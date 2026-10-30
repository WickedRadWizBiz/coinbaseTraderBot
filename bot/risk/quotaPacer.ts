// Hourly quota pacer (Steven's spec, Oct 29 2026 23:35 UTC): a 24-hour profit clock anchored to 10:00 AM New York time
// ($4.50 an hour, $108 a cycle) that tells the strategy the dollars a position must be up, net of fees, for its sale to put
// the day back on pace before the current clock hour ends. The strategy sells such a position at once, whatever the exit
// policy or the model says (the "quota snipe", bot/strategy/fairValueStrategy.ts), except inside the last share of a
// contract's window when the position is in profit, where it rides to settlement (STRATEGY_NO_EXIT_BEFORE_CLOSE_FRAC).
//
//   cycle      the most recent anchor (10:00 AM New York) to the next one; hour #1 is 10-11 AM, #24 is 9-10 AM
//   deficit    cumulative mode (the default): hour# x hourly - realized since the anchor, so a slow hour is owed by the
//              next ones ("don't stack up deficit across hours"); rolling_hour: hourly - realized in this clock hour
//   needed     max(min take, min(deficit, max target)): ahead of pace the floor still takes a profit at once ("if it's
//              ahead it shouldn't slow down"), and a cold streak never demands more than the cap from one position
//   realized   net of fees: each reducing fill credits its realized part against the position's cost basis (entry fee
//              in), and a settlement credits whatever the market's realized total still lacks, so a market's credits
//              always sum to the book's realized P&L (bot/oms/positions.ts)
//
// The engine and the backtester run the same class on their own clocks; the engine persists it (DATA_DIR) so a restart
// mid-cycle resumes the running cycle rather than starting hour #1 at the restart.
import fs from 'fs';
import path from 'path';

export type PacerMode = 'cumulative' | 'rolling_hour';

export interface PacerConfig {
  /** PACER: the quota snipe is on. */
  enabled: boolean;
  /** PACER_GROUP: positions each in profit after fees whose profits together cover the target are all sold (SnipeGroup). */
  group: boolean;
  /** PACER_HOURLY_USD: the hourly target (4.50). */
  hourlyUsd: number;
  /** PACER_ANCHOR_HOUR / PACER_ANCHOR_MINUTE: the cycle's start on the wall clock of PACER_TZ (10:00). */
  anchorHour: number;
  anchorMinute: number;
  /** PACER_TZ: an IANA zone (America/New_York: EDT and EST follow the calendar). */
  tz: string;
  /** PACER_MODE: how the deficit is measured. */
  mode: PacerMode;
  /** PACER_MIN_TAKE_USD: the floor on what a snipe takes (0.75), the whole threshold once ahead of pace. */
  minTakeUsd: number;
  /** PACER_MAX_TARGET_USD: the cap on what one position is asked for (6.50). */
  maxTargetUsd: number;
}

export const CYCLE_HOURS = 24;

export interface PacerStatus {
  /** The running cycle's anchor and the next one (ms). */
  anchorStart: number;
  nextReset: number;
  elapsedSec: number;
  /** 1-based clock hour of the cycle (1 = the anchor hour). */
  hourIndex: number;
  minutesIntoHour: number;
  minutesRemaining: number;
  minutesSinceProfit: number;
  realized24hUsd: number;
  realizedHourUsd: number;
  /** Where the straight $hourly/60-a-minute line is right now. */
  linearBenchmarkUsd: number;
  /** The cumulative goal at the top of the next hour (cumulative) or the hour's target (rolling_hour). */
  nextHourGoalUsd: number;
  /** Goal less realized: what the rest of this hour owes (negative = ahead). */
  rawDeficitUsd: number;
  /** The clamped deficit: the net dollars a position must be up for a snipe. */
  neededUsd: number;
  requiredUsdPerMin: number;
  ahead: boolean;
}

interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number }

const fmts = new Map<string, Intl.DateTimeFormat>();

/** The wall clock of `tz` at `ts`. */
export function wallClock(ts: number, tz: string): Wall {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmts.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ts))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/** The instant (ms) a wall-clock time of `tz` names; a day past the month's end rolls into the next month as Date.UTC does. */
export function wallToUtc(w: { y: number; mo: number; d: number; h: number; mi: number }, tz: string): number {
  const want = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  let ts = want;
  for (let i = 0; i < 3; i++) {
    const p = wallClock(ts, tz);
    const got = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    if (got === want) break;
    ts += want - got;
  }
  return ts;
}

type AnchorCfg = Pick<PacerConfig, 'anchorHour' | 'anchorMinute' | 'tz'>;

/** The most recent anchor (today's if the wall clock has passed it, else yesterday's). */
export function anchorBefore(ts: number, cfg: AnchorCfg): number {
  const p = wallClock(ts, cfg.tz);
  const today = wallToUtc({ y: p.y, mo: p.mo, d: p.d, h: cfg.anchorHour, mi: cfg.anchorMinute }, cfg.tz);
  return ts >= today ? today : wallToUtc({ y: p.y, mo: p.mo, d: p.d - 1, h: cfg.anchorHour, mi: cfg.anchorMinute }, cfg.tz);
}

/** The anchor after `anchor` (a day later on the wall clock: 23 or 25 hours across a clock change). */
export function anchorAfter(anchor: number, cfg: AnchorCfg): number {
  const p = wallClock(anchor, cfg.tz);
  return wallToUtc({ y: p.y, mo: p.mo, d: p.d + 1, h: cfg.anchorHour, mi: cfg.anchorMinute }, cfg.tz);
}

/** Checks the zone name once (an unknown zone throws in Intl). */
export function validZone(tz: string): boolean {
  try { wallClock(0, tz); return true; } catch { return false; }
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export interface GroupVerdict {
  /** This market is to be sold as a member of a group whose profits together cover the target. */
  sell: boolean;
  /** The members' net profits summed, and how many there are (this market included). */
  sumUsd: number;
  members: number;
}

/** Steven's addition (Oct 30 2026 00:05 UTC): when more than one position is in profit after fees and those profits together
 *  cover what the hour needs, they are all sold. The engine judges markets one at a time, so each market's net profit at its bid
 *  is recorded as it is evaluated; when the fresh ones sum to the target, every member is marked and sold at its next evaluation
 *  while still in profit (a sale's credit lowers the target, which must not strand the rest of the group). A position inside the
 *  final share of its window is not a member (it rides to settlement). */
export class SnipeGroup {
  private readonly nets = new Map<string, { net: number; at: number }>();
  private readonly marked = new Map<string, number>();

  constructor(private readonly staleMs = 120_000, private readonly markMs = 90_000) {}

  /** Records the market's net profit after fees at its bid (undefined: flat, no basis, or inside its final share) and says whether
   *  it is to be sold as a member of a group covering `needed`. */
  judge(ticker: string, net: number | undefined, needed: number | undefined, now: number): GroupVerdict {
    if (net === undefined || !(net > 1e-9)) {
      this.nets.delete(ticker);
      this.marked.delete(ticker);
      return { sell: false, sumUsd: 0, members: 0 };
    }
    this.nets.set(ticker, { net, at: now });
    for (const [t, x] of this.nets) if (now - x.at > this.staleMs) this.nets.delete(t);
    for (const [t, until] of this.marked) if (until <= now) this.marked.delete(t);
    let sumUsd = 0;
    for (const x of this.nets.values()) sumUsd += x.net;
    const members = this.nets.size;
    if (this.marked.has(ticker)) return { sell: true, sumUsd, members };
    if (needed !== undefined && members >= 2 && sumUsd >= needed - 1e-9) {
      for (const t of this.nets.keys()) this.marked.set(t, now + this.markMs);
      return { sell: true, sumUsd, members };
    }
    return { sell: false, sumUsd, members };
  }

  /** The market settled or is gone. */
  forget(ticker: string): void {
    this.nets.delete(ticker);
    this.marked.delete(ticker);
  }
}

interface Saved { cycleStart: number; lastProfitTs: number; realized24h: number; buckets: Record<string, number>; fed: Record<string, number>; savedAt: number }

export class HourlyQuotaPacer {
  private cycleStart: number;
  /** The next anchor, computed once a cycle (the wall-clock arithmetic is the costly part of a status read). */
  private nextAnchor: number;
  private lastProfitTs: number;
  private realized24h = 0;
  private readonly buckets = new Map<number, number>();
  /** Realized P&L credited per open market, so its settlement credits only the rest. */
  private readonly fed = new Map<string, number>();

  constructor(readonly cfg: PacerConfig, now: number, private readonly file?: string) {
    this.cycleStart = anchorBefore(now, cfg);
    this.nextAnchor = anchorAfter(this.cycleStart, cfg);
    this.lastProfitTs = now;
    this.load();
  }

  /** Resets the cycle the moment the clock crosses an anchor. */
  private rollover(now: number): boolean {
    if (now >= this.cycleStart && now < this.nextAnchor) return false;
    const a = anchorBefore(now, this.cfg);
    if (a <= this.cycleStart) return false;
    this.cycleStart = a;
    this.nextAnchor = anchorAfter(a, this.cfg);
    this.lastProfitTs = now;
    this.realized24h = 0;
    this.buckets.clear();
    this.save(now);
    return true;
  }

  hourIndex(now: number): number {
    const elapsedSec = Math.max(0, now - this.cycleStart) / 1000;
    return Math.min(Math.floor(elapsedSec / 3600) + 1, CYCLE_HOURS);
  }

  /** Books a realized, fee-adjusted result at `now`. */
  record(netUsd: number, now: number): void {
    this.rollover(now);
    this.realized24h += netUsd;
    const h = this.hourIndex(now);
    this.buckets.set(h, (this.buckets.get(h) ?? 0) + netUsd);
    if (netUsd > 0) this.lastProfitTs = now;
    this.save(now);
  }

  /** A fill the position book has applied (`after` is the market's book state after it): the reducing part's realized
   *  P&L against the position's cost basis (entry fee in), net of the fill's fee, is credited; an entry credits nothing.
   *  Returns the credit. */
  onFill(f: { ticker: string; side: 'bid' | 'ask'; count: number; price: number }, fee: number, after: { yes: number; netCash: number; fees: number }, now: number): number {
    const signed = f.side === 'bid' ? f.count : -f.count;
    const yesBefore = round2(after.yes - signed);
    if (!(f.count > 0) || Math.abs(yesBefore) < 1e-9 || Math.sign(yesBefore) === Math.sign(signed)) return 0;
    const n = Math.min(f.count, Math.abs(yesBefore));
    const netCashBefore = after.netCash + signed * f.price;
    const feesBefore = after.fees - fee;
    const basis = (yesBefore > 0 ? -netCashBefore / yesBefore : 1 - netCashBefore / -yesBefore) + feesBefore / Math.abs(yesBefore);
    const sidePrice = yesBefore > 0 ? f.price : 1 - f.price;
    const credit = n * (sidePrice - basis) - fee * (n / f.count);
    this.fed.set(f.ticker, (this.fed.get(f.ticker) ?? 0) + credit);
    this.record(credit, now);
    return credit;
  }

  /** The market settled with the book's realized total (net of fees): credits what its fills have not. */
  onSettled(ticker: string, realized: number, now: number): number {
    const credit = realized - (this.fed.get(ticker) ?? 0);
    this.fed.delete(ticker);
    this.record(credit, now);
    return credit;
  }

  status(now: number): PacerStatus {
    this.rollover(now);
    const c = this.cfg;
    const elapsedSec = Math.max(0, now - this.cycleStart) / 1000;
    const hourIndex = this.hourIndex(now);
    const secInto = elapsedSec % 3600;
    const minutesRemaining = Math.max(1 / 60, (3600 - secInto) / 60);
    const realizedHour = this.buckets.get(hourIndex) ?? 0;
    const nextHourGoal = c.mode === 'cumulative' ? hourIndex * c.hourlyUsd : c.hourlyUsd;
    const rawDeficit = c.mode === 'cumulative' ? nextHourGoal - this.realized24h : c.hourlyUsd - realizedHour;
    const neededUsd = Math.max(c.minTakeUsd, Math.min(rawDeficit, c.maxTargetUsd));
    const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
    return {
      anchorStart: this.cycleStart, nextReset: this.nextAnchor, elapsedSec: Math.round(elapsedSec), hourIndex,
      minutesIntoHour: r4(secInto / 60), minutesRemaining: r4(minutesRemaining), minutesSinceProfit: r4(Math.max(0, now - this.lastProfitTs) / 60_000),
      realized24hUsd: r4(this.realized24h), realizedHourUsd: r4(realizedHour), linearBenchmarkUsd: r4(elapsedSec * c.hourlyUsd / 3600),
      nextHourGoalUsd: r4(nextHourGoal), rawDeficitUsd: r4(rawDeficit), neededUsd: r4(neededUsd), requiredUsdPerMin: r4(Math.max(0, rawDeficit) / minutesRemaining),
      ahead: rawDeficit <= 0,
    };
  }

  /** The net dollars a position must be up for a snipe right now; undefined while the pacer is off. */
  neededUsd(now: number): number | undefined {
    return this.cfg.enabled ? this.status(now).neededUsd : undefined;
  }

  private save(now: number): void {
    if (!this.file) return;
    const s: Saved = { cycleStart: this.cycleStart, lastProfitTs: this.lastProfitTs, realized24h: this.realized24h, buckets: Object.fromEntries([...this.buckets].map(([k, v]) => [String(k), v])), fed: Object.fromEntries(this.fed), savedAt: now };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(s));
    } catch { /* best effort: the next credit tries again */ }
  }

  /** Restores the running cycle from the state file when it is the same cycle; the per-market credits always (an open
   *  market's settlement must not credit what its exits already did). */
  private load(): void {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Saved>;
      for (const [k, v] of Object.entries(s.fed ?? {})) if (Number.isFinite(v)) this.fed.set(k, v as number);
      if (typeof s.cycleStart !== 'number' || Math.abs(s.cycleStart - this.cycleStart) >= 1000) return;
      this.realized24h = Number.isFinite(s.realized24h) ? s.realized24h! : 0;
      if (typeof s.lastProfitTs === 'number') this.lastProfitTs = s.lastProfitTs;
      for (const [k, v] of Object.entries(s.buckets ?? {})) if (Number.isFinite(v)) this.buckets.set(Number(k), v as number);
    } catch { /* unreadable state: a fresh cycle from this restart */ }
  }
}

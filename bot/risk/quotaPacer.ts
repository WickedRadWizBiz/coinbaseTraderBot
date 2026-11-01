// Hourly quota pacer (Steven's spec, Oct 29 2026 23:35 UTC; the non-stacking slices, his spec of Oct 30 04:14 UTC): a
// 24-hour profit clock anchored to 10:00 AM New York time
// ($4.50 an hour, $108 a cycle) that tells the strategy the dollars a position must be up, net of fees, for its sale to put
// the day back on pace before the current clock hour ends. The strategy sells such a position at once, whatever the exit
// policy or the model says (the "quota snipe", bot/strategy/fairValueStrategy.ts), except inside the last share of a
// contract's window when the position is in profit, where it rides to settlement (STRATEGY_NO_EXIT_BEFORE_CLOSE_FRAC).
//
//   cycle      the most recent anchor (10:00 AM New York) to the next one; hour #1 is 10-11 AM, #24 is 9-10 AM
//   slices     the default (Steven, Oct 30: "Do not stack deficit across hours"). The required rate is what the rest of the
//              cycle owes an hour block, max(0, 24 x hourly - realized since the anchor) / the blocks left (this one
//              included). Behind pace (rate > hourly: catch-up) the slice goal is the hourly target; on pace it is the
//              rate. A position must be up the goal less what the running slice has banked; a slice reached rolls over
//              at once (the excess carried), so a deficit is caught up in slices of at most the hourly target, never one
//              oversized target; a new clock hour starts a fresh slice (a partial one is not owed); a loss never raises
//              the target (the slice floors at 0); once a slice is banked in an hour on pace, the floor stands.
//   needed     max(min take, min(..., hourly)) in slices; the older modes (PACER_MODE): cumulative, hour# x hourly -
//              realized since the anchor clamped to [min take, max target] (a slow hour owed by the next ones), and
//              rolling_hour, hourly - realized in this clock hour. Ahead of pace the floor still takes a profit at once
//              ("if it's ahead it shouldn't slow down")
//   realized   net of fees: each reducing fill credits its realized part against the position's cost basis (entry fee
//              in), and a settlement credits whatever the market's realized total still lacks, so a market's credits
//              always sum to the book's realized P&L (bot/oms/positions.ts)
//   floor      PACER_FLOOR (Steven, Oct 31 00:21 UTC): when another exit rule aims higher than the quota, the quota lets the
//              price go higher and is the position's stop instead (QuotaFloors, quotaCall)
//
// The engine and the backtester run the same class on their own clocks; the engine persists it (DATA_DIR) so a restart
// mid-cycle resumes the running cycle rather than starting hour #1 at the restart.
import fs from 'fs';
import path from 'path';

export type PacerMode = 'slices' | 'cumulative' | 'rolling_hour';

/** PACER_FLOOR: which exit rules count as aiming higher than the quota. riding: any rule still riding a winner (the hunt
 *  trailing its stop, the take-profit trailing its best, a perp signal or setup trade still open) or holding out for a set
 *  price; targets: only a set sell price (the model's, a resting take-profit, a setup's target, a rule's target passed in);
 *  off: the quota snipe sells at the quota whatever the other rules aim for. */
export type PacerFloorMode = 'off' | 'targets' | 'riding';

export interface PacerConfig {
  /** PACER: the quota snipe is on. */
  enabled: boolean;
  /** PACER_GROUP (off by default since Oct 30): positions each in profit after fees whose profits together cover the target are
   *  all sold (SnipeGroup). */
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
  /** PACER_MAX_TARGET_USD: the cap on what one position is asked for in the cumulative and rolling_hour modes (6.50); the
   *  slices mode never asks more than the hourly target. */
  maxTargetUsd: number;
  /** PACER_FLOOR: the quota as a stop under a higher target (riding by default). */
  floor: PacerFloorMode;
  /** PACER_FLOOR_TICKS (8): the floor sells once the position's profit is this many price ticks a contract under it, not
   *  at the first dip below it (Kalshi contracts: crypto and tennis; perps have no contract tick and keep the floor as is). */
  floorTicks: number;
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
  /** The cumulative goal at the top of the next hour (cumulative), the hour's target (rolling_hour) or the running slice's goal
   *  (slices). */
  nextHourGoalUsd: number;
  /** Goal less realized: what the rest of this hour (slices: the running slice) owes (negative = ahead). */
  rawDeficitUsd: number;
  /** The clamped deficit: the net dollars a position must be up for a snipe. */
  neededUsd: number;
  requiredUsdPerMin: number;
  ahead: boolean;
  mode: PacerMode;
  /** Hour blocks left in the cycle, this one included. */
  hoursRemaining: number;
  /** The cycle's target (24 x hourly) less its realized total, at least 0. */
  remainingGoalUsd: number;
  /** remainingGoalUsd / hoursRemaining: the required hourly rate (slices: catch-up while above the hourly target). */
  requiredPerHourUsd: number;
  catchUp: boolean;
  /** The running slice: its goal (at most the hourly target), what it has banked, and the slices completed this clock hour. */
  sliceGoalUsd: number;
  sliceRealizedUsd: number;
  slicesThisHour: number;
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

/** Steven's rule (Oct 31 2026 00:21 UTC): "things in the bot setting higher targets than whatever the dynamic $4.50/hr quota is
 *  setting as a target, then the quota should allow for the price to go higher and function as a stop loss instead". While
 *  another exit rule aims higher (PACER_FLOOR), a position whose profit after fees covers what the hour needs is not sold: that
 *  need becomes its floor, raised when a later need it covers is higher, and the position is sold once its profit falls below
 *  it. Kept per contract, so a partial sale leaves the rest its share; a position opened, reversed or added to starts with
 *  none. Every contract type's quota snipe keeps its floors here, the engine and the backtest alike; not persisted (after a
 *  restart a floor is armed again when the profit covers the need). */
export class QuotaFloors {
  private readonly m = new Map<string, { sign: number; size: number; perUnit?: number }>();

  /** Records the position this tick and returns its floor in dollars (undefined: flat or none armed). */
  floor(key: string, position: number): number | undefined {
    if (position === 0) { this.m.delete(key); return undefined; }
    const sign = Math.sign(position), size = Math.abs(position);
    const f = this.m.get(key);
    if (f && f.sign === sign && size <= f.size + 1e-9) {
      f.size = size;
      return f.perUnit === undefined ? undefined : f.perUnit * size;
    }
    this.m.set(key, { sign, size });
    return undefined;
  }

  /** The position's profit covers `usd` while a rule aims higher: its floor is at least `usd`. True when it was raised. */
  arm(key: string, position: number, usd: number): boolean {
    const size = Math.abs(position);
    const f = this.m.get(key);
    if (!f || f.sign !== Math.sign(position) || !(size > 0)) return false;
    const perUnit = usd / size;
    if (f.perUnit !== undefined && perUnit <= f.perUnit + 1e-12) return false;
    f.perUnit = perUnit;
    return true;
  }

  forget(key: string): void { this.m.delete(key); }
}

export interface QuotaCall {
  /** Sell now: 'snipe', the profit covers the need and no rule aims higher; 'floor', the profit fell below the floor. */
  sell?: 'snipe' | 'floor';
  /** Arm the floor (or raise it) at this many dollars: the profit covers the need and a rule aims higher. */
  arm?: number;
}

/** The quota's call on one position: `net` its profit after fees at the touch now, `need` what the hour needs (undefined: the
 *  pacer is off or the position is not judged), `floor` its armed floor (QuotaFloors), `higher` why another exit rule aims
 *  higher (undefined: none, or PACER_FLOOR off). */
export function quotaCall(net: number | undefined, need: number | undefined, floor: number | undefined, higher: string | undefined, cushion = 0): QuotaCall {
  if (net === undefined) return {};
  // `cushion` (PACER_FLOOR_TICKS, in dollars for the position): how far under the floor the profit may dip before it sells.
  if (floor !== undefined && net < floor - cushion - 1e-9) return { sell: 'floor' };
  if (need === undefined || net < need - 1e-9) return {};
  return higher !== undefined ? { arm: need } : { sell: 'snipe' };
}

interface Saved { cycleStart: number; lastProfitTs: number; realized24h: number; buckets: Record<string, number>; fed: Record<string, number>; savedAt: number; activeHour?: number; slice?: number; slicesThisHour?: number }

export class HourlyQuotaPacer {
  private cycleStart: number;
  /** The next anchor, computed once a cycle (the wall-clock arithmetic is the costly part of a status read). */
  private nextAnchor: number;
  private lastProfitTs: number;
  private realized24h = 0;
  private readonly buckets = new Map<number, number>();
  /** Realized P&L credited per open market, so its settlement credits only the rest. */
  private readonly fed = new Map<string, number>();
  /** The slices: the clock hour they belong to, the running slice's banked dollars and the slices completed this hour. */
  private activeHour: number;
  private slice = 0;
  private slicesThisHour = 0;

  constructor(readonly cfg: PacerConfig, now: number, private readonly file?: string) {
    this.cycleStart = anchorBefore(now, cfg);
    this.nextAnchor = anchorAfter(this.cycleStart, cfg);
    this.lastProfitTs = now;
    this.activeHour = this.hourIndex(now);
    this.load();
  }

  /** Resets the cycle the moment the clock crosses an anchor, and the slice the moment it crosses into a new clock hour (a
   *  partial slice is never owed by the next hour). */
  private rollover(now: number): boolean {
    let changed = false;
    if (!(now >= this.cycleStart && now < this.nextAnchor)) {
      const a = anchorBefore(now, this.cfg);
      if (a > this.cycleStart) {
        this.cycleStart = a;
        this.nextAnchor = anchorAfter(a, this.cfg);
        this.lastProfitTs = now;
        this.realized24h = 0;
        this.buckets.clear();
        this.slice = 0;
        this.slicesThisHour = 0;
        this.activeHour = this.hourIndex(now);
        changed = true;
      }
    }
    const h = this.hourIndex(now);
    if (h !== this.activeHour) {
      this.activeHour = h;
      this.slice = 0;
      this.slicesThisHour = 0;
      changed = true;
    }
    if (changed) this.save(now);
    return changed;
  }

  /** What the rest of the cycle owes an hour block (the hour `h` included). */
  private requiredPerHour(h: number): number {
    return Math.max(0, this.cfg.hourlyUsd * CYCLE_HOURS - this.realized24h) / Math.max(1, CYCLE_HOURS - h + 1);
  }

  /** The running slice's goal: the hourly target behind pace, the required rate on pace. */
  private sliceGoal(h: number): number {
    return Math.min(this.cfg.hourlyUsd, this.requiredPerHour(h));
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
    // A slice reached is banked and the next one starts at once with the excess; a loss never raises the target.
    this.slice += netUsd;
    let goal = this.sliceGoal(h);
    for (let n = 0; goal > 0 && this.slice >= goal - 1e-9 && n < 1000; n++) {
      this.slice -= goal;
      this.slicesThisHour++;
      goal = this.sliceGoal(h);
      if (goal < this.cfg.minTakeUsd) break;
    }
    if (this.slice < 0) this.slice = 0;
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
    const hoursRemaining = Math.max(1, CYCLE_HOURS - hourIndex + 1);
    const remainingGoal = Math.max(0, c.hourlyUsd * CYCLE_HOURS - this.realized24h);
    const perHour = this.requiredPerHour(hourIndex);
    const catchUp = perHour > c.hourlyUsd + 1e-9;
    const sliceGoal = this.sliceGoal(hourIndex);
    let nextHourGoal: number, rawDeficit: number, neededUsd: number;
    if (c.mode === 'slices') {
      nextHourGoal = sliceGoal;
      // on pace with a slice banked this hour the floor stands: no further slice is forced this hour
      rawDeficit = this.slicesThisHour > 0 && !catchUp ? c.minTakeUsd : sliceGoal - this.slice;
      neededUsd = Math.max(c.minTakeUsd, Math.min(rawDeficit, c.hourlyUsd));
    } else {
      nextHourGoal = c.mode === 'cumulative' ? hourIndex * c.hourlyUsd : c.hourlyUsd;
      rawDeficit = c.mode === 'cumulative' ? nextHourGoal - this.realized24h : c.hourlyUsd - realizedHour;
      neededUsd = Math.max(c.minTakeUsd, Math.min(rawDeficit, c.maxTargetUsd));
    }
    const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
    return {
      anchorStart: this.cycleStart, nextReset: this.nextAnchor, elapsedSec: Math.round(elapsedSec), hourIndex,
      minutesIntoHour: r4(secInto / 60), minutesRemaining: r4(minutesRemaining), minutesSinceProfit: r4(Math.max(0, now - this.lastProfitTs) / 60_000),
      realized24hUsd: r4(this.realized24h), realizedHourUsd: r4(realizedHour), linearBenchmarkUsd: r4(elapsedSec * c.hourlyUsd / 3600),
      nextHourGoalUsd: r4(nextHourGoal), rawDeficitUsd: r4(rawDeficit), neededUsd: r4(neededUsd), requiredUsdPerMin: r4(Math.max(0, rawDeficit) / minutesRemaining),
      ahead: c.mode === 'slices' ? !catchUp : rawDeficit <= 0,
      mode: c.mode, hoursRemaining, remainingGoalUsd: r4(remainingGoal), requiredPerHourUsd: r4(perHour), catchUp,
      sliceGoalUsd: r4(sliceGoal), sliceRealizedUsd: r4(this.slice), slicesThisHour: this.slicesThisHour,
    };
  }

  /** The net dollars a position must be up for a snipe right now; undefined while the pacer is off. */
  neededUsd(now: number): number | undefined {
    return this.cfg.enabled ? this.status(now).neededUsd : undefined;
  }

  private save(now: number): void {
    if (!this.file) return;
    const s: Saved = { cycleStart: this.cycleStart, lastProfitTs: this.lastProfitTs, realized24h: this.realized24h, buckets: Object.fromEntries([...this.buckets].map(([k, v]) => [String(k), v])), fed: Object.fromEntries(this.fed), savedAt: now, activeHour: this.activeHour, slice: this.slice, slicesThisHour: this.slicesThisHour };
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
      // the slice resumes within its clock hour; a later hour starts a fresh one at the next read (rollover)
      if (Number.isFinite(s.activeHour) && Number.isFinite(s.slice) && Number.isFinite(s.slicesThisHour)) {
        this.activeHour = s.activeHour!;
        this.slice = Math.max(0, s.slice!);
        this.slicesThisHour = s.slicesThisHour!;
      }
    } catch { /* unreadable state: a fresh cycle from this restart */ }
  }
}

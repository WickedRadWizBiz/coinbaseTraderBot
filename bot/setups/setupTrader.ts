// Live setup trader: the fast and slow lanes on perpetual futures (same interface as PerpTrader, so
// the perps executor turns its targets into orders and keeps the exchange-side stop in place).
//
// Every executor tick:
//   1. manage open trades on the spot price (stop, half off at the first target with the stop to
//      break-even, final target; trail and time stop at each close of the trade's timeframe)
//   2. on every newly closed 15m / 1h / daily candle: run the detectors, score each setup with the
//      model, queue it in its lane (bot/setups/lanes.ts)
//   3. when a lane has room: re-check the best candidates on fresh data (re-scored, still tradable,
//      not chased) and open them
//   4. targets for the executor: contracts per perp = side x remaining share x size; the exchange stop
//      is the trade's stop converted from spot to the perp's price.
// Levels come from spot candles and are checked against the spot price; orders go to the perp.
// The book (queues and open trades) is saved to disk, so a restart resumes managing the trades.
// Guards: kill switch / halts flatten urgently; the perp daily loss stop flattens and halts for the
// day; an unvalidated lane trades at pilot size (or not at all with PERP_REQUIRE_VALIDATION).

import fs from 'fs';
import type { AuditLog } from '../audit/auditLog';
import type { CandleSet } from '../ta/candleStore';
import type { Candle } from '../ta/indicators';
import type { Timeframe } from '../ta/knowledge';
import type { DirTarget, DirectionalContext } from '../perps/hedger';
import type { PerpHub } from '../perps/perpData';
import type { PerpGateway } from '../perps/perpRest';
import { detectLast, FAST_TFS, SLOW_TFS, SETUP_MIN_BARS, TF_MS, type Lane, type SetupSignal } from './detectors';
import { DEFAULT_COSTS, openTrade, stepTrade, tradeResult, type CostModel, type OpenTrade } from './exits';
import { setupFeatureMap, setupVector, type SetupBars } from './features';
import { DEFAULT_LANES, LaneBook, type Candidate, type LaneBookParams } from './lanes';
import { SetupModel } from './setupModel';

export interface SetupTraderParams {
  book: LaneBookParams;
  costs: CostModel;
  dailyLossFrac: number;
  minEquityUsd: number;
  pilotMaxNotionalUsd: number;
  requireValidation: boolean;
  dailyGoalUsd: number;
}

export interface SetupTraderDeps {
  params: SetupTraderParams;
  hub: PerpHub;
  gateway: PerpGateway;
  /** Model file; a function so a model the pipeline promotes later is picked up (hot reload on change). */
  modelPath: string | (() => string);
  statePath: string;
  candles: (asset: string) => CandleSet | undefined;
  /** Current spot price of an asset (the level the setups were drawn on). */
  spot: (asset: string, now: number) => number | undefined;
  audit?: AuditLog;
}

interface SavedBook { positions: OpenTrade[]; queues: Record<Lane, Candidate[]>; seen: Record<string, number>; day?: { key: string; start: number; realized: number }; history: ClosedRecord[] }
export interface ClosedRecord { asset: string; lane: Lane; kind: string; tf: string; dir: number; entry: number; exit: number; entryTs: number; exitTs: number; reason: string; r: number; ret: number; usd: number; score?: number }

const TFS: Timeframe[] = [...FAST_TFS, ...SLOW_TFS];

export class SetupTrader {
  readonly book: LaneBook;
  private model?: SetupModel;
  private modelMtime = 0;
  modelError?: string;
  private seen = new Map<string, number>();
  private lastPx = new Map<string, number>();
  private equity?: { value: number; ts: number };
  private day?: { key: string; start: number; realized: number };
  private dayHalt?: string;
  private history: ClosedRecord[] = [];
  readonly lastDecisions = new Map<string, { target: number; reason: string; stop?: number }>();
  lastError?: string;

  constructor(private readonly d: SetupTraderDeps) {
    this.book = new LaneBook(d.params.book);
    this.reloadModel();
    this.restore();
  }

  /** Load (or hot-reload when the file changed) the setup model; lane settings come from it, risk limits from config. */
  reloadModel(): void {
    try {
      const file = typeof this.d.modelPath === 'function' ? this.d.modelPath() : this.d.modelPath;
      if (!fs.existsSync(file)) { this.model = undefined; this.modelError = `no setup model at ${file} (research:setups)`; return; }
      const m = fs.statSync(file).mtimeMs + file.length;
      if (m === this.modelMtime) return;
      this.model = SetupModel.load(file);
      this.modelMtime = m;
      this.modelError = undefined;
      const P = this.d.params.book, M = this.model?.params.book;
      if (M) for (const lane of ['fast', 'slow'] as const) this.book.params[lane] = { ...P[lane], minScore: M[lane].minScore, refScore: M[lane].refScore, ttlBars: M[lane].ttlBars, maxChaseR: M[lane].maxChaseR };
      this.d.audit?.write('setup_model', { version: this.model?.params.version, fast: this.model?.validated('fast'), slow: this.model?.validated('slow') });
    } catch (e) {
      this.model = undefined;
      this.modelError = String(e);
    }
  }

  private restore(): void {
    try {
      if (!fs.existsSync(this.d.statePath)) return;
      const s = JSON.parse(fs.readFileSync(this.d.statePath, 'utf8')) as SavedBook;
      for (const t of s.positions ?? []) this.book.add(t);
      this.book.queues.fast = s.queues?.fast ?? [];
      this.book.queues.slow = s.queues?.slow ?? [];
      this.seen = new Map(Object.entries(s.seen ?? {}));
      this.day = s.day;
      this.history = s.history ?? [];
    } catch (e) { this.lastError = `restore: ${String(e)}`; }
  }

  private save(): void {
    try {
      const s: SavedBook = { positions: [...this.book.positions.values()], queues: this.book.queues, seen: Object.fromEntries(this.seen), day: this.day, history: this.history.slice(-500) };
      const tmp = `${this.d.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s));
      fs.renameSync(tmp, this.d.statePath);
    } catch (e) { this.lastError = `save: ${String(e)}`; }
  }

  private async refreshEquity(now: number): Promise<number | undefined> {
    if (this.equity && now - this.equity.ts < 30_000) return this.equity.value;
    if (!this.d.gateway.getBalance) return undefined;
    try {
      const b = await this.d.gateway.getBalance();
      this.equity = { value: b.equity, ts: now };
      const key = new Date(now).toISOString().slice(0, 10);
      if (this.day?.key !== key) { this.day = { key, start: b.equity, realized: 0 }; this.dayHalt = undefined; }
      if (this.day.start > 0 && b.equity <= this.day.start * (1 - this.d.params.dailyLossFrac)) {
        this.dayHalt ??= `perp daily loss: equity $${b.equity.toFixed(2)} is ${((1 - b.equity / this.day.start) * 100).toFixed(1)}% below today's start`;
      }
      return b.equity;
    } catch (e) {
      this.lastError = `balance: ${String(e)}`;
      return this.equity?.value;
    }
  }

  private bars(asset: string): SetupBars | undefined {
    const c = this.d.candles(asset);
    if (!c?.bars['1h']) return undefined;
    return { m15: c.bars['15m'], h1: c.bars['1h'], d1: c.bars['1d'] };
  }

  /** Model score of a setup as of `t` (fresh features), NaN without a model. */
  private score(sig: SetupSignal, t: number): number {
    if (!this.model) return NaN;
    const bars = this.bars(sig.asset);
    if (!bars) return NaN;
    return this.model.score(sig.lane, setupVector(setupFeatureMap(sig, bars, this.bars('BTC'), t)));
  }

  private record(t: OpenTrade, now: number): void {
    const res = tradeResult(t);
    const usd = res.ret * (t.notional ?? 0);
    if (this.day) this.day.realized += usd;
    this.history.push({ asset: t.asset, lane: t.lane, kind: t.kind, tf: t.tf, dir: t.dir, entry: t.entry, exit: t.closed?.px ?? NaN, entryTs: t.entryTs, exitTs: t.closed?.ts ?? now, reason: t.closed?.reason ?? 'manual', r: res.r, ret: res.ret, usd, score: t.score });
    this.d.audit?.write('setup_trade', { event: 'closed', asset: t.asset, lane: t.lane, kind: t.kind, tf: t.tf, dir: t.dir, entry: t.entry, exit: t.closed?.px, reason: t.closed?.reason, r: res.r, usd });
  }

  /** Directional targets for the executor (called after it synced positions). */
  async targets(c: DirectionalContext, guards: { halt?: string; noEntry?: string; lockedFrac?: number }): Promise<DirTarget[]> {
    const now = c.now;
    this.reloadModel();
    const equity = await this.refreshEquity(now);
    const assets = [...this.d.hub.byAsset.entries()].filter(([, s]) => s.latest?.ticker).map(([a]) => a);
    let changed = false;
    const exitNow = new Set<string>();

    // 1. Manage open trades on the spot price (a pseudo-bar from the last price to now), trail / time at candle closes.
    for (const [asset, t] of [...this.book.positions]) {
      const px = this.d.spot(asset, now);
      if (!(px && px > 0)) continue;
      const prev = this.lastPx.get(asset) ?? px;
      this.lastPx.set(asset, px);
      const cs = this.d.candles(asset)?.bars[t.tf];
      const lastBar = cs?.[cs.length - 1];
      const key = `trail|${asset}|${t.tf}`;
      let tfClose: { close: number; atr: number } | undefined;
      if (lastBar && lastBar.ts > t.entryTs - TF_MS[t.tf]! && (this.seen.get(key) ?? 0) < lastBar.ts) {
        this.seen.set(key, lastBar.ts);
        const atr = atrOf(cs!);
        if (atr > 0) tfClose = { close: lastBar.c, atr };
      }
      const bar: Candle = { ts: now, o: prev, h: Math.max(prev, px), l: Math.min(prev, px), c: px, v: 0 };
      const was = t.partialDone;
      if (stepTrade(t, bar, 0, this.d.params.costs, tfClose)) { this.record(t, now); this.book.remove(asset); changed = true; if (t.closed?.reason !== 'target') exitNow.add(asset); }
      else if (t.partialDone !== was || tfClose) changed = true;
    }

    // 2. New setups on newly closed candles.
    for (const asset of assets) {
      const set = this.d.candles(asset);
      if (!set) continue;
      for (const tf of TFS) {
        const cs = set.bars[tf];
        if (!cs || cs.length < SETUP_MIN_BARS) continue;
        const last = cs[cs.length - 1];
        const key = `${asset}|${tf}`;
        if ((this.seen.get(key) ?? 0) >= last.ts) continue;
        this.seen.set(key, last.ts); changed = true;
        if (now - (last.ts + TF_MS[tf]!) > TF_MS[tf]!) continue; // stale candles (feed catching up)
        const sig = detectLast(asset, tf, cs);
        if (!sig) continue;
        const score = this.score(sig, last.ts + TF_MS[tf]!);
        const queued = Number.isFinite(score) && this.book.offer(sig, score, now);
        this.d.audit?.write('setup_signal', { asset, lane: sig.lane, kind: sig.kind, tf, dir: sig.dir, ref: sig.ref, stop: sig.stop, score, queued });
      }
    }

    // 3. Entries (re-checked on fresh data), unless entries are blocked.
    const block = guards.halt ?? this.dayHalt ?? guards.noEntry
      ?? (equity === undefined ? 'margin equity unknown' : equity < this.d.params.minEquityUsd ? `margin equity $${equity.toFixed(2)} below $${this.d.params.minEquityUsd}` : undefined)
      ?? (!this.model ? this.modelError ?? 'no setup model' : undefined);
    if (!block && equity) {
      const entries = this.book.select(now, equity, (cand) => {
        if (!assets.includes(cand.sig.asset)) return undefined;
        const px = this.d.spot(cand.sig.asset, now);
        const q = this.d.hub.get(cand.sig.asset)?.latest;
        if (!(px && px > 0) || q?.bid === undefined || q.ask === undefined || q.isOpen === false) return undefined;
        if (this.d.params.requireValidation && !this.model?.validated(cand.sig.lane)) return undefined;
        return { px, score: this.score(cand.sig, now) };
      });
      for (const e of entries) {
        const t = openTrade(e.cand.sig, e.px, now, this.d.params.costs);
        if (!t) continue;
        const pilot = !this.model?.validated(t.lane);
        // Keep liquidation well beyond the stop: at most half the exchange's leverage for the market.
        const lev = this.d.hub.get(t.asset)?.latest?.leverage;
        const levCap = lev && lev > 0 ? equity * 0.5 * lev : Infinity;
        t.notional = Math.min(pilot ? Math.min(e.notional, this.d.params.pilotMaxNotionalUsd) : e.notional, levCap);
        t.score = e.score;
        this.book.add(t);
        this.lastPx.set(t.asset, e.px);
        changed = true;
        this.d.audit?.write('setup_trade', { event: 'opened', asset: t.asset, lane: t.lane, kind: t.kind, tf: t.tf, dir: t.dir, entry: t.entry, stop: t.stop, target1: t.plan.target1, target2: t.plan.target2, notional: t.notional, score: e.score, pilot });
      }
    }

    // 4. Targets per perp market.
    const out: DirTarget[] = [];
    const flatten = guards.halt ?? this.dayHalt;
    for (const asset of assets) {
      const s = this.d.hub.get(asset)!, l = s.latest!;
      const t = this.book.positions.get(asset);
      const perpPx = l.bid !== undefined && l.ask !== undefined ? (l.bid + l.ask) / 2 : s.price(now, 60_000);
      const spotPx = this.d.spot(asset, now);
      const step = l.fractional ? 0.01 : 1;
      if (flatten) {
        if (t) { t.closed = { ts: now, px: spotPx ?? t.entry, reason: 'manual' }; this.record(t, now); this.book.remove(asset); changed = true; }
        out.push({ asset, ticker: l.ticker, target: 0, urgent: true, reason: `flatten: ${flatten}` });
        this.lastDecisions.set(l.ticker, { target: 0, reason: `flatten: ${flatten}` });
        continue;
      }
      if (!t || !(perpPx && perpPx > 0) || !(spotPx && spotPx > 0)) {
        const why = exitNow.has(asset) ? `exit: ${this.history[this.history.length - 1]?.reason ?? 'stop'}` : t ? 'no perp / spot price: hold' : 'no setup trade';
        if (t && !exitNow.has(asset)) { out.push({ asset, ticker: l.ticker, target: c.positions.get(l.ticker)?.position ?? 0, urgent: false, reason: why }); continue; }
        out.push({ asset, ticker: l.ticker, target: 0, urgent: exitNow.has(asset), reason: why });
        this.lastDecisions.set(l.ticker, { target: 0, reason: why });
        continue;
      }
      const ratio = perpPx / spotPx;
      const contracts = Math.sign(t.dir) * Math.floor(((t.notional ?? 0) * t.frac) / perpPx / step + 1e-9) * step;
      const stopPrice = +(t.stop * ratio).toFixed(4);
      const reason = `${t.lane} ${t.tf} ${t.kind} ${t.dir > 0 ? 'long' : 'short'} from ${t.entry.toFixed(4)}: stop ${t.stop.toFixed(4)}${t.partialDone ? ' (half off, stop at break-even or trailing)' : ''}${t.plan.target1 !== undefined && !t.partialDone ? `, target ${t.plan.target1.toFixed(4)}` : ''}${t.plan.target2 !== undefined ? ` then ${t.plan.target2.toFixed(4)}` : ', trailing'}`;
      out.push({ asset, ticker: l.ticker, target: +contracts.toFixed(4), urgent: false, reason, stopPrice });
      this.lastDecisions.set(l.ticker, { target: contracts, reason, stop: stopPrice });
    }
    if (changed) this.save();
    return out;
  }

  status() {
    const m = this.model;
    const today = this.day ? this.day.realized : 0;
    const open = [...this.book.positions.values()].map((t) => ({ asset: t.asset, lane: t.lane, kind: t.kind, tf: t.tf, dir: t.dir, entry: t.entry, stop: t.stop, target1: t.plan.target1 ?? null, target2: t.plan.target2 ?? null, half_off: t.partialDone, bars: t.bars, notional: t.notional ?? null, score: t.score ?? null, open_r: tradeResult(t, this.lastPx.get(t.asset)).r, usd_at_stop: -(t.notional ?? 0) * Math.abs(t.entry - t.initialStop) / t.entry, usd_at_target1: t.plan.target1 !== undefined ? (t.notional ?? 0) * Math.abs(t.plan.target1 - t.entry) / t.entry : null, open_usd: tradeResult(t, this.lastPx.get(t.asset)).ret * (t.notional ?? 0) }));
    const cand = (lane: Lane) => this.book.queues[lane].map((c) => ({ asset: c.sig.asset, kind: c.sig.kind, tf: c.sig.tf, dir: c.sig.dir, score: c.score, expires: c.expires }));
    return {
      strategy: 'setups',
      model: m ? { version: m.params.version, fast: { validated: m.validated('fast'), blockers: m.blockers('fast') }, slow: { validated: m.validated('slow'), blockers: m.blockers('slow') } } : null,
      modelError: this.modelError ?? null,
      equity: this.equity?.value ?? null, dayStartEquity: this.day?.start ?? null, dayHalt: this.dayHalt ?? null,
      today: { realizedUsd: today, goalUsd: this.d.params.dailyGoalUsd, trades: this.history.filter((h) => this.day && new Date(h.exitTs).toISOString().slice(0, 10) === this.day.key).length },
      lanes: { fast: { open: open.filter((o) => o.lane === 'fast'), queue: cand('fast'), params: this.book.params.fast }, slow: { open: open.filter((o) => o.lane === 'slow'), queue: cand('slow'), params: this.book.params.slow } },
      recentSkips: this.book.lastSkips.slice(0, 20),
      recentTrades: this.history.slice(-20).reverse(),
      decisions: Object.fromEntries(this.lastDecisions),
      lastError: this.lastError ?? null,
    };
  }
}

/** Wilder ATR(14) at the last bar. */
function atrOf(cs: Candle[]): number {
  if (cs.length < 16) return NaN;
  let a = 0;
  const tr = (i: number) => Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
  const from = Math.max(1, cs.length - 200);
  for (let i = from; i < from + 14; i++) a += tr(i);
  a /= 14;
  for (let i = from + 14; i < cs.length; i++) a = (a * 13 + tr(i)) / 14;
  return a;
}

export const defaultSetupParams = (o: Partial<SetupTraderParams> = {}): SetupTraderParams => ({
  book: DEFAULT_LANES, costs: DEFAULT_COSTS, dailyLossFrac: 0.05, minEquityUsd: 5, pilotMaxNotionalUsd: 25, requireValidation: false, dailyGoalUsd: 100, ...o,
});

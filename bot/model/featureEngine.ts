// Candidate features for the meta-model, ported from the old model's signal
// set where the recorded data can support them honestly.
//
// Every feature is computed from the same event stream in production
// (MarketData) and in research replay (ReplayState) through FeatureHub, so
// training inputs and live inputs cannot drift apart. Each returns NaN when
// its data is insufficient; the model imputes NaN as the training mean.
// Candidates only enter a model if offline walk-forward validation selects
// them; every feature set tried counts toward the Deflated Sharpe.
//
// Not ported (no testable basis for a 15-minute binary, or data we don't
// have): macro goal progress, smart-trailing state, latency, funding rate,
// hand-set pattern labels, exit-liquidity heuristics. USDT.D/BTC.D and
// confluence are included as learned inputs (macro / confluence groups).

import { OrderBook } from '../marketdata/orderBook';
import type { IndexTracker } from '../marketdata/indexTracker';
import { clamp, logit, normInv, normPdf, studentTCdf } from '../util/num';
import { kalshiMaintenance, sessionState, usMarketClock, weekPhase, zoneTime } from './sessions';
import { neighborGap, violationAt, type LadderQuote } from './ladder';
import { PerpHub, type PerpSnapshot, type PerpState } from '../perps/perpData';
import { EWMA_LOOKBACK_SEC, seasonalVarianceRatio, type VolProfile } from './volSeasonality';
import { CandleSet, fromRow, takerImbalance, toRow, type CandleRow } from '../ta/candleStore';
import type { Timeframe } from '../ta/knowledge';
import { CONFLUENCES, RULES } from '../ta/knowledge';
import { marketContext } from '../ta/marketContext';
import type { TaSnapshot, TfState } from '../ta/analyzer';
import { activeTaNet, type TaNetOutput } from '../ta/taNet';

export type FeatureGroup = 'base' | 'micro' | 'momentum' | 'spot' | 'macro' | 'confluence' | 'session' | 'time'
  // Relaxed-cadence catalog (minute windows and slower).
  | 'geometry' | 'vol' | 'kalshi' | 'returns' | 'clock' | 'calendar' | 'interaction' | 'ladder' | 'perp'
  // Cortex-like SNN outputs (bot/snn): market-direction calls and the contract fair-value bias.
  | 'snn'
  // TA library on the Coinbase spot USD pair (bot/ta): indicator readings, and rule/confluence scores.
  | 'ta' | 'taconf'
  // TA network (bot/ta/taNet.ts): forecasts learned from years of hourly history, and its live skill.
  | 'tanet';

/** Build tiers from the relaxed-cadence spec: T1 first, T2 only after ablation proves them, T3 experimental. */
export type FeatureTier = 'T1' | 'T2' | 'T3';

/** Bump whenever any feature formula changes; older training rows for changed features are retired. */
export const FEATURE_SCHEMA_VERSION = '3';

/** A scheduled macro release (operator-maintained params/calendar.json). */
export interface MacroEvent { ts: number; kind: 'CPI' | 'FOMC' | 'NFP' | 'PCE' | 'OTHER' }

// ---- One-minute bars of the settlement index --------------------------------

export interface Bar { ts: number; o: number; h: number; l: number; c: number }

/**
 * One-minute OHLC bars of the settlement index (24 h kept) plus EWMA
 * per-minute variances of 1-minute log returns (lambda 0.97 slow, 0.94 fast).
 * Returns are raw; the seasonal variance ratio is a separate feature.
 */
export class BarStore {
  readonly bars: Bar[] = [];
  private cur?: Bar;
  ewmaSlow?: number;
  ewmaFast?: number;
  private n = 0;

  onPrice(value: number, ts: number): void {
    const t = Math.floor(ts / 60_000) * 60_000;
    if (this.cur && t < this.cur.ts) return;
    if (!this.cur || t > this.cur.ts) {
      if (this.cur) this.close(this.cur, t);
      this.cur = { ts: t, o: value, h: value, l: value, c: value };
      return;
    }
    const b = this.cur;
    b.h = Math.max(b.h, value); b.l = Math.min(b.l, value); b.c = value;
  }

  private close(b: Bar, nextTs: number): void {
    const prev = this.bars[this.bars.length - 1];
    // A gap (missing minutes) restarts the return chain.
    if (prev && b.ts - prev.ts === 60_000) {
      const r = Math.log(b.c / prev.c);
      this.ewmaSlow = this.ewmaSlow === undefined ? r * r : 0.97 * this.ewmaSlow + 0.03 * r * r;
      this.ewmaFast = this.ewmaFast === undefined ? r * r : 0.94 * this.ewmaFast + 0.06 * r * r;
      this.n++;
    } else if (prev && nextTs - prev.ts > 10 * 60_000) {
      this.bars.length = 0;
    }
    this.bars.push(b);
    if (this.bars.length > 1500) this.bars.shift();
  }

  /** Per-minute volatility (slow EWMA) once 30 returns are in. */
  sigma1m(): number | undefined {
    return this.ewmaSlow !== undefined && this.n >= 30 ? Math.sqrt(this.ewmaSlow) : undefined;
  }

  /** The last n completed bars if they are contiguous. */
  last(n: number): Bar[] | undefined {
    if (this.bars.length < n) return undefined;
    const out = this.bars.slice(-n);
    for (let i = 1; i < out.length; i++) if (out[i].ts - out[i - 1].ts !== 60_000) return undefined;
    return out;
  }

  /** 1-minute log returns over the last n minutes (n + 1 contiguous bars). */
  returns(n: number): number[] | undefined {
    const b = this.last(n + 1);
    if (!b) return undefined;
    const r: number[] = [];
    for (let i = 1; i < b.length; i++) r.push(Math.log(b[i].c / b[i - 1].c));
    return r;
  }
}

// ---- Per-market microstructure state ----------------------------------------

interface Stamped { ts: number; v: number }

export class MicroTracker {
  private prev?: { bid: number; bidSz: number; ask: number; askSz: number };
  private readonly ofi: Stamped[] = [];
  private readonly trades: Array<{ ts: number; signed: number; count: number }> = [];
  private readonly mids: Stamped[] = [];

  /** Call after every book update (snapshot or delta). Order-flow imbalance per Cont, Kukanov & Stoikov. */
  onBook(book: OrderBook, ts: number): void {
    const b = book.bestBid();
    const a = book.bestAsk();
    if (!b || !a) { this.prev = undefined; return; }
    const cur = { bid: b.price, bidSz: b.size, ask: a.price, askSz: a.size };
    const mid = (b.price + a.price) / 2;
    const lastMid = this.mids[this.mids.length - 1];
    if (!lastMid || ts - lastMid.ts >= 1000) this.mids.push({ ts, v: mid });
    else if (ts >= lastMid.ts) lastMid.v = mid;
    if (this.prev) {
      const p = this.prev;
      const e = (cur.bid >= p.bid ? cur.bidSz : 0) - (cur.bid <= p.bid ? p.bidSz : 0)
        - (cur.ask <= p.ask ? cur.askSz : 0) + (cur.ask >= p.ask ? p.askSz : 0);
      if (e !== 0) this.ofi.push({ ts, v: e });
    }
    this.prev = cur;
    this.trim(ts);
  }

  /** Public trade. takerSide 'yes' lifts YES asks (+), 'no' hits YES bids (-). */
  onTrade(count: number, takerSide: 'yes' | 'no' | undefined, ts: number): void {
    const sign = takerSide === 'yes' ? 1 : takerSide === 'no' ? -1 : 0;
    this.trades.push({ ts, signed: sign * count, count });
    this.trim(ts);
  }

  private trim(now: number): void {
    const cut = now - 960_000;
    while (this.ofi.length && this.ofi[0].ts < cut) this.ofi.shift();
    while (this.trades.length && this.trades[0].ts < cut) this.trades.shift();
    while (this.mids.length && this.mids[0].ts < cut) this.mids.shift();
  }

  /** Mid at or before `ts` (within 5 s), if recorded. */
  midAt(ts: number): number | undefined {
    for (let i = this.mids.length - 1; i >= 0; i--) if (this.mids[i].ts <= ts) return ts - this.mids[i].ts <= 5000 ? this.mids[i].v : undefined;
    return undefined;
  }

  ofiSum(now: number, windowMs: number): number {
    let s = 0;
    for (let i = this.ofi.length - 1; i >= 0 && this.ofi[i].ts >= now - windowMs; i--) s += this.ofi[i].v;
    return s;
  }

  tradesIn(now: number, windowMs: number) {
    return this.trades.filter((t) => t.ts >= now - windowMs && t.ts <= now);
  }
}

/**
 * High/low of the settlement index during the most recent Asian session
 * (Tokyo date). Complete once the Asian session has ended and was observed
 * from (near) its start without large gaps.
 */
export class AsiaRangeTracker {
  private day: string | undefined;
  private hi = 0;
  private lo = 0;
  private first = 0;
  private last = 0;
  private start = 0;
  private maxGap = 0;

  onIndex(value: number, ts: number): void {
    const st = sessionState(ts);
    if (st.key !== 'asia') return;
    const day = zoneTime(ts, 'Asia/Tokyo').ymd;
    if (day !== this.day) {
      this.day = day; this.hi = value; this.lo = value; this.first = ts; this.last = ts; this.maxGap = 0; this.start = st.since ?? ts;
      return;
    }
    if (ts < this.last) return;
    this.hi = Math.max(this.hi, value);
    this.lo = Math.min(this.lo, value);
    this.maxGap = Math.max(this.maxGap, ts - this.last);
    this.last = ts;
  }

  /** The completed range, usable during the following London / New York hours. */
  range(now: number): { hi: number; lo: number } | undefined {
    if (!this.day) return undefined;
    const k = sessionState(now).key;
    if (k !== 'london' && k !== 'london_ny_overlap' && k !== 'new_york') return undefined;
    if (now - this.last > 16 * 3_600_000) return undefined;
    if (this.first - this.start > 15 * 60_000 || this.maxGap > 10 * 60_000 || !(this.hi > this.lo)) return undefined;
    return { hi: this.hi, lo: this.lo };
  }
}

/** Shared event sink: production and replay both drive features through this. */
export class FeatureHub {
  readonly micro = new Map<string, MicroTracker>();
  readonly asiaRange = new Map<string, AsiaRangeTracker>();
  readonly bars = new Map<string, BarStore>();
  /** Kalshi perpetuals per asset (premium to the index, funding, open interest). */
  readonly perps = new PerpHub();
  onPerp(s: PerpSnapshot): void { this.perps.apply(s); }
  /** Coinbase spot candles per asset (TA library); returns the rows that were new. */
  readonly candles = new Map<string, CandleSet>();
  onCandles(asset: string, tf: Timeframe, rows: CandleRow[], ts: number): CandleRow[] {
    let set = this.candles.get(asset);
    if (!set) { set = new CandleSet(asset); this.candles.set(asset, set); }
    return set.add(tf, rows.map(fromRow), ts).map(toRow);
  }
  onIndex(asset: string, value: number, ts: number): void {
    let b = this.bars.get(asset);
    if (!b) { b = new BarStore(); this.bars.set(asset, b); }
    b.onPrice(value, ts);
    let t = this.asiaRange.get(asset);
    if (!t) { t = new AsiaRangeTracker(); this.asiaRange.set(asset, t); }
    t.onIndex(value, ts);
  }
  tracker(ticker: string): MicroTracker {
    let m = this.micro.get(ticker);
    if (!m) { m = new MicroTracker(); this.micro.set(ticker, m); }
    return m;
  }
  onBook(ticker: string, book: OrderBook, ts: number): void { this.tracker(ticker).onBook(book, ts); }
  onTrade(ticker: string, count: number, takerSide: 'yes' | 'no' | undefined, ts: number): void { this.tracker(ticker).onTrade(count, takerSide, ts); }
  forget(ticker: string): void { this.micro.delete(ticker); }
}

// ---- Registry --------------------------------------------------------------

export interface FeatureContext {
  now: number;
  fairValue: number;
  mid: number;
  tauSec: number;
  sigmaPerSqrtSec: number;
  referenceSigma: number;
  inWindow: boolean;
  book: OrderBook;
  micro?: MicroTracker;
  index: IndexTracker;
  spot?: IndexTracker;
  /** Underlying asset symbol (BTC, ETH, ...). */
  asset?: string;
  /** USDT.D and BTC.D trackers (percent). */
  usdtd?: IndexTracker;
  btcd?: IndexTracker;
  /** Contract close time (for the seasonal volatility ratio). */
  closeTs?: number;
  /** Fitted intraday volatility profile, when available. */
  volProfile?: VolProfile;
  /** Asian-session range tracker for this asset. */
  asiaRange?: AsiaRangeTracker;
  /** Contract terms and the pricer's outputs for this contract. */
  kind?: string;
  strike?: number;
  cap?: number;
  d2?: number;
  vEff?: number;
  sigmaPricing?: number;
  tNu?: number;
  openTime?: number;
  /** One-minute bars of the settlement index for this asset. */
  bars?: BarStore;
  /** Scheduled macro releases. */
  calendar?: MacroEvent[];
  /** This contract's ticker and the other strikes/brackets settling with it (hourly events). */
  ticker?: string;
  siblings?: LadderQuote[];
  /** Kalshi perp state for this contract's asset. */
  perp?: PerpState;
  /** Coinbase spot candles for this contract's asset (TA library). */
  candles?: CandleSet;
  /** SNN outputs for this asset: P(up) per direction horizon (minutes), expected signed move in bps,
   *  and the SNN's P(YES) for this contract. Missing -> features NaN (imputed as the training mean). */
  snn?: SnnContext;
}

export interface SnnContext {
  up?: Partial<Record<15 | 60 | 240, number>>;
  move?: Partial<Record<15 | 60 | 240, number>>;
  /** Confidence of each call, from the network's own graded history. */
  conf?: Partial<Record<15 | 60 | 240, SnnConf>>;
  pContract?: number;
}

/** skill / contractSkill = 1 - Brier/0.25 (0 = coin flip); calConf = calibration confidence of the
 *  contract readout; surpriseRatio = surprise vs normal (> 1 = confused); G = governor; labelled =
 *  graded direction calls. NaN until enough history. */
export interface SnnConf { skill?: number; calConf?: number; contractSkill?: number; surpriseRatio?: number; G?: number; labelled?: number }

/** Direction horizon matching a contract: 15-minute contracts -> 15, longer (hourly ladders) -> 60. */
export const snnHorizonFor = (c: { openTime?: number; closeTs?: number; tauSec: number }): 15 | 60 =>
  (c.openTime && c.closeTs ? (c.closeTs - c.openTime) / 60_000 : c.tauSec / 60) <= 20 ? 15 : 60;

const snnLogit = (p: number | undefined) => (p === undefined || !Number.isFinite(p) ? NA : clip(Math.log(clamp(p, 1e-4, 1 - 1e-4) / (1 - clamp(p, 1e-4, 1 - 1e-4))), 6));
const snnConfOf = (c: FeatureContext, h: 15 | 60 | 240, k: keyof SnnConf, lim: number) => {
  const v = c.snn?.conf?.[h]?.[k];
  return v === undefined || !Number.isFinite(v) ? NA : clip(v, lim);
};
const snnMoveZ = (c: FeatureContext, h: 15 | 60 | 240) => {
  const m = c.snn?.move?.[h];
  if (m === undefined || !Number.isFinite(m) || !(c.sigmaPerSqrtSec > 0)) return NA;
  return clip(m / 1e4 / (c.sigmaPerSqrtSec * Math.sqrt(h * 60)), 5);
};

type Fn = (c: FeatureContext, cache: Cache) => number;
interface Cache { idx: Map<number, number[] | undefined>; spot: Map<number, number[] | undefined>; memo: Map<string, number>; ta?: TaSnapshot | null; tanet?: TaNetOutput | null }

const NA = NaN;
const clip = (x: number, lim = 10) => (Number.isFinite(x) ? clamp(x, -lim, lim) : NA);
const series = (c: FeatureContext, k: Cache, sec: number) => {
  if (!k.idx.has(sec)) k.idx.set(sec, c.index.series(c.now, sec));
  return k.idx.get(sec);
};
const spotSeries = (c: FeatureContext, k: Cache, sec: number) => {
  if (!c.spot) return undefined;
  if (!k.spot.has(sec)) k.spot.set(sec, c.spot.series(c.now, sec));
  return k.spot.get(sec);
};
const retZ = (sec: number): Fn => (c, k) => {
  const s = series(c, k, sec);
  return s ? clip(Math.log(s[s.length - 1] / s[0]) / (c.sigmaPerSqrtSec * Math.sqrt(sec))) : NA;
};
function ema(xs: number[], n: number): number[] {
  const a = 2 / (n + 1);
  const out: number[] = [];
  let e = xs[0];
  for (const x of xs) { e = a * x + (1 - a) * e; out.push(e); }
  return out;
}
const memo = (k: Cache, key: string, f: () => number): number => {
  if (!k.memo.has(key)) k.memo.set(key, f());
  return k.memo.get(key)!;
};

/** Sigma-scaled log change of a dominance series over `sec` seconds. */
const domZ = (tr: IndexTracker | undefined, c: FeatureContext, sec: number): number => {
  if (!tr) return NA;
  const s = tr.series(c.now, sec, 10_000);
  const v = tr.vol(120);
  if (!s || !v || !(v.sigmaPerSqrtSec > 0)) return NA;
  return clip(Math.log(s[s.length - 1] / s[0]) / (v.sigmaPerSqrtSec * Math.sqrt(sec)));
};

/** Deviation of the latest value from its trailing-hour mean, in standard deviations. */
const levelDev = (tr: IndexTracker | undefined, c: FeatureContext): number => {
  if (!tr) return NA;
  const s = tr.series(c.now, 3600, 10_000);
  if (!s) return NA;
  const m = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / s.length);
  return sd > 0 ? clip((s[s.length - 1] - m) / sd) : 0;
};

/** RSI(14) on one-minute closes of the settlement index, scaled to [-1, 1] (oversold < 0). */
const rsi14x1m = (c: FeatureContext, k: Cache): number => memo(k, 'rsi14', () => {
  const s = series(c, k, 15 * 60);
  if (!s) return NA;
  const closes = s.filter((_, i) => i % 60 === 0);
  let up = 0, dn = 0;
  for (let i = 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) up += d; else dn -= d; }
  return up + dn > 0 ? (100 - 100 / (1 + up / Math.max(1e-12, dn)) - 50) / 50 : 0;
});

// Oriented macro factors: positive = bullish for THIS contract's underlying.
const riskOn5m = (c: FeatureContext, k: Cache) => memo(k, 'riskOn5m', () => -domZ(c.usdtd, c, 300));     // USDT.D falling
const btcdRel5m = (c: FeatureContext, k: Cache) => memo(k, 'btcdRel5m', () => {
  const z = domZ(c.btcd, c, 300);
  return (c.asset ?? 'BTC') === 'BTC' ? z : -z;                                                        // BTC.D rising helps BTC, falling helps alts
});
const mom = (sec: number) => (c: FeatureContext, k: Cache) => memo(k, `mom${sec}`, () => retZ(sec)(c, k));

/**
 * Confluence: non-zero only when every factor points the same way; signed by
 * that direction; magnitude is the geometric mean of the factor strengths.
 */
export function agree(...xs: number[]): number {
  if (xs.some((x) => !Number.isFinite(x))) return NA;
  const sgn = Math.sign(xs[0]);
  if (sgn === 0 || xs.some((x) => Math.sign(x) !== sgn)) return 0;
  return sgn * Math.exp(xs.reduce((a, x) => a + Math.log(Math.abs(x)), 0) / xs.length);
}

const midRange = (sec: number): Fn => (c, k) => {
  const s = series(c, k, sec);
  if (!s) return NA;
  const mid = (Math.max(...s) + Math.min(...s)) / 2;
  const S = s[s.length - 1];
  return clip(Math.log(S / mid) / (c.sigmaPerSqrtSec * Math.sqrt(sec)));
};

// ---- Relaxed-cadence helpers --------------------------------------------------

const rvLog = (c: FeatureContext, min: number): number => {
  const r = c.bars?.returns(min);
  if (!r) return NA;
  const ms = r.reduce((a, x) => a + x * x, 0) / r.length;
  return ms > 0 ? Math.log(ms) : NA;
};
/** Log return over `min` minutes (current price vs the close `min` bars ago) / (sigma_1m sqrt(min)). */
const barRetZ = (min: number): Fn => (c) => {
  const b = c.bars?.last(min);
  const s = c.bars?.sigma1m();
  const S = c.index.latest()?.value;
  if (!b || !s || S === undefined) return NA;
  return clip(Math.log(S / b[0].c) / (s * Math.sqrt(min)));
};
const efficiency = (min: number): Fn => (c) => {
  const r = c.bars?.returns(min);
  if (!r) return NA;
  const path = r.reduce((a, x) => a + Math.abs(x), 0);
  return path > 0 ? Math.abs(r.reduce((a, x) => a + x, 0)) / path : 0;
};
const rangePos = (min: number): Fn => (c) => {
  const b = c.bars?.last(min);
  const S = c.index.latest()?.value;
  if (!b || S === undefined) return NA;
  const hi = Math.max(...b.map((x) => x.h)), lo = Math.min(...b.map((x) => x.l));
  return hi > lo ? clamp((S - lo) / (hi - lo), -0.5, 1.5) : 0.5;
};
const distExtreme = (min: number, which: 'high' | 'low'): Fn => (c) => {
  const b = c.bars?.last(min);
  const s = c.bars?.sigma1m();
  const S = c.index.latest()?.value;
  if (!b || !s || S === undefined) return NA;
  const x = which === 'high' ? Math.max(...b.map((y) => y.h)) : Math.min(...b.map((y) => y.l));
  return clip(Math.log(S / x) / (s * Math.sqrt(min)));
};
/** Kalshi order flow over `sec`: signed taker contracts / (trailing 15-min volume rate x window). */
const kalshiFlow = (sec: number): Fn => (c) => {
  if (!c.micro) return NA;
  const all = c.micro.tradesIn(c.now, 900_000);
  const vol = all.reduce((a, x) => a + x.count, 0);
  if (!(vol > 0)) return 0;
  const w = c.micro.tradesIn(c.now, sec * 1000).reduce((a, x) => a + x.signed, 0);
  return clip(w / ((vol / 900) * sec));
};
const midChange = (sec: number): Fn => (c) => {
  const then = c.micro?.midAt(c.now - sec * 1000);
  return then === undefined ? NA : c.mid - then;
};
const ofiDepth = (sec: number): Fn => (c) => {
  if (!c.micro) return NA;
  const b = c.book.bestBid(), a = c.book.bestAsk();
  const depth = ((b?.size ?? 0) + (a?.size ?? 0)) / 2;
  return depth > 0 ? clip(c.micro.ofiSum(c.now, sec * 1000) / depth / Math.sqrt(sec / 30)) : NA;
};
/** Pricer outputs only exist for single-threshold contracts before the averaging window. */
const hasGeometry = (c: FeatureContext) => (c.kind === 'updown' || c.kind === 'greater') && !c.inWindow && Number.isFinite(c.d2) && (c.vEff ?? 0) > 0;
/** Fixed nu = 5 so the feature never depends on which pricer nu a model was trained with. */
const pAnalyticT = (c: FeatureContext): number => {
  if (!hasGeometry(c)) return NA;
  const nu = 5;
  return studentTCdf(c.d2! / Math.sqrt((nu - 2) / nu), nu);
};
const logitGap = (c: FeatureContext): number => {
  const p = pAnalyticT(c);
  return Number.isFinite(p) ? clip(logit(c.mid) - logit(p)) : clip(logit(c.mid) - logit(c.fairValue));
};
const macroClock = (c: FeatureContext, dir: 'to' | 'since'): number => {
  if (!c.calendar?.length) return NA;
  let best = Infinity;
  for (const e of c.calendar) {
    const dt = dir === 'to' ? e.ts - c.now : c.now - e.ts;
    if (dt >= 0 && dt < best) best = dt;
  }
  return best <= 86_400_000 ? Math.min(240, best / 60_000) : NA;
};
const minuteOfHour = (now: number) => (now % 3_600_000) / 60_000;
const perpRetDiff = (c: FeatureContext, k: Cache, sec: number): number => {
  const ps = c.perp?.mid.series(c.now, sec, 15_000), ix = series(c, k, sec);
  if (!ps || !ix) return NA;
  return clip((Math.log(ps[ps.length - 1] / ps[0]) - Math.log(ix[ix.length - 1] / ix[0])) / (c.sigmaPerSqrtSec * Math.sqrt(sec)));
};

export const FEATURES: Record<string, { group: FeatureGroup; description: string; fn: Fn; tier?: FeatureTier }> = {
  // Base (the original v2 set).
  logit_fv: { group: 'base', description: 'digital-option fair value (log-odds)', fn: (c) => logit(c.fairValue) },
  logit_mid: { group: 'base', description: 'market mid (log-odds)', fn: (c) => logit(c.mid) },
  fv_minus_mid: { group: 'base', description: 'fair value minus mid', fn: (c) => c.fairValue - c.mid },
  sqrt_tau_min: { group: 'base', description: 'sqrt(minutes to close)', fn: (c) => Math.sqrt(Math.max(0, c.tauSec) / 60) },
  log_vol_ratio: { group: 'base', description: 'log(sigma / reference sigma)', fn: (c) => Math.log(Math.max(1e-12, c.sigmaPerSqrtSec) / Math.max(1e-12, c.referenceSigma)) },
  spread: { group: 'base', description: 'YES ask - YES bid', fn: (c) => { const b = c.book.bestBid(), a = c.book.bestAsk(); return b && a ? clamp(a.price - b.price, 0, 1) : NA; } },
  imbalance: { group: 'base', description: 'top-3 depth imbalance', fn: (c) => clamp(c.book.imbalance(3), -1, 1) },
  in_window: { group: 'base', description: 'inside settlement averaging window', fn: (c) => (c.inWindow ? 1 : 0) },

  // Microstructure (old: orderFlowImbalance, tradeFlowImbalance, vpin, micropriceDrift, relativeVolume).
  ofi_30s: { group: 'micro', description: 'order-flow imbalance, 30s, / top-of-book depth', fn: (c) => {
    if (!c.micro) return NA;
    const b = c.book.bestBid(), a = c.book.bestAsk();
    const depth = ((b?.size ?? 0) + (a?.size ?? 0)) / 2;
    return depth > 0 ? clip(c.micro.ofiSum(c.now, 30_000) / depth) : NA;
  } },
  microprice_drift: { group: 'micro', description: '(microprice - mid) / spread', fn: (c) => {
    const b = c.book.bestBid(), a = c.book.bestAsk();
    if (!b || !a || b.size + a.size <= 0) return NA;
    const micro = (b.price * a.size + a.price * b.size) / (b.size + a.size);
    return clip((micro - (b.price + a.price) / 2) / Math.max(0.01, a.price - b.price), 1);
  } },
  depth_imbalance_5: { group: 'micro', description: 'top-5 depth imbalance', fn: (c) => clamp(c.book.imbalance(5), -1, 1) },
  tfi_60s: { group: 'micro', description: 'signed taker volume / total, 60s', fn: (c) => {
    const t = c.micro?.tradesIn(c.now, 60_000) ?? [];
    const tot = t.reduce((s, x) => s + x.count, 0);
    return tot > 0 ? t.reduce((s, x) => s + x.signed, 0) / tot : NA;
  } },
  vpin_300s: { group: 'micro', description: 'VPIN-style toxicity over 300s (10 volume buckets)', fn: (c) => {
    const t = c.micro?.tradesIn(c.now, 300_000) ?? [];
    const tot = t.reduce((s, x) => s + x.count, 0);
    if (t.length < 10 || tot <= 0) return NA;
    const bucket = tot / 10;
    let acc = 0, signed = 0, sumAbs = 0, n = 0;
    for (const x of t) {
      acc += x.count; signed += x.signed;
      if (acc >= bucket) { sumAbs += Math.abs(signed) / acc; n++; acc = 0; signed = 0; }
    }
    return n ? sumAbs / n : NA;
  } },
  trade_intensity_60s: { group: 'micro', description: 'log(1 + contracts traded in 60s)', fn: (c) => (c.micro ? Math.log1p(c.micro.tradesIn(c.now, 60_000).reduce((s, x) => s + x.count, 0)) : NA) },

  // Momentum / TA on the settlement index (old: rsi, macd, bollinger %B, kaufmanEfficiency, ichimoku, momentum).
  ret_10s_z: { group: 'momentum', description: '10s index log return / (sigma*sqrt(10))', fn: retZ(10) },
  ret_60s_z: { group: 'momentum', description: '60s index log return, sigma-scaled', fn: retZ(60) },
  ret_300s_z: { group: 'momentum', description: '300s index log return, sigma-scaled', fn: retZ(300) },
  rsi_60: { group: 'momentum', description: 'RSI over 60 one-second returns, (rsi-50)/50', fn: (c, k) => {
    const s = series(c, k, 60);
    if (!s) return NA;
    let up = 0, dn = 0;
    for (let i = 1; i < s.length; i++) { const d = s[i] - s[i - 1]; if (d > 0) up += d; else dn -= d; }
    return up + dn > 0 ? (100 - 100 / (1 + up / Math.max(1e-12, dn)) - 50) / 50 : 0;
  } },
  macd_hist_z: { group: 'momentum', description: 'MACD(12,26,9) histogram on 5s samples, sigma-scaled', fn: (c, k) => {
    const s = series(c, k, 600);
    if (!s) return NA;
    const x = s.filter((_, i) => i % 5 === 0);
    const e12 = ema(x, 12), e26 = ema(x, 26);
    const macd = e12.map((v, i) => v - e26[i]);
    const sig = ema(macd, 9);
    const S = s[s.length - 1];
    return clip((macd[macd.length - 1] - sig[sig.length - 1]) / (S * c.sigmaPerSqrtSec * Math.sqrt(60)));
  } },
  bb_pctb_300: { group: 'momentum', description: 'Bollinger %B over 300s, centred', fn: (c, k) => {
    const s = series(c, k, 300);
    if (!s) return NA;
    const m = s.reduce((a, b) => a + b, 0) / s.length;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / s.length);
    return sd > 0 ? clip((s[s.length - 1] - (m - 2 * sd)) / (4 * sd) - 0.5, 3) : 0;
  } },
  kaufman_er_120: { group: 'momentum', description: 'Kaufman efficiency ratio, 120s', fn: (c, k) => {
    const s = series(c, k, 120);
    if (!s) return NA;
    let path = 0;
    for (let i = 1; i < s.length; i++) path += Math.abs(s[i] - s[i - 1]);
    return path > 0 ? Math.abs(s[s.length - 1] - s[0]) / path : 0;
  } },
  vol_ratio_60: { group: 'momentum', description: 'log(realized sigma 60s / EWMA sigma)', fn: (c, k) => {
    const s = series(c, k, 60);
    if (!s) return NA;
    let ss = 0;
    for (let i = 1; i < s.length; i++) ss += Math.log(s[i] / s[i - 1]) ** 2;
    const rv = Math.sqrt(ss / (s.length - 1));
    return rv > 0 ? clip(Math.log(rv / c.sigmaPerSqrtSec), 5) : -5;
  } },
  rsi_14_1m: { group: 'momentum', description: 'RSI(14) on 1-minute index closes, (rsi-50)/50', fn: (c, k) => rsi14x1m(c, k) },
  tenkan_dist: { group: 'momentum', description: 'distance to 9-min midrange (Ichimoku tenkan), sigma-scaled', fn: midRange(540) },
  kijun_dist: { group: 'momentum', description: 'distance to 26-min midrange (Ichimoku kijun), sigma-scaled', fn: midRange(1560) },

  // Spot lead-lag (old: leadLagCorrelation, coinbase features). Coinbase spot vs the CF RTI.
  spot_basis_bps: { group: 'spot', description: 'Coinbase spot vs settlement index, bps', fn: (c) => {
    const sp = c.spot?.fresh(c.now, 3000);
    const ix = c.index.latest();
    return sp && ix ? clip(1e4 * Math.log(sp.value / ix.value), 50) : NA;
  } },
  spot_lead_10s_z: { group: 'spot', description: 'spot 10s return minus index 10s return, sigma-scaled', fn: (c, k) => {
    const sp = spotSeries(c, k, 10);
    const ix = series(c, k, 10);
    if (!sp || !ix) return NA;
    return clip((Math.log(sp[sp.length - 1] / sp[0]) - Math.log(ix[ix.length - 1] / ix[0])) / (c.sigmaPerSqrtSec * Math.sqrt(10)));
  } },

  // Macro: USDT.D / BTC.D via Binance prices anchored to CoinGecko (old: usdtDominance locks, now a learned input).
  usdtd_ret_5m_z: { group: 'macro', description: 'USDT.D 5-min change, sigma-scaled (negative = risk-on)', fn: (c) => domZ(c.usdtd, c, 300) },
  usdtd_ret_15m_z: { group: 'macro', description: 'USDT.D 15-min change, sigma-scaled', fn: (c) => domZ(c.usdtd, c, 900) },
  usdtd_level_dev_1h: { group: 'macro', description: 'USDT.D vs its 1-hour mean, in std devs', fn: (c) => levelDev(c.usdtd, c) },
  btcd_ret_5m_z: { group: 'macro', description: 'BTC.D 5-min change, sigma-scaled', fn: (c) => domZ(c.btcd, c, 300) },
  btcd_ret_15m_z: { group: 'macro', description: 'BTC.D 15-min change, sigma-scaled', fn: (c) => domZ(c.btcd, c, 900) },
  btcd_level_dev_1h: { group: 'macro', description: 'BTC.D vs its 1-hour mean, in std devs', fn: (c) => levelDev(c.btcd, c) },
  btcd_rel_5m_z: { group: 'macro', description: 'BTC.D 5-min change oriented to the asset (+ for BTC, - for alts)', fn: (c, k) => btcdRel5m(c, k) },

  // Confluence: explicit agreement between independent factors. Weights are LEARNED
  // offline (never hand-set); a factor set that agrees raises or lowers P(YES)
  // only as much as validation supports, which then scales edge, size and aggressiveness.
  conf_riskon_momentum: { group: 'confluence', description: 'USDT.D falling AND index rising (or the bearish mirror)', fn: (c, k) => agree(riskOn5m(c, k), mom(300)(c, k)) },
  conf_riskon_momentum_rsi: { group: 'confluence', description: 'USDT.D falling AND index rising AND RSI(14,1m) oversold (or mirror)', fn: (c, k) => agree(riskOn5m(c, k), mom(60)(c, k), -3 * rsi14x1m(c, k)) },
  conf_btcd_momentum: { group: 'confluence', description: 'BTC.D favouring this asset AND index rising (or mirror)', fn: (c, k) => agree(btcdRel5m(c, k), mom(300)(c, k)) },
  conf_macro_pair: { group: 'confluence', description: 'USDT.D and asset-oriented BTC.D agree', fn: (c, k) => agree(riskOn5m(c, k), btcdRel5m(c, k)) },
  conf_riskon_orderflow: { group: 'confluence', description: 'USDT.D falling AND Kalshi order flow buying YES (or mirror)', fn: (c, k) => agree(riskOn5m(c, k), FEATURES.ofi_30s.fn(c, k)) },
  conf_count: { group: 'confluence', description: 'bullish minus bearish factors with |z| > 1 (macro, momentum, RSI, order flow, spot lead)', fn: (c, k) => {
    const factors = [riskOn5m(c, k), btcdRel5m(c, k), mom(60)(c, k), mom(300)(c, k), -3 * rsi14x1m(c, k), FEATURES.ofi_30s.fn(c, k), FEATURES.spot_lead_10s_z.fn(c, k)];
    const avail = factors.filter(Number.isFinite);
    if (avail.length < 3) return NA;
    return avail.reduce((a, x) => a + (x > 1 ? 1 : x < -1 ? -1 : 0), 0);
  } },

  // Order-flow excitation (Hawkes-style): exponentially-decayed Kalshi trade intensity,
  // fast (10 s) vs slow (300 s) kernel. Bursts of self-exciting flow read > 0.
  hawkes_excitation: { group: 'micro', description: 'log ratio of 10s vs 300s exponentially-decayed trade intensity (Hawkes-style burst)', fn: (c) => {
    const t = c.micro?.tradesIn(c.now, 600_000) ?? [];
    if (!t.length) return NA;
    let fast = 0, slow = 0;
    for (const x of t) {
      const age = (c.now - x.ts) / 1000;
      fast += x.count * Math.exp(-age / 10) / 10;
      slow += x.count * Math.exp(-age / 300) / 300;
    }
    return clip(Math.log((fast + 1e-3) / (slow + 1e-3)), 8);
  } },

  // Market sessions (old: tradingSession card). DST-correct via IANA zones; see sessions.ts.
  sess_asia: { group: 'session', description: 'Asian session (Tokyo/Hong Kong open)', fn: (c) => (sessionState(c.now).key === 'asia' ? 1 : 0) },
  sess_london: { group: 'session', description: 'London session (NY closed)', fn: (c) => (sessionState(c.now).key === 'london' ? 1 : 0) },
  sess_overlap: { group: 'session', description: 'London / New York overlap', fn: (c) => (sessionState(c.now).key === 'london_ny_overlap' ? 1 : 0) },
  sess_new_york: { group: 'session', description: 'New York session (London closed)', fn: (c) => (sessionState(c.now).key === 'new_york' ? 1 : 0) },
  sess_twilight: { group: 'session', description: 'US close -> Asia open transition (liquidity trough)', fn: (c) => (sessionState(c.now).key === 'twilight' ? 1 : 0) },
  sess_weekend: { group: 'session', description: 'weekend market (Fri 16:00 ET US close -> Sun 18:00 ET): thin, low volume', fn: (c) => (sessionState(c.now).key === 'weekend' ? 1 : 0) },
  sess_pre_week: { group: 'session', description: 'pre-week phase (Sun 18:00 ET CME reopen -> Mon 09:30 ET US open)', fn: (c) => (sessionState(c.now).key === 'pre_week' ? 1 : 0) },
  sess_min_to_transition: { group: 'session', description: 'log(1 + minutes until the next session change)', fn: (c) => Math.log1p(sessionState(c.now).minutesToTransition) },
  sess_min_since_transition: { group: 'session', description: 'log(1 + minutes since the session began)', fn: (c) => Math.log1p(sessionState(c.now).minutesSinceTransition) },
  us_open_window: { group: 'session', description: 'first 30 min after the NYSE open (ETF-era volatility spike)', fn: (c) => (sessionState(c.now).usOpenWindow ? 1 : 0) },
  monday_asia_open: { group: 'session', description: 'first 3 h after the Monday Tokyo open', fn: (c) => (sessionState(c.now).mondayAsiaOpen ? 1 : 0) },
  vol_season_ratio: { group: 'session', description: 'log seasonal variance ratio, contract window vs EWMA lookback (needs a fitted profile)', fn: (c) => {
    if (!c.volProfile || c.closeTs === undefined) return NA;
    return Math.log(seasonalVarianceRatio(c.volProfile, c.asset ?? '*', c.now, c.closeTs, EWMA_LOOKBACK_SEC));
  } },
  // Asian-range ideas from practitioner (ICT/SMC) literature: no peer-reviewed support; kept
  // only as candidates the trainer can reject.
  asia_range_pos: { group: 'session', description: 'index position vs completed Asian-session range (-1 low, +1 high; beyond = breakout) [weak evidence]', fn: (c) => {
    const r = c.asiaRange?.range(c.now);
    const S = c.index.latest()?.value;
    if (!r || S === undefined) return NA;
    return clip((S - (r.hi + r.lo) / 2) / ((r.hi - r.lo) / 2), 5);
  } },
  asia_range_break: { group: 'session', description: '+1 above / -1 below the completed Asian range, 0 inside [weak evidence]', fn: (c) => {
    const r = c.asiaRange?.range(c.now);
    const S = c.index.latest()?.value;
    if (!r || S === undefined) return NA;
    return S > r.hi ? 1 : S < r.lo ? -1 : 0;
  } },

  // Time (old: hourOfDay, dayOfWeek, tradingSession).
  hour_sin: { group: 'time', description: 'sin(UTC hour)', fn: (c) => Math.sin((2 * Math.PI * (new Date(c.now).getUTCHours() + new Date(c.now).getUTCMinutes() / 60)) / 24) },
  hour_cos: { group: 'time', description: 'cos(UTC hour)', fn: (c) => Math.cos((2 * Math.PI * (new Date(c.now).getUTCHours() + new Date(c.now).getUTCMinutes() / 60)) / 24) },
  weekend: { group: 'time', description: '1 in the weekend market (Fri 16:00 -> Sun 18:00 ET)', fn: (c) => (weekPhase(c.now) === 'weekend' ? 1 : 0) },
  pre_week: { group: 'time', description: '1 in the pre-week phase (Sun 18:00 -> Mon 09:30 ET)', fn: (c) => (weekPhase(c.now) === 'pre_week' ? 1 : 0) },

  // ===== Relaxed-cadence catalog (1-minute windows and slower) =====
  // A. Contract and settlement geometry.
  log_tau: { group: 'geometry', tier: 'T1', description: 'log(seconds to close)', fn: (c) => Math.log(Math.max(1, c.tauSec)) },
  strike_dist_z: { group: 'geometry', tier: 'T1', description: 'ln(S/K) / sqrt(v_eff)', fn: (c) => { const S = c.index.latest()?.value; return hasGeometry(c) && S && c.strike ? clip(Math.log(S / c.strike) / Math.sqrt(c.vEff!)) : NA; } },
  d2: { group: 'geometry', tier: 'T1', description: '(ln(S/K) - v_eff/2) / sqrt(v_eff)', fn: (c) => (hasGeometry(c) ? clip(c.d2!) : NA) },
  phi_d2: { group: 'geometry', tier: 'T1', description: 'normal density at d2: sensitivity to the next move', fn: (c) => (hasGeometry(c) ? normPdf(c.d2!) : NA) },
  p_analytic_t: { group: 'geometry', tier: 'T1', description: 'Student-t (nu = 5) pricer probability (log-odds)', fn: (c) => { const p = pAnalyticT(c); return Number.isFinite(p) ? logit(p) : NA; } },
  kind_updown: { group: 'geometry', tier: 'T1', description: '15-minute Up/Down contract', fn: (c) => (c.kind === undefined ? NA : c.kind === 'updown' ? 1 : 0) },
  kind_greater: { group: 'geometry', tier: 'T1', description: 'hourly greater-than ladder strike', fn: (c) => (c.kind === undefined ? NA : c.kind === 'greater' ? 1 : 0) },
  kind_between: { group: 'geometry', tier: 'T1', description: 'hourly range bracket', fn: (c) => (c.kind === undefined ? NA : c.kind === 'between' ? 1 : 0) },
  bracket_width_z: { group: 'geometry', tier: 'T2', description: '(cap - floor) / (S sqrt(v_eff)), brackets only', fn: (c) => { const S = c.index.latest()?.value; const v = (c.sigmaPricing ?? c.sigmaPerSqrtSec) ** 2 * Math.max(1, c.tauSec - 40); return c.kind === 'between' && c.cap && c.strike && S ? clip((c.cap - c.strike) / (S * Math.sqrt(v)), 20) : NA; } },

  // C. Volatility (1-minute returns).
  log_rv_15m: { group: 'vol', tier: 'T1', description: 'log mean squared 1-min return, 15 min', fn: (c) => rvLog(c, 15) },
  log_rv_1h: { group: 'vol', tier: 'T1', description: 'log mean squared 1-min return, 1 h', fn: (c) => rvLog(c, 60) },
  log_rv_4h: { group: 'vol', tier: 'T1', description: 'log mean squared 1-min return, 4 h', fn: (c) => rvLog(c, 240) },
  ewma_vol_ratio: { group: 'vol', tier: 'T1', description: 'sqrt(fast / slow EWMA variance): volatility accelerating (>1) or fading', fn: (c) => { const b = c.bars; return b?.sigma1m() && b.ewmaFast !== undefined && b.ewmaSlow! > 0 ? clip(Math.sqrt(b.ewmaFast / b.ewmaSlow!), 5) : NA; } },
  vol_ratio_15m_4h: { group: 'vol', tier: 'T1', description: 'log(rv_15m / rv_4h)', fn: (c) => { const a = rvLog(c, 15), b = rvLog(c, 240); return Number.isFinite(a) && Number.isFinite(b) ? clip(a - b) : NA; } },
  jump_ratio_1h: { group: 'vol', tier: 'T1', description: 'max(RV - BV, 0) / RV over 60 one-minute returns (bipower variation)', fn: (c) => {
    const r = c.bars?.returns(60);
    if (!r) return NA;
    const rv = r.reduce((a, x) => a + x * x, 0);
    let bv = 0;
    for (let i = 1; i < r.length; i++) bv += Math.abs(r[i]) * Math.abs(r[i - 1]);
    bv *= Math.PI / 2;
    return rv > 0 ? Math.max(0, rv - bv) / rv : 0;
  } },
  jump_count_4h: { group: 'vol', tier: 'T2', description: '1-minute returns beyond 4 sigma in 4 h', fn: (c) => { const r = c.bars?.returns(240); const s = c.bars?.sigma1m(); return r && s ? r.filter((x) => Math.abs(x) > 4 * s).length : NA; } },
  garman_klass_15m: { group: 'vol', tier: 'T2', description: 'log Garman-Klass variance from 1-min OHLC, 15 min', fn: (c) => {
    const b = c.bars?.last(15);
    if (!b) return NA;
    const v = b.reduce((a, x) => a + 0.5 * Math.log(x.h / x.l) ** 2 - (2 * Math.LN2 - 1) * Math.log(x.c / x.o) ** 2, 0) / b.length;
    return v > 0 ? Math.log(v) : NA;
  } },

  // D. Kalshi market state.
  logit_gap: { group: 'kalshi', tier: 'T1', description: 'logit(mid) - logit(analytic price): where the market disagrees with the pricer', fn: (c) => logitGap(c) },
  sigma_gap: { group: 'kalshi', tier: 'T1', description: '0.5 ln(market-implied variance / v_eff); null near the money', fn: (c) => {
    const S = c.index.latest()?.value;
    if (!hasGeometry(c) || !S || !c.strike) return NA;
    const x = Math.log(S / c.strike);
    const z = normInv(clamp(c.mid, 0.01, 0.99));
    if (Math.abs(z) < 0.1 || Math.abs(x) < 1e-5 || Math.sign(x) !== Math.sign(z)) return NA;
    return clip(0.5 * Math.log((x / z) ** 2 / c.vEff!), 5);
  } },
  kalshi_flow_1m: { group: 'kalshi', tier: 'T1', description: 'YES-taker minus NO-taker contracts, 1 min, / trailing volume rate', fn: kalshiFlow(60) },
  kalshi_flow_5m: { group: 'kalshi', tier: 'T1', description: 'YES-taker minus NO-taker contracts, 5 min, / trailing volume rate', fn: kalshiFlow(300) },
  p_mkt_chg_1m: { group: 'kalshi', tier: 'T1', description: 'change in the Kalshi mid over 1 min', fn: midChange(60) },
  p_mkt_chg_5m: { group: 'kalshi', tier: 'T1', description: 'change in the Kalshi mid over 5 min', fn: midChange(300) },
  ofi_1m: { group: 'kalshi', tier: 'T1', description: 'Kalshi order-flow imbalance, 1 min, / top depth', fn: ofiDepth(60) },
  ofi_5m: { group: 'kalshi', tier: 'T1', description: 'Kalshi order-flow imbalance, 5 min, / top depth', fn: ofiDepth(300) },
  ofi_15m: { group: 'kalshi', tier: 'T1', description: 'Kalshi order-flow imbalance, 15 min, / top depth', fn: ofiDepth(900) },

  // I. Returns and technical analysis (volatility-normalized).
  ret_5m_z: { group: 'returns', tier: 'T1', description: '5-min log return / (sigma_1m sqrt 5)', fn: barRetZ(5) },
  ret_15m_z: { group: 'returns', tier: 'T1', description: '15-min log return, sigma-scaled', fn: barRetZ(15) },
  ret_1h_z: { group: 'returns', tier: 'T1', description: '1-hour log return, sigma-scaled', fn: barRetZ(60) },
  ret_4h_z: { group: 'returns', tier: 'T2', description: '4-hour log return, sigma-scaled', fn: barRetZ(240) },
  ret_since_open_z: { group: 'returns', tier: 'T1', description: 'Up/Down: return since the window opened (vs the opening reference), sigma-scaled', fn: (c) => {
    const S = c.index.latest()?.value, s = c.bars?.sigma1m();
    if (c.kind !== 'updown' || !S || !s || !c.strike || c.openTime === undefined) return NA;
    const min = Math.max(1, (c.now - c.openTime) / 60_000);
    return clip(Math.log(S / c.strike) / (s * Math.sqrt(min)));
  } },
  efficiency_ratio_15m: { group: 'returns', tier: 'T1', description: '|net move| / sum |1-min moves|, 15 min: trend vs chop', fn: efficiency(15) },
  efficiency_ratio_1h: { group: 'returns', tier: 'T1', description: '|net move| / sum |1-min moves|, 1 h', fn: efficiency(60) },
  range_pos_1h: { group: 'returns', tier: 'T2', description: 'position in the 1-hour high/low range', fn: rangePos(60) },
  range_pos_4h: { group: 'returns', tier: 'T2', description: 'position in the 4-hour high/low range', fn: rangePos(240) },
  dist_24h_high_z: { group: 'returns', tier: 'T2', description: 'distance to the 24 h high, sigma-scaled', fn: distExtreme(1440, 'high') },
  dist_24h_low_z: { group: 'returns', tier: 'T2', description: 'distance to the 24 h low, sigma-scaled', fn: distExtreme(1440, 'low') },
  variance_ratio_1m_15m: { group: 'returns', tier: 'T2', description: 'Var(15-min returns) / (15 Var(1-min returns)) over 4 h; > 1 trending', fn: (c) => {
    const r = c.bars?.returns(240);
    if (!r) return NA;
    const v1 = r.reduce((a, x) => a + x * x, 0) / r.length;
    let v15 = 0, n = 0;
    for (let i = 0; i + 15 <= r.length; i += 15) { v15 += r.slice(i, i + 15).reduce((a, x) => a + x, 0) ** 2; n++; }
    return v1 > 0 && n ? clip(v15 / n / (15 * v1), 10) : NA;
  } },

  // K. Clock and calendar (quarter-hour effects align with Kalshi window boundaries).
  min_of_hour_sin: { group: 'clock', tier: 'T1', description: 'sin(minute of hour)', fn: (c) => Math.sin((2 * Math.PI * minuteOfHour(c.now)) / 60) },
  min_of_hour_cos: { group: 'clock', tier: 'T1', description: 'cos(minute of hour)', fn: (c) => Math.cos((2 * Math.PI * minuteOfHour(c.now)) / 60) },
  sec_since_quarter: { group: 'clock', tier: 'T1', description: 'seconds since the last :00/:15/:30/:45', fn: (c) => (c.now % 900_000) / 1000 },
  min_to_us_open: { group: 'clock', tier: 'T2', description: 'minutes to the NYSE open (clipped +/-240; null on weekends)', fn: (c) => usMarketClock(c.now).toOpen },
  min_to_us_close: { group: 'clock', tier: 'T2', description: 'minutes to the NYSE close (clipped +/-240; null on weekends)', fn: (c) => usMarketClock(c.now).toClose },
  near_kalshi_maintenance: { group: 'clock', tier: 'T2', description: 'within 30 min of the Thursday 3-5 AM ET maintenance window', fn: (c) => { const m = kalshiMaintenance(c.now); return m.inside || m.minutesTo <= 30 ? 1 : 0; } },
  min_to_macro_event: { group: 'calendar', tier: 'T1', description: 'minutes to the next CPI/FOMC/NFP/PCE release (clipped 240; null if none within 24 h)', fn: (c) => macroClock(c, 'to') },
  min_since_macro_event: { group: 'calendar', tier: 'T1', description: 'minutes since the last scheduled macro release (clipped 240)', fn: (c) => macroClock(c, 'since') },

  // E. Ladder and cross-contract structure (hourly events).
  ladder_violation_c: { group: 'ladder', tier: 'T2', description: 'largest monotonicity breach touching this strike, cents (arbitrage flag)', fn: (c) => {
    if (c.kind !== 'greater' || !c.siblings || !c.ticker) return NA;
    const l = c.siblings.filter((q) => q.kind === 'greater' && q.strike !== undefined && q.mid !== undefined).sort((a, b) => a.strike! - b.strike!);
    const i = l.findIndex((q) => q.ticker === c.ticker);
    return i >= 0 && l.length >= 2 ? violationAt(l.map((q) => q.mid!), i) * 100 : NA;
  } },
  neighbor_gap: { group: 'ladder', tier: 'T2', description: "this strike's mid minus the interpolation of its neighbours", fn: (c) => (c.kind === 'greater' && c.siblings && c.ticker ? neighborGap(c.siblings, c.ticker) ?? NA : NA) },
  bracket_sum_dev_c: { group: 'ladder', tier: 'T2', description: 'sum of range-bracket mids minus 100c (same settlement)', fn: (c) => {
    if (c.kind !== 'between' || !c.siblings) return NA;
    const b = c.siblings.filter((q) => q.kind === 'between' && q.mid !== undefined);
    return b.length >= 3 ? clip((b.reduce((s2, q) => s2 + q.mid!, 0) - 1) * 100, 50) : NA;
  } },

  // G/H. Kalshi perpetuals: premium to the settlement index (perps lead spot), funding, positioning.
  perp_premium_bps: { group: 'perp', tier: 'T2', description: 'Kalshi perp price vs settlement index, bps', fn: (c) => {
    const p = c.perp?.price(c.now), ix = c.index.latest()?.value;
    return p && ix ? clip(1e4 * Math.log(p / ix), 100) : NA;
  } },
  perp_premium_chg_5m: { group: 'perp', tier: 'T2', description: 'change in the perp premium over 5 min, bps', fn: (c, k) => {
    const ps = c.perp?.mid.series(c.now, 300, 15_000), ix = series(c, k, 300);
    return ps && ix ? clip(1e4 * (Math.log(ps[ps.length - 1] / ix[ix.length - 1]) - Math.log(ps[0] / ix[0])), 100) : NA;
  } },
  perp_ret_diff_1m_z: { group: 'perp', tier: 'T2', description: 'perp 1-min return minus index 1-min return, sigma-scaled (lead-lag)', fn: (c, k) => perpRetDiff(c, k, 60) },
  perp_ret_diff_5m_z: { group: 'perp', tier: 'T2', description: 'perp 5-min return minus index 5-min return, sigma-scaled', fn: (c, k) => perpRetDiff(c, k, 300) },
  funding_rate_bps: { group: 'perp', tier: 'T2', description: 'current funding-rate estimate per 8 h, bps (positive = longs pay)', fn: (c) => { const r = c.perp?.latest?.fundingRate; return r === undefined ? NA : clip(r * 1e4, 200); } },
  min_to_funding: { group: 'perp', tier: 'T2', description: 'minutes to the next funding payment', fn: (c) => { const t = c.perp?.latest?.nextFundingTs; return t === undefined ? NA : clamp((t - c.now) / 60_000, 0, 480); } },
  funding_delta_4h: { group: 'perp', tier: 'T2', description: 'change in the funding-rate estimate over 4 h, bps per 8 h (leverage demand building or unwinding)', fn: (c) => {
    const now = c.perp?.latest?.fundingRate, then = c.perp?.fundingAt(c.now - 4 * 3_600_000);
    return now === undefined || then === undefined ? NA : clip((now - then) * 1e4, 200);
  } },
  perp_oi_accel_1h: { group: 'perp', tier: 'T2', description: 'open-interest acceleration: log OI change over the last hour minus the hour before (positions piling in vs unwinding)', fn: (c) => {
    const s = c.perp?.oi.series(c.now, 7200, 300_000);
    if (!s || !(s[0] > 0) || !(s[3600] > 0)) return NA;
    return clip(Math.log(s[7200] / s[3600]) - Math.log(s[3600] / s[0]), 5);
  } },
  perp_oi_chg_1h: { group: 'perp', tier: 'T2', description: 'log change in perp open interest over 1 h', fn: (c) => { const s = c.perp?.oi.series(c.now, 3600, 120_000); return s && s[0] > 0 ? clip(Math.log(s[s.length - 1] / s[0]), 5) : NA; } },

  // O. Cortex-like SNN (bot/snn): direction calls learned continuously from realised moves, and its
  // fair-value bias for this contract. Logged live; research reads the logs (or a prequential replay).
  snn_up_15m: { group: 'snn', tier: 'T2', description: 'SNN P(index up in 15 min), as log-odds', fn: (c) => snnLogit(c.snn?.up?.[15]) },
  snn_up_1h: { group: 'snn', tier: 'T2', description: 'SNN P(index up in 1 h), as log-odds', fn: (c) => snnLogit(c.snn?.up?.[60]) },
  snn_up_4h: { group: 'snn', tier: 'T2', description: 'SNN P(index up in 4 h), as log-odds', fn: (c) => snnLogit(c.snn?.up?.[240]) },
  snn_up_h: { group: 'snn', tier: 'T2', description: "SNN P(up) over this contract's horizon, as log-odds", fn: (c) => snnLogit(c.snn?.up?.[snnHorizonFor(c)]) },
  snn_move_h_z: { group: 'snn', tier: 'T2', description: "SNN expected signed move over this contract's horizon, sigma-scaled", fn: (c) => snnMoveZ(c, snnHorizonFor(c)) },
  snn_bias: { group: 'snn', tier: 'T2', description: 'SNN fair-value bias: logit(p_snn) - logit(fair value) for this contract', fn: (c) => { const a = snnLogit(c.snn?.pContract), b = snnLogit(c.fairValue); return Number.isFinite(a) && Number.isFinite(b) ? clip(a - b, 6) : NA; } },
  // Confidence of the SNN's calls (its own graded history: the snapshot/settlement analysis).
  snn_skill_h: { group: 'snn', tier: 'T2', description: "SNN direction skill over this contract's horizon: 1 - Brier/0.25 of its graded calls (0 = coin flip)", fn: (c) => snnConfOf(c, snnHorizonFor(c), 'skill', 1) },
  snn_cal_h: { group: 'snn', tier: 'T2', description: 'SNN contract readout calibration confidence on settled snapshots (1 = calibrated)', fn: (c) => snnConfOf(c, snnHorizonFor(c), 'calConf', 1) },
  snn_contract_skill_h: { group: 'snn', tier: 'T2', description: 'SNN contract readout skill on settled snapshots: 1 - Brier/0.25', fn: (c) => snnConfOf(c, snnHorizonFor(c), 'contractSkill', 1) },
  snn_surprise_h: { group: 'snn', tier: 'T2', description: 'SNN surprise vs its normal level (> 1 = the network is confused right now)', fn: (c) => snnConfOf(c, snnHorizonFor(c), 'surpriseRatio', 5) },
  snn_gov_h: { group: 'snn', tier: 'T2', description: 'SNN governor level G (0 calm .. 1 over-active / deteriorating)', fn: (c) => snnConfOf(c, snnHorizonFor(c), 'G', 1) },
  snn_skill_1h: { group: 'snn', tier: 'T2', description: 'SNN 1-hour direction skill (1 - Brier/0.25)', fn: (c) => snnConfOf(c, 60, 'skill', 1) },
  snn_skill_4h: { group: 'snn', tier: 'T2', description: 'SNN 4-hour direction skill (1 - Brier/0.25)', fn: (c) => snnConfOf(c, 240, 'skill', 1) },
  snn_dir_agree: { group: 'snn', tier: 'T2', description: "+1 when the SNN direction over the contract's horizon agrees with the fair value's side, -1 when it disagrees", fn: (c) => { const u = c.snn?.up?.[snnHorizonFor(c)]; return u === undefined || !Number.isFinite(u) ? NA : Math.sign(u - 0.5) * Math.sign(c.fairValue - 0.5); } },

  // N. Interactions (kept only if ablation proves them; trees find most on their own).
  gap_x_spread: { group: 'interaction', tier: 'T1', description: 'logit_gap x spread (cents): a disagreement is tradable only where the spread is tight', fn: (c) => { const b = c.book.bestBid(), a = c.book.bestAsk(); return b && a ? clip(logitGap(c) * (a.price - b.price) * 100, 50) : NA; } },
  d2_x_log_tau: { group: 'interaction', tier: 'T1', description: 'd2 x log(tau): strike distance means different things at 3 vs 50 minutes', fn: (c) => (hasGeometry(c) ? clip(c.d2! * Math.log(Math.max(1, c.tauSec)), 50) : NA) },
  ret15_x_efficiency: { group: 'interaction', tier: 'T2', description: 'ret_15m_z x efficiency_ratio_15m: momentum only counts when trending', fn: (c, k) => { const a = barRetZ(15)(c, k), b = efficiency(15)(c, k); return Number.isFinite(a) && Number.isFinite(b) ? a * b : NA; } },
};

// ---- TA library features (bot/ta) -------------------------------------------------------------
// Computed on CLOSED Coinbase spot candles; a timeframe whose last candle is older than 3 periods
// reads NaN (feed down or history too short), so a model never trades on stale charts.

const TF_PERIOD: Record<Timeframe, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };

const taOf = (c: FeatureContext, k: Cache): TaSnapshot | undefined => {
  if (k.ta === undefined) {
    k.ta = c.candles ? c.candles.snapshot(c.now, { usdtdChg: domZ(c.usdtd, c, 900), btcdChg: domZ(c.btcd, c, 900), ...marketContext()?.macro() }) : null;
  }
  return k.ta ?? undefined;
};
const tfOf = (c: FeatureContext, k: Cache, tf: Timeframe): TfState | undefined => {
  const last = c.candles?.lastTs(tf);
  if (last === undefined || c.now - last > 4 * TF_PERIOD[tf]) return undefined;
  return taOf(c, k)?.tf[tf];
};
const taFeat = (tf: Timeframe, pick: (s: TfState) => number, lim = 10): Fn => (c, k) => {
  const s = tfOf(c, k, tf);
  return s ? clip(pick(s), lim) : NA;
};
const perAtr = (s: TfState, x: number) => (s.atr > 0 ? x / s.atr : NA);

function taFeatures(): typeof FEATURES {
  const out: typeof FEATURES = {};
  const add = (name: string, group: FeatureGroup, description: string, fn: Fn) => { out[name] = { group, tier: 'T2', description, fn }; };
  for (const tf of ['15m', '1h', '4h'] as Timeframe[]) {
    add(`ta_rsi_${tf}`, 'ta', `RSI(14) on ${tf} spot candles, (rsi-50)/50`, taFeat(tf, (s) => (s.rsi - 50) / 50));
    add(`ta_macd_hist_${tf}`, 'ta', `MACD(12,26,9) histogram on ${tf}, in ATRs`, taFeat(tf, (s) => perAtr(s, s.macdHist)));
    add(`ta_adx_${tf}`, 'ta', `ADX(14) on ${tf} / 50 (trend strength)`, taFeat(tf, (s) => s.adx / 50));
    add(`ta_di_diff_${tf}`, 'ta', `(+DI - -DI) / 50 on ${tf} (trend direction)`, taFeat(tf, (s) => (s.plusDI - s.minusDI) / 50));
    add(`ta_bb_pctb_${tf}`, 'ta', `Bollinger %B - 0.5 on ${tf}`, taFeat(tf, (s) => s.bbPctB - 0.5, 3));
    add(`ta_bb_bw_rank_${tf}`, 'ta', `Bollinger bandwidth percentile (120 bars) on ${tf}: low = squeeze`, taFeat(tf, (s) => s.bbBandwidthRank));
    add(`ta_ema_stack_${tf}`, 'ta', `+1 price > EMA21 > EMA50, -1 mirror, 0 mixed, on ${tf}`, taFeat(tf, (s) => (s.close > s.ema21 && s.ema21 > s.ema50 ? 1 : s.close < s.ema21 && s.ema21 < s.ema50 ? -1 : Number.isFinite(s.ema50) ? 0 : NA)));
    add(`ta_structure_${tf}`, 'ta', `market structure on ${tf}: +1 HH/HL, -1 LH/LL, 0 range`, taFeat(tf, (s) => (s.trend === 'up' ? 1 : s.trend === 'down' ? -1 : 0)));
    add(`ta_cmf_${tf}`, 'ta', `Chaikin money flow (20) on ${tf}`, taFeat(tf, (s) => s.cmf, 1));
  }
  for (const tf of ['1h', '4h', '1d'] as Timeframe[]) {
    add(`ta_price_ma50_${tf}`, 'ta', `(close - SMA50) / ATR on ${tf} (price-to-MA, Detzel et al.)`, taFeat(tf, (s) => perAtr(s, s.close - s.sma50)));
    add(`ta_cloud_${tf}`, 'ta', `Ichimoku on ${tf}: +1 above the cloud, -1 below, 0 inside`, taFeat(tf, (s) => (!s.cloud ? NA : s.cloud.above ? 1 : s.cloud.below ? -1 : 0)));
  }
  add('ta_price_sma200_1d', 'ta', '(close - SMA200) / ATR on daily candles (long-term regime)', taFeat('1d', (s) => perAtr(s, s.close - s.sma200), 30));
  for (const tf of ['15m', '1h'] as Timeframe[]) {
    add(`ta_squeeze_${tf}`, 'ta', `Bollinger inside Keltner (squeeze) on ${tf}`, taFeat(tf, (s) => (s.squeeze ? 1 : 0)));
    add(`ta_stoch_${tf}`, 'ta', `stochastic %K(14) on ${tf}, (k-50)/50`, taFeat(tf, (s) => (s.stochK - 50) / 50));
    add(`ta_mfi_${tf}`, 'ta', `money flow index (14) on ${tf}, (mfi-50)/50`, taFeat(tf, (s) => (s.mfi - 50) / 50));
    add(`ta_vwap_dist_${tf}`, 'ta', `(close - session VWAP) / ATR on ${tf}`, taFeat(tf, (s) => perAtr(s, s.close - s.vwap)));
    add(`ta_vp_pos_${tf}`, 'ta', `(close - POC) / value-area width, volume profile of 96 ${tf} bars`, taFeat(tf, (s) => (s.profile && s.profile.vah > s.profile.val ? (s.close - s.profile.poc) / (s.profile.vah - s.profile.val) : NA), 5));
    add(`ta_vol_ratio_${tf}`, 'ta', `log(last ${tf} volume / 20-bar average)`, taFeat(tf, (s) => (s.volRatio > 0 ? Math.log(s.volRatio) : NA), 5));
  }
  for (const tf of ['1h', '4h'] as Timeframe[]) add(`ta_obv_slope_${tf}`, 'ta', `OBV 20-bar change / (20 x avg volume) on ${tf}`, taFeat(tf, (s) => s.obvSlope, 3));
  // Order flow: taker-buy share of volume (Binance klines in history, the Coinbase trade feed live).
  const flowFeat = (tf: Timeframe, bars: number): Fn => (c) => {
    const cs = c.candles?.bars[tf], last = c.candles?.lastTs(tf);
    if (!cs || last === undefined || c.now - last > 4 * TF_PERIOD[tf] || cs.length < bars) return NA;
    return takerImbalance(cs.slice(-bars));
  };
  add('ta_taker_imb_15m', 'ta', 'taker order-flow imbalance of the last 15m bar: 2 x taker-buy / volume - 1', flowFeat('15m', 1));
  add('ta_taker_imb_1h', 'ta', 'taker order-flow imbalance of the last hourly bar', flowFeat('1h', 1));
  add('ta_taker_imb_4h', 'ta', 'taker order-flow imbalance of the last 4 hourly bars', flowFeat('1h', 4));
  add('ta_taker_imb_24h', 'ta', 'taker order-flow imbalance of the last 24 hourly bars (cumulative delta / volume)', flowFeat('1h', 24));
  add('ta_willr_15m', 'ta', 'Williams %R(14) on 15m, (r+50)/50', taFeat('15m', (s) => (s.willR + 50) / 50));
  add('ta_atr_rank_1h', 'ta', 'ATR/price percentile over 100 1h bars (volatility regime)', taFeat('1h', (s) => s.atrRank));
  add('ta_round_dist_15m', 'ta', 'signed distance to the nearest round-number level, in 15m ATRs (Osler)', taFeat('15m', (s) => s.round.distAtr, 20));

  // Confluence scores and signal nets (group taconf).
  const fresh = (c: FeatureContext, k: Cache) => tfOf(c, k, '15m') ?? tfOf(c, k, '1h');
  for (const cf of CONFLUENCES) {
    add(`taconf_${cf.id}`, 'taconf', `${cf.name} confluence score in [-1, 1] (${cf.source})`, (c, k) => {
      if (!fresh(c, k)) return NA;
      return taOf(c, k)?.confluences.find((x) => x.id === cf.id)?.score ?? NA;
    });
  }
  const kindOf = new Map(RULES.map((r) => [r.id, r.kind]));
  for (const kind of ['trend', 'reversal', 'continuation'] as const) {
    add(`taconf_net_${kind}`, 'taconf', `sum of signed ${kind}-rule strengths over all timeframes (bullish - bearish)`, (c, k) => {
      if (!fresh(c, k)) return NA;
      const t = taOf(c, k);
      return t ? clip(t.signals.filter((x) => kindOf.get(x.id) === kind).reduce((a, x) => a + x.dir * x.strength, 0), 30) : NA;
    });
  }
  add('taconf_net', 'taconf', 'sum of all signed rule strengths (bullish - bearish)', (c, k) => (fresh(c, k) ? clip(taOf(c, k)?.net ?? NA, 60) : NA));
  return out;
}
Object.assign(FEATURES, taFeatures());

// ---- TA network outputs (bot/ta/taNet.ts) -----------------------------------------------------
// Computed from the same Coinbase candles (288 closed hourly bars, 288 daily) as in its training;
// NaN when no network is installed, the head did not validate, or the candles are stale.

const tanetOf = (c: FeatureContext, k: Cache): TaNetOutput | undefined => {
  if (k.tanet === undefined) k.tanet = (c.asset && c.candles ? activeTaNet()?.outputFor(c.asset, c.candles, c.now) : undefined) ?? null;
  return k.tanet ?? undefined;
};
const tnLogit = (p: number | undefined) => (p === undefined || !Number.isFinite(p) ? NA : clip(Math.log(clamp(p, 1e-4, 1 - 1e-4) / (1 - clamp(p, 1e-4, 1 - 1e-4))), 6));
Object.assign(FEATURES, {
  tanet_up_1h: { group: 'tanet', tier: 'T2', description: 'TA network P(spot up over the next hour), as log-odds', fn: (c, k) => tnLogit(tanetOf(c, k)?.up[60]) },
  tanet_up_4h: { group: 'tanet', tier: 'T2', description: 'TA network P(spot up over the next 4 hours), as log-odds', fn: (c, k) => tnLogit(tanetOf(c, k)?.up[240]) },
  tanet_vol_4h: { group: 'tanet', tier: 'T2', description: 'TA network forecast of log(next-4h realised vol / last-24h realised vol)', fn: (c, k) => { const v = tanetOf(c, k)?.vol4h; return v === undefined || !Number.isFinite(v) ? NA : clip(v, 3); } },
  tanet_skill_1h: { group: 'tanet', tier: 'T2', description: 'TA network 1-hour skill over its last graded calls (1 - Brier/0.25; NaN until 24 graded)', fn: (c, k) => { const v = tanetOf(c, k)?.skill[60]; return v === undefined || !Number.isFinite(v) ? NA : clip(v, 1); } },
  tanet_skill_4h: { group: 'tanet', tier: 'T2', description: 'TA network 4-hour skill over its last graded calls', fn: (c, k) => { const v = tanetOf(c, k)?.skill[240]; return v === undefined || !Number.isFinite(v) ? NA : clip(v, 1); } },
  tanet_dir_agree: { group: 'tanet', tier: 'T2', description: "+1 when the TA network's 1-hour direction agrees with the fair value's side, -1 when it disagrees", fn: (c, k) => { const u = tanetOf(c, k)?.up[60]; return u === undefined || !Number.isFinite(u) ? NA : Math.sign(u - 0.5) * Math.sign(c.fairValue - 0.5); } },
} satisfies typeof FEATURES);

export const ALL_FEATURES = Object.keys(FEATURES);
export const featuresInGroups = (groups: FeatureGroup[]) => ALL_FEATURES.filter((n) => groups.includes(FEATURES[n].group));

/** Compute every registered feature. Values are finite numbers or NaN. */
/** Asset-level features (no contract): the context the SNN's crypto columns and the perps read. */
export function assetFeatureMap(asset: string, now: number, s: { index?: IndexTracker; spot?: IndexTracker; bars?: BarStore; candles?: CandleSet; usdtd?: IndexTracker; btcd?: IndexTracker; perp?: PerpState; snn?: SnnContext }): Record<string, number> {
  const vol = s.index?.vol();
  return computeFeatureMap({
    now, fairValue: 0.5, mid: 0.5, tauSec: 3600, sigmaPerSqrtSec: vol?.sigmaPerSqrtSec ?? NaN, referenceSigma: vol?.sigmaPerSqrtSec ?? NaN,
    inWindow: false, book: ASSET_BOOK, index: s.index!, spot: s.spot, asset, usdtd: s.usdtd, btcd: s.btcd, bars: s.bars, candles: s.candles, perp: s.perp, snn: s.snn,
  });
}
const ASSET_BOOK = new OrderBook('asset-context');

export function computeFeatureMap(c: FeatureContext): Record<string, number> {
  const cache: Cache = { idx: new Map(), spot: new Map(), memo: new Map() };
  const out: Record<string, number> = {};
  for (const [name, f] of Object.entries(FEATURES)) {
    let v: number;
    try { v = f.fn(c, cache); } catch { v = NA; }
    out[name] = Number.isFinite(v) ? v : NA;
  }
  return out;
}

/** Ordered vector for a model's feature list (unknown/missing -> NaN). */
export function vectorFor(names: string[], map: Record<string, number>): number[] {
  return names.map((n) => (n in map && Number.isFinite(map[n]) ? map[n] : NaN));
}

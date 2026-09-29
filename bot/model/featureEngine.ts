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
// pattern/confluence labels, USDT dominance, exit-liquidity heuristics.

import type { OrderBook } from '../marketdata/orderBook';
import type { IndexTracker } from '../marketdata/indexTracker';
import { clamp, logit } from '../util/num';

export type FeatureGroup = 'base' | 'micro' | 'momentum' | 'spot' | 'time';

// ---- Per-market microstructure state ----------------------------------------

interface Stamped { ts: number; v: number }

export class MicroTracker {
  private prev?: { bid: number; bidSz: number; ask: number; askSz: number };
  private readonly ofi: Stamped[] = [];
  private readonly trades: Array<{ ts: number; signed: number; count: number }> = [];

  /** Call after every book update (snapshot or delta). Order-flow imbalance per Cont, Kukanov & Stoikov. */
  onBook(book: OrderBook, ts: number): void {
    const b = book.bestBid();
    const a = book.bestAsk();
    if (!b || !a) { this.prev = undefined; return; }
    const cur = { bid: b.price, bidSz: b.size, ask: a.price, askSz: a.size };
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
    const cut = now - 600_000;
    while (this.ofi.length && this.ofi[0].ts < cut) this.ofi.shift();
    while (this.trades.length && this.trades[0].ts < cut) this.trades.shift();
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

/** Shared event sink: production and replay both drive features through this. */
export class FeatureHub {
  readonly micro = new Map<string, MicroTracker>();
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
}

type Fn = (c: FeatureContext, cache: Cache) => number;
interface Cache { idx: Map<number, number[] | undefined>; spot: Map<number, number[] | undefined> }

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
const midRange = (sec: number): Fn => (c, k) => {
  const s = series(c, k, sec);
  if (!s) return NA;
  const mid = (Math.max(...s) + Math.min(...s)) / 2;
  const S = s[s.length - 1];
  return clip(Math.log(S / mid) / (c.sigmaPerSqrtSec * Math.sqrt(sec)));
};

export const FEATURES: Record<string, { group: FeatureGroup; description: string; fn: Fn }> = {
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

  // Time (old: hourOfDay, dayOfWeek, tradingSession).
  hour_sin: { group: 'time', description: 'sin(UTC hour)', fn: (c) => Math.sin((2 * Math.PI * (new Date(c.now).getUTCHours() + new Date(c.now).getUTCMinutes() / 60)) / 24) },
  hour_cos: { group: 'time', description: 'cos(UTC hour)', fn: (c) => Math.cos((2 * Math.PI * (new Date(c.now).getUTCHours() + new Date(c.now).getUTCMinutes() / 60)) / 24) },
  weekend: { group: 'time', description: '1 on Saturday/Sunday UTC', fn: (c) => { const d = new Date(c.now).getUTCDay(); return d === 0 || d === 6 ? 1 : 0; } },
};

export const ALL_FEATURES = Object.keys(FEATURES);
export const featuresInGroups = (groups: FeatureGroup[]) => ALL_FEATURES.filter((n) => groups.includes(FEATURES[n].group));

/** Compute every registered feature. Values are finite numbers or NaN. */
export function computeFeatureMap(c: FeatureContext): Record<string, number> {
  const cache: Cache = { idx: new Map(), spot: new Map() };
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

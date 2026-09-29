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

import type { OrderBook } from '../marketdata/orderBook';
import type { IndexTracker } from '../marketdata/indexTracker';
import { clamp, logit } from '../util/num';

export type FeatureGroup = 'base' | 'micro' | 'momentum' | 'spot' | 'macro' | 'confluence' | 'time';

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
  /** Underlying asset symbol (BTC, ETH, ...). */
  asset?: string;
  /** USDT.D and BTC.D trackers (percent). */
  usdtd?: IndexTracker;
  btcd?: IndexTracker;
}

type Fn = (c: FeatureContext, cache: Cache) => number;
interface Cache { idx: Map<number, number[] | undefined>; spot: Map<number, number[] | undefined>; memo: Map<string, number> }

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

  // Time (old: hourOfDay, dayOfWeek, tradingSession).
  hour_sin: { group: 'time', description: 'sin(UTC hour)', fn: (c) => Math.sin((2 * Math.PI * (new Date(c.now).getUTCHours() + new Date(c.now).getUTCMinutes() / 60)) / 24) },
  hour_cos: { group: 'time', description: 'cos(UTC hour)', fn: (c) => Math.cos((2 * Math.PI * (new Date(c.now).getUTCHours() + new Date(c.now).getUTCMinutes() / 60)) / 24) },
  weekend: { group: 'time', description: '1 on Saturday/Sunday UTC', fn: (c) => { const d = new Date(c.now).getUTCDay(); return d === 0 || d === 6 ? 1 : 0; } },
};

export const ALL_FEATURES = Object.keys(FEATURES);
export const featuresInGroups = (groups: FeatureGroup[]) => ALL_FEATURES.filter((n) => groups.includes(FEATURES[n].group));

/** Compute every registered feature. Values are finite numbers or NaN. */
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

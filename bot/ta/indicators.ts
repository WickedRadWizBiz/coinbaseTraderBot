// Technical-analysis indicator math on OHLCV candles (the spot USD pair behind each contract).
// Pure functions, no I/O. Every function returns a series aligned with its input: NaN until the
// look-back is filled, so crossovers and divergences can be read off the same index.
//
// Formulas follow the original authors (Wilder 1978 for RSI/ATR/ADX with Wilder smoothing,
// Appel for MACD, Bollinger, Lane, Williams, Granville, Chaikin, Hosoda) and match the definitions
// in the operator's TA reference ("Quantitative Technical Analysis in Cryptocurrency Markets").

export interface Candle {
  /** Bar open time (ms). */
  ts: number;
  o: number; h: number; l: number; c: number;
  /** Base-asset volume. */
  v: number;
  /** Taker-buy base volume (aggressive buyers), when the source splits it (Binance klines, the live
   *  Coinbase trade feed); undefined otherwise. Order-flow imbalance = 2 tb / v - 1. */
  tb?: number;
}

export type Series = number[];
const NA = NaN;
const fin = Number.isFinite;

export function last(xs: Series, back = 0): number {
  const i = xs.length - 1 - back;
  return i >= 0 ? xs[i] : NA;
}

export const closes = (cs: Candle[]) => cs.map((c) => c.c);

/** Simple moving average. */
export function sma(xs: Series, n: number): Series {
  const out: Series = new Array(xs.length).fill(NA);
  let s = 0, cnt = 0;
  for (let i = 0; i < xs.length; i++) {
    s += xs[i]; cnt++;
    if (i >= n) { s -= xs[i - n]; cnt--; }
    if (cnt === n && fin(s)) out[i] = s / n;
  }
  return out;
}

/** Exponential moving average, alpha = 2 / (n + 1), seeded with the SMA of the first n values. */
export function ema(xs: Series, n: number): Series {
  const out: Series = new Array(xs.length).fill(NA);
  const a = 2 / (n + 1);
  let e = NA, start = -1;
  for (let i = 0; i < xs.length; i++) {
    if (!fin(xs[i])) continue;
    if (start < 0) start = i;
    if (i - start + 1 < n) continue;
    if (!fin(e)) { let s = 0; for (let j = i - n + 1; j <= i; j++) s += xs[j]; e = s / n; }
    else e = (xs[i] - e) * a + e;
    out[i] = e;
  }
  return out;
}

/** Wilder's smoothing (RMA): alpha = 1 / n, seeded with the SMA. */
export function rma(xs: Series, n: number): Series {
  const out: Series = new Array(xs.length).fill(NA);
  let e = NA, start = -1;
  for (let i = 0; i < xs.length; i++) {
    if (!fin(xs[i])) continue;
    if (start < 0) start = i;
    if (i - start + 1 < n) continue;
    if (!fin(e)) { let s = 0; for (let j = i - n + 1; j <= i; j++) s += xs[j]; e = s / n; }
    else e = (e * (n - 1) + xs[i]) / n;
    out[i] = e;
  }
  return out;
}

/** Rolling population standard deviation. */
export function stdev(xs: Series, n: number): Series {
  const m = sma(xs, n);
  return xs.map((_, i) => {
    if (!fin(m[i])) return NA;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (xs[j] - m[i]) ** 2;
    return Math.sqrt(s / n);
  });
}

/** RSI (Wilder, 14): 100 - 100 / (1 + avg gain / avg loss). */
export function rsi(xs: Series, n = 14): Series {
  const g: Series = [NA], l: Series = [NA];
  for (let i = 1; i < xs.length; i++) { const d = xs[i] - xs[i - 1]; g.push(Math.max(0, d)); l.push(Math.max(0, -d)); }
  const ag = rma(g, n), al = rma(l, n);
  return xs.map((_, i) => (!fin(ag[i]) ? NA : al[i] === 0 ? (ag[i] === 0 ? 50 : 100) : 100 - 100 / (1 + ag[i] / al[i])));
}

/** MACD (12, 26, 9): line, signal, histogram. */
export function macd(xs: Series, fast = 12, slow = 26, signal = 9): { line: Series; signal: Series; hist: Series } {
  const f = ema(xs, fast), s = ema(xs, slow);
  const line = xs.map((_, i) => (fin(f[i]) && fin(s[i]) ? f[i] - s[i] : NA));
  const sig = ema(line, signal);
  return { line, signal: sig, hist: line.map((x, i) => (fin(x) && fin(sig[i]) ? x - sig[i] : NA)) };
}

/** Bollinger Bands (20, 2): bands, %B (0 = lower band, 1 = upper) and bandwidth (UB - LB) / MB. */
export function bollinger(xs: Series, n = 20, k = 2) {
  const mid = sma(xs, n), sd = stdev(xs, n);
  const upper = mid.map((m, i) => m + k * sd[i]);
  const lower = mid.map((m, i) => m - k * sd[i]);
  const pctB = xs.map((x, i) => (fin(mid[i]) ? (upper[i] > lower[i] ? (x - lower[i]) / (upper[i] - lower[i]) : 0.5) : NA));
  const bandwidth = mid.map((m, i) => (fin(m) && m > 0 ? (upper[i] - lower[i]) / m : NA));
  return { mid, upper, lower, pctB, bandwidth };
}

/** True range: max(H - L, |H - prevC|, |L - prevC|). */
export function trueRange(cs: Candle[]): Series {
  return cs.map((c, i) => (i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - cs[i - 1].c), Math.abs(c.l - cs[i - 1].c))));
}

/** Average true range (Wilder, 14). */
export function atr(cs: Candle[], n = 14): Series {
  return rma(trueRange(cs), n);
}

/** Keltner channel: EMA(20) +/- mult x ATR(10) (used with Bollinger for the squeeze). */
export function keltner(cs: Candle[], n = 20, mult = 1.5, atrN = 10) {
  const mid = ema(closes(cs), n), a = atr(cs, atrN);
  return { mid, upper: mid.map((m, i) => m + mult * a[i]), lower: mid.map((m, i) => m - mult * a[i]) };
}

/** ADX with +DI / -DI (Wilder, 14). */
export function adx(cs: Candle[], n = 14): { adx: Series; plusDI: Series; minusDI: Series } {
  const pdm: Series = [NA], mdm: Series = [NA];
  for (let i = 1; i < cs.length; i++) {
    const up = cs[i].h - cs[i - 1].h, dn = cs[i - 1].l - cs[i].l;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  const tr = trueRange(cs); tr[0] = NA;
  const str = rma(tr, n), sp = rma(pdm, n), sm = rma(mdm, n);
  const plusDI = cs.map((_, i) => (fin(str[i]) && str[i] > 0 ? (100 * sp[i]) / str[i] : NA));
  const minusDI = cs.map((_, i) => (fin(str[i]) && str[i] > 0 ? (100 * sm[i]) / str[i] : NA));
  const dx = cs.map((_, i) => (fin(plusDI[i]) && plusDI[i] + minusDI[i] > 0 ? (100 * Math.abs(plusDI[i] - minusDI[i])) / (plusDI[i] + minusDI[i]) : NA));
  return { adx: rma(dx, n), plusDI, minusDI };
}

const midpoint = (cs: Candle[], i: number, n: number) => {
  if (i - n + 1 < 0) return NA;
  let hi = -Infinity, lo = Infinity;
  for (let j = i - n + 1; j <= i; j++) { hi = Math.max(hi, cs[j].h); lo = Math.min(lo, cs[j].l); }
  return (hi + lo) / 2;
};

/**
 * Ichimoku (9, 26, 52). spanA/spanB are the values PLOTTED at each bar (i.e. computed 26 bars
 * earlier), so "price vs the cloud" at bar i uses no future data. chikouVs = close vs the close 26
 * bars ago (the lagging span's relation to price).
 */
export function ichimoku(cs: Candle[], t = 9, k = 26, b = 52, shift = 26) {
  const tenkan = cs.map((_, i) => midpoint(cs, i, t));
  const kijun = cs.map((_, i) => midpoint(cs, i, k));
  const rawA = cs.map((_, i) => (fin(tenkan[i]) && fin(kijun[i]) ? (tenkan[i] + kijun[i]) / 2 : NA));
  const rawB = cs.map((_, i) => midpoint(cs, i, b));
  const spanA = cs.map((_, i) => (i - shift >= 0 ? rawA[i - shift] : NA));
  const spanB = cs.map((_, i) => (i - shift >= 0 ? rawB[i - shift] : NA));
  const chikouVs = cs.map((c, i) => (i - shift >= 0 ? c.c - cs[i - shift].c : NA));
  return { tenkan, kijun, spanA, spanB, chikouVs, futureA: rawA, futureB: rawB };
}

/** Fast stochastic %K (14) and %D (3-SMA of %K). */
export function stochastic(cs: Candle[], n = 14, d = 3): { k: Series; d: Series } {
  const k = cs.map((c, i) => {
    if (i - n + 1 < 0) return NA;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hi = Math.max(hi, cs[j].h); lo = Math.min(lo, cs[j].l); }
    return hi > lo ? (100 * (c.c - lo)) / (hi - lo) : 50;
  });
  return { k, d: sma(k, d) };
}

/** Williams %R (14): -100 x (HH - C) / (HH - LL), in [-100, 0]. */
export function williamsR(cs: Candle[], n = 14): Series {
  return stochastic(cs, n, 1).k.map((k) => (fin(k) ? k - 100 : NA));
}

/** On-balance volume. */
export function obv(cs: Candle[]): Series {
  let o = 0;
  return cs.map((c, i) => { if (i > 0) o += c.c > cs[i - 1].c ? c.v : c.c < cs[i - 1].c ? -c.v : 0; return o; });
}

/** Chaikin money flow (20): sum(MF multiplier x V) / sum(V), in [-1, 1]. */
export function cmf(cs: Candle[], n = 20): Series {
  const mfv = cs.map((c) => (c.h > c.l ? (((c.c - c.l) - (c.h - c.c)) / (c.h - c.l)) * c.v : 0));
  const a = sma(mfv, n), b = sma(cs.map((c) => c.v), n);
  return a.map((x, i) => (fin(x) && b[i] > 0 ? x / b[i] : NA));
}

/** Money flow index (14): volume-weighted RSI on the typical price. */
export function mfi(cs: Candle[], n = 14): Series {
  const tp = cs.map((c) => (c.h + c.l + c.c) / 3);
  return cs.map((_, i) => {
    if (i - n < 0) return NA;
    let pos = 0, neg = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const f = tp[j] * cs[j].v;
      if (tp[j] > tp[j - 1]) pos += f; else if (tp[j] < tp[j - 1]) neg += f;
    }
    return neg === 0 ? (pos === 0 ? 50 : 100) : 100 - 100 / (1 + pos / neg);
  });
}

/** VWAP from `fromIdx` (session or anchored): sum(TP x V) / sum(V). */
export function vwap(cs: Candle[], fromIdx = 0): Series {
  let pv = 0, vv = 0;
  return cs.map((c, i) => {
    if (i < fromIdx) return NA;
    pv += ((c.h + c.l + c.c) / 3) * c.v; vv += c.v;
    return vv > 0 ? pv / vv : NA;
  });
}

/** Donchian channel (n-bar high/low, excluding the current bar: a breakout is a close beyond it). */
export function donchian(cs: Candle[], n = 20): { upper: Series; lower: Series } {
  const upper: Series = [], lower: Series = [];
  for (let i = 0; i < cs.length; i++) {
    if (i - n < 0) { upper.push(NA); lower.push(NA); continue; }
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n; j < i; j++) { hi = Math.max(hi, cs[j].h); lo = Math.min(lo, cs[j].l); }
    upper.push(hi); lower.push(lo);
  }
  return { upper, lower };
}

/**
 * Volume profile: volume per price bin (each candle's volume spread evenly over its high-low range),
 * point of control, and the 70% value area grown outward from the POC.
 */
export function volumeProfile(cs: Candle[], bins = 40, valueArea = 0.7) {
  if (!cs.length) return undefined;
  const hi = Math.max(...cs.map((c) => c.h)), lo = Math.min(...cs.map((c) => c.l));
  if (!(hi > lo)) return undefined;
  const w = (hi - lo) / bins;
  const vol = new Array(bins).fill(0);
  for (const c of cs) {
    const a = Math.min(bins - 1, Math.floor((c.l - lo) / w)), b = Math.min(bins - 1, Math.floor((c.h - lo) / w));
    for (let j = a; j <= b; j++) vol[j] += c.v / (b - a + 1);
  }
  const total = vol.reduce((s, x) => s + x, 0);
  if (!(total > 0)) return undefined;
  let poc = 0;
  for (let j = 1; j < bins; j++) if (vol[j] > vol[poc]) poc = j;
  let loI = poc, hiI = poc, acc = vol[poc];
  while (acc < valueArea * total && (loI > 0 || hiI < bins - 1)) {
    const up = hiI < bins - 1 ? vol[hiI + 1] : -1, dn = loI > 0 ? vol[loI - 1] : -1;
    if (up >= dn) acc += vol[++hiI]; else acc += vol[--loI];
  }
  const price = (j: number) => lo + (j + 0.5) * w;
  const mean = total / bins;
  return {
    lo, hi, binWidth: w, volume: vol,
    poc: price(poc), vah: lo + (hiI + 1) * w, val: lo + loI * w,
    /** Volume at a price relative to the average bin (HVN > 1.5, LVN < 0.5). */
    nodeAt: (p: number) => { const j = Math.floor((p - lo) / w); return j >= 0 && j < bins ? vol[j] / mean : NA; },
  };
}

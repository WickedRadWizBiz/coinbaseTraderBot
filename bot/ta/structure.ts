// Price-action structure on OHLCV candles: swing points, market structure (HH/HL/LH/LL, break of
// structure, change of character), liquidity sweeps vs true breakouts, fair value gaps, equal
// highs/lows, divergences between price and an oscillator, candlestick patterns and round-number
// levels. Everything uses only CONFIRMED information at the last bar (a swing needs `right` later
// bars before it counts), so it is safe for live use and for training without look-ahead.

import { atr, last, sma, type Candle, type Series } from './indicators';

export interface Swing { i: number; price: number; kind: 'high' | 'low' }

/** Fractal swing points: a high (low) that is the extreme of `left` bars before and `right` after. */
export function swings(cs: Candle[], left = 3, right = 3): Swing[] {
  const out: Swing[] = [];
  for (let i = left; i < cs.length - right; i++) {
    let isH = true, isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (cs[j].h >= cs[i].h) isH = false;
      if (cs[j].l <= cs[i].l) isL = false;
    }
    if (isH) out.push({ i, price: cs[i].h, kind: 'high' });
    if (isL) out.push({ i, price: cs[i].l, kind: 'low' });
  }
  return out;
}

export type Trend = 'up' | 'down' | 'range';

/**
 * Market structure from the last two swing highs and lows.
 *  - up: higher high + higher low; down: lower high + lower low; else range.
 *  - bos: the last close broke the latest swing point WITH the trend (continuation).
 *  - choch: the last close broke the latest swing point AGAINST the trend (first sign of reversal).
 */
export function marketStructure(cs: Candle[], sw = swings(cs)): { trend: Trend; bos: -1 | 0 | 1; choch: -1 | 0 | 1; lastHigh?: Swing; lastLow?: Swing } {
  const highs = sw.filter((s) => s.kind === 'high'), lows = sw.filter((s) => s.kind === 'low');
  const [h1, h2] = [highs[highs.length - 2], highs[highs.length - 1]];
  const [l1, l2] = [lows[lows.length - 2], lows[lows.length - 1]];
  let trend: Trend = 'range';
  if (h1 && h2 && l1 && l2) {
    if (h2.price > h1.price && l2.price > l1.price) trend = 'up';
    else if (h2.price < h1.price && l2.price < l1.price) trend = 'down';
  }
  const c = cs[cs.length - 1]?.c;
  const brokeUp = h2 !== undefined && c > h2.price;
  const brokeDn = l2 !== undefined && c < l2.price;
  const bos: -1 | 0 | 1 = trend === 'up' && brokeUp ? 1 : trend === 'down' && brokeDn ? -1 : 0;
  const choch: -1 | 0 | 1 = trend === 'down' && brokeUp ? 1 : trend === 'up' && brokeDn ? -1 : 0;
  return { trend, bos, choch, lastHigh: h2, lastLow: l2 };
}

/**
 * Liquidity sweep (stop hunt) within the last `within` bars: a wick through a prior swing low
 * (high) whose candle CLOSES back inside, leaving a long wick (>= wickFrac of the range).
 * +1 bullish sweep of lows, -1 bearish sweep of highs, 0 none.
 */
export function liquiditySweep(cs: Candle[], sw = swings(cs), within = 3, wickFrac = 0.5): -1 | 0 | 1 {
  for (let k = cs.length - 1; k >= Math.max(0, cs.length - within); k--) {
    const c = cs[k], range = c.h - c.l;
    if (!(range > 0)) continue;
    const priorLows = sw.filter((s) => s.kind === 'low' && s.i < k - 1);
    const priorHighs = sw.filter((s) => s.kind === 'high' && s.i < k - 1);
    const lo = priorLows[priorLows.length - 1], hi = priorHighs[priorHighs.length - 1];
    if (lo && c.l < lo.price && c.c > lo.price && (Math.min(c.o, c.c) - c.l) / range >= wickFrac) return 1;
    if (hi && c.h > hi.price && c.c < hi.price && (c.h - Math.max(c.o, c.c)) / range >= wickFrac) return -1;
  }
  return 0;
}

/**
 * True breakout of the latest swing high (low) on the last bar: a solid body (>= 60% of the range)
 * closing beyond it on volume >= volMult x the 20-bar average. +1 up, -1 down, 0 none.
 */
export function trueBreakout(cs: Candle[], sw = swings(cs), volMult = 1.5): -1 | 0 | 1 {
  const c = cs[cs.length - 1];
  if (!c || cs.length < 21) return 0;
  const avgV = last(sma(cs.map((x) => x.v), 20), 1);
  const solid = c.h > c.l && Math.abs(c.c - c.o) / (c.h - c.l) >= 0.6;
  if (!solid || !(c.v >= volMult * avgV)) return 0;
  const hi = sw.filter((s) => s.kind === 'high').pop(), lo = sw.filter((s) => s.kind === 'low').pop();
  if (hi && c.c > hi.price && c.o <= hi.price * 1.001) return 1;
  if (lo && c.c < lo.price && c.o >= lo.price * 0.999) return -1;
  return 0;
}

/** Equal highs / lows (resting liquidity): the last two swing highs (lows) within tol x ATR. */
export function equalLevels(cs: Candle[], sw = swings(cs), tol = 0.15): { highs?: number; lows?: number } {
  const a = last(atr(cs, 14));
  if (!(a > 0)) return {};
  const hs = sw.filter((s) => s.kind === 'high').slice(-2), ls = sw.filter((s) => s.kind === 'low').slice(-2);
  return {
    highs: hs.length === 2 && Math.abs(hs[0].price - hs[1].price) <= tol * a ? Math.max(hs[0].price, hs[1].price) : undefined,
    lows: ls.length === 2 && Math.abs(ls[0].price - ls[1].price) <= tol * a ? Math.min(ls[0].price, ls[1].price) : undefined,
  };
}

export interface Gap { i: number; top: number; bottom: number; dir: 1 | -1 }

/** Unfilled fair value gaps (3-candle imbalances): bullish when bar i-2's high < bar i's low. */
export function fairValueGaps(cs: Candle[], lookback = 50): Gap[] {
  const out: Gap[] = [];
  for (let i = Math.max(2, cs.length - lookback); i < cs.length; i++) {
    if (cs[i - 2].h < cs[i].l) out.push({ i, bottom: cs[i - 2].h, top: cs[i].l, dir: 1 });
    if (cs[i - 2].l > cs[i].h) out.push({ i, bottom: cs[i].h, top: cs[i - 2].l, dir: -1 });
  }
  // Drop gaps later traded through.
  return out.filter((g) => !cs.slice(g.i + 1).some((c) => (g.dir === 1 ? c.l <= g.bottom : c.h >= g.top)));
}

/**
 * Divergence between price swings and an oscillator at the same bars (last two confirmed swings).
 *  regular: bullish = price lower low, oscillator higher low (selling exhausted); bearish mirror.
 *  hidden:  bullish = price higher low, oscillator lower low (trend continuation); bearish mirror.
 * Returns +1 / -1 / 0 for each.
 */
export function divergence(cs: Candle[], osc: Series, sw = swings(cs), maxAge = 10): { regular: -1 | 0 | 1; hidden: -1 | 0 | 1 } {
  const fresh = (s: Swing) => cs.length - 1 - s.i <= maxAge;
  const lows = sw.filter((s) => s.kind === 'low' && Number.isFinite(osc[s.i])).slice(-2);
  const highs = sw.filter((s) => s.kind === 'high' && Number.isFinite(osc[s.i])).slice(-2);
  let regular: -1 | 0 | 1 = 0, hidden: -1 | 0 | 1 = 0;
  if (lows.length === 2 && fresh(lows[1])) {
    const [a, b] = lows;
    if (b.price < a.price && osc[b.i] > osc[a.i]) regular = 1;
    else if (b.price > a.price && osc[b.i] < osc[a.i]) hidden = 1;
  }
  if (highs.length === 2 && fresh(highs[1]) && (regular === 0 || hidden === 0)) {
    const [a, b] = highs;
    const newer = !lows[1] || b.i > lows[1].i;
    if (newer && b.price > a.price && osc[b.i] < osc[a.i]) regular = -1;
    else if (newer && b.price < a.price && osc[b.i] > osc[a.i]) hidden = -1;
  }
  return { regular, hidden };
}

/**
 * Continuous OBV divergence between the last two CONFIRMED swing lows / highs (a swing is known only
 * once 3 bars after it exist, so nothing here looks ahead). Same patterns as divergence(), but scored
 * by size instead of flagged:
 *   strength = tanh(0.25 x |price move| / ATR + |OBV move| / volume traded between the two swings)
 * faded by exp(-age / maxAge), where age = bars since the second swing. Positive = bullish (regular:
 * price lower low + OBV higher low; hidden: price higher low + OBV lower low), negative = bearish.
 */
export function obvDivergenceStrength(cs: Candle[], obvS: Series, atr: number, sw = swings(cs), maxAge = 10): { regular: number; hidden: number } {
  const out = { regular: 0, hidden: 0 };
  if (!(atr > 0)) return out;
  const score = (a: Swing, b: Swing) => {
    let vol = 0;
    for (let i = a.i + 1; i <= b.i; i++) vol += cs[i].v;
    const dObv = vol > 0 ? Math.abs(obvS[b.i] - obvS[a.i]) / vol : 0;
    const age = cs.length - 1 - b.i;
    return Math.tanh(0.25 * (Math.abs(b.price - a.price) / atr) + dObv) * Math.exp(-age / maxAge);
  };
  const lows = sw.filter((s) => s.kind === 'low' && Number.isFinite(obvS[s.i])).slice(-2);
  const highs = sw.filter((s) => s.kind === 'high' && Number.isFinite(obvS[s.i])).slice(-2);
  const lowIsLatest = lows.length === 2 && (highs.length < 2 || lows[1].i >= highs[1].i);
  if (lows.length === 2 && lowIsLatest) {
    const [a, b] = lows;
    if (b.price < a.price && obvS[b.i] > obvS[a.i]) out.regular = score(a, b);
    else if (b.price > a.price && obvS[b.i] < obvS[a.i]) out.hidden = score(a, b);
  } else if (highs.length === 2) {
    const [a, b] = highs;
    if (b.price > a.price && obvS[b.i] < obvS[a.i]) out.regular = -score(a, b);
    else if (b.price < a.price && obvS[b.i] > obvS[a.i]) out.hidden = -score(a, b);
  }
  return out;
}

/** Candlestick patterns on the last bar: +1 bullish, -1 bearish, 0 none (doji: 1 when present). */
export function candlePatterns(cs: Candle[]): { engulfing: -1 | 0 | 1; doji: 0 | 1; pinBar: -1 | 0 | 1 } {
  const c = cs[cs.length - 1], p = cs[cs.length - 2];
  if (!c || !p) return { engulfing: 0, doji: 0, pinBar: 0 };
  const range = c.h - c.l, body = Math.abs(c.c - c.o);
  const engulfing: -1 | 0 | 1 = c.c > c.o && p.c < p.o && c.c >= p.o && c.o <= p.c ? 1 : c.c < c.o && p.c > p.o && c.o >= p.c && c.c <= p.o ? -1 : 0;
  const doji: 0 | 1 = range > 0 && body / range <= 0.1 ? 1 : 0;
  const lower = Math.min(c.o, c.c) - c.l, upper = c.h - Math.max(c.o, c.c);
  const pinBar: -1 | 0 | 1 = range > 0 && body > 0 && lower >= 2 * body && lower / range >= 0.6 ? 1 : range > 0 && body > 0 && upper >= 2 * body && upper / range >= 0.6 ? -1 : 0;
  return { engulfing, doji, pinBar };
}

/**
 * Nearest round-number level and the signed distance to it (Osler 2003: take-profit orders cluster
 * AT round numbers, stop-losses just BEYOND them). Step = 10^(floor(log10 price) - 1): $1,000 for
 * BTC near $65k, $100 for ETH near $3k, $10 for SOL near $150.
 */
export function roundLevel(price: number): { level: number; step: number; dist: number } {
  const step = 10 ** (Math.floor(Math.log10(price)) - 1);
  const level = Math.round(price / step) * step;
  return { level, step, dist: price - level };
}

// ---- Classic chart patterns (Lo, Mamaysky & Wang 2000: they carry incremental information) ----------
// Each fires on the bar that completes it and for the next `within` - 1 bars (so a closing pattern is
// not missed between evaluations), from confirmed swings only. +1 bullish, -1 bearish, 0 none.

export interface ChartPatterns {
  /** Double top (-1): two highs within 0.5 ATR, the close breaks the trough between; double bottom (+1). */
  doubleTB: -1 | 0 | 1;
  /** Head and shoulders (-1): a head 0.5 ATR above two shoulders within 1 ATR, the close breaks the
   *  neckline through the two troughs; inverse (+1). */
  headShoulders: -1 | 0 | 1;
  /** Flag / pennant: an impulse of >= 4 ATR within 10 bars, a 4-15 bar pause inside half its size, and
   *  the close breaking the pause in the impulse's direction (continuation). */
  flag: -1 | 0 | 1;
  /** Triangle (falling highs and rising lows, or one flat side): the close breaks out of it. */
  triangle: -1 | 0 | 1;
  /** Trendline break and retest: the rising line through the last two swing lows broke, and price came
   *  back up to it and was rejected (-1); the falling line through two swing highs broke and held as
   *  support on the retest (+1). */
  trendlineRetest: -1 | 0 | 1;
}

const lineAt = (a: Swing, b: Swing, i: number) => a.price + ((b.price - a.price) * (i - a.i)) / (b.i - a.i);

/** Bar k (k in the last `within` bars) where the close crossed `level(k)` downward (-1) or upward (+1). */
function crossedRecently(cs: Candle[], level: (i: number) => number, dir: 1 | -1, after: number, within: number): boolean {
  const n = cs.length - 1;
  for (let k = n; k > Math.max(after, n - within); k--) {
    const now = cs[k].c - level(k), prev = cs[k - 1].c - level(k - 1);
    if (dir < 0 ? now < 0 && prev >= 0 : now > 0 && prev <= 0) return true;
  }
  return false;
}

export function chartPatterns(cs: Candle[], sw = swings(cs), a = last(atr(cs, 14)), within = 3): ChartPatterns {
  const out: ChartPatterns = { doubleTB: 0, headShoulders: 0, flag: 0, triangle: 0, trendlineRetest: 0 };
  const n = cs.length - 1;
  if (n < 30 || !(a > 0)) return out;
  const highs = sw.filter((s) => s.kind === 'high'), lows = sw.filter((s) => s.kind === 'low');
  const lowBetween = (i: number, j: number) => lows.filter((s) => s.i > i && s.i < j).sort((x, y) => x.price - y.price)[0];
  const highBetween = (i: number, j: number) => highs.filter((s) => s.i > i && s.i < j).sort((x, y) => y.price - x.price)[0];

  // Double top / bottom.
  const [h1, h2] = highs.slice(-2);
  if (h1 && h2 && h2.i - h1.i >= 5 && Math.abs(h1.price - h2.price) <= 0.5 * a) {
    const t = lowBetween(h1.i, h2.i);
    if (t && Math.max(h1.price, h2.price) - t.price >= 1.5 * a && crossedRecently(cs, () => t.price, -1, h2.i, within)) out.doubleTB = -1;
  }
  const [l1, l2] = lows.slice(-2);
  if (!out.doubleTB && l1 && l2 && l2.i - l1.i >= 5 && Math.abs(l1.price - l2.price) <= 0.5 * a) {
    const t = highBetween(l1.i, l2.i);
    if (t && t.price - Math.min(l1.price, l2.price) >= 1.5 * a && crossedRecently(cs, () => t.price, 1, l2.i, within)) out.doubleTB = 1;
  }

  // Head and shoulders (and inverse).
  const [ls, hd, rs] = highs.slice(-3);
  if (ls && hd && rs && hd.price > Math.max(ls.price, rs.price) + 0.5 * a && Math.abs(ls.price - rs.price) <= a) {
    const t1 = lowBetween(ls.i, hd.i), t2 = lowBetween(hd.i, rs.i);
    if (t1 && t2 && crossedRecently(cs, (i) => lineAt(t1, t2, i), -1, rs.i, within)) out.headShoulders = -1;
  }
  const [lsI, hdI, rsI] = lows.slice(-3);
  if (!out.headShoulders && lsI && hdI && rsI && hdI.price < Math.min(lsI.price, rsI.price) - 0.5 * a && Math.abs(lsI.price - rsI.price) <= a) {
    const t1 = highBetween(lsI.i, hdI.i), t2 = highBetween(hdI.i, rsI.i);
    if (t1 && t2 && crossedRecently(cs, (i) => lineAt(t1, t2, i), 1, rsI.i, within)) out.headShoulders = 1;
  }

  // Flag / pennant: impulse, tight pause, break in the impulse's direction on the last bar.
  for (let M = 4; M <= 15 && !out.flag; M++) {
    const s0 = n - M - 10, s1 = n - M;
    if (s0 < 0) break;
    const mv = cs[s1].c - cs[s0].c;
    if (Math.abs(mv) < 4 * a) continue;
    let hi = -Infinity, lo = Infinity;
    for (let k = s1 + 1; k < n; k++) { hi = Math.max(hi, cs[k].h); lo = Math.min(lo, cs[k].l); }
    if (!(hi - lo <= 0.5 * Math.abs(mv))) continue;
    // Pullback no deeper than half the impulse.
    if (mv > 0 ? cs[s1].c - lo > 0.5 * mv : hi - cs[s1].c > 0.5 * -mv) continue;
    if (mv > 0 && cs[n].c > hi && cs[n - 1].c <= hi) out.flag = 1;
    else if (mv < 0 && cs[n].c < lo && cs[n - 1].c >= lo) out.flag = -1;
  }

  // Triangle: last two highs and lows within 60 bars, converging, the close breaking out of the lines.
  if (h1 && h2 && l1 && l2 && n - Math.min(h1.i, l1.i) <= 60 && h2.i > h1.i && l2.i > l1.i) {
    const upSlope = (h2.price - h1.price) / (h2.i - h1.i), dnSlope = (l2.price - l1.price) / (l2.i - l1.i);
    const flat = 0.05 * a; // per bar: a "flat" side
    const converging = upSlope < dnSlope && (upSlope < -flat || dnSlope > flat) && upSlope <= flat && dnSlope >= -flat;
    const after = Math.max(h2.i, l2.i);
    if (converging && lineAt(h1, h2, n) > lineAt(l1, l2, n)) {
      if (crossedRecently(cs, (i) => lineAt(h1, h2, i), 1, after, within)) out.triangle = 1;
      else if (crossedRecently(cs, (i) => lineAt(l1, l2, i), -1, after, within)) out.triangle = -1;
    }
  }

  // Trendline break and retest (rejection at the broken line on the last bar). The break itself makes a
  // new swing, so the broken line is the newest rising (falling) pair of swing lows (highs) among the
  // last five whose line a close went through after its second point.
  const c = cs[n];
  const brokenLine = (pts: Swing[], rising: boolean): ((i: number) => number) | undefined => {
    for (let j = pts.length - 1; j >= 1; j--) {
      const p1 = pts[j - 1], p2 = pts[j];
      if (n - p2.i > 40 || (rising ? !(p2.price > p1.price) : !(p2.price < p1.price))) continue;
      const line = (i: number) => lineAt(p1, p2, i);
      for (let k = p2.i + 1; k < n; k++) if (rising ? cs[k].c < line(k) - 0.2 * a : cs[k].c > line(k) + 0.2 * a) return line;
    }
    return undefined;
  };
  const up = brokenLine(lows.slice(-5), true);
  if (up && c.h >= up(n) - 0.3 * a && c.c < up(n) && c.c < c.o) out.trendlineRetest = -1;
  const dn = !out.trendlineRetest ? brokenLine(highs.slice(-5), false) : undefined;
  if (dn && c.l <= dn(n) + 0.3 * a && c.c > dn(n) && c.c > c.o) out.trendlineRetest = 1;
  return out;
}

/** Cardwell RSI range shift over the last `n` bars: bull range (RSI holds above ~40 and reaches 70+)
 *  = +1, bear range (stays below ~60 and reaches 30-) = -1. */
export function rsiRangeShift(rsiS: Series, n = 60): -1 | 0 | 1 {
  const w = rsiS.slice(-n).filter(Number.isFinite);
  if (w.length < n * 0.8) return 0;
  const lo = Math.min(...w), hi = Math.max(...w);
  if (lo >= 38 && hi >= 68) return 1;
  if (hi <= 62 && lo <= 32) return -1;
  return 0;
}

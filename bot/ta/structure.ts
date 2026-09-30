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

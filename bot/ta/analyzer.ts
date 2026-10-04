// Multi-timeframe TA snapshot for one spot USD pair: every indicator in the library computed on
// each timeframe's CLOSED candles (the core indicators by TA-Lib, bot/ta/talib.ts, when it is
// installed; the built-in implementations otherwise), then the knowledge base's rules and confluences evaluated on
// top. The same snapshot feeds the meta-model's features (ta / taconf groups), the dashboard/API
// ("what the chart says and what it means") and the offline rule study (research/taStudy.ts).

import {
  adx, atr, bollinger, cmf, donchian, ema, ichimoku, keltner, last, macd, mfi, obv, rsi, sma, stochastic, volumeProfile, vwap, williamsR, type Candle,
} from './indicators';
import { candlePatterns, divergence, equalLevels, obvDivergenceStrength, fairValueGaps, liquiditySweep, marketStructure, roundLevel, swings, trueBreakout, type Trend } from './structure';
import { CONFLUENCES, RULES, type Timeframe } from './knowledge';
import { talibCore, talibExtras } from './talib';

export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
export const TF_MS: Record<Timeframe, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };

/** Indicator readings for one timeframe at its last closed candle. NaN = not enough history. */
export interface TfState {
  tf: Timeframe;
  bars: number;
  close: number;
  atr: number;
  /** ATR as a fraction of price, and its percentile rank over the last 100 bars (0..1). */
  atrPct: number;
  atrRank: number;
  ema12: number; ema21: number; ema26: number; ema50: number; sma50: number; sma200: number;
  /** Previous-bar SMA50 - SMA200 (for golden/death cross detection). */
  smaDiffPrev: number;
  adx: number; adxPrev: number; plusDI: number; minusDI: number;
  cloud: { above: boolean; below: boolean; inside: boolean; thicknessAtr: number; futureBull: boolean; tkCross: -1 | 0 | 1; tenkanAboveKijun: boolean; chikou: number } | undefined;
  bbPctB: number; bbBandwidth: number; bbBandwidthRank: number;
  /** Bollinger inside Keltner (TTM-style squeeze) now / on the previous bar. */
  squeeze: boolean; squeezePrev: boolean;
  rsi: number; rsiPrev: number;
  macdLine: number; macdSignal: number; macdHist: number; macdHistPrev: number; macdCross: -1 | 0 | 1;
  stochK: number; stochD: number; stochCross: -1 | 0 | 1; willR: number;
  /** OBV change over 20 bars / (20 x average volume): -1..1 style slope. */
  obvSlope: number;
  cmf: number; mfi: number;
  vwap: number;
  /** Volume of the last closed bar / 20-bar average. */
  volRatio: number;
  donchianBreak: -1 | 0 | 1;
  /** Last bar's change and the 20-bar change, in ATRs. */
  chgAtr: number; chg20Atr: number;
  /** Volume profile of the prior 96 bars. nodeLow/nodeHigh: relative volume (vs the average bin) at
   * the last two bars' low / high: < 0.5 = low-volume node (LVN), > 1.5 = high-volume node (HVN). */
  profile: { poc: number; vah: number; val: number; nodeLow: number; nodeHigh: number; loc: 'above' | 'inside' | 'below'; reentry: -1 | 0 | 1 } | undefined;
  trend: Trend; bos: -1 | 0 | 1; choch: -1 | 0 | 1;
  sweep: -1 | 0 | 1; breakout: -1 | 0 | 1;
  equalHighs?: number; equalLows?: number;
  /** Signed distance to the nearest unfilled FVG in ATRs (+ = gap below price, i.e. support). */
  fvgDistAtr: number; inFvg: -1 | 0 | 1;
  divRsi: { regular: -1 | 0 | 1; hidden: -1 | 0 | 1 };
  divMacd: { regular: -1 | 0 | 1; hidden: -1 | 0 | 1 };
  divObv: { regular: -1 | 0 | 1; hidden: -1 | 0 | 1 };
  /** Continuous OBV divergence strength in [-1, 1] (structure.ts obvDivergenceStrength). */
  obvDiv: { regular: number; hidden: number };
  divMfi: { regular: -1 | 0 | 1; hidden: -1 | 0 | 1 };
  candle: { engulfing: -1 | 0 | 1; doji: 0 | 1; pinBar: -1 | 0 | 1 };
  round: { level: number; distAtr: number; crossed: -1 | 0 | 1 };
  /** TA-Lib-only readings and the candlestick-pattern summary (bot/ta/talib.ts TALIB_KEYS; NaN without TA-Lib). */
  tl: Record<string, number>;
}

export interface TaSignal {
  id: string;
  indicator: string;
  tf: Timeframe;
  /** +1 bullish, -1 bearish, 0 = volatility / regime only (no direction). */
  dir: -1 | 0 | 1;
  /** 0..1. */
  strength: number;
  meaning: string;
}

export interface TaConfluence {
  id: string;
  name: string;
  /** Signed score in [-1, 1]: + bullish, - bearish, 0 = members disagree or absent. */
  score: number;
  agreeing: string[];
  meaning: string;
}

export interface MacroInput {
  asset?: string;
  /** Recent USDT.D and BTC.D changes (sigma-scaled or %; only the sign and size matter). */
  usdtdChg?: number;
  btcdChg?: number;
}

export interface TaSnapshot {
  asset: string;
  ts: number;
  tf: Partial<Record<Timeframe, TfState>>;
  signals: TaSignal[];
  confluences: TaConfluence[];
  /** Sum of directional signal strengths, bullish minus bearish, over all timeframes. */
  net: number;
}

const rank = (xs: number[], x: number) => {
  const v = xs.filter(Number.isFinite);
  return v.length ? v.filter((y) => y <= x).length / v.length : NaN;
};
const cross = (a: number, b: number, ap: number, bp: number): -1 | 0 | 1 => (ap <= bp && a > b ? 1 : ap >= bp && a < b ? -1 : 0);

/** Compute every indicator for one timeframe. Needs >= 30 candles; long look-backs are NaN until filled. */
export function tfState(tf: Timeframe, cs: Candle[]): TfState | undefined {
  if (cs.length < 30) return undefined;
  const cl = cs.map((c) => c.c);
  const n = cs.length - 1;
  // Core indicators: TA-Lib when available (the main engine), the built-in versions otherwise.
  const T = talibCore(cs);
  const A = T?.atr ?? atr(cs, 14);
  const a = A[n];
  const close = cl[n];
  const atrPctS = A.map((x, i) => x / cl[i]);
  const e12 = T?.ema12 ?? ema(cl, 12), e26 = T?.ema26 ?? ema(cl, 26), s50 = T?.sma50 ?? sma(cl, 50), s200 = T?.sma200 ?? sma(cl, 200);
  const e21 = T?.ema21 ?? ema(cl, 21), e50 = T?.ema50 ?? ema(cl, 50);
  const ad = T ? { adx: T.adx, plusDI: T.plusDI, minusDI: T.minusDI } : adx(cs, 14);
  const ich = ichimoku(cs);
  const bb = T ? {
    upper: T.bbUpper, lower: T.bbLower, mid: T.bbMiddle,
    pctB: cl.map((x, i) => (Number.isFinite(T.bbMiddle[i]) ? (T.bbUpper[i] > T.bbLower[i] ? (x - T.bbLower[i]) / (T.bbUpper[i] - T.bbLower[i]) : 0.5) : NaN)),
    bandwidth: T.bbMiddle.map((md, i) => (Number.isFinite(md) && md > 0 ? (T.bbUpper[i] - T.bbLower[i]) / md : NaN)),
  } : bollinger(cl, 20, 2);
  const kc = keltner(cs, 20, 1.5, 10);
  const r = T?.rsi ?? rsi(cl, 14);
  const m = T ? { line: T.macd, signal: T.macdSignal, hist: T.macdHist } : macd(cl);
  const st = T ? { k: T.stochK, d: T.stochD } : stochastic(cs, 14, 3);
  const o = T?.obv ?? obv(cs);
  const mfiS = T?.mfi ?? mfi(cs, 14);
  const willR = T ? T.willR[n] : last(williamsR(cs, 14));
  const vols = cs.map((c) => c.v);
  const avgV = sma(vols, 20);
  const sw = swings(cs, 3, 3);
  const ms = marketStructure(cs, sw);
  const eq = equalLevels(cs, sw);
  const fvgs = fairValueGaps(cs);
  const dc = donchian(cs, 20);
  // Session VWAP: from the first bar of the current UTC day (intraday), else the last 20 bars.
  const dayStart = Math.floor(cs[n].ts / 86_400_000) * 86_400_000;
  let from = cs.findIndex((c) => c.ts >= dayStart);
  if (TF_MS[tf] >= 14_400_000 || from < 0 || n - from < 2) from = Math.max(0, n - 19);
  const vw = vwap(cs, from);
  // Volume profile over the last 96 bars (24 h of 15m, 4 days of 1h), excluding the last bar.
  const vpBars = cs.slice(Math.max(0, n - 96), n);
  const vp = volumeProfile(vpBars, 40);
  let profile: TfState['profile'];
  if (vp) {
    const loc = close > vp.vah ? 'above' : close < vp.val ? 'below' : 'inside';
    // 80% rule: opened outside the value area, then closed back inside on the last two bars.
    const prev2 = cs[n - 2]?.c;
    const wasBelow = prev2 !== undefined && prev2 < vp.val, wasAbove = prev2 !== undefined && prev2 > vp.vah;
    const inside = (x: number) => x >= vp.val && x <= vp.vah;
    const reentry: -1 | 0 | 1 = wasBelow && inside(cl[n - 1]) && inside(close) ? 1 : wasAbove && inside(cl[n - 1]) && inside(close) ? -1 : 0;
    profile = { poc: vp.poc, vah: vp.vah, val: vp.val, nodeLow: vp.nodeAt(Math.min(cs[n].l, cs[n - 1].l)), nodeHigh: vp.nodeAt(Math.max(cs[n].h, cs[n - 1].h)), loc, reentry };
  }
  let fvgDistAtr = NaN, inFvg: -1 | 0 | 1 = 0;
  for (const g of fvgs) {
    if (close >= g.bottom && close <= g.top) inFvg = g.dir;
    const d = g.dir === 1 ? close - g.top : close - g.bottom;
    if (a > 0 && (!Number.isFinite(fvgDistAtr) || Math.abs(d) < Math.abs(fvgDistAtr * a))) fvgDistAtr = d / a;
  }
  const rl = roundLevel(close), rlPrev = roundLevel(cl[n - 1]);
  const crossed: -1 | 0 | 1 = cl[n - 1] < rl.level && close >= rl.level ? 1 : cl[n - 1] > rl.level && close <= rl.level ? -1 : rlPrev.level !== rl.level ? (close > cl[n - 1] ? 1 : -1) : 0;
  const cloudTop = Math.max(ich.spanA[n], ich.spanB[n]), cloudBot = Math.min(ich.spanA[n], ich.spanB[n]);
  const obvSlope = n >= 20 && avgV[n] > 0 ? (o[n] - o[n - 20]) / (20 * avgV[n]) : NaN;
  return {
    tf, bars: cs.length, close, atr: a, atrPct: a / close, atrRank: rank(atrPctS.slice(-100), atrPctS[n]),
    ema12: e12[n], ema21: e21[n], ema26: e26[n], ema50: e50[n], sma50: s50[n], sma200: s200[n],
    smaDiffPrev: s50[n - 1] - s200[n - 1],
    adx: ad.adx[n], adxPrev: ad.adx[n - 3], plusDI: ad.plusDI[n], minusDI: ad.minusDI[n],
    cloud: Number.isFinite(cloudTop) ? {
      above: close > cloudTop, below: close < cloudBot, inside: close >= cloudBot && close <= cloudTop,
      thicknessAtr: a > 0 ? (cloudTop - cloudBot) / a : NaN,
      futureBull: ich.futureA[n] > ich.futureB[n],
      tkCross: cross(ich.tenkan[n], ich.kijun[n], ich.tenkan[n - 1], ich.kijun[n - 1]),
      tenkanAboveKijun: ich.tenkan[n] > ich.kijun[n],
      chikou: ich.chikouVs[n],
    } : undefined,
    bbPctB: bb.pctB[n], bbBandwidth: bb.bandwidth[n], bbBandwidthRank: rank(bb.bandwidth.slice(-120), bb.bandwidth[n]),
    squeeze: bb.upper[n] < kc.upper[n] && bb.lower[n] > kc.lower[n],
    squeezePrev: bb.upper[n - 1] < kc.upper[n - 1] && bb.lower[n - 1] > kc.lower[n - 1],
    rsi: r[n], rsiPrev: r[n - 1],
    macdLine: m.line[n], macdSignal: m.signal[n], macdHist: m.hist[n], macdHistPrev: m.hist[n - 1],
    macdCross: cross(m.line[n], m.signal[n], m.line[n - 1], m.signal[n - 1]),
    stochK: st.k[n], stochD: st.d[n], stochCross: cross(st.k[n], st.d[n], st.k[n - 1], st.d[n - 1]), willR,
    obvSlope, cmf: last(cmf(cs, 20)), mfi: mfiS[n], vwap: vw[n],
    volRatio: avgV[n - 1] > 0 ? cs[n].v / avgV[n - 1] : NaN,
    chgAtr: a > 0 ? (close - cl[n - 1]) / a : NaN, chg20Atr: a > 0 && n >= 20 ? (close - cl[n - 20]) / a : NaN,
    donchianBreak: close > dc.upper[n] ? 1 : close < dc.lower[n] ? -1 : 0,
    profile,
    trend: ms.trend, bos: ms.bos, choch: ms.choch,
    sweep: liquiditySweep(cs, sw), breakout: trueBreakout(cs, sw),
    equalHighs: eq.highs, equalLows: eq.lows,
    fvgDistAtr, inFvg,
    divRsi: divergence(cs, r, sw), divMacd: divergence(cs, m.hist, sw), divObv: divergence(cs, o, sw), obvDiv: obvDivergenceStrength(cs, o, a, sw), divMfi: divergence(cs, mfiS, sw),
    candle: candlePatterns(cs),
    round: { level: rl.level, distAtr: a > 0 ? rl.dist / a : NaN, crossed },
    tl: talibExtras(cs, a),
  };
}

/** Indicator states per timeframe (the expensive part; cache it per candle update). */
export function computeStates(candles: Partial<Record<Timeframe, Candle[]>>): Partial<Record<Timeframe, TfState>> {
  const tf: Partial<Record<Timeframe, TfState>> = {};
  for (const t of TIMEFRAMES) {
    const cs = candles[t];
    if (cs?.length) { const s = tfState(t, cs); if (s) tf[t] = s; }
  }
  return tf;
}

/** Evaluate the whole library for one asset from its candles per timeframe (closed candles only). */
export function analyze(asset: string, candles: Partial<Record<Timeframe, Candle[]>>, now: number, macro?: MacroInput): TaSnapshot {
  return evaluate(asset, computeStates(candles), now, macro);
}

/** Rules and confluences on precomputed states. */
export function evaluate(asset: string, tf: Partial<Record<Timeframe, TfState>>, now: number, macro?: MacroInput): TaSnapshot {
  const signals: TaSignal[] = [];
  for (const rule of RULES) {
    for (const t of rule.timeframes) {
      const s = tf[t];
      if (!s) continue;
      let r: { dir: -1 | 0 | 1; strength: number } | undefined;
      try { r = rule.evaluate(s, tf, macro); } catch { r = undefined; }
      if (r && Number.isFinite(r.strength) && r.strength > 0) signals.push({ id: rule.id, indicator: rule.indicator, tf: t, dir: r.dir, strength: Math.min(1, r.strength), meaning: r.dir > 0 ? rule.bullish : r.dir < 0 ? rule.bearish : rule.neutral ?? rule.bullish });
    }
  }
  const confluences: TaConfluence[] = CONFLUENCES.map((c) => {
    const found = c.members.map((mb) => signals.find((s) => s.id === mb.rule && s.tf === mb.tf && (mb.dirless || s.dir !== 0)));
    const present = found.filter((x): x is TaSignal => x !== undefined);
    const dirs = present.filter((x) => x.dir !== 0);
    const up = dirs.filter((x) => x.dir > 0).length, dn = dirs.filter((x) => x.dir < 0).length;
    const dir = up > dn ? 1 : dn > up ? -1 : 0;
    const agreeing = present.filter((x) => x.dir === 0 || x.dir === dir);
    const ok = dir !== 0 && (up === 0 || dn === 0) && agreeing.length >= c.minAgree && c.required.every((req) => agreeing.some((x) => x.id === req));
    const score = ok ? dir * (agreeing.reduce((s, x) => s + x.strength, 0) / c.members.length) : 0;
    return { id: c.id, name: c.name, score: Math.max(-1, Math.min(1, score)), agreeing: ok ? agreeing.map((x) => `${x.id}@${x.tf}`) : [], meaning: ok ? (dir > 0 ? c.bullish : c.bearish) : '' };
  });
  const net = signals.reduce((s, x) => s + x.dir * x.strength, 0);
  return { asset, ts: now, tf, signals, confluences, net };
}

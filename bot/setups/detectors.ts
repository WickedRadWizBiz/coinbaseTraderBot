// Trade setups: the chart patterns a discretionary trader acts on, as code. Each detector looks at the
// last CLOSED bar of a series and either returns a setup (side, structure stop, targets, exit plan)
// or nothing. The same functions run in the research backtest (every bar of years of history) and
// live (the last bar of the candle store), so what the model learned on is what the bot trades.
//
// Fast lane (15m / 1h bars, held hours):
//   fade      exhaustion reversal: RSI overbought, the upper Bollinger band tagged, momentum fading
//             (RSI off its high, MACD histogram falling) and sellers taking over (red bar, taker-buy
//             share below 50% and falling) -> short; mirror image -> long. Targets: middle band
//             (half off, stop to break-even), then the opposite band; ATR trail.
//   pullback  trend continuation: higher-timeframe trend up (SMA 20 > SMA 50, close above SMA 50),
//             price dips (RSI < 40 or the lower band tagged), then a green bar with buyers -> long;
//             mirror -> short. Targets 1R (half off) then 3R; ATR trail.
//   burst     momentum: join a move that is happening now in a volatile moment: a wide-range bar
//             (body >= 60% of it) on a volume spike, closing beyond the recent range, with taker flow
//             on its side and the higher timeframe agreeing; thresholds and exits per side (BURST).
//             Stop under the bar (at least 1 ATR); no target, an ATR trail from entry, a time stop.
// Slow lane (daily bars, held days to weeks):
//   breakout  Donchian: close beyond the prior 20-day high (low) with the 50/200-day trend agreeing.
//   dip       daily pullback in an established trend (close above SMA 200, SMA 50 above SMA 200, RSI
//             back above 45 after dipping under it).
//   Exits: no fixed target; a 3-ATR chandelier trail from the best close, 60-day time limit.
//
// The higher-timeframe trend uses simple averages (exact over a finite window), so the live candle
// store's 320 bars give the same values as the full history.

import { atr, bollinger, macd, rsi, sma, type Candle } from '../ta/indicators';
import { aggregate } from '../ta/candleStore';
import type { Timeframe } from '../ta/knowledge';

export type Lane = 'fast' | 'slow';
export type SetupKind = 'fade' | 'pullback' | 'burst' | 'breakout' | 'dip';

export interface ExitPlan {
  /** First target: half the position off, stop to break-even. */
  target1?: number;
  /** Final target for the rest (undefined = trail only). */
  target2?: number;
  /** Trailing stop distance in ATRs (from the best close since entry), active from the start for the
   *  slow lane and after the first target for the fast lane. */
  trailAtr: number;
  /** Time stop in bars of the setup's timeframe. */
  maxBars: number;
  /** Trail from entry (momentum trades ride the move from the start). */
  trailFromStart?: boolean;
  /** Move the stop to break-even once price has gone this many R in our favour (unset = off). */
  breakevenR?: number;
  /** Profit lock: once price has gone this many R in our favour, trail by tightTrailAtr instead. */
  tightenAfterR?: number;
  tightTrailAtr?: number;
}

export interface SetupSignal {
  asset: string;
  lane: Lane;
  kind: SetupKind;
  tf: Timeframe;
  dir: 1 | -1;
  /** Open time of the signal bar; the setup is known at its close (ts + tf). */
  ts: number;
  /** Close of the signal bar (reference entry price). */
  ref: number;
  stop: number;
  atr: number;
  plan: ExitPlan;
  /** Readings that triggered it (also model inputs). */
  info: { rsi: number; pctB: number; flow: number; bandwidth: number; volRatio: number };
}

/** Momentum-burst thresholds and exits per side, from the per-side search (research/burstParamSearch.ts,
 *  ranked on 2020 to Jun 2025, checked on Jul 2025 onward). Longs: the top tuning setting; all ten best
 *  long settings were also profitable on the test window (median +0.35R per trade). Shorts: the search's
 *  best tuning settings all lost on the test window, so shorts keep the original thresholds plus the
 *  daily-trend rule (which improved them in both windows). */
export const BURST = {
  long: { range: 1.5, vol: 1.5, flow: 0.55, lookback: 10, daily: false, trail: 3.5, bars: 32 },
  short: { range: 1.5, vol: 2, flow: 0.6, lookback: 20, daily: true, trail: 2.5, bars: 16 },
};

export const TF_MS: Partial<Record<Timeframe, number>> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
export const FAST_TFS: Timeframe[] = ['15m', '1h'];
export const SLOW_TFS: Timeframe[] = ['1d'];
/** Bars the detectors need (the live candle store keeps 320). */
export const SETUP_MIN_BARS = 220;

/** Indicator series for one candle series (computed once, read at any index). */
export interface SetupSeries {
  cs: Candle[];
  rsi: number[]; mid: number[]; upper: number[]; lower: number[]; pctB: number[]; bandwidth: number[];
  hist: number[]; atr: number[]; share: number[]; volAvg: number[];
  sma50: number[]; sma200: number[];
  /** Higher timeframe (4 bars; daily: none): closes at each bar's index, SMA 20 / 50 of HTF closes. */
  htf?: { closeAt: number[]; s20: number[]; s50: number[] };
}

export function setupSeries(cs: Candle[], tf: Timeframe): SetupSeries {
  const c = cs.map((x) => x.c);
  const bb = bollinger(c, 20, 2);
  const share = cs.map((x) => (x.tb !== undefined && x.v > 0 ? x.tb / x.v : NaN));
  const s: SetupSeries = {
    cs, rsi: rsi(c, 14), mid: bb.mid, upper: bb.upper, lower: bb.lower, pctB: bb.pctB, bandwidth: bb.bandwidth,
    hist: macd(c).hist, atr: atr(cs, 14), share, volAvg: sma(cs.map((x) => x.v), 20), sma50: sma(c, 50), sma200: sma(c, 200),
  };
  if (tf !== '1d') {
    // Higher timeframe = 4 of these bars (15m -> 1h, 1h -> 4h), aligned to its own clock; at bar i the
    // last HTF bar that has CLOSED is used.
    const ms = TF_MS[tf]! * 4;
    const h = aggregate(cs, ms);
    const hc = h.map((x) => x.c), s20 = sma(hc, 20), s50 = sma(hc, 50);
    const closeAt: number[] = [], a20: number[] = [], a50: number[] = [];
    let j = -1;
    for (let i = 0; i < cs.length; i++) {
      const t = cs[i].ts + TF_MS[tf]!; // close time of bar i
      while (j + 1 < h.length && h[j + 1].ts + ms <= t) j++;
      closeAt.push(j >= 0 ? hc[j] : NaN); a20.push(j >= 0 ? s20[j] : NaN); a50.push(j >= 0 ? s50[j] : NaN);
    }
    s.htf = { closeAt, s20: a20, s50: a50 };
  }
  return s;
}

const fin = Number.isFinite;

/** Setup at bar i of a series (undefined = none). Reads bars <= i only. */
/** Daily trend at a moment: the last daily bar closed by `t` above (+1) or below (-1) its SMA 50 (0 = unknown). */
export function dailyTrendAt(daily: SetupSeries | undefined, t: number): -1 | 0 | 1 {
  if (!daily) return 0;
  let lo = 0, hi = daily.cs.length - 1, j = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (daily.cs[m].ts + 86_400_000 <= t) { j = m; lo = m + 1; } else hi = m - 1; }
  if (j < 0 || !fin(daily.sma50[j])) return 0;
  return daily.cs[j].c > daily.sma50[j] ? 1 : -1;
}

/** Setup at bar i. `daily` (the asset's daily series) lets burst shorts require the daily trend down
 *  (close below its 50-day average): in the trade-anatomy study that rule improved shorts in both the
 *  tuning years and the unseen test months, while it hurt longs, so longs do not use it. */
export function detectAt(asset: string, tf: Timeframe, s: SetupSeries, i: number, daily?: SetupSeries): SetupSignal | undefined {
  if (i < 60 || i >= s.cs.length) return undefined;
  const cs = s.cs, b = cs[i], a = s.atr[i];
  if (!(a > 0) || !fin(s.upper[i]) || !fin(s.rsi[i])) return undefined;
  const info = { rsi: s.rsi[i], pctB: s.pctB[i], flow: s.share[i], bandwidth: s.bandwidth[i], volRatio: s.volAvg[i - 1] > 0 ? b.v / s.volAvg[i - 1] : NaN };
  const hi3 = Math.max(b.h, cs[i - 1].h, cs[i - 2].h), lo3 = Math.min(b.l, cs[i - 1].l, cs[i - 2].l);
  const mk = (kind: SetupKind, lane: Lane, dir: 1 | -1, stop: number, plan: ExitPlan): SetupSignal => ({ asset, lane, kind, tf, dir, ts: b.ts, ref: b.c, stop, atr: a, plan, info });

  if (tf === '1d') {
    if (!fin(s.sma200[i]) || !fin(s.sma50[i])) return undefined;
    let hi20 = -Infinity, lo20 = Infinity;
    for (let k = i - 20; k < i; k++) { hi20 = Math.max(hi20, cs[k].c); lo20 = Math.min(lo20, cs[k].c); }
    const up = s.sma50[i] > s.sma200[i], dn = s.sma50[i] < s.sma200[i];
    const slow: ExitPlan = { trailAtr: 3, maxBars: 60 };
    if (up && b.c > hi20 && cs[i - 1].c <= hi20) return mk('breakout', 'slow', 1, b.c - 3 * a, slow);
    if (dn && b.c < lo20 && cs[i - 1].c >= lo20) return mk('breakout', 'slow', -1, b.c + 3 * a, slow);
    const rMin = Math.min(s.rsi[i - 1], s.rsi[i - 2], s.rsi[i - 3]), rMax = Math.max(s.rsi[i - 1], s.rsi[i - 2], s.rsi[i - 3]);
    if (up && b.c > s.sma200[i] && rMin < 45 && s.rsi[i] >= 45 && b.c > b.o) return mk('dip', 'slow', 1, Math.min(lo3, b.c - 2 * a), slow);
    if (dn && b.c < s.sma200[i] && rMax > 55 && s.rsi[i] <= 55 && b.c < b.o) return mk('dip', 'slow', -1, Math.max(hi3, b.c + 2 * a), slow);
    return undefined;
  }

  const sh = s.share[i];
  // Burst (momentum in a volatile moment): checked first; it is the move happening now. Each side has
  // its own thresholds and exits (BURST).
  const aPrev = s.atr[i - 1], range = b.h - b.l;
  if (aPrev > 0 && s.volAvg[i - 1] > 0 && Math.abs(b.c - b.o) >= 0.6 * range && s.htf && fin(s.htf.s50[i])) {
    const side: 1 | -1 = b.c > b.o ? 1 : -1;
    const P = side > 0 ? BURST.long : BURST.short;
    const flow = side > 0 ? sh : 1 - sh;
    if (range >= P.range * aPrev && b.v >= P.vol * s.volAvg[i - 1] && flow >= P.flow && (side > 0 ? s.htf.s20[i] > s.htf.s50[i] : s.htf.s20[i] < s.htf.s50[i])) {
      let hi = -Infinity, lo = Infinity;
      for (let k = i - P.lookback; k < i; k++) { hi = Math.max(hi, cs[k].h); lo = Math.min(lo, cs[k].l); }
      const trendOk = !P.daily || (side > 0 ? dailyTrendAt(daily, b.ts + TF_MS[tf]!) >= 0 : dailyTrendAt(daily, b.ts + TF_MS[tf]!) <= 0);
      const plan: ExitPlan = { trailAtr: P.trail, maxBars: P.bars, trailFromStart: true };
      if (side > 0 && b.c > hi && trendOk) return mk('burst', 'fast', 1, Math.min(b.l, b.c - aPrev) - 0.1 * aPrev, plan);
      if (side < 0 && b.c < lo && trendOk) return mk('burst', 'fast', -1, Math.max(b.h, b.c + aPrev) + 0.1 * aPrev, plan);
    }
  }
  const avgShare = (s.share[i - 1] + s.share[i - 2] + s.share[i - 3] + s.share[i - 4]) / 4;
  // Fade (exhaustion reversal).
  const rMax = Math.max(s.rsi[i - 1], s.rsi[i - 2], s.rsi[i - 3]), rMin = Math.min(s.rsi[i - 1], s.rsi[i - 2], s.rsi[i - 3]);
  const fadePlan = (dir: 1 | -1): ExitPlan => ({ target1: s.mid[i], target2: dir > 0 ? s.upper[i] : s.lower[i], trailAtr: 1.5, maxBars: 24 });
  if (rMax >= 70 && s.rsi[i] < rMax && (b.h >= s.upper[i] || cs[i - 1].h >= s.upper[i - 1]) && s.hist[i] < s.hist[i - 1] && b.c < b.o && sh < 0.5 && sh < avgShare && s.mid[i] < b.c) {
    return mk('fade', 'fast', -1, hi3 + 0.25 * a, fadePlan(-1));
  }
  if (rMin <= 30 && s.rsi[i] > rMin && (b.l <= s.lower[i] || cs[i - 1].l <= s.lower[i - 1]) && s.hist[i] > s.hist[i - 1] && b.c > b.o && sh > 0.5 && sh > avgShare && s.mid[i] > b.c) {
    return mk('fade', 'fast', 1, lo3 - 0.25 * a, fadePlan(1));
  }
  // Pullback (trend continuation).
  const H = s.htf;
  if (!H || !fin(H.s50[i])) return undefined;
  const up = H.s20[i] > H.s50[i] && H.closeAt[i] > H.s50[i], dn = H.s20[i] < H.s50[i] && H.closeAt[i] < H.s50[i];
  const dipped = Math.min(s.rsi[i - 1], s.rsi[i - 2]) < 40 || cs[i - 1].l <= s.lower[i - 1];
  const popped = Math.max(s.rsi[i - 1], s.rsi[i - 2]) > 60 || cs[i - 1].h >= s.upper[i - 1];
  const rPlan = (dir: 1 | -1, stop: number): ExitPlan => { const r = Math.abs(b.c - stop); return { target1: b.c + dir * r, target2: b.c + dir * 3 * r, trailAtr: 1.5, maxBars: 24 }; };
  if (up && dipped && b.c > b.o && sh > 0.5) { const stop = lo3 - 0.25 * a; return mk('pullback', 'fast', 1, stop, rPlan(1, stop)); }
  if (dn && popped && b.c < b.o && sh < 0.5) { const stop = hi3 + 0.25 * a; return mk('pullback', 'fast', -1, stop, rPlan(-1, stop)); }
  return undefined;
}

/** Setup on the last closed bar of `cs` (live). */
export function detectLast(asset: string, tf: Timeframe, cs: Candle[], daily?: Candle[]): SetupSignal | undefined {
  if (cs.length < SETUP_MIN_BARS) return undefined;
  return detectAt(asset, tf, setupSeries(cs, tf), cs.length - 1, daily && daily.length >= 60 ? setupSeries(daily, '1d') : undefined);
}

/** Volatility-adapted trail for fast-lane setups: the trail distance in ATRs is multiplied by
 *  exp(trailK x the TA network's 4h volatility forecast), clamped to 0.67-1.5x. The forecast is the log
 *  ratio of the next 4 hours' volatility to the last 24 hours' (its one validated head), so a trail
 *  widens before an expected volatility expansion and tightens before a quiet spell. trailK = 0 turns it
 *  off; the sweep optimizer tunes it (research/sweep.ts, target setups-vol). */
export const VOL_ADAPT = { trailK: 0 };

/** The signal with its trail scaled by the volatility forecast (unchanged when off or without one). */
export function adaptToVol(sig: SetupSignal, vol: number | undefined, k = VOL_ADAPT.trailK): SetupSignal {
  if (!k || sig.lane !== 'fast' || vol === undefined || !Number.isFinite(vol)) return sig;
  const m = Math.max(0.67, Math.min(1.5, Math.exp(k * vol)));
  return { ...sig, plan: { ...sig.plan, trailAtr: sig.plan.trailAtr * m, ...(sig.plan.tightTrailAtr !== undefined ? { tightTrailAtr: sig.plan.tightTrailAtr * m } : {}) } };
}

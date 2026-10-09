// The context a TA signal fired in: the parameters the confluence logbook notes at every step of the rule-book
// walk (research/conditionBook.ts) to learn what makes or breaks each rule, and that the live rule book reads to
// apply those conditions (bot/strategy/ruleBook.ts). One function for both, from the same TA snapshot (TA-Lib
// indicators of closed bars), so the research and the live bot see the same numbers.
//
// Directional parameters are read relative to the signal: 'with' > 0 means the context agrees with the
// signal's direction (a higher-timeframe trend up behind a bullish signal), < 0 that it fights it.

import type { TaSnapshot } from '../ta/analyzer';

export interface ContextParam { name: string; label: string; directional: boolean }

export const CONTEXT_PARAMS: ContextParam[] = [
  { name: 'rsi_1h', label: 'RSI (1h), towards the signal', directional: true },
  { name: 'adx_1h', label: 'trend strength ADX (1h)', directional: false },
  { name: 'vol_rank_1h', label: 'volatility percentile (1h ATR rank)', directional: false },
  { name: 'volume_1h', label: 'volume vs its 20-bar average (1h)', directional: false },
  { name: 'bb_width_rank_1h', label: 'Bollinger width percentile (1h)', directional: false },
  { name: 'move20_1h', label: 'last 20 hours\' move in ATRs, with the signal', directional: true },
  { name: 'cmf_1h', label: 'money flow CMF (1h), with the signal', directional: true },
  { name: 'trend_4h', label: '4h trend (EMA 12 vs 26) with the signal', directional: true },
  { name: 'trend_1d', label: 'daily trend (EMA 12 vs 26) with the signal', directional: true },
  { name: 'vs_sma200_1d', label: 'price vs the 200-day average, with the signal', directional: true },
  { name: 'rsi_4h', label: 'RSI (4h), towards the signal', directional: true },
  { name: 'hour_utc', label: 'hour of day (UTC)', directional: false },
  { name: 'weekend', label: 'weekend (1) or weekday (0)', directional: false },
];

/** The context at a step (raw: directional parameters as if the signal were bullish; see oriented()). */
export function contextOf(snap: TaSnapshot | undefined, t: number): Float32Array {
  const out = new Float32Array(CONTEXT_PARAMS.length).fill(NaN);
  const h = snap?.tf['1h'], h4 = snap?.tf['4h'], d = snap?.tf['1d'];
  const ema = (s: typeof h) => (s && s.ema26 > 0 ? (s.ema12 - s.ema26) / s.ema26 : NaN);
  const set = (name: string, v: number | undefined) => { const i = CONTEXT_PARAMS.findIndex((p) => p.name === name); if (i >= 0 && v !== undefined && Number.isFinite(v)) out[i] = v; };
  set('rsi_1h', h ? h.rsi - 50 : undefined);
  set('adx_1h', h?.adx);
  set('vol_rank_1h', h?.atrRank);
  set('volume_1h', h?.volRatio);
  set('bb_width_rank_1h', h?.bbBandwidthRank);
  set('move20_1h', h?.chg20Atr);
  set('cmf_1h', h?.cmf);
  set('trend_4h', ema(h4));
  set('trend_1d', ema(d));
  set('vs_sma200_1d', d && d.sma200 > 0 ? d.close / d.sma200 - 1 : undefined);
  set('rsi_4h', h4 ? h4.rsi - 50 : undefined);
  const date = new Date(t);
  set('hour_utc', date.getUTCHours());
  set('weekend', date.getUTCDay() === 0 || date.getUTCDay() === 6 ? 1 : 0);
  return out;
}

/** A context parameter as seen by a signal of direction dir (directional ones flipped for bearish signals). */
export function oriented(ctx: ArrayLike<number>, i: number, dir: number): number {
  const v = ctx[i];
  return CONTEXT_PARAMS[i].directional && dir < 0 ? -v : v;
}

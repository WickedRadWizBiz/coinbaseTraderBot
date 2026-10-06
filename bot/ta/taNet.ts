// TA network ("tanet"): reads the whole TA library - every indicator and structure reading on 15m,
// 1h, 4h and 1d spot USD candles, every rule's signal and every confluence score - plus raw 15m and
// hourly bars and the market around the coin (BTC, market breadth, Binance's BTC dominance index,
// the BTC.D x USDT.D quadrant, TA on the daily dominance charts), through a five-branch network
// (bot/ta/branchNet.ts: fractal blocks over 15m and hourly bars, hourly GRU, daily attention, market
// context) and forecasts, at each closed hourly bar:
//
//   up_1h   P(close one hour later > close now)
//   up_4h   P(close four hours later > close now)
//   vol_4h  log(realised vol over the next 4 hours / realised vol of the last 24 hours)
//
// Initialised by a population tournament (research/trainTaNet.ts + research/pbt.ts): three
// identical networks with slightly different hyperparameters train walk-forward over years of
// hourly history and fight for fitness month by month; the surviving elite is this file. The market
// context (bot/ta/taNetContext.ts) is computed by the same code from the history store in training
// and from the live feeds here, never from anything after the bar being forecast.
//
// Live, the same inputs are computed from the bot's Coinbase candles with the same windows as
// training, every forecast is graded against the candles that follow (tanet_skill_*), and the
// network's position rule is forward-tested live (the protocol's out-of-sample finality).
// The outputs are features of the decision models (MLP, perps, vol forecast) that keep them only
// when their own validation improves.

import { TALIB_KEYS, taEngine } from './talib';
import fs from 'fs';
import { branchForward, branchLayout, type BranchDims, type BranchGates, type BranchInput } from './branchNet';
import { evaluate, TF_MS, tfState, type TaSnapshot, type TfState } from './analyzer';
import { aggregate, takerImbalance, type CandleSet } from './candleStore';
import { CONTEXT_FEATURES, DAILY_CONTEXT_FEATURES, SLOW_INDEXES, TaNetContext } from './taNetContext';
import type { Candle } from './indicators';
import { CONFLUENCES, RULES, type Timeframe } from './knowledge';

/** Bump when a feature formula or window changes (old models are then refused). */
export const TANET_SCHEMA = '6';
/** Hourly bars per window, and the GRU's hourly steps. Coinbase returns 300 candles per request
 *  including the forming one, so the live store holds >= 299 closed bars from the first poll:
 *  280 + 11 earlier steps = 291 always fit. */
export const TANET_H1_BARS = 280;
export const TANET_TREND_STEPS = 12;
/** Daily bars per window, and the attention branch's days: 250 + 29 = 279 <= 299 live. */
export const TANET_D1_BARS = 250;
export const TANET_MACRO_DAYS = 30;
/** 15-minute bars the convolution reads (33 closed bars needed for 32 returns). */
export const TANET_MICRO_STEPS = 32;
export const TANET_MICRO_F = 5;
/** Raw hourly bars the swing branch's fractal block reads (49 closed bars for 48 returns). */
export const TANET_SWING_BARS = 48;
export const TANET_SWING_F = 5;
/** Maximum missing hours inside the window before a step is skipped (exchange outages). */
export const TANET_MAX_MISSING = 12;
export const TANET_HORIZONS = [60, 240] as const;
export type TaNetHorizon = typeof TANET_HORIZONS[number];
export type TaNetHeadName = 'up_1h' | 'up_4h' | 'vol_4h';
export const TANET_HEADS: TaNetHeadName[] = ['up_1h', 'up_4h', 'vol_4h'];

const H = 3_600_000;
const NA = NaN;
const fin = (x: number) => (Number.isFinite(x) ? x : NA);
const clip = (x: number, lim: number) => (Number.isFinite(x) ? Math.max(-lim, Math.min(lim, x)) : NA);
const perAtr = (s: TfState, x: number) => (s.atr > 0 ? x / s.atr : NA);
const sgn = (b: boolean | undefined) => (b === undefined ? NA : b ? 1 : 0);

/** Readings of one timeframe, scale-free (ATR units, oscillators centred), prefixed by tf. */
export function tfFeatures(p: string, s: TfState | undefined, out: Record<string, number>, opts: { sma200: boolean; vwap: boolean }): void {
  const put = (k: string, v: number, lim = 10) => { out[`${p}_${k}`] = s ? clip(v, lim) : NA; };
  if (!s) { for (const k of TF_KEYS(opts)) out[`${p}_${k}`] = NA; return; }
  put('rsi', (s.rsi - 50) / 50);
  put('rsi_chg', (s.rsi - s.rsiPrev) / 50);
  put('macd_atr', perAtr(s, s.macdHist));
  put('macd_chg_atr', perAtr(s, s.macdHist - s.macdHistPrev));
  put('macd_cross', s.macdCross);
  put('adx', s.adx / 50);
  put('adx_chg', (s.adx - s.adxPrev) / 50);
  put('di', (s.plusDI - s.minusDI) / 50);
  put('bb_pctb', s.bbPctB - 0.5, 3);
  put('bb_bw_rank', s.bbBandwidthRank);
  put('squeeze', s.squeeze ? 1 : 0);
  put('squeeze_release', s.squeezePrev && !s.squeeze ? 1 : 0);
  put('ema_stack', s.close > s.ema21 && s.ema21 > s.ema50 ? 1 : s.close < s.ema21 && s.ema21 < s.ema50 ? -1 : Number.isFinite(s.ema50) ? 0 : NA);
  put('ema12_26', perAtr(s, s.ema12 - s.ema26));
  put('ema21_dist', perAtr(s, s.close - s.ema21), 20);
  put('ema50_dist', perAtr(s, s.close - s.ema50), 30);
  put('sma50_dist', perAtr(s, s.close - s.sma50), 30);
  if (opts.sma200) { put('sma200_dist', perAtr(s, s.close - s.sma200), 60); put('golden', Number.isFinite(s.sma200) ? (s.sma50 > s.sma200 ? 1 : -1) : NA); }
  put('cloud', !s.cloud ? NA : s.cloud.above ? 1 : s.cloud.below ? -1 : 0);
  put('cloud_thick', s.cloud ? s.cloud.thicknessAtr : NA, 20);
  put('cloud_future', s.cloud ? (s.cloud.futureBull ? 1 : -1) : NA);
  put('tk_cross', s.cloud ? s.cloud.tkCross : NA);
  put('tk_above', s.cloud ? (s.cloud.tenkanAboveKijun ? 1 : -1) : NA);
  put('stoch', (s.stochK - 50) / 50);
  put('stoch_kd', (s.stochK - s.stochD) / 50);
  put('stoch_cross', s.stochCross);
  put('willr', (s.willR + 50) / 50);
  put('obv_slope', s.obvSlope, 3);
  put('cmf', s.cmf, 1);
  put('mfi', (s.mfi - 50) / 50);
  put('vol_ratio', s.volRatio > 0 ? Math.log(s.volRatio) : NA, 5);
  put('log_atr_pct', s.atrPct > 0 ? Math.log(s.atrPct) : NA, 15);
  put('atr_rank', s.atrRank);
  put('chg_atr', s.chgAtr, 10);
  put('chg20_atr', s.chg20Atr, 30);
  put('donchian', s.donchianBreak);
  put('trend', s.trend === 'up' ? 1 : s.trend === 'down' ? -1 : 0);
  put('bos', s.bos);
  put('choch', s.choch);
  put('sweep', s.sweep);
  put('breakout', s.breakout);
  put('eq_highs', s.equalHighs ? 1 : 0);
  put('eq_lows', s.equalLows ? 1 : 0);
  put('div', s.divRsi.regular + s.divMacd.regular + s.divObv.regular + s.divMfi.regular, 4);
  put('hdiv', s.divRsi.hidden + s.divMacd.hidden + s.divObv.hidden + s.divMfi.hidden, 4);
  put('obv_div', s.obvDiv.regular, 1);
  put('obv_hdiv', s.obvDiv.hidden, 1);
  put('engulf', s.candle.engulfing);
  put('pin', s.candle.pinBar);
  put('doji', s.candle.doji);
  put('fvg_dist', s.fvgDistAtr, 20);
  put('in_fvg', s.inFvg);
  put('vp_pos', s.profile && s.profile.vah > s.profile.val ? (s.close - s.profile.poc) / (s.profile.vah - s.profile.val) : NA, 5);
  put('vp_reentry', s.profile ? s.profile.reentry : NA);
  put('vp_node', s.profile ? Math.log(Math.max(1e-3, (s.profile.nodeLow + s.profile.nodeHigh) / 2)) : NA, 5);
  put('round_dist', s.round.distAtr, 20);
  put('round_cross', s.round.crossed);
  if (opts.vwap) put('vwap_dist', perAtr(s, s.close - s.vwap), 20);
  // TA-Lib-only readings and candlestick patterns (already scale-free; NaN without TA-Lib).
  for (const k of TALIB_KEYS) put(k, s.tl?.[k] ?? NaN, 30);
}

const BASE_KEYS = ['rsi', 'rsi_chg', 'macd_atr', 'macd_chg_atr', 'macd_cross', 'adx', 'adx_chg', 'di', 'bb_pctb', 'bb_bw_rank', 'squeeze', 'squeeze_release', 'ema_stack', 'ema12_26', 'ema21_dist', 'ema50_dist', 'sma50_dist',
  'cloud', 'cloud_thick', 'cloud_future', 'tk_cross', 'tk_above', 'stoch', 'stoch_kd', 'stoch_cross', 'willr', 'obv_slope', 'cmf', 'mfi', 'vol_ratio', 'log_atr_pct', 'atr_rank', 'chg_atr', 'chg20_atr', 'donchian',
  'trend', 'bos', 'choch', 'sweep', 'breakout', 'eq_highs', 'eq_lows', 'div', 'hdiv', 'engulf', 'pin', 'doji', 'obv_div', 'obv_hdiv', 'fvg_dist', 'in_fvg', 'vp_pos', 'vp_reentry', 'vp_node', 'round_dist', 'round_cross'];
export function TF_KEYS(o: { sma200: boolean; vwap: boolean }): string[] {
  return [...BASE_KEYS, ...(o.sma200 ? ['sma200_dist', 'golden'] : []), ...(o.vwap ? ['vwap_dist'] : []), ...TALIB_KEYS];
}
// 4h is built from the 280-bar hourly window (70 bars): no SMA200 there, live or in training. 15m reads
// the last TANET_M15_BARS closed bars (live keeps 320, enough for that window 12 hours back).
export const TF_OPTS: Array<[Timeframe, string, { sma200: boolean; vwap: boolean }]> = [['1h', 'h1', { sma200: true, vwap: true }], ['4h', 'h4', { sma200: false, vwap: false }], ['1d', 'd1', { sma200: true, vwap: false }], ['15m', 'm15', { sma200: true, vwap: true }]];
export const TANET_M15_BARS = 256;

export const KIND_OF = new Map(RULES.map((r) => [r.id, r.kind]));
export const RULE_KINDS = ['trend', 'reversal', 'continuation', 'regime', 'volatility'] as const;

/** Every input of the network, in order. */
export const TANET_FEATURES: string[] = [
  ...TF_OPTS.flatMap(([, p, o]) => TF_KEYS(o).map((k) => `${p}_${k}`)),
  ...CONFLUENCES.map((c) => `conf_${c.id}`),
  ...RULE_KINDS.map((k) => `net_${k}`), 'net_all', 'n_signals',
  'ret_1h_z', 'ret_4h_z', 'ret_24h_z', 'ret_168h_z', 'log_sigma_1h', 'rv_24_168', 'rv_4_24', 'range_24h_pos',
  'hour_sin', 'hour_cos', 'dow_sin', 'dow_cos', 'weekend', 'missing_hours',
  // Order flow: taker-buy share of volume (2 tb / v - 1) over 1, 4 and 24 hours, and its change.
  'flow_1h', 'flow_4h', 'flow_24h', 'flow_chg',
  // Market-wide context: BTC, relative strength vs BTC, market momentum / breadth, BTCDOM, the
  // dominance quadrant (bot/ta/taNetContext.ts).
  ...CONTEXT_FEATURES,
];

/** Reuses the 4h / 1d states between consecutive steps (they change every 4 / 24 bars). */
export interface TaNetStateCache { h4?: { key: string; s?: TfState }; d1?: { j: number; n: number; s?: TfState } }

/** States the network reads at the close of the last bar of `h1` (h1 = the hourly window). */
export function taNetStates(h1: Candle[], d1: Candle[] | undefined, t: number, cache?: TaNetStateCache, m15?: Candle[]): Partial<Record<Timeframe, TfState>> {
  const st: Partial<Record<Timeframe, TfState>> = {};
  const s1 = tfState('1h', h1);
  if (s1) st['1h'] = s1;
  if (m15?.length) {
    const j = closedIndex(m15, TF_MS['15m'], t);
    if (j >= TANET_M15_BARS - 1) { const s = tfState('15m', m15.slice(j - TANET_M15_BARS + 1, j + 1)); if (s) st['15m'] = s; }
  }
  const h4 = aggregate(h1, TF_MS['4h']).filter((c) => c.ts + TF_MS['4h'] <= t);
  if (h4.length) {
    const key = `${h4.length}|${h4[0].ts}|${h4[h4.length - 1].ts}|${h4[h4.length - 1].c}`;
    if (!cache?.h4 || cache.h4.key !== key) { const s = tfState('4h', h4); if (cache) cache.h4 = { key, s }; else if (s) st['4h'] = s; }
    if (cache?.h4?.s) st['4h'] = cache.h4.s;
  }
  if (d1?.length) {
    let j = d1.length - 1;
    while (j >= 0 && d1[j].ts + TF_MS['1d'] > t) j--;
    if (j >= 29) {
      if (!cache?.d1 || cache.d1.j !== j || cache.d1.n !== d1.length) {
        const s = tfState('1d', d1.slice(Math.max(0, j - TANET_D1_BARS + 1), j + 1));
        if (cache) cache.d1 = { j, n: d1.length, s }; else if (s) st['1d'] = s;
      }
      if (cache?.d1?.s) st['1d'] = cache.d1.s;
    }
  }
  return st;
}

/** The feature map at the close of the last bar of `h1` (TANET_H1_BARS hourly bars), with daily bars
 *  `d1`, 15-minute bars `m15` and the market-wide context. */
export function taNetFeatureMap(asset: string, h1: Candle[], d1: Candle[] | undefined, cache?: TaNetStateCache, o: { ctx?: TaNetContext; m15?: Candle[] } = {}): Record<string, number> {
  const last = h1[h1.length - 1];
  const t = last.ts + H;
  const states = taNetStates(h1, d1, t, cache, o.m15);
  // The dominance quadrant (4h scale) lets the dominance_matrix rule and macro_rotation confluence fire.
  const snap: TaSnapshot = evaluate(asset, states, t, o.ctx?.macro(asset, last.ts));
  const out: Record<string, number> = {};
  for (const [tf, p, o] of TF_OPTS) tfFeatures(p, states[tf], out, o);
  for (const c of CONFLUENCES) out[`conf_${c.id}`] = snap.confluences.find((x) => x.id === c.id)?.score ?? 0;
  for (const k of RULE_KINDS) out[`net_${k}`] = clip(snap.signals.filter((x) => KIND_OF.get(x.id) === k).reduce((a, x) => a + (k === 'regime' || k === 'volatility' ? (x.dir === 0 ? x.strength : x.dir * x.strength) : x.dir * x.strength), 0), 30);
  out.net_all = clip(snap.net, 60);
  out.n_signals = Math.log1p(snap.signals.length);
  // Returns and realised volatility from the hourly closes.
  const c = h1.map((x) => x.c);
  const n = c.length - 1;
  const r: number[] = [];
  for (let i = 1; i <= n; i++) r.push(Math.log(c[i] / c[i - 1]));
  const rms = (xs: number[]) => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / Math.max(1, xs.length));
  const s168 = rms(r.slice(-168)), s24 = rms(r.slice(-24)), s4 = rms(r.slice(-4));
  const z = (k: number) => (n >= k && s168 > 0 ? clip(Math.log(c[n] / c[n - k]) / (s168 * Math.sqrt(k)), 10) : NA);
  out.ret_1h_z = z(1); out.ret_4h_z = z(4); out.ret_24h_z = z(24); out.ret_168h_z = z(168);
  out.log_sigma_1h = s168 > 0 ? clip(Math.log(s168), 15) : NA;
  out.rv_24_168 = s24 > 0 && s168 > 0 ? clip(Math.log(s24 / s168), 5) : NA;
  out.rv_4_24 = s4 > 0 && s24 > 0 ? clip(Math.log(s4 / s24), 5) : NA;
  const w = h1.slice(-24);
  const hi = Math.max(...w.map((x) => x.h)), lo = Math.min(...w.map((x) => x.l));
  out.range_24h_pos = hi > lo ? clip((c[n] - lo) / (hi - lo) * 2 - 1, 1) : NA;
  const d = new Date(t);
  const hr = d.getUTCHours(), dow = d.getUTCDay();
  out.hour_sin = Math.sin((2 * Math.PI * hr) / 24); out.hour_cos = Math.cos((2 * Math.PI * hr) / 24);
  out.dow_sin = Math.sin((2 * Math.PI * dow) / 7); out.dow_cos = Math.cos((2 * Math.PI * dow) / 7);
  out.weekend = dow === 0 || dow === 6 ? 1 : 0;
  out.missing_hours = Math.max(0, Math.round((last.ts - h1[0].ts) / H) - (h1.length - 1));
  out.flow_1h = takerImbalance(h1.slice(-1)); out.flow_4h = takerImbalance(h1.slice(-4)); out.flow_24h = takerImbalance(h1.slice(-24));
  out.flow_chg = Number.isFinite(out.flow_4h) && Number.isFinite(out.flow_24h) ? out.flow_4h - out.flow_24h : NA;
  if (o.ctx) Object.assign(out, o.ctx.hourly(asset, last.ts));
  for (const k of TANET_FEATURES) if (!(k in out)) out[k] = NA;
  return out;
}

export const taNetVector = (names: string[], m: Record<string, number>) => names.map((k) => fin(m[k]));

/** Whether an hourly window is usable (no long outage inside). */
export function windowOk(h1: Candle[]): boolean {
  if (h1.length < TANET_H1_BARS) return false;
  return Math.round((h1[h1.length - 1].ts - h1[0].ts) / H) - (h1.length - 1) <= TANET_MAX_MISSING;
}

// ---- Branch inputs --------------------------------------------------------------------------------

/** Hourly GRU step: the coin's hourly / 4h readings, rule nets, confluences, returns and flow (the daily
 *  readings feed the macro branch; 15m readings and the market context feed the context branch). */
/** TA-Lib-only readings and candlestick patterns (h1_tl_cci, d1_cdl_net, ...): read once, through the
 *  context branch, not in every GRU / attention step (dozens of extra inputs per step made the
 *  network overfit, as the market context did before it got its own branch). */
const isTalibKey = (k: string) => TALIB_KEYS.some((t) => k.endsWith(`_${t}`));
/** The TA-Lib readings the network reads (per timeframe): a compact set. All of them reach the setup
 *  scorer (trees cope with wide inputs); ~170 extra context inputs made this network overfit a planted
 *  signal it otherwise learns, so it gets the candlestick summary and the oscillators that add the most. */
export const TANET_TALIB_KEYS = ['cdl_net', 'cdl_net3', 'tl_cci', 'tl_aroonosc', 'tl_ultosc', 'tl_sar_dist', 'tl_ht_trendmode', 'tl_kama_dist'];
const isNetTalibKey = (k: string) => TANET_TALIB_KEYS.some((t) => k.endsWith(`_${t}`));
export const TANET_TREND_FEATURES = TANET_FEATURES.filter((k) => !k.startsWith('d1_') && !k.startsWith('m15_') && !k.startsWith('x_') && !isTalibKey(k));
/** Context branch, read once at the forecast hour: the 15m TA library, the market-wide context, the
 *  TA-Lib readings of every timeframe, and TA on the daily index charts as of the last closed day. */
export const TANET_CTX_HOURLY = TANET_FEATURES.filter((k) => ((k.startsWith('m15_') || k.startsWith('x_')) && !isTalibKey(k)) || isNetTalibKey(k));
export const TANET_CTX_FEATURES = [...TANET_CTX_HOURLY, ...DAILY_CONTEXT_FEATURES];

// ---- Indicator families (grouped variant, bot/ta/branchNet.ts dims.fam) -------------------------
// Indicators that measure the same thing are stacked: RSI, MACD, Stochastic, CCI ... on 1h and 4h
// all feed the momentum family's encoder; ADX, moving averages, Ichimoku, SAR, KAMA the trend
// family; and so on. Context adds market (BTC, the basket, breadth), dominance (BTCDOM, BTC.D,
// USDT.D, the quadrant) and the slow series (TOTAL3, OTHERS.D, RTY).
const FAMILY_RULES: Array<[string, RegExp]> = [
  ['slow', /^dd_(total3|othersd|rty)_/],
  ['dominance', /^(x_btcdom_|x_dom_|dd_btcd_|dd_usdtd_|dd_dom_)/],
  ['market', /^(x_btc_|x_rel_|x_mkt_|x_breadth_)/],
  ['confluence', /^(conf_|net_|n_signals$)/],
  ['timing', /^(hour_|dow_|weekend$|missing_hours$)/],
  ['candles', /^(engulf|pin|doji|cdl_)/],
  ['volume', /^(obv_slope|cmf|mfi|vol_ratio|vwap_dist|vp_|flow_|tl_adosc|tl_bop)/],
  ['volatility', /^(bb_|squeeze|log_atr_pct|atr_rank|tl_natr|tl_stddev_atr|log_sigma_|rv_|range_24h_pos)/],
  ['structure', /^(bos|choch|sweep|breakout|eq_highs|eq_lows|donchian|fvg_dist|in_fvg|round_|div|hdiv|obv_div|obv_hdiv)$/],
  ['momentum', /^(rsi|rsi_chg|macd_|stoch|willr|chg_atr|chg20_atr|tl_cci|tl_mom_atr|tl_ultosc|tl_cmo|tl_ppo|tl_trix|tl_stochrsi|ret_)/],
  ['trend', /^(ema|sma|golden|cloud|tk_|adx|di$|trend$|tl_kama_dist|tl_ht_trendmode|tl_sar_dist|tl_aroonosc|tl_linreg_slope)/],
];

/** Family of one input (the timeframe prefix h1_ / h4_ / m15_ / d1_ is ignored: same indicator, same family). */
export function familyOf(name: string): string {
  const base = name.replace(/^(h1|h4|m15|d1)_/, '');
  for (const [fam, re] of FAMILY_RULES) if (re.test(name) || re.test(base)) return fam;
  return 'other';
}

/** Family index per trend / context input and the family names (in order of first appearance). */
export function taNetFamilies(): { trend: number[]; ctx: number[]; nT: number; nC: number; trendNames: string[]; ctxNames: string[] } {
  const index = (names: string[]) => { const order: string[] = []; const idx = names.map((n) => { const f = familyOf(n); let i = order.indexOf(f); if (i < 0) { i = order.length; order.push(f); } return i; }); return { idx, order }; };
  const t = index(TANET_TREND_FEATURES), c = index(TANET_CTX_FEATURES);
  return { trend: t.idx, ctx: c.idx, nT: t.order.length, nC: c.order.length, trendNames: t.order, ctxNames: c.order };
}
const D1_OPTS = { sma200: true, vwap: false };
/** One attention step per closed day: the daily TA readings plus daily returns and volatility. */
export const TANET_DAY_FEATURES = [...TF_KEYS(D1_OPTS).filter((k) => !TALIB_KEYS.includes(k)).map((k) => `d1_${k}`), 'dret_1', 'dret_5', 'dret_20', 'dvol_10_60', 'ddow_sin', 'ddow_cos'];

/** Daily step vector at the close of daily bar `j` (undefined until a full window exists). */
export function taNetDayVector(d1: Candle[], j: number): number[] | undefined {
  if (j < TANET_D1_BARS - 1) return undefined;
  const w = d1.slice(j - TANET_D1_BARS + 1, j + 1);
  const out: Record<string, number> = {};
  tfFeatures('d1', tfState('1d', w), out, D1_OPTS);
  const c = w.map((x) => x.c), n = c.length - 1;
  const r: number[] = [];
  for (let i = Math.max(1, n - 59); i <= n; i++) r.push(Math.log(c[i] / c[i - 1]));
  const rms = (xs: number[]) => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / Math.max(1, xs.length));
  const s60 = rms(r), s10 = rms(r.slice(-10));
  const z = (k: number) => (s60 > 0 ? clip(Math.log(c[n] / c[n - k]) / (s60 * Math.sqrt(k)), 10) : NA);
  out.dret_1 = z(1); out.dret_5 = z(5); out.dret_20 = z(20);
  out.dvol_10_60 = s10 > 0 && s60 > 0 ? clip(Math.log(s10 / s60), 5) : NA;
  const dow = new Date(w[n].ts).getUTCDay();
  out.ddow_sin = Math.sin((2 * Math.PI * dow) / 7); out.ddow_cos = Math.cos((2 * Math.PI * dow) / 7);
  return TANET_DAY_FEATURES.map((k) => fin(out[k]));
}

/** Last index with ts + period <= t (closed by t), or -1. */
export function closedIndex(cs: Candle[], periodMs: number, t: number): number {
  let lo = 0, hi = cs.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cs[m].ts + periodMs <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/** 15-minute steps closed by `t`: [return/sigma, log(high/low)/sigma, close position in bar, log volume
 *  vs the 32-bar mean], sigma = rms of the 32 returns. NaN-filled when 33 consecutive bars are missing. */
export function taNetMicro(m15: Candle[] | undefined, t: number): Float64Array {
  const out = new Float64Array(TANET_MICRO_STEPS * TANET_MICRO_F).fill(NaN);
  if (!m15?.length) return out;
  const Q = 900_000;
  const j = closedIndex(m15, Q, t);
  if (j < TANET_MICRO_STEPS) return out;
  const w = m15.slice(j - TANET_MICRO_STEPS, j + 1);
  if (w[w.length - 1].ts - w[0].ts !== TANET_MICRO_STEPS * Q) return out;
  const r: number[] = [];
  for (let i = 1; i < w.length; i++) r.push(Math.log(w[i].c / w[i - 1].c));
  const s = Math.sqrt(r.reduce((a, x) => a + x * x, 0) / r.length);
  const avgV = w.slice(1).reduce((a, x) => a + x.v, 0) / TANET_MICRO_STEPS;
  if (!(s > 0)) return out;
  for (let k = 0; k < TANET_MICRO_STEPS; k++) {
    const b = w[k + 1];
    const F = TANET_MICRO_F;
    out[k * F] = clip(r[k] / s, 10);
    out[k * F + 1] = b.h > b.l ? clip(Math.log(b.h / b.l) / s, 20) : 0;
    out[k * F + 2] = b.h > b.l ? ((b.c - b.l) / (b.h - b.l)) * 2 - 1 : 0;
    out[k * F + 3] = avgV > 0 ? clip(Math.log((b.v + 1e-9) / avgV), 5) : 0;
    out[k * F + 4] = takerImbalance([b]);
  }
  return out;
}

/** Raw hourly bars ending at index i (the swing branch): [return/sigma, log(high/low)/sigma, close
 *  position, log volume vs the 48-bar mean, taker imbalance], sigma = rms of the 48 returns. */
export function taNetSwing(h1: Candle[], i: number): Float64Array {
  const B = TANET_SWING_BARS, F = TANET_SWING_F;
  const out = new Float64Array(B * F).fill(NaN);
  if (i < B) return out;
  const w = h1.slice(i - B, i + 1);
  const r: number[] = [];
  for (let k = 1; k < w.length; k++) r.push(Math.log(w[k].c / w[k - 1].c));
  const s = Math.sqrt(r.reduce((a, x) => a + x * x, 0) / r.length);
  const avgV = w.slice(1).reduce((a, x) => a + x.v, 0) / B;
  if (!(s > 0)) return out;
  for (let k = 0; k < B; k++) {
    const b = w[k + 1];
    out[k * F] = clip(r[k] / s, 10);
    out[k * F + 1] = b.h > b.l ? clip(Math.log(b.h / b.l) / s, 20) : 0;
    out[k * F + 2] = b.h > b.l ? ((b.c - b.l) / (b.h - b.l)) * 2 - 1 : 0;
    out[k * F + 3] = avgV > 0 ? clip(Math.log((b.v + 1e-9) / avgV), 5) : 0;
    out[k * F + 4] = takerImbalance([b]);
  }
  return out;
}

/** RMS of the last 24 hourly log returns (the position rule's volatility scale). */
export function sigma24(h1: Candle[], i: number): number {
  if (i < 24) return NaN;
  let s = 0;
  for (let k = i - 23; k <= i; k++) { const r = Math.log(h1[k].c / h1[k - 1].c); s += r * r; }
  return Math.sqrt(s / 24);
}

// ---- Position rule (shared by the tournament's fitness and the live forward test) -----------------

export interface TaNetStrategy {
  /** Positions smaller than this (fraction of the asset's capital) are not taken (avoids churning
   *  on noise; with hourly vol near 0.6% this means P(up) beyond roughly 0.5 +/- 0.002). */
  minPos: number;
  /** Fractional Kelly shrinkage (0.25 = quarter Kelly). */
  shrink: number;
  maxPos: number;
  /** Cost per unit of turnover (taker fee + slippage), as a fraction of notional. */
  costPerTurnover: number;
  /** Confidence threshold: a barrier trade is taken only when |P(up in 4h) - 0.5| >= minEdge (tuned
   *  by the tournament; trading fewer, surer hours instead of every hour). */
  minEdge?: number;
}
export const TANET_STRATEGY: TaNetStrategy = { minPos: 0.1, shrink: 0.25, maxPos: 1, costPerTurnover: 0.0005 };

/** Position (fraction of the asset's capital, signed) for the next hour: fractional Kelly for a
 *  continuous bet, f* = mu / sigma^2 with mu = (2p - 1) E|r| = (2p - 1) sigma sqrt(2/pi), and sigma the
 *  network's own volatility forecast. */
export function taNetPosition(pUp: number, volLogRatio: number, sig24: number, s: TaNetStrategy = TANET_STRATEGY): number {
  if (!Number.isFinite(pUp) || !(sig24 > 0)) return 0;
  const sigHat = sig24 * Math.exp(Number.isFinite(volLogRatio) ? Math.max(-3, Math.min(3, volLogRatio)) : 0);
  const f = (s.shrink * (2 * pUp - 1) * Math.sqrt(2 / Math.PI)) / sigHat;
  if (Math.abs(f) < s.minPos) return 0;
  return Math.max(-s.maxPos, Math.min(s.maxPos, f));
}

// ---- Model ---------------------------------------------------------------------------------------

/** Triple-barrier trade (López de Prado): take-profit and stop at +/- k forecast 4-hour standard
 *  deviations, a 4-hour time barrier; the first barrier touched decides. */
export const TANET_BARRIER = { horizon: 4, k: 1 };

/** Position for the 4-hour barrier trade: fractional Kelly on P(up in 4h) with the 4-hour vol scale. */
export function taNetBarrierPosition(pUp4: number, volLogRatio: number, sig24: number, s: TaNetStrategy = TANET_STRATEGY): number {
  if (!(Math.abs(pUp4 - 0.5) >= (s.minEdge ?? 0))) return 0;
  return taNetPosition(pUp4, volLogRatio, sig24 * Math.sqrt(TANET_BARRIER.horizon), s);
}

/** Barrier half-width (log) from the forecast hourly vol: k x sigma_1h x sqrt(horizon). */
export function taNetBarrierWidth(volLogRatio: number, sig24: number): number {
  return TANET_BARRIER.k * sig24 * Math.exp(Number.isFinite(volLogRatio) ? Math.max(-3, Math.min(3, volLogRatio)) : 0) * Math.sqrt(TANET_BARRIER.horizon);
}

/**
 * Log return of a triple-barrier trade in direction `dir`, entered at `entry`, over the following bars
 * `next` (horizon bars). Path-aware and conservative: a bar that touches both barriers counts as the
 * stop, and a bar that opens beyond a barrier exits at its open (gaps are not filled at the barrier).
 */
export function tripleBarrier(entry: number, next: Candle[], dir: 1 | -1, width: number): number {
  const up = entry * Math.exp(width), dn = entry * Math.exp(-width);
  for (const b of next) {
    const stopHit = dir > 0 ? b.l <= dn : b.h >= up;
    const takeHit = dir > 0 ? b.h >= up : b.l <= dn;
    if (stopHit) return dir > 0 ? Math.log(Math.min(dn, b.o) / entry) : -Math.log(Math.max(up, b.o) / entry);
    if (takeHit) return dir > 0 ? Math.log(Math.max(up, b.o) / entry) : -Math.log(Math.min(dn, b.o) / entry);
  }
  return dir * Math.log(next[next.length - 1].c / entry);
}

export interface TaNetNorm { mean: number[]; std: number[] }

export interface TaNetHeadValidation {
  metric: 'logloss' | 'mse';
  rows: number;
  from: string; to: string;
  base: number; model: number;
  /** Day-block bootstrap of the per-row improvement (base - model) on the unseen holdout. */
  improvement: { mean: number; lo: number; hi: number };
  skill?: number; hitRate?: number;
  /** The holdout CI is above zero. */
  holdoutPassed: boolean;
  /** The same head on the frozen final window (the most recent months, never used for anything else):
   *  passed = mean improvement above zero. */
  final?: { rows: number; from: string; to: string; base: number; model: number; improvement: { mean: number; lo: number; hi: number }; hitRate?: number; passed: boolean };
  /** Allowed to speak live: holdoutPassed, and for direction heads also the network-level gates. */
  validated: boolean;
}

/** Selective prediction: hours traded (barrier trade taken) and their win rate with a Wilson 95% interval. */
export interface TaNetSelective { hours: number; taken: number; coverage: number; hitRate: number; hitLo: number; hitHi: number; netReturn: number }

export interface TaNetNetworkValidation {
  /** Deflated Sharpe of the elite lineage's out-of-sample record (independent interactions). */
  dsr: { sharpe: number; sr0: number; probability: number; n: number };
  trials: number;
  regimes: Array<{ regime: string; independent: number; netReturn: number; sortino: number; hitRate: number; enough: boolean }>;
  /** Strategy fitness on the unseen holdout months. */
  holdout: { fitness: number; sortino: number; maxDrawdown: number; costs: number; netReturn: number; independent: number; days: number; selective?: TaNetSelective };
  /** The frozen final window: strategy fitness, selective hit rate, and how often this window has been
   *  evaluated (more than once = it is no longer an unseen test). */
  final?: { from: string; to: string; fitness: number; sortino: number; maxDrawdown: number; netReturn: number; selective: TaNetSelective; views: number };
  minIndependentPerRegime: number;
  dsrThreshold: number;
  /** DSR probability >= threshold AND every covered regime has enough independent interactions. */
  validated: boolean;
}

export interface PatternReport {
  /** Bars each fractal column sees (e.g. 3 / 7 / 31). */
  reach: number[];
  /** Holdout loss with only one column active in a block, vs all columns (lower = that depth alone does well). */
  ablation: Array<{ block: 'micro' | 'swing'; column: number; reach: number; logLossUp1h: number; mseVol: number }>;
  allColumns: { logLossUp1h: number; mseVol: number };
  /** Max |correlation| between a column's channels and each TA pattern family's readings. */
  families: Array<{ block: 'micro' | 'swing'; column: number; reach: number } & Record<string, number | string>>;
  /** Per block and family: the column whose channels track that family most closely. */
  best?: Record<string, { block: 'micro' | 'swing'; family: string; column: number; reach: number; corr: number }>;
  /** Held-out rows the report was computed on. */
  rows?: number;
}

export interface TaNetParams {
  version: string;
  schema: string;
  dims: BranchDims;
  gates: BranchGates;
  weights: number[];
  norm: { trend: TaNetNorm; macro: TaNetNorm; micro: TaNetNorm; swing: TaNetNorm; ctx: TaNetNorm };
  /** Which fractal depth carries which kind of TA pattern (research/trainTaNet.ts patternReport). */
  patterns?: PatternReport;
  /** Market-wide context the network was trained with: index series coverage and the coin basket. */
  context?: { indexes: Record<string, { from: string; to: string; bars: number }>; basket: string[] };
  trendFeatures: string[];
  dayFeatures: string[];
  strategy: TaNetStrategy;
  heads: Record<TaNetHeadName, { validation: TaNetHeadValidation }>;
  network: TaNetNetworkValidation;
  pbt: { rounds: number; trials: number; elite: { member: number; hyper: Record<string, number>; lineage: number[] }; recent: unknown[] };
  data: { assets: string[]; from: string; to: string; rows: number; sources: Record<string, string[]>; holdoutFrom: string; finalFrom?: string };
  /** Indicator engine the inputs were computed with ('talib' or 'builtin'; bot/ta/talib.ts). */
  taEngine?: string;
  /** Architecture: 'flat' (raw readings into the GRU / context layer) or 'grouped' (indicator families). */
  arch?: 'flat' | 'grouped';
  /** Grouped: family names, trend families first then context families (the attention's order). */
  familyNames?: string[];
  /** Platt calibration of the direction heads: P = sigmoid(a x logit(P_raw) + b), fitted on an evaluation period the
   *  network never trained on (research/trainTaNet.ts). Raw network probabilities are overconfident. */
  calib?: Partial<Record<'up_1h' | 'up_4h', PlattParams>>;
  trainedAt: string;
}

export interface PlattParams { a: number; b: number; rows: number; before: number; after: number }

/** Apply Platt calibration to a probability (identity without parameters). */
export function calibrated(p: number, c: PlattParams | undefined): number {
  if (!c || !Number.isFinite(p)) return p;
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return sigmoid(c.a * Math.log(q / (1 - q)) + c.b);
}

/** Fit Platt parameters (a in [0, 1]: it only ever shrinks overconfident probabilities, never sharpens
 *  them; |b| <= 0.2) by Newton steps on the log loss, with a light pull toward the
 *  identity (a = 1, b = 0) so a small sample cannot produce wild values. */
export function fitPlatt(ps: ArrayLike<number>, ys: ArrayLike<number>, l2 = 1e-3): PlattParams {
  const z: number[] = [], y: number[] = [];
  for (let i = 0; i < ps.length; i++) if (Number.isFinite(ps[i]) && Number.isFinite(ys[i])) { const q = Math.min(1 - 1e-9, Math.max(1e-9, ps[i])); z.push(Math.log(q / (1 - q))); y.push(ys[i]); }
  const ll = (a: number, b: number) => { let s = 0; for (let i = 0; i < z.length; i++) { const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(a * z[i] + b))); s -= y[i] ? Math.log(p) : Math.log(1 - p); } return s / Math.max(1, z.length); };
  let a = 1, b = 0;
  if (z.length < 50) return { a, b, rows: z.length, before: ll(1, 0), after: ll(1, 0) };
  const n = z.length;
  for (let it = 0; it < 50; it++) {
    let ga = l2 * (a - 1), gb = l2 * b, haa = l2, hab = 0, hbb = l2;
    for (let i = 0; i < n; i++) {
      const p = sigmoid(a * z[i] + b), r = (p - y[i]) / n, w = p * (1 - p) / n;
      ga += r * z[i]; gb += r; haa += w * z[i] * z[i]; hab += w * z[i]; hbb += w;
    }
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-18)) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a = Math.max(0, Math.min(1, a - da)); b = Math.max(-0.2, Math.min(0.2, b - db));
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { a, b, rows: n, before: ll(1, 0), after: ll(a, b) };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Normalised branch input from raw step vectors (missing -> 0 = the training mean). */
export function buildBranchInput(dims: BranchDims, norm: TaNetParams['norm'], trend: ArrayLike<number>[], macro: ArrayLike<number>[], micro: ArrayLike<number>, swing: ArrayLike<number>, ctxVec: ArrayLike<number>): BranchInput {
  const nz = (v: number, n: TaNetNorm, j: number) => (Number.isFinite(v) ? Math.max(-8, Math.min(8, (v - n.mean[j]) / n.std[j])) : 0);
  const t = new Float64Array(dims.tT * dims.tF), m = new Float64Array(dims.dT * dims.dF), u = new Float64Array(dims.mT * dims.mF), w = new Float64Array(dims.sT * dims.sF);
  for (let s = 0; s < dims.sT; s++) for (let f = 0; f < dims.sF; f++) w[s * dims.sF + f] = nz(swing[s * dims.sF + f], norm.swing, f);
  for (let s = 0; s < dims.tT; s++) for (let f = 0; f < dims.tF; f++) t[s * dims.tF + f] = nz(trend[s][f], norm.trend, f);
  for (let s = 0; s < dims.dT; s++) for (let f = 0; f < dims.dF; f++) m[s * dims.dF + f] = nz(macro[s][f], norm.macro, f);
  for (let s = 0; s < dims.mT; s++) for (let f = 0; f < dims.mF; f++) u[s * dims.mF + f] = nz(micro[s * dims.mF + f], norm.micro, f);
  const c = new Float64Array(dims.cF);
  for (let f = 0; f < dims.cF; f++) c[f] = nz(ctxVec[f], norm.ctx, f);
  return { trend: t, macro: m, micro: u, swing: w, ctx: c };
}

/** Schema of a TA network file, read from its first few KB (the key follows `version`); undefined when
 *  the file is missing or unreadable. Lets callers skip a file this build cannot load. */
export function taNetFileSchema(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    let head = '';
    try {
      const buf = Buffer.alloc(4096);
      head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
    } finally { fs.closeSync(fd); }
    const m = /"schema"\s*:\s*"([^"]*)"/.exec(head);
    return m ? m[1] : (JSON.parse(fs.readFileSync(file, 'utf8')) as { schema?: string }).schema;
  } catch { return undefined; }
}

export class TaNet {
  private readonly w: Float64Array;
  private readonly layout: ReturnType<typeof branchLayout>['layout'];
  constructor(readonly params: TaNetParams) {
    const { layout, size } = branchLayout(params.dims);
    if (params.weights.length !== size) throw new Error(`TA network weights: ${params.weights.length} values, the layout needs ${size}`);
    this.w = Float64Array.from(params.weights);
    this.layout = layout;
  }

  static load(file: string): TaNet | undefined {
    if (!fs.existsSync(file)) return undefined;
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as TaNetParams;
    if (p.schema !== TANET_SCHEMA) throw new Error(`TA network ${file} has schema ${p.schema}, this build needs ${TANET_SCHEMA} (retrain it)`);
    if (!p.dims || !Array.isArray(p.weights) || !p.heads) throw new Error(`invalid TA network ${file}`);
    if (p.taEngine && p.taEngine !== taEngine()) console.warn(`[ta-net] ${file} was trained with the ${p.taEngine} indicator engine but ${taEngine()} is active: its inputs differ from training (install TA-Lib: npm ci)`);
    return new TaNet(p);
  }

  get version(): string { return this.params.version; }

  /** Heads allowed to speak: validated ones (or all when `requireValidated` is false). */
  active(requireValidated = true): TaNetHeadName[] {
    return TANET_HEADS.filter((k) => this.params.heads[k] && (!requireValidated || this.params.heads[k].validation.validated));
  }

  /** P(up 1h), P(up 4h), vol log ratio from raw step vectors. */
  predict(trend: ArrayLike<number>[], macro: ArrayLike<number>[], micro: ArrayLike<number>, swing: ArrayLike<number>, ctxVec: ArrayLike<number>): { up1: number; up4: number; vol: number; families?: Record<string, number> } {
    const x = buildBranchInput(this.params.dims, this.params.norm, trend, macro, micro, swing, ctxVec);
    const f = branchForward(this.params.dims, this.w, this.params.gates, x, this.layout);
    const o = f.out;
    // Grouped network: how much each indicator family counted in this call (the family attention).
    const names = this.params.familyNames;
    const families = f.cache.pi && names?.length === f.cache.pi.length ? Object.fromEntries(names.map((n, i) => [n, +f.cache.pi![i].toFixed(3)])) : undefined;
    const c = this.params.calib;
    return { up1: calibrated(sigmoid(o[0]), c?.up_1h), up4: calibrated(sigmoid(o[1]), c?.up_4h), vol: clip(o[2], 3), families };
  }
}

// ---- Live / replay runtime -----------------------------------------------------------------------

export interface TaNetOutput {
  /** Open time of the hourly bar the forecast was made at the close of. */
  barTs: number;
  up: Partial<Record<TaNetHorizon, number>>;
  vol4h?: number;
  /** Rolling skill (1 - Brier/0.25) of the last graded calls per horizon (NaN until 24 graded). */
  skill: Partial<Record<TaNetHorizon, number>>;
  graded: Partial<Record<TaNetHorizon, number>>;
  /** The direction heads' forecasts whether or not they validated (`up` holds only the validated ones),
   *  and their own rolling skill on the calls graded so far: what the conviction overlay
   *  (bot/strategy/taConviction.ts) weighs them by. */
  raw?: Partial<Record<TaNetHorizon, number>>;
  rawSkill?: Partial<Record<TaNetHorizon, number>>;
  rawGraded?: Partial<Record<TaNetHorizon, number>>;
  /** Whether each direction head is allowed to speak (validated, and not muted by a failed forward test). */
  validated?: Partial<Record<TaNetHorizon, boolean>>;
  version: string;
  /** Grouped network: weight of each indicator family in this call (trend families, then context). */
  families?: Record<string, number>;
  /** Live forward test of the position rule: status and days so far. */
  forward?: { status: 'forward-testing' | 'confirmed' | 'failed'; days: number };
}

interface Call { up60: number; up240: number; raw60: number; raw240: number; vol: number; close: number; pos: number; pos4: number; width: number; families?: Record<string, number> }

const ROLL = 168;
const MIN_GRADED = 24;
const DAY_MS = 86_400_000;

export interface ForwardRecord {
  version: string;
  startTs: number;
  /** Per-asset hourly results of the position rule: [barTs, ret, cost]. */
  results: Record<string, Array<[number, number, number]>>;
  status: 'forward-testing' | 'confirmed' | 'failed';
  decidedAt?: number;
}

/** One barrier trade's contribution: |position| x barrier return minus entry + exit costs, divided by
 *  the horizon (a new trade opens every hour, so `horizon` overlap) and the number of coins. */
export function barrierResult(pos: number, entry: number, next: Candle[], width: number, s: TaNetStrategy, nCoins: number): { ret: number; cost: number } {
  if (pos === 0 || !(width > 0) || next.length < TANET_BARRIER.horizon) return { ret: 0, cost: 0 };
  const scale = 1 / (TANET_BARRIER.horizon * Math.max(1, nCoins));
  const cost = 2 * s.costPerTurnover * Math.abs(pos) * scale;
  return { ret: Math.abs(pos) * tripleBarrier(entry, next, pos > 0 ? 1 : -1, width) * scale - cost, cost };
}

/** Where the live runtime gets the market-wide context: every tracked coin's candles and the index
 *  series (bot/marketdata/indexBars.ts IndexStore). Set once at startup (main.ts, research replay). */
export interface TaNetContextSource {
  sets(): Map<string, CandleSet>;
  index(asset: string, tf: '1h' | '1d'): Candle[] | undefined;
}
let contextSource: TaNetContextSource | undefined;
export function setTaNetContextSource(s: TaNetContextSource | undefined): void { contextSource = s; }

/** Per-asset forecasts from a CandleSet, memoised per closed hourly bar, graded as later bars close,
 *  and (live only) forward-tested with the position rule. */
export class TaNetRuntime {
  private ctxCache?: { key: string; ctx: TaNetContext };
  private readonly feats = new Map<string, Map<number, { f: number[]; c: number[]; close: number; sig: number }>>();
  private readonly days = new Map<string, Map<number, number[]>>();
  private readonly calls = new Map<string, Map<number, Call>>();
  private readonly briers = new Map<string, Record<TaNetHorizon, number[]>>();
  private readonly rawBriers = new Map<string, Record<TaNetHorizon, number[]>>();
  private readonly gradedTs = new Map<string, Record<TaNetHorizon, Set<number>>>();
  private readonly last = new Map<string, { lastTs: number; len: number; out: TaNetOutput }>();
  private forward?: { file: string; rec: ForwardRecord; days: number; minDays: number; mute: boolean; savedDay: number };

  constructor(readonly net: TaNet, readonly requireValidated = true) {}

  /** The latest hourly inputs for an asset, z-scored the way the network sees them (trend features and
   *  the hourly context features, in TANET_TREND_FEATURES / TANET_CTX_FEATURES order). For the dashboard. */
  /** Every stored hour of an asset's inputs (z-scored as in latestInputs) with its close, oldest first. */
  inputHistory(asset: string): Array<{ ts: number; trend: number[]; ctx: number[]; close: number }> {
    const m = this.feats.get(asset);
    if (!m) return [];
    const n = this.net.params.norm;
    const z = (v: number, nm: TaNetNorm, j: number) => (Number.isFinite(v) && nm.std[j] ? Math.max(-8, Math.min(8, (v - nm.mean[j]) / nm.std[j])) : 0);
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([ts, r]) => ({ ts, trend: r.f.map((v, j) => z(v, n.trend, j)), ctx: r.c.map((v, j) => z(v, n.ctx, j)), close: r.close }));
  }

  latestInputs(asset: string): { ts: number; trend: number[]; ctx: number[] } | undefined {
    const m = this.feats.get(asset);
    if (!m?.size) return undefined;
    const ts = Math.max(...m.keys()), r = m.get(ts)!, n = this.net.params.norm;
    const z = (v: number, nm: TaNetNorm, j: number) => (Number.isFinite(v) && nm.std[j] ? Math.max(-8, Math.min(8, (v - nm.mean[j]) / nm.std[j])) : 0);
    return { ts, trend: r.f.map((v, j) => z(v, n.trend, j)), ctx: r.c.map((v, j) => z(v, n.ctx, j)) };
  }

  /** Live only: record the position rule's results per hour and decide after `days` days. */
  enableForwardTest(file: string, now: number, o: { days?: number; muteOnFail?: boolean } = {}): void {
    let rec: ForwardRecord | undefined;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')) as ForwardRecord; } catch { /* first run */ }
    if (!rec || rec.version !== this.net.version) rec = { version: this.net.version, startTs: now, results: {}, status: 'forward-testing' };
    this.forward = { file, rec, days: o.days ?? 90, minDays: o.days ?? 90, mute: o.muteOnFail ?? true, savedDay: Math.floor(now / DAY_MS) };
  }

  forwardStatus(now: number): { status: ForwardRecord['status']; days: number; netReturn: number; sortino: number; independent: number } | undefined {
    const f = this.forward;
    if (!f) return undefined;
    const all = Object.values(f.rec.results).flat();
    const byDay = new Map<number, number>();
    const n = Math.max(1, Object.keys(f.rec.results).length);
    for (const [ts, r] of all) byDay.set(Math.floor(ts / DAY_MS), (byDay.get(Math.floor(ts / DAY_MS)) ?? 0) + r / n);
    const daily = [...byDay.values()];
    const m = daily.reduce((a, x) => a + x, 0) / Math.max(1, daily.length);
    const dn = Math.sqrt(daily.reduce((a, x) => a + Math.min(0, x) ** 2, 0) / Math.max(1, daily.length));
    let runs = 0;
    for (const rs of Object.values(f.rec.results)) for (let i = 0; i < rs.length; i++) if (rs[i][1] !== 0 && (i === 0 || rs[i - 1][1] === 0 || rs[i][0] - rs[i - 1][0] > H)) runs++;
    return { status: f.rec.status, days: (now - f.rec.startTs) / DAY_MS, netReturn: daily.reduce((a, x) => a + x, 0), sortino: dn > 0 ? (m / dn) * Math.sqrt(365) : m > 0 ? 10 : 0, independent: runs };
  }

  private forwardStep(asset: string, h1: Candle[], memo: Map<number, Call>, now: number): void {
    const f = this.forward;
    if (!f || f.rec.status !== 'forward-testing') return;
    const rs = (f.rec.results[asset] ??= []);
    const lastDone = rs.length ? rs[rs.length - 1][0] : -Infinity;
    // The same triple-barrier trade the tournament scored: one per hour, graded once its 4 bars closed.
    const n = TANET_BARRIER.horizon;
    for (let i = 0; i + n < h1.length; i++) {
      const bar = h1[i];
      if (bar.ts <= lastDone || bar.ts < f.rec.startTs || h1[i + n].ts - bar.ts !== n * H) continue;
      const call = memo.get(bar.ts);
      if (!call) continue;
      const { ret, cost } = barrierResult(call.pos4, bar.c, h1.slice(i + 1, i + 1 + n), call.width, this.net.params.strategy, 1);
      rs.push([bar.ts, ret, cost]);
    }
    const day = Math.floor(now / DAY_MS);
    if ((now - f.rec.startTs) / DAY_MS >= f.minDays) {
      const st = this.forwardStatus(now)!;
      // Confirmed when the live record is positive after costs with a positive Sortino over enough
      // independent position runs; otherwise failed (and, by default, the direction heads go silent).
      f.rec.status = st.netReturn > 0 && st.sortino > 0 && st.independent >= 30 ? 'confirmed' : 'failed';
      f.rec.decidedAt = now;
    }
    if (day !== f.savedDay || f.rec.decidedAt === now) {
      f.savedDay = day;
      try { fs.writeFileSync(f.file, JSON.stringify(f.rec)); } catch { /* best effort */ }
    }
  }

  /** The live context, rebuilt when any coin's hourly candles or an index series changed. Only the
   *  recent part of each series is used (every feature looks back at most 280 + 168 hours). */
  private context(): TaNetContext | undefined {
    const src = contextSource;
    if (!src) return undefined;
    const h1: Record<string, Candle[]> = {};
    let key = '';
    for (const [a, s] of src.sets()) { const b = s.bars['1h']; if (b?.length) { h1[a] = b; key += `${a}:${b[b.length - 1].ts}:${b.length};`; } }
    const dom = src.index('BTCDOM', '1h'), btcd = src.index('BTC.D', '1d'), usdtd = src.index('USDT.D', '1d');
    const slow = Object.fromEntries(SLOW_INDEXES.map(({ asset }) => [asset, src.index(asset, '1d')?.slice(-400)]));
    const tail = (cs: Candle[] | undefined) => `${cs?.length ?? 0}:${cs?.[cs.length - 1]?.ts ?? 0}:${cs?.[cs.length - 1]?.c ?? 0}`;
    key += `|${tail(dom)}|${tail(btcd)}|${tail(usdtd)}|${SLOW_INDEXES.map(({ asset }) => tail(slow[asset])).join('|')}`;
    if (this.ctxCache?.key === key) return this.ctxCache.ctx;
    const ctx = new TaNetContext({ h1, btcdom1h: dom?.slice(-800), btcd1d: btcd?.slice(-500), usdtd1d: usdtd?.slice(-500), slow1d: slow });
    this.ctxCache = { key, ctx };
    return ctx;
  }

  /** Forecast at the last closed hourly bar of `set` (undefined when stale or history too short). */
  outputFor(asset: string, set: CandleSet | undefined, now: number): TaNetOutput | undefined {
    const h1 = set?.bars['1h'];
    const need = TANET_H1_BARS + TANET_TREND_STEPS - 1;
    if (!h1 || h1.length < need) return undefined;
    const lastTs = h1[h1.length - 1].ts;
    if (now - (lastTs + H) > 3 * H || lastTs + H > now) return undefined;
    const prev = this.last.get(asset);
    if (prev && prev.lastTs === lastTs && prev.len === h1.length) return prev.out;
    // Time went backwards (a research process replaying another span): start this asset afresh, so
    // the rolling skill only ever contains calls graded before `now`, exactly as live.
    if (prev && lastTs < prev.lastTs) for (const m of [this.feats, this.days, this.calls, this.briers, this.rawBriers, this.gradedTs]) m.delete(asset);
    const feats = this.feats.get(asset) ?? new Map(); this.feats.set(asset, feats);
    const days = this.days.get(asset) ?? new Map(); this.days.set(asset, days);
    const memo = this.calls.get(asset) ?? new Map<number, Call>(); this.calls.set(asset, memo);
    const p = this.net.params;
    const trendIdx = p.trendFeatures.map((k) => TANET_FEATURES.indexOf(k));
    const ctxIdx = TANET_CTX_HOURLY.map((k) => TANET_FEATURES.indexOf(k));
    const ctx = this.context();
    // Wait (a minute or so) until the other coins' and BTCDOM's bars for the newest hour are in, so a
    // cached feature row never misses context that training had.
    if (ctx && !feats.has(lastTs) && !ctx.ready(lastTs, now)) return prev && prev.lastTs === lastTs ? prev.out : undefined;
    for (let i = TANET_H1_BARS - 1; i < h1.length; i++) {
      if (feats.has(h1[i].ts)) continue;
      const w = h1.slice(i - TANET_H1_BARS + 1, i + 1);
      if (!windowOk(w)) continue;
      const fm = taNetFeatureMap(asset, w, set!.bars['1d'], undefined, { ctx, m15: set!.bars['15m'] });
      const all = TANET_FEATURES.map((k) => fin(fm[k]));
      feats.set(h1[i].ts, { f: trendIdx.map((j) => all[j]), c: ctxIdx.map((j) => all[j]), close: h1[i].c, sig: sigma24(h1, i) });
    }
    const d1 = set!.bars['1d'] ?? [];
    for (let j = TANET_D1_BARS - 1; j < d1.length; j++) if (!days.has(d1[j].ts)) { const v = taNetDayVector(d1, j); if (v) days.set(d1[j].ts, v); }
    const active = this.net.active(this.requireValidated);
    const muted = this.forward?.mute && this.forward.rec.status === 'failed';
    for (let i = need - 1; i < h1.length; i++) {
      const ts = h1[i].ts;
      if (memo.has(ts)) continue;
      const trend: number[][] = [];
      for (let s = TANET_TREND_STEPS - 1; s >= 0; s--) { const r = feats.get(ts - s * H); if (r) trend.push(r.f); }
      const t = ts + H;
      const dj = closedIndex(d1, DAY_MS, t);
      const macro: number[][] = [];
      for (let k = dj - TANET_MACRO_DAYS + 1; k <= dj && k >= 0; k++) { const v = days.get(d1[k].ts); if (v) macro.push(v); }
      const fr = feats.get(ts);
      if (trend.length < TANET_TREND_STEPS || macro.length < TANET_MACRO_DAYS || !fr) { memo.set(ts, { up60: NA, up240: NA, raw60: NA, raw240: NA, vol: NA, close: h1[i].c, pos: 0, pos4: 0, width: NaN }); continue; }
      // Context vector: this hour's 15m readings and market context, then the dominance charts' TA as of
      // the last closed day (the same day the macro branch ends on).
      const ctxVec = [...fr.c, ...(ctx && dj >= 0 ? ctx.daily(asset, d1[dj].ts) : DAILY_CONTEXT_FEATURES.map(() => NA))];
      const o = this.net.predict(trend, macro, taNetMicro(set!.bars['15m'], t), taNetSwing(h1, i), ctxVec);
      const up60 = active.includes('up_1h') && !muted ? o.up1 : NA;
      const up240 = active.includes('up_4h') && !muted ? o.up4 : NA;
      const vol = active.includes('vol_4h') ? o.vol : NA;
      memo.set(ts, { up60, up240, raw60: o.up1, raw240: o.up4, vol, close: h1[i].c, pos: taNetPosition(o.up1, o.vol, fr.sig, p.strategy), pos4: taNetBarrierPosition(o.up4, o.vol, fr.sig, p.strategy), width: taNetBarrierWidth(o.vol, fr.sig), families: o.families });
    }
    this.grade(asset, h1, memo);
    this.forwardStep(asset, h1, memo, now);
    for (const m of [memo, feats]) for (const k of m.keys()) if (k < lastTs - 500 * H) m.delete(k);
    for (const k of days.keys()) if (k < lastTs - 400 * DAY_MS) days.delete(k);
    const cur = memo.get(lastTs)!;
    const br = this.briers.get(asset);
    const rb = this.rawBriers.get(asset);
    const skillOf = (h: TaNetHorizon, from = br) => { const b = from?.[h] ?? []; return b.length >= MIN_GRADED ? 1 - b.reduce((a, x) => a + x, 0) / b.length / 0.25 : NA; };
    const fs_ = this.forwardStatus(now);
    const out: TaNetOutput = {
      barTs: lastTs, up: { 60: cur.up60, 240: cur.up240 }, vol4h: cur.vol,
      skill: { 60: skillOf(60), 240: skillOf(240) }, graded: { 60: br?.[60].length ?? 0, 240: br?.[240].length ?? 0 },
      raw: { 60: cur.raw60, 240: cur.raw240 }, rawSkill: { 60: skillOf(60, rb), 240: skillOf(240, rb) }, rawGraded: { 60: rb?.[60].length ?? 0, 240: rb?.[240].length ?? 0 },
      validated: { 60: this.net.active(true).includes('up_1h') && !muted, 240: this.net.active(true).includes('up_4h') && !muted },
      version: this.net.version, families: cur.families, forward: fs_ ? { status: fs_.status, days: fs_.days } : undefined,
    };
    this.last.set(asset, { lastTs, len: h1.length, out });
    return out;
  }

  private grade(asset: string, h1: Candle[], memo: Map<number, Call>): void {
    const byTs = new Map(h1.map((c) => [c.ts, c.c]));
    let br = this.briers.get(asset), rb = this.rawBriers.get(asset), done = this.gradedTs.get(asset);
    if (!br) { br = { 60: [], 240: [] }; this.briers.set(asset, br); }
    if (!rb) { rb = { 60: [], 240: [] }; this.rawBriers.set(asset, rb); }
    if (!done) { done = { 60: new Set(), 240: new Set() }; this.gradedTs.set(asset, done); }
    for (const [t, call] of memo) {
      for (const h of TANET_HORIZONS) {
        if (done[h].has(t)) continue;
        const later = byTs.get(t + (h / 60) * H);
        if (later === undefined) continue;
        done[h].add(t);
        const y = later > call.close ? 1 : 0;
        const r = h === 60 ? call.raw60 : call.raw240;
        if (Number.isFinite(r)) { rb[h].push((r - y) ** 2); if (rb[h].length > ROLL) rb[h].shift(); }
        const p = h === 60 ? call.up60 : call.up240;
        if (!Number.isFinite(p)) continue;
        br[h].push((p - y) ** 2);
        if (br[h].length > ROLL) br[h].shift();
      }
    }
    for (const h of TANET_HORIZONS) for (const t of done[h]) if (!memo.has(t)) done[h].delete(t);
  }
}

// ---- Active network (shared by live features, replay, dataset and every trainer) -----------------

let active: { runtime?: TaNetRuntime; loadedFrom?: string; envChecked: boolean } = { envChecked: false };

/** Install (or remove) the network every feature computation reads. */
export function setTaNet(net: TaNet | undefined, requireValidated = process.env.TA_NET_REQUIRE_VALIDATED !== 'false'): void {
  active = { runtime: net ? new TaNetRuntime(net, requireValidated) : undefined, loadedFrom: undefined, envChecked: true };
}

/** The installed network; on first use, research processes load TA_NET_PATH if set. */
export function activeTaNet(): TaNetRuntime | undefined {
  if (!active.envChecked) {
    active.envChecked = true;
    const p = process.env.TA_NET_PATH;
    if (p && fs.existsSync(p)) {
      try { const n = TaNet.load(p); if (n) { setTaNet(n); active.loadedFrom = p; } } catch { /* unreadable: features stay NaN */ }
    }
  }
  return active.runtime;
}

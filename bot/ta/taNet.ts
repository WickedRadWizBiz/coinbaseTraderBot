// TA network ("tanet"): a neural network (trees and logistic regression compete with it in
// training) that reads the whole TA library - every indicator and structure reading on 1h, 4h and
// 1d spot USD candles, every rule's signal and every confluence score - and forecasts, at each
// closed hourly bar:
//
//   up_1h   P(close one hour later > close now)
//   up_4h   P(close four hours later > close now)
//   vol_4h  log(realised vol over the next 4 hours / realised vol of the last 24 hours)
//
// Trained offline on years of hourly history (research/trainTaNet.ts; Binance Vision, Coinbase,
// imported CSVs), walk-forward and blind: every graded forecast came from a model fitted only on
// earlier data. It reads no dominance charts (no history for them), so rules that need USDT.D /
// BTC.D stay silent, exactly as in training.
//
// Live, the same features are computed from the bot's Coinbase candles with the same windows as
// training (288 hourly bars, 4h built from them, 288 daily bars), and every forecast is graded
// against the candles that follow: tanet_skill_* is the rolling skill of its own recent calls.
// The outputs are features of the decision models (MLP, perps, vol forecast) that keep them only
// when their own validation improves.

import fs from 'fs';
import type { DenseLayer } from '../model/metaModel';
import { gbdtLogit, validateGbdt, type GbdtModel } from '../model/trees';
import { evaluate, TF_MS, tfState, type TaSnapshot, type TfState } from './analyzer';
import { aggregate, type CandleSet } from './candleStore';
import type { Candle } from './indicators';
import { CONFLUENCES, RULES, type Timeframe } from './knowledge';

/** Bump when a feature formula or window changes (old models are then refused). */
export const TANET_SCHEMA = '1';
/** Hourly bars per window. Coinbase returns 300 candles per request including the forming one, so the
 *  live store holds >= 299 closed bars from the first poll: 288 (12 days) is always available. */
export const TANET_H1_BARS = 288;
export const TANET_D1_BARS = 288;
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
function tfFeatures(p: string, s: TfState | undefined, out: Record<string, number>, opts: { sma200: boolean; vwap: boolean }): void {
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
}

const BASE_KEYS = ['rsi', 'rsi_chg', 'macd_atr', 'macd_chg_atr', 'macd_cross', 'adx', 'adx_chg', 'di', 'bb_pctb', 'bb_bw_rank', 'squeeze', 'squeeze_release', 'ema_stack', 'ema12_26', 'ema21_dist', 'ema50_dist', 'sma50_dist',
  'cloud', 'cloud_thick', 'cloud_future', 'tk_cross', 'tk_above', 'stoch', 'stoch_kd', 'stoch_cross', 'willr', 'obv_slope', 'cmf', 'mfi', 'vol_ratio', 'log_atr_pct', 'atr_rank', 'chg_atr', 'chg20_atr', 'donchian',
  'trend', 'bos', 'choch', 'sweep', 'breakout', 'eq_highs', 'eq_lows', 'div', 'hdiv', 'engulf', 'pin', 'doji', 'fvg_dist', 'in_fvg', 'vp_pos', 'vp_reentry', 'vp_node', 'round_dist', 'round_cross'];
function TF_KEYS(o: { sma200: boolean; vwap: boolean }): string[] {
  return [...BASE_KEYS, ...(o.sma200 ? ['sma200_dist', 'golden'] : []), ...(o.vwap ? ['vwap_dist'] : [])];
}
// 4h is built from the 288-bar hourly window (72 bars): no SMA200 there, live or in training.
const TF_OPTS: Array<[Timeframe, string, { sma200: boolean; vwap: boolean }]> = [['1h', 'h1', { sma200: true, vwap: true }], ['4h', 'h4', { sma200: false, vwap: false }], ['1d', 'd1', { sma200: true, vwap: false }]];

const KIND_OF = new Map(RULES.map((r) => [r.id, r.kind]));
const RULE_KINDS = ['trend', 'reversal', 'continuation', 'regime', 'volatility'] as const;

/** Every input of the network, in order. */
export const TANET_FEATURES: string[] = [
  ...TF_OPTS.flatMap(([, p, o]) => TF_KEYS(o).map((k) => `${p}_${k}`)),
  ...CONFLUENCES.map((c) => `conf_${c.id}`),
  ...RULE_KINDS.map((k) => `net_${k}`), 'net_all', 'n_signals',
  'ret_1h_z', 'ret_4h_z', 'ret_24h_z', 'ret_168h_z', 'log_sigma_1h', 'rv_24_168', 'rv_4_24', 'range_24h_pos',
  'hour_sin', 'hour_cos', 'dow_sin', 'dow_cos', 'weekend', 'missing_hours',
];

/** Reuses the 4h / 1d states between consecutive steps (they change every 4 / 24 bars). */
export interface TaNetStateCache { h4?: { key: string; s?: TfState }; d1?: { j: number; n: number; s?: TfState } }

/** States the network reads at the close of the last bar of `h1` (h1 = the 288-bar window). */
export function taNetStates(h1: Candle[], d1: Candle[] | undefined, t: number, cache?: TaNetStateCache): Partial<Record<Timeframe, TfState>> {
  const st: Partial<Record<Timeframe, TfState>> = {};
  const s1 = tfState('1h', h1);
  if (s1) st['1h'] = s1;
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

/** The feature map at the close of the last bar of `h1` (288 hourly bars), with daily bars `d1`. */
export function taNetFeatureMap(asset: string, h1: Candle[], d1: Candle[] | undefined, cache?: TaNetStateCache): Record<string, number> {
  const last = h1[h1.length - 1];
  const t = last.ts + H;
  const states = taNetStates(h1, d1, t, cache);
  const snap: TaSnapshot = evaluate(asset, states, t);
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
  for (const k of TANET_FEATURES) if (!(k in out)) out[k] = NA;
  return out;
}

export const taNetVector = (names: string[], m: Record<string, number>) => names.map((k) => fin(m[k]));

/** Whether a 288-bar hourly window is usable (no long outage inside). */
export function windowOk(h1: Candle[]): boolean {
  if (h1.length < TANET_H1_BARS) return false;
  return Math.round((h1[h1.length - 1].ts - h1[0].ts) / H) - (h1.length - 1) <= TANET_MAX_MISSING;
}

// ---- Model ---------------------------------------------------------------------------------------

export interface TaNetNorm { mean: number[]; std: number[] }

export type TaNetHead =
  | { kind: 'mlp'; layers: DenseLayer[]; norm: TaNetNorm }
  | { kind: 'gbdt'; model: GbdtModel }
  | { kind: 'constant'; value: number };

export interface TaNetHeadParams {
  head: TaNetHead;
  /** Platt scaling of the direction logit (fitted on validation forecasts). */
  cal?: { a: number; b: number };
  /** Walk-forward (blind) test results; `validated` = beats the naive forecast out of sample. */
  validation: {
    metric: 'logloss' | 'mse';
    rows: number;
    from: string; to: string;
    base: number; model: number;
    /** Day-block bootstrap of the per-row improvement (base - model). */
    improvement: { mean: number; lo: number; hi: number };
    /** Direction heads: 1 - Brier/0.25 and hit rate of the blind forecasts. */
    skill?: number; hitRate?: number;
    validated: boolean;
  };
  candidates: Array<{ kind: string; valLoss: number }>;
}

export interface TaNetParams {
  version: string;
  schema: string;
  features: string[];
  heads: Partial<Record<TaNetHeadName, TaNetHeadParams>>;
  data: { assets: string[]; from: string; to: string; rows: number; sources: Record<string, string[]> };
  trainedAt: string;
}

export function evalHead(h: TaNetHead, x: number[]): number {
  if (h.kind === 'constant') return h.value;
  if (h.kind === 'gbdt') return gbdtLogit(h.model, x);
  let v = x.map((val, j) => (Number.isFinite(val) ? (val - h.norm.mean[j]) / h.norm.std[j] : 0));
  for (const l of h.layers) {
    const o = new Array<number>(l.bias.length);
    for (let k = 0; k < l.bias.length; k++) {
      let s = l.bias[k];
      const w = l.weights[k];
      for (let j = 0; j < v.length; j++) s += w[j] * v[j];
      o[k] = l.activation === 'tanh' ? Math.tanh(s) : l.activation === 'relu' ? Math.max(0, s) : s;
    }
    v = o;
  }
  return v[0];
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export class TaNet {
  constructor(readonly params: TaNetParams) {}

  static load(file: string): TaNet | undefined {
    if (!fs.existsSync(file)) return undefined;
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as TaNetParams;
    if (p.schema !== TANET_SCHEMA) throw new Error(`TA network ${file} has schema ${p.schema}, this build needs ${TANET_SCHEMA} (retrain it)`);
    if (!Array.isArray(p.features) || !p.heads) throw new Error(`invalid TA network ${file}`);
    for (const h of Object.values(p.heads)) if (h?.head.kind === 'gbdt') validateGbdt(h.head.model, p.features.length);
    return new TaNet(p);
  }

  get version(): string { return this.params.version; }

  /** Heads allowed to speak: validated ones (or all when `requireValidated` is false). */
  active(requireValidated = true): TaNetHeadName[] {
    return TANET_HEADS.filter((k) => this.params.heads[k] && (!requireValidated || this.params.heads[k]!.validation.validated));
  }

  /** Raw head value for a feature map: probability for up_*, log vol ratio for vol_4h. */
  predict(head: TaNetHeadName, featureMap: Record<string, number>): number {
    const hp = this.params.heads[head];
    if (!hp) return NA;
    const z = evalHead(hp.head, taNetVector(this.params.features, featureMap));
    if (head === 'vol_4h') return clip(z, 3);
    return sigmoid(hp.cal ? hp.cal.a * z + hp.cal.b : z);
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
  version: string;
}

interface Call { up60: number; up240: number; vol: number; close: number }

const ROLL = 168;
const MIN_GRADED = 24;

/** Per-asset forecasts from a CandleSet, memoised per closed hourly bar and graded as later bars close. */
export class TaNetRuntime {
  private readonly calls = new Map<string, Map<number, Call>>();
  private readonly briers = new Map<string, Record<TaNetHorizon, number[]>>();
  private readonly gradedTs = new Map<string, Record<TaNetHorizon, Set<number>>>();
  /** Latest output per asset, reused until a new hourly bar arrives (features are read per contract). */
  private readonly last = new Map<string, { lastTs: number; len: number; out: TaNetOutput }>();

  constructor(readonly net: TaNet, readonly requireValidated = true) {}

  /** Forecast at the last closed hourly bar of `set` (undefined when stale or history too short). */
  outputFor(asset: string, set: CandleSet | undefined, now: number): TaNetOutput | undefined {
    const h1 = set?.bars['1h'];
    if (!h1 || h1.length < TANET_H1_BARS) return undefined;
    const lastTs = h1[h1.length - 1].ts;
    if (now - (lastTs + H) > 3 * H || lastTs + H > now) return undefined;
    const prev = this.last.get(asset);
    if (prev && prev.lastTs === lastTs && prev.len === h1.length) return prev.out;
    // Time went backwards (a research process replaying another span): start this asset afresh,
    // so the rolling skill only ever contains calls graded before `now`, exactly as live.
    if (prev && lastTs < prev.lastTs) { this.calls.delete(asset); this.briers.delete(asset); this.gradedTs.delete(asset); }
    let memo = this.calls.get(asset);
    if (!memo) { memo = new Map(); this.calls.set(asset, memo); }
    const active = this.net.active(this.requireValidated);
    // Forecast every bar whose full window is in the store and that has no forecast yet.
    for (let i = TANET_H1_BARS - 1; i < h1.length; i++) {
      if (memo.has(h1[i].ts)) continue;
      const w = h1.slice(i - TANET_H1_BARS + 1, i + 1);
      if (!windowOk(w)) { memo.set(h1[i].ts, { up60: NA, up240: NA, vol: NA, close: h1[i].c }); continue; }
      const f = taNetFeatureMap(asset, w, set!.bars['1d']);
      memo.set(h1[i].ts, {
        up60: active.includes('up_1h') ? this.net.predict('up_1h', f) : NA,
        up240: active.includes('up_4h') ? this.net.predict('up_4h', f) : NA,
        vol: active.includes('vol_4h') ? this.net.predict('vol_4h', f) : NA,
        close: h1[i].c,
      });
    }
    this.grade(asset, h1, memo);
    for (const t of memo.keys()) if (t < lastTs - 500 * H) memo.delete(t);
    const cur = memo.get(lastTs)!;
    const br = this.briers.get(asset);
    const skillOf = (h: TaNetHorizon) => { const b = br?.[h] ?? []; return b.length >= MIN_GRADED ? 1 - b.reduce((a, x) => a + x, 0) / b.length / 0.25 : NA; };
    const out: TaNetOutput = {
      barTs: lastTs,
      up: { 60: cur.up60, 240: cur.up240 },
      vol4h: cur.vol,
      skill: { 60: skillOf(60), 240: skillOf(240) },
      graded: { 60: br?.[60].length ?? 0, 240: br?.[240].length ?? 0 },
      version: this.net.version,
    };
    this.last.set(asset, { lastTs, len: h1.length, out });
    return out;
  }

  private grade(asset: string, h1: Candle[], memo: Map<number, Call>): void {
    const byTs = new Map(h1.map((c) => [c.ts, c.c]));
    let br = this.briers.get(asset), done = this.gradedTs.get(asset);
    if (!br) { br = { 60: [], 240: [] }; this.briers.set(asset, br); }
    if (!done) { done = { 60: new Set(), 240: new Set() }; this.gradedTs.set(asset, done); }
    for (const [t, call] of memo) {
      for (const h of TANET_HORIZONS) {
        if (done[h].has(t)) continue;
        const later = byTs.get(t + (h / 60) * H);
        if (later === undefined) continue;
        done[h].add(t);
        const p = h === 60 ? call.up60 : call.up240;
        if (!Number.isFinite(p)) continue;
        const y = later > call.close ? 1 : 0;
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

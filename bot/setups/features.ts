// Model inputs for one setup: everything a chart reader weighs before taking it.
//
//   - the whole TA library on 15m / 1h / 4h / daily (bot/ta/analyzer.ts states, scale-free as in the
//     TA network), and the knowledge base's confluences and rule tallies
//   - the same readings for BTC (the market leader) on 15m / 1h
//   - the market clock: session, first 30 / 60 minutes of the US open, the 11:00 ET window, the last
//     30 minutes, holidays, London / Tokyo opens, the CME break (bot/model/sessions.ts)
//   - the setup itself: lane, kind, timeframe, side, risk in ATRs, targets in R, and its trigger
//     readings (RSI, %B, taker flow, band width, volume)
//   - every directional reading again multiplied by the trade's side ("o_" prefix), so "RSI high" and
//     "RSI high against my short" are both visible to the model.
//   - the TA network's forecasts at the last closed hour (P(up 1h), P(up 4h), the 4h volatility
//     forecast), the "tanet" group: in research they come from its walk-forward export
//     (research/taNetOos.ts), live from the same walking network. The trainer keeps the group only if
//     it improves the development years; otherwise these inputs are blanked (NaN) for the model.
//   - the coin's market character at the setup (calm / trending / volatile coin-specific / volatile
//     market-wide, and its inputs: bot/ta/character.ts), the "character" group, kept on the same terms.
//   - where the 2018-to-now BTC dominance cycle stands on its 2016-2017 parent (bot/macro/fractalEngine.ts:
//     progress, the parent's phase, time dilation, fit, the projected BTC.D path and the next waterfall) and
//     the waterfall legs (BTC.D against the 55% gate, a USDT.D breakdown, SHIB volume velocity), the "fractal"
//     group, kept on the same terms. Blank before the child cycle has a year (2019) or without the parent.
//   - the Librarian's reading at the last closed hour (bot/ta/librarian.ts: each strategy family's weight, the
//     continuous playbook position and its disagreement with the rule tally, P(regime change within 72 h)), the
//     "librarian" group: in research from its walk-forward export (research/librarian.ts), live from the same model.
//     Kept on the same terms.
//   - the cross-asset graph network's forecast for the coin at the last closed hour (bot/ta/crossGraph.ts: its relative
//     return over the next 4 and 24 hours against the basket, and its rank), the "xgraph" group, kept on the same terms.
// The states come from bot/ta/taNet.ts taNetStates on the same windows live and in research.

import { evaluate } from '../ta/analyzer';
import { CONFLUENCES } from '../ta/knowledge';
import type { Candle } from '../ta/indicators';
import { closedIndex, KIND_OF, RULE_KINDS, taNetStates, TANET_D1_BARS, TANET_H1_BARS, TF_KEYS, TF_OPTS, tfFeatures } from '../ta/taNet';
import { marketClockFeatures, MARKET_CLOCK_FEATURES } from '../model/sessions';
import type { SetupSignal } from './detectors';
import type { Character, CharacterInputs } from '../ta/character';
import { TF_MS } from './detectors';
import type { MacroInputs } from '../macro/macroSeries';
import { LIB_SETUP_KEYS, libSetupFeatures, type LibrarianReading } from '../ta/librarian';
import { XG_SETUP_KEYS, xgSetupFeatures, type XgReading } from '../ta/crossGraph';

const clip = (x: number, lim: number) => (Number.isFinite(x) ? Math.max(-lim, Math.min(lim, x)) : NaN);

const TA_KEYS = [
  ...TF_OPTS.flatMap(([, p, o]) => TF_KEYS(o).map((k) => `${p}_${k}`)),
  ...CONFLUENCES.map((c) => `conf_${c.id}`),
  ...RULE_KINDS.map((k) => `net_${k}`), 'net_all',
];
const BTC_TFS = TF_OPTS.filter(([tf]) => tf === '1h' || tf === '15m');
const BTC_KEYS = BTC_TFS.flatMap(([, p, o]) => TF_KEYS(o).map((k) => `btc_${p}_${k}`));
const SETUP_KEYS = [
  'dir', 'lane_slow', 'kind_fade', 'kind_pullback', 'kind_burst', 'kind_breakout', 'kind_dip', 'tf_15m', 'tf_1h', 'tf_1d',
  'risk_atr', 'log_risk_pct', 't1_r', 't2_r', 'trig_rsi', 'trig_pctb', 'trig_flow', 'trig_bw', 'trig_vol',
];

/** Inputs computed from the candles (cached per setup in research). */
export const SETUP_BASE_FEATURES: string[] = [...SETUP_KEYS, ...MARKET_CLOCK_FEATURES, ...TA_KEYS, ...BTC_KEYS, ...TA_KEYS.map((k) => `o_${k}`), ...BTC_KEYS.map((k) => `o_${k}`)];
/** The TA network's forecasts (side-oriented copies: P(up) - 0.5 times the trade's side). */
export const TANET_SETUP_KEYS = ['tn_up1', 'tn_up4', 'tn_vol', 'o_tn_up1', 'o_tn_up4'];
/** The coin's market character at the setup (bot/ta/character.ts): class one-hot and its inputs. */
export const CHAR_SETUP_KEYS = ['ch_calm', 'ch_trending', 'ch_vol_idio', 'ch_vol_sys', 'ch_rvpct', 'ch_corr', 'ch_hurst', 'ch_er'];
/** The Fractal Alignment Engine and the waterfall legs (bot/macro): fractalFeatures. */
export const FRACTAL_SETUP_KEYS = [
  'fae_progress', 'fae_base', 'fae_fall', 'fae_waterfall', 'fae_swing_frac', 'fae_log_dil', 'fae_log_ldil', 'fae_fit', 'fae_recent_fit', 'fae_mae',
  'fae_proj30', 'fae_proj90', 'fae_wf_weeks', 'fae_alt', 'o_fae_proj90', 'mac_gate', 'mac_usdt_brk', 'mac_shib_vel',
];
/** Optional input groups the trainer switches on only when they help (off = blanked to NaN). */
export const SETUP_GROUPS: Record<string, string[]> = { tanet: TANET_SETUP_KEYS, character: CHAR_SETUP_KEYS, fractal: FRACTAL_SETUP_KEYS, librarian: LIB_SETUP_KEYS, xgraph: XG_SETUP_KEYS };
/** Every input, in order (groups appended last, so models trained before a group existed still load). */
/** The spot pullback's kind flag (kept outside the cached candle inputs, so adding the kind did not invalidate them). */
export const SPOT_PB_SETUP_KEYS = ['kind_spotpb'];
export const SETUP_FEATURES: string[] = [...SETUP_BASE_FEATURES, ...TANET_SETUP_KEYS, ...CHAR_SETUP_KEYS, ...FRACTAL_SETUP_KEYS, ...LIB_SETUP_KEYS, ...XG_SETUP_KEYS, ...SPOT_PB_SETUP_KEYS];

/** Fill the fractal inputs: the engine's state and the waterfall legs (NaN when unknown). For an altcoin a falling
 *  BTC.D is the tailwind, for BTC the reverse, so the oriented copy flips with the asset. */
export function fractalFeatures(out: Record<string, number>, asset: string, dir: number, m: MacroInputs | undefined): void {
  for (const k of FRACTAL_SETUP_KEYS) out[k] = NaN;
  const f = m?.fractal, w = m?.wf;
  const alt = asset !== 'BTC' ? 1 : 0;
  if (f) {
    out.fae_progress = f.progress;
    out.fae_base = f.swing.base ? 1 : 0;
    out.fae_fall = f.swing.dir < 0 ? 1 : 0;
    out.fae_waterfall = f.swing.waterfall && !f.swing.base ? 1 : 0;
    out.fae_swing_frac = f.swing.frac;
    out.fae_log_dil = Math.log(Math.max(0.1, f.dilation));
    out.fae_log_ldil = Math.log(Math.max(0.1, f.localDilation));
    out.fae_fit = f.fit.r;
    out.fae_recent_fit = f.fit.recentR;
    out.fae_mae = clip(f.fit.recentMaePts / 10, 10);
    out.fae_proj30 = clip((f.proj.d30 - f.btcd) / 10, 10);
    out.fae_proj90 = clip((f.proj.d90 - f.btcd) / 10, 10);
    out.fae_wf_weeks = f.nextWaterfall ? (f.nextWaterfall.inside ? 0 : Math.min(156, f.nextWaterfall.weeksAway) / 52) : NaN;
    out.fae_alt = alt;
    out.o_fae_proj90 = Number.isFinite(out.fae_proj90) ? dir * out.fae_proj90 * (alt ? -1 : 1) : NaN;
  }
  if (w) {
    out.mac_gate = w.btcd !== undefined && m ? clip((w.btcd - m.gate) / 10, 10) : NaN;
    out.mac_usdt_brk = w.why.some((x) => x.startsWith('usdt: under')) ? NaN : w.legs.usdt ? 1 : 0;
    out.mac_shib_vel = w.shibVelocity !== undefined && w.shibVelocity > 0 ? clip(Math.log(w.shibVelocity), 5) : NaN;
  }
}

/** Fill the character inputs of a feature map (NaN when unknown). */
export function characterFeatures(out: Record<string, number>, ch: { cls: Character; x: CharacterInputs } | undefined): void {
  const one = (c: Character) => (ch ? (ch.cls === c ? 1 : 0) : NaN);
  out.ch_calm = one('calm'); out.ch_trending = one('trending'); out.ch_vol_idio = one('volatile_idio'); out.ch_vol_sys = one('volatile_systemic');
  out.ch_rvpct = ch?.x.rvPct ?? NaN; out.ch_corr = ch?.x.corr ?? NaN; out.ch_hurst = ch?.x.hurst ?? NaN; out.ch_er = ch?.x.er ?? NaN;
}

/** TA network forecast at a setup (P(up 1h), P(up 4h), 4h vol log ratio). */
export interface TaNetReading { up1: number; up4: number; vol: number }

/** Fill the TA network inputs of a feature map (NaN when no forecast). */
export function tanetFeatures(out: Record<string, number>, dir: number, r: TaNetReading | undefined): void {
  out.tn_up1 = r && Number.isFinite(r.up1) ? r.up1 - 0.5 : NaN;
  out.tn_up4 = r && Number.isFinite(r.up4) ? r.up4 - 0.5 : NaN;
  out.tn_vol = r && Number.isFinite(r.vol) ? r.vol : NaN;
  out.o_tn_up1 = dir * out.tn_up1;
  out.o_tn_up4 = dir * out.tn_up4;
}

/** Indices of the inputs of the groups NOT enabled (blanked before scoring / training). */
export function maskedIndices(enabled: string[] | undefined): number[] {
  const off = Object.entries(SETUP_GROUPS).filter(([g]) => !(enabled ?? []).includes(g)).flatMap(([, ks]) => ks);
  return off.map((k) => SETUP_FEATURES.indexOf(k)).filter((i) => i >= 0);
}

/** Blank the inputs at `idx` (a copy). */
export function applyMask<T extends ArrayLike<number>>(x: T, idx: number[]): number[] {
  const v = Array.from(x);
  for (const i of idx) v[i] = NaN;
  return v;
}

/** Candles an asset's features read, as of the setup's close time `t` (only closed bars are used). */
export interface SetupBars { m15?: Candle[]; h1: Candle[]; d1?: Candle[] }

/** Hourly window closed by t (the TA network's window length). */
export function h1Window(h1: Candle[], t: number): Candle[] {
  const j = closedIndex(h1, 3_600_000, t);
  return j < 0 ? [] : h1.slice(Math.max(0, j - TANET_H1_BARS + 1), j + 1);
}

/** Daily bars closed by t, the last TANET_D1_BARS + 10 of them (taNetStates reads 250). */
function d1Upto(d1: Candle[] | undefined, t: number): Candle[] | undefined {
  if (!d1) return undefined;
  const j = closedIndex(d1, 86_400_000, t);
  return j < 0 ? [] : d1.slice(Math.max(0, j - TANET_D1_BARS - 10), j + 1);
}

function taMap(prefix: string, bars: SetupBars, t: number, out: Record<string, number>, tfs = TF_OPTS, withConf = true): void {
  const h1 = h1Window(bars.h1, t);
  const states = h1.length >= 30 ? taNetStates(h1, d1Upto(bars.d1, t), t, undefined, bars.m15) : {};
  for (const [tf, p, o] of tfs) tfFeatures(`${prefix}${p}`, states[tf], out, o);
  if (!withConf) return;
  const snap = evaluate('', states, t);
  for (const c of CONFLUENCES) out[`conf_${c.id}`] = snap.confluences.find((x) => x.id === c.id)?.score ?? 0;
  for (const k of RULE_KINDS) out[`net_${k}`] = clip(snap.signals.filter((x) => KIND_OF.get(x.id) === k).reduce((a, x) => a + (k === 'regime' || k === 'volatility' ? (x.dir === 0 ? x.strength : x.dir * x.strength) : x.dir * x.strength), 0), 30);
  out.net_all = clip(snap.net, 60);
}

/** Feature vector of a setup known at time `t` (= signal bar close), from the asset's and BTC's bars. */
export function setupFeatureMap(sig: SetupSignal, bars: SetupBars, btc: SetupBars | undefined, t = sig.ts + TF_MS[sig.tf]!, tanet?: TaNetReading, character?: { cls: Character; x: CharacterInputs }, macro?: MacroInputs, lib?: Pick<LibrarianReading, 'w' | 'net' | 'vsBook' | 'transition'>, xg?: Pick<XgReading, 'rel4' | 'rel24' | 'rank'>): Record<string, number> {
  const out: Record<string, number> = {};
  const risk = Math.abs(sig.ref - sig.stop);
  out.dir = sig.dir;
  out.lane_slow = sig.lane === 'slow' ? 1 : 0;
  for (const k of ['fade', 'pullback', 'burst', 'breakout', 'dip']) out[`kind_${k}`] = sig.kind === k ? 1 : 0;
  for (const k of ['15m', '1h', '1d']) out[`tf_${k}`] = sig.tf === k ? 1 : 0;
  out.risk_atr = sig.atr > 0 ? clip(risk / sig.atr, 20) : NaN;
  out.log_risk_pct = risk > 0 && sig.ref > 0 ? Math.log(risk / sig.ref) : NaN;
  out.t1_r = sig.plan.target1 !== undefined && risk > 0 ? clip((sig.dir * (sig.plan.target1 - sig.ref)) / risk, 20) : NaN;
  out.t2_r = sig.plan.target2 !== undefined && risk > 0 ? clip((sig.dir * (sig.plan.target2 - sig.ref)) / risk, 20) : NaN;
  out.trig_rsi = (sig.info.rsi - 50) / 50;
  out.trig_pctb = clip(sig.info.pctB - 0.5, 3);
  out.trig_flow = Number.isFinite(sig.info.flow) ? 2 * sig.info.flow - 1 : NaN;
  out.trig_bw = sig.info.bandwidth > 0 ? Math.log(sig.info.bandwidth) : NaN;
  out.trig_vol = sig.info.volRatio > 0 ? clip(Math.log(sig.info.volRatio), 5) : NaN;
  Object.assign(out, marketClockFeatures(t));
  taMap('', bars, t, out);
  if (btc) taMap('btc_', btc, t, out, BTC_TFS, false);
  for (const k of [...TA_KEYS, ...BTC_KEYS]) out[`o_${k}`] = Number.isFinite(out[k]) ? sig.dir * out[k] : NaN;
  tanetFeatures(out, sig.dir, tanet);
  characterFeatures(out, character);
  fractalFeatures(out, sig.asset, sig.dir, macro);
  libSetupFeatures(out, sig.dir, lib);
  xgSetupFeatures(out, sig.dir, xg);
  out.kind_spotpb = sig.kind === 'spotpb' ? 1 : 0;
  return out;
}

export const setupVector = (m: Record<string, number>, names: string[] = SETUP_FEATURES): number[] => names.map((k) => (Number.isFinite(m[k]) ? m[k] : NaN));

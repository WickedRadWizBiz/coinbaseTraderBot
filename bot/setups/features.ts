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
// The states come from bot/ta/taNet.ts taNetStates on the same windows live and in research.

import { evaluate } from '../ta/analyzer';
import { CONFLUENCES } from '../ta/knowledge';
import type { Candle } from '../ta/indicators';
import { KIND_OF, RULE_KINDS, taNetStates, TANET_H1_BARS, TF_KEYS, TF_OPTS, tfFeatures } from '../ta/taNet';
import { marketClockFeatures, MARKET_CLOCK_FEATURES } from '../model/sessions';
import type { SetupSignal } from './detectors';
import { TF_MS } from './detectors';

const clip = (x: number, lim: number) => (Number.isFinite(x) ? Math.max(-lim, Math.min(lim, x)) : NaN);

const TA_KEYS = [
  ...TF_OPTS.flatMap(([, p, o]) => TF_KEYS(o).map((k) => `${p}_${k}`)),
  ...CONFLUENCES.map((c) => `conf_${c.id}`),
  ...RULE_KINDS.map((k) => `net_${k}`), 'net_all',
];
const BTC_TFS = TF_OPTS.filter(([tf]) => tf === '1h' || tf === '15m');
const BTC_KEYS = BTC_TFS.flatMap(([, p, o]) => TF_KEYS(o).map((k) => `btc_${p}_${k}`));
const SETUP_KEYS = [
  'dir', 'lane_slow', 'kind_fade', 'kind_pullback', 'kind_breakout', 'kind_dip', 'tf_15m', 'tf_1h', 'tf_1d',
  'risk_atr', 'log_risk_pct', 't1_r', 't2_r', 'trig_rsi', 'trig_pctb', 'trig_flow', 'trig_bw', 'trig_vol',
];

/** Every input, in order. */
export const SETUP_FEATURES: string[] = [...SETUP_KEYS, ...MARKET_CLOCK_FEATURES, ...TA_KEYS, ...BTC_KEYS, ...TA_KEYS.map((k) => `o_${k}`), ...BTC_KEYS.map((k) => `o_${k}`)];

/** Candles an asset's features read, as of the setup's close time `t` (only closed bars are used). */
export interface SetupBars { m15?: Candle[]; h1: Candle[]; d1?: Candle[] }

/** Hourly window closed by t (the TA network's window length). */
export function h1Window(h1: Candle[], t: number): Candle[] {
  let j = h1.length - 1;
  while (j >= 0 && h1[j].ts + 3_600_000 > t) j--;
  return j < 0 ? [] : h1.slice(Math.max(0, j - TANET_H1_BARS + 1), j + 1);
}

function taMap(prefix: string, bars: SetupBars, t: number, out: Record<string, number>, tfs = TF_OPTS, withConf = true): void {
  const h1 = h1Window(bars.h1, t);
  const states = h1.length >= 30 ? taNetStates(h1, bars.d1, t, undefined, bars.m15) : {};
  for (const [tf, p, o] of tfs) tfFeatures(`${prefix}${p}`, states[tf], out, o);
  if (!withConf) return;
  const snap = evaluate('', states, t);
  for (const c of CONFLUENCES) out[`conf_${c.id}`] = snap.confluences.find((x) => x.id === c.id)?.score ?? 0;
  for (const k of RULE_KINDS) out[`net_${k}`] = clip(snap.signals.filter((x) => KIND_OF.get(x.id) === k).reduce((a, x) => a + (k === 'regime' || k === 'volatility' ? (x.dir === 0 ? x.strength : x.dir * x.strength) : x.dir * x.strength), 0), 30);
  out.net_all = clip(snap.net, 60);
}

/** Feature vector of a setup known at time `t` (= signal bar close), from the asset's and BTC's bars. */
export function setupFeatureMap(sig: SetupSignal, bars: SetupBars, btc: SetupBars | undefined, t = sig.ts + TF_MS[sig.tf]!): Record<string, number> {
  const out: Record<string, number> = {};
  const risk = Math.abs(sig.ref - sig.stop);
  out.dir = sig.dir;
  out.lane_slow = sig.lane === 'slow' ? 1 : 0;
  for (const k of ['fade', 'pullback', 'breakout', 'dip']) out[`kind_${k}`] = sig.kind === k ? 1 : 0;
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
  return out;
}

export const setupVector = (m: Record<string, number>): number[] => SETUP_FEATURES.map((k) => (Number.isFinite(m[k]) ? m[k] : NaN));

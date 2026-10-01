// Stage 3 signal: expected perp return over the holding horizon, in basis points.
//
// Two sources:
//  - PerpModel: a frozen linear (ridge) model on standardized features, trained and validated
//    offline by research/trainPerpModel.ts and research/perpBacktest.ts (walk-forward, out-of-
//    sample information coefficient CI, net-of-cost P&L CI, deflated Sharpe). Loaded from
//    params/perp_model.json. Only a model whose validation passed trades at full size.
//  - Prior: time-series momentum (Moskowitz, Ooi & Pedersen 2012; crypto: Liu & Tsyvinski 2021,
//    Shen, Urquhart & Wang 2022). mu = IC x sigma_H x clip(4h return z, -2, 2) with a small,
//    configurable IC. It exists so the bot can trade LIVE at pilot size before a model has
//    validated; with realistic costs it trades rarely, which is the honest outcome.
//
// Features are computed by the same FeatureHub registry the binary model uses (identical in live
// and research), from a context built around the perp's asset.

import fs from 'fs';
import type { IndexTracker } from '../marketdata/indexTracker';
import { assetFeatureMap, type BarStore, type SnnContext } from '../model/featureEngine';
import type { CandleSet } from '../ta/candleStore';
import type { PerpState } from './perpData';

/** Candidate inputs for the perp model: returns/volatility, perp premium/funding/OI, macro, TA. */
export const PERP_FEATURES = [
  'ret_15m_z', 'ret_1h_z', 'ret_4h_z', 'efficiency_ratio_1h', 'log_rv_1h', 'vol_ratio_15m_4h',
  'perp_premium_bps', 'perp_premium_chg_5m', 'perp_ret_diff_5m_z', 'funding_rate_bps', 'min_to_funding', 'perp_oi_chg_1h',
  'usdtd_ret_15m_z', 'btcd_rel_5m_z',
  'ta_rsi_1h', 'ta_rsi_4h', 'ta_macd_hist_1h', 'ta_di_diff_1h', 'ta_adx_1h', 'ta_ema_stack_1h', 'ta_ema_stack_4h', 'ta_bb_pctb_1h',
  'ta_cmf_1h', 'ta_price_ma50_4h', 'ta_cloud_4h', 'ta_structure_1h', 'ta_vwap_dist_1h', 'ta_obv_slope_4h',
  'taconf_trend_alignment', 'taconf_mtf_momentum', 'taconf_net_trend', 'taconf_net_reversal',
  // SNN direction calls over the perp horizons (1 h and 4 h).
  'snn_up_1h', 'snn_up_4h',
];

export interface PerpFeatureSources {
  index?: IndexTracker;
  spot?: IndexTracker;
  bars?: BarStore;
  candles?: CandleSet;
  usdtd?: IndexTracker;
  btcd?: IndexTracker;
  perp?: PerpState;
  /** SNN direction calls for this asset (P(up) and expected move per horizon). */
  snn?: SnnContext;
}


/** Feature values for one asset at `now` (NaN where data is missing). */
export function perpFeatures(asset: string, now: number, s: PerpFeatureSources): Record<string, number> {
  if (!s.index) return Object.fromEntries(PERP_FEATURES.map((n) => [n, NaN]));
  const all = assetFeatureMap(asset, now, s);
  return Object.fromEntries(PERP_FEATURES.map((n) => [n, all[n] ?? NaN]));
}

export interface PerpModelValidation {
  passed: boolean;
  /** Effective (non-overlapping) out-of-sample observations. */
  nEff: number;
  ic: number;
  icCiLo: number;
  pnlBpsPerTrade: number;
  pnlCiLo: number;
  dsrProbability: number;
  trials: number;
  notes?: string[];
  /** Execution-realistic replay (research/perpBacktest.ts --annotate). */
  backtest?: { ok: boolean; pnlUsd: number; pnlCiLo: number; dsrProbability: number; trades: number; days: number; fees: number; funding: number };
}

export interface PerpModelParams {
  version: string;
  kind: 'linear';
  horizonMin: number;
  features: string[];
  mean: number[];
  std: number[];
  weights: number[];
  bias: number;
  residStdBps: number;
  lambda: number;
  trainedAt: string;
  validation?: PerpModelValidation;
}

export class PerpModel {
  constructor(readonly params: PerpModelParams) {}

  static load(path: string): PerpModel | undefined {
    try {
      if (!fs.existsSync(path)) return undefined;
      const p = JSON.parse(fs.readFileSync(path, 'utf8')) as PerpModelParams;
      if (p.kind !== 'linear' || p.features.length !== p.weights.length) return undefined;
      return new PerpModel(p);
    } catch {
      return undefined;
    }
  }

  /** Full-size trading needs the offline validation AND the execution backtest to pass. */
  validated(): boolean {
    const v = this.params.validation;
    return Boolean(v?.passed && v.backtest?.ok);
  }

  blockers(): string[] {
    const v = this.params.validation;
    if (!v) return ['perp model has no validation report'];
    const out: string[] = [];
    if (!v.passed) out.push(`walk-forward validation failed (IC CI low ${v.icCiLo.toFixed(3)}, net P&L CI low ${v.pnlCiLo.toFixed(2)} bps, DSR ${v.dsrProbability.toFixed(2)})`);
    if (!v.backtest) out.push('no execution backtest (run research:perp-backtest --annotate)');
    else if (!v.backtest.ok) out.push(`execution backtest failed (P&L CI low $${v.backtest.pnlCiLo.toFixed(2)}, DSR ${v.backtest.dsrProbability.toFixed(2)})`);
    return out;
  }

  /** Expected return over the horizon (bps) and residual std (bps). */
  predict(f: Record<string, number>): { muBps: number; sigmaBps: number } {
    const p = this.params;
    let mu = p.bias;
    p.features.forEach((name, i) => {
      const x = f[name];
      const z = Number.isFinite(x) && p.std[i] > 0 ? (x - p.mean[i]) / p.std[i] : 0; // missing -> training mean
      mu += p.weights[i] * Math.max(-5, Math.min(5, z));
    });
    const cap = 3 * p.residStdBps;
    return { muBps: Math.max(-cap, Math.min(cap, mu)), sigmaBps: p.residStdBps };
  }
}

/** Time-series-momentum prior (see header). Undefined without enough history. */
export function priorMuBps(f: Record<string, number>, sigmaHBps: number, ic: number): number | undefined {
  const z = f.ret_4h_z;
  if (!Number.isFinite(z) || !(sigmaHBps > 0)) return undefined;
  return ic * sigmaHBps * Math.max(-2, Math.min(2, z));
}

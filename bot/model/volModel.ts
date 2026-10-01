// Tree-based volatility forecast for fair value. The pricer's sigma is a backward-looking EWMA of
// 1 s log returns (5-minute half-life) - it lags vol regime shifts, jumps, macro releases and
// weekend lulls. This model forecasts how far the realised volatility over the contract's remaining
// life will differ from that EWMA:
//
//     target = log(sigma_realised[now, now + tau] / sigma_ewma(now))
//
// from the asset-level vol / session / return / perp features (bot/model/featureEngine.ts) plus the
// horizon itself. Gradient-boosted trees with squared loss (research/gbdt.ts), missing inputs
// routed by learned default directions. Live:
//
//     sigma_pricing = sigma_ewma (x seasonal factor) x clamp(exp(pred), 0.5, 2)
//
// Trained and validated by research/trainVolModel.ts (QLIKE on held-out days, day-block bootstrap);
// fair value applies it only when validated and VOL_MODEL=true.

import fs from 'fs';
import { gbdtLogit, validateGbdt, type GbdtModel } from './trees';
import { zoneTime } from './sessions';

/** Asset-level features (assetFeatureMap names) the forecast reads, plus the extras below. */
export const VOL_MODEL_ASSET_FEATURES = [
  'log_rv_15m', 'log_rv_1h', 'log_rv_4h', 'ewma_vol_ratio', 'vol_ratio_15m_4h', 'jump_ratio_1h', 'jump_count_4h', 'garman_klass_15m',
  'ret_5m_z', 'ret_15m_z', 'ret_1h_z', 'efficiency_ratio_15m', 'efficiency_ratio_1h', 'variance_ratio_1m_15m',
  'sess_weekend', 'sess_min_to_transition', 'us_open_window', 'hour_sin', 'hour_cos',
  'perp_premium_bps', 'funding_rate_bps', 'perp_oi_chg_1h',
] as const;
export const VOL_MODEL_EXTRAS = ['log_sigma_ewma', 'log_tau_min', 'ny_min_sin', 'ny_min_cos'] as const;
export const VOL_MODEL_FEATURES = [...VOL_MODEL_ASSET_FEATURES, ...VOL_MODEL_EXTRAS];

export const VOL_MULT_MIN = 0.5;
export const VOL_MULT_MAX = 2;

export interface VolModelParams {
  version: string;
  features: string[];
  gbdt: GbdtModel;
  /** Horizons (minutes) it was trained on; predictions outside are clamped into this range. */
  tauMin: [number, number];
  validation: {
    rows: number; holdoutRows: number; holdoutDays: number;
    /** Mean QLIKE of the variance forecast over the remaining life: EWMA alone vs EWMA x model. */
    qlikeEwma: number; qlikeModel: number;
    /** Day-block bootstrap of the per-row improvement (ewma - model). */
    improvement: { mean: number; lo: number; hi: number };
    validated: boolean;
  };
  trainedAt: string;
}

/** Extra (non-catalog) inputs of the forecast. */
export function volExtras(now: number, sigmaEwma: number, tauSec: number): Record<string, number> {
  const ny = zoneTime(now, 'America/New_York').minutes;
  return {
    log_sigma_ewma: sigmaEwma > 0 ? Math.log(sigmaEwma) : NaN,
    log_tau_min: Math.log(Math.max(1, tauSec / 60)),
    ny_min_sin: Math.sin((2 * Math.PI * ny) / 1440),
    ny_min_cos: Math.cos((2 * Math.PI * ny) / 1440),
  };
}

export class VolModel {
  constructor(readonly params: VolModelParams) {}

  static load(file: string): VolModel | undefined {
    if (!fs.existsSync(file)) return undefined;
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as VolModelParams;
    if (!Array.isArray(p.features) || !p.gbdt?.trees) throw new Error(`invalid vol model ${file}`);
    validateGbdt(p.gbdt, p.features.length);
    return new VolModel(p);
  }

  get validated(): boolean { return Boolean(this.params.validation?.validated); }

  /** Sigma multiplier for the remaining life `tauSec` (1 when the inputs are unusable). */
  multiplier(assetFeatures: Record<string, number>, now: number, sigmaEwma: number, tauSec: number): number {
    const [lo, hi] = this.params.tauMin;
    const tau = Math.min(hi * 60, Math.max(lo * 60, tauSec));
    const f = { ...assetFeatures, ...volExtras(now, sigmaEwma, tau) };
    const x = this.params.features.map((k) => (Number.isFinite(f[k]) ? f[k] : NaN));
    const z = gbdtLogit(this.params.gbdt, x);
    return Number.isFinite(z) ? Math.min(VOL_MULT_MAX, Math.max(VOL_MULT_MIN, Math.exp(z))) : 1;
  }
}

/** QLIKE loss of a variance forecast F for realised variance R (lower is better; 0 when F = R). */
export function qlike(R: number, F: number): number {
  const q = R / F;
  return q - Math.log(q) - 1;
}

/** Live / replay helper: the multiplier for (asset, now, tau), recomputing the asset-level features
 *  at most every `everyMs` per asset (they move on the minute scale). Unvalidated models return 1. */
export class VolForecaster {
  private readonly cache = new Map<string, { ts: number; f: Record<string, number> }>();
  constructor(public model: VolModel | undefined, private readonly everyMs = 5000) {}

  multiplier(asset: string, now: number, sigmaEwma: number, tauSec: number, assetFeatures: () => Record<string, number>): number {
    const m = this.model;
    if (!m?.validated) return 1;
    let c = this.cache.get(asset);
    if (!c || now - c.ts >= this.everyMs || now < c.ts) { c = { ts: now, f: assetFeatures() }; this.cache.set(asset, c); }
    return m.multiplier(c.f, now, sigmaEwma, tauSec);
  }

  setModel(m: VolModel | undefined): void { this.model = m; this.cache.clear(); }
}

// Feature vector for the meta-model. Shared verbatim by production and
// research so training and inference cannot drift apart.

import { clamp, logit } from '../util/num';

export const FEATURE_NAMES = [
  'logit_fv',        // digital-option fair value (log-odds)
  'logit_mid',       // market mid (log-odds)
  'fv_minus_mid',    // disagreement with the market
  'sqrt_tau_min',    // sqrt(minutes to close)
  'log_vol_ratio',   // log(sigma / reference sigma) — vol regime
  'spread',          // YES ask - YES bid
  'imbalance',       // top-of-book depth imbalance [-1, 1]
  'in_window',       // 1 if inside the settlement averaging window
] as const;

export type FeatureName = typeof FEATURE_NAMES[number];

export interface FeatureInput {
  fairValue: number;
  mid: number;
  tauSec: number;
  sigmaPerSqrtSec: number;
  referenceSigma: number;
  spread: number;
  imbalance: number;
  inWindow: boolean;
}

export function buildFeatures(f: FeatureInput): number[] {
  return [
    logit(f.fairValue),
    logit(f.mid),
    f.fairValue - f.mid,
    Math.sqrt(Math.max(0, f.tauSec) / 60),
    Math.log(Math.max(1e-12, f.sigmaPerSqrtSec) / Math.max(1e-12, f.referenceSigma)),
    clamp(f.spread, 0, 1),
    clamp(f.imbalance, -1, 1),
    f.inWindow ? 1 : 0,
  ];
}

// Meta-model: a small, frozen neural network that refines the digital-option
// fair value into a calibrated probability using market context.
//
// This replaces the old online tfjs "meta-learning"/"plasticity" engines,
// which retrained live on pre-fee win/loss labels and could not be validated.
// Rules now:
//  - Trained offline only (research/trainMetaModel.ts) on fee-independent
//    labels (did the market settle YES?), with purged walk-forward validation.
//  - Loaded read-only at startup from a versioned JSON file; never mutated at
//    runtime. The file's SHA-256 is stamped on every decision and order.
//  - Carries its own validation report. Live trading refuses a model whose
//    report does not pass the go-live gates (Brier better than market mid,
//    calibration within tolerance, enough independent windows).
//  - `kind: "identity"` passes the fair value through unchanged. That is the
//    default until a trained model earns its place.

import crypto from 'crypto';
import fs from 'fs';
import { FEATURE_NAMES } from './features';
import { clamp, sigmoid } from '../util/num';

export type Activation = 'tanh' | 'relu' | 'linear';

export interface DenseLayer {
  /** weights[out][in] */
  weights: number[][];
  bias: number[];
  activation: Activation;
}

export interface ValidationReport {
  passed: boolean;
  nWindows: number;
  brierModel: number;
  brierMarket: number;
  brierFairValue?: number;
  maxCalibrationErrorPp: number;
  /** Fee-inclusive net edge per contract, 95% CI lower bound (backtest). */
  netEdgeCiLow?: number;
  deflatedSharpe?: number;
  variantsTried?: number;
  evaluatedAt: string;
  notes?: string;
}

export interface MetaModelParams {
  version: string;
  kind: 'identity' | 'mlp';
  features: string[];
  normalization?: { mean: number[]; std: number[] };
  layers?: DenseLayer[];
  /** If set, the raw (unnormalized) value of this feature index is added to the
   * network's output logit, so the network learns a residual correction on top
   * of the fair value and L2 regularization shrinks it back to the fair value. */
  residualFeature?: number;
  /** Platt scaling on the output logit: p = sigmoid(a * z + b). */
  calibration?: { a: number; b: number };
  /** Reference sigma for the vol-regime feature. */
  referenceSigma: number;
  training?: Record<string, unknown>;
  validation?: ValidationReport;
}

export const GO_LIVE_GATES = {
  minWindows: 1000,
  maxCalibrationErrorPp: 3,
};

export class MetaModel {
  readonly hash: string;

  private constructor(readonly params: MetaModelParams, raw: string) {
    this.hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  static identity(referenceSigma = 5e-5): MetaModel {
    const p: MetaModelParams = { version: 'identity', kind: 'identity', features: [...FEATURE_NAMES], referenceSigma };
    return new MetaModel(p, JSON.stringify(p));
  }

  static fromJson(raw: string): MetaModel {
    const p = JSON.parse(raw) as MetaModelParams;
    validateParams(p);
    return new MetaModel(Object.freeze(p) as MetaModelParams, raw);
  }

  static load(file: string): MetaModel {
    return MetaModel.fromJson(fs.readFileSync(file, 'utf8'));
  }

  get id(): string {
    return `${this.params.version}@${this.hash}`;
  }

  /** Why this model may not be used for live trading, or [] if it may. */
  liveBlockers(): string[] {
    const v = this.params.validation;
    const out: string[] = [];
    if (!v) return ['model has no validation report'];
    if (!v.passed) out.push('validation.passed is false');
    if (v.nWindows < GO_LIVE_GATES.minWindows) out.push(`only ${v.nWindows} validation windows (< ${GO_LIVE_GATES.minWindows})`);
    if (!(v.brierModel < v.brierMarket)) out.push(`Brier ${v.brierModel} does not beat market ${v.brierMarket}`);
    if (v.maxCalibrationErrorPp > GO_LIVE_GATES.maxCalibrationErrorPp) out.push(`calibration error ${v.maxCalibrationErrorPp}pp > ${GO_LIVE_GATES.maxCalibrationErrorPp}pp`);
    if (v.netEdgeCiLow === undefined) out.push('no fee-inclusive backtest result (run research:backtest --annotate)');
    else if (!(v.netEdgeCiLow > 0)) out.push(`net edge CI lower bound ${v.netEdgeCiLow} <= 0`);
    if (v.deflatedSharpe === undefined) out.push('no deflated Sharpe result');
    else if (!(v.deflatedSharpe > 0)) out.push(`deflated Sharpe ${v.deflatedSharpe} <= 0`);
    return out;
  }

  /** Probability that YES settles, given the feature vector. */
  predict(features: number[], fairValue: number): number {
    const p = this.params;
    if (p.kind === 'identity') return fairValue;
    if (features.length !== p.features.length) throw new Error(`feature length ${features.length} != ${p.features.length}`);
    let x = features.map((v, i) => (v - p.normalization!.mean[i]) / p.normalization!.std[i]);
    for (const layer of p.layers!) x = forward(layer, x);
    const z = x[0] + (p.residualFeature !== undefined ? features[p.residualFeature] : 0);
    const cal = p.calibration ?? { a: 1, b: 0 };
    return clamp(sigmoid(cal.a * z + cal.b), 1e-4, 1 - 1e-4);
  }
}

export function forward(layer: DenseLayer, x: number[]): number[] {
  const out = new Array(layer.bias.length);
  for (let o = 0; o < layer.bias.length; o++) {
    let s = layer.bias[o];
    const w = layer.weights[o];
    for (let i = 0; i < x.length; i++) s += w[i] * x[i];
    out[o] = layer.activation === 'tanh' ? Math.tanh(s) : layer.activation === 'relu' ? Math.max(0, s) : s;
  }
  return out;
}

function validateParams(p: MetaModelParams): void {
  if (!p || typeof p.version !== 'string') throw new Error('model params missing version');
  if (!(p.referenceSigma > 0)) throw new Error('model params missing referenceSigma');
  if (p.kind === 'identity') return;
  if (p.kind !== 'mlp') throw new Error(`unknown model kind ${p.kind}`);
  const names = [...FEATURE_NAMES];
  if (JSON.stringify(p.features) !== JSON.stringify(names)) {
    throw new Error(`model features ${JSON.stringify(p.features)} do not match code ${JSON.stringify(names)}`);
  }
  const n = names.length;
  if (!p.normalization || p.normalization.mean.length !== n || p.normalization.std.length !== n) throw new Error('bad normalization');
  if (p.normalization.std.some((s) => !(s > 0))) throw new Error('normalization std must be > 0');
  if (!p.layers?.length) throw new Error('mlp has no layers');
  let width = n;
  for (const [i, l] of p.layers.entries()) {
    if (l.weights.length !== l.bias.length) throw new Error(`layer ${i}: weights/bias mismatch`);
    for (const row of l.weights) {
      if (row.length !== width) throw new Error(`layer ${i}: expected input width ${width}`);
      if (row.some((w) => !Number.isFinite(w))) throw new Error(`layer ${i}: non-finite weight`);
    }
    width = l.bias.length;
  }
  if (width !== 1) throw new Error('mlp must output a single logit');
  if (p.residualFeature !== undefined && !(Number.isInteger(p.residualFeature) && p.residualFeature >= 0 && p.residualFeature < n)) {
    throw new Error('residualFeature out of range');
  }
}

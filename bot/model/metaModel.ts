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
import { FEATURES, vectorFor } from './featureEngine';
import { FEATURE_NAMES } from './features';
import { applyBeta, type BetaCal } from './calibration';
import { gbdtLogit, validateGbdt, type GbdtModel } from './trees';
import { clamp, logit, sigmoid } from '../util/num';

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
  /** Holdout log loss of the model and of the beta-calibrated market mid (primary benchmark). */
  logLossModel?: number;
  logLossMarketCal?: number;
  /** Diebold-Mariano one-sided p-value, per-window log loss, model vs calibrated market. */
  dmPValue?: number;
  /** Largest calibration error beyond sampling noise across price and time-to-close slices (pp). */
  maxExcessCalibrationPp?: number;
  /** Deflated Sharpe probability (PSR against the expected max Sharpe of all variants tried). */
  dsrProbability?: number;
  /** Probability of backtest overfitting across the variants compared. */
  pbo?: number;
  /** Hunt mode (confluence ratchet with the order-book trailing stop) vs the fair-value exit, from
   * research:backtest --annotate. huntOk gates live use; `hunt` holds the winning parameters. */
  exitEvaluation?: {
    huntOk: boolean;
    windows: number;
    pairedDiffMean: number;
    pairedDiffCiLo: number;
    dsrProbability: number;
    hunt: { targetMargin: number; minConfluence: number; minFillRatio: number; minWallAgeMs: number; slippageTicks: number };
    [k: string]: unknown;
  };
  /** Fee-inclusive net edge per contract, 95% CI lower bound (backtest). */
  netEdgeCiLow?: number;
  deflatedSharpe?: number;
  variantsTried?: number;
  evaluatedAt: string;
  notes?: string;
}

/** One additional ensemble member (same kind and features as the primary). */
export interface EnsembleMember {
  normalization?: { mean: number[]; std: number[] };
  layers?: DenseLayer[];
  gbdt?: GbdtModel;
}

export interface MetaModelParams {
  version: string;
  kind: 'identity' | 'mlp' | 'gbdt';
  /** Gradient-boosted trees (kind 'gbdt'); logit = baseScore + sum(trees) + residual. */
  gbdt?: GbdtModel;
  /** Extra members (seeds/bootstraps). Prediction averages member logits; their spread is the uncertainty. */
  ensemble?: EnsembleMember[];
  /** Beta calibration of the output probability (applied instead of Platt when present). */
  betaCalibration?: BetaCal;
  /** Beta calibration of the market mid: p_mkt_cal, the market corrected for its own favourite-longshot bias. */
  marketCalibration?: BetaCal;
  /** Student-t degrees of freedom for the pricer's tails (fitted offline); omitted = Gaussian. */
  tNu?: number;
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
  /** Relaxed spec: calibration error < 1.5c in every price and time-to-close bucket (beyond sampling noise). */
  maxExcessCalibrationPp: 1.5,
  /** Log loss must beat the calibrated market with Diebold-Mariano p below this. */
  maxDmPValue: 0.05,
  minDsrProbability: 0.95,
  maxPbo: 0.2,
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
    if (v.logLossModel === undefined || v.logLossMarketCal === undefined) out.push('no log-loss comparison against the calibrated market');
    else if (!(v.logLossModel < v.logLossMarketCal)) out.push(`log loss ${v.logLossModel} does not beat calibrated market ${v.logLossMarketCal}`);
    if (v.dmPValue === undefined) out.push('no Diebold-Mariano test vs the calibrated market');
    else if (!(v.dmPValue < GO_LIVE_GATES.maxDmPValue)) out.push(`Diebold-Mariano p ${v.dmPValue} >= ${GO_LIVE_GATES.maxDmPValue}`);
    if (v.maxExcessCalibrationPp !== undefined && v.maxExcessCalibrationPp > GO_LIVE_GATES.maxExcessCalibrationPp) out.push(`calibration slice error ${v.maxExcessCalibrationPp}pp beyond noise > ${GO_LIVE_GATES.maxExcessCalibrationPp}pp`);
    if (v.dsrProbability === undefined) out.push('no deflated Sharpe probability (run research:backtest --annotate)');
    else if (!(v.dsrProbability > GO_LIVE_GATES.minDsrProbability)) out.push(`deflated Sharpe probability ${v.dsrProbability} <= ${GO_LIVE_GATES.minDsrProbability}`);
    if (v.pbo !== undefined && !(v.pbo < GO_LIVE_GATES.maxPbo)) out.push(`PBO ${v.pbo} >= ${GO_LIVE_GATES.maxPbo}`);
    return out;
  }

  /** Hunt-mode parameters validated by the backtest, when hunt mode beat the fair-value exit. */
  validatedHunt(): NonNullable<ValidationReport['exitEvaluation']>['hunt'] | undefined {
    const e = this.params.validation?.exitEvaluation;
    return e?.huntOk ? e.hunt : undefined;
  }

  /** p_mkt_cal: the market mid corrected by the fitted market calibration (identity if none). */
  marketProbability(mid: number): number {
    const c = this.params.marketCalibration;
    return clamp(c ? applyBeta(mid, c) : mid, 1e-4, 1 - 1e-4);
  }

  /** Probability that YES settles, given the named feature map. Missing
   * features (NaN) are imputed as the training mean (normalized 0). */
  predict(featureMap: Record<string, number>, fairValue: number): number {
    return this.predictDetailed(featureMap, fairValue).p;
  }

  /** Probability plus ensemble uncertainty (std of member probabilities) when the model has members. */
  predictDetailed(featureMap: Record<string, number>, fairValue: number): { p: number; std?: number } {
    const p = this.params;
    if (p.kind === 'identity') return { p: fairValue };
    const features = vectorFor(p.features, featureMap);
    const resid = p.residualFeature !== undefined && Number.isFinite(features[p.residualFeature]) ? features[p.residualFeature] : 0;
    const members: EnsembleMember[] = [{ normalization: p.normalization, layers: p.layers, gbdt: p.gbdt }, ...(p.ensemble ?? [])];
    const logits = members.map((m) => memberLogit(p.kind, m, features) + resid);
    const z = logits.reduce((a, b) => a + b, 0) / logits.length;
    const out = (zz: number) => {
      if (p.betaCalibration) return clamp(applyBeta(sigmoid(zz), p.betaCalibration), 1e-4, 1 - 1e-4);
      const cal = p.calibration ?? { a: 1, b: 0 };
      return clamp(sigmoid(cal.a * zz + cal.b), 1e-4, 1 - 1e-4);
    };
    if (logits.length < 2) return { p: out(z) };
    const ps = logits.map(out);
    const mp = ps.reduce((a, b) => a + b, 0) / ps.length;
    const std = Math.sqrt(ps.reduce((a, b) => a + (b - mp) ** 2, 0) / (ps.length - 1));
    return { p: out(z), std };
  }
}

function memberLogit(kind: MetaModelParams['kind'], m: EnsembleMember, features: number[]): number {
  if (kind === 'gbdt') return gbdtLogit(m.gbdt!, features);
  let x = features.map((v, i) => (Number.isFinite(v) ? (v - m.normalization!.mean[i]) / m.normalization!.std[i] : 0));
  for (const layer of m.layers!) x = forward(layer, x);
  return x[0];
}

export interface Driver {
  feature: string;
  value: number;
  /** Change in log-odds of P(YES) attributable to this feature vs its training mean. */
  logitContribution: number;
}

export interface Explanation {
  /** logit(model P) - logit(fair value): how far the model moved off the physics price. */
  shiftFromFairValue: number;
  drivers: Driver[];
}

/** Occlusion attribution: replace one feature at a time with its training mean. */
export function explain(model: MetaModel, featureMap: Record<string, number>, fairValue: number, top = 6): Explanation {
  const p = model.predict(featureMap, fairValue);
  const shift = logit(p) - logit(fairValue);
  if (model.params.kind === 'identity') return { shiftFromFairValue: 0, drivers: [] };
  const drivers: Driver[] = [];
  for (const f of model.params.features) {
    if (f === 'logit_fv') continue;
    const v = featureMap[f];
    if (!Number.isFinite(v)) continue;
    const q = model.predict({ ...featureMap, [f]: NaN }, fairValue);
    drivers.push({ feature: f, value: v, logitContribution: logit(p) - logit(q) });
  }
  drivers.sort((a, b) => Math.abs(b.logitContribution) - Math.abs(a.logitContribution));
  return { shiftFromFairValue: shift, drivers: drivers.slice(0, top) };
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
  if (p.tNu !== undefined && !(p.tNu > 2)) throw new Error('tNu must be > 2');
  for (const c of [p.marketCalibration, p.betaCalibration]) if (c && ![c.a, c.b, c.c].every(Number.isFinite)) throw new Error('bad beta calibration');
  if (p.kind === 'identity') return;
  if (p.kind !== 'mlp' && p.kind !== 'gbdt') throw new Error(`unknown model kind ${p.kind}`);
  if (!Array.isArray(p.features) || !p.features.length) throw new Error('model features missing');
  const unknown = p.features.filter((f) => !(f in FEATURES));
  if (unknown.length) throw new Error(`model features not in registry: ${unknown.join(', ')}`);
  if (new Set(p.features).size !== p.features.length) throw new Error('duplicate model features');
  const n = p.features.length;
  const members: EnsembleMember[] = [{ normalization: p.normalization, layers: p.layers, gbdt: p.gbdt }, ...(p.ensemble ?? [])];
  for (const [mi, m] of members.entries()) {
    if (p.kind === 'gbdt') {
      if (!m.gbdt) throw new Error(`member ${mi}: gbdt missing`);
      validateGbdt(m.gbdt, n);
      continue;
    }
    if (!m.normalization || m.normalization.mean.length !== n || m.normalization.std.length !== n) throw new Error('bad normalization');
    if (m.normalization.std.some((s) => !(s > 0))) throw new Error('normalization std must be > 0');
    if (!m.layers?.length) throw new Error('mlp has no layers');
    let width = n;
    for (const [i, l] of m.layers.entries()) {
      if (l.weights.length !== l.bias.length) throw new Error(`layer ${i}: weights/bias mismatch`);
      for (const row of l.weights) {
        if (row.length !== width) throw new Error(`layer ${i}: expected input width ${width}`);
        if (row.some((w) => !Number.isFinite(w))) throw new Error(`layer ${i}: non-finite weight`);
      }
      width = l.bias.length;
    }
    if (width !== 1) throw new Error('mlp must output a single logit');
  }
  if (p.residualFeature !== undefined && !(Number.isInteger(p.residualFeature) && p.residualFeature >= 0 && p.residualFeature < n)) {
    throw new Error('residualFeature out of range');
  }
}

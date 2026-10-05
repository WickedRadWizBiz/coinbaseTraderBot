// The setup scorer: a gradient-boosted model per lane predicting a setup's net result in R (after
// costs), trained walk-forward by research/trainSetupModel.ts. The setup picks the side; the model
// decides whether it is worth taking and how big (meta-labeling). A lane without enough history for
// its own model scores every setup at its historical average (rule-only).

import fs from 'fs';
import { gbdtLogit, validateGbdt, type GbdtModel } from '../model/trees';
import type { Lane } from './detectors';
import type { CostModel } from './exits';
import type { LaneBookParams } from './lanes';
import { applyMask, maskedIndices, SETUP_FEATURES } from './features';
import { taEngine } from '../ta/talib';

export const SETUP_SCHEMA = '5';

/** One lane's scorer: a model predicting net R, and the distribution of its predictions on held-out
 *  trades (101 quantiles). The score is the prediction's percentile in that distribution (0..1), so a
 *  threshold like 0.9 means "the model's top 10%" whatever the scale of its raw output (an early-stopped
 *  model with few trees predicts close to the lane average, which made absolute thresholds fall silent).
 *  Without a model every setup scores 1 when the lane's average result is positive, else 0. */
export interface LaneScorer { model?: GbdtModel; meanR: number; trades: number; quantiles?: number[] }

export function rawPrediction(l: LaneScorer, x: ArrayLike<number>): number {
  return l.model ? l.meanR + gbdtLogit({ ...l.model, baseScore: 0 }, Array.from(x)) : l.meanR;
}

export function laneScore(l: LaneScorer, x: ArrayLike<number>): number {
  if (!l.model || !l.quantiles?.length) return l.meanR > 0 ? 1 : 0;
  const v = rawPrediction(l, x), q = l.quantiles;
  if (!Number.isFinite(v)) return NaN;
  if (v <= q[0]) return 0;
  if (v >= q[q.length - 1]) return 1;
  let lo = 0, hi = q.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (q[m] <= v) lo = m; else hi = m; }
  const f = q[hi] > q[lo] ? (v - q[lo]) / (q[hi] - q[lo]) : 0;
  return (lo + f) / (q.length - 1);
}

/** 101 quantiles of a set of predictions. */
export function quantilesOf(xs: number[]): number[] {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return [];
  return Array.from({ length: 101 }, (_, i) => s[Math.min(s.length - 1, Math.round((i / 100) * (s.length - 1)))]);
}

export interface LaneValidation {
  /** Out-of-sample lane backtest per period (walk-forward scores, the lane book, costs). */
  periods: Record<'development' | 'holdout' | 'final', LanePeriodStats>;
  /** Thresholds tried when choosing minScore (trials for the deflated Sharpe). */
  trials: number;
  /** Holdout: mean net R > 0 with its bootstrap 5% lower bound > 0, and the final window net > 0. */
  passed: boolean;
  reasons: string[];
}

export interface LanePeriodStats {
  from: string; to: string; days: number;
  trades: number; tradesPerDay: number; winRate: number; avgR: number; avgRet: number; profitFactor: number;
  netUsd: number; usdPerDay: number; maxDrawdownUsd: number; sharpe: number;
  /** Bootstrap 90% interval of the mean net R per trade. */
  avgRLo: number; avgRHi: number;
  byKind: Record<string, { trades: number; avgR: number; winRate: number }>;
}

export interface SetupModelParams {
  version: string;
  schema: string;
  features: string[];
  /** Optional input groups the model uses (bot/setups/features.ts SETUP_GROUPS); the others are blanked. */
  groups?: string[];
  /** Development-years comparison behind the group choice (information). */
  groupChoice?: Record<string, { withGroup: number; without: number; kept: boolean }>;
  /** Indicator engine the inputs were computed with ('talib' or 'builtin'). */
  taEngine?: string;
  /** VOL_ADAPT.trailK the events were simulated with (the trail scaling by the TA network's vol forecast). */
  volTrailK?: number;
  lanes: Partial<Record<Lane, LaneScorer>>;
  book: LaneBookParams;
  costs: CostModel;
  /** Equity the dollar figures in the validation assume. */
  equityUsd: number;
  validation: Partial<Record<Lane, LaneValidation>>;
  trainedAt: string;
  data: { assets: string[]; from: string; to: string; holdoutFrom: string; finalFrom: string; events: number };
}

export class SetupModel {
  private readonly mask: number[];
  /** Position in the code's feature vector of each model input (models trained before a feature was added still load). */
  private readonly order: number[] | undefined;
  constructor(readonly params: SetupModelParams) {
    this.mask = maskedIndices(params.groups);
    const same = params.features.length === SETUP_FEATURES.length && params.features.every((k, i) => k === SETUP_FEATURES[i]);
    this.order = same ? undefined : params.features.map((k) => SETUP_FEATURES.indexOf(k));
  }

  /** Masked inputs in the model's own feature order. */
  private input(x: number[]): number[] {
    const v = applyMask(x, this.mask);
    return this.order ? this.order.map((i) => v[i]) : v;
  }

  static load(file: string): SetupModel | undefined {
    if (!fs.existsSync(file)) return undefined;
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as SetupModelParams;
    if (p.schema !== SETUP_SCHEMA) throw new Error(`setup model schema ${p.schema}, code expects ${SETUP_SCHEMA}: retrain (research:setups)`);
    const missing = p.features.filter((k) => !SETUP_FEATURES.includes(k));
    if (missing.length) throw new Error(`setup model uses features the code no longer computes (${missing.slice(0, 5).join(', ')}): retrain (research:setups)`);
    for (const l of Object.values(p.lanes)) if (l?.model) validateGbdt(l.model, p.features.length);
    if (p.taEngine && p.taEngine !== taEngine()) console.warn(`[setups] ${file} was trained with the ${p.taEngine} indicator engine but ${taEngine()} is active (install TA-Lib: npm ci)`);
    return new SetupModel(p);
  }

  /** Percentile score of a setup in its lane (0..1; x = setupVector). */
  score(lane: Lane, x: number[]): number {
    const l = this.params.lanes[lane];
    return l ? laneScore(l, this.input(x)) : NaN;
  }

  /** The model's raw expected net R (for the record). */
  expectedR(lane: Lane, x: number[]): number {
    const l = this.params.lanes[lane];
    return l ? rawPrediction(l, this.input(x)) : NaN;
  }

  /** Whether an input group (e.g. 'tanet') is used. */
  uses(group: string): boolean { return Boolean(this.params.groups?.includes(group)); }

  validated(lane: Lane): boolean { return Boolean(this.params.validation[lane]?.passed); }
  blockers(lane: Lane): string[] { const v = this.params.validation[lane]; return v ? (v.passed ? [] : v.reasons) : [`no ${lane} lane in the model`]; }
}

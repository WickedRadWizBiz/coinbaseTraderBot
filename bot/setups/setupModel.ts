// The setup scorer: a gradient-boosted model per lane predicting a setup's net result in R (after
// costs), trained walk-forward by research/trainSetupModel.ts. The setup picks the side; the model
// decides whether it is worth taking and how big (meta-labeling). A lane without enough history for
// its own model scores every setup at its historical average (rule-only).

import fs from 'fs';
import { gbdtLogit, validateGbdt, type GbdtModel } from '../model/trees';
import type { Lane } from './detectors';
import type { CostModel } from './exits';
import type { LaneBookParams } from './lanes';
import { SETUP_FEATURES } from './features';

export const SETUP_SCHEMA = '1';

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
  lanes: Partial<Record<Lane, { model?: GbdtModel; meanR: number; trades: number }>>;
  book: LaneBookParams;
  costs: CostModel;
  /** Equity the dollar figures in the validation assume. */
  equityUsd: number;
  validation: Partial<Record<Lane, LaneValidation>>;
  trainedAt: string;
  data: { assets: string[]; from: string; to: string; holdoutFrom: string; finalFrom: string; events: number };
}

export class SetupModel {
  constructor(readonly params: SetupModelParams) {}

  static load(file: string): SetupModel | undefined {
    if (!fs.existsSync(file)) return undefined;
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as SetupModelParams;
    if (p.schema !== SETUP_SCHEMA) throw new Error(`setup model schema ${p.schema}, code expects ${SETUP_SCHEMA}: retrain (research:setups)`);
    if (p.features.length !== SETUP_FEATURES.length || p.features.some((k, i) => k !== SETUP_FEATURES[i])) throw new Error('setup model features differ from the code: retrain (research:setups)');
    for (const l of Object.values(p.lanes)) if (l?.model) validateGbdt(l.model, p.features.length);
    return new SetupModel(p);
  }

  /** Expected net R of a setup in a lane (x = setupVector). */
  score(lane: Lane, x: number[]): number {
    const l = this.params.lanes[lane];
    if (!l) return NaN;
    return l.model ? l.meanR + gbdtLogit({ ...l.model, baseScore: 0 }, x) : l.meanR;
  }

  validated(lane: Lane): boolean { return Boolean(this.params.validation[lane]?.passed); }
  blockers(lane: Lane): string[] { const v = this.params.validation[lane]; return v ? (v.passed ? [] : v.reasons) : [`no ${lane} lane in the model`]; }
}

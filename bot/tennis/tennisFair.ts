// Tennis MLP: fair P(player A wins) from the same information the tennis SNN column reads (the four
// confluence signals with magnitudes, the live score, progress, the score model, the book) plus the
// SNN's own P(A) and direction call. A residual network on the market's log-odds: with no evidence
// it returns the market. Trained by research/trainTennisModel.ts on recorded matches; it gates
// tennis entries only once validated (Brier beats the market on held-out matches).

import fs from 'fs';
import type { DenseLayer } from '../model/metaModel';

export const TENNIS_FAIR_FEATURES = [
  'logit_pA', 'spread', 'momentum', 'flow', 'depth', 'crossMarket', 'confluence',
  'setDiff', 'gameDiff', 'pointDiff', 'serverA', 'tiebreak', 'breakDiff', 'progress', 'logit_modelPA',
  'logit_snn_p', 'logit_snn_up',
] as const;

export interface TennisFairParams {
  version: string;
  features: string[];
  normalization: { mean: number[]; std: number[] };
  layers: DenseLayer[];
  /** Index of logit_pA, added raw to the output (residual on the market). */
  residual: number;
  validation: { matches: number; holdoutMatches: number; brierModel: number; brierMarket: number; validated: boolean };
  trainedAt: string;
}

const lg = (p: number | undefined) => (p === undefined || !Number.isFinite(p) ? NaN : Math.log(Math.min(0.99, Math.max(0.01, p)) / (1 - Math.min(0.99, Math.max(0.01, p)))));

/** Feature vector from tennis column values (bot/snn/inputs.ts tennisValues) and the SNN outputs. */
export function tennisFairInputs(v: Record<string, number | undefined>, snn?: { p?: number; up?: number }): Record<string, number> {
  const n = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? NaN : x);
  return {
    logit_pA: lg(v.mid), spread: n(v.spread), momentum: n(v.momentum), flow: n(v.flow), depth: n(v.depth), crossMarket: n(v.crossMarket), confluence: n(v.confluence),
    setDiff: n(v.setDiff), gameDiff: n(v.gameDiff), pointDiff: n(v.pointDiff), serverA: n(v.serverA), tiebreak: n(v.tiebreak), breakDiff: n(v.breakDiff),
    progress: n(v.progress), logit_modelPA: lg(v.modelPA), logit_snn_p: lg(snn?.p), logit_snn_up: lg(snn?.up),
  };
}

function forward(layer: DenseLayer, x: number[]): number[] {
  const out = layer.bias.slice();
  for (let i = 0; i < out.length; i++) { let v = out[i]; for (let j = 0; j < x.length; j++) v += layer.weights[i][j] * x[j]; out[i] = v; }
  return layer.activation === 'tanh' ? out.map(Math.tanh) : layer.activation === 'relu' ? out.map((v) => Math.max(0, v)) : out;
}

export class TennisFairModel {
  constructor(readonly params: TennisFairParams) {}

  static load(file: string): TennisFairModel | undefined {
    if (!fs.existsSync(file)) return undefined;
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as TennisFairParams;
    if (!Array.isArray(p.features) || !p.layers?.length || p.normalization?.mean.length !== p.features.length) throw new Error(`invalid tennis model ${file}`);
    return new TennisFairModel(p);
  }

  get validated(): boolean { return Boolean(this.params.validation?.validated); }

  /** Fair P(A wins); NaN when the market price (the residual anchor) is missing. */
  predict(f: Record<string, number>): number {
    const p = this.params;
    const x = p.features.map((k) => f[k]);
    const anchor = x[p.residual];
    if (!Number.isFinite(anchor)) return NaN;
    let h = x.map((v, i) => (Number.isFinite(v) ? (v - p.normalization.mean[i]) / p.normalization.std[i] : 0));
    for (const l of p.layers) h = forward(l, h);
    const z = h[0] + anchor;
    return 1 / (1 + Math.exp(-z));
  }
}

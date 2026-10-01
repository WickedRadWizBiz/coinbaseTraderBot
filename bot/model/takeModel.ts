// The MLP's "should we take this trade" head (meta-labeling, Lopez de Prado). The fair-value MLP
// says what the contract is worth; for every trade that edge would place, this second, small model
// estimates the probability that the trade WINS, using the same information plus the SNN's
// direction call and fair-value bias oriented to the trade's side. A trade is taken only when that
// probability clears the side's break-even (price + fee) by `margin`.
//
// It is trained out-of-fold in research:train (the fair-value model's OOF predictions decide the
// would-be trades, so no trade is labelled by a model that saw its outcome) and only gates live
// orders once its own held-out check showed it beats the fair-value probability alone.

import { takerFee } from '../fees';
import type { DenseLayer } from './metaModel';
import type { OrderPlan } from '../strategy/fairValueStrategy';

export const TAKE_FEATURES = ['edge', 'logit_p_side', 'price_side', 'spread', 'tau_min', 'snn_up_side', 'snn_bias_side', 'snn_agree_side', 'p_std'] as const;

export interface TakeModelParams {
  features: string[];
  normalization: { mean: number[]; std: number[] };
  layers: DenseLayer[];
  /** Held-out check (last 30% of OOF trade windows): log loss of P(win) vs the fair-value probability. */
  validation: { trades: number; windows: number; logLossBase: number; logLossTake: number; validated: boolean };
}

const lg = (p: number) => { const q = Math.min(1 - 1e-4, Math.max(1e-4, p)); return Math.log(q / (1 - q)); };

/** Inputs for a trade on `side` at side price `price` (YES price for 'yes', NO price for 'no'). */
export function takeInputs(side: 'yes' | 'no', pYes: number, price: number, spread: number, tauSec: number, f: Record<string, number>, pStd?: number): number[] {
  const s = side === 'yes' ? 1 : -1;
  const pSide = side === 'yes' ? pYes : 1 - pYes;
  const up = f.snn_up_h, bias = f.snn_bias;
  return [
    pSide - price - takerFee(1, price),
    lg(pSide),
    price,
    spread,
    tauSec / 60,
    Number.isFinite(up) ? s * up : NaN,
    Number.isFinite(bias) ? s * bias : NaN,
    Number.isFinite(up) ? s * Math.sign(up) : NaN,
    pStd ?? NaN,
  ];
}

function forward(layer: DenseLayer, x: number[]): number[] {
  const out = layer.bias.slice();
  for (let i = 0; i < out.length; i++) { let v = out[i]; for (let j = 0; j < x.length; j++) v += layer.weights[i][j] * x[j]; out[i] = v; }
  return layer.activation === 'tanh' ? out.map(Math.tanh) : layer.activation === 'relu' ? out.map((v) => Math.max(0, v)) : out;
}

/** P(trade wins). Missing inputs are imputed as the training mean. */
export function takeProbability(p: TakeModelParams, x: number[]): number {
  let h = x.map((v, i) => (Number.isFinite(v) ? (v - p.normalization.mean[i]) / p.normalization.std[i] : 0));
  for (const l of p.layers) h = forward(l, h);
  return 1 / (1 + Math.exp(-h[0]));
}

export interface TakeGateCtx { pYes: number; features: Record<string, number>; tauSec: number; bid: number; ask: number; pStd?: number; margin: number }

/** Drop entry orders the take model says to skip. Exits and reduce-only orders always pass. */
export function applyTakeGate(plan: { place: OrderPlan[]; notes: string[] }, take: TakeModelParams | undefined, c: TakeGateCtx): number {
  if (!take?.validation.validated) return 0;
  let skipped = 0;
  plan.place = plan.place.filter((o) => {
    if (o.reduceOnly || o.purpose === 'exit') return true;
    const side = o.side === 'bid' ? 'yes' : 'no';
    const price = side === 'yes' ? o.price : 1 - o.price;
    const q = takeProbability(take, takeInputs(side, c.pYes, price, c.ask - c.bid, c.tauSec, c.features, c.pStd));
    const breakeven = price + (o.postOnly ? 0 : takerFee(1, price));
    if (q >= breakeven + c.margin) return true;
    skipped++;
    plan.notes.push(`take model: skip ${side.toUpperCase()} @ ${price.toFixed(2)} (P(win) ${q.toFixed(3)} < break-even ${(breakeven + c.margin).toFixed(3)})`);
    return false;
  });
  return skipped;
}

// The MLP's "should we take this trade" head (meta-labeling, Lopez de Prado). The fair-value MLP
// says what the contract is worth; for every trade that edge would place, this second, small model
// estimates the probability that the trade WINS, using the same information plus the SNN's
// direction call and fair-value bias oriented to the trade's side. A trade is taken only when that
// probability clears the side's break-even (price + fee) by `margin`.
//
// It is trained out-of-fold in research:train (the fair-value model's OOF predictions decide the
// would-be trades, so no trade is labelled by a model that saw its outcome) and only gates live
// orders once its own held-out check showed it beats the fair-value probability alone.

import { takerFee, type FeeSchedule } from '../fees';
import type { DenseLayer } from './metaModel';
import { gbdtLogit, type GbdtModel } from './trees';
import { gatedPredict, type GatedExperts } from './gatedExperts';
import type { OrderPlan } from '../strategy/fairValueStrategy';
import { gatePasses, probationLevel, probationTakeAdd } from '../risk/probation';

export const TAKE_FEATURES = ['edge', 'logit_p_side', 'price_side', 'spread', 'tau_min', 'snn_up_side', 'snn_bias_side', 'snn_agree_side', 'p_std', 'snn_skill_h', 'snn_cal_h'] as const;
/** Index of logit_p_side: the tree candidate learns a residual on the fair-value probability. */
export const TAKE_RESIDUAL = 1;

/** The gated candidate's inputs (bot/model/gatedExperts.ts): [name, centre, oriented to the trade's side]. Trend:
 *  momentum, the TA library and the TA network; micro: the contract's order flow and book; drivers of the gate: how
 *  fast volatility is changing and the SNN governor level. */
export const TAKE_GATED_TREND: Array<[string, number, boolean]> = [
  ['ret_60s_z', 0, true], ['ret_300s_z', 0, true], ['macd_hist_z', 0, true], ['rsi_60', 50, true], ['bb_pctb_300', 0.5, true], ['kaufman_er_120', 0, false],
  ['tanet_up_1h', 0.5, true], ['tanet_up_4h', 0.5, true],
];
export const TAKE_GATED_MICRO: Array<[string, number, boolean]> = [
  ['ofi_30s', 0, true], ['microprice_drift', 0, true], ['depth_imbalance_5', 0, true], ['tfi_60s', 0, true], ['vpin_300s', 0, false], ['trade_intensity_60s', 0, false], ['hawkes_excitation', 0, false],
];
export const TAKE_GATED_DRIVERS = ['vol_ratio_15m_4h', 'ewma_vol_ratio', 'snn_gov_h'];
export const TAKE_GATED_FEATURES = [...TAKE_GATED_TREND.map(([n]) => `${n}_side`), ...TAKE_GATED_MICRO.map(([n]) => `${n}_side`), ...TAKE_GATED_DRIVERS];

/** The gated candidate's input vector for a trade on `side`, from the feature map. */
export function takeGatedInputs(side: 'yes' | 'no', f: Record<string, number>): number[] {
  const s = side === 'yes' ? 1 : -1;
  const o = ([n, c, oriented]: [string, number, boolean]) => { const v = f[n]; return Number.isFinite(v) ? (oriented ? s * (v - c) : v) : NaN; };
  return [...TAKE_GATED_TREND.map(o), ...TAKE_GATED_MICRO.map(o), ...TAKE_GATED_DRIVERS.map((n) => (Number.isFinite(f[n]) ? f[n] : NaN))];
}

/** Indices of the gated candidate's experts and drivers in takeGatedInputs. */
export const TAKE_GATED_LAYOUT = {
  trend: TAKE_GATED_TREND.map((_, i) => i),
  micro: TAKE_GATED_MICRO.map((_, i) => TAKE_GATED_TREND.length + i),
  drivers: TAKE_GATED_DRIVERS.map((_, i) => TAKE_GATED_TREND.length + TAKE_GATED_MICRO.length + i),
};

export interface TakeModelParams {
  features: string[];
  /** mlp (default for older files), gbdt (boosted trees on the logit of the fair-value side probability), or gated
   *  (a trend expert and a microstructure expert on that logit, mixed by a gate on volatility change and the SNN
   *  governor: bot/model/gatedExperts.ts). */
  kind?: 'mlp' | 'gbdt' | 'gated';
  gated?: GatedExperts & { features: string[] };
  normalization?: { mean: number[]; std: number[] };
  layers?: DenseLayer[];
  gbdt?: GbdtModel;
  /** Candidates compared on the inner validation split (log loss); the lower one was kept. */
  candidates?: { kind: 'mlp' | 'gbdt' | 'gated'; valLogLoss: number }[];
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
    // The crypto network's confidence in its own calls (graded direction skill, contract calibration).
    Number.isFinite(f.snn_skill_h) ? f.snn_skill_h : NaN,
    Number.isFinite(f.snn_cal_h) ? f.snn_cal_h : NaN,
  ];
}

function forward(layer: DenseLayer, x: number[]): number[] {
  const out = layer.bias.slice();
  for (let i = 0; i < out.length; i++) { let v = out[i]; for (let j = 0; j < x.length; j++) v += layer.weights[i][j] * x[j]; out[i] = v; }
  return layer.activation === 'tanh' ? out.map(Math.tanh) : layer.activation === 'relu' ? out.map((v) => Math.max(0, v)) : out;
}

/** P(trade wins). MLP: missing inputs are imputed as the training mean; trees route them by learned defaults; the gated
 *  model needs `gx` (takeGatedInputs) and reads the fair-value probability alone without it. */
export function takeProbability(p: TakeModelParams, x: number[], gx?: number[]): number {
  // Older files were trained on fewer inputs: use the leading ones.
  x = x.slice(0, p.features.length);
  if (p.kind === 'gbdt' && p.gbdt) return 1 / (1 + Math.exp(-(gbdtLogit(p.gbdt, x) + x[TAKE_RESIDUAL])));
  if (p.kind === 'gated') return 1 / (1 + Math.exp(-(p.gated && gx ? gatedPredict(p.gated, gx, x[TAKE_RESIDUAL]).y : x[TAKE_RESIDUAL])));
  let h = x.map((v, i) => (Number.isFinite(v) ? (v - p.normalization!.mean[i]) / p.normalization!.std[i] : 0));
  for (const l of p.layers!) h = forward(l, h);
  return 1 / (1 + Math.exp(-h[0]));
}

export interface TakeGateCtx { pYes: number; features: Record<string, number>; tauSec: number; bid: number; ask: number; pStd?: number; margin: number; fees?: FeeSchedule }

/** Drop entry orders the take model says to skip. Exits and reduce-only orders always pass. */
export function applyTakeGate(plan: { place: OrderPlan[]; notes: string[] }, take: TakeModelParams | undefined, c: TakeGateCtx): number {
  if (!take || !gatePasses('kalshi', take.validation.validated)) return 0;
  // On probation (unvalidated), each level of the Kalshi book's probation asks for a wider margin (bot/risk/probation.ts).
  const extra = take.validation.validated ? 0 : probationTakeAdd('kalshi');
  let skipped = 0;
  plan.place = plan.place.filter((o) => {
    if (o.reduceOnly || o.purpose === 'exit') return true;
    const side = o.side === 'bid' ? 'yes' : 'no';
    const price = side === 'yes' ? o.price : 1 - o.price;
    const q = takeProbability(take, takeInputs(side, c.pYes, price, c.ask - c.bid, c.tauSec, c.features, c.pStd), takeGatedInputs(side, c.features));
    const breakeven = price + (o.postOnly ? 0 : takerFee(1, price, c.fees));
    if (q >= breakeven + c.margin + extra) return true;
    skipped++;
    plan.notes.push(`take model: skip ${side.toUpperCase()} @ ${price.toFixed(2)} (P(win) ${q.toFixed(3)} < break-even ${(breakeven + c.margin + extra).toFixed(3)}${extra ? `, probation level ${probationLevel('kalshi')}` : ''})`);
    return false;
  });
  return skipped;
}

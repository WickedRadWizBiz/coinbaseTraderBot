// Fee-net fractional Kelly for binary contracts.
//
// Buying one contract of a side at price c (dollars) with fee f per contract,
// and probability q that the side settles in the money:
//   win  -> +(1 - c - f)      lose -> -(c + f)
//   full Kelly fraction of bankroll to put at risk:
//     f* = (q - c - f) / (1 - c - f)
// If the fee-net edge (q - c - f) is not positive the size is ZERO. There is
// no fallback size, and negative Kelly never becomes a positive bet.

import { floorCount } from '../util/num';

export interface KellyInput {
  /** Probability the purchased side wins (calibrated). */
  q: number;
  /** Price paid per contract for that side (dollars). */
  cost: number;
  /** Fee per contract (dollars). */
  feePerContract: number;
  bankroll: number;
  kellyFraction: number;
  /** Hard cap on premium at risk for this order (dollars). */
  maxRiskUsd: number;
  maxContracts: number;
}

export interface KellyResult {
  contracts: number;
  edge: number;
  fullKelly: number;
  riskUsd: number;
  reason?: string;
}

export function kellySize(k: KellyInput): KellyResult {
  const lossPer = k.cost + k.feePerContract;
  const winPer = 1 - lossPer;
  const edge = k.q - lossPer;
  if (!(k.q > 0 && k.q < 1) || !(k.cost > 0 && k.cost < 1) || !(k.bankroll > 0)) {
    return { contracts: 0, edge, fullKelly: 0, riskUsd: 0, reason: 'invalid_input' };
  }
  if (!(edge > 0) || !(winPer > 0)) return { contracts: 0, edge, fullKelly: 0, riskUsd: 0, reason: 'no_edge' };
  const fullKelly = edge / winPer;
  const riskUsd = Math.min(fullKelly * k.kellyFraction * k.bankroll, k.maxRiskUsd);
  const contracts = floorCount(Math.min(riskUsd / lossPer, k.maxContracts));
  if (contracts <= 0) return { contracts: 0, edge, fullKelly, riskUsd: 0, reason: 'below_min_size' };
  return { contracts, edge, fullKelly, riskUsd: contracts * lossPer };
}

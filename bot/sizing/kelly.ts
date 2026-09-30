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

// ---- Target-EV sizing (relaxed-cadence spec) --------------------------------
//   q_adj = p_mkt_cal + kappa * (q_model - p_mkt_cal)    shrink toward the market
//   e     = q_adj - cost - fee                            net edge per contract
//   N     = min( ceil(targetEv / e), floor(lambda f* B / c), caps )
// Skip when e < minEdge or N * e < minEv. Halving the edge quadruples the
// bankroll needed for the same dollar target (size doubles, Kelly halves).

export interface TargetEvConfig {
  /** Shrink toward the calibrated market price, 0..1 (1 = trust the model fully). */
  kappa: number;
  kellyFraction: number;
  /** Dollar expected profit a trade aims for (the ceiling on size from the target). */
  targetEv: number;
  /** Skip trades whose expected profit is below this. */
  minEv: number;
  /** Net edge per contract required. */
  minEdge: number;
}

/** Effective $ target and $ minimum for a bankroll: min(absolute, fraction x bankroll). */
export function evThresholds(c: { targetEvUsd: number; minTradeEvUsd: number; targetEvFrac: number; minTradeEvFrac: number }, bankroll: number): { targetEv: number; minEv: number } {
  const b = Math.max(0, bankroll);
  return { targetEv: Math.min(c.targetEvUsd, c.targetEvFrac * b), minEv: Math.min(c.minTradeEvUsd, c.minTradeEvFrac * b) };
}

export interface TargetEvInput {
  /** Model and calibrated-market probabilities that the PURCHASED side wins. */
  qModel: number;
  qMarket: number;
  cost: number;
  feePerContract: number;
  bankroll: number;
  maxRiskUsd: number;
  maxContracts: number;
}

export interface TargetEvResult extends KellyResult { qAdj: number; ev: number }

export function targetEvSize(i: TargetEvInput, c: TargetEvConfig): TargetEvResult {
  const qAdj = i.qMarket + c.kappa * (i.qModel - i.qMarket);
  const k = kellySize({ q: qAdj, cost: i.cost, feePerContract: i.feePerContract, bankroll: i.bankroll, kellyFraction: c.kellyFraction, maxRiskUsd: i.maxRiskUsd, maxContracts: i.maxContracts });
  if (k.contracts <= 0) return { ...k, qAdj, ev: 0 };
  if (k.edge < c.minEdge) return { ...k, contracts: 0, riskUsd: 0, qAdj, ev: 0, reason: 'below_min_edge' };
  const target = c.targetEv > 0 ? Math.ceil(c.targetEv / k.edge) : Infinity;
  const contracts = floorCount(Math.min(k.contracts, target));
  const ev = contracts * k.edge;
  if (!(contracts > 0) || ev < c.minEv) return { ...k, contracts: 0, riskUsd: 0, qAdj, ev: 0, reason: 'below_min_ev' };
  return { ...k, contracts, riskUsd: contracts * (i.cost + i.feePerContract), qAdj, ev };
}

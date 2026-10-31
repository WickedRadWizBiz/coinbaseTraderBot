// The per-order stake for a Kalshi crypto entry or maker quote: one function for the engine, the backtester and the
// sweeps, so a replay sizes orders exactly as the bot does (phase 2 of the dynamic-scaling plan, Oct 28).
//
//   maxOrderRiskUsd = min(tier.orderFrac x bankroll x sizeMult x riskScale, optimal f cap x bankroll)
//
//   sizeMult   the session's size factor x the regime weight (Compensator, else the playbook): market conditions.
//              Above 1 it grows the dollar stake only: contracts per order never pass RISK_MAX_CONTRACTS_PER_ORDER.
//   riskScale  the loss-aware scale (EquityGuard: full size at break-even, shrinking with net losses)
//   optimal f  the growth-optimal stake the bot's own settled trades support, at a bootstrap quantile
//              (bot/strategy/optimalF.ts): the measured edge, with a margin for how uncertain it is. Infinity until
//              there are enough trades; paper floors it so evidence keeps coming.
//
// Kelly then sizes inside that budget from the trade's own edge (bot/sizing/kelly.ts). The order band (ORDER_USD_MIN /
// ORDER_USD_MAX, $10-$20 since Steven's choice on Oct 30, paper and live) replaces the budget: the budget is the band's top
// and the strategy clamps Kelly's stake into the band. The paper order size (PAPER_ORDER_FRAC / PAPER_ORDER_USD, off by
// default since the owner's choice on Oct 28: paper sizes like live) replaces all of it when set.
import { floorCount } from '../util/num';

export interface OrderBudgetInput {
  bankroll: number;
  /** The tier's per-order fraction of the bankroll. */
  orderFrac: number;
  /** Session size factor x regime weight. */
  sizeMult: number;
  /** Loss-aware risk scale. */
  riskScale: number;
  /** Optimal f cap in dollars (Infinity = none). */
  fCapUsd: number;
  /** Paper's fixed order size in dollars (0 = paper sizes like live). */
  paperOrderUsd: number;
  /** The order band in dollars (orderBand(); undefined = off). */
  bandUsd?: { min: number; max: number };
  maxContractsPerOrder: number;
}

export interface OrderBudget {
  maxOrderRiskUsd: number;
  maxContracts: number;
  /** Set only while a paper order size is in use. */
  fixedOrderUsd?: number;
  /** Set only while the order band is in use: the strategy clamps the sized stake into it. */
  band?: { min: number; max: number };
  /** What bound the stake: tier (the tier x factors), optimal_f, paper, or band. */
  boundBy: 'tier' | 'optimal_f' | 'paper' | 'band';
}

/** The order band from ORDER_USD_MIN / ORDER_USD_MAX: undefined when the minimum is 0 (off); the top never below the
 *  minimum. */
export function orderBand(minUsd: number | undefined, maxUsd: number | undefined): { min: number; max: number } | undefined {
  const min = Math.max(0, minUsd ?? 0);
  return min > 0 ? { min, max: Math.max(min, maxUsd ?? 0) } : undefined;
}

export function orderBudget(i: OrderBudgetInput): OrderBudget {
  if (i.paperOrderUsd > 0) return { maxOrderRiskUsd: i.paperOrderUsd, maxContracts: floorCount(i.maxContractsPerOrder), fixedOrderUsd: i.paperOrderUsd, boundBy: 'paper' };
  if (i.bandUsd && i.bandUsd.min > 0) return { maxOrderRiskUsd: i.bandUsd.max, maxContracts: floorCount(i.maxContractsPerOrder), band: i.bandUsd, boundBy: 'band' };
  const tierUsd = i.orderFrac * i.bankroll * i.sizeMult * i.riskScale;
  const capped = Number.isFinite(i.fCapUsd) && i.fCapUsd < tierUsd;
  return { maxOrderRiskUsd: capped ? i.fCapUsd : tierUsd, maxContracts: floorCount(i.maxContractsPerOrder * Math.min(1, i.sizeMult)), boundBy: capped ? 'optimal_f' : 'tier' };
}

// Dynamic entry edge: the edge the bot asks for before it quotes or takes, moved with what the market is doing now
// (phase 3 of the dynamic-scaling plan, Oct 28). One function for the engine and the backtester, so a replay asks for the
// same edge the bot asked for.
//
//   minEdge = STRATEGY_MIN_EDGE + session add + clamp(sum of the parts below, -maxDown, +maxUp)
//
//   vol          k x (rv15m / rv1h - 1): volatility rising makes the price stale sooner (asks more), calming asks less
//   change       k x P(change point in the last 5 minutes): the process just changed, the model's history fits it less
//   spread       k x the median Kalshi spread: a wide book is a sign informed traders are on the other side
//   flow         k x |taker imbalance|: one-sided flow is the toxicity reading (adverse selection on fills)
//   uncertainty  k x the model's standard deviation of p: less sure, more margin
//   quiet        k x max(0, 1 - jump / quietRef): the coin is not moving. Scaling lab round 1 (Oct 31): across every arm the
//                third of trades entered after the smallest 1-hour moves (jump under ~1.6 sigma) lost and the largest
//                (over ~2.2 sigma) earned, so a quiet coin asks more edge and a moving one asks no extra
//
// Every k is 0 by default, so nothing changes until the sweep (research/randomSweep.ts, PBO < 0.3 and a deflated Sharpe
// on held-out days) finds settings that earn more than today's. A reading the market state does not have yet adds 0.
import type { MarketStateReading } from '../marketdata/marketState';

export interface DynamicEdgeParams {
  vol: number;
  change: number;
  spread: number;
  flow: number;
  uncertainty: number;
  quiet: number;
  /** Jump (1-hour sigmas) at or above which the quiet term adds nothing. */
  quietRef: number;
  /** Most the edge can rise or fall from the static one (probability points). */
  maxUp: number;
  maxDown: number;
}

export const DYNAMIC_EDGE_OFF: DynamicEdgeParams = { vol: 0, change: 0, spread: 0, flow: 0, uncertainty: 0, quiet: 0, quietRef: 2.2, maxUp: 0.05, maxDown: 0.01 };

export interface DynamicEdge {
  /** What to add to minEdge (probability points). */
  add: number;
  parts: { vol: number; change: number; spread: number; flow: number; uncertainty: number; quiet: number };
}

const v = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? 0 : x);

export function dynamicEdge(p: DynamicEdgeParams, r: MarketStateReading | undefined, pStd: number | undefined): DynamicEdge {
  const parts = {
    vol: p.vol && r?.volRatio != null ? p.vol * (r.volRatio - 1) : 0,
    change: p.change * v(r?.changeProb),
    spread: p.spread * v(r?.spread),
    flow: p.flow * Math.abs(v(r?.flowImbalance)),
    uncertainty: p.uncertainty * v(pStd),
    quiet: p.quiet && p.quietRef > 0 && r?.jump != null && Number.isFinite(r.jump) ? p.quiet * Math.max(0, 1 - r.jump / p.quietRef) : 0,
  };
  const sum = parts.vol + parts.change + parts.spread + parts.flow + parts.uncertainty + parts.quiet;
  return { add: Math.max(-p.maxDown, Math.min(p.maxUp, sum)), parts };
}

export const dynamicEdgeOn = (p: DynamicEdgeParams) => p.vol !== 0 || p.change !== 0 || p.spread !== 0 || p.flow !== 0 || p.uncertainty !== 0 || p.quiet !== 0;

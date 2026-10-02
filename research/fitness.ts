// Fitness and validation statistics for the population tournaments (research/pbt.ts).
//
//   Fitness = Sortino (annualised, net of costs) - ddWeight x max drawdown - costWeight x costs
//
// plus the statistical hurdles of the protocol:
//   - independent interactions: trades that fire together (same asset/event, within clusterMs of
//     each other, e.g. 15 trades in one volatility spike) count as ONE interaction;
//   - the deflated Sharpe ratio (Bailey & Lopez de Prado), with every evaluation of every
//     population member counted as a trial;
//   - per-regime reporting over the crypto cycles 2016-2026, and the minimum number of independent
//     interactions per regime.

import { deflatedSharpe, type DeflatedSharpe } from './stats';


/** Crypto market regimes the walk-forward deliberately crosses (Phase 4). */
export interface Regime { id: string; cycle: string; phase: string; from: number; to: number }
const d = (s: string) => Date.parse(`${s}T00:00:00Z`);
export const REGIMES: Regime[] = [
  { id: 'c1-markup', cycle: 'Cycle 1 (retail)', phase: 'markup', from: d('2016-07-01'), to: d('2018-01-01') },
  { id: 'c1-markdown', cycle: 'Cycle 1 (retail)', phase: 'markdown', from: d('2018-01-01'), to: d('2019-01-01') },
  { id: 'c1-accumulation', cycle: 'Cycle 1 (retail)', phase: 'accumulation/chop', from: d('2019-01-01'), to: d('2020-04-01') },
  { id: 'c2-markup', cycle: 'Cycle 2 (DeFi/macro)', phase: 'markup', from: d('2020-04-01'), to: d('2021-12-01') },
  { id: 'c2-markdown', cycle: 'Cycle 2 (DeFi/macro)', phase: 'markdown', from: d('2021-12-01'), to: d('2023-01-01') },
  { id: 'c2-accumulation', cycle: 'Cycle 2 (DeFi/macro)', phase: 'accumulation/chop', from: d('2023-01-01'), to: d('2024-01-01') },
  { id: 'c3-markup', cycle: 'Cycle 3 (ETF/institutional)', phase: 'markup', from: d('2024-01-01'), to: d('2025-11-01') },
  { id: 'c3-distribution', cycle: 'Cycle 3 (ETF/institutional)', phase: 'distribution/markdown', from: d('2025-11-01'), to: Infinity },
];

export function regimeOf(ts: number): Regime | undefined {
  return REGIMES.find((r) => ts >= r.from && ts < r.to);
}

/** Regimes a [from, to) block touches. */
export function regimesIn(from: number, to: number): string[] {
  return REGIMES.filter((r) => r.from < to && r.to > from).map((r) => r.id);
}

export { dailyReturns, DEFAULT_FITNESS, fitnessOf, independentInteractions, maxDrawdown, sortino, type FitnessReport, type FitnessWeights, type Interaction } from '../bot/util/fitness';
import { dailyReturns, independentInteractions, sortino, type Interaction } from '../bot/util/fitness';

export interface RegimeStats { regime: string; independent: number; netReturn: number; sortino: number; hitRate: number; enough: boolean }

/** Independent interactions and performance per regime; `enough` = at least `minIndependent`. */
export function regimeReport(xs: Interaction[], clusterMs: number, minIndependent: number): RegimeStats[] {
  const ind = independentInteractions(xs, clusterMs);
  return REGIMES.map((r) => {
    const mine = ind.filter((x) => x.ts >= r.from && x.ts < r.to);
    const daily = dailyReturns(mine);
    return {
      regime: r.id, independent: mine.length, netReturn: mine.reduce((s, x) => s + x.ret, 0), sortino: sortino(daily),
      hitRate: mine.length ? mine.filter((x) => x.ret > 0).length / mine.length : NaN, enough: mine.length >= minIndependent,
    };
  }).filter((s) => s.independent > 0);
}

/** Deflated Sharpe on the independent interactions (each one observation), `trials` = every
 *  evaluation of every member the tournament ran. */
export function dsrOf(xs: Interaction[], clusterMs: number, trials: number): DeflatedSharpe & { n: number } {
  const ind = independentInteractions(xs, clusterMs).map((x) => x.ret);
  if (ind.length < 3) return { sharpe: NaN, sr0: NaN, excess: NaN, probability: NaN, n: ind.length };
  return { ...deflatedSharpe(ind, Math.max(1, trials)), n: ind.length };
}

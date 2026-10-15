// Tournament selection that is harder to fool (the 4th-generation spec, section 6, as reviewed):
//
//   era-robust ranking   members are ranked on their recent evaluation blocks (one block per round, about a
//                        month), not the latest one alone: mean - lambda x spread across the last `window` blocks
//                        (or the mean of the worst k). A member that shines in one era and fails the next ranks
//                        below one that is steadily good. The spread of a member with few blocks is shrunk toward
//                        the population's, so a newcomer is not favoured for having no history to vary.
//   real transitions     a penalty for drawdown and turnover cost in the hours after each REAL regime transition
//                        (each coin's confirmed regime from bot/ta/regime.ts changing), the "inertia and whipsaw"
//                        test, on history that happened. Nothing is spliced together: splicing periods creates
//                        price jumps that never happened, and models learn the seam.
//   PBO gate             the probability of backtest overfitting (CSCV, research/stats.ts pbo) on the tournament's
//                        member x round fitness matrix: promotion needs PBO < 0.2 on top of the existing DSR gate.
//
// Deliberately not here: a hard "Sortino >= 1 in the post-shock window" guillotine. One short window is too small
// a sample; it would reject good candidates at random. The transition penalty aggregates over many transitions.

import { pbo } from './stats';
import type { Interaction } from '../bot/util/fitness';

export interface RobustOpts {
  /** Blocks (rounds) a member is judged on. */
  window: number;
  /** Weight of the spread (standard deviation of block fitness). */
  lambda: number;
  /** Instead of mean - lambda x spread: the mean of the worst k blocks (0 / unset = off). */
  worstK?: number;
  /** Pseudo-blocks of the population's spread a member's own spread is shrunk with. */
  prior?: number;
}

export const DEFAULT_ROBUST: RobustOpts = { window: 6, lambda: 0.5, prior: 3 };

const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / Math.max(1, x.length);
const variance = (x: number[]) => { if (x.length < 2) return NaN; const m = mean(x); return x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1); };

/** The population's typical block-to-block variance (median over members with 2+ blocks; 0 without any). */
export function populationVariance(histories: number[][], window: number): number {
  const v = histories.map((h) => variance(h.slice(-window))).filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
}

/** Era-robust score of one member from its block fitnesses (oldest first). */
export function robustScore(scores: number[], popVar: number, o: RobustOpts = DEFAULT_ROBUST): number {
  const w = scores.slice(-Math.max(1, o.window)).filter(Number.isFinite);
  if (!w.length) return -Infinity;
  if (o.worstK && o.worstK > 0) {
    const worst = [...w].sort((a, b) => a - b).slice(0, Math.min(o.worstK, w.length));
    // With fewer blocks than k, the missing ones count at the population's typical shortfall below the mean.
    const missing = Math.max(0, o.worstK - w.length);
    return (worst.reduce((s, v) => s + v, 0) + missing * (mean(w) - Math.sqrt(Math.max(0, popVar)))) / (worst.length + missing);
  }
  const own = variance(w);
  const k = o.prior ?? 3, n = w.length - 1;
  const v = Number.isFinite(own) ? (n * own + k * popVar) / (n + k) : popVar;
  return mean(w) - o.lambda * Math.sqrt(Math.max(0, v));
}

/** A real regime transition: a coin's confirmed regime changing at `ts` (asset undefined = market-wide). */
export interface Transition { ts: number; asset?: string; from: string; to: string }

/** Confirmed transitions from labels in time order (hysteresis: a new label must hold `confirm` labels in a row,
 *  bot/ta/regime.ts RegimeTracker's rule). */
export function transitionsOf(labels: Array<{ ts: number; key: string }>, asset?: string, confirm = 2): Transition[] {
  const out: Transition[] = [];
  let cur: string | undefined, pending: { key: string; n: number; ts: number } | undefined;
  for (const l of labels) {
    if (cur === undefined) { cur = l.key; continue; }
    if (l.key === cur) { pending = undefined; continue; }
    pending = pending?.key === l.key ? { ...pending, n: pending.n + 1 } : { key: l.key, n: 1, ts: l.ts };
    if (pending.n >= confirm) { out.push({ ts: pending.ts, asset, from: cur, to: pending.key }); cur = pending.key; pending = undefined; }
  }
  return out;
}

export interface TransitionOpts { windowMs: number; ddWeight: number; costWeight: number }
export const DEFAULT_TRANSITION: TransitionOpts = { windowMs: 24 * 3_600_000, ddWeight: 2, costWeight: 2 };

/**
 * Drawdown and turnover in the window after each transition, averaged over the transitions in [from, to)
 * (a transition the member sat out counts as 0: staying flat through a regime change is fine). An interaction
 * belongs to a coin's transition when `assetOf` gives that coin; market-wide transitions take every interaction.
 */
export function transitionPenalty(xs: Interaction[], transitions: Transition[], o: TransitionOpts & { from: number; to: number; assetOf?: (x: Interaction) => string | undefined }): { penalty: number; transitions: number; meanDd: number; meanCost: number } {
  const ts = transitions.filter((t) => t.ts >= o.from && t.ts < o.to);
  if (!ts.length) return { penalty: 0, transitions: 0, meanDd: 0, meanCost: 0 };
  const sorted = [...xs].sort((a, b) => a.ts - b.ts);
  let dd = 0, cost = 0;
  for (const t of ts) {
    let eq = 0, peak = 0, worst = 0, c = 0;
    for (const x of sorted) {
      if (x.ts < t.ts) continue;
      if (x.ts >= t.ts + o.windowMs) break;
      if (t.asset !== undefined && o.assetOf && o.assetOf(x) !== t.asset) continue;
      eq += x.ret; peak = Math.max(peak, eq); worst = Math.max(worst, peak - eq); c += x.cost;
    }
    dd += worst; cost += c;
  }
  const meanDd = dd / ts.length, meanCost = cost / ts.length;
  return { penalty: o.ddWeight * meanDd + o.costWeight * meanCost, transitions: ts.length, meanDd, meanCost };
}

/** PBO of a tournament: CSCV over the member x round fitness matrix of the last `maxRounds` rounds (rows = rounds,
 *  columns = member slots; a slot missing from a round's ranking is skipped with the round). NaN with too few rounds. */
export function tournamentPbo(log: Array<{ ranking: Array<{ member: number; fitness: number }> }>, maxRounds = 32): { pbo: number; rounds: number; members: number; splits: number } {
  const recent = log.slice(-maxRounds);
  const ids = [...new Set(recent.flatMap((r) => r.ranking.map((x) => x.member)))].sort((a, b) => a - b);
  const rows = recent.map((r) => { const m = new Map(r.ranking.map((x) => [x.member, x.fitness])); return ids.map((id) => m.get(id)); })
    .filter((row) => row.every((v) => v !== undefined && Number.isFinite(v))) as number[][];
  let S = 8;
  while (S > 2 && rows.length < 2 * S) S -= 2;
  if (ids.length < 2 || rows.length < 2 * S) return { pbo: NaN, rounds: rows.length, members: ids.length, splits: 0 };
  const r = pbo(rows, S);
  return { pbo: r.pbo, rounds: rows.length, members: ids.length, splits: r.splits };
}

/** The promotion gate: PBO below `max` (unmeasurable with too few rounds: reported, not blocking). */
export function pboGate(p: { pbo: number; rounds: number }, max = 0.2): { ok: boolean; why: string } {
  if (!Number.isFinite(p.pbo)) return { ok: true, why: `PBO not measurable yet (${p.rounds} complete rounds)` };
  return p.pbo < max ? { ok: true, why: `PBO ${p.pbo.toFixed(2)} < ${max}` } : { ok: false, why: `PBO ${p.pbo.toFixed(2)} >= ${max}: the in-sample winner tends to fall to the bottom half out of sample` };
}

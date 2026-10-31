// Strictness ladder (Steven, Oct 31: "Anything benched needs to be reworked ... rather than bench them or get rid of them").
//
// A scoreboard that used to bench its feature (stop it outright) now moves it one level stricter instead. The feature keeps
// working at every level; each level asks more of it before it acts (bot/strategy/fairValueStrategy.ts: the take-profit's
// fair-value confirm; bot/strategy/sinuousExit.ts: the cross's). The rule that used to bench trips the ladder: a net cost of
// maxLossUsd, or after minTrades results a negative net with t <= -t. Each trip starts a fresh window at the new level.
// After minTrades results at a level that made money (net > 0), it steps back one level, also with a fresh window: a
// feature that has become too strict gets looser again. Level 0 is the feature as it was before any trip.
//
// `pinned` (a setting) holds the level fixed whatever the scores say: the lab's arms compare fixed levels; scores still keep.

import { scoreStats } from './scoreStats';

export interface LadderRule { minTrades: number; t: number; maxLossUsd: number; window: number }
export interface LadderState { results: number[]; since: number; level: number }
export type LadderMove = { event: 'stricter' | 'looser'; level: number; from: number; reason: string } | undefined;

export class LevelLadder {
  constructor(readonly rule: LadderRule, readonly maxLevel: number, readonly pinned?: number) {}

  /** The level in force: the pinned one, or the state's. */
  level(st: LadderState): number { return this.pinned ?? Math.max(0, Math.min(this.maxLevel, st.level || 0)); }

  /** Add one result; returns the move it caused, if any (the state is changed in place). `what` names the feature. */
  record(st: LadderState, usd: number, now: number, what: string): LadderMove {
    st.results.push(+usd.toFixed(4));
    if (st.results.length > this.rule.window) st.results.splice(0, st.results.length - this.rule.window);
    if (this.pinned !== undefined) return undefined;
    const why = this.verdict(st.results, what);
    const from = this.level(st);
    if (why && from < this.maxLevel) {
      st.level = from + 1; st.results = []; st.since = now;
      return { event: 'stricter', level: st.level, from, reason: why };
    }
    const s = scoreStats(st.results);
    if (!why && from > 0 && st.results.length >= this.rule.minTrades && s.sum > 0) {
      st.level = from - 1; st.results = []; st.since = now;
      return { event: 'looser', level: st.level, from, reason: `${what} made $${s.sum.toFixed(2)} over ${this.rule.minTrades}+ results at level ${from}` };
    }
    return undefined;
  }

  /** The reason the old bench rule gives for this window, or undefined. */
  verdict(r: number[], what: string): string | undefined {
    const s = scoreStats(r);
    if (s.sum <= -this.rule.maxLossUsd) return `${what} cost $${(-s.sum).toFixed(2)} over ${r.length} results (limit $${this.rule.maxLossUsd})`;
    if (r.length >= this.rule.minTrades && s.sum < 0 && s.t !== null && s.t <= -this.rule.t) return `${what} is losing beyond luck: $${s.sum.toFixed(2)} over ${r.length} results, t ${s.t.toFixed(2)}`;
    return undefined;
  }
}

/** A list of per-level margins from a setting ("0.06,0.03,0.01,0"): index 0 is level 1. */
export function parseLevelMargins(raw: string | undefined, fallback: number[]): number[] {
  const xs = (raw ?? '').split(',').map((s) => Number(s.trim())).filter((x) => Number.isFinite(x) && Math.abs(x) <= 1);
  return xs.length ? xs : fallback;
}

/** The fair-value confirm a level asks for: undefined at level 0 (no confirm), else the level's margin (the last one for a
 *  level past the list). */
export function levelMargin(margins: number[], level: number): number | undefined {
  if (!(level > 0) || !margins.length) return undefined;
  return margins[Math.min(level, margins.length) - 1];
}

// Conditioning mode: a pressure test of the freshly trained bot on days it never saw, as live. Many instances
// of the whole bot (research/wholeBot.ts: Kalshi contracts and perps setups from one pot) trade the same
// unseen windows of the history replay, and every window culls the ones that did not hold up:
//
//   Tier 1  $1000   3 days, 2 days, 1 day
//   Tier 2  $500    3 days, 2 days, 1 day
//   Tier 3  $200    3 days, 2 days, 1 day
//   Tier C  $100    calm days                   (the market character, bot/ta/character.ts)
//   Tier B  $100    trending days
//   Tier A  $100    volatile days (the coin alone)
//   Tier S  $100    volatile days (market-wide)
//
//   window       starts with the tier's cash; the full window always plays out (reaching the target early does
//                not end it): what counts is the profit still held at its end
//   pass         at least targetUsd ($100) of profit at the end, and never below -cullFrac (35 %) of the starting
//                cash at any point of the window (realised P&L, in time order)
//   Tier C fill  if fewer than minTierC instances pass Tier 3, the best of those that reached Tier 3 enter Tier C
//                anyway (wildcards); every instance that reached Tier 3 is saved in the report
//   Elite        passed all 21 windows AND made more over them than the live settings did on the same days: it
//                replaces the live settings (the previous ones are kept for rollback)
//   retrials     no Elite: up to 3 more trials on new days, with new random instances plus the best of the last
//                trial varied (they keep what worked and try around it)
//   best         ranked by how far an instance got, then by the profit it held, then by its worst moment: the
//                best of every trial is kept even when nobody finishes (a fixed $100 is a pressure test: at $100
//                of cash it asks for a doubling in a day)
//
// This module is the tournament itself (pure: evaluation is injected); research/conditioningRun.ts supplies the
// days, the instances and the evaluation in worker threads.

import type { Character } from '../bot/ta/character';

export interface Tier { name: string; cash: number; regime?: Character }
export const TIERS: Tier[] = [
  { name: '1', cash: 1000 }, { name: '2', cash: 500 }, { name: '3', cash: 200 },
  { name: 'C', cash: 100, regime: 'calm' }, { name: 'B', cash: 100, regime: 'trending' },
  { name: 'A', cash: 100, regime: 'volatile_idio' }, { name: 'S', cash: 100, regime: 'volatile_systemic' },
];
export const WINDOW_DAYS = [3, 2, 1];
/** Index of Tier 3 (the last tier before the Tier C fill). */
export const TIER3 = 2;
export const STAGES = TIERS.length * WINDOW_DAYS.length;

export interface ConditioningRules { targetUsd: number; cullFrac: number; minTierC: number; retrials: number }
export const DEFAULT_RULES: ConditioningRules = { targetUsd: 100, cullFrac: 0.35, minTierC: 4, retrials: 3 };

/** One window: the tier and the window within it, and its days (the same days for every instance). */
export interface Stage { index: number; tier: number; win: number; cash: number; days: string[] }

/** What a window did for an instance: profit at its end, the lowest running profit in it, trades. */
export interface WindowResult { pnl: number; minPnl: number; trades: number }

export interface InstanceRecord<S> {
  id: string; settings: S; origin: string;
  /** Windows played, in order, with whether each passed. */
  played: Array<WindowResult & { stage: number; passed: boolean; why?: string }>;
  /** Windows passed in a row from the start, and windows passed in all (wildcards keep playing after a miss). */
  passed: number; wins: number;
  /** Entered Tier C as a wildcard (did not pass Tier 3). */
  wildcard?: boolean;
  culled?: string;
}

export interface TrialResult<S> {
  trial: number; stages: Stage[]; instances: Array<InstanceRecord<S>>;
  baseline: Array<WindowResult & { stage: number }>;
  elite?: InstanceRecord<S>; best?: InstanceRecord<S>;
  /** Instances that reached Tier 3 or further (saved). */
  saved: Array<InstanceRecord<S>>;
}

export interface ConditioningResult<S> { trials: Array<TrialResult<S>>; elite?: InstanceRecord<S>; best?: InstanceRecord<S> }

export const stageName = (s: { tier: number; win: number }) => `Tier ${TIERS[s.tier].name} ${WINDOW_DAYS[s.win]}-day`;

/** Passed or not, and why not. */
export function judge(r: WindowResult, cash: number, rules: ConditioningRules): { passed: boolean; why?: string } {
  if (r.minPnl <= -rules.cullFrac * cash) return { passed: false, why: `fell to ${r.minPnl.toFixed(2)} (cull at -${(rules.cullFrac * 100).toFixed(0)} % of $${cash})` };
  if (r.pnl < rules.targetUsd) return { passed: false, why: `held $${r.pnl.toFixed(2)} at the end (target $${rules.targetUsd})` };
  return { passed: true };
}

const total = (played: Array<{ pnl: number }>) => played.reduce((a, r) => a + r.pnl, 0);
const worst = (played: Array<{ minPnl: number }>) => Math.min(0, ...played.map((r) => r.minPnl));

/** Ranking: windows passed in a row, windows passed in all, profit held over the windows played, then the
 *  shallowest worst moment. */
export function rankKey<S>(r: InstanceRecord<S>): [number, number, number, number] { return [r.passed, r.wins, total(r.played), worst(r.played)]; }
export function compareRecords<S>(a: InstanceRecord<S>, b: InstanceRecord<S>): number {
  const x = rankKey(a), y = rankKey(b);
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2] || y[3] - x[3];
}

/** One trial: every instance through the stages; culled at its first failed window (wildcards aside). */
export async function runTrial<S>(o: {
  trial: number; stages: Stage[]; instances: Array<{ id: string; settings: S; origin: string }>; baseline: S; rules: ConditioningRules;
  evaluate: (settings: S, stage: Stage) => Promise<WindowResult>;
  log?: (m: string) => void; progress?: (done: number, total: number) => void;
}): Promise<TrialResult<S>> {
  const log = o.log ?? (() => undefined);
  const recs: Array<InstanceRecord<S>> = o.instances.map((i) => ({ ...i, played: [], passed: 0, wins: 0 }));
  const baseline: TrialResult<S>['baseline'] = [];
  let alive = recs.slice();
  let done = 0;
  const work = o.stages.length * (recs.length + 1);
  for (const stage of o.stages) {
    if (!alive.length) break;
    // The live settings play every window (the bar an Elite must clear), alongside the instances still in.
    const [base, ...res] = await Promise.all([o.evaluate(o.baseline, stage), ...alive.map((r) => o.evaluate(r.settings, stage))]);
    baseline.push({ ...base, stage: stage.index });
    done += 1 + alive.length;
    o.progress?.(Math.min(done, work), work);
    const next: Array<InstanceRecord<S>> = [];
    res.forEach((w, k) => {
      const r = alive[k];
      const j = judge(w, stage.cash, o.rules);
      r.played.push({ ...w, stage: stage.index, passed: j.passed, why: j.why });
      if (j.passed) r.wins++;
      if (j.passed && r.passed === stage.index) r.passed++;
      if (j.passed) next.push(r); else r.culled = `${stageName(stage)}: ${j.why}`;
    });
    log(`trial ${o.trial}, ${stageName(stage)} (${stage.days.join(', ')}, $${stage.cash}): ${next.length} of ${alive.length} passed; live settings ${base.pnl >= 0 ? '+' : ''}$${base.pnl.toFixed(2)}`);
    alive = next;
    // After Tier 3: too few survivors, so the best of those that reached Tier 3 enter Tier C as wildcards.
    if (stage.tier === TIER3 && stage.win === WINDOW_DAYS.length - 1 && alive.length < o.rules.minTierC) {
      const reached = recs.filter((r) => r.passed >= TIER3 * WINDOW_DAYS.length && !alive.includes(r)).sort(compareRecords);
      const wild = reached.slice(0, o.rules.minTierC - alive.length);
      for (const r of wild) { r.wildcard = true; r.culled = undefined; }
      if (wild.length) log(`trial ${o.trial}: ${alive.length} passed Tier 3; ${wild.length} wildcard(s) that reached it enter Tier C`);
      alive = [...alive, ...wild];
    }
  }
  const finished = o.stages.length === STAGES ? recs.filter((r) => r.passed === o.stages.length && !r.wildcard) : [];
  const baseTotal = total(baseline);
  const elite = finished.filter((r) => total(r.played) > baseTotal).sort(compareRecords)[0];
  if (finished.length && !elite) log(`trial ${o.trial}: ${finished.length} finished every window but none made more than the live settings ($${baseTotal.toFixed(2)})`);
  const sorted = recs.slice().sort(compareRecords);
  return { trial: o.trial, stages: o.stages, instances: sorted, baseline, elite, best: sorted[0], saved: sorted.filter((r) => r.passed >= TIER3 * WINDOW_DAYS.length || r.wildcard) };
}

/** The whole run: trials until an Elite (or 1 + retrials trials), each on new days with new instances. */
export async function runConditioning<S>(o: {
  rules?: Partial<ConditioningRules>;
  /** The windows of a trial (new days each trial); undefined when the unseen days ran out. */
  stagesFor: (trial: number) => Stage[] | undefined;
  /** The instances of a trial, given the best of the previous trials (trial 0: none). */
  instancesFor: (trial: number, previousBest: Array<InstanceRecord<S>>) => Array<{ id: string; settings: S; origin: string }>;
  baseline: S;
  evaluate: (settings: S, stage: Stage) => Promise<WindowResult>;
  log?: (m: string) => void; progress?: (trial: number, done: number, total: number) => void; stopped?: () => boolean;
}): Promise<ConditioningResult<S>> {
  const rules = { ...DEFAULT_RULES, ...o.rules };
  const log = o.log ?? (() => undefined);
  const trials: Array<TrialResult<S>> = [];
  for (let t = 0; t <= rules.retrials && !o.stopped?.(); t++) {
    const stages = o.stagesFor(t);
    if (!stages?.length) { log(`trial ${t}: not enough unseen days left for another trial`); break; }
    const prev = trials.flatMap((x) => x.instances).sort(compareRecords);
    const instances = o.instancesFor(t, prev);
    log(`trial ${t}${t ? ' (retrial)' : ''}: ${instances.length} instance(s) over ${stages.length} window(s) from ${stages[0].days[0]}`);
    const r = await runTrial({ trial: t, stages, instances, baseline: o.baseline, rules, evaluate: o.evaluate, log, progress: (d, n) => o.progress?.(t, d, n) });
    trials.push(r);
    if (r.elite) { log(`trial ${t}: Elite Champion ${r.elite.id} (${r.elite.origin})`); break; }
  }
  const all = trials.flatMap((x) => x.instances).sort(compareRecords);
  return { trials, elite: trials.find((x) => x.elite)?.elite, best: all[0] };
}

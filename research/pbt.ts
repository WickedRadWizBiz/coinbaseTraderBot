// Population-based training (Jaderberg et al. 2017, DeepMind) adapted to time series as a
// walk-forward tournament of THREE networks. Used to initialise every network in the bot: the TA
// network (research/trainTaNet.ts), the crypto and perps SNNs (research/snnPbt.ts) and, live, the
// tennis SNN (bot/snn/population.ts uses the same exploration rules).
//
//   init        three identical networks (same seed, same weights) whose hyperparameters differ
//               slightly: member 0 = the base, members 1-2 = the base perturbed by +/-10%
//   per round   exploit:  each member trains on the round's training block (rolling, past only)
//               evaluate: each member is scored on the NEXT block, which none of them has seen
//               explore:  ranked by fitness -
//                         elite  (best)   survives untouched
//                         culled (worst)  abandons its weights and clones the elite exactly
//                         middle + clone  hyperparameters mutated (x0.8 or x1.25 per knob, clipped)
//   roll        the blocks advance; repeat. Nothing ever trains on data after its evaluation block.
//
// Each member keeps the record of its evaluation windows; a clone inherits the elite's record, so
// the final elite's record is the out-of-sample history of its lineage. Every evaluation of every
// member counts as a trial for the deflated Sharpe ratio.

import { rng } from './stats';
import { perturb, type FitnessReport, type Hyper, type Interaction, type MutationSpec } from '../bot/util/fitness';

export { perturb, type Hyper, type MutationSpec } from '../bot/util/fitness';
export interface PbtRound {
  index: number;
  /** Training block [trainFrom, trainTo) and evaluation block [evalFrom, evalTo). */
  trainFrom: number; trainTo: number; evalFrom: number; evalTo: number;
}

export interface PbtEval { report: FitnessReport; interactions: Interaction[]; extra?: Record<string, number> }

export interface PbtHooks<S> {
  /** Build a member. Every member starts from the same weights (same seed); only `hyper` differs. */
  init(hyper: Hyper, member: number): Promise<S> | S;
  /** Exact copy of a member's state (weights, optimiser and learning state). */
  clone(state: S): Promise<S> | S;
  /** Exploitation: continue training on the round's training block. */
  train(state: S, hyper: Hyper, round: PbtRound): Promise<S> | S;
  /** Score on the round's evaluation block (strictly after the training block). */
  evaluate(state: S, hyper: Hyper, round: PbtRound): Promise<PbtEval> | PbtEval;
  /** Called after a member's hyperparameters change (e.g. rebuild a network with new knobs). */
  rehyper?(state: S, hyper: Hyper): Promise<S> | S;
}

export interface PbtMember<S> {
  id: number;
  hyper: Hyper;
  state: S;
  /** Member ids this one descends from (clones append the elite's lineage). */
  lineage: number[];
  /** Out-of-sample record: interactions from every evaluation window of this lineage. */
  record: Interaction[];
  scores: Array<{ round: number; fitness: number }>;
  /** Round after which this member restarted fresh (exploration): protected from culling for a while. */
  bornRound?: number;
}

export interface PbtRoundLog {
  round: number;
  evalFrom: string; evalTo: string;
  ranking: Array<{ member: number; fitness: number; sortino: number; maxDrawdown: number; costs: number; independent: number; hyper: Hyper }>;
  elite: number; culled: number; mutated: number[];
  /** Member that restarted fresh this round (exploration), if any. */
  restarted?: number;
  /** Worst-ranked member that was not culled because it is a newcomer still in its grace period. */
  spared?: number;
}

export interface PbtResult<S> {
  elite: PbtMember<S>;
  members: PbtMember<S>[];
  log: PbtRoundLog[];
  /** Total evaluations (members x rounds): the trial count for the deflated Sharpe ratio. */
  trials: number;
}

export async function runPbt<S>(o: {
  base: Hyper;
  spec: MutationSpec;
  rounds: PbtRound[];
  hooks: PbtHooks<S>;
  seed?: number;
  population?: number;
  log?: (m: string) => void;
  /** Continue an earlier tournament (its members, trial count and log) instead of initialising. */
  resume?: { members: PbtMember<S>[]; trials: number; log: PbtRoundLog[] };
  /** Also explore after the last round of this call (the tournament continues later). */
  exploreAfterLast?: boolean;
  /** Every N rounds the culled member restarts fresh with random knobs instead of cloning (0 = never). */
  restartEvery?: number;
  /** Rounds a restarted member cannot be culled (default 2): month-to-month fitness noise is larger
   *  than the gaps between members, so a newcomer needs a few evaluations before it can be judged. */
  restartGrace?: number;
  /** Called after every round (e.g. to persist the population). */
  onRound?: (state: { members: PbtMember<S>[]; trials: number; log: PbtRoundLog[]; round: PbtRound }) => Promise<void> | void;
}): Promise<PbtResult<S>> {
  const r = rng((o.seed ?? 17) + (o.resume ? o.resume.trials : 0));
  const n = o.resume?.members.length ?? o.population ?? 3;
  const log = o.log ?? (() => {});
  const members: PbtMember<S>[] = o.resume ? o.resume.members : [];
  if (!o.resume) {
    for (let i = 0; i < n; i++) {
      const hyper = i === 0 ? { ...o.base } : perturb(o.base, o.spec, r, 'init');
      members.push({ id: i, hyper, state: await o.hooks.init(hyper, i), lineage: [i], record: [], scores: [] });
    }
  }
  const out: PbtRoundLog[] = o.resume ? [...o.resume.log] : [];
  let trials = o.resume?.trials ?? 0;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  for (const round of o.rounds) {
    const evals: PbtEval[] = [];
    for (const m of members) {
      m.state = await o.hooks.train(m.state, m.hyper, round);
      const e = await o.hooks.evaluate(m.state, m.hyper, round);
      trials++;
      m.record.push(...e.interactions);
      m.scores.push({ round: round.index, fitness: e.report.fitness });
      evals.push(e);
    }
    const order = members.map((m, i) => ({ m, e: evals[i] })).sort((a, b) => b.e.report.fitness - a.e.report.fitness);
    const elite = order[0].m;
    // The worst member is culled unless it is a newcomer in its grace period; then the next worst.
    const grace = o.restartGrace ?? 2;
    const inGrace = (m: PbtMember<S>) => m.bornRound !== undefined && round.index - m.bornRound <= grace;
    const candidates = order.slice(1).map((x) => x.m);
    const culled = [...candidates].reverse().find((m) => !inGrace(m)) ?? order[order.length - 1].m;
    const worst = order[order.length - 1].m;
    const middle = candidates.filter((m) => m !== culled);
    const entry: PbtRoundLog = {
      round: round.index, evalFrom: iso(round.evalFrom), evalTo: iso(round.evalTo),
      ranking: order.map(({ m, e }) => ({ member: m.id, fitness: e.report.fitness, sortino: e.report.sortino, maxDrawdown: e.report.maxDrawdown, costs: e.report.costs, independent: e.report.independent, hyper: { ...m.hyper } })),
      elite: elite.id, culled: culled.id, mutated: [],
      ...(worst !== culled ? { spared: worst.id } : {}),
    };
    // Exploration (not after the last round: the elite is final).
    // Exploration after every round except the final one; a resumed tournament explores between
    // calls too, so the population keeps evolving as new months arrive.
    if ((round !== o.rounds[o.rounds.length - 1] || o.exploreAfterLast) && n >= 2) {
      // Exploration member: every `restartEvery` rounds the worst network does not copy the elite but
      // starts afresh (new weights, random knobs within their ranges), so the population cannot
      // collapse onto one lineage and get stuck in its local optimum.
      const restart = (o.restartEvery ?? 0) > 0 && (round.index + 1) % o.restartEvery! === 0;
      if (restart) {
        culled.hyper = randomHyper(o.spec, o.base, r);
        culled.state = await o.hooks.init(culled.hyper, culled.id);
        culled.lineage = [culled.id];
        culled.record = [];
        culled.bornRound = round.index;
        entry.restarted = culled.id;
      } else {
        culled.state = await o.hooks.clone(elite.state);
        culled.hyper = { ...elite.hyper };
        culled.lineage = [...elite.lineage, culled.id];
        culled.record = [...elite.record];
        delete culled.bornRound;
      }
      // A newcomer in its grace period keeps its knobs (it is being judged on them).
      for (const m of (restart ? middle : [...middle, culled]).filter((x) => !inGrace(x))) {
        m.hyper = perturb(m.hyper, o.spec, r, 'explore');
        if (o.hooks.rehyper) m.state = await o.hooks.rehyper(m.state, m.hyper);
        entry.mutated.push(m.id);
      }
    }
    out.push(entry);
    await o.onRound?.({ members, trials, log: out, round });
    log(`round ${round.index} (${entry.evalFrom}..${entry.evalTo}): ${entry.ranking.map((x) => `#${x.member} ${x.fitness.toFixed(2)}`).join(', ')}; elite #${elite.id}, #${culled.id} ${entry.restarted !== undefined ? 'restarts fresh (exploration)' : 'clones it'}${entry.spared !== undefined ? ` (#${entry.spared} spared: newcomer)` : ''}`);
  }
  const lastRank = out[out.length - 1]?.ranking[0]?.member ?? 0;
  return { elite: members.find((m) => m.id === lastRank) ?? members[0], members, log: out, trials };
}

/** Random knobs: log-uniform within each range (knobs outside the spec keep the base value). */
export function randomHyper(spec: MutationSpec, base: Hyper, r: () => number): Hyper {
  const out: Hyper = { ...base };
  for (const [k, s] of Object.entries(spec)) {
    if (!(k in out)) continue;
    const lo = Math.max(s.min, 1e-12), hi = Math.max(lo, s.max);
    let v = s.min <= 0 ? s.min + r() * (s.max - s.min) : Math.exp(Math.log(lo) + r() * (Math.log(hi) - Math.log(lo)));
    if (s.integer) v = Math.round(v);
    out[k] = v;
  }
  return out;
}

/** Walk-forward rounds: rolling training block of `trainMs`, evaluation block of `evalMs`,
 *  advancing by `stepMs`, from `start` until the evaluation block would pass `end`. */
export function walkForwardRounds(start: number, end: number, trainMs: number, evalMs: number, stepMs: number): PbtRound[] {
  const out: PbtRound[] = [];
  for (let t = start + trainMs, i = 0; t + evalMs <= end; t += stepMs, i++) out.push({ index: i, trainFrom: t - trainMs, trainTo: t, evalFrom: t, evalTo: t + evalMs });
  return out;
}

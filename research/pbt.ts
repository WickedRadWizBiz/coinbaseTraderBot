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
//
// Genetic layer (`genetic`, research/genetic.ts), on top of that selection: with a population of 6+, every
// few rounds (a generation) the best survivors over the generation breed -- one offspring per pair, its
// knobs crossed from both parents and very slightly mutated, its learned state from the parents -- and the
// offspring take the slots of the worst; the champion parents and the best runners-up carry on. Optionally
// the population is split into islands whose winners are the parents.

import { rng } from './stats';
import { perturb, type FitnessReport, type Hyper, type Interaction, type MutationSpec } from '../bot/util/fitness';
import { crossoverGenes, geneScale, geneTraits, GENE_WINDOW, islandCount, newGaState, parentCount, planBreeding, roundRanks, type GaGeneration, type GaState, type GeneTrait } from './genetic';

export { perturb, type Hyper, type MutationSpec } from '../bot/util/fitness';
export interface PbtRound {
  index: number;
  /** Training block [trainFrom, trainTo) and evaluation block [evalFrom, evalTo). */
  trainFrom: number; trainTo: number; evalFrom: number; evalTo: number;
}

export interface PbtEval {
  report: FitnessReport; interactions: Interaction[]; extra?: Record<string, number>;
  /** What each of the member's parts made this round (e.g. per SNN column): summed until the next breeding,
   *  where an offspring takes each part from the parent whose part did better (genetic layer). */
  traits?: Record<string, number>;
}

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
  /** Genetic layer: an offspring's learned state from two parents (`a` the fitter), given what each parent's
   *  parts made since the last breeding. Must leave both parents unchanged. Default: a copy of `a`. */
  breed?(a: S, b: S, ctx: { traitsA: Record<string, number>; traitsB: Record<string, number>; r: () => number }): Promise<S> | S;
}

/** Genetic layer: breeding on top of the selection every `breedEvery` rounds (research/genetic.ts). */
export interface GeneticOpts {
  /** Survivors bred each generation (default 3: three offspring): the best over the generation, one
   *  offspring per pair. Replacing much more than a fifth of the population each generation did worse on
   *  noisy scores (docs/EVOLUTION.md). */
  parents?: number;
  /** Islands (default 1: one population). More splits the population into separate tournaments whose
   *  winners are the parents. On noisy scores islands converged more slowly than one population (see
   *  docs/EVOLUTION.md), so they are off unless asked for. */
  islands?: number;
  /** Rounds per generation. */
  breedEvery: number;
  /** An offspring's knob mutation (log-normal sd; default 0.03, about +/-3%). */
  mutation?: number;
  /** Tournament size when there is not room for an offspring of every pair (default 2). */
  tournament?: number;
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
  /** Genetic layer: the island this member fights in, what its parts made since the last breeding, and an
   *  offspring's two parents and the generation it was born in. */
  island?: number;
  traits?: Record<string, number>;
  parents?: [number, number];
  bornGen?: number;
}

export interface PbtRoundLog {
  round: number;
  evalFrom: string; evalTo: string;
  ranking: Array<{ member: number; fitness: number; sortino: number; maxDrawdown: number; costs: number; independent: number; hyper: Hyper }>;
  elite: number; culled: number; mutated: number[];
  /** Every member culled this round (populations of 4+ cull their worst quarter). */
  culledAll?: number[];
  /** Member that restarted fresh this round (exploration), if any. */
  restarted?: number;
  /** Worst-ranked member that was not culled because it is a newcomer still in its grace period. */
  spared?: number;
  /** Genetic layer: each island's selection this round, and the generation that ended with it. */
  islands?: Array<{ island: number; elite: number; culled: number[]; mutated: number[]; restarted?: number; spared?: number }>;
  breeding?: GaGeneration;
}

export interface PbtResult<S> {
  elite: PbtMember<S>;
  members: PbtMember<S>[];
  log: PbtRoundLog[];
  /** Total evaluations (members x rounds): the trial count for the deflated Sharpe ratio. */
  trials: number;
  /** Genetic layer state (when breeding runs). */
  ga?: GaState;
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
  resume?: { members: PbtMember<S>[]; trials: number; log: PbtRoundLog[]; ga?: GaState };
  /** Genetic layer: breeding (off unless given and the population has room: 6+ members). */
  genetic?: GeneticOpts;
  /** Also explore after the last round of this call (the tournament continues later). */
  exploreAfterLast?: boolean;
  /** Every N rounds the culled member restarts fresh with random knobs instead of cloning (0 = never). */
  restartEvery?: number;
  /** Rounds a restarted member cannot be culled (default 2): month-to-month fitness noise is larger
   *  than the gaps between members, so a newcomer needs a few evaluations before it can be judged. */
  restartGrace?: number;
  /** Members trained and evaluated at once (their hooks must not share mutable state; e.g. each replays
   *  in its own worker thread). 1 = one after another. */
  concurrency?: number;
  /** Called after every round (e.g. to persist the population). */
  onRound?: (state: { members: PbtMember<S>[]; trials: number; log: PbtRoundLog[]; round: PbtRound; ga?: GaState }) => Promise<void> | void;
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
  const grace = o.restartGrace ?? 2;
  // Genetic layer: parents bred every `breedEvery` rounds; with islands, each member's `island`.
  const islands = o.genetic ? islandCount(n, o.genetic.islands ?? 1) : 1;
  const parentsN = !o.genetic ? 0 : islands > 1 ? islands : parentCount(n, o.genetic.parents ?? 3);
  // A population without genetic state (new, or saved before breeding) starts its first generation now.
  const ga: GaState | undefined = parentsN >= 2 ? (o.resume?.ga ?? { ...newGaState(), lastBreed: (o.rounds[0]?.index ?? 0) - 1 }) : undefined;
  if (islands > 1 && members.some((m) => m.island === undefined || m.island < 0 || m.island >= islands)) members.forEach((m, i) => { m.island = i % islands; });

  // Selection inside one group (the whole population, or one island), ranked best first: the elite
  // survives, the worst member (in a group of 4+, the worst quarter) is culled, newcomers in their grace
  // period excepted, and clones one of the best (the elite first, then the runners-up); with `explore`,
  // the culled clone and the middle are then mutated, or (`restart`) the worst starts afresh.
  const selectIn = async (order: Array<{ m: PbtMember<S>; e: PbtEval }>, round: PbtRound, explore: boolean, restart: boolean) => {
    const size = order.length;
    const inGrace = (m: PbtMember<S>) => m.bornRound !== undefined && round.index - m.bornRound <= grace;
    const nCull = size >= 4 ? Math.floor(size / 4) : 1;
    const candidates = order.slice(1).map((x) => x.m);
    const cullList = [...candidates].reverse().filter((m) => !inGrace(m)).slice(0, nCull);
    if (!cullList.length) cullList.push(order[order.length - 1].m);
    const culled = cullList[0];
    const donors = order.slice(0, nCull).map((x) => x.m);
    const worst = order[order.length - 1].m;
    const middle = candidates.filter((m) => !cullList.includes(m));
    const mutated: number[] = [];
    let restarted: number | undefined;
    if (explore) {
      // Exploration member: every `restartEvery` rounds the worst network does not copy the elite but
      // starts afresh (new weights, random knobs within their ranges), so the population cannot
      // collapse onto one lineage and get stuck in its local optimum.
      if (restart) {
        culled.hyper = randomHyper(o.spec, o.base, r);
        culled.state = await o.hooks.init(culled.hyper, culled.id);
        culled.lineage = [culled.id];
        culled.record = [];
        culled.bornRound = round.index;
        if (ga) { culled.traits = {}; delete culled.parents; delete culled.bornGen; }
        restarted = culled.id;
      }
      // Every other culled member (and the worst, when it does not restart) clones a donor.
      const cloners = restart ? cullList.slice(1) : cullList;
      for (let k = 0; k < cloners.length; k++) {
        const c = cloners[k], d = donors[k % donors.length];
        c.state = await o.hooks.clone(d.state);
        c.hyper = { ...d.hyper };
        c.lineage = [...d.lineage, c.id];
        c.record = [...d.record];
        delete c.bornRound;
        if (ga) { c.traits = { ...(d.traits ?? {}) }; delete c.parents; delete c.bornGen; }
      }
      // A newcomer in its grace period keeps its knobs (it is being judged on them).
      for (const m of [...middle, ...cloners].filter((x) => !inGrace(x))) {
        m.hyper = perturb(m.hyper, o.spec, r, 'explore');
        if (o.hooks.rehyper) m.state = await o.hooks.rehyper(m.state, m.hyper);
        mutated.push(m.id);
      }
    }
    return { elite: order[0].m, culled, cullList, worst, mutated, restarted };
  };

  // Breeding: the parents (the best `parentsN` survivors over the generation, or each island's winner)
  // have one offspring per pair; the worst over the generation give up their slots (never one in `keep`).
  const breed = async (round: PbtRound, keep: number[]): Promise<{ gen: GaGeneration; traits: Record<string, GeneTrait>; slots: Set<number> }> => {
    const since = ga!.lastBreed;
    const genFitness = (m: PbtMember<S>) => { const s = m.scores.filter((x) => x.round > since); return s.length ? s.reduce((a, x) => a + x.fitness, 0) / s.length : -Infinity; };
    const cands = members.map((m) => ({ id: m.id, island: m.island ?? 0, fitness: genFitness(m), offspring: m.parents !== undefined && m.bornGen === ga!.generation }));
    // One population: the best `parentsN` over the generation stand as the "islands" whose winners breed.
    if (islands === 1) [...cands].sort((x, y) => y.fitness - x.fitness || x.id - y.id).forEach((c, i) => { c.island = Math.min(i, parentsN); });
    const plan = planBreeding(cands, parentsN, r, { tournament: o.genetic!.tournament, keep });
    const traits = geneTraits(ga!.genes, o.spec);
    const byId = new Map(members.map((m) => [m.id, m]));
    // Every offspring is built before any slot is handed over (the parents stay as they are).
    const kids: Array<{ slot: number; a: PbtMember<S>; b: PbtMember<S>; hyper: Hyper; state: S }> = [];
    for (const p of plan.pairs) {
      const a = byId.get(p.a)!, b = byId.get(p.b)!;
      const hyper = crossoverGenes(a.hyper, b.hyper, o.spec, r, { traits, mutation: o.genetic!.mutation });
      let state = o.hooks.breed ? await o.hooks.breed(a.state, b.state, { traitsA: a.traits ?? {}, traitsB: b.traits ?? {}, r }) : await o.hooks.clone(a.state);
      if (o.hooks.rehyper) state = await o.hooks.rehyper(state, hyper);
      kids.push({ slot: p.slot, a, b, hyper, state });
    }
    const generation = ga!.generation + 1;
    for (const k of kids) {
      const c = byId.get(k.slot)!;
      c.state = k.state; c.hyper = k.hyper; c.lineage = [...k.a.lineage, c.id]; c.record = [...k.a.record];
      c.parents = [k.a.id, k.b.id]; c.bornGen = generation;
      delete c.bornRound;
    }
    for (const m of members) { if (islands > 1) m.island = plan.islandOf.get(m.id) ?? m.island; m.traits = {}; }
    const offspringChampions = plan.champions.filter((c) => c.offspring).length;
    ga!.sinceOffspringWon = offspringChampions > 0 ? 0 : ga!.sinceOffspringWon + 1;
    ga!.generation = generation;
    ga!.lastBreed = round.index;
    const gen: GaGeneration = {
      generation, round: round.index,
      champions: plan.champions.map((c) => ({ member: c.id, island: islands > 1 ? c.island : 0, fitness: c.fitness, offspring: c.offspring })),
      offspring: kids.map((k) => ({ member: k.slot, parents: [k.a.id, k.b.id] as [number, number], island: islands > 1 ? plan.islandOf.get(k.slot) ?? 0 : 0 })),
      runnersUp: plan.runnersUp, offspringChampions,
    };
    ga!.history.push(gen);
    if (ga!.history.length > 200) ga!.history.splice(0, ga!.history.length - 200);
    return { gen, traits, slots: new Set(kids.map((k) => k.slot)) };
  };

  for (const round of o.rounds) {
    // Train + evaluate every member (up to `concurrency` at once); results applied in member order.
    const evals: PbtEval[] = new Array(members.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 1, members.length)) }, async () => {
      while (next < members.length) {
        const i = next++, m = members[i];
        m.state = await o.hooks.train(m.state, m.hyper, round);
        evals[i] = await o.hooks.evaluate(m.state, m.hyper, round);
      }
    }));
    members.forEach((m, i) => { trials++; m.record.push(...evals[i].interactions); m.scores.push({ round: round.index, fitness: evals[i].report.fitness }); });
    if (ga) {
      // What each member's parts made, and the trait memory (knobs vs rank within this round).
      members.forEach((m, i) => { for (const [k, v] of Object.entries(evals[i].traits ?? {})) { const t = (m.traits ??= {}); t[k] = (t[k] ?? 0) + v; } });
      const ranks = roundRanks(evals.map((e) => e.report.fitness));
      members.forEach((m, i) => ga.genes.push({ g: geneScale(o.spec, m.hyper), f: ranks[i] }));
      if (ga.genes.length > GENE_WINDOW) ga.genes.splice(0, ga.genes.length - GENE_WINDOW);
    }
    let order = members.map((m, i) => ({ m, e: evals[i] })).sort((a, b) => b.e.report.fitness - a.e.report.fitness);
    const elite = order[0].m;
    const entry: PbtRoundLog = {
      round: round.index, evalFrom: iso(round.evalFrom), evalTo: iso(round.evalTo),
      ranking: order.map(({ m, e }) => ({ member: m.id, fitness: e.report.fitness, sortino: e.report.sortino, maxDrawdown: e.report.maxDrawdown, costs: e.report.costs, independent: e.report.independent, hyper: { ...m.hyper } })),
      elite: elite.id, culled: elite.id, mutated: [],
    };
    // Exploration after every round except the final one; a resumed tournament explores between calls
    // too, so the population keeps evolving as new months arrive.
    const explore = (round !== o.rounds[o.rounds.length - 1] || o.exploreAfterLast === true) && n >= 2;
    const restart = (o.restartEvery ?? 0) > 0 && (round.index + 1) % o.restartEvery! === 0;
    let note = '';
    // A generation ends: the parents breed first, with the knobs that earned their places; the usual
    // selection then goes on among the others (the offspring are judged next round as they are).
    if (ga && explore && round.index - ga.lastBreed >= o.genetic!.breedEvery) {
      // Never handed over: the round's elite, and an exploration newcomer still in its grace period.
      const keep = [elite.id, ...members.filter((m) => m.bornRound !== undefined && round.index - m.bornRound <= grace).map((m) => m.id)];
      const { gen, traits, slots } = await breed(round, keep);
      entry.breeding = gen;
      order = order.filter((x) => !slots.has(x.m.id));
      const top = Object.entries(traits).filter(([, t]) => t.conf > 0).sort((a, b) => b[1].conf - a[1].conf).slice(0, 3);
      note = `generation ${gen.generation}: parents ${gen.champions.map((c) => `#${c.member}${c.offspring ? '*' : ''}`).join(' ')}, offspring ${gen.offspring.map((x) => `#${x.member}=#${x.parents[0]}x#${x.parents[1]}`).join(' ')}${gen.offspringChampions ? ` (${gen.offspringChampions} parent(s) were last generation's offspring)` : ''}${top.length ? `; winning traits ${top.map(([k, t]) => `${k}~${t.best.toPrecision(3)}`).join(' ')}` : ''}; `;
    }
    if (islands === 1) {
      const sel = await selectIn(order, round, explore, restart);
      entry.culled = sel.culled.id;
      if (sel.cullList.length > 1) entry.culledAll = sel.cullList.map((m) => m.id);
      if (sel.worst !== sel.culled) entry.spared = sel.worst.id;
      entry.mutated = sel.mutated;
      if (sel.restarted !== undefined) entry.restarted = sel.restarted;
      note += `#${sel.culled.id} ${entry.restarted !== undefined ? 'restarts fresh (exploration)' : 'clones it'}${entry.spared !== undefined ? ` (#${entry.spared} spared: newcomer)` : ''}`;
    } else {
      // Inside each island the usual selection; an exploration restart goes to one island in turn.
      const restartIsland = restart ? Math.floor((round.index + 1) / o.restartEvery!) % islands : -1;
      entry.islands = [];
      const culledAll: number[] = [];
      for (let isl = 0; isl < islands; isl++) {
        const group = order.filter((x) => x.m.island === isl);
        if (group.length < 2) continue;
        const sel = await selectIn(group, round, explore, isl === restartIsland);
        entry.islands.push({ island: isl, elite: sel.elite.id, culled: sel.cullList.map((m) => m.id), mutated: sel.mutated, ...(sel.restarted !== undefined ? { restarted: sel.restarted } : {}), ...(sel.worst !== sel.culled ? { spared: sel.worst.id } : {}) });
        culledAll.push(...sel.cullList.map((m) => m.id));
        entry.mutated.push(...sel.mutated);
        if (sel.restarted !== undefined) entry.restarted = sel.restarted;
      }
      entry.culled = culledAll[0] ?? elite.id;
      entry.culledAll = culledAll;
      note += `islands ${entry.islands.map((x) => `${x.island}:#${x.elite}`).join(' ')}${entry.restarted !== undefined ? `, #${entry.restarted} restarts fresh` : ''}`;
    }
    out.push(entry);
    await o.onRound?.({ members, trials, log: out, round, ga });
    log(`round ${round.index} (${entry.evalFrom}..${entry.evalTo}): ${entry.ranking.map((x) => `#${x.member} ${x.fitness.toFixed(2)}`).join(', ')}; elite #${elite.id}, ${note}`);
  }
  const lastRank = out[out.length - 1]?.ranking[0]?.member ?? 0;
  return { elite: members.find((m) => m.id === lastRank) ?? members[0], members, log: out, trials, ...(ga ? { ga } : {}) };
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

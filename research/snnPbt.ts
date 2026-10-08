// Population tournament that initialises the crypto and perps SNNs over the recordings (the tennis
// network's tournament runs live: bot/snn/population.ts). Three identical networks (same seed,
// same weights; knobs within +/-10%) replay the recorded days prequentially:
//
//   round 0   each member learns online through the first --init-days (training block)
//   round k   each member continues online through the next --eval-days; every output is made
//             before the label that could train on it, so this IS its out-of-sample evaluation.
//             Fitness on that block: Sortino - 5 x max drawdown - 5 x costs of simulated trades -
//               crypto: one quarter-Kelly bet per contract when p_snn beats the mid by 3c (fee 2c),
//                       contracts of one settlement window = one interaction;
//               perps:  quarter-Kelly even-odds bets on its direction calls (1% move, 5 bp cost),
//                       overlapping calls of one column within its horizon = one interaction.
//             Elite untouched; worst clones the elite's state and knobs; middle + clone mutate.
//
// The elite's knobs become the network's hyperparameters for the training step that follows
// (research/trainSnn.ts --hyper) and for the live network. The population is saved after every
// round, so a long tournament can run in chunks (--max-rounds) across pipeline runs.
//
// Genetic layer (`genetic`; research/genetic.ts): in a population of 6+ the best survivors breed every few
// rounds. An offspring takes each column -- one asset and horizon, a strategy of its own -- from the parent
// whose column made more over the generation (crypto, perps; a tennis network's columns are its matches,
// so a tennis offspring starts from the fitter parent's network), its knobs crossed from both parents and
// very slightly mutated.
//
//   npm run research:snn-pbt -- --recordings data/recordings --domain crypto --stage S5 [--days 7]

import { recordingDayList } from '../bot/marketdata/recordingFiles';
import type { TennisConfig } from '../bot/config';
import fs from 'fs';
import path from 'path';
import { MetaModel } from '../bot/model/metaModel';
import { loadCalendar } from '../bot/model/calendar';
import type { SnnCheckpoint } from '../bot/snn/network';
import { DEFAULT_SNN, domainParams, stageFlags, versionHash, withFlags, type SnnParams, type Stage } from '../bot/snn/params';
import { SNN_HYPER_SPEC, snnHyperOf, withSnnHyper } from '../bot/snn/population';
import { binaryBet, coverageFloor, fitnessOf, independentInteractions, type Hyper, type Interaction } from '../bot/util/fitness';

/** Least share of opportunities a tournament member must act on (sitting out must not win). */
export const SNN_MIN_COVERAGE = 0.05;
import { dsrOf } from './fitness';
import { runPbt, walkForwardRounds, type GeneticOpts, type PbtMember, type PbtRoundLog } from './pbt';
import { geneTraits, type GaGeneration, type GaState } from './genetic';
import { replaySnn, type SnnRow } from './snnReplay';
import type { SnnReplayJob, SnnReplayOut } from './snnReplayWorker';
import { WorkerPool, workerCount, workerScript } from './workerPool';

const DAY = 86_400_000;
const H = 3_600_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Simulated trades of one replay's rows (see the header). */
export function snnInteractions(rows: SnnRow[], domain: 'crypto' | 'perps' | 'tennis'): Interaction[] {
  const out: Interaction[] = [];
  // Contracts (crypto) and match markets (tennis): one bet per contract against its mid, settled by the result.
  if (domain !== 'perps') {
    const seen = new Set<string>();
    for (const r of [...rows].sort((a, b) => a.ts - b.ts)) {
      if (seen.has(r.ticker)) continue;
      const g = binaryBet(r.pSnn, r.mid, r.y);
      if (!g) continue;
      seen.add(r.ticker);
      out.push({ ts: r.ts, ret: g.ret, cost: g.cost, group: r.eventKey.split(':')[0], trait: r.column });
    }
    return out;
  }
  for (const r of rows) {
    const f = 0.25 * (2 * r.pSnn - 1);
    if (Math.abs(f) < 0.02) continue;
    const cost = 0.0005 * Math.abs(f);
    out.push({ ts: r.ts, ret: f * (2 * r.y - 1) * 0.01 - cost, cost, group: r.column, trait: r.column });
  }
  return out;
}

/** Interactions closer than this are one bet for the fitness's independence count. */
export const clusterFor = (domain: 'crypto' | 'perps' | 'tennis') => (domain === 'perps' ? 4 * H : H);

/** What each column's calls made (summed returns): the traits an offspring inherits column by column. */
export function columnTraits(xs: Interaction[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) if (x.trait) out[x.trait] = (out[x.trait] ?? 0) + x.ret;
  return out;
}

/** An offspring network's learned state from two parents (`a` the fitter): each column (one asset and
 *  horizon) from the parent whose column made more since the last breeding, everything shared across the
 *  columns (the cross-column weights, health, clock) from `a`. Neither parent is changed. */
export function crossColumns(a: SnnCheckpoint, b: SnnCheckpoint, traitsA: Record<string, number>, traitsB: Record<string, number>): { cp: SnnCheckpoint; fromB: string[] } {
  const out = JSON.parse(JSON.stringify(a)) as SnnCheckpoint;
  const other = new Map(b.columns.map((c) => [c.key, c]));
  const fromB: string[] = [];
  out.columns = out.columns.map((c) => {
    const o = other.get(c.key);
    if (!o || !((traitsB[c.key] ?? 0) > (traitsA[c.key] ?? 0))) return c;
    fromB.push(c.key);
    return JSON.parse(JSON.stringify(o)) as SnnCheckpoint['columns'][number];
  });
  return { cp: out, fromB };
}

interface MemberState { cp?: SnnCheckpoint; through: number }

interface Saved {
  domain: string; stage: string; baseVersion: string; trials: number; nextIndex: number; lastEvalTo: number; log: PbtRoundLog[];
  /** How the days were chosen (a different choice starts a fresh tournament). */
  layout?: string;
  /** The history-ledger generation these rounds belong to (research/historyLedger.ts). */
  generation?: string;
  /** The genetic layer's state (islands breeding). */
  ga?: GaState;
  members: Array<{ id: number; hyper: Hyper; lineage: number[]; through: number; record: Array<[number, number, number, string]>; scores: Array<{ round: number; fitness: number }>; bornRound?: number; island?: number; traits?: Record<string, number>; parents?: [number, number] }>;
}

export interface SnnPbtResult {
  domain: 'crypto' | 'perps' | 'tennis'; stage: Stage; complete: boolean; remaining: number; rounds: number; trials: number;
  elite: { member: number; hyper: Hyper; lineage: number[]; parents?: [number, number] };
  dsr: { sharpe: number; sr0: number; probability: number; n: number };
  log: PbtRoundLog[];
  /** Genetic layer: generations bred so far, the last one, generations since an offspring won its island,
   *  and the knob values that have kept winning (the trait memory, where it is confident). */
  ga?: { islands: number; generation: number; sinceOffspringWon: number; last?: GaGeneration; traits: Record<string, { best: number; rho: number; conf: number }> };
}

/** `n` of the sorted days `all` for a tournament: blocks of `block` consecutive days spread evenly from the
 *  first day to the last (the last block ends at the latest day), so every era of the history -- bull and
 *  bear markets, crashes, quiet years -- weighs in, not only the latest weeks. */
export function eraDays(all: string[], n: number, block: number): string[] {
  if (all.length <= n) return all;
  const k = Math.floor(n / block);
  if (k <= 1) return all.slice(-n);
  const out: string[] = [];
  for (let i = 0; i < k; i++) { const s = Math.round((i * (all.length - block)) / (k - 1)); out.push(...all.slice(s, s + block)); }
  return out;
}

/** Runs of consecutive calendar days. */
function segments(days: string[]): string[][] {
  const out: string[][] = [];
  for (const d of days) {
    const cur = out[out.length - 1];
    if (cur && Date.parse(d) - Date.parse(cur[cur.length - 1]) === DAY) cur.push(d); else out.push([d]);
  }
  return out;
}

export async function runSnnPbt(o: {
  recordings: string; domain: 'crypto' | 'perps' | 'tennis'; stage: Stage; days: string[]; initDays?: number; evalDays?: number;
  /** Every recorded day (the warm-up day before a block is the calendar day before it, when recorded). */
  allDays?: string[];
  /** How `days` were chosen (eraDays vs the latest days): a change starts a fresh tournament. */
  layout?: string;
  /** A history-ledger generation (research/historyLedger.ts): weeks the population has never trained on.
   *  A new id continues the saved population on its days -- every member keeps its knobs and its network
   *  -- with the rounds of those days only (they may lie before the weeks it last replayed). */
  generation?: string;
  /** The tennis config (required for the tennis domain: the engine's match inputs). */
  tennis?: TennisConfig;
  model?: MetaModel; seed?: number; stateDir?: string; maxRounds?: number; restartEvery?: number; fresh?: boolean; log?: (m: string) => void;
  /** Members in the population (default 3) and worker threads replaying them at once (default 1). With
   *  workers > 1 each member's replay runs in its own thread; `modelPath` is then the MLP's file. */
  population?: number; workers?: number; modelPath?: string;
  /** Breeding every few rounds (research/genetic.ts; populations of 6+). */
  genetic?: GeneticOpts;
}): Promise<SnnPbtResult> {
  const log = o.log ?? (() => {});
  const initDays = o.initDays ?? 3, evalDays = o.evalDays ?? 1;
  if (o.days.length < initDays + evalDays) throw new Error(`need at least ${initDays + evalDays} days of recordings for an SNN tournament (have ${o.days.length})`);
  const base: SnnParams = domainParams(o.domain, withFlags({ ...DEFAULT_SNN, seed: o.seed ?? DEFAULT_SNN.seed }, stageFlags(o.stage)));
  const baseVersion = versionHash(base);
  const start = Date.parse(`${o.days[0]}T00:00:00Z`);
  // Blocks across the years (eraDays): each run of consecutive days is walked forward on its own (its first
  // days train, the rest are judged), the members carrying their state from one run to the next. The latest
  // days: one walk from the first to the last (a missing day is just a round with nothing to judge).
  const spans = o.layout?.startsWith('era') || o.layout === 'ledger' ? segments(o.days) : [o.days];
  const all = spans.flatMap((seg) => walkForwardRounds(Date.parse(seg[0]), Date.parse(seg[seg.length - 1]) + DAY, initDays * DAY, evalDays * DAY, evalDays * DAY)).map((r, i) => ({ ...r, index: i }));
  const calendar = loadCalendar(path.resolve('params/calendar.json'));
  const dayOf = (t: number) => iso(t);
  const stateFile = o.stateDir ? path.join(o.stateDir, 'state.json') : undefined;
  const cpFile = (id: number) => path.join(o.stateDir!, `m${id}.json`);
  let saved: Saved | undefined;
  if (stateFile && !o.fresh && fs.existsSync(stateFile)) {
    try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (saved!.domain !== o.domain || saved!.stage !== o.stage || saved!.baseVersion !== baseVersion || saved!.members.length !== (o.population ?? 3) || (saved!.layout ?? 'latest') !== (o.layout ?? 'latest')) saved = undefined; } catch { saved = undefined; }
  }
  // A new ledger generation: the saved population moves on to new weeks (all their rounds to run).
  const newGen = Boolean(saved && o.generation && saved.generation !== o.generation);
  if (newGen) log(`${o.domain} SNN tournament: generation ${o.generation} on ${o.days.length} day(s) the population has never trained on (${saved!.log.length} rounds so far)`);
  let rounds = (saved && !newGen ? all.filter((r) => r.evalFrom >= saved!.lastEvalTo - 1) : all).map((r, k) => ({ ...r, index: (saved?.nextIndex ?? 0) + k }));
  const pending = rounds.length;
  if (o.maxRounds && o.maxRounds > 0) rounds = rounds.slice(0, o.maxRounds);
  const resume = saved ? {
    trials: saved.trials, log: saved.log,
    members: saved.members.map((m): PbtMember<MemberState> => ({
      id: m.id, hyper: m.hyper, lineage: m.lineage, scores: m.scores, bornRound: m.bornRound, record: m.record.map(([ts, ret, cost, group]) => ({ ts, ret, cost, group })),
      state: { through: newGen ? start : m.through, cp: fs.existsSync(cpFile(m.id)) ? JSON.parse(fs.readFileSync(cpFile(m.id), 'utf8')) : undefined },
      ...(m.island !== undefined ? { island: m.island } : {}), ...(m.traits ? { traits: m.traits } : {}), ...(m.parents ? { parents: m.parents } : {}),
    })),
    ga: saved.ga,
  } : undefined;
  log(`${o.domain} SNN tournament (stage ${o.stage}): ${o.days.length} recorded day(s), ${saved ? `continuing (${saved.log.length} rounds so far)` : `fresh population of ${o.population ?? 3}`}; ${rounds.length} round(s) to run${(o.workers ?? 1) > 1 ? `, ${o.workers} members at a time` : ''}`);
  const pool = (o.workers ?? 1) > 1 ? new WorkerPool<SnnReplayJob, SnnReplayOut>(workerScript('snnReplayWorker'), o.workers!) : undefined;

  const replay = async (s: MemberState, hyper: Hyper, from: number, to: number) => {
    if (to <= s.through) return { rows: [] as SnnRow[] };
    const a = Math.max(from, s.through);
    const params = withSnnHyper(base, hyper);
    const known = o.allDays ?? o.days;
    const prevDay = known[known.indexOf(dayOf(a)) - 1];
    if (pool) {
      const r = await pool.run({ dir: o.recordings, params, domain: o.domain, modelPath: o.modelPath, checkpoint: s.cp, from: a, to, fromDay: prevDay ?? dayOf(a), toDay: dayOf(to - 1), skipModel: true, tennis: o.tennis });
      s.cp = r.checkpoint;
      s.through = to;
      return { rows: r.rows };
    }
    // Fitness reads p_snn against the market only: the decision model's p_model is not computed.
    const r = await replaySnn(o.recordings, { params, domain: o.domain, model: o.model, calendar, checkpoint: s.cp, allowParamChange: true, from: a, to, fromDay: prevDay ?? dayOf(a), toDay: dayOf(to - 1), skipModel: true, tennis: o.tennis });
    s.cp = r.net.serialize();
    s.through = to;
    return r;
  };
  const save = (members: PbtMember<MemberState>[], trials: number, plog: PbtRoundLog[], lastEvalTo: number, nextIndex: number, ga?: GaState) => {
    if (!o.stateDir) return;
    fs.mkdirSync(o.stateDir, { recursive: true });
    for (const m of members) if (m.state.cp) fs.writeFileSync(cpFile(m.id), JSON.stringify(m.state.cp));
    const st: Saved = {
      domain: o.domain, stage: o.stage, baseVersion, trials, nextIndex, lastEvalTo, log: plog, layout: o.layout, generation: o.generation, ...(ga ? { ga } : {}),
      members: members.map((m) => ({ id: m.id, hyper: m.hyper, lineage: m.lineage, through: m.state.through, scores: m.scores, bornRound: m.bornRound, record: m.record.map((x) => [x.ts, x.ret, x.cost, x.group ?? ''] as [number, number, number, string]), ...(m.island !== undefined ? { island: m.island } : {}), ...(m.traits ? { traits: m.traits } : {}), ...(m.parents ? { parents: m.parents } : {}) })),
    };
    fs.writeFileSync(stateFile!, JSON.stringify(st));
  };
  const res = await runPbt<MemberState>({
    base: snnHyperOf(base), spec: SNN_HYPER_SPEC, rounds, seed: o.seed ?? 17, resume, exploreAfterLast: true, restartEvery: o.restartEvery ?? 0, log,
    population: o.population ?? 3, concurrency: pool ? o.workers : 1, genetic: o.genetic,
    hooks: {
      init: () => ({ through: start }),
      clone: (s) => ({ through: s.through, cp: s.cp ? JSON.parse(JSON.stringify(s.cp)) : undefined }),
      // An offspring: each column from the parent whose column made more (tennis: the fitter parent's network).
      breed: (a, b, ctx) => {
        if (!a.cp || !b.cp || o.domain === 'tennis') return { through: a.through, cp: a.cp ? JSON.parse(JSON.stringify(a.cp)) : undefined };
        const x = crossColumns(a.cp, b.cp, ctx.traitsA, ctx.traitsB);
        if (x.fromB.length) log(`${o.domain} offspring: column(s) ${x.fromB.join(', ')} from the second parent, the rest from the fitter one`);
        return { through: a.through, cp: x.cp };
      },
      train: async (s, h, r) => { await replay(s, h, r.trainFrom, r.trainTo); return s; },
      evaluate: async (s, h, r) => {
        const out = await replay(s, h, r.evalFrom, r.evalTo);
        const rows = out.rows.filter((x) => x.ts >= r.evalFrom && x.ts < r.evalTo);
        const xs = snnInteractions(rows, o.domain);
        // Opportunities: one per contract (crypto and tennis bet each contract at most once), one per step (perps).
        const opportunities = o.domain !== 'perps' ? new Set(rows.map((x) => x.ticker)).size : rows.length;
        const report = coverageFloor(fitnessOf(xs, { from: r.evalFrom, to: r.evalTo, clusterMs: clusterFor(o.domain) }), xs.length, opportunities, SNN_MIN_COVERAGE);
        return { report, interactions: independentInteractions(xs, clusterFor(o.domain)), traits: columnTraits(xs) };
      },
    },
    onRound: ({ members, trials, log: plog, round, ga }) => save(members, trials, plog, round.evalTo, round.index + 1, ga),
  }).finally(() => pool?.close());
  if (!rounds.length && resume) Object.assign(res, { members: resume.members, trials: resume.trials, log: resume.log, elite: resume.members.find((m) => m.id === resume.log[resume.log.length - 1]?.ranking[0]?.member) ?? resume.members[0] });
  const dsr = dsrOf(res.elite.record, clusterFor(o.domain), res.trials);
  log(`${o.domain} elite #${res.elite.id} (lineage ${res.elite.lineage.join('>')}); out-of-sample ${dsr.n} independent interactions, DSR probability ${Number.isFinite(dsr.probability) ? dsr.probability.toFixed(3) : 'n/a'} over ${res.trials} trials`);
  const ga = res.ga ?? (resume?.ga && o.genetic ? resume.ga : undefined);
  const traits = ga ? Object.fromEntries(Object.entries(geneTraits(ga.genes, SNN_HYPER_SPEC)).filter(([, t]) => t.conf > 0).map(([k, t]) => [k, { best: t.best, rho: t.rho, conf: t.conf }])) : {};
  return {
    domain: o.domain, stage: o.stage, complete: pending - rounds.length === 0, remaining: pending - rounds.length, rounds: res.log.length, trials: res.trials,
    elite: { member: res.elite.id, hyper: res.elite.hyper, lineage: res.elite.lineage, ...(res.elite.parents ? { parents: res.elite.parents } : {}) },
    dsr: { sharpe: dsr.sharpe, sr0: dsr.sr0, probability: dsr.probability, n: dsr.n }, log: res.log,
    ...(ga ? { ga: { islands: new Set(res.members.map((m) => m.island ?? 0)).size, generation: ga.generation, sinceOffspringWon: ga.sinceOffspringWon, last: ga.history[ga.history.length - 1], traits } } : {}),
  };
}

export async function snnPbtMain(argOf: (k: string, d: string) => string = cliArg): Promise<SnnPbtResult> {
  const dir = argOf('recordings', 'data/recordings');
  const domain = argOf('domain', 'crypto') as 'crypto' | 'perps' | 'tennis';
  const days = recordingDayList(dir);
  const n = Number(argOf('days', '7'));
  const modelPath = argOf('model', '');
  const res = await runSnnPbt({
    recordings: dir, domain, stage: argOf('stage', 'S5') as Stage, days: days.slice(-n), initDays: Number(argOf('init-days', '3')), evalDays: Number(argOf('eval-days', '1')),
    model: modelPath && fs.existsSync(modelPath) ? MetaModel.load(modelPath) : undefined, stateDir: argOf('state', '') || undefined,
    maxRounds: Number(argOf('max-rounds', '0')) || undefined, restartEvery: Number(argOf('restart-every', '0')), fresh: argOf('fresh', '') === 'true', log: (m) => console.log(`[snn-pbt] ${m}`),
    population: Number(argOf('population', '3')), workers: workerCount(), modelPath: modelPath && fs.existsSync(modelPath) ? modelPath : undefined,
    genetic: { parents: Number(argOf('parents', '3')), islands: Number(argOf('islands', '1')), breedEvery: Number(argOf('breed-every', '4')), mutation: Number(argOf('mutation', '0.03')) },
    tennis: domain === 'tennis' ? (await import('../bot/config')).loadConfig({ ...process.env, DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32), TRADING_MODE: 'paper' }).tennis : undefined,
  });
  const out = argOf('out', '');
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(res, null, 1)); }
  return res;
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

if (process.argv[1] && /snnPbt\.(ts|js|cjs)$/.test(process.argv[1])) void snnPbtMain().catch((e) => { console.error(e); process.exitCode = 1; });

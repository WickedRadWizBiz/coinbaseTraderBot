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
//   npm run research:snn-pbt -- --recordings data/recordings --domain crypto --stage S5 [--days 7]

import fs from 'fs';
import path from 'path';
import { MetaModel } from '../bot/model/metaModel';
import { loadCalendar } from '../bot/model/calendar';
import type { SnnCheckpoint } from '../bot/snn/network';
import { DEFAULT_SNN, domainParams, stageFlags, versionHash, withFlags, type SnnParams, type Stage } from '../bot/snn/params';
import { SNN_HYPER_SPEC, snnHyperOf, withSnnHyper } from '../bot/snn/population';
import { binaryBet, fitnessOf, independentInteractions, type Hyper, type Interaction } from '../bot/util/fitness';
import { dsrOf } from './fitness';
import { runPbt, walkForwardRounds, type PbtMember, type PbtRoundLog } from './pbt';
import { replaySnn, type SnnRow } from './snnReplay';

const DAY = 86_400_000;
const H = 3_600_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Simulated trades of one replay's rows (see the header). */
export function snnInteractions(rows: SnnRow[], domain: 'crypto' | 'perps'): Interaction[] {
  const out: Interaction[] = [];
  if (domain === 'crypto') {
    const seen = new Set<string>();
    for (const r of [...rows].sort((a, b) => a.ts - b.ts)) {
      if (seen.has(r.ticker)) continue;
      const g = binaryBet(r.pSnn, r.mid, r.y);
      if (!g) continue;
      seen.add(r.ticker);
      out.push({ ts: r.ts, ret: g.ret, cost: g.cost, group: r.eventKey.split(':')[0] });
    }
    return out;
  }
  for (const r of rows) {
    const f = 0.25 * (2 * r.pSnn - 1);
    if (Math.abs(f) < 0.02) continue;
    const cost = 0.0005 * Math.abs(f);
    out.push({ ts: r.ts, ret: f * (2 * r.y - 1) * 0.01 - cost, cost, group: r.column });
  }
  return out;
}

const clusterFor = (domain: 'crypto' | 'perps') => (domain === 'crypto' ? H : 4 * H);

interface MemberState { cp?: SnnCheckpoint; through: number }

interface Saved {
  domain: string; stage: string; baseVersion: string; trials: number; nextIndex: number; lastEvalTo: number; log: PbtRoundLog[];
  members: Array<{ id: number; hyper: Hyper; lineage: number[]; through: number; record: Array<[number, number, number, string]>; scores: Array<{ round: number; fitness: number }> }>;
}

export interface SnnPbtResult {
  domain: 'crypto' | 'perps'; stage: Stage; complete: boolean; remaining: number; rounds: number; trials: number;
  elite: { member: number; hyper: Hyper; lineage: number[] };
  dsr: { sharpe: number; sr0: number; probability: number; n: number };
  log: PbtRoundLog[];
}

export async function runSnnPbt(o: {
  recordings: string; domain: 'crypto' | 'perps'; stage: Stage; days: string[]; initDays?: number; evalDays?: number;
  model?: MetaModel; seed?: number; stateDir?: string; maxRounds?: number; fresh?: boolean; log?: (m: string) => void;
}): Promise<SnnPbtResult> {
  const log = o.log ?? (() => {});
  const initDays = o.initDays ?? 3, evalDays = o.evalDays ?? 1;
  if (o.days.length < initDays + evalDays) throw new Error(`need at least ${initDays + evalDays} days of recordings for an SNN tournament (have ${o.days.length})`);
  const base: SnnParams = domainParams(o.domain, withFlags({ ...DEFAULT_SNN, seed: o.seed ?? DEFAULT_SNN.seed }, stageFlags(o.stage)));
  const baseVersion = versionHash(base);
  const start = Date.parse(`${o.days[0]}T00:00:00Z`), end = Date.parse(`${o.days[o.days.length - 1]}T00:00:00Z`) + DAY;
  const all = walkForwardRounds(start, end, initDays * DAY, evalDays * DAY, evalDays * DAY);
  const calendar = loadCalendar(path.resolve('params/calendar.json'));
  const dayOf = (t: number) => iso(t);
  const stateFile = o.stateDir ? path.join(o.stateDir, 'state.json') : undefined;
  const cpFile = (id: number) => path.join(o.stateDir!, `m${id}.json`);
  let saved: Saved | undefined;
  if (stateFile && !o.fresh && fs.existsSync(stateFile)) {
    try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (saved!.domain !== o.domain || saved!.stage !== o.stage || saved!.baseVersion !== baseVersion) saved = undefined; } catch { saved = undefined; }
  }
  let rounds = (saved ? all.filter((r) => r.evalFrom >= saved!.lastEvalTo - 1) : all).map((r, k) => ({ ...r, index: (saved?.nextIndex ?? 0) + k }));
  const pending = rounds.length;
  if (o.maxRounds && o.maxRounds > 0) rounds = rounds.slice(0, o.maxRounds);
  const resume = saved ? {
    trials: saved.trials, log: saved.log,
    members: saved.members.map((m): PbtMember<MemberState> => ({
      id: m.id, hyper: m.hyper, lineage: m.lineage, scores: m.scores, record: m.record.map(([ts, ret, cost, group]) => ({ ts, ret, cost, group })),
      state: { through: m.through, cp: fs.existsSync(cpFile(m.id)) ? JSON.parse(fs.readFileSync(cpFile(m.id), 'utf8')) : undefined },
    })),
  } : undefined;
  log(`${o.domain} SNN tournament (stage ${o.stage}): ${o.days.length} recorded day(s), ${saved ? `continuing (${saved.log.length} rounds so far)` : 'fresh population of 3'}; ${rounds.length} round(s) to run`);

  const replay = async (s: MemberState, hyper: Hyper, from: number, to: number) => {
    if (to <= s.through) return { rows: [] as SnnRow[] };
    const a = Math.max(from, s.through);
    const params = withSnnHyper(base, hyper);
    const prevDay = o.days[o.days.indexOf(dayOf(a)) - 1];
    const r = await replaySnn(o.recordings, { params, domain: o.domain, model: o.model, calendar, checkpoint: s.cp, allowParamChange: true, from: a, to, fromDay: prevDay ?? dayOf(a), toDay: dayOf(to - 1) });
    s.cp = r.net.serialize();
    s.through = to;
    return r;
  };
  const save = (members: PbtMember<MemberState>[], trials: number, plog: PbtRoundLog[], lastEvalTo: number, nextIndex: number) => {
    if (!o.stateDir) return;
    fs.mkdirSync(o.stateDir, { recursive: true });
    for (const m of members) if (m.state.cp) fs.writeFileSync(cpFile(m.id), JSON.stringify(m.state.cp));
    const st: Saved = {
      domain: o.domain, stage: o.stage, baseVersion, trials, nextIndex, lastEvalTo, log: plog,
      members: members.map((m) => ({ id: m.id, hyper: m.hyper, lineage: m.lineage, through: m.state.through, scores: m.scores, record: m.record.map((x) => [x.ts, x.ret, x.cost, x.group ?? ''] as [number, number, number, string]) })),
    };
    fs.writeFileSync(stateFile!, JSON.stringify(st));
  };
  const res = await runPbt<MemberState>({
    base: snnHyperOf(base), spec: SNN_HYPER_SPEC, rounds, seed: o.seed ?? 17, resume, exploreAfterLast: true, log,
    hooks: {
      init: () => ({ through: start }),
      clone: (s) => ({ through: s.through, cp: s.cp ? JSON.parse(JSON.stringify(s.cp)) : undefined }),
      train: async (s, h, r) => { await replay(s, h, r.trainFrom, r.trainTo); return s; },
      evaluate: async (s, h, r) => {
        const out = await replay(s, h, r.evalFrom, r.evalTo);
        const xs = snnInteractions(out.rows.filter((x) => x.ts >= r.evalFrom && x.ts < r.evalTo), o.domain);
        return { report: fitnessOf(xs, { from: r.evalFrom, to: r.evalTo, clusterMs: clusterFor(o.domain) }), interactions: independentInteractions(xs, clusterFor(o.domain)) };
      },
    },
    onRound: ({ members, trials, log: plog, round }) => save(members, trials, plog, round.evalTo, round.index + 1),
  });
  if (!rounds.length && resume) Object.assign(res, { members: resume.members, trials: resume.trials, log: resume.log, elite: resume.members.find((m) => m.id === resume.log[resume.log.length - 1]?.ranking[0]?.member) ?? resume.members[0] });
  const dsr = dsrOf(res.elite.record, clusterFor(o.domain), res.trials);
  log(`${o.domain} elite #${res.elite.id} (lineage ${res.elite.lineage.join('>')}); out-of-sample ${dsr.n} independent interactions, DSR probability ${Number.isFinite(dsr.probability) ? dsr.probability.toFixed(3) : 'n/a'} over ${res.trials} trials`);
  return {
    domain: o.domain, stage: o.stage, complete: pending - rounds.length === 0, remaining: pending - rounds.length, rounds: res.log.length, trials: res.trials,
    elite: { member: res.elite.id, hyper: res.elite.hyper, lineage: res.elite.lineage },
    dsr: { sharpe: dsr.sharpe, sr0: dsr.sr0, probability: dsr.probability, n: dsr.n }, log: res.log,
  };
}

export async function snnPbtMain(argOf: (k: string, d: string) => string = cliArg): Promise<SnnPbtResult> {
  const dir = argOf('recordings', 'data/recordings');
  const domain = argOf('domain', 'crypto') as 'crypto' | 'perps';
  const days = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => /^md-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1]).filter((d): d is string => Boolean(d)).sort() : [];
  const n = Number(argOf('days', '7'));
  const modelPath = argOf('model', '');
  const res = await runSnnPbt({
    recordings: dir, domain, stage: argOf('stage', 'S5') as Stage, days: days.slice(-n), initDays: Number(argOf('init-days', '3')), evalDays: Number(argOf('eval-days', '1')),
    model: modelPath && fs.existsSync(modelPath) ? MetaModel.load(modelPath) : undefined, stateDir: argOf('state', '') || undefined,
    maxRounds: Number(argOf('max-rounds', '0')) || undefined, fresh: argOf('fresh', '') === 'true', log: (m) => console.log(`[snn-pbt] ${m}`),
  });
  const out = argOf('out', '');
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(res, null, 1)); }
  return res;
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

if (process.argv[1] && /snnPbt\.(ts|js|cjs)$/.test(process.argv[1])) void snnPbtMain().catch((e) => { console.error(e); process.exitCode = 1; });

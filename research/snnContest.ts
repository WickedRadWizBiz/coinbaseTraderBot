// Champion contest for an SNN: the challenger (just trained) and the network in use replay the same
// held-out days -- weeks neither has ever trained on (research/historyLedger.ts) -- each from its own model
// file, learning online as it would live, and are scored as tournament members are (simulated bets against
// the market, settled by the result; log growth, sitting out penalised). The challenger replaces the
// champion only if it scores better. Each day is replayed on its own (one job per network and day, the day
// before warming the trackers), so a contest of two weeks runs on every core at once.

import path from 'path';
import { loadCalendar } from '../bot/model/calendar';
import type { SnnModelFile } from '../bot/snn/network';
import { coverageFloor, fitnessOf } from '../bot/util/fitness';
import { clusterFor, SNN_MIN_COVERAGE, snnInteractions } from './snnPbt';
import { replaySnn, type SnnRow } from './snnReplay';
import type { SnnReplayJob, SnnReplayOut } from './snnReplayWorker';
import { WorkerPool, workerScript } from './workerPool';

const DAY = 86_400_000;

export interface ContestScore { fitness: number; interactions: number; netReturn: number; maxDrawdown: number; days: number }
export interface ContestResult { candidate: ContestScore; incumbent: ContestScore; winner: 'candidate' | 'incumbent'; reason: string; days: string[] }

/** Tournament fitness of one network's rows over the contest days. */
export function contestScore(rows: SnnRow[], domain: 'crypto' | 'perps', days: string[]): ContestScore {
  const xs = snnInteractions(rows, domain);
  const opportunities = domain === 'crypto' ? new Set(rows.map((r) => r.ticker)).size : rows.length;
  const from = Date.parse(`${days[0]}T00:00:00Z`), to = Date.parse(`${days[days.length - 1]}T00:00:00Z`) + DAY;
  const rep = coverageFloor(fitnessOf(xs, { from, to, clusterMs: clusterFor(domain) }), xs.length, opportunities, SNN_MIN_COVERAGE);
  return { fitness: rep.fitness, interactions: xs.length, netReturn: rep.netReturn, maxDrawdown: rep.maxDrawdown, days: days.length };
}

export async function snnContest(o: {
  recordings: string; domain: 'crypto' | 'perps'; candidate: SnnModelFile; incumbent: SnnModelFile;
  /** The held-out days; `allDays` every recorded day (for each day's warm-up day). */
  days: string[]; allDays: string[]; workers?: number; log?: (m: string) => void;
}): Promise<ContestResult> {
  const log = o.log ?? (() => {});
  const days = [...o.days].sort();
  const sides = { candidate: o.candidate, incumbent: o.incumbent } as const;
  const jobs: Array<{ side: keyof typeof sides; job: SnnReplayJob }> = [];
  for (const side of ['candidate', 'incumbent'] as const) {
    for (const d of days) {
      const from = Date.parse(`${d}T00:00:00Z`);
      const prev = o.allDays[o.allDays.indexOf(d) - 1];
      jobs.push({ side, job: { dir: o.recordings, params: sides[side].params, snnModel: sides[side], domain: o.domain, from, to: from + DAY, fromDay: prev ?? d, toDay: d, skipModel: true } });
    }
  }
  log(`${o.domain} SNN contest: challenger vs champion on ${days.length} held-out day(s) (${days[0]}..${days[days.length - 1]}), ${jobs.length} replays`);
  const rows = { candidate: [] as SnnRow[], incumbent: [] as SnnRow[] };
  const workers = Math.max(1, o.workers ?? 1);
  if (workers > 1) {
    const pool = new WorkerPool<SnnReplayJob, SnnReplayOut>(workerScript('snnReplayWorker'), workers);
    try { await Promise.all(jobs.map(async ({ side, job }) => { rows[side].push(...(await pool.run(job)).rows); })); } finally { await pool.close(); }
  } else {
    const calendar = loadCalendar(path.resolve('params/calendar.json'));
    for (const { side, job } of jobs) rows[side].push(...(await replaySnn(job.dir, { ...job, calendar, allowParamChange: true })).rows);
  }
  const candidate = contestScore(rows.candidate, o.domain, days), incumbent = contestScore(rows.incumbent, o.domain, days);
  const winner = candidate.fitness > incumbent.fitness ? 'candidate' : 'incumbent';
  const fmt = (s: ContestScore) => `fitness ${s.fitness.toFixed(4)} (${s.interactions} bets, net ${(100 * s.netReturn).toFixed(2)}%, max drawdown ${(100 * s.maxDrawdown).toFixed(1)}%)`;
  const reason = winner === 'candidate' ? `beats the network in use on held-out weeks: ${fmt(candidate)} vs ${fmt(incumbent)}` : `does not beat the network in use on held-out weeks: ${fmt(candidate)} vs ${fmt(incumbent)}`;
  log(`${o.domain} SNN contest: challenger ${reason}`);
  return { candidate, incumbent, winner, reason, days };
}

// Population-based training for the SNNs. Three identical networks (same seed, same weights) whose
// hyperparameters differ slightly fight for fitness; the elite is "the one network" for its contract
// type. Knobs mutated are those that keep every array's shape (learning rates, gains, time
// constants), so a culled member can take over the elite's learned state exactly.
//
// The crypto and perps networks run their tournament offline over the recordings
// (research/snnPbt.ts). The tennis network can only learn live (there is no recorded score feed),
// so its tournament runs here, live: all three members see every input; the engine reads the
// elite's outputs; each member is graded on simulated bets against the market mid at settlement
// (bot/util/fitness.ts binaryBet), and after every `roundSettles` graded matches:
//   elite  (best fitness)  untouched
//   culled (worst)         restarted from the elite's state with the elite's knobs, then mutated
//   middle                 restarted from its own state with mutated knobs
// The population (knobs, lineage, round log) survives restarts (<dir>/population.json).

import fs from 'fs';
import path from 'path';
import { logger } from '../util/log';
import { fitnessOf, perturb, binaryBet, type Hyper, type Interaction, type MutationSpec } from '../util/fitness';
import type { SnnHost, SnnHostLike } from './host';
import type { ColumnInput, ContractQuery, SnnCheckpoint } from './network';
import type { SnnParams } from './params';
import type { StepReply } from './runtime';

const log = logger('snn-population');

/** Shape-preserving SNN knobs and their ranges. */
export const SNN_HYPER_SPEC: MutationSpec = {
  readoutEta: { min: 1e-6, max: 1e-2 },
  dirEta: { min: 1e-4, max: 5e-2 },
  dirCap: { min: 0.002, max: 0.1 },
  deltaGain: { min: 0.3, max: 4 },
  l1Gain: { min: 0.3, max: 4 },
  tauRateL1: { min: 2, max: 3600 },
  tauRateL23: { min: 5, max: 7200 },
  surpriseTau: { min: 5, max: 3600 },
  eta: { min: 0.002, max: 0.5 },
  pcLambda: { min: 1e-5, max: 1e-1 },
};

export function snnHyperOf(p: SnnParams): Hyper {
  return Object.fromEntries(Object.keys(SNN_HYPER_SPEC).map((k) => [k, (p as unknown as Record<string, number>)[k]]));
}

export function withSnnHyper(p: SnnParams, h: Hyper | undefined): SnnParams {
  if (!h) return p;
  const out = { ...p } as unknown as Record<string, unknown>;
  for (const k of Object.keys(SNN_HYPER_SPEC)) if (Number.isFinite(h[k])) out[k] = h[k];
  return out as unknown as SnnParams;
}

/** Deterministic RNG for the live tournament's mutations. */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

export interface PopulationOpts {
  base: SnnParams;
  /** Build a member's host (its own worker and checkpoint dir); `seed` = state to start from. */
  makeHost: (params: SnnParams, member: number, seed?: SnnCheckpoint) => SnnHost;
  dir: string;
  roundSettles: number;
  seed?: number;
  size?: number;
  now?: () => number;
}

interface Member {
  id: number;
  hyper: Hyper;
  host?: SnnHost;
  lineage: number[];
  /** ticker -> the first snapshot where this member's p beat the mid by the bet edge. */
  bets: Map<string, { p: number; mid: number; ts: number }>;
  /** Graded bets since the last tournament round. */
  graded: Interaction[];
  restarting: boolean;
}

interface Saved {
  members: Array<{ id: number; hyper: Hyper; lineage: number[] }>;
  elite: number;
  rounds: Array<{ ts: number; ranking: Array<{ member: number; fitness: number; bets: number }>; elite: number; culled: number }>;
  rngState: number;
}

export class SnnPopulationHost implements SnnHostLike {
  private members: Member[] = [];
  private elite = 0;
  private rounds: Saved['rounds'] = [];
  private gradedSinceRound = 0;
  private r: () => number;
  private rngCalls = 0;
  timeouts = 0;
  lastError?: string;
  restoredFrom?: string | null;

  constructor(private readonly o: PopulationOpts) {
    this.r = lcg(o.seed ?? 17);
  }

  private get file() { return path.join(this.o.dir, 'population.json'); }
  private rand(): number { this.rngCalls++; return this.r(); }
  private get eliteMember(): Member { return this.members.find((m) => m.id === this.elite) ?? this.members[0]; }

  get version(): string { return this.eliteMember?.host?.version ?? 'population'; }
  get mode(): string { return `population of ${this.members.length} (${this.eliteMember?.host?.mode ?? 'starting'})`; }

  async start(now = Date.now()): Promise<void> {
    let saved: Saved | undefined;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Saved; } catch { /* first start */ }
    const base = snnHyperOf(this.o.base);
    if (saved?.members?.length) {
      for (let i = 0; i < saved.rngState; i++) this.r();
      this.rngCalls = saved.rngState;
      this.members = saved.members.map((m) => ({ id: m.id, hyper: m.hyper, lineage: m.lineage, bets: new Map(), graded: [], restarting: false }));
      this.elite = saved.elite;
      this.rounds = saved.rounds ?? [];
      this.restoredFrom = `population: ${this.rounds.length} round(s), elite #${this.elite}`;
    } else {
      // Three identical networks: member 0 = the base knobs, members 1-2 within +/-10% of them.
      const n = this.o.size ?? 3;
      for (let i = 0; i < n; i++) this.members.push({ id: i, hyper: i === 0 ? base : perturb(base, SNN_HYPER_SPEC, () => this.rand(), 'init'), lineage: [i], bets: new Map(), graded: [], restarting: false });
      this.restoredFrom = 'population: initialised (3 members)';
    }
    for (const m of this.members) { m.host = this.o.makeHost(withSnnHyper(this.o.base, m.hyper), m.id); await m.host.start(now); }
    this.save();
  }

  private save(): void {
    const s: Saved = { members: this.members.map((m) => ({ id: m.id, hyper: m.hyper, lineage: m.lineage })), elite: this.elite, rounds: this.rounds.slice(-50), rngState: this.rngCalls };
    try {
      fs.mkdirSync(this.o.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s));
      fs.renameSync(tmp, this.file);
    } catch (e) { this.lastError = `population save: ${(e as Error).message}`; }
  }

  async stepAndScore(now: number, inputs: ColumnInput[], queries: ContractQuery[]): Promise<StepReply | undefined> {
    const replies = await Promise.all(this.members.map((m) => (m.host && !m.restarting ? m.host.stepAndScore(now, inputs, queries) : Promise.resolve(undefined))));
    const mid = new Map(queries.map((q) => [q.ticker, q.mid]));
    replies.forEach((rep, k) => {
      if (!rep) return;
      const m = this.members[k];
      for (const sc of rep.scores) {
        const md = mid.get(sc.ticker);
        if (md === undefined || m.bets.has(sc.ticker)) continue;
        if (Math.abs(sc.p - md) >= 0.03) m.bets.set(sc.ticker, { p: sc.p, mid: md, ts: now });
      }
    });
    const ei = this.members.findIndex((m) => m.id === this.elite);
    const out = replies[ei] ?? replies.find(Boolean);
    if (!replies[ei]) this.timeouts++;
    return out;
  }

  p99(): number { return this.eliteMember?.host?.p99() ?? 0; }
  latencyOk(): boolean { return this.eliteMember?.host?.latencyOk() ?? false; }

  async settle(ticker: string, result: 'yes' | 'no', now: number): Promise<void> {
    await Promise.all(this.members.map((m) => m.host?.settle(ticker, result, now)));
    let any = false;
    for (const m of this.members) {
      const b = m.bets.get(ticker);
      if (!b) continue;
      m.bets.delete(ticker);
      const g = binaryBet(b.p, b.mid, result === 'yes' ? 1 : 0);
      if (g) { m.graded.push({ ts: now, ret: g.ret, cost: g.cost, group: ticker }); any = true; }
    }
    if (any) this.gradedSinceRound++;
    if (this.gradedSinceRound >= this.o.roundSettles) await this.tournament(now);
  }

  /** One round: rank by fitness on the bets graded since the last round, then exploit / explore. */
  async tournament(now: number): Promise<void> {
    this.gradedSinceRound = 0;
    const scored = this.members.map((m) => ({ m, f: fitnessOf(m.graded, { clusterMs: 3_600_000 }) })).sort((a, b) => b.f.fitness - a.f.fitness);
    const elite = scored[0].m, culled = scored[scored.length - 1].m, middle = scored.slice(1, -1).map((x) => x.m);
    this.rounds.push({ ts: now, ranking: scored.map((x) => ({ member: x.m.id, fitness: +x.f.fitness.toFixed(4), bets: x.m.graded.length })), elite: elite.id, culled: culled.id });
    this.elite = elite.id;
    for (const m of this.members) m.graded = [];
    log.info('tennis SNN tournament round', { round: this.rounds.length, ranking: this.rounds[this.rounds.length - 1].ranking, elite: elite.id, culled: culled.id });
    const eliteState = await elite.host?.snapshot();
    const restart = async (m: Member, state: SnnCheckpoint | undefined, hyper: Hyper) => {
      m.restarting = true;
      try {
        await m.host?.stop(now);
        m.hyper = perturb(hyper, SNN_HYPER_SPEC, () => this.rand(), 'explore');
        m.host = this.o.makeHost(withSnnHyper(this.o.base, m.hyper), m.id, state);
        await m.host.start(now);
      } catch (e) { this.lastError = `population restart #${m.id}: ${(e as Error).message}`; }
      m.restarting = false;
    };
    if (culled !== elite) {
      culled.lineage = [...elite.lineage, culled.id];
      culled.bets = new Map(elite.bets);
      await restart(culled, eliteState, elite.hyper);
    }
    for (const m of middle) await restart(m, await m.host?.snapshot(), m.hyper);
    this.save();
  }

  async remove(keys: string[]): Promise<void> { await Promise.all(this.members.map((m) => m.host?.remove(keys))); }

  async status(): Promise<unknown> {
    return {
      population: {
        elite: this.elite, roundSettles: this.o.roundSettles, gradedSinceRound: this.gradedSinceRound,
        members: this.members.map((m) => ({ id: m.id, hyper: m.hyper, lineage: m.lineage, openBets: m.bets.size, gradedBets: m.graded.length, version: m.host?.version })),
        rounds: this.rounds.slice(-10),
      },
      network: await this.eliteMember?.host?.status(),
    };
  }

  async checkpoint(now = Date.now()): Promise<string | undefined> {
    const files = await Promise.all(this.members.map((m) => m.host?.checkpoint(now)));
    this.save();
    return files.find(Boolean);
  }

  async stop(now = Date.now()): Promise<void> {
    await Promise.all(this.members.map((m) => m.host?.stop(now)));
    this.save();
  }
}

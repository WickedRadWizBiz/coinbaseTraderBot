// Genetic layer of the tournaments: crossover, trait memory, the breeding plan, islands in runPbt, and the
// SNN offspring that inherit whole columns.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { SnnCheckpoint } from '../bot/snn/network';
import type { MutationSpec } from '../bot/util/fitness';
import { crossoverGenes, geneScale, geneTraits, islandCount, parentCount, planBreeding, roundRanks, spearman, type GeneSample } from '../research/genetic';
import { runPbt, type PbtRound } from '../research/pbt';
import { columnTraits, crossColumns, runSnnPbt } from '../research/snnPbt';
import { rng } from '../research/stats';
import { writeSyntheticRecordings } from '../research/synthetic';
import { tmpDir } from './helpers';

const DAY = 86_400_000;
const SPEC: MutationSpec = { lr: { min: 1e-4, max: 1e-1 }, tau: { min: 1, max: 1000 }, k: { min: 1, max: 20, integer: true } };

test('crossover: each knob mostly from one parent, a little of the other, very slightly mutated, within its limits', () => {
  const r = rng(5);
  const a = { lr: 1e-3, tau: 10, k: 4, other: 7 }, b = { lr: 1e-2, tau: 100, k: 12, other: 9 };
  let nearA = 0;
  for (let i = 0; i < 2000; i++) {
    const c = crossoverGenes(a, b, SPEC, r);
    for (const [key, s] of Object.entries(SPEC)) {
      assert.ok(c[key] >= s.min && c[key] <= s.max, `${key} within its limits`);
      const lo = Math.log(Math.min(a[key as 'lr'], b[key as 'lr'])), hi = Math.log(Math.max(a[key as 'lr'], b[key as 'lr']));
      assert.ok(Math.log(c[key]) > lo - 0.2 && Math.log(c[key]) < hi + 0.2, `${key} between the parents (plus a slight mutation)`);
    }
    assert.equal(Number.isInteger(c.k), true);
    assert.equal(c.other, 7, 'knobs outside the spec come from the fitter parent');
    if (Math.abs(Math.log(c.lr / a.lr)) < Math.abs(Math.log(c.lr / b.lr))) nearA++;
  }
  assert.ok(nearA > 1100 && nearA < 1400, `the fitter parent slightly favoured (${nearA} of 2000 nearer it)`);
  const same = crossoverGenes(a, a, SPEC, r, { mutation: 0 });
  for (const k of Object.keys(a) as Array<keyof typeof a>) assert.ok(Math.abs(same[k] / a[k] - 1) < 1e-12, `identical parents and no mutation: the same ${k}`);
  // The trait memory pulls a knob towards where the winners' values sit.
  let towardB = 0;
  for (let i = 0; i < 2000; i++) {
    const c = crossoverGenes(a, b, SPEC, r, { traits: { tau: { center: Math.log(100), best: 100, rho: 0.6, conf: 1, n: 500 } } });
    if (Math.abs(Math.log(c.tau / 100)) < Math.abs(Math.log(c.tau / 10))) towardB++;
  }
  assert.ok(towardB > 1300, `a winning trait is passed down (${towardB} of 2000 took the parent nearer it)`);
});

test('trait memory: finds the knob values that keep winning, and ignores knobs that do not matter', () => {
  const r = rng(9);
  const samples: GeneSample[] = [];
  for (let round = 0; round < 60; round++) {
    const hs = Array.from({ length: 8 }, () => ({ lr: Math.exp(Math.log(1e-4) + r() * Math.log(1e3)), tau: Math.exp(r() * Math.log(1000)), k: 1 + Math.floor(r() * 20) }));
    // Fitness peaks at lr = 1e-2; tau and k do nothing.
    const fit = hs.map((h) => -((Math.log(h.lr) - Math.log(1e-2)) ** 2) + 0.3 * (r() - 0.5));
    const ranks = roundRanks(fit);
    hs.forEach((h, i) => samples.push({ g: geneScale(SPEC, h), f: ranks[i] }));
  }
  const t = geneTraits(samples, SPEC);
  assert.ok(t.lr.conf > 0.5, `confident about lr (${t.lr.conf})`);
  assert.ok(Math.abs(Math.log(t.lr.best / 1e-2)) < 1, `lr's winning region near 1e-2 (${t.lr.best})`);
  assert.equal(t.tau.conf, 0, 'no confidence in a knob that does not matter');
  assert.equal(t.k.conf, 0);
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [10, 20, 30, 40]) - 1) < 1e-12);
  assert.deepEqual(roundRanks([3, 1, 2]), [1, 0, 0.5]);
});

test('breeding plan: island winners breed in every pair, the best runners-up stay, the worst make room, islands balanced', () => {
  assert.deepEqual([islandCount(3, 4), islandCount(6, 4), islandCount(8, 4), islandCount(12, 4), islandCount(15, 4), islandCount(16, 4), islandCount(15, 1)], [1, 2, 2, 4, 4, 4, 1]);
  assert.deepEqual([parentCount(3, 3), parentCount(5, 3), parentCount(6, 3), parentCount(8, 3), parentCount(15, 3), parentCount(15, 4), parentCount(15, 0)], [0, 0, 2, 3, 3, 4, 0], 'no breeding in the classic three-network tournament');
  // 15 networks in 4 islands; fitness = id (14 is the best).
  const cands = Array.from({ length: 15 }, (_, id) => ({ id, island: id % 4, fitness: id, offspring: false }));
  const plan = planBreeding(cands, 4, rng(3));
  assert.deepEqual(plan.champions.map((c) => c.id), [14, 13, 12, 11], 'the best of each island');
  assert.equal(plan.pairs.length, 6, 'one offspring for every pair of the 4 champions');
  assert.deepEqual(plan.pairs.map((p) => [p.a, p.b]), [[14, 13], [14, 12], [14, 11], [13, 12], [13, 11], [12, 11]], 'the fitter parent first');
  assert.deepEqual(plan.pairs.map((p) => p.slot).sort((x, y) => x - y), [0, 1, 2, 3, 4, 5], 'the six worst give their slots');
  assert.deepEqual(plan.runnersUp, [10, 9, 8, 7, 6], 'the best of the rest stay');
  const sizes = [0, 1, 2, 3].map((i) => [...plan.islandOf.values()].filter((x) => x === i).length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `islands balanced (${sizes})`);
  for (let i = 0; i < 4; i++) assert.equal(plan.champions.filter((c) => plan.islandOf.get(c.id) === i).length, 1, 'one champion per island');
  // A network the tournament reports as its elite never gives up its slot.
  const kept = planBreeding(cands, 4, rng(3), { keep: [0] });
  assert.ok(!kept.pairs.some((p) => p.slot === 0) && kept.runnersUp.includes(0));
  // Not enough room for every pair: pairs by tournament selection, no pair twice.
  const small = planBreeding(Array.from({ length: 15 }, (_, id) => ({ id, island: id % 5, fitness: id, offspring: false })), 5, rng(4));
  assert.equal(small.champions.length, 5);
  assert.equal(small.pairs.length, 9, '15 - 5 champions - 1 runner-up');
  assert.equal(new Set(small.pairs.map((p) => `${p.a}-${p.b}`)).size, 9);
});

test('islands (optional): their winners breed every few rounds, offspring carry both parents, the generation count persists', async () => {
  // A learned state that grows each round, and fitness that peaks at lr = 0.01, tau = 30.
  const rounds: PbtRound[] = Array.from({ length: 12 }, (_, i) => ({ index: i, trainFrom: i * DAY, trainTo: (i + 1) * DAY, evalFrom: (i + 1) * DAY, evalTo: (i + 2) * DAY }));
  const noise = rng(11);
  const fit = (h: { lr: number; tau: number }) => -((Math.log(h.lr / 0.01)) ** 2) - (Math.log(h.tau / 30)) ** 2 + 0.05 * (noise() - 0.5);
  const breeds: Array<{ traitsA: Record<string, number>; traitsB: Record<string, number> }> = [];
  const hooks = {
    init: () => ({ learned: 0, cols: { A: 0, B: 0 } }),
    clone: (s: { learned: number; cols: Record<string, number> }) => ({ learned: s.learned, cols: { ...s.cols } }),
    train: (s: { learned: number; cols: Record<string, number> }) => { s.learned++; return s; },
    evaluate: (_s: unknown, h: Record<string, number>) => {
      const f = fit(h as { lr: number; tau: number });
      return { report: { fitness: f, sortino: f, maxDrawdown: 0, costs: 0, independent: 1, netReturn: 0, n: 1 } as never, interactions: [], traits: { A: f, B: -f } };
    },
    breed: (a: { learned: number; cols: Record<string, number> }, b: { learned: number; cols: Record<string, number> }, ctx: { traitsA: Record<string, number>; traitsB: Record<string, number> }) => {
      breeds.push({ traitsA: ctx.traitsA, traitsB: ctx.traitsB });
      return { learned: Math.max(a.learned, b.learned), cols: { A: (ctx.traitsB.A ?? 0) > (ctx.traitsA.A ?? 0) ? b.cols.A : a.cols.A, B: a.cols.B } };
    },
  };
  const spec: MutationSpec = { lr: { min: 1e-4, max: 1 }, tau: { min: 1, max: 1000 } };
  let saved: { ga?: unknown } = {};
  const res = await runPbt({ base: { lr: 0.001, tau: 300 }, spec, rounds: rounds.slice(0, 8), hooks, seed: 3, population: 12, genetic: { islands: 4, breedEvery: 4 }, exploreAfterLast: true, onRound: ({ ga }) => { saved = { ga: JSON.parse(JSON.stringify(ga)) }; } });
  assert.equal(new Set(res.members.map((m) => m.island)).size, 4, 'four islands');
  const bred = res.log.filter((l) => l.breeding);
  assert.deepEqual(bred.map((l) => l.round), [3, 7], 'a generation every 4 rounds');
  assert.equal(bred[0].breeding!.champions.length, 4);
  assert.equal(bred[0].breeding!.offspring.length, 6, 'one offspring per pair of the 4 island winners');
  assert.equal(breeds.length, 12);
  assert.ok(breeds.every((b) => Object.keys(b.traitsA).length === 2), 'each parent arrives with what its parts made over the generation');
  const kids = res.members.filter((m) => m.parents && m.bornGen === res.ga!.generation);
  assert.equal(kids.length, 6, 'the last generation\'s offspring');
  for (const k of kids) {
    assert.ok(k.parents![0] !== k.parents![1]);
    assert.equal(k.lineage[k.lineage.length - 1], k.id);
  }
  assert.equal(res.ga!.generation, 2);
  assert.equal((saved.ga as { generation: number }).generation, 2, 'saved after every round');
  // Resumed: the generation count carries on.
  const again = await runPbt({ base: { lr: 0.001, tau: 300 }, spec, rounds: rounds.slice(8), hooks, seed: 3, population: 12, genetic: { islands: 4, breedEvery: 4 }, exploreAfterLast: true, resume: { members: res.members, trials: res.trials, log: res.log, ga: res.ga } });
  assert.equal(again.ga!.generation, 3);
  assert.ok(again.log.some((l) => l.round === 11 && l.breeding), 'the next generation 4 rounds later');
  // Breeding moves the population towards the knobs that win.
  const dist = (h: Record<string, number>) => Math.abs(Math.log(h.lr / 0.01)) + Math.abs(Math.log(h.tau / 30));
  const first = res.log[0].ranking.map((x) => dist(x.hyper)), last = again.log[again.log.length - 1].ranking.map((x) => dist(x.hyper));
  assert.ok(Math.min(...last) < Math.min(...first), `best knobs closer to the optimum (${Math.min(...first).toFixed(2)} -> ${Math.min(...last).toFixed(2)})`);
  // A small population is the classic tournament.
  const classic = await runPbt({ base: { lr: 0.001, tau: 300 }, spec, rounds: rounds.slice(0, 4), hooks, seed: 3, population: 3, genetic: { islands: 4, breedEvery: 2 } });
  assert.equal(classic.ga, undefined);
  assert.ok(classic.log.every((l) => !l.breeding && !l.islands));
});

test('breeding on top of the selection (default): the 3 best over each generation have an offspring per pair; the elite is never replaced', async () => {
  const rounds: PbtRound[] = Array.from({ length: 8 }, (_, i) => ({ index: i, trainFrom: i * DAY, trainTo: (i + 1) * DAY, evalFrom: (i + 1) * DAY, evalTo: (i + 2) * DAY }));
  const noise = rng(21);
  const hooks = {
    init: () => ({}), clone: () => ({}), train: (st: object) => st,
    evaluate: (_s: object, h: Record<string, number>) => { const f = -((Math.log(h.lr / 0.01)) ** 2) + 0.05 * (noise() - 0.5); return { report: { fitness: f, sortino: f, maxDrawdown: 0, costs: 0, independent: 1 } as never, interactions: [] }; },
  };
  const res = await runPbt({ base: { lr: 0.001 }, spec: { lr: { min: 1e-4, max: 1 } }, rounds, hooks, seed: 5, population: 15, genetic: { breedEvery: 4 } });
  const bred = res.log.filter((l) => l.breeding);
  assert.deepEqual(bred.map((l) => l.round), [3], 'one generation ended (the last round explores nothing)');
  const g = bred[0].breeding!;
  assert.equal(g.champions.length, 3);
  assert.equal(g.offspring.length, 3, 'one offspring per pair of the three');
  assert.ok(!bred[0].islands, 'one population');
  // The parents are the best by mean fitness over the generation.
  const mean = (id: number) => { const s = res.members.find((m) => m.id === id)!.scores.filter((x) => x.round <= 3); return s.reduce((a, x) => a + x.fitness, 0) / s.length; };
  const others = res.members.map((m) => m.id).filter((id) => !g.champions.some((c) => c.member === id));
  assert.ok(g.champions.every((c) => others.every((o) => mean(c.member) >= mean(o) - 1e-12)));
  assert.ok(!g.offspring.some((x) => x.member === bred[0].elite), 'the round\'s elite keeps its slot');
  assert.equal(res.ga!.generation, 1);
});

test('SNN offspring: each column from the parent whose column made more; the parents are left as they were', () => {
  const col = (key: string, tag: string) => ({ key, asset: key.slice(0, 3), arrays: { w1: tag }, scalars: {}, inputs: null, readout: { wf: tag, ws: tag, trace: tag, traceTs: 0, brierFast: null, brierSlow: null, updates: 0, history: [], tags: [] } });
  const cp = (tag: string): SnnCheckpoint => ({ version: 'v', lastTs: 1, steps: 1, salience: {}, top: null, wc: [], corr: [], health: {} as never, lastTag: [], columns: [col('BTC-15m', tag), col('ETH-15m', tag)] } as unknown as SnnCheckpoint);
  const a = cp('A'), b = cp('B');
  const x = crossColumns(a, b, { 'BTC-15m': 0.5, 'ETH-15m': -0.2 }, { 'BTC-15m': 0.1, 'ETH-15m': 0.3 });
  assert.deepEqual(x.fromB, ['ETH-15m']);
  assert.deepEqual(x.cp.columns.map((c) => c.arrays.w1), ['A', 'B'], 'BTC from the fitter parent, ETH from the other');
  assert.equal(a.columns[1].arrays.w1, 'A', 'parent A unchanged');
  x.cp.columns[1].arrays.w1 = 'changed';
  assert.equal(b.columns[1].arrays.w1, 'B', 'parent B unchanged');
  assert.deepEqual(crossColumns(a, b, {}, {}).fromB, [], 'no record: everything from the fitter parent');
  assert.deepEqual(columnTraits([{ ts: 1, ret: 0.02, cost: 0, trait: 'BTC-15m' }, { ts: 2, ret: -0.01, cost: 0, trait: 'BTC-15m' }, { ts: 3, ret: 0.05, cost: 0, trait: 'ETH-15m' }, { ts: 4, ret: 1, cost: 0 }]), { 'BTC-15m': 0.01, 'ETH-15m': 0.05 });
});

test('SNN tournament with breeding: offspring bred on the recorded days, saved and continued', async () => {
  const rec = tmpDir();
  for (let d = 0; d < 4; d++) writeSyntheticRecordings(rec, { windows: 1, seed: 51 + d, start: Date.parse('2026-02-01T00:00:00Z') + d * DAY });
  const days = ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04'];
  const state = path.join(tmpDir(), 'pbt');
  const o = { recordings: rec, domain: 'crypto' as const, stage: 'S1' as const, days, initDays: 1, evalDays: 1, stateDir: state, population: 6, genetic: { breedEvery: 1 } };
  const r1 = await runSnnPbt({ ...o, maxRounds: 2 });
  assert.equal(r1.ga?.islands, 1, 'one population');
  assert.equal(r1.ga?.generation, 2, 'a generation after every round (breedEvery 1)');
  assert.equal(r1.ga?.last?.offspring.length, 1, 'six networks: two parents, one offspring');
  const st = JSON.parse(fs.readFileSync(path.join(state, 'state.json'), 'utf8'));
  assert.equal(st.ga.generation, 2);
  assert.ok(st.members.some((m: { parents?: number[] }) => m.parents), 'the offspring and its parents are saved');
  const r2 = await runSnnPbt(o);
  assert.equal(r2.complete, true);
  assert.equal(r2.ga?.generation, 3, 'continued from the saved generation');
});

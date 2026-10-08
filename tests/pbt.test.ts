// Population-based training: the generic tournament (elite / cull / mutate, lineage records, trial
// counting, resume), fitness and the statistical hurdles, the SNN replay tournament, and the live
// tennis population.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SnnHost } from '../bot/snn/host';
import { SnnNetwork } from '../bot/snn/network';
import { DEFAULT_SNN, domainParams, versionHash, withFlags, type SnnParams } from '../bot/snn/params';
import { SNN_HYPER_SPEC, SnnPopulationHost, snnHyperOf, withSnnHyper } from '../bot/snn/population';
import { binaryBet, fitnessOf, independentInteractions, maxDrawdown, perturb, sortino } from '../bot/util/fitness';
import { dsrOf, regimeOf, regimeReport, REGIMES } from '../research/fitness';
import { runPbt, walkForwardRounds } from '../research/pbt';
import { runSnnPbt, snnInteractions } from '../research/snnPbt';
import { writeSyntheticRecordings } from '../research/synthetic';
import { tmpDir } from './helpers';

const H = 3_600_000, DAY = 86_400_000;

test('fitness: Sortino, drawdown, costs, independent interactions, regimes, DSR', () => {
  const t0 = Date.UTC(2024, 0, 1);
  // 15 trades in one volatility spike count as ONE independent interaction.
  const burst = Array.from({ length: 15 }, (_, i) => ({ ts: t0 + i * 60_000, ret: 0.001, cost: 0.0001, group: 'BTC' }));
  assert.equal(independentInteractions(burst, H).length, 1);
  assert.equal(independentInteractions([...burst, { ts: t0 + 5 * H, ret: 0.001, cost: 0, group: 'BTC' }, { ts: t0, ret: 0, cost: 0, group: 'ETH' }], H).length, 3);
  assert.equal(maxDrawdown([0.1, -0.5, 0.2]), 0.5);
  assert.ok(sortino([0.01, -0.005, 0.02, 0.01]) > 0);
  const f = fitnessOf(burst, { clusterMs: H });
  assert.ok(Math.abs(f.fitness - f.growth!) < 1e-12, 'default objective: log growth');
  assert.ok(Math.abs(f.growth! - 365 * Math.log(1.015)) < 1e-9, 'one day of +1.5%');
  const fs = fitnessOf(burst, { clusterMs: H, weights: { objective: 'sortino', ddWeight: 5, costWeight: 5 } });
  assert.ok(Math.abs(fs.fitness - (fs.sortino - 5 * fs.maxDrawdown - 5 * fs.costs)) < 1e-12);
  assert.equal(fitnessOf([], { from: t0, to: t0 + DAY, clusterMs: H }).fitness, 0, 'no trades = cash = 0');
  assert.equal(regimeOf(Date.UTC(2022, 5, 1))!.id, 'c2-markdown');
  assert.equal(regimeOf(Date.UTC(2026, 5, 1))!.id, 'c3-distribution');
  assert.equal(REGIMES.length, 8);
  const daily = Array.from({ length: 400 }, (_, i) => ({ ts: Date.UTC(2021, 0, 1) + i * DAY, ret: (i % 3 === 0 ? -1 : 1) * 0.01 + 0.002, cost: 0, group: 'x' }));
  const rr = regimeReport(daily, H, 100);
  assert.deepEqual(rr.map((r) => r.regime), ['c2-markup', 'c2-markdown']);
  assert.equal(rr[0].enough, true);
  const d1 = dsrOf(daily, H, 1), d100 = dsrOf(daily, H, 100);
  assert.ok(d100.sr0 > d1.sr0 && d100.probability < d1.probability, 'more trials -> stricter deflated Sharpe');
  // Binary bet: quarter Kelly net of the fee, only past the edge.
  assert.equal(binaryBet(0.52, 0.5, 1), undefined);
  const w = binaryBet(0.7, 0.5, 1)!, l = binaryBet(0.7, 0.5, 0)!;
  assert.ok(w.ret > 0 && l.ret < 0 && l.ret >= -0.1);
  assert.ok(binaryBet(0.2, 0.5, 0)!.ret > 0, 'NO side wins when YES loses');
});

test('tournament: identical start, elite survives, worst clones elite, middle + clone mutate, lineage, trials, resume', async () => {
  // Toy members: state = a number that training moves toward the hyper "target"; fitness = closeness to 3.
  const rounds = walkForwardRounds(0, 10 * DAY, 2 * DAY, DAY, DAY);
  assert.equal(rounds.length, 8);
  assert.ok(rounds.every((r) => r.trainTo === r.evalFrom && r.evalTo - r.evalFrom === DAY));
  const spec = { target: { min: 0.1, max: 10 } };
  const inits: number[] = [];
  const hooks = {
    init: (h: Record<string, number>) => { inits.push(h.target); return { x: 0 }; },
    clone: (s: { x: number }) => ({ x: s.x }),
    train: (s: { x: number }, h: Record<string, number>) => { s.x += 0.5 * (h.target - s.x); return s; },
    evaluate: (s: { x: number }, _h: Record<string, number>, r: { evalFrom: number }) => {
      const fit = -Math.abs(s.x - 3);
      return { report: { fitness: fit, sortino: fit, maxDrawdown: 0, costs: 0, netReturn: 0, interactions: 1, independent: 1, days: 1 }, interactions: [{ ts: r.evalFrom, ret: fit, cost: 0 }] };
    },
  };
  const first = await runPbt({ base: { target: 1 }, spec, rounds: rounds.slice(0, 3), hooks, seed: 5, exploreAfterLast: true });
  assert.equal(inits[0], 1, 'member 0 = the base');
  assert.ok(inits.slice(1).every((t) => t >= 0.9 && t <= 1.1), 'members 1-2 within +/-10%');
  const l0 = first.log[0];
  assert.notEqual(l0.elite, l0.culled);
  assert.equal(l0.mutated.length, 2);
  assert.ok(!l0.mutated.includes(l0.elite), 'the elite is never mutated');
  const culled = first.members.find((m) => m.id === first.log[2].culled)!;
  assert.deepEqual(culled.lineage.slice(0, -1), first.members.find((m) => m.id === first.log[2].elite)!.lineage, 'a clone inherits the elite lineage');
  assert.equal(first.trials, 9);
  const rest = await runPbt({ base: { target: 1 }, spec, rounds: rounds.slice(3), hooks, seed: 5, resume: { members: first.members, trials: first.trials, log: first.log } });
  assert.equal(rest.trials, 24);
  assert.equal(rest.log.length, 8);
  assert.ok(Math.abs(rest.elite.hyper.target - 1) > 0.15, `evolution moved the knob toward 3 (target ${rest.elite.hyper.target})`);
  assert.ok(rest.elite.record.length >= rest.log.length, 'out-of-sample record of the lineage');
});

test('exploration member: every N rounds the worst network restarts fresh with random knobs', async () => {
  const rounds = walkForwardRounds(0, 10 * DAY, 2 * DAY, DAY, DAY);
  const spec = { target: { min: 0.1, max: 10 } };
  const inits: Array<{ target: number; id: number }> = [];
  const hooks = {
    init: (h: Record<string, number>, id: number) => { inits.push({ target: h.target, id }); return { x: 0 }; },
    clone: (s: { x: number }) => ({ x: s.x }),
    train: (s: { x: number }, h: Record<string, number>) => { s.x += 0.5 * (h.target - s.x); return s; },
    evaluate: (s: { x: number }, _h: Record<string, number>, r: { evalFrom: number }) => {
      const fit = -Math.abs(s.x - 3);
      return { report: { fitness: fit, sortino: fit, maxDrawdown: 0, costs: 0, netReturn: 0, interactions: 1, independent: 1, days: 1 }, interactions: [{ ts: r.evalFrom, ret: fit, cost: 0 }] };
    },
  };
  const res = await runPbt({ base: { target: 1 }, spec, rounds: rounds.slice(0, 6), hooks, seed: 5, restartEvery: 3, exploreAfterLast: true });
  const restarted = res.log.filter((l) => l.restarted !== undefined);
  assert.deepEqual(restarted.map((l) => l.round), [2, 5], 'rounds 3 and 6 (1-based) restart the culled member');
  for (const l of restarted) {
    assert.equal(l.restarted, l.culled);
    assert.equal(l.mutated.length, 1, 'only the middle member mutates on a restart round');
    assert.ok(!l.mutated.includes(l.culled));
  }
  assert.equal(inits.length, 5, '3 initial members + 2 fresh restarts');
  // Grace period: a fresh member (x = 0, far from the optimum) ranks last at first, but for two
  // rounds the next-worst member is culled instead and the newcomer keeps its knobs.
  const born = restarted[0];
  for (const l of res.log.filter((x) => x.round === born.round + 1 || x.round === born.round + 2)) {
    assert.notEqual(l.culled, born.restarted, `newcomer #${born.restarted} culled in its grace period (round ${l.round})`);
    assert.ok(!l.mutated.includes(born.restarted!), 'a newcomer in its grace period is not mutated');
    if (l.ranking[l.ranking.length - 1].member === born.restarted) assert.equal(l.spared, born.restarted);
  }
  assert.ok(res.log.some((l) => l.spared === born.restarted), 'the newcomer was spared at least once');
  assert.ok(inits.slice(3).every((x) => x.target >= 0.1 && x.target <= 10));
  // A restarted member starts its own lineage and an empty out-of-sample record.
  const last = res.members.find((m) => m.id === restarted[restarted.length - 1].culled)!;
  assert.deepEqual(last.lineage, [last.id]);
  assert.equal(last.record.length, 0);
});

test('SNN knobs: shape-preserving mutation, clone into a mutated network', () => {
  const p = withFlags({ ...DEFAULT_SNN, nE: 32, nI: 8, nL1: 12, maxColumns: 4 }, {});
  const h = snnHyperOf(p);
  assert.deepEqual(Object.keys(h).sort(), Object.keys(SNN_HYPER_SPEC).sort());
  let s = 3;
  const m = perturb(h, SNN_HYPER_SPEC, () => { s = (s * 16807) % 2147483647; return s / 2147483647; }, 'explore');
  const q = withSnnHyper(p, m);
  assert.notEqual(versionHash(q), versionHash(p));
  assert.equal(q.nE, p.nE);
  const a = new SnnNetwork(p);
  for (let k = 0; k < 30; k++) a.step(Date.UTC(2026, 0, 1) + k * 1000, [{ key: 'BTC-15m', asset: 'BTC', price: 60000 + k, values: {} }]);
  const cp = a.serialize();
  const b = new SnnNetwork(q);
  assert.throws(() => b.restore(cp), /does not match/);
  b.restore(cp, { allowParamChange: true });
  assert.equal(b.columns.size, 1);
});

test('SNN replay tournament: crypto rows -> bets, rounds over recorded days, saved and continued', async () => {
  const rec = tmpDir();
  for (let d = 0; d < 3; d++) writeSyntheticRecordings(rec, { windows: 6, seed: 3 + d, start: Date.parse('2026-02-01T00:00:00Z') + d * DAY });
  const rows = [{ ticker: 'A', eventKey: 'BTC:1', column: 'BTC-15m', ts: 1, day: 'x', kind: 'updown', pModel: 0.5, pSnn: 0.7, mid: 0.5, y: 1 as const, surprise: 0, surprise0: 1, G: 1, volRatio: 1 }];
  assert.equal(snnInteractions([...rows, { ...rows[0], ts: 2 }], 'crypto').length, 1, 'one bet per contract');
  assert.equal(snnInteractions([{ ...rows[0], pSnn: 0.51 }], 'perps').length, 0);
  const days = ['2026-02-01', '2026-02-02', '2026-02-03'];
  const state = path.join(tmpDir(), 'pbt');
  const r1 = await runSnnPbt({ recordings: rec, domain: 'crypto', stage: 'S1', days, initDays: 1, evalDays: 1, stateDir: state, maxRounds: 1 });
  assert.equal(r1.complete, false);
  assert.equal(r1.trials, 3);
  assert.ok(fs.existsSync(path.join(state, 'state.json')) && fs.existsSync(path.join(state, 'm0.json')));
  const r2 = await runSnnPbt({ recordings: rec, domain: 'crypto', stage: 'S1', days, initDays: 1, evalDays: 1, stateDir: state });
  assert.equal(r2.complete, true);
  assert.equal(r2.rounds, 2);
  assert.equal(r2.trials, 6);
  assert.deepEqual(Object.keys(r2.elite.hyper).sort(), Object.keys(SNN_HYPER_SPEC).sort());
  await assert.rejects(runSnnPbt({ recordings: rec, domain: 'perps', stage: 'S1', days: days.slice(0, 1), initDays: 1, evalDays: 1 }), /need at least/);
});

test('SNN tournament over blocks across the years: each block walked on its own (its first day trains), the members carried across', async () => {
  const rec = tmpDir();
  for (let d = 0; d < 5; d++) writeSyntheticRecordings(rec, { windows: 1, seed: 9 + d, start: Date.parse('2026-02-01T00:00:00Z') + d * DAY });
  const all = ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05'];
  const days = ['2026-02-01', '2026-02-02', '2026-02-04', '2026-02-05'];
  const era = await runSnnPbt({ recordings: rec, domain: 'crypto', stage: 'S1', days, allDays: all, layout: 'era:2', initDays: 1, evalDays: 1, stateDir: path.join(tmpDir(), 'pbt') });
  assert.equal(era.rounds, 2, 'two blocks, one judged day each');
  assert.deepEqual(era.log.map((r) => new Date(r.evalFrom).toISOString().slice(0, 10)), ['2026-02-02', '2026-02-05']);
  const latest = await runSnnPbt({ recordings: rec, domain: 'crypto', stage: 'S1', days, initDays: 1, evalDays: 1 });
  assert.equal(latest.rounds, 4, 'the latest days: one walk from the first day to the last');
  // A tournament saved under another way of choosing its days starts afresh.
  const state = path.join(tmpDir(), 'pbt2');
  await runSnnPbt({ recordings: rec, domain: 'crypto', stage: 'S1', days: all.slice(0, 2), initDays: 1, evalDays: 1, stateDir: state });
  const switched = await runSnnPbt({ recordings: rec, domain: 'crypto', stage: 'S1', days, allDays: all, layout: 'era:2', initDays: 1, evalDays: 1, stateDir: state });
  assert.equal(switched.rounds, 2);
});

test('tennis population: three live members, elite outputs, tournament after graded matches, restarts, persisted', async () => {
  const dir = tmpDir();
  const base: SnnParams = domainParams('tennis', withFlags({ ...DEFAULT_SNN, nE: 32, nI: 8, nL1: 12 }, {}));
  const made: Array<{ member: number; seeded: boolean }> = [];
  const pop = new SnnPopulationHost({
    base, dir, roundSettles: 3, seed: 4,
    makeHost: (p, member, seed) => { made.push({ member, seeded: Boolean(seed) }); return new SnnHost({ params: p, timeoutMs: 1000, latencySkipP99Ms: 1000, checkpointDir: path.join(dir, `m${member}`), checkpointEveryMin: 1e9, keepCheckpoints: 2, seedCheckpoint: seed }); },
  });
  const t0 = Date.UTC(2026, 3, 1);
  await pop.start(t0);
  assert.equal(made.length, 3);
  const st0 = (await pop.status()) as { population: { members: Array<{ hyper: Record<string, number> }> } };
  assert.deepEqual(st0.population.members[0].hyper, snnHyperOf(base), 'member 0 = the base knobs');
  let now = t0;
  for (let m = 0; m < 4; m++) {
    const key = `TEN:EV${m}`, ticker = `EV${m}-A`;
    for (let s = 0; s < 40; s++) {
      now += 1000;
      const rep = await pop.stepAndScore(now, [{ key, asset: 'TENNIS', price: 0.5, values: { momentum: 0.01 * (m % 2 ? 1 : -1), modelPA: 0.5 } }],
        [{ ticker, mid: 0.3, column: key, kind: 'match', d: Math.log(0.8 / 0.2), lifeFrac: 0.5, spot: 0, sigma: 0, tauSec: 0, lifeSec: 0, eventKey: ticker, tag: true }]);
      assert.ok(rep, 'the elite answers');
    }
    await pop.settle(ticker, m % 2 ? 'yes' : 'no', now);
    await pop.remove([key]);
  }
  const st = (await pop.status()) as { population: { rounds: Array<{ elite: number; culled: number }> } };
  assert.ok(st.population.rounds.length >= 1, 'a tournament round ran');
  assert.ok(made.length > 3 && made.slice(3).every((x) => x.seeded), 'restarted members start from a learned state');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'population.json'), 'utf8'));
  assert.equal(saved.members.length, 3);
  await pop.stop(now);
  const again = new SnnPopulationHost({ base, dir, roundSettles: 3, seed: 4, makeHost: (p, member, seed) => new SnnHost({ params: p, timeoutMs: 1000, latencySkipP99Ms: 1000, checkpointDir: path.join(dir, `m${member}`), checkpointEveryMin: 1e9, keepCheckpoints: 2, seedCheckpoint: seed }) });
  await again.start(now);
  assert.match(String(again.restoredFrom), /round/);
  await again.stop(now);
});

test('tournament of 8 run 4 at a time: members overlap, the worst quarter clones the best two, same result as one at a time', async () => {
  const rounds = walkForwardRounds(0, 10 * DAY, 2 * DAY, DAY, DAY);
  const run = async (concurrency: number) => {
    let active = 0, peak = 0;
    const r = await runPbt<{ k: number }>({
      base: { lr: 1 }, spec: { lr: { min: 0.1, max: 10, log: true } } as never, rounds, seed: 5, population: 8, concurrency,
      hooks: {
        init: (h) => ({ k: h.lr }), clone: (s) => ({ ...s }),
        train: async (s, h) => { active++; peak = Math.max(peak, active); await new Promise((res) => setTimeout(res, 5)); active--; s.k = h.lr; return s; },
        evaluate: (s, _h, rd) => { const f = -Math.abs(Math.log(s.k)) + rd.index * 0; return { report: { fitness: f, sortino: f, maxDrawdown: 0, costs: 0, independent: 1 } as never, interactions: [] }; },
      },
    });
    return { r, peak };
  };
  const a = await run(4), b = await run(1);
  assert.equal(a.peak, 4, 'four members in flight at once');
  assert.equal(b.peak, 1);
  assert.equal(a.r.members.length, 8);
  assert.equal(a.r.trials, 8 * rounds.length);
  const first = a.r.log[0];
  assert.equal(first.culledAll!.length, 2, 'population of 8: the worst two are culled');
  assert.deepEqual(a.r.log.map((x) => x.ranking.map((y) => y.member)), b.r.log.map((x) => x.ranking.map((y) => y.member)), 'concurrency does not change the outcome');
});

test('SNN tournament with worker threads: a bigger population replays in parallel and matches the in-process result', async () => {
  const rec = tmpDir();
  for (let d = 0; d < 3; d++) writeSyntheticRecordings(rec, { windows: 4, seed: 9 + d, start: Date.parse('2026-02-01T00:00:00Z') + d * DAY });
  const days = ['2026-02-01', '2026-02-02', '2026-02-03'];
  const opts = { recordings: rec, domain: 'crypto' as const, stage: 'S1' as const, days, initDays: 1, evalDays: 1, maxRounds: 1, population: 4 };
  const inProc = await runSnnPbt({ ...opts, workers: 1 });
  const threaded = await runSnnPbt({ ...opts, workers: 2 });
  assert.equal(threaded.trials, 4);
  assert.deepEqual(threaded.log[0].ranking.map((x) => +x.fitness.toFixed(9)), inProc.log[0].ranking.map((x) => +x.fitness.toFixed(9)));
});

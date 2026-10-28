// History walk (research/historyWalk.ts): blocks sized by the measured pace and held a week back, where the walk stands
// (walk.json, or the population's own when it got further), the server lease, the learning pause of the holdout days,
// the health reference taken afresh, and a population walking two blocks as one stretch of time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_HEALTH, recalibrated, SnnHealth, type HealthSample } from '../bot/snn/health';
import type { SnnNetwork } from '../bot/snn/network';
import { DEFAULT_SNN, domainParams, stageFlags, withFlags } from '../bot/snn/params';
import { inHoldoutWeek, isHoldout, weekBlocks } from '../research/historyLedger';
import { leaseCommand, planBlock, readWalk, recordBlock, WALK_START, walkEnd, writeWalk, type WalkState } from '../research/historyWalk';
import { runSnnPbt, walkRounds } from '../research/snnPbt';
import { replaySnn } from '../research/snnReplay';
import { writeSyntheticRecordings } from '../research/synthetic';
import { trainSnnMain } from '../research/trainSnn';
import { tmpDir } from './helpers';

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(Date.parse(`${d}T00:00:00Z`) + n * DAY);

test('history walk: a block is sized by the measured pace, 20 to 90 days, and never walks the newest week', () => {
  const st: WalkState = { version: 1, net: 'crypto', next: '2026-01-01', blocks: [] };
  assert.equal(walkEnd('2026-10-28'), '2026-10-21');
  // No pace measured yet: 10 minutes a day, so 240 minutes buy 24 days.
  const p = planBlock(st, { today: '2026-10-28', minutes: 240 })!;
  assert.deepEqual([p.days.length, p.days[0], p.days[23], p.warmUp], [24, '2026-01-01', '2026-01-24', '2025-12-31']);
  assert.equal(p.behind, 293 - 24, 'the days left to walk after it, up to 2026-10-20');
  assert.equal(planBlock({ ...st, secPerDay: 60 }, { today: '2026-10-28', minutes: 240 })!.days.length, 90, 'at most 90 days');
  assert.equal(planBlock({ ...st, secPerDay: 3600 }, { today: '2026-10-28', minutes: 240 })!.days.length, 20, 'at least 20 days');
  const end = planBlock({ ...st, next: '2026-10-15' }, { today: '2026-10-28', minutes: 240 })!;
  assert.deepEqual([end.days.length, end.days[end.days.length - 1], end.behind], [6, '2026-10-20', 0], 'never into the week held back');
  assert.equal(planBlock({ ...st, next: '2026-10-21' }, { today: '2026-10-28', minutes: 240 }), undefined, 'caught up');
});

test('history walk: a walked block moves the position on and measures the pace; one that walked nothing only slows it', () => {
  const st: WalkState = { version: 1, net: 'perps', next: '2026-01-01', blocks: [] };
  const a = recordBlock(st, { from: '2026-01-01', walkedTo: '2026-01-21', judged: 18, minutes: 200, by: 'github-1', elite: 2, fitness: 0.5 }, Date.parse('2026-10-28T12:00:00Z'));
  assert.equal(a.next, '2026-01-21');
  assert.equal(a.secPerDay, 600, '200 minutes for 20 days');
  assert.deepEqual(a.blocks, [{ from: '2026-01-01', to: '2026-01-20', days: 20, judged: 18, minutes: 200, by: 'github-1', at: '2026-10-28T12:00:00.000Z', elite: 2, fitness: 0.5 }]);
  const b = recordBlock(a, { from: '2026-01-21', judged: 0, minutes: 30, by: 'laptop' });
  assert.deepEqual([b.next, b.blocks.length, b.secPerDay], ['2026-01-21', 1, 0.5 * 600 + 0.5 * 1800]);
});

test('history walk: where it stands is the population\'s own when the population got further', () => {
  const dir = tmpDir();
  assert.deepEqual(readWalk(dir, 'crypto'), { version: 1, net: 'crypto', next: WALK_START.crypto, blocks: [] });
  writeWalk(dir, { version: 1, net: 'crypto', next: '2018-01-10', blocks: [] });
  fs.mkdirSync(path.join(dir, 'pbt'));
  const pbt = (layout: string, day: string) => fs.writeFileSync(path.join(dir, 'pbt', 'state.json'), JSON.stringify({ layout, lastEvalTo: Date.parse(`${day}T00:00:00Z`) }));
  pbt('walk', '2018-01-14');
  assert.equal(readWalk(dir, 'crypto').next, '2018-01-14', 'a run that stopped after saving rounds, before writing walk.json');
  pbt('walk', '2018-01-02');
  assert.equal(readWalk(dir, 'crypto').next, '2018-01-10');
  pbt('latest', '2018-02-14');
  assert.equal(readWalk(dir, 'crypto').next, '2018-01-10', 'another kind of tournament does not count');
  assert.equal(readWalk(dir, 'perps').next, WALK_START.perps, 'nor another network\'s walk');
});

test('history walk: the lease lets one walker at a time take a network, and only its holder gives it back', () => {
  const home = tmpDir();
  const sh = (cmd: string) => spawnSync('bash', ['-c', cmd], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  const file = path.join(home, 'bot', 'data', 'locks', 'walk-crypto.lease');
  assert.equal(sh(leaseCommand('take', 'crypto', 'github-1', 60)).status, 0);
  const [exp, who] = fs.readFileSync(file, 'utf8').trim().split(' ');
  assert.equal(who, 'github-1');
  assert.ok(Math.abs(Number(exp) - (Date.now() / 1000 + 3600)) < 60, 'held for its time to live');
  const busy = sh(leaseCommand('take', 'crypto', 'laptop'));
  assert.equal(busy.status, 3);
  assert.match(busy.stdout, /held by github-1/);
  assert.equal(sh(leaseCommand('take', 'perps', 'laptop')).status, 0, 'each network has a lease of its own');
  assert.equal(sh(leaseCommand('take', 'crypto', 'github-1')).status, 0, 'its holder may take it again');
  assert.equal(sh(leaseCommand('give', 'crypto', 'laptop')).status, 0);
  assert.ok(fs.existsSync(file), 'only its holder gives it back');
  assert.equal(sh(leaseCommand('give', 'crypto', 'github-1')).status, 0);
  assert.ok(!fs.existsSync(file));
  // A walker that died: its lease runs out and the next walker takes it.
  fs.writeFileSync(file, `${Math.floor(Date.now() / 1000) - 5} github-2\n`);
  assert.equal(sh(leaseCommand('take', 'crypto', 'laptop')).status, 0);
  assert.throws(() => leaseCommand('take', 'crypto', 'a b; rm -rf ~'), /letters, digits/);
});

test('history walk rounds: one per day it may learn from, judged before it learns it; holdout weeks in every year', () => {
  const days = ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05'];
  const r = walkRounds(days, (d) => d === '2026-02-03', 1);
  assert.deepEqual(r.map((x) => [x.index, iso(x.trainFrom), iso(x.trainTo), iso(x.evalFrom), iso(x.evalTo)]), [
    [0, '2026-02-01', '2026-02-02', '2026-02-02', '2026-02-03'],
    [1, '2026-02-03', '2026-02-04', '2026-02-04', '2026-02-05'],
    [2, '2026-02-05', '2026-02-05', '2026-02-05', '2026-02-06'],
  ], 'the first day learns only; the paused day is trained through before the next round, judged by nobody');
  // The walk pauses every week that is or will be a holdout week, whatever its age.
  const weeks = weekBlocks(Array.from({ length: 7 * 16 }, (_, i) => addDays('2025-01-06', i)));
  for (const b of weeks) for (const d of b.days) assert.equal(inHoldoutWeek(d), isHoldout(b, '2026-10-28'), d);
  assert.equal(weeks.filter((b) => isHoldout(b, '2026-10-28')).length, 2, 'one week in eight');
});

test('health: a re-anchored monitor takes its reference afresh and its freeze ends', () => {
  const h = new SnnHealth({ ...DEFAULT_HEALTH, calibSec: 60 });
  const sample = (rate: number): HealthSample => ({ rateL0: rate, rateL1: rate, rateE: rate, rateI: rate, ei: 1, theta: 1, fSat: 0, divergence: 0, G: [0.5], surprise: 0, calN: 0 });
  const t0 = Date.parse('2018-01-01T00:00:00Z');
  for (let t = t0; t <= t0 + 120_000; t += 1000) h.observe(t, sample(1));
  assert.equal(h.ref?.rateL0, 1);
  // Two years on the network fires 10x as much: out of the old reference's band, its learning freezes.
  const t1 = t0 + 730 * DAY;
  for (let t = t1; t <= t1 + 600_000; t += 1000) h.observe(t, sample(10));
  assert.ok(h.freezeLearning);
  const again = new SnnHealth({ ...DEFAULT_HEALTH, calibSec: 60 });
  again.restore(recalibrated(h.state()));
  assert.deepEqual([again.ref, again.freezeLearning], [undefined, false]);
  const t2 = t1 + 600_000;
  for (let t = t2; t <= t2 + 600_000; t += 1000) again.observe(t, sample(10));
  assert.deepEqual([again.ref?.rateL0, again.ref?.ts, again.freezeLearning], [10, t2 + 60_000, false], 'the new reference is taken after calibSec');
});

test('a paused day: the network runs through it as time flows, but learns nothing from it', async () => {
  // Two worlds that share the first day and differ on the second.
  const d1 = Date.parse('2026-02-01T00:00:00Z'), d2 = d1 + DAY;
  const a = tmpDir(), b = tmpDir();
  for (const [dir, seed] of [[a, 6], [b, 77]] as const) { writeSyntheticRecordings(dir, { windows: 3, seed: 5, start: d1 }); writeSyntheticRecordings(dir, { windows: 3, seed, start: d2 }); }
  const params = domainParams('crypto', withFlags({ ...DEFAULT_SNN }, stageFlags('S6')));
  const first = await replaySnn(a, { params, domain: 'crypto', from: d1, to: d2, skipModel: true });
  const cp = first.net.serialize();
  const day2 = (dir: string, pauseLearning: boolean) => replaySnn(dir, { params, domain: 'crypto', checkpoint: cp, allowParamChange: true, from: d2, to: d2 + DAY, skipModel: true, pauseLearning });
  const learned = (net: SnnNetwork) => { const m = net.exportModel(); return JSON.stringify([m.columns, m.readouts, m.dirReadouts]); };
  const updates = (net: SnnNetwork) => [...net.readouts.values(), ...net.dirReadouts.values()].reduce((n, r) => n + r.updates, 0);
  const [pa, pb, ua, ub] = [await day2(a, true), await day2(b, true), await day2(a, false), await day2(b, false)];
  assert.ok(pa.rows.length > 0 && pa.net.lastTs > d2, 'it makes its calls and its clock moves on');
  assert.equal(updates(pa.net), updates(first.net), 'no readout learned from a settled contract');
  // Its weights still consolidate as time passes (the fast copy relaxing toward the slow one), whatever the day held.
  assert.ok(learned(pa.net) === learned(pb.net), 'paused, what it holds after the day does not depend on the day');
  assert.ok(learned(ua.net) !== learned(ub.net), 'unpaused, the day teaches it');
  assert.ok(updates(ua.net) > updates(first.net));
});

test('history walk: two blocks walked by one population as one stretch of time; the holdout day played through, judged by nobody', async () => {
  const rec = tmpDir();
  const all = Array.from({ length: 6 }, (_, i) => addDays('2026-02-01', i));
  for (let d = 0; d < all.length; d++) writeSyntheticRecordings(rec, { windows: 1, seed: 41 + d, start: Date.parse(`${all[d]}T00:00:00Z`) });
  const state = path.join(tmpDir(), 'pbt');
  const o = {
    recordings: rec, domain: 'crypto' as const, stage: 'S1' as const, allDays: all, layout: 'walk', walk: { paused: (d: string) => d === '2026-02-04' },
    initDays: 1, evalDays: 1, stateDir: state, restartEvery: 0, population: 3, tapeDir: path.join(tmpDir(), 'tapes'),
  };
  const b1 = await runSnnPbt({ ...o, days: all.slice(0, 3) });
  assert.deepEqual([b1.complete, b1.rounds, b1.walkedTo], [true, 2, '2026-02-04']);
  assert.ok(typeof b1.frozen === 'number' && b1.frozen >= 0 && b1.frozen <= 1, 'the share of steps with learning frozen is measured');
  const b2 = await runSnnPbt({ ...o, days: all.slice(3) });
  assert.deepEqual([b2.complete, b2.walkedTo], [true, '2026-02-07']);
  assert.deepEqual(b2.log.map((r) => r.evalFrom.slice(0, 10)), ['2026-02-02', '2026-02-03', '2026-02-05', '2026-02-06'], 'every day judged once, before it is learned; the holdout day by nobody');
  for (const m of [0, 1, 2]) {
    const cp = JSON.parse(fs.readFileSync(path.join(state, `m${m}.json`), 'utf8')) as { lastTs: number };
    assert.ok(cp.lastTs >= Date.parse('2026-02-06T00:00:00Z'), `member ${m} walked on to the last day`);
  }
  // A block already walked has nothing left to walk.
  const again = await runSnnPbt({ ...o, days: all.slice(3) });
  assert.deepEqual([again.rounds, again.walkedTo], [4, '2026-02-07']);
  // A new walk needs a day it may learn from after its first days.
  await assert.rejects(runSnnPbt({ ...o, stateDir: path.join(tmpDir(), 'pbt'), days: all.slice(0, 1) }), /need more than 1 day/);
});

test('daily training from the walk\'s network (--init) goes on from it; the network in use is judged on the same unseen days', async () => {
  const rec = tmpDir(), out = tmpDir();
  for (let d = 0; d < 3; d++) writeSyntheticRecordings(rec, { windows: 3, seed: 61 + d, start: Date.parse('2026-02-01T00:00:00Z') + d * DAY });
  const args = (o: Record<string, string>) => (k: string, d: string) => o[k] ?? d;
  const base = { recordings: rec, domain: 'crypto', stage: 'S5', from: '2026-02-01', to: '2026-02-03', 'eval-from': '2026-02-03', 'eval-to': '2026-02-04', 'skip-model': 'true' };
  const coldFile = path.join(out, 'cold.json'), initFile = path.join(out, 'init.json'), warmFile = path.join(out, 'warm.json');
  const cold = await trainSnnMain(args({ ...base, out: coldFile }), false);
  // The walk's network: the cold one, its health reference measured years before.
  const m = JSON.parse(fs.readFileSync(coldFile, 'utf8'));
  fs.writeFileSync(initFile, JSON.stringify({ ...m, healthRef: { ...m.healthRef, ts: Date.parse('2017-08-18T03:00:00Z') } }));
  const warm = await trainSnnMain(args({ ...base, out: warmFile, init: initFile, incumbent: coldFile }), false);
  assert.equal(warm.init, initFile);
  assert.deepEqual(warm.incumbent, cold.eval, 'the network in use, judged on the unseen days as its own training judged it');
  assert.ok(warm.eval && warm.eval.n === cold.eval?.n && warm.eval.n > 0);
  const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')) as { readouts: Record<string, number[]>; healthRef?: { ts: number } };
  assert.notDeepEqual(read(warmFile).readouts, read(coldFile).readouts, 'it went on from the network it started from');
  assert.ok(read(warmFile).healthRef!.ts >= Date.parse('2026-02-01T00:00:00Z'), 'its health reference measured on its own training days, not carried');
});

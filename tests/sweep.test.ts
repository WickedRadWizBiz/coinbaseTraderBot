// Sweep optimizer (research/sweep.ts): coordinate descent with tune / check / final windows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSweep, tStat, type SweepTarget } from '../research/sweep';

function target(checkPenalty: (s: Record<string, number>) => number): SweepTarget & { s: Record<string, number> } {
  const s: Record<string, number> = { a: 0, b: 0 };
  return {
    s, name: 'toy', minN: 1,
    params: ['a', 'b'].map((k) => ({ name: k, values: [-2, -1, 0, 1, 2, 3], get: () => s[k], set: (v: number) => { s[k] = v; } })),
    snapshot: () => ({ ...s }),
    // Tune peaks at a = 2, b = -1; check agrees except where the penalty says otherwise.
    fitness: async (w) => ({ score: 10 - (s.a - 2) ** 2 - (s.b + 1) ** 2 - (w === 'check' ? checkPenalty(s) : 0), n: 100 }),
  };
}

test('sweep: coordinate descent reaches the optimum and stops on a plateau; final reported', async () => {
  const t = target(() => 0);
  const r = await runSweep(t, { hours: 1, epsilon: 0.01, tolerance: 0, maxPasses: 10, log: () => {} });
  assert.deepEqual(t.s, { a: 2, b: -1 });
  assert.equal(r.plateau, true);
  assert.equal(r.end.final.score, 10);
  assert.equal(r.start.final.score, 10 - 4 - 1);
  assert.ok(r.steps.some((x) => x.param === 'a' && x.accepted && x.to === 2));
});

test('sweep: a change that hurts the check window is rejected', async () => {
  const t = target((s) => (s.a > 1 ? 50 : 0)); // a = 2 looks best on tune but fails the check window
  await runSweep(t, { hours: 1, epsilon: 0.01, tolerance: 0.5, maxPasses: 10, log: () => {} });
  assert.equal(t.s.a, 1, 'stops at the best value the check window accepts');
  assert.equal(t.s.b, -1);
});

test('sweep: resumes from its ledger', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-')), 'ledger.json');
  const t1 = target(() => 0);
  await runSweep(t1, { hours: 1, epsilon: 0.01, tolerance: 0, maxPasses: 1, ledgerPath: file, log: () => {} });
  const t2 = target(() => 0);
  const r = await runSweep(t2, { hours: 1, epsilon: 0.01, tolerance: 0, maxPasses: 10, ledgerPath: file, log: () => {} });
  assert.deepEqual(t2.s, { a: 2, b: -1 });
  assert.ok(r.steps.length >= 2);
  assert.deepEqual(r.start.settings, { a: 0, b: 0 }, 'the original starting point is kept');
});

test('sweep: a stop part way resumes exactly (no evaluation made twice), and parallel evaluation chooses the same', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  const counted = (limit = Infinity) => {
    const t = target((s) => (s.a > 2 ? 3 : 0)) as ReturnType<typeof target> & { calls: number };
    t.calls = 0;
    const f = t.fitness;
    t.fitness = async (w) => { if (++t.calls > limit) throw new Error('stopped'); return f(w); };
    return t;
  };
  // Uninterrupted reference.
  const ref = counted();
  const r0 = await runSweep(ref, { hours: 1, epsilon: 0.01, tolerance: 0, maxPasses: 10, ledgerPath: path.join(dir, 'ref.json'), log: () => {} });
  // Stopped after 7 evaluations (in the middle of the first setting's values), then continued.
  const file = path.join(dir, 'ledger.json');
  await assert.rejects(runSweep(counted(7), { hours: 1, epsilon: 0.01, tolerance: 0, maxPasses: 10, ledgerPath: file, log: () => {} }), /stopped/);
  const rest = counted();
  const r1 = await runSweep(rest, { hours: 1, epsilon: 0.01, tolerance: 0, maxPasses: 10, ledgerPath: file, log: () => {} });
  assert.equal(7 + rest.calls, ref.calls, 'every evaluation made once across the two runs');
  assert.deepEqual(r1.end.settings, r0.end.settings);
  assert.deepEqual(r1.steps.map((x) => [x.param, x.to, x.accepted]), r0.steps.map((x) => [x.param, x.to, x.accepted]));
  assert.equal(r1.complete, true);
  // A target that evaluates the values of a setting at once lands on the same settings.
  const par = target((s) => (s.a > 2 ? 3 : 0));
  let batches = 0;
  par.fitnessMany = async (jobs) => { batches++; return Promise.all(jobs.map(async (j) => ({ score: 10 - (j.settings.a - 2) ** 2 - (j.settings.b + 1) ** 2 - (j.w === 'check' && j.settings.a > 2 ? 3 : 0), n: 100 }))); };
  const r2 = await runSweep(par, { hours: 1, epsilon: 0.01, tolerance: 0, maxPasses: 10, log: () => {} });
  assert.deepEqual(r2.end.settings, r0.end.settings);
  assert.ok(batches > 0);
  // Other data (another signature): the ledger is not reused.
  const other = counted();
  other.signature = 'new-days';
  await runSweep(other, { hours: 1, epsilon: 0.01, tolerance: 0, maxPasses: 10, ledgerPath: file, log: () => {} });
  assert.equal(other.calls, ref.calls);
});

test('sweep: the time budget leaves an unfinished ledger the next run continues', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-')), 'ledger.json');
  const r = await runSweep(target(() => 0), { hours: 0, epsilon: 0.01, tolerance: 0, maxPasses: 10, ledgerPath: file, log: () => {} });
  assert.equal(r.complete, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).complete, false);
  const t = target(() => 0);
  const r2 = await runSweep(t, { hours: 1, epsilon: 0.01, tolerance: 0, maxPasses: 10, ledgerPath: file, log: () => {} });
  assert.equal(r2.complete, true);
  assert.deepEqual(t.s, { a: 2, b: -1 });
});

test('tStat', () => {
  assert.equal(tStat([1]).score, -Infinity);
  assert.ok(Math.abs(tStat([1, 2, 3]).score - 2 / (1 / Math.sqrt(3))) < 1e-9);
});

test('sweep: a Kalshi evaluation on a worker thread scores exactly as in the main thread', async () => {
  const { writeSyntheticRecordings } = await import('../research/synthetic');
  const { kalshiScore } = await import('../research/sweep');
  const { WorkerPool, workerScript } = await import('../research/workerPool');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-rec-'));
  writeSyntheticRecordings(dir, { windows: 8, seed: 4 });
  const strategy = { minEdge: 0.02, kellyFraction: 0.25 };
  const main = await kalshiScore(dir, path.join(dir, 'no-model.json'), strategy);
  const pool = new WorkerPool<{ dir: string; modelPath: string; strategy: Record<string, unknown> }, { score: number; n: number; mean?: number }>(workerScript('sweepWorker'), 2);
  try {
    const [a, b] = await Promise.all([pool.run({ dir, modelPath: path.join(dir, 'no-model.json'), strategy }), pool.run({ dir, modelPath: path.join(dir, 'no-model.json'), strategy: { ...strategy, minEdge: 0.05 } })]);
    assert.deepEqual(a, main);
    assert.deepEqual(b, await kalshiScore(dir, path.join(dir, 'no-model.json'), { ...strategy, minEdge: 0.05 }));
  } finally { await pool.close(); }
});

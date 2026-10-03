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

test('tStat', () => {
  assert.equal(tStat([1]).score, -Infinity);
  assert.ok(Math.abs(tStat([1, 2, 3]).score - 2 / (1 / Math.sqrt(3))) < 1e-9);
});

// Multi-branch TA network: hand-written backprop matches finite differences for every parameter.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { branchBackward, branchForward, branchLayout, branchLoss, initBranchParams, type BranchDims, type BranchInput } from '../bot/ta/branchNet';

const dims: BranchDims = { mT: 6, mF: 3, kW: 3, mC: 2, tT: 4, tF: 5, tH: 3, dT: 5, dF: 4, dE: 3, hM: 4, nOut: 3 };

function rand(n: number, seed: number): Float64Array {
  let s = seed;
  return Float64Array.from({ length: n }, () => { s = (s * 16807) % 2147483647; return (s / 2147483647) * 2 - 1; });
}

test('analytic gradients match finite differences (conv, GRU, attention, merge, loss)', () => {
  const { size, layout } = branchLayout(dims);
  const p = initBranchParams(dims, 5);
  // Non-zero output layer so every path carries gradient.
  const r = rand(size, 9);
  for (let i = 0; i < size; i++) p[i] += 0.3 * r[i];
  const x: BranchInput = { micro: rand(dims.mT * dims.mF, 2), trend: rand(dims.tT * dims.tF, 3), macro: rand(dims.dT * dims.dF, 4) };
  const g = { micro: 0.9, trend: 1.1, macro: 0.7 };
  const y: [number, number, number] = [1, 0, 0.4];
  const lossAt = (q: Float64Array) => branchLoss(branchForward(dims, q, g, x).out, y, 0.5).loss;
  const f = branchForward(dims, p, g, x);
  const { dOut } = branchLoss(f.out, y, 0.5);
  const grad = new Float64Array(size);
  branchBackward(dims, p, g, x, f.cache, dOut, grad);
  let worst = { name: '', i: 0, rel: 0 };
  for (const [name, { off, n }] of Object.entries(layout)) {
    for (let i = 0; i < n; i++) {
      const h = 1e-5;
      const a = Float64Array.from(p); a[off + i] += h;
      const b = Float64Array.from(p); b[off + i] -= h;
      const num = (lossAt(a) - lossAt(b)) / (2 * h);
      const rel = Math.abs(num - grad[off + i]) / Math.max(1e-6, Math.abs(num) + Math.abs(grad[off + i]));
      if (rel > worst.rel) worst = { name, i, rel };
    }
  }
  assert.ok(worst.rel < 1e-4, `worst relative error ${worst.rel} at ${worst.name}[${worst.i}]`);
});

test('identical seeds give identical networks; an untrained network predicts the base rate', () => {
  const a = initBranchParams(dims, 7), b = initBranchParams(dims, 7);
  assert.deepEqual(Array.from(a), Array.from(b));
  const x: BranchInput = { micro: rand(18, 1), trend: rand(20, 2), macro: rand(20, 3) };
  const o = branchForward(dims, a, { micro: 1, trend: 1, macro: 1 }, x).out;
  assert.deepEqual(Array.from(o), [0, 0, 0]);
});

// Multi-branch TA network: hand-written backprop matches finite differences for every parameter
// (fractal blocks with drop-path masks, GRU, attention, merge, branch drops); the fractal block's
// structure (columns of depth 1/2/4 seeing 3/7/31 bars).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { branchBackward, branchForward, branchLayout, branchLoss, fractalPlan, initBranchParams, type BranchDims, type BranchDrop, type BranchInput } from '../bot/ta/branchNet';
import { buildFractal, columnMask, columnReach, localDropMask } from '../bot/ta/fractal';

const DIMS: BranchDims = { mT: 10, mF: 3, mC: 2, sT: 9, sF: 2, sC: 2, fDepth: 3, tT: 4, tF: 5, tH: 3, dT: 5, dF: 4, dE: 3, cF: 6, cH: 3, hM: 4, nOut: 3 };

function rand(n: number, seed: number): Float64Array {
  let s = seed;
  return Float64Array.from({ length: n }, () => { s = (s * 16807) % 2147483647; return (s / 2147483647) * 2 - 1; });
}
const dims = DIMS;
const input = (): BranchInput => ({ micro: rand(dims.mT * dims.mF, 2), swing: rand(dims.sT * dims.sF, 6), trend: rand(dims.tT * dims.tF, 3), macro: rand(dims.dT * dims.dF, 4), ctx: rand(dims.cF, 8) });
const g = { micro: 0.9, swing: 1.2, trend: 1.1, macro: 0.7, ctx: 0.8 };

function gradCheck(drop?: BranchDrop, dims: BranchDims = DIMS) {
  const { size, layout } = branchLayout(dims);
  const p = initBranchParams(dims, 5);
  const r = rand(size, 9);
  for (let i = 0; i < size; i++) p[i] += 0.3 * r[i];
  const x = input();
  const y: [number, number, number] = [1, 0, 0.4];
  const lossAt = (q: Float64Array) => branchLoss(branchForward(dims, q, g, x, undefined, drop).out, y, 0.5).loss;
  const f = branchForward(dims, p, g, x, undefined, drop);
  const grad = new Float64Array(size);
  branchBackward(dims, p, g, x, f.cache, branchLoss(f.out, y, 0.5).dOut, grad);
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
  return worst;
}

test('fractal block: columns of 1, 2 and 4 convolutions seeing 3, 7 and 31 bars; masks', () => {
  const spec = { depth: 3, channels: 2, kernel: 3 };
  const plan = buildFractal(spec);
  assert.equal(plan.convs.length, 7);
  assert.deepEqual([1, 2, 3].map((c) => plan.convs.filter((x) => x.col === c).length), [1, 2, 4]);
  assert.deepEqual(columnReach(plan, spec), [3, 7, 31]);
  assert.deepEqual([...columnMask(plan, 1).values()], [[true, false]]);
  assert.ok([...columnMask(plan, 3).values()].every(([a, b]) => !a && b));
  let s = 1;
  const m = localDropMask(plan, 0.9, () => { s = (s * 16807) % 2147483647; return s / 2147483647; });
  assert.ok([...m.values()].every(([a, b]) => a || b), 'a join always keeps an input');
});

test('analytic gradients match finite differences: all paths, drop-path masks, branch drops', () => {
  const all = gradCheck();
  assert.ok(all.rel < 1e-4, `worst relative error ${all.rel} at ${all.name}[${all.i}]`);
  const plan = fractalPlan({ depth: 3, channels: 2, kernel: 3 });
  const dropped = gradCheck({ micro: columnMask(plan, 3), swing: new Map([[0, [true, false]], [1, [false, true]], [2, [true, true]]]), branches: [true, true, false, true, true], keep: 0.8 });
  assert.ok(dropped.rel < 1e-4, `with drop-path: worst relative error ${dropped.rel} at ${dropped.name}[${dropped.i}]`);
  const noCtx = gradCheck({ branches: [true, false, true, true, false], keep: 0.9 });
  assert.ok(noCtx.rel < 1e-4, `context branch dropped: worst relative error ${noCtx.rel} at ${noCtx.name}[${noCtx.i}]`);
  assert.ok(dropped.rel < 1e-4, `with drop-path: worst relative error ${dropped.rel} at ${dropped.name}[${dropped.i}]`);
});

test('identical seeds give identical networks; an untrained network predicts the base rate', () => {
  const a = initBranchParams(dims, 7), b = initBranchParams(dims, 7);
  assert.deepEqual(Array.from(a), Array.from(b));
  const o = branchForward(dims, a, { micro: 1, swing: 1, trend: 1, macro: 1, ctx: 1 }, input()).out;
  assert.deepEqual(Array.from(o), [0, 0, 0]);
});

test('grouped variant: family encoders, family attention and the deep path all match finite differences', () => {
  // 5 trend features in 2 families, 6 context features in 3 families, k = 2 per family.
  const grouped: BranchDims = { ...DIMS, fam: { trend: [0, 1, 0, 1, 1], ctx: [0, 0, 1, 2, 2, 1], nT: 2, nC: 3, k: 2 } };
  const w = gradCheck(undefined, grouped);
  assert.ok(w.rel < 1e-4, `worst relative error ${w.rel} at ${w.name}[${w.i}]`);
  const wd = gradCheck({ branches: [true, false, true, true, false], keep: 0.8 }, grouped);
  assert.ok(wd.rel < 1e-4, `with branch drops: worst relative error ${wd.rel} at ${wd.name}[${wd.i}]`);
  // Block structure: a trend feature only moves its own family's encoder outputs.
  const p = initBranchParams(grouped, 3);
  const x = input();
  const a = branchForward(grouped, p, g, x).cache.xt;
  const x2 = { ...x, trend: Float64Array.from(x.trend) }; x2.trend[0] += 0.5; // feature 0 -> family 0
  const b = branchForward(grouped, p, g, x2).cache.xt;
  for (let j = 0; j < 2; j++) assert.equal(a[2 + j], b[2 + j], 'family 1 unaffected');
  assert.notEqual(a[0], b[0]);
  const pi = branchForward(grouped, p, g, x).cache.pi!;
  assert.equal(pi.length, 5);
  assert.ok(Math.abs(pi.reduce((s, v) => s + v, 0) - 1) < 1e-12);
});

// The PyTorch TA network trainer (python/tanet) against the TypeScript network it trains for: identical outputs and
// gradients on the same weights, inputs and drop-path masks (float64), the training pack rebuilding exactly the
// inputs rawInputs builds, and forecasts through the pack matching the TypeScript forecast. Needs a Python with
// PyTorch (TA_NET_PYTHON, else python3); skipped without one. CI installs the CPU build.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Candle } from '../bot/ta/indicators';
import { branchBackward, branchForward, branchLayout, branchLoss, fractalPlan, fractalSpecs, initBranchParams, type BranchDrop } from '../bot/ta/branchNet';
import { columnMask, localDropMask, type JoinMask } from '../bot/ta/fractal';
import { aggregateCandles, upsertSeries } from '../research/history/candles';
import { buildData, fitNorms, forecast, rawInputs, taNetDims, trainTaNet, writeTaNetPack } from '../research/trainTaNet';
import { TaNetTorch, torchSelfTest } from '../research/taNetTorch';
import { ensureTorch, envPython } from '../research/torchSetup';
import { tmpDir } from './helpers';

const PY = process.env.TA_NET_PYTHON || 'python3';
const hasTorch = spawnSync(PY, ['-c', 'import torch, numpy'], { encoding: 'utf8' }).status === 0;
const skip = hasTorch ? false : `no Python with PyTorch (${PY})`;

function rngOf(seed: number) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

test('torch network: outputs and gradients equal the TypeScript network (weights, inputs, drop-path masks, branch scales)', { skip }, async () => {
  const dims = taNetDims('flat');
  const { layout: L, size } = branchLayout(dims);
  const r = rngOf(5);
  const w = initBranchParams(dims, 11);
  for (let i = 0; i < size; i++) w[i] += (r() - 0.5) * 0.2; // non-zero output layer and biases
  const B = 6;
  const fsp = fractalSpecs(dims), plans = { micro: fractalPlan(fsp.micro), swing: fractalPlan(fsp.swing) };
  const field = (n: number) => Float64Array.from({ length: B * n }, () => (r() - 0.5) * 3);
  const x = { micro: field(dims.mT * dims.mF), swing: field(dims.sT * dims.sF), trend: field(dims.tT * dims.tF), macro: field(dims.dT * dims.dF), ctx: field(dims.cF) };
  const gates = { micro: 1.3, swing: 0.7, trend: 1, macro: 1.6, ctx: 0.5 };
  const drops: BranchDrop[] = [];
  for (let b = 0; b < B; b++) {
    const mm: JoinMask = b % 2 ? localDropMask(plans.micro, 0.4, r) : columnMask(plans.micro, 1 + (b % 3));
    const sm: JoinMask = b % 3 ? columnMask(plans.swing, 1 + ((b + 1) % 3)) : localDropMask(plans.swing, 0.4, r);
    drops.push({ micro: mm, swing: sm, branches: [b !== 1, b !== 2, true, b !== 4, b !== 5], keep: 0.9 });
  }
  const scale = new Float64Array(B * 5), mmask = new Float64Array(B * plans.micro.joins * 2), smask = new Float64Array(B * plans.swing.joins * 2);
  const g5 = [gates.micro, gates.swing, gates.trend, gates.macro, gates.ctx];
  drops.forEach((d, b) => {
    d.branches!.forEach((on, k) => { scale[b * 5 + k] = on ? g5[k] / d.keep! : 0; });
    for (let j = 0; j < plans.micro.joins; j++) { const a = d.micro!.get(j) ?? [true, true]; mmask[(b * plans.micro.joins + j) * 2] = +a[0]; mmask[(b * plans.micro.joins + j) * 2 + 1] = +a[1]; }
    for (let j = 0; j < plans.swing.joins; j++) { const a = d.swing!.get(j) ?? [true, true]; smask[(b * plans.swing.joins + j) * 2] = +a[0]; smask[(b * plans.swing.joins + j) * 2 + 1] = +a[1]; }
  });
  const sample = (b: number) => ({ micro: x.micro.subarray(b * dims.mT * dims.mF, (b + 1) * dims.mT * dims.mF), swing: x.swing.subarray(b * dims.sT * dims.sF, (b + 1) * dims.sT * dims.sF), trend: x.trend.subarray(b * dims.tT * dims.tF, (b + 1) * dims.tT * dims.tF), macro: x.macro.subarray(b * dims.dT * dims.dF, (b + 1) * dims.dT * dims.dF), ctx: x.ctx.subarray(b * dims.cF, (b + 1) * dims.cF) });
  const ys: Array<[number, number, number]> = Array.from({ length: B }, (_, b) => [b % 2, b === 3 ? NaN : 1 - (b % 2), b === 2 ? NaN : (r() - 0.5)]);
  const grad = new Float64Array(size);
  const tsOut: number[] = [];
  let tsLoss = 0;
  for (let b = 0; b < B; b++) {
    const f = branchForward(dims, w, gates, sample(b), L, drops[b]);
    tsOut.push(...f.out);
    const { loss, dOut } = branchLoss(f.out, ys[b], 0.7);
    tsLoss += loss;
    branchBackward(dims, w, gates, sample(b), f.cache, dOut, grad, L);
  }
  const t = TaNetTorch.start({ python: PY });
  try {
    await t.init({ dims, device: 'cpu', dtype: 'float64' });
    const out = await t.forward(w, x, B, scale, mmask, smask);
    for (let i = 0; i < tsOut.length; i++) assert.ok(Math.abs(out[i] - tsOut[i]) < 1e-9, `output ${i}: torch ${out[i]} vs ts ${tsOut[i]}`);
    const g = await t.grad(w, x, B, scale, Float64Array.from(ys.flat()), 0.7, mmask, smask);
    assert.ok(Math.abs(g.loss - tsLoss) < 1e-8 * Math.max(1, Math.abs(tsLoss)), `loss torch ${g.loss} vs ts ${tsLoss}`);
    let worst = 0, at = '';
    for (const [name, { off, n }] of Object.entries(L)) for (let k = 0; k < n; k++) {
      const e = Math.abs(g.grad[off + k] - grad[off + k]) / (1e-6 + Math.abs(grad[off + k]));
      if (e > worst) { worst = e; at = `${name}[${k}] torch ${g.grad[off + k]} ts ${grad[off + k]}`; }
    }
    assert.ok(worst < 1e-6, `largest relative gradient difference ${worst} at ${at}`);
  } finally { await t.close(); }
});

// A small market history (the TA network test's shapes).
const H = 3_600_000, Q = 900_000, T0 = Date.UTC(2020, 0, 1);
function planted(hours: number, seed: number, phi: number): Candle[] {
  let s = seed; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
  let p = 100, prev = 0, v = 0.006 ** 2; const out: Candle[] = [];
  for (let i = 0; i < hours; i++) {
    v = 0.000002 + 0.1 * prev * prev + 0.85 * v; const ret = phi * prev + Math.sqrt(v) * gauss();
    for (let k = 0; k < 4; k++) { const o = p; p = p * Math.exp(ret / 4 + Math.sqrt(v) * 0.15 * gauss()); out.push({ ts: T0 + i * H + k * Q, o, h: Math.max(o, p) * 1.0003, l: Math.min(o, p) * 0.9997, c: p, v: 25 * (0.5 + r()) }); }
    prev = Math.log(out[out.length - 1].c / out[out.length - 4].o);
  }
  return out;
}
function walk(n: number, step: number, t0: number, level: number, vol: number, seed: number): Candle[] {
  let s = seed, p = level;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  return Array.from({ length: n }, (_, i) => { const o = p; p *= Math.exp(vol * r()); return { ts: t0 + i * step, o, h: Math.max(o, p) * (1 + vol / 4), l: Math.min(o, p) * (1 - vol / 4), c: p, v: 0 }; });
}
let data: { D: ReturnType<typeof buildData>; dir: string } | undefined;
function history() {
  if (data) return data;
  const dir = tmpDir();
  const m15 = planted(9000, 3, 0.6), DAY = 24 * H;
  const days = aggregateCandles(m15, Q, DAY).length;
  upsertSeries(dir, 'binance', 'TST', '15m', m15);
  upsertSeries(dir, 'binance', 'BTC', '15m', planted(9000, 11, 0.2));
  upsertSeries(dir, 'binance-index', 'BTCDOM', '1h', walk(9000, H, T0, 1000, 0.004, 5));
  const btcd = walk(days + 300, DAY, T0 - 300 * DAY, 55, 0.02, 7), usdtd = walk(days + 300, DAY, T0 - 300 * DAY, 5, 0.03, 9);
  upsertSeries(dir, 'tradingview', 'BTC.D', '1d', btcd);
  upsertSeries(dir, 'tradingview', 'USDT.D', '1d', usdtd);
  for (const [k, v] of Object.entries({ TOTAL3: btcd, 'OTHERS.D': usdtd, RTY: btcd })) upsertSeries(dir, 'tradingview', k, '1d', v);
  const D = buildData(dir, ['TST'], path.join(dir, '.cache'), () => undefined);
  assert.ok(D.ts.length > 2000, `${D.ts.length} samples`);
  data = { D, dir };
  return data;
}

test('training pack: every sample rebuilds exactly the inputs rawInputs builds; an unchanged dataset reuses the pack', () => {
  const { D, dir } = history();
  const packDir = path.join(dir, 'pack');
  const p = writeTaNetPack(D, packDir);
  assert.equal(p.n, D.ts.length);
  const meta = JSON.parse(fs.readFileSync(path.join(packDir, 'meta.json'), 'utf8'));
  const rd = (f: string, T: typeof Float32Array | typeof Int32Array) => { const b = fs.readFileSync(path.join(packDir, f)); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  const rt = rd('rows_trend.f32', Float32Array) as Float32Array, rc = rd('rows_ctx.f32', Float32Array) as Float32Array, dv = rd('days_vec.f32', Float32Array) as Float32Array, dd = rd('days_dom.f32', Float32Array) as Float32Array;
  const gr = rd('s_gr.i32', Int32Array) as Int32Array, gd = rd('s_gd.i32', Int32Array) as Int32Array, mi = rd('s_micro.f32', Float32Array) as Float32Array, sw = rd('s_swing.f32', Float32Array) as Float32Array;
  const same = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
  for (const i of [0, 1, 7, Math.floor(D.ts.length / 2), D.ts.length - 1]) {
    const raw = rawInputs(D, i);
    raw.trend.forEach((row, s) => row.forEach((v, j) => assert.ok(same(rt[(gr[i] - (meta.tT - 1) + s) * meta.tF + j], v), `trend ${i} ${s} ${j}`)));
    raw.macro.forEach((row, s) => row.forEach((v, j) => assert.ok(same(dv[(gd[i] - (meta.dT - 1) + s) * meta.dF + j], v), `macro ${i} ${s} ${j}`)));
    raw.ctx.forEach((v, j) => assert.ok(same(j < meta.cI ? rc[gr[i] * meta.cI + j] : dd[gd[i] * meta.nDom + j - meta.cI], v), `ctx ${i} ${j}`));
    raw.micro.forEach((v, k) => assert.ok(same(mi[i * raw.micro.length + k], v), `micro ${i} ${k}`));
    raw.swing.forEach((v, k) => assert.ok(same(sw[i * raw.swing.length + k], v), `swing ${i} ${k}`));
  }
  const mtime = fs.statSync(path.join(packDir, 's_micro.f32')).mtimeMs;
  writeTaNetPack(D, packDir);
  assert.equal(fs.statSync(path.join(packDir, 's_micro.f32')).mtimeMs, mtime, 'reused, not rewritten');
});

test('torch trainer: forecasts through the pack equal the TypeScript forecast; training moves the weights and lowers the loss', { skip }, async () => {
  const { D, dir } = history();
  const dims = taNetDims('flat');
  const idx = Array.from({ length: D.ts.length }, (_, i) => i);
  const norm = fitNorms(D, idx);
  const pack = writeTaNetPack(D, path.join(dir, 'pack'));
  const t = TaNetTorch.start({ python: PY });
  try {
    await t.init({ dims, norm, pack: pack.dir, device: 'cpu', dtype: 'float64' });
    const w = initBranchParams(dims, 3);
    const r = rngOf(9);
    for (let i = 0; i < w.length; i++) w[i] += (r() - 0.5) * 0.1;
    const h = { gMicro: 1, gSwing: 1, gTrend: 1, gMacro: 1, gCtx: 1 };
    const some = idx.filter((_, k) => k % 97 === 0);
    const out = await t.forecast(w, [1, 1, 1, 1, 1], some);
    const ts = forecast(D, dims, norm, w, h as never, some);
    some.forEach((_, k) => {
      assert.ok(Math.abs(1 / (1 + Math.exp(-out[k * 3])) - ts.up1[k]) < 1e-5, `up1 ${k}`);
      assert.ok(Math.abs(1 / (1 + Math.exp(-out[k * 3 + 1])) - ts.up4[k]) < 1e-5, `up4 ${k}`);
      assert.ok(Math.abs(Math.max(-3, Math.min(3, out[k * 3 + 2])) - ts.vol[k]) < 1e-5, `vol ${k}`);
    });
    const size = branchLayout(dims).size;
    const st = { w: initBranchParams(dims, 3), m: new Float64Array(size), v: new Float64Array(size), step: 0 };
    const hyper = { lr: 3e-3, wd: 1e-2, volWeight: 0.5, pJoin: 0.15, pBranch: 0.1, gMicro: 1, gSwing: 1, gTrend: 1, gMacro: 1, gCtx: 1 };
    const a = await t.train(st, hyper, idx, 1, 1);
    const b = await t.train(a, hyper, idx, 2, 3);
    assert.equal(a.step, Math.ceil(idx.length / 64));
    assert.equal(b.step, a.step + 3 * Math.ceil(idx.length / 64));
    assert.ok(a.w.some((v, i) => v !== st.w[i]) && a.w.every(Number.isFinite));
    assert.ok(b.loss < a.loss, `loss ${a.loss} -> ${b.loss}`);
    // The GPU's layout (tables copied in and normalised once) on the CPU: the same forecasts and training.
    const t2 = TaNetTorch.start({ python: PY });
    try {
      await t2.init({ dims, norm, pack: pack.dir, device: 'cpu', dtype: 'float64', resident: true });
      const out2 = await t2.forecast(w, [1, 1, 1, 1, 1], some);
      out2.forEach((v, k) => assert.ok(Math.abs(v - out[k]) < 1e-5, `resident forecast ${k}: ${v} vs ${out[k]}`));
      const a2 = await t2.train(st, hyper, idx, 1, 1);
      assert.ok(Math.abs(a2.loss - a.loss) < 1e-9 * Math.max(1, a.loss) && a2.w.every((v, i) => Math.abs(v - a.w[i]) < 1e-9), 'resident training = memory-mapped training');
    } finally { await t2.close(); }
    // The CUDA-graph path's bookkeeping (static buffers, the check against the eager step, full batches replayed and
    // the last partial batch eager, state restored after the check), emulated without a GPU: the same training.
    const logs: string[] = [];
    const t3 = TaNetTorch.start({ python: PY, log: (m) => logs.push(m) });
    try {
      await t3.init({ dims, norm, pack: pack.dir, device: 'cpu', dtype: 'float64', resident: true, graphs: 'emulate' });
      const a3 = await t3.train(st, hyper, idx, 1, 1);
      assert.ok(a3.graph, logs.join('\n'));
      assert.match(logs.join('\n'), /CUDA graph ready for batch 64/);
      assert.ok(idx.length % 64 !== 0, 'the fixture ends on a partial batch');
      assert.ok(Math.abs(a3.loss - a.loss) < 1e-9 * Math.max(1, a.loss) && a3.w.every((v, i) => Math.abs(v - a.w[i]) < 1e-9) && a3.m.every((v, i) => Math.abs(v - a.m[i]) < 1e-9), 'graph path = eager path');
      assert.equal(a3.step, a.step);
    } finally { await t3.close(); }
  } finally { await t.close(); }
});

const TOURNEY = { trainMonths: 1.25, evalMonths: 0.25, stepMonths: 0.25, holdoutMonths: 0.5, finalMonths: 0.25, stride: 4, minPerRegime: 5, epochsPerRound: 1, catchUpEpochs: 0, patterns: false, baseHyper: { lr: 3e-3, wd: 1e-2 } };

test('tournament on the torch engine: rounds train in PyTorch, the saved population continues in TypeScript', { skip }, async () => {
  const { D, dir } = history();
  const statePath = path.join(dir, 'pop-torch.json');
  const logs: string[] = [];
  const a = await trainTaNet(D, { ...TOURNEY, statePath, maxRounds: 2, engine: 'torch', python: PY, device: 'cpu', packDir: path.join(dir, 'pack'), log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => /^training engine: PyTorch .* on the CPU$/.test(m)), logs.join('\n'));
  assert.equal(logs.filter((m) => /^round \d+: PyTorch trained \d+ samples in/.test(m)).length, 2, logs.join('\n'));
  assert.equal(a.newRounds, 2);
  assert.ok(a.params.weights.every(Number.isFinite));
  // The same population, one more round, in TypeScript (weights and optimizer moments are engine-neutral).
  const logs2: string[] = [];
  const b = await trainTaNet(D, { ...TOURNEY, statePath, maxRounds: 1, engine: 'ts', log: (m) => logs2.push(m) });
  assert.ok(logs2.some((m) => /continuing a saved population \(2 rounds so far\)/.test(m)), logs2.join('\n'));
  assert.ok(!logs2.some((m) => /PyTorch/.test(m)));
  assert.equal(b.rounds, 3);
});

test('torch engine on auto without a working Python: the tournament trains in TypeScript', async () => {
  const { D, dir } = history();
  const logs: string[] = [];
  const r = await trainTaNet(D, { ...TOURNEY, statePath: path.join(dir, 'pop-auto.json'), maxRounds: 1, engine: 'auto', python: path.join(dir, 'no-such-python'), packDir: path.join(dir, 'pack'), log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => /^training engine: TypeScript \(PyTorch unavailable: /.test(m)), logs.join('\n'));
  assert.equal(r.newRounds, 1);
  await assert.rejects(trainTaNet(D, { ...TOURNEY, statePath: path.join(dir, 'pop-strict.json'), maxRounds: 1, engine: 'torch', python: path.join(dir, 'no-such-python'), packDir: path.join(dir, 'pack') }), /could not start|exited/);
});

test('torch setup: a given Python with PyTorch is used as is; the self-test matches the TypeScript network', { skip }, async () => {
  const logs: string[] = [];
  const env = await ensureTorch(tmpDir(), (m) => logs.push(m), { python: PY });
  assert.equal(env?.python, PY);
  assert.match(logs.join('\n'), /^PyTorch \S+ from TA_NET_PYTHON/m);
  const t = await torchSelfTest({ python: PY });
  assert.ok(t.maxDiff < 1e-4, `self-test difference ${t.maxDiff}`);
});

test('torch setup: no PyTorch and no working uv -> undefined (TypeScript), with the reason logged', async () => {
  const logs: string[] = [];
  const dir = tmpDir();
  const env = await ensureTorch(dir, (m) => logs.push(m), { python: path.join(dir, 'none'), uv: path.join(dir, 'no-uv'), gpu: null });
  assert.equal(env, undefined);
  assert.match(logs.join('\n'), /has no working PyTorch/);
  assert.match(logs.join('\n'), /setting up PyTorch for the CPU/);
  assert.match(logs.join('\n'), /creating the Python environment failed: the TA network trains in TypeScript/);
  assert.equal(envPython('E', true), path.join('E', 'Scripts', 'python.exe'));
  assert.equal(envPython('E', false), path.join('E', 'bin', 'python'));
});

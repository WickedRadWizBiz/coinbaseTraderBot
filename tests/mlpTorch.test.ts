// The decision models' MLPs fitted in PyTorch (python/mlp/fit.py, research/mlpTorch.ts) against the TypeScript trainer
// (research/mlp.ts): the same algorithm from the same initial weights gives the same network. Skipped without a Python
// with PyTorch (TA_NET_PYTHON, else python3); CI installs the CPU build.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { predictLogits, train } from '../research/mlp';
import { MlpTorch, trainMlp } from '../research/mlpTorch';
import path from 'node:path';
import { buildDataset } from '../research/buildDataset';
import { rng } from '../research/stats';
import { writeSyntheticRecordings } from '../research/synthetic';
import { trainMetaModel } from '../research/trainMetaModel';
import { tmpDir } from './helpers';

const PY = process.env.TA_NET_PYTHON || 'python3';
const hasTorch = spawnSync(PY, ['-c', 'import torch, numpy'], { stdio: 'ignore' }).status === 0;
const skip = hasTorch ? false : `no Python with PyTorch (${PY})`;

function problem(n: number, seed: number) {
  const r = rng(seed);
  const X: number[][] = [], y: number[] = [], w: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = [r() * 2 - 1, r() * 2 - 1, r() < 0.1 ? NaN : r() * 3, (r() - 0.5) * 2];
    const z = 1.5 * x[0] - x[1] * x[3] + 0.3 * x[3];
    X.push(x); y.push(r() < 1 / (1 + Math.exp(-z)) ? 1 : 0); w.push(0.5 + r());
  }
  return { X, y, w };
}

test('MLP fits in PyTorch: the same network as the TypeScript trainer (hidden layer and logistic), weights in its layout', { skip }, async () => {
  const torch = await MlpTorch.start({ engine: 'torch', python: PY });
  assert.ok(torch, 'PyTorch MLP trainer started');
  try {
    const tr = problem(600, 1), va = problem(200, 2);
    for (const hidden of [6, 0]) {
      const o = { hidden, l2: 1e-2, lr: 0.01, maxEpochs: 120, patience: 30, seed: 7, residual: 3 };
      const a = train(tr.X, tr.y, va.X, va.y, o, tr.w, va.w);
      const b = await trainMlp(torch, tr.X, tr.y, va.X, va.y, o, tr.w, va.w);
      assert.equal(b.epochs, a.epochs, `hidden ${hidden}: early stop at the same epoch`);
      assert.ok(Math.abs(b.valLoss - a.valLoss) < 1e-7, `hidden ${hidden}: val loss ${b.valLoss} vs ${a.valLoss}`);
      assert.deepEqual(b.layers.map((l) => [l.weights.length, l.weights[0].length, l.activation]), a.layers.map((l) => [l.weights.length, l.weights[0].length, l.activation]));
      const pa = predictLogits(a.layers, a.norm, va.X, 3), pb = predictLogits(b.layers, b.norm, va.X, 3);
      assert.ok(pa.every((z, i) => Math.abs(z - pb[i]) < 1e-6), `hidden ${hidden}: same predictions`);
    }
  } finally { await torch!.close(); }
});

test('MLP_ENGINE=ts: no PyTorch, the TypeScript trainer', async () => {
  assert.equal(await MlpTorch.start({ engine: 'ts' }), undefined);
  const tr = problem(200, 3);
  const r = await trainMlp(undefined, tr.X, tr.y, tr.X, tr.y, { hidden: 0, l2: 1e-2, lr: 0.01, maxEpochs: 20, patience: 10, seed: 1, residual: -1 });
  assert.equal(r.layers.length, 1);
});

test('Kalshi MLP trainer with its fits in PyTorch: the same candidate chosen and the same holdout as in TypeScript', { skip }, async () => {
  const dir = path.join(tmpDir(), 'rec');
  writeSyntheticRecordings(dir, { windows: 14, seed: 6 });
  const rows = await buildDataset(dir, 15);
  const o = { folds: 3, maxEpochs: 40, ensemble: 2, cpcvGroups: 0, sets: ['base', 'base+geometry+vol+kalshi'] };
  const a = await trainMetaModel(rows, o);
  const torch = await MlpTorch.start({ engine: 'torch', python: PY });
  const logs: string[] = [];
  const b = await trainMetaModel(rows, { ...o, torch, log: (m) => logs.push(m) }).finally(() => torch?.close());
  assert.deepEqual(logs, [], 'no fallback to TypeScript');
  assert.deepEqual(b.selected, a.selected);
  assert.ok(b.cv.every((c, i) => Math.abs(c.oosLogLoss - a.cv[i].oosLogLoss) < 1e-6), 'the same cross-validation');
  assert.ok(Math.abs(b.holdout.logLossModel - a.holdout.logLossModel) < 1e-6);
  assert.equal(b.params.ensemble?.length, a.params.ensemble?.length);
});

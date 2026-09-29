import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brier, fitPlatt, maxCalibrationErrorPp, reliability } from '../bot/model/calibration';
import { buildFeatures, FEATURE_NAMES } from '../bot/model/features';
import { MetaModel, MetaModelParams } from '../bot/model/metaModel';
import { logit, sigmoid } from '../bot/util/num';

const n = FEATURE_NAMES.length;

function mlp(over: Partial<MetaModelParams> = {}): MetaModelParams {
  return {
    version: 't1', kind: 'mlp', features: [...FEATURE_NAMES], referenceSigma: 5e-5,
    normalization: { mean: new Array(n).fill(0), std: new Array(n).fill(1) },
    // Single linear unit reading only logit_fv with weight 1 -> identity on fair value.
    layers: [{ weights: [[1, ...new Array(n - 1).fill(0)]], bias: [0], activation: 'linear' }],
    ...over,
  };
}

test('identity model passes fair value through and is blocked from live', () => {
  const m = MetaModel.identity();
  assert.equal(m.predict([], 0.63), 0.63);
  assert.ok(m.liveBlockers().length > 0);
});

test('mlp forward pass is deterministic and applies Platt calibration', () => {
  const f = buildFeatures({ fairValue: 0.7, mid: 0.6, tauSec: 300, sigmaPerSqrtSec: 5e-5, referenceSigma: 5e-5, spread: 0.02, imbalance: 0, inWindow: false });
  const m = MetaModel.fromJson(JSON.stringify(mlp()));
  assert.ok(Math.abs(m.predict(f, 0.7) - 0.7) < 1e-6);
  const cal = MetaModel.fromJson(JSON.stringify(mlp({ calibration: { a: 0.5, b: 0 } })));
  assert.ok(Math.abs(cal.predict(f, 0.7) - sigmoid(0.5 * logit(0.7))) < 1e-9);
  assert.equal(m.hash.length, 16);
});

test('loader rejects mismatched features and malformed weights', () => {
  assert.throws(() => MetaModel.fromJson(JSON.stringify(mlp({ features: ['a'] }))), /features/);
  assert.throws(() => MetaModel.fromJson(JSON.stringify(mlp({ layers: [{ weights: [[1]], bias: [0], activation: 'linear' }] }))), /width/);
  const nan = mlp();
  nan.layers![0].weights[0][0] = null as unknown as number;
  assert.throws(() => MetaModel.fromJson(JSON.stringify(nan)));
});

test('go-live gates: enough windows, beats market Brier, calibrated, positive edge CI', () => {
  const good = { passed: true, nWindows: 1500, brierModel: 0.2, brierMarket: 0.21, maxCalibrationErrorPp: 2, netEdgeCiLow: 0.004, deflatedSharpe: 0.5, evaluatedAt: 'x' };
  assert.deepEqual(MetaModel.fromJson(JSON.stringify(mlp({ validation: good }))).liveBlockers(), []);
  const few = MetaModel.fromJson(JSON.stringify(mlp({ validation: { ...good, nWindows: 200 } })));
  assert.ok(few.liveBlockers().some((b) => b.includes('windows')));
  const worse = MetaModel.fromJson(JSON.stringify(mlp({ validation: { ...good, brierModel: 0.22 } })));
  assert.ok(worse.liveBlockers().some((b) => b.includes('Brier')));
  const neg = MetaModel.fromJson(JSON.stringify(mlp({ validation: { ...good, netEdgeCiLow: -0.001 } })));
  assert.ok(neg.liveBlockers().some((b) => b.includes('edge')));
});

test('Brier, reliability and Platt scaling', () => {
  assert.equal(brier([1, 0], [1, 0]), 0);
  assert.equal(brier([0.5, 0.5], [1, 0]), 0.25);
  // Overconfident predictor: true p = sigmoid(z/2), predicted sigmoid(z).
  let seed = 3;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const z: number[] = [], y: number[] = [];
  for (let i = 0; i < 20000; i++) { const zi = (rand() - 0.5) * 8; z.push(zi); y.push(rand() < sigmoid(zi / 2) ? 1 : 0); }
  const cal = fitPlatt(z, y);
  assert.ok(Math.abs(cal.a - 0.5) < 0.05, `a=${cal.a}`);
  const raw = z.map(sigmoid);
  const fixed = z.map((zi) => sigmoid(cal.a * zi + cal.b));
  assert.ok(brier(fixed, y) < brier(raw, y));
  assert.ok(maxCalibrationErrorPp(reliability(fixed, y)) < maxCalibrationErrorPp(reliability(raw, y)));
});

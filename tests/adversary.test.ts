import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateEntry, type AdversaryInput } from '../bot/strategy/adversary';

// A YES entry at 50c with a 10c edge; fair value moves 1:1 with the stress inputs.
function base(over: Partial<AdversaryInput> = {}): AdversaryInput {
  return {
    side: 'yes', cost: 0.5, fee: 0.0175, q: 0.62,
    features: { conf_count: 3, rsi_14_1m: 0.4, usdtd_ret_5m_z: -1.2 },
    predict: () => 0.62, taFeatures: ['conf_count', 'rsi_14_1m', 'usdtd_ret_5m_z'], direction: 1,
    fairValue: 0.62, stressFairValue: (vm, mv) => 0.62 + 0.02 * mv - 0.01 * Math.abs(vm - 1),
    pStd: 0.02, fastMove: false, imbalance: 0.1, seed: 7, maxBoost: 2,
    ...over,
  };
}

test('adversary: a robust entry with agreeing confluence earns a boost in (1, 2]', () => {
  const v = evaluateEntry(base());
  assert.equal(v.broken, false, JSON.stringify(v.attacks));
  assert.equal(v.evidence, true);
  assert.ok(v.multiplier > 1 && v.multiplier <= 2, String(v.multiplier));
  // The insensitive model makes the noise / leave-one attacks not applicable; confluence carries the evidence.
  assert.equal(v.attacks.find((a) => a.name === 'noise')!.status, 'na');
  assert.equal(v.attacks.find((a) => a.name === 'confluence')!.status, 'pass');
});

test('adversary: confluence against the side breaks it (normal size, never smaller)', () => {
  const v = evaluateEntry(base({ features: { conf_count: -2 } }));
  assert.equal(v.broken, true);
  assert.equal(v.multiplier, 1);
  // A NO entry on the same reading is supported.
  const no = evaluateEntry(base({ side: 'no', cost: 0.3, q: 0.55, features: { conf_count: -2 }, fairValue: 0.55, stressFairValue: () => 0.55 }));
  assert.equal(no.attacks.find((a) => a.name === 'confluence')!.status, 'pass');
});

test('adversary: an edge that rests on one indicator is broken by leave-one-out', () => {
  // The model's whole lift over 0.5 comes from rsi alone.
  const predict = (f: Record<string, number>) => 0.5 + 0.3 * Math.tanh(f.rsi_14_1m ?? 0);
  const features = { conf_count: 2, rsi_14_1m: 1.5, usdtd_ret_5m_z: 0.1 };
  const q = predict(features);
  const v = evaluateEntry(base({ features, predict, q, fairValue: 0.5, stressFairValue: () => 0.5 }));
  const loo = v.attacks.find((a) => a.name === 'leave-one')!;
  assert.equal(loo.status, 'fail', loo.detail);
  assert.match(loo.detail, /rsi_14_1m/);
  assert.equal(v.multiplier, 1);
});

test('adversary: a thin edge fails the volatility / price stress', () => {
  const v = evaluateEntry(base({ q: 0.53, fairValue: 0.53, stressFairValue: (vm, mv) => 0.53 + 0.03 * mv, pStd: undefined }));
  assert.equal(v.attacks.find((a) => a.name === 'stress')!.status, 'fail');
  assert.equal(v.multiplier, 1);
});

test('adversary: no TA or confluence evidence means no boost even when nothing breaks', () => {
  const v = evaluateEntry(base({ features: {}, taFeatures: [] }));
  assert.equal(v.broken, false);
  assert.equal(v.evidence, false);
  assert.equal(v.multiplier, 1);
});

test('adversary: fast moves and hostile order books break entries; the boost is capped by maxBoost', () => {
  assert.equal(evaluateEntry(base({ fastMove: true })).broken, true);
  assert.equal(evaluateEntry(base({ imbalance: -0.8 })).broken, true);
  const capped = evaluateEntry(base({ maxBoost: 1.5, stressFairValue: () => 0.62, pStd: 0 }));
  assert.ok(capped.multiplier <= 1.5 && capped.multiplier > 1.4, String(capped.multiplier));
  // Deterministic: the same seed gives the same verdict.
  assert.deepEqual(evaluateEntry(base()), evaluateEntry(base()));
});

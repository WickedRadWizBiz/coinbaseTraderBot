import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kellySize } from '../bot/sizing/kelly';

const base = { bankroll: 200, kellyFraction: 0.25, maxRiskUsd: 4, maxContracts: 100 };

test('zero size when fee-net edge is non-positive (never a fallback size)', () => {
  const r = kellySize({ ...base, q: 0.52, cost: 0.5, feePerContract: 0.02 });
  assert.equal(r.contracts, 0);
  assert.equal(r.reason, 'no_edge');
  assert.equal(kellySize({ ...base, q: 0.3, cost: 0.5, feePerContract: 0 }).contracts, 0);
});

test('full Kelly fraction formula (q - c - f) / (1 - c - f)', () => {
  const r = kellySize({ ...base, q: 0.6, cost: 0.5, feePerContract: 0, maxRiskUsd: 1e9 });
  assert.ok(Math.abs(r.fullKelly - 0.2) < 1e-12);
  // 0.25 * 0.2 * 200 = $10 risk / $0.50 = 20 contracts
  assert.equal(r.contracts, 20);
});

test('hard caps override Kelly', () => {
  const r = kellySize({ ...base, q: 0.9, cost: 0.5, feePerContract: 0 });
  assert.ok(r.riskUsd <= 4 + 1e-9);
  assert.equal(r.contracts, 8);
  assert.equal(kellySize({ ...base, q: 0.9, cost: 0.5, feePerContract: 0, maxRiskUsd: 1e9, maxContracts: 3 }).contracts, 3);
});

test('invalid inputs size to zero', () => {
  assert.equal(kellySize({ ...base, q: 1.2, cost: 0.5, feePerContract: 0 }).contracts, 0);
  assert.equal(kellySize({ ...base, q: 0.6, cost: 0.5, feePerContract: 0, bankroll: 0 }).contracts, 0);
});

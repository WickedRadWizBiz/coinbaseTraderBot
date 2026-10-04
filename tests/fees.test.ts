import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makerFee, perContractFee, takerFee } from '../bot/fees';

test('taker fee matches Kalshi schedule examples', () => {
  assert.equal(takerFee(100, 0.5), 1.75); // 100 contracts at 50c -> $1.75
  assert.equal(takerFee(1, 0.5), 0.02);   // 1.75c rounds up to 2c
  assert.equal(takerFee(10, 0.1), 0.07);  // 0.07*10*0.09 = 6.3c -> 7c
});

test('maker fee is zero under the default multiplier and rounds up otherwise', () => {
  assert.equal(makerFee(100, 0.5), 0);
  assert.equal(makerFee(100, 0.5, { takerMultiplier: 1, makerMultiplier: 1 }), 0.44); // 43.75c -> 44c
});

test('no fee at degenerate prices or zero count', () => {
  assert.equal(takerFee(0, 0.5), 0);
  assert.equal(takerFee(10, 0), 0);
  assert.equal(takerFee(10, 1), 0);
});

test('per-contract fee reflects rounding on small orders', () => {
  assert.equal(perContractFee(1, 0.5, true), 0.02);
  assert.equal(perContractFee(100, 0.5, true), 0.0175);
});

test('fee is exact at float-hostile inputs (no spurious extra cent)', () => {
  // 0.07 * 20 * 0.5 * 0.5 = 0.35 dollars exactly = 35 cents
  assert.equal(takerFee(20, 0.5), 0.35);
});

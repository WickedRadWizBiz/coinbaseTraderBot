// Numeric helpers that must hold for arrays of any length.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maxOf, minOf, pushAll } from '../bot/util/num';

test('maxOf, minOf and pushAll handle arrays far past the call-argument limit', () => {
  const n = 500_000;
  const xs = Array.from({ length: n }, (_, i) => ({ ts: (i * 7919) % n }));
  assert.throws(() => Math.max(...xs.map((x) => x.ts)), RangeError, 'the spread these replace overflows the stack');
  assert.equal(maxOf(xs, (x) => x.ts), n - 1);
  assert.equal(minOf(xs, (x) => x.ts), 0);
  assert.equal(maxOf([], (x: number) => x), -Infinity);
  assert.equal(minOf([], (x: number) => x), Infinity);
  assert.equal(maxOf([1, NaN, 3], (x) => x), 3, 'NaN skipped');
  const dst = [-1];
  assert.equal(pushAll(dst, xs.map((x) => x.ts)), dst);
  assert.equal(dst.length, n + 1);
  assert.deepEqual([dst[0], dst[1], dst[n]], [-1, 0, xs[n - 1].ts]);
});

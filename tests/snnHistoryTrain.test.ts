import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthChunks, trainParams } from '../research/snnHistoryTrain';

test('history training: month chunks cover the range exactly, in order, split at month ends', () => {
  assert.deepEqual(monthChunks('2026-01-15', '2026-03-02'), [['2026-01-15', '2026-01-31'], ['2026-02-01', '2026-02-28'], ['2026-03-01', '2026-03-02']]);
  assert.deepEqual(monthChunks('2026-09-30', '2026-09-30'), [['2026-09-30', '2026-09-30']]);
  assert.deepEqual(monthChunks('2026-12-31', '2027-01-01'), [['2026-12-31', '2026-12-31'], ['2027-01-01', '2027-01-01']]);
});

test('history training: the anchored crypto network, volNorm only when asked', () => {
  const p = trainParams('S5');
  assert.equal(p.anchorMid, true);
  assert.equal(p.volNorm, undefined);
  assert.equal(trainParams('S5', 1).volNorm, 1);
});

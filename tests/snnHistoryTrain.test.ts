import { test } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import { kalshiDays, monthChunks, resumeDay, trainChunks, trainParams } from '../research/snnHistoryTrain';

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

test('history training: week pieces inside months, and resuming the day after the checkpoint', () => {
  assert.deepEqual(trainChunks('2026-01-01', '2026-01-20'), [['2026-01-01', '2026-01-07'], ['2026-01-08', '2026-01-14'], ['2026-01-15', '2026-01-20']]);
  assert.deepEqual(trainChunks('2026-01-30', '2026-02-02'), [['2026-01-30', '2026-01-31'], ['2026-02-01', '2026-02-02']]);
  assert.equal(resumeDay('2026-01-01', undefined), '2026-01-01');
  assert.equal(resumeDay('2026-01-01', Date.parse('2026-03-31T23:58:00Z')), '2026-04-01');
  assert.equal(resumeDay('2026-05-01', Date.parse('2023-10-02T00:00:00Z')), '2026-05-01');
});

test('history training: days without a Kalshi day file are counted out (skipped without building a replay)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
  fs.mkdirSync(path.join(dir, 'KXBTC15M')); fs.writeFileSync(path.join(dir, 'KXBTC15M', '2026-08-02.jsonl'), '');
  assert.equal(kalshiDays(dir, '2026-07-25', '2026-07-31'), 0);
  assert.equal(kalshiDays(dir, '2026-08-01', '2026-08-07'), 1);
  assert.equal(kalshiDays(path.join(dir, 'none'), '2026-08-01', '2026-08-07'), 0);
});

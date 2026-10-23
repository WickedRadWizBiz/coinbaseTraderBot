// The TA network's row cache (research/trainTaNet.ts assetRows): rows are reused up to the first month whose inputs
// changed and recomputed from there, giving exactly the rows a fresh computation gives; caches written before the
// monthly signatures are still accepted (and upgraded); rows for many coins are computed on worker threads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Candle } from '../bot/ta/indicators';
import { TaNetContext } from '../bot/ta/taNetContext';
import { aggregateCandles } from '../research/history/candles';
import { assetRows, keepRowsBefore, legacySig, rowCheckpoints, type RowInputs } from '../research/trainTaNet';
import { taRowWorkerCount } from '../research/workerPool';
import { tmpDir } from './helpers';

const H = 3_600_000, Q = 900_000, DAY = 86_400_000, T0 = Date.UTC(2020, 0, 1);
function planted(hours: number, seed: number): Candle[] {
  let s = seed; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  let p = 100; const out: Candle[] = [];
  for (let i = 0; i < hours * 4; i++) { const o = p; p *= Math.exp((r() - 0.5) * 0.004); out.push({ ts: T0 + i * Q, o, h: Math.max(o, p) * 1.0005, l: Math.min(o, p) * 0.9995, c: p, v: 10 + 20 * r() }); }
  return out;
}

function setup(btcBump?: number) {
  const tst15 = planted(1200, 3), btc15 = planted(1200, 11);
  const tst = aggregateCandles(tst15, Q, H), d1 = aggregateCandles(tst15, Q, DAY);
  const btc = aggregateCandles(btc15, Q, H).map((c) => (btcBump !== undefined && c.ts === btcBump ? { ...c, c: c.c * 1.01, h: c.h * 1.01 } : c));
  const basket = { BTC: btc, TST: tst };
  const inputs: RowInputs = { m15: tst15, basket, daily: {} };
  return { tst, d1, inputs, ctx: new TaNetContext({ h1: basket }) };
}

test('row cache: a changed bar recomputes rows from its month only, and the result equals a fresh computation', () => {
  const dir = tmpDir();
  const a = setup();
  const r1 = assetRows('TST', a.tst, a.d1, dir, () => undefined, a.ctx, a.inputs);
  assert.ok(r1.computed > 600);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'TST.json'), 'utf8'));
  assert.equal(meta.v, 2);
  assert.ok(meta.months.length >= 1 && meta.tail);
  const logs: string[] = [];
  const r2 = assetRows('TST', a.tst, a.d1, dir, (m) => logs.push(m), a.ctx, a.inputs);
  assert.equal(r2.computed, 0, 'unchanged inputs: all rows from the cache');
  assert.deepEqual(Array.from(r2.X), Array.from(r1.X));
  // One BTC bar (a basket coin: every coin's context) changes in February: January's rows stay.
  const bump = T0 + 900 * H;
  const b = setup(bump);
  const fresh = assetRows('TST', b.tst, b.d1, undefined, () => undefined, b.ctx, b.inputs);
  const logs3: string[] = [];
  const r3 = assetRows('TST', b.tst, b.d1, dir, (m) => logs3.push(m), b.ctx, b.inputs);
  const feb = Date.UTC(2020, 1, 1);
  assert.equal(r3.computed, r1.ts.filter((t) => t >= feb - DAY).length, logs3.join('\n'));
  assert.match(logs3.join('\n'), /inputs changed from 2020-01-31; recomputing \d+ cached rows from there \(\d+ kept\)/);
  assert.deepEqual(r3.ts, fresh.ts);
  assert.deepEqual(Array.from(r3.X), Array.from(fresh.X), 'kept + recomputed rows = a fresh computation');
  assert.ok(r1.X.some((v, i) => !Object.is(v, fresh.X[i])), 'the bump does change some rows');
});

test('row cache: month signatures find the first changed month; a cache from before them is accepted and upgraded', () => {
  const a = setup(), b = setup(T0 + 1000 * H);
  const through = a.tst[a.tst.length - 1].ts;
  const ca = rowCheckpoints(a.tst, a.d1, a.inputs, through), cb = rowCheckpoints(b.tst, b.d1, b.inputs, through);
  assert.equal(keepRowsBefore(ca, ca, through), Infinity);
  assert.equal(keepRowsBefore(ca, cb, through), Date.UTC(2020, 1, 1) - DAY);
  // A change in the month still in progress: only its rows.
  const late = setup(T0 + 1190 * H);
  assert.equal(keepRowsBefore(ca, rowCheckpoints(late.tst, late.d1, late.inputs, through), through), Date.UTC(2020, 1, 1) - DAY);
  // A coin added to the basket from February on: January's rows stay.
  const extra = planted(1200, 5).filter((c) => c.ts >= Date.UTC(2020, 1, 3));
  const withNew: RowInputs = { ...a.inputs, basket: { ...a.inputs.basket, NEW: aggregateCandles(extra, Q, H) } };
  assert.equal(keepRowsBefore(ca, rowCheckpoints(a.tst, a.d1, withNew, through), through), Date.UTC(2020, 1, 1) - DAY);

  const dir = tmpDir();
  const r1 = assetRows('TST', a.tst, a.d1, dir, () => undefined, a.ctx, a.inputs);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'TST.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'TST.json'), JSON.stringify({ schema: m.schema, d: m.d, through: m.through, sig: legacySig(a.tst, a.d1, a.inputs, m.through), ts: m.ts }));
  const r2 = assetRows('TST', a.tst, a.d1, dir, () => undefined, a.ctx, a.inputs);
  assert.equal(r2.computed, 0, 'an older cache with a matching signature is used as is');
  assert.deepEqual(Array.from(r2.X), Array.from(r1.X));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'TST.json'), 'utf8')).v, 2, 'and upgraded to month signatures');
});

test('row threads: TA_ROW_WORKERS when set (the remote runner: every core), else TRAIN_WORKERS; never above the cores', () => {
  const cores = os.cpus().length;
  assert.equal(taRowWorkerCount({ TRAIN_WORKERS: '1', TA_ROW_WORKERS: '3' }), Math.min(3, cores));
  assert.equal(taRowWorkerCount({ TRAIN_WORKERS: '2' }), Math.min(2, cores));
  assert.equal(taRowWorkerCount({}), 1);
  assert.equal(taRowWorkerCount({ TA_ROW_WORKERS: '999' }), cores);
});

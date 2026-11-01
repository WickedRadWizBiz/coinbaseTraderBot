import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { test } from 'node:test';
import { auc, dayRows, discriminate, FEATURES, outcome, type Row } from '../research/historyTwin';
import { tmpDir } from './helpers';

const D0 = Date.UTC(2026, 9, 28);
const MIN = 60_000;

test('auc ranks perfectly separated scores 1, reversed 0, ties 0.5', () => {
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]), 0);
  assert.equal(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5);
});

/** Rows whose feature 0 is drawn around `shift`, the rest noise, over three days. */
function rows(src: string, shift: number, seed: number): Row[] {
  let s = seed; const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) - 0.5;
  return Array.from({ length: 300 }, (_, i) => ({ day: `2026-10-2${i % 3}`, ticker: `T${i}`, src, f: FEATURES.map((_, j) => (j === 0 ? shift : 0) + r()) }));
}

test('the adversary finds a real difference and scores identical sources near 0.5', () => {
  const real = rows('real', 0, 1);
  assert.ok(discriminate(real, rows('twin', 0.6, 2), FEATURES.map((_, j) => j)) > 0.8, 'a shifted feature is found');
  const same = discriminate(real, rows('twin', 0, 3), FEATURES.map((_, j) => j));
  assert.ok(Math.abs(same - 0.5) < 0.08, `same source scores ${same}`);
});

test('outcome: an identical twin has zero error and an interval around 0; a kinder one does not', () => {
  const real = new Map([...Array(50).keys()].map((k) => [k, { pnl: (k % 7) - 3, contracts: 2 }] as const));
  const same = outcome(real, real);
  assert.equal(same.rmse, 0); assert.ok(same.lo <= 0 && same.hi >= 0);
  const kind = outcome(real, new Map([...real].map(([k, v]) => [k, { ...v, pnl: v.pnl + 1 }])));
  assert.ok(kind.lo > 0, 'a twin a dollar kinder every window is caught');
});

test('dayRows reads a contract life from book snapshots and deltas alike', async () => {
  const dir = tmpDir();
  const open = D0 + 60 * MIN, close = open + 15 * MIN, tk = 'KXBTC15M-TEST';
  const ev: object[] = [{ t: open - MIN, k: 'market', ticker: tk, series: 'KXBTC15M', asset: 'BTC', openTime: open, closeTime: close }];
  for (let t = open - MIN; t <= close; t += 5000) {
    ev.push({ t, k: 'index', asset: 'BTC', value: 70000 + Math.sin(t / 60000) * 20 });
    const mid = 0.5 + Math.sin(t / 60000) * 0.1;
    ev.push({ t, k: 'book', ticker: tk, bids: [{ price: +(mid - 0.01).toFixed(2), size: 100 }], asks: [{ price: +(mid + 0.01).toFixed(2), size: 120 }] });
  }
  ev.push({ t: close + 1000, k: 'result', ticker: tk, result: 'yes' });
  const f = path.join(dir, 'md-2026-10-28.jsonl.gz');
  fs.writeFileSync(f, zlib.gzipSync(ev.map((e) => JSON.stringify(e)).join('\n') + '\n'));
  const out = await dayRows(f, '2026-10-28', 'real', new Map([[tk, 'yes']]));
  assert.equal(out.length, 1);
  const r = out[0].f;
  assert.ok(Math.abs(r[FEATURES.indexOf('spreadC')] - 2) < 0.6, `spread ${r[0]}`);
  assert.ok(r[FEATURES.indexOf('followIx')] > 0.5, 'the mid follows the index');
  assert.ok(Number.isFinite(r[FEATURES.indexOf('brierT5')]));
});

test('requoteBetween with a lag moves the quote only part of the way', async () => {
  const { requoteBetween } = await import('../research/history/historyReplay');
  const d0 = D0, MINS = 1440 * 4;
  const ixs = new Float64Array(MINS).fill(70000), sgs = new Float64Array(MINS).fill(0.0003);
  // The index jumps up 0.2% at the second print of minute 60.
  for (let i = 60 * 4 + 1; i < MINS; i++) ixs[i] = 70140;
  const m = { ticker: 'T', kind: 'updown' as never, strike: 70000, cap: null, closeTime: d0 + 70 * MIN };
  const run = (lag?: { gInf: number; tauSec: number }) => { const ev: any[] = []; requoteBetween(ev, m, 0.49, 0.51, d0 + 60 * MIN, d0 + 61 * MIN, d0, ixs, sgs, lag); return ev.at(-1)?.bids[0].price as number; };
  const free = run(), lagged = run({ gInf: 0.29, tauSec: 3.9 }), instant = run({ gInf: 1, tauSec: 1e-6 });
  assert.ok(free > 0.5, `the free quote moves up (${free})`);
  assert.equal(instant, free, 'a full, instant lag is the old behaviour');
  assert.ok(lagged > 0.49 && lagged < free, `the lagged quote moves less (${lagged} vs ${free})`);
});

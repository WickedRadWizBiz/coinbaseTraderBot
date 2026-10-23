import assert from 'node:assert/strict';
import path from 'path';
import { test } from 'node:test';
import { AccuracyGate, accuracyBucket, accuracyGroup } from '../bot/strategy/accuracyGate';
import { tmpDir } from './helpers';

const CFG = { enabled: true, window: 150, minMarkets: 40 };

/** Settles `n` 15-minute markets, each seen once at `tau` with the bot's probability `p(y)` and the mid `mid(y)`. */
function run(g: AccuracyGate, n: number, tau: number, p: (y: 0 | 1, i: number) => number, mid: (y: 0 | 1, i: number) => number, prefix = 'KXBTC15M-M') {
  for (let i = 0; i < n; i++) {
    const y = (i % 2) as 0 | 1;
    const t = `${prefix}${i}-00`;
    g.observe(t, tau, p(y, i), mid(y, i));
    g.settle(t, y ? 'yes' : 'no');
  }
}

test('accuracy gate: buckets and groups', () => {
  assert.equal(accuracyGroup('KXBTC15M-26OCT230530-30'), 'updown15m');
  assert.equal(accuracyGroup('KXBTCD-26OCT2306-T81499.99'), 'hourly');
  assert.equal(accuracyBucket('updown15m', 700), 0);
  assert.equal(accuracyBucket('updown15m', 600), 1);
  assert.equal(accuracyBucket('updown15m', 200), 3);
  assert.equal(accuracyBucket('updown15m', 900), undefined);
  assert.equal(accuracyBucket('hourly', 3000), 0);
  assert.equal(accuracyBucket('hourly', 60), undefined);
});

test('accuracy gate: open while warming up, then closed in a bucket where the market mid called results better', () => {
  const g = new AccuracyGate(CFG);
  // The market leans the right way (0.65 / 0.35); the bot sits at 0.5: worse.
  run(g, 39, 700, () => 0.5, (y) => (y ? 0.65 : 0.35));
  assert.equal(g.block('KXETH15M-X-00', 700), undefined, 'fewer than minMarkets: open');
  run(g, 10, 700, () => 0.5, (y) => (y ? 0.65 : 0.35), 'KXSOL15M-M');
  assert.match(g.block('KXETH15M-X-00', 700) ?? '', /600-840 s/);
  // Other buckets have no data: open. The hourly markets keep their own scorecard.
  assert.equal(g.block('KXETH15M-X-00', 200), undefined);
  assert.equal(g.block('KXETHD-X-T1', 3000), undefined);
});

test('accuracy gate: open where the bot called results better than the mid', () => {
  const g = new AccuracyGate(CFG);
  run(g, 60, 500, (y) => (y ? 0.7 : 0.3), () => 0.5);
  const s = g.status().groups.updown15m.buckets[1];
  assert.equal(s.n, 60);
  assert.ok(s.llBot! < s.llMid!);
  assert.equal(g.block('KXBTC15M-X-00', 500), undefined);
});

test('accuracy gate: the temperature k fitted on settled markets widens odds that were too extreme', () => {
  const g = new AccuracyGate(CFG);
  // The bot says 0.9 for the side that wins 70% of the time: too confident, a k above 1 fits better.
  run(g, 100, 700, (y, i) => (i % 10 < 7 ? (y ? 0.9 : 0.1) : (y ? 0.1 : 0.9)), () => 0.5);
  const k = g.status().groups.updown15m.k;
  assert.ok(k > 1.2, `k ${k}`);
});

test('accuracy gate: the snapshot nearest the middle of the bucket is the one scored', () => {
  const g = new AccuracyGate(CFG);
  for (let i = 0; i < 50; i++) {
    const t = `KXBTC15M-M${i}-00`;
    const y = (i % 2) as 0 | 1;
    g.observe(t, 830, y ? 0.1 : 0.9, 0.5);   // near the edge of 600-840: wrong and confident
    g.observe(t, 720, y ? 0.8 : 0.2, 0.5);   // the middle: right
    g.observe(t, 610, y ? 0.1 : 0.9, 0.5);   // near the other edge: wrong again
    g.settle(t, y ? 'yes' : 'no');
  }
  assert.equal(g.block('KXBTC15M-X-00', 700), undefined);
  assert.ok(g.status().groups.updown15m.buckets[0].llBot! < 0.5);
});

test('accuracy gate: odd quotes are not scored; a settled market is scored once; disabled never blocks', () => {
  const g = new AccuracyGate(CFG);
  g.observe('KXBTC15M-A-00', 700, 0.6, 0.99);  // mid outside [0.05, 0.95]
  g.observe('KXBTC15M-B-00', 700, 1, 0.5);     // p at the edge
  g.settle('KXBTC15M-A-00', 'yes');
  g.settle('KXBTC15M-B-00', 'yes');
  assert.equal(g.status().groups.updown15m.buckets[0].n, 0);
  g.observe('KXBTC15M-C-00', 700, 0.6, 0.5);
  g.settle('KXBTC15M-C-00', 'yes');
  g.settle('KXBTC15M-C-00', 'yes');
  assert.equal(g.status().groups.updown15m.buckets[0].n, 1);
  const off = new AccuracyGate({ ...CFG, enabled: false });
  run(off, 60, 700, () => 0.5, (y) => (y ? 0.65 : 0.35));
  assert.equal(off.block('KXETH15M-X-00', 700), undefined);
});

test('accuracy gate: the window keeps the newest markets, and the scorecard survives a restart', () => {
  const file = path.join(tmpDir(), 'accuracy_gate.json');
  let now = Date.parse('2026-10-23T12:00:00Z');
  const g = new AccuracyGate({ ...CFG, window: 50 }, file, () => now);
  run(g, 50, 700, () => 0.5, (y) => (y ? 0.65 : 0.35));
  // The newest 50: the bot better now, so the bucket reopens.
  run(g, 50, 700, (y) => (y ? 0.75 : 0.25), (y) => (y ? 0.55 : 0.45), 'KXSOL15M-M');
  assert.equal(g.status().groups.updown15m.buckets[0].n, 50);
  assert.equal(g.block('KXETH15M-X-00', 700), undefined);
  now += 120_000;
  g.flush();
  const again = new AccuracyGate({ ...CFG, window: 50 }, file, () => now);
  assert.equal(again.status().groups.updown15m.buckets[0].n, 50);
  assert.equal(again.block('KXETH15M-X-00', 700), undefined);
});

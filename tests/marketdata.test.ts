import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IndexTracker } from '../bot/marketdata/indexTracker';
import { OrderBook } from '../bot/marketdata/orderBook';

test('time-weighted average requires coverage of the window', () => {
  const t = new IndexTracker('BTC');
  for (let s = 0; s <= 120; s++) t.add(100 + (s >= 60 ? 1 : 0), s * 1000);
  const a = t.average(60_000, 120_000)!;
  assert.ok(Math.abs(a.avg - 101) < 1e-9);
  const b = t.average(30_000, 90_000)!;
  assert.ok(Math.abs(b.avg - 100.5) < 1e-9);
  assert.equal(t.average(-10_000, 50_000), undefined); // starts before first print
});

test('average refuses windows with data holes', () => {
  const t = new IndexTracker('BTC');
  t.add(100, 0);
  t.add(100, 1000);
  t.add(100, 20_000); // 19s hole
  assert.equal(t.average(0, 20_000, 5000), undefined);
});

test('staleness and out-of-order prints', () => {
  const t = new IndexTracker('BTC');
  t.add(100, 10_000);
  t.add(99, 5000); // dropped
  assert.equal(t.latest()!.value, 100);
  assert.ok(t.fresh(12_000, 3000));
  assert.equal(t.fresh(14_000, 3000), undefined);
});

test('EWMA vol recovers the simulated sigma and needs warm-up', () => {
  const t = new IndexTracker('BTC', 3_600_000, 600);
  let x = Math.log(100);
  let seed = 7;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  assert.equal(t.vol(), undefined);
  for (let s = 0; s < 3000; s++) { x += 0.0005 * gauss(); t.add(Math.exp(x), s * 1000); }
  const v = t.vol()!;
  assert.ok(Math.abs(v.sigmaPerSqrtSec - 0.0005) / 0.0005 < 0.2, `sigma=${v.sigmaPerSqrtSec}`);
});

test('order book: snapshot, deltas, crossed and staleness checks', () => {
  const b = new OrderBook('T');
  assert.equal(b.isUsable(0, 1000), false);
  b.applySnapshot({ bids: [{ price: 0.45, size: 10 }, { price: 0.44, size: 5 }], asks: [{ price: 0.48, size: 7 }] }, 1000);
  assert.equal(b.bestBid()!.price, 0.45);
  assert.equal(b.bestAsk()!.price, 0.48);
  b.applyDelta('bid', 0.45, -10, 1100);
  assert.equal(b.bestBid()!.price, 0.44);
  b.applyDelta('bid', 0.49, 3, 1200);
  assert.ok(b.isCrossed());
  assert.equal(b.isUsable(1200, 1000), false);
  b.applyDelta('bid', 0.49, -3, 1300);
  assert.equal(b.isUsable(1300, 1000), true);
  assert.equal(b.isUsable(5000, 1000), false);
  b.invalidate();
  assert.equal(b.isUsable(1300, 1000), false);
});

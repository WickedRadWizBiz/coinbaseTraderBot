import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { buildLots, lotPnl, nextLevel, RestingSell, runStudy, wallTarget, type AuditFill } from '../research/makerExitStudy';
import type { Candle } from '../bot/ta/indicators';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'maker-exit-test-'));
const fill = (t: number, side: 'bid' | 'ask', price: number, count: number, fee = 0, ticker = 'KXBTC15M-X'): AuditFill => ({ t, ticker, side, price, count, fee, purpose: 'quote' });

test('lots: opening fills are lots, reductions close them first in first out, a cross through flat opens the other way', () => {
  const lots = buildLots([fill(1, 'bid', 0.4, 10, 0.1), fill(2, 'bid', 0.5, 5), fill(3, 'ask', 0.6, 12, 0.12), fill(4, 'ask', 0.7, 8)]);
  assert.equal(lots.length, 3);
  assert.deepEqual(lots[0].exits.map((x) => [x.qty, x.px]), [[10, 0.6]]);
  assert.deepEqual(lots[1].exits.map((x) => [x.qty, x.px]), [[2, 0.6], [3, 0.7]]);
  assert.ok(Math.abs(lots[0].exits[0].fee - 0.1) < 1e-9);
  // 8 sold, 3 closed long YES: 5 left open a long NO lot at 1 - 0.7.
  assert.equal(lots[2].sign, -1);
  assert.equal(lots[2].n, 5);
  assert.equal(lots[2].entry, 0.3);
});

test('resting sell: through fills on better prints, queue waits for the size ahead, a crossing bid matches once', () => {
  const s = new RestingSell(1, 10, 0.6, 4);
  s.onTrade(1, 0.6, 3, 'yes'); // eats queue ahead
  s.onTrade(2, 0.55, 50, 'yes'); // below our price
  s.onTrade(3, 0.6, 3, 'no'); // a seller, not a buyer of our side
  assert.equal(s.queue, 0);
  s.onTrade(4, 0.6, 3, 'yes'); // 1 ahead left, 2 for us
  assert.equal(s.queue, 2);
  assert.equal(s.through, 0);
  s.onTrade(5, 0.62, 5, 'yes');
  assert.equal(s.through, 5);
  assert.equal(s.queue, 7);
  s.onBook(6, 2);
  s.onBook(7, 2); // the same resting bid: counted once
  assert.equal(s.queue, 9);
  // Long NO: our NO sell at 0.6 is lifted by NO takers paying 1 - YES price.
  const n = new RestingSell(-1, 5, 0.6, 0);
  n.onTrade(1, 0.35, 5, 'no');
  assert.equal(n.through, 5);
});

test('lot dollars: the resting sell beside paper exits, or alone with the rest settling', () => {
  const [lot] = buildLots([fill(1, 'bid', 0.5, 10), fill(10, 'ask', 0.55, 10)]);
  // Paper sold everything at 0.55 at t=10; the target at 0.6 filled 4 at t=5 first.
  assert.ok(Math.abs(lotPnl(lot, 1, [], 0, 0, true) - 0.5) < 1e-9);
  assert.ok(Math.abs(lotPnl(lot, 1, [{ t: 5, qty: 4 }], 0.6, 0, true) - (4 * 0.1 + 6 * 0.05)) < 1e-9);
  // Alone: 4 sold at 0.6, 6 settle at 1.
  assert.ok(Math.abs(lotPnl(lot, 1, [{ t: 5, qty: 4 }], 0.6, 0, false) - (0.4 + 3)) < 1e-9);
  // A maker-fee series charges the resting sell.
  assert.ok(lotPnl(lot, 1, [{ t: 5, qty: 4 }], 0.6, 1, false) < 3.4);
});

test('wall target sits one tick in front of the first big stack above the floor', () => {
  const sell = [{ price: 0.55, size: 5 }, { price: 0.58, size: 6 }, { price: 0.61, size: 200 }, { price: 0.7, size: 300 }];
  assert.equal(wallTarget(sell, 10, 0.56, 0.01), 0.6);
  assert.equal(wallTarget(sell, 10, 0.65, 0.01), 0.69);
  assert.equal(wallTarget(sell, 500, 0.56, 0.01), undefined);
});

test('next level: the nearest swing or hour extreme past spot in the paying direction', () => {
  const bars: Candle[] = [];
  const path = [100, 101, 102, 105, 102, 101, 100, 99, 97, 99, 100, 101, 100, 100, 100, 100];
  path.forEach((c, i) => bars.push({ ts: i * 60_000, o: c, h: c + 0.5, l: c - 0.5, c, v: 0 }));
  assert.equal(nextLevel(bars, 100, true), 101.5);
  assert.equal(nextLevel(bars, 100, false), 96.5);
  assert.equal(nextLevel(bars.slice(0, 5), 100, true), undefined);
});

test('study end to end on a tiny recording: a target that the tape lifts beats a paper exit at a lower price', async () => {
  const dir = tmp();
  const rec = path.join(dir, 'rec'), aud = path.join(dir, 'audit');
  fs.mkdirSync(rec); fs.mkdirSync(aud);
  const day = '2026-10-27', t0 = Date.parse(`${day}T10:00:00Z`), ticker = 'KXBTC15M-26OCT271015-15';
  const L: object[] = [];
  L.push({ t: t0, k: 'market', ticker, series: 'KXBTC15M', asset: 'BTC', openTime: t0, closeTime: t0 + 900_000, strike: 100000, kind: 'greater', tickSize: 0.01 });
  for (let s = 0; s <= 960; s++) L.push({ t: t0 + s * 1000, k: 'index', asset: 'BTC', value: 100000 + s, ts: t0 + s * 1000 });
  L.push({ t: t0 + 1000, k: 'book', ticker, bids: [{ price: 0.48, size: 50 }], asks: [{ price: 0.5, size: 20 }, { price: 0.55, size: 500 }], ts: t0 + 1000 });
  L.push({ t: t0 + 300_000, k: 'trade', ticker, price: 0.6, count: 100, takerSide: 'yes', ts: t0 + 300_000 });
  L.push({ t: t0 + 990_000, k: 'result', ticker, result: 'yes' });
  L.sort((a: any, b: any) => a.t - b.t);
  fs.writeFileSync(path.join(rec, `md-${day}.jsonl`), L.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const iso = (ms: number) => new Date(ms).toISOString();
  const audit = [
    { ts: iso(t0 + 2000), kind: 'order_new', data: { clientOrderId: 'a', purpose: 'entry' } },
    { ts: iso(t0 + 2000), kind: 'fill', data: { fill: { ticker, side: 'bid', price: 0.5, count: 10 }, fee: 0.18, clientOrderId: 'a' } },
    { ts: iso(t0 + 600_000), kind: 'fill', data: { fill: { ticker, side: 'ask', price: 0.52, count: 10 }, fee: 0.18 } },
  ];
  fs.writeFileSync(path.join(aud, `audit-${day}.jsonl`), audit.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const r = await runStudy({ recordings: rec, audit: aud, days: [day] });
  assert.equal(r.lots, 1);
  assert.ok(Math.abs(r.actualUsd - (0.2 - 0.36)) < 1e-6);
  assert.ok(Math.abs(r.holdUsd - (5 - 0.18)) < 1e-6);
  const tp4 = r.byRule['tp+4c'];
  assert.equal(tp4.withTarget, 1);
  assert.equal(tp4.filledThrough, 10);
  // Sold 10 at 0.54 at 5 minutes, before paper's own exit.
  assert.ok(Math.abs(tp4.usd.through.paper[0] - (10 * 0.04 - 0.18)) < 1e-6);
  // The wall at 0.55 (500 contracts): the target rests at 0.54.
  assert.equal(r.byRule.wall.withTarget, 1);
});

import assert from 'node:assert/strict';
import path from 'path';
import { test } from 'node:test';
import { DEFAULT_FEES } from '../bot/fees';
import { OrderBook } from '../bot/marketdata/orderBook';
import { PaperExchange } from '../bot/paper/paperExchange';
import type { CreateOrderRequest } from '../bot/kalshi/types';
import { tmpDir } from './helpers';

function setup() {
  const book = new OrderBook('T');
  book.applySnapshot({ bids: [{ price: 0.45, size: 10 }], asks: [{ price: 0.48, size: 4 }, { price: 0.5, size: 10 }] }, Date.now());
  const ex = new PaperExchange(path.join(tmpDir(), 'p.json'), 100, () => book, () => DEFAULT_FEES);
  return { book, ex };
}

const req = (o: Partial<CreateOrderRequest>): CreateOrderRequest => ({
  ticker: 'T', side: 'bid', count: 5, price: 0.45, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false,
  selfTradePrevention: 'taker_at_cross', clientOrderId: Math.random().toString(36), ...o,
});

test('post-only that would cross is rejected', async () => {
  const { ex } = setup();
  await assert.rejects(ex.createOrder(req({ price: 0.48 })), /post only/);
});

test('IOC walks the visible book and pays taker fees; remainder cancelled', async () => {
  const { ex } = setup();
  const o = await ex.createOrder(req({ price: 0.48, postOnly: false, timeInForce: 'immediate_or_cancel', count: 6 }));
  assert.equal(o.fillCount, 4);
  assert.equal(o.status, 'executed');
  assert.equal((await ex.getPositions())[0].position, 4);
  // 4 @ 0.48 = 1.92, fee ceil(0.07*4*0.48*0.52*100)=7c
  assert.ok(Math.abs((await ex.getBalance()) - (100 - 1.92 - 0.07)) < 1e-9);
});

test('resting order joins the back of the queue and fills only on trades', async () => {
  const { ex } = setup();
  const fills: unknown[] = [];
  ex.on('fill', (f) => fills.push(f));
  const o = await ex.createOrder(req({}));
  ex.onTrade('T', 0.45, 6, 'no'); // eats 6 of 10 ahead
  assert.equal(fills.length, 0);
  ex.onTrade('T', 0.45, 6, 'no'); // 4 more ahead, then 2 for us
  assert.equal(fills.length, 1);
  assert.equal((await ex.getOrder(o.orderId))!.fillCount, 2);
  ex.onTrade('T', 0.44, 1, 'no'); // trade through our price fills the rest
  assert.equal((await ex.getOrder(o.orderId))!.status, 'executed');
  assert.equal((await ex.getPositions())[0].position, 5);
});

test('YES-taker trades do not fill resting YES bids', async () => {
  const { ex } = setup();
  const o = await ex.createOrder(req({}));
  ex.onTrade('T', 0.45, 100, 'yes');
  assert.equal((await ex.getOrder(o.orderId))!.fillCount, 0);
});

test('settlement pays winners and leaves no bankroll refill', async () => {
  const { ex } = setup();
  await ex.createOrder(req({ price: 0.48, postOnly: false, timeInForce: 'immediate_or_cancel', count: 4 }));
  const before = await ex.getBalance();
  ex.settle('T', 'no');
  assert.equal(await ex.getBalance(), before);
  assert.equal((await ex.getPositions()).length, 0);
});

test('expired resting orders are cancelled', async () => {
  const { ex } = setup();
  const o = await ex.createOrder(req({ expirationTime: Math.floor(Date.now() / 1000) - 1 }));
  await ex.getOpenOrders();
  assert.equal((await ex.getOrder(o.orderId))!.status, 'canceled');
});

test('a resting order is filled only by trades the exchange printed after it was placed (late market data)', async () => {
  const book = new OrderBook('T');
  const T0 = Date.parse('2026-10-06T12:00:00Z');
  let now = T0;
  book.applySnapshot({ bids: [{ price: 0.40, size: 10 }], asks: [{ price: 0.48, size: 10 }] }, now);
  const ex = new PaperExchange(undefined, 100, () => book, () => DEFAULT_FEES, () => now);
  const fills: Array<{ count: number }> = [];
  ex.on('fill', (f) => fills.push(f));
  now = T0 + 300_000;
  await ex.createOrder(req({ price: 0.45 }));
  // A trade through our bid that Kalshi printed five minutes ago, delivered only now (a lagging feed).
  ex.onTrade('T', 0.42, 10, 'no', T0);
  assert.equal(fills.length, 0, 'the trade happened before the order existed');
  // Stamped in the same whole second as the order: may have followed it, so it counts.
  ex.onTrade('T', 0.42, 10, 'no', Math.floor(now / 1000) * 1000);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].count, 5);
  // Without a time stamp (older callers) a trade matches as before.
  await ex.createOrder(req({ price: 0.45 }));
  ex.onTrade('T', 0.42, 10, 'no');
  assert.equal(fills.length, 2);
});

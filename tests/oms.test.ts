import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { OrderRejectedError, OrderStateUnknownError } from '../bot/kalshi/types';
import { Oms, OrderIntent } from '../bot/oms/oms';
import { canTransition } from '../bot/oms/orderState';
import { DEFAULT_FEES } from '../bot/fees';
import { FakeGateway } from './fakeGateway';
import { tmpAudit, tmpDir } from './helpers';

function mk(gw: FakeGateway, statePath = path.join(tmpDir(), 'oms.json')) {
  return new Oms({ gateway: gw, audit: tmpAudit(), statePath, feesFor: () => DEFAULT_FEES, sleep: async () => undefined });
}

const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  ticker: 'KXBTC15M-X', asset: 'BTC', windowCloseTs: 10_000_000, side: 'bid', price: 0.45, count: 5,
  timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote',
  fairValue: 0.5, modelId: 'test', decisionId: 'd1', ...over,
});

test('state machine forbids leaving terminal states', () => {
  assert.equal(canTransition('FILLED', 'ACKED'), false);
  assert.equal(canTransition('CANCELED', 'PARTIALLY_FILLED'), false);
  assert.equal(canTransition('ACKED', 'PARTIALLY_FILLED'), true);
});

test('acceptance is not a fill: position unchanged until a fill arrives', async () => {
  const gw = new FakeGateway();
  const oms = mk(gw);
  const rec = await oms.submit(intent());
  assert.equal(rec.state, 'ACKED');
  assert.equal(oms.positions.position('KXBTC15M-X'), 0);
  oms.onFill({ tradeId: 't1', orderId: rec.orderId!, ticker: rec.ticker, side: 'bid', count: 2, price: 0.45, isTaker: false, ts: 1 });
  assert.equal(rec.state, 'PARTIALLY_FILLED');
  assert.equal(oms.positions.position('KXBTC15M-X'), 2);
  oms.onFill({ tradeId: 't2', orderId: rec.orderId!, ticker: rec.ticker, side: 'bid', count: 3, price: 0.45, isTaker: false, ts: 2 });
  assert.equal(rec.state, 'FILLED');
  assert.equal(oms.positions.position('KXBTC15M-X'), 5);
});

test('duplicate fills (WS + REST replay) are applied once', async () => {
  const gw = new FakeGateway();
  const oms = mk(gw);
  const rec = await oms.submit(intent());
  const f = { tradeId: 'dup', orderId: rec.orderId!, ticker: rec.ticker, side: 'bid' as const, count: 1, price: 0.45, isTaker: false, ts: 1 };
  assert.equal(oms.onFill(f), true);
  assert.equal(oms.onFill(f), false);
  assert.equal(oms.positions.position(rec.ticker), 1);
});

test('timeout that actually landed is resolved by client_order_id query, never resent', async () => {
  const gw = new FakeGateway();
  gw.onCreate = () => 'land-then-throw';
  const oms = mk(gw);
  const rec = await oms.submit(intent());
  assert.equal(gw.creates.length, 1, 'no second create');
  assert.equal(gw.orders.length, 1);
  assert.equal(rec.state, 'ACKED');
  assert.equal(rec.orderId, 'ex-1');
});

test('timeout that never landed is resent with the SAME client_order_id', async () => {
  const gw = new FakeGateway();
  gw.onCreate = (req, n) => (n === 1 ? new OrderStateUnknownError('network') : gw.accept(req));
  const oms = mk(gw);
  const rec = await oms.submit(intent());
  assert.equal(gw.creates.length, 2);
  assert.equal(gw.creates[0].clientOrderId, gw.creates[1].clientOrderId);
  assert.equal(rec.state, 'ACKED');
});

test('definitive rejection moves to REJECTED and counts consecutive errors', async () => {
  const gw = new FakeGateway();
  gw.onCreate = () => new OrderRejectedError('HTTP 400: bad', 400, 'invalid');
  const oms = mk(gw);
  let errs = 0;
  oms.on('order_error', (n: number) => { errs = n; });
  const rec = await oms.submit(intent());
  await oms.submit(intent());
  assert.equal(rec.state, 'REJECTED');
  assert.equal(errs, 2);
});

test('client_order_id is persisted before the order is sent and state survives restart', async () => {
  const gw = new FakeGateway();
  const file = path.join(tmpDir(), 'oms.json');
  let persistedBeforeSend = false;
  gw.onCreate = (req) => {
    persistedBeforeSend = fs.readFileSync(file, 'utf8').includes(req.clientOrderId);
    return gw.accept(req);
  };
  const oms = mk(gw, file);
  const rec = await oms.submit(intent());
  assert.ok(persistedBeforeSend);
  oms.flush(); // later transitions are coalesced; shutdown flushes them
  const reloaded = mk(gw, file);
  assert.equal(reloaded.get(rec.clientOrderId)?.state, 'ACKED');
});

test('cancel requested before ack is honoured on ack; exits tracked until confirmed', async () => {
  const gw = new FakeGateway();
  const oms = mk(gw);
  const rec = await oms.submit(intent());
  await oms.cancel(rec.clientOrderId, 'test');
  assert.equal(rec.state, 'CANCELED');
  assert.deepEqual(gw.cancels, ['ex-1']);
});

test('cancelAll also cancels exchange orders the OMS does not know', async () => {
  const gw = new FakeGateway();
  const oms = mk(gw);
  gw.accept({ ticker: 'X', side: 'bid', count: 1, price: 0.3, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, selfTradePrevention: 'taker_at_cross', clientOrderId: 'foreign' });
  await oms.cancelAll('kill');
  assert.ok(gw.cancels.includes('ex-1'));
});

test('settlement realizes fee-inclusive PnL', async () => {
  const gw = new FakeGateway();
  const oms = mk(gw);
  const rec = await oms.submit(intent({ side: 'bid', price: 0.4, count: 10 }));
  oms.onFill({ tradeId: 'a', orderId: rec.orderId!, ticker: rec.ticker, side: 'bid', count: 10, price: 0.4, isTaker: true, fee: 0.17, ts: 1 });
  const m = oms.settle(rec.ticker, 'yes')!;
  assert.ok(Math.abs(m.realized! - (10 - 4 - 0.17)) < 1e-9);
  assert.equal(oms.positions.position(rec.ticker), 0);
});

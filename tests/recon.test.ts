import assert from 'node:assert/strict';
import path from 'path';
import { test } from 'node:test';
import { DEFAULT_FEES } from '../bot/fees';
import { Oms } from '../bot/oms/oms';
import { Reconciler } from '../bot/recon/reconciler';
import { FakeGateway } from './fakeGateway';
import { tmpAudit, tmpDir } from './helpers';

function setup() {
  const gw = new FakeGateway();
  const audit = tmpAudit();
  const oms = new Oms({ gateway: gw, audit, statePath: path.join(tmpDir(), 'o.json'), feesFor: () => DEFAULT_FEES, sleep: async () => undefined });
  const breaks: string[] = [];
  const recon = new Reconciler({ gateway: gw, oms, audit, getMarket: async () => undefined, onPersistentBreak: (r) => breaks.push(r), killAfterBreaks: 2 });
  return { gw, oms, recon, breaks };
}

test('clean state reconciles and clears the startup halt', async () => {
  const { recon } = setup();
  assert.equal(recon.halted, true);
  const r = await recon.run('startup');
  assert.equal(r!.ok, true);
  assert.equal(recon.halted, false);
});

test('a missed WebSocket fill is repaired from REST, not a break', async () => {
  const { gw, oms, recon } = setup();
  const rec = await oms.submit({ ticker: 'T', asset: 'BTC', windowCloseTs: Date.now() + 600_000, side: 'bid', price: 0.4, count: 3, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', fairValue: 0.5, modelId: 'm', decisionId: 'd' });
  gw.orders[0].status = 'executed'; gw.orders[0].fillCount = 3; gw.orders[0].remainingCount = 0;
  gw.fills.push({ tradeId: 'f1', orderId: rec.orderId!, clientOrderId: rec.clientOrderId, ticker: 'T', side: 'bid', count: 3, price: 0.4, isTaker: false, ts: Date.now() });
  gw.positions = [{ ticker: 'T', position: 3 }];
  const r = await recon.run('interval');
  assert.equal(r!.ok, true, r!.breaks.join('; '));
  assert.equal(r!.repairedFills, 1);
  assert.equal(oms.positions.position('T'), 3);
  assert.equal(rec.state, 'FILLED');
});

test('unexplained exchange position is a break; persistent breaks trip the kill switch', async () => {
  const { gw, recon, breaks } = setup();
  gw.positions = [{ ticker: 'T', position: 2 }];
  const r = await recon.run('interval');
  assert.equal(r!.ok, false);
  assert.equal(recon.halted, true);
  await recon.run('interval');
  assert.equal(breaks.length, 1);
});

test('orphan resting orders are cancelled and reported', async () => {
  const { gw, recon } = setup();
  gw.accept({ ticker: 'T', side: 'bid', count: 1, price: 0.3, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, selfTradePrevention: 'taker_at_cross', clientOrderId: 'not-ours' });
  const r = await recon.run('interval');
  assert.equal(r!.ok, false);
  assert.equal(r!.orphanOrdersCanceled, 1);
  assert.deepEqual(gw.cancels, ['ex-1']);
});

test('closed market is settled from the exchange result before comparing', async () => {
  const gw = new FakeGateway();
  const audit = tmpAudit();
  const oms = new Oms({ gateway: gw, audit, statePath: path.join(tmpDir(), 'o.json'), feesFor: () => DEFAULT_FEES, sleep: async () => undefined });
  oms.onFill({ tradeId: 'x', orderId: '', ticker: 'OLD', side: 'bid', count: 2, price: 0.5, isTaker: false, fee: 0, ts: 1 }, { closeTs: 1000, asset: 'BTC' });
  const recon = new Reconciler({ gateway: gw, oms, audit, getMarket: async () => ({ ticker: 'OLD', seriesTicker: 'S', status: 'settled', openTime: 0, closeTime: 1000, tickSize: 0.01, result: 'yes' }), onPersistentBreak: () => undefined });
  gw.fills = [];
  const r = await recon.run('interval');
  assert.equal(r!.ok, true, r!.breaks.join('; '));
  assert.ok(Math.abs(oms.positions.get('OLD')!.realized! - 1) < 1e-9);
});

test('an order the exchange no longer knows: a break in live, closed locally in paper (a paper book started fresh)', async () => {
  for (const paper of [false, true]) {
    const gw = new FakeGateway();
    const audit = tmpAudit();
    const oms = new Oms({ gateway: gw, audit, statePath: path.join(tmpDir(), 'o.json'), feesFor: () => DEFAULT_FEES, sleep: async () => undefined });
    const rec = await oms.submit({ ticker: 'T', asset: 'BTC', windowCloseTs: Date.now() + 600_000, side: 'bid', price: 0.4, count: 3, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', fairValue: 0.5, modelId: 'm', decisionId: 'd' });
    gw.orders.length = 0; // the exchange forgot it
    const recon = new Reconciler({ gateway: gw, oms, audit, getMarket: async () => undefined, onPersistentBreak: () => undefined, closeUnknownOrders: paper });
    const r = await recon.run('interval');
    if (paper) {
      assert.equal(r!.ok, true, r!.breaks.join('; '));
      assert.equal(rec.state, 'CANCELED');
      assert.equal((await recon.run('interval'))!.ok, true, 'and stays clean');
    } else {
      assert.equal(r!.ok, false);
      assert.match(r!.breaks.join('; '), /unknown to exchange/);
    }
  }
});

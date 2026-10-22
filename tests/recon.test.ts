import assert from 'node:assert/strict';
import path from 'path';
import { test } from 'node:test';
import { DEFAULT_FEES } from '../bot/fees';
import { Oms } from '../bot/oms/oms';
import { Reconciler } from '../bot/recon/reconciler';
import { FakeGateway } from './fakeGateway';
import { tmpAudit, tmpDir } from './helpers';

function setup(opts: Partial<ConstructorParameters<typeof Reconciler>[0]> = {}) {
  const gw = new FakeGateway();
  const audit = tmpAudit();
  const oms = new Oms({ gateway: gw, audit, statePath: path.join(tmpDir(), 'o.json'), feesFor: () => DEFAULT_FEES, sleep: async () => undefined });
  const breaks: string[] = [];
  const recon = new Reconciler({ gateway: gw, oms, audit, getMarket: async () => undefined, onPersistentBreak: (r) => breaks.push(r), killAfterBreaks: 2, ...opts });
  return { gw, oms, recon, breaks, audit };
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

test('unexplained exchange position is a break; persistent breaks trip the kill switch (no automatic adoption)', async () => {
  const { gw, recon, breaks } = setup({ adoptAfterRuns: 0 });
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

test('live: a resting order the bot did not place is the operator\'s own: left alone and listed, not a break', async () => {
  const { gw, recon } = setup({ leaveExternalOrders: true });
  gw.accept({ ticker: 'T', side: 'ask', count: 5, price: 0.7, timeInForce: 'good_till_canceled', postOnly: false, reduceOnly: false, selfTradePrevention: 'taker_at_cross', clientOrderId: 'placed-on-kalshi' });
  const r = await recon.run('startup');
  assert.equal(r!.ok, true, r!.breaks.join('; '));
  assert.deepEqual(gw.cancels, [], 'never cancelled');
  assert.deepEqual(r!.externalOrders.map((o) => [o.ticker, o.side, o.price, o.remaining]), [['T', 'ask', 0.7, 5]]);
  assert.equal(recon.halted, false);
});

test('a trade made by hand on Kalshi is booked from its fill: the position follows, no break', async () => {
  const { gw, oms, recon } = setup({ leaveExternalOrders: true });
  oms.onFill({ tradeId: 'bot-1', orderId: 'o1', ticker: 'T', side: 'bid', count: 10, price: 0.4, isTaker: false, fee: 0, ts: Date.now() - 60_000 });
  // Sold 6 of them on Kalshi: the fill is for an order the bot never sent.
  gw.fills.push({ tradeId: 'hand-1', orderId: 'kalshi-app-order', ticker: 'T', side: 'ask', count: 6, price: 0.55, isTaker: true, fee: 0.07, ts: Date.now() - 1000 });
  gw.positions = [{ ticker: 'T', position: 4 }];
  const r = await recon.run('interval');
  assert.equal(r!.ok, true, r!.breaks.join('; '));
  assert.equal(oms.positions.position('T'), 4);
});

test('a fill outside the usual replay window is found in the market\'s own fill history', async () => {
  const { gw, oms, recon } = setup();
  const now = Date.now();
  oms.onFill({ tradeId: 'a', orderId: 'o1', ticker: 'T', side: 'bid', count: 10, price: 0.4, isTaker: false, fee: 0, ts: now - 60_000 });
  // Sold an hour ago (before the bot's last fill minus the 10-minute replay margin).
  gw.fills.push({ tradeId: 'old', orderId: 'x', ticker: 'T', side: 'ask', count: 10, price: 0.6, isTaker: true, fee: 0.17, ts: now - 3_600_000 });
  gw.positions = [];
  const r = await recon.run('interval');
  assert.equal(r!.ok, true, r!.breaks.join('; '));
  assert.equal(oms.positions.position('T'), 0);
  assert.equal(r!.adopted.length, 0, 'found, not adopted');
});

test('an unexplained mismatch seen twice adopts Kalshi\'s position at Kalshi\'s mid, with an audit record', async () => {
  const market = { ticker: 'T', seriesTicker: 'S', status: 'active', openTime: 0, closeTime: Date.now() + 600_000, tickSize: 0.01, yesMid: 0.62 };
  const { gw, oms, recon, breaks, audit } = setup({ getMarket: async () => market });
  oms.onFill({ tradeId: 'a', orderId: 'o1', ticker: 'T', side: 'bid', count: 10, price: 0.4, isTaker: false, fee: 0, ts: Date.now() - 60_000 });
  gw.positions = []; // sold on Kalshi, and no fill to show for it
  const first = await recon.run('interval');
  assert.equal(first!.ok, false);
  assert.match(first!.breaks[0], /adopted if this persists/);
  const second = await recon.run('interval');
  assert.equal(second!.ok, true, second!.breaks.join('; '));
  assert.equal(oms.positions.position('T'), 0);
  assert.match(second!.adopted[0], /adopted Kalshi's 0 at 0\.62 \(auto\)/);
  assert.ok(Math.abs(oms.positions.get('T')!.netCash - (-4 + 6.2)) < 1e-9, 'priced at the mid');
  assert.equal(breaks.length, 0, 'the kill switch never tripped');
  const rec = audit.tail(5, 'recon_adopt')[0] as { data: Record<string, unknown> };
  assert.deepEqual([rec.data.ticker, rec.data.ours, rec.data.theirs, rec.data.by], ['T', 10, 0, 'auto']);
  await recon.run('interval');
  assert.equal(recon.halted, false, 'two clean runs lift the halt');
});

test('the operator resolves: Kalshi\'s position adopted at once and the halt lifted on that run', async () => {
  const { gw, oms, recon } = setup({ adoptAfterRuns: 0 });
  gw.positions = [{ ticker: 'T', position: -3 }];
  assert.equal((await recon.run('interval'))!.ok, false);
  assert.equal(recon.halted, true);
  const r = await recon.run('operator', { adopt: true });
  assert.equal(r!.ok, true, r!.breaks.join('; '));
  assert.equal(oms.positions.position('T'), -3);
  assert.match(r!.adopted[0], /\(operator\)/);
  assert.equal(recon.halted, false);
});

test('automatic adoptions are capped per hour; past the cap mismatches stay breaks until the operator resolves', async () => {
  let t = 1_000_000_000_000;
  const { gw, oms, recon } = setup({ now: () => t, killAfterBreaks: 99 });
  for (let i = 1; i <= 4; i++) {
    gw.positions = [...gw.positions, { ticker: `T${i}`, position: i }];
    await recon.run('interval'); t += 45_000;
    await recon.run('interval'); t += 45_000;
  }
  assert.deepEqual([1, 2, 3, 4].map((i) => oms.positions.position(`T${i}`)), [1, 2, 3, 0]);
  assert.match(recon.lastResult!.breaks.join('; '), /T4: internal 0 vs exchange 4 \(3 positions already adopted this hour/);
  t += 3_600_000;
  assert.equal((await recon.run('interval'))!.ok, true, 'an hour later the next one is adopted');
  assert.equal(oms.positions.position('T4'), 4);
});

test('a market settled in the books that Kalshi still lists (not paid out yet) is not a break', async () => {
  const { gw, oms, recon } = setup();
  oms.onFill({ tradeId: 'a', orderId: 'o1', ticker: 'T', side: 'bid', count: 5, price: 0.4, isTaker: false, fee: 0, ts: Date.now() - 60_000 }, { closeTs: Date.now() - 1000 });
  oms.settle('T', 'yes');
  gw.positions = [{ ticker: 'T', position: 5 }];
  const r = await recon.run('interval');
  assert.equal(r!.ok, true, r!.breaks.join('; '));
});

test('a market the bot never priced (traded by hand) has its close time looked up and is settled from its result', async () => {
  const { gw, oms, recon } = setup({ getMarket: async (t) => ({ ticker: t, seriesTicker: 'S', status: 'settled', openTime: 0, closeTime: Date.now() - 60_000, tickSize: 0.01, result: 'no' as const }) });
  gw.fills.push({ tradeId: 'hand', orderId: 'kalshi-app', ticker: 'ELSEWHERE', side: 'bid', count: 2, price: 0.3, isTaker: true, fee: 0.03, ts: Date.now() - 5000 });
  gw.positions = [{ ticker: 'ELSEWHERE', position: 2 }];
  assert.equal((await recon.run('interval'))!.ok, true, 'booked from the fill');
  gw.positions = []; // the market settled on Kalshi
  const r = await recon.run('interval');
  assert.equal(r!.ok, true, r!.breaks.join('; '));
  assert.equal(oms.positions.get('ELSEWHERE')!.settled, true);
  assert.ok(Math.abs(oms.positions.get('ELSEWHERE')!.realized! - (-0.6 - 0.03)) < 1e-9);
});

test('a market Kalshi has resolved but not paid out stays out of the breaks while Kalshi reports our result; a different result is a break', async () => {
  for (const kalshiResult of ['yes', ''] as const) {
    let result: 'yes' | '' = kalshiResult;
    const later = Date.now() + 15 * 60_000; // past the grace: Kalshi is asked
    const { gw, oms, recon } = setup({ now: () => later, getMarket: async (t) => ({ ticker: t, seriesTicker: 'S', status: result ? 'determined' : 'closed', openTime: 0, closeTime: 0, tickSize: 0.01, result }) });
    oms.onFill({ tradeId: 'a', orderId: 'o1', ticker: 'XRPD', side: 'ask', count: 3.4, price: 0.26, isTaker: false, fee: 0, ts: Date.now() - 600_000 }, { closeTs: Date.now() - 60_000 });
    oms.settle('XRPD', 'yes');
    gw.positions = [{ ticker: 'XRPD', position: -3.4 }];
    const r = await recon.run('startup');
    if (kalshiResult === 'yes') {
      assert.equal(r!.ok, true, r!.breaks.join('; '));
      assert.equal(recon.halted, false);
    } else {
      assert.equal(r!.ok, false);
      assert.match(r!.breaks[0], /settled yes in the books, but Kalshi still holds it/);
      result = 'yes';
    }
  }
});

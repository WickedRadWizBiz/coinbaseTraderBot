import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { PerpHedger, type HedgeParams } from '../bot/perps/hedger';
import { PaperPerpExchange } from '../bot/perps/paperPerp';
import { PerpHub, type PerpSnapshot } from '../bot/perps/perpData';
import { KalshiPerpsRest, parsePerpBalance, parsePerpOrder, parsePerpRisk } from '../bot/perps/perpRest';
import { PerpModel, priorMuBps, type PerpModelParams } from '../bot/perps/perpSignal';
import { decidePerp, PerpTrader, type PerpDecisionInput, type PerpTraderParams } from '../bot/perps/perpTrader';

const T0 = 1_800_000_000_000;
// A realistic per-contract market: 0.001 BTC contracts priced ~$100 (index $100,000).
const snap = (o: Partial<PerpSnapshot> = {}): PerpSnapshot => ({ ticker: 'BTC-PERP', asset: 'BTC', ts: T0, bid: 99.99, ask: 100.01, contractSize: 0.001, fractional: true, fundingRate: 0, tickSize: 0.01, leverage: 10, ...o });

const P: PerpTraderParams = {
  horizonMin: 240, entryEdgeBps: 5, exitEdgeBps: 0, kellyFraction: 0.25, maxLeverage: 3, maxNotionalUsd: 500, maxTotalNotionalUsd: 1000,
  stopAtrMult: 2, minStopBps: 50, maxHoldMin: 480, dailyLossFrac: 0.1, cooldownMin: 60, pilotMaxNotionalUsd: 25, pilotMaxLeverage: 1,
  priorIc: 0.05, makerBps: 5, requireValidation: false, minEquityUsd: 5,
};
const base = (o: Partial<PerpDecisionInput> = {}): PerpDecisionInput => ({
  asset: 'BTC', ticker: 'BTC-PERP', muBps: 40, sigmaHBps: 100, validated: true, source: 'model', bid: 99.99, ask: 100.01, fundingRate: 0,
  current: 0, equity: 1000, atrFrac: 0.004, marketLeverage: 10, step: 0.01, otherNotional: 0, ...o,
});

test('REST: spec rules and shapes (reduce-only needs IOC, create response, balance, risk, exchange stop)', async () => {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  const fake = (async (url: string, init: any) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const body = url.includes('/margin/orders') ? { order_id: 'o9', client_order_id: 'c9', fill_count: '0.00', remaining_count: '1.50' }
      : url.includes('/margin/balance') ? { subaccount_balances: [{ subaccount: 0, position_value: '10', account_equity: '123.4500', maintenance_margin: '2', initial_margin: '3', resting_orders_margin: '0', available_balance: '99.0000' }], settled_funds: '113.45' }
      : url.includes('/margin/enabled') ? { enabled: true } : {};
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const c = new KalshiPerpsRest('https://external-api.demo.kalshi.co/trade-api/v2', { headers: () => ({}) } as any, fake);
  await assert.rejects(() => c.createOrder({ ticker: 'BTC-PERP', side: 'ask', count: 1, price: 100, clientOrderId: 'x', postOnly: true, reduceOnly: true }), /reduce_only requires/);
  assert.equal(calls.length, 0, 'rejected locally, never sent');
  const o = await c.createOrder({ ticker: 'BTC-PERP', side: 'bid', count: 1.5, price: 99.99, clientOrderId: 'c9', postOnly: true, reduceOnly: false });
  assert.deepEqual([o.orderId, o.ticker, o.side, o.price, o.remaining, o.status], ['o9', 'BTC-PERP', 'bid', 99.99, 1.5, 'resting'], 'CreateMarginOrderResponse has no ticker/side: taken from the request');
  assert.equal(calls[0].body.price, '99.9900');
  const b = await c.getBalance();
  assert.deepEqual([b.equity, b.available], [123.45, 99]);
  assert.ok(calls.some((x) => x.url.endsWith('/margin/balance?compute_available_balance=true')));
  assert.equal(await c.enabled(), true);
  await c.setStopLoss('BTC-PERP', 98.5);
  const put = calls.find((x) => x.method === 'PUT')!;
  assert.equal(put.url, 'https://external-api.demo.kalshi.co/trade-api/v2/margin/cross/positions/BTC-PERP/exit_trigger');
  assert.deepEqual(put.body, { kind: 'bracket', stop_loss_price: '98.5000' });
  await c.clearStopLoss('BTC-PERP');
  assert.ok(calls.some((x) => x.method === 'DELETE' && x.url.includes('/exit_trigger?kind=bracket')));
  assert.equal(parsePerpOrder({ order_id: 'a', fill_count: '2', remaining_count: '0' }).status, 'executed');
  assert.equal(parsePerpBalance({ subaccount_balances: [{ subaccount: 0, account_equity: '0', position_value: '5' }], settled_funds: '20' })!.equity, 25, 'self-clearing: settled funds + position value');
  assert.deepEqual(parsePerpRisk({ positions: [{ market_ticker: 'BTC-PERP', position: '-2', mark_price: '100', position_notional: '200', position_leverage: 4, estimated_liquidation_price: '120' }] })[0], { ticker: 'BTC-PERP', position: -2, mark: 100, notional: 200, leverage: 4, liquidationPrice: 120 });
});

test('paper perps: per-contract notional, reduce-only only on IOC, exchange stop fires on the liquidation mark, equity', async () => {
  const hub = new PerpHub();
  let now = T0;
  hub.apply(snap({ ts: now }));
  const sim = new PaperPerpExchange(hub, () => 'BTC', { makerBps: 5, takerBps: 12 }, undefined, () => now, 100);
  await assert.rejects(() => sim.createOrder({ ticker: 'BTC-PERP', side: 'ask', count: 1, price: 100.01, clientOrderId: 'r', postOnly: true, reduceOnly: true }), /reduce_only/);
  await sim.createOrder({ ticker: 'BTC-PERP', side: 'bid', count: 2, price: 100.02, clientOrderId: 'e', postOnly: false, reduceOnly: false, timeInForce: 'immediate_or_cancel' });
  const led = sim.ledger()['BTC-PERP'];
  assert.ok(Math.abs(led.fees - 2 * 100.01 * 12 / 1e4) < 1e-9, 'fee on count x price (per-contract price)');
  await sim.setStopLoss('BTC-PERP', 99);
  now += 1000; hub.apply(snap({ ts: now, bid: 99.5, ask: 99.52, liquidationMark: 99.4 })); sim.step();
  assert.equal((await sim.getPositions()).length, 1, 'above the stop: still open');
  now += 1000; hub.apply(snap({ ts: now, bid: 98.9, ask: 98.92, liquidationMark: 98.95 })); sim.step();
  assert.equal((await sim.getPositions()).length, 0, 'liquidation mark crossed the stop: closed reduce-only at the bid');
  assert.equal(sim.stopFills(), 1);
  const eq = (await sim.getBalance()).equity;
  assert.ok(Math.abs(eq - (100 + 2 * (98.9 - 100.01) - led.fees)) < 1e-6, `equity ${eq}`);
});

test('decision: cost-aware entry, hysteresis, funding, stops, caps, pilot size and halts', () => {
  // Strong long signal, validated: size = min(Kelly leverage, caps) x equity.
  const d = decidePerp(base(), P);
  assert.ok(d.target > 0, d.reason);
  const net = 40 - 10;
  const kellyLev = 0.25 * (net / 1e4) / (0.01 * 0.01);
  assert.ok(Math.abs(d.leverage! - Math.min(kellyLev, 3, 5, 0.5 / 0.008)) < 1e-9, `${d.leverage}`);
  assert.ok(d.target * 100 <= 500 + 1e-9, 'per-asset notional cap');
  assert.ok(d.stopPrice! < 100 && Math.abs(d.stopPrice! - 100 * (1 - 0.008)) < 1e-3, 'stop 2 x ATR (0.8%) under the entry');
  // Edge below costs + threshold: stay flat.
  assert.equal(decidePerp(base({ muBps: 12 }), P).target, 0);
  // Funding: a positive rate makes the long pay (8 h rate 0.1% over a 4 h hold = 5 bps).
  assert.equal(decidePerp(base({ muBps: 18, fundingRate: 0.001 }), P).target, 0, '18 - 10 - 5 = 3 < 5');
  assert.ok(decidePerp(base({ muBps: 18, fundingRate: -0.001 }), P).target > 0, 'negative funding pays longs');
  // Unvalidated: pilot caps ($25, 1x).
  const pilot = decidePerp(base({ validated: false, source: 'prior' }), P);
  assert.ok(pilot.target * 100 <= 25 + 1e-9 && pilot.target > 0, pilot.reason);
  assert.match(pilot.reason, /pilot size/);
  // Hysteresis: holding a long needs only exit cost + exitEdge; a small positive mu keeps it.
  assert.ok(decidePerp(base({ current: 2, entryPrice: 100, muBps: 7 }), P).target > 0);
  assert.equal(decidePerp(base({ current: 2, entryPrice: 100, muBps: -2 }), P).target, 0);
  // A strong opposite signal reverses.
  assert.ok(decidePerp(base({ current: 2, entryPrice: 100, muBps: -40 }), P).target < 0);
  // Stop hit (bid through the stop): urgent flatten.
  const stop = decidePerp(base({ current: 2, entryPrice: 100, bid: 99.1, ask: 99.12 }), P);
  assert.deepEqual([stop.target, stop.urgent], [0, true]);
  // Held too long without a fresh entry-strength signal: exit.
  assert.equal(decidePerp(base({ current: 2, entryPrice: 100, muBps: 12, heldMin: 600 }), P).target, 0);
  // Halt: flatten urgently; no-entry: existing positions managed, no new ones.
  assert.deepEqual([decidePerp(base({ current: 2, halt: 'kill switch' }), P).urgent, decidePerp(base({ current: 2, halt: 'kill switch' }), P).target], [true, 0]);
  assert.equal(decidePerp(base({ noEntry: 'clock skew' }), P).target, 0);
  // Stop must sit inside the liquidation distance: leverage <= 0.5 / stop distance and <= half the exchange estimate.
  assert.ok(decidePerp(base({ marketLeverage: 2, muBps: 500, sigmaHBps: 60 }), P).leverage! <= 1 + 1e-9);
  // Total notional cap across assets.
  assert.equal(decidePerp(base({ otherNotional: 1000 }), P).target, 0);
  // Prior: IC x sigma_H x clipped 4h momentum z.
  assert.equal(priorMuBps({ ret_4h_z: 3 }, 100, 0.05), 10);
  assert.equal(priorMuBps({ ret_4h_z: NaN }, 100, 0.05), undefined);
});

const model = (bias: number, validated: boolean): PerpModel => new PerpModel({
  version: 't', kind: 'linear', horizonMin: 240, features: ['ret_4h_z'], mean: [0], std: [1], weights: [0], bias, residStdBps: 100, lambda: 1, trainedAt: 'x',
  validation: validated ? { passed: true, nEff: 500, ic: 0.1, icCiLo: 0.02, pnlBpsPerTrade: 5, pnlCiLo: 1, dsrProbability: 0.99, trials: 4, backtest: { ok: true, pnlUsd: 10, pnlCiLo: 1, dsrProbability: 0.97, trades: 100, days: 60, fees: 1, funding: 0 } } : undefined,
} as PerpModelParams);

test('live loop: executor + trader enter as maker, set the exchange stop, stop out, cool down, flatten on kill', async () => {
  const hub = new PerpHub();
  let now = T0;
  hub.apply(snap({ ts: now }));
  const sim = new PaperPerpExchange(hub, () => 'BTC', { makerBps: 5, takerBps: 12 }, undefined, () => now, 1000);
  const H: HedgeParams = { minDollarDelta: 2000, maxNotionalUsd: 1000, excludeTauSec: 120, repriceSec: 30, takerAfterSec: 300 };
  const ex = new PerpHedger({ gateway: sim, hub, params: H, now: () => now, minTickMs: 0 });
  const trader = new PerpTrader({ params: P, hub, gateway: sim, model: model(40, true), sources: () => ({}) });
  const tick = (halt?: string) => ex.tick([], { directional: (c) => trader.targets({ ...c, now }, { halt }) });
  await tick();
  const q = (await sim.getOpenOrders())[0];
  assert.ok(q && q.side === 'bid' && q.price === 99.99, 'long entry joins the bid (post-only maker)');
  // The market trades through the bid: filled.
  now += 5000; hub.apply(snap({ ts: now, bid: 99.95, ask: 99.98 })); sim.step();
  const pos = (await sim.getPositions())[0];
  assert.ok(pos.position > 0);
  await tick();
  const stop = sim.stopFor('BTC-PERP');
  assert.ok(stop !== undefined && stop < 99.99, `exchange-side stop set at ${stop}`);
  // Price collapses through the stop: the exchange trigger closes the position.
  now += 5000; hub.apply(snap({ ts: now, bid: 98.5, ask: 98.52, liquidationMark: 98.5 })); sim.step();
  assert.equal((await sim.getPositions()).length, 0);
  await tick();
  assert.match(trader.lastDecisions.get('BTC-PERP')!.reason, /cooldown/);
  assert.equal((await sim.getOpenOrders()).length, 0, 'no re-entry during the cooldown');
  // Kill switch with an open position: urgent reduce-only IOC flatten.
  const t2 = new PerpTrader({ params: { ...P, cooldownMin: 0 }, hub, gateway: sim, model: model(40, true), sources: () => ({}) });
  await sim.createOrder({ ticker: 'BTC-PERP', side: 'bid', count: 1, price: 99, clientOrderId: 'm', postOnly: false, reduceOnly: false, timeInForce: 'immediate_or_cancel' });
  assert.equal((await sim.getPositions())[0].position, 1);
  now += 5000;
  await ex.tick([], { reduceOnly: true, directional: (c) => t2.targets({ ...c, now }, { halt: 'kill switch engaged' }) });
  assert.equal((await sim.getPositions()).length, 0, 'flattened immediately');
});

test('perp daily loss stop flattens and halts for the day; unvalidated model trades pilot size only', async () => {
  const hub = new PerpHub();
  let now = T0;
  hub.apply(snap({ ts: now }));
  const sim = new PaperPerpExchange(hub, () => 'BTC', { makerBps: 5, takerBps: 12 }, undefined, () => now, 100);
  const ex = new PerpHedger({ gateway: sim, hub, params: { minDollarDelta: 2000, maxNotionalUsd: 1000, excludeTauSec: 120, repriceSec: 30, takerAfterSec: 300 }, now: () => now, minTickMs: 0 });
  const trader = new PerpTrader({ params: P, hub, gateway: sim, model: model(40, false), sources: () => ({}) });
  await ex.tick([], { directional: (c) => trader.targets({ ...c, now }, {}) });
  const q = (await sim.getOpenOrders())[0];
  assert.ok(q.remaining * q.price <= 25 + 1e-6, `pilot notional ${q.remaining * q.price}`);
  // Fill, then a 15% equity drop: daily loss stop.
  now += 1000; hub.apply(snap({ ts: now, bid: 99.95, ask: 99.98 })); sim.step();
  await sim.createOrder({ ticker: 'BTC-PERP', side: 'bid', count: 5, price: 101, clientOrderId: 'big', postOnly: false, reduceOnly: false, timeInForce: 'immediate_or_cancel' });
  now += 40_000; hub.apply(snap({ ts: now, bid: 96, ask: 96.02 })); sim.step();
  await ex.tick([], { directional: (c) => trader.targets({ ...c, now }, {}) });
  assert.match(String(trader.status().dayHalt), /perp daily loss/);
  assert.equal((await sim.getPositions()).length, 0, 'flattened');
});

test('perps config: directional trading simulated by default; live needs live mode + keys; hedge and trading share one account', () => {
  const c = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) });
  assert.equal(c.perps.trading, 'paper');
  assert.equal(c.perps.pilotMaxNotionalUsd, 25);
  assert.throws(() => loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), PERP_TRADING: 'live' }), /TRADING_MODE=live/);
  assert.throws(() => loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), PERP_HEDGE: 'off', PERP_TRADING: 'live', TRADING_MODE: 'paper' }), /TRADING_MODE=live/);
  assert.equal(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), PERP_HEDGE: 'off', PERP_TRADING: 'paper' }).perps.hedge, 'off');
  assert.equal(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), PERP_TRADING: 'off' }).perps.trading, 'off');
});

import path from 'path';
import { writeSyntheticPerps } from '../research/syntheticPerps';
import { buildPerpDataset, trainPerp } from '../research/trainPerpModel';
import { runPerpBacktest } from '../research/perpBacktest';
import { tmpDir } from './helpers';

test('research pipeline: a random walk never validates; a planted momentum signal is found and trades profitably', async () => {
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) });
  const run = async (momentum: number) => {
    const dir = path.join(tmpDir(), 'rec');
    writeSyntheticPerps(dir, { days: 6, momentum, seed: 11, stepSec: 60 });
    const rows = await buildPerpDataset(dir, { everySec: 300, horizonMin: 240 });
    const res = trainPerp(rows, { horizonMin: 240, everySec: 300, minEff: 20 });
    const bt = await runPerpBacktest(dir, { ...cfg.perps, paperBalanceUsd: 1000 }, new PerpModel(res.params), { minDays: 3 });
    return { v: res.params.validation!, bt, rows: rows.length };
  };
  const nul = await run(0);
  assert.ok(nul.rows > 500);
  assert.equal(nul.v.passed, false, JSON.stringify(nul.v));
  assert.equal(nul.bt.ok, false);
  const sig = await run(10);
  assert.ok(sig.v.ic > 0.3 && sig.v.icCiLo > 0, JSON.stringify(sig.v));
  assert.ok(sig.bt.trades > 0 && sig.bt.pnlUsd > 0, JSON.stringify({ ...sig.bt, dailyPnl: undefined }));
  assert.ok(sig.bt.fees > 0);
});

test('capital locked in binaries inflates the perp sigma: smaller Kelly size, never larger', () => {
  const free = decidePerp(base({ muBps: 16 }), P), locked = decidePerp(base({ muBps: 16, lockedFrac: 0.6 }), P);
  assert.ok(Math.abs(locked.target) <= Math.abs(free.target));
  assert.ok((locked.leverage ?? 0) < (free.leverage ?? 0) || Math.abs(locked.target) < Math.abs(free.target), `${free.target} -> ${locked.target}`);
});

import assert from 'node:assert/strict';
import path from 'path';
import { test } from 'node:test';
import { DEFAULT_FEES } from '../bot/fees';
import type { RiskLimits } from '../bot/config';
import type { OrderIntent } from '../bot/oms/oms';
import { marketWorstLoss } from '../bot/risk/exposure';
import { KillSwitch } from '../bot/risk/killSwitch';
import { RiskContext, RiskGateway } from '../bot/risk/riskGateway';
import { tmpAudit, tmpDir } from './helpers';

const limits: RiskLimits = {
  maxContractsPerOrder: 10, maxOrderRiskFrac: 0.02, maxWindowRiskFrac: 0.03, maxTotalRiskFrac: 0.1,
  dailyLossLimitFrac: 0.05, dailyLossLimitUsd: 50, minSidePrice: 0.1, maxOrdersPerMinute: 30, maxOpenOrders: 10,
  maxBookAgeMs: 5000, maxIndexAgeMs: 3000, noEntryBeforeCloseSec: 15, maxConsecutiveOrderErrors: 5,
};

const intent = (o: Partial<OrderIntent> = {}): OrderIntent => ({
  ticker: 'T', asset: 'BTC', windowCloseTs: 1_000_000, side: 'bid', price: 0.45, count: 4,
  timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote',
  fairValue: 0.5, modelId: 'm', decisionId: 'd', ...o,
});

const ctx = (o: Partial<RiskContext> = {}): RiskContext => ({
  now: 0, mode: 'paper', killEngaged: false, haltReasons: [], bankroll: 200, dailyPnl: 0,
  bookUsable: true, bestBid: 0.44, bestAsk: 0.47, indexFresh: true, marketCloseTs: 600_000, tickSize: 0.01,
  fees: DEFAULT_FEES, position: 0, marketRiskNow: 0, marketRiskWith: 1.8, windowRisk: 0, totalRisk: 0,
  ordersLastMinute: 0, openOrders: 0, modelLiveBlockers: [], ...o,
});

const gw = new RiskGateway(limits);

test('accepts a sane, positive-edge maker order', () => {
  const d = gw.check(intent(), ctx());
  assert.deepEqual(d.reasons, []);
  assert.equal(d.ok, true);
});

test('fails closed on unknown bankroll, stale data, halts and kill switch', () => {
  assert.equal(gw.check(intent(), ctx({ bankroll: undefined })).ok, false);
  assert.equal(gw.check(intent(), ctx({ bookUsable: false })).ok, false);
  assert.equal(gw.check(intent(), ctx({ indexFresh: false })).ok, false);
  assert.equal(gw.check(intent(), ctx({ haltReasons: ['recon'] })).ok, false);
  assert.equal(gw.check(intent(), ctx({ killEngaged: true })).ok, false);
  assert.equal(gw.check(intent(), ctx({ bestBid: undefined })).ok, false);
});

test('rejects orders with no fee-net edge (price collar vs fair value)', () => {
  const d = gw.check(intent({ price: 0.5, fairValue: 0.5 }), ctx({ bestAsk: 0.52 }));
  assert.equal(d.ok, false);
  assert.ok(d.reasons.some((r) => r.includes('no fee-net edge')));
  // Taker at 0.47 with fv 0.48: 1c edge < 2c taker fee on 1 contract.
  assert.equal(gw.check(intent({ price: 0.47, count: 1, postOnly: false, timeInForce: 'immediate_or_cancel', fairValue: 0.48 }), ctx()).ok, false);
});

test('rejects longshots, bad ticks, oversize, and near-close entries', () => {
  assert.equal(gw.check(intent({ price: 0.05, fairValue: 0.2 }), ctx({ bestBid: 0.04, bestAsk: 0.07 })).ok, false);
  assert.equal(gw.check(intent({ price: 0.455 }), ctx()).ok, false);
  assert.equal(gw.check(intent({ count: 11 }), ctx()).ok, false);
  assert.equal(gw.check(intent(), ctx({ now: 590_000 })).ok, false);
  assert.equal(gw.check(intent({ price: 0.47 }), ctx()).ok, false); // post-only would cross
});

test('capital thresholds: per-order, per-window, total', () => {
  assert.equal(gw.check(intent({ count: 10 }), ctx({ marketRiskWith: 4.5 })).ok, false); // $4.50 > 2% of $200
  assert.equal(gw.check(intent(), ctx({ windowRisk: 5 })).ok, false); // 5 + 1.8 > $6
  assert.equal(gw.check(intent(), ctx({ totalRisk: 19 })).ok, false);
});

test('daily loss limit rejects and asks to trip the kill switch', () => {
  const d = gw.check(intent(), ctx({ dailyPnl: -10 }));
  assert.equal(d.ok, false);
  assert.ok(d.tripKill);
});

test('reduce-only exits are allowed during a halt but must reduce', () => {
  const exit = intent({ side: 'ask', price: 0.44, count: 2, reduceOnly: true, postOnly: false, timeInForce: 'immediate_or_cancel', purpose: 'exit' });
  assert.equal(gw.check(exit, ctx({ position: 3, haltReasons: ['recon'] })).ok, true);
  assert.equal(gw.check(exit, ctx({ position: -3 })).ok, false);
  assert.equal(gw.check({ ...exit, count: 5 }, ctx({ position: 3 })).ok, false);
  assert.equal(gw.check({ ...exit, timeInForce: 'good_till_canceled' }, ctx({ position: 3 })).ok, false);
});

test('live mode refuses an unvalidated model', () => {
  assert.equal(gw.check(intent(), ctx({ mode: 'live', modelLiveBlockers: ['no validation'] })).ok, false);
});

test('an exception inside a check rejects (fail closed)', () => {
  const bad = new Proxy(ctx(), { get: (t, k) => { if (k === 'fees') throw new Error('boom'); return (t as any)[k]; } });
  const d = gw.check(intent(), bad);
  assert.equal(d.ok, false);
});

test('worst-case exposure includes resting orders at the corners', () => {
  // Long 5 YES bought at 0.40 (cash -2): worst case NO -> -2.
  const pos = { yes: 5, netCash: -2, fees: 0 };
  assert.ok(Math.abs(marketWorstLoss(pos, [], DEFAULT_FEES) - 2) < 1e-9);
  // Plus a resting bid for 5 @ 0.45: if it fills and NO wins, lose another 2.25.
  const withBid = marketWorstLoss(pos, [{ ticker: 'T', side: 'bid', price: 0.45, remaining: 5, isTaker: false }], DEFAULT_FEES);
  assert.ok(Math.abs(withBid - 4.25) < 1e-9);
  // A resting ask (sell YES @ 0.6) reduces the NO-case loss; worst case unchanged at 2.
  const withAsk = marketWorstLoss(pos, [{ ticker: 'T', side: 'ask', price: 0.6, remaining: 5, isTaker: false }], DEFAULT_FEES);
  assert.ok(Math.abs(withAsk - 2) < 1e-9);
});

test('kill switch persists across restarts and cancels orders on engage', async () => {
  const file = path.join(tmpDir(), 'kill.json');
  const audit = tmpAudit();
  let cancelled = 0;
  const k = new KillSwitch(file, audit);
  k.bindCancelAll(async () => { cancelled++; });
  await k.engage('test', 'unit');
  assert.equal(cancelled, 1);
  const k2 = new KillSwitch(file, audit);
  assert.equal(k2.engaged, true);
  k2.reset('tester');
  assert.equal(new KillSwitch(file, audit).engaged, false);
});

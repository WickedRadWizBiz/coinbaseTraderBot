import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StrategyConfig } from '../bot/config';
import { DEFAULT_FEES } from '../bot/fees';
import { decide, MarketView } from '../bot/strategy/fairValueStrategy';

const cfg: StrategyConfig = {
  style: 'maker', series: ['KXBTC15M'], kellyFraction: 0.25, minEdge: 0.02, takerBuffer: 0.01,
  inventorySkewPerContract: 0.002, requoteThreshold: 0.01, fastMoveSigmas: 3, fastMoveWindowSec: 5, orderTtlSec: 60,
  exitPolicy: 'fair_value', huntTargetMargin: 0.02, huntMinConfluence: 2, ratchetMinFillRatio: 1, ratchetMinWallAgeSec: 3, ratchetSlippageTicks: 1,
};

const view = (o: Partial<MarketView> = {}): MarketView => ({
  ticker: 'T', pYes: 0.55, bestBid: { price: 0.5, size: 20 }, bestAsk: { price: 0.6, size: 20 }, position: 0,
  bankroll: 200, maxOrderRiskUsd: 4, maxContracts: 10, minSidePrice: 0.1, tauSec: 400, noEntryBeforeCloseSec: 15,
  fastMove: false, tickSize: 0.01, fees: DEFAULT_FEES, nowSec: 1000, closeSec: 1400, ...o,
});

test('maker quotes are post-only, GTC with exchange expiry, and priced inside fair value', () => {
  const out = decide(view(), cfg);
  const bid = out.place.find((p) => p.side === 'bid')!;
  const ask = out.place.find((p) => p.side === 'ask')!;
  assert.ok(bid.postOnly && ask.postOnly);
  assert.equal(bid.timeInForce, 'good_till_canceled');
  assert.ok(bid.expirationTime! <= 1060 && bid.expirationTime! < 1400);
  assert.ok(bid.price <= 0.55 - 0.02 + 1e-9 && bid.price < 0.6);
  assert.ok(ask.price >= 0.55 + 0.02 - 1e-9 && ask.price > 0.5);
});

test('quotes are pulled on fast moves and near close', () => {
  assert.equal(decide(view({ fastMove: true }), cfg).place.length, 0);
  assert.equal(decide(view({ tauSec: 10 }), cfg).place.length, 0);
});

test('existing resting quotes are cancelled when no longer wanted, kept when unchanged', () => {
  const out = decide(view({ fastMove: true, restingBid: { clientOrderId: 'b', price: 0.53, remaining: 5 } }), cfg);
  assert.deepEqual(out.cancel.map((c) => c.clientOrderId), ['b']);
  const first = decide(view(), cfg).place.find((p) => p.side === 'bid')!;
  const again = decide(view({ restingBid: { clientOrderId: 'b', price: first.price, remaining: first.count } }), cfg);
  assert.equal(again.cancel.length, 0);
  assert.equal(again.place.filter((p) => p.side === 'bid').length, 0);
});

test('no longshot quotes: never bid a side below the minimum side price', () => {
  const out = decide(view({ pYes: 0.08, bestBid: { price: 0.05, size: 10 }, bestAsk: { price: 0.09, size: 10 } }), cfg);
  assert.equal(out.place.filter((p) => p.side === 'bid').length, 0);
});

test('taker only crosses when fair value beats the touch by fee + buffer', () => {
  const tcfg = { ...cfg, style: 'taker' as const };
  assert.equal(decide(view({ pYes: 0.62 }), tcfg).place.length, 0); // 2c edge - 2c fee < buffer
  const out = decide(view({ pYes: 0.7 }), tcfg);
  const take = out.place.find((p) => p.purpose === 'entry')!;
  assert.equal(take.side, 'bid');
  assert.equal(take.timeInForce, 'immediate_or_cancel');
  assert.equal(take.price, 0.6);
});

test('exit only when the bid pays more than fair value plus exit fee; no percentage stops', () => {
  const hold = decide(view({ position: 5, pYes: 0.3, bestBid: { price: 0.25, size: 10 } }), cfg);
  assert.equal(hold.place.filter((p) => p.purpose === 'exit').length, 0, 'losing position is held, not stopped out');
  const exit = decide(view({ position: 5, pYes: 0.4, bestBid: { price: 0.5, size: 10 } }), cfg).place.find((p) => p.purpose === 'exit')!;
  assert.equal(exit.side, 'ask');
  assert.equal(exit.reduceOnly, true);
  assert.equal(exit.timeInForce, 'immediate_or_cancel');
  assert.equal(exit.count, 5);
});

test('blockReductions (hunt mode) removes the fair-value exit, the opposite quote and opposite takes', () => {
  const long = view({ position: 5, pYes: 0.4, bestBid: { price: 0.5, size: 10 } });
  const normal = decide(long, { ...cfg, style: 'both' });
  assert.ok(normal.place.some((p) => p.purpose === 'exit'));
  const hunting = decide(long, { ...cfg, style: 'both' }, { exits: false, blockReductions: true });
  assert.equal(hunting.place.filter((p) => p.side === 'ask').length, 0, 'nothing sells YES while hunting a long YES');
  // A resting ask (which would unwind the winner) is cancelled.
  const withAsk = decide({ ...long, restingAsk: { clientOrderId: 'a', price: 0.62, remaining: 5 } }, cfg, { exits: false, blockReductions: true });
  assert.deepEqual(withAsk.cancel.map((c) => c.clientOrderId), ['a']);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, type StrategyConfig } from '../bot/config';
import { DEFAULT_FEES } from '../bot/fees';
import { decide, MarketView } from '../bot/strategy/fairValueStrategy';

// Continuous cadence + Kelly sizing (the pre-relaxed behaviour these tests pin down).
const base = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), STRATEGY_CADENCE: 'continuous' }).strategy;
const cfg: StrategyConfig = {
  ...base,
  style: 'maker', series: ['KXBTC15M'], kellyFraction: 0.25, minEdge: 0.02, takerBuffer: 0.01,
  inventorySkewPerContract: 0.002, requoteThreshold: 0.01, fastMoveSigmas: 3, fastMoveWindowSec: 5, orderTtlSec: 60,
  exitPolicy: 'fair_value', huntTargetMargin: 0.02, huntMinConfluence: 2, ratchetMinFillRatio: 1, ratchetMinWallAgeSec: 3, ratchetSlippageTicks: 1,
  sessionRisk: {}, huntSessionGuard: true, huntTransitionBufferMin: 10, volSeasonality: false, volProfilePath: 'params/vol_profile.json',
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

test('profit target: a winner is sold at the bid once that banks the target net of both fees, even though the model values it higher', () => {
  const pt = { ...cfg, profitTarget: 0.02, profitTargetPct: 0 };
  // Bought 10 YES at 0.40 as a maker (no fee); the model now says 0.70, so the fair-value exit would hold.
  const long = (bid: number) => view({ position: 10, pYes: 0.7, entrySidePrice: 0.4, entryFeePerContract: 0, bestBid: { price: bid, size: 50 }, bestAsk: { price: bid + 0.02, size: 50 } });
  // 0.43: +3c gross, minus the taker fee (18c on the order, rounded up to the cent) = +1.2c net: under the target.
  assert.equal(decide(long(0.43), pt).place.filter((p) => p.purpose === 'exit').length, 0);
  // 0.44: +4c - 1.8c = +2.2c net.
  const exit = decide(long(0.44), pt).place.find((p) => p.purpose === 'exit')!;
  assert.deepEqual([exit.side, exit.price, exit.count, exit.reduceOnly, exit.timeInForce], ['ask', 0.44, 10, true, 'immediate_or_cancel']);
  assert.match(exit.why, /^profit target: \+0\.02\d a contract net of fees >= 0\.020/);
  // Fees already paid on the entry count against the gain.
  assert.equal(decide({ ...long(0.44), entryFeePerContract: 0.01 }, pt).place.filter((p) => p.purpose === 'exit').length, 0);
  // Off: the model's exit alone, which holds a contract it values at 0.70.
  assert.equal(decide(long(0.5), { ...pt, profitTarget: 0 }).place.filter((p) => p.purpose === 'exit').length, 0);
  // A percentage target, when larger: 10% of 0.40 = 4c net.
  assert.equal(decide(long(0.44), { ...pt, profitTargetPct: 0.1 }).place.filter((p) => p.purpose === 'exit').length, 0);
  assert.equal(decide(long(0.46), { ...pt, profitTargetPct: 0.1 }).place.filter((p) => p.purpose === 'exit').length, 1);
});

test('profit target on a NO position: bought back at the ask, priced on the NO side', () => {
  const pt = { ...cfg, profitTarget: 0.02, profitTargetPct: 0 };
  // Holding 10 NO bought at 0.40 (YES sold at 0.60); the model wants to keep it (P(YES) 0.30).
  const short = (yesAsk: number) => view({ position: -10, pYes: 0.3, entrySidePrice: 0.4, entryFeePerContract: 0, bestBid: { price: yesAsk - 0.02, size: 50 }, bestAsk: { price: yesAsk, size: 50 } });
  assert.equal(decide(short(0.57), pt).place.filter((p) => p.purpose === 'exit').length, 0, 'NO bid 0.43: +1.2c net');
  const exit = decide(short(0.56), pt).place.find((p) => p.purpose === 'exit')!;
  assert.deepEqual([exit.side, exit.price, exit.count, exit.reduceOnly], ['bid', 0.56, 10, true]);
  assert.match(exit.why, /^profit target: NO \+0\.02/);
});

test('profit target: no exits in the final minute or while hunting (the hunt\'s trailing stop has it)', () => {
  const pt = { ...cfg, profitTarget: 0.02, profitTargetPct: 0 };
  const long = view({ position: 10, pYes: 0.7, entrySidePrice: 0.4, entryFeePerContract: 0, bestBid: { price: 0.5, size: 50 }, bestAsk: { price: 0.52, size: 50 } });
  assert.equal(decide({ ...long, exitWindowOpen: false }, pt).place.filter((p) => p.purpose === 'exit').length, 0);
  assert.equal(decide(long, pt, { exits: false, blockReductions: true }).place.filter((p) => p.purpose === 'exit').length, 0);
});

test('profit target default: at least 10% of what a contract cost (price plus the entry fee), and at least 2c', () => {
  assert.equal(cfg.profitTargetPct, 0.1);
  assert.equal(cfg.profitTarget, 0.02);
  // Bought at 0.40 with a 1c fee: cost 0.41, so the target is 4.1c net.
  const long = (bid: number) => view({ position: 10, pYes: 0.7, entrySidePrice: 0.4, entryFeePerContract: 0.01, bestBid: { price: bid, size: 50 }, bestAsk: { price: bid + 0.02, size: 50 } });
  assert.equal(decide(long(0.46), cfg).place.filter((p) => p.purpose === 'exit').length, 0, '+6c - 1c - 1.8c = +3.2c');
  const exit = decide(long(0.47), cfg).place.find((p) => p.purpose === 'exit')!;
  assert.match(exit.why, /^profit target: \+0\.042 a contract net of fees >= 0\.041/);
  // A cheap contract: 10% of 0.12 is 1.2c, so the 2c floor applies.
  const cheap = (bid: number) => view({ position: 10, pYes: 0.3, entrySidePrice: 0.12, entryFeePerContract: 0, bestBid: { price: bid, size: 50 }, bestAsk: { price: bid + 0.02, size: 50 } });
  assert.equal(decide(cheap(0.14), cfg).place.filter((p) => p.purpose === 'exit').length, 0, '+2c - 0.9c fee < 2c');
  assert.match(decide(cheap(0.15), cfg).place.find((p) => p.purpose === 'exit')!.why, />= 0\.020/);
});

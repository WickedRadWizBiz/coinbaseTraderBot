import assert from 'node:assert/strict';
import path from 'path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { DEFAULT_FEES } from '../bot/fees';
import { OrderBook } from '../bot/marketdata/orderBook';
import { MetaModel } from '../bot/model/metaModel';
import { exitLevels, LiquidityRatchet } from '../bot/strategy/exitPolicies';
import { runBacktest } from '../research/backtest';
import { writeSyntheticRecordings } from '../research/synthetic';
import { tmpDir } from './helpers';

const P = { minFillRatio: 1, minWallAgeMs: 3000, slippageTicks: 1 };

function book(bids: Array<[number, number]>, asks: Array<[number, number]>, ts = 0): OrderBook {
  const b = new OrderBook('T');
  b.applySnapshot({ bids: bids.map(([price, size]) => ({ price, size })), asks: asks.map(([price, size]) => ({ price, size })) }, ts);
  return b;
}
const run = (r: LiquidityRatchet, position: number, b: OrderBook, now: number, extra = {}) =>
  r.evaluate({ position, book: b, now, tick: 0.01, fees: DEFAULT_FEES, ...extra });

test('exit levels are in side terms: YES bids for long YES, 1 - asks for long NO', () => {
  const b = book([[0.55, 10], [0.54, 3]], [[0.58, 7], [0.6, 20]]);
  assert.deepEqual(exitLevels(b, 1).map((l) => l.price), [0.55, 0.54]);
  assert.deepEqual(exitLevels(b, -1).map((l) => l.price), [0.42, 0.4]);
});

test('walls must absorb the whole position and persist before becoming the stop', () => {
  const r = new LiquidityRatchet(P);
  // Position 5; 0.53 has 20 (wall), 0.54 has 3 (too thin).
  const b = book([[0.56, 8], [0.54, 3], [0.53, 20]], [[0.6, 10]]);
  assert.equal(run(r, 5, b, 0).stop, undefined, 'not aged yet');
  assert.equal(run(r, 5, b, 2000).stop, undefined);
  const out = run(r, 5, b, 3000);
  assert.equal(out.event, 'armed');
  assert.equal(out.stop, 0.53);
});

test('stop ratchets up only as price moves past higher walls, never down', () => {
  const r = new LiquidityRatchet(P);
  let b = book([[0.56, 8], [0.53, 20]], [[0.6, 10]]);
  run(r, 5, b, 0); run(r, 5, b, 3000);
  assert.equal(r.stop, 0.53);
  // Price rallies; a new wall at 0.58 appears below the new best bid 0.61.
  b = book([[0.61, 6], [0.58, 30], [0.53, 20]], [[0.64, 10]]);
  run(r, 5, b, 4000);
  assert.equal(r.stop, 0.53, 'new wall not aged');
  const out = run(r, 5, b, 7000);
  assert.equal(out.event, 'ratcheted');
  assert.equal(r.stop, 0.58);
  // Price dips but stays above the stop: stop does not move down.
  b = book([[0.59, 6], [0.58, 30], [0.53, 20]], [[0.63, 10]]);
  run(r, 5, b, 8000);
  assert.equal(r.stop, 0.58);
});

test('price coming back down to the stop triggers an IOC reduce-only exit limited to stop - slippage', () => {
  const r = new LiquidityRatchet(P);
  let b = book([[0.61, 6], [0.58, 30]], [[0.64, 10]]);
  run(r, 5, b, 0); run(r, 5, b, 3000);
  b = book([[0.58, 30], [0.55, 10]], [[0.62, 10]]);
  const out = run(r, 5, b, 4000);
  assert.equal(out.event, 'triggered');
  assert.deepEqual(out.plan, { side: 'ask', price: 0.57, count: 5, stop: 0.58 });
});

test('long NO: stop and exit order are mirrored onto the YES book', () => {
  const r = new LiquidityRatchet(P);
  // NO bids = 1 - YES asks: 0.40 (from 0.60 ask, size 30) is a wall below best NO bid 0.43.
  let b = book([[0.5, 10]], [[0.57, 6], [0.6, 30]]);
  run(r, -5, b, 0); run(r, -5, b, 3000);
  assert.equal(r.stop, 0.4);
  b = book([[0.5, 10]], [[0.6, 30]]); // best NO bid falls to the stop
  const out = run(r, -5, b, 4000);
  assert.equal(out.plan?.side, 'bid');
  assert.equal(out.plan?.price, 0.61); // buy YES up to 1 - (0.40 - 0.01)
});

test('gap through the stop cannot fill; stop falls back to the next wall down', () => {
  const r = new LiquidityRatchet(P);
  let b = book([[0.61, 6], [0.58, 30], [0.5, 40]], [[0.64, 10]]);
  run(r, 5, b, 0); run(r, 5, b, 3000);
  assert.equal(r.stop, 0.58);
  b = book([[0.55, 6], [0.5, 40]], [[0.6, 10]], 4000);
  const out = run(r, 5, b, 4000);
  assert.equal(out.event, 'gapped');
  assert.equal(r.stop, 0.5);
});

test('hybrid holds a triggered stop when the model still values the position above it', () => {
  const r = new LiquidityRatchet(P);
  let b = book([[0.61, 6], [0.58, 30]], [[0.64, 10]]);
  run(r, 5, b, 0, { hybrid: true, qSide: 0.7 }); run(r, 5, b, 3000, { hybrid: true, qSide: 0.7 });
  b = book([[0.58, 30]], [[0.62, 10]]);
  assert.equal(run(r, 5, b, 4000, { hybrid: true, qSide: 0.7 }).event, 'hybrid_hold');
  assert.equal(run(r, 5, b, 5000, { hybrid: true, qSide: 0.5 }).event, 'triggered');
});

test('flat position resets the ratchet', () => {
  const r = new LiquidityRatchet(P);
  const b = book([[0.56, 8], [0.53, 20]], [[0.6, 10]]);
  run(r, 5, b, 0); run(r, 5, b, 3000);
  run(r, 0, b, 4000);
  assert.equal(r.stop, undefined);
});

test('backtester compares all exit policies on identical data', async () => {
  const dir = path.join(tmpDir(), 'rec');
  writeSyntheticRecordings(dir, { windows: 8, seed: 9, marketNoise: 0.05 });
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), STRATEGY_STYLE: 'both' });
  const out: Record<string, Awaited<ReturnType<typeof runBacktest>>> = {};
  for (const exitPolicy of ['hold', 'fair_value', 'liquidity_ratchet', 'hybrid'] as const) {
    out[exitPolicy] = await runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 200, { exitPolicy });
  }
  assert.equal(out.hold.exits.orders, 0, 'hold never exits early');
  assert.equal(out.hold.exits.ratchetTriggers, 0);
  assert.ok(out.liquidity_ratchet.exits.ratchetTriggers > 0, 'ratchet fires on synthetic data');
  assert.ok(out.liquidity_ratchet.exits.orders > 0);
  for (const r of Object.values(out)) {
    assert.ok(Number.isFinite(r.pnl) && Number.isFinite(r.exits.regret));
    // Exited contracts are accounted for: regret is settlement value minus proceeds.
    if (r.exits.fills === 0) assert.equal(r.exits.regret, 0);
  }
});

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
  // Continuous cadence + Kelly: an exit-policy comparison with plenty of trades.
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), STRATEGY_STYLE: 'both', STRATEGY_CADENCE: 'continuous' });
  const out: Record<string, Awaited<ReturnType<typeof runBacktest>>> = {};
  for (const exitPolicy of ['hold', 'fair_value', 'take_profit', 'liquidity_ratchet', 'hybrid', 'confluence_ratchet'] as const) {
    out[exitPolicy] = await runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 200, { exitPolicy });
  }
  assert.equal(out.hold.exits.orders, 0, 'hold never exits early');
  assert.equal(out.hold.exits.ratchetTriggers, 0);
  assert.ok(out.liquidity_ratchet.exits.ratchetTriggers > 0, 'ratchet fires on synthetic data');
  assert.ok(out.liquidity_ratchet.exits.orders > 0);
  // Identity model + no dominance data: confluence rarely reaches the threshold, so the
  // confluence ratchet mostly behaves like fair_value, and never hunts without activation.
  if (out.confluence_ratchet.exits.huntActivations === 0) assert.equal(out.confluence_ratchet.exits.ratchetTriggers, 0);
  for (const r of Object.values(out)) {
    assert.ok(Number.isFinite(r.pnl) && Number.isFinite(r.exits.regret));
    // Exited contracts are accounted for: regret is settlement value minus proceeds.
    if (r.exits.fills === 0) assert.equal(r.exits.regret, 0);
  }
});

import { ConfluenceRatchetExit } from '../bot/strategy/exitPolicies';

const H = { targetMargin: 0.02, minConfluence: 2 };
const hunt = (h: ConfluenceRatchetExit, o: { position?: number; qSide?: number; sideBid?: number; confluence?: number; b: OrderBook; now: number }) =>
  h.update({ position: o.position ?? 5, qSide: o.qSide ?? 0.55, sideBid: o.sideBid, confluence: o.confluence ?? 0, book: o.b, now: o.now, tick: 0.01, fees: DEFAULT_FEES });

test('confluence ratchet stays in fair-value mode until outperformance AND confluence', () => {
  const h = new ConfluenceRatchetExit(H, P);
  const b = book([[0.6, 8], [0.57, 30]], [[0.63, 10]]);
  assert.equal(hunt(h, { qSide: 0.55, sideBid: 0.5, confluence: 4, b, now: 0 }).mode, 'fair_value'); // entry fv 0.55 recorded
  assert.equal(hunt(h, { sideBid: 0.6, confluence: 1, b, now: 1000 }).mode, 'fair_value', 'outperformed but weak confluence');
  assert.equal(hunt(h, { sideBid: 0.56, confluence: 5, b, now: 2000 }).mode, 'fair_value', 'confluence but not past target 0.57');
  const d = hunt(h, { sideBid: 0.6, confluence: 3, b, now: 3000 });
  assert.equal(d.mode, 'hunt');
  assert.equal(d.event, 'activated');
  assert.ok(Math.abs(d.target! - 0.57) < 1e-12);
});

test('in hunt mode the liquidity ratchet manages the exit', () => {
  const h = new ConfluenceRatchetExit(H, P);
  let b = book([[0.62, 6], [0.59, 30]], [[0.65, 10]]);
  hunt(h, { qSide: 0.55, sideBid: 0.5, b, now: 0 });
  hunt(h, { sideBid: 0.62, confluence: 3, b, now: 1000 });         // activate; wall at 0.59 starts aging
  const armed = hunt(h, { sideBid: 0.62, confluence: 3, b, now: 4500 });
  assert.equal(armed.stop, 0.59);
  b = book([[0.58, 30]], [[0.63, 10]]);                               // the surge reverses below the wall
  const out = hunt(h, { sideBid: 0.58, confluence: 3, b, now: 5500 });
  assert.equal(out.mode, 'hunt');
  assert.equal(out.plan?.side, 'ask');
  assert.equal(out.plan?.price, 0.58);
});

test('hunt mode locks the target at activation; takes profit on a confluence flip; exits on reversal; ends on a deep gap', () => {
  const b = book([[0.6, 8]], [[0.63, 10]]); // no wall below the bid: the stop stays at the lock
  const h = new ConfluenceRatchetExit(H, P);
  hunt(h, { qSide: 0.55, sideBid: 0.5, b, now: 0 });
  const on = hunt(h, { sideBid: 0.6, confluence: 3, b, now: 1000 });
  assert.deepEqual([on.mode, on.event, on.stop], ['hunt', 'activated', 0.57], 'stop starts at the target (entry fv 0.55 + 0.02)');
  const flip = hunt(h, { sideBid: 0.6, confluence: -2, b, now: 2000 });
  assert.deepEqual([flip.mode, flip.event, flip.plan?.side, flip.plan?.price], ['hunt', 'profit_take_confluence', 'ask', 0.6]);

  const g = new ConfluenceRatchetExit(H, P);
  hunt(g, { qSide: 0.55, sideBid: 0.5, b, now: 0 });
  hunt(g, { sideBid: 0.6, confluence: 3, b, now: 1000 });
  const rev = hunt(g, { sideBid: 0.56, confluence: 3, b: book([[0.56, 8]], [[0.6, 10]]), now: 2000 });
  assert.deepEqual([rev.event, rev.plan?.price], ['triggered', 0.56], 'reversal below the lock exits at the lock minus one tick');

  const k = new ConfluenceRatchetExit(H, P);
  hunt(k, { qSide: 0.55, sideBid: 0.5, b, now: 0 });
  hunt(k, { sideBid: 0.6, confluence: 3, b, now: 1000 });
  const deep = hunt(k, { sideBid: 0.5, confluence: 3, b: book([[0.5, 8]], [[0.53, 10]]), now: 2000 });
  assert.deepEqual([deep.mode, deep.event], ['fair_value', 'deactivated_giveback'], 'gapped below the entry fair value: fair-value exit takes over');
});

test('confluence is oriented to the position: long NO hunts on bearish confluence', () => {
  const h = new ConfluenceRatchetExit(H, P);
  const b = book([[0.35, 10]], [[0.38, 8], [0.41, 30]]);
  hunt(h, { position: -5, qSide: 0.55, sideBid: 0.5, b, now: 0 });
  assert.equal(hunt(h, { position: -5, sideBid: 0.62, confluence: 3, b, now: 1000 }).mode, 'fair_value', 'bullish confluence does not help a NO');
  assert.equal(hunt(h, { position: -5, sideBid: 0.62, confluence: -3, b, now: 2000 }).mode, 'hunt');
});

import { evaluateHunt, type BacktestResult } from '../research/backtest';

test('hunt mode is evaluated against the fair-value exit on identical windows; only a clear win enables it', () => {
  const mkRes = (policy: 'fair_value' | 'confluence_ratchet', perWindow: (i: number) => number, margin = 0.02): BacktestResult => {
    const windows = new Map<number, { pnl: number; contracts: number; fees: number }>();
    let pnl = 0;
    for (let i = 0; i < 400; i++) { const p = perWindow(i); windows.set(i * 900_000, { pnl: p, contracts: 5, fees: 0 }); pnl += p; }
    return {
      exitPolicy: policy, label: policy, huntParams: policy === 'confluence_ratchet' ? { hunt: { targetMargin: margin, minConfluence: 2 }, ratchet: { minFillRatio: 1, minWallAgeMs: 3000, slippageTicks: 1 } } : undefined,
      vaultEnd: 0, pocketEnd: 0, bySession: {}, trades: [], takeProfitFills: 0, entryEvaluations: 0, days: 4, minEdge: 0.03, windows, fills: 0, contracts: 0, fees: 0, pnl,
      exits: { orders: 0, fills: 0, contracts: 0, proceeds: 0, regret: 0, stoppedWinners: 0, ratchetTriggers: 0, gaps: 0, hybridHolds: 0, huntActivations: 10, huntDeactivations: 0, huntProfitTakes: 3, lockSales: 0, lockHolds: 0, wallAsks: 0, wallFills: 0, avgSlippage: null },
    };
  };
  const base = mkRes('fair_value', (i) => ((i * 37) % 11) / 10 - 0.5);
  const all = [...base.windows.keys()];
  const better = mkRes('confluence_ratchet', (i) => ((i * 37) % 11) / 10 - 0.5 + 0.08 + ((i * 13) % 5) / 100, 0.04);
  const worse = mkRes('confluence_ratchet', (i) => ((i * 37) % 11) / 10 - 0.5 - 0.02, 0.01);
  const good = evaluateHunt([base, better, worse], all, 0.03)!;
  assert.equal(good.huntOk, true);
  assert.equal(good.hunt.targetMargin, 0.04, 'the winning variant is recorded');
  assert.equal(good.variants, 2);
  const bad = evaluateHunt([base, worse], all, 0.03)!;
  assert.equal(bad.huntOk, false);
  assert.equal(evaluateHunt([base], all, 0.03), undefined);
});


test('validated hunt parameters come from the model file only when hunt mode won', () => {
  const v = { passed: false, nWindows: 0, brierModel: 0, brierMarket: 0, maxCalibrationErrorPp: 0, evaluatedAt: 'x' };
  const hunt = { targetMargin: 0.04, minConfluence: 2, minFillRatio: 2, minWallAgeMs: 3000, slippageTicks: 1 };
  const ok = MetaModel.fromJson(JSON.stringify({ version: 'i', kind: 'identity', features: [], referenceSigma: 1e-4, validation: { ...v, exitEvaluation: { huntOk: true, windows: 400, pairedDiffMean: 0.1, pairedDiffCiLo: 0.05, dsrProbability: 0.99, hunt } } }));
  assert.deepEqual(ok.validatedHunt(), hunt);
  const no = MetaModel.fromJson(JSON.stringify({ version: 'i', kind: 'identity', features: [], referenceSigma: 1e-4, validation: { ...v, exitEvaluation: { huntOk: false, windows: 400, pairedDiffMean: -0.1, pairedDiffCiLo: -0.2, dsrProbability: 0.1, hunt } } }));
  assert.equal(no.validatedHunt(), undefined);
  assert.equal(MetaModel.identity().validatedHunt(), undefined);
});

test('hunt mode with the hybrid rule holds a triggered stop while the model values the contract above it', () => {
  const b = book([[0.6, 8]], [[0.63, 10]]);
  const dip = book([[0.56, 8]], [[0.6, 10]]);
  const h = new ConfluenceRatchetExit({ ...H, hybrid: true }, P);
  hunt(h, { qSide: 0.55, sideBid: 0.5, b, now: 0 });
  hunt(h, { sideBid: 0.6, confluence: 3, b, now: 1000 }); // stop at the lock, 0.57
  const held = hunt(h, { qSide: 0.6, sideBid: 0.56, confluence: 3, b: dip, now: 2000 });
  assert.deepEqual([held.mode, held.event, held.plan, held.stop], ['hunt', 'hybrid_hold', undefined, 0.57], 'the model says 0.60: the stop holds');
  const sold = hunt(h, { qSide: 0.5, sideBid: 0.56, confluence: 3, b: dip, now: 3000 });
  assert.deepEqual([sold.event, sold.plan?.price], ['triggered', 0.56], 'the model says 0.50: the stop sells');
  const off = new ConfluenceRatchetExit(H, P);
  hunt(off, { qSide: 0.55, sideBid: 0.5, b, now: 0 });
  hunt(off, { sideBid: 0.6, confluence: 3, b, now: 1000 });
  assert.equal(hunt(off, { qSide: 0.6, sideBid: 0.56, confluence: 3, b: dip, now: 2000 }).event, 'triggered', 'without the rule the stop sells whatever the model says');
});

test('hunt mode without the gap sale holds through a gap: the stop waits at the lock for the bid to come back', () => {
  const b = book([[0.6, 8]], [[0.63, 10]]); // no wall below the bid: the stop stays at the lock
  const k = new ConfluenceRatchetExit({ ...H, sellIntoGap: false }, P);
  hunt(k, { qSide: 0.55, sideBid: 0.5, b, now: 0 });
  hunt(k, { sideBid: 0.6, confluence: 3, b, now: 1000 });
  const gap = hunt(k, { sideBid: 0.55, confluence: 3, b: book([[0.55, 8]], [[0.58, 10]]), now: 2000 });
  assert.deepEqual([gap.mode, gap.event, gap.plan, gap.stop], ['hunt', 'gapped', undefined, 0.57], 'a gap to the entry fair value sells nothing (the default sells at the bid there)');
  const deep = hunt(k, { sideBid: 0.5, confluence: 3, b: book([[0.5, 8]], [[0.53, 10]]), now: 3000 });
  assert.deepEqual([deep.mode, deep.event, deep.plan, deep.stop], ['hunt', 'gapped', undefined, 0.57], 'a gap below the entry fair value keeps the lock too (the default drops it)');
  const back = hunt(k, { sideBid: 0.56, confluence: 3, b: book([[0.56, 8]], [[0.6, 10]]), now: 4000 });
  assert.deepEqual([back.event, back.plan?.price], ['triggered', 0.56], 'the bid coming back to a tick under the lock sells there');

  const g = new ConfluenceRatchetExit(H, P); // the default: the gap sale
  hunt(g, { qSide: 0.55, sideBid: 0.5, b, now: 0 });
  hunt(g, { sideBid: 0.6, confluence: 3, b, now: 1000 });
  const sold = hunt(g, { sideBid: 0.55, confluence: 3, b: book([[0.55, 8]], [[0.58, 10]]), now: 2000 });
  assert.deepEqual([sold.event, sold.plan?.price], ['profit_take_gap', 0.55], 'the default sells at the bid on a gap that is still at the entry fair value');
});

test('HUNT_LOCK_SALE_AT=lock judges the lock once: sells at the bid when the bid pays the fair value plus the margin or the taker flow favours the side, else holds with no stop or hands over', () => {
  const L = { ...H, lockSaleAt: 'lock' as const };
  const b = book([[0.6, 8], [0.57, 30]], [[0.63, 10]]);
  const at = (h: ConfluenceRatchetExit, o: { sideBid?: number; confluence?: number; fvSide?: number; flowSide?: number; now: number; b?: OrderBook }) =>
    h.update({ position: 5, qSide: 0.55, sideBid: o.sideBid, confluence: o.confluence ?? 0, book: o.b ?? b, now: o.now, tick: 0.01, fees: DEFAULT_FEES, fvSide: o.fvSide, flowSide: o.flowSide });

  // fair value: the bid 0.6 pays 2c over a 0.58 fair value -> sold at the bid, and kept being sold until flat
  const fv = new ConfluenceRatchetExit({ ...L, lockSale: 'fair_value', lockSaleFvMargin: 0.02 }, P);
  at(fv, { sideBid: 0.5, now: 0 });
  const sale = at(fv, { sideBid: 0.6, confluence: 3, fvSide: 0.58, now: 1000 });
  assert.deepEqual([sale.mode, sale.event, sale.plan?.side, sale.plan?.price], ['hunt', 'lock_sale', 'ask', 0.6]);
  const again = at(fv, { sideBid: 0.59, confluence: 3, fvSide: 0.58, now: 2000, b: book([[0.59, 8]], [[0.63, 10]]) });
  assert.deepEqual([again.mode, again.event, again.plan?.price], ['hunt', undefined, 0.59], 'still selling at the bid, no new event');

  // fair value too far above the bid -> the default 'hold': hunt mode without a stop, nothing sells on the way down
  const hold = new ConfluenceRatchetExit({ ...L, lockSale: 'fair_value' }, P);
  at(hold, { sideBid: 0.5, now: 0 });
  const held = at(hold, { sideBid: 0.6, confluence: 3, fvSide: 0.66, now: 1000 });
  assert.deepEqual([held.mode, held.event, held.plan, held.stop], ['hunt', 'lock_hold', undefined, 0.57]);
  const down = at(hold, { sideBid: 0.5, confluence: -3, fvSide: 0.66, now: 2000, b: book([[0.5, 8]], [[0.53, 10]]) });
  assert.deepEqual([down.mode, down.event, down.plan], ['hunt', undefined, undefined], 'a hold has no stop, no profit take and no giveback');

  // 'exit': the lock is judged once and the normal exit has the position; it does not re-arm at the next tick
  const exit = new ConfluenceRatchetExit({ ...L, lockSale: 'flow', lockSaleElse: 'exit' }, P);
  at(exit, { sideBid: 0.5, now: 0 });
  const pass = at(exit, { sideBid: 0.6, confluence: 3, flowSide: -2, now: 1000 });
  assert.deepEqual([pass.mode, pass.event], ['fair_value', 'lock_pass']);
  const later = at(exit, { sideBid: 0.62, confluence: 3, flowSide: 5, now: 2000 });
  assert.deepEqual([later.mode, later.event], ['fair_value', undefined], 'judged once: no second lock');

  // 'flow' sells when takers buy the side; 'both' needs the fair value too; an unpriced lock (no fair value) cannot hit 'fair_value'
  const flow = new ConfluenceRatchetExit({ ...L, lockSale: 'flow' }, P);
  at(flow, { sideBid: 0.5, now: 0 });
  assert.equal(at(flow, { sideBid: 0.6, confluence: 3, flowSide: 3, now: 1000 }).event, 'lock_sale');
  const both = new ConfluenceRatchetExit({ ...L, lockSale: 'both' }, P);
  at(both, { sideBid: 0.5, now: 0 });
  assert.equal(at(both, { sideBid: 0.6, confluence: 3, flowSide: 3, fvSide: 0.7, now: 1000 }).event, 'lock_hold');
  const unpriced = new ConfluenceRatchetExit({ ...L, lockSale: 'fair_value' }, P);
  at(unpriced, { sideBid: 0.5, now: 0 });
  assert.equal(at(unpriced, { sideBid: 0.6, confluence: 3, now: 1000 }).event, 'lock_hold');
  // position flat: everything resets, a new position gets a fresh judgement
  unpriced.update({ position: 0, qSide: 0.5, sideBid: 0.5, confluence: 0, book: b, now: 3000, tick: 0.01, fees: DEFAULT_FEES });
  at(unpriced, { sideBid: 0.5, now: 4000 });
  assert.equal(at(unpriced, { sideBid: 0.6, confluence: 3, fvSide: 0.55, now: 5000 }).event, 'lock_sale');
});

test('HUNT_LOCK_SALE at the trigger (default): the stop walks up as before; the first dip or gap under it is judged once, sold into a bid over fair value, else held with nothing reducing the position, or handed over with else=exit', () => {
  const at = (h: ConfluenceRatchetExit, o: { sideBid: number; confluence?: number; fvSide?: number; now: number; b: OrderBook }) =>
    h.update({ position: 5, qSide: 0.55, sideBid: o.sideBid, confluence: o.confluence ?? 3, book: o.b, now: o.now, tick: 0.01, fees: DEFAULT_FEES, fvSide: o.fvSide });
  const up = book([[0.61, 6], [0.58, 30]], [[0.64, 10]]); // a wall at 0.58 under the bid
  const dip = book([[0.57, 30], [0.55, 10]], [[0.62, 10]]); // the bid one tick under the 0.58 stop
  const gap = book([[0.5, 40]], [[0.55, 10]]);

  // sold: at the first dip the bid 0.57 pays 2c over a 0.55 fair value
  const sell = new ConfluenceRatchetExit({ ...H, lockSale: 'fair_value', lockSaleFvMargin: 0.02 }, P);
  at(sell, { sideBid: 0.5, confluence: 0, now: 0, b: up });
  const on = at(sell, { sideBid: 0.61, now: 1000, b: up });
  assert.deepEqual([on.mode, on.event], ['hunt', 'activated']);
  const walked = at(sell, { sideBid: 0.61, confluence: -3, fvSide: 0.7, now: 4000, b: up }); // the wall has aged: the stop walks up; no profit take on the flip
  assert.deepEqual([walked.mode, walked.event, walked.stop, walked.plan], ['hunt', 'ratcheted', 0.58, undefined]);
  const sold = at(sell, { sideBid: 0.57, fvSide: 0.55, now: 5000, b: dip });
  assert.deepEqual([sold.mode, sold.event, sold.plan?.side, sold.plan?.price], ['hunt', 'lock_sale', 'ask', 0.57]);
  assert.equal(at(sell, { sideBid: 0.56, fvSide: 0.55, now: 6000, b: book([[0.56, 8]], [[0.6, 10]]) }).plan?.price, 0.56, 'keeps selling at the bid until flat');

  // held: the bid at the first dip is under fair value plus the margin -> nothing reduces the position after that
  const hold = new ConfluenceRatchetExit({ ...H, lockSale: 'fair_value', lockSaleFvMargin: 0.02 }, P);
  at(hold, { sideBid: 0.5, confluence: 0, now: 0, b: up });
  at(hold, { sideBid: 0.61, now: 1000, b: up }); at(hold, { sideBid: 0.61, now: 4000, b: up });
  const held = at(hold, { sideBid: 0.57, fvSide: 0.58, now: 5000, b: dip });
  assert.deepEqual([held.mode, held.event, held.plan], ['hunt', 'lock_hold', undefined]);
  const deeper = at(hold, { sideBid: 0.5, confluence: -3, fvSide: 0.2, now: 6000, b: gap });
  assert.deepEqual([deeper.mode, deeper.event, deeper.plan], ['hunt', undefined, undefined], 'judged once: no stop, no gap sale, no profit take');

  // a gap is a first trigger too; else=exit hands the position to the normal exit, judged once
  const exit = new ConfluenceRatchetExit({ ...H, lockSale: 'fair_value', lockSaleElse: 'exit' }, P);
  at(exit, { sideBid: 0.5, confluence: 0, now: 0, b: up });
  at(exit, { sideBid: 0.61, now: 1000, b: up }); at(exit, { sideBid: 0.61, now: 4000, b: up });
  const pass = at(exit, { sideBid: 0.5, fvSide: 0.6, now: 5000, b: gap });
  assert.deepEqual([pass.mode, pass.event], ['fair_value', 'lock_pass']);
  const later = at(exit, { sideBid: 0.61, now: 6000, b: up });
  assert.deepEqual([later.mode, later.event], ['fair_value', undefined], 'no second lock');
});

test('HUNT_WALL_ASK: the hunted position rests its sell at a top-of-book sell wall over fair value plus the margin, found once; the first-dip judgement still runs and cancels it on a hold', () => {
  const at = (h: ConfluenceRatchetExit, o: { sideBid: number; confluence?: number; fvSide?: number; now: number; b: OrderBook }) =>
    h.update({ position: 5, qSide: 0.55, sideBid: o.sideBid, confluence: o.confluence ?? 3, book: o.b, now: o.now, tick: 0.01, fees: DEFAULT_FEES, fvSide: o.fvSide });
  const W = { ...H, lockSale: 'fair_value' as const, lockSaleFvMargin: 0.02, wallAsk: true, wallAskRatio: 3 };
  const thin = book([[0.61, 6], [0.58, 30]], [[0.64, 10]]); // the 0.64 ask is under 3 x the 6 bid: no wall
  const wall = book([[0.61, 6], [0.58, 30]], [[0.64, 20]]); // 20 >= 3 x 6 and >= the 5 held
  const dip = book([[0.57, 30], [0.55, 10]], [[0.62, 10]]);

  const h = new ConfluenceRatchetExit(W, P);
  at(h, { sideBid: 0.5, confluence: 0, now: 0, b: thin });
  const on = at(h, { sideBid: 0.61, fvSide: 0.6, now: 1000, b: thin });
  assert.deepEqual([on.event, on.rest], ['activated', undefined], 'no wall yet');
  const low = at(h, { sideBid: 0.61, fvSide: 0.63, now: 2000, b: wall });
  assert.equal(low.rest, undefined, 'the wall at 0.64 is under fair value 0.63 + 2c');
  const found = at(h, { sideBid: 0.61, fvSide: 0.6, now: 3000, b: wall });
  assert.deepEqual([found.mode, found.event, found.rest, found.plan], ['hunt', 'wall_ask', 0.64, undefined]);
  const kept = at(h, { sideBid: 0.61, fvSide: 0.6, now: 4000, b: thin });
  assert.deepEqual([kept.event, kept.rest], ['ratcheted', 0.64], 'found once: the rest stays when the wall thins');
  const held = at(h, { sideBid: 0.57, fvSide: 0.58, now: 5000, b: dip });
  assert.deepEqual([held.event, held.rest, held.plan], ['lock_hold', undefined, undefined], 'the judgement cancels the resting sell');
  assert.equal(at(h, { sideBid: 0.6, fvSide: 0.5, now: 6000, b: wall }).rest, undefined, 'nothing rests after the hold');

  // sold at the first dip: the sale replaces the resting sell
  const s = new ConfluenceRatchetExit(W, P);
  at(s, { sideBid: 0.5, confluence: 0, now: 0, b: thin });
  at(s, { sideBid: 0.61, fvSide: 0.6, now: 1000, b: wall });
  assert.equal(at(s, { sideBid: 0.61, fvSide: 0.6, now: 4000, b: wall }).rest, 0.64);
  const sold = at(s, { sideBid: 0.57, fvSide: 0.55, now: 5000, b: dip });
  assert.deepEqual([sold.event, sold.plan?.price, sold.rest], ['lock_sale', 0.57, undefined]);

  // long NO: the wall is a YES bid, read in NO terms
  const no = new ConfluenceRatchetExit(W, P);
  const atNo = (o: { sideBid: number; confluence?: number; fvSide?: number; now: number; b: OrderBook }) =>
    no.update({ position: -5, qSide: 0.55, sideBid: o.sideBid, confluence: o.confluence ?? -3, book: o.b, now: o.now, tick: 0.01, fees: DEFAULT_FEES, fvSide: o.fvSide });
  const noWall = book([[0.36, 20]], [[0.39, 6], [0.42, 30]]); // NO bid 0.61 (6), NO ask 0.64 (20)
  atNo({ sideBid: 0.5, confluence: 0, now: 0, b: noWall });
  atNo({ sideBid: 0.61, fvSide: 0.6, now: 1000, b: noWall });
  assert.equal(atNo({ sideBid: 0.61, fvSide: 0.6, now: 2000, b: noWall }).rest, 0.64);

  // off: nothing rests
  const off = new ConfluenceRatchetExit({ ...H, lockSale: 'fair_value' as const }, P);
  at(off, { sideBid: 0.5, confluence: 0, now: 0, b: thin });
  at(off, { sideBid: 0.61, fvSide: 0.6, now: 1000, b: wall });
  assert.equal(at(off, { sideBid: 0.61, fvSide: 0.6, now: 2000, b: wall }).rest, undefined);
});

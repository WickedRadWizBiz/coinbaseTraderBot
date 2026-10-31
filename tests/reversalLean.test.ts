import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, paperEnv } from '../bot/config';
import { decide, type MarketView } from '../bot/strategy/fairValueStrategy';
import { makerLean, priceLean, REVERSAL_LEAN_OFF, reversalVotes } from '../bot/strategy/reversalLean';

test('reversal votes lean toward the bounce and ignore missing readings', () => {
  assert.equal(reversalVotes({}), 0);
  assert.equal(reversalVotes({ bb_pctb_300: 0.02, rsi_14_1m: 15, ret_300s_z: -4 }), 3);
  assert.equal(reversalVotes({ bb_pctb_300: 0.98, rsi_14_1m: 85, ret_300s_z: 1 }), -2.5);
  assert.equal(reversalVotes({ bb_pctb_300: 0.5, rsi_14_1m: 50, ret_300s_z: NaN }), 0);
});

test('the leans are off by default, capped, and the price lean only tips close calls', () => {
  const f = { bb_pctb_300: 0.02, rsi_14_1m: 15, ret_300s_z: -4 };
  assert.equal(makerLean(REVERSAL_LEAN_OFF, f), 0);
  assert.equal(priceLean(REVERSAL_LEAN_OFF, f, 0.5), 0);
  const p = { ...REVERSAL_LEAN_OFF, maker: 0.01, price: 0.005 };
  assert.equal(makerLean(p, f), 0.02);
  assert.equal(priceLean(p, f, 0.55), 0.015);
  assert.equal(priceLean(p, f, 0.8), 0);
});

test('a maker lean moves both quotes toward the favoured side', () => {
  const base = {
    ticker: 'T', pYes: 0.5, bestBid: { price: 0.4, size: 100 }, bestAsk: { price: 0.6, size: 100 }, position: 0, bankroll: 1000,
    maxOrderRiskUsd: 20, maxContracts: 20, minSidePrice: 0.05, tauSec: 600, noEntryBeforeCloseSec: 30, fastMove: false, tickSize: 0.01,
    nowSec: 1000, closeSec: 1600,
  } as unknown as MarketView;
  // The quote centre is the decision probability plus the lean: with a lean the YES bid is higher than without.
  const S = loadConfig(paperEnv({ ...process.env, DASHBOARD_TOKEN: 'x'.repeat(32), STRATEGY_STYLE: 'maker' })).strategy;
  const bid = (v: MarketView) => decide(v, S, { exits: false }).place.find((o) => o.why === 'maker bid')?.price;
  const ask = (v: MarketView) => decide(v, S, { exits: false }).place.find((o) => o.why === 'maker ask')?.price;
  const b0 = bid(base), b1 = bid({ ...base, makerLean: 0.02 });
  const a0 = ask(base), a1 = ask({ ...base, makerLean: 0.02 });
  assert.ok(b0 !== undefined && b1 !== undefined && a0 !== undefined && a1 !== undefined, 'both quotes placed');
  assert.ok(b1 > b0);
  assert.ok(a1 > a0);
});

test('the extreme exit fires only against the held side and only when switched on', async () => {
  const { extremeExit } = await import('../bot/strategy/reversalLean');
  const f = { bb_pctb_300: 0.98, rsi_14_1m: 85, ret_300s_z: 1 }; // stretched up: votes -2.5
  assert.equal(extremeExit(REVERSAL_LEAN_OFF, f, 10), false);
  const p = { ...REVERSAL_LEAN_OFF, exitVotes: 1.5 };
  assert.equal(extremeExit(p, f, 10), true); // long YES at an up extreme: take it
  assert.equal(extremeExit(p, f, -10), false); // long NO: the stretch is against it
  assert.equal(extremeExit(p, f, 0), false);
});

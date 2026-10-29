import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, type StrategyConfig } from '../bot/config';
import { DEFAULT_FEES } from '../bot/fees';
import { decide, MarketView } from '../bot/strategy/fairValueStrategy';
import { ProfitPeaks } from '../bot/strategy/profitPeaks';

// Continuous cadence + Kelly sizing (the pre-relaxed behaviour these tests pin down).
// The exit tests below were written against the ratchet policy and the 1c margin (the defaults until Oct 29; the fallback is
// now the model exit at a 4c margin).
const base = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), STRATEGY_CADENCE: 'continuous', EXIT_POLICY: 'confluence_ratchet', STRATEGY_EXIT_MARGIN: '0.01' }).strategy;
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

test('PROFIT_GIVE_BACK=0: a winner is sold at the bid once that banks the floor net of both fees, even though the model values it higher', () => {
  const pt = { ...cfg, profitTarget: 0.02, profitTargetPct: 0, profitGiveBack: 0 };
  // Bought 10 YES at 0.40 as a maker (no fee); the model now says 0.70, so the fair-value exit would hold.
  const long = (bid: number) => view({ position: 10, pYes: 0.7, entrySidePrice: 0.4, entryFeePerContract: 0, bestBid: { price: bid, size: 50 }, bestAsk: { price: bid + 0.02, size: 50 } });
  // 0.43: +3c gross, minus the taker fee (18c on the order, rounded up to the cent) = +1.2c net: under the target.
  assert.equal(decide(long(0.43), pt).place.filter((p) => p.purpose === 'exit').length, 0);
  // 0.44: +4c - 1.8c = +2.2c net.
  const exit = decide(long(0.44), pt).place.find((p) => p.purpose === 'exit')!;
  assert.deepEqual([exit.side, exit.price, exit.count, exit.reduceOnly, exit.timeInForce], ['ask', 0.44, 10, true, 'immediate_or_cancel']);
  assert.match(exit.why, /^take-profit: \+0\.02\d a contract net of fees \(best \+0\.02\d, floor \+0\.020\)/);
  assert.equal(exit.protective, undefined, 'the curve still times it');
  // Fees already paid on the entry count against the gain.
  assert.equal(decide({ ...long(0.44), entryFeePerContract: 0.01 }, pt).place.filter((p) => p.purpose === 'exit').length, 0);
  // Off: the model's exit alone, which holds a contract it values at 0.70.
  assert.equal(decide(long(0.5), { ...pt, profitTarget: 0 }).place.filter((p) => p.purpose === 'exit').length, 0);
  // A percentage target, when larger: 10% of 0.40 = 4c net.
  assert.equal(decide(long(0.44), { ...pt, profitTargetPct: 0.1 }).place.filter((p) => p.purpose === 'exit').length, 0);
  assert.equal(decide(long(0.46), { ...pt, profitTargetPct: 0.1 }).place.filter((p) => p.purpose === 'exit').length, 1);
});

test('take-profit on a NO position (PROFIT_GIVE_BACK=0): bought back at the ask, priced on the NO side', () => {
  const pt = { ...cfg, profitTarget: 0.02, profitTargetPct: 0, profitGiveBack: 0 };
  // Holding 10 NO bought at 0.40 (YES sold at 0.60); the model wants to keep it (P(YES) 0.30).
  const short = (yesAsk: number) => view({ position: -10, pYes: 0.3, entrySidePrice: 0.4, entryFeePerContract: 0, bestBid: { price: yesAsk - 0.02, size: 50 }, bestAsk: { price: yesAsk, size: 50 } });
  assert.equal(decide(short(0.57), pt).place.filter((p) => p.purpose === 'exit').length, 0, 'NO bid 0.43: +1.2c net');
  const exit = decide(short(0.56), pt).place.find((p) => p.purpose === 'exit')!;
  assert.deepEqual([exit.side, exit.price, exit.count, exit.reduceOnly], ['bid', 0.56, 10, true]);
  assert.match(exit.why, /^take-profit NO: \+0\.02/);
});

test('take-profit: no exits in the final minute or while hunting (the hunt\'s trailing stop has it)', () => {
  const pt = { ...cfg, profitTarget: 0.02, profitTargetPct: 0, profitGiveBack: 0 };
  const long = view({ position: 10, pYes: 0.7, entrySidePrice: 0.4, entryFeePerContract: 0, bestBid: { price: 0.5, size: 50 }, bestAsk: { price: 0.52, size: 50 } });
  assert.equal(decide({ ...long, exitWindowOpen: false }, pt).place.filter((p) => p.purpose === 'exit').length, 0);
  assert.equal(decide(long, pt, { exits: false, blockReductions: true }).place.filter((p) => p.purpose === 'exit').length, 0);
});

test('take-profit default: armed at 10% of what a contract cost (price plus the entry fee) and at least 2c, then trails', () => {
  assert.equal(cfg.profitTargetPct, 0.1);
  assert.equal(cfg.profitTarget, 0.02);
  assert.equal(cfg.profitGiveBack, 1 / 3);
  // Bought at 0.40 with a 1c fee: cost 0.41, so the floor is 4.1c net.
  const long = (bid: number, peak = bid) => view({ position: 10, pYes: 0.7, entrySidePrice: 0.4, entryFeePerContract: 0.01, profitPeakSidePrice: peak, bestBid: { price: bid, size: 50 }, bestAsk: { price: bid + 0.02, size: 50 } });
  const at46 = decide(long(0.46), cfg);
  assert.equal(at46.place.filter((p) => p.purpose === 'exit').length, 0, '+6c - 1c - 1.8c = +3.2c: under the floor');
  assert.ok(!at46.notes.some((n) => n.startsWith('take-profit armed')));
  // 0.47 is +4.2c, over the floor: armed, but a winner at its best is not sold.
  const at47 = decide(long(0.47), cfg);
  assert.equal(at47.place.filter((p) => p.purpose === 'exit').length, 0);
  assert.ok(at47.notes.some((n) => /^take-profit armed: \+0\.042 now, best \+0\.042/.test(n)), at47.notes.join(' | '));
  // Back at 0.47 after a 0.48 best (+5.2c): into the last tick above the floor, sold to lock it in (protective).
  const lock = decide(long(0.47, 0.48), cfg).place.find((p) => p.purpose === 'exit')!;
  assert.deepEqual([lock.side, lock.price, lock.count, lock.protective], ['ask', 0.47, 10, true]);
  assert.match(lock.why, /^take-profit: \+0\.042 a contract net of fees \(best \+0\.052, floor \+0\.041\)/);
  // A cheap contract: 10% of 0.12 is 1.2c, so the 2c minimum is the floor.
  const cheap = (bid: number, peak = bid) => view({ position: 10, pYes: 0.3, entrySidePrice: 0.12, entryFeePerContract: 0, profitPeakSidePrice: peak, bestBid: { price: bid, size: 50 }, bestAsk: { price: bid + 0.02, size: 50 } });
  assert.equal(decide(cheap(0.14, 0.16), cfg).place.filter((p) => p.purpose === 'exit').length, 0, '+2c - 0.9c fee < 2c');
  assert.match(decide(cheap(0.15, 0.16), cfg).place.find((p) => p.purpose === 'exit')!.why, /floor \+0\.020\)/);
});

test('take-profit: a winner runs and is sold once it gives back a third of its best gain, never below the floor', () => {
  // Bought 10 YES at 0.40 as a maker (no fee): floor 4c. The model values it at 0.70, so its own exit holds.
  const long = (bid: number, peak: number) => view({ position: 10, pYes: 0.7, entrySidePrice: 0.4, entryFeePerContract: 0, profitPeakSidePrice: peak, bestBid: { price: bid, size: 50 }, bestAsk: { price: bid + 0.02, size: 50 } });
  const exitOf = (bid: number, peak: number) => decide(long(bid, peak), cfg).place.find((p) => p.purpose === 'exit');
  // Best 0.60: +20c less the 1.7c taker fee = +18.3c. A third given back leaves +12.2c.
  assert.equal(exitOf(0.6, 0.6), undefined, 'at its best: runs');
  assert.equal(exitOf(0.55, 0.6), undefined, '+13.2c: less than a third given back');
  const out = exitOf(0.53, 0.6)!;
  assert.deepEqual([out.side, out.price, out.count, out.protective], ['ask', 0.53, 10, undefined]);
  assert.match(out.why, /^take-profit: \+0\.112 a contract net of fees \(best \+0\.183, floor \+0\.040\)/);
  // A best of 0.48 (+6.2c): back at 0.46 (+4.2c, the last tick above the floor) it is sold, protective.
  const lock = exitOf(0.46, 0.48)!;
  assert.deepEqual([lock.price, lock.protective], [0.46, true]);
  // Gapped through the floor to 0.45 (+3.2c): no sale below the floor; the model exit has the position.
  assert.equal(exitOf(0.45, 0.48), undefined);
  // Without a high-water mark the current bid is the best seen: not sold at its best.
  assert.equal(decide({ ...long(0.6, 0.6), profitPeakSidePrice: undefined }, cfg).place.filter((p) => p.purpose === 'exit').length, 0);
});

test('take-profit benched (its scoreboard against holding to settlement): it sells nothing; the model exit still sells', () => {
  const long = (bid: number, peak: number, pYes: number) => view({ position: 10, pYes, entrySidePrice: 0.4, entryFeePerContract: 0, profitPeakSidePrice: peak, bestBid: { price: bid, size: 50 }, bestAsk: { price: bid + 0.02, size: 50 }, takeProfitBenched: 'take-profit sales cost $26.00 against holding to settlement over 13 markets (limit $25)' });
  // The sale the trailing take-profit makes above (+11.2c, a third of the best given back) is not made.
  const out = decide(long(0.53, 0.6, 0.7), cfg);
  assert.equal(out.place.filter((p) => p.purpose === 'exit').length, 0);
  assert.ok(out.notes.some((n) => /^take-profit benched: \+0\.112 now, best \+0\.183, not sold \(take-profit sales cost \$26\.00/.test(n)), out.notes.join(' | '));
  // The model now values it at 0.40: the bid less the fee beats that by more than the margin, so the model exit sells.
  const model = decide(long(0.53, 0.6, 0.4), cfg).place.find((p) => p.purpose === 'exit')!;
  assert.deepEqual([model.side, model.price, model.count], ['ask', 0.53, 10]);
  assert.match(model.why, /^bid 0\.53 - fee > q 0\.400/);
});

test('take-profit on a NO position: trails the NO bid and buys back at the YES ask', () => {
  // Holding 10 NO bought at 0.40; the model wants to keep it (P(YES) 0.30). Best NO bid 0.60, now 0.53 (YES ask 0.47).
  const short = (yesAsk: number, peakNo: number) => view({ position: -10, pYes: 0.3, entrySidePrice: 0.4, entryFeePerContract: 0, profitPeakSidePrice: peakNo, bestBid: { price: yesAsk - 0.02, size: 50 }, bestAsk: { price: yesAsk, size: 50 } });
  assert.equal(decide(short(0.45, 0.6), cfg).place.filter((p) => p.purpose === 'exit').length, 0, 'NO bid 0.55: +13.2c, runs');
  const exit = decide(short(0.47, 0.6), cfg).place.find((p) => p.purpose === 'exit')!;
  assert.deepEqual([exit.side, exit.price, exit.count], ['bid', 0.47, 10]);
  assert.match(exit.why, /^take-profit NO: \+0\.112/);
});

test('take-profit high-water mark: the best side price since the position was opened or added to; a sale keeps it', () => {
  const pk = new ProfitPeaks();
  assert.equal(pk.update('T', 10, 0.45), 0.45, 'opened');
  assert.equal(pk.update('T', 10, 0.52), 0.52);
  assert.equal(pk.update('T', 10, 0.49), 0.52, 'a lower bid keeps the best');
  assert.equal(pk.update('T', 10, undefined), 0.52, 'no book this tick');
  assert.equal(pk.update('T', 4, 0.5), 0.52, 'partly sold: the rest keeps the mark');
  assert.equal(pk.update('T', 8, 0.47), 0.47, 'added to: a new mark from the current bid');
  assert.equal(pk.update('T', -5, 0.6), 0.6, 'reversed to NO: the NO bid');
  assert.equal(pk.update('T', 0, 0.6), undefined, 'flat');
  assert.equal(pk.update('T', 3, 0.3), 0.3, 'a new position starts again');
});

test('the 10% minimum only adds a reason to sell: the model exit still sells a loser and a small winner', () => {
  assert.equal(cfg.profitTargetPct, 0.1);
  // Long 10 YES bought at 0.50; the model now says 0.30: at a 0.40 bid (a loss) the model exit sells.
  const loser = decide(view({ position: 10, pYes: 0.3, entrySidePrice: 0.5, entryFeePerContract: 0, bestBid: { price: 0.4, size: 50 }, bestAsk: { price: 0.42, size: 50 } }), cfg).place.find((p) => p.purpose === 'exit')!;
  assert.deepEqual([loser.side, loser.price, loser.count], ['ask', 0.4, 10]);
  assert.match(loser.why, /^bid 0\.4 - fee > q 0\.300/);
  // Bought at 0.40, bid 0.42: +2c gross is under the 10% target, but the model (0.30) wants out: it sells.
  const small = decide(view({ position: 10, pYes: 0.3, entrySidePrice: 0.4, entryFeePerContract: 0, bestBid: { price: 0.42, size: 50 }, bestAsk: { price: 0.44, size: 50 } }), cfg).place.find((p) => p.purpose === 'exit')!;
  assert.match(small.why, /^bid 0\.42 - fee > q/);
  // The NO side: holding NO bought at 0.40 while the model turns to YES 0.75: bought back at a loss.
  const noLoser = decide(view({ position: -10, pYes: 0.75, entrySidePrice: 0.4, entryFeePerContract: 0, bestBid: { price: 0.62, size: 50 }, bestAsk: { price: 0.64, size: 50 } }), cfg).place.find((p) => p.purpose === 'exit')!;
  assert.deepEqual([noLoser.side, noLoser.price], ['bid', 0.64]);
});

test('minimum quote: a quote sizing wants is at least 3 contracts, inside the per-order cap and the risk room left', () => {
  assert.equal(base.minQuoteContracts, 3);
  const bidOf = (v: MarketView, c = cfg) => decide(v, c).place.find((p) => p.side === 'bid');
  const askOf = (v: MarketView, c = cfg) => decide(v, c).place.find((p) => p.side === 'ask');
  const small = view({ bankroll: 20 });
  const plain = bidOf(small, { ...cfg, minQuoteContracts: 0 })!;
  assert.ok(plain.count > 0 && plain.count < 1, `Kelly alone quotes ${plain.count}`);
  assert.equal(bidOf(small)!.count, 3);
  assert.equal(askOf(small)!.count, 3);
  // Bounded by the per-order cap ($1 at 53c: 1.88) and by the risk room left; never below what sizing asked for.
  assert.equal(bidOf(view({ bankroll: 20, maxOrderRiskUsd: 1 }))!.count, 1.88);
  assert.equal(bidOf(view({ bankroll: 20, newRiskRoomUsd: 0.8 }))!.count, 1.5);
  assert.equal(bidOf(view({ bankroll: 20, newRiskRoomUsd: 0 }))!.count, plain.count);
  assert.equal(bidOf(view({ bankroll: 20, maxContracts: 2 }))!.count, 2);
  // Larger quotes are left as sized; no quote appears where sizing wants none; unwinding rides on top.
  const big = bidOf(view(), { ...cfg, minQuoteContracts: 0 })!;
  assert.ok(big.count > 3);
  assert.equal(bidOf(view())!.count, big.count);
  assert.equal(decide(view({ bankroll: 0 }), cfg).place.length, 0);
  assert.equal(bidOf(view({ bankroll: 20, position: -2 }))!.count, 5, '3 new YES plus the 2 NO it buys back');
});

test('paper fixed size: a quote sizing wants buys about fixedOrderUsd of contracts, inside the per-order cap and the risk room', () => {
  const bidOf = (v: MarketView) => decide(v, cfg).place.find((p) => p.side === 'bid');
  const fixed = bidOf(view({ fixedOrderUsd: 10, maxOrderRiskUsd: 10, maxContracts: 100 }))!;
  const usd = fixed.count * fixed.price;
  assert.ok(usd > 9.4 && usd <= 10, `${fixed.count} at ${fixed.price}: $${usd.toFixed(2)} (fee included in the $10)`);
  assert.ok(fixed.count > bidOf(view())!.count, 'more than the sized quote');
  // The risk room left and the contract cap still bind; no quote where sizing wants none.
  assert.ok(bidOf(view({ fixedOrderUsd: 10, maxOrderRiskUsd: 10, maxContracts: 100, newRiskRoomUsd: 4 }))!.count * fixed.price <= 4);
  assert.equal(bidOf(view({ fixedOrderUsd: 10, maxOrderRiskUsd: 10, maxContracts: 6 }))!.count, 6);
  assert.equal(decide(view({ fixedOrderUsd: 10, maxOrderRiskUsd: 10, maxContracts: 100, bankroll: 0 }), cfg).place.length, 0);
});

test('a resting quote due to expire on the exchange is placed again, unless the replacement would end no later', () => {
  const first = decide(view(), cfg).place.find((p) => p.side === 'bid')!;
  const resting = { clientOrderId: 'b', price: first.price, remaining: first.count };
  const early = decide(view({ restingBid: { ...resting, expiresSec: 1010 } }), cfg);
  assert.equal(early.cancel.length + early.place.filter((p) => p.side === 'bid').length, 0, '10 s left: kept');
  const due = decide(view({ restingBid: { ...resting, expiresSec: 1001 } }), cfg);
  assert.deepEqual(due.cancel.map((c) => [c.clientOrderId, c.reason]), [['b', 'quote expiring']]);
  assert.equal(due.place.filter((p) => p.side === 'bid').length, 1);
  // Close at 1016: a new quote would also expire at 1001 (15 s before the close), so the old one is left to lapse.
  const atClose = decide(view({ closeSec: 1016, restingBid: { ...resting, expiresSec: 1001 } }), cfg);
  assert.equal(atClose.cancel.length, 0);
});

test('exit curve rest mode: the held side rests its sell at the curve target, never below the take-profit floor', () => {
  // Long 10 YES bought at 0.40 as a maker (no fee): floor 4c, so never below 0.44. The model values it at 0.70.
  const long = (o: Partial<MarketView> = {}) => view({ position: 10, pYes: 0.7, entrySidePrice: 0.4, entryFeePerContract: 0, bestBid: { price: 0.47, size: 50 }, bestAsk: { price: 0.6, size: 50 }, ...o });
  const restOf = (v: MarketView) => decide(v, cfg).place.find((p) => p.side === 'ask' && p.timeInForce === 'good_till_canceled');
  const r = restOf(long({ curveRestSidePrice: 0.553 }))!;
  assert.deepEqual([r.price, r.count, r.postOnly, r.reduceOnly, r.purpose], [0.56, 10, true, false, 'exit']);
  assert.match(r.why, /^exit curve: rest 0\.56 \(\+0\.160 a contract net, swing top 0\.553\)/);
  // A target under the floor rests at the floor; one at or under the bid, a tick above it.
  assert.equal(restOf(long({ curveRestSidePrice: 0.42 }))!.price, 0.48, 'floor 0.44 is under the 0.47 bid: a tick above the bid');
  assert.equal(restOf(long({ curveRestSidePrice: 0.42, bestBid: { price: 0.41, size: 50 } }))!.price, 0.44, 'the floor');
  // Without a target, the opposite-side maker quote as before (not a curve sell).
  assert.doesNotMatch(restOf(long())?.why ?? '', /exit curve/);
  // While a hunt runs the winner: no resting sell.
  assert.equal(decide(long({ curveRestSidePrice: 0.553 }), cfg, { blockReductions: true }).place.filter((p) => p.side === 'ask').length, 0);
  // An exit crossing the book this tick (the bid pays more than the model's value): no resting sell beside it, and a
  // resting one is pulled.
  const exiting = decide(long({ curveRestSidePrice: 0.553, pYes: 0.4, restingAsk: { clientOrderId: 'r', price: 0.56, remaining: 10 } }), cfg);
  assert.ok(exiting.place.some((p) => p.purpose === 'exit' && p.timeInForce === 'immediate_or_cancel'));
  assert.equal(exiting.place.filter((p) => p.side === 'ask' && p.timeInForce === 'good_till_canceled').length, 0);
  assert.ok(exiting.cancel.some((c) => c.clientOrderId === 'r'));
});

test('exit curve rest mode: a NO position rests a YES bid at 1 - target, and the resting sell follows the position size exactly', () => {
  // Long 10 NO bought at 0.30 (YES sold at 0.70): floor 4c on 0.30 is 3c, never below NO 0.33. The model values NO at 0.50.
  const short = (o: Partial<MarketView> = {}) => view({ position: -10, pYes: 0.5, entrySidePrice: 0.3, entryFeePerContract: 0, bestBid: { price: 0.4, size: 50 }, bestAsk: { price: 0.66, size: 50 }, ...o });
  const r = decide(short({ curveRestSidePrice: 0.401 }), cfg).place.find((p) => p.side === 'bid' && p.purpose === 'exit')!;
  assert.deepEqual([r.price, r.count], [0.59, 10]);
  assert.match(r.why, /^exit curve: rest NO 0\.41 /);
  // 4 of the 10 sold another way: the resting 10 is replaced by 6 (a quote would keep its size until it halved).
  const out = decide(short({ position: -6, curveRestSidePrice: 0.401, restingBid: { clientOrderId: 'b', price: 0.59, remaining: 10 } }), cfg);
  assert.ok(out.cancel.some((c) => c.clientOrderId === 'b'));
  assert.equal(out.place.find((p) => p.side === 'bid' && p.purpose === 'exit')!.count, 6);
});

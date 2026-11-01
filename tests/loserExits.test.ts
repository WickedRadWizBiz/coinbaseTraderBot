import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, type StrategyConfig } from '../bot/config';
import { DEFAULT_FEES } from '../bot/fees';
import { applyFvGate, decide, fvGatePasses, inLoserWindow, loserExit, loserNoEntry, shareWindowSec, type MarketView, type StrategyOutput } from '../bot/strategy/fairValueStrategy';

// Steven's settlement rule (Oct 31) and the sizing lab's loser exits: the entry gate, the loser cut and the window cut.
const base = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), STRATEGY_CADENCE: 'continuous' }).strategy;
const cfg: StrategyConfig = {
  ...base,
  style: 'both', series: ['KXBTC15M'], kellyFraction: 0.25, minEdge: 0.02, takerBuffer: 0.01,
  inventorySkewPerContract: 0.002, requoteThreshold: 0.01, fastMoveSigmas: 3, fastMoveWindowSec: 5, orderTtlSec: 60,
  exitPolicy: 'fair_value', sessionRisk: {},
};
const off: StrategyConfig = { ...cfg, loserExits: { ...cfg.loserExits!, gate: false, cut: false, window: false } };

const view = (o: Partial<MarketView> = {}): MarketView => ({
  ticker: 'T', pYes: 0.55, bestBid: { price: 0.5, size: 20 }, bestAsk: { price: 0.6, size: 20 }, position: 0,
  bankroll: 200, maxOrderRiskUsd: 4, maxContracts: 10, minSidePrice: 0.1, tauSec: 400, noEntryBeforeCloseSec: 15,
  fastMove: false, tickSize: 0.01, fees: DEFAULT_FEES, nowSec: 1000, closeSec: 1400, ...o,
});
// Long 10 YES bought at 0.55 plus a 1.75c fee: under water at a 0.50 bid, in profit at 0.70.
const long = (o: Partial<MarketView> = {}) => view({ position: 10, entrySidePrice: 0.55, entryFeePerContract: 0.0175, ...o });
const ioc = (out: StrategyOutput) => out.place.filter((p) => p.purpose === 'exit' && p.timeInForce === 'immediate_or_cancel');

test('loser rules: on by default (gate 6c, cut 3c, window), each off by its flag', () => {
  assert.deepEqual(base.loserExits, { gate: true, gateMargin: 0.06, cut: true, cutMargin: 0.03, window: true, windowJudge: 'bid', windowShare: 0, noEntryShare: 0 });
  const c = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), FV_ENTRY_GATE: 'false', LOSER_CUT: 'false', LOSER_WINDOW_CUT: 'false', FV_ENTRY_GATE_MARGIN: '0.09', LOSER_CUT_MARGIN: '0.05',
    LOSER_WINDOW_JUDGE: 'cost', LOSER_WINDOW_SHARE: '0.25', LOSER_NO_ENTRY_SHARE: '0.2' }).strategy;
  assert.deepEqual(c.loserExits, { gate: false, gateMargin: 0.09, cut: false, cutMargin: 0.05, window: false, windowJudge: 'cost', windowShare: 0.25, noEntryShare: 0.2 });
});

test('loser window cut: in the last share of the window or the final minute a position not in profit is sold at the bid; one in profit rides', () => {
  // The last 10% (settleShare), -0.68 after fees: sold at the bid, the whole position (the bid shows 20).
  const share = decide(long({ settleShare: true, tauSec: 70 }), cfg);
  assert.equal(ioc(share).length, 1);
  const s = ioc(share)[0];
  assert.deepEqual([s.side, s.price, s.count, s.reduceOnly, s.postOnly], ['ask', 0.5, 10, true, false]);
  assert.match(s.why, /^loser window cut: -0\.\d\d net after fees on 10 at bid 0\.50, 70 s to the close/);
  // The final minute (exits closed): sold too, and the hold note is not written.
  const last = decide(long({ exitWindowOpen: false, settleShare: true, tauSec: 30 }), cfg);
  assert.match(ioc(last)[0]?.why ?? '', /^loser window cut: /);
  assert.ok(!last.notes.includes('final minute: riding to settlement'));
  // In profit after fees: it rides to settlement in both.
  const ride = decide(long({ settleShare: true, tauSec: 70, bestBid: { price: 0.7, size: 20 } }), cfg);
  assert.equal(ioc(ride).length, 0);
  assert.ok(ride.notes.includes('final share of the window, in profit after fees: riding to settlement'));
  const rideLast = decide(long({ exitWindowOpen: false, settleShare: true, tauSec: 30, bestBid: { price: 0.7, size: 20 } }), cfg);
  assert.equal(ioc(rideLast).length, 0);
  assert.ok(rideLast.notes.includes('final minute: riding to settlement'));
  // A thin bid sells what it shows; the rest is judged on the next evaluation.
  assert.equal(ioc(decide(long({ settleShare: true, tauSec: 70, bestBid: { price: 0.5, size: 4 } }), cfg))[0]?.count, 4);
  // The NO side: 10 NO bought at 0.40 plus the fee, NO bid 0.35 (YES ask 0.65): bought back at the YES ask.
  const no = ioc(decide(view({ position: -10, entrySidePrice: 0.4, entryFeePerContract: 0.0175, bestBid: { price: 0.6, size: 20 }, bestAsk: { price: 0.65, size: 20 }, settleShare: true, tauSec: 70 }), cfg))[0];
  assert.deepEqual([no?.side, no?.price, no?.count], ['bid', 0.65, 10]);
  assert.match(no!.why, /^loser window cut: .* on 10 NO at bid 0\.35/);
  // Off: the old behavior (the final minute holds every position).
  assert.equal(ioc(decide(long({ exitWindowOpen: false, settleShare: true, tauSec: 30 }), off)).length, 0);
  // No cost basis: no judgement, nothing sold.
  assert.equal(loserExit(view({ position: 10, settleShare: true, tauSec: 70 }), cfg), undefined);
});

test('loser window judge: fair and cost ask the coin before a thin closing bid is hit; no fair value judges at the bid', () => {
  // Long 10 YES at 0.55 + 1.75c (cost 0.5675), bid 0.50 (1.8c fee a contract: 0.482 net), the last share of the window.
  const end = (pFair: number | undefined, judge: 'bid' | 'fair' | 'cost', o: Partial<MarketView> = {}) =>
    ioc(decide(long({ settleShare: true, tauSec: 70, ...(pFair === undefined ? {} : { pFair }), ...o }), { ...cfg, loserExits: { ...cfg.loserExits!, windowJudge: judge } }));
  // fair: sold only when the coin says the bid beats holding (fair value under 0.482); 0.60 rides, 0.47 is sold.
  assert.equal(end(0.6, 'fair').length, 0);
  assert.match(end(0.47, 'fair')[0]?.why ?? '', /^loser window cut: .* at bid 0\.50, fair value 0\.470 < bid less fee 0\.482, 70 s to the close/);
  // cost: sold when the coin says the side is worth less than it cost (0.55 < 0.5675); 0.60 rides.
  assert.equal(end(0.6, 'cost').length, 0);
  assert.match(end(0.55, 'cost')[0]?.why ?? '', /^loser window cut: .* fair value 0\.550 < cost 0\.56\d, 70 s/);
  // bid (as first built) sells at 0.60 too; no fair value known: every judge sells at the bid.
  assert.equal(end(0.6, 'bid').length, 1);
  assert.equal(end(undefined, 'fair').length, 1);
  // Held by the judge in the final minute: it rides (no exit runs there), with the note.
  const last = decide(long({ exitWindowOpen: false, settleShare: true, tauSec: 30, pFair: 0.6 }), { ...cfg, loserExits: { ...cfg.loserExits!, windowJudge: 'cost' } });
  assert.equal(ioc(last).length, 0);
  assert.ok(last.notes.includes('final minute: riding to settlement'));
  // A side worth well under the bid (0.44) is sold under either judge.
  assert.match(end(0.44, 'cost')[0]?.why ?? '', /^loser window cut: /);
  assert.match(end(0.44, 'fair')[0]?.why ?? '', /^loser window cut: /);
});

test('loser window share: LOSER_WINDOW_SHARE starts the window cut earlier, while books are deeper', () => {
  const early = { ...cfg, loserExits: { ...cfg.loserExits!, windowShare: 0.3 } };
  // 900 s contract: the cut starts with 270 s left (30%), before the last 10%.
  assert.match(loserExit(long({ tauSec: 250, windowSec: 900 }), early)?.why ?? '', /^loser window cut: .* 250 s to the close/);
  assert.equal(loserExit(long({ tauSec: 300, windowSec: 900 }), early), undefined);
  // Off (0), or the window's length unknown: only the last share and the final minute.
  assert.equal(loserExit(long({ tauSec: 250, windowSec: 900 }), cfg), undefined);
  assert.equal(loserExit(long({ tauSec: 250 }), early), undefined);
  // In profit: never cut early (its own exits still run).
  assert.equal(loserExit(long({ tauSec: 250, windowSec: 900, bestBid: { price: 0.7, size: 20 } }), early), undefined);
});

test('loser no-entry window: no new risk where the window cut would sell it straight back, nor from LOSER_NO_ENTRY_SHARE left', () => {
  const ne = (share: number, o: Partial<StrategyConfig['loserExits']> = {}): StrategyConfig => ({ ...cfg, loserExits: { ...cfg.loserExits!, noEntryShare: share, ...o } });
  // Off (0): entries run in the last share as before.
  assert.equal(loserNoEntry({ settleShare: true, tauSec: 70, windowSec: 900 }, cfg), false);
  // On: the window cut's stretch (last share, final minute) and from the share left (180 s of 900 at 0.2).
  assert.equal(loserNoEntry({ settleShare: true, tauSec: 70, windowSec: 900 }, ne(0.1)), true);
  assert.equal(loserNoEntry({ exitWindowOpen: false, tauSec: 30 }, ne(0.1)), true);
  assert.equal(loserNoEntry({ tauSec: 150, windowSec: 900 }, ne(0.2)), true);
  assert.equal(loserNoEntry({ tauSec: 200, windowSec: 900 }, ne(0.2)), false);
  // With the window cut off only the share counts.
  assert.equal(loserNoEntry({ settleShare: true, tauSec: 100, windowSec: 900 }, ne(0.1, { window: false })), false);
  // A taker YES the model wants is not taken there, and a resting quote is pulled.
  const taker = (o: Partial<MarketView>, c: StrategyConfig) => decide(view({ pYes: 0.75, pFair: 0.75, ...o }), { ...c, style: 'taker' });
  assert.ok(taker({ tauSec: 400, windowSec: 900 }, ne(0.2)).place.some((p) => p.purpose === 'entry'));
  const late = taker({ tauSec: 150, windowSec: 900 }, ne(0.2));
  assert.equal(late.place.filter((p) => p.purpose === 'entry').length, 0);
  assert.ok(late.notes.includes('loser window: no new risk this close to the end'));
  const pulled = decide(view({ tauSec: 70, windowSec: 900, settleShare: true, restingBid: { clientOrderId: 'q1', price: 0.5, remaining: 5 } }), { ...ne(0.1), style: 'maker' });
  assert.ok(pulled.cancel.some((c) => c.clientOrderId === 'q1'));
  assert.equal(pulled.place.filter((p) => p.purpose === 'quote').length, 0);
  // The finished plan (fill-model crosses, training trades): every order that adds is dropped, exits and reductions stay.
  const plan = (): StrategyOutput => ({ cancel: [], notes: [], place: [
    { side: 'bid', price: 0.6, count: 5, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: false, purpose: 'entry', edge: 0.1, why: 'fill model YES -> cross' },
    { side: 'ask', price: 0.5, count: 3, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: true, purpose: 'exit', edge: 0, why: 'exit' },
    { side: 'ask', price: 0.5, count: 2, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', edge: 0.02, why: 'maker ask' },
  ] });
  const flat = plan();
  assert.equal(applyFvGate(flat, 0.9, 0, DEFAULT_FEES, off, true), 2, 'gate off: the late window still drops new risk');
  assert.deepEqual(flat.place.map((p) => p.why), ['exit']);
  assert.ok(flat.notes.some((n) => n.startsWith('loser window: dropped entry YES at 0.60')));
  const held = plan();
  assert.equal(applyFvGate(held, 0.9, 5, DEFAULT_FEES, off, true), 1);
  assert.deepEqual(held.place.map((p) => p.why), ['exit', 'maker ask']);
});

test('loser cut: a position not in profit is sold at once when the spot fair value of its side is under the bid less the fee less 3c', () => {
  // Bid 0.50, fee 1.8c a contract on 10: the cut line is 0.50 - 0.018 - 0.03 = 0.452.
  const cut = decide(long({ pFair: 0.44 }), cfg);
  assert.equal(ioc(cut).length, 1, JSON.stringify(cut.place));
  assert.match(ioc(cut)[0].why, /^loser cut: fair value 0\.440 < bid 0\.50 - fee 0\.018 - 0\.03, -0\.\d\d net after fees on 10$/);
  assert.equal(ioc(cut)[0].count, 10);
  // Above the line: held (the model, at 0.55, does not sell either).
  assert.equal(ioc(decide(long({ pFair: 0.46 }), cfg)).length, 0);
  // In profit: never a loser cut (its own exits, the pacer or settlement in the last share decide).
  assert.ok(ioc(decide(long({ pFair: 0.2, bestBid: { price: 0.7, size: 20 } }), cfg)).every((p) => !p.why.startsWith('loser')));
  // No fair value, or the flag off: no cut.
  assert.equal(ioc(decide(long(), cfg)).length, 0);
  assert.equal(ioc(decide(long({ pFair: 0.44 }), off)).length, 0);
  // The NO side: NO fair value 1 - 0.7 = 0.30 under NO bid 0.35 - fee - 3c.
  const no = ioc(decide(view({ position: -10, pFair: 0.7, entrySidePrice: 0.4, entryFeePerContract: 0.0175, bestBid: { price: 0.6, size: 20 }, bestAsk: { price: 0.65, size: 20 } }), cfg));
  assert.match(no[0]?.why ?? '', /^loser cut: fair value 0\.300 < bid 0\.35/);
  // One sale a tick: the cut stands in for the position's other exits (the model's sale at the same bid).
  const both = decide(long({ pFair: 0.3, pYes: 0.3 }), cfg);
  assert.equal(ioc(both).length, 1);
  assert.match(ioc(both)[0].why, /^loser cut: /);
});

test('fair value gate: new risk only where the spot fair value of the side bought is at least cost + fee + 6c', () => {
  assert.equal(fvGatePasses(0.7, 'yes', 0.6, 0.02, cfg), true);
  assert.equal(fvGatePasses(0.67, 'yes', 0.6, 0.02, cfg), false);
  assert.equal(fvGatePasses(0.3, 'no', 0.6, 0.02, cfg), true); // NO worth 0.70 against 0.68
  assert.equal(fvGatePasses(undefined, 'yes', 0.6, 0.02, cfg), true);
  assert.equal(fvGatePasses(0.5, 'yes', 0.6, 0.02, off), true);
  // A taker YES the model wants (q 0.75 against a 0.60 ask): taken only when the spot fair value clears the gate.
  const taker = (pFair?: number) => decide(view({ pYes: 0.75, pFair }), { ...cfg, style: 'taker' });
  const take = (out: StrategyOutput) => out.place.find((p) => p.purpose === 'entry');
  assert.ok(take(taker(0.75)));
  assert.ok(take(taker()), 'no fair value: no gate');
  const refused = taker(0.62);
  assert.equal(take(refused), undefined);
  assert.ok(refused.notes.some((n) => /^fair value gate: YES fair value 0\.620 < 0\.60 \+ fee 0\.0\d\d \+ 0\.06$/.test(n)), JSON.stringify(refused.notes));
  // Maker quotes: the gate drops the new risk a quote would add, never the part that unwinds a position.
  const short = (pFair: number) => decide(view({ position: -5, pFair, entrySidePrice: 0.45, entryFeePerContract: 0.0175 }), { ...cfg, style: 'maker' });
  const yesBid = (out: StrategyOutput) => out.place.find((p) => p.side === 'bid' && p.purpose === 'quote');
  assert.ok(yesBid(short(0.7))!.count > 5);
  assert.equal(yesBid(short(0.4))?.count, 5);
});

test('applyFvGate: the finished plan keeps no entry the gate refuses (fill-model crosses, training trades); orders that only reduce stay', () => {
  const plan = (): StrategyOutput => ({ cancel: [], notes: [], place: [
    { side: 'bid', price: 0.6, count: 5, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: false, purpose: 'entry', edge: 0.1, why: 'fill model YES -> cross' },
    { side: 'ask', price: 0.5, count: 3, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: true, purpose: 'exit', edge: 0, why: 'exit' },
    { side: 'ask', price: 0.5, count: 2, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', edge: 0.02, why: 'maker ask' },
  ] });
  // Flat, YES fair value 0.62: the YES cross (0.60 + fee + 6c) and the NO quote (NO worth 0.38 against 0.50) go.
  const flat = plan();
  assert.equal(applyFvGate(flat, 0.62, 0, DEFAULT_FEES, cfg), 2);
  assert.deepEqual(flat.place.map((p) => p.why), ['exit']);
  assert.equal(flat.notes.filter((n) => n.startsWith('fair value gate: dropped')).length, 2);
  // Long 5 YES: the ask for 2 only sells what is held, so it stays.
  const held = plan();
  assert.equal(applyFvGate(held, 0.62, 5, DEFAULT_FEES, cfg), 1);
  assert.deepEqual(held.place.map((p) => p.why), ['exit', 'maker ask']);
  // Off, or no fair value: untouched.
  assert.equal(applyFvGate(plan(), 0.62, 0, DEFAULT_FEES, off), 0);
  assert.equal(applyFvGate(plan(), undefined, 0, DEFAULT_FEES, cfg), 0);
});

test('shareWindowSec: the share rules measure a contract\'s own hour, not a ladder\'s listing hours or a day ahead', () => {
  const close = Date.parse('2026-10-30T17:00:00Z');
  assert.equal(base.shareWindowMaxSec, 3600, 'an hour by default');
  // A 15-minute contract keeps its 900 s (the last 10% is its last 90 s).
  assert.equal(shareWindowSec(close - 900_000, close, 3600), 900);
  // An hourly ladder listed an hour ahead, and a daily one listed 20 hours ahead: both an hour (the last 10% is 6 minutes).
  assert.equal(shareWindowSec(close - 3_600_000, close, 3600), 3600);
  assert.equal(shareWindowSec(close - 20 * 3_600_000, close, 3600), 3600);
  // No cap (0): the listing, as before (20 h: its last 10% was the last 2 hours, the bot's whole entry window).
  assert.equal(shareWindowSec(close - 20 * 3_600_000, close, 0), 72_000);
  // No open time, or a broken one: no window.
  assert.equal(shareWindowSec(Number.NaN, close, 3600), undefined);
  assert.equal(shareWindowSec(close, close, 3600), undefined);
  // At 30 minutes to the close a 20-hour listing is no longer inside the loser window (it was, measured on the listing).
  const L = { ...cfg.loserExits!, windowShare: 0.1 };
  const at = (maxSec: number) => inLoserWindow({ settleShare: false, exitWindowOpen: true, tauSec: 1800, windowSec: shareWindowSec(close - 20 * 3_600_000, close, maxSec) }, L);
  assert.equal(at(3600), false);
  assert.equal(at(0), true);
});

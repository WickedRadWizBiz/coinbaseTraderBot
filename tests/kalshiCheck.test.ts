import assert from 'node:assert/strict';
import path from 'path';
import { test } from 'node:test';
import type { ExchangeFill } from '../bot/kalshi/types';
import type { MarketPosition } from '../bot/oms/positions';
import { KalshiCheck, type SettlementRecord, type TransferRecord } from '../bot/recon/kalshiCheck';
import { tmpDir } from './helpers';
import { PaperExchange } from '../bot/paper/paperExchange';
import { OrderBook } from '../bot/marketdata/orderBook';
import { DEFAULT_FEES } from '../bot/fees';

const T0 = Date.parse('2026-10-07T12:00:00Z');
const fill = (over: Partial<ExchangeFill> = {}): ExchangeFill => ({ tradeId: 'f1', orderId: 'o1', ticker: 'KXBTC15M-A', side: 'bid', count: 3, price: 0.4, isTaker: false, fee: 0.02, ts: T0, ...over });

function mk(o: { settlements?: SettlementRecord[]; transfers?: TransferRecord[]; seen?: string[]; positions?: Record<string, MarketPosition>; now?: () => number; file?: string } = {}) {
  let now = T0;
  const clock = o.now ?? (() => now);
  const check = new KalshiCheck({
    file: o.file,
    source: {
      getSettlements: o.settlements ? async () => o.settlements! : undefined,
      getTransfers: o.transfers ? async () => o.transfers! : undefined,
    },
    now: clock,
    seenTrade: (id) => (o.seen ?? []).includes(id),
    position: (t) => o.positions?.[t],
  });
  return { check, advance: (ms: number) => { now += ms; } };
}

test('Kalshi check: fills match on side, count, price and fee; differences and unknown fills are flagged', () => {
  const { check } = mk({ seen: ['booked-before-restart'] });
  check.onBotFill(fill(), 0.02, 3);
  check.onBotFill(fill({ tradeId: 'f2' }), 0.03, 6);
  check.onExchangeFills([fill(), fill({ tradeId: 'f2', fee: 0.05 }), fill({ tradeId: 'stranger' }), fill({ tradeId: 'booked-before-restart' })]);
  check.onExchangeFills([fill()]); // the replay window lists fills again: compared once
  const r = check.report();
  assert.equal(r.checked.fills, 4);
  assert.equal(r.matched.fills, 2);
  assert.deepEqual(r.mismatches.map((m) => m.kind).sort(), ['fill', 'fill_unknown']);
  assert.match(r.mismatches.find((m) => m.kind === 'fill')!.what, /fee \$0\.0300 vs \$0\.0500/);
  assert.equal(r.ok, false);
  assert.equal(r.today?.bot.fills, 2);
  assert.equal(r.today?.kalshi.fills, 3, 'the fill booked before a restart is in neither column');
});

test('Kalshi check: a settlement matches contracts, payout, fees and net P&L', async () => {
  // Bought 3 YES at 40c (fees 2c), settled YES: payout $3, net 3 - 1.20 - 0.02 = 1.78.
  const rec: SettlementRecord = { ticker: 'KXBTC15M-A', result: 'yes', yesCount: 3, noCount: 0, yesCost: 1.2, noCost: 0, revenue: 3, fees: 0.02, ts: T0 + 60_000 };
  const { check } = mk({ settlements: [rec] });
  check.onBotFill(fill(), 0.02, 3);
  check.onBotSettle({ ticker: 'KXBTC15M-A', result: 'yes', realized: 1.78, positionBefore: 3 }, { ticker: 'KXBTC15M-A', closeTs: T0, asset: 'BTC', yes: 0, netCash: 1.8, fees: 0.02, settled: true, result: 'yes', realized: 1.78, settledTs: T0 + 30_000 });
  await check.checkSettlements();
  const r = check.report();
  assert.equal(r.matched.settlements, 1);
  assert.equal(r.mismatches.length, 0);
  assert.equal(r.today?.bot.payout, 3);
  assert.equal(r.today?.kalshi.payout, 3);
});

test('Kalshi check: settlement differences are named; a partly closed position skips only the net P&L comparison', async () => {
  const rec: SettlementRecord = { ticker: 'KXBTC15M-A', result: 'yes', yesCount: 2, noCount: 0, yesCost: 0.8, noCost: 0, revenue: 2, fees: 0.04, ts: T0 + 60_000 };
  const { check } = mk({ settlements: [rec] });
  check.onBotFill(fill(), 0.02, 3);
  check.onBotFill(fill({ tradeId: 'close', side: 'ask', count: 1, price: 0.5 }), 0.01, 2); // reduces: a partial close
  check.onBotSettle({ ticker: 'KXBTC15M-A', result: 'yes', realized: 999, positionBefore: 2 }, { ticker: 'KXBTC15M-A', closeTs: T0, asset: 'BTC', yes: 0, netCash: 0, fees: 0.03, settled: true, settledTs: T0 + 30_000 });
  await check.checkSettlements();
  const m = check.report().mismatches;
  assert.equal(m.length, 1);
  assert.match(m[0].what, /fees \$0\.0300 vs \$0\.0400/);
  assert.doesNotMatch(m[0].what, /net P&L/, 'net P&L spans the close the record does not show');
});

test('Kalshi check: Kalshi settled a market the bot still holds (after grace), or one the bot never had', async () => {
  const open: MarketPosition = { ticker: 'OPEN', closeTs: T0, asset: 'BTC', yes: 2, netCash: -0.8, fees: 0, settled: false };
  const recs: SettlementRecord[] = [
    { ticker: 'OPEN', result: 'no', yesCount: 2, noCount: 0, yesCost: 0.8, noCost: 0, revenue: 0, fees: 0, ts: T0 },
    { ticker: 'GHOST', result: 'yes', yesCount: 1, noCount: 0, yesCost: 0.5, noCost: 0, revenue: 1, fees: 0, ts: T0 },
  ];
  const { check, advance } = mk({ settlements: recs, positions: { OPEN: open } });
  await check.checkSettlements();
  assert.deepEqual(check.report().mismatches.map((x) => x.ticker), ['GHOST'], 'the open one is still within its grace period');
  advance(31 * 60_000);
  await check.checkSettlements();
  assert.deepEqual(check.report().mismatches.map((x) => x.ticker).sort(), ['GHOST', 'OPEN']);
});

test('Kalshi check: the bot settled a market Kalshi has no record of (two hours on)', async () => {
  const { check, advance } = mk({ settlements: [] });
  check.onBotSettle({ ticker: 'LOST', result: 'yes', realized: 1, positionBefore: 2 }, { ticker: 'LOST', closeTs: T0, asset: 'BTC', yes: 0, netCash: 1, fees: 0, settled: true, settledTs: T0 });
  await check.checkSettlements();
  assert.equal(check.report().mismatches.length, 0);
  advance(2 * 3_600_000 + 1);
  await check.checkSettlements();
  assert.equal(check.report().mismatches[0].kind, 'settlement_missing');
});

test('Kalshi check: a cash move is a transfer only if Kalshi shows one; each transfer is used once', async () => {
  const transfers: TransferRecord[] = [{ id: 'd1', kind: 'deposit', amount: 25, status: 'applied', ts: T0 }, { id: 'w1', kind: 'withdrawal', amount: 10, status: 'pending', ts: T0 }];
  const { check } = mk({ transfers });
  assert.equal(await check.verifyTransfer(25), 'verified');
  assert.equal(await check.verifyTransfer(25), 'unexplained', 'the same deposit cannot explain a second move');
  assert.equal(await check.verifyTransfer(-10), 'unexplained', 'a pending withdrawal has not left the balance');
  const cash = check.report().mismatches.filter((m) => m.kind === 'cash');
  assert.equal(cash.length, 2);
  assert.ok(cash.some((m) => /fell by \$10\.00/.test(m.what)), 'the withdrawal-sized drop is named');
  const { check: paper } = mk();
  assert.equal(await paper.verifyTransfer(5), 'unverifiable', 'no transfer history (paper)');
});

test('Kalshi check: cash line and persistence', () => {
  const file = path.join(tmpDir(), 'kalshi_check.json');
  const { check } = mk({ file });
  check.onBalance(100, 100);
  check.onBotCash(-1.2);
  check.onBalance(98.8, 98.8);
  check.onExchangeFills([fill({ tradeId: 'x' })]);
  check.flush();
  const again = mk({ file }).check.report();
  assert.equal(again.today?.cash?.kalshiStart, 100);
  assert.equal(again.today?.cash?.kalshiEnd, 98.8);
  assert.equal(again.today?.cash?.botExpectedChange, -1.2);
  assert.equal(again.cash?.diff, 0);
  assert.equal(again.mismatches.length, 1);
});

test('paper exchange: settlement records in Kalshi\'s shape (cost basis, fees, payout)', async () => {
  const book = new OrderBook('T');
  book.applySnapshot({ bids: [{ price: 0.39, size: 50 }], asks: [{ price: 0.41, size: 50 }] }, T0);
  const px = new PaperExchange(undefined, 100, () => book, () => DEFAULT_FEES, () => T0);
  const req = { ticker: 'T', side: 'bid' as const, count: 4, price: 0.41, timeInForce: 'immediate_or_cancel' as const, postOnly: false, reduceOnly: false, selfTradePrevention: 'taker_at_cross' as const, clientOrderId: 'a' };
  await px.createOrder(req);                                                       // buy 4 YES at 41c (taker)
  await px.createOrder({ ...req, side: 'ask', count: 1, price: 0.39, clientOrderId: 'b' }); // sell 1 back at 39c
  const fees = (await px.getFills(0)).reduce((s, f) => s + (f.fee ?? 0), 0);
  px.settle('T', 'yes');
  const [r] = await px.getSettlements(0);
  assert.equal(r.yesCount, 3);
  assert.ok(Math.abs(r.yesCost - 3 * 0.41) < 1e-9, `cost basis of the 3 held: ${r.yesCost}`);
  assert.equal(r.revenue, 3);
  assert.ok(Math.abs(r.fees - fees) < 1e-9);
});

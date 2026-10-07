// CPU / disk efficiency changes: each optimisation must leave results exactly as they were.
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { DEFAULT_FEES } from '../bot/fees';
import { IndexTracker } from '../bot/marketdata/indexTracker';
import { OrderBook } from '../bot/marketdata/orderBook';
import { targetedStreamUrl } from '../bot/marketdata/dominance';
import { BarStore, computeFeatureMap, MicroTracker, type FeatureContext } from '../bot/model/featureEngine';
import { sessionState, zoneTime } from '../bot/model/sessions';
import { Oms, type OrderIntent } from '../bot/oms/oms';
import { PaperExchange } from '../bot/paper/paperExchange';
import { stateWriteStats, writeJsonAtomic } from '../bot/util/persist';
import { CpuMeter } from '../bot/engine';
import { FakeGateway } from './fakeGateway';
import { tmpAudit, tmpDir } from './helpers';

const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  ticker: 'KXBTC15M-X', asset: 'BTC', windowCloseTs: 10_000_000, side: 'bid', price: 0.45, count: 5,
  timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote',
  fairValue: 0.5, modelId: 'test', decisionId: 'd1', ...over,
});

test('state writes: fsync only when durable; per-file write stats', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'x.json');
  writeJsonAtomic(f, { a: 1 }, { compact: true });
  writeJsonAtomic(f, { a: 2 }, { durable: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 2 });
  const s = stateWriteStats().find((x) => x.file === 'x.json')!;
  assert.equal(s.n, 2);
  assert.equal(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp')).length, 0, 'no temp file left behind');
});

test('OMS: liveOrders follows every state change (no scan of finished orders)', async () => {
  const gw = new FakeGateway();
  const oms = new Oms({ gateway: gw, audit: tmpAudit(), statePath: path.join(tmpDir(), 'oms.json'), feesFor: () => DEFAULT_FEES, sleep: async () => undefined });
  const a = await oms.submit(intent());
  const b = await oms.submit(intent({ side: 'ask', price: 0.55 }));
  assert.deepEqual(oms.liveOrders().map((o) => o.clientOrderId).sort(), [a.clientOrderId, b.clientOrderId].sort());
  oms.onFill({ tradeId: 't1', orderId: a.orderId!, ticker: a.ticker, side: 'bid', count: 5, price: 0.45, isTaker: false, ts: 1 });
  assert.equal(a.state, 'FILLED');
  assert.deepEqual(oms.liveOrders().map((o) => o.clientOrderId), [b.clientOrderId]);
  await oms.cancel(b.clientOrderId, 'test');
  // FakeGateway reports the cancel through getOrder; either way it is no longer live once terminal.
  oms.onExchangeOrder({ orderId: b.orderId!, clientOrderId: b.clientOrderId, ticker: b.ticker, side: 'ask', price: 0.55, status: 'canceled', fillCount: 0, remainingCount: 0, initialCount: 5 });
  assert.equal(oms.liveOrders().length, 0);
});

test('OMS: the state file keeps only the trade ids a replay could deliver, and de-duplication survives a restart', async () => {
  const statePath = path.join(tmpDir(), 'oms.json');
  const gw = new FakeGateway();
  const mk = () => new Oms({ gateway: gw, audit: tmpAudit(), statePath, feesFor: () => DEFAULT_FEES, sleep: async () => undefined });
  const oms = mk();
  const rec = await oms.submit(intent({ count: 100 }));
  const H = 3_600_000, t0 = 1_800_000_000_000;
  const fill = (id: string, ts: number) => ({ tradeId: id, orderId: rec.orderId!, ticker: rec.ticker, side: 'bid' as const, count: 1, price: 0.45, isTaker: false, ts });
  oms.onFill(fill('old', t0));                 // 10 h before the newest fill: can never be replayed again
  oms.onFill(fill('recent', t0 + 9 * H));
  oms.onFill(fill('newest', t0 + 10 * H));
  oms.saveNow();
  const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.deepEqual(st.seenTradeIds, ['recent', 'newest']);
  assert.equal(st.seenTradeTimes.length, 2);
  const again = mk();
  // Reconciliation replays from 10 minutes before the newest fill: those are recognised.
  assert.equal(again.onFill(fill('recent', t0 + 9 * H)), false);
  assert.equal(again.onFill(fill('newest', t0 + 10 * H)), false);
  assert.equal(again.positions.position(rec.ticker), 3);
});

test('OMS: an old-format state file (ids without times) still de-duplicates', () => {
  const statePath = path.join(tmpDir(), 'oms.json');
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, orders: [], seenTradeIds: ['a', 'b'], positions: [], lastFillTs: 5 }));
  const oms = new Oms({ gateway: new FakeGateway(), audit: tmpAudit(), statePath, feesFor: () => DEFAULT_FEES, sleep: async () => undefined });
  assert.equal(oms.onFill({ tradeId: 'a', orderId: 'x', ticker: 'T', side: 'bid', count: 1, price: 0.5, isTaker: false, ts: 1 }), false);
  oms.saveNow();
  assert.ok(JSON.parse(fs.readFileSync(statePath, 'utf8')).seenTradeIds.includes('b'));
});

test('OMS: in paper the write-ahead record rides the coalesced write; in live it is written before the send', async () => {
  for (const durable of [false, true]) {
    const statePath = path.join(tmpDir(), 'oms.json');
    let seenOnDiskAtSend = false;
    const gw = new FakeGateway();
    gw.onCreate = (req) => { seenOnDiskAtSend = fs.existsSync(statePath) && fs.readFileSync(statePath, 'utf8').includes(req.clientOrderId!); return gw.accept(req); };
    const oms = new Oms({ gateway: gw, audit: tmpAudit(), statePath, feesFor: () => DEFAULT_FEES, sleep: async () => undefined, durableWriteAhead: durable, saveDelayMs: 5 });
    await oms.submit(intent());
    assert.equal(seenOnDiskAtSend, durable);
    oms.flush();
    assert.ok(fs.existsSync(statePath));
  }
});

test('paper exchange: resting-order index, fills on trade prints, and a pruned compact state file', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'paper.json');
  let now = 1_800_000_000_000;
  const book = new OrderBook('T');
  book.applySnapshot({ bids: [{ price: 0.4, size: 10 }], asks: [{ price: 0.6, size: 10 }] }, now);
  const px = new PaperExchange(file, 100, () => book, () => DEFAULT_FEES, () => now);
  const o = await px.createOrder({ ticker: 'T', side: 'bid', count: 2, price: 0.45, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, selfTradePrevention: 'taker_at_cross', clientOrderId: 'c1' });
  assert.equal((await px.getOpenOrders()).length, 1);
  assert.equal((await px.findOrderByClientId('c1'))?.orderId, o.orderId);
  px.onTrade('T', 0.44, 5, 'no'); // a NO taker trades through our 45c bid: filled
  assert.equal((await px.getOrder(o.orderId))?.status, 'executed');
  assert.equal((await px.getOpenOrders()).length, 0);
  await assert.rejects(px.createOrder({ ticker: 'T', side: 'bid', count: 1, price: 0.41, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, selfTradePrevention: 'taker_at_cross', clientOrderId: 'c1' }), /duplicate/);
  // Many finished orders, a day later: the state file keeps the resting one and drops the stale.
  for (let i = 0; i < 80; i++) {
    const x = await px.createOrder({ ticker: 'T', side: 'bid', count: 1, price: 0.41, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, selfTradePrevention: 'taker_at_cross', clientOrderId: `k${i}` });
    await px.cancelOrder(x.orderId);
  }
  const keep = await px.createOrder({ ticker: 'T', side: 'bid', count: 1, price: 0.42, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, selfTradePrevention: 'taker_at_cross', clientOrderId: 'keep' });
  now += 2 * 86_400_000;
  px.flush();
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('\n  '), 'compact JSON');
  assert.deepEqual(st.orders.map((x: { clientOrderId: string }) => x.clientOrderId), ['keep']);
  assert.equal(st.fills.length, 0, 'fills older than a day dropped');
  assert.equal((await px.getOrder(keep.orderId))?.status, 'resting');
  // Reload: the index is rebuilt from the file.
  const px2 = new PaperExchange(file, 100, () => book, () => DEFAULT_FEES, () => now);
  assert.equal((await px2.getOpenOrders())[0]?.clientOrderId, 'keep');
});

test('index tracker: series() reuses results until a new print or another instant; trailing return unchanged', () => {
  const t = new IndexTracker('BTC');
  const now = 1_800_000_000_000;
  for (let s = 600; s >= 1; s--) t.add(100 + s * 0.01, now - s * 1000);
  const a = t.series(now, 300)!;
  assert.equal(t.series(now, 300), a, 'same array for the same instant and data');
  assert.notEqual(t.series(now + 1000, 300), a);
  t.add(99, now);
  const b = t.series(now, 300)!;
  assert.notEqual(b, a);
  assert.equal(b[b.length - 1], 99);
  // trailingLogReturn: latest vs the last print at or before now - window.
  assert.ok(Math.abs(t.trailingLogReturn(now, 10_000)! - Math.log(99 / (100 + 10 * 0.01))) < 1e-12);
  assert.equal(new IndexTracker('X').trailingLogReturn(now, 1000), undefined);
});

test('bar store: window results reused until the next bar closes', () => {
  const b = new BarStore();
  const t0 = 1_800_000_000_000;
  for (let m = 0; m < 40; m++) b.onPrice(100 + m, t0 + m * 60_000);
  const r = b.returns(15)!;
  assert.equal(b.returns(15), r);
  assert.equal(b.last(15), b.last(15));
  b.onPrice(200, t0 + 40 * 60_000); // closes minute 39
  assert.notEqual(b.returns(15), r);
  assert.ok(Math.abs(b.returns(15)![14] - Math.log(139 / 138)) < 1e-12);
});

test('zone time and session state: memoised values equal fresh ones', () => {
  const ts = Date.parse('2026-10-07T13:45:20Z');
  const z = zoneTime(ts, 'America/New_York');
  assert.equal(z.hhmm, '09:45');
  assert.equal(zoneTime(ts + 30_000, 'America/New_York'), z, 'same minute: same object');
  assert.equal(zoneTime(ts + 60_000, 'America/New_York').hhmm, '09:46');
  assert.equal(sessionState(ts).key, sessionState(ts).key);
});

/** A shared asset context plus two different contracts on it. */
function twoContracts() {
  const now = Date.parse('2026-10-07T14:00:00Z');
  const index = new IndexTracker('BTC'), spot = new IndexTracker('BTC'), usdtd = new IndexTracker('USDT.D', 90 * 60_000), btcd = new IndexTracker('BTC.D', 90 * 60_000);
  const bars = new BarStore();
  for (let s = 5400; s >= 0; s--) {
    const ts = now - s * 1000, x = 60000 * Math.exp(1e-6 * (5400 - s) + 2e-4 * Math.sin(s / 37));
    index.add(x, ts); spot.add(x * 1.0002, ts); bars.onPrice(x, ts);
    usdtd.add(4.8 * Math.exp(-1e-6 * (5400 - s)), ts); btcd.add(56 + 1e-4 * Math.cos(s / 50), ts);
  }
  const contract = (ticker: string, bid: number, ask: number, kind: 'updown' | 'greater', strike: number, tauSec: number): FeatureContext => {
    const book = new OrderBook(ticker);
    book.applySnapshot({ bids: [{ price: bid, size: 20 }, { price: bid - 0.01, size: 9 }], asks: [{ price: ask, size: 12 }] }, now - 30_000);
    const micro = new MicroTracker();
    micro.onBook(book, now - 30_000);
    micro.onTrade(5, 'yes', now - 20_000); micro.onTrade(3, 'no', now - 5_000);
    book.applySnapshot({ bids: [{ price: bid + 0.01, size: 15 }], asks: [{ price: ask, size: 4 }] }, now - 1000);
    micro.onBook(book, now - 1000);
    return {
      now, fairValue: (bid + ask) / 2 + 0.03, mid: (bid + ask) / 2, tauSec, sigmaPerSqrtSec: 2e-4, referenceSigma: 2.2e-4, inWindow: false,
      book, micro, index, spot, usdtd, btcd, bars, asset: 'BTC', kind, strike, d2: (bid - 0.5) * 3, vEff: 4e-5, closeTs: now + tauSec * 1000, openTime: now - 300_000, ticker,
    };
  };
  return { a: contract('A', 0.42, 0.46, 'updown', 60010, 600), b: contract('B', 0.71, 0.76, 'greater', 59800, 3000) };
}

test('feature engine: contracts on one asset at one instant share asset-level work with identical results', () => {
  const { a, b } = twoContracts();
  computeFeatureMap(a);
  const shared = computeFeatureMap(b);          // reuses what A computed for BTC at this instant
  computeFeatureMap({ ...a, now: a.now + 1 });  // another instant clears the shared cache
  const fresh = computeFeatureMap(b);
  assert.deepEqual(shared, fresh);
  const finite = Object.values(fresh).filter(Number.isFinite).length;
  assert.ok(finite > 80, `only ${finite} finite features: the comparison would prove little`);
  // And the contract-level features really differ between the two (nothing leaked from A).
  const fa = computeFeatureMap(a);
  for (const k of ['logit_mid', 'logit_fv', 'spread', 'kind_updown', 'log_tau']) assert.notEqual(fa[k], fresh[k], k);
});

test('feature engine: a print between two contracts at the same instant is not missed', () => {
  const { a, b } = twoContracts();
  computeFeatureMap(a);
  a.index.add(70000, a.now); // a big print lands before B is evaluated
  const withPrint = computeFeatureMap(b);
  computeFeatureMap({ ...a, now: a.now + 1 });
  assert.deepEqual(withPrint, computeFeatureMap(b));
});

test('Binance: the all-market stream URL becomes a combined stream of the chosen symbols', () => {
  assert.equal(targetedStreamUrl('wss://data-stream.binance.vision/ws/!miniTicker@arr', ['BTC', 'ETH']), 'wss://data-stream.binance.vision/stream?streams=btcusdt@miniTicker/ethusdt@miniTicker');
  assert.equal(targetedStreamUrl('wss://example.test/custom', ['BTC']), undefined);
  assert.equal(targetedStreamUrl('wss://data-stream.binance.vision/ws/!miniTicker@arr', []), undefined);
});

test('CPU meter: per-minute summary with thread breakdown and a 10-minute history', () => {
  const m = new CpuMeter();
  const realNow = Date.now;
  try {
    let t = realNow();
    Date.now = () => t;
    const start = process.hrtime.bigint();
    m.note('evaluate', start, 5, 10);
    t += 61_000;
    m.note('evaluate', start, 5, 10);
    const s = m.status()!;
    assert.ok(s.processCores >= 0);
    assert.ok(s.mainBusy >= 0 && s.mainBusy <= 1);
    assert.ok(s.rssMb > 0);
    assert.equal(s.evaluatedShare, 0.5);
    if (process.platform === 'linux') assert.ok(s.threads && 'main' in s.threads, 'thread breakdown on Linux');
    assert.equal(m.history().length, 1);
  } finally {
    Date.now = realNow;
  }
});

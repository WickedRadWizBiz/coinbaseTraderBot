import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { IndexTracker } from '../bot/marketdata/indexTracker';
import { OrderBook } from '../bot/marketdata/orderBook';
import { computeFeatureMap } from '../bot/model/featureEngine';
import { hedgeTargets, PerpHedger, type HedgeParams } from '../bot/perps/hedger';
import { lastFundingTime, PaperPerpExchange } from '../bot/perps/paperPerp';
import { assetOfPerp, nextFundingTime, parseFundingEstimate, parseMarginMarket, PerpHub, type PerpSnapshot } from '../bot/perps/perpData';
import { KalshiPerpsRest, parsePerpPositions } from '../bot/perps/perpRest';

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

test('perp market parsing: assets from ticker/title, fixed-point strings, marks, inactive skipped', () => {
  assert.equal(assetOfPerp('BTC-PERP', undefined, ASSETS), 'BTC');
  assert.equal(assetOfPerp('KXETHPERP', undefined, ASSETS), 'ETH');
  assert.equal(assetOfPerp('XYZ1', 'Solana Perpetual', ASSETS), 'SOL');
  assert.equal(assetOfPerp('GOLD-PERP', 'Gold', ASSETS), undefined);
  const s = parseMarginMarket({
    ticker: 'BTC-PERP', title: 'Bitcoin Perpetual', status: 'active', contract_size: '0.0001', tick_size: '0.10', fractional_trading_enabled: true,
    bid: '100000.10', ask: '100000.50', price: '100000.20', open_interest_fp: '1234.00', settlement_mark_price: { price: '100000.30', ts_ms: 1 }, leverage_estimate: '6.8',
  }, ASSETS, 5)!;
  assert.equal(s.asset, 'BTC');
  assert.equal(s.contractSize, 0.0001);
  assert.equal(s.mark, 100000.3);
  assert.equal(s.openInterest, 1234);
  assert.equal(s.fractional, true);
  assert.equal(parseMarginMarket({ ticker: 'BTC-PERP', status: 'inactive' }, ASSETS, 5), undefined);
  const f = parseFundingEstimate({ funding_rate: '0.0001', next_funding_time: '2026-10-01T04:00:00Z', mark_price_dollars: '99999' });
  assert.equal(f.rate, 0.0001);
  assert.equal(f.nextTs, Date.parse('2026-10-01T04:00:00Z'));
  assert.deepEqual(parsePerpPositions({ positions: [{ market_ticker: 'BTC-PERP', position: '-3.00', entry_price: '100000' }] }), [{ ticker: 'BTC-PERP', position: -3, entryPrice: 100000, unrealizedPnl: undefined, marginUsed: undefined }]);
});

test('funding times are 00:00, 08:00 and 16:00 New York (DST-correct)', () => {
  assert.equal(new Date(nextFundingTime(Date.parse('2026-10-01T05:00:00Z'))).toISOString(), '2026-10-01T12:00:00.000Z'); // 08:00 EDT
  assert.equal(new Date(nextFundingTime(Date.parse('2026-12-01T14:00:00Z'))).toISOString(), '2026-12-01T21:00:00.000Z'); // 16:00 EST
  assert.equal(new Date(lastFundingTime(Date.parse('2026-10-01T13:00:00Z'))).toISOString(), '2026-10-01T12:00:00.000Z');
});

test('perps REST client uses the /margin endpoints and the documented order body', async () => {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  const fake = (async (url: string, init: any) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const body = url.includes('/margin/markets') ? [{ ticker: 'ETH-PERP', status: 'active', bid: '4000', ask: '4001', contract_size: '0.001' }]
      : url.includes('/margin/orders') ? { order: { order_id: 'o1', ticker: 'ETH-PERP', side: 'bid', price: '4000', remaining_count: '2.00', status: 'resting' } } : {};
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const signer = { headers: () => ({ 'KALSHI-ACCESS-KEY': 'k' }) } as any;
  const c = new KalshiPerpsRest('https://external-api.demo.kalshi.co/trade-api/v2', signer, fake);
  const m = await c.markets(ASSETS);
  assert.equal(m[0].asset, 'ETH');
  const o = await c.createOrder({ ticker: 'ETH-PERP', side: 'bid', count: 2, price: 4000, clientOrderId: 'c1', postOnly: true, reduceOnly: false });
  assert.equal(o.orderId, 'o1');
  const post = calls.find((x) => x.method === 'POST')!;
  assert.equal(post.url, 'https://external-api.demo.kalshi.co/trade-api/v2/margin/orders');
  assert.deepEqual(Object.keys(post.body).sort(), ['cancel_order_on_pause', 'client_order_id', 'count', 'post_only', 'price', 'reduce_only', 'self_trade_prevention_type', 'side', 'ticker', 'time_in_force']);
  assert.equal(post.body.count, '2.00');
  assert.equal(post.body.time_in_force, 'good_till_canceled');
});

const snap = (o: Partial<PerpSnapshot> = {}): PerpSnapshot => ({ ticker: 'BTC-PERP', asset: 'BTC', ts: 1_800_000_000_000, bid: 99_990, ask: 100_010, contractSize: 0.0001, fractional: true, fundingRate: 0.0001, nextFundingTs: 1_800_000_000_000 + 3_600_000, openInterest: 100, ...o });

test('perp features: premium to the index, lead-lag, funding, open interest', () => {
  const hub = new PerpHub();
  const idx = new IndexTracker('BTC', 3 * 3_600_000);
  const t0 = 1_800_000_000_000;
  for (let s = 0; s <= 3700; s += 2) {
    const ts = t0 + s * 1000;
    idx.add(100_000 + s * 0.01, ts);
    hub.apply(snap({ ts, bid: 100_020 + s * 0.02, ask: 100_040 + s * 0.02, openInterest: 100 + s / 100 }));
  }
  const now = t0 + 3700 * 1000;
  const book = new OrderBook('T');
  book.applySnapshot({ bids: [{ price: 0.5, size: 10 }], asks: [{ price: 0.52, size: 10 }] }, now);
  const f = computeFeatureMap({ now, fairValue: 0.5, mid: 0.51, tauSec: 600, sigmaPerSqrtSec: 1e-4, referenceSigma: 1e-4, inWindow: false, book, index: idx, perp: hub.get('BTC') });
  assert.ok(f.perp_premium_bps > 5 && f.perp_premium_bps < 20, `premium ${f.perp_premium_bps}`);
  assert.ok(f.perp_premium_chg_5m > 0, 'perp drifting up faster than the index');
  assert.ok(f.perp_ret_diff_5m_z > 0);
  assert.equal(f.funding_rate_bps, 1);
  assert.ok(Number.isFinite(f.min_to_funding));
  assert.ok(f.perp_oi_chg_1h > 0);
  const none = computeFeatureMap({ now, fairValue: 0.5, mid: 0.51, tauSec: 600, sigmaPerSqrtSec: 1e-4, referenceSigma: 1e-4, inWindow: false, book, index: idx });
  assert.ok(Number.isNaN(none.perp_premium_bps), 'no perp data -> unavailable, never 0');
});

const P: HedgeParams = { minDollarDelta: 2000, maxNotionalUsd: 1000, excludeTauSec: 120, repriceSec: 30, takerAfterSec: 300 };

test('hedge targets offset the binary delta, respect threshold, caps and near-expiry exclusion', () => {
  const hub = new PerpHub();
  const now = 1_800_000_000_000;
  hub.apply(snap({ ts: now }));
  // Long 100 YES with dP/dS = 1e-4 per $: E = 0.01 BTC, dollar delta = $1,000 < $2,000 -> no hedge.
  let t = hedgeTargets([{ asset: 'BTC', ticker: 'A', position: 100, dPdS: 1e-4, tauSec: 600 }], hub, new Map(), P, now);
  assert.equal(t[0].target, 0);
  // 300 YES: E = 0.03 BTC, $3,000 dollar delta -> short 300 contracts, capped at $1,000 notional = 100 contracts.
  t = hedgeTargets([{ asset: 'BTC', ticker: 'A', position: 300, dPdS: 1e-4, tauSec: 600 }], hub, new Map(), P, now);
  assert.equal(t[0].target, -100);
  assert.match(t[0].reason, /capped/);
  const big = { ...P, maxNotionalUsd: 1e9 };
  t = hedgeTargets([{ asset: 'BTC', ticker: 'A', position: 300, dPdS: 1e-4, tauSec: 600 }, { asset: 'BTC', ticker: 'B', position: -100, dPdS: 1e-4, tauSec: 600 }], hub, new Map(), big, now);
  assert.equal(t[0].target, -200, 'positions net within an asset');
  t = hedgeTargets([{ asset: 'BTC', ticker: 'A', position: 300, dPdS: 1e-4, tauSec: 60 }], hub, new Map([['BTC-PERP', -300]]), big, now);
  assert.equal(t[0].target, 0, 'near-expiry exposure excluded -> unwind');
  assert.equal(t[0].act, true);
  // Hysteresis: a small drift does not trade.
  t = hedgeTargets([{ asset: 'BTC', ticker: 'A', position: 310, dPdS: 1e-4, tauSec: 600 }], hub, new Map([['BTC-PERP', -300]]), big, now);
  assert.equal(t[0].act, false);
});

test('paper hedger: maker entry fills only on trade-through; stale hedge unwinds; kill = reductions only', async () => {
  const hub = new PerpHub();
  let now = 1_800_000_000_000;
  hub.apply(snap({ ts: now }));
  const sim = new PaperPerpExchange(hub, () => 'BTC', { makerBps: 5, takerBps: 12 }, undefined, () => now);
  const h = new PerpHedger({ gateway: sim, hub, params: { ...P, maxNotionalUsd: 1e9 }, now: () => now, risk: { maxOrderNotionalUsd: 1e12 } });
  const exp = [{ asset: 'BTC', ticker: 'A', position: 300, dPdS: 1e-4, tauSec: 600 }];
  await h.tick(exp);
  const open = await sim.getOpenOrders();
  assert.equal(open.length, 1);
  assert.deepEqual([open[0].side, open[0].price, open[0].remaining], ['ask', 100_010, 300], 'sell at the ask: maker, joins the touch');
  hub.apply(snap({ ts: now + 1000, bid: 100_010, ask: 100_030 }));
  sim.step();
  assert.equal((await sim.getPositions()).length, 0, 'touching is not a fill');
  hub.apply(snap({ ts: now + 2000, bid: 100_015, ask: 100_035 }));
  sim.step();
  assert.equal((await sim.getPositions())[0].position, -300);
  // Binaries gone: the hedge must unwind, and while the kill switch is on only that is allowed.
  now += 10_000;
  hub.apply(snap({ ts: now, bid: 100_000, ask: 100_020 }));
  await h.tick([], { reduceOnly: true });
  const unwind = (await sim.getOpenOrders())[0];
  assert.deepEqual([unwind.side, unwind.remaining], ['bid', 300]);
  // Unfilled for takerAfterSec -> crosses the spread reduce-only.
  now += 301_000;
  hub.apply(snap({ ts: now, bid: 100_000, ask: 100_020 }));
  await h.tick([], { reduceOnly: true });
  assert.equal((await sim.getPositions()).length, 0, 'flat');
  assert.equal((await sim.getOpenOrders()).length, 0);
  const led = sim.ledger()['BTC-PERP'];
  assert.ok(led.fees > 0 && Number.isFinite(led.realized));
  // With reduceOnly and no position, nothing new is opened.
  now += 10_000;
  await h.tick(exp, { reduceOnly: true });
  assert.equal((await sim.getOpenOrders()).length, 0);
});

test('paper hedger: an order over the per-order notional cap is trimmed to fit, not dropped', async () => {
  const hub = new PerpHub();
  const now = 1_800_000_000_000;
  hub.apply(snap({ ts: now }));
  const sim = new PaperPerpExchange(hub, () => 'BTC', { makerBps: 5, takerBps: 12 }, undefined, () => now);
  // The hedge wants 300 contracts at the 100,010 ask; the cap allows 150.
  const h = new PerpHedger({ gateway: sim, hub, params: { ...P, maxNotionalUsd: 1e9 }, now: () => now, risk: { maxOrderNotionalUsd: 100_010 * 150 + 5 } });
  await h.tick([{ asset: 'BTC', ticker: 'A', position: 300, dPdS: 1e-4, tauSec: 600 }]);
  const open = await sim.getOpenOrders();
  assert.equal(open.length, 1, 'placed, not dropped');
  assert.deepEqual([open[0].side, open[0].remaining], ['ask', 150]);
  assert.ok(open[0].remaining * open[0].price <= 100_010 * 150 + 5);
});

test('perps config: feed on, hedging simulated by default; live hedging needs live mode and perps keys', () => {
  const c = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) });
  assert.equal(c.perps.feed, true);
  assert.equal(c.perps.hedge, 'paper');
  assert.equal(c.perps.restUrl, 'https://external-api.demo.kalshi.co/trade-api/v2');
  assert.throws(() => loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), PERP_HEDGE: 'live' }), /TRADING_MODE=live/);
});

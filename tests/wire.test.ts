import assert from 'node:assert/strict';
import crypto from 'crypto';
import { test } from 'node:test';
import { KalshiSigner } from '../bot/kalshi/auth';
import { KalshiRest } from '../bot/kalshi/rest';
import { parseIndexRow, tsMs } from '../bot/kalshi/ws';
import { nearestStrikes } from '../bot/marketdata/marketData';
import { fillTickerStrikes, parseBalanceBreakdown, parseCreatedOrder, parseFill, parseMarket, parseOrder, parseOrderbook, parsePositions, tickerStrikeOf, toBookSide } from '../bot/kalshi/wire';

test('exchange shards: cash per shard from the balance breakdown, and each market\'s shard', () => {
  assert.deepEqual(parseBalanceBreakdown({ balance: 3000, balance_breakdown: [{ exchange_index: 0, balance: '30.0000' }, { exchange_index: 2, balance: '0.0000' }] }), { 0: 30, 2: 0 });
  assert.equal(parseBalanceBreakdown({ balance: 3000 }), undefined);
  const m = parseMarket({ ticker: 'KXBTC15M-26OCT221330-30', open_time: '2026-10-22T13:15:00Z', close_time: '2026-10-22T13:30:00Z', exchange_index: 2 })!;
  assert.equal(m.exchangeIndex, 2);
  assert.equal(parseMarket({ ticker: 'X', open_time: '2026-10-22T13:15:00Z', close_time: '2026-10-22T13:30:00Z' })!.exchangeIndex, undefined);
});

test('V2 order payload with fixed-point strings', () => {
  const o = parseOrder({ order: { order_id: 'o1', client_order_id: 'c1', ticker: 'T', side: 'bid', price: '0.4500', status: 'resting', fill_count_fp: '2.00', remaining_count_fp: '3.00', average_fee_paid: '0.0100' } });
  assert.equal(o.side, 'bid');
  assert.equal(o.price, 0.45);
  assert.equal(o.fillCount, 2);
  assert.equal(o.remainingCount, 3);
  assert.ok(Math.abs(o.feesPaid! - 0.02) < 1e-12);
});

test('Create Order V2 reply (outcome only): ticker, side and price come from the request', () => {
  const req = { ticker: 'KXBTC15M-26OCT221430-30', side: 'bid' as const, price: 0.43, count: 10, clientOrderId: '719ea35f' };
  // The reply that tripped the kill switch on Oct 22: a resting GTC order.
  const resting = parseCreatedOrder({ client_order_id: '719ea35f', fill_count: '0.00', order_id: '01a163f2', remaining_count: '10.00', ts_ms: 1792678203049 }, req);
  assert.deepEqual([resting.orderId, resting.clientOrderId, resting.ticker, resting.side, resting.price, resting.status, resting.fillCount, resting.remainingCount, resting.initialCount, resting.updatedTs],
    ['01a163f2', '719ea35f', req.ticker, 'bid', 0.43, 'resting', 0, 10, 10, 1792678203049]);
  // IOC: remaining_count is already final.
  const filled = parseCreatedOrder({ order_id: 'o2', fill_count: '10.00', remaining_count: '0.00', average_fill_price: '0.4200', average_fee_paid: '0.0150', ts_ms: 1 }, req);
  assert.equal(filled.status, 'executed');
  assert.equal(filled.averageFillPrice, 0.42);
  assert.ok(Math.abs(filled.feesPaid! - 0.15) < 1e-12);
  assert.equal(parseCreatedOrder({ order_id: 'o3', fill_count: '0.00', remaining_count: '0.00', ts_ms: 1 }, req).status, 'canceled');
  // A full order object still parses as one.
  assert.equal(parseCreatedOrder({ order: { order_id: 'o4', ticker: 'T', side: 'ask', price: '0.6000', status: 'resting', fill_count_fp: '0.00', remaining_count_fp: '5.00' } }, req).ticker, 'T');
  assert.throws(() => parseCreatedOrder({ order_id: 'o5' }, req), /Unparseable/);
  // Orders listed with only the current direction field (book_side), no deprecated side/action.
  const listed = parseOrder({ order_id: 'o6', ticker: 'T', book_side: 'ask', outcome_side: 'no', yes_price_dollars: '0.5500', status: 'resting', fill_count_fp: '0.00', remaining_count_fp: '3.00' });
  assert.equal(listed.side, 'ask');
  assert.equal(listed.price, 0.55);
});

test('REST: an order Kalshi accepts is an acknowledged order; a cancel names the market so it reaches the right shard', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const calls: string[] = [];
  const rest = new KalshiRest({
    baseUrl: 'https://x.test/trade-api/v2',
    signer: new KalshiSigner('kid', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    fetchImpl: (async (url: string, init: { method: string }) => {
      calls.push(`${init.method} ${url}`);
      if (init.method === 'POST') return new Response('{"client_order_id":"c1","fill_count":"0.00","order_id":"ex1","remaining_count":"10.00","ts_ms":1792678203049}', { status: 201 });
      return new Response('{"order_id":"ex1","client_order_id":"c1","reduced_by":"10.00","ts_ms":1792678204000}', { status: 200 });
    }) as unknown as typeof fetch,
  });
  const o = await rest.createOrder({ ticker: 'KXBTC15M-26OCT221430-30', side: 'bid', count: 10, price: 0.43, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, selfTradePrevention: 'taker_at_cross', clientOrderId: 'c1' });
  assert.equal(o.status, 'resting');
  assert.equal(o.ticker, 'KXBTC15M-26OCT221430-30');
  await rest.cancelOrder('ex1', 'KXBTC15M-26OCT221430-30');
  assert.equal(calls[1], 'DELETE https://x.test/trade-api/v2/portfolio/events/orders/ex1?market_ticker=KXBTC15M-26OCT221430-30');
});

test('legacy order payload (yes/no + action, cents)', () => {
  const o = parseOrder({ order_id: 'o2', ticker: 'T', side: 'no', action: 'buy', yes_price: 40, status: 'executed', fill_count: 1, remaining_count: 0 });
  assert.equal(o.side, 'ask');
  assert.equal(o.price, 0.4);
  assert.equal(o.status, 'executed');
});

test('side mapping onto the single YES book', () => {
  assert.equal(toBookSide('yes', 'buy'), 'bid');
  assert.equal(toBookSide('yes', 'sell'), 'ask');
  assert.equal(toBookSide('no', 'buy'), 'ask');
  assert.equal(toBookSide('no', 'sell'), 'bid');
});

test('unparseable payloads throw instead of defaulting', () => {
  assert.throws(() => parseOrder({ order_id: 'x', side: 'bid' }));
  assert.throws(() => parseFill({ trade_id: 't', side: 'yes', action: 'buy' }));
});

test('fill, positions and orderbook parsing', () => {
  const f = parseFill({ trade_id: 't', order_id: 'o', market_ticker: 'T', side: 'yes', action: 'buy', count_fp: '1.50', yes_price_dollars: '0.3300', is_taker: true, created_time: '2026-09-29T00:00:00Z' });
  assert.equal(f.count, 1.5);
  assert.equal(f.price, 0.33);
  assert.equal(f.side, 'bid');
  assert.deepEqual(parsePositions({ market_positions: [{ ticker: 'T', position_fp: '-2.00' }] }), [{ ticker: 'T', position: -2 }]);
  const ob = parseOrderbook({ orderbook_fp: { yes_dollars: [['0.4000', '10.00']], no_dollars: [['0.5500', '5.00']] } });
  assert.deepEqual(ob.bids, [{ price: 0.4, size: 10 }]);
  assert.deepEqual(ob.asks, [{ price: 0.45, size: 5 }]);
});

test('signature covers timestamp + method + path without query (RSA-PSS)', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const s = new KalshiSigner('kid', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const h = s.headers('GET', '/trade-api/v2/portfolio/orders?status=resting', 1700000000000);
  const ok = crypto.verify('sha256', Buffer.from('1700000000000GET/trade-api/v2/portfolio/orders'), {
    key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }, Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64'));
  assert.equal(ok, true);
  assert.equal(h['KALSHI-ACCESS-KEY'], 'kid');
});

test('Ed25519 keys sign too', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const s = new KalshiSigner('kid', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const h = s.headers('POST', '/trade-api/v2/portfolio/events/orders', 1);
  assert.equal(crypto.verify(null, Buffer.from('1POST/trade-api/v2/portfolio/events/orders'), publicKey, Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64')), true);
});

test('ticker strikes: range bounds and thresholds are filled when Kalshi omits them', () => {
  const ms = [
    { ticker: 'KXDOGE-26OCT0603-B0.097', eventTicker: 'E', tickerStrike: tickerStrikeOf('KXDOGE-26OCT0603-B0.097') } as { ticker: string; eventTicker: string; strikeType?: string; floorStrike?: number; capStrike?: number; tickerStrike?: { kind: 'B' | 'T'; value: number } },
    { ticker: 'KXDOGE-26OCT0603-B0.102', eventTicker: 'E', tickerStrike: tickerStrikeOf('KXDOGE-26OCT0603-B0.102') },
    { ticker: 'KXDOGE-26OCT0603-B0.107', eventTicker: 'E', tickerStrike: tickerStrikeOf('KXDOGE-26OCT0603-B0.107'), floorStrike: 0.1045, capStrike: 0.1095 },
    { ticker: 'KXBTCD-26OCT0603-T85699.99', eventTicker: 'F', tickerStrike: tickerStrikeOf('KXBTCD-26OCT0603-T85699.99') },
    { ticker: 'KXX-1-T5', eventTicker: 'G', strikeType: 'less', tickerStrike: tickerStrikeOf('KXX-1-T5') },
  ];
  fillTickerStrikes(ms);
  assert.ok(Math.abs(ms[0].floorStrike! - 0.0945) < 1e-9 && Math.abs(ms[0].capStrike! - 0.0995) < 1e-9);
  assert.equal(ms[2].floorStrike, 0.1045, 'published bounds are kept');
  assert.equal(ms[3].floorStrike, 85699.99);
  assert.equal(ms[4].capStrike, 5);
  assert.equal(tickerStrikeOf('KXBTC15M-26OCT060300-00'), undefined);
  // A range market without strike_type is recognised from its ticker.
  const p = parseMarket({ ticker: 'KXDOGE-26OCT0603-B0.097', open_time: '2026-10-06T06:00:00Z', close_time: '2026-10-06T07:00:00Z' });
  assert.equal(p?.strikeType, 'between');
});

test('index feed: values parse across field-name variants; timestamps in s / ms / us / ns / ISO', () => {
  assert.deepEqual(parseIndexRow({ index_id: 'brti', value: '65000.5', ts: 1791270000 }), { indexId: 'BRTI', value: 65000.5, ts: 1791270000000 });
  assert.equal(parseIndexRow({ symbol: 'ETHUSD_RTI', price: 2700 })?.indexId, 'ETHUSD_RTI');
  assert.equal(parseIndexRow({ data: { index: 'SOLUSD_RTI', index_value: 120.1 } })?.value, 120.1);
  assert.equal(parseIndexRow({ value: 1 }), undefined, 'no id: dropped (and counted)');
  // Kalshi's actual form (captured from the live feed, October 2026): value_usd + source_ts_ms, with the
  // vendor's own JSON as a string in `data`.
  const live = JSON.parse('{"type":"cfbenchmarks_value_5hz","sid":3,"seq":9166,"msg":{"index_id":"BRTI","value_usd":"86526.25000000","source_ts_ms":1791300043200,"received_at":1791300043239,"data":"{\\"type\\":\\"value\\",\\"time\\":1791300043200,\\"id\\":\\"BRTI\\",\\"value\\":\\"86526.25\\"}"},"sending_ts_ms":1791300043241}');
  assert.deepEqual(parseIndexRow(live.msg, live.msg), { indexId: 'BRTI', value: 86526.25, ts: 1791300043200 });
  // Only the vendor JSON string: still read.
  assert.deepEqual(parseIndexRow({ data: '{"type":"value","time":1791300043200,"id":"XRPUSD_RTI","value":"1.52160"}' }), { indexId: 'XRPUSD_RTI', value: 1.5216, ts: 1791300043200 });
  assert.equal(tsMs(1791270000123), 1791270000123);
  assert.equal(tsMs(1791270000123456), 1791270000123);
  assert.equal(tsMs(1791270000123456789), 1791270000123);
  assert.equal(tsMs('2026-10-06T07:00:00.000Z'), Date.parse('2026-10-06T07:00:00.000Z'));
});

test('strike selection: Kalshi\'s own prices pick the at-the-money strikes (no outside price)', () => {
  const ladder = [0.95, 0.8, 0.55, 0.45, 0.2, 0.05].map((p, i) => ({ ticker: `L-T${i}`, eventTicker: 'L', floorStrike: 100 + i, yesMid: p }));
  const kept = nearestStrikes(ladder, () => 'greater', 'KXBTCD', undefined, 2, new Set()).map((m) => m.ticker);
  assert.deepEqual(kept.sort(), ['L-T2', 'L-T3']);
  const ranges = [0.02, 0.1, 0.4, 0.3, 0.05].map((p, i) => ({ ticker: `R-B${i}`, eventTicker: 'R', strikeType: 'between', floorStrike: i, capStrike: i + 1, yesMid: p }));
  assert.deepEqual(nearestStrikes(ranges, (_s, t) => (t === 'between' ? 'between' : 'greater'), 'KXBTC', undefined, 2, new Set()).map((m) => m.ticker).sort(), ['R-B2', 'R-B3']);
});

test('Kalshi index frames: parsed, counted, and the one-way transit measured from sending_ts_ms', async () => {
  const { KalshiWs } = await import('../bot/kalshi/ws');
  const { latencySnapshot } = await import('../bot/util/latency');
  const ws = new KalshiWs('wss://example.invalid/trade-api/ws/v2', undefined, ['BRTI']);
  const got: Array<{ indexId: string; value: number; ts: number }> = [];
  ws.on('index', (p) => got.push(p));
  const now = Date.now();
  const frame = { type: 'cfbenchmarks_value_5hz', sid: 3, seq: 1, msg: { index_id: 'BRTI', value_usd: '86526.25000000', source_ts_ms: now - 140, received_at: now - 100, data: '{}' }, sending_ts_ms: now - 95 };
  (ws as any).onMessage(JSON.stringify(frame));
  assert.deepEqual(got, [{ indexId: 'BRTI', value: 86526.25, ts: now - 140 }]);
  assert.equal(ws.indexStats.parsed, 1);
  assert.equal(ws.indexStats.dropped, 0);
  assert.equal(ws.indexStats.vendorMs, 40, 'vendor -> Kalshi');
  assert.ok(ws.indexStats.transitMs! >= 95 && ws.indexStats.transitMs! < 1000, `Kalshi -> here ${ws.indexStats.transitMs}`);
  assert.ok(latencySnapshot().kalshiTransit! >= 95);
});

test('Kalshi feed lag: measured from the send stamp (index frames), else from trade times; stale samples expire', async () => {
  const { KalshiWs } = await import('../bot/kalshi/ws');
  const ws = new KalshiWs('wss://example.invalid/trade-api/ws/v2', undefined, ['BRTI']);
  assert.equal(ws.feedLagMs(), undefined, 'no sample yet');
  const now = Date.now();
  // A backlog: Kalshi sent this index print 8 s ago and it is only being handled now.
  (ws as any).onMessage(JSON.stringify({ type: 'cfbenchmarks_value_5hz', sid: 3, seq: 1, msg: { index_id: 'BRTI', value_usd: '86526.25', source_ts_ms: now - 8100 }, sending_ts_ms: now - 8000 }));
  assert.ok(ws.feedLagMs()! >= 8000 && ws.feedLagMs()! < 9000, `${ws.feedLagMs()}`);
  // A fresh trade does not overwrite a recent precise sample...
  (ws as any).onMessage(JSON.stringify({ type: 'trade', sid: 9, seq: 1, msg: { market_ticker: 'T', yes_price_dollars: '0.45', count_fp: '1', taker_side: 'yes', ts: Math.floor(now / 1000) } }));
  assert.ok(ws.feedLagMs()! >= 8000);
  // ...the next index frame does.
  (ws as any).onMessage(JSON.stringify({ type: 'cfbenchmarks_value_5hz', sid: 3, seq: 2, msg: { index_id: 'BRTI', value_usd: '86527', source_ts_ms: now - 60 }, sending_ts_ms: now - 20 }));
  assert.ok(ws.feedLagMs()! < 1000);
  assert.equal(ws.feedLagMs(Date.now() + 6000), undefined, 'a sample older than 5 s says nothing');
  // Trades alone: a trade stamped two minutes ago (whole seconds) arriving now.
  const ws2 = new KalshiWs('wss://example.invalid/trade-api/ws/v2', undefined, []);
  (ws2 as any).onMessage(JSON.stringify({ type: 'trade', sid: 9, seq: 1, msg: { market_ticker: 'T', yes_price_dollars: '0.45', count_fp: '1', taker_side: 'yes', ts: Math.floor(now / 1000) - 120 } }));
  assert.ok(ws2.feedLagMs()! > 118_000, `${ws2.feedLagMs()}`);
});

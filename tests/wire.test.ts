import assert from 'node:assert/strict';
import crypto from 'crypto';
import { test } from 'node:test';
import { KalshiSigner } from '../bot/kalshi/auth';
import { parseFill, parseOrder, parseOrderbook, parsePositions, toBookSide } from '../bot/kalshi/wire';

test('V2 order payload with fixed-point strings', () => {
  const o = parseOrder({ order: { order_id: 'o1', client_order_id: 'c1', ticker: 'T', side: 'bid', price: '0.4500', status: 'resting', fill_count_fp: '2.00', remaining_count_fp: '3.00', average_fee_paid: '0.0100' } });
  assert.equal(o.side, 'bid');
  assert.equal(o.price, 0.45);
  assert.equal(o.fillCount, 2);
  assert.equal(o.remainingCount, 3);
  assert.ok(Math.abs(o.feesPaid! - 0.02) < 1e-12);
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'net';
import { authMiddleware, tokenMatches } from '../bot/api/server';

test('token comparison', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abd'), false);
  assert.equal(tokenMatches('abc', undefined), false);
});

test('every protected route requires the bearer token and locks out brute force', async () => {
  const app = express();
  app.use('/api', authMiddleware('t'.repeat(40)), (_req, res) => { res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/status`;
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { headers: { Authorization: `Bearer ${'t'.repeat(40)}` } })).status, 200);
    for (let i = 0; i < 10; i++) await fetch(base, { headers: { Authorization: 'Bearer wrong' } });
    assert.equal((await fetch(base, { headers: { Authorization: `Bearer ${'t'.repeat(40)}` } })).status, 429);
  } finally {
    server.close();
  }
});

test('spot book service parses Coinbase L2, caches, and surfaces errors', async () => {
  const { SpotBookService } = await import('../bot/marketdata/spotBook');
  let calls = 0;
  const fake = (async (url: string) => {
    calls++;
    if (String(url).includes('BAD-USD')) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify({ bids: [['64000.10', '0.5', 3], ['63999.00', 'x', 1]], asks: [['64000.50', '1.25', 2]] }), { status: 200 });
  }) as unknown as typeof fetch;
  const svc = new SpotBookService('https://example.test', 60_000, 50, fake);
  const b = await svc.get('btc');
  assert.equal(b.product, 'BTC-USD');
  assert.deepEqual(b.bids, [{ price: 64000.1, size: 0.5 }]);
  assert.deepEqual(b.asks, [{ price: 64000.5, size: 1.25 }]);
  await svc.get('BTC');
  assert.equal(calls, 1, 'cached');
  await assert.rejects(svc.get('BAD'), /404/);
});

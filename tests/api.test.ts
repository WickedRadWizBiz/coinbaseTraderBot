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

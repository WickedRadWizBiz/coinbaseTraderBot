// 429 handling: one shared back-off for every caller, no overlapping catalog refreshes, server-side close filter.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TokenBucket } from '../bot/kalshi/rateLimiter';
import { KalshiRest } from '../bot/kalshi/rest';

test('TokenBucket.rateLimited pauses every caller, doubling per consecutive 429 and resetting on success', () => {
  let t = 0;
  const b = new TokenBucket(200, 200, () => t);
  assert.ok(b.tryTake(10));
  assert.equal(b.rateLimited(), 1000);
  assert.equal(b.tryTake(10), false, 'paused');
  t = 999; assert.equal(b.tryTake(10), false);
  t = 1100; assert.ok(b.tryTake(10), 'refilled gradually after the pause');
  assert.equal(b.rateLimited(), 2000);
  assert.equal(b.rateLimited(), 4000);
  for (let i = 0; i < 10; i++) b.rateLimited();
  assert.equal(b.rateLimited(), 30_000, 'capped');
  b.ok();
  assert.equal(b.rateLimited(), 1000);
});

test('getOpenMarkets asks for open markets without close-time filters; a 429 pauses the shared read bucket', async () => {
  const urls: string[] = [];
  let calls = 0;
  const rest = new KalshiRest({
    baseUrl: 'https://x.test/trade-api/v2',
    fetchImpl: (async (u: string) => { urls.push(u); calls++; return calls === 1 ? new Response('{}', { status: 429 }) : new Response('{"markets":[]}', { status: 200 }); }) as unknown as typeof fetch,
  });
  const t0 = Date.now();
  await rest.getOpenMarkets('KXBTCD');
  assert.ok(urls[0].includes('status=open') && !urls[0].includes('close_ts'), urls[0]);
  assert.equal(calls, 2);
  assert.ok(Date.now() - t0 >= 900, 'waited out the pause before retrying');
});

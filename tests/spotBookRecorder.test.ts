import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpotBookRecorder, SpotBookService, spotBookLine, type SpotBook } from '../bot/marketdata/spotBook';

test('spot book recorder: every coin each round, top levels only, a coin Coinbase does not list is skipped for an hour', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.includes('HYPE-USD')) return new Response('not found', { status: 404 });
    const rows = (p0: number, step: number) => Array.from({ length: 30 }, (_, i) => [String(p0 + i * step), '1.5', 3]);
    return new Response(JSON.stringify({ bids: rows(100, -1), asks: rows(101, 1) }), { status: 200 });
  }) as unknown as typeof fetch;
  const lines: Array<Record<string, unknown>> = [];
  let now = 1_000_000;
  const rec = new SpotBookRecorder(() => ['BTC', 'HYPE'], (a, b: SpotBook) => lines.push(spotBookLine(a, b)), 15_000, new SpotBookService('https://x', 0, 10, fetchImpl), () => now);
  assert.equal(await rec.round(), 1);
  assert.equal(lines.length, 1);
  const l = lines[0] as { asset: string; b: number[][]; a: number[][] };
  assert.equal(l.asset, 'BTC');
  assert.equal(l.b.length, 10);
  assert.deepEqual(l.b[0], [100, 1.5]);
  assert.deepEqual(l.a[0], [101, 1.5]);
  // HYPE answered 404: not asked again within the hour, asked again after it.
  const before = calls.length;
  now += 60_000;
  await rec.round();
  assert.equal(calls.length - before, 1);
  now += 3_600_000;
  await rec.round();
  assert.ok(calls.slice(-2).some((u) => u.includes('HYPE-USD')));
});

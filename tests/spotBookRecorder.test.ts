import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpotBookRecorder, SpotBookService, bandDepth, spotBookLine, type SpotBook } from '../bot/marketdata/spotBook';

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

test('spot book bands: the whole book summed per band out from the mid, kept on the line beside the top levels', async () => {
  // Mid 100; 1-bps bands (0.01 wide); 30 levels a side, 0.01 apart, so the top 10 are kept but every band sees all.
  const rows = (p0: number, step: number) => Array.from({ length: 30 }, (_, i) => [String(p0 + i * step), '2', 1]);
  const fetchImpl = (async () => new Response(JSON.stringify({ bids: rows(99.995, -0.01), asks: rows(100.005, 0.01) }), { status: 200 })) as unknown as typeof fetch;
  const book = await new SpotBookService('https://x', 0, 10, fetchImpl, { bps: 1, n: 20 }).get('BTC');
  assert.equal(book.bids.length, 10);
  assert.equal(book.bands?.bids.length, 20);
  assert.deepEqual(book.bands?.bids.slice(0, 3), [2, 2, 2]);
  assert.equal(book.bands?.asks.reduce((s, v) => s + v, 0), 40); // 20 levels fall inside the 20 bands; the rest are past them
  const line = spotBookLine('BTC', book) as { bw: number; bb: number[]; ba: number[]; b: number[][] };
  assert.equal(line.bw, 1);
  assert.equal(line.bb.length, 20);
  assert.equal(line.b.length, 10);
  // Off by default (the dashboard's book): no bands, no band fields on the line.
  const plain = await new SpotBookService('https://x', 0, 10, fetchImpl).get('BTC');
  assert.equal(plain.bands, undefined);
  assert.equal('bw' in spotBookLine('BTC', plain), false);
  assert.equal(bandDepth([], [], 10, 10), undefined);
});

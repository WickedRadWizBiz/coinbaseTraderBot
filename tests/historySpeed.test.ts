import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readSeries, seriesPath, upsertSeries, writeSeries } from '../bot/marketdata/historyStore';
import { downloadKalshiHistory, storedMarkets } from '../research/history/kalshiHistory';

const bar = (ts: number, c: number, tb?: number) => ({ ts, o: c, h: c, l: c, c, v: 1, ...(tb !== undefined ? { tb } : {}) });

test('candle store: newer bars are appended in place; anything older or overlapping goes through the full merge', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-'));
  const file = seriesPath(dir, 'binance', 'BTC', '1m');
  writeSeries(file, [bar(60_000, 1, 0.5), bar(120_000, 2, 0.5)]);
  const before = fs.statSync(file).ino;
  assert.equal(upsertSeries(dir, 'binance', 'BTC', '1m', [bar(240_000, 4, 1), bar(180_000, 3)]), 4, 'out of order input is sorted');
  assert.equal(fs.statSync(file).ino, before, 'appended, not rewritten');
  assert.deepEqual(readSeries(file).map((c) => [c.ts, c.c, c.tb]), [[60_000, 1, 0.5], [120_000, 2, 0.5], [180_000, 3, undefined], [240_000, 4, 1]]);
  assert.equal(upsertSeries(dir, 'binance', 'BTC', '1m', [bar(120_000, 9), bar(300_000, 5)]), 5, 'an overlapping bar: merged');
  assert.deepEqual(readSeries(file).map((c) => c.c), [1, 9, 3, 4, 5]);
  // A series without the taker-buy column takes the full path when new bars carry it (the header changes).
  const f2 = seriesPath(dir, 'coinbase', 'ETH', '1h');
  writeSeries(f2, [bar(3_600_000, 1)]);
  upsertSeries(dir, 'coinbase', 'ETH', '1h', [bar(7_200_000, 2, 0.3)]);
  assert.equal(fs.readFileSync(f2, 'utf8').split('\n')[0], 'ts,o,h,l,c,v,tb');
  assert.deepEqual(readSeries(f2).map((c) => c.tb), [undefined, 0.3]);
});

test('kalshi stored-market index: only changed day files are read again; a market that failed keeps the listing from being marked complete', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-'));
  const s = path.join(dir, 'KXBTC15M');
  fs.mkdirSync(s);
  const line = (t: string, extra = '') => `{"ticker":"${t}","series":"KXBTC15M","openTime":1,"closeTime":2,"strike":1,"cap":null,"candles":[{"ts":1,"bidO":0.1,"bidH":null}]${extra}}`;
  fs.writeFileSync(path.join(s, '2026-10-01.jsonl'), `${line('A')}\n${line('B', ',"noVolume":true')}\n${line('C', ',"error":"HTTP 404 (both tiers)"')}\n`);
  let r = storedMarkets(s).rows;
  assert.deepEqual(r.map((x) => [x.ticker, x.noVolume ?? false, x.error ?? '']), [['A', false, ''], ['B', true, ''], ['C', false, 'HTTP 404 (both tiers)']]);
  fs.appendFileSync(path.join(s, '2026-10-01.jsonl'), `${line('D')}\n{"ticker":"torn`);
  r = storedMarkets(s).rows;
  assert.deepEqual(r.map((x) => x.ticker), ['A', 'B', 'C', 'D'], 'a changed file is read again; a torn last line is ignored');

  // A network failure on one market: it is not stored, and the next run must list it again.
  const now = Date.parse('2026-10-03T00:00:00Z');
  let fail = true;
  const mk = (t: string) => ({ ticker: t, open_time: '2026-09-20T00:00:00Z', close_time: '2026-09-20T00:15:00Z', floor_strike: 1, result: 'yes', volume_fp: '5' });
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' }) as unknown as Response;
    if (u.pathname.endsWith('/historical/cutoff')) return ok({});
    if (u.pathname.endsWith('/historical/markets')) return ok({ markets: [], cursor: '' });
    if (u.pathname.endsWith('/markets')) return ok({ markets: [mk('X1'), mk('X2')], cursor: '' });
    if (fail && u.pathname.includes('/X2/')) throw new Error('socket hang up');
    return ok({ candlesticks: [] });
  }) as unknown as typeof fetch;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-'));
  const a = await downloadKalshiHistory({ series: ['KXSOL15M'], days: 30, out, fetchImpl, now, log: () => {} });
  assert.deepEqual([a.markets, a.failed], [1, 1]);
  fail = false;
  const b = await downloadKalshiHistory({ series: ['KXSOL15M'], days: 30, out, fetchImpl, now, log: () => {} });
  assert.deepEqual([b.markets, b.skipped], [1, 1], 'the failed market (closed 13 days ago) is listed and fetched again');
  const c = await downloadKalshiHistory({ series: ['KXSOL15M'], days: 30, out, fetchImpl, now, log: () => {} });
  assert.deepEqual([c.markets, c.skipped], [0, 0], 'once every market is stored, the old days are not listed again');
});

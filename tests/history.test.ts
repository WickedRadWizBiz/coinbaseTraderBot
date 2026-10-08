// Historical candle store: CSV formats, validation, splicing, the clock-alignment check, the zip
// reader, the Binance Vision downloader and the Coinbase backfill (mocked network).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';
import type { Candle } from '../bot/ta/indicators';
import { assetsFromPerps, assetsFromSeries, normalizeAssets } from '../research/history/assets';
import { downloadBinance, parseChecksum } from '../research/history/binanceVision';
import { aggregateCandles, alignmentCheck, cleanAndValidate, loadSeries, readSeries, seriesPath, shiftCandles, spliceSources, upsertSeries } from '../research/history/candles';
import { backfillCoinbase } from '../research/history/coinbaseBackfill';
import { epochToMs, parseCandleCsv, parseTime, splitSymbol } from '../research/history/csvFormats';
import { importCsvText } from '../research/history/importCsv';
import { unzip } from '../research/history/zip';
import { tmpDir } from './helpers';

const H = 3_600_000;
const T0 = Date.UTC(2021, 0, 1);

/** Random-walk hourly candles (deterministic). */
function walk(n: number, start = T0, seed = 1, p0 = 30000): Candle[] {
  let s = seed, p = p0;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = p;
    p = p * Math.exp((r() - 0.5) * 0.02);
    out.push({ ts: start + i * H, o, h: Math.max(o, p) * 1.001, l: Math.min(o, p) * 0.999, c: p, v: 10 + r() * 5 });
  }
  return out;
}

/** Store-only ZIP (method 0) or deflate (method 8) with one entry. */
function makeZip(name: string, text: string, deflate = true): Buffer {
  const data = Buffer.from(text);
  const comp = deflate ? zlib.deflateRawSync(data) : data;
  const nameB = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameB.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(deflate ? 8 : 0, 10);
  central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameB.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameB.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameB.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameB, comp, central, nameB, eocd]);
}

const binanceCsv = (cs: Candle[], micro = false) => cs.map((c) => `${micro ? c.ts * 1000 : c.ts},${c.o},${c.h},${c.l},${c.c},${c.v},${c.ts + H - 1},0,0,0,0,0`).join('\n');

test('CSV formats: Binance (ms, microseconds, futures header), CryptoDataDownload, Yahoo, yfinance, Bittrex', () => {
  const cs = walk(30);
  const b = parseCandleCsv(binanceCsv(cs), 'BTCUSDT-1h-2021-01.csv');
  assert.equal(b.format, 'binance'); assert.equal(b.asset, 'BTC'); assert.equal(b.quote, 'USDT'); assert.equal(b.tf, '1h'); assert.equal(b.source, 'binance');
  assert.equal(b.candles[0].ts, T0); assert.equal(b.candles.length, 30);
  // 2025+ spot files: microseconds.
  assert.equal(parseCandleCsv(binanceCsv(cs, true), 'ETHUSDT-1h-2025-01.csv').candles[5].ts, cs[5].ts);
  const fut = parseCandleCsv(`open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n${binanceCsv(cs)}`, 'BTCUSDT-1h-2021-01.csv');
  assert.equal(fut.candles.length, 30);

  // CryptoDataDownload / Bittrex: banner, newest first, base-volume column, unix in seconds.
  const cdd = ['https://www.CryptoDataDownload.com', 'unix,date,symbol,open,high,low,close,Volume BTC,Volume USD',
    ...[...cs].reverse().map((c) => `${c.ts / 1000},${new Date(c.ts).toISOString().replace('T', ' ').slice(0, 19)},BTC/USD,${c.o},${c.h},${c.l},${c.c},${c.v},${c.v * c.c}`)].join('\n');
  const p = parseCandleCsv(cdd, 'Bittrex_BTCUSD_1h.csv');
  assert.equal(p.format, 'cdd'); assert.equal(p.source, 'bittrex'); assert.equal(p.asset, 'BTC'); assert.equal(p.tf, '1h');
  assert.equal(p.candles[0].ts, T0, 'sorted ascending');
  assert.equal(p.candles[3].v, cs[3].v, 'base volume, not quote volume');
  // Old CDD date format "2020-03-13 08-PM".
  assert.equal(parseTime('2020-03-13 08-PM'), Date.UTC(2020, 2, 13, 20));
  assert.equal(parseTime('2020-03-13 12-AM'), Date.UTC(2020, 2, 13, 0));

  const yahoo = ['Date,Open,High,Low,Close,Adj Close,Volume', '2021-01-01,29000,29600,28800,29374,29374,40730301359', '2021-01-02,29376,33155,29091,32127,32127,67865420765', '2021-01-03,32129,34608,32052,32782,32782,78665235202'].join('\n');
  const y = parseCandleCsv(yahoo, 'BTC-USD.csv');
  assert.equal(y.format, 'yahoo'); assert.equal(y.asset, 'BTC'); assert.equal(y.tf, '1d'); assert.equal(y.candles[0].ts, T0);
  // yfinance multi-row header.
  const yf = ['Price,Close,High,Low,Open,Volume', 'Ticker,ETH-USD,ETH-USD,ETH-USD,ETH-USD,ETH-USD', 'Date,,,,,', '2021-01-01 00:00:00+00:00,730,749,719,737,13652004358', '2021-01-01 01:00:00+00:00,735,740,730,731,1'].join('\n');
  const f = parseCandleCsv(yf, 'ETH-USD_1h.csv');
  assert.equal(f.candles.length, 2); assert.equal(f.candles[0].c, 730); assert.equal(f.candles[0].o, 737); assert.equal(f.asset, 'ETH');

  const bit = ['startsAt,open,high,low,close,volume,quoteVolume', '2021-01-01T00:00:00Z,1,2,0.5,1.5,10,15', '2021-01-01T01:00:00Z,1.5,2,1,1.2,11,13'].join('\n');
  const bx = parseCandleCsv(bit, 'XRP-USD_1h.csv');
  assert.equal(bx.format, 'bittrex'); assert.equal(bx.candles[1].ts, T0 + H);

  assert.deepEqual(splitSymbol('SOL/USDT'), { asset: 'SOL', quote: 'USDT' });
  assert.equal(splitSymbol('ETHBTC'), undefined, 'non-USD pairs are not split');
  assert.equal(epochToMs(1_600_000_000), 1_600_000_000_000);
});

test('validation drops impossible and duplicate bars and reports gaps and jumps', () => {
  const cs = walk(50);
  const bad = [...cs, { ...cs[3] }, { ts: T0 + 60 * H, o: 1, h: 0.5, l: 1, c: 1, v: 1 }];
  bad.splice(20, 5); // a 5-hour gap
  bad.push({ ts: T0 + 70 * H, o: cs[49].c, h: cs[49].c * 3, l: cs[49].c, c: cs[49].c * 2.5, v: 1 }); // jump
  const { candles, report } = cleanAndValidate(bad, '1h');
  assert.equal(report.dropped.duplicate, 1);
  assert.equal(report.dropped.invalid, 1);
  assert.ok(report.gaps.count >= 2 && report.gaps.longest[0].bars >= 5);
  assert.equal(report.jumps.length, 1);
  assert.ok(candles.every((c, i) => i === 0 || c.ts > candles[i - 1].ts));
});

test('aggregation keeps only complete aligned groups; splicing never mixes sources inside a better span', () => {
  const h = walk(30, T0 + 2 * H);
  const four = aggregateCandles(h, H, 4 * H);
  assert.equal(four[0].ts, T0 + 4 * H, 'the partial 00:00 group is dropped');
  assert.equal(four[0].o, h[2].o); assert.equal(four[0].c, h[5].c);
  const good = walk(100, T0 + 50 * H, 2);
  const other = walk(300, T0, 3);
  const s = spliceSources([{ source: 'bittrex', candles: other }, { source: 'binance', candles: good }]);
  const inSpan = s.candles.filter((c) => c.ts >= good[0].ts && c.ts <= good[99].ts);
  assert.ok(inSpan.every((c, i) => c === good[i]), 'binance keeps its whole span');
  assert.equal(s.candles.length, 300);
  assert.deepEqual(s.segments.map((x) => x.source), ['binance', 'bittrex']);
});

test('alignment check: a close-time stamped copy shows up as a one-bar shift', () => {
  const a = walk(600, T0, 5);
  assert.equal(alignmentCheck(a, a, '1h')!.bestShift, 0);
  const shifted = shiftCandles(a, '1h', 1); // stamped with close times
  const al = alignmentCheck(shifted, a, '1h')!;
  assert.equal(al.bestShift, -1);
  assert.equal(al.aligned, false);
});

test('import: merges into the store, refuses a shifted clock unless corrected', () => {
  const dir = tmpDir();
  const a = walk(600, T0, 7);
  const r1 = importCsvText(binanceCsv(a), 'BTCUSDT-1h-2021-01.csv', { out: dir });
  assert.ok(r1.ok, r1.error);
  assert.equal(readSeries(seriesPath(dir, 'binance', 'BTC', '1h')).length, 600);
  // A Bittrex copy stamped with close times (one hour late).
  const late = shiftCandles(a, '1h', 1);
  const cdd = ['https://www.CryptoDataDownload.com', 'unix,date,symbol,open,high,low,close,Volume BTC,Volume USD', ...late.map((c) => `${c.ts},x,BTC/USD,${c.o},${c.h},${c.l},${c.c},${c.v},0`)].join('\n');
  const r2 = importCsvText(cdd, 'Bittrex_BTCUSD_1h.csv', { out: dir });
  assert.equal(r2.ok, false);
  assert.match(r2.error!, /shift-bars 1|shifted by -1/);
  const r3 = importCsvText(cdd, 'Bittrex_BTCUSD_1h.csv', { out: dir, shiftBars: -1 });
  assert.ok(r3.ok, r3.error);
  assert.equal(r3.alignment?.bestShift, 0);
  // Re-importing is idempotent.
  assert.ok(importCsvText(binanceCsv(a), 'BTCUSDT-1h-2021-01.csv', { out: dir }).ok);
  assert.equal(readSeries(seriesPath(dir, 'binance', 'BTC', '1h')).length, 600);
  // Daily bars come from the hourly data when no daily file exists.
  assert.equal(loadSeries(dir, 'BTC', '1d').candles.length, 25);
});

test('zip reader: deflate and stored entries', () => {
  for (const deflate of [true, false]) {
    const e = unzip(makeZip('a.csv', 'hello,world\n', deflate));
    assert.equal(e[0].name, 'a.csv');
    assert.equal(e[0].data.toString(), 'hello,world\n');
  }
  assert.throws(() => unzip(Buffer.from('not a zip')), /not a zip/);
});

test('Binance Vision: lists, verifies checksums, imports, and skips archives it already has', async () => {
  const dir = tmpDir();
  const jan = walk(744, T0, 9), feb = walk(672, T0 + 744 * H, 10, jan[743].c), mar1 = walk(24, T0 + (744 + 672) * H, 11, feb[671].c);
  const files: Record<string, Buffer> = {
    'data/spot/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2021-01.zip': makeZip('BTCUSDT-1h-2021-01.csv', binanceCsv(jan)),
    'data/spot/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2021-02.zip': makeZip('BTCUSDT-1h-2021-02.csv', binanceCsv(feb)),
    'data/spot/daily/klines/BTCUSDT/1h/BTCUSDT-1h-2021-03-01.zip': makeZip('BTCUSDT-1h-2021-03-01.csv', binanceCsv(mar1, true)),
    // A daily archive for a month that already has a monthly archive: ignored.
    'data/spot/daily/klines/BTCUSDT/1h/BTCUSDT-1h-2021-02-01.zip': makeZip('x.csv', 'garbage'),
  };
  let badSum = false;
  const calls: string[] = [];
  const fetchImpl = (async (u: string | URL) => {
    const url = String(u);
    calls.push(url);
    if (url.includes('?delimiter=')) {
      const prefix = decodeURIComponent(/prefix=([^&]+)/.exec(url)![1]);
      const keys = Object.keys(files).filter((k) => k.startsWith(prefix));
      const xml = `<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key><Size>${files[k].length}</Size></Contents><Contents><Key>${k}.CHECKSUM</Key><Size>100</Size></Contents>`).join('')}</ListBucketResult>`;
      return new Response(xml);
    }
    const key = url.replace(/^https:\/\/[^/]+\/(data\.binance\.vision\/)?/, '');
    if (key.endsWith('.CHECKSUM')) {
      const z = files[key.slice(0, -9)];
      const sum = badSum && key.includes('2021-02') ? 'f'.repeat(64) : crypto.createHash('sha256').update(z).digest('hex');
      return new Response(`${sum}  ${path.basename(key.slice(0, -9))}\n`);
    }
    return files[key] ? new Response(new Uint8Array(files[key])) : new Response('nope', { status: 404 });
  }) as typeof fetch;
  const r = await downloadBinance({ out: dir, assets: ['BTC'], intervals: ['1h'], markets: ['spot'], fetchImpl, log: () => undefined });
  assert.equal(r[0].fetched, 3);
  assert.equal(r[0].failed, 0);
  const stored = readSeries(seriesPath(dir, 'binance', 'BTC', '1h'));
  assert.equal(stored.length, 744 + 672 + 24);
  assert.equal(stored[stored.length - 1].ts, mar1[23].ts, 'microsecond daily file parsed');
  // Second run: nothing new to fetch.
  calls.length = 0;
  const again = await downloadBinance({ out: dir, assets: ['BTC'], intervals: ['1h'], markets: ['spot'], fetchImpl, log: () => undefined });
  assert.equal(again[0].fetched, 0); assert.equal(again[0].skipped, 3);
  assert.ok(calls.every((c) => c.includes('?delimiter=')), 'only listings on the second run');
  // A checksum mismatch is refused.
  badSum = true;
  const dir2 = tmpDir();
  const r2 = await downloadBinance({ out: dir2, assets: ['BTC'], intervals: ['1h'], markets: ['spot'], fetchImpl, log: () => undefined });
  assert.equal(r2[0].failed, 1);
  assert.equal(parseChecksum('ABC'), undefined);
});

test('Coinbase backfill: walks back to the listing, then forward on the next run', async () => {
  const dir = tmpDir();
  const listing = T0, now = T0 + 2000 * H + 30 * 60_000;
  const all = walk(2000, listing, 12);
  let reqs = 0;
  const fetchImpl = (async (u: string | URL) => {
    reqs++;
    const q = new URL(String(u));
    const s = Date.parse(q.searchParams.get('start')!), e = Date.parse(q.searchParams.get('end')!);
    const rows = all.filter((c) => c.ts >= s && c.ts < e).reverse().map((c) => [c.ts / 1000, c.l, c.h, c.o, c.c, c.v]);
    return new Response(JSON.stringify(rows));
  }) as typeof fetch;
  const r = await backfillCoinbase({ out: dir, assets: ['ETH'], tfs: ['1h'], fromTs: T0 - 400 * 86_400_000, fetchImpl, delayMs: 0, now: () => now, log: () => undefined });
  const stored = readSeries(seriesPath(dir, 'coinbase', 'ETH', '1h'));
  assert.equal(stored.length, 2000);
  assert.equal(r[0].added, 2000);
  assert.ok(reqs < 20, `stopped after empty windows (${reqs} requests)`);
  upsertSeries(dir, 'coinbase', 'ETH', '1h', stored.slice(0, 1500));
  fs.writeFileSync(seriesPath(dir, 'coinbase', 'ETH', '1h'), `ts,o,h,l,c,v\n${stored.slice(0, 1500).map((c) => `${c.ts},${c.o},${c.h},${c.l},${c.c},${c.v}`).join('\n')}\n`);
  const r2 = await backfillCoinbase({ out: dir, assets: ['ETH'], tfs: ['1h'], fromTs: T0 - 400 * 86_400_000, fetchImpl, delayMs: 0, now: () => now, log: () => undefined });
  assert.equal(r2[0].added, 500, 'forward fill of the missing tail');
});

test('Coinbase backfill: an asset Coinbase does not sell is asked for once, not once per timeframe', async () => {
  const dir = tmpDir();
  let reqs = 0;
  const logs: string[] = [];
  const fetchImpl = (async () => { reqs++; return new Response('{"message":"NotFound"}', { status: 404 }); }) as unknown as typeof fetch;
  const r = await backfillCoinbase({ out: dir, assets: ['US500'], tfs: ['15m', '1h', '1d'], fromTs: T0 - 400 * 86_400_000, fetchImpl, delayMs: 0, now: () => T0, log: (m) => logs.push(m) });
  assert.equal(reqs, 1);
  assert.ok(r.every((s) => s.note === 'no US500-USD product on Coinbase' && s.stored === 0));
  assert.deepEqual(logs, ['US500: not sold on Coinbase (no US500-USD product), skipped']);
});

test('asset discovery from Kalshi listings', () => {
  assert.deepEqual(normalizeAssets(['TONH', 'TON', 'SILVER', 'SHIBA']), ['SHIB', 'TON'], 'folded against coins from the perps list too');
  assert.deepEqual(assetsFromSeries(['KXNEAR', 'KXNEARH', 'KXSOL15M', 'KXSOLE', 'KXTONH', 'KXRIPPLE', 'KXSHIBA', 'KXSILVER', 'KXPLATINUM', 'KXPALLADIUM', 'KXUS500', 'KXETH', 'KXETHD'].map((ticker) => ({ ticker }))),
    ['ETH', 'NEAR', 'SHIB', 'SOL', 'TONH', 'XRP'], 'frequency letters folded (NEARH, SOLE; TONH stays without a TON listing), names mapped (RIPPLE, SHIBA), metals and indices dropped; ETH untouched');
  assert.deepEqual(assetsFromSeries([{ ticker: 'KXBTC15M' }, { ticker: 'KXETHD', frequency: 'hourly' }, { ticker: 'KXSOL' }, { ticker: 'KXBTCMAXY', frequency: 'annual' }, { ticker: 'KXHYPE15M', frequency: 'fifteen_min' }]), ['BTC', 'ETH', 'HYPE', 'SOL']);
  assert.deepEqual(assetsFromPerps([{ ticker: 'KXBTCPERP' }, { ticker: 'ETH-PERP' }, { ticker: 'X', title: 'Solana Perpetual' }, { underlying: 'DOGE' }]), ['BTC', 'DOGE', 'ETH', 'SOL']);
});

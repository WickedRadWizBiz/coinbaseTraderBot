// Dominance and index series: TradingView exports filed as index series (never as coins), index
// splicing with level calibration and partial-day aggregation, Binance's BTCDOM index klines, the
// live BTCDOM reconstruction, and the bot's hourly index bars written to and read back from the store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BtcDomIndex } from '../bot/marketdata/dominance';
import { IndexBars, IndexStore } from '../bot/marketdata/indexBars';
import type { Candle } from '../bot/ta/indicators';
import { downloadBinance } from '../research/history/binanceVision';
import { compareIndexSources } from '../bot/marketdata/historyStore';
import { aggregateIndex, loadIndexSeries, readSeries, seriesPath, storedAssets, storedIndexAssets, upsertSeries } from '../research/history/candles';
import { tradingViewIndexFromName } from '../research/history/csvFormats';
import { importCsvText } from '../research/history/importCsv';
import { tmpDir } from './helpers';

const H = 3_600_000, DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const bar = (ts: number, c: number): Candle => ({ ts, o: c, h: c * 1.001, l: c * 0.999, c, v: 0 });

test('TradingView exports: dominance charts are index series, never coins', () => {
  assert.deepEqual(tradingViewIndexFromName('CRYPTOCAP_BTC.D, 1D.csv'), { asset: 'BTC.D', tf: '1d' });
  assert.deepEqual(tradingViewIndexFromName('CRYPTOCAP_USDT.D, 60.csv'), { asset: 'USDT.D', tf: '1h' });
  assert.deepEqual(tradingViewIndexFromName('CRYPTOCAP_TOTAL3, 240_ab12c.csv'), { asset: 'TOTAL3', tf: '4h' });
  assert.deepEqual(tradingViewIndexFromName('CRYPTOCAP_OTHERS.D_1h.csv'), { asset: 'OTHERS.D', tf: '1h' }, 'tv_dominance.py naming: ".D" is not "daily"');
  assert.equal(tradingViewIndexFromName('BTCUSDT-1h-2021-03.csv'), undefined);
  const dir = tmpDir();
  upsertSeries(dir, 'binance', 'BTC', '1h', Array.from({ length: 30 }, (_, i) => bar(T0 + i * H, 100 + i)));
  const csv = ['time,open,high,low,close,volume', ...Array.from({ length: 40 }, (_, i) => `${(T0 + i * DAY) / 1000},5.${i},5.${i}5,5.${i},5.${i}2,0`)].join('\n');
  const r = importCsvText(csv, 'CRYPTOCAP_USDT.D_1d.csv', { out: dir });
  assert.ok(r.ok, r.error);
  assert.equal(r.source, 'tradingview');
  assert.equal(r.asset, 'USDT.D');
  assert.ok(!r.notes.some((n) => /quote currency/.test(n)));
  assert.deepEqual(storedAssets(dir), ['BTC'], 'not a coin to train on');
  assert.deepEqual(storedIndexAssets(dir), ['USDT.D']);
});

test('index series: partial days allowed, sources spliced and level-calibrated at the seam', () => {
  // A day with 13 of 24 hourly bars counts; one with 6 does not.
  const hours = [...Array.from({ length: 13 }, (_, i) => bar(T0 + i * H, 5 + i * 0.01)), ...Array.from({ length: 6 }, (_, i) => bar(T0 + DAY + i * H, 6))];
  const days = aggregateIndex(hours, H, DAY);
  assert.equal(days.length, 1);
  assert.equal(days[0].c, hours[12].c);
  const dir = tmpDir();
  // TradingView's daily USDT.D up to day 20; the bot's own hourly bars from day 15 on, 2% lower (CoinGecko vs TradingView).
  upsertSeries(dir, 'tradingview', 'USDT.D', '1d', Array.from({ length: 21 }, (_, i) => bar(T0 + i * DAY, 5 + i * 0.01)));
  const botHours: Candle[] = [];
  for (let d = 15; d < 30; d++) for (let h = 0; h < 24; h++) botHours.push(bar(T0 + d * DAY + h * H, (5 + d * 0.01) * 0.98));
  upsertSeries(dir, 'bot-index', 'USDT.D', '1h', botHours);
  const s = loadIndexSeries(dir, 'USDT.D', '1d');
  assert.ok(Math.abs(s.scale['bot-index'] - 1 / 0.98) < 1e-9, `scale ${s.scale['bot-index']}`);
  assert.deepEqual(s.segments.map((x) => x.source), ['tradingview', 'bot-index']);
  assert.equal(s.candles.length, 30);
  const after = s.candles.find((c) => c.ts === T0 + 25 * DAY)!;
  assert.ok(Math.abs(after.c - (5 + 25 * 0.01)) < 1e-9, 'bot bars continue at TradingView\'s level');
  // The pipeline's check of the live BTCDOM rebuild against Binance's index: same moves, 0.5% level offset.
  let p = 5000;
  const ref = Array.from({ length: 100 }, (_, i) => { p *= 1 + 0.003 * Math.sin(i * 1.7); return bar(T0 + i * H, p); });
  upsertSeries(dir, 'binance-index', 'BTCDOM', '1h', ref);
  upsertSeries(dir, 'bot-index', 'BTCDOM', '1h', ref.slice(40).map((c) => bar(c.ts, c.c * 0.995)));
  const chk = compareIndexSources(dir, 'BTCDOM', 'binance-index', 'bot-index');
  assert.equal(chk.overlap, 60);
  assert.ok(chk.returnCorr > 0.999 && Math.abs(chk.levelRatio - 1 / 0.995) < 1e-9, JSON.stringify(chk));
});

test('Binance index klines: BTCDOM comes from indexPriceKlines, stored as an index series', async () => {
  const dir = tmpDir();
  const urls: string[] = [];
  const rows = Array.from({ length: 24 }, (_, i) => `${T0 + i * H},${1000 + i},${1001 + i},${999 + i},${1000.5 + i},0,${T0 + (i + 1) * H - 1},0,3600,0,0,0`);
  const csv = Buffer.from(['open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore', ...rows].join('\n'));
  const zip = makeZip('BTCDOMUSDT-1h-2026-01-01.csv', csv);
  const fetchImpl = (async (u: string | URL) => {
    const url = String(u);
    urls.push(url);
    if (url.includes('?delimiter')) {
      const key = url.includes('daily') ? 'data/futures/um/daily/indexPriceKlines/BTCDOMUSDT/1h/BTCDOMUSDT-1h-2026-01-01.zip' : '';
      return new Response(`<ListBucketResult>${key ? `<Contents><Key>${key}</Key><Size>${zip.length}</Size></Contents>` : ''}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    }
    if (url.endsWith('.CHECKSUM')) return new Response('', { status: 404 });
    return new Response(zip);
  }) as typeof fetch;
  const res = await downloadBinance({ out: dir, assets: ['BTCDOM'], intervals: ['1h'], markets: ['um-index'], fetchImpl, log: () => undefined });
  assert.equal(res[0].fetched, 1, JSON.stringify(res));
  assert.ok(urls.some((u) => u.includes('indexPriceKlines')) && !urls.some((u) => /\/klines\//.test(u)));
  const stored = readSeries(seriesPath(dir, 'binance-index', 'BTCDOM', '1h'));
  assert.equal(stored.length, 24);
  assert.equal(stored[0].tb, undefined, 'index klines carry no taker volume');
  assert.deepEqual(storedAssets(dir), []);
});

test('live BTCDOM: BTC priced in the top alts, cap-weighted, no jump at rebalances', () => {
  const caps = [
    { symbol: 'btc', price: 100_000, marketCap: 2e12 }, { symbol: 'usdt', price: 1, marketCap: 1.5e11 }, { symbol: 'steth', price: 3000, marketCap: 3e10 },
    { symbol: 'eth', price: 3000, marketCap: 4e11 }, { symbol: 'xrp', price: 2, marketCap: 1.2e11 }, { symbol: 'sol', price: 150, marketCap: 8e10 },
    { symbol: 'doge', price: 0.2, marketCap: 3e10 }, { symbol: 'ada', price: 0.5, marketCap: 2e10 }, { symbol: 'link', price: 15, marketCap: 1e10 },
  ];
  const live = (btc: number, altMult = 1) => new Map<string, number>([['BTC', btc], ['ETH', 3000 * altMult], ['XRP', 2 * altMult], ['SOL', 150 * altMult], ['DOGE', 0.2 * altMult], ['ADA', 0.5 * altMult], ['LINK', 15 * altMult], ['STETH', 3000]]);
  const idx = new BtcDomIndex();
  idx.setAnchor(5000);
  assert.equal(idx.update(live(100_000), T0), undefined, 'no caps yet');
  idx.setCaps(caps, live(100_000));
  assert.ok(Math.abs(idx.update(live(100_000), T0)! - 5000) < 1e-9, 'continues from the stored level');
  // BTC +10% while alts are flat: BTC/alt ratios all +10% -> the index +10%.
  assert.ok(Math.abs(idx.update(live(110_000), T0 + H)! - 5500) < 1e-6);
  // Alts +10% while BTC is flat: the index falls.
  assert.ok(idx.update(live(110_000, 1.1), T0 + 2 * H)! < 5500);
  // The next day rebalances to fresh caps: the level is continuous.
  const before = idx.update(live(110_000, 1.1), T0 + DAY - 1)!;
  idx.setCaps(caps.map((c) => (c.symbol === 'eth' ? { ...c, marketCap: 6e11 } : c)), live(110_000, 1.1));
  const after = idx.update(live(110_000, 1.1), T0 + DAY)!;
  assert.ok(Math.abs(after - before) < 1e-6, `rebalance jumped: ${before} -> ${after}`);
  // Stablecoins and staked tokens are not constituents: moving stETH alone changes nothing.
  const m = live(110_000, 1.1); m.set('STETH', 9999);
  assert.ok(Math.abs(idx.update(m, T0 + DAY + H)! - after) < 1e-6);
});

test('live index bars: hourly OHLC written to the store when the hour ends, read back by the index store', () => {
  const dir = tmpDir();
  const bars = new IndexBars(dir);
  const closed: string[] = [];
  const store = new IndexStore(dir);
  bars.onClose = (a) => { closed.push(a); store.invalidate(); };
  for (let k = 0; k < 120; k++) { const ts = T0 + k * 30_000; bars.add('BTCDOM', 5000 + k, ts); bars.add('USDT.D', 5 - k * 0.001, ts); }
  assert.equal(closed.length, 0, 'still inside the first hour');
  bars.add('BTCDOM', 6000, T0 + H + 1000);
  assert.deepEqual(closed, ['BTCDOM']);
  bars.flush(T0 + H + 60_000);
  assert.deepEqual(closed.sort(), ['BTCDOM', 'USDT.D']);
  const b = readSeries(seriesPath(dir, 'bot-index', 'BTCDOM', '1h'))[0];
  assert.deepEqual([b.ts, b.o, b.h, b.l, b.c], [T0, 5000, 5119, 5000, 5119]);
  assert.equal(IndexBars.lastStored(dir, 'BTCDOM'), 5119);
  assert.equal(store.get('BTCDOM', '1h')?.length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'bot-index', 'USDT.D', '1h.csv')));
  bars.add('BTC.D', undefined, T0);
  bars.add('BTC.D', NaN, T0);
  assert.equal(fs.existsSync(path.join(dir, 'bot-index', 'BTC.D')), false, 'no value, no bar');
});

/** Minimal stored (uncompressed) zip with one file. */
function makeZip(name: string, data: Buffer): Buffer {
  const crc = crc32(data);
  const nm = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nm.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nm.length, 28);
  const offCentral = local.length + nm.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nm.length, 12); end.writeUInt32LE(offCentral, 16);
  return Buffer.concat([local, nm, data, central, nm, end]);
}
function crc32(b: Buffer): number {
  let c = ~0;
  for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}

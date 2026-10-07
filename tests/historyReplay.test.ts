import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { aggregate, barPath, buildHistoryReplay } from '../research/history/historyReplay';
import { readRecordings, ReplayState } from '../research/replay';
import { buildPerpDataset } from '../research/trainPerpModel';
import { tmpDir } from './helpers';

const D0 = Date.parse('2026-03-01T00:00:00Z');
const MIN = 60_000;

/** Synthetic history: 1-minute spot and perp bars for 4 days (plus 2 days before), stored higher timeframes,
 *  funding, and one Kalshi 15-minute contract per hour on the replayed days. */
function writeHistory(dir: string) {
  let x = 60000, seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 - 0.5; };
  const spot: string[] = ['ts,o,h,l,c,v'], perp: string[] = ['ts,o,h,l,c,v'];
  const bars: Array<{ ts: number; o: number; h: number; l: number; c: number; v: number }> = [];
  for (let t = D0 - 2 * 86_400_000; t < D0 + 4 * 86_400_000; t += MIN) {
    const o = x; x *= Math.exp(0.0008 * rnd()); const c = x; const h = Math.max(o, c) * 1.0002, l = Math.min(o, c) * 0.9998;
    bars.push({ ts: t, o, h, l, c, v: 1 });
    spot.push(`${t},${o},${h},${l},${c},1`); perp.push(`${t},${o * 1.0003},${h * 1.0003},${l * 1.0003},${c * 1.0003},1`);
  }
  const put = (src: string, tf: string, lines: string[]) => { fs.mkdirSync(path.join(dir, src, 'BTC'), { recursive: true }); fs.writeFileSync(path.join(dir, src, 'BTC', `${tf}.csv`), lines.join('\n') + '\n'); };
  put('binance-1m', '1m', spot); put('binance-um', '1m', perp);
  for (const [tf, ms] of [['15m', 15 * MIN], ['1h', 60 * MIN], ['1d', 86_400_000]] as const) put('binance', tf, ['ts,o,h,l,c,v', ...aggregate(bars, ms).map((c) => `${c.ts},${c.o},${c.h},${c.l},${c.c},${c.v}`)]);
  fs.mkdirSync(path.join(dir, 'binance-funding', 'BTC'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'binance-funding', 'BTC', 'funding.csv'), `ts,rate\n${D0 - 8 * 3_600_000},0.0001\n${D0 + 8 * 3_600_000},-0.0002\n`);
  fs.mkdirSync(path.join(dir, 'kalshi', 'KXBTC15M'), { recursive: true });
  const ms: string[] = [];
  for (let h = 0; h < 24; h++) {
    const open = D0 + h * 3_600_000, close = open + 15 * MIN;
    const at = (t: number) => bars.find((b) => b.ts === t)!;
    const strike = at(open - MIN).c * 1.0004; // Kalshi's index runs 4 bp above Binance
    const candles = Array.from({ length: 15 }, (_, i) => ({ ts: open + (i + 1) * MIN, bidC: 0.45, askC: 0.48, last: 0.46, volume: 3 }));
    ms.push(JSON.stringify({ ticker: `KXBTC15M-T${h}`, series: 'KXBTC15M', openTime: open, closeTime: close, strike, cap: null, result: at(close - MIN).c * 1.0004 >= strike ? 'yes' : 'no', candles }));
  }
  fs.writeFileSync(path.join(dir, 'kalshi', 'KXBTC15M', '2026-03-01.jsonl'), ms.join('\n') + '\n');
}

test('history replay: bar paths and aggregation', () => {
  assert.deepEqual(barPath({ o: 10, h: 12, l: 9, c: 11 }).map((p) => p[1]), [10, 9, 12, 11], 'up bar: low before high');
  assert.deepEqual(barPath({ o: 10, h: 12, l: 9, c: 9.5 }).map((p) => p[1]), [10, 12, 9, 9.5]);
  const bars = Array.from({ length: 12 }, (_, i) => ({ ts: D0 + i * MIN, o: i, h: i + 1, l: i - 1, c: i + 0.5, v: 1 }));
  const five = aggregate(bars, 5 * MIN);
  assert.equal(five.length, 2, 'the incomplete third group is dropped');
  assert.deepEqual([five[0].o, five[0].h, five[0].l, five[0].c, five[0].v], [0, 5, -1, 4.5, 5]);
});

test('history replay: day files the replay reads like live recordings; the perps dataset trains on them', async () => {
  const hist = tmpDir(), out = path.join(tmpDir(), 'replay');
  writeHistory(hist);
  const r = await buildHistoryReplay({ historyDir: hist, outDir: out, assets: ['BTC', 'ETH'], fromDay: '2026-03-01', toDay: '2026-03-04', perpSpecs: { BTC: { ticker: 'KXBTCPERP', tickSize: 0.5, halfSpreadBps: 2 } }, log: () => {} });
  assert.equal(r.written, 4);
  assert.match(r.notes.join(' '), /ETH: no 1-minute spot history/);
  const again = await buildHistoryReplay({ historyDir: hist, outDir: out, assets: ['BTC'], fromDay: '2026-03-01', toDay: '2026-03-04', log: () => {} });
  assert.equal(again.skipped, 4, 'built days are not rebuilt');

  const st = new ReplayState();
  let last = 0, perps = 0, results = 0, books = 0;
  let firstPerp: any;
  for await (const e of readRecordings(out)) {
    assert.ok(e.t >= last, 'time order across days');
    last = e.t;
    st.apply(e);
    if (e.k === 'perp') { perps++; firstPerp ??= e; }
    if (e.k === 'result') results++;
    if (e.k === 'book') books++;
  }
  assert.equal(results, 24);
  assert.ok(books >= 24 * 14);
  assert.equal(firstPerp.ticker, 'KXBTCPERP');
  assert.ok(firstPerp.ask > firstPerp.bid && firstPerp.bid % 0.5 === 0, 'quoted at the spread, on the tick');
  assert.equal(firstPerp.fundingRate, 0.0001);
  assert.ok(st.index.get('BTC')!.vol(), 'four prints a minute: the index volatility estimator runs');
  const tfs = st.features.candles.get('BTC');
  assert.ok(tfs, 'candles reach the feature hub');
  // The basis: index prints sit ~4 bp above Binance once a contract has opened.
  const idx = st.index.get('BTC')!.latest()!.value, spot = st.spot.get('BTC')!.latest()!.value;
  assert.ok(Math.abs(idx / spot - 1.0004) < 1e-6, `basis ${idx / spot}`);

  const rows = await buildPerpDataset(out, { everySec: 600, horizonMin: 60 });
  assert.ok(rows.length > 300, `perp rows ${rows.length}`);
  assert.ok(rows.every((x) => Number.isFinite(x.y)));
});

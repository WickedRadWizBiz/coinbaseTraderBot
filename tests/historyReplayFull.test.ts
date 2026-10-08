import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { test } from 'node:test';
import { aggregate, buildHistoryReplay, csvRange, historyStart, replayPerpDays } from '../research/history/historyReplay';
import { anchorsIn, dominanceAnchors, DominanceReplay, DOM_BLEND_MS, DOM_MAX_STALE_MS } from '../research/history/dominanceReplay';
import { readRecordings, ReplayState, type RecEvent } from '../research/replay';
import { assetFeatureMap } from '../bot/model/featureEngine';
import { upsertSeries } from '../bot/marketdata/historyStore';
import { buildPerpDataset, type PerpRow } from '../research/trainPerpModel';
import { PERP_FEATURES, perpFeatures } from '../bot/perps/perpSignal';
import { parseMetricsCsv } from '../research/history/binanceVision';
import { eraDays } from '../research/snnPbt';
import { tmpDir } from './helpers';

const MIN = 60_000, H = 3_600_000, DAY = 86_400_000;
const D0 = Date.parse('2026-03-01T00:00:00Z');
const bar = (ts: number, c: number) => ({ ts, o: c, h: c, l: c, c, v: 0 });

/** 1-minute spot and perp bars of BTC and ETH over [from, to), appended to what is stored. */
function writeBars(dir: string, from: number, to: number) {
  for (const [a, p0, k] of [['BTC', 60000, 0.0008], ['ETH', 3000, 0.0011]] as const) {
    let x = p0, seed = a === 'BTC' ? 7 : 11;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 - 0.5; };
    const bars: Array<{ ts: number; o: number; h: number; l: number; c: number; v: number }> = [];
    for (let t = D0 - 2 * DAY; t < to; t += MIN) {
      const o = x; x *= Math.exp(k * rnd()); const c = x;
      if (t >= from) bars.push({ ts: t, o, h: Math.max(o, c) * 1.0002, l: Math.min(o, c) * 0.9998, c, v: 1 });
    }
    for (const src of ['binance-1m', 'binance-um']) {
      const f = path.join(dir, src, a, '1m.csv');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : 'ts,o,h,l,c,v\n';
      const m = src === 'binance-um' ? 1.0003 : 1;
      fs.writeFileSync(f, old + bars.map((b) => `${b.ts},${b.o * m},${b.h * m},${b.l * m},${b.c * m},1`).join('\n') + '\n');
    }
    if (from === D0 - 2 * DAY) for (const [tf, ms] of [['15m', 15 * MIN], ['1h', H], ['1d', DAY]] as const) {
      fs.mkdirSync(path.join(dir, 'binance', a), { recursive: true });
      fs.writeFileSync(path.join(dir, 'binance', a, `${tf}.csv`), ['ts,o,h,l,c,v', ...aggregate(bars, ms).map((c) => `${c.ts},${c.o},${c.h},${c.l},${c.c},${c.v}`)].join('\n') + '\n');
    }
  }
}

/** TradingView BTC.D / USDT.D: daily from ten days before the history, hourly from `hourlyFrom`. */
function writeDominance(dir: string, hourlyFrom: number, to: number) {
  let b = 55, u = 4.6, seed = 5;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 - 0.5; };
  const hb: ReturnType<typeof bar>[] = [], hu: ReturnType<typeof bar>[] = [];
  for (let t = D0 - 12 * DAY; t < to; t += H) { b *= 1 + 0.002 * rnd(); u *= 1 + 0.003 * rnd(); hb.push(bar(t, b)); hu.push(bar(t, u)); }
  const daily = (hs: ReturnType<typeof bar>[]) => { const out: ReturnType<typeof bar>[] = []; for (let i = 0; i < hs.length; i += 24) out.push(bar(hs[i].ts, hs[Math.min(i + 23, hs.length - 1)].c)); return out; };
  upsertSeries(dir, 'tradingview', 'BTC.D', '1d', daily(hb));
  upsertSeries(dir, 'tradingview', 'USDT.D', '1d', daily(hu));
  upsertSeries(dir, 'tradingview', 'BTC.D', '1h', hb.filter((x) => x.ts >= hourlyFrom));
  upsertSeries(dir, 'tradingview', 'USDT.D', '1h', hu.filter((x) => x.ts >= hourlyFrom));
}

test('dominance: real readings at the finest timeframe from their close on, moved by prices, seams closed over an hour', () => {
  const dir = tmpDir();
  upsertSeries(dir, 'tradingview', 'BTC.D', '1d', [bar(D0 - DAY, 50), bar(D0, 52), bar(D0 + DAY, 53)]);
  upsertSeries(dir, 'tradingview', 'BTC.D', '1h', [bar(D0 + DAY + 5 * H, 53.5)]);
  upsertSeries(dir, 'tradingview', 'USDT.D', '1d', [bar(D0 - DAY, 5)]);
  const A = dominanceAnchors(dir);
  // Daily closes at their bar's end; the day with an hourly bar keeps only the hourly reading (the daily
  // bar the store builds from it would claim the 05:00 value at midnight).
  assert.deepEqual(A.map((a) => [(a.t - D0) / H, a.btcd]), [[0, 50], [24, 52], [30, 53.5]]);
  assert.deepEqual(A.map((a) => a.usdtd), [5, 5, null], 'USDT.D only where its series is within 26 hours');
  assert.equal(anchorsIn(A, D0 - 1, D0 + DAY), 2);

  const dom = new DominanceReplay(A);
  assert.equal(dom.at(D0 - MIN, { BTC: 100 }), undefined, 'nothing before the first reading');
  assert.equal(dom.at(D0, { ETH: 10 }), undefined, 'nothing without BTC\'s price');
  const v0 = dom.at(D0, { BTC: 100, ETH: 10 })!;
  assert.ok(Math.abs(v0.btcd - 50) < 1e-9 && Math.abs(v0.usdtd! - 5) < 1e-9, 'the reading itself at its close');
  // BTC +10% while the alts stay: BTC's cap 0.5 * 1.1 of a total 1 + 0.05 -> BTC.D 52.38%, USDT.D 4.76%.
  const up = dom.at(D0 + H, { BTC: 110, ETH: 10 })!;
  assert.ok(Math.abs(up.btcd - 55 / 1.05) < 1e-9, `${up.btcd}`);
  assert.ok(Math.abs(up.usdtd! - 5 / 1.05) < 1e-9, 'USDT.D falls when crypto rises');
  // Everything +10%: BTC.D barely moves (USDT's share shrinks), USDT.D falls.
  const all = dom.at(D0 + 2 * H, { BTC: 110, ETH: 11 })!;
  assert.ok(Math.abs(all.btcd - 55 / 1.095) < 1e-9 && Math.abs(all.usdtd! - 5 / 1.095) < 1e-9);
  // The next reading (52 at D0 + 1 day) lands where the moved value is not: no step, the gap closed over an hour.
  const before = dom.at(D0 + DAY - 1000, { BTC: 110, ETH: 11 })!;
  const seam = dom.at(D0 + DAY, { BTC: 110, ETH: 11 })!;
  assert.ok(Math.abs(seam.btcd - before.btcd) < 1e-9, 'continuous at the new reading');
  const half = dom.at(D0 + DAY + DOM_BLEND_MS / 2, { BTC: 110, ETH: 11 })!;
  assert.ok(Math.abs(half.btcd - Math.sqrt(before.btcd * 52)) < 1e-6, 'halfway (geometrically) after half an hour');
  const done = dom.at(D0 + DAY + DOM_BLEND_MS, { BTC: 110, ETH: 11 })!;
  assert.ok(Math.abs(done.btcd - 52) < 1e-9, 'the new reading after an hour');
  assert.ok(dom.at(D0 + DAY + 5 * H, { BTC: 110, ETH: 11 })!.usdtd !== null);
  assert.ok(dom.at(D0 + DAY + 6 * H, { BTC: 110, ETH: 11 })!.usdtd === null, 'the 06:00 reading has no USDT.D near it: none made up');
  assert.equal(dom.at(D0 + DAY + 6 * H + DOM_MAX_STALE_MS + MIN, { BTC: 110 }), undefined, 'a reading 2.5 days old is too old');
});

test('history replay from the first day of history: dominance records, and the reader fills the seconds as live data would', async () => {
  const hist = tmpDir(), out = path.join(tmpDir(), 'replay');
  writeBars(hist, D0 - 2 * DAY, D0 + 2 * DAY);
  writeDominance(hist, D0 + DAY, D0 + 2 * DAY);
  assert.equal(historyStart(hist, ['BTC', 'ETH', 'SOL']), '2026-02-27');
  const r = await buildHistoryReplay({ historyDir: hist, outDir: out, assets: ['BTC', 'ETH'], fromDay: historyStart(hist, ['BTC', 'ETH'])!, toDay: '2026-03-02', log: () => {} });
  assert.equal(r.written, 4);
  assert.equal(r.dominance, 4 * 1440 * 4, 'BTC.D / USDT.D at every print');
  assert.deepEqual(replayPerpDays(out), ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);

  const st = new ReplayState();
  let doms = 0, checked = 0, held = 0, bridged = 0, settled = 0;
  let lastPrint: { t: number; v: number } | undefined, lastDom: RecEvent | undefined;
  for await (const e of readRecordings(out)) {
    st.apply(e);
    const idx = st.index.get('BTC');
    if (e.k === 'dominance') { doms++; assert.equal(e.hist, 1); assert.ok(e.btcd > 40 && e.btcd < 70 && e.usdtd > 3 && e.usdtd < 7); lastDom = e; }
    // Off the print grid the series hold their last print: nothing from the coming print is known early.
    if (e.k === 'result' && lastPrint && idx && e.t % 15_000 !== 0) {
      const p = idx.latest()!;
      assert.equal(p.value, lastPrint.v);
      assert.ok(p.ts > lastPrint.t && p.ts <= e.t, 'held through the second marks up to now');
      held++;
    }
    if (e.k === 'index' && e.asset === 'BTC') {
      // When the next print comes, the seconds in between were bridged toward it.
      if (lastPrint && e.t - lastPrint.t === 15_000) {
        const s = idx!.series(e.t, 15, 5000)!;
        assert.equal(s.length, 16);
        assert.ok(s.slice(1, -1).some((v) => v !== lastPrint!.v && v !== e.value), 'the seconds between prints move');
        bridged++;
      }
      lastPrint = { t: e.t, v: e.value };
    }
    if (e.tie || e.t < D0 + DAY + 6 * H || e.t % (30 * MIN) !== 0) continue;
    // The live features read one value a second: price paths, Kalshi's 60 s settlement marks, dominance.
    const f = assetFeatureMap('ETH', st.now, { index: st.index.get('ETH'), spot: st.spot.get('ETH'), bars: st.features.bars.get('ETH'), candles: st.features.candles.get('ETH'), usdtd: st.usdtd, btcd: st.btcd, perp: st.features.perps.get('ETH') });
    for (const k of ['ret_10s_z', 'ret_60s_z', 'rsi_60', 'kaufman_er_120', 'macd_hist_z', 'usdtd_ret_5m_z', 'usdtd_ret_15m_z', 'usdtd_level_dev_1h', 'btcd_ret_15m_z', 'btcd_rel_5m_z', 'conf_macro_pair']) assert.ok(Number.isFinite(f[k]), `${k} at ${new Date(st.now).toISOString()}`);
    if (st.index.get('ETH')!.settlement(st.now, st.now)) settled++;
    checked++;
  }
  assert.equal(doms, r.dominance);
  assert.ok(lastDom && checked >= 30 && settled === checked, `checked ${checked}, settlement averages ${settled}`);
  assert.ok(held > 50 && bridged > 20000, `held ${held}, bridged ${bridged}`);
  // Live recordings (no hist mark) are left as recorded: prints 15 s apart stay 15 s apart.
  const rec = tmpDir();
  fs.writeFileSync(path.join(rec, 'md-2026-03-01.jsonl'), Array.from({ length: 40 }, (_, i) => JSON.stringify({ t: D0 + i * 15_000, k: 'index', asset: 'BTC', value: 60000 + i, ts: D0 + i * 15_000 })).join('\n') + '\n');
  const live = new ReplayState();
  for await (const e of readRecordings(rec)) live.apply(e);
  assert.equal(live.index.get('BTC')!.series(live.now, 60, 5000), undefined);
});

test('history replay: a day built before its data arrived is built again, an empty day is not, a late input resumes from a month end', async () => {
  const hist = tmpDir(), a = path.join(tmpDir(), 'a');
  writeBars(hist, D0 - 2 * DAY, D0 + DAY);
  writeDominance(hist, D0 + 4 * DAY, D0 + 4 * DAY);
  const opts = { historyDir: hist, assets: ['BTC', 'ETH'], fromDay: '2026-02-27', log: () => {} };
  const first = await buildHistoryReplay({ ...opts, outDir: a, toDay: '2026-03-03' });
  const manifest = () => JSON.parse(fs.readFileSync(path.join(a, 'replay-manifest.json'), 'utf8'));
  // 03-02 holds only the last bar's close carried over midnight; 03-03 has nothing: recorded, no file.
  assert.equal(first.written, 4);
  assert.ok(manifest().n['2026-03-02'] < 20 && manifest().n['2026-03-03'] === 0);
  assert.ok(!fs.existsSync(path.join(a, 'md-2026-03-03.jsonl.gz')));
  assert.equal((await buildHistoryReplay({ ...opts, outDir: a, toDay: '2026-03-03' })).written, 0, 'nothing changed: nothing rebuilt');
  // The data for 03-02 arrives: that day is built again (and 03-03, which its last bar's close now reaches).
  writeBars(hist, D0 + DAY, D0 + 2 * DAY);
  const later = await buildHistoryReplay({ ...opts, outDir: a, toDay: '2026-03-03' });
  assert.deepEqual([later.written, later.resumed], [2, '2026-03-01']);
  const fresh = path.join(tmpDir(), 'fresh');
  await buildHistoryReplay({ ...opts, outDir: fresh, toDay: '2026-03-03' });
  const read = (dir: string, d: string) => zlib.gunzipSync(fs.readFileSync(path.join(dir, `md-${d}.jsonl.gz`))).toString();
  for (const d of ['2026-03-01', '2026-03-02', '2026-03-03']) assert.ok(read(a, d) === read(fresh, d), `${d}: identical to a fresh build`);
  // Kept states: the last three days and every month's last day.
  assert.deepEqual(fs.readdirSync(path.join(a, 'replay-states')).sort(), ['2026-02-28.json.gz', '2026-03-01.json.gz', '2026-03-02.json.gz', '2026-03-03.json.gz']);
  // Kalshi data arriving for 03-02 rebuilds 03-01 and 03-02, continuing from the end of February.
  fs.mkdirSync(path.join(hist, 'kalshi', 'KXBTC15M'), { recursive: true });
  const open = D0 + DAY + 12 * H;
  fs.writeFileSync(path.join(hist, 'kalshi', 'KXBTC15M', '2026-03-02.jsonl'), JSON.stringify({ ticker: 'KXBTC15M-LATE', series: 'KXBTC15M', openTime: open, closeTime: open + 15 * MIN, strike: 60000, cap: null, result: 'yes', candles: [{ ts: open + MIN, bidC: 0.4, askC: 0.43, last: 0.41, volume: 2 }] }) + '\n');
  const late = await buildHistoryReplay({ ...opts, outDir: a, toDay: '2026-03-03' });
  assert.deepEqual([late.written, late.resumed], [2, '2026-02-28']);
  assert.match(read(a, '2026-03-02'), /KXBTC15M-LATE/);
  // Dominance readings added near a day rebuild it.
  writeDominance(hist, D0 + DAY, D0 + 2 * DAY);
  const dom = await buildHistoryReplay({ ...opts, outDir: a, toDay: '2026-03-03' });
  assert.ok(dom.written >= 2 && read(a, '2026-03-02').includes('"k":"dominance"'));
});

test('open interest: Binance metrics parsed, carried on the replay\'s perp quotes for at most 10 minutes, the open-interest features defined', async () => {
  assert.deepEqual(parseMetricsCsv('create_time,symbol,sum_open_interest,sum_open_interest_value\n2026-03-01 00:05:00,BTCUSDT,95676.373,7982126717.19\nbad,line\n'), [[D0 + 5 * MIN, 95676.373, 7982126717.19]]);
  const hist = tmpDir(), out = path.join(tmpDir(), 'replay');
  writeBars(hist, D0 - 2 * DAY, D0);
  // Readings every 5 minutes, with a half-hour hole at 12:00 on the second day.
  const hole = [D0 - DAY + 12 * H, D0 - DAY + 12.5 * H];
  const rows: string[] = [];
  for (let t = D0 - 2 * DAY, k = 0; t < D0; t += 5 * MIN, k++) if (t < hole[0] || t >= hole[1]) rows.push(`${t},${90000 + 10 * Math.sin(k / 7)},${9e9}`);
  fs.mkdirSync(path.join(hist, 'binance-oi', 'BTC'), { recursive: true });
  fs.writeFileSync(path.join(hist, 'binance-oi', 'BTC', 'oi.csv'), `ts,oi,oi_usd\n${rows.join('\n')}\n`);
  await buildHistoryReplay({ historyDir: hist, outDir: out, assets: ['BTC', 'ETH'], fromDay: '2026-02-27', toDay: '2026-02-28', log: () => {} });
  const st = new ReplayState();
  let withOi = 0, inHole = 0, ethOi = 0, early: number | undefined, late: number | undefined;
  for await (const e of readRecordings(out)) {
    st.apply(e);
    if (e.k === 'perp' && e.asset === 'BTC') {
      if (e.openInterest > 0) withOi++;
      if (e.t >= hole[0] + 10 * MIN + 1000 && e.t < hole[1]) { assert.equal(e.openInterest, undefined, 'a reading older than 10 minutes is not carried'); inHole++; }
    }
    if (e.k === 'perp' && e.asset === 'ETH' && e.openInterest !== undefined) ethOi++;
    if (e.tie) continue;
    const f = () => perpFeatures('BTC', st.now, { index: st.index.get('BTC'), spot: st.spot.get('BTC'), bars: st.features.bars.get('BTC'), candles: st.features.candles.get('BTC'), perp: st.features.perps.get('BTC') });
    if (e.t === D0 - DAY + 6 * H) early = f().perp_oi_chg_1h;
    if (e.t === hole[0] + 20 * MIN) late = f().perp_oi_chg_1h;
  }
  assert.ok(withOi > 2 * 5760 * 0.9 && inHole > 50, `quotes with open interest ${withOi}, in the hole ${inHole}`);
  assert.equal(ethOi, 0, 'no readings: none made up');
  assert.ok(Number.isFinite(early), 'the hourly open-interest change is defined');
  assert.ok(late !== undefined && !Number.isFinite(late), 'and missing in the hole, as with a stale live feed');
});

test('history replay helpers: the first and last bar of a CSV (a torn last line ignored)', () => {
  const f = path.join(tmpDir(), 'x.csv');
  fs.writeFileSync(f, `ts,o,h,l,c,v\n${D0},1,1,1,1,0\n${D0 + MIN},1,1,1,1,0\n${D0 + 2 * MIN},1,1`);
  assert.deepEqual(csvRange(f), { first: D0, last: D0 + MIN });
  assert.equal(csvRange(path.join(tmpDir(), 'none.csv')), undefined);
  const big = path.join(tmpDir(), 'big.csv');
  fs.writeFileSync(big, 'ts,c\n' + Array.from({ length: 2000 }, (_, i) => `${D0 + i * MIN},${i}`).join('\n') + '\n');
  assert.deepEqual(csvRange(big), { first: D0, last: D0 + 1999 * MIN });
});

test('perps dataset: each day cached, the same rows as without the cache, a changed day computed again with its neighbours', async () => {
  const hist = tmpDir(), out = path.join(tmpDir(), 'replay'), cache = path.join(tmpDir(), 'cache');
  writeBars(hist, D0 - 2 * DAY, D0 + 2 * DAY);
  writeDominance(hist, D0, D0 + 2 * DAY);
  await buildHistoryReplay({ historyDir: hist, outDir: out, assets: ['BTC', 'ETH'], fromDay: '2026-02-27', toDay: '2026-03-02', log: () => {} });
  const norm = (rows: PerpRow[]) => rows.map((r) => ({ ...r, x: r.x.map((v) => v + 0) })); // JSON keeps no -0
  const plain = await buildPerpDataset(out, { everySec: 3600, horizonMin: 60 });
  const logs: string[] = [];
  const cached = await buildPerpDataset(out, { everySec: 3600, horizonMin: 60, cacheDir: cache, log: (m) => logs.push(m) });
  assert.ok(plain.length > 150, `rows ${plain.length}`);
  assert.deepEqual(norm(cached), norm(plain));
  const [u, b] = ['usdtd_ret_15m_z', 'btcd_rel_5m_z'].map((n) => PERP_FEATURES.indexOf(n));
  assert.ok(plain.every((r) => (Number.isFinite(r.x[u]) && Number.isFinite(r.x[b])) || r.ts < D0 - DAY), 'the dominance inputs are there');
  assert.deepEqual(norm(await buildPerpDataset(out, { everySec: 3600, horizonMin: 60, cacheDir: cache, log: (m) => logs.push(m) })), norm(plain));
  assert.equal(logs.length, 1, 'the second build reads every day from the cache');
  // A rebuilt day (new file) is computed again, with the day before (its labels) and after (its warm-up).
  const f = path.join(out, 'md-2026-02-28.jsonl.gz');
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(f, t, t);
  await buildPerpDataset(out, { everySec: 3600, horizonMin: 60, cacheDir: cache, log: (m) => logs.push(m) });
  assert.match(logs[1], /1 day\(s\) cached, 3 to compute/);
});

test('tournament days: blocks spread over every era of the history, ending at the latest day', () => {
  const all = Array.from({ length: 1000 }, (_, i) => new Date(D0 + i * DAY).toISOString().slice(0, 10));
  const d = eraDays(all, 28, 7);
  assert.equal(d.length, 28);
  assert.deepEqual([d[0], d[6], d[7], d[27]], [all[0], all[6], all[331], all[999]]);
  assert.deepEqual(eraDays(all.slice(0, 20), 28, 7), all.slice(0, 20), 'fewer days than asked: all of them');
  assert.deepEqual(eraDays(all, 10, 7), all.slice(-10), 'room for one block only: the latest days');
});

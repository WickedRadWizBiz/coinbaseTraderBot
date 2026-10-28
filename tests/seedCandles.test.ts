import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { MetaModel } from '../bot/model/metaModel';
import type { CandleRow } from '../bot/ta/candleStore';
import type { Timeframe } from '../bot/ta/knowledge';
import { setTaNet } from '../bot/ta/taNet';
import { setTaNetEnsemble } from '../bot/ta/taNetEnsemble';
import { engineModels, runBacktest, type EvalReading } from '../research/backtest';
import { candleAssets, fetchSeedCandles, readSeedCandles } from '../research/seedCandles';
import { writeSyntheticRecordings } from '../research/synthetic';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'seed-candles-test-'));
const iso = (ms: number) => new Date(ms).toISOString();

test('seed candles: the bot\'s startup fetch, made for the replay\'s start', async () => {
  const at = Date.parse('2026-10-26T16:03:00Z');
  const asked: string[] = [];
  // Coinbase's candles: every bar starting in [start, end], newest first; no product for ZZZ.
  const stub = (async (url: string) => {
    asked.push(url);
    const u = new URL(url);
    if (u.pathname.includes('ZZZ-USD')) return { ok: false, status: 404, json: async () => ({}) };
    const g = Number(u.searchParams.get('granularity')) * 1000;
    const from = Date.parse(u.searchParams.get('start')!), to = Date.parse(u.searchParams.get('end')!);
    const rows: number[][] = [];
    for (let ts = Math.ceil(from / g) * g; ts <= to; ts += g) rows.push([ts / 1000, 99, 101, 100, 100.5, 3]);
    return { ok: true, status: 200, json: async () => rows.reverse() };
  }) as unknown as typeof fetch;
  const seed = await fetchSeedCandles(['BTC', 'ZZZ'], at, 'https://cb.test', stub, 0);
  assert.equal(seed.at, at);
  assert.deepEqual(seed.missing, ['ZZZ (no Coinbase product)'], 'an asset Coinbase does not list gets nothing, as in the bot');
  assert.equal(asked.filter((u) => u.includes('ZZZ')).length, 1, 'nothing more asked for it');
  assert.deepEqual(seed.sets.map((c) => c.tf), ['1m', '5m', '15m', '1h', '1d'], 'every timeframe the bot polls');
  const h1 = new URL(asked.find((u) => u.includes('BTC-USD') && u.includes('granularity=3600'))!);
  assert.deepEqual([h1.searchParams.get('start'), h1.searchParams.get('end')], [iso(at - 299 * 3_600_000), iso(at)], 'one page of 1h bars, ending at the start');
  const m15 = asked.filter((u) => u.includes('BTC-USD') && u.includes('granularity=900')).map((u) => new URL(u));
  assert.equal(m15.length, 2, '15m: the bot backfills one older page');
  // The first page's oldest bar: the first 15m start inside it.
  const oldest = Math.ceil((at - 299 * 900_000) / 900_000) * 900_000;
  assert.deepEqual([m15[1].searchParams.get('start'), m15[1].searchParams.get('end')], [iso(oldest - 300 * 900_000), iso(oldest - 900_000)]);
  assert.ok(seed.sets.find((c) => c.tf === '15m')!.rows.length > 590);

  const file = path.join(tmp(), 'seed.json');
  fs.writeFileSync(file, JSON.stringify(seed));
  assert.equal(readSeedCandles(file, at)?.sets.length, 5);
  assert.equal(readSeedCandles(file, at + 1000), undefined, 'a seed fetched for another start is not used');
  assert.equal(readSeedCandles(path.join(tmp(), 'none.json'), at), undefined);
});

test('seed candles: the assets the bot polls candles for', () => {
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) });
  const assets = candleAssets(cfg);
  assert.ok(assets.includes('BTC') && assets.includes('ETH'), assets.join(', '));
  assert.ok(!assets.includes('TENNIS'));
  assert.deepEqual(candleAssets(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), TA_CANDLES: 'false' })), [], 'no candle feed, no candles');
});

test('backtest seedCandles: a replay that starts mid-run prices with the TA network as paper did', async () => {
  const dir = tmp();
  fs.copyFileSync('params/ta_net.json', path.join(dir, 'ta_net.json'));
  const rec = path.join(dir, 'rec');
  const start = Date.parse('2026-01-01T00:00:00Z');
  writeSyntheticRecordings(rec, { windows: 2, seed: 7, start });
  // The closed bars the bot would have held at the start: a random walk near the recordings' BTC (about 60,000).
  let x = Math.log(60000), seedRng = 1;
  const rnd = () => ((seedRng = (seedRng * 16807) % 2147483647) / 2147483647) - 0.5;
  const bars = (tf: Timeframe, sec: number, n: number) => {
    const rows: CandleRow[] = [];
    for (let i = n; i >= 1; i--) {
      const o = Math.exp(x); x += 0.004 * Math.sqrt(sec / 3600) * rnd() * 3.4; const c = Math.exp(x);
      rows.push([Math.floor(start / 1000) - i * sec, Math.min(o, c) * 0.999, Math.max(o, c) * 1.001, o, c, 50 + 40 * rnd()]);
    }
    return { asset: 'BTC', tf, rows };
  };
  x = Math.log(60000); const d1 = bars('1d', 86400, 300);
  x = Math.log(60000); const h1 = bars('1h', 3600, 300);
  x = Math.log(60000); const m15 = bars('15m', 900, 600);
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), AUTO_TRAIN_DIR: dir });
  try {
    await engineModels(cfg);
    const read = async (seedCandles?: { at: number; sets: Array<{ asset: string; tf: Timeframe; rows: CandleRow[] }> }) => {
      const seen: EvalReading[] = [];
      await runBacktest(rec, MetaModel.identity(), cfg.strategy, cfg.risk, 200, { paper: { orderFrac: 0.1, orderUsd: 0 }, taNet: true, onEval: (e) => seen.push(e), ...(seedCandles ? { seedCandles } : {}) });
      return seen;
    };
    const without = await read();
    assert.ok(without.length > 0);
    assert.ok(without.every((e) => e.taVolMult === 1), 'the recorded bars alone: too few for the network, sigma as the fallback');
    const seeded = await read({ at: start, sets: [d1, h1, m15] });
    assert.ok(seeded.some((e) => e.taVolMult !== undefined && Math.abs(e.taVolMult - 1) > 1e-6), 'seeded: the network\'s volatility forecast scales sigma');
    // The same market at the same instant (the positions part, so not every evaluation is in both).
    const fv = new Map(without.map((e) => [`${e.ticker}@${e.now}`, e.fv]));
    const both = seeded.filter((e) => fv.has(`${e.ticker}@${e.now}`));
    assert.ok(both.length > 100);
    assert.ok(both.some((e) => Math.abs(e.fv - fv.get(`${e.ticker}@${e.now}`)!) > 1e-6), 'and so the fair value');
  } finally { setTaNet(undefined); setTaNetEnsemble(undefined); }
});

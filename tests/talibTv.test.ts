// TA-Lib as the main indicator engine (bot/ta/talib.ts), and TradingView history (research/history/
// tradingview.ts): hole finding, index needs, fetch + import, and the slow context series (TOTAL3,
// OTHERS.D, RTY) in the TA network's daily inputs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KEY_PATTERNS, TALIB_KEYS, taEngine, talibCore, talibExtras, tl } from '../bot/ta/talib';
import { tfState } from '../bot/ta/analyzer';
import { atr, rsi, type Candle } from '../bot/ta/indicators';
import { upsertSeries } from '../bot/marketdata/historyStore';
import { findSpotHoles, indexNeeds, tvFill } from '../research/history/tradingview';
import { loadSeries } from '../research/history/candles';
import { DAILY_CONTEXT_FEATURES, SLOW_INDEXES, TaNetContext } from '../bot/ta/taNetContext';
import { TF_KEYS } from '../bot/ta/taNet';

const H = 3_600_000, DAY = 86_400_000;
function walk(n: number, step: number, t0 = Date.UTC(2026, 0, 1), seed = 1): Candle[] {
  let x = 100, s = seed;
  const r = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) - 0.5;
  return Array.from({ length: n }, (_, i) => {
    const o = x; x *= 1 + r() * 0.02 + Math.sin(i / 9) * 0.004;
    return { ts: t0 + i * step, o, h: Math.max(o, x) * (1 + Math.abs(r()) * 0.01), l: Math.min(o, x) * (1 - Math.abs(r()) * 0.01), c: x, v: 1000 + Math.abs(r()) * 500 };
  });
}

test('TA-Lib: the native engine is active; core indicators agree with the built-in definitions', () => {
  assert.equal(taEngine(), 'talib');
  const cs = walk(300, H);
  const T = talibCore(cs)!;
  const n = cs.length - 1;
  // Wilder RSI and ATR: same definition, converged after the warm-up.
  assert.ok(Math.abs(T.rsi[n] - rsi(cs.map((c) => c.c), 14)[n]) < 1e-6, `rsi ${T.rsi[n]}`);
  assert.ok(Math.abs(T.atr[n] - atr(cs, 14)[n]) / T.atr[n] < 1e-3, `atr ${T.atr[n]}`);
  assert.ok(Number.isNaN(T.sma200[100]) && Number.isFinite(T.sma200[n]), 'aligned outputs: NaN before the first value');
  // Every optional input gets TA-Lib's documented default (patterns with a penetration factor work).
  assert.ok(tl('CDLMORNINGSTAR', { open: cs.map((c) => c.o), high: cs.map((c) => c.h), low: cs.map((c) => c.l), close: cs.map((c) => c.c) }).outInteger);
});

test('TA-Lib extras: every key, scale-free, patterns summarised; carried into the TA state and the network inputs', () => {
  const cs = walk(300, H);
  const s = tfState('1h', cs)!;
  const x = talibExtras(cs, s.atr);
  assert.deepEqual(Object.keys(x).sort(), [...TALIB_KEYS].sort());
  for (const k of ['tl_cci', 'tl_mom_atr', 'tl_aroonosc', 'tl_ultosc', 'tl_cmo', 'tl_bop', 'tl_sar_dist', 'tl_stddev_atr', 'tl_kama_dist']) assert.ok(Number.isFinite(x[k]) && Math.abs(x[k]) <= 30, `${k}=${x[k]}`);
  for (const p of KEY_PATTERNS) assert.ok([-2, -1, 0, 1, 2].includes(x[`cdl_${p.toLowerCase()}`]), p);
  assert.equal(x.cdl_net, x.cdl_bull - x.cdl_bear);
  assert.deepEqual(Object.keys(s.tl).sort(), [...TALIB_KEYS].sort());
  for (const k of TALIB_KEYS) assert.ok(TF_KEYS({ sma200: true, vwap: true }).includes(k));
});

test('TradingView: spot holes within reach, index needs, fetch and import as gap-only sources', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvh-'));
  const now = Date.UTC(2026, 9, 1);
  const bars = walk(2000, H, now - 2000 * H);
  const withHole = bars.filter((_, i) => i < 500 || i >= 520);          // 20 hourly bars missing
  upsertSeries(dir, 'binance', 'BTC', '1h', withHole);
  const holes = findSpotHoles(dir, ['BTC'], ['1h'], { now });
  assert.equal(holes.length, 1);
  assert.equal(holes[0].missing, 20);
  assert.equal(holes[0].first, bars[500].ts);
  // No index series yet: all nine need the full backfill.
  assert.deepEqual(indexNeeds(dir, now).full, ['BTC.D', 'USDT.D', 'TOTAL3', 'OTHERS.D', 'RTY', 'DXY', 'US10Y', 'VIX', 'HYG']);
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const out = args[args.indexOf('--out') + 1];
    const csv = (cs: Candle[]) => `time,open,high,low,close,volume\n${cs.map((c) => `${c.ts / 1000},${c.o},${c.h},${c.l},${c.c},${c.v}`).join('\n')}\n`;
    if (args.includes('--spot')) fs.writeFileSync(path.join(out, 'tvspot__BTC__1h__COINBASE-BTCUSD.csv'), csv(bars.slice(490, 530).map((c) => ({ ...c, o: c.o * 1.001, h: c.h * 1.001, l: c.l * 1.001, c: c.c * 1.001 }))));
    else { const d = walk(3500, DAY, now - 3500 * DAY, 7); fs.writeFileSync(path.join(out, 'CRYPTOCAP_TOTAL3_1d.csv'), csv(d)); fs.writeFileSync(path.join(out, 'TVINDEX_RTY_1d.csv'), csv(d)); }
    return 0;
  };
  const tried: Record<string, number> = {};
  const r = await tvFill({ histDir: dir, assets: ['BTC'], now, run, log: () => {}, tried });
  assert.ok(calls.some((a) => a.includes('--indexes') && a[a.indexOf('--indexes') + 1].includes('RTY=TVC:RUT')));
  // Every timeframe with holes is requested (15m has no history at all here: its whole reachable window).
  assert.ok(calls.some((a) => a.includes('--spot') && a[a.indexOf('--spot') + 1].split(',').includes('BTC:1h')));
  assert.ok(r.imported.every((x) => x.ok), JSON.stringify(r.imported));
  // The hole is filled from TradingView, the exchange's own bars win everywhere else.
  const after = loadSeries(dir, 'BTC', '1h').candles;
  const byTs = new Map(after.map((c) => [c.ts, c]));
  assert.ok(byTs.has(bars[505].ts), 'hole filled');
  assert.ok(Math.abs(byTs.get(bars[495].ts)!.c - bars[495].c) < 1e-6, 'binance bar kept where it existed (the TradingView copy is 0.1% off)');
  assert.ok(Math.abs(byTs.get(bars[505].ts)!.c - bars[505].c * 1.001) < 1e-6, 'the hole holds the TradingView bar');
  assert.deepEqual(findSpotHoles(dir, ['BTC'], ['1h'], { now }), []);
  assert.ok(findSpotHoles(dir, ['BTC'], ['15m'], { now })[0].missing > 0, 'an absent timeframe counts as a hole (TradingView can supply it)');
  const need = indexNeeds(dir, now);
  assert.ok(!need.full.includes('TOTAL3') && !need.full.includes('RTY'));
  // Holes sent this run are remembered (retried weekly, not daily, if TradingView can't fill them either).
  assert.ok(Object.keys(tried).some((k) => k.startsWith('BTC|1h|')));
});

test('slow context: TOTAL3 / OTHERS.D / RTY one day behind, RTY carried over the weekend, signed per coin', () => {
  const t0 = Date.UTC(2025, 0, 1);
  const daily = walk(400, DAY, t0, 3);
  const rty = daily.filter((c) => { const d = new Date(c.ts).getUTCDay(); return d !== 0 && d !== 6; });
  const ctx = new TaNetContext({ h1: {}, slow1d: { TOTAL3: daily, 'OTHERS.D': daily, RTY: rty } });
  const base = DAILY_CONTEXT_FEATURES.indexOf(`dd_${SLOW_INDEXES[0].p}_chg_1`);
  const per = DAILY_CONTEXT_FEATURES.indexOf(`dd_${SLOW_INDEXES[1].p}_chg_1`) - base;
  const day = daily[300].ts;
  const btc = ctx.daily('BTC', day), eth = ctx.daily('ETH', day);
  assert.equal(btc.length, DAILY_CONTEXT_FEATURES.length);
  // TOTAL3 reads the bar of the day before (log change of daily[299] vs daily[298], z-scored).
  assert.ok(Number.isFinite(btc[base]) && Math.sign(btc[base]) === Math.sign(Math.log(daily[299].c / daily[298].c)));
  // OTHERS.D: + for alts, - for BTC.
  assert.equal(eth[base + per], -btc[base + per]);
  // A Monday reads RTY's Friday bar (carried over the weekend); 5 days without a bar reads missing.
  let mon = day; while (new Date(mon).getUTCDay() !== 1) mon += DAY;
  assert.ok(Number.isFinite(ctx.daily('ETH', mon)[base + 2 * per + 3]), 'RTY carried from Friday');
  const late = new TaNetContext({ h1: {}, slow1d: { RTY: rty.slice(0, 200) } }).daily('ETH', rty[199].ts + 6 * DAY);
  assert.ok(Number.isNaN(late[base + 2 * per]), 'stale beyond 4 days');
});

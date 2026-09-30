import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { IndexTracker } from '../bot/marketdata/indexTracker';
import { OrderBook } from '../bot/marketdata/orderBook';
import { SpotCandleFeed } from '../bot/marketdata/spotCandles';
import { computeFeatureMap, FEATURES, FeatureHub, type FeatureContext } from '../bot/model/featureEngine';
import { analyze, TF_MS, tfState } from '../bot/ta/analyzer';
import { aggregate, CandleSet, toRow } from '../bot/ta/candleStore';
import { adx, atr, bollinger, cmf, ema, ichimoku, macd, mfi, obv, rsi, sma, stochastic, volumeProfile, vwap, williamsR, type Candle } from '../bot/ta/indicators';
import { CONFLUENCES, KNOWLEDGE, RULES } from '../bot/ta/knowledge';
import { candlePatterns, divergence, fairValueGaps, liquiditySweep, marketStructure, roundLevel, swings, trueBreakout } from '../bot/ta/structure';
import { benjaminiHochberg, runTaStudy } from '../research/taStudy';
import { ReplayState } from '../research/replay';
import { tmpDir } from './helpers';

const T0 = Date.parse('2026-09-01T00:00:00Z');
let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
/** Random-walk candles with a drift per bar. */
function walk(n: number, ms: number, drift: number, vol = 0.004, start = 60000, t0 = T0): Candle[] {
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    p *= Math.exp(drift + vol * (rnd() - 0.5));
    out.push({ ts: t0 + i * ms, o, h: Math.max(o, p) * (1 + 0.001 * rnd()), l: Math.min(o, p) * (1 - 0.001 * rnd()), c: p, v: 10 + 10 * rnd() });
  }
  return out;
}
const bar = (i: number, o: number, h: number, l: number, c: number, v = 10): Candle => ({ ts: T0 + i * 60_000, o, h, l, c, v });

test('indicator math matches the textbook definitions', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual(sma(xs, 3).slice(2, 4), [2, 3]);
  const e = ema(xs, 3);
  assert.equal(e[2], 2); // seeded with the SMA
  assert.equal(e[3], (4 - 2) * 0.5 + 2);
  assert.equal(rsi([...Array(30)].map((_, i) => i), 14).at(-1), 100, 'only gains -> RSI 100');
  const flat = [...Array(40)].map((_, i) => 100 + (i % 2));
  assert.ok(Math.abs(rsi(flat, 14).at(-1)! - 50) < 5);
  const up = [...Array(60)].map((_, i) => 100 + i);
  assert.ok(macd(up).line.at(-1)! > 0 && Math.abs(macd(up).hist.at(-1)!) < 1e-6, 'linear trend: MACD > 0, histogram ~ 0');
  const bb = bollinger([...Array(19).fill(10), 10], 20);
  assert.equal(bb.pctB.at(-1), 0.5);
  const cs = [...Array(30)].map((_, i) => bar(i, 100, 101, 99, 100));
  assert.ok(Math.abs(atr(cs, 14).at(-1)! - 2) < 1e-9, 'constant 2-point ranges -> ATR 2');
  const atHigh = [...Array(30)].map((_, i) => bar(i, 100 + i, 101 + i, 99 + i, 101 + i));
  assert.equal(stochastic(atHigh).k.at(-1), 100);
  assert.equal(williamsR(atHigh).at(-1), 0);
  assert.ok(Math.abs(cmf(atHigh).at(-1)! - 1) < 1e-9, 'closing at the high every bar -> CMF 1');
  assert.equal(mfi(atHigh).at(-1), 100);
  assert.deepEqual(obv([bar(0, 1, 1, 1, 1, 5), bar(1, 1, 2, 1, 2, 3), bar(2, 2, 2, 1, 1, 4)]), [0, 3, -1]);
  const vw = vwap([bar(0, 10, 12, 8, 10, 1), bar(1, 10, 13, 11, 12, 1)]);
  assert.equal(vw.at(-1), (10 + 12) / 2);
  const a = adx(atHigh);
  assert.ok(a.adx.at(-1)! > 25 && a.plusDI.at(-1)! > a.minusDI.at(-1)!);
  const ich = ichimoku(walk(120, 3_600_000, 0.003));
  assert.ok(ich.tenkan.at(-1)! > ich.kijun.at(-1)!, 'uptrend: tenkan above kijun');
  const vp = volumeProfile([...Array(20)].map((_, i) => bar(i, 100, 100.5, 99.5, 100, i === 5 ? 1000 : 1)).concat([bar(21, 110, 111, 109, 110, 1)]), 20)!;
  assert.ok(Math.abs(vp.poc - 100) < 1 && vp.val <= 100 && vp.vah >= 100);
  assert.ok(vp.nodeAt(105) < 0.5, 'no trading between 101 and 109: low-volume node');
});

test('structure: swings, sweeps, true breakouts, FVGs, divergence, candles, round numbers', () => {
  // A swing low at 95, then a bar that wicks to 94 and closes back at 97 (sweep of the lows).
  const cs: Candle[] = [];
  const path = [100, 99, 98, 97, 95, 97, 98, 99, 100, 99, 98, 97.5];
  path.forEach((p, i) => cs.push(bar(i, p + 0.2, p + 0.5, p - 0.5, p)));
  cs.push(bar(path.length, 97.4, 97.6, 94, 97.2));
  const sw = swings(cs);
  assert.ok(sw.some((s) => s.kind === 'low' && Math.abs(s.price - 94.5) < 1e-9));
  assert.equal(liquiditySweep(cs, sw), 1);
  // True breakout: solid body closing above the swing high on 3x volume.
  const bo = [...Array(25)].map((_, i) => bar(i, 100, 100.5 + (i === 10 ? 2 : 0), 99.5, 100));
  bo.push(bar(25, 100.4, 104, 100.3, 103.8, 30));
  assert.equal(trueBreakout(bo), 1);
  // Bullish FVG: bar 0 high 101 < bar 2 low 102.
  const g = fairValueGaps([bar(0, 100, 101, 99, 100.5), bar(1, 101, 104, 100.8, 103.5), bar(2, 103.5, 105, 102, 104.5)]);
  assert.deepEqual(g.map((x) => [x.dir, x.bottom, x.top]), [[1, 101, 102]]);
  // Bullish divergence: price lower low, oscillator higher low.
  const dv: Candle[] = [100, 98, 96, 94, 96, 98, 100, 98, 96, 93, 95, 97, 99, 100].map((p, i) => bar(i, p, p + 0.3, p - 0.3, p));
  const osc = dv.map((_, i) => (i === 3 ? 20 : i === 9 ? 30 : 50));
  assert.equal(divergence(dv, osc).regular, 1);
  assert.equal(candlePatterns([bar(0, 101, 101.5, 99.5, 100), bar(1, 99.8, 102.5, 99.7, 102)]).engulfing, 1);
  assert.deepEqual(roundLevel(64_870), { level: 65_000, step: 1000, dist: -130 });
  assert.equal(roundLevel(152).step, 10);
  // Market structure: HH/HL uptrend.
  // Zigzag: 4 bars up 1.0 each, 4 bars down 0.5 each -> higher highs and higher lows.
  const upSeries: number[] = [];
  let lvl = 100;
  for (let k = 0; k < 6; k++) { for (let j = 0; j < 4; j++) upSeries.push((lvl += 1)); for (let j = 0; j < 4; j++) upSeries.push((lvl -= 0.5)); }
  const ups = upSeries.map((p, i) => bar(i, p, p + 0.4, p - 0.4, p));
  assert.equal(marketStructure(ups).trend, 'up');
});

test('candle store: drops forming candles, merges updates, builds 4h from complete 1h groups', () => {
  const set = new CandleSet('BTC');
  const hours = walk(12, 3_600_000, 0);
  const now = hours[11].ts + 30 * 60_000; // last hour still forming
  const fresh = set.add('1h', hours, now);
  assert.equal(fresh.length, 11);
  assert.equal(set.lastTs('1h'), hours[10].ts);
  assert.equal(set.bars['4h']!.length, 2, '00-04 and 04-08 complete; 08-12 incomplete');
  assert.equal(set.bars['4h']![0].v, hours.slice(0, 4).reduce((s, c) => s + c.v, 0));
  assert.equal(set.add('1h', hours.slice(0, 11), now).length, 0, 'unchanged rows are not new');
  assert.deepEqual(aggregate(hours.slice(1, 9), TF_MS['4h']).map((c) => c.ts), [hours[4].ts], 'misaligned leading bars are skipped');
});

test('knowledge base is consistent: every rule and confluence points at real entries and timeframes', () => {
  const ids = new Set(KNOWLEDGE.map((k) => k.id));
  assert.equal(ids.size, KNOWLEDGE.length);
  for (const r of RULES) assert.ok(ids.has(r.indicator), `${r.id} -> ${r.indicator}`);
  const ruleIds = new Set(RULES.map((r) => r.id));
  assert.equal(ruleIds.size, RULES.length);
  for (const c of CONFLUENCES) {
    for (const m of c.members) {
      const r = RULES.find((x) => x.id === m.rule);
      assert.ok(r, `${c.id}: unknown rule ${m.rule}`);
      assert.ok(r!.timeframes.includes(m.tf), `${c.id}: ${m.rule} is not evaluated on ${m.tf}`);
    }
    for (const req of c.required) assert.ok(c.members.some((m) => m.rule === req), `${c.id}: required ${req} not a member`);
    assert.ok(c.minAgree <= c.members.length);
  }
  for (const k of KNOWLEDGE) assert.ok(k.evidence.sources.length > 0, `${k.id} cites sources`);
  // Every PDF indicator family is covered.
  for (const id of ['moving_averages', 'adx', 'ichimoku', 'bollinger', 'atr', 'rsi', 'macd', 'stochastic', 'obv', 'money_flow', 'volume_profile', 'vwap', 'liquidity', 'mvrv_z', 'nvt', 'dominance_matrix']) assert.ok(ids.has(id), id);
});

test('analyzer: an uptrend reads bullish, a downtrend bearish; the dominance matrix is asset-aware', () => {
  const mk = (drift: number) => ({ '15m': walk(300, TF_MS['15m'], drift / 4), '1h': walk(300, TF_MS['1h'], drift), '4h': walk(300, TF_MS['4h'], drift), '1d': walk(300, TF_MS['1d'], drift) });
  const up = analyze('BTC', mk(0.002), Date.now());
  const dn = analyze('BTC', mk(-0.002), Date.now());
  assert.ok(up.net > 5 && dn.net < -5, `${up.net} / ${dn.net}`);
  assert.ok(up.confluences.find((c) => c.id === 'trend_alignment')!.score > 0.5);
  assert.ok(dn.confluences.find((c) => c.id === 'trend_alignment')!.score < -0.5);
  assert.ok(up.signals.every((s) => s.meaning.length > 0));
  // USDT.D falling + BTC.D rising: bullish BTC, not bullish for an alt.
  const dom = (a: string) => analyze(a, { '1h': walk(100, TF_MS['1h'], 0) }, Date.now(), { usdtdChg: -1, btcdChg: 1, asset: a }).signals.find((s) => s.id === 'dominance_matrix');
  assert.equal(dom('BTC')?.dir, 1);
  assert.equal(dom('SOL')?.dir, 0);
  assert.ok(tfState('1h', walk(29, TF_MS['1h'], 0)) === undefined, 'needs 30 candles');
});

function ctx(candles: CandleSet | undefined, now: number): FeatureContext {
  const book = new OrderBook('T');
  book.applySnapshot({ bids: [{ price: 0.5, size: 30 }], asks: [{ price: 0.53, size: 10 }] }, now);
  const index = new IndexTracker('BTC');
  index.add(60000, now);
  return { now, fairValue: 0.55, mid: 0.515, tauSec: 300, sigmaPerSqrtSec: 2e-4, referenceSigma: 2e-4, inWindow: false, book, index, asset: 'BTC', candles };
}

test('features: TA readings come from fresh candles only; stale charts read NaN', () => {
  const set = new CandleSet('BTC');
  const c15 = walk(300, TF_MS['15m'], 0.0008), c1h = walk(300, TF_MS['1h'], 0.002, 0.004, 60000, c15[299].ts + TF_MS['15m'] - 300 * TF_MS['1h']);
  const now = c15[299].ts + TF_MS['15m'] + 1000;
  set.add('15m', c15, now);
  set.add('1h', c1h, now);
  const f = computeFeatureMap(ctx(set, now));
  const taNames = Object.keys(FEATURES).filter((n) => FEATURES[n].group === 'ta' || FEATURES[n].group === 'taconf');
  assert.ok(taNames.length > 40);
  for (const n of taNames) assert.ok(Number.isFinite(f[n]) || Number.isNaN(f[n]), n);
  assert.ok(f.ta_rsi_15m > 0 && f.ta_ema_stack_1h === 1, JSON.stringify({ rsi: f.ta_rsi_15m, stack: f.ta_ema_stack_1h }));
  assert.ok(Number.isFinite(f.taconf_trend_alignment));
  const stale = computeFeatureMap(ctx(set, now + 6 * 3_600_000));
  assert.ok(Number.isNaN(stale.ta_rsi_15m) && Number.isNaN(stale.taconf_net));
  assert.ok(Number.isNaN(computeFeatureMap(ctx(undefined, now)).ta_rsi_1h));
});

test('replay feeds recorded candles through the same hub as live', () => {
  const st = new ReplayState();
  const rows = walk(40, TF_MS['15m'], 0).map(toRow);
  const t = T0 + 41 * TF_MS['15m'];
  st.apply({ t, k: 'candles', asset: 'ETH', tf: '15m', rows, ts: t } as any);
  assert.equal(st.features.candles.get('ETH')?.bars['15m']?.length, 40);
  const hub = new FeatureHub();
  assert.equal(hub.onCandles('ETH', '15m', rows, t).length, 40);
  assert.equal(hub.onCandles('ETH', '15m', rows, t).length, 0, 'only new rows are recorded again');
});

test('study: Benjamini-Hochberg, and a persistent trend makes trend rules pass while the output is well-formed', () => {
  assert.deepEqual(benjaminiHochberg([0.001, 0.2, 0.01, 0.9], 0.1), [true, false, true, false]);
  // Autocorrelated 15m returns (momentum), so trend-following rules should carry an edge.
  const n = 1400;
  const c15: Candle[] = [];
  let p = 60000, r = 0;
  for (let i = 0; i < n; i++) {
    r = 0.9 * r + 0.0012 * (rnd() - 0.5);
    const o = p; p *= Math.exp(r);
    c15.push({ ts: T0 + i * TF_MS['15m'], o, h: Math.max(o, p) * 1.0004, l: Math.min(o, p) * 0.9996, c: p, v: 10 + 5 * rnd() });
  }
  const c1h = aggregate(c15, TF_MS['1h']);
  const res = runTaStudy({ BTC: { '15m': c15, '1h': c1h } }, { stride: 2 });
  assert.ok(res.steps > 400 && res.rows.length > 10);
  for (const row of res.rows) assert.ok(row.hitRate >= 0 && row.hitRate <= 1 && row.n >= 30 && row.p > 0 && row.p <= 1);
  const ms = res.rows.find((x) => x.id === 'momentum_state' && x.tf === '15m' && x.horizonMin === 15)!;
  assert.ok(ms.meanBps > 0 && ms.fdrPass, JSON.stringify(ms));
});

test('spot candle feed: parses Coinbase rows, emits them, and disables an asset without a USD pair', async () => {
  const calls: string[] = [];
  const fake = (async (url: string) => {
    calls.push(url);
    if (url.includes('XYZ-USD')) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify([[1_700_000_060, 99, 101, 100, 100.5, 3], [1_700_000_000, 98, 100, 99, 100, 2], ['bad']]), { status: 200 });
  }) as unknown as typeof fetch;
  const feed = new SpotCandleFeed(['BTC', 'XYZ'], 'https://cb.test', fake, () => 1_700_001_000_000);
  const got: any[] = [];
  feed.on('candles', (e) => got.push(e));
  await feed.tick();
  assert.equal(got.length, 5, 'BTC on 1m, 5m, 15m, 1h, 1d');
  assert.deepEqual(got[0].rows[0], [1_700_000_060, 99, 101, 100, 100.5, 3]);
  assert.equal(got[0].rows.length, 2);
  assert.equal(calls.filter((u) => u.includes('XYZ')).length, 1, 'no retries for a missing product');
  await feed.tick();
  assert.equal(got.length, 5, 'nothing due yet');
});

test('research:ta writes a study the API can read', async () => {
  const { studyFor } = await import('../bot/ta/study');
  const dir = tmpDir();
  const p = path.join(dir, 'ta_study.json');
  fs.writeFileSync(p, JSON.stringify({ generatedAt: 'x', rows: [{ id: 'bos', kind: 'rule', tf: '1h', horizonMin: 60, n: 100, hitRate: 0.56, meanBps: 3, ciLo: 1, ciHi: 5, p: 0.01, fdrPass: true }] }));
  assert.equal(studyFor(p, 'rule', 'bos', '1h')?.[0].hitRate, 0.56);
  assert.equal(studyFor(p, 'rule', 'bos', '15m'), undefined);
});

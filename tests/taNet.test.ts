// TA network v2: inputs (identical offline and live, no look-ahead), the population tournament with
// its hurdles, saving/continuing the population, train/serve parity of the three-branch network,
// the live runtime (grading, forward test), the feature registry, and the pipeline step.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { assetFeatureMap } from '../bot/model/featureEngine';
import { CandleSet } from '../bot/ta/candleStore';
import type { Candle } from '../bot/ta/indicators';
import {
  activeTaNet, setTaNet, TANET_D1_BARS, TANET_FEATURES, TANET_H1_BARS, TANET_SCHEMA, TANET_TREND_STEPS, TaNet, TaNetRuntime, taNetDayVector, taNetFeatureMap, taNetMicro, taNetPosition, windowOk, type TaNetStateCache,
} from '../bot/ta/taNet';
import { aggregateCandles, upsertSeries } from '../research/history/candles';
import { runPipeline } from '../research/pipeline';
import { buildData, forecast, trainTaNet } from '../research/trainTaNet';
import { tmpDir } from './helpers';

const H = 3_600_000, Q = 900_000, DAY = 86_400_000;
const T0 = Date.UTC(2020, 0, 1);

/** 15-minute candles whose HOURLY returns are autocorrelated (phi) with clustered volatility. */
function planted(hours: number, seed = 3, phi = 0.6): Candle[] {
  let s = seed;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
  let p = 100, prev = 0, v = 0.006 ** 2;
  const out: Candle[] = [];
  for (let i = 0; i < hours; i++) {
    v = 0.000002 + 0.1 * prev * prev + 0.85 * v;
    const ret = phi * prev + Math.sqrt(v) * gauss();
    for (let k = 0; k < 4; k++) {
      const o = p;
      p = p * Math.exp(ret / 4 + Math.sqrt(v) * 0.15 * gauss());
      out.push({ ts: T0 + i * H + k * Q, o, h: Math.max(o, p) * (1 + Math.abs(gauss()) * 0.0005), l: Math.min(o, p) * (1 - Math.abs(gauss()) * 0.0005), c: p, v: 25 * (1 + Math.abs(ret) * 50) * (0.5 + r()) });
    }
    prev = Math.log(out[out.length - 1].c / out[out.length - 4].o);
  }
  return out;
}

const M15 = planted(9000);
const H1 = aggregateCandles(M15, Q, H);
const D1 = aggregateCandles(M15, Q, DAY);

function historyDir(): string {
  const dir = tmpDir();
  upsertSeries(dir, 'binance', 'TST', '15m', M15);
  return dir;
}
const OPTS = { trainMonths: 1.5, evalMonths: 0.25, stepMonths: 0.25, holdoutMonths: 0.5, stride: 1, minPerRegime: 5, epochsPerRound: 2, baseHyper: { lr: 3e-3, l2: 1e-3 } };

test('inputs: hourly map, daily steps and 15m steps are complete, cache-identical and never look ahead', () => {
  const i = 8000;
  const w = H1.slice(i - TANET_H1_BARS + 1, i + 1);
  const f = taNetFeatureMap('TST', w, D1);
  assert.deepEqual(Object.keys(f).sort(), [...TANET_FEATURES].sort());
  const cache: TaNetStateCache = {};
  for (let k = i; k < i + 10; k++) {
    const win = H1.slice(k - TANET_H1_BARS + 1, k + 1);
    const a = taNetFeatureMap('TST', win, D1, cache), b = taNetFeatureMap('TST', win, D1);
    for (const key of TANET_FEATURES) assert.ok(Object.is(a[key], b[key]), `${key} differs with the state cache`);
  }
  const t = H1[i].ts + H;
  const later = M15.map((c) => (c.ts >= t ? { ...c, c: c.c * 3, h: c.h * 3 } : c));
  const H1b = aggregateCandles(later, Q, H), D1b = aggregateCandles(later, Q, DAY);
  const g = taNetFeatureMap('TST', H1b.slice(i - TANET_H1_BARS + 1, i + 1), D1b);
  for (const key of TANET_FEATURES) assert.ok(Object.is(f[key], g[key]), `${key} looked ahead`);
  assert.deepEqual(Array.from(taNetMicro(later, t)), Array.from(taNetMicro(M15, t)), '15m steps looked ahead');
  const dj = D1.findIndex((c) => c.ts + DAY > t) - 1;
  assert.deepEqual(taNetDayVector(D1b, dj), taNetDayVector(D1, dj), 'daily step looked ahead');
  assert.ok(Number.isFinite(taNetMicro(M15, t)[0]));
  assert.ok(Number.isNaN(taNetMicro(M15.filter((c) => c.ts !== t - 2 * Q), t)[0]), 'a missing 15m bar -> no micro input');
  assert.equal(windowOk(w), true);
  // Position rule: flat below the minimum Kelly size, Kelly-sized and clipped above it.
  assert.equal(taNetPosition(0.502, 0, 0.01), 0);
  assert.ok(taNetPosition(0.6, 0, 0.01) > 0 && taNetPosition(0.4, 0, 0.01) < 0);
  assert.equal(taNetPosition(0.99, 0, 0.0001), 1);
});

test('tournament: 3 identical networks, elite/cull/mutate, hurdles, holdout, continue, parity, live runtime', async () => {
  const dir = historyDir();
  const D = buildData(dir, ['TST'], path.join(dir, '.cache'), () => undefined);
  assert.ok(D.ts.length > 2000, `${D.ts.length} samples`);
  assert.ok(D.microShare > 0.95);
  const state = path.join(dir, 'pop.json');
  const logs: string[] = [];
  const first = await trainTaNet(D, { ...OPTS, statePath: state, maxRounds: 2, log: (m) => logs.push(m) });
  assert.equal(first.complete, false);
  assert.equal(first.rounds, 2);
  const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.equal(saved.members.length, 3);
  // Identical starts: round 0's members differ only in hyperparameters (member 0 = the base).
  assert.equal(saved.log[0].ranking.length, 3);
  assert.ok(saved.log[0].culled !== saved.log[0].elite && saved.log[0].mutated.length === 2);
  const rep = await trainTaNet(D, { ...OPTS, statePath: state, log: (m) => logs.push(m) });
  assert.equal(rep.complete, true);
  assert.ok(rep.rounds > 2 && rep.newRounds === rep.rounds - 2, 'continued from the saved population');
  const p = rep.params;
  assert.equal(p.schema, TANET_SCHEMA);
  assert.equal(p.pbt.trials, rep.rounds * 3, 'every member evaluation is a trial');
  assert.ok(p.network.dsr.n > 0 && Number.isFinite(p.network.dsr.probability));
  assert.ok(p.network.regimes.length >= 1);
  // The planted autocorrelation is learned (direction right more often than not on the unseen holdout).
  assert.ok(p.heads.up_1h.validation.hitRate! > 0.52, `planted autocorrelation: ${JSON.stringify(p.heads.up_1h.validation)}`);
  assert.equal(p.heads.up_1h.validation.validated, p.heads.up_1h.validation.holdoutPassed && p.network.validated);
  assert.ok(logs.some((l) => /elite #\d/.test(l)));

  // Save / load / live forecast == offline forecast for the same bar.
  const file = path.join(dir, 'ta_net.json');
  fs.writeFileSync(file, JSON.stringify(p));
  const net = TaNet.load(file)!;
  const k = D.ts.length - 100;
  const off = forecast(D, p.dims, p.norm, Float64Array.from(p.weights), { gMicro: p.gates.micro, gTrend: p.gates.trend, gMacro: p.gates.macro }, [k]);
  const barTs = D.ts[k];
  const end = H1.findIndex((c) => c.ts === barTs) + 1;
  const set = new CandleSet('TST');
  const now = barTs + H + 60_000;
  set.add('1h', H1.slice(end - 299, end), now);
  set.add('1d', D1.filter((c) => c.ts + DAY <= now).slice(-299), now);
  set.add('15m', M15.filter((c) => c.ts + Q <= now).slice(-299), now);
  const rt = new TaNetRuntime(net, false);
  const o = rt.outputFor('TST', set, now)!;
  assert.ok(o, 'forecast from the first poll (299 closed hourly bars)');
  assert.equal(o.barTs, barTs);
  assert.ok(Math.abs(o.up[60]! - off.up1[0]) < 1e-4, `live ${o.up[60]} vs offline ${off.up1[0]}`);
  assert.ok(Math.abs(o.vol4h! - off.vol[0]) < 1e-3);
  assert.equal(rt.outputFor('TST', set, now), o, 'reused until a new bar arrives');
  assert.equal(rt.outputFor('TST', set, now + 10 * H), undefined, 'stale candles: no forecast');

  // Forward test: results recorded per hour; a failed test mutes the direction heads.
  const fwd = path.join(dir, 'fwd.json');
  const rt2 = new TaNetRuntime(net, false);
  rt2.enableForwardTest(fwd, now - 1, { days: 1, muteOnFail: true });
  const s2 = new CandleSet('TST');
  s2.add('1h', H1.slice(end - 299, end), now); s2.add('1d', D1.filter((c) => c.ts + DAY <= now).slice(-299), now); s2.add('15m', M15.filter((c) => c.ts + Q <= now).slice(-299), now);
  rt2.outputFor('TST', s2, now);
  for (let j = end; j < end + 30; j++) {
    const t = H1[j].ts + H + 60_000;
    s2.add('1h', [H1[j]], t); s2.add('15m', M15.filter((c) => c.ts >= H1[j].ts && c.ts < H1[j].ts + H), t);
    rt2.outputFor('TST', s2, t);
  }
  const st = rt2.forwardStatus(H1[end + 29].ts + 2 * H)!;
  assert.ok(st.days > 1 && ['confirmed', 'failed'].includes(st.status), JSON.stringify(st));
  assert.ok(fs.existsSync(fwd));

  // Feature registry reads the installed network; nothing without one.
  setTaNet(net, false);
  const fm = assetFeatureMap('TST', now, { candles: set });
  assert.ok(Math.abs(fm.tanet_up_1h - Math.log(o.up[60]! / (1 - o.up[60]!))) < 1e-9);
  setTaNet(undefined);
  assert.equal(activeTaNet(), undefined);
  assert.ok(Number.isNaN(assetFeatureMap('TST', now, { candles: set }).tanet_up_1h));
  fs.writeFileSync(file, JSON.stringify({ ...p, schema: '1' }));
  assert.throws(() => TaNet.load(file), /schema/);
});

test('pipeline: ta_net runs the tournament in chunks and promotes only when it reaches the present', async () => {
  const data = tmpDir();
  upsertSeries(path.join(data, 'history'), 'binance', 'TST', '15m', M15);
  const env = { DASHBOARD_TOKEN: 'x'.repeat(32), DATA_DIR: data, HISTORY_AUTO_UPDATE: 'false', TA_NET_TRAIN_MONTHS: '1.5', TA_NET_EVAL_MONTHS: '0.25', TA_NET_HOLDOUT_MONTHS: '0.5', TA_NET_STRIDE: '2', TA_NET_MIN_PER_REGIME: '5', TA_NET_STEP_MONTHS: '0.25' };
  const cfg = loadConfig({ ...env, TA_NET_MAX_ROUNDS_PER_RUN: '2' });
  const now = Date.UTC(2026, 9, 1);
  const r1 = await runPipeline({ cfg, only: ['history', 'ta_net'], log: () => undefined, now });
  const step = (r: typeof r1, n: string) => r.steps.find((s) => s.step === n)!;
  assert.equal(step(r1, 'history').skipped, 'HISTORY_AUTO_UPDATE=false');
  assert.match(String((step(r1, 'ta_net').detail as { reason?: string })?.reason), /in progress/);
  assert.equal(fs.existsSync(path.join(cfg.autoTrain.dir, 'ta_net.json')), false);
  const cfgAll = loadConfig({ ...env, TA_NET_MAX_ROUNDS_PER_RUN: '0' });
  const r2 = await runPipeline({ cfg: cfgAll, only: ['ta_net'], log: () => undefined, now: now + H });
  assert.ok(step(r2, 'ta_net').ok, step(r2, 'ta_net').error);
  assert.equal((step(r2, 'ta_net').detail as { promoted?: boolean }).promoted, true);
  assert.ok(fs.existsSync(path.join(cfgAll.autoTrain.dir, 'ta_net.json')));
  assert.equal(r2.state.taNetComplete, true);
  const r3 = await runPipeline({ cfg: cfgAll, only: ['ta_net'], log: () => undefined, now: now + 2 * H });
  assert.match(r3.steps[0].skipped ?? '', /trained 0\.0 day/);
  setTaNet(undefined);
});

void TANET_D1_BARS; void TANET_TREND_STEPS;

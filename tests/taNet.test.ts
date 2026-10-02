// TA network: features (identical offline and live), training with a blind walk-forward test on a
// planted signal, train/serve parity, the live runtime's grading, the feature registry, and the
// pipeline's history / ta_net steps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { assetFeatureMap } from '../bot/model/featureEngine';
import { CandleSet } from '../bot/ta/candleStore';
import type { Candle } from '../bot/ta/indicators';
import { activeTaNet, setTaNet, TANET_FEATURES, TANET_H1_BARS, TANET_SCHEMA, TaNet, TaNetRuntime, taNetFeatureMap, windowOk, type TaNetStateCache } from '../bot/ta/taNet';
import { aggregateCandles, upsertSeries } from '../research/history/candles';
import { runPipeline } from '../research/pipeline';
import { buildRows, headValue, trainTaNet } from '../research/trainTaNet';
import { tmpDir } from './helpers';

const H = 3_600_000;
const T0 = Date.UTC(2020, 0, 1);

/** Hourly candles whose returns are autocorrelated (phi) with clustered volatility: a learnable signal. */
function planted(n: number, seed = 3, phi = 0.35): Candle[] {
  let s = seed;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
  let p = 100, prev = 0, v = 0.006 ** 2;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    v = 0.000002 + 0.1 * prev * prev + 0.85 * v;
    const ret = phi * prev + Math.sqrt(v) * gauss();
    const o = p;
    p = p * Math.exp(ret);
    out.push({ ts: T0 + i * H, o, h: Math.max(o, p) * (1 + Math.abs(gauss()) * 0.001), l: Math.min(o, p) * (1 - Math.abs(gauss()) * 0.001), c: p, v: 100 * (1 + Math.abs(ret) * 50) * (0.5 + r()) });
    prev = ret;
  }
  return out;
}

const DATA = planted(4200);
const DAILY = aggregateCandles(DATA, H, 24 * H);

function historyDir(): string {
  const dir = tmpDir();
  upsertSeries(dir, 'binance', 'TST', '1h', DATA);
  return dir;
}

test('feature map: every input present, cache-identical, window checks', () => {
  const w = DATA.slice(1000 - TANET_H1_BARS + 1, 1001);
  const f = taNetFeatureMap('TST', w, DAILY);
  assert.deepEqual(Object.keys(f).sort(), [...TANET_FEATURES].sort());
  const finite = TANET_FEATURES.filter((k) => Number.isFinite(f[k])).length;
  assert.ok(finite > TANET_FEATURES.length * 0.85, `${finite}/${TANET_FEATURES.length} finite`);
  const cache: TaNetStateCache = {};
  for (let i = 1000; i < 1030; i++) {
    const win = DATA.slice(i - TANET_H1_BARS + 1, i + 1);
    const a = taNetFeatureMap('TST', win, DAILY, cache), b = taNetFeatureMap('TST', win, DAILY);
    for (const k of TANET_FEATURES) assert.ok(Object.is(a[k], b[k]), `${k} differs with the state cache at ${i}`);
  }
  // No look-ahead: changing bars after the window does not change the features.
  const later = DATA.map((c, i) => (i > 1000 ? { ...c, c: c.c * 2, h: c.h * 2 } : c));
  const g = taNetFeatureMap('TST', later.slice(1000 - TANET_H1_BARS + 1, 1001), aggregateCandles(later, H, 24 * H));
  for (const k of TANET_FEATURES) assert.ok(Object.is(f[k], g[k]), `${k} looked ahead`);
  assert.equal(windowOk(w), true);
  assert.equal(windowOk([...w.slice(0, 100), ...w.slice(120)]), false, 'a 20-hour outage inside the window');
});

test('training: candidates on validation, blind walk-forward test, validated head, train/serve parity', () => {
  const dir = historyDir();
  const rows = buildRows(dir, ['TST'], path.join(dir, '.cache'), () => undefined);
  assert.equal(rows.X.cols, TANET_FEATURES.length);
  assert.ok(rows.X.rows > 3800);
  const rep = trainTaNet(rows, { candidates: ['logistic', 'gbdt'], volCandidates: ['logistic'], refitMonths: 12 });
  const up = rep.params.heads.up_1h!;
  assert.equal(up.validation.validated, true, `planted autocorrelation should validate: ${JSON.stringify(up.validation)}`);
  assert.ok(up.validation.skill! > 0.01);
  assert.ok(up.candidates.some((c) => c.kind === 'base') && up.candidates.length === 3);
  assert.ok(rep.params.heads.vol_4h, 'vol head trained');
  assert.equal(rep.params.schema, TANET_SCHEMA);
  // Save / load / predict == trainer's evaluation of the same row.
  const file = path.join(dir, 'ta_net.json');
  fs.writeFileSync(file, JSON.stringify(rep.params));
  const net = TaNet.load(file)!;
  const i = rows.X.rows - 10;
  const bar = DATA.findIndex((c) => c.ts === rows.ts[i]);
  const f = taNetFeatureMap('TST', DATA.slice(bar - TANET_H1_BARS + 1, bar + 1), DAILY);
  const live = net.predict('up_1h', f);
  const offline = 1 / (1 + Math.exp(-headValue(up.head, rows.X, i)));
  assert.ok(Math.abs(live - offline) < 1e-4, `live ${live} vs offline ${offline}`);
  // The row cache is reused on a second build.
  const again = buildRows(dir, ['TST'], path.join(dir, '.cache'), () => undefined);
  assert.deepEqual(Array.from(again.X.data.subarray(0, 500)), Array.from(rows.X.data.subarray(0, 500)));
  // A model from another feature schema is refused.
  fs.writeFileSync(file, JSON.stringify({ ...rep.params, schema: '0' }));
  assert.throws(() => TaNet.load(file), /schema/);

  // Live runtime on a CandleSet (288+ closed hourly bars): forecasts, then grades them as bars close.
  const rt = new TaNetRuntime(net, false);
  const set = new CandleSet('TST');
  const end = 3000;
  set.add('1h', DATA.slice(end - 299, end), DATA[end].ts + 60_000);
  set.add('1d', DAILY.filter((c) => c.ts + 24 * H <= DATA[end].ts), DATA[end].ts + 60_000);
  const o1 = rt.outputFor('TST', set, DATA[end].ts + 60_000)!;
  assert.ok(o1, 'output from the first poll (299 closed bars)');
  assert.equal(o1.barTs, DATA[end - 1].ts);
  assert.ok(o1.up[60]! > 0 && o1.up[60]! < 1);
  assert.ok(Number.isFinite(o1.vol4h!));
  for (let k = end; k < end + 40; k++) set.add('1h', [DATA[k]], DATA[k].ts + H + 60_000);
  const o2 = rt.outputFor('TST', set, DATA[end + 39].ts + H + 60_000)!;
  assert.ok(o2.graded[60]! >= 24 && Number.isFinite(o2.skill[60]!), `graded ${o2.graded[60]}`);
  assert.equal(rt.outputFor('TST', set, DATA[end + 39].ts + 10 * H), undefined, 'stale candles: no forecast');
  assert.equal(rt.outputFor('TST', set, DATA[end + 39].ts + H + 60_000), o2, 'reused until a new bar arrives');
  // Replaying an earlier span in the same process: no skill from calls graded after `now`.
  const early = new CandleSet('TST');
  early.add('1h', DATA.slice(end - 299, end), DATA[end].ts + 60_000);
  early.add('1d', DAILY.filter((c) => c.ts + 24 * H <= DATA[end].ts), DATA[end].ts + 60_000);
  const back = rt.outputFor('TST', early, DATA[end].ts + 60_000)!;
  assert.equal(back.graded[60], o1.graded[60]);
  assert.ok(Math.abs(back.up[60]! - o1.up[60]!) < 1e-12);
  // Validated-only runtime hides heads that did not validate.
  const strict = new TaNetRuntime(net, true);
  const o3 = strict.outputFor('TST', set, DATA[end + 39].ts + H + 60_000)!;
  for (const [h, k] of [[60, 'up_1h'], [240, 'up_4h']] as const) assert.equal(Number.isFinite(o3.up[h]!), Boolean(rep.params.heads[k]?.validation.validated));

  // Feature registry: tanet_* read the installed network, NaN without one.
  setTaNet(net, false);
  const fm = assetFeatureMap('TST', DATA[end + 39].ts + H + 60_000, { candles: set });
  assert.ok(Number.isFinite(fm.tanet_up_1h) && Number.isFinite(fm.tanet_vol_4h) && Number.isFinite(fm.tanet_skill_1h));
  assert.ok(Math.abs(fm.tanet_up_1h - Math.log(o2.up[60]! / (1 - o2.up[60]!))) < 1e-9);
  setTaNet(undefined);
  assert.equal(activeTaNet(), undefined);
  assert.ok(Number.isNaN(assetFeatureMap('TST', DATA[end + 39].ts + H + 60_000, { candles: set }).tanet_up_1h));
});

test('pipeline: history step obeys HISTORY_AUTO_UPDATE; ta_net trains, promotes, then waits until due', async () => {
  const data = tmpDir();
  const hist = path.join(data, 'history');
  upsertSeries(hist, 'binance', 'TST', '1h', DATA);
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), DATA_DIR: data, HISTORY_AUTO_UPDATE: 'false', TA_NET_REFIT_MONTHS: '12' });
  const now = Date.UTC(2026, 9, 1);
  const r = await runPipeline({ cfg, only: ['history', 'ta_net'], log: () => undefined, now });
  const step = (n: string) => r.steps.find((s) => s.step === n)!;
  assert.equal(step('history').skipped, 'HISTORY_AUTO_UPDATE=false');
  assert.ok(step('ta_net').ok && !step('ta_net').skipped, step('ta_net').error);
  const promotedFile = path.join(cfg.autoTrain.dir, 'ta_net.json');
  assert.ok(fs.existsSync(promotedFile));
  assert.equal(r.state.taNetVersion, TaNet.load(promotedFile)!.version);
  assert.ok(activeTaNet(), 'installed for the steps that follow');
  const r2 = await runPipeline({ cfg, only: ['ta_net'], log: () => undefined, now: now + 3_600_000 });
  assert.match(r2.steps[0].skipped ?? '', /trained 0\.0 day/);
  const r3 = await runPipeline({ cfg, only: ['ta_net'], forceTaNet: true, log: () => undefined, now: now + 7_200_000 });
  assert.ok(r3.steps[0].ok && !r3.steps[0].skipped);
  // No history: skipped with instructions.
  const empty = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), DATA_DIR: tmpDir(), HISTORY_AUTO_UPDATE: 'false' });
  const r4 = await runPipeline({ cfg: empty, only: ['ta_net'], log: () => undefined, now });
  assert.match(r4.steps[0].skipped ?? '', /no history/);
  setTaNet(undefined);
});

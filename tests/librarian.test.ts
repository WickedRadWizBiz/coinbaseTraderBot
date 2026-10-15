import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { LIB_INPUTS, LIB_SCHEMA, LIB_SETUP_KEYS, LIB_STRATEGIES, Librarian, libSetupFeatures, rowPositions, strategyPositions } from '../bot/ta/librarian';
import { TANET_FEATURES } from '../bot/ta/taNet';
import { SETUP_FEATURES, SETUP_GROUPS } from '../bot/setups/features';
import { LibIndex, libRows, loadLibForecasts, trainLibrarianOn } from '../research/librarian';
import type { TaNetData } from '../research/trainTaNet';
import { rng } from '../research/stats';
import { tmpDir } from './helpers';

const H = 3_600_000, D = 86_400_000;
const T0 = Date.UTC(2021, 0, 1);
const F = (k: string) => { const i = TANET_FEATURES.indexOf(k); assert.ok(i >= 0, k); return i; };
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * One coin, `days` of hourly bars in 24-hour blocks. Each block has a trend position (h4_ema_stack) and a revert
 * position (h1_bb_pctb beyond the band); which of them the block's drift follows is drawn per block and shown by
 * h1_adx (+1 trend, -1 revert), so neither the last block's winner nor a slow regime label knows it. `signal` false:
 * the drift ignores the families. Day regimes change after segments of 4-20 days, and h1_bb_bw_rank is 1 in the 72 h
 * before each change.
 */
function world(days: number, seed: number, signal = true): { Dt: TaNetData; labels: Map<string, Map<string, string>> } {
  const r = rng(seed);
  const n = days * 24, NF = TANET_FEATURES.length;
  const X = new Float32Array(n * NF);
  const h1: Array<{ ts: number; o: number; h: number; l: number; c: number; v: number }> = [];
  // Day labels with known change days.
  const lab = new Map<string, string>(), changes: number[] = [];
  let key = 'calm', d = 0;
  while (d < days) { const len = 4 + Math.floor(r() * 17); for (let k = 0; k < len && d < days; k++, d++) lab.set(iso(T0 + d * D), key); if (d < days) { changes.push(T0 + d * D); key = key === 'calm' ? 'trending' : 'calm'; } }
  let c = 100;
  let tp = 1, rp = 1, reg = 1;
  for (let i = 0; i < n; i++) {
    const ts = T0 + i * H;
    if (i % 24 === 0) { tp = r() < 0.5 ? 1 : -1; rp = r() < 0.5 ? 1 : -1; reg = r() < 0.5 ? 1 : -1; }
    const off = i * NF;
    X[off + F('h4_ema_stack')] = tp;
    X[off + F('h1_bb_pctb')] = -0.5 * rp;
    X[off + F('h1_adx')] = reg + 0.3 * gauss(r);
    X[off + F('h1_bb_bw_rank')] = (changes.some((t) => t > ts && t <= ts + 72 * H) ? 1 : 0) + 0.2 * gauss(r);
    X[off + F('h1_rsi')] = 0.1 * gauss(r);
    X[off + F('net_all')] = gauss(r);
    const pos = reg > 0 ? tp : rp;
    const ret = (signal ? (0.03 / 24) * pos : 0) + 0.003 * gauss(r);
    const o = c; c = c * Math.exp(ret);
    h1.push({ ts, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1 });
  }
  const rowTs = h1.map((b) => b.ts);
  const Dt = { assets: [{ asset: 'BTC', rowTs, X, h1, h1Idx: new Map(rowTs.map((t, i) => [t, i])), dayVec: new Map(), dayDom: new Map(), d1: [] }] } as unknown as TaNetData;
  return { Dt, labels: new Map([['BTC', lab]]) };
}

test('Librarian: family positions come from the TA readings the bot trades on', () => {
  const f = (m: Record<string, number>) => strategyPositions((k) => m[k] ?? NaN);
  assert.deepEqual(f({ h4_ema_stack: 1, h1_bb_pctb: 0.48, h1_donchian: 1 }), [1, -1, 1, 0]);
  assert.deepEqual(f({ h1_ema_stack: -1, h1_rsi: -0.5, h1_squeeze_release: 1, h1_bb_pctb: -0.2 }), [-1, 1, -1, 0], '1h stack without 4h; RSI 25 fades up; a release follows %B');
  assert.deepEqual(f({}), [0, 0, 0, 0]);
  const row = new Array(TANET_FEATURES.length).fill(NaN);
  row[F('h4_ema_stack')] = -1;
  assert.deepEqual(rowPositions(row), [-1, 0, 0, 0]);
  assert.equal(LIB_INPUTS.length, TANET_FEATURES.length + 3);
});

test('Librarian: oracle labels are soft, net of the round trip, and the transition label looks 72 h ahead', () => {
  const { Dt, labels } = world(60, 3);
  const rows = libRows(Dt, labels);
  assert.ok(rows.length > 300);
  for (const x of rows.slice(0, 50)) {
    assert.ok(Math.abs(x.y.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.ok(Math.abs(x.R[3]) === 0, 'flat earns nothing');
    assert.ok(x.R[0] === x.pos[0] * x.fwd - 0.001 * Math.abs(x.pos[0]));
  }
  // The last 72 h of labels cannot be known: NaN there.
  const lastDay = Date.UTC(2021, 0, 1) + 59 * D;
  assert.ok(rows.filter((x) => x.ts + 72 * H > lastDay + D).every((x) => Number.isNaN(x.trans)));
  assert.ok(rows.some((x) => x.trans === 1) && rows.some((x) => x.trans === 0));
});

test('Librarian: learns which family pays and when the regime turns, beats persistence out of sample, writes forecasts, loads', () => {
  const { Dt, labels } = world(700, 5);
  const hist = tmpDir();
  const rep = trainLibrarianOn(Dt, labels, { hist, firstDays: 240, stepDays: 60, epochsFirst: 8, epochsStep: 3, epochsFinal: 4 });
  const s = rep.grade.strategy, t = rep.grade.transition;
  assert.equal(s.validated, true, JSON.stringify(s));
  assert.ok(s.sharpeLib > s.sharpeRegime && s.sharpeLib > s.sharpeWinner && s.ceLib < s.ceRegime, JSON.stringify(s));
  assert.equal(t.validated, true, JSON.stringify(t));
  assert.ok(t.llLib < t.llHazard, JSON.stringify(t));
  assert.equal(rep.params.strategy.validation.validated, true);
  // The final model reads the readings the right way.
  const lib = new Librarian(rep.params);
  const row = new Array(TANET_FEATURES.length).fill(0);
  row[F('h4_ema_stack')] = 1; row[F('h1_bb_pctb')] = 0.5;
  const trendDay = lib.predict(Object.assign([...row], { [F('h1_adx')]: 1 })), revertDay = lib.predict(Object.assign([...row], { [F('h1_adx')]: -1 }));
  assert.ok(trendDay.w[0] > trendDay.w[1] + 0.1 && revertDay.w[1] > revertDay.w[0] + 0.1, JSON.stringify({ trendDay: trendDay.w, revertDay: revertDay.w }));
  assert.ok(trendDay.net > 0.1 && revertDay.net < -0.1, `long with the trend, short to fade %B at the top (${trendDay.net}, ${revertDay.net})`);
  const calm = lib.predict(Object.assign([...row], { [F('h1_bb_bw_rank')]: 0 })), turning = lib.predict(Object.assign([...row], { [F('h1_bb_bw_rank')]: 1 }));
  assert.ok(turning.transition > calm.transition + 0.2, `${calm.transition} -> ${turning.transition}`);
  // Saved and loaded; a file for other inputs is refused.
  const file = path.join(hist, 'librarian.json');
  fs.writeFileSync(file, JSON.stringify(rep.params));
  assert.ok(Librarian.load(file));
  fs.writeFileSync(file, JSON.stringify({ ...rep.params, inputs: rep.params.inputs.slice(1) }));
  assert.throws(() => Librarian.load(file), /other inputs/);
  fs.writeFileSync(file, JSON.stringify({ ...rep.params, schema: 'old' }));
  assert.throws(() => Librarian.load(file), /schema/);
  // The walk's forecasts: every hour after the first fit, looked up at the last closed hour.
  const fc = loadLibForecasts(hist)!;
  assert.equal(fc.schema, LIB_SCHEMA);
  assert.ok(fc.assets.BTC.length > 400 * 24, `${fc.assets.BTC.length} hours`);
  const idx = new LibIndex(fc);
  const [t0, ...v] = fc.assets.BTC[100];
  const got = idx.at('BTC', t0 + H + 5 * 60_000)!;
  assert.deepEqual(got.w, v.slice(0, 4));
  assert.deepEqual(idx.at('BTC', t0)!.w, fc.assets.BTC[99].slice(1, 5), 'at the bar\'s own open time the bar before it is the last closed one');
});

test('Librarian: a world where no family has an edge does not validate', () => {
  const { Dt, labels } = world(500, 8, false);
  const rep = trainLibrarianOn(Dt, labels, { firstDays: 240, stepDays: 60, epochsFirst: 6, epochsStep: 2, epochsFinal: 2 });
  assert.equal(rep.grade.strategy.validated, false, JSON.stringify(rep.grade.strategy));
});

test('Librarian: setup inputs are an optional group, blank without a reading', () => {
  assert.deepEqual(SETUP_GROUPS.librarian, LIB_SETUP_KEYS);
  assert.ok(LIB_SETUP_KEYS.every((k) => SETUP_FEATURES.includes(k)));
  const out: Record<string, number> = {};
  libSetupFeatures(out, -1, { w: [0.6, 0.2, 0.1, 0.1], net: 0.5, vsBook: -0.4, transition: 0.3 });
  assert.equal(out.lib_trend, 0.6); assert.equal(out.lib_flat, 0.1);
  assert.equal(out.o_lib_net, -0.5); assert.equal(out.o_lib_vs_book, 0.4); assert.equal(out.lib_trans, 0.3);
  libSetupFeatures(out, 1, undefined);
  assert.ok(LIB_SETUP_KEYS.every((k) => Number.isNaN(out[k])));
  assert.equal(LIB_STRATEGIES.length, 4);
});

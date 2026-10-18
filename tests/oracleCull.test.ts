// The Oracle cull (research/oracleCull.ts): a TA reading that tells which strategy family pays is proven, readings
// that tell nothing are culled; the TA network reads culled inputs as absent and the Librarian fits without them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIB_INPUTS } from '../bot/ta/librarian';
import { CULLED_STD, cullNorm, TANET_CTX_FEATURES, TANET_DAY_FEATURES, TANET_FEATURES, TANET_TREND_FEATURES } from '../bot/ta/taNet';
import { trainLibrarianOn } from '../research/librarian';
import { bhPass, blockBootstrap, oracleCullOn, readCull } from '../research/oracleCull';
import { rng } from '../research/stats';
import type { TaNetData } from '../research/trainTaNet';
import { tmpDir } from './helpers';
import fs from 'node:fs';
import path from 'node:path';

const H = 3_600_000, D = 86_400_000;
const T0 = Date.UTC(2020, 0, 1);
const F = (k: string) => TANET_FEATURES.indexOf(k);
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** One coin: each day either trend (h4_ema_stack's side) or mean-revert (h1_bb_pctb's fade) pays, which one shown by
 *  h1_adx; h1_rsi is pure noise; every other reading is constant. */
function world(days: number, seed: number): { Dt: TaNetData; labels: Map<string, Map<string, string>> } {
  const r = rng(seed), n = days * 24, NF = TANET_FEATURES.length;
  const X = new Float32Array(n * NF);
  const h1: Array<{ ts: number; o: number; h: number; l: number; c: number; v: number }> = [];
  const lab = new Map<string, string>();
  for (let d = 0; d < days; d++) lab.set(iso(T0 + d * D), Math.floor(d / 10) % 2 ? 'calm' : 'trending');
  let c = 100, tp = 1, rp = 1, reg = 1;
  for (let i = 0; i < n; i++) {
    const ts = T0 + i * H;
    if (i % 24 === 0) { tp = r() < 0.5 ? 1 : -1; rp = r() < 0.5 ? 1 : -1; reg = r() < 0.5 ? 1 : -1; }
    const off = i * NF;
    X[off + F('h4_ema_stack')] = tp;
    X[off + F('h1_bb_pctb')] = -0.5 * rp;
    X[off + F('h1_adx')] = reg + 0.3 * gauss(r);
    X[off + F('h1_rsi')] = 0.1 * gauss(r);
    const ret = (0.03 / 24) * (reg > 0 ? tp : rp) + 0.003 * gauss(r);
    const o = c; c = c * Math.exp(ret);
    h1.push({ ts, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1 });
  }
  const rowTs = h1.map((b) => b.ts);
  return { Dt: { assets: [{ asset: 'BTC', rowTs, X, h1, h1Idx: new Map(rowTs.map((t, i) => [t, i])), dayVec: new Map(), dayDom: new Map(), d1: [] }] } as unknown as TaNetData, labels: new Map([['BTC', lab]]) };
}

test('oracle cull: the reading that shows which strategy pays is proven, noise and constant readings are culled', () => {
  const { Dt, labels } = world(560, 4);
  const f = oracleCullOn(Dt, labels, { firstDays: 300 });
  const it = (k: string) => f.items.find((x) => x.name === k)!;
  assert.equal(it('h1_adx').verdict, 'proven', JSON.stringify(it('h1_adx')));
  assert.ok(it('h1_adx').gain > 0 && it('h1_adx').lo > 0);
  assert.notEqual(it('h1_rsi').verdict, 'proven');
  assert.equal(it('h1_cdl_doji').verdict, 'culled', 'a reading that never changes tells nothing');
  assert.ok(f.culled.length > TANET_FEATURES.length / 2 && !f.culled.includes('h1_adx'));
  assert.equal(f.items.length, TANET_FEATURES.length);
  // Strict level: everything not proven is culled.
  const strict = oracleCullOn(Dt, labels, { firstDays: 300, level: 'unproven' });
  assert.equal(strict.culled.length, TANET_FEATURES.length - strict.proven.length);
  // The file round-trips.
  const file = path.join(tmpDir(), 'cull.json');
  fs.writeFileSync(file, JSON.stringify(f));
  assert.deepEqual(readCull(file), f.culled);
  assert.deepEqual(readCull(path.join(tmpDir(), 'missing.json')), []);
});

test('oracle cull statistics: Benjamini-Hochberg and the weekly-block bootstrap', () => {
  assert.deepEqual(bhPass([0.001, 0.2, 0.01, 0.9], 0.1), [true, false, true, false]);
  const pos = Array.from({ length: 200 }, (_, d) => ({ day: d, s: 0.01 * 5, n: 5 }));
  const b = blockBootstrap(pos);
  assert.ok(b.mean > 0 && b.lo > 0 && b.p < 0.01);
  const r = rng(3), noise = Array.from({ length: 200 }, (_, d) => ({ day: d, s: gauss(r), n: 5 }));
  assert.ok(blockBootstrap(noise).p > 0.01);
});

test('a culled reading reaches the TA network as absent; the raw statistics are kept', () => {
  const mk = (n: number) => ({ mean: Array.from({ length: n }, () => 3), std: Array.from({ length: n }, () => 2) });
  const norm = { trend: mk(TANET_TREND_FEATURES.length), macro: mk(TANET_DAY_FEATURES.length), micro: mk(4), swing: mk(4), ctx: mk(TANET_CTX_FEATURES.length) };
  const k = TANET_TREND_FEATURES[5], c = TANET_CTX_FEATURES[2];
  const out = cullNorm(norm, [k, c]);
  const j = TANET_TREND_FEATURES.indexOf(k), jc = TANET_CTX_FEATURES.indexOf(c);
  assert.equal(out.trend.std[j], CULLED_STD);
  assert.ok(Math.abs((60 - out.trend.mean[j]) / out.trend.std[j]) < 1e-200, 'any value normalises to ~0');
  assert.equal(out.ctx.std[jc], CULLED_STD);
  assert.equal(out.trend.std[j + 1], 2, 'other readings untouched');
  assert.equal(norm.trend.std[j], 2, 'the raw statistics are not changed');
  assert.equal(Math.fround(CULLED_STD), Infinity, 'float32 (PyTorch) divides it to exactly 0');
  assert.equal(cullNorm(norm, []), norm);
});

test('the Librarian fits and forecasts without the culled inputs', () => {
  const { Dt, labels } = world(400, 7);
  const rep = trainLibrarianOn(Dt, labels, { firstDays: 240, stepDays: 60, epochsFirst: 3, epochsStep: 1, epochsFinal: 1, cull: ['h1_adx', 'not_a_reading'] });
  const i = LIB_INPUTS.indexOf('h1_adx');
  assert.equal(rep.params.std[i], 0, 'zero spread: z = 0 in every forecast');
  assert.ok(rep.params.std[LIB_INPUTS.indexOf('h1_rsi')] > 0);
  assert.deepEqual(rep.params.cull, ['h1_adx']);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { XG_DIMS, xgBackward, xgForward, xgInit, xgLayout, type XgGraph } from '../bot/ta/crossGraph';
import { rng } from '../research/stats';
import fs from 'fs';
import path from 'path';
import { CrossGraph, XG_SCHEMA, XG_SETUP_KEYS, xgGraph, XgMemo, xgSeries, xgSetupFeatures, type XgSeries } from '../bot/ta/crossGraph';
import { fitCrossGraph, loadXgForecasts, torchForward, torchPython, trainCrossGraphOn, xgNorms, xgSamples, XgIndex } from '../research/trainCrossGraph';
import { tmpDir } from './helpers';
function randomGraph(n: number, seed: number): XgGraph {
  const r = rng(seed);
  const x = Float64Array.from({ length: n * XG_DIMS.F }, () => 2 * r() - 1);
  const corr = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) corr[i * n + j] = corr[j * n + i] = i === j ? 1 : 2 * r() - 1;
  return { n, x, corr };
}

test('cross graph: the backward pass matches finite differences for every weight', () => {
  const g = randomGraph(5, 3), w = xgInit(7);
  w[xgLayout().beta] = 0.7;
  const target = Float64Array.from({ length: 5 * XG_DIMS.O }, (_, i) => (i === 3 ? NaN : Math.sin(i)));
  const loss = (ww: Float64Array) => { const c = xgForward(ww, g); let s = 0; for (let i = 0; i < target.length; i++) if (Number.isFinite(target[i])) s += (c.y[i] - target[i]) ** 2; return s; };
  const grad = new Float64Array(w.length);
  const r = xgBackward(w, g, xgForward(w, g), target, grad);
  assert.equal(r.count, target.length - 1);
  assert.ok(Math.abs(r.loss - loss(w)) < 1e-12);
  let worst = 0;
  for (let k = 0; k < w.length; k++) {
    const e = 1e-6, wp = Float64Array.from(w), wm = Float64Array.from(w);
    wp[k] += e; wm[k] -= e;
    const num = (loss(wp) - loss(wm)) / (2 * e);
    worst = Math.max(worst, Math.abs(num - grad[k]) / (1e-6 + 1e-3 * Math.abs(num)));
  }
  assert.ok(worst < 1, `largest gradient error (in units of 1e-6 + 0.1% of the gradient): ${worst}`);
});


const H = 3_600_000;
const T0 = Date.UTC(2021, 0, 1);
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());

/** Eight coins in two clusters (market + cluster + own noise). With `kappa`, a coin that lagged its cluster over the last
 *  24 hours catches up over the next day: visible only through the neighbours it moves with. */
function market(days: number, seed: number, kappa: number): XgSeries[] {
  const r = rng(seed), N = 8, T = days * 24;
  const rets: number[][] = Array.from({ length: N }, () => []);
  const px = Array.from({ length: N }, () => 100);
  const bars: Array<Array<{ ts: number; o: number; h: number; l: number; c: number; v: number; tb: number }>> = Array.from({ length: N }, () => []);
  for (let t = 0; t < T; t++) {
    const m = gauss(r), cl = [gauss(r), gauss(r)];
    const r24 = rets.map((x) => x.slice(-24).reduce((a, v) => a + v, 0));
    const mean = r24.reduce((a, v) => a + v, 0) / N;
    for (let i = 0; i < N; i++) {
      const k = i < 4 ? 0 : 1, mates = [0, 1, 2, 3].map((q) => q + 4 * k).filter((q) => q !== i);
      const mateRel = mates.reduce((a, q) => a + r24[q] - mean, 0) / mates.length, own = r24[i] - mean;
      const ret = (t >= 24 ? (kappa * (mateRel - own)) / 24 : 0) + 0.004 * (0.6 * m + 0.6 * cl[k] + 0.5 * gauss(r));
      rets[i].push(ret);
      const o = px[i]; px[i] *= Math.exp(ret);
      bars[i].push({ ts: T0 + t * H, o, h: Math.max(o, px[i]), l: Math.min(o, px[i]), c: px[i], v: 100, tb: 50 });
    }
  }
  return bars.map((b, i) => xgSeries(`C${i}`, b));
}

test('cross graph: learns a catch-up that only the neighbours reveal, beats momentum / reversal out of sample, writes forecasts, loads', () => {
  const hist = tmpDir();
  const series = market(720, 4, 1);
  const rep = trainCrossGraphOn(series, { hist, engine: 'ts', firstDays: 200, stepDays: 90, epochsFirst: 25, epochsStep: 5, epochsFinal: 5, minDays: 100 });
  const v = rep.params.validation;
  assert.equal(v.validated, true, JSON.stringify(v));
  assert.ok((v.icModel as number) > (v.icBaseline as number) + 0.05, JSON.stringify(v));
  assert.ok((v.book as number) > 0);
  assert.equal(rep.params.engine, 'ts');
  const file = path.join(hist, 'cg.json');
  fs.writeFileSync(file, JSON.stringify(rep.params));
  const model = CrossGraph.load(file)!;
  const bar = series[0].h1[series[0].h1.length - 30].ts;
  const out = model.predict(series, bar);
  assert.equal(out.size, 8);
  const ranks = [...out.values()].map((x) => x.rank).sort((a, b) => a - b);
  assert.equal(ranks[0], -1); assert.equal(ranks[7], 1);
  fs.writeFileSync(file, JSON.stringify({ ...rep.params, schema: 'old' }));
  assert.throws(() => CrossGraph.load(file), /schema/);
  // Live: a coin whose newest bar has not arrived yet is missing, and the forecast is redone once it arrives.
  const memo = new XgMemo();
  const last = series[0].h1[series[0].h1.length - 1].ts, now = last + H + 60_000;
  const sets = series.map((x): [string, typeof x.h1] => [x.asset, x.h1]);
  const late = sets.map(([a, cs], i): [string, typeof cs] => [a, i === 3 ? cs.slice(0, -1) : cs]);
  assert.equal(memo.get(model, late, now, 'C3'), undefined);
  assert.ok(memo.get(model, late, now, 'C0'));
  assert.ok(memo.get(model, sets, now, 'C3'), 'redone when the late bar arrives');
  const fc = loadXgForecasts(hist)!;
  assert.equal(fc.schema, XG_SCHEMA);
  const idx = new XgIndex(fc);
  const [t0, ...vals] = fc.assets.C0[50];
  assert.deepEqual(idx.at('C0', t0 + H + 60_000), { rel4: vals[0], rel24: vals[1], rank: vals[2] });
});

test('cross graph: a market with nothing to learn does not validate; setup inputs are an oriented optional group', () => {
  const series = market(420, 5, 0);
  const rep = trainCrossGraphOn(series, { engine: 'ts', firstDays: 200, stepDays: 90, epochsFirst: 15, epochsStep: 3, epochsFinal: 2, minDays: 100 });
  assert.equal(rep.params.validation.validated, false, JSON.stringify(rep.params.validation));
  const out: Record<string, number> = {};
  xgSetupFeatures(out, -1, { rel4: 0.2, rel24: 0.5, rank: 1 });
  assert.equal(out.o_xg_rel24, -0.5); assert.equal(out.o_xg_rank, -1);
  xgSetupFeatures(out, 1, undefined);
  assert.ok(XG_SETUP_KEYS.every((k) => Number.isNaN(out[k])));
});

const PY = torchPython();

test('cross graph: the PyTorch engine computes the same network (parity on identical weights)', { skip: PY ? false : 'no Python with PyTorch and numpy' }, () => {
  const samples = xgSamples(market(40, 6, 1)).slice(-20);
  const norm = xgNorms(samples), w = xgInit(5);
  w[xgLayout().beta] = 1.3;
  const t = torchForward(samples, norm, w, PY!);
  let worst = 0;
  samples.forEach((q, s) => {
    const c = xgForward(w, xgGraph({ norm }, q.x, q.corr));
    for (let i = 0; i < q.assets.length; i++) for (let o = 0; o < XG_DIMS.O; o++) worst = Math.max(worst, Math.abs(c.y[i * XG_DIMS.O + o] - t.out[(s * t.N + i) * XG_DIMS.O + o]));
  });
  assert.ok(worst < 1e-9, `largest difference ${worst}`);
});

test('cross graph: PyTorch training lowers the loss and its weights run in the TypeScript network', { skip: PY ? false : 'no Python with PyTorch and numpy' }, () => {
  const samples = xgSamples(market(200, 7, 1)).filter((q) => q.y.some(Number.isFinite));
  const lossOf = (w: Float64Array, norm: { mean: number[]; std: number[] }) => {
    let l = 0, n = 0;
    for (const q of samples) { const c = xgForward(w, xgGraph({ norm }, q.x, q.corr)); q.y.forEach((y, k) => { if (Number.isFinite(y)) { l += (c.y[k] - y) ** 2; n++; } }); }
    return l / n;
  };
  const fit = fitCrossGraph(samples, { epochs: 8, engine: 'torch', python: PY, seed: 3 });
  assert.equal(fit.engine, 'torch');
  assert.ok(lossOf(fit.w, fit.norm) < 0.97 * lossOf(xgInit(3), fit.norm), `${lossOf(xgInit(3), fit.norm)} -> ${lossOf(fit.w, fit.norm)}`);
});

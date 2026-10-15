// Trains the cross-asset graph network (bot/ta/crossGraph.ts) walk-forward over all hourly history and grades it.
//
//   samples   every LIB-style 4th hour with 3+ coins: each coin's relative-return inputs, the coins' 168 h return
//             correlations (the edges), and each coin's relative return over the next 4 and 24 hours in volatility units
//   walk      the first fit on XG_FIRST_DAYS, then a warm-started refit every XG_STEP_DAYS on every sample whose 24 h
//             label had closed, each fit forecasting every hour of the next step unseen
//   engine    PyTorch (python/xgraph/train.py) when XG_ENGINE is torch, or auto and a Python with PyTorch is found;
//             TypeScript otherwise (the same model, the same flat weights)
//   grading   one decision a day at midnight UTC, on the walk's forecasts only: the cross-sectional correlation (IC)
//             of the forecast 24 h relative return with what happened, against the better of momentum and reversal
//             of the 24 h relative return (its sign chosen on the rows each fit saw), and a long-short book (the top
//             quarter of coins long, the bottom quarter short, equal weights, 10 bps per name changed). It validates
//             when its IC edge over the baseline has a daily bootstrap 95% lower bound above 0 on 120+ days and the
//             book made money after costs.
//   output    params (the final fit on every sample) with the grading; <history>/.xgraph/forecasts.json, the walk's
//             forecasts per coin and hour (the setup scorer's "xgraph" inputs)
//
//   npm run research:xgraph -- --history data/history [--out params/cross_graph.json] [--engine auto]

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CrossGraph, XG_DIMS, XG_F, XG_HORIZONS, XG_INPUTS, XG_LOOKBACK_H, XG_SCHEMA, xgBackward, xgCorr, xgForward, xgGraph, xgInit, xgLayout, xgRawInputs, xgSeries, xgTargets, type XgParams, type XgSeries } from '../bot/ta/crossGraph';
import { loadHistory, storedAssets } from './history/candles';
import { dayBootstrap } from './trainTaNet';

const H = 3_600_000;
const D = 86_400_000;
export const XG_STRIDE_H = 4;
export const XG_FIRST_DAYS = 730;
export const XG_STEP_DAYS = 91;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export interface XgSample { bar: number; assets: string[]; x: number[][]; corr: Float64Array; y: number[] /* n x O */ }

/** The hourly bars every coin's inputs need. */
export function loadXgSeries(hist: string, assets: string[] = storedAssets(hist)): XgSeries[] {
  return assets.map((a) => xgSeries(a, loadHistory(hist, a, ['1h'])['1h'] ?? [])).filter((s) => s.h1.length > XG_LOOKBACK_H + 48);
}

/** All bar times any coin has, from the first with enough lookback. */
function barTimes(series: XgSeries[]): number[] {
  const t = new Set<number>();
  for (const s of series) for (let i = XG_LOOKBACK_H; i < s.h1.length; i++) t.add(s.h1[i].ts);
  return [...t].sort((a, b) => a - b);
}

/** Samples every `stride` hours (3+ coins; targets NaN where the future is not there yet). */
export function xgSamples(series: XgSeries[], stride = XG_STRIDE_H): XgSample[] {
  const out: XgSample[] = [];
  for (const bar of barTimes(series)) {
    if (Math.floor(bar / H) % stride !== 0) continue;
    const { assets, x, ret1 } = xgRawInputs(series, bar);
    if (assets.length < 3) continue;
    const ys = XG_HORIZONS.map((hh) => xgTargets(series, assets, bar, hh));
    const y: number[] = [];
    assets.forEach((_, i) => { for (const t of ys) y.push(t[i]); });
    out.push({ bar, assets, x, corr: xgCorr(assets, ret1), y });
  }
  return out;
}

function norms(samples: XgSample[]): { mean: number[]; std: number[] } {
  const s = new Array(XG_F).fill(0), ss = new Array(XG_F).fill(0), n = new Array(XG_F).fill(0);
  for (const q of samples) for (const row of q.x) row.forEach((v, f) => { if (Number.isFinite(v)) { s[f] += v; ss[f] += v * v; n[f]++; } });
  const mean = s.map((v, f) => (n[f] ? v / n[f] : 0));
  return { mean, std: ss.map((v, f) => { const sd = n[f] > 10 ? Math.sqrt(Math.max(0, v / n[f] - mean[f] ** 2)) : 0; return sd > 1e-9 ? sd : 0; }) };
}

export interface XgFit { w: Float64Array; norm: { mean: number[]; std: number[] }; loss: number; engine: 'ts' | 'torch' }
export interface XgFitOpts { epochs: number; init?: Float64Array; lr?: number; l2?: number; batch?: number; seed?: number; engine?: 'ts' | 'torch' | 'auto'; python?: string }

/** Adam over graphs in minibatches (TypeScript). */
function fitTs(samples: XgSample[], norm: XgFit['norm'], o: XgFitOpts): XgFit {
  const L = xgLayout(), w = o.init ? Float64Array.from(o.init) : xgInit(o.seed ?? 1);
  const m = new Float64Array(L.size), v = new Float64Array(L.size), g = new Float64Array(L.size);
  const lr = o.lr ?? 3e-3, l2 = o.l2 ?? 1e-4, B = o.batch ?? 32;
  const graphs = samples.map((q) => xgGraph({ norm }, q.x, q.corr));
  let s = (o.seed ?? 1) >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const order = samples.map((_, i) => i);
  let step = 0, last = NaN;
  for (let ep = 0; ep < o.epochs; ep++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let tot = 0, cnt = 0;
    for (let b0 = 0; b0 < order.length; b0 += B) {
      g.fill(0);
      let c = 0;
      for (let k = b0; k < Math.min(order.length, b0 + B); k++) {
        const q = order[k], r = xgBackward(w, graphs[q], xgForward(w, graphs[q]), samples[q].y, g);
        tot += r.loss; c += r.count;
      }
      cnt += c;
      if (!c) continue;
      step++;
      const c1 = 1 - 0.9 ** step, c2 = 1 - 0.999 ** step;
      for (let k = 0; k < L.size; k++) {
        const gk = g[k] / c + (k === L.beta ? 0 : l2 * w[k]);
        m[k] = 0.9 * m[k] + 0.1 * gk; v[k] = 0.999 * v[k] + 0.001 * gk * gk;
        w[k] -= (lr * m[k] / c1) / (Math.sqrt(v[k] / c2) + 1e-8);
      }
    }
    last = cnt ? tot / cnt : NaN;
  }
  return { w, norm, loss: last, engine: 'ts' };
}

/** python/xgraph/train.py next to the bundle, else the repository's. */
export function xgTorchScript(entry = process.argv[1] ?? ''): string | undefined {
  return [path.resolve(path.dirname(entry), '..', 'python', 'xgraph', 'train.py'), path.resolve('python', 'xgraph', 'train.py')].find((c) => fs.existsSync(c));
}

/** A Python with PyTorch (undefined when none). */
export function torchPython(python?: string): string | undefined {
  for (const p of [python, process.env.XG_PYTHON, process.env.TA_NET_PYTHON, 'python3', 'python'].filter(Boolean) as string[]) {
    const r = spawnSync(p, ['-c', 'import torch, numpy'], { encoding: 'utf8', timeout: 60_000 });
    if (r.status === 0) return p;
  }
  return undefined;
}

/** Samples padded to the largest graph as float64 binaries in `dir` (the torch trainer's input). */
function packTorch(dir: string, samples: XgSample[], norm: XgFit['norm'], w: Float64Array): { S: number; N: number } {
  const N = Math.max(...samples.map((q) => q.assets.length)), S = samples.length, F = XG_F, O = XG_DIMS.O;
  const X = new Float64Array(S * N * F), C = new Float64Array(S * N * N), Y = new Float64Array(S * N * O).fill(NaN), M = new Float64Array(S * N);
  samples.forEach((q, s) => {
    const gph = xgGraph({ norm }, q.x, q.corr), n = q.assets.length;
    for (let i = 0; i < n; i++) {
      M[s * N + i] = 1;
      for (let f = 0; f < F; f++) X[(s * N + i) * F + f] = gph.x[i * F + f];
      for (let j = 0; j < n; j++) C[(s * N + i) * N + j] = q.corr[i * n + j];
      for (let k = 0; k < O; k++) Y[(s * N + i) * O + k] = q.y[i * O + k];
    }
  });
  const put = (name: string, a: Float64Array) => fs.writeFileSync(path.join(dir, name), Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  put('x.f64', X); put('c.f64', C); put('y.f64', Y); put('m.f64', M); put('w.f64', w);
  return { S, N };
}

function runTorch(python: string, script: string, dir: string, job: Record<string, unknown>): { loss?: number | null } {
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ dir, F: XG_F, O: XG_DIMS.O, H: XG_DIMS.H, layout: xgLayout(), ...job }));
  const r = spawnSync(python, [script, path.join(dir, 'job.json')], { encoding: 'utf8', timeout: 6 * 3_600_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`xgraph torch trainer failed (${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
  return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as { loss?: number | null };
}

const readF64 = (file: string) => { const b = fs.readFileSync(file); return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

/** The same training on PyTorch: samples padded to the largest graph, sent as float64 binaries; weights back. */
function fitTorch(samples: XgSample[], norm: XgFit['norm'], o: XgFitOpts, python: string, script: string): XgFit {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xgraph-'));
  try {
    const { S, N } = packTorch(dir, samples, norm, o.init ? Float64Array.from(o.init) : xgInit(o.seed ?? 1));
    const res = runTorch(python, script, dir, { S, N, epochs: o.epochs, lr: o.lr ?? 3e-3, l2: o.l2 ?? 1e-4, batch: o.batch ?? 32, seed: o.seed ?? 1 });
    return { w: readF64(path.join(dir, 'w_out.f64')), norm, loss: res.loss ?? NaN, engine: 'torch' };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** PyTorch's outputs for every sample with weights `w` (padded S x N x O): the engines' parity check. */
export function torchForward(samples: XgSample[], norm: XgFit['norm'], w: Float64Array, python: string, script = xgTorchScript()!): { out: Float64Array; N: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xgraph-'));
  try {
    const { S, N } = packTorch(dir, samples, norm, w);
    runTorch(python, script, dir, { S, N, forward: true, epochs: 0, lr: 0, l2: 0, batch: 1, seed: 1 });
    return { out: readF64(path.join(dir, 'y_out.f64')), N };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export { norms as xgNorms };

/** Fit on samples with labels, on the chosen engine (torch falls back to TypeScript when it is not available). */
export function fitCrossGraph(samples: XgSample[], o: XgFitOpts): XgFit {
  const norm = norms(samples);
  const want = o.engine ?? 'ts';
  if (want !== 'ts') {
    const py = torchPython(o.python), script = xgTorchScript();
    if (py && script) return fitTorch(samples, norm, o, py, script);
    if (want === 'torch') throw new Error('XG_ENGINE=torch but no Python with PyTorch (and numpy) was found, or python/xgraph/train.py is missing');
  }
  return fitTs(samples, norm, o);
}

const pearson = (a: number[], b: number[]) => {
  const n = a.length; if (n < 3) return NaN;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
};

export type XgForecast = [number, number, number]; // rel4, rel24, rank
export interface XgWalk { forecasts: Map<string, Map<number, XgForecast>>; signs: Map<number, number>; refits: number; from: number; last?: XgFit }

/** The walk: forecasts for every hour after the first fit; `signs` (bar -> +1 momentum / -1 reversal, from the fit's rows). */
export function walkCrossGraph(series: XgSeries[], samples: XgSample[], o: { firstDays?: number; stepDays?: number; epochsFirst?: number; epochsStep?: number; engine?: XgFitOpts['engine']; python?: string; log?: (m: string) => void } = {}): XgWalk {
  const log = o.log ?? (() => {});
  const forecasts = new Map<string, Map<number, XgForecast>>(), signs = new Map<number, number>();
  if (!samples.length) return { forecasts, signs, refits: 0, from: NaN };
  const bars = barTimes(series);
  const from = samples[0].bar + (o.firstDays ?? XG_FIRST_DAYS) * D, step = (o.stepDays ?? XG_STEP_DAYS) * D, end = bars[bars.length - 1] + H;
  let fit: XgFit | undefined, refits = 0;
  for (let cut = from; cut < end; cut += step) {
    const train = samples.filter((q) => q.bar + 24 * H <= cut);
    if (train.length < 200) continue;
    const t0 = Date.now();
    fit = fitCrossGraph(train, { epochs: fit ? (o.epochsStep ?? 6) : (o.epochsFirst ?? 30), init: fit?.w, seed: refits + 1, engine: o.engine, python: o.python });
    refits++;
    // The baseline's sign on the same rows: does the last 24 h relative move continue (momentum) or revert?
    const ics = train.map((q) => pearson(q.x.map((r) => r[2]), q.assets.map((_, i) => q.y[i * 2 + 1]))).filter(Number.isFinite);
    const sign = ics.reduce((a, b) => a + b, 0) >= 0 ? 1 : -1;
    const model = new CrossGraph({ schema: XG_SCHEMA, version: 'walk', trainedAt: '', inputs: XG_INPUTS, horizons: XG_HORIZONS, dims: XG_DIMS, norm: fit.norm, weights: Array.from(fit.w), validation: { validated: false, why: '', days: 0 } });
    let n = 0;
    for (const bar of bars) {
      if (bar < cut || bar >= cut + step) continue;
      for (const [a, r] of model.predict(series, bar)) { (forecasts.get(a) ?? forecasts.set(a, new Map()).get(a)!).set(bar, [+r.rel4.toFixed(4), +r.rel24.toFixed(4), +r.rank.toFixed(4)]); n++; }
      signs.set(bar, sign);
    }
    log(`[xgraph] fit ${refits} through ${iso(cut)} on ${train.length} graphs (${fit.engine}, ${((Date.now() - t0) / 1000).toFixed(0)} s, loss ${fit.loss.toFixed(4)}), forecast ${n} coin-hours; baseline = ${sign > 0 ? 'momentum' : 'reversal'}`);
  }
  return { forecasts, signs, refits, from, last: fit };
}

export interface XgGrade { validated: boolean; why: string; days: number; icModel: number; icBaseline: number; edgeLo: number; edgeMean: number; book: number; bookBaseline: number; bookSharpe: number }

/** Grade the walk at one decision a day (bars closing at midnight UTC). */
export function gradeCrossGraph(series: XgSeries[], walk: XgWalk, o: { minDays?: number; costPerName?: number } = {}): XgGrade {
  const cost = o.costPerName ?? 0.001;
  const by = new Map(series.map((s) => [s.asset, s]));
  const days = [...walk.signs.keys()].filter((b) => (b + H) % D === 0).sort((a, b) => a - b);
  const ts: number[] = [], edge: number[] = [], icM: number[] = [], icB: number[] = [], book: number[] = [], bookB: number[] = [];
  let prevL = new Set<string>(), prevS = new Set<string>(), prevLB = new Set<string>(), prevSB = new Set<string>();
  for (const bar of days) {
    const { assets, x } = xgRawInputs(series, bar);
    const rows = assets.map((a, i) => ({ a, f: walk.forecasts.get(a)?.get(bar)?.[1], base: (walk.signs.get(bar) ?? 1) * x[i][2] })).filter((r) => r.f !== undefined && Number.isFinite(r.base));
    if (rows.length < 3) continue;
    const tgt = xgTargets(series, rows.map((r) => r.a), bar, 24);
    const raw = rows.map((r) => { const s = by.get(r.a)!, i = s.idx.get(bar), j = s.idx.get(bar + 24 * H); return i !== undefined && j !== undefined ? Math.log(s.h1[j].c / s.h1[i].c) : NaN; });
    const ok = rows.map((_, k) => Number.isFinite(tgt[k]) && Number.isFinite(raw[k]));
    if (ok.filter(Boolean).length < 3) continue;
    const pick = <T,>(xs: T[]) => xs.filter((_, k) => ok[k]);
    const R = pick(rows), T = pick(tgt), RAW = pick(raw);
    const im = pearson(R.map((r) => r.f!), T), ib = pearson(R.map((r) => r.base), T);
    if (!Number.isFinite(im) || !Number.isFinite(ib)) continue;
    const k = Math.max(1, Math.floor(R.length / 4));
    const bookOf = (score: number[], pl: Set<string>, ps: Set<string>) => {
      const ord = [...score.keys()].sort((a, b) => score[b] - score[a]);
      const L = new Set(ord.slice(0, k).map((q) => R[q].a)), S = new Set(ord.slice(-k).map((q) => R[q].a));
      const mean = (s: Set<string>) => [...s].reduce((acc, a) => acc + RAW[R.findIndex((r) => r.a === a)], 0) / s.size;
      const changed = [...L].filter((a) => !pl.has(a)).length + [...S].filter((a) => !ps.has(a)).length;
      return { pnl: mean(L) - mean(S) - cost * changed / k, L, S };
    };
    const bm = bookOf(R.map((r) => r.f!), prevL, prevS), bb = bookOf(R.map((r) => r.base), prevLB, prevSB);
    prevL = bm.L; prevS = bm.S; prevLB = bb.L; prevSB = bb.S;
    ts.push(bar); icM.push(im); icB.push(ib); edge.push(im - ib); book.push(bm.pnl); bookB.push(bb.pnl);
  }
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); };
  const b = dayBootstrap(edge, ts);
  const minDays = o.minDays ?? 120;
  const bookSum = book.reduce((s, v) => s + v, 0), bookBSum = bookB.reduce((s, v) => s + v, 0);
  const why = ts.length < minDays ? `${ts.length} graded day(s), need ${minDays}`
    : !(b.lo > 0) ? `IC ${mean(icM).toFixed(3)} vs the baseline's ${mean(icB).toFixed(3)}; edge 95% lower bound ${b.lo.toFixed(3)} <= 0`
    : !(bookSum > 0) ? `IC edge holds but the long-short book lost ${bookSum.toFixed(3)} (log) after costs`
    : `IC ${mean(icM).toFixed(3)} vs ${mean(icB).toFixed(3)} (edge lower bound ${b.lo.toFixed(3)}); long-short book ${bookSum.toFixed(3)} vs the baseline's ${bookBSum.toFixed(3)} after costs`;
  return {
    validated: ts.length >= minDays && b.lo > 0 && bookSum > 0, why, days: ts.length, icModel: mean(icM), icBaseline: mean(icB), edgeLo: b.lo, edgeMean: b.mean,
    book: +bookSum.toFixed(4), bookBaseline: +bookBSum.toFixed(4), bookSharpe: sd(book) > 0 ? (mean(book) / sd(book)) * Math.sqrt(365) : 0,
  };
}

export const xgDir = (hist: string) => path.join(hist, '.xgraph');
export interface XgForecastFile { schema: string; version: string; assets: Record<string, Array<[number, ...XgForecast]>> }
export function loadXgForecasts(hist: string): XgForecastFile | undefined {
  try { const j = JSON.parse(fs.readFileSync(path.join(xgDir(hist), 'forecasts.json'), 'utf8')) as XgForecastFile; return j.schema === XG_SCHEMA ? j : undefined; } catch { return undefined; }
}
/** Lookup by asset: the forecast made at the close of the last hourly bar closed by t. */
export class XgIndex {
  private readonly by = new Map<string, Map<number, XgForecast>>();
  constructor(readonly f: XgForecastFile | undefined) { for (const [a, rows] of Object.entries(f?.assets ?? {})) this.by.set(a, new Map(rows.map(([t, ...v]) => [t, v as XgForecast]))); }
  at(asset: string, t: number): { rel4: number; rel24: number; rank: number } | undefined {
    const v = this.by.get(asset)?.get(Math.floor(t / H) * H - H);
    return v ? { rel4: v[0], rel24: v[1], rank: v[2] } : undefined;
  }
}

export interface XgReport { params: XgParams; samples: number; refits: number; from: string; forecastHours: number }

/** Samples, walk, grade, final fit; writes the forecasts file when `hist` is given. */
export function trainCrossGraphOn(series: XgSeries[], o: { hist?: string; engine?: XgFitOpts['engine']; python?: string; firstDays?: number; stepDays?: number; epochsFirst?: number; epochsStep?: number; epochsFinal?: number; minDays?: number; log?: (m: string) => void } = {}): XgReport {
  const log = o.log ?? (() => {});
  const samples = xgSamples(series);
  if (samples.length < 500) throw new Error(`only ${samples.length} graphs with 3+ coins: the cross graph needs years of hourly history for several coins`);
  log(`[xgraph] ${samples.length} graphs over ${series.length} coins, ${iso(samples[0].bar)}..${iso(samples[samples.length - 1].bar)}`);
  const walk = walkCrossGraph(series, samples, { ...o, log });
  const grade = gradeCrossGraph(series, walk, o);
  log(`[xgraph] ${grade.validated ? 'VALIDATED' : 'not validated'}: ${grade.why}`);
  const labelled = samples.filter((q) => q.y.some(Number.isFinite));
  const final = fitCrossGraph(labelled, { epochs: o.epochsFinal ?? 8, init: walk.last?.w, seed: 99, engine: o.engine, python: o.python });
  const version = `xg-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  const { validated, why, days, ...rest } = grade;
  const params: XgParams = { schema: XG_SCHEMA, version, trainedAt: new Date().toISOString(), inputs: XG_INPUTS, horizons: XG_HORIZONS, dims: XG_DIMS, norm: final.norm, weights: Array.from(final.w), validation: { validated, why, days, ...rest }, engine: final.engine };
  let hours = 0;
  if (o.hist) {
    const assets: XgForecastFile['assets'] = {};
    for (const [a, m] of walk.forecasts) { assets[a] = [...m].sort((x, y) => x[0] - y[0]).map(([t, v]) => [t, ...v]); hours += m.size; }
    fs.mkdirSync(xgDir(o.hist), { recursive: true });
    const file = path.join(xgDir(o.hist), 'forecasts.json'), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schema: XG_SCHEMA, version, assets } satisfies XgForecastFile));
    fs.renameSync(tmp, file);
  }
  return { params, samples: samples.length, refits: walk.refits, from: Number.isFinite(walk.from) ? iso(walk.from) : '', forecastHours: hours };
}

export async function trainCrossGraph(hist: string, o: { engine?: XgFitOpts['engine']; python?: string; assets?: string[]; log?: (m: string) => void } = {}): Promise<XgReport> {
  return trainCrossGraphOn(loadXgSeries(hist, o.assets?.length ? o.assets : undefined), { hist, engine: o.engine, python: o.python, log: o.log ?? console.log });
}

async function main(): Promise<void> {
  const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
  const out = arg('out', 'params/cross_graph.json');
  const engine = (['ts', 'torch', 'auto'] as const).find((e) => e === arg('engine', process.env.XG_ENGINE ?? 'auto')) ?? 'auto';
  const rep = await trainCrossGraph(arg('history', 'data/history'), { engine, python: arg('python', '') || undefined, assets: arg('assets', '') ? arg('assets', '').split(',') : undefined });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rep.params));
  console.log(JSON.stringify({ out, samples: rep.samples, refits: rep.refits, from: rep.from, forecastHours: rep.forecastHours, validation: rep.params.validation }, null, 2));
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error(e); process.exitCode = 1; });

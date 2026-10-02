// Trains the TA network (bot/ta/taNet.ts) on historical hourly + daily candles (research/history).
//
//   npm run research:ta-net                                   # every asset in data/history
//   npm run research:ta-net -- --assets BTC,ETH,SOL --out params/ta_net.json
//   npm run research:ta-net -- --val-from 2024-01-01 --test-from 2025-01-01
//
// 1. Rows: at every closed hourly bar with a full 288-bar window, the network's ~200 TA inputs
//    (cached per asset under --cache; only new bars are computed on re-runs) and three targets:
//    up in 1 h, up in 4 h, log(next-4h realised vol / last-24h realised vol). Assets are pooled:
//    every input is scale-free, so one coin's patterns can inform another's.
// 2. Split by time: train | validation | test (default: the last 20% of the span is the test,
//    the 15% before it validation), with a 5-hour embargo at each boundary (targets overlap).
// 3. Candidates per head (logistic regression, MLP, boosted trees) are fitted on train and compared
//    on validation; the best one is kept.
// 4. Blind walk-forward test: through the test period the chosen candidate is refitted every
//    --refit-months on everything before, and each segment is forecast by a model that never saw
//    it. Graded against the naive forecast (base rate / mean) with a day-block bootstrap; a head is
//    `validated` only when the 95% CI of the improvement is above zero.
// 5. The deployed model is refitted on all rows. Only validated heads speak live by default.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Candle } from '../bot/ta/indicators';
import { TANET_FEATURES, TANET_H1_BARS, TANET_SCHEMA, taNetFeatureMap, windowOk, type TaNetHead, type TaNetHeadName, type TaNetHeadParams, type TaNetParams, type TaNetStateCache } from '../bot/ta/taNet';
import { gbdtLogit } from '../bot/model/trees';
import { loadSeries, storedAssets } from './history/candles';
import { trainGbdt } from './gbdt';
import { trainMinibatch, type Matrix } from './mlpMinibatch';
import { rng } from './stats';

const H = 3_600_000;
const DAY = 86_400_000;

export interface TaNetRows {
  assets: string[];
  X: Matrix;
  ts: Float64Array;
  asset: Uint16Array;
  y: Record<TaNetHeadName, Float32Array>;
  sources: Record<string, string[]>;
}

const hashBars = (h: crypto.Hash, cs: Candle[]) => { for (const c of cs) h.update(`${c.ts},${c.o},${c.h},${c.l},${c.c},${c.v};`); };

/** Feature rows for one asset, reusing the cache for bars it already holds. */
export function assetRows(asset: string, h1: Candle[], d1: Candle[], cacheDir: string | undefined, log: (m: string) => void): { ts: number[]; X: Float32Array } {
  const d = TANET_FEATURES.length;
  let cachedTs: number[] = [], cachedX = new Float32Array(0);
  const meta = cacheDir ? path.join(cacheDir, `${asset}.json`) : undefined, bin = cacheDir ? path.join(cacheDir, `${asset}.f32`) : undefined;
  if (meta && bin && fs.existsSync(meta) && fs.existsSync(bin)) {
    try {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8')) as { schema: string; d: number; through: number; sig: string; ts: number[] };
      const through = m.through;
      const h = crypto.createHash('sha1');
      hashBars(h, h1.filter((c) => c.ts <= through));
      hashBars(h, d1.filter((c) => c.ts + DAY <= through + H));
      if (m.schema === TANET_SCHEMA && m.d === d && m.sig === h.digest('hex')) {
        const buf = fs.readFileSync(bin);
        cachedX = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
        cachedTs = m.ts;
      } else log(`${asset}: history or features changed since the cache was written; rebuilding its rows`);
    } catch { /* rebuild */ }
  }
  const have = new Set(cachedTs);
  const newTs: number[] = [];
  const newX: Float32Array[] = [];
  const cache: TaNetStateCache = {};
  const t0 = Date.now();
  for (let i = TANET_H1_BARS - 1; i < h1.length; i++) {
    if (have.has(h1[i].ts)) continue;
    const w = h1.slice(i - TANET_H1_BARS + 1, i + 1);
    if (!windowOk(w)) continue;
    const f = taNetFeatureMap(asset, w, d1, cache);
    newTs.push(h1[i].ts);
    newX.push(Float32Array.from(TANET_FEATURES, (k) => f[k]));
  }
  if (newTs.length) log(`${asset}: computed ${newTs.length} new rows in ${((Date.now() - t0) / 1000).toFixed(0)} s (${cachedTs.length} cached)`);
  const ts = [...cachedTs, ...newTs];
  const X = new Float32Array(ts.length * d);
  X.set(cachedX.subarray(0, cachedTs.length * d), 0);
  newX.forEach((row, k) => X.set(row, (cachedTs.length + k) * d));
  if (meta && bin && newTs.length && ts.length) {
    fs.mkdirSync(cacheDir!, { recursive: true });
    const through = h1[h1.length - 1].ts;
    const h = crypto.createHash('sha1');
    hashBars(h, h1.filter((c) => c.ts <= through));
    hashBars(h, d1.filter((c) => c.ts + DAY <= through + H));
    fs.writeFileSync(bin, Buffer.from(X.buffer, X.byteOffset, X.byteLength));
    fs.writeFileSync(meta, JSON.stringify({ schema: TANET_SCHEMA, d, through, sig: h.digest('hex'), ts }));
  }
  return { ts, X };
}

/** Targets for the bar at `ts` from the hourly series. */
function targets(h1: Candle[], idx: Map<number, number>, ts: number): [number, number, number] {
  const i = idx.get(ts);
  if (i === undefined) return [NaN, NaN, NaN];
  const c0 = h1[i].c;
  const at = (k: number) => { const j = idx.get(ts + k * H); return j === undefined ? undefined : h1[j].c; };
  const c1 = at(1), c4 = at(4);
  const y1 = c1 === undefined ? NaN : c1 > c0 ? 1 : 0;
  const y4 = c4 === undefined ? NaN : c4 > c0 ? 1 : 0;
  let yv = NaN;
  const next: number[] = [];
  let prev = c0;
  for (let k = 1; k <= 4; k++) { const c = at(k); if (c === undefined) { next.length = 0; break; } next.push(Math.log(c / prev)); prev = c; }
  const past: number[] = [];
  for (let k = 0; k < 24; k++) { const a = idx.get(ts - k * H), b = idx.get(ts - (k + 1) * H); if (a === undefined || b === undefined) { past.length = 0; break; } past.push(Math.log(h1[a].c / h1[b].c)); }
  if (next.length === 4 && past.length === 24) {
    const rms = (xs: number[]) => Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length);
    const a = Math.max(1e-6, rms(next)), b = Math.max(1e-6, rms(past));
    yv = Math.max(-3, Math.min(3, Math.log(a / b)));
  }
  return [y1, y4, yv];
}

export function buildRows(histDir: string, assets: string[], cacheDir: string | undefined, log: (m: string) => void): TaNetRows {
  const parts: Array<{ ts: number[]; X: Float32Array; y: number[][]; a: number }> = [];
  const sources: Record<string, string[]> = {};
  const used: string[] = [];
  for (const asset of assets) {
    const s1 = loadSeries(histDir, asset, '1h'), s24 = loadSeries(histDir, asset, '1d');
    const h1 = s1.candles, d1 = s24.candles;
    if (h1.length < TANET_H1_BARS + 50) { log(`${asset}: only ${h1.length} hourly bars, skipped`); continue; }
    sources[asset] = [...new Set([...s1.segments, ...s24.segments].map((s) => s.source))];
    const { ts, X } = assetRows(asset, h1, d1, cacheDir, log);
    const idx = new Map(h1.map((c, i) => [c.ts, i]));
    parts.push({ ts, X, y: ts.map((t) => targets(h1, idx, t)), a: used.length });
    used.push(asset);
  }
  const n = parts.reduce((s, p) => s + p.ts.length, 0), d = TANET_FEATURES.length;
  const data = new Float32Array(n * d), tsA = new Float64Array(n), assetA = new Uint16Array(n);
  const y = { up_1h: new Float32Array(n), up_4h: new Float32Array(n), vol_4h: new Float32Array(n) };
  let o = 0;
  for (const p of parts) {
    data.set(p.X, o * d);
    for (let i = 0; i < p.ts.length; i++) {
      tsA[o + i] = p.ts[i]; assetA[o + i] = p.a;
      y.up_1h[o + i] = p.y[i][0]; y.up_4h[o + i] = p.y[i][1]; y.vol_4h[o + i] = p.y[i][2];
    }
    o += p.ts.length;
  }
  return { assets: used, X: { data, rows: n, cols: d }, ts: tsA, asset: assetA, y, sources };
}

// ---- Fitting ------------------------------------------------------------------------------------

export type CandidateKind = 'logistic' | 'mlp16' | 'mlp32' | 'gbdt';

const sig = (z: number) => 1 / (1 + Math.exp(-z));
const ll = (p: number, y: number) => { const q = Math.min(1 - 1e-9, Math.max(1e-9, p)); return y ? -Math.log(q) : -Math.log(1 - q); };
const mean = (xs: ArrayLike<number>) => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[i]; return xs.length ? s / xs.length : NaN; };

/** Row views (no copy) for the tree trainer. */
const rowViews = (X: Matrix, idx: ArrayLike<number>) => Array.from(idx, (i) => X.data.subarray(i * X.cols, (i + 1) * X.cols)) as unknown as number[][];

/** Fit one candidate on `idx` (early stopping on its last 10% by time). */
export function fitCandidate(kind: CandidateKind, rows: TaNetRows, yAll: Float32Array, idx: number[], loss: 'logistic' | 'squared', seed = 7): TaNetHead {
  const sorted = [...idx].sort((a, b) => rows.ts[a] - rows.ts[b]);
  const cut = Math.floor(sorted.length * 0.9);
  const cutTs = rows.ts[sorted[cut]];
  const tr = sorted.slice(0, cut).filter((i) => rows.ts[i] < cutTs - 5 * H), es = sorted.slice(cut);
  if (kind === 'gbdt') {
    const stride = tr.length > 120_000 ? 3 : tr.length > 60_000 ? 2 : 1;
    const trS = tr.filter((_, k) => k % stride === 0);
    const base = loss === 'logistic' ? (() => { const m = mean(trS.map((i) => yAll[i])); return Math.log(Math.max(1e-4, m) / Math.max(1e-4, 1 - m)); })() : mean(trS.map((i) => yAll[i]));
    const fit = trainGbdt(rowViews(rows.X, trS), trS.map((i) => yAll[i]), trS.map(() => 1), trS.map(() => base),
      rowViews(rows.X, es), es.map((i) => yAll[i]), es.map(() => 1), es.map(() => base),
      { loss, nTrees: 300, learningRate: 0.05, maxDepth: 4, minLeafWeight: 100, lambda: 10, featureFraction: 0.5, baggingFraction: 0.7, patience: 30, seed });
    fit.model.baseScore = base;
    return { kind: 'gbdt', model: fit.model };
  }
  const hidden = kind === 'logistic' ? 0 : kind === 'mlp16' ? 16 : 32;
  const f = trainMinibatch(rows.X, yAll, tr, es, { hidden, loss, l2: hidden ? 3e-4 : 1e-4, lr: 1e-3, batch: 512, maxEpochs: 25, patience: 3, seed });
  return { kind: 'mlp', layers: f.layers, norm: f.norm };
}

export function headValue(h: TaNetHead, X: Matrix, i: number): number {
  const x = X.data.subarray(i * X.cols, (i + 1) * X.cols);
  if (h.kind === 'constant') return h.value;
  if (h.kind === 'gbdt') return gbdtLogit(h.model, x as unknown as number[]);
  // Same arithmetic as taNet.evalHead (Float32 storage, NaN -> 0 after normalisation).
  let v = Array.from(x, (val, j) => (Number.isFinite(val) ? (val - h.norm.mean[j]) / h.norm.std[j] : 0));
  for (const l of h.layers) {
    const o: number[] = new Array(l.bias.length);
    for (let k = 0; k < l.bias.length; k++) { let s = l.bias[k]; const w = l.weights[k]; for (let j = 0; j < v.length; j++) s += w[j] * v[j]; o[k] = l.activation === 'tanh' ? Math.tanh(s) : s; }
    v = o;
  }
  return v[0];
}

/** Day-block bootstrap of the mean of per-row differences (rows grouped by UTC day). */
export function dayBootstrap(diff: number[], ts: number[], iters = 1000, seed = 11): { mean: number; lo: number; hi: number } {
  const byDay = new Map<number, { s: number; n: number }>();
  diff.forEach((d, k) => { const day = Math.floor(ts[k] / DAY); const b = byDay.get(day) ?? { s: 0, n: 0 }; b.s += d; b.n++; byDay.set(day, b); });
  const days = [...byDay.values()];
  const m = diff.reduce((a, b) => a + b, 0) / Math.max(1, diff.length);
  if (days.length < 5) return { mean: m, lo: NaN, hi: NaN };
  const r = rng(seed);
  const ms: number[] = [];
  for (let it = 0; it < iters; it++) {
    let s = 0, n = 0;
    for (let k = 0; k < days.length; k++) { const b = days[Math.floor(r() * days.length)]; s += b.s; n += b.n; }
    ms.push(s / n);
  }
  ms.sort((a, b) => a - b);
  return { mean: m, lo: ms[Math.floor(0.025 * iters)], hi: ms[Math.floor(0.975 * iters)] };
}

export interface TaNetTrainOpts {
  valFrom?: number;
  testFrom?: number;
  refitMonths?: number;
  candidates?: CandidateKind[];
  volCandidates?: CandidateKind[];
  heads?: TaNetHeadName[];
  seed?: number;
  log?: (m: string) => void;
}

export interface TaNetReport { params: TaNetParams; split: { trainRows: number; valRows: number; testRows: number; valFrom: string; testFrom: string } }

export function trainTaNet(rows: TaNetRows, o: TaNetTrainOpts = {}): TaNetReport {
  const log = o.log ?? (() => {});
  const seed = o.seed ?? 7;
  const all = Array.from({ length: rows.X.rows }, (_, i) => i);
  if (!all.length) throw new Error('need at least some history: no rows (import or download hourly candles first)');
  let tMin = Infinity, tMax = -Infinity;
  for (const i of all) { tMin = Math.min(tMin, rows.ts[i]); tMax = Math.max(tMax, rows.ts[i]); }
  const dayFloor = (t: number) => Math.floor(t / DAY) * DAY;
  const testFrom = o.testFrom ?? dayFloor(tMin + 0.8 * (tMax - tMin));
  const valFrom = o.valFrom ?? dayFloor(tMin + 0.65 * (tMax - tMin));
  const emb = 5 * H;
  const refitMs = (o.refitMonths ?? 6) * 30.44 * DAY;
  const heads = o.heads ?? ['up_1h', 'up_4h', 'vol_4h'];
  const out: Partial<Record<TaNetHeadName, TaNetHeadParams>> = {};
  let split = { trainRows: 0, valRows: 0, testRows: 0 };
  for (const name of heads) {
    const y = rows.y[name];
    const loss: 'logistic' | 'squared' = name === 'vol_4h' ? 'squared' : 'logistic';
    const ok = all.filter((i) => Number.isFinite(y[i]));
    const train = ok.filter((i) => rows.ts[i] < valFrom - emb);
    const val = ok.filter((i) => rows.ts[i] >= valFrom && rows.ts[i] < testFrom - emb);
    const test = ok.filter((i) => rows.ts[i] >= testFrom);
    split = { trainRows: train.length, valRows: val.length, testRows: test.length };
    if (train.length < 2000 || val.length < 300 || test.length < 300) throw new Error(`need at least 2000 train / 300 validation / 300 test rows for ${name} (have ${train.length} / ${val.length} / ${test.length}): add more history`);
    const baseOf = (idx: number[]) => mean(idx.map((i) => y[i]));
    const lossOf = (pred: number, yy: number) => (loss === 'logistic' ? ll(sig(pred), yy) : (pred - yy) ** 2);
    const baseLoss = (b: number, yy: number) => (loss === 'logistic' ? ll(b, yy) : (b - yy) ** 2);
    // 3. candidates on validation
    const kinds = name === 'vol_4h' ? (o.volCandidates ?? ['logistic', 'mlp16', 'gbdt']) : (o.candidates ?? ['logistic', 'mlp16', 'gbdt']);
    const cands: Array<{ kind: CandidateKind; valLoss: number }> = [];
    const b0 = baseOf(train);
    cands.push({ kind: 'base' as CandidateKind, valLoss: mean(val.map((i) => baseLoss(b0, y[i]))) });
    for (const k of kinds) {
      const t0 = Date.now();
      const h = fitCandidate(k, rows, y, train, loss, seed);
      const vl = mean(val.map((i) => lossOf(headValue(h, rows.X, i), y[i])));
      cands.push({ kind: k, valLoss: vl });
      log(`${name}: ${k} validation ${loss === 'logistic' ? 'log loss' : 'MSE'} ${vl.toFixed(5)} (base ${cands[0].valLoss.toFixed(5)}) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
    const best = cands.filter((c) => c.kind !== ('base' as CandidateKind)).sort((a, b) => a.valLoss - b.valLoss)[0];
    // 4. blind walk-forward through the test period
    const preds: number[] = [], bases: number[] = [], ys: number[] = [], tss: number[] = [];
    for (let s = testFrom; s <= tMax; s += refitMs) {
      const seg = test.filter((i) => rows.ts[i] >= s && rows.ts[i] < s + refitMs);
      if (!seg.length) continue;
      const fitIdx = ok.filter((i) => rows.ts[i] < s - emb);
      const h = fitCandidate(best.kind, rows, y, fitIdx, loss, seed);
      const b = baseOf(fitIdx);
      for (const i of seg) { preds.push(headValue(h, rows.X, i)); bases.push(b); ys.push(y[i]); tss.push(rows.ts[i]); }
      log(`${name}: walk-forward segment from ${new Date(s).toISOString().slice(0, 10)}: ${seg.length} rows, model fitted on ${fitIdx.length}`);
    }
    const mLoss = preds.map((p, k) => lossOf(p, ys[k])), bLoss = bases.map((b, k) => baseLoss(b, ys[k]));
    const imp = dayBootstrap(bLoss.map((b, k) => b - mLoss[k]), tss);
    const v: TaNetHeadParams['validation'] = {
      metric: loss === 'logistic' ? 'logloss' : 'mse', rows: preds.length,
      from: new Date(testFrom).toISOString().slice(0, 10), to: new Date(tMax).toISOString().slice(0, 10),
      base: mean(bLoss), model: mean(mLoss), improvement: imp, validated: Number.isFinite(imp.lo) && imp.lo > 0,
    };
    if (loss === 'logistic') {
      const ps = preds.map(sig);
      v.skill = 1 - mean(ps.map((p, k) => (p - ys[k]) ** 2)) / 0.25;
      v.hitRate = mean(ps.map((p, k) => ((p > 0.5 ? 1 : 0) === ys[k] ? 1 : 0)));
    }
    log(`${name}: blind test ${v.metric} ${v.model.toFixed(5)} vs base ${v.base.toFixed(5)}; improvement ${imp.mean.toExponential(2)} [${imp.lo.toExponential(2)}, ${imp.hi.toExponential(2)}]${v.skill !== undefined ? `; skill ${v.skill.toFixed(4)}, hit ${(v.hitRate! * 100).toFixed(2)}%` : ''}; validated=${v.validated}`);
    // 5. deployed model: refit on everything
    const head = fitCandidate(best.kind, rows, y, ok, loss, seed);
    out[name] = { head, validation: v, candidates: cands.map((c) => ({ kind: String(c.kind), valLoss: c.valLoss })) };
  }
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return {
    params: {
      version: `tanet-${new Date().toISOString().slice(0, 10)}-${rows.assets.length}a-${rows.X.rows}r`,
      schema: TANET_SCHEMA, features: [...TANET_FEATURES], heads: out,
      data: { assets: rows.assets, from: iso(tMin), to: iso(tMax), rows: rows.X.rows, sources: rows.sources },
      trainedAt: new Date().toISOString(),
    },
    split: { ...split, valFrom: iso(valFrom), testFrom: iso(testFrom) },
  };
}

export async function trainTaNetMain(argOf: (k: string, d: string) => string = cliArg): Promise<TaNetReport> {
  const log = (m: string) => console.log(`[ta-net] ${m}`);
  const hist = argOf('history', 'data/history');
  const spec = argOf('assets', 'all');
  const assets = spec === 'all' ? storedAssets(hist) : spec.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!assets.length) throw new Error(`need at least one asset with hourly history in ${hist} (npm run history:binance / history:import)`);
  const rows = buildRows(hist, assets, argOf('cache', path.join(hist, '.tanet-cache')), log);
  log(`${rows.X.rows} rows over ${rows.assets.join(', ')}`);
  const day = (k: string) => { const v = argOf(k, ''); return v ? Date.parse(`${v}T00:00:00Z`) : undefined; };
  const kinds = (k: string, d: string) => argOf(k, d).split(',').map((s) => s.trim()).filter(Boolean) as CandidateKind[];
  const rep = trainTaNet(rows, { valFrom: day('val-from'), testFrom: day('test-from'), refitMonths: Number(argOf('refit-months', '6')), candidates: kinds('candidates', 'logistic,mlp16,gbdt'), volCandidates: kinds('vol-candidates', 'logistic,mlp16,gbdt'), log });
  const out = argOf('out', 'params/ta_net.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rep.params));
  console.table(Object.entries(rep.params.heads).map(([k, h]) => ({ head: k, model: h!.head.kind, test: `${h!.validation.metric} ${h!.validation.model.toFixed(5)} vs ${h!.validation.base.toFixed(5)}`, skill: h!.validation.skill?.toFixed(4) ?? '', hit: h!.validation.hitRate !== undefined ? `${(h!.validation.hitRate * 100).toFixed(2)}%` : '', validated: h!.validation.validated })));
  log(`split: train < ${rep.split.valFrom} <= validation < ${rep.split.testFrom} <= blind test; wrote ${out}`);
  return rep;
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

if (process.argv[1] && /trainTaNet\.(ts|js|cjs)$/.test(process.argv[1])) void trainTaNetMain().catch((e) => { console.error(e); process.exitCode = 1; });

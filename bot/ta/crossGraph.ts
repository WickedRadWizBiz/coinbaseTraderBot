// Cross-asset graph network ("xgraph", the 4th-generation spec's 2, as reviewed): the coins as nodes of a graph whose
// edges are how their hourly returns have moved together, learning from RELATIVE returns, each coin against the
// basket, so it forecasts which coins will outrun the others rather than where the market goes (the TA network's job).
//
//   nodes      every coin with hourly bars, at the close of each hour. Inputs, all in units of the coin's own hourly
//              volatility so BTC and DOGE are comparable: its return relative to the basket over 1 / 4 / 24 / 168 hours,
//              its volatility regime (24 h vs 168 h), its taker-buy share and volume against their norms, and the
//              basket's own 24 h move (the same for every node: the tide the relative moves happen in)
//   edges      the correlation of each pair's hourly returns over the last 168 hours (recomputed every hour)
//   network    encoder        h_i = tanh(W1 x_i + b1)
//              message        m_i = sum_j a_ij h_j,  a_ij = softmax over j != i of beta x corr_ij  (beta learned: how
//                             much the closest-moving coins speak, against all coins alike)
//              update         z_i = tanh(W2 h_i + U2 m_i + b2)
//              heads          y_i = Wo z_i + bo: the coin's relative return over the next 4 and 24 hours, in units of its
//                             volatility
//
// Trained walk-forward over all history (research/trainCrossGraph.ts, on PyTorch when there is one, in TypeScript
// otherwise; the same flat weights either way) and graded against momentum / reversal of the 24 h relative return.
// The live bot runs this file's forward pass on the same inputs from its candle store.

import fs from 'fs';
import type { Candle } from './indicators';

export const XG_SCHEMA = 'xg1';
const H = 3_600_000;
export const XG_HORIZONS = [4, 24] as const;
export const XG_INPUTS = ['rel_1h', 'rel_4h', 'rel_24h', 'rel_168h', 'vol_regime', 'flow_24h', 'volume_24h', 'market_24h'] as const;
export const XG_F = XG_INPUTS.length;
/** Hourly bars a node needs: the 168 h return, volatility and correlation window (the live store keeps 300+). */
export const XG_LOOKBACK_H = 170;

export interface XgDims { F: number; H: number; O: number }
export const XG_DIMS: XgDims = { F: XG_F, H: 12, O: XG_HORIZONS.length };

/** Flat weight layout: W1 (H x F), b1 (H), beta, W2 (H x H), U2 (H x H), b2 (H), Wo (O x H), bo (O). */
export function xgLayout(d: XgDims = XG_DIMS): { W1: number; b1: number; beta: number; W2: number; U2: number; b2: number; Wo: number; bo: number; size: number } {
  let o = 0;
  const at = (n: number) => { const s = o; o += n; return s; };
  const L = { W1: at(d.H * d.F), b1: at(d.H), beta: at(1), W2: at(d.H * d.H), U2: at(d.H * d.H), b2: at(d.H), Wo: at(d.O * d.H), bo: at(d.O), size: 0 };
  L.size = o;
  return L;
}

/** Small random initial weights (deterministic by seed). */
export function xgInit(seed = 1, d: XgDims = XG_DIMS): Float64Array {
  const L = xgLayout(d), w = new Float64Array(L.size);
  let s = seed >>> 0;
  const r = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5; };
  for (let k = 0; k < d.H * d.F; k++) w[L.W1 + k] = r() * 2 / Math.sqrt(d.F);
  for (let k = 0; k < d.H * d.H; k++) { w[L.W2 + k] = r() * 2 / Math.sqrt(d.H); w[L.U2 + k] = r() * 2 / Math.sqrt(d.H); }
  for (let k = 0; k < d.O * d.H; k++) w[L.Wo + k] = r() * 0.2 / Math.sqrt(d.H);
  w[L.beta] = 1;
  return w;
}

/** One hour's graph: n nodes' inputs (n x F, z-scored, missing = 0) and the n x n correlations (diagonal ignored). */
export interface XgGraph { n: number; x: Float64Array; corr: Float64Array }
export interface XgCache { h: Float64Array; a: Float64Array; m: Float64Array; z: Float64Array; y: Float64Array }

/** Forward pass: outputs (n x O) and the cache for the backward pass. */
export function xgForward(w: ArrayLike<number>, g: XgGraph, d: XgDims = XG_DIMS, L = xgLayout(d)): XgCache {
  const { n } = g, Hh = d.H, F = d.F, O = d.O;
  const h = new Float64Array(n * Hh), a = new Float64Array(n * n), m = new Float64Array(n * Hh), z = new Float64Array(n * Hh), y = new Float64Array(n * O);
  for (let i = 0; i < n; i++) for (let k = 0; k < Hh; k++) {
    let s = w[L.b1 + k];
    for (let f = 0; f < F; f++) s += w[L.W1 + k * F + f] * g.x[i * F + f];
    h[i * Hh + k] = Math.tanh(s);
  }
  const beta = w[L.beta];
  for (let i = 0; i < n; i++) {
    let mx = -Infinity;
    for (let j = 0; j < n; j++) if (j !== i) mx = Math.max(mx, beta * g.corr[i * n + j]);
    let sum = 0;
    for (let j = 0; j < n; j++) if (j !== i) { const e = Math.exp(beta * g.corr[i * n + j] - mx); a[i * n + j] = e; sum += e; }
    for (let j = 0; j < n; j++) if (j !== i) { a[i * n + j] = sum > 0 ? a[i * n + j] / sum : 0; for (let k = 0; k < Hh; k++) m[i * Hh + k] += a[i * n + j] * h[j * Hh + k]; }
  }
  for (let i = 0; i < n; i++) for (let k = 0; k < Hh; k++) {
    let s = w[L.b2 + k];
    for (let q = 0; q < Hh; q++) s += w[L.W2 + k * Hh + q] * h[i * Hh + q] + w[L.U2 + k * Hh + q] * m[i * Hh + q];
    z[i * Hh + k] = Math.tanh(s);
  }
  for (let i = 0; i < n; i++) for (let o = 0; o < O; o++) {
    let s = w[L.bo + o];
    for (let k = 0; k < Hh; k++) s += w[L.Wo + o * Hh + k] * z[i * Hh + k];
    y[i * O + o] = s;
  }
  return { h, a, m, z, y };
}

/** Squared-error loss over the nodes with targets (NaN = no target) and its gradient, accumulated into `grad`. */
export function xgBackward(w: ArrayLike<number>, g: XgGraph, c: XgCache, target: ArrayLike<number>, grad: Float64Array, d: XgDims = XG_DIMS, L = xgLayout(d)): { loss: number; count: number } {
  const { n } = g, Hh = d.H, F = d.F, O = d.O;
  let loss = 0, count = 0;
  const dy = new Float64Array(n * O);
  for (let i = 0; i < n * O; i++) { const t = target[i]; if (!Number.isFinite(t)) continue; const e = c.y[i] - t; loss += e * e; dy[i] = 2 * e; count++; }
  const dz = new Float64Array(n * Hh);
  for (let i = 0; i < n; i++) for (let o = 0; o < O; o++) {
    const e = dy[i * O + o];
    if (!e) continue;
    grad[L.bo + o] += e;
    for (let k = 0; k < Hh; k++) { grad[L.Wo + o * Hh + k] += e * c.z[i * Hh + k]; dz[i * Hh + k] += e * w[L.Wo + o * Hh + k]; }
  }
  const dh = new Float64Array(n * Hh), dm = new Float64Array(n * Hh);
  for (let i = 0; i < n; i++) for (let k = 0; k < Hh; k++) {
    const ds = dz[i * Hh + k] * (1 - c.z[i * Hh + k] ** 2);
    if (!ds) continue;
    grad[L.b2 + k] += ds;
    for (let q = 0; q < Hh; q++) {
      grad[L.W2 + k * Hh + q] += ds * c.h[i * Hh + q]; grad[L.U2 + k * Hh + q] += ds * c.m[i * Hh + q];
      dh[i * Hh + q] += ds * w[L.W2 + k * Hh + q]; dm[i * Hh + q] += ds * w[L.U2 + k * Hh + q];
    }
  }
  // m_i = sum_j a_ij h_j, a_ij = softmax_j(beta corr_ij): dh_j += a_ij dm_i; da_ij = dm_i . h_j; d(beta) through the softmax.
  let dBeta = 0;
  for (let i = 0; i < n; i++) {
    let mean = 0;
    const da = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      let s = 0;
      for (let k = 0; k < Hh; k++) { s += dm[i * Hh + k] * c.h[j * Hh + k]; dh[j * Hh + k] += c.a[i * n + j] * dm[i * Hh + k]; }
      da[j] = s; mean += c.a[i * n + j] * s;
    }
    for (let j = 0; j < n; j++) if (j !== i) dBeta += c.a[i * n + j] * (da[j] - mean) * g.corr[i * n + j];
  }
  grad[L.beta] += dBeta;
  for (let i = 0; i < n; i++) for (let k = 0; k < Hh; k++) {
    const ds = dh[i * Hh + k] * (1 - c.h[i * Hh + k] ** 2);
    if (!ds) continue;
    grad[L.b1 + k] += ds;
    for (let f = 0; f < F; f++) grad[L.W1 + k * F + f] += ds * g.x[i * F + f];
  }
  return { loss, count };
}

// ---- Inputs from candles (the same function live and in research) ------------------------------------------------

const fin = Number.isFinite;

/** A coin's hourly bars and the index of the bar that closed at each hour. */
export interface XgSeries { asset: string; h1: Candle[]; idx: Map<number, number> }
export const xgSeries = (asset: string, h1: Candle[]): XgSeries => ({ asset, h1, idx: new Map(h1.map((c, i) => [c.ts, i])) });

/** Raw (un-normalised) inputs of every coin at the close of the hourly bar opening at `bar`, and the coins used. */
export function xgRawInputs(series: XgSeries[], bar: number): { assets: string[]; x: number[][]; ret1: Map<string, number[]> } {
  const assets: string[] = [], rows: Array<{ r: number[]; sig: number; vr: number; flow: number; volu: number }> = [], ret1 = new Map<string, number[]>();
  for (const s of series) {
    const i = s.idx.get(bar);
    if (i === undefined || i < XG_LOOKBACK_H) continue;
    const c = (k: number) => s.h1[i - k]?.c;
    // The last 168 hours must be contiguous (no gaps) for the returns and the correlation.
    if (s.h1[i - 168].ts !== bar - 168 * H) continue;
    const r1: number[] = [];
    for (let k = 168; k >= 1; k--) r1.push(Math.log(s.h1[i - k + 1].c / s.h1[i - k].c));
    const sig = Math.sqrt(r1.reduce((a, v) => a + v * v, 0) / r1.length);
    const sig24 = Math.sqrt(r1.slice(-24).reduce((a, v) => a + v * v, 0) / 24);
    if (!(sig > 0)) continue;
    const r = [1, 4, 24, 168].map((hh) => Math.log(c(0)! / c(hh)!));
    let tb = 0, v = 0, v168 = 0;
    for (let k = 0; k < 24; k++) { const b = s.h1[i - k]; v += b.v; if (b.tb !== undefined) tb += b.tb; }
    for (let k = 0; k < 168; k++) v168 += s.h1[i - k].v;
    assets.push(s.asset);
    ret1.set(s.asset, r1);
    rows.push({ r, sig, vr: sig24 > 0 ? Math.log(sig24 / sig) : NaN, flow: v > 0 && tb > 0 ? 2 * tb / v - 1 : NaN, volu: v168 > 0 && v > 0 ? Math.log((v * 7) / v168) : NaN });
  }
  const n = rows.length;
  const mean = [0, 1, 2, 3].map((k) => (n ? rows.reduce((a, x) => a + x.r[k], 0) / n : NaN));
  const sigM = n ? rows.reduce((a, x) => a + x.sig, 0) / n : NaN;
  const x = rows.map((q) => [
    ...[1, 4, 24, 168].map((hh, k) => (q.r[k] - mean[k]) / (q.sig * Math.sqrt(hh))),
    q.vr, q.flow, q.volu, sigM > 0 ? mean[2] / (sigM * Math.sqrt(24)) : NaN,
  ].map((v) => (fin(v) ? Math.max(-8, Math.min(8, v)) : NaN)));
  return { assets, x, ret1 };
}

/** Correlation matrix of the coins' last-168-hour hourly returns (row-major n x n, diagonal 1). */
export function xgCorr(assets: string[], ret1: Map<string, number[]>): Float64Array {
  const n = assets.length, C = new Float64Array(n * n);
  const z = assets.map((a) => { const r = ret1.get(a)!; const m = r.reduce((s, v) => s + v, 0) / r.length; const sd = Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / r.length); return r.map((v) => (sd > 0 ? (v - m) / sd : 0)); });
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) {
    let s = 0;
    for (let k = 0; k < z[i].length; k++) s += z[i][k] * z[j][k];
    C[i * n + j] = C[j * n + i] = i === j ? 1 : s / z[i].length;
  }
  return C;
}

/** The forward relative return target (vol units) of each coin in `assets` over `hh` hours from the close of `bar`. */
export function xgTargets(series: XgSeries[], assets: string[], bar: number, hh: number): number[] {
  const by = new Map(series.map((s) => [s.asset, s]));
  const r = assets.map((a) => { const s = by.get(a)!; const i = s.idx.get(bar), j = s.idx.get(bar + hh * H); return i !== undefined && j !== undefined ? Math.log(s.h1[j].c / s.h1[i].c) : NaN; });
  const ok = r.filter(fin);
  if (ok.length < 2) return r.map(() => NaN);
  const m = ok.reduce((a, v) => a + v, 0) / ok.length;
  return assets.map((a, k) => {
    const s = by.get(a)!, i = s.idx.get(bar)!;
    let ss = 0;
    for (let q = 0; q < 168; q++) ss += Math.log(s.h1[i - q].c / s.h1[i - q - 1].c) ** 2;
    const sig = Math.sqrt(ss / 168);
    return fin(r[k]) && sig > 0 ? Math.max(-4, Math.min(4, (r[k] - m) / (sig * Math.sqrt(hh)))) : NaN;
  });
}

// ---- The trained model ---------------------------------------------------------------------------------------------

export interface XgValidation { validated: boolean; why: string; days: number; [k: string]: number | boolean | string }
export interface XgParams {
  schema: string; version: string; trainedAt: string;
  inputs: readonly string[]; horizons: readonly number[]; dims: XgDims;
  norm: { mean: number[]; std: number[] };
  weights: number[];
  validation: XgValidation;
  /** Training engine ('ts' | 'torch'). */
  engine?: string;
}

/** z-scored graph from raw inputs (missing -> 0). */
export function xgGraph(p: Pick<XgParams, 'norm'>, x: number[][], corr: Float64Array): XgGraph {
  const n = x.length, F = XG_F, out = new Float64Array(n * F);
  for (let i = 0; i < n; i++) for (let f = 0; f < F; f++) { const v = x[i][f], s = p.norm.std[f]; out[i * F + f] = fin(v) && s > 0 ? Math.max(-6, Math.min(6, (v - p.norm.mean[f]) / s)) : 0; }
  return { n, x: out, corr };
}

export interface XgReading { rel4: number; rel24: number; rank: number; n: number }

export class CrossGraph {
  private readonly w: Float64Array;
  constructor(readonly params: XgParams) {
    if (params.weights.length !== xgLayout(params.dims).size) throw new Error(`cross graph weights: ${params.weights.length} values, the layout needs ${xgLayout(params.dims).size}`);
    this.w = Float64Array.from(params.weights);
  }
  static load(file: string): CrossGraph | undefined {
    if (!fs.existsSync(file)) return undefined;
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as XgParams;
    if (p.schema !== XG_SCHEMA) throw new Error(`cross graph ${file} has schema ${p.schema}, this build needs ${XG_SCHEMA} (retrain it)`);
    if (p.inputs.length !== XG_F || p.inputs.some((k, i) => k !== XG_INPUTS[i])) throw new Error(`cross graph ${file} was trained on other inputs: retrain it`);
    return new CrossGraph(p);
  }
  get version(): string { return this.params.version; }
  /** Every coin's forecast at the close of the hour opening at `bar` (needs XG_LOOKBACK_H bars per coin). */
  predict(series: XgSeries[], bar: number): Map<string, XgReading> {
    const { assets, x, ret1 } = xgRawInputs(series, bar);
    const out = new Map<string, XgReading>();
    if (assets.length < 3) return out;
    const c = xgForward(this.w, xgGraph(this.params, x, xgCorr(assets, ret1)), this.params.dims);
    const O = this.params.dims.O;
    const r24 = assets.map((_, i) => c.y[i * O + 1]);
    const order = [...r24.keys()].sort((a, b) => r24[a] - r24[b]);
    assets.forEach((a, i) => out.set(a, { rel4: c.y[i * O], rel24: c.y[i * O + 1], rank: assets.length > 1 ? (2 * order.indexOf(i)) / (assets.length - 1) - 1 : 0, n: assets.length }));
    return out;
  }
}

/** Feature keys for the setup trader ("xgraph" group, side-oriented copies). */
export const XG_SETUP_KEYS = ['xg_rel4', 'xg_rel24', 'xg_rank', 'o_xg_rel4', 'o_xg_rel24', 'o_xg_rank'];
export function xgSetupFeatures(out: Record<string, number>, dir: number, r: Pick<XgReading, 'rel4' | 'rel24' | 'rank'> | undefined): void {
  out.xg_rel4 = r ? r.rel4 : NaN; out.xg_rel24 = r ? r.rel24 : NaN; out.xg_rank = r ? r.rank : NaN;
  out.o_xg_rel4 = dir * out.xg_rel4; out.o_xg_rel24 = dir * out.xg_rel24; out.o_xg_rank = dir * out.xg_rank;
}

/** Forecasts memoised per hour and per set of coins that have that hour's bar: right after the hour some coins' bars are
 *  still arriving, and the forecast is redone as they come in (a partial graph is never kept for the hour). */
export class XgMemo {
  private key = '';
  private out = new Map<string, XgReading>();
  get(model: CrossGraph, sets: Array<[string, Candle[] | undefined]>, now: number, asset: string): XgReading | undefined {
    const bar = Math.floor(now / H) * H - H;
    const have = sets.filter(([, cs]) => cs?.some((c, i) => i >= cs.length - 2 && c.ts === bar)).map(([a]) => a).sort().join(',');
    const key = `${model.version}|${bar}|${have}`;
    if (key !== this.key) { this.key = key; this.out = model.predict(sets.map(([a, cs]) => xgSeries(a, cs ?? [])), bar); }
    return this.out.get(asset);
  }
}

// ---- Shared instance (general features: validated only; research processes load CROSS_GRAPH_PATH) ----------------

let active: { file?: () => string | undefined; at?: string; mtime: number; checkedAt: number; model?: CrossGraph } = { mtime: -1, checkedAt: -Infinity };
const liveMemo = new XgMemo();

/** Read the model from `file` (a path, or a function giving the current one), reloading it (checked once a minute). */
export function setCrossGraphPath(file: string | (() => string | undefined) | undefined): void {
  active = { file: typeof file === 'function' ? file : file === undefined ? undefined : () => file, mtime: -1, checkedAt: -Infinity };
}

/** The installed model (research processes load CROSS_GRAPH_PATH on first use). */
export function activeCrossGraph(now = Date.now()): CrossGraph | undefined {
  if (active.checkedAt === -Infinity && !active.file && process.env.CROSS_GRAPH_PATH) { const p = process.env.CROSS_GRAPH_PATH; active.file = () => p; }
  if (active.file && now - active.checkedAt >= 60_000) {
    active.checkedAt = now;
    const f = active.file();
    let m = 0;
    try { m = f ? fs.statSync(f).mtimeMs : 0; } catch { /* missing */ }
    if (m !== active.mtime || f !== active.at) { active.mtime = m; active.at = f; try { active.model = m && f ? CrossGraph.load(f) : undefined; } catch { active.model = undefined; } }
  }
  return active.model;
}

/** The installed model's forecast for `asset` at the last hour closed by `now`, from every coin's hourly bars (only when
 *  the model validated). */
export function xgLiveReading(asset: string, now: number, bars: () => Iterable<[string, Candle[] | undefined]>): XgReading | undefined {
  const g = activeCrossGraph(now);
  return g?.params.validation.validated ? liveMemo.get(g, [...bars()], now, asset) : undefined;
}

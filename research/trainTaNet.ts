// Initialises the TA network (bot/ta/taNet.ts) with a population tournament over years of hourly
// history (research/history): three identical three-branch networks (bot/ta/branchNet.ts) with
// slightly different hyperparameters train walk-forward and fight for fitness (research/pbt.ts).
//
//   npm run research:ta-net                                   # every asset in data/history
//   npm run research:ta-net -- --assets BTC,ETH,SOL --out params/ta_net.json
//   npm run research:ta-net -- --train-months 12 --eval-months 1 --holdout-months 3 --stride 2
//
// 1. Inputs per closed hourly bar (cached per asset; only new bars are computed on re-runs): the last
//    12 hourly TA steps (GRU branch), the last 30 daily TA steps (attention branch), the last 32
//    15-minute bars (convolution branch). Targets: up in 1h, up in 4h, next-4h vol vs last-24h.
// 2. Tournament: rolling training block (--train-months, 12-18), evaluation on the NEXT month, roll
//    forward one month. Every member trains one epoch per round on its block, then is scored on the
//    unseen month by trading the network's own position rule (fractional Kelly on its forecasts,
//    taNetPosition): Fitness = Sortino - 5 x max drawdown - 5 x costs, and a member trading under 5% of
//    the hours scores up to -10 (coverageFloor: sitting out must not win). Elite survives, worst clones
//    it, middle + clone mutate (learning rate, L2, the 15m / hourly / daily branch gates, vol weight).
//    The blocks deliberately cross the 2016-2026 regime shifts (research/fitness.ts REGIMES).
// 3. Hurdles: the elite lineage's out-of-sample record, clustered into independent interactions
//    (one continuous position = one interaction), must pass the deflated Sharpe ratio with every
//    member evaluation counted as a trial, and every regime it covers must hold at least
//    --min-per-regime independent interactions. The last --holdout-months are never touched by the
//    tournament: each head is graded there against the naive forecast (day-block bootstrap).
// 4. Speaking live: vol_4h when its holdout CI is above zero; up_1h / up_4h only when their holdout
//    CI is above zero AND the network passed the DSR and regime hurdles. The live bot then
//    forward-tests the position rule (TaNetRuntime.enableForwardTest).
// The population is saved (--state): later runs continue the tournament month by month instead of
// starting over, so it is an initialisation followed by continual evolution.

import { taEngine } from '../bot/ta/talib';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Candle } from '../bot/ta/indicators';
import { branchBackward, branchForward, branchLayout, branchLoss, fractalPlan, fractalSpecs, initBranchParams, type BranchDims, type BranchDrop, type BranchGates } from '../bot/ta/branchNet';
import { columnMask, columnReach, localDropMask, type FractalPlan, type JoinMask } from '../bot/ta/fractal';
import {
  buildBranchInput, closedIndex, sigma24, TANET_CTX_FEATURES, TANET_CTX_HOURLY, TANET_D1_BARS, TANET_DAY_FEATURES, TANET_FEATURES, TANET_H1_BARS, TANET_MACRO_DAYS, TANET_MICRO_F, TANET_MICRO_STEPS, TANET_SCHEMA,
  TANET_STRATEGY, TANET_SWING_BARS, TANET_SWING_F, TANET_TREND_FEATURES, TANET_TREND_STEPS, taNetDayVector, taNetFeatureMap, barrierResult, taNetBarrierPosition, taNetBarrierWidth, TANET_BARRIER, tripleBarrier, taNetMicro, taNetSwing, windowOk,
  taNetFamilies, calibrated, fitPlatt, type PatternReport, type TaNetHeadName, type TaNetNetworkValidation, type TaNetStrategy, type TaNetHeadValidation, type TaNetNorm, type TaNetParams, type TaNetStateCache,
} from '../bot/ta/taNet';
import { coverageFloor as sharedCoverageFloor } from '../bot/util/fitness';
import { dsrOf, fitnessOf, independentInteractions, regimeReport, regimesIn, type FitnessReport, type Interaction } from './fitness';
import { runPbt, walkForwardRounds, type Hyper, type MutationSpec, type PbtMember, type PbtRound, type PbtRoundLog } from './pbt';
import { loadIndexSeries, loadSeries, storedAssets } from './history/candles';
import { DAILY_CONTEXT_FEATURES, SLOW_INDEXES, TaNetContext } from '../bot/ta/taNetContext';
import { rng } from './stats';

const H = 3_600_000;
const DAY = 86_400_000;
const MONTH = 30.44 * DAY;

const hashBars = (h: crypto.Hash, cs: Candle[]) => { for (const c of cs) h.update(`${c.ts},${c.o},${c.h},${c.l},${c.c},${c.v},${c.tb ?? ''};`); };

/** Everything a cached feature row depends on besides the asset's own hourly / daily bars: its 15m bars,
 *  every basket coin's hourly bars and BTCDOM, up to `through` (rows only ever look backwards). */
export interface RowInputs { m15?: Candle[]; basket: Record<string, Candle[]>; btcdom?: Candle[] }
function contextHash(h: crypto.Hash, inp: RowInputs | undefined, through: number): void {
  if (!inp) return;
  hashBars(h, (inp.m15 ?? []).filter((c) => c.ts <= through));
  for (const a of Object.keys(inp.basket).sort()) { h.update(`|${a}|`); hashBars(h, inp.basket[a].filter((c) => c.ts <= through)); }
  h.update('|BTCDOM|');
  hashBars(h, (inp.btcdom ?? []).filter((c) => c.ts <= through));
}

/** Feature rows for one asset, reusing the cache for bars it already holds. */
export function assetRows(asset: string, h1: Candle[], d1: Candle[], cacheDir: string | undefined, log: (m: string) => void, ctx?: TaNetContext, inputs?: RowInputs): { ts: number[]; X: Float32Array } {
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
      contextHash(h, inputs, through);
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
    const f = taNetFeatureMap(asset, w, d1, cache, { ctx, m15: inputs?.m15 });
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
    contextHash(h, inputs, through);
    fs.writeFileSync(bin, Buffer.from(X.buffer, X.byteOffset, X.byteLength));
    fs.writeFileSync(meta, JSON.stringify({ schema: TANET_SCHEMA, d, through, sig: h.digest('hex'), ts }));
  }
  return { ts, X };
}

/** Targets for the bar at `ts` from the hourly series. */
function targets(h1: Candle[], idx: Map<number, number>, ts: number): [number, number, number, number] {
  const i = idx.get(ts);
  if (i === undefined) return [NaN, NaN, NaN, NaN];
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
    yv = Math.max(-3, Math.min(3, Math.log(Math.max(1e-6, rms(next)) / Math.max(1e-6, rms(past)))));
  }
  return [y1, y4, yv, c1 === undefined ? NaN : Math.log(c1 / c0)];
}

export interface AssetData {
  asset: string;
  m15?: Candle[];
  rowTs: number[];
  /** Hourly TA rows (rows x TANET_FEATURES). */
  X: Float32Array;
  /** Daily step vectors per daily bar open time. */
  dayVec: Map<number, number[]>;
  /** TA on the BTC.D / USDT.D daily charts per daily bar open time (oriented to this coin). */
  dayDom: Map<number, number[]>;
  d1: Candle[];
  /** Hourly bars and their index by open time (the swing branch reads raw bars). */
  h1: Candle[];
  h1Idx: Map<number, number>;
}

/** One training example: an asset's hourly row with full branch inputs and its targets. */
export interface TaNetData {
  assets: AssetData[];
  /** Sorted by time. */
  sa: Uint16Array; sr: Int32Array; ts: Float64Array;
  y1: Float32Array; y4: Float32Array; yv: Float32Array; ret1: Float32Array; sig: Float32Array;
  sources: Record<string, string[]>;
  /** Bars with 15-minute input available (share). */
  microShare: number;
  /** Market-wide context the rows were built with (coverage of the index series, the coin basket). */
  context: { indexes: Record<string, { from: string; to: string; bars: number }>; basket: string[] };
}

export function buildData(histDir: string, assets: string[], cacheDir: string | undefined, log: (m: string) => void): TaNetData {
  const out: AssetData[] = [];
  const sources: Record<string, string[]> = {};
  const S: Array<[number, number, number, number, number, number, number, number]> = [];
  let micro = 0;
  // The market basket is every coin in the store with hourly history (live: every tracked coin), also
  // when only some of them are trained here and when one is too short to train on.
  const loaded = assets.map((asset) => ({ asset, s1: loadSeries(histDir, asset, '1h'), s24: loadSeries(histDir, asset, '1d'), s15: loadSeries(histDir, asset, '15m') }));
  const basket: Record<string, Candle[]> = Object.fromEntries(loaded.filter((x) => x.s1.candles.length).map((x) => [x.asset, x.s1.candles]));
  for (const a of storedAssets(histDir)) if (!(a in basket)) { const c = loadSeries(histDir, a, '1h').candles; if (c.length) basket[a] = c; }
  const btcdom = loadIndexSeries(histDir, 'BTCDOM', '1h').candles;
  const ctx = new TaNetContext({
    h1: basket, btcdom1h: btcdom, btcd1d: loadIndexSeries(histDir, 'BTC.D', '1d').candles, usdtd1d: loadIndexSeries(histDir, 'USDT.D', '1d').candles,
    slow1d: Object.fromEntries(SLOW_INDEXES.map(({ asset }) => [asset, loadIndexSeries(histDir, asset, '1d').candles])),
  });
  const cov = ctx.coverage();
  log(`market context: basket ${ctx.basket.join(', ') || 'none'}; ${Object.entries(cov).map(([k, v]) => `${k} ${v.from}..${v.to}`).join(', ') || 'no index series (BTCDOM: history.sh binance; BTC.D / USDT.D: history.sh tradingview)'}`);
  for (const { asset, s1, s24, s15 } of loaded) {
    const h1 = s1.candles, d1 = s24.candles;
    if (h1.length < TANET_H1_BARS + 200 || d1.length < TANET_D1_BARS + TANET_MACRO_DAYS) { log(`${asset}: only ${h1.length} hourly / ${d1.length} daily bars, skipped`); continue; }
    sources[asset] = [...new Set([...s1.segments, ...s24.segments, ...s15.segments].map((s) => s.source))];
    const { ts, X } = assetRows(asset, h1, d1, cacheDir, log, ctx, { m15: s15.candles, basket, btcdom });
    const dayVec = new Map<number, number[]>(), dayDom = new Map<number, number[]>();
    for (let j = TANET_D1_BARS - 1; j < d1.length; j++) { const v = taNetDayVector(d1, j); if (v) dayVec.set(d1[j].ts, v); dayDom.set(d1[j].ts, ctx.daily(asset, d1[j].ts)); }
    const a = out.length;
    const idx = new Map(h1.map((c, i) => [c.ts, i]));
    out.push({ asset, m15: s15.candles.length ? s15.candles : undefined, rowTs: ts, X, dayVec, dayDom, d1, h1, h1Idx: idx });
    for (let r = TANET_TREND_STEPS - 1; r < ts.length; r++) {
      const t = ts[r];
      if (ts[r - TANET_TREND_STEPS + 1] !== t - (TANET_TREND_STEPS - 1) * H) continue;
      const dj = closedIndex(d1, DAY, t + H);
      if (dj - TANET_MACRO_DAYS + 1 < 0 || !dayVec.has(d1[dj - TANET_MACRO_DAYS + 1].ts)) continue;
      const [y1, y4, yv, r1] = targets(h1, idx, t);
      const hi = idx.get(t)!;
      if (hi < TANET_SWING_BARS) continue;
      S.push([t, a, r, y1, y4, yv, r1, sigma24(h1, hi)]);
      if (s15.candles.length && Number.isFinite(taNetMicro(s15.candles, t + H)[0])) micro++;
    }
  }
  S.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const n = S.length;
  const f32 = (k: number) => Float32Array.from(S, (x) => x[k]);
  return {
    assets: out, sa: Uint16Array.from(S, (x) => x[1]), sr: Int32Array.from(S, (x) => x[2]), ts: Float64Array.from(S, (x) => x[0]),
    y1: f32(3), y4: f32(4), yv: f32(5), ret1: f32(6), sig: f32(7), sources, microShare: n ? micro / n : 0,
    context: { indexes: cov, basket: ctx.basket },
  };
}

const TREND_IDX = TANET_TREND_FEATURES.map((k) => TANET_FEATURES.indexOf(k));
const CTX_IDX = TANET_CTX_HOURLY.map((k) => TANET_FEATURES.indexOf(k));
const NO_DOM = DAILY_CONTEXT_FEATURES.map(() => NaN);

/** Raw step vectors of sample i (trend rows, daily vectors, 15-minute steps, 48 raw hourly bars, and the
 *  context vector: this hour's 15m readings and market context plus the last closed day's dominance TA). */
export function rawInputs(D: TaNetData, i: number): { trend: Float32Array[]; macro: number[][]; micro: Float64Array; swing: Float64Array; ctx: number[] } {
  const A = D.assets[D.sa[i]], r = D.sr[i], t = D.ts[i];
  const F = TANET_FEATURES.length;
  const trend: Float32Array[] = [];
  for (let s = TANET_TREND_STEPS - 1; s >= 0; s--) {
    const row = A.X.subarray((r - s) * F, (r - s + 1) * F);
    trend.push(Float32Array.from(TREND_IDX, (j) => row[j]));
  }
  const dj = closedIndex(A.d1, DAY, t + H);
  const macro: number[][] = [];
  for (let k = dj - TANET_MACRO_DAYS + 1; k <= dj; k++) macro.push(A.dayVec.get(A.d1[k].ts)!);
  const row = A.X.subarray(r * F, (r + 1) * F);
  const ctx = [...CTX_IDX.map((j) => row[j]), ...(dj >= 0 ? A.dayDom.get(A.d1[dj].ts) ?? NO_DOM : NO_DOM)];
  return { trend, macro, micro: taNetMicro(A.m15, t + H), swing: taNetSwing(A.h1, A.h1Idx.get(t)!), ctx };
}

export function fitNorms(D: TaNetData, idx: ArrayLike<number>, maxSamples = 20_000): TaNetParams['norm'] {
  const pick = Array.from(idx).filter((_, k, all) => k % Math.max(1, Math.floor(all.length / maxSamples)) === 0);
  const acc = (dim: number) => ({ s: new Float64Array(dim), s2: new Float64Array(dim), n: new Float64Array(dim) });
  const T = acc(TANET_TREND_FEATURES.length), M = acc(TANET_DAY_FEATURES.length), U = acc(TANET_MICRO_F), W = acc(TANET_SWING_F), C = acc(TANET_CTX_FEATURES.length);
  const add = (a: ReturnType<typeof acc>, j: number, v: number) => { if (Number.isFinite(v)) { a.s[j] += v; a.s2[j] += v * v; a.n[j]++; } };
  for (const i of pick) {
    const x = rawInputs(D, i);
    for (const row of x.trend) row.forEach((v, j) => add(T, j, v));
    for (const row of x.macro) row.forEach((v, j) => add(M, j, v));
    for (let k = 0; k < x.micro.length; k++) add(U, k % TANET_MICRO_F, x.micro[k]);
    for (let k = 0; k < x.swing.length; k++) add(W, k % TANET_SWING_F, x.swing[k]);
    x.ctx.forEach((v, j) => add(C, j, v));
  }
  const fin = (a: ReturnType<typeof acc>): TaNetNorm => {
    const mean = Array.from(a.s, (v, j) => (a.n[j] ? v / a.n[j] : 0));
    return { mean, std: Array.from(a.s2, (v, j) => (a.n[j] > 1 ? Math.sqrt(Math.max(0, v / a.n[j] - mean[j] ** 2)) : 0) || 1) };
  };
  return { trend: fin(T), macro: fin(M), micro: fin(U), swing: fin(W), ctx: fin(C) };
}

/** Network layout: 'flat' reads the raw readings, 'grouped' stacks them into indicator families (k units each). */
export function taNetDims(arch: 'flat' | 'grouped' = 'flat', k = 4): BranchDims {
  const d: BranchDims = { mT: TANET_MICRO_STEPS, mF: TANET_MICRO_F, mC: 8, sT: TANET_SWING_BARS, sF: TANET_SWING_F, sC: 8, fDepth: 3, tT: TANET_TREND_STEPS, tF: TANET_TREND_FEATURES.length, tH: 12, dT: TANET_MACRO_DAYS, dF: TANET_DAY_FEATURES.length, dE: 8, cF: TANET_CTX_FEATURES.length, cH: 8, hM: 16, nOut: 3 };
  if (arch === 'grouped') { const f = taNetFamilies(); d.fam = { trend: f.trend, ctx: f.ctx, nT: f.nT, nC: f.nC, k }; }
  return d;
}

// ---- Population members -------------------------------------------------------------------------

export interface Member { w: Float64Array; m: Float64Array; v: Float64Array; step: number }

// pJoin: drop-path probability per join input inside the fractal blocks; pBranch: probability of
// dropping a whole branch for a sample (at least one always stays).
// wd: decoupled weight decay (AdamW): each step shrinks weights by lr x wd, independently of the
// gradient. Plain L2 inside Adam was rescaled by Adam into full-size steps for weights with a weak
// learning signal, which decayed whole branches to zero (schema 4's 15-minute and swing blocks).
export const BASE_HYPER: Hyper = { lr: 1e-3, wd: 1e-2, minEdge: 0.02, gMicro: 1, gSwing: 1, gTrend: 1, gMacro: 1, gCtx: 1, volWeight: 0.5, pJoin: 0.15, pBranch: 0.1 };
export const HYPER_SPEC: MutationSpec = {
  // Learning rate capped at 3e-3: the schema-4 elite ran at 1e-2 and over-shrank weak branches.
  lr: { min: 1e-4, max: 3e-3 }, wd: { min: 1e-4, max: 1e-1 }, minEdge: { min: 0.002, max: 0.15 },
  gMicro: { min: 0.25, max: 2 }, gSwing: { min: 0.25, max: 2 }, gTrend: { min: 0.25, max: 2 }, gMacro: { min: 0.25, max: 2 }, gCtx: { min: 0.25, max: 2 }, volWeight: { min: 0.1, max: 2 },
  pJoin: { min: 0.02, max: 0.5 }, pBranch: { min: 0.02, max: 0.3 },
};
const gatesOf = (h: Hyper): BranchGates => ({ micro: h.gMicro, swing: h.gSwing ?? 1, trend: h.gTrend, macro: h.gMacro, ctx: h.gCtx ?? 1 });

/** Per-sample structure noise (FractalNet): half the samples drop join inputs locally, half keep a
 *  single random column through the block ("global" drop-path); plus whole-branch drops. */
export function sampleDrop(plans: { micro: FractalPlan; swing: FractalPlan }, depth: number, h: Hyper, r: () => number): BranchDrop {
  const pj = h.pJoin ?? 0, pb = h.pBranch ?? 0;
  const mask = (plan: FractalPlan): JoinMask | undefined => (pj <= 0 ? undefined : r() < 0.5 ? localDropMask(plan, pj, r) : columnMask(plan, 1 + Math.floor(r() * depth)));
  const drop: BranchDrop = { micro: mask(plans.micro), swing: mask(plans.swing) };
  if (pb > 0) {
    const on = [0, 1, 2, 3, 4].map(() => r() >= pb) as [boolean, boolean, boolean, boolean, boolean];
    if (!on.some(Boolean)) on[Math.floor(r() * 5)] = true;
    drop.branches = on;
    drop.keep = 1 - pb;
  }
  return drop;
}

/** Parameters weight decay applies to: weights and convolution kernels, not biases. */
const decayMasks = new Map<string, Uint8Array>();
function decayMask(dims: BranchDims): Uint8Array {
  const key = JSON.stringify(dims);
  let m = decayMasks.get(key);
  if (!m) {
    const { layout, size } = branchLayout(dims);
    m = new Uint8Array(size);
    for (const [name, { off, n }] of Object.entries(layout)) if (!name.startsWith('b')) m.fill(1, off, off + n);
    decayMasks.set(key, m);
  }
  return m;
}

/** One epoch of mini-batch AdamW over `idx` (shuffled with `seed`). */
export function trainEpoch(D: TaNetData, dims: BranchDims, norm: TaNetParams['norm'], st: Member, h: Hyper, idx: number[], seed: number, batch = 64): number {
  const L = branchLayout(dims).layout;
  const mask = decayMask(dims);
  const g = gatesOf(h);
  const r = rng(seed);
  const fs = fractalSpecs(dims), plans = { micro: fractalPlan(fs.micro), swing: fractalPlan(fs.swing) };
  const order = idx.slice();
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const grad = new Float64Array(st.w.length);
  let total = 0;
  for (let s = 0; s < order.length; s += batch) {
    grad.fill(0);
    const e = Math.min(order.length, s + batch);
    for (let q = s; q < e; q++) {
      const i = order[q];
      const raw = rawInputs(D, i);
      const x = buildBranchInput(dims, norm, raw.trend, raw.macro, raw.micro, raw.swing, raw.ctx);
      const f = branchForward(dims, st.w, g, x, L, sampleDrop(plans, dims.fDepth, h, r));
      const { loss, dOut } = branchLoss(f.out, [D.y1[i], D.y4[i], D.yv[i]], h.volWeight);
      total += loss;
      branchBackward(dims, st.w, g, x, f.cache, dOut, grad, L);
    }
    const nb = e - s;
    st.step++;
    const c1 = 1 - 0.9 ** st.step, c2 = 1 - 0.999 ** st.step;
    const wd = h.wd ?? 0;
    for (let k = 0; k < st.w.length; k++) {
      const gr = grad[k] / nb;
      st.m[k] = 0.9 * st.m[k] + 0.1 * gr;
      st.v[k] = 0.999 * st.v[k] + 0.001 * gr * gr;
      st.w[k] -= h.lr * ((st.m[k] / c1) / (Math.sqrt(st.v[k] / c2) + 1e-8) + wd * mask[k] * st.w[k]);
    }
  }
  return total / Math.max(1, order.length);
}

export interface Forecasts { idx: number[]; up1: Float64Array; up4: Float64Array; vol: Float64Array }

export function forecast(D: TaNetData, dims: BranchDims, norm: TaNetParams['norm'], w: Float64Array, h: Hyper | BranchGates, idx: number[], drop?: BranchDrop, calib?: TaNetParams['calib']): Forecasts {
  const L = branchLayout(dims).layout, g = 'micro' in h ? (h as BranchGates) : gatesOf(h as Hyper);
  const up1 = new Float64Array(idx.length), up4 = new Float64Array(idx.length), vol = new Float64Array(idx.length);
  idx.forEach((i, k) => {
    const raw = rawInputs(D, i);
    const o = branchForward(dims, w, g, buildBranchInput(dims, norm, raw.trend, raw.macro, raw.micro, raw.swing, raw.ctx), L, drop).out;
    up1[k] = calibrated(1 / (1 + Math.exp(-o[0])), calib?.up_1h); up4[k] = calibrated(1 / (1 + Math.exp(-o[1])), calib?.up_4h); vol[k] = Math.max(-3, Math.min(3, o[2]));
  });
  return { idx, up1, up4, vol };
}

// ---- Which fractal depth carries which TA pattern -----------------------------------------------

/** TA pattern families of the hourly feature map (the TA library's readings) the report compares the
 *  fractal columns against. */
export const PATTERN_FAMILIES: Record<string, string[]> = {
  candlestick: ['h1_engulf', 'h1_pin', 'h1_doji'],
  structure: ['h1_trend', 'h1_bos', 'h1_choch', 'h1_sweep', 'h1_breakout', 'h1_eq_highs', 'h1_eq_lows', 'h1_donchian'],
  momentum: ['h1_rsi', 'h1_rsi_chg', 'h1_macd_atr', 'h1_stoch', 'h1_willr', 'h1_chg_atr'],
  divergence: ['h1_div', 'h1_hdiv', 'h1_obv_div', 'h1_obv_hdiv'],
  volatility: ['h1_squeeze', 'h1_squeeze_release', 'h1_bb_bw_rank', 'h1_atr_rank', 'h1_log_atr_pct'],
  volume_flow: ['h1_vol_ratio', 'h1_obv_slope', 'h1_cmf', 'h1_mfi', 'flow_1h', 'flow_4h'],
  levels: ['h1_round_dist', 'h1_vp_pos', 'h1_fvg_dist', 'h1_in_fvg'],
  swing_4h: ['h4_trend', 'h4_bos', 'h4_choch', 'h4_ema_stack', 'h4_div'],
  // The same families read on 15-minute bars (what the micro block's columns see directly).
  candlestick_15m: ['m15_engulf', 'm15_pin', 'm15_doji'],
  structure_15m: ['m15_trend', 'm15_bos', 'm15_choch', 'm15_sweep', 'm15_breakout'],
  momentum_15m: ['m15_rsi', 'm15_macd_atr', 'm15_stoch', 'm15_willr'],
  // Market-wide context: does a column track the market or BTC instead of the coin's own pattern?
  market: ['x_btc_ret_1h_z', 'x_btc_ret_4h_z', 'x_mkt_ret_1h_z', 'x_mkt_ret_4h_z', 'x_breadth_4h'],
  dominance: ['x_rel_btc_1h', 'x_rel_btc_4h', 'x_btcdom_ret_1h_z', 'x_btcdom_ret_4h_z', 'x_btcdom_trend', 'x_dom_matrix_4h'],
};

function absCorr(a: number[], b: number[]): number {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let k = 0; k < a.length; k++) {
    const x = a[k], y = b[k];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  if (n < 30) return 0;
  const cov = sab / n - (sa / n) * (sb / n), va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
  return va > 1e-12 && vb > 1e-12 ? Math.abs(cov / Math.sqrt(va * vb)) : 0;
}

/**
 * Pattern report on held-out rows. For each fractal block (15-minute micro, hourly swing) and each
 * column (depth 1 / 2 / 4 = 3 / 7 / 31 bars), run the network with ONLY that column active in that
 * block (the drop-path training makes single columns meaningful) and record
 *   - ablation: holdout log loss of up_1h and MSE of vol_4h with that column alone, and
 *   - families: the max |correlation| between the column's pooled channels and the readings of each
 *     TA pattern family (candlesticks, structure, momentum, divergence, volatility, volume/flow,
 *     levels, 4h swing structure),
 * so the report says which depth has learned which kind of pattern, and whether a depth carries
 * anything the TA library does not already encode (good ablation, weak family correlation).
 */
export function patternReport(D: TaNetData, dims: BranchDims, norm: TaNetParams['norm'], w: Float64Array, h: Hyper, rows: number[], maxRows = 4000): PatternReport {
  const step = Math.max(1, Math.floor(rows.length / maxRows));
  const idx = rows.filter((_, k) => k % step === 0);
  const L = branchLayout(dims).layout, g = gatesOf(h);
  const fs = fractalSpecs(dims);
  const plans = { micro: fractalPlan(fs.micro), swing: fractalPlan(fs.swing) };
  const reach = columnReach(plans.micro, fs.micro);
  const F = TANET_FEATURES.length;
  const fam = Object.entries(PATTERN_FAMILIES).map(([name, keys]) => [name, keys.map((k) => TANET_FEATURES.indexOf(k)).filter((j) => j >= 0)] as const).filter(([, js]) => js.length);
  const feats = fam.map(([, js]) => js.map((j) => idx.map((i) => D.assets[D.sa[i]].X[D.sr[i] * F + j])));
  const inputs = idx.map((i) => { const raw = rawInputs(D, i); return { x: buildBranchInput(dims, norm, raw.trend, raw.macro, raw.micro, raw.swing, raw.ctx), hasMicro: Number.isFinite(raw.micro[0]) }; });
  const ll = (z: number, y: number) => { const q = Math.min(1 - 1e-9, Math.max(1e-9, 1 / (1 + Math.exp(-z)))); return y ? -Math.log(q) : -Math.log(1 - q); };
  const losses = (outs: Float64Array[]) => {
    let a = 0, na = 0, b = 0, nb = 0;
    outs.forEach((o, k) => { const i = idx[k]; if (Number.isFinite(D.y1[i])) { a += ll(o[0], D.y1[i]); na++; } if (Number.isFinite(D.yv[i])) { b += (Math.max(-3, Math.min(3, o[2])) - D.yv[i]) ** 2; nb++; } });
    return { logLossUp1h: na ? a / na : NaN, mseVol: nb ? b / nb : NaN };
  };
  const allColumns = losses(inputs.map(({ x }) => branchForward(dims, w, g, x, L).out));
  const ablation: PatternReport['ablation'] = [];
  const families: PatternReport['families'] = [];
  const best: NonNullable<PatternReport['best']> = {};
  for (const block of ['micro', 'swing'] as const) {
    const C = block === 'micro' ? dims.mC : dims.sC, at = block === 'micro' ? 0 : 2 * dims.mC;
    for (let col = 1; col <= dims.fDepth; col++) {
      const drop: BranchDrop = { [block]: columnMask(plans[block], col) };
      const outs: Float64Array[] = [];
      const ch: number[][] = Array.from({ length: 2 * C }, () => []);
      inputs.forEach(({ x, hasMicro }) => {
        const f = branchForward(dims, w, g, x, L, drop);
        outs.push(f.out);
        for (let c = 0; c < 2 * C; c++) ch[c].push(block === 'micro' && !hasMicro ? NaN : f.cache.u[at + c]);
      });
      ablation.push({ block, column: col, reach: reach[col - 1], ...losses(outs) });
      const row: PatternReport['families'][number] = { block, column: col, reach: reach[col - 1] };
      fam.forEach(([name], q) => {
        let m = 0;
        for (const series of feats[q]) for (const c of ch) m = Math.max(m, absCorr(c, series));
        row[name] = +m.toFixed(3);
        const key = `${block}:${name}`;
        if (!best[key] || m > best[key].corr) best[key] = { block, family: name, column: col, reach: reach[col - 1], corr: +m.toFixed(3) };
      });
      families.push(row);
    }
  }
  return { reach, ablation, allColumns, families, best, rows: idx.length };
}

/** Trade the position rule on forecasts (equal capital per asset); one interaction per asset-hour with
 *  a position or turnover. */
/** The trading rule of a member: the shared strategy with its own confidence threshold. */
export const strategyOf = (h: Hyper): TaNetStrategy => ({ ...TANET_STRATEGY, minEdge: h.minEdge ?? 0 });

/** Selective prediction on a window: how many hours were traded and how often the barrier trade won
 *  (before costs), with a Wilson 95% interval; the honest form of "hit rate". */
export interface SelectiveStats { hours: number; taken: number; coverage: number; hitRate: number; hitLo: number; hitHi: number; netReturn: number }
export function selectiveStats(D: TaNetData, f: Forecasts, strategy: TaNetStrategy): SelectiveStats {
  const n = TANET_BARRIER.horizon;
  let hours = 0, taken = 0, wins = 0;
  f.idx.forEach((i, k) => {
    const A = D.assets[D.sa[i]], ts = D.ts[i], hi = A.h1Idx.get(ts);
    if (hi === undefined || hi + n >= A.h1.length || A.h1[hi + n].ts - ts !== n * H || !Number.isFinite(f.up4[k])) return;
    hours++;
    const p = taNetBarrierPosition(f.up4[k], f.vol[k], D.sig[i], strategy);
    if (p === 0) return;
    taken++;
    if (tripleBarrier(A.h1[hi].c, A.h1.slice(hi + 1, hi + 1 + n), p > 0 ? 1 : -1, taNetBarrierWidth(f.vol[k], D.sig[i])) > 0) wins++;
  });
  const z = 1.96, ph = taken ? wins / taken : NaN;
  const den = 1 + (z * z) / Math.max(1, taken), mid = (ph + (z * z) / (2 * Math.max(1, taken))) / den;
  const half = taken ? (z * Math.sqrt((ph * (1 - ph)) / taken + (z * z) / (4 * taken * taken))) / den : NaN;
  const net = strategyInteractions(D, f, strategy).reduce((s, x) => s + x.ret, 0);
  return { hours, taken, coverage: hours ? taken / hours : 0, hitRate: ph, hitLo: mid - half, hitHi: mid + half, netReturn: net };
}

/** Minimum share of hours a member must trade in a round. Without it, sitting out scores 0 (cash) and
 *  beats every member that traded and lost, so the confidence threshold evolves until nothing trades
 *  (schema-5 run: minEdge 0.14, 0 trades on the holdout). Below the floor the round scores up to -10,
 *  the Sortino floor, scaled by how far short the member fell. */
export const TANET_MIN_COVERAGE = 0.05;
export function coverageFloor(rep: FitnessReport, taken: number, hours: number, min = TANET_MIN_COVERAGE): FitnessReport {
  return sharedCoverageFloor(rep, taken, hours, min);
}

export function strategyInteractions(D: TaNetData, f: Forecasts, strategy: TaNetStrategy = TANET_STRATEGY): Interaction[] {
  // Triple-barrier trades (bot/ta/taNet.ts tripleBarrier): every hour, a 4-hour trade sized by Kelly on
  // P(up in 4h), with take-profit / stop at +/- 1 forecast 4-hour sigma; first touch decides, costs on
  // entry and exit. Path-aware, unlike scoring one hourly close-to-close return.
  const out: Interaction[] = [];
  const nA = Math.max(1, D.assets.length), n = TANET_BARRIER.horizon;
  f.idx.forEach((i, k) => {
    const A = D.assets[D.sa[i]], ts = D.ts[i];
    const p = taNetBarrierPosition(f.up4[k], f.vol[k], D.sig[i], strategy);
    if (p === 0) return;
    const hi = A.h1Idx.get(ts);
    if (hi === undefined || hi + n >= A.h1.length || A.h1[hi + n].ts - ts !== n * H) return;
    const { ret, cost } = barrierResult(p, A.h1[hi].c, A.h1.slice(hi + 1, hi + 1 + n), taNetBarrierWidth(f.vol[k], D.sig[i]), strategy, nA);
    out.push({ ts, ret, cost, group: A.asset });
  });
  return out;
}

const b64 = (a: Float64Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const unb64 = (s: string) => { const b = Buffer.from(s, 'base64'); return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

interface SavedState {
  schema: string; dims: BranchDims; assets: string[]; norm: TaNetParams['norm']; trials: number; lastEvalTo: number; nextIndex: number;
  /** Which index series (and from when) the rows were built with: a change starts a fresh tournament. */
  contextSig?: string;
  /** Optimizer the population trained with ('adamw'); members trained otherwise start over. */
  optimizer?: string;
  log: PbtRoundLog[]; members: Array<{ id: number; hyper: Hyper; w: string; m: string; v: string; step: number; lineage: number[]; record: Array<[number, number, number, string]>; scores: Array<{ round: number; fitness: number }>; bornRound?: number }>;
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
  /** 'flat' (default) or 'grouped' (indicator families, bot/ta/branchNet.ts), and units per family. */
  arch?: 'flat' | 'grouped';
  famK?: number;
  trainMonths?: number;
  evalMonths?: number;
  stepMonths?: number;
  holdoutMonths?: number;
  /** Frozen final window: the most recent months, after the holdout, never used for training or
   *  selection; every head must also hold up there (0 = none). */
  finalMonths?: number;
  /** Use every k-th training sample per epoch (adjacent hours are highly correlated). */
  stride?: number;
  epochsPerRound?: number;
  minPerRegime?: number;
  dsrThreshold?: number;
  seed?: number;
  /** Persist / continue the population here. */
  statePath?: string;
  /** Restart the tournament even if a saved population exists. */
  fresh?: boolean;
  /** Stop after this many rounds in this call (testing / time budget). */
  maxRounds?: number;
  /** Override base hyperparameters (member 0; the others start within +/-10% of it). */
  baseHyper?: Partial<Hyper>;
  /** Every N rounds the culled member restarts from scratch with random knobs (0 = never). */
  restartEvery?: number;
  /** Extra epochs for an untrained network on its first block (the newcomer catches up with members
   *  that have trained on every earlier block; the three initial members get them too). */
  catchUpEpochs?: number;
  /** Compute the per-fractal-column pattern report on the holdout (default true). */
  patterns?: boolean;
  /** Months just before the holdout the final training pass leaves out, to fit the direction heads'
   *  calibration on data the network never trained on (default: one evaluation period; 0 = no calibration). */
  calibMonths?: number;
  /** The network live now: graded on the same holdout rows as the candidate (champion / challenger),
   *  when its inputs match and it never trained on that holdout. */
  incumbent?: TaNetParams;
  log?: (m: string) => void;
}

/** Holdout score of a network: mean over the heads of (model loss / naive loss); lower is better, 1 = naive. */
export interface ChampionScores { candidate: number; incumbent: number | null; incumbentVersion: string | null; why?: string; rows: number }

export interface TaNetReport { params: TaNetParams; rounds: number; newRounds: number; /** The tournament has reached the holdout (no rounds left to run). */ complete: boolean; remaining: number; champion?: ChampionScores }

export async function trainTaNet(D: TaNetData, o: TaNetTrainOpts = {}): Promise<TaNetReport> {
  const log = o.log ?? (() => {});
  const n = D.ts.length;
  if (n < 2000) throw new Error(`need at least 2000 hourly samples with full inputs (have ${n}): add more history`);
  const dims = taNetDims(o.arch ?? 'flat', o.famK ?? 4);
  const trainMs = (o.trainMonths ?? 12) * MONTH, evalMs = (o.evalMonths ?? 1) * MONTH, stepMs = (o.stepMonths ?? 1) * MONTH;
  const t0 = D.ts[0], tEnd = D.ts[n - 1] + H;
  const finalMonths = o.finalMonths ?? 2;
  const finalFrom = finalMonths > 0 ? Math.floor((tEnd - finalMonths * MONTH) / DAY) * DAY : tEnd;
  const holdoutFrom = Math.floor((finalFrom - (o.holdoutMonths ?? 3) * MONTH) / DAY) * DAY;
  const stride = Math.max(1, o.stride ?? 2), epochs = Math.max(1, o.epochsPerRound ?? 1), seed = o.seed ?? 7;
  const catchUp = Math.max(0, o.catchUpEpochs ?? 3);
  const minPerRegime = o.minPerRegime ?? 100, dsrThreshold = o.dsrThreshold ?? 0.95;
  const emb = 5 * H;
  const allRounds = walkForwardRounds(t0, holdoutFrom, trainMs, evalMs, stepMs);
  if (!allRounds.length) throw new Error(`need at least ${(o.trainMonths ?? 12) + (o.evalMonths ?? 1) + (o.holdoutMonths ?? 3) + finalMonths} months of history for one tournament round plus the holdout and the final window`);
  const between = (a: number, b: number, k = 1) => { const out: number[] = []; let c = 0; for (let i = 0; i < n; i++) if (D.ts[i] >= a && D.ts[i] < b) { if (c++ % k === 0) out.push(i); } return out; };

  // Saved population (continue) or a fresh one. New context data (say, BTC.D / USDT.D history imported
  // from TradingView) changes every past row, so the tournament starts over to learn from it.
  const contextSig = [...Object.entries(D.context.indexes).map(([k, v]) => `${k}:${v.from.slice(0, 7)}`).sort(), `basket:${D.context.basket.join(',')}`].join('|');
  let saved: SavedState | undefined;
  if (o.statePath && !o.fresh && fs.existsSync(o.statePath)) {
    try {
      saved = JSON.parse(fs.readFileSync(o.statePath, 'utf8')) as SavedState;
      if (saved.schema !== TANET_SCHEMA || JSON.stringify(saved.dims) !== JSON.stringify(dims) || saved.assets.join() !== D.assets.map((a) => a.asset).join()) { log('saved population is for other inputs; starting a fresh tournament'); saved = undefined; }
      else if (saved.optimizer !== 'adamw') { log('saved population trained with Adam + L2; starting a fresh tournament with AdamW'); saved = undefined; }
      else if ((saved.contextSig ?? '') !== contextSig) { log(`market context changed (${saved.contextSig || 'none'} -> ${contextSig || 'none'}); starting a fresh tournament`); saved = undefined; }
    } catch { saved = undefined; }
  }
  const norm = saved?.norm ?? fitNorms(D, between(allRounds[0].trainFrom, allRounds[0].trainTo));
  let rounds = saved ? allRounds.filter((r) => r.evalFrom >= saved!.lastEvalTo - 1) : allRounds;
  rounds = rounds.map((r, k) => ({ ...r, index: (saved?.nextIndex ?? 0) + k }));
  const pending = rounds.length;
  if (o.maxRounds !== undefined && o.maxRounds > 0) rounds = rounds.slice(0, o.maxRounds);
  const remaining = pending - rounds.length;
  const resume = saved ? {
    trials: saved.trials, log: saved.log,
    members: saved.members.map((m): PbtMember<Member> => ({ id: m.id, hyper: m.hyper, state: { w: unb64(m.w), m: unb64(m.m), v: unb64(m.v), step: m.step }, lineage: m.lineage, scores: m.scores, bornRound: m.bornRound, record: m.record.map(([ts, ret, cost, group]) => ({ ts, ret, cost, group })) })),
  } : undefined;
  log(`${n} samples over ${D.assets.map((a) => a.asset).join(', ')}; 15m input on ${(D.microShare * 100).toFixed(0)}% of them; ${saved ? `continuing a saved population (${saved.log.length} rounds so far)` : 'fresh population of 3'}; ${rounds.length} round(s) to run; holdout from ${new Date(holdoutFrom).toISOString().slice(0, 10)}`);

  const save = (members: PbtMember<Member>[], trials: number, plog: PbtRoundLog[], lastEvalTo: number, nextIndex: number) => {
    if (!o.statePath) return;
    const st: SavedState = {
      schema: TANET_SCHEMA, dims, assets: D.assets.map((a) => a.asset), norm, trials, lastEvalTo, nextIndex, contextSig, optimizer: 'adamw', log: plog,
      members: members.map((m) => ({ id: m.id, hyper: m.hyper, w: b64(m.state.w), m: b64(m.state.m), v: b64(m.state.v), step: m.state.step, lineage: m.lineage, scores: m.scores, bornRound: m.bornRound, record: m.record.map((x) => [x.ts, x.ret, x.cost, x.group ?? ''] as [number, number, number, string]) })),
    };
    fs.mkdirSync(path.dirname(o.statePath), { recursive: true });
    const tmp = `${o.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, o.statePath);
  };

  const size = branchLayout(dims).size;
  let inits = 0;
  const res = await runPbt<Member>({
    base: { ...BASE_HYPER, ...o.baseHyper } as Hyper, spec: HYPER_SPEC, rounds, seed, resume, exploreAfterLast: true, restartEvery: o.restartEvery ?? 0, log,
    hooks: {
      // Three identical networks: same seed, same weights; only the hyperparameters differ. A later
      // init is an exploration restart and gets fresh weights from a new seed.
      init: () => { const restart = resume !== undefined || inits >= 3; inits++; return { w: initBranchParams(dims, restart ? seed + 7919 * inits : seed), m: new Float64Array(size), v: new Float64Array(size), step: 0 }; },
      clone: (s) => ({ w: s.w.slice(), m: s.m.slice(), v: s.v.slice(), step: s.step }),
      train: (s, h, r: PbtRound) => {
        const idx = between(r.trainFrom, r.trainTo - emb, stride);
        const nEpochs = epochs + (s.step === 0 ? catchUp : 0);
        for (let e = 0; e < nEpochs; e++) trainEpoch(D, dims, norm, s, h, idx, seed + r.index * 131 + e);
        return s;
      },
      evaluate: (s, h, r: PbtRound) => {
        const idx = between(r.evalFrom, r.evalTo);
        const xs = strategyInteractions(D, forecast(D, dims, norm, s.w, h, idx), strategyOf(h));
        return { report: coverageFloor(fitnessOf(xs, { from: r.evalFrom, to: r.evalTo, clusterMs: H }), xs.length, idx.length), interactions: independentInteractions(xs, H) };
      },
    },
    onRound: ({ members, trials, log: plog, round }) => save(members, trials, plog, round.evalTo, round.index + 1),
  });
  if (!rounds.length && resume) Object.assign(res, { members: resume.members, trials: resume.trials, log: resume.log, elite: resume.members.find((m) => m.id === resume.log[resume.log.length - 1]?.ranking[0]?.member) ?? resume.members[0] });
  const elite = res.elite;

  // Bring the elite up to the holdout (one more pass on the block just before it), never past it. The
  // last calibMonths before the holdout are left out of that pass: the direction heads' calibration is
  // fitted there, on hours the network never trained on (raw probabilities are overconfident).
  const calibMonths = o.calibMonths ?? (o.evalMonths ?? 1);
  const calibFrom = Math.floor((holdoutFrom - calibMonths * MONTH) / DAY) * DAY;
  const finalW = elite.state.w.slice();
  const finalSt: Member = { w: finalW, m: elite.state.m.slice(), v: elite.state.v.slice(), step: elite.state.step };
  trainEpoch(D, dims, norm, finalSt, elite.hyper, between(calibFrom - trainMs, calibFrom - emb, stride), seed + 99_991);
  let calib: TaNetParams['calib'];
  if (calibMonths > 0) {
    const cr = between(calibFrom, holdoutFrom - emb);
    const raw = forecast(D, dims, norm, finalW, elite.hyper, cr);
    calib = { up_1h: fitPlatt(raw.up1, cr.map((i) => D.y1[i])), up_4h: fitPlatt(raw.up4, cr.map((i) => D.y4[i])) };
    for (const [k, c] of Object.entries(calib)) log(`calibration ${k}: a ${c!.a.toFixed(3)}, b ${c!.b.toFixed(3)} on ${c!.rows} rows (log loss ${c!.before.toFixed(5)} -> ${c!.after.toFixed(5)})`);
  }

  // Holdout: strategy fitness and per-head grading against the naive forecast. Then the frozen final
  // window, graded the same way; it decides nothing but whether the heads also hold up there.
  const strat = strategyOf(elite.hyper);
  const ho = between(holdoutFrom, finalFrom);
  const fc = forecast(D, dims, norm, finalW, elite.hyper, ho, undefined, calib);
  const hoX = strategyInteractions(D, fc, strat);
  const hoFit = fitnessOf(hoX, { from: holdoutFrom, to: finalFrom, clusterMs: H });
  const hoSel = selectiveStats(D, fc, strat);
  const fi = finalFrom < tEnd ? between(finalFrom, tEnd) : [];
  const fcF = fi.length ? forecast(D, dims, norm, finalW, elite.hyper, fi, undefined, calib) : undefined;
  const pre = between(holdoutFrom - trainMs, holdoutFrom - emb);
  const meanOf = (a: Float32Array, idx: number[]) => { let s = 0, c = 0; for (const i of idx) if (Number.isFinite(a[i])) { s += a[i]; c++; } return c ? s / c : NaN; };
  const ll = (p: number, y: number) => { const q = Math.min(1 - 1e-9, Math.max(1e-9, p)); return y ? -Math.log(q) : -Math.log(1 - q); };
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const gradeOn = (name: TaNetHeadName, rows: number[], f: Forecasts) => {
    const y = name === 'up_1h' ? D.y1 : name === 'up_4h' ? D.y4 : D.yv;
    const pred = name === 'up_1h' ? f.up1 : name === 'up_4h' ? f.up4 : f.vol;
    const base = meanOf(y, pre);
    const mL: number[] = [], bL: number[] = [], ts: number[] = [], ps: number[] = [], ys: number[] = [];
    rows.forEach((i, k) => {
      if (!Number.isFinite(y[i])) return;
      if (name === 'vol_4h') { mL.push((pred[k] - y[i]) ** 2); bL.push((base - y[i]) ** 2); } else { mL.push(ll(pred[k], y[i])); bL.push(ll(base, y[i])); ps.push(pred[k]); ys.push(y[i]); }
      ts.push(D.ts[i]);
    });
    const imp = dayBootstrap(bL.map((b, k) => b - mL[k]), ts);
    const out = {
      rows: mL.length, base: bL.reduce((a, b) => a + b, 0) / Math.max(1, bL.length), model: mL.reduce((a, b) => a + b, 0) / Math.max(1, mL.length), improvement: imp,
      skill: ps.length ? 1 - ps.reduce((a, p, k) => a + (p - ys[k]) ** 2, 0) / ps.length / 0.25 : undefined,
      hitRate: ps.length ? ps.filter((p, k) => (p > 0.5 ? 1 : 0) === ys[k]).length / ps.length : undefined,
    };
    return out;
  };
  const grade = (name: TaNetHeadName): TaNetHeadValidation => {
    const g = gradeOn(name, ho, fc);
    const v: TaNetHeadValidation = {
      metric: name === 'vol_4h' ? 'mse' : 'logloss', rows: g.rows, from: iso(holdoutFrom), to: iso(finalFrom),
      base: g.base, model: g.model, improvement: g.improvement, holdoutPassed: Number.isFinite(g.improvement.lo) && g.improvement.lo > 0, validated: false,
    };
    if (g.skill !== undefined) { v.skill = g.skill; v.hitRate = g.hitRate; }
    if (fcF) {
      const f = gradeOn(name, fi, fcF);
      v.final = { rows: f.rows, from: iso(finalFrom), to: iso(tEnd), base: f.base, model: f.model, improvement: f.improvement, hitRate: f.hitRate, passed: f.improvement.mean > 0 };
    }
    return v;
  };
  const patterns = o.patterns === false ? undefined : patternReport(D, dims, norm, finalW, elite.hyper, ho);
  if (patterns) {
    log(`pattern report (${patterns.rows} holdout rows; columns see ${patterns.reach.join(' / ')} bars): all columns logloss ${patterns.allColumns.logLossUp1h.toFixed(5)}, vol MSE ${patterns.allColumns.mseVol.toFixed(4)}`);
    for (const a of patterns.ablation) log(`  ${a.block} column ${a.column} (${a.reach} bars) alone: logloss ${a.logLossUp1h.toFixed(5)}, vol MSE ${a.mseVol.toFixed(4)}`);
    for (const b of Object.values(patterns.best ?? {})) log(`  ${b.block} ${b.family}: best tracked by column ${b.column} (${b.reach} bars), |corr| ${b.corr}`);
  }
  const heads = { up_1h: { validation: grade('up_1h') }, up_4h: { validation: grade('up_4h') }, vol_4h: { validation: grade('vol_4h') } };

  // Champion / challenger: the live network graded on the same holdout rows (mean over the heads of model
  // loss / naive loss). Only when its inputs match and its own holdout began no later than this one's
  // (so it never trained on these hours).
  const scoreOf = (f: Forecasts) => (['up_1h', 'up_4h', 'vol_4h'] as const).reduce((a, k) => { const g = gradeOn(k, ho, f); return a + g.model / Math.max(1e-12, g.base); }, 0) / 3;
  const champion: ChampionScores = { candidate: scoreOf(fc), incumbent: null, incumbentVersion: o.incumbent?.version ?? null, rows: ho.length };
  const inc = o.incumbent;
  if (inc) {
    const why = inc.schema !== TANET_SCHEMA ? `incumbent has schema ${inc.schema}` : JSON.stringify(inc.dims) !== JSON.stringify(dims) ? 'incumbent has another layout'
      : inc.trendFeatures.join() !== TANET_TREND_FEATURES.join() || inc.dayFeatures.join() !== TANET_DAY_FEATURES.join() ? 'incumbent reads other inputs'
      : !(Date.parse(inc.data.holdoutFrom) <= holdoutFrom) ? 'incumbent trained on part of this holdout' : undefined;
    if (why) champion.why = why;
    else {
      try {
        champion.incumbent = scoreOf(forecast(D, dims, inc.norm, Float64Array.from(inc.weights), inc.gates, ho, undefined, inc.calib));
      } catch (e) { champion.why = `incumbent could not be scored: ${(e as Error).message}`; }
    }
    log(`champion / challenger on ${ho.length} holdout rows: candidate ${champion.candidate.toFixed(5)}, incumbent ${inc.version} ${champion.incumbent?.toFixed(5) ?? `n/a (${champion.why})`} (model / naive loss, lower is better)`);
  }

  // Network-level hurdles on the elite lineage's out-of-sample record.
  const dsr = dsrOf(elite.record, H, res.trials);
  const regimes = regimeReport(elite.record, H, minPerRegime);
  const covered = regimes.filter((g) => {
    const def = elite.record.filter((x) => regimesIn(x.ts, x.ts + 1).includes(g.regime));
    return def.length && (Math.max(...def.map((x) => x.ts)) - Math.min(...def.map((x) => x.ts))) >= 60 * DAY;
  });
  const netOk = Number.isFinite(dsr.probability) && dsr.probability >= dsrThreshold && covered.every((g) => g.enough);
  const finalOk = (v: TaNetHeadValidation) => !v.final || v.final.passed;
  heads.vol_4h.validation.validated = heads.vol_4h.validation.holdoutPassed && finalOk(heads.vol_4h.validation);
  heads.up_1h.validation.validated = heads.up_1h.validation.holdoutPassed && finalOk(heads.up_1h.validation) && netOk;
  heads.up_4h.validation.validated = heads.up_4h.validation.holdoutPassed && finalOk(heads.up_4h.validation) && netOk;
  // The final window is a one-time test: count how often each window has been evaluated.
  let views = 0, finalNet: TaNetNetworkValidation['final'];
  if (fcF) {
    const ledger = o.statePath ? `${o.statePath}.final-views.json` : undefined;
    let seen: Record<string, number> = {};
    try { if (ledger && fs.existsSync(ledger)) seen = JSON.parse(fs.readFileSync(ledger, 'utf8')); } catch { /* fresh */ }
    views = (seen[iso(finalFrom)] ?? 0) + 1;
    seen[iso(finalFrom)] = views;
    if (ledger) { try { fs.writeFileSync(ledger, JSON.stringify(seen)); } catch { /* best effort */ } }
    const fx = strategyInteractions(D, fcF, strat);
    const ff = fitnessOf(fx, { from: finalFrom, to: tEnd, clusterMs: H });
    finalNet = { from: iso(finalFrom), to: iso(tEnd), fitness: ff.fitness, sortino: ff.sortino, maxDrawdown: ff.maxDrawdown, netReturn: ff.netReturn, selective: selectiveStats(D, fcF, strat), views };
  }
  const selTxt = (s: SelectiveStats) => `traded ${s.taken} of ${s.hours} hours (${(s.coverage * 100).toFixed(1)}%), win rate ${(s.hitRate * 100).toFixed(1)}% [${(s.hitLo * 100).toFixed(1)}, ${(s.hitHi * 100).toFixed(1)}]`;
  log(`elite #${elite.id} (lineage ${elite.lineage.join('>')}) hyper ${JSON.stringify(Object.fromEntries(Object.entries(elite.hyper).map(([k, v]) => [k, +v.toPrecision(3)])))}`);
  log(`out-of-sample record: ${dsr.n} independent interactions, Sharpe ${dsr.sharpe.toFixed(3)} vs ${dsr.sr0.toFixed(3)} expected from ${res.trials} trials; DSR probability ${dsr.probability.toFixed(3)} (need ${dsrThreshold}); regimes ${regimes.map((g) => `${g.regime}:${g.independent}`).join(' ')}`);
  log(`holdout barrier trades (minEdge ${strat.minEdge?.toFixed(3)}): ${selTxt(hoSel)}`);
  if (finalNet) log(`final window ${finalNet.from}..${finalNet.to} (evaluation #${views}${views > 1 ? ': no longer an unseen test' : ''}): fitness ${finalNet.fitness.toFixed(2)}, net ${(finalNet.netReturn * 100).toFixed(2)}%, ${selTxt(finalNet.selective)}; heads ${Object.entries(heads).map(([k, h]) => `${k} ${h.validation.final?.passed ? 'holds' : 'fails'}`).join(', ')}`);
  log(`holdout ${iso(holdoutFrom)}..${iso(finalFrom)}: fitness ${hoFit.fitness.toFixed(2)}, Sortino ${hoFit.sortino.toFixed(2)}, maxDD ${(hoFit.maxDrawdown * 100).toFixed(1)}%, net ${(hoFit.netReturn * 100).toFixed(2)}%`);
  for (const [k, h] of Object.entries(heads)) log(`${k}: holdout ${h.validation.metric} ${h.validation.model.toFixed(5)} vs ${h.validation.base.toFixed(5)}, CI [${h.validation.improvement.lo.toExponential(2)}, ${h.validation.improvement.hi.toExponential(2)}]${h.validation.hitRate !== undefined ? `, hit ${(h.validation.hitRate * 100).toFixed(2)}%` : ''}; speaks live: ${h.validation.validated}`);

  return {
    rounds: res.log.length, newRounds: rounds.length, complete: remaining === 0, remaining, champion,
    params: {
      version: `tanet5-${new Date().toISOString().slice(0, 10)}-${D.assets.length}a-r${res.log.length}`,
      schema: TANET_SCHEMA, dims, gates: gatesOf(elite.hyper), weights: Array.from(finalW), norm, patterns, context: D.context,
      trendFeatures: [...TANET_TREND_FEATURES], dayFeatures: [...TANET_DAY_FEATURES], strategy: strat, heads, taEngine: taEngine(), ...(calib ? { calib } : {}),
      arch: o.arch ?? 'flat', ...(dims.fam ? { familyNames: (() => { const f = taNetFamilies(); return [...f.trendNames.map((n) => `trend:${n}`), ...f.ctxNames.map((n) => `ctx:${n}`)]; })() } : {}),
      network: {
        dsr: { sharpe: dsr.sharpe, sr0: dsr.sr0, probability: dsr.probability, n: dsr.n }, trials: res.trials, regimes,
        holdout: { fitness: hoFit.fitness, sortino: hoFit.sortino, maxDrawdown: hoFit.maxDrawdown, costs: hoFit.costs, netReturn: hoFit.netReturn, independent: hoFit.independent, days: hoFit.days, selective: hoSel },
        final: finalNet,
        minIndependentPerRegime: minPerRegime, dsrThreshold, validated: netOk,
      },
      pbt: { rounds: res.log.length, trials: res.trials, elite: { member: elite.id, hyper: elite.hyper, lineage: elite.lineage }, recent: res.log.slice(-12) },
      data: { assets: D.assets.map((a) => a.asset), from: iso(t0), to: iso(tEnd), rows: n, sources: D.sources, holdoutFrom: iso(holdoutFrom), finalFrom: iso(finalFrom) },
      trainedAt: new Date().toISOString(),
    },
  };
}

export async function trainTaNetMain(argOf: (k: string, d: string) => string = cliArg): Promise<TaNetReport> {
  const log = (m: string) => console.log(`[ta-net] ${m}`);
  const hist = argOf('history', 'data/history');
  const spec = argOf('assets', 'all');
  const assets = spec === 'all' ? storedAssets(hist) : spec.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!assets.length) throw new Error(`need at least one asset with hourly history in ${hist} (npm run history:binance / history:import)`);
  const D = buildData(hist, assets, argOf('cache', path.join(hist, '.tanet-cache')), log);
  const num = (k: string, d: string) => Number(argOf(k, d));
  const rep = await trainTaNet(D, {
    trainMonths: num('train-months', '12'), evalMonths: num('eval-months', '1'), stepMonths: num('step-months', '1'), holdoutMonths: num('holdout-months', '3'), finalMonths: num('final-months', '2'),
    arch: argOf('arch', 'flat') === 'grouped' ? 'grouped' : 'flat', famK: num('fam-k', '4'),
    stride: num('stride', '2'), epochsPerRound: num('epochs', '1'), minPerRegime: num('min-per-regime', '100'), dsrThreshold: num('dsr', '0.95'),
    statePath: argOf('state', path.join(hist, '.tanet-population.json')), fresh: argOf('fresh', '') === 'true' || process.argv.includes('--fresh'),
    maxRounds: num('max-rounds', '0') || undefined, restartEvery: num('restart-every', '0'), catchUpEpochs: num('catch-up-epochs', '3'), patterns: argOf('patterns', 'true') !== 'false', log,
    calibMonths: argOf('calib-months', '') === '' ? undefined : num('calib-months', '1'),
    incumbent: (() => { const f = argOf('incumbent', ''); try { return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) as TaNetParams : undefined; } catch { return undefined; } })(),
  });
  const out = argOf('out', 'params/ta_net.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rep.params));
  console.table(Object.entries(rep.params.heads).map(([k, h]) => ({ head: k, holdout: `${h.validation.metric} ${h.validation.model.toFixed(5)} vs ${h.validation.base.toFixed(5)}`, hit: h.validation.hitRate !== undefined ? `${(h.validation.hitRate * 100).toFixed(2)}%` : '', holdoutPassed: h.validation.holdoutPassed, speaks: h.validation.validated })));
  log(`network: DSR probability ${rep.params.network.dsr.probability.toFixed(3)} over ${rep.params.network.trials} trials; validated=${rep.params.network.validated}; ${rep.complete ? 'tournament complete' : `${rep.remaining} round(s) still to run (continue with the same --state)`}; wrote ${out}`);
  return rep;
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

if (process.argv[1] && /trainTaNet\.(ts|js|cjs)$/.test(process.argv[1])) void trainTaNetMain().catch((e) => { console.error(e); process.exitCode = 1; });

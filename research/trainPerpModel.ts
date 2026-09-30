// Train and validate the stage-3 perp signal (bot/perps/perpSignal.ts).
//
//  1. Dataset: replay recordings; every `--every` seconds per perp market, the SAME feature
//     function production uses (perpFeatures) and the perp mid; the label is the perp's log return
//     over the horizon H (bps), read from later recorded quotes (never from the future at decision time).
//  2. Model: ridge regression on standardized features, lambda over a small grid.
//  3. Walk-forward: expanding-window folds in time order with an H embargo before each test block.
//     Every lambda is scored out of sample and counts as a trial for the deflated Sharpe.
//  4. Validation (all must hold): effective (non-overlapping) sample >= minEff; out-of-sample
//     information coefficient CI lower bound > 0 (moving-block bootstrap); the trading rule the live
//     trader uses (net of maker fees both ways and funding) has a positive per-trade P&L CI lower bound;
//     deflated Sharpe probability > 0.95.
//  5. Output: params/perp_model.candidate.json. Full-size live trading additionally needs the
//     execution backtest (research/perpBacktest.ts --annotate).
//
//   npm run research:perp-train -- --recordings data/recordings --every 300 --horizon 240

import fs from 'fs';
import path from 'path';
import { loadConfig } from '../bot/config';
import { PERP_FEATURES, perpFeatures, type PerpModelParams } from '../bot/perps/perpSignal';
import { readRecordings, ReplayState } from './replay';
import { deflatedSharpe, rng } from './stats';

export interface PerpRow { ts: number; asset: string; x: number[]; y: number; fundingBps: number }

/** Replay -> feature rows with forward-return labels. */
export async function buildPerpDataset(dir: string, opts: { everySec?: number; horizonMin?: number } = {}): Promise<PerpRow[]> {
  const every = (opts.everySec ?? 300) * 1000;
  const H = (opts.horizonMin ?? 240) * 60_000;
  const st = new ReplayState();
  const samples: Array<{ ts: number; asset: string; x: number[]; mid: number; fundingBps: number }> = [];
  const mids = new Map<string, Array<{ ts: number; mid: number }>>();
  const nextAt = new Map<string, number>();
  for await (const e of readRecordings(dir)) {
    st.apply(e);
    if (e.k !== 'perp') continue;
    const asset = (e as any).asset as string;
    const ps = st.features.perps.get(asset);
    const mid = ps?.price(st.now, 60_000);
    if (!mid) continue;
    const arr = mids.get(asset) ?? [];
    if (!arr.length || st.now - arr[arr.length - 1].ts >= 10_000) arr.push({ ts: st.now, mid });
    mids.set(asset, arr);
    if (st.now < (nextAt.get(asset) ?? 0)) continue;
    nextAt.set(asset, Math.floor(st.now / every + 1) * every);
    const f = perpFeatures(asset, st.now, { index: st.index.get(asset), spot: st.spot.get(asset), bars: st.features.bars.get(asset), candles: st.features.candles.get(asset), usdtd: st.usdtd, btcd: st.btcd, perp: ps });
    samples.push({ ts: st.now, asset, x: PERP_FEATURES.map((n) => f[n]), mid, fundingBps: Number.isFinite(f.funding_rate_bps) ? f.funding_rate_bps : 0 });
  }
  const rows: PerpRow[] = [];
  for (const s of samples) {
    const arr = mids.get(s.asset)!;
    // First recorded quote at or after ts + H (within 5 minutes).
    let lo = 0, hi = arr.length - 1, j = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].ts >= s.ts + H) { j = m; hi = m - 1; } else lo = m + 1; }
    if (j < 0 || arr[j].ts - (s.ts + H) > 300_000) continue;
    rows.push({ ts: s.ts, asset: s.asset, x: s.x, y: 1e4 * Math.log(arr[j].mid / s.mid), fundingBps: s.fundingBps });
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

/** Solve A x = b (Gaussian elimination with partial pivoting). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) { const k = M[r][c] / d; for (let q = c; q <= n; q++) M[r][q] -= k * M[c][q]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let q = r + 1; q < n; q++) s -= M[r][q] * x[q]; x[r] = s / (M[r][r] || 1e-12); }
  return x;
}

interface Fit { mean: number[]; std: number[]; w: number[]; b: number }

function fitRidge(rows: PerpRow[], lambda: number): Fit {
  const d = rows[0].x.length;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0), cnt = new Array(d).fill(0);
  for (const r of rows) r.x.forEach((v, i) => { if (Number.isFinite(v)) { mean[i] += v; cnt[i]++; } });
  mean.forEach((_, i) => { mean[i] = cnt[i] ? mean[i] / cnt[i] : 0; });
  for (const r of rows) r.x.forEach((v, i) => { if (Number.isFinite(v)) std[i] += (v - mean[i]) ** 2; });
  std.forEach((_, i) => { std[i] = cnt[i] > 1 ? Math.sqrt(std[i] / (cnt[i] - 1)) : 0; });
  const z = (r: PerpRow) => r.x.map((v, i) => (Number.isFinite(v) && std[i] > 0 ? Math.max(-5, Math.min(5, (v - mean[i]) / std[i])) : 0));
  const ybar = rows.reduce((s, r) => s + r.y, 0) / rows.length;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const bv = new Array(d).fill(0);
  for (const r of rows) {
    const zz = z(r);
    for (let i = 0; i < d; i++) { bv[i] += zz[i] * (r.y - ybar); for (let j = 0; j < d; j++) A[i][j] += zz[i] * zz[j]; }
  }
  for (let i = 0; i < d; i++) A[i][i] += lambda * rows.length / 100;
  return { mean, std, w: solve(A, bv), b: ybar };
}

const predict = (f: Fit, x: number[]) => f.b + x.reduce((s, v, i) => s + (Number.isFinite(v) && f.std[i] > 0 ? f.w[i] * Math.max(-5, Math.min(5, (v - f.mean[i]) / f.std[i])) : 0), 0);

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return NaN;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

/** Moving-block bootstrap of a statistic over paired rows. */
function blockCi(n: number, block: number, stat: (idx: number[]) => number, iters = 1000, seed = 3): { lo: number; hi: number } {
  const r = rng(seed);
  const vals: number[] = [];
  const b = Math.max(1, Math.min(block, n));
  for (let it = 0; it < iters; it++) {
    const idx: number[] = [];
    while (idx.length < n) { const s = Math.floor(r() * (n - b + 1)); for (let j = 0; j < b && idx.length < n; j++) idx.push(s + j); }
    vals.push(stat(idx));
  }
  vals.sort((a, c) => a - c);
  return { lo: vals[Math.floor(0.025 * iters)], hi: vals[Math.floor(0.975 * iters)] };
}

export interface TrainPerpOpts { horizonMin: number; everySec: number; folds?: number; lambdas?: number[]; makerBps?: number; entryEdgeBps?: number; minEff?: number }

export function trainPerp(rows: PerpRow[], o: TrainPerpOpts): { params: PerpModelParams; oos: { lambda: number; ic: number }[] } {
  if (rows.length < 50) throw new Error(`only ${rows.length} labelled rows: record more perp data first`);
  const folds = o.folds ?? 5, lambdas = o.lambdas ?? [0.1, 1, 10, 100];
  const maker = o.makerBps ?? 5, edge = o.entryEdgeBps ?? 5;
  const H = o.horizonMin * 60_000;
  const stride = Math.max(1, Math.round((o.horizonMin * 60) / o.everySec)); // rows per horizon (overlap)
  const n = rows.length;
  const start = Math.floor(n / (folds + 1));
  const blocks: Array<[number, number]> = [];
  for (let k = 0; k < folds; k++) blocks.push([start + Math.floor((k * (n - start)) / folds), start + Math.floor(((k + 1) * (n - start)) / folds)]);
  const oosPred = new Map<number, number[]>(lambdas.map((l) => [l, new Array(n).fill(NaN)]));
  for (const [a, b] of blocks) {
    const cut = rows[a].ts - H; // embargo: labels of training rows must end before the test block starts
    const train = rows.filter((r, i) => i < a && r.ts <= cut);
    if (train.length < 30) continue;
    for (const l of lambdas) {
      const f = fitRidge(train, l);
      for (let i = a; i < b; i++) oosPred.get(l)![i] = predict(f, rows[i].x);
    }
  }
  const scored = lambdas.map((l) => {
    const p = oosPred.get(l)!;
    const idx = p.map((v, i) => (Number.isFinite(v) ? i : -1)).filter((i) => i >= 0);
    return { lambda: l, ic: pearson(idx.map((i) => p[i]), idx.map((i) => rows[i].y)), idx };
  });
  const best = scored.reduce((x, y) => ((y.ic ?? -1) > (x.ic ?? -1) ? y : x));
  const p = oosPred.get(best.lambda)!;
  const idx = best.idx;
  const icCi = blockCi(idx.length, stride, (s) => pearson(s.map((j) => p[idx[j]]), s.map((j) => rows[idx[j]].y)));
  // The live trading rule on non-overlapping out-of-sample rows (one decision per horizon per asset).
  const trades: number[] = [];
  const lastTs = new Map<string, number>();
  for (const i of idx) {
    const r = rows[i];
    if (r.ts - (lastTs.get(r.asset) ?? -Infinity) < H) continue;
    lastTs.set(r.asset, r.ts);
    const fund = (dir: number) => dir * r.fundingBps * (o.horizonMin / 480);
    const net = (dir: number) => dir * p[i] - 2 * maker - fund(dir);
    const dir = net(1) >= net(-1) ? 1 : -1;
    if (net(dir) < edge) continue;
    trades.push(dir * r.y - 2 * maker - fund(dir));
  }
  const mean = trades.length ? trades.reduce((s, x) => s + x, 0) / trades.length : NaN;
  const pnlCi = trades.length >= 10 ? blockCi(trades.length, 1, (s) => s.reduce((a, j) => a + trades[j], 0) / s.length) : { lo: NaN, hi: NaN };
  const dsr = trades.length >= 10 ? deflatedSharpe(trades, lambdas.length).probability : 0;
  const resid = idx.map((i) => rows[i].y - p[i]);
  const residStd = Math.sqrt(resid.reduce((s, x) => s + x * x, 0) / Math.max(1, resid.length - 1));
  const nEff = Math.floor(idx.length / stride);
  const minEff = o.minEff ?? 200;
  const notes: string[] = [];
  if (nEff < minEff) notes.push(`effective sample ${nEff} < ${minEff}`);
  if (!(icCi.lo > 0)) notes.push(`IC CI lower bound ${icCi.lo?.toFixed(3)} <= 0`);
  if (!(pnlCi.lo > 0)) notes.push(`net P&L per trade CI lower bound ${pnlCi.lo?.toFixed(2)} bps <= 0 (${trades.length} trades)`);
  if (!(dsr > 0.95)) notes.push(`deflated Sharpe probability ${dsr.toFixed(3)} <= 0.95`);
  const final = fitRidge(rows, best.lambda);
  return {
    params: {
      version: `perp-ridge-${new Date().toISOString().slice(0, 10)}`, kind: 'linear', horizonMin: o.horizonMin, features: PERP_FEATURES,
      mean: final.mean, std: final.std, weights: final.w, bias: final.b, residStdBps: residStd || 1, lambda: best.lambda, trainedAt: new Date().toISOString(),
      validation: { passed: notes.length === 0, nEff, ic: best.ic, icCiLo: icCi.lo, pnlBpsPerTrade: mean, pnlCiLo: pnlCi.lo, dsrProbability: dsr, trials: lambdas.length, notes },
    },
    oos: scored.map((s) => ({ lambda: s.lambda, ic: s.ic })),
  };
}

async function main() {
  const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const cfg = loadConfig({ ...process.env, DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32), TRADING_MODE: 'paper' });
  const horizonMin = Number(arg('horizon', String(cfg.perps.horizonMin)));
  const everySec = Number(arg('every', '300'));
  const rows = await buildPerpDataset(arg('recordings', 'data/recordings'), { everySec, horizonMin });
  console.log(`${rows.length} labelled rows`);
  const res = trainPerp(rows, { horizonMin, everySec, makerBps: cfg.perps.makerFeeBps, entryEdgeBps: cfg.perps.entryEdgeBps });
  console.table(res.oos);
  console.log(JSON.stringify(res.params.validation, null, 1));
  const out = arg('out', 'params/perp_model.candidate.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(res.params, null, 1));
  console.log(`wrote ${out}. Next: npm run research:perp-backtest -- --model ${out} --annotate, then review and copy to params/perp_model.json.`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) void main();

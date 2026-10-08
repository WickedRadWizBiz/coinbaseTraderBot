// Train and validate the stage-3 perp signal (bot/perps/perpSignal.ts).
//
//  1. Dataset: replay recordings; every `--every` seconds per perp market, the SAME feature
//     function production uses (perpFeatures) and the perp mid; the label is the perp's log return
//     over the horizon H (bps), read from later recorded quotes (never from the future at decision time).
//     With --cache, each day's rows are kept and only days whose recordings (or neighbours) changed are
//     computed again, runs of them on --workers threads at once: years of history replay cost minutes a
//     run instead of hours.
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
import zlib from 'zlib';
import { loadConfig } from '../bot/config';
import { recordingFiles } from '../bot/marketdata/recordingFiles';
import { PERP_FEATURES, perpFeatures, PerpModel, type PerpModelParams } from '../bot/perps/perpSignal';
import { HOLDOUT_RULE, isHoldout, weekBlocks } from './historyLedger';
import { readRecordings, ReplayState } from './replay';
import { hashStr, replayPerpDays } from './history/historyReplay';
import { WorkerPool, workerCount, workerScript } from './workerPool';
import type { PerpDatasetJob } from './perpDatasetWorker';
import { deflatedSharpe, rng } from './stats';
import { gbdtLogit, type GbdtModel } from '../bot/model/trees';
import { trainGbdt } from './gbdt';

export interface PerpRow { ts: number; asset: string; x: number[]; y: number; fundingBps: number }

const DAY = 86_400_000;
/** Bumped when the rows change for the same recordings (the cache keys carry it). */
const PERP_DATASET_VERSION = 1;

/** Feature rows with forward-return labels for a run of consecutive recorded days (`days`, in order). The
 *  replay starts with `warm` (the recorded day before: the trackers warm up) and reads on into `tail` (the
 *  day after) only as far as the last samples' labels need. A sample is taken once its whole instant is in
 *  (the history replay writes every asset's prices and the dominance of an instant as one burst). */
export async function perpRowsForDays(dir: string, days: string[], warm: string | undefined, tail: string | undefined, opts: { everySec?: number; horizonMin?: number } = {}): Promise<PerpRow[]> {
  if (!days.length) return [];
  const every = (opts.everySec ?? 300) * 1000;
  const H = (opts.horizonMin ?? 240) * 60_000;
  const from = Date.parse(days[0]), to = Date.parse(days[days.length - 1]) + DAY;
  const st = new ReplayState();
  const samples: Array<{ ts: number; asset: string; x: number[]; mid: number; fundingBps: number }> = [];
  const mids = new Map<string, Array<{ ts: number; mid: number }>>();
  const nextAt = new Map<string, number>();
  const quoted = new Set<string>();
  for await (const e of readRecordings(dir, undefined, warm ?? days[0], tail ?? days[days.length - 1])) {
    if (e.t >= to + H + 300_000) break;
    st.apply(e);
    if (e.k === 'perp') quoted.add((e as any).asset as string);
    if (e.tie || !quoted.size) continue;
    for (const asset of quoted) {
      const ps = st.features.perps.get(asset);
      const mid = ps?.price(st.now, 60_000);
      if (!mid) continue;
      const arr = mids.get(asset) ?? [];
      if (!arr.length || st.now - arr[arr.length - 1].ts >= 60_000) arr.push({ ts: st.now, mid }); // label prices: one a minute (years of replay fit in memory)
      mids.set(asset, arr);
      if (st.now < from || st.now >= to || st.now < (nextAt.get(asset) ?? 0)) continue;
      nextAt.set(asset, Math.floor(st.now / every + 1) * every);
      const f = perpFeatures(asset, st.now, { index: st.index.get(asset), spot: st.spot.get(asset), bars: st.features.bars.get(asset), candles: st.features.candles.get(asset), usdtd: st.usdtd, btcd: st.btcd, perp: ps, snn: st.snnContext(asset, undefined, 'perps') });
      samples.push({ ts: st.now, asset, x: PERP_FEATURES.map((n) => f[n]), mid, fundingBps: Number.isFinite(f.funding_rate_bps) ? f.funding_rate_bps : 0 });
    }
    quoted.clear();
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

export interface PerpDatasetOpts {
  everySec?: number; horizonMin?: number;
  /** Keep each day's rows here; a day is computed again only when its recording, a neighbour's (warm-up,
   *  labels) or its SNN backfill changed. */
  cacheDir?: string;
  /** Worker threads computing runs of uncached days at once (default 1). */
  workers?: number;
  log?: (m: string) => void;
}
interface PerpCacheFile { sig: string; assets: string[]; rows: Array<Array<number | null>> }

/** Replay -> feature rows with forward-return labels (history replay: the days with perp quotes). */
export async function buildPerpDataset(dir: string, opts: PerpDatasetOpts = {}): Promise<PerpRow[]> {
  const files = recordingFiles(dir);
  const all = files.map((f) => f.day);
  if (!all.length) return [];
  if (!opts.cacheDir) return perpRowsForDays(dir, all, undefined, undefined, opts);
  const log = opts.log ?? (() => {});
  const every = (opts.everySec ?? 300) * 1000, H = (opts.horizonMin ?? 240) * 60_000;
  const perpDays = new Set(replayPerpDays(dir));
  const days = perpDays.size ? all.filter((d) => perpDays.has(d)) : all;
  const pos = new Map(all.map((d, i) => [d, i]));
  const fileOf = new Map(files.map((f) => [f.day, f.file]));
  const stat = (d: string | undefined) => { const f = d && fileOf.get(d); if (!f) return '-'; try { const x = fs.statSync(f); return `${x.size}.${Math.round(x.mtimeMs)}`; } catch { return '-'; } };
  const sides = (process.env.SNN_BACKFILL_DIR ?? '').split(path.delimiter).filter(Boolean);
  const sideStat = (d: string) => sides.map((x) => { try { return fs.statSync(path.join(x, `snnfill-${d}.jsonl`)).size; } catch { return 0; } }).join('.');
  const head = `${PERP_DATASET_VERSION}|${every}|${H}|${hashStr(PERP_FEATURES.join(','))}`;
  const sigOf = (d: string) => { const i = pos.get(d)!; return `${head}|${stat(all[i - 1])}|${stat(d)}|${stat(all[i + 1])}|${sideStat(d)}`; };
  const cacheFile = (d: string) => path.join(opts.cacheDir!, `${d}.json.gz`);
  fs.mkdirSync(opts.cacheDir, { recursive: true });
  const byDay = new Map<string, PerpRow[]>();
  const todo: string[] = [];
  for (const d of days) {
    try {
      const c = JSON.parse(zlib.gunzipSync(fs.readFileSync(cacheFile(d))).toString('utf8')) as PerpCacheFile;
      if (c.sig === sigOf(d)) {
        byDay.set(d, c.rows.map((r) => ({ ts: r[0] as number, asset: c.assets[r[1] as number], y: r[2] as number, fundingBps: r[3] as number, x: r.slice(4).map((v) => (v === null ? NaN : v)) })));
        continue;
      }
    } catch { /* not cached yet */ }
    todo.push(d);
  }
  // Runs of consecutive recorded days, cut into chunks a few per worker (each chunk replays one extra
  // day to warm up and part of the next for its labels).
  const workers = Math.max(1, opts.workers ?? 1);
  const size = Math.max(7, Math.ceil(todo.length / (workers * 3)));
  const jobs: PerpDatasetJob[] = [];
  for (let i = 0; i < todo.length;) {
    let j = i;
    while (j + 1 < todo.length && j + 1 - i < size && pos.get(todo[j + 1]) === pos.get(todo[j])! + 1) j++;
    const run = todo.slice(i, j + 1);
    jobs.push({ dir, days: run, warm: all[pos.get(run[0])! - 1], tail: all[pos.get(run[run.length - 1])! + 1], everySec: opts.everySec, horizonMin: opts.horizonMin });
    i = j + 1;
  }
  if (jobs.length) log(`perp dataset: ${byDay.size} day(s) cached, ${todo.length} to compute in ${jobs.length} run(s)${workers > 1 ? ` on ${workers} threads` : ''}`);
  const pool = workers > 1 && jobs.length > 1 ? new WorkerPool<PerpDatasetJob, PerpRow[]>(workerScript('perpDatasetWorker'), workers) : undefined;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  try {
    await Promise.all(jobs.map(async (job) => {
      const rows = pool ? await pool.run(job) : await perpRowsForDays(job.dir, job.days, job.warm, job.tail, job);
      const got = new Map<string, PerpRow[]>(job.days.map((d) => [d, []]));
      for (const r of rows) got.get(iso(r.ts))?.push(r);
      for (const [d, rs] of got) {
        byDay.set(d, rs);
        const assets = [...new Set(rs.map((r) => r.asset))];
        const c: PerpCacheFile = { sig: sigOf(d), assets, rows: rs.map((r) => [r.ts, assets.indexOf(r.asset), r.y, r.fundingBps, ...r.x.map((v) => (Number.isFinite(v) ? v : null))]) };
        fs.writeFileSync(`${cacheFile(d)}.tmp`, zlib.gzipSync(JSON.stringify(c)));
        fs.renameSync(`${cacheFile(d)}.tmp`, cacheFile(d));
      }
    }));
  } finally { await pool?.close(); }
  return days.flatMap((d) => byDay.get(d) ?? []).sort((a, b) => a.ts - b.ts);
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

export interface TrainPerpOpts { horizonMin: number; everySec: number; folds?: number; lambdas?: number[]; makerBps?: number; entryEdgeBps?: number; minEff?: number; trees?: boolean }

type Cand = number | 'gbdt';

/** Boosted regression trees on the raw features (missing values routed by the trees); early
 *  stopping on the last 20% of the training rows by time, with a horizon-long embargo. */
function fitTrees(train: PerpRow[], H: number): GbdtModel | undefined {
  if (train.length < 60) return undefined;
  const vi = Math.floor(train.length * 0.8);
  const vStart = train[vi].ts;
  const tr = train.filter((r) => r.ts <= vStart - H), va = train.slice(vi);
  if (tr.length < 40 || va.length < 10) return undefined;
  const ybar = tr.reduce((s, r) => s + r.y, 0) / tr.length;
  const ones = (k: number) => new Array(k).fill(1), base = (k: number) => new Array(k).fill(ybar);
  const g = trainGbdt(tr.map((r) => r.x), tr.map((r) => r.y), ones(tr.length), base(tr.length), va.map((r) => r.x), va.map((r) => r.y), ones(va.length), base(va.length),
    { loss: 'squared', nTrees: 200, learningRate: 0.05, maxDepth: 2, minLeafWeight: 20, seed: 7 });
  return { ...g.model, baseScore: ybar };
}

/** The live trading rule on rows in time order with forecasts `p(i)` (bps): one decision per horizon per
 *  asset, taken when the better side's forecast, after maker fees both ways and the funding over the
 *  horizon, clears the entry edge. Each trade's net P&L (bps). */
export function ruleTrades(rows: PerpRow[], p: (i: number) => number, idx: Iterable<number>, o: { horizonMin: number; makerBps: number; entryEdgeBps: number }): number[] {
  const H = o.horizonMin * 60_000, maker = o.makerBps;
  const trades: number[] = [];
  const lastTs = new Map<string, number>();
  for (const i of idx) {
    const r = rows[i];
    if (r.ts - (lastTs.get(r.asset) ?? -Infinity) < H) continue;
    lastTs.set(r.asset, r.ts);
    const fund = (dir: number) => dir * r.fundingBps * (o.horizonMin / 480);
    const net = (dir: number) => dir * p(i) - 2 * maker - fund(dir);
    const dir = net(1) >= net(-1) ? 1 : -1;
    if (net(dir) < o.entryEdgeBps) continue;
    trades.push(dir * r.y - 2 * maker - fund(dir));
  }
  return trades;
}

/** A trained model's record on rows it never saw (a champion contest on the held-out weeks): the live
 *  rule's trades and their mean net P&L (bps), and the forecasts' information coefficient. */
export function perpRuleRecord(model: PerpModel, rows: PerpRow[], o: { horizonMin: number; makerBps: number; entryEdgeBps: number }): { trades: number; meanBps: number; ic: number } {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  const preds = sorted.map((r) => model.predict(Object.fromEntries(PERP_FEATURES.map((n, k) => [n, r.x[k]]))).muBps);
  const t = ruleTrades(sorted, (i) => preds[i], sorted.keys(), o);
  return { trades: t.length, meanBps: t.length ? t.reduce((a, x) => a + x, 0) / t.length : NaN, ic: pearson(preds, sorted.map((r) => r.y)) };
}

/** Days of the history-ledger holdout weeks among the recorded days (research/historyLedger.ts). */
export function holdoutDays(days: string[]): Set<string> {
  const latest = days[days.length - 1];
  return new Set(weekBlocks(days).filter((b) => isHoldout(b, latest)).flatMap((b) => b.days));
}

export function trainPerp(rows: PerpRow[], o: TrainPerpOpts): { params: PerpModelParams; oos: { lambda: Cand; ic: number }[] } {
  if (rows.length < 50) throw new Error(`only ${rows.length} labelled rows: record more perp data first`);
  const folds = o.folds ?? 5, lambdas = o.lambdas ?? [0.1, 1, 10, 100];
  const maker = o.makerBps ?? 5, edge = o.entryEdgeBps ?? 5;
  const H = o.horizonMin * 60_000;
  const stride = Math.max(1, Math.round((o.horizonMin * 60) / o.everySec)); // rows per horizon (overlap)
  const n = rows.length;
  const start = Math.floor(n / (folds + 1));
  const blocks: Array<[number, number]> = [];
  for (let k = 0; k < folds; k++) blocks.push([start + Math.floor((k * (n - start)) / folds), start + Math.floor(((k + 1) * (n - start)) / folds)]);
  // Candidates: ridge at each lambda, and boosted regression trees (squared loss), all walked
  // forward on the same folds and judged on the same out-of-sample IC.
  const cands: Cand[] = [...lambdas, ...(o.trees === false ? [] : ['gbdt' as const])];
  const oosPred = new Map<Cand, number[]>(cands.map((l) => [l, new Array(n).fill(NaN)]));
  for (const [a, b] of blocks) {
    const cut = rows[a].ts - H; // embargo: labels of training rows must end before the test block starts
    const train = rows.filter((r, i) => i < a && r.ts <= cut);
    if (train.length < 30) continue;
    for (const l of cands) {
      if (l === 'gbdt') {
        const g = fitTrees(train, H);
        for (let i = a; i < b; i++) oosPred.get(l)![i] = g ? gbdtLogit(g, rows[i].x) : NaN;
        continue;
      }
      const f = fitRidge(train, l);
      for (let i = a; i < b; i++) oosPred.get(l)![i] = predict(f, rows[i].x);
    }
  }
  const scored = cands.map((l) => {
    const p = oosPred.get(l)!;
    const idx = p.map((v, i) => (Number.isFinite(v) ? i : -1)).filter((i) => i >= 0);
    return { lambda: l, ic: pearson(idx.map((i) => p[i]), idx.map((i) => rows[i].y)), idx };
  });
  const best = scored.reduce((x, y) => ((y.ic ?? -1) > (x.ic ?? -1) ? y : x));
  const p = oosPred.get(best.lambda)!;
  const idx = best.idx;
  const icCi = blockCi(idx.length, stride, (s) => pearson(s.map((j) => p[idx[j]]), s.map((j) => rows[idx[j]].y)));
  // The live trading rule on non-overlapping out-of-sample rows (one decision per horizon per asset).
  const trades = ruleTrades(rows, (i) => p[i], idx, { horizonMin: o.horizonMin, makerBps: maker, entryEdgeBps: edge });
  const mean = trades.length ? trades.reduce((s, x) => s + x, 0) / trades.length : NaN;
  const pnlCi = trades.length >= 10 ? blockCi(trades.length, 1, (s) => s.reduce((a, j) => a + trades[j], 0) / s.length) : { lo: NaN, hi: NaN };
  const dsr = trades.length >= 10 ? deflatedSharpe(trades, cands.length).probability : 0;
  const resid = idx.map((i) => rows[i].y - p[i]);
  const residStd = Math.sqrt(resid.reduce((s, x) => s + x * x, 0) / Math.max(1, resid.length - 1));
  const nEff = Math.floor(idx.length / stride);
  const minEff = o.minEff ?? 200;
  const notes: string[] = [];
  if (nEff < minEff) notes.push(`effective sample ${nEff} < ${minEff}`);
  if (!(icCi.lo > 0)) notes.push(`IC CI lower bound ${icCi.lo?.toFixed(3)} <= 0`);
  if (!(pnlCi.lo > 0)) notes.push(`net P&L per trade CI lower bound ${pnlCi.lo?.toFixed(2)} bps <= 0 (${trades.length} trades)`);
  if (!(dsr > 0.95)) notes.push(`deflated Sharpe probability ${dsr.toFixed(3)} <= 0.95`);
  const validation = { passed: notes.length === 0, nEff, ic: best.ic, icCiLo: icCi.lo, pnlBpsPerTrade: mean, pnlCiLo: pnlCi.lo, dsrProbability: dsr, trials: cands.length, notes };
  const common = { horizonMin: o.horizonMin, features: PERP_FEATURES, residStdBps: residStd || 1, trainedAt: new Date().toISOString(), validation };
  const trees = best.lambda === 'gbdt' ? fitTrees(rows, H) : undefined;
  if (trees) {
    const d = PERP_FEATURES.length;
    return {
      params: { ...common, version: `perp-gbdt-${new Date().toISOString().slice(0, 10)}`, kind: 'gbdt', gbdt: trees, mean: new Array(d).fill(0), std: new Array(d).fill(1), weights: [], bias: 0, lambda: NaN },
      oos: scored.map((s) => ({ lambda: s.lambda, ic: s.ic })),
    };
  }
  const lam = typeof best.lambda === 'number' ? best.lambda : lambdas[0];
  const final = fitRidge(rows, lam);
  return {
    params: { ...common, version: `perp-ridge-${new Date().toISOString().slice(0, 10)}`, kind: 'linear', mean: final.mean, std: final.std, weights: final.w, bias: final.b, lambda: lam },
    oos: scored.map((s) => ({ lambda: s.lambda, ic: s.ic })),
  };
}

export async function trainPerpMain(argOf: (k: string, d: string) => string = cliArg, annotate: boolean = process.argv.includes('--annotate')) {
  const cfg = loadConfig({ ...process.env, DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32), TRADING_MODE: 'paper' });
  const horizonMin = Number(argOf('horizon', String(cfg.perps.horizonMin)));
  const everySec = Number(argOf('every', '300'));
  const dir = argOf('recordings', 'data/recordings');
  let rows = await buildPerpDataset(dir, { everySec, horizonMin, cacheDir: argOf('cache', '') || undefined, workers: Number(argOf('workers', String(workerCount()))), log: (m) => console.log(m) });
  // --holdout ledger: the history ledger's held-out weeks are left out (champion contests are run there), and
  // so are the rows just before them whose label (the return over the horizon) ends inside one.
  const held = argOf('holdout', '') === 'ledger' ? holdoutDays(recordingFiles(dir).map((f) => f.day)) : undefined;
  const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
  if (held) { const n = rows.length; rows = rows.filter((r) => !held.has(dayOf(r.ts)) && !held.has(dayOf(r.ts + horizonMin * 60_000))); console.log(`held out ${n - rows.length} rows of ${held.size / 7} holdout week(s)`); }
  console.log(`${rows.length} labelled rows`);
  const res = trainPerp(rows, { horizonMin, everySec, makerBps: cfg.perps.makerFeeBps, entryEdgeBps: cfg.perps.entryEdgeBps });
  if (held) res.params.holdout = HOLDOUT_RULE;
  console.table(res.oos);
  console.log(JSON.stringify(res.params.validation, null, 1));
  const out = argOf('out', 'params/perp_model.candidate.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(res.params, null, 1));
  console.log(`wrote ${out}. Next: npm run research:perp-backtest -- --model ${out} --annotate, then review and copy to params/perp_model.json.`);
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void trainPerpMain();

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

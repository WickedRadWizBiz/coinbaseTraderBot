// Initialises the TA network (bot/ta/taNet.ts) with a population tournament over years of hourly
// history (research/history): three identical three-branch networks (bot/ta/branchNet.ts) with
// slightly different hyperparameters train walk-forward and fight for fitness (research/pbt.ts).
//
//   npm run research:ta-net                                   # every asset in data/history
//   npm run research:ta-net -- --assets BTC,ETH,SOL --out params/ta_net.json
//   npm run research:ta-net -- --train-months 12 --eval-months 1 --holdout-months 3 --stride 2
//   npm run research:ta-net -- --engine auto        # train in PyTorch (GPU when there is one; research/taNetTorch.ts)
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
import os from 'os';
import path from 'path';
import type { Candle } from '../bot/ta/indicators';
import { branchBackward, branchForward, branchLayout, branchLoss, fractalPlan, fractalSpecs, initBranchParams, type BranchDims, type BranchDrop, type BranchGates } from '../bot/ta/branchNet';
import { columnMask, columnReach, localDropMask, type FractalPlan, type JoinMask } from '../bot/ta/fractal';
import {
  buildBranchInput, closedIndex, sigma24, TANET_CTX_FEATURES, TANET_CTX_HOURLY, TANET_D1_BARS, TANET_DAY_FEATURES, TANET_FEATURES, TANET_H1_BARS, TANET_MACRO_DAYS, TANET_MICRO_F, TANET_MICRO_STEPS, TANET_SCHEMA,
  TANET_STRATEGY, TANET_SWING_BARS, TANET_SWING_F, TANET_TREND_FEATURES, TANET_TREND_STEPS, taNetDayVector, taNetFeatureMap, barrierResult, taNetBarrierPosition, taNetBarrierWidth, TANET_BARRIER, tripleBarrier, taNetMicro, taNetSwing, windowOk,
  taNetFamilies, calibrated, fitPlatt, type PatternReport, type TaNetHeadName, type TaNetNetworkValidation, type TaNetStrategy, type TaNetHeadValidation, type TaNetNorm, type TaNetParams, type TaNetStateCache,
  cullNorm,
} from '../bot/ta/taNet';
import { coverageFloor as sharedCoverageFloor } from '../bot/util/fitness';
import { maxOf, minOf } from '../bot/util/num';
import { dsrOf, fitnessOf, independentInteractions, regimeReport, regimesIn, type FitnessReport, type Interaction } from './fitness';
import { fileMemberProgress, runPbt, walkForwardRounds, type GeneticOpts, type Hyper, type MutationSpec, type PbtMember, type PbtRound, type PbtRoundLog } from './pbt';
import { DEFAULT_TRANSITION, pboGate, tournamentPbo, transitionPenalty, type Transition } from './selection';
import { regimeTransitions } from './transitions';
import { readCull } from './cullFile';
import type { GaGeneration, GaState } from './genetic';
import { loadIndexSeries, loadSeries, storedAssets } from './history/candles';
import { DAILY_CONTEXT_FEATURES, SLOW_INDEXES, TaNetContext } from '../bot/ta/taNetContext';
import { rng } from './stats';
import { TaNetTorch, type TaNetEngine } from './taNetTorch';
import { progress } from './progress';
import { taRowWorkerCount, WorkerPool, workerScript } from './workerPool';
import { sessionTimeUp } from './sessionClock';

const H = 3_600_000;
const DAY = 86_400_000;
const MONTH = 30.44 * DAY;

const barStr = (c: Candle) => `${c.ts},${c.o},${c.h},${c.l},${c.c},${c.v},${c.tb ?? ''};`;
const hashBars = (h: crypto.Hash, cs: Candle[]) => { for (const c of cs) h.update(barStr(c)); };

/** Everything a cached feature row depends on besides the asset's own hourly / daily bars: its 15m bars,
 *  every basket coin's hourly bars, BTCDOM and the daily index charts, up to the row's hour (rows only ever look
 *  backwards). */
export interface RowInputs { m15?: Candle[]; basket: Record<string, Candle[]>; btcdom?: Candle[]; daily?: Record<string, Candle[]> }

/** The cache signature before monthly checkpoints (caches written by earlier versions are still accepted). */
export function legacySig(h1: Candle[], d1: Candle[], inp: RowInputs | undefined, through: number): string {
  const h = crypto.createHash('sha1');
  hashBars(h, h1.filter((c) => c.ts <= through));
  hashBars(h, d1.filter((c) => c.ts + DAY <= through + H));
  if (inp) {
    hashBars(h, (inp.m15 ?? []).filter((c) => c.ts <= through));
    for (const a of Object.keys(inp.basket).sort()) { h.update(`|${a}|`); hashBars(h, inp.basket[a].filter((c) => c.ts <= through)); }
    h.update('|BTCDOM|');
    hashBars(h, (inp.btcdom ?? []).filter((c) => c.ts <= through));
  }
  return h.digest('hex');
}

const monthOf = (ts: number) => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const monthCache = new WeakMap<Candle[], { n: number; last: number; m: Map<number, string> }>();
/** sha1 of each calendar month's bars (UTC) of one series; computed once per series (the basket coins are shared
 *  by every asset). */
function monthDigests(cs: Candle[]): Map<number, string> {
  const hit = monthCache.get(cs);
  if (hit && hit.n === cs.length && hit.last === (cs[cs.length - 1]?.ts ?? 0)) return hit.m;
  const m = new Map<number, string>();
  for (let i = 0; i < cs.length;) {
    const k = monthOf(cs[i].ts), h = crypto.createHash('sha1');
    let j = i;
    for (; j < cs.length && monthOf(cs[j].ts) === k; j++) h.update(barStr(cs[j]));
    m.set(k, (m.get(k) ?? '') + h.digest('hex'));
    i = j;
  }
  monthCache.set(cs, { n: cs.length, last: cs[cs.length - 1]?.ts ?? 0, m });
  return m;
}

/** Cumulative signatures of a row's inputs: one per complete calendar month before `through`'s month (everything
 *  up to that month's end), and `tail` (everything up to `through`). A row at hour t reads bars up to t only, so
 *  when the first differing month is k, the cached rows before month k still hold. */
export function rowCheckpoints(h1: Candle[], d1: Candle[], inp: RowInputs | undefined, through: number): { months: Array<[number, string]>; tail: string } {
  const src: Array<[string, Candle[], (c: Candle) => boolean]> = [['h1', h1, (c) => c.ts <= through], ['d1', d1, (c) => c.ts + DAY <= through + H]];
  if (inp) {
    src.push(['m15', inp.m15 ?? [], (c) => c.ts <= through]);
    for (const a of Object.keys(inp.basket).sort()) src.push([`b:${a}`, inp.basket[a], (c) => c.ts <= through]);
    src.push(['dom', inp.btcdom ?? [], (c) => c.ts <= through]);
    for (const k of Object.keys(inp.daily ?? {}).sort()) src.push([`ix:${k}`, inp.daily![k], (c) => c.ts + DAY <= through + H]);
  }
  const cur = monthOf(through);
  const digests = src.map(([name, cs]) => [name, monthDigests(cs)] as const);
  const keys = [...new Set(digests.flatMap(([, m]) => [...m.keys()]))].filter((k) => k < cur).sort((x, y) => x - y);
  const run = crypto.createHash('sha1');
  const months: Array<[number, string]> = [];
  for (const k of keys) {
    for (const [name, m] of digests) { const d = m.get(k); if (d) run.update(`${name}=${d};`); }
    months.push([k, run.copy().digest('hex')]);
  }
  const tail = run.copy();
  for (const [name, cs, ok] of src) {
    let started = false;
    for (let i = lowerBound(cs, cur); i < cs.length && cs[i].ts <= through; i++) if (ok(cs[i])) { if (!started) { tail.update(`${name}:`); started = true; } tail.update(barStr(cs[i])); }
  }
  return { months, tail: tail.digest('hex') };
}

function lowerBound(cs: Candle[], ts: number): number {
  let lo = 0, hi = cs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cs[mid].ts < ts) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Cached rows from this hour on are recomputed: the first month whose inputs differ (a day early: margin), or
 *  Infinity when every input up to the cache's last hour is unchanged. */
export function keepRowsBefore(stored: { months: Array<[number, string]>; tail: string }, now: { months: Array<[number, string]>; tail: string }, through: number): number {
  const a = new Map(stored.months), b = new Map(now.months);
  for (const k of [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y)) if (a.get(k) !== b.get(k)) return k - DAY;
  return stored.tail === now.tail ? Infinity : monthOf(through) - DAY;
}

interface RowCacheMeta { schema: string; d: number; through: number; ts: number[]; sig?: string; v?: number; months?: Array<[number, string]>; tail?: string }

/** Feature rows for one asset, reusing the cache for the hours whose inputs have not changed. */
export function assetRows(asset: string, h1: Candle[], d1: Candle[], cacheDir: string | undefined, log: (m: string) => void, ctx?: TaNetContext, inputs?: RowInputs): { ts: number[]; X: Float32Array; computed: number } {
  const d = TANET_FEATURES.length;
  let cachedTs: number[] = [], cachedX = new Float32Array(0);
  let upgrade = false;
  const meta = cacheDir ? path.join(cacheDir, `${asset}.json`) : undefined, bin = cacheDir ? path.join(cacheDir, `${asset}.f32`) : undefined;
  if (meta && bin && fs.existsSync(meta) && fs.existsSync(bin)) {
    try {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8')) as RowCacheMeta;
      if (m.schema === TANET_SCHEMA && m.d === d) {
        let keep: number;
        if (m.v === 2 && m.months && m.tail) keep = keepRowsBefore({ months: m.months, tail: m.tail }, rowCheckpoints(h1, d1, inputs, m.through), m.through);
        else { keep = m.sig === legacySig(h1, d1, inputs, m.through) ? Infinity : -Infinity; upgrade = keep === Infinity; }
        const buf = fs.readFileSync(bin);
        const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        let n = 0;
        while (n < m.ts.length && m.ts[n] < keep) n++;
        cachedTs = m.ts.slice(0, n);
        cachedX = all.slice(0, n * d);
        if (n === 0 && m.ts.length) log(`${asset}: history or features changed since the cache was written; rebuilding its rows`);
        else if (n < m.ts.length) log(`${asset}: inputs changed from ${new Date(m.ts[n]).toISOString().slice(0, 10)}; recomputing ${m.ts.length - n} cached rows from there (${n} kept)`);
      } else log(`${asset}: the cache is for other features; rebuilding its rows`);
    } catch { cachedTs = []; cachedX = new Float32Array(0); }
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
  if (meta && bin && (newTs.length || upgrade) && ts.length) {
    fs.mkdirSync(cacheDir!, { recursive: true });
    const through = h1[h1.length - 1].ts;
    const cp = rowCheckpoints(h1, d1, inputs, through);
    const tmp = `${bin}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(X.buffer, X.byteOffset, X.byteLength));
    fs.renameSync(tmp, bin);
    fs.writeFileSync(meta, JSON.stringify({ schema: TANET_SCHEMA, d, through, v: 2, months: cp.months, tail: cp.tail, ts } satisfies RowCacheMeta));
  }
  return { ts, X, computed: newTs.length };
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

/** Everything the rows read: each trained asset's hourly / daily / 15-minute series, the basket (every stored coin's
 *  hourly bars, in name order), BTCDOM and the daily index charts, and the market context built from them. `light`:
 *  the trained assets' daily and 15-minute series are left out (the row workers load one asset's at a time). */
export interface TaNetInputs {
  loaded: Array<{ asset: string; s1: ReturnType<typeof loadSeries>; s24?: ReturnType<typeof loadSeries>; s15?: ReturnType<typeof loadSeries> }>;
  basket: Record<string, Candle[]>; btcdom: Candle[]; daily: Record<string, Candle[]>; ctx: TaNetContext;
}
export function loadTaNetInputs(histDir: string, assets: string[], light = false): TaNetInputs {
  const loaded = assets.map((asset) => ({ asset, s1: loadSeries(histDir, asset, '1h'), ...(light ? {} : { s24: loadSeries(histDir, asset, '1d'), s15: loadSeries(histDir, asset, '15m') }) }));
  // The market basket is every coin in the store with hourly history (live: every tracked coin), also
  // when only some of them are trained here and when one is too short to train on.
  const h1 = new Map<string, Candle[]>(loaded.filter((x) => x.s1.candles.length).map((x) => [x.asset, x.s1.candles]));
  for (const a of storedAssets(histDir)) if (!h1.has(a)) { const c = loadSeries(histDir, a, '1h').candles; if (c.length) h1.set(a, c); }
  const basket: Record<string, Candle[]> = Object.fromEntries([...h1.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const btcdom = loadIndexSeries(histDir, 'BTCDOM', '1h').candles;
  const daily: Record<string, Candle[]> = { 'BTC.D': loadIndexSeries(histDir, 'BTC.D', '1d').candles, 'USDT.D': loadIndexSeries(histDir, 'USDT.D', '1d').candles };
  for (const { asset } of SLOW_INDEXES) daily[asset] = loadIndexSeries(histDir, asset, '1d').candles;
  const ctx = new TaNetContext({
    h1: basket, btcdom1h: btcdom, btcd1d: daily['BTC.D'], usdtd1d: daily['USDT.D'],
    slow1d: Object.fromEntries(SLOW_INDEXES.map(({ asset }) => [asset, daily[asset]])),
  });
  return { loaded, basket, btcdom, daily, ctx };
}

const trainable = (h1: Candle[], d1: Candle[]) => h1.length >= TANET_H1_BARS + 200 && d1.length >= TANET_D1_BARS + TANET_MACRO_DAYS;

/** Hourly rows of `asset` its cache does not hold yet (cheap: the cache's month signatures, no feature math). */
export function rowsToCompute(asset: string, h1: Candle[], d1: Candle[], cacheDir: string, inputs: RowInputs): number {
  const total = Math.max(0, h1.length - TANET_H1_BARS + 1);
  try {
    const m = JSON.parse(fs.readFileSync(path.join(cacheDir, `${asset}.json`), 'utf8')) as RowCacheMeta;
    if (m.schema !== TANET_SCHEMA || m.d !== TANET_FEATURES.length || !fs.existsSync(path.join(cacheDir, `${asset}.f32`))) return total;
    const keep = m.v === 2 && m.months && m.tail ? keepRowsBefore({ months: m.months, tail: m.tail }, rowCheckpoints(h1, d1, inputs, m.through), m.through) : m.sig === legacySig(h1, d1, inputs, m.through) ? Infinity : -Infinity;
    const from = Math.min(keep, m.through + 1);
    return h1.filter((c) => c.ts >= from).length;
  } catch { return total; }
}

/** Rows to (re)compute are spread over worker threads, one asset each (research/taNetRowsWorker.ts): years of hourly
 *  rows for many coins take hours on one core. Workers write the row caches; buildData then reads them. Assets with
 *  only a few new hours are left to buildData. At most as many workers as memory allows (each holds the basket). */
export async function computeRowsInWorkers(histDir: string, assets: string[], cacheDir: string, inp: TaNetInputs, log: (m: string) => void, workers: number, o: { minRows?: number; freeGb?: number } = {}): Promise<number> {
  const minRows = o.minRows ?? 2000;
  const jobs: Array<{ asset: string; rows: number }> = [];
  for (const { asset, s1, s24, s15 } of inp.loaded) {
    const h1 = s1.candles, d1 = s24?.candles ?? loadSeries(histDir, asset, '1d').candles;
    if (!trainable(h1, d1)) continue;
    const rows = rowsToCompute(asset, h1, d1, cacheDir, { m15: s15?.candles ?? loadSeries(histDir, asset, '15m').candles, basket: inp.basket, btcdom: inp.btcdom, daily: inp.daily });
    if (rows >= minRows) jobs.push({ asset, rows });
  }
  if (!jobs.length) return 0;
  const freeGb = o.freeGb ?? os.freemem() / 2 ** 30;
  const n = Math.max(1, Math.min(workers, jobs.length, Math.floor((freeGb - 1.5) / 0.75)));
  const why = oneThreadReason(jobs.length, workers, freeGb, n);
  if (why) {
    const total = jobs.reduce((s, j) => s + j.rows, 0);
    log(`computing ${total} hourly rows for ${jobs.map((j) => j.asset).join(', ')} on one thread: ${why} (about ${Math.max(1, Math.round(total / 3500))} min)`);
    return 0;
  }
  jobs.sort((a, b) => b.rows - a.rows);
  const total = jobs.reduce((s, j) => s + j.rows, 0);
  log(`computing ${total} hourly rows for ${jobs.length} coins on ${n} threads (${freeGb.toFixed(1)} GB free memory): ${jobs.map((j) => j.asset).join(', ')}`);
  const pool = new WorkerPool<TaNetRowsJob, TaNetRowsOut>(workerScript('taNetRowsWorker'), n);
  const t0 = Date.now();
  let done = 0, rowsDone = 0;
  progress('TA network rows', 0, total);
  // A coin takes minutes to tens of minutes: a line every 5 minutes so the log shows it working.
  const beat = setInterval(() => log(`rows: ${done}/${jobs.length} coins ready, ${((Date.now() - t0) / 60_000).toFixed(0)} min so far (${n} threads working)`), 5 * 60_000);
  beat.unref?.();
  try {
    await Promise.all(jobs.map(async (j) => {
      try {
        const r = await pool.run({ histDir, assets, asset: j.asset, cacheDir });
        for (const l of r.logs) log(l);
        rowsDone += j.rows;
        progress('TA network rows', rowsDone, total);
      } catch (e) { log(`${j.asset}: the row worker failed (${(e as Error).message.split('\n')[0]}); computed here instead`); }
      done++;
      const mins = (Date.now() - t0) / 60_000;
      log(`rows: ${done}/${jobs.length} coins ready after ${mins.toFixed(0)} min${done < jobs.length && rowsDone ? `, about ${Math.max(1, Math.round(mins * (total - rowsDone) / rowsDone))} min left` : ''}`);
    }));
  } finally { clearInterval(beat); await pool.close(); }
  return jobs.length;
}

/** Why a rebuild runs on one thread ('' when it runs on several). Each extra thread holds the whole basket (about
 *  0.75 GB), with 1.5 GB kept free for the rest of the computer. */
export function oneThreadReason(coins: number, workers: number, freeGb: number, n: number): string {
  if (coins < 2) return 'only one coin needs them, and one coin cannot be split over threads';
  if (workers < 2) return 'TRAIN_WORKERS is 1 (set it to the number of CPU threads to use more)';
  if (n < 2) return `only ${freeGb.toFixed(1)} GB of memory is free, and each extra thread needs about 0.75 GB on top of 1.5 GB kept free; closing other programs frees memory for the next rebuild`;
  return '';
}

export interface TaNetRowsJob { histDir: string; assets: string[]; asset: string; cacheDir: string }
export interface TaNetRowsOut { computed: number; logs: string[] }

/** One asset's rows in a worker: the same inputs buildData gives assetRows, the cache written for buildData. */
export function rowsJob(j: TaNetRowsJob, inp: TaNetInputs): TaNetRowsOut {
  const logs: string[] = [];
  const h1 = inp.basket[j.asset] ?? [], d1 = loadSeries(j.histDir, j.asset, '1d').candles;
  if (!trainable(h1, d1)) return { computed: 0, logs };
  const r = assetRows(j.asset, h1, d1, j.cacheDir, (m) => logs.push(m), inp.ctx, { m15: loadSeries(j.histDir, j.asset, '15m').candles, basket: inp.basket, btcdom: inp.btcdom, daily: inp.daily });
  return { computed: r.computed, logs };
}

/** buildData with the row (re)computation spread over `workers` threads first. */
export async function buildDataParallel(histDir: string, assets: string[], cacheDir: string | undefined, log: (m: string) => void, workers: number, o: { minRows?: number; freeGb?: number } = {}): Promise<TaNetData> {
  const inp = loadTaNetInputs(histDir, assets);
  if (cacheDir) await computeRowsInWorkers(histDir, assets, cacheDir, inp, log, workers, o);
  return buildData(histDir, assets, cacheDir, log, inp);
}

export function buildData(histDir: string, assets: string[], cacheDir: string | undefined, log: (m: string) => void, inp: TaNetInputs = loadTaNetInputs(histDir, assets)): TaNetData {
  const out: AssetData[] = [];
  const sources: Record<string, string[]> = {};
  const S: Array<[number, number, number, number, number, number, number, number]> = [];
  let micro = 0;
  const { basket, btcdom, daily, ctx } = inp;
  const loaded = inp.loaded.map((x) => ({ asset: x.asset, s1: x.s1, s24: x.s24 ?? loadSeries(histDir, x.asset, '1d'), s15: x.s15 ?? loadSeries(histDir, x.asset, '15m') }));
  const cov = ctx.coverage();
  log(`market context: basket ${ctx.basket.join(', ') || 'none'}; ${Object.entries(cov).map(([k, v]) => `${k} ${v.from}..${v.to}`).join(', ') || 'no index series (BTCDOM: history.sh binance; BTC.D / USDT.D: history.sh tradingview)'}`);
  for (const { asset, s1, s24, s15 } of loaded) {
    const h1 = s1.candles, d1 = s24.candles;
    if (!trainable(h1, d1)) { log(`${asset}: only ${h1.length} hourly / ${d1.length} daily bars, skipped`); continue; }
    sources[asset] = [...new Set([...s1.segments, ...s24.segments, ...s15.segments].map((s) => s.source))];
    const { ts, X } = assetRows(asset, h1, d1, cacheDir, log, ctx, { m15: s15.candles, basket, btcdom, daily });
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

// ---- Training pack for the PyTorch engine (python/tanet) -------------------------------------------
// The torch trainer rebuilds every sample's branch inputs on the GPU from compact tables instead of a second
// copy of the data: per hourly row its trend readings (TREND_IDX) and hourly context readings (CTX_IDX); per
// daily bar its day vector and its dominance-chart TA; per sample the row and day it reads (global indexes into
// those tables), its 15-minute and swing windows (computed here by the same functions as live), and its targets.
// rawInputs(D, i) == the pack's sample i (tests/taNetTorch.test.ts).

export interface TaNetPack { dir: string; n: number; rows: number; days: number; sig: string }

const PACK_FILES = ['rows_trend.f32', 'rows_ctx.f32', 'days_vec.f32', 'days_dom.f32', 's_gr.i32', 's_gd.i32', 's_micro.f32', 's_swing.f32', 's_y.f32'] as const;

/** Write (or reuse, when the data has not changed) the training pack for D. */
export function writeTaNetPack(D: TaNetData, dir: string, log: (m: string) => void = () => undefined): TaNetPack {
  const F = TANET_FEATURES.length;
  const sigH = crypto.createHash('sha1');
  sigH.update(`${TANET_SCHEMA}|${D.ts.length}|${D.ts[0]}|${D.ts[D.ts.length - 1]}|`);
  for (const A of D.assets) {
    sigH.update(`${A.asset}:${A.rowTs.length}:${A.rowTs[A.rowTs.length - 1] ?? 0}:${A.d1.length}:${A.m15?.length ?? 0}:${A.m15?.[A.m15.length - 1]?.c ?? ''}|`);
    // A strided sample of the rows (a revised bar changes the readings around it) and every target.
    const smp = new Float32Array(Math.ceil(A.X.length / 101));
    for (let k = 0; k < smp.length; k++) smp[k] = A.X[k * 101];
    sigH.update(Buffer.from(smp.buffer));
  }
  for (const a of [D.y1, D.y4, D.yv, D.sr]) sigH.update(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  const sig = sigH.digest('hex');
  const metaFile = path.join(dir, 'meta.json');
  try {
    const m = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as TaNetPack & { files: string[] };
    if (m.sig === sig && PACK_FILES.every((f) => fs.existsSync(path.join(dir, f)))) return { dir, n: m.n, rows: m.rows, days: m.days, sig };
  } catch { /* none yet */ }
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(metaFile, { force: true });
  const t0 = Date.now();
  const rowOff: number[] = [], dayOff: number[] = [];
  let R = 0, Dn = 0;
  for (const A of D.assets) { rowOff.push(R); dayOff.push(Dn); R += A.X.length / F; Dn += A.d1.length; }
  const tF = TREND_IDX.length, cI = CTX_IDX.length, dF = TANET_DAY_FEATURES.length, nDom = NO_DOM.length;
  // Written in chunks (years of hourly samples over many coins are gigabytes; host memory stays small).
  const fds = new Map<string, number>();
  const put = (name: string, a: Float32Array | Int32Array) => {
    let fd = fds.get(name);
    if (fd === undefined) { fd = fs.openSync(path.join(dir, name), 'w'); fds.set(name, fd); }
    fs.writeSync(fd, Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  };
  try {
    for (const f of PACK_FILES) put(f, new Float32Array(0));
    // Row tables.
    D.assets.forEach((A) => {
      const rows = A.X.length / F;
      const rt = new Float32Array(rows * tF), rc = new Float32Array(rows * cI);
      for (let r = 0; r < rows; r++) {
        const x = r * F;
        for (let j = 0; j < tF; j++) rt[r * tF + j] = A.X[x + TREND_IDX[j]];
        for (let j = 0; j < cI; j++) rc[r * cI + j] = A.X[x + CTX_IDX[j]];
      }
      put('rows_trend.f32', rt); put('rows_ctx.f32', rc);
    });
    // Day tables (a day without a vector / dominance reading: NaN, as rawInputs would read it).
    D.assets.forEach((A) => {
      const dv = new Float32Array(A.d1.length * dF).fill(NaN), dd = new Float32Array(A.d1.length * nDom).fill(NaN);
      A.d1.forEach((c, k) => {
        const v = A.dayVec.get(c.ts), m = A.dayDom.get(c.ts);
        if (v) for (let j = 0; j < dF; j++) dv[k * dF + j] = v[j];
        if (m) for (let j = 0; j < nDom; j++) dd[k * nDom + j] = m[j];
      });
      put('days_vec.f32', dv); put('days_dom.f32', dd);
    });
    // Samples.
    const n = D.ts.length, CH = 20_000, MI = TANET_MICRO_STEPS * TANET_MICRO_F, SW = TANET_SWING_BARS * TANET_SWING_F;
    for (let c0 = 0; c0 < n; c0 += CH) {
      const c1 = Math.min(n, c0 + CH), k = c1 - c0;
      const gr = new Int32Array(k), gd = new Int32Array(k), mi = new Float32Array(k * MI), sw = new Float32Array(k * SW), y = new Float32Array(k * 3);
      for (let i = c0; i < c1; i++) {
        const a = D.sa[i], A = D.assets[a], r = D.sr[i], t = D.ts[i], q = i - c0;
        const dj = closedIndex(A.d1, DAY, t + H);
        if (r < TANET_TREND_STEPS - 1 || dj < TANET_MACRO_DAYS - 1) throw new Error(`sample ${i} lacks a full trend / macro window`);
        gr[q] = rowOff[a] + r; gd[q] = dayOff[a] + dj;
        mi.set(taNetMicro(A.m15, t + H), q * MI);
        sw.set(taNetSwing(A.h1, A.h1Idx.get(t)!), q * SW);
        y[q * 3] = D.y1[i]; y[q * 3 + 1] = D.y4[i]; y[q * 3 + 2] = D.yv[i];
      }
      put('s_gr.i32', gr); put('s_gd.i32', gd); put('s_micro.f32', mi); put('s_swing.f32', sw); put('s_y.f32', y);
    }
  } finally { for (const fd of fds.values()) fs.closeSync(fd); }
  const n = D.ts.length;
  const meta = { dir, n, rows: R, days: Dn, sig, files: [...PACK_FILES], tF, cI, dF, nDom, tT: TANET_TREND_STEPS, dT: TANET_MACRO_DAYS, mT: TANET_MICRO_STEPS, mF: TANET_MICRO_F, sT: TANET_SWING_BARS, sF: TANET_SWING_F };
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  log(`torch training pack: ${n} samples, ${R} rows, ${Dn} days (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  return { dir, n, rows: R, days: Dn, sig };
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
  log: PbtRoundLog[]; members: Array<{ id: number; hyper: Hyper; w: string; m: string; v: string; step: number; lineage: number[]; record: Array<[number, number, number, string]>; scores: Array<{ round: number; fitness: number }>; blocks?: number[]; bornRound?: number; island?: number; parents?: [number, number] }>;
  /** The genetic layer's state (islands breeding: research/genetic.ts). */
  ga?: GaState;
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
  /** TA readings the oracle cull switched off (research/oracleCull.ts): read as absent; the population keeps the raw statistics. */
  cull?: string[];
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
  /** Asked before each round: true ends this call there (the training session's time is up: research/sessionClock.ts). */
  stop?: () => boolean;
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
  /** Networks in the tournament (default 3; all start from the same weights). */
  population?: number;
  /** Real regime transitions (research/transitions.ts): each round's fitness pays for drawdown and turnover in
   *  the 24 hours after them (research/selection.ts). None = no penalty. */
  transitions?: Transition[];
  /** Promotion gate: the tournament's PBO must be below this (default 0.2). */
  pboMax?: number;
  /** Breeding every few rounds (research/genetic.ts; populations of 6+). An offspring starts from the fitter
   *  parent's weights with knobs crossed from both. */
  genetic?: GeneticOpts;
  /** Training engine: 'ts' (default), 'torch' (python/tanet: PyTorch on the GPU when there is one; research/taNetTorch.ts)
   *  or 'auto' (torch when a Python with PyTorch starts, else TypeScript; a failure mid-run continues in TypeScript).
   *  Only the flat network trains in torch. Weights move unchanged between the two, so a saved tournament continues. */
  engine?: TaNetEngine;
  /** Python interpreter for the torch engine (default TA_NET_PYTHON, else python3 / python). */
  python?: string;
  /** The torch engine's training pack (default: a temporary directory). */
  packDir?: string;
  /** Torch device (default auto: CUDA when available). */
  device?: 'auto' | 'cpu' | 'cuda';
  log?: (m: string) => void;
}

/** Holdout score of a network: mean over the heads of (model loss / naive loss); lower is better, 1 = naive. */
export interface ChampionScores { candidate: number; incumbent: number | null; incumbentVersion: string | null; why?: string; rows: number }

export interface TaNetReport {
  params: TaNetParams; rounds: number; newRounds: number; /** The tournament has reached the holdout (no rounds left to run). */ complete: boolean; remaining: number; champion?: ChampionScores;
  /** Genetic layer: generations bred, the last one, generations since an offspring won its island. */
  ga?: { generation: number; sinceOffspringWon: number; last?: GaGeneration };
}

const lastLine = (e: unknown) => String((e as Error)?.message ?? e).trim().split('\n').filter(Boolean).pop() ?? String(e);

/** A run's training engine: TypeScript, or the PyTorch trainer (research/taNetTorch.ts) with TypeScript as the
 *  fallback. Training epochs and forecasts go through it; everything else (the tournament, fitness, the holdout,
 *  the pattern report) stays in TypeScript. */
export class TaNetTrainEngine {
  private torch?: TaNetTorch;
  /** Since the last `took()`: samples trained in torch and the seconds that took. */
  private samples = 0;
  private secs = 0;
  private graph = false;
  private tried = false;
  constructor(private readonly D: TaNetData, private readonly dims: BranchDims, private readonly o: Pick<TaNetTrainOpts, 'engine' | 'python' | 'packDir' | 'device'>, private readonly log: (m: string) => void) {}

  get name(): 'ts' | 'torch' { return this.torch ? 'torch' : 'ts'; }

  async start(norm: TaNetParams['norm']): Promise<void> {
    const want = this.o.engine ?? 'ts';
    if (want === 'ts' || this.tried) return;
    this.tried = true;
    if (this.dims.fam) { this.log('training engine: TypeScript (the grouped network trains in TypeScript only)'); return; }
    let t: TaNetTorch | undefined;
    try {
      const pack = writeTaNetPack(this.D, this.o.packDir ?? path.join(os.tmpdir(), `tanet-pack-${process.pid}`), this.log);
      t = TaNetTorch.start({ python: this.o.python, log: this.log });
      await t.init({ dims: this.dims, norm, pack: pack.dir, device: this.o.device ?? 'auto', graphs: process.env.TA_NET_CUDA_GRAPHS !== 'false' });
      this.torch = t;
      this.log(`training engine: PyTorch ${t.info.torch} on ${t.info.device === 'cuda' ? `the GPU (${t.info.name})` : 'the CPU'}`);
    } catch (e) {
      await t?.close();
      if (want === 'torch') throw e;
      this.log(`training engine: TypeScript (PyTorch unavailable: ${lastLine(e)})`);
    }
  }

  private async fallback(e: unknown): Promise<void> {
    if ((this.o.engine ?? 'ts') === 'torch') throw e;
    this.log(`PyTorch trainer failed (${lastLine(e)}); continuing in TypeScript`);
    const t = this.torch;
    this.torch = undefined;
    await t?.close();
  }

  /** `epochs` epochs over `idx` (seeds seed, seed + 1, ... in TypeScript; one stream from `seed` in torch). */
  async train(norm: TaNetParams['norm'], st: Member, h: Hyper, idx: number[], seed: number, epochs: number): Promise<void> {
    if (this.torch && idx.length) {
      try {
        const r = await this.torch.train(st, h as Record<string, number>, idx, seed, epochs);
        if (!r.w.every(Number.isFinite)) throw new Error('non-finite weights');
        st.w.set(r.w); st.m.set(r.m); st.v.set(r.v); st.step = r.step;
        this.samples += r.samples; this.secs += r.secs; this.graph ||= r.graph;
        return;
      } catch (e) { await this.fallback(e); }
    }
    for (let e = 0; e < epochs; e++) trainEpoch(this.D, this.dims, norm, st, h, idx, seed + e);
  }

  async forecast(norm: TaNetParams['norm'], w: Float64Array, h: Hyper, idx: number[], calib?: TaNetParams['calib']): Promise<Forecasts> {
    if (this.torch && idx.length) {
      try {
        const g = gatesOf(h);
        const raw = await this.torch.forecast(w, [g.micro, g.swing, g.trend, g.macro, g.ctx], idx);
        const up1 = new Float64Array(idx.length), up4 = new Float64Array(idx.length), vol = new Float64Array(idx.length);
        for (let k = 0; k < idx.length; k++) {
          up1[k] = calibrated(1 / (1 + Math.exp(-raw[k * 3])), calib?.up_1h); up4[k] = calibrated(1 / (1 + Math.exp(-raw[k * 3 + 1])), calib?.up_4h);
          vol[k] = Math.max(-3, Math.min(3, raw[k * 3 + 2]));
        }
        for (let k = 0; k < idx.length; k++) if (!Number.isFinite(up1[k] + up4[k] + vol[k])) throw new Error('non-finite forecasts');
        return { idx, up1, up4, vol };
      } catch (e) { await this.fallback(e); }
    }
    return forecast(this.D, this.dims, norm, w, h, idx, undefined, calib);
  }

  /** Torch throughput since the last call ('' when nothing trained in torch). */
  took(): string {
    if (!this.samples) return '';
    const out = `PyTorch trained ${this.samples} samples in ${this.secs.toFixed(0)} s (${Math.round(this.samples / Math.max(1e-6, this.secs))}/s${this.graph ? ', CUDA graph' : ''})`;
    this.samples = 0; this.secs = 0;
    return out;
  }

  async close(): Promise<void> { const t = this.torch; this.torch = undefined; await t?.close(); }
}

export async function trainTaNet(D: TaNetData, o: TaNetTrainOpts = {}): Promise<TaNetReport> {
  const dims = taNetDims(o.arch ?? 'flat', o.famK ?? 4);
  const eng = new TaNetTrainEngine(D, dims, o, o.log ?? (() => {}));
  try { return await runTaNet(D, o, dims, eng); } finally { await eng.close(); }
}

async function runTaNet(D: TaNetData, o: TaNetTrainOpts, dims: BranchDims, eng: TaNetTrainEngine): Promise<TaNetReport> {
  const log = o.log ?? (() => {});
  const n = D.ts.length;
  if (n < 2000) throw new Error(`need at least 2000 hourly samples with full inputs (have ${n}): add more history`);
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
      else if (saved.members.length !== (o.population ?? 3)) { log(`saved population has ${saved.members.length} networks, ${o.population ?? 3} wanted; starting a fresh tournament`); saved = undefined; }
    } catch { saved = undefined; }
  }
  const normRaw = saved?.norm ?? fitNorms(D, between(allRounds[0].trainFrom, allRounds[0].trainTo));
  // The oracle cull on top (the saved population keeps the raw statistics, so a reading a later cull keeps comes back).
  const cull = (o.cull ?? []).filter((k) => TANET_FEATURES.includes(k));
  const norm = cullNorm(normRaw, cull);
  if (cull.length) log(`oracle cull: ${cull.length} TA reading(s) switched off`);
  let rounds = saved ? allRounds.filter((r) => r.evalFrom >= saved!.lastEvalTo - 1) : allRounds;
  rounds = rounds.map((r, k) => ({ ...r, index: (saved?.nextIndex ?? 0) + k }));
  const pending = rounds.length;
  if (o.maxRounds !== undefined && o.maxRounds > 0) rounds = rounds.slice(0, o.maxRounds);
  let remaining = pending - rounds.length;
  const resume = saved ? {
    trials: saved.trials, log: saved.log,
    members: saved.members.map((m): PbtMember<Member> => ({ id: m.id, hyper: m.hyper, state: { w: unb64(m.w), m: unb64(m.m), v: unb64(m.v), step: m.step }, lineage: m.lineage, scores: m.scores, ...(m.blocks ? { blocks: m.blocks } : {}), bornRound: m.bornRound, record: m.record.map(([ts, ret, cost, group]) => ({ ts, ret, cost, group })), ...(m.island !== undefined ? { island: m.island } : {}), ...(m.parents ? { parents: m.parents } : {}) })),
    ga: saved.ga,
  } : undefined;
  const population = o.population ?? 3;
  if (rounds.length || !resume) await eng.start(norm);
  log(`${n} samples over ${D.assets.map((a) => a.asset).join(', ')}; 15m input on ${(D.microShare * 100).toFixed(0)}% of them; ${saved ? `continuing a saved population (${saved.log.length} rounds so far)` : `fresh population of ${population}`}; ${rounds.length} round(s) to run; holdout from ${new Date(holdoutFrom).toISOString().slice(0, 10)}`);

  const save = (members: PbtMember<Member>[], trials: number, plog: PbtRoundLog[], lastEvalTo: number, nextIndex: number, ga?: GaState) => {
    if (!o.statePath) return;
    const st: SavedState = {
      schema: TANET_SCHEMA, dims, assets: D.assets.map((a) => a.asset), norm: normRaw, trials, lastEvalTo, nextIndex, contextSig, optimizer: 'adamw', log: plog, ...(ga ? { ga } : {}),
      members: members.map((m) => ({ id: m.id, hyper: m.hyper, w: b64(m.state.w), m: b64(m.state.m), v: b64(m.state.v), step: m.state.step, lineage: m.lineage, scores: m.scores, ...(m.blocks ? { blocks: m.blocks } : {}), bornRound: m.bornRound, record: m.record.map((x) => [x.ts, x.ret, x.cost, x.group ?? ''] as [number, number, number, string]), ...(m.island !== undefined ? { island: m.island } : {}), ...(m.parents ? { parents: m.parents } : {}) })),
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
    population, genetic: o.genetic,
    // A member that finished the round before a stop keeps its training and score when the round resumes.
    ...(o.statePath ? { memberProgress: fileMemberProgress<Member>(`${o.statePath}.round`, {
      encode: (s) => ({ w: b64(s.w), m: b64(s.m), v: b64(s.v), step: s.step }),
      decode: (x) => { const y = x as { w: string; m: string; v: string; step: number }; return { w: unb64(y.w), m: unb64(y.m), v: unb64(y.v), step: y.step }; },
    }) } : {}),
    hooks: {
      // Identical networks: same seed, same weights; only the hyperparameters differ. A later init is an
      // exploration restart and gets fresh weights from a new seed.
      init: () => { const restart = resume !== undefined || inits >= population; inits++; return { w: initBranchParams(dims, restart ? seed + 7919 * inits : seed), m: new Float64Array(size), v: new Float64Array(size), step: 0 }; },
      clone: (s) => ({ w: s.w.slice(), m: s.m.slice(), v: s.v.slice(), step: s.step }),
      train: async (s, h, r: PbtRound) => {
        const idx = between(r.trainFrom, r.trainTo - emb, stride);
        await eng.train(norm, s, h, idx, seed + r.index * 131, epochs + (s.step === 0 ? catchUp : 0));
        return s;
      },
      evaluate: async (s, h, r: PbtRound) => {
        const idx = between(r.evalFrom, r.evalTo);
        const xs = strategyInteractions(D, await eng.forecast(norm, s.w, h, idx), strategyOf(h));
        const report = coverageFloor(fitnessOf(xs, { from: r.evalFrom, to: r.evalTo, clusterMs: H }), xs.length, idx.length);
        // Inertia and whipsaw: drawdown and turnover in the hours after each coin's real regime transitions.
        const tp = o.transitions?.length ? transitionPenalty(xs, o.transitions, { ...DEFAULT_TRANSITION, from: r.evalFrom, to: r.evalTo, assetOf: (x) => x.group }) : undefined;
        return { report: tp ? { ...report, fitness: report.fitness - tp.penalty } : report, interactions: independentInteractions(xs, H), ...(tp ? { extra: { transitionPenalty: tp.penalty, transitions: tp.transitions } } : {}) };
      },
    },
    onRound: ({ members, trials, log: plog, round, ga }) => { const t = eng.took(); if (t) log(`round ${round.index + 1}: ${t}`); save(members, trials, plog, round.evalTo, round.index + 1, ga); },
    stop: o.stop,
  });
  if (!rounds.length && resume) Object.assign(res, { members: resume.members, trials: resume.trials, log: resume.log, elite: resume.members.find((m) => m.id === resume.log[resume.log.length - 1]?.ranking[0]?.member) ?? resume.members[0] });
  // Rounds the session's clock left for the next call.
  remaining = pending - res.ran;
  const elite = res.elite;

  // Bring the elite up to the holdout (one more pass on the block just before it), never past it. The
  // last calibMonths before the holdout are left out of that pass: the direction heads' calibration is
  // fitted there, on hours the network never trained on (raw probabilities are overconfident).
  const calibMonths = o.calibMonths ?? (o.evalMonths ?? 1);
  const calibFrom = Math.floor((holdoutFrom - calibMonths * MONTH) / DAY) * DAY;
  const finalW = elite.state.w.slice();
  const finalSt: Member = { w: finalW, m: elite.state.m.slice(), v: elite.state.v.slice(), step: elite.state.step };
  await eng.start(norm);
  await eng.train(norm, finalSt, elite.hyper, between(calibFrom - trainMs, calibFrom - emb, stride), seed + 99_991, 1);
  let calib: TaNetParams['calib'];
  if (calibMonths > 0) {
    const cr = between(calibFrom, holdoutFrom - emb);
    const raw = await eng.forecast(norm, finalW, elite.hyper, cr);
    calib = { up_1h: fitPlatt(raw.up1, cr.map((i) => D.y1[i])), up_4h: fitPlatt(raw.up4, cr.map((i) => D.y4[i])) };
    for (const [k, c] of Object.entries(calib)) log(`calibration ${k}: a ${c!.a.toFixed(3)}, b ${c!.b.toFixed(3)} on ${c!.rows} rows (log loss ${c!.before.toFixed(5)} -> ${c!.after.toFixed(5)})`);
  }

  // Holdout: strategy fitness and per-head grading against the naive forecast. Then the frozen final
  // window, graded the same way; it decides nothing but whether the heads also hold up there.
  const strat = strategyOf(elite.hyper);
  const ho = between(holdoutFrom, finalFrom);
  const fc = await eng.forecast(norm, finalW, elite.hyper, ho, calib);
  const hoX = strategyInteractions(D, fc, strat);
  const hoFit = fitnessOf(hoX, { from: holdoutFrom, to: finalFrom, clusterMs: H });
  const hoSel = selectiveStats(D, fc, strat);
  const fi = finalFrom < tEnd ? between(finalFrom, tEnd) : [];
  const fcF = fi.length ? await eng.forecast(norm, finalW, elite.hyper, fi, calib) : undefined;
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
    return def.length && (maxOf(def, (x) => x.ts) - minOf(def, (x) => x.ts)) >= 60 * DAY;
  });
  // Probability of backtest overfitting on the member x round fitness matrix: the tournament's selection must carry
  // out of sample (PBO < pboMax), on top of the DSR and regime hurdles.
  const pboR = tournamentPbo(res.log), pboOk = pboGate(pboR, o.pboMax ?? 0.2);
  log(`tournament selection: ${pboOk.why} (${pboR.rounds} rounds x ${pboR.members} networks, ${pboR.splits} splits)`);
  const netOk = Number.isFinite(dsr.probability) && dsr.probability >= dsrThreshold && covered.every((g) => g.enough) && pboOk.ok;
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
    rounds: res.log.length, newRounds: res.ran, complete: remaining === 0, remaining, champion,
    ...(res.ga ? { ga: { generation: res.ga.generation, sinceOffspringWon: res.ga.sinceOffspringWon, last: res.ga.history[res.ga.history.length - 1] } } : {}),
    params: {
      version: `tanet5-${new Date().toISOString().slice(0, 10)}-${D.assets.length}a-r${res.log.length}`,
      schema: TANET_SCHEMA, dims, gates: gatesOf(elite.hyper), weights: Array.from(finalW), norm, ...(cull.length ? { cull } : {}), patterns, context: D.context,
      trendFeatures: [...TANET_TREND_FEATURES], dayFeatures: [...TANET_DAY_FEATURES], strategy: strat, heads, taEngine: taEngine(), ...(calib ? { calib } : {}),
      arch: o.arch ?? 'flat', ...(dims.fam ? { familyNames: (() => { const f = taNetFamilies(); return [...f.trendNames.map((n) => `trend:${n}`), ...f.ctxNames.map((n) => `ctx:${n}`)]; })() } : {}),
      network: {
        dsr: { sharpe: dsr.sharpe, sr0: dsr.sr0, probability: dsr.probability, n: dsr.n }, trials: res.trials, regimes,
        holdout: { fitness: hoFit.fitness, sortino: hoFit.sortino, maxDrawdown: hoFit.maxDrawdown, costs: hoFit.costs, netReturn: hoFit.netReturn, independent: hoFit.independent, days: hoFit.days, selective: hoSel },
        final: finalNet,
        minIndependentPerRegime: minPerRegime, dsrThreshold, validated: netOk, pbo: { pbo: pboR.pbo, rounds: pboR.rounds, members: pboR.members, ok: pboOk.ok, why: pboOk.why },
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
  const cache = argOf('cache', path.join(hist, '.tanet-cache'));
  const D = await buildDataParallel(hist, assets, cache, log, taRowWorkerCount());
  const num = (k: string, d: string) => Number(argOf(k, d));
  // Real regime transitions over the history the tournament evaluates (each round's transition penalty).
  const transitions = argOf('transitions', 'true') === 'false' ? [] : regimeTransitions(hist, D.assets.map((a) => a.asset), D.ts[0], D.ts[D.ts.length - 1] + H, log);
  const rep = await trainTaNet(D, {
    transitions,
    trainMonths: num('train-months', '12'), evalMonths: num('eval-months', '1'), stepMonths: num('step-months', '1'), holdoutMonths: num('holdout-months', '3'), finalMonths: num('final-months', '2'),
    arch: argOf('arch', 'flat') === 'grouped' ? 'grouped' : 'flat', famK: num('fam-k', '4'),
    stride: num('stride', '2'), epochsPerRound: num('epochs', '1'), minPerRegime: num('min-per-regime', '100'), dsrThreshold: num('dsr', '0.95'),
    statePath: argOf('state', path.join(hist, '.tanet-population.json')), fresh: argOf('fresh', '') === 'true' || process.argv.includes('--fresh'),
    maxRounds: num('max-rounds', '0') || undefined, stop: sessionTimeUp, restartEvery: num('restart-every', '0'), catchUpEpochs: num('catch-up-epochs', '3'), patterns: argOf('patterns', 'true') !== 'false', log,
    calibMonths: argOf('calib-months', '') === '' ? undefined : num('calib-months', '1'),
    population: num('population', '3'),
    engine: (['ts', 'torch', 'auto'] as const).find((e) => e === argOf('engine', process.env.TA_NET_ENGINE ?? 'ts')) ?? 'ts',
    python: argOf('python', '') || undefined, packDir: path.join(cache, 'torch-pack'),
    genetic: { parents: num('parents', '3'), islands: num('islands', '1'), breedEvery: num('breed-every', '4'), mutation: num('mutation', '0.03') },
    cull: (() => { const f = argOf('cull', ''); return f ? readCull(f) : []; })(),
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

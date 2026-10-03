// Trains and validates the setup scorer (bot/setups/setupModel.ts) and backtests the two lanes.
//
//   npm run research:setups -- --history data/history --out params/setup_model.json
//
// 1. Events: every fast-lane (15m, 1h) and slow-lane (daily) setup in the history of every asset
//    (bot/setups/detectors.ts), each traded on its own with the real exit rules on 15-minute bars
//    (bot/setups/exits.ts) and costs, giving its net result in R. Features at the signal's close
//    (bot/setups/features.ts; cached per asset).
// 2. Walk-forward scores: half-year folds from 2020; each fold's model sees only trades that had
//    CLOSED before the fold started (no overlap), early-stops on its last 15%, and scores the fold.
// 3. Lane backtest on those out-of-sample scores: one event loop over all assets' 15-minute bars with
//    the live lane book (queues, re-checks, one position per asset, caps), fixed equity for sizing.
//    minScore per lane is chosen on the development years only (a short grid, counted as trials).
// 4. Validation per lane: the holdout months (never used for choices) need a positive mean net R with
//    its bootstrap 5% lower bound above zero, and the frozen final window must be net positive. The
//    deployed model is refit on every event with the same settings.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { loadSeries, storedAssets } from './history/candles';
import { trainGbdt } from './gbdt';
import { gbdtLogit, type GbdtModel } from '../bot/model/trees';
import type { Candle } from '../bot/ta/indicators';
import type { Timeframe } from '../bot/ta/knowledge';
import { detectAt, FAST_TFS, SLOW_TFS, setupSeries, TF_MS, type Lane, type SetupSeries, type SetupSignal } from '../bot/setups/detectors';
import { DEFAULT_COSTS, openTrade, stepTrade, tradeResult, type CostModel, type OpenTrade } from '../bot/setups/exits';
import { SETUP_FEATURES, setupFeatureMap, setupVector, type SetupBars } from '../bot/setups/features';
import { DEFAULT_LANES, LaneBook, type LaneBookParams } from '../bot/setups/lanes';
import { SETUP_SCHEMA, type LanePeriodStats, type LaneValidation, type SetupModelParams } from '../bot/setups/setupModel';

const M15 = 900_000;
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export interface SetupEvent { asset: string; sig: SetupSignal; at: number; exitAt: number; r: number; ret: number; x: Float32Array }

interface AssetBars { asset: string; m15: Candle[]; h1: Candle[]; d1: Candle[]; m15Idx: Map<number, number>; series: Partial<Record<Timeframe, SetupSeries>>; tfIdx: Partial<Record<Timeframe, Map<number, number>>> }

export function loadAssetBars(hist: string, asset: string): AssetBars | undefined {
  const m15 = loadSeries(hist, asset, '15m').candles, h1 = loadSeries(hist, asset, '1h').candles, d1 = loadSeries(hist, asset, '1d').candles;
  if (m15.length < 5000 || h1.length < 2000 || d1.length < 300) return undefined;
  const bars: Record<string, Candle[]> = { '15m': m15, '1h': h1, '1d': d1 };
  const series: AssetBars['series'] = {}, tfIdx: AssetBars['tfIdx'] = {};
  for (const tf of [...FAST_TFS, ...SLOW_TFS]) { series[tf] = setupSeries(bars[tf], tf); tfIdx[tf] = new Map(bars[tf].map((c, i) => [c.ts, i])); }
  return { asset, m15, h1, d1, m15Idx: new Map(m15.map((c, i) => [c.ts, i])), series, tfIdx };
}

/** First 15-minute bar index at or after t. */
function m15At(A: AssetBars, t: number): number {
  let lo = 0, hi = A.m15.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (A.m15[m].ts < t) lo = m + 1; else hi = m; }
  return lo;
}

/** Advance a trade through the 15-minute bar at index k (trail / time updates at its timeframe's closes). */
export function stepOn15m(A: AssetBars, t: OpenTrade, k: number, costs: CostModel): boolean {
  const b = A.m15[k];
  const tfMs = TF_MS[t.tf]!;
  let tfClose: { close: number; atr: number } | undefined;
  if ((b.ts + M15) % tfMs === 0) {
    const j = A.tfIdx[t.tf]!.get(b.ts + M15 - tfMs);
    const s = A.series[t.tf]!;
    if (j !== undefined) tfClose = { close: s.cs[j].c, atr: s.atr[j] };
  }
  return stepTrade(t, b, M15, costs, tfClose);
}

/** Trade one setup on its own from the first 15m bar after it is known; undefined if it never fills or never ends in the data. */
export function simulateSetup(A: AssetBars, sig: SetupSignal, costs: CostModel): OpenTrade | undefined {
  const at = sig.ts + TF_MS[sig.tf]!;
  let k = m15At(A, at);
  if (k >= A.m15.length || A.m15[k].ts - at > 2 * TF_MS[sig.tf]!) return undefined;
  const t = openTrade(sig, A.m15[k].o, A.m15[k].ts, costs);
  if (!t) return undefined;
  const limit = at + (sig.plan.maxBars + 2) * TF_MS[sig.tf]!;
  for (; k < A.m15.length && A.m15[k].ts < limit; k++) if (stepOn15m(A, t, k, costs)) return t;
  return undefined;
}

function cacheKey(): string {
  return crypto.createHash('sha1').update(`${SETUP_SCHEMA}|${SETUP_FEATURES.join(',')}`).digest('hex').slice(0, 12);
}

/** Every setup of an asset with its standalone outcome and features (features cached on disk). */
export function assetEvents(A: AssetBars, btc: SetupBars | undefined, costs: CostModel, cacheDir: string | undefined, log: (m: string) => void): SetupEvent[] {
  const sigs: SetupSignal[] = [];
  for (const tf of [...FAST_TFS, ...SLOW_TFS]) {
    const s = A.series[tf]!;
    for (let i = 60; i < s.cs.length; i++) { const g = detectAt(A.asset, tf, s, i); if (g) sigs.push(g); }
  }
  const key = (g: SetupSignal) => `${g.tf}|${g.ts}|${g.kind}|${g.dir}`;
  const F = SETUP_FEATURES.length;
  const cached = new Map<string, Float32Array>();
  const file = cacheDir ? path.join(cacheDir, `${A.asset}.${cacheKey()}.json`) : undefined;
  if (file && fs.existsSync(file)) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { keys: string[]; x: string };
      const buf = Buffer.from(j.x, 'base64');
      const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      j.keys.forEach((k, i) => cached.set(k, all.slice(i * F, (i + 1) * F)));
    } catch { /* rebuild */ }
  }
  const bars: SetupBars = { m15: A.m15, h1: A.h1, d1: A.d1 };
  const out: SetupEvent[] = [];
  let fresh = 0;
  const t0 = Date.now();
  for (const g of sigs) {
    const tr = simulateSetup(A, g, costs);
    if (!tr?.closed) continue;
    const k = key(g);
    let x = cached.get(k);
    if (!x) { x = Float32Array.from(setupVector(setupFeatureMap(g, bars, btc))); cached.set(k, x); fresh++; }
    const res = tradeResult(tr);
    out.push({ asset: A.asset, sig: g, at: g.ts + TF_MS[g.tf]!, exitAt: tr.closed.ts, r: res.r, ret: res.ret, x });
  }
  if (fresh) log(`${A.asset}: features for ${fresh} new setups in ${((Date.now() - t0) / 1000).toFixed(0)} s (${out.length} setups)`);
  if (file && fresh) {
    fs.mkdirSync(cacheDir!, { recursive: true });
    const keys = [...cached.keys()];
    const all = new Float32Array(keys.length * F);
    keys.forEach((k, i) => all.set(cached.get(k)!, i * F));
    fs.writeFileSync(file, JSON.stringify({ keys, x: Buffer.from(all.buffer).toString('base64') }));
  }
  return out;
}

// ---- Model ------------------------------------------------------------------------------------------

const GBDT = { loss: 'squared' as const, nTrees: 300, learningRate: 0.05, maxDepth: 3, minLeafWeight: 80, lambda: 10, featureFraction: 0.3, baggingFraction: 0.7, patience: 30 };
const yOf = (e: SetupEvent) => Math.max(-2, Math.min(4, e.r));
const MIN_MODEL_TRADES = 400;
const MAX_TRAIN = 40_000;

export interface LaneFit { model?: GbdtModel; meanR: number; trades: number }

export function fitLane(train: SetupEvent[], seed = 7): LaneFit {
  const meanR = train.length ? train.reduce((a, e) => a + yOf(e), 0) / train.length : 0;
  if (train.length < MIN_MODEL_TRADES) return { meanR, trades: train.length };
  // The most recent MAX_TRAIN trades (memory: features are 785 wide; recent behaviour matters most).
  const sorted = [...train].sort((a, b) => a.at - b.at).slice(-MAX_TRAIN);
  const cut = Math.floor(sorted.length * 0.85);
  const tr = sorted.slice(0, cut), va = sorted.slice(cut);
  const X = tr.map((e) => Array.from(e.x)), Xv = va.map((e) => Array.from(e.x));
  const fit = trainGbdt(X, tr.map(yOf), tr.map(() => 1), tr.map(() => meanR), Xv, va.map(yOf), va.map(() => 1), va.map(() => meanR), { ...GBDT, seed });
  return { model: fit.trees ? fit.model : undefined, meanR, trades: train.length };
}

export const scoreWith = (f: LaneFit, x: ArrayLike<number>) => (f.model ? f.meanR + gbdtLogit({ ...f.model, baseScore: 0 }, Array.from(x)) : f.meanR);

/** Walk-forward out-of-sample scores (NaN before the first fold). */
export function walkForward(events: SetupEvent[], lane: Lane, firstFold: number, foldMs: number, log: (m: string) => void): Float64Array {
  const sc = new Float64Array(events.length).fill(NaN);
  const end = Math.max(...events.map((e) => e.at)) + 1;
  for (let a = firstFold; a < end; a += foldMs) {
    const b = a + foldMs;
    const train = events.filter((e) => e.sig.lane === lane && e.exitAt < a);
    const f = fitLane(train, 7 + Math.floor(a / foldMs));
    let n = 0;
    events.forEach((e, i) => { if (e.sig.lane === lane && e.at >= a && e.at < b) { sc[i] = scoreWith(f, e.x); n++; } });
    log(`  ${lane} fold ${iso(a)}: trained on ${train.length} trades (${f.model ? `${f.model.trees.length} trees` : 'rule-only'}), scored ${n}`);
  }
  return sc;
}

// ---- Lane backtest ----------------------------------------------------------------------------------

export interface ClosedTrade { asset: string; lane: Lane; kind: string; entryTs: number; exitTs: number; r: number; ret: number; usd: number; score: number }

/** One event loop over every asset's 15-minute bars with the lane book (fixed equity for sizing). */
export function backtestLanes(assets: Map<string, AssetBars>, events: SetupEvent[], scores: Float64Array, book: LaneBookParams, costs: CostModel, equity: number, from: number, to: number, lanes: Lane[] = ['fast', 'slow']): ClosedTrade[] {
  const B = new LaneBook(book);
  const out: ClosedTrade[] = [];
  const byAt = new Map<number, number[]>();
  events.forEach((e, i) => { if (e.at >= from && e.at < to && Number.isFinite(scores[i]) && lanes.includes(e.sig.lane)) { const l = byAt.get(e.at) ?? []; l.push(i); byAt.set(e.at, l); } });
  const times = new Set<number>();
  for (const A of assets.values()) for (const c of A.m15) if (c.ts >= from - M15 && c.ts < to) times.add(c.ts);
  const timeline = [...times].sort((a, b) => a - b);
  const scoreOf = new Map<SetupSignal, number>();
  for (const T of timeline) {
    // 1. Manage open positions through this bar.
    for (const [asset, t] of [...B.positions]) {
      const A = assets.get(asset)!, k = A.m15Idx.get(T);
      if (k === undefined) continue;
      if (stepOn15m(A, t, k, costs)) {
        const res = tradeResult(t);
        out.push({ asset, lane: t.lane, kind: `${t.tf} ${t.kind}`, entryTs: t.entryTs, exitTs: t.closed!.ts, r: res.r, ret: res.ret, usd: res.ret * (t.notional ?? 0), score: t.score ?? NaN });
        B.remove(asset);
      }
    }
    // 2. Setups known at this bar's close join their queues.
    const now = T + M15;
    for (const i of byAt.get(now) ?? []) { scoreOf.set(events[i].sig, scores[i]); B.offer(events[i].sig, scores[i], now); }
    // 3. Fill what the book picks at the next bar's open (re-check: the setup must still be tradable there).
    const entries = B.select(now, equity, (c) => {
      const A = assets.get(c.sig.asset)!, k = A.m15Idx.get(now);
      return k === undefined ? undefined : { px: A.m15[k].o, score: scoreOf.get(c.sig) ?? c.score };
    });
    for (const e of entries) {
      const A = assets.get(e.cand.sig.asset)!;
      const t = openTrade(e.cand.sig, e.px, now, costs);
      if (!t) continue;
      t.notional = e.notional; t.score = e.score;
      B.add(t);
      void A;
    }
  }
  return out;
}

function bootMean(xs: number[], iters = 1000, seed = 3): [number, number] {
  if (xs.length < 2) return [NaN, NaN];
  let x = seed >>> 0; const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const ms: number[] = [];
  for (let k = 0; k < iters; k++) { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rnd() * xs.length)]; ms.push(s / xs.length); }
  ms.sort((a, b) => a - b);
  return [ms[Math.floor(0.05 * iters)], ms[Math.floor(0.95 * iters)]];
}

export function periodStats(ts: ClosedTrade[], from: number, to: number): LanePeriodStats {
  const sel = ts.filter((t) => t.entryTs >= from && t.entryTs < to);
  const days = Math.max(1, (to - from) / DAY);
  const n = sel.length;
  const wins = sel.filter((t) => t.ret > 0);
  const gp = wins.reduce((a, t) => a + t.usd, 0), gl = -sel.filter((t) => t.ret <= 0).reduce((a, t) => a + t.usd, 0);
  const daily = new Map<number, number>();
  for (const t of sel) { const d = Math.floor(t.exitTs / DAY); daily.set(d, (daily.get(d) ?? 0) + t.usd); }
  const dv: number[] = [];
  for (let d = Math.floor(from / DAY); d < Math.floor(to / DAY); d++) dv.push(daily.get(d) ?? 0);
  const dm = dv.reduce((a, x) => a + x, 0) / Math.max(1, dv.length), dsd = Math.sqrt(dv.reduce((a, x) => a + (x - dm) ** 2, 0) / Math.max(1, dv.length));
  let eq = 0, pk = 0, dd = 0; for (const x of dv) { eq += x; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const [lo, hi] = bootMean(sel.map((t) => t.r));
  const byKind: LanePeriodStats['byKind'] = {};
  for (const t of sel) { const k = byKind[t.kind] ??= { trades: 0, avgR: 0, winRate: 0 }; k.trades++; k.avgR += t.r; k.winRate += t.ret > 0 ? 1 : 0; }
  for (const k of Object.values(byKind)) { k.avgR /= k.trades; k.winRate /= k.trades; }
  return {
    from: iso(from), to: iso(to), days, trades: n, tradesPerDay: n / days, winRate: n ? wins.length / n : NaN,
    avgR: n ? sel.reduce((a, t) => a + t.r, 0) / n : NaN, avgRet: n ? sel.reduce((a, t) => a + t.ret, 0) / n : NaN,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : NaN, netUsd: sel.reduce((a, t) => a + t.usd, 0), usdPerDay: sel.reduce((a, t) => a + t.usd, 0) / days,
    maxDrawdownUsd: dd, sharpe: dsd > 0 ? (dm / dsd) * Math.sqrt(365) : 0, avgRLo: lo, avgRHi: hi, byKind,
  };
}

// ---- Main -------------------------------------------------------------------------------------------

export interface TrainSetupOpts { assets?: string[]; equityUsd?: number; costs?: CostModel; holdoutMonths?: number; finalMonths?: number; firstFold?: number; foldMonths?: number; cacheDir?: string; log?: (m: string) => void }

export async function trainSetupModel(hist: string, o: TrainSetupOpts = {}): Promise<SetupModelParams> {
  const log = o.log ?? ((m: string) => console.log(`[setups] ${m}`));
  const costs = o.costs ?? DEFAULT_COSTS, equity = o.equityUsd ?? 10_000;
  const names = o.assets ?? storedAssets(hist);
  const assets = new Map<string, AssetBars>();
  for (const a of names) { const A = loadAssetBars(hist, a); if (A) assets.set(a, A); else log(`${a}: not enough 15m / 1h / 1d history, skipped`); }
  if (!assets.size) throw new Error('no asset with 15m, 1h and 1d history');
  const btcA = assets.get('BTC') ?? (names.includes('BTC') ? undefined : loadAssetBars(hist, 'BTC'));
  const btc: SetupBars | undefined = btcA ? { m15: btcA.m15, h1: btcA.h1 } : undefined;
  const events: SetupEvent[] = [];
  for (const A of assets.values()) events.push(...assetEvents(A, btc, costs, o.cacheDir ?? path.join(hist, '.setup-cache'), log));
  events.sort((a, b) => a.at - b.at);
  const end = Math.max(...events.map((e) => e.at)) + 1;
  const month = 30.44 * DAY;
  const finalFrom = end - (o.finalMonths ?? 3) * month, holdoutFrom = finalFrom - (o.holdoutMonths ?? 9) * month;
  const firstFold = o.firstFold ?? Date.UTC(2020, 0, 1), foldMs = (o.foldMonths ?? 6) * month;
  for (const lane of ['fast', 'slow'] as const) {
    const ev = events.filter((e) => e.sig.lane === lane);
    log(`${lane} lane: ${ev.length} setups, standalone mean net R ${(ev.reduce((a, e) => a + e.r, 0) / Math.max(1, ev.length)).toFixed(3)}, win ${(100 * ev.filter((e) => e.ret > 0).length / Math.max(1, ev.length)).toFixed(1)}%`);
  }
  // Walk-forward scores.
  const scores = new Float64Array(events.length).fill(NaN);
  for (const lane of ['fast', 'slow'] as const) {
    const s = walkForward(events, lane, firstFold, foldMs, log);
    s.forEach((v, i) => { if (Number.isFinite(v)) scores[i] = v; });
  }
  // minScore per lane on the development years only.
  const GRID = [-Infinity, 0, 0.05, 0.1, 0.2, 0.3];
  const book: LaneBookParams = JSON.parse(JSON.stringify(DEFAULT_LANES));
  const validation: SetupModelParams['validation'] = {};
  for (const lane of ['fast', 'slow'] as const) {
    let best = { th: -Infinity, usd: -Infinity };
    for (const th of GRID) {
      const b: LaneBookParams = { ...book, [lane]: { ...book[lane], minScore: th } };
      const tr = backtestLanes(assets, events, scores, b, costs, equity, firstFold, holdoutFrom, [lane]);
      const usd = tr.reduce((a, t) => a + t.usd, 0);
      log(`  ${lane} minScore ${th === -Infinity ? 'none' : th}: development ${tr.length} trades, net $${usd.toFixed(0)}`);
      if (usd > best.usd) best = { th, usd };
    }
    const devScores = events.map((e, i) => (e.sig.lane === lane && e.at >= firstFold && e.at < holdoutFrom ? scores[i] : NaN)).filter((v) => Number.isFinite(v) && v >= best.th).sort((a, b) => a - b);
    book[lane].minScore = best.th === -Infinity ? -1e9 : best.th;
    book[lane].refScore = Math.max(0.05, devScores.length ? devScores[Math.floor(devScores.length / 2)] : 0.2);
  }
  // Both lanes together, every period.
  const trades = backtestLanes(assets, events, scores, book, costs, equity, firstFold, end);
  for (const lane of ['fast', 'slow'] as const) {
    const lt = trades.filter((t) => t.lane === lane);
    const periods = { development: periodStats(lt, firstFold, holdoutFrom), holdout: periodStats(lt, holdoutFrom, finalFrom), final: periodStats(lt, finalFrom, end) };
    const reasons: string[] = [];
    const h = periods.holdout, f = periods.final;
    if (h.trades < 30) reasons.push(`holdout: only ${h.trades} trades (need 30)`);
    if (!(h.avgRLo > 0)) reasons.push(`holdout: mean net R ${h.avgR.toFixed(3)}, 5% bound ${h.avgRLo.toFixed(3)} (needs > 0)`);
    if (!(f.netUsd > 0)) reasons.push(`final window: net $${f.netUsd.toFixed(0)} (needs > 0)`);
    validation[lane] = { periods, trials: GRID.length, passed: reasons.length === 0, reasons };
    for (const [k, p] of Object.entries(periods)) {
      log(`${lane} ${k} ${p.from}..${p.to}: ${p.trades} trades (${p.tradesPerDay.toFixed(2)}/day), win ${(100 * p.winRate).toFixed(1)}%, mean net R ${p.avgR.toFixed(3)} [${p.avgRLo.toFixed(3)}, ${p.avgRHi.toFixed(3)}], PF ${p.profitFactor.toFixed(2)}, net $${p.netUsd.toFixed(0)} ($${p.usdPerDay.toFixed(1)}/day on $${equity}), max DD $${p.maxDrawdownUsd.toFixed(0)}, Sharpe ${p.sharpe.toFixed(2)}`);
      for (const [kind, s] of Object.entries(p.byKind)) log(`    ${kind}: ${s.trades} trades, win ${(100 * s.winRate).toFixed(1)}%, mean R ${s.avgR.toFixed(3)}`);
    }
    log(`${lane} lane ${reasons.length ? `NOT validated: ${reasons.join('; ')}` : 'validated'}`);
  }
  // Deployed model: refit on every event.
  const lanes: SetupModelParams['lanes'] = {};
  for (const lane of ['fast', 'slow'] as const) lanes[lane] = fitLane(events.filter((e) => e.sig.lane === lane), 11);
  return {
    version: `setups1-${iso(Date.now())}`, schema: SETUP_SCHEMA, features: SETUP_FEATURES, lanes, book, costs, equityUsd: equity, validation, trainedAt: new Date().toISOString(),
    data: { assets: [...assets.keys()], from: iso(events[0].at), to: iso(end), holdoutFrom: iso(holdoutFrom), finalFrom: iso(finalFrom), events: events.length },
  };
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

export async function trainSetupMain(argOf: (k: string, d: string) => string = cliArg): Promise<SetupModelParams> {
  const hist = argOf('history', 'data/history');
  const out = argOf('out', 'params/setup_model.json');
  const assets = argOf('assets', '');
  const p = await trainSetupModel(hist, { assets: assets ? assets.split(',') : undefined, equityUsd: Number(argOf('equity', '10000')), holdoutMonths: Number(argOf('holdout-months', '9')), finalMonths: Number(argOf('final-months', '3')) });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(p));
  console.log(`[setups] wrote ${out} (fast ${p.validation.fast?.passed ? 'validated' : 'not validated'}, slow ${p.validation.slow?.passed ? 'validated' : 'not validated'})`);
  return p;
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void trainSetupMain();

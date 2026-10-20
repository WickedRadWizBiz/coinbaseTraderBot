// Trains and validates the setup scorer (bot/setups/setupModel.ts) and backtests the two lanes.
//
//   npm run research:setups -- --history data/history --out params/setup_model.json
//
// 1. Events: every fast-lane (15m, 1h) and slow-lane (daily) setup in the history of every asset
//    (bot/setups/detectors.ts), each traded on its own with the real exit rules on 15-minute bars
//    (bot/setups/exits.ts) and costs, giving its net result in R. Features at the signal's close
//    (bot/setups/features.ts; cached per asset). The TA network's inputs come from its walk-forward
//    export (research/taNetOos.ts: forecasts from a network that never saw the hour it forecast).
// 2. Walk-forward scores: half-year folds from 2020; each fold's model sees only trades that had
//    CLOSED before the fold started (no overlap), early-stops on its last 15%, and scores the fold.
// 3. Lane backtest on those out-of-sample scores: one event loop over all assets' 15-minute bars with
//    the live lane book (queues, re-checks, one position per asset, caps), fixed equity for sizing.
//    minScore per lane is chosen on the development years only (a short grid, counted as trials).
//    The TA network's inputs are kept only if the walk-forward with them beats the one without on the
//    development years (t-statistic of net R per trade of both lanes' trades); otherwise blanked.
// 4. Validation per lane: the holdout months (never used for choices) need a positive mean net R with
//    its bootstrap 5% lower bound above zero, and the frozen final window must be net positive. The
//    deployed model is refit on every event with the same settings.

import { optimalF, recencyWeight } from '../bot/strategy/optimalF';
import { maxOf, pushAll } from '../bot/util/num';
import { taEngine } from '../bot/ta/talib';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { loadSeries, storedAssets } from './history/candles';
import { trainGbdt } from './gbdt';
import { gbdtLogit, type GbdtModel } from '../bot/model/trees';
import type { Candle } from '../bot/ta/indicators';
import type { Timeframe } from '../bot/ta/knowledge';
import { adaptToVol, applyRatchet, applyScaleOut, atr4hAt, detectAt, FAST_TFS, RATCHET, SCALE_OUT, SLOW_TFS, SPOT_PB, setupSeries, TF_MS, VOL_ADAPT, type Lane, type SetupSeries, type SetupSignal } from '../bot/setups/detectors';
import { DEFAULT_COSTS, exitTrade, openTrade, stepTrade, tradeResult, type CostModel, type OpenTrade } from '../bot/setups/exits';
import { CL_SCHEMA, CL_SETUP_HORIZONS, CrossLead, crossLeadSetupFeatures, crossLeadSetupReading, crossLeadSum, type CrossLeadParams } from '../bot/ta/crossLead';
import { libDir, LibIndex, loadLibForecasts } from './librarian';
import { spotLeads } from './leadLag';
import { LIB_SCHEMA, libSetupFeatures } from '../bot/ta/librarian';
import { XG_SCHEMA, xgSetupFeatures } from '../bot/ta/crossGraph';
import { loadXgForecasts, xgDir, XgIndex } from './trainCrossGraph';
import { applyMask, characterFeatures, fractalFeatures, maskedIndices, SETUP_BASE_FEATURES, SETUP_FEATURES, SETUP_GROUPS, setupFeatureMap, setupVector, tanetFeatures, type SetupBars } from '../bot/setups/features';
import { loadMacroDaily, MacroSeries, macroSettings } from '../bot/macro/macroSeries';
import { macroConfig } from '../bot/config';
import { characterOf } from '../bot/ta/character';
import { loadOos, oosDir, OosIndex } from './taNetOos';
import { TANET_SCHEMA } from '../bot/ta/taNet';
import { DEFAULT_LANES, kindKey, LaneBook, minScoreFor, type LaneBookParams } from '../bot/setups/lanes';
import { laneScore, quantilesOf, rawPrediction, SETUP_SCHEMA, type LanePeriodStats, type LaneScorer, type SetupModelParams } from '../bot/setups/setupModel';

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
    // A bar of the trade's timeframe closes with this 15m bar (same close). Its ATR, or the last one
    // known when that candle is missing from the data (the clock keeps running through gaps).
    const s = A.series[t.tf]!;
    let j = A.tfIdx[t.tf]!.get(b.ts + M15 - tfMs);
    if (j === undefined) { let lo = 0, hi = s.cs.length - 1; j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (s.cs[m].ts < b.ts + M15 - tfMs) { j = m; lo = m + 1; } else hi = m - 1; } }
    tfClose = { close: b.c, atr: j >= 0 ? s.atr[j] : NaN };
  }
  return stepTrade(t, b, M15, costs, tfClose);
}

/** An exit decided at a 15-minute close outside the trade's plan (the cross-coin lead-lag exit): true closes the trade at
 *  that bar's close. */
export type SetupExitHook = (t: OpenTrade, closeTs: number) => boolean;

/** Trade one setup on its own from the first 15m bar after it is known; undefined if it never fills or never ends in the data. */
export function simulateSetup(A: AssetBars, sig: SetupSignal, costs: CostModel, exit?: SetupExitHook): OpenTrade | undefined {
  const at = sig.ts + TF_MS[sig.tf]!;
  let k = m15At(A, at);
  if (k >= A.m15.length || A.m15[k].ts - at > 2 * TF_MS[sig.tf]!) return undefined;
  const t = openTrade(sig, A.m15[k].o, A.m15[k].ts, costs);
  if (!t) return undefined;
  const limit = at + (sig.plan.maxBars + 2) * TF_MS[sig.tf]!;
  for (; k < A.m15.length && A.m15[k].ts < limit; k++) {
    if (stepOn15m(A, t, k, costs)) return t;
    const close = A.m15[k].ts + M15;
    if (exit?.(t, close)) { exitTrade(t, A.m15[k].c, close, 'leadlag', costs); return t; }
  }
  return undefined;
}

/** The leaders' expected pull on a coin at a 15-minute close (both horizons, in the coin's volatility units; the
 *  walk-forward fit before that time), remembered per close: every trade and every k reads the same closes. */
export function crossLeadPull(cl: CrossLead, asset: string, m15Of: (asset: string) => Candle[] | undefined): (ts: number) => number | undefined {
  const memo = new Map<number, number | undefined>();
  return (ts) => {
    if (memo.has(ts)) return memo.get(ts);
    const e = crossLeadSum(crossLeadSetupReading(cl, asset, ts, m15Of));
    memo.set(ts, e);
    return e;
  };
}

/** The cross-coin lead-lag exit: at a 15-minute close, the leaders' pull against the trade by more than k. */
export function crossLeadExitHook(pull: (ts: number) => number | undefined, k: number): SetupExitHook {
  return (t, ts) => { const e = pull(ts); return e !== undefined && t.dir * e < -k; };
}

/** The plan a setup is traded with (volatility-adapted stop and trail, ratchet, scale-out): what the scorer's events and
 *  the live trader use. */
export function setupPlan(A: AssetBars, g0: SetupSignal, costs: CostModel, oos?: OosIndex): SetupSignal {
  const at = g0.ts + TF_MS[g0.tf]!;
  const reading = oos?.at(A.asset, at);
  return applyScaleOut(applyRatchet(adaptToVol(g0, reading?.vol), atr4hAt(A.h1, at), costs.entry + costs.takerExit, RATCHET, reading?.vol), SCALE_OUT);
}

export const CL_EXIT_KS = [0.5, 1, 1.5, 2];

/** Whether the lead-lag exit pays: every setup with a lead-lag reading at its entry, traded on its own with and without the
 *  exit at each k. Kept (the k with the best gain) only if its net R gain per trade on the development years has a
 *  month-block bootstrap lower bound above 0 (Bonferroni over the ks), and it gains on the holdout too. The final window
 *  is not looked at. */
export function chooseCrossLeadExit(assets: Map<string, AssetBars>, cl: CrossLead, costs: CostModel, o: { devTo: number; holdTo: number; log?: (m: string) => void; ks?: number[]; boots?: number; oos?: OosIndex }): SetupModelParams['crossLeadExit'] {
  const log = o.log ?? (() => {});
  const m15Of = (a: string) => assets.get(a)?.m15;
  const ks = o.ks ?? CL_EXIT_KS;
  const rows: Array<{ at: number; d: number[] }> = [];
  for (const A of assets.values()) {
    if (!cl.any(A.asset)) continue;
    const pull = crossLeadPull(cl, A.asset, m15Of);
    const hooks = ks.map((k) => crossLeadExitHook(pull, k));
    const spotPb = SPOT_PB.assets.includes(A.asset);
    for (const tf of [...FAST_TFS, ...SLOW_TFS]) {
      const s = A.series[tf];
      if (!s) continue;
      for (let i = 60; i < s.cs.length; i++) {
        const g0 = detectAt(A.asset, tf, s, i, A.series['1d'], { spotPb });
        if (!g0) continue;
        const at = g0.ts + TF_MS[g0.tf]!;
        if (at >= o.holdTo || !crossLeadSetupReading(cl, A.asset, at, m15Of)) continue;
        const g = setupPlan(A, g0, costs, o.oos);
        const base = simulateSetup(A, g, costs);
        if (!base?.closed) continue;
        const r0 = tradeResult(base).r;
        const d = hooks.map((h) => { const t = simulateSetup(A, g, costs, h); return t?.closed ? tradeResult(t).r - r0 : 0; });
        rows.push({ at, d });
      }
    }
  }
  return crossLeadExitGate(rows, { ks, devTo: o.devTo, boots: o.boots, log });
}

/** The lead-lag exit's gate on the setups' outcomes (`d[j]`: the net R the exit at ks[j] added to a trade): the k with the
 *  best development-years gain among those whose month-block bootstrap lower bound is above 0 (Bonferroni over the ks),
 *  kept only if it gains on the holdout too; undefined (off) otherwise. */
export function crossLeadExitGate(rows: Array<{ at: number; d: number[] }>, o: { ks: number[]; devTo: number; boots?: number; minDev?: number; log?: (m: string) => void }): SetupModelParams['crossLeadExit'] {
  const log = o.log ?? (() => {});
  const ks = o.ks;
  const dev = rows.filter((x) => x.at < o.devTo), hold = rows.filter((x) => x.at >= o.devTo);
  const minDev = o.minDev ?? 200;
  if (dev.length < minDev) { log(`lead-lag exit: only ${dev.length} development setups with a lead-lag reading (< ${minDev}): off`); return undefined; }
  const month = (t: number) => Math.floor(t / (30.44 * DAY));
  const months = [...new Set(dev.map((x) => month(x.at)))];
  const byMonth = new Map<number, number[]>();
  dev.forEach((x, i) => { const m = month(x.at); (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(i); });
  let s = 1;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const alpha = 0.05 / ks.length, B = o.boots ?? 400;
  let best: { j: number; gain: number; lo: number } | undefined;
  for (let j = 0; j < ks.length; j++) {
    const gain = dev.reduce((a, x) => a + x.d[j], 0) / dev.length;
    const bs: number[] = [];
    for (let b = 0; b < B; b++) {
      let sum = 0, n = 0;
      for (let q = 0; q < months.length; q++) for (const i of byMonth.get(months[Math.floor(r() * months.length)])!) { sum += dev[i].d[j]; n++; }
      bs.push(n ? sum / n : 0);
    }
    bs.sort((a, b) => a - b);
    const lo = bs[Math.max(0, Math.floor(alpha * B))];
    log(`lead-lag exit k=${ks[j]}: ${(gain >= 0 ? '+' : '') + gain.toFixed(4)} R per trade on ${dev.length} development setups (lower bound ${lo.toFixed(4)})`);
    if (lo > 0 && (!best || gain > best.gain)) best = { j, gain, lo };
  }
  if (!best) { log('lead-lag exit: no k raised the development years\' net R with confidence: off'); return undefined; }
  const holdGain = hold.length ? hold.reduce((a, x) => a + x.d[best!.j], 0) / hold.length : NaN;
  if (!(holdGain > 0)) { log(`lead-lag exit k=${ks[best.j]}: ${hold.length ? `${holdGain.toFixed(4)} R per trade on ${hold.length} holdout setups` : 'no holdout setups'}: off`); return undefined; }
  log(`lead-lag exit ON at k=${ks[best.j]}: +${best.gain.toFixed(4)} R per trade on the development years, +${holdGain.toFixed(4)} on the holdout`);
  return { k: ks[best.j], devGainR: best.gain, devLoR: best.lo, holdGainR: holdGain, trades: dev.length + hold.length };
}

function cacheKey(): string {
  return crypto.createHash('sha1').update(`features-1|${taEngine()}|${SETUP_BASE_FEATURES.join(',')}`).digest('hex').slice(0, 12);
}

const HOUR = 3_600_000;
const lastClosed = (cs: Candle[], period: number, t: number) => { let lo = 0, hi = cs.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (cs[m].ts + period <= t) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };
/** Character of a coin at time t from bars closed by then (the same function the live bot uses). */
function characterAtTime(A: AssetBars, others: Candle[][], t: number) {
  const i = lastClosed(A.h1, HOUR, t), j = lastClosed(A.d1, 86_400_000, t);
  if (i < 130 || j < 30) return undefined;
  const os = others.map((h) => { const k = lastClosed(h, HOUR, t); return k >= 0 ? h.slice(Math.max(0, k - 159), k + 1) : []; });
  try { return characterOf(A.h1.slice(i - 159, i + 1), A.d1.slice(Math.max(0, j - 199), j + 1), os); } catch { return undefined; }
}

/** Every setup of an asset with its standalone outcome and features (features cached on disk). */
export function assetEvents(A: AssetBars, btc: SetupBars | undefined, costs: CostModel, cacheDir: string | undefined, log: (m: string) => void, oos?: OosIndex, others: Candle[][] = [], macro?: MacroSeries, lib?: LibIndex, xg?: XgIndex, cl?: { lead: CrossLead; m15Of: (asset: string) => Candle[] | undefined; exitK?: number }): SetupEvent[] {
  const exitHook = cl?.exitK !== undefined && cl.lead.any(A.asset) ? crossLeadExitHook(crossLeadPull(cl.lead, A.asset, cl.m15Of), cl.exitK) : undefined;
  const sigs: SetupSignal[] = [];
  for (const tf of [...FAST_TFS, ...SLOW_TFS]) {
    const s = A.series[tf]!;
    const spotPb = SPOT_PB.assets.includes(A.asset);
    for (let i = 60; i < s.cs.length; i++) { const g = detectAt(A.asset, tf, s, i, A.series['1d'], { spotPb }); if (g) sigs.push(g); }
  }
  const key = (g: SetupSignal) => `${g.tf}|${g.ts}|${g.kind}|${g.dir}`;
  const F = SETUP_BASE_FEATURES.length;
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
  const tn: Record<string, number> = {};
  for (const g0 of sigs) {
    const at = g0.ts + TF_MS[g0.tf]!;
    const reading = oos?.at(A.asset, at);
    const g = setupPlan(A, g0, costs, oos);
    const tr = simulateSetup(A, g, costs, exitHook);
    if (!tr?.closed) continue;
    const k = key(g0);
    let base = cached.get(k);
    if (!base) { base = Float32Array.from(setupVector(setupFeatureMap(g0, bars, btc), SETUP_BASE_FEATURES)); cached.set(k, base); fresh++; }
    tanetFeatures(tn, g.dir, reading);
    // The coin's character at the setup (hourly bars closed by then, this coin and the others).
    characterFeatures(tn, characterAtTime(A, others, at));
    // Where the BTC dominance cycle stands on its 2016-2017 parent, and the waterfall legs (point in time).
    fractalFeatures(tn, A.asset, g.dir, macro?.at(at));
    // The Librarian's walk-forward reading at the last closed hour.
    libSetupFeatures(tn, g.dir, lib?.at(A.asset, at));
    // The cross-asset graph network's walk-forward forecast at the last closed hour.
    xgSetupFeatures(tn, g.dir, xg?.at(A.asset, at));
    // Cross-coin lead-lag at the setup's close (the walk-forward fit before it).
    crossLeadSetupFeatures(tn, g.dir, cl ? crossLeadSetupReading(cl.lead, A.asset, at, cl.m15Of) : undefined);
    tn.kind_spotpb = g.kind === 'spotpb' ? 1 : 0;
    const x = new Float32Array(SETUP_FEATURES.length);
    x.set(base);
    SETUP_FEATURES.slice(F).forEach((name, j) => { x[F + j] = Number.isFinite(tn[name]) ? tn[name] : NaN; });
    const res = tradeResult(tr);
    out.push({ asset: A.asset, sig: g, at, exitAt: tr.closed.ts, r: res.r, ret: res.ret, x });
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

export type LaneFit = LaneScorer;

export function fitLane(train: SetupEvent[], seed = 7, mask: number[] = []): LaneFit {
  const meanR = train.length ? train.reduce((a, e) => a + yOf(e), 0) / train.length : 0;
  if (train.length < MIN_MODEL_TRADES) return { meanR, trades: train.length };
  // The most recent MAX_TRAIN trades (memory: features are 785 wide; recent behaviour matters most).
  const sorted = [...train].sort((a, b) => a.at - b.at).slice(-MAX_TRAIN);
  const cut = Math.floor(sorted.length * 0.85);
  const tr = sorted.slice(0, cut), va = sorted.slice(cut);
  const X = tr.map((e) => applyMask(e.x, mask)), Xv = va.map((e) => applyMask(e.x, mask));
  const fit = trainGbdt(X, tr.map(yOf), tr.map(() => 1), tr.map(() => meanR), Xv, va.map(yOf), va.map(() => 1), va.map(() => meanR), { ...GBDT, seed });
  if (!fit.trees) return { meanR, trades: train.length };
  const out: LaneFit = { model: fit.model, meanR, trades: train.length };
  // Calibration: where the model's predictions fall on trades it did not train on (the early-stopping set).
  out.quantiles = quantilesOf(Xv.map((x) => rawPrediction(out, x)));
  return out;
}

export const scoreWith = (f: LaneFit, x: ArrayLike<number>) => laneScore(f, x);

/** Walk-forward out-of-sample scores (NaN before the first fold). */
export function walkForward(events: SetupEvent[], lane: Lane, firstFold: number, foldMs: number, log: (m: string) => void, mask: number[] = []): Float64Array {
  const sc = new Float64Array(events.length).fill(NaN);
  const end = maxOf(events, (e) => e.at) + 1;
  for (let a = firstFold; a < end; a += foldMs) {
    const b = a + foldMs;
    const train = events.filter((e) => e.sig.lane === lane && e.exitAt < a);
    const f = fitLane(train, 7 + Math.floor(a / foldMs), mask);
    let n = 0;
    events.forEach((e, i) => { if (e.sig.lane === lane && e.at >= a && e.at < b) { sc[i] = scoreWith(f, applyMask(e.x, mask)); n++; } });
    log(`  ${lane} fold ${iso(a)}: trained on ${train.length} trades (${f.model ? `${f.model.trees.length} trees` : 'rule-only'}), scored ${n}`);
  }
  return sc;
}

// ---- Lane backtest ----------------------------------------------------------------------------------

export interface ClosedTrade { asset: string; lane: Lane; kind: string; entryTs: number; exitTs: number; r: number; ret: number; usd: number; score: number }

/** One event loop over every asset's 15-minute bars with the lane book (fixed equity for sizing). */
export function backtestLanes(assets: Map<string, AssetBars>, events: SetupEvent[], scores: Float64Array, book: LaneBookParams, costs: CostModel, equity: number, from: number, to: number, lanes: Lane[] = ['fast', 'slow'], keep: (e: SetupEvent) => boolean = () => true): ClosedTrade[] {
  const B = new LaneBook(book);
  const out: ClosedTrade[] = [];
  const byAt = new Map<number, number[]>();
  events.forEach((e, i) => { if (e.at >= from && e.at < to && Number.isFinite(scores[i]) && lanes.includes(e.sig.lane) && keep(e)) { const l = byAt.get(e.at) ?? []; l.push(i); byAt.set(e.at, l); } });
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

// ---- The optional inputs: are they plugged in? ------------------------------------------------------

/** The `schema` of a JSON forecasts file, read from its first few KB (the writers put it first; the files run to
 *  tens of MB), else from the whole file; undefined when missing or unreadable. */
export function forecastSchema(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4096);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const m = /"schema"\s*:\s*"([^"]*)"/.exec(head.subarray(0, n).toString('utf8'));
    if (m) return m[1];
  } catch { return undefined; } finally { if (fd !== undefined) fs.closeSync(fd); }
  try { return (JSON.parse(fs.readFileSync(file, 'utf8')) as { schema?: string }).schema; } catch { return undefined; }
}

export interface SetupInputStatus { name: string; ok: boolean; producer: string; detail?: string }

/** The cross-coin lead-lag study as a setup input: there when it validated a leader / coin pair at the horizons the
 *  setup scorer reads (15 and 60 minutes). */
function crossLeadInput(file: string): SetupInputStatus {
  const s = { name: 'cross-coin lead-lag (15 / 60 min)', ok: false, producer: 'cross_lead' };
  let p: CrossLeadParams;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')) as CrossLeadParams; } catch { return { ...s, detail: `no study at ${file}` }; }
  if (p.schema !== CL_SCHEMA) return { ...s, detail: `${file} has schema ${p.schema}, not ${CL_SCHEMA}` };
  const used = p.pairs.filter((x) => x.validated && (CL_SETUP_HORIZONS as readonly number[]).includes(x.h)).map((x) => `${x.leader}->${x.follower} ${x.h}m`);
  return used.length ? { ...s, ok: true, detail: used.join(', ') } : { ...s, detail: `the study (${p.pairs.length} pairs tested) found no leader / coin pair predictive at 15 or 60 minutes` };
}

/** Each optional input group of the setup scorer, whether its source is there for a history folder, and which
 *  pipeline step (or download) produces it (`crossLeadFile`: the cross-coin lead-lag study, when one is expected). */
export function setupInputStatus(hist: string, macro = macroConfig(process.env), crossLeadFile?: string): SetupInputStatus[] {
  const ms = macroSettings(macro);
  const daily = loadMacroDaily(hist);
  const btcd = daily.btcd, usdtd = daily.usdtd ?? [];
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  return [
    { name: 'TA network walk-forward', ok: forecastSchema(path.join(oosDir(hist), 'forecasts.json')) === TANET_SCHEMA, producer: 'ta_net_oos' },
    { name: `fractal (BTC.D daily ${day(ms.fractal.parentFrom)}..${day(ms.fractal.parentTo - DAY)})`, ok: new MacroSeries(daily, ms.params, ms.fractal).hasParent(), producer: 'history (TradingView, TV_FILL)', detail: btcd.length ? `BTC.D daily ${day(btcd[0].ts)}..${day(btcd[btcd.length - 1].ts)}` : 'no BTC.D daily' },
    // The waterfall's USDT.D leg (a fractal input), over the same years.
    { name: `waterfall USDT.D leg (USDT.D daily from ${day(ms.fractal.parentFrom)})`, ok: usdtd.length > 0 && usdtd[0].ts <= ms.fractal.parentFrom + 7 * DAY, producer: 'history (TradingView, TV_FILL)', detail: usdtd.length ? `USDT.D daily ${day(usdtd[0].ts)}..${day(usdtd[usdtd.length - 1].ts)}` : 'no USDT.D daily' },
    { name: 'Librarian walk-forward', ok: forecastSchema(path.join(libDir(hist), 'forecasts.json')) === LIB_SCHEMA, producer: 'librarian' },
    { name: 'cross-graph walk-forward', ok: forecastSchema(path.join(xgDir(hist), 'forecasts.json')) === XG_SCHEMA, producer: 'cross_graph' },
    ...(crossLeadFile === undefined ? [] : [crossLeadInput(crossLeadFile)]),
  ];
}

// ---- Main -------------------------------------------------------------------------------------------

/** Out-of-sample setups (walk-forward scores) for replays of recent days (research/wholeBot.ts). */
export interface SetupOosFile { version: string; from: string; to: string; events: Array<{ asset: string; sig: SetupSignal; at: number; exitAt: number; r: number; ret: number; score: number }> }

export interface TrainSetupOpts { oosOut?: string; oosMonths?: number; assets?: string[]; equityUsd?: number; costs?: CostModel; holdoutMonths?: number; finalMonths?: number; firstFold?: number; foldMonths?: number; cacheDir?: string; log?: (m: string) => void;
  /** The cross-coin lead-lag study (research/crossLead.ts): its inputs, and the lead-lag exit when it pays. */
  crossLead?: CrossLead }

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
  const oos = new OosIndex(loadOos(hist));
  if (!oos.f) log(`no TA network walk-forward forecasts in ${hist}/.tanet-oos (pipeline step ta_net_oos; by hand npm run research:ta-net-oos): its inputs stay blank`);
  const ms = macroSettings(macroConfig(process.env));
  const macro = new MacroSeries(loadMacroDaily(hist), ms.params, ms.fractal);
  if (!macro.hasParent()) log(`no BTC.D daily history for the fractal parent window (TradingView CRYPTOCAP:BTC.D, fetched by the history step's TradingView fill, TV_FILL): the fractal inputs stay blank`);
  const usdtd0 = macro.daily.usdtd?.[0]?.ts;
  if (usdtd0 === undefined || usdtd0 > ms.fractal.parentFrom + 7 * DAY) log(`${usdtd0 === undefined ? 'no USDT.D daily history' : `USDT.D daily history starts ${iso(usdtd0)}`} (TradingView CRYPTOCAP:USDT.D, fetched by the history step's TradingView fill, TV_FILL): the waterfall's USDT.D leg stays blank before ${usdtd0 === undefined ? 'it arrives' : iso(usdtd0 + 37 * DAY)}`);
  const lib = new LibIndex(loadLibForecasts(hist));
  if (!lib.f) log(`no Librarian walk-forward forecasts in ${hist}/.librarian (pipeline step librarian; by hand npm run research:librarian): its inputs stay blank`);
  const xg = new XgIndex(loadXgForecasts(hist));
  if (!xg.f) log(`no cross-graph walk-forward forecasts in ${hist}/.xgraph (pipeline step cross_graph; by hand npm run research:xgraph): its inputs stay blank`);
  // Cross-coin lead-lag: its inputs, and its exit if it raises the setups' net R out of sample (decided before the events
  // are simulated, so the scorer and the lane validation see the exits the live trader will make). Its windows end two
  // weeks short of the trainer's (which end at the last setup, a few days before the data does): the final window stays
  // unseen.
  const month0 = 30.44 * DAY, margin = 14 * DAY;
  const dataEnd = Math.max(...[...assets.values()].map((A) => A.m15[A.m15.length - 1]?.ts ?? 0)) + 1;
  const finalFrom0 = dataEnd - (o.finalMonths ?? 3) * month0 - margin, holdFrom0 = finalFrom0 - (o.holdoutMonths ?? 9) * month0;
  const m15Of = (a: string) => assets.get(a)?.m15;
  let crossLeadExit: SetupModelParams['crossLeadExit'];
  if (!o.crossLead) log('no cross-coin lead-lag study (pipeline step cross_lead; by hand npm run research:cross-lead): its inputs stay blank');
  else if (![...assets.keys()].some((a) => o.crossLead!.any(a))) log('cross-coin lead-lag: no leader / coin pair was predictive out of sample: its inputs stay blank, no lead-lag exit');
  else crossLeadExit = chooseCrossLeadExit(assets, o.crossLead, costs, { devTo: holdFrom0, holdTo: finalFrom0, log, oos });
  const cl = o.crossLead ? { lead: o.crossLead, m15Of, exitK: crossLeadExit?.k } : undefined;
  for (const A of assets.values()) pushAll(events, assetEvents(A, btc, costs, o.cacheDir ?? path.join(hist, '.setup-cache'), log, oos, [...assets.values()].filter((x) => x !== A).map((x) => x.h1), macro, lib, xg, cl));
  events.sort((a, b) => a.at - b.at);
  const end = maxOf(events, (e) => e.at) + 1;
  const month = 30.44 * DAY;
  const finalFrom = end - (o.finalMonths ?? 3) * month, holdoutFrom = finalFrom - (o.holdoutMonths ?? 9) * month;
  const firstFold = o.firstFold ?? Date.UTC(2020, 0, 1), foldMs = (o.foldMonths ?? 6) * month;
  for (const lane of ['fast', 'slow'] as const) {
    const ev = events.filter((e) => e.sig.lane === lane);
    log(`${lane} lane: ${ev.length} setups, standalone mean net R ${(ev.reduce((a, e) => a + e.r, 0) / Math.max(1, ev.length)).toFixed(3)}, win ${(100 * ev.filter((e) => e.ret > 0).length / Math.max(1, ev.length)).toFixed(1)}%`);
  }
  const cacheDir = o.cacheDir ?? path.join(hist, '.setup-cache');
  // Walk-forward scores with the given input groups (cached: same events, outcomes, inputs, folds and
  // model settings give the same scores).
  const scoresFor = (groups: string[]): Float64Array => {
    const mask = maskedIndices(groups);
    const h = crypto.createHash('sha1').update(JSON.stringify({ GBDT, MAX_TRAIN, MIN_MODEL_TRADES, firstFold, foldMs, schema: SETUP_SCHEMA, groups: [...groups].sort() }));
    const live = Object.entries(SETUP_GROUPS).filter(([g]) => groups.includes(g)).flatMap(([, ks]) => ks.map((k) => SETUP_FEATURES.indexOf(k)));
    for (const e of events) { h.update(`${e.asset}|${e.sig.tf}|${e.sig.ts}|${e.sig.kind}|${e.sig.dir}|${e.r.toFixed(6)}`); for (const i of live) h.update(`|${e.x[i]}`); h.update('\n'); }
    const scoreFile = path.join(cacheDir, `wf-scores.${h.digest('hex').slice(0, 16)}.json`);
    if (fs.existsSync(scoreFile)) {
      log(`walk-forward scores (${groups.length ? groups.join(', ') : 'candles only'}) from cache (${path.basename(scoreFile)})`);
      return Float64Array.from((JSON.parse(fs.readFileSync(scoreFile, 'utf8')) as Array<number | null>).map((v) => (v === null ? NaN : v)));
    }
    log(`walk-forward scores with ${groups.length ? `inputs: candles + ${groups.join(', ')}` : 'candle inputs only'}`);
    const sc = new Float64Array(events.length).fill(NaN);
    for (const lane of ['fast', 'slow'] as const) {
      const s = walkForward(events, lane, firstFold, foldMs, log, mask);
      s.forEach((v, i) => { if (Number.isFinite(v)) sc[i] = v; });
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(scoreFile, JSON.stringify(Array.from(sc, (v) => (Number.isFinite(v) ? v : null))));
    return sc;
  };
  // Per setup type, on the development years only: its minimum score from a short grid (the lane book
  // with only that type), and whether it is traded at all (its best development result must be net
  // positive). Every (type, threshold) tried counts as a trial.
  const GRID = [-Infinity, 0.5, 0.7, 0.8, 0.9, 0.95];
  const trialsOf: Record<string, number> = {};
  const chooseBook = (scores: Float64Array, quiet = false): LaneBookParams => {
    const book: LaneBookParams = JSON.parse(JSON.stringify(DEFAULT_LANES));
    for (const lane of ['fast', 'slow'] as const) {
      const kinds = [...new Set(events.filter((e) => e.sig.lane === lane).map((e) => kindKey(e.sig)))].sort();
      const byKind: Record<string, number> = {};
      for (const k of kinds) {
        let best = { th: -Infinity, usd: -Infinity, n: 0, t: 0 };
        for (const th of GRID) {
          const b: LaneBookParams = { ...book, [lane]: { ...book[lane], minScore: th, minScoreByKind: undefined } };
          const tr = backtestLanes(assets, events, scores, b, costs, equity, firstFold, holdoutFrom, [lane], (e) => kindKey(e.sig) === k);
          const usd = tr.reduce((a, t) => a + t.usd, 0);
          const rs = tr.map((t) => t.r), m = rs.reduce((a, v) => a + v, 0) / Math.max(1, rs.length);
          const sd = Math.sqrt(rs.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, rs.length - 1));
          if (usd > best.usd) best = { th, usd, n: tr.length, t: sd > 0 ? m / (sd / Math.sqrt(rs.length)) : 0 };
        }
        // Traded only with real evidence: net positive, enough trades, and a t-statistic of at least 1
        // (a type that merely scrapes above zero would take position slots from the types that work).
        const on = best.usd > 0 && best.n >= 20 && best.t >= 1;
        if (on) byKind[k] = best.th === -Infinity ? -1e9 : best.th;
        if (!quiet) log(`  ${lane} ${k}: best development threshold ${best.th === -Infinity ? 'none' : best.th} -> ${best.n} trades, net $${best.usd.toFixed(0)}, t ${best.t.toFixed(2)}: ${on ? 'TRADED' : 'off'}`);
      }
      book[lane].minScoreByKind = byKind;
      book[lane].minScore = Math.min(...Object.values(byKind), 1e9);
      book[lane].refScore = 0.5;
      trialsOf[lane] = (trialsOf[lane] ?? 0) + kinds.length * GRID.length;
    }
    return book;
  };
  /** t-statistic of net R per trade of both lanes on the development years. */
  const devScore = (scores: Float64Array, book: LaneBookParams) => {
    const rs = backtestLanes(assets, events, scores, book, costs, equity, firstFold, holdoutFrom).map((t) => t.r);
    const m = rs.reduce((a, v) => a + v, 0) / Math.max(1, rs.length), sd = Math.sqrt(rs.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, rs.length - 1));
    return { t: sd > 0 ? m / (sd / Math.sqrt(rs.length)) : 0, n: rs.length, mean: m };
  };
  let groups: string[] = [];
  let scores = scoresFor(groups);
  let book = chooseBook(scores, true);
  const groupChoice: NonNullable<SetupModelParams['groupChoice']> = {};
  const tnIdx = SETUP_GROUPS.tanet.map((k) => SETUP_FEATURES.indexOf(k));
  const tnCover = events.filter((e) => e.at >= firstFold && Number.isFinite(e.x[tnIdx[0]])).length / Math.max(1, events.filter((e) => e.at >= firstFold).length);
  if (tnCover > 0.8) {
    const base = devScore(scores, book);
    const sT = scoresFor(['tanet']);
    const bT = chooseBook(sT, true);
    const withT = devScore(sT, bT);
    const kept = withT.t > base.t;
    groupChoice.tanet = { withGroup: withT.t, without: base.t, kept };
    log(`TA network inputs on the development years: with ${withT.n} trades, mean R ${withT.mean.toFixed(3)}, t ${withT.t.toFixed(2)} | without ${base.n} trades, mean R ${base.mean.toFixed(3)}, t ${base.t.toFixed(2)} -> ${kept ? 'KEPT' : 'blanked'}`);
    if (kept) { groups = ['tanet']; scores = sT; }
  } else log(`TA network inputs: walk-forward forecasts cover ${(100 * tnCover).toFixed(0)}% of the setups since ${iso(firstFold)} (need 80%; npm run research:ta-net-oos) -> blanked`);
  // The coin's market character: kept on the same terms (it must raise the development years' t).
  const chIdx = SETUP_FEATURES.indexOf(SETUP_GROUPS.character[0]);
  const chCover = events.filter((e) => e.at >= firstFold && Number.isFinite(e.x[chIdx])).length / Math.max(1, events.filter((e) => e.at >= firstFold).length);
  if (chCover > 0.8) {
    const base = devScore(scores, chooseBook(scores, true));
    const sC = scoresFor([...groups, 'character']);
    const withC = devScore(sC, chooseBook(sC, true));
    const kept = withC.t > base.t;
    groupChoice.character = { withGroup: withC.t, without: base.t, kept };
    log(`character inputs on the development years: with ${withC.n} trades, mean R ${withC.mean.toFixed(3)}, t ${withC.t.toFixed(2)} | without ${base.n} trades, mean R ${base.mean.toFixed(3)}, t ${base.t.toFixed(2)} -> ${kept ? 'KEPT' : 'blanked'}`);
    if (kept) { groups = [...groups, 'character']; scores = sC; }
  } else log(`character inputs cover ${(100 * chCover).toFixed(0)}% of the setups since ${iso(firstFold)} (need 80%) -> blanked`);
  // The fractal cycle and the waterfall legs: kept on the same terms.
  const faIdx = SETUP_FEATURES.indexOf(SETUP_GROUPS.fractal[0]);
  const faCover = events.filter((e) => e.at >= firstFold && Number.isFinite(e.x[faIdx])).length / Math.max(1, events.filter((e) => e.at >= firstFold).length);
  if (faCover > 0.8) {
    const base = devScore(scores, chooseBook(scores, true));
    const sF = scoresFor([...groups, 'fractal']);
    const withF = devScore(sF, chooseBook(sF, true));
    const kept = withF.t > base.t;
    groupChoice.fractal = { withGroup: withF.t, without: base.t, kept };
    log(`fractal inputs on the development years: with ${withF.n} trades, mean R ${withF.mean.toFixed(3)}, t ${withF.t.toFixed(2)} | without ${base.n} trades, mean R ${base.mean.toFixed(3)}, t ${base.t.toFixed(2)} -> ${kept ? 'KEPT' : 'blanked'}`);
    if (kept) { groups = [...groups, 'fractal']; scores = sF; }
  } else log(`fractal inputs cover ${(100 * faCover).toFixed(0)}% of the setups since ${iso(firstFold)} (need 80%; BTC.D 2016-2017 history) -> blanked`);
  // The Librarian: kept on the same terms.
  const lbIdx = SETUP_FEATURES.indexOf(SETUP_GROUPS.librarian[0]);
  const lbCover = events.filter((e) => e.at >= firstFold && Number.isFinite(e.x[lbIdx])).length / Math.max(1, events.filter((e) => e.at >= firstFold).length);
  if (lbCover > 0.8) {
    const base = devScore(scores, chooseBook(scores, true));
    const sL = scoresFor([...groups, 'librarian']);
    const withL = devScore(sL, chooseBook(sL, true));
    const kept = withL.t > base.t;
    groupChoice.librarian = { withGroup: withL.t, without: base.t, kept };
    log(`Librarian inputs on the development years: with ${withL.n} trades, mean R ${withL.mean.toFixed(3)}, t ${withL.t.toFixed(2)} | without ${base.n} trades, mean R ${base.mean.toFixed(3)}, t ${base.t.toFixed(2)} -> ${kept ? 'KEPT' : 'blanked'}`);
    if (kept) { groups = [...groups, 'librarian']; scores = sL; }
  } else log(`Librarian inputs: walk-forward forecasts cover ${(100 * lbCover).toFixed(0)}% of the setups since ${iso(firstFold)} (need 80%; npm run research:librarian) -> blanked`);
  // The cross-asset graph network: kept on the same terms.
  const xgIdx = SETUP_FEATURES.indexOf(SETUP_GROUPS.xgraph[0]);
  const xgCover = events.filter((e) => e.at >= firstFold && Number.isFinite(e.x[xgIdx])).length / Math.max(1, events.filter((e) => e.at >= firstFold).length);
  if (xgCover > 0.8) {
    const base = devScore(scores, chooseBook(scores, true));
    const sX = scoresFor([...groups, 'xgraph']);
    const withX = devScore(sX, chooseBook(sX, true));
    const kept = withX.t > base.t;
    groupChoice.xgraph = { withGroup: withX.t, without: base.t, kept };
    log(`cross-graph inputs on the development years: with ${withX.n} trades, mean R ${withX.mean.toFixed(3)}, t ${withX.t.toFixed(2)} | without ${base.n} trades, mean R ${base.mean.toFixed(3)}, t ${base.t.toFixed(2)} -> ${kept ? 'KEPT' : 'blanked'}`);
    if (kept) { groups = [...groups, 'xgraph']; scores = sX; }
  } else log(`cross-graph inputs: walk-forward forecasts cover ${(100 * xgCover).toFixed(0)}% of the setups since ${iso(firstFold)} (need 80%; npm run research:xgraph) -> blanked`);
  // Cross-coin lead-lag: kept on the same terms. Only the coins with a validated leader have a reading, and only over the
  // study's years after its first fit, so it needs 300 development setups with a reading rather than 80% coverage.
  const clIdx = SETUP_GROUPS.crosslead.map((k) => SETUP_FEATURES.indexOf(k));
  const clN = events.filter((e) => e.at >= firstFold && e.at < holdoutFrom && clIdx.some((j) => Number.isFinite(e.x[j]))).length;
  if (clN >= 300) {
    const base = devScore(scores, chooseBook(scores, true));
    const sCl = scoresFor([...groups, 'crosslead']);
    const withCl = devScore(sCl, chooseBook(sCl, true));
    const kept = withCl.t > base.t;
    groupChoice.crosslead = { withGroup: withCl.t, without: base.t, kept };
    log(`cross-coin lead-lag inputs (${clN} development setups with a reading): with ${withCl.n} trades, mean R ${withCl.mean.toFixed(3)}, t ${withCl.t.toFixed(2)} | without ${base.n} trades, mean R ${base.mean.toFixed(3)}, t ${base.t.toFixed(2)} -> ${kept ? 'KEPT' : 'blanked'}`);
    if (kept) { groups = [...groups, 'crosslead']; scores = sCl; }
  } else log(`cross-coin lead-lag inputs: ${clN} development setups with a reading (need 300; pipeline step cross_lead) -> blanked`);
  book = chooseBook(scores);
  const validation: SetupModelParams['validation'] = {};
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
    validation[lane] = { periods, trials: trialsOf[lane], passed: reasons.length === 0, reasons };
    for (const [k, p] of Object.entries(periods)) {
      log(`${lane} ${k} ${p.from}..${p.to}: ${p.trades} trades (${p.tradesPerDay.toFixed(2)}/day), win ${(100 * p.winRate).toFixed(1)}%, mean net R ${p.avgR.toFixed(3)} [${p.avgRLo.toFixed(3)}, ${p.avgRHi.toFixed(3)}], PF ${p.profitFactor.toFixed(2)}, net $${p.netUsd.toFixed(0)} ($${p.usdPerDay.toFixed(1)}/day on $${equity}), max DD $${p.maxDrawdownUsd.toFixed(0)}, Sharpe ${p.sharpe.toFixed(2)}`);
      for (const [kind, s] of Object.entries(p.byKind)) log(`    ${kind}: ${s.trades} trades, win ${(100 * s.winRate).toFixed(1)}%, mean R ${s.avgR.toFixed(3)}`);
    }
    log(`${lane} lane ${reasons.length ? `NOT validated: ${reasons.join('; ')}` : 'validated'}`);
  }
  // Optimal f per lane on the out-of-sample trades (the live trader recomputes it with its own trades
  // added; this report is what the history alone supports at training time).
  const sizing: NonNullable<SetupModelParams['sizing']> = {};
  for (const lane of ['fast', 'slow'] as const) {
    const lt = trades.filter((t) => t.lane === lane).sort((a, b) => a.exitTs - b.exitTs);
    const rep = optimalF(lt.map((t) => ({ ts: t.exitTs, r: t.r, w: recencyWeight(t.exitTs, end, 365) * (t.entryTs < holdoutFrom ? 0.5 : 1) })), { horizon: 100 });
    sizing[lane] = { trades: lt.map((t) => [t.exitTs, +t.r.toFixed(4)] as [number, number]), devUntil: holdoutFrom, report: rep };
    log(`${lane} optimal f: ${rep.n} trades, mean R ${rep.meanR.toFixed(3)}, g* ${(100 * rep.gStar).toFixed(2)}% (bootstrap p25 ${(100 * rep.gP25).toFixed(2)}% / p50 ${(100 * rep.gP50).toFixed(2)}%) at risk per trade -> cap ${Number.isFinite(rep.cap) ? `${(100 * rep.cap).toFixed(2)}%` : 'none'}; 95% of 100-trade runs draw down less than ${rep.ddP95R.toFixed(1)}R`);
  }
  // Information only (not used for any choice): the same book with limit-order entries (maker fee,
  // no slippage) instead of market entries, from the holdout on.
  const makerCosts: CostModel = { ...costs, entry: costs.makerExit };
  const mk = backtestLanes(assets, events, scores, book, makerCosts, equity, holdoutFrom, end);
  for (const lane of ['fast', 'slow'] as const) {
    const p = periodStats(mk.filter((t) => t.lane === lane), holdoutFrom, end);
    log(`${lane} with limit-order entries, holdout + final ${p.from}..${p.to}: ${p.trades} trades, win ${(100 * p.winRate).toFixed(1)}%, mean net R ${p.avgR.toFixed(3)} [${p.avgRLo.toFixed(3)}, ${p.avgRHi.toFixed(3)}], net $${p.netUsd.toFixed(0)} ($${p.usdPerDay.toFixed(1)}/day on $${equity})`);
  }
  // Recent setups with their walk-forward scores (each scored by a model that never saw it), for
  // replays of the bot's recorded days with every component in the loop.
  if (o.oosOut) {
    const from = end - (o.oosMonths ?? 24) * month;
    const ev = events.flatMap((e, i) => (e.at >= from && Number.isFinite(scores[i]) && minScoreFor(book[e.sig.lane], e.sig) !== undefined ? [{ asset: e.asset, sig: e.sig, at: e.at, exitAt: e.exitAt, r: +e.r.toFixed(5), ret: +e.ret.toFixed(6), score: +scores[i].toFixed(5) }] : []));
    const f: SetupOosFile = { version: `setups1-${iso(Date.now())}`, from: iso(from), to: iso(end), events: ev };
    fs.mkdirSync(path.dirname(o.oosOut), { recursive: true });
    fs.writeFileSync(o.oosOut, JSON.stringify(f));
    log(`wrote ${ev.length} out-of-sample setups since ${iso(from)} to ${o.oosOut}`);
  }
  // Deployed model: refit on every event.
  const lanes: SetupModelParams['lanes'] = {};
  for (const lane of ['fast', 'slow'] as const) lanes[lane] = fitLane(events.filter((e) => e.sig.lane === lane), 11, maskedIndices(groups));
  return {
    version: `setups1-${iso(Date.now())}`, schema: SETUP_SCHEMA, features: SETUP_FEATURES, groups, groupChoice, volTrailK: VOL_ADAPT.trailK, ...(RATCHET.lanes !== 'off' ? { ratchet: { ...RATCHET } } : {}), ...(SCALE_OUT.lanes !== 'off' ? { scaleOut: { ...SCALE_OUT } } : {}), ...(SPOT_PB.assets.length ? { spotPullback: [...SPOT_PB.assets] } : {}), ...(crossLeadExit ? { crossLeadExit } : {}), taEngine: taEngine(), lanes, book, costs, equityUsd: equity, validation, sizing, trainedAt: new Date().toISOString(),
    data: { assets: [...assets.keys()], from: iso(events[0].at), to: iso(end), holdoutFrom: iso(holdoutFrom), finalFrom: iso(finalFrom), events: events.length },
  };
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

export async function trainSetupMain(argOf: (k: string, d: string) => string = cliArg): Promise<SetupModelParams> {
  const hist = argOf('history', 'data/history');
  const out = argOf('out', 'params/setup_model.json');
  const assets = argOf('assets', '');
  // The 4h ATR ratchet the events are simulated with (and recorded in the model for the live trader).
  const lanes = argOf('ratchet', process.env.SETUP_RATCHET ?? 'slow');
  const num = (k: string, d: number) => { const v = Number(argOf(k, String(d))); return Number.isFinite(v) && v > 0 ? v : d; };
  Object.assign(RATCHET, {
    lanes: (['off', 'slow', 'fast', 'both'] as const).find((x) => x === lanes) ?? 'slow',
    stopAtr: num('ratchet-stop-atr', 3.5), beAtr: num('ratchet-be-atr', 2), trailStartAtr: num('ratchet-trail-start-atr', 3.5), trailAtr: num('ratchet-trail-atr', 3),
    volK: (() => { const v = Number(argOf('ratchet-vol-k', process.env.SETUP_RATCHET_VOL_K ?? '0')); return Number.isFinite(v) ? v : 0; })(),
  });
  // Scale-out exits (off unless adopted from the setups-scale sweep), recorded in the model the same way.
  const scale = argOf('scale-out', process.env.SETUP_SCALE_OUT ?? 'off');
  const frac = (k: string, d: number) => { const v = Number(argOf(k, String(d))); return Number.isFinite(v) && v >= 0 ? v : d; };
  Object.assign(SCALE_OUT, {
    lanes: (['off', 'slow', 'fast', 'both'] as const).find((x) => x === scale) ?? 'off',
    r1: num('scale-r1', 1), f1: frac('scale-f1', 0.33), r2: num('scale-r2', 2), f2: frac('scale-f2', 0.33), trailAtr: num('scale-trail-atr', 2.5),
  });
  // The spot pullback: only once adopted (SETUP_SPOT_PB=on) and only for the coins where spot leads the perp by the
  // latest lead-lag study (research/leadLag.ts); recorded in the model so the live trader detects the same setups.
  const leadFile = argOf('lead-lag', '');
  SPOT_PB.assets = argOf('spot-pb', process.env.SETUP_SPOT_PB ?? 'off') === 'on' && leadFile ? spotLeads(leadFile) : [];
  // The cross-coin lead-lag study (research/crossLead.ts), when there is one.
  const clFile = argOf('cross-lead', process.env.CROSS_LEAD_PATH ?? '');
  let crossLead: CrossLead | undefined;
  if (clFile && fs.existsSync(clFile)) { try { crossLead = CrossLead.load(clFile); } catch (e) { console.log(`[setups] ${clFile}: ${(e as Error).message}`); } }
  const p = await trainSetupModel(hist, { oosOut: argOf('oos-out', '') || undefined, assets: assets ? assets.split(',') : undefined, equityUsd: Number(argOf('equity', '10000')), holdoutMonths: Number(argOf('holdout-months', '9')), finalMonths: Number(argOf('final-months', '3')), crossLead });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(p));
  console.log(`[setups] wrote ${out} (fast ${p.validation.fast?.passed ? 'validated' : 'not validated'}, slow ${p.validation.slow?.passed ? 'validated' : 'not validated'})`);
  return p;
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void trainSetupMain();

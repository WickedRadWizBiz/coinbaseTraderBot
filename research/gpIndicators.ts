// Genetic programming of trading formulas: machine-made indicators evolved on years of hourly history, after
// the video "I let genetic programming design trading indicators" and ZiadFrancis/Genetics_Trading_Part_1
// (DEAP + vectorbt), rebuilt for the bot's coins. The formula language and its evaluation are in
// bot/gp/expr.ts (shared with the live bot).
//
// Per coin (BTC, ETH, SOL, XRP, DOGE: GP_ASSETS), with the cross-market coins' bars as extra inputs (GP_CROSS,
// BTC and ETH: the video predicts one pair from four):
//   1. population   GP_POPULATION (1,000; 15,000 in the video, the laptop trainer's size) random formulas,
//                   half grown, half full trees (ramped half-and-half, depth 1..5), plus the formula in use
//   2. fitness      each formula's exposure backtested on the training years: target-percent position in
//                   -100 % .. +100 %, a 10 % dead band (GP_BAND) so small moves of the formula pay no fees,
//                   GP_COST_BPS (5 bps) per unit of exposure traded. Score = annualised Sharpe (GP_FITNESS=
//                   sharpe, the default: risk-adjusted) or -e^(-total return) (GP_FITNESS=return: the video's
//                   e^(-returns), minimised), minus a little per node (bloat control); fewer than 20 trades,
//                   a wiped-out account or a broken formula scores worst (the video's 1e6 penalty).
//   3. survival     the best 10 % pass to the next generation unchanged; the rest are bred: parents picked by
//                   tournament (best of 3), one-point subtree crossover (90 %: a random branch of one formula
//                   swapped with a random branch of the other), mutation (15 %: a branch regrown, one node
//                   swapped for another of the same kind, or a branch hoisted up). A child deeper than 8,
//                   longer than 60 tokens or looking back more than 240 hours is replaced by its parent.
//   4. generations  GP_GENERATIONS (15), keeping a hall of fame of the 10 best formulas ever seen.
//   5. champion     the hall-of-fame formula with the best score on the validation years (after training),
//                   then tested ONCE on the most recent years (never seen by the evolution or the choice):
//                   return, Sharpe, max drawdown, trades, against buy-and-hold. Splits: 60 / 20 / 20 % of the
//                   timeline, oldest to newest.
//   6. validated    test Sharpe > 0 with the probabilistic Sharpe of its daily returns >= GP_MIN_PSR (0.9),
//                   deflated by every champion that was ever compared on a test window for that coin,
//                   enough trades and a drawdown within GP_MAX_DD_PCT. Only validated formulas speak live
//                   (bot/gp/gpSignals.ts: one more TA conviction signal).
//   7. promotion    a new champion replaces the one in use only when it scores better on the new test window
//                   (both judged on the same years); the file is champions per coin, so a better BTC formula
//                   never costs the ETH one.
//
//   npx tsx research/gpIndicators.ts --history data/history [--assets BTC,ETH] [--cross BTC,ETH]
//        [--population 1000] [--generations 15] [--fitness sharpe|return] [--seed 1] [--out data/models/gp_indicators.json]

import fs from 'fs';
import path from 'path';
import {
  arity, assetsOf, BINARY, buildInputs, depthOf, desiredExposure, evaluate, FIELDS, formulaText, heldExposure, isValid, lookbackOf, MAX_LOOKBACK, parseToken, subtreeEnd,
  UNARY, WINDOW_OPS, windowsOf, type Bar, type Inputs, type Token,
} from '../bot/gp/expr';
import { loadSeries, storedAssets } from './history/candles';
import { deflatedSharpe, probabilisticSharpe, rng } from './stats';
import { WorkerPool, workerScript } from './workerPool';

export const GP_SCHEMA = 'gp1';

export interface GpOptions {
  population?: number; generations?: number;
  /** Share of the population passed on unchanged (the best). */
  elite?: number;
  tournament?: number; pCx?: number; pMut?: number;
  maxDepth?: number; maxLen?: number; maxLookback?: number; initDepth?: [number, number];
  costBps?: number; band?: number; fitness?: 'sharpe' | 'return';
  /** Fewest trades on the training years (scaled down for the shorter validation and test years). */
  minTrades?: number;
  /** Score taken off per token. */
  parsimony?: number;
  hof?: number;
  /** Training and validation shares of the timeline (the rest is the test). */
  split?: [number, number];
  minPsr?: number; maxDdPct?: number;
  seed?: number;
  /** Formulas put into the first generation (the champion in use). */
  seeds?: Token[][];
  /** Champions already compared on a test window for this coin (deflates the test's probabilistic Sharpe). */
  contests?: number;
  workers?: number;
  log?: (m: string) => void;
}

const DEFAULTS = {
  population: 1000, generations: 15, elite: 0.1, tournament: 3, pCx: 0.9, pMut: 0.15, maxDepth: 8, maxLen: 60, maxLookback: MAX_LOOKBACK, initDepth: [1, 5] as [number, number],
  costBps: 5, band: 0.1, fitness: 'sharpe' as 'sharpe' | 'return', minTrades: 20, parsimony: 0.002, hof: 10, split: [0.6, 0.2] as [number, number], minPsr: 0.9, maxDdPct: 35,
};
export type Opts = typeof DEFAULTS & GpOptions;
export const withDefaults = (o: GpOptions): Opts => ({ ...DEFAULTS, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) }) as Opts;

// ---- Data ----------------------------------------------------------------------------------------

export interface GpData {
  target: string; inputs: string[]; inp: Inputs;
  /** Target's hourly log returns (bar t: close t / close t-1). */
  ret: Float64Array;
  /** First bar every formula has warmed up on (every input coin trading for MAX_LOOKBACK bars); split ends. */
  start: number; trainEnd: number; valEnd: number;
}

export function gpData(target: string, bars: Record<string, Bar[]>, split: [number, number] = DEFAULTS.split): GpData {
  const inp = buildInputs(target, bars);
  const inputs = Object.keys(bars).sort();
  let first = 0;
  for (const a of inputs) { const c = inp.cols.get(`${a}.c`)!; let i = 0; while (i < inp.n && Number.isNaN(c[i])) i++; first = Math.max(first, i); }
  const start = Math.min(inp.n, first + MAX_LOOKBACK);
  const span = inp.n - start;
  return { target, inputs, inp, ret: inp.cols.get(`${target}.c`)!, start, trainEnd: start + Math.floor(split[0] * span), valEnd: start + Math.floor((split[0] + split[1]) * span) };
}

/** Coins to evolve formulas for: GP_ASSETS, else the usual five that have hourly history. */
export function gpAssets(dir: string, wanted: string[] = []): string[] {
  const have = storedAssets(dir);
  return (wanted.length ? wanted : ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']).map((a) => a.toUpperCase()).filter((a) => have.includes(a));
}

/** Input coins of a target: itself and the cross-market coins that have history. */
export function inputsFor(dir: string, target: string, cross: string[]): string[] {
  const have = storedAssets(dir);
  return [...new Set([target, ...cross.map((a) => a.toUpperCase())])].filter((a) => have.includes(a));
}

export function loadGpData(dir: string, target: string, inputs: string[], split?: [number, number]): GpData {
  const bars: Record<string, Bar[]> = {};
  for (const a of inputs) { const cs = loadSeries(dir, a, '1h').candles; if (cs.length) bars[a] = cs; }
  if (!bars[target]) throw new Error(`no hourly history for ${target}`);
  return gpData(target, bars, split);
}

const sliceInputs = (inp: Inputs, end: number): Inputs => ({ n: end, ts: inp.ts.subarray(0, end), cols: new Map([...inp.cols].map(([k, v]) => [k, v.subarray(0, end)])) });

// ---- Backtest ------------------------------------------------------------------------------------

export interface SliceStats {
  from: string; to: string; bars: number;
  totalReturn: number; sharpe: number; maxDd: number; trades: number;
  /** Mean |exposure| and exposure traded per year. */
  exposure: number; turnover: number;
}

/** Exposure `held` (decided at each bar's close) over bars a..b-1 of the target: each bar earns the exposure
 *  held from the bar before, less the cost of the exposure traded at that bar's open. Also the daily returns. */
export function backtest(held: Float64Array, d: Pick<GpData, 'ret' | 'inp'>, a: number, b: number, costBps: number): SliceStats & { daily: number[]; hourly: Float64Array } {
  const cost = costBps / 1e4;
  const hourly = new Float64Array(Math.max(0, b - a));
  let eq = 1, peak = 1, maxDd = 0, trades = 0, expo = 0, turn = 0;
  const daily: number[] = [];
  let day = -1, dayEq = 1;
  for (let t = a; t < b; t++) {
    const w = t >= 1 ? held[t - 1] : 0, w0 = t >= 2 ? held[t - 2] : 0;
    const r = d.ret[t];
    const traded = Math.abs(w - w0);
    if (traded > 0) trades++;
    const R = w * (Number.isFinite(r) ? Math.exp(r) - 1 : 0) - cost * traded;
    hourly[t - a] = R;
    eq *= 1 + R; expo += Math.abs(w); turn += traded;
    peak = Math.max(peak, eq); maxDd = Math.max(maxDd, 1 - eq / peak);
    const dd = Math.floor(d.inp.ts[t] / 86_400_000);
    if (dd !== day) { if (day >= 0) daily.push(dayEq - 1); day = dd; dayEq = 1; }
    dayEq *= 1 + R;
    if (eq <= 0) { maxDd = 1; break; }
  }
  if (day >= 0) daily.push(dayEq - 1);
  let m = 0;
  for (const x of hourly) m += x;
  m /= Math.max(1, hourly.length);
  let v = 0;
  for (const x of hourly) v += (x - m) ** 2;
  const sd = Math.sqrt(v / Math.max(1, hourly.length - 1));
  const iso = (i: number) => (i >= 0 && i < d.inp.n ? new Date(d.inp.ts[i]).toISOString().slice(0, 10) : '');
  const years = Math.max(1e-9, (b - a) / 8760);
  return {
    from: iso(a), to: iso(b - 1), bars: b - a, totalReturn: eq - 1, sharpe: sd > 0 ? (m / sd) * Math.sqrt(8760) : 0, maxDd, trades,
    exposure: expo / Math.max(1, b - a), turnover: turn / years, daily, hourly,
  };
}

/** Score (higher is better): annualised Sharpe or -e^(-return), less parsimony per token; worst when it
 *  trades too little, loses the account, or breaks. */
export function scoreOf(s: SliceStats, size: number, o: Pick<Opts, 'fitness' | 'parsimony'>, minTrades: number): number {
  if (!Number.isFinite(s.totalReturn) || !Number.isFinite(s.sharpe) || s.totalReturn <= -1 || s.trades < minTrades) return -1e6;
  const base = o.fitness === 'return' ? -Math.exp(-s.totalReturn) : s.sharpe;
  return base - o.parsimony * size;
}

const minTradesFor = (d: GpData, o: Opts, a: number, b: number) => Math.max(5, Math.round(o.minTrades * (b - a) / Math.max(1, d.trainEnd - d.start)));

/** A formula's held exposure over the data (or its first `end` bars). */
export function exposureOf(tokens: Token[], d: GpData, band: number, end = d.inp.n): Float64Array {
  return heldExposure(desiredExposure(evaluate(tokens, end === d.inp.n ? d.inp : sliceInputs(d.inp, end))), band);
}

export function trainScore(tokens: Token[], d: GpData, o: Opts): number {
  try {
    const held = exposureOf(tokens, d, o.band, d.trainEnd);
    return scoreOf(backtest(held, d, d.start, d.trainEnd, o.costBps), tokens.length, o, o.minTrades);
  } catch { return -1e6; }
}

// ---- Variation -----------------------------------------------------------------------------------

type Rng = () => number;
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const PRIMS = [...BINARY, ...UNARY, ...WINDOW_OPS];

function randomPrim(r: Rng): Token {
  const p = pick(r, PRIMS);
  return (WINDOW_OPS as readonly string[]).includes(p) ? `${p}${pick(r, windowsOf(p as typeof WINDOW_OPS[number]))}` : p;
}

function randomTerminal(r: Rng, assets: string[]): Token {
  return r() < 0.1 ? String(+(r() * 2 - 1).toFixed(4)) : `${pick(r, assets)}.${pick(r, FIELDS)}`;
}

/** A random tree: `full` grows every branch to the drawn height, otherwise branches may stop early. */
export function randomTree(r: Rng, assets: string[], minDepth: number, maxDepth: number, full: boolean): Token[] {
  const height = minDepth + Math.floor(r() * (maxDepth - minDepth + 1));
  const termRatio = (FIELDS.length * assets.length + 1) / (FIELDS.length * assets.length + 1 + PRIMS.length);
  const out: Token[] = [];
  const grow = (depth: number) => {
    if (depth >= height || (!full && depth >= minDepth && r() < termRatio)) { out.push(randomTerminal(r, assets)); return; }
    const p = randomPrim(r);
    out.push(p);
    for (let k = 0; k < arity(p); k++) grow(depth + 1);
  };
  grow(0);
  return out;
}

const fits = (t: Token[], o: Pick<Opts, 'maxDepth' | 'maxLen' | 'maxLookback'>) => isValid(t) && t.length <= o.maxLen && depthOf(t) <= o.maxDepth && lookbackOf(t) <= o.maxLookback;

/** One-point subtree crossover: a random branch of each parent swapped (the root is never picked). */
export function crossover(a: Token[], b: Token[], r: Rng): [Token[], Token[]] {
  if (a.length < 2 || b.length < 2) return [a.slice(), b.slice()];
  const i = 1 + Math.floor(r() * (a.length - 1)), j = 1 + Math.floor(r() * (b.length - 1));
  const ie = subtreeEnd(a, i), je = subtreeEnd(b, j);
  return [[...a.slice(0, i), ...b.slice(j, je), ...a.slice(ie)], [...b.slice(0, j), ...a.slice(i, ie), ...b.slice(je)]];
}

/** Mutation: regrow a random branch (uniform), swap one node for another of the same arity, or hoist a
 *  branch over its parent (shrink). */
export function mutate(t: Token[], r: Rng, assets: string[]): Token[] {
  const i = Math.floor(r() * t.length);
  const ie = subtreeEnd(t, i);
  const u = r();
  if (u < 0.6) return [...t.slice(0, i), ...randomTree(r, assets, 0, 2, true), ...t.slice(ie)];
  if (u < 0.85) {
    const p = parseToken(t[i]);
    let rep: Token;
    if (p.kind === 'const') rep = String(+Math.max(-1, Math.min(1, p.v + 0.2 * (r() + r() + r() - 1.5))).toFixed(4));
    else if (p.kind === 'in') rep = randomTerminal(r, assets);
    else if (p.kind === 'bin') rep = pick(r, BINARY);
    else { do rep = randomPrim(r); while (arity(rep) !== 1); }
    return [...t.slice(0, i), rep, ...t.slice(i + 1)];
  }
  if (ie - i < 2) return t.slice();
  const k = i + 1 + Math.floor(r() * (ie - i - 1));
  return [...t.slice(0, i), ...t.slice(k, subtreeEnd(t, k)), ...t.slice(ie)];
}

// ---- Evolution -----------------------------------------------------------------------------------

export interface GenStats { gen: number; best: number; median: number; meanSize: number; evaluated: number }
interface Ind { t: Token[]; key: string; score: number }

/** Scores formulas on the training years: inline, or spread over worker threads. */
export type Scorer = (formulas: Token[][]) => Promise<number[]>;

export function inlineScorer(d: GpData, o: Opts): Scorer {
  return async (fs) => fs.map((f) => trainScore(f, d, o));
}

/** Evolve one population; the hall of fame (best first) and the per-generation stats. */
export async function evolve(d: GpData, opts: GpOptions, scorer?: Scorer): Promise<{ hof: Ind[]; history: GenStats[]; evaluated: number }> {
  const o = withDefaults(opts);
  const r = rng(o.seed ?? Date.now() % 2 ** 31);
  const score = scorer ?? inlineScorer(d, o);
  const log = o.log ?? (() => {});
  const seen = new Map<string, number>();
  const assets = d.inputs;
  const evalAll = async (xs: Token[][]): Promise<Ind[]> => {
    const fresh = [...new Map(xs.map((t) => [t.join(' '), t])).entries()].filter(([k]) => !seen.has(k));
    const got = fresh.length ? await score(fresh.map(([, t]) => t)) : [];
    fresh.forEach(([k], i) => seen.set(k, got[i]));
    return xs.map((t) => { const key = t.join(' '); return { t, key, score: seen.get(key)! }; });
  };
  // Ramped half-and-half, plus the seeds (formulas that fit this data's inputs).
  const init: Token[][] = (o.seeds ?? []).filter((t) => fits(t, o) && assetsOf(t).every((a) => assets.includes(a)));
  let guard = 0;
  while (init.length < o.population && guard++ < o.population * 20) {
    const t = randomTree(r, assets, o.initDepth[0], o.initDepth[1], init.length % 2 === 0);
    if (fits(t, o)) init.push(t);
  }
  let pop = await evalAll(init);
  const hof = new Map<string, Ind>();
  const updateHof = () => {
    for (const x of pop) if (x.score > -1e6 && !hof.has(x.key)) hof.set(x.key, x);
    const best = [...hof.values()].sort((a, b) => b.score - a.score || a.t.length - b.t.length).slice(0, o.hof);
    hof.clear(); for (const x of best) hof.set(x.key, x);
  };
  const history: GenStats[] = [];
  const stats = (gen: number) => {
    const s = pop.map((x) => x.score).filter((x) => x > -1e6).sort((a, b) => a - b);
    const g = { gen, best: s.length ? s[s.length - 1] : -1e6, median: s.length ? s[Math.floor(s.length / 2)] : -1e6, meanSize: pop.reduce((a, x) => a + x.t.length, 0) / pop.length, evaluated: seen.size };
    history.push(g);
    log(`[gp] ${d.target} gen ${gen}: best ${g.best.toFixed(3)}, median ${g.median.toFixed(3)}, mean size ${g.meanSize.toFixed(1)}, ${g.evaluated} formulas tried`);
  };
  updateHof(); stats(0);
  const tourn = () => { let best = pop[Math.floor(r() * pop.length)]; for (let k = 1; k < o.tournament; k++) { const c = pop[Math.floor(r() * pop.length)]; if (c.score > best.score) best = c; } return best; };
  for (let gen = 1; gen <= o.generations; gen++) {
    const ranked = [...pop].sort((a, b) => b.score - a.score || a.t.length - b.t.length);
    const elite: Ind[] = [];
    const ek = new Set<string>();
    for (const x of ranked) { if (elite.length >= Math.round(o.elite * o.population)) break; if (!ek.has(x.key)) { ek.add(x.key); elite.push(x); } }
    const kids: Token[][] = [];
    while (kids.length < o.population - elite.length) {
      const p1 = tourn().t, p2 = tourn().t;
      let [c1, c2] = r() < o.pCx ? crossover(p1, p2, r) : [p1.slice(), p2.slice()];
      if (!fits(c1, o)) c1 = p1.slice();
      if (!fits(c2, o)) c2 = p2.slice();
      for (const [c, p] of [[c1, p1], [c2, p2]] as const) {
        let k = c;
        if (r() < o.pMut) { const m = mutate(c, r, assets); k = fits(m, o) ? m : c; }
        if (kids.length < o.population - elite.length) kids.push(k.length ? k : p.slice());
      }
    }
    pop = [...elite, ...(await evalAll(kids))];
    updateHof(); stats(gen);
  }
  return { hof: [...hof.values()], history, evaluated: seen.size };
}

// ---- Champion ------------------------------------------------------------------------------------

export interface GpChampion {
  asset: string; tokens: Token[]; formula: string; inputs: string[]; lookback: number; size: number; depth: number;
  train: SliceStats; val: SliceStats; test: SliceStats;
  /** Buy-and-hold over the test years. */
  buyHoldTest: number;
  /** Test score (the fitness, on the test years: what a challenger must beat). */
  testScore: number;
  /** Probabilistic Sharpe of the test's daily returns against 0, and deflated by `contests`. */
  psr: number; dsr: number; contests: number;
  validated: boolean; why: string;
  evaluated: number; population: number; generations: number; fitness: 'sharpe' | 'return';
  /** The fitness in the video's terms when it is the return: e^(-test return), lower is better. */
  expNegReturn: number;
  history: GenStats[];
  trainedAt: string;
}

export interface GpFile {
  schema: string; generatedAt: string; version: string; bar: '1h'; costBps: number; band: number; fitness: 'sharpe' | 'return';
  champions: Record<string, GpChampion>;
}

const strip = ({ daily: _d, hourly: _h, ...s }: SliceStats & { daily?: number[]; hourly?: Float64Array }): SliceStats => ({ ...s, totalReturn: +s.totalReturn.toFixed(5), sharpe: +s.sharpe.toFixed(4), maxDd: +s.maxDd.toFixed(4), exposure: +s.exposure.toFixed(4), turnover: +s.turnover.toFixed(2) });

/** A formula judged on the data's three splits: stats, test score, and whether it passes the gate. */
export function judge(tokens: Token[], d: GpData, opts: GpOptions, contests = 1): Omit<GpChampion, 'evaluated' | 'population' | 'generations' | 'history' | 'trainedAt' | 'asset' | 'fitness'> {
  const o = withDefaults(opts);
  const held = exposureOf(tokens, d, o.band);
  const tr = backtest(held, d, d.start, d.trainEnd, o.costBps), va = backtest(held, d, d.trainEnd, d.valEnd, o.costBps), te = backtest(held, d, d.valEnd, d.inp.n, o.costBps);
  let bh = 0;
  for (let t = d.valEnd; t < d.inp.n; t++) if (Number.isFinite(d.ret[t])) bh += d.ret[t];
  const psr = te.daily.length >= 3 ? probabilisticSharpe(te.daily, 0) : NaN;
  const dsr = te.daily.length >= 3 ? deflatedSharpe(te.daily, Math.max(1, contests)).probability : NaN;
  // A formula that barely trades has a flat, misleadingly smooth record: the test needs the training's minimum.
  const minTest = Math.max(o.minTrades, minTradesFor(d, o, d.valEnd, d.inp.n));
  const fails = [
    te.trades < minTest ? `${te.trades} test trades (< ${minTest})` : '',
    !(te.sharpe > 0) ? `test Sharpe ${te.sharpe.toFixed(2)} <= 0` : '',
    !(dsr >= o.minPsr) ? `test probabilistic Sharpe ${Number.isFinite(dsr) ? dsr.toFixed(3) : 'n/a'} < ${o.minPsr}${contests > 1 ? ` (deflated by ${contests} contests)` : ''}` : '',
    te.maxDd * 100 > o.maxDdPct ? `test drawdown ${(te.maxDd * 100).toFixed(1)}% > ${o.maxDdPct}%` : '',
    !(va.sharpe > 0) ? `validation Sharpe ${va.sharpe.toFixed(2)} <= 0` : '',
  ].filter(Boolean);
  return {
    tokens, formula: formulaText(tokens), inputs: assetsOf(tokens), lookback: lookbackOf(tokens), size: tokens.length, depth: depthOf(tokens),
    train: strip(tr), val: strip(va), test: strip(te), buyHoldTest: +(Math.exp(bh) - 1).toFixed(5),
    testScore: +scoreOf(te, tokens.length, o, minTest).toFixed(6), psr: +psr.toFixed(4), dsr: +dsr.toFixed(4), contests,
    validated: fails.length === 0, why: fails.length ? fails.join('; ') : `test Sharpe ${te.sharpe.toFixed(2)}, return ${(te.totalReturn * 100).toFixed(1)}% (buy-and-hold ${((Math.exp(bh) - 1) * 100).toFixed(1)}%), probabilistic Sharpe ${dsr.toFixed(3)}`,
    expNegReturn: +Math.exp(-te.totalReturn).toFixed(5),
  };
}

/** Evolve a coin's formula and pick its champion (best validation score among the hall of fame). */
export async function evolveChampion(d: GpData, opts: GpOptions, scorer?: Scorer): Promise<GpChampion> {
  const o = withDefaults(opts);
  const ev = await evolve(d, opts, scorer);
  if (!ev.hof.length) throw new Error(`${d.target}: no formula traded enough to score`);
  const minVal = minTradesFor(d, o, d.trainEnd, d.valEnd);
  const byVal = ev.hof.map((x) => ({ x, v: scoreOf(backtest(exposureOf(x.t, d, o.band, d.valEnd), d, d.trainEnd, d.valEnd, o.costBps), x.t.length, o, minVal) }))
    .sort((a, b) => b.v - a.v || a.x.t.length - b.x.t.length);
  const best = byVal[0].x;
  o.log?.(`[gp] ${d.target}: champion by validation ${formulaText(best.t)} (train ${best.score.toFixed(3)}, validation ${byVal[0].v.toFixed(3)})`);
  return {
    asset: d.target, ...judge(best.t, d, opts, o.contests ?? 1),
    evaluated: ev.evaluated, population: o.population, generations: o.generations, fitness: o.fitness, history: ev.history, trainedAt: new Date().toISOString(),
  };
}

/**
 * Champion per coin: the candidate's, unless the formula in use scores better on the candidate's test years
 * (then it stays, re-judged on those years). improved = a coin got a strictly better (or its first) formula.
 */
export function mergeChampions(incumbent: GpFile | undefined, candidate: GpFile, rejudge: (asset: string, tokens: Token[], contests: number) => GpChampion | undefined): { file: GpFile; improved: string[]; kept: string[] } {
  const champions: Record<string, GpChampion> = { ...(incumbent?.champions ?? {}) };
  const improved: string[] = [], kept: string[] = [];
  for (const [asset, cand] of Object.entries(candidate.champions)) {
    const inc = incumbent?.champions[asset];
    const contests = (inc?.contests ?? 0) + 1;
    const again = inc ? rejudge(asset, inc.tokens, contests) : undefined;
    if (again && !(cand.testScore > again.testScore)) { champions[asset] = again; kept.push(asset); continue; }
    champions[asset] = { ...cand, contests };
    improved.push(asset);
  }
  return { file: { ...candidate, champions }, improved, kept };
}

// ---- Runner (pipeline and command line) -----------------------------------------------------------

export interface GpJob { dir: string; target: string; inputs: string[]; split: [number, number]; opts: GpOptions; formulas: Token[][] }

/** Evolve every coin's formula; worker threads score the population when workers > 1. */
export async function runGp(o: { dir: string; assets: string[]; cross: string[]; opts: GpOptions; incumbent?: GpFile; log?: (m: string) => void }): Promise<{ file: GpFile; improved: string[]; kept: string[]; skipped: Record<string, string> }> {
  const log = o.log ?? (() => {});
  const opts = withDefaults({ ...o.opts, log });
  const workers = Math.max(1, opts.workers ?? 1);
  const pool = workers > 1 ? new WorkerPool<GpJob, number[]>(workerScript('gpWorker'), workers) : undefined;
  const champions: Record<string, GpChampion> = {};
  const skipped: Record<string, string> = {};
  const datas = new Map<string, GpData>();
  try {
    for (const target of o.assets) {
      const inputs = inputsFor(o.dir, target, o.cross);
      let d: GpData;
      try { d = loadGpData(o.dir, target, inputs, opts.split); } catch (e) { skipped[target] = (e as Error).message; continue; }
      if (d.inp.n - d.start < 24 * 365) { skipped[target] = `only ${((d.inp.n - d.start) / 24).toFixed(0)} days of hourly bars after warm-up (need a year)`; continue; }
      datas.set(target, d);
      const inc = o.incumbent?.champions[target];
      log(`[gp] ${target}: ${d.inp.n - d.start} hourly bars over ${inputs.join(', ')}, train ${new Date(d.inp.ts[d.start]).toISOString().slice(0, 10)}..${new Date(d.inp.ts[d.trainEnd - 1]).toISOString().slice(0, 10)}, validation ..${new Date(d.inp.ts[d.valEnd - 1]).toISOString().slice(0, 10)}, test ..${new Date(d.inp.ts[d.inp.n - 1]).toISOString().slice(0, 10)}; population ${opts.population} x ${opts.generations} generations`);
      const scorer: Scorer | undefined = pool ? async (fs) => {
        const chunk = Math.max(8, Math.ceil(fs.length / (workers * 4)));
        const parts: Promise<number[]>[] = [];
        for (let i = 0; i < fs.length; i += chunk) parts.push(pool.run({ dir: o.dir, target, inputs, split: opts.split, opts: { ...o.opts, log: undefined }, formulas: fs.slice(i, i + chunk) }));
        return (await Promise.all(parts)).flat();
      } : undefined;
      champions[target] = await evolveChampion(d, { ...opts, seeds: inc ? [inc.tokens] : [], contests: (inc?.contests ?? 0) + 1 }, scorer);
      const c = champions[target];
      log(`[gp] ${target}: ${c.formula} | test ${c.test.from}..${c.test.to}: return ${(c.test.totalReturn * 100).toFixed(1)}% (buy-and-hold ${(c.buyHoldTest * 100).toFixed(1)}%), Sharpe ${c.test.sharpe.toFixed(2)}, max drawdown ${(c.test.maxDd * 100).toFixed(1)}%, ${c.test.trades} trades -> ${c.validated ? 'VALIDATED' : `not validated (${c.why})`}`);
    }
  } finally { await pool?.close(); }
  const now = new Date().toISOString();
  const candidate: GpFile = { schema: GP_SCHEMA, generatedAt: now, version: `gp-${now.replace(/[:.]/g, '-')}`, bar: '1h', costBps: opts.costBps, band: opts.band, fitness: opts.fitness, champions };
  const merged = mergeChampions(o.incumbent?.schema === GP_SCHEMA ? o.incumbent : undefined, candidate, (asset, tokens, contests) => {
    const d = datas.get(asset);
    if (!d || !assetsOf(tokens).every((a) => d.inputs.includes(a)) || !isValid(tokens)) return undefined;
    const prev = o.incumbent?.champions[asset];
    return { asset, ...judge(tokens, d, opts, contests), evaluated: prev?.evaluated ?? 0, population: prev?.population ?? 0, generations: prev?.generations ?? 0, fitness: opts.fitness, history: prev?.history ?? [], trainedAt: prev?.trainedAt ?? now };
  });
  for (const a of merged.kept) log(`[gp] ${a}: the formula in use scores at least as well on the new test years: kept (${merged.file.champions[a].formula})`);
  return { ...merged, skipped };
}

export function readGpFile(file: string): GpFile | undefined {
  try { const f = JSON.parse(fs.readFileSync(file, 'utf8')) as GpFile; return f.schema === GP_SCHEMA ? f : undefined; } catch { return undefined; }
}

export function gpSummary(f: GpFile): string[] {
  return Object.values(f.champions).map((c) => `${c.asset} ${c.validated ? 'VALIDATED' : 'not validated'}: ${c.formula} | test ${c.test.from}..${c.test.to} return ${(c.test.totalReturn * 100).toFixed(1)}% vs buy-and-hold ${(c.buyHoldTest * 100).toFixed(1)}%, Sharpe ${c.test.sharpe.toFixed(2)}, max drawdown ${(c.test.maxDd * 100).toFixed(1)}%, ${c.test.trades} trades${c.validated ? '' : ` (${c.why})`}`);
}

async function main() {
  const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const dir = arg('history', 'data/history');
  const list = (s: string) => s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  const out = arg('out', 'data/models/gp_indicators.json');
  const r = await runGp({
    dir, assets: gpAssets(dir, list(arg('assets', ''))), cross: list(arg('cross', 'BTC,ETH')), incumbent: readGpFile(out), log: console.log,
    opts: { population: Number(arg('population', '1000')), generations: Number(arg('generations', '15')), fitness: arg('fitness', 'sharpe') === 'return' ? 'return' : 'sharpe', seed: Number(arg('seed', String(Date.now() % 2 ** 31))), workers: Number(arg('workers', process.env.TRAIN_WORKERS ?? '1')) },
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(r.file));
  for (const l of gpSummary(r.file)) console.log(l);
  for (const [a, why] of Object.entries(r.skipped)) console.log(`${a}: skipped (${why})`);
  console.log(`wrote ${out}`);
}

if (process.argv[1] && /gpIndicators\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });

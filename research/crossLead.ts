// Cross-coin lead-lag study: does a leader coin's move (BTC, ETH) show up in a follower coin over the next 1, 5, 15 or 60
// minutes, beyond what the follower already did? On years of 1-minute spot history (the history replay's binance-1m
// store), walk-forward, so every number is out of sample:
//
//   samples   every h minutes (no overlap): the leader's and the follower's log return over the last h minutes (x_L, x_F),
//             and the follower's log return over the next h minutes (y)
//   fit       on the two years before each quarter: beta, how much the follower moves with the leader in full (from returns
//             over 60 minutes, 240 for the hourly horizon: a beta from the same short span would absorb the lag it is meant
//             to measure), and the catch-up slope a (y on the gap g = beta x_L - x_F, the part of the leader's move the
//             follower has not made yet)
//   test      the next quarter, never seen by its fit: the information coefficient of a*g with y, and the net return of
//             trading the follower in the gap's direction for h minutes after the largest 10% of gaps (perp round trip,
//             research costs: entry and taker exit)
//
// A pair (leader, follower, horizon) is validated (predictive) when the pooled out-of-sample IC has its day-block bootstrap
// lower bound above 0 (one-sided, Bonferroni over every pair and horizon tested) and it was positive in at least 60% of
// the quarters, on 120+ days. It is also "tradable" when the largest gaps paid for their own round trip (lower bound of
// the net return per trade above 0) - reported only: nothing trades the gap on its own. Where it is used, its use must
// pay (bot/ta/crossLead.ts).
//
//   npm run research:cross-lead -- --history data/history [--years 4] [--out data/models/cross_lead.json]

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { seriesEnds } from '../bot/marketdata/historyStore';
import { DEFAULT_COSTS } from '../bot/setups/exits';
import { CL_HORIZONS, CL_LEADERS, CL_SCHEMA, type CrossLeadOos, type CrossLeadPair, type CrossLeadParams } from '../bot/ta/crossLead';

const MIN = 60_000, DAY = 86_400_000;

/** Closes on a 1-minute grid from `from` (NaN where a minute is missing). */
export interface MinuteSeries { from: number; c: Float64Array }

/** One coin's 1-minute closes from a history-store CSV (ts,o,h,l,c,...), from `fromTs` to the file's last bar. */
export async function loadMinuteCloses(file: string, fromTs: number): Promise<MinuteSeries | undefined> {
  const ends = seriesEnds(file);
  if (!ends) return undefined;
  const from = Math.ceil(fromTs / MIN) * MIN;
  const n = Math.floor((ends.lastTs - from) / MIN) + 1;
  if (n <= 0) return undefined;
  const c = new Float64Array(n).fill(NaN);
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  for await (const line of rl) {
    const k = line.indexOf(',');
    if (k <= 0) continue;
    const ts = Number(line.slice(0, k));
    if (!(ts >= from)) continue;
    const i = (ts - from) / MIN;
    if (!Number.isInteger(i) || i >= n) continue;
    // ts,o,h,l,c,...: the close is the 5th field (after the 4th comma).
    let p = k, f = 1;
    while (f < 4 && p >= 0) { p = line.indexOf(',', p + 1); f++; }
    const end = line.indexOf(',', p + 1);
    const close = Number(line.slice(p + 1, end < 0 ? undefined : end));
    if (close > 0) c[i] = close;
  }
  return { from, c };
}

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** One-sided standard normal quantile (Acklam's approximation). */
export function normQ(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const lo = 0.02425;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - lo) return -normQ(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export interface CrossLeadOpts {
  horizons?: readonly number[]; leaders?: string[];
  /** Round trip charged to a trade on the gap (bps); default the setups' entry + taker exit. */
  costBps?: number;
  /** Days before the first test quarter; days each fit looks back. */
  firstFitDays?: number; trainDays?: number;
  minDays?: number; minTrades?: number; boots?: number; seed?: number;
  log?: (m: string) => void;
}

interface Samples { n: number; xl: Float64Array; xf: Float64Array; y: Float64Array; t: Float64Array }

/** Non-overlapping samples of a pair at horizon h (both coins on the same minute grid). */
export function pairSamples(L: MinuteSeries, F: MinuteSeries, h: number): Samples {
  const off = Math.round((F.from - L.from) / MIN);
  const n = Math.min(L.c.length, F.c.length + off);
  const cap = Math.max(0, Math.floor(n / h));
  const s: Samples = { n: 0, xl: new Float64Array(cap), xf: new Float64Array(cap), y: new Float64Array(cap), t: new Float64Array(cap) };
  const at = (i: number) => (i - off >= 0 && i - off < F.c.length ? F.c[i - off] : NaN);
  // Aligned to multiples of h from the epoch (h = 15 / 60: the 15-minute / hourly closes the setups read).
  const first = Math.ceil((L.from / MIN + h) / h) * h - L.from / MIN;
  for (let i = first; i + h < n; i += h) {
    const l0 = L.c[i - h], l1 = L.c[i], f0 = at(i - h), f1 = at(i), f2 = at(i + h);
    if (!(l0 > 0 && l1 > 0 && f0 > 0 && f1 > 0 && f2 > 0)) continue;
    const xl = Math.log(l1 / l0), xf = Math.log(f1 / f0), y = Math.log(f2 / f1);
    if (Math.abs(xl) > 0.3 || Math.abs(xf) > 0.3 || Math.abs(y) > 0.3) continue; // a bad print, not a market move
    s.xl[s.n] = xl; s.xf[s.n] = xf; s.y[s.n] = y; s.t[s.n] = L.from + i * MIN; s.n++;
  }
  return s;
}

/** The span beta is measured over for horizon h (minutes): long enough for the follower's lag to have played out. */
export const betaSpan = (h: number) => Math.max(60, 4 * h);

/** beta (from the long-span samples `b` in [j0, j1)), a and the |gap| threshold (90th percentile) on samples [i0, i1). */
export function fitPair(s: Samples, i0: number, i1: number, b: Samples, j0: number, j1: number): { beta: number; a: number; thr: number } | undefined {
  let ll = 0, lf = 0;
  for (let j = j0; j < j1; j++) { ll += b.xl[j] * b.xl[j]; lf += b.xl[j] * b.xf[j]; }
  if (!(ll > 0) || i1 - i0 < 100) return undefined;
  const beta = lf / ll;
  let gy = 0, gg = 0;
  for (let i = i0; i < i1; i++) { const g = beta * s.xl[i] - s.xf[i]; gy += g * s.y[i]; gg += g * g; }
  if (!(gg > 0)) return undefined;
  const step = Math.max(1, Math.floor((i1 - i0) / 20_000));
  const abs: number[] = [];
  for (let i = i0; i < i1; i += step) abs.push(Math.abs(beta * s.xl[i] - s.xf[i]));
  abs.sort((x, y) => x - y);
  return { beta, a: gy / gg, thr: abs[Math.floor(0.9 * (abs.length - 1))] ?? Infinity };
}

const lowerIdx = (n: number, alpha: number) => Math.max(0, Math.min(n - 1, Math.floor(alpha * n)));

/** Walk-forward test of one pair at one horizon. */
export function testPair(leader: string, follower: string, h: number, s: Samples, bs: Samples, o: Required<Pick<CrossLeadOpts, 'costBps' | 'firstFitDays' | 'trainDays' | 'minDays' | 'minTrades' | 'boots' | 'seed'>> & { tests: number }): CrossLeadPair | undefined {
  if (s.n < 1000 || bs.n < 100) return undefined;
  const lowerOf = (x: Samples, lo: number) => { let a = 0, b = x.n; while (a < b) { const m = (a + b) >> 1; if (x.t[m] < lo) a = m + 1; else b = m; } return a; };
  const lowerB = (lo: number) => lowerOf(s, lo), lowerL = (lo: number) => lowerOf(bs, lo);
  const fitOn = (from: number, to: number) => fitPair(s, lowerB(from), lowerB(to), bs, lowerL(from), lowerL(to));
  const t0 = s.t[0], tEnd = s.t[s.n - 1] + h * MIN;
  // Quarter boundaries (calendar quarters) from the first full year on.
  const qs: number[] = [];
  { const d = new Date(t0 + o.firstFitDays * DAY); let q = Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3 + 3, 1); while (q < tEnd) { qs.push(q); const x = new Date(q); q = Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 3, 1); } }
  if (!qs.length) return undefined;
  const day0 = Math.floor(qs[0] / DAY), nd = Math.ceil(tEnd / DAY) - day0 + 1;
  const PY = new Float64Array(nd), PP = new Float64Array(nd), YY = new Float64Array(nd), PNL = new Float64Array(nd), TR = new Float64Array(nd);
  const walk: CrossLeadPair['walk'] = [];
  let quarters = 0, quartersUp = 0;
  const cost = o.costBps / 1e4;
  for (let q = 0; q < qs.length; q++) {
    const from = qs[q], to = q + 1 < qs.length ? qs[q + 1] : tEnd;
    const fit = fitOn(from - o.trainDays * DAY, from);
    if (!fit) continue;
    walk.push([from, to, fit.beta, fit.a]);
    let py = 0;
    for (let i = lowerB(from), e = lowerB(to); i < e; i++) {
      const g = fit.beta * s.xl[i] - s.xf[i], p = fit.a * g, y = s.y[i];
      const d = Math.floor(s.t[i] / DAY) - day0;
      PY[d] += p * y; PP[d] += p * p; YY[d] += y * y; py += p * y;
      if (Math.abs(g) > fit.thr && p !== 0) { PNL[d] += Math.sign(p) * y - cost; TR[d] += 1; }
    }
    quarters++;
    if (py > 0) quartersUp++;
  }
  const days: number[] = [];
  for (let d = 0; d < nd; d++) if (PP[d] > 0) days.push(d);
  const sum = (idx: number[]) => { let py = 0, pp = 0, yy = 0, pnl = 0, tr = 0; for (const d of idx) { py += PY[d]; pp += PP[d]; yy += YY[d]; pnl += PNL[d]; tr += TR[d]; } return { ic: pp > 0 && yy > 0 ? py / Math.sqrt(pp * yy) : 0, net: tr > 0 ? pnl / tr : 0, tr }; };
  const all = sum(days);
  const r = rng(o.seed + h * 7919 + leader.length * 31 + follower.charCodeAt(0));
  const ics: number[] = [], nets: number[] = [];
  for (let b = 0; b < o.boots && days.length; b++) {
    const idx = Array.from({ length: days.length }, () => days[Math.floor(r() * days.length)]);
    const x = sum(idx); ics.push(x.ic); nets.push(x.net);
  }
  ics.sort((x, y) => x - y); nets.sort((x, y) => x - y);
  const alpha = 0.05 / Math.max(1, o.tests);
  // A bootstrap this small cannot reach a tail of 0.05 / tests: past it, the normal approximation of the same spread.
  const lowerBound = (xs: number[], mid: number) => { if (!xs.length) return -Infinity; if (alpha * xs.length >= 5) return xs[lowerIdx(xs.length, alpha)]; const m = xs.reduce((a, b) => a + b, 0) / xs.length; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)); return mid + normQ(alpha) * sd; };
  const icLo = lowerBound(ics, all.ic), netLo = lowerBound(nets, all.net);
  const oos: CrossLeadOos = { ic: all.ic, icLo, netBps: all.net * 1e4, netLo: netLo * 1e4, trades: all.tr, days: days.length, quartersUp, quarters };
  const enough = days.length >= o.minDays;
  const validated = enough && icLo > 0 && quartersUp >= 0.6 * quarters;
  const tradable = validated && all.tr >= o.minTrades && netLo > 0;
  const why = !enough ? `only ${days.length} out-of-sample days (< ${o.minDays})`
    : validated ? `IC ${all.ic.toFixed(4)} (lower bound ${icLo.toFixed(4)} > 0), positive in ${quartersUp} of ${quarters} quarters; the largest gaps net ${(all.net * 1e4).toFixed(1)} bps a trade after ${o.costBps.toFixed(0)} bps (lower bound ${(netLo * 1e4).toFixed(1)})${tradable ? ': tradable on its own' : ''}`
    : `IC ${all.ic.toFixed(4)}, lower bound ${icLo.toFixed(4)}${icLo > 0 ? `, but positive in only ${quartersUp} of ${quarters} quarters` : ' <= 0'}`;
  const last = fitOn(tEnd - o.trainDays * DAY, Infinity);
  if (!last) return undefined;
  return { leader, follower, h, beta: last.beta, a: last.a, walk, validated, tradable, why, oos };
}

/** Every leader -> follower pair at every horizon. */
export function studyCrossLead(series: Map<string, MinuteSeries>, o: CrossLeadOpts = {}): CrossLeadParams {
  const log = o.log ?? (() => {});
  const horizons = o.horizons ?? CL_HORIZONS;
  const leaders = (o.leaders ?? CL_LEADERS).filter((a) => series.has(a));
  const pairs: Array<[string, string]> = [];
  for (const L of leaders) for (const F of series.keys()) if (F !== L) pairs.push([L, F]);
  const tests = pairs.length * horizons.length;
  const opts = { costBps: o.costBps ?? (DEFAULT_COSTS.entry + DEFAULT_COSTS.takerExit) * 1e4, firstFitDays: o.firstFitDays ?? 365, trainDays: o.trainDays ?? 730, minDays: o.minDays ?? 120, minTrades: o.minTrades ?? 200, boots: o.boots ?? 400, seed: o.seed ?? 1, tests };
  const out: CrossLeadPair[] = [];
  let from = Infinity, to = 0;
  for (const [L, F] of pairs) for (const h of horizons) {
    const s = pairSamples(series.get(L)!, series.get(F)!, h);
    if (s.n) { from = Math.min(from, s.t[0]); to = Math.max(to, s.t[s.n - 1] + h * MIN); }
    const p = testPair(L, F, h, s, pairSamples(series.get(L)!, series.get(F)!, betaSpan(h)), opts);
    if (!p) { log(`[cross-lead] ${L} -> ${F} ${h}m: not enough samples (${s.n})`); continue; }
    out.push(p);
    log(`[cross-lead] ${L} -> ${F} ${h}m: ${p.validated ? 'VALIDATED' : 'not validated'} (${p.why})`);
  }
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { schema: CL_SCHEMA, version: `cl-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`, at: new Date().toISOString(), from: Number.isFinite(from) ? iso(from) : '', to, costBps: opts.costBps, tests, pairs: out };
}

/** The study from a history folder's 1-minute spot store (binance-1m), the last `years` years. */
export async function trainCrossLead(hist: string, o: CrossLeadOpts & { assets?: string[]; years?: number; now?: number } = {}): Promise<CrossLeadParams> {
  const log = o.log ?? console.log;
  const dir = path.join(hist, 'binance-1m');
  const assets = o.assets ?? (fs.existsSync(dir) ? fs.readdirSync(dir).filter((a) => fs.existsSync(path.join(dir, a, '1m.csv'))) : []);
  if (assets.length < 2 || !assets.some((a) => CL_LEADERS.includes(a))) throw new Error(`cross-coin lead-lag needs 1-minute spot history of BTC or ETH and another coin in ${dir} (the history step downloads it with HISTORY_REPLAY=true)`);
  const fromTs = (o.now ?? Date.now()) - (o.years ?? 4) * 365 * DAY;
  const series = new Map<string, MinuteSeries>();
  const t0 = Date.now();
  for (const a of assets) { const s = await loadMinuteCloses(path.join(dir, a, '1m.csv'), fromTs); if (s) series.set(a, s); }
  log(`[cross-lead] 1-minute closes of ${[...series.keys()].join(', ')} loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return studyCrossLead(series, { ...o, log });
}

export async function crossLeadMain(): Promise<void> {
  const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
  const out = arg('out', 'data/models/cross_lead.json');
  const p = await trainCrossLead(arg('history', 'data/history'), { years: Number(arg('years', '4')) });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(p));
  console.log(JSON.stringify({ out, from: p.from, tests: p.tests, validated: p.pairs.filter((x) => x.validated).map((x) => `${x.leader}->${x.follower} ${x.h}m`), tradable: p.pairs.filter((x) => x.tradable).map((x) => `${x.leader}->${x.follower} ${x.h}m`) }, null, 2));
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) crossLeadMain().catch((e) => { console.error(e); process.exitCode = 1; });

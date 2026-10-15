// Does Coinbase spot lead the Kalshi perp? (the 4th-generation spec's 5.2, as reviewed: measure it before building on it.)
//
// From the recordings (real prints only, never history-replay events): each coin's Coinbase spot price ('spot') and
// its Kalshi perp mid ('perp', (bid + ask) / 2) on a one-second grid, carried forward from the last print while it is
// fresh. Then:
//
//   cross-correlation   corr(spot return in second s, perp return in second s + L) for L = -60..60 s. Spot leads when
//                       the correlations at positive lags (spot first) are positive and larger than at negative lags.
//   lead score          the sum of those correlations over ten lags starting at the perp's own update interval (lags
//                       shorter than that are the polling of the perp feed, PERPS_POLL_MS, not the market), against
//                       the same sum the other way round, each with an hour-block bootstrap 95% interval
//   the gap             measured only at seconds when the perp quote is fresh (a print in the last second), so a stale
//                       poll catching up is not counted: is the gap between spot's and the perp's return over the last
//                       w seconds followed by the perp closing it over the next L seconds? Slope with its bootstrap
//                       interval, and the tradeable size: the perp's mean move (bps) in the gap's direction after the
//                       largest 10% of gaps, against the cost of trading it (w in 5 / 15 / 30 s, L in 5 / 15 / 30 / 60 s,
//                       sampled every 5 s). A latency artifact leaves gaps too small to pay for themselves.
//
// Verdict: "spot leads" only when the lead score's lower bound is above 0 and above the reverse score, and at least
// one big-gap move has its lower bound above the cost (PERP maker fee both ways by default). The spotPullback setups
// are built on this verdict, never ahead of it.
//
//   npm run research:lead-lag -- --recordings data/recordings [--out data/models/lead_lag.json]

import fs from 'fs';
import path from 'path';
import { readRecordings } from './replay';

const S = 1000;
const HOUR = 3_600_000;

export interface GapFit { w: number; L: number; beta: number; lo: number; hi: number; n: number;
  /** Perp move (bps) in the gap's direction after the largest 10% of gaps, with its bootstrap interval. */
  bigBps: number; bigLo: number; bigHi: number }
export interface LeadLagAsset {
  asset: string;
  /** Seconds where both prices were fresh, and the hours they span. */
  seconds: number; hours: number;
  /** Median time between perp quotes (ms): the poll interval. */
  perpUpdateMs: number;
  /** Cost a big-gap move must clear (bps). */
  costBps: number;
  xcorr: Array<{ lag: number; rho: number }>;
  /** First lag counted in the scores (the perp's update interval, in seconds). */
  fromLag: number;
  lead: { score: number; lo: number; hi: number };
  reverse: { score: number; lo: number; hi: number };
  gaps: GapFit[];
  verdict: 'spot leads' | 'perp leads' | 'no lead' | 'too little data';
  why: string;
}
export interface LeadLagFile { schema: 'leadlag1'; at: string; days: string[]; assets: Record<string, LeadLagAsset> }

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Prices on a one-second grid: the last print at or before each second, NaN when older than `staleMs`; and its age (ms). */
export function secondGrid(prints: Array<[number, number]>, from: number, to: number, staleMs: number): { v: Float64Array; age: Float64Array } {
  const n = Math.max(0, Math.floor((to - from) / S));
  const v = new Float64Array(n).fill(NaN), age = new Float64Array(n).fill(Infinity);
  let j = 0, last = NaN, lastTs = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = from + i * S;
    while (j < prints.length && prints[j][0] <= t) { last = prints[j][1]; lastTs = prints[j][0]; j++; }
    age[i] = t - lastTs;
    v[i] = age[i] <= staleMs ? last : NaN;
  }
  return { v, age };
}

const logRet = (p: Float64Array) => { const r = new Float64Array(p.length).fill(NaN); for (let i = 1; i < p.length; i++) if (p[i] > 0 && p[i - 1] > 0) r[i] = Math.log(p[i] / p[i - 1]); return r; };

/** Per-hour cross moments for a set of lags: sum x(s) y(s + L), and sum x^2, y^2 over the pairs used. */
function hourMoments(x: Float64Array, y: Float64Array, lags: number[], hourOf: (i: number) => number): Map<number, { xy: number; xx: number; yy: number }> {
  const m = new Map<number, { xy: number; xx: number; yy: number }>();
  for (const L of lags) for (let i = Math.max(0, -L); i < x.length && i + L < y.length; i++) {
    const a = x[i], b = y[i + L];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const h = hourOf(i);
    const e = m.get(h) ?? { xy: 0, xx: 0, yy: 0 };
    e.xy += a * b; e.xx += a * a; e.yy += b * b;
    m.set(h, e);
  }
  return m;
}

/** Sum of correlations over `lags` (as one pooled correlation x the number of lags) with an hour-block bootstrap. */
function score(x: Float64Array, y: Float64Array, lags: number[], hourOf: (i: number) => number, seed: number): { score: number; lo: number; hi: number } {
  const blocks = [...hourMoments(x, y, lags, hourOf).values()];
  const pooled = (bs: typeof blocks) => { let xy = 0, xx = 0, yy = 0; for (const b of bs) { xy += b.xy; xx += b.xx; yy += b.yy; } return xx > 0 && yy > 0 ? (lags.length * xy) / Math.sqrt(xx * yy) : 0; };
  const s = pooled(blocks);
  if (blocks.length < 10) return { score: s, lo: NaN, hi: NaN };
  const r = rng(seed), vals: number[] = [];
  for (let it = 0; it < 500; it++) { const bs: typeof blocks = []; for (let k = 0; k < blocks.length; k++) bs.push(blocks[Math.floor(r() * blocks.length)]); vals.push(pooled(bs)); }
  vals.sort((a, b) => a - b);
  return { score: s, lo: vals[Math.floor(0.025 * vals.length)], hi: vals[Math.floor(0.975 * vals.length)] };
}

/** At fresh perp quotes: does the gap between spot's and the perp's last-w-second returns predict the perp's next-L-second
 *  return, and by how much after the largest gaps? */
function gapFit(sp: Float64Array, pp: Float64Array, pAge: Float64Array, w: number, L: number, hourOf: (i: number) => number, seed: number): GapFit {
  const pts: Array<{ g: number; y: number; h: number }> = [];
  for (let i = w; i + L < pp.length; i += 5) {
    let k = i;
    while (k < i + 5 && k + L < pp.length && !(pAge[k] < S)) k++;
    if (!(pAge[k] < S) || k + L >= pp.length) continue;
    const g = Math.log(sp[k] / sp[k - w]) - Math.log(pp[k] / pp[k - w]);
    const y = Math.log(pp[k + L] / pp[k]);
    if (Number.isFinite(g) && Number.isFinite(y)) pts.push({ g, y, h: hourOf(k) });
  }
  const absG = pts.map((p) => Math.abs(p.g)).sort((a, b) => a - b);
  const cut = absG.length ? absG[Math.floor(0.9 * absG.length)] : Infinity;
  const byHour = new Map<number, { sxy: number; sxx: number; n: number; big: number; nb: number }>();
  for (const p of pts) {
    const e = byHour.get(p.h) ?? { sxy: 0, sxx: 0, n: 0, big: 0, nb: 0 };
    e.sxy += p.g * p.y; e.sxx += p.g * p.g; e.n++;
    if (Math.abs(p.g) >= cut && p.g !== 0) { e.big += Math.sign(p.g) * p.y * 1e4; e.nb++; }
    byHour.set(p.h, e);
  }
  const blocks = [...byHour.values()];
  const stat = (bs: typeof blocks) => { let a = 0, b = 0, c = 0, d = 0; for (const x of bs) { a += x.sxy; b += x.sxx; c += x.big; d += x.nb; } return { beta: b > 0 ? a / b : 0, big: d > 0 ? c / d : NaN }; };
  const all = stat(blocks), n = pts.length;
  if (blocks.length < 10) return { w, L, beta: all.beta, lo: NaN, hi: NaN, n, bigBps: all.big, bigLo: NaN, bigHi: NaN };
  const r = rng(seed), betas: number[] = [], bigs: number[] = [];
  for (let it = 0; it < 500; it++) { const bs: typeof blocks = []; for (let k = 0; k < blocks.length; k++) bs.push(blocks[Math.floor(r() * blocks.length)]); const x = stat(bs); betas.push(x.beta); if (Number.isFinite(x.big)) bigs.push(x.big); }
  betas.sort((a, b) => a - b); bigs.sort((a, b) => a - b);
  const q = (v: number[], p: number) => (v.length ? v[Math.floor(p * v.length)] : NaN);
  return { w, L, beta: all.beta, lo: q(betas, 0.025), hi: q(betas, 0.975), n, bigBps: all.big, bigLo: q(bigs, 0.025), bigHi: q(bigs, 0.975) };
}

/** The study for one coin from its spot prints and perp mids ([ts ms, price], in time order). */
export function leadLag(asset: string, spot: Array<[number, number]>, perp: Array<[number, number]>, o: { maxLag?: number; minHours?: number; staleMs?: number; costBps?: number } = {}): LeadLagAsset {
  const maxLag = o.maxLag ?? 60, costBps = o.costBps ?? 10;
  const gaps = perp.slice(1).map((p, i) => p[0] - perp[i][0]).filter((g) => g > 0).sort((a, b) => a - b);
  const perpUpdateMs = gaps.length ? gaps[Math.floor(gaps.length / 2)] : NaN;
  const empty = (why: string): LeadLagAsset => ({ asset, seconds: 0, hours: 0, perpUpdateMs, costBps, xcorr: [], fromLag: 1, lead: { score: NaN, lo: NaN, hi: NaN }, reverse: { score: NaN, lo: NaN, hi: NaN }, gaps: [], verdict: 'too little data', why });
  if (spot.length < 100 || perp.length < 100) return empty(`${spot.length} spot prints, ${perp.length} perp quotes`);
  const from = Math.ceil(Math.max(spot[0][0], perp[0][0]) / S) * S, to = Math.min(spot[spot.length - 1][0], perp[perp.length - 1][0]);
  const stale = o.staleMs ?? Math.max(10_000, 3 * (perpUpdateMs || 2000));
  const sp = secondGrid(spot, from, to, stale).v, pg = secondGrid(perp, from, to, stale), pp = pg.v;
  const rs = logRet(sp), rp = logRet(pp);
  const hourOf = (i: number) => Math.floor((from + i * S) / HOUR);
  let both = 0;
  const hours = new Set<number>();
  for (let i = 0; i < rs.length; i++) if (Number.isFinite(rs[i]) && Number.isFinite(rp[i])) { both++; hours.add(hourOf(i)); }
  if (hours.size < (o.minHours ?? 24)) return { ...empty(`${hours.size} hour(s) with both prices fresh, need ${o.minHours ?? 24}`), seconds: both, hours: hours.size };
  // Pooled correlation per lag.
  const xcorr: Array<{ lag: number; rho: number }> = [];
  for (let L = -maxLag; L <= maxLag; L++) {
    let xy = 0, xx = 0, yy = 0;
    for (let i = Math.max(0, -L); i < rs.length && i + L < rp.length; i++) { const a = rs[i], b = rp[i + L]; if (!Number.isFinite(a) || !Number.isFinite(b)) continue; xy += a * b; xx += a * a; yy += b * b; }
    xcorr.push({ lag: L, rho: xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0 });
  }
  // Lags within two poll intervals are the perp feed's staleness, not the market.
  const fromLag = Math.max(1, Math.ceil((2 * (Number.isFinite(perpUpdateMs) ? perpUpdateMs : 1000)) / S));
  const lags = Array.from({ length: 10 }, (_, k) => fromLag + k).filter((L) => L <= maxLag);
  const lead = score(rs, rp, lags, hourOf, 11), reverse = score(rs, rp, lags.map((L) => -L), hourOf, 12);
  const gapFits: GapFit[] = [];
  for (const w of [5, 15, 30]) for (const L of [5, 15, 30, 60]) gapFits.push(gapFit(sp, pp, pg.age, w, L, hourOf, 13 + w + L));
  const tradeable = gapFits.filter((g) => g.bigLo > costBps);
  const best = [...gapFits].sort((a, b) => (Number.isFinite(b.bigLo) ? b.bigLo : -Infinity) - (Number.isFinite(a.bigLo) ? a.bigLo : -Infinity))[0];
  const verdict: LeadLagAsset['verdict'] = lead.lo > 0 && lead.score > reverse.score && tradeable.length ? 'spot leads'
    : reverse.lo > 0 && reverse.score > lead.score ? 'perp leads' : 'no lead';
  const why = `lead ${lead.score.toFixed(3)} [${lead.lo.toFixed(3)}, ${lead.hi.toFixed(3)}] vs reverse ${reverse.score.toFixed(3)} [${reverse.lo.toFixed(3)}, ${reverse.hi.toFixed(3)}] over lags ${lags[0]}-${lags[lags.length - 1]} s`
    + `; best gap w ${best?.w}s -> L ${best?.L}s: slope ${best?.beta.toFixed(3)}, the perp moves ${best?.bigBps.toFixed(1)} bps [${best?.bigLo.toFixed(1)}, ${best?.bigHi.toFixed(1)}] after the largest 10% of gaps (cost ${costBps} bps); perp quotes every ${Number.isFinite(perpUpdateMs) ? (perpUpdateMs / 1000).toFixed(1) : '?'} s`;
  return { asset, seconds: both, hours: hours.size, perpUpdateMs, costBps, xcorr, fromLag, lead, reverse, gaps: gapFits, verdict, why };
}

/** The study over every coin with both feeds in the recordings. */
export async function leadLagStudy(recDir: string, o: { fromDay?: string; toDay?: string; log?: (m: string) => void } = {}): Promise<LeadLagFile> {
  const log = o.log ?? console.log;
  const spot = new Map<string, Array<[number, number]>>(), perp = new Map<string, Array<[number, number]>>();
  const days = new Set<string>();
  for await (const e of readRecordings(recDir, '', o.fromDay, o.toDay)) {
    if (e.hist) continue;
    if (e.k === 'spot' && e.value > 0) { const ts = e.ts ?? e.t; (spot.get(e.asset) ?? spot.set(e.asset, []).get(e.asset)!).push([ts, e.value]); days.add(new Date(ts).toISOString().slice(0, 10)); }
    else if (e.k === 'perp' && e.asset && e.bid > 0 && e.ask > 0 && e.ask >= e.bid) (perp.get(e.asset) ?? perp.set(e.asset, []).get(e.asset)!).push([e.ts ?? e.t, (e.bid + e.ask) / 2]);
  }
  const assets: Record<string, LeadLagAsset> = {};
  for (const a of [...spot.keys()].filter((k) => perp.has(k)).sort()) {
    const s = spot.get(a)!.sort((x, y) => x[0] - y[0]), p = perp.get(a)!.sort((x, y) => x[0] - y[0]);
    assets[a] = leadLag(a, s, p);
    log(`[lead-lag] ${a}: ${assets[a].verdict} (${assets[a].why})`);
  }
  return { schema: 'leadlag1', at: new Date().toISOString(), days: [...days].sort(), assets };
}

/** Coins where spot leads by the latest study (none without a study). */
export function spotLeads(file: string): string[] {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')) as LeadLagFile; return j.schema === 'leadlag1' ? Object.values(j.assets).filter((a) => a.verdict === 'spot leads').map((a) => a.asset) : []; } catch { return []; }
}

async function main(): Promise<void> {
  const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
  const f = await leadLagStudy(arg('recordings', 'data/recordings'), { fromDay: arg('from', '') || undefined, toDay: arg('to', '') || undefined });
  const out = arg('out', '');
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(f)); }
  for (const a of Object.values(f.assets)) console.table(a.xcorr.filter((x) => Math.abs(x.lag) <= 15 || x.lag % 10 === 0).map((x) => ({ asset: a.asset, lag: x.lag, rho: +x.rho.toFixed(4) })));
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error(e); process.exitCode = 1; });

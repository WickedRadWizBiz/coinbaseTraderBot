// The Oracle cull: every TA library reading the TA network and the Librarian read (bot/ta/taNet.ts TANET_FEATURES:
// each indicator on 15m / 1h / 4h / 1d, the rules' tallies, the confluences, the candle patterns, the cross-asset
// and order-flow readings) is tested against the oracle, what paid in hindsight. A reading that tells nothing about
// the hindsight-best strategy on years it was not fitted on is culled: the TA network and the Librarian stop reading
// it.
//
//   oracle      the Librarian's soft oracle label at every LIB_STRIDE_H-th hour of each coin: which strategy family
//               (trend, mean-revert, breakout, flat) earned most over the next day after a round trip, softmaxed in
//               units of the coin's volatility (research/librarian.ts libRows)
//   test        per reading, walk-forward in time: its values cut into quantile bins on the first LIB_FIRST_DAYS of
//               history; each later row is forecast by the mean oracle label of the rows in its bin whose labels had
//               closed before it (smoothed toward the overall mean), against the overall mean alone. The gain is
//               the drop in cross-entropy against the oracle label: what knowing this reading told about the
//               hindsight-best strategy, out of sample
//   verdict     per reading, from its daily mean gains (weekly-block bootstrap):
//                 proven   the gain's p-value passes Benjamini-Hochberg at q over all readings (and the mean is > 0)
//                 kept     mean gain > 0, not proven
//                 culled   mean gain <= 0: the reading forecast the oracle worse than not reading it
//               ORACLE_CULL_LEVEL=unproven culls every reading that is not proven
//   effect      the TA network reads a culled input as zero (research/trainTaNet.ts cullNorm: its normalisation
//               makes it 0 in TypeScript, PyTorch and live; the population keeps the raw statistics, so a reading
//               the next cull keeps comes back) and the Librarian fits and forecasts without it. Both keep their
//               own gates: the TA network's champion contest and the Librarian's grading decide whether the culled
//               model is used
//
//   npm run research:oracle-cull -- --history data/history [--out data/models/oracle_cull.json]

import fs from 'fs';
import path from 'path';
import { LIB_STRATEGIES } from '../bot/ta/librarian';
import { TANET_FEATURES } from '../bot/ta/taNet';
import { storedAssets } from './history/candles';
import { LIB_FIRST_DAYS, libRows, type LibRow } from './librarian';
import { regimeDayLabels } from './transitions';
import { buildDataParallel, type TaNetData } from './trainTaNet';
import { workerCount } from './workerPool';
import { CULL_SCHEMA, type CullItem, type CullLevel, type OracleCullFile } from './cullFile';

export { readCull, CULL_SCHEMA, type OracleCullFile } from './cullFile';

const H = 3_600_000, D = 86_400_000;
const K = LIB_STRATEGIES.length;
const NF = TANET_FEATURES.length;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Quantile edges (unique) of finite values. */
function edgesOf(vals: number[], bins: number): number[] {
  const v = vals.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [];
  const e: number[] = [];
  for (let k = 1; k < bins; k++) e.push(v[Math.min(v.length - 1, Math.floor((k * v.length) / bins))]);
  return [...new Set(e)];
}
/** Bin of a value: 0 = missing, then 1.. by edges. */
const binOf = (x: number, e: number[]) => { if (!Number.isFinite(x)) return 0; let b = 1; for (const t of e) if (x > t) b++; return b; };

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Complementary error function (Numerical Recipes erfcc, |error| < 1.2e-7). */
function erfc(x: number): number {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** Weekly-block bootstrap of daily mean gains: mean, 90% interval, one-sided p-value of mean <= 0. */
export function blockBootstrap(daily: Array<{ day: number; s: number; n: number }>, iters = 400, seed = 5): { mean: number; lo: number; hi: number; p: number } {
  const S = daily.reduce((a, d) => a + d.s, 0), N = daily.reduce((a, d) => a + d.n, 0);
  const mean = N ? S / N : NaN;
  const weeks = new Map<number, { s: number; n: number }>();
  for (const d of daily) { const w = Math.floor(d.day / 7); const e = weeks.get(w) ?? { s: 0, n: 0 }; e.s += d.s; e.n += d.n; weeks.set(w, e); }
  const W = [...weeks.values()];
  if (W.length < 8) return { mean, lo: NaN, hi: NaN, p: 1 };
  const r = rng(seed), ms: number[] = [];
  for (let it = 0; it < iters; it++) {
    let s = 0, n = 0;
    for (let k = 0; k < W.length; k++) { const b = W[Math.floor(r() * W.length)]; s += b.s; n += b.n; }
    ms.push(s / n);
  }
  ms.sort((a, b) => a - b);
  // One-sided p-value from the bootstrap's standard error (normal): resolves the small p-values Benjamini-Hochberg needs
  // over hundreds of readings, which counting resamples at or below zero cannot.
  const mb = ms.reduce((a, v) => a + v, 0) / iters;
  const se = Math.sqrt(ms.reduce((a, v) => a + (v - mb) ** 2, 0) / Math.max(1, iters - 1));
  const p = se > 0 ? 0.5 * erfc(mean / (se * Math.SQRT2)) : mean > 0 ? 0 : 1;
  return { mean, lo: ms[Math.floor(0.05 * iters)], hi: ms[Math.floor(0.95 * iters)], p };
}

/** Benjamini-Hochberg: which p-values pass at q. */
export function bhPass(ps: number[], q: number): boolean[] {
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  let cut = -1;
  order.forEach(([p], k) => { if (p <= ((k + 1) / order.length) * q) cut = k; });
  const out = new Array(ps.length).fill(false);
  for (let k = 0; k <= cut; k++) out[order[k][1]] = true;
  return out;
}

/** The out-of-sample oracle gain of one reading over the rows (sorted by time). */
export function readingGain(values: Float64Array, rows: LibRow[], o: { scoreFrom: number; horizonMs: number; bins?: number; prior?: number }): { daily: Array<{ day: number; s: number; n: number }>; scored: number; covered: number } {
  const bins = o.bins ?? 5, prior = o.prior ?? 30;
  const fitVals: number[] = [];
  for (let i = 0; i < rows.length && rows[i].ts < o.scoreFrom; i++) fitVals.push(values[i]);
  const edges = edgesOf(fitVals, bins);
  const nb = edges.length + 2;
  const sum = new Float64Array(nb * K), cnt = new Float64Array(nb), all = new Float64Array(K);
  let nAll = 0, next = 0;
  const daily = new Map<number, { s: number; n: number }>();
  let scored = 0, covered = 0;
  const pb = new Float64Array(K), pa = new Float64Array(K);
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i].ts;
    // Every row whose label had closed by t joins the statistics (strictly before: no row sees its own outcome).
    while (next < i && rows[next].ts + o.horizonMs <= t) {
      const b = binOf(values[next], edges), y = rows[next].y;
      for (let k = 0; k < K; k++) { sum[b * K + k] += y[k]; all[k] += y[k]; }
      cnt[b]++; nAll++; next++;
    }
    if (t < o.scoreFrom || nAll < 200) continue;
    const b = binOf(values[i], edges), y = rows[i].y;
    let g = 0;
    for (let k = 0; k < K; k++) {
      pa[k] = (all[k] + 1 / K) / (nAll + 1);
      pb[k] = (sum[b * K + k] + prior * pa[k]) / (cnt[b] + prior);
    }
    for (let k = 0; k < K; k++) if (y[k] > 0) g += y[k] * (Math.log(pb[k]) - Math.log(pa[k]));
    const day = Math.floor(t / D), e = daily.get(day) ?? { s: 0, n: 0 };
    e.s += g; e.n++; daily.set(day, e);
    scored++;
    if (b > 0) covered++;
  }
  return { daily: [...daily].map(([day, e]) => ({ day, ...e })), scored, covered };
}

const corr = (a: number[], b: number[]) => {
  const n = a.length;
  if (n < 3) return NaN;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
};

/** Every TA reading against the oracle. */
export function oracleCullOn(Dt: TaNetData, labels: Map<string, Map<string, string>>, o: { level?: CullLevel; q?: number; firstDays?: number; log?: (m: string) => void } = {}): OracleCullFile {
  const log = o.log ?? (() => {});
  const level = o.level ?? 'noise', q = o.q ?? 0.1;
  const rows = libRows(Dt, labels);
  if (rows.length < 2000) throw new Error(`only ${rows.length} labelled rows: the oracle cull needs years of hourly history`);
  const scoreFrom = rows[0].ts + (o.firstDays ?? LIB_FIRST_DAYS) * D;
  if (rows[rows.length - 1].ts < scoreFrom + 180 * D) throw new Error(`the oracle cull needs ${o.firstDays ?? LIB_FIRST_DAYS} days to set its bins plus 180 days to judge on (history ${iso(rows[0].ts)}..${iso(rows[rows.length - 1].ts)})`);
  const pStar = rows.map((r) => r.pos.reduce((s, p, k) => s + r.y[k] * p, 0));
  const vals = new Float64Array(rows.length);
  const items: CullItem[] = [];
  let scoredRows = 0;
  const t0 = Date.now();
  for (let f = 0; f < NF; f++) {
    for (let i = 0; i < rows.length; i++) vals[i] = Dt.assets[rows[i].a].X[rows[i].r * NF + f];
    const g = readingGain(vals, rows, { scoreFrom, horizonMs: 24 * H });
    scoredRows = Math.max(scoredRows, g.scored);
    const bs = blockBootstrap(g.daily, 400, 5 + f);
    const xa: number[] = [], xb: number[] = [];
    for (let i = 0; i < rows.length; i++) if (rows[i].ts >= scoreFrom && Number.isFinite(vals[i])) { xa.push(vals[i]); xb.push(pStar[i]); }
    items.push({ name: TANET_FEATURES[f], gain: bs.mean, lo: bs.lo, hi: bs.hi, p: bs.p, capture: corr(xa, xb), coverage: g.scored ? g.covered / g.scored : 0, verdict: 'kept' });
  }
  const pass = bhPass(items.map((it) => (Number.isFinite(it.gain) && it.gain > 0 ? it.p : 1)), q);
  items.forEach((it, i) => {
    it.verdict = pass[i] ? 'proven' : !(it.gain > 0) || level === 'unproven' ? 'culled' : 'kept';
    for (const k of ['gain', 'lo', 'hi', 'p', 'capture', 'coverage'] as const) it[k] = Number.isFinite(it[k]) ? +it[k].toPrecision(4) : NaN;
  });
  const groups: OracleCullFile['groups'] = {};
  for (const it of items) { const g = it.name.replace(/^(m15|h1|h4|d1)_/, ''); const e = groups[g] ?? { proven: 0, kept: 0, culled: 0 }; e[it.verdict]++; groups[g] = e; }
  const culled = items.filter((x) => x.verdict === 'culled').map((x) => x.name), proven = items.filter((x) => x.verdict === 'proven').map((x) => x.name);
  const days = new Set(rows.filter((r) => r.ts >= scoreFrom).map((r) => Math.floor(r.ts / D))).size;
  log(`[oracle-cull] ${NF} readings against the oracle on ${scoredRows} rows (${days} days, ${iso(scoreFrom)}..${iso(rows[rows.length - 1].ts)}; ${((Date.now() - t0) / 1000).toFixed(0)} s): ${proven.length} proven, ${NF - proven.length - culled.length} kept, ${culled.length} culled (level ${level})`);
  return {
    schema: CULL_SCHEMA, version: `cull-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`, trainedAt: new Date().toISOString(), level, q,
    rows: rows.length, scoredRows, days, from: iso(scoreFrom), to: iso(rows[rows.length - 1].ts),
    culled, proven, items: [...items].sort((a, b) => (b.gain || -1) - (a.gain || -1)), groups,
  };
}

/** One-line summaries for the log. */
export function cullSummary(f: OracleCullFile, top = 8): string[] {
  const best = f.items.filter((x) => x.verdict === 'proven').slice(0, top).map((x) => `${x.name} (${x.gain.toExponential(2)})`);
  const worst = f.items.filter((x) => x.verdict === 'culled').slice(-top).reverse().map((x) => `${x.name} (${Number.isFinite(x.gain) ? x.gain.toExponential(2) : 'n/a'})`);
  const groupsCulled = Object.entries(f.groups).filter(([, g]) => g.culled && !g.proven && !g.kept).map(([k]) => k);
  return [
    `most informative about the oracle: ${best.join(', ') || 'none proven'}`,
    `culled (worse than not reading them): ${worst.join(', ') || 'none'}${f.culled.length > top ? ` and ${f.culled.length - top} more` : ''}`,
    ...(groupsCulled.length ? [`indicators culled on every timeframe: ${groupsCulled.slice(0, 20).join(', ')}${groupsCulled.length > 20 ? ' ...' : ''}`] : []),
  ];
}

export async function trainOracleCull(hist: string, o: { cacheDir?: string; level?: CullLevel; log?: (m: string) => void } = {}): Promise<OracleCullFile> {
  const log = o.log ?? console.log;
  const assets = storedAssets(hist);
  const Dt = await buildDataParallel(hist, assets, o.cacheDir ?? path.join(hist, '.tanet-cache'), log, workerCount());
  if (!Dt.assets.length) throw new Error('no coin has enough hourly and daily history for TA rows');
  const t0 = Math.min(...Dt.assets.map((a) => a.rowTs[0] ?? Infinity)), t1 = Math.max(...Dt.assets.map((a) => a.rowTs[a.rowTs.length - 1] ?? 0)) + D;
  const labels = regimeDayLabels(hist, Dt.assets.map((a) => a.asset), t0, t1, log);
  return oracleCullOn(Dt, labels, { level: o.level, log });
}

export async function oracleCullMain(): Promise<void> {
  const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
  const hist = arg('history', 'data/history'), out = arg('out', 'data/models/oracle_cull.json');
  const f = await trainOracleCull(hist, { level: arg('level', process.env.ORACLE_CULL_LEVEL ?? 'noise') === 'unproven' ? 'unproven' : 'noise' });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(f, null, 1));
  for (const l of cullSummary(f)) console.log(`[oracle-cull] ${l}`);
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) oracleCullMain().catch((e) => { console.error(e); process.exitCode = 1; });

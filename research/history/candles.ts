// Historical OHLCV store for spot USD pairs, fed by CSV imports (Bittrex, Binance, CryptoDataDownload,
// Yahoo, Coinbase) and by the Binance Vision / Coinbase downloaders.
//
// Layout: <dir>/<source>/<ASSET>/<tf>.csv, header `ts,o,h,l,c,v`, one row per bar, ts = bar OPEN
// time in UTC milliseconds, ascending, no duplicates. Every importer converts to this convention;
// a bar stamped with its close time would leak the next bar into training, so the importers also
// run an alignment check against any other source already stored for the same asset.
//
// Reading (loadSeries) splices sources by priority: the best source covers its whole span, and a
// lower-priority source only fills time BEFORE or AFTER what better sources cover, never inside it
// (bar-by-bar mixing of exchanges would create artificial jumps).

import fs from 'fs';
import path from 'path';
import type { Candle } from '../../bot/ta/indicators';
import type { Timeframe } from '../../bot/ta/knowledge';

export type HistTf = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export const HIST_TF_MS: Record<HistTf, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
export const HIST_TFS = Object.keys(HIST_TF_MS) as HistTf[];

/** Splice priority (first = preferred). Coinbase is closest to the CF Benchmarks indices Kalshi settles on. */
export const DEFAULT_SOURCE_PRIORITY = ['coinbase', 'binance', 'bitstamp', 'kraken', 'gemini', 'cdd', 'bittrex', 'yahoo', 'other'];

/** Sources stored but never spliced into spot series (perp futures trade at a basis to spot). */
export const NON_SPOT_SOURCES = new Set(['binance-um']);

export function tfFromMs(ms: number): HistTf | undefined {
  return HIST_TFS.find((t) => HIST_TF_MS[t] === ms);
}

export function seriesPath(dir: string, source: string, asset: string, tf: HistTf): string {
  return path.join(dir, source, asset.toUpperCase(), `${tf}.csv`);
}

export function readSeries(file: string): Candle[] {
  if (!fs.existsSync(file)) return [];
  const out: Candle[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith('ts')) continue;
    const [ts, o, h, l, c, v] = line.split(',').map(Number);
    if (Number.isFinite(ts) && Number.isFinite(c)) out.push({ ts, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  return out;
}

const fmt = (x: number) => (Number.isInteger(x) ? String(x) : String(+x.toPrecision(12)));

export function writeSeries(file: string, cs: Candle[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const lines = ['ts,o,h,l,c,v', ...cs.map((c) => `${c.ts},${fmt(c.o)},${fmt(c.h)},${fmt(c.l)},${fmt(c.c)},${fmt(c.v)}`)];
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`);
  fs.renameSync(tmp, file);
}

/** Union by timestamp; `incoming` wins on conflicts. Sorted ascending. */
export function mergeCandles(existing: Candle[], incoming: Candle[]): Candle[] {
  const m = new Map(existing.map((c) => [c.ts, c]));
  for (const c of incoming) m.set(c.ts, c);
  return [...m.values()].sort((a, b) => a.ts - b.ts);
}

/** Merge `incoming` into the stored series and write it back; returns the stored length. */
export function upsertSeries(dir: string, source: string, asset: string, tf: HistTf, incoming: Candle[]): number {
  const file = seriesPath(dir, source, asset, tf);
  const merged = mergeCandles(readSeries(file), incoming);
  writeSeries(file, merged);
  return merged.length;
}

export interface SeriesInfo { source: string; asset: string; tf: HistTf; file: string }

/** Every stored series (optionally for one asset). */
export function listSeries(dir: string, asset?: string): SeriesInfo[] {
  const out: SeriesInfo[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const source of fs.readdirSync(dir)) {
    const sd = path.join(dir, source);
    if (!fs.statSync(sd).isDirectory()) continue;
    for (const a of fs.readdirSync(sd)) {
      if (asset && a !== asset.toUpperCase()) continue;
      const ad = path.join(sd, a);
      if (!fs.statSync(ad).isDirectory()) continue;
      for (const f of fs.readdirSync(ad)) {
        const tf = /^(\w+)\.csv$/.exec(f)?.[1] as HistTf | undefined;
        if (tf && tf in HIST_TF_MS) out.push({ source, asset: a, tf, file: path.join(ad, f) });
      }
    }
  }
  return out;
}

export function storedAssets(dir: string): string[] {
  return [...new Set(listSeries(dir).filter((s) => !NON_SPOT_SOURCES.has(s.source)).map((s) => s.asset))].sort();
}

const rankOf = (source: string, priority: string[]) => {
  const i = priority.indexOf(source);
  if (i >= 0) return i;
  const j = priority.indexOf(source.split('-')[0]); // cdd-bitstamp -> cdd
  return j >= 0 ? j + 0.5 : priority.length;
};

/** Complete, aligned groups of `ms` built from finer candles (incomplete groups are dropped). */
export function aggregateCandles(cs: Candle[], fromMs: number, ms: number): Candle[] {
  const per = Math.round(ms / fromMs);
  const out: Candle[] = [];
  let i = 0;
  while (i < cs.length) {
    const start = Math.floor(cs[i].ts / ms) * ms;
    let j = i, n = 0, h = -Infinity, l = Infinity, v = 0;
    while (j < cs.length && cs[j].ts < start + ms) { h = Math.max(h, cs[j].h); l = Math.min(l, cs[j].l); v += cs[j].v; n++; j++; }
    if (n === per && cs[i].ts === start) out.push({ ts: start, o: cs[i].o, h, l, c: cs[j - 1].c, v });
    i = j;
  }
  return out;
}

/** Splice: better sources keep their whole span; worse ones only extend it before/after. */
export function spliceSources(parts: Array<{ source: string; candles: Candle[] }>, priority = DEFAULT_SOURCE_PRIORITY): { candles: Candle[]; segments: Array<{ source: string; from: number; to: number; bars: number }> } {
  const sorted = parts.filter((p) => p.candles.length).sort((a, b) => rankOf(a.source, priority) - rankOf(b.source, priority));
  const spans: Array<[number, number]> = [];
  const byTs = new Map<number, Candle>();
  const segments: Array<{ source: string; from: number; to: number; bars: number }> = [];
  for (const p of sorted) {
    const covered = (t: number) => spans.some(([a, b]) => t >= a && t <= b);
    const take = p.candles.filter((c) => !covered(c.ts) && !byTs.has(c.ts));
    for (const c of take) byTs.set(c.ts, c);
    if (take.length) segments.push({ source: p.source, from: take[0].ts, to: take[take.length - 1].ts, bars: take.length });
    spans.push([p.candles[0].ts, p.candles[p.candles.length - 1].ts]);
  }
  return { candles: [...byTs.values()].sort((a, b) => a.ts - b.ts), segments };
}

/** One spot series for (asset, tf): stored sources at that tf, plus each source's finer data
 *  aggregated up (a real file wins over an aggregate from the same source). */
export function loadSeries(dir: string, asset: string, tf: HistTf, priority = DEFAULT_SOURCE_PRIORITY): { candles: Candle[]; segments: Array<{ source: string; from: number; to: number; bars: number }> } {
  const all = listSeries(dir, asset).filter((s) => !NON_SPOT_SOURCES.has(s.source));
  const parts: Array<{ source: string; candles: Candle[] }> = [];
  for (const source of [...new Set(all.map((s) => s.source))]) {
    const mine = all.filter((s) => s.source === source);
    const exact = mine.find((s) => s.tf === tf);
    let cs = exact ? readSeries(exact.file) : [];
    // Fill time the real file does not cover from this source's finer bars.
    const finer = mine.filter((s) => HIST_TF_MS[s.tf] < HIST_TF_MS[tf] && HIST_TF_MS[tf] % HIST_TF_MS[s.tf] === 0).sort((a, b) => HIST_TF_MS[b.tf] - HIST_TF_MS[a.tf]);
    for (const f of finer) {
      const agg = aggregateCandles(readSeries(f.file), HIST_TF_MS[f.tf], HIST_TF_MS[tf]);
      if (!cs.length) { cs = agg; continue; }
      const a = cs[0].ts, b = cs[cs.length - 1].ts;
      cs = mergeCandles(agg.filter((c) => c.ts < a || c.ts > b), cs);
    }
    if (cs.length) parts.push({ source, candles: cs });
  }
  return spliceSources(parts, priority);
}

/** Candles per library timeframe for one asset (1h base plus 4h and 1d; 15m when stored). */
export function loadHistory(dir: string, asset: string, tfs: HistTf[] = ['15m', '1h', '4h', '1d'], priority = DEFAULT_SOURCE_PRIORITY): Partial<Record<Timeframe, Candle[]>> {
  const out: Partial<Record<Timeframe, Candle[]>> = {};
  for (const tf of tfs) { const s = loadSeries(dir, asset, tf, priority).candles; if (s.length) out[tf] = s; }
  return out;
}

// ---- Validation --------------------------------------------------------------------------------

export interface ValidationReport {
  bars: number;
  from: string | null;
  to: string | null;
  dropped: { invalid: number; duplicate: number };
  /** Gaps longer than one bar: count, missing bars, the 5 longest. */
  gaps: { count: number; missingBars: number; longest: Array<{ from: string; to: string; bars: number }> };
  /** Bars whose close-to-close log return exceeds `jumpLimit` (kept, but flagged). */
  jumps: Array<{ ts: string; ret: number }>;
  zeroVolumeBars: number;
  /** Bars whose timestamp is not a multiple of the bar length (stamped mid-bar). */
  misaligned: number;
}

const iso = (t: number) => new Date(t).toISOString();

/** Drop impossible bars and duplicates (first kept), sort, and describe the series. */
export function cleanAndValidate(cs: Candle[], tf: HistTf, jumpLimit = tf === '1d' ? 0.6 : 0.3): { candles: Candle[]; report: ValidationReport } {
  const ms = HIST_TF_MS[tf];
  let invalid = 0, duplicate = 0, misaligned = 0;
  const seen = new Set<number>();
  const ok: Candle[] = [];
  for (const c of [...cs].sort((a, b) => a.ts - b.ts)) {
    const good = [c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x) && x > 0) && c.h >= Math.max(c.o, c.c) * (1 - 1e-9) && c.l <= Math.min(c.o, c.c) * (1 + 1e-9) && Number.isFinite(c.ts);
    if (!good) { invalid++; continue; }
    if (seen.has(c.ts)) { duplicate++; continue; }
    seen.add(c.ts);
    if (c.ts % ms !== 0) misaligned++;
    ok.push({ ...c, v: Number.isFinite(c.v) && c.v >= 0 ? c.v : 0 });
  }
  const gapsList: Array<{ from: number; to: number; bars: number }> = [];
  const jumps: Array<{ ts: string; ret: number }> = [];
  let zeroVolumeBars = 0;
  for (let i = 0; i < ok.length; i++) {
    if (ok[i].v === 0) zeroVolumeBars++;
    if (i === 0) continue;
    const missing = Math.round((ok[i].ts - ok[i - 1].ts) / ms) - 1;
    if (missing > 0) gapsList.push({ from: ok[i - 1].ts + ms, to: ok[i].ts - ms, bars: missing });
    const r = Math.log(ok[i].c / ok[i - 1].c);
    if (Math.abs(r) > jumpLimit) jumps.push({ ts: iso(ok[i].ts), ret: +r.toFixed(4) });
  }
  return {
    candles: ok,
    report: {
      bars: ok.length, from: ok.length ? iso(ok[0].ts) : null, to: ok.length ? iso(ok[ok.length - 1].ts) : null,
      dropped: { invalid, duplicate },
      gaps: { count: gapsList.length, missingBars: gapsList.reduce((s, g) => s + g.bars, 0), longest: [...gapsList].sort((a, b) => b.bars - a.bars).slice(0, 5).map((g) => ({ from: iso(g.from), to: iso(g.to), bars: g.bars })) },
      jumps: jumps.slice(0, 20), zeroVolumeBars, misaligned,
    },
  };
}

// ---- Alignment check ---------------------------------------------------------------------------

export interface AlignmentResult {
  /** Overlapping bars compared. */
  overlap: number;
  /** Correlation of close-to-close returns at each shift (bars): series A shifted by k vs B. */
  corrByShift: Record<string, number>;
  /** Shift with the highest correlation; 0 = aligned. A positive shift means A's bar t matches B's bar t+k. */
  bestShift: number;
  aligned: boolean;
}

/** Compare two series of the same asset and timeframe: a wrong open/close-time convention shows up
 *  as the best return correlation at shift +/-1 instead of 0. */
export function alignmentCheck(a: Candle[], b: Candle[], tf: HistTf, maxShift = 2): AlignmentResult | undefined {
  const ms = HIST_TF_MS[tf];
  const ra = new Map<number, number>(), rb = new Map<number, number>();
  for (let i = 1; i < a.length; i++) if (a[i].ts - a[i - 1].ts === ms) ra.set(a[i].ts, Math.log(a[i].c / a[i - 1].c));
  for (let i = 1; i < b.length; i++) if (b[i].ts - b[i - 1].ts === ms) rb.set(b[i].ts, Math.log(b[i].c / b[i - 1].c));
  const corrByShift: Record<string, number> = {};
  let best = 0, bestC = -Infinity, overlap0 = 0;
  for (let k = -maxShift; k <= maxShift; k++) {
    const xs: number[] = [], ys: number[] = [];
    for (const [t, r] of ra) { const s = rb.get(t + k * ms); if (s !== undefined) { xs.push(r); ys.push(s); } }
    if (k === 0) overlap0 = xs.length;
    if (xs.length < 50) continue;
    const c = corr(xs, ys);
    corrByShift[String(k)] = +c.toFixed(4);
    if (c > bestC) { bestC = c; best = k; }
  }
  if (!Object.keys(corrByShift).length) return undefined;
  return { overlap: overlap0, corrByShift, bestShift: best, aligned: best === 0 };
}

function corr(x: number[], y: number[]): number {
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** Shift every bar by k bars (fix a close-time convention: k = -1 moves close-stamped bars to their open). */
export function shiftCandles(cs: Candle[], tf: HistTf, k: number): Candle[] {
  return k ? cs.map((c) => ({ ...c, ts: c.ts + k * HIST_TF_MS[tf] })) : cs;
}

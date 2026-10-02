// Historical OHLCV store for spot USD pairs, fed by CSV imports (Bittrex, Binance, CryptoDataDownload,
// Yahoo, Coinbase) and by the Binance Vision / Coinbase downloaders. The on-disk layout and the
// generic read / write / splice code live in bot/marketdata/historyStore.ts (the live bot appends its
// own index bars to the same store); this module adds the spot-specific reading and validation.
//
// Layout: <dir>/<source>/<ASSET>/<tf>.csv, header `ts,o,h,l,c,v`, one row per bar, ts = bar OPEN
// time in UTC milliseconds, ascending, no duplicates. Every importer converts to this convention;
// a bar stamped with its close time would leak the next bar into training, so the importers also
// run an alignment check against any other source already stored for the same asset.
//
// Reading (loadSeries) splices sources by priority: the best source covers its whole span, and a
// lower-priority source only fills time BEFORE or AFTER what better sources cover, never inside it
// (bar-by-bar mixing of exchanges would create artificial jumps).

import type { Candle } from '../../bot/ta/indicators';
import type { Timeframe } from '../../bot/ta/knowledge';
import { aggregateCandles, DEFAULT_SOURCE_PRIORITY, HIST_TF_MS, INDEX_SOURCES, listSeries, mergeCandles, readSeries, spliceSources, type HistTf } from '../../bot/marketdata/historyStore';

export {
  aggregateCandles, aggregateIndex, DEFAULT_SOURCE_PRIORITY, HIST_TF_MS, HIST_TFS, INDEX_SOURCE_PRIORITY, INDEX_SOURCES, listSeries, loadIndexSeries, mergeCandles,
  readSeries, seriesPath, spliceSources, storedIndexAssets, tfFromMs, upsertSeries, writeSeries, type HistTf, type SeriesInfo,
} from '../../bot/marketdata/historyStore';

/** Sources stored but never spliced into spot series (perp futures trade at a basis to spot). */
export const NON_SPOT_SOURCES = new Set(['binance-um']);
/** Spot pair sources: everything except perps and the market-wide index series. */
export const isSpotSource = (source: string) => !NON_SPOT_SOURCES.has(source) && !INDEX_SOURCES.has(source);

export function storedAssets(dir: string): string[] {
  return [...new Set(listSeries(dir).filter((s) => isSpotSource(s.source)).map((s) => s.asset))].sort();
}

/** One spot series for (asset, tf): stored sources at that tf, plus each source's finer data
 *  aggregated up (a real file wins over an aggregate from the same source). */
export function loadSeries(dir: string, asset: string, tf: HistTf, priority = DEFAULT_SOURCE_PRIORITY): { candles: Candle[]; segments: Array<{ source: string; from: number; to: number; bars: number }> } {
  const all = listSeries(dir, asset).filter((s) => isSpotSource(s.source));
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
  const spliced = spliceSources(parts, priority);
  // Order flow: a bar from a source without the taker split (Coinbase REST, Bittrex, Yahoo) borrows
  // the taker-buy SHARE of the same bar from any source that has it (tb = v x donor tb / donor v).
  const donors = parts.flatMap((p) => p.candles.filter((c) => c.tb !== undefined && c.v > 0)).reduce((m, c) => (m.has(c.ts) ? m : m.set(c.ts, c.tb! / c.v)), new Map<number, number>());
  if (donors.size) spliced.candles = spliced.candles.map((c) => (c.tb === undefined && donors.has(c.ts) ? { ...c, tb: c.v * donors.get(c.ts)! } : c));
  return spliced;
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
    const v = Number.isFinite(c.v) && c.v >= 0 ? c.v : 0;
    const bar: Candle = { ...c, v };
    if (c.tb !== undefined) { if (Number.isFinite(c.tb) && c.tb >= 0) bar.tb = Math.min(c.tb, v); else delete bar.tb; }
    ok.push(bar);
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

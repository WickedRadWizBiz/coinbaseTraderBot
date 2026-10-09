// The historical candle store on disk, shared by research (importers, downloaders, training) and the
// live bot (which appends its own dominance / index bars and reads them back).
//
// Layout: <dir>/<source>/<ASSET>/<tf>.csv, header `ts,o,h,l,c,v[,tb]`, one row per bar, ts = bar OPEN
// time in UTC milliseconds, ascending, no duplicates.
//
// Two kinds of series live here:
//   - spot USD pairs (research/history/candles.ts loadSeries splices their sources);
//   - market-wide index series (INDEX_SOURCES): TradingView's dominance and total-market-cap charts
//     (BTC.D, USDT.D, TOTAL, TOTAL2, TOTAL3, OTHERS.D), Binance's BTC dominance index (BTCDOM), and
//     the bot's own live-recorded bars of the same. loadIndexSeries reads those.

import fs from 'fs';
import path from 'path';
import type { Candle } from '../ta/indicators';

export type HistTf = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export const HIST_TF_MS: Record<HistTf, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
export const HIST_TFS = Object.keys(HIST_TF_MS) as HistTf[];

/** Splice priority for spot series (first = preferred). Coinbase is closest to the CF Benchmarks indices Kalshi settles on. */
// tvspot: TradingView bars of an exchange's pair (deploy/tv_history.py), fetched only to fill holes.
export const DEFAULT_SOURCE_PRIORITY = ['coinbase', 'binance', 'bitstamp', 'kraken', 'gemini', 'cdd', 'bittrex', 'tvspot', 'yahoo', 'other'];

/** Market-wide index series, never spliced into spot pairs: TradingView's charts (one-off export),
 *  Binance's BTCDOM index (Binance Vision), and the bot's live-recorded bars. */
export const INDEX_SOURCES = new Set(['tradingview', 'binance-index', 'bot-index']);
export const INDEX_SOURCE_PRIORITY = ['tradingview', 'binance-index', 'bot-index'];

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
    const f = line.split(',');
    const [ts, o, h, l, c, v] = f.map(Number);
    if (!Number.isFinite(ts) || !Number.isFinite(c)) continue;
    const bar: Candle = { ts, o, h, l, c, v: Number.isFinite(v) ? v : 0 };
    if (f[6] !== undefined && f[6] !== '' && Number.isFinite(Number(f[6]))) bar.tb = Number(f[6]);
    out.push(bar);
  }
  return out;
}

const fmt = (x: number) => (Number.isInteger(x) ? String(x) : String(+x.toPrecision(12)));

export function writeSeries(file: string, cs: Candle[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const anyTb = cs.some((c) => c.tb !== undefined);
  const lines = [anyTb ? 'ts,o,h,l,c,v,tb' : 'ts,o,h,l,c,v', ...cs.map((c) => `${c.ts},${fmt(c.o)},${fmt(c.h)},${fmt(c.l)},${fmt(c.c)},${fmt(c.v)}${anyTb ? `,${c.tb !== undefined ? fmt(c.tb) : ''}` : ''}`)];
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`);
  fs.renameSync(tmp, file);
}

/** Union by timestamp; `incoming` wins on conflicts. Sorted ascending. */
export function mergeCandles(existing: Candle[], incoming: Candle[]): Candle[] {
  const m = new Map(existing.map((c) => [c.ts, c]));
  for (const c of incoming) m.set(c.ts, c);
  return [...m.values()].sort((a, b) => a.ts - b.ts);
}

/** The header and the last bar's timestamp of a stored series, from its first and last few KB (undefined
 *  when there is no file, or no bar). */
export function seriesEnds(file: string): { header: string; lastTs: number; endsWithNewline: boolean } | undefined {
  if (!fs.existsSync(file)) return undefined;
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return undefined;
    const head = Buffer.alloc(Math.min(256, size));
    fs.readSync(fd, head, 0, head.length, 0);
    const tailLen = Math.min(8192, size), tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    const header = head.toString('utf8').split('\n')[0];
    const lines = tail.toString('utf8').split('\n').filter((l) => l && !l.startsWith('ts'));
    const lastTs = Number(lines[lines.length - 1]?.split(',')[0]);
    return Number.isFinite(lastTs) ? { header, lastTs, endsWithNewline: tail[tailLen - 1] === 10 } : undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** Rows in a stored series (newlines counted in chunks; the file is not parsed). */
function countRows(file: string): number {
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(1 << 20);
  let n = 0, k: number;
  try { while ((k = fs.readSync(fd, buf, 0, buf.length, null)) > 0) for (let i = 0; i < k; i++) if (buf[i] === 10) n++; } finally { fs.closeSync(fd); }
  return Math.max(0, n - 1); // the header
}

/** Merge `incoming` into the stored series and write it back; returns the stored length. When every incoming
 *  bar is newer than the stored series (a download adding the latest days), the bars are appended instead:
 *  rewriting years of 1-minute bars for one new day took half a minute per series. */
export function upsertSeries(dir: string, source: string, asset: string, tf: HistTf, incoming: Candle[]): number {
  const file = seriesPath(dir, source, asset, tf);
  const ends = seriesEnds(file);
  if (ends && incoming.length) {
    const add = mergeCandles([], incoming); // sorted, one bar per timestamp
    const tbCol = ends.header === 'ts,o,h,l,c,v,tb';
    if (add[0].ts > ends.lastTs && (tbCol || !add.some((c) => c.tb !== undefined)) && /^ts,o,h,l,c,v(,tb)?$/.test(ends.header)) {
      const rows = add.map((c) => `${c.ts},${fmt(c.o)},${fmt(c.h)},${fmt(c.l)},${fmt(c.c)},${fmt(c.v)}${tbCol ? `,${c.tb !== undefined ? fmt(c.tb) : ''}` : ''}`);
      fs.appendFileSync(file, `${ends.endsWithNewline ? '' : '\n'}${rows.join('\n')}\n`);
      return countRows(file);
    }
  }
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
    if (n === per && cs[i].ts === start) {
      const g = cs.slice(i, j);
      const tb = g.every((x) => x.tb !== undefined) ? g.reduce((s, x) => s + x.tb!, 0) : undefined;
      out.push({ ts: start, o: cs[i].o, h, l, c: cs[j - 1].c, v, ...(tb !== undefined ? { tb } : {}) });
    }
    i = j;
  }
  return out;
}

/** Aligned groups of `ms` from finer index bars, keeping a group when at least `minShare` of its bars
 *  exist (an index has no volume to lose, and live-recorded bars have gaps while the bot is down). */
export function aggregateIndex(cs: Candle[], fromMs: number, ms: number, minShare = 0.5): Candle[] {
  const per = Math.round(ms / fromMs);
  const out: Candle[] = [];
  let i = 0;
  while (i < cs.length) {
    const start = Math.floor(cs[i].ts / ms) * ms;
    let j = i, h = -Infinity, l = Infinity;
    while (j < cs.length && cs[j].ts < start + ms) { h = Math.max(h, cs[j].h); l = Math.min(l, cs[j].l); j++; }
    if (j - i >= Math.max(1, Math.ceil(per * minShare))) out.push({ ts: start, o: cs[i].o, h, l, c: cs[j - 1].c, v: 0 });
    i = j;
  }
  return out;
}

export type Segment = { source: string; from: number; to: number; bars: number };

/** Sources fetched only to repair missing bars: they fill holes INSIDE better sources' spans too. */
export const GAP_FILL_SOURCES = new Set(['tvspot']);

/** Splice: better sources keep their whole span; worse ones only extend it before/after (gap-fill
 *  sources also fill the missing bars inside it). */
export function spliceSources(parts: Array<{ source: string; candles: Candle[] }>, priority = DEFAULT_SOURCE_PRIORITY): { candles: Candle[]; segments: Segment[] } {
  const sorted = parts.filter((p) => p.candles.length).sort((a, b) => rankOf(a.source, priority) - rankOf(b.source, priority));
  const spans: Array<[number, number]> = [];
  const byTs = new Map<number, Candle>();
  const segments: Segment[] = [];
  for (const p of sorted) {
    const covered = (t: number) => spans.some(([a, b]) => t >= a && t <= b);
    const fill = GAP_FILL_SOURCES.has(p.source);
    const take = p.candles.filter((c) => (fill || !covered(c.ts)) && !byTs.has(c.ts));
    for (const c of take) byTs.set(c.ts, c);
    if (take.length) segments.push({ source: p.source, from: take[0].ts, to: take[take.length - 1].ts, bars: take.length });
    spans.push([p.candles[0].ts, p.candles[p.candles.length - 1].ts]);
  }
  return { candles: [...byTs.values()].sort((a, b) => a.ts - b.ts), segments };
}

/** How closely one source of an index tracks another where both have bars: hourly log-return
 *  correlation and the median level ratio (e.g. the bot's live-built BTCDOM vs Binance's own). */
export function compareIndexSources(dir: string, asset: string, a: string, b: string, tf: HistTf = '1h'): { overlap: number; returnCorr: number; levelRatio: number } {
  const x = new Map(readSeries(seriesPath(dir, a, asset, tf)).map((c) => [c.ts, c.c]));
  const ys = readSeries(seriesPath(dir, b, asset, tf)).filter((c) => x.has(c.ts));
  const ms = HIST_TF_MS[tf];
  const ra: number[] = [], rb: number[] = [], ratios: number[] = [];
  for (let i = 0; i < ys.length; i++) {
    ratios.push(x.get(ys[i].ts)! / ys[i].c);
    if (i > 0 && ys[i].ts - ys[i - 1].ts === ms) { ra.push(Math.log(x.get(ys[i].ts)! / x.get(ys[i - 1].ts)!)); rb.push(Math.log(ys[i].c / ys[i - 1].c)); }
  }
  const mean = (v: number[]) => v.reduce((s, z) => s + z, 0) / Math.max(1, v.length);
  const ma = mean(ra), mb = mean(rb);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < ra.length; i++) { sab += (ra[i] - ma) * (rb[i] - mb); saa += (ra[i] - ma) ** 2; sbb += (rb[i] - mb) ** 2; }
  ratios.sort((p, q) => p - q);
  return { overlap: ys.length, returnCorr: ra.length >= 24 && saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN, levelRatio: ratios.length ? ratios[Math.floor(ratios.length / 2)] : NaN };
}

/** Index assets stored (BTC.D, USDT.D, BTCDOM, ...). */
export function storedIndexAssets(dir: string): string[] {
  return [...new Set(listSeries(dir).filter((s) => INDEX_SOURCES.has(s.source)).map((s) => s.asset))].sort();
}

/**
 * One index series (BTC.D, USDT.D, TOTAL, BTCDOM, ...) at `tf`. Per source: its file at that tf, with
 * the time it does not cover filled from its finer bars (partial groups allowed, see aggregateIndex).
 * Sources are spliced like spot sources (TradingView, then Binance's index, then the bot's own bars),
 * and each lower-priority source is first scaled by the median ratio of closes where it overlaps a
 * better one: the bot's live dominance comes from CoinGecko market caps while TradingView computes its
 * own, so their levels differ slightly and would otherwise jump at the seam.
 */
export function loadIndexSeries(dir: string, asset: string, tf: HistTf, minOverlap = tf === '1d' ? 3 : 24): { candles: Candle[]; segments: Segment[]; scale: Record<string, number> } {
  const all = listSeries(dir, asset).filter((s) => INDEX_SOURCES.has(s.source));
  const parts: Array<{ source: string; candles: Candle[] }> = [];
  for (const source of [...new Set(all.map((s) => s.source))]) {
    const mine = all.filter((s) => s.source === source);
    const exact = mine.find((s) => s.tf === tf);
    let cs = exact ? readSeries(exact.file) : [];
    const finer = mine.filter((s) => HIST_TF_MS[s.tf] < HIST_TF_MS[tf] && HIST_TF_MS[tf] % HIST_TF_MS[s.tf] === 0).sort((a, b) => HIST_TF_MS[b.tf] - HIST_TF_MS[a.tf]);
    for (const f of finer) {
      const agg = aggregateIndex(readSeries(f.file), HIST_TF_MS[f.tf], HIST_TF_MS[tf]);
      if (!cs.length) { cs = agg; continue; }
      const a = cs[0].ts, b = cs[cs.length - 1].ts;
      cs = mergeCandles(agg.filter((c) => c.ts < a || c.ts > b), cs);
    }
    if (cs.length) parts.push({ source, candles: cs });
  }
  parts.sort((a, b) => rankOf(a.source, INDEX_SOURCE_PRIORITY) - rankOf(b.source, INDEX_SOURCE_PRIORITY));
  const scale: Record<string, number> = {};
  const done: Array<{ source: string; candles: Candle[] }> = [];
  for (const p of parts) {
    let k = 1;
    for (const ref of done) {
      const byTs = new Map(ref.candles.map((c) => [c.ts, c.c]));
      const ratios = p.candles.filter((c) => byTs.has(c.ts) && c.c > 0).map((c) => byTs.get(c.ts)! / c.c).sort((x, y) => x - y);
      if (ratios.length >= minOverlap) { k = ratios[Math.floor(ratios.length / 2)]; break; }
    }
    scale[p.source] = k;
    done.push(k === 1 ? p : { source: p.source, candles: p.candles.map((c) => ({ ...c, o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k })) });
  }
  return { ...spliceSources(done, INDEX_SOURCE_PRIORITY), scale };
}

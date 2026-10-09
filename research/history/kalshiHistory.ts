// Kalshi's own market history: settled contracts of the crypto series with their 1-minute candlesticks
// (YES bid / ask OHLC, last price, volume, open interest). Months of real contract prices, far more than
// the bot's own recordings, for research on how the market priced these contracts (calibration of the
// market vs settlement, the model's edge against it, fee-aware entry studies).
//
//   npm run history:kalshi -- --series KXBTC15M,KXETH15M --days 60 --out data/history/kalshi
//
// Kalshi partitions data into live and historical tiers (API docs: "Historical Data"): markets settled
// before GET /historical/cutoff's market_settled_ts are only in GET /historical/markets and their
// candles only in GET /historical/markets/{ticker}/candlesticks; newer settled markets come from
// GET /markets?status=settled and GET /series/{series}/markets/{ticker}/candlesticks. Both are read
// here with cursor pagination, public endpoints only (no key needed). One JSON line per market in
// <out>/<SERIES>/<YYYY-MM-DD>.jsonl (UTC day of close); markets already stored are skipped, so it
// resumes and later runs only add new days.
//
// Cost control (the hourly / daily ladders list ~100,000 settled markets in 60 days, and a request per
// market once filled a whole 5-hour training run): 1-minute candles cover at most the last
// maxCandleMinutes of a market's life (a week of 1-minute candles is more than one request returns:
// HTTP 400); markets that never traded are stored without a request; a market the API rejects for
// good (400, or 404 from both tiers) is stored with its error so it is not asked for again (a plain
// 'HTTP 404' stored by older versions, which asked one tier only, is asked again once); requests run `concurrency`
// at a time; and the whole download stops at budgetMs, the rest waiting for the next run.
//
// Rate limit: every request of a download shares one pace (ratePerSec, 10 a second: half of Kalshi's Basic
// tier of 20 reads a second), so the workers together never outrun it. A 429 pauses all of them at once
// (1 s, 2 s, 4 s ... 30 s, or the server's Retry-After when longer) and the request is tried again; a market
// that still fails is not stored, so the next run asks for it again.

import fs from 'fs';
import path from 'path';
import { TokenBucket } from '../../bot/kalshi/rateLimiter';
import { progress } from '../progress';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number | null => { if (v === null || v === undefined || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };

export interface KalshiCandle { ts: number; bidO: number | null; bidH: number | null; bidL: number | null; bidC: number | null; askO: number | null; askH: number | null; askL: number | null; askC: number | null; last: number | null; volume: number | null; oi: number | null }
export interface KalshiHistMarket {
  ticker: string; series: string; event?: string; openTime: number; closeTime: number; strike: number | null; cap: number | null; strikeType?: string; result?: string; settlement?: number | null; volume?: number | null;
  /** Market title (tennis: the players and the tournament) and the event's start (tennis: the match). */
  title?: string; startTime?: number;
  candles: KalshiCandle[]; noVolume?: boolean; error?: string;
}

/** One candlestick (fixed-point dollar strings, legacy cents tolerated). */
export function parseCandle(c: Record<string, any>): KalshiCandle | undefined {
  const ts = num(c.end_period_ts);
  if (ts === null) return undefined;
  const d = (o: any, k: string) => num(o?.[`${k}_dollars`]) ?? (num(o?.[k]) !== null ? num(o?.[k])! / 100 : null);
  const yb = c.yes_bid ?? {}, ya = c.yes_ask ?? {}, p = c.price ?? {};
  return {
    ts: ts * 1000, bidO: d(yb, 'open'), bidH: d(yb, 'high'), bidL: d(yb, 'low'), bidC: d(yb, 'close'),
    askO: d(ya, 'open'), askH: d(ya, 'high'), askL: d(ya, 'low'), askC: d(ya, 'close'),
    last: d(p, 'close'), volume: num(c.volume_fp ?? c.volume), oi: num(c.open_interest_fp ?? c.open_interest),
  };
}

export function parseHistMarket(m: Record<string, any>, series: string): Omit<KalshiHistMarket, 'candles'> | undefined {
  const openTime = Date.parse(String(m.open_time ?? '')), closeTime = Date.parse(String(m.close_time ?? m.expiration_time ?? ''));
  if (!m.ticker || !Number.isFinite(openTime) || !Number.isFinite(closeTime)) return undefined;
  const start = Date.parse(String(m.occurrence_datetime ?? m.expected_start_time ?? m.event_start_time ?? m.start_time ?? ''));
  return {
    ticker: String(m.ticker), series, event: m.event_ticker, openTime, closeTime, strike: num(m.floor_strike), cap: num(m.cap_strike), strikeType: m.strike_type,
    result: m.result || undefined, settlement: num(m.settlement_value_dollars) ?? num(m.expiration_value), volume: num(m.volume_fp ?? m.volume),
    ...(m.title ? { title: String(m.title) } : {}), ...(Number.isFinite(start) ? { startTime: start } : {}),
  };
}

/** One trade of the tape: [time ms, YES price, contracts, taker side (1 = bought YES, 0 = bought NO)]. */
export type KalshiTrade = [number, number, number, 0 | 1];

/** A trade from GET /markets/trades or /historical/trades (fixed-point dollar strings, legacy cents tolerated). */
export function parseTrade(t: Record<string, any>): KalshiTrade | undefined {
  const ts = Date.parse(String(t.created_time ?? ''));
  const cents = num(t.yes_price);
  const price = num(t.yes_price_dollars) ?? (cents !== null ? (cents > 1 ? cents / 100 : cents) : null);
  const count = num(t.count_fp) ?? num(t.count);
  const side = t.taker_side === 'yes' ? 1 : t.taker_side === 'no' ? 0 : undefined;
  if (!Number.isFinite(ts) || price === null || !(price > 0 && price < 1) || !(count! > 0) || side === undefined) return undefined;
  return [ts, +price.toFixed(4), count!, side];
}

export interface KalshiHistoryOpts {
  baseUrl?: string; series: string[]; days: number; out: string; fetchImpl?: typeof fetch; log?: (m: string) => void; now?: number; maxMarkets?: number;
  /** Stop starting requests after this long (wall clock); the rest is fetched by the next run. */
  budgetMs?: number;
  /** Candle requests in flight at once. */
  concurrency?: number;
  /** Requests a second, shared by every worker (default 10). */
  ratePerSec?: number;
  /** 1-minute candles for at most this many minutes before a market's close. */
  maxCandleMinutes?: number;
  /** Wall clock for the budget (tests). */
  clock?: () => number;
}

export interface KalshiHistoryResult { markets: number; skipped: number; failed: number; noVolume: number; rejected: number; remaining: number; budgetHit: boolean }

class HttpError extends Error { constructor(msg: string, readonly status: number) { super(msg); } }

/** Seconds (or an HTTP date) in a Retry-After header, as milliseconds; 0 when absent. */
export function retryAfterMs(v: string | null | undefined, now = Date.now()): number {
  if (!v) return 0;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : 0;
}

/** GET at a pace shared by every caller (public endpoints, no key): a 429 pauses them all (the bucket),
 *  then this request is tried again, up to 10 times; a 5xx is retried with its own backoff. */
export function getter(baseUrl: string | undefined, f: typeof fetch, ratePerSec = 10): { get: (p: string) => Promise<any>; limited: () => number } {
  const base = (baseUrl ?? 'https://external-api.kalshi.com/trade-api/v2').replace(/\/$/, '');
  const rate = Math.max(0.5, ratePerSec);
  const bucket = new TokenBucket(Math.max(1, Math.round(rate)), rate);
  let limited = 0;
  const get = async (p: string): Promise<any> => {
    let delay = 500;
    for (let attempt = 0; ; attempt++) {
      await bucket.take(1);
      const res = await f(base + p, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) { bucket.ok(); return res.json(); }
      if (res.status === 429 && attempt < 10) { limited++; bucket.rateLimited(retryAfterMs(res.headers?.get?.('retry-after'))); continue; }
      if (res.status >= 500 && attempt < 5) { await sleep(delay); delay *= 2; continue; }
      throw new HttpError(`GET ${p}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, res.status);
    }
  };
  return { get, limited: () => limited };
}

/** A stored market without its candles: what the downloaders need to know a market is already there. */
export interface StoredMarket { ticker: string; openTime: number; closeTime: number; startTime?: number; noVolume?: boolean; error?: string }

/** The stored-market index of a series (<dir>/.index.json): per day file, its size when indexed and its markets
 *  without candles, plus the close-time range a past run listed completely. Re-reading every stored market
 *  with its candles to learn which ones are there took seconds per GB at the start of every run; only day files
 *  whose size changed since (new markets appended, or written by hand) are read again. */
interface SeriesIndex { v: 1; files: Record<string, { size: number; rows: StoredMarket[] }>; listed?: { from: number; to: number } }
const INDEX = '.index.json';

/** A stored line without parsing its candles: the fields before "candles" and the flags after the array. */
function storedOf(line: string): StoredMarket | undefined {
  const at = line.indexOf(',"candles":[');
  try {
    if (at < 0) { const r = JSON.parse(line); return { ticker: r.ticker, openTime: r.openTime, closeTime: r.closeTime, startTime: r.startTime, noVolume: r.noVolume, error: r.error }; }
    const head = JSON.parse(`${line.slice(0, at)}}`);
    const end = line.indexOf(']', at); // candles are objects of numbers: the first ']' closes the array
    const tail = line.slice(end + 1);
    const flags = tail.startsWith(',') ? JSON.parse(`{${tail.slice(1)}`) : {};
    if (!head.ticker) return undefined;
    return { ticker: head.ticker, openTime: head.openTime, closeTime: head.closeTime, ...(head.startTime ? { startTime: head.startTime } : {}), ...(flags.noVolume ? { noVolume: true } : {}), ...(flags.error ? { error: flags.error } : {}) };
  } catch { return undefined; } // torn
}

function readIndex(dir: string): SeriesIndex {
  try { const x = JSON.parse(fs.readFileSync(path.join(dir, INDEX), 'utf8')); if (x?.v === 1 && x.files) return x; } catch { /* missing or damaged: rebuilt */ }
  return { v: 1, files: {} };
}

/** The index brought up to date with the day files on disk (only changed files are read) and saved. */
export function storedMarkets(dir: string): { rows: StoredMarket[]; index: SeriesIndex } {
  const index = readIndex(dir);
  if (!fs.existsSync(dir)) return { rows: [], index };
  const names = fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'));
  let changed = false;
  for (const name of names) {
    const size = fs.statSync(path.join(dir, name)).size;
    if (index.files[name]?.size === size) continue;
    const rows: StoredMarket[] = [];
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) { if (line) { const r = storedOf(line); if (r) rows.push(r); } }
    index.files[name] = { size, rows };
    changed = true;
  }
  for (const name of Object.keys(index.files)) if (!names.includes(name)) { delete index.files[name]; changed = true; }
  if (changed) saveIndex(dir, index);
  return { rows: Object.values(index.files).flatMap((f) => f.rows), index };
}

function saveIndex(dir: string, index: SeriesIndex): void {
  const tmp = path.join(dir, `${INDEX}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(index));
  fs.renameSync(tmp, path.join(dir, INDEX));
}

/** Settled markets are listed newest first; a past run that listed and stored a close-time range completely
 *  lets the listing stop this far inside it (markets that settle late, or move to the archive tier late). */
const LISTED_OVERLAP_MS = 3 * 86_400_000;

export async function downloadKalshiHistory(o: KalshiHistoryOpts): Promise<KalshiHistoryResult> {
  const f = o.fetchImpl ?? fetch, log = o.log ?? ((m: string) => console.log(`[kalshi-history] ${m}`));
  const now = o.now ?? Date.now(), from = now - o.days * 86_400_000;
  const { get, limited } = getter(o.baseUrl, f, o.ratePerSec);
  const clock = o.clock ?? Date.now;
  const deadline = o.budgetMs && o.budgetMs > 0 ? clock() + o.budgetMs : Infinity;
  const concurrency = Math.max(1, Math.floor(o.concurrency ?? 3));
  const maxMin = o.maxCandleMinutes ?? 2880;
  const cutoffRaw = await get('/historical/cutoff').catch(() => ({}));
  const cutoff = Date.parse(String(cutoffRaw?.market_settled_ts ?? '')) || 0;
  let markets = 0, skipped = 0, failed = 0, noVolume = 0, rejected = 0, remaining = 0, budgetHit = false;
  for (const series of o.series) {
    if (clock() >= deadline) { budgetHit = true; log(`${series}: time budget used up; left for the next run`); continue; }
    const dir = path.join(o.out, series);
    fs.mkdirSync(dir, { recursive: true });
    const failedBefore = failed;
    const stored = storedMarkets(dir);
    const have = new Set(stored.rows.filter((r) => r.error !== 'HTTP 404').map((r) => r.ticker));
    // Settled markets from both tiers, newest first, until older than `from` -- or, when a past run listed
    // [from, to] completely and this run wants no older markets, until a few days inside that range.
    const listed = stored.index.listed;
    const stopAt = listed && listed.from <= from ? Math.max(from, listed.to - LISTED_OVERLAP_MS) : from;
    let complete = true;
    const rows: Array<{ m: Omit<KalshiHistMarket, 'candles'>; hist: boolean }> = [];
    for (const [hist, p0] of [[false, `/markets?series_ticker=${encodeURIComponent(series)}&status=settled&limit=200`], [true, `/historical/markets?series_ticker=${encodeURIComponent(series)}&limit=200`]] as const) {
      let cursor = '';
      for (let page = 0; page < 500 && clock() < deadline; page++) {
        const d = await get(`${p0}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).catch((e) => { log(`${series}: ${String(e)}`); return undefined; });
        if (!d) { complete = false; break; }
        let older = false;
        for (const raw of d.markets ?? []) {
          const m = parseHistMarket(raw, series);
          if (!m) continue;
          if (m.closeTime < stopAt) { older = true; continue; }
          if (m.closeTime <= now) rows.push({ m, hist });
        }
        cursor = d.cursor ?? '';
        if (!cursor || older) break;
        if (page === 499 || clock() >= deadline) complete = false;
      }
    }
    log(`${series}: ${rows.length} settled market(s) ${stopAt > from ? `since ${new Date(stopAt).toISOString().slice(0, 10)} (older days listed by an earlier run)` : `in the last ${o.days} days`} (historical cutoff ${cutoff ? new Date(cutoff).toISOString().slice(0, 10) : 'unknown'}), ${rows.filter((r) => have.has(r.m.ticker)).length} already stored`);
    const store = (rec: KalshiHistMarket) => {
      fs.appendFileSync(path.join(dir, `${new Date(rec.closeTime).toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(rec)}\n`);
      have.add(rec.ticker);
    };
    const todo: typeof rows = [];
    for (const r of rows) {
      if (have.has(r.m.ticker)) { skipped++; continue; }
      // Never traded: nothing to learn from its candles, and no request needed.
      if (r.m.volume === 0) { store({ ...r.m, candles: [], noVolume: true }); noVolume++; continue; }
      todo.push(r);
    }
    let next = 0, n = 0;
    const worker = async () => {
      while (next < todo.length && clock() < deadline && !(o.maxMarkets && n >= o.maxMarkets)) {
        const { m, hist } = todo[next++];
        // Sports markets list days ahead: the candles that matter start an hour before the event.
        const start = Math.max(m.openTime, m.closeTime - maxMin * 60_000, m.startTime && m.startTime < m.closeTime ? m.startTime - 3_600_000 : -Infinity);
        const q = `start_ts=${Math.floor(start / 1000)}&end_ts=${Math.ceil(m.closeTime / 1000)}&period_interval=1`;
        const histPath = `/historical/markets/${encodeURIComponent(m.ticker)}/candlesticks?${q}`, livePath = `/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(m.ticker)}/candlesticks?${q}`;
        const first = hist || (cutoff && m.closeTime < cutoff) ? histPath : livePath;
        try {
          // Markets near the cutoff can still sit in the other tier (the archive move lags the cutoff): a 404 from
          // one tier is tried on the other before the market counts as rejected.
          const d = await get(first).catch((e) => { if (e instanceof HttpError && e.status === 404) return get(first === histPath ? livePath : histPath); throw e; });
          const candles = (d.candlesticks ?? []).map(parseCandle).filter((c: KalshiCandle | undefined): c is KalshiCandle => Boolean(c));
          store({ ...m, candles });
          markets++; n++;
        } catch (e) {
          // A request the API rejects for good is remembered (stored with its error), not retried each run.
          if (e instanceof HttpError && (e.status === 400 || e.status === 404)) { store({ ...m, candles: [], error: e.status === 404 ? 'HTTP 404 (both tiers)' : `HTTP ${e.status}` }); rejected++; }
          else failed++;
          if (failed + rejected <= 5) log(`${m.ticker}: ${String(e)}`);
        }
        progress(`Kalshi ${series} contracts`, next, todo.length);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    const left = todo.length - next;
    if (left > 0) { remaining += left; if (clock() >= deadline) { budgetHit = true; log(`${series}: time budget used up, ${left} market(s) left for the next run`); } }
    // Index the markets stored this run, and remember the range listed and stored completely (every market
    // stored, or kept back only after a failure the next run asks again: those are listed again anyway).
    const after = storedMarkets(dir);
    if (complete && left === 0 && failed === failedBefore) {
      const prev = after.index.listed;
      after.index.listed = { from: prev && prev.from <= from && prev.to >= stopAt ? prev.from : from, to: now };
      saveIndex(dir, after.index);
    }
  }
  log(`done: ${markets} new market(s), ${noVolume} never traded (stored without candles), ${skipped} already stored, ${rejected} rejected by the API, ${failed} failed${remaining ? `, ${remaining} left for the next run` : ''}${limited() ? `; Kalshi asked to slow down ${limited()} time(s) (paused and retried)` : ''}`);
  return { markets, skipped, failed, noVolume, rejected, remaining, budgetHit };
}

export interface KalshiTradesOpts {
  baseUrl?: string; series: string[]; out: string; fetchImpl?: typeof fetch; log?: (m: string) => void;
  /** Stop starting requests after this long (wall clock); the rest is fetched by the next run. */
  budgetMs?: number; concurrency?: number; clock?: () => number;
  /** Requests a second, shared by every worker (default 10). */
  ratePerSec?: number;
  /** Tape from this long before the event's start (or two days before the close) to the close. */
  leadMin?: number;
  /** Pages of 1000 trades per market and endpoint at most. */
  maxPages?: number;
}
export interface KalshiTradesResult { markets: number; trades: number; skipped: number; failed: number; remaining: number; budgetHit: boolean }

/**
 * The trade tape of every market stored by downloadKalshiHistory for these series (it must run first):
 * every fill with its price, size and taker side, from GET /historical/trades (trades older than the
 * archive's trades_created_ts cutoff) and GET /markets/trades (newer ones), cursor-paginated, deduplicated
 * by trade id. One line per market in <out>/<SERIES>/trades/<close day>.jsonl: {ticker, trades: [[ts,
 * price, count, side]]}. Markets already stored are skipped; budgeted and resumable like the market download.
 */
export async function downloadKalshiTrades(o: KalshiTradesOpts): Promise<KalshiTradesResult> {
  const f = o.fetchImpl ?? fetch, log = o.log ?? ((m: string) => console.log(`[kalshi-trades] ${m}`));
  const { get } = getter(o.baseUrl, f, o.ratePerSec);
  const clock = o.clock ?? Date.now;
  const deadline = o.budgetMs && o.budgetMs > 0 ? clock() + o.budgetMs : Infinity;
  const concurrency = Math.max(1, Math.floor(o.concurrency ?? 3));
  const lead = (o.leadMin ?? 120) * 60_000, maxPages = o.maxPages ?? 50;
  const cutoffRaw = await get('/historical/cutoff').catch(() => ({}));
  const cutoff = Date.parse(String(cutoffRaw?.trades_created_ts ?? '')) || 0;
  let markets = 0, trades = 0, skipped = 0, failed = 0, remaining = 0, budgetHit = false;
  for (const series of o.series) {
    const dir = path.join(o.out, series, 'trades');
    fs.mkdirSync(dir, { recursive: true });
    const have = new Set<string>();
    // Tape lines start {"ticker":"...": the ticker is read without parsing the tape.
    for (const file of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (line.startsWith('{"ticker":"') && line.endsWith('}')) { const e = line.indexOf('"', 11); if (e > 11) have.add(line.slice(11, e)); }
    }
    const all = storedMarkets(path.join(o.out, series)).rows;
    const todo = all.filter((m) => !have.has(m.ticker) && !m.noVolume && !m.error);
    skipped += all.length - todo.length;
    let next = 0;
    const worker = async () => {
      while (next < todo.length && clock() < deadline) {
        const m = todo[next++];
        const from = Math.max(m.openTime, (m.startTime && m.startTime < m.closeTime ? m.startTime : m.closeTime - 2 * 86_400_000) - lead);
        const q = `ticker=${encodeURIComponent(m.ticker)}&min_ts=${Math.floor(from / 1000)}&max_ts=${Math.ceil(m.closeTime / 1000)}&limit=1000`;
        const byId = new Map<string, KalshiTrade>();
        try {
          for (const [use, p0] of [[!cutoff || from < cutoff, '/historical/trades'], [!cutoff || m.closeTime >= cutoff, '/markets/trades']] as const) {
            if (!use) continue;
            let cursor = '';
            for (let page = 0; page < maxPages; page++) {
              const d = await get(`${p0}?${q}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
              for (const raw of d.trades ?? []) { const t = parseTrade(raw); if (t) byId.set(String(raw.trade_id ?? `${t[0]}:${t[1]}:${t[2]}:${t[3]}`), t); }
              cursor = d.cursor ?? '';
              if (!cursor || !(d.trades ?? []).length) break;
            }
          }
          const tape = [...byId.values()].sort((a, b) => a[0] - b[0]);
          fs.appendFileSync(path.join(dir, `${new Date(m.closeTime).toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({ ticker: m.ticker, trades: tape })}\n`);
          markets++; trades += tape.length;
        } catch (e) {
          failed++;
          if (failed <= 5) log(`${m.ticker}: ${String(e)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    const left = todo.length - next;
    if (left > 0) { remaining += left; if (clock() >= deadline) { budgetHit = true; log(`${series}: time budget used up, ${left} tape(s) left for the next run`); } }
  }
  log(`done: ${markets} tape(s), ${trades} trade(s), ${skipped} already stored or untraded, ${failed} failed${remaining ? `, ${remaining} left for the next run` : ''}`);
  return { markets, trades, skipped, failed, remaining, budgetHit };
}

/** Stored trade tapes of a series for markets closing on the given days, by ticker. */
export function loadKalshiTrades(out: string, series: string, days: string[]): Map<string, KalshiTrade[]> {
  const res = new Map<string, KalshiTrade[]>();
  for (const d of days) {
    const f = path.join(out, series, 'trades', `${d}.jsonl`);
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) { try { if (line) { const r = JSON.parse(line); res.set(r.ticker, r.trades); } } catch { /* torn */ } }
  }
  return res;
}

/** Every stored market of a series with candles (for research); includeEmpty adds the markets stored
 *  without candles (never traded, or rejected by the API). */
export function loadKalshiHistory(out: string, series: string, o: { includeEmpty?: boolean } = {}): KalshiHistMarket[] {
  const dir = path.join(out, series);
  if (!fs.existsSync(dir)) return [];
  const all: KalshiHistMarket[] = [];
  for (const file of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) { try { if (line) all.push(JSON.parse(line)); } catch { /* torn */ } }
  return all.filter((m) => o.includeEmpty || m.candles?.length).sort((a, b) => a.closeTime - b.closeTime);
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) {
  void downloadKalshiHistory({
    baseUrl: cliArg('base-url', process.env.KALSHI_REST_URL ?? 'https://external-api.kalshi.com/trade-api/v2'),
    series: cliArg('series', 'KXBTC15M,KXETH15M,KXSOL15M,KXXRP15M').split(',').map((s) => s.trim()).filter(Boolean),
    days: Number(cliArg('days', '60')), out: cliArg('out', 'data/history/kalshi'), maxMarkets: Number(cliArg('max-markets', '0')) || undefined,
    budgetMs: Number(cliArg('budget-min', '0')) * 60_000 || undefined,
  }).catch((e) => { console.error(e); process.exitCode = 1; });
}

// Bulk download of Binance kline history from data.binance.vision (free, no API key) for every
// crypto asset Kalshi lists in its price-prediction series and perpetuals.
//
//   npm run history:binance                                   # Kalshi assets, 1h + 15m + 1d, spot
//   npm run history:binance -- --assets BTC,ETH --intervals 15m,1h --markets spot,um
//   npm run history:binance -- --dry-run                      # list what would be fetched
//
// For each <ASSET>USDT pair and interval: list the archive (S3 bucket listing), download every
// monthly zip not yet fetched plus the daily zips of the current month, verify each against its
// published SHA-256 .CHECKSUM, unzip, validate and merge into data/history/binance/<ASSET>/<tf>.csv
// (USD-M perpetual futures, --markets um, go to binance-um/: stored, never spliced into spot).
// Binance's BTC dominance index (BTCDOM: BTC priced against a market-cap-weighted basket of the top 20
// alts, stablecoins excluded) comes along by default, from the futures index-price klines, as the
// index series binance-index/BTCDOM/1h.csv (hourly since June 2021).
// A manifest remembers what was fetched, so re-running only downloads what is new.
//
// Spot open times switched from milliseconds to microseconds on 2025-01-01; the parser handles both.

import { progress } from '../progress';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { cleanAndValidate, upsertSeries, type HistTf } from './candles';
import { parseCandleCsv } from './csvFormats';
import { resolveAssets } from './assets';
import { unzip } from './zip';
import { checkedStore } from './recheck';

export const BINANCE_HOSTS = ['https://data.binance.vision', 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision'];
const LIST_HOST = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';

/** spot pairs, USD-M perpetuals, or USD-M index prices (BTCDOM). */
export type BinanceMarket = 'spot' | 'um' | 'um-index';
const MARKET_PREFIX: Record<BinanceMarket, string> = { spot: 'data/spot', um: 'data/futures/um', 'um-index': 'data/futures/um' };
const MARKET_KIND: Record<BinanceMarket, string> = { spot: 'klines', um: 'klines', 'um-index': 'indexPriceKlines' };
const MARKET_SOURCE: Record<BinanceMarket, string> = { spot: 'binance', um: 'binance-um', 'um-index': 'binance-index' };
/** Index series downloaded with the spot history (market um-index). */
export const BINANCE_INDEXES = ['BTCDOM'];

export interface BinanceOpts {
  out: string;
  assets: string[];
  intervals: HistTf[];
  markets: BinanceMarket[];
  /** Skip archives before this month (YYYY-MM). */
  fromMonth?: string;
  /** Store under this source instead of the market's default (e.g. 1-minute spot bars kept apart from the
   *  spot store the TA steps read, so a multi-gigabyte file never joins their splice). */
  source?: string;
  dryRun?: boolean;
  concurrency?: number;
  /** Series checked (listed completely, nothing failed) within this many ms are not listed again
   *  (HISTORY_RECHECK_HOURS; 0 = always list). */
  recheckMs?: number;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
  now?: () => number;
}

/** A series' last clean check: when, from which month (a change re-lists it in full), and when it was last
 *  listed in full (every FULL_RELIST_MS, catching an archive Binance republished with a new size). */
interface Checked { at: number; full: number; from?: string }
interface Manifest { version?: number; files: Record<string, { size: number; bars: number; at: string }>; checked?: Record<string, Checked> }
const FULL_RELIST_MS = 30 * 86_400_000;
/** Series listed at once: S3 listing pages take ~2 s each, so they are asked in parallel. */
const SERIES_CONCURRENCY = 6;
/** 2: bars carry taker-buy volume (tb); files fetched before that are fetched again once. */
const MANIFEST_VERSION = 2;

export interface BinanceSummary { pair: string; market: BinanceMarket; tf: HistTf; listed: number; fetched: number; skipped: number; failed: number; bars: number; note?: string; /** Checked within recheckMs: not listed this run. */ fresh?: boolean }

/** Every object key under a prefix (S3 ListObjects v1 with marker pagination). */
export async function listKeys(prefix: string, f: typeof fetch = fetch, after = ''): Promise<Array<{ key: string; size: number }>> {
  const out: Array<{ key: string; size: number }> = [];
  // `after`: list only keys after this one (archive names sort by date, so: only the newer archives).
  let marker = after;
  for (let page = 0; page < 100; page++) {
    const url = `${LIST_HOST}?delimiter=/&prefix=${encodeURIComponent(prefix)}${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`;
    const res = await f(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`listing ${prefix}: HTTP ${res.status}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents><Key>([^<]+)<\/Key>(?:(?!<\/Contents>).)*?<Size>(\d+)<\/Size>/gs)) out.push({ key: m[1], size: Number(m[2]) });
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
    const next = /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1] ?? out[out.length - 1]?.key;
    if (!next || next === marker) break;
    marker = next;
  }
  return out;
}

let workingHost: string | undefined;

async function download(key: string, f: typeof fetch): Promise<Buffer> {
  const hosts = workingHost ? [workingHost, ...BINANCE_HOSTS.filter((h) => h !== workingHost)] : BINANCE_HOSTS;
  let last: unknown;
  for (const h of hosts) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await f(`${h}/${key}`, { signal: AbortSignal.timeout(60_000) });
        if (res.status === 404) throw Object.assign(new Error(`404 ${key}`), { notFound: true });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${key}`);
        workingHost = h;
        return Buffer.from(await res.arrayBuffer());
      } catch (e) {
        last = e;
        if ((e as { notFound?: boolean }).notFound) break;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Expected SHA-256 from a .CHECKSUM file ("<hex>  <name>"). */
export function parseChecksum(text: string): string | undefined {
  return /^([0-9a-f]{64})\b/i.exec(text.trim())?.[1]?.toLowerCase();
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

export async function downloadBinance(o: BinanceOpts): Promise<BinanceSummary[]> {
  const f = o.fetchImpl ?? fetch;
  const log = o.log ?? ((m: string) => console.log(`[binance] ${m}`));
  const manifestFile = path.join(o.out, o.source ? `binance-manifest-${o.source}.json` : 'binance-manifest.json');
  let manifest: Manifest = { files: {} };
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { /* first run */ }
  if ((manifest.version ?? 1) < MANIFEST_VERSION) {
    if (Object.keys(manifest.files).length) log('store predates taker-buy volume: fetching every file once more to add it');
    manifest = { version: MANIFEST_VERSION, files: {} };
  }
  const saveManifest = () => { if (!o.dryRun) { fs.mkdirSync(o.out, { recursive: true }); fs.writeFileSync(manifestFile, JSON.stringify(manifest)); } };
  const out: BinanceSummary[] = [];
  const now = (o.now ?? Date.now)();
  const checked = (manifest.checked ??= {});
  const jobs: Array<{ market: BinanceMarket; asset: string; tf: HistTf }> = [];
  for (const market of o.markets) for (const asset of o.assets) for (const tf of o.intervals) jobs.push({ market, asset, tf });
  let fresh = 0;
  /** The newest known archive under a prefix (from the manifest): later listings start after it. */
  const knownUnder = (prefix: string) => Object.keys(manifest.files).filter((k) => k.startsWith(prefix));
  await pool(jobs, SERIES_CONCURRENCY, async ({ market, asset, tf }) => {
    const pair = `${asset}USDT`;
    const s: BinanceSummary = { pair, market, tf, listed: 0, fetched: 0, skipped: 0, failed: 0, bars: 0 };
    out.push(s);
    const ck = `${market}|${pair}|${tf}|${o.source ?? ''}`;
    const last = checked[ck];
    const sameFrom = last && (!last.from || (o.fromMonth !== undefined && o.fromMonth >= last.from));
    if (last && sameFrom && o.recheckMs && now - last.at < o.recheckMs) { s.fresh = true; fresh++; return; }
    const incremental = Boolean(last && sameFrom && now - last.full < FULL_RELIST_MS);
    const mPrefix = `${MARKET_PREFIX[market]}/monthly/${MARKET_KIND[market]}/${pair}/${tf}/`, dPrefix = `${MARKET_PREFIX[market]}/daily/${MARKET_KIND[market]}/${pair}/${tf}/`;
    const knownM = incremental ? knownUnder(mPrefix) : [], knownD = incremental ? knownUnder(dPrefix) : [];
    const newest = (keys: string[]) => keys.reduce((a, k) => (k > a ? k : a), '');
    let monthly: Array<{ key: string; size: number }>, daily: Array<{ key: string; size: number }>;
    try {
      [monthly, daily] = await Promise.all([listKeys(mPrefix, f, newest(knownM)), listKeys(dPrefix, f, newest(knownD))]);
      monthly = monthly.filter((k) => k.key.endsWith('.zip'));
      daily = daily.filter((k) => k.key.endsWith('.zip'));
    } catch (e) { s.note = (e as Error).message; log(`${pair} ${market} ${tf}: ${s.note}`); return; }
    // Archives listed by an earlier run (incremental listing: only newer ones came back) count as listed.
    // Merged by key (a listing that ignored the marker returns them again; the listed size wins).
    const merge = (known: string[], listed: Array<{ key: string; size: number }>) => [...new Map([...known.map((key) => [key, { key, size: manifest.files[key].size }] as const), ...listed.map((k) => [k.key, k] as const)]).values()];
    monthly = merge(knownM, monthly);
    daily = merge(knownD, daily);
    if (!monthly.length && !daily.length) { s.note = 'not listed on Binance'; checked[ck] = { at: now, full: now, from: o.fromMonth }; saveManifest(); return; }
    const month = (k: string) => /-(\d{4}-\d{2})(?:-\d{2})?\.zip$/.exec(k)?.[1] ?? '';
    const months = new Set(monthly.map((k) => month(k.key)));
    // Daily archives only for months that have no monthly archive yet (the current month).
    const want = [...monthly, ...daily.filter((k) => !months.has(month(k.key)))].filter((k) => !o.fromMonth || month(k.key) >= o.fromMonth);
    s.listed = want.length;
    const todo = want.filter((k) => manifest.files[k.key]?.size !== k.size);
    s.skipped = want.length - todo.length;
    if (o.dryRun) { log(`${pair} ${market} ${tf}: ${todo.length} archive(s) to fetch (${s.skipped} already fetched)`); return; }
    const batch: Array<{ key: string; candles: ReturnType<typeof cleanAndValidate>['candles'] }> = [];
    await pool(todo, o.concurrency ?? 4, async (k) => {
      try {
        const [zip, sum] = await Promise.all([download(k.key, f), download(`${k.key}.CHECKSUM`, f).then((b) => b.toString('utf8')).catch(() => '')]);
        const expect = parseChecksum(sum);
        const got = crypto.createHash('sha256').update(zip).digest('hex');
        if (expect && expect !== got) throw new Error(`checksum mismatch for ${k.key}`);
        const entry = unzip(zip).find((e) => e.name.endsWith('.csv'));
        if (!entry) throw new Error(`no CSV inside ${k.key}`);
        const p = parseCandleCsv(entry.data.toString('utf8'), entry.name, { asset, tf, source: o.source ?? MARKET_SOURCE[market] });
        const { candles } = cleanAndValidate(p.candles, tf);
        batch.push({ key: k.key, candles });
        manifest.files[k.key] = { size: k.size, bars: candles.length, at: new Date().toISOString() };
        s.fetched++;
      } catch (e) {
        s.failed++;
        log(`${k.key}: ${(e as Error).message}`);
      }
      progress(`Binance ${pair} ${market} ${tf} archives`, s.fetched + s.failed, todo.length);
    });
    if (batch.length) s.bars = upsertSeries(o.out, o.source ?? MARKET_SOURCE[market], asset, tf, batch.flatMap((b) => b.candles));
    // A clean check is remembered (a failure is asked again next run, with a full listing).
    if (!s.failed) checked[ck] = { at: now, full: incremental ? last!.full : now, from: o.fromMonth };
    else delete checked[ck];
    saveManifest();
    if (todo.length || s.failed) log(`${pair} ${market} ${tf}: fetched ${s.fetched}, already had ${s.skipped}, failed ${s.failed}; ${s.bars || 'no new'} bars stored`);
    progress('Binance series checked', out.length, jobs.length);
  });
  const upToDate = out.filter((x) => !x.fresh && !x.note && !x.fetched && !x.failed).length;
  log(`${jobs.length} series: ${fresh} checked within the last ${Math.round((o.recheckMs ?? 0) / 3_600_000)} h (skipped), ${upToDate} already up to date, ${out.filter((x) => x.fetched).length} with new archives`);
  return out;
}

/** Binance USD-M funding rates (monthly fundingRate archives: calc_time, funding_interval_hours,
 *  last_funding_rate) -> <out>/binance-funding/<ASSET>/funding.csv ("ts,rate", ms and fraction per
 *  interval), merged and de-duplicated. A perp-quote input of the history replay (research/history/historyReplay.ts). */
export async function downloadBinanceFunding(o: { out: string; assets: string[]; fromMonth?: string; recheckMs?: number; now?: number; fetchImpl?: typeof fetch; log?: (m: string) => void }): Promise<Array<{ asset: string; fetched: number; rows: number; note?: string; fresh?: boolean }>> {
  const f = o.fetchImpl ?? fetch;
  const log = o.log ?? ((m: string) => console.log(`[binance] ${m}`));
  const manifestFile = path.join(o.out, 'binance-funding', 'manifest.json');
  let manifest: Record<string, number> = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { /* first run */ }
  const res: Array<{ asset: string; fetched: number; rows: number; note?: string; fresh?: boolean }> = [];
  const now = o.now ?? Date.now(), checked = checkedStore(path.join(o.out, 'binance-funding', 'checked.json'));
  for (const asset of o.assets) {
    const pair = `${asset}USDT`;
    const r = { asset, fetched: 0, rows: 0 } as { asset: string; fetched: number; rows: number; note?: string; fresh?: boolean };
    res.push(r);
    const ck = `${asset}|${o.fromMonth ?? ''}`;
    if (checked.fresh(ck, now, o.recheckMs)) { r.fresh = true; continue; }
    let keys: Array<{ key: string; size: number }>;
    try { keys = (await listKeys(`data/futures/um/monthly/fundingRate/${pair}/`, f)).filter((k) => k.key.endsWith('.zip')); } catch (e) { r.note = (e as Error).message; continue; }
    if (!keys.some((k) => manifest[k.key] !== k.size && (!o.fromMonth || (/-(\d{4}-\d{2})\.zip$/.exec(k.key)?.[1] ?? '') >= o.fromMonth))) { checked.mark(ck, now); checked.save(); if (!keys.length) r.note = 'no USD-M perpetual'; continue; }
    const month = (k: string) => /-(\d{4}-\d{2})\.zip$/.exec(k)?.[1] ?? '';
    const todo = keys.filter((k) => (!o.fromMonth || month(k.key) >= o.fromMonth) && manifest[k.key] !== k.size);
    if (!keys.length) { r.note = 'no USD-M perpetual'; continue; }
    const file = path.join(o.out, 'binance-funding', asset, 'funding.csv');
    const rows = new Map<number, number>();
    if (fs.existsSync(file)) for (const l of fs.readFileSync(file, 'utf8').split('\n').slice(1)) { const [t, v] = l.split(',').map(Number); if (Number.isFinite(t) && Number.isFinite(v)) rows.set(t, v); }
    await pool(todo, 4, async (k) => {
      try {
        const entry = unzip(await download(k.key, f)).find((e) => e.name.endsWith('.csv'));
        if (!entry) throw new Error('no CSV inside');
        for (const l of entry.data.toString('utf8').split('\n')) {
          const c = l.split(',');
          const t = Number(c[0]), v = Number(c[c.length - 1]);
          if (Number.isFinite(t) && t > 1e12 && Number.isFinite(v)) rows.set(t, v);
        }
        manifest[k.key] = k.size;
        r.fetched++;
      } catch (e) { log(`${k.key}: ${(e as Error).message}`); }
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'ts,rate\n' + [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => `${t},${v}`).join('\n') + '\n');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    r.rows = rows.size;
    if (r.fetched === todo.length) checked.mark(ck, now); else checked.forget(ck);
    checked.save();
    log(`${pair} funding: fetched ${r.fetched} month(s), ${r.rows} rates stored`);
  }
  return res;
}

/** Rows of a Binance USD-M daily metrics CSV (create_time, symbol, sum_open_interest, sum_open_interest_value,
 *  ...; one row per 5 minutes, UTC): [ts ms, open interest in coins, in USD]. Header, duplicate and broken
 *  lines are dropped. */
export function parseMetricsCsv(text: string): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const l of text.split('\n')) {
    const c = l.split(',');
    if (c.length < 4) continue;
    const ts = Date.parse(`${c[0].trim().replace(' ', 'T')}Z`), oi = Number(c[2]), usd = Number(c[3]);
    if (Number.isFinite(ts) && oi > 0 && Number.isFinite(usd)) out.push([ts, oi, usd]);
  }
  return out;
}

/** Binance USD-M open interest from the daily metrics archives (every 5 minutes, from September 2020) ->
 *  <out>/binance-oi/<ASSET>/oi.csv ("ts,oi,oi_usd": ms, coins, USD), merged and de-duplicated. The history
 *  replay puts it on its perp quotes (the perps model's open-interest inputs). Daily files only: Binance
 *  publishes no monthly metrics archive. */
export async function downloadBinanceOpenInterest(o: { out: string; assets: string[]; fromDay?: string; concurrency?: number; recheckMs?: number; now?: number; fetchImpl?: typeof fetch; log?: (m: string) => void }): Promise<Array<{ asset: string; fetched: number; rows: number; note?: string; fresh?: boolean }>> {
  const f = o.fetchImpl ?? fetch;
  const log = o.log ?? ((m: string) => console.log(`[binance] ${m}`));
  const manifestFile = path.join(o.out, 'binance-oi', 'manifest.json');
  let manifest: Record<string, number> = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { /* first run */ }
  const res: Array<{ asset: string; fetched: number; rows: number; note?: string; fresh?: boolean }> = [];
  const now = o.now ?? Date.now(), checked = checkedStore(path.join(o.out, 'binance-oi', 'checked.json'));
  for (const asset of o.assets) {
    const pair = `${asset}USDT`;
    const r = { asset, fetched: 0, rows: 0 } as { asset: string; fetched: number; rows: number; note?: string; fresh?: boolean };
    res.push(r);
    const ck = `${asset}|${o.fromDay ?? ''}`;
    if (checked.fresh(ck, now, o.recheckMs)) { r.fresh = true; continue; }
    // Daily archives sort by date: list only those after the newest one stored (one page instead of years).
    const prefix = `data/futures/um/daily/metrics/${pair}/`;
    // (Only after a complete check from the same first day: an earlier first day lists everything again.)
    const after = checked.seen(ck) ? Object.keys(manifest).reduce((a, k) => (k.startsWith(prefix) && k > a ? k : a), '') : '';
    let keys: Array<{ key: string; size: number }>;
    try { keys = (await listKeys(prefix, f, after)).filter((k) => k.key.endsWith('.zip')); } catch (e) { r.note = (e as Error).message; continue; }
    if (after) keys = [...new Map([...Object.keys(manifest).filter((k) => k.startsWith(prefix)).map((key) => [key, { key, size: manifest[key] }] as const), ...keys.map((k) => [k.key, k] as const)]).values()];
    if (!keys.length) { r.note = 'no USD-M perpetual metrics'; continue; }
    const day = (k: string) => /-(\d{4}-\d{2}-\d{2})\.zip$/.exec(k)?.[1] ?? '';
    const todo = keys.filter((k) => (!o.fromDay || day(k.key) >= o.fromDay) && manifest[k.key] !== k.size);
    const file = path.join(o.out, 'binance-oi', asset, 'oi.csv');
    const rows = new Map<number, [number, number]>();
    if (todo.length && fs.existsSync(file)) for (const l of fs.readFileSync(file, 'utf8').split('\n').slice(1)) { const [t, v, u] = l.split(',').map(Number); if (Number.isFinite(t) && v > 0) rows.set(t, [v, u]); }
    await pool(todo, o.concurrency ?? 8, async (k) => {
      try {
        const entry = unzip(await download(k.key, f)).find((e) => e.name.endsWith('.csv'));
        if (!entry) throw new Error('no CSV inside');
        for (const [t, v, u] of parseMetricsCsv(entry.data.toString('utf8'))) rows.set(t, [v, u]);
        manifest[k.key] = k.size;
        r.fetched++;
      } catch (e) { log(`${k.key}: ${(e as Error).message}`); }
    });
    if (r.fetched) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, 'ts,oi,oi_usd\n' + [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([t, [v, u]]) => `${t},${v},${u}`).join('\n') + '\n');
      fs.renameSync(`${file}.tmp`, file);
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    }
    r.rows = todo.length ? rows.size : 0;
    if (r.fetched === todo.length) checked.mark(ck, now); else checked.forget(ck);
    checked.save();
    if (todo.length) log(`${pair} open interest: fetched ${r.fetched} day(s), ${r.rows} readings stored`);
  }
  return res;
}

export async function binanceMain(argOf: (k: string, d: string) => string = cliArg, flags: (k: string) => boolean = (k) => process.argv.includes(`--${k}`)): Promise<BinanceSummary[]> {
  const log = (m: string) => console.log(`[binance] ${m}`);
  const assets = await resolveAssets(argOf('assets', 'auto'), { kalshiUrl: process.env.KALSHI_REST_URL, perpsUrl: process.env.KALSHI_PERPS_REST_URL, log });
  const res = await downloadBinance({
    out: argOf('out', 'data/history'), assets,
    intervals: argOf('intervals', '1h,15m,1d').split(',').map((s) => s.trim()) as HistTf[],
    markets: argOf('markets', 'spot').split(',').map((s) => s.trim()) as BinanceMarket[],
    fromMonth: argOf('from', '') || undefined, dryRun: flags('dry-run'), concurrency: Number(argOf('concurrency', '4')), log,
  });
  if (!flags('no-index')) res.push(...await downloadBinance({ out: argOf('out', 'data/history'), assets: BINANCE_INDEXES, intervals: ['1h'], markets: ['um-index'], dryRun: flags('dry-run'), log }));
  console.table(res.map((r) => ({ pair: r.pair, market: r.market, tf: r.tf, listed: r.listed, fetched: r.fetched, had: r.skipped, failed: r.failed, bars: r.bars, note: r.note ?? '' })));
  return res;
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

if (process.argv[1] && /binanceVision\.(ts|js|cjs)$/.test(process.argv[1])) void binanceMain().then((r) => { process.exitCode = r.some((x) => x.failed) ? 1 : 0; });

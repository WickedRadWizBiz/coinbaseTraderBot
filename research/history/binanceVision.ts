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
// A manifest remembers what was fetched, so re-running only downloads what is new.
//
// Spot open times switched from milliseconds to microseconds on 2025-01-01; the parser handles both.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { cleanAndValidate, upsertSeries, type HistTf } from './candles';
import { parseCandleCsv } from './csvFormats';
import { resolveAssets } from './assets';
import { unzip } from './zip';

export const BINANCE_HOSTS = ['https://data.binance.vision', 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision'];
const LIST_HOST = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';

export type BinanceMarket = 'spot' | 'um';
const MARKET_PREFIX: Record<BinanceMarket, string> = { spot: 'data/spot', um: 'data/futures/um' };
const MARKET_SOURCE: Record<BinanceMarket, string> = { spot: 'binance', um: 'binance-um' };

export interface BinanceOpts {
  out: string;
  assets: string[];
  intervals: HistTf[];
  markets: BinanceMarket[];
  /** Skip archives before this month (YYYY-MM). */
  fromMonth?: string;
  dryRun?: boolean;
  concurrency?: number;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

interface Manifest { files: Record<string, { size: number; bars: number; at: string }> }

export interface BinanceSummary { pair: string; market: BinanceMarket; tf: HistTf; listed: number; fetched: number; skipped: number; failed: number; bars: number; note?: string }

/** Every object key under a prefix (S3 ListObjects v1 with marker pagination). */
export async function listKeys(prefix: string, f: typeof fetch = fetch): Promise<Array<{ key: string; size: number }>> {
  const out: Array<{ key: string; size: number }> = [];
  let marker = '';
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
  const manifestFile = path.join(o.out, 'binance-manifest.json');
  let manifest: Manifest = { files: {} };
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { /* first run */ }
  const saveManifest = () => { if (!o.dryRun) { fs.mkdirSync(o.out, { recursive: true }); fs.writeFileSync(manifestFile, JSON.stringify(manifest)); } };
  const out: BinanceSummary[] = [];
  for (const market of o.markets) {
    for (const asset of o.assets) {
      const pair = `${asset}USDT`;
      for (const tf of o.intervals) {
        const s: BinanceSummary = { pair, market, tf, listed: 0, fetched: 0, skipped: 0, failed: 0, bars: 0 };
        out.push(s);
        let monthly: Array<{ key: string; size: number }>, daily: Array<{ key: string; size: number }>;
        try {
          monthly = (await listKeys(`${MARKET_PREFIX[market]}/monthly/klines/${pair}/${tf}/`, f)).filter((k) => k.key.endsWith('.zip'));
          daily = (await listKeys(`${MARKET_PREFIX[market]}/daily/klines/${pair}/${tf}/`, f)).filter((k) => k.key.endsWith('.zip'));
        } catch (e) { s.note = (e as Error).message; log(`${pair} ${market} ${tf}: ${s.note}`); continue; }
        if (!monthly.length && !daily.length) { s.note = 'not listed on Binance'; continue; }
        const month = (k: string) => /-(\d{4}-\d{2})(?:-\d{2})?\.zip$/.exec(k)?.[1] ?? '';
        const months = new Set(monthly.map((k) => month(k.key)));
        // Daily archives only for months that have no monthly archive yet (the current month).
        const want = [...monthly, ...daily.filter((k) => !months.has(month(k.key)))].filter((k) => !o.fromMonth || month(k.key) >= o.fromMonth);
        s.listed = want.length;
        const todo = want.filter((k) => manifest.files[k.key]?.size !== k.size);
        s.skipped = want.length - todo.length;
        if (o.dryRun) { log(`${pair} ${market} ${tf}: ${todo.length} archive(s) to fetch (${s.skipped} already fetched)`); continue; }
        const batch: Array<{ key: string; candles: ReturnType<typeof cleanAndValidate>['candles'] }> = [];
        await pool(todo, o.concurrency ?? 4, async (k) => {
          try {
            const [zip, sum] = await Promise.all([download(k.key, f), download(`${k.key}.CHECKSUM`, f).then((b) => b.toString('utf8')).catch(() => '')]);
            const expect = parseChecksum(sum);
            const got = crypto.createHash('sha256').update(zip).digest('hex');
            if (expect && expect !== got) throw new Error(`checksum mismatch for ${k.key}`);
            const entry = unzip(zip).find((e) => e.name.endsWith('.csv'));
            if (!entry) throw new Error(`no CSV inside ${k.key}`);
            const p = parseCandleCsv(entry.data.toString('utf8'), entry.name, { asset, tf, source: MARKET_SOURCE[market] });
            const { candles } = cleanAndValidate(p.candles, tf);
            batch.push({ key: k.key, candles });
            manifest.files[k.key] = { size: k.size, bars: candles.length, at: new Date().toISOString() };
            s.fetched++;
          } catch (e) {
            s.failed++;
            log(`${k.key}: ${(e as Error).message}`);
          }
        });
        if (batch.length) s.bars = upsertSeries(o.out, MARKET_SOURCE[market], asset, tf, batch.flatMap((b) => b.candles));
        saveManifest();
        log(`${pair} ${market} ${tf}: fetched ${s.fetched}, already had ${s.skipped}, failed ${s.failed}; ${s.bars || 'no new'} bars stored`);
      }
    }
  }
  return out;
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
  console.table(res.map((r) => ({ pair: r.pair, market: r.market, tf: r.tf, listed: r.listed, fetched: r.fetched, had: r.skipped, failed: r.failed, bars: r.bars, note: r.note ?? '' })));
  return res;
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

if (process.argv[1] && /binanceVision\.(ts|js|cjs)$/.test(process.argv[1])) void binanceMain().then((r) => { process.exitCode = r.some((x) => x.failed) ? 1 : 0; });

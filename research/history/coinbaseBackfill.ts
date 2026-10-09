// Coinbase Exchange candle backfill (public API, no key): the closest venue to the CF Benchmarks
// indices Kalshi settles on. Fills data/history/coinbase/<ASSET>/<tf>.csv backwards to the
// product's first bar and forwards to the last closed bar; re-running only fetches what is missing.
//
//   npm run history:coinbase                                 # Kalshi assets, 15m + 1h + 1d
//   npm run history:coinbase -- --assets BTC,ETH --tfs 15m,1h --from 2018-01-01
//
// 300 candles per request at ~4 requests/second (public limit is higher); a 15-minute backfill
// since 2017 is roughly 1,000 requests (~5 minutes) per asset.

import fs from 'fs';
import path from 'path';
import { fromRow, type CandleRow } from '../../bot/ta/candleStore';
import type { Candle } from '../../bot/ta/indicators';
import { cleanAndValidate, readSeries, seriesPath, upsertSeries, type HistTf } from './candles';
import { resolveAssets } from './assets';
import { progress } from '../progress';

const GRANULARITY: Partial<Record<HistTf, number>> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 };

export interface CoinbaseOpts {
  out: string;
  assets: string[];
  tfs: HistTf[];
  /** Earliest time to backfill to (ms). */
  fromTs: number;
  baseUrl?: string;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (m: string) => void;
}

export interface CoinbaseSummary { asset: string; tf: HistTf; requests: number; added: number; stored: number; note?: string }

export async function backfillCoinbase(o: CoinbaseOpts): Promise<CoinbaseSummary[]> {
  const f = o.fetchImpl ?? fetch;
  const base = (o.baseUrl ?? 'https://api.exchange.coinbase.com').replace(/\/$/, '');
  const now = (o.now ?? Date.now)();
  const log = o.log ?? ((m: string) => console.log(`[coinbase] ${m}`));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const out: CoinbaseSummary[] = [];
  for (const [ai, asset] of o.assets.entries()) {
    progress('Coinbase candles (coins)', ai, o.assets.length);
    // Kalshi lists assets Coinbase does not sell (tokenised stocks, indices): asked once, not per timeframe.
    let noProduct = false;
    for (const tf of o.tfs) {
      const g = GRANULARITY[tf];
      const s: CoinbaseSummary = { asset, tf, requests: 0, added: 0, stored: 0 };
      out.push(s);
      if (!g) { s.note = `Coinbase has no ${tf} candles`; continue; }
      const ms = g * 1000, span = 300 * ms;
      const have = readSeries(seriesPath(o.out, 'coinbase', asset, tf));
      if (noProduct) { s.note = `no ${asset}-USD product on Coinbase`; s.stored = have.length; continue; }
      const got: Candle[] = [];
      const fetchWindow = async (start: number, end: number): Promise<Candle[] | 'missing'> => {
        for (let attempt = 0; attempt < 5; attempt++) {
          s.requests++;
          const url = `${base}/products/${asset}-USD/candles?granularity=${g}&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
          const res = await f(url, { headers: { Accept: 'application/json', 'User-Agent': 'kalshi-bot-history' }, signal: AbortSignal.timeout(15_000) }).catch((e) => e as Error);
          if (res instanceof Error) { await sleep(1000 * 2 ** attempt); continue; }
          if (res.status === 404 || res.status === 400) return 'missing';
          if (res.status === 429 || res.status >= 500) { await sleep(1000 * 2 ** attempt); continue; }
          if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
          await sleep(o.delayMs ?? 250);
          const rows = (await res.json()) as CandleRow[];
          return (Array.isArray(rows) ? rows : []).map(fromRow).filter((c) => c.ts + ms <= now);
        }
        throw new Error(`${asset} ${tf}: Coinbase kept failing`);
      };
      try {
        const lastClosed = Math.floor(now / ms) * ms - ms;
        // Forward: from the last stored bar to now.
        if (have.length) {
          for (let t = have[have.length - 1].ts + ms; t <= lastClosed; t += span) {
            const w = await fetchWindow(t, Math.min(lastClosed + ms, t + span));
            if (w === 'missing') break;
            got.push(...w);
          }
        }
        // Backward: from the first stored bar (or now) to fromTs, stopping after 6 empty windows
        // (before the product listed). Once that is found, the start is remembered next to the series
        // (<tf>.start) and later runs do not ask those empty windows again.
        const startFile = `${seriesPath(o.out, 'coinbase', asset, tf)}.start`;
        const knownStart = fs.existsSync(startFile) ? Number(fs.readFileSync(startFile, 'utf8')) : NaN;
        let empty = 0;
        const from0 = have.length ? have[0].ts : lastClosed + ms;
        if (have.length && knownStart === have[0].ts) empty = 6;
        for (let end = from0; end > o.fromTs && empty < 6; end -= span) {
          const w = await fetchWindow(Math.max(o.fromTs, end - span), end);
          if (w === 'missing') { s.note = `no ${asset}-USD product on Coinbase`; noProduct = !have.length && !got.length; break; }
          if (!w.length) empty++; else empty = 0;
          got.push(...w);
        }
        if (empty >= 6) {
          const first = Math.min(have.length ? have[0].ts : Infinity, ...got.map((c) => c.ts));
          if (Number.isFinite(first) && knownStart !== first) { fs.mkdirSync(path.dirname(startFile), { recursive: true }); fs.writeFileSync(startFile, String(first)); }
        }
      } catch (e) { s.note = (e as Error).message; }
      if (got.length) {
        const { candles } = cleanAndValidate(got, tf);
        const before = have.length;
        s.stored = upsertSeries(o.out, 'coinbase', asset, tf, candles);
        s.added = s.stored - before;
      } else s.stored = have.length;
      log(noProduct ? `${asset}: not sold on Coinbase (no ${asset}-USD product), skipped` : `${asset} ${tf}: ${s.requests} requests, +${s.added} bars (${s.stored} stored)${s.note ? `; ${s.note}` : ''}`);
    }
  }
  return out;
}

export async function coinbaseMain(argOf: (k: string, d: string) => string = cliArg): Promise<CoinbaseSummary[]> {
  const log = (m: string) => console.log(`[coinbase] ${m}`);
  const assets = await resolveAssets(argOf('assets', 'auto'), { kalshiUrl: process.env.KALSHI_REST_URL, perpsUrl: process.env.KALSHI_PERPS_REST_URL, log });
  const res = await backfillCoinbase({
    out: argOf('out', 'data/history'), assets, tfs: argOf('tfs', '15m,1h,1d').split(',').map((s) => s.trim()) as HistTf[],
    fromTs: Date.parse(`${argOf('from', '2015-01-01')}T00:00:00Z`), baseUrl: process.env.COINBASE_REST_URL, log,
  });
  console.table(res.map((r) => ({ asset: r.asset, tf: r.tf, requests: r.requests, added: r.added, stored: r.stored, note: r.note ?? '' })));
  return res;
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

if (process.argv[1] && /coinbaseBackfill\.(ts|js|cjs)$/.test(process.argv[1])) void coinbaseMain();

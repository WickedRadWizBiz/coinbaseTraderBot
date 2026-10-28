// The spot candles the paper bot held at a given time, for a replay that starts there. The bot fetches Coinbase's candles
// when it starts (bot/marketdata/spotCandles.ts: the newest page of each timeframe, one older page of 15m) and records
// only the bars that are new to it after that. A replay that starts in the middle of a run therefore has just the bars
// recorded since: too few for the TA network (291 hourly and 279 daily bars) and the longer indicators, which paper had
// all along. Without them the replay prices with neither the network's volatility forecast nor its tilt (Oct 27 to 28:
// the fair value 1.5c off paper's, against 0.4c on a stretch that began at a start of the bot). The seed is the bot's
// startup fetch made for the replay's start: the same requests, over pages that end there.
//
//   npm run research:seed-candles -- --at 2026-10-27T00:00:00Z --out data/sweeps/seed-candles.json
//         (the bot's settings from the environment, as the replay reads them: the assets and the Coinbase address)

import fs from 'fs';
import path from 'path';
import type { Config } from '../bot/config';
import { BACKFILL, GRANULARITY, SpotCandleFeed } from '../bot/marketdata/spotCandles';
import type { CandleRow } from '../bot/ta/candleStore';
import type { Timeframe } from '../bot/ta/knowledge';

export interface SeedCandles {
  /** When the bot would have fetched them (ms): bars still forming then are dropped as they arrive (CandleSet.add). */
  at: number;
  sets: Array<{ asset: string; tf: Timeframe; rows: CandleRow[] }>;
  /** What could not be fetched (an asset without a Coinbase product, or a page that failed twice). */
  missing: string[];
}

/** The assets the bot polls candles for (bot/marketdata/marketData.ts): every asset with a settlement index. */
export function candleAssets(cfg: Pick<Config, 'strategy' | 'seriesAssetMap' | 'indexIdMap' | 'taCandles'>): string[] {
  if (!cfg.taCandles) return [];
  const assets = new Set([...cfg.strategy.series.map((s) => cfg.seriesAssetMap[s]), ...(cfg.strategy.seriesAuto ? Object.values(cfg.indexIdMap) : [])]);
  return [...assets].filter((a): a is string => Boolean(a) && a !== 'TENNIS');
}

/** The bot's startup fetch for `at`: for each asset and timeframe the page of bars up to it, and one older page for the
 *  timeframes the bot backfills. Pages are fetched one at a time, `pauseMs` apart (well inside Coinbase's public limits). */
export async function fetchSeedCandles(assets: string[], at: number, baseUrl: string, fetchImpl: typeof fetch = fetch, pauseMs = 150): Promise<SeedCandles> {
  const feed = new SpotCandleFeed(assets, baseUrl, fetchImpl, () => at);
  const out: SeedCandles = { at, sets: [], missing: [] };
  const page = async (asset: string, tf: Timeframe, from: number, to: number): Promise<CandleRow[]> => {
    for (let attempt = 0; ; attempt++) {
      try { return await feed.fetchCandles(asset, tf, from, to); } catch (e) {
        if ((e as Error).message.includes('HTTP 404') || attempt > 0) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      } finally { if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs)); }
    }
  };
  for (const asset of assets) {
    for (const tf of Object.keys(GRANULARITY) as Timeframe[]) {
      const g = GRANULARITY[tf]! * 1000;
      try {
        // One Coinbase page is at most 300 bars: the window ends at `at` and starts 299 bars before it.
        const rows = await page(asset, tf, at - 299 * g, at);
        if (rows.length && BACKFILL.includes(tf)) {
          const oldest = Math.min(...rows.map((r) => r[0])) * 1000;
          rows.push(...(await page(asset, tf, oldest - 300 * g, oldest - g)));
        }
        if (rows.length) out.sets.push({ asset, tf, rows });
      } catch (e) {
        // As the bot: an asset Coinbase does not list gets no candles at all.
        if ((e as Error).message.includes('HTTP 404')) { out.missing.push(`${asset} (no Coinbase product)`); break; }
        out.missing.push(`${asset} ${tf}`);
      }
    }
  }
  return out;
}

/** A seed file for the replay starting at `at`; undefined when there is none, or it was fetched for another start. */
export function readSeedCandles(file: string | undefined, at: number): SeedCandles | undefined {
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as SeedCandles;
    return s.at === at && Array.isArray(s.sets) ? s : undefined;
  } catch { return undefined; }
}

/** Fetches the seed for `at` with the bot's settings (its assets and Coinbase address) into `out`; returns a line on it
 *  (counts only: the workflows that print it run in a public repository). */
export async function writeSeedCandles(cfg: Config, at: number, out: string): Promise<string> {
  const seed = await fetchSeedCandles(candleAssets(cfg), at, cfg.coinbaseRestUrl);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(seed));
  return `spot candles for ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC (as the bot's startup fetch): ${new Set(seed.sets.map((c) => c.asset)).size} coins, ${seed.sets.reduce((n, c) => n + c.rows.length, 0)} bars${seed.missing.length ? ` | not fetched: ${seed.missing.join(', ')}` : ''}`;
}

async function main(): Promise<void> {
  const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] ?? '' : ''; };
  const at = Date.parse(arg('at')), out = arg('out');
  if (!Number.isFinite(at) || !out) throw new Error('usage: seedCandles --at ISO --out file.json');
  const { loadConfig, paperEnv } = await import('../bot/config');
  console.log(await writeSeedCandles(loadConfig(paperEnv(process.env)) as Config, at, out));
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error((e as Error).message); process.exitCode = 1; });

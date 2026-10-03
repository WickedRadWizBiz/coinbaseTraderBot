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

import fs from 'fs';
import path from 'path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number | null => { if (v === null || v === undefined || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };

export interface KalshiCandle { ts: number; bidO: number | null; bidH: number | null; bidL: number | null; bidC: number | null; askO: number | null; askH: number | null; askL: number | null; askC: number | null; last: number | null; volume: number | null; oi: number | null }
export interface KalshiHistMarket { ticker: string; series: string; event?: string; openTime: number; closeTime: number; strike: number | null; cap: number | null; strikeType?: string; result?: string; settlement?: number | null; candles: KalshiCandle[] }

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
  return {
    ticker: String(m.ticker), series, event: m.event_ticker, openTime, closeTime, strike: num(m.floor_strike), cap: num(m.cap_strike), strikeType: m.strike_type,
    result: m.result || undefined, settlement: num(m.settlement_value_dollars) ?? num(m.expiration_value),
  };
}

export interface KalshiHistoryOpts { baseUrl?: string; series: string[]; days: number; out: string; fetchImpl?: typeof fetch; log?: (m: string) => void; now?: number; maxMarkets?: number }

export async function downloadKalshiHistory(o: KalshiHistoryOpts): Promise<{ markets: number; skipped: number; failed: number }> {
  const base = (o.baseUrl ?? 'https://external-api.kalshi.com/trade-api/v2').replace(/\/$/, '');
  const f = o.fetchImpl ?? fetch, log = o.log ?? ((m: string) => console.log(`[kalshi-history] ${m}`));
  const now = o.now ?? Date.now(), from = now - o.days * 86_400_000;
  const get = async (p: string): Promise<any> => {
    let delay = 500;
    for (let attempt = 0; ; attempt++) {
      const res = await f(base + p, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status >= 500) && attempt < 5) { await sleep(delay); delay *= 2; continue; }
      throw new Error(`GET ${p}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  };
  const cutoffRaw = await get('/historical/cutoff').catch(() => ({}));
  const cutoff = Date.parse(String(cutoffRaw?.market_settled_ts ?? '')) || 0;
  let markets = 0, skipped = 0, failed = 0;
  for (const series of o.series) {
    const dir = path.join(o.out, series);
    fs.mkdirSync(dir, { recursive: true });
    const have = new Set<string>();
    for (const file of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) { try { if (line) have.add(JSON.parse(line).ticker); } catch { /* torn */ } }
    // Settled markets from both tiers, newest first, until older than `from`.
    const rows: Array<{ m: Omit<KalshiHistMarket, 'candles'>; hist: boolean }> = [];
    for (const [hist, p0] of [[false, `/markets?series_ticker=${encodeURIComponent(series)}&status=settled&limit=200`], [true, `/historical/markets?series_ticker=${encodeURIComponent(series)}&limit=200`]] as const) {
      let cursor = '';
      for (let page = 0; page < 500; page++) {
        const d = await get(`${p0}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).catch((e) => { log(`${series}: ${String(e)}`); return undefined; });
        if (!d) break;
        let older = false;
        for (const raw of d.markets ?? []) {
          const m = parseHistMarket(raw, series);
          if (!m) continue;
          if (m.closeTime < from) { older = true; continue; }
          if (m.closeTime <= now) rows.push({ m, hist });
        }
        cursor = d.cursor ?? '';
        if (!cursor || older) break;
      }
    }
    log(`${series}: ${rows.length} settled market(s) in the last ${o.days} days (historical cutoff ${cutoff ? new Date(cutoff).toISOString().slice(0, 10) : 'unknown'}), ${rows.filter((r) => have.has(r.m.ticker)).length} already stored`);
    let n = 0;
    for (const { m, hist } of rows) {
      if (have.has(m.ticker)) { skipped++; continue; }
      if (o.maxMarkets && n >= o.maxMarkets) break;
      const q = `start_ts=${Math.floor(m.openTime / 1000)}&end_ts=${Math.ceil(m.closeTime / 1000)}&period_interval=1`;
      const p = hist || (cutoff && m.closeTime < cutoff) ? `/historical/markets/${encodeURIComponent(m.ticker)}/candlesticks?${q}` : `/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(m.ticker)}/candlesticks?${q}`;
      try {
        const d = await get(p);
        const candles = (d.candlesticks ?? []).map(parseCandle).filter((c: KalshiCandle | undefined): c is KalshiCandle => Boolean(c));
        const rec: KalshiHistMarket = { ...m, candles };
        fs.appendFileSync(path.join(dir, `${new Date(m.closeTime).toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(rec)}\n`);
        have.add(m.ticker); markets++; n++;
      } catch (e) { failed++; if (failed <= 5) log(`${m.ticker}: ${String(e)}`); }
    }
  }
  log(`done: ${markets} new market(s), ${skipped} already stored, ${failed} failed`);
  return { markets, skipped, failed };
}

/** Every stored market of a series (for research). */
export function loadKalshiHistory(out: string, series: string): KalshiHistMarket[] {
  const dir = path.join(out, series);
  if (!fs.existsSync(dir)) return [];
  const all: KalshiHistMarket[] = [];
  for (const file of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) { try { if (line) all.push(JSON.parse(line)); } catch { /* torn */ } }
  return all.sort((a, b) => a.closeTime - b.closeTime);
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) {
  void downloadKalshiHistory({
    baseUrl: cliArg('base-url', process.env.KALSHI_REST_URL ?? 'https://external-api.kalshi.com/trade-api/v2'),
    series: cliArg('series', 'KXBTC15M,KXETH15M,KXSOL15M,KXXRP15M').split(',').map((s) => s.trim()).filter(Boolean),
    days: Number(cliArg('days', '60')), out: cliArg('out', 'data/history/kalshi'), maxMarkets: Number(cliArg('max-markets', '0')) || undefined,
  }).catch((e) => { console.error(e); process.exitCode = 1; });
}

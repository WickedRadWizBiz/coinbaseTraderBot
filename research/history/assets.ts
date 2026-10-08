// Which crypto assets to collect history for: every asset Kalshi lists in its crypto price-prediction
// series (15-minute Up/Down KX<A>15M, hourly/daily ladders KX<A>D, range brackets KX<A>) and in its
// perpetuals (GET /margin/markets). Both listings are public. Candidate symbols that are not real
// assets (KXBTCMAXY etc.) drop out later when Binance / Coinbase have no such pair.

import { DEFAULT_SOURCE_PRIORITY } from './candles';

export const FALLBACK_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
const FREQUENCIES = new Set(['fifteen_min', '15min', 'hourly', 'daily']);

export interface DiscoverOpts {
  kalshiUrl?: string;
  perpsUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

/** Kalshi series named after the coin rather than its ticker. */
export const ASSET_ALIASES: Record<string, string> = { BITCOIN: 'BTC', ETHEREUM: 'ETH', SOLANA: 'SOL', RIPPLE: 'XRP', DOGECOIN: 'DOGE', SHIBA: 'SHIB', SHIBAINU: 'SHIB', CARDANO: 'ADA', LITECOIN: 'LTC', POLKADOT: 'DOT', CHAINLINK: 'LINK', AVALANCHE: 'AVAX' };
/** Kalshi's crypto category also lists metals and stock indices: no coin to download. */
export const NOT_CRYPTO = new Set(['GOLD', 'SILVER', 'PLATINUM', 'PALLADIUM', 'COPPER', 'OIL', 'WTI', 'BRENT', 'NATGAS', 'US500', 'SPX', 'SP500', 'NASDAQ', 'NDX', 'DOW', 'INX']);
/** Letters Kalshi appends to a coin for a series' frequency or kind (KXNEARH hourly, KXSOLE, KXTONH). */
const SUFFIXES = ['H', 'D', 'E', 'W', 'M', 'Y'];

/** Coin tickers from raw candidates: aliases mapped (RIPPLE -> XRP), metals and indices dropped, and a coin with a
 *  frequency letter stuck on (NEARH, TONH, SOLE) folded into the coin when that coin is listed too or is a known one. */
export function normalizeAssets(candidates: string[]): string[] {
  const raw = new Set(candidates.map((a) => ASSET_ALIASES[a] ?? a).filter((a) => !NOT_CRYPTO.has(a)));
  const known = new Set([...raw, ...FALLBACK_ASSETS, ...Object.values(ASSET_ALIASES)]);
  const out = new Set<string>();
  for (const a of raw) {
    const stem = a.slice(0, -1);
    const folds = stem.length >= 2 && SUFFIXES.includes(a.slice(-1)) && known.has(stem) && !FALLBACK_ASSETS.includes(a);
    out.add(folds ? stem : a);
  }
  return [...out].sort();
}

/** Asset candidates from Kalshi's crypto series list (pattern + frequency filter), normalised to coin tickers. */
export function assetsFromSeries(rows: Array<{ ticker: string; frequency?: string }>): string[] {
  const raw: string[] = [];
  for (const r of rows) {
    const m = /^KX([A-Z0-9]{2,10}?)(15M|D)?$/.exec(r.ticker.toUpperCase());
    if (!m) continue;
    const f = r.frequency?.toLowerCase();
    if (f && !FREQUENCIES.has(f)) continue;
    raw.push(m[1]);
  }
  return normalizeAssets(raw);
}

/** Asset candidates from perp market tickers/titles (KXBTCPERP, BTC-PERP, BTCUSD-PERP, "Bitcoin Perpetual"). */
export function assetsFromPerps(rows: Array<{ ticker?: string; title?: string; underlying?: string }>): string[] {
  const names: Record<string, string> = { BITCOIN: 'BTC', ETHEREUM: 'ETH', SOLANA: 'SOL', RIPPLE: 'XRP', DOGECOIN: 'DOGE' };
  const out = new Set<string>();
  for (const r of rows) {
    const u = String(r.underlying ?? '').toUpperCase();
    if (/^[A-Z0-9]{2,10}$/.test(u)) { out.add(u); continue; }
    const t = String(r.ticker ?? '').toUpperCase();
    const m = /^(?:KX)?([A-Z0-9]{2,10}?)(?:-?USDT?|-?USD)?-?PERP/.exec(t);
    if (m) { out.add(m[1]); continue; }
    for (const [n, a] of Object.entries(names)) if (String(r.title ?? '').toUpperCase().includes(n)) out.add(a);
  }
  return [...out].sort();
}

/** Assets Kalshi lists (binary series + perps), or the fallback list when the listings fail. */
export async function discoverKalshiAssets(o: DiscoverOpts = {}): Promise<{ assets: string[]; binary: string[]; perps: string[]; errors: string[] }> {
  const f = o.fetchImpl ?? fetch;
  const kalshi = (o.kalshiUrl ?? 'https://api.elections.kalshi.com/trade-api/v2').replace(/\/$/, '');
  const perps = (o.perpsUrl ?? 'https://external-api.kalshi.com/trade-api/v2').replace(/\/$/, '');
  const errors: string[] = [];
  const get = async (url: string) => {
    const r = await f(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<any>;
  };
  let binary: string[] = [], perp: string[] = [];
  try { binary = assetsFromSeries(((await get(`${kalshi}/series?category=Crypto`)).series ?? []).map((s: any) => ({ ticker: String(s.ticker), frequency: s.frequency }))); }
  catch (e) { errors.push(`Kalshi series list: ${(e as Error).message}`); }
  try { const raw = await get(`${perps}/margin/markets?status=active`); perp = assetsFromPerps(Array.isArray(raw) ? raw : raw.markets ?? []); }
  catch (e) { errors.push(`Kalshi perps list: ${(e as Error).message}`); }
  const assets = normalizeAssets([...binary, ...perp]);
  for (const e of errors) o.log?.(`asset discovery: ${e}`);
  return { assets: assets.length ? assets : FALLBACK_ASSETS, binary, perps: perp, errors };
}

/** --assets value: "auto" (discover), or a comma list. */
export async function resolveAssets(spec: string | undefined, o: DiscoverOpts = {}): Promise<string[]> {
  if (spec && spec !== 'auto') return spec.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const d = await discoverKalshiAssets(o);
  o.log?.(`Kalshi assets: binary ${d.binary.join(',') || '-'}; perps ${d.perps.join(',') || '-'}${d.errors.length ? ' (fallback list used for failed listings)' : ''}`);
  return d.assets;
}

export { DEFAULT_SOURCE_PRIORITY };

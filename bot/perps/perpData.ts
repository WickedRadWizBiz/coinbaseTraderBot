// Kalshi Perpetual Contracts: market data model shared by production and
// research replay (stage 1: perps as features for the binary model).
//
// Wire shapes follow the perps OpenAPI/AsyncAPI as mirrored by the public
// kalshi-python-sdk (docs.kalshi.com is unreachable from the build host):
//   GET /margin/markets                    -> MarginMarket[] (public)
//   GET /margin/funding_rates/estimate     -> { funding_rate, mark_price, next_funding_time, ... } (public)
//   MarginMarket: ticker, title, status, contract_size, tick_size, fractional_trading_enabled,
//     price, bid, ask, open_interest(_fp), reference_price, settlement_mark_price,
//     liquidation_mark_price (TickerPrice), leverage_estimate, asset_class
// Prices are fixed-point dollar strings; counts are fixed-point strings.
// All parsing is defensive and lives here, so a field rename is a one-file fix.
// VERIFY ON KALSHI DEMO before relying on live perps data.

import { IndexTracker } from '../marketdata/indexTracker';

export interface PerpSnapshot {
  ticker: string;
  asset: string;
  ts: number;
  bid?: number;
  ask?: number;
  last?: number;
  /** Mark price used for settlement/funding (falls back to reference, then mid). */
  mark?: number;
  openInterest?: number;
  /** Current funding-rate estimate per 8 h interval (fraction, e.g. 0.0001 = 1 bp). */
  fundingRate?: number;
  nextFundingTs?: number;
  /** Underlying units per contract (e.g. 0.0001 BTC). */
  contractSize?: number;
  tickSize?: number;
  fractional?: boolean;
  leverage?: number;
}

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return num(o.price ?? o.value ?? o.price_dollars ?? o.dollars);
  }
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const ts = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : undefined; }
  return undefined;
};

const NAMES: Record<string, string[]> = {
  BTC: ['BITCOIN', 'BTC'], ETH: ['ETHEREUM', 'ETHER', 'ETH'], SOL: ['SOLANA', 'SOL'], XRP: ['XRP', 'RIPPLE'], DOGE: ['DOGECOIN', 'DOGE'],
};

/** Underlying asset of a perp market from its ticker / title, restricted to `assets`. */
export function assetOfPerp(ticker: string, title: string | undefined, assets: Iterable<string>): string | undefined {
  const tokens = new Set(`${ticker} ${title ?? ''}`.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean));
  const tickerCompact = ticker.toUpperCase();
  for (const a of assets) {
    const names = NAMES[a] ?? [a];
    if (names.some((n) => tokens.has(n))) return a;
    // Compact tickers such as KXBTCPERP / BTCUSD.
    if (new RegExp(`^(KX)?${a}(USD|PERP|-|$)`).test(tickerCompact)) return a;
  }
  return undefined;
}

/** Parse one MarginMarket from GET /margin/markets. */
export function parseMarginMarket(m: Record<string, any>, assets: Iterable<string>, now: number): PerpSnapshot | undefined {
  if (!m?.ticker) return undefined;
  if (m.status && String(m.status) !== 'active') return undefined;
  const asset = assetOfPerp(String(m.ticker), m.title, assets);
  if (!asset) return undefined;
  const bid = num(m.bid ?? m.bid_dollars), ask = num(m.ask ?? m.ask_dollars);
  const mid = bid !== undefined && ask !== undefined && ask >= bid ? (bid + ask) / 2 : undefined;
  return {
    ticker: String(m.ticker), asset, ts: now,
    bid, ask, last: num(m.price ?? m.price_dollars),
    mark: num(m.settlement_mark_price) ?? num(m.reference_price) ?? mid,
    openInterest: num(m.open_interest_fp ?? m.open_interest),
    contractSize: num(m.contract_size ?? m.contract_size_dollars),
    tickSize: num(m.tick_size ?? m.tick_size_dollars),
    fractional: typeof m.fractional_trading_enabled === 'boolean' ? m.fractional_trading_enabled : undefined,
    leverage: num(m.leverage_estimate),
  };
}

/** Parse GET /margin/funding_rates/estimate. */
export function parseFundingEstimate(raw: Record<string, any>): { rate?: number; nextTs?: number; mark?: number } {
  const r = raw?.funding_rate_estimate ?? raw?.estimate ?? raw;
  return { rate: num(r?.funding_rate), nextTs: ts(r?.next_funding_time ?? r?.next_funding_time_ms), mark: num(r?.mark_price_dollars ?? r?.mark_price) };
}

/** Kalshi funding times: 00:00, 08:00, 16:00 America/New_York. Next one strictly after `now`. */
export function nextFundingTime(now: number): number {
  const step = 15 * 60_000;
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
  for (let t = Math.floor(now / step) * step + step, i = 0; i < 4 * 24 + 8; i++, t += step) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    if (p.minute === '00' && ['00', '08', '16'].includes(p.hour)) return t;
  }
  return now + 8 * 3_600_000;
}

/** Per-asset perp state: mid/mark series, open interest series, latest funding. */
export class PerpState {
  readonly mid = new IndexTracker('perp', 5 * 3_600_000, 300);
  readonly oi = new IndexTracker('perp-oi', 5 * 3_600_000, 300);
  latest?: PerpSnapshot;

  apply(s: PerpSnapshot): void {
    const m = s.bid !== undefined && s.ask !== undefined && s.ask >= s.bid ? (s.bid + s.ask) / 2 : s.mark ?? s.last;
    if (m !== undefined && m > 0) this.mid.add(m, s.ts);
    if (s.openInterest !== undefined && s.openInterest > 0) this.oi.add(s.openInterest, s.ts);
    this.latest = { ...this.latest, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) } as PerpSnapshot;
  }

  /** Fresh mid (or mark) price. */
  price(now: number, maxAgeMs = 15_000): number | undefined {
    return this.mid.fresh(now, maxAgeMs)?.value;
  }
}

/** Perp state for every asset; fed identically by the live feed and research replay. */
export class PerpHub {
  readonly byAsset = new Map<string, PerpState>();
  apply(s: PerpSnapshot): void {
    let st = this.byAsset.get(s.asset);
    if (!st) { st = new PerpState(); this.byAsset.set(s.asset, st); }
    st.apply(s);
  }
  get(asset: string): PerpState | undefined { return this.byAsset.get(asset); }
}

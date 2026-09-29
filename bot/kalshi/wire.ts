// Wire-format parsing for Kalshi REST and WebSocket payloads.
//
// Kalshi migrated to fixed-point dollar strings (`*_dollars`, `*_fp`) and the V2
// single-book (`bid`/`ask` on YES) order model; older payloads use integer cents
// and yes/no + buy/sell. Everything format-specific lives here so it can be
// checked against the demo environment in one place. Unknown or missing
// numeric fields parse to undefined and callers must fail closed.

import { parseCount, parseDollars } from '../util/num';
import type { BookLevel, BookSide, ExchangeFill, ExchangeOrder, ExchangeOrderStatus, ExchangePosition, MarketInfo, SeriesFeeInfo } from './types';

type Obj = Record<string, any>;

export function toBookSide(side: unknown, action: unknown): BookSide | undefined {
  const s = String(side ?? '').toLowerCase();
  if (s === 'bid' || s === 'ask') return s;
  const a = String(action ?? 'buy').toLowerCase();
  if (s === 'yes') return a === 'sell' ? 'ask' : 'bid';
  if (s === 'no') return a === 'sell' ? 'bid' : 'ask';
  return undefined;
}

/** YES-side price from any of the known representations. */
export function yesPrice(o: Obj): number | undefined {
  return parseDollars(o.price_dollars)
    ?? parseDollars(o.yes_price_dollars)
    ?? (typeof o.price === 'string' ? parseDollars(o.price) : undefined)
    ?? (o.no_price_dollars !== undefined ? 1 - (parseDollars(o.no_price_dollars) as number) : undefined)
    ?? parseDollars(o.yes_price, true)
    ?? (typeof o.price === 'number' ? parseDollars(o.price, o.price > 1) : undefined)
    ?? (o.no_price !== undefined ? 1 - (parseDollars(o.no_price, true) as number) : undefined);
}

function ts(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const d = Date.parse(String(v));
  return Number.isFinite(d) ? d : undefined;
}

function status(v: unknown): ExchangeOrderStatus {
  const s = String(v ?? '').toLowerCase();
  if (s === 'resting' || s === 'open') return 'resting';
  if (s === 'canceled' || s === 'cancelled') return 'canceled';
  if (s === 'executed' || s === 'filled') return 'executed';
  if (s === 'pending') return 'pending';
  return 'unknown';
}

export function parseOrder(raw: Obj): ExchangeOrder {
  const o: Obj = raw.order ?? raw;
  const side = toBookSide(o.side, o.action);
  const price = yesPrice(o);
  const orderId = o.order_id ?? o.id;
  if (!orderId || !side || price === undefined) {
    throw new Error(`Unparseable order payload: ${JSON.stringify(o).slice(0, 300)}`);
  }
  const fillCount = parseCount(o.fill_count_fp) ?? parseCount(o.fill_count) ?? 0;
  const remainingCount = parseCount(o.remaining_count_fp) ?? parseCount(o.remaining_count) ?? 0;
  const avgFee = parseDollars(o.average_fee_paid_dollars) ?? parseDollars(o.average_fee_paid);
  const legacyFees = (parseDollars(o.taker_fees_dollars) ?? 0) + (parseDollars(o.maker_fees_dollars) ?? 0);
  const feesPaid = avgFee !== undefined ? avgFee * fillCount : (legacyFees > 0 ? legacyFees : undefined);
  return {
    orderId: String(orderId),
    clientOrderId: o.client_order_id ? String(o.client_order_id) : undefined,
    ticker: String(o.ticker ?? o.market_ticker),
    side,
    price,
    status: status(o.status),
    fillCount,
    remainingCount,
    initialCount: parseCount(o.initial_count_fp) ?? parseCount(o.initial_count),
    averageFillPrice: parseDollars(o.average_fill_price_dollars) ?? parseDollars(o.average_fill_price),
    feesPaid,
    lastUpdateReason: o.last_update_reason,
    updatedTs: ts(o.last_update_time ?? o.updated_time ?? o.created_time),
  };
}

export function parseFill(raw: Obj): ExchangeFill {
  const f: Obj = raw.fill ?? raw;
  const side = toBookSide(f.side, f.action);
  const price = yesPrice(f);
  const count = parseCount(f.count_fp) ?? parseCount(f.count);
  const tradeId = f.trade_id ?? f.fill_id;
  if (!tradeId || !side || price === undefined || count === undefined) {
    throw new Error(`Unparseable fill payload: ${JSON.stringify(f).slice(0, 300)}`);
  }
  return {
    tradeId: String(tradeId),
    orderId: String(f.order_id ?? ''),
    clientOrderId: f.client_order_id ? String(f.client_order_id) : undefined,
    ticker: String(f.ticker ?? f.market_ticker),
    side,
    count,
    price,
    isTaker: Boolean(f.is_taker),
    fee: parseDollars(f.fee_cost_dollars) ?? parseDollars(f.fee_dollars) ?? parseDollars(f.fee_cost),
    ts: ts(f.created_time ?? f.ts) ?? Date.now(),
  };
}

export function parsePositions(raw: Obj): ExchangePosition[] {
  const rows: Obj[] = raw.market_positions ?? raw.positions ?? [];
  return rows
    .map((p) => ({ ticker: String(p.ticker ?? p.market_ticker), position: parseCount(p.position_fp) ?? parseCount(p.position) ?? NaN }))
    .filter((p) => Number.isFinite(p.position));
}

export function parseBalance(raw: Obj): number | undefined {
  return parseDollars(raw.balance_dollars) ?? parseDollars(raw.balance, true);
}

export function parseMarket(m: Obj): MarketInfo | undefined {
  const openTime = ts(m.open_time);
  const closeTime = ts(m.close_time ?? m.expected_expiration_time);
  if (!m.ticker || openTime === undefined || closeTime === undefined) return undefined;
  const strike = parseDollars(m.floor_strike);
  const tick = parseDollars(m.tick_size_dollars) ?? (typeof m.tick_size === 'number' ? m.tick_size / 100 : undefined);
  return {
    ticker: String(m.ticker),
    seriesTicker: String(m.series_ticker ?? String(m.event_ticker ?? m.ticker).split('-')[0]),
    eventTicker: m.event_ticker,
    status: String(m.status ?? ''),
    openTime,
    closeTime,
    floorStrike: strike !== undefined && strike > 0 ? strike : undefined,
    tickSize: tick && tick > 0 ? tick : 0.01,
    result: m.result,
  };
}

export function parseSeriesFees(raw: Obj): SeriesFeeInfo | undefined {
  const s: Obj = raw.series ?? raw;
  const mult = parseCount(s.fee_multiplier);
  const type = s.fee_type ? String(s.fee_type) : undefined;
  if (mult === undefined && !type) return undefined;
  // `fee_type` names the schedule; `fee_multiplier` scales the taker fee.
  // Maker multiplier is 0 unless the schedule says otherwise.
  const makerMult = parseCount(s.maker_fee_multiplier) ?? 0;
  return { takerMultiplier: mult ?? 1, makerMultiplier: makerMult, feeType: type };
}

/** Parse the REST orderbook (YES bids and NO bids) into a YES bid/ask book. */
export function parseOrderbook(raw: Obj): { bids: BookLevel[]; asks: BookLevel[] } {
  const ob: Obj = raw.orderbook_fp ?? raw.orderbook ?? raw;
  const yes = levels(ob.yes_dollars ?? ob.yes, !ob.yes_dollars);
  const no = levels(ob.no_dollars ?? ob.no, !ob.no_dollars);
  const bids = yes.sort((a, b) => b.price - a.price);
  const asks = no.map((l) => ({ price: Math.round((1 - l.price) * 10000) / 10000, size: l.size })).sort((a, b) => a.price - b.price);
  return { bids, asks };
}

function levels(rows: unknown, legacyCents: boolean): BookLevel[] {
  if (!Array.isArray(rows)) return [];
  const out: BookLevel[] = [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const price = parseDollars(r[0], legacyCents && Number(r[0]) > 1);
    const size = parseCount(r[1]);
    if (price !== undefined && size !== undefined && size > 0) out.push({ price, size });
  }
  return out;
}

export function formatPrice(p: number): string {
  return p.toFixed(4);
}

export function formatCount(c: number): string {
  return c.toFixed(2);
}

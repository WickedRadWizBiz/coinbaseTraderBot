// Wire-format parsing for Kalshi REST and WebSocket payloads.
//
// Kalshi migrated to fixed-point dollar strings (`*_dollars`, `*_fp`) and the V2
// single-book (`bid`/`ask` on YES) order model; older payloads use integer cents
// and yes/no + buy/sell. Everything format-specific lives here so it can be
// checked against the demo environment in one place. Unknown or missing
// numeric fields parse to undefined and callers must fail closed.

import { parseCount, parseDollars } from '../util/num';
import { parsePriceRanges } from './priceGrid';
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
  // `book_side` (bid/ask) is the current field; `side` + `action` are the deprecated ones.
  const side = toBookSide(o.book_side ?? o.side, o.action);
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

/** POST /portfolio/events/orders (Create Order V2) replies with the outcome only: {order_id, client_order_id,
 *  fill_count, remaining_count, average_fill_price?, average_fee_paid?, ts_ms}. The ticker, side and price are the
 *  request's. For IOC orders remaining_count is already the final state (the unfilled rest canceled). A full order
 *  object (older servers) is parsed as before. */
export function parseCreatedOrder(raw: Obj, req: { ticker: string; side: BookSide; price: number; count: number; clientOrderId?: string }): ExchangeOrder {
  const o: Obj = raw.order ?? raw;
  if (o.ticker !== undefined && (o.book_side !== undefined || o.side !== undefined)) return parseOrder(raw);
  const orderId = o.order_id ?? o.id;
  const fillCount = parseCount(o.fill_count_fp) ?? parseCount(o.fill_count);
  const remaining = parseCount(o.remaining_count_fp) ?? parseCount(o.remaining_count);
  if (!orderId || fillCount === undefined || remaining === undefined) throw new Error(`Unparseable order payload: ${JSON.stringify(o).slice(0, 300)}`);
  const avgFee = parseDollars(o.average_fee_paid_dollars) ?? parseDollars(o.average_fee_paid);
  return {
    orderId: String(orderId),
    clientOrderId: o.client_order_id ? String(o.client_order_id) : req.clientOrderId,
    ticker: req.ticker,
    side: req.side,
    price: req.price,
    status: remaining > 1e-9 ? 'resting' : fillCount > 1e-9 ? 'executed' : 'canceled',
    fillCount,
    remainingCount: remaining,
    initialCount: req.count,
    averageFillPrice: parseDollars(o.average_fill_price_dollars) ?? parseDollars(o.average_fill_price),
    feesPaid: avgFee !== undefined ? avgFee * fillCount : undefined,
    updatedTs: ts(o.ts_ms),
  };
}

export function parseFill(raw: Obj): ExchangeFill {
  const f: Obj = raw.fill ?? raw;
  const side = toBookSide(f.book_side ?? f.side, f.action);
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
    wire: Object.fromEntries(FILL_WIRE_KEYS.filter((k) => f[k] !== undefined).map((k) => [k, f[k]])),
  };
}

const FILL_WIRE_KEYS = ['book_side', 'outcome_side', 'side', 'action', 'purchased_side', 'yes_price_dollars', 'no_price_dollars', 'price_dollars', 'count_fp', 'post_position_fp', 'subaccount', 'subaccount_number'];

export function parsePositions(raw: Obj): ExchangePosition[] {
  const rows: Obj[] = raw.market_positions ?? raw.positions ?? [];
  return rows
    .map((p) => ({ ticker: String(p.ticker ?? p.market_ticker), position: parseCount(p.position_fp) ?? parseCount(p.position) ?? NaN }))
    .filter((p) => Number.isFinite(p.position));
}

export function parseBalance(raw: Obj): number | undefined {
  return parseDollars(raw.balance_dollars) ?? parseDollars(raw.balance, true);
}

/** Available cash per exchange shard (GET /portfolio/balance `balance_breakdown`): Kalshi runs each market category
 *  on its own matching engine (shard 2 crypto, 3 tennis/baseball/basketball, 0 everything else) and checks an order's
 *  collateral on its shard only. Undefined when the response has no breakdown. */
export function parseBalanceBreakdown(raw: Obj): Record<number, number> | undefined {
  if (!Array.isArray(raw.balance_breakdown)) return undefined;
  const out: Record<number, number> = {};
  for (const b of raw.balance_breakdown as Obj[]) {
    const i = Number(b?.exchange_index), v = parseDollars(b?.balance);
    if (Number.isInteger(i) && i >= 0 && v !== undefined) out[i] = (out[i] ?? 0) + v;
  }
  return out;
}

/** The strike in a ladder ticker's last segment: B = range centred there, T = threshold. */
export function tickerStrikeOf(ticker: string): { kind: 'B' | 'T'; value: number } | undefined {
  const r = /-([BT])(\d+(?:\.\d+)?)$/.exec(ticker);
  const v = r ? Number(r[2]) : NaN;
  return r && Number.isFinite(v) && v > 0 ? { kind: r[1] as 'B' | 'T', value: v } : undefined;
}

/** Fill floor / cap strikes Kalshi omitted from the tickers: a range's bounds are its centre +/- half the
 *  spacing between neighbouring range centres in the same event; a threshold's floor is its value. */
export function fillTickerStrikes<M extends { eventTicker?: string; strikeType?: string; floorStrike?: number; capStrike?: number; tickerStrike?: { kind: 'B' | 'T'; value: number } }>(markets: M[]): M[] {
  const byEvent = new Map<string, M[]>();
  for (const m of markets) if (m.tickerStrike?.kind === 'B') (byEvent.get(m.eventTicker ?? '') ?? byEvent.set(m.eventTicker ?? '', []).get(m.eventTicker ?? '')!).push(m);
  for (const ms of byEvent.values()) {
    const cs = [...new Set(ms.map((m) => m.tickerStrike!.value))].sort((a, b) => a - b);
    let w = Infinity;
    for (let i = 1; i < cs.length; i++) w = Math.min(w, cs[i] - cs[i - 1]);
    if (!Number.isFinite(w)) continue;
    for (const m of ms) if (m.floorStrike === undefined || m.capStrike === undefined) {
      const c = m.tickerStrike!.value;
      m.floorStrike ??= +(c - w / 2).toPrecision(12);
      m.capStrike ??= +(c + w / 2).toPrecision(12);
    }
  }
  for (const m of markets) {
    if (m.tickerStrike?.kind !== 'T' || m.floorStrike !== undefined || m.capStrike !== undefined) continue;
    if (/^less/i.test(m.strikeType ?? '')) m.capStrike = m.tickerStrike.value; else m.floorStrike = m.tickerStrike.value;
  }
  return markets;
}

export function parseMarket(m: Obj): MarketInfo | undefined {
  const openTime = ts(m.open_time);
  const closeTime = ts(m.close_time ?? m.expected_expiration_time);
  if (!m.ticker || openTime === undefined || closeTime === undefined) return undefined;
  const strike = parseDollars(m.floor_strike);
  const cap = parseDollars(m.cap_strike);
  const tick = parseDollars(m.tick_size_dollars) ?? (typeof m.tick_size === 'number' ? m.tick_size / 100 : undefined);
  return {
    ticker: String(m.ticker),
    seriesTicker: String(m.series_ticker ?? String(m.event_ticker ?? m.ticker).split('-')[0]),
    eventTicker: m.event_ticker,
    status: String(m.status ?? ''),
    openTime,
    closeTime,
    floorStrike: strike !== undefined && strike > 0 ? strike : undefined,
    capStrike: cap !== undefined && cap > 0 ? cap : undefined,
    strikeType: m.strike_type ? String(m.strike_type) : tickerStrikeOf(String(m.ticker))?.kind === 'B' ? 'between' : undefined,
    tickerStrike: tickerStrikeOf(String(m.ticker)),
    yesMid: (() => {
      const b = parseDollars(m.yes_bid_dollars) ?? parseDollars(m.yes_bid, true);
      const k = parseDollars(m.yes_ask_dollars) ?? parseDollars(m.yes_ask, true);
      if (b !== undefined && k !== undefined && b > 0 && k > b && k < 1) return (b + k) / 2;
      const l = parseDollars(m.last_price_dollars) ?? parseDollars(m.last_price, true);
      return l !== undefined && l > 0 && l < 1 ? l : undefined;
    })(),
    tickSize: tick && tick > 0 ? tick : 0.01,
    priceRanges: parsePriceRanges(m.price_ranges),
    exchangeIndex: Number.isInteger(m.exchange_index) && m.exchange_index >= 0 ? m.exchange_index : undefined,
    result: m.result,
    title: m.title ?? m.yes_sub_title ?? undefined,
    // Sports: scheduled start when the exchange publishes one (field name unverified; several tried).
    startTime: ts(m.occurrence_datetime ?? m.expected_start_time ?? m.event_start_time ?? m.start_time),
  };
}

export function parseSeriesFees(raw: Obj): SeriesFeeInfo | undefined {
  const s: Obj = raw.series ?? raw;
  const mult = Number(s.fee_multiplier);
  const type = s.fee_type ? String(s.fee_type) : undefined;
  if (!Number.isFinite(mult) && !type) return undefined;
  // `fee_type` names the schedule's table, `fee_multiplier` scales it (bot/kalshi/feeSchedule.ts).
  return { feeType: type, multiplier: s.fee_multiplier !== undefined && s.fee_multiplier !== null && Number.isFinite(mult) ? mult : undefined };
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

/** GET /portfolio/settlements row -> dollars (revenue is in cents on the wire). */
export function parseSettlement(r: Obj): { ticker: string; result: 'yes' | 'no' | 'scalar'; yesCount: number; noCount: number; yesCost: number; noCost: number; revenue: number; fees: number; ts: number } | undefined {
  const ts = Date.parse(String(r.settled_time ?? ''));
  const result = r.market_result === 'yes' || r.market_result === 'no' || r.market_result === 'scalar' ? r.market_result : undefined;
  if (!r.ticker || !result || !Number.isFinite(ts)) return undefined;
  return {
    ticker: String(r.ticker), result,
    yesCount: parseCount(r.yes_count_fp) ?? parseCount(r.yes_count) ?? 0,
    noCount: parseCount(r.no_count_fp) ?? parseCount(r.no_count) ?? 0,
    yesCost: parseDollars(r.yes_total_cost_dollars) ?? parseDollars(r.yes_total_cost, true) ?? 0,
    noCost: parseDollars(r.no_total_cost_dollars) ?? parseDollars(r.no_total_cost, true) ?? 0,
    revenue: Number(r.revenue ?? 0) / 100,
    fees: parseDollars(r.fee_cost) ?? 0,
    ts,
  };
}

/** GET /portfolio/deposits | withdrawals row -> dollars, ms. */
export function parseTransfer(r: Obj, kind: 'deposit' | 'withdrawal'): { id: string; kind: 'deposit' | 'withdrawal'; amount: number; status: string; ts: number } | undefined {
  const cents = Number(r.amount_cents), sec = Number(r.finalized_ts ?? r.created_ts);
  if (!r.id || !Number.isFinite(cents) || !Number.isFinite(sec)) return undefined;
  return { id: String(r.id), kind, amount: cents / 100, status: String(r.status ?? ''), ts: sec < 1e12 ? sec * 1000 : sec };
}

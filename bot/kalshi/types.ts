// Normalized exchange types. All prices are YES-side dollars; the adapter
// converts to and from Kalshi's wire format. Book side on the wire (V2):
//   bid = buy YES at price     |  ask = sell YES at price (== buy NO at 1 - price)

import type { PriceBand } from './priceGrid';
export type BookSide = 'bid' | 'ask';
export type TimeInForce = 'fill_or_kill' | 'good_till_canceled' | 'immediate_or_cancel';
export type SelfTradePrevention = 'taker_at_cross' | 'maker';

export interface CreateOrderRequest {
  ticker: string;
  side: BookSide;
  /** Contracts (0.01 granularity). */
  count: number;
  /** YES-side limit price in dollars. */
  price: number;
  timeInForce: TimeInForce;
  postOnly: boolean;
  reduceOnly: boolean;
  selfTradePrevention: SelfTradePrevention;
  clientOrderId: string;
  /** Unix seconds; GTC only. */
  expirationTime?: number;
  cancelOnPause?: boolean;
  subaccount?: number;
}

export type ExchangeOrderStatus = 'resting' | 'canceled' | 'executed' | 'pending' | 'unknown';

export interface ExchangeOrder {
  orderId: string;
  clientOrderId?: string;
  ticker: string;
  side: BookSide;
  price: number;
  status: ExchangeOrderStatus;
  fillCount: number;
  remainingCount: number;
  initialCount?: number;
  averageFillPrice?: number;
  /** Total fees paid on this order so far (dollars), when reported. */
  feesPaid?: number;
  lastUpdateReason?: string;
  updatedTs?: number;
}

export interface ExchangeFill {
  tradeId: string;
  orderId: string;
  clientOrderId?: string;
  ticker: string;
  side: BookSide;
  count: number;
  /** YES-side execution price in dollars. */
  price: number;
  isTaker: boolean;
  /** Fee for this fill in dollars, when the exchange reports it. */
  fee?: number;
  ts: number;
  /** Kalshi's direction and price fields as sent (the audit keeps them for fills the bot did not place). */
  wire?: Record<string, unknown>;
}

export interface ExchangePosition {
  ticker: string;
  /** Signed YES contracts: positive = long YES, negative = long NO. */
  position: number;
}

export interface MarketInfo {
  ticker: string;
  seriesTicker: string;
  eventTicker?: string;
  status: string;
  openTime: number;
  closeTime: number;
  /** Strike for up/down markets (the opening 60s average), when published. */
  floorStrike?: number;
  /** Upper strike for range ('between') and 'less' markets. */
  capStrike?: number;
  /** Strike written in the ticker ("-B0.097" = a range centred there, "-T85699.99" = above it), used when
   *  Kalshi omits floor_strike / cap_strike. */
  tickerStrike?: { kind: 'B' | 'T'; value: number };
  /** Kalshi's own YES price for the market in the listing (bid/ask mid, else last trade): picks the
   *  at-the-money strikes without any outside price. */
  yesMid?: number;
  /** Kalshi strike_type: greater, greater_or_equal, less, between, ... */
  strikeType?: string;
  tickSize: number;
  /** Valid price bands (price_ranges): the source of truth for the price grid (bot/kalshi/priceGrid.ts). */
  priceRanges?: PriceBand[];
  result?: 'yes' | 'no' | '';
  /** Market title (sports: player / match / tournament). */
  title?: string;
  /** Scheduled event start, when published (sports). */
  startTime?: number;
  /** The exchange shard (matching engine) the market trades on: its orders are collateralized from that shard's cash. */
  exchangeIndex?: number;
}

/** GET /series/{t}: the series' fee structure. bot/kalshi/feeSchedule.ts turns it into maker and taker multipliers. */
export interface SeriesFeeInfo {
  /** quadratic, quadratic_with_maker_fees, quadratic_with_combo_maker_fees or flat. */
  feeType?: string;
  multiplier?: number;
}

export interface BookLevel { price: number; size: number }

export interface BookSnapshot {
  ticker: string;
  /** YES bids, best (highest) first. */
  bids: BookLevel[];
  /** YES asks, best (lowest) first. */
  asks: BookLevel[];
  ts: number;
}

/** The single order path. Implemented by the live Kalshi REST client and the
 * paper exchange, so paper and live exercise identical OMS/risk code. */
export interface ExchangeGateway {
  readonly name: string;
  /** When the exchange last validated balance / orders / fills / positions (GET /exchange/user_data_timestamp). */
  getUserDataTimestamp?(): Promise<number | undefined>;
  createOrder(req: CreateOrderRequest): Promise<ExchangeOrder>;
  /** `ticker` routes the cancel to the market's exchange shard (Kalshi needs it for orders off shard 0). */
  cancelOrder(orderId: string, ticker?: string): Promise<void>;
  getOrder(orderId: string): Promise<ExchangeOrder | undefined>;
  findOrderByClientId(clientOrderId: string, ticker: string): Promise<ExchangeOrder | undefined>;
  getOpenOrders(): Promise<ExchangeOrder[]>;
  getFills(sinceTs: number): Promise<ExchangeFill[]>;
  /** One market's fills since `sinceTs` (reconciliation looks further back on a market whose position disagrees). */
  getFillsForTicker?(ticker: string, sinceTs: number): Promise<ExchangeFill[]>;
  getPositions(): Promise<ExchangePosition[]>;
  getBalance(): Promise<number>;
  /** Cash per exchange shard from the last getBalance() (live Kalshi only; undefined when not reported). */
  shardBalances?(): Record<number, number> | undefined;
  /** When the account's location attestation for API trading expires (unix seconds): null = never attested,
   *  undefined = unknown. Without it Kalshi refuses API orders on Sports, Elections and Entertainment markets. */
  getLocationAttestation?(): Promise<number | null | undefined>;
}

/** Order submit failed in a way where the order may or may not exist. */
export class OrderStateUnknownError extends Error {}
/** The exchange definitively rejected the order. */
export class OrderRejectedError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); }
}

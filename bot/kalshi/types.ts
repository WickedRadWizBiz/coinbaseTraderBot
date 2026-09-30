// Normalized exchange types. All prices are YES-side dollars; the adapter
// converts to and from Kalshi's wire format. Book side on the wire (V2):
//   bid = buy YES at price     |  ask = sell YES at price (== buy NO at 1 - price)

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
  /** Kalshi strike_type: greater, greater_or_equal, less, between, ... */
  strikeType?: string;
  tickSize: number;
  result?: 'yes' | 'no' | '';
  /** Market title (sports: player / match / tournament). */
  title?: string;
  /** Scheduled event start, when published (sports). */
  startTime?: number;
}

export interface SeriesFeeInfo {
  takerMultiplier: number;
  makerMultiplier: number;
  feeType?: string;
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
  createOrder(req: CreateOrderRequest): Promise<ExchangeOrder>;
  cancelOrder(orderId: string): Promise<void>;
  getOrder(orderId: string): Promise<ExchangeOrder | undefined>;
  findOrderByClientId(clientOrderId: string, ticker: string): Promise<ExchangeOrder | undefined>;
  getOpenOrders(): Promise<ExchangeOrder[]>;
  getFills(sinceTs: number): Promise<ExchangeFill[]>;
  getPositions(): Promise<ExchangePosition[]>;
  getBalance(): Promise<number>;
}

/** Order submit failed in a way where the order may or may not exist. */
export class OrderStateUnknownError extends Error {}
/** The exchange definitively rejected the order. */
export class OrderRejectedError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); }
}

// Kalshi Perps REST client (separate exchange host and rate-limit buckets).
//   prod  https://external-api.kalshi.com/trade-api/v2
//   demo  https://external-api.demo.kalshi.co/trade-api/v2
// Public: /margin/markets, /margin/funding_rates/estimate.
// Authenticated (perps API key, signed like the prediction API):
//   POST /margin/orders, DELETE /margin/orders/{id}, GET /margin/orders,
//   GET /margin/positions, GET /margin/balance.
// Order creation is sent exactly once per call; timeouts surface as
// OrderStateUnknownError so the caller can look the order up before resending.

import type { KalshiSigner } from '../kalshi/auth';
import { KalshiRateLimiter, REQUEST_COST } from '../kalshi/rateLimiter';
import { OrderRejectedError, OrderStateUnknownError } from '../kalshi/types';
import { parseFundingEstimate, parseMarginMarket, type PerpSnapshot } from './perpData';

export const PERPS_URLS = {
  prod: 'https://external-api.kalshi.com/trade-api/v2',
  demo: 'https://external-api.demo.kalshi.co/trade-api/v2',
};

export interface PerpOrderRequest {
  ticker: string;
  side: 'bid' | 'ask';
  count: number;
  price: number;
  clientOrderId: string;
  postOnly: boolean;
  reduceOnly: boolean;
  expirationTime?: number;
  timeInForce?: 'good_till_canceled' | 'immediate_or_cancel';
}

export interface PerpOrder { orderId: string; clientOrderId?: string; ticker: string; side: 'bid' | 'ask'; price: number; remaining: number; status: string }
export interface PerpPosition { ticker: string; position: number; entryPrice?: number; unrealizedPnl?: number; marginUsed?: number }

/** What the hedger needs from an exchange: implemented by the live client and the paper simulator. */
export interface PerpGateway {
  readonly name: string;
  createOrder(req: PerpOrderRequest): Promise<PerpOrder>;
  cancelOrder(orderId: string): Promise<void>;
  getOpenOrders(): Promise<PerpOrder[]>;
  getPositions(): Promise<PerpPosition[]>;
}

const n = (v: unknown) => { const x = typeof v === 'number' ? v : Number(v); return Number.isFinite(x) ? x : undefined; };

export function parsePerpOrder(o: Record<string, any>): PerpOrder {
  return {
    orderId: String(o.order_id ?? o.id), clientOrderId: o.client_order_id, ticker: String(o.ticker ?? o.market_ticker), side: o.side === 'ask' ? 'ask' : 'bid',
    price: n(o.price_dollars ?? o.price) ?? NaN, remaining: n(o.remaining_count_fp ?? o.remaining_count) ?? 0, status: String(o.status ?? ''),
  };
}

export function parsePerpPositions(raw: Record<string, any>): PerpPosition[] {
  const rows: any[] = raw.positions ?? raw.margin_positions ?? raw.market_positions ?? [];
  return rows.map((p) => ({
    ticker: String(p.market_ticker ?? p.ticker), position: n(p.position_fp ?? p.position) ?? NaN,
    entryPrice: n(p.entry_price), unrealizedPnl: n(p.unrealized_pnl), marginUsed: n(p.margin_used),
  })).filter((p) => Number.isFinite(p.position));
}

export class KalshiPerpsRest implements PerpGateway {
  readonly name = 'kalshi-perps';
  private readonly base: string;
  private readonly prefix: string;
  private readonly limiter = new KalshiRateLimiter();

  constructor(baseUrl: string, private readonly signer?: KalshiSigner, private readonly fetchImpl: typeof fetch = fetch, private readonly subaccount?: number) {
    this.base = baseUrl.replace(/\/$/, '');
    this.prefix = new URL(this.base).pathname.replace(/\/$/, '');
  }

  private async call(method: string, path: string, body?: unknown, auth = false): Promise<any> {
    await (method === 'GET' ? this.limiter.read : this.limiter.write).take(REQUEST_COST);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      if (!this.signer) throw new Error(`perps call ${method} ${path} needs KALSHI_PERPS_KEY_ID / KALSHI_PERPS_PRIVATE_KEY_PATH`);
      Object.assign(headers, this.signer.headers(method, this.prefix + path));
    }
    const res = await this.fetchImpl(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`perps HTTP ${res.status}: ${text.slice(0, 300)}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  }

  /** Every active perp market on a known asset. */
  async markets(assets: Iterable<string>, now = Date.now()): Promise<PerpSnapshot[]> {
    const raw = await this.call('GET', '/margin/markets?status=active');
    const rows: any[] = Array.isArray(raw) ? raw : raw.markets ?? [];
    const list = [...assets];
    return rows.map((m) => parseMarginMarket(m, list, now)).filter((x): x is PerpSnapshot => Boolean(x));
  }

  async fundingEstimate(ticker: string) {
    return parseFundingEstimate(await this.call('GET', `/margin/funding_rates/estimate?ticker=${encodeURIComponent(ticker)}`));
  }

  async createOrder(r: PerpOrderRequest): Promise<PerpOrder> {
    const body = {
      ticker: r.ticker, client_order_id: r.clientOrderId, side: r.side, count: r.count.toFixed(2), price: r.price.toFixed(4),
      time_in_force: r.timeInForce ?? 'good_till_canceled', self_trade_prevention_type: 'taker_at_cross', post_only: r.postOnly, reduce_only: r.reduceOnly,
      cancel_order_on_pause: true, ...(r.expirationTime && r.timeInForce !== 'immediate_or_cancel' ? { expiration_time: r.expirationTime } : {}), ...(this.subaccount !== undefined ? { subaccount: this.subaccount } : {}),
    };
    try {
      const raw = await this.call('POST', '/margin/orders', body, true);
      return parsePerpOrder(raw.order ?? raw);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status !== undefined && status >= 400 && status < 500) throw new OrderRejectedError(String((e as Error).message), status);
      throw new OrderStateUnknownError(String((e as Error).message));
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    const q = this.subaccount !== undefined ? `?subaccount=${this.subaccount}` : '';
    await this.call('DELETE', `/margin/orders/${encodeURIComponent(orderId)}${q}`, undefined, true);
  }

  async getOpenOrders(): Promise<PerpOrder[]> {
    const raw = await this.call('GET', '/margin/orders?status=resting', undefined, true);
    return (raw.orders ?? []).map(parsePerpOrder);
  }

  async getPositions(): Promise<PerpPosition[]> {
    return parsePerpPositions(await this.call('GET', `/margin/positions${this.subaccount !== undefined ? `?subaccount=${this.subaccount}` : ''}`, undefined, true));
  }
}

// Kalshi Perps REST client (separate exchange host and rate-limit buckets).
//   prod  https://external-api.kalshi.com/trade-api/v2
//   demo  https://external-api.demo.kalshi.co/trade-api/v2
// Public: /margin/markets, /margin/funding_rates/estimate.
// Authenticated (perps API key, signed like the prediction API):
//   POST /margin/orders, DELETE /margin/orders/{id}, GET /margin/orders,
//   GET /margin/positions, GET /margin/balance, GET /margin/risk, GET /margin/enabled,
//   PUT/DELETE /margin/cross/positions/{ticker}/exit_trigger (exchange-side stop-loss).
// Field names follow the perps OpenAPI spec (specs/perps_openapi.yaml in the public
// kalshi-python-sdk). Rules from the spec enforced here:
//  - reduce_only is only accepted on immediate_or_cancel / fill_or_kill orders.
//  - count and price are fixed-point strings; prices are per contract, in dollars (4 dp).
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
  timeInForce?: 'good_till_canceled' | 'immediate_or_cancel' | 'fill_or_kill';
}

export interface PerpOrder { orderId: string; clientOrderId?: string; ticker: string; side: 'bid' | 'ask'; price: number; remaining: number; status: string }
export interface PerpPosition { ticker: string; position: number; entryPrice?: number; unrealizedPnl?: number; marginUsed?: number }
export interface PerpBalance { equity: number; available?: number; maintenanceMargin?: number; initialMargin?: number }
export interface PerpRiskPosition { ticker: string; position: number; mark?: number; notional?: number; leverage?: number; liquidationPrice?: number }

/** What the perp executor needs from an exchange: implemented by the live client and the paper simulator. */
export interface PerpGateway {
  readonly name: string;
  createOrder(req: PerpOrderRequest): Promise<PerpOrder>;
  cancelOrder(orderId: string): Promise<void>;
  getOpenOrders(): Promise<PerpOrder[]>;
  getPositions(): Promise<PerpPosition[]>;
  /** Margin-account equity (directional sizing and the perp daily loss stop). */
  getBalance?(): Promise<PerpBalance>;
  /** Per-position liquidation estimates. */
  getRisk?(): Promise<PerpRiskPosition[]>;
  /** Exchange-side stop-loss on the whole position (fires a reduce-only order on the liquidation mark). */
  setStopLoss?(ticker: string, stopPrice: number): Promise<void>;
  clearStopLoss?(ticker: string): Promise<void>;
}

/** The exchange accepts reduce_only only on IOC / FOK orders; a resting reduction must be a plain post-only order. */
export function assertReduceOnlyRule(r: PerpOrderRequest): void {
  if (r.reduceOnly && (r.timeInForce ?? 'good_till_canceled') === 'good_till_canceled') throw new OrderRejectedError('reduce_only requires immediate_or_cancel or fill_or_kill', 400);
}

const n = (v: unknown) => { const x = typeof v === 'number' ? v : Number(v); return Number.isFinite(x) ? x : undefined; };

export function parsePerpOrder(o: Record<string, any>, req?: PerpOrderRequest): PerpOrder {
  const remaining = n(o.remaining_count_fp ?? o.remaining_count) ?? 0;
  const filled = n(o.fill_count_fp ?? o.fill_count) ?? 0;
  // CreateMarginOrderResponse carries no ticker/side/price/status: take them from the request.
  const status = o.status ? String(o.status) : remaining > 0 ? 'resting' : filled > 0 ? 'executed' : 'canceled';
  return {
    orderId: String(o.order_id ?? o.id), clientOrderId: o.client_order_id ?? req?.clientOrderId, ticker: String(o.ticker ?? o.market_ticker ?? req?.ticker), side: (o.side ?? req?.side) === 'ask' ? 'ask' : 'bid',
    price: n(o.average_fill_price ?? o.price_dollars ?? o.price) ?? req?.price ?? NaN, remaining, status,
  };
}

/** GET /margin/balance: the entry for our subaccount (0 = primary). */
export function parsePerpBalance(raw: Record<string, any>, subaccount = 0): PerpBalance | undefined {
  const rows: any[] = raw?.subaccount_balances ?? [];
  const r = rows.find((x) => Number(x.subaccount ?? 0) === subaccount) ?? (rows.length === 1 ? rows[0] : undefined);
  if (!r) { const settled = n(raw?.settled_funds); return settled !== undefined ? { equity: settled } : undefined; }
  const equity = n(r.account_equity);
  const available = n(r.available_balance);
  // account_equity is 0 for self-clearing members: fall back to settled funds + position value.
  const eq = equity && equity > 0 ? equity : (n(raw?.settled_funds) ?? 0) + (n(r.position_value) ?? 0);
  return { equity: eq, available: available && available > 0 ? available : undefined, maintenanceMargin: n(r.maintenance_margin), initialMargin: n(r.initial_margin) };
}

/** GET /margin/risk positions. */
export function parsePerpRisk(raw: Record<string, any>): PerpRiskPosition[] {
  return (raw?.positions ?? []).map((p: any) => ({
    ticker: String(p.market_ticker ?? p.ticker), position: n(p.position) ?? 0, mark: n(p.mark_price), notional: n(p.position_notional),
    leverage: n(p.position_leverage), liquidationPrice: n(p.estimated_liquidation_price),
  }));
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
    assertReduceOnlyRule(r);
    const body = {
      ticker: r.ticker, client_order_id: r.clientOrderId, side: r.side, count: r.count.toFixed(2), price: r.price.toFixed(4),
      time_in_force: r.timeInForce ?? 'good_till_canceled', self_trade_prevention_type: 'taker_at_cross', post_only: r.postOnly, reduce_only: r.reduceOnly,
      cancel_order_on_pause: true, ...(r.expirationTime && r.timeInForce !== 'immediate_or_cancel' ? { expiration_time: r.expirationTime } : {}), ...(this.subaccount !== undefined ? { subaccount: this.subaccount } : {}),
    };
    try {
      const raw = await this.call('POST', '/margin/orders', body, true);
      return parsePerpOrder(raw.order ?? raw, r);
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

  async getBalance(): Promise<PerpBalance> {
    const b = parsePerpBalance(await this.call('GET', '/margin/balance?compute_available_balance=true', undefined, true), this.subaccount ?? 0);
    if (!b) throw new Error('margin balance unavailable for this subaccount');
    return b;
  }

  async getRisk(): Promise<PerpRiskPosition[]> {
    return parsePerpRisk(await this.call('GET', `/margin/risk${this.subaccount !== undefined ? `?subaccount=${this.subaccount}` : ''}`, undefined, true));
  }

  /** Whether margin trading is enabled for this account (rolling out member by member). */
  async enabled(): Promise<boolean> {
    return Boolean((await this.call('GET', '/margin/enabled', undefined, true))?.enabled);
  }

  async setStopLoss(ticker: string, stopPrice: number): Promise<void> {
    const q = this.subaccount !== undefined ? `?subaccount=${this.subaccount}` : '';
    await this.call('PUT', `/margin/cross/positions/${encodeURIComponent(ticker)}/exit_trigger${q}`, { kind: 'bracket', stop_loss_price: stopPrice.toFixed(4) }, true);
  }

  async clearStopLoss(ticker: string): Promise<void> {
    const q = this.subaccount !== undefined ? `?subaccount=${this.subaccount}&kind=bracket` : '?kind=bracket';
    await this.call('DELETE', `/margin/cross/positions/${encodeURIComponent(ticker)}/exit_trigger${q}`, undefined, true);
  }
}

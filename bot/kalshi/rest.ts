// Kalshi REST client. One host, one order path (Create Order V2), no FIX, no
// perps, no fallback hosts that could double-submit.
//
// Retry policy:
//  - Reads retry with exponential backoff on 429 / 5xx / network errors.
//  - Order creation is sent exactly once per call. A timeout, network error or
//    5xx raises OrderStateUnknownError; the OMS then queries by
//    client_order_id before any resend (and a resend reuses the same id).

import { logger } from '../util/log';
import type { KalshiSigner } from './auth';
import { KalshiRateLimiter, REQUEST_COST } from './rateLimiter';
import {
  CreateOrderRequest, ExchangeFill, ExchangeGateway, ExchangeOrder, ExchangePosition,
  MarketInfo, OrderRejectedError, OrderStateUnknownError, SeriesFeeInfo, BookSnapshot,
} from './types';
import { formatCount, formatPrice, parseBalance, parseFill, parseMarket, parseOrder, parseOrderbook, parsePositions, parseSeriesFees } from './wire';
import { recordLatency } from '../util/latency';

const log = logger('kalshi-rest');

export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string) { super(`HTTP ${status}: ${body.slice(0, 300)}`); }
}

export interface RestOptions {
  baseUrl: string;
  signer?: KalshiSigner;
  limiter?: KalshiRateLimiter;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  subaccount?: number;
  /** Called with every response's Date header (epoch ms) and the local send/receive times, for the clock-skew guard. */
  onServerDate?: (serverDateMs: number, sentTs: number, recvTs: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class KalshiRest implements ExchangeGateway {
  readonly name = 'kalshi';
  private readonly base: string;
  private readonly prefix: string;
  private readonly limiter: KalshiRateLimiter;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private signPublic = true;

  constructor(private readonly opts: RestOptions) {
    this.base = opts.baseUrl.replace(/\/$/, '');
    this.prefix = new URL(this.base).pathname.replace(/\/$/, '');
    this.limiter = opts.limiter ?? new KalshiRateLimiter();
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async raw(method: string, path: string, body?: unknown, auth = true): Promise<any> {
    const bucket = method === 'GET' ? this.limiter.read : this.limiter.write;
    await bucket.take(REQUEST_COST);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // Public reads are signed too when keys exist: signed requests count against the account's limit
    // instead of the anonymous per-IP one.
    const signed = auth || (!!this.opts.signer && this.signPublic);
    if (signed) {
      if (!this.opts.signer) throw new Error(`Authenticated call ${method} ${path} without credentials`);
      Object.assign(headers, this.opts.signer.headers(method, this.prefix + path));
    }
    const sentTs = Date.now();
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const recvTs = Date.now();
    recordLatency('kalshiRest', recvTs - sentTs, recvTs);
    const dateHeader = res.headers?.get?.('date');
    // A response served from a CDN cache carries the Date of when it was first generated (with an Age
    // header): it says nothing about the exchange's clock now and would make ours look seconds ahead.
    const h = (k: string) => res.headers?.get?.(k) ?? '';
    const cached = Number(h('age')) > 0 || /hit/i.test(h('x-cache')) || /hit/i.test(h('cf-cache-status'));
    if (dateHeader && this.opts.onServerDate && !cached) {
      const d = Date.parse(dateHeader);
      if (Number.isFinite(d)) this.opts.onServerDate(d, sentTs, recvTs);
    }
    const text = await res.text();
    if (res.status === 429) {
      const ms = bucket.rateLimited();
      log.debug('rate limited; pausing requests', { path: path.split('?')[0], pauseMs: ms });
    } else if (res.ok) bucket.ok();
    if (res.status === 401 && signed && !auth) {
      // The key is refused: keep public data flowing unsigned (authenticated calls will report the key problem).
      this.signPublic = false;
      log.warn('signed public request refused (401); public market data continues unsigned', { path: path.split('?')[0] });
      return this.raw(method, path, body, auth);
    }
    if (!res.ok) throw new HttpError(res.status, text);
    return text ? JSON.parse(text) : {};
  }

  /** Read with exponential backoff (Kalshi 429s carry no Retry-After). */
  private async read(path: string, auth = true): Promise<any> {
    let delay = 250;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.raw('GET', path, undefined, auth);
      } catch (e) {
        const retriable = !(e instanceof HttpError) || e.status === 429 || e.status >= 500;
        if (!retriable || attempt >= 4) throw e;
        await sleep(delay + Math.random() * delay * 0.25);
        delay *= 2;
      }
    }
  }

  private async paginate(path: string, key: string, maxPages = 20, auth = true): Promise<any[]> {
    const out: any[] = [];
    let cursor = '';
    for (let i = 0; i < maxPages; i++) {
      const sep = path.includes('?') ? '&' : '?';
      const data = await this.read(`${path}${sep}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, auth);
      out.push(...(data[key] ?? []));
      cursor = data.cursor ?? '';
      if (!cursor) break;
    }
    return out;
  }

  // ---- Orders -------------------------------------------------------------

  async createOrder(req: CreateOrderRequest): Promise<ExchangeOrder> {
    if (req.reduceOnly && req.timeInForce !== 'immediate_or_cancel') {
      throw new OrderRejectedError('reduce_only is only accepted with immediate_or_cancel', 400, 'local_validation');
    }
    if (req.expirationTime !== undefined && req.timeInForce !== 'good_till_canceled') {
      throw new OrderRejectedError('expiration_time is only valid with good_till_canceled', 400, 'local_validation');
    }
    const payload: Record<string, unknown> = {
      ticker: req.ticker,
      side: req.side,
      count: formatCount(req.count),
      price: formatPrice(req.price),
      time_in_force: req.timeInForce,
      post_only: req.postOnly,
      self_trade_prevention_type: req.selfTradePrevention,
      client_order_id: req.clientOrderId,
    };
    if (req.reduceOnly) payload.reduce_only = true;
    if (req.expirationTime !== undefined) payload.expiration_time = req.expirationTime;
    if (req.cancelOnPause) payload.cancel_order_on_pause = true;
    const sub = req.subaccount ?? this.opts.subaccount;
    if (sub !== undefined) payload.subaccount = sub;

    try {
      const data = await this.raw('POST', '/portfolio/events/orders', payload);
      return parseOrder(data);
    } catch (e) {
      if (e instanceof HttpError && e.status >= 400 && e.status < 500) {
        let code: string | undefined;
        try { code = JSON.parse(e.body)?.error?.code; } catch { /* body not JSON */ }
        // 409 on a duplicate client_order_id means our earlier attempt landed.
        if (e.status === 409) throw new OrderStateUnknownError(`duplicate client_order_id ${req.clientOrderId}`);
        throw new OrderRejectedError(e.message, e.status, code ?? (e.status === 429 ? 'rate_limited' : undefined));
      }
      throw new OrderStateUnknownError(`create order ${req.clientOrderId}: ${(e as Error).message}`);
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    try {
      await this.raw('DELETE', `/portfolio/events/orders/${encodeURIComponent(orderId)}`);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        // Older orders may live only on the legacy path; a 404 there too means
        // the order is already gone, which the OMS confirms via getOrder.
        try {
          await this.raw('DELETE', `/portfolio/orders/${encodeURIComponent(orderId)}`);
        } catch (e2) {
          if (e2 instanceof HttpError && e2.status === 404) return;
          throw e2;
        }
        return;
      }
      throw e;
    }
  }

  async getOrder(orderId: string): Promise<ExchangeOrder | undefined> {
    try {
      return parseOrder(await this.read(`/portfolio/orders/${encodeURIComponent(orderId)}`));
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return undefined;
      throw e;
    }
  }

  async findOrderByClientId(clientOrderId: string, ticker: string): Promise<ExchangeOrder | undefined> {
    const rows = await this.paginate(`/portfolio/orders?ticker=${encodeURIComponent(ticker)}`, 'orders', 5);
    const hit = rows.find((o) => o.client_order_id === clientOrderId);
    return hit ? parseOrder(hit) : undefined;
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    const rows = await this.paginate('/portfolio/orders?status=resting', 'orders');
    return rows.map(parseOrder);
  }

  async getFills(sinceTs: number): Promise<ExchangeFill[]> {
    const rows = await this.paginate(`/portfolio/fills?min_ts=${Math.floor(sinceTs / 1000)}`, 'fills');
    const out: ExchangeFill[] = [];
    for (const r of rows) {
      try { out.push(parseFill(r)); } catch (e) { log.error('skipping unparseable fill', { error: String(e) }); }
    }
    return out;
  }

  async getPositions(): Promise<ExchangePosition[]> {
    const rows = await this.paginate('/portfolio/positions', 'market_positions');
    return parsePositions({ market_positions: rows });
  }

  async getBalance(): Promise<number> {
    const b = parseBalance(await this.read('/portfolio/balance'));
    if (b === undefined) throw new Error('balance missing from response');
    return b;
  }

  // ---- Market data (public) ----------------------------------------------

  async getOpenMarkets(seriesTicker: string): Promise<MarketInfo[]> {
    // Hourly ladders list many strikes per close time: page through all of them. (No close-time filter:
    // Kalshi rejects min/max_close_ts combined with status=open; far-dated events are dropped by the caller.)
    const rows = await this.paginate(`/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=open`, 'markets', 10, false);
    return rows.map(parseMarket).filter(Boolean) as MarketInfo[];
  }

  /** Every series in a category (public), e.g. "Crypto": ticker, title, frequency. */
  async listSeries(category: string): Promise<Array<{ ticker: string; title?: string; frequency?: string }>> {
    const data = await this.read(`/series?category=${encodeURIComponent(category)}`, false);
    return (data.series ?? []).map((s: any) => ({ ticker: String(s.ticker), title: s.title, frequency: s.frequency }));
  }

  /** Milestones linked to an event (sports: the real-world match), e.g. for live scores. */
  async getMilestones(eventTicker: string): Promise<Array<{ id: string; type: string; title?: string }>> {
    const data = await this.read(`/milestones?limit=10&related_event_ticker=${encodeURIComponent(eventTicker)}`, false);
    return (data.milestones ?? []).map((m: any) => ({ id: String(m.id), type: String(m.type), title: m.title }));
  }

  /** Live data for a milestone: { type, details } (details is sport-specific and undocumented). */
  async getLiveData(type: string, milestoneId: string): Promise<{ type: string; details: unknown } | undefined> {
    const data = await this.read(`/live_data/${encodeURIComponent(type)}/milestone/${encodeURIComponent(milestoneId)}`, false);
    const ld = data.live_data ?? data;
    return ld ? { type: String(ld.type ?? type), details: ld.details } : undefined;
  }

  /** GET /exchange/status (public): exchange_active, trading_active, estimated resume time. */
  async getExchangeStatus(): Promise<Record<string, any>> { return this.read('/exchange/status', false); }

  /** GET /exchange/schedule (public): standard hours and maintenance windows. */
  async getExchangeSchedule(): Promise<Record<string, any>> { return this.read('/exchange/schedule', false); }

  /** GET /exchange/user_data_timestamp: when balance / orders / fills / positions were last validated (ms). */
  async getUserDataTimestamp(): Promise<number | undefined> {
    const d = await this.read('/exchange/user_data_timestamp');
    const t = Date.parse(String(d?.as_of_time ?? ''));
    return Number.isFinite(t) ? t : undefined;
  }

  /** GET /series/fee_changes (public): scheduled fee changes (series_ticker, fee_type, fee_multiplier, scheduled_ts). */
  async getSeriesFeeChanges(seriesTicker?: string): Promise<Array<{ seriesTicker: string; feeType?: string; multiplier?: number; scheduledTs: number }>> {
    const d = await this.read(`/series/fee_changes${seriesTicker ? `?series_ticker=${encodeURIComponent(seriesTicker)}` : ''}`, false);
    return (d?.series_fee_change_arr ?? []).map((c: any) => ({ seriesTicker: String(c.series_ticker), feeType: c.fee_type ? String(c.fee_type) : undefined, multiplier: Number.isFinite(Number(c.fee_multiplier)) ? Number(c.fee_multiplier) : undefined, scheduledTs: Date.parse(String(c.scheduled_ts)) }))
      .filter((c: { scheduledTs: number }) => Number.isFinite(c.scheduledTs));
  }

  async getMarket(ticker: string): Promise<MarketInfo | undefined> {
    const data = await this.read(`/markets/${encodeURIComponent(ticker)}`, false);
    return parseMarket(data.market ?? data);
  }

  async getSeriesFees(seriesTicker: string): Promise<SeriesFeeInfo | undefined> {
    const data = await this.read(`/series/${encodeURIComponent(seriesTicker)}`, false);
    return parseSeriesFees(data);
  }

  /** Raw public trades for a market since `sinceTs` (ms). */
  async getRecentTrades(ticker: string, sinceTs: number): Promise<any[]> {
    const data = await this.read(`/markets/trades?ticker=${encodeURIComponent(ticker)}&min_ts=${Math.floor(sinceTs / 1000)}&limit=200`, false);
    return data.trades ?? [];
  }

  async getOrderbook(ticker: string): Promise<BookSnapshot> {
    const data = await this.read(`/markets/${encodeURIComponent(ticker)}/orderbook`, false);
    return { ticker, ...parseOrderbook(data), ts: Date.now() };
  }
}

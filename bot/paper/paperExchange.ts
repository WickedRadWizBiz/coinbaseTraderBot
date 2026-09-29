// Paper exchange implementing the same ExchangeGateway as live Kalshi, so
// paper/shadow trading runs the identical OMS, risk and reconciliation code.
//
// Fill realism (conservative by design):
//  - IOC/FOK orders walk the visible book and pay taker fees.
//  - Resting orders join the BACK of their price level (queue ahead = visible
//    size at that price when placed).
//  - Resting orders fill only when public trades print: a trade at a price
//    through ours fills us fully; a trade at our price first consumes the
//    queue ahead. Book changes alone never fill us.
//  - Post-only orders that would cross are rejected, like the exchange.
//  - No bankroll refills. Drawdowns stay visible.

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { orderFee, type FeeSchedule } from '../fees';
import type { OrderBook } from '../marketdata/orderBook';
import {
  CreateOrderRequest, ExchangeFill, ExchangeGateway, ExchangeOrder, ExchangePosition, OrderRejectedError,
} from '../kalshi/types';
import { readJson, writeJsonAtomic } from '../util/persist';

interface PaperOrder extends ExchangeOrder {
  queueAhead: number;
  postOnly: boolean;
  reduceOnly: boolean;
  expirationTime?: number;
  count: number;
}

interface PaperState {
  balance: number;
  positions: Record<string, number>;
  fills: ExchangeFill[];
  orders: PaperOrder[];
}

export class PaperExchange extends EventEmitter implements ExchangeGateway {
  readonly name = 'paper';
  private st: PaperState;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    /** State file; undefined = in-memory only (backtests). */
    private readonly file: string | undefined,
    startingBalance: number,
    private readonly books: (ticker: string) => OrderBook | undefined,
    private readonly feesFor: (ticker: string) => FeeSchedule,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.st = (file && readJson<PaperState>(file)) || { balance: startingBalance, positions: {}, fills: [], orders: [] };
  }

  private save(): void {
    if (this.st.orders.length > 4000) {
      this.st.orders = this.st.orders.filter((o) => o.status === 'resting' || this.now() - (o.updatedTs ?? 0) < 86_400_000).slice(-2000);
    }
    if (this.st.fills.length > 10_000) this.st.fills = this.st.fills.slice(-5000);
    if (!this.file || this.saveTimer) return;
    // Debounced: the simulated exchange is not the system of record.
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      writeJsonAtomic(this.file!, this.st);
    }, 250);
    this.saveTimer.unref();
  }

  /** Write pending state now (shutdown). */
  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.file) writeJsonAtomic(this.file, this.st);
  }

  async createOrder(req: CreateOrderRequest): Promise<ExchangeOrder> {
    if (this.st.orders.some((o) => o.clientOrderId === req.clientOrderId)) {
      throw new OrderRejectedError('duplicate client_order_id', 409, 'duplicate');
    }
    const book = this.books(req.ticker);
    if (!book) throw new OrderRejectedError('unknown market', 404, 'market_not_found');
    const o: PaperOrder = {
      orderId: crypto.randomUUID(),
      clientOrderId: req.clientOrderId,
      ticker: req.ticker,
      side: req.side,
      price: req.price,
      status: 'resting',
      fillCount: 0,
      remainingCount: req.count,
      initialCount: req.count,
      count: req.count,
      feesPaid: 0,
      queueAhead: 0,
      postOnly: req.postOnly,
      reduceOnly: req.reduceOnly,
      expirationTime: req.expirationTime,
      updatedTs: this.now(),
    };
    const bestBid = book.bestBid();
    const bestAsk = book.bestAsk();
    const crosses = req.side === 'bid' ? bestAsk !== undefined && req.price >= bestAsk.price : bestBid !== undefined && req.price <= bestBid.price;
    if (req.postOnly && crosses) throw new OrderRejectedError('post only order would cross', 400, 'post_only_cross');
    if (req.reduceOnly) {
      const pos = this.st.positions[req.ticker] ?? 0;
      const reduces = req.side === 'ask' ? pos > 0 : pos < 0;
      if (!reduces) throw new OrderRejectedError('reduce only would increase position', 400, 'reduce_only');
      o.remainingCount = Math.min(o.remainingCount, Math.abs(pos));
    }
    const cost = (req.side === 'bid' ? req.price : 1 - req.price) * req.count;
    if (!req.reduceOnly && cost > this.st.balance + 1e-9) throw new OrderRejectedError('insufficient_balance', 400, 'insufficient_balance');

    this.st.orders.push(o);
    if (crosses) {
      // Taker: walk the opposite side of the visible book.
      const levels = req.side === 'bid' ? book.snapshot(50).asks : book.snapshot(50).bids;
      for (const lvl of levels) {
        if (o.remainingCount <= 1e-9) break;
        const through = req.side === 'bid' ? lvl.price <= req.price : lvl.price >= req.price;
        if (!through) break;
        this.fill(o, Math.min(lvl.size, o.remainingCount), lvl.price, true);
      }
    }
    if (o.remainingCount > 1e-9) {
      if (req.timeInForce === 'good_till_canceled') {
        o.queueAhead = book.sizeAt(req.side, req.price);
      } else {
        o.status = o.fillCount > 0 ? 'executed' : 'canceled';
        if (req.timeInForce === 'fill_or_kill' && o.fillCount > 0) throw new Error('FOK partial fill in paper sim');
        o.remainingCount = 0;
      }
    }
    o.updatedTs = this.now();
    this.save();
    return { ...o };
  }

  async cancelOrder(orderId: string): Promise<void> {
    const o = this.st.orders.find((x) => x.orderId === orderId);
    if (!o || o.status !== 'resting') return;
    o.status = 'canceled';
    o.remainingCount = 0;
    o.updatedTs = this.now();
    this.save();
    this.emit('order', { ...o });
  }

  async getOrder(orderId: string): Promise<ExchangeOrder | undefined> {
    const o = this.st.orders.find((x) => x.orderId === orderId);
    return o ? { ...o } : undefined;
  }

  async findOrderByClientId(clientOrderId: string): Promise<ExchangeOrder | undefined> {
    const o = this.st.orders.find((x) => x.clientOrderId === clientOrderId);
    return o ? { ...o } : undefined;
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    this.expire();
    return this.st.orders.filter((o) => o.status === 'resting').map((o) => ({ ...o }));
  }

  async getFills(sinceTs: number): Promise<ExchangeFill[]> {
    return this.st.fills.filter((f) => f.ts >= sinceTs);
  }

  async getPositions(): Promise<ExchangePosition[]> {
    return Object.entries(this.st.positions).filter(([, v]) => Math.abs(v) > 1e-9).map(([ticker, position]) => ({ ticker, position }));
  }

  async getBalance(): Promise<number> {
    return this.st.balance;
  }

  /** Public trade print from market data. */
  onTrade(ticker: string, price: number, count: number, takerSide: 'yes' | 'no' | undefined): void {
    let changed = this.expire();
    let remaining = count;
    // A YES-taker lifts asks; a NO-taker hits YES bids. Unknown side: match by price only.
    const candidates = this.st.orders
      .filter((o) => o.ticker === ticker && o.status === 'resting')
      .filter((o) => (o.side === 'bid' ? takerSide !== 'yes' && price <= o.price + 1e-9 : takerSide !== 'no' && price >= o.price - 1e-9))
      .sort((a, b) => (a.side === 'bid' ? b.price - a.price : a.price - b.price));
    for (const o of candidates) {
      if (remaining <= 1e-9) break;
      const through = o.side === 'bid' ? price < o.price - 1e-9 : price > o.price + 1e-9;
      changed = true;
      if (through) {
        this.fill(o, o.remainingCount, o.price, false);
        continue;
      }
      const eatQueue = Math.min(o.queueAhead, remaining);
      o.queueAhead -= eatQueue;
      remaining -= eatQueue;
      if (o.queueAhead <= 1e-9 && remaining > 1e-9) {
        const n = Math.min(o.remainingCount, remaining);
        remaining -= n;
        this.fill(o, n, o.price, false);
      }
    }
    if (changed) this.save();
  }

  /** Settle a market in the paper account. */
  settle(ticker: string, result: 'yes' | 'no'): void {
    const pos = this.st.positions[ticker] ?? 0;
    if (pos > 0 && result === 'yes') this.st.balance += pos;
    if (pos < 0 && result === 'no') this.st.balance += -pos;
    delete this.st.positions[ticker];
    for (const o of this.st.orders) {
      if (o.ticker === ticker && o.status === 'resting') { o.status = 'canceled'; o.remainingCount = 0; this.emit('order', { ...o }); }
    }
    this.save();
  }

  private expire(): boolean {
    const nowSec = this.now() / 1000;
    let any = false;
    for (const o of this.st.orders) {
      if (o.status === 'resting' && o.expirationTime !== undefined && nowSec >= o.expirationTime) {
        o.status = 'canceled';
        o.lastUpdateReason = 'expired';
        o.remainingCount = 0;
        o.updatedTs = this.now();
        any = true;
        this.emit('order', { ...o });
      }
    }
    return any;
  }

  private fill(o: PaperOrder, count: number, price: number, isTaker: boolean): void {
    const n = Math.round(count * 100) / 100;
    if (n <= 0) return;
    const pos = this.st.positions[o.ticker] ?? 0;
    const fee = orderFee(n, o.side === 'bid' ? price : 1 - price, isTaker, this.feesFor(o.ticker));
    // Kalshi collateral accounting: opening costs the side's price; closing releases it.
    if (o.side === 'bid') {
      const closing = Math.min(n, Math.max(0, -pos));
      this.st.balance += closing * (1 - price) - (n - closing) * price;
      this.st.positions[o.ticker] = Math.round((pos + n) * 100) / 100;
    } else {
      const closing = Math.min(n, Math.max(0, pos));
      this.st.balance += closing * price - (n - closing) * (1 - price);
      this.st.positions[o.ticker] = Math.round((pos - n) * 100) / 100;
    }
    this.st.balance -= fee;
    o.fillCount = Math.round((o.fillCount + n) * 100) / 100;
    o.remainingCount = Math.max(0, Math.round((o.remainingCount - n) * 100) / 100);
    o.feesPaid = (o.feesPaid ?? 0) + fee;
    o.averageFillPrice = price;
    if (o.remainingCount <= 1e-9) o.status = 'executed';
    o.updatedTs = this.now();
    const f: ExchangeFill = {
      tradeId: crypto.randomUUID(), orderId: o.orderId, clientOrderId: o.clientOrderId, ticker: o.ticker,
      side: o.side, count: n, price, isTaker, fee, ts: this.now(),
    };
    this.st.fills.push(f);
    this.emit('fill', f);
    this.emit('order', { ...o });
  }
}

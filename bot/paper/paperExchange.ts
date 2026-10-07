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
//  - Only trades the exchange printed after the order was placed can fill it
//    (by the trade's own time stamp). Market data can reach the bot late: on
//    Oct 5-6 Kalshi trades arrived minutes behind, and quotes priced on live
//    Coinbase prices were filled by those old trades - profits a real exchange
//    could never have given.
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
import type { SettlementRecord } from '../recon/kalshiCheck';

interface PaperOrder extends ExchangeOrder {
  queueAhead: number;
  postOnly: boolean;
  reduceOnly: boolean;
  expirationTime?: number;
  count: number;
  /** When the order was placed (the paper clock); orders saved before this field fill as before. */
  placedTs?: number;
}

/** Kalshi stamps trades in whole seconds: a trade stamped up to this long before an order may still follow it. */
const TRADE_TS_SLACK_MS = 1000;

interface PaperState {
  balance: number;
  /** Cash put into the paper account so far (raising PAPER_BANKROLL_USD tops it up by the difference). */
  funded?: number;
  /** Cash added by training refills (capital exhaustion), total. */
  refilled?: number;
  positions: Record<string, number>;
  fills: ExchangeFill[];
  orders: PaperOrder[];
  /** Per market: cost basis of the YES / NO contracts held and fees paid (as Kalshi reports them). */
  basis?: Record<string, { yesCost: number; noCost: number; fees: number }>;
  /** Settlement records in Kalshi's shape (last 2 days), for the Kalshi check. */
  settlements?: SettlementRecord[];
}

/** Finished orders kept (state file and lookups): those updated within the hour, newest 500. */
const KEEP_ORDERS_MS = 3_600_000, KEEP_ORDERS = 500;
/** Fills kept: the last day, newest 2,000 (reconciliation replays from 10 minutes before the newest fill). */
const KEEP_FILLS_MS = 86_400_000, KEEP_FILLS = 2000;

export class PaperExchange extends EventEmitter implements ExchangeGateway {
  readonly name = 'paper';
  private st: PaperState;
  private saveTimer: NodeJS.Timeout | null = null;
  /** Lookups by exchange id and client id, and the resting orders alone: every public trade print is
   *  matched against resting orders, which used to mean a scan of every order kept (up to 4,000). */
  private readonly byId = new Map<string, PaperOrder>();
  private readonly byClientId = new Map<string, PaperOrder>();
  private readonly resting = new Map<string, PaperOrder>();

  constructor(
    /** State file; undefined = in-memory only (backtests). */
    private readonly file: string | undefined,
    startingBalance: number,
    private readonly books: (ticker: string) => OrderBook | undefined,
    private readonly feesFor: (ticker: string) => FeeSchedule,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.st = (file && readJson<PaperState>(file)) || { balance: startingBalance, funded: startingBalance, positions: {}, fills: [], orders: [] };
    // Accounts created before `funded` was recorded started with the old $20 default.
    const funded = this.st.funded ?? 20;
    if (startingBalance > funded) {
      this.st.balance += startingBalance - funded;
      this.st.funded = startingBalance;
      this.save();
    } else this.st.funded = funded;
    for (const o of this.st.orders) this.index(o);
  }

  private index(o: PaperOrder): void {
    this.byId.set(o.orderId, o);
    if (o.clientOrderId) this.byClientId.set(o.clientOrderId, o);
    if (o.status === 'resting') this.resting.set(o.orderId, o); else this.resting.delete(o.orderId);
  }

  /** Cash put into the paper account (the configured starting balance, after any top-ups). */
  get funded(): number { return this.st.funded ?? 0; }

  /** Training refill after capital exhaustion (bot/training/supervisor.ts): add cash, tracked separately. */
  refill(amount: number): void {
    if (!(amount > 0)) return;
    this.st.balance += amount;
    this.st.refilled = (this.st.refilled ?? 0) + amount;
    this.save();
  }

  private save(): void {
    if (!this.file || this.saveTimer) return;
    // Debounced, compact, not fsynced: the simulated exchange is not the system of record.
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.prune();
      writeJsonAtomic(this.file!, this.st, { compact: true });
    }, 1000);
    this.saveTimer.unref();
  }

  /** Drop finished orders and old fills nothing can ask for again (the state file is rewritten whole). */
  private prune(): void {
    const now = this.now();
    if (this.st.orders.length > this.resting.size + 50) {
      const keep = this.st.orders.filter((o) => o.status === 'resting' || now - (o.updatedTs ?? 0) < KEEP_ORDERS_MS);
      const finished = keep.filter((o) => o.status !== 'resting');
      const drop = new Set(finished.slice(0, Math.max(0, finished.length - KEEP_ORDERS)));
      const next = keep.filter((o) => !drop.has(o));
      if (next.length !== this.st.orders.length) {
        const kept = new Set(next);
        for (const o of this.st.orders) if (!kept.has(o)) { this.byId.delete(o.orderId); if (o.clientOrderId) this.byClientId.delete(o.clientOrderId); this.resting.delete(o.orderId); }
        this.st.orders = next;
      }
    }
    const f = this.st.fills;
    if (f.length && (f.length > KEEP_FILLS || f[0].ts < now - KEEP_FILLS_MS)) {
      let i = Math.max(0, f.length - KEEP_FILLS);
      while (i < f.length && f[i].ts < now - KEEP_FILLS_MS) i++;
      this.st.fills = f.slice(i);
    }
  }

  /** Write pending state now (shutdown). */
  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.file) { this.prune(); writeJsonAtomic(this.file, this.st, { compact: true }); }
  }

  async createOrder(req: CreateOrderRequest): Promise<ExchangeOrder> {
    if (this.byClientId.has(req.clientOrderId)) {
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
      placedTs: this.now(),
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
    this.index(o);
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
        this.resting.delete(o.orderId);
        if (req.timeInForce === 'fill_or_kill' && o.fillCount > 0) throw new Error('FOK partial fill in paper sim');
        o.remainingCount = 0;
      }
    }
    o.updatedTs = this.now();
    this.save();
    return { ...o };
  }

  async cancelOrder(orderId: string): Promise<void> {
    const o = this.byId.get(orderId);
    if (!o || o.status !== 'resting') return;
    o.status = 'canceled';
    this.resting.delete(orderId);
    o.remainingCount = 0;
    o.updatedTs = this.now();
    this.save();
    this.emit('order', { ...o });
  }

  async getOrder(orderId: string): Promise<ExchangeOrder | undefined> {
    const o = this.byId.get(orderId);
    return o ? { ...o } : undefined;
  }

  async findOrderByClientId(clientOrderId: string): Promise<ExchangeOrder | undefined> {
    const o = this.byClientId.get(clientOrderId);
    return o ? { ...o } : undefined;
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    this.expire();
    return [...this.resting.values()].map((o) => ({ ...o }));
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

  /** Public trade print from market data; `tradeTs` is the exchange's time stamp of the trade. */
  onTrade(ticker: string, price: number, count: number, takerSide: 'yes' | 'no' | undefined, tradeTs?: number): void {
    let changed = this.expire();
    let remaining = count;
    // A YES-taker lifts asks; a NO-taker hits YES bids. Unknown side: match by price only.
    // A trade printed before an order existed neither fills it nor eats its queue.
    const after = (o: PaperOrder) => tradeTs === undefined || !Number.isFinite(tradeTs) || o.placedTs === undefined || o.placedTs <= tradeTs + TRADE_TS_SLACK_MS;
    const candidates = [...this.resting.values()]
      .filter((o) => o.ticker === ticker && after(o))
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

  async getSettlements(sinceTs: number): Promise<SettlementRecord[]> {
    return (this.st.settlements ?? []).filter((r) => r.ts >= sinceTs);
  }

  /** Settle a market in the paper account. */
  settle(ticker: string, result: 'yes' | 'no'): void {
    const pos = this.st.positions[ticker] ?? 0;
    const b = this.st.basis?.[ticker];
    if (Math.abs(pos) > 1e-9 || b) {
      const now = this.now();
      const rec: SettlementRecord = { ticker, result, yesCount: Math.max(0, pos), noCount: Math.max(0, -pos), yesCost: r6(b?.yesCost ?? 0), noCost: r6(b?.noCost ?? 0),
        revenue: pos > 0 && result === 'yes' ? pos : pos < 0 && result === 'no' ? -pos : 0, fees: r6(b?.fees ?? 0), ts: now };
      this.st.settlements = [...(this.st.settlements ?? []).filter((r) => r.ts >= now - 2 * 86_400_000), rec];
      if (this.st.basis) delete this.st.basis[ticker];
    }
    if (pos > 0 && result === 'yes') this.st.balance += pos;
    if (pos < 0 && result === 'no') this.st.balance += -pos;
    delete this.st.positions[ticker];
    for (const o of [...this.resting.values()]) {
      if (o.ticker === ticker) { o.status = 'canceled'; o.remainingCount = 0; this.resting.delete(o.orderId); this.emit('order', { ...o }); }
    }
    this.save();
  }

  private expire(): boolean {
    const nowSec = this.now() / 1000;
    let any = false;
    for (const o of [...this.resting.values()]) {
      if (o.expirationTime !== undefined && nowSec >= o.expirationTime) {
        o.status = 'canceled';
        this.resting.delete(o.orderId);
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
    // Cost basis as Kalshi keeps it: opening adds the side's price; closing releases its share.
    const b = ((this.st.basis ??= {})[o.ticker] ??= { yesCost: 0, noCost: 0, fees: 0 });
    b.fees += fee;
    if (o.side === 'bid') {
      const closing = Math.min(n, Math.max(0, -pos));
      if (closing > 0) b.noCost *= (-pos - closing) / -pos;
      b.yesCost += (n - closing) * price;
    } else {
      const closing = Math.min(n, Math.max(0, pos));
      if (closing > 0) b.yesCost *= (pos - closing) / pos;
      b.noCost += (n - closing) * (1 - price);
    }
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
    if (o.remainingCount <= 1e-9) { o.status = 'executed'; this.resting.delete(o.orderId); }
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

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

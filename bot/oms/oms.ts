// Order management system.
//
// Guarantees:
//  - A client_order_id is generated and persisted to disk BEFORE the order is
//    sent, and every retry of that order reuses it.
//  - After a timeout/network failure the order is UNKNOWN; we query the
//    exchange by client_order_id before any resend, so a slow ack can never
//    produce a duplicate order.
//  - An order being accepted is not a fill. Positions change only when fills
//    are applied, and fills are de-duplicated by trade id so WebSocket and
//    REST replay (reconciliation) can both deliver them safely.
//  - Exits stay tracked until the exchange confirms them.

import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { AuditLog } from '../audit/auditLog';
import { orderFee, type FeeSchedule } from '../fees';
import {
  ExchangeFill, ExchangeGateway, ExchangeOrder, OrderRejectedError, OrderStateUnknownError, TimeInForce, BookSide,
} from '../kalshi/types';
import { logger } from '../util/log';
import { readJson, writeJsonAtomic } from '../util/persist';
import { canTransition, isLive, OrderPurpose, OrderRecord, OrderState, TERMINAL, transition } from './orderState';
import { MarketPosition, PositionBook } from './positions';

const log = logger('oms');

export interface OrderIntent {
  ticker: string;
  asset: string;
  windowCloseTs: number;
  side: BookSide;
  price: number;
  count: number;
  timeInForce: TimeInForce;
  postOnly: boolean;
  reduceOnly: boolean;
  expirationTime?: number;
  purpose: OrderPurpose;
  /** Model P(YES) at decision time. */
  fairValue: number;
  modelId: string;
  decisionId: string;
}

interface PersistedState {
  version: 1;
  orders: OrderRecord[];
  seenTradeIds: string[];
  /** Fill time per seenTradeIds entry (absent in older files). */
  seenTradeTimes?: number[];
  positions: MarketPosition[];
  lastFillTs: number;
}

/** Terminal orders kept (memory and state file): the dashboard shows the latest 40, diagnostics 300. */
const KEEP_TERMINAL = 300;
/** Trade ids persisted: those of fills this close to the newest fill. Reconciliation replays fills from
 *  10 minutes before the newest one we hold, so older ids can never be delivered again. */
const SEEN_PERSIST_MS = 6 * 3_600_000;

export interface OmsOptions {
  gateway: ExchangeGateway;
  audit: AuditLog;
  statePath: string;
  feesFor: (ticker: string) => FeeSchedule;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  subaccount?: number;
  /** Fsync the write-ahead record of a new order before it is sent (live). Paper trades against an
   *  in-process exchange, where a crash loses both sides alike: there the record rides the next
   *  coalesced write. Default true. */
  durableWriteAhead?: boolean;
  /** Coalescing window for state writes (ms). Default 1000. */
  saveDelayMs?: number;
}

export class Oms extends EventEmitter {
  readonly positions: PositionBook;
  private readonly orders = new Map<string, OrderRecord>();
  private readonly byExchangeId = new Map<string, string>();
  private readonly seenTrades: string[] = [];
  /** Fill time of each id in seenTrades (same order; 0 for ids loaded from an older state file). */
  private readonly seenTimes: number[] = [];
  private readonly seenTradeSet = new Set<string>();
  /** Live (non-terminal) orders, kept in step with every state change: liveOrders() is called many
   *  times per market per second and used to scan every order kept (up to ~1000 terminal ones). */
  private readonly live = new Map<string, OrderRecord>();
  private readonly orderTimes: number[] = [];
  consecutiveErrors = 0;
  lastFillTs = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly o: OmsOptions) {
    super();
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const st = readJson<PersistedState>(o.statePath);
    this.positions = new PositionBook(st?.positions);
    for (const rec of st?.orders ?? []) {
      this.orders.set(rec.clientOrderId, rec);
      if (rec.orderId) this.byExchangeId.set(rec.orderId, rec.clientOrderId);
      if (isLive(rec)) this.live.set(rec.clientOrderId, rec);
    }
    const times = st?.seenTradeTimes;
    (st?.seenTradeIds ?? []).forEach((t, i) => this.markSeen(t, times?.[i] ?? 0));
    this.lastFillTs = st?.lastFillTs ?? 0;
  }

  // ---- Queries ---------------------------------------------------------------

  liveOrders(): OrderRecord[] {
    return [...this.live.values()];
  }

  allOrders(limit = 200): OrderRecord[] {
    return [...this.orders.values()].sort((a, b) => b.createdTs - a.createdTs).slice(0, limit);
  }

  /** Has this trade id been applied (it is still among those remembered)? */
  hasSeenTrade(tradeId: string): boolean { return this.seenTradeSet.has(tradeId); }

  get(clientOrderId: string): OrderRecord | undefined {
    return this.orders.get(clientOrderId);
  }

  findByExchangeId(orderId: string): OrderRecord | undefined {
    const c = this.byExchangeId.get(orderId);
    return c ? this.orders.get(c) : undefined;
  }

  ordersSentInLast(ms: number): number {
    const cutoff = this.now() - ms;
    while (this.orderTimes.length && this.orderTimes[0] < cutoff) this.orderTimes.shift();
    return this.orderTimes.length;
  }

  // ---- Commands --------------------------------------------------------------

  /** Submit an order that has ALREADY passed the risk gateway. */
  async submit(intent: OrderIntent): Promise<OrderRecord> {
    const now = this.now();
    const rec: OrderRecord = {
      clientOrderId: crypto.randomUUID(),
      ticker: intent.ticker,
      asset: intent.asset,
      windowCloseTs: intent.windowCloseTs,
      side: intent.side,
      price: intent.price,
      count: intent.count,
      timeInForce: intent.timeInForce,
      postOnly: intent.postOnly,
      reduceOnly: intent.reduceOnly,
      expirationTime: intent.expirationTime,
      purpose: intent.purpose,
      state: 'PENDING_NEW',
      filledCount: 0,
      exchangeFillCount: 0,
      remainingCount: intent.count,
      feesPaid: 0,
      attempts: 0,
      cancelRequested: false,
      createdTs: now,
      updatedTs: now,
      decisionId: intent.decisionId,
      modelId: intent.modelId,
      fairValue: intent.fairValue,
    };
    this.orders.set(rec.clientOrderId, rec);
    this.live.set(rec.clientOrderId, rec);
    // Write-ahead: the client order id is on disk before the exchange sees it (fsynced in live).
    if (this.o.durableWriteAhead ?? true) this.saveNow(true); else this.save();
    this.o.audit.write('order_new', rec);
    this.orderTimes.push(now);
    await this.send(rec);
    return rec;
  }

  private async send(rec: OrderRecord): Promise<void> {
    rec.attempts += 1;
    try {
      const ex = await this.o.gateway.createOrder({
        ticker: rec.ticker,
        side: rec.side,
        count: rec.count,
        price: rec.price,
        timeInForce: rec.timeInForce,
        postOnly: rec.postOnly,
        reduceOnly: rec.reduceOnly,
        selfTradePrevention: 'taker_at_cross',
        clientOrderId: rec.clientOrderId,
        expirationTime: rec.expirationTime,
        cancelOnPause: true,
        subaccount: this.o.subaccount,
      });
      this.consecutiveErrors = 0;
      this.o.audit.write('order_ack', { clientOrderId: rec.clientOrderId, exchange: ex });
      this.applyExchangeOrder(rec, ex);
      if (rec.cancelRequested && isLive(rec)) void this.cancel(rec.clientOrderId, 'cancel requested before ack');
    } catch (e) {
      if (e instanceof OrderRejectedError) {
        rec.lastError = e.message;
        this.safeTransition(rec, 'REJECTED');
        this.o.audit.write('order_reject', { clientOrderId: rec.clientOrderId, status: e.status, code: e.code, error: e.message });
        // Post-only crosses and rate limits are expected; count everything else.
        if (e.code !== 'post_only_cross' && !/post.?only/i.test(e.message)) this.bumpError(e.message);
      } else if (e instanceof OrderStateUnknownError) {
        rec.lastError = e.message;
        this.safeTransition(rec, 'UNKNOWN');
        this.o.audit.write('order_unknown', { clientOrderId: rec.clientOrderId, error: e.message });
        this.bumpError(e.message);
        this.save();
        await this.resolveUnknown(rec);
      } else {
        rec.lastError = String(e);
        this.safeTransition(rec, 'UNKNOWN');
        this.bumpError(String(e));
        this.save();
        await this.resolveUnknown(rec);
      }
    } finally {
      this.save();
      this.emit('order', rec);
    }
  }

  /** Query by client_order_id; resend once with the SAME id if never seen. */
  private async resolveUnknown(rec: OrderRecord): Promise<void> {
    for (const delay of [500, 1000, 2000, 4000]) {
      await this.sleep(delay);
      try {
        const ex = await this.o.gateway.findOrderByClientId(rec.clientOrderId, rec.ticker);
        if (ex) {
          this.applyExchangeOrder(rec, ex);
          this.o.audit.write('order_update', { clientOrderId: rec.clientOrderId, via: 'client_id_query', exchange: ex });
          return;
        }
      } catch (e) {
        log.warn('client id query failed', { clientOrderId: rec.clientOrderId, error: String(e) });
      }
    }
    const fresh = this.now() - rec.createdTs < 15_000;
    if (rec.attempts < 2 && fresh && !rec.cancelRequested) {
      log.warn('order not found after timeout; resending with same client_order_id', { clientOrderId: rec.clientOrderId });
      this.safeTransition(rec, 'PENDING_NEW');
      await this.send(rec);
      return;
    }
    // Leave it UNKNOWN only if cancel was requested; otherwise mark lost.
    // Reconciliation will flag it as an orphan if it ever appears.
    rec.lastError = `lost after ${rec.attempts} attempt(s)`;
    this.safeTransition(rec, 'REJECTED');
    this.o.audit.write('order_reject', { clientOrderId: rec.clientOrderId, error: rec.lastError });
  }

  async cancel(clientOrderId: string, reason: string): Promise<void> {
    const rec = this.orders.get(clientOrderId);
    if (!rec || !isLive(rec)) return;
    rec.cancelRequested = true;
    this.o.audit.write('order_cancel_req', { clientOrderId, orderId: rec.orderId, reason });
    if (!rec.orderId) {
      this.save();
      return; // cancelled as soon as the ack arrives
    }
    if (rec.state !== 'CANCEL_PENDING') this.safeTransition(rec, 'CANCEL_PENDING');
    this.save();
    try {
      await this.o.gateway.cancelOrder(rec.orderId);
      const ex = await this.o.gateway.getOrder(rec.orderId);
      if (ex) this.applyExchangeOrder(rec, ex);
    } catch (e) {
      log.error('cancel failed', { clientOrderId, error: String(e) });
      this.bumpError(`cancel: ${String(e)}`);
    } finally {
      this.save();
      this.emit('order', rec);
    }
  }

  /** Cancel every live order we know of AND every resting order on the exchange. */
  async cancelAll(reason: string): Promise<{ canceled: number; errors: number }> {
    let canceled = 0, errors = 0;
    await Promise.all(this.liveOrders().map(async (r) => {
      try { await this.cancel(r.clientOrderId, reason); canceled++; } catch { errors++; }
    }));
    try {
      const resting = await this.o.gateway.getOpenOrders();
      for (const ex of resting) {
        try { await this.o.gateway.cancelOrder(ex.orderId); canceled++; } catch { errors++; }
      }
    } catch (e) {
      errors++;
      log.error('cancelAll: listing open orders failed', { error: String(e) });
    }
    return { canceled, errors };
  }

  // ---- Exchange events ------------------------------------------------------

  onExchangeOrder(ex: ExchangeOrder): void {
    const rec = (ex.clientOrderId && this.orders.get(ex.clientOrderId)) || this.findByExchangeId(ex.orderId);
    if (!rec) {
      this.o.audit.write('order_update', { orphan: true, exchange: ex });
      this.emit('orphan_order', ex);
      return;
    }
    this.applyExchangeOrder(rec, ex);
    this.o.audit.write('order_update', { clientOrderId: rec.clientOrderId, exchange: ex });
    this.save();
    this.emit('order', rec);
  }

  /** Apply a fill exactly once. Returns false if it was a duplicate. */
  onFill(f: ExchangeFill, meta?: { closeTs?: number; asset?: string }): boolean {
    if (this.seenTradeSet.has(f.tradeId)) return false;
    this.markSeen(f.tradeId, f.ts);
    const rec = (f.clientOrderId && this.orders.get(f.clientOrderId)) || (f.orderId ? this.findByExchangeId(f.orderId) : undefined);
    const fee = f.fee ?? orderFee(f.count, f.side === 'bid' ? f.price : 1 - f.price, f.isTaker, this.o.feesFor(f.ticker));
    const pos = this.positions.applyFill(
      { ticker: f.ticker, side: f.side, count: f.count, price: f.price, fee },
      { closeTs: rec?.windowCloseTs ?? meta?.closeTs, asset: rec?.asset ?? meta?.asset },
    );
    this.lastFillTs = Math.max(this.lastFillTs, f.ts);
    if (rec) {
      rec.filledCount = Math.round((rec.filledCount + f.count) * 100) / 100;
      rec.exchangeFillCount = Math.max(rec.exchangeFillCount, rec.filledCount);
      rec.feesPaid += fee;
      rec.remainingCount = Math.max(0, Math.round((rec.count - rec.exchangeFillCount) * 100) / 100);
      if (rec.filledCount >= rec.count - 1e-9) this.safeTransition(rec, 'FILLED');
      else if (rec.state === 'ACKED' || rec.state === 'PENDING_NEW' || rec.state === 'UNKNOWN') this.safeTransition(rec, 'PARTIALLY_FILLED');
    }
    this.o.audit.write('fill', { fill: f, fee, feeEstimated: f.fee === undefined, clientOrderId: rec?.clientOrderId, orphan: !rec, position: pos.yes });
    this.save();
    this.emit('fill', f, rec, fee, pos.yes);
    if (!rec) this.emit('orphan_fill', f);
    return true;
  }

  settle(ticker: string, result: 'yes' | 'no'): MarketPosition | undefined {
    const before = this.positions.get(ticker);
    const wasSettled = before?.settled ?? true;
    const positionBefore = before?.yes ?? 0;
    const m = this.positions.settle(ticker, result, this.now());
    if (m && !wasSettled) this.emit('settled', { ticker, result, realized: m.realized ?? 0, positionBefore });
    if (m) {
      this.o.audit.write('settlement', { ticker, result, realized: m.realized, fees: m.fees, win: (m.realized ?? 0) > 0 });
      this.save();
    }
    return m;
  }

  // ---- Internals --------------------------------------------------------------

  private applyExchangeOrder(rec: OrderRecord, ex: ExchangeOrder): void {
    if (ex.orderId && !rec.orderId) {
      rec.orderId = ex.orderId;
      this.byExchangeId.set(ex.orderId, rec.clientOrderId);
    }
    rec.exchangeFillCount = Math.max(rec.exchangeFillCount, ex.fillCount);
    rec.remainingCount = ex.remainingCount;
    if (ex.averageFillPrice !== undefined) rec.avgFillPrice = ex.averageFillPrice;
    let target: OrderState | undefined;
    switch (ex.status) {
      case 'resting':
        target = rec.state === 'CANCEL_PENDING' ? 'CANCEL_PENDING' : rec.exchangeFillCount > 0 ? 'PARTIALLY_FILLED' : 'ACKED';
        break;
      case 'executed':
        target = 'FILLED';
        break;
      case 'canceled':
        if (rec.exchangeFillCount >= rec.count - 1e-9) target = 'FILLED';
        else if (/expir/i.test(ex.lastUpdateReason ?? '')) target = 'EXPIRED';
        else target = 'CANCELED';
        break;
      case 'pending':
        target = rec.state === 'PENDING_NEW' || rec.state === 'UNKNOWN' ? 'ACKED' : undefined;
        break;
      default:
        target = undefined;
    }
    if (target) this.safeTransition(rec, target);
  }

  private safeTransition(rec: OrderRecord, to: OrderState): void {
    if (canTransition(rec.state, to)) {
      transition(rec, to, this.now());
      if (isLive(rec)) this.live.set(rec.clientOrderId, rec); else this.live.delete(rec.clientOrderId);
    } else if (!TERMINAL.has(rec.state)) {
      log.warn('ignored illegal transition', { clientOrderId: rec.clientOrderId, from: rec.state, to });
    }
  }

  private bumpError(msg: string): void {
    this.consecutiveErrors += 1;
    this.emit('order_error', this.consecutiveErrors, msg);
  }

  private markSeen(id: string, ts: number): void {
    this.seenTradeSet.add(id);
    this.seenTrades.push(id);
    this.seenTimes.push(ts);
    if (this.seenTrades.length > 20_000) { this.seenTradeSet.delete(this.seenTrades.shift()!); this.seenTimes.shift(); }
  }

  /** Persist soon: transitions within the coalescing window (1 s) share one write. Quotes churn: a
   *  synchronous write (and fsync) of the whole state per transition held the main thread, and every
   *  message waited behind it. Positions, seen trade ids and lastFillTs are written together, so a fill
   *  lost to a crash inside the window is simply fetched and applied again on restart. */
  save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, this.o.saveDelayMs ?? 1000);
    this.saveTimer.unref?.();
  }

  /** Write any pending state now (shutdown). */
  flush(): void { if (this.saveTimer) this.saveNow(); }

  saveNow(durable = false): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    // Keep live orders plus the most recent terminal ones.
    if (this.orders.size - this.live.size > KEEP_TERMINAL + 50) {
      const terminal = [...this.orders.values()].filter((o) => !isLive(o)).sort((a, b) => b.updatedTs - a.updatedTs);
      for (const old of terminal.slice(KEEP_TERMINAL)) {
        this.orders.delete(old.clientOrderId);
        if (old.orderId) this.byExchangeId.delete(old.orderId);
      }
    }
    this.positions.prune(this.now() - 3 * 86_400_000);
    // Only the trade ids a replay could still deliver (see SEEN_PERSIST_MS); ids of unknown age (older
    // files) are kept while they are among the last 2,000.
    const cut = this.lastFillTs - SEEN_PERSIST_MS, n = this.seenTrades.length;
    const ids: string[] = [], times: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = this.seenTimes[i];
      if (t >= cut || (t === 0 && i >= n - 2000)) { ids.push(this.seenTrades[i]); times.push(t); }
    }
    const st: PersistedState = {
      version: 1,
      orders: [...this.orders.values()],
      seenTradeIds: ids,
      seenTradeTimes: times,
      positions: this.positions.all(),
      lastFillTs: this.lastFillTs,
    };
    writeJsonAtomic(this.o.statePath, st, { compact: true, durable });
  }
}

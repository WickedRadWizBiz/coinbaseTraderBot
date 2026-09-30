// Paper perps exchange for simulated hedging (paper/shadow modes). Uses the
// live perp top of book from PerpHub:
//  - Resting post-only orders fill only when the market trades THROUGH them
//    (a buy fills once the best ask drops below its price; a sell once the best
//    bid rises above it). Touching is never a fill.
//  - Immediate-or-cancel orders fill at the opposite touch.
//  - Fees are bps of notional (defaults: maker 5, taker 12 at tier 0).
//  - Funding accrues at each funding time: longs pay rate x notional when the
//    rate is positive (and receive when negative).

import { readJson, writeJsonAtomic } from '../util/persist';
import { nextFundingTime, type PerpHub } from './perpData';

/** Most recent funding time at or before `now`. */
export function lastFundingTime(now: number): number {
  let t = nextFundingTime(now - 10 * 3_600_000);
  for (let n = nextFundingTime(t); n <= now; n = nextFundingTime(t)) t = n;
  return t;
}
import type { PerpGateway, PerpOrder, PerpOrderRequest, PerpPosition } from './perpRest';

interface PaperOrder extends PerpOrder { asset: string; postOnly: boolean }
interface PaperPos { position: number; entryPrice: number; realized: number; fees: number; funding: number }
interface State { orders: PaperOrder[]; positions: Record<string, PaperPos>; lastFunding: Record<string, number>; seq: number }

export class PaperPerpExchange implements PerpGateway {
  readonly name = 'paper-perps';
  private st: State;

  constructor(
    private readonly hub: PerpHub,
    private readonly tickerAsset: (ticker: string) => string | undefined,
    private readonly fees = { makerBps: 5, takerBps: 12 },
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.st = (file && readJson<State>(file)) || { orders: [], positions: {}, lastFunding: {}, seq: 0 };
  }

  private save(): void { if (this.file) writeJsonAtomic(this.file, this.st); }

  private book(asset: string) {
    const l = this.hub.get(asset)?.latest;
    return { bid: l?.bid, ask: l?.ask, cs: l?.contractSize ?? 1, rate: l?.fundingRate, nextTs: l?.nextFundingTs, mark: this.hub.get(asset)?.price(this.now(), 60_000) };
  }

  private fill(ticker: string, asset: string, side: 'bid' | 'ask', count: number, price: number, taker: boolean): void {
    const { cs } = this.book(asset);
    const p = (this.st.positions[ticker] ??= { position: 0, entryPrice: 0, realized: 0, fees: 0, funding: 0 });
    const signed = side === 'bid' ? count : -count;
    p.fees += (price * count * cs * (taker ? this.fees.takerBps : this.fees.makerBps)) / 1e4;
    if (p.position === 0 || Math.sign(p.position) === Math.sign(signed)) {
      p.entryPrice = (p.entryPrice * Math.abs(p.position) + price * count) / (Math.abs(p.position) + count);
      p.position = +(p.position + signed).toFixed(4);
    } else {
      const closed = Math.min(Math.abs(signed), Math.abs(p.position));
      p.realized += closed * cs * (price - p.entryPrice) * Math.sign(p.position);
      p.position = +(p.position + signed).toFixed(4);
      if (Math.sign(p.position) === Math.sign(signed) && p.position !== 0) p.entryPrice = price;
      if (p.position === 0) p.entryPrice = 0;
    }
  }

  /** Advance the simulation: trade-through fills and funding. Call on each market-data update. */
  step(): void {
    const now = this.now();
    for (const o of [...this.st.orders]) {
      const { bid, ask } = this.book(o.asset);
      const through = o.side === 'bid' ? ask !== undefined && ask < o.price : bid !== undefined && bid > o.price;
      if (through) {
        this.fill(o.ticker, o.asset, o.side, o.remaining, o.price, false);
        this.st.orders = this.st.orders.filter((x) => x !== o);
      }
    }
    const prev = lastFundingTime(now);
    for (const [ticker, p] of Object.entries(this.st.positions)) {
      const asset = this.tickerAsset(ticker);
      const last = this.st.lastFunding[ticker];
      this.st.lastFunding[ticker] = prev;
      if (!asset || p.position === 0 || last === undefined || prev <= last) continue;
      // A funding time passed while the position was open: positive rate -> longs pay.
      const { rate, mark, cs } = this.book(asset);
      if (rate !== undefined && mark !== undefined) p.funding -= Math.sign(p.position) * rate * Math.abs(p.position) * cs * mark;
    }
    this.save();
  }

  async createOrder(r: PerpOrderRequest): Promise<PerpOrder> {
    const asset = this.tickerAsset(r.ticker);
    if (!asset) throw new Error(`unknown perp ${r.ticker}`);
    const { bid, ask } = this.book(asset);
    const id = `pp-${++this.st.seq}`;
    const pos = this.st.positions[r.ticker]?.position ?? 0;
    if (r.reduceOnly && (pos === 0 || Math.sign(pos) === (r.side === 'bid' ? 1 : -1) || r.count > Math.abs(pos) + 1e-9)) throw new Error('reduce_only order would not reduce');
    if (r.timeInForce === 'immediate_or_cancel') {
      const px = r.side === 'bid' ? ask : bid;
      if (px === undefined || (r.side === 'bid' ? px > r.price : px < r.price)) return { orderId: id, clientOrderId: r.clientOrderId, ticker: r.ticker, side: r.side, price: r.price, remaining: 0, status: 'canceled' };
      this.fill(r.ticker, asset, r.side, r.count, px, true);
      this.save();
      return { orderId: id, clientOrderId: r.clientOrderId, ticker: r.ticker, side: r.side, price: px, remaining: 0, status: 'executed' };
    }
    if (r.postOnly && ((r.side === 'bid' && ask !== undefined && r.price >= ask) || (r.side === 'ask' && bid !== undefined && r.price <= bid))) throw new Error('post-only order would cross');
    const o: PaperOrder = { orderId: id, clientOrderId: r.clientOrderId, ticker: r.ticker, side: r.side, price: r.price, remaining: r.count, status: 'resting', asset, postOnly: r.postOnly };
    this.st.orders.push(o);
    this.save();
    return o;
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.st.orders = this.st.orders.filter((o) => o.orderId !== orderId);
    this.save();
  }

  async getOpenOrders(): Promise<PerpOrder[]> { return this.st.orders.map(({ asset: _a, postOnly: _p, ...o }) => o); }

  async getPositions(): Promise<PerpPosition[]> {
    return Object.entries(this.st.positions).map(([ticker, p]) => ({ ticker, position: p.position, entryPrice: p.entryPrice }));
  }

  /** Realized P&L, fees and funding per ticker (dashboard). */
  ledger() { return this.st.positions; }
}

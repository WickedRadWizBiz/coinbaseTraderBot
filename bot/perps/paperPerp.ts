// Paper perps exchange for simulated hedging and directional trading (paper/shadow modes and
// research). Uses the live perp top of book from PerpHub and follows the exchange's rules:
//  - Resting post-only orders fill only when the market trades THROUGH them
//    (a buy fills once the best ask drops below its price; a sell once the best
//    bid rises above it). Touching is never a fill.
//  - Immediate-or-cancel orders fill at the opposite touch.
//  - reduce_only is accepted only on IOC / FOK orders (as on Kalshi).
//  - Prices are per contract: notional = count x price (the exchange's own |qty| x mark).
//  - Fees are bps of notional (defaults: maker 5, taker 12 at tier 0).
//  - Funding accrues at each funding time: longs pay rate x notional when the
//    rate is positive (and receive when negative).
//  - Exchange-side stop-losses fire on the liquidation mark (falls back to the mid) with a
//    reduce-only taker order at the touch.
//  - Equity = starting balance + realized P&L - fees + funding + unrealized P&L at the mid.

import { readJson, writeJsonAtomic } from '../util/persist';
import { nextFundingTime, type PerpHub } from './perpData';
import { assertReduceOnlyRule, type PerpBalance, type PerpGateway, type PerpOrder, type PerpOrderRequest, type PerpPosition } from './perpRest';

/** Most recent funding time at or before `now`. */
export function lastFundingTime(now: number): number {
  let t = nextFundingTime(now - 10 * 3_600_000);
  for (let n = nextFundingTime(t); n <= now; n = nextFundingTime(t)) t = n;
  return t;
}

interface PaperOrder extends PerpOrder { asset: string; postOnly: boolean }
interface PaperPos { position: number; entryPrice: number; realized: number; fees: number; funding: number }
interface State { orders: PaperOrder[]; positions: Record<string, PaperPos>; lastFunding: Record<string, number>; seq: number; stops?: Record<string, number>; startBalance?: number; stopFills?: number }

export class PaperPerpExchange implements PerpGateway {
  readonly name = 'paper-perps';
  private st: State;

  constructor(
    private readonly hub: PerpHub,
    private readonly tickerAsset: (ticker: string) => string | undefined,
    private readonly fees = { makerBps: 5, takerBps: 12 },
    private readonly file?: string,
    private readonly now: () => number = Date.now,
    startBalance = 20,
  ) {
    this.st = (file && readJson<State>(file)) || { orders: [], positions: {}, lastFunding: {}, seq: 0 };
    this.st.stops ??= {};
    this.st.startBalance ??= startBalance;
  }

  private save(): void { if (this.file) writeJsonAtomic(this.file, this.st); }

  private book(asset: string) {
    const l = this.hub.get(asset)?.latest;
    return { bid: l?.bid, ask: l?.ask, rate: l?.fundingRate, liq: l?.liquidationMark, mark: this.hub.get(asset)?.price(this.now(), 60_000) };
  }

  private fill(ticker: string, side: 'bid' | 'ask', count: number, price: number, taker: boolean): void {
    const p = (this.st.positions[ticker] ??= { position: 0, entryPrice: 0, realized: 0, fees: 0, funding: 0 });
    const signed = side === 'bid' ? count : -count;
    p.fees += (price * count * (taker ? this.fees.takerBps : this.fees.makerBps)) / 1e4;
    if (p.position === 0 || Math.sign(p.position) === Math.sign(signed)) {
      p.entryPrice = (p.entryPrice * Math.abs(p.position) + price * count) / (Math.abs(p.position) + count);
      p.position = +(p.position + signed).toFixed(4);
    } else {
      const closed = Math.min(Math.abs(signed), Math.abs(p.position));
      p.realized += closed * (price - p.entryPrice) * Math.sign(p.position);
      p.position = +(p.position + signed).toFixed(4);
      if (Math.sign(p.position) === Math.sign(signed) && p.position !== 0) p.entryPrice = price;
      if (p.position === 0) p.entryPrice = 0;
    }
  }

  /** Advance the simulation: trade-through fills, stop-losses and funding. Call on each market-data update. */
  step(): void {
    const now = this.now();
    for (const o of [...this.st.orders]) {
      const { bid, ask } = this.book(o.asset);
      const through = o.side === 'bid' ? ask !== undefined && ask < o.price : bid !== undefined && bid > o.price;
      if (through) {
        this.fill(o.ticker, o.side, o.remaining, o.price, false);
        this.st.orders = this.st.orders.filter((x) => x !== o);
      }
    }
    for (const [ticker, stop] of Object.entries(this.st.stops ?? {})) {
      const asset = this.tickerAsset(ticker);
      const p = this.st.positions[ticker];
      if (!asset || !p || p.position === 0) { delete this.st.stops![ticker]; continue; }
      const { bid, ask, liq, mark } = this.book(asset);
      const m = liq ?? mark;
      if (m === undefined) continue;
      const hit = p.position > 0 ? m <= stop : m >= stop;
      const px = p.position > 0 ? bid : ask;
      if (hit && px !== undefined) {
        this.fill(ticker, p.position > 0 ? 'ask' : 'bid', Math.abs(p.position), px, true);
        delete this.st.stops![ticker];
        this.st.stopFills = (this.st.stopFills ?? 0) + 1;
      }
    }
    const prev = lastFundingTime(now);
    for (const [ticker, p] of Object.entries(this.st.positions)) {
      const asset = this.tickerAsset(ticker);
      const last = this.st.lastFunding[ticker];
      this.st.lastFunding[ticker] = prev;
      if (!asset || p.position === 0 || last === undefined || prev <= last) continue;
      // A funding time passed while the position was open: positive rate -> longs pay.
      const { rate, mark } = this.book(asset);
      if (rate !== undefined && mark !== undefined) p.funding -= Math.sign(p.position) * rate * Math.abs(p.position) * mark;
    }
    this.save();
  }

  async createOrder(r: PerpOrderRequest): Promise<PerpOrder> {
    assertReduceOnlyRule(r);
    const asset = this.tickerAsset(r.ticker);
    if (!asset) throw new Error(`unknown perp ${r.ticker}`);
    const { bid, ask } = this.book(asset);
    const id = `pp-${++this.st.seq}`;
    const pos = this.st.positions[r.ticker]?.position ?? 0;
    if (r.reduceOnly && (pos === 0 || Math.sign(pos) === (r.side === 'bid' ? 1 : -1))) throw new Error('reduce_only order would not reduce');
    const count = r.reduceOnly ? Math.min(r.count, Math.abs(pos)) : r.count; // the exchange caps reduce-only at the position
    if (r.timeInForce === 'immediate_or_cancel' || r.timeInForce === 'fill_or_kill') {
      const px = r.side === 'bid' ? ask : bid;
      if (px === undefined || (r.side === 'bid' ? px > r.price : px < r.price)) return { orderId: id, clientOrderId: r.clientOrderId, ticker: r.ticker, side: r.side, price: r.price, remaining: 0, status: 'canceled' };
      this.fill(r.ticker, r.side, count, px, true);
      this.save();
      return { orderId: id, clientOrderId: r.clientOrderId, ticker: r.ticker, side: r.side, price: px, remaining: 0, status: 'executed' };
    }
    if (r.postOnly && ((r.side === 'bid' && ask !== undefined && r.price >= ask) || (r.side === 'ask' && bid !== undefined && r.price <= bid))) throw new Error('post-only order would cross');
    const o: PaperOrder = { orderId: id, clientOrderId: r.clientOrderId, ticker: r.ticker, side: r.side, price: r.price, remaining: count, status: 'resting', asset, postOnly: r.postOnly };
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
    return Object.entries(this.st.positions).filter(([, p]) => p.position !== 0).map(([ticker, p]) => ({ ticker, position: p.position, entryPrice: p.entryPrice, unrealizedPnl: this.unrealized(ticker, p) }));
  }

  private unrealized(ticker: string, p: PaperPos): number {
    const asset = this.tickerAsset(ticker);
    const m = asset ? this.book(asset).mark : undefined;
    return p.position !== 0 && m !== undefined ? p.position * (m - p.entryPrice) : 0;
  }

  async getBalance(): Promise<PerpBalance> {
    let eq = this.st.startBalance ?? 0;
    for (const [t, p] of Object.entries(this.st.positions)) eq += p.realized - p.fees + p.funding + this.unrealized(t, p);
    return { equity: eq };
  }

  async setStopLoss(ticker: string, stopPrice: number): Promise<void> { this.st.stops![ticker] = stopPrice; this.save(); }
  async clearStopLoss(ticker: string): Promise<void> { delete this.st.stops![ticker]; this.save(); }
  stopFor(ticker: string): number | undefined { return this.st.stops?.[ticker]; }

  /** Realized P&L, fees and funding per ticker (dashboard, research). */
  ledger() { return this.st.positions; }
  stopFills(): number { return this.st.stopFills ?? 0; }
}

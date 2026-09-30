// Exit policies compared in the backtester (research:backtest --exits ...).
//
//   hold              hold every position to settlement (no settlement fee).
//   fair_value        production rule: sell when the market bid for our side
//                     exceeds model fair value + exit fee + buffer.
//   liquidity_ratchet order-book-anchored ratcheting stop (below).
//   hybrid            liquidity_ratchet, but a triggered stop only exits if
//                     the model agrees the position is worth less than the
//                     stop (otherwise hold); fair_value exits stay active.
//
// Liquidity ratchet
//   - Exit-side book levels (YES bids for a long YES; NO bids = 1 - YES asks
//     for a long NO) whose resting size can absorb the WHOLE position
//     (size >= minFillRatio x position) and that have persisted for
//     minWallAgeMs are "walls": prices where an exit can realistically fill.
//   - When price moves past a wall (the best exit price is above it), that
//     wall becomes the stop. The stop only ratchets up, to the highest wall
//     the price has moved past.
//   - If price comes back down to the stop, exit with an immediate-or-cancel
//     reduce-only order limited to stop - slippageTicks.
//   - If price gaps through (best < stop - slippage) the order cannot fill;
//     the stop drops to the highest wall still below the price.
// Pure logic: no I/O. All prices here are in "side" terms (the price of the
// contract side we hold), converted to YES terms only for the order.

import type { OrderBook } from '../marketdata/orderBook';
import type { BookSide } from '../kalshi/types';
import { orderFee, type FeeSchedule } from '../fees';
import { round } from '../util/num';

export type ExitPolicyName = 'hold' | 'fair_value' | 'liquidity_ratchet' | 'hybrid';
export const EXIT_POLICIES: ExitPolicyName[] = ['hold', 'fair_value', 'liquidity_ratchet', 'hybrid'];

export interface RatchetParams {
  /** A level is a wall if its size >= minFillRatio x position size. */
  minFillRatio: number;
  /** A wall must persist this long before it can become a stop (pulled liquidity filter). */
  minWallAgeMs: number;
  /** Exit limit = stop - slippageTicks x tick (worst price accepted). */
  slippageTicks: number;
}

export const DEFAULT_RATCHET: RatchetParams = { minFillRatio: 1, minWallAgeMs: 3000, slippageTicks: 1 };

export interface SideLevel { price: number; size: number }

/** Exit-side levels in side-price terms, best (highest) first. */
export function exitLevels(book: OrderBook, positionSign: number, depth = 50): SideLevel[] {
  const snap = book.snapshot(depth);
  if (positionSign > 0) return snap.bids.map((l) => ({ price: l.price, size: l.size }));
  return snap.asks.map((l) => ({ price: round(1 - l.price, 4), size: l.size }));
}

export interface ExitOrderPlan {
  side: BookSide;
  /** YES-terms limit price. */
  price: number;
  count: number;
  /** Side-terms stop that triggered it. */
  stop: number;
}

export interface RatchetInput {
  position: number;
  book: OrderBook;
  now: number;
  tick: number;
  fees: FeeSchedule;
  /** hybrid only: model probability that OUR side wins. */
  qSide?: number;
  hybrid?: boolean;
}

export type RatchetEvent = 'armed' | 'ratcheted' | 'triggered' | 'gapped' | 'hybrid_hold' | undefined;

export class LiquidityRatchet {
  stop: number | undefined;
  private sign = 0;
  private readonly since = new Map<number, number>();

  constructor(private readonly p: RatchetParams = DEFAULT_RATCHET) {}

  reset(): void {
    this.stop = undefined;
    this.sign = 0;
    this.since.clear();
  }

  evaluate(i: RatchetInput): { plan?: ExitOrderPlan; event: RatchetEvent; stop?: number } {
    if (Math.abs(i.position) < 1e-9) { this.reset(); return { event: undefined }; }
    const sign = Math.sign(i.position);
    if (sign !== this.sign) { this.reset(); this.sign = sign; }
    const n = Math.abs(i.position);
    const need = this.p.minFillRatio * n;
    const levels = exitLevels(i.book, sign);

    // Track how long each level has continuously been a wall.
    const key = (p: number) => Math.round(p * 10000);
    const live = new Set<number>();
    for (const l of levels) {
      if (l.size + 1e-9 >= need) {
        const k = key(l.price);
        live.add(k);
        if (!this.since.has(k)) this.since.set(k, i.now);
      }
    }
    for (const k of [...this.since.keys()]) if (!live.has(k)) this.since.delete(k);

    const best = levels[0]?.price;
    if (best === undefined) return { event: undefined, stop: this.stop };
    const aged = (price: number) => {
      const s = this.since.get(key(price));
      return s !== undefined && i.now - s >= this.p.minWallAgeMs;
    };
    const wallBelow = (limit: number) => levels.filter((l) => l.price < limit - 1e-9 && l.size + 1e-9 >= need && aged(l.price)).reduce<number | undefined>((m, l) => (m === undefined || l.price > m ? l.price : m), undefined);

    let event: RatchetEvent;
    const slip = this.p.slippageTicks * i.tick;

    if (this.stop !== undefined && best <= this.stop + 1e-9) {
      if (best < this.stop - slip - 1e-9) {
        // Gapped through: the exit cannot fill at an acceptable price. Fall back to the next wall down.
        this.stop = wallBelow(best);
        return { event: 'gapped', stop: this.stop };
      }
      if (i.hybrid && i.qSide !== undefined) {
        const feePer = orderFee(n, this.stop, true, i.fees) / n;
        if (i.qSide >= this.stop + feePer) return { event: 'hybrid_hold', stop: this.stop };
      }
      const limitSide = round(Math.max(i.tick, this.stop - slip), 4);
      const plan: ExitOrderPlan = sign > 0
        ? { side: 'ask', price: limitSide, count: round(n, 2), stop: this.stop }
        : { side: 'bid', price: round(1 - limitSide, 4), count: round(n, 2), stop: this.stop };
      return { plan, event: 'triggered', stop: this.stop };
    }

    // Ratchet: the highest persistent wall the price has moved past.
    const candidate = wallBelow(best);
    if (candidate !== undefined && (this.stop === undefined || candidate > this.stop + 1e-9)) {
      event = this.stop === undefined ? 'armed' : 'ratcheted';
      this.stop = candidate;
    }
    return { event, stop: this.stop };
  }
}

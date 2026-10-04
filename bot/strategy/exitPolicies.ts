// Exit policies compared in the backtester (research:backtest --exits ...).
//
//   hold              hold every position to settlement (no settlement fee).
//   fair_value        model exit: sell when the market bid for our side
//                     exceeds the model's value + exit fee + margin.
//   take_profit       Mode B (relaxed spec): a resting maker take-profit at
//                     entry + TP (never below model value) plus the model exit.
//   liquidity_ratchet order-book-anchored ratcheting stop (below).
//   hybrid            liquidity_ratchet, but a triggered stop only exits if
//                     the model agrees the position is worth less than the
//                     stop (otherwise hold); fair_value exits stay active.
//   confluence_ratchet fair_value normally; switches to "hunt" mode — the
//                     liquidity ratchet manages the exit and nothing else may
//                     reduce the position — only while the contract has
//                     outperformed its entry fair value AND confluence agrees
//                     with the position (ConfluenceRatchetExit below).
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

export type ExitPolicyName = 'hold' | 'fair_value' | 'take_profit' | 'liquidity_ratchet' | 'hybrid' | 'confluence_ratchet';
export const EXIT_POLICIES: ExitPolicyName[] = ['hold', 'fair_value', 'take_profit', 'liquidity_ratchet', 'hybrid', 'confluence_ratchet'];

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
  /** Profit lock (side terms): the stop never sits below this, arms at it, and only a price
   * strictly BELOW the stop triggers (a trailing stop that "begins at the target price"). */
  floor?: number;
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
    if (i.floor !== undefined && (this.stop === undefined || this.stop < i.floor - 1e-9)) {
      event = this.stop === undefined ? 'armed' : 'ratcheted';
      this.stop = i.floor;
    }
    const hit = this.stop !== undefined && (i.floor !== undefined ? best < this.stop - 1e-9 : best <= this.stop + 1e-9);

    if (this.stop !== undefined && hit) {
      if (best < this.stop - slip - 1e-9) {
        // Gapped through: the exit cannot fill at an acceptable price. Fall back to the next wall down
        // (never below the profit lock: the caller decides what to do below it).
        const below = wallBelow(best);
        this.stop = i.floor !== undefined ? Math.max(i.floor, below ?? i.floor) : below;
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
      event = this.stop === undefined ? 'armed' : event === 'armed' ? 'armed' : 'ratcheted';
      this.stop = candidate;
    }
    return { event, stop: this.stop };
  }
}

// ---- Confluence-gated ratchet ("let the winner run") ----------------------

export interface HuntParams {
  /** Hunt only once the exit price exceeds entry fair value by this much (side terms). */
  targetMargin: number;
  /** Minimum confluence score oriented to the position (conf_count x side sign). */
  minConfluence: number;
}

export const DEFAULT_HUNT: HuntParams = { targetMargin: 0.02, minConfluence: 2 };

export type HuntEvent = 'activated' | 'profit_take_confluence' | 'profit_take_session' | 'profit_take_gap' | 'deactivated_giveback' | 'deactivated_session' | RatchetEvent;

export interface HuntInput {
  position: number;
  /** Model probability that OUR side wins, now. */
  qSide: number;
  /** Best price we could sell our side at now (side terms). */
  sideBid: number | undefined;
  /** conf_count feature (NaN when unavailable). */
  confluence: number;
  book: OrderBook;
  now: number;
  tick: number;
  fees: FeeSchedule;
  /** Reason hunt mode is unsafe in the current market session (see sessionRisk.ts), if any. */
  sessionBlocked?: string;
}

export interface HuntDecision {
  mode: 'fair_value' | 'hunt';
  plan?: ExitOrderPlan;
  event?: HuntEvent;
  target?: number;
  stop?: number;
}

/**
 * Normal behaviour is the fair-value exit. Hunt mode ("let the winner run")
 * switches on only when BOTH:
 *   - the exit price has beaten the entry fair value + targetMargin (the
 *     TARGET), and
 *   - confluence oriented to the position >= minConfluence.
 * Once on, profit is hunted with an order-book ratcheting trailing stop:
 *   - the stop starts AT the target (the profit is locked from activation);
 *   - as the surge continues it ratchets up to the highest exit-side wall the
 *     price has moved past: a level big enough to fill the whole position that
 *     has persisted (so the exit can actually be filled there);
 *   - when the price reverses to below the stop, exit reduce-only there.
 * Take-profit early, at the bid (never below the lock): confluence flips
 * against the position, or the session turns unsafe for book-anchored stops.
 * A gap through the stop sells at the bid while still above the entry fair
 * value; below it, hunt mode ends and the fair-value exit takes over.
 */
export class ConfluenceRatchetExit {
  private readonly ratchet: LiquidityRatchet;
  private sign = 0;
  entryQ: number | undefined;
  active = false;
  /** Profit lock (side terms) set at activation. */
  floor: number | undefined;

  constructor(private readonly h: HuntParams = DEFAULT_HUNT, ratchet: RatchetParams = DEFAULT_RATCHET) {
    this.ratchet = new LiquidityRatchet(ratchet);
  }

  reset(): void {
    this.sign = 0;
    this.entryQ = undefined;
    this.active = false;
    this.floor = undefined;
    this.ratchet.reset();
  }

  private sellAtBid(i: HuntInput, sign: number): ExitOrderPlan {
    const n = round(Math.abs(i.position), 2);
    const px = i.sideBid!;
    return sign > 0 ? { side: 'ask', price: round(px, 4), count: n, stop: px } : { side: 'bid', price: round(1 - px, 4), count: n, stop: px };
  }

  update(i: HuntInput): HuntDecision {
    if (Math.abs(i.position) < 1e-9) { this.reset(); return { mode: 'fair_value' }; }
    const sign = Math.sign(i.position);
    if (sign !== this.sign) { this.reset(); this.sign = sign; this.entryQ = i.qSide; }
    const target = this.entryQ! + this.h.targetMargin;
    const oriented = Number.isFinite(i.confluence) ? sign * i.confluence : NaN;

    if (!this.active) {
      // Thin/transitional session liquidity: never START hunting with book-anchored stops.
      if (i.sessionBlocked) return { mode: 'fair_value', target };
      if (!(i.sideBid !== undefined && i.sideBid >= target - 1e-9 && oriented >= this.h.minConfluence)) return { mode: 'fair_value', target };
      this.active = true;
      this.ratchet.reset();
      this.floor = round(Math.floor(target / i.tick + 1e-9) * i.tick, 4);
      const r0 = this.ratchet.evaluate({ position: i.position, book: i.book, now: i.now, tick: i.tick, fees: i.fees, floor: this.floor });
      return { mode: 'hunt', event: 'activated', target, stop: r0.stop };
    }

    // Take the locked profit early at the bid when the reason to hunt is gone.
    const above = i.sideBid !== undefined && i.sideBid >= this.floor! - 1e-9;
    if (i.sessionBlocked && above) return { mode: 'hunt', plan: this.sellAtBid(i, sign), event: 'profit_take_session', target, stop: this.ratchet.stop };
    if (oriented <= -this.h.minConfluence && above) return { mode: 'hunt', plan: this.sellAtBid(i, sign), event: 'profit_take_confluence', target, stop: this.ratchet.stop };

    const r = this.ratchet.evaluate({ position: i.position, book: i.book, now: i.now, tick: i.tick, fees: i.fees, floor: this.floor });
    if (r.event === 'gapped') {
      if (i.sideBid !== undefined && i.sideBid >= this.entryQ! - 1e-9) return { mode: 'hunt', plan: this.sellAtBid(i, sign), event: 'profit_take_gap', target, stop: r.stop };
      this.active = false;
      this.floor = undefined;
      this.ratchet.reset();
      return { mode: 'fair_value', event: 'deactivated_giveback', target };
    }
    return { mode: 'hunt', plan: r.plan, event: r.event, target, stop: r.stop };
  }
}

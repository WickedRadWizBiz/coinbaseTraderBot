// Strategy: price the contract, then
//  1. MAKER (default): rest post_only quotes around the decision probability
//     q, fee-free on series with a zero maker multiplier, skewed against
//     inventory, pulled on fast index moves and outside the entry window.
//     Relaxed spec: bid at floor(q_adj - e_min - buffer), where the buffer is
//     the adverse-selection haircut measured from 60 s markouts. A quote sizing
//     wants is at least minQuoteContracts (within the per-order caps and the
//     risk room left): Kalshi rounds each order's fee up to the cent, so a small
//     position pays more a contract to sell. A quote due to expire on the
//     exchange is placed again.
//  2. TAKER (optional): cross only when q beats the touch by the taker fee
//     plus minEdge plus takerBuffer (5c in the relaxed spec), then hold.
//  3. EXIT: never a percentage stop. Profit target: sell at the bid as soon as
//     that banks profitTargetPct of what a contract cost (price plus entry fee;
//     10% by default) and at least profitTarget a contract, net of the entry's
//     fees and this exit's taker fee, whatever the model thinks the contract is
//     worth: gains banked as they come. Model exit: sell at the bid when the bid minus
//     the taker fee beats q + exitMargin (the market overpays, or the model
//     turned against the position). Mode B adds a resting maker take-profit at
//     entry + TP, never offered below what the model thinks the position is
//     worth. Inside the final minute positions ride to settlement.
//
// q is the model probability, or with target-EV sizing q_adj = p_mkt_cal +
// kappa * (p_model - p_mkt_cal): the model shrunk toward the calibrated market.
//
// Pure function: no I/O. The engine turns plans into risk-checked orders.

import type { StrategyConfig } from '../config';
import { orderFee, type FeeSchedule } from '../fees';
import type { BookSide, TimeInForce } from '../kalshi/types';
import type { OrderPurpose } from '../oms/orderState';
import { evThresholds, kellySize, targetEvSize } from '../sizing/kelly';
import { ceilToTick, floorCount, floorToTick, round } from '../util/num';

export interface RestingQuote {
  clientOrderId: string;
  price: number;
  remaining: number;
  /** When the exchange expires it (unix seconds). */
  expiresSec?: number;
}

export interface MarketView {
  ticker: string;
  pYes: number;
  bestBid?: { price: number; size: number };
  bestAsk?: { price: number; size: number };
  position: number;
  bankroll: number;
  /** Remaining room under the per-order risk cap (dollars). */
  maxOrderRiskUsd: number;
  /** Risk room left under the window and total caps and in free cash (dollars): a quote is only raised to the
   *  minimum size inside it. Unbounded when not given. */
  newRiskRoomUsd?: number;
  maxContracts: number;
  minSidePrice: number;
  tauSec: number;
  noEntryBeforeCloseSec: number;
  fastMove: boolean;
  tickSize: number;
  fees: FeeSchedule;
  restingBid?: RestingQuote;
  restingAsk?: RestingQuote;
  nowSec: number;
  closeSec: number;
  /** Calibrated market probability of YES (p_mkt_cal); target-EV sizing shrinks toward it. */
  pMarket?: number;
  /** Model uncertainty: std of P(YES) across ensemble members. */
  pStd?: number;
  /** Maker adverse-selection buffer in dollars (added to minEdge for quotes). */
  makerBuffer?: number;
  /** Average entry price of the side currently held (profit target, Mode B take-profit). */
  entrySidePrice?: number;
  /** Fees already paid, a contract held (the profit target nets them out). */
  entryFeePerContract?: number;
  /** Entry window open (contract kind, time to close, maintenance). Default: tau >= noEntryBeforeCloseSec. */
  entryWindowOpen?: boolean;
  /** Exits allowed (false in the final minute: ride to settlement). Default true. */
  exitWindowOpen?: boolean;
}

export interface OrderPlan {
  side: BookSide;
  price: number;
  count: number;
  timeInForce: TimeInForce;
  postOnly: boolean;
  reduceOnly: boolean;
  purpose: OrderPurpose;
  expirationTime?: number;
  edge: number;
  why: string;
  /** Adversarial conviction boost applied to this entry's size (1 = none); widens its per-order caps. */
  boost?: number;
}

export interface StrategyOutput {
  place: OrderPlan[];
  cancel: Array<{ clientOrderId: string; reason: string }>;
  notes: string[];
}

/** Decision probability of YES: the model, or shrunk toward the calibrated market under target-EV sizing. */
export function decisionProbability(v: Pick<MarketView, 'pYes' | 'pMarket'>, cfg: Pick<StrategyConfig, 'sizing' | 'kappa'>): number {
  if (cfg.sizing !== 'target_ev' || v.pMarket === undefined) return v.pYes;
  return v.pMarket + cfg.kappa * (v.pYes - v.pMarket);
}

/** `opts.exits: false` disables the built-in model exit (another exit policy
 * manages the position). `opts.blockReductions: true` suppresses every order
 * that would reduce the current position (the opposite-side quote and
 * opposite-side takes), used while a winner is being run under the confluence
 * ratchet. `opts.entries: false` evaluates exits only and leaves resting quotes
 * untouched (relaxed cadence between scheduled evaluations). */
export function decide(v: MarketView, cfg: StrategyConfig, opts: { exits?: boolean; blockReductions?: boolean; entries?: boolean } = {}): StrategyOutput {
  const out: StrategyOutput = { place: [], cancel: [], notes: [] };
  const tick = v.tickSize;
  const bid = v.bestBid;
  const ask = v.bestAsk;
  const q = decisionProbability(v, cfg);
  const targetEv = cfg.sizing === 'target_ev';
  // Probabilities for the PURCHASED side: YES -> (q, p_mkt), NO -> (1 - q, 1 - p_mkt).
  const size = (side: 'yes' | 'no', cost: number, fee: number, maxContracts: number) => {
    const qm = side === 'yes' ? v.pYes : 1 - v.pYes;
    if (targetEv && v.pMarket !== undefined) {
      const qk = side === 'yes' ? v.pMarket : 1 - v.pMarket;
      return targetEvSize({ qModel: qm, qMarket: qk, cost, feePerContract: fee, bankroll: v.bankroll, maxRiskUsd: v.maxOrderRiskUsd, maxContracts },
        { kappa: cfg.kappa, kellyFraction: cfg.kellyFraction, ...evThresholds(cfg, v.bankroll, v.maxOrderRiskUsd), minEdge: cfg.minEdge });
    }
    return kellySize({ q: side === 'yes' ? q : 1 - q, cost, feePerContract: fee, bankroll: v.bankroll, kellyFraction: cfg.kellyFraction, maxRiskUsd: v.maxOrderRiskUsd, maxContracts });
  };
  // A maker quote sizing wants (contracts > 0) is at least minQuoteContracts, as far as the per-order caps and the risk
  // room left allow; never smaller than sizing asked for.
  const quoteSize = (contracts: number, cost: number, fee: number) => {
    const min = cfg.minQuoteContracts ?? 0;
    if (!(contracts > 0) || contracts >= min) return contracts;
    const room = Math.min(v.maxOrderRiskUsd, v.newRiskRoomUsd ?? Infinity);
    return Math.max(contracts, floorCount(Math.min(min, v.maxContracts, room / (cost + fee))));
  };

  // ---- Exits (risk-reducing, allowed in every style) ------------------------
  const exitWindow = v.exitWindowOpen !== false;
  if (!exitWindow && v.position !== 0) out.notes.push('final minute: riding to settlement');
  const exits = opts.exits !== false && exitWindow;
  const margin = cfg.exitMargin ?? cfg.takerBuffer;
  // Profit target: what selling the held side at its touch banks a contract over its cost, net of every fee, against
  // the larger of the cents floor and the percentage of what a contract cost (price plus the entry fee).
  const target = v.entrySidePrice === undefined ? 0 : Math.max(cfg.profitTarget ?? 0, (cfg.profitTargetPct ?? 0) * (v.entrySidePrice + (v.entryFeePerContract ?? 0)));
  const banked = (sidePx: number, exitFee: number) => (target > 0 ? sidePx - v.entrySidePrice! - (v.entryFeePerContract ?? 0) - exitFee : -Infinity);
  if (exits && v.position > 0 && bid) {
    const n = Math.min(v.position, bid.size);
    const fee = n > 0 ? orderFee(n, bid.price, true, v.fees) / n : 0;
    const edge = bid.price - q - fee;
    const net = banked(bid.price, fee);
    const tp = net >= target - 1e-9;
    if (n > 0 && (edge >= margin || tp)) {
      out.place.push({ side: 'ask', price: bid.price, count: round(n, 2), timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: true, purpose: 'exit', edge,
        why: tp ? `profit target: +${net.toFixed(3)} a contract net of fees >= ${target.toFixed(3)}` : `bid ${bid.price} - fee > q ${q.toFixed(3)} + ${margin}` });
    }
  } else if (exits && v.position < 0 && ask) {
    const n = Math.min(-v.position, ask.size);
    const noBid = round(1 - ask.price, 4);
    const fee = n > 0 ? orderFee(n, noBid, true, v.fees) / n : 0;
    const edge = q - ask.price - fee;
    const net = banked(noBid, fee);
    const tp = net >= target - 1e-9;
    if (n > 0 && (edge >= margin || tp)) {
      out.place.push({ side: 'bid', price: ask.price, count: round(n, 2), timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: true, purpose: 'exit', edge,
        why: tp ? `profit target: NO +${net.toFixed(3)} a contract net of fees >= ${target.toFixed(3)}` : `NO bid ${noBid.toFixed(2)} - fee > q + ${margin}` });
    }
  }

  if (opts.entries === false) return out;

  const entriesAllowed = (v.entryWindowOpen ?? true) && v.tauSec >= v.noEntryBeforeCloseSec;
  // Ensemble veto: the model's disagreement with the market must exceed its own uncertainty.
  const vetoed = v.pStd !== undefined && v.pMarket !== undefined && cfg.ensembleVetoSigmas > 0 && Math.abs(v.pYes - v.pMarket) < cfg.ensembleVetoSigmas * v.pStd;
  const newRisk = entriesAllowed && !vetoed;
  const quoteAllowed = newRisk && !v.fastMove;
  if (!entriesAllowed) out.notes.push('outside entry window');
  if (vetoed) out.notes.push(`ensemble veto: |p - p_mkt| < ${cfg.ensembleVetoSigmas} x ${v.pStd!.toFixed(3)}`);
  if (v.fastMove) out.notes.push('fast index move: quotes pulled');

  // ---- Maker quotes -----------------------------------------------------------
  let desiredBid: OrderPlan | undefined;
  let desiredAsk: OrderPlan | undefined;
  const quoting = (cfg.style === 'maker' || cfg.style === 'both') && bid && ask;
  const offset = cfg.minEdge + (v.makerBuffer ?? 0);
  const expiry = Math.min(v.nowSec + cfg.orderTtlSec, v.closeSec - Math.max(1, Math.floor(v.noEntryBeforeCloseSec)));
  if (quoting && quoteAllowed) {
    const skewed = q - cfg.inventorySkewPerContract * v.position;

    // YES bid.
    let bp = floorToTick(skewed - offset, tick);
    bp = Math.min(bp, round(ask.price - tick, 4));
    if (bp >= v.minSidePrice && bp <= 1 - v.minSidePrice) {
      const fee = orderFee(1, bp, false, v.fees);
      const k = size('yes', bp, fee, v.maxContracts);
      const unwind = Math.max(0, -v.position);
      const count = round(Math.min(v.maxContracts, quoteSize(k.contracts, bp, fee) + unwind), 2);
      if (count > 0) desiredBid = { side: 'bid', price: bp, count, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', expirationTime: expiry, edge: q - bp - fee, why: 'maker bid' };
    }
    // YES ask (= NO bid at 1 - ap).
    let ap = ceilToTick(skewed + offset, tick);
    ap = Math.max(ap, round(bid.price + tick, 4));
    const noCost = round(1 - ap, 4);
    if (noCost >= v.minSidePrice && noCost <= 1 - v.minSidePrice) {
      const fee = orderFee(1, noCost, false, v.fees);
      const k = size('no', noCost, fee, v.maxContracts);
      const unwind = Math.max(0, v.position);
      const count = round(Math.min(v.maxContracts, quoteSize(k.contracts, noCost, fee) + unwind), 2);
      if (count > 0) desiredAsk = { side: 'ask', price: ap, count, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', expirationTime: expiry, edge: (1 - q) - noCost - fee, why: 'maker ask' };
    }
  }
  // Mode B: a resting maker take-profit on the held side at entry + TP, never below
  // the model's value of the position + exitMargin (then holding is better).
  if (quoting && cfg.exitPolicy === 'take_profit' && v.position !== 0 && v.entrySidePrice !== undefined && !opts.blockReductions) {
    const long = v.position > 0;
    const qSide = long ? q : 1 - q;
    const sidePx = Math.max(v.entrySidePrice + cfg.takeProfit, qSide + margin);
    const n = round(Math.abs(v.position), 2);
    if (sidePx < 1) {
      if (long) {
        const ap = Math.max(ceilToTick(sidePx, tick), round(bid!.price + tick, 4));
        desiredAsk = { side: 'ask', price: ap, count: n, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', expirationTime: v.closeSec - 1, edge: ap - qSide, why: `take-profit ${ap}` };
      } else {
        const bp = Math.min(floorToTick(1 - sidePx, tick), round(ask!.price - tick, 4));
        desiredBid = { side: 'bid', price: bp, count: n, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', expirationTime: v.closeSec - 1, edge: (1 - bp) - qSide, why: `take-profit NO ${round(1 - bp, 4)}` };
      }
    }
  }
  if (opts.blockReductions) {
    if (v.position > 0) desiredAsk = undefined;
    if (v.position < 0) desiredBid = undefined;
  }
  reconcileQuote(v.restingBid, desiredBid, cfg.requoteThreshold, v.nowSec, out);
  reconcileQuote(v.restingAsk, desiredAsk, cfg.requoteThreshold, v.nowSec, out);

  // ---- Selective taking -------------------------------------------------------
  if ((cfg.style === 'taker' || cfg.style === 'both') && newRisk && !v.fastMove && out.place.every((p) => p.purpose !== 'exit')) {
    const mayBuyYes = !(opts.blockReductions && v.position < 0);
    const mayBuyNo = !(opts.blockReductions && v.position > 0);
    if (mayBuyYes && ask && ask.price >= v.minSidePrice && ask.price <= 1 - v.minSidePrice) {
      const fee1 = orderFee(1, ask.price, true, v.fees);
      const k = size('yes', ask.price, fee1, Math.min(v.maxContracts, ask.size));
      if (k.contracts > 0) {
        const fee = orderFee(k.contracts, ask.price, true, v.fees) / k.contracts;
        const edge = q - ask.price - fee;
        if (edge >= cfg.takerBuffer + cfg.minEdge) {
          out.place.push({ side: 'bid', price: ask.price, count: k.contracts, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: false, purpose: 'entry', edge, why: `take YES: q ${q.toFixed(3)} vs ask ${ask.price}` });
        }
      }
    }
    const noCost = bid ? round(1 - bid.price, 4) : 0;
    if (mayBuyNo && bid && noCost >= v.minSidePrice && noCost <= 1 - v.minSidePrice) {
      const fee1 = orderFee(1, noCost, true, v.fees);
      const k = size('no', noCost, fee1, Math.min(v.maxContracts, bid.size));
      if (k.contracts > 0) {
        const fee = orderFee(k.contracts, noCost, true, v.fees) / k.contracts;
        const edge = (1 - q) - noCost - fee;
        if (edge >= cfg.takerBuffer + cfg.minEdge) {
          out.place.push({ side: 'ask', price: bid.price, count: k.contracts, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: false, purpose: 'entry', edge, why: `take NO: q ${q.toFixed(3)} vs bid ${bid.price}` });
        }
      }
    }
  }
  return out;
}

/** A resting quote this close to its exchange expiry (seconds) is replaced rather than left to lapse. */
const EXPIRY_LEAD_SEC = 1;

function reconcileQuote(resting: RestingQuote | undefined, desired: OrderPlan | undefined, threshold: number, nowSec: number, out: StrategyOutput): void {
  if (resting && !desired) {
    out.cancel.push({ clientOrderId: resting.clientOrderId, reason: 'quote no longer wanted' });
    return;
  }
  if (!desired) return;
  if (!resting) {
    out.place.push(desired);
    return;
  }
  const moved = Math.abs(resting.price - desired.price) >= threshold - 1e-9;
  // Only requote size when it shrinks materially (never chase size up and lose queue priority).
  const shrink = desired.count < resting.remaining * 0.5;
  // A quote at its exchange expiry is placed again, when the replacement would outlive it (not at the close, where both end together).
  const expiring = resting.expiresSec !== undefined && resting.expiresSec - nowSec <= EXPIRY_LEAD_SEC && (desired.expirationTime ?? Infinity) > resting.expiresSec;
  if (moved || shrink || expiring) {
    out.cancel.push({ clientOrderId: resting.clientOrderId, reason: moved ? `requote ${resting.price} -> ${desired.price}` : shrink ? 'size shrink' : 'quote expiring' });
    out.place.push(desired);
  }
}

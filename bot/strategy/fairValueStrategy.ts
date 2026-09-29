// Strategy: price the contract, then
//  1. MAKER (default): rest post_only quotes around fair value, fee-free on
//     series with a zero maker multiplier, skewed against inventory, pulled on
//     fast index moves and near close.
//  2. TAKER (optional): cross only when fair value beats the touch by the
//     taker fee plus a buffer, and hold to settlement (no second fee).
//  3. EXIT: never a percentage stop. Exit early only when the market pays
//     more than fair value plus the exit fee plus a buffer.
//
// Pure function: no I/O. The engine turns plans into risk-checked orders.

import type { StrategyConfig } from '../config';
import { orderFee, type FeeSchedule } from '../fees';
import type { BookSide, TimeInForce } from '../kalshi/types';
import type { OrderPurpose } from '../oms/orderState';
import { kellySize } from '../sizing/kelly';
import { ceilToTick, floorToTick, round } from '../util/num';

export interface RestingQuote {
  clientOrderId: string;
  price: number;
  remaining: number;
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
}

export interface StrategyOutput {
  place: OrderPlan[];
  cancel: Array<{ clientOrderId: string; reason: string }>;
  notes: string[];
}

export function decide(v: MarketView, cfg: StrategyConfig): StrategyOutput {
  const out: StrategyOutput = { place: [], cancel: [], notes: [] };
  const tick = v.tickSize;
  const bid = v.bestBid;
  const ask = v.bestAsk;

  // ---- Exits (risk-reducing, allowed in every style) ------------------------
  if (v.position > 0 && bid) {
    const n = Math.min(v.position, bid.size);
    const fee = n > 0 ? orderFee(n, bid.price, true, v.fees) / n : 0;
    const edge = bid.price - v.pYes - fee;
    if (n > 0 && edge >= cfg.takerBuffer) {
      out.place.push({ side: 'ask', price: bid.price, count: round(n, 2), timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: true, purpose: 'exit', edge, why: `bid ${bid.price} > fv ${v.pYes.toFixed(3)} + fee` });
    }
  } else if (v.position < 0 && ask) {
    const n = Math.min(-v.position, ask.size);
    const fee = n > 0 ? orderFee(n, 1 - ask.price, true, v.fees) / n : 0;
    const edge = v.pYes - ask.price - fee;
    if (n > 0 && edge >= cfg.takerBuffer) {
      out.place.push({ side: 'bid', price: ask.price, count: round(n, 2), timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: true, purpose: 'exit', edge, why: `NO bid ${(1 - ask.price).toFixed(2)} > fv + fee` });
    }
  }

  const entriesAllowed = v.tauSec >= v.noEntryBeforeCloseSec;
  const quoteAllowed = entriesAllowed && !v.fastMove;
  if (!entriesAllowed) out.notes.push('inside no-entry window');
  if (v.fastMove) out.notes.push('fast index move: quotes pulled');

  // ---- Maker quotes -----------------------------------------------------------
  let desiredBid: OrderPlan | undefined;
  let desiredAsk: OrderPlan | undefined;
  if ((cfg.style === 'maker' || cfg.style === 'both') && quoteAllowed && bid && ask) {
    const skewed = v.pYes - cfg.inventorySkewPerContract * v.position;
    const expiry = Math.min(v.nowSec + cfg.orderTtlSec, v.closeSec - Math.max(1, Math.floor(v.noEntryBeforeCloseSec)));

    // YES bid.
    let bp = floorToTick(skewed - cfg.minEdge, tick);
    bp = Math.min(bp, round(ask.price - tick, 4));
    if (bp >= v.minSidePrice && bp <= 1 - v.minSidePrice) {
      const fee = orderFee(1, bp, false, v.fees);
      const k = kellySize({ q: v.pYes, cost: bp, feePerContract: fee, bankroll: v.bankroll, kellyFraction: cfg.kellyFraction, maxRiskUsd: v.maxOrderRiskUsd, maxContracts: v.maxContracts });
      const unwind = Math.max(0, -v.position);
      const count = round(Math.min(v.maxContracts, k.contracts + unwind), 2);
      if (count > 0) desiredBid = { side: 'bid', price: bp, count, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', expirationTime: expiry, edge: v.pYes - bp - fee, why: 'maker bid' };
    }
    // YES ask (= NO bid at 1 - ap).
    let ap = ceilToTick(skewed + cfg.minEdge, tick);
    ap = Math.max(ap, round(bid.price + tick, 4));
    const noCost = round(1 - ap, 4);
    if (noCost >= v.minSidePrice && noCost <= 1 - v.minSidePrice) {
      const fee = orderFee(1, noCost, false, v.fees);
      const k = kellySize({ q: 1 - v.pYes, cost: noCost, feePerContract: fee, bankroll: v.bankroll, kellyFraction: cfg.kellyFraction, maxRiskUsd: v.maxOrderRiskUsd, maxContracts: v.maxContracts });
      const unwind = Math.max(0, v.position);
      const count = round(Math.min(v.maxContracts, k.contracts + unwind), 2);
      if (count > 0) desiredAsk = { side: 'ask', price: ap, count, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', expirationTime: expiry, edge: (1 - v.pYes) - noCost - fee, why: 'maker ask' };
    }
  }
  reconcileQuote(v.restingBid, desiredBid, cfg.requoteThreshold, out);
  reconcileQuote(v.restingAsk, desiredAsk, cfg.requoteThreshold, out);

  // ---- Selective taking -------------------------------------------------------
  if ((cfg.style === 'taker' || cfg.style === 'both') && entriesAllowed && !v.fastMove && out.place.every((p) => p.purpose !== 'exit')) {
    if (ask && ask.price >= v.minSidePrice && ask.price <= 1 - v.minSidePrice) {
      const fee1 = orderFee(1, ask.price, true, v.fees);
      const k = kellySize({ q: v.pYes, cost: ask.price, feePerContract: fee1, bankroll: v.bankroll, kellyFraction: cfg.kellyFraction, maxRiskUsd: v.maxOrderRiskUsd, maxContracts: Math.min(v.maxContracts, ask.size) });
      if (k.contracts > 0) {
        const fee = orderFee(k.contracts, ask.price, true, v.fees) / k.contracts;
        const edge = v.pYes - ask.price - fee;
        if (edge >= cfg.takerBuffer + cfg.minEdge) {
          out.place.push({ side: 'bid', price: ask.price, count: k.contracts, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: false, purpose: 'entry', edge, why: `take YES: fv ${v.pYes.toFixed(3)} vs ask ${ask.price}` });
        }
      }
    }
    const noCost = bid ? round(1 - bid.price, 4) : 0;
    if (bid && noCost >= v.minSidePrice && noCost <= 1 - v.minSidePrice) {
      const fee1 = orderFee(1, noCost, true, v.fees);
      const k = kellySize({ q: 1 - v.pYes, cost: noCost, feePerContract: fee1, bankroll: v.bankroll, kellyFraction: cfg.kellyFraction, maxRiskUsd: v.maxOrderRiskUsd, maxContracts: Math.min(v.maxContracts, bid.size) });
      if (k.contracts > 0) {
        const fee = orderFee(k.contracts, noCost, true, v.fees) / k.contracts;
        const edge = (1 - v.pYes) - noCost - fee;
        if (edge >= cfg.takerBuffer + cfg.minEdge) {
          out.place.push({ side: 'ask', price: bid.price, count: k.contracts, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: false, purpose: 'entry', edge, why: `take NO: fv ${v.pYes.toFixed(3)} vs bid ${bid.price}` });
        }
      }
    }
  }
  return out;
}

function reconcileQuote(resting: RestingQuote | undefined, desired: OrderPlan | undefined, threshold: number, out: StrategyOutput): void {
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
  if (moved || shrink) {
    out.cancel.push({ clientOrderId: resting.clientOrderId, reason: moved ? `requote ${resting.price} -> ${desired.price}` : 'size shrink' });
    out.place.push(desired);
  }
}

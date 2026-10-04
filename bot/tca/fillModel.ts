// Fill / adverse-selection model for maker quotes. Two gradient-boosted tree models trained on the
// bot's OWN quotes (bot/tca/fillLog.ts, data/fills/):
//
//   pFill    P(the quote fills within 60 s | placement features)        (logistic loss)
//   markout  E[60 s markout per contract | it filled, placement features] (squared loss;
//            side-signed: negative = the market moved against us = picked off)
//
// With them the engine compares, per maker entry quote:
//
//   EV_maker = pFill x (edge + markout)          (edge = q - price - fee at decision)
//   EV_taker = q - touch - taker fee             (crossing now instead)
//
// and quotes, crosses or skips, whichever has the higher expected value (skip when neither clears
// FILL_MIN_EV). It does nothing until a model file is VALIDATED (beats the base rate on held-out
// days), so it brings itself online: the logger collects quotes from day one, the pipeline's fill
// step trains once >= 500 quotes and >= 100 fills exist and promotes only a validated model, and the
// engine starts using it the moment it is hot-swapped in.

import fs from 'fs';
import type { BookSide } from '../kalshi/types';
import type { OrderBook } from '../marketdata/orderBook';
import type { OrderPlan } from '../strategy/fairValueStrategy';
import { takerFee } from '../fees';
import { gbdtLogit, validateGbdt, type GbdtModel } from '../model/trees';

export const FILL_FEATURES = [
  'side_price', 'dist_ticks', 'queue_ahead_log', 'touch_size_log', 'opp_touch_size_log', 'spread_ticks', 'imbalance_side',
  'log_tau_min', 'log_sigma', 'edge', 'ofi_30s_side', 'tfi_60s_side', 'microprice_drift_side', 'trade_intensity_60s', 'vpin_300s',
] as const;

export const FILL_MIN_QUOTES = 500;
export const FILL_MIN_FILLS = 100;
export const FILL_HORIZON_SEC = 60;

export interface FillModelParams {
  version: string;
  features: string[];
  pFill: GbdtModel;
  markout: GbdtModel;
  baseRate: number;
  baseMarkout: number;
  validation: {
    quotes: number; fills: number; holdoutQuotes: number; holdoutFills: number;
    logLossBase: number; logLossModel: number;
    markoutMseBase: number; markoutMseModel: number;
    validated: boolean;
  };
  trainedAt: string;
}

const lg = (x: number) => Math.log(1 + Math.max(0, x));

/** Placement features of a maker quote (side = the order's book side; bid = buy YES). */
export function fillInputs(o: { side: BookSide; price: number; edge: number }, c: { book: OrderBook; tick: number; tauSec: number; sigma: number; features: Record<string, number> }): Record<string, number> {
  const s = o.side === 'bid' ? 1 : -1;
  const bb = c.book.bestBid(), ba = c.book.bestAsk();
  const touch = o.side === 'bid' ? bb : ba, opp = o.side === 'bid' ? ba : bb;
  const tick = c.tick > 0 ? c.tick : 0.01;
  const f = (k: string) => (Number.isFinite(c.features[k]) ? c.features[k] : NaN);
  return {
    side_price: o.side === 'bid' ? o.price : 1 - o.price,
    // 0 = joining the touch, > 0 = behind it, < 0 = improving it.
    dist_ticks: touch ? (s * (touch.price - o.price)) / tick : NaN,
    queue_ahead_log: lg(c.book.sizeAt(o.side, o.price)),
    touch_size_log: touch ? lg(touch.size) : NaN,
    opp_touch_size_log: opp ? lg(opp.size) : NaN,
    spread_ticks: bb && ba ? (ba.price - bb.price) / tick : NaN,
    imbalance_side: s * c.book.imbalance(3),
    log_tau_min: Math.log(Math.max(1 / 60, c.tauSec / 60)),
    log_sigma: c.sigma > 0 ? Math.log(c.sigma) : NaN,
    edge: o.edge,
    ofi_30s_side: s * f('ofi_30s'), tfi_60s_side: s * f('tfi_60s'), microprice_drift_side: s * f('microprice_drift'),
    trade_intensity_60s: f('trade_intensity_60s'), vpin_300s: f('vpin_300s'),
  };
}

export class FillModel {
  constructor(readonly params: FillModelParams) {}

  static load(file: string): FillModel | undefined {
    if (!fs.existsSync(file)) return undefined;
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as FillModelParams;
    if (!Array.isArray(p.features) || !p.pFill?.trees || !p.markout?.trees) throw new Error(`invalid fill model ${file}`);
    validateGbdt(p.pFill, p.features.length);
    validateGbdt(p.markout, p.features.length);
    return new FillModel(p);
  }

  get validated(): boolean { return Boolean(this.params.validation?.validated); }

  private vec(x: Record<string, number>): number[] { return this.params.features.map((k) => (Number.isFinite(x[k]) ? x[k] : NaN)); }
  pFill(x: Record<string, number>): number { return 1 / (1 + Math.exp(-gbdtLogit(this.params.pFill, this.vec(x)))); }
  /** Expected side-signed 60 s markout per contract given a fill, clamped to [-0.15, 0.15]. */
  markout(x: Record<string, number>): number { return Math.max(-0.15, Math.min(0.15, gbdtLogit(this.params.markout, this.vec(x)))); }
}

export interface FillDecisionCtx {
  /** Decision probability of YES. */
  q: number;
  book: OrderBook;
  tick: number;
  tauSec: number;
  sigma: number;
  features: Record<string, number>;
  /** Minimum EV per contract for any entry (FILL_MIN_EV). */
  minEv: number;
  /** The strategy's own taker threshold (takerBuffer + minEdge): a cross must clear it too. */
  takerMinEdge: number;
}

/** Maker entry quotes (not take-profit quotes, not exits). */
export const isMakerEntry = (o: OrderPlan) => o.purpose === 'quote' && o.postOnly && !o.reduceOnly && !o.why.startsWith('take-profit');

/** Quote, cross or skip each maker entry by expected value. Does nothing unless the model is validated.
 *  Returns what it changed (for notes / tests). */
export function applyFillModel(plan: { place: OrderPlan[]; notes: string[] }, fm: FillModel | undefined, c: FillDecisionCtx): { crossed: number; skipped: number } {
  const res = { crossed: 0, skipped: 0 };
  if (!fm?.validated) return res;
  const bb = c.book.bestBid(), ba = c.book.bestAsk();
  const next: OrderPlan[] = [];
  for (const o of plan.place) {
    if (!isMakerEntry(o)) { next.push(o); continue; }
    const x = fillInputs(o, c);
    const pf = fm.pFill(x), mk = fm.markout(x);
    const evMaker = pf * (o.edge + mk);
    // Crossing on the same side: buy YES at the ask / sell YES (buy NO) at the bid.
    const touch = o.side === 'bid' ? ba?.price : bb?.price;
    const qSide = o.side === 'bid' ? c.q : 1 - c.q;
    const cost = touch === undefined ? NaN : o.side === 'bid' ? touch : 1 - touch;
    const evTaker = Number.isFinite(cost) ? qSide - cost - takerFee(1, cost) : -Infinity;
    const already = plan.place.some((p) => p !== o && p.side === o.side && p.purpose === 'entry' && !p.postOnly);
    const tag = `fill model ${o.side === 'bid' ? 'YES' : 'NO'}: P(fill) ${pf.toFixed(2)}, markout ${mk >= 0 ? '+' : ''}${mk.toFixed(3)}, EV maker ${evMaker.toFixed(3)} vs taker ${Number.isFinite(evTaker) ? evTaker.toFixed(3) : 'n/a'}`;
    if (!already && touch !== undefined && evTaker > evMaker && evTaker >= c.minEv && evTaker >= c.takerMinEdge) {
      next.push({ ...o, price: touch, timeInForce: 'immediate_or_cancel', postOnly: false, purpose: 'entry', expirationTime: undefined, edge: evTaker, why: `${tag} -> cross` });
      plan.notes.push(`${tag} -> cross`);
      res.crossed++;
    } else if (evMaker < c.minEv) {
      plan.notes.push(`${tag} -> skip`);
      res.skipped++;
    } else {
      next.push(o);
    }
  }
  plan.place = next;
  return res;
}

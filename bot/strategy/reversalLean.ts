// Reversal lean: the TA pieces that hold up on the 15-minute contract's own question, as a small lean toward a bounce
// (thread "Rework TA signals into real bot edge", Oct 31). On a year of synthetic contracts the Bollinger band test moved
// the Up share about 1 point the bounce's way on both sides (z 2.8 / 3.5, 18,000 contracts), RSI under 20 on short bars
// 7 points on few contracts, and at 15 minutes 90% of Binance pairs reverse by sign (Kitron & Wengrowicz 2026). Too
// small to pay a taker fee on its own, so it is used two ways, each off by default and the same in paper and live:
//
//   maker  shifts the quoted centre (both the YES bid and the YES ask) by maker x lean: a maker fill pays no taker fee
//   price  moves the decision probability by price x lean, only while the fair value is within `band` of 50% (a close
//          call), so it tips undecided contracts and never fights a clear one
//
// lean is a vote count in [-3, 3], + for YES: price at or below the lower Bollinger band of the last 5 minutes (+1) or at
// or above the upper (-1); 1-minute RSI(14) at or under 20 (+1) or at or over 80 (-1); and against the last 5 minutes'
// move, -clamp(z, -2, 2) / 2. Each shift is capped at +-max.

export interface ReversalLeanParams {
  /** Job 4: sell a position in profit after fees when the votes against the held side reach this (TA_EXIT_EXTREME_VOTES;
   *  0 = off). The coin stretched in the position's favour is the bounce the lean expects, so the profit is taken first. */
  exitVotes?: number;
  /** Job 4, second iteration (Oct 31): the first sold any profit and cost $0.68/h on the full bot (it cut winners for a cent
   *  and paid the taker fee). It now also needs the bid, net of the exit fee, within `exitEdge` of the fair value for the
   *  held side (TA_EXIT_EXTREME_EDGE; -1 = any) and the sale to lock in at least `exitShare` of the position's most it can
   *  still make by settlement, (1 - cost) a contract (TA_EXIT_EXTREME_SHARE; 0 = any profit). */
  exitEdge?: number;
  exitShare?: number;
  /** Probability points per vote on the quoted centre (TA_LEAN_MAKER; 0 = off). */
  maker: number;
  /** Probability points per vote on the decision probability (TA_LEAN_PRICE; 0 = off). */
  price: number;
  /** The price lean applies only while |fair value - 0.5| < band (TA_LEAN_BAND). */
  band: number;
  /** Cap on either shift (TA_LEAN_MAX). */
  max: number;
}

export const REVERSAL_LEAN_OFF: ReversalLeanParams = { maker: 0, price: 0, band: 0.15, max: 0.02 };

const fin = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x);

/** The vote count from the decision's feature map (+ = YES). Readings the map lacks add nothing. */
export function reversalVotes(f: Record<string, number>): number {
  let v = 0;
  const b = f.bb_pctb_300;
  if (fin(b)) v += b <= 0.05 ? 1 : b >= 0.95 ? -1 : 0;
  const rsi = f.rsi_14_1m;
  if (fin(rsi)) v += rsi <= 20 ? 1 : rsi >= 80 ? -1 : 0;
  const z = f.ret_300s_z;
  if (fin(z)) v += -Math.max(-2, Math.min(2, z)) / 2;
  return v;
}

/** Whether a position of `position` contracts (+ YES, - NO) is at an extreme in its favour (job 4). */
export function extremeExit(p: ReversalLeanParams, f: Record<string, number>, position: number): boolean {
  if (!p.exitVotes || position === 0) return false;
  return -Math.sign(position) * reversalVotes(f) >= p.exitVotes;
}

const cap = (x: number, m: number) => Math.max(-m, Math.min(m, x));

/** The shift of the quoted centre (probability points, + = toward YES). */
export function makerLean(p: ReversalLeanParams, f: Record<string, number>): number {
  return p.maker ? cap(p.maker * reversalVotes(f), p.max) : 0;
}

/** The shift of the decision probability for a fair value `pFair` (+ = toward YES). */
export function priceLean(p: ReversalLeanParams, f: Record<string, number>, pFair: number): number {
  return p.price && Math.abs(pFair - 0.5) < p.band ? cap(p.price * reversalVotes(f), p.max) : 0;
}

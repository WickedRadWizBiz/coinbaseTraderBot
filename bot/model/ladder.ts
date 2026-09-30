// Strike-ladder consistency for hourly contracts (institutional blueprint 2.5).
//
// A 'greater' ladder (KXBTCD) prices P(A >= K) at each strike: it must be
// non-increasing in K. Range brackets (KXBTC) price P(L <= A < U), which
// should equal P(>= L) - P(>= U) of the ladder with the same settlement.
//
//  - isotonicNonIncreasing: pool-adjacent-violators projection of ladder mids
//    onto the monotone set (a consistent CDF to compare each strike against).
//  - scanLadder: monotonicity breaches, and executable ladder arbitrage: buying
//    YES(>= K1) and NO(>= K2) with K1 < K2 pays at least $1 in every outcome
//    ($2 between the strikes), so ask(K1) + (1 - bid(K2)) + taker fees < $1 is
//    riskless. Bracket-vs-ladder deviations are reported where strikes align.
// Report-only: nothing here places orders. Ladder features feed the model.

import type { OrderBook } from '../marketdata/orderBook';
import { takerFee, type FeeSchedule, DEFAULT_FEES } from '../fees';

export interface LadderMarket { ticker: string; asset: string; closeTime: number; kind: string; strike?: number; cap?: number }
export interface LadderQuote { ticker: string; kind: string; strike?: number; cap?: number; bid?: number; ask?: number; mid?: number; bidSize?: number; askSize?: number }

/** Quotes for every contract settling at the same time on the same asset. */
export function ladderQuotes(markets: Iterable<LadderMarket>, bookOf: (ticker: string) => OrderBook | undefined, asset: string, closeTime: number): LadderQuote[] {
  const out: LadderQuote[] = [];
  for (const m of markets) {
    if (m.asset !== asset || m.closeTime !== closeTime || m.kind === 'updown') continue;
    const b = bookOf(m.ticker);
    const bid = b?.bestBid(), ask = b?.bestAsk();
    out.push({ ticker: m.ticker, kind: m.kind, strike: m.strike, cap: m.cap, bid: bid?.price, ask: ask?.price, bidSize: bid?.size, askSize: ask?.size, mid: bid && ask ? (bid.price + ask.price) / 2 : undefined });
  }
  return out;
}

/** Pool-adjacent-violators: the closest (weighted L2) non-increasing sequence. */
export function isotonicNonIncreasing(y: number[], w: number[] = y.map(() => 1)): number[] {
  const blocks: Array<{ v: number; w: number; n: number }> = [];
  for (let i = 0; i < y.length; i++) {
    blocks.push({ v: y[i], w: w[i], n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].v < blocks[blocks.length - 1].v) {
      const b = blocks.pop()!, a = blocks.pop()!;
      blocks.push({ v: (a.v * a.w + b.v * b.w) / (a.w + b.w), w: a.w + b.w, n: a.n + b.n });
    }
  }
  return blocks.flatMap((b) => Array(b.n).fill(b.v));
}

export interface LadderArb { buyYes: string; buyNo: string; cost: number; profitPerContract: number; size: number }
export interface LadderScan {
  strikes: Array<{ ticker: string; strike: number; mid: number; projected: number; violationC: number }>;
  arbitrage: LadderArb[];
  bracketDeviations: Array<{ ticker: string; floor: number; cap: number; bracketMid: number; impliedByLadder: number; devC: number }>;
  bracketSumDevC: number | null;
}

export function scanLadder(quotes: LadderQuote[], fees: FeeSchedule = DEFAULT_FEES): LadderScan {
  const ladder = quotes.filter((q) => q.kind === 'greater' && q.strike !== undefined && q.mid !== undefined).sort((a, b) => a.strike! - b.strike!);
  const mids = ladder.map((q) => q.mid!);
  const proj = isotonicNonIncreasing(mids);
  const strikes = ladder.map((q, i) => ({ ticker: q.ticker, strike: q.strike!, mid: q.mid!, projected: proj[i], violationC: violationAt(mids, i) * 100 }));
  const arbitrage: LadderArb[] = [];
  for (let i = 0; i < ladder.length; i++) {
    for (let j = i + 1; j < ladder.length; j++) {
      const lo = ladder[i], hi = ladder[j];
      if (lo.ask === undefined || hi.bid === undefined) continue;
      const size = Math.min(lo.askSize ?? 0, hi.bidSize ?? 0);
      if (!(size > 0)) continue;
      const n = Math.max(1, Math.floor(size));
      const cost = lo.ask + (1 - hi.bid) + (takerFee(n, lo.ask, fees) + takerFee(n, 1 - hi.bid, fees)) / n;
      if (cost < 1 - 1e-9) arbitrage.push({ buyYes: lo.ticker, buyNo: hi.ticker, cost, profitPerContract: 1 - cost, size });
    }
  }
  const at = new Map(ladder.map((q) => [q.strike!, q.mid!]));
  const brackets = quotes.filter((q) => q.kind === 'between' && q.strike !== undefined && q.cap !== undefined && q.mid !== undefined);
  const bracketDeviations = brackets.filter((q) => at.has(q.strike!) && at.has(q.cap!)).map((q) => {
    const implied = at.get(q.strike!)! - at.get(q.cap!)!;
    return { ticker: q.ticker, floor: q.strike!, cap: q.cap!, bracketMid: q.mid!, impliedByLadder: implied, devC: (q.mid! - implied) * 100 };
  });
  const bracketSumDevC = brackets.length >= 3 ? (brackets.reduce((s, q) => s + q.mid!, 0) - 1) * 100 : null;
  return { strikes, arbitrage: arbitrage.sort((a, b) => b.profitPerContract - a.profitPerContract), bracketDeviations, bracketSumDevC };
}

/** Largest monotonicity breach touching strike i (dollars): a higher strike priced above it, or a lower one below it. */
export function violationAt(mids: number[], i: number): number {
  let v = 0;
  for (let j = 0; j < mids.length; j++) {
    if (j < i) v = Math.max(v, mids[i] - mids[j]);
    if (j > i) v = Math.max(v, mids[j] - mids[i]);
  }
  return v;
}

/** This strike's mid minus the linear interpolation of its two neighbours' mids (by strike). */
export function neighborGap(quotes: LadderQuote[], ticker: string): number | undefined {
  const l = quotes.filter((q) => q.kind === 'greater' && q.strike !== undefined && q.mid !== undefined).sort((a, b) => a.strike! - b.strike!);
  const i = l.findIndex((q) => q.ticker === ticker);
  if (i <= 0 || i >= l.length - 1) return undefined;
  const a = l[i - 1], b = l[i + 1], x = l[i];
  const t = (x.strike! - a.strike!) / (b.strike! - a.strike!);
  return x.mid! - (a.mid! + t * (b.mid! - a.mid!));
}

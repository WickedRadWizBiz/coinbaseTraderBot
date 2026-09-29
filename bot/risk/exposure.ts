// Worst-case exposure accounting, including resting orders.
//
// For one market, PnL is linear in how much of each resting order fills, so
// the worst case over all partial-fill combinations and both settlement
// outcomes is found at the corners: {no fills, all bids, all asks, both} ×
// {YES, NO}. Correlated crypto markets that close together are summed
// without netting (BTC and ETH can settle opposite ways), which is stricter
// than netting them into a single "crypto up" number.

import { orderFee, type FeeSchedule } from '../fees';
import type { BookSide } from '../kalshi/types';
import type { MarketPosition } from '../oms/positions';

export interface RestingLike {
  ticker: string;
  side: BookSide;
  price: number;
  remaining: number;
  isTaker: boolean;
}

export function marketWorstLoss(
  pos: Pick<MarketPosition, 'yes' | 'netCash' | 'fees'> | undefined,
  resting: RestingLike[],
  fees: FeeSchedule,
): number {
  const base = { yes: pos?.yes ?? 0, cash: pos?.netCash ?? 0, fees: pos?.fees ?? 0 };
  const agg = (side: BookSide) => {
    let yes = 0, cash = 0, fee = 0;
    for (const r of resting) {
      if (r.side !== side || r.remaining <= 0) continue;
      const signed = side === 'bid' ? r.remaining : -r.remaining;
      yes += signed;
      cash -= signed * r.price;
      fee += orderFee(r.remaining, side === 'bid' ? r.price : 1 - r.price, r.isTaker, fees);
    }
    return { yes, cash, fee };
  };
  const b = agg('bid');
  const a = agg('ask');
  let worst = Infinity;
  for (const useB of [false, true]) {
    for (const useA of [false, true]) {
      const yes = base.yes + (useB ? b.yes : 0) + (useA ? a.yes : 0);
      const cash = base.cash + (useB ? b.cash : 0) + (useA ? a.cash : 0);
      const fee = base.fees + (useB ? b.fee : 0) + (useA ? a.fee : 0);
      worst = Math.min(worst, cash + yes - fee, cash - fee);
    }
  }
  return Math.max(0, -worst);
}

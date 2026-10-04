// Pre-trade risk gateway (SEC 15c3-5 / FIA style). Every order passes
// `check()` before the OMS sees it. The gateway FAILS CLOSED: missing data,
// an unknown bankroll, a stale book, or an exception inside a check all reject.
// There is no override flag.

import { onGrid, type PriceBand } from '../kalshi/priceGrid';
import type { RiskLimits, TradingMode } from '../config';
import { orderFee, type FeeSchedule } from '../fees';
import type { OrderIntent } from '../oms/oms';
import { EPS } from '../util/num';

export interface RiskContext {
  now: number;
  mode: TradingMode;
  killEngaged: boolean;
  /** Non-empty when new risk is halted (recon break, stale data, startup). */
  haltReasons: string[];
  /** Bankroll-tier limits that replace the configured fractions (sizing tiers). */
  limitOverrides?: Partial<RiskLimits>;
  /** Rules-based strategies without a model fair value (tennis): skip the fee-net edge collar only. */
  skipEdgeCollar?: boolean;
  /** Bankroll used for fractional limits; undefined = unknown = reject. */
  bankroll: number | undefined;
  /** Today's PnL, realized + mark-to-market, net of fees. */
  dailyPnl: number;
  bookUsable: boolean;
  bestBid?: number;
  bestAsk?: number;
  indexFresh: boolean;
  marketCloseTs: number;
  tickSize: number;
  /** The market's price bands (price_ranges); the tick size alone when absent. */
  priceRanges?: PriceBand[];
  fees: FeeSchedule;
  /** Signed YES position in this market. */
  position: number;
  /** Worst-case loss in this market now, and if the intent were added. */
  marketRiskNow: number;
  marketRiskWith: number;
  /** Worst-case loss across all markets in the same close window, now. */
  windowRisk: number;
  /** Worst-case loss across all markets, now. */
  totalRisk: number;
  ordersLastMinute: number;
  openOrders: number;
  modelLiveBlockers: string[];
}

export interface RiskDecision {
  ok: boolean;
  reasons: string[];
  /** Set when the check itself says the kill switch must trip. */
  tripKill?: string;
}

const MAX_DISTANCE_FROM_TOUCH = 0.25;

export class RiskGateway {
  constructor(private readonly limits: RiskLimits) {}

  check(intent: OrderIntent, ctx: RiskContext): RiskDecision {
    try {
      return this.evaluate(intent, ctx);
    } catch (e) {
      return { ok: false, reasons: [`risk check error: ${(e as Error).message}`] };
    }
  }

  dailyLossLimit(bankroll: number | undefined, overrides?: Partial<RiskLimits>): number {
    const L = { ...this.limits, ...overrides };
    const frac = bankroll !== undefined && bankroll > 0 ? bankroll * L.dailyLossLimitFrac : 0;
    return Math.min(frac || Infinity, L.dailyLossLimitUsd);
  }

  private evaluate(i: OrderIntent, c: RiskContext): RiskDecision {
    const L = { ...this.limits, ...c.limitOverrides };
    const r: string[] = [];
    const reduces = i.reduceOnly;

    if (c.killEngaged) return { ok: false, reasons: ['kill switch engaged'] };
    if (c.mode === 'live' && c.modelLiveBlockers.length) r.push(`model not validated for live: ${c.modelLiveBlockers.join('; ')}`);

    // Order sanity.
    if (!(i.price > 0 && i.price < 1)) r.push(`price ${i.price} outside (0,1)`);
    if (!onGrid(i.price, c.priceRanges, c.tickSize)) r.push(`price ${i.price} off the market's price grid (tick ${c.priceRanges ? 'per band' : c.tickSize})`);
    if (!(i.count > 0)) r.push(`count ${i.count} must be > 0`);
    if (i.count > L.maxContractsPerOrder + EPS) r.push(`count ${i.count} > max ${L.maxContractsPerOrder}`);
    if (Math.abs(i.count * 100 - Math.round(i.count * 100)) > 1e-6) r.push(`count ${i.count} finer than 0.01`);
    if (i.reduceOnly && i.timeInForce !== 'immediate_or_cancel') r.push('reduce_only requires immediate_or_cancel');
    if (!Number.isFinite(i.fairValue) || i.fairValue <= 0 || i.fairValue >= 1) r.push('missing fair value');

    // Throttles.
    if (c.ordersLastMinute >= L.maxOrdersPerMinute) r.push(`order rate ${c.ordersLastMinute}/min at limit`);
    if (!reduces && c.openOrders >= L.maxOpenOrders) r.push(`open orders ${c.openOrders} at limit`);

    // Market data must be live; never trade on invented or stale prices.
    if (!c.bookUsable) r.push('order book stale, crossed, or not snapshotted');
    if (!c.indexFresh && !reduces) r.push('settlement index stale');

    // Price collar vs the touch (erroneous-order prevention).
    if (c.bestBid !== undefined && c.bestAsk !== undefined) {
      const ref = i.side === 'bid' ? c.bestAsk : c.bestBid;
      if (Math.abs(i.price - ref) > MAX_DISTANCE_FROM_TOUCH) r.push(`price ${i.price} more than ${MAX_DISTANCE_FROM_TOUCH} from touch ${ref}`);
      if (i.postOnly && i.side === 'bid' && i.price >= c.bestAsk - EPS) r.push('post-only bid would cross');
      if (i.postOnly && i.side === 'ask' && i.price <= c.bestBid + EPS) r.push('post-only ask would cross');
    } else if (!reduces) {
      r.push('one-sided or empty book');
    }

    if (reduces) {
      // Exits must actually reduce the position.
      const wantSign = i.side === 'ask' ? 1 : -1;
      if (Math.sign(c.position) !== wantSign || i.count > Math.abs(c.position) + EPS) {
        r.push(`reduce-only ${i.side} ${i.count} does not reduce position ${c.position}`);
      }
      return { ok: r.length === 0, reasons: r };
    }

    // ---- Risk-increasing orders only below this line. ----
    if (c.haltReasons.length) r.push(`new risk halted: ${c.haltReasons.join('; ')}`);
    if (c.bankroll === undefined || !(c.bankroll > 0)) {
      r.push('bankroll unknown');
      return { ok: false, reasons: r };
    }
    const secsToClose = (c.marketCloseTs - c.now) / 1000;
    if (secsToClose < L.noEntryBeforeCloseSec) r.push(`${secsToClose.toFixed(0)}s to close < ${L.noEntryBeforeCloseSec}s`);

    // Favourite-longshot guard: never buy the cheap side. A resting order that only reduces the
    // current position (e.g. a take-profit selling a winning YES at 95c) buys nothing new.
    const sideCost = i.side === 'bid' ? i.price : 1 - i.price;
    const onlyReduces = (i.side === 'ask' ? c.position > 0 : c.position < 0) && i.count <= Math.abs(c.position) + EPS;
    if (!onlyReduces && sideCost < L.minSidePrice - EPS) r.push(`side price ${sideCost.toFixed(2)} below ${L.minSidePrice} (longshot)`);
    if (!onlyReduces && sideCost > 1 - L.minSidePrice + EPS) r.push(`side price ${sideCost.toFixed(2)} above ${1 - L.minSidePrice}`);

    // Fair-value collar: the order must carry positive edge net of fees.
    const isTaker = !i.postOnly;
    const feePer = orderFee(i.count, sideCost, isTaker, c.fees) / i.count;
    const q = i.side === 'bid' ? i.fairValue : 1 - i.fairValue;
    if (!c.skipEdgeCollar && !(q - sideCost - feePer > 0)) r.push(`no fee-net edge: q=${q.toFixed(4)} cost=${sideCost} fee=${feePer.toFixed(4)}`);

    // Capital thresholds.
    const bank = c.bankroll;
    const addRisk = Math.max(0, c.marketRiskWith - c.marketRiskNow);
    const orderRisk = i.count * (sideCost + feePer);
    if (orderRisk > L.maxOrderRiskFrac * bank + EPS) r.push(`order risk $${orderRisk.toFixed(2)} > ${(L.maxOrderRiskFrac * 100).toFixed(1)}% of $${bank.toFixed(2)}`);
    if (c.windowRisk + addRisk > L.maxWindowRiskFrac * bank + EPS) r.push(`window risk $${(c.windowRisk + addRisk).toFixed(2)} > ${(L.maxWindowRiskFrac * 100).toFixed(1)}% cap`);
    if (c.totalRisk + addRisk > L.maxTotalRiskFrac * bank + EPS) r.push(`total risk $${(c.totalRisk + addRisk).toFixed(2)} > ${(L.maxTotalRiskFrac * 100).toFixed(1)}% cap`);

    // Daily loss limit trips the kill switch.
    const limit = this.dailyLossLimit(bank, c.limitOverrides);
    if (c.dailyPnl <= -limit) {
      r.push(`daily loss $${(-c.dailyPnl).toFixed(2)} at limit $${limit.toFixed(2)}`);
      return { ok: false, reasons: r, tripKill: `daily loss limit $${limit.toFixed(2)} reached` };
    }
    return { ok: r.length === 0, reasons: r };
  }
}

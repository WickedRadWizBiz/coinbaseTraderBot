// Trade management for setup trades, bar by bar (research backtest and live bot alike).
//
// Order of checks inside a bar (conservative: an intrabar sequence we cannot see is resolved against us):
//   1. stop (a gap through it exits at the bar's open)
//   2. first target: half off at the target (maker), stop moved to break-even
//   3. final target: the rest off at the target (maker)
// At the close of a bar of the trade's own timeframe: the trailing stop follows the best close by
// trailAtr ATRs (fast lane after the first target, slow lane from the start; it only ever tightens),
// and the time stop exits at the close after maxBars.
// Costs: the entry fee + slippage, maker fees on target exits, taker fees + slippage on stops / time
// exits, and perp funding while the position is open.

import type { Candle } from '../ta/indicators';
import { TF_MS, type ExitPlan, type Lane, type SetupKind } from './detectors';
import type { Timeframe } from '../ta/knowledge';

export interface CostModel {
  /** Entry cost per unit notional (taker fee + slippage), e.g. 0.0014. */
  entry: number;
  /** Exit at a resting target (maker fee). */
  makerExit: number;
  /** Exit by stop / time / manual (taker fee + slippage). */
  takerExit: number;
  /** Funding per 8 hours held (charged regardless of side: conservative). */
  fundingPer8h: number;
}

export const DEFAULT_COSTS: CostModel = { entry: 0.0014, makerExit: 0.0005, takerExit: 0.0014, fundingPer8h: 0.0001 };

export type ExitReason = 'stop' | 'breakeven' | 'trail' | 'target' | 'time' | 'manual';

export interface OpenTrade {
  asset: string;
  lane: Lane;
  kind: SetupKind;
  tf: Timeframe;
  dir: 1 | -1;
  entry: number;
  entryTs: number;
  /** Stop at entry (defines 1R). */
  initialStop: number;
  stop: number;
  plan: ExitPlan;
  /** Remaining share of the position (1, then 0.5 after the first target). */
  frac: number;
  partialDone: boolean;
  /** Best close since entry (in the trade's direction). */
  best: number;
  bars: number;
  /** Closed parts: sum of share x return, and costs (fractions of the full notional). */
  realized: number;
  costs: number;
  closed?: { ts: number; px: number; reason: ExitReason };
  /** Model score at entry and the size (fraction of equity at risk / notional), for the record. */
  score?: number;
  notional?: number;
}

/** Open a trade at `px` (next bar's open in research, the market live). Undefined when the price has
 *  already run through the stop or the first target (the setup is gone). */
export function openTrade(s: { asset: string; lane: Lane; kind: SetupKind; tf: Timeframe; dir: 1 | -1; stop: number; plan: ExitPlan; atr: number }, px: number, ts: number, costs: CostModel = DEFAULT_COSTS): OpenTrade | undefined {
  const d = s.dir;
  if (!(px > 0) || !(d * (px - s.stop) > 0.1 * s.atr)) return undefined;
  if (s.plan.target1 !== undefined && !(d * (s.plan.target1 - px) > 0)) return undefined;
  if (s.plan.target2 !== undefined && !(d * (s.plan.target2 - px) > 0)) return undefined;
  return {
    asset: s.asset, lane: s.lane, kind: s.kind, tf: s.tf, dir: d, entry: px, entryTs: ts, initialStop: s.stop, stop: s.stop, plan: { ...s.plan },
    frac: 1, partialDone: false, best: px, bars: 0, realized: 0, costs: costs.entry,
  };
}

const ret = (t: OpenTrade, px: number) => (t.dir * (px - t.entry)) / t.entry;

function close(t: OpenTrade, px: number, ts: number, reason: ExitReason, cost: number): void {
  t.realized += t.frac * ret(t, px);
  t.costs += t.frac * cost;
  t.frac = 0;
  t.closed = { ts, px, reason };
}

/**
 * Advance a trade through one bar (any timeframe at or below the trade's own). `tfClose`: this bar
 * completes a bar of the trade's timeframe (trail / time stop update), with that timeframe's ATR and
 * close. Returns true when the trade is now closed.
 */
export function stepTrade(t: OpenTrade, bar: Candle, barMs: number, costs: CostModel = DEFAULT_COSTS, tfClose?: { close: number; atr: number }): boolean {
  if (t.closed) return true;
  const d = t.dir;
  t.costs += t.frac * costs.fundingPer8h * (barMs / 28_800_000);
  const stopHit = d > 0 ? bar.l <= t.stop : bar.h >= t.stop;
  if (stopHit) {
    const px = d > 0 ? Math.min(t.stop, bar.o) : Math.max(t.stop, bar.o);
    const reason: ExitReason = t.stop === t.initialStop ? 'stop' : t.partialDone && Math.abs(t.stop - t.entry) < 1e-12 ? 'breakeven' : 'trail';
    close(t, px, bar.ts + barMs, reason, costs.takerExit);
    return true;
  }
  const p = t.plan;
  if (!t.partialDone && p.target1 !== undefined && (d > 0 ? bar.h >= p.target1 : bar.l <= p.target1)) {
    const px = d > 0 ? Math.max(p.target1, bar.o) : Math.min(p.target1, bar.o);
    t.realized += 0.5 * ret(t, px);
    t.costs += 0.5 * costs.makerExit;
    t.frac = 0.5;
    t.partialDone = true;
    t.stop = d > 0 ? Math.max(t.stop, t.entry) : Math.min(t.stop, t.entry);
  }
  if (p.target2 !== undefined && (d > 0 ? bar.h >= p.target2 : bar.l <= p.target2)) {
    close(t, d > 0 ? Math.max(p.target2, bar.o) : Math.min(p.target2, bar.o), bar.ts + barMs, 'target', costs.makerExit);
    return true;
  }
  // Hard age limit: the time stop also fires on elapsed time (missing candles cannot keep a trade open).
  if (bar.ts + barMs - t.entryTs > (p.maxBars + 2) * (TF_MS[t.tf] ?? 0)) { close(t, bar.c, bar.ts + barMs, 'time', costs.takerExit); return true; }
  if (tfClose) {
    t.bars++;
    if (d * (tfClose.close - t.best) > 0) t.best = tfClose.close;
    if ((t.lane === 'slow' || t.partialDone || p.trailFromStart) && tfClose.atr > 0) {
      const trail = t.best - d * p.trailAtr * tfClose.atr;
      if (d * (trail - t.stop) > 0) t.stop = trail;
    }
    if (t.bars >= p.maxBars) { close(t, tfClose.close, bar.ts + barMs, 'time', costs.takerExit); return true; }
  }
  return false;
}

/** Net result of a closed (or marked-to-market) trade: return on notional and in R. */
export function tradeResult(t: OpenTrade, markPx?: number): { ret: number; r: number } {
  const open = t.closed ? 0 : t.frac * ret(t, markPx ?? t.entry);
  const net = t.realized + open - t.costs;
  const risk = Math.abs(t.entry - t.initialStop) / t.entry;
  return { ret: net, r: risk > 0 ? net / risk : 0 };
}

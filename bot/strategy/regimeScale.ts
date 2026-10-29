// Regime scale: the order size moved with what the market is doing now (phase 5 of the dynamic-scaling plan, Oct 29).
// One function for the engine and the backtester; it multiplies the loss-aware risk scale, so it shrinks every sizing
// route (Kelly, target EV and the per-order caps) the way that scale does.
//
//   vol      (rv6h / rv15m)^w: volatility targeting (Moreira & Muir, 2017): smaller when the last 15 minutes run hotter
//            than the last 6 hours, larger when calmer
//   change   1 - k x P(change point in the last 5 minutes): de-risk right after the return process changed, while the
//            model's history fits it least
//   corr     1 / (1 + k x max(0, correlation) x other coins held): positions on coins that move together are one bet
//
// The product stays within [REGIME_SCALE_MIN, REGIME_SCALE_MAX] (max 1 by default: it only shrinks). Every weight is 0
// by default, so nothing changes until the sweep (research/randomSweep.ts) accepts settings that earn more. A reading
// the market state does not have yet leaves its part at 1.
import type { MarketStateReading } from '../marketdata/marketState';

export interface RegimeScaleParams {
  volTarget: number;
  changeDerisk: number;
  corrDerisk: number;
  min: number;
  max: number;
}

export const REGIME_SCALE_OFF: RegimeScaleParams = { volTarget: 0, changeDerisk: 0, corrDerisk: 0, min: 0.25, max: 1 };

export interface RegimeScale {
  mult: number;
  parts: { vol: number; change: number; corr: number };
}

const ok = (x: number | null | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x);

export function regimeScale(p: RegimeScaleParams, r: MarketStateReading | undefined, otherCoinsHeld: number): RegimeScale {
  const parts = {
    vol: p.volTarget && ok(r?.rv6h) && ok(r?.rv15m) && r!.rv6h! > 0 && r!.rv15m! > 0 ? (r!.rv6h! / r!.rv15m!) ** p.volTarget : 1,
    change: p.changeDerisk && ok(r?.changeProb) ? Math.max(0, 1 - p.changeDerisk * r!.changeProb!) : 1,
    corr: p.corrDerisk && ok(r?.correlation) ? 1 / (1 + p.corrDerisk * Math.max(0, r!.correlation!) * Math.max(0, otherCoinsHeld)) : 1,
  };
  const raw = parts.vol * parts.change * parts.corr;
  return { mult: raw === 1 ? 1 : Math.max(p.min, Math.min(p.max, raw)), parts };
}

export const regimeScaleOn = (p: RegimeScaleParams) => p.volTarget !== 0 || p.changeDerisk !== 0 || p.corrDerisk !== 0;

/** How many coins other than `asset` the bot holds an open position on. */
export function otherCoinsHeld(open: Array<{ ticker: string; asset?: string }>, asset: string, assetOf: (ticker: string) => string | undefined): number {
  const coins = new Set<string>();
  for (const m of open) {
    const a = m.asset ?? assetOf(m.ticker);
    if (a && a !== asset) coins.add(a);
  }
  return coins.size;
}

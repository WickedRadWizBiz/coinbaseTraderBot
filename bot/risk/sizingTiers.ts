// Bankroll-scaled risk tiers: a small account is treated as expendable
// "tuition" and sized aggressively; as it grows, sizing tapers to the normal
// institutional limits.
//
//   $20  aggressive  10% per order, 20% daily stop, 3/4 Kelly
//   $50  moderate     5% per order, 10% daily stop, 1/2 Kelly
//   $100 normal      the configured limits (2%, 3%, 1/4 Kelly)
//
// Between points every parameter is interpolated linearly in log(bankroll),
// so there is no jump at a boundary. Below the first point the first tier
// applies; above the last, the last.
//
// The tier is chosen from the account's HIGH-WATER MARK of tradable bankroll,
// not its current value: once an account has grown into "normal" it stays
// there, and losses never re-escalate risk. Drawdowns still cut size through
// the drawdown brake, whose threshold (ddScaleAt) is itself per tier so one
// aggressive-tier loss doesn't cancel the aggressive tier. Withdrawals and
// deposits shift the high-water mark (see EquityGuard.onCashFlow).
//
// Tiers can only be as risky as their validated bounds (parseSizingTiers).

import type { Config } from '../config';

export interface TierPoint {
  bankroll: number;
  name: string;
  /** Per-order, same-close window, and total risk as fractions of bankroll. */
  orderFrac: number;
  windowFrac: number;
  totalFrac: number;
  /** Daily loss (realized + mark) that trips the kill switch, as a fraction of bankroll. */
  dailyLossFrac: number;
  kellyFraction: number;
  /** Drawdown at which the Kelly brake reaches zero. */
  ddScaleAt: number;
  /** 7-day loss that pauses new risk for 24 h. */
  weeklyLossPause: number;
}

export interface Tier extends Omit<TierPoint, 'bankroll'> {
  /** High-water mark the tier was read from. */
  reference: number;
}

export const AGGRESSIVE: Omit<TierPoint, 'bankroll'> = { name: 'aggressive', orderFrac: 0.10, windowFrac: 0.10, totalFrac: 0.30, dailyLossFrac: 0.20, kellyFraction: 0.75, ddScaleAt: 0.60, weeklyLossPause: 0.50 };
export const MODERATE: Omit<TierPoint, 'bankroll'> = { name: 'moderate', orderFrac: 0.05, windowFrac: 0.05, totalFrac: 0.20, dailyLossFrac: 0.10, kellyFraction: 0.50, ddScaleAt: 0.35, weeklyLossPause: 0.25 };

/** Default ladder; "normal" is whatever the configured base limits are. */
export function defaultTiers(cfg: Pick<Config, 'risk' | 'strategy'>): TierPoint[] {
  const normal: TierPoint = {
    bankroll: 100, name: 'normal',
    orderFrac: cfg.risk.maxOrderRiskFrac, windowFrac: cfg.risk.maxWindowRiskFrac, totalFrac: cfg.risk.maxTotalRiskFrac,
    dailyLossFrac: cfg.risk.dailyLossLimitFrac, kellyFraction: cfg.strategy.kellyFraction,
    ddScaleAt: cfg.strategy.ddScaleAt, weeklyLossPause: cfg.strategy.weeklyLossPause,
  };
  return [{ bankroll: 20, ...AGGRESSIVE }, { bankroll: 50, ...MODERATE }, normal];
}

const BOUNDS: Record<Exclude<keyof TierPoint, 'bankroll' | 'name'>, [number, number]> = {
  orderFrac: [0.001, 0.25], windowFrac: [0.001, 0.4], totalFrac: [0.001, 0.6], dailyLossFrac: [0.001, 0.4],
  kellyFraction: [0.01, 1], ddScaleAt: [0.01, 1], weeklyLossPause: [0.01, 1],
};

/** Validate a tier ladder (from SIZING_TIERS JSON or the defaults). */
export function validateTiers(t: TierPoint[]): TierPoint[] {
  if (!Array.isArray(t) || !t.length) throw new Error('sizing tiers must be a non-empty array');
  for (const [i, p] of t.entries()) {
    if (!(p.bankroll > 0)) throw new Error(`tier ${i}: bankroll must be > 0`);
    if (i > 0 && !(p.bankroll > t[i - 1].bankroll)) throw new Error('tier bankrolls must increase');
    for (const [k, [lo, hi]] of Object.entries(BOUNDS)) {
      const v = (p as unknown as Record<string, number>)[k];
      if (!(Number.isFinite(v) && v >= lo && v <= hi)) throw new Error(`tier ${i} (${p.name}): ${k}=${v} outside [${lo}, ${hi}]`);
    }
    if (p.orderFrac > p.windowFrac || p.windowFrac > p.totalFrac) throw new Error(`tier ${i} (${p.name}): need orderFrac <= windowFrac <= totalFrac`);
  }
  return t;
}

/** Interpolate the ladder at a high-water mark (linear in log bankroll). */
export function tierAt(tiers: TierPoint[], reference: number): Tier {
  const ref = Math.max(0, reference);
  const first = tiers[0], last = tiers[tiers.length - 1];
  const strip = ({ bankroll: _b, ...rest }: TierPoint): Omit<TierPoint, 'bankroll'> => rest;
  if (ref <= first.bankroll) return { ...strip(first), reference: ref };
  if (ref >= last.bankroll) return { ...strip(last), reference: ref };
  const i = tiers.findIndex((p) => p.bankroll >= ref);
  const a = tiers[i - 1], b = tiers[i];
  const w = (Math.log(ref) - Math.log(a.bankroll)) / (Math.log(b.bankroll) - Math.log(a.bankroll));
  const lerp = (k: keyof typeof BOUNDS) => a[k] + w * (b[k] - a[k]);
  return {
    name: w < 0.5 ? a.name : b.name,
    orderFrac: lerp('orderFrac'), windowFrac: lerp('windowFrac'), totalFrac: lerp('totalFrac'), dailyLossFrac: lerp('dailyLossFrac'),
    kellyFraction: lerp('kellyFraction'), ddScaleAt: lerp('ddScaleAt'), weeklyLossPause: lerp('weeklyLossPause'),
    reference: ref,
  };
}

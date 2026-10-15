// Liquidation must sit beyond the stop. A perp position under cross margin is liquidated when the account's
// equity, after the position's loss, falls to its maintenance margin. If the stop is the planned exit, the
// liquidation price has to be farther away than the stop, with room to spare (slippage through the stop,
// funding, other positions moving at the same time); otherwise the exchange closes the position at a worse
// price than the stop before the stop can fire.
//
// For one new position of notional N with stop distance s (fraction of price), maintenance rate m, and
// equity A left after reserving the other open positions (their loss at their own stops plus their
// maintenance margin), liquidation comes after a move of
//     L = A / N - m
// Requiring the stop to use at most (1 - buffer) of that room, (s + m) <= (1 - buffer) (A / N), gives
//     N <= (1 - buffer) A / (s + m)          (leverage cap (1 - buffer) / (s + m))
// so the liquidation distance is at least s / (1 - buffer) + buffer m / (1 - buffer): 25% beyond the stop
// with the default buffer of 0.2.

/** Maintenance margin rate of a perp market: the configured one, else half the initial margin implied by the
 *  exchange's leverage estimate (the usual maintenance / initial ratio), else 5%. */
export function maintenanceRate(maxLeverage?: number, override?: number): number {
  if (override !== undefined && override > 0) return override;
  return maxLeverage && maxLeverage > 0 ? 0.5 / maxLeverage : 0.05;
}

/** What an open position ties up against a new one: its loss if it ran to its stop (0 once the stop locks a
 *  profit) plus its maintenance margin. */
export function reservedFor(p: { notional: number; entry: number; stop: number; dir: 1 | -1; mmr: number }): number {
  if (!(p.notional > 0) || !(p.entry > 0)) return 0;
  const lossAtStop = Math.max(0, p.dir * (p.entry - p.stop)) / p.entry;
  return p.notional * (lossAtStop + p.mmr);
}

/** Largest notional (USD) whose liquidation sits beyond a stop `stopFrac` away (fraction of price), with
 *  `reserved` of the equity tied up by the other positions. 0 when nothing is left. */
export function maxSafeNotional(o: { equity: number; reserved?: number; stopFrac: number; mmr: number; buffer: number }): number {
  const avail = o.equity - (o.reserved ?? 0);
  if (!(avail > 0) || !(o.stopFrac > 0)) return 0;
  return ((1 - Math.min(0.9, Math.max(0, o.buffer))) * avail) / (o.stopFrac + o.mmr);
}

/** Leverage cap (notional / equity) for a single position: the same rule with nothing reserved. */
export const liquidationLeverageCap = (stopFrac: number, mmr: number, buffer: number): number => maxSafeNotional({ equity: 1, stopFrac, mmr, buffer });

/** True when the exchange's liquidation estimate is not far enough beyond the stop: the liquidation distance
 *  from the entry must be at least stop distance / (1 - buffer). A position whose stop already locks a profit
 *  is judged from the stop itself (the liquidation must still lie beyond it). */
export function liquidationInsideStop(o: { dir: 1 | -1; entry: number; stop: number; liquidation: number; buffer: number }): boolean {
  if (!(o.liquidation > 0) || !(o.entry > 0)) return false;
  const stopDist = Math.max(0, o.dir * (o.entry - o.stop));
  const liqDist = o.dir * (o.entry - o.liquidation);
  if (stopDist === 0) return o.dir * (o.stop - o.liquidation) <= 0;
  return liqDist < stopDist / (1 - Math.min(0.9, Math.max(0, o.buffer)));
}

/** Share of the position to keep so the liquidation moves out to the required distance (liquidation distance
 *  grows as A / N: cutting N by k moves it to (L + m) / k - m). 1 = no change needed. */
export function safeShare(o: { dir: 1 | -1; entry: number; stop: number; liquidation: number; mmr: number; buffer: number }): number {
  if (!liquidationInsideStop(o)) return 1;
  const L = Math.max(0, o.dir * (o.entry - o.liquidation)) / o.entry;
  const need = Math.max(0, o.dir * (o.entry - o.stop)) / o.entry / (1 - Math.min(0.9, Math.max(0, o.buffer)));
  if (!(need > 0)) return 0.5; // a stop locking a profit with the liquidation inside it: halve and look again
  return Math.max(0, Math.min(1, (L + o.mmr) / (need + o.mmr)));
}

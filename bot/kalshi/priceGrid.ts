// Per-market price grids (Kalshi "Fixed-Point Representation"): each market's valid prices are the bands
// in `price_ranges` ({ start, end, step } in dollars). Any on-grid price is valid and any off-grid price
// is rejected. Grids taper (finer ticks near $0 and $1) and the named structures change over time, so
// the bands themselves are the source of truth. A market without bands uses its single tick size.

export interface PriceBand { start: number; end: number; step: number }

const E = 1e-9;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

/** Parse `price_ranges` (strings or numbers, dollars); undefined when absent or malformed. */
export function parsePriceRanges(raw: unknown): PriceBand[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const out: PriceBand[] = [];
  for (const b of raw) {
    const start = Number((b as Record<string, unknown>)?.start), end = Number((b as Record<string, unknown>)?.end), step = Number((b as Record<string, unknown>)?.step);
    if (!(Number.isFinite(start) && Number.isFinite(end) && step > 0 && end > start)) return undefined;
    out.push({ start, end, step });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Bands for a market: its own, or a uniform grid at `tick`. */
export const bandsOf = (ranges: PriceBand[] | undefined, tick: number): PriceBand[] => ranges?.length ? ranges : [{ start: 0, end: 1, step: tick > 0 ? tick : 0.01 }];

/** Every valid price within [lo, hi] would be enumerable; instead: is `p` on the grid? Band edges belong
 *  to both neighbouring bands (a price valid in either is valid). */
export function onGrid(p: number, ranges: PriceBand[] | undefined, tick: number): boolean {
  for (const b of bandsOf(ranges, tick)) {
    if (p < b.start - E || p > b.end + E) continue;
    const k = (p - b.start) / b.step;
    if (Math.abs(k - Math.round(k)) < 1e-6) return true;
  }
  return false;
}

/** The nearest valid price at or below `p` (dir -1) or at or above it (dir +1); undefined outside the grid. */
export function snapToGrid(p: number, ranges: PriceBand[] | undefined, tick: number, dir: 1 | -1): number | undefined {
  if (onGrid(p, ranges, tick)) return r4(p);
  let best: number | undefined;
  for (const b of bandsOf(ranges, tick)) {
    const k = (p - b.start) / b.step;
    let q = b.start + (dir < 0 ? Math.floor(k + E) : Math.ceil(k - E)) * b.step;
    q = Math.min(b.end, Math.max(b.start, q));
    if (dir < 0 ? q > p + E : q < p - E) continue;
    if (best === undefined || (dir < 0 ? q > best : q < best)) best = q;
  }
  return best === undefined ? undefined : r4(best);
}

/** Tick at a price (the step of its band; at a band edge, the finer of the two). */
export function tickAt(p: number, ranges: PriceBand[] | undefined, tick: number): number {
  let t = Infinity;
  for (const b of bandsOf(ranges, tick)) if (p >= b.start - E && p <= b.end + E) t = Math.min(t, b.step);
  return Number.isFinite(t) ? t : tick;
}

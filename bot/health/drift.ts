// Drift watch: has a module's score against its benchmark got worse recently, rather than over its whole record?
// Page-Hinkley test (Page, 1954; Hinkley, 1971) on the per-window log-loss difference (module minus benchmark),
// standardized by its own spread: it alarms when the running sum of (x - mean - delta) climbs `lambda` above its lowest
// point, and names the window where the climb began. Phase 5 of the dynamic-scaling plan (Oct 29): the whole-record test
// in modelHealth.ts can take hundreds of windows to see a model that was fine and then broke; this sees the break.

export interface DriftReading {
  alarm: boolean;
  /** Close time of the window the rise started from (null without an alarm). */
  since: number | null;
  /** How far the cumulative sum stands above its minimum, in standard deviations. */
  stat: number;
}

export function pageHinkley(xs: Array<{ ts: number; x: number }>, delta = 0.1, lambda = 8, minN = 30): DriftReading {
  const n = xs.length;
  if (n < minN) return { alarm: false, since: null, stat: 0 };
  const mean = xs.reduce((s, v) => s + v.x, 0) / n;
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v.x - mean) ** 2, 0) / Math.max(1, n - 1));
  if (!(sd > 0)) return { alarm: false, since: null, stat: 0 };
  let m = 0, min = 0, minAt = -1, run = 0;
  // A running mean (not the whole-sample one) so a late rise is not hidden by the mean it raises.
  for (let i = 0; i < n; i++) {
    run += (xs[i].x - run) / (i + 1);
    m += (xs[i].x - run) / sd - delta;
    if (m < min) { min = m; minAt = i; }
  }
  const stat = m - min;
  const alarm = stat > lambda;
  return { alarm, since: alarm ? xs[Math.min(n - 1, minAt + 1)].ts : null, stat: +stat.toFixed(2) };
}

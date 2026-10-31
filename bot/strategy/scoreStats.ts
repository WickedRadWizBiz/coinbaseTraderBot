/** A scoreboard's net and its t statistic (mean over its standard error); t is null below two results. */
export function scoreStats(r: number[]): { sum: number; t: number | null } {
  const n = r.length, sum = r.reduce((a, v) => a + v, 0);
  if (n < 2) return { sum, t: null };
  const m = sum / n, sd = Math.sqrt(r.reduce((a, v) => a + (v - m) ** 2, 0) / (n - 1));
  return { sum, t: sd > 0 ? m / (sd / Math.sqrt(n)) : m < 0 ? -Infinity : m > 0 ? Infinity : 0 };
}

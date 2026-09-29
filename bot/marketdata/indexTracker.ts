// Tracks the settlement index (CF Benchmarks RTI) per asset: a time-ordered
// buffer of prints, trailing-window averages (settlement uses a 60 s simple
// average), and an EWMA realized-volatility estimate from 1 s log returns.
//
// Stale or insufficient data returns undefined. Nothing here invents a price.

export interface IndexPoint { ts: number; value: number }

export interface VolEstimate {
  /** Volatility of log price per sqrt(second). */
  sigmaPerSqrtSec: number;
  samples: number;
}

export class IndexTracker {
  private readonly points: IndexPoint[] = [];
  private ewmaVar: number | undefined;
  private volSamples = 0;
  private lastSampleSec: number | undefined;
  private lastSampleValue: number | undefined;

  constructor(
    readonly asset: string,
    /** How much history to keep (ms). */
    private readonly retainMs = 20 * 60_000,
    /** EWMA half-life in seconds for the variance estimate. */
    private readonly volHalfLifeSec = 300,
  ) {}

  add(value: number, ts: number): void {
    if (!(value > 0) || !Number.isFinite(value)) return;
    const last = this.points[this.points.length - 1];
    if (last && ts < last.ts) return; // drop out-of-order prints
    this.points.push({ ts, value });
    this.updateVol(value, ts);
    const cutoff = ts - this.retainMs;
    while (this.points.length && this.points[0].ts < cutoff) this.points.shift();
  }

  private updateVol(value: number, ts: number): void {
    const sec = Math.floor(ts / 1000);
    if (this.lastSampleSec === undefined) {
      this.lastSampleSec = sec;
      this.lastSampleValue = value;
      return;
    }
    if (sec <= this.lastSampleSec) return;
    const dt = sec - this.lastSampleSec;
    if (dt > 30) {
      // Large gap: restart the return chain rather than attributing a gap's
      // move to one second.
      this.lastSampleSec = sec;
      this.lastSampleValue = value;
      return;
    }
    const r = Math.log(value / (this.lastSampleValue as number));
    const perSecVar = (r * r) / dt;
    const alpha = 1 - Math.pow(0.5, dt / this.volHalfLifeSec);
    this.ewmaVar = this.ewmaVar === undefined ? perSecVar : (1 - alpha) * this.ewmaVar + alpha * perSecVar;
    this.volSamples += 1;
    this.lastSampleSec = sec;
    this.lastSampleValue = value;
  }

  latest(): IndexPoint | undefined {
    return this.points[this.points.length - 1];
  }

  /** Latest value if it is no older than maxAgeMs. */
  fresh(now: number, maxAgeMs: number): IndexPoint | undefined {
    const p = this.latest();
    return p && now - p.ts <= maxAgeMs ? p : undefined;
  }

  vol(minSamples = 120): VolEstimate | undefined {
    if (this.ewmaVar === undefined || this.volSamples < minSamples) return undefined;
    return { sigmaPerSqrtSec: Math.sqrt(this.ewmaVar), samples: this.volSamples };
  }

  /**
   * Time-weighted average over [from, to] treating the index as a step
   * function (each print holds until the next). Returns undefined unless the
   * window is covered: a print at or before `from` and no hole longer than
   * `maxGapMs` inside the window.
   */
  average(from: number, to: number, maxGapMs = 5000): { avg: number; coveredMs: number } | undefined {
    if (to <= from) return undefined;
    const pts = this.points;
    let i = pts.findIndex((p) => p.ts > from) - 1;
    if (i === -2) i = pts.length - 1; // every point is <= from
    if (i < 0) return undefined; // no print at or before `from`
    let area = 0;
    let t = from;
    let v = pts[i].value;
    if (from - pts[i].ts > maxGapMs) return undefined;
    for (let j = i + 1; j < pts.length && pts[j].ts <= to; j++) {
      if (pts[j].ts - t > maxGapMs) return undefined;
      area += v * (pts[j].ts - t);
      t = pts[j].ts;
      v = pts[j].value;
    }
    if (to - t > maxGapMs) return undefined;
    area += v * (to - t);
    return { avg: area / (to - from), coveredMs: to - from };
  }

  /** Log return over the trailing window, for fast-move detection. */
  trailingLogReturn(now: number, windowMs: number): number | undefined {
    const last = this.latest();
    if (!last) return undefined;
    const start = [...this.points].reverse().find((p) => p.ts <= now - windowMs);
    if (!start) return undefined;
    return Math.log(last.value / start.value);
  }
}

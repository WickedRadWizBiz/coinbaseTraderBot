// Clock-skew guard. Contracts settle on exact seconds (a 60 s average ending at the close) and
// Kalshi rejects signed requests whose timestamp is off, so a drifting local clock means mistimed
// entry windows, wrong "seconds to close", and failing orders.
//
// The exchange time comes from the HTTP `Date` header of every REST response. It only has one-second
// resolution, but each response still bounds the offset: the server's true time T satisfied
//      D <= T < D + 1 s    at some instant between our send and our receive,
// so   offset = T - local  lies in  [D - recvTs, D + 1000 - sendTs].
// Every response gives such an interval and the true offset (which drifts slowly) lies in all
// recent ones, so their intersection narrows the estimate far below one second. If the intervals
// stop overlapping (clock stepping, NTP correction), the newest few are used instead.
//
// New risk halts when the whole interval is beyond the limit (a confident drift, not noise); exits
// stay allowed. A small margin is warned about first.

export interface SkewEstimate {
  /** Server time minus local time, ms (positive: the local clock is behind). */
  offsetMs: number;
  /** Bounds of the estimate, ms. */
  lo: number;
  hi: number;
  samples: number;
  /** When the newest sample arrived. */
  lastTs: number;
}

export class ClockSkewMonitor {
  private readonly samples: Array<{ lo: number; hi: number; ts: number }> = [];

  constructor(
    /** Halt new risk when |offset| is confidently beyond this. */
    readonly maxMs = 2000,
    /** Warn (but keep trading) beyond this. */
    readonly warnMs = 1000,
    /** Samples older than this are dropped (the clock can move). */
    private readonly keepMs = 10 * 60_000,
    /** Without a sample this recent there is no verdict. */
    private readonly staleMs = 15 * 60_000,
  ) {}

  /** One REST response: the Date header as epoch ms, and the local time before sending / after receiving. */
  observe(serverDateMs: number, sentTs: number, recvTs: number): void {
    if (!Number.isFinite(serverDateMs) || !(recvTs >= sentTs)) return;
    this.samples.push({ lo: serverDateMs - recvTs, hi: serverDateMs + 1000 - sentTs, ts: recvTs });
    const cut = recvTs - this.keepMs;
    while (this.samples.length && this.samples[0].ts < cut) this.samples.shift();
    if (this.samples.length > 200) this.samples.shift();
  }

  /** Current offset estimate: the intersection of the recent intervals, else the newest few. */
  estimate(now: number): SkewEstimate | undefined {
    const s = this.samples.filter((x) => x.ts >= now - this.keepMs);
    if (!s.length) return undefined;
    let use = s;
    let lo = Math.max(...use.map((x) => x.lo)), hi = Math.min(...use.map((x) => x.hi));
    if (lo > hi) {
      use = s.slice(-5); // the offset moved: trust only the newest
      lo = Math.max(...use.map((x) => x.lo)); hi = Math.min(...use.map((x) => x.hi));
      if (lo > hi) { const m = use.map((x) => (x.lo + x.hi) / 2).sort((a, b) => a - b)[Math.floor(use.length / 2)]; lo = m - 500; hi = m + 500; }
    }
    return { offsetMs: (lo + hi) / 2, lo, hi, samples: use.length, lastTs: s[s.length - 1].ts };
  }

  /** The halt reason when the clock is confidently off by more than maxMs; undefined otherwise. */
  haltReason(now: number): string | undefined {
    const e = this.estimate(now);
    if (!e || now - e.lastTs > this.staleMs) return undefined;
    const beyond = e.lo > this.maxMs ? e.lo : e.hi < -this.maxMs ? -e.hi : 0;
    return beyond ? `system clock is ${(Math.abs(e.offsetMs) / 1000).toFixed(1)} s ${e.offsetMs > 0 ? 'behind' : 'ahead of'} Kalshi (limit ${this.maxMs / 1000} s): fix NTP` : undefined;
  }

  warning(now: number): string | undefined {
    const e = this.estimate(now);
    if (!e || now - e.lastTs > this.staleMs || this.haltReason(now)) return undefined;
    const beyond = e.lo > this.warnMs || e.hi < -this.warnMs;
    return beyond ? `system clock drifting: ${(e.offsetMs / 1000).toFixed(1)} s off Kalshi` : undefined;
  }

  status(now: number) {
    const e = this.estimate(now);
    return { offsetMs: e ? Math.round(e.offsetMs) : null, lo: e ? Math.round(e.lo) : null, hi: e ? Math.round(e.hi) : null, samples: e?.samples ?? 0, ageMs: e ? now - e.lastTs : null, maxMs: this.maxMs, halted: !!this.haltReason(now), warning: this.warning(now) ?? null };
  }
}

// Fast and slow lanes: candidate queues, re-evaluation before entry, positions and sizing.
//
//   fast lane  15m / 1h setups held for hours (the intraday / micro-swing trades)
//   slow lane  daily setups held for days to weeks, reviewed at every daily close
//
// Every detected setup the model rates at or above the lane's minimum score joins its lane's queue
// (a newer setup for the same asset and lane replaces the older one). A candidate lives for ttlBars of
// its timeframe. When there is room, the queue is worked best-first and EVERY candidate is checked
// again right before entry: re-scored on fresh data, still at or above the minimum, price not beyond
// the stop or the first target, and not chased (moved no more than maxChaseR toward the target since
// the signal). One position per asset at a time (whichever lane got it first; the slow lane is
// served first), each lane has its own position limit and risk per trade, and total notional is capped
// as a multiple of equity.
// Sizing: risk riskFrac of equity between entry and stop, scaled by the score (0.5x to 1.5x of the
// lane's reference score), capped per asset and in total.

import type { Lane, SetupSignal } from './detectors';
import { TF_MS } from './detectors';
import type { OpenTrade } from './exits';

export interface LaneParams {
  maxPositions: number;
  /** Equity at risk per trade (entry to stop), before the score scaling. */
  riskFrac: number;
  /** Candidate lifetime in bars of its timeframe. */
  ttlBars: number;
  /** Minimum model score (expected R) to queue and to enter. */
  minScore: number;
  /** Score at which the size is 1x (sizes run 0.5x-1.5x around it). */
  refScore: number;
  /** Re-check: largest move toward the target since the signal, in R. */
  maxChaseR: number;
}

export interface LaneBookParams {
  fast: LaneParams;
  slow: LaneParams;
  /** Total notional / equity. */
  maxLeverage: number;
  /** One asset's notional / equity. */
  maxAssetLeverage: number;
}

export const DEFAULT_LANES: LaneBookParams = {
  fast: { maxPositions: 3, riskFrac: 0.004, ttlBars: 2, minScore: 0, refScore: 0.2, maxChaseR: 0.3 },
  slow: { maxPositions: 3, riskFrac: 0.006, ttlBars: 1, minScore: 0, refScore: 0.3, maxChaseR: 0.5 },
  maxLeverage: 3,
  maxAssetLeverage: 1.5,
};

export interface Candidate { sig: SetupSignal; score: number; queuedAt: number; expires: number }

/** What a re-check returns: the current price and the fresh score (undefined = drop the candidate). */
export type Recheck = (c: Candidate) => { px: number; score: number } | undefined;

export interface Entry { cand: Candidate; px: number; score: number; notional: number }

export class LaneBook {
  readonly queues: Record<Lane, Candidate[]> = { fast: [], slow: [] };
  readonly positions = new Map<string, OpenTrade>();
  /** Why the last candidates were dropped or skipped (status / audit). */
  readonly lastSkips: Array<{ asset: string; lane: Lane; kind: string; reason: string; ts: number }> = [];

  constructor(public params: LaneBookParams = DEFAULT_LANES) {}

  /** Queue a scored setup (ignored below the lane's minimum score). */
  offer(sig: SetupSignal, score: number, now: number): boolean {
    const L = this.params[sig.lane];
    if (!(score >= L.minScore)) return false;
    const q = this.queues[sig.lane].filter((c) => c.sig.asset !== sig.asset);
    q.push({ sig, score, queuedAt: now, expires: sig.ts + TF_MS[sig.tf]! * (1 + L.ttlBars) });
    q.sort((a, b) => b.score - a.score);
    this.queues[sig.lane] = q;
    return true;
  }

  expire(now: number): void {
    for (const lane of ['fast', 'slow'] as const) this.queues[lane] = this.queues[lane].filter((c) => c.expires > now);
  }

  private skip(c: Candidate, reason: string, now: number): void {
    this.lastSkips.unshift({ asset: c.sig.asset, lane: c.sig.lane, kind: c.sig.kind, reason, ts: now });
    this.lastSkips.length = Math.min(this.lastSkips.length, 50);
  }

  /** Notional of open positions (at entry). */
  usedNotional(): number { let s = 0; for (const t of this.positions.values()) s += (t.notional ?? 0) * (t.frac || 0); return s; }

  /**
   * Choose entries now: slow lane first, then fast; per lane best score first; every candidate
   * re-checked. Chosen candidates leave the queue (the caller opens the trades and calls add()).
   */
  select(now: number, equity: number, recheck: Recheck): Entry[] {
    this.expire(now);
    const out: Entry[] = [];
    if (!(equity > 0)) return out;
    let used = this.usedNotional();
    const busy = new Set(this.positions.keys());
    for (const lane of ['slow', 'fast'] as const) {
      const L = this.params[lane];
      let open = [...this.positions.values()].filter((t) => t.lane === lane).length;
      const keep: Candidate[] = [];
      for (const c of this.queues[lane]) {
        if (open >= L.maxPositions) { keep.push(c); continue; }
        if (busy.has(c.sig.asset)) { keep.push(c); continue; } // waits for the asset to free up
        const r = recheck(c);
        if (!r) { this.skip(c, 'gone on re-check', now); continue; }
        if (!(r.score >= L.minScore)) { this.skip(c, `re-scored ${r.score.toFixed(3)} below ${L.minScore}`, now); continue; }
        const s = c.sig, d = s.dir;
        const risk = Math.abs(s.ref - s.stop);
        if (!(d * (r.px - s.stop) > 0)) { this.skip(c, 'price beyond the stop', now); continue; }
        if (d * (r.px - s.ref) > L.maxChaseR * risk) { this.skip(c, `price ran ${((d * (r.px - s.ref)) / risk).toFixed(2)}R toward the target: not chasing`, now); continue; }
        const riskPct = Math.abs(r.px - s.stop) / r.px;
        const scale = L.refScore > 0 ? Math.max(0.5, Math.min(1.5, r.score / L.refScore)) : 1;
        let notional = (equity * L.riskFrac * scale) / riskPct;
        notional = Math.min(notional, equity * this.params.maxAssetLeverage, Math.max(0, equity * this.params.maxLeverage - used));
        if (!(notional > 0)) { keep.push(c); continue; }
        out.push({ cand: c, px: r.px, score: r.score, notional });
        used += notional; open++; busy.add(s.asset);
      }
      this.queues[lane] = keep;
    }
    return out;
  }

  add(t: OpenTrade): void { this.positions.set(t.asset, t); }
  remove(asset: string): OpenTrade | undefined { const t = this.positions.get(asset); this.positions.delete(asset); return t; }
}

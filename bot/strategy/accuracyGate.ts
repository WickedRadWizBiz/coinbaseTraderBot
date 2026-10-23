// Market-accuracy gate (paper only; the owner's choice on Oct 23): no new entries in a time-to-close bucket where the
// market's own price has called the results better than the bot.
//
// For every crypto market the bot prices, one snapshot per time-to-close bucket is kept: the evaluation nearest the
// bucket's middle (the bot's probability and the market mid). When the market settles, its snapshots are scored. Per
// bucket, over the last `window` settled markets, the log loss of the bot's probability re-scored with a temperature k
// fitted on those same markets (Phi(Phi^-1(p) / k): the bot's odds have been too extreme, k about 1.15-1.5 on Oct
// 21-23) is set against the log loss of the mid. Worse than the mid: no new entries in that bucket (exits are not
// affected); fewer than `minMarkets` settled markets: open.
//
// Tried on the record first (deploy/decision_study.py section 8, Oct 21-23, walk-forward): the entry fills the gate
// would have left open lost $53 to settlement, against $193 for all of them. Only the gate trades on it: sizing on the
// re-scored probabilities did worse on the same record (it dropped the small-edge fills, the ones that made money).

import { normCdf, normInv } from '../util/num';
import { readJson, writeJsonAtomic } from '../util/persist';

export type AccuracyGroup = 'updown15m' | 'hourly';

export interface AccuracyGateConfig {
  /** Blocks entries where the market has been more accurate (the engine asks only in paper). */
  enabled: boolean;
  /** Settled markets scored per bucket (the most recent). */
  window: number;
  /** Fewer settled markets than this in a bucket: open (warm-up). */
  minMarkets: number;
}

/** Time-to-close buckets in seconds, (lo, hi]: the 15-minute markets' entry window (840-300 s) and the hourly ones'
 *  (3300-600 s) split in parts, plus the last minutes. */
export const ACCURACY_BUCKETS: Record<AccuracyGroup, ReadonlyArray<readonly [number, number]>> = {
  updown15m: [[600, 840], [450, 600], [300, 450], [90, 300]],
  hourly: [[2400, 3300], [1500, 2400], [600, 1500], [90, 600]],
};
const K_GRID = Array.from({ length: 25 }, (_, i) => +(0.8 + 0.05 * i).toFixed(2));
/** A market evaluated but never settled (dropped from the scan) is forgotten this long after its last snapshot. */
const PENDING_MAX_AGE_MS = 3 * 3_600_000;
const SAVE_EVERY_MS = 60_000;

interface Snap { z: number; mid: number; tau: number }
interface Scored { z: number; mid: number; y: 0 | 1; ts: number }
export interface AccuracyGateState { rows: Record<string, Scored[]> }
export interface BucketScore { lo: number; hi: number; n: number; llBot: number | null; llMid: number | null; open: boolean }

const ll = (p: number, y: number) => { const q = Math.min(1 - 1e-3, Math.max(1e-3, p)); return y ? -Math.log(q) : -Math.log(1 - q); };

export function accuracyGroup(ticker: string): AccuracyGroup {
  return ticker.includes('15M-') ? 'updown15m' : 'hourly';
}

export function accuracyBucket(group: AccuracyGroup, tauSec: number): number | undefined {
  const i = ACCURACY_BUCKETS[group].findIndex(([lo, hi]) => tauSec > lo && tauSec <= hi);
  return i >= 0 ? i : undefined;
}

export class AccuracyGate {
  private readonly pending = new Map<string, { group: AccuracyGroup; snaps: Array<Snap | undefined>; lastTs: number }>();
  private readonly scores = new Map<AccuracyGroup, { k: number; buckets: BucketScore[] }>();
  private st: AccuracyGateState;
  private lastSave = 0;
  private lastPrune = 0;
  private dirty = false;

  constructor(private readonly cfg: AccuracyGateConfig, private readonly file?: string, private readonly now: () => number = Date.now) {
    this.st = (file && readJson<AccuracyGateState>(file, { quarantine: true })) || { rows: {} };
    if (!this.st.rows || typeof this.st.rows !== 'object') this.st.rows = {};
  }

  /** One evaluation of a crypto market: kept when it is the nearest yet to the middle of its time-to-close bucket. */
  observe(ticker: string, tauSec: number, pYes: number, mid: number): void {
    if (!(pYes > 0.001 && pYes < 0.999) || !(mid >= 0.05 && mid <= 0.95)) return;
    const group = accuracyGroup(ticker);
    const b = accuracyBucket(group, tauSec);
    if (b === undefined) return;
    const t = this.now();
    let e = this.pending.get(ticker);
    if (!e) { e = { group, snaps: [], lastTs: t }; this.pending.set(ticker, e); }
    e.lastTs = t;
    const [lo, hi] = ACCURACY_BUCKETS[group][b];
    const c = (lo + hi) / 2;
    const cur = e.snaps[b];
    if (!cur || Math.abs(tauSec - c) < Math.abs(cur.tau - c)) e.snaps[b] = { z: normInv(pYes), mid, tau: tauSec };
  }

  /** The market's result: its snapshots are scored (a second call for the same market does nothing). */
  settle(ticker: string, result: 'yes' | 'no'): void {
    const e = this.pending.get(ticker);
    if (e) {
      this.pending.delete(ticker);
      const y = result === 'yes' ? 1 : 0;
      const ts = this.now();
      e.snaps.forEach((s, b) => {
        if (!s) return;
        const rows = (this.st.rows[`${e.group}:${b}`] ??= []);
        rows.push({ z: s.z, mid: s.mid, y, ts });
        if (rows.length > this.cfg.window) rows.splice(0, rows.length - this.cfg.window);
      });
      this.scores.delete(e.group);
      this.dirty = true;
    }
    this.prune();
    this.save();
  }

  private prune(): void {
    const t = this.now();
    if (t - this.lastPrune < 600_000) return;
    this.lastPrune = t;
    for (const [k, e] of this.pending) if (t - e.lastTs > PENDING_MAX_AGE_MS) this.pending.delete(k);
  }

  private save(): void {
    if (!this.file || !this.dirty || this.now() - this.lastSave < SAVE_EVERY_MS) return;
    this.flush();
  }

  /** Writes the scored markets now (otherwise at most once a minute, on a settlement). */
  flush(): void {
    if (!this.file || !this.dirty) return;
    writeJsonAtomic(this.file, this.st);
    this.lastSave = this.now();
    this.dirty = false;
  }

  /** The temperature k and each bucket's log losses, from the settled markets kept. */
  score(group: AccuracyGroup): { k: number; buckets: BucketScore[] } {
    const hit = this.scores.get(group);
    if (hit) return hit;
    const rows = ACCURACY_BUCKETS[group].map((_, b) => this.st.rows[`${group}:${b}`] ?? []);
    const all = rows.flat();
    let k = 1;
    if (all.length >= this.cfg.minMarkets) {
      let best = Infinity;
      for (const kk of K_GRID) {
        let s = 0;
        for (const r of all) s += ll(normCdf(r.z / kk), r.y);
        if (s < best) { best = s; k = kk; }
      }
    }
    const buckets = ACCURACY_BUCKETS[group].map(([lo, hi], b): BucketScore => {
      const rr = rows[b];
      if (!rr.length) return { lo, hi, n: 0, llBot: null, llMid: null, open: true };
      let sb = 0, sm = 0;
      for (const r of rr) { sb += ll(normCdf(r.z / k), r.y); sm += ll(r.mid, r.y); }
      const llBot = sb / rr.length, llMid = sm / rr.length;
      return { lo, hi, n: rr.length, llBot, llMid, open: rr.length < this.cfg.minMarkets || llBot <= llMid };
    });
    const out = { k, buckets };
    this.scores.set(group, out);
    return out;
  }

  /** Why no new entry may open in this market now, or undefined when one may. */
  block(ticker: string, tauSec: number): string | undefined {
    if (!this.cfg.enabled) return undefined;
    const group = accuracyGroup(ticker);
    const b = accuracyBucket(group, tauSec);
    if (b === undefined) return undefined;
    const s = this.score(group).buckets[b];
    return s.open ? undefined : `accuracy gate: the market has called results better ${s.lo}-${s.hi} s before the close`;
  }

  status() {
    const r4 = (x: number | null) => (x === null ? null : +x.toFixed(4));
    const groups = Object.fromEntries((Object.keys(ACCURACY_BUCKETS) as AccuracyGroup[]).map((g) => {
      const s = this.score(g);
      return [g, { k: s.k, buckets: s.buckets.map((b) => ({ ...b, llBot: r4(b.llBot), llMid: r4(b.llMid) })) }];
    }));
    return { enabled: this.cfg.enabled, window: this.cfg.window, minMarkets: this.cfg.minMarkets, pending: this.pending.size, groups };
  }
}

// Spot wall study (the owner's ask on Oct 31: use the Coinbase book already recorded rather than wait for more). Two parts:
//
// 1. Integrity. Is each coin's recorded spot book ('spot_book' lines: the top levels and, since Oct 29, the whole
//    book's size in bands out from the mid, every 15 s) complete, sane and in step with the Coinbase price feed
//    ('spot', the public ticker)? Coverage and gaps, crossed or unsorted books, repeated (stale) books, the book's mid
//    against the ticker, the bands against the top levels they must contain, and whether the outer bands hold size (a
//    book cut short would leave them empty). A coin passes only if every check does.
// 2. Walls as barriers, on the coins that pass. A wall is a band holding at least --wall-z (2) times what that band
//    (the same side, the same distance from the mid) held over the hour before (its median; nothing later is used).
//    From each snapshot, over the next 5 and 15 minutes of ticker prices: did the price reach the band (touched),
//    stop inside it (held: it never reached the band's far edge), or come back a band's width toward where it started
//    after touching it (bounced)? Walls are compared with plain bands at the same coin, side, distance and volatility
//    third (the price range of the 5 minutes before), and the
//    difference in held and bounced rates is pooled over those strata (each weighted tw*tp/(tw+tp) by its touch
//    counts), with a 90% interval from resampling whole hours. Also: whether a touched wall was still there (at least
//    half its size left in its price range) in the last snapshot before the touch, and how often each distance is
//    reached at all.
//
//   npm run research:spot-wall-study -- --recordings data/recordings [--from 2026-10-29] [--to 2026-10-31] [--out f.json]
//
// Read-only: writes only --out. SpotWallTracker is shared with research/makerExitStudy.ts (its spot wall rules).

import fs from 'fs';
import path from 'path';
import { readRecordings } from './replay';

export interface SpotBookLine { ts: number; b: number[][]; a: number[][]; bw?: number; bb?: number[]; ba?: number[] }

const medianOf = (xs: number[]): number => { if (!xs.length) return NaN; const s = [...xs].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2; };

/** A pause in the recordings longer than this is an outage: not recorded time, left out of coverage and of the study. */
export const OUTAGE_MS = 10 * 60_000;

/** Each band's size against its own trailing history (the same coin, side and distance), one line at a time. */
export interface WallView { ts: number; mid: number; bw: number; zBid: number[]; zAsk: number[]; bid: number[]; ask: number[] }

export class SpotWallTracker {
  private readonly hist = new Map<string, number[][]>();
  private readonly last = new Map<string, WallView>();
  /** `window`: trailing snapshots per band (240 = an hour at 15 s); `minHist`: needed before a band gets a z. */
  constructor(readonly window = 240, readonly minHist = 120) {}

  /** Adds one recorded line; returns each band's z against the history before it (NaN while the history is short). */
  add(asset: string, line: SpotBookLine): WallView | undefined {
    const bb = line.bb, ba = line.ba, bw = line.bw;
    if (!bb || !ba || !bw || !line.b?.length || !line.a?.length) return undefined;
    // After an outage (the bot down or not recording) the hour before is not "the hour before": start the history over.
    const prev = this.last.get(asset);
    if (prev && line.ts - prev.ts > OUTAGE_MS) for (const k of [...this.hist.keys()]) if (k.startsWith(`${asset}|`)) this.hist.delete(k);
    const mid = (line.b[0][0] + line.a[0][0]) / 2;
    const z = (side: 'b' | 'a', sizes: number[]) => {
      const key = `${asset}|${side}|${bw}|${sizes.length}`;
      let h = this.hist.get(key);
      if (!h) { h = sizes.map(() => []); this.hist.set(key, h); }
      return sizes.map((s, k) => {
        const past = h![k];
        const med = past.length >= this.minHist ? medianOf(past) : NaN;
        past.push(s);
        if (past.length > this.window) past.shift();
        return med > 0 ? s / med : NaN;
      });
    };
    const v: WallView = { ts: line.ts, mid, bw, zBid: z('b', bb), zAsk: z('a', ba), bid: bb, ask: ba };
    this.last.set(asset, v);
    return v;
  }

  latest(asset: string): WallView | undefined { return this.last.get(asset); }

  /** The near edge of the nearest wall (z >= minZ, bands 1 and out: band 0 holds the touch) that the price runs into
   *  going `up` (an ask wall) or down (a bid wall), from the coin's latest line if it is at most maxAgeMs old. */
  wallLevel(asset: string, now: number, up: boolean, minZ = 2, maxAgeMs = 60_000): number | undefined {
    const v = this.last.get(asset);
    if (!v || now - v.ts > maxAgeMs || now < v.ts - 5_000) return undefined;
    const z = up ? v.zAsk : v.zBid;
    const w = v.bw / 10_000;
    for (let k = 1; k < z.length; k++) if (z[k] >= minZ) return up ? v.mid * (1 + k * w) : v.mid * (1 - k * w);
    return undefined;
  }
}

/** Sizes of the top levels per band (the same banding as bot/marketdata/spotBook.ts bandDepth). */
export function topPerBand(levels: number[][], mid: number, bps: number, n: number): number[] {
  const out = new Array<number>(n).fill(0);
  for (const [p, s] of levels) { const i = Math.floor((Math.abs(p - mid) / mid) * 10_000 / bps); if (i < n) out[i] += s; }
  return out;
}

export interface Integrity {
  asset: string; snaps: number; withBands: number; hours: number; cadenceSec: number;
  /** Recorded hours (the span less outages), the outages (start ISO time, minutes) and coverage within recorded time. */
  recordedHours: number; outages: Array<[string, number]>; coverage: number;
  gapsOver60s: number; longestGapMin: number; nonMonotone: number; crossed: number; unsorted: number; badSize: number;
  repeated: number; fetchLagMsMedian: number; spotTicks: number; midVsSpotBpsMedian: number; midVsSpotBpsP99: number;
  midVsSpotChecked: number; bandsConsistent: number; outerBandsFilled: number; bandsOverTopMedian: number;
  pass: boolean; why: string[];
}

export function checkIntegrity(asset: string, lines: Array<SpotBookLine & { t: number }>, ticks: Float64Array | number[]): Integrity {
  const why: string[] = [];
  const n = lines.length;
  const banded = lines.filter((l) => l.bb && l.ba && l.bw);
  let nonMonotone = 0, crossed = 0, unsorted = 0, badSize = 0, repeated = 0, consistent = 0, filled = 0, midChecked = 0;
  const lags: number[] = [], dts: number[] = [], diffs: number[] = [], ratios: number[] = [];
  let tick = 0;
  const T = ticks.length / 2;
  for (let i = 0; i < n; i++) {
    const l = lines[i];
    lags.push(l.t - l.ts);
    if (i) { const dt = l.ts - lines[i - 1].ts; if (dt <= 0) nonMonotone++; else dts.push(dt); }
    const b = l.b ?? [], a = l.a ?? [];
    if (b.length && a.length && b[0][0] >= a[0][0]) crossed++;
    if (b.some((x, j) => j && x[0] >= b[j - 1][0]) || a.some((x, j) => j && x[0] <= a[j - 1][0])) unsorted++;
    if ([...b, ...a].some((x) => !(x[1] > 0) || !(x[0] > 0))) badSize++;
    if (i && JSON.stringify([b, a]) === JSON.stringify([lines[i - 1].b, lines[i - 1].a])) repeated++;
    if (b.length && a.length) {
      const mid = (b[0][0] + a[0][0]) / 2;
      while (tick < T && ticks[2 * tick] <= l.ts) tick++;
      if (tick > 0 && l.ts - ticks[2 * (tick - 1)] <= 5_000) { midChecked++; diffs.push((Math.abs(mid - ticks[2 * tick - 1]) / mid) * 10_000); }
      if (l.bb && l.ba && l.bw) {
        const nb = l.bb.length;
        const tb = topPerBand(b, mid, l.bw, nb), ta = topPerBand(a, mid, l.bw, l.ba.length);
        const ok = (top: number[], band: number[]) => top.every((s, k) => s <= band[k] * (1 + 1e-4) + 1e-9);
        if (ok(tb, l.bb) && ok(ta, l.ba)) consistent++;
        if (l.bb[nb - 1] > 0 && l.ba[l.ba.length - 1] > 0) filled++;
        const top = b.reduce((s, x) => s + x[1], 0) + a.reduce((s, x) => s + x[1], 0);
        if (top > 0) ratios.push((l.bb.reduce((s, x) => s + x, 0) + l.ba.reduce((s, x) => s + x, 0)) / top);
      }
    }
  }
  const cadence = medianOf(dts);
  const span = n > 1 ? lines[n - 1].ts - lines[0].ts : 0;
  const outages: Array<[string, number]> = [];
  let outMs = 0;
  for (let i = 1; i < n; i++) { const dt = lines[i].ts - lines[i - 1].ts; if (dt > OUTAGE_MS) { outages.push([new Date(lines[i - 1].ts).toISOString().slice(0, 16), Math.round(dt / 60_000)]); outMs += dt; } }
  const recorded = span - outMs;
  const coverage = recorded > 0 && cadence > 0 ? Math.min(1, ((n - 1 - outages.length) * cadence) / recorded) : 0;
  const gaps = dts.filter((d) => d > 60_000);
  const sortedDiffs = [...diffs].sort((x, y) => x - y);
  const r: Integrity = {
    asset, snaps: n, withBands: banded.length, hours: span / 3_600_000, cadenceSec: cadence / 1000, recordedHours: recorded / 3_600_000, outages, coverage,
    gapsOver60s: gaps.length, longestGapMin: gaps.length ? Math.max(...gaps) / 60_000 : 0, nonMonotone, crossed, unsorted, badSize, repeated,
    fetchLagMsMedian: medianOf(lags), spotTicks: T, midVsSpotBpsMedian: medianOf(diffs),
    midVsSpotBpsP99: sortedDiffs.length ? sortedDiffs[Math.floor(0.99 * (sortedDiffs.length - 1))] : NaN, midVsSpotChecked: midChecked,
    bandsConsistent: banded.length ? consistent / banded.length : 0, outerBandsFilled: banded.length ? filled / banded.length : 0,
    bandsOverTopMedian: medianOf(ratios), pass: false, why,
  };
  if (banded.length < 1000) why.push(`only ${banded.length} snapshots with bands`);
  if (coverage < 0.9) why.push(`coverage ${(100 * coverage).toFixed(0)}% of recorded time`);
  if (recorded < 24 * 3_600_000) why.push(`only ${(recorded / 3_600_000).toFixed(1)} recorded hours`);
  if (crossed > n * 0.001) why.push(`${crossed} crossed books`);
  if (unsorted > n * 0.001) why.push(`${unsorted} unsorted books`);
  if (badSize > n * 0.001) why.push(`${badSize} books with a bad level`);
  if (nonMonotone > n * 0.001) why.push(`${nonMonotone} out-of-order snapshots`);
  if (repeated > n * 0.05) why.push(`${repeated} repeated (stale) books`);
  if (midChecked < n * 0.5) why.push(`the ticker is near only ${midChecked} of ${n} snapshots`);
  else if (!(r.midVsSpotBpsMedian <= 3)) why.push(`mid vs ticker median ${r.midVsSpotBpsMedian.toFixed(1)} bps`);
  if (r.bandsConsistent < 0.99) why.push(`bands contain the top levels in only ${(100 * r.bandsConsistent).toFixed(1)}%`);
  if (r.outerBandsFilled < 0.95) why.push(`outer bands filled in only ${(100 * r.outerBandsFilled).toFixed(1)}% (book cut short?)`);
  r.pass = !why.length;
  return r;
}

/** One second-by-second price path (the last ticker price of each second, carried forward) and, per second, how many
 *  seconds since a tick last arrived (a feed gap, as opposed to trades printing at one price). */
export function secondPath(ticks: Float64Array | number[]): { t0: number; px: Float64Array; age: Float64Array } {
  const T = ticks.length / 2;
  if (!T) return { t0: 0, px: new Float64Array(0), age: new Float64Array(0) };
  const t0 = Math.floor(ticks[0] / 1000), t1 = Math.floor(ticks[2 * (T - 1)] / 1000);
  const px = new Float64Array(t1 - t0 + 1).fill(NaN);
  const age = new Float64Array(px.length).fill(NaN);
  for (let i = 0; i < T; i++) { const j = Math.floor(ticks[2 * i] / 1000) - t0; px[j] = ticks[2 * i + 1]; age[j] = 0; }
  for (let i = 1; i < px.length; i++) if (Number.isNaN(px[i])) { px[i] = px[i - 1]; age[i] = age[i - 1] + 1; }
  return { t0, px, age };
}

/** From second s (exclusive) over H seconds: for bands k = 1..n-1 on one side, the first second the price reached each
 *  band's near edge (k) and far edge (k+1), and the first second it came back a band's width toward the start after
 *  reaching band k. Infinity where it never did; undefined if the path has a hole (no tick for over maxStaleSec, judged
 *  by tick arrival, never by an unchanged price) or ends inside the horizon. */
export function bandOutcomes(px: Float64Array, s: number, H: number, mid: number, w: number, n: number, up: boolean, age?: Float64Array, maxStaleSec = 120):
  { touch: number[]; bounce: number[] } | undefined {
  if (s < 0 || s + H >= px.length) return undefined;
  const edge = (k: number) => (up ? mid * (1 + k * w) : mid * (1 - k * w));
  const touch = new Array<number>(n + 1).fill(Infinity), bounce = new Array<number>(n + 1).fill(Infinity);
  let next = 1;
  for (let d = 1; d <= H; d++) {
    const p = px[s + d];
    if (Number.isNaN(p)) return undefined;
    if (age && age[s + d] > maxStaleSec) return undefined;
    while (next <= n && (up ? p >= edge(next) : p <= edge(next))) touch[next++] = d;
    for (let k = 1; k < next && k < n; k++) {
      if (bounce[k] !== Infinity || touch[k + 1] !== Infinity) continue;
      const back = up ? edge(k) - mid * w : edge(k) + mid * w;
      if (up ? p <= back : p >= back) bounce[k] = d;
    }
  }
  return { touch, bounce };
}

interface Count { n: number; touch: number; held: number; bounce: number }
const zc = (): Count => ({ n: 0, touch: 0, held: 0, bounce: 0 });

export interface WallStudy {
  from?: string; to?: string; wallZ: number; integrity: Integrity[];
  /** Per horizon: pooled wall-minus-plain held and bounced rates (points) with 90% hour-resampled intervals. */
  effect: Record<string, { held: [number, number, number]; bounce: [number, number, number]; strata: number; wallTouches: number; plainTouches: number }>;
  /** Per horizon, side and distance (bands from the mid), over the passing coins: walls vs plain bands. */
  table: Array<{ H: number; side: 'ask' | 'bid'; k: number; wall: Count; plain: Count }>;
  /** Touched walls (15 min): at least half the wall's size still in its price range in the last snapshot before the
   *  touch, and their held rate. */
  persistence: { touched: number; stayed: number; heldStayed: number; pulled: number; heldPulled: number; unknown: number };
}

export async function runWallStudy(o: { recordings: string; from?: string; to?: string; wallZ?: number; boot?: number; log?: (m: string) => void }): Promise<WallStudy> {
  const log = o.log ?? (() => {});
  const wallZ = o.wallZ ?? 2;
  const books = new Map<string, Array<SpotBookLine & { t: number }>>();
  const tickArr = new Map<string, number[]>();
  for await (const e of readRecordings(o.recordings, '', o.from, o.to, (k) => k === 'spot_book' || k === 'spot')) {
    if (e.hist) continue;
    if (e.k === 'spot_book' && e.asset) (books.get(e.asset) ?? books.set(e.asset, []).get(e.asset)!).push({ t: e.t, ts: e.ts ?? e.t, b: e.b ?? [], a: e.a ?? [], bw: e.bw, bb: e.bb, ba: e.ba });
    else if (e.k === 'spot' && e.asset && e.value > 0) { const a = tickArr.get(e.asset) ?? tickArr.set(e.asset, []).get(e.asset)!; a.push(e.ts ?? e.t, e.value); }
  }
  const integrity: Integrity[] = [];
  const table = new Map<string, { H: number; side: 'ask' | 'bid'; k: number; wall: Count; plain: Count }>();
  // Per hour and stratum (coin|side|k|H): counts for walls and plain bands, for the resampled interval.
  const byHour = new Map<number, Map<string, { w: Count; p: Count }>>();
  const persistence = { touched: 0, stayed: 0, heldStayed: 0, pulled: 0, heldPulled: 0, unknown: 0 };
  const HS = [300, 900];
  for (const asset of [...books.keys()].sort()) {
    const lines = books.get(asset)!.sort((x, y) => x.ts - y.ts);
    const raw = tickArr.get(asset) ?? [];
    // Ticks in time order (the feed's own timestamps can arrive slightly out of order).
    const idx = Array.from({ length: raw.length / 2 }, (_, i) => i).sort((x, y) => raw[2 * x] - raw[2 * y]);
    const ticks = new Float64Array(raw.length);
    idx.forEach((j, i) => { ticks[2 * i] = raw[2 * j]; ticks[2 * i + 1] = raw[2 * j + 1]; });
    tickArr.delete(asset);
    const integ = checkIntegrity(asset, lines, ticks);
    integrity.push(integ);
    log(`[integrity] ${asset}: ${integ.pass ? 'PASS' : `FAIL (${integ.why.join('; ')})`}`);
    if (!integ.pass) continue;
    const { t0, px, age } = secondPath(ticks);
    const tracker = new SpotWallTracker();
    const views: WallView[] = [];
    for (const l of lines) { const v = tracker.add(asset, l); if (v) views.push(v); }
    // The 5 minutes before each snapshot: its price range (bps), so walls are compared with plain bands in the same
    // volatility third (a calm market reaches fewer bands and may also carry thicker books).
    const vol = views.map((v) => {
      const s = Math.ceil(v.ts / 1000) - t0;
      if (s - 300 < 0 || s >= px.length) return NaN;
      let lo = Infinity, hi = -Infinity;
      for (let d = s - 300; d <= s; d++) { const p = px[d]; if (p < lo) lo = p; if (p > hi) hi = p; }
      return Number.isFinite(lo) && Number.isFinite(hi) ? ((hi - lo) / v.mid) * 10_000 : NaN;
    });
    const vs = vol.filter(Number.isFinite).sort((x, y) => x - y);
    const cut1 = vs[Math.floor(vs.length / 3)] ?? Infinity, cut2 = vs[Math.floor((2 * vs.length) / 3)] ?? Infinity;
    for (let i = 0; i < views.length; i++) {
      const v = views[i];
      const w = v.bw / 10_000;
      const s = Math.ceil(v.ts / 1000) - t0;
      const hour = Math.floor(v.ts / 3_600_000);
      if (!Number.isFinite(vol[i])) continue;
      const third = vol[i] < cut1 ? 0 : vol[i] < cut2 ? 1 : 2;
      for (const side of ['ask', 'bid'] as const) {
        const z = side === 'ask' ? v.zAsk : v.zBid;
        const nb = z.length;
        const out = bandOutcomes(px, s, HS[HS.length - 1], v.mid, w, nb, side === 'ask', age);
        if (!out) continue;
        for (let k = 1; k < nb; k++) {
          if (!Number.isFinite(z[k])) continue;
          const isWall = z[k] >= wallZ;
          for (const H of HS) {
            const touched = out.touch[k] <= H;
            const held = touched && !(out.touch[k + 1] <= H);
            const bounced = touched && out.bounce[k] <= H;
            const key = `${H}|${side}|${k}`;
            const row = table.get(key) ?? table.set(key, { H, side, k, wall: zc(), plain: zc() }).get(key)!;
            const c = isWall ? row.wall : row.plain;
            c.n++; if (touched) c.touch++; if (held) c.held++; if (bounced) c.bounce++;
            const hm = byHour.get(hour) ?? byHour.set(hour, new Map()).get(hour)!;
            const sk = `${asset}|v${third}|${key}`;
            const hs = hm.get(sk) ?? hm.set(sk, { w: zc(), p: zc() }).get(sk)!;
            const hc = isWall ? hs.w : hs.p;
            hc.n++; if (touched) hc.touch++; if (held) hc.held++; if (bounced) hc.bounce++;
          }
          if (isWall && out.touch[k] <= 900) {
            // Was it still there just before the price arrived? The size resting in the wall's own price range in the last
            // snapshot at or before the touch (each band of that snapshot pro-rated by its overlap with the range),
            // against the wall's size when it was seen: stayed if at least half is left.
            persistence.touched++;
            const tt = (s + out.touch[k] + t0) * 1000;
            let lo = i, hi = views.length - 1;
            while (lo < hi) { const m = (lo + hi + 1) >> 1; if (views[m].ts <= tt) lo = m; else hi = m - 1; }
            const vi = lo;
            const u = views[vi];
            const rLo = side === 'ask' ? v.mid * (1 + k * w) : v.mid * (1 - (k + 1) * w);
            const rHi = side === 'ask' ? v.mid * (1 + (k + 1) * w) : v.mid * (1 - k * w);
            const uSizes = side === 'ask' ? u.ask : u.bid, uw = u.bw / 10_000;
            let left = 0;
            for (let b = 0; b < uSizes.length; b++) {
              const bl = side === 'ask' ? u.mid * (1 + b * uw) : u.mid * (1 - (b + 1) * uw);
              const bh = side === 'ask' ? u.mid * (1 + (b + 1) * uw) : u.mid * (1 - b * uw);
              left += (uSizes[b] * Math.max(0, Math.min(rHi, bh) - Math.max(rLo, bl))) / (bh - bl);
            }
            const was = (side === 'ask' ? v.ask : v.bid)[k];
            const share = was > 0 ? left / was : NaN;
            const held = !(out.touch[k + 1] <= 900);
            if (vi === i || !Number.isFinite(share)) persistence.unknown++;
            else if (share >= 0.5) { persistence.stayed++; if (held) persistence.heldStayed++; }
            else { persistence.pulled++; if (held) persistence.heldPulled++; }
          }
        }
      }
    }
    log(`[walls] ${asset}: ${views.length} snapshots with bands scored`);
  }
  // Pooled difference over strata, from per-hour counts; the interval resamples whole hours.
  const hours = [...byHour.keys()].sort((x, y) => x - y);
  const pooled = (pick: number[], H: number, what: 'held' | 'bounce') => {
    const sum = new Map<string, { w: Count; p: Count }>();
    for (const h of pick) for (const [k, v] of byHour.get(hours[h])!) {
      if (!k.includes(`|${H}|`)) continue;
      const s = sum.get(k) ?? sum.set(k, { w: zc(), p: zc() }).get(k)!;
      s.w.touch += v.w.touch; s.w[what] += v.w[what]; s.p.touch += v.p.touch; s.p[what] += v.p[what];
    }
    let num = 0, den = 0, strata = 0, wt = 0, pt = 0;
    for (const { w, p } of sum.values()) {
      if (w.touch < 5 || p.touch < 5) continue;
      const wgt = (w.touch * p.touch) / (w.touch + p.touch);
      num += wgt * (w[what] / w.touch - p[what] / p.touch); den += wgt; strata++; wt += w.touch; pt += p.touch;
    }
    return { d: den ? (100 * num) / den : NaN, strata, wt, pt };
  };
  const boot = o.boot ?? 500;
  // mulberry32: a 2^32 period, plenty for the resamples (a float LCG lost its low bits and cycled after ~10k draws).
  let seed = 12345;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const all = hours.map((_, i) => i);
  const effect: WallStudy['effect'] = {};
  for (const H of HS) {
    const ci = (what: 'held' | 'bounce'): [number, number, number] => {
      const point = pooled(all, H, what).d;
      const xs: number[] = [];
      for (let b = 0; b < boot && hours.length > 1; b++) { const d = pooled(all.map(() => Math.floor(rnd() * hours.length)), H, what).d; if (Number.isFinite(d)) xs.push(d); }
      xs.sort((x, y) => x - y);
      return [point, xs.length ? xs[Math.floor(0.05 * (xs.length - 1))] : NaN, xs.length ? xs[Math.floor(0.95 * (xs.length - 1))] : NaN];
    };
    const p = pooled(all, H, 'held');
    effect[`${H / 60}min`] = { held: ci('held'), bounce: ci('bounce'), strata: p.strata, wallTouches: p.wt, plainTouches: p.pt };
  }
  return { from: o.from, to: o.to, wallZ, integrity, effect, table: [...table.values()].sort((x, y) => x.H - y.H || x.side.localeCompare(y.side) || x.k - y.k), persistence };
}

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
const pc = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(0)}%` : 'n/a');

export function wallReport(r: WallStudy): string {
  const out: string[] = [`Spot wall study ${r.from ?? ''}..${r.to ?? ''} (wall = z >= ${r.wallZ} vs the band's own trailing hour)`, '', 'Integrity'];
  for (const i of r.integrity) {
    out.push(`  ${i.asset.padEnd(5)} ${i.pass ? 'PASS' : 'FAIL'}  ${i.snaps} snaps (${i.withBands} with bands) over ${i.hours.toFixed(1)} h, every ${i.cadenceSec.toFixed(0)} s; recorded ${i.recordedHours.toFixed(1)} h (outages: ${i.outages.map(([a, m]) => `${a} ${m} min`).join(', ') || 'none'}), coverage ${pc(i.coverage, 1)} of it, `
      + `${i.gapsOver60s} gaps > 60 s (longest ${i.longestGapMin.toFixed(1)} min); crossed ${i.crossed}, unsorted ${i.unsorted}, bad level ${i.badSize}, out of order ${i.nonMonotone}, repeated ${i.repeated}; `
      + `fetch lag ${f1(i.fetchLagMsMedian)} ms; mid vs ticker ${f1(i.midVsSpotBpsMedian)} bps (p99 ${f1(i.midVsSpotBpsP99)}, ${i.midVsSpotChecked} checked, ${i.spotTicks} ticks); `
      + `bands contain the top ${pc(i.bandsConsistent, 1)}, outer bands filled ${pc(i.outerBandsFilled, 1)}, whole-band size ${f1(i.bandsOverTopMedian)}x the top levels`
      + (i.why.length ? `  -> ${i.why.join('; ')}` : ''));
  }
  out.push('', 'Walls vs plain bands (pooled over coin, side, distance and volatility third; points, 90% interval from resampled hours)');
  for (const [h, e] of Object.entries(r.effect)) {
    out.push(`  ${h.padEnd(6)} held ${f1(e.held[0])} [${f1(e.held[1])}, ${f1(e.held[2])}]   bounced ${f1(e.bounce[0])} [${f1(e.bounce[1])}, ${f1(e.bounce[2])}]   (${e.strata} strata, ${e.wallTouches} wall / ${e.plainTouches} plain touches)`);
  }
  out.push('', '  H    side k   touched wall / plain     held | touched wall / plain     bounced | touched wall / plain');
  for (const t of r.table) {
    out.push(`  ${String(t.H / 60).padStart(2)}m  ${t.side} ${String(t.k).padStart(2)}   ${pc(t.wall.touch, t.wall.n).padStart(4)} of ${String(t.wall.n).padStart(6)} / ${pc(t.plain.touch, t.plain.n).padStart(4)} of ${String(t.plain.n).padStart(6)}`
      + `   ${pc(t.wall.held, t.wall.touch).padStart(4)} / ${pc(t.plain.held, t.plain.touch).padStart(4)}   ${pc(t.wall.bounce, t.wall.touch).padStart(4)} / ${pc(t.plain.bounce, t.plain.touch).padStart(4)}`);
  }
  const p = r.persistence;
  out.push('', `Touched walls (15 min): ${p.touched}; still there just before the touch ${p.stayed} (held ${pc(p.heldStayed, p.stayed)}), pulled ${p.pulled} (held ${pc(p.heldPulled, p.pulled)}), unknown ${p.unknown}`);
  return out.join('\n');
}

function arg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

async function main(): Promise<void> {
  const r = await runWallStudy({ recordings: arg('recordings', 'data/recordings'), from: arg('from', '') || undefined, to: arg('to', '') || undefined,
    wallZ: Number(arg('wall-z', '2')), log: (m) => console.log(m) });
  console.log(wallReport(r));
  const out = arg('out', '');
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(r, null, 1)); }
  if (!r.integrity.some((i) => i.pass)) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error(e); process.exit(1); });

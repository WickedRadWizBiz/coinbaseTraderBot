// Fractal Alignment Engine: where the 2018-to-now BTC dominance cycle stands on its 2016-2017 parent.
//
// The thesis: BTC.D since 2018 (the child) is replaying the shape of 2016-2017 (the parent: a long
// BTC-dominant stretch, a first waterfall, a relief rally, then the final waterfall into the alt season), slowed
// down several times and on a compressed scale. The engine measures that relationship point in time, from the
// weekly closes known at the time, so the same numbers feed training and the live bot.
//
//   alignment   dynamic time warping of the child's weekly closes onto the parent's. Each child week advances
//               the parent by 0, 1 or 2 weeks (local time dilation from 0.5x up to maxStall x), the child's first
//               week may sit anywhere in the first startSlack of the parent, and the end is open: the child's
//               latest week lands on the parent week it matches best. Levels are compared after an affine map
//               (child = a + b x parent), refitted on the aligned pairs a few times, because the child moves on
//               a compressed scale.
//   state       the parent week matched to now (date, progress through the parent), the parent's phase there
//               (its swings, from a zigzag, with the deep falls marked as waterfalls), the time dilation overall
//               and over the last localBars weeks, and how well the child fits (correlation and error after
//               the map, over the whole path and the last year).
//   projection  the parent's remaining path, mapped onto the child's scale and anchored at the current level,
//               stretched by the dilation: BTC.D in 30 / 90 / 180 days, the next waterfall's projected start,
//               the remaining low and when it comes, and when the projection crosses a level (the 55% gate).
//
// Nothing is given before the child has minChildBars weeks (the features read NaN), and nothing at all before
// the child's start (2018): the relationship only exists from then on. It is a description of the market's
// path, not a forecast with a track record; research/fractalStudy.ts scores the projection walk-forward.

import type { Candle } from '../ta/indicators';

const DAY = 86_400_000;

export interface FractalConfig {
  /** Parent window [from, to) and the child's start (UTC ms). */
  parentFrom: number;
  parentTo: number;
  childFrom: number;
  /** Bar length the series are compared on (weekly). */
  barMs: number;
  /** Most child bars on one parent bar (local dilation cap). */
  maxStall: number;
  /** The child's first bar may align within this share of the parent's start. */
  startSlack: number;
  /** Weeks of child before a state is given. */
  minChildBars: number;
  /** Child bars for the local dilation and the recent fit. */
  localBars: number;
  recentBars: number;
  /** Affine refits of the level map. */
  iterations: number;
  /** Zigzag threshold (points of BTC.D) for the parent's swings, and the drop that makes a fall a waterfall. */
  swingPts: number;
  waterfallPts: number;
  /** Weight of the shape term (trend per parent bar, points) against the level term (points). */
  slopeWeight: number;
  /** How long a waterfall's steep part lasts in the projection, start to finish (days). Waterfalls are fast
   *  capitulations, not slowed down with the rest of the cycle: only the drift and the rallies between them are
   *  stretched by the dilation. 0 = stretch the waterfalls too. */
  waterfallDays: number;
}

export const DEFAULT_FRACTAL: FractalConfig = {
  parentFrom: Date.UTC(2016, 0, 1), parentTo: Date.UTC(2018, 0, 1), childFrom: Date.UTC(2018, 0, 1),
  barMs: 7 * DAY, maxStall: 16, startSlack: 0.15, minChildBars: 52, localBars: 26, recentBars: 52, iterations: 3,
  swingPts: 6, waterfallPts: 15, slopeWeight: 2, waterfallDays: 90,
};

/** A parent swing between two extremes (bar indices); `move`: where its steep part starts (the drift before it,
 *  under 15% of the swing, is the base it builds from). */
export interface Swing { from: number; move: number; to: number; dir: 1 | -1; fromLevel: number; toLevel: number; waterfall: boolean }

export interface FractalProjectionPoint { ts: number; btcd: number; parentTs: number }

export interface FractalState {
  /** As of (UTC ms): the end of the last complete child bar. */
  asOf: number;
  childBars: number;
  /** The parent bar matched to now: its date and the share of the parent behind it. */
  parentTs: number;
  progress: number;
  /** The parent's swing at that bar: index, direction, waterfall, share of it done. */
  swing: { index: number; count: number; dir: 1 | -1; waterfall: boolean; base: boolean; frac: number; fromTs: number; toTs: number; fromLevel: number; toLevel: number };
  phase: string;
  /** Child time per parent time: since the start, and over the last localBars. */
  dilation: number;
  localDilation: number;
  /** Level map child = a + b x parent, and the fit after it. */
  map: { a: number; b: number };
  /** The level map the projection uses, fitted in logit space (it keeps projected BTC.D inside 0-100%). */
  projMap: { a: number; b: number };
  fit: { r: number; recentR: number; maePts: number; recentMaePts: number };
  btcd: number;
  /** The parent's remaining path on the child's scale (anchored at the current level). */
  projection: FractalProjectionPoint[];
  proj: { d30: number; d90: number; d180: number };
  /** The next parent waterfall (the current one when inside it): projected start, end and depth on the child's scale. */
  nextWaterfall?: { startTs: number; endTs: number; fromBtcd: number; toBtcd: number; weeksAway: number; inside: boolean };
  /** The lowest projected level ahead and when. */
  low?: { ts: number; btcd: number };
  /** Parent and child bars, for the dashboard chart (child in its own scale; parent mapped onto it). */
  path: Array<{ childTs: number; parentTs: number; btcd: number; mapped: number }>;
}

/** Last close in each bar [from + k x barMs, from + (k + 1) x barMs) that has ended by `upto`, carried over an
 *  empty bar (none before the first close). Closes count once the daily bar has closed (ts + 1 day <= upto). */
export function barCloses(daily: Candle[], from: number, to: number, barMs: number, upto = Infinity): Array<{ ts: number; c: number }> {
  const end = Math.min(to, upto);
  const n = Math.floor((end - from) / barMs);
  const out: Array<{ ts: number; c: number }> = [];
  if (!(n > 0)) return out;
  let k = 0, last = NaN;
  // first daily bar at or after `from`
  let lo = 0, hi = daily.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (daily[m].ts < from) lo = m + 1; else hi = m; }
  for (let b = 0; b < n; b++) {
    const bEnd = from + (b + 1) * barMs;
    for (k = Math.max(k, lo); k < daily.length && daily[k].ts + DAY <= bEnd; k++) if (Number.isFinite(daily[k].c) && daily[k].c > 0) last = daily[k].c;
    lo = k;
    if (Number.isFinite(last)) out.push({ ts: bEnd, c: last });
    else if (out.length) out.push({ ts: bEnd, c: out[out.length - 1].c });
  }
  return out;
}

/** The parent's swings: a zigzag reversing on a move of `pts` from the last extreme; falls of `waterfallPts`
 *  or more are waterfalls. Indices are bar indices. */
export function swings(p: number[], pts: number, waterfallPts: number): Swing[] {
  if (p.length < 2) return [];
  const out: Swing[] = [];
  const push = (from: number, to: number, dir: 1 | -1) => {
    const total = Math.abs(p[to] - p[from]);
    let move = from;
    while (move < to && Math.abs(p[move + 1] - p[from]) < 0.15 * total) move++;
    out.push({ from, move, to, dir, fromLevel: p[from], toLevel: p[to], waterfall: dir < 0 && p[from] - p[to] >= waterfallPts });
  };
  let start = 0, ext = 0, dir: 1 | -1 | 0 = 0;
  for (let i = 1; i < p.length; i++) {
    if (dir === 0) {
      if (Math.abs(p[i] - p[start]) >= pts) { dir = p[i] > p[start] ? 1 : -1; ext = i; }
      else if ((p[i] > p[start] && p[i] > p[ext]) || (p[i] < p[start] && p[i] < p[ext])) ext = i;
      continue;
    }
    if (dir * (p[i] - p[ext]) > 0) ext = i;
    else if (dir * (p[ext] - p[i]) >= pts) {
      push(start, ext, dir);
      start = ext; ext = i; dir = dir > 0 ? -1 : 1;
    }
  }
  const last = p.length - 1;
  if (dir === 0) dir = p[last] >= p[0] ? 1 : -1;
  if (ext !== start) push(start, ext, dir);
  if (ext < last) push(ext, last, p[last] >= p[ext] ? 1 : -1);
  return out;
}

/** Open-end DTW of child c onto parent p under the level map (a, b): the parent bar for every child bar.
 *  Each child bar advances the parent by 0 (at most maxStall bars in a row), 1 or 2; the first child bar sits
 *  within the first `slack` parent bars. */
export function align(c: number[], p: number[], a: number, b: number, maxStall: number, slack: number, slope?: { c: number[]; p: number[]; w: number }): { path: number[]; cost: number } {
  const n = c.length, m = p.length, K = Math.max(1, maxStall);
  if (!n || !m) return { path: [], cost: NaN };
  const INF = Number.POSITIVE_INFINITY;
  // cur[j * K + r]: best cost ending at parent j with r extra child bars on it (r + 1 in a row).
  let prev = new Float64Array(m * K).fill(INF), cur = new Float64Array(m * K).fill(INF);
  const back = new Int8Array(n * m * K); // move: 0 stall, 1 diag, 2 jump (the best r of the source is in bestR)
  const bestR = new Int8Array(n * m);     // argmin over r at (i, j)
  const rowBest = new Float64Array(m);
  const mapped = new Float64Array(m);
  for (let j = 0; j < m; j++) mapped[j] = a + b * p[j];
  // Shape: the child's and the parent's trend over the same span of parent time, on the child's scale.
  const cost = (i: number, j: number) => {
    const lv = Math.abs(c[i] - mapped[j]);
    if (!slope) return lv;
    const sc = slope.c[i], sp = slope.p[j];
    return Number.isFinite(sc) && Number.isFinite(sp) ? lv + slope.w * Math.abs(sc - b * sp) : lv;
  };
  const s = Math.max(1, Math.min(m, Math.ceil(slack * m)));
  for (let j = 0; j < s; j++) prev[j * K] = cost(0, j);
  const best = (row: Float64Array, i: number) => {
    for (let j = 0; j < m; j++) {
      let v = INF, br = 0;
      for (let r = 0; r < K; r++) if (row[j * K + r] < v) { v = row[j * K + r]; br = r; }
      rowBest[j] = v; bestR[i * m + j] = br;
    }
  };
  best(prev, 0);
  for (let i = 1; i < n; i++) {
    cur.fill(INF);
    for (let j = 0; j < m; j++) {
      const d = cost(i, j);
      // arrive by advancing (r = 0)
      const v1 = j >= 1 ? rowBest[j - 1] : INF, v2 = j >= 2 ? rowBest[j - 2] : INF;
      if (v1 <= v2 && v1 < INF) { cur[j * K] = v1 + d; back[(i * m + j) * K] = 1; }
      else if (v2 < INF) { cur[j * K] = v2 + d; back[(i * m + j) * K] = 2; }
      // stay (r >= 1)
      for (let r = 1; r < K; r++) {
        const v = prev[j * K + r - 1];
        if (v < INF) { cur[j * K + r] = v + d; back[(i * m + j) * K + r] = 0; }
      }
    }
    best(cur, i);
    const t = prev; prev = cur; cur = t;
  }
  let ej = -1, er = 0, ev = INF;
  for (let j = 0; j < m; j++) for (let r = 0; r < K; r++) if (prev[j * K + r] < ev) { ev = prev[j * K + r]; ej = j; er = r; }
  if (ej < 0) return { path: [], cost: NaN };
  const path = new Array<number>(n);
  let j = ej, r = er;
  for (let i = n - 1; i >= 0; i--) {
    path[i] = j;
    if (i === 0) break;
    const mv = back[(i * m + j) * K + r];
    if (mv === 0) r -= 1;
    else { j -= mv; r = bestR[(i - 1) * m + j]; }
  }
  return { path, cost: ev };
}

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return NaN;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/** Parent bars the trends are measured over. */
const SLOPE_SPAN = 4;
/** Trailing change per parent bar: over `k` bars of a series running `dil` bars per parent bar. */
function trend(x: number[], k: number, dil: number): number[] {
  return x.map((v, i) => (i >= k ? ((v - x[i - k]) / k) * dil : NaN));
}

const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / Math.max(1, x.length);
const sd = (x: number[]) => { const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, x.length - 1)); };

/** Least-squares level map child = a + b x parent on aligned pairs (b kept in [B_MIN, B_MAX]: a child that has
 *  barely moved yet must not flatten the parent into a line every path fits). */
const B_MIN = 0.35, B_MAX = 2.5;
/** Dominance (%) to logit and back, kept off the 0 / 100 walls. */
const logit = (x: number) => { const q = Math.min(0.995, Math.max(0.005, x / 100)); return Math.log(q / (1 - q)); };
const unlogit = (y: number) => 100 / (1 + Math.exp(-y));
function fitMap(c: number[], pAligned: number[]): { a: number; b: number } {
  const mx = mean(pAligned), my = mean(c);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < c.length; i++) { sxy += (pAligned[i] - mx) * (c[i] - my); sxx += (pAligned[i] - mx) ** 2; }
  const b = Math.max(B_MIN, Math.min(B_MAX, sxx > 0 ? sxy / sxx : 1));
  return { a: my - b * mx, b };
}

/** The engine's state from daily BTC.D closes known at `at` (undefined before the child has minChildBars bars,
 *  or without the parent's history). */
export function fractalState(btcdDaily: Candle[], at: number, cfg: FractalConfig = DEFAULT_FRACTAL): FractalState | undefined {
  const parent = barCloses(btcdDaily, cfg.parentFrom, cfg.parentTo, cfg.barMs);
  const child = barCloses(btcdDaily, cfg.childFrom, Infinity, cfg.barMs, at);
  const fullParent = Math.floor((cfg.parentTo - cfg.parentFrom) / cfg.barMs);
  if (parent.length < 0.9 * fullParent || child.length < cfg.minChildBars) return undefined;
  const p = parent.map((x) => x.c), c = child.map((x) => x.c);
  // Initial map: the child's spread on the parent's (z-scores), then refits on the aligned pairs.
  let map = { b: Math.max(B_MIN, Math.min(B_MAX, sd(c) / Math.max(1e-9, sd(p)))), a: 0 };
  map.a = mean(c) - map.b * mean(p);
  // Levels first; then levels and shape, the shape at the dilation the previous pass found, refitting the map.
  let al = align(c, p, map.a, map.b, cfg.maxStall, cfg.startSlack);
  for (let it = 0; it < cfg.iterations && al.path.length; it++) {
    map = fitMap(c, al.path.map((j) => p[j]));
    const dil = Math.max(1, Math.min(cfg.maxStall, c.length / (al.path[c.length - 1] + 1)));
    al = align(c, p, map.a, map.b, cfg.maxStall, cfg.startSlack, { c: trend(c, Math.max(1, Math.round(SLOPE_SPAN * dil)), dil), p: trend(p, SLOPE_SPAN, 1), w: cfg.slopeWeight });
  }
  if (!al.path.length) return undefined;
  const path = al.path, n = c.length, m = p.length;
  const jStar = path[n - 1];
  const pa = path.map((j) => map.a + map.b * p[j]);
  const tail = Math.min(cfg.recentBars, n);
  const r = pearson(c, pa), recentR = pearson(c.slice(-tail), pa.slice(-tail));
  const mae = mean(c.map((v, i) => Math.abs(v - pa[i]))), recentMae = mean(c.slice(-tail).map((v, i) => Math.abs(v - pa[n - tail + i])));
  const L = Math.min(cfg.localBars, n - 1);
  const advance = path[n - 1] - path[n - 1 - L];
  const localDilation = Math.min(cfg.maxStall, L / Math.max(advance, L / cfg.maxStall));
  const dilation = n / (jStar + 1);
  // Parent swings and the one at jStar.
  const sw = swings(p, cfg.swingPts, cfg.waterfallPts);
  let si = sw.findIndex((s) => jStar >= s.from && jStar < s.to);
  if (si < 0) si = sw.length - 1;
  const cs = sw[si];
  // Inside the swing's steep part only when the parent says so AND the child has itself moved 15% of the swing on
  // its own scale since it reached the swing (on a flat base the open end can slide to the first steep week).
  const movedOf = (sw_: Swing) => {
    const i0 = path.findIndex((j) => j >= sw_.from);
    if (i0 < 0) return 0;
    const seg = c.slice(i0);
    return sw_.dir < 0 ? Math.max(...seg) - c[n - 1] : c[n - 1] - Math.min(...seg);
  };
  const isMoving = (sw_: Swing) => jStar >= sw_.move && movedOf(sw_) >= 0.15 * map.b * Math.abs(sw_.toLevel - sw_.fromLevel);
  const inMove = cs ? isMoving(cs) : false;
  const swing = cs
    ? { index: si, count: sw.length, dir: cs.dir, waterfall: cs.waterfall, base: !inMove, frac: inMove ? (jStar - cs.move) / Math.max(1, cs.to - cs.move) : 0, fromTs: parent[cs.move].ts, toTs: parent[cs.to].ts, fromLevel: p[cs.move], toLevel: cs.toLevel }
    : { index: 0, count: 0, dir: 1 as const, waterfall: false, base: false, frac: 0, fromTs: parent[0].ts, toTs: parent[m - 1].ts, fromLevel: p[0], toLevel: p[m - 1] };
  const what = cs ? (cs.waterfall ? 'waterfall' : cs.dir > 0 ? 'dominance rising' : 'dominance falling') : '';
  const phase = !cs ? 'unknown' : inMove ? `${what} (parent swing ${si + 1} of ${sw.length}, ${Math.round(swing.frac * 100)}% through)` : `base before the ${what} (parent swing ${si + 1} of ${sw.length})`;
  // Projection: the parent ahead of jStar on the child's scale, anchored at today's level, at the blended dilation.
  const asOf = child[n - 1].ts, btcd = c[n - 1];
  const projDil = Math.max(0.5, Math.min(cfg.maxStall, Math.sqrt(Math.max(0.5, localDilation) * Math.max(0.5, dilation))));
  // The projection moves in logit space (dominance is a share in 0-100%): today's level plus the parent's moves
  // ahead, scaled by a level map refitted on the aligned pairs in logit space. A raw-point map pinned at B_MAX
  // (TradingView's 2016 BTC.D sits near 99%, which squeezes the parent's range) once projected BTC.D to -21%.
  const lmap = fitMap(c.map(logit), path.map((j) => logit(p[j])));
  const lvlAt = (j: number) => unlogit(logit(btcd) + lmap.b * (logit(p[j]) - logit(p[jStar])));
  // Child time of each parent bar ahead: a parent bar inside a waterfall's steep part takes its share of
  // waterfallDays, every other bar projDil bars (a waterfall already under way keeps only what is left of it).
  const stepMs = (j: number) => {
    const w = cfg.waterfallDays > 0 ? sw.find((s_) => s_.waterfall && j >= s_.move && j < s_.to) : undefined;
    return w ? (cfg.waterfallDays * DAY) / Math.max(1, w.to - w.move) : cfg.barMs * projDil;
  };
  const tsOf: number[] = new Array(m).fill(NaN);
  tsOf[jStar] = asOf;
  for (let j = jStar + 1; j < m; j++) tsOf[j] = tsOf[j - 1] + stepMs(j - 1);
  const projection: FractalProjectionPoint[] = [];
  for (let k = 1; jStar + k < m; k++) projection.push({ ts: tsOf[jStar + k], btcd: lvlAt(jStar + k), parentTs: parent[jStar + k].ts });
  const at_ = (days: number) => {
    const ts = asOf + days * DAY;
    if (!projection.length || ts > projection[projection.length - 1].ts) return NaN;
    let x0 = asOf, y0 = btcd;
    for (const q of projection) { if (q.ts >= ts) return y0 + ((q.btcd - y0) * (ts - x0)) / (q.ts - x0); x0 = q.ts; y0 = q.btcd; }
    return NaN;
  };
  const toChild = (j: number) => tsOf[Math.max(j, jStar)];
  const lvl = lvlAt;
  const wf = sw.find((s) => s.waterfall && s.to > jStar);
  const wfIn = !!wf && wf === cs && inMove;
  const nextWaterfall = wf
    ? { startTs: toChild(Math.max(wf.move, jStar)), endTs: toChild(wf.to), fromBtcd: lvl(Math.max(wf.move, jStar)), toBtcd: lvl(wf.to), weeksAway: Math.max(0, (toChild(wf.move) - asOf) / (7 * DAY)), inside: wfIn }
    : undefined;
  let low: FractalState['low'];
  for (const q of projection) if (!low || q.btcd < low.btcd) low = { ts: q.ts, btcd: q.btcd };
  return {
    asOf, childBars: n, parentTs: parent[jStar].ts, progress: jStar / Math.max(1, m - 1), swing, phase,
    dilation, localDilation, map, projMap: lmap, fit: { r, recentR, maePts: mae, recentMaePts: recentMae }, btcd,
    projection, proj: { d30: at_(30), d90: at_(90), d180: at_(180) }, nextWaterfall, low,
    path: child.map((x, i) => ({ childTs: x.ts, parentTs: parent[path[i]].ts, btcd: c[i], mapped: pa[i] })),
  };
}

/** The first projected date the level crosses `level` going down (undefined if the projection never does). */
export function projectedCross(s: FractalState, level: number): number | undefined {
  if (s.btcd <= level) return s.asOf;
  let x0 = s.asOf, y0 = s.btcd;
  for (const q of s.projection) {
    if (q.btcd <= level) return x0 + ((y0 - level) / (y0 - q.btcd)) * (q.ts - x0);
    x0 = q.ts; y0 = q.btcd;
  }
  return undefined;
}

/** States by child bar, computed once per bar (research: point-in-time features for every setup). */
export class FractalCache {
  private readonly byBar = new Map<number, FractalState | null>();
  constructor(private readonly btcdDaily: Candle[], readonly cfg: FractalConfig = DEFAULT_FRACTAL) {}
  at(ts: number): FractalState | undefined {
    if (ts < this.cfg.childFrom) return undefined;
    const k = Math.floor((ts - this.cfg.childFrom) / this.cfg.barMs);
    let s = this.byBar.get(k);
    if (s === undefined) { s = fractalState(this.btcdDaily, this.cfg.childFrom + k * this.cfg.barMs, this.cfg) ?? null; this.byBar.set(k, s); }
    return s ?? undefined;
  }
}

// Confluence logbook: which signals were active TOGETHER and what price did next. Nothing is generated in
// advance: the rule-book walk (research/ruleBook.ts) records, at every step of years of hourly history, the set
// of rules, rule-book patterns and confluences active at that moment (each with its direction); this module
// logs every pair that was actually seen together pointing the same way, with what followed.
//
//   observed     every pair of co-active signals agreeing in direction (also the same rule on two timeframes,
//                such as a 1h and a 4h trend), as a trade in that direction held H hours after costs
//   logbook      per pair and horizon: how often it happened, hit rate, expectancy (bps), and the same on the
//                later years (confirmation), plus its lift: how much better the pair did than the better of its
//                two signals alone in the same period
//   pass         discovery: n >= minN, mean > 0, lift > 0, Benjamini-Hochberg pass at q over every pair tested
//                (overlap-adjusted t-test; pairs are their own family of tests, apart from the single rules);
//                confirmation: n >= minConf, mean > 0, hit rate >= 50 %, lift > 0 (the pair kept adding to its
//                parts on years the discovery never saw)
//   bracket      for a passing pair, a small take-profit / stop-loss grid on the hourly highs and lows (the
//                perps side: Kalshi contracts settle at expiry), best by discovery, with its confirmation
//
// Passing pairs join the live rule-book reading (bot/strategy/ruleBook.ts); the logbook keeps the most frequent
// pairs whether they passed or not, so what tends to happen together can be read in rule_book.json.

import type { Candle } from '../bot/ta/indicators';
import type { Bracket, ComboRow } from '../bot/strategy/ruleBook';
export type { Bracket, ComboRow };
import { normCdf } from '../bot/util/num';

/** One walk step: the asset, its bar, the time, the raw log return over each horizon, the signed active signals. */
export interface Step { asset: number; i: number; t: number; fwd: number[]; active: Int32Array }
export interface ComboOptions { horizons: number[]; splitAt: number; stride: number; minN?: number; minConf?: number; fdr?: number; maxLog?: number; costBps?: number }

/** Signed signal id: (index + 1) x direction. */
export const signed = (keyIndex: number, dir: number) => (keyIndex + 1) * (dir > 0 ? 1 : -1);

// Accumulator layout per (key or pair): [horizon][period: 0 discovery, 1 confirmation][n, sum, sum of squares, wins]
const accIndex = (h: number, period: number, f: number) => (h * 2 + period) * 4 + f;
function acc(store: Map<number, Float64Array>, key: number, size: number): Float64Array {
  let a = store.get(key);
  if (!a) store.set(key, (a = new Float64Array(size)));
  return a;
}
function add(a: Float64Array, h: number, period: number, r: number): void {
  a[accIndex(h, period, 0)]++; a[accIndex(h, period, 1)] += r; a[accIndex(h, period, 2)] += r * r; if (r > 0) a[accIndex(h, period, 3)]++;
}
const stat = (a: Float64Array | undefined, h: number, period: number) => {
  if (!a) return { n: 0, mean: NaN, sd: NaN, hit: NaN };
  const n = a[accIndex(h, period, 0)], s = a[accIndex(h, period, 1)], ss = a[accIndex(h, period, 2)];
  const mean = n ? s / n : NaN;
  return { n, mean, sd: n > 1 ? Math.sqrt(Math.max(0, (ss - n * mean * mean) / (n - 1))) : NaN, hit: n ? a[accIndex(h, period, 3)] / n : NaN };
};

/** Benjamini-Hochberg: which of these p-values pass at false-discovery rate q. */
export function bh(ps: number[], q: number): boolean[] {
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  let k = -1;
  order.forEach(([p], j) => { if (p <= ((j + 1) / order.length) * q) k = j; });
  const out = ps.map(() => false);
  for (let j = 0; j <= k; j++) out[order[j][1]] = true;
  return out;
}

/** Every pair of co-active, same-direction signals seen in the steps, with its statistics and verdict. */
export function studyCombos(steps: Step[], keys: string[], o: ComboOptions): ComboRow[] {
  const H = o.horizons.length, size = H * 2 * 4;
  const minN = o.minN ?? 50, minConf = o.minConf ?? 20, q = o.fdr ?? 0.1, cost = (o.costBps ?? 10) / 1e4;
  const singles = new Map<number, Float64Array>(), pairs = new Map<number, Float64Array>();
  const K = keys.length + 1;
  for (const s of steps) {
    const period = s.t < o.splitAt ? 0 : 1;
    const act = s.active;
    for (let x = 0; x < act.length; x++) {
      const a = acc(singles, Math.abs(act[x]), size);
      const dx = Math.sign(act[x]);
      for (let h = 0; h < H; h++) add(a, h, period, dx * s.fwd[h] - cost);
      for (let y = x + 1; y < act.length; y++) {
        if (Math.sign(act[y]) !== dx) continue;
        const lo = Math.min(Math.abs(act[x]), Math.abs(act[y])), hi = Math.max(Math.abs(act[x]), Math.abs(act[y]));
        if (lo === hi) continue;
        const p = acc(pairs, lo * K + hi, size);
        for (let h = 0; h < H; h++) add(p, h, period, dx * s.fwd[h] - cost);
      }
    }
  }
  const rows: ComboRow[] = [];
  const stats: Float64Array[] = [];
  for (const [key, a] of pairs) {
    const lo = Math.floor(key / K), hi = key % K;
    for (let h = 0; h < H; h++) {
      const d = stat(a, h, 0), c = stat(a, h, 1);
      if (d.n < minN) continue;
      const overlap = Math.max(1, o.horizons[h] / o.stride);
      const t = d.sd > 0 ? (d.mean / d.sd) * Math.sqrt(d.n / overlap) : 0;
      const best = (period: number) => Math.max(stat(singles.get(lo), h, period).mean, stat(singles.get(hi), h, period).mean);
      rows.push({
        parts: [keys[lo - 1], keys[hi - 1]], h: o.horizons[h],
        n: d.n, hit: d.hit, expBps: d.mean * 1e4, liftBps: (d.mean - best(0)) * 1e4, p: 1 - normCdf(t), fdr: false,
        nConf: c.n, hitConf: c.hit, expConfBps: c.mean * 1e4, liftConfBps: c.n ? (c.mean - best(1)) * 1e4 : NaN,
        pass: false, weight: 0,
      });
      stats.push(a);
    }
  }
  const fdr = bh(rows.map((r) => r.p), q);
  rows.forEach((r, i) => {
    r.fdr = fdr[i];
    r.pass = r.fdr && r.expBps > 0 && r.liftBps > 0 && r.nConf >= minConf && r.expConfBps > 0 && r.hitConf >= 0.5 && r.liftConfBps > 0;
    if (r.pass) {
      const a = stats[i];
      const h = o.horizons.indexOf(r.h), overlap = Math.max(1, r.h / o.stride);
      const tstat = (period: number) => { const s = stat(a, h, period); return s.sd > 0 ? (s.mean / s.sd) * Math.sqrt(s.n / overlap) : 0; };
      r.weight = +Math.max(0, Math.min(1, 0.5 * (tstat(0) / 3) + 0.5 * (tstat(1) / 2))).toFixed(3);
    }
  });
  const round = (r: ComboRow): ComboRow => ({ ...r, hit: +r.hit.toFixed(4), expBps: +r.expBps.toFixed(2), liftBps: +r.liftBps.toFixed(2), p: +r.p.toFixed(5), hitConf: +r.hitConf.toFixed(4), expConfBps: +r.expConfBps.toFixed(2), liftConfBps: +r.liftConfBps.toFixed(2) });
  return rows.sort((a, b) => Number(b.pass) - Number(a.pass) || b.weight - a.weight || b.n - a.n).slice(0, o.maxLog ?? 1500).map(round);
}

/** One bracket trade on hourly bars from the close of bar i: the stop is checked before the target in a bar that
 *  touches both (the cautious reading); unhit after maxH bars, it exits at the close. Return net of cost. */
export function bracketReturn(h1: Candle[], i: number, dir: number, tp: number, sl: number, maxH: number, cost: number): number {
  const entry = h1[i].c;
  for (let j = i + 1; j <= Math.min(h1.length - 1, i + maxH); j++) {
    const b = h1[j];
    if (dir > 0) { if (b.l <= entry * (1 - sl)) return -sl - cost; if (b.h >= entry * (1 + tp)) return tp - cost; }
    else { if (b.h >= entry * (1 + sl)) return -sl - cost; if (b.l <= entry * (1 - tp)) return tp - cost; }
  }
  const last = h1[Math.min(h1.length - 1, i + maxH)];
  return dir * (last.c / entry - 1) - cost;
}

export const TPS = [0.01, 0.02, 0.04], SLS = [0.005, 0.01, 0.02];

/** The best take-profit / stop-loss pair for a passing combination (by discovery), with its confirmation. */
export function bestBracket(steps: Step[], keys: string[], parts: [string, string], h1s: Candle[][], o: { splitAt: number; costBps?: number; maxH?: number }): Bracket | undefined {
  const a = keys.indexOf(parts[0]) + 1, b = keys.indexOf(parts[1]) + 1;
  const hits = steps.flatMap((s) => {
    const x = s.active.find((v) => Math.abs(v) === a), y = s.active.find((v) => Math.abs(v) === b);
    return x !== undefined && y !== undefined && Math.sign(x) === Math.sign(y) ? [{ s, dir: Math.sign(x) }] : [];
  });
  if (hits.length < 20) return undefined;
  const cost = (o.costBps ?? 10) / 1e4, maxH = o.maxH ?? 48;
  let best: Bracket | undefined;
  for (const tp of TPS) for (const sl of SLS) {
    const d: number[] = [], c: number[] = [];
    for (const { s, dir } of hits) (s.t < o.splitAt ? d : c).push(bracketReturn(h1s[s.asset], s.i, dir, tp, sl, maxH, cost));
    if (!d.length) continue;
    const m = (xs: number[]) => xs.reduce((u, v) => u + v, 0) / Math.max(1, xs.length);
    const br: Bracket = { tp, sl, expBps: +(m(d) * 1e4).toFixed(2), expConfBps: +(m(c) * 1e4).toFixed(2), hitConf: c.length ? +(c.filter((x) => x > 0).length / c.length).toFixed(4) : NaN, n: d.length, nConf: c.length, ok: false };
    if (!best || br.expBps > best.expBps) best = br;
  }
  if (best) best.ok = best.expBps > 0 && best.nConf >= 10 && best.expConfBps > 0;
  return best;
}

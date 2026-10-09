// What invalidates a TA call: for every signal the rule-book walk saw (research/ruleBook.ts), what happened to its
// call when other signals were active at the same time, compared with the times they were not. Nothing is chosen
// in advance: every signal seen alongside it is tested, pointing the same way or the other way.
//
//   by one signal     A with B present vs A without B (B pointing with A or against it), for every B seen with A
//   by several        A with 1, 2 or 3+ other signals pointing against it (or with it) vs A with fewer
//   test              A's trade in its own direction after costs; Welch two-sample t (overlap-adjusted) of the
//                     occurrences with the addition against those without; Benjamini-Hochberg at q over every
//                     test (one family)
//   invalidates       with the addition A's call lost money (mean < 0) and did worse than without it, on the
//                     discovery years AND the later years: the addition turned what A said would happen around
//
// Live (bot/strategy/ruleBook.ts): a signal whose passing invalidator is present now is silenced. The log
// (`invalidations` in rule_book.json) keeps the most notable rows whether they passed or not.

import type { InvalidationRow } from '../bot/strategy/ruleBook';
import { normCdf } from '../bot/util/num';
import { bh, type Step } from './confluenceBook';
export type { InvalidationRow };

export interface InvalidationOptions { horizons: number[]; splitAt: number; stride: number; costBps?: number; minN?: number; minConf?: number; fdr?: number; maxLog?: number }

/** The count thresholds for 'several signals' rows: 1, 2 and 3 or more. */
export const COUNTS = [1, 2, 3];
/** The `by` of a count row: 'against>=2' = two or more other signals pointing against A. */
export const countBy = (rel: 'with' | 'against', c: number) => `${rel}>=${c}`;

// Accumulators: [horizon][period: 0 discovery, 1 confirmation][n, sum, sum of squares, wins]
const F = 4;
const at = (h: number, p: number, f: number) => (h * 2 + p) * F + f;
function add(a: Float64Array, h: number, p: number, r: number): void { a[at(h, p, 0)]++; a[at(h, p, 1)] += r; a[at(h, p, 2)] += r * r; if (r > 0) a[at(h, p, 3)]++; }
const mom = (n: number, s: number, ss: number, w: number) => { const m = n ? s / n : NaN; return { n, m, sd: n > 1 ? Math.sqrt(Math.max(0, (ss - n * m * m) / (n - 1))) : NaN, hit: n ? w / n : NaN }; };
type Mom = ReturnType<typeof mom>;
const part = (a: Float64Array, h: number, p: number): Mom => mom(a[at(h, p, 0)], a[at(h, p, 1)], a[at(h, p, 2)], a[at(h, p, 3)]);
const rest = (tot: Float64Array, a: Float64Array, h: number, p: number): Mom => mom(...([0, 1, 2, 3].map((f) => tot[at(h, p, f)] - a[at(h, p, f)]) as [number, number, number, number]));

export function studyInvalidations(steps: Step[], keys: string[], o: InvalidationOptions): InvalidationRow[] {
  const H = o.horizons.length, size = H * 2 * F, K = keys.length + 1;
  const cost = (o.costBps ?? 10) / 1e4, minN = o.minN ?? 40, minConf = o.minConf ?? 15, q = o.fdr ?? 0.1;
  const totals = new Map<number, Float64Array>();
  // By one signal: ((a * K + b) * 2 + rel); by several: a * 8 + rel * 4 + c. rel 1 = against.
  const byOne = new Map<number, Float64Array>(), bySeveral = new Map<number, Float64Array>();
  const get = (m: Map<number, Float64Array>, k: number) => { let a = m.get(k); if (!a) m.set(k, (a = new Float64Array(size))); return a; };
  for (const s of steps) {
    const p = s.t < o.splitAt ? 0 : 1, act = s.active;
    for (let x = 0; x < act.length; x++) {
      const a = Math.abs(act[x]), dir = Math.sign(act[x]);
      const r = o.horizons.map((_, h) => dir * s.fwd[h] - cost);
      const tot = get(totals, a);
      for (let h = 0; h < H; h++) add(tot, h, p, r[h]);
      let against = 0, withA = 0;
      for (let y = 0; y < act.length; y++) {
        const b = Math.abs(act[y]);
        if (y === x || b === a) continue;
        const rel = Math.sign(act[y]) === dir ? 0 : 1;
        if (rel) against++; else withA++;
        const acc = get(byOne, (a * K + b) * 2 + rel);
        for (let h = 0; h < H; h++) add(acc, h, p, r[h]);
      }
      for (const [rel, n] of [[0, withA], [1, against]] as const) for (let c = 1; c <= COUNTS.length; c++) if (n >= COUNTS[c - 1]) {
        const acc = get(bySeveral, a * 8 + rel * 4 + c);
        for (let h = 0; h < H; h++) add(acc, h, p, r[h]);
      }
    }
  }
  const rows: InvalidationRow[] = [];
  const strength: number[] = [];
  const test = (a: number, by: string, rel: 'with' | 'against', acc: Float64Array) => {
    const tot = totals.get(a)!;
    for (let h = 0; h < H; h++) {
      const d = part(acc, h, 0), c = part(acc, h, 1), dOut = rest(tot, acc, h, 0), cOut = rest(tot, acc, h, 1);
      if (d.n < minN || dOut.n < minN) continue;
      const overlap = Math.max(1, o.horizons[h] / o.stride);
      const welch = (u: Mom, v: Mom) => { const se = Math.sqrt((overlap * u.sd ** 2) / u.n + (overlap * v.sd ** 2) / v.n); return se > 0 ? (u.m - v.m) / se : 0; };
      const t = welch(d, dOut), tc = c.n > 1 && cOut.n > 1 ? welch(c, cOut) : 0;
      rows.push({
        key: keys[a - 1], by, rel, h: o.horizons[h],
        n: d.n, hit: d.hit, expBps: d.m * 1e4, aloneBps: dOut.m * 1e4, p: normCdf(t), fdr: false,
        nConf: c.n, hitConf: c.hit, expConfBps: c.m * 1e4, aloneConfBps: cOut.m * 1e4, pass: false, weight: 0,
      });
      // Strength as for the rules: the t-statistic towards invalidation on both periods (3 and 2 = full).
      strength.push(Math.max(0, Math.min(1, 0.5 * (Math.max(0, -t) / 3) + 0.5 * (Math.max(0, -tc) / 2))));
    }
  };
  for (const [k, acc] of byOne) { const rel = k & 1 ? 'against' : 'with', ab = k >> 1; test(Math.floor(ab / K), keys[(ab % K) - 1], rel, acc); }
  for (const [k, acc] of bySeveral) { const rel = (k >> 2) & 1 ? 'against' : 'with'; test(k >> 3, countBy(rel, COUNTS[(k & 3) - 1]), rel, acc); }
  const fdr = bh(rows.map((r) => r.p), q);
  rows.forEach((r, i) => {
    r.fdr = fdr[i];
    r.pass = r.fdr && r.expBps < 0 && r.expBps < r.aloneBps && r.nConf >= minConf && r.expConfBps < 0 && r.expConfBps < r.aloneConfBps;
    if (r.pass) r.weight = +strength[i].toFixed(3);
  });
  const fix = (x: number, d: number) => (Number.isFinite(x) ? +x.toFixed(d) : x);
  // The log: passing rows first, then the rest that leaned towards invalidation, by p-value.
  return rows.filter((r) => r.pass || r.expBps < r.aloneBps)
    .sort((a, b) => Number(b.pass) - Number(a.pass) || a.p - b.p).slice(0, o.maxLog ?? 2000)
    .map((r) => ({ ...r, hit: fix(r.hit, 4), expBps: fix(r.expBps, 2), aloneBps: fix(r.aloneBps, 2), p: fix(r.p, 6), hitConf: fix(r.hitConf, 4), expConfBps: fix(r.expConfBps, 2), aloneConfBps: fix(r.aloneConfBps, 2) }));
}

/** An invalidation in words: "rule|rsi_extreme|1h is invalidated 4h by book|double_top|1h pointing against it". */
export function invalidationText(r: InvalidationRow): string {
  const m = /^(with|against)>=(\d+)$/.exec(r.by);
  const by = m ? `${m[2]} or more other signals pointing ${m[1] === 'with' ? 'the same way' : 'against it'}` : `${r.by} pointing ${r.rel === 'with' ? 'the same way' : 'against it'}`;
  return `${r.key} is invalidated ${r.h}h by ${by}`;
}

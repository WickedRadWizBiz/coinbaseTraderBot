// What makes or breaks each TA rule: the rule-book walk notes the context of every step (bot/strategy/
// ruleContext.ts: RSI, ADX, volatility and Bollinger-width percentiles, volume, the last 20 hours' move, money
// flow, the 4h and daily trend, the 200-day average, the hour, the weekend), and this module splits every rule's
// occurrences by each parameter, as seen by the signal (directional parameters flipped for bearish signals).
//
//   buckets    thirds of the parameter's values on the discovery years (by value when it has three or fewer,
//              such as the weekend flag); the same cut points on the later years
//   makes      the rule in that range: mean > 0 and above the rule's own mean, on the discovery years AND the
//              later years (the condition under which the rule works)
//   breaks     mean < 0 and below the rule's own mean on both periods (the condition under which it fails)
//   test       the bucket against the rule's other occurrences (Welch two-sample t, overlap-adjusted), so a
//              range of a rule that loses anyway is not called a breaker for losing like the rest; Benjamini-
//              Hochberg at q over every rule x horizon x parameter x bucket tested (one family)
//
// Live (bot/strategy/ruleBook.ts): a passing 'breaks' condition that holds now silences the signal; a passing
// 'makes' condition lets a rule that did not pass on its own count while the condition holds.

import { CONTEXT_PARAMS, oriented } from '../bot/strategy/ruleContext';
import type { ConditionRow } from '../bot/strategy/ruleBook';
import { normCdf } from '../bot/util/num';
import { bh, type Step } from './confluenceBook';
export type { ConditionRow };

export interface ConditionOptions { horizons: number[]; splitAt: number; stride: number; costBps?: number; minBucket?: number; minConfBucket?: number; fdr?: number; maxLog?: number }

const moments = (xs: number[]) => {
  const n = xs.length, m = n ? xs.reduce((a, b) => a + b, 0) / n : NaN;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) : NaN;
  return { n, m, sd, hit: n ? xs.filter((x) => x > 0).length / n : NaN };
};

/** Cut points: thirds of the values, or each distinct value when there are three or fewer. */
export function buckets(values: number[]): Array<[number | null, number | null]> {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < 3) return [];
  const distinct = [...new Set(v)];
  if (distinct.length <= 3) return distinct.map((x, i) => [i === 0 ? null : x, i === distinct.length - 1 ? null : distinct[i + 1]] as [number | null, number | null]);
  const q1 = v[Math.floor(v.length / 3)], q2 = v[Math.floor((2 * v.length) / 3)];
  return q1 === q2 ? [[null, q1], [q1, null]] : [[null, q1], [q1, q2], [q2, null]];
}
export const inBucket = (x: number, lo: number | null, hi: number | null) => Number.isFinite(x) && (lo === null || x >= lo) && (hi === null || x < hi);

export function studyConditions(steps: Step[], keys: string[], o: ConditionOptions): ConditionRow[] {
  const cost = (o.costBps ?? 10) / 1e4, minBucket = o.minBucket ?? 40, minConf = o.minConfBucket ?? 15, q = o.fdr ?? 0.1;
  // Every occurrence of every signal: (step, direction).
  const occ = new Map<number, number[]>();
  steps.forEach((s, si) => { if (!s.ctx) return; for (const a of s.active) { const k = Math.abs(a) - 1; let l = occ.get(k); if (!l) occ.set(k, (l = [])); l.push(si * 2 + (a > 0 ? 1 : 0)); } });
  const rows: ConditionRow[] = [];
  const strength: number[] = [];
  for (const [k, list] of occ) {
    if (list.length < 3 * minBucket) continue;
    const n = list.length, disc = new Uint8Array(n), vals = CONTEXT_PARAMS.map(() => new Float64Array(n));
    list.forEach((code, j) => {
      const s = steps[code >> 1], dir = code & 1 ? 1 : -1;
      disc[j] = s.t < o.splitAt ? 1 : 0;
      CONTEXT_PARAMS.forEach((_, pi) => { vals[pi][j] = oriented(s.ctx!, pi, dir); });
    });
    const cuts = vals.map((v) => buckets(Array.from(v).filter((_, j) => disc[j])));
    for (const [hi_, h] of o.horizons.entries()) {
      const overlap = Math.max(1, h / o.stride);
      const r = Float64Array.from(list, (code) => (code & 1 ? 1 : -1) * steps[code >> 1].fwd[hi_] - cost);
      const all = [Array.from(r).filter((_, j) => !disc[j]), Array.from(r).filter((_, j) => disc[j])];
      const base = moments(all[1]), baseConf = moments(all[0]);
      if (base.n < 3 * minBucket) continue;
      // Sums over a period, for the bucket and (by difference) the rest: [n, sum, sum of squares, wins].
      const tot = [0, 1].map((dp) => { const a = [0, 0, 0, 0]; for (const x of all[dp]) { a[0]++; a[1] += x; a[2] += x * x; if (x > 0) a[3]++; } return a; });
      const mom = (a: number[]) => { const m = a[0] ? a[1] / a[0] : NaN; return { n: a[0], m, sd: a[0] > 1 ? Math.sqrt(Math.max(0, (a[2] - a[0] * m * m) / (a[0] - 1))) : NaN, hit: a[0] ? a[3] / a[0] : NaN }; };
      // Welch t of the bucket against the rest, each variance inflated by the horizon's overlap.
      const welch = (a: ReturnType<typeof mom>, b: ReturnType<typeof mom>) => { const se = Math.sqrt((overlap * a.sd ** 2) / a.n + (overlap * b.sd ** 2) / b.n); return se > 0 ? (a.m - b.m) / se : 0; };
      for (const [pi, p] of CONTEXT_PARAMS.entries()) {
        const v = vals[pi];
        for (const [lo, hi] of cuts[pi]) {
          const acc = [[0, 0, 0, 0], [0, 0, 0, 0]];
          for (let j = 0; j < n; j++) if (inBucket(v[j], lo, hi)) { const a = acc[disc[j]], x = r[j]; a[0]++; a[1] += x; a[2] += x * x; if (x > 0) a[3]++; }
          const rest = (dp: number) => tot[dp].map((x, f) => x - acc[dp][f]);
          const d = mom(acc[1]), c = mom(acc[0]), dOut = mom(rest(1)), cOut = mom(rest(0));
          if (d.n < minBucket || dOut.n < minBucket) continue;
          const t = welch(d, dOut);
          const effect: ConditionRow['effect'] = t >= 0 ? 'makes' : 'breaks';
          rows.push({
            key: keys[k], h, param: p.name, lo, hi, effect,
            n: d.n, hit: d.hit, expBps: d.m * 1e4, baseBps: base.m * 1e4, p: effect === 'makes' ? 1 - normCdf(t) : normCdf(t), fdr: false,
            nConf: c.n, hitConf: c.hit, expConfBps: c.m * 1e4, baseConfBps: baseConf.m * 1e4, pass: false, weight: 0,
          });
          // Weight as for the rules: the t-statistic on both periods in the effect's direction (3 on discovery, 2 later
          // = full weight).
          const tc = c.n > 1 && cOut.n > 1 ? welch(c, cOut) : 0;
          strength.push(Math.max(0, Math.min(1, 0.5 * (Math.abs(t) / 3) + 0.5 * (Math.max(0, Math.sign(t) * tc) / 2))));
        }
      }
    }
  }
  const fdr = bh(rows.map((r) => r.p), q);
  rows.forEach((r, i) => {
    r.fdr = fdr[i];
    const later = r.nConf >= minConf && Number.isFinite(r.expConfBps);
    r.pass = r.fdr && later && (r.effect === 'makes'
      ? r.expBps > 0 && r.expBps > r.baseBps && r.expConfBps > 0 && r.expConfBps > r.baseConfBps && r.hitConf >= 0.5
      : r.expBps < 0 && r.expBps < r.baseBps && r.expConfBps < 0 && r.expConfBps < r.baseConfBps);
    if (r.pass) r.weight = +strength[i].toFixed(3);
  });
  const fix = (x: number, d: number) => (Number.isFinite(x) ? +x.toFixed(d) : x);
  return rows.sort((a, b) => Number(b.pass) - Number(a.pass) || a.p - b.p).slice(0, o.maxLog ?? 2000)
    .map((r) => ({ ...r, lo: r.lo === null ? null : fix(r.lo, 4), hi: r.hi === null ? null : fix(r.hi, 4), hit: fix(r.hit, 4), expBps: fix(r.expBps, 2), baseBps: fix(r.baseBps, 2), p: fix(r.p, 6), hitConf: fix(r.hitConf, 4), expConfBps: fix(r.expConfBps, 2), baseConfBps: fix(r.baseConfBps, 2) }));
}

/** A condition in words: "rule|rsi_extreme|1h makes it when RSI (1h), towards the signal is below 12.5". */
export function conditionText(c: ConditionRow): string {
  const label = CONTEXT_PARAMS.find((p) => p.name === c.param)?.label ?? c.param;
  const range = c.lo === null ? `below ${c.hi}` : c.hi === null ? `at or above ${c.lo}` : `${c.lo} to ${c.hi}`;
  return `${c.key} ${c.effect === 'makes' ? 'works' : 'fails'} ${c.h}h when ${label} is ${range}`;
}

// Genetic evolution on top of the tournaments (research/pbt.ts).
//
//   selection   every round the usual candidate selection goes on (the elite survives, the worst clone the
//               best, the rest mutate a little).
//   breeding    every few rounds (a generation) the best survivors over the generation -- by their mean
//               fitness across its rounds, the tournament's winners -- are parents (default 3), and every
//               pair of them has ONE offspring:
//                 genes     every knob from one parent or the other (the fitter parent slightly favoured,
//                           and the parent whose value sits where the best networks' values have sat
//                           favoured more, by the trait memory below), blended a little with the other
//                           parent's value, then mutated very slightly (about +/-3%);
//                 learning  what the network learned comes along too: the SNNs take each column (one
//                           asset and horizon: a strategy of its own) from the parent whose column made
//                           more over the generation, the rest of the network from the fitter parent.
//   next        the offspring take the slots of the worst over the generation (never the round's elite);
//               the champion parents and the best runners-up carry on into the next generation.
//   traits      every evaluation of every network feeds a trait memory: per knob, where the values of the
//               networks that ranked in the top quarter of their round lie, and how strongly the knob
//               relates to rank. Crossover leans on it, so knob values that keep winning are passed down.
//   islands     optional: the population split into separate tournaments run side by side, whose winners
//               are the parents, the next islands dealt from the champions, offspring and runners-up. On
//               noisy scores (as tournament days are) islands converged more slowly than one population,
//               so they are off by default (docs/EVOLUTION.md has the measurements).
//
// Pure functions here; runPbt drives them.

import type { Hyper, MutationSpec } from '../bot/util/fitness';

/** Per-knob trait: where the top-quarter networks' values lie (log scale for positive knobs), how strongly
 *  the knob relates to rank (Spearman), and how much crossover trusts it (0..1). */
export interface GeneTrait { center: number; best: number; rho: number; conf: number; n: number }
export interface GeneSample { g: Hyper; f: number }

export interface GaGeneration {
  generation: number; round: number;
  champions: Array<{ member: number; island: number; fitness: number; offspring: boolean }>;
  offspring: Array<{ member: number; parents: [number, number]; island: number }>;
  runnersUp: number[];
  /** Champions that were offspring of the previous breeding: crossover producing winners. */
  offspringChampions: number;
}

/** What the genetic layer keeps between rounds and runs. */
export interface GaState {
  /** Breeding events so far. */
  generation: number;
  /** Round index of the last breeding (-1 before the first). */
  lastBreed: number;
  /** Trait memory: recent evaluations (knobs on the trait scale, rank within their round: 1 = best). */
  genes: GeneSample[];
  history: GaGeneration[];
  /** Generations since an offspring last won its island. */
  sinceOffspringWon: number;
}

export const GENE_WINDOW = 2000;

export function newGaState(): GaState { return { generation: 0, lastBreed: -1, genes: [], history: [], sinceOffspringWon: 0 }; }

const logScale = (s: { min: number }) => s.min > 0;
const clip = (v: number, s: { min: number; max: number; integer?: boolean }) => { const x = Math.min(s.max, Math.max(s.min, v)); return s.integer ? Math.round(x) : x; };

/** A knob on its trait scale (log for positive knobs). */
export function geneScale(spec: MutationSpec, h: Hyper): Hyper {
  const out: Hyper = {};
  for (const [k, s] of Object.entries(spec)) if (Number.isFinite(h[k])) out[k] = logScale(s) ? Math.log(Math.max(h[k], 1e-300)) : h[k];
  return out;
}

/** Standard normal draw. */
export function gauss(r: () => number): number { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

/** Spearman rank correlation. */
export function spearman(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const ranks = (a: number[]) => {
    const idx = a.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(n);
    for (let i = 0; i < n;) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2; i = j + 1; }
    return r;
  };
  const rx = ranks(x), ry = ranks(y);
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** Ranks within one round as 0..1 (1 = the best fitness). */
export function roundRanks(fitness: number[]): number[] {
  const n = fitness.length;
  if (n < 2) return fitness.map(() => 0.5);
  const order = fitness.map((f, i) => [f, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(n);
  order.forEach(([, i], k) => { out[i] = k / (n - 1); });
  return out;
}

/** The trait memory read out: per knob, the top quarter's centre and how far crossover should trust it.
 *  Confidence grows with the rank correlation's t-statistic (none below |t| = 3, full from 8: networks
 *  descended from one another are not independent samples, so the bar is high). */
export function geneTraits(samples: GeneSample[], spec: MutationSpec): Record<string, GeneTrait> {
  const out: Record<string, GeneTrait> = {};
  for (const [k, s] of Object.entries(spec)) {
    const xs: number[] = [], ys: number[] = [];
    for (const smp of samples) if (Number.isFinite(smp.g[k]) && Number.isFinite(smp.f)) { xs.push(smp.g[k]); ys.push(smp.f); }
    const n = xs.length;
    if (n < 8) continue;
    const rho = spearman(xs, ys);
    const t = Math.abs(rho) * Math.sqrt((n - 2) / Math.max(1e-9, 1 - rho * rho));
    const top = xs.filter((_, i) => ys[i] >= 0.75);
    const center = (top.length ? top : xs).reduce((a, b) => a + b, 0) / (top.length || n);
    out[k] = { center, best: logScale(s) ? Math.exp(center) : center, rho, conf: Math.min(1, Math.max(0, (t - 3) / 5)), n };
  }
  return out;
}

/** One offspring's knobs from two parents (`a` the fitter): each knob mostly from one parent -- the fitter
 *  one slightly favoured, the one nearer the trait memory's winning region favoured more -- blended a
 *  little with the other's, then mutated very slightly (log-normal, `mutation` = its sd: 0.03 ~ +/-3%). */
export function crossoverGenes(a: Hyper, b: Hyper, spec: MutationSpec, r: () => number, o: { traits?: Record<string, GeneTrait>; mutation?: number; tilt?: number } = {}): Hyper {
  const out: Hyper = { ...a };
  const sd = o.mutation ?? 0.03;
  for (const [k, s] of Object.entries(spec)) {
    if (!Number.isFinite(a[k]) || !Number.isFinite(b[k])) continue;
    const ls = logScale(s);
    const xa = ls ? Math.log(a[k]) : a[k], xb = ls ? Math.log(b[k]) : b[k];
    let pA = 0.5 + (o.tilt ?? 0.1);
    const t = o.traits?.[k];
    if (t && t.conf > 0) {
      const da = Math.abs(xa - t.center), db = Math.abs(xb - t.center);
      if (da !== db) pA += (da < db ? 1 : -1) * 0.35 * t.conf;
    }
    pA = Math.min(0.9, Math.max(0.1, pA));
    const fromA = r() < pA;
    const w = 0.6 + 0.4 * r();
    let x = fromA ? w * xa + (1 - w) * xb : w * xb + (1 - w) * xa;
    x += ls ? sd * gauss(r) : sd * (s.max - s.min) * gauss(r);
    out[k] = clip(ls ? Math.exp(x) : x, s);
  }
  return out;
}

/** Parents bred each generation for a population: as many as asked, leaving room for at least as many
 *  others (offspring slots and runners-up); none under 6 members (the classic three-network tournament). */
export function parentCount(population: number, wanted: number): number {
  if (population < 6) return 0;
  return Math.max(0, Math.min(Math.floor(wanted), Math.floor((population - 2) / 2)));
}

/** Islands for a population: as many as asked while each keeps at least 3 networks (1 = no islands). */
export function islandCount(population: number, wanted: number): number {
  return Math.max(1, Math.min(Math.floor(wanted), Math.floor(population / 3)));
}

export interface BreedCandidate { id: number; island: number; fitness: number; offspring: boolean }
export interface BreedPlan {
  champions: BreedCandidate[];
  /** Parent pairs, the fitter parent first, each with the slot its offspring takes. */
  pairs: Array<{ a: number; b: number; slot: number }>;
  runnersUp: number[];
  /** Every network's island in the next generation. */
  islandOf: Map<number, number>;
}

/** Who breeds and who stays: each island's winner is a champion parent; offspring for every pair of
 *  champions while there is room (else pairs by tournament selection), at least one runner-up kept; the
 *  worst networks give their slots to the offspring (never one listed in `keep`, e.g. the network the
 *  tournament reports as its elite); the next islands get one champion each and the offspring and
 *  runners-up dealt across them in turn. */
export function planBreeding(cands: BreedCandidate[], islands: number, r: () => number, o: { tournament?: number; keep?: number[] } = {}): BreedPlan {
  const tournament = o.tournament ?? 2;
  const byFit = (x: BreedCandidate, y: BreedCandidate) => y.fitness - x.fitness || x.id - y.id;
  const champions: BreedCandidate[] = [];
  for (let i = 0; i < islands; i++) {
    const best = cands.filter((c) => c.island === i).sort(byFit)[0];
    if (best) champions.push(best);
  }
  champions.sort(byFit);
  const k = champions.length, n = cands.length;
  const allPairs: Array<[number, number]> = [];
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) allPairs.push([i, j]);
  const room = Math.max(0, Math.min(allPairs.length, n - k - 1));
  let chosen: Array<[number, number]>;
  if (room >= allPairs.length) chosen = allPairs;
  else {
    // Tournament selection: each parent is the best of `tournament` champions drawn at random.
    const pick = (avoid = -1) => {
      let best = -1;
      for (let t = 0; t < tournament; t++) { const c = Math.floor(r() * k); if (c !== avoid && (best < 0 || c < best)) best = c; }
      return best < 0 ? (avoid === 0 ? 1 : 0) : best;
    };
    chosen = [];
    const key = (p: [number, number]) => `${Math.min(...p)}-${Math.max(...p)}`;
    const seen = new Set<string>();
    for (let tries = 0; chosen.length < room && tries < 50 * room; tries++) {
      const x = pick(), y = pick(x);
      const p: [number, number] = [Math.min(x, y), Math.max(x, y)];
      if (!seen.has(key(p))) { seen.add(key(p)); chosen.push(p); }
    }
    for (const p of allPairs) if (chosen.length < room && !seen.has(key(p))) { seen.add(key(p)); chosen.push(p); }
  }
  const champIds = new Set(champions.map((c) => c.id));
  const keep = new Set(o.keep ?? []);
  // Kept networks first, then by fitness: the worst at the end give up their slots.
  const others = cands.filter((c) => !champIds.has(c.id)).sort((x, y) => Number(keep.has(y.id)) - Number(keep.has(x.id)) || byFit(x, y));
  const maxSlots = others.length - others.filter((c) => keep.has(c.id)).length;
  if (chosen.length > maxSlots) chosen = chosen.slice(0, maxSlots);
  const slots = others.slice(others.length - chosen.length).reverse();
  const runnersUp = others.slice(0, others.length - chosen.length);
  const pairs = chosen.map(([i, j], m) => ({ a: champions[i].id, b: champions[j].id, slot: slots[m].id }));
  // Next islands: champion i anchors island i; offspring, then runners-up, dealt in a snake order so no
  // island collects all the best newcomers.
  const islandOf = new Map<number, number>();
  champions.forEach((c, i) => islandOf.set(c.id, i));
  const deal = [...pairs.map((p) => p.slot), ...runnersUp.map((c) => c.id)];
  deal.forEach((id, m) => { const lap = Math.floor(m / k), pos = m % k; islandOf.set(id, lap % 2 === 0 ? pos : k - 1 - pos); });
  return { champions, pairs, runnersUp: runnersUp.map((c) => c.id), islandOf };
}

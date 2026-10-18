// Fits the Compensator (bot/strategy/compensator.ts): per strategy, a ramp of its weight on one of the Librarian's
// readings, from what each strategy earned on whole-bot replay coin-days (research/wholeBot.ts byAsset / bySetup).
//
//   readings   each coin's Librarian forecast at the start of each day (research/librarian.ts LibIndex: the
//              walk-forward forecasts, made by a Librarian fitted only on earlier rows)
//   hindsight  per strategy and coin-day: did it pay? weighted by how much it made or lost; the top-performing
//              allocation would have put the strategy at its ceiling on the paying days and at its floor on the rest
//   fit        per strategy and reading: a weighted, ridge-shrunk logistic fit p = sigmoid(k (s - theta)), i.e. the
//              ramp's slope and threshold; the reading kept is the one with the largest deviance drop over the base
//              rate, and only when that drop beats the BIC price of the extra parameter (ln n); otherwise the
//              weight is flat at the (shrunk) base rate's
//   validation walk-forward: ramps fitted on the earlier 70% of days, applied to the later 30%; switched on only if
//              that beats the static bot AND the step playbook learned on the same earlier days (more profit,
//              drawdown at most 10% deeper than static, 10+ days). Weights scale size, so each strategy's P&L is
//              taken to scale with its weight. The ramps written are fitted on every day.

import { COMP_INPUTS, COMP_SCHEMA, COMP_STRATEGIES, compInputs, compRange, rampWeight, type CompensatorFile, type CompInput, type CompRamp, type LibDayReading } from '../bot/strategy/compensator';
import { applyWeights, learnWeights, type CoinDay } from './playbook';

export interface CompSample { day: string; asset: string; x?: Record<CompInput, number>; pnl: Record<string, number> }

/** Ridge strength (in effective coin-days) pulling the logistic fit toward even odds. */
export const COMP_RIDGE = 10;
/** Fewest coin-days a strategy traded on before it gets anything but a neutral weight. */
export const COMP_MIN_SAMPLES = 20;

/** Samples from the playbook's coin-days, the whole-bot run's per-setup P&L and the Librarian's day-start forecasts. */
export function compSamples(cds: CoinDay[], bySetup: Record<string, Record<string, Record<string, number>>>, lib: { at(asset: string, t: number): LibDayReading | undefined } | undefined): CompSample[] {
  return cds.map((c) => {
    const r = lib?.at(c.asset, Date.parse(`${c.day}T00:00:00Z`));
    const pnl: Record<string, number> = { kalshi: c.kalshi };
    for (const [k, v] of Object.entries(bySetup[c.day]?.[c.asset] ?? {})) pnl[`setup:${k}`] = v;
    return { day: c.day, asset: c.asset, x: r ? compInputs(r) : undefined, pnl };
  });
}

/** Weighted logistic regression p = sigmoid(a + b z) with ridge `lambda` on a and b (b fixed at 0 when `flat`):
 *  Newton steps. Returns the coefficients and the weighted deviance. */
export function fitLogistic(z: number[], y: number[], w: number[], lambda: number, flat = false): { a: number; b: number; deviance: number } {
  let a = 0, b = 0;
  const dev = () => { let d = 0; for (let i = 0; i < z.length; i++) { const p = Math.min(1 - 1e-12, Math.max(1e-12, 1 / (1 + Math.exp(-(a + b * z[i]))))); d -= 2 * w[i] * (y[i] ? Math.log(p) : Math.log(1 - p)); } return d; };
  for (let it = 0; it < 50; it++) {
    let ga = lambda * a, gb = lambda * b, haa = lambda, hab = 0, hbb = lambda;
    for (let i = 0; i < z.length; i++) {
      const p = 1 / (1 + Math.exp(-(a + b * z[i]))), e = w[i] * (p - y[i]), h = w[i] * p * (1 - p);
      ga += e; gb += e * z[i]; haa += h; hab += h * z[i]; hbb += h * z[i] * z[i];
    }
    let da: number, db: number;
    if (flat) { da = ga / haa; db = 0; } else { const det = haa * hbb - hab * hab; if (!(det > 0)) break; da = (hbb * ga - hab * gb) / det; db = (haa * gb - hab * ga) / det; }
    a -= da; b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-10) break;
  }
  return { a, b, deviance: dev() };
}

/** One strategy's ramp from its coin-days (those it traded on). */
export function fitRamp(samples: CompSample[], strategy: string): CompRamp {
  const [lo, hi] = compRange(strategy);
  const s = samples.filter((x) => (x.pnl[strategy] ?? 0) !== 0);
  const n = s.length;
  const neutral: CompRamp = { input: null, k: 0, theta: 0, base: 0.5, lo, hi, n, devianceDrop: 0, why: `${n} coin-day(s) traded, need ${COMP_MIN_SAMPLES}: neutral` };
  if (n < COMP_MIN_SAMPLES) return neutral;
  // Weights: |P&L| normalised to n effective coin-days, so the ridge means the same at any account size.
  const abs = s.map((x) => Math.abs(x.pnl[strategy])), tot = abs.reduce((a, v) => a + v, 0);
  const w = abs.map((v) => (v * n) / tot), y = s.map((x) => (x.pnl[strategy] > 0 ? 1 : 0));
  const base = fitLogistic(s.map(() => 0), y, w, COMP_RIDGE, true);
  const pBase = 1 / (1 + Math.exp(-base.a));
  let best: CompRamp = { ...neutral, base: pBase, why: `flat: no reading beat the base rate (paid on ${(100 * pBase).toFixed(0)}% of stake, shrunk)` };
  for (const input of COMP_INPUTS) {
    const idx = s.map((x, i) => (Number.isFinite(x.x?.[input]) ? i : -1)).filter((i) => i >= 0);
    if (idx.length < COMP_MIN_SAMPLES) continue;
    const v = idx.map((i) => s[i].x![input]);
    const m = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
    if (!(sd > 1e-9)) continue;
    const yy = idx.map((i) => y[i]), ww = idx.map((i) => w[i]);
    const flat = fitLogistic(v.map(() => 0), yy, ww, COMP_RIDGE, true);
    const f = fitLogistic(v.map((x) => (x - m) / sd), yy, ww, COMP_RIDGE);
    const drop = flat.deviance - f.deviance;
    if (!(drop > Math.log(idx.length)) || !(drop > best.devianceDrop) || Math.abs(f.b) < 1e-9) continue;
    const k = f.b / sd, theta = m - (f.a * sd) / f.b;
    best = { input, k, theta, base: pBase, lo, hi, n, devianceDrop: drop, why: `${input}: slope ${k.toFixed(3)}, threshold ${theta.toFixed(3)} (deviance drop ${drop.toFixed(1)} > ln ${idx.length})` };
  }
  return best;
}

export function fitCompensator(samples: CompSample[]): Record<string, CompRamp> {
  return Object.fromEntries(COMP_STRATEGIES.map((st) => [st, fitRamp(samples, st)]));
}

/** Daily totals of the static bot and of the bot weighted by `ramps`. */
export function applyRamps(samples: CompSample[], ramps: Record<string, CompRamp>): { days: string[]; static: number[]; comp: number[] } {
  const byDay = new Map<string, { s: number; w: number }>();
  for (const x of samples) {
    const r = byDay.get(x.day) ?? { s: 0, w: 0 };
    for (const [st, v] of Object.entries(x.pnl)) { r.s += v; r.w += v * rampWeight(ramps[st], x.x, st); }
    byDay.set(x.day, r);
  }
  const days = [...byDay.keys()].sort();
  return { days, static: days.map((d) => byDay.get(d)!.s), comp: days.map((d) => byDay.get(d)!.w) };
}

const maxDd = (pnl: number[]) => { let run = 0, peak = 0, dd = 0; for (const p of pnl) { run += p; peak = Math.max(peak, run); dd = Math.max(dd, peak - run); } return dd; };
const sum = (x: number[]) => x.reduce((a, b) => a + b, 0);

/** The Compensator: ramps fitted on every day, switched on only if ramps fitted on the earlier 70% beat both the
 *  static bot and the step playbook (learned on the same 70%) on the later 30%. `cds` are the same coin-days as
 *  `samples` (the playbook's view: per family). */
export function buildCompensator(samples: CompSample[], cds: CoinDay[], o: { version: string; at: string; trainFrac?: number; minValidationDays?: number }): CompensatorFile {
  const days = [...new Set(samples.map((s) => s.day))].sort();
  const off = (why: string): CompensatorFile => ({ schema: COMP_SCHEMA, version: o.version, at: o.at, enabled: false, ramps: {}, validation: { days: 0, staticUsd: 0, playbookUsd: 0, compUsd: 0, staticMaxDdUsd: 0, compMaxDdUsd: 0, why } });
  if (!days.length) return off('no replay coin-days');
  if (!samples.some((s) => s.x)) return off('no Librarian forecasts for the replay days (the Librarian step writes them)');
  const cut = days[Math.floor(days.length * (o.trainFrac ?? 0.7))];
  const v = applyRamps(samples.filter((s) => s.day >= cut), fitCompensator(samples.filter((s) => s.day < cut)));
  const pb = applyWeights(cds.filter((s) => s.day >= cut), learnWeights(cds.filter((s) => s.day < cut)));
  const staticUsd = sum(v.static), compUsd = sum(v.comp), playbookUsd = sum(pb.switched), sDd = maxDd(v.static), cDd = maxDd(v.comp);
  const minDays = o.minValidationDays ?? 10;
  const tail = `on the later ${v.days.length} days: $${compUsd.toFixed(2)} vs static $${staticUsd.toFixed(2)} and playbook $${playbookUsd.toFixed(2)}`;
  const why = v.days.length < minDays ? `${v.days.length} validation day(s), need ${minDays}`
    : !(compUsd > staticUsd) ? `did not beat the static bot ${tail}`
    : !(compUsd > playbookUsd) ? `did not beat the step playbook ${tail}`
    : cDd > sDd * 1.1 + 1e-9 ? `deepened the drawdown to $${cDd.toFixed(2)} (static $${sDd.toFixed(2)}) ${tail}`
    : `beat both ${tail} (drawdown $${cDd.toFixed(2)} vs $${sDd.toFixed(2)})`;
  const enabled = v.days.length >= minDays && compUsd > staticUsd && compUsd > playbookUsd && cDd <= sDd * 1.1 + 1e-9;
  return {
    schema: COMP_SCHEMA, version: o.version, at: o.at, enabled, ramps: fitCompensator(samples),
    validation: { days: v.days.length, staticUsd: +staticUsd.toFixed(2), playbookUsd: +playbookUsd.toFixed(2), compUsd: +compUsd.toFixed(2), staticMaxDdUsd: +sDd.toFixed(2), compMaxDdUsd: +cDd.toFixed(2), why },
  };
}

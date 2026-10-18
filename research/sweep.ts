// Sweep optimizer: coordinate descent over the bot's settings, one at a time, until a full pass changes
// nothing (plateau) or the time budget runs out. Runs unattended for hours (a background job or a
// pipeline step) and writes a proposal; it never changes the live configuration by itself.
//
//   npm run research:sweep -- --target setups-long --hours 2 --history data/history
//   npm run research:sweep -- --target kalshi --hours 24 --recordings data/recordings
//
// Guards against overfitting (each extra setting tried on the same data makes the best result look
// better by luck):
//   - three time windows: TUNE (choices are made here), CHECK (a change must not make this worse),
//     FINAL (untouched until the end, evaluated once and reported)
//   - a change is accepted only if it improves the tuning score by at least `epsilon` and the check
//     score does not drop by more than `tolerance`
//   - every evaluation is counted (trials) and reported, with the final-window result next to the
//     starting point's, so the gain can be judged out of sample
// Every evaluation is saved in the ledger the moment it finishes (with the data it was made on), so a stopped
// sweep resumes exactly where it was: it walks the same path again from the same start, every result it already
// has taken from the ledger, and the first new evaluation is the one that was interrupted. The values of one
// setting are evaluated at once on worker threads when the target can (fitnessMany; the choice among them is the
// same as evaluating them one by one).
//
// Targets:
//   setups-long / setups-short   the 1h momentum burst per side (bot/setups/detectors.ts BURST): entry
//                                thresholds and exits, scored by the t-statistic of net R per trade on
//                                years of candle history (all coins, order flow, the real fees)
//   setups-vol                   the volatility-adapted trail (bot/setups/detectors.ts VOL_ADAPT): how
//                                much the TA network's 4h volatility forecast (walk-forward export,
//                                research/taNetOos.ts) widens / tightens fast-lane trails; both sides
//   setups-ratchet               the 4h ATR ratchet exit on the slow lane (bot/setups/detectors.ts RATCHET): on /
//                                off and its distances, by the t-statistic of net R per trade on the daily setups
//   setups-scale                 scale-out exits (bot/setups/detectors.ts SCALE_OUT): partial take-profits at R
//                                multiples, the rest trailed, against each lane's own exits (on / off, the steps, the
//                                trail), by the t-statistic of net R per trade on both lanes' setups
//   setups-spotpb                the spot pullback (bot/setups/detectors.ts spotpb) for the coins where Coinbase spot
//                                leads the Kalshi perp (the latest research/leadLag.ts study): on / off, by the
//                                t-statistic of net R per trade over those coins' fast-lane setups
//   kalshi                       the Kalshi contract strategy (edge thresholds, buffers, exit margin,
//                                Kelly fraction, per-trade EV target), scored by the t-statistic of net
//                                P&L per 15-minute window in the production backtester over the bot's
//                                own recordings (needs data/recordings: run it on the server)
//   bot                          the WHOLE bot over the recordings (research/wholeBot.ts): Kalshi through
//                                the production backtester and the perps setup lanes on walk-forward
//                                scores, one pot of capital, one daily loss stop; tunes the shared
//                                settings (capital split, risk per lane trade, lane sizes, minimum
//                                target, daily stop, Kalshi edge and Kelly) by the t-statistic of the
//                                combined P&L per day

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pruneTapes } from './callTape';

export interface SweepParam { name: string; values: number[]; get(): number; set(v: number): void }
export interface Fitness { score: number; n: number; mean?: number }
export type SweepWindow = 'tune' | 'check' | 'final';
export interface SweepTarget {
  name: string;
  params: SweepParam[];
  /** Fewest trades / windows for a score to count. */
  minN: number;
  fitness(w: SweepWindow): Promise<Fitness>;
  /** Several settings at once (worker threads): the same results as fitness() with each applied. */
  fitnessMany?(jobs: { w: SweepWindow; settings: Record<string, number> }[]): Promise<Fitness[]>;
  /** Everything the scores depend on besides the swept settings (the data, the model, the other settings): a ledger
   *  made on other data starts over. */
  signature?: string;
  /** Releases what fitnessMany started (worker threads). */
  close?(): Promise<void>;
  /** Current settings (for the proposal). */
  snapshot(): Record<string, number>;
}

export interface SweepOpts {
  hours: number; epsilon: number; tolerance: number; maxPasses: number; ledgerPath?: string; log?: (m: string) => void;
  /** Kept in the ledger for the caller (the pipeline pins the sweep's days there). */
  meta?: Record<string, unknown>;
}
export interface SweepStep { pass: number; param: string; from: number; to: number; tune: Fitness; check: Fitness; accepted: boolean; ts: string }
export interface SweepReport {
  target: string; started: string; finished: string; passes: number; evaluations: number; plateau: boolean;
  start: { settings: Record<string, number>; tune: Fitness; check: Fitness; final: Fitness };
  end: { settings: Record<string, number>; tune: Fitness; check: Fitness; final: Fitness };
  steps: SweepStep[];
  /** Ran to a plateau or its last pass (not cut by the time budget). */
  complete?: boolean;
  signature?: string;
  meta?: Record<string, unknown>;
  /** Every evaluation so far: "window|settings" -> [score, n, mean] (non-finite numbers as strings). */
  evals?: Record<string, [number | string, number, number | string | null]>;
}

const fmt = (f: Fitness) => `score ${f.score.toFixed(3)} (n ${f.n}${f.mean !== undefined ? `, mean ${f.mean.toFixed(3)}` : ''})`;

/** t-statistic of a sample (mean / standard error). */
export function tStat(xs: number[]): Fitness {
  const n = xs.length;
  if (n < 2) return { score: -Infinity, n, mean: n ? xs[0] : NaN };
  const m = xs.reduce((a, v) => a + v, 0) / n, sd = Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / (n - 1));
  return { score: sd > 0 ? m / (sd / Math.sqrt(n)) : 0, n, mean: m };
}

const num = (x: number) => (Number.isFinite(x) ? x : String(x));
const unnum = (x: number | string | null | undefined) => (typeof x === 'string' ? Number(x) : x ?? undefined);

export async function runSweep(t: SweepTarget, o: SweepOpts): Promise<SweepReport> {
  try { return await sweepLoop(t, o); } finally { await t.close?.(); }
}

async function sweepLoop(t: SweepTarget, o: SweepOpts): Promise<SweepReport> {
  const log = o.log ?? ((m: string) => console.log(`[sweep] ${m}`));
  const deadline = Date.now() + o.hours * 3_600_000;
  const valid = (f: Fitness) => f.n >= t.minN && Number.isFinite(f.score);
  // Resume: the same start and every evaluation already made, when the ledger is this target's on the same data.
  let prior: SweepReport | undefined;
  if (o.ledgerPath && fs.existsSync(o.ledgerPath)) {
    try { prior = JSON.parse(fs.readFileSync(o.ledgerPath, 'utf8')) as SweepReport; } catch { prior = undefined; }
    if (prior && (prior.target !== t.name || !prior.evals || (prior.signature ?? '') !== (t.signature ?? ''))) {
      if (prior.target === t.name) log(`${o.ledgerPath} was made on other data or by an older version: starting over`);
      prior = undefined;
    }
  }
  const cache = new Map<string, Fitness>(Object.entries(prior?.evals ?? {}).map(([k, [sc, n, m]]) => [k, { score: unnum(sc)!, n, ...(m !== null ? { mean: unnum(m) } : {}) }]));
  if (prior) log(`resuming ${o.ledgerPath}: ${cache.size} evaluation(s) already made`);
  const startSettings = prior?.start.settings ?? t.snapshot();
  for (const p of t.params) if (startSettings[p.name] !== undefined) p.set(startSettings[p.name]);
  const key = (w: SweepWindow, settings: Record<string, number>) => `${w}|${JSON.stringify(settings)}`;
  let evaluations = 0;
  const steps: SweepStep[] = [];
  const started = prior?.started ?? new Date().toISOString();
  let pass = 0, plateau = false, complete = false;
  let tune: Fitness = { score: NaN, n: 0 }, check: Fitness = { score: NaN, n: 0 }, startScores = { tune, check, final: tune };
  const save = (final?: Fitness): SweepReport => {
    const r: SweepReport = {
      target: t.name, started, finished: new Date().toISOString(), passes: pass, evaluations: cache.size, plateau, complete, signature: t.signature, meta: o.meta ?? prior?.meta,
      start: { settings: startSettings, tune: startScores.tune, check: startScores.check, final: startScores.final },
      end: { settings: t.snapshot(), tune, check, final: final ?? { score: NaN, n: 0 } },
      steps,
      evals: Object.fromEntries([...cache].map(([k, f]) => [k, [num(f.score), f.n, f.mean === undefined ? null : num(f.mean)]])),
    };
    if (o.ledgerPath) {
      fs.mkdirSync(path.dirname(o.ledgerPath), { recursive: true });
      const tmp = `${o.ledgerPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(r, null, 1));
      fs.renameSync(tmp, o.ledgerPath);
    }
    return r;
  };
  /** Scores of several settings: from the ledger when already made, the rest at once (fitnessMany) or one by one,
   *  each saved as soon as the batch finishes. */
  const many = async (jobs: { w: SweepWindow; settings: Record<string, number> }[]): Promise<Fitness[]> => {
    const todo = [...new Map(jobs.filter((j) => !cache.has(key(j.w, j.settings))).map((j) => [key(j.w, j.settings), j])).values()];
    // Each result is in the ledger the moment it is made, so a stop loses only the evaluations still running.
    const keep1 = (j: { w: SweepWindow; settings: Record<string, number> }, f: Fitness) => { cache.set(key(j.w, j.settings), f); evaluations++; save(); };
    if (t.fitnessMany && todo.length > 1) {
      const many1 = t.fitnessMany.bind(t);
      await Promise.all(todo.map(async (j) => keep1(j, (await many1([j]))[0])));
    } else {
      const keep = t.snapshot();
      try {
        for (const j of todo) {
          for (const p of t.params) if (j.settings[p.name] !== undefined) p.set(j.settings[p.name]);
          keep1(j, await t.fitness(j.w));
        }
      } finally { for (const p of t.params) p.set(keep[p.name]); }
    }
    return jobs.map((j) => cache.get(key(j.w, j.settings))!);
  };
  [startScores.tune, startScores.check, startScores.final] = await many((['tune', 'check', 'final'] as const).map((w) => ({ w, settings: startSettings })));
  startScores = { ...startScores };
  tune = startScores.tune; check = startScores.check;
  log(`start: tune ${fmt(tune)} | check ${fmt(check)}`);
  let cut = false;
  while (pass < o.maxPasses) {
    if (Date.now() >= deadline) { cut = true; break; }
    pass++;
    let changed = 0;
    for (const p of t.params) {
      if (Date.now() >= deadline) { cut = true; break; }
      const cur = p.get(), base = t.snapshot();
      const cands = p.values.filter((v) => v !== cur);
      const at = (v: number) => ({ ...base, [p.name]: v });
      const tunes = await many(cands.map((v) => ({ w: 'tune' as const, settings: at(v) })));
      // The check window of every value that could clear the first bar (a superset of what the choice below reads).
      const pre = cands.filter((_, i) => valid(tunes[i]) && tunes[i].score >= tune.score + o.epsilon);
      const checks = new Map(pre.map((v, i) => [v, i]));
      const preChecks = await many(pre.map((v) => ({ w: 'check' as const, settings: at(v) })));
      let best: { v: number; tune: Fitness; check: Fitness } | undefined;
      cands.forEach((v, i) => {
        const ft = tunes[i];
        if (!valid(ft) || ft.score < (best?.tune.score ?? tune.score) + o.epsilon) return;
        const fc = preChecks[checks.get(v)!];
        if (!valid(fc) || fc.score < check.score - o.tolerance) return;
        best = { v, tune: ft, check: fc };
      });
      p.set(best ? best.v : cur);
      steps.push({ pass, param: p.name, from: cur, to: best?.v ?? cur, tune: best?.tune ?? tune, check: best?.check ?? check, accepted: Boolean(best), ts: new Date().toISOString() });
      if (best) { changed++; tune = best.tune; check = best.check; log(`pass ${pass}: ${p.name} ${cur} -> ${best.v}: tune ${fmt(tune)} | check ${fmt(check)}`); }
      save();
    }
    if (cut) break;
    if (!changed) { plateau = true; log(`pass ${pass}: no change accepted - plateau`); break; }
  }
  complete = !cut;
  if (cut) {
    const r = save();
    log(`time budget used after ${pass} pass(es), ${r.evaluations} evaluations: the next run continues from here (tune ${fmt(tune)} | check ${fmt(check)})`);
    return r;
  }
  const [final] = await many([{ w: 'final', settings: t.snapshot() }]);
  const r = save(final);
  log(`end after ${pass} pass(es), ${r.evaluations} evaluations (${evaluations} this run)${plateau ? ' (plateau)' : ' (last pass)'}: tune ${fmt(tune)} | check ${fmt(check)} | FINAL ${fmt(final)} (start: final ${fmt(startScores.final)})`);
  return r;
}

// ---- Targets ----------------------------------------------------------------------------------------

/** 1h momentum burst, one side (or both with side 0: the volatility trail). Windows: tune 2020 to Jun
 *  2024, check Jul 2024 to Jun 2025, final after. */
export async function setupsTarget(hist: string, side: 1 | -1 | 0): Promise<SweepTarget> {
  const { loadAssetBars, simulateSetup } = await import('./trainSetupModel');
  const { BURST, VOL_ADAPT, adaptToVol, detectAt } = await import('../bot/setups/detectors');
  const { loadOos, OosIndex } = await import('./taNetOos');
  const oos = new OosIndex(loadOos(hist));
  if (side === 0 && !oos.f) throw new Error(`the setups-vol sweep needs the TA network's walk-forward forecasts in ${hist}/.tanet-oos (npm run research:ta-net-oos)`);
  const { DEFAULT_COSTS, tradeResult } = await import('../bot/setups/exits');
  const assets = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'].map((a) => loadAssetBars(hist, a)).filter((A): A is NonNullable<typeof A> => Boolean(A));
  const P = side >= 0 ? BURST.long : BURST.short;
  const WIN: Record<SweepWindow, [number, number]> = { tune: [Date.UTC(2020, 0, 1), Date.UTC(2024, 6, 1)], check: [Date.UTC(2024, 6, 1), Date.UTC(2025, 6, 1)], final: [Date.UTC(2025, 6, 1), Infinity] };
  const num = (k: keyof typeof P, values: number[]): SweepParam => ({ name: `${side > 0 ? 'long' : 'short'}.${String(k)}`, values, get: () => Number(P[k]), set: (v) => { (P as Record<string, number | boolean>)[k] = typeof P[k] === 'boolean' ? v > 0 : v; } });
  const volK: SweepParam = { name: 'vol.trailK', values: [-0.5, 0, 0.25, 0.5, 1], get: () => VOL_ADAPT.trailK, set: (v) => { VOL_ADAPT.trailK = v; } };
  return {
    name: side > 0 ? 'setups-long' : side < 0 ? 'setups-short' : 'setups-vol',
    minN: 40,
    params: side === 0 ? [volK] : [
      num('range', [1.25, 1.5, 1.75, 2, 2.5]), num('vol', [1.5, 2, 2.5, 3, 4]), num('flow', [0.55, 0.6, 0.65, 0.7]),
      num('lookback', [10, 20, 40]), num('daily', [0, 1]), num('trail', [2, 2.5, 3, 3.5, 4]), num('bars', [12, 16, 24, 32, 48]),
    ],
    snapshot: () => (side === 0 ? { 'vol.trailK': VOL_ADAPT.trailK } : Object.fromEntries(Object.entries(P).map(([k, v]) => [`${side > 0 ? 'long' : 'short'}.${k}`, Number(v)]))),
    async fitness(w) {
      const [from, to] = WIN[w];
      const rs: number[] = [];
      for (const A of assets) {
        const s = A.series['1h']!;
        let busyUntil = 0;
        for (let i = 60; i < s.cs.length; i++) {
          const ts = s.cs[i].ts;
          if (ts < from || ts >= to || ts < busyUntil) continue;
          const g = detectAt(A.asset, '1h', s, i, A.series['1d']);
          if (!g || g.kind !== 'burst' || (side !== 0 && g.dir !== side)) continue;
          const t = simulateSetup(A, adaptToVol(g, oos.at(A.asset, ts + 3_600_000)?.vol), DEFAULT_COSTS);
          if (!t?.closed) continue;
          busyUntil = t.closed.ts;
          rs.push(tradeResult(t).r);
        }
      }
      return tStat(rs);
    },
  };
}

/** The 4h ATR ratchet exit (bot/setups/detectors.ts RATCHET) on the slow lane's daily setups, every coin with history:
 *  on / off, the initial stop, break-even and trail distances, and (with the TA network's walk-forward forecasts)
 *  whether its 4h volatility forecast makes a better unit than ATR(4h) alone (volK; 0 = ATR alone), scored by the t-statistic of net R per trade (the
 *  lanes size by stop distance, so R is what the account feels). Same windows as the setup sweeps. */
export async function ratchetTarget(hist: string): Promise<SweepTarget> {
  const { loadAssetBars, simulateSetup } = await import('./trainSetupModel');
  const { RATCHET, applyRatchet, atr4hAt, detectAt, TF_MS } = await import('../bot/setups/detectors');
  const { DEFAULT_COSTS, tradeResult } = await import('../bot/setups/exits');
  const { storedAssets } = await import('./history/candles');
  const { loadOos, OosIndex } = await import('./taNetOos');
  const assets = storedAssets(hist).map((a) => loadAssetBars(hist, a)).filter((A): A is NonNullable<typeof A> => Boolean(A));
  const WIN: Record<SweepWindow, [number, number]> = { tune: [Date.UTC(2020, 0, 1), Date.UTC(2024, 6, 1)], check: [Date.UTC(2024, 6, 1), Date.UTC(2025, 6, 1)], final: [Date.UTC(2025, 6, 1), Infinity] };
  if (RATCHET.lanes === 'off') RATCHET.lanes = 'slow';
  // The TA network's walk-forward 4h volatility forecasts: with them, the unit can be scaled by the forecast (volK).
  const oos = new OosIndex(loadOos(hist));
  const on = { v: 1 };
  const p = (name: keyof typeof RATCHET, values: number[]): SweepParam => ({ name: `ratchet.${name}`, values, get: () => Number(RATCHET[name]), set: (v) => { (RATCHET as unknown as Record<string, number>)[name] = v; } });
  const fee = DEFAULT_COSTS.entry + DEFAULT_COSTS.takerExit;
  return {
    name: 'setups-ratchet',
    minN: 30,
    params: [
      { name: 'ratchet.on', values: [0, 1], get: () => on.v, set: (v) => { on.v = v; } },
      p('stopAtr', [2.5, 3, 3.5, 4.5]), p('beAtr', [1.5, 2, 3]), p('trailStartAtr', [2.5, 3.5, 5]), p('trailAtr', [2, 3, 4]),
      ...(oos.f ? [p('volK', [-0.5, 0, 0.5, 1])] : []),
    ],
    snapshot: () => ({ 'ratchet.on': on.v, 'ratchet.stopAtr': RATCHET.stopAtr, 'ratchet.beAtr': RATCHET.beAtr, 'ratchet.trailStartAtr': RATCHET.trailStartAtr, 'ratchet.trailAtr': RATCHET.trailAtr, 'ratchet.volK': RATCHET.volK ?? 0 }),
    async fitness(w) {
      const [from, to] = WIN[w];
      const rs: number[] = [];
      const settings = { ...RATCHET, lanes: on.v ? ('slow' as const) : ('off' as const) };
      for (const A of assets) {
        const s = A.series['1d'];
        if (!s) continue;
        let busyUntil = 0;
        for (let i = 60; i < s.cs.length; i++) {
          const ts = s.cs[i].ts;
          if (ts < from || ts >= to || ts < busyUntil) continue;
          const g = detectAt(A.asset, '1d', s, i, s);
          if (!g || g.lane !== 'slow') continue;
          const at = ts + TF_MS['1d']!;
          const t = simulateSetup(A, applyRatchet(g, atr4hAt(A.h1, at), fee, settings, oos.at(A.asset, at)?.vol), DEFAULT_COSTS);
          if (!t?.closed) continue;
          busyUntil = t.closed.ts;
          rs.push(tradeResult(t).r);
        }
      }
      return tStat(rs);
    },
  };
}

/** Scale-out exits (bot/setups/detectors.ts SCALE_OUT, the 4th-generation spec's 5.1) on both lanes' setups, every coin
 *  with history: on / off (off = each lane's own targets and trail, the baseline), the two steps and the trail, scored
 *  by the t-statistic of net R per trade. A proposal like the others: SETUP_SCALE_OUT stays off until it is adopted. */
export async function scaleTarget(hist: string): Promise<SweepTarget> {
  const { loadAssetBars, simulateSetup } = await import('./trainSetupModel');
  const { SCALE_OUT, applyScaleOut, detectAt, FAST_TFS, SLOW_TFS } = await import('../bot/setups/detectors');
  const { DEFAULT_COSTS, tradeResult } = await import('../bot/setups/exits');
  const { storedAssets } = await import('./history/candles');
  const assets = storedAssets(hist).map((a) => loadAssetBars(hist, a)).filter((A): A is NonNullable<typeof A> => Boolean(A));
  const WIN: Record<SweepWindow, [number, number]> = { tune: [Date.UTC(2020, 0, 1), Date.UTC(2024, 6, 1)], check: [Date.UTC(2024, 6, 1), Date.UTC(2025, 6, 1)], final: [Date.UTC(2025, 6, 1), Infinity] };
  const on = { v: SCALE_OUT.lanes === 'off' ? 0 : 1 };
  const p = (name: Exclude<keyof typeof SCALE_OUT, 'lanes'>, values: number[]): SweepParam => ({ name: `scale.${name}`, values, get: () => SCALE_OUT[name], set: (v) => { SCALE_OUT[name] = v; } });
  return {
    name: 'setups-scale',
    minN: 30,
    params: [
      { name: 'scale.on', values: [0, 1], get: () => on.v, set: (v) => { on.v = v; } },
      p('r1', [0.75, 1, 1.5]), p('f1', [0.25, 0.33, 0.5]), p('r2', [1.5, 2, 3]), p('f2', [0, 0.25, 0.33]), p('trailAtr', [1.5, 2.5, 3.5]),
    ],
    snapshot: () => ({ 'scale.on': on.v, 'scale.r1': SCALE_OUT.r1, 'scale.f1': SCALE_OUT.f1, 'scale.r2': SCALE_OUT.r2, 'scale.f2': SCALE_OUT.f2, 'scale.trailAtr': SCALE_OUT.trailAtr }),
    async fitness(w) {
      const [from, to] = WIN[w];
      const rs: number[] = [];
      const settings = { ...SCALE_OUT, lanes: on.v ? ('both' as const) : ('off' as const) };
      for (const A of assets) for (const tf of [...FAST_TFS, ...SLOW_TFS]) {
        const s = A.series[tf];
        if (!s) continue;
        let busyUntil = 0;
        for (let i = 60; i < s.cs.length; i++) {
          const ts = s.cs[i].ts;
          if (ts < from || ts >= to || ts < busyUntil) continue;
          const g = detectAt(A.asset, tf, s, i, A.series['1d']);
          if (!g) continue;
          const t = simulateSetup(A, applyScaleOut(g, settings), DEFAULT_COSTS);
          if (!t?.closed) continue;
          busyUntil = t.closed.ts;
          rs.push(tradeResult(t).r);
        }
      }
      return tStat(rs);
    },
  };
}

/** The spot pullback on / off over the fast-lane setups of the coins where spot leads (the lead-lag study's verdict).
 *  With it on, those coins' fast lane also takes spot pullbacks (and takes them ahead of plain pullbacks). */
export async function spotPbTarget(hist: string, leadLagFile: string): Promise<SweepTarget> {
  const { loadAssetBars, simulateSetup } = await import('./trainSetupModel');
  const { detectAt, FAST_TFS } = await import('../bot/setups/detectors');
  const { DEFAULT_COSTS, tradeResult } = await import('../bot/setups/exits');
  const { spotLeads } = await import('./leadLag');
  const coins = spotLeads(leadLagFile);
  if (!coins.length) throw new Error(`setups-spotpb needs at least one coin where spot leads the perp (${leadLagFile}: run the lead_lag step on the recordings)`);
  const assets = coins.map((a) => loadAssetBars(hist, a)).filter((A): A is NonNullable<typeof A> => Boolean(A));
  const WIN: Record<SweepWindow, [number, number]> = { tune: [Date.UTC(2020, 0, 1), Date.UTC(2024, 6, 1)], check: [Date.UTC(2024, 6, 1), Date.UTC(2025, 6, 1)], final: [Date.UTC(2025, 6, 1), Infinity] };
  const on = { v: 0 };
  return {
    name: 'setups-spotpb',
    minN: 30,
    params: [{ name: 'spotpb.on', values: [0, 1], get: () => on.v, set: (v) => { on.v = v; } }],
    snapshot: () => ({ 'spotpb.on': on.v, coins: coins.length }),
    async fitness(w) {
      const [from, to] = WIN[w];
      const rs: number[] = [];
      for (const A of assets) for (const tf of FAST_TFS) {
        const s = A.series[tf];
        if (!s) continue;
        let busyUntil = 0;
        for (let i = 60; i < s.cs.length; i++) {
          const ts = s.cs[i].ts;
          if (ts < from || ts >= to || ts < busyUntil) continue;
          const g = detectAt(A.asset, tf, s, i, A.series['1d'], { spotPb: on.v === 1 });
          if (!g) continue;
          const t = simulateSetup(A, g, DEFAULT_COSTS);
          if (!t?.closed) continue;
          busyUntil = t.closed.ts;
          rs.push(tradeResult(t).r);
        }
      }
      return tStat(rs);
    },
  };
}

/** Kalshi contracts through the production backtester. Windows: the recorded days split 70 / 15 / 15. */
/** One Kalshi sweep evaluation: the production backtester over a window's days with these strategy settings, scored
 *  by the t-statistic of net P&L per traded 15-minute window (the same in the sweep and its worker threads). */
export async function kalshiScore(dir: string, modelPath: string, strategy: Record<string, unknown>, tape?: { file: string; sig: string }): Promise<Fitness> {
  const { runBacktest } = await import('./backtest');
  const { loadConfig } = await import('../bot/config');
  const { MetaModel } = await import('../bot/model/metaModel');
  const cfg = loadConfig({ ...process.env, DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32), TRADING_MODE: 'paper' });
  const model = kalshiModels.get(modelPath) ?? (fs.existsSync(modelPath) ? MetaModel.load(modelPath) : MetaModel.identity());
  kalshiModels.set(modelPath, model);
  const S = { ...cfg.strategy, ...strategy } as typeof cfg.strategy;
  const res = await runBacktest(dir, model, S, cfg.risk, cfg.paperBankrollUsd, {
    sessionRisk: S.sessionRisk, huntSessionGuard: S.huntSessionGuard, huntTransitionBufferMin: S.huntTransitionBufferMin,
    vault: cfg.vault.enabled ? cfg.vault : undefined, sizingTiers: cfg.sizingTiers, tape,
  });
  return tStat([...res.windows.values()].filter((x) => x.contracts > 0).map((x) => x.pnl));
}
const kalshiModels = new Map<string, import('../bot/model/metaModel').MetaModel>();

/** Model-call tapes (research/callTape.ts) kept within SWEEP_TAPE_GB (default 4), least recently used out. */
export const sweepTapeBytes = () => Math.max(0.1, Number(process.env.SWEEP_TAPE_GB ?? 4) || 4) * 1e9;

export async function kalshiTarget(recordings: string, modelPath: string, workers = 1, tapeDir?: string): Promise<SweepTarget> {
  const { loadConfig } = await import('../bot/config');
  const cfg = loadConfig({ ...process.env, DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32), TRADING_MODE: 'paper' });
  const { recordingFiles, linkDays } = await import('../bot/marketdata/recordingFiles');
  const days = recordingFiles(recordings);
  if (days.length < 20) throw new Error(`only ${days.length} recorded day(s) in ${recordings}: the kalshi sweep needs at least 20`);
  const a = Math.floor(days.length * 0.7), b = Math.floor(days.length * 0.85);
  const split = { tune: days.slice(0, a), check: days.slice(a, b), final: days.slice(b) };
  const dirs = {} as Record<SweepWindow, string>;
  for (const w of ['tune', 'check', 'final'] as const) {
    dirs[w] = fs.mkdtempSync(path.join(os.tmpdir(), `sweep-${w}-`));
    linkDays(split[w], dirs[w]);
  }
  const S = { ...cfg.strategy };
  const KEYS = ['minEdge', 'takerBuffer', 'makerBuffer', 'exitMargin', 'kellyFraction', 'targetEvUsd', 'targetEvOfRisk'] as const;
  const num = (k: (typeof KEYS)[number], values: number[]): SweepParam => ({ name: `strategy.${k}`, values, get: () => S[k], set: (v) => { S[k] = v; } });
  // Day files by name and size (a replay rebuilt with the same content keeps its sweep); the model by size and time.
  const stat = (f: string, time = false) => { try { const st = fs.statSync(f); return [path.basename(f), st.size, time ? Math.floor(st.mtimeMs) : 0]; } catch { return [path.basename(f), 0, 0]; } };
  // The scores depend on the days (and their files), the model, and every setting the sweep does not move.
  const fixed = Object.fromEntries(Object.entries(cfg.strategy).filter(([k]) => !(KEYS as readonly string[]).includes(k)));
  const signature = crypto.createHash('sha1').update(JSON.stringify([days.map((d) => stat(d.file)), stat(modelPath, true), fixed, cfg.risk, cfg.paperBankrollUsd, cfg.vault, cfg.sizingTiers])).digest('hex');
  const strategyOf = (settings: Record<string, number>) => Object.fromEntries(KEYS.map((k) => [k, settings[`strategy.${k}`] ?? S[k]]));
  // Each window's model calls are the same whatever the settings: recorded on its first backtest, played back after.
  if (tapeDir) pruneTapes(tapeDir, sweepTapeBytes());
  const tapeOf = (w: SweepWindow) => (tapeDir ? { file: path.join(tapeDir, `kalshi-${w}-${signature.slice(0, 16)}.tape`), sig: `${signature}|${w}` } : undefined);
  let pool: import('./workerPool').WorkerPool<{ dir: string; modelPath: string; strategy: Record<string, unknown>; tape?: { file: string; sig: string } }, Fitness> | undefined;
  return {
    name: 'kalshi',
    minN: 30,
    signature,
    params: [
      num('minEdge', [0.01, 0.015, 0.02, 0.03, 0.04, 0.05]), num('takerBuffer', [0, 0.005, 0.01, 0.02, 0.03]), num('makerBuffer', [0, 0.005, 0.01, 0.015, 0.02]),
      num('exitMargin', [0, 0.005, 0.01, 0.02, 0.03]), num('kellyFraction', [0.1, 0.15, 0.25, 0.35, 0.5]), num('targetEvOfRisk', [0.1, 0.25, 0.5, 0.75]),
    ],
    snapshot: () => Object.fromEntries(KEYS.map((k) => [`strategy.${k}`, S[k]])),
    fitness: (w) => kalshiScore(dirs[w], modelPath, { ...S }, tapeOf(w)),
    // Several settings at once, one backtest per worker thread (TRAIN_WORKERS).
    fitnessMany: workers > 1 ? async (jobs) => {
      const { WorkerPool, workerScript } = await import('./workerPool');
      pool ??= new WorkerPool(workerScript('sweepWorker'), workers);
      return Promise.all(jobs.map((j) => pool!.run({ dir: dirs[j.w], modelPath, strategy: strategyOf(j.settings), tape: tapeOf(j.w) })));
    } : undefined,
    close: async () => { await pool?.close(); pool = undefined; },
  };
}

/** The whole bot over the recordings. Windows: the recorded days split 70 / 15 / 15. */
export async function botTarget(recordings: string, history: string, modelPath: string, setupOos: string, setupModelPath?: string, tapeDir?: string): Promise<SweepTarget> {
  const { loadWholeBot, runWholeBot, settingsFromConfig, recordedDays } = await import('./wholeBot');
  const n = recordedDays(recordings).length;
  if (n < 20) throw new Error(`only ${n} recorded day(s) in ${recordings}: the whole-bot sweep needs at least 20`);
  const D = await loadWholeBot({ recordings, history, setupOos, modelPath, split: { tune: [0, 0.7], check: [0.7, 0.85], final: [0.85, 1] } });
  if (tapeDir) {
    pruneTapes(tapeDir, sweepTapeBytes());
    const stat = (f: string) => { try { const st = fs.statSync(f); return [path.basename(f), st.size, Math.floor(st.mtimeMs)]; } catch { return [path.basename(f), 0, 0]; } };
    D.tape = { dir: tapeDir, sig: crypto.createHash('sha1').update(JSON.stringify([recordedDays(recordings).map((d) => stat(d.file)), stat(modelPath), D.cfg.risk])).digest('hex') };
  }
  const { SetupModel } = await import('../bot/setups/setupModel');
  let book;
  try { book = SetupModel.load(setupModelPath ?? D.cfg.perps.setupModelPath)?.params.book; } catch { book = undefined; }
  const S = settingsFromConfig(D.cfg, book);
  const cache = new Map<string, unknown>();
  const p = (name: string, values: number[], get: () => number, set: (v: number) => void): SweepParam => ({ name, values, get, set });
  const risk = (S.totalUsd || 100) * Math.max(0.05, S.perpsShare);
  return {
    name: 'bot',
    minN: 5,
    params: [
      p('perpsShare', [0, 0.25, 0.4, 0.5, 0.6, 0.75, 1], () => S.perpsShare, (v) => { S.perpsShare = v; }),
      p('SETUP_FAST_RISK_USD', [0, 0.005, 0.01, 0.02, 0.03].map((f) => +(f * risk).toFixed(2)), () => S.book.fast.riskUsd ?? 0, (v) => { S.book.fast.riskUsd = v; }),
      p('SETUP_SLOW_RISK_USD', [0, 0.005, 0.01, 0.02].map((f) => +(f * risk).toFixed(2)), () => S.book.slow.riskUsd ?? 0, (v) => { S.book.slow.riskUsd = v; }),
      p('SETUP_FAST_MAX_POSITIONS', [1, 2, 3, 5], () => S.book.fast.maxPositions, (v) => { S.book.fast.maxPositions = v; }),
      p('SETUP_SLOW_MAX_POSITIONS', [0, 1, 2, 3], () => S.book.slow.maxPositions, (v) => { S.book.slow.maxPositions = v; }),
      p('SETUP_MIN_TARGET_USD', [0, 1, 2, 3, 5], () => S.book.minTargetUsd ?? 0, (v) => { S.book.minTargetUsd = v; }),
      p('dailyLossFrac', [0, 0.03, 0.05, 0.1, 0.2], () => S.dailyLossFrac, (v) => { S.dailyLossFrac = v; }),
      p('STRATEGY_MIN_EDGE', [0.01, 0.02, 0.03, 0.05], () => S.strategy.minEdge, (v) => { S.strategy.minEdge = v; }),
      p('STRATEGY_KELLY_FRACTION', [0.1, 0.15, 0.25, 0.35, 0.5], () => S.strategy.kellyFraction, (v) => { S.strategy.kellyFraction = v; }),
    ],
    snapshot: () => ({ perpsShare: S.perpsShare, SETUP_FAST_RISK_USD: S.book.fast.riskUsd ?? 0, SETUP_SLOW_RISK_USD: S.book.slow.riskUsd ?? 0, SETUP_FAST_MAX_POSITIONS: S.book.fast.maxPositions, SETUP_SLOW_MAX_POSITIONS: S.book.slow.maxPositions, SETUP_MIN_TARGET_USD: S.book.minTargetUsd ?? 0, dailyLossFrac: S.dailyLossFrac, STRATEGY_MIN_EDGE: S.strategy.minEdge, STRATEGY_KELLY_FRACTION: S.strategy.kellyFraction }),
    async fitness(w) {
      const r = await runWholeBot(D, w, structuredClone(S), cache);
      return tStat(r.days.map((d) => d.total));
    },
  };
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

export async function sweepMain(argOf: (k: string, d: string) => string = cliArg, extra: { meta?: Record<string, unknown>; log?: (m: string) => void } = {}): Promise<SweepReport> {
  const target = argOf('target', 'setups-long');
  const { workerCount } = await import('./workerPool');
  const tapeDir = argOf('tape-dir', '') || undefined;
  const t = target === 'kalshi' ? await kalshiTarget(argOf('recordings', 'data/recordings'), argOf('model', 'params/model.json'), workerCount(), tapeDir)
    : target === 'bot' ? await botTarget(argOf('recordings', 'data/recordings'), argOf('history', 'data/history'), argOf('model', 'params/model.json'), argOf('setup-oos', 'data/models/setup_oos.json'), argOf('setup-model', '') || undefined, tapeDir)
    : target === 'setups-ratchet' ? await ratchetTarget(argOf('history', 'data/history'))
    : target === 'setups-scale' ? await scaleTarget(argOf('history', 'data/history'))
    : target === 'setups-spotpb' ? await spotPbTarget(argOf('history', 'data/history'), argOf('lead-lag', 'data/models/lead_lag.json'))
    : await setupsTarget(argOf('history', 'data/history'), target === 'setups-short' ? -1 : target === 'setups-vol' ? 0 : 1);
  const out = argOf('out', path.join('data', 'sweeps', `${target}.json`));
  return runSweep(t, { hours: Number(argOf('hours', '2')), epsilon: Number(argOf('epsilon', '0.05')), tolerance: Number(argOf('tolerance', '0.1')), maxPasses: Number(argOf('passes', '6')), ledgerPath: out, meta: extra.meta, log: extra.log });
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void sweepMain();

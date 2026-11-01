// Random sweep of the Kalshi settings (the plan approved on Oct 24): settings sampled at random rather than stepped one at
// a time (only a few of them usually matter, and random sampling finds the good combinations sooner: Bergstra & Bengio
// 2012), each scored by the production backtester as paper trades (10% of the bankroll an order, the accuracy gate, the
// take-profit bench), then judged on days the choice never saw. A proposal, never applied.
//
//   npm run research:random-sweep -- days   --replay data/history-replay --out data/sweep-days [--days 120]
//   npm run research:random-sweep -- run    --stage 1 --recordings data/sweep-days --trials 600 [--shard 0/6] [--sample 40]
//   npm run research:random-sweep -- run    --stage 2|3 --recordings data/sweep-days --from LEDGER,...
//   npm run research:random-sweep -- run    --stage 4 --recordings data/sweep-days --from LEDGER,... --recorded DIR
//   npm run research:random-sweep -- report --recordings data/sweep-days --from LEDGER,... [--out data/sweeps/random-kalshi.json]
//       [--replay-check data/sweeps/replay-check-latest.json]
//   (run also takes --model data/models/model.json --ledger FILE --hours 4 --tape-dir DIR --seed N)
//
// Each trial is a set of bot.env lines (a winner is exactly what the bot would run). The days are split once:
//   - TUNE: the older 70%. HOLDOUT: the newest 30%, seen only by stage 3's finalists and judged once by the report.
//   - stage 1: today's settings, six evidence trials, then random draws, each on a fixed sample of the tune days
//   - stage 2: settings near the 20 best of stage 1, on the same sample
//   - stage 3: the 20 best of stages 1-2 and today's settings on every day (tune and holdout)
//   - stage 4: the best of stage 3 and today's settings on the bot's own recorded days (real order books, where the
//     history replay has minute candles)
// Score: net $ an hour after fees (every hour of the days, traded or not), less half the worst drawdown spread over the
// same hours, so a smooth $3/h beats one that earns $4/h through deep swings. Doing nothing scores 0.
// A candidate is proposed only if all of these hold (otherwise the report says which failed):
//   - profitable on the holdout days, and better there than today's settings
//   - the probability of backtest overfitting (CSCV over the daily P&L of every trial, Bailey et al.) is under 0.3, on
//     the stage 1-2 search and on the finalists alike
//   - the deflated Sharpe ratio of its holdout days (every trial counted) has a probability of at least 0.95
//   - enough trades on the holdout days (MIN_HOLDOUT_TRADES)
//   - the latest replay check is close (the backtester trades as paper does: research/replayCheck.ts), and on the
//     recorded days (stage 4) the candidate makes money and beats today's settings. The history replay rebuilds
//     Kalshi's quotes from minute candles, and the sweeps of Oct 25 accepted settings that made +$400k on $150 there
//     and lost on the recorded day as today's settings did; these two rules would have turned them down.
// Every trial is kept in the ledger (one JSON line each, written as it finishes; a stopped run resumes), failures too.
// The model's calls are the same whatever the strategy settings, so each run records them once per day set (research/
// callTape.ts) and plays them back after.

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pruneTapes } from './callTape';
import { deflatedSharpe, pbo, rng, sharpe } from './stats';

/** One setting: its bot.env name and the values tried. */
export interface SweepDim { env: string; values: string[]; note: string }

// Order size is not swept: paper stays at PAPER_ORDER_FRAC (10%, the owner's floor).
export const SPACE: SweepDim[] = [
  { env: 'STRATEGY_MIN_EDGE', values: ['0.01', '0.015', '0.02', '0.03', '0.04', '0.05', '0.06', '0.08'], note: 'edge needed to enter' },
  { env: 'STRATEGY_TAKER_BUFFER', values: ['0', '0.005', '0.01', '0.02', '0.03', '0.05'], note: 'extra edge to cross the spread' },
  { env: 'STRATEGY_MAKER_BUFFER', values: ['0', '0.005', '0.01', '0.015', '0.02', '0.03'], note: 'maker discount' },
  { env: 'STRATEGY_STYLE', values: ['maker', 'both'], note: 'taker entries on / off' },
  { env: 'EXIT_POLICY', values: ['hold', 'fair_value', 'take_profit', 'confluence_ratchet'], note: 'exit policy (hold = to settlement)' },
  { env: 'STRATEGY_EXIT_MARGIN', values: ['0', '0.005', '0.01', '0.02', '0.03', '0.05'], note: 'model-exit margin' },
  { env: 'PROFIT_TARGET_PCT', values: ['0.05', '0.1', '0.2', '0.3', '0.5'], note: 'take-profit floor' },
  { env: 'PROFIT_GIVE_BACK', values: ['0', '0.2', '0.333', '0.5'], note: 'take-profit give-back' },
  { env: 'TAKE_PROFIT_BENCH', values: ['true', 'false'], note: 'take-profit bench' },
  { env: 'ENTRY_WINDOW_15M', values: ['840,300', '900,300', '840,120', '600,300', '900,450', '840,60', '720,180'], note: '15-minute entry window (s before close)' },
  { env: 'ENTRY_WINDOW_HOURLY', values: ['3300,600', '3600,600', '3300,1200', '2400,600', '3300,300'], note: 'hourly entry window (s before close)' },
  { env: 'HOURLY_MID_BAND', values: ['0.1,0.9', '0.2,0.8', '0.3,0.7', '0.05,0.95'], note: 'hourly price band' },
  { env: 'RISK_MIN_SIDE_PRICE', values: ['0.05', '0.1', '0.15', '0.2', '0.3'], note: 'cheapest side bought (no longshots)' },
  { env: 'RISK_NO_ENTRY_BEFORE_CLOSE_SEC', values: ['15', '30', '60', '120'], note: 'no entry this close to the close' },
  { env: 'STRATEGY_NO_EXIT_BEFORE_CLOSE_SEC', values: ['0', '30', '60', '120'], note: 'no exit this close to the close' },
  { env: 'ACCURACY_GATE', values: ['true', 'false'], note: 'accuracy gate' },
  { env: 'VOL_FALLBACK_MULT', values: ['1', '1.1', '1.15', '1.25', '1.4'], note: 'volatility multiplier' },
  { env: 'STRATEGY_FAST_MOVE_SIGMAS', values: ['1.5', '2', '3', '4'], note: 'fast-move guard' },
  { env: 'HUNT_TARGET_MARGIN', values: ['0.01', '0.02', '0.04'], note: 'ratchet target margin' },
  { env: 'STRATEGY_KELLY_FRACTION', values: ['0.1', '0.25', '0.5'], note: 'Kelly fraction (entry sizing below the paper floor)' },
];

/** Settings first worth testing on the evidence of Oct 22-24 (holding vs taking profits, resting orders only, no
 *  longshots, shorter windows), tried as given before the random ones. */
export const EVIDENCE_TRIALS: Array<Record<string, string>> = [
  { EXIT_POLICY: 'hold' },
  { STRATEGY_STYLE: 'maker' },
  { RISK_MIN_SIDE_PRICE: '0.2' },
  { ENTRY_WINDOW_15M: '600,300', ENTRY_WINDOW_HOURLY: '2400,600' },
  { EXIT_POLICY: 'hold', STRATEGY_STYLE: 'maker', RISK_MIN_SIDE_PRICE: '0.2' },
  { STRATEGY_MIN_EDGE: '0.05', STRATEGY_TAKER_BUFFER: '0.03' },
  // The entry edge moved with the market state (bot/strategy/dynamicEdge.ts), one reading at a time, then together.
  { DYN_EDGE_VOL: '0.02' },
  { DYN_EDGE_CHANGE: '0.03' },
  { DYN_EDGE_SPREAD: '0.5' },
  { DYN_EDGE_FLOW: '0.02' },
  { DYN_EDGE_UNCERTAINTY: '0.5' },
  { DYN_EDGE_VOL: '0.02', DYN_EDGE_CHANGE: '0.03', DYN_EDGE_SPREAD: '0.5', DYN_EDGE_FLOW: '0.02', DYN_EDGE_UNCERTAINTY: '0.5' },
  // The order size moved with the market state (bot/strategy/regimeScale.ts), one reading at a time, then together.
  { REGIME_VOL_TARGET: '0.5' },
  { REGIME_CHANGE_DERISK: '0.5' },
  { REGIME_CORR_DERISK: '0.5' },
  { REGIME_VOL_TARGET: '0.5', REGIME_CHANGE_DERISK: '0.5', REGIME_CORR_DERISK: '0.5' },
];

export const MIN_HOLDOUT_TRADES = 50;
export const TOP_REFINE = 20;
export const PBO_LIMIT = 0.3;
export const DSR_MIN = 0.95;

/** Which days a result covers: the stage 1-2 sample of the tune days, every day, or the bot's own recordings. */
export type Scope = 'sample' | 'all' | 'recorded';

export interface TrialResult {
  id: string; stage: number; scope: Scope; env: Record<string, string>;
  ok: boolean; error?: string; ms: number;
  pnl: number; fees: number; contracts: number; fills: number; trades: number;
  byDay: Record<string, number>; tradesByDay: Record<string, number>; byHour: Record<string, number>;
  /** Diagnostics: decisions evaluated, refills of a pool that ran dry, the exit curve's cross sales and dip buys. */
  diag?: { entryEvaluations: number; refills: number; refillUsd: number; crossSales: number; dipBuys: number };
}

export const trialId = (env: Record<string, string>) => crypto.createHash('sha1').update(JSON.stringify(Object.entries(env).sort())).digest('hex').slice(0, 12);
const key = (t: { id: string; scope: Scope }) => `${t.id}:${t.scope}`;

/** Stage 1: today's settings, the evidence trials, then random draws (every setting drawn on its own) up to `n`. */
export function stage1Trials(n: number, seed = 7): Array<Record<string, string>> {
  const r = rng(seed);
  const out: Array<Record<string, string>> = [{}, ...EVIDENCE_TRIALS];
  const seen = new Set(out.map(trialId));
  for (let guard = 0; out.length < n && guard < n * 20; guard++) {
    const env: Record<string, string> = {};
    for (const d of SPACE) env[d.env] = d.values[Math.floor(r() * d.values.length)];
    const id = trialId(env);
    if (!seen.has(id)) { seen.add(id); out.push(env); }
  }
  return out;
}

/** Stage 2: around each of the best: a few neighbours, each moving one to three settings one step. */
export function stage2Trials(best: Array<Record<string, string>>, perBest = 10, seed = 11, exclude: Set<string> = new Set()): Array<Record<string, string>> {
  const r = rng(seed);
  const out: Array<Record<string, string>> = [];
  const seen = new Set([...best.map(trialId), ...exclude]);
  for (const b of best) {
    for (let k = 0, guard = 0; k < perBest && guard < perBest * 20; guard++) {
      const env = { ...b };
      const moves = 1 + Math.floor(r() * 3);
      for (let m = 0; m < moves; m++) {
        const d = SPACE[Math.floor(r() * SPACE.length)];
        // A setting the trial left out ran today's value (bot.env): one step from it, or any value when it is off the list.
        const i = d.values.indexOf(env[d.env] ?? process.env[d.env] ?? '');
        const j = i < 0 ? Math.floor(r() * d.values.length) : Math.max(0, Math.min(d.values.length - 1, i + (r() < 0.5 ? -1 : 1)));
        env[d.env] = d.values[j];
      }
      const id = trialId(env);
      if (seen.has(id)) continue;
      seen.add(id); out.push(env); k++;
    }
  }
  return out;
}

/** The tape of the model's calls over a day set: everything the calls depend on is in its name (the days, the model,
 *  the volatility the fair value is priced with, the staleness limits, the features read after the call). */
async function tapeFor(dir: string, modelPath: string, tapeDir: string | undefined, sig: unknown[]): Promise<{ file: string; sig: string } | undefined> {
  if (!tapeDir) return undefined;
  const { recordingFiles } = await import('../bot/marketdata/recordingFiles');
  const stat = (f: string, time = false) => { try { const st = fs.statSync(f); return [path.basename(f), st.size, time ? Math.floor(st.mtimeMs) : 0]; } catch { return [path.basename(f), 0, 0]; } };
  const s = crypto.createHash('sha1').update(JSON.stringify([recordingFiles(dir).map((d) => stat(d.file)), stat(modelPath, true), ...sig])).digest('hex');
  return { file: path.join(tapeDir, `rs-${s.slice(0, 20)}.tape`), sig: s };
}

/** One trial: the production backtester over every day in `dir`, as paper with these bot.env lines. */
export async function evalTrial(dir: string, modelPath: string, env: Record<string, string>, stage = 1, scope: Scope = 'sample', tapeDir?: string, extra: { refill?: boolean } = {}): Promise<TrialResult> {
  const t0 = Date.now();
  const base = { id: trialId(env), stage, scope, env, ms: 0, pnl: 0, fees: 0, contracts: 0, fills: 0, trades: 0, byDay: {}, tradesByDay: {}, byHour: {} };
  try {
    const { loadConfig, paperEnv } = await import('../bot/config');
    const { MetaModel } = await import('../bot/model/metaModel');
    const { EXIT_POLICIES } = await import('../bot/strategy/exitPolicies');
    const { engineModels, installProbation, runBacktest } = await import('./backtest');
    const cfg = loadConfig(paperEnv({ ...process.env, DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32), ...env }));
    const model = models.get(modelPath) ?? (fs.existsSync(modelPath) ? MetaModel.load(modelPath) : MetaModel.identity());
    models.set(modelPath, model);
    // The engine's other models, its validation gates and the component trials' verdicts, as the replay check runs them
    // (once a process: a trial does not change them).
    engine ??= engineModels(cfg, { trialsFile: process.env.RS_TRIALS_FILE }).then((m) => { installProbation(cfg, process.env.RS_PROBATION_FILE); return m; });
    const em = await engine;
    const S = cfg.strategy;
    const policy = (EXIT_POLICIES as readonly string[]).includes(S.exitPolicy) ? S.exitPolicy : 'fair_value';
    const rule = { ...cfg.probation, t: cfg.sinuousExit.benchT ?? cfg.probation.t, minTrades: cfg.sinuousExit.benchMinExits ?? cfg.probation.minTrades };
    // The bot's own recorded days start in the middle of its run: the spot candles it held at the first one's start
    // (RS_SEED_CANDLES, fetched for that midnight), so the TA network prices from the first minute as it did in paper.
    // The history replay's days carry their own (research/history/historyReplay.ts), and a seed for another start is not used.
    const { recordingFiles } = await import('../bot/marketdata/recordingFiles');
    const { readSeedCandles } = await import('./seedCandles');
    const first = recordingFiles(dir)[0]?.day;
    const seed = first ? readSeedCandles(process.env.RS_SEED_CANDLES, Date.parse(`${first}T00:00:00Z`)) : undefined;
    const tape = await tapeFor(dir, modelPath, tapeDir, [S.volFallbackMult, S.taVolWeight, cfg.risk.maxBookAgeMs, cfg.risk.maxIndexAgeMs, S.takeGate, S.takeMargin, policy === 'confluence_ratchet', em.sig, Boolean(em.fillModel), seed ? [seed.at, seed.sets.reduce((n, c) => n + c.rows.length, 0)] : null]);
    const r = await runBacktest(dir, model, S, cfg.risk, Number(process.env.SWEEP_BANKROLL_USD ?? cfg.paperBankrollUsd), {
      exitPolicy: policy as never, sessionRisk: em.sessionRisk, huntSessionGuard: S.huntSessionGuard, huntTransitionBufferMin: S.huntTransitionBufferMin,
      sizingTiers: cfg.sizingTiers, paper: { orderFrac: S.paperOrderFrac, orderUsd: S.paperOrderUsd },
      optimalF: cfg.optimalF,
      accuracyGate: S.accuracyGate, takeProfitBench: { enforce: S.takeProfitBench, rule }, takeProfitLevel: { pinned: S.takeProfitLevel, max: S.takeProfitLevelMax },
      // The exit curve as the bot runs it (its cross and dip buy act only when their settings turn them on).
      curveExit: { params: cfg.sinuousExit, rule: { ...cfg.probation, t: cfg.sinuousExit.benchT ?? cfg.probation.t, minTrades: cfg.sinuousExit.benchMinExits ?? cfg.probation.minTrades } }, tape, dailyGoalUsd: cfg.vault.dailyGoalUsd, sessionEdge: cfg.sessionEdge,
      volProfile: em.volProfile, applyVolSeasonality: Boolean(em.volProfile), volModel: em.volModel, fillModel: em.fillModel, calendar: em.calendar,
      taNet: true, trials: em.trials, marketContext: true, ...(seed ? { seedCandles: seed } : {}),
      // Paper refills its pool when it can no longer trade; a comparison over months needs the same or it stops in week one.
      ...(extra.refill ? { refillUsd: cfg.paperBankrollUsd } : {}),
    });
    const byDay: Record<string, number> = {}, tradesByDay: Record<string, number> = {}, byHour: Record<string, number> = {};
    for (const t of r.trades) {
      const iso = new Date(t.closeTs).toISOString();
      byDay[iso.slice(0, 10)] = (byDay[iso.slice(0, 10)] ?? 0) + t.pnl;
      tradesByDay[iso.slice(0, 10)] = (tradesByDay[iso.slice(0, 10)] ?? 0) + 1;
      byHour[iso.slice(0, 13)] = (byHour[iso.slice(0, 13)] ?? 0) + t.pnl;
    }
    return { ...base, ok: true, ms: Date.now() - t0, pnl: r.pnl, fees: r.fees, contracts: r.contracts, fills: r.fills, trades: r.trades.length, byDay, tradesByDay, byHour,
      diag: { entryEvaluations: r.entryEvaluations, refills: r.refills?.length ?? 0, refillUsd: (r.refills ?? []).reduce((a, x) => a + x.usd, 0), crossSales: r.exits.crossSales ?? 0, dipBuys: r.exits.dipBuys ?? 0 } };
  } catch (e) {
    return { ...base, ok: false, error: String((e as Error).message ?? e).slice(0, 300), ms: Date.now() - t0 };
  }
}
const models = new Map<string, import('../bot/model/metaModel').MetaModel>();
let engine: ReturnType<typeof import('./backtest').engineModels> | undefined;

export function readLedgers(files: string[]): TrialResult[] {
  const byKey = new Map<string, TrialResult>();
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const t = JSON.parse(line) as TrialResult; t.scope ??= 'sample'; byKey.set(key(t), t); } catch { /* a torn last line */ }
    }
  }
  return [...byKey.values()];
}

/** Hourly P&L over every hour of `days` (hours without a trade count as 0). */
export function hourly(t: TrialResult, days: string[]): number[] {
  const out: number[] = [];
  for (const d of days) for (let h = 0; h < 24; h++) out.push(t.byHour[`${d}T${String(h).padStart(2, '0')}`] ?? 0);
  return out;
}

export interface Score { perHour: number; sd: number; maxDd: number; score: number; pnl: number; trades: number }
export function scoreOf(t: TrialResult, days: string[]): Score {
  const x = hourly(t, days);
  const n = Math.max(1, x.length);
  const pnl = x.reduce((a, v) => a + v, 0);
  const mean = pnl / n;
  const sd = Math.sqrt(x.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, n - 1));
  let eq = 0, peak = 0, maxDd = 0;
  for (const v of x) { eq += v; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq); }
  const trades = days.reduce((a, d) => a + (t.tradesByDay[d] ?? 0), 0);
  return { perHour: mean, sd, maxDd, score: (pnl - 0.5 * maxDd) / n, pnl, trades };
}

export function splitDays(days: string[], tuneShare = 0.7): { tune: string[]; holdout: string[] } {
  const s = [...days].sort();
  const a = Math.max(1, Math.floor(s.length * tuneShare));
  return { tune: s.slice(0, a), holdout: s.slice(a) };
}

/** The stage 1-2 sample: `n` of the tune days, spread evenly (the same for every shard and run on the same days). */
export function sampleDays(tune: string[], n: number): string[] {
  if (n <= 0 || n >= tune.length) return [...tune];
  return Array.from({ length: n }, (_, i) => tune[Math.floor(((i + 0.5) * tune.length) / n)]);
}

/** The stage 1-2 ranking (on the sample), best first, today's settings included wherever they land. */
export function sampleRanking(trials: TrialResult[], sample: string[]): Array<{ t: TrialResult; s: Score }> {
  return trials.filter((t) => t.ok && t.scope === 'sample').map((t) => ({ t, s: scoreOf(t, sample) })).sort((a, b) => b.s.score - a.s.score);
}

/** CSCV probability of backtest overfitting over these trials' daily P&L (NaN with fewer than 16 days or 2 trials). */
export function pboOf(trials: TrialResult[], days: string[]): number {
  if (trials.length < 2 || days.length < 16) return NaN;
  return pbo(days.map((d) => trials.map((t) => t.byDay[d] ?? 0)), 8).pbo;
}

type Pick = { id: string; env: Record<string, string>; tune: Score; holdout: Score };
export interface SweepReportOut {
  at: string; days: { tune: string[]; holdout: string[]; sample: string[] };
  trials: { sample: number; all: number; recorded: number; failed: number };
  baseline: { tune: Score; holdout: Score } | null;
  /** Stage 1-2's best on the sample (today's settings marked by an empty env). */
  sampleTop: Array<{ id: string; env: Record<string, string>; sample: Score }>;
  /** The finalists on every day, ranked on the tune days. */
  top: Pick[];
  chosen: Pick | null;
  pbo: { search: number | null; finalists: number | null };
  deflated: { sharpe: number; sr0: number; probability: number } | null;
  /** Stage 4: today's settings and the chosen candidate on the bot's own recorded days. */
  recorded: { days: string[]; baseline: { pnl: number; trades: number; contracts: number } | null; chosen: { pnl: number; trades: number; contracts: number } | null } | null;
  /** The replay check's verdict the report was judged with (null: none given or none found). */
  replayCheck: ReplayGate | null;
  accepted: boolean; why: string[];
  /** The bot.env lines of the accepted candidate (empty when none is). */
  envLines: string[];
}

/** The replay check's latest verdict (data/models/sweeps/replay-check-latest.json). */
export interface ReplayGate { close: boolean; why: string[]; from?: string; to?: string }

/** The verdict: finalists ranked on the tune days, the best judged once on the holdout days, the rules applied. `gate`:
 *  the replay check's verdict (null: none found) and whether stage 4's recorded days count; left out, those rules are
 *  not applied (the stage 4 run picks its candidate that way). */
export function report(trials: TrialResult[], days: string[], sampleSize = 40, gate: { replayCheck?: ReplayGate | null; recorded?: boolean } = {}): SweepReportOut {
  const { tune, holdout } = splitDays(days);
  const sample = sampleDays(tune, sampleSize);
  const ok = trials.filter((t) => t.ok);
  const sampled = ok.filter((t) => t.scope === 'sample');
  const finals = ok.filter((t) => t.scope === 'all');
  const rec = ok.filter((t) => t.scope === 'recorded');
  const ranked = sampleRanking(ok, sample);
  const scored = finals.map((t) => ({ t, tune: scoreOf(t, tune), holdout: scoreOf(t, holdout) })).sort((a, b) => b.tune.score - a.tune.score);
  const base = scored.find((x) => Object.keys(x.t.env).length === 0);
  const best = scored[0];
  const why: string[] = [];
  const pSearch = pboOf(sampled, sample), pFinal = pboOf(finals, [...tune, ...holdout]);
  const recOf = (id: string | undefined) => { const t = rec.find((x) => x.id === id); return t ? { pnl: t.pnl, trades: t.trades, contracts: t.contracts } : null; };
  let deflated: SweepReportOut['deflated'] = null;
  if (best) {
    // Every trial tried counts (the search's breadth), with the spread of their Sharpe ratios on the sample.
    const srs = sampled.map((t) => sharpe(sample.map((d) => t.byDay[d] ?? 0))).filter(Number.isFinite);
    const mu = srs.reduce((a, v) => a + v, 0) / Math.max(1, srs.length);
    const v = srs.reduce((a, x) => a + (x - mu) ** 2, 0) / Math.max(1, srs.length - 1);
    const ds = deflatedSharpe(holdout.map((d) => best.t.byDay[d] ?? 0), Math.max(sampled.length, finals.length), v > 0 ? v : undefined);
    deflated = { sharpe: ds.sharpe, sr0: ds.sr0, probability: ds.probability };
  }
  if (!best) why.push(finals.length ? 'no finalist finished' : 'stage 3 (the finalists on every day) has not run');
  else {
    if (!(best.holdout.pnl > 0)) why.push(`not profitable on the holdout days ($${best.holdout.pnl.toFixed(2)})`);
    if (base && !(best.holdout.perHour > base.holdout.perHour)) why.push(`not better than today's settings on the holdout days ($${best.holdout.perHour.toFixed(3)}/h vs $${base.holdout.perHour.toFixed(3)}/h)`);
    if (!base) why.push("today's settings are missing from the finalists");
    for (const [name, p] of [['search', pSearch], ['finalists', pFinal]] as const) {
      if (!(p < PBO_LIMIT)) why.push(`probability of backtest overfitting (${name}) ${Number.isFinite(p) ? p.toFixed(2) : 'n/a (needs 16+ days)'} (limit ${PBO_LIMIT})`);
    }
    if (!(deflated && deflated.probability >= DSR_MIN)) why.push(`deflated Sharpe probability ${deflated && Number.isFinite(deflated.probability) ? deflated.probability.toFixed(2) : 'n/a'} (needs ${DSR_MIN})`);
    if (best.holdout.trades < MIN_HOLDOUT_TRADES) why.push(`only ${best.holdout.trades} trades on the holdout days (needs ${MIN_HOLDOUT_TRADES})`);
    if (gate.replayCheck !== undefined && !gate.replayCheck?.close) why.push(gate.replayCheck ? `the replay check is not close (${gate.replayCheck.why.join('; ') || 'not checked yet'})` : 'no replay check verdict yet');
    if (gate.recorded) {
      const c = recOf(best.t.id), b0 = recOf(trialId({}));
      if (!c) why.push('not replayed on the recorded days (stage 4)');
      else {
        if (!(c.pnl > 0)) why.push(`loses on the recorded days ($${c.pnl.toFixed(2)})`);
        if (b0 && !(c.pnl > b0.pnl)) why.push(`not better than today's settings on the recorded days ($${c.pnl.toFixed(2)} vs $${b0.pnl.toFixed(2)})`);
      }
    }
  }
  const accepted = why.length === 0;
  const pick = (x: (typeof scored)[number]): Pick => ({ id: x.t.id, env: x.t.env, tune: x.tune, holdout: x.holdout });
  const recDays = [...new Set(rec.flatMap((t) => Object.keys(t.byDay)))].sort();
  return {
    at: new Date().toISOString(), days: { tune, holdout, sample },
    trials: { sample: sampled.length, all: finals.length, recorded: rec.length, failed: trials.length - ok.length },
    baseline: base ? { tune: base.tune, holdout: base.holdout } : null,
    sampleTop: ranked.slice(0, TOP_REFINE).map((x) => ({ id: x.t.id, env: x.t.env, sample: x.s })),
    top: scored.slice(0, TOP_REFINE + 1).map(pick), chosen: best ? pick(best) : null,
    pbo: { search: Number.isFinite(pSearch) ? pSearch : null, finalists: Number.isFinite(pFinal) ? pFinal : null }, deflated,
    recorded: rec.length ? { days: recDays, baseline: recOf(trialId({})), chosen: recOf(best?.t.id) } : null,
    replayCheck: gate.replayCheck ?? null,
    accepted, why,
    envLines: accepted && best ? Object.entries(best.t.env).sort().map(([k, v]) => `${k}=${v}`) : [],
  };
}

/** Evaluates the trials of this shard not yet in the ledger, until done or the time budget is spent. */
export async function runTrials(o: { dir: string; modelPath: string; trials: Array<Record<string, string>>; stage: number; scope: Scope; shard: [number, number]; ledger: string; hours: number; workers: number; tapeDir?: string; log?: (m: string) => void }): Promise<{ done: number; skipped: number; left: number }> {
  const log = o.log ?? ((m: string) => console.log(`[random-sweep] ${m}`));
  const have = new Set(readLedgers([o.ledger]).map(key));
  const mine = o.trials.filter((_, i) => i % o.shard[1] === o.shard[0]).filter((e) => !have.has(`${trialId(e)}:${o.scope}`));
  const deadline = Date.now() + o.hours * 3_600_000;
  fs.mkdirSync(path.dirname(o.ledger), { recursive: true });
  if (o.tapeDir) { fs.mkdirSync(o.tapeDir, { recursive: true }); pruneTapes(o.tapeDir, Math.max(0.1, Number(process.env.SWEEP_TAPE_GB ?? 4) || 4) * 1e9); }
  let done = 0, next = 0, ms = 0;
  const { WorkerPool, workerScript } = await import('./workerPool');
  type Job = { dir: string; modelPath: string; env: Record<string, string>; stage: number; scope: Scope; tapeDir?: string };
  const pool = o.workers > 1 ? new WorkerPool<Job, TrialResult>(workerScript('randomSweepWorker'), o.workers) : undefined;
  const one = async (env: Record<string, string>) => (pool ? pool.run({ dir: o.dir, modelPath: o.modelPath, env, stage: o.stage, scope: o.scope, tapeDir: o.tapeDir }) : evalTrial(o.dir, o.modelPath, env, o.stage, o.scope, o.tapeDir));
  const lane = async () => {
    while (next < mine.length && Date.now() < deadline) {
      const env = mine[next++];
      const r = await one(env);
      fs.appendFileSync(o.ledger, JSON.stringify(r) + '\n');
      done++; ms += r.ms;
      if (done % 10 === 0 || done === 1 || !r.ok) log(`stage ${o.stage}: ${done}/${mine.length} trial(s), ${(ms / done / 1000).toFixed(0)} s each${r.ok ? '' : ` (one failed: ${r.error})`}`);
    }
  };
  try { await Promise.all(Array.from({ length: Math.max(1, o.workers) }, lane)); } finally { await pool?.close(); }
  return { done, skipped: o.trials.length - mine.length, left: mine.length - done };
}

function arg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

/** The recorded days in a recordings folder (md-YYYY-MM-DD.jsonl[.gz]). */
async function daysIn(dir: string): Promise<Array<{ day: string; file: string }>> {
  const { recordingFiles } = await import('../bot/marketdata/recordingFiles');
  return fs.existsSync(dir) ? recordingFiles(dir) : [];
}

/** A folder linking just these days of `files`. */
async function linkSubset(files: Array<{ day: string; file: string }>, days: string[], name: string): Promise<string> {
  const { linkDays } = await import('../bot/marketdata/recordingFiles');
  const want = new Set(days);
  const dir = path.join(os.tmpdir(), `random-sweep-${name}-${crypto.createHash('sha1').update(days.join(',')).digest('hex').slice(0, 10)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  linkDays(files.filter((f) => want.has(f.day)), dir);
  return dir;
}

export function printReport(r: SweepReportOut, log = console.log): void {
  const f = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
  const span = (d: string[]) => (d.length ? `${d[0]}..${d[d.length - 1]} (${d.length} d)` : 'none');
  const row = (name: string, s: { tune: Score; holdout: Score }) => log(`${name.padEnd(15)} tune ${f(s.tune.perHour)}/h (score ${f(s.tune.score)}, ${s.tune.trades} trades) | holdout ${f(s.holdout.perHour)}/h, P&L ${f(s.holdout.pnl)}, max drawdown ${s.holdout.maxDd.toFixed(2)}, ${s.holdout.trades} trades`);
  log(`random sweep: ${r.trials.sample} trial(s) on the sample, ${r.trials.all} finalist(s) on every day, ${r.trials.failed} failed`);
  log(`days: tune ${span(r.days.tune)} | sample ${r.days.sample.length} of them | holdout ${span(r.days.holdout)}`);
  if (r.baseline) row("today's", r.baseline);
  r.top.slice(0, 5).forEach((x, i) => row(`#${i + 1} ${x.id}`, x));
  log(`overfitting probability: search ${r.pbo.search === null ? 'n/a' : r.pbo.search.toFixed(2)}, finalists ${r.pbo.finalists === null ? 'n/a' : r.pbo.finalists.toFixed(2)} | deflated Sharpe probability ${r.deflated && Number.isFinite(r.deflated.probability) ? r.deflated.probability.toFixed(2) : 'n/a'}`);
  if (r.chosen) log(`best on the tune days: ${Object.entries(r.chosen.env).map(([k, v]) => `${k}=${v}`).join(' ') || "today's settings"}`);
  if (r.recorded) log(`recorded days ${r.recorded.days.join(', ')}: today's ${r.recorded.baseline ? f(r.recorded.baseline.pnl) : 'n/a'}, chosen ${r.recorded.chosen ? f(r.recorded.chosen.pnl) : 'n/a'}`);
  log(r.accepted ? 'ACCEPTED: proposal written (envLines)' : `NOT ACCEPTED: ${r.why.join('; ')}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const dir = arg('recordings', 'data/sweep-days');
  const from = arg('from', '').split(',').filter(Boolean);
  const sampleSize = Number(arg('sample', '40'));
  if (cmd === 'days') {
    // The days a sweep replays: the newest --days of the history replay that hold real Kalshi contracts.
    const { replayKalshiDays } = await import('./history/historyReplay');
    const replay = arg('replay', 'data/history-replay'), out = arg('out', 'data/sweep-days');
    const kDays = new Set(fs.existsSync(replay) ? replayKalshiDays(replay) : []);
    const use = (await daysIn(replay)).filter((d) => kDays.has(d.day)).slice(-Number(arg('days', '120')));
    const { linkDays } = await import('../bot/marketdata/recordingFiles');
    fs.rmSync(out, { recursive: true, force: true });
    linkDays(use, out);
    console.log(`[random-sweep] ${use.length} replayed day(s) with real Kalshi contracts${use.length ? ` (${use[0].day}..${use[use.length - 1].day})` : ''} -> ${out}`);
    return;
  }
  const files = await daysIn(dir);
  const { tune } = splitDays(files.map((d) => d.day));
  const sample = sampleDays(tune, sampleSize);
  if (cmd === 'run') {
    const stage = Number(arg('stage', '1'));
    const [a, b] = arg('shard', '0/1').split('/').map(Number);
    const prior = readLedgers(from);
    let trials: Array<Record<string, string>>;
    let scope: Scope = 'sample';
    let runDir: string;
    if (stage === 1) {
      trials = stage1Trials(Number(arg('trials', '600')), Number(arg('seed', '7')));
      runDir = await linkSubset(files, sample, 'sample');
    } else if (stage === 2) {
      const ranked = sampleRanking(prior, sample);
      trials = stage2Trials(ranked.slice(0, TOP_REFINE).map((x) => x.t.env), Number(arg('per-best', '10')), Number(arg('seed', '11')), new Set(prior.map((t) => t.id)));
      runDir = await linkSubset(files, sample, 'sample');
    } else if (stage === 3) {
      const ranked = sampleRanking(prior, sample);
      trials = [{}, ...ranked.map((x) => x.t.env).filter((e) => Object.keys(e).length > 0).slice(0, TOP_REFINE)];
      scope = 'all';
      runDir = dir;
    } else {
      const r = report(prior, files.map((d) => d.day), sampleSize);
      trials = r.chosen && Object.keys(r.chosen.env).length ? [{}, r.chosen.env] : [{}];
      scope = 'recorded';
      runDir = arg('recorded', 'data/recordings');
    }
    const { workerCount } = await import('./workerPool');
    const res = await runTrials({
      dir: runDir, modelPath: arg('model', 'data/models/model.json'), trials, stage, scope, shard: [a, b],
      ledger: arg('ledger', path.join('data', 'sweeps', `random-kalshi.s${stage}-${a}.jsonl`)), hours: Number(arg('hours', '4')),
      workers: workerCount(), tapeDir: arg('tape-dir', '') || undefined,
    });
    console.log(`[random-sweep] stage ${stage} shard ${a}/${b}: ${res.done} evaluated, ${res.left} left for the next run`);
    return;
  }
  if (cmd === 'report') {
    // The replay check's verdict file (the workflow copies the server's); missing or unreadable, nothing is accepted.
    const readGate = (f: string): ReplayGate | null => {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        return { close: j.checked !== false && j.close === true, why: j.checked === false ? ['not checked yet'] : Array.isArray(j.why) ? j.why.map(String) : [], from: j.from, to: j.to };
      } catch { return null; }
    };
    const r = report(readLedgers(from), files.map((d) => d.day), sampleSize, { replayCheck: readGate(arg('replay-check', path.join('data', 'sweeps', 'replay-check-latest.json'))), recorded: true });
    const out = arg('out', path.join('data', 'sweeps', 'random-kalshi.json'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(r, null, 1));
    printReport(r);
    return;
  }
  console.error('usage: random-sweep days|run|report (see research/randomSweep.ts)');
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error((e as Error).stack ?? e); process.exitCode = 1; });

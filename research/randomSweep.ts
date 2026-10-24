// Random sweep of the Kalshi settings (the plan approved on Oct 24): settings sampled at random rather than stepped one at
// a time (only a few of them usually matter, and random sampling finds the good combinations sooner: Bergstra & Bengio
// 2012), each scored by the production backtester as paper trades (10% of the bankroll an order, the accuracy gate, the
// take-profit bench), then judged on days the choice never saw. A proposal, never applied.
//
//   npm run research:random-sweep -- run --recordings DIR --trials 600 [--stage 1|2] [--shard 0/4] [--hours 4]
//       [--model data/models/model.json] [--ledger data/sweeps/random-kalshi.s0.jsonl] [--from LEDGER,...] [--seed 7]
//   npm run research:random-sweep -- report --recordings DIR --from LEDGER,... [--out data/sweeps/random-kalshi.json]
//
// Each trial is a set of bot.env lines (so a winner is exactly what the bot would run), replayed over every day in the
// recordings once; the days are split afterwards:
//   - TUNE (the older 70% of the days): the trials are ranked here; stage 2 tries settings near the 20 best
//   - HOLDOUT (the newest 30%): seen only by the report, once
// Score: net $ an hour after fees (every hour of the days, traded or not), less half the worst drawdown spread over the
// same hours, so a smooth $3/h beats one that earns $4/h through deep swings. Doing nothing scores 0.
// A candidate is proposed only if all of these hold (otherwise the report says which failed):
//   - profitable on the holdout days, and better there than today's settings (trial 0)
//   - the probability of backtest overfitting (CSCV over every trial's daily P&L, Bailey et al.) is under 0.3
//   - the deflated Sharpe ratio of its holdout days (every trial counted) has a probability of at least 0.95
//   - enough trades on the holdout days (MIN_HOLDOUT_TRADES)
// Every trial is kept in the ledger (one JSON line each, written as it finishes; a stopped run resumes), failures too.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
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
];

export const MIN_HOLDOUT_TRADES = 50;
export const TOP_REFINE = 20;

export interface TrialResult {
  id: string; stage: number; env: Record<string, string>;
  ok: boolean; error?: string; ms: number;
  pnl: number; fees: number; contracts: number; fills: number; trades: number;
  byDay: Record<string, number>; tradesByDay: Record<string, number>; byHour: Record<string, number>;
}

export const trialId = (env: Record<string, string>) => crypto.createHash('sha1').update(JSON.stringify(Object.entries(env).sort())).digest('hex').slice(0, 12);

/** Stage 1: today's settings, the evidence trials, then `n` random draws (every setting drawn on its own). */
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
export function stage2Trials(best: Array<Record<string, string>>, perBest = 10, seed = 11): Array<Record<string, string>> {
  const r = rng(seed);
  const out: Array<Record<string, string>> = [];
  const seen = new Set(best.map(trialId));
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

/** One trial: the production backtester over every day in `dir`, as paper with these bot.env lines. */
export async function evalTrial(dir: string, modelPath: string, env: Record<string, string>, stage = 1): Promise<TrialResult> {
  const t0 = Date.now();
  const base = { id: trialId(env), stage, env, ms: 0, pnl: 0, fees: 0, contracts: 0, fills: 0, trades: 0, byDay: {}, tradesByDay: {}, byHour: {} };
  try {
    const { loadConfig, paperEnv } = await import('../bot/config');
    const { MetaModel } = await import('../bot/model/metaModel');
    const { EXIT_POLICIES } = await import('../bot/strategy/exitPolicies');
    const { runBacktest } = await import('./backtest');
    const cfg = loadConfig(paperEnv({ ...process.env, DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32), ...env }));
    const model = models.get(modelPath) ?? (fs.existsSync(modelPath) ? MetaModel.load(modelPath) : MetaModel.identity());
    models.set(modelPath, model);
    const S = cfg.strategy;
    const policy = (EXIT_POLICIES as readonly string[]).includes(S.exitPolicy) ? S.exitPolicy : 'fair_value';
    const rule = { ...cfg.probation, t: cfg.sinuousExit.benchT ?? cfg.probation.t, minTrades: cfg.sinuousExit.benchMinExits ?? cfg.probation.minTrades };
    const r = await runBacktest(dir, model, S, cfg.risk, Number(process.env.SWEEP_BANKROLL_USD ?? cfg.paperBankrollUsd), {
      exitPolicy: policy as never, sessionRisk: S.sessionRisk, huntSessionGuard: S.huntSessionGuard, huntTransitionBufferMin: S.huntTransitionBufferMin,
      sizingTiers: cfg.sizingTiers, paper: { orderFrac: S.paperOrderFrac, orderUsd: S.paperOrderUsd },
      accuracyGate: S.accuracyGate, takeProfitBench: { enforce: S.takeProfitBench, rule },
    });
    const byDay: Record<string, number> = {}, tradesByDay: Record<string, number> = {}, byHour: Record<string, number> = {};
    for (const t of r.trades) {
      const iso = new Date(t.closeTs).toISOString();
      byDay[iso.slice(0, 10)] = (byDay[iso.slice(0, 10)] ?? 0) + t.pnl;
      tradesByDay[iso.slice(0, 10)] = (tradesByDay[iso.slice(0, 10)] ?? 0) + 1;
      byHour[iso.slice(0, 13)] = (byHour[iso.slice(0, 13)] ?? 0) + t.pnl;
    }
    return { ...base, ok: true, ms: Date.now() - t0, pnl: r.pnl, fees: r.fees, contracts: r.contracts, fills: r.fills, trades: r.trades.length, byDay, tradesByDay, byHour };
  } catch (e) {
    return { ...base, ok: false, error: String((e as Error).message ?? e).slice(0, 300), ms: Date.now() - t0 };
  }
}
const models = new Map<string, import('../bot/model/metaModel').MetaModel>();

export function readLedgers(files: string[]): TrialResult[] {
  const byId = new Map<string, TrialResult>();
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const t = JSON.parse(line) as TrialResult; byId.set(t.id, t); } catch { /* a torn last line */ }
    }
  }
  return [...byId.values()];
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

export interface SweepReportOut {
  at: string; days: { tune: string[]; holdout: string[] }; trials: number; failed: number;
  baseline: { tune: Score; holdout: Score } | null;
  top: Array<{ id: string; env: Record<string, string>; tune: Score; holdout: Score }>;
  chosen: { id: string; env: Record<string, string>; tune: Score; holdout: Score } | null;
  pbo: number | null; deflated: { sharpe: number; sr0: number; probability: number } | null;
  accepted: boolean; why: string[];
  /** The bot.env lines of the accepted candidate (empty when none is). */
  envLines: string[];
}

/** Rank on the tune days, judge the best once on the holdout days, apply the acceptance rules. */
export function report(trials: TrialResult[], days: string[]): SweepReportOut {
  const ok = trials.filter((t) => t.ok);
  const { tune, holdout } = splitDays(days);
  const scored = ok.map((t) => ({ t, tune: scoreOf(t, tune), holdout: scoreOf(t, holdout) })).sort((a, b) => b.tune.score - a.tune.score);
  const base = scored.find((x) => Object.keys(x.t.env).length === 0);
  const why: string[] = [];
  const best = scored[0];
  // PBO over every trial's daily P&L (rows: days, columns: trials).
  const allDays = [...tune, ...holdout];
  const matrix = allDays.map((d) => ok.map((t) => t.byDay[d] ?? 0));
  const p = ok.length >= 2 && allDays.length >= 16 ? pbo(matrix, 8).pbo : NaN;
  let deflated: SweepReportOut['deflated'] = null;
  if (best) {
    const srs = ok.map((t) => sharpe(tune.map((d) => t.byDay[d] ?? 0))).filter(Number.isFinite);
    const mu = srs.reduce((a, v) => a + v, 0) / Math.max(1, srs.length);
    const v = srs.reduce((a, x) => a + (x - mu) ** 2, 0) / Math.max(1, srs.length - 1);
    const ds = deflatedSharpe(holdout.map((d) => best.t.byDay[d] ?? 0), ok.length, v > 0 ? v : undefined);
    deflated = { sharpe: ds.sharpe, sr0: ds.sr0, probability: ds.probability };
  }
  if (!best) why.push('no trial finished');
  else {
    if (!(best.holdout.pnl > 0)) why.push(`not profitable on the holdout days ($${best.holdout.pnl.toFixed(2)})`);
    if (base && !(best.holdout.perHour > base.holdout.perHour)) why.push(`not better than today's settings on the holdout days ($${best.holdout.perHour.toFixed(2)}/h vs $${base.holdout.perHour.toFixed(2)}/h)`);
    if (!base) why.push("today's settings (trial 0) are missing from the ledger");
    if (!(p < 0.3)) why.push(`probability of backtest overfitting ${Number.isFinite(p) ? p.toFixed(2) : 'n/a (needs 16+ days)'} (limit 0.30)`);
    if (!(deflated && deflated.probability >= 0.95)) why.push(`deflated Sharpe probability ${deflated ? deflated.probability.toFixed(2) : 'n/a'} (needs 0.95)`);
    if (best.holdout.trades < MIN_HOLDOUT_TRADES) why.push(`only ${best.holdout.trades} trades on the holdout days (needs ${MIN_HOLDOUT_TRADES})`);
  }
  const accepted = why.length === 0;
  const pick = (x: (typeof scored)[number]) => ({ id: x.t.id, env: x.t.env, tune: x.tune, holdout: x.holdout });
  return {
    at: new Date().toISOString(), days: { tune, holdout }, trials: trials.length, failed: trials.length - ok.length,
    baseline: base ? { tune: base.tune, holdout: base.holdout } : null,
    top: scored.slice(0, TOP_REFINE).map(pick), chosen: best ? pick(best) : null,
    pbo: Number.isFinite(p) ? p : null, deflated, accepted, why,
    envLines: accepted && best ? Object.entries(best.t.env).sort().map(([k, v]) => `${k}=${v}`) : [],
  };
}

/** Evaluates the trials of this shard not yet in the ledger, until done or the time budget is spent. */
export async function runTrials(o: { dir: string; modelPath: string; trials: Array<Record<string, string>>; stage: number; shard: [number, number]; ledger: string; hours: number; workers: number; log?: (m: string) => void }): Promise<{ done: number; skipped: number; left: number }> {
  const log = o.log ?? ((m: string) => console.log(`[random-sweep] ${m}`));
  const have = new Set(readLedgers([o.ledger]).map((t) => t.id));
  const mine = o.trials.filter((_, i) => i % o.shard[1] === o.shard[0]).filter((e) => !have.has(trialId(e)));
  const deadline = Date.now() + o.hours * 3_600_000;
  fs.mkdirSync(path.dirname(o.ledger), { recursive: true });
  let done = 0, next = 0;
  const { WorkerPool, workerScript } = await import('./workerPool');
  const pool = o.workers > 1 ? new WorkerPool<{ dir: string; modelPath: string; env: Record<string, string>; stage: number }, TrialResult>(workerScript('randomSweepWorker'), o.workers) : undefined;
  const one = async (env: Record<string, string>) => (pool ? pool.run({ dir: o.dir, modelPath: o.modelPath, env, stage: o.stage }) : evalTrial(o.dir, o.modelPath, env, o.stage));
  const lane = async () => {
    while (next < mine.length && Date.now() < deadline) {
      const env = mine[next++];
      const r = await one(env);
      fs.appendFileSync(o.ledger, JSON.stringify(r) + '\n');
      done++;
      if (done % 10 === 0 || !r.ok) log(`${done}/${mine.length} trial(s)${r.ok ? '' : ` (one failed: ${r.error})`}`);
    }
  };
  try { await Promise.all(Array.from({ length: Math.max(1, o.workers) }, lane)); } finally { await pool?.close(); }
  return { done, skipped: o.trials.length - mine.length, left: mine.length - done };
}

function arg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

/** The recorded days in a recordings folder (md-YYYY-MM-DD.jsonl[.gz]). */
async function daysIn(dir: string): Promise<string[]> {
  const { recordingFiles } = await import('../bot/marketdata/recordingFiles');
  return recordingFiles(dir).map((d) => d.day);
}

export function printReport(r: SweepReportOut, log = console.log): void {
  const f = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
  const row = (name: string, s: { tune: Score; holdout: Score }) => log(`${name.padEnd(14)} tune ${f(s.tune.perHour)}/h (score ${f(s.tune.score)}, ${s.tune.trades} trades) | holdout ${f(s.holdout.perHour)}/h, P&L ${f(s.holdout.pnl)}, max drawdown ${s.holdout.maxDd.toFixed(2)}, ${s.holdout.trades} trades`);
  log(`random sweep: ${r.trials} trial(s), ${r.failed} failed | tune ${r.days.tune[0]}..${r.days.tune[r.days.tune.length - 1]} (${r.days.tune.length} d) | holdout ${r.days.holdout[0]}..${r.days.holdout[r.days.holdout.length - 1]} (${r.days.holdout.length} d)`);
  if (r.baseline) row("today's", r.baseline);
  r.top.slice(0, 5).forEach((x, i) => row(`#${i + 1} ${x.id}`, x));
  log(`overfitting probability ${r.pbo === null ? 'n/a' : r.pbo.toFixed(2)} | deflated Sharpe probability ${r.deflated ? r.deflated.probability.toFixed(2) : 'n/a'}`);
  if (r.chosen) log(`best on the tune days: ${Object.entries(r.chosen.env).map(([k, v]) => `${k}=${v}`).join(' ') || "today's settings"}`);
  log(r.accepted ? 'ACCEPTED: proposal written (envLines)' : `NOT ACCEPTED: ${r.why.join('; ')}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const dir = arg('recordings', 'data/recordings');
  const from = arg('from', '').split(',').filter(Boolean);
  if (cmd === 'run') {
    const stage = Number(arg('stage', '1'));
    const [a, b] = arg('shard', '0/1').split('/').map(Number);
    let trials: Array<Record<string, string>>;
    if (stage === 1) trials = stage1Trials(Number(arg('trials', '600')), Number(arg('seed', '7')));
    else {
      const r = report(readLedgers(from), await daysIn(dir));
      trials = stage2Trials(r.top.map((x) => x.env), Number(arg('per-best', '10')), Number(arg('seed', '11')));
    }
    const { workerCount } = await import('./workerPool');
    const res = await runTrials({ dir, modelPath: arg('model', 'data/models/model.json'), trials, stage, shard: [a, b], ledger: arg('ledger', path.join('data', 'sweeps', `random-kalshi.s${stage}-${a}.jsonl`)), hours: Number(arg('hours', '4')), workers: workerCount() });
    console.log(`[random-sweep] stage ${stage} shard ${a}/${b}: ${res.done} evaluated, ${res.left} left for the next run`);
    return;
  }
  if (cmd === 'days') {
    // The days a sweep replays: the newest --days of the history replay that hold real Kalshi contracts, and every day
    // the bot recorded itself (its own recording wins a day both have: real books instead of minute candles).
    const { recordingFiles, linkDays } = await import('../bot/marketdata/recordingFiles');
    const { replayKalshiDays } = await import('./history/historyReplay');
    const replay = arg('replay', 'data/history-replay'), out = arg('out', 'data/sweep-days');
    const recorded = fs.existsSync(dir) ? recordingFiles(dir) : [];
    const own = new Set(recorded.map((d) => d.day));
    const kDays = new Set(fs.existsSync(replay) ? replayKalshiDays(replay) : []);
    const fromReplay = (fs.existsSync(replay) ? recordingFiles(replay) : []).filter((d) => kDays.has(d.day) && !own.has(d.day)).slice(-Number(arg('days', '120')));
    fs.rmSync(out, { recursive: true, force: true });
    linkDays([...fromReplay, ...recorded].sort((a, b) => a.day.localeCompare(b.day)), out);
    console.log(`[random-sweep] ${fromReplay.length} replayed day(s) with real Kalshi contracts${fromReplay.length ? ` (${fromReplay[0].day}..${fromReplay[fromReplay.length - 1].day})` : ''} + ${recorded.length} recorded day(s) -> ${out}`);
    return;
  }
  if (cmd === 'report') {
    const r = report(readLedgers(from), await daysIn(dir));
    const out = arg('out', path.join('data', 'sweeps', 'random-kalshi.json'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(r, null, 1));
    printReport(r);
    return;
  }
  console.error('usage: random-sweep run|report (see research/randomSweep.ts)');
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error((e as Error).stack ?? e); process.exitCode = 1; });

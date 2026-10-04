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
// The ledger is saved after every step, so a stopped sweep resumes where it left off.
//
// Targets:
//   setups-long / setups-short   the 1h momentum burst per side (bot/setups/detectors.ts BURST): entry
//                                thresholds and exits, scored by the t-statistic of net R per trade on
//                                years of candle history (all coins, order flow, the real fees)
//   setups-vol                   the volatility-adapted trail (bot/setups/detectors.ts VOL_ADAPT): how
//                                much the TA network's 4h volatility forecast (walk-forward export,
//                                research/taNetOos.ts) widens / tightens fast-lane trails; both sides
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

import fs from 'fs';
import os from 'os';
import path from 'path';

export interface SweepParam { name: string; values: number[]; get(): number; set(v: number): void }
export interface Fitness { score: number; n: number; mean?: number }
export type SweepWindow = 'tune' | 'check' | 'final';
export interface SweepTarget {
  name: string;
  params: SweepParam[];
  /** Fewest trades / windows for a score to count. */
  minN: number;
  fitness(w: SweepWindow): Promise<Fitness>;
  /** Current settings (for the proposal). */
  snapshot(): Record<string, number>;
}

export interface SweepOpts { hours: number; epsilon: number; tolerance: number; maxPasses: number; ledgerPath?: string; log?: (m: string) => void }
export interface SweepStep { pass: number; param: string; from: number; to: number; tune: Fitness; check: Fitness; accepted: boolean; ts: string }
export interface SweepReport {
  target: string; started: string; finished: string; passes: number; evaluations: number; plateau: boolean;
  start: { settings: Record<string, number>; tune: Fitness; check: Fitness; final: Fitness };
  end: { settings: Record<string, number>; tune: Fitness; check: Fitness; final: Fitness };
  steps: SweepStep[];
}

const fmt = (f: Fitness) => `score ${f.score.toFixed(3)} (n ${f.n}${f.mean !== undefined ? `, mean ${f.mean.toFixed(3)}` : ''})`;

/** t-statistic of a sample (mean / standard error). */
export function tStat(xs: number[]): Fitness {
  const n = xs.length;
  if (n < 2) return { score: -Infinity, n, mean: n ? xs[0] : NaN };
  const m = xs.reduce((a, v) => a + v, 0) / n, sd = Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / (n - 1));
  return { score: sd > 0 ? m / (sd / Math.sqrt(n)) : 0, n, mean: m };
}

export async function runSweep(t: SweepTarget, o: SweepOpts): Promise<SweepReport> {
  const log = o.log ?? ((m: string) => console.log(`[sweep] ${m}`));
  const deadline = Date.now() + o.hours * 3_600_000;
  const valid = (f: Fitness) => f.n >= t.minN && Number.isFinite(f.score);
  let evaluations = 0;
  const ev = async (w: SweepWindow) => { evaluations++; return t.fitness(w); };
  // Resume: re-apply the accepted settings of a previous run with the same target.
  let prior: SweepReport | undefined;
  if (o.ledgerPath && fs.existsSync(o.ledgerPath)) {
    try { prior = JSON.parse(fs.readFileSync(o.ledgerPath, 'utf8')) as SweepReport; } catch { prior = undefined; }
    if (prior?.target === t.name) { for (const p of t.params) if (prior.end.settings[p.name] !== undefined) p.set(prior.end.settings[p.name]); log(`resuming ${o.ledgerPath} (${prior.steps.length} steps so far)`); }
    else prior = undefined;
  }
  const startSettings = prior?.start.settings ?? t.snapshot();
  const startScores = prior?.start ?? await (async () => {
    const snap = t.snapshot();
    for (const p of t.params) p.set(startSettings[p.name]);
    const s = { tune: await ev('tune'), check: await ev('check'), final: await ev('final') };
    for (const p of t.params) p.set(snap[p.name]);
    return s;
  })();
  let tune = await ev('tune'), check = await ev('check');
  log(`start: tune ${fmt(tune)} | check ${fmt(check)}`);
  const steps: SweepStep[] = prior?.steps ?? [];
  const started = prior?.started ?? new Date().toISOString();
  let pass = prior?.passes ?? 0, plateau = false;
  const save = (final?: Fitness): SweepReport => {
    const r: SweepReport = {
      target: t.name, started, finished: new Date().toISOString(), passes: pass, evaluations: (prior?.evaluations ?? 0) + evaluations, plateau,
      start: { settings: startSettings, tune: startScores.tune, check: startScores.check, final: startScores.final },
      end: { settings: t.snapshot(), tune, check, final: final ?? { score: NaN, n: 0 } },
      steps,
    };
    if (o.ledgerPath) { fs.mkdirSync(path.dirname(o.ledgerPath), { recursive: true }); fs.writeFileSync(o.ledgerPath, JSON.stringify(r, null, 1)); }
    return r;
  };
  while (pass < o.maxPasses && Date.now() < deadline) {
    pass++;
    let changed = 0;
    for (const p of t.params) {
      if (Date.now() >= deadline) break;
      const cur = p.get();
      let best: { v: number; tune: Fitness; check: Fitness } | undefined;
      for (const v of p.values) {
        if (v === cur || Date.now() >= deadline) continue;
        p.set(v);
        const ft = await ev('tune');
        if (!valid(ft) || ft.score < (best?.tune.score ?? tune.score) + o.epsilon) continue;
        const fc = await ev('check');
        if (!valid(fc) || fc.score < check.score - o.tolerance) continue;
        best = { v, tune: ft, check: fc };
      }
      p.set(best ? best.v : cur);
      steps.push({ pass, param: p.name, from: cur, to: best?.v ?? cur, tune: best?.tune ?? tune, check: best?.check ?? check, accepted: Boolean(best), ts: new Date().toISOString() });
      if (best) { changed++; tune = best.tune; check = best.check; log(`pass ${pass}: ${p.name} ${cur} -> ${best.v}: tune ${fmt(tune)} | check ${fmt(check)}`); }
      save();
    }
    if (!changed) { plateau = true; log(`pass ${pass}: no change accepted - plateau`); break; }
  }
  const final = await ev('final');
  const r = save(final);
  log(`end after ${pass} pass(es), ${r.evaluations} evaluations${plateau ? ' (plateau)' : ' (budget)'}: tune ${fmt(tune)} | check ${fmt(check)} | FINAL ${fmt(final)} (start: final ${fmt(startScores.final)})`);
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

/** Kalshi contracts through the production backtester. Windows: the recorded days split 70 / 15 / 15. */
export async function kalshiTarget(recordings: string, modelPath: string): Promise<SweepTarget> {
  const { runBacktest } = await import('./backtest');
  const { loadConfig } = await import('../bot/config');
  const { MetaModel } = await import('../bot/model/metaModel');
  const cfg = loadConfig({ ...process.env, DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32), TRADING_MODE: 'paper' });
  const model = fs.existsSync(modelPath) ? MetaModel.load(modelPath) : MetaModel.identity();
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
  const num = (k: 'minEdge' | 'takerBuffer' | 'makerBuffer' | 'exitMargin' | 'kellyFraction' | 'targetEvUsd' | 'targetEvOfRisk', values: number[]): SweepParam => ({ name: `strategy.${k}`, values, get: () => S[k], set: (v) => { S[k] = v; } });
  return {
    name: 'kalshi',
    minN: 30,
    params: [
      num('minEdge', [0.01, 0.015, 0.02, 0.03, 0.04, 0.05]), num('takerBuffer', [0, 0.005, 0.01, 0.02, 0.03]), num('makerBuffer', [0, 0.005, 0.01, 0.015, 0.02]),
      num('exitMargin', [0, 0.005, 0.01, 0.02, 0.03]), num('kellyFraction', [0.1, 0.15, 0.25, 0.35, 0.5]), num('targetEvOfRisk', [0.1, 0.25, 0.5, 0.75]),
    ],
    snapshot: () => ({ 'strategy.minEdge': S.minEdge, 'strategy.takerBuffer': S.takerBuffer, 'strategy.makerBuffer': S.makerBuffer, 'strategy.exitMargin': S.exitMargin, 'strategy.kellyFraction': S.kellyFraction, 'strategy.targetEvUsd': S.targetEvUsd, 'strategy.targetEvOfRisk': S.targetEvOfRisk }),
    async fitness(w) {
      const res = await runBacktest(dirs[w], model, { ...S }, cfg.risk, cfg.paperBankrollUsd, {
        sessionRisk: S.sessionRisk, huntSessionGuard: S.huntSessionGuard, huntTransitionBufferMin: S.huntTransitionBufferMin,
        vault: cfg.vault.enabled ? cfg.vault : undefined, sizingTiers: cfg.sizingTiers,
      });
      return tStat([...res.windows.values()].filter((x) => x.contracts > 0).map((x) => x.pnl));
    },
  };
}

/** The whole bot over the recordings. Windows: the recorded days split 70 / 15 / 15. */
export async function botTarget(recordings: string, history: string, modelPath: string, setupOos: string, setupModelPath?: string): Promise<SweepTarget> {
  const { loadWholeBot, runWholeBot, settingsFromConfig, recordedDays } = await import('./wholeBot');
  const n = recordedDays(recordings).length;
  if (n < 20) throw new Error(`only ${n} recorded day(s) in ${recordings}: the whole-bot sweep needs at least 20`);
  const D = await loadWholeBot({ recordings, history, setupOos, modelPath, split: { tune: [0, 0.7], check: [0.7, 0.85], final: [0.85, 1] } });
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

export async function sweepMain(argOf: (k: string, d: string) => string = cliArg): Promise<SweepReport> {
  const target = argOf('target', 'setups-long');
  const t = target === 'kalshi' ? await kalshiTarget(argOf('recordings', 'data/recordings'), argOf('model', 'params/model.json'))
    : target === 'bot' ? await botTarget(argOf('recordings', 'data/recordings'), argOf('history', 'data/history'), argOf('model', 'params/model.json'), argOf('setup-oos', 'data/models/setup_oos.json'), argOf('setup-model', '') || undefined)
    : await setupsTarget(argOf('history', 'data/history'), target === 'setups-short' ? -1 : target === 'setups-vol' ? 0 : 1);
  const out = argOf('out', path.join('data', 'sweeps', `${target}.json`));
  return runSweep(t, { hours: Number(argOf('hours', '2')), epsilon: Number(argOf('epsilon', '0.05')), tolerance: Number(argOf('tolerance', '0.1')), maxPasses: Number(argOf('passes', '6')), ledgerPath: out });
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void sweepMain();

// Automated training pipeline: every research step in the right order, with the right inputs,
// promoting the results to AUTO_TRAIN_DIR (data/models), where the running bot picks them up
// without a restart (bot/autotrain.ts).
//
// The TA network and three isolated SNNs inform, the decision models decide. Each network (crypto, perps, tennis)
// reads only its own domain's inputs and is read only by its own decision model (MLP, perps model,
// tennis model), so every network comes FIRST and each model that reads it is retrained after it:
//
//   0a. history      refresh the historical candle store (Binance Vision + Coinbase backfill) for
//                    every crypto asset Kalshi lists (HISTORY_AUTO_UPDATE; needs internet)
//   0a'. history_replay  (HISTORY_REPLAY) years of 1-minute spot / perp history, funding and Kalshi's settled
//                    contracts written as recordings (research/history/historyReplay.ts) that the recording-
//                    based steps replay like live data, with synthetic 15-minute / hourly contracts built
//                    from the price path where Kalshi's history has none; the perps step, both networks'
//                    tournaments and training, and the sweeps (on the days with real contracts) use them
//   0b. ta_net       TA network on years of hourly history (bot/ta/taNet.ts): a tournament of three
//                    networks initialises it, later runs continue the tournament as new months
//                    arrive (every TA_NET_RETRAIN_DAYS) -> promote ta_net.json; its forecasts are
//                    features of vol_model, mlp and perps below (kept only if their validation improves)
//   0c. ta_net_oos   walk-forward forecasts of that network over all history (research/taNetOos.ts),
//                    extended month by month -> inputs of the setup scorer; promote ta_net_wf.json (the
//                    walking network, read live by the setup trader)
//   0d. setups       setup scorer for the fast / slow lanes (TA network inputs kept only if they help)
//   0e. setup_snn    does the perps SNN help the setup trader? Tested on the bot's own setup journal
//                    (research/setupSnnStudy.ts); writes setup_snn_gate.json, on only once proven
//   0f. sweep        sweep optimizer proposals (setups per side, the volatility trail, kalshi, the whole bot)
//   1. snn           per replayable network (crypto: 15m/1h with contracts; perps: 1h/4h, graded on
//                    direction calls): ablation when due -> population tournament of identical networks
//                    (snnPbt.ts; the elite's knobs) -> train at the best accepted stage -> promote
//                    snn_<domain>.json -> prequential backfill (work/snnfill/<domain>). Tournament and
//                    training on the history replay when it has the days; the crypto network's ablation
//                    (its gate for live use) always on the bot's recordings, against real Kalshi prices.
//                    The tennis network learns live only (no recorded score feed to replay).
//   2. vol_model     tree-based volatility forecast (sigma multiplier for fair value) -> promote
//   3. dataset       research:dataset (with the crypto network's logged/backfilled outputs)
//   4. mlp           research:train (MLP fair value + take/skip head, tree candidates) -> backtest -> promote
//   5. vol           intraday volatility profile -> promote
//   6. perps         perp-train (perps network's 1h/4h calls; MLP/tree candidates) -> perp-backtest -> promote
//   7. tennis        tennis model (4 signals, score, book, tennis network; MLP vs trees) -> promote
//   8. fill          fill / adverse-selection model from the bot's own maker quotes: skipped until
//                    enough quotes and fills exist, promoted once it beats the base rate on holdout;
//                    the engine starts using it the moment a validated file appears.
//
// A new network triggers the retrain of its own consumer only (the bot watches snn_<domain>.json,
// AUTO_TRAIN_ON_MODEL_CHANGE).
//
//   npm run pipeline                         # everything
//   npm run pipeline -- --only mlp,perps     # steps: history, history_replay, ta_net, ta_net_oos, setups, setup_snn, sweep, snn, vol_model, dataset, mlp, vol, perps, tennis, fill, sizing
//   npm run pipeline -- --force-ablation     # re-run the SNN ablations even if not due
//   npm run pipeline -- --only ta_net --force-ta-net   # retrain the TA network now

import { loadRuleBookHistory, ruleBookSummary, runRuleBook } from './ruleBook';
import { tuneSizingMain } from './tuneSizing';
import { promoteIfChampion } from './champion';
import fs from 'fs';
import path from 'path';
import { MODEL_FILES } from '../bot/autotrain';
import { loadConfig, type Config } from '../bot/config';
import { MetaModel } from '../bot/model/metaModel';
import { PerpModel } from '../bot/perps/perpSignal';
import type { SnnCheckpoint } from '../bot/snn/network';
import { DEFAULT_SNN, domainParams, STAGES, stageFlags, type SnnDomain, type Stage } from '../bot/snn/params';
import { FillModel } from '../bot/tca/fillModel';
import { trainFillMain } from './trainFillModel';
import { trainVolModelMain } from './trainVolModel';
import { backtestMain } from './backtest';
import { buildDatasetMain } from './buildDataset';
import { perpBacktestMain } from './perpBacktest';
import { sessionsMain } from './sessions';
import { snnAblationMain, type Verdict } from './snnAblation';
import { replaySnn } from './snnReplay';
import { trainMetaModelMain } from './trainMetaModel';
import { trainPerpMain } from './trainPerpModel';
import { trainSnnMain } from './trainSnn';
import { runSnnPbt } from './snnPbt';
import { withSnnHyper } from '../bot/snn/population';
import { versionHash } from '../bot/snn/params';
import { trainTennisMain } from './trainTennisModel';
import { trainTaNetMain } from './trainTaNet';
import { trainSetupMain } from './trainSetupModel';
import { sweepMain } from './sweep';
import { collectFiles, importFile } from './history/importCsv';
import { downloadKalshiHistory } from './history/kalshiHistory';
import { tvFill } from './history/tradingview';
import { linkDays, recordingDayList, recordingsUsage } from '../bot/marketdata/recordingFiles';
import { readJournalTrades } from '../bot/setups/journal';
import { setupSnnMain, SNN_GATE_MIN_TRADES } from './setupSnnStudy';
import { exportTaNetOos, oosDir } from './taNetOos';
import { BINANCE_INDEXES, downloadBinance, downloadBinanceFunding, type BinanceMarket } from './history/binanceVision';
import { buildHistoryReplay, perpSpecsFromRecordings, replayKalshiDays } from './history/historyReplay';
import { workerCount } from './workerPool';
import { compareIndexSources } from '../bot/marketdata/historyStore';
import { backfillCoinbase } from './history/coinbaseBackfill';
import { resolveAssets } from './history/assets';
import { storedAssets, type HistTf } from './history/candles';
import { setTaNet, TaNet, taNetFileSchema, TANET_SCHEMA } from '../bot/ta/taNet';

export const STEPS = ['history', 'history_replay', 'ta_net', 'ta_net_oos', 'rule_book', 'setups', 'setup_snn', 'sweep', 'snn', 'vol_model', 'dataset', 'mlp', 'vol', 'perps', 'tennis', 'fill', 'sizing'] as const;
export type Step = typeof STEPS[number];

/** Per replayable network. */
export interface SnnDomainState {
  lastAblation?: number;
  stage?: Stage;
  version?: string;
  /** Last day fully backfilled with prequential outputs, and the stage of that backfill. */
  backfillThrough?: string;
  backfillStage?: Stage;
  /** Params version the backfill was made with (changes when the tournament picks new knobs). */
  backfillVersion?: string;
  /** Population tournament: the elite's knobs, the stage they were found for, when, and progress. */
  pbtHyper?: Record<string, number>;
  pbtStage?: Stage;
  pbtAt?: number;
  pbtComplete?: boolean;
}

export const REPLAYABLE: Exclude<SnnDomain, 'tennis'>[] = ['crypto', 'perps'];

export interface PipelineState {
  lastRun?: number;
  mlpId?: string;
  snn?: Partial<Record<SnnDomain, SnnDomainState>>;
  /** Promoted network version per domain. */
  snnVersions?: Partial<Record<SnnDomain, string>>;
  /** Network version whose outputs each consumer (crypto = MLP, perps, tennis) was trained with. */
  trainedWithSnn?: Partial<Record<SnnDomain, string>>;
  /** Promoted TA network, when it was trained, and the version the MLP was trained with. */
  taNetVersion?: string;
  taNetTrainedAt?: number;
  trainedWithTaNet?: string;
  /** false while the TA network's initial tournament is still running (chunked over daily runs). */
  taNetComplete?: boolean;
  /** Promoted setup model (fast / slow lanes) and when it was trained. */
  setupsVersion?: string;
  setupsTrainedAt?: number;
  /** Last rule-book study (research/ruleBook.ts, weekly). */
  ruleBookAt?: number;
  /** What the recordings make testable so far (see the readiness block of each report). */
  readiness?: Readiness;
  /** Last sweep run per target. */
  sweptAt?: Record<string, number>;
  lastHistoryUpdate?: number;
  /** Spot holes already sent to TradingView (asset|tf|missing -> when), retried weekly. */
  tvTried?: Record<string, number>;
  /** Seed history files already imported (name:size list). */
  historySeed?: string;
  lastReport?: string;
}

/** Data-growth progress: which recording-based steps can run, and how far the others are. */
export interface Readiness {
  recordedDays: number; firstDay: string | null; lastDay: string | null; recordingsGb: number; freeGb: number | null;
  /** Per step that needs recordings: days or trades it has / needs. */
  gates: Record<string, { have: number; need: number; ready: boolean }>;
}

/** Thrown by a step that has nothing to do yet (e.g. no perp quotes recorded): reported as skipped. */
export class SkipStep extends Error {}

export interface StepResult { step: string; ok: boolean; skipped?: string; ms: number; detail?: unknown; error?: string }

export function readState(dir: string): PipelineState {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'pipeline_state.json'), 'utf8')); } catch { return {}; }
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Recording days present (md-YYYY-MM-DD.jsonl or .jsonl.gz), sorted. */
export function recordingDays(dir: string): string[] {
  return recordingDayList(dir);
}

const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const nextDay = (d: string) => new Date(dayMs(d) + 86_400_000).toISOString().slice(0, 10);
const argsOf = (o: Record<string, string | number | undefined>) => (k: string, d: string) => (o[k] === undefined || o[k] === '' ? d : String(o[k]));

/** Highest stage k such that S1..Sk were all accepted; 0 if S1 failed. */
export function acceptedChain(verdicts: Verdict[]): number {
  let k = 0;
  for (let s = 1; s <= 6; s++) {
    const v = verdicts.find((x) => x.mechanism.startsWith(`S${s} `));
    if (!v?.accepted) break;
    k = s;
  }
  return k;
}

export interface PipelineOpts {
  cfg?: Readonly<Config>; only?: Step[]; forceAblation?: boolean; now?: number; log?: (m: string) => void;
  /** Restrict the SNN ablation to mechanisms whose name starts with this (testing). */
  ablationOnly?: string;
  /** Retrain the TA network even if it is not due. */
  forceTaNet?: boolean;
  /** Restart the TA network's population tournament from scratch. */
  forceTaNetFresh?: boolean;
  /** Re-run the SNN population tournaments even if not due. */
  forceSnnPbt?: boolean;
}

export async function runPipeline(o: PipelineOpts = {}): Promise<{ steps: StepResult[]; state: PipelineState; report: string }> {
  const cfg = o.cfg ?? loadConfig({ ...process.env, DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32), TRADING_MODE: 'paper' });
  const A = cfg.autoTrain;
  const log = o.log ?? ((m: string) => console.log(`[pipeline] ${m}`));
  const now = o.now ?? Date.now();
  const work = path.join(A.dir, 'work');
  const fillRoot = path.join(work, 'snnfill');
  const fillDir = (d: SnnDomain) => path.join(fillRoot, d);
  for (const d of REPLAYABLE) fs.mkdirSync(fillDir(d), { recursive: true });
  const state = readState(A.dir);
  const steps: StepResult[] = [];
  const want = (s: Step) => !o.only?.length || o.only.includes(s);
  const rec = A.recordingsDir;
  const days = recordingDays(rec);
  const promoted = (name: keyof typeof MODEL_FILES) => path.join(A.dir, MODEL_FILES[name]);
  const report = path.join(A.dir, 'reports', `pipeline-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`);
  // Progress is saved after every step (state and a partial report), so a run cut short (a deploy restarts
  // the bot and the pipeline with it) keeps what its finished steps produced instead of starting over.
  const checkpoint = (complete: boolean) => {
    try {
      writeAtomic(report, JSON.stringify({ at: new Date(now).toISOString(), complete, recordings: rec, days: days.length, readiness: state.readiness, promote: A.promote, steps }, null, 1));
      writeAtomic(path.join(A.dir, 'pipeline_state.json'), JSON.stringify({ ...state, lastReport: report }, null, 1));
    } catch (e) { log(`checkpoint failed: ${(e as Error).message}`); }
  };
  const run = async (step: string, fn: () => Promise<unknown>, skip?: string) => {
    const t0 = Date.now();
    if (skip) { steps.push({ step, ok: true, skipped: skip, ms: 0 }); log(`${step}: skipped (${skip})`); return undefined; }
    log(`${step}: running...`);
    try {
      const detail = await fn();
      steps.push({ step, ok: true, ms: Date.now() - t0, detail });
      log(`${step}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      checkpoint(false);
      return detail;
    } catch (e) {
      if (e instanceof SkipStep) { steps.push({ step, ok: true, skipped: e.message, ms: Date.now() - t0 }); log(`${step}: skipped (${e.message})`); return undefined; }
      steps.push({ step, ok: false, ms: Date.now() - t0, error: (e as Error).stack ?? String(e) });
      log(`${step}: FAILED: ${(e as Error).message}`);
      checkpoint(false);
      return undefined;
    }
  };
  const tooFew = days.length < A.minDays ? `only ${days.length} day(s) of recordings in ${rec} (< AUTO_TRAIN_MIN_DAYS=${A.minDays})` : undefined;
  const lastDays = (n: number) => (days.length ? days.slice(-n) : []);
  // How far the recordings have grown (and what that unlocks): reported every run.
  {
    const u = recordingsUsage(rec);
    const journalTrades = readJournalTrades(path.join(cfg.dataDir, 'setups')).filter((t) => t.snn_up1 !== null || t.snn_up4 !== null).length;
    const g = (have: number, need: number) => ({ have, need, ready: have >= need });
    state.readiness = {
      recordedDays: days.length, firstDay: days[0] ?? null, lastDay: days[days.length - 1] ?? null, recordingsGb: +(u.bytes / 1e9).toFixed(2), freeGb: u.freeBytes !== undefined ? +(u.freeBytes / 1e9).toFixed(1) : null,
      gates: {
        'snn / mlp / perps / vol_model (AUTO_TRAIN_MIN_DAYS)': g(days.length, A.minDays),
        'sweep kalshi': g(days.length, 20), 'sweep bot (whole-bot replay)': g(days.length, 20),
        'setup_snn gate': g(journalTrades, SNN_GATE_MIN_TRADES),
      },
    };
    log(`recordings: ${days.length} day(s)${days.length ? ` ${days[0]}..${days[days.length - 1]}` : ''}, ${state.readiness.recordingsGb} GB${state.readiness.freeGb !== null ? `, ${state.readiness.freeGb} GB free` : ''}; ${Object.entries(state.readiness.gates).map(([k, v]) => `${k} ${v.have}/${v.need}`).join(', ')}`);
  }
  const mlpPath = () => (fs.existsSync(promoted('mlp')) ? promoted('mlp') : fs.existsSync(cfg.paramsPath) ? cfg.paramsPath : undefined);

  // ---- 0. History and the TA network (no recordings needed: years of exchange candles) ----
  const T = cfg.taNet;
  const taNetFile = promoted('ta_net');
  const installTaNet = () => {
    if (!T.enabled) { setTaNet(undefined); return; }
    // The promoted network, or the shipped one while the promoted file predates this build's inputs.
    const file = fs.existsSync(taNetFile) && taNetFileSchema(taNetFile) === TANET_SCHEMA ? taNetFile : fs.existsSync(T.modelPath) ? T.modelPath : undefined;
    try { setTaNet(file ? TaNet.load(file) : undefined, T.requireValidated); } catch (e) { log(`TA network not loaded: ${(e as Error).message}`); setTaNet(undefined); }
  };
  installTaNet();
  // Seed history shipped with the release (deploy/seed/history: Yahoo daily bars from before Binance's
  // archives start), imported once per file version; lowest source priority, so it only fills gaps.
  if (want('history')) {
    await run('history-seed', async () => {
      const dir = path.resolve('deploy', 'seed', 'history');
      if (!fs.existsSync(dir)) throw new SkipStep('no seed history in this release');
      const files = collectFiles([dir]);
      const sig = files.map((f) => `${path.basename(f)}:${fs.statSync(f).size}`).join('|');
      if (state.historySeed === sig) throw new SkipStep('seed history already imported');
      const res = files.flatMap((f) => importFile(f, { out: T.historyDir }));
      state.historySeed = sig;
      return res.map((r) => ({ file: path.basename(r.file), ok: r.ok, asset: r.asset, tf: r.tf, error: r.error }));
    });
  }
  if (want('history')) {
    await run('history', async () => {
      const assets = await resolveAssets(T.historyAssets, { log });
      const bin = await downloadBinance({ out: T.historyDir, assets, intervals: T.binanceIntervals as HistTf[], markets: ['spot' as BinanceMarket], log: (m) => log(`binance: ${m}`) });
      // Binance's BTC dominance index (BTC vs the top-20 alts): an input of the TA network.
      bin.push(...await downloadBinance({ out: T.historyDir, assets: BINANCE_INDEXES, intervals: ['1h'], markets: ['um-index'], log: (m) => log(`binance: ${m}`) }));
      // The live bot rebuilds BTCDOM itself (Binance's futures API refuses US servers): check it tracks
      // Binance's own index wherever both exist.
      // The history replay's inputs: 1-minute spot (kept apart from the TA steps' store) and perpetual bars,
      // and funding rates, for the replayed assets and years.
      let replayInputs: unknown;
      if (T.historyReplay) {
        const fromMonth = new Date(now - T.historyReplayYears * 365 * 86_400_000).toISOString().slice(0, 7);
        const rs = await downloadBinance({ out: T.historyDir, assets: T.historyReplayAssets, intervals: ['1m'], markets: ['spot'], source: 'binance-1m', fromMonth, log: (m) => log(`binance: ${m}`) });
        const ru = await downloadBinance({ out: T.historyDir, assets: T.historyReplayAssets, intervals: ['1m'], markets: ['um'], fromMonth, log: (m) => log(`binance: ${m}`) });
        const fu = await downloadBinanceFunding({ out: T.historyDir, assets: T.historyReplayAssets, fromMonth, log: (m) => log(`binance: ${m}`) });
        replayInputs = { spot1m: rs.reduce((a, b) => a + b.fetched, 0), perp1m: ru.reduce((a, b) => a + b.fetched, 0), funding: fu.map((f) => `${f.asset} ${f.rows}`) };
      }
      const btcdomCheck = compareIndexSources(T.historyDir, 'BTCDOM', 'binance-index', 'bot-index');
      if (btcdomCheck.overlap) log(`BTCDOM: live rebuild vs Binance over ${btcdomCheck.overlap} hours: hourly return correlation ${btcdomCheck.returnCorr.toFixed(3)}, level ratio ${btcdomCheck.levelRatio.toFixed(4)}`);
      const cb = T.coinbaseTfs.length ? await backfillCoinbase({ out: T.historyDir, assets, tfs: T.coinbaseTfs as HistTf[], fromTs: Date.parse('2015-01-01T00:00:00Z'), baseUrl: cfg.coinbaseRestUrl, log: (m) => log(`coinbase: ${m}`) }) : [];
      // TradingView (tvdatafeed): the index series' 5,000-bar backfill and daily refresh, and the spot holes
      // (before the Kalshi download: models read these; the Kalshi candles are research material).
      let tradingview: unknown;
      if (T.tvFill) {
        state.tvTried ??= {};
        try { tradingview = await tvFill({ histDir: T.historyDir, assets, log: (m) => log(`tradingview: ${m}`), tried: state.tvTried }); } catch (e) { tradingview = { error: String(e) }; }
      }
      // Kalshi's own settled contracts (1-minute candles) for the traded series: real contract prices for
      // research. Time-boxed (KALSHI_HISTORY_BUDGET_MIN); the rest resumes on the next run.
      let kalshi: unknown;
      if (T.kalshiHistoryBudgetMin > 0) {
        try { kalshi = await downloadKalshiHistory({ baseUrl: cfg.restBaseUrl, series: cfg.strategy.series, days: T.kalshiHistoryDays, out: path.join(T.historyDir, 'kalshi'), budgetMs: T.kalshiHistoryBudgetMin * 60_000, log: (m) => log(`kalshi: ${m}`) }); } catch (e) { kalshi = { error: String(e) }; }
      } else kalshi = { skipped: 'KALSHI_HISTORY_BUDGET_MIN=0' };
      const reached = bin.some((b) => b.listed > 0) || cb.some((c) => c.requests > 0 && !/kept failing/.test(c.note ?? ''));
      if (!reached) throw new SkipStep('Binance Vision and Coinbase unreachable from this machine');
      state.lastHistoryUpdate = now;
      return { replayInputs, tradingview, kalshi, assets, binance: { fetched: bin.reduce((a, b) => a + b.fetched, 0), failed: bin.reduce((a, b) => a + b.failed, 0) }, coinbase: { added: cb.reduce((a, c) => a + c.added, 0) }, btcdomCheck };
    }, T.historyUpdate ? undefined : 'HISTORY_AUTO_UPDATE=false');
  }
  // ---- History replay: years of history as recordings (research/history/historyReplay.ts) ----
  const replayDir = T.historyReplayDir;
  const replayDays = () => recordingDays(replayDir);
  if (want('history_replay')) {
    await run('history_replay', async () => {
      const yesterday = new Date(Math.floor(now / 86_400_000) * 86_400_000 - 86_400_000).toISOString().slice(0, 10);
      const fromDay = new Date(now - T.historyReplayYears * 365 * 86_400_000).toISOString().slice(0, 10);
      const perpSpecs = await perpSpecsFromRecordings(rec, T.historyReplayAssets);
      const r = await buildHistoryReplay({ historyDir: T.historyDir, outDir: replayDir, assets: T.historyReplayAssets, fromDay, toDay: yesterday, perpSpecs, log });
      if (!r.assets.length) throw new SkipStep(`no 1-minute history yet (${r.notes.join('; ')})`);
      return { ...r, perpSpecs: Object.keys(perpSpecs) };
    }, T.historyReplay ? undefined : 'HISTORY_REPLAY=false');
  }
  if (want('ta_net')) {
    const staleSchema = fs.existsSync(taNetFile) && taNetFileSchema(taNetFile) !== TANET_SCHEMA;
    const due = o.forceTaNet || staleSchema || state.taNetComplete === false || !fs.existsSync(taNetFile) || !state.taNetTrainedAt || now - state.taNetTrainedAt >= T.retrainEveryDays * 86_400_000;
    const noHistory = storedAssets(T.historyDir).length ? undefined : `no history in ${T.historyDir} yet (npm run history:binance, or history:import your CSVs)`;
    await run('ta_net', async () => {
      const cand = path.join(work, 'ta_net.candidate.json');
      let rep;
      try {
        rep = await trainTaNetMain(argsOf({
          history: T.historyDir, out: cand, cache: path.join(work, 'tanet-cache'), state: path.join(work, 'tanet-population.json'), fresh: o.forceTaNetFresh ? 'true' : undefined,
          'train-months': T.trainMonths, 'eval-months': T.evalMonths, 'step-months': T.stepMonths, 'holdout-months': T.holdoutMonths, 'final-months': T.finalMonths, stride: T.stride, 'min-per-regime': T.minPerRegime, dsr: T.dsrThreshold,
          'max-rounds': T.maxRoundsPerRun || undefined, 'restart-every': T.restartEvery, arch: T.arch,
          incumbent: fs.existsSync(taNetFile) ? taNetFile : undefined,
        }));
      } catch (e) {
        if (/need at least/.test((e as Error).message)) throw new SkipStep((e as Error).message);
        throw e;
      }
      const validated = Object.entries(rep.params.heads).filter(([, h]) => h?.validation.validated).map(([k]) => k);
      state.taNetComplete = rep.complete;
      // The initialisation runs in chunks of rounds (one chunk per daily run); nothing is promoted
      // until the tournament has reached the present.
      if (!rep.complete) return { promoted: false, reason: `tournament in progress: ${rep.rounds} round(s) done, ${rep.remaining} to go (continues on the next run)` };
      state.taNetTrainedAt = now;
      const summary = { rounds: rep.rounds, newRounds: rep.newRounds, network: rep.params.network, heads: Object.fromEntries(Object.entries(rep.params.heads).map(([k, h]) => [k, h.validation])), elite: rep.params.pbt.elite };
      if (A.promote === 'validated' && !validated.length) return { promoted: false, version: rep.params.version, reason: 'no head passed the holdout and network hurdles', ...summary };
      const champ = promoteIfChampion({ dir: A.dir, kind: 'ta_net', candidate: cand, live: taNetFile, enabled: A.champion, candidateScore: rep.champion?.candidate, incumbentScore: rep.champion?.incumbent });
      if (!champ.promote) return { promoted: false, version: rep.params.version, reason: champ.reason, champion: rep.champion, ...summary };
      state.taNetVersion = rep.params.version;
      installTaNet();
      return { promoted: true, version: rep.params.version, validatedHeads: validated, champion: { ...rep.champion, reason: champ.reason, archived: champ.archived ?? null }, ...summary };
    }, !T.enabled ? 'TA_NET=false' : noHistory ?? (due ? undefined : `trained ${((now - state.taNetTrainedAt!) / 86_400_000).toFixed(1)} day(s) ago (TA_NET_RETRAIN_DAYS=${T.retrainEveryDays})`));
  }

  // ---- 0c. Walk-forward TA network forecasts for the setup scorer (and the walking network for live) ----
  if (want('ta_net_oos')) {
    const noHistory = storedAssets(T.historyDir).length ? undefined : `no history in ${T.historyDir} yet`;
    await run('ta_net_oos', async () => {
      const params = fs.existsSync(taNetFile) && taNetFileSchema(taNetFile) === TANET_SCHEMA ? taNetFile : T.modelPath;
      if (!fs.existsSync(params)) throw new SkipStep('no TA network yet');
      const r = await exportTaNetOos(T.historyDir, { paramsPath: params, cacheDir: path.join(work, 'tanet-cache'), hours: A.taNetOosHours, log });
      const wf = path.join(oosDir(T.historyDir), 'ta_net_wf.json');
      if (r.complete && fs.existsSync(wf)) fs.copyFileSync(wf, promoted('ta_net_wf'));
      return { ...r, promoted: r.complete };
    }, cfg.perps.strategy !== 'setups' ? 'PERP_STRATEGY is not setups' : !T.enabled ? 'TA_NET=false' : noHistory);
  }

  // ---- 0c'. Rule book: every TA rule walk-forward by market character (research/ruleBook.ts) ----
  if (want('rule_book')) {
    const file = path.join(A.dir, 'rule_book.json');
    const due = !fs.existsSync(file) || !state.ruleBookAt || now - state.ruleBookAt >= 7 * 86_400_000;
    const noHistory = storedAssets(T.historyDir).length ? undefined : `no history in ${T.historyDir} yet`;
    await run('rule_book', async () => {
      const { hist, risk } = loadRuleBookHistory(T.historyDir);
      if (!Object.keys(hist).length) throw new SkipStep('no hourly + daily history for the study coins');
      const f = runRuleBook(hist, { risk, log });
      writeAtomic(file, JSON.stringify(f));
      state.ruleBookAt = now;
      for (const l of ruleBookSummary(f)) log(`[rule-book] ${l}`);
      return { tests: f.rows.length, passed: f.rows.filter((r) => r.pass).length, character: { accuracy: f.character.accuracy, baseline: f.character.baseline }, from: f.from, to: f.to, splitAt: f.splitAt };
    }, noHistory ?? (due ? undefined : `ran ${((now - state.ruleBookAt!) / 86_400_000).toFixed(1)} day(s) ago (weekly)`));
  }

  // ---- 0d. Setup scorer for the fast / slow lane trader (years of 15m / 1h / daily candles) ----
  if (want('setups')) {
    const file = promoted('setups');
    const P = cfg.perps;
    const due = !fs.existsSync(file) || !state.setupsTrainedAt || now - state.setupsTrainedAt >= P.setupRetrainDays * 86_400_000;
    const noHistory = storedAssets(T.historyDir).length ? undefined : `no history in ${T.historyDir} yet`;
    await run('setups', async () => {
      const cand = path.join(work, 'setup_model.candidate.json');
      const oosCand = path.join(work, 'setup_oos.candidate.json');
      const p = await trainSetupMain(argsOf({ history: T.historyDir, out: cand, 'oos-out': oosCand, equity: P.paperBalanceUsd > 100 ? P.paperBalanceUsd : 10_000 }));
      state.setupsTrainedAt = now;
      const validated = (['fast', 'slow'] as const).filter((l) => p.validation[l]?.passed);
      const summary = { version: p.version, validated, holdout: Object.fromEntries((['fast', 'slow'] as const).map((l) => [l, p.validation[l]?.periods.holdout])), reasons: Object.fromEntries((['fast', 'slow'] as const).map((l) => [l, p.validation[l]?.reasons])) };
      if (A.promote === 'validated' && !validated.length) return { promoted: false, reason: 'no lane passed its holdout and final window', ...summary };
      const champ = promoteIfChampion({ dir: A.dir, kind: 'setups', candidate: cand, live: file, enabled: A.champion });
      if (!champ.promote) return { promoted: false, reason: champ.reason, ...summary };
      // Its recent out-of-sample setups, for the whole-bot replay (research/wholeBot.ts).
      if (fs.existsSync(oosCand)) fs.copyFileSync(oosCand, path.join(A.dir, 'setup_oos.json'));
      state.setupsVersion = p.version;
      return { promoted: true, champion: champ.reason, ...summary };
    }, cfg.perps.strategy !== 'setups' ? 'PERP_STRATEGY is not setups' : noHistory ?? (due ? undefined : `trained ${((now - state.setupsTrainedAt!) / 86_400_000).toFixed(1)} day(s) ago (SETUP_RETRAIN_DAYS=${P.setupRetrainDays})`));
  }

  // ---- 0e. SNN gate for the setup trader, from its own journal ----
  if (want('setup_snn')) {
    await run('setup_snn', async () => {
      const g = setupSnnMain(argsOf({ journal: path.join(cfg.dataDir, 'setups'), out: path.join(A.dir, 'setup_snn_gate.json') }));
      return g;
    }, cfg.perps.strategy !== 'setups' ? 'PERP_STRATEGY is not setups' : undefined);
  }

  // ---- 0f. Sweep optimizer: setting by setting until a plateau, as a PROPOSAL (never auto-applied) ----
  if (want('sweep')) {
    state.sweptAt ??= {};
    for (const target of A.sweepTargets) {
      const last = state.sweptAt[target];
      const due = !last || now - last >= A.sweepEveryDays * 86_400_000;
      // The whole bot and the Kalshi settings are swept over the history replay's days that hold Kalshi's
      // real contracts, when there are enough of them (the strategy never trades the synthetic ones: they are
      // quoted at its own fair value). A proposal, never applied.
      const kDays = (target === 'bot' || target === 'kalshi') && T.historyReplay ? replayKalshiDays(replayDir) : [];
      await run(`sweep-${target}`, async () => {
        let sweepSrc = rec;
        if (kDays.length >= 20 && kDays.length > days.length) {
          sweepSrc = path.join(work, 'sweep-replay');
          fs.rmSync(sweepSrc, { recursive: true, force: true });
          linkDays(kDays.map((d) => ({ day: d, file: path.join(replayDir, `md-${d}.jsonl.gz`) })), sweepSrc);
        }
        const out = path.join(A.dir, 'sweeps', `${target}.json`);
        if (fs.existsSync(out)) fs.renameSync(out, out.replace(/\.json$/, `.${new Date(now).toISOString().slice(0, 10)}.json`));
        let r;
        try {
          r = await sweepMain(argsOf({ target, hours: A.sweepHours, history: T.historyDir, recordings: sweepSrc, model: mlpPath(), out, 'setup-oos': path.join(A.dir, 'setup_oos.json'), 'setup-model': fs.existsSync(promoted('setups')) ? promoted('setups') : undefined }));
        } catch (e) {
          if (/needs at least|needs the TA network|recorded day/.test((e as Error).message)) throw new SkipStep((e as Error).message);
          throw e;
        }
        state.sweptAt![target] = now;
        return { proposal: out, data: sweepSrc === rec ? 'recordings' : `history replay: ${kDays.length} day(s) with real Kalshi contracts`, plateau: r.plateau, passes: r.passes, evaluations: r.evaluations, start: r.start, end: r.end, changed: r.steps.filter((x) => x.accepted).map((x) => `${x.param}: ${x.from} -> ${x.to}`) };
      }, due ? undefined : `swept ${((now - last!) / 86_400_000).toFixed(1)} day(s) ago (SWEEP_EVERY_DAYS=${A.sweepEveryDays})`);
    }
  }

  // ---- 1. The networks first, each alone: ablation (when due) -> train -> backfill ----
  const snnChanged: SnnDomain[] = [];
  state.snn ??= {}; state.snnVersions ??= {}; state.trainedWithSnn ??= {};
  if (want('snn')) {
    for (const domain of REPLAYABLE) {
      if (!cfg.snn.domains[domain].enabled) { await run(`snn-${domain}`, async () => undefined, `SNN_${domain.toUpperCase()}=false`); continue; }
      const ds: SnnDomainState = (state.snn[domain] ??= {});
      const fill = fillDir(domain);
      const file = promoted(`snn_${domain}`);
      const base = cfg.snn.domains[domain].stage;
      const due = o.forceAblation || !ds.lastAblation || (A.ablationEveryDays > 0 && now - ds.lastAblation >= A.ablationEveryDays * 86_400_000);
      let stage: Stage = A.snnStage === 'auto' ? (ds.stage ?? base) : A.snnStage;
      let stageAccepted = false;
      // Both networks' tournaments and training run on years of replayed history when the replay exists:
      // perps on its prices, candles and perp quotes; crypto on its 15-minute / hourly contracts (Kalshi's
      // real ones where its history reaches, synthetic ones built from the price path elsewhere, settled by
      // the real price). The crypto network's ablation, the gate for live use, stays on the bot's
      // recordings: it must beat real Kalshi prices. The backfill is always on the recordings (its outputs
      // feed the models trained on them).
      const src = T.historyReplay && replayDays().length >= A.snnPbtDays + A.snnPbtInitDays ? replayDir : rec;
      const srcDays = src === rec ? days : replayDays();
      const lastSrc = (n: number) => srcDays.slice(-n);
      const srcGate = src === rec ? tooFew : undefined;
      const abSrc = domain === 'crypto' ? rec : src;
      const abDays = (abSrc === rec ? days : replayDays()).slice(-A.ablationDays);
      // The crypto network is judged on settled contracts against the MLP; perps on its own direction calls.
      const verdicts = await run(`snn-${domain}-ablation`, async () => {
        const v = await snnAblationMain(argsOf({ recordings: abSrc, domain, model: domain === 'crypto' ? mlpPath() : undefined, from: abDays[0], out: path.join(work, `snn_${domain}_ablation.json`), only: o.ablationOnly }));
        ds.lastAblation = now;
        return v;
      }, (abSrc === rec ? tooFew : undefined) ?? (due ? undefined : 'not due (ablated recently)')) as Verdict[] | undefined;
      if (verdicts) {
        const k = acceptedChain(verdicts);
        if (A.snnStage === 'auto') stage = k > 0 ? STAGES[k] : base;
        stageAccepted = k > 0 && STAGES.indexOf(stage) <= k;
      }
      // Population tournament: three identical networks of this stage, knobs within +/-10%, fight
      // over the recorded days; the elite's knobs are this network's hyperparameters from now on.
      const pbtDue = o.forceSnnPbt || ds.pbtStage !== stage || !ds.pbtHyper || ds.pbtComplete === false || (A.snnPbtEveryDays > 0 && now - (ds.pbtAt ?? 0) >= A.snnPbtEveryDays * 86_400_000);
      const pbtDays = lastSrc(A.snnPbtDays);
      const pbt = await run(`snn-${domain}-pbt`, async () => {
        let r;
        try {
          r = await runSnnPbt({ recordings: src, domain, stage, days: pbtDays, initDays: A.snnPbtInitDays, evalDays: 1, model: domain === 'crypto' && mlpPath() ? MetaModel.load(mlpPath()!) : undefined, modelPath: domain === 'crypto' ? mlpPath() : undefined, stateDir: path.join(work, 'snnpbt', domain), maxRounds: A.snnPbtMaxRounds || undefined, restartEvery: A.snnPbtRestartEvery, fresh: ds.pbtStage !== undefined && ds.pbtStage !== stage, population: A.snnPbtPopulation, workers: workerCount(), log });
        } catch (e) {
          if (/need at least/.test((e as Error).message)) throw new SkipStep((e as Error).message);
          throw e;
        }
        ds.pbtComplete = r.complete;
        if (!r.complete) return { complete: false, reason: `tournament in progress: ${r.rounds} round(s) done, ${r.remaining} to go`, elite: r.elite };
        ds.pbtHyper = r.elite.hyper; ds.pbtStage = stage; ds.pbtAt = now;
        return { complete: true, rounds: r.rounds, trials: r.trials, elite: r.elite, dsr: r.dsr, population: A.snnPbtPopulation, data: src === rec ? 'recordings' : 'history replay' };
      }, srcGate ?? (pbtDue ? undefined : `knobs chosen ${(((now - (ds.pbtAt ?? now)) / 86_400_000)).toFixed(1)} day(s) ago`)) as { complete?: boolean } | undefined;
      const hyper = ds.pbtStage === stage ? ds.pbtHyper : undefined;
      const trainNeeded = Boolean(verdicts) || Boolean(pbt?.complete) || !fs.existsSync(file) || ds.stage !== stage;
      await run(`snn-${domain}-train`, async () => {
        const span = lastSrc(A.snnTrainDays);
        const nEval = span.length >= 2 ? Math.max(1, Math.round(span.length * 0.2)) : 0;
        const trainSpan = span.slice(0, span.length - nEval), evalSpan = span.slice(span.length - nEval);
        const cand = path.join(work, `snn_${domain}.candidate.json`);
        const r = await trainSnnMain(argsOf({
          recordings: src, stage, domain, out: cand, model: domain === 'crypto' ? mlpPath() : undefined, hyper: hyper ? JSON.stringify(hyper) : undefined, 'skip-model': src === rec ? undefined : 'true',
          from: trainSpan[0], to: evalSpan[0] ?? undefined,
          'eval-from': evalSpan[0], 'eval-to': evalSpan.length ? nextDay(evalSpan[evalSpan.length - 1]) : undefined,
        }));
        if (A.promote === 'validated' && !stageAccepted) return { promoted: false, stage, reason: 'stage not accepted by the ablation', result: r };
        fs.copyFileSync(cand, file);
        if (state.snnVersions![domain] !== r?.version) snnChanged.push(domain);
        ds.stage = stage;
        ds.version = r?.version;
        state.snnVersions![domain] = r?.version;
        return { promoted: true, stage, stageAccepted, result: r };
      }, srcGate ?? (trainNeeded ? undefined : 'up to date'));
      // Prequential backfill, day by day from the last backfilled day (a fresh online network of the
      // promoted stage: it was never fitted offline on these days, so no output saw its own label).
      await run(`snn-${domain}-backfill`, async () => {
        const params = withSnnHyper(domainParams(domain, { ...DEFAULT_SNN, flags: { ...stageFlags(stage), ...cfg.snn.deferred }, seed: cfg.snn.seed, maxColumns: cfg.snn.maxColumns, readoutEta: cfg.snn.readoutEta }), hyper);
        const pv = versionHash(params);
        if (ds.backfillStage !== stage || (ds.backfillVersion && ds.backfillVersion !== pv)) { for (const f of fs.readdirSync(fill)) fs.rmSync(path.join(fill, f), { force: true }); ds.backfillThrough = undefined; ds.backfillStage = stage; }
        ds.backfillVersion = pv;
        const todo = days.filter((d) => !ds.backfillThrough || d >= ds.backfillThrough);
        let cp: SnnCheckpoint | undefined;
        const cpFile = path.join(fill, 'state.json');
        if (ds.backfillThrough && fs.existsSync(cpFile)) cp = JSON.parse(fs.readFileSync(cpFile, 'utf8'));
        let filled = 0;
        for (const d of todo) {
          // The day before warms up the trackers; outputs are written only for day d.
          const prev = days[days.indexOf(d) - 1];
          const r = await replaySnn(rec, { params, domain, checkpoint: cp, backfillDir: fill, from: dayMs(d), to: dayMs(nextDay(d)), fromDay: prev ?? d, toDay: d });
          cp = r.net.serialize();
          filled++;
          // Today is redone next run (it is still being recorded); completed days are final.
          if (d < new Date(now).toISOString().slice(0, 10)) { ds.backfillThrough = nextDay(d); writeAtomic(cpFile, JSON.stringify(cp)); }
        }
        return { days: filled, through: ds.backfillThrough ?? null };
      }, tooFew);
    }
    await run('snn-tennis', async () => undefined, 'the tennis network learns live only (no recorded score feed to replay); its checkpoints persist in data/snn/tennis');
  }
  // Every later step reads the logged + backfilled outputs (each consumer picks its own network's).
  process.env.SNN_BACKFILL_DIR = REPLAYABLE.map(fillDir).join(path.delimiter);
  process.env.SNN_CROSS_FEED = String(cfg.snn.crossFeed);

  // ---- 2. tree volatility forecast (fair value's sigma multiplier) ----
  if (want('vol_model')) {
    await run('vol_model', async () => {
      const cand = path.join(work, 'vol_model.candidate.json');
      let p;
      try { p = await trainVolModelMain(argsOf({ recordings: rec, out: cand })); } catch (e) {
        if (/need at least/.test((e as Error).message)) throw new SkipStep(`not enough index history yet (${(e as Error).message})`);
        throw e;
      }
      if (A.promote === 'validated' && !p.validation.validated) return { promoted: false, validation: p.validation };
      const champ = promoteIfChampion({ dir: A.dir, kind: 'vol_model', candidate: cand, live: promoted('vol_model'), enabled: A.champion });
      return { promoted: champ.promote, champion: champ.reason, validation: p.validation };
    }, tooFew);
  }

  // ---- 4-5. dataset -> MLP (fair value + take/skip head) -> backtest -> promote ----
  const dataset = path.join(work, 'dataset.jsonl');
  // Price the dataset and the backtest exactly as production will: with the vol forecast (when on)
  // and the fill model (each is applied only if validated).
  const volModelArg = cfg.strategy.volModel && fs.existsSync(promoted('vol_model')) ? promoted('vol_model') : undefined;
  const fillModelArg = fs.existsSync(promoted('fill')) ? promoted('fill') : undefined;
  if (want('dataset') || want('mlp')) await run('dataset', () => buildDatasetMain(argsOf({ recordings: rec, out: dataset, every: 60, 'vol-model': volModelArg })), tooFew);
  if (want('mlp')) {
    const cand = path.join(work, 'model.candidate.json');
    await run('mlp', async () => {
      if (!fs.existsSync(dataset) || fs.statSync(dataset).size === 0) throw new SkipStep('empty dataset: no priced contracts with outcomes in the recordings yet');
      try { await trainMetaModelMain(argsOf({ data: dataset, out: cand })); } catch (e) {
        if (/need at least \d+ windows/.test((e as Error).message)) throw new SkipStep(`not enough settlement windows yet: ${(e as Error).message}`);
        throw e;
      }
      await backtestMain(argsOf({ recordings: rec, model: cand, exits: cfg.strategy.exitPolicy, 'vol-model': volModelArg, 'fill-model': fillModelArg }), true);
      const m = MetaModel.load(cand);
      const passed = Boolean(m.params.validation?.passed);
      const usesSnn = m.params.features.some((f) => f.startsWith('snn_'));
      if (A.promote === 'validated' && !passed) return { promoted: false, id: m.id, reason: `validation not passed (${m.liveBlockers().join('; ')})` };
      const champ = promoteIfChampion({ dir: A.dir, kind: 'mlp', candidate: cand, live: promoted('mlp'), enabled: A.champion });
      if (!champ.promote) return { promoted: false, id: m.id, reason: champ.reason };
      state.mlpId = m.id;
      state.trainedWithSnn!.crypto = state.snnVersions!.crypto;
      state.trainedWithTaNet = state.taNetVersion;
      return { promoted: true, champion: champ.reason, id: m.id, kind: m.params.kind, usesSnnFeatures: usesSnn, take: m.params.take?.validation ?? null, validationPassed: passed, liveBlockers: m.liveBlockers() };
    }, tooFew);
  }

  // ---- 6. intraday volatility profile ----
  if (want('vol')) {
    await run('vol', async () => {
      const out = path.join(work, 'vol_profile.json');
      await sessionsMain(argsOf({ recordings: rec, out, 'no-backtest': 1 }));
      fs.copyFileSync(out, promoted('vol'));
      return { promoted: true, improved: JSON.parse(fs.readFileSync(out, 'utf8')).validation?.improved ?? false };
    }, tooFew);
  }

  // ---- 7. perps (SNN 1h/4h direction among the features) ----
  if (want('perps')) {
    // Years of replayed perpetual history when the replay exists (HISTORY_REPLAY); else the bot's recordings.
    const perpSrc = T.historyReplay && replayDays().length >= 30 ? replayDir : rec;
    await run('perps', async () => {
      const cand = path.join(work, 'perp_model.candidate.json');
      try { await trainPerpMain(argsOf({ recordings: perpSrc, out: cand, every: perpSrc === rec ? undefined : 900 })); } catch (e) {
        if (/record more perp data|no perp/i.test((e as Error).message)) throw new SkipStep('no perp quotes recorded yet (PERPS_FEED=true records them)');
        throw e;
      }
      if (!fs.existsSync(cand)) throw new SkipStep('perp trainer wrote no model');
      await perpBacktestMain(argsOf({ recordings: perpSrc, model: cand }), true);
      const m = PerpModel.load(cand);
      const ok = Boolean(m?.validated());
      if (A.promote === 'validated' && !ok) return { promoted: false, reason: m?.blockers().join('; ') };
      const champ = promoteIfChampion({ dir: A.dir, kind: 'perp', candidate: cand, live: promoted('perp'), enabled: A.champion });
      if (!champ.promote) return { promoted: false, reason: champ.reason };
      state.trainedWithSnn!.perps = state.snnVersions!.perps;
      return { promoted: true, champion: champ.reason, validated: ok, blockers: m?.blockers() ?? [], data: perpSrc === rec ? 'recordings' : `history replay (${replayDays().length} days)` };
    }, perpSrc === rec ? tooFew : undefined);
  }

  // ---- 8. tennis MLP ----
  if (want('tennis')) {
    await run('tennis', async () => {
      const cand = path.join(work, 'tennis_model.candidate.json');
      let p;
      try { p = await trainTennisMain(argsOf({ recordings: rec, out: cand })); } catch (e) {
        if (/need at least \d+ matches/.test((e as Error).message)) throw new SkipStep(`not enough settled tennis matches recorded yet (${(e as Error).message})`);
        throw e;
      }
      if (A.promote === 'validated' && !p.validation.validated) return { promoted: false, validation: p.validation };
      const champ = promoteIfChampion({ dir: A.dir, kind: 'tennis', candidate: cand, live: promoted('tennis'), enabled: A.champion });
      if (!champ.promote) return { promoted: false, reason: champ.reason, validation: p.validation };
      state.trainedWithSnn!.tennis = state.snnVersions!.tennis;
      return { promoted: true, champion: champ.reason, validation: p.validation };
    }, tooFew);
  }

  // ---- 8. fill / adverse-selection model: brings itself online once it validates ----
  if (want('fill')) {
    await run('fill', async () => {
      const cand = path.join(work, 'fill_model.candidate.json');
      let p;
      try { p = await trainFillMain(argsOf({ fills: path.join(cfg.dataDir, 'fills'), out: cand })); } catch (e) {
        if (/not ready/.test((e as Error).message)) throw new SkipStep(`collecting maker quotes (${(e as Error).message})`);
        throw e;
      }
      // Promoted only once it beats the base rate on held-out days (in either promotion mode): the
      // engine starts using a validated fill model as soon as the file appears.
      if (!p.validation.validated) return { promoted: false, validation: p.validation, reason: 'does not beat the base rate on holdout yet' };
      fs.copyFileSync(cand, promoted('fill'));
      const m = FillModel.load(promoted('fill'));
      return { promoted: true, active: Boolean(m?.validated), validation: p.validation };
    });
  }

  // ---- 9. sizing tuner: replays the bot's settled entries under a grid of sizing policies (PROPOSAL) ----
  if (want('sizing')) {
    await run('sizing', async () => {
      const r = await tuneSizingMain(argsOf({ 'data-dir': cfg.dataDir, kelly: cfg.strategy.kellyFraction, 'loss-at': cfg.strategy.ddScaleAt, start: cfg.paperBankrollUsd, floor: cfg.strategy.minTradableBankrollUsd, out: path.join(A.dir, 'sizing_proposal.json') }));
      if (!r.ready) throw new SkipStep(r.note);
      return { proposal: path.join(A.dir, 'sizing_proposal.json'), note: r.note, best: r.best, current: r.current, epochs: r.epochs };
    });
  }

  state.lastRun = now;
  writeAtomic(report, JSON.stringify({ at: new Date(now).toISOString(), complete: true, recordings: rec, days: days.length, readiness: state.readiness, promote: A.promote, snnChanged, steps }, null, 1));
  state.lastReport = report;
  writeAtomic(path.join(A.dir, 'pipeline_state.json'), JSON.stringify(state, null, 1));
  log(`report: ${report}`);
  return { steps, state, report };
}

async function main() {
  const i = process.argv.indexOf('--only');
  const only = i >= 0 ? (process.argv[i + 1] ?? '').split(',').filter(Boolean) as Step[] : undefined;
  for (const s of only ?? []) if (!STEPS.includes(s)) throw new Error(`unknown step ${s} (steps: ${STEPS.join(', ')})`);
  const r = await runPipeline({ only, forceAblation: process.argv.includes('--force-ablation'), forceTaNet: process.argv.includes('--force-ta-net') || process.argv.includes('--fresh-ta-net'), forceTaNetFresh: process.argv.includes('--fresh-ta-net'), forceSnnPbt: process.argv.includes('--force-snn-pbt') });
  const failed = r.steps.filter((s) => !s.ok);
  console.log(`[pipeline] ${r.steps.length - failed.length}/${r.steps.length} steps ok${failed.length ? `; failed: ${failed.map((f) => f.step).join(', ')}` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && /pipeline\.(ts|cjs|js)$/.test(process.argv[1])) void main();

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
//   0b' oracle_cull  every TA reading against the oracle (research/oracleCull.ts, weekly) -> oracle_cull.json: the
//                    readings that told nothing about the hindsight-best strategy are switched off in the TA network
//                    and the Librarian
//   0c+ librarian    the Librarian (research/librarian.ts): oracle strategy and regime-transition heads on the TA
//                    network's inputs, walk-forward and graded against persistence (weekly) -> librarian.json (its
//                    validated heads are features of the decision models) and the walk's forecasts for the setups
//   0c~ cross_graph  the cross-asset graph network on relative returns (research/trainCrossGraph.ts, weekly; PyTorch when
//                    XG_ENGINE finds it) -> cross_graph.json and the walk's forecasts for the setups
//   0c` cross_lead   cross-coin lead-lag on the 1-minute history (research/crossLead.ts, weekly): which leader / coin pairs
//                    are predictive out of sample -> cross_lead.json (the Kalshi features, the setup scorer's inputs and
//                    the lead-lag exit, each used only where it pays)
//   0c* lead_lag     does Coinbase spot lead the Kalshi perp? (research/leadLag.ts, weekly, on the recordings) ->
//                    lead_lag.json, the verdict per coin the spot-led setups wait for
//   0d. setups       setup scorer for the fast / slow lanes (TA network inputs kept only if they help)
//   0e. setup_snn    does the perps SNN help the setup trader? Tested on the bot's own setup journal
//                    (research/setupSnnStudy.ts); writes setup_snn_gate.json, on only once proven
//   0f. sweep        sweep optimizer proposals (setups per side, the volatility trail, kalshi, the whole bot)
//   1. snn           per replayable network (crypto: 15m/1h with contracts; perps: 1h/4h, graded on
//                    direction calls): ablation when due -> population tournament of identical networks
//                    (snnPbt.ts; the elite's knobs) -> train at the best accepted stage (from the history
//                    walk's best network when it walks that stage: historyWalk.ts) -> promote
//                    snn_<domain>.json -> prequential backfill (work/snnfill/<domain>). Tournament and
//                    training on the history replay when it has the days; the crypto network's ablation
//                    (its gate for live use) always on the bot's recordings, against real Kalshi prices.
//                    The tennis network: tournament + an online run through Kalshi's tennis history in the
//                    replay (every match's real prices and tape), its tennis template carrying what each
//                    match learned to the next; without tennis history it learns live only.
//   2. vol_model     tree-based volatility forecast (sigma multiplier for fair value) -> promote
//   3. dataset       research:dataset (with the crypto network's logged/backfilled outputs)
//   4. mlp           research:train (MLP fair value + take/skip head, tree candidates) -> backtest -> promote
//   5. vol           intraday volatility profile (the replay's last 180 days when it exists) -> promote
//   6. perps         perp-train (perps network's 1h/4h calls; MLP/tree candidates) -> perp-backtest -> promote
//   7. tennis        tennis model (4 signals, score, book, tennis network; MLP vs trees) on Kalshi's tennis
//                    history + the bot's recorded matches (the newest, with the live score, are the holdout)
//   8. fill          fill / adverse-selection model from the bot's own maker quotes: skipped until
//                    enough quotes and fills exist, promoted once it beats the base rate on holdout;
//                    the engine starts using it the moment a validated file appears.
//   10. readiness    the whole bot (Kalshi + perps setups, one pot) replayed on days nothing was fitted or tuned
//                    on, in % of TRAIN_TARGET_POOL_USD, against the target the continuous laptop trainer stops
//                    at; every model's state; each network's weeks in the history ledger -> readiness.json
//                    (research/readiness.ts)
//
// A new network triggers the retrain of its own consumer only (the bot watches snn_<domain>.json,
// AUTO_TRAIN_ON_MODEL_CHANGE).
//
//   npm run pipeline                         # everything
//   npm run pipeline -- --only mlp,perps     # steps: history, history_replay, ta_net, ta_net_oos, librarian, cross_graph, rule_book, gp, lead_lag, setups, setup_snn, sweep, snn, vol_model, dataset, mlp, vol, perps, tennis, fill, sizing, playbook, readiness
//   npm run pipeline -- --force-ablation     # re-run the SNN ablations even if not due
//   npm run pipeline -- --sweep-all          # every step due now (weekly studies, tournaments, ablations, sweeps)
//   npm run pipeline -- --only ta_net --force-ta-net   # retrain the TA network now

import { loadRuleBookHistory, ruleBookSummary, runRuleBook } from './ruleBook';
import { gpAssets, gpSummary, readGpFile, runGp } from './gpIndicators';
import { tuneSizingMain } from './tuneSizing';
import { archiveModel, promoteIfChampion } from './champion';
import crypto from 'crypto';
import fs from 'fs';
import v8 from 'v8';
import path from 'path';
import { MODEL_FILES } from '../bot/autotrain';
import { loadConfig, paperEnv, type Config } from '../bot/config';
import { MetaModel } from '../bot/model/metaModel';
import { PerpModel } from '../bot/perps/perpSignal';
import type { SnnCheckpoint } from '../bot/snn/network';
import { DEFAULT_SNN, domainParams, STAGES, stageFlags, type SnnDomain, type Stage } from '../bot/snn/params';
import { FillModel } from '../bot/tca/fillModel';
import { trainFillMain } from './trainFillModel';
import { trainVolModelMain, VOL_MODEL_MIN_DAYS } from './trainVolModel';
import { backtestMain } from './backtest';
import { buildDatasetMain } from './buildDataset';
import { perpBacktestMain, PERP_RECORDED_MIN_DAYS, PERP_RECORDED_TEST_DAYS } from './perpBacktest';
import { sessionsMain } from './sessions';
import { snnAblationMain, type Verdict } from './snnAblation';
import { replaySnn } from './snnReplay';
import { trainMetaModelMain } from './trainMetaModel';
import { buildPerpDataset, perpRuleRecord, trainPerpMain } from './trainPerpModel';
import { runSnnPbt } from './snnPbt';
import { snnContest, type ContestResult } from './snnContest';
import { daysOf, HistoryLedger, HOLDOUT_RULE, isHoldout, isoWeek, weekBlocks } from './historyLedger';
import { componentStatus, dailyStats, ledgerStatus, READINESS_RECORDED_DAYS, SOLID, solidWholeBot, targetMet, writeReadiness, type ReadinessFile, type ReadinessTarget } from './readiness';
import { readWalk, walkDir } from './historyWalk';
import { loadWholeBot, runWholeBot, settingsFromConfig } from './wholeBot';
import { SetupModel } from '../bot/setups/setupModel';
import { withSnnHyper } from '../bot/snn/population';
import { versionHash } from '../bot/snn/params';
import { trainTennisMain } from './trainTennisModel';
import { trainTaNetMain } from './trainTaNet';
import { forecastSchema, setupInputStatus, trainSetupMain } from './trainSetupModel';
import { sweepMain, SWEEP_MIN_DAYS } from './sweep';
import { collectFiles, importFile } from './history/importCsv';
import { downloadKalshiHistory, downloadKalshiTrades } from './history/kalshiHistory';
import { dominanceNeedFrom, indexNeeds, tvFill } from './history/tradingview';
import { linkDays, recordingDayList, recordingFiles, recordingsUsage } from '../bot/marketdata/recordingFiles';
import { readJournalTrades } from '../bot/setups/journal';
import { setupSnnMain, SNN_GATE_MIN_TRADES } from './setupSnnStudy';
import { exportTaNetOos, oosDir } from './taNetOos';
import { libDir, trainLibrarian } from './librarian';
import { cullSummary, readCull, trainOracleCull } from './oracleCull';
import { leadLagStudy } from './leadLag';
import { trainCrossGraph, xgDir } from './trainCrossGraph';
import { trainCrossLead } from './crossLead';
import { CL_SCHEMA, setCrossLeadPath } from '../bot/ta/crossLead';
import { setCrossGraphPath, XG_SCHEMA } from '../bot/ta/crossGraph';
import { LIB_SCHEMA, setLibrarianPath } from '../bot/ta/librarian';

const readLibSchema = (f: string): string | undefined => { try { return (JSON.parse(fs.readFileSync(f, 'utf8')) as { schema?: string }).schema; } catch { return undefined; } };
import { BINANCE_INDEXES, downloadBinance, downloadBinanceFunding, downloadBinanceOpenInterest, type BinanceMarket } from './history/binanceVision';
import { buildHistoryReplay, historyStart, perpSpecsFromRecordings, replayKalshiDays, replayPerpDays, replayTennisDays } from './history/historyReplay';
import { WorkerPool, workerCount, workerScript } from './workerPool';
import type { SnnTrainJob, SnnTrainOut } from './snnReplayWorker';
import { compareIndexSources } from '../bot/marketdata/historyStore';
import { backfillCoinbase } from './history/coinbaseBackfill';
import { resolveAssets } from './history/assets';
import { storedAssets, type HistTf } from './history/candles';
import { regimeTransitions } from './transitions';
import { setTaNet, TaNet, taNetFileSchema, TANET_SCHEMA } from '../bot/ta/taNet';
import { capHours, enterDecisionPhase, resetSession, sessionActive, sessionTimeUp, startSession } from './sessionClock';

/** Coins with Kalshi crypto contracts: the SNN tournaments' transition penalty reads their regime changes. */
const SNN_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

export const STEPS = ['history', 'history_replay', 'oracle_cull', 'ta_net', 'ta_net_oos', 'librarian', 'cross_graph', 'cross_lead', 'rule_book', 'gp', 'lead_lag', 'setups', 'setup_snn', 'sweep', 'snn', 'vol_model', 'dataset', 'mlp', 'vol', 'perps', 'tennis', 'fill', 'sizing', 'playbook', 'readiness', 'conditioning'] as const;
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
  /** When its tournament last ran (with the session clock, the network whose turn is oldest goes first). */
  turnAt?: number;
  pbtComplete?: boolean;
  /** How the tournament's days were chosen (the latest days, or blocks across the replay's years). */
  pbtLayout?: string;
  /** The history walk's first day not walked when this network last trained (a walk that moved on trains it again),
   *  and whether the training started from the walk's network fell short of the network in use (the next one then
   *  starts from nothing). */
  walkThrough?: string;
  walkFellShort?: boolean;
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
  /** The setup scorer's optional inputs that were there when it last trained (a new one makes it due). */
  setupInputs?: string[];
  /** Last rule-book study (research/ruleBook.ts, weekly). */
  ruleBookAt?: number;
  /** Last cross-coin lead-lag study (research/crossLead.ts, weekly). */
  crossLeadAt?: number;
  /** Last Librarian training (research/librarian.ts, weekly). */
  librarianAt?: number;
  oracleCullAt?: number;
  /** Last spot vs perp lead-lag study (research/leadLag.ts, weekly). */
  leadLagAt?: number;
  /** Last cross-asset graph network training (research/trainCrossGraph.ts, weekly). */
  crossGraphAt?: number;
  /** Last genetic-programming run (research/gpIndicators.ts, every GP_EVERY_DAYS). */
  gpAt?: number;
  /** What the recordings make testable so far (see the readiness block of each report). */
  readiness?: Readiness;
  /** Last sweep run per target. */
  sweptAt?: Record<string, number>;
  lastHistoryUpdate?: number;
  /** What each retrain step read at its last completed run (inputsSignature), to skip it when nothing changed. */
  stepInputs?: Record<string, { sig: string; at: number }>;
  /** The readiness step's whole-bot result, reused while nothing it reads changes. */
  readinessWholeBot?: { sig: string; at: number; wholeBot?: ReadinessFile['wholeBot']; note?: string };
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

/** A file's size and modification time ('' when missing). */
const statSig = (f: string) => { try { const s = fs.statSync(f); return `${s.size}:${Math.round(s.mtimeMs)}`; } catch { return ''; } };

/** Every file in a folder (and `depth - 1` levels of subfolders): name, size and time, hashed. */
export function dirSignature(dir: string, depth = 2): string {
  const h = crypto.createHash('sha1');
  const walk = (d: string, left: number) => {
    let es: fs.Dirent[];
    try { es = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (left > 1) { h.update(`${e.name}/\n`); walk(p, left - 1); } }
      else if (!e.name.endsWith('.tmp')) h.update(`${e.name}\t${statSig(p)}\n`);
    }
  };
  walk(dir, depth);
  return h.digest('hex');
}

/** What a retrain step reads, as one hash: the code that runs, the settings (the per-round time budgets left out),
 *  the folders and files it reads, and anything else given. The same hash as at the step's last completed run means
 *  the run would give the same result. */
export function inputsSignature(o: { code: string; settings: unknown; dirs: string[]; files: string[]; extra?: unknown }): string {
  return crypto.createHash('sha1').update(JSON.stringify([statSig(o.code), o.settings, o.dirs.map((d) => dirSignature(d)), o.files.map((f) => [path.basename(f), statSig(f)]), o.extra ?? null])).digest('hex');
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

/** research/trainSnn.ts on a worker thread (dist/snnReplayWorker.cjs) with a heap of its own, as large as this
 *  process's: what earlier steps left in the pipeline's memory does not count against it, and a training that runs
 *  out of memory fails this step only (the pool retries it with twice the room while that stays within 8 GB). */
async function trainSnnApart(args: Record<string, string | number | undefined>): Promise<SnnTrainOut> {
  const heapMb = Math.round(v8.getHeapStatistics().heap_size_limit / 1048576);
  const pool = new WorkerPool<SnnTrainJob, SnnTrainOut>(workerScript('snnReplayWorker'), 1, { ...process.env, TRAIN_WORKER_HEAP_MB: String(heapMb) });
  try { return await pool.run({ train: args }); } finally { await pool.close(); }
}

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
  /** Steps left out of this run (the trainer's "skip data download": history). */
  skip?: Step[];
  /** Restrict the SNN ablation to mechanisms whose name starts with this (testing). */
  ablationOnly?: string;
  /** Retrain the TA network even if it is not due. */
  forceTaNet?: boolean;
  /** Restart the TA network's population tournament from scratch. */
  forceTaNetFresh?: boolean;
  /** Re-run the SNN population tournaments even if not due. */
  forceSnnPbt?: boolean;
  /** Every step due now (the laptop trainer's "sweep everything again"): weekly studies, retrains, sweeps,
   *  ablations and tournaments run whatever their schedule says. Models and tournaments in progress are kept. */
  forceAll?: boolean;
}

export async function runPipeline(o: PipelineOpts = {}): Promise<{ steps: StepResult[]; state: PipelineState; report: string }> {
  const cfg = o.cfg ?? loadConfig(paperEnv(process.env));
  const A = cfg.autoTrain;
  const log = o.log ?? ((m: string) => console.log(`[pipeline] ${m}`));
  const now = o.now ?? Date.now();
  const work = path.join(A.dir, 'work');
  // Which weeks of the history replay each network has trained on and been judged on.
  const ledger = new HistoryLedger(path.join(work, 'history-ledger.json'));
  // Every tournament's genetic layer: the best survivors breed every few rounds (research/genetic.ts).
  const genetic = { parents: A.gaParents, islands: A.gaIslands, breedEvery: A.gaBreedEvery, mutation: A.gaMutation };
  const fillRoot = path.join(work, 'snnfill');
  const fillDir = (d: SnnDomain) => path.join(fillRoot, d);
  for (const d of REPLAYABLE) fs.mkdirSync(fillDir(d), { recursive: true });
  const state = readState(A.dir);
  if (o.forceAll) {
    delete state.stepInputs; delete state.readinessWholeBot;
    delete state.ruleBookAt; delete state.librarianAt; delete state.oracleCullAt; delete state.leadLagAt; delete state.crossGraphAt; delete state.crossLeadAt; delete state.gpAt; delete state.setupsTrainedAt; delete state.taNetTrainedAt; state.sweptAt = {};
    o = { ...o, forceAblation: true, forceSnnPbt: true, forceTaNet: true };
    log('sweeping everything: every step is due this run');
  }
  const steps: StepResult[] = [];
  // A stop signal (the remote job's time limit, the bot restarting, the trainer's Stop): no new step starts, and the
  // step in progress gets PIPELINE_STOP_GRACE_SEC (45: inside the remote job's 2-minute kill-after and systemd's
  // 60-second stop timeout) to finish before the process exits. Finished steps are already saved; a second signal
  // exits at once.
  let stopRequested = false;
  const graceSec = Math.max(0, Number(process.env.PIPELINE_STOP_GRACE_SEC ?? 45) || 0);
  const onStop = (sig: NodeJS.Signals) => {
    if (stopRequested) { log(`${sig} again: exiting now`); process.exit(143); }
    stopRequested = true;
    log(`stop requested (${sig}): no new step starts; the step in progress has ${graceSec} s to finish`);
    setTimeout(() => { log('stop: the step in progress did not finish in time; exiting (finished steps are saved)'); process.exit(143); }, graceSec * 1000).unref();
  };
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);

  // Conditioning runs only when asked for by name (the trainer window's conditioning mode), never in a normal run.
  const want = (s: Step) => !o.skip?.includes(s) && (s === 'conditioning' ? !!o.only?.includes(s) : !o.only?.length || o.only.includes(s));
  const rec = A.recordingsDir;
  const days = recordingDays(rec);
  // The models built from the bot's own recordings (vol forecast, dataset, the MLP candidate's backtest) replay every
  // recorded day they read, 8 to 11 minutes a day each on the remote runner. AUTO_TRAIN_DECISION_DAYS keeps them on the
  // newest days, so a run stops growing with the recordings (Oct 23: three days already overran the quick phase).
  const decisionRec = (() => {
    if (!(A.decisionDays > 0) || days.length <= A.decisionDays) return rec;
    const dir = path.join(work, 'decision-days');
    fs.rmSync(dir, { recursive: true, force: true });
    linkDays(recordingFiles(rec).slice(-A.decisionDays), dir);
    return dir;
  })();
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
  // The training session's clock (TRAIN_SESSION_MIN, the laptop trainer's session length; research/sessionClock.ts):
  // started by the first training step (the data steps are outside it); the networks get its first part, the decision
  // models the rest, from the first of them on. A step whose part is used up does not start; it runs next session.
  const sessionMin = Number(process.env.TRAIN_SESSION_MIN) || 0;
  resetSession();
  const DATA_STEPS = ['history-seed', 'history', 'history-index', 'history_replay', 'conditioning'];
  const DECISION_STEPS = ['vol_model', 'dataset', 'mlp', 'vol', 'perps', 'tennis', 'fill', 'sizing', 'playbook', 'readiness'];
  const run = async (step: string, fn: () => Promise<unknown>, skip?: string) => {
    const t0 = Date.now();
    if (stopRequested) {
      steps.push({ step, ok: true, skipped: 'stop requested', ms: 0 });
      log(`${step}: skipped (stop requested)`);
      return undefined;
    }
    if (skip) { steps.push({ step, ok: true, skipped: skip, ms: 0 }); log(`${step}: skipped (${skip})`); return undefined; }
    if (sessionMin > 0 && !DATA_STEPS.includes(step)) {
      if (!sessionActive()) { startSession(sessionMin); log(`session clock: ${sessionMin} min from now; the networks stop at their next round once their part is used up, the rest is the decision models'`); }
      const decision = DECISION_STEPS.includes(step);
      if (decision) enterDecisionPhase();
      if (sessionTimeUp()) {
        const why = decision ? `the ${sessionMin}-minute session is used up: it runs next session` : `the networks' part of the ${sessionMin}-minute session is used up (the rest is the decision models'): it runs next session`;
        steps.push({ step, ok: true, skipped: why, ms: 0 });
        log(`${step}: skipped (${why})`);
        return undefined;
      }
    }
    const hm = () => new Date().toISOString().slice(11, 16);
    log(`${step}: running... (${hm()} UTC)`);
    try {
      const detail = await fn();
      steps.push({ step, ok: true, ms: Date.now() - t0, detail });
      log(`${step}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s (${hm()} UTC)`);
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
  // Retrain steps that would give the same result are skipped: nothing they read changed since their last completed
  // run (the same code and settings, no new recordings, replay days or SNN outputs, no model replaced). Common on the
  // laptop trainer: a round after a stop, or a round whose tournaments promoted nothing.
  // Time budgets (the laptop trainer sizes them to the session) are left out: they change no decision model's inputs.
  const settingsSig = crypto.createHash('sha1').update(JSON.stringify({ ...cfg, taNet: { ...cfg.taNet, kalshiHistoryBudgetMin: 0 }, autoTrain: { ...A, sweepHours: 0, taNetOosHours: 0, snnPbtDays: 0, snnTrainDays: 0 } })).digest('hex');
  // What the steps read: the networks and studies the features come from, then each step's own upstream models (a
  // step's own output is not among them, or a promotion would make it due again next round).
  const MF = MODEL_FILES;
  const UPSTREAM = [MF.ta_net, MF.ta_net_wf, MF.librarian, MF.cross_graph, MF.cross_lead, MF.snn_crypto, MF.snn_perps, MF.snn_tennis, MF.setups, 'rule_book.json', 'gp_indicators.json', 'lead_lag.json', 'setup_snn_gate.json'];
  const READS: Record<string, string[]> = {
    vol_model: UPSTREAM, vol: UPSTREAM, perps: UPSTREAM, tennis: UPSTREAM,
    dataset: [...UPSTREAM, MF.vol_model],
    mlp: [...UPSTREAM, MF.vol_model, MF.fill, 'work/dataset.jsonl'],
    playbook: [...UPSTREAM, MF.vol_model, MF.fill, MF.mlp, MF.perp, MF.vol, MF.tennis, 'setup_oos.json'],
    readiness: [...UPSTREAM, MF.vol_model, MF.fill, MF.mlp, MF.perp, MF.vol, MF.tennis, 'setup_oos.json', 'playbook.json'],
  };
  const inputsNow = (step: string) => inputsSignature({
    code: process.argv[1] ?? '', settings: settingsSig, extra: state.lastHistoryUpdate ?? 0,
    dirs: [rec, T.historyReplayDir, fillRoot], files: [...(READS[step] ?? UPSTREAM).map((f) => path.join(A.dir, f)), path.resolve('params', 'calendar.json')],
  });
  const ifChanged = (step: string, fn: () => Promise<unknown>) => async () => {
    const prev = state.stepInputs?.[step];
    if (A.skipUnchanged && prev && prev.sig === inputsNow(step)) throw new SkipStep(`nothing it reads changed since its run at ${new Date(prev.at).toISOString().slice(0, 16).replace('T', ' ')} UTC (no new recordings, replay days or models)`);
    const r = await fn();
    // Taken after the run: what it wrote is part of what the next run would read.
    (state.stepInputs ??= {})[step] = { sig: inputsNow(step), at: Date.now() };
    return r;
  };
  const tooFew = days.length < A.minDays ? `only ${days.length} day(s) of recordings in ${rec} (< AUTO_TRAIN_MIN_DAYS=${A.minDays})` : undefined;
  const lastDays = (n: number) => (days.length ? days.slice(-n) : []);
  // The recorded days before today (today's file is still being written).
  const completeDays = days.filter((d) => d < new Date(now).toISOString().slice(0, 10));
  // How far the recordings have grown (and what that unlocks): reported every run.
  {
    const u = recordingsUsage(rec);
    const journalTrades = readJournalTrades(path.join(cfg.dataDir, 'setups')).filter((t) => t.snn_up1 !== null || t.snn_up4 !== null).length;
    const g = (have: number, need: number) => ({ have, need, ready: have >= need });
    state.readiness = {
      recordedDays: days.length, firstDay: days[0] ?? null, lastDay: days[days.length - 1] ?? null, recordingsGb: +(u.bytes / 1e9).toFixed(2), freeGb: u.freeBytes !== undefined ? +(u.freeBytes / 1e9).toFixed(1) : null,
      gates: {
        'snn / mlp / perps / vol_model (AUTO_TRAIN_MIN_DAYS)': g(days.length, A.minDays),
        'sweep kalshi': g(completeDays.length, SWEEP_MIN_DAYS), 'sweep bot (whole-bot replay)': g(completeDays.length, SWEEP_MIN_DAYS),
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
  // The Librarian the datasets' features read (its validated heads; the promoted file, else the shipped one).
  setLibrarianPath(T.enabled ? () => (fs.existsSync(promoted('librarian')) ? promoted('librarian') : cfg.taNet.librarianPath) : undefined);
  setCrossGraphPath(T.enabled ? () => (fs.existsSync(promoted('cross_graph')) ? promoted('cross_graph') : cfg.taNet.crossGraphPath) : undefined);
  setCrossLeadPath(() => (fs.existsSync(promoted('cross_lead')) ? promoted('cross_lead') : cfg.taNet.crossLeadPath));
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
      const recheckMs = T.historyRecheckHours * 3_600_000;
      const bin = await downloadBinance({ out: T.historyDir, assets, intervals: T.binanceIntervals as HistTf[], markets: ['spot' as BinanceMarket], recheckMs, log: (m) => log(`binance: ${m}`) });
      // Binance's BTC dominance index (BTC vs the top-20 alts): an input of the TA network.
      bin.push(...await downloadBinance({ out: T.historyDir, assets: BINANCE_INDEXES, intervals: ['1h'], markets: ['um-index'], recheckMs, log: (m) => log(`binance: ${m}`) }));
      // The live bot rebuilds BTCDOM itself (Binance's futures API refuses US servers): check it tracks
      // Binance's own index wherever both exist.
      // The history replay's inputs: 1-minute spot (kept apart from the TA steps' store) and perpetual bars,
      // and funding rates, for the replayed assets and years (HISTORY_REPLAY_YEARS=0: everything Binance
      // has, from each coin's first month).
      let replayInputs: unknown;
      if (T.historyReplay) {
        const fromMonth = T.historyReplayYears > 0 ? new Date(now - T.historyReplayYears * 365 * 86_400_000).toISOString().slice(0, 7) : undefined;
        const rs = await downloadBinance({ out: T.historyDir, assets: T.historyReplayAssets, intervals: ['1m'], markets: ['spot'], source: 'binance-1m', fromMonth, recheckMs, log: (m) => log(`binance: ${m}`) });
        const ru = await downloadBinance({ out: T.historyDir, assets: T.historyReplayAssets, intervals: ['1m'], markets: ['um'], fromMonth, recheckMs, log: (m) => log(`binance: ${m}`) });
        const fu = await downloadBinanceFunding({ out: T.historyDir, assets: T.historyReplayAssets, fromMonth, recheckMs, log: (m) => log(`binance: ${m}`) });
        // Open interest every 5 minutes (from September 2020): the perps model's open-interest inputs.
        const oi = await downloadBinanceOpenInterest({ out: T.historyDir, assets: T.historyReplayAssets, fromDay: fromMonth ? `${fromMonth}-01` : undefined, recheckMs, log: (m) => log(`binance: ${m}`) });
        replayInputs = { spot1m: rs.reduce((a, b) => a + b.fetched, 0), perp1m: ru.reduce((a, b) => a + b.fetched, 0), funding: fu.map((f) => `${f.asset} ${f.rows}`), openInterest: oi.map((f) => `${f.asset} ${f.rows}`) };
      }
      const btcdomCheck = compareIndexSources(T.historyDir, 'BTCDOM', 'binance-index', 'bot-index');
      if (btcdomCheck.overlap) log(`BTCDOM: live rebuild vs Binance over ${btcdomCheck.overlap} hours: hourly return correlation ${btcdomCheck.returnCorr.toFixed(3)}, level ratio ${btcdomCheck.levelRatio.toFixed(4)}`);
      const cb = T.coinbaseTfs.length ? await backfillCoinbase({ out: T.historyDir, assets, tfs: T.coinbaseTfs as HistTf[], fromTs: Date.parse('2015-01-01T00:00:00Z'), baseUrl: cfg.coinbaseRestUrl, recheckMs, log: (m) => log(`coinbase: ${m}`) }) : [];
      // TradingView (tvdatafeed): the index series' 5,000-bar backfill and daily refresh, and the spot holes
      // (before the Kalshi download: models read these; the Kalshi candles are research material).
      let tradingview: unknown;
      if (T.tvFill) {
        state.tvTried ??= {};
        // BTC.D and USDT.D must reach back to the Fractal Alignment Engine's parent window (2016-2017 by default).
        try { tradingview = await tvFill({ histDir: T.historyDir, assets, log: (m) => log(`tradingview: ${m}`), tried: state.tvTried, needFrom: dominanceNeedFrom(cfg.macro.parentFrom) }); } catch (e) { tradingview = { error: String(e) }; }
      }
      // Kalshi's own settled contracts (1-minute candles) for the traded series: real contract prices for
      // research. Time-boxed (KALSHI_HISTORY_BUDGET_MIN); the rest resumes on the next run.
      // Tennis: the match markets too, then every match's trade tape (real price swings, trade by trade).
      let kalshi: unknown;
      if (T.kalshiHistoryBudgetMin > 0) {
        const kStart = Date.now(), budget = T.kalshiHistoryBudgetMin * 60_000;
        const tennisSeries = cfg.tennis.enabled ? cfg.tennis.series : [];
        try {
          const markets = await downloadKalshiHistory({ baseUrl: cfg.restBaseUrl, series: [...cfg.strategy.series, ...tennisSeries], days: T.kalshiHistoryDays, out: path.join(T.historyDir, 'kalshi'), budgetMs: budget, recheckMs, log: (m) => log(`kalshi: ${m}`) });
          const left = budget - (Date.now() - kStart);
          const tapes = tennisSeries.length && left > 60_000 ? await downloadKalshiTrades({ baseUrl: cfg.restBaseUrl, series: tennisSeries, out: path.join(T.historyDir, 'kalshi'), budgetMs: left, log: (m) => log(`kalshi trades: ${m}`) }) : undefined;
          kalshi = { markets, tennisTapes: tapes ?? (tennisSeries.length ? { skipped: 'no time left in KALSHI_HISTORY_BUDGET_MIN' } : undefined) };
        } catch (e) { kalshi = { error: String(e) }; }
      } else kalshi = { skipped: 'KALSHI_HISTORY_BUDGET_MIN=0' };
      // Reached: listed something this run, or checked it completely within HISTORY_RECHECK_HOURS.
      const reached = bin.some((b) => b.listed > 0 || b.fresh) || cb.some((c) => c.fresh || (c.requests > 0 && !/kept failing/.test(c.note ?? '')));
      if (!reached) throw new SkipStep('Binance Vision and Coinbase unreachable from this machine');
      state.lastHistoryUpdate = now;
      return { replayInputs, tradingview, kalshi, assets, binance: { fetched: bin.reduce((a, b) => a + b.fetched, 0), failed: bin.reduce((a, b) => a + b.failed, 0) }, coinbase: { added: cb.reduce((a, c) => a + c.added, 0) }, btcdomCheck };
    }, T.historyUpdate ? undefined : 'HISTORY_AUTO_UPDATE=false');
  }
  // The index series (BTC.D, USDT.D and the rest of TV_INDEXES) when the history step is left out: the trainer's
  // "Skip data download", or a round that continues the training. Training reads them from disk: only a series missing
  // there (or short of its history) is fetched, once, and nothing is refreshed (the history step and the laptop
  // trainer's copy from the server keep them current). The setups' fractal and waterfall inputs, the TA network's
  // dominance context and the replay's dominance events read them. Its log line gives each series' first and last day. Only where
  // HISTORY_INDEX_FILL=true: the laptop trainer sets it; the server's own runs keep the history step.
  if (process.env.HISTORY_INDEX_FILL === 'true' && !want('history') && (['history_replay', 'ta_net', 'setups'] as const).some((s) => want(s))) {
    const onDisk = () => {
      const daily = indexNeeds(T.historyDir, Date.now()).daily;
      const cover = (k: string) => (daily[k]?.first ? `${k} ${daily[k].first}..${daily[k].last}` : `${k} none`);
      return { daily, text: `${cover('BTC.D')}, ${cover('USDT.D')}`, missing: ['BTC.D', 'USDT.D'].filter((k) => !daily[k]?.first) };
    };
    const before = onDisk();
    await run('history-index', async () => {
      state.tvTried ??= {};
      const r = await tvFill({ histDir: T.historyDir, assets: [], spot: false, refresh: false, log: (m) => log(`tradingview: ${m}`), tried: state.tvTried, needFrom: dominanceNeedFrom(cfg.macro.parentFrom) });
      const after = onDisk();
      log(`index series on disk: ${after.text}`);
      if (after.missing.length) throw new Error(`${after.missing.join(' and ')} still missing after the TradingView fill (exit codes: ${r.exitCodes.join(', ') || 'none'})`);
      if (r.skipped) throw new SkipStep(`on disk: ${after.text}`);
      return { ...r, coverage: { 'BTC.D': after.daily['BTC.D'], 'USDT.D': after.daily['USDT.D'] } };
    }, T.tvFill ? undefined : `TradingView fill off (TV_FILL=false, or its Python is not set up); on disk: ${before.text}`);
  }
  // ---- History replay: years of history as recordings (research/history/historyReplay.ts) ----
  const replayDir = T.historyReplayDir;
  const replayDays = () => recordingDays(replayDir);
  if (want('history_replay')) {
    await run('history_replay', async () => {
      const yesterday = new Date(Math.floor(now / 86_400_000) * 86_400_000 - 86_400_000).toISOString().slice(0, 10);
      // From the first day of 1-minute history (HISTORY_REPLAY_YEARS=0), else the last N years.
      const fromDay = T.historyReplayYears > 0 ? new Date(now - T.historyReplayYears * 365 * 86_400_000).toISOString().slice(0, 10) : historyStart(T.historyDir, T.historyReplayAssets) ?? yesterday;
      const perpSpecs = await perpSpecsFromRecordings(rec, T.historyReplayAssets);
      const r = await buildHistoryReplay({ historyDir: T.historyDir, outDir: replayDir, assets: T.historyReplayAssets, fromDay, toDay: yesterday, perpSpecs, tennisSeries: cfg.tennis.enabled ? cfg.tennis.series : [], log });
      if (!r.assets.length) throw new SkipStep(`no 1-minute history yet (${r.notes.join('; ')})`);
      return { ...r, perpSpecs: Object.keys(perpSpecs) };
    }, T.historyReplay ? undefined : 'HISTORY_REPLAY=false');
  }
  // ---- 0b'. The oracle cull: every TA reading against what paid in hindsight (research/oracleCull.ts) ----
  const cullFile = path.join(A.dir, 'oracle_cull.json');
  const cullOn = process.env.ORACLE_CULL !== 'false';
  if (want('oracle_cull')) {
    const due = !fs.existsSync(cullFile) || !state.oracleCullAt || now - state.oracleCullAt >= 7 * 86_400_000;
    const noHistory = storedAssets(T.historyDir).length ? undefined : `no history in ${T.historyDir} yet`;
    await run('oracle_cull', async () => {
      let f;
      try {
        f = await trainOracleCull(T.historyDir, { cacheDir: path.join(work, 'tanet-cache'), level: process.env.ORACLE_CULL_LEVEL === 'unproven' ? 'unproven' : 'noise', log });
      } catch (e) {
        if (/needs years|needs \d+ days/.test((e as Error).message)) throw new SkipStep((e as Error).message);
        throw e;
      }
      writeAtomic(cullFile, JSON.stringify(f, null, 1));
      state.oracleCullAt = now;
      for (const l of cullSummary(f)) log(`[oracle-cull] ${l}`);
      return { file: cullFile, readings: f.items.length, proven: f.proven.length, culled: f.culled.length, level: f.level, judged: `${f.from}..${f.to}`, days: f.days };
    }, !cullOn ? 'ORACLE_CULL=false' : !T.enabled ? 'TA_NET=false' : noHistory ?? (due ? undefined : `ran ${((now - state.oracleCullAt!) / 86_400_000).toFixed(1)} day(s) ago (weekly)`));
  }
  // The TA network and the Librarian read every TA reading the cull kept.
  const cullArg = cullOn && fs.existsSync(cullFile) ? cullFile : undefined;

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
          'max-rounds': T.maxRoundsPerRun || undefined, 'restart-every': T.restartEvery, arch: T.arch, engine: T.engine, python: T.python || undefined,
          population: T.population, parents: A.gaParents, islands: A.gaIslands, 'breed-every': A.gaBreedEvery, mutation: A.gaMutation,
          incumbent: fs.existsSync(taNetFile) ? taNetFile : undefined, cull: cullArg,
        }));
      } catch (e) {
        if (/need at least/.test((e as Error).message)) throw new SkipStep((e as Error).message);
        throw e;
      }
      const validated = Object.entries(rep.params.heads).filter(([, h]) => h?.validation.validated).map(([k]) => k);
      state.taNetComplete = rep.complete;
      // The initialisation runs in chunks of rounds (one chunk per daily run); nothing is promoted
      // until the tournament has reached the present.
      if (!rep.complete) return { promoted: false, complete: false, reason: `tournament in progress: ${rep.rounds} round(s) done, ${rep.remaining} to go (continues on the next run)`, ...(rep.ga ? { ga: rep.ga } : {}) };
      state.taNetTrainedAt = now;
      const summary = { rounds: rep.rounds, newRounds: rep.newRounds, network: rep.params.network, heads: Object.fromEntries(Object.entries(rep.params.heads).map(([k, h]) => [k, h.validation])), elite: rep.params.pbt.elite, ...(rep.ga ? { ga: rep.ga } : {}) };
      if (A.promote === 'validated' && !validated.length) return { promoted: false, version: rep.params.version, reason: 'no head passed the holdout and network hurdles', ...summary };
      // No new tournament round since the network in use was trained: the same elite retrained on the same
      // months scores the same. It stays (re-promoting it would only fill the ensemble's archive with copies).
      if (rep.newRounds === 0 && rep.champion?.incumbent != null && !(rep.champion.candidate < rep.champion.incumbent)) return { promoted: false, version: rep.params.version, reason: 'no new tournament round since the network in use: it stays', champion: rep.champion, ...summary };
      const champ = promoteIfChampion({ dir: A.dir, kind: 'ta_net', candidate: cand, live: taNetFile, enabled: A.champion, candidateScore: rep.champion?.candidate, incumbentScore: rep.champion?.incumbent });
      if (!champ.promote) return { promoted: false, version: rep.params.version, reason: champ.reason, champion: rep.champion, ...summary };
      state.taNetVersion = rep.params.version;
      installTaNet();
      return { promoted: true, improved: champ.improved, version: rep.params.version, validatedHeads: validated, champion: { ...rep.champion, reason: champ.reason, archived: champ.archived ?? null }, ...summary };
    }, !T.enabled ? 'TA_NET=false' : noHistory ?? (due ? undefined : `trained ${((now - state.taNetTrainedAt!) / 86_400_000).toFixed(1)} day(s) ago (TA_NET_RETRAIN_DAYS=${T.retrainEveryDays})`));
  }

  // ---- 0c. Walk-forward TA network forecasts for the setup scorer (and the walking network for live) ----
  if (want('ta_net_oos')) {
    const noHistory = storedAssets(T.historyDir).length ? undefined : `no history in ${T.historyDir} yet`;
    await run('ta_net_oos', async () => {
      const params = fs.existsSync(taNetFile) && taNetFileSchema(taNetFile) === TANET_SCHEMA ? taNetFile : T.modelPath;
      if (!fs.existsSync(params)) throw new SkipStep('no TA network yet');
      const r = await exportTaNetOos(T.historyDir, { paramsPath: params, cacheDir: path.join(work, 'tanet-cache'), hours: capHours(A.taNetOosHours), engine: T.engine, python: T.python || undefined, log });
      const wf = path.join(oosDir(T.historyDir), 'ta_net_wf.json');
      if (r.complete && fs.existsSync(wf)) fs.copyFileSync(wf, promoted('ta_net_wf'));
      return { ...r, promoted: r.complete };
    }, cfg.perps.strategy !== 'setups' ? 'PERP_STRATEGY is not setups' : !T.enabled ? 'TA_NET=false' : noHistory);
  }

  // ---- 0c+. The Librarian: oracle strategy + regime-transition heads on the TA network's inputs (research/librarian.ts) ----
  if (want('librarian')) {
    const file = promoted('librarian');
    // Also due when the walk-forward forecasts the setup scorer reads are missing (a model file copied from elsewhere,
    // or a run that stopped before writing them): otherwise the setups would train without them for a week.
    const due = !fs.existsSync(file) || !state.librarianAt || now - state.librarianAt >= 7 * 86_400_000 || readLibSchema(file) !== LIB_SCHEMA
      || forecastSchema(path.join(libDir(T.historyDir), 'forecasts.json')) !== LIB_SCHEMA;
    const noHistory = storedAssets(T.historyDir).length ? undefined : `no history in ${T.historyDir} yet`;
    await run('librarian', async () => {
      const r = await trainLibrarian(T.historyDir, { cacheDir: path.join(work, 'tanet-cache'), cull: readCull(cullArg), log });
      writeAtomic(file, JSON.stringify(r.params));
      state.librarianAt = now;
      return { promoted: true, version: r.params.version, rows: r.rows, refits: r.refits, from: r.from, forecastHours: r.forecastHours, strategy: r.params.strategy.validation, transition: r.params.transition.validation };
    }, !T.enabled ? 'TA_NET=false' : noHistory ?? (due ? undefined : `trained ${((now - state.librarianAt!) / 86_400_000).toFixed(1)} day(s) ago (weekly)`));
  }

  // ---- 0c~. The cross-asset graph network on relative returns (research/trainCrossGraph.ts) ----
  if (want('cross_graph')) {
    const file = promoted('cross_graph');
    const due = !fs.existsSync(file) || !state.crossGraphAt || now - state.crossGraphAt >= 7 * 86_400_000 || readLibSchema(file) !== XG_SCHEMA
      || forecastSchema(path.join(xgDir(T.historyDir), 'forecasts.json')) !== XG_SCHEMA;
    const noHistory = storedAssets(T.historyDir).length ? undefined : `no history in ${T.historyDir} yet`;
    await run('cross_graph', async () => {
      const r = await trainCrossGraph(T.historyDir, { engine: cfg.taNet.xgEngine, python: T.python || undefined, log });
      writeAtomic(file, JSON.stringify(r.params));
      state.crossGraphAt = now;
      return { promoted: true, version: r.params.version, engine: r.params.engine, samples: r.samples, refits: r.refits, from: r.from, forecastHours: r.forecastHours, validation: r.params.validation };
    }, !T.enabled ? 'TA_NET=false' : noHistory ?? (due ? undefined : `trained ${((now - state.crossGraphAt!) / 86_400_000).toFixed(1)} day(s) ago (weekly)`));
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
      return { tests: f.rows.length, passed: f.rows.filter((r) => r.pass).length, pairsLogged: f.combos?.length ?? 0, pairsPassed: f.combos?.filter((c) => c.pass).length ?? 0, conditionsPassed: f.conditions?.filter((c) => c.pass).length ?? 0, invalidationsPassed: f.invalidations?.filter((v) => v.pass).length ?? 0, character: { accuracy: f.character.accuracy, baseline: f.character.baseline }, from: f.from, to: f.to, splitAt: f.splitAt };
    }, noHistory ?? (due ? undefined : `ran ${((now - state.ruleBookAt!) / 86_400_000).toFixed(1)} day(s) ago (weekly)`));
  }

  // ---- 0c''. Evolved formulas: genetic programming on years of hourly bars (research/gpIndicators.ts) ----
  if (want('gp')) {
    const file = path.join(A.dir, 'gp_indicators.json');
    const due = !fs.existsSync(file) || !state.gpAt || now - state.gpAt >= A.gpEveryDays * 86_400_000;
    const noHistory = storedAssets(T.historyDir).length ? undefined : `no history in ${T.historyDir} yet`;
    await run('gp', async () => {
      const assets = gpAssets(T.historyDir, A.gpAssets);
      if (!assets.length) throw new SkipStep(`no hourly history for ${A.gpAssets.join(', ') || 'BTC, ETH, SOL, XRP, DOGE'}`);
      const incumbent = readGpFile(file);
      const r = await runGp({ dir: T.historyDir, assets, cross: A.gpCross, incumbent, log,
        opts: { population: A.gpPopulation, generations: A.gpGenerations, fitness: A.gpFitness, costBps: A.gpCostBps, band: A.gpBand, minPsr: A.gpMinPsr, workers: workerCount(), stop: sessionTimeUp } });
      if (!Object.keys(r.file.champions).length) throw new SkipStep(`no coin has enough hourly history (${Object.entries(r.skipped).map(([a, w]) => `${a}: ${w}`).join('; ')})`);
      // The champions per coin: a new one only where it beat the one in use on the same test years.
      const archived = incumbent && r.improved.length ? archiveModel(A.dir, 'gp', file) : undefined;
      writeAtomic(file, JSON.stringify(r.file));
      state.gpAt = now;
      for (const l of gpSummary(r.file)) log(`[gp] ${l}`);
      return {
        promoted: r.improved.length > 0, improved: r.improved.length > 0, improvedAssets: r.improved, kept: r.kept, skipped: r.skipped, archived,
        champions: Object.fromEntries(Object.values(r.file.champions).map((c) => [c.asset, { formula: c.formula, validated: c.validated, testSharpe: c.test.sharpe, testReturn: c.test.totalReturn, buyHoldTest: c.buyHoldTest, maxDd: c.test.maxDd, why: c.why }])),
      };
    }, noHistory ?? (due ? undefined : `ran ${((now - state.gpAt!) / 86_400_000).toFixed(1)} day(s) ago (every ${A.gpEveryDays} day(s))`));
  }

  // ---- 0c`. Cross-coin lead-lag on the 1-minute history (research/crossLead.ts) ----
  if (want('cross_lead')) {
    const file = promoted('cross_lead');
    const due = !fs.existsSync(file) || !state.crossLeadAt || now - state.crossLeadAt >= 7 * 86_400_000 || readLibSchema(file) !== CL_SCHEMA;
    const noMinutes = fs.existsSync(path.join(T.historyDir, 'binance-1m')) ? undefined : `no 1-minute history in ${T.historyDir}/binance-1m (the history step downloads it with HISTORY_REPLAY=true)`;
    await run('cross_lead', async () => {
      const p = await trainCrossLead(T.historyDir, { log });
      writeAtomic(file, JSON.stringify(p));
      state.crossLeadAt = now;
      return { promoted: true, version: p.version, from: p.from, tests: p.tests, validated: p.pairs.filter((x) => x.validated).map((x) => `${x.leader}->${x.follower} ${x.h}m`), tradable: p.pairs.filter((x) => x.tradable).map((x) => `${x.leader}->${x.follower} ${x.h}m`) };
    }, noMinutes ?? (due ? undefined : `ran ${((now - state.crossLeadAt!) / 86_400_000).toFixed(1)} day(s) ago (weekly)`));
  }

  // ---- 0d. Setup scorer for the fast / slow lane trader (years of 15m / 1h / daily candles) ----
  if (want('setups')) {
    const file = promoted('setups');
    const P = cfg.perps;
    const noHistory = storedAssets(T.historyDir).length ? undefined : `no history in ${T.historyDir} yet`;
    // An optional input that has arrived since the last training (BTC.D's early years, the Librarian's forecasts, a
    // lead-lag study with a validated pair)
    // makes it due now instead of after SETUP_RETRAIN_DAYS.
    const clFile = fs.existsSync(promoted('cross_lead')) ? promoted('cross_lead') : cfg.taNet.crossLeadPath;
    const inputs = noHistory ? [] : setupInputStatus(T.historyDir, cfg.macro, clFile);
    const arrived = inputs.filter((x) => x.ok && !(state.setupInputs ?? []).includes(x.name)).map((x) => x.name);
    const due = !fs.existsSync(file) || !state.setupsTrainedAt || now - state.setupsTrainedAt >= P.setupRetrainDays * 86_400_000 || arrived.length > 0;
    await run('setups', async () => {
      // Which optional inputs are plugged in, and for a missing one what its producing step did this round.
      const stepNow = (name: string) => {
        const st = steps.find((x) => x.step === name || x.step.startsWith(`${name} `));
        return !st ? 'did not run this round' : st.error ? `FAILED this round: ${st.error.split('\n')[0].slice(0, 200)}` : st.skipped ? `skipped this round (${st.skipped})` : 'ran this round';
      };
      log(`setups: inputs: ${inputs.map((x) => (x.ok ? `${x.name}: yes` : `${x.name}: MISSING (${x.producer.split(' ')[0] === 'history' ? `${x.detail}; TradingView fill ${T.tvFill ? 'on' : 'off'}, history ${stepNow('history')}` : `${x.detail ? `${x.detail}; ` : ''}${x.producer} ${stepNow(x.producer)}`})`)).join('; ')}${arrived.length && state.setupsTrainedAt ? ` (new since the last training: ${arrived.join(', ')})` : ''}`);
      const cand = path.join(work, 'setup_model.candidate.json');
      const oosCand = path.join(work, 'setup_oos.candidate.json');
      const p = await trainSetupMain(argsOf({
        history: T.historyDir, out: cand, 'oos-out': oosCand, equity: P.paperBalanceUsd > 100 ? P.paperBalanceUsd : 10_000,
        ratchet: P.setupRatchet, 'ratchet-stop-atr': P.setupRatchetStopAtr, 'ratchet-be-atr': P.setupRatchetBeAtr, 'ratchet-trail-start-atr': P.setupRatchetTrailStartAtr, 'ratchet-trail-atr': P.setupRatchetTrailAtr, 'ratchet-vol-k': P.setupRatchetVolK,
        'scale-out': P.setupScaleOut, 'scale-r1': P.setupScaleR1, 'scale-f1': P.setupScaleF1, 'scale-r2': P.setupScaleR2, 'scale-f2': P.setupScaleF2, 'scale-trail-atr': P.setupScaleTrailAtr,
        'spot-pb': P.setupSpotPb, 'lead-lag': path.join(A.dir, 'lead_lag.json'),
        'cross-lead': clFile,
      }));
      state.setupsTrainedAt = now;
      state.setupInputs = inputs.filter((x) => x.ok).map((x) => x.name);
      const validated = (['fast', 'slow'] as const).filter((l) => p.validation[l]?.passed);
      const summary = { version: p.version, validated, holdout: Object.fromEntries((['fast', 'slow'] as const).map((l) => [l, p.validation[l]?.periods.holdout])), reasons: Object.fromEntries((['fast', 'slow'] as const).map((l) => [l, p.validation[l]?.reasons])) };
      if (A.promote === 'validated' && !validated.length) return { promoted: false, reason: 'no lane passed its holdout and final window', ...summary };
      const champ = promoteIfChampion({ dir: A.dir, kind: 'setups', candidate: cand, live: file, enabled: A.champion });
      if (!champ.promote) return { promoted: false, reason: champ.reason, ...summary };
      // Its recent out-of-sample setups, for the whole-bot replay (research/wholeBot.ts).
      if (fs.existsSync(oosCand)) fs.copyFileSync(oosCand, path.join(A.dir, 'setup_oos.json'));
      state.setupsVersion = p.version;
      return { promoted: true, improved: champ.improved, champion: champ.reason, ...summary };
    }, cfg.perps.strategy !== 'setups' ? 'PERP_STRATEGY is not setups' : noHistory ?? (due ? undefined : `trained ${((now - state.setupsTrainedAt!) / 86_400_000).toFixed(1)} day(s) ago (SETUP_RETRAIN_DAYS=${P.setupRetrainDays})`));
  }

  // ---- 0e. SNN gate for the setup trader, from its own journal ----
  if (want('setup_snn')) {
    await run('setup_snn', async () => {
      const g = setupSnnMain(argsOf({ journal: path.join(cfg.dataDir, 'setups'), out: path.join(A.dir, 'setup_snn_gate.json') }));
      return g;
    }, cfg.perps.strategy !== 'setups' ? 'PERP_STRATEGY is not setups' : undefined);
  }

  // ---- 0c*. Does Coinbase spot lead the Kalshi perp? (research/leadLag.ts, on the recordings) ----
  if (want('lead_lag')) {
    const file = path.join(A.dir, 'lead_lag.json');
    const due = !fs.existsSync(file) || !state.leadLagAt || now - state.leadLagAt >= 7 * 86_400_000;
    await run('lead_lag', async () => {
      const f = await leadLagStudy(rec, { log });
      if (!Object.keys(f.assets).length) throw new SkipStep('no coin has both Coinbase spot prints and Kalshi perp quotes in the recordings');
      writeAtomic(file, JSON.stringify(f));
      state.leadLagAt = now;
      return { days: f.days.length, verdicts: Object.fromEntries(Object.values(f.assets).map((a) => [a.asset, a.verdict])), why: Object.fromEntries(Object.values(f.assets).map((a) => [a.asset, a.why])) };
    }, !fs.existsSync(rec) ? `no recordings in ${rec}` : due ? undefined : `ran ${((now - state.leadLagAt!) / 86_400_000).toFixed(1)} day(s) ago (weekly)`);
  }

  // ---- 0f. Sweep optimizer: setting by setting until a plateau, as a PROPOSAL (never auto-applied) ----
  // A sweep stopped part way (the trainer closed, its time budget used) is continued by the next run on exactly the
  // same days, every evaluation it already made taken from its ledger; only a finished sweep is archived and, once
  // SWEEP_EVERY_DAYS have passed, started again.
  if (want('sweep')) {
    state.sweptAt ??= {};
    for (const target of A.sweepTargets) {
      const last = state.sweptAt[target];
      const out = path.join(A.dir, 'sweeps', `${target}.json`);
      let ledger: { complete?: boolean; meta?: { days?: string[]; source?: string } } | undefined;
      try { ledger = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : undefined; } catch { ledger = undefined; }
      const unfinished = ledger?.complete === false;
      const due = unfinished || !last || now - last >= A.sweepEveryDays * 86_400_000;
      // The whole bot and the Kalshi settings are swept over the history replay's days that hold Kalshi's
      // real contracts, when there are enough of them (the strategy never trades the synthetic ones: they are
      // quoted at its own fair value). A proposal, never applied.
      const kDays = (target === 'bot' || target === 'kalshi') && T.historyReplay ? replayKalshiDays(replayDir) : [];
      await run(`sweep-${target}`, async () => {
        let sweepSrc = rec;
        const recorded = target === 'bot' || target === 'kalshi';
        let source: 'replay' | 'recordings' = kDays.length >= 20 && kDays.length > days.length ? 'replay' : 'recordings';
        // An unfinished sweep keeps its days (new days would change every score it has).
        let pinned = unfinished && ledger?.meta?.days?.length ? ledger.meta.days : undefined;
        if (pinned && ledger?.meta?.source === 'replay') source = 'replay';
        else if (pinned) source = 'recordings';
        if (recorded) {
          const files = new Map(recordingFiles(source === 'replay' ? replayDir : rec).map((f) => [f.day, f.file]));
          if (pinned && !pinned.every((d) => files.has(d))) { log(`sweep-${target}: some of the unfinished sweep's days are gone: starting over`); pinned = undefined; }
          // The most recent SWEEP_KALSHI_DAYS days of the replay (every setting tried replays all of them); an unfinished
          // sweep on more days than that (from before the cap) starts over on the recent ones. On the recordings, the
          // newest SWEEP_MIN_DAYS complete days: the bot keeps 20 (RECORDINGS_KEEP_DAYS), so a sweep has its days for 5
          // more daily runs, and none of its files changes (a file still being written would change every score).
          const cap = source === 'replay' ? A.sweepKalshiDays : SWEEP_MIN_DAYS;
          if (pinned && pinned.length > cap) { log(`sweep-${target}: the unfinished sweep is on ${pinned.length} days, over ${source === 'replay' ? `SWEEP_KALSHI_DAYS=${cap}` : `the ${cap} recorded days swept`}: starting over on the recent ones`); pinned = undefined; }
          const use = pinned ?? (source === 'replay' ? kDays.filter((d) => files.has(d)) : completeDays.filter((d) => files.has(d))).slice(-cap);
          sweepSrc = path.join(work, 'sweep-replay');
          fs.rmSync(sweepSrc, { recursive: true, force: true });
          linkDays(use.map((d) => ({ day: d, file: files.get(d)! })), sweepSrc);
          pinned = use;
        }
        if (!unfinished && fs.existsSync(out)) fs.renameSync(out, out.replace(/\.json$/, `.${new Date(now).toISOString().slice(0, 10)}.json`));
        let r;
        try {
          r = await sweepMain(argsOf({ target, hours: capHours(A.sweepHours), history: T.historyDir, recordings: sweepSrc, model: mlpPath(), out, 'setup-oos': path.join(A.dir, 'setup_oos.json'), 'setup-model': fs.existsSync(promoted('setups')) ? promoted('setups') : undefined, 'lead-lag': path.join(A.dir, 'lead_lag.json'), 'tape-dir': recorded ? path.join(work, 'kalshi-tape') : '' }), { meta: pinned ? { days: pinned, source } : undefined, log: (m) => log(`sweep-${target}: ${m}`) });
        } catch (e) {
          if (/needs at least|needs the TA network|recorded day/.test((e as Error).message)) throw new SkipStep((e as Error).message);
          throw e;
        }
        if (r.complete) {
          state.sweptAt![target] = now;
          // Its model-call tapes are of no use to the next sweep (other days, another model).
          for (const f of fs.existsSync(path.join(work, 'kalshi-tape')) ? fs.readdirSync(path.join(work, 'kalshi-tape')) : []) if (f.startsWith(`${target}-`)) fs.rmSync(path.join(work, 'kalshi-tape', f), { force: true });
        }
        return { proposal: out, complete: r.complete, data: !recorded ? 'history' : source === 'recordings' ? `recordings: ${pinned!.length} day(s)` : `history replay: ${pinned!.length} day(s) with real Kalshi contracts`, plateau: r.plateau, passes: r.passes, evaluations: r.evaluations, start: r.start, end: r.end, changed: r.steps.filter((x) => x.accepted).map((x) => `${x.param}: ${x.from} -> ${x.to}`) };
      }, due ? undefined : `swept ${((now - last!) / 86_400_000).toFixed(1)} day(s) ago (SWEEP_EVERY_DAYS=${A.sweepEveryDays})`);
    }
  }

  // ---- 1'. The tennis network on Kalshi's tennis history: every settled match replayed with its real
  // prices and tape (no score: Kalshi keeps none). Tournament over the most recent replayed days (members
  // judged on simulated bets against the market, settled by the result), then one network run online
  // through the training days: each match column starts from the tennis template and folds back into it,
  // so what it learns carries from match to match. Without tennis history it keeps learning live only.
  const tennisNetwork = async () => {
    const tennisDays = T.historyReplay ? replayTennisDays(replayDir) : [];
    if (!cfg.snn.domains.tennis.enabled) { await run('snn-tennis', async () => undefined, 'SNN_TENNIS=false'); return; }
    if (tennisDays.length < A.snnPbtInitDays + 2) { await run('snn-tennis', async () => undefined, `learns live only: ${tennisDays.length} replayed day(s) of Kalshi tennis history (HISTORY_REPLAY with TENNIS_ENABLED downloads it)`); return; }
    const ds: SnnDomainState = (state.snn!.tennis ??= {});
    const stage: Stage = A.snnStage === 'auto' ? (ds.stage ?? cfg.snn.domains.tennis.stage) : A.snnStage;
    const file = promoted('snn_tennis');
    const pbtDue = o.forceSnnPbt || ds.pbtStage !== stage || !ds.pbtHyper || ds.pbtComplete === false || (A.snnPbtEveryDays > 0 && now - (ds.pbtAt ?? 0) >= A.snnPbtEveryDays * 86_400_000);
    const pbt = await run('snn-tennis-pbt', async () => {
      let r;
      try {
        r = await runSnnPbt({ recordings: replayDir, domain: 'tennis', stage, days: tennisDays.slice(-A.snnPbtDays), initDays: A.snnPbtInitDays, evalDays: 1, stateDir: path.join(work, 'snnpbt', 'tennis'), maxRounds: A.snnPbtMaxRounds || undefined, restartEvery: A.snnPbtRestartEvery, fresh: ds.pbtStage !== undefined && ds.pbtStage !== stage, population: A.snnPbtPopulation, workers: workerCount(), genetic, tennis: cfg.tennis, log, stop: sessionTimeUp });
      } catch (e) {
        if (/need at least/.test((e as Error).message)) throw new SkipStep((e as Error).message);
        throw e;
      }
      ds.pbtComplete = r.complete;
      if (!r.complete) return { complete: false, reason: `tournament in progress: ${r.rounds} round(s) done, ${r.remaining} to go`, elite: r.elite };
      ds.pbtHyper = r.elite.hyper; ds.pbtStage = stage; ds.pbtAt = now;
      const tw = [...new Set(tennisDays.slice(-A.snnPbtDays).map(isoWeek))];
      const g = ledger.begin('snn-tennis', 'tournament', tw.map((id) => ({ id, days: [] })));
      ledger.markTrained('snn-tennis', tw); ledger.finish('snn-tennis', g.id, `elite #${r.elite.member}`); ledger.save();
      return { complete: true, rounds: r.rounds, trials: r.trials, elite: r.elite, dsr: r.dsr, population: A.snnPbtPopulation, data: `history replay (${tennisDays.length} day(s) with tennis)`, ...(r.ga ? { ga: r.ga } : {}) };
    }, pbtDue ? undefined : `knobs chosen ${(((now - (ds.pbtAt ?? now)) / 86_400_000)).toFixed(1)} day(s) ago`) as { complete?: boolean } | undefined;
    const hyper = ds.pbtStage === stage ? ds.pbtHyper : undefined;
    const trainNeeded = Boolean(pbt?.complete) || !fs.existsSync(file) || ds.stage !== stage;
    await run('snn-tennis-train', async () => {
      const span = tennisDays.slice(-A.snnTrainDays);
      const params = withSnnHyper(domainParams('tennis', { ...DEFAULT_SNN, flags: { ...stageFlags(stage), ...cfg.snn.deferred }, seed: cfg.snn.seed, maxColumns: cfg.snn.maxColumns, readoutEta: cfg.snn.readoutEta }), hyper);
      const r = await replaySnn(replayDir, { params, domain: 'tennis', tennis: cfg.tennis, skipModel: true, from: dayMs(span[0]), to: dayMs(nextDay(span[span.length - 1])), fromDay: span[0], toDay: span[span.length - 1] });
      const matches = r.net.tennisTemplate?.n ?? 0;
      if (!matches) throw new SkipStep('no tennis match settled in the replayed days');
      const cand = path.join(work, 'snn_tennis.candidate.json');
      writeAtomic(cand, JSON.stringify(r.net.exportModel(`tennis stage ${stage}; online over ${span.length} replayed day(s) of Kalshi tennis history; template of ${matches} match(es)`)));
      const b = (f: (x: { pSnn: number; mid: number }) => number) => r.rows.reduce((a, x) => a + (f(x) - x.y) ** 2, 0) / Math.max(1, r.rows.length);
      const first = !fs.existsSync(file);
      fs.copyFileSync(cand, file);
      ledger.markTrained('snn-tennis', [...new Set(span.map(isoWeek))]); ledger.save();
      ds.stage = stage; ds.version = versionHash(params);
      if (state.snnVersions!.tennis !== ds.version) snnChanged.push('tennis');
      state.snnVersions!.tennis = ds.version;
      return { promoted: true, improved: first, stage, matches, rows: r.rows.length, brier: { snn: b((x) => x.pSnn), market: b((x) => x.mid) } };
    }, trainNeeded ? undefined : 'up to date');
  };

  // ---- 1. The networks first, each alone: ablation (when due) -> train -> backfill ----
  const snnChanged: SnnDomain[] = [];
  state.snn ??= {}; state.snnVersions ??= {}; state.trainedWithSnn ??= {};
  if (want('snn')) {
    // With the session clock the network whose tournament ran longest ago goes first: a session that ends part-way
    // through one network's tournament leaves the other for the next session instead of never reaching it.
    const snnOrder = sessionMin > 0 ? [...REPLAYABLE].sort((a, b) => (state.snn![a]?.turnAt ?? 0) - (state.snn![b]?.turnAt ?? 0)) : REPLAYABLE;
    for (const domain of snnOrder) {
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
      // Population tournament: identical networks of this stage, knobs within +/-10%, fight over the days;
      // the elite's knobs are this network's hyperparameters from now on. On the history replay the days
      // are blocks spread over all its years (perps: from Binance's first perpetual), so the knobs must
      // hold up in every kind of market; on the recordings, the latest days.
      // On the history replay the history ledger (research/historyLedger.ts) picks the tournament's days:
      // each generation is weeks this network has never trained on, spread over all the years, and the
      // population carries on from one generation to the next (every round of the laptop trainer runs one).
      // Holdout weeks are never trained on: the contest below is run there.
      const ledgerNet = `snn-${domain}`;
      const weeks = src === rec ? [] : weekBlocks(domain === 'perps' ? replayPerpDays(replayDir) : srcDays);
      const latestDay = srcDays[srcDays.length - 1];
      let gen = src === rec ? undefined : ledger.current(ledgerNet, 'tournament');
      if (src !== rec && !gen) {
        // A new stage (or no knobs yet, or a forced re-run) needs its tournament even with no fresh week left:
        // it then takes the weeks this network has trained on least.
        const reuse = Boolean(o.forceSnnPbt) || ds.pbtStage !== stage || !ds.pbtHyper;
        const pick = ledger.pickTrain(ledgerNet, weeks, Math.max(1, Math.round(A.snnPbtDays / 7)), latestDay, reuse);
        if (pick.length) { gen = ledger.begin(ledgerNet, 'tournament', pick, reuse && pick.some((b) => ledger.use(ledgerNet, b.id).trained > 0) ? 're-run on the least-used weeks' : undefined); ledger.save(); }
      }
      const layout = src === rec ? 'latest' : 'ledger';
      const pbtDue = o.forceSnnPbt || ds.pbtStage !== stage || !ds.pbtHyper || ds.pbtComplete === false || (ds.pbtLayout ?? 'latest') !== layout || gen !== undefined || (A.snnPbtEveryDays > 0 && now - (ds.pbtAt ?? 0) >= A.snnPbtEveryDays * 86_400_000);
      const pbtDays = src === rec ? lastSrc(A.snnPbtDays) : gen ? daysOf(weeks, gen.blocks) : [];
      const noFresh = src !== rec && !gen ? `every training week has been used by this network (${weeks.length} weeks): no fresh history until new weeks complete` : undefined;
      const pbt = await run(`snn-${domain}-pbt`, async () => {
        let r;
        try {
          const transitions = pbtDays.length ? regimeTransitions(T.historyDir, SNN_COINS.filter((a) => storedAssets(T.historyDir).includes(a)), Date.parse(`${pbtDays[0]}T00:00:00Z`), Date.parse(`${pbtDays[pbtDays.length - 1]}T00:00:00Z`) + 86_400_000, log) : [];
          r = await runSnnPbt({ recordings: src, domain, stage, days: pbtDays, allDays: srcDays, layout, generation: gen?.id, transitions, initDays: A.snnPbtInitDays, evalDays: 1, model: domain === 'crypto' && mlpPath() ? MetaModel.load(mlpPath()!) : undefined, modelPath: domain === 'crypto' ? mlpPath() : undefined, stateDir: path.join(work, 'snnpbt', domain), maxRounds: A.snnPbtMaxRounds || undefined, restartEvery: A.snnPbtRestartEvery, fresh: ds.pbtStage !== undefined && ds.pbtStage !== stage, population: A.snnPbtPopulation, workers: workerCount(), genetic, log, stop: sessionTimeUp });
          ds.turnAt = Date.now();
        } catch (e) {
          if (/need at least/.test((e as Error).message)) throw new SkipStep((e as Error).message);
          throw e;
        }
        ds.pbtComplete = r.complete;
        ds.pbtLayout = layout;
        if (gen && r.complete) { ledger.markTrained(ledgerNet, gen.blocks); ledger.finish(ledgerNet, gen.id, `elite #${r.elite.member}`); ledger.save(); }
        const genInfo = { ...(gen ? { generation: gen.id, weeks: gen.blocks, freshWeeksLeft: ledger.summary(ledgerNet, weeks, latestDay).fresh } : {}), ...(r.ga ? { ga: r.ga } : {}) };
        if (!r.complete) return { complete: false, reason: `tournament in progress: ${r.rounds} round(s) done, ${r.remaining} to go`, elite: r.elite, ...genInfo };
        // The elite's knobs are adopted only when the tournament's selection carries out of sample (PBO < 0.2).
        if (!r.pbo.ok) { ds.pbtAt = now; return { complete: true, adopted: false, reason: `knobs kept: ${r.pbo.why}`, rounds: r.rounds, trials: r.trials, elite: r.elite, dsr: r.dsr, pbo: r.pbo, ...genInfo }; }
        ds.pbtHyper = r.elite.hyper; ds.pbtStage = stage; ds.pbtAt = now;
        return { complete: true, adopted: true, pbo: r.pbo, rounds: r.rounds, trials: r.trials, elite: r.elite, dsr: r.dsr, population: A.snnPbtPopulation, data: src === rec ? 'recordings' : `history replay, ${pbtDays.length} days from ${pbtDays[0]} to ${pbtDays[pbtDays.length - 1]}`, ...genInfo };
      }, srcGate ?? noFresh ?? (pbtDue ? undefined : `knobs chosen ${(((now - (ds.pbtAt ?? now)) / 86_400_000)).toFixed(1)} day(s) ago`)) as { complete?: boolean } | undefined;
      const hyper = ds.pbtStage === stage ? ds.pbtHyper : undefined;
      // The history walk's best network (research/historyWalk.ts), when the walk runs this stage. A walk that moved on
      // since this network last trained trains it again.
      const wDir = walkDir(A.dir, domain), walked = readWalk(wDir, domain), eliteFile = path.join(wDir, 'elite.json');
      const walkElite = walked.elite && walked.stage === stage && fs.existsSync(eliteFile) ? walked.elite : undefined;
      const trainNeeded = Boolean(verdicts) || Boolean(pbt?.complete) || !fs.existsSync(file) || ds.stage !== stage || Boolean(walkElite && ds.walkThrough !== walkElite.through);
      await run(`snn-${domain}-train`, async () => {
        const span = lastSrc(A.snnTrainDays);
        const nEval = span.length >= 2 ? Math.max(1, Math.round(span.length * 0.2)) : 0;
        const trainSpan = span.slice(0, span.length - nEval), evalSpan = span.slice(span.length - nEval);
        const cand = path.join(work, `snn_${domain}.candidate.json`);
        // Started from the walk's network, with its knobs, only when the walk never saw the unseen days the training is
        // judged on (it stays a week behind), and not right after it fell short of the network in use: that training
        // starts from nothing, as before the walk, so the network in use never grows old.
        const fromWalk = walkElite && !ds.walkFellShort && (!evalSpan.length || walkElite.through <= evalSpan[0]) ? walkElite : undefined;
        const r = await trainSnnApart({
          recordings: src, stage, domain, out: cand, model: domain === 'crypto' ? mlpPath() : undefined, hyper: fromWalk ? JSON.stringify(fromWalk.hyper) : hyper ? JSON.stringify(hyper) : undefined, 'skip-model': src === rec ? undefined : 'true',
          from: trainSpan[0], to: evalSpan[0] ?? undefined,
          'eval-from': evalSpan[0], 'eval-to': evalSpan.length ? nextDay(evalSpan[evalSpan.length - 1]) : undefined,
          init: fromWalk ? eliteFile : undefined, incumbent: fromWalk && src === rec ? file : undefined,
        });
        if (walkElite) ds.walkThrough = walkElite.through;
        ds.walkFellShort = undefined;
        if (src !== rec) { ledger.markTrained(ledgerNet, weekBlocks(span).map((b) => b.id)); ledger.save(); }
        if (A.promote === 'validated' && !stageAccepted) return { promoted: false, stage, reason: 'stage not accepted by the ablation', result: r };
        // On the recordings (no contest) a network started from the walk's replaces the network in use only by doing at
        // least as well on the newest days, unseen by both.
        if (fromWalk && r.incumbent?.n && r.eval && r.eval.snn > r.incumbent.snn) {
          ds.walkFellShort = true;
          return { promoted: false, stage, reason: `started from the history walk's network (walked to ${fromWalk.through}): Brier ${r.eval.snn.toFixed(4)} on the ${evalSpan.length} newest day(s), the network in use ${r.incumbent.snn.toFixed(4)}; the next training starts from nothing`, result: r };
        }
        // Contest (history replay): the new network replaces the one in use only if it beats it on held-out
        // weeks neither has trained on (the least-judged ones), replayed as live. Its own training days are
        // the latest ones, younger than any held-out week unless AUTO_TRAIN_SNN_TRAIN_DAYS reaches past half a
        // year; a held-out week inside them is then left out of the contest.
        let contest: ContestResult | undefined;
        if (src !== rec && A.champion && fs.existsSync(file)) {
          const unseen = weeks.filter((b) => b.days[b.days.length - 1] < span[0] || b.days[0] > span[span.length - 1]);
          const cw = ledger.pickContest(ledgerNet, unseen, A.contestWeeks, latestDay);
          if (cw.length) {
            contest = await snnContest({ recordings: replayDir, domain, candidate: JSON.parse(fs.readFileSync(cand, 'utf8')), incumbent: JSON.parse(fs.readFileSync(file, 'utf8')), days: cw.flatMap((b) => b.days), allDays: srcDays, workers: workerCount(), log, tapeDir: path.join(work, 'snn-tape', domain) });
            const g = ledger.begin(ledgerNet, 'contest', cw, contest.winner);
            ledger.markJudged(ledgerNet, g.blocks); ledger.finish(ledgerNet, g.id); ledger.save();
            if (contest.winner !== 'candidate') return { promoted: false, stage, reason: `contest: challenger ${contest.reason}`, contest, result: r };
          }
        }
        const first = !fs.existsSync(file);
        fs.copyFileSync(cand, file);
        if (state.snnVersions![domain] !== r?.version) snnChanged.push(domain);
        ds.stage = stage;
        ds.version = r?.version;
        state.snnVersions![domain] = r?.version;
        return { promoted: true, improved: first || contest?.winner === 'candidate', stage, stageAccepted, contest, result: r, ...(fromWalk ? { fromWalk: fromWalk.through } : {}) };
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
    await tennisNetwork();
  }
  // Every later step reads the logged + backfilled outputs (each consumer picks its own network's).
  process.env.SNN_BACKFILL_DIR = REPLAYABLE.map(fillDir).join(path.delimiter);
  process.env.SNN_CROSS_FEED = String(cfg.snn.crossFeed);

  // ---- 2. tree volatility forecast (fair value's sigma multiplier) ----
  if (want('vol_model')) {
    await run('vol_model', ifChanged('vol_model', async () => {
      // Counted from the file names first: reading two days of recordings only to find too few took 13-40 minutes.
      const recDays = recordingDays(decisionRec).length;
      if (recDays < VOL_MODEL_MIN_DAYS) throw new SkipStep(`not enough index history yet (needs ${VOL_MODEL_MIN_DAYS} days of recordings, have ${recDays})`);
      const cand = path.join(work, 'vol_model.candidate.json');
      let p;
      try { p = await trainVolModelMain(argsOf({ recordings: decisionRec, out: cand })); } catch (e) {
        if (/need at least/.test((e as Error).message)) throw new SkipStep(`not enough index history yet (${(e as Error).message})`);
        throw e;
      }
      if (A.promote === 'validated' && !p.validation.validated) return { promoted: false, validation: p.validation };
      const champ = promoteIfChampion({ dir: A.dir, kind: 'vol_model', candidate: cand, live: promoted('vol_model'), enabled: A.champion });
      return { promoted: champ.promote, improved: champ.promote && champ.improved, champion: champ.reason, validation: p.validation };
    }), tooFew);
  }

  // ---- 4-5. dataset -> MLP (fair value + take/skip head) -> backtest -> promote ----
  const dataset = path.join(work, 'dataset.jsonl');
  // Price the dataset and the backtest exactly as production will: with the vol forecast (when on)
  // and the fill model (each is applied only if validated).
  const volModelArg = cfg.strategy.volModel && fs.existsSync(promoted('vol_model')) ? promoted('vol_model') : undefined;
  const fillModelArg = fs.existsSync(promoted('fill')) ? promoted('fill') : undefined;
  if (want('dataset') || want('mlp')) await run('dataset', ifChanged('dataset', () => buildDatasetMain(argsOf({ recordings: decisionRec, out: dataset, every: 60, 'vol-model': volModelArg }))), tooFew);
  if (want('mlp')) {
    const cand = path.join(work, 'model.candidate.json');
    await run('mlp', ifChanged('mlp', async () => {
      if (!fs.existsSync(dataset) || fs.statSync(dataset).size === 0) throw new SkipStep('empty dataset: no priced contracts with outcomes in the recordings yet');
      try { await trainMetaModelMain(argsOf({ data: dataset, out: cand })); } catch (e) {
        if (/need at least \d+ windows/.test((e as Error).message)) throw new SkipStep(`not enough settlement windows yet: ${(e as Error).message}`);
        throw e;
      }
      // One replay with the exit settings production trades with. The backtest's own grid for confluence_ratchet
      // (3 hunt margins x 2 wall fill ratios) replayed the recordings six times for the same annotation: most of the
      // step, which ran out of the quick phase's time on Oct 22 and Oct 23.
      await backtestMain(argsOf({
        recordings: decisionRec, model: cand, exits: cfg.strategy.exitPolicy, 'vol-model': volModelArg, 'fill-model': fillModelArg,
        'hunt-grid': cfg.strategy.huntTargetMargin, 'hunt-confluence': cfg.strategy.huntMinConfluence,
        'ratchet-fill-grid': cfg.strategy.ratchetMinFillRatio, 'ratchet-age': cfg.strategy.ratchetMinWallAgeSec, 'ratchet-slip': cfg.strategy.ratchetSlippageTicks,
      }), true);
      const m = MetaModel.load(cand);
      const passed = Boolean(m.params.validation?.passed);
      const usesSnn = m.params.features.some((f) => f.startsWith('snn_'));
      if (A.promote === 'validated' && !passed) return { promoted: false, id: m.id, reason: `validation not passed (${m.liveBlockers().join('; ')})` };
      const champ = promoteIfChampion({ dir: A.dir, kind: 'mlp', candidate: cand, live: promoted('mlp'), enabled: A.champion });
      if (!champ.promote) return { promoted: false, id: m.id, reason: champ.reason };
      state.mlpId = m.id;
      state.trainedWithSnn!.crypto = state.snnVersions!.crypto;
      state.trainedWithTaNet = state.taNetVersion;
      return { promoted: true, improved: champ.improved, champion: champ.reason, id: m.id, kind: m.params.kind, usesSnnFeatures: usesSnn, take: m.params.take?.validation ?? null, validationPassed: passed, liveBlockers: m.liveBlockers() };
    }), tooFew);
  }

  // ---- 6. intraday volatility profile: the replay's last 180 days of 1-minute history when it exists ----
  if (want('vol')) {
    const recent = T.historyReplay ? replayDays().slice(-180) : [];
    await run('vol', ifChanged('vol', async () => {
      const out = path.join(work, 'vol_profile.json');
      let src = rec;
      if (recent.length >= 30) {
        src = path.join(work, 'vol-replay');
        fs.rmSync(src, { recursive: true, force: true });
        linkDays(recent.map((d) => ({ day: d, file: path.join(replayDir, `md-${d}.jsonl.gz`) })), src);
      }
      await sessionsMain(argsOf({ recordings: src, out, 'no-backtest': 1 }));
      fs.copyFileSync(out, promoted('vol'));
      return { promoted: true, improved: JSON.parse(fs.readFileSync(out, 'utf8')).validation?.improved ?? false, data: src === rec ? 'recordings' : `history replay (${recent.length} days)` };
    }), recent.length >= 30 ? undefined : tooFew);
  }

  // ---- 7. perps (SNN 1h/4h direction among the features) ----
  if (want('perps')) {
    // Every day of replayed perpetual history when the replay exists (HISTORY_REPLAY: from Binance's first
    // perpetual, September 2019); else the bot's recordings. Each day's rows are cached, so a run only
    // computes the new days (all cores at once on the first run).
    const perpSrc = T.historyReplay && replayDays().length >= 30 ? replayDir : rec;
    await run('perps', ifChanged('perps', async () => {
      const cand = path.join(work, 'perp_model.candidate.json');
      const cache = path.join(work, perpSrc === rec ? 'perp-dataset-rec' : 'perp-dataset');
      // On the replay the history ledger's held-out weeks are left out of training: the contest and the
      // execution backtest run there, on weeks the model has never seen.
      const perpDays = perpSrc === replayDir ? replayPerpDays(replayDir) : [];
      const held = perpDays.length ? weekBlocks(perpDays).filter((b) => isHoldout(b, replayDays().slice(-1)[0])) : [];
      // On the recordings the newest week is held out of training for the execution backtest (the bot keeps 20 days:
      // 13 to train on, 7 to test on). With fewer than 12 days there are too few to do both (the backtest passes from
      // PERP_RECORDED_MIN_DAYS days of quotes), and the model trains on them all.
      const testN = Math.min(PERP_RECORDED_TEST_DAYS, Math.floor(days.length / 2));
      const recTest = perpSrc === rec && testN > PERP_RECORDED_MIN_DAYS ? days.slice(-testN) : [];
      try { await trainPerpMain(argsOf({ recordings: perpSrc, out: cand, every: perpSrc === rec ? undefined : 900, cache, workers: workerCount(), holdout: held.length ? 'ledger' : undefined, 'holdout-from': recTest[0] })); } catch (e) {
        if (/record more perp data|no perp/i.test((e as Error).message)) throw new SkipStep('no perp quotes recorded yet (PERPS_FEED=true records them)');
        throw e;
      }
      if (!fs.existsSync(cand)) throw new SkipStep('perp trainer wrote no model');
      // The execution backtest, on days the candidate never trained on: the held-out weeks on the replay (it passes from
      // PERP_BACKTEST_MIN_DAYS days), the held-out newest week on the recordings (from PERP_RECORDED_MIN_DAYS), after
      // the recorded day before it to warm the trackers up.
      let btSrc: string | undefined = perpSrc, btFrom: string | undefined;
      if (held.length) {
        btSrc = path.join(work, 'perp-backtest-days');
        fs.rmSync(btSrc, { recursive: true, force: true });
        linkDays(held.flatMap((b) => b.days).map((d) => ({ day: d, file: path.join(replayDir, `md-${d}.jsonl.gz`) })), btSrc);
      } else if (perpSrc === rec) {
        btSrc = undefined;
        if (recTest.length) {
          btSrc = path.join(work, 'perp-backtest-days');
          fs.rmSync(btSrc, { recursive: true, force: true });
          linkDays(recordingFiles(rec).filter((f) => f.day >= days[days.length - recTest.length - 1]), btSrc);
          btFrom = recTest[0];
        }
      }
      const left = btSrc ? undefined : `left out: ${days.length} recorded day(s), it needs ${2 * (PERP_RECORDED_MIN_DAYS + 1)} (the newest ${PERP_RECORDED_MIN_DAYS + 1} held out of training to test on)`;
      if (btSrc) await perpBacktestMain(argsOf({ recordings: btSrc, model: cand, from: btFrom, 'min-days': btFrom ? PERP_RECORDED_MIN_DAYS : undefined }), true);
      else log(`perps: execution backtest ${left}`);
      const m = PerpModel.load(cand);
      const ok = Boolean(m?.validated());
      const bt = m?.params.validation?.backtest;
      const backtest = left ?? (bt ? { ok: bt.ok, days: +bt.days.toFixed(1), pnlUsd: +bt.pnlUsd.toFixed(2), trades: bt.trades, ...(btFrom ? { from: btFrom } : {}) } : undefined);
      if (A.promote === 'validated' && !ok) return { promoted: false, reason: m?.blockers().join('; '), backtest };
      // Contest: the live rule's net P&L per trade on the held-out weeks, challenger vs the model in use --
      // only when the model in use was also trained without them (else the contest would favour it).
      const live = PerpModel.load(promoted('perp'));
      let contest: { candidate: ReturnType<typeof perpRuleRecord>; incumbent: ReturnType<typeof perpRuleRecord>; weeks: number } | undefined;
      if (m && live && held.length && live.params.holdout === HOLDOUT_RULE) {
        const heldDays = new Set(held.flatMap((b) => b.days));
        const rows = (await buildPerpDataset(perpSrc, { everySec: 900, horizonMin: cfg.perps.horizonMin, cacheDir: cache, workers: workerCount() })).filter((r) => heldDays.has(new Date(r.ts).toISOString().slice(0, 10)));
        const ro = { horizonMin: cfg.perps.horizonMin, makerBps: cfg.perps.makerFeeBps, entryEdgeBps: cfg.perps.entryEdgeBps };
        contest = { candidate: perpRuleRecord(m, rows, ro), incumbent: perpRuleRecord(live, rows, ro), weeks: held.length };
        const g = ledger.begin('perp-model', 'contest', held, `${contest.candidate.meanBps.toFixed(2)} vs ${contest.incumbent.meanBps.toFixed(2)} bps/trade`);
        ledger.markJudged('perp-model', g.blocks); ledger.finish('perp-model', g.id);
      }
      if (held.length) { const ids = new Set(held.map((b) => b.id)); ledger.markTrained('perp-model', weekBlocks(perpDays).filter((b) => !ids.has(b.id)).map((b) => b.id)); ledger.save(); }
      const scored = contest && contest.candidate.trades >= 20 && contest.incumbent.trades >= 20;
      const champ = promoteIfChampion({ dir: A.dir, kind: 'perp', candidate: cand, live: promoted('perp'), enabled: A.champion, candidateScore: scored ? -contest!.candidate.meanBps : undefined, incumbentScore: scored ? -contest!.incumbent.meanBps : undefined });
      if (!champ.promote) return { promoted: false, reason: champ.reason, contest, backtest };
      state.trainedWithSnn!.perps = state.snnVersions!.perps;
      return { promoted: true, improved: champ.improved, champion: champ.reason, validated: ok, blockers: m?.blockers() ?? [], backtest, contest, data: perpSrc === rec ? `recordings (${days.length} days${recTest.length ? `, the newest ${recTest.length} held out for the backtest` : ''})` : `history replay (${replayDays().length} days, ${held.length} held-out weeks)` };
    }), perpSrc === rec ? tooFew : undefined);
  }

  // ---- 8. tennis MLP: Kalshi's tennis history (replay) + the bot's own recorded matches (the holdout) ----
  const tennisHistory = T.historyReplay && replayTennisDays(replayDir).length > 0;
  if (want('tennis')) {
    await run('tennis', ifChanged('tennis', async () => {
      const cand = path.join(work, 'tennis_model.candidate.json');
      let p;
      try { p = await trainTennisMain(argsOf({ recordings: rec, history: tennisHistory ? replayDir : undefined, out: cand })); } catch (e) {
        if (/need at least \d+ matches/.test((e as Error).message)) throw new SkipStep(`not enough settled tennis matches recorded yet (${(e as Error).message})`);
        throw e;
      }
      if (A.promote === 'validated' && !p.validation.validated) return { promoted: false, validation: p.validation };
      const champ = promoteIfChampion({ dir: A.dir, kind: 'tennis', candidate: cand, live: promoted('tennis'), enabled: A.champion });
      if (!champ.promote) return { promoted: false, reason: champ.reason, validation: p.validation };
      state.trainedWithSnn!.tennis = state.snnVersions!.tennis;
      return { promoted: true, improved: champ.improved, champion: champ.reason, validation: p.validation, data: tennisHistory ? 'Kalshi tennis history + recordings' : 'recordings' };
    }), tennisHistory ? undefined : tooFew);
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

  // ---- 9b. strategy playbook: which strategy family carries the risk in which coin regime, learned from whole-bot
  // replay days and switched on only if it beat the static bot on later days (research/playbook.ts) ----
  if (want('playbook')) {
    await run('playbook', ifChanged('playbook', async () => {
      const kDays = T.historyReplay ? replayKalshiDays(replayDir) : [];
      if (kDays.length < 30) throw new SkipStep(`${kDays.length} history replay day(s) with Kalshi's real contracts, need 30`);
      const fit = mlpPath() ? (MetaModel.load(mlpPath()!).params.training as { firstWindow?: string; holdoutStart?: string } | undefined) : undefined;
      const fitted = (d: string) => Boolean(fit?.firstWindow && fit.holdoutStart && d >= fit.firstWindow.slice(0, 10) && d < fit.holdoutStart.slice(0, 10));
      // Not the readiness step's held-out newest 15%, not the MLP's fitting span; the newest 240 of the rest.
      const pool = kDays.slice(0, Math.floor(kDays.length * 0.85)).filter((d) => !fitted(d)).slice(-240);
      if (pool.length < 30) throw new SkipStep(`${pool.length} replay day(s) outside the MLP's fitting span and the readiness days, need 30`);
      const { dayRegimes, coinDays, buildPlaybook } = await import('./playbook');
      const src = path.join(work, 'playbook-days');
      fs.rmSync(src, { recursive: true, force: true });
      linkDays(pool.map((d) => ({ day: d, file: path.join(replayDir, `md-${d}.jsonl.gz`) })), src);
      const D = await loadWholeBot({ recordings: src, history: T.historyDir, setupOos: path.join(A.dir, 'setup_oos.json'), modelPath: mlpPath(), split: { all: [0, 1] }, log });
      try {
        let book;
        try { book = SetupModel.load(fs.existsSync(promoted('setups')) ? promoted('setups') : cfg.perps.setupModelPath)?.params.book; } catch { book = undefined; }
        const r = await runWholeBot(D, 'all', { ...settingsFromConfig(cfg, book), totalUsd: A.targetPoolUsd });
        const assets = [...new Set([...T.historyReplayAssets, ...Object.values(r.byAsset).flatMap((x) => Object.keys(x))])].filter((a) => a !== 'OTHER');
        const samples = coinDays(r.byAsset, dayRegimes(T.historyDir, pool, assets));
        const pb = buildPlaybook(samples, { version: new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15), at: new Date(now).toISOString() });
        const file = path.join(A.dir, 'playbook.json');
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(pb, null, 1));
        fs.renameSync(`${file}.tmp`, file);
        log(`playbook ${pb.enabled ? 'ON' : 'off'}: ${pb.validation?.why}`);
        // The Compensator (research/compensator.ts): per strategy, a ramp on the Librarian's day-start reading, on the
        // same coin-days; switched on only if it beats both the static bot and the step playbook on later days.
        let comp: Record<string, unknown> | string = 'COMPENSATOR=false';
        if (process.env.COMPENSATOR !== 'false') {
          const { compSamples, buildCompensator } = await import('./compensator');
          const { LibIndex, loadLibForecasts } = await import('./librarian');
          const cf = buildCompensator(compSamples(samples, r.bySetup, new LibIndex(loadLibForecasts(T.historyDir))), samples, { version: pb.version, at: pb.at });
          const cfile = path.join(A.dir, 'compensator.json');
          fs.writeFileSync(`${cfile}.tmp`, JSON.stringify(cf, null, 1));
          fs.renameSync(`${cfile}.tmp`, cfile);
          log(`compensator ${cf.enabled ? 'ON' : 'off'}: ${cf.validation?.why}`);
          comp = { enabled: cf.enabled, validation: cf.validation, ramps: Object.fromEntries(Object.entries(cf.ramps).map(([k, e]) => [k, e.why])) };
        }
        return { enabled: pb.enabled, days: pool.length, coinDays: samples.length, regimes: Object.keys(pb.entries).length, validation: pb.validation, entries: Object.fromEntries(Object.entries(pb.entries).map(([k, e]) => [k, `kalshi x${e.kalshi}, perps x${e.perps} (${e.days} coin-days)`])), compensator: comp };
      } finally {
        for (const d of Object.values(D.dirs)) fs.rmSync(d, { recursive: true, force: true });
        fs.rmSync(src, { recursive: true, force: true });
      }
    }));
  }

  // ---- 10. readiness: the whole bot on days nothing was fitted or tuned on, against the target the continuous
  // trainer stops at; every model's state; each network's weeks in the history ledger (research/readiness.ts) ----
  if (want('readiness')) {
    await run('readiness', async () => {
      const kinds: Array<[keyof typeof MODEL_FILES, string]> = [['ta_net', 'ta_net'], ['setups', 'setups'], ['mlp', 'mlp'], ['perp', 'perp'], ['vol_model', 'vol_model'], ['tennis', 'tennis'], ['snn_crypto', 'snn'], ['snn_perps', 'snn'], ['snn_tennis', 'snn']];
      const components = componentStatus(A.dir, { ...Object.fromEntries(kinds.map(([k, kind]) => [k, { kind, file: promoted(k) }])), gp: { kind: 'gp', file: path.join(A.dir, 'gp_indicators.json') } });
      const rDays = T.historyReplay ? replayDays() : [], pDays = T.historyReplay ? replayPerpDays(replayDir) : [];
      const ledgerInfo = ledgerStatus(ledger, { 'snn-crypto': weekBlocks(rDays), 'snn-perps': weekBlocks(pDays), 'perp-model': weekBlocks(pDays), 'snn-tennis': weekBlocks(T.historyReplay ? replayTennisDays(replayDir) : [], 1) }, rDays[rDays.length - 1] ?? days[days.length - 1] ?? '1970-01-01');
      // The days: the replay's days that hold Kalshi's real contracts (the sweep's), their newest 15% (the sweep's final
      // window: never tuned on), without the days the MLP was fitted on (its development span; its own holdout stays
      // in), at most the newest 90, and 30 of them to pass. Without that replay, the recordings: the bot keeps 20 days
      // (RECORDINGS_KEEP_DAYS) and the MLP is fitted on the newest, so their newest 15% leaves a day or two; the whole
      // bot is judged on the newest READINESS_RECORDED_DAYS complete days the MLP was not fitted on (a part of today is
      // not a day), and passes on 5.
      const kDays = T.historyReplay ? replayKalshiDays(replayDir) : [];
      const useReplay = kDays.length >= 20 && kDays.length > days.length;
      const minDays = useReplay ? SOLID.minDays : READINESS_RECORDED_DAYS;
      const target: ReadinessTarget = { poolUsd: A.targetPoolUsd, dailyPct: A.targetDailyPct, maxDdPct: A.targetMaxDdPct, minDays };
      const fit = mlpPath() ? (MetaModel.load(mlpPath()!).params.training as { firstWindow?: string; holdoutStart?: string } | undefined) : undefined;
      const fitted = (d: string) => Boolean(fit?.firstWindow && fit.holdoutStart && d >= fit.firstWindow.slice(0, 10) && d < fit.holdoutStart.slice(0, 10));
      const held = useReplay
        ? kDays.slice(Math.floor(kDays.length * 0.85)).filter((d) => !fitted(d)).slice(-90)
        : completeDays.filter((d) => !fitted(d)).slice(-Math.max(READINESS_RECORDED_DAYS, days.length - Math.floor(days.length * 0.85)));
      let wholeBot: ReadinessFile['wholeBot'];
      let note: string | undefined;
      // The whole-bot replay is reused while nothing it reads changed (the models' and ledger's status is refreshed).
      const wbSig = crypto.createHash('sha1').update(`${inputsNow('readiness')}|${held.join(',')}|${target.poolUsd}`).digest('hex');
      const reuse = A.skipUnchanged && state.readinessWholeBot?.sig === wbSig ? state.readinessWholeBot : undefined;
      if (reuse) {
        wholeBot = reuse.wholeBot; note = reuse.note;
        log(`readiness: the whole-bot replay from ${new Date(reuse.at).toISOString().slice(0, 16).replace('T', ' ')} UTC reused (nothing it reads changed)`);
      } else if (held.length) {
        const src = path.join(work, 'readiness-days');
        fs.rmSync(src, { recursive: true, force: true });
        const set = new Set(held);
        linkDays(useReplay ? held.map((d) => ({ day: d, file: path.join(replayDir, `md-${d}.jsonl.gz`) })) : recordingFiles(rec).filter((f) => set.has(f.day)), src);
        const D = await loadWholeBot({ recordings: src, history: T.historyDir, setupOos: path.join(A.dir, 'setup_oos.json'), modelPath: mlpPath(), split: { held: [0, 1] }, log });
        try {
          let book;
          try { book = SetupModel.load(fs.existsSync(promoted('setups')) ? promoted('setups') : cfg.perps.setupModelPath)?.params.book; } catch { book = undefined; }
          const r = await runWholeBot(D, 'held', { ...settingsFromConfig(cfg, book), totalUsd: target.poolUsd });
          const st = dailyStats(r.days.map((x) => x.total), target.poolUsd, r.days.map((x) => x.day));
          const sw = solidWholeBot(st, minDays);
          wholeBot = { ...st, window: `${useReplay ? 'history replay (real Kalshi contracts)' : 'recordings'}: ${held.length} day(s) ${held[0]}..${held[held.length - 1]}`, kalshiUsd: r.kalshiUsd, perpsUsd: r.perpsUsd, solid: sw.solid, solidWhy: sw.why };
        } finally {
          for (const d of Object.values(D.dirs)) fs.rmSync(d, { recursive: true, force: true });
          fs.rmSync(src, { recursive: true, force: true });
        }
      } else note = 'no day the bot was neither fitted nor tuned on yet';
      if (!reuse) state.readinessWholeBot = { sig: wbSig, at: Date.now(), wholeBot, note };
      const t = wholeBot ? targetMet(wholeBot, target) : { met: false, why: [note ?? 'no whole-bot result'] };
      writeReadiness(A.dir, { at: new Date(now).toISOString(), target, wholeBot, met: t.met, why: t.why, components, ledger: ledgerInfo, note });
      const f2 = (x: number) => (Number.isFinite(x) ? +x.toFixed(3) : null);
      return { met: t.met, why: t.why, solid: wholeBot?.solid ?? false, wholeBot: wholeBot ? { window: wholeBot.window, meanPct: f2(wholeBot.meanPct), ciLoPct: f2(wholeBot.ciLoPct), maxDdPct: f2(wholeBot.maxDdPct), sharpe: f2(wholeBot.sharpe), perDayUsd: f2(wholeBot.perDayUsd) } : null, ledger: ledgerInfo };
    });
  }

  // ---- 11. conditioning (only on request): the freshly trained bot's settings pressure-tested on unseen days of the
  // history replay, tier by tier (research/conditioning.ts, research/conditioningRun.ts) ----
  if (want('conditioning')) {
    await run('conditioning', async () => {
      if (!T.historyReplay || !replayDays().length) throw new SkipStep('no history replay to condition on (HISTORY_REPLAY=false or not built yet: run the normal training first)');
      const { conditioningStep } = await import('./conditioningRun');
      let book;
      try { book = SetupModel.load(fs.existsSync(promoted('setups')) ? promoted('setups') : cfg.perps.setupModelPath)?.params.book; } catch { book = undefined; }
      const fit = mlpPath() ? (MetaModel.load(mlpPath()!).params.training as { firstWindow?: string; holdoutStart?: string } | undefined) : undefined;
      const env = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && process.env[k] !== '' && process.env[k] !== undefined ? v : d; };
      return conditioningStep({
        replayDir, historyDir: T.historyDir, modelsDir: A.dir, setupOos: path.join(A.dir, 'setup_oos.json'), modelPath: mlpPath(),
        live: settingsFromConfig(cfg, book), ledger,
        fitted: (d) => Boolean(fit?.firstWindow && fit.holdoutStart && d >= fit.firstWindow.slice(0, 10) && d < fit.holdoutStart.slice(0, 10)),
        instances: Math.max(2, Math.round(env('COND_INSTANCES', 24))), workers: workerCount(),
        rules: { targetUsd: env('COND_TARGET_USD', 100), cullFrac: env('COND_CULL_FRAC', 0.35), minTierC: Math.round(env('COND_MIN_TIER_C', 4)), retrials: Math.round(env('COND_RETRIALS', 3)) },
        log: (m) => log(`conditioning: ${m}`), now,
      });
    });
  }

  // A conditioning-only run is not a normal training run (the trainer greys conditioning out until there is a fresh one).
  const conditioningOnly = o.only?.length === 1 && o.only[0] === 'conditioning';
  // A run stopped part-way is not a fresh training run either (its remaining steps never ran).
  if (!conditioningOnly && !stopRequested) state.lastRun = now;
  writeAtomic(report, JSON.stringify({ at: new Date(now).toISOString(), complete: !stopRequested, recordings: rec, days: days.length, readiness: state.readiness, promote: A.promote, snnChanged, steps }, null, 1));
  state.lastReport = report;
  writeAtomic(path.join(A.dir, 'pipeline_state.json'), JSON.stringify(state, null, 1));
  log(`report: ${report}`);
  process.removeListener('SIGINT', onStop);
  process.removeListener('SIGTERM', onStop);
  return { steps, state, report };
}

async function main() {
  const i = process.argv.indexOf('--only');
  const only = i >= 0 ? (process.argv[i + 1] ?? '').split(',').filter(Boolean) as Step[] : undefined;
  const j = process.argv.indexOf('--skip');
  const skip = j >= 0 ? (process.argv[j + 1] ?? '').split(',').filter(Boolean) as Step[] : undefined;
  for (const s of [...(only ?? []), ...(skip ?? [])]) if (!STEPS.includes(s)) throw new Error(`unknown step ${s} (steps: ${STEPS.join(', ')})`);
  const r = await runPipeline({ only, skip, forceAblation: process.argv.includes('--force-ablation'), forceTaNet: process.argv.includes('--force-ta-net') || process.argv.includes('--fresh-ta-net'), forceTaNetFresh: process.argv.includes('--fresh-ta-net'), forceSnnPbt: process.argv.includes('--force-snn-pbt'), forceAll: process.argv.includes('--sweep-all') });
  const failed = r.steps.filter((s) => !s.ok);
  console.log(`[pipeline] ${r.steps.length - failed.length}/${r.steps.length} steps ok${failed.length ? `; failed: ${failed.map((f) => f.step).join(', ')}` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && /pipeline\.(ts|cjs|js)$/.test(process.argv[1])) void main();

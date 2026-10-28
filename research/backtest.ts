// Fee-inclusive backtest on recorded data using the production strategy,
// risk gateway and the conservative queue-aware fill simulator.
//   npm run research:backtest -- --recordings data/recordings --model params/model.candidate.json \
//       [--grid 0.01,0.02,0.03] [--exits hold,fair_value,liquidity_ratchet,hybrid,confluence_ratchet] \
//       [--ratchet-fill 1] [--ratchet-age 3] [--ratchet-slip 1] [--hunt-margin 0.02] [--hunt-confluence 2] \
//       [--trials 6] [--annotate]
//
// Exit policies (bot/strategy/exitPolicies.ts) are compared on identical data.
// The exit policy governs every ACTIVE reduction: under hold / liquidity_ratchet,
// taker entries against an existing position are blocked (they are exits in
// disguise). Passive maker quotes unwind at favourable prices under every policy.
// Every exit executes one tick (1 s) after it triggers, against the book at
// that moment, so no policy gets instantaneous reaction for free. As the
// engine's loop: markets are evaluated in its selection order (altcoin risk-on,
// then TA conviction, from each market's last evaluation) and one with no
// position, no resting order and nothing in flight only every EVAL_IDLE_SEC.
// Exit
// diagnostics: exit regret (what exited contracts would have paid at
// settlement minus what the exit actually received; positive = the exit cost
// money), stopped-out winners, ratchet slippage vs the stop, and gap-throughs.
//
// Reports per-WINDOW results (correlated markets closing together count once),
// a bootstrap CI on net edge per contract, the Deflated Sharpe given every
// variant tried, and PBO across the --grid of minEdge values. With --annotate
// the model file's validation block gets netEdgeCiLow / deflatedSharpe.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, paperEnv, type Config, type StrategyConfig, type RiskLimits } from '../bot/config';
import { PROBATION_BOOKS, Probation, setProbation } from '../bot/risk/probation';
import { DEFAULT_FEES } from '../bot/fees';
import { assetFeatureMap, computeFeatureMap } from '../bot/model/featureEngine';
import { VolForecaster, VolModel } from '../bot/model/volModel';
import { applyFillModel, FillModel } from '../bot/tca/fillModel';
import { applyTakeGate, TAKE_GATED_DRIVERS, TAKE_GATED_MICRO, TAKE_GATED_TREND } from '../bot/model/takeModel';
import { dropTape, openTape, TapeMiss, tickerHash, type TapeReader, type TapeWriter } from './callTape';
import { effectiveSigma, loadVolProfile, type VolProfile } from '../bot/model/volSeasonality';
import { sessionRiskFor, huntBlockedBySession, type SessionRiskProfile } from '../bot/model/sessionRisk';
import { sessionState } from '../bot/model/sessions';
import { Vault, type VaultConfig } from '../bot/vault/vault';
import { ladderQuotes } from '../bot/model/ladder';
import { priceContract, SETTLEMENT_AVG_SEC } from '../bot/model/fairValue';
import { kalshiMaintenance } from '../bot/model/sessions';
import { defaultTiers, tierAt, type TierPoint } from '../bot/risk/sizingTiers';
import { CadenceGate, inEntryWindow } from '../bot/strategy/cadence';
import type { MacroEvent } from '../bot/model/featureEngine';
import { loadCalendar } from '../bot/model/calendar';
import { MetaModel } from '../bot/model/metaModel';
import type { OrderIntent } from '../bot/oms/oms';
import { PositionBook } from '../bot/oms/positions';
import { PaperExchange } from '../bot/paper/paperExchange';
import { marketWorstLoss } from '../bot/risk/exposure';
import { EquityGuard } from '../bot/risk/equityGuard';
import { RiskGateway } from '../bot/risk/riskGateway';
import { decide, decisionProbability, type MarketView } from '../bot/strategy/fairValueStrategy';
import { ComponentTrials, type TrialName } from '../bot/strategy/componentTrials';
import { activeRuleBook, RuleBook, setRuleBook } from '../bot/strategy/ruleBook';
import { altcoinRiskOn, confluenceBreadth, orientedSignals, selectionPriority, taDrift, taNetDirection } from '../bot/strategy/taConviction';
import { activeGpSignals, GpSignals, setGpSignals } from '../bot/gp/gpSignals';
import { MarketContext, marketContext, setMarketContext } from '../bot/ta/marketContext';
import { setTaNet, sigma24, TaNet } from '../bot/ta/taNet';
import type { TaSnapshot } from '../bot/ta/analyzer';
import { setTaNetEnsemble, TaNetEnsemble, taNetView } from '../bot/ta/taNetEnsemble';
import { ProfitPeaks } from '../bot/strategy/profitPeaks';
import { ConfluenceRatchetExit, DEFAULT_HUNT, DEFAULT_RATCHET, EXIT_POLICIES, ExitPolicyName, HuntParams, LiquidityRatchet, RatchetParams } from '../bot/strategy/exitPolicies';
import { readRecordings, ReplayState } from './replay';
import { AccuracyGate, type AccuracyGateConfig } from '../bot/strategy/accuracyGate';
import { TakeProfitBench } from '../bot/strategy/takeProfitBench';
import { gatePasses, type ProbationParams } from '../bot/risk/probation';
import { bootstrapMeanCi, deflatedSharpe, pbo, rng, sharpe } from './stats';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

export interface ExitStats {
  orders: number;
  fills: number;
  contracts: number;
  /** Net proceeds of exit fills (side price x count - fees). */
  proceeds: number;
  /** Settlement value of exited contracts minus exit proceeds (positive = exiting cost money). */
  regret: number;
  /** Exit fills whose side went on to settle in the money. */
  stoppedWinners: number;
  ratchetTriggers: number;
  gaps: number;
  hybridHolds: number;
  /** confluence_ratchet: times hunt mode switched on / off, and exits it made. */
  huntActivations: number;
  huntDeactivations: number;
  /** Early take-profits at the bid (confluence flipped, session unsafe, gap through the stop). */
  huntProfitTakes: number;
  /** Mean (stop - fill price) in side terms for ratchet exits; positive = filled below the stop. */
  avgSlippage: number | null;
}

export interface SessionBreakdown { windows: number; pnl: number; contracts: number; fees: number }

/** One traded contract (a market in which a position was taken), settled. */
export interface TradeResult { ticker: string; closeTs: number; pnl: number; contracts: number; kind: string }

export interface BacktestResult {
  exitPolicy: ExitPolicyName;
  /** Variant label (hunt variants carry their parameters). */
  label: string;
  huntParams?: { hunt: HuntParams; ratchet: RatchetParams };
  /** Vault and pocket at the end of the run (bookkeeping; reduces tradable bankroll). */
  vaultEnd: number;
  pocketEnd: number;
  /** P&L attributed to the session in effect when each 15-minute window opened. */
  bySession: Record<string, SessionBreakdown>;
  exits: ExitStats;
  /** Settled contracts that were traded, for EV-per-trade and trades-per-day. */
  trades: TradeResult[];
  /** Mode B take-profit fills. */
  takeProfitFills: number;
  /** Injected latency and its effects (see BacktestLatency). */
  latency?: { orderMs: number; cancelMs: number; jitterMs: number; sent: number; cancelRaceFills: number; cancelRaceContracts: number; lateKills: number };
  /** Evaluations that ran the full (entry) decision under the cadence. */
  entryEvaluations: number;
  days: number;
  minEdge: number;
  /** Per market close time: P&L, contracts and fees (and fills, counted by the run since the replay check needed them). */
  windows: Map<number, { pnl: number; contracts: number; fees: number; fills?: number }>;
  fills: number;
  contracts: number;
  fees: number;
  pnl: number;
  /** The smallest loss-aware size scale the run reached (bot/risk/equityGuard.ts; 1 = never below break-even). */
  sizeScaleMin?: number;
  /** Each refill of a pool that ran dry (BacktestOpts.refillUsd): when, and how much went in. */
  refills?: Array<{ t: number; usd: number }>;
  /** With the paper options: entries the accuracy gate held back, when the take-profit bench benched, its sales (fills
   *  and contracts). */
  paper?: { accuracyBlocks: number; takeProfitBenchedAt: number | undefined; takeProfitSales: number; takeProfitContracts?: number; takeProfitScored?: number; takeProfitNetUsd?: number;
    /** Each market the take-profit bench scored (from tradeFromMs): what its sales made against holding, contracts sold, when. */
    takeProfitByMarket?: Record<string, { usd: number; contracts: number; t: number }>;
    rejected?: Record<string, number>; trainTrades?: number; exploreEntries?: number; extraSent?: number; extraRejected?: Record<string, number> };
  /** Fills and contracts by order purpose (quote, entry, exit), and contracts filled by UTC hour (YYYY-MM-DDTHH). */
  byPurpose?: Record<string, { fills: number; contracts: number }>;
  contractsByHour?: Record<string, number>;
  /** The maker buffer at the last evaluation (adaptive with the paper options). */
  makerBufferEnd?: number;
}

/**
 * Execution latency: every order and cancel the bot sends reaches the exchange `orderMs` /
 * `cancelMs` (+/- jitter) after the decision, against whatever the book and the tape look like
 * THEN. So a taker order fills at the later price, a maker quote joins the queue later (trades that
 * printed in flight cannot fill it), and a cancel can lose the race against a trade that reaches
 * the quote first (counted as `cancelRaceFills`). While a ticker has anything in flight the
 * strategy does not plan new quotes for it, as the engine's per-market busy flag does live.
 */
export interface BacktestLatency { orderMs: number; cancelMs?: number; jitterMs?: number }

export interface BacktestOpts { exitPolicy?: ExitPolicyName; ratchet?: RatchetParams; hunt?: HuntParams; volProfile?: VolProfile; applyVolSeasonality?: boolean; volModel?: VolModel; fillModel?: FillModel; sessionRisk?: SessionRiskProfile; huntSessionGuard?: boolean; huntTransitionBufferMin?: number; vault?: VaultConfig; calendar?: MacroEvent[]; sizingTiers?: TierPoint[]; latency?: BacktestLatency;
  /** Record the model calls to this tape on the first run, play them back on later ones (research/callTape.ts). `sig`
   *  must change with anything the calls depend on (the days, the model, the vol settings, the risk limits). Not used
   *  with a fill model (it reads features the tape does not keep). */
  tape?: { file: string; sig: string };
  /** Paper sizing as the engine does it (bot/engine.ts paperOrderUsd / orderLimits): each crypto order buys about
   *  orderFrac of the bankroll (or the fixed orderUsd with orderFrac 0), whatever the tier allows; the risk caps widen
   *  to fit one order, PAPER_WINDOW_ORDERS closing together and PAPER_TOTAL_ORDERS in all. The vault is bookkeeping
   *  only in paper, so it does not shrink the bankroll here either. */
  paper?: { orderFrac: number; orderUsd: number };
  /** The paper accuracy gate (bot/strategy/accuracyGate.ts): no new entry in a time-to-close bucket where the market's
   *  own price has called the recent results better than the bot. Starts with an empty scorecard (no look-ahead), or
   *  from accuracyGateFile. */
  accuracyGate?: AccuracyGateConfig;
  /** The gate's scorecard to start from (a copy: the gate writes to it), e.g. the paper bot's as it stood at tradeFromMs.
   *  Markets settling before tradeFromMs are then not scored again: the scorecard already holds paper's own. */
  accuracyGateFile?: string;
  /** The take-profit bench (bot/strategy/takeProfitBench.ts): take-profit sales scored against holding to settlement,
   *  benched (no more take-profit sales) on the exit curve's rule when `enforce`. `stateFile`: its scoreboard to start
   *  from (a copy: the bench writes to it), else an empty one. `follow`: the take-profit sells or sits out as another
   *  bench did (research/replayCheck.ts: paper's, benched from the start or not, then its benches and resets in time
   *  order); the replay's own scoreboard still scores every sale and paper.takeProfitBenchedAt says when it would have
   *  benched. */
  takeProfitBench?: { enforce: boolean; rule: Pick<ProbationParams, 'minTrades' | 't' | 'maxLossUsd' | 'window'>; stateFile?: string;
    follow?: { benched: string | null; events: Array<{ t: number; benched: string | null }> } };
  /** Replay from this time (ms) on: what the recordings hold before it is skipped, so the books, features and gate
   *  start empty there (research/replayCheck.ts starts hours before the stretch it compares). */
  startMs?: number;
  /** The break-even ratchet's daily goal (VAULT_DAILY_GOAL_USD), as the engine's equity guard has it; none when unset. */
  dailyGoalUsd?: number;
  /** The dashboard's kill-switch override (bot/control.ts: on unless turned off). With it the weekly loss pause does not
   *  stop entries, as in the engine. Default on. */
  killOverride?: boolean;
  /** The paper training supervisor's refill (bot/training/supervisor.ts checkKalshi), with the override on: once the
   *  bankroll is below MIN_TRADABLE_BANKROLL_USD and below this amount (PAPER_BANKROLL_USD), resting orders are
   *  cancelled, the account is topped back up to it and the equity guard starts a new epoch. Checked every 5 s from
   *  tradeFromMs, as the supervisor's pass runs. Off when unset. */
  refillUsd?: number;
  /** Start the equity guard from this saved state (a copy: the guard writes to it), e.g. the paper bot's
   *  equity_guard.json, so the break-even it sizes against and its sizing tier are the bot's. */
  equityGuardFile?: string;
  /** No orders before this time (ms): until then the replay only watches (research/replayCheck.ts). */
  tradeFromMs?: number;
  /** Evaluate on the engine's 1 s timer (bot/engine.ts: setInterval) this many ms into each second: wherever paper's
   *  timer fell, the replay can evaluate a little before or after the market moves it saw. Unset: at the first recorded
   *  event a second after the last evaluation. */
  tickPhaseMs?: number;
  /** With the paper options the maker buffer adapts as the engine's does (Engine.makerBuffer, bot/tca/tca.ts): once 30
   *  maker fills have a 60 s markout, it is minus their average (the newest 2000), within strategy.makerBufferRange.
   *  These seed it: the paper bot's own recent maker markouts (the replay check reads them from its TCA log). */
  makerMarkouts?: number[];
  /** Called at every market evaluation with the price the replay trades on (the replay check sets it beside the paper
   *  bot's decision records). */
  onEval?: (e: EvalReading) => void;
  /** Price with the TA network as the engine does (bot/engine.ts), reading the network engineModels installed: its
   *  validated vol forecast scales sigma (TA_VOL_WEIGHT) and its drift tilts the price (TA_PRICING). */
  taNet?: boolean;
  /** The component trials' verdicts (engineModels): with the paper options, paper's price leaves out the trained model
   *  when its trial is off, takes the TA network's full drift when its trial is on, and adds the rule book's tilt while
   *  that trial is applied. The SNN's blend is not replayed. */
  trials?: { applied(name: TrialName): boolean };
  /** Keep a market context (bot/ta/marketContext.ts) from the replayed candles, refreshed every minute as bot/main.ts
   *  does: breadth for the TA features, and each coin's character for the rule book. Process-wide, as in the bot. */
  marketContext?: boolean }
/** One market evaluation: the price traded on and what the fair value was made of (pModel: the trained model's price,
 *  before the TA tilt and the rule book's). */
export interface EvalReading { ticker: string; now: number; pYes: number; fv: number; bid: number; ask: number; position: number; spot?: number; strike?: number; sigma?: number; sigmaPricing?: number;
  pModel?: number; taVolMult?: number; taShift?: number; ruleShift?: number }

/** The engine's paper caps (bot/engine.ts): one order, this many closing together, this many in all. */
export const PAPER_WINDOW_ORDERS = 3;
/** The maker buffer's markouts (bot/tca/tca.ts): the newest 2000, and 30 before it adapts (bot/engine.ts makerBuffer). */
const MARKOUT_KEEP = 2000;
const MARKOUT_MIN = 30;
export const PAPER_TOTAL_ORDERS = 10;

/** The features read after the model call, kept on the tape: confluence for its exit, the take gate's inputs. */
export const TAKE_TAPE_KEYS = ['snn_up_h', 'snn_bias', 'snn_skill_h', 'snn_cal_h', ...TAKE_GATED_TREND.map(([n]) => n), ...TAKE_GATED_MICRO.map(([n]) => n), ...TAKE_GATED_DRIVERS];
/** The features the fill model reads beside the book (bot/tca/fillModel.ts fillInputs). */
const FILL_TAPE_KEYS = ['ofi_30s', 'tfi_60s', 'microprice_drift', 'trade_intensity_60s', 'vpin_300s'];
/** The features the selection priority reads (bot/strategy/taConviction.ts orientedSignals, altcoinRiskOn). */
export const PRIORITY_TAPE_KEYS = ['conf_count', 'taconf_net_trend', 'taconf_trend_alignment', 'taconf_mtf_momentum', 'ta_rsi_1h', 'ta_ema_stack_1h', 'ta_rsi_15m', 'rsi_14_1m', 'usdtd_ret_15m_z'];
const tapeKeys = (policy: ExitPolicyName, strategy: StrategyConfig, model: MetaModel, fillModel?: FillModel) => [
  ...PRIORITY_TAPE_KEYS,
  ...(strategy.takeGate === 'validated' && model.params.take?.validation.validated ? TAKE_TAPE_KEYS : []),
  ...(fillModel ? FILL_TAPE_KEYS : []),
];
/** A feature map with only the taped keys; reading any other is a miss (the run starts over without the tape). */
const tapedMap = (keys: string[], x: Float64Array): Record<string, number> => new Proxy({} as Record<string, number>, {
  get: (_, k) => { if (typeof k !== 'string') return undefined; const i = keys.indexOf(k); if (i < 0) throw new TapeMiss(`feature ${k} is not on the tape`); return x[i]; },
  has: (_, k) => typeof k === 'string' && keys.includes(k),
});

/** The models the engine prices with besides the meta-model, loaded as bot/main.ts loads them: the intraday volatility
 *  profile (VOL_SEASONALITY, only when its own validation improved), the tree volatility forecast (VOL_MODEL) and the
 *  fill model (each applied only when validated), the macro calendar, the TA network (TA_NET, with TA_NET_ENSEMBLE - 1
 *  archived versions) and the rule book; from the bot's model directory (AUTO_TRAIN_DIR, a copy of the server's) when
 *  there, else the shipped params/ files (bot/autotrain.ts resolveModelPaths). The TA network and the rule book are
 *  installed process-wide, as in the bot. `trialsFile`: the bot's component_trials.json, read from a private copy (the
 *  trials' verdicts on paper's price). `used` names the ones in use; `sig` is what a call tape depends on. */
export async function engineModels(cfg: Config, o: { trialsFile?: string } = {}): Promise<{ volProfile?: VolProfile; volModel?: VolModel; fillModel?: FillModel; calendar?: MacroEvent[]; trials?: ComponentTrials; used: string[]; sig: string }> {
  const { resolveModelPaths } = await import('../bot/autotrain');
  const paths = resolveModelPaths(cfg);
  const vp = fs.existsSync(paths.vol) ? loadVolProfile(paths.vol) : undefined;
  const volProfile = vp && cfg.strategy.volSeasonality && vp.validation?.improved ? vp : undefined;
  let volModel: VolModel | undefined, fillModel: FillModel | undefined, taNet: TaNet | undefined;
  try { volModel = cfg.strategy.volModel && fs.existsSync(paths.vol_model) ? VolModel.load(paths.vol_model) : undefined; } catch { volModel = undefined; }
  try { fillModel = fs.existsSync(paths.fill) ? FillModel.load(paths.fill) : undefined; } catch { fillModel = undefined; }
  const calendar = loadCalendar(path.resolve(process.env.MACRO_CALENDAR_PATH ?? './params/calendar.json'));
  try { taNet = cfg.taNet.enabled && fs.existsSync(paths.ta_net) ? TaNet.load(paths.ta_net) : undefined; } catch { taNet = undefined; }
  setTaNet(taNet, cfg.taNet.requireValidated);
  const archiveDir = path.join(cfg.autoTrain.dir, 'archive', 'ta_net');
  setTaNetEnsemble(taNet && cfg.taNet.ensemble > 1 ? new TaNetEnsemble(archiveDir, cfg.taNet.ensemble) : undefined);
  const archived = taNet && cfg.taNet.ensemble > 1 && fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, cfg.taNet.ensemble) : [];
  const ruleBookFile = path.join(cfg.autoTrain.dir, 'rule_book.json');
  setRuleBook(new RuleBook(() => ruleBookFile));
  // The evolved formula (bot/main.ts): one of the signals the engine's selection priority counts.
  const gpFile = path.join(cfg.autoTrain.dir, 'gp_indicators.json');
  setGpSignals(cfg.strategy.gp ? new GpSignals(() => gpFile, () => !cfg.strategy.gpRequireValidated && (cfg.mode !== 'live' || cfg.liveAllowUnvalidated)) : undefined);
  let trials: ComponentTrials | undefined;
  if (cfg.trials.enabled) {
    let file: string | undefined;
    if (o.trialsFile && fs.existsSync(o.trialsFile)) {
      file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trials-')), 'component_trials.json');
      fs.copyFileSync(o.trialsFile, file);
    }
    trials = new ComponentTrials(cfg.trials, file);
  }
  const taVol = taNet?.active(cfg.taNet.requireValidated).includes('vol_4h');
  const used = [volProfile ? 'vol profile' : '', volModel?.validated ? 'vol model' : '', fillModel ? `fill model${fillModel.validated ? '' : ' (unvalidated)'}` : '', calendar?.length ? 'macro calendar' : '',
    taNet ? `TA network${taVol ? ' (vol forecast in use)' : ''}${archived.length ? ` + ${Math.min(archived.length, cfg.taNet.ensemble - 1)} archived` : ''}` : '', fs.existsSync(ruleBookFile) ? 'rule book' : '',
    cfg.strategy.gp && fs.existsSync(gpFile) ? 'evolved formula' : '', trials ? `trials in paper's price: ${(['mlp', 'snn', 'ta', 'rules'] as TrialName[]).filter((n) => trials!.applied(n)).join(' ') || 'none'}` : ''].filter(Boolean);
  // What a call tape depends on: the fair value's volatility, the calendar's and the TA network's features.
  const sig = JSON.stringify([volProfile?.version ?? null, volModel?.validated ? volModel.params.trainedAt : null, calendar?.length ?? 0, taNet?.version ?? null, archived]);
  return { volProfile, volModel, fillModel, calendar, trials, used, sig };
}

/** The validation gates as the bot runs them (bot/main.ts): with VALIDATION_GATES=monitor (the default) a model that
 *  has not passed validation (the fill model, the take model) trades on probation unless its book is benched. `stateFile`
 *  is the bot's probation.json, read from a private copy (nothing is written back). Process-wide, as in the bot; returns
 *  the benched books. */
export function installProbation(cfg: Config, stateFile?: string): string[] {
  let file: string | undefined;
  if (stateFile && fs.existsSync(stateFile)) {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'probation-')), 'probation.json');
    fs.copyFileSync(stateFile, file);
  }
  const p = new Probation(cfg.probation, file);
  setProbation(p);
  return p.p.mode === 'monitor' ? PROBATION_BOOKS.filter((b) => !p.open(b)) : [];
}

export async function runBacktest(dir: string, model: MetaModel, strategy: StrategyConfig, limits: RiskLimits, bankroll0: number, opts: BacktestOpts = {}): Promise<BacktestResult> {
  const t = opts.tape;
  if (!t) return runBacktestOnce(dir, model, strategy, limits, bankroll0, opts);
  const keys = tapeKeys(opts.exitPolicy ?? 'fair_value', strategy, model, opts.fillModel);
  for (let attempt = 0; ; attempt++) {
    const tape = openTape(t.file, t.sig, keys);
    try {
      const r = await runBacktestOnce(dir, model, strategy, limits, bankroll0, opts, tape);
      tape.finish();
      return r;
    } catch (e) {
      tape.abort();
      if (!(e instanceof TapeMiss) || attempt > 0) throw e;
      dropTape(t.file);
    }
  }
}

async function runBacktestOnce(dir: string, model: MetaModel, strategy: StrategyConfig, limits: RiskLimits, bankroll0: number, opts: BacktestOpts, tape?: TapeReader | TapeWriter): Promise<BacktestResult> {
  const policy = opts.exitPolicy ?? 'fair_value';
  const st = new ReplayState();
  const volFc = new VolForecaster(opts.volModel);
  const pos = new PositionBook();
  const ex = new PaperExchange(undefined, bankroll0, (t) => st.books.get(t), () => DEFAULT_FEES, () => st.now);
  const gateway = new RiskGateway(limits);
  const exits: ExitStats = { orders: 0, fills: 0, contracts: 0, proceeds: 0, regret: 0, stoppedWinners: 0, ratchetTriggers: 0, gaps: 0, hybridHolds: 0, huntActivations: 0, huntDeactivations: 0, huntProfitTakes: 0, avgSlippage: null };
  const vault = opts.vault ? new Vault(opts.vault, undefined, () => st.now) : undefined;
  const res: BacktestResult = { exitPolicy: policy, label: policy === 'confluence_ratchet' ? `confluence_ratchet[m=${(opts.hunt ?? DEFAULT_HUNT).targetMargin},f=${(opts.ratchet ?? DEFAULT_RATCHET).minFillRatio}]` : policy, huntParams: policy === 'confluence_ratchet' ? { hunt: opts.hunt ?? DEFAULT_HUNT, ratchet: opts.ratchet ?? DEFAULT_RATCHET } : undefined, vaultEnd: 0, pocketEnd: 0, bySession: {}, exits, trades: [], takeProfitFills: 0, latency: { orderMs: opts.latency?.orderMs ?? 0, cancelMs: opts.latency?.cancelMs ?? opts.latency?.orderMs ?? 0, jitterMs: opts.latency?.jitterMs ?? 0, sent: 0, cancelRaceFills: 0, cancelRaceContracts: 0, lateKills: 0 }, entryEvaluations: 0, days: 0, minEdge: strategy.minEdge, windows: new Map(), fills: 0, contracts: 0, fees: 0, pnl: 0 };
  const cadence = new CadenceGate(strategy);
  const lastPos = new Map<string, number>();
  const peaks = new ProfitPeaks();
  // The engine's loop (bot/engine.ts tick): each market's selection priority from its last evaluation, when that was, and
  // how long a market with nothing working waits between evaluations.
  const priority = new Map<string, number>();
  const lastEval = new Map<string, number>();
  const idleMs = Math.max(0, strategy.idleEvalSec ?? 0) * 1000;
  const snaps = new Map<string, { t: number; s: TaSnapshot | undefined }>();
  const taSnapOf = (asset: string) => {
    const c = snaps.get(asset);
    if (c && c.t === st.now) return c.s;
    const s = st.features.candles.get(asset)?.snapshot(st.now, marketContext()?.macro());
    snaps.set(asset, { t: st.now, s });
    return s;
  };
  // Bankroll tiers from the tradable high-water mark, with the tier's drawdown brake (mirrors the engine).
  const tiers = opts.sizingTiers ?? defaultTiers({ risk: limits, strategy });
  let peakBank = 0;
  // The engine's loss-aware sizing and weekly loss pause, in memory (bot/risk/equityGuard.ts).
  const guard = new EquityGuard({ ddScaleAt: strategy.ddScaleAt, weeklyLossPause: strategy.weeklyLossPause, dailyGoalUsd: opts.dailyGoalUsd }, opts.equityGuardFile);
  const stratRun: StrategyConfig = { ...strategy, exitPolicy: policy === 'take_profit' ? 'take_profit' : policy === 'hold' ? 'hold' : strategy.exitPolicy === 'take_profit' ? 'fair_value' : strategy.exitPolicy };
  let firstTs = 0;
  const closeOf = new Map<string, number>();
  const ratchets = new Map<string, LiquidityRatchet>();
  const hunts = new Map<string, ConfluenceRatchetExit>();
  const pending = new Map<string, { side: 'bid' | 'ask'; price: number; count: number; kind: 'fv' | 'tp' | 'rt'; stop?: number }>();
  let exitSeq = 0;
  // The paper bot's exploration entries and training trades (with the paper options; see below).
  const exploreTs: number[] = [], trainTs: number[] = [];
  const trainTicker = new Set<string>();
  const exploreRng = rng(29);
  // The adaptive maker buffer (see BacktestOpts.makerMarkouts): maker fills wait 60 s for their markout, signed so that
  // positive is the market moving the fill's way.
  const markouts = (opts.makerMarkouts ?? []).filter((x) => Number.isFinite(x)).slice(-MARKOUT_KEEP);
  const markoutDue: Array<{ due: number; ticker: string; sign: 1 | -1; price: number }> = [];
  const makerBuffer = (): number => {
    if (!opts.paper || markouts.length < MARKOUT_MIN) return strategy.makerBuffer;
    const avg = markouts.reduce((a, x) => a + x, 0) / markouts.length;
    return Math.min(strategy.makerBufferRange[1], Math.max(strategy.makerBufferRange[0], -avg));
  };
  res.makerBufferEnd = undefined;
  const stopByOrder = new Map<string, number>();
  const exitLedger = new Map<string, Array<{ sideSign: number; n: number; proceeds: number }>>();
  let slipSum = 0, slipN = 0;
  const gate = opts.accuracyGate?.enabled ? new AccuracyGate(opts.accuracyGate, opts.accuracyGateFile, () => st.now) : undefined;
  // The bench's markets scored from the first trading moment on (the replay check sets them beside paper's).
  const tpScored = (e: { event: string; ticker?: string; usd?: unknown; contracts?: unknown }) => {
    if (e.event !== 'scored' || st.now < (opts.tradeFromMs ?? -Infinity)) return;
    res.paper!.takeProfitScored!++; res.paper!.takeProfitNetUsd! += Number(e.usd) || 0;
    if (e.ticker) res.paper!.takeProfitByMarket![e.ticker] = { usd: Number(e.usd) || 0, contracts: Number(e.contracts) || 0, t: st.now };
  };
  const follow = opts.takeProfitBench?.follow;
  const tpBench = opts.takeProfitBench ? new TakeProfitBench(opts.takeProfitBench.enforce && !follow, opts.takeProfitBench.rule, opts.takeProfitBench.stateFile, tpScored, 0) : undefined;
  // Benched or selling now: the replay's own bench, or the one it follows.
  let followAt = 0, followed = follow?.benched ?? undefined;
  const tpBenched = (): string | undefined => {
    if (!follow) return tpBench?.benched;
    while (followAt < follow.events.length && follow.events[followAt].t <= st.now) followed = follow.events[followAt++].benched ?? undefined;
    return followed;
  };
  // When the replay's own scoreboard benched (or, following another bench, would have).
  const ownBenched = () => (follow ? tpBench?.status().wouldBench ?? undefined : tpBench?.benched);
  res.paper = { accuracyBlocks: 0, takeProfitBenchedAt: undefined, takeProfitSales: 0, takeProfitContracts: 0, takeProfitScored: 0, takeProfitNetUsd: 0, takeProfitByMarket: {}, rejected: {}, trainTrades: 0, exploreEntries: 0, extraSent: 0, extraRejected: {} };
  // The risk gateway's rejections from the first trading moment on, deduped as the engine logs them (one a market, side,
  // purpose and reason a minute), for the replay check.
  const rejectSeen = new Map<string, number>();
  // A bench started from a benched scoreboard (takeProfitBench.stateFile) is benched from the first trading moment on.
  if (ownBenched()) res.paper.takeProfitBenchedAt = opts.tradeFromMs ?? opts.startMs;
  // The market context (opts.marketContext): a fresh one each run, so a replay of an earlier span starts clean; risk
  // gauges from the history directory the replay's index series come from (research/replay.ts).
  const mctx = opts.marketContext ? new MarketContext(path.resolve(process.env.HISTORY_DIR ?? path.join(process.env.DATA_DIR ?? './data', 'history'))) : undefined;
  if (mctx) setMarketContext(mctx);
  let ctxAt = -Infinity;
  res.byPurpose = {};
  res.contractsByHour = {};
  // An order's purpose from its client order id (<ticker>-<ms>-<side>-<purpose>[-tp]; a queued exit <ticker>-<ms>-exit-<kind>).
  const purposeOf = (coid?: string) => (!coid ? 'other' : coid.includes('-exit-') ? 'exit' : /-(quote|entry|exit)(?:-tp)?$/.exec(coid)?.[1] ?? 'other');

  ex.on('fill', (f) => {
    pos.applyFill({ ticker: f.ticker, side: f.side, count: f.count, price: f.price, fee: f.fee ?? 0 }, { closeTs: closeOf.get(f.ticker) });
    const w = closeOf.get(f.ticker)!;
    const b = res.windows.get(w) ?? { pnl: 0, contracts: 0, fees: 0 };
    b.contracts += f.count;
    b.fees += f.fee ?? 0;
    b.fills = (b.fills ?? 0) + 1;
    res.windows.set(w, b);
    res.fills++; res.contracts += f.count; res.fees += f.fee ?? 0;
    if (opts.paper && !f.isTaker) markoutDue.push({ due: st.now + 60_000, ticker: f.ticker, sign: f.side === 'bid' ? 1 : -1, price: f.price });
    const bp = (res.byPurpose![purposeOf(f.clientOrderId)] ??= { fills: 0, contracts: 0 });
    bp.fills++; bp.contracts += f.count;
    const hour = new Date(st.now).toISOString().slice(0, 13);
    res.contractsByHour![hour] = (res.contractsByHour![hour] ?? 0) + f.count;
    if (cancelInFlight.has(f.orderId)) { L.cancelRaceFills++; L.cancelRaceContracts += f.count; }
    if (f.clientOrderId?.endsWith('-tp')) {
      res.takeProfitFills++;
      if (tpBench && f.count > 0) {
        // Selling YES (an ask) closes a YES position; buying YES (a bid) closes a NO one (bot/engine.ts noteScoredExitFill).
        const sign = f.side === 'ask' ? 1 : -1;
        tpBench.filled(f.ticker, sign, sign > 0 ? f.price : Math.round((1 - f.price) * 1e4) / 1e4, f.count, (f.fee ?? 0) / f.count, st.now);
        res.paper!.takeProfitSales++;
        res.paper!.takeProfitContracts = (res.paper!.takeProfitContracts ?? 0) + f.count;
      }
    }
    if (f.clientOrderId?.includes('-exit-')) {
      const sideSign = f.side === 'ask' ? 1 : -1; // selling YES exits a long YES; buying YES exits a long NO
      const sidePrice = sideSign > 0 ? f.price : 1 - f.price;
      const proceeds = f.count * sidePrice - (f.fee ?? 0);
      exits.fills++; exits.contracts += f.count; exits.proceeds += proceeds;
      const arr = exitLedger.get(f.ticker) ?? [];
      arr.push({ sideSign, n: f.count, proceeds });
      exitLedger.set(f.ticker, arr);
      const stop = stopByOrder.get(f.clientOrderId);
      if (stop !== undefined) { slipSum += stop - sidePrice; slipN++; }
    }
  });

  // Latency: actions wait in `inflight` until their arrival time; each runs against the state at that time.
  const L = res.latency!;
  const jitter = rng(17);
  const inflight: Array<{ due: number; ticker: string; orderId?: string; run: () => Promise<void> }> = [];
  const cancelInFlight = new Set<string>();
  const send = async (ticker: string, kind: 'order' | 'cancel', run: () => Promise<void>, orderId?: string): Promise<void> => {
    const base = kind === 'cancel' ? L.cancelMs : L.orderMs;
    if (base <= 0 && L.jitterMs <= 0) return run();
    L.sent++;
    const due = st.now + Math.max(0, base + (jitter() * 2 - 1) * L.jitterMs);
    let i = inflight.length;
    while (i > 0 && inflight[i - 1].due > due) i--;
    inflight.splice(i, 0, { due, ticker, orderId: kind === 'cancel' ? orderId : undefined, run });
    if (kind === 'cancel' && orderId) cancelInFlight.add(orderId);
  };
  const inflightFor = (t: string) => inflight.some((x) => x.ticker === t);
  const cancelNow = async (orderId: string) => { cancelInFlight.delete(orderId); try { await ex.cancelOrder(orderId); } catch { /* already gone: the cancel lost the race */ L.lateKills++; } };

  let lastTick = 0, nextTick = -Infinity, refillAt = -Infinity;
  for await (const e of readRecordings(dir)) {
    if (opts.startMs !== undefined && e.t < opts.startMs) continue;
    while (inflight.length && inflight[0].due <= e.t) await inflight.shift()!.run();
    st.apply(e);
    if (!firstTs) firstTs = st.now;
    if (e.k === 'trade') ex.onTrade(e.ticker, e.price, e.count, e.takerSide, e.ts);
    if (e.tie) continue; // the rest of this instant first
    if (opts.tickPhaseMs !== undefined) {
      if (st.now < nextTick) continue;
      nextTick = st.now - ((((st.now - opts.tickPhaseMs) % 1000) + 1000) % 1000) + 1000;
    } else if (st.now - lastTick < 1000) continue;
    lastTick = st.now;
    while (markoutDue.length && markoutDue[0].due <= st.now) {
      const x = markoutDue.shift()!;
      const mid = st.books.get(x.ticker)?.mid();
      if (mid === undefined) continue;
      markouts.push(x.sign * (mid - x.price));
      if (markouts.length > MARKOUT_KEEP) markouts.shift();
    }
    // Refreshed every minute, as bot/main.ts does.
    if (mctx && st.now - ctxAt >= 60_000) {
      ctxAt = st.now;
      try { mctx.update(st.features.candles.values(), st.now, (a) => taNetView(a, st.features.candles.get(a), st.now)?.vol4h); } catch { /* as the bot: kept as it was */ }
    }
    // The supervisor's pass (bot/training/supervisor.ts checkKalshi): a pool that can no longer trade is refilled.
    if (opts.refillUsd !== undefined && opts.killOverride !== false && st.now - refillAt >= 5_000 && st.now >= (opts.tradeFromMs ?? -Infinity)) {
      refillAt = st.now;
      const bank = (await ex.getBalance()) + pos.open().reduce((s, p) => s + PositionBook.maxLoss(p), 0);
      if (bank < strategy.minTradableBankrollUsd && bank < opts.refillUsd) {
        for (const o of await ex.getOpenOrders()) await cancelNow(o.orderId);
        const usd = Math.round((opts.refillUsd - bank) * 100) / 100;
        ex.refill(usd);
        const eq = (await ex.getBalance()) + pos.open().reduce((s, p) => s + PositionBook.maxLoss(p), 0);
        guard.resetEpoch(eq, st.now, eq);
        (res.refills ??= []).push({ t: st.now, usd });
      }
    }

    for (const m of [...st.markets.values()].sort((a, b) => (priority.get(b.ticker) ?? 0) - (priority.get(a.ticker) ?? 0))) {
      // Recorded for research, or synthesized from price history (quoted at the model's own fair value): never traded.
      if (m.recordOnly || m.synthetic) { if (st.now >= m.closeTime + 90_000) st.forget(m.ticker); continue; }
      closeOf.set(m.ticker, m.closeTime);
      // Settle closed markets.
      if (st.now >= m.closeTime + 60_000) {
        const out = st.outcome(m);
        if (out) {
          const result = out.label ? 'yes' : 'no';
          ex.settle(m.ticker, result);
          if (!(opts.accuracyGateFile && opts.tradeFromMs !== undefined && st.now < opts.tradeFromMs)) gate?.settle(m.ticker, result);
          if (tpBench) { tpBench.settled(m.ticker, result, st.now); if (res.paper!.takeProfitBenchedAt === undefined && ownBenched()) res.paper!.takeProfitBenchedAt = st.now; }
          for (const x of exitLedger.get(m.ticker) ?? []) {
            const won = (x.sideSign > 0) === (result === 'yes');
            exits.regret += (won ? x.n : 0) - x.proceeds;
            if (won) exits.stoppedWinners++;
          }
          exitLedger.delete(m.ticker);
          ratchets.delete(m.ticker);
          hunts.delete(m.ticker);
          cadence.forget(m.ticker);
          pending.delete(m.ticker);
          priority.delete(m.ticker);
          lastEval.delete(m.ticker);
          trainTicker.delete(m.ticker);
          const p = pos.get(m.ticker);
          if (p && !p.settled) {
            pos.settle(m.ticker, result, st.now);
            const traded = res.windows.get(m.closeTime)?.contracts ?? 0;
            if (traded > 0) res.trades.push({ ticker: m.ticker, closeTs: m.closeTime, pnl: p.realized ?? 0, contracts: traded, kind: m.kind });
            const b = res.windows.get(m.closeTime) ?? { pnl: 0, contracts: 0, fees: 0 };
            b.pnl += p.realized ?? 0;
            res.windows.set(m.closeTime, b);
            res.pnl += p.realized ?? 0;
            if (p.realized) guard.onTradeResult(p.realized > 0, (await ex.getBalance()) + pos.open().reduce((x, q) => x + PositionBook.maxLoss(q), 0), st.now);
            if ((p.realized ?? 0) > 0) vault?.onSettled(p.realized!, m.ticker, st.now, peakBank);
            const sk = sessionState(m.openTime).key;
            const sb = res.bySession[sk] ?? { windows: 0, pnl: 0, contracts: 0, fees: 0 };
            sb.windows++; sb.pnl += p.realized ?? 0; sb.contracts += b.contracts; sb.fees += b.fees;
            res.bySession[sk] = sb;
          }
        }
        st.forget(m.ticker);
        continue;
      }
      if (st.now < m.openTime || st.now >= m.closeTime) continue;

      const book = st.books.get(m.ticker);
      const idx = st.index.get(m.asset);
      const bid = book?.bestBid(), ask = book?.bestAsk();
      const spot = idx?.fresh(st.now, limits.maxIndexAgeMs);
      const vol = idx?.vol();
      const terms = st.terms(m);
      const open = (await ex.getOpenOrders()).filter((o) => o.ticker === m.ticker);
      // Nothing working here (no position, no resting order, nothing in flight): evaluated again EVAL_IDLE_SEC after the
      // last time, as the engine does. A tape being recorded still gets this second's model call: it holds every call any
      // run over the window can make.
      const idle = idleMs > 0 && pos.position(m.ticker) === 0 && !open.length && !inflightFor(m.ticker) && !pending.has(m.ticker) && st.now - (lastEval.get(m.ticker) ?? -Infinity) < idleMs;
      if (idle && tape?.mode !== 'record') continue;
      if (!idle) lastEval.set(m.ticker, st.now);
      if (!book?.isUsable(st.now, limits.maxBookAgeMs) || !bid || !ask || !spot || !vol || !terms) {
        for (const o of open) if (!cancelInFlight.has(o.orderId)) await send(m.ticker, 'cancel', () => cancelNow(o.orderId), o.orderId);
        pending.delete(m.ticker); // never fire a queued exit into a stale book later
        continue;
      }
      const tauSec = (m.closeTime - st.now) / 1000;
      const settle = tauSec <= SETTLEMENT_AVG_SEC ? idx!.settlement(m.closeTime, st.now, SETTLEMENT_AVG_SEC) : undefined;
      const observed = settle?.avg, observedCount = settle?.n;
      const candles = st.features.candles.get(m.asset);
      // The TA network's readings (opts.taNet): its validated vol forecast scales sigma toward where volatility is heading,
      // m = exp(forecast) x 24 h realised / EWMA in [0.5, 2], applied as m^TA_VOL_WEIGHT while the tree vol model is not
      // validated (bot/engine.ts).
      const taView = opts.taNet ? taNetView(m.asset, candles, st.now) : undefined;
      let taVolMult = 1;
      if (taView && strategy.taVolWeight > 0 && !volFc.model?.validated && taView.vol4h !== undefined && Number.isFinite(taView.vol4h)) {
        const h1 = candles?.bars['1h'];
        const rv = h1 && h1.length > 25 ? sigma24(h1, h1.length - 1) : NaN;
        const ewmaHour = vol.sigmaPerSqrtSec * 60;
        if (rv > 0 && ewmaHour > 0) taVolMult = Math.max(0.5, Math.min(2, Math.exp(taView.vol4h) * rv / ewmaHour)) ** strategy.taVolWeight;
      }
      // As live: the vol forecast once validated, else the flat fallback multiplier.
      const sigmaFv = (opts.applyVolSeasonality ? effectiveSigma(vol.sigmaPerSqrtSec, opts.volProfile, m.asset, st.now, m.closeTime) : vol.sigmaPerSqrtSec)
        * (volFc.model?.validated
          ? volFc.multiplier(m.asset, st.now, vol.sigmaPerSqrtSec, tauSec, () => assetFeatureMap(m.asset, st.now, { index: idx, spot: st.spot.get(m.asset), bars: st.features.bars.get(m.asset), candles, usdtd: st.usdtd, btcd: st.btcd, perp: st.features.perps.get(m.asset) }))
          : strategy.volFallbackMult ?? 1) * taVolMult;
      const fv = priceContract(terms, { spot: spot.value, sigmaPerSqrtSec: sigmaFv, tauSec, observedAvg: observed, observedCount, nu: model.params.tNu });
      if (!fv) continue;
      const mid = (bid.price + ask.price) / 2;
      let fmap: Record<string, number>, pred: { p: number; std?: number };
      if (tape?.mode === 'replay') {
        const c = tape.next(st.now, tickerHash(m.ticker), fv.pYes);
        pred = { p: c.p, std: c.std };
        fmap = tapedMap(tape.keys, c.x);
      } else {
        fmap = computeFeatureMap({
          now: st.now, fairValue: fv.pYes, mid, tauSec, sigmaPerSqrtSec: vol.sigmaPerSqrtSec, referenceSigma: model.params.referenceSigma, inWindow: fv.regime !== 'pre_window', book, micro: st.features.micro.get(m.ticker), index: idx!, spot: st.spot.get(m.asset), asset: m.asset, usdtd: st.usdtd, btcd: st.btcd, closeTs: m.closeTime, volProfile: opts.volProfile, asiaRange: st.features.asiaRange.get(m.asset),
          kind: m.kind, strike: terms.strike, cap: terms.cap, d2: fv.d2, vEff: fv.vEff, sigmaPricing: sigmaFv, tNu: model.params.tNu, bars: st.features.bars.get(m.asset), peerBars: st.features.bars, openTime: m.openTime, calendar: opts.calendar,
          ticker: m.ticker, siblings: m.kind === 'updown' ? undefined : ladderQuotes(st.markets.values(), (t) => st.books.get(t), m.asset, m.closeTime),
          perp: st.features.perps.get(m.asset), candles: st.features.candles.get(m.asset), snn: st.snnContext(m.asset, m.ticker),
        });
        pred = model.predictDetailed(fmap, fv.pYes);
        tape?.push(st.now, tickerHash(m.ticker), fv.pYes, pred.p, pred.std, tape.keys.map((k) => fmap[k]));
      }
      if (idle) continue;
      // The market's place in the next pass (bot/engine.ts): altcoin risk-on first, then TA / confluence conviction, with
      // the rule book's and the evolved formula's readings among the signals, as paper reads them.
      {
        const ctx = marketContext();
        const rb = strategy.ruleBook ? activeRuleBook()?.read(taSnapOf(m.asset), Math.max(1, tauSec / 3600), ctx?.character(m.asset)?.cls) : undefined;
        const gp = strategy.gp ? activeGpSignals()?.read(m.asset, (a) => st.features.candles.get(a)?.bars['1h']) : undefined;
        const signals = orientedSignals(fmap, taView, false, rb, gp && (gp.validated || gp.speaks || gatePasses('kalshi', false)) ? gp : undefined);
        const rsi = [(m.closeTime - m.openTime) / 60_000 <= 20 ? fmap.ta_rsi_15m : fmap.ta_rsi_1h, fmap.rsi_14_1m].find((x) => x !== undefined && Number.isFinite(x));
        const alt = altcoinRiskOn(m.asset, fmap.usdtd_ret_15m_z, rsi, strategy);
        priority.set(m.ticker, selectionPriority(alt.active, taNetDirection(taView, false), confluenceBreadth(signals, 1).breadth, confluenceBreadth(signals, -1).breadth));
      }
      // Paper's price (bot/engine.ts): the trained model unless its trial switched it off, the TA network's drift (its
      // trial's full drift once that is on) unless the model reads the network itself, then the rule book's trial tilt
      // while that trial is applied. A tilt re-prices the contract with the index moved by w x k sigma sqrt(tau), capped.
      const trialOn = (name: TrialName) => Boolean(opts.paper && opts.trials?.applied(name));
      const tilt = (k: number, w: number) => {
        if (!(Math.abs(k) > 1e-9)) return 0;
        const tilted = priceContract(terms, { spot: spot.value * Math.exp(w * k * sigmaFv * Math.sqrt(tauSec)), sigmaPerSqrtSec: sigmaFv, tauSec, observedAvg: observed, observedCount, nu: model.params.tNu });
        return tilted ? Math.max(-strategy.taPricingMaxShift, Math.min(strategy.taPricingMaxShift, tilted.pYes - fv.pYes)) : 0;
      };
      const pModel = opts.paper && opts.trials && !trialOn('mlp') ? fv.pYes : pred.p;
      const modelReadsTa = model.params.kind !== 'identity' && model.params.features.some((f) => f.startsWith('tanet_up'));
      const taPricing = Boolean(opts.taNet) && strategy.taPricing && strategy.taPricingWeight > 0 && !modelReadsTa;
      const drift = taPricing ? taDrift(taView, tauSec, { maxZ: strategy.taPricingMaxZ, live: false }) : undefined;
      const driftFull = taPricing && opts.trials ? taDrift(taView, tauSec, { maxZ: strategy.taPricingMaxZ, live: false, full: true }) : undefined;
      const taShiftFull = driftFull ? tilt(driftFull.k, strategy.taPricingWeight) : undefined;
      const taShift = trialOn('ta') && taShiftFull !== undefined ? taShiftFull : drift ? tilt(drift.k, strategy.taPricingWeight) : 0;
      let pYes = taShift !== 0 ? Math.max(0.001, Math.min(0.999, pModel + taShift)) : pModel;
      let ruleShift = 0;
      if (trialOn('rules')) {
        const ctx = marketContext();
        const rb = activeRuleBook()?.trialRead(taSnapOf(m.asset), tauSec, ctx?.character(m.asset)?.cls, strategy.taPricingMaxZ);
        ruleShift = rb ? tilt(rb.k, 1) : 0;
        if (ruleShift) pYes = Math.max(0.001, Math.min(0.999, pYes + ruleShift));
      }
      opts.onEval?.({ ticker: m.ticker, now: st.now, pYes, fv: fv.pYes, bid: bid.price, ask: ask.price, position: pos.position(m.ticker), spot: spot.value, strike: terms.strike, sigma: vol.sigmaPerSqrtSec, sigmaPricing: sigmaFv,
        pModel: pred.p, taVolMult, taShift, ruleShift });
      const pMarket = model.marketProbability(mid);
      const ret = idx!.trailingLogReturn(st.now, strategy.fastMoveWindowSec * 1000);
      const fastMove = ret !== undefined && Math.abs(ret) > strategy.fastMoveSigmas * vol.sigmaPerSqrtSec * Math.sqrt(strategy.fastMoveWindowSec);
      vault?.tick(st.now);
      const bankroll = Math.max(0, (await ex.getBalance()) + pos.open().reduce((s, p) => s + PositionBook.maxLoss(p), 0) - (opts.paper ? 0 : vault?.reserved() ?? 0));
      peakBank = Math.max(peakBank, bankroll);
      // The tier from the tradable high-water mark, as the engine picks it (EquityGuard.tierReference).
      const tier = tierAt(tiers, guard.tierReference(bankroll));
      // As the engine sizes (Engine.riskScale): full size at or above break-even (the starting equity, raised by the
      // guard's ratchets), down to a quarter at a net loss of the tier's ddScaleAt, never zero.
      guard.update(bankroll, st.now, bankroll, tier.weeklyLossPause);
      const sizeScale = guard.sizeScale(bankroll, tier.ddScaleAt);
      res.sizeScaleMin = Math.min(res.sizeScaleMin ?? 1, sizeScale);
      // Paper: about orderFrac of the bankroll an order (bot/engine.ts paperOrderUsd), the caps widened to fit it.
      const fixedUsd = !opts.paper ? 0 : opts.paper.orderFrac > 0 ? (bankroll > 0 ? Math.round(opts.paper.orderFrac * bankroll * 100) / 100 : 0) : Math.max(0, opts.paper.orderUsd);
      const tierLimits = { maxOrderRiskFrac: tier.orderFrac, maxWindowRiskFrac: tier.windowFrac, maxTotalRiskFrac: tier.totalFrac, dailyLossLimitFrac: tier.dailyLossFrac, dailyLossLimitUsd: tier.dailyLossUsd };
      if (fixedUsd > 0 && bankroll > 0) {
        tierLimits.maxOrderRiskFrac = Math.max(tier.orderFrac, fixedUsd / bankroll);
        tierLimits.maxWindowRiskFrac = Math.max(tier.windowFrac, (PAPER_WINDOW_ORDERS * fixedUsd) / bankroll);
        tierLimits.maxTotalRiskFrac = Math.max(tier.totalFrac, (PAPER_TOTAL_ORDERS * fixedUsd) / bankroll);
      }
      const q = (side: 'bid' | 'ask') => { const o = open.find((x) => x.side === side); return o ? { clientOrderId: o.orderId, price: o.price, remaining: o.remainingCount } : undefined; };
      // An exit queued on an evaluation goes out on the next one, a second later (the live bot's reaction); with the paper
      // options it goes out at the end of the same evaluation, as the paper bot sends it to its in-process exchange.
      const fireExit = async () => {
        const due = pending.get(m.ticker);
        pending.delete(m.ticker);
        const curPos = pos.position(m.ticker);
        if (!due || Math.sign(curPos) !== (due.side === 'ask' ? 1 : -1)) return;
        const count = Math.min(due.count, Math.abs(curPos));
        const intent: OrderIntent = { ticker: m.ticker, asset: m.asset, windowCloseTs: m.closeTime, side: due.side, price: due.price, count, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: true, purpose: 'exit', fairValue: pYes, modelId: model.id, decisionId: 'bt' };
        const d = gateway.check(intent, {
          now: st.now, mode: 'paper', killEngaged: false, haltReasons: [], bankroll: 1, dailyPnl: 0, bookUsable: true, bestBid: bid.price, bestAsk: ask.price,
          indexFresh: true, marketCloseTs: m.closeTime, tickSize: m.tickSize, fees: DEFAULT_FEES, position: curPos, marketRiskNow: 0, marketRiskWith: 0,
          windowRisk: 0, totalRisk: 0, ordersLastMinute: 0, openOrders: 0, modelLiveBlockers: [],
        });
        if (d.ok) {
          const id = `${m.ticker}-${st.now}-${++exitSeq}-exit-${due.kind}`;
          if (due.stop !== undefined) stopByOrder.set(id, due.stop);
          exits.orders++;
          await send(m.ticker, 'order', async () => { try { await ex.createOrder({ ticker: m.ticker, side: due.side, count, price: due.price, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: true, selfTradePrevention: 'taker_at_cross', clientOrderId: id }); } catch { /* no fill */ } });
        }
      };
      await fireExit();

      // Ratchet / hybrid: evaluate the order-book-anchored stop.
      const posNow = pos.position(m.ticker);
      if ((policy === 'liquidity_ratchet' || policy === 'hybrid') && posNow !== 0) {
        let r = ratchets.get(m.ticker);
        if (!r) { r = new LiquidityRatchet(opts.ratchet ?? DEFAULT_RATCHET); ratchets.set(m.ticker, r); }
        const out = r.evaluate({ position: posNow, book, now: st.now, tick: m.tickSize, fees: DEFAULT_FEES, qSide: posNow > 0 ? pYes : 1 - pYes, hybrid: policy === 'hybrid' });
        if (out.event === 'gapped') exits.gaps++;
        if (out.event === 'hybrid_hold') exits.hybridHolds++;
        if (out.plan && !pending.has(m.ticker)) {
          exits.ratchetTriggers++;
          pending.set(m.ticker, { side: out.plan.side, price: out.plan.price, count: out.plan.count, kind: 'rt', stop: out.plan.stop });
        }
      }

      // Confluence ratchet: fair-value exit normally; hunt mode (ratchet exit, no other reductions)
      // only while the contract has beaten its entry fair value AND confluence agrees.
      const sess = sessionState(st.now);
      const sessRisk = sessionRiskFor(opts.sessionRisk ?? {}, sess);
      let huntMode = false;
      if (policy === 'confluence_ratchet') {
        const posH = pos.position(m.ticker);
        let h = hunts.get(m.ticker);
        if (!h) { h = new ConfluenceRatchetExit(opts.hunt ?? DEFAULT_HUNT, opts.ratchet ?? DEFAULT_RATCHET); hunts.set(m.ticker, h); }
        const d = h.update({
          position: posH, qSide: posH >= 0 ? pYes : 1 - pYes, sideBid: posH > 0 ? bid.price : posH < 0 ? 1 - ask.price : undefined,
          confluence: fmap.conf_count, book, now: st.now, tick: m.tickSize, fees: DEFAULT_FEES,
          sessionBlocked: (opts.huntSessionGuard ?? true) ? huntBlockedBySession(sess, opts.huntTransitionBufferMin ?? 10) : undefined,
        });
        huntMode = d.mode === 'hunt';
        if (d.event === 'activated') exits.huntActivations++;
        if (d.event === 'deactivated_giveback') exits.huntDeactivations++;
        if (d.event === 'profit_take_confluence' || d.event === 'profit_take_session' || d.event === 'profit_take_gap') exits.huntProfitTakes++;
        if (d.event === 'gapped') exits.gaps++;
        if (d.plan && !pending.has(m.ticker)) {
          exits.ratchetTriggers++;
          pending.set(m.ticker, { side: d.plan.side, price: d.plan.price, count: d.plan.count, kind: 'rt', stop: d.plan.stop });
        }
      }

      if (inflightFor(m.ticker)) continue; // orders/cancels still travelling: no new plan until they land

      // Relaxed cadence and entry windows, mirroring the engine.
      const mt = kalshiMaintenance(st.now);
      const kindWindow = strategy.cadence === 'relaxed'
        ? inEntryWindow(m.kind, tauSec, strategy.entryWindowUpdown, strategy.entryWindowHourly) && (m.kind === 'updown' || (mid >= strategy.hourlyMidBand[0] && mid <= strategy.hourlyMidBand[1]))
        : true;
      gate?.observe(m.ticker, tauSec, pYes, mid);
      const accuracyBlock = kindWindow && gate ? gate.block(m.ticker, tauSec) : undefined;
      const entryWindowOpen = kindWindow && !accuracyBlock && !mt.inside && mt.minutesTo > 30 && bankroll >= strategy.minTradableBankrollUsd && (opts.killOverride !== false || !guard.paused(st.now));
      const rb = q('bid'), ra = q('ask');
      const through = (r: { price: number } | undefined, best: number) => r !== undefined && Math.abs(best - r.price) >= 2 * strategy.requoteThreshold - 1e-9;
      const posC = pos.position(m.ticker);
      const positionChanged = (lastPos.get(m.ticker) ?? 0) !== posC;
      lastPos.set(m.ticker, posC);
      const reason = cadence.check(m.ticker, { now: st.now, fairValue: pYes, entryWindowOpen, hasResting: Boolean(rb || ra), bookThroughQuote: through(rb, bid.price) || through(ra, ask.price), positionChanged });
      if (reason) res.entryEvaluations++;
      if (reason && accuracyBlock) res.paper!.accuracyBlocks++;
      const pNow = pos.get(m.ticker);
      const entrySide = pNow && pNow.yes > 0 ? -pNow.netCash / pNow.yes : pNow && pNow.yes < 0 ? 1 - pNow.netCash / -pNow.yes : undefined;
      // As the engine (Engine.newRiskRoom): a new order fits the room left under the window and total caps and in the
      // free cash, so near the caps an order shrinks instead of being refused. Paper's cash holds nothing back for
      // resting orders, as the bot reads it.
      let newRiskRoomUsd: number | undefined;
      if (reason) {
        // (Every resting order adds risk: the exchange takes reduce-only on immediate-or-cancel orders only.)
        const restingAll = (await ex.getOpenOrders()).map((o) => ({ ticker: o.ticker, side: o.side, price: o.price, remaining: o.remainingCount, isTaker: false }));
        let windowRisk = 0, totalRisk = 0;
        for (const t of new Set([...pos.unsettled().map((x) => x.ticker), ...restingAll.map((r) => r.ticker)])) {
          const l = marketWorstLoss(pos.get(t), restingAll.filter((r) => r.ticker === t), DEFAULT_FEES);
          totalRisk += l;
          if (closeOf.get(t) === m.closeTime) windowRisk += l;
        }
        newRiskRoomUsd = Math.max(0, Math.min(tierLimits.maxWindowRiskFrac * bankroll - windowRisk, tierLimits.maxTotalRiskFrac * bankroll - totalRisk, await ex.getBalance()));
      }
      const view: MarketView = {
        ticker: m.ticker, pYes, bestBid: bid, bestAsk: ask, position: pos.position(m.ticker), bankroll,
        maxOrderRiskUsd: fixedUsd > 0 ? fixedUsd : tier.orderFrac * bankroll * sessRisk.sizeMult * sizeScale, maxContracts: Math.floor(limits.maxContractsPerOrder * (fixedUsd > 0 ? 1 : sessRisk.sizeMult) * 100) / 100, minSidePrice: limits.minSidePrice,
        ...(fixedUsd > 0 ? { fixedOrderUsd: fixedUsd } : {}),
        ...(() => { const b = tpBenched(); return b ? { takeProfitBenched: b } : {}; })(),
        newRiskRoomUsd,
        tauSec, noEntryBeforeCloseSec: limits.noEntryBeforeCloseSec, fastMove, tickSize: m.tickSize, fees: DEFAULT_FEES,
        restingBid: rb, restingAsk: ra, nowSec: Math.floor(st.now / 1000), closeSec: Math.floor(m.closeTime / 1000),
        pMarket, pStd: pred.std, makerBuffer: (res.makerBufferEnd = makerBuffer()), entrySidePrice: entrySide !== undefined && entrySide > 0 && entrySide < 1 ? entrySide : undefined,
        entryFeePerContract: pNow && Math.abs(pNow.yes) > 1e-9 ? pNow.fees / Math.abs(pNow.yes) : undefined,
        profitPeakSidePrice: peaks.update(m.ticker, posC, posC > 0 ? bid.price : posC < 0 ? Math.round((1 - ask.price) * 1e4) / 1e4 : undefined),
        entryWindowOpen, exitWindowOpen: tauSec > strategy.noExitBeforeCloseSec,
      };
      const strat = { ...stratRun, kellyFraction: tier.kellyFraction * sizeScale, minEdge: strategy.minEdge + sessRisk.minEdgeAdd, inventorySkewPerContract: strategy.inventorySkewPerContract * sessRisk.skewMult };
      const plan = decide(view, strat, {
        exits: policy === 'fair_value' || policy === 'take_profit' || policy === 'hybrid' || (policy === 'confluence_ratchet' && !huntMode),
        blockReductions: huntMode,
        entries: Boolean(reason),
      });
      const qDecision = decisionProbability(view, strat);
      if (strategy.takeGate === 'validated') applyTakeGate(plan, model.params.take, { pYes, features: fmap, tauSec, bid: bid.price, ask: ask.price, pStd: pred.std, margin: strategy.takeMargin });
      // Fill model (validated only), as live: quote, cross or skip each maker entry by expected value.
      applyFillModel(plan, opts.fillModel, { q: qDecision, book, tick: m.tickSize, tauSec, sigma: vol.sigmaPerSqrtSec, features: fmap, minEv: strategy.fillMinEv, takerMinEdge: strategy.takerBuffer + strategy.minEdge });
      // The paper bot's own extra entries (bot/engine.ts), when nothing else enters a flat market in its entry window:
      // an exploration entry (PAPER_EXPLORE: the best borderline one within PAPER_EXPLORE_BAND of the edge threshold, at
      // most 1 contract, at PAPER_EXPLORE_RATE, PAPER_EXPLORE_MAX_PER_HOUR), else a training trade (1 contract at the
      // touch on the side the model favours, PAPER_TRAINING_TRADES_PER_HOUR spread over the hour, one per contract).
      // Only once trading starts: the bot starts with neither (a fresh process), so the warm-up must not use up their budgets.
      if (opts.paper && reason && entryWindowOpen && posC === 0 && !plan.place.some((p) => p.purpose === 'entry') && (opts.tradeFromMs === undefined || st.now >= opts.tradeFromMs)) {
        while (exploreTs.length && exploreTs[0] < st.now - 3_600_000) exploreTs.shift();
        if (strategy.paperExplore) {
          const e = decide(view, { ...strat, minEdge: Math.max(0, strat.minEdge - strategy.exploreBand), style: 'both' }, { exits: false, blockReductions: false, entries: true }).place.find((p) => p.purpose === 'entry');
          if (e && exploreTs.length < strategy.exploreMaxPerHour && exploreRng() < strategy.exploreRate) {
            exploreTs.push(st.now);
            res.paper!.exploreEntries!++;
            plan.place.push({ ...e, count: Math.min(e.count, 1), why: `explore (p=${strategy.exploreRate}): ${e.why}` });
          }
        }
        while (trainTs.length && trainTs[0] < st.now - 3_600_000) trainTs.shift();
        const perHour = strategy.paperTrainTrades;
        if (!plan.place.some((p) => p.purpose === 'entry') && perHour > 0 && !trainTicker.has(m.ticker) && trainTs.length < perHour && st.now - (trainTs[trainTs.length - 1] ?? 0) >= (3_600_000 / perHour) * 0.5) {
          const buyYes = qDecision >= mid;
          const cost = buyYes ? ask.price : Math.round((1 - bid.price) * 10000) / 10000;
          if (cost >= limits.minSidePrice && cost <= 1 - limits.minSidePrice && ask.price - bid.price <= 0.08 && !fastMove && tauSec > limits.noEntryBeforeCloseSec) {
            trainTs.push(st.now);
            trainTicker.add(m.ticker);
            res.paper!.trainTrades!++;
            plan.place.push({ side: buyYes ? 'bid' : 'ask', price: buyYes ? ask.price : bid.price, count: 1, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: false, purpose: 'entry',
              edge: buyYes ? qDecision - ask.price : (1 - qDecision) - cost, why: `train (paper): ${buyYes ? 'YES' : 'NO'} at ${cost.toFixed(2)}` });
          }
        }
      }
      for (const c of plan.cancel) if (!cancelInFlight.has(c.clientOrderId)) await send(m.ticker, 'cancel', () => cancelNow(c.clientOrderId), c.clientOrderId);

      for (const p of plan.place) {
        if (opts.tradeFromMs !== undefined && st.now < opts.tradeFromMs) break;
        if (p.purpose === 'exit') {
          // Queue for next tick, like every other exit (a take-profit keeps its name: its fills feed the bench).
          if (!pending.has(m.ticker)) pending.set(m.ticker, { side: p.side, price: p.price, count: p.count, kind: p.why.startsWith('take-profit') ? 'tp' : 'fv' });
          continue;
        }
        // A taker entry against an existing position is an early exit in disguise
        // (e.g. "buy NO" while long YES). Only policies with fair-value exits may do it,
        // so hold / liquidity_ratchet are compared honestly. Passive maker quotes still
        // unwind at favourable prices under every policy.
        const cur = pos.position(m.ticker);
        if (p.purpose === 'entry' && (policy === 'hold' || policy === 'liquidity_ratchet') && cur !== 0 && Math.sign(cur) !== (p.side === 'bid' ? 1 : -1)) continue;
        const openNow = await ex.getOpenOrders();
        const resting = openNow.map((o) => ({ ticker: o.ticker, side: o.side, price: o.price, remaining: o.remainingCount, isTaker: false }));
        const riskOf = (t: string, extra = [] as typeof resting) => marketWorstLoss(pos.get(t), [...resting.filter((r) => r.ticker === t), ...extra], DEFAULT_FEES);
        const tickers = new Set([...pos.unsettled().map((x) => x.ticker), ...resting.map((r) => r.ticker)]);
        let windowRisk = 0, totalRisk = 0;
        for (const t of tickers) { const l = riskOf(t); totalRisk += l; if (closeOf.get(t) === m.closeTime) windowRisk += l; }
        const intent: OrderIntent = { ticker: m.ticker, asset: m.asset, windowCloseTs: m.closeTime, side: p.side, price: p.price, count: p.count, timeInForce: p.timeInForce, postOnly: p.postOnly, reduceOnly: p.reduceOnly, expirationTime: p.expirationTime, purpose: p.purpose, fairValue: pYes, modelId: model.id, decisionId: 'bt' };
        const d = gateway.check(intent, {
          now: st.now, mode: 'paper', killEngaged: false, haltReasons: [], bankroll, dailyPnl: 0, bookUsable: true,
          bestBid: bid.price, bestAsk: ask.price, indexFresh: true, marketCloseTs: m.closeTime, tickSize: m.tickSize, fees: DEFAULT_FEES,
          position: pos.position(m.ticker), marketRiskNow: riskOf(m.ticker),
          marketRiskWith: p.reduceOnly ? riskOf(m.ticker) : riskOf(m.ticker, [{ ticker: m.ticker, side: p.side, price: p.price, remaining: p.count, isTaker: !p.postOnly }]),
          windowRisk, totalRisk, ordersLastMinute: 0, openOrders: openNow.length, modelLiveBlockers: [], limitOverrides: tierLimits,
          // Paper training trades need no edge (bot/engine.ts): they exist to produce trades.
          skipEdgeCollar: Boolean(opts.paper) && p.why.startsWith('train (paper)'),
        });
        if (!d.ok) {
          // Why the risk gateway turned down the paper bot's extra entries (numbers folded), for the replay check.
          const k = (d.reasons?.[0] ?? 'rejected').replace(/[-+]?\$?\d[\d.,]*%?/g, '#');
          if (/^(train|explore)/.test(p.why)) res.paper!.extraRejected![k] = (res.paper!.extraRejected![k] ?? 0) + 1;
          const seen = `${m.ticker}:${p.side}:${p.purpose}:${k}`;
          if ((opts.tradeFromMs === undefined || st.now >= opts.tradeFromMs) && st.now - (rejectSeen.get(seen) ?? -Infinity) > 60_000) {
            rejectSeen.set(seen, st.now);
            res.paper!.rejected![`${p.purpose}: ${k}`] = (res.paper!.rejected![`${p.purpose}: ${k}`] ?? 0) + 1;
          }
          continue;
        }
        if (/^(train|explore)/.test(p.why)) res.paper!.extraSent = (res.paper!.extraSent ?? 0) + 1;
        const clientOrderId = `${m.ticker}-${st.now}-${p.side}-${p.purpose}${p.why.startsWith('take-profit') ? '-tp' : ''}`;
        await send(m.ticker, 'order', async () => {
          try {
            await ex.createOrder({ ticker: m.ticker, side: p.side, count: p.count, price: p.price, timeInForce: p.timeInForce, postOnly: p.postOnly, reduceOnly: p.reduceOnly, selfTradePrevention: 'taker_at_cross', clientOrderId, expirationTime: p.expirationTime });
          } catch { /* rejected like the exchange would */ }
        });
      }
      if (opts.paper && (opts.tradeFromMs === undefined || st.now >= opts.tradeFromMs)) await fireExit();
    }
  }
  exits.avgSlippage = slipN ? slipSum / slipN : null;
  res.days = Math.max(1 / 24, (st.now - firstTs) / 86_400_000);
  res.vaultEnd = vault?.vaultTotal ?? 0;
  res.pocketEnd = vault?.pocketTotal ?? 0;
  return res;
}

export interface HuntEvaluation {
  baseline: 'fair_value';
  hunt: { targetMargin: number; minConfluence: number; minFillRatio: number; minWallAgeMs: number; slippageTicks: number };
  windows: number;
  pnlHunt: number;
  pnlBaseline: number;
  pairedDiffMean: number;
  pairedDiffCiLo: number;
  pairedDiffCiHi: number;
  /** Deflated for the number of hunt variants tried (the best of the grid is reported). */
  dsrProbability: number;
  activations: number;
  profitTakes: number;
  exitRegret: number;
  variants: number;
  /** Hunt mode may be used live (and its parameters applied) only when true. */
  huntOk: boolean;
}

/** Paired comparison: best hunt variant vs the fair-value exit on identical windows. */
export function evaluateHunt(results: BacktestResult[], allWindows: number[], minEdge: number): HuntEvaluation | undefined {
  const base = results.find((r) => r.exitPolicy === 'fair_value' && r.minEdge === minEdge);
  const hunts = results.filter((r) => r.exitPolicy === 'confluence_ratchet' && r.minEdge === minEdge && r.huntParams);
  if (!base || !hunts.length) return undefined;
  const top = hunts.reduce((a, b) => (b.pnl > a.pnl ? b : a));
  const ws = allWindows.filter((w) => (base.windows.get(w)?.contracts ?? 0) > 0 || (top.windows.get(w)?.contracts ?? 0) > 0);
  const diffs = ws.map((w) => (top.windows.get(w)?.pnl ?? 0) - (base.windows.get(w)?.pnl ?? 0));
  const ci = bootstrapMeanCi(diffs);
  const dsr = diffs.length > 2 ? deflatedSharpe(diffs, hunts.length) : { probability: NaN };
  const hp = top.huntParams!;
  return {
    baseline: 'fair_value',
    hunt: { targetMargin: hp.hunt.targetMargin, minConfluence: hp.hunt.minConfluence, minFillRatio: hp.ratchet.minFillRatio, minWallAgeMs: hp.ratchet.minWallAgeMs, slippageTicks: hp.ratchet.slippageTicks },
    windows: diffs.length, pnlHunt: top.pnl, pnlBaseline: base.pnl,
    pairedDiffMean: ci.mean, pairedDiffCiLo: ci.lo, pairedDiffCiHi: ci.hi, dsrProbability: dsr.probability,
    activations: top.exits.huntActivations, profitTakes: top.exits.huntProfitTakes, exitRegret: top.exits.regret, variants: hunts.length,
    huntOk: diffs.length >= 300 && ci.lo > 0 && dsr.probability > 0.95,
  };
}

export async function backtestMain(argOf: (k: string, d: string) => string = cliArg, annotate: boolean = process.argv.includes('--annotate')) {
  const dir = argOf('recordings', 'data/recordings');
  const modelPath = argOf('model', 'params/model.json');
  const model = fs.existsSync(modelPath) ? MetaModel.load(modelPath) : MetaModel.identity();
  const cfg = loadConfig(paperEnv(process.env));
  const grid = argOf('grid', String(cfg.strategy.minEdge)).split(',').map(Number);
  const bankroll = Number(argOf('bankroll', String(cfg.paperBankrollUsd)));
  const priorTrials = Number(argOf('trials', String((model.params.validation?.variantsTried ?? 1))));
  const policies = argOf('exits', EXIT_POLICIES.join(',')).split(',') as ExitPolicyName[];
  for (const p of policies) if (!EXIT_POLICIES.includes(p)) throw new Error(`unknown exit policy ${p}`);
  const ratchet: RatchetParams = {
    minFillRatio: Number(argOf('ratchet-fill', String(DEFAULT_RATCHET.minFillRatio))),
    minWallAgeMs: Number(argOf('ratchet-age', String(DEFAULT_RATCHET.minWallAgeMs / 1000))) * 1000,
    slippageTicks: Number(argOf('ratchet-slip', String(DEFAULT_RATCHET.slippageTicks))),
  };
  const hunt: HuntParams = {
    targetMargin: Number(argOf('hunt-margin', String(DEFAULT_HUNT.targetMargin))),
    minConfluence: Number(argOf('hunt-confluence', String(DEFAULT_HUNT.minConfluence))),
  };
  // Hunt mode is evaluated over a parameter grid (target margin x wall fill ratio); every variant
  // counts toward the Deflated Sharpe.
  const huntMargins = argOf('hunt-grid', policies.includes('confluence_ratchet') ? '0.01,0.02,0.04' : String(hunt.targetMargin)).split(',').map(Number);
  const huntFills = argOf('ratchet-fill-grid', policies.includes('confluence_ratchet') ? '1,2' : String(ratchet.minFillRatio)).split(',').map(Number);
  // Price with the seasonal volatility profile when given (mirror production).
  const vpPath = argOf('vol-profile', '');
  const volProfile = vpPath ? loadVolProfile(vpPath) : undefined;
  // Tree vol forecast / fill model, as production applies them (each only when validated).
  const vmPath = argOf('vol-model', '');
  const volModel = vmPath ? VolModel.load(vmPath) : undefined;
  const fmPath = argOf('fill-model', '');
  const fillModel = fmPath ? FillModel.load(fmPath) : undefined;
  const calendar = loadCalendar(argOf('calendar', 'params/calendar.json'));
  // Execution latency (ms): --latency-ms 250 [--cancel-latency-ms 150] [--latency-jitter-ms 100]. Default: none.
  const latency: BacktestLatency | undefined = Number(argOf('latency-ms', '0')) > 0 || Number(argOf('latency-jitter-ms', '0')) > 0
    ? { orderMs: Number(argOf('latency-ms', '0')), cancelMs: argOf('cancel-latency-ms', '') ? Number(argOf('cancel-latency-ms', '0')) : undefined, jitterMs: Number(argOf('latency-jitter-ms', '0')) }
    : undefined;

  const results: BacktestResult[] = [];
  for (const minEdge of grid) {
    for (const exitPolicy of policies) {
      const combos = exitPolicy === 'confluence_ratchet'
        ? huntMargins.flatMap((m) => huntFills.map((f) => ({ hunt: { ...hunt, targetMargin: m }, ratchet: { ...ratchet, minFillRatio: f } })))
        : [{ hunt, ratchet }];
      for (const c of combos) {
        results.push(await runBacktest(dir, model, { ...cfg.strategy, minEdge }, cfg.risk, bankroll, {
          exitPolicy, ratchet: c.ratchet, hunt: c.hunt, volProfile, applyVolSeasonality: Boolean(volProfile), volModel, fillModel,
          sessionRisk: cfg.strategy.sessionRisk, huntSessionGuard: cfg.strategy.huntSessionGuard, huntTransitionBufferMin: cfg.strategy.huntTransitionBufferMin,
          vault: cfg.vault.enabled ? cfg.vault : undefined, calendar, sizingTiers: cfg.sizingTiers, latency,
        }));
      }
    }
  }
  const variants = results.length;
  const allWindows = [...new Set(results.flatMap((r) => [...r.windows.keys()]))].sort((a, b) => a - b);

  const summaries = results.map((r) => {
    const traded = [...r.windows.values()].filter((w) => w.contracts > 0);
    const perContract = traded.map((w) => w.pnl / w.contracts);
    const ci = bootstrapMeanCi(perContract);
    const series = allWindows.map((w) => r.windows.get(w)?.pnl ?? 0);
    const dsr = deflatedSharpe(series, priorTrials * variants);
    const perTrade = bootstrapMeanCi(r.trades.map((t) => t.pnl));
    return {
      exit: r.label, minEdge: r.minEdge, vault: +r.vaultEnd.toFixed(2), pocket: +r.pocketEnd.toFixed(2), windowsTraded: traded.length, fills: r.fills, contracts: r.contracts, fees: +r.fees.toFixed(2), pnl: +r.pnl.toFixed(2),
      trades: r.trades.length, tradesPerDay: +(r.trades.length / r.days).toFixed(1), pnlPerTrade: perTrade.mean, pnlPerTradeCiLo: perTrade.lo, pnlPerDay: +(r.pnl / r.days).toFixed(2), tpFills: r.takeProfitFills, latencyMs: r.latency?.orderMs ?? 0, cancelRaceFills: r.latency?.cancelRaceFills ?? 0,
      edgePerContract: ci.mean, edgeCiLo: ci.lo, edgeCiHi: ci.hi, sharpePerWindow: sharpe(series), deflatedExcess: dsr.excess, dsrProb: dsr.probability,
    };
  });
  console.table(summaries);
  console.log('Relaxed-spec target: $1-$10 average profit per trade at this bankroll, 10-25 trades/day; $100/day is a monthly average.');
  console.log('exit diagnostics (regret > 0 means exiting cost money vs holding to settlement):');
  console.table(results.map((r) => ({
    exit: r.label, minEdge: r.minEdge, exitOrders: r.exits.orders, exitFills: r.exits.fills, contracts: +r.exits.contracts.toFixed(2),
    proceeds: +r.exits.proceeds.toFixed(2), regret: +r.exits.regret.toFixed(2), stoppedWinners: r.exits.stoppedWinners,
    ratchetTriggers: r.exits.ratchetTriggers, gaps: r.exits.gaps, hybridHolds: r.exits.hybridHolds,
    huntOn: r.exits.huntActivations, huntOff: r.exits.huntDeactivations, huntTakes: r.exits.huntProfitTakes,
    avgSlippage: r.exits.avgSlippage === null ? null : +r.exits.avgSlippage.toFixed(4),
  })));
  console.log('P&L by session at window open (fee-inclusive):');
  console.table(results.flatMap((r) => Object.entries(r.bySession).map(([session, b]) => ({
    exit: r.exitPolicy, minEdge: r.minEdge, session, windows: b.windows, contracts: +b.contracts.toFixed(2), fees: +b.fees.toFixed(2),
    pnl: +b.pnl.toFixed(2), perContract: b.contracts ? +(b.pnl / b.contracts).toFixed(4) : null,
  }))));
  let pboValue: number | undefined;
  if (results.length > 1) {
    const matrix = allWindows.map((w) => results.map((r) => r.windows.get(w)?.pnl ?? 0));
    const pb = pbo(matrix, Math.min(16, Math.max(2, Math.floor(allWindows.length / 20) * 2)));
    console.log('PBO (CSCV):', pb);
    if (Number.isFinite(pb.pbo)) pboValue = pb.pbo;
  }
  // The model annotation uses the production exit policy at the configured minEdge.
  const prod = cfg.strategy.exitPolicy === 'confluence_ratchet' ? 'fair_value' : cfg.strategy.exitPolicy;
  const best = summaries.find((s) => s.minEdge === cfg.strategy.minEdge && s.exit === prod) ?? summaries[0];
  const exitEvaluation = evaluateHunt(results, allWindows, cfg.strategy.minEdge);
  if (exitEvaluation) console.log('hunt mode vs fair-value exit (paired per window):', exitEvaluation);
  console.log(`windows traded: ${best.windowsTraded} (need >= 1000 independent windows before trusting any edge)`);

  if (annotate && fs.existsSync(modelPath)) {
    const params = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    params.validation = {
      ...params.validation,
      netEdgeCiLow: best.edgeCiLo,
      deflatedSharpe: best.deflatedExcess,
      dsrProbability: best.dsrProb,
      ...(pboValue !== undefined ? { pbo: pboValue } : {}),
      variantsTried: priorTrials * variants,
      backtestWindowsTraded: best.windowsTraded,
      backtestPnlPerTrade: best.pnlPerTrade,
      backtestTradesPerDay: best.tradesPerDay,
      ...(exitEvaluation ? { exitEvaluation } : {}),
    };
    params.validation.passed = Boolean(params.validation.passed) && best.edgeCiLo > 0 && best.deflatedExcess > 0 && best.dsrProb > 0.95
      && (pboValue === undefined || pboValue < 0.2) && best.windowsTraded >= 1000;
    fs.writeFileSync(modelPath, JSON.stringify(params, null, 2) + '\n');
    console.log(`annotated ${modelPath}: passed=${params.validation.passed}`);
  }
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void backtestMain();

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

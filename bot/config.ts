// Configuration is read once from the environment at startup, validated, and
// frozen. Nothing at runtime (API, LLM, learner) can change it. Changing a
// parameter means a reviewed commit and a redeploy.

import fs from 'fs';
import { parseSessionRisk, type SessionRiskProfile } from './model/sessionRisk';
import { defaultTiers, validateTiers, type TierPoint } from './risk/sizingTiers';
import type { VaultConfig } from './vault/vault';
import path from 'path';

export type TradingMode = 'paper' | 'shadow' | 'live';
export type KalshiEnv = 'demo' | 'prod';
export type StrategyStyle = 'maker' | 'taker' | 'both';

export interface RiskLimits {
  /** Max contracts in a single order. */
  maxContractsPerOrder: number;
  /** Max fraction of bankroll at risk (premium) in one order. */
  maxOrderRiskFrac: number;
  /** Max fraction of bankroll at risk across all correlated crypto markets closing in the same window. */
  maxWindowRiskFrac: number;
  /** Max fraction of bankroll at risk across all open positions and resting orders. */
  maxTotalRiskFrac: number;
  /** Daily loss (realized + mark-to-market, fee-inclusive) that trips the kill switch. */
  dailyLossLimitFrac: number;
  /** Absolute daily loss cap in dollars (whichever of frac/abs is tighter applies). */
  dailyLossLimitUsd: number;
  /** Refuse to buy a side priced below this (favourite-longshot bias) or above 1 - this. */
  minSidePrice: number;
  /** Max new orders per rolling minute. */
  maxOrdersPerMinute: number;
  /** Max simultaneously resting orders. */
  maxOpenOrders: number;
  /** Market data older than this blocks new orders. */
  maxBookAgeMs: number;
  maxIndexAgeMs: number;
  /** No new entries this close to market close. */
  noEntryBeforeCloseSec: number;
  /** Consecutive order-path errors that trip the kill switch. */
  maxConsecutiveOrderErrors: number;
}

export interface StrategyConfig {
  style: StrategyStyle;
  /** Series to trade, e.g. KXBTC15M (with seriesAuto: the fallback list). */
  series: string[];
  /** Series that are recorded (books, trades, lifecycle, results) for research but never priced or traded (RECORD_SERIES). */
  recordSeries: string[];
  /** Cap on simultaneously tracked record-only markets. */
  recordMaxMarkets: number;
  /** Discover every priceable crypto 15-minute / hourly series from the exchange (STRATEGY_SERIES=auto). */
  seriesAuto: boolean;
  /** Fractional Kelly multiplier (0.1–0.25 recommended). */
  kellyFraction: number;
  /** Portfolio numerical Kelly cap on new binary orders (reduce-only), and its shrink (0.25-0.5). */
  portfolioKelly: boolean;
  portfolioKellyShrink: number;
  /** Required edge beyond fees, in probability points, before quoting/taking. */
  minEdge: number;
  /** Additional buffer for taker entries on top of the taker fee. */
  takerBuffer: number;
  /** Inventory skew per contract held, in probability points. */
  inventorySkewPerContract: number;
  /** Minimum change in desired quote (dollars) before replacing a resting order. */
  requoteThreshold: number;
  /** Pull quotes if |index move| over `fastMoveWindowSec` exceeds this many sigmas. */
  fastMoveSigmas: number;
  fastMoveWindowSec: number;
  /** Resting orders expire on the exchange after this many seconds (dead-man switch). */
  orderTtlSec: number;
  /** Exit mode. hold = Mode A (ride to settlement, no exit fee); fair_value = model exit only;
   * take_profit = Mode B (resting maker take-profit + model exit); confluence_ratchet = hunt winners. */
  exitPolicy: 'hold' | 'fair_value' | 'take_profit' | 'confluence_ratchet';
  /** Model exit: sell at the bid when bid - taker fee > q_adj + exitMargin. */
  exitMargin: number;
  /** Mode B take-profit distance above the entry price (dollars per contract). */
  takeProfit: number;
  /** relaxed = decide on each 1-minute bar close or on a trigger (spec cadence); continuous = every tick. */
  cadence: 'relaxed' | 'continuous';
  /** Scheduled evaluation period, fair-value move that triggers an evaluation, re-price period, and the floor between evaluations. */
  evalBarSec: number;
  evalFvMove: number;
  repriceSec: number;
  minEvalIntervalSec: number;
  /** Entry windows [earliest, latest] seconds before close, per contract kind. */
  entryWindowUpdown: [number, number];
  entryWindowHourly: [number, number];
  /** Hourly strikes are only entered while the market mid is inside this band. */
  hourlyMidBand: [number, number];
  /** No exits in the final seconds: positions ride to settlement (spreads widen inside the averaging window). */
  noExitBeforeCloseSec: number;
  /** Maker adverse-selection buffer: default, and clamp range when estimated from 60 s markouts. */
  makerBuffer: number;
  makerBufferRange: [number, number];
  /** kelly = fractional Kelly on the model probability; target_ev = spec sizing (shrink to market, $ target, min EV). */
  sizing: 'kelly' | 'target_ev';
  kappa: number;
  /** Per-trade $ target: min(targetEvUsd, targetEvOfRisk x the per-order risk budget), so the
   * target never caps size below what the tier's risk limit allows. */
  targetEvUsd: number;
  targetEvOfRisk: number;
  /** Per-trade $ minimum EV: min(minTradeEvUsd, minTradeEvFrac x bankroll). */
  minTradeEvUsd: number;
  minTradeEvFrac: number;
  /** Hard floor: below this tradable bankroll no new risk is taken (exits still run). */
  minTradableBankrollUsd: number;
  /** Veto entries when |q - p_mkt| < this many ensemble standard deviations. */
  ensembleVetoSigmas: number;
  /** Scale Kelly by max(0, 1 - drawdown / ddScaleAt); pause entries 24 h after a 7-day loss beyond weeklyLossPause. */
  ddScaleAt: number;
  weeklyLossPause: number;
  /** Halt new risk when the rolling log-loss advantage vs the calibrated market is significantly negative. */
  modelHealthHalt: boolean;
  modelHealthMinWindows: number;
  huntTargetMargin: number;
  huntMinConfluence: number;
  ratchetMinFillRatio: number;
  ratchetMinWallAgeSec: number;
  ratchetSlippageTicks: number;
  /** Per-session risk multipliers (can only reduce risk). */
  sessionRisk: SessionRiskProfile;
  /** Block hunt mode in twilight/weekend liquidity and near session changes. */
  huntSessionGuard: boolean;
  huntTransitionBufferMin: number;
  /** Apply a fitted, validated intraday volatility profile to fair value. */
  volSeasonality: boolean;
  volProfilePath: string;
  /** Tree-based volatility forecast (research:vol-train): applied to fair value once validated. */
  volModel: boolean;
  volModelPath: string;
  /** Fill / adverse-selection model (research:fill-train): brings itself online once validated. */
  fillModelPath: string;
  /** Maker quotes need expected value (P(fill) x (edge - expected markout)) of at least this per contract. */
  fillMinEv: number;
  /** MLP take/skip head: 'validated' gates entries once its held-out check passed; 'off' never. */
  takeGate: 'validated' | 'off';
  /** Extra P(win) required above a trade's break-even (price + fee). */
  takeMargin: number;
}

export interface Config {
  mode: TradingMode;
  kalshiEnv: KalshiEnv;
  restBaseUrl: string;
  wsUrl: string;
  kalshiKeyId?: string;
  kalshiPrivateKeyPath?: string;
  kalshiSubaccount?: number;
  /** Balance precision for fee rounding: 0.01 for non-direct (FCM-cleared) members, 0.0001 for direct members. */
  kalshiBalancePrecision: number;
  /** LIVE_ALLOW_UNVALIDATED_MODEL=true: trade binary contracts live even when the model failed validation
   *  (the operator accepts the risk; every other limit still applies). */
  liveAllowUnvalidated: boolean;
  host: string;
  port: number;
  /** DASHBOARD_PASSWORD: '' (default) = the dashboard opens without a login. */
  dashboardPassword: string;
  dataDir: string;
  paramsPath: string;
  paperBankrollUsd: number;
  /** Map of Kalshi CF Benchmarks index id -> asset symbol (BTC, ETH...). */
  indexIdMap: Record<string, string>;
  /** Map of series ticker -> asset symbol. */
  seriesAssetMap: Record<string, string>;
  /** Ignore markets closing further out than this (daily/weekly strikes of hourly series). */
  catalogHorizonMin: number;
  /** Strike ladders and range brackets: track only the N strikes nearest the price in each event (0 = all).
   *  Far strikes sit at 1c / 99c and are never traded; tracking them only costs CPU. */
  catalogStrikesPerEvent: number;
  /** Allow using the Coinbase public ticker as an index proxy (basis risk; paper/shadow only). */
  allowProxyIndex: boolean;
  /** Stream Coinbase spot for lead-lag features and the dashboard (never a pricing input). */
  spotFeed: boolean;
  /** Track USDT.D / BTC.D (Binance prices anchored to CoinGecko) as feature inputs. */
  dominanceFeed: boolean;
  /** Poll Coinbase spot candles (1m..1d) for the TA library (features, dashboard, research). */
  taCandles: boolean;
  /** Clock-skew guard: halt new risk when the local clock is confidently off Kalshi's by more than this (ms); 0 disables. */
  clockSkewMaxMs: number;
  /** Session edges (first/last N minutes of the Asia, London and New York sessions): no new entries there
   *  (noEntry) and, with AUTO_TRAIN=windows, the only time the training pipeline runs. */
  sessionEdge: { minutes: number; noEntry: boolean };
  clockSkewWarnMs: number;
  /** Settlement average: official = sixty one-per-second RTI values; continuous = time-weighted step average. */
  settlementAvg: 'official' | 'continuous';
  /** Output of `npm run research:ta` (measured hit rates per rule), shown with live signals. */
  taStudyPath: string;
  coinbaseRestUrl: string;
  /** Coinbase public trade feed (taker order flow for the candles) and its URL. */
  takerFlow: boolean;
  coinbaseWsUrl: string;
  binanceWsUrl: string;
  coingeckoUrl: string;
  coingeckoApiKey?: string;
  reconcileIntervalMs: number;
  heartbeatTimeoutMs: number;
  alertTelegramToken?: string;
  alertTelegramChatId?: string;
  alertWebhookUrl?: string;
  risk: RiskLimits;
  strategy: StrategyConfig;
  /** Profit vault / pocket rules (bookkeeping: reserved cash is not traded). */
  vault: VaultConfig;
  /** Bankroll-scaled risk ladder ($20 aggressive -> $50 moderate -> $100 normal); see risk/sizingTiers.ts. */
  sizingTiers: TierPoint[];
  /** Kalshi perpetuals: market data as features (stage 1) and delta-hedging the binary book (stage 2). */
  perps: PerpsConfig;
  /** ATP tennis match-winner markets (bot/tennis). */
  tennis: TennisConfig;
  /** Cortex-like spiking network (bot/snn): shadow by default, blended only with an earned alpha. */
  snn: SnnConfig;
  /** Automated training pipeline (research/pipeline.ts) and model hot-swapping. */
  autoTrain: AutoTrainConfig;
  /** TA network (bot/ta/taNet.ts) and the historical candle store it trains on (research/history). */
  taNet: TaNetConfig;
}

export interface TaNetConfig {
  /** Compute the TA network's forecasts as features (they are only used by models that validated them). */
  enabled: boolean;
  modelPath: string;
  /** Only heads that beat the naive forecast in the blind walk-forward test speak (default true). */
  requireValidated: boolean;
  /** Historical candles (data/history/<source>/<ASSET>/<tf>.csv). */
  historyDir: string;
  /** Pipeline: refresh history from Binance Vision + Coinbase before training (needs internet). */
  historyUpdate: boolean;
  /** Fill history holes and keep the TradingView index series (BTC.D, USDT.D, TOTAL3, OTHERS.D, RTY) with tvdatafeed (TV_FILL). */
  tvFill: boolean;
  /** Assets to collect: "auto" = every crypto asset Kalshi lists (binary series + perps), or a list. */
  historyAssets: string;
  /** Binance intervals to download, and Coinbase timeframes to backfill. */
  binanceIntervals: string[];
  coinbaseTfs: string[];
  /** Retrain the network at most every N days (and whenever it is missing). */
  retrainEveryDays: number;
  /** Network layout trained by the pipeline: flat, or grouped (indicator families; TA_NET_ARCH). */
  arch: 'flat' | 'grouped';
  /** Population tournament: rolling training block, evaluation window, untouched holdout (months). */
  trainMonths: number;
  evalMonths: number;
  /** How far each round rolls forward (months). */
  stepMonths: number;
  holdoutMonths: number;
  /** Frozen final window after the holdout (months, 0 = none): every head must also hold up there. */
  finalMonths: number;
  /** Train on every k-th hourly sample per epoch (adjacent hours are highly correlated). */
  stride: number;
  /** Statistical hurdles: independent interactions per regime, deflated Sharpe probability. */
  minPerRegime: number;
  dsrThreshold: number;
  /** Live forward test of the elite's position rule: days, and whether a failure mutes the direction heads. */
  forwardDays: number;
  muteOnForwardFail: boolean;
  /** Tournament rounds per pipeline run (0 = all): the initialisation is spread over daily runs. */
  maxRoundsPerRun: number;
  /** Exploration member: every N rounds the worst network restarts from scratch (0 = never). */
  restartEvery: number;
}

export interface AutoTrainConfig {
  /** off | daily (once a day at hourUtc) | windows (once a day, only inside session-edge windows, paused
   *  outside them: training never runs while the bot trades). */
  mode: 'off' | 'daily' | 'windows';
  hourUtc: number;
  /** Where the pipeline writes promoted models; the bot prefers these over params/ and hot-swaps them. */
  dir: string;
  recordingsDir: string;
  /** Gzip recorded days older than this many days (0 = never); readers handle both forms. */
  recordingsGzipAfterDays: number;
  /** Alert when free disk space where the recordings live drops below this (GB). */
  recordingsMinFreeGb: number;
  /** always = promote every freshly trained model (hot-swap mode); validated = only models whose
   *  validation passed (MLP: validation.passed; perps: validated(); SNN: its stage accepted). */
  promote: 'always' | 'validated';
  /** auto = highest stage whose whole chain S1..Sk the ablation accepted (else SNN_STAGE). */
  snnStage: 'auto' | 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6';
  ablationDays: number;
  ablationEveryDays: number;
  snnTrainDays: number;
  /** Re-run the SNN steps automatically whenever the meta-model changes (e.g. a manual swap). */
  onModelChange: boolean;
  /** Sweep optimizer (research/sweep.ts): targets run by the pipeline, hours per target, and how often. */
  sweepTargets: string[];
  sweepHours: number;
  /** Time budget per run for the TA network's walk-forward export (it resumes on the next run). */
  taNetOosHours: number;
  sweepEveryDays: number;
  /** Minimum days of recordings before anything is trained. */
  minDays: number;
  /** Poll interval for model-file changes (hot reload). */
  watchSec: number;
  /** SNN population tournaments (crypto, perps): recorded days replayed, initial training block,
   *  rounds per pipeline run (0 = all), and how often the tournament is re-run (0 = only at init). */
  snnPbtDays: number;
  snnPbtInitDays: number;
  snnPbtMaxRounds: number;
  snnPbtEveryDays: number;
  /** Exploration member: every N tournament rounds the worst SNN restarts from scratch with random
   *  knobs instead of copying the elite (0 = never). */
  snnPbtRestartEvery: number;
}

export interface SnnConfig {
  /** off | shadow (score, label, log; never trades) | blend (p_final = (1 - alpha c) p_model + alpha c p_snn). */
  mode: 'off' | 'shadow' | 'blend';
  /** Staging: S0..S6, each stage adds one mechanism (S6 = online plasticity). */
  stage: 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6';
  /** Whitelisted columns (asset-horizon keys such as BTC-15m); empty = first maxColumns seen. */
  columns: string[];
  maxColumns: number;
  checkpointDir: string;
  checkpointEveryMin: number;
  worker: boolean;
  timeoutMs: number;
  latencySkipP99Ms: number;
  alphaMax: number;
  minEvents: number;
  readoutEta: number;
  seed: number;
  /** Conservative-only dynamic target scaling (hunt take-profit distance), one step per 15 min. */
  targetScaling: boolean;
  deferred: { wilsonCowan: boolean; gapJunctions: boolean; izhikevichCH: boolean; dcaap: boolean };
  /** Tennis: run three networks live and keep the fittest (population-based training). */
  tennisPopulation: boolean;
  /** Graded matches between live tournament rounds. */
  tennisPopulationSettles: number;
  /** Three isolated SNNs (crypto contracts, perps, tennis): on/off, stage and model file each. */
  domains: Record<'crypto' | 'perps' | 'tennis', { enabled: boolean; stage: SnnConfig['stage']; modelPath: string }>;
  /** Let a decision model read ANOTHER domain's SNN outputs (e.g. the crypto MLP reading the perps
   *  SNN's 4h call). The SNNs themselves never read each other either way. Off by default. */
  crossFeed: boolean;
}

export interface TennisConfig {
  /** Track and (in paper/shadow) trade ATP match markets. */
  enabled: boolean;
  /** Real-money tennis orders additionally need this explicit opt-in in live mode. */
  live: boolean;
  series: string[];
  /** Ignore matches closing further out than this. */
  horizonHours: number;
  /** Hard cap: worst-case loss of all tennis positions + resting orders <= this fraction of the working cash pool. */
  maxTotalFrac: number;
  /** Per match and per order caps (fractions of the working cash pool). */
  maxMatchFrac: number;
  orderFrac: number;
  /** Underdog rule. */
  underdogMax: number;
  underdogMin: number;
  preStartMin: number;
  entryWindowMin: number;
  maxSpread: number;
  takeProfitCents: number;
  takeProfitPct: number;
  /** Optional stop on the underdog trade (0 = off: hold to settlement if the take-profit never fills). */
  underdogStopCents: number;
  /** Favorite re-entry after the match is at least half done. */
  favMin: number;
  favMax: number;
  favMinProgress: number;
  favStableCents: number;
  favStopCents: number;
  /** Match progress (bot/tennis/tennisModel.ts): a point -> game -> set -> match model (deuce,
   * tiebreaks, 10-point final-set tiebreak at the Slams, best of 3/5) calibrated to the pre-match
   * price gives the expected number of points; minutes are converted at secPerPoint (incl.
   * changeovers). Blended with the information clock (share of the match's price uncertainty
   * already resolved, sampled every qvSampleSec) at progressInfoWeight. serveBase: tour-average
   * serve-point win rate. A live score (scoreFeed) replaces both when available. */
  secPerPoint: number;
  serveBase: number;
  progressInfoWeight: number;
  qvSampleSec: number;
  scoreFeed: 'off' | 'kalshi' | 'livetennis';
  /** livetennis: refresh a match's score when its price moved this much since the last score, or after this many minutes. */
  scoreIdleMin: number;
  scorePollSec: number;
  /** In-play detection from price action when no start time is published: a mid move of this size within 3 minutes. */
  liveMoveCents: number;
  /** Order-book ratcheting trailing stop from the target price (both legs) instead of a fixed take-profit. */
  trail: boolean;
  /** Favorite leg: the trail arms at min(favTrailCap, entry + favTrailCents). */
  favTrailCents: number;
  favTrailCap: number;
  /** Walls: bid levels >= trailMinFillRatio x position, persisting trailMinWallAgeSec; exit limit stop - slippage ticks. */
  trailMinFillRatio: number;
  trailMinWallAgeSec: number;
  trailSlippageTicks: number;
  /** Conservative price hunt past the target: continue only while >= huntMinSignals of the tennis
   * confluence signals agree, for at most huntMaxSec, trailing huntTrailTicks under the peak bid. */
  huntMinSignals: number;
  huntMaxSec: number;
  huntTrailTicks: number;
  /** Tennis confluence thresholds (over confWindowSec): our mid up, taker flow, top-3 depth imbalance, opponent mid down. */
  confWindowSec: number;
  confMomentumCents: number;
  confFlow: number;
  confDepth: number;
  confOpponentCents: number;
  /** Signals required to ENTER: underdog before the start / once live; favorite re-entry. */
  entryMinSignalsPre: number;
  entryMinSignalsLive: number;
  favEntryMinSignals: number;
  /** Early is what matters for underdogs: full size before the start and for the first earlyFullSizeMin
   * minutes, tapering to half size by the end of the entry window. */
  earlyFullSizeMin: number;
  /** Underdog positions age badly: from this match progress take any exit in profit; from the cut
   * progress sell at the bid regardless (0 = off). */
  underdogLateProgress: number;
  underdogCutProgress: number;
  /** Tennis MLP (fair P(win) from the 4 signals, score, book and SNN): when validated, entries need
   *  fair - price >= this. */
  fairMinEdge: number;
  /** Tennis MLP file (research:tennis-train). */
  modelPath: string;
}

export interface PerpsConfig {
  /** Poll public perp market data (premium, funding, OI) for features and the hedger. */
  feed: boolean;
  restUrl: string;
  pollMs: number;
  /** Separate perps API credentials (the perps exchange has its own keys). */
  keyId?: string;
  privateKeyPath?: string;
  subaccount?: number;
  /** off | paper (simulate hedges against live perp quotes) | live (real perp orders; needs TRADING_MODE=live). */
  hedge: 'off' | 'paper' | 'live';
  minDollarDelta: number;
  maxNotionalUsd: number;
  excludeTauSec: number;
  repriceSec: number;
  takerAfterSec: number;
  makerFeeBps: number;
  takerFeeBps: number;
  /** Stage 3 directional trading: off | paper (simulated against live perp quotes) | live (real orders). */
  trading: 'off' | 'paper' | 'live';
  /** Frozen perp signal model (research:perp-train); without it the momentum prior trades at pilot size. */
  modelPath: string;
  /** Paper margin balance for the simulated perps account. */
  paperBalanceUsd: number;
  horizonMin: number;
  entryEdgeBps: number;
  exitEdgeBps: number;
  kellyFraction: number;
  maxLeverage: number;
  maxTradeNotionalUsd: number;
  maxTotalNotionalUsd: number;
  stopAtrMult: number;
  minStopBps: number;
  maxHoldMin: number;
  dailyLossFrac: number;
  cooldownMin: number;
  pilotMaxNotionalUsd: number;
  pilotMaxLeverage: number;
  priorIc: number;
  requireValidation: boolean;
  minEquityUsd: number;
  maxOrderNotionalUsd: number;
  collarBps: number;
  /** Directional strategy: setups = the fast / slow lane setup trader (bot/setups), signal = the
   *  horizon-return signal (PerpTrader). */
  strategy: 'signal' | 'setups';
  /** Setup scorer (research:setups). */
  setupModelPath: string;
  /** The TA network the setup trader reads (its walk-forward network: research/taNetOos.ts). */
  setupTaNetPath: string;
  /** Equity at risk per trade (entry to stop) in the fast / slow lane. */
  setupFastRisk: number;
  setupSlowRisk: number;
  setupFastMax: number;
  setupSlowMax: number;
  /** Total and per-asset notional caps as multiples of equity. */
  setupMaxLeverage: number;
  setupMaxAssetLeverage: number;
  /** Daily profit goal shown on the dashboard (it does not change how the bot trades). */
  setupDailyGoalUsd: number;
  /** Retrain the setup scorer every this many days (automated pipeline). */
  setupRetrainDays: number;
  /** Fixed dollars at risk per trade per lane (0 = use SETUP_*_RISK as a share of equity). */
  setupFastRiskUsd: number;
  setupSlowRiskUsd: number;
  /** Skip trades whose first target pays less than this after fees (0 = off). */
  setupMinTargetUsd: number;
}

export class ConfigError extends Error {}

const DEFAULT_SERIES_ASSET: Record<string, string> = {
  KXBTC15M: 'BTC',
  KXETH15M: 'ETH',
  KXSOL15M: 'SOL',
  KXXRP15M: 'XRP',
  KXDOGE15M: 'DOGE',
  // Hourly: greater-than ladders (KX*D) and range brackets.
  KXBTCD: 'BTC',
  KXETHD: 'ETH',
  KXSOLD: 'SOL',
  KXBTC: 'BTC',
  KXETH: 'ETH',
};

// Kalshi streams CF Benchmarks real-time indices; ids verified only for BRTI.
// Override with INDEX_ID_MAP if the channel reports different identifiers.
const DEFAULT_INDEX_IDS: Record<string, string> = {
  BRTI: 'BTC',
  ETHUSD_RTI: 'ETH',
  SOLUSD_RTI: 'SOL',
  XRPUSD_RTI: 'XRP',
  DOGEUSD_RTI: 'DOGE',
};

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, def: number, lo: number, hi: number): number {
  const raw = env[key];
  const v = raw === undefined || raw === '' ? def : Number(raw);
  if (!Number.isFinite(v) || v < lo || v > hi) {
    throw new ConfigError(`${key}=${raw} must be a number in [${lo}, ${hi}]`);
  }
  return v;
}

function bool(env: Env, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ConfigError(`${key}=${raw} must be true or false`);
}

function oneOf<T extends string>(env: Env, key: string, def: T, allowed: readonly T[]): T {
  const raw = (env[key] ?? def) as T;
  if (!allowed.includes(raw)) throw new ConfigError(`${key}=${raw} must be one of ${allowed.join(', ')}`);
  return raw;
}

/** SIZING_TIERS: unset = default ladder, "off" = configured limits at every size, or a JSON array of tier points. */
function parseSizingTiers(raw: string | undefined, base: { risk: RiskLimits; strategy: StrategyConfig }): TierPoint[] {
  const normal = defaultTiers(base)[2];
  try {
    if (!raw) return validateTiers(defaultTiers(base));
    if (raw === 'off') return [normal];
    return validateTiers(JSON.parse(raw) as TierPoint[]);
  } catch (e) {
    throw new ConfigError(`SIZING_TIERS: ${(e as Error).message}`);
  }
}

/** "earliest,latest" seconds before close. */
function window(env: Env, key: string, def: [number, number]): [number, number] {
  const raw = env[key];
  if (!raw) return def;
  const [a, b] = raw.split(',').map(Number);
  if (!(Number.isFinite(a) && Number.isFinite(b) && a > b && b >= 0)) throw new ConfigError(`${key}=${raw} must be "earliest,latest" seconds before close with earliest > latest >= 0`);
  return [a, b];
}

function band(env: Env, key: string, def: [number, number]): [number, number] {
  const raw = env[key];
  if (!raw) return def;
  const [a, b] = raw.split(',').map(Number);
  if (!(Number.isFinite(a) && Number.isFinite(b) && a <= b && a >= 0)) throw new ConfigError(`${key}=${raw} must be "lo,hi" with 0 <= lo <= hi`);
  return [a, b];
}

function jsonMap(env: Env, key: string, def: Record<string, string>): Record<string, string> {
  const raw = env[key];
  if (!raw) return { ...def };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [String(k), String(v)]));
  } catch (e) {
    throw new ConfigError(`${key} must be a JSON object: ${(e as Error).message}`);
  }
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

export function loadConfig(env: Env = process.env): Readonly<Config> {
  const mode = oneOf<TradingMode>(env, 'TRADING_MODE', 'paper', ['paper', 'shadow', 'live']);
  const kalshiEnv = oneOf<KalshiEnv>(env, 'KALSHI_ENV', 'demo', ['demo', 'prod']);

  // Optional dashboard password (empty = no login). DASHBOARD_TOKEN is no longer used.
  const dashboardPassword = (env.DASHBOARD_PASSWORD ?? '').trim();

  const host = env.BIND_HOST ?? '127.0.0.1';
  const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!isLoopback && !bool(env, 'ALLOW_NON_LOOPBACK_BIND', false)) {
    throw new ConfigError(`BIND_HOST=${host} is not loopback. Reach the dashboard through an SSH tunnel or Tailscale, or set ALLOW_NON_LOOPBACK_BIND=true behind TLS.`);
  }

  // auto (default): every crypto 15-minute and hourly series the exchange lists whose asset has a
  // settlement index; the built-in list below is only the fallback if discovery fails.
  const rawSeries = (env.STRATEGY_SERIES ?? 'auto').trim();
  const seriesAuto = rawSeries === 'auto';
  const seriesAssetMap = jsonMap(env, 'SERIES_ASSET_MAP', DEFAULT_SERIES_ASSET);
  const series = seriesAuto ? Object.keys(seriesAssetMap) : rawSeries.split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of series) {
    if (!seriesAssetMap[s]) throw new ConfigError(`Series ${s} has no asset mapping in SERIES_ASSET_MAP`);
  }

  const kalshiKeyId = env.KALSHI_KEY_ID || undefined;
  const kalshiPrivateKeyPath = env.KALSHI_PRIVATE_KEY_PATH || undefined;
  const needsAuth = mode !== 'paper' || bool(env, 'PAPER_USE_KALSHI_AUTH', false);
  if (needsAuth) {
    if (!kalshiKeyId || !kalshiPrivateKeyPath) {
      throw new ConfigError('KALSHI_KEY_ID and KALSHI_PRIVATE_KEY_PATH are required outside paper mode');
    }
    checkKeyFile(kalshiPrivateKeyPath);
  }

  if (mode === 'live') {
    if (kalshiEnv !== 'prod') throw new ConfigError('TRADING_MODE=live requires KALSHI_ENV=prod');
    if (env.LIVE_TRADING_ACKNOWLEDGED !== 'I_ACCEPT_REAL_MONEY_RISK') {
      throw new ConfigError('TRADING_MODE=live requires LIVE_TRADING_ACKNOWLEDGED=I_ACCEPT_REAL_MONEY_RISK set at deploy time');
    }
  }

  const allowProxyIndex = bool(env, 'ALLOW_PROXY_INDEX', false);
  if (allowProxyIndex && mode === 'live') {
    throw new ConfigError('ALLOW_PROXY_INDEX is not permitted in live mode: the bot must price off the index Kalshi settles on');
  }

  const restBaseUrl = env.KALSHI_REST_URL ?? (kalshiEnv === 'prod'
    ? 'https://api.elections.kalshi.com/trade-api/v2'
    : 'https://demo-api.kalshi.co/trade-api/v2');
  const wsUrl = env.KALSHI_WS_URL ?? (kalshiEnv === 'prod'
    ? 'wss://api.elections.kalshi.com/trade-api/ws/v2'
    : 'wss://demo-api.kalshi.co/trade-api/ws/v2');

  const risk: RiskLimits = {
    // The bankroll-fraction limits below bind first; this is a fat-finger ceiling.
    maxContractsPerOrder: num(env, 'RISK_MAX_CONTRACTS_PER_ORDER', 250, 0.01, 5000),
    maxOrderRiskFrac: num(env, 'RISK_MAX_ORDER_FRAC', 0.02, 0.001, 0.05),
    maxWindowRiskFrac: num(env, 'RISK_MAX_WINDOW_FRAC', 0.03, 0.001, 0.1),
    maxTotalRiskFrac: num(env, 'RISK_MAX_TOTAL_FRAC', 0.10, 0.001, 0.25),
    dailyLossLimitFrac: num(env, 'RISK_DAILY_LOSS_FRAC', 0.03, 0.001, 0.2),
    dailyLossLimitUsd: num(env, 'RISK_DAILY_LOSS_USD', 5, 0.01, 100000),
    minSidePrice: num(env, 'RISK_MIN_SIDE_PRICE', 0.10, 0.01, 0.45),
    maxOrdersPerMinute: num(env, 'RISK_MAX_ORDERS_PER_MIN', 30, 1, 600),
    maxOpenOrders: num(env, 'RISK_MAX_OPEN_ORDERS', 12, 1, 200),
    maxBookAgeMs: num(env, 'RISK_MAX_BOOK_AGE_MS', 5000, 250, 60000),
    maxIndexAgeMs: num(env, 'RISK_MAX_INDEX_AGE_MS', 3000, 250, 60000),
    noEntryBeforeCloseSec: num(env, 'RISK_NO_ENTRY_BEFORE_CLOSE_SEC', 15, 0, 600),
    maxConsecutiveOrderErrors: num(env, 'RISK_MAX_CONSEC_ORDER_ERRORS', 5, 1, 100),
  };
  if (risk.maxOrderRiskFrac > risk.maxWindowRiskFrac) throw new ConfigError('RISK_MAX_ORDER_FRAC must be <= RISK_MAX_WINDOW_FRAC');
  if (risk.maxWindowRiskFrac > risk.maxTotalRiskFrac) throw new ConfigError('RISK_MAX_WINDOW_FRAC must be <= RISK_MAX_TOTAL_FRAC');

  const cadence = oneOf(env, 'STRATEGY_CADENCE', 'relaxed', ['relaxed', 'continuous'] as const);
  const relaxed = cadence === 'relaxed';
  const strategy: StrategyConfig = {
    style: oneOf<StrategyStyle>(env, 'STRATEGY_STYLE', 'maker', ['maker', 'taker', 'both']),
    series,
    seriesAuto,
    recordSeries: (env.RECORD_SERIES ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    recordMaxMarkets: num(env, 'RECORD_MAX_MARKETS', 150, 1, 2000),
    kellyFraction: num(env, 'STRATEGY_KELLY_FRACTION', 0.25, 0.01, 0.5),
    portfolioKelly: bool(env, 'PORTFOLIO_KELLY', true),
    portfolioKellyShrink: num(env, 'PORTFOLIO_KELLY_SHRINK', 0.5, 0.05, 0.5),
    // Relaxed spec: e_min = 3c for maker entries; take only with >= 5c net edge (3c + 2c buffer).
    minEdge: num(env, 'STRATEGY_MIN_EDGE', relaxed ? 0.03 : 0.02, 0.0, 0.5),
    takerBuffer: num(env, 'STRATEGY_TAKER_BUFFER', relaxed ? 0.02 : 0.01, 0.0, 0.5),
    inventorySkewPerContract: num(env, 'STRATEGY_INVENTORY_SKEW', 0.002, 0, 0.05),
    requoteThreshold: num(env, 'STRATEGY_REQUOTE_THRESHOLD', 0.01, 0.01, 0.2),
    fastMoveSigmas: num(env, 'STRATEGY_FAST_MOVE_SIGMAS', 3, 0.5, 20),
    fastMoveWindowSec: num(env, 'STRATEGY_FAST_MOVE_WINDOW_SEC', 5, 1, 120),
    orderTtlSec: num(env, 'STRATEGY_ORDER_TTL_SEC', 60, 10, 900),
    exitPolicy: oneOf(env, 'EXIT_POLICY', relaxed ? 'hold' : 'fair_value', ['hold', 'fair_value', 'take_profit', 'confluence_ratchet'] as const),
    exitMargin: num(env, 'STRATEGY_EXIT_MARGIN', 0.01, 0, 0.5),
    takeProfit: num(env, 'STRATEGY_TAKE_PROFIT', 0.08, 0.01, 0.5),
    cadence,
    evalBarSec: num(env, 'STRATEGY_EVAL_BAR_SEC', 60, 5, 600),
    evalFvMove: num(env, 'STRATEGY_EVAL_FV_MOVE', 0.015, 0.001, 0.2),
    repriceSec: num(env, 'STRATEGY_REPRICE_SEC', 30, 5, 600),
    minEvalIntervalSec: num(env, 'STRATEGY_MIN_EVAL_INTERVAL_SEC', 10, 0, 120),
    entryWindowUpdown: window(env, 'ENTRY_WINDOW_15M', relaxed ? [840, 120] : [900, 15]),
    entryWindowHourly: window(env, 'ENTRY_WINDOW_HOURLY', relaxed ? [3300, 300] : [3600, 15]),
    hourlyMidBand: band(env, 'HOURLY_MID_BAND', [0.1, 0.9]),
    noExitBeforeCloseSec: num(env, 'STRATEGY_NO_EXIT_BEFORE_CLOSE_SEC', relaxed ? 60 : 0, 0, 600),
    makerBuffer: num(env, 'STRATEGY_MAKER_BUFFER', relaxed ? 0.01 : 0, 0, 0.1),
    makerBufferRange: band(env, 'STRATEGY_MAKER_BUFFER_RANGE', relaxed ? [0.005, 0.015] : [0, 0]),
    sizing: oneOf(env, 'STRATEGY_SIZING', relaxed ? 'target_ev' : 'kelly', ['kelly', 'target_ev'] as const),
    kappa: num(env, 'STRATEGY_KAPPA', 0.5, 0, 1),
    targetEvUsd: num(env, 'STRATEGY_TARGET_EV_USD', 10, 0, 10000),
    minTradeEvUsd: num(env, 'STRATEGY_MIN_TRADE_EV_USD', 1, 0, 10000),
    targetEvOfRisk: num(env, 'STRATEGY_TARGET_EV_OF_RISK', 0.25, 0, 1),
    minTradeEvFrac: num(env, 'STRATEGY_MIN_TRADE_EV_FRAC', 0.00016, 0, 1),
    minTradableBankrollUsd: num(env, 'MIN_TRADABLE_BANKROLL_USD', 10, 0, 1e7),
    ensembleVetoSigmas: num(env, 'STRATEGY_ENSEMBLE_VETO_SIGMAS', 2, 0, 10),
    ddScaleAt: num(env, 'RISK_DD_SCALE_AT', 0.15, 0.01, 1),
    weeklyLossPause: num(env, 'RISK_WEEKLY_LOSS_PAUSE', 0.08, 0.01, 1),
    modelHealthHalt: bool(env, 'MODEL_HEALTH_HALT', true),
    modelHealthMinWindows: num(env, 'MODEL_HEALTH_MIN_WINDOWS', 200, 20, 100000),
    huntTargetMargin: num(env, 'HUNT_TARGET_MARGIN', 0.02, 0, 0.5),
    huntMinConfluence: num(env, 'HUNT_MIN_CONFLUENCE', 2, 1, 7),
    ratchetMinFillRatio: num(env, 'RATCHET_MIN_FILL_RATIO', 1, 0.1, 20),
    ratchetMinWallAgeSec: num(env, 'RATCHET_MIN_WALL_AGE_SEC', 3, 0, 120),
    ratchetSlippageTicks: num(env, 'RATCHET_SLIPPAGE_TICKS', 1, 0, 10),
    sessionRisk: (() => { try { return parseSessionRisk(env.SESSION_RISK); } catch (e) { throw new ConfigError((e as Error).message); } })(),
    huntSessionGuard: bool(env, 'HUNT_SESSION_GUARD', true),
    huntTransitionBufferMin: num(env, 'HUNT_TRANSITION_BUFFER_MIN', 10, 0, 120),
    volSeasonality: bool(env, 'VOL_SEASONALITY', true),
    volProfilePath: path.resolve(env.VOL_PROFILE_PATH ?? './params/vol_profile.json'),
    volModel: bool(env, 'VOL_MODEL', true),
    volModelPath: path.resolve(env.VOL_MODEL_PATH ?? './params/vol_model.json'),
    fillModelPath: path.resolve(env.FILL_MODEL_PATH ?? './params/fill_model.json'),
    fillMinEv: num(env, 'FILL_MIN_EV', 0, -0.5, 0.5),
    takeGate: oneOf(env, 'TAKE_GATE', 'validated', ['validated', 'off'] as const),
    takeMargin: num(env, 'TAKE_MARGIN', 0, 0, 0.2),
  };

  const dataDir = path.resolve(env.DATA_DIR ?? './data');

  const cfg: Config = {
    mode,
    kalshiEnv,
    restBaseUrl,
    wsUrl,
    kalshiKeyId,
    kalshiPrivateKeyPath,
    kalshiSubaccount: env.KALSHI_SUBACCOUNT ? num(env, 'KALSHI_SUBACCOUNT', 0, 0, 1000) : undefined,
    kalshiBalancePrecision: env.KALSHI_BALANCE_PRECISION === '0.0001' ? 0.0001 : 0.01,
    liveAllowUnvalidated: bool(env, 'LIVE_ALLOW_UNVALIDATED_MODEL', false),
    host,
    port: num(env, 'PORT', 3000, 1, 65535),
    dashboardPassword,
    dataDir,
    paramsPath: path.resolve(env.MODEL_PARAMS_PATH ?? './params/model.json'),
    // Starts in the aggressive tier; see SIZING_TIERS.
    paperBankrollUsd: num(env, 'PAPER_BANKROLL_USD', 20, 1, 1e7),
    indexIdMap: jsonMap(env, 'INDEX_ID_MAP', DEFAULT_INDEX_IDS),
    seriesAssetMap,
    catalogHorizonMin: num(env, 'CATALOG_HORIZON_MIN', 90, 16, 7 * 24 * 60),
    catalogStrikesPerEvent: num(env, 'CATALOG_STRIKES_PER_EVENT', 8, 0, 1000),
    allowProxyIndex,
    spotFeed: bool(env, 'SPOT_FEED', true),
    dominanceFeed: bool(env, 'DOMINANCE_FEED', true),
    taCandles: bool(env, 'TA_CANDLES', true),
    clockSkewMaxMs: num(env, 'CLOCK_SKEW_MAX_MS', 2000, 0, 60_000),
    sessionEdge: { minutes: num(env, 'SESSION_EDGE_MIN', 40, 5, 120), noEntry: bool(env, 'SESSION_EDGE_NO_ENTRY', true) },
    clockSkewWarnMs: num(env, 'CLOCK_SKEW_WARN_MS', 1000, 0, 60_000),
    settlementAvg: oneOf(env, 'SETTLEMENT_AVG', 'official', ['official', 'continuous'] as const),
    taStudyPath: path.resolve(env.TA_STUDY_PATH ?? './params/ta_study.json'),
    coinbaseRestUrl: env.COINBASE_REST_URL ?? 'https://api.exchange.coinbase.com',
    takerFlow: bool(env, 'TAKER_FLOW', true),
    coinbaseWsUrl: env.COINBASE_WS_URL ?? 'wss://ws-feed.exchange.coinbase.com',
    // Binance.com blocks US IPs; the market-data-only host usually works. Override if needed.
    binanceWsUrl: env.BINANCE_WS_URL ?? 'wss://data-stream.binance.vision/ws/!miniTicker@arr',
    coingeckoUrl: env.COINGECKO_URL ?? 'https://api.coingecko.com/api/v3',
    coingeckoApiKey: env.COINGECKO_API_KEY || undefined,
    reconcileIntervalMs: num(env, 'RECONCILE_INTERVAL_MS', 45000, 5000, 600000),
    heartbeatTimeoutMs: num(env, 'HEARTBEAT_TIMEOUT_MS', 15000, 2000, 300000),
    alertTelegramToken: env.ALERT_TELEGRAM_TOKEN || undefined,
    alertTelegramChatId: env.ALERT_TELEGRAM_CHAT_ID || undefined,
    alertWebhookUrl: env.ALERT_WEBHOOK_URL || undefined,
    risk,
    strategy,
    vault: {
      enabled: bool(env, 'VAULT_ENABLED', true),
      quotaUsd: num(env, 'VAULT_QUOTA_USD', 100, 0, 1e7),
      winShare: num(env, 'VAULT_WIN_SHARE', 0.5, 0, 1),
      pocketShare: num(env, 'POCKET_SHARE', 0.1, 0, 1),
      quotaReset: oneOf(env, 'VAULT_QUOTA_RESET', 'session', ['session', 'us_open'] as const),
      dailyGoalUsd: num(env, 'VAULT_DAILY_GOAL_USD', 100, 0, 1e7),
      rampStartUsd: num(env, 'VAULT_RAMP_START_USD', 20, 0, 1e7),
      rampFullUsd: num(env, 'VAULT_RAMP_FULL_USD', 100, 0, 1e7),
    },
    sizingTiers: parseSizingTiers(env.SIZING_TIERS, { risk, strategy }),
    perps: (() => {
      const hedge = oneOf(env, 'PERP_HEDGE', 'paper', ['off', 'paper', 'live'] as const);
      const trading = oneOf(env, 'PERP_TRADING', 'paper', ['off', 'paper', 'live'] as const);
      // The perps REST API uses the same authentication as event contracts: without a separate perps key
      // the main Kalshi key is used (separate keys are only required for FIX).
      const keyId = env.KALSHI_PERPS_KEY_ID || env.KALSHI_KEY_ID || undefined;
      const privateKeyPath = env.KALSHI_PERPS_PRIVATE_KEY_PATH || (env.KALSHI_PERPS_KEY_ID ? undefined : env.KALSHI_PRIVATE_KEY_PATH) || undefined;
      for (const [name, v] of [['PERP_HEDGE', hedge], ['PERP_TRADING', trading]] as const) {
        if (v !== 'live') continue;
        if (mode !== 'live') throw new ConfigError(`${name}=live requires TRADING_MODE=live (use ${name}=paper to simulate)`);
        if (!keyId || !privateKeyPath) throw new ConfigError(`${name}=live requires a key: KALSHI_PERPS_KEY_ID + KALSHI_PERPS_PRIVATE_KEY_PATH, or KALSHI_KEY_ID + KALSHI_PRIVATE_KEY_PATH`);
        checkKeyFile(privateKeyPath);
      }
      // One perps account, one gateway: hedging and trading cannot run on different venues.
      if (hedge !== 'off' && trading !== 'off' && hedge !== trading) throw new ConfigError(`PERP_HEDGE=${hedge} and PERP_TRADING=${trading} must match (one perps account); set both to live or both to paper`);
      return {
        feed: bool(env, 'PERPS_FEED', true),
        restUrl: env.KALSHI_PERPS_REST_URL ?? (kalshiEnv === 'prod' ? 'https://external-api.kalshi.com/trade-api/v2' : 'https://external-api.demo.kalshi.co/trade-api/v2'),
        pollMs: num(env, 'PERPS_POLL_MS', 2000, 500, 60000),
        keyId, privateKeyPath,
        subaccount: env.KALSHI_PERPS_SUBACCOUNT ? num(env, 'KALSHI_PERPS_SUBACCOUNT', 0, 0, 1000) : undefined,
        hedge,
        // Blueprint: hedge only above a dollar delta that justifies 5-12 bps (the $ P&L of a 100% move; $2,000 = $20 per 1%).
        minDollarDelta: num(env, 'PERP_HEDGE_MIN_DOLLAR_DELTA', 2000, 1, 1e9),
        maxNotionalUsd: num(env, 'PERP_HEDGE_MAX_NOTIONAL_USD', 1000, 0, 1e9),
        excludeTauSec: num(env, 'PERP_HEDGE_EXCLUDE_TAU_SEC', 120, 0, 3600),
        repriceSec: num(env, 'PERP_HEDGE_REPRICE_SEC', 30, 5, 600),
        takerAfterSec: num(env, 'PERP_HEDGE_TAKER_AFTER_SEC', 300, 10, 86400),
        makerFeeBps: num(env, 'PERP_MAKER_FEE_BPS', 5, 0, 100),
        takerFeeBps: num(env, 'PERP_TAKER_FEE_BPS', 12, 0, 100),
        trading,
        modelPath: path.resolve(env.PERP_MODEL_PATH ?? './params/perp_model.json'),
        paperBalanceUsd: num(env, 'PERP_PAPER_BALANCE_USD', 20, 1, 1e9),
        horizonMin: num(env, 'PERP_HORIZON_MIN', 240, 15, 7 * 24 * 60),
        entryEdgeBps: num(env, 'PERP_ENTRY_EDGE_BPS', 5, 0, 500),
        exitEdgeBps: num(env, 'PERP_EXIT_EDGE_BPS', 0, -500, 500),
        kellyFraction: num(env, 'PERP_KELLY_FRACTION', 0.25, 0.01, 1),
        lockedVolMult: num(env, 'PERP_LOCKED_VOL_MULT', 1, 0, 10),
        maxLeverage: num(env, 'PERP_MAX_LEVERAGE', 3, 0.1, 20),
        maxTradeNotionalUsd: num(env, 'PERP_MAX_NOTIONAL_USD', 500, 1, 1e9),
        maxTotalNotionalUsd: num(env, 'PERP_MAX_TOTAL_NOTIONAL_USD', 1000, 1, 1e9),
        stopAtrMult: num(env, 'PERP_STOP_ATR_MULT', 2, 0.25, 20),
        minStopBps: num(env, 'PERP_MIN_STOP_BPS', 50, 5, 5000),
        maxHoldMin: num(env, 'PERP_MAX_HOLD_MIN', 480, 15, 30 * 24 * 60),
        dailyLossFrac: num(env, 'PERP_DAILY_LOSS_FRAC', 0.10, 0.005, 0.5),
        cooldownMin: num(env, 'PERP_COOLDOWN_MIN', 60, 0, 24 * 60),
        pilotMaxNotionalUsd: num(env, 'PERP_PILOT_MAX_NOTIONAL_USD', 25, 1, 1e9),
        pilotMaxLeverage: num(env, 'PERP_PILOT_MAX_LEVERAGE', 1, 0.1, 20),
        priorIc: num(env, 'PERP_PRIOR_IC', 0.05, 0, 0.3),
        requireValidation: bool(env, 'PERP_REQUIRE_VALIDATION', false),
        minEquityUsd: num(env, 'PERP_MIN_EQUITY_USD', 5, 0, 1e9),
        maxOrderNotionalUsd: num(env, 'PERP_MAX_ORDER_NOTIONAL_USD', 1000, 1, 1e9),
        collarBps: num(env, 'PERP_COLLAR_BPS', 150, 5, 2000),
        strategy: oneOf(env, 'PERP_STRATEGY', 'setups', ['signal', 'setups'] as const),
        setupModelPath: path.resolve(env.SETUP_MODEL_PATH ?? './params/setup_model.json'),
        setupTaNetPath: path.resolve(env.SETUP_TA_NET_PATH ?? './params/ta_net_wf.json'),
        setupFastRisk: num(env, 'SETUP_FAST_RISK', 0.004, 0.0005, 0.05),
        setupSlowRisk: num(env, 'SETUP_SLOW_RISK', 0.006, 0.0005, 0.05),
        setupFastMax: num(env, 'SETUP_FAST_MAX_POSITIONS', 3, 0, 20),
        setupSlowMax: num(env, 'SETUP_SLOW_MAX_POSITIONS', 3, 0, 20),
        setupMaxLeverage: num(env, 'SETUP_MAX_LEVERAGE', 3, 0.1, 20),
        setupMaxAssetLeverage: num(env, 'SETUP_MAX_ASSET_LEVERAGE', 1.5, 0.1, 20),
        setupDailyGoalUsd: num(env, 'SETUP_DAILY_GOAL_USD', 100, 0, 1e9),
        setupRetrainDays: num(env, 'SETUP_RETRAIN_DAYS', 7, 1, 365),
        setupFastRiskUsd: num(env, 'SETUP_FAST_RISK_USD', 0, 0, 1e7),
        setupSlowRiskUsd: num(env, 'SETUP_SLOW_RISK_USD', 0, 0, 1e7),
        setupMinTargetUsd: num(env, 'SETUP_MIN_TARGET_USD', 0, 0, 1e7),
      };
    })(),
    autoTrain: {
      mode: oneOf(env, 'AUTO_TRAIN', 'windows', ['off', 'daily', 'windows'] as const),
      hourUtc: num(env, 'AUTO_TRAIN_HOUR_UTC', 6, 0, 23),
      dir: path.resolve(env.AUTO_TRAIN_DIR ?? path.join(dataDir, 'models')),
      recordingsDir: path.resolve(env.AUTO_TRAIN_RECORDINGS ?? path.join(dataDir, 'recordings')),
      recordingsGzipAfterDays: num(env, 'RECORDINGS_GZIP_AFTER_DAYS', 2, 0, 365),
      recordingsMinFreeGb: num(env, 'RECORDINGS_MIN_FREE_GB', 3, 0, 1e4),
      promote: oneOf(env, 'AUTO_TRAIN_PROMOTE', 'always', ['always', 'validated'] as const),
      snnStage: oneOf(env, 'AUTO_TRAIN_SNN_STAGE', 'auto', ['auto', 'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const),
      ablationDays: num(env, 'AUTO_TRAIN_ABLATION_DAYS', 7, 1, 365),
      ablationEveryDays: num(env, 'AUTO_TRAIN_ABLATION_EVERY_DAYS', 7, 0, 365),
      snnTrainDays: num(env, 'AUTO_TRAIN_SNN_TRAIN_DAYS', 21, 1, 365),
      onModelChange: bool(env, 'AUTO_TRAIN_ON_MODEL_CHANGE', true),
      sweepTargets: (env.SWEEP_TARGETS ?? 'setups-long,setups-short,setups-vol,kalshi,bot').split(',').map((x) => x.trim()).filter(Boolean),
      sweepHours: num(env, 'SWEEP_HOURS', 2, 0.05, 48),
      taNetOosHours: num(env, 'TA_NET_OOS_HOURS', 3, 0.05, 48),
      sweepEveryDays: num(env, 'SWEEP_EVERY_DAYS', 7, 1, 365),
      minDays: num(env, 'AUTO_TRAIN_MIN_DAYS', 1, 0, 365),
      watchSec: num(env, 'AUTO_TRAIN_WATCH_SEC', 30, 5, 3600),
      snnPbtDays: num(env, 'AUTO_TRAIN_SNN_PBT_DAYS', 7, 2, 365),
      snnPbtInitDays: num(env, 'AUTO_TRAIN_SNN_PBT_INIT_DAYS', 3, 1, 60),
      snnPbtMaxRounds: num(env, 'AUTO_TRAIN_SNN_PBT_MAX_ROUNDS', 0, 0, 1000),
      snnPbtEveryDays: num(env, 'AUTO_TRAIN_SNN_PBT_EVERY_DAYS', 30, 0, 365),
      snnPbtRestartEvery: num(env, 'AUTO_TRAIN_SNN_PBT_RESTART_EVERY', 4, 0, 1000),
    },
    snn: {
      mode: oneOf(env, 'SNN_MODE', 'shadow', ['off', 'shadow', 'blend'] as const),
      stage: oneOf(env, 'SNN_STAGE', 'S5', ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const),
      columns: (env.SNN_COLUMNS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      maxColumns: num(env, 'SNN_MAX_COLUMNS', 6, 1, 32),
      checkpointDir: path.resolve(env.SNN_CHECKPOINT_DIR ?? path.join(dataDir, 'snn')),
      checkpointEveryMin: num(env, 'SNN_CHECKPOINT_EVERY_MIN', 10, 1, 1440),
      worker: bool(env, 'SNN_WORKER', true),
      // The decision deadline: never wait longer than 200 ms for a readout.
      timeoutMs: num(env, 'SNN_TIMEOUT_MS', 200, 10, 200),
      latencySkipP99Ms: num(env, 'SNN_LATENCY_SKIP_P99_MS', 150, 5, 200),
      // Hard guardrail: alpha can never exceed 0.25.
      alphaMax: num(env, 'SNN_ALPHA_MAX', 0.25, 0, 0.25),
      minEvents: num(env, 'SNN_MIN_EVENTS', 200, 20, 100_000),
      readoutEta: num(env, 'SNN_READOUT_ETA', 1e-4, 0, 0.1),
      seed: num(env, 'SNN_SEED', 20260601, 0, 2 ** 31),
      targetScaling: bool(env, 'SNN_TARGET_SCALING', true),
      tennisPopulation: bool(env, 'SNN_TENNIS_POPULATION', true),
      tennisPopulationSettles: num(env, 'SNN_TENNIS_POPULATION_SETTLES', 30, 3, 10_000),
      domains: (() => {
        const stage = oneOf(env, 'SNN_STAGE', 'S5', ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const);
        const st = (d: string, def: typeof stage) => oneOf(env, `SNN_${d}_STAGE`, def, ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const);
        const mp = (d: string) => path.resolve(env[`SNN_${d}_MODEL_PATH`] ?? `./params/snn_${d.toLowerCase()}.json`);
        return {
          crypto: { enabled: bool(env, 'SNN_CRYPTO', true), stage: st('CRYPTO', stage), modelPath: mp('CRYPTO') },
          perps: { enabled: bool(env, 'SNN_PERPS', true), stage: st('PERPS', stage), modelPath: mp('PERPS') },
          // Tennis cannot be pretrained offline (no tennis replay): S3 by default (no PC pathway).
          tennis: { enabled: bool(env, 'SNN_TENNIS', true), stage: st('TENNIS', 'S3'), modelPath: mp('TENNIS') },
        };
      })(),
      crossFeed: bool(env, 'SNN_CROSS_FEED', false),
      deferred: {
        wilsonCowan: bool(env, 'SNN_WILSON_COWAN', false),
        gapJunctions: bool(env, 'SNN_GAP_JUNCTIONS', false),
        izhikevichCH: bool(env, 'SNN_IZHIKEVICH_CH', false),
        dcaap: bool(env, 'SNN_DCAAP', false),
      },
    },
    tennis: {
      enabled: bool(env, 'TENNIS_ENABLED', true),
      live: bool(env, 'TENNIS_LIVE', false),
      series: (env.TENNIS_SERIES ?? 'KXATPMATCH').split(',').map((s) => s.trim()).filter(Boolean),
      horizonHours: num(env, 'TENNIS_HORIZON_HOURS', 36, 1, 24 * 14),
      maxTotalFrac: num(env, 'TENNIS_MAX_TOTAL_FRAC', 0.25, 0, 0.25),
      maxMatchFrac: num(env, 'TENNIS_MAX_MATCH_FRAC', 0.10, 0.001, 0.25),
      orderFrac: num(env, 'TENNIS_ORDER_FRAC', 0.05, 0.001, 0.25),
      underdogMax: num(env, 'TENNIS_UNDERDOG_MAX', 0.25, 0.02, 0.45),
      underdogMin: num(env, 'TENNIS_UNDERDOG_MIN', 0.08, 0.01, 0.45),
      // Never more than 30 minutes before the published start.
      preStartMin: num(env, 'TENNIS_PRE_START_MIN', 30, 0, 30),
      entryWindowMin: num(env, 'TENNIS_ENTRY_WINDOW_MIN', 20, 1, 240),
      maxSpread: num(env, 'TENNIS_MAX_SPREAD', 0.03, 0.01, 0.2),
      takeProfitCents: num(env, 'TENNIS_TP_CENTS', 0.06, 0.01, 0.5),
      takeProfitPct: num(env, 'TENNIS_TP_PCT', 0.40, 0, 5),
      underdogStopCents: num(env, 'TENNIS_UNDERDOG_STOP_CENTS', 0, 0, 0.5),
      favMin: num(env, 'TENNIS_FAV_MIN', 0.75, 0.5, 0.99),
      favMax: num(env, 'TENNIS_FAV_MAX', 0.92, 0.5, 0.99),
      favMinProgress: num(env, 'TENNIS_FAV_MIN_PROGRESS', 0.5, 0, 1),
      favStableCents: num(env, 'TENNIS_FAV_STABLE_CENTS', 0.04, 0, 0.5),
      favStopCents: num(env, 'TENNIS_FAV_STOP_CENTS', 0, 0, 0.9),
      secPerPoint: num(env, 'TENNIS_SEC_PER_POINT', 40, 15, 120),
      serveBase: num(env, 'TENNIS_SERVE_BASE', 0.64, 0.5, 0.8),
      progressInfoWeight: num(env, 'TENNIS_PROGRESS_INFO_WEIGHT', 0.5, 0, 1),
      qvSampleSec: num(env, 'TENNIS_QV_SAMPLE_SEC', 30, 5, 600),
      scoreFeed: oneOf(env, 'TENNIS_SCORE_FEED', env.LIVE_TENNIS_API_KEY ? 'livetennis' : 'off', ['off', 'kalshi', 'livetennis'] as const),
      scoreIdleMin: num(env, 'TENNIS_SCORE_IDLE_MIN', 30, 1, 24 * 60),
      scorePollSec: num(env, 'TENNIS_SCORE_POLL_SEC', 15, 5, 300),
      liveMoveCents: num(env, 'TENNIS_LIVE_MOVE_CENTS', 0.03, 0.005, 0.5),
      trail: bool(env, 'TENNIS_TRAIL', true),
      favTrailCents: num(env, 'TENNIS_FAV_TRAIL_CENTS', 0.06, 0.01, 0.5),
      favTrailCap: num(env, 'TENNIS_FAV_TRAIL_CAP', 0.97, 0.5, 0.99),
      trailMinFillRatio: num(env, 'TENNIS_TRAIL_MIN_FILL_RATIO', 1, 0.1, 20),
      trailMinWallAgeSec: num(env, 'TENNIS_TRAIL_MIN_WALL_AGE_SEC', 3, 0, 120),
      trailSlippageTicks: num(env, 'TENNIS_TRAIL_SLIPPAGE_TICKS', 1, 0, 10),
      huntMinSignals: num(env, 'TENNIS_HUNT_MIN_SIGNALS', 2, 1, 4),
      huntMaxSec: num(env, 'TENNIS_HUNT_MAX_SEC', 180, 0, 3600),
      huntTrailTicks: num(env, 'TENNIS_HUNT_TRAIL_TICKS', 2, 1, 20),
      confWindowSec: num(env, 'TENNIS_CONF_WINDOW_SEC', 60, 10, 900),
      confMomentumCents: num(env, 'TENNIS_CONF_MOMENTUM_CENTS', 0.01, 0.001, 0.5),
      confFlow: num(env, 'TENNIS_CONF_FLOW', 0.2, 0.01, 1),
      confDepth: num(env, 'TENNIS_CONF_DEPTH', 0.2, 0.01, 1),
      confOpponentCents: num(env, 'TENNIS_CONF_OPPONENT_CENTS', 0.01, 0.001, 0.5),
      entryMinSignalsPre: num(env, 'TENNIS_ENTRY_MIN_SIGNALS_PRE', 1, 0, 4),
      entryMinSignalsLive: num(env, 'TENNIS_ENTRY_MIN_SIGNALS_LIVE', 2, 0, 4),
      favEntryMinSignals: num(env, 'TENNIS_FAV_ENTRY_MIN_SIGNALS', 2, 0, 4),
      earlyFullSizeMin: num(env, 'TENNIS_EARLY_FULL_SIZE_MIN', 10, 0, 240),
      underdogLateProgress: num(env, 'TENNIS_UNDERDOG_LATE_PROGRESS', 0.35, 0, 1),
      underdogCutProgress: num(env, 'TENNIS_UNDERDOG_CUT_PROGRESS', 0.6, 0, 1),
      fairMinEdge: num(env, 'TENNIS_FAIR_MIN_EDGE', 0.01, -0.5, 0.5),
      modelPath: path.resolve(env.TENNIS_MODEL_PATH ?? './params/tennis_model.json'),
    },
    taNet: {
      enabled: bool(env, 'TA_NET', true),
      modelPath: path.resolve(env.TA_NET_PATH ?? './params/ta_net.json'),
      requireValidated: bool(env, 'TA_NET_REQUIRE_VALIDATED', true),
      historyDir: path.resolve(env.HISTORY_DIR ?? path.join(dataDir, 'history')),
      historyUpdate: bool(env, 'HISTORY_AUTO_UPDATE', true),
      tvFill: bool(env, 'TV_FILL', true),
      historyAssets: env.HISTORY_ASSETS ?? 'auto',
      binanceIntervals: (env.HISTORY_BINANCE_INTERVALS ?? '1h,15m,1d').split(',').map((x) => x.trim()).filter(Boolean),
      coinbaseTfs: (env.HISTORY_COINBASE_TFS ?? '1h,1d').split(',').map((x) => x.trim()).filter(Boolean),
      retrainEveryDays: num(env, 'TA_NET_RETRAIN_DAYS', 7, 0, 365),
      arch: oneOf(env, 'TA_NET_ARCH', 'flat', ['flat', 'grouped'] as const),
      trainMonths: num(env, 'TA_NET_TRAIN_MONTHS', 12, 1, 36),
      evalMonths: num(env, 'TA_NET_EVAL_MONTHS', 1, 0.25, 6),
      stepMonths: num(env, 'TA_NET_STEP_MONTHS', 1, 0.25, 6),
      holdoutMonths: num(env, 'TA_NET_HOLDOUT_MONTHS', 3, 0.5, 12),
      finalMonths: num(env, 'TA_NET_FINAL_MONTHS', 2, 0, 12),
      stride: num(env, 'TA_NET_STRIDE', 2, 1, 24),
      minPerRegime: num(env, 'TA_NET_MIN_PER_REGIME', 100, 1, 100_000),
      dsrThreshold: num(env, 'TA_NET_DSR', 0.95, 0, 1),
      forwardDays: num(env, 'TA_NET_FORWARD_DAYS', 90, 1, 365),
      muteOnForwardFail: bool(env, 'TA_NET_MUTE_ON_FORWARD_FAIL', true),
      maxRoundsPerRun: num(env, 'TA_NET_MAX_ROUNDS_PER_RUN', 36, 0, 10_000),
      restartEvery: num(env, 'TA_NET_RESTART_EVERY', 6, 0, 1000),
    },
  };
  return deepFreeze(cfg);
}

function checkKeyFile(p: string): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    throw new ConfigError(`KALSHI_PRIVATE_KEY_PATH ${p} does not exist`);
  }
  const repoRoot = path.resolve('.');
  if (path.resolve(p).startsWith(repoRoot + path.sep)) {
    throw new ConfigError('The Kalshi private key must live outside the repository directory');
  }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new ConfigError(`Private key ${p} is readable by group/others; run chmod 600`);
  }
}

/** Redacted view for logs and the dashboard. */
export function publicConfig(cfg: Config): Record<string, unknown> {
  const { dashboardPassword, kalshiKeyId, kalshiPrivateKeyPath, alertTelegramToken, alertWebhookUrl, coingeckoApiKey, ...rest } = cfg;
  return {
    ...rest,
    kalshiKeyId: kalshiKeyId ? `${kalshiKeyId.slice(0, 4)}…` : undefined,
    perps: { ...cfg.perps, keyId: cfg.perps.keyId ? `${cfg.perps.keyId.slice(0, 4)}…` : undefined, privateKeyPath: cfg.perps.privateKeyPath ? '(set)' : undefined },
    alerts: { telegram: Boolean(alertTelegramToken), webhook: Boolean(alertWebhookUrl) },
  };
}

// Configuration is read once from the environment at startup, validated, and
// frozen. Nothing at runtime (API, LLM, learner) can change it. Changing a
// parameter means a reviewed commit and a redeploy.

import type { DynamicEdgeParams } from './strategy/dynamicEdge';
import type { RegimeScaleParams } from './strategy/regimeScale';
import { type PacerConfig, validZone } from './risk/quotaPacer';
import fs from 'fs';
import { parseSessionRisk, type SessionRiskProfile } from './model/sessionRisk';
import { DEFAULT_PROBATION, type ProbationParams } from './risk/probation';
import { FEE_SCHEDULE_URL } from './kalshi/feeSchedule';
import { DEFAULT_SINUOUS_ENTRY, type SinuousEntryParams } from './strategy/sinuousEntry';
import { DEFAULT_SINUOUS_EXIT, type SinuousExitParams } from './strategy/sinuousExit';
import { defaultTiers, validateTiers, type TierPoint } from './risk/sizingTiers';
import type { AccuracyGateConfig } from './strategy/accuracyGate';
import type { VaultConfig } from './vault/vault';
import { DEFAULT_LIVE_LINE } from './strategy/liveLine';
import { DEFAULT_TRIALS, TRIAL_NAMES, type TrialName, type TrialParams } from './strategy/componentTrials';
import { DEFAULT_SCOREBOARD, type ScoreboardParams } from './health/scoreboard';
import os from 'os';
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
  /** Kalshi data reaching the bot later than this (backlog, stalled event loop) blocks all orders; 0 = off. */
  maxFeedLagMs: number;
  maxIndexAgeMs: number;
  /** No new entries this close to market close. */
  noEntryBeforeCloseSec: number;
  /** Consecutive order-path errors that trip the kill switch. */
  maxConsecutiveOrderErrors: number;
}

/** Steven's settlement rule and the loser exits that enforce it (bot/strategy/fairValueStrategy.ts decide). */
export interface LoserExitConfig {
  /** FV_ENTRY_GATE (on): a crypto entry is taken only when the spot fair value of the side bought (the contract priced off the
   *  index, before the model, the SNN, the TA and the rules) is at least its cost with the fee plus FV_ENTRY_GATE_MARGIN. */
  gate: boolean;
  /** FV_ENTRY_GATE_MARGIN (0.06 a contract, the lab's best of 0, 3, 6, 9 and 12 cents). */
  gateMargin: number;
  /** FV_ENTRY_GATE_QUOTE_MARGIN (unset = FV_ENTRY_GATE_MARGIN): the margin a resting maker quote that opens or adds to a
   *  position needs. A quote fills later than it is placed, mostly when the price has moved through it, so it can need a
   *  wider cushion than a taker entry, which fills at the price the gate saw. */
  gateQuoteMargin?: number;
  /** LOSER_CUT (on): a position not in profit after fees is sold at the bid (the top bid's size each evaluation, no delay)
   *  as soon as the spot fair value of its side is below the bid less the taker fee a contract less LOSER_CUT_MARGIN. */
  cut: boolean;
  /** LOSER_CUT_MARGIN (0.03 a contract; the lab: 3c beat 5, 8 and 12c, and waiting 10-30 s lost). */
  cutMargin: number;
  /** LOSER_WINDOW_CUT (on): inside the last share of the window (STRATEGY_NO_EXIT_BEFORE_CLOSE_FRAC) or the final
   *  STRATEGY_NO_EXIT_BEFORE_CLOSE_SEC, a position not in profit after fees is sold at the bid (Steven's rule); only a
   *  position in profit rides to settlement. Tennis: its last share of the match (TENNIS_NO_EXIT_BEFORE_END_FRAC). */
  window: boolean;
  /** LOSER_WINDOW_JUDGE (bid): how the window cut tells a loser it sells. bid: not in profit after fees at the bid (as first
   *  built). fair: that, and the spot fair value of the side under the bid less the taker fee a contract (selling beats
   *  holding: a bid that has fallen under fair value near the close is not hit). cost: that, and the spot fair value of the
   *  side under its cost with the entry fee (in profit judged by the coin's price instead of a thin closing bid). */
  windowJudge: 'bid' | 'fair' | 'cost';
  /** LOSER_WINDOW_SHARE (0: off): the window cut also runs once this share of the contract's window is left, when that is
   *  earlier than the last share (STRATEGY_NO_EXIT_BEFORE_CLOSE_FRAC), while the books are still deep. */
  windowShare: number;
  /** LOSER_NO_ENTRY_SHARE (0: off): no new risk (entries, quotes that add, fill-model crosses, training trades) once this
   *  share of the contract's window is left, nor anywhere the loser window cut runs: a position opened there is under water
   *  by the spread and fees at once, and the window cut would sell it straight back into a thin closing bid. */
  noEntryShare: number;
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
  /** Entry edge moved with the market state (bot/strategy/dynamicEdge.ts; DYN_EDGE_*, all 0 = static edge). */
  dynamicEdge: DynamicEdgeParams;
  /** Order size moved with the market state (bot/strategy/regimeScale.ts; REGIME_*, all 0 = no change). */
  regimeScale: RegimeScaleParams;
  /** Resting orders expire on the exchange after this many seconds (dead-man switch); a quote still wanted is placed again. */
  orderTtlSec: number;
  /** Exit mode. hold = Mode A (ride to settlement, no exit fee); fair_value = model exit only;
   * take_profit = Mode B (resting maker take-profit + model exit); confluence_ratchet = hunt winners. */
  exitPolicy: 'hold' | 'fair_value' | 'take_profit' | 'confluence_ratchet';
  /** Model exit: sell at the bid when bid - taker fee > q_adj + exitMargin. */
  exitMargin: number;
  /** Mode B take-profit distance above the entry price (dollars per contract). */
  takeProfit: number;
  /** Profit target: sell at the touch once that banks this much a contract (dollars) over what the position cost,
   *  net of the entry's fees and the exit's taker fee, whatever the model thinks the contract is worth. 0 = off. */
  profitTarget: number;
  /** ...or this fraction of what a contract cost (its price plus the entry fee), when that is more. Together: the
   *  take-profit's floor, which arms it. */
  profitTargetPct: number;
  /** Take-profit: once armed, sell when the gain falls back by this fraction of its best (never below the floor).
   *  0 = sell as soon as the floor is reached. */
  profitGiveBack: number;
  /** Take-profit bench (bot/strategy/takeProfitBench.ts): its crypto sales scored against holding to settlement, the
   *  take-profit benched on the exit curve's rule. false = scored only, never benched. */
  takeProfitBench: boolean;
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
  /** No exits in the final seconds, the hunt stop included: positions ride to settlement (spreads widen inside the
   *  averaging window, and the stop sales inside the last minutes were the ones found always wrong). */
  noExitBeforeCloseSec: number;
  /** STRATEGY_NO_EXIT_BEFORE_CLOSE_FRAC: in the last share of the contract's window (0.10 = the last 90 s of a 15-minute market,
   *  6 min of an hourly one) a position in profit after fees rides to settlement, no exit selling it (Steven's rule, Oct 29); a
   *  position that is not in profit keeps its exits until STRATEGY_NO_EXIT_BEFORE_CLOSE_SEC. */
  noExitBeforeCloseFrac: number;
  /** STRATEGY_SHARE_WINDOW_MAX_SEC (3600; 0 = no cap): the window the share rules measure (that last share, LOSER_WINDOW_SHARE,
   *  LOSER_NO_ENTRY_SHARE) is open to close, at most this long (shareWindowSec). Kalshi lists the hourly and daily ladders and
   *  the range brackets hours or a day before they close, and the bot trades them in their last hour: measured on the listing,
   *  their "last 10%" covered the whole entry window, so every winner rode to settlement and the loser window cut sold every
   *  new buy straight back into the bid (Nov 1 replay: window cut sales on average 1,828 s before the close). */
  shareWindowMaxSec: number;
  /** PACER (Steven's spec, Oct 29 23:35 UTC): the hourly quota pacer (bot/risk/quotaPacer.ts). A 24-hour profit clock anchored
   *  to 10:00 AM New York time at PACER_HOURLY_USD (4.50) an hour; the strategy sells a position at once (the "quota snipe") when
   *  its net profit after fees, sold at the bid, covers the running slice's goal (PACER_MODE=slices, Steven's non-stacking
   *  spec of Oct 30: never more than PACER_HOURLY_USD, a deficit caught up in rolling slices, a fresh slice each clock hour)
   *  or, in the older modes, the clock hour's deficit clamped to [PACER_MIN_TAKE_USD, PACER_MAX_TARGET_USD], whatever the
   *  exit policy (hold included), the hunt or the model says. Inside the last share of the
   *  window a position in profit rides to settlement instead, and a hunted position is never held for settlement
   *  (HUNT_LOCK_SALE_ELSE=exit). */
  pacer: PacerConfig;
  /** Steven's settlement rule (Oct 31: nothing rides to settlement unless it is in the last share of its window and in profit)
   *  and the sizing lab's loser exits (section L, Oct 31), the same in paper and live. Unset: off (views and tests built
   *  outside the loader). */
  loserExits?: LoserExitConfig;
  /** PROFIT_MANDATE (off by default; Steven's first wording, Oct 29 23:22 UTC): outside that final share of the window a position
   *  whose side bid net of the exit fee clears its entry cost (entry fee in) by PROFIT_MANDATE_MIN is sold at the bid whatever the
   *  exit policy or the model says, a hunt trailing its stop excepted. On, a penny of profit sells before the pacer's threshold is
   *  ever reached. */
  profitMandate: boolean;
  profitMandateMin: number;
  /** Maker adverse-selection buffer: default, and clamp range when estimated from 60 s markouts. */
  makerBuffer: number;
  makerBufferRange: [number, number];
  /** Smallest maker quote, in contracts, when sizing wants a smaller one (within the per-order caps and the risk room
   *  left): Kalshi rounds each order's fee up to the cent, so a small position pays more a contract to sell. 0 = off. */
  minQuoteContracts: number;
  /** Paper only, with paperOrderFrac 0: each crypto entry and maker quote buys about this many dollars of contracts
   *  once sizing wants the trade, in place of the tier, break-even, optimal-f and portfolio-Kelly sizing (the owner's
   *  choice on Oct 23: profit sales of $1 to $3 instead of cents). Both 0 = paper sizes like live. Live never uses it. */
  paperOrderUsd: number;
  /** Paper only: each crypto entry and maker quote buys about this share of the bankroll once sizing wants the trade
   *  (the owner's choice on Oct 24, a minimum of 10%: orders shrink as the account does and grow as it does). 0 = the
   *  fixed paperOrderUsd. Live never uses it. */
  paperOrderFrac: number;
  /** The order band, paper and live (Steven, Oct 30: "between $10-$20 an order"): each crypto entry and maker quote that
   *  sizing wants stakes its sized amount clamped to [orderUsdMin, orderUsdMax] dollars, within the risk room and free
   *  cash left (an entry the room cannot fit at orderUsdMin is skipped), in place of the tier, loss-aware, optimal-f and
   *  portfolio-Kelly sizing; the risk caps widen to fit it as for the paper order size. orderUsdMin 0 = off. A paper
   *  order size (paperOrderUsd / paperOrderFrac) wins over it. */
  orderUsdMin: number;
  orderUsdMax: number;
  /** Paper only: no new crypto entries in a time-to-close bucket where the market mid has scored a better log loss
   *  than the bot's (temperature-calibrated) probability over the last settled markets (bot/strategy/accuracyGate.ts;
   *  the owner's choice on Oct 23). Live never blocks on it. */
  accuracyGate: AccuracyGateConfig;
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
  /** Paper exploration: occasionally enter a borderline opportunity (edge within exploreBand below the
   *  threshold, still fee-net positive) at minimum size, logged with its probability, so the fill model
   *  and the edge threshold get data near the boundary. Paper mode only. */
  paperExplore: boolean;
  exploreRate: number;
  exploreBand: number;
  exploreMaxPerHour: number;
  /** TRAINING_TRADES_PER_HOUR (12; the old paper-only PAPER_TRAINING_TRADES_PER_HOUR is no longer read): training
   *  trades an hour on the side the model favours, taken when nothing qualifies on edge, so the bot keeps producing
   *  trades to learn from (0 = off). Steven's pick on Oct 31 (sizing thread): back on, in paper and live alike, each
   *  sized at the order band's minimum ($10) and screened by the fair value gate (FV_ENTRY_GATE) like every entry. */
  trainTrades: number;
  /** Markets with no position and no resting order are fully re-evaluated at most every idleEvalSec
   *  (1 s otherwise): most of the bot's CPU is the per-second evaluation of markets it is not in. */
  idleEvalSec: number;
  /** Paper only: price contracts on Coinbase / Binance when Kalshi's index is stale (default off: outside
   *  exchanges feed TA and features, never contract prices). */
  outsidePriceFallback: boolean;
  /** Adversarial evaluator (bot/strategy/adversary.ts): entries it cannot break, with TA / confluence
   *  evidence, are re-sized by Kelly with a conviction multiplier up to adversarialMaxBoost (<= 2). */
  adversarialBoost: boolean;
  adversarialMaxBoost: number;
  /** TA conviction overlay (bot/strategy/taConviction.ts): the TA network's blind-test-validated direction forecasts
   *  add a drift to the mathematical fair value (weight x reliability; at most taPricingMaxShift); unproven heads
   *  only through the 'ta' component trial. */
  taPricing: boolean;
  taPricingWeight: number;
  taPricingMaxShift: number;
  taPricingMaxZ: number;
  /** Altcoin risk-on rule: altcoins long the underlying while USDT.D falls and RSI > altRsiMin get
   *  selection priority and altBoost x their Kelly size. */
  altBoost: number;
  altUsdtdMaxZ: number;
  altRsiMin: number;
  nonAlts: string[];
  /** Largest combined size multiplier (adversary / confluence x altcoin rule) on any entry. */
  convictionMaxTotal: number;
  /** No conviction boosts while the coin's character is volatile-systemic (bot/strategy/ruleBook.ts). */
  characterStandAside: boolean;
  /** The rule book (rules that passed research/ruleBook.ts) joins the conviction signals. */
  ruleBook: boolean;
  /** The evolved formulas (research/gpIndicators.ts champions) join the conviction signals; only validated
   *  ones unless gpRequireValidated is false (paper mode only). */
  gp: boolean;
  gpRequireValidated: boolean;
  /** Weight of the TA network's validated volatility forecast in the pricing sigma (0 = off, 1 = fully). */
  taVolWeight: number;
  modelHealthMinWindows: number;
  huntTargetMargin: number;
  huntMinConfluence: number;
  /** HUNT_HYBRID: in hunt mode a triggered stop sells only when the model agrees the contract is worth less than the stop
   *  plus the fee (bot/strategy/exitPolicies.ts); off by default. */
  huntHybrid: boolean;
  /** HUNT_SELL_INTO_GAP: off, a gap through the hunt stop never sells (the lock waits for the bid to come back). */
  huntSellIntoGap: boolean;
  /** HUNT_LOCK_SALE: off | fair_value | flow | either | both. Judge the hunted position once instead of trailing a stop that
   *  sells every dip: sell the whole position at the bid when the bid is at least the math fair value plus
   *  HUNT_LOCK_SALE_FV_MARGIN (0.02) and/or the last minute's Kalshi taker flow favours the held side. HUNT_LOCK_SALE_AT
   *  (lock | trigger) says when: right at the lock, or (default) the first time the bid sits under the ratchet's stop.
   *  HUNT_LOCK_SALE_ELSE (hold | exit; exit by default since Oct 29 23:00 UTC: the profit mandate never
   *  holds a hunted position to settlement) when the rule does not hit. fair_value by default (Oct 29): on the replayed days it is
   *  never worse than the trailing stop (+$39 on Oct 28, level on Oct 27) and level with holding, on half the contracts. */
  huntLockSale: 'off' | 'fair_value' | 'flow' | 'either' | 'both';
  huntLockSaleFvMargin: number;
  huntLockSaleElse: 'hold' | 'exit';
  huntLockSaleAt: 'lock' | 'trigger';
  /** HUNT_WALL_ASK: while the hunt's stop walks up, rest the position's sell at a top-of-book sell wall on our side (the best
   *  ask's size at least HUNT_WALL_ASK_RATIO x the best bid's and the position, its price at least the fair value plus
   *  HUNT_LOCK_SALE_FV_MARGIN), post-only behind the wall, until it fills or the lock sale's judgement cancels it. On by
   *  default since Oct 29 23:00 UTC (Steven's multi-day paper run of the rule); the exit study measured it level with the
   *  judgement alone (+9 / +98 vs +8 / +106 against holding on the recorded days). */
  huntWallAsk: boolean;
  huntWallAskRatio: number;
  ratchetMinFillRatio: number;
  ratchetMinWallAgeSec: number;
  ratchetSlippageTicks: number;
  /** Per-session risk multipliers (can only reduce risk). */
  sessionRisk: SessionRiskProfile;
  /** Apply the pipeline's session_risk.json under SESSION_RISK (bot/model/sessionRisk.ts). */
  sessionRiskAuto: boolean;
  sessionRiskPath: string;
  /** Block hunt mode in twilight/weekend liquidity and near session changes. */
  huntSessionGuard: boolean;
  huntTransitionBufferMin: number;
  /** Apply a fitted, validated intraday volatility profile to fair value. */
  volSeasonality: boolean;
  volProfilePath: string;
  /** Tree-based volatility forecast (research:vol-train): applied to fair value once validated. */
  volModel: boolean;
  volModelPath: string;
  /** Sigma multiplier for fair value while no validated vol forecast is in use (1 = off). */
  volFallbackMult: number;
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
  /** Balance precision for fee rounding: 0.01 for non-direct (FCM-cleared) members, 0.0001 for direct members. The
   *  starting point only: the fee check learns the account's grid from the fees Kalshi charges on live fills. */
  kalshiBalancePrecision: number;
  /** Kalshi's published fee schedule (bot/kalshi/feeSchedule.ts), read at start and every KALSHI_FEE_SCHEDULE_HOURS. */
  feeSchedule: { check: boolean; url: string; hours: number };
  /** LIVE_ALLOW_UNVALIDATED_MODEL (default true, the owner's choice on Oct 23): the model's validation never blocks a
   *  binary crypto order in live. Entries, exits and ratchet stops go out whether or not the model passed validation or
   *  its probation is benched; every other limit still applies. false: live entries (and ratchet stops) wait for a
   *  validated model or an open probation; an exit always goes out. */
  liveAllowUnvalidated: boolean;
  /** VALIDATION_GATES=monitor (default): models that have not passed validation trade anyway, on probation; a book whose
   *  results are unacceptable is benched (bot/risk/probation.ts). enforce: every validation gate blocks as before. */
  probation: ProbationParams;
  /** SINUOUS_EXIT, the same in paper and live: cross (default) sells on a confirmed cross (SINUOUS_CROSS) and holds
   *  nothing (bot/strategy/sinuousExit.ts); gate holds a profit-taking exit for the curve's signal; monitor shows the
   *  curve without holding exits; rest also rests a sell at the swing top; off. */
  sinuousExit: SinuousExitParams;
  /** SINUOUS_ENTRY=monitor (default): score maker entry fills by whether the order-book curve was moving against the side
   *  bought (bot/strategy/sinuousEntry.ts), blocking nothing; gate: no quote that adds to a position while it is; off. */
  sinuousEntry: SinuousEntryParams;
  /** TRIALS (default on): the trained model, the rule book, the SNN and the TA network each scored against the price
   *  without them on every settled crypto contract; one that tests significantly better goes into paper's prices, one
   *  significantly worse comes out, never in live's (bot/strategy/componentTrials.ts). */
  trials: TrialParams;
  /** SCOREBOARD (default on): every price (math fair value, meta-model, the bot's, the SNN's, the TA tilt) scored against the
   *  Kalshi market on every settled crypto contract, paper and live alike (bot/health/scoreboard.ts). */
  scoreboard: ScoreboardParams;
  host: string;
  port: number;
  /** DASHBOARD_PASSWORD: '' (default) = the dashboard opens without a login. */
  dashboardPassword: string;
  dataDir: string;
  /** Where the money state lives (orders and positions, vault, break-even, balance history, perps trades, the
   *  Kalshi check): DATA_DIR in paper, DATA_DIR/live in live, so the paper pool and its positions never show or
   *  count in live mode, and a switch back to paper finds the paper books as they were. */
  bookDir: string;
  /** Audit log: a day's file splits into parts at this size; files older than the retention are deleted. */
  auditMaxFileMb: number;
  auditRetentionDays: number;
  paramsPath: string;
  /** The paper Kalshi pool (Steven, Oct 30: $200): what paper starts with and refills to; raising it tops the pool up once
   *  (bot/training/supervisor.ts). */
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
  /** The server's env file, rewritten by the dashboard's PAPER / LIVE switch (BOT_ENV_FILE, default ~/bot/bot.env). */
  botEnvFile: string;
  clockSkewWarnMs: number;
  /** Settlement average: official = sixty one-per-second RTI values; continuous = time-weighted step average. */
  settlementAvg: 'official' | 'continuous';
  /** Output of `npm run research:ta` (measured hit rates per rule), shown with live signals. */
  taStudyPath: string;
  coinbaseRestUrl: string;
  /** Coinbase public trade feed (taker order flow for the candles) and its URL. */
  takerFlow: boolean;
  /** Record Coinbase's spot order book (top spotBookDepth levels a side) for every tracked coin every this many seconds
   *  (SPOT_BOOK_RECORD_SEC; 0 = off): the depth the exit and sizing research needs, which the recordings lacked. */
  spotBookRecordSec: number;
  spotBookDepth: number;
  /** Also record the whole spot book's size in SPOT_BOOK_BANDS bands SPOT_BOOK_BAND_BPS wide out from the mid
   *  (defaults 10 x 10 bps = out to 1%), so walls past the top levels are kept; 0 bands = off. */
  spotBookBandBps: number;
  spotBookBands: number;
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
  /** Apply the conditioning champion's settings (<AUTO_TRAIN_DIR>/conditioning_champion.json) at startup. */
  conditioningApply: boolean;
  /** Run on the strategy playbook (bot/strategy/playbook.ts: per coin regime, the Kalshi / perps weights) when it passed validation. */
  playbookApply: boolean;
  /** Run on the Compensator (bot/strategy/compensator.ts: per strategy, a ramp on the coin's Librarian reading) when it passed validation. */
  compensatorApply: boolean;
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
  /** Optimal f cap on Kelly sizing (bot/strategy/optimalF.ts). */
  optimalF: OptimalFConfig;
  /** Fractal Alignment Engine and waterfall mode (bot/macro). */
  macro: MacroConfig;
}

export interface MacroConfig {
  /** The parent window [from, to) and the child's start (UTC ms; FAE_PARENT_FROM / FAE_PARENT_TO / FAE_CHILD_FROM). */
  parentFrom: number;
  parentTo: number;
  childFrom: number;
  /** Waterfall mode (bot/macro/waterfall.ts). */
  waterfall: { gate: number; minFit: number; leadWeeks: number; shibVelocity: number; kalshiMaxFrac: number; altLongMult: number; btcMult: number; lowBufferPts: number };
}

export interface OptimalFConfig {
  enabled: boolean;
  /** Bootstrap quantile of the growth-optimal fraction used as the cap (0.25 = its 25th percentile). */
  quantile: number;
  /** Recency half-life of a trade's weight (days). */
  halfLifeDays: number;
  /** A live (or paper) trade counts this many backtested ones. */
  liveMult: number;
  /** Trades needed before a cap applies: setup lanes (backtest + live), Kalshi (settled positions). */
  minTradesSetups: number;
  minTradesKalshi: number;
  /** Paper: the cap never goes below this share of the configured risk (keeps collecting evidence). */
  paperFloor: number;
}

export interface TaNetConfig {
  /** Compute the TA network's forecasts as features (they are only used by models that validated them). */
  enabled: boolean;
  modelPath: string;
  /** The Librarian (bot/ta/librarian.ts: oracle strategy and regime-transition heads on the TA network's inputs). */
  librarianPath: string;
  /** The cross-asset graph network (bot/ta/crossGraph.ts) and its training engine (XG_ENGINE: ts | torch | auto). */
  crossGraphPath: string;
  xgEngine: 'ts' | 'torch' | 'auto';
  /** The cross-coin lead-lag study (bot/ta/crossLead.ts): the Kalshi features', the setup scorer's and its exit's source. */
  crossLeadPath: string;
  /** Only heads that beat the naive forecast in the blind walk-forward test speak (default true). */
  requireValidated: boolean;
  /** Versions in the performance-weighted ensemble (bot/ta/taNetEnsemble.ts): the live network plus up to N-1 archived ones (1 = off). */
  ensemble: number;
  /** Historical candles (data/history/<source>/<ASSET>/<tf>.csv). */
  historyDir: string;
  /** Pipeline: refresh history from Binance Vision + Coinbase before training (needs internet). */
  historyUpdate: boolean;
  /** Fill history holes and keep the TradingView index series (BTC.D, USDT.D, TOTAL3, OTHERS.D, RTY) with tvdatafeed (TV_FILL). */
  tvFill: boolean;
  /** Minutes the history step may spend on Kalshi's settled-contract candles per run (the rest resumes next
   *  run); 0 = skip them. */
  kalshiHistoryBudgetMin: number;
  /** Days of Kalshi's settled contracts to download (the laptop trainer asks for a year). */
  kalshiHistoryDays: number;
  /** Assets to collect: "auto" = every crypto asset Kalshi lists (binary series + perps), or a list. */
  historyAssets: string;
  /** Binance intervals to download, and Coinbase timeframes to backfill. */
  binanceIntervals: string[];
  coinbaseTfs: string[];
  /** A history source (Binance series, Coinbase series, Kalshi contract series) checked completely within this
   *  many hours is not asked again (0 = check everything every run). */
  historyRecheckHours: number;
  /** History replay (research/history/historyReplay.ts): years of 1-minute spot and perp history turned into
   *  recordings the recording-based steps replay like live data (HISTORY_REPLAY; the laptop trainer turns it on). */
  historyReplay: boolean;
  /** Years of history to replay, back from yesterday (0 = all of it: from each coin's first Binance minute). */
  historyReplayYears: number;
  historyReplayDir: string;
  historyReplayAssets: string[];
  /** Retrain the network at most every N days (and whenever it is missing). */
  retrainEveryDays: number;
  /** Network layout trained by the pipeline: flat, or grouped (indicator families; TA_NET_ARCH). */
  arch: 'flat' | 'grouped';
  /** Training engine (TA_NET_ENGINE): ts, torch (PyTorch, on the GPU when there is one: python/tanet) or auto (torch
   *  when a Python with PyTorch starts, else ts). The live bot always runs the network in TypeScript. */
  engine: 'ts' | 'torch' | 'auto';
  /** Python interpreter for the torch engine (TA_NET_PYTHON; default python3 / python). */
  python: string;
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
  /** Networks in the tournament (6+ split into islands that breed: AUTO_TRAIN gaIslands). */
  population: number;
}

export interface AutoTrainConfig {
  /** remote (default: the pipeline runs on GitHub Actions (.github/workflows/train.yml) and copies the
   *  models into AUTO_TRAIN_DIR; the bot never trains itself, it only hot-reloads them) | background
   *  (trains beside trading at the lowest CPU priority, frozen while the machine is under pressure) |
   *  daily (once a day at hourUtc) | windows (once a day, only inside session-edge windows) | off. */
  mode: 'off' | 'daily' | 'windows' | 'background' | 'remote';
  hourUtc: number;
  /** Background mode: start a new run this many hours after the last completed one. */
  everyHours: number;
  /** Background mode: wait this long after the bot starts before training (let trading warm up). */
  startDelayMin: number;
  /** Background mode: freeze training while the trading loop lags more than this (p99, ms)... */
  maxLoopLagMs: number;
  /** ...or less than this much memory is available (MB)... */
  minAvailableMb: number;
  /** ...or the host steals more than this share of CPU time (burstable CPU out of credits). */
  maxStealFrac: number;
  /** Where the pipeline writes promoted models; the bot prefers these over params/ and hot-swaps them. */
  dir: string;
  recordingsDir: string;
  /** Recorded days kept uncompressed, today included (1 = yesterday is gzipped right after midnight; 0 = never gzip);
   *  readers handle both forms. */
  recordingsGzipAfterDays: number;
  /** Alert when free disk space where the recordings live drops below this (GB); with recordingsPrune the
   *  oldest recorded days are then deleted until twice this is free. */
  recordingsMinFreeGb: number;
  /** Delete the oldest recorded days when the disk runs low (the newest two days are kept unless the disk is nearly
   *  full, then only today). */
  recordingsPrune: boolean;
  /** Write each day's recording as gzip while it is recorded (a gzip member every few seconds: about a tenth of the
   *  plain size at every hour); false = plain until midnight, then gzipped (takes effect from the next new day file). */
  recordingsGzipLive: boolean;
  /** Recorded days kept, today included (0 = no cap; at least 2): older days are deleted (the disk floor still applies). */
  recordingsKeepDays: number;
  /** always = promote every freshly trained model (hot-swap mode); validated = only models whose
   *  validation passed (MLP: validation.passed; perps: validated(); SNN: its stage accepted). */
  promote: 'always' | 'validated';
  /** Champion / challenger (research/champion.ts): a retrained model replaces the live one only if it is at least as good; replaced models are archived. */
  champion: boolean;
  /** auto = highest stage whose whole chain S1..Sk the ablation accepted (else SNN_STAGE). */
  snnStage: 'auto' | 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6';
  ablationDays: number;
  ablationEveryDays: number;
  snnTrainDays: number;
  /** Re-run the SNN steps automatically whenever the meta-model changes (e.g. a manual swap). */
  onModelChange: boolean;
  /** Skip a retrain step when nothing it reads changed since its last completed run (AUTO_TRAIN_SKIP_UNCHANGED). */
  skipUnchanged: boolean;
  /** Sweep optimizer (research/sweep.ts): targets run by the pipeline, hours per target, and how often. */
  sweepTargets: string[];
  sweepHours: number;
  /** Time budget per run for the TA network's walk-forward export (it resumes on the next run). */
  taNetOosHours: number;
  sweepEveryDays: number;
  /** The Kalshi and whole-bot sweeps run on the most recent this many replay (or recorded) days. */
  sweepKalshiDays: number;
  /** Minimum days of recordings before anything is trained. */
  minDays: number;
  /** The vol forecast, the dataset and the MLP candidate's backtest read only the newest this many recorded days
   *  (0 = all). Each of them replays every recorded day it reads; the remote runner sets 4 to stay inside its time. */
  decisionDays: number;
  /** Poll interval for model-file changes (hot reload). */
  watchSec: number;
  /** SNN population tournaments (crypto, perps): recorded days replayed, initial training block,
   *  rounds per pipeline run (0 = all), and how often the tournament is re-run (0 = only at init). */
  snnPbtDays: number;
  snnPbtInitDays: number;
  snnPbtMaxRounds: number;
  /** Networks in each SNN tournament (3 = the original trio; the laptop trainer uses about one per core). */
  snnPbtPopulation: number;
  snnPbtEveryDays: number;
  /** Exploration member: every N tournament rounds the worst SNN restarts from scratch with random
   *  knobs instead of copying the elite (0 = never). */
  snnPbtRestartEvery: number;
  /** Held-out weeks a challenger SNN replays against the network in use before it may replace it (history
   *  replay; research/historyLedger.ts). */
  contestWeeks: number;
  /** Where the continuous trainer stops (research/readiness.ts): the whole bot, on held-out days and a pool of
   *  targetPoolUsd, earning at least targetDailyPct of the pool a day (the 95% interval's lower end, not
   *  just the mean) with a drawdown of at most targetMaxDdPct; or plateauRounds rounds in a row without
   *  progress (no model promoted, no better readiness). */
  targetPoolUsd: number;
  targetDailyPct: number;
  targetMaxDdPct: number;
  plateauRounds: number;
  /** Genetic layer of every tournament with 6+ networks (research/genetic.ts): every gaBreedEvery rounds the
   *  gaParents best survivors over the generation breed (one offspring per pair, knobs crossed and mutated
   *  by gaMutation, a log-normal sd: 0.03 is about +/-3%) and the offspring replace the worst. gaIslands > 1
   *  splits the population into separate tournaments whose winners breed instead (slower on noisy scores). */
  gaParents: number;
  gaIslands: number;
  gaBreedEvery: number;
  gaMutation: number;
  /** Genetic programming of trading formulas (research/gpIndicators.ts): every gpEveryDays (0 = every run) a
   *  population of gpPopulation random formulas per coin (gpAssets; empty = BTC, ETH, SOL, XRP, DOGE) over the
   *  coin's and the cross-market coins' (gpCross) hourly bars evolves for gpGenerations generations; fitness
   *  gpFitness (sharpe, or return: the video's e^(-return)) after gpCostBps per unit of exposure traded and a
   *  gpBand dead band; a champion is validated when its test probabilistic Sharpe is at least gpMinPsr. */
  gpEveryDays: number;
  gpPopulation: number;
  gpGenerations: number;
  gpAssets: string[];
  gpCross: string[];
  gpFitness: 'sharpe' | 'return';
  gpCostBps: number;
  gpBand: number;
  gpMinPsr: number;
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
  /** SNN_ANCHOR_MID: the contract readouts start from the market's mid and learn the correction (bot/snn/network.ts
   *  anchorLogit). Default on (Steven, Oct 30); crypto network only (params.ts anchorFor). A new version hash, so the
   *  crypto network starts fresh when it flips. */
  anchorMid: boolean;
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
  /** Steven's profit rules on tennis (Oct 30): in the last share of the match by its progress (0.30: his "less than 30%"
   *  for tennis, against the 10% of a crypto contract's window, STRATEGY_NO_EXIT_BEFORE_CLOSE_FRAC) a position in profit
   *  after fees rides to settlement; elsewhere the quota snipe applies as on every contract type. 0 = off. */
  settleFrac: number;
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
  /** Liquidation beyond the stop (bot/risk/liquidation.ts): the stop may use at most (1 - buffer) of the room to
   *  liquidation (PERP_LIQ_BUFFER), and the maintenance margin rate (PERP_MAINT_MARGIN; 0 = half the initial margin
   *  implied by the exchange's leverage estimate). */
  liqBuffer: number;
  maintMargin: number;
  /** The 4h ATR ratchet exit for setup trades (bot/setups/detectors.ts RATCHET; recorded in the setup model, so the
   *  live trader manages trades exactly as they were trained): SETUP_RATCHET (off | slow (default) | fast | both), the initial
   *  stop, break-even plus fees, and the trail, all in 4h ATRs. */
  setupRatchet: 'off' | 'slow' | 'fast' | 'both';
  setupRatchetStopAtr: number;
  setupRatchetBeAtr: number;
  setupRatchetTrailStartAtr: number;
  setupRatchetTrailAtr: number;
  /** SETUP_RATCHET_VOL_K: the unit is ATR(4h) x exp(k x the TA network's 4h volatility forecast); 0 = plain ATR(4h). */
  setupRatchetVolK: number;
  /** Scale-out exits for setup trades (bot/setups/detectors.ts SCALE_OUT; recorded in the setup model): SETUP_SCALE_OUT
   *  (off (default) | slow | fast | both), then the two steps (R multiple, share of the original position; f2 = 0: one
   *  step) and the trail of the rest in ATRs. Adopt it from the setups-scale sweep's proposal. */
  setupScaleOut: 'off' | 'slow' | 'fast' | 'both';
  setupScaleR1: number; setupScaleF1: number; setupScaleR2: number; setupScaleF2: number; setupScaleTrailAtr: number;
  /** SETUP_SPOT_PB: the spot pullback setups (bot/setups/detectors.ts spotpb), for the coins where Coinbase spot leads
   *  the Kalshi perp by the weekly lead-lag study; off until adopted from the setups-spotpb sweep. */
  setupSpotPb: 'off' | 'on';
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

/** The hourly quota pacer's settings (PACER_*, bot/risk/quotaPacer.ts). */
function pacerConfig(env: Env): PacerConfig {
  const tz = (env.PACER_TZ ?? 'America/New_York').trim() || 'America/New_York';
  if (!validZone(tz)) throw new Error(`PACER_TZ ${tz} is not a time zone this Node knows`);
  const minTakeUsd = num(env, 'PACER_MIN_TAKE_USD', 0.75, 0, 10_000);
  return {
    enabled: bool(env, 'PACER', true),
    // Off by default since Oct 30: in the exit lab (Oct 24-28, every position) the group sold winners the pacer alone would
    // have kept and made less on 4 of the 5 days (+$163 against +$222 without it).
    group: bool(env, 'PACER_GROUP', false),
    hourlyUsd: num(env, 'PACER_HOURLY_USD', 4.5, 0, 10_000),
    anchorHour: Math.floor(num(env, 'PACER_ANCHOR_HOUR', 10, 0, 23)),
    anchorMinute: Math.floor(num(env, 'PACER_ANCHOR_MINUTE', 0, 0, 59)),
    tz,
    mode: oneOf(env, 'PACER_MODE', 'slices', ['slices', 'cumulative', 'rolling_hour'] as const),
    minTakeUsd,
    maxTargetUsd: Math.max(minTakeUsd, num(env, 'PACER_MAX_TARGET_USD', 6.5, 0, 10_000)),
    // Steven (Oct 31): under a higher target the quota is the position's stop, not its sale.
    floor: oneOf(env, 'PACER_FLOOR', 'riding', ['off', 'targets', 'riding'] as const),
    // Paired replays of Oct 29-30 (Oct 31): a floor armed at the profit just reached sold winners on a one-tick dip. Under
    // today's other rules a cushion of 8 ticks a contract made $262 and $238 a day more than none (two batches, 5 bankrolls
    // of 5 each); with the loser exits of PR #230, 16 ticks made $88 a day more than none.
    floorTicks: num(env, 'PACER_FLOOR_TICKS', 8, 0, 50),
  };
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

function isoDate(env: Env, key: string, def: string): number {
  const raw = env[key] || def;
  const t = Date.parse(`${raw}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(t)) throw new ConfigError(`${key}=${raw} must be a date YYYY-MM-DD`);
  return t;
}

/** The Fractal Alignment Engine and waterfall settings (also read by the setup trainer, so both agree). */
export function macroConfig(env: Env = process.env): MacroConfig {
  const parentFrom = isoDate(env, 'FAE_PARENT_FROM', '2016-01-01'), parentTo = isoDate(env, 'FAE_PARENT_TO', '2018-01-01'), childFrom = isoDate(env, 'FAE_CHILD_FROM', '2018-01-01');
  if (!(parentTo - parentFrom >= 180 * 86_400_000) || childFrom < parentTo) throw new ConfigError('FAE_PARENT_FROM < FAE_PARENT_TO (at least 180 days) <= FAE_CHILD_FROM');
  return {
    parentFrom, parentTo, childFrom,
    waterfall: {
      gate: num(env, 'WATERFALL_GATE', 55, 20, 90),
      minFit: num(env, 'WATERFALL_MIN_FIT', 0.8, 0, 1),
      leadWeeks: num(env, 'WATERFALL_LEAD_WEEKS', 8, 0, 104),
      shibVelocity: num(env, 'WATERFALL_SHIB_VELOCITY', 2, 1, 50),
      kalshiMaxFrac: num(env, 'WATERFALL_KALSHI_MAX_FRAC', 0.125, 0, 0.25),
      altLongMult: num(env, 'WATERFALL_ALT_LONG_MULT', 1.5, 1, 2),
      btcMult: num(env, 'WATERFALL_BTC_MULT', 0.5, 0, 1),
      lowBufferPts: num(env, 'WATERFALL_LOW_BUFFER_PTS', 3, 0, 20),
    },
  };
}

/** Settings for research and training runs, which always simulate: paper mode, and live-only settings (live perps) turned
 *  into their paper twins, so a copy of a live server's bot.env trains instead of failing to load. */
export function paperEnv(env: Env): Env {
  const out: Env = { ...env, TRADING_MODE: 'paper', DASHBOARD_TOKEN: env.DASHBOARD_TOKEN ?? 'x'.repeat(32) };
  for (const k of ['PERP_HEDGE', 'PERP_TRADING']) if (out[k] === 'live') out[k] = 'paper';
  return out;
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
    // Order submissions a minute (cancels apart). 120, owner-approved Oct 22: a fifth of Kalshi's Basic-tier write budget
    // (100 tokens a second at 10 a write: 600 writes a minute), so creates plus the cancels that go with them stay well
    // inside it; the REST client's own limiter holds every write to that budget anyway (bot/kalshi/rateLimiter.ts).
    maxOrdersPerMinute: num(env, 'RISK_MAX_ORDERS_PER_MIN', 120, 1, 600),
    maxOpenOrders: num(env, 'RISK_MAX_OPEN_ORDERS', 12, 1, 200),
    // Paper uses live's limits (since Oct 23, so paper trades only on data live would trade on: paper resting orders
    // fill from Kalshi's real trades, so a stale book meant quotes live would never have had there). Until then paper
    // tolerated 30 s / 15 s to keep training going while a busy server delivered feed messages late.
    maxBookAgeMs: num(env, 'RISK_MAX_BOOK_AGE_MS', 5000, 250, 120000),
    maxFeedLagMs: num(env, 'RISK_MAX_FEED_LAG_MS', 3000, 0, 120000),
    maxIndexAgeMs: num(env, 'RISK_MAX_INDEX_AGE_MS', 3000, 250, 120000),
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
    // Quotes stay fresh (a stale bid is the one that gets picked off): pulled on a 2-sigma move, re-priced every 10 s.
    fastMoveSigmas: num(env, 'STRATEGY_FAST_MOVE_SIGMAS', 2, 0.5, 20),
    fastMoveWindowSec: num(env, 'STRATEGY_FAST_MOVE_WINDOW_SEC', 5, 1, 120),
    dynamicEdge: {
      vol: num(env, 'DYN_EDGE_VOL', 0, -0.2, 0.2),
      change: num(env, 'DYN_EDGE_CHANGE', 0, 0, 0.2),
      spread: num(env, 'DYN_EDGE_SPREAD', 0, 0, 2),
      flow: num(env, 'DYN_EDGE_FLOW', 0, 0, 0.2),
      uncertainty: num(env, 'DYN_EDGE_UNCERTAINTY', 0, 0, 2),
      maxUp: num(env, 'DYN_EDGE_MAX_UP', 0.05, 0, 0.3),
      maxDown: num(env, 'DYN_EDGE_MAX_DOWN', 0.01, 0, 0.1),
    },
    regimeScale: {
      volTarget: num(env, 'REGIME_VOL_TARGET', 0, 0, 2),
      changeDerisk: num(env, 'REGIME_CHANGE_DERISK', 0, 0, 1),
      corrDerisk: num(env, 'REGIME_CORR_DERISK', 0, 0, 2),
      min: num(env, 'REGIME_SCALE_MIN', 0.25, 0, 1),
      max: num(env, 'REGIME_SCALE_MAX', 1.5, 1, 2),
      upWeight: num(env, 'REGIME_UP_WEIGHT', 0.5, 0, 1),
    },
    // 20 s: a quote the bot stops tending is gone from the exchange within 20 s. Re-placing the ones still wanted costs
    // orders, which RISK_MAX_ORDERS_PER_MIN (120) now has room for.
    orderTtlSec: num(env, 'STRATEGY_ORDER_TTL_SEC', 20, 10, 900),
    // Sell for profit once the bid beats the model's value, and let winners run on the confluence ratchet.
    exitPolicy: oneOf(env, 'EXIT_POLICY', 'confluence_ratchet', ['hold', 'fair_value', 'take_profit', 'confluence_ratchet'] as const),
    exitMargin: num(env, 'STRATEGY_EXIT_MARGIN', 0.01, 0, 0.5),
    takeProfit: num(env, 'STRATEGY_TAKE_PROFIT', 0.08, 0.01, 0.5),
    // Take-profit (owner's spec, Oct 22): winners run. Armed at 10% of what the contract cost (at least 2c) net of every
    // fee, then sold when a third of the best gain is given back, never below that floor.
    profitTarget: num(env, 'PROFIT_TARGET_CENTS', 2, 0, 50) / 100,
    profitTargetPct: num(env, 'PROFIT_TARGET_PCT', 0.10, 0, 1),
    profitGiveBack: num(env, 'PROFIT_GIVE_BACK', 1 / 3, 0, 1),
    // The owner, Oct 24: the take-profit goes on the exit curve's scoreboard and bench (it sold winners for $230 less
    // than holding them on Oct 23-24).
    takeProfitBench: bool(env, 'TAKE_PROFIT_BENCH', true),
    cadence,
    evalBarSec: num(env, 'STRATEGY_EVAL_BAR_SEC', 60, 5, 600),
    evalFvMove: num(env, 'STRATEGY_EVAL_FV_MOVE', 0.015, 0.001, 0.2),
    repriceSec: num(env, 'STRATEGY_REPRICE_SEC', 10, 5, 600),
    minEvalIntervalSec: num(env, 'STRATEGY_MIN_EVAL_INTERVAL_SEC', 10, 0, 120),
    // No new entries in a 15-minute contract's last 5 minutes or an hourly one's last 10: time to sell before the final minute.
    entryWindowUpdown: window(env, 'ENTRY_WINDOW_15M', relaxed ? [840, 300] : [900, 15]),
    entryWindowHourly: window(env, 'ENTRY_WINDOW_HOURLY', relaxed ? [3300, 600] : [3600, 15]),
    hourlyMidBand: band(env, 'HOURLY_MID_BAND', [0.1, 0.9]),
    noExitBeforeCloseSec: num(env, 'STRATEGY_NO_EXIT_BEFORE_CLOSE_SEC', relaxed ? 60 : 0, 0, 600),
    noExitBeforeCloseFrac: num(env, 'STRATEGY_NO_EXIT_BEFORE_CLOSE_FRAC', 0.10, 0, 0.9),
    shareWindowMaxSec: num(env, 'STRATEGY_SHARE_WINDOW_MAX_SEC', 3600, 0, 7 * 86_400),
    pacer: pacerConfig(env),
    loserExits: {
      gate: bool(env, 'FV_ENTRY_GATE', true),
      gateMargin: num(env, 'FV_ENTRY_GATE_MARGIN', 0.06, 0, 0.5),
      ...(env.FV_ENTRY_GATE_QUOTE_MARGIN !== undefined && env.FV_ENTRY_GATE_QUOTE_MARGIN !== '' ? { gateQuoteMargin: num(env, 'FV_ENTRY_GATE_QUOTE_MARGIN', 0.06, 0, 0.5) } : {}),
      cut: bool(env, 'LOSER_CUT', true),
      cutMargin: num(env, 'LOSER_CUT_MARGIN', 0.03, 0, 0.5),
      window: bool(env, 'LOSER_WINDOW_CUT', true),
      windowJudge: oneOf(env, 'LOSER_WINDOW_JUDGE', 'bid', ['bid', 'fair', 'cost'] as const),
      windowShare: num(env, 'LOSER_WINDOW_SHARE', 0, 0, 0.9),
      noEntryShare: num(env, 'LOSER_NO_ENTRY_SHARE', 0, 0, 0.9),
    },
    profitMandate: bool(env, 'PROFIT_MANDATE', false),
    profitMandateMin: num(env, 'PROFIT_MANDATE_MIN', 0.01, 0, 0.5),
    // Maker discount for the measured adverse move a minute after a fill: at least 1.5c, up to 3c.
    makerBuffer: num(env, 'STRATEGY_MAKER_BUFFER', relaxed ? 0.02 : 0, 0, 0.1),
    makerBufferRange: band(env, 'STRATEGY_MAKER_BUFFER_RANGE', relaxed ? [0.015, 0.03] : [0, 0]),
    minQuoteContracts: num(env, 'STRATEGY_MIN_QUOTE_CONTRACTS', 3, 0, 100),
    paperOrderUsd: num(env, 'PAPER_ORDER_USD', 0, 0, 1000),
    paperOrderFrac: num(env, 'PAPER_ORDER_FRAC', 0, 0, 1),
    orderUsdMin: num(env, 'ORDER_USD_MIN', 10, 0, 1000),
    orderUsdMax: num(env, 'ORDER_USD_MAX', 20, 0, 1000),
    accuracyGate: { enabled: bool(env, 'ACCURACY_GATE', true), window: num(env, 'ACCURACY_GATE_WINDOW', 150, 20, 2000), minMarkets: num(env, 'ACCURACY_GATE_MIN_MARKETS', 40, 5, 1000) },
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
    paperExplore: bool(env, 'PAPER_EXPLORE', false),
    exploreRate: num(env, 'PAPER_EXPLORE_RATE', 0.1, 0, 1),
    exploreBand: num(env, 'PAPER_EXPLORE_BAND', 0.02, 0, 0.1),
    exploreMaxPerHour: num(env, 'PAPER_EXPLORE_MAX_PER_HOUR', 6, 0, 120),
    trainTrades: num(env, 'TRAINING_TRADES_PER_HOUR', 12, 0, 120),
    idleEvalSec: num(env, 'EVAL_IDLE_SEC', 5, 0, 60),
    outsidePriceFallback: bool(env, 'PAPER_OUTSIDE_PRICE_FALLBACK', false),
    adversarialBoost: bool(env, 'ADVERSARIAL_BOOST', true),
    adversarialMaxBoost: num(env, 'ADVERSARIAL_MAX_BOOST', 2, 1, 2),
    taPricing: bool(env, 'TA_PRICING', true),
    taPricingWeight: num(env, 'TA_PRICING_WEIGHT', 1, 0, 2),
    taPricingMaxShift: num(env, 'TA_PRICING_MAX_SHIFT', 0.06, 0, 0.2),
    taPricingMaxZ: num(env, 'TA_PRICING_MAX_Z', 0.5, 0.05, 1.5),
    altBoost: num(env, 'ALT_RISKON_BOOST', 2.5, 1, 3),
    altUsdtdMaxZ: num(env, 'ALT_USDTD_MAX_Z', 0, -5, 5),
    altRsiMin: num(env, 'ALT_RSI_MIN', 50, 0, 100),
    nonAlts: (env.NON_ALTCOINS ?? 'BTC').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
    convictionMaxTotal: num(env, 'CONVICTION_MAX_TOTAL', 2.5, 1, 5),
    characterStandAside: bool(env, 'CHARACTER_STAND_ASIDE', true),
    ruleBook: bool(env, 'RULE_BOOK', true),
    gp: bool(env, 'GP_SIGNAL', true),
    gpRequireValidated: bool(env, 'GP_REQUIRE_VALIDATED', true),
    taVolWeight: num(env, 'TA_VOL_WEIGHT', 0.5, 0, 1),
    modelHealthMinWindows: num(env, 'MODEL_HEALTH_MIN_WINDOWS', 200, 20, 100000),
    huntTargetMargin: num(env, 'HUNT_TARGET_MARGIN', 0.02, 0, 0.5),
    huntMinConfluence: num(env, 'HUNT_MIN_CONFLUENCE', 2, 1, 7),
    huntHybrid: bool(env, 'HUNT_HYBRID', false),
    huntSellIntoGap: bool(env, 'HUNT_SELL_INTO_GAP', true),
    huntLockSale: oneOf(env, 'HUNT_LOCK_SALE', 'fair_value', ['off', 'fair_value', 'flow', 'either', 'both'] as const),
    huntLockSaleFvMargin: num(env, 'HUNT_LOCK_SALE_FV_MARGIN', 0.02, -0.2, 0.2),
    huntLockSaleElse: oneOf(env, 'HUNT_LOCK_SALE_ELSE', 'exit', ['hold', 'exit'] as const),
    huntLockSaleAt: oneOf(env, 'HUNT_LOCK_SALE_AT', 'trigger', ['lock', 'trigger'] as const),
    huntWallAsk: bool(env, 'HUNT_WALL_ASK', true),
    huntWallAskRatio: num(env, 'HUNT_WALL_ASK_RATIO', 3, 1, 1000),
    ratchetMinFillRatio: num(env, 'RATCHET_MIN_FILL_RATIO', 1, 0.1, 20),
    ratchetMinWallAgeSec: num(env, 'RATCHET_MIN_WALL_AGE_SEC', 3, 0, 120),
    ratchetSlippageTicks: num(env, 'RATCHET_SLIPPAGE_TICKS', 1, 0, 10),
    sessionRisk: (() => { try { return parseSessionRisk(env.SESSION_RISK); } catch (e) { throw new ConfigError((e as Error).message); } })(),
    huntSessionGuard: bool(env, 'HUNT_SESSION_GUARD', true),
    huntTransitionBufferMin: num(env, 'HUNT_TRANSITION_BUFFER_MIN', 10, 0, 120),
    sessionRiskAuto: bool(env, 'SESSION_RISK_AUTO', true),
    sessionRiskPath: path.resolve(env.SESSION_RISK_PATH ?? './params/session_risk.json'),
    volSeasonality: bool(env, 'VOL_SEASONALITY', true),
    volProfilePath: path.resolve(env.VOL_PROFILE_PATH ?? './params/vol_profile.json'),
    volModel: bool(env, 'VOL_MODEL', true),
    volModelPath: path.resolve(env.VOL_MODEL_PATH ?? './params/vol_model.json'),
    // Until the vol forecast trains: the live EWMA sigma ran 1.3-2x low on volatile days; 1.15 scored best over Oct 20-22.
    volFallbackMult: num(env, 'VOL_FALLBACK_MULT', 1.15, 0.5, 2),
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
    feeSchedule: {
      check: bool(env, 'KALSHI_FEE_SCHEDULE_CHECK', true),
      url: env.KALSHI_FEE_SCHEDULE_URL?.startsWith('https://') ? env.KALSHI_FEE_SCHEDULE_URL : FEE_SCHEDULE_URL,
      hours: num(env, 'KALSHI_FEE_SCHEDULE_HOURS', 6, 1, 168),
    },
    liveAllowUnvalidated: bool(env, 'LIVE_ALLOW_UNVALIDATED_MODEL', true),
    probation: {
      mode: oneOf(env, 'VALIDATION_GATES', 'monitor', ['monitor', 'enforce'] as const),
      minTrades: num(env, 'PROBATION_MIN_TRADES', DEFAULT_PROBATION.minTrades, 2, 10_000),
      t: num(env, 'PROBATION_T', DEFAULT_PROBATION.t, 0, 10),
      maxLossUsd: num(env, 'PROBATION_MAX_LOSS_USD', DEFAULT_PROBATION.maxLossUsd, 0, 1e9),
      maxLossPct: num(env, 'PROBATION_MAX_LOSS_PCT', DEFAULT_PROBATION.maxLossPct, 0, 1),
      window: num(env, 'PROBATION_WINDOW', DEFAULT_PROBATION.window, 10, 100_000),
    },
    sinuousExit: {
      mode: oneOf(env, 'SINUOUS_EXIT', DEFAULT_SINUOUS_EXIT.mode, ['gate', 'monitor', 'rest', 'cross', 'off'] as const),
      restBandSigmas: num(env, 'SINUOUS_REST_BAND_SIGMAS', 0.5, 0, 3),
      // The cross's sell signal is off until a version beats the bot's other exits on the exit study's replays: on
      // Oct 23 (16:15-00:15 UTC, 250 positions) every turn-based rule lost against them (the book cross -$28.61
      // against holding on its 15 fills and was benched by its own rule; the live line, the book cross and the
      // projected-peak watch all lost on replay). Oct 24's wiggle band did no better (16 h, 564 positions: it sold on 8 and
      // lost $3.51 against what they got; k 1.5, a 10 s look-ahead and no profit floor lost more). The curves, the live
      // line's band and its heads-up run either way.
      cross: bool(env, 'SINUOUS_CROSS', false),
      crossFeeMargin: num(env, 'SINUOUS_CROSS_FEE_MARGIN', 0.5, 0, 5),
      restStandDownSec: num(env, 'SINUOUS_REST_STAND_DOWN_SEC', 120, 0, 900),
      // What the cross watches: Kalshi's live line for the coin (the owner's description, Oct 23), or the contract's book.
      crossSource: oneOf(env, 'SINUOUS_CROSS_SOURCE', 'line', ['line', 'book'] as const),
      line: {
        aheadSec: num(env, 'LIVE_LINE_AHEAD_SEC', DEFAULT_LIVE_LINE.aheadSec, 3, 120),
        // x from the contract's own wiggles around the curve since it opened (the owner, Oct 24): mean +- k sd.
        bandK: num(env, 'LIVE_LINE_BAND_K', DEFAULT_LIVE_LINE.bandK, 0.5, 6),
        bandMinSec: num(env, 'LIVE_LINE_BAND_MIN_SEC', DEFAULT_LIVE_LINE.bandMinSec, 10, 900),
        confirmSec: num(env, 'LIVE_LINE_CONFIRM_SEC', DEFAULT_LIVE_LINE.confirmSec, 1, 30),
      },
      minNetProfit: num(env, 'SINUOUS_MIN_PROFIT_CENTS', DEFAULT_SINUOUS_EXIT.minNetProfit * 100, 0, 50) / 100,
      // Paper and live alike; the paper-only names from before Oct 24 are still read.
      benchT: num(env, 'SINUOUS_BENCH_T', num(env, 'SINUOUS_PAPER_BENCH_T', 2, 0.5, 10), 0.5, 10),
      benchMinExits: num(env, 'SINUOUS_BENCH_MIN_EXITS', num(env, 'SINUOUS_PAPER_BENCH_MIN_EXITS', 30, 5, 10_000), 5, 10_000),
    },
    sinuousEntry: {
      mode: oneOf(env, 'SINUOUS_ENTRY', DEFAULT_SINUOUS_ENTRY.mode, ['gate', 'monitor', 'off'] as const),
      slope: num(env, 'SINUOUS_ENTRY_SLOPE_CENTS', DEFAULT_SINUOUS_ENTRY.slope * 100, 0, 10) / 100,
    },
    trials: (() => {
      const minWindows = num(env, 'TRIAL_MIN_WINDOWS', DEFAULT_TRIALS.minWindows, 20, 5000);
      return {
        enabled: bool(env, 'TRIALS', DEFAULT_TRIALS.enabled),
        minWindows,
        p: num(env, 'TRIAL_P', DEFAULT_TRIALS.p, 0.001, 0.5),
        // The test needs at least TRIAL_MIN_WINDOWS settlements kept.
        keep: Math.max(minWindows, num(env, 'TRIAL_KEEP', DEFAULT_TRIALS.keep, 50, 5000)),
        snnAlpha: num(env, 'TRIAL_SNN_ALPHA', DEFAULT_TRIALS.snnAlpha, 0, 1),
        // Trials that trade in paper while they are tested (the owner, Oct 24: the trained rule book trades in paper).
        paperStart: (env.TRIAL_PAPER_START ?? DEFAULT_TRIALS.paperStart.join(',')).split(',').map((x) => x.trim()).filter((x): x is TrialName => (TRIAL_NAMES as string[]).includes(x)),
      };
    })(),
    scoreboard: {
      enabled: bool(env, 'SCOREBOARD', DEFAULT_SCOREBOARD.enabled),
      keep: num(env, 'SCOREBOARD_KEEP', DEFAULT_SCOREBOARD.keep, 100, 20000),
      snnAlpha: num(env, 'TRIAL_SNN_ALPHA', DEFAULT_SCOREBOARD.snnAlpha, 0, 1),
      bootstrap: num(env, 'SCOREBOARD_BOOTSTRAP', DEFAULT_SCOREBOARD.bootstrap, 50, 5000),
    },
    host,
    port: num(env, 'PORT', 3000, 1, 65535),
    dashboardPassword,
    dataDir,
    bookDir: mode === 'live' ? path.join(dataDir, 'live') : dataDir,
    auditMaxFileMb: num(env, 'AUDIT_MAX_FILE_MB', 256, 16, 4096),
    auditRetentionDays: num(env, 'AUDIT_RETENTION_DAYS', 30, 0, 3650),
    paramsPath: path.resolve(env.MODEL_PARAMS_PATH ?? './params/model.json'),
    // $200 since Oct 30 (Steven), the normal tier; see SIZING_TIERS.
    paperBankrollUsd: num(env, 'PAPER_BANKROLL_USD', 200, 1, 1e7),
    indexIdMap: jsonMap(env, 'INDEX_ID_MAP', DEFAULT_INDEX_IDS),
    seriesAssetMap,
    catalogHorizonMin: num(env, 'CATALOG_HORIZON_MIN', 90, 16, 7 * 24 * 60),
    catalogStrikesPerEvent: num(env, 'CATALOG_STRIKES_PER_EVENT', 4, 0, 1000),
    allowProxyIndex,
    spotFeed: bool(env, 'SPOT_FEED', true),
    dominanceFeed: bool(env, 'DOMINANCE_FEED', true),
    taCandles: bool(env, 'TA_CANDLES', true),
    clockSkewMaxMs: num(env, 'CLOCK_SKEW_MAX_MS', 2000, 0, 60_000),
    sessionEdge: { minutes: num(env, 'SESSION_EDGE_MIN', 40, 5, 120), noEntry: bool(env, 'SESSION_EDGE_NO_ENTRY', true) },
    botEnvFile: path.resolve(env.BOT_ENV_FILE ?? path.join(os.homedir(), 'bot', 'bot.env')),
    clockSkewWarnMs: num(env, 'CLOCK_SKEW_WARN_MS', 1000, 0, 60_000),
    settlementAvg: oneOf(env, 'SETTLEMENT_AVG', 'official', ['official', 'continuous'] as const),
    taStudyPath: path.resolve(env.TA_STUDY_PATH ?? './params/ta_study.json'),
    coinbaseRestUrl: env.COINBASE_REST_URL ?? 'https://api.exchange.coinbase.com',
    takerFlow: bool(env, 'TAKER_FLOW', true),
    spotBookRecordSec: num(env, 'SPOT_BOOK_RECORD_SEC', 15, 0, 3600),
    spotBookDepth: num(env, 'SPOT_BOOK_DEPTH', 10, 1, 50),
    spotBookBandBps: num(env, 'SPOT_BOOK_BAND_BPS', 10, 1, 500),
    spotBookBands: num(env, 'SPOT_BOOK_BANDS', 10, 0, 100),
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
      paper: bool(env, 'VAULT_IN_PAPER', false),
    },
    sizingTiers: parseSizingTiers(env.SIZING_TIERS, { risk, strategy }),
    conditioningApply: bool(env, 'CONDITIONING_APPLY', true),
    playbookApply: bool(env, 'PLAYBOOK_APPLY', true),
    compensatorApply: bool(env, 'COMPENSATOR_APPLY', true),
    perps: (() => {
      // Live mode never runs a simulated perps pool next to the real money: a paper setting is off there.
      const noPaperInLive = <T extends string>(v: T): T | 'off' => (mode === 'live' && v === 'paper' ? 'off' : v);
      const hedge = noPaperInLive(oneOf(env, 'PERP_HEDGE', 'paper', ['off', 'paper', 'live'] as const));
      const trading = noPaperInLive(oneOf(env, 'PERP_TRADING', 'paper', ['off', 'paper', 'live'] as const));
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
        paperBalanceUsd: num(env, 'PERP_PAPER_BALANCE_USD', 100, 1, 1e9),
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
        liqBuffer: num(env, 'PERP_LIQ_BUFFER', 0.2, 0, 0.9),
        maintMargin: num(env, 'PERP_MAINT_MARGIN', 0, 0, 0.5),
        setupRatchet: oneOf(env, 'SETUP_RATCHET', 'slow', ['off', 'slow', 'fast', 'both'] as const),
        setupRatchetStopAtr: num(env, 'SETUP_RATCHET_STOP_ATR', 3.5, 0.5, 20),
        setupRatchetBeAtr: num(env, 'SETUP_RATCHET_BE_ATR', 2, 0.25, 20),
        setupRatchetTrailStartAtr: num(env, 'SETUP_RATCHET_TRAIL_START_ATR', 3.5, 0.25, 30),
        setupRatchetTrailAtr: num(env, 'SETUP_RATCHET_TRAIL_ATR', 3, 0.25, 20),
        setupRatchetVolK: num(env, 'SETUP_RATCHET_VOL_K', 0, -2, 2),
        setupScaleOut: oneOf(env, 'SETUP_SCALE_OUT', 'off', ['off', 'slow', 'fast', 'both'] as const),
        setupScaleR1: num(env, 'SETUP_SCALE_R1', 1, 0.25, 10),
        setupScaleF1: num(env, 'SETUP_SCALE_F1', 0.33, 0.05, 0.95),
        setupScaleR2: num(env, 'SETUP_SCALE_R2', 2, 0.25, 20),
        setupScaleF2: num(env, 'SETUP_SCALE_F2', 0.33, 0, 0.9),
        setupScaleTrailAtr: num(env, 'SETUP_SCALE_TRAIL_ATR', 2.5, 0.25, 20),
        setupSpotPb: oneOf(env, 'SETUP_SPOT_PB', 'off', ['off', 'on'] as const),
      };
    })(),
    macro: macroConfig(env),
    optimalF: {
      enabled: bool(env, 'OPTIMAL_F', true),
      quantile: num(env, 'OPTIMAL_F_QUANTILE', 0.25, 0.05, 0.5),
      halfLifeDays: num(env, 'OPTIMAL_F_HALF_LIFE_DAYS', 365, 7, 3650),
      liveMult: num(env, 'OPTIMAL_F_LIVE_MULT', 2, 0.1, 20),
      minTradesSetups: num(env, 'OPTIMAL_F_MIN_TRADES', 50, 10, 10000),
      minTradesKalshi: num(env, 'OPTIMAL_F_MIN_TRADES_KALSHI', 100, 10, 10000),
      paperFloor: num(env, 'OPTIMAL_F_PAPER_FLOOR', 0.25, 0, 1),
    },
    autoTrain: {
      mode: oneOf(env, 'AUTO_TRAIN', 'remote', ['off', 'daily', 'windows', 'background', 'remote'] as const),
      hourUtc: num(env, 'AUTO_TRAIN_HOUR_UTC', 6, 0, 23),
      everyHours: num(env, 'AUTO_TRAIN_EVERY_HOURS', 6, 1, 168),
      startDelayMin: num(env, 'AUTO_TRAIN_START_DELAY_MIN', 10, 0, 240),
      maxLoopLagMs: num(env, 'AUTO_TRAIN_MAX_LAG_MS', 500, 50, 60_000),
      minAvailableMb: num(env, 'AUTO_TRAIN_MIN_FREE_MB', 300, 0, 1e6),
      maxStealFrac: num(env, 'AUTO_TRAIN_MAX_STEAL', 0.15, 0, 1),
      dir: path.resolve(env.AUTO_TRAIN_DIR ?? path.join(dataDir, 'models')),
      recordingsDir: path.resolve(env.AUTO_TRAIN_RECORDINGS ?? path.join(dataDir, 'recordings')),
      recordingsGzipAfterDays: num(env, 'RECORDINGS_GZIP_AFTER_DAYS', 1, 0, 365),
      recordingsMinFreeGb: num(env, 'RECORDINGS_MIN_FREE_GB', 5, 0, 1e4),
      recordingsPrune: bool(env, 'RECORDINGS_PRUNE', true),
      recordingsGzipLive: bool(env, 'RECORDINGS_GZIP_LIVE', true),
      recordingsKeepDays: num(env, 'RECORDINGS_KEEP_DAYS', 20, 0, 3650),
      promote: oneOf(env, 'AUTO_TRAIN_PROMOTE', 'always', ['always', 'validated'] as const),
      champion: bool(env, 'AUTO_TRAIN_CHAMPION', true),
      snnStage: oneOf(env, 'AUTO_TRAIN_SNN_STAGE', 'auto', ['auto', 'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const),
      ablationDays: num(env, 'AUTO_TRAIN_ABLATION_DAYS', 7, 1, 365),
      ablationEveryDays: num(env, 'AUTO_TRAIN_ABLATION_EVERY_DAYS', 7, 0, 365),
      snnTrainDays: num(env, 'AUTO_TRAIN_SNN_TRAIN_DAYS', 21, 1, 365),
      onModelChange: bool(env, 'AUTO_TRAIN_ON_MODEL_CHANGE', true),
      skipUnchanged: bool(env, 'AUTO_TRAIN_SKIP_UNCHANGED', true),
      sweepTargets: (env.SWEEP_TARGETS ?? 'setups-long,setups-short,setups-vol,setups-ratchet,setups-scale,setups-spotpb,kalshi,bot').split(',').map((x) => x.trim()).filter(Boolean),
      sweepHours: num(env, 'SWEEP_HOURS', 2, 0.05, 48),
      taNetOosHours: num(env, 'TA_NET_OOS_HOURS', 3, 0.05, 48),
      sweepEveryDays: num(env, 'SWEEP_EVERY_DAYS', 7, 1, 365),
      sweepKalshiDays: num(env, 'SWEEP_KALSHI_DAYS', 60, 20, 2000),
      minDays: num(env, 'AUTO_TRAIN_MIN_DAYS', 1, 0, 365),
      decisionDays: num(env, 'AUTO_TRAIN_DECISION_DAYS', 0, 0, 365),
      watchSec: num(env, 'AUTO_TRAIN_WATCH_SEC', 30, 5, 3600),
      snnPbtDays: num(env, 'AUTO_TRAIN_SNN_PBT_DAYS', 7, 2, 365),
      snnPbtInitDays: num(env, 'AUTO_TRAIN_SNN_PBT_INIT_DAYS', 3, 1, 60),
      snnPbtMaxRounds: num(env, 'AUTO_TRAIN_SNN_PBT_MAX_ROUNDS', 0, 0, 1000),
      snnPbtPopulation: num(env, 'AUTO_TRAIN_SNN_PBT_POPULATION', 3, 2, 64),
      snnPbtEveryDays: num(env, 'AUTO_TRAIN_SNN_PBT_EVERY_DAYS', 30, 0, 365),
      snnPbtRestartEvery: num(env, 'AUTO_TRAIN_SNN_PBT_RESTART_EVERY', 4, 0, 1000),
      contestWeeks: num(env, 'AUTO_TRAIN_CONTEST_WEEKS', 2, 1, 12),
      targetPoolUsd: num(env, 'TRAIN_TARGET_POOL_USD', 200, 1, 1e9),
      targetDailyPct: num(env, 'TRAIN_TARGET_DAILY_PCT', 50, 0.01, 1000),
      targetMaxDdPct: num(env, 'TRAIN_TARGET_MAX_DD_PCT', 10, 0.1, 100),
      plateauRounds: num(env, 'TRAIN_PLATEAU_ROUNDS', 3, 1, 100),
      gaParents: num(env, 'TOURNAMENT_PARENTS', 3, 0, 16),
      gaIslands: num(env, 'TOURNAMENT_ISLANDS', 1, 1, 16),
      gaBreedEvery: num(env, 'TOURNAMENT_BREED_EVERY', 4, 1, 1000),
      gaMutation: num(env, 'TOURNAMENT_MUTATION', 0.03, 0, 0.5),
      gpEveryDays: num(env, 'GP_EVERY_DAYS', 7, 0, 365),
      gpPopulation: num(env, 'GP_POPULATION', 1000, 20, 200_000),
      gpGenerations: num(env, 'GP_GENERATIONS', 15, 1, 500),
      gpAssets: (env.GP_ASSETS ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
      gpCross: (env.GP_CROSS ?? 'BTC,ETH').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
      gpFitness: oneOf(env, 'GP_FITNESS', 'sharpe', ['sharpe', 'return'] as const),
      gpCostBps: num(env, 'GP_COST_BPS', 5, 0, 100),
      gpBand: num(env, 'GP_BAND', 0.1, 0, 1),
      gpMinPsr: num(env, 'GP_MIN_PSR', 0.9, 0.5, 0.9999),
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
      anchorMid: bool(env, 'SNN_ANCHOR_MID', true),
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
      settleFrac: num(env, 'TENNIS_NO_EXIT_BEFORE_END_FRAC', 0.30, 0, 0.9),
      fairMinEdge: num(env, 'TENNIS_FAIR_MIN_EDGE', 0.01, -0.5, 0.5),
      modelPath: path.resolve(env.TENNIS_MODEL_PATH ?? './params/tennis_model.json'),
    },
    taNet: {
      enabled: bool(env, 'TA_NET', true),
      modelPath: path.resolve(env.TA_NET_PATH ?? './params/ta_net.json'),
      librarianPath: path.resolve(env.LIBRARIAN_PATH ?? './params/librarian.json'),
      crossGraphPath: path.resolve(env.CROSS_GRAPH_PATH ?? './params/cross_graph.json'),
      crossLeadPath: path.resolve(env.CROSS_LEAD_PATH ?? './params/cross_lead.json'),
      xgEngine: oneOf(env, 'XG_ENGINE', 'auto', ['ts', 'torch', 'auto'] as const),
      requireValidated: bool(env, 'TA_NET_REQUIRE_VALIDATED', true),
      ensemble: num(env, 'TA_NET_ENSEMBLE', 3, 1, 6),
      historyDir: path.resolve(env.HISTORY_DIR ?? path.join(dataDir, 'history')),
      historyUpdate: bool(env, 'HISTORY_AUTO_UPDATE', true),
      tvFill: bool(env, 'TV_FILL', true),
      kalshiHistoryBudgetMin: num(env, 'KALSHI_HISTORY_BUDGET_MIN', 20, 0, 600),
      kalshiHistoryDays: num(env, 'KALSHI_HISTORY_DAYS', 60, 1, 1095),
      historyAssets: env.HISTORY_ASSETS ?? 'auto',
      binanceIntervals: (env.HISTORY_BINANCE_INTERVALS ?? '1h,15m,1d').split(',').map((x) => x.trim()).filter(Boolean),
      coinbaseTfs: (env.HISTORY_COINBASE_TFS ?? '1h,1d').split(',').map((x) => x.trim()).filter((x) => x && x !== 'none'),
      historyRecheckHours: num(env, 'HISTORY_RECHECK_HOURS', 24, 0, 720),
      historyReplay: bool(env, 'HISTORY_REPLAY', false),
      historyReplayYears: num(env, 'HISTORY_REPLAY_YEARS', 0, 0, 20),
      historyReplayDir: path.resolve(env.HISTORY_REPLAY_DIR ?? path.join(dataDir, 'history-replay')),
      historyReplayAssets: (env.HISTORY_REPLAY_ASSETS ?? 'BTC,ETH,SOL,XRP,DOGE').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
      retrainEveryDays: num(env, 'TA_NET_RETRAIN_DAYS', 7, 0, 365),
      arch: oneOf(env, 'TA_NET_ARCH', 'flat', ['flat', 'grouped'] as const),
      engine: oneOf(env, 'TA_NET_ENGINE', 'ts', ['ts', 'torch', 'auto'] as const),
      python: env.TA_NET_PYTHON ?? '',
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
      population: num(env, 'TA_NET_POPULATION', 3, 2, 64),
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

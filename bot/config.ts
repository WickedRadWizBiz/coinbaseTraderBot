// Configuration is read once from the environment at startup, validated, and
// frozen. Nothing at runtime (API, LLM, learner) can change it. Changing a
// parameter means a reviewed commit and a redeploy.

import fs from 'fs';
import { parseSessionRisk, type SessionRiskProfile } from './model/sessionRisk';
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
  /** Series to trade, e.g. KXBTC15M. */
  series: string[];
  /** Fractional Kelly multiplier (0.1–0.25 recommended). */
  kellyFraction: number;
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
  /** fair_value (default) or confluence_ratchet ("let the winner run" under confluence). */
  exitPolicy: 'fair_value' | 'confluence_ratchet';
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
}

export interface Config {
  mode: TradingMode;
  kalshiEnv: KalshiEnv;
  restBaseUrl: string;
  wsUrl: string;
  kalshiKeyId?: string;
  kalshiPrivateKeyPath?: string;
  kalshiSubaccount?: number;
  host: string;
  port: number;
  dashboardToken: string;
  dataDir: string;
  paramsPath: string;
  paperBankrollUsd: number;
  /** Map of Kalshi CF Benchmarks index id -> asset symbol (BTC, ETH...). */
  indexIdMap: Record<string, string>;
  /** Map of series ticker -> asset symbol. */
  seriesAssetMap: Record<string, string>;
  /** Allow using the Coinbase public ticker as an index proxy (basis risk; paper/shadow only). */
  allowProxyIndex: boolean;
  /** Stream Coinbase spot for lead-lag features and the dashboard (never a pricing input). */
  spotFeed: boolean;
  /** Track USDT.D / BTC.D (Binance prices anchored to CoinGecko) as feature inputs. */
  dominanceFeed: boolean;
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
}

export class ConfigError extends Error {}

const DEFAULT_SERIES_ASSET: Record<string, string> = {
  KXBTC15M: 'BTC',
  KXETH15M: 'ETH',
  KXSOL15M: 'SOL',
  KXXRP15M: 'XRP',
  KXDOGE15M: 'DOGE',
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

  const token = env.DASHBOARD_TOKEN ?? '';
  if (token.length < 32) {
    throw new ConfigError('DASHBOARD_TOKEN must be set to a random string of at least 32 characters (e.g. `openssl rand -hex 32`)');
  }

  const host = env.BIND_HOST ?? '127.0.0.1';
  const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!isLoopback && !bool(env, 'ALLOW_NON_LOOPBACK_BIND', false)) {
    throw new ConfigError(`BIND_HOST=${host} is not loopback. Reach the dashboard through an SSH tunnel or Tailscale, or set ALLOW_NON_LOOPBACK_BIND=true behind TLS.`);
  }

  const series = (env.STRATEGY_SERIES ?? 'KXBTC15M').split(',').map((s) => s.trim()).filter(Boolean);
  const seriesAssetMap = jsonMap(env, 'SERIES_ASSET_MAP', DEFAULT_SERIES_ASSET);
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
    maxContractsPerOrder: num(env, 'RISK_MAX_CONTRACTS_PER_ORDER', 5, 0.01, 1000),
    maxOrderRiskFrac: num(env, 'RISK_MAX_ORDER_FRAC', 0.02, 0.001, 0.05),
    maxWindowRiskFrac: num(env, 'RISK_MAX_WINDOW_FRAC', 0.03, 0.001, 0.1),
    maxTotalRiskFrac: num(env, 'RISK_MAX_TOTAL_FRAC', 0.10, 0.001, 0.25),
    dailyLossLimitFrac: num(env, 'RISK_DAILY_LOSS_FRAC', 0.05, 0.001, 0.2),
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

  const strategy: StrategyConfig = {
    style: oneOf<StrategyStyle>(env, 'STRATEGY_STYLE', 'maker', ['maker', 'taker', 'both']),
    series,
    kellyFraction: num(env, 'STRATEGY_KELLY_FRACTION', 0.15, 0.01, 0.5),
    minEdge: num(env, 'STRATEGY_MIN_EDGE', 0.02, 0.0, 0.5),
    takerBuffer: num(env, 'STRATEGY_TAKER_BUFFER', 0.01, 0.0, 0.5),
    inventorySkewPerContract: num(env, 'STRATEGY_INVENTORY_SKEW', 0.002, 0, 0.05),
    requoteThreshold: num(env, 'STRATEGY_REQUOTE_THRESHOLD', 0.01, 0.01, 0.2),
    fastMoveSigmas: num(env, 'STRATEGY_FAST_MOVE_SIGMAS', 3, 0.5, 20),
    fastMoveWindowSec: num(env, 'STRATEGY_FAST_MOVE_WINDOW_SEC', 5, 1, 120),
    orderTtlSec: num(env, 'STRATEGY_ORDER_TTL_SEC', 60, 10, 900),
    exitPolicy: oneOf(env, 'EXIT_POLICY', 'fair_value', ['fair_value', 'confluence_ratchet'] as const),
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
    host,
    port: num(env, 'PORT', 3000, 1, 65535),
    dashboardToken: token,
    dataDir,
    paramsPath: path.resolve(env.MODEL_PARAMS_PATH ?? './params/model.json'),
    paperBankrollUsd: num(env, 'PAPER_BANKROLL_USD', 200, 1, 1e7),
    indexIdMap: jsonMap(env, 'INDEX_ID_MAP', DEFAULT_INDEX_IDS),
    seriesAssetMap,
    allowProxyIndex,
    spotFeed: bool(env, 'SPOT_FEED', true),
    dominanceFeed: bool(env, 'DOMINANCE_FEED', true),
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
  const { dashboardToken, kalshiKeyId, kalshiPrivateKeyPath, alertTelegramToken, alertWebhookUrl, coingeckoApiKey, ...rest } = cfg;
  return {
    ...rest,
    kalshiKeyId: kalshiKeyId ? `${kalshiKeyId.slice(0, 4)}…` : undefined,
    alerts: { telegram: Boolean(alertTelegramToken), webhook: Boolean(alertWebhookUrl) },
  };
}

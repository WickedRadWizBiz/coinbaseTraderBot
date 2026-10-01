// SNN L0 input specification: which signals each column kind encodes, and the ONE function that
// builds those values (live engine and research replay both call it, so they cannot drift).
//
// Crypto columns (one per asset x horizon: 15m and 60m for the Kalshi contracts, 240m with 60m for
// perps) read the same information the MLP reads, from the shared feature registry:
//   - the TA library on the Coinbase spot USD pair: RSI, MACD histogram, DMI direction and Bollinger
//     %B on the two timeframes nearest the horizon, plus the library's rule/confluence scores;
//   - the perp: premium to the index, funding, perp-vs-index return;
//   - the Kalshi book of the closest-to-the-money contract: mid, spread, depth imbalance, strike
//     distance in sigma units, time left;
//   - returns over the horizon and over 5 minutes, and the USDT.D risk-on/off factor.
// Tennis columns (one per live match) read the four tennis confluence signals (momentum, flow,
// depth, cross-market) with their magnitudes, the live score (Live Tennis API: sets, games, points,
// server, tiebreak, breaks), match progress, the score model's P(A wins), and the book.

import type { TennisConfig } from '../config';
import { impliedModel, type MatchFormat, type TennisScore } from '../tennis/tennisModel';
import { MatchTracker, tennisConfluence, type MatchMarket } from '../tennis/tennisStrategy';

export type ColumnKind = 'crypto' | 'tennis';

export interface PopSpec { name: string; lo: number; hi: number }

/** Crypto horizons (minutes) and the direction horizon each column predicts. */
export const CRYPTO_HORIZONS = [15, 60, 240] as const;
export type CryptoHorizon = typeof CRYPTO_HORIZONS[number];
export const TENNIS_DIRECTION_SEC = 300;

/** TA timeframes encoded by each crypto horizon (the library computes 15m, 1h, 4h). */
export const TA_TFS: Record<CryptoHorizon, [string, string]> = { 15: ['15m', '1h'], 60: ['1h', '4h'], 240: ['1h', '4h'] };
const RET_FOR: Record<CryptoHorizon, string> = { 15: 'ret_15m_z', 60: 'ret_1h_z', 240: 'ret_4h_z' };

/** Population-coded crypto inputs (8 bands each), in channel order after the 8 delta channels. */
export const CRYPTO_POP: PopSpec[] = [
  // Kalshi contract (closest to the money; absent for the perp-only 240m column)
  { name: 'dAtm', lo: -3, hi: 3 }, { name: 'tauFrac', lo: 0, hi: 1 }, { name: 'mid', lo: 0, hi: 1 }, { name: 'spread', lo: 0, hi: 0.1 }, { name: 'imbalance', lo: -1, hi: 1 },
  // returns
  { name: 'ret_h_z', lo: -3, hi: 3 }, { name: 'ret_5m_z', lo: -3, hi: 3 },
  // TA library indicators on the spot USD pair, fast and slow timeframe
  { name: 'ta_rsi_a', lo: -1, hi: 1 }, { name: 'ta_macd_a', lo: -2, hi: 2 }, { name: 'ta_di_a', lo: -1, hi: 1 }, { name: 'ta_bb_a', lo: -1, hi: 1 },
  { name: 'ta_rsi_b', lo: -1, hi: 1 }, { name: 'ta_macd_b', lo: -2, hi: 2 }, { name: 'ta_di_b', lo: -1, hi: 1 }, { name: 'ta_bb_b', lo: -1, hi: 1 },
  // TA library rule/confluence scores
  { name: 'taconf_net', lo: -10, hi: 10 }, { name: 'taconf_net_trend', lo: -5, hi: 5 }, { name: 'taconf_net_reversal', lo: -5, hi: 5 },
  { name: 'taconf_trend_alignment', lo: -1, hi: 1 }, { name: 'taconf_mtf_momentum', lo: -1, hi: 1 },
  // perpetual
  { name: 'perp_premium_bps', lo: -20, hi: 20 }, { name: 'funding_rate_bps', lo: -5, hi: 5 }, { name: 'perp_ret_diff_5m_z', lo: -3, hi: 3 },
  // macro
  { name: 'usdtd_ret_15m_z', lo: -3, hi: 3 },
];

/** Population-coded tennis inputs. */
export const TENNIS_POP: PopSpec[] = [
  { name: 'momentum', lo: -0.05, hi: 0.05 }, { name: 'flow', lo: -1, hi: 1 }, { name: 'depth', lo: -1, hi: 1 }, { name: 'crossMarket', lo: -0.05, hi: 0.05 },
  { name: 'confluence', lo: -4, hi: 4 },
  { name: 'setDiff', lo: -2, hi: 2 }, { name: 'gameDiff', lo: -6, hi: 6 }, { name: 'pointDiff', lo: -4, hi: 4 }, { name: 'serverA', lo: 0, hi: 1 },
  { name: 'tiebreak', lo: 0, hi: 1 }, { name: 'breakDiff', lo: -3, hi: 3 }, { name: 'progress', lo: 0, hi: 1 }, { name: 'modelPA', lo: 0, hi: 1 },
  { name: 'mid', lo: 0, hi: 1 }, { name: 'spread', lo: 0, hi: 0.1 },
];

/** Send-on-delta thresholds on the column's primary price (crypto: bps of the index; tennis: cents of P(A)). */
export const CRYPTO_DELTA_BPS = [3, 6, 12];
export const TENNIS_DELTA_CENTS = [0.01, 0.02, 0.04];

export function popSpec(kind: ColumnKind): PopSpec[] { return kind === 'tennis' ? TENNIS_POP : CRYPTO_POP; }
/** L0 width: 8 delta channels (3 thresholds x up/down + 2 secondary) + 8 bands per pop input. */
export function l0Width(kind: ColumnKind): number { return 8 + 8 * popSpec(kind).length; }

export const cryptoColumnKey = (asset: string, h: CryptoHorizon) => `${asset}-${h}m`;
export const tennisColumnKey = (event: string) => `TEN:${event}`;
export function columnHorizonSec(key: string): number {
  if (key.startsWith('TEN:')) return TENNIS_DIRECTION_SEC;
  const m = /-(\d+)m$/.exec(key);
  return m ? Number(m[1]) * 60 : 900;
}
export function columnKind(key: string): ColumnKind { return key.startsWith('TEN:') ? 'tennis' : 'crypto'; }

/** Crypto column values from one asset-level feature map (+ the ATM Kalshi contract when listed). */
export function cryptoValues(h: CryptoHorizon, f: Record<string, number>, contract?: { dAtm?: number; tauFrac?: number; mid?: number; spread?: number; imbalance?: number }): Record<string, number | undefined> {
  const [a, b] = TA_TFS[h];
  const g = (k: string) => (Number.isFinite(f[k]) ? f[k] : undefined);
  return {
    dAtm: contract?.dAtm, tauFrac: contract?.tauFrac, mid: contract?.mid, spread: contract?.spread, imbalance: contract?.imbalance,
    ret_h_z: g(RET_FOR[h]), ret_5m_z: g('ret_5m_z'),
    ta_rsi_a: g(`ta_rsi_${a}`), ta_macd_a: g(`ta_macd_hist_${a}`), ta_di_a: g(`ta_di_diff_${a}`), ta_bb_a: g(`ta_bb_pctb_${a}`),
    ta_rsi_b: g(`ta_rsi_${b}`), ta_macd_b: g(`ta_macd_hist_${b}`), ta_di_b: g(`ta_di_diff_${b}`), ta_bb_b: g(`ta_bb_pctb_${b}`),
    taconf_net: g('taconf_net'), taconf_net_trend: g('taconf_net_trend'), taconf_net_reversal: g('taconf_net_reversal'),
    taconf_trend_alignment: g('taconf_trend_alignment'), taconf_mtf_momentum: g('taconf_mtf_momentum'),
    perp_premium_bps: g('perp_premium_bps'), funding_rate_bps: g('funding_rate_bps'), perp_ret_diff_5m_z: g('perp_ret_diff_5m_z'),
    usdtd_ret_15m_z: g('usdtd_ret_15m_z'),
  };
}

export interface TennisInputSources {
  /** P(player A wins) from the books, and player A's market spread. */
  pA?: number; spread?: number;
  /** Mid changes over the confluence window: A's market, and the opponent's market. */
  momentum?: number; opponentMove?: number;
  flow?: number; depth?: number;
  /** Signed confluence count: A's signals minus B's (each 0..4). */
  confluence?: number;
  score?: TennisScore; tiebreak?: boolean; breaksTotal?: [number, number];
  progress?: number; pStart?: number; format?: MatchFormat; serveBase?: number;
}

/** Tennis column values (oriented to player A, the event's first market). */
export function tennisValues(s: TennisInputSources): Record<string, number | undefined> {
  const sc = s.score;
  let modelPA: number | undefined;
  if (sc && s.format) {
    try {
      const m = impliedModel(s.pStart ?? s.pA ?? 0.5, s.format, s.serveBase);
      modelPA = m.from(sc.setsA, sc.setsB, sc.gamesA, sc.gamesB, sc.pointsA, sc.pointsB, sc.serverA === false ? 1 : 0).pA;
    } catch { modelPA = undefined; }
  }
  return {
    momentum: s.momentum, flow: s.flow, depth: s.depth, crossMarket: s.opponentMove === undefined ? undefined : -s.opponentMove, confluence: s.confluence,
    setDiff: sc ? sc.setsA - sc.setsB : undefined, gameDiff: sc ? sc.gamesA - sc.gamesB : undefined, pointDiff: sc ? sc.pointsA - sc.pointsB : undefined,
    serverA: sc?.serverA === undefined ? undefined : sc.serverA ? 1 : 0, tiebreak: s.tiebreak === undefined ? undefined : s.tiebreak ? 1 : 0,
    breakDiff: s.breaksTotal ? s.breaksTotal[0] - s.breaksTotal[1] : undefined, progress: s.progress, modelPA: modelPA ?? s.pA, mid: s.pA, spread: s.spread,
  };
}

/** Tennis column values for a match, exactly as the engine computes them (also used by the tennis
 *  model trainer on recorded matches, so training and live inputs cannot drift). */
export function tennisSnapshotValues(t: MatchTracker, markets: MatchMarket[], now: number, cfg: TennisConfig, live: { tiebreak?: boolean; breaksTotal?: [number, number] } = {}): Record<string, number | undefined> | undefined {
  const a = markets[0], b = markets[1];
  const pA = MatchTracker.probability(markets);
  if (!a || pA === undefined) return undefined;
  const w = cfg.confWindowSec * 1000;
  const sigA = tennisConfluence(t, a, b, now, cfg), sigB = b ? tennisConfluence(t, b, a, now, cfg) : undefined;
  return tennisValues({
    pA, spread: a.quote.bid !== undefined && a.quote.ask !== undefined ? a.quote.ask - a.quote.bid : undefined,
    momentum: t.midChange(a.ticker, now, w), opponentMove: b ? t.midChange(b.ticker, now, w) : undefined,
    flow: a.flow, depth: a.book?.imbalance(3), confluence: sigA.score - (sigB?.score ?? 0),
    score: t.score, tiebreak: live.tiebreak, breaksTotal: live.breaksTotal, progress: t.progress(now, markets), pStart: t.pStart, format: t.format(markets), serveBase: cfg.serveBase,
  });
}

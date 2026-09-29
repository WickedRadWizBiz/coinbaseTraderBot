// Digital-option fair value for Kalshi 15-minute crypto "up or down" markets.
//
// Settlement (CRYPTO15M terms): YES iff the simple average of the CF RTI over
// the 60 s before close is at least the strike, where the strike is the 60 s
// average before open. A tie resolves YES. Missing/incomplete index data
// resolves NO (we do not model that tail; it only lowers P(YES)).
//
// Model: driftless log-Brownian index with volatility sigma (per sqrt second).
//  - More than A = 60 s to close: the settlement average's log-variance seen
//    from now is sigma^2 * (tau - 2A/3), so
//        P(YES) = Phi( ln(S/K) / (sigma * sqrt(tau - 2A/3)) ).
//  - Inside the final A seconds, the part of the average already observed (F,
//    over A - tau seconds) is fixed. The unknown remainder U (average over the
//    last tau seconds) has log-variance sigma^2 * tau / 3. YES iff
//        U >= K* = (A*K - (A - tau)*F) / tau.

import { clamp, normCdf } from '../util/num';

export const SETTLEMENT_AVG_SEC = 60;

export interface FairValueInput {
  /** Current index value. */
  spot: number;
  /** Strike (opening 60 s average). */
  strike: number;
  /** Volatility of log index per sqrt(second). */
  sigmaPerSqrtSec: number;
  /** Seconds until market close. */
  tauSec: number;
  /** Average of the index over [close - A, now], required once tau < A. */
  observedAvg?: number;
  averagingSec?: number;
}

export interface FairValue {
  pYes: number;
  /** Standard deviation of the log settlement average, for diagnostics. */
  stdLog: number;
  regime: 'pre_window' | 'in_window' | 'determined';
}

const P_MIN = 1e-4;
const P_MAX = 1 - 1e-4;

export function fairValue(inp: FairValueInput): FairValue | undefined {
  const A = inp.averagingSec ?? SETTLEMENT_AVG_SEC;
  const { spot: S, strike: K, sigmaPerSqrtSec: sigma } = inp;
  const tau = Math.max(0, inp.tauSec);
  if (!(S > 0) || !(K > 0) || !(sigma > 0) || !Number.isFinite(tau)) return undefined;

  if (tau > A) {
    const std = sigma * Math.sqrt(tau - (2 * A) / 3);
    return { pYes: clamp(normCdf(Math.log(S / K) / std), P_MIN, P_MAX), stdLog: std, regime: 'pre_window' };
  }

  const F = inp.observedAvg;
  if (F === undefined || !(F > 0)) return undefined; // cannot price without the fixed part
  if (tau < 0.5) {
    // Effectively determined; tie goes to YES.
    return { pYes: F >= K ? P_MAX : P_MIN, stdLog: 0, regime: 'determined' };
  }
  const kStar = (A * K - (A - tau) * F) / tau;
  if (kStar <= 0) return { pYes: P_MAX, stdLog: 0, regime: 'determined' };
  const std = sigma * Math.sqrt(tau / 3);
  return { pYes: clamp(normCdf(Math.log(S / kStar) / std), P_MIN, P_MAX), stdLog: std, regime: 'in_window' };
}

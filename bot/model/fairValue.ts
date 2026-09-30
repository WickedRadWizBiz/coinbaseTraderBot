// Settlement-exact fair value for Kalshi crypto binaries.
//
// Settlement (CRYPTO15M and hourly terms): the simple average A of the CF RTI
// over the 60 s before close. Contract kinds:
//   updown   15-minute Up/Down: YES iff A >= K, K = the 60 s average before
//            the window opened ("at least": a tie resolves YES).
//   greater  hourly ladder (KXBTCD): YES iff A >= floor strike.
//   between  hourly range bracket (KXBTC): YES iff floor <= A < cap.
// Missing/incomplete index data resolves NO (not modelled; it only lowers
// P(YES) by a small tail).
//
// Model: the index is a martingale (the BRTI methodology states it), so log
// returns have drift -v/2 and P(S_T >= K) = N(d2), d2 = (ln(S/K) - v/2)/sqrt(v).
//  - Before the averaging window (tau > w, w = 60 s): averaging a Brownian
//    path over the window keeps one third of that window's variance, so
//        v_eff = sigma^2 * [(tau - w) + w/3] = sigma^2 * (tau - 2w/3).
//  - Inside the window, the part of the average already observed (F over
//    w - tau seconds) is fixed. The unknown remainder U (average over the last
//    tau seconds) has log-variance sigma^2 * tau / 3. YES iff
//        U >= K* = (w*K - (w - tau)*F) / tau.
//  - Fat tails (optional): a unit-variance Student-t with nu degrees of
//    freedom in place of the normal, nu fitted offline on 1-15 minute returns.

import { clamp, normCdf, normInv, normPdf, studentTCdf } from '../util/num';

export const SETTLEMENT_AVG_SEC = 60;

export type ContractKind = 'updown' | 'greater' | 'between';

export interface FairValueInput {
  /** Current index value (best estimate of the settlement index now). */
  spot: number;
  /** Strike: opening 60 s average (updown) or floor strike (greater/between). */
  strike: number;
  /** Upper bound for 'between' brackets (YES iff strike <= A < cap). */
  cap?: number;
  /** Volatility of log index per sqrt(second). */
  sigmaPerSqrtSec: number;
  /** Seconds until market close. */
  tauSec: number;
  /** Average of the index over [close - w, now], required once tau < w. */
  observedAvg?: number;
  averagingSec?: number;
  /** Student-t degrees of freedom (> 2); omit for Gaussian tails. */
  nu?: number;
}

export interface FairValue {
  pYes: number;
  /** Standard deviation of the log settlement average, for diagnostics. */
  stdLog: number;
  /** d2 of the floor strike and its effective variance (NaN when determined). */
  d2: number;
  vEff: number;
  regime: 'pre_window' | 'in_window' | 'determined';
}

const P_MIN = 1e-4;
const P_MAX = 1 - 1e-4;

/** P(Z <= z) for the unit-variance tail model. */
export function tailCdf(z: number, nu?: number): number {
  if (!nu || !(nu > 2)) return normCdf(z);
  return studentTCdf(z / Math.sqrt((nu - 2) / nu), nu);
}

/** P(A >= K) with A lognormal-ish around S and log-variance v. */
export function probAbove(S: number, K: number, v: number, nu?: number): { p: number; d2: number } {
  if (!(v > 1e-16)) {
    const win = S >= K;
    return { p: win ? 1 : 0, d2: win ? Infinity : -Infinity };
  }
  const d2 = (Math.log(S / K) - 0.5 * v) / Math.sqrt(v);
  return { p: tailCdf(d2, nu), d2 };
}

/** P(the settlement average >= K) for one threshold. */
function probAboveSettlement(inp: FairValueInput, K: number): { p: number; d2: number; v: number; regime: FairValue['regime'] } | undefined {
  const w = inp.averagingSec ?? SETTLEMENT_AVG_SEC;
  const { spot: S, sigmaPerSqrtSec: sigma } = inp;
  const tau = Math.max(0, inp.tauSec);
  if (tau > w) {
    const v = sigma * sigma * (tau - (2 * w) / 3);
    return { ...probAbove(S, K, v, inp.nu), v, regime: 'pre_window' };
  }
  const F = inp.observedAvg;
  if (F === undefined || !(F > 0)) return undefined; // cannot price without the fixed part
  if (tau < 0.5) return { p: F >= K ? 1 : 0, d2: NaN, v: 0, regime: 'determined' }; // tie goes to YES
  const kStar = (w * K - (w - tau) * F) / tau;
  if (kStar <= 0) return { p: 1, d2: NaN, v: 0, regime: 'determined' };
  const v = (sigma * sigma * tau) / 3;
  return { ...probAbove(S, kStar, v, inp.nu), v, regime: 'in_window' };
}

export function fairValue(inp: FairValueInput): FairValue | undefined {
  const { spot: S, strike: K, sigmaPerSqrtSec: sigma } = inp;
  if (!(S > 0) || !(K > 0) || !(sigma > 0) || !Number.isFinite(inp.tauSec)) return undefined;
  if (inp.cap !== undefined && !(inp.cap > K)) return undefined;
  const lo = probAboveSettlement(inp, K);
  if (!lo) return undefined;
  let p = lo.p;
  if (inp.cap !== undefined) {
    const hi = probAboveSettlement(inp, inp.cap);
    if (!hi) return undefined;
    p = lo.p - hi.p;
  }
  return { pYes: clamp(p, P_MIN, P_MAX), stdLog: Math.sqrt(lo.v), d2: lo.d2, vEff: lo.v, regime: lo.regime };
}

/** Sensitivity of P(YES) to the next move: phi(d2). */
export function phiD2(d2: number): number {
  return Number.isFinite(d2) ? normPdf(d2) : 0;
}

/**
 * Market-implied integrated variance from a 'greater'/'updown' price, dropping
 * the negligible -v/2 drift: p = N(x / sqrt(v)) => v = (x / Ninv(p))^2. Null
 * near the money (the inversion is ill-conditioned) or on a sign mismatch.
 */
export function impliedVariance(S: number, K: number, pMkt: number): number | undefined {
  const x = Math.log(S / K);
  const z = normInv(clamp(pMkt, 0.01, 0.99));
  if (Math.abs(z) < 0.1 || Math.abs(x) < 1e-5 || Math.sign(x) !== Math.sign(z)) return undefined;
  return (x / z) ** 2;
}

export type MarketKind = ContractKind | 'less';

/** Contract kind from the series and Kalshi strike_type. 15-minute series are
 * Up/Down; otherwise strike_type decides (default 'greater', the hourly ladder). */
export function contractKind(seriesTicker: string, strikeType?: string): MarketKind {
  const st = (strikeType ?? '').toLowerCase();
  if (st === 'between') return 'between';
  if (st === 'less' || st === 'less_or_equal') return 'less';
  if (/15M$/i.test(seriesTicker)) return 'updown';
  return 'greater';
}

export interface ContractTerms { kind: MarketKind; strike?: number; cap?: number }

/** Price any supported contract kind. 'less' pays iff A < cap. */
export function priceContract(terms: ContractTerms, inp: Omit<FairValueInput, 'strike' | 'cap'>): FairValue | undefined {
  switch (terms.kind) {
    case 'updown':
    case 'greater':
      return terms.strike ? fairValue({ ...inp, strike: terms.strike }) : undefined;
    case 'between':
      return terms.strike && terms.cap ? fairValue({ ...inp, strike: terms.strike, cap: terms.cap }) : undefined;
    case 'less': {
      if (!terms.cap) return undefined;
      const f = fairValue({ ...inp, strike: terms.cap });
      return f && { ...f, pYes: clamp(1 - f.pYes, P_MIN, P_MAX), d2: -f.d2 };
    }
  }
}

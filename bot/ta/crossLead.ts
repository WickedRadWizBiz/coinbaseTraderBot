// Cross-coin lead-lag: when a leader coin (BTC, ETH) moves, does a follower coin make up the part of that move it has not
// made yet over the next minutes or hour? research/crossLead.ts measures it on years of 1-minute history, walk-forward;
// this module holds the result and computes the same reading in training and live.
//
//   gap       at time t, horizon h minutes (looking back the same h): beta * r_L(t - h, t) - r_F(t - h, t), the part of the
//             leader's move the follower has not made yet (beta: how much the follower moves with the leader; r: log return)
//   expected  a * gap: the follower's expected return over the next h minutes (a: the catch-up slope fitted on past data),
//             summed over the leaders validated for that follower and horizon; each consumer divides it by the follower's
//             own volatility over h (the Kalshi features by the per-minute volatility of the settlement index's bars, the
//             setup scorer and its exit by the std of the coin's 15-minute returns)
//
// A pair is used only when it was predictive out of sample (research/crossLead.ts). Whether it pays is decided where it is
// used: the setup scorer keeps its "crosslead" inputs only if they raise the development years' P&L, its lead-lag exit is
// switched on only if it improves the trades' net R out of sample, and the Kalshi models select their own features.
// Training reads each time through the fit made before it (the walk-forward folds); live reads the final fit.

import fs from 'fs';
import type { Candle } from './indicators';

export const CL_SCHEMA = 'crosslead1';
export const CL_HORIZONS = [1, 5, 15, 60] as const;
/** The horizons the setup scorer and its exit read (15-minute bars). */
export const CL_SETUP_HORIZONS = [15, 60] as const;
export const CL_LEADERS = ['BTC', 'ETH'];

export interface CrossLeadOos { ic: number; icLo: number; netBps: number; netLo: number; trades: number; days: number; quartersUp: number; quarters: number }
export interface CrossLeadPair {
  leader: string; follower: string; h: number;
  /** The final fit (on the latest two years): what live reads. */
  beta: number; a: number;
  /** Walk-forward fits: [from, to, beta, a], each fitted on data before `from` (what training reads at a time in [from, to)). */
  walk: Array<[number, number, number, number]>;
  /** Predictive out of sample (the catch-up slope's information coefficient held up): the pair's inputs are filled. */
  validated: boolean;
  /** Also paid for its own round trip after costs (reported; nothing trades it on its own). */
  tradable: boolean;
  why: string;
  oos: CrossLeadOos;
}
export interface CrossLeadParams { schema: string; version: string; at: string; from: string; to: number; costBps: number; tests: number; pairs: CrossLeadPair[] }

export class CrossLead {
  private readonly by = new Map<string, CrossLeadPair[]>();
  constructor(readonly params: CrossLeadParams) {
    for (const p of params.pairs) if (p.validated) { const k = `${p.follower}|${p.h}`; (this.by.get(k) ?? this.by.set(k, []).get(k)!).push(p); }
  }
  static load(file: string): CrossLead {
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as CrossLeadParams;
    if (p.schema !== CL_SCHEMA) throw new Error(`${file}: schema ${p.schema}, expected ${CL_SCHEMA}`);
    return new CrossLead(p);
  }
  /** Validated leaders of a follower at a horizon. */
  leaders(follower: string, h: number): CrossLeadPair[] { return this.by.get(`${follower}|${h}`) ?? []; }
  /** Whether any horizon of this follower is validated. */
  any(follower: string): boolean { return CL_HORIZONS.some((h) => this.leaders(follower, h).length > 0); }

  /** The follower's expected log return over the next h minutes, from each asset's log return over the last h minutes
   *  (`ret(asset)`); `t` set: the walk-forward fit covering t (training; undefined before the first fold), the final fit
   *  after the study's data; `t` undefined: the final fit (live). Undefined without a validated leader or a return. */
  expected(follower: string, h: number, ret: (asset: string) => number | undefined, t?: number): number | undefined {
    const ls = this.leaders(follower, h);
    if (!ls.length) return undefined;
    const rf = ret(follower);
    if (rf === undefined || !Number.isFinite(rf)) return undefined;
    let sum = 0, n = 0;
    for (const p of ls) {
      const fit = t === undefined || t >= this.params.to ? { beta: p.beta, a: p.a } : foldAt(p.walk, t);
      if (!fit) continue;
      const rl = ret(p.leader);
      if (rl === undefined || !Number.isFinite(rl)) continue;
      sum += fit.a * (fit.beta * rl - rf); n++;
    }
    return n ? sum : undefined;
  }
}

function foldAt(walk: CrossLeadPair['walk'], t: number): { beta: number; a: number } | undefined {
  let lo = 0, hi = walk.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const [from, to, beta, a] = walk[m];
    if (t < from) hi = m - 1; else if (t >= to) lo = m + 1; else return { beta, a };
  }
  return undefined;
}

// ---- The setup scorer's inputs and exit: 15-minute bars --------------------------------------------------------------

const M15 = 900_000;

/** Index of the last 15-minute bar closed by t (bars sorted by open time). */
function lastClosed15(cs: Candle[], t: number): number {
  let lo = 0, hi = cs.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cs[m].ts + M15 <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/** Close time of the last 15-minute bar closed by t. */
export function lastClose15(cs: Candle[] | undefined, t: number): number | undefined {
  const i = cs?.length ? lastClosed15(cs, t) : -1;
  return i >= 0 ? cs![i].ts + M15 : undefined;
}

/** Log return over the h minutes up to t from 15-minute bars, the last of them closing exactly at t (undefined when that
 *  bar or one in the span is missing: every coin's return covers the same minutes). */
export function ret15(cs: Candle[] | undefined, t: number, h: number): number | undefined {
  if (!cs?.length) return undefined;
  const i = lastClosed15(cs, t), k = h / 15;
  if (i < k || cs[i].ts + M15 !== t) return undefined;
  if (cs[i].ts - cs[i - k].ts !== k * M15) return undefined;
  const r = Math.log(cs[i].c / cs[i - k].c);
  return Number.isFinite(r) ? r : undefined;
}

/** Std of the 15-minute log returns over the last day (96 bars) closed by t. */
export function sigma15(cs: Candle[] | undefined, t: number): number | undefined {
  if (!cs?.length) return undefined;
  const i = lastClosed15(cs, t);
  if (i < 97) return undefined;
  let s = 0, s2 = 0, n = 0;
  for (let j = i - 95; j <= i; j++) { if (cs[j].ts - cs[j - 1].ts !== M15) continue; const r = Math.log(cs[j].c / cs[j - 1].c); if (Number.isFinite(r)) { s += r; s2 += r * r; n++; } }
  if (n < 48) return undefined;
  const v = s2 / n - (s / n) ** 2;
  return v > 0 ? Math.sqrt(v) : undefined;
}

export interface CrossLeadReading { exp15?: number; exp60?: number }

/** The setup scorer's reading for `asset` at time t: the expected move over the next 15 / 60 minutes in units of the coin's
 *  own volatility over that span, from 15-minute bars of every coin up to the coin's last bar closed by t (a leader whose
 *  bar for the same 15 minutes is not in yet is left out; nothing when the coin's own last bar is older than 30 minutes). */
export function crossLeadSetupReading(cl: CrossLead | undefined, asset: string, t: number, m15: (asset: string) => Candle[] | undefined, live = false): CrossLeadReading | undefined {
  if (!cl?.any(asset)) return undefined;
  const own = m15(asset), at = lastClose15(own, t);
  if (at === undefined || t - at > 2 * M15) return undefined;
  const sd = sigma15(own, at);
  if (!sd) return undefined;
  const out: CrossLeadReading = {};
  for (const h of CL_SETUP_HORIZONS) {
    const e = cl.expected(asset, h, (a) => ret15(m15(a), at, h), live ? undefined : at);
    if (e !== undefined) out[h === 15 ? 'exp15' : 'exp60'] = clip(e / (sd * Math.sqrt(h / 15)), 10);
  }
  return out.exp15 === undefined && out.exp60 === undefined ? undefined : out;
}

/** Both horizons' expected moves together (the exit's reading): undefined when neither is there. */
export function crossLeadSum(r: CrossLeadReading | undefined): number | undefined {
  if (!r) return undefined;
  const xs = [r.exp15, r.exp60].filter((x): x is number => x !== undefined && Number.isFinite(x));
  return xs.length ? xs.reduce((a, b) => a + b, 0) : undefined;
}

export const CL_SETUP_KEYS = ['cl_exp15', 'cl_exp60', 'o_cl_exp15', 'o_cl_exp60'];
/** Fill the setup scorer's "crosslead" inputs (NaN without a reading); o_ copies are oriented to the trade's side. */
export function crossLeadSetupFeatures(out: Record<string, number>, dir: number, r: CrossLeadReading | undefined): void {
  out.cl_exp15 = r?.exp15 ?? NaN; out.cl_exp60 = r?.exp60 ?? NaN;
  out.o_cl_exp15 = dir * out.cl_exp15; out.o_cl_exp60 = dir * out.cl_exp60;
}

const clip = (x: number, lim: number) => Math.max(-lim, Math.min(lim, x));

// ---- Shared instance (live bot, pipeline; research processes load CROSS_LEAD_PATH) ------------------------------------

let active: { file?: () => string | undefined; at?: string; mtime: number; checkedAt: number; model?: CrossLead } = { mtime: -1, checkedAt: -Infinity };

/** Read the study from `file` (a path, or a function giving the current one), reloading it (checked once a minute). */
export function setCrossLeadPath(file: string | (() => string | undefined) | undefined): void {
  active = { file: typeof file === 'function' ? file : file === undefined ? undefined : () => file, mtime: -1, checkedAt: -Infinity };
}

/** The installed study (research processes load CROSS_LEAD_PATH on first use). */
export function activeCrossLead(now = Date.now()): CrossLead | undefined {
  if (active.checkedAt === -Infinity && !active.file && process.env.CROSS_LEAD_PATH) { const p = process.env.CROSS_LEAD_PATH; active.file = () => p; }
  if (active.file && now - active.checkedAt >= 60_000) {
    active.checkedAt = now;
    const f = active.file();
    let m = 0;
    try { m = f ? fs.statSync(f).mtimeMs : 0; } catch { /* missing */ }
    if (m !== active.mtime || f !== active.at) { active.mtime = m; active.at = f; try { active.model = m && f ? CrossLead.load(f) : undefined; } catch { active.model = undefined; } }
  }
  return active.model;
}

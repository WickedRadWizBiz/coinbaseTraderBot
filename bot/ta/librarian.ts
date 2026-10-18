// The Librarian (the 4th-generation spec's 3.1, as reviewed; the user's name for the Adversary with full access to the
// TA library, trained on the oracle). It reads what the TA network reads, every TA library reading at the close of an
// hourly bar (bot/ta/taNet.ts TANET_FEATURES), and answers two questions the direction heads do not:
//
//   strategy head     which of the bot's strategy families would have paid over the next LIB_HORIZON_H hours, after
//                     fees, as soft weights:
//                       trend     ride the 4h EMA stack (the trend-pullback setups' side)
//                       revert    fade the 1h Bollinger / RSI extremes (the fade and dip setups' side)
//                       breakout  follow a 20-bar Donchian break or a squeeze releasing (the burst and breakout setups)
//                       flat      stay out
//                     The oracle label is a softmax of what each family's position earned over the horizon, net of a
//                     round trip, in units of the coin's volatility (soft: two families that earned about the same
//                     share the label). It is a multinomial logistic model on the z-scored readings.
//   transition head   P(the coin's confirmed regime, bot/ta/regime.ts on daily labels with the playbook's two-day
//                     confirmation, changes within LIB_TRANSITION_H hours).
//
// From the weights: a continuous playbook, position = sum of weight x family position, and its agreement with the
// knowledge base's rule tally (net_all). Both heads are trained walk-forward (research/librarian.ts) and graded
// against persistence: the strategy head against the weights that paid in the coin's current regime (the regime
// persists) and against the family that paid over the last horizon (the winner persists), the transition head against
// the hazard by days since the last change. A head speaks to the general decision models only when it beat them out of
// sample; the setup trader reads both heads ungated and keeps them only if they raise its development years.

import fs from 'fs';
import { TANET_FEATURES } from './taNet';

export const LIB_SCHEMA = 'lib1';
export const LIB_STRATEGIES = ['trend', 'revert', 'breakout', 'flat'] as const;
export type LibStrategy = typeof LIB_STRATEGIES[number];
/** Hours the strategy label looks ahead (one decision per horizon in the grading). */
export const LIB_HORIZON_H = 24;
/** Hours the transition head looks ahead. */
export const LIB_TRANSITION_H = 72;
/** Round-trip cost of a family's position (10 bps, the rule study's). */
export const LIB_FEE_RT = 0.001;

const fin = Number.isFinite;

/** Each family's position (-1, 0, 1; flat always 0) at the close of an hourly bar, from the TA readings there. */
export function strategyPositions(f: (k: string) => number): number[] {
  const st4 = f('h4_ema_stack'), st1 = f('h1_ema_stack');
  const trend = fin(st4) ? st4 : fin(st1) ? st1 : 0;
  // h1_bb_pctb is %B - 0.5 (beyond +-0.45 = outside 95% of the band); h1_rsi is (RSI - 50) / 50 (beyond +-0.4 = 70 / 30).
  const pb = f('h1_bb_pctb'), rsi = f('h1_rsi');
  const revert = fin(pb) && Math.abs(pb) > 0.45 ? -Math.sign(pb) : fin(rsi) && Math.abs(rsi) > 0.4 ? -Math.sign(rsi) : 0;
  const dc = f('h1_donchian'), rel = f('h1_squeeze_release');
  const breakout = fin(dc) && dc !== 0 ? Math.sign(dc) : fin(rel) && rel > 0 && fin(pb) && pb !== 0 ? Math.sign(pb) : 0;
  return [trend, revert, breakout, 0];
}

/** Positions from a TANET_FEATURES row. */
const IDX = new Map(TANET_FEATURES.map((k, i) => [k, i]));
export const rowPositions = (row: ArrayLike<number>) => strategyPositions((k) => { const i = IDX.get(k); return i === undefined ? NaN : row[i]; });

/** The model's inputs: the TA row, then the family positions. */
export const LIB_INPUTS = [...TANET_FEATURES, ...LIB_STRATEGIES.slice(0, 3).map((s) => `pos_${s}`)];
export const libInputs = (row: ArrayLike<number>): number[] => [...Array.from(row), ...rowPositions(row).slice(0, 3)];

export interface LibHeadValidation {
  validated: boolean;
  why: string;
  /** Out-of-sample rows / decisions / days graded. */
  rows: number; days: number;
  [k: string]: number | boolean | string;
}

export interface LibrarianParams {
  schema: string;
  version: string;
  trainedAt: string;
  inputs: string[];
  horizonH: number; transitionH: number; feeRt: number;
  mean: number[]; std: number[];
  /** Strategy head: logits = W x z + b, one row per family. */
  strategy: { W: number[][]; b: number[]; validation: LibHeadValidation };
  /** Transition head: logit = w . z + b. */
  transition: { w: number[]; b: number; validation: LibHeadValidation };
  /** Mean oracle weights per regime key in the training rows (the regime-persistence baseline; shown). */
  regimeTable?: Record<string, number[]>;
  /** Inputs the oracle cull switched off (research/oracleCull.ts): trained and forecast with zero spread, i.e. absent. */
  cull?: string[];
}

export interface LibrarianReading {
  /** Soft weights per family (trend, revert, breakout, flat). */
  w: number[];
  /** Continuous playbook position: sum of weight x family position (-1..1). */
  net: number;
  /** Signed difference to the knowledge base's rule tally (tanh(net_all / 3)): its size is the disagreement. */
  vsBook: number;
  /** P(regime change within transitionH hours). */
  transition: number;
  validated: { strategy: boolean; transition: boolean };
}

const z = (v: number, m: number, s: number) => (fin(v) && s > 0 ? Math.max(-6, Math.min(6, (v - m) / s)) : 0);
export const softmax = (l: number[]) => { const mx = Math.max(...l); const e = l.map((v) => Math.exp(v - mx)); const s = e.reduce((a, b) => a + b, 0); return e.map((v) => v / s); };
const sig = (x: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));

/** Both heads on one TA row (TANET_FEATURES order). */
export function librarianPredict(p: LibrarianParams, row: ArrayLike<number>): LibrarianReading {
  const x = libInputs(row);
  const zz = x.map((v, i) => z(v, p.mean[i], p.std[i]));
  const w = softmax(p.strategy.W.map((wr, k) => wr.reduce((s, wi, i) => s + wi * zz[i], p.strategy.b[k])));
  const pos = rowPositions(row);
  const net = w.reduce((s, wk, k) => s + wk * pos[k], 0);
  const book = row[IDX.get('net_all')!];
  const transition = sig(p.transition.w.reduce((s, wi, i) => s + wi * zz[i], p.transition.b));
  return { w, net, vsBook: net - (fin(book) ? Math.tanh(book / 3) : 0), transition, validated: { strategy: p.strategy.validation.validated, transition: p.transition.validation.validated } };
}

export class Librarian {
  constructor(readonly params: LibrarianParams) {}
  static load(file: string): Librarian | undefined {
    if (!fs.existsSync(file)) return undefined;
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as LibrarianParams;
    if (p.schema !== LIB_SCHEMA) throw new Error(`Librarian ${file} has schema ${p.schema}, this build needs ${LIB_SCHEMA} (retrain it)`);
    if (p.inputs?.length !== LIB_INPUTS.length || p.inputs.some((k, i) => k !== LIB_INPUTS[i])) throw new Error(`Librarian ${file} was trained on other inputs (the TA network's inputs changed): retrain it`);
    if (p.mean.length !== LIB_INPUTS.length || p.strategy.W.length !== LIB_STRATEGIES.length || p.strategy.W.some((r) => r.length !== LIB_INPUTS.length) || p.transition.w.length !== LIB_INPUTS.length) throw new Error(`invalid Librarian ${file}`);
    return new Librarian(p);
  }
  get version(): string { return this.params.version; }
  predict(row: ArrayLike<number>): LibrarianReading { return librarianPredict(this.params, row); }
}

// ---- Shared instance (live features; research processes load LIBRARIAN_PATH) ---------------------------------------

let active: { lib?: Librarian; file?: () => string | undefined; at?: string; mtime: number; checkedAt: number } = { mtime: -1, checkedAt: -Infinity };

/** Install (or remove) the Librarian the general features read. */
export function setLibrarian(lib: Librarian | undefined): void { active = { lib, mtime: -1, checkedAt: Infinity }; }

/** Read the Librarian from `file` (a path, or a function giving the current one), reloading it, checked once a
 *  minute, when the pipeline replaces it. */
export function setLibrarianPath(file: string | (() => string | undefined) | undefined): void {
  active = { file: typeof file === 'function' ? file : file === undefined ? undefined : () => file, mtime: -1, checkedAt: -Infinity };
}

/** The installed Librarian; research processes load LIBRARIAN_PATH on first use. */
export function activeLibrarian(now = Date.now()): Librarian | undefined {
  if (active.checkedAt === -Infinity && !active.file && process.env.LIBRARIAN_PATH) { const p = process.env.LIBRARIAN_PATH; active.file = () => p; }
  if (active.file && now - active.checkedAt >= 60_000) {
    active.checkedAt = now;
    const f = active.file();
    let m = 0;
    try { m = f ? fs.statSync(f).mtimeMs : 0; } catch { /* missing */ }
    if (m !== active.mtime || f !== active.at) { active.mtime = m; active.at = f; try { active.lib = m && f ? Librarian.load(f) : undefined; } catch { active.lib = undefined; } }
  }
  return active.lib;
}

/** Feature keys for the setup trader (side-oriented copies, "librarian" group). */
export const LIB_SETUP_KEYS = ['lib_trend', 'lib_revert', 'lib_breakout', 'lib_flat', 'lib_net', 'o_lib_net', 'lib_vs_book', 'o_lib_vs_book', 'lib_trans'];

/** A reading at a setup: [w x4, net, vsBook, transition] (NaN when none). */
export function libSetupFeatures(out: Record<string, number>, dir: number, r: { w: number[]; net: number; vsBook: number; transition: number } | undefined): void {
  LIB_STRATEGIES.forEach((s, k) => { out[`lib_${s}`] = r ? r.w[k] : NaN; });
  out.lib_net = r ? r.net : NaN;
  out.o_lib_net = dir * out.lib_net;
  out.lib_vs_book = r ? r.vsBook : NaN;
  out.o_lib_vs_book = dir * out.lib_vs_book;
  out.lib_trans = r ? r.transition : NaN;
}

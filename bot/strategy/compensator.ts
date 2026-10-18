// The Compensator: smooth, learned strategy switching on the TA library's reading of each coin.
//
// The strategy playbook (bot/strategy/playbook.ts) switches in steps: one weight per regime. The Compensator gives
// each strategy its own ramp on one of the Librarian's readings (bot/ta/librarian.ts: the oracle-trained weights of
// the trend / revert / breakout / flat families, its net position and the chance the regime changes):
//
//   p = sigmoid(k * (s - theta))          s the reading at the start of the coin's day, k the slope, theta the threshold
//   weight = lo + (1 - lo) * 2p           below p = 1/2 (the strategy more likely loses than pays in hindsight)
//          = 1 + (hi - 1) * (2p - 1)      above it
//
// so the weight passes 1 where the strategy breaks even and moves toward the range's floor or ceiling as the reading
// says it will lose or pay. Slope and threshold are fitted by research/compensator.ts against hindsight: on replay
// coin-days each strategy's label is whether it paid (weighted by how much it made or lost), the bar the
// top-performing allocation would have set; a strategy whose readings say nothing keeps a flat weight (its base rate).
// The strategies are Kalshi's contracts and each perps setup kind (bot/setups/detectors.ts):
//
//   kalshi          0 .. 1      the Kalshi order size cap (as the playbook's family weight)
//   setup:<kind>    0 .. 1.5    that setup kind's risk per trade (the perps daily stop and margin caps still bind)
//
// A coin's reading is taken once per UTC day (its first reading after midnight, as in training), so weights do not
// flap inside the day. Switched on only when the ramps fitted on earlier replay days beat the static bot AND the step
// playbook on later days; when on (and the coin has a reading) it replaces the playbook's weight, otherwise the
// playbook applies. <AUTO_TRAIN_DIR>/compensator.json is re-read when it changes; COMPENSATOR_APPLY=false ignores it.

import fs from 'fs';
import path from 'path';
import type { SetupKind } from '../setups/detectors';
import { activeLibrarian } from '../ta/librarian';
import { activeTaNet, marketCandleSets } from '../ta/taNet';
import { WEIGHT_RANGE } from './playbook';

export const COMP_SCHEMA = 'comp1';
export const COMP_INPUTS = ['lib_trend', 'lib_revert', 'lib_breakout', 'lib_flat', 'lib_net', 'lib_abs_net', 'lib_trans'] as const;
export type CompInput = typeof COMP_INPUTS[number];
export const SETUP_KINDS: SetupKind[] = ['fade', 'pullback', 'burst', 'breakout', 'dip', 'spotpb'];
export const COMP_STRATEGIES = ['kalshi', ...SETUP_KINDS.map((k) => `setup:${k}`)];
export const compRange = (strategy: string): readonly [number, number] => (strategy === 'kalshi' ? WEIGHT_RANGE.kalshi : WEIGHT_RANGE.perps);

export interface CompRamp {
  /** The reading the ramp is on (null: no reading helped, the weight is flat at the base rate's). */
  input: CompInput | null;
  /** Slope (per unit of the reading) and threshold: p = sigmoid(k (s - theta)). */
  k: number; theta: number;
  /** Stake-weighted share of paying coin-days (the flat ramp's p). */
  base: number;
  lo: number; hi: number;
  /** Coin-days the strategy traded on (fit), and the evidence for the reading (deviance drop over the base rate). */
  n: number; devianceDrop: number;
  why?: string;
}

export interface CompensatorFile {
  schema: typeof COMP_SCHEMA; version: string; at: string;
  enabled: boolean;
  ramps: Record<string, CompRamp>;
  validation?: { days: number; staticUsd: number; playbookUsd: number; compUsd: number; staticMaxDdUsd: number; compMaxDdUsd: number; why: string };
}

export interface LibDayReading { w: number[]; net: number; transition: number }

export const compInputs = (r: LibDayReading): Record<CompInput, number> => ({
  lib_trend: r.w[0], lib_revert: r.w[1], lib_breakout: r.w[2], lib_flat: r.w[3], lib_net: r.net, lib_abs_net: Math.abs(r.net), lib_trans: r.transition,
});

const sig = (x: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));

/** P(the strategy pays) under the ramp (the base rate when it has no input or the reading is missing). */
export function rampP(r: CompRamp, x: Record<CompInput, number> | undefined): number {
  const s = r.input && x ? x[r.input] : NaN;
  return Number.isFinite(s) ? sig(r.k * (s - r.theta)) : r.base;
}

/** The weight for a probability of paying: 1 at even odds, the floor at 0 and the ceiling at 1. */
export function weightOfP(p: number, lo: number, hi: number): number {
  return p < 0.5 ? lo + (1 - lo) * 2 * p : 1 + (hi - 1) * (2 * p - 1);
}

export function rampWeight(r: CompRamp | undefined, x: Record<CompInput, number> | undefined, strategy = 'kalshi'): number {
  if (!r) return 1;
  const [lo, hi] = compRange(strategy);
  const w = weightOfP(rampP(r, x), Math.max(lo, r.lo), Math.min(hi, r.hi));
  return Number.isFinite(w) ? Math.min(hi, Math.max(lo, w)) : 1;
}

export const compensatorPath = (dir: string) => path.join(dir, 'compensator.json');

export function readCompensator(file: string): CompensatorFile | undefined {
  try {
    const f = JSON.parse(fs.readFileSync(file, 'utf8')) as CompensatorFile;
    return f?.schema === COMP_SCHEMA && f.ramps && typeof f.ramps === 'object' ? f : undefined;
  } catch { return undefined; }
}

const DAY = 86_400_000, H = 3_600_000;

/** The Librarian's reading of a coin now, once the hourly bar that closed at or after midnight UTC is in (the reading
 *  training used: research/librarian.ts LibIndex at the day's start). */
export function liveLibReading(asset: string, now: number): LibDayReading | undefined {
  const lib = activeLibrarian(), rt = lib ? activeTaNet() : undefined;
  if (!lib || !rt) return undefined;
  let o;
  try { o = rt.outputFor(asset, marketCandleSets()?.get(asset), now); } catch { return undefined; }
  if (!o || o.barTs + H < Math.floor(now / DAY) * DAY) return undefined;
  const row = rt.row(asset, o.barTs);
  return row ? lib.predict(row) : undefined;
}

/** Live holder: re-reads the file when its time changes (checked at most every 30 s); one reading per coin per UTC day. */
export class Compensator {
  private file?: CompensatorFile;
  private mtime = -1;
  private checked = -Infinity;
  private readonly day = new Map<string, { day: number; x: Record<CompInput, number> }>();
  constructor(private readonly dir: string, private readonly apply = true) {}

  current(now = Date.now()): CompensatorFile | undefined {
    if (!this.apply) return undefined;
    if (now - this.checked >= 30_000) {
      this.checked = now;
      let m = -1;
      try { m = fs.statSync(compensatorPath(this.dir)).mtimeMs; } catch { /* absent */ }
      if (m !== this.mtime) { this.mtime = m; this.file = m < 0 ? undefined : readCompensator(compensatorPath(this.dir)); }
    }
    return this.file;
  }

  /** The coin's reading for today: the first one `read` gives after midnight UTC (kept for the day). */
  dayInputs(asset: string, now: number, read: () => LibDayReading | undefined): Record<CompInput, number> | undefined {
    const d = Math.floor(now / DAY), have = this.day.get(asset);
    if (have?.day === d) return have.x;
    const r = read();
    if (!r) return undefined;
    const x = compInputs(r);
    this.day.set(asset, { day: d, x });
    return x;
  }

  /** The strategy's weight on this coin today; undefined when the Compensator is off or the coin has no reading yet
   *  (the caller then uses the playbook). */
  weight(asset: string, strategy: string, now = Date.now(), read: () => LibDayReading | undefined = () => liveLibReading(asset, now)): { w: number; source: string } | undefined {
    const f = this.current(now);
    if (!f?.enabled) return undefined;
    const x = this.dayInputs(asset, now, read);
    if (!x) return undefined;
    const r = f.ramps[strategy];
    return { w: rampWeight(r, x, strategy), source: r?.input ? `${r.input} ${x[r.input].toFixed(2)}` : 'flat' };
  }

  status(now = Date.now()) {
    const f = this.current(now);
    const coins = Object.fromEntries([...this.day].filter(([, v]) => v.day === Math.floor(now / DAY)).map(([a, v]) => [a, Object.fromEntries(COMP_STRATEGIES.map((s) => [s, +rampWeight(f?.ramps[s], v.x, s).toFixed(3)]))]));
    return { apply: this.apply, version: f?.version ?? null, enabled: f?.enabled ?? false, validation: f?.validation ?? null, ramps: f?.ramps ?? null, coins };
  }
}

let live: Compensator | undefined;
export function setCompensator(c: Compensator | undefined): void { live = c; }
export function compensator(): Compensator | undefined { return live; }

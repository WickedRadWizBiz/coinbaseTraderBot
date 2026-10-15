// Waterfall mode: the bot's stance for a BTC-dominance collapse (the alt season the Fractal Alignment Engine,
// bot/macro/fractalEngine.ts, places the 2018-to-now cycle against: the parent's final waterfall).
//
// The gate. BTC.D closing at or below WATERFALL_GATE (55%) on the way down from a cycle peak at least 5 points
// higher (within two years) is "the first 55% hit". It is latched and persisted (DATA_DIR/waterfall.json) and only
// then can the operator arm the mode on the dashboard. Arming before the gate is refused; disarming always works.
//
// The trigger, triangulated from four legs:
//   gate      BTC.D's last daily close is below the gate
//   fractal   the engine fits the cycle well (correlation >= minFit over the path and the last year) and puts
//             now inside a parent waterfall, or one projected to start within leadWeeks
//   usdt      a USDT.D breakdown: the lowest close of the last 7 days under the lowest of the 30 before them,
//             and the last close under its 30-day average (stablecoin share falling: money going to risk)
//   shib      SHIB volume velocity: the last 7 days' average daily quote volume at least shibVelocity x the
//             median day of the 90 before them (retail speculation arriving)
// It fires on gate + fractal + (usdt or shib).
//
// What the mode does (new entries only; open positions keep their exits):
//   armed      tennis stops opening (0%), and Kalshi binaries are held to kalshiMaxFrac of the bank (the total
//              risk cap is lowered to it)
//   triggered  Kalshi binaries stop opening too (halted below the gate); the perps setup lanes lean into the
//              alts: alt longs at altLongMult x risk, alt shorts not opened, BTC at btcMult x risk, all inside the
//              lanes' own caps and the liquidation cap. The alt-long boost tapers to 1 as BTC.D falls from the
//              gate toward the engine's projected low, and alt longs stop opening within lowBufferPts of it (the
//              parent's waterfall ended there; the core / stack exit schedule is the gated 5.1 work).

import type { Candle } from '../ta/indicators';
import { readJson, writeJsonAtomic } from '../util/persist';
import type { FractalState } from './fractalEngine';

const DAY = 86_400_000;

export interface WaterfallParams {
  gate: number;
  minFit: number;
  leadWeeks: number;
  shibVelocity: number;
  kalshiMaxFrac: number;
  altLongMult: number;
  btcMult: number;
  lowBufferPts: number;
}

export const DEFAULT_WATERFALL: WaterfallParams = { gate: 55, minFit: 0.8, leadWeeks: 8, shibVelocity: 2, kalshiMaxFrac: 0.125, altLongMult: 1.5, btcMult: 0.5, lowBufferPts: 3 };

export interface WaterfallLegs { gate: boolean; fractal: boolean; usdt: boolean; shib: boolean }

export interface WaterfallReading {
  legs: WaterfallLegs;
  signal: boolean;
  confirmations: number;
  btcd?: number;
  usdtd?: number;
  shibVelocity?: number;
  why: string[];
}

/** The last `n` daily closes known at `at` (the bar has closed), skipping empty ones. */
function closesUpTo(d: Candle[] | undefined, at: number, n: number): Candle[] {
  if (!d?.length) return [];
  let lo = 0, hi = d.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (d[m].ts + DAY <= at) lo = m + 1; else hi = m; }
  return d.slice(Math.max(0, lo - n - 10), lo).filter((c) => Number.isFinite(c.c) && c.c > 0).slice(-n);
}

/** A USDT.D breakdown at `at`: the last 7 days' low under the 30 days' before, and the close under its 30-day mean. */
export function usdtBreakdown(usdtd: Candle[] | undefined, at: number): boolean | undefined {
  const c = closesUpTo(usdtd, at, 37);
  if (c.length < 37) return undefined;
  const recent = c.slice(-7), before = c.slice(0, 30), last30 = c.slice(-30);
  const avg = last30.reduce((s, x) => s + x.c, 0) / 30;
  return Math.min(...recent.map((x) => x.c)) < Math.min(...before.map((x) => x.c)) && c[c.length - 1].c < avg;
}

/** SHIB volume velocity at `at`: mean daily quote volume of the last 7 days / the median of the 90 before. */
export function shibVelocity(shib: Candle[] | undefined, at: number): number | undefined {
  const c = closesUpTo(shib, at, 97);
  if (c.length < 97) return undefined;
  const q = (x: Candle) => (x.v ?? 0) * x.c;
  const recent = c.slice(-7).reduce((s, x) => s + q(x), 0) / 7;
  const base = c.slice(0, 90).map(q).sort((a, b) => a - b)[45];
  return base > 0 ? recent / base : undefined;
}

/** The four legs and the trigger at `at` from daily closes and the engine's state. */
export function waterfallReading(o: { btcd?: Candle[]; usdtd?: Candle[]; shib?: Candle[]; fractal?: FractalState; at: number }, p: WaterfallParams = DEFAULT_WATERFALL): WaterfallReading {
  const why: string[] = [];
  const btcd = closesUpTo(o.btcd, o.at, 1)[0]?.c;
  const gate = btcd !== undefined && btcd < p.gate;
  why.push(btcd === undefined ? 'gate: no BTC.D' : `gate: BTC.D ${btcd.toFixed(2)}% ${gate ? '<' : '>='} ${p.gate}%`);
  const f = o.fractal;
  const fitted = !!f && f.fit.r >= p.minFit && f.fit.recentR >= p.minFit;
  const near = !!f?.nextWaterfall && (f.nextWaterfall.inside || f.nextWaterfall.weeksAway <= p.leadWeeks);
  const fractal = fitted && near;
  why.push(!f ? 'fractal: no alignment (parent history missing or under a year of child)' : `fractal: fit ${f.fit.r.toFixed(2)} / last year ${f.fit.recentR.toFixed(2)}${fitted ? '' : ` (< ${p.minFit})`}; ${f.nextWaterfall ? (f.nextWaterfall.inside ? 'inside the parent waterfall' : `parent waterfall in ${f.nextWaterfall.weeksAway.toFixed(0)} weeks`) : 'no parent waterfall ahead'}`);
  const u = usdtBreakdown(o.usdtd, o.at);
  const usdtd = closesUpTo(o.usdtd, o.at, 1)[0]?.c;
  why.push(u === undefined ? 'usdt: under 37 days of USDT.D' : `usdt: ${u ? 'breakdown' : 'no breakdown'}${usdtd !== undefined ? ` (USDT.D ${usdtd.toFixed(2)}%)` : ''}`);
  const v = shibVelocity(o.shib, o.at);
  const shib = v !== undefined && v >= p.shibVelocity;
  why.push(v === undefined ? 'shib: under 97 days of SHIB' : `shib: volume velocity ${v.toFixed(2)}x${shib ? '' : ` (< ${p.shibVelocity}x)`}`);
  const legs = { gate, fractal, usdt: u === true, shib };
  return { legs, signal: gate && fractal && (legs.usdt || shib), confirmations: Object.values(legs).filter(Boolean).length, btcd, usdtd, shibVelocity: v, why };
}

/** The first 55% hit at `at`: the last close at or below the gate, after a peak at least 5 points above it within
 *  two years. */
export function gateHit(btcd: Candle[] | undefined, at: number, gate: number): { ts: number; level: number; peak: number } | undefined {
  const c = closesUpTo(btcd, at, 731);
  const last = c[c.length - 1];
  if (!last || last.c > gate) return undefined;
  const peak = Math.max(...c.filter((x) => x.ts >= last.ts - 730 * DAY).map((x) => x.c));
  return peak >= gate + 5 ? { ts: last.ts, level: last.c, peak } : undefined;
}

export type WaterfallLevel = 'off' | 'armed' | 'triggered';

/** What the mode changes for one new entry. */
export interface WaterfallPolicy {
  level: WaterfallLevel;
  /** Tennis: no new entries. */
  tennisBlocked: boolean;
  /** Kalshi binaries: total risk cap (fraction of the bank), or blocked. */
  kalshiMaxFrac?: number;
  kalshiBlocked: boolean;
  /** Perps setups: risk multiplier for an asset and side (0 = not opened). */
  perpMult(asset: string, dir: 1 | -1): number;
  why: string;
}

const NONE: WaterfallPolicy = { level: 'off', tennisBlocked: false, kalshiBlocked: false, perpMult: () => 1, why: 'waterfall mode off' };

/** The policy at a level, with the engine's projected low for the alt-long taper. */
export function waterfallPolicy(level: WaterfallLevel, p: WaterfallParams, btcd?: number, projectedLow?: number): WaterfallPolicy {
  if (level === 'off') return NONE;
  if (level === 'armed') return { level, tennisBlocked: true, kalshiMaxFrac: p.kalshiMaxFrac, kalshiBlocked: false, perpMult: () => 1, why: `armed: tennis paused, Kalshi binaries held to ${(p.kalshiMaxFrac * 100).toFixed(1)}% of the bank` };
  const low = projectedLow !== undefined && Number.isFinite(projectedLow) && projectedLow < p.gate ? projectedLow : undefined;
  const room = low !== undefined && btcd !== undefined ? Math.max(0, Math.min(1, (btcd - low - p.lowBufferPts) / Math.max(1e-9, p.gate - low - p.lowBufferPts))) : 1;
  const altLong = low !== undefined && btcd !== undefined && btcd <= low + p.lowBufferPts ? 0 : 1 + (p.altLongMult - 1) * room;
  return {
    level, tennisBlocked: true, kalshiBlocked: true,
    perpMult: (asset, dir) => (asset === 'BTC' ? p.btcMult : dir > 0 ? altLong : 0),
    why: `triggered: tennis and Kalshi binaries paused; alt longs ${altLong.toFixed(2)}x${low !== undefined ? ` (projected low ${low.toFixed(1)}%)` : ''}, alt shorts off, BTC ${p.btcMult}x`,
  };
}

interface Persisted { gateHitAt?: number; gateHitLevel?: number; gatePeak?: number; armed?: boolean; armedAt?: number; by?: string }

/** The persisted gate latch and arming switch. */
export class WaterfallSwitch {
  private st: Persisted;
  constructor(private readonly file?: string) { this.st = (file ? readJson<Persisted>(file) : undefined) ?? {}; }

  get gateHitAt(): number | undefined { return this.st.gateHitAt; }
  get armed(): boolean { return this.st.armed === true && this.st.gateHitAt !== undefined; }

  /** Latch the first gate hit (true when this call latched it). */
  observe(hit: { ts: number; level: number; peak: number } | undefined): boolean {
    if (!hit || this.st.gateHitAt !== undefined) return false;
    this.st = { ...this.st, gateHitAt: hit.ts, gateHitLevel: hit.level, gatePeak: hit.peak };
    this.save();
    return true;
  }

  /** Arm or disarm; arming before the gate was hit is refused. */
  setArmed(on: boolean, by = 'dashboard', now = Date.now()): { ok: boolean; error?: string } {
    if (on && this.st.gateHitAt === undefined) return { ok: false, error: 'BTC.D has not hit the gate yet: waterfall mode can be armed only after its first close at or below the gate' };
    this.st = { ...this.st, armed: on, armedAt: now, by };
    this.save();
    return { ok: true };
  }

  status() { return { gateHitAt: this.st.gateHitAt ?? null, gateHitLevel: this.st.gateHitLevel ?? null, gatePeak: this.st.gatePeak ?? null, armed: this.armed, armedAt: this.st.armedAt ?? null, armable: this.st.gateHitAt !== undefined }; }

  private save(): void { if (this.file) writeJsonAtomic(this.file, this.st); }
}

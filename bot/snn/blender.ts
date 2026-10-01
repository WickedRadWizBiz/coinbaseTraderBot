// Decision-side SNN blender (main thread). The SNN is never safety-critical: hard limits,
// whitelist, position caps, daily loss stop and kill switch all sit outside it.
//
//   p_final = (1 - alpha c) p_model + alpha c p_snn
//   alpha   starts at 0, capped at 0.25, EARNED by rolling out-of-sample Brier: the grid alpha* in
//           [0, 0.25] minimising the blended Brier over recent settled contracts, adopted only when
//           the day-block bootstrap 95% CI of the per-event paired difference
//           Brier(blend at alpha*) - Brier(model) lies entirely below 0. Otherwise alpha = 0.
//   c       = c_cal x min(1, S0/S_t) x (1 - delta' G): calibration-derived (reliability slope of
//           p_snn), and surprise and the governor may only REDUCE it.
// Every scanned contract is logged at settlement, traded or not.

import fs from 'fs';
import path from 'path';
import { blend, brier, calibrationSlope, sat01, surpriseConfidence } from './formulas';
import { Xoshiro128 } from './rng';

export interface BlendRecord { ticker: string; eventKey: string; ts: number; pModel: number; pSnn: number; c: number; y?: 0 | 1 }

export interface BlenderOpts {
  alphaMax: number; minEvents: number; windowEvents: number; recordEverySec: number; govDeltaP: number;
  /** Use surprise in c (stage S4); off => c = c_cal x governor factor. */
  surpriseToC: boolean;
  bootstrapIters: number;
}

export const DEFAULT_BLENDER: BlenderOpts = { alphaMax: 0.25, minEvents: 200, windowEvents: 2000, recordEverySec: 60, govDeltaP: 0.5, surpriseToC: true, bootstrapIters: 1000 };

export interface Earned { alpha: number; alphaStar: number; ciHi: number | null; meanDiff: number | null; events: number; reason: string }

export class SnnBlender {
  private readonly pending = new Map<string, BlendRecord>();
  readonly settled: BlendRecord[] = [];
  private lastRecord = new Map<string, number>();
  earned: Earned = { alpha: 0, alphaStar: 0, ciHi: null, meanDiff: null, events: 0, reason: 'no settled events yet' };
  private dirty = true;

  constructor(private readonly o: BlenderOpts = DEFAULT_BLENDER) {}

  /** c_cal from the reliability slope of recent p_snn: 1 at slope 1, falling to 0 at |slope - 1| >= 0.5. */
  calibrationConfidence(): number {
    const s = this.settled.slice(-this.o.windowEvents);
    if (s.length < this.o.minEvents) return 0;
    const b = calibrationSlope(s.map((r) => r.pSnn), s.map((r) => r.y!));
    return Number.isFinite(b) ? sat01(1 - Math.abs(b - 1) / 0.5) : 0;
  }

  confidence(surprise: number, surprise0: number, G: number): number {
    const cCal = this.calibrationConfidence();
    const c = this.o.surpriseToC ? surpriseConfidence(cCal, surprise0, surprise) : cCal;
    return c * (1 - this.o.govDeltaP * sat01(G));
  }

  /** Remember the pair for this contract (latest per contract; throttled). */
  record(r: BlendRecord): void {
    if (r.ts - (this.lastRecord.get(r.ticker) ?? -Infinity) < this.o.recordEverySec * 1000) return;
    this.lastRecord.set(r.ticker, r.ts);
    this.pending.set(r.ticker, r);
  }

  settle(ticker: string, y: 0 | 1): BlendRecord | undefined {
    const r = this.pending.get(ticker);
    this.lastRecord.delete(ticker);
    if (!r) return undefined;
    this.pending.delete(ticker);
    const done = { ...r, y };
    this.settled.push(done);
    if (this.settled.length > this.o.windowEvents * 2) this.settled.splice(0, this.settled.length - this.o.windowEvents * 2);
    this.dirty = true;
    return done;
  }

  /** Recompute the earned alpha (cheap; cached until the next settlement). */
  alpha(): Earned {
    if (!this.dirty) return this.earned;
    this.dirty = false;
    const s = this.settled.slice(-this.o.windowEvents);
    const events = new Set(s.map((r) => r.eventKey)).size;
    if (events < this.o.minEvents) return (this.earned = { alpha: 0, alphaStar: 0, ciHi: null, meanDiff: null, events, reason: `${events}/${this.o.minEvents} settled events` });
    let best = 0, bestB = Infinity;
    for (let k = 0; k * 0.025 <= this.o.alphaMax + 1e-9; k++) {
      const a = k * 0.025;
      const b = s.reduce((acc, r) => acc + brier(blend(r.pModel, r.pSnn, a, r.c, this.o.alphaMax), r.y!), 0);
      if (b < bestB - 1e-12) { bestB = b; best = a; }
    }
    if (best === 0) return (this.earned = { alpha: 0, alphaStar: 0, ciHi: null, meanDiff: 0, events, reason: 'blending does not improve Brier' });
    const ci = pairedEventCi(s, (r) => brier(blend(r.pModel, r.pSnn, best, r.c, this.o.alphaMax), r.y!) - brier(r.pModel, r.y!), this.o.bootstrapIters);
    const ok = ci.hi < 0;
    return (this.earned = { alpha: ok ? Math.min(this.o.alphaMax, best) : 0, alphaStar: best, ciHi: ci.hi, meanDiff: ci.mean, events, reason: ok ? 'earned: blended Brier CI below model' : 'improvement not significant (CI crosses 0)' });
  }

  /** The blended probability actually traded. alpha = 0 whenever the SNN is in shadow or timed out. */
  pFinal(pModel: number, pSnn: number | undefined, c: number, shadow: boolean): number {
    if (pSnn === undefined || shadow || !Number.isFinite(pSnn)) return pModel;
    return blend(pModel, pSnn, this.alpha().alpha, c, this.o.alphaMax);
  }

  status() {
    const s = this.settled.slice(-this.o.windowEvents);
    const mean = (f: (r: BlendRecord) => number) => (s.length ? s.reduce((a, r) => a + f(r), 0) / s.length : null);
    return {
      earned: this.alpha(), pending: this.pending.size, settled: s.length, cCal: +this.calibrationConfidence().toFixed(3),
      brierModel: mean((r) => brier(r.pModel, r.y!)), brierSnn: mean((r) => brier(r.pSnn, r.y!)),
    };
  }

  /** Meta-model the stored (p_model, p_snn) pairs were recorded against. */
  modelId?: string;

  /** Tie the history to a meta-model: a different model invalidates every stored pair (they hold
   *  the old model's p_model), so alpha must be re-earned from scratch. Returns true if it reset. */
  bindModel(id: string): boolean {
    if (this.modelId === id) return false;
    const had = this.modelId !== undefined && (this.settled.length > 0 || this.pending.size > 0);
    this.modelId = id;
    this.reset();
    return had;
  }

  reset(): void {
    this.settled.length = 0;
    this.pending.clear();
    this.lastRecord.clear();
    this.earned = { alpha: 0, alphaStar: 0, ciHi: null, meanDiff: null, events: 0, reason: 'no settled events yet' };
    this.dirty = true;
  }

  state() { return { modelId: this.modelId ?? null, settled: this.settled, pending: [...this.pending] }; }
  restore(st: { modelId?: string | null; settled: BlendRecord[]; pending: [string, BlendRecord][] }): void {
    this.settled.splice(0, this.settled.length, ...st.settled);
    this.pending.clear(); for (const [k, v] of st.pending) this.pending.set(k, v);
    this.modelId = st.modelId ?? undefined;
    this.dirty = true;
  }

  /** Persist to disk (atomic). */
  save(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state()));
    fs.renameSync(tmp, file);
  }

  /** Load saved history, discarding it if it was recorded against a different meta-model. */
  load(file: string, modelId: string): 'loaded' | 'reset' | 'none' {
    let st: ReturnType<SnnBlender['state']> | undefined;
    try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { st = undefined; }
    if (!st) { this.modelId = modelId; return 'none'; }
    if (st.modelId !== modelId) { this.modelId = modelId; this.reset(); return 'reset'; }
    this.restore(st);
    return 'loaded';
  }
}

/** Event-clustered, day-block bootstrap CI of the mean per-event difference. Strikes of one event
 *  are averaged into one observation; days are resampled as blocks. */
export function pairedEventCi(rows: { eventKey: string; ts: number }[] | BlendRecord[], diff: (r: BlendRecord) => number, iters = 1000, seed = 7): { mean: number; lo: number; hi: number; events: number; days: number } {
  const ev = new Map<string, { s: number; n: number; day: string }>();
  for (const r of rows as BlendRecord[]) {
    const e = ev.get(r.eventKey) ?? { s: 0, n: 0, day: new Date(r.ts).toISOString().slice(0, 10) };
    e.s += diff(r); e.n++;
    ev.set(r.eventKey, e);
  }
  return dayBlockBootstrap([...ev.values()].map((e) => ({ day: e.day, x: e.s / e.n })), iters, seed);
}

/** Day-block bootstrap of the mean over (day, value) observations. */
export function dayBlockBootstrap(obs: { day: string; x: number }[], iters = 1000, seed = 7): { mean: number; lo: number; hi: number; events: number; days: number } {
  const byDay = new Map<string, number[]>();
  for (const o of obs) byDay.set(o.day, [...(byDay.get(o.day) ?? []), o.x]);
  const days = [...byDay.keys()].sort().map((d) => byDay.get(d)!);
  const all = obs.map((o) => o.x);
  const mean = all.length ? all.reduce((a, b) => a + b, 0) / all.length : NaN;
  if (days.length < 2) return { mean, lo: NaN, hi: NaN, events: obs.length, days: days.length };
  const rng = new Xoshiro128(seed);
  const means: number[] = [];
  for (let b = 0; b < iters; b++) {
    let s = 0, n = 0;
    for (let k = 0; k < days.length; k++) { const d = days[rng.int(days.length)]; for (const x of d) { s += x; n++; } }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { mean, lo: means[Math.floor(0.025 * iters)], hi: means[Math.ceil(0.975 * iters) - 1], events: obs.length, days: days.length };
}

/** Dynamic target scaling, conservative only: a scale in [1 - clamp, 1] (never above 1), moved at
 *  most one step per 15 minutes, driven by surprise and the governor state. */
export class TargetScaler {
  scale = 1;
  private lastStep = 0;

  constructor(private readonly o: { clamp: number; stepSize: number; minIntervalSec: number } = { clamp: 0.15, stepSize: 0.05, minIntervalSec: 900 }) {}

  /** Desired scale: 1 when calm; shrinks with surprise ratio S_t/S0 above 1 and with G. */
  target(surprise: number, surprise0: number, G: number): number {
    const ratio = surprise0 > 0 ? surprise / surprise0 : 1;
    const shrink = Math.max(0, Math.min(1, (ratio - 1) / 2)) * 0.5 + 0.5 * sat01(G);
    return 1 - this.o.clamp * Math.min(1, shrink);
  }

  update(now: number, surprise: number, surprise0: number, G: number): number {
    const want = this.target(surprise, surprise0, G);
    if (Math.abs(want - this.scale) < 1e-9 || now - this.lastStep < this.o.minIntervalSec * 1000) return this.scale;
    const step = Math.sign(want - this.scale) * Math.min(this.o.stepSize, Math.abs(want - this.scale));
    this.scale = Math.min(1, Math.max(1 - this.o.clamp, this.scale + step));
    this.lastStep = now;
    return this.scale;
  }
}

/** Implied settlement-price quantile from a ladder of P(index > K): the K where the exceedance
 *  crosses 1 - q (linear interpolation). Used for SNN price targets, blended with the model's and
 *  clamped to +/-clamp of the model's target. */
export function impliedQuantile(ladder: { K: number; pExceed: number }[], q: number): number | undefined {
  const pts = [...ladder].sort((a, b) => a.K - b.K);
  if (pts.length < 2) return undefined;
  const want = 1 - q;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if ((a.pExceed - want) * (b.pExceed - want) <= 0 && a.pExceed !== b.pExceed) return a.K + ((a.pExceed - want) / (a.pExceed - b.pExceed)) * (b.K - a.K);
  }
  return undefined;
}

export function blendedTarget(model: number, snn: number | undefined, alpha: number, clamp = 0.15): number {
  if (snn === undefined || !Number.isFinite(snn)) return model;
  const t = (1 - alpha) * model + alpha * snn;
  return Math.min(model * (1 + clamp), Math.max(model * (1 - clamp), t));
}

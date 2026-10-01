// L5 readout: logistic regression on spiking features, one per column (contract type), trained
// ONLY by the settlement label through exact per-contract tags (the engineering stand-in for
// synaptic tagging and capture; biological eligibility traces last ~1-10 s, settlement is
// 15-60 min away). When contract k is scored, phi_k(t) and p_k(t) are stored in a ring buffer
// keyed by contract ID; when k settles with outcome y_k, dw = eta (y_k - p_k) phi_k (capped).
// Weights are two-speed: w_f (used forward, takes the updates) relaxes toward w_s, which follows
// slowly. The S0 baseline variant uses one decaying trace instead of tags (smeared credit).

import { readoutDelta, sigmoid, twoSpeedStep } from './formulas';

export type ThresholdRole = 'strike' | 'cap';

export interface Tag { phi: Float32Array; p: number; ts: number; role: ThresholdRole }

export interface ContractLabel { kind: string; result: 'yes' | 'no' }

/** Exceedance label for one threshold of a settled contract, or undefined when not identified
 *  (a 'between' contract that settled NO could have finished below the floor or above the cap). */
export function exceedLabel(kind: string, role: ThresholdRole, result: 'yes' | 'no'): 0 | 1 | undefined {
  const yes = result === 'yes';
  if (kind === 'match') return yes ? 1 : 0; // tennis: P(our player wins)
  if (kind === 'less') return yes ? 0 : 1; // pays iff A < cap  => exceed(cap) = !yes
  if (kind === 'between') {
    if (!yes) return undefined;
    return role === 'strike' ? 1 : 0;
  }
  return yes ? 1 : 0; // updown / greater: exceed(strike)
}

export interface ReadoutOpts { eta: number; cap: number; tauC: number; eps: number; tagsPerContract: number; maxTagged: number; traceTauSec: number; useTags: boolean }

export class Readout {
  readonly wf: Float64Array;
  readonly ws: Float64Array;
  /** S0 baseline: one exponentially decaying trace of scored feature vectors. */
  readonly trace: Float64Array;
  traceTs = 0;
  readonly tags = new Map<string, { kind: string; tags: Tag[] }>();
  /** Recent settled (p, y) pairs for the calibration slope and the rolling Brier. */
  readonly history: { p: number; y: number; ts: number }[] = [];
  brierFast = NaN;
  brierSlow = NaN;
  updates = 0;

  constructor(readonly n: number, private readonly o: ReadoutOpts, prior?: ArrayLike<number>) {
    this.wf = new Float64Array(n);
    this.ws = new Float64Array(n);
    this.trace = new Float64Array(n);
    if (prior) { this.wf.set(prior); this.ws.set(prior); }
  }

  logit(phi: ArrayLike<number>): number {
    let z = 0;
    for (let i = 0; i < this.n; i++) z += this.wf[i] * phi[i];
    return z;
  }

  predict(phi: ArrayLike<number>): number {
    return sigmoid(this.logit(phi));
  }

  /** Store a tag (or feed the decaying trace in the S0 variant). */
  tag(ticker: string, kind: string, role: ThresholdRole, phi: ArrayLike<number>, p: number, ts: number): void {
    if (!this.o.useTags) {
      const k = this.traceTs ? Math.exp(-(ts - this.traceTs) / 1000 / this.o.traceTauSec) : 0;
      for (let i = 0; i < this.n; i++) this.trace[i] = this.trace[i] * k + phi[i];
      this.traceTs = ts;
    }
    let e = this.tags.get(ticker);
    if (!e) {
      if (this.tags.size >= this.o.maxTagged) this.tags.delete(this.tags.keys().next().value!); // ring: evict oldest contract
      e = { kind, tags: [] };
      this.tags.set(ticker, e);
    }
    e.tags.push({ phi: Float32Array.from(phi), p, ts, role });
    if (e.tags.length > this.o.tagsPerContract * 2) e.tags.shift();
  }

  /** Apply the settlement label. `etaScale` is the governor's (1 - delta G). Returns the tags used. */
  settle(ticker: string, result: 'yes' | 'no', ts: number, etaScale = 1, learn = true): number {
    const e = this.tags.get(ticker);
    if (!e) return 0;
    this.tags.delete(ticker);
    const usable = e.tags.filter((t) => exceedLabel(e.kind, t.role, result) !== undefined);
    if (!usable.length) return 0;
    const eta = (this.o.eta * etaScale) / usable.length; // one contract = one unit of credit
    const dw = new Float64Array(this.n);
    for (const t of usable) {
      const y = exceedLabel(e.kind, t.role, result)!;
      this.record(t.p, y, ts);
      if (!learn) continue;
      if (this.o.useTags) readoutDelta(t.phi, y, t.p, eta, this.o.cap, dw);
      else {
        // Decaying-trace credit: the same delta rule, but applied to whatever the trace holds now.
        const k = Math.exp(-(ts - this.traceTs) / 1000 / this.o.traceTauSec);
        const tr = Float64Array.from(this.trace, (v) => v * k);
        readoutDelta(tr, y, t.p, eta, this.o.cap, dw);
      }
      for (let i = 0; i < this.n; i++) this.wf[i] += dw[i];
      this.updates++;
    }
    return usable.length;
  }

  private record(p: number, y: number, ts: number): void {
    this.history.push({ p, y, ts });
    if (this.history.length > 2000) this.history.shift();
    const b = (p - y) ** 2;
    this.brierFast = Number.isFinite(this.brierFast) ? this.brierFast + 0.05 * (b - this.brierFast) : b;
    this.brierSlow = Number.isFinite(this.brierSlow) ? this.brierSlow + 0.005 * (b - this.brierSlow) : b;
  }

  /** Rolling Brier deterioration dB = max(0, fast/slow - 1) for the governor. */
  brierDeterioration(): number {
    if (!(this.history.length >= 50) || !(this.brierSlow > 0)) return 0;
    return Math.max(0, this.brierFast / this.brierSlow - 1);
  }

  /** Two-speed relaxation over dt seconds (exact). */
  relax(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      const s = twoSpeedStep(this.wf[i], this.ws[i], this.o.tauC, this.o.eps, dt);
      this.wf[i] = s.wf; this.ws[i] = s.ws;
    }
  }

  /** |w_f - w_s| / |w_s| (health: < 0.1). */
  divergence(): number {
    let d = 0, s = 0;
    for (let i = 0; i < this.n; i++) { d += (this.wf[i] - this.ws[i]) ** 2; s += this.ws[i] ** 2; }
    return s > 0 ? Math.sqrt(d / s) : 0;
  }
}

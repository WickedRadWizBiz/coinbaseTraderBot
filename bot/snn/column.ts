// One cortical column (one whitelisted market: asset x horizon). Struct-of-arrays state in
// pre-allocated typed arrays, exact exponential updates with precomputed decay factors, CSR
// synapses with event-driven propagation, Float64 for slow accumulators. Update order within a
// 1 s step (PDF handoff, problem 2): inputs -> synaptic currents -> dendrites -> soma -> spikes ->
// traces -> plasticity -> governor -> PC -> readout features.
//
//   L0  encoders + LIF (tau 2 s): 64 channels = spot send-on-delta at 3/6/12 bp (+/-), Kalshi mid
//       +/-1c, 8-band population codes of 7 features (strike distance in sigma units, time to
//       expiry, Kalshi mid, spread, book imbalance, RSI, 5-min return z).
//  L1  48 Poirazi neurons: 6 branches x 16 synapses, sigmoid branches low-passed with
//       tau_branch in {5, 30, 120} s, LIF soma; current-based AMPA-like (5 s) + NMDA-like (90 s)
//       classes, the NMDA class gated by the Jahr-Stevens Mg block of the postsynaptic soma.
//  L2/3 128 ALIF E (tau_m 10 s, tau_a 300 s) + 32 LIF I (tau_m 3 s), 10% recurrent; cross-column
//       I -> E lateral inhibition (network level); 64 error units carrying the signed L0 error.
//  PC   U1: L2/3 -> L1 (48 x 128), U0: L1 -> L0 (64 x 48), Rao-Ballard with precision 1/sigma^2.
//  Gov  astrocyte-like G in [0, 1]: eta_eff = eta (1 - delta G), column gain x (1 - delta' G).

import {
  a2MinusSlide, alifThreshold, columnGain, dcaap, decay, deltaEncode, dexpNorm, etaEff, ewma, fastSigmoidSurrogate, gatedUpdate,
  governorStep, IZH, izhikevichStep, nmdaGate, pcPredict, pcScratch, pcUpdate, populationCode, sigmoid, SYN_CLASSES, toMvEquivalent,
  twoSpeedStep, type PcParams, type PcScratch,
} from './formulas';
import { columnHorizonSec, columnKind, CRYPTO_DELTA_BPS, l0Width, popSpec, TENNIS_DELTA_CENTS, type ColumnKind, type PopSpec } from './inputs';
import type { SnnParams } from './params';
import { Xoshiro128 } from './rng';

export interface ColumnInput {
  key: string;
  asset: string;
  /** Primary price for the send-on-delta channels (crypto: settlement index; tennis: P(A wins)).
   *  It is also the price the column's direction head predicts. `spot` is the legacy alias. */
  price?: number;
  spot?: number;
  /** Secondary delta channel (crypto: ATM Kalshi mid). */
  mid?: number;
  /** Population-coded values by name (bot/snn/inputs.ts: CRYPTO_POP / TENNIS_POP). */
  values?: Record<string, number | undefined>;
  // Legacy contract fields (folded into `values` when `values` is absent).
  spread?: number;
  imbalance?: number;
  dAtm?: number;
  tauFrac?: number;
}

export const N_POOL = 16;
export const N_BASE = 6;
export const N_EXTRA = 3;

export type TypedArr = Float32Array | Float64Array | Int32Array | Uint8Array;

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export class Column {
  readonly N: number;
  readonly kind: ColumnKind;
  readonly nL0: number;
  /** Seconds ahead the direction head predicts (15m/60m/240m crypto, 5 min tennis). */
  readonly horizonSec: number;
  private readonly pop: PopSpec[];
  private readonly deltaThr: number[];
  readonly nSyn: number;
  readonly nFeat: number;
  // ---- L0
  readonly I0: Float64Array; readonly v0: Float64Array; readonly s0: Uint8Array; readonly rate0: Float64Array;
  readonly deltaAcc: Float64Array; midAcc = 0; lastSpot = 0; lastMid = NaN;
  readonly aR0: Float64Array; readonly aD0: Float64Array; readonly nR0: Float64Array; readonly nD0: Float64Array;
  readonly gA0: Float64Array; readonly gN0: Float64Array;
  // ---- L1 (synapse index = (n * B + j) * K + k)
  readonly src: Int32Array; readonly w1: Float32Array; readonly w1s: Float32Array;
  readonly theta1: Float64Array; readonly alpha1: Float64Array; readonly u1: Float64Array; readonly b1: Float64Array; readonly bbar: Float64Array;
  readonly v1: Float64Array; readonly s1: Uint8Array; readonly rate1: Float64Array; readonly gate1: Float64Array;
  readonly preR1: Float64Array; readonly postO1: Float64Array; readonly postO2: Float64Array; readonly rho1: Float64Array;
  readonly revPtr: Int32Array; readonly revSyn: Int32Array;
  /** Offline training only: e-prop style eligibility of every L1 synapse (truncated surrogate gradient). */
  elig?: Float32Array;
  // ---- L2/3 (E: 0..nE-1, I: nE..N-1)
  readonly v2: Float64Array; readonly a2: Float64Array; readonly s2: Uint8Array; readonly rate2: Float64Array;
  readonly aR2: Float64Array; readonly aD2: Float64Array; readonly nR2: Float64Array; readonly nD2: Float64Array; readonly gR2: Float64Array; readonly gD2: Float64Array;
  readonly ffPtr: Int32Array; readonly ffCol: Int32Array; readonly ffW: Float32Array;
  readonly recPtr: Int32Array; readonly recCol: Int32Array; readonly recW: Float32Array; readonly recWs: Float32Array;
  readonly inPtr: Int32Array; readonly inEdge: Int32Array; readonly inPre: Int32Array;
  readonly preRE: Float64Array; readonly postO1E: Float64Array; readonly postO2E: Float64Array; readonly rhoE: Float64Array;
  readonly theta0E: Float64Array;
  // ---- PC
  readonly U1: Float32Array; readonly U0: Float32Array; readonly z2: Float64Array; readonly z1: Float64Array;
  readonly xhat1: Float64Array; readonly err0: Float64Array;
  sigma2_1: number; sigma2_0: number;
  surprise = 0; surpriseInst = 0; errMean = 0; errVar = 0; errN = 0; errZ = 0; zHighRun = 0; pcFrozen = false; pcNormalRun = 0;
  // ---- governor and health accumulators
  G = 0;
  rateL0 = 0; rateL1 = 0; rateE = 0; rateI = 0; exc = 0; inh = 0; fSat = 0;
  private ipCount = 0;
  // ---- deferred: Izhikevich CH burst detectors
  readonly chV: Float64Array; readonly chU: Float64Array; chBurst = 0;
  // ---- cheap proxies of the deferred mechanisms
  deltaFast = 0; deltaSlow = 0; lastRetBp = 0;
  // scratch
  private readonly sc1: PcScratch; private readonly sc0: PcScratch;
  private readonly prevSpikes: Int32Array; private nPrev = 0;
  private readonly p: SnnParams;
  private readonly dec: Record<string, number>;
  private readonly Ka: number; private readonly Kn: number; private readonly Kg: number;
  private readonly decBranch: Float64Array;
  private stepsSinceSlow = 0;

  constructor(readonly key: string, readonly asset: string, p: SnnParams, readonly index: number) {
    this.p = p;
    this.kind = columnKind(key);
    this.pop = popSpec(this.kind);
    this.nL0 = l0Width(this.kind);
    this.horizonSec = columnHorizonSec(key);
    this.deltaThr = this.kind === 'tennis' ? TENNIS_DELTA_CENTS : CRYPTO_DELTA_BPS;
    const nL0 = this.nL0;
    const { nL1, branches: B, synPerBranch: K, nE, nI } = p;
    this.N = nE + nI;
    this.nSyn = nL1 * B * K;
    this.nFeat = N_BASE + Math.max(nE + nL1 + N_POOL + N_EXTRA, nL0);
    const rng = new Xoshiro128((p.seed ^ fnv1a(key)) >>> 0);
    const f64 = (n: number) => new Float64Array(n);
    this.I0 = f64(nL0); this.v0 = f64(nL0); this.s0 = new Uint8Array(nL0); this.rate0 = f64(nL0);
    this.deltaAcc = f64(this.deltaThr.length);
    this.aR0 = f64(nL0); this.aD0 = f64(nL0); this.nR0 = f64(nL0); this.nD0 = f64(nL0); this.gA0 = f64(nL0); this.gN0 = f64(nL0);
    // L1 connectivity: each branch samples 16 distinct L0 channels.
    this.src = new Int32Array(this.nSyn); this.w1 = new Float32Array(this.nSyn); this.w1s = new Float32Array(this.nSyn);
    for (let nb = 0; nb < nL1 * B; nb++) {
      const pool = Array.from({ length: nL0 }, (_, i) => i);
      for (let k = 0; k < K; k++) {
        const pick = k + rng.int(nL0 - k);
        [pool[k], pool[pick]] = [pool[pick], pool[k]];
        this.src[nb * K + k] = pool[k];
        this.w1[nb * K + k] = rng.normal() * p.wInitL1;
      }
    }
    this.w1s.set(this.w1);
    this.theta1 = f64(nL1 * B).fill(p.branchTheta); this.alpha1 = f64(nL1 * B).fill(1 / B);
    this.u1 = f64(nL1 * B); this.b1 = f64(nL1 * B); this.bbar = f64(nL1 * B);
    this.v1 = f64(nL1); this.s1 = new Uint8Array(nL1); this.rate1 = f64(nL1); this.gate1 = f64(nL1);
    this.preR1 = f64(nL0); this.postO1 = f64(nL1); this.postO2 = f64(nL1); this.rho1 = f64(nL1).fill(p.triplet.rho0);
    // Reverse index L0 channel -> synapses (for depression on pre spikes).
    const cnt = new Int32Array(nL0 + 1);
    for (let s = 0; s < this.nSyn; s++) cnt[this.src[s] + 1]++;
    for (let i = 0; i < nL0; i++) cnt[i + 1] += cnt[i];
    this.revPtr = cnt.slice();
    this.revSyn = new Int32Array(this.nSyn);
    const fill = cnt.slice();
    for (let s = 0; s < this.nSyn; s++) this.revSyn[fill[this.src[s]]++] = s;
    // L2/3.
    const N = this.N;
    this.v2 = f64(N); this.a2 = f64(nE); this.s2 = new Uint8Array(N); this.rate2 = f64(N);
    this.aR2 = f64(N); this.aD2 = f64(N); this.nR2 = f64(N); this.nD2 = f64(N); this.gR2 = f64(N); this.gD2 = f64(N);
    // Feedforward L1 -> L2/3 (CSR by presynaptic L1 neuron).
    const ff: number[][] = [];
    for (let i = 0; i < nL1; i++) { const row: number[] = []; for (let j = 0; j < N; j++) if (rng.next() < p.pFF) row.push(j); ff.push(row); }
    this.ffPtr = new Int32Array(nL1 + 1);
    for (let i = 0; i < nL1; i++) this.ffPtr[i + 1] = this.ffPtr[i] + ff[i].length;
    this.ffCol = new Int32Array(this.ffPtr[nL1]); this.ffW = new Float32Array(this.ffPtr[nL1]);
    for (let i = 0, e = 0; i < nL1; i++) for (const j of ff[i]) { this.ffCol[e] = j; this.ffW[e++] = rng.next() * p.wFF; }
    // Recurrent within column, 10% (CSR by presynaptic neuron); E -> +, I -> -.
    const rec: number[][] = [];
    for (let i = 0; i < N; i++) { const row: number[] = []; for (let j = 0; j < N; j++) if (j !== i && rng.next() < p.pRec) row.push(j); rec.push(row); }
    this.recPtr = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) this.recPtr[i + 1] = this.recPtr[i] + rec[i].length;
    this.recCol = new Int32Array(this.recPtr[N]); this.recW = new Float32Array(this.recPtr[N]);
    for (let i = 0, e = 0; i < N; i++) for (const j of rec[i]) {
      this.recCol[e] = j;
      const u = rng.next();
      this.recW[e++] = i < nE ? (j < nE ? u * p.wEE : u * p.wEI) : -(j < nE ? u * p.wIE : u * p.wII);
    }
    this.recWs = this.recW.slice();
    // In-edges of E->E synapses per E post neuron (potentiation on post spikes).
    const inc: number[][] = Array.from({ length: nE }, () => []);
    const incPre: number[][] = Array.from({ length: nE }, () => []);
    for (let i = 0; i < nE; i++) for (let e = this.recPtr[i]; e < this.recPtr[i + 1]; e++) if (this.recCol[e] < nE) { inc[this.recCol[e]].push(e); incPre[this.recCol[e]].push(i); }
    this.inPtr = new Int32Array(nE + 1);
    for (let j = 0; j < nE; j++) this.inPtr[j + 1] = this.inPtr[j] + inc[j].length;
    this.inEdge = Int32Array.from(inc.flat()); this.inPre = Int32Array.from(incPre.flat());
    this.preRE = f64(nE); this.postO1E = f64(nE); this.postO2E = f64(nE); this.rhoE = f64(nE).fill(p.triplet.rho0);
    this.theta0E = f64(nE).fill(p.thetaE);
    // PC matrices (small random init) and latents.
    this.U1 = Float32Array.from({ length: nL1 * nE }, () => rng.normal() * 0.05);
    this.U0 = Float32Array.from({ length: nL0 * nL1 }, () => rng.normal() * 0.05);
    this.z2 = f64(nE); this.z1 = f64(nL1); this.xhat1 = f64(nL1); this.err0 = f64(nL0);
    this.sigma2_1 = p.pcSigma2; this.sigma2_0 = p.pcSigma2;
    this.chV = f64(8).fill(-65); this.chU = f64(8).fill(IZH.CH.b * -65);
    this.sc1 = pcScratch(nL1, nE); this.sc0 = pcScratch(nL0, nL1);
    this.prevSpikes = new Int32Array(N);
    const single = !p.flags.synClasses;
    this.dec = {
      L0: decay(1, p.tauL0), L1: decay(1, p.tauL1), E: decay(1, p.tauE), I: decay(1, p.tauI), A: decay(1, p.tauA),
      aR: decay(1, SYN_CLASSES.ampa.tauR), aD: decay(1, SYN_CLASSES.ampa.tauD), nR: decay(1, SYN_CLASSES.nmda.tauR), nD: decay(1, SYN_CLASSES.nmda.tauD),
      gR: decay(1, SYN_CLASSES.gaba.tauR), gD: decay(1, single ? SYN_CLASSES.ampa.tauD : SYN_CLASSES.gaba.tauD),
      tp: decay(1, p.triplet.tauPlus), tm: decay(1, p.triplet.tauMinus), ty: decay(1, p.triplet.tauY),
    };
    this.Ka = single ? 1 : dexpNorm(SYN_CLASSES.ampa.tauR, SYN_CLASSES.ampa.tauD);
    this.Kn = dexpNorm(SYN_CLASSES.nmda.tauR, SYN_CLASSES.nmda.tauD);
    this.Kg = single ? 1 : dexpNorm(SYN_CLASSES.gaba.tauR, SYN_CLASSES.gaba.tauD);
    this.decBranch = Float64Array.from({ length: B }, (_, j) => decay(1, p.branchTaus[j % p.branchTaus.length]));
  }

  /** All persistent typed-array state (checkpointing). */
  arrays(): Record<string, TypedArr> {
    const a: Record<string, TypedArr> = {
      v0: this.v0, s0: this.s0, rate0: this.rate0, deltaAcc: this.deltaAcc, aR0: this.aR0, aD0: this.aD0, nR0: this.nR0, nD0: this.nD0,
      src: this.src, w1: this.w1, w1s: this.w1s, theta1: this.theta1, alpha1: this.alpha1, bbar: this.bbar, v1: this.v1, s1: this.s1, rate1: this.rate1,
      preR1: this.preR1, postO1: this.postO1, postO2: this.postO2, rho1: this.rho1,
      v2: this.v2, a2: this.a2, s2: this.s2, rate2: this.rate2, aR2: this.aR2, aD2: this.aD2, nR2: this.nR2, nD2: this.nD2, gR2: this.gR2, gD2: this.gD2,
      ffW: this.ffW, recW: this.recW, recWs: this.recWs, preRE: this.preRE, postO1E: this.postO1E, postO2E: this.postO2E, rhoE: this.rhoE,
      U1: this.U1, U0: this.U0, z2: this.z2, z1: this.z1, xhat1: this.xhat1, err0: this.err0, chV: this.chV, chU: this.chU,
      prevSpikes: this.prevSpikes,
      // Per-neuron E thresholds (moved only by threshold homeostasis; old checkpoints restore the default).
      theta0E: this.theta0E,
    };
    return a;
  }

  private static readonly SCALARS = ['midAcc', 'lastSpot', 'lastMid', 'sigma2_1', 'sigma2_0', 'surprise', 'surpriseInst', 'errMean', 'errVar', 'errN', 'errZ', 'zHighRun', 'pcFrozen', 'pcNormalRun', 'G', 'rateL0', 'rateL1', 'rateE', 'rateI', 'exc', 'inh', 'fSat', 'chBurst', 'nPrev', 'stepsSinceSlow', 'deltaFast', 'deltaSlow', 'lastRetBp'] as const;

  scalars(): Record<string, number | boolean> {
    const o: Record<string, number | boolean> = {};
    for (const k of Column.SCALARS) o[k] = (this as unknown as Record<string, number | boolean>)[k];
    return o;
  }

  setScalars(o: Record<string, number | boolean>): void {
    for (const k of Column.SCALARS) if (k in o) (this as unknown as Record<string, number | boolean | null>)[k] = o[k] === null ? NaN : o[k];
  }

  /** Reset transient state (voltages, traces, encoders) after a long gap; weights are kept. */
  resetTransient(): void {
    for (const a of [this.v0, this.s0, this.rate0, this.deltaAcc, this.aR0, this.aD0, this.nR0, this.nD0, this.bbar, this.v1, this.s1, this.preR1, this.postO1, this.postO2,
      this.v2, this.a2, this.s2, this.aR2, this.aD2, this.nR2, this.nD2, this.gR2, this.gD2, this.preRE, this.postO1E, this.postO2E, this.z2, this.z1, this.xhat1, this.err0]) a.fill(0);
    this.midAcc = 0; this.lastSpot = 0; this.lastMid = NaN; this.nPrev = 0;
  }

  /** One 1 s step. `first` applies the price deltas (inputs are piecewise-constant across catch-up
   *  steps); `latInh` is the cross-column lateral inhibition; `gapV` the partner column's I voltages. */
  step(inp: ColumnInput, first: boolean, ctx: { latInh: number; gapV?: Float64Array; dBrier: number; refRateE?: number; frozen: boolean; training?: boolean }): void {
    const p = this.p, F = p.flags, d = this.dec;
    const nL0 = this.nL0;
    const { nL1, branches: B, synPerBranch: K, nE } = p;
    const N = this.N;
    // ---- 1. inputs -> L0 encoder currents
    const I0 = this.I0;
    I0.fill(0);
    this.lastRetBp = 0;
    const price = inp.price ?? inp.spot;
    if (first) {
      if (price && price > 0 && this.lastSpot > 0) {
        // Crypto: log return in bp; tennis: probability change in absolute units (cents as fractions).
        const dx = this.kind === 'tennis' ? price - this.lastSpot : 1e4 * Math.log(price / this.lastSpot);
        this.lastRetBp = this.kind === 'tennis' ? 1e4 * dx : dx;
        for (let k = 0; k < this.deltaThr.length; k++) {
          const e = deltaEncode(this.deltaAcc[k], dx, this.deltaThr[k]);
          this.deltaAcc[k] = e.acc; I0[2 * k] = p.deltaGain * e.up; I0[2 * k + 1] = p.deltaGain * e.down;
        }
      }
      if (price && price > 0) this.lastSpot = price;
      if (this.kind === 'crypto' && inp.mid !== undefined && Number.isFinite(inp.mid)) {
        if (Number.isFinite(this.lastMid)) {
          const e = deltaEncode(this.midAcc, inp.mid - this.lastMid, p.midDelta);
          this.midAcc = e.acc; I0[6] = p.deltaGain * e.up; I0[7] = p.deltaGain * e.down;
        }
        this.lastMid = inp.mid;
      }
    }
    const vals = inp.values ?? { dAtm: inp.dAtm, tauFrac: inp.tauFrac, mid: inp.mid, spread: inp.spread, imbalance: inp.imbalance };
    for (let f = 0; f < this.pop.length; f++) {
      const pf = this.pop[f];
      populationCode(vals[pf.name] ?? NaN, pf.lo, pf.hi, 8, I0, 8 + f * 8);
    }
    for (let i = 8; i < nL0; i++) I0[i] *= p.popGain;
    let deltas = 0;
    for (let k = 0; k < 2 * this.deltaThr.length; k++) deltas += I0[k] / p.deltaGain;
    this.deltaFast = ewma(this.deltaFast, deltas, 60);
    this.deltaSlow = ewma(this.deltaSlow, deltas, 3600);
    // ---- 2. L0 LIF (exact), spikes, rates
    let spk0 = 0;
    for (let i = 0; i < nL0; i++) {
      let v = I0[i] + (this.v0[i] - I0[i]) * d.L0;
      const s = v >= p.thetaL0 ? 1 : 0;
      if (s) { v = 0; spk0++; }
      this.v0[i] = v; this.s0[i] = s;
      this.rate0[i] = ewma(this.rate0[i], s, p.tauRateL0);
    }
    // ---- 3. synaptic currents from L0 (current-based, shared tau per class)
    for (let i = 0; i < nL0; i++) {
      const s = this.s0[i];
      this.aD0[i] = this.aD0[i] * d.aD + s;
      if (F.synClasses) {
        this.aR0[i] = this.aR0[i] * d.aR + s;
        this.nR0[i] = this.nR0[i] * d.nR + s; this.nD0[i] = this.nD0[i] * d.nD + s;
        this.gA0[i] = this.Ka * (this.aD0[i] - this.aR0[i]);
        this.gN0[i] = this.Kn * (this.nD0[i] - this.nR0[i]);
      } else {
        this.gA0[i] = this.aD0[i];
        this.gN0[i] = 0;
      }
    }
    // ---- 4. L1 dendrites and soma
    let spk1 = 0;
    const elig = ctx.training ? this.elig : undefined;
    const decElig = elig ? decay(1, p.tauRateL1) : 0;
    for (let n = 0; n < nL1; n++) {
      const gate = F.synClasses ? nmdaGate(toMvEquivalent(this.v1[n], 0, p.thetaL1), p.mg) : 0;
      this.gate1[n] = gate;
      let I = 0;
      for (let j = 0; j < B; j++) {
        const nb = n * B + j, base = nb * K;
        let A = 0, Nn = 0;
        for (let k = 0; k < K; k++) { const s = base + k, w = this.w1[s], i = this.src[s]; A += w * this.gA0[i]; Nn += w * this.gN0[i]; }
        const u = A + p.nmdaWeight * gate * Nn - this.theta1[nb];
        this.u1[nb] = u;
        if (F.dendrites) {
          const b = F.dcaap && (j & 1) ? dcaap(u + this.theta1[nb], this.theta1[nb], 1) : sigmoid(u);
          this.b1[nb] = b;
          this.bbar[nb] = b + (this.bbar[nb] - b) * this.decBranch[j];
        } else {
          // Point neuron with the same synapses: linear sum, no branch nonlinearity or filter.
          this.b1[nb] = u + this.theta1[nb];
          this.bbar[nb] = this.b1[nb];
        }
        I += this.alpha1[nb] * this.bbar[nb];
      }
      I = p.l1Gain * I + (F.pc ? p.feedbackGain * this.xhat1[n] : 0);
      let v = I + (this.v1[n] - I) * d.L1;
      if (elig) {
        // e-prop style truncated surrogate gradient: psi = fast-sigmoid(V - theta) at the soma.
        const psi = fastSigmoidSurrogate((v - p.thetaL1) / p.thetaL1);
        for (let j = 0; j < B; j++) {
          const nb = n * B + j, base = nb * K;
          const bd = F.dendrites ? this.b1[nb] * (1 - this.b1[nb]) : 1;
          const g = psi * p.l1Gain * this.alpha1[nb] * bd;
          for (let k = 0; k < K; k++) { const s = base + k, i = this.src[s]; elig[s] = elig[s] * decElig + g * (this.gA0[i] + p.nmdaWeight * gate * this.gN0[i]); }
        }
      }
      const s = v >= p.thetaL1 ? 1 : 0;
      if (s) { v = 0; spk1++; }
      this.v1[n] = v; this.s1[n] = s;
      this.rate1[n] = ewma(this.rate1[n], s, p.tauRateL1);
    }
    // ---- 5. L2/3: decay traces, event-driven propagation, ALIF/LIF somas
    for (let k = 0; k < N; k++) {
      this.aD2[k] *= d.aD; this.gD2[k] *= d.gD;
      if (F.synClasses) { this.aR2[k] *= d.aR; this.nR2[k] *= d.nR; this.nD2[k] *= d.nD; this.gR2[k] *= d.gR; }
    }
    const gain = columnGain(p.govDeltaP, this.G);
    for (let i = 0; i < nL1; i++) {
      if (!this.s1[i]) continue;
      for (let e = this.ffPtr[i]; e < this.ffPtr[i + 1]; e++) {
        const j = this.ffCol[e], w = this.ffW[e] * gain;
        this.aD2[j] += w;
        if (F.synClasses) { this.aR2[j] += w; this.nR2[j] += 0.5 * w; this.nD2[j] += 0.5 * w; }
      }
    }
    for (let q = 0; q < this.nPrev; q++) {
      const i = this.prevSpikes[q];
      for (let e = this.recPtr[i]; e < this.recPtr[i + 1]; e++) {
        const j = this.recCol[e], w = this.recW[e];
        if (w >= 0) { this.aD2[j] += w; if (F.synClasses) this.aR2[j] += w; }
        else { this.gD2[j] -= w; if (F.synClasses) this.gR2[j] -= w; }
      }
    }
    let excSum = 0, inhSum = 0, spkE = 0, spkI = 0;
    this.nPrev = 0;
    for (let k = 0; k < N; k++) {
      const isE = k < nE;
      let Iexc = this.Ka * (this.aD2[k] - (F.synClasses ? this.aR2[k] : 0));
      if (F.synClasses) {
        const theta = isE ? p.thetaE : p.thetaI;
        Iexc += nmdaGate(toMvEquivalent(this.v2[k], 0, theta), p.mg) * this.Kn * (this.nD2[k] - this.nR2[k]);
      }
      const Iinh = this.Kg * (this.gD2[k] - (F.synClasses ? this.gR2[k] : 0));
      let I = Iexc - Iinh;
      if (isE) { excSum += Iexc; inhSum += Iinh; if (F.lateral) I -= ctx.latInh; }
      else if (F.gapJunctions && ctx.gapV) I += p.gapCoupling * (ctx.gapV[k - nE] - this.v2[k]); // I = g_j (V_partner - V_self)
      let v = I + (this.v2[k] - I) * (isE ? d.E : d.I);
      const th = isE ? (F.alif ? alifThreshold(this.theta0E[k], p.betaA, this.a2[k]) : this.theta0E[k]) : p.thetaI;
      const s = v >= th ? 1 : 0;
      if (s) { v = 0; this.prevSpikes[this.nPrev++] = k; if (isE) spkE++; else spkI++; }
      this.v2[k] = v; this.s2[k] = s;
      if (isE) this.a2[k] = this.a2[k] * d.A + s;
      this.rate2[k] = ewma(this.rate2[k], s, p.tauRateL23);
    }
    // ---- health accumulators (5-min EWMA of the per-level spike fraction)
    this.rateL0 = ewma(this.rateL0, spk0 / nL0, 300); this.rateL1 = ewma(this.rateL1, spk1 / nL1, 300);
    this.rateE = ewma(this.rateE, spkE / nE, 300); this.rateI = ewma(this.rateI, spkI / (N - nE), 300);
    this.exc = ewma(this.exc, excSum / nE, 300); this.inh = ewma(this.inh, inhSum / nE, 300);
    // ---- intrinsic threshold homeostasis (silent columns; perps): see SnnParams.ipLow
    if (p.ipLow && ++this.ipCount >= 60) {
      this.ipCount = 0;
      const f = this.rateE < p.ipLow ? 1 - (p.ipStep ?? 0.02) : p.ipHigh && this.rateE > p.ipHigh ? 1 + (p.ipStep ?? 0.02) : 1;
      if (f !== 1) { const lo = (p.ipMin ?? 0.15) * p.thetaE; for (let k = 0; k < nE; k++) this.theta0E[k] = Math.max(lo, Math.min(p.thetaE, this.theta0E[k] * f)); }
    }
    // ---- 6. traces and plasticity (S6): minimal triplet x NMDA gate x governor, two-speed weights
    const learn = F.plasticity && !ctx.frozen;
    const T = p.triplet;
    for (let i = 0; i < nL0; i++) this.preR1[i] = this.preR1[i] * d.tp + this.s0[i];
    for (let n = 0; n < nL1; n++) { this.postO1[n] *= d.tm; this.postO2[n] *= d.ty; }
    for (let i = 0; i < nE; i++) this.preRE[i] = this.preRE[i] * d.tp + this.s2[i];
    for (let n = 0; n < nE; n++) { this.postO1E[n] *= d.tm; this.postO2E[n] *= d.ty; }
    if (learn) {
      const eta = etaEff(p.eta, p.govDelta, this.G);
      for (let n = 0; n < nL1; n++) {
        if (!this.s1[n]) continue;
        const g = this.gate1[n], o2 = this.postO2[n];
        for (let s = n * B * K, e = s + B * K; s < e; s++) this.w1[s] = gatedUpdate(this.w1[s], T.A3plus * this.preR1[this.src[s]] * o2, 0, eta, g, p.kappa, p.wMin, p.wMax);
      }
      for (let i = 0; i < nL0; i++) {
        if (!this.s0[i]) continue;
        for (let q = this.revPtr[i]; q < this.revPtr[i + 1]; q++) {
          const s = this.revSyn[q], n = Math.floor(s / (B * K));
          this.w1[s] = gatedUpdate(this.w1[s], 0, -a2MinusSlide(T.A2minus, this.rho1[n], T.rho0, T.p) * this.postO1[n], eta, this.gate1[n], p.kappa, p.wMin, p.wMax);
        }
      }
      for (let j = 0; j < nE; j++) {
        if (!this.s2[j]) continue;
        const g = nmdaGate(toMvEquivalent(p.thetaE, 0, p.thetaE), p.mg); // post just crossed threshold
        for (let q = this.inPtr[j]; q < this.inPtr[j + 1]; q++) {
          const e = this.inEdge[q];
          this.recW[e] = gatedUpdate(this.recW[e], T.A3plus * this.preRE[this.inPre[q]] * this.postO2E[j], 0, eta, g, p.kappa, 0, p.wMax);
        }
      }
      for (let i = 0; i < nE; i++) {
        if (!this.s2[i]) continue;
        for (let e = this.recPtr[i]; e < this.recPtr[i + 1]; e++) {
          const j = this.recCol[e];
          if (j >= nE) continue;
          const g = nmdaGate(toMvEquivalent(this.v2[j], 0, p.thetaE), p.mg);
          this.recW[e] = gatedUpdate(this.recW[e], 0, -a2MinusSlide(T.A2minus, this.rhoE[j], T.rho0, T.p) * this.postO1E[j], eta, g, p.kappa, 0, p.wMax);
        }
      }
    }
    for (let n = 0; n < nL1; n++) { this.postO1[n] += this.s1[n]; this.postO2[n] += this.s1[n]; this.rho1[n] = ewma(this.rho1[n], this.s1[n], p.tauRho); }
    for (let n = 0; n < nE; n++) { this.postO1E[n] += this.s2[n]; this.postO2E[n] += this.s2[n]; this.rhoE[n] = ewma(this.rhoE[n], this.s2[n], p.tauRho); }
    // Multi-rate: two-speed relaxation (exact for dt = slowEverySec) and the saturation fraction.
    if (++this.stepsSinceSlow >= p.slowEverySec) {
      const dt = this.stepsSinceSlow;
      this.stepsSinceSlow = 0;
      let sat = 0, tot = 0;
      if (F.plasticity) {
        for (let s = 0; s < this.nSyn; s++) {
          const r = twoSpeedStep(this.w1[s], this.w1s[s], p.tauC, p.eps, dt);
          this.w1[s] = r.wf; this.w1s[s] = r.ws;
        }
        for (let i = 0; i < nE; i++) for (let e = this.recPtr[i]; e < this.recPtr[i + 1]; e++) {
          if (this.recCol[e] >= nE) continue;
          const r = twoSpeedStep(this.recW[e], this.recWs[e], p.tauC, p.eps, dt);
          this.recW[e] = r.wf; this.recWs[e] = r.ws;
        }
      }
      for (let s = 0; s < this.nSyn; s++) { tot++; if (this.w1[s] <= p.wMin + 1e-6 || this.w1[s] >= p.wMax - 1e-6) sat++; }
      for (let i = 0; i < nE; i++) for (let e = this.recPtr[i]; e < this.recPtr[i + 1]; e++) {
        if (this.recCol[e] >= nE) continue;
        tot++; if (this.recW[e] <= 1e-9 || this.recW[e] >= p.wMax - 1e-6) sat++;
      }
      this.fSat = tot ? sat / tot : 0;
    }
    // ---- 7. governor
    const rhoHat = ctx.refRateE && ctx.refRateE > 0 ? Math.max(0, this.rateE / ctx.refRateE - 1) : 0;
    this.G = governorStep(this.G, { rhoHat, zE: Math.max(0, this.errZ), fSat: this.fSat, dBrier: ctx.dBrier }, { k1: p.govK[0], k2: p.govK[1], k3: p.govK[2], k4: p.govK[3] }, p.tauG);
    // ---- 8. predictive coding: predict this interval from last step's latents, then update
    if (F.pc) this.pcStep(ctx.frozen);
    // ---- deferred: Izhikevich CH burst detectors driven by aggregate L0 activity
    if (F.izhikevichCH) {
      let bursts = 0;
      for (let c = 0; c < this.chV.length; c++) {
        const o = izhikevichStep(this.chV[c], this.chU[c], 40 * (spk0 / nL0) * (1 + 0.1 * c), IZH.CH);
        this.chV[c] = o.v; this.chU[c] = o.u; if (o.spike) bursts++;
      }
      this.chBurst = ewma(this.chBurst, bursts / this.chV.length, 60);
    }
  }

  private pcStep(frozen: boolean): void {
    const p = this.p, nL0 = this.nL0, { nL1, nE } = p;
    const P1: PcParams = { k1: p.pcK1, k2: p.pcK2 * (1 - p.govDelta * this.G), sigma2: this.sigma2_1, sigmaTd2: p.pcSigmaTd2, lambda: p.pcLambda, eMax: p.pcEMax, priorL2: p.pcPriorL2 };
    const P0: PcParams = { ...P1, sigma2: this.sigma2_0 };
    const n1 = pcPredict(this.U1, this.z2, this.rate1, this.sc1);
    const n0 = pcPredict(this.U0, this.z1, this.rate0, this.sc0);
    const s = Math.sqrt((n1 * n1 / this.sigma2_1 + n0 * n0 / this.sigma2_0) / (nL1 + nL0));
    this.surpriseInst = s;
    // Error z-score against a slow EWMA mean/variance of the surprise (before this step's update).
    const sd = Math.sqrt(this.errVar);
    this.errZ = this.errN > 300 && sd > 1e-9 ? (s - this.errMean) / sd : 0;
    const a = 1 - Math.exp(-1 / Math.min(p.errZTau, ++this.errN));
    const dm = s - this.errMean;
    this.errMean += a * dm;
    this.errVar = (1 - a) * (this.errVar + a * dm * dm);
    // z > 6 -> clip the error to its z = 6 level; z > 10 for 3 consecutive steps -> freeze PC updates.
    let e1 = p.pcEMax, e0 = p.pcEMax;
    if (this.errZ > 6) {
      const s6 = this.errMean + 6 * sd;
      e1 = Math.min(e1, s6 * Math.sqrt(this.sigma2_1 * nL1));
      e0 = Math.min(e0, s6 * Math.sqrt(this.sigma2_0 * nL0));
    }
    this.zHighRun = this.errZ > 10 ? this.zHighRun + 1 : 0;
    if (this.zHighRun >= 3) { this.pcFrozen = true; this.pcNormalRun = 0; }
    if (this.pcFrozen) { this.pcNormalRun = this.errZ < 6 ? this.pcNormalRun + 1 : 0; if (this.pcNormalRun >= 3600) this.pcFrozen = false; }
    const learnU = p.flags.pcLearn && !this.pcFrozen && !frozen;
    // Top-down prior for the L2/3 latent: the spiking L2/3 E rates; for the L1 latent: L1 rates.
    pcUpdate(this.U1, this.z2, this.rate2.subarray(0, nE), this.sc1, P1, learnU, e1);
    pcUpdate(this.U0, this.z1, this.rate1, this.sc0, P0, learnU, e0);
    this.err0.set(this.sc0.e);
    // Feedback prediction f(U1 z2) depolarises the L1 somas next step (context for the NMDA gate).
    for (let i = 0; i < nL1; i++) {
      let v = 0;
      for (let j = 0; j < nE; j++) v += this.U1[i * nE + j] * this.z2[j];
      this.xhat1[i] = Math.tanh(v);
    }
    this.surprise = this.surprise ? ewma(this.surprise, s, p.surpriseTau) : s;
    if (learnU) {
      this.sigma2_1 = Math.min(p.pcSigma2Max, Math.max(p.pcSigma2Min, ewma(this.sigma2_1, (n1 * n1) / nL1, p.pcSigmaLearnTau)));
      this.sigma2_0 = Math.min(p.pcSigma2Max, Math.max(p.pcSigma2Min, ewma(this.sigma2_0, (n0 * n0) / nL0, p.pcSigmaLearnTau)));
    }
  }

  /** Readout feature vector for threshold distance d (in sigma sqrt(tau) units) and life fraction. */
  /** Proxy features: realized-vol regime ratio and delta-spike burst counter (corr is network-level). */
  proxyVolRatio(): number { return this.deltaSlow > 1e-9 ? Math.min(5, this.deltaFast / this.deltaSlow) / 5 : 0; }
  proxyBurst(): number { return Math.min(1, (this.deltaFast * 60) / 20); }

  features(d: number, tauFrac: number, extra: [number, number, number], out?: Float64Array): Float64Array {
    const p = this.p, { nE, nL1 } = p;
    const phi = out ?? new Float64Array(this.nFeat);
    phi.fill(0);
    const dc = Math.max(-4, Math.min(4, Number.isFinite(d) ? d : 0)) / 4;
    const tf = Math.max(0, Math.min(1, Number.isFinite(tauFrac) ? tauFrac : 0));
    phi[0] = 1; phi[1] = dc; phi[2] = Math.tanh(Number.isFinite(d) ? d : 0); phi[3] = tf; phi[4] = Math.sqrt(tf); phi[5] = dc * tf;
    let o = N_BASE;
    if (p.flags.rawReadout) {
      for (let i = 0; i < this.nL0; i++) phi[o + i] = this.rate0[i];
      return phi;
    }
    for (let i = 0; i < nE; i++) phi[o + i] = this.rate2[i];
    o += nE;
    for (let i = 0; i < nL1; i++) phi[o + i] = this.rate1[i];
    o += nL1;
    for (let q = 0; q < N_POOL; q++) {
      const a = Math.floor((q * nE) / N_POOL), b = Math.max(a + 1, Math.floor(((q + 1) * nE) / N_POOL));
      let s = 0;
      for (let i = a; i < b && i < nE; i++) s += this.rate2[i];
      phi[o + q] = dc * (s / (b - a));
    }
    o += N_POOL;
    phi[o] = extra[0]; phi[o + 1] = extra[1]; phi[o + 2] = extra[2];
    return phi;
  }

  /** Mean E rate (salience input) and mean I rate (lateral inhibition source). */
  meanRateE(): number { let s = 0; for (let i = 0; i < this.p.nE; i++) s += this.rate2[i]; return s / this.p.nE; }
  meanRateI(): number { let s = 0; for (let i = this.p.nE; i < this.N; i++) s += this.rate2[i]; return s / (this.N - this.p.nE); }
  meanRateL0(): number { let s = 0; for (let i = 0; i < this.nL0; i++) s += this.rate0[i]; return s / this.nL0; }

  /** Mean BCM sliding threshold theta_M = (rhobar/rho0)^p rhobar over L1 and E neurons (health). */
  bcmTheta(): number {
    const T = this.p.triplet;
    let s = 0, n = 0;
    for (const r of [this.rho1, this.rhoE]) for (let i = 0; i < r.length; i++) { s += (r[i] / T.rho0) ** T.p * r[i]; n++; }
    return n ? s / n : 0;
  }

  hasNaN(): boolean {
    for (const a of [this.v0, this.v1, this.v2, this.w1, this.recW, this.U1, this.U0, this.z1, this.z2]) for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return true;
    return !Number.isFinite(this.G) || !Number.isFinite(this.surprise);
  }
}

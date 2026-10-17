// The SNN column kernel (python/snn/column.cu): the column step in C with the TypeScript's operations in the same order and
// V8's own exp/log/tanh, so its results are the TypeScript's to the bit. Here it runs as WebAssembly (bot/snn/kernelWasm.ts,
// built by scripts/buildSnnWasm.ts), about twice as fast as Column.step in TypeScript; the C build checks it against the
// TypeScript (tests/snnKernel.test.ts) and the CUDA build runs it on the GPU (python/snn/bench.py).
//
// Each column gets its own WebAssembly memory, sized once (it never grows, so views into it stay valid) and freed with the
// column. The column's arrays become views into that memory, so the TypeScript (checkpoints, readouts, health, the e-prop
// training step, which stays in TypeScript) reads and writes the same state; its scalars are copied in before and out
// after each step. SNN_WASM=false keeps every column in TypeScript.

import type { Column, ColumnInput, TypedArr } from './column';
import { KERNEL_WASM_B64 } from './kernelWasm';
import type { SnnParams } from './params';

/** SnnP's int fields, then its double fields, in the struct's order. */
export const KERNEL_INTS = ['nL0', 'nL1', 'B', 'K', 'nE', 'N', 'nSyn', 'nThr', 'nPop', 'kindTennis', 'synClasses', 'dendrites', 'pc', 'lateral', 'gapJunctions', 'alif', 'plasticity', 'pcLearn', 'slowEverySec', 'pad_'] as const;
export const KERNEL_DOUBLES = [
  'deltaGain', 'midDelta', 'popGain', 'thetaL0', 'tauRateL0', 'nmdaWeight', 'mg', 'thetaL1', 'l1Gain', 'feedbackGain', 'tauRateL1',
  'govDeltaP', 'thetaE', 'thetaI', 'gapCoupling', 'betaA', 'tauRateL23', 'ipLow', 'ipHigh', 'ipStep', 'ipMin',
  'eta', 'govDelta', 'kappa', 'wMin', 'wMax', 'tauRho', 'A3plus', 'A2minus', 'rho0', 'tripP', 'tauC', 'eps',
  'govK0', 'govK1', 'govK2', 'govK3', 'tauG',
  'pcK1', 'pcK2', 'pcSigmaTd2', 'pcLambda', 'pcEMax', 'pcPriorL2', 'errZTau', 'surpriseTau', 'pcSigma2Max', 'pcSigma2Min', 'pcSigmaLearnTau',
  'dL0', 'dL1', 'dE', 'dI', 'dA', 'daR', 'daD', 'dnR', 'dnD', 'dgR', 'dgD', 'dtp', 'dtm', 'dty', 'Ka', 'Kn', 'Kg',
] as const;

/** Col's pointer fields in order (scalars last: Column.SCALARS doubles, then the int counters). */
export const KERNEL_F64 = [
  'thr', 'popLo', 'popHi', 'decBranch', 'I0', 'v0', 'rate0', 'deltaAcc', 'aR0', 'aD0', 'nR0', 'nD0', 'gA0', 'gN0',
  'theta1', 'alpha1', 'u1', 'b1', 'bbar', 'v1', 'rate1', 'gate1', 'preR1', 'postO1', 'postO2', 'rho1',
  'v2', 'a2', 'rate2', 'aR2', 'aD2', 'nR2', 'nD2', 'gR2', 'gD2', 'preRE', 'postO1E', 'postO2E', 'rhoE', 'theta0E', 'theta0I',
  'z2', 'z1', 'xhat1', 'err0', 's1u', 's1t', 's1e', 's1fe', 's1r0', 's1acc', 's0u', 's0t', 's0e', 's0fe', 's0r0', 's0acc',
] as const;
export const KERNEL_U8 = ['s0', 's1', 's2'] as const;
export const KERNEL_F32 = ['w1', 'w1s', 'ffW', 'recW', 'recWs', 'U1', 'U0'] as const;
export const KERNEL_I32 = ['src', 'ffPtr', 'ffCol', 'recPtr', 'recCol', 'inPtr', 'inEdge', 'inPre', 'revPtr', 'revSyn', 'prevSpikes'] as const;
const SC = ['midAcc', 'lastSpot', 'lastMid', 'sigma2_1', 'sigma2_0', 'surprise', 'surpriseInst', 'errMean', 'errVar', 'errN', 'errZ',
  'zHighRun', 'pcNormalRun', 'G', 'rateL0', 'rateL1', 'rateE', 'rateI', 'exc', 'inh', 'fSat', 'chBurst', 'deltaFast', 'deltaSlow', 'lastRetBp'] as const;
const SI = ['pcFrozen', 'nPrev', 'stepsSinceSlow', 'ipCount'] as const;

type Priv = Record<string, unknown> & {
  p: SnnParams; pop: { name: string; lo: number; hi: number }[]; deltaThr: number[]; dec: Record<string, number>;
  Ka: number; Kn: number; Kg: number; decBranch: Float64Array;
  sc1: Scratch; sc0: Scratch;
};
type Scratch = { u: Float64Array; t: Float64Array; e: Float64Array; fe: Float64Array; r0: Float64Array; acc: Float64Array };
const priv = (c: Column) => c as unknown as Priv;

/** Flags the kernel does not implement. */
export function kernelUnsupported(p: SnnParams): string[] {
  const out: string[] = [];
  if (p.flags.dcaap) out.push('dcaap');
  if (p.flags.izhikevichCH) out.push('izhikevichCH');
  if (p.flags.plasticity && p.triplet.p !== 1 && p.triplet.p !== 2) out.push('triplet.p other than 1 or 2');
  return out;
}

export function kernelParams(c: Column): { ints: Int32Array; dbls: Float64Array } {
  const x = priv(c), p = x.p, d = x.dec, F = p.flags;
  const ints: Record<(typeof KERNEL_INTS)[number], number> = {
    nL0: c.nL0, nL1: p.nL1, B: p.branches, K: p.synPerBranch, nE: p.nE, N: c.N, nSyn: c.nSyn, nThr: x.deltaThr.length, nPop: x.pop.length, kindTennis: c.kind === 'tennis' ? 1 : 0,
    synClasses: +F.synClasses, dendrites: +F.dendrites, pc: +F.pc, lateral: +F.lateral, gapJunctions: +F.gapJunctions, alif: +F.alif, plasticity: +F.plasticity, pcLearn: +F.pcLearn,
    slowEverySec: p.slowEverySec, pad_: 0,
  };
  const dbls: Record<(typeof KERNEL_DOUBLES)[number], number> = {
    deltaGain: p.deltaGain, midDelta: p.midDelta, popGain: p.popGain, thetaL0: p.thetaL0, tauRateL0: p.tauRateL0,
    nmdaWeight: p.nmdaWeight, mg: p.mg, thetaL1: p.thetaL1, l1Gain: p.l1Gain, feedbackGain: p.feedbackGain, tauRateL1: p.tauRateL1,
    govDeltaP: p.govDeltaP, thetaE: p.thetaE, thetaI: p.thetaI, gapCoupling: p.gapCoupling, betaA: p.betaA, tauRateL23: p.tauRateL23,
    ipLow: p.ipLow || 0, ipHigh: p.ipHigh || 0, ipStep: p.ipStep ?? 0.02, ipMin: p.ipMin ?? 0.15,
    eta: p.eta, govDelta: p.govDelta, kappa: p.kappa, wMin: p.wMin, wMax: p.wMax, tauRho: p.tauRho,
    A3plus: p.triplet.A3plus, A2minus: p.triplet.A2minus, rho0: p.triplet.rho0, tripP: p.triplet.p, tauC: p.tauC, eps: p.eps,
    govK0: p.govK[0], govK1: p.govK[1], govK2: p.govK[2], govK3: p.govK[3], tauG: p.tauG,
    pcK1: p.pcK1, pcK2: p.pcK2, pcSigmaTd2: p.pcSigmaTd2, pcLambda: p.pcLambda, pcEMax: p.pcEMax, pcPriorL2: p.pcPriorL2, errZTau: p.errZTau,
    surpriseTau: p.surpriseTau, pcSigma2Max: p.pcSigma2Max, pcSigma2Min: p.pcSigma2Min, pcSigmaLearnTau: p.pcSigmaLearnTau,
    dL0: d.L0, dL1: d.L1, dE: d.E, dI: d.I, dA: d.A, daR: d.aR, daD: d.aD, dnR: d.nR, dnD: d.nD, dgR: d.gR, dgD: d.gD, dtp: d.tp, dtm: d.tm, dty: d.ty,
    Ka: x.Ka, Kn: x.Kn, Kg: x.Kg,
  };
  return { ints: Int32Array.from(KERNEL_INTS.map((k) => ints[k])), dbls: Float64Array.from(KERNEL_DOUBLES.map((k) => dbls[k])) };
}

/** The column's state as the kernel's arrays, in Col's pointer order (live views where the column has the array). */
export function kernelArrays(c: Column): TypedArr[] {
  const x = priv(c);
  const named: Record<string, TypedArr> = {
    thr: Float64Array.from(x.deltaThr), popLo: Float64Array.from(x.pop.map((f) => f.lo)), popHi: Float64Array.from(x.pop.map((f) => f.hi)), decBranch: x.decBranch,
    s1u: x.sc1.u, s1t: x.sc1.t, s1e: x.sc1.e, s1fe: x.sc1.fe, s1r0: x.sc1.r0, s1acc: x.sc1.acc,
    s0u: x.sc0.u, s0t: x.sc0.t, s0e: x.sc0.e, s0fe: x.sc0.fe, s0r0: x.sc0.r0, s0acc: x.sc0.acc,
  };
  const get = (k: string) => named[k] ?? (x[k] as TypedArr);
  return [
    ...KERNEL_F64.map(get), ...KERNEL_U8.map(get), ...KERNEL_F32.map(get), ...KERNEL_I32.map(get),
    Float64Array.from(SC.map((k) => { const v = x[k]; return typeof v === 'boolean' ? +v : (v as number); })),
    Int32Array.from(SI.map((k) => { const v = x[k]; return typeof v === 'boolean' ? +v : (v as number); })),
  ];
}

/** One call's inputs as the kernel reads them (StepIn): absent values are NaN, an absent reference rate 0. */
export function kernelInput(c: Column, inp: ColumnInput, first: boolean, ctx: { latInh: number; gapV?: Float64Array; dBrier: number; refRateE?: number; frozen: boolean }) {
  const x = priv(c);
  const vals = inp.values ?? { dAtm: inp.dAtm, tauFrac: inp.tauFrac, mid: inp.mid, spread: inp.spread, imbalance: inp.imbalance };
  return {
    price: inp.price ?? inp.spot ?? NaN, mid: inp.mid ?? NaN, latInh: ctx.latInh, dBrier: ctx.dBrier, refRateE: ctx.refRateE || 0, first: first ? 1 : 0, frozen: ctx.frozen ? 1 : 0,
    vals: Float64Array.from(x.pop.map((f) => vals[f.name] ?? NaN)), gapV: ctx.gapV ? Float64Array.from(ctx.gapV) : undefined,
  };
}


const SC_NAMES = SC as readonly string[];
const SI_NAMES = SI as readonly string[];
let compiled: { mod: WebAssembly.Module; heapBase: number } | null | undefined;

/** The compiled kernel (once per thread), or undefined when WebAssembly is off or unavailable. */
export function kernelModule(env: NodeJS.ProcessEnv = process.env): { mod: WebAssembly.Module; heapBase: number } | undefined {
  if (compiled === undefined) {
    try {
      if (env.SNN_WASM === 'false') compiled = null;
      else {
        const mod = new WebAssembly.Module(Buffer.from(KERNEL_WASM_B64, 'base64'));
        // The stack and constants sit below __heap_base; a probe instance reads where the free memory starts.
        const probe = new WebAssembly.Instance(mod, { env: { memory: new WebAssembly.Memory({ initial: 64 }) } });
        compiled = { mod, heapBase: (probe.exports.__heap_base as WebAssembly.Global).value as number };
      }
    } catch { compiled = null; }
  }
  return compiled ?? undefined;
}

const al8 = (n: number) => (n + 7) & ~7;

/** Columns created while `off` is set stay in TypeScript (tests compare both). */
export const kernelSwitch = { off: false };

/** A column's WebAssembly state and step. */
export class ColumnKernel {
  private constructor(
    private readonly step_: (p: number, c: number, i: number) => void,
    private readonly pP: number, private readonly pC: number, private readonly pIn: number,
    private readonly sc: Float64Array, private readonly si: Int32Array,
    private readonly inF: Float64Array, private readonly inI: Int32Array, private readonly inP: Uint32Array,
    private readonly vals: Float64Array, private readonly gap: Float64Array, private readonly pGap: number,
    private readonly pop: string[],
  ) {}

  /** Moves the column's state into its own WebAssembly memory (its arrays become views) and returns the kernel, or
   *  undefined (the column stays in TypeScript) when WebAssembly is off or the column uses an unported mechanism. */
  static attach(c: Column): ColumnKernel | undefined {
    const x = priv(c);
    if (kernelSwitch.off || kernelUnsupported(x.p).length) return undefined;
    const k = kernelModule();
    if (!k) return undefined;
    const { ints, dbls } = kernelParams(c);
    const arrs = kernelArrays(c);
    const nI = c.N - x.p.nE;
    let pos = al8(k.heapBase);
    const take = (n: number) => { const at = pos; pos = al8(pos + n); return at; };
    const pP = take(ints.byteLength + dbls.byteLength), pC = take(arrs.length * 4);
    const pA = arrs.map((a) => take(a.byteLength));
    const pIn = take(64), pVals = take(8 * Math.max(1, x.pop.length)), pGap = take(8 * Math.max(1, nI));
    const memory = new WebAssembly.Memory({ initial: Math.ceil(pos / 65536), maximum: Math.ceil(pos / 65536) });
    const inst = new WebAssembly.Instance(k.mod, { env: { memory } });
    const buf = memory.buffer, u8 = new Uint8Array(buf);
    u8.set(new Uint8Array(ints.buffer, ints.byteOffset, ints.byteLength), pP);
    u8.set(new Uint8Array(dbls.buffer, dbls.byteOffset, dbls.byteLength), pP + ints.byteLength);
    const slots = new Uint32Array(buf, pC, arrs.length);
    const view = (a: TypedArr, at: number): TypedArr => {
      const v = a instanceof Float64Array ? new Float64Array(buf, at, a.length) : a instanceof Float32Array ? new Float32Array(buf, at, a.length)
        : a instanceof Int32Array ? new Int32Array(buf, at, a.length) : new Uint8Array(buf, at, a.length);
      v.set(a as never);
      return v;
    };
    const views = arrs.map((a, i) => { slots[i] = pA[i]; return view(a, pA[i]); });
    // The column now works on the views (the first four kernel arrays are the encoders' constants, not column fields).
    const names = [...KERNEL_F64, ...KERNEL_U8, ...KERNEL_F32, ...KERNEL_I32];
    const scratch: Record<string, [Scratch, keyof Scratch]> = {
      s1u: [x.sc1, 'u'], s1t: [x.sc1, 't'], s1e: [x.sc1, 'e'], s1fe: [x.sc1, 'fe'], s1r0: [x.sc1, 'r0'], s1acc: [x.sc1, 'acc'],
      s0u: [x.sc0, 'u'], s0t: [x.sc0, 't'], s0e: [x.sc0, 'e'], s0fe: [x.sc0, 'fe'], s0r0: [x.sc0, 'r0'], s0acc: [x.sc0, 'acc'],
    };
    names.forEach((n, i) => {
      if (n === 'thr' || n === 'popLo' || n === 'popHi') return;
      const s = scratch[n];
      if (s) (s[0] as Record<string, unknown>)[s[1]] = views[i];
      else (x as Record<string, unknown>)[n] = views[i];
    });
    const ex = inst.exports as unknown as { col_step: (p: number, c: number, i: number) => void };
    return new ColumnKernel(ex.col_step, pP, pC, pIn, views[names.length] as Float64Array, views[names.length + 1] as Int32Array,
      new Float64Array(buf, pIn, 5), new Int32Array(buf, pIn + 40, 4), new Uint32Array(buf, pIn + 56, 2),
      new Float64Array(buf, pVals, x.pop.length), new Float64Array(buf, pGap, nI), pGap, x.pop.map((f) => f.name));
  }

  /** Column.step in WebAssembly (the same bits). */
  step(c: Column, inp: ColumnInput, first: boolean, ctx: { latInh: number; gapV?: Float64Array; dBrier: number; refRateE?: number; frozen: boolean }): void {
    const x = priv(c), sc = this.sc, si = this.si;
    for (let i = 0; i < SC_NAMES.length; i++) sc[i] = x[SC_NAMES[i]] as number;
    si[0] = x.pcFrozen ? 1 : 0; si[1] = x.nPrev as number; si[2] = x.stepsSinceSlow as number; si[3] = x.ipCount as number;
    const f = this.inF;
    f[0] = inp.price ?? inp.spot ?? NaN; f[1] = inp.mid ?? NaN; f[2] = ctx.latInh; f[3] = ctx.dBrier; f[4] = ctx.refRateE || 0;
    this.inI[0] = first ? 1 : 0; this.inI[1] = ctx.frozen ? 1 : 0; this.inI[2] = 1; this.inI[3] = 0;
    const vals = inp.values ?? { dAtm: inp.dAtm, tauFrac: inp.tauFrac, mid: inp.mid, spread: inp.spread, imbalance: inp.imbalance };
    for (let i = 0; i < this.pop.length; i++) this.vals[i] = vals[this.pop[i]] ?? NaN;
    this.inP[0] = this.vals.byteOffset;
    if (ctx.gapV) { this.gap.set(ctx.gapV.subarray(0, this.gap.length)); this.inP[1] = this.pGap; } else this.inP[1] = 0;
    this.step_(this.pP, this.pC, this.pIn);
    for (let i = 0; i < SC_NAMES.length; i++) x[SC_NAMES[i]] = sc[i];
    x.pcFrozen = si[0] !== 0; x.nPrev = si[1]; x.stepsSinceSlow = si[2]; x.ipCount = si[3];
  }
}

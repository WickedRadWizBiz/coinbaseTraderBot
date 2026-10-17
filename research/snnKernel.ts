// The SNN column kernel's view of a column (python/snn/column.cu): its parameters, its state in the kernel's
// pointer order and each call's inputs, plus a trace recorder for the parity check. A trace is the state of
// every column before its first step, every call the network made to Column.step (and resetTransient) in
// order, and every column's state after the last one; the C build of the kernel replays the calls and must
// end on the same bits (tests/snnKernel.test.ts), as must the GPU build (python/snn/bench.py).

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Column, type ColumnInput, type TypedArr } from '../bot/snn/column';
import { DEFAULT_SNN, domainParams, stageFlags, withFlags, type SnnParams, type Stage } from '../bot/snn/params';
import { recordingDayList } from '../bot/marketdata/recordingFiles';
import { replaySnn } from './snnReplay';

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

const DT = (a: TypedArr) => (a instanceof Float64Array ? 0 : a instanceof Float32Array ? 1 : a instanceof Int32Array ? 2 : 3);

class Bin {
  parts: Buffer[] = [];
  u32(x: number) { const b = Buffer.alloc(4); b.writeUInt32LE(x >>> 0); this.parts.push(b); }
  i32(x: number) { const b = Buffer.alloc(4); b.writeInt32LE(x); this.parts.push(b); }
  f64(x: number) { const b = Buffer.alloc(8); b.writeDoubleLE(x); this.parts.push(b); }
  arr(a: TypedArr) { this.parts.push(Buffer.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength).slice())); }
  typed(a: TypedArr) { this.u32(DT(a)); this.u32(a.length); this.arr(a); }
}

/** Records every Column.step (and resetTransient) while `run` drives the network, capped at `maxCalls`;
 *  writes the trace to `file`. Returns the number of calls recorded. */
export async function recordKernelTrace(file: string, run: () => Promise<unknown>, maxCalls = Infinity): Promise<{ calls: number; columns: number; tsUsPerColumnStep: number }> {
  const proto = Column.prototype as unknown as { step: Column['step']; resetTransient: Column['resetTransient'] };
  const origStep = proto.step, origReset = proto.resetTransient;
  const ids = new Map<Column, number>();
  const head = new Bin(), calls = new Bin();
  let n = 0, tsMs = 0, tsSteps = 0;
  const idOf = (c: Column) => {
    let id = ids.get(c);
    if (id === undefined) {
      const bad = kernelUnsupported(priv(c).p);
      if (bad.length) throw new Error(`snn kernel: unsupported flags ${bad.join(', ')}`);
      id = ids.size; ids.set(c, id);
      const kp = kernelParams(c);
      head.u32(kp.ints.length); head.arr(kp.ints); head.u32(kp.dbls.length); head.arr(kp.dbls);
      const arrs = kernelArrays(c);
      head.u32(arrs.length); for (const a of arrs) head.typed(a);
    }
    return id;
  };
  let final: Buffer[] | undefined;
  const snapshot = () => { const b = new Bin(); for (const c of ids.keys()) for (const a of kernelArrays(c)) b.typed(a); final = b.parts; };
  const after = () => { if (n >= maxCalls && !final) snapshot(); };
  proto.step = function (this: Column, inp, first, ctx) {
    if (n < maxCalls) {
      if (ctx.training) throw new Error('snn kernel: e-prop training is not ported');
      const id = idOf(this), k = kernelInput(this, inp, first, ctx);
      calls.u32(0); calls.u32(id); calls.i32(k.first); calls.i32(k.frozen);
      for (const v of [k.price, k.mid, k.latInh, k.dBrier, k.refRateE]) calls.f64(v);
      calls.typed(k.vals); calls.u32(k.gapV ? 1 : 0); if (k.gapV) calls.typed(k.gapV);
      n++;
    }
    const t0 = performance.now();
    const r = origStep.call(this, inp, first, ctx);
    if (!final) { tsMs += performance.now() - t0; tsSteps++; }
    after();
    return r;
  };
  proto.resetTransient = function (this: Column) {
    if (n < maxCalls && ids.has(this)) { calls.u32(1); calls.u32(ids.get(this)!); n++; }
    origReset.call(this);
    after();
  };
  try { await run(); } finally { proto.step = origStep; proto.resetTransient = origReset; }
  if (!final) snapshot();
  const out = new Bin();
  out.parts.push(Buffer.from('SNNK')); out.u32(1); out.u32(ids.size);
  out.parts.push(Buffer.concat(head.parts));
  out.u32(n); out.parts.push(Buffer.concat(calls.parts));
  out.parts.push(Buffer.concat(final!));
  fs.writeFileSync(file, Buffer.concat(out.parts));
  return { calls: n, columns: ids.size, tsUsPerColumnStep: tsSteps ? (1000 * tsMs) / tsSteps : NaN };
}

/** bench.py: next to the bundle (the trainer package: app/python/snn), else the repository's. */
export function kernelBenchScript(entry = process.argv[1] ?? ''): string | undefined {
  return [path.resolve(path.dirname(entry), '..', 'python', 'snn', 'bench.py'), path.resolve('python', 'snn', 'bench.py')].find((c) => fs.existsSync(c));
}

/** The GPU prototype's check on this computer: records the crypto network's column steps over the first `hours` of
 *  the latest recorded day, then runs them on the GPU for several population sizes (python/snn/bench.py), every
 *  member checked bit for bit against the TypeScript network. Writes <outDir>/snn-gpu-bench.json. */
export async function snnKernelBench(o: { recordings: string; outDir: string; python: string; hours?: number; stage?: Stage; members?: string; log: (m: string) => void }): Promise<{ ok: boolean; report?: unknown }> {
  const days = recordingDayList(o.recordings);
  if (!days.length) { o.log(`no recordings in ${o.recordings}`); return { ok: false }; }
  const script = kernelBenchScript();
  if (!script) { o.log('python/snn/bench.py is missing'); return { ok: false }; }
  const day = days[days.length - 1], prev = days[days.length - 2];
  const from = Date.parse(`${day}T00:00:00Z`), to = from + (o.hours ?? 4) * 3_600_000;
  const params = domainParams('crypto', withFlags(DEFAULT_SNN, stageFlags(o.stage ?? 'S5')));
  fs.mkdirSync(o.outDir, { recursive: true });
  const trace = path.join(o.outDir, 'snn-kernel-trace.bin');
  o.log(`recording the crypto network's column steps on ${day} (${o.hours ?? 4} h)...`);
  const t = await recordKernelTrace(trace, () => replaySnn(o.recordings, { params, domain: 'crypto', skipModel: true, from, to, fromDay: prev ?? day, toDay: day }));
  o.log(`${t.calls} column steps over ${t.columns} columns; TypeScript: ${t.tsUsPerColumnStep.toFixed(1)} us per column step`);
  const json = path.join(o.outDir, 'snn-gpu-bench.json');
  const r = spawnSync(o.python, [script, trace, '--members', o.members ?? '1,4,8,16,32,64', '--json', json], { stdio: 'inherit', windowsHide: true });
  fs.rmSync(trace, { force: true });
  if (!fs.existsSync(json)) { o.log(`the GPU check did not finish (exit ${r.status})`); return { ok: false }; }
  const report = { ...JSON.parse(fs.readFileSync(json, 'utf8')), day, hours: o.hours ?? 4, tsUsPerColumnStep: t.tsUsPerColumnStep };
  fs.writeFileSync(json, JSON.stringify(report, null, 1));
  const runs = (report.runs ?? []) as { members: number; usPerStep: number; identical: boolean }[];
  for (const x of runs) {
    const cpu = x.members * t.columns * t.tsUsPerColumnStep;
    o.log(`${x.members} member(s): GPU ${x.usPerStep.toFixed(0)} us per step vs TypeScript ${cpu.toFixed(0)} us on one core (${(cpu / x.usPerStep).toFixed(1)}x)${x.identical ? '' : ' -- NOT bit-identical'}`);
  }
  o.log(`report: ${json}`);
  return { ok: r.status === 0, report };
}

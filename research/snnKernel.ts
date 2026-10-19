// The SNN column kernel's view of a column (python/snn/column.cu): its parameters, its state in the kernel's
// pointer order and each call's inputs, plus a trace recorder for the parity check. A trace is the state of
// every column before its first step, every call the network made to Column.step (and resetTransient) in
// order, and every column's state after the last one; the C build of the kernel replays the calls and must
// end on the same bits (tests/snnKernel.test.ts), as must the GPU build (python/snn/bench.py).

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Column, type TypedArr } from '../bot/snn/column';
import { kernelArrays, kernelInput, kernelParams, kernelUnsupported } from '../bot/snn/kernel';
import { DEFAULT_SNN, domainParams, stageFlags, withFlags, type Stage } from '../bot/snn/params';
import { recordingDayList } from '../bot/marketdata/recordingFiles';
import { replaySnn } from './snnReplay';
import { workerCount } from './workerPool';

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
      const bad = kernelUnsupported((c as unknown as { p: Parameters<typeof kernelUnsupported>[0] }).p);
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
  const r = spawnSync(o.python, [script, trace, '--members', o.members ?? '1,8,32,64,128,256', '--json', json], { stdio: 'inherit', windowsHide: true });
  fs.rmSync(trace, { force: true });
  if (!fs.existsSync(json)) { o.log(`the GPU check did not finish (exit ${r.status})`); return { ok: false }; }
  const report = { ...JSON.parse(fs.readFileSync(json, 'utf8')), day, hours: o.hours ?? 4, tsUsPerColumnStep: t.tsUsPerColumnStep };
  fs.writeFileSync(json, JSON.stringify(report, null, 1));
  // Against the CPU: one core, and every thread the tournaments use (TRAIN_WORKERS; an estimate: members split evenly).
  const cores = Math.max(1, workerCount());
  type Run = { members: number; usPerStep: number; identical: boolean };
  for (const [kind, runs] of [['thread-per-column kernel', report.runs], [`block kernel (${report.blockThreads} threads per column)`, report.blockRuns]] as const) {
    if (!runs?.length) continue;
    o.log(kind + ':');
    for (const x of runs as Run[]) {
      const cpu = x.members * t.columns * t.tsUsPerColumnStep, all = cpu / Math.min(cores, x.members);
      o.log(`  ${x.members} member(s): GPU ${x.usPerStep.toFixed(0)} us per step; CPU ${cpu.toFixed(0)} us on one core (${(cpu / x.usPerStep).toFixed(1)}x), ~${all.toFixed(0)} us on ${Math.min(cores, x.members)} thread(s) (${(all / x.usPerStep).toFixed(1)}x)${x.identical ? '' : ' -- NOT bit-identical'}`);
    }
  }
  o.log(`report: ${json}`);
  return { ok: r.status === 0, report };
}

/** The GPU tournament engine's check on this computer (research/snnGpu.ts): one member plays a tape of the first `hours` of
 *  the latest recorded day on the CPU, then groups of members (knobs spread by up to 10%) play it with their columns on the
 *  GPU; the first two members of each group are checked bit for bit against the CPU. Adds `engine` to the report. */
export async function snnEngineBench(o: { recordings: string; outDir: string; python: string; hours?: number; stage?: Stage; groups?: number[]; cpu?: boolean; log: (m: string) => void }): Promise<{ ok: boolean; engine?: unknown }> {
  const days = recordingDayList(o.recordings);
  if (!days.length) return { ok: false };
  const { recordSnnTape, playSnnTape } = await import('./snnTape');
  const { GpuPool, playSnnTapeGpu } = await import('./snnGpu');
  const { snnHyperOf, withSnnHyper } = await import('../bot/snn/population');
  const day = days[days.length - 1], prev = days[days.length - 2];
  const from = Date.parse(`${day}T00:00:00Z`), to = from + (o.hours ?? 2) * 3_600_000;
  const base = domainParams('crypto', withFlags(DEFAULT_SNN, stageFlags(o.stage ?? 'S5')));
  const tape = path.join(o.outDir, 'snn-engine-bench.tape');
  o.log(`GPU tournament engine: recording ${o.hours ?? 2} h of ${day} as a tape...`);
  await recordSnnTape(o.recordings, tape, { params: base, domain: 'crypto', skipModel: true, from, to, fromDay: prev ?? day, toDay: day });
  const member = (i: number) => {
    let s = (i + 1) * 2654435761 >>> 0;
    const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
    return { params: i === 0 ? base : withSnnHyper(base, Object.fromEntries(Object.entries(snnHyperOf(base)).map(([k, v]) => [k, v * (0.9 + 0.2 * r())]))), domain: 'crypto' as const };
  };
  const t0 = performance.now();
  const ref0 = playSnnTape(tape, member(0));
  const cpuSec = (performance.now() - t0) / 1000;
  const ref1 = playSnnTape(tape, member(1));
  const columns = ref0.net.columns.size, steps = ref0.steps;
  o.log(`one member on one CPU core: ${cpuSec.toFixed(1)} s (${columns} columns, ${steps} steps)`);
  const pool = await GpuPool.start({ python: o.python, cpu: o.cpu });
  const runs: { members: number; seconds: number; memberSecondsPerCpuMember: number; vsOneCore: number; identical: boolean }[] = [];
  try {
    o.log(`pool: ${JSON.stringify(await pool.info())}`);
    for (const m of o.groups ?? [8, 16, 32]) {
      const members = Array.from({ length: m }, (_, i) => member(i));
      const g0 = performance.now();
      const out = await playSnnTapeGpu(tape, members, pool);
      const sec = (performance.now() - g0) / 1000;
      const same = (a: typeof ref0, b: typeof ref0) => JSON.stringify(a.rows) === JSON.stringify(b.rows) && JSON.stringify(a.net.serialize()) === JSON.stringify(b.net.serialize());
      const identical = same(out[0], ref0) && same(out[1], ref1);
      runs.push({ members: m, seconds: sec, memberSecondsPerCpuMember: sec / m / cpuSec, vsOneCore: (m * cpuSec) / sec, identical });
      o.log(`${m} members on the GPU: ${sec.toFixed(1)} s, ${((m * cpuSec) / sec).toFixed(1)}x one CPU core${identical ? ', bit-identical to the CPU' : ' -- NOT bit-identical'}`);
    }
  } finally {
    await pool.close();
    fs.rmSync(tape, { force: true });
  }
  const engine = { day, hours: o.hours ?? 2, columns, steps, cpuSecondsPerMember: cpuSec, runs };
  const json = path.join(o.outDir, 'snn-gpu-bench.json');
  let report: Record<string, unknown> = {};
  try { report = JSON.parse(fs.readFileSync(json, 'utf8')); } catch { /* the kernel check did not run */ }
  fs.writeFileSync(json, JSON.stringify({ ...report, engine }, null, 1));
  return { ok: runs.every((r) => r.identical), engine };
}

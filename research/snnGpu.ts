// The GPU tournament engine: a group of tournament members plays one tape in lockstep, every member's columns on the GPU.
//
// The columns live in a device pool (python/snn/pool.py: the block kernel, python/snn/column_par.cuh, through
// python/snn/group.cuh); everything else of each member's network (inputs, lateral inhibition, readouts, direction heads,
// salience, health, the NaN guard, scoring and settlements) stays here, on the member's own SnnNetwork, exactly as when it
// plays the tape on the CPU (research/snnTape.ts TapeMember). Per network step the members' columns go to the pool as one
// batch of records (inputs and cross-column terms); each comes back as a summary (the column's scalars, mean rates, BCM
// threshold, on request the NaN check and the rate vectors the readouts read), which the host column takes on. So every
// member's rows and network come out bit for bit as from playSnnTape (tests/snnGpu.test.ts, with the pool's C build).
//
// Not on the GPU (the member plays on the CPU instead): gap junctions (columns stepping in a chain), the unported
// mechanisms (dCaAP, Izhikevich, triplet exponents other than 1 or 2), e-prop training.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Column, TypedArr } from '../bot/snn/column';
import { kernelArrays, kernelInput, kernelLoad, kernelParams, kernelScalars, kernelUnsupported, KERNEL_SC, KERNEL_SI } from '../bot/snn/kernel';
import { SNN_DT_MS, type SnnNetwork } from '../bot/snn/network';
import type { SnnParams } from '../bot/snn/params';
import type { SnnReplayResult } from './snnReplay';
import { readTape, TAPE_OP, TapeMember, type PlayOpts, type TapeOp } from './snnTape';

const OP_ADD = 1, OP_STEP = 2, OP_GET = 3, OP_FREE = 4, OP_INFO = 5, OP_QUIT = 9;
const GSUM = 34, REC = 64, WANT_NAN = 1, WANT_FEAT = 2;
const NSC = KERNEL_SC.length, NSI = KERNEL_SI.length;

/** Why a member cannot play on the GPU (empty: it can). */
export function gpuUnsupported(p: SnnParams): string[] {
  const out = kernelUnsupported(p);
  if (p.flags.gapJunctions) out.push('gapJunctions');
  return out;
}

const dtypeOf = (a: TypedArr) => (a instanceof Float64Array ? 0 : a instanceof Float32Array ? 1 : a instanceof Int32Array ? 2 : 3);

/** pool.py: next to the bundle (the trainer package: app/python/snn), else the repository's. */
export function poolScript(entry = process.argv[1] ?? ''): string {
  const c = [path.resolve(path.dirname(entry), '..', 'python', 'snn', 'pool.py'), path.resolve('python', 'snn', 'pool.py')];
  return c.find((f) => fs.existsSync(f)) ?? c[1];
}

/** The pool process: binary frames over its stdin and stdout, one request at a time. */
export class GpuPool {
  private buf = Buffer.alloc(0);
  private waiting?: { resolve: (b: Buffer) => void; reject: (e: Error) => void };
  private err = '';
  private dead?: Error;

  private constructor(private readonly proc: ChildProcessWithoutNullStreams) {
    proc.stdout.on('data', (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    proc.stderr.on('data', (d: Buffer) => { this.err = (this.err + d.toString()).slice(-4000); });
    const gone = (e: Error) => {
      this.dead ??= e;
      this.waiting?.reject(this.dead);
      this.waiting = undefined;
    };
    proc.on('exit', (code) => gone(new Error(`SNN GPU pool exited (${code}): ${this.err.trim().split('\n').pop() ?? ''}\n${this.err.trim()}`)));
    // No such Python (spawn fails): the start's first request fails instead of the process.
    proc.on('error', (e) => gone(new Error(`SNN GPU pool did not start: ${e.message}`)));
    proc.stdin.on('error', () => { /* the exit above reports it */ });
  }

  /** Starts a pool: `python` with PyTorch for the GPU; `cpu` for the C build (tests): serial, or with `threads` the GPU's
   *  group kernel on that many POSIX threads. */
  static async start(o: { python: string; cpu?: boolean; threads?: number; env?: NodeJS.ProcessEnv; script?: string }): Promise<GpuPool> {
    const script = o.script ?? poolScript();
    const proc = spawn(o.python, [script, ...(o.cpu ? ['--cpu'] : []), ...(o.threads ? ['--threads', String(o.threads)] : [])], { env: o.env ?? process.env, windowsHide: true });
    const pool = new GpuPool(proc);
    await pool.info();
    return pool;
  }

  private drain(): void {
    if (!this.waiting || this.buf.length < 4) return;
    const n = this.buf.readUInt32LE(0);
    if (this.buf.length < 4 + n) return;
    const msg = this.buf.subarray(4, 4 + n);
    this.buf = this.buf.subarray(4 + n);
    const w = this.waiting;
    this.waiting = undefined;
    w.resolve(Buffer.from(msg));
  }

  private request(op: number, payload: Buffer): Promise<Buffer> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      const head = Buffer.alloc(5);
      head.writeUInt32LE(payload.length, 0); head.writeUInt8(op, 4);
      this.proc.stdin.write(Buffer.concat([head, payload]));
      this.drain();
    });
  }

  async info(): Promise<{ backend: string; device: string; threads: number }> { return JSON.parse((await this.request(OP_INFO, Buffer.alloc(0))).toString()); }

  /** Uploads a column (its kernel params and arrays); returns its id in the pool. */
  async add(c: Column): Promise<number> {
    const { ints, dbls } = kernelParams(c);
    const arrs = kernelArrays(c);
    const parts: Buffer[] = [];
    const u32 = (x: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(x); parts.push(b); };
    u32(ints.length); parts.push(Buffer.from(ints.buffer, ints.byteOffset, ints.byteLength));
    u32(dbls.length); parts.push(Buffer.from(dbls.buffer, dbls.byteOffset, dbls.byteLength));
    u32(arrs.length);
    for (const a of arrs) { u32(dtypeOf(a)); u32(a.length); parts.push(Buffer.from(a.buffer, a.byteOffset, a.byteLength)); }
    return (await this.request(OP_ADD, Buffer.concat(parts))).readInt32LE(0);
  }

  /** One round: the records (REC bytes each) and their vals; returns the summaries, then the asked features. */
  step(n: number, recs: Buffer, vals: Float64Array): Promise<Buffer> {
    const head = Buffer.alloc(4); head.writeUInt32LE(n);
    const nv = Buffer.alloc(4); nv.writeUInt32LE(vals.length);
    return this.request(OP_STEP, Buffer.concat([head, recs, nv, Buffer.from(vals.buffer, vals.byteOffset, vals.byteLength)]));
  }

  /** A column's arrays in the pool, in kernelArrays' order. */
  async get(id: number): Promise<TypedArr[]> {
    const id4 = Buffer.alloc(4); id4.writeInt32LE(id);
    const b = await this.request(OP_GET, id4);
    let i = 0;
    const na = b.readUInt32LE(i); i += 4;
    const out: TypedArr[] = [];
    for (let k = 0; k < na; k++) {
      const dt = b.readUInt32LE(i), n = b.readUInt32LE(i + 4); i += 8;
      const es = [8, 4, 4, 1][dt], bytes = b.subarray(i, i + n * es); i += n * es;
      const copy = new Uint8Array(bytes).buffer;
      out.push(dt === 0 ? new Float64Array(copy) : dt === 1 ? new Float32Array(copy) : dt === 2 ? new Int32Array(copy) : new Uint8Array(copy));
    }
    return out;
  }

  async free(id: number): Promise<void> { const id4 = Buffer.alloc(4); id4.writeInt32LE(id); await this.request(OP_FREE, id4); }

  async close(): Promise<void> {
    if (!this.dead) { try { await this.request(OP_QUIT, Buffer.alloc(0)); } catch { /* gone */ } }
    this.proc.stdin.end();
  }
}

/** A member's network with its columns in the pool. */
class GpuMember {
  readonly ids = new Map<Column, number>();
  readonly sums = new Map<Column, Float64Array>();
  /** The host columns' rate vectors are the pool's (the last round asked for them, nothing stepped since). */
  fresh = false;
  constructor(readonly m: TapeMember) {}
  get net(): SnnNetwork { return this.m.net; }

  /** Uploads the columns the pool does not have yet (new inputs, a restored checkpoint); frees the ones gone. */
  async sync(pool: GpuPool): Promise<void> {
    const live = new Set(this.net.columns.values());
    for (const [c, id] of [...this.ids]) if (!live.has(c)) { await pool.free(id); this.ids.delete(c); this.sums.delete(c); }
    for (const c of live) if (!this.ids.has(c)) this.ids.set(c, await pool.add(c));
  }

  /** The pool's state of every column back into the host columns (checkpoints, the NaN guard's snapshots). */
  async pull(pool: GpuPool): Promise<void> {
    for (const [c, id] of this.ids) kernelLoad(c, await pool.get(id));
  }

  /** A summary into the host column: its scalars, and from the first one on, its mean rates, BCM threshold and NaN check. */
  take(c: Column, s: Float64Array, feat?: Float64Array): void {
    kernelScalars(c, s.subarray(0, NSC), s.subarray(NSC, NSC + NSI));
    let held = this.sums.get(c);
    if (!held) {
      held = new Float64Array(GSUM);
      this.sums.set(c, held);
      const h = held;
      Object.assign(c, {
        meanRateE: () => h[29], meanRateI: () => h[30], meanRateL0: () => h[31], bcmTheta: () => h[32], hasNaN: () => h[33] === 1,
      });
    }
    held.set(s);
    if (feat) {
      const p = this.net.p;
      c.rate2.set(feat.subarray(0, p.nE));
      c.rate1.set(feat.subarray(p.nE, p.nE + p.nL1));
      c.rate0.set(feat.subarray(p.nE + p.nL1, p.nE + p.nL1 + c.nL0));
    }
  }
}

type Rec = { g: GpuMember; c: Column; kind: number; first: boolean; frozen: boolean; want: number; inp?: ReturnType<typeof kernelInput>; latInh: number; dBrier: number; refRateE: number };

/** One device round: the records out, the summaries (and asked features) into their host columns. */
async function round(pool: GpuPool, recs: Rec[]): Promise<void> {
  if (!recs.length) return;
  const b = Buffer.alloc(recs.length * REC);
  const valsList: Float64Array[] = [];
  const valsAt = new Map<Float64Array, number>();
  let nv = 0;
  recs.forEach((r, k) => {
    const o = k * REC;
    let off = 0;
    if (r.inp) {
      const v = r.inp.vals;
      let at = valsAt.get(v);
      if (at === undefined) { at = nv; valsAt.set(v, at); valsList.push(v); nv += v.length; }
      off = at;
    }
    b.writeInt32LE(r.g.ids.get(r.c)!, o); b.writeInt32LE(r.kind, o + 4); b.writeInt32LE(r.first ? 1 : 0, o + 8); b.writeInt32LE(r.frozen ? 1 : 0, o + 12);
    b.writeInt32LE(r.want, o + 16); b.writeInt32LE(off, o + 20);
    b.writeDoubleLE(r.inp?.price ?? NaN, o + 24); b.writeDoubleLE(r.inp?.mid ?? NaN, o + 32); b.writeDoubleLE(r.latInh, o + 40);
    b.writeDoubleLE(r.dBrier, o + 48); b.writeDoubleLE(r.refRateE, o + 56);
  });
  const vals = new Float64Array(Math.max(1, nv));
  let at = 0;
  for (const v of valsList) { vals.set(v, at); at += v.length; }
  const out = await pool.step(recs.length, b, vals);
  const f = new Float64Array(new Uint8Array(out).buffer);
  let fi = recs.length * GSUM;
  recs.forEach((r, k) => {
    let feat: Float64Array | undefined;
    if (r.want & WANT_FEAT) { const nf = r.g.net.p.nE + r.g.net.p.nL1 + r.c.nL0; feat = f.subarray(fi, fi + nf); fi += nf; }
    r.g.take(r.c, f.subarray(k * GSUM, (k + 1) * GSUM), feat);
  });
}

/** Resets the columns' transient state in the pool (the long-gap and NaN-guard resets). */
async function resetRound(pool: GpuPool, gs: GpuMember[]): Promise<void> {
  const recs: Rec[] = [];
  for (const g of gs) for (const c of g.net.sortedColumns()) recs.push({ g, c, kind: 2, first: false, frozen: false, want: 0, latInh: 0, dBrier: 0, refRateE: 0 });
  await round(pool, recs);
  for (const g of gs) g.fresh = false;
}

/** Every member plays the tape at `file`, its columns in the pool: the same rows and networks as playSnnTape per member.
 *  The networks come back with the pool's final state loaded (checkpoints serialize as usual). */
export async function playSnnTapeGpu(file: string, members: PlayOpts[], pool: GpuPool): Promise<SnnReplayResult[]> {
  for (const o of members) { const bad = gpuUnsupported(o.params); if (bad.length) throw new Error(`member cannot play on the GPU: ${bad.join(', ')}`); }
  const gs = members.map((o) => new GpuMember(new TapeMember(o)));
  const it = readTape(file)[Symbol.iterator]();
  let next = it.next();
  try {
    while (!next.done) {
      const x: TapeOp = next.value;
      next = it.next();
      if (x.op === TAPE_OP.SETTLE) { for (const g of gs) g.m.settle(x); continue; }
      if (x.op === TAPE_OP.SCORE) {
        // Scoring reads the columns' rate vectors: fetched now for any member whose last round did not bring them.
        const stale = gs.filter((g) => !g.fresh);
        const recs: Rec[] = [];
        for (const g of stale) { await g.sync(pool); for (const c of g.net.sortedColumns()) recs.push({ g, c, kind: 0, first: false, frozen: false, want: WANT_FEAT, latInh: 0, dBrier: 0, refRateE: 0 }); }
        await round(pool, recs);
        for (const g of stale) g.fresh = true;
        for (const g of gs) g.m.score(x);
        continue;
      }
      // A step: plan every member (inputs and new columns), reset the ones after a long gap, then the rounds.
      const t0 = performance.now();
      const scoreNow = !next.done && next.value.op === TAPE_OP.SCORE && next.value.T === x.T;
      const plans = gs.map((g) => g.net.plan(x.T, x.inputs));
      for (const g of gs) await g.sync(pool);
      await resetRound(pool, gs.filter((_, i) => plans[i].reset));
      const rounds = Math.max(0, ...plans.map((p) => p.n));
      for (let k = 0; k < rounds; k++) {
        const recs: Rec[] = [];
        const stepping: { g: GpuMember; ts: number; cols: Column[] }[] = [];
        gs.forEach((g, i) => {
          const pl = plans[i];
          if (k >= pl.n) return;
          const net = g.net, ts = pl.t - (pl.n - 1 - k) * SNN_DT_MS, first = k === 0;
          const cols = net.sortedColumns(), ctx = net.stepContexts(cols);
          // The NaN check is read after the step that makes the count a multiple of 10; the rate vectors when the direction
          // heads sample this second, or the tape scores right after it.
          const want = ((net.steps + 1) % 10 === 0 ? WANT_NAN : 0) | (ts % (net.p.dirEverySec * 1000) === 0 || (scoreNow && ts === pl.t) ? WANT_FEAT : 0);
          cols.forEach((c, j) => {
            const inp = kernelInput(c, net.inputOf(c), first, ctx[j]);
            recs.push({ g, c, kind: 1, first, frozen: ctx[j].frozen, want, inp, latInh: ctx[j].latInh, dBrier: ctx[j].dBrier, refRateE: ctx[j].refRateE || 0 });
          });
          stepping.push({ g, ts, cols });
        });
        await round(pool, recs);
        const resets: GpuMember[] = [];
        for (const r of recs) r.g.fresh = (r.want & WANT_FEAT) !== 0;
        for (const { g, ts, cols } of stepping) {
          g.net.afterColumns(ts, cols);
          const a = g.net.nanAction(ts, () => cols.some((c) => c.hasNaN()));
          if (a === 'restore') g.net.restoreLastGood();
          else if (a === 'reset') resets.push(g);
          else if (a === 'snapshot') { await g.pull(pool); g.net.snapshotGood(ts); }
        }
        await resetRound(pool, resets);
        for (const g of gs) await g.sync(pool);
      }
      gs.forEach((g, i) => {
        if (plans[i].n > 0) g.net.lastTs = plans[i].t;
        g.m.stepped((performance.now() - t0) / gs.length);
      });
    }
    for (const g of gs) await g.pull(pool);
    return gs.map((g) => g.m.result());
  } finally {
    for (const g of gs) for (const id of g.ids.values()) { try { await pool.free(id); } catch { /* the pool is gone */ } }
  }
}

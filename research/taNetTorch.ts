// Bridge to the PyTorch TA network trainer (python/tanet/server.py): one Python process per ta_net step, JSON lines
// over stdin / stdout. The tournament (research/trainTaNet.ts, research/pbt.ts) stays here; only a member's training
// epochs and its forecasts run in Python, on the GPU when there is one (CUDA), on the CPU's math library otherwise.
// Weights and AdamW moments cross unchanged (the same flat layout, sent from here), so a tournament can switch engines
// mid-way and the live bot keeps running the network in TypeScript.
//
//   TA_NET_ENGINE  ts (default) | torch | auto (torch when a Python with PyTorch is found, else TypeScript)
//   TA_NET_PYTHON  the Python interpreter (the laptop trainer sets its own environment's; default python3 / python)

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { branchForward, branchLayout, fractalPlan, fractalSpecs, initBranchParams, type BranchDims } from '../bot/ta/branchNet';
import type { TaNetParams } from '../bot/ta/taNet';

export type TaNetEngine = 'ts' | 'torch' | 'auto';

/** server.py: next to the bundle (the trainer package: app/python/tanet), else the repository's. */
export function serverScript(entry = process.argv[1] ?? ''): string | undefined {
  const cands = [path.resolve(path.dirname(entry), '..', 'python', 'tanet', 'server.py'), path.resolve('python', 'tanet', 'server.py')];
  return cands.find((c) => fs.existsSync(c));
}

const b64f64 = (a: Float64Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const b64i32 = (a: Int32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const f64 = (s: string) => { const b = Buffer.from(s, 'base64'); return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const f32 = (s: string) => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

export interface TorchMember { w: Float64Array; m: Float64Array; v: Float64Array; step: number }

export class TaNetTorch {
  private buf = '';
  private waiting: Array<{ resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }> = [];
  private dead?: string;
  info: { device: string; name: string; torch: string } = { device: '?', name: '?', torch: '?' };

  private constructor(private readonly child: ChildProcess, private readonly log: (m: string) => void) {
    child.stdout!.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8');
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        let r: Record<string, unknown>;
        try { r = JSON.parse(line) as Record<string, unknown>; } catch { if (line) this.log(line); continue; } // not a reply
        const w = this.waiting.shift();
        if (!w) continue;
        if (r.ok) w.resolve(r); else w.reject(new Error(String(r.error)));
      }
    });
    let err = '';
    child.stderr!.on('data', (d: Buffer) => { err += d.toString('utf8'); let i: number; while ((i = err.indexOf('\n')) >= 0) { const l = err.slice(0, i); err = err.slice(i + 1); if (l.trim()) this.log(l.trim()); } });
    const fail = (why: string) => { this.dead = why; for (const w of this.waiting.splice(0)) w.reject(new Error(why)); };
    child.stdin!.on('error', () => undefined); // a process that never started: reported by 'error' below
    child.on('exit', (code) => fail(`the torch trainer exited (${code})`));
    child.on('error', (e) => fail(`the torch trainer could not start: ${e.message}`));
  }

  static start(o: { python?: string; script?: string; log?: (m: string) => void } = {}): TaNetTorch {
    const script = o.script ?? serverScript();
    if (!script) throw new Error('python/tanet/server.py not found');
    const python = o.python || process.env.TA_NET_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const child = spawn(python, ['-u', script], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true });
    return new TaNetTorch(child, o.log ?? (() => undefined));
  }

  /** One request, one reply. No reply within `timeoutMs` (a hung driver, a stuck process): the process is ended and
   *  every waiting request fails (the trainer continues in TypeScript). */
  private ask(req: Record<string, unknown>, timeoutMs = TaNetTorch.TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.dead = `the torch trainer did not answer within ${Math.round(timeoutMs / 60_000)} min (${String(req.type)})`; for (const w of this.waiting.splice(0)) w.reject(new Error(this.dead)); this.child.kill(); }, timeoutMs);
      timer.unref?.();
      this.waiting.push({ resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.child.stdin!.write(JSON.stringify(req) + '\n');
    });
  }

  /** Longest wait for one reply (a member's round of epochs on a slow CPU fits well inside it). */
  static TIMEOUT_MS = 3 * 3_600_000;

  /** Load the network layout (and the training pack, when given) into the server. */
  async init(o: { dims: BranchDims; norm?: TaNetParams['norm']; pack?: string; device?: 'auto' | 'cpu' | 'cuda'; dtype?: 'float32' | 'float64'; /** CUDA graphs (default on; 'emulate': the same path without a GPU, tests) */ graphs?: boolean | 'emulate'; resident?: boolean }): Promise<void> {
    const fs2 = fractalSpecs(o.dims);
    const r = await this.ask({ type: 'init', dims: o.dims, layout: branchLayout(o.dims).layout, plans: { micro: fractalPlan(fs2.micro), swing: fractalPlan(fs2.swing) }, norm: o.norm, pack: o.pack, device: o.device ?? 'auto', dtype: o.dtype ?? 'float32', graphs: o.graphs ?? true, resident: o.resident ?? false });
    this.info = { device: String(r.device), name: String(r.name), torch: String(r.torch) };
  }

  /** `epochs` of mini-batch AdamW over the samples `idx` (research/trainTaNet.ts trainEpoch's update). */
  async train(s: TorchMember, hyper: Record<string, number>, idx: number[], seed: number, epochs: number, batch = 64): Promise<TorchMember & { loss: number; secs: number; samples: number; graph: boolean }> {
    const r = await this.ask({ type: 'train', w: b64f64(s.w), m: b64f64(s.m), v: b64f64(s.v), step: s.step, hyper, idx: b64i32(Int32Array.from(idx)), seed, epochs, batch });
    return { w: f64(String(r.w)), m: f64(String(r.m)), v: f64(String(r.v)), step: Number(r.step), loss: Number(r.loss), secs: Number(r.secs), samples: Number(r.samples), graph: r.graph === true };
  }

  /** Raw outputs (logit up 1h, logit up 4h, vol) per sample, n x 3. */
  async forecast(w: Float64Array, gates: [number, number, number, number, number], idx: number[]): Promise<Float32Array> {
    const r = await this.ask({ type: 'forecast', w: b64f64(w), gates, idx: b64i32(Int32Array.from(idx)) });
    return f32(String(r.out));
  }

  /** Tests: forward / gradient on explicit, already normalised inputs (b samples, row-major per field). */
  async forward(w: Float64Array, x: Record<'micro' | 'swing' | 'trend' | 'macro' | 'ctx', Float64Array>, b: number, scale: Float64Array, mmask?: Float64Array, smask?: Float64Array): Promise<Float64Array> {
    const r = await this.ask({ type: 'forward', w: b64f64(w), x: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, b64f64(v)])), b, scale: b64f64(scale), mmask: mmask && b64f64(mmask), smask: smask && b64f64(smask) });
    return f64(String(r.out));
  }
  async grad(w: Float64Array, x: Record<'micro' | 'swing' | 'trend' | 'macro' | 'ctx', Float64Array>, b: number, scale: Float64Array, y: Float64Array, volWeight: number, mmask?: Float64Array, smask?: Float64Array): Promise<{ grad: Float64Array; loss: number }> {
    const r = await this.ask({ type: 'grad', w: b64f64(w), x: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, b64f64(v)])), b, scale: b64f64(scale), y: b64f64(y), volWeight, mmask: mmask && b64f64(mmask), smask: smask && b64f64(smask) });
    return { grad: f64(String(r.grad)), loss: Number(r.loss) };
  }

  async close(): Promise<void> {
    if (this.dead) return;
    try { this.child.stdin!.write(JSON.stringify({ type: 'quit' }) + '\n'); } catch { /* gone */ }
    await new Promise<void>((res) => { const t = setTimeout(() => { this.child.kill(); res(); }, 5000); this.child.once('exit', () => { clearTimeout(t); res(); }); });
  }
}

/** A small network through the torch trainer and through TypeScript: the largest output difference (on the device
 *  training will use, in float32). Checks the Python, PyTorch, the GPU and this bridge before a tournament relies
 *  on them. */
export async function torchSelfTest(o: { python?: string; script?: string; log?: (m: string) => void } = {}): Promise<{ device: string; name: string; torch: string; maxDiff: number }> {
  const dims: BranchDims = { mT: 8, mF: 3, mC: 4, sT: 10, sF: 3, sC: 4, fDepth: 3, tT: 4, tF: 6, tH: 5, dT: 5, dF: 4, dE: 4, cF: 7, cH: 3, hM: 6, nOut: 3 };
  let s = 12345;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const w = initBranchParams(dims, 5);
  for (let i = 0; i < w.length; i++) w[i] += r() * 0.2;
  const B = 4;
  const field = (n: number) => Float64Array.from({ length: B * n }, () => r() * 3);
  const x = { micro: field(dims.mT * dims.mF), swing: field(dims.sT * dims.sF), trend: field(dims.tT * dims.tF), macro: field(dims.dT * dims.dF), ctx: field(dims.cF) };
  const gates = { micro: 1.2, swing: 0.8, trend: 1, macro: 1.1, ctx: 0.9 };
  const scale = new Float64Array(B * 5);
  for (let b = 0; b < B; b++) scale.set([gates.micro, gates.swing, gates.trend, gates.macro, gates.ctx], b * 5);
  const t = TaNetTorch.start(o);
  try {
    await t.init({ dims, device: 'auto', dtype: 'float32' });
    const out = await t.forward(w, x, B, scale);
    const L = branchLayout(dims).layout;
    let maxDiff = 0;
    for (let b = 0; b < B; b++) {
      const sl = (a: Float64Array, n: number) => a.subarray(b * n, (b + 1) * n);
      const f = branchForward(dims, w, gates, { micro: sl(x.micro, dims.mT * dims.mF), swing: sl(x.swing, dims.sT * dims.sF), trend: sl(x.trend, dims.tT * dims.tF), macro: sl(x.macro, dims.dT * dims.dF), ctx: sl(x.ctx, dims.cF) }, L).out;
      for (let k = 0; k < dims.nOut; k++) maxDiff = Math.max(maxDiff, Math.abs(out[b * dims.nOut + k] - f[k]));
    }
    return { ...t.info, maxDiff };
  } finally { await t.close(); }
}

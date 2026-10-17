// The decision models' small MLPs (research/mlp.ts train) fitted in PyTorch (python/mlp/fit.py), on the GPU when there
// is one: the same algorithm and initial weights as the TypeScript trainer, and weights back in the same DenseLayer
// layout, so the live bot runs them unchanged. A trainer sends its rows once and then batches of fits (every fold of
// every candidate at once).
//
//   MLP_ENGINE  auto (default: PyTorch when a Python with it starts, else TypeScript) | torch | ts
//   MLP_PYTHON  the interpreter (default TA_NET_PYTHON: the laptop trainer's, else python3 / python)

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DenseLayer } from '../bot/model/metaModel';
import { initLayers, train, type Normalization, type TrainOptions } from './mlp';

export interface TorchFitJob {
  train: number[]; val: number[];
  /** Columns of the uploaded matrix, in the model's feature order. */
  cols: number[];
  /** Position in `cols` of the column added raw to the logit (-1: none). */
  residual: number;
  hidden: number; l2: number; lr: number; maxEpochs: number; patience: number;
  /** Initial hidden-layer weights (hidden x cols, row-major), from the TypeScript trainer's seeded generator. */
  init?: Float64Array;
  /** Training-row weights (default: the uploaded weights). */
  wTrain?: number[];
}
export interface TorchFit { layers: DenseLayer[]; norm: Normalization; valLoss: number; epochs: number }

/** fit.py: next to the bundle (the trainer package: app/python/mlp), else the repository's. */
export function fitScript(entry = process.argv[1] ?? ''): string | undefined {
  return [path.resolve(path.dirname(entry), '..', 'python', 'mlp', 'fit.py'), path.resolve('python', 'mlp', 'fit.py')].find((c) => fs.existsSync(c));
}

export class MlpTorch {
  private buf = '';
  private waiting: Array<{ resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }> = [];
  private dead?: string;
  private tmp?: string;
  device = '?';

  private constructor(private readonly child: ChildProcess, private readonly log: (m: string) => void) {
    child.stdout!.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8');
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        let r: Record<string, unknown>;
        try { r = JSON.parse(line) as Record<string, unknown>; } catch { if (line) this.log(line); continue; }
        const w = this.waiting.shift();
        if (w) { if (r.ok) w.resolve(r); else w.reject(new Error(String(r.error))); }
      }
    });
    child.stderr!.on('data', (d: Buffer) => { for (const l of d.toString('utf8').split('\n')) if (l.trim()) this.log(l.trim()); });
    const fail = (why: string) => { this.dead = why; for (const w of this.waiting.splice(0)) w.reject(new Error(why)); };
    child.stdin!.on('error', () => undefined);
    child.on('exit', (code) => fail(`the PyTorch MLP trainer exited (${code})`));
    child.on('error', (e) => fail(`the PyTorch MLP trainer could not start: ${e.message}`));
  }

  /** A trainer per MLP_ENGINE, or undefined (TypeScript): auto falls back quietly, torch says why. */
  static async start(o: { log?: (m: string) => void; engine?: string; python?: string } = {}): Promise<MlpTorch | undefined> {
    const log = o.log ?? (() => undefined);
    const engine = o.engine ?? process.env.MLP_ENGINE ?? 'auto';
    if (engine === 'ts') return undefined;
    const script = fitScript();
    if (!script) { if (engine === 'torch') log('MLP_ENGINE=torch but python/mlp/fit.py is missing: TypeScript'); return undefined; }
    const python = o.python || process.env.MLP_PYTHON || process.env.TA_NET_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const t = new MlpTorch(spawn(python, ['-u', script], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true }), log);
    try {
      const r = await t.ask({ type: 'init' }, 120_000);
      t.device = `${r.device}${r.name && r.name !== 'cpu' ? ` (${r.name})` : ''}, PyTorch ${r.torch}`;
      return t;
    } catch (e) {
      if (engine === 'torch') log(`PyTorch MLP trainer unavailable (${(e as Error).message}): TypeScript`);
      await t.close();
      return undefined;
    }
  }

  private ask(req: Record<string, unknown>, timeoutMs = 6 * 3_600_000): Promise<Record<string, unknown>> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.dead = `the PyTorch MLP trainer did not answer within ${Math.round(timeoutMs / 60_000)} min`; for (const w of this.waiting.splice(0)) w.reject(new Error(this.dead)); this.child.kill(); }, timeoutMs);
      timer.unref?.();
      this.waiting.push({ resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.child.stdin!.write(JSON.stringify(req) + '\n');
    });
  }

  /** The rows every later fit indexes into (NaN = missing), their labels and weights. */
  async setData(X: number[][], y: number[], w: number[]): Promise<void> {
    this.tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), 'mlp-torch-'));
    const cols = X[0]?.length ?? 0, flat = new Float32Array(X.length * cols);
    X.forEach((row, i) => flat.set(row, i * cols));
    const f = (name: string, a: Float32Array) => { const p = path.join(this.tmp!, name); fs.writeFileSync(p, Buffer.from(a.buffer, a.byteOffset, a.byteLength)); return p; };
    await this.ask({ type: 'data', x: f('x.f32', flat), rows: X.length, cols, y: f('y.f32', Float32Array.from(y)), w: f('w.f32', Float32Array.from(w)) });
  }

  async fit(jobs: TorchFitJob[]): Promise<TorchFit[]> {
    const b64 = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
    const r = await this.ask({ type: 'fit', jobs: jobs.map((j) => ({ ...j, train: b64(Int32Array.from(j.train)), val: b64(Int32Array.from(j.val)), init: j.init ? b64(j.init) : undefined, wTrain: j.wTrain ? b64(Float32Array.from(j.wTrain)) : undefined })) });
    return (r.results as Array<{ layers: DenseLayer[]; mean: number[]; std: number[]; valLoss: number; epochs: number }>).map((x) => ({ layers: x.layers, norm: { mean: x.mean, std: x.std }, valLoss: x.valLoss, epochs: x.epochs }));
  }

  async close(): Promise<void> {
    try { this.child.stdin!.end(); } catch { /* gone */ }
    if (this.tmp) fs.rmSync(this.tmp, { recursive: true, force: true });
    this.child.kill();
  }
}

/** research/mlp.ts train() through `torch` when given (the same arguments and result), else in TypeScript. */
export async function trainMlp(torch: MlpTorch | undefined, X: number[][], y: number[], Xval: number[][], yval: number[], o: TrainOptions, w?: number[], wval?: number[], log?: (m: string) => void): Promise<{ layers: DenseLayer[]; norm: Normalization; valLoss: number; epochs: number }> {
  if (torch && X.length) {
    try {
      await torch.setData([...X, ...Xval], [...y, ...yval], [...(w ?? X.map(() => 1)), ...(wval ?? Xval.map(() => 1))]);
      const d = X[0].length, idx = (n: number, from: number) => Array.from({ length: n }, (_, i) => from + i);
      const [r] = await torch.fit([{ train: idx(X.length, 0), val: idx(Xval.length, X.length), cols: idx(d, 0), residual: o.residual, hidden: o.hidden, l2: o.l2, lr: o.lr, maxEpochs: o.maxEpochs, patience: o.patience, init: o.hidden > 0 ? Float64Array.from(initLayers(d, o.hidden, o.seed)[0].weights.flat()) : undefined }]);
      return r;
    } catch (e) { log?.(`PyTorch MLP fit failed (${(e as Error).message}): TypeScript`); }
  }
  return train(X, y, Xval, yval, o, w, wval);
}

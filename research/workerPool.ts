// A fixed pool of worker threads running one script, for research jobs that are independent and
// CPU-bound (tournament members replaying recordings). Each task goes to the next free worker; a worker
// that dies is replaced. In production bundles the script is a .cjs next to the bundle; under tsx a small
// bootstrap (research/workerDev.mjs) registers the TypeScript loader in the thread first.

import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { Worker } from 'worker_threads';

export function workerScript(name: string, entry = process.argv[1] ?? ''): { path: string; workerData?: unknown } {
  if (entry.endsWith('.cjs')) return { path: path.join(path.dirname(entry), `${name}.cjs`) };
  return { path: path.resolve('research', 'workerDev.mjs'), workerData: { entry: pathToFileURL(path.resolve('research', `${name}.ts`)).href } };
}

/** Worker threads to use: TRAIN_WORKERS, else 1 (the laptop trainer sets one per core but one). */
export function workerCount(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TRAIN_WORKERS ?? 1);
  return Math.max(1, Math.min(Number.isFinite(n) ? Math.floor(n) : 1, Math.max(1, os.cpus().length)));
}

export class WorkerPool<I, O> {
  private readonly idle: Worker[] = [];
  private readonly queue: Array<{ input: I; resolve: (o: O) => void; reject: (e: Error) => void }> = [];
  private readonly all = new Set<Worker>();
  constructor(private readonly script: { path: string; workerData?: unknown }, private readonly size: number) {}

  run(input: I): Promise<O> {
    return new Promise<O>((resolve, reject) => { this.queue.push({ input, resolve, reject }); this.pump(); });
  }

  private spawn(): Worker {
    const w = new Worker(this.script.path, { workerData: this.script.workerData, env: process.env });
    this.all.add(w);
    return w;
  }

  private pump(): void {
    while (this.queue.length && (this.idle.length || this.all.size < this.size)) {
      const w = this.idle.pop() ?? this.spawn();
      const job = this.queue.shift()!;
      const done = () => { w.off('message', onMsg); w.off('error', onErr); w.off('exit', onExit); };
      const onMsg = (m: { ok: boolean; out?: O; error?: string }) => { done(); this.idle.push(w); m.ok ? job.resolve(m.out as O) : job.reject(new Error(m.error)); this.pump(); };
      const onErr = (e: Error) => { done(); this.all.delete(w); job.reject(e); this.pump(); };
      const onExit = (code: number) => { done(); this.all.delete(w); job.reject(new Error(`worker exited with ${code}`)); this.pump(); };
      w.on('message', onMsg); w.once('error', onErr); w.once('exit', onExit);
      w.postMessage(job.input);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.all].map((w) => w.terminate()));
    this.all.clear(); this.idle.length = 0;
  }
}

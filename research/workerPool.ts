// A fixed pool of worker threads running one script, for research jobs that are independent and
// CPU-bound (tournament members replaying recordings). Each task goes to the next free worker; a worker
// that dies is replaced. In production bundles the script is a .cjs next to the bundle; under tsx a small
// bootstrap (research/workerDev.mjs) registers the TypeScript loader in the thread first.
//
// On the laptop trainer (research/trainerResources.ts) the pool also keeps the computer usable: each worker's heap is
// capped (TRAIN_WORKER_HEAP_MB; a job that runs out of it is run again on a fresh worker with twice the room, up to
// 8 GB, so the cap stops a runaway without failing a step that needs more), it starts no new work while free memory
// is below TRAIN_MIN_FREE_MB (one job always runs, so it never stalls), and it follows the governor's throttle file
// (TRAIN_THROTTLE_FILE): fewer jobs at once while you use the computer or memory is short, and idle workers above
// that are let go to free their memory.

import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import v8 from 'v8';
import { Worker } from 'worker_threads';
import { readThrottle } from './trainerResources';

// A process-wide --max-old-space-size (NODE_OPTIONS) overrides every worker's own heap cap: each worker could then
// grow to the main process's size. The main heap keeps the size it started with; clearing the flag once lets the
// workers' caps apply.
let heapFlagCleared = false;
function allowWorkerHeapCaps(): void {
  if (heapFlagCleared) return;
  heapFlagCleared = true;
  try { v8.setFlagsFromString('--max-old-space-size=0'); } catch { /* the caps then follow the flag */ }
}

export function workerScript(name: string, entry = process.argv[1] ?? ''): { path: string; workerData?: unknown } {
  if (entry.endsWith('.cjs')) return { path: path.join(path.dirname(entry), `${name}.cjs`) };
  return { path: path.resolve('research', 'workerDev.mjs'), workerData: { entry: pathToFileURL(path.resolve('research', `${name}.ts`)).href } };
}

/** Worker threads to use: TRAIN_WORKERS, else 1 (the laptop trainer sets one per core but one). */
export function workerCount(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TRAIN_WORKERS ?? 1);
  return Math.max(1, Math.min(Number.isFinite(n) ? Math.floor(n) : 1, Math.max(1, os.cpus().length)));
}

/** Worker threads for the TA network's row rebuild (trainTaNet.ts computeRowsInWorkers, which also caps them by free
 *  memory): TA_ROW_WORKERS when set (the remote runner: one per core), else TRAIN_WORKERS. */
export function taRowWorkerCount(env: NodeJS.ProcessEnv = process.env): number {
  return env.TA_ROW_WORKERS ? workerCount({ ...env, TRAIN_WORKERS: env.TA_ROW_WORKERS }) : workerCount(env);
}

export class WorkerPool<I, O> {
  private readonly idle: Worker[] = [];
  private readonly queue: Array<{ input: I; resolve: (o: O) => void; reject: (e: Error) => void; /** A retry's heap (MB). */ heapMb?: number }> = [];
  private readonly all = new Set<Worker>();
  private recheck?: NodeJS.Timeout;
  constructor(private readonly script: { path: string; workerData?: unknown }, private readonly size: number, private readonly env: NodeJS.ProcessEnv = process.env) {}

  run(input: I): Promise<O> {
    return new Promise<O>((resolve, reject) => { this.queue.push({ input, resolve, reject }); this.pump(); });
  }

  private heapMb(): number { const h = Number(this.env.TRAIN_WORKER_HEAP_MB); return h > 0 ? h : 0; }

  private spawn(heap = this.heapMb()): Worker {
    if (heap > 0) allowWorkerHeapCaps();
    const w = new Worker(this.script.path, { workerData: this.script.workerData, env: this.env, ...(heap > 0 ? { resourceLimits: { maxOldGenerationSizeMb: heap } } : {}) });
    this.all.add(w);
    return w;
  }

  /** Jobs that may run at once now: the pool's size, the governor's throttle, and free memory (never below one). */
  limit(busy: number): number {
    const t = readThrottle(this.env.TRAIN_THROTTLE_FILE);
    let n = Math.max(1, Math.min(this.size, t ? t.workers : this.size));
    const floor = Number(this.env.TRAIN_MIN_FREE_MB);
    if (floor > 0 && os.freemem() / 1048576 < floor) n = Math.max(1, Math.min(n, busy));
    return n;
  }

  private pump(): void {
    const busy = () => this.all.size - this.idle.length;
    const n = this.limit(busy());
    // Throttled: let idle workers above the limit go (their memory comes back).
    while (this.idle.length && this.all.size > n) { const w = this.idle.pop()!; this.all.delete(w); void w.terminate(); }
    while (this.queue.length && busy() < n && (this.idle.length || this.all.size < this.size)) {
      const job = this.queue.shift()!;
      // A job that ran out of memory: a fresh worker with its bigger heap (an idle one makes room for it).
      if (job.heapMb && this.all.size >= this.size) { const x = this.idle.pop()!; this.all.delete(x); void x.terminate(); }
      const w = job.heapMb ? this.spawn(job.heapMb) : this.idle.pop() ?? this.spawn();
      const done = () => { w.off('message', onMsg); w.off('error', onErr); w.off('exit', onExit); };
      const onMsg = (m: { ok: boolean; out?: O; error?: string }) => { done(); this.idle.push(w); m.ok ? job.resolve(m.out as O) : job.reject(new Error(m.error)); this.pump(); };
      const onErr = (e: Error & { code?: string }) => {
        done(); this.all.delete(w);
        const heap = job.heapMb ?? this.heapMb();
        if (e.code === 'ERR_WORKER_OUT_OF_MEMORY' && heap > 0 && heap < 8192) this.queue.unshift({ ...job, heapMb: Math.min(8192, heap * 2) });
        else job.reject(e.code === 'ERR_WORKER_OUT_OF_MEMORY' && heap > 0 ? new Error(`a worker ran out of its ${heap} MB of memory: ${e.message}`) : e);
        this.pump();
      };
      const onExit = (code: number) => { done(); this.all.delete(w); job.reject(new Error(`worker exited with ${code}`)); this.pump(); };
      w.on('message', onMsg); w.once('error', onErr); w.once('exit', onExit);
      w.postMessage(job.input);
    }
    // Work waiting behind the throttle or the memory floor: look again shortly.
    if (this.queue.length && !this.recheck) this.recheck = setTimeout(() => { this.recheck = undefined; this.pump(); }, 2000);
  }

  async close(): Promise<void> {
    if (this.recheck) { clearTimeout(this.recheck); this.recheck = undefined; }
    await Promise.all([...this.all].map((w) => w.terminate()));
    this.all.clear(); this.idle.length = 0;
  }
}

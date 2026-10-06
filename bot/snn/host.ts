// Main-thread side of the SNN: a worker_threads Worker owns all network state; this host sends
// the 1 s inputs, requests batched readouts with a hard 200 ms timeout (on timeout the blender
// uses alpha = 0 for that tick), tracks latency p99 (> 150 ms -> skip the SNN vote), forwards
// settlements, and writes versioned checkpoints with rollback (every N minutes and at shutdown).
// Without a worker (tests, or if the worker fails to start) the same runtime runs in-process.

import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';
import { logger } from '../util/log';
import type { ColumnInput, ContractQuery, SnnCheckpoint, SnnModelFile } from './network';
import { versionHash, type SnnParams } from './params';
import { SnnRuntime, type SnnReply, type SnnRequest, type StepReply } from './runtime';

const log = logger('snn');

export interface SnnHostOpts {
  params: SnnParams;
  whitelist?: string[];
  model?: SnnModelFile;
  /** Worker script; undefined => in-process runtime. */
  worker?: { path: string; execArgv?: string[] };
  timeoutMs: number;
  latencySkipP99Ms: number;
  checkpointDir?: string;
  checkpointEveryMin: number;
  keepCheckpoints: number;
  /** Start from this state instead of the newest checkpoint on disk (a tournament clone), accepted
   *  even though its hyperparameters differ (same shapes). */
  seedCheckpoint?: SnnCheckpoint;
}

/** What the engine needs from a network host: one SnnHost, or the tennis population (population.ts). */
export interface SnnHostLike {
  readonly version: string;
  readonly mode: string;
  timeouts: number;
  lastError?: string;
  restoredFrom?: string | null;
  start(now?: number): Promise<void>;
  stepAndScore(now: number, inputs: ColumnInput[], queries: ContractQuery[]): Promise<StepReply | undefined>;
  p99(): number;
  latencyOk(): boolean;
  /** Share of the worker thread's time spent busy since the previous call (null without a worker). */
  utilization?(): number | null;
  settle(ticker: string, result: 'yes' | 'no', now: number): Promise<void>;
  remove(keys: string[]): Promise<void>;
  status(): Promise<unknown>;
  checkpoint(now?: number): Promise<string | undefined>;
  stop(now?: number): Promise<void>;
}

type Req = SnnRequest extends infer T ? (T extends { id: number } ? Omit<T, 'id'> : never) : never;

export class SnnHost implements SnnHostLike {
  private worker?: Worker;
  private readonly local = new SnnRuntime();
  private seq = 0;
  private readonly waiting = new Map<number, (r: SnnReply) => void>();
  private busy = false;
  private readonly lat: number[] = [];
  private lastCheckpoint = 0;
  timeouts = 0;
  lastError?: string;
  restoredFrom?: string | null;
  readonly version: string;

  constructor(private readonly o: SnnHostOpts) {
    this.version = versionHash(o.params);
  }

  get mode(): 'worker' | 'in-process' { return this.worker ? 'worker' : 'in-process'; }

  async start(now = Date.now()): Promise<void> {
    if (this.o.worker) {
      try {
        this.worker = new Worker(this.o.worker.path, { execArgv: this.o.worker.execArgv });
        this.worker.on('message', (r: SnnReply) => { const f = this.waiting.get(r.id); this.waiting.delete(r.id); f?.(r); });
        this.worker.on('error', (e) => { this.lastError = `worker: ${e.message}`; log.error('snn worker error', { error: e.message }); this.worker = undefined; });
        this.worker.unref();
      } catch (e) {
        this.lastError = `worker failed to start, running in-process: ${(e as Error).message}`;
        this.worker = undefined;
      }
    }
    const seeded = this.o.seedCheckpoint;
    const cp = this.loadCheckpoint() ?? seeded;
    const r = await this.call({ type: 'init', params: this.o.params, whitelist: this.o.whitelist, model: this.o.model, checkpoint: cp, allowParamChange: Boolean(seeded) && cp === seeded }, 30_000);
    if (!r?.ok) throw new Error(`SNN init failed: ${r && !r.ok ? r.error : 'timeout'}`);
    this.restoredFrom = (r.result as { restoredFrom: string | null }).restoredFrom;
    this.lastCheckpoint = now;
  }

  private call(req: Req, timeoutMs: number): Promise<SnnReply | undefined> {
    const id = ++this.seq;
    const msg = { ...req, id } as SnnRequest;
    if (!this.worker) return Promise.resolve(this.local.handle(msg));
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.waiting.delete(id); resolve(undefined); }, timeoutMs);
      this.waiting.set(id, (r) => { clearTimeout(t); resolve(r); });
      this.worker!.postMessage(msg);
    });
  }

  /** Advance the clock and score candidates. undefined on timeout, while busy, or on error: the
   *  caller then blends with alpha = 0. */
  async stepAndScore(now: number, inputs: ColumnInput[], queries: ContractQuery[]): Promise<StepReply | undefined> {
    if (this.busy) return undefined;
    this.busy = true;
    const t0 = performance.now();
    try {
      const r = await this.call({ type: 'step', now, inputs, queries }, this.o.timeoutMs);
      const ms = performance.now() - t0;
      this.lat.push(r ? ms : this.o.timeoutMs);
      if (this.lat.length > 600) this.lat.shift();
      if (!r) { this.timeouts++; return undefined; }
      if (!r.ok) { this.lastError = r.error; return undefined; }
      return r.result as StepReply;
    } finally {
      this.busy = false;
      if (this.o.checkpointDir && now - this.lastCheckpoint >= this.o.checkpointEveryMin * 60_000) { this.lastCheckpoint = now; void this.checkpoint(now); }
    }
  }

  /** Latency p99 over the last ~10 minutes of requests (ms). */
  p99(): number {
    if (!this.lat.length) return 0;
    const s = [...this.lat].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(0.99 * s.length))];
  }

  private elu?: ReturnType<Worker['performance']['eventLoopUtilization']>;
  utilization(): number | null {
    if (!this.worker) return null;
    const now = this.worker.performance.eventLoopUtilization();
    const d = this.elu ? this.worker.performance.eventLoopUtilization(now, this.elu) : now;
    this.elu = now;
    return +d.utilization.toFixed(3);
  }

  /** The vote is skipped while latency p99 exceeds its band. */
  latencyOk(): boolean { return this.p99() <= this.o.latencySkipP99Ms; }

  async settle(ticker: string, result: 'yes' | 'no', now: number): Promise<void> {
    await this.call({ type: 'settle', ticker, result, now }, 5_000);
  }

  /** Drop columns (tennis matches that ended). */
  async remove(keys: string[]): Promise<void> {
    if (keys.length) await this.call({ type: 'remove', keys }, 5_000);
  }

  async status(): Promise<unknown> {
    const r = await this.call({ type: 'status' }, 2_000);
    return r?.ok ? r.result : { error: r ? r.error : 'timeout' };
  }

  async checkpoint(now = Date.now()): Promise<string | undefined> {
    if (!this.o.checkpointDir) return undefined;
    const r = await this.call({ type: 'checkpoint' }, 30_000);
    if (!r?.ok) { this.lastError = `checkpoint: ${r && !r.ok ? r.error : 'timeout'}`; return undefined; }
    const file = path.join(this.o.checkpointDir, `snn-${this.version}-${now}.json`);
    fs.mkdirSync(this.o.checkpointDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(r.result), { mode: 0o600 });
    fs.renameSync(tmp, file);
    // Keep the newest N versioned files (older ones are the rollback history).
    const all = this.checkpointFiles();
    for (const f of all.slice(this.o.keepCheckpoints)) fs.rmSync(path.join(this.o.checkpointDir, f), { force: true });
    return file;
  }

  private checkpointFiles(): string[] {
    if (!this.o.checkpointDir || !fs.existsSync(this.o.checkpointDir)) return [];
    return fs.readdirSync(this.o.checkpointDir).filter((f) => f.startsWith(`snn-${this.version}-`) && f.endsWith('.json'))
      .sort((a, b) => Number(b.split('-').pop()!.slice(0, -5)) - Number(a.split('-').pop()!.slice(0, -5)));
  }

  /** Current network state (for cloning into another member). */
  async snapshot(): Promise<SnnCheckpoint | undefined> {
    const r = await this.call({ type: 'checkpoint' }, 30_000);
    return r?.ok ? (r.result as SnnCheckpoint) : undefined;
  }

  /** Newest readable checkpoint of this version; a corrupt file rolls back to the previous one. */
  loadCheckpoint(): SnnCheckpoint | undefined {
    for (const f of this.checkpointFiles()) {
      try {
        const cp = JSON.parse(fs.readFileSync(path.join(this.o.checkpointDir!, f), 'utf8')) as SnnCheckpoint;
        if (cp.version === this.version) return cp;
      } catch (e) {
        log.warn('snn checkpoint unreadable, rolling back', { file: f, error: String(e) });
      }
    }
    return undefined;
  }

  async stop(now = Date.now()): Promise<void> {
    await this.checkpoint(now);
    await this.worker?.terminate();
    this.worker = undefined;
  }
}

// GPU groups next to the CPU workers in an SNN tournament (research/snnPbt.ts). Each round's members replaying one tape
// are shared out: a group of them plays the tape together with their columns on the GPU (research/snnGpu.ts, in a worker
// thread of its own: research/snnReplayWorker.ts), the rest play it one per CPU worker as before. Every member's rows and
// network are the same bits either way (tests/snnGpu.test.ts), so the split changes only how long a round takes.
//
// The split: with Q members waiting, C CPU workers and a GPU group worth r CPU cores (members per second, measured on
// the rounds so far; SNN_GPU_SPEEDUP before the first), the group takes Q r / (C + r) of them, so both sides finish
// about together.
//
//   SNN_GPU          auto (default: on when the laptop trainer's PyTorch sees a CUDA GPU), true, or false
//   SNN_GPU_GROUP    most members in one GPU group (default 16)
//   SNN_GPU_GROUPS   GPU groups at once, each with its own worker thread and device pool (default: what SnnGpuBench.cmd
//                    found best on this computer, trainer-data/snn-gpu-bench.json; else 1)
//   SNN_GPU_SPEEDUP  a GPU group member's speed in CPU cores before one is measured (default: the bench's, else 2)

import fs from 'fs';
import path from 'path';
import { gpuUnsupported } from './snnGpu';
import type { SnnGpuJob, SnnGpuOut, SnnGpuSpec, SnnReplayJob, SnnReplayOut } from './snnReplayWorker';

interface Runner<I, O> { run(input: I): Promise<O> }

/** The device pool the tournaments may use: the laptop trainer's PyTorch (TA_NET_PYTHON) unless SNN_GPU=false. */
export function snnGpuSpec(env: NodeJS.ProcessEnv = process.env): SnnGpuSpec | undefined {
  const on = (env.SNN_GPU ?? 'auto').toLowerCase();
  if (on === 'false' || on === '0' || on === 'off') return undefined;
  const python = env.TA_NET_PYTHON;
  return python ? { python } : undefined;
}

/** Group size, how many groups at once and the first guess of a GPU member's speed: SNN_GPU_GROUP / SNN_GPU_GROUPS /
 *  SNN_GPU_SPEEDUP, else what SnnGpuBench.cmd recommended on this computer (DATA_DIR/snn-gpu-bench.json), else 16 / 1 / 2. */
export function snnGpuShape(env: NodeJS.ProcessEnv = process.env): { group: number; groups: number; speedup: number } {
  let rec: { groups?: number; group?: number; speedup?: number } = {};
  try { rec = JSON.parse(fs.readFileSync(path.join(env.DATA_DIR ?? 'data', 'snn-gpu-bench.json'), 'utf8')).engine?.recommend ?? {}; } catch { /* no bench run */ }
  const n = (v: unknown, d: number) => { const x = Math.floor(Number(v)); return x >= 1 ? x : d; };
  const sp = Number(env.SNN_GPU_SPEEDUP) || Number(rec.speedup);
  return { group: n(env.SNN_GPU_GROUP ?? rec.group, 16), groups: n(env.SNN_GPU_GROUPS ?? rec.groups, 1), speedup: sp > 0 ? sp : 2 };
}

interface Waiting { job: SnnReplayJob; resolve: (o: SnnReplayOut) => void; reject: (e: Error) => void }

export class MemberScheduler {
  private queue: Waiting[] = [];
  private timer?: NodeJS.Timeout;
  private free: number;
  private off = false;
  /** Replay ms per member and tape ms, on a CPU worker and in a GPU group (running means). */
  private cpuCost?: number;
  private gpuCost?: number;
  constructor(private readonly o: {
    cpu: Runner<SnnReplayJob, SnnReplayOut>; gpu: Runner<SnnGpuJob, SnnGpuOut>; spec: SnnGpuSpec;
    group: number; groups: number; cpuWorkers: number; speedup?: number; log: (m: string) => void;
  }) {
    this.free = o.groups;
  }

  /** A GPU group member's speed in CPU cores. */
  speed(): number {
    return this.cpuCost && this.gpuCost ? this.cpuCost / this.gpuCost : this.o.speedup ?? 2;
  }

  /** One member's replay: on a CPU worker, or in a GPU group when it plays a tape the GPU can run. */
  run(job: SnnReplayJob): Promise<SnnReplayOut> {
    if (this.off || !job.playTape || job.domain === 'tennis' || job.snnModel || gpuUnsupported(job.params).length) return this.cpu(job);
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      // The members of a round arrive together (they wait on the same tape): share them out once they are all in.
      this.timer ??= setTimeout(() => { this.timer = undefined; this.dispatch(); }, 50);
    });
  }

  private async cpu(job: SnnReplayJob): Promise<SnnReplayOut> {
    const out = await this.o.cpu.run(job);
    if (job.playTape && out.ms && job.to > job.from) this.cpuCost = mean(this.cpuCost, out.ms / (job.to - job.from));
    return out;
  }

  private dispatch(): void {
    const q = this.queue;
    this.queue = [];
    const r = this.speed() * this.free;
    let take = this.free ? Math.min(this.free * this.o.group, q.length, Math.round((q.length * r) / (this.o.cpuWorkers + r))) : 0;
    if (!take && this.free && this.speed() >= 1) take = 1;
    // Groups from the members that start the same tape at the same time (most of a round's).
    const byKey = new Map<string, Waiting[]>();
    for (const w of q) { const k = `${w.job.playTape}|${w.job.from}`; byKey.set(k, [...(byKey.get(k) ?? []), w]); }
    const buckets = [...byKey.values()].sort((a, b) => b.length - a.length);
    const groups: Waiting[][] = [];
    for (const b of buckets) {
      while (take > 0 && this.free - groups.length > 0 && b.length) {
        const g = b.splice(0, Math.min(this.o.group, take, Math.ceil(take / (this.free - groups.length))));
        groups.push(g);
        take -= g.length;
      }
    }
    const onGpu = new Set(groups.flat());
    for (const w of q) if (!onGpu.has(w)) this.cpu(w.job).then(w.resolve, w.reject);
    for (const g of groups) void this.group(g, q.length - onGpu.size);
  }

  private async group(g: Waiting[], onCpu: number): Promise<void> {
    this.free--;
    const j0 = g[0].job;
    try {
      const out = await this.o.gpu.run({
        gpuGroup: { spec: this.o.spec, tape: j0.playTape!, domain: j0.domain as 'crypto' | 'perps', members: g.map((w) => ({ params: w.job.params, checkpoint: w.job.checkpoint, from: w.job.from, pauseLearning: w.job.pauseLearning })) },
      });
      const span = j0.to - j0.from;
      if (span > 0) this.gpuCost = mean(this.gpuCost, out.ms / (g.length * span));
      this.o.log(`SNN GPU group: ${g.length} member(s) in ${(out.ms / 1000).toFixed(1)} s next to ${onCpu} on ${this.o.cpuWorkers} CPU worker(s); a GPU member ≈ ${this.speed().toFixed(1)} CPU core(s)`);
      g.forEach((w, i) => w.resolve(out.outs[i]));
    } catch (e) {
      // The same bits on the CPU: the round goes on there, and so do the next ones.
      this.off = true;
      this.o.log(`SNN GPU group failed, members replay on the CPU from now on: ${(e as Error).message.split('\n')[0]}`);
      for (const w of g) this.cpu(w.job).then(w.resolve, w.reject);
    } finally {
      this.free++;
    }
  }
}

/** A running mean that follows the latest rounds (spans and machines' load vary). */
function mean(prev: number | undefined, x: number): number {
  return prev === undefined ? x : prev + 0.3 * (x - prev);
}

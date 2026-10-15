// Keeps the computer usable while the laptop trainer runs, and keeps the trainer from freezing it.
//
//   the plan       from the machine (CPU threads, memory) and the intensity you choose (gentle / balanced / full):
//                  how many worker threads, how much memory each Node process and worker may take, how many threads
//                  PyTorch may use, how much of the GPU's memory it may take and how often it pauses for the desktop.
//                  Memory left for you and Windows: a quarter of it, at least 3 GB. Threads left for you: balanced
//                  uses half of them, gentle a quarter, full all but two.
//   priority       the trainer and everything it starts run below normal priority (gentle: the idle class), so
//                  whatever you are doing comes first.
//   the governor   every 15 s: free memory, and on Windows whether you are using the computer (keyboard / mouse in the
//                  last 90 s). It writes a throttle file that the pipeline's worker pools read before they start new
//                  work (fewer threads while you work or while memory is short; idle workers are let go to free their
//                  memory) and that the PyTorch trainer reads to pace the GPU.
//   the record     a line a minute in trainer-data/resources.log (free memory, the trainer's own memory, threads,
//                  why), and a marker while a run is in progress: if the computer froze or lost power, the next start
//                  says so, with the last readings before it happened.

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type Intensity = 'gentle' | 'balanced' | 'full';
export const INTENSITIES: Intensity[] = ['gentle', 'balanced', 'full'];
export const asIntensity = (v: unknown): Intensity => (INTENSITIES.includes(v as Intensity) ? (v as Intensity) : 'balanced');

const MB = 1024 * 1024;

export interface ResourcePlan {
  intensity: Intensity;
  cores: number; totalMb: number;
  /** Worker threads with the computer idle, and while you are using it. */
  workers: number; activeWorkers: number;
  /** Heap of each Node process (the pipeline) and of each worker thread (MB). */
  mainHeapMb: number; workerHeapMb: number;
  /** Worker pools start no new work below this much free memory (MB). */
  minFreeMb: number;
  torchThreads: number;
  /** Share of the GPU's memory PyTorch may take; a sync every N training steps and a pause (ms) after it. */
  gpuMemFraction: number; gpuSyncEvery: number; gpuYieldMs: number; activeGpuYieldMs: number;
  priority: 'low' | 'below_normal';
  gpPopulation: number; snnPopulation: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** The plan for this machine at an intensity. */
export function resourcePlan(intensity: Intensity = 'balanced', cores = os.cpus().length, totalMb = Math.round(os.totalmem() / MB)): ResourcePlan {
  const reserveMb = Math.max(3072, Math.round(0.25 * totalMb));
  const budgetMb = Math.max(1024, totalMb - reserveMb);
  const byCpu = intensity === 'gentle' ? Math.floor(cores / 4) : intensity === 'balanced' ? Math.floor(cores / 2) : cores - 2;
  // The pipeline's own process: its history step holds years of 1-minute bars (about 5.5 GB measured), so up to 8 GB
  // when the machine has it. The workers are sized on what it typically holds while they run (a third of the budget at
  // most), about 1.5 GB each; a worker's cap above that only stops one that runs away.
  const mainHeapMb = Math.round(clamp(budgetMb - 1536, 2048, 8192));
  const mainTypMb = Math.min(mainHeapMb, 0.35 * budgetMb);
  const workers = Math.max(1, Math.min(Math.max(1, byCpu), Math.floor((budgetMb - mainTypMb) / 1536)));
  const workerHeapMb = Math.round(clamp((budgetMb - mainTypMb) / workers, 2048, 4096));
  const activeWorkers = intensity === 'full' ? workers : Math.max(1, Math.min(workers, intensity === 'gentle' ? 1 : Math.floor(cores / 4)));
  // GPU: share of its memory (the rest stays with the display; too tight and training falls back to TypeScript
  // part-way), a sync every N steps and the pauses (ms) after it, idle and while you use the computer.
  const gpu = { gentle: [0.6, 10, 20, 40], balanced: [0.75, 25, 5, 20], full: [0.9, 100, 0, 0] }[intensity];
  return {
    intensity, cores, totalMb, workers, activeWorkers, mainHeapMb, workerHeapMb,
    minFreeMb: Math.max(1536, Math.round(0.12 * totalMb)),
    torchThreads: Math.max(1, Math.min(Math.max(1, byCpu), Math.floor(cores / 2))),
    gpuMemFraction: gpu[0], gpuSyncEvery: gpu[1], gpuYieldMs: gpu[2], activeGpuYieldMs: gpu[3],
    priority: intensity === 'gentle' ? 'low' : 'below_normal',
    gpPopulation: Math.min(15000, Math.max(2000, 2000 * workers)), snnPopulation: Math.min(32, Math.max(3, workers)),
  };
}

/** The settings the pipeline and its workers read. */
export function planEnv(p: ResourcePlan, throttleFile?: string): Record<string, string> {
  return {
    NODE_OPTIONS: `--max-old-space-size=${p.mainHeapMb}`,
    TRAIN_WORKERS: String(p.workers), TRAIN_WORKER_HEAP_MB: String(p.workerHeapMb), TRAIN_MIN_FREE_MB: String(p.minFreeMb),
    ...(throttleFile ? { TRAIN_THROTTLE_FILE: throttleFile } : {}),
    // PyTorch, numpy and the math libraries under them: their own thread pools, sized like the plan.
    TA_NET_TORCH_THREADS: String(p.torchThreads), OMP_NUM_THREADS: String(p.torchThreads), MKL_NUM_THREADS: String(p.torchThreads), OPENBLAS_NUM_THREADS: String(p.torchThreads),
    TA_NET_GPU_MEM_FRACTION: String(p.gpuMemFraction), TA_NET_GPU_SYNC_EVERY: String(p.gpuSyncEvery), TA_NET_GPU_YIELD_MS: String(p.gpuYieldMs),
    GP_POPULATION: String(p.gpPopulation), AUTO_TRAIN_SNN_PBT_POPULATION: String(p.snnPopulation),
  };
}

/** Lower this process's priority (its children inherit it on Windows and Linux). */
export function lowerPriority(p: ResourcePlan['priority'], pid = 0): boolean {
  try { os.setPriority(pid, p === 'low' ? os.constants.priority.PRIORITY_LOW : os.constants.priority.PRIORITY_BELOW_NORMAL); return true; } catch { return false; }
}

// ---- The throttle file (written by the governor, read by the worker pools and the PyTorch trainer) ----------------

export interface Throttle { workers: number; gpuSyncEvery: number; gpuYieldMs: number; reason: string; at: number }

let cache: { file: string; at: number; v?: Throttle } | undefined;
/** The current throttle (re-read at most every 2 s; undefined without a file or when it is older than 2 minutes: a
 *  governor that is gone must not hold the pipeline back). */
export function readThrottle(file: string | undefined = process.env.TRAIN_THROTTLE_FILE, now = Date.now()): Throttle | undefined {
  if (!file) return undefined;
  if (cache?.file === file && now - cache.at < 2000) return cache.v;
  let v: Throttle | undefined;
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Throttle; if (j && Number.isFinite(j.workers) && now - j.at < 120_000) v = j; } catch { /* none */ }
  cache = { file, at: now, v };
  return v;
}

/** What the governor decides from the free memory and whether you are using the computer. */
export function decideThrottle(p: ResourcePlan, freeMb: number, idleSec: number | undefined, now = Date.now()): Throttle {
  const base = { gpuSyncEvery: p.gpuSyncEvery, at: now };
  if (freeMb < p.minFreeMb) return { ...base, workers: 1, gpuYieldMs: Math.max(20, p.gpuYieldMs), reason: `low memory: ${Math.round(freeMb)} MB free (below ${p.minFreeMb} MB), one thread` };
  if (freeMb < 1.5 * p.minFreeMb) return { ...base, workers: Math.max(1, Math.floor(p.workers / 2)), gpuYieldMs: Math.max(p.gpuYieldMs, p.activeGpuYieldMs), reason: `memory getting short: ${Math.round(freeMb)} MB free` };
  if (idleSec !== undefined && idleSec < 90 && p.intensity !== 'full') return { ...base, workers: p.activeWorkers, gpuYieldMs: p.activeGpuYieldMs, reason: 'you are using the computer: fewer threads' };
  return { ...base, workers: p.workers, gpuYieldMs: p.gpuYieldMs, reason: idleSec === undefined ? 'full plan' : 'computer idle: full plan' };
}

// ---- Windows: seconds since the last keyboard / mouse input (one PowerShell process for the whole run) ------------

const IDLE_PS = [
  'Add-Type @"',
  'using System; using System.Runtime.InteropServices;',
  'public static class TrainerIdle { [StructLayout(LayoutKind.Sequential)] struct L { public uint cb; public uint t; }',
  '[DllImport("user32.dll")] static extern bool GetLastInputInfo(ref L l);',
  'public static long Ms() { var l = new L(); l.cb = (uint)Marshal.SizeOf(l); if (!GetLastInputInfo(ref l)) return -1; return (long)((uint)Environment.TickCount - l.t); } }',
  '"@',
  'while ($true) { [Console]::Out.WriteLine([TrainerIdle]::Ms()); [Console]::Out.Flush(); Start-Sleep -Seconds 10 }',
].join('\n');

export class IdleWatch {
  private child?: ChildProcess;
  private last?: { ms: number; at: number };
  start(): void {
    if (process.platform !== 'win32' || this.child) return;
    try {
      this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(IDLE_PS, 'utf16le').toString('base64')], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let buf = '';
      this.child.stdout!.on('data', (b: Buffer) => {
        buf += b.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) { const v = Number(buf.slice(0, i).trim()); buf = buf.slice(i + 1); if (Number.isFinite(v) && v >= 0) this.last = { ms: v, at: Date.now() }; }
      });
      this.child.on('error', () => { this.child = undefined; });
      this.child.on('exit', () => { this.child = undefined; });
    } catch { this.child = undefined; }
  }
  /** Seconds since the last input (undefined when unknown or stale). */
  idleSec(now = Date.now()): number | undefined { return this.last && now - this.last.at < 60_000 ? (this.last.ms + (now - this.last.at)) / 1000 : undefined; }
  stop(): void { try { this.child?.kill(); } catch { /* gone */ } this.child = undefined; }
}

// ---- The governor ------------------------------------------------------------------------------------------------

export interface GovernorStatus { intensity: Intensity; workers: number; maxWorkers: number; reason: string; freeMb: number; totalMb: number; idleSec: number | null }

export class ResourceGovernor {
  private timer?: NodeJS.Timeout;
  private lastLog = 0;
  private readonly idle = new IdleWatch();
  status: GovernorStatus;
  constructor(readonly plan: ResourcePlan, private readonly o: { throttleFile: string; logFile?: string; freeMb?: () => number; idleSec?: () => number | undefined; rssMb?: () => number }) {
    this.status = { intensity: plan.intensity, workers: plan.workers, maxWorkers: plan.workers, reason: 'starting', freeMb: 0, totalMb: plan.totalMb, idleSec: null };
  }
  start(everyMs = 15_000): void {
    if (!this.o.idleSec) this.idle.start();
    this.tick();
    this.timer = setInterval(() => this.tick(), everyMs);
    this.timer.unref();
  }
  tick(now = Date.now()): Throttle {
    const freeMb = (this.o.freeMb ?? (() => os.freemem() / MB))();
    const idleSec = (this.o.idleSec ?? (() => this.idle.idleSec(now)))();
    const t = decideThrottle(this.plan, freeMb, idleSec, now);
    try { const tmp = `${this.o.throttleFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(t)); fs.renameSync(tmp, this.o.throttleFile); } catch { /* the pools run on the plan */ }
    this.status = { intensity: this.plan.intensity, workers: t.workers, maxWorkers: this.plan.workers, reason: t.reason, freeMb: Math.round(freeMb), totalMb: this.plan.totalMb, idleSec: idleSec === undefined ? null : Math.round(idleSec) };
    if (this.o.logFile && now - this.lastLog >= 60_000) {
      this.lastLog = now;
      const rss = Math.round((this.o.rssMb ?? (() => process.memoryUsage().rss / MB))());
      appendCapped(this.o.logFile, `${new Date(now).toISOString()} free ${Math.round(freeMb)}/${this.plan.totalMb} MB, trainer ${rss} MB, threads ${t.workers}/${this.plan.workers}, ${t.reason}${idleSec === undefined ? '' : `, idle ${Math.round(idleSec)} s`}\n`);
    }
    return t;
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.idle.stop(); try { fs.rmSync(this.o.throttleFile, { force: true }); } catch { /* gone */ } }
}

/** Append, keeping the file under ~2 MB (the older half is dropped). */
export function appendCapped(file: string, line: string, maxBytes = 2 * MB): void {
  try {
    fs.appendFileSync(file, line);
    if (fs.statSync(file).size > maxBytes) { const s = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, s.slice(s.length - Math.floor(maxBytes / 2))); }
  } catch { /* best effort */ }
}

// ---- Did the last run end without stopping? ------------------------------------------------------------------------

const markerOf = (dataDir: string) => path.join(dataDir, 'run.marker');

/** Mark a run as in progress; returns what happened to the previous one when it never stopped (a freeze, a crash,
 *  power loss), with the last resource readings before it. */
export function markRunStart(dataDir: string, now = Date.now()): string | undefined {
  let note: string | undefined;
  try {
    const prev = JSON.parse(fs.readFileSync(markerOf(dataDir), 'utf8')) as { startedAt: string; pid: number; intensity?: string };
    let tail: string[] = [];
    try { tail = fs.readFileSync(path.join(dataDir, 'resources.log'), 'utf8').trim().split('\n').slice(-3); } catch { /* none */ }
    note = `the previous run (started ${prev.startedAt.slice(0, 16).replace('T', ' ')} UTC${prev.intensity ? `, ${prev.intensity}` : ''}) ended without stopping: the computer froze, crashed or lost power, or the window was killed.${tail.length ? ` Its last readings: ${tail.join(' | ')}` : ''}`;
  } catch { /* the previous run stopped normally */ }
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(markerOf(dataDir), JSON.stringify({ startedAt: new Date(now).toISOString(), pid: process.pid })); } catch { /* best effort */ }
  return note;
}
export function markRunIntensity(dataDir: string, intensity: Intensity): void {
  try { const m = JSON.parse(fs.readFileSync(markerOf(dataDir), 'utf8')); fs.writeFileSync(markerOf(dataDir), JSON.stringify({ ...m, intensity })); } catch { /* best effort */ }
}
export function markRunEnd(dataDir: string): void { try { fs.rmSync(markerOf(dataDir), { force: true }); } catch { /* gone */ } }

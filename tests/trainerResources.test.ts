import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { laptopProfile } from '../research/laptopTrain';
import { appendCapped, decideThrottle, INTENSITIES, markRunEnd, markRunIntensity, markRunStart, planEnv, readThrottle, ResourceGovernor, resourcePlan } from '../research/trainerResources';
import { WorkerPool } from '../research/workerPool';
import { tmpDir } from './helpers';

test('resource plan: threads and memory sized to the machine and the intensity, with room left for you', () => {
  // 16 threads, 32 GB, balanced: half the threads, a quarter of the memory kept free.
  const b = resourcePlan('balanced', 16, 32768);
  assert.deepEqual([b.workers, b.activeWorkers, b.mainHeapMb, b.workerHeapMb, b.minFreeMb, b.torchThreads, b.priority], [8, 4, 8192, 2048, 3932, 8, 'below_normal']);
  assert.deepEqual([b.snnPopulation, b.gpPopulation], [8, 15000]);
  // 16 GB: memory decides (5 workers; gentle 4, and one while you use the computer). The pipeline keeps up to 8 GB:
  // its history step needs about 5.5 GB.
  const m = resourcePlan('balanced', 16, 16384);
  assert.deepEqual([m.workers, m.mainHeapMb, m.workerHeapMb, m.minFreeMb], [5, 8192, 2048, 1966]);
  const g = resourcePlan('gentle', 16, 16384);
  assert.deepEqual([g.workers, g.activeWorkers, g.priority, g.gpuMemFraction], [4, 1, 'low', 0.6]);
  assert.equal(resourcePlan('full', 16, 16384).workers, 5);
  assert.equal(resourcePlan('full', 16, 65536).workers, 14, 'full: all threads but two when memory allows');
  // 8 GB and 4 GB laptops: one worker, never none.
  assert.deepEqual([resourcePlan('balanced', 8, 8192).workers, resourcePlan('balanced', 8, 8192).mainHeapMb], [2, 3584]);
  assert.equal(resourcePlan('full', 4, 4096).workers, 1);
  for (const cores of [2, 4, 8, 12, 16, 24, 32]) {
    for (const mb of [8192, 16384, 32768, 65536]) {
      const ps = INTENSITIES.map((i) => resourcePlan(i, cores, mb));
      for (const p of ps) {
        assert.ok(p.workers >= 1 && p.workers <= Math.max(1, cores - 1), `${p.intensity} ${cores}/${mb}: ${p.workers} workers`);
        assert.ok(p.activeWorkers >= 1 && p.activeWorkers <= p.workers);
        const budget = mb - Math.max(3072, 0.25 * mb);
        assert.ok(Math.min(p.mainHeapMb, 0.35 * budget) + 1536 * p.workers <= budget, `${p.intensity} ${cores}/${mb}: expected use within the budget`);
        assert.ok(p.mainHeapMb <= 8192 && p.workerHeapMb <= 4096 && p.torchThreads >= 1 && p.torchThreads <= Math.max(1, cores / 2));
        assert.ok(p.minFreeMb >= 1536);
      }
      assert.ok(ps[0].workers <= ps[1].workers && ps[1].workers <= ps[2].workers, 'gentle <= balanced <= full');
      assert.ok(ps[0].gpuYieldMs >= ps[1].gpuYieldMs && ps[1].gpuYieldMs >= ps[2].gpuYieldMs, 'gentle pauses the GPU the most');
    }
  }
});

test('resource plan: the settings the pipeline, its workers and PyTorch read; the laptop profile carries them', () => {
  const p = resourcePlan('balanced', 16, 16384);
  const e = planEnv(p, '/x/throttle.json');
  assert.equal(e.NODE_OPTIONS, '--max-old-space-size=8192');
  assert.deepEqual([e.TRAIN_WORKERS, e.TRAIN_WORKER_HEAP_MB, e.TRAIN_MIN_FREE_MB, e.TRAIN_THROTTLE_FILE], ['5', '2048', '1966', '/x/throttle.json']);
  // PyTorch's threads follow the CPU (half of them), not the memory that limits the worker threads.
  assert.deepEqual([e.TA_NET_TORCH_THREADS, e.OMP_NUM_THREADS, e.MKL_NUM_THREADS, e.OPENBLAS_NUM_THREADS], ['8', '8', '8', '8']);
  assert.deepEqual([e.TA_NET_GPU_MEM_FRACTION, e.TA_NET_GPU_SYNC_EVERY, e.TA_NET_GPU_YIELD_MS], ['0.75', '25', '5']);
  assert.equal(planEnv(p).TRAIN_THROTTLE_FILE, undefined);
  const prof = laptopProfile(12, 16, false, resourcePlan('balanced', 8, 8192));
  assert.equal(prof.NODE_OPTIONS, '--max-old-space-size=3584', 'the pipeline\'s cap follows the machine');
  assert.equal(prof.TRAIN_WORKERS, '2');
  assert.equal(laptopProfile(0, 16, true, p).TRAIN_WORKERS, '5', 'continuous runs use the same plan');
});

test('throttle: fewer threads while you use the computer or memory is short; the GPU pauses more', () => {
  const p = resourcePlan('balanced', 16, 32768);
  const low = decideThrottle(p, 2000, 600, 1);
  assert.deepEqual([low.workers, low.gpuYieldMs >= 20], [1, true]);
  assert.match(low.reason, /low memory/);
  const short = decideThrottle(p, 5000, 600, 1);
  assert.equal(short.workers, 4);
  assert.match(short.reason, /getting short/);
  const busy = decideThrottle(p, 20000, 10, 1);
  assert.deepEqual([busy.workers, busy.gpuYieldMs], [4, 20]);
  assert.match(busy.reason, /using the computer/);
  assert.deepEqual([decideThrottle(p, 20000, 600, 1).workers, decideThrottle(p, 20000, 600, 1).gpuYieldMs], [8, 5]);
  assert.equal(decideThrottle(p, 20000, undefined, 1).workers, 8, 'not knowing whether you are there: the plan');
  const full = resourcePlan('full', 16, 32768);
  assert.equal(decideThrottle(full, 20000, 10, 1).workers, full.workers, 'full ignores you; memory still counts');
  assert.equal(decideThrottle(full, 2000, 10, 1).workers, 1);
});

test('throttle file: read at most every 2 s, ignored when the governor is gone (older than 2 minutes)', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'throttle.json'), stale = path.join(dir, 'stale.json');
  const now = 1_000_000_000;
  fs.writeFileSync(f, JSON.stringify({ workers: 2, gpuSyncEvery: 25, gpuYieldMs: 5, reason: 'x', at: now }));
  assert.equal(readThrottle(f, now)?.workers, 2);
  fs.writeFileSync(f, JSON.stringify({ workers: 5, gpuSyncEvery: 25, gpuYieldMs: 5, reason: 'x', at: now + 1000 }));
  assert.equal(readThrottle(f, now + 1000)?.workers, 2, 'cached');
  assert.equal(readThrottle(f, now + 2500)?.workers, 5);
  fs.writeFileSync(stale, JSON.stringify({ workers: 1, gpuSyncEvery: 25, gpuYieldMs: 5, reason: 'x', at: now - 200_000 }));
  assert.equal(readThrottle(stale, now), undefined);
  assert.equal(readThrottle(path.join(dir, 'none.json'), now), undefined);
  assert.equal(readThrottle(undefined, now), undefined);
});

test('governor: writes the throttle, logs a line a minute, removes the file when it stops', () => {
  const dir = tmpDir();
  const throttleFile = path.join(dir, 'throttle.json'), logFile = path.join(dir, 'resources.log');
  let free = 2000;
  const g = new ResourceGovernor(resourcePlan('balanced', 16, 32768), { throttleFile, logFile, freeMb: () => free, idleSec: () => 5, rssMb: () => 123 });
  const now = Date.now();
  g.tick(now);
  assert.equal(JSON.parse(fs.readFileSync(throttleFile, 'utf8')).workers, 1);
  assert.deepEqual([g.status.workers, g.status.maxWorkers, g.status.freeMb, g.status.idleSec], [1, 8, 2000, 5]);
  free = 20000;
  g.tick(now + 15_000);
  assert.equal(JSON.parse(fs.readFileSync(throttleFile, 'utf8')).workers, 4, 'memory back, you are still there');
  g.tick(now + 61_000);
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'a line a minute');
  assert.match(lines[0], /free 2000\/32768 MB, trainer 123 MB, threads 1\/8, low memory/);
  assert.match(lines[1], /threads 4\/8, you are using the computer/);
  g.stop();
  assert.equal(fs.existsSync(throttleFile), false);
});

test('run marker: a run that never stopped is reported at the next start, with its last readings', () => {
  const dir = tmpDir();
  assert.equal(markRunStart(dir, Date.parse('2026-10-15T10:00:00Z')), undefined);
  markRunIntensity(dir, 'gentle');
  fs.writeFileSync(path.join(dir, 'resources.log'), 'a\nb\nfree 900/16384 MB, threads 1/4, low memory\n');
  const note = markRunStart(dir, Date.parse('2026-10-15T12:00:00Z'));
  assert.match(note!, /started 2026-10-15 10:00 UTC, gentle\) ended without stopping/);
  assert.match(note!, /free 900\/16384 MB/);
  markRunEnd(dir);
  assert.equal(markRunStart(dir), undefined, 'stopped normally: nothing to say');
  const log = path.join(dir, 'capped.log');
  for (let i = 0; i < 200; i++) appendCapped(log, `${'x'.repeat(40)} ${i}\n`, 2000);
  assert.ok(fs.statSync(log).size <= 2000);
  assert.match(fs.readFileSync(log, 'utf8'), / 199\n$/, 'the newest lines are kept');
});

// A worker that counts how many jobs run at once (shared memory), sleeps, allocates if asked, and reports its heap cap.
const WORKER = `
const { parentPort, workerData } = require('worker_threads');
const v8 = require('v8');
const c = new Int32Array(workerData.sab);
parentPort.on('message', async (j) => {
  const now = Atomics.add(c, 0, 1) + 1;
  for (;;) { const m = Atomics.load(c, 1); if (now <= m || Atomics.compareExchange(c, 1, m, now) === m) break; }
  const keep = [];
  for (let i = 0; i < (j.allocMb || 0); i++) keep.push(new Array(1 << 17).fill(i + 0.5));
  await new Promise((r) => setTimeout(r, j.ms || 0));
  Atomics.sub(c, 0, 1);
  parentPort.postMessage({ ok: true, out: { limitMb: v8.getHeapStatistics().heap_size_limit / 1048576, kept: keep.length } });
});
`;

function pool(env: NodeJS.ProcessEnv, size = 4) {
  const dir = tmpDir();
  const file = path.join(dir, 'w.cjs');
  fs.writeFileSync(file, WORKER);
  const sab = new SharedArrayBuffer(8);
  const p = new WorkerPool<{ ms?: number; allocMb?: number }, { limitMb: number; kept: number }>({ path: file, workerData: { sab } }, size, env);
  return { p, peak: () => Atomics.load(new Int32Array(sab), 1), reset: () => Atomics.store(new Int32Array(sab), 1, 0) };
}

test('worker pool: follows the throttle, waits for free memory, caps each worker\'s heap', async () => {
  // No throttle: up to its size at once.
  const a = pool({});
  try { await Promise.all([0, 1, 2, 3].map(() => a.p.run({ ms: 400 }))); assert.ok(a.peak() >= 2, `ran ${a.peak()} at once`); } finally { await a.p.close(); }
  // The governor says one thread: one job at a time.
  const throttle = path.join(tmpDir(), 'throttle.json');
  fs.writeFileSync(throttle, JSON.stringify({ workers: 1, gpuSyncEvery: 25, gpuYieldMs: 5, reason: 'you are using the computer', at: Date.now() }));
  const c = pool({ TRAIN_THROTTLE_FILE: throttle });
  try { await Promise.all([0, 1, 2].map(() => c.p.run({ ms: 100 }))); assert.equal(c.peak(), 1); } finally { await c.p.close(); }
  // Free memory below the floor: one job at a time, never none.
  const d = pool({ TRAIN_MIN_FREE_MB: String(1e9) });
  try { await Promise.all([0, 1, 2].map(() => d.p.run({ ms: 100 }))); assert.equal(d.peak(), 1); } finally { await d.p.close(); }
  // The heap cap reaches the worker, even with a process-wide --max-old-space-size (NODE_OPTIONS) in force.
  const e = pool({ TRAIN_WORKER_HEAP_MB: '96' });
  try { const r = await e.p.run({}); assert.ok(r.limitMb < 400, `heap limit ${r.limitMb} MB`); } finally { await e.p.close(); }
});

test('worker pool: a job that runs out of its worker\'s heap runs again with twice the room', async () => {
  const f = pool({ TRAIN_WORKER_HEAP_MB: '32' }, 2);
  try {
    const r = await f.p.run({ allocMb: 50 });
    assert.equal(r.kept, 50);
    assert.ok(r.limitMb > 100, `retried with a bigger heap (${r.limitMb} MB; the first worker had about 80)`);
  } finally { await f.p.close(); }
});

test('worker pool: idle workers above the throttle are let go', async () => {
  const throttle = path.join(tmpDir(), 'throttle.json');
  const h = pool({ TRAIN_THROTTLE_FILE: throttle }, 3);
  try {
    await Promise.all([0, 1, 2].map(() => h.p.run({ ms: 300 })));
    assert.ok(h.p['all'].size >= 2);
    fs.writeFileSync(throttle, JSON.stringify({ workers: 1, gpuSyncEvery: 25, gpuYieldMs: 5, reason: 'low memory', at: Date.now() }));
    await new Promise((r) => setTimeout(r, 2100)); // the throttle is re-read every 2 s
    h.reset();
    await Promise.all([0, 1].map(() => h.p.run({ ms: 50 })));
    assert.equal(h.peak(), 1);
    assert.equal(h.p['all'].size, 1, 'the others were terminated (their memory comes back)');
  } finally { await h.p.close(); }
});

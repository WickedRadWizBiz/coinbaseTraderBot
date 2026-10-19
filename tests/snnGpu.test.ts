// The GPU tournament engine (research/snnGpu.ts): a group of members playing one tape with their columns in the device
// pool gets exactly the rows and networks each member gets playing the tape on the CPU. Run here with the pool's C build
// (python/snn/pool.py --cpu: the same summaries and protocol as the GPU, the serial kernel); skipped without Python or a
// C compiler.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SNN, domainParams, stageFlags, withFlags, type Stage } from '../bot/snn/params';
import { snnHyperOf, withSnnHyper } from '../bot/snn/population';
import { GpuPool, gpuUnsupported, playSnnTapeGpu } from '../research/snnGpu';
import { MemberScheduler, snnGpuShape } from '../research/snnGpuSched';
import { runSnnPbt } from '../research/snnPbt';
import type { SnnReplayJob } from '../research/snnReplayWorker';
import { playSnnTape, recordSnnTape, type PlayOpts } from '../research/snnTape';
import { writeSyntheticRecordings } from '../research/synthetic';
import { tmpDir } from './helpers';

const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import ctypes'], { encoding: 'utf8' }).status === 0);
const cc = ['cc', 'gcc', 'clang'].find((c) => spawnSync(c, ['--version']).status === 0);
const skip = !python ? 'no Python' : !cc ? 'no C compiler' : false;

const params = (domain: 'crypto' | 'perps', stage: Stage, seed = 3) => domainParams(domain, withFlags({ ...DEFAULT_SNN, nE: 24, nI: 6, nL1: 10, seed }, stageFlags(stage)));
const knobs = (p: ReturnType<typeof params>, f: number) => withSnnHyper(p, Object.fromEntries(Object.entries(snnHyperOf(p)).map(([k, v]) => [k, v * f])));

test('a group of members on the device pool plays a tape bit for bit as each member on the CPU (crypto S5/S6, perps S6, from scratch and from checkpoints)', { skip }, async () => {
  const rec = tmpDir();
  writeSyntheticRecordings(rec, { windows: 6, seed: 7 });
  const pool = await GpuPool.start({ python: python!, cpu: true, env: { ...process.env, CC: cc } });
  try {
    assert.equal((await pool.info()).backend, 'cpu');
    for (const [domain, stage] of [['crypto', 'S5'], ['crypto', 'S6'], ['perps', 'S6']] as const) {
      const base = params(domain, stage);
      const file = path.join(tmpDir(), 'span.tape');
      await recordSnnTape(rec, file, { params: base, domain, skipModel: true });
      const first = playSnnTape(file, { params: base, domain });
      const cp = first.net.serialize();
      // Members: the base, mutated knobs from scratch, and two continuing from a saved network.
      const members: PlayOpts[] = [
        { params: base, domain },
        { params: knobs(base, 1.05), domain },
        { params: knobs(base, 0.95), domain, checkpoint: cp, allowParamChange: true },
        { params: base, domain, checkpoint: cp },
      ];
      const cpu = members.map((o) => playSnnTape(file, o));
      const gpu = await playSnnTapeGpu(file, members, pool);
      assert.ok(cpu[0].rows.length > 0 && cpu[0].steps > 1000);
      members.forEach((_, i) => {
        assert.equal(gpu[i].steps, cpu[i].steps, `${domain} ${stage} member ${i} steps`);
        assert.equal(JSON.stringify(gpu[i].rows), JSON.stringify(cpu[i].rows), `${domain} ${stage} member ${i} rows`);
        assert.equal(JSON.stringify(gpu[i].net.serialize()), JSON.stringify(cpu[i].net.serialize()), `${domain} ${stage} member ${i} network`);
      });
    }
  } finally {
    await pool.close();
  }
});

test("the GPU's own group kernel (every column on a team of threads, persistent transposed indexes) gives the same bits, on POSIX threads", { skip }, async () => {
  const rec = tmpDir();
  writeSyntheticRecordings(rec, { windows: 3, seed: 11 });
  const pool = await GpuPool.start({ python: python!, cpu: true, threads: 3, env: { ...process.env, CC: cc } });
  try {
    assert.equal((await pool.info()).threads, 3);
    const base = params('crypto', 'S6');
    const file = path.join(tmpDir(), 'span.tape');
    await recordSnnTape(rec, file, { params: base, domain: 'crypto', skipModel: true });
    const members: PlayOpts[] = [{ params: base, domain: 'crypto' }, { params: knobs(base, 1.05), domain: 'crypto' }];
    const cpu = members.map((o) => playSnnTape(file, o));
    const gpu = await playSnnTapeGpu(file, members, pool);
    members.forEach((_, i) => {
      assert.equal(JSON.stringify(gpu[i].rows), JSON.stringify(cpu[i].rows), `member ${i} rows`);
      assert.equal(JSON.stringify(gpu[i].net.serialize()), JSON.stringify(cpu[i].net.serialize()), `member ${i} network`);
    });
  } finally {
    await pool.close();
  }
});

test('a tournament with a GPU group next to its CPU workers ranks and keeps its members exactly as on the CPU', { skip }, async () => {
  const rec = tmpDir();
  for (let d = 0; d < 3; d++) writeSyntheticRecordings(rec, { windows: 3, seed: 21 + d, start: Date.parse('2026-02-01T00:00:00Z') + d * 86_400_000 });
  const opts = { recordings: rec, domain: 'crypto' as const, stage: 'S5' as const, days: ['2026-02-01', '2026-02-02', '2026-02-03'], initDays: 1, evalDays: 1, population: 5 };
  const ranks = (r: Awaited<ReturnType<typeof runSnnPbt>>) => r.log.map((x) => x.ranking.map((y) => `${y.member}:${y.fitness}`));
  const cpuState = tmpDir(), gpuState = tmpDir();
  const cpu = await runSnnPbt({ ...opts, tapeDir: tmpDir(), stateDir: cpuState, workers: 2, gpu: false });
  const logs: string[] = [];
  const cc0 = process.env.CC;
  process.env.CC = cc;
  try {
    const gpu = await runSnnPbt({ ...opts, tapeDir: tmpDir(), stateDir: gpuState, workers: 3, gpu: { python: python!, cpu: true }, log: (m) => logs.push(m) });
    assert.deepEqual(ranks(gpu), ranks(cpu));
  } finally {
    if (cc0 === undefined) delete process.env.CC; else process.env.CC = cc0;
  }
  assert.ok(logs.some((m) => /SNN GPU group: \d+ member/.test(m)), logs.join('\n'));
  // The members' saved networks too.
  for (const f of fs.readdirSync(cpuState).filter((x) => /^m\d+\.json$/.test(x))) assert.equal(fs.readFileSync(path.join(gpuState, f), 'utf8'), fs.readFileSync(path.join(cpuState, f), 'utf8'), f);
});

test('the scheduler gives a GPU group its share of the waiting members, and falls back to the CPU when the GPU fails', async () => {
  const job = (i: number, tape = 'a.tape'): SnnReplayJob => ({ dir: '', params: params('crypto', 'S6'), domain: 'crypto', from: 0, to: 1000, fromDay: '', toDay: '', playTape: tape, checkpoint: { i } as never });
  const ran: string[] = [];
  const cpuRun = async (j: SnnReplayJob) => { ran.push(`cpu ${(j.checkpoint as never as { i: number }).i}`); return { rows: [], ms: 1000 }; };
  let fail = false, groups = 0;
  const gpuRun = async (j: Parameters<MemberScheduler['run']>[0] | { gpuGroup: { members: unknown[] } } | { gpuProbe: unknown }) => {
    if (fail) throw new Error('device lost');
    const n = 'gpuGroup' in j ? j.gpuGroup.members.length : 0;
    groups++;
    ran.push(`gpu ${n}`);
    return { outs: Array.from({ length: n }, () => ({ rows: [] })), ms: 250 * n };
  };
  const logs: string[] = [];
  const s = new MemberScheduler({ cpu: { run: cpuRun }, gpu: { run: gpuRun as never }, spec: { python: 'x' }, group: 16, groups: 1, cpuWorkers: 4, speedup: 4, log: (m) => logs.push(m) });
  // 16 members, 4 CPU workers, a GPU group worth 4 cores: half go to the GPU.
  await Promise.all(Array.from({ length: 16 }, (_, i) => s.run(job(i))));
  assert.equal(groups, 1);
  assert.ok(ran.includes('gpu 8'), ran.join(', '));
  assert.equal(ran.filter((x) => x.startsWith('cpu')).length, 8);
  // Measured: a CPU member 1 s, a GPU member 0.25 s -> 4 cores.
  assert.equal(s.speed(), 4);
  // Members the GPU cannot run, and a failing GPU: the CPU.
  ran.length = 0;
  const gap = params('crypto', 'S5');
  await s.run({ ...job(99), params: { ...gap, flags: { ...gap.flags, gapJunctions: true } } });
  assert.deepEqual(ran, ['cpu 99']);
  fail = true; ran.length = 0;
  await Promise.all(Array.from({ length: 4 }, (_, i) => s.run(job(i))));
  assert.equal(ran.length, 4);
  assert.ok(logs.some((m) => /GPU group failed/.test(m)));
});

test("the tournaments take their GPU group count from this computer's bench run, unless set", () => {
  const dir = tmpDir();
  assert.deepEqual(snnGpuShape({ DATA_DIR: dir }), { group: 16, groups: 1, speedup: 2 });
  fs.writeFileSync(path.join(dir, 'snn-gpu-bench.json'), JSON.stringify({ engine: { recommend: { groups: 3, group: 16, speedup: 2.9 } } }));
  assert.deepEqual(snnGpuShape({ DATA_DIR: dir }), { group: 16, groups: 3, speedup: 2.9 });
  assert.deepEqual(snnGpuShape({ DATA_DIR: dir, SNN_GPU_GROUPS: '2', SNN_GPU_GROUP: '8', SNN_GPU_SPEEDUP: '4' }), { group: 8, groups: 2, speedup: 4 });
});

test('members the GPU cannot run are refused (gap junctions, unported mechanisms)', () => {
  assert.deepEqual(gpuUnsupported(params('crypto', 'S6')), []);
  const gap = params('crypto', 'S5');
  assert.deepEqual(gpuUnsupported({ ...gap, flags: { ...gap.flags, gapJunctions: true } }), ['gapJunctions']);
  assert.ok(gpuUnsupported({ ...gap, flags: { ...gap.flags, dcaap: true } }).includes('dcaap'));
});

// The GPU tournament engine (research/snnGpu.ts): a group of members playing one tape with their columns in the device
// pool gets exactly the rows and networks each member gets playing the tape on the CPU. Run here with the pool's C build
// (python/snn/pool.py --cpu: the same summaries and protocol as the GPU, the serial kernel); skipped without Python or a
// C compiler.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SNN, domainParams, stageFlags, withFlags, type Stage } from '../bot/snn/params';
import { snnHyperOf, withSnnHyper } from '../bot/snn/population';
import { GpuPool, gpuUnsupported, playSnnTapeGpu } from '../research/snnGpu';
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

test('members the GPU cannot run are refused (gap junctions, unported mechanisms)', () => {
  assert.deepEqual(gpuUnsupported(params('crypto', 'S6')), []);
  const gap = params('crypto', 'S5');
  assert.deepEqual(gpuUnsupported({ ...gap, flags: { ...gap.flags, gapJunctions: true } }), ['gapJunctions']);
  assert.ok(gpuUnsupported({ ...gap, flags: { ...gap.flags, dcaap: true } }).includes('dcaap'));
});

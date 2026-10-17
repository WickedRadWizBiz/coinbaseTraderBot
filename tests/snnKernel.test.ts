// SNN column kernel (python/snn/column.cu, the GPU prototype): its exp/log/tanh are V8's to the bit, and replaying
// the TypeScript network's recorded column steps through the kernel (built as C here) ends on exactly the
// TypeScript state, stage by stage; the GPU benchmark's data layout is checked through the same C (bench.py --cpu).
// Skipped where no C compiler (or, for the layout, no Python with numpy) is installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SNN, domainParams, stageFlags, withFlags, type Stage } from '../bot/snn/params';
import { recordKernelTrace } from '../research/snnKernel';
import { replaySnn } from '../research/snnReplay';
import { writeSyntheticRecordings } from '../research/synthetic';
import { tmpDir } from './helpers';

const cc = ['cc', 'gcc', 'clang'].find((c) => spawnSync(c, ['--version']).status === 0);
const build = (src: string, out: string, extra: string[] = []) => {
  const r = spawnSync(cc!, ['-O2', '-ffp-contract=off', '-fno-fast-math', ...extra, src, '-o', out, '-lm'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};

test('fdlibm.h computes exp, log and tanh exactly as V8 does', { skip: !cc && 'no C compiler' }, () => {
  const dir = tmpDir(), src = path.join(dir, 'm.c'), bin = path.join(dir, 'm');
  fs.writeFileSync(src, `#include <stdio.h>\n#include "${path.resolve('python/snn/fdlibm.h')}"\nint main(void){ double x; while (fread(&x,8,1,stdin)==1){ double o[3]={fd_exp(x),fd_log(x),fd_tanh(x)}; fwrite(o,8,3,stdout);} return 0; }\n`);
  build(src, bin);
  const n = 200_000, xs = new Float64Array(n);
  let s = 7;
  const r = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 2 ** 32; };
  for (let i = 0; i < n; i++) { const k = i % 5; xs[i] = k === 0 ? (r() - 0.5) * 1500 : k === 1 ? (r() - 0.5) * 20 : k === 2 ? (r() - 0.5) * 1e-6 : k === 3 ? r() * 1e6 : (r() - 0.5) * 2; }
  xs.set([0, -0, 1, -1, Infinity, -Infinity, NaN, 709.78, -745.2, 1e-310, 22, -22, 0.5 * Math.LN2]);
  const out = new Float64Array(new Uint8Array(spawnSync(bin, { input: Buffer.from(xs.buffer), maxBuffer: 1 << 28 }).stdout).buffer);
  const f = [Math.exp, Math.log, Math.tanh];
  let bad = 0;
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) if (!Object.is(out[3 * i + k], f[k](xs[i])) && !(Number.isNaN(out[3 * i + k]) && Number.isNaN(f[k](xs[i])))) bad++;
  assert.equal(bad, 0);
});

test('the column kernel replays the TypeScript network bit for bit (crypto S2-S6, perps S6), and so does the GPU layout', { skip: !cc && 'no C compiler' }, async () => {
  const dir = tmpDir(), rec = path.join(dir, 'rec'), bin = path.join(dir, 'parity');
  build(path.resolve('python/snn/parity.c'), bin);
  writeSyntheticRecordings(rec, { windows: 3, seed: 3 });
  const cases: ['crypto' | 'perps', Stage][] = [['crypto', 'S2'], ['crypto', 'S3'], ['crypto', 'S5'], ['crypto', 'S6'], ['perps', 'S6']];
  for (const [domain, stage] of cases) {
    const trace = path.join(dir, `${domain}-${stage}.bin`);
    const params = domainParams(domain, withFlags(DEFAULT_SNN, stageFlags(stage)));
    const t = await recordKernelTrace(trace, () => replaySnn(rec, { params, domain, skipModel: true }));
    assert.ok(t.calls > 1000 && t.columns >= 2);
    const r = spawnSync(bin, [trace], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${domain} ${stage}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /bit-identical/);
  }
  const numpy = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import numpy'], { encoding: 'utf8' }).status === 0);
  if (numpy) {
    const r = spawnSync(numpy, [path.resolve('python/snn/bench.py'), path.join(dir, 'crypto-S6.bin'), '--cpu', '--members', '1,3'], { encoding: 'utf8', env: { ...process.env, CC: cc } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal((r.stdout.match(/every member bit-identical/g) ?? []).length, 2);
  }
});

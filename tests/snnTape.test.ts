// SNN input tapes (research/snnTape.ts): a member playing the tape gets exactly the rows and the network
// its own replay would have produced.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SNN, domainParams, stageFlags, withFlags } from '../bot/snn/params';
import { snnHyperOf, withSnnHyper } from '../bot/snn/population';
import { runSnnPbt } from '../research/snnPbt';
import { replaySnn } from '../research/snnReplay';
import { playSnnTape, pruneTapes, recordSnnTape, tapeFile } from '../research/snnTape';
import { writeSyntheticRecordings } from '../research/synthetic';
import { tmpDir } from './helpers';

const params = (domain: 'crypto' | 'perps', seed = 3) => domainParams(domain, withFlags({ ...DEFAULT_SNN, nE: 24, nI: 6, nL1: 10, seed }, stageFlags('S5')));

for (const domain of ['crypto', 'perps'] as const) {
  test(`a ${domain} tape plays back bit for bit as the replay, from scratch and from a checkpoint`, async () => {
    const dir = tmpDir();
    writeSyntheticRecordings(dir, { windows: 6, seed: 7 });
    const file = path.join(tmpDir(), 'span.tape');
    await recordSnnTape(dir, file, { params: params(domain), domain, skipModel: true });
    const a = await replaySnn(dir, { params: params(domain), domain, skipModel: true });
    const b = playSnnTape(file, { params: params(domain), domain });
    assert.ok(a.rows.length > 0 && a.steps > 1000);
    assert.equal(b.steps, a.steps);
    assert.equal(JSON.stringify(b.rows), JSON.stringify(a.rows));
    assert.equal(JSON.stringify(b.net.serialize()), JSON.stringify(a.net.serialize()));
    // A tournament member: another member's knobs, continuing from a saved network.
    const cp = a.net.serialize(), other = withSnnHyper(params(domain), Object.fromEntries(Object.entries(snnHyperOf(params(domain))).map(([k, v]) => [k, v * 1.05])));
    const c = await replaySnn(dir, { params: other, domain, skipModel: true, checkpoint: cp, allowParamChange: true });
    const d = playSnnTape(file, { params: other, domain, checkpoint: cp, allowParamChange: true });
    assert.equal(JSON.stringify(d.rows), JSON.stringify(c.rows));
    assert.equal(JSON.stringify(d.net.serialize()), JSON.stringify(c.net.serialize()));
  });
}

test('tape files are keyed by their recordings and the cache drops the least recently used', () => {
  const rec = tmpDir(), tapes = tmpDir();
  writeSyntheticRecordings(rec, { windows: 2, seed: 1 });
  const day = fs.readdirSync(rec)[0].match(/\d{4}-\d{2}-\d{2}/)![0];
  const span = { domain: 'crypto' as const, from: 0, to: 1, fromDay: day, toDay: day };
  const f1 = tapeFile(tapes, rec, span, 'env');
  assert.equal(tapeFile(tapes, rec, span, 'env'), f1);
  assert.notEqual(tapeFile(tapes, rec, span, 'env2'), f1);
  assert.notEqual(tapeFile(tapes, rec, { ...span, to: 2 }, 'env'), f1);
  const old = path.join(tapes, 'a.tape'), mid = path.join(tapes, 'b.tape'), cur = path.join(tapes, 'c.tape');
  for (const [f, t] of [[old, 1], [mid, 2], [cur, 3]] as const) { fs.writeFileSync(f, Buffer.alloc(100)); fs.utimesSync(f, t, t); }
  assert.equal(pruneTapes(tapes, 150, [old]), 2);
  assert.deepEqual(fs.readdirSync(tapes).sort(), ['a.tape']);
});

test('an SNN tournament on tapes ranks its members exactly as on the recordings, in process and on worker threads', async () => {
  const rec = tmpDir();
  for (let d = 0; d < 3; d++) writeSyntheticRecordings(rec, { windows: 3, seed: 21 + d, start: Date.parse('2026-02-01T00:00:00Z') + d * 86_400_000 });
  const days = ['2026-02-01', '2026-02-02', '2026-02-03'];
  const opts = { recordings: rec, domain: 'crypto' as const, stage: 'S1' as const, days, initDays: 1, evalDays: 1, population: 3 };
  const ranks = (r: Awaited<ReturnType<typeof runSnnPbt>>) => r.log.map((x) => x.ranking.map((y) => `${y.member}:${y.fitness}`));
  const plain = await runSnnPbt(opts);
  const logs: string[] = [];
  const tapeDir = tmpDir();
  const inProc = await runSnnPbt({ ...opts, tapeDir, log: (m) => logs.push(m) });
  assert.deepEqual(ranks(inProc), ranks(plain));
  assert.equal(logs.filter((m) => /SNN tape .* recorded once/.test(m)).length, 3, 'one tape per replayed span: the first day trains, two days judged');
  assert.equal(fs.readdirSync(tapeDir).filter((f) => f.endsWith('.tape')).length, 3);
  const threaded = await runSnnPbt({ ...opts, tapeDir: tmpDir(), workers: 2 });
  assert.deepEqual(ranks(threaded), ranks(plain));
});

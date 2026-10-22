import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { latestPipelineReport } from '../bot/autotrain';
import { buildDataset, buildDatasetMain, readDataset } from '../research/buildDataset';
import { writeSyntheticRecordings } from '../research/synthetic';
import { tmpDir } from './helpers';

test('the dataset streams to its file as contracts settle: the same rows as in memory, none held', async () => {
  const root = tmpDir(), dir = path.join(root, 'rec'), out = path.join(root, 'work', 'dataset.jsonl');
  writeSyntheticRecordings(dir, { windows: 6, seed: 5 });
  const mem = await buildDataset(dir, 15);
  const streamed: unknown[] = [];
  const kept = await buildDataset(dir, 15, 5e-5, { onRow: (r) => streamed.push(r) });
  assert.equal(kept.length, 0, 'with onRow nothing accumulates');
  assert.equal(streamed.length, mem.length);
  await buildDatasetMain((k, d) => ({ recordings: dir, out, every: '15' } as Record<string, string>)[k] ?? d);
  const { rows, total } = await readDataset(out);
  assert.equal(total, mem.length);
  assert.deepEqual(rows.map((r) => [r.ticker, r.t, r.label]), mem.map((r) => [r.ticker, r.t, r.label]));
  assert.ok(!fs.readdirSync(path.dirname(out)).some((n) => n.endsWith('.tmp')), 'no temporary file left');
});

test('over maxRows each contract keeps an evenly spaced share of its snapshots, and every contract stays', async () => {
  const root = tmpDir(), file = path.join(root, 'd.jsonl');
  const lines: string[] = [];
  for (let c = 0; c < 20; c++) for (let i = 0; i < 50; i++) lines.push(JSON.stringify({ t: i * 15_000, ticker: `KX-${c}`, fx: { a: i === 3 ? null : i }, label: c % 2 }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const all = await readDataset(file);
  assert.equal(all.rows.length, 1000);
  assert.ok(Number.isNaN(all.rows[3].fx.a), 'null features read back as NaN');
  const thin = await readDataset(file, 200);
  assert.equal(thin.total, 1000);
  assert.equal(thin.rows.length, 200);
  const per = new Map<string, number[]>();
  for (const r of thin.rows) per.set(r.ticker, [...(per.get(r.ticker) ?? []), r.t]);
  assert.equal(per.size, 20, 'every contract kept');
  // Shares are rounded down: never over the cap.
  const uneven = await readDataset(file, 333);
  assert.ok(uneven.rows.length <= 333, `rows=${uneven.rows.length}`);
  for (const ts of per.values()) {
    assert.equal(ts.length, 10);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]);
    assert.ok(gaps.every((g) => g === 75_000), `evenly spaced: ${gaps}`);
  }
});

test('the newest pipeline report is summarized for the dashboard (the remote run, copied back with the models)', () => {
  const dir = tmpDir();
  assert.equal(latestPipelineReport(dir), null);
  fs.mkdirSync(path.join(dir, 'reports'));
  const write = (name: string, r: unknown) => fs.writeFileSync(path.join(dir, 'reports', name), JSON.stringify(r));
  write('pipeline-2026-10-20T07-20-00-000Z.json', { at: '2026-10-20T07:20:00.000Z', complete: true, steps: [] });
  write('pipeline-2026-10-21T13-02-00-000Z.json', {
    at: '2026-10-21T13:02:00.000Z', complete: false,
    steps: [{ step: 'vol_model', ok: true, skipped: 'not enough' }, { step: 'dataset', ok: true }, { step: 'mlp', ok: true, detail: { promoted: true } }, { step: 'perps', ok: false }],
  });
  assert.deepEqual(latestPipelineReport(dir), { at: '2026-10-21T13:02:00.000Z', complete: false, steps: 4, promoted: ['mlp'], failed: ['perps'] });
});

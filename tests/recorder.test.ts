import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { loadConfig } from '../bot/config';
import { Recorder } from '../bot/marketdata/marketData';
import { capRecordings, recordingFiles, recordingLines } from '../bot/marketdata/recordingFiles';
import { tmpDir } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The `i` of every line of a day file, in file order (a torn line is skipped, as the readers skip it). */
async function iOf(file: string): Promise<number[]> {
  const out: number[] = [];
  for await (const l of recordingLines(file)) { try { out.push(JSON.parse(l).i); } catch { /* torn */ } }
  return out;
}
const upTo = (n: number, from = 0) => Array.from({ length: n - from }, (_, k) => from + k);

test('recorder: the day is written as gzip members while it is recorded, readable at any time, whole after close', async () => {
  const dir = tmpDir();
  const rec = new Recorder(dir, { memberMs: 20, memberBytes: 300 });
  for (let i = 0; i < 40; i++) rec.write('trade', { i, pad: 'x'.repeat(20) });
  await sleep(200);
  const [day] = recordingFiles(dir);
  assert.match(path.basename(day.file), /^md-\d{4}-\d{2}-\d{2}\.jsonl\.gz$/);
  assert.deepEqual(await iOf(day.file), upTo(40), 'every line so far, in order, across several members');
  for (let i = 40; i < 45; i++) rec.write('trade', { i });
  rec.close();
  assert.deepEqual(await iOf(day.file), upTo(45), 'close() writes the lines still in memory');
  assert.equal(zlib.gunzipSync(fs.readFileSync(day.file)).toString('utf8').trim().split('\n').length, 45, 'a plain gunzip reads every member');
});

test('recorder: close() writes the members still in memory in order and once, the one being compressed included', async () => {
  const dir = tmpDir();
  const rec = new Recorder(dir, { memberMs: 1_000_000, memberBytes: 50 });
  for (let i = 0; i < 30; i++) rec.write('index', { i }); // a member every two lines: one compressing, the rest queued
  rec.close();
  await sleep(100); // the compression already under way finishes after close(): it must not append a second copy
  assert.deepEqual(await iOf(recordingFiles(dir)[0].file), upTo(30));
});

test('recorder: each UTC day gets its own file, the lines before midnight staying in the old day', async () => {
  const dir = tmpDir();
  let t = Date.UTC(2026, 9, 24, 23, 59, 58);
  const rec = new Recorder(dir, { now: () => t, memberMs: 1_000_000, memberBytes: 1e9 });
  rec.write('index', { i: 1 });
  t += 1000;
  rec.write('index', { i: 2 });
  t += 2000;
  rec.write('index', { i: 3 });
  rec.close();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['md-2026-10-24.jsonl.gz', 'md-2026-10-25.jsonl.gz']);
  assert.deepEqual(await iOf(path.join(dir, 'md-2026-10-24.jsonl.gz')), [1, 2]);
  assert.deepEqual(await iOf(path.join(dir, 'md-2026-10-25.jsonl.gz')), [3]);
});

test('recorder: a day keeps the form it was begun in, so it never splits over two files', async () => {
  const t = Date.UTC(2026, 9, 24, 12);
  const now = () => t;
  // Begun plain (a bot from before gzip writing): plain until midnight, when the night's compression gzips it whole.
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'md-2026-10-24.jsonl'), JSON.stringify({ t: 1, k: 'index', i: 0 }) + '\n');
  const a = new Recorder(dir, { now });
  a.write('index', { i: 1 });
  a.write('index', { i: 2 });
  a.close();
  await sleep(50);
  assert.deepEqual(fs.readdirSync(dir), ['md-2026-10-24.jsonl']);
  assert.deepEqual(await iOf(path.join(dir, 'md-2026-10-24.jsonl')), [0, 1, 2]);
  // Begun as gzip, then gzip writing turned off: gzip until midnight.
  const dir2 = tmpDir();
  const b = new Recorder(dir2, { now });
  b.write('index', { i: 1 });
  b.close();
  const c = new Recorder(dir2, { now, gzip: false });
  c.write('index', { i: 2 });
  c.close();
  await sleep(50);
  assert.deepEqual(fs.readdirSync(dir2), ['md-2026-10-24.jsonl.gz']);
  assert.deepEqual(await iOf(path.join(dir2, 'md-2026-10-24.jsonl.gz')), [1, 2], 'a restart appends members to the same file');
  // Off from the start: plain, as before.
  const dir3 = tmpDir();
  const d = new Recorder(dir3, { now, gzip: false });
  d.write('index', { i: 1 });
  d.close();
  await sleep(50);
  assert.deepEqual(fs.readdirSync(dir3), ['md-2026-10-24.jsonl']);
});

test('recordings: a gzipped day cut short inside a member is read up to the cut instead of failing the read', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'md-2026-10-24.jsonl.gz');
  const member = (a: number, b: number) => zlib.gzipSync(upTo(b, a).map((i) => JSON.stringify({ t: i, k: 'index', i })).join('\n') + '\n');
  const torn = member(200, 300);
  fs.writeFileSync(file, Buffer.concat([member(0, 100), member(100, 200), torn.subarray(0, torn.length - 30)]));
  const got = await iOf(file);
  assert.deepEqual(got.slice(0, 200), upTo(200), 'the whole members');
  assert.ok(got.length < 300 && got.every((x, k) => x === k), 'then what the torn member still holds, nothing invented');
});

test('recordings: only the newest RECORDINGS_KEEP_DAYS days are kept, today included, both forms of a day going together', () => {
  const dir = tmpDir();
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']) fs.writeFileSync(path.join(dir, `md-${d}.jsonl.gz`), 'x');
  fs.writeFileSync(path.join(dir, 'md-2026-10-01.jsonl'), 'x'); // a half-finished gzip
  assert.deepEqual(capRecordings(dir, 0), [], '0 = no cap');
  assert.deepEqual(capRecordings(dir, 3), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['md-2026-10-03.jsonl.gz', 'md-2026-10-04.jsonl.gz', 'md-2026-10-05.jsonl.gz']);
  assert.deepEqual(capRecordings(dir, 1), ['2026-10-03'], 'never fewer than two days');
  assert.deepEqual(capRecordings(dir, 3), []);
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40) });
  assert.equal(cfg.autoTrain.recordingsKeepDays, 20);
  assert.equal(cfg.autoTrain.recordingsGzipLive, true);
  assert.throws(() => loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), RECORDINGS_KEEP_DAYS: '-1' }));
});

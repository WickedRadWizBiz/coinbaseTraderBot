import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readJson, setQuarantineAll, writeJsonAtomic } from '../bot/util/persist';
import { PaperExchange } from '../bot/paper/paperExchange';
import { DEFAULT_FEES } from '../bot/fees';
import { pruneRecordings } from '../bot/marketdata/recordingFiles';

test('a truncated state file: rebuildable state is moved aside and starts fresh; risk state still refuses to start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-'));
  const file = path.join(dir, 'paper.json');
  fs.writeFileSync(file, '{"balance": 100, "fills": [{"ticker": "KXBTC'); // cut off mid-write
  assert.throws(() => readJson(file), /does not parse/);
  assert.equal(readJson(file, { quarantine: true }), undefined);
  assert.ok(!fs.existsSync(file), 'the damaged file is out of the way');
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('paper.json.corrupt-')).length, 1, 'and kept for inspection');
});

test('the paper exchange starts on a damaged state file instead of crash-looping', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperx-'));
  const file = path.join(dir, 'paper_state.json');
  fs.writeFileSync(file, '{"balance": 50, "positions": {"X": ');
  const px = new PaperExchange(file, 100, () => undefined, () => DEFAULT_FEES);
  assert.ok(px, 'started with a fresh paper book');
});

test('atomic writes land whole and leave no temp file behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistw-'));
  const file = path.join(dir, 'big.json');
  const value = { rows: Array.from({ length: 50_000 }, (_, i) => ({ i, s: 'x'.repeat(20), u: 'é' })) };
  writeJsonAtomic(file, value, { compact: true });
  assert.deepEqual(readJson(file), value);
  assert.deepEqual(fs.readdirSync(dir), ['big.json']);
});

test('a low disk deletes the oldest recorded days first and never the newest two', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recprune-'));
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']) fs.writeFileSync(path.join(dir, `md-${d}.jsonl${d < '2026-10-04' ? '.gz' : ''}`), 'x');
  let free = 1;
  const gone = pruneRecordings(dir, 3, 2, () => free++);
  assert.deepEqual(gone, ['2026-10-01', '2026-10-02'], 'stops once enough is free');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['md-2026-10-03.jsonl.gz', 'md-2026-10-04.jsonl', 'md-2026-10-05.jsonl']);
  assert.deepEqual(pruneRecordings(dir, 100, 2, () => 0), ['2026-10-03'], 'however low the disk, the newest two days stay');
  assert.deepEqual(pruneRecordings(dir, 100, 2, () => undefined), [], 'nothing is deleted when free space is unknown');
});

test('paper mode: even risk state that does not parse is moved aside; live mode keeps it strict', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistq-'));
  const file = path.join(dir, 'oms_state.json');
  fs.writeFileSync(file, '{"orders": [');
  assert.throws(() => readJson(file), /does not parse/, 'live (the default)');
  setQuarantineAll(true);
  try { assert.equal(readJson(file), undefined); } finally { setQuarantineAll(false); }
  assert.ok(!fs.existsSync(file));
});

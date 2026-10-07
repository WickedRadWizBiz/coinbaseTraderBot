import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { AuditLog } from '../bot/audit/auditLog';
import { tmpDir } from './helpers';

test('audit log is hash-chained, resumes across restarts, and detects tampering', () => {
  const dir = path.join(tmpDir(), 'audit');
  const now = () => Date.parse('2026-09-29T12:00:00Z');
  const a = new AuditLog(dir, 100, now);
  a.write('startup', { x: 1 });
  a.write('decision', { y: 2 });
  const b = new AuditLog(dir, 100, now);
  const r = b.write('shutdown', {});
  assert.equal(r.seq, 3);
  const file = path.join(dir, 'audit-2026-09-29.jsonl');
  assert.equal(AuditLog.verifyFile(file), null);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[1] = lines[1].replace('"y":2', '"y":3');
  fs.writeFileSync(file, lines.join('\n'));
  assert.equal(AuditLog.verifyFile(file), 2);
});

test('audit log: startup reads only the tail of a huge day file (a 600 MB file once crash-looped the bot)', () => {
  const dir = path.join(tmpDir(), 'audit');
  fs.mkdirSync(dir, { recursive: true });
  const now = () => Date.parse('2026-10-06T22:00:00Z');
  // Write a real chained record, then grow the file to 600 MB sparsely (no disk used) and end it with
  // that record again, as the last line: the old resume read the whole file into one string and threw.
  const a = new AuditLog(path.join(tmpDir(), 'seed'), 100, now);
  const rec = a.write('decision', { x: 1 });
  const file = path.join(dir, 'audit-2026-10-06.jsonl');
  fs.writeFileSync(file, '');
  fs.truncateSync(file, 600 * 1024 * 1024);
  fs.appendFileSync(file, '\n' + JSON.stringify(rec) + '\n');
  const t0 = Date.now();
  const b = new AuditLog(dir, 100, now, { maxFileBytes: 256 * 1024 * 1024 });
  assert.ok(Date.now() - t0 < 2000, 'tail read only');
  const next = b.write('shutdown', {});
  assert.equal(next.seq, rec.seq + 1);
  assert.equal(next.prev, rec.hash, 'the chain continues from the last record');
  // The 600 MB part is over the size limit: the new record went to the next part.
  assert.ok(fs.existsSync(path.join(dir, 'audit-2026-10-06.1.jsonl')));
  assert.equal(fs.statSync(file).size, 600 * 1024 * 1024 + JSON.stringify(rec).length + 2, 'the big part is not written to');
  fs.rmSync(file, { force: true });
});

test('audit log: parts by size, chain across parts and restarts, retention, torn and empty tails', async () => {
  const { auditFiles, lastLine } = await import('../bot/audit/auditLog');
  const dir = path.join(tmpDir(), 'audit');
  let t = Date.parse('2026-09-01T10:00:00Z');
  const now = () => t;
  const a = new AuditLog(dir, 100, now, { maxFileBytes: 2000, retentionDays: 10 });
  const recs = Array.from({ length: 40 }, (_, i) => a.write('decision', { i, pad: 'x'.repeat(60) }));
  const parts = auditFiles(dir);
  assert.ok(parts.length >= 3, `split into parts: ${parts.length}`);
  assert.deepEqual(parts.map((p) => p.part), parts.map((_, i) => i), 'ordered by part number (.10 after .9)');
  for (const p of parts) { assert.equal(AuditLog.verifyFile(p.file), null); assert.ok(fs.statSync(p.file).size <= 2000); }
  // Restart: resumes from the newest part's last record, keeps writing there.
  const b = new AuditLog(dir, 100, now, { maxFileBytes: 2000, retentionDays: 10 });
  const r = b.write('startup', {});
  assert.equal(r.prev, recs[recs.length - 1].hash);
  assert.equal(r.seq, 41);
  // Day change: a new file, and files older than the retention are deleted.
  t = Date.parse('2026-09-20T00:00:01Z');
  b.write('decision', {});
  assert.ok(auditFiles(dir).every((f) => f.day >= '2026-09-10'), 'old days removed');
  assert.ok(fs.existsSync(path.join(dir, 'audit-2026-09-20.jsonl')));
  // lastLine edge cases.
  const f = path.join(tmpDir(), 'x.jsonl');
  fs.writeFileSync(f, ''); assert.equal(lastLine(f), undefined);
  fs.writeFileSync(f, '\n\n'); assert.equal(lastLine(f), undefined);
  fs.writeFileSync(f, 'only'); assert.equal(lastLine(f), 'only');
  fs.writeFileSync(f, 'a\nb\n\n'); assert.equal(lastLine(f), 'b');
  fs.writeFileSync(f, 'a\n{"torn'); assert.equal(lastLine(f), '{"torn');
  fs.writeFileSync(f, 'a\n' + 'é'.repeat(100_000) + '\n'); assert.equal(lastLine(f, 64), 'é'.repeat(100_000), 'multi-byte line across reads');
  // A torn last record starts a new chain segment.
  const d2 = path.join(tmpDir(), 'audit2');
  fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(path.join(d2, 'audit-2026-09-01.jsonl'), '{"seq":5,"ha');
  const c = new AuditLog(d2, 100, () => Date.parse('2026-09-01T11:00:00Z'));
  assert.equal(c.write('startup', {}).prev, 'torn-tail');
});

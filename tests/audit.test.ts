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

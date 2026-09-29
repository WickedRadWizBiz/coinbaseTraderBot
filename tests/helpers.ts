import fs from 'fs';
import os from 'os';
import path from 'path';
import { AuditLog } from '../bot/audit/auditLog';

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-'));
}

export function tmpAudit(): AuditLog {
  return new AuditLog(path.join(tmpDir(), 'audit'));
}

export function near(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol;
}

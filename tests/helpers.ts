import fs from 'fs';
import os from 'os';
import path from 'path';
import { AuditLog } from '../bot/audit/auditLog';
import type { ExchangeStatusMonitor } from '../bot/kalshi/exchangeStatus';

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-'));
}

export function tmpAudit(): AuditLog {
  return new AuditLog(path.join(tmpDir(), 'audit'));
}

export function near(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol;
}

/** An exchange whose schedule is known and open: engine tests then do not depend on the wall clock (without a
 *  schedule the engine blocks entries around Kalshi's Thursday 3-5 AM ET maintenance window). */
export function openExchange(): ExchangeStatusMonitor {
  return { scheduleKnown: () => true, entryBlock: () => undefined, perpsBlock: () => undefined } as unknown as ExchangeStatusMonitor;
}

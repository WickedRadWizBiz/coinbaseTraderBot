import fs from 'fs';
import os from 'os';
import path from 'path';
import { AuditLog } from '../bot/audit/auditLog';
import type { ExchangeStatusMonitor } from '../bot/kalshi/exchangeStatus';
import { recordingFiles, recordingLines } from '../bot/marketdata/recordingFiles';

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

/** One recording folder holding every day of `dirs`, each day's lines in time order (a recorded day carries every feed). */
export async function mergeRecordingDays(out: string, dirs: string[]): Promise<void> {
  const byDay = new Map<string, Array<{ t: number; line: string }>>();
  for (const d of dirs) {
    for (const f of recordingFiles(d)) {
      const day = byDay.get(f.day) ?? byDay.set(f.day, []).get(f.day)!;
      for await (const line of recordingLines(f.file)) if (line) day.push({ t: JSON.parse(line).t, line });
    }
  }
  fs.mkdirSync(out, { recursive: true });
  for (const [day, rows] of byDay) fs.writeFileSync(path.join(out, `md-${day}.jsonl`), rows.sort((a, b) => a.t - b.t).map((r) => r.line).join('\n') + '\n');
}

// The recordings folder: one file per UTC day, md-YYYY-MM-DD.jsonl while the day is being written,
// gzipped to md-YYYY-MM-DD.jsonl.gz once it is a few days old (about a tenth of the size), so months of
// recordings fit on the server's disk. Every reader goes through here and reads both forms.

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';

const RE = /^md-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;

export interface RecordingDay { day: string; file: string }

/** Recorded days in a folder, sorted (the plain file wins when both forms exist). */
export function recordingFiles(dir: string): RecordingDay[] {
  if (!fs.existsSync(dir)) return [];
  const by = new Map<string, string>();
  for (const f of fs.readdirSync(dir)) {
    const m = RE.exec(f);
    if (!m) continue;
    if (!by.has(m[1]) || !m[2]) by.set(m[1], f);
  }
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, f]) => ({ day, file: path.join(dir, f) }));
}

/** Just the days. */
export const recordingDayList = (dir: string): string[] => recordingFiles(dir).map((d) => d.day);

/** Lines of a day file (gzipped or not). */
export function recordingLines(file: string): readline.Interface {
  const raw = fs.createReadStream(file);
  return readline.createInterface({ input: file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw, crlfDelay: Infinity });
}

/** Link the given days into `dest` under their own names (for tools that take a folder). */
export function linkDays(days: RecordingDay[], dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const d of days) {
    const src = path.resolve(d.file), to = path.join(dest, path.basename(d.file));
    // Windows refuses symlinks without developer mode: a hard link, else a copy.
    try { fs.symlinkSync(src, to); } catch { try { fs.linkSync(src, to); } catch { fs.copyFileSync(src, to); } }
  }
}

/** Gzip every plain day file older than `keepPlainDays` days (never today's). Returns the days compressed. */
export async function compressOldRecordings(dir: string, keepPlainDays: number, now = Date.now()): Promise<string[]> {
  const cutoff = new Date(now - keepPlainDays * 86_400_000).toISOString().slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);
  const done: string[] = [];
  if (!fs.existsSync(dir)) return done;
  for (const f of fs.readdirSync(dir)) {
    const m = RE.exec(f);
    if (!m || m[2] || m[1] >= cutoff || m[1] >= today) continue;
    const src = path.join(dir, f), dst = `${src}.gz`, tmp = `${dst}.tmp`;
    await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp, { mode: 0o600 }));
    fs.renameSync(tmp, dst);
    fs.rmSync(src);
    done.push(m[1]);
  }
  return done;
}

/** Free bytes on the disk holding `dir` (undefined when unknown). */
export function freeBytesAt(dir: string): number | undefined {
  try { const s = fs.statfsSync(fs.existsSync(dir) ? dir : '.'); return s.bavail * s.bsize; } catch { return undefined; }
}

/** Delete the oldest recorded days until `targetFreeBytes` are free on the disk, never touching the newest
 *  `keepDays` days. A full disk stops the bot from writing its state and from starting at all; losing the
 *  oldest training days is the lesser harm. Returns the days deleted. */
export function pruneRecordings(dir: string, targetFreeBytes: number, keepDays = 2, free: () => number | undefined = () => freeBytesAt(dir)): string[] {
  const deleted: string[] = [];
  const days = recordingFiles(dir).slice(0, -Math.max(1, keepDays));
  for (const d of days) {
    const f = free();
    if (f === undefined || f >= targetFreeBytes) break;
    // Both forms of the day, if both exist (a half-finished gzip).
    for (const file of [d.file, d.file.endsWith('.gz') ? d.file.slice(0, -3) : `${d.file}.gz`, `${d.file.replace(/\.gz$/, '')}.gz.tmp`]) {
      try { fs.rmSync(file); } catch { /* not there */ }
    }
    deleted.push(d.day);
  }
  return deleted;
}

/** Disk use of the recordings and free space where they live (free is undefined when unknown). */
export function recordingsUsage(dir: string): { days: number; bytes: number; freeBytes?: number } {
  const files = recordingFiles(dir);
  let bytes = 0;
  for (const d of files) { try { bytes += fs.statSync(d.file).size; } catch { /* raced */ } }
  return { days: files.length, bytes, freeBytes: freeBytesAt(dir) };
}

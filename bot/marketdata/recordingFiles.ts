// The recordings folder: one file per UTC day, md-YYYY-MM-DD.jsonl.gz, written as gzip while the day is recorded
// (one gzip member every few seconds, bot/marketdata/marketData.ts Recorder), about a tenth of the plain size at every
// hour. A day begun plain (RECORDINGS_GZIP_LIVE=false, or a bot from before it) is md-YYYY-MM-DD.jsonl until it is
// gzipped after midnight. Every reader goes through here and reads both forms, today's file included.

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

/** Gunzip for a day file: today's may end in a member still being written (or one a crash cut short), which is read
 *  up to where it stops instead of failing the whole read. */
export const dayGunzip = (): zlib.Gunzip => zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });

/** Lines of a day file (gzipped or not). */
export function recordingLines(file: string): readline.Interface {
  const raw = fs.createReadStream(file);
  return readline.createInterface({ input: file.endsWith('.gz') ? raw.pipe(dayGunzip()) : raw, crlfDelay: Infinity });
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

/** Gzip every plain day file except the newest `keepPlainDays` days, today included (1 = only today stays plain:
 *  yesterday is compressed right after midnight). Never today's. Returns the days compressed. */
export async function compressOldRecordings(dir: string, keepPlainDays: number, now = Date.now()): Promise<string[]> {
  const cutoff = new Date(now - Math.max(0, keepPlainDays - 1) * 86_400_000).toISOString().slice(0, 10);
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
    removeDay(d);
    deleted.push(d.day);
  }
  return deleted;
}

/** Both forms of the day, if both exist (a half-finished gzip). */
function removeDay(d: RecordingDay): void {
  for (const file of [d.file, d.file.endsWith('.gz') ? d.file.slice(0, -3) : `${d.file}.gz`, `${d.file.replace(/\.gz$/, '')}.gz.tmp`]) {
    try { fs.rmSync(file); } catch { /* not there */ }
  }
}

/** Keep only the newest `keepDays` recorded days, today included (RECORDINGS_KEEP_DAYS; 0 = no cap, and never fewer
 *  than two): the owner's plan of Oct 24 keeps 14-20 days on the server for the sweep's recorded-day checks, the disk
 *  floor above still guarding the disk. Returns the days deleted. */
export function capRecordings(dir: string, keepDays: number): string[] {
  if (!(keepDays > 0)) return [];
  const days = recordingFiles(dir);
  const old = days.slice(0, Math.max(0, days.length - Math.max(2, Math.floor(keepDays))));
  for (const d of old) removeDay(d);
  return old.map((d) => d.day);
}

/** Below `floorBytes` free: the oldest days go until twice that is free, never the newest two; still below a quarter
 *  of the floor, yesterday goes too (only today is kept). The bot cannot start or save its state on a full disk, which
 *  is worse than losing a recorded day. Returns the days deleted. */
export function makeRecordingsRoom(dir: string, floorBytes: number, free: () => number | undefined = () => freeBytesAt(dir)): string[] {
  if ((free() ?? Infinity) >= floorBytes) return [];
  const gone = pruneRecordings(dir, 2 * floorBytes, 2, free);
  if ((free() ?? Infinity) < floorBytes / 4) gone.push(...pruneRecordings(dir, 2 * floorBytes, 1, free));
  return gone;
}

/** Disk use of the recordings and free space where they live (free is undefined when unknown). */
export function recordingsUsage(dir: string): { days: number; bytes: number; freeBytes?: number } {
  const files = recordingFiles(dir);
  let bytes = 0;
  for (const d of files) { try { bytes += fs.statSync(d.file).size; } catch { /* raced */ } }
  return { days: files.length, bytes, freeBytes: freeBytesAt(dir) };
}

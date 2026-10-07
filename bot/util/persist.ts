import fs from 'fs';
import path from 'path';

/** Per-file write counts and bytes since start (status: guards.cpu.stateWrites), to spot write amplification. */
const writes = new Map<string, { n: number; bytes: number; ms: number }>();

export function stateWriteStats(): Array<{ file: string; n: number; mb: number; ms: number }> {
  return [...writes].map(([file, w]) => ({ file, n: w.n, mb: +(w.bytes / 1e6).toFixed(2), ms: Math.round(w.ms) })).sort((a, b) => b.mb - a.mb);
}

/** Atomic JSON write: write a temp file, rename it over the target. A crash mid-write leaves the old file.
 *  `compact` drops the indentation (large, frequently written state: the write and the parse cost scale
 *  with its size). `durable` also fsyncs before the rename, so the write survives a power loss / kernel
 *  crash too; it costs a disk round trip on the calling thread, so it is only for state that must never
 *  go back in time (the OMS write-ahead record of an order about to be sent, the kill switch). Everything
 *  else is rebuilt or re-fetched on restart, and the page cache already survives a process crash. */
export function writeJsonAtomic(file: string, value: unknown, o: { compact?: boolean; durable?: boolean } = {}): void {
  const t0 = performance.now();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const text = o.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    if (o.durable) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  const w = writes.get(path.basename(file)) ?? { n: 0, bytes: 0, ms: 0 };
  w.n++; w.bytes += text.length; w.ms += performance.now() - t0;
  writes.set(path.basename(file), w);
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

import fs from 'fs';
import path from 'path';
import { logger } from './log';

const log = logger('persist');

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
  const buf = Buffer.from(text, 'utf8');
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    // writeSync may write only part of the buffer (a full disk, a signal); keep going until all of it is
    // down, and never rename a short temp file over the good one.
    for (let off = 0; off < buf.length;) {
      const n = fs.writeSync(fd, buf, off, buf.length - off);
      if (n <= 0) throw new Error(`short write to ${tmp}: ${off} of ${buf.length} bytes`);
      off += n;
    }
    if (o.durable) fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
  const w = writes.get(path.basename(file)) ?? { n: 0, bytes: 0, ms: 0 };
  w.n++; w.bytes += text.length; w.ms += performance.now() - t0;
  writes.set(path.basename(file), w);
}

let quarantineAll = false;
/** Paper mode: every state file is rebuildable (paper orders, a paper vault), so any damaged one is moved
 *  aside instead of stopping the bot. Live mode keeps risk state strict. */
export function setQuarantineAll(on: boolean): void { quarantineAll = on; }

/** Read a JSON state file; undefined when it does not exist. A file that does not parse throws, unless
 *  `quarantine` is set: state the bot can rebuild (paper books, health windows, statistics) is then moved
 *  aside to `<file>.corrupt-<time>` and read as missing, so one damaged file cannot keep the bot from
 *  starting. Risk state (kill switch, order records, vault, equity guard) keeps throwing: starting without
 *  it could forget an engaged brake or an order in flight. */
export function readJson<T>(file: string, o: { quarantine?: boolean } = {}): T | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    if (!(o.quarantine ?? quarantineAll)) throw new Error(`${file} does not parse (${(e as Error).message})`);
    const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(file, aside);
    log.warn(`${file} does not parse (${(e as Error).message}); moved to ${aside}, starting it fresh`);
    return undefined;
  }
}

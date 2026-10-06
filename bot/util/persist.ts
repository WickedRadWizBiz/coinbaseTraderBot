import fs from 'fs';
import path from 'path';

/** Atomic JSON write: write temp file, fsync, rename. Survives crash mid-write. `compact` drops the
 *  indentation (large, frequently written state: the write and the parse cost scale with its size). */
export function writeJsonAtomic(file: string, value: unknown, o: { compact?: boolean } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, o.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

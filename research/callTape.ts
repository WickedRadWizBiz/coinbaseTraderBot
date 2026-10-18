// A tape of the backtester's model calls (research/backtest.ts), so a sweep pays for them once.
//
// Every second the backtester prices each open contract, builds the full feature map and asks the model for its
// probability: three quarters of a Kalshi backtest's time. None of that depends on the strategy settings a sweep moves
// (edges, buffers, sizing): the calls come in the same order with the same answers whatever they are. The first run
// over a window records each call's answer (the model's probability and spread, plus the few features read after it);
// every later run over the same window and model plays them back, checking each call's time and contract on the way,
// and starts over without the tape at the first mismatch.
//
// Layout: <file> holds chunks [u32 length][raw deflate of float64 rows]; <file>.json (written last, so a tape without
// it is unfinished) holds the signature, the extra feature keys and the call count. Rows: time, contract hash, the
// fair value the call was made on (recomputed by every run: a tape from other data stops at the first call), the
// model's probability, has-spread, spread, then one value per key.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

export const TAPE_SCHEMA = 'ktape2';
const ROWS_PER_CHUNK = 65_536;
const BASE = 6;

export class TapeMiss extends Error {}

export interface TapeCall { p: number; std: number | undefined; x: Float64Array; at: number }

export const tickerHash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
};

interface Meta { schema: string; sig: string; keys: string[]; calls: number }
const readMeta = (file: string): Meta | undefined => { try { return JSON.parse(fs.readFileSync(`${file}.json`, 'utf8')) as Meta; } catch { return undefined; } };

export class TapeWriter {
  readonly mode = 'record' as const;
  private readonly fd: number;
  private readonly tmp: string;
  private buf: Float64Array;
  private n = 0;
  private calls = 0;
  constructor(private readonly file: string, private readonly sig: string, readonly keys: string[]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    this.fd = fs.openSync(this.tmp, 'w');
    this.buf = new Float64Array(ROWS_PER_CHUNK * (BASE + keys.length));
  }
  push(at: number, ticker: number, fv: number, p: number, std: number | undefined, x: ArrayLike<number>): void {
    const W = BASE + this.keys.length, o = this.n * W;
    this.buf[o] = at; this.buf[o + 1] = ticker; this.buf[o + 2] = fv; this.buf[o + 3] = p; this.buf[o + 4] = std === undefined ? 0 : 1; this.buf[o + 5] = std ?? 0;
    for (let k = 0; k < this.keys.length; k++) this.buf[o + BASE + k] = x[k];
    this.calls++;
    if (++this.n === ROWS_PER_CHUNK) this.flush();
  }
  private flush(): void {
    if (!this.n) return;
    const W = BASE + this.keys.length;
    const z = zlib.deflateRawSync(Buffer.from(this.buf.buffer, 0, this.n * W * 8), { level: 1 });
    const len = Buffer.alloc(4); len.writeUInt32LE(z.length);
    fs.writeSync(this.fd, len); fs.writeSync(this.fd, z);
    this.n = 0;
  }
  /** Writes the tape (another process may have written the same one first: either copy is the same). */
  finish(): void {
    this.flush();
    fs.closeSync(this.fd);
    try {
      fs.renameSync(this.tmp, this.file);
      const meta: Meta = { schema: TAPE_SCHEMA, sig: this.sig, keys: this.keys, calls: this.calls };
      const mt = `${this.tmp}.json`;
      fs.writeFileSync(mt, JSON.stringify(meta));
      fs.renameSync(mt, `${this.file}.json`);
    } catch { fs.rmSync(this.tmp, { force: true }); }
  }
  abort(): void { try { fs.closeSync(this.fd); } catch { /* closed */ } fs.rmSync(this.tmp, { force: true }); }
}

export class TapeReader {
  readonly mode = 'replay' as const;
  private readonly fd: number;
  private rows = new Float64Array(0);
  private i = 0;
  private n = 0;
  private read = 0;
  private readonly W: number;
  private readonly x: Float64Array;
  constructor(file: string, readonly keys: string[], private readonly calls: number) {
    this.fd = fs.openSync(file, 'r');
    this.W = BASE + keys.length;
    this.x = new Float64Array(keys.length);
  }
  private chunk(): boolean {
    const len = Buffer.alloc(4);
    if (fs.readSync(this.fd, len, 0, 4, null) < 4) return false;
    const z = Buffer.alloc(len.readUInt32LE());
    if (fs.readSync(this.fd, z, 0, z.length, null) < z.length) return false;
    const b = zlib.inflateRawSync(z);
    this.rows = new Float64Array(b.buffer, b.byteOffset, b.length / 8);
    this.n = this.rows.length / this.W; this.i = 0;
    return true;
  }
  /** The next call's answer; throws TapeMiss when the run has drifted from the tape. */
  next(at: number, ticker: number, fv: number): TapeCall {
    if (this.i >= this.n && !this.chunk()) throw new TapeMiss('the run made more model calls than the tape holds');
    const o = this.i * this.W;
    if (this.rows[o] !== at || this.rows[o + 1] !== ticker || this.rows[o + 2] !== fv) throw new TapeMiss(`call ${this.read} differs from the tape`);
    this.i++; this.read++;
    for (let k = 0; k < this.keys.length; k++) this.x[k] = this.rows[o + BASE + k];
    return { p: this.rows[o + 3], std: this.rows[o + 4] ? this.rows[o + 5] : undefined, x: this.x, at };
  }
  /** At the end of the run: every call on the tape was made. */
  finish(): void {
    fs.closeSync(this.fd);
    if (this.read !== this.calls) throw new TapeMiss(`the run made ${this.read} of the tape's ${this.calls} model calls`);
  }
  abort(): void { try { fs.closeSync(this.fd); } catch { /* closed */ } }
}

/** The finished tape at `file` when it matches (then its time is touched, for the size cap), else a writer for it. */
export function openTape(file: string, sig: string, keys: string[]): TapeReader | TapeWriter {
  const m = readMeta(file);
  if (m && m.schema === TAPE_SCHEMA && m.sig === sig && JSON.stringify(m.keys) === JSON.stringify(keys) && fs.existsSync(file)) {
    try { const now = new Date(); fs.utimesSync(`${file}.json`, now, now); } catch { /* read-only */ }
    return new TapeReader(file, keys, m.calls);
  }
  return new TapeWriter(file, sig, keys);
}

export function dropTape(file: string): void { fs.rmSync(file, { force: true }); fs.rmSync(`${file}.json`, { force: true }); }

/** Keeps the tapes in `dir` within `maxBytes`, least recently used first out. */
export function pruneTapes(dir: string, maxBytes: number): void {
  let files: { f: string; size: number; t: number }[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.tape')).map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      let t = st.mtimeMs;
      try { t = fs.statSync(`${p}.json`).mtimeMs; } catch { /* unfinished */ }
      return { f: p, size: st.size, t };
    });
    // Left by a run that was stopped while recording.
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.tmp')) { const p = path.join(dir, f); try { if (Date.now() - fs.statSync(p).mtimeMs > 6 * 3_600_000) fs.rmSync(p, { force: true }); } catch { /* gone */ } }
  } catch { return; }
  files.sort((a, b) => b.t - a.t);
  let total = 0;
  for (const x of files) { total += x.size; if (total > maxBytes) dropTape(x.f); }
}

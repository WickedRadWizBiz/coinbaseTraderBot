// SNN input tapes: the crypto and perps networks are a pure function of the calls the replay makes to them
// (research/snnReplay.ts): one step per market second with the columns' inputs, a batch of contract queries
// every scoring second, and a settlement per contract. Everything that produces those calls (reading the
// recordings, the books, the index trackers, the feature maps, pricing every contract) is the same for
// every member of a tournament, and it is a third or more of each replay. A tape records those calls once
// per span; each member then plays the tape on its own network: the same calls in the same order, so its
// rows and its network come out bit for bit as from its own replay (tests/snnTape.test.ts).
//
// Tapes are kept under work/snn-tape/<domain> keyed by everything their content depends on (the span, the
// recording files, the TA network and history store the features read, the decision model's pricing
// knobs, this code), and the oldest are deleted past SNN_TAPE_CACHE_GB (default 10).
//
// Format: "SNNTAPE" + version byte, then frames [u32 length][raw deflate of whole ops]. Ops: a string or a
// column layout (declared before first use), a step (each input's changed fields only), a score batch
// (queries plus each row's market context), a settlement, the end.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { threadId } from 'worker_threads';
import { recordingFiles } from '../bot/marketdata/recordingFiles';
import { SnnNetwork, type ColumnInput, type ContractQuery, type SnnCheckpoint, type SnnModelFile } from '../bot/snn/network';
import type { SnnDomain, SnnParams } from '../bot/snn/params';
import { directionRows, replaySnn, type SnnReplayOpts, type SnnReplayResult, type SnnRow } from './snnReplay';

export const TAPE_VERSION = 1;
const MAGIC = Buffer.from('SNNTAPE');
const OP_STR = 1, OP_COL = 2, OP_STEP = 3, OP_SCORE = 4, OP_SETTLE = 5, OP_END = 6;
const FRAME = 1 << 20;
const INPUT_KEYS = 'key,asset,price,mid,values';

/** What the replay calls on the tape (research/snnReplay.ts). */
export interface SnnTapeSink {
  step(T: number, inputs: ColumnInput[]): void;
  score(T: number, queries: ContractQuery[], ctx: { pYes: number; mid: number; asset: string }[]): void;
  settle(ticker: string, label: 0 | 1 | undefined, now: number): void;
}

class Out {
  buf = Buffer.allocUnsafe(FRAME * 2);
  n = 0;
  private room(k: number) {
    if (this.n + k <= this.buf.length) return;
    const b = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.n + k));
    this.buf.copy(b, 0, 0, this.n);
    this.buf = b;
  }
  u8(x: number) { this.room(1); this.buf[this.n++] = x; }
  vu(x: number) { this.room(5); while (x >= 0x80) { this.buf[this.n++] = (x & 0x7f) | 0x80; x >>>= 7; } this.buf[this.n++] = x; }
  f64(x: number) { this.room(8); this.buf.writeDoubleLE(x, this.n); this.n += 8; }
  bytes(b: Buffer) { this.room(b.length); b.copy(this.buf, this.n); this.n += b.length; }
}

/** Records a replay's network calls to `file` (written under a temporary name, renamed by close()). */
export class TapeWriter implements SnnTapeSink {
  private readonly tmp: string;
  private readonly fd: number;
  private readonly o = new Out();
  private readonly strs = new Map<string, number>();
  private readonly cols = new Map<string, { id: number; schema: string; fields: string[]; prev: (number | undefined)[] }>();
  private nCols = 0;
  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.tmp = `${file}.tmp-${process.pid}-${threadId}`;
    this.fd = fs.openSync(this.tmp, 'w');
    fs.writeSync(this.fd, Buffer.concat([MAGIC, Buffer.from([TAPE_VERSION])]));
  }

  private str(s: string): number {
    let id = this.strs.get(s);
    if (id === undefined) {
      id = this.strs.size;
      this.strs.set(s, id);
      const b = Buffer.from(s, 'utf8');
      this.o.u8(OP_STR); this.o.vu(b.length); this.o.bytes(b);
    }
    return id;
  }

  private col(inp: ColumnInput) {
    if (Object.keys(inp).join(',') !== INPUT_KEYS || !inp.values) throw new Error(`snn tape: unsupported column input layout (${Object.keys(inp).join(',')})`);
    const vk = Object.keys(inp.values), schema = vk.join(',');
    let c = this.cols.get(inp.key);
    if (c && c.schema === schema) return c;
    const fields = ['price', 'mid', ...vk];
    if (fields.length > 31) throw new Error('snn tape: more than 31 input fields');
    const ids = [this.str(inp.key), this.str(inp.asset), ...vk.map((k) => this.str(k))];
    c = { id: this.nCols++, schema, fields, prev: fields.map(() => NaN) };
    this.cols.set(inp.key, c);
    this.o.u8(OP_COL); this.o.vu(c.id); this.o.vu(ids[0]); this.o.vu(ids[1]); this.o.vu(vk.length);
    for (const id of ids.slice(2)) this.o.vu(id);
    return c;
  }

  step(T: number, inputs: ColumnInput[]): void {
    const cs = inputs.map((x) => this.col(x));
    const o = this.o;
    o.u8(OP_STEP); o.f64(T); o.vu(inputs.length);
    for (let i = 0; i < inputs.length; i++) {
      const c = cs[i], inp = inputs[i], v = inp.values!;
      let changed = 0, undef = 0;
      const now: (number | undefined)[] = [inp.price, inp.mid];
      for (let k = 2; k < c.fields.length; k++) now.push(v[c.fields[k]]);
      for (let k = 0; k < now.length; k++) {
        const a = now[k], b = c.prev[k];
        // Changed unless the same value (bitwise: NaN stays NaN; +0 and -0 differ).
        if (a === undefined ? b === undefined : b !== undefined && Object.is(a, b)) continue;
        changed |= 1 << k;
        if (a === undefined) undef |= 1 << k;
      }
      o.vu(c.id); o.vu(changed >>> 0); o.vu(undef >>> 0);
      for (let k = 0; k < now.length; k++) if (changed & (1 << k) && !(undef & (1 << k))) o.f64(now[k]!);
      c.prev = now;
    }
    this.flush();
  }

  score(T: number, queries: ContractQuery[], ctx: { pYes: number; mid: number; asset: string }[]): void {
    const ids = queries.map((q, i) => [this.str(q.ticker), this.str(q.column), this.str(q.kind), this.str(q.eventKey), this.str(ctx[i].asset)]);
    const o = this.o;
    o.u8(OP_SCORE); o.f64(T); o.vu(queries.length);
    queries.forEach((q, i) => {
      const [t, c, k, e, a] = ids[i];
      o.vu(t); o.vu(c); o.vu(k); o.vu(e); o.vu(a);
      o.u8((q.strike !== undefined ? 1 : 0) | (q.cap !== undefined ? 2 : 0) | (q.tag ? 4 : 0));
      if (q.strike !== undefined) o.f64(q.strike);
      if (q.cap !== undefined) o.f64(q.cap);
      o.f64(q.spot); o.f64(q.sigma); o.f64(q.tauSec); o.f64(q.lifeSec); o.f64(ctx[i].pYes); o.f64(ctx[i].mid);
    });
    this.flush();
  }

  settle(ticker: string, label: 0 | 1 | undefined, now: number): void {
    const t = this.str(ticker);
    this.o.u8(OP_SETTLE); this.o.vu(t); this.o.u8(label ?? 2); this.o.f64(now);
    this.flush();
  }

  private flush(force = false): void {
    if (!force && this.o.n < FRAME) return;
    if (!this.o.n) return;
    const z = zlib.deflateRawSync(this.o.buf.subarray(0, this.o.n), { level: 1 });
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32LE(z.length, 0);
    fs.writeSync(this.fd, len);
    fs.writeSync(this.fd, z);
    this.o.n = 0;
  }

  /** Ends the tape and puts it in place. */
  close(): void {
    this.o.u8(OP_END);
    this.flush(true);
    fs.closeSync(this.fd);
    fs.renameSync(this.tmp, this.file);
  }

  /** Drops a tape that did not finish. */
  abort(): void {
    try { fs.closeSync(this.fd); } catch { /* closed */ }
    fs.rmSync(this.tmp, { force: true });
  }
}

export const TAPE_OP = { STEP: OP_STEP, SCORE: OP_SCORE, SETTLE: OP_SETTLE } as const;
export type TapeOp = Op;
type Op =
  | { op: typeof OP_STEP; T: number; inputs: ColumnInput[] }
  | { op: typeof OP_SCORE; T: number; queries: ContractQuery[]; ctx: { pYes: number; mid: number; asset: string }[] }
  | { op: typeof OP_SETTLE; ticker: string; label: 0 | 1 | undefined; now: number };

/** The network calls of a tape, in order. */
export function* readTape(file: string): Generator<Op> {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length + 1);
    fs.readSync(fd, head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC) || head[MAGIC.length] !== TAPE_VERSION) throw new Error(`${file}: not an SNN tape (version ${TAPE_VERSION})`);
    let pos = head.length;
    const strs: string[] = [];
    const cols: { key: string; asset: string; fields: string[]; prev: (number | undefined)[] }[] = [];
    const len = Buffer.alloc(4);
    for (;;) {
      if (fs.readSync(fd, len, 0, 4, pos) < 4) throw new Error(`${file}: tape ends early`);
      const zl = len.readUInt32LE(0), z = Buffer.allocUnsafe(zl);
      if (fs.readSync(fd, z, 0, zl, pos + 4) < zl) throw new Error(`${file}: tape ends early`);
      pos += 4 + zl;
      const b = zlib.inflateRawSync(z);
      let i = 0;
      const vu = () => { let x = 0, s = 0, c: number; do { c = b[i++]; x += (c & 0x7f) * 2 ** s; s += 7; } while (c & 0x80); return x; };
      const f64 = () => { const x = b.readDoubleLE(i); i += 8; return x; };
      while (i < b.length) {
        const op = b[i++];
        if (op === OP_STR) { const n = vu(); strs.push(b.toString('utf8', i, i + n)); i += n; }
        else if (op === OP_COL) {
          const id = vu(), key = strs[vu()], asset = strs[vu()], n = vu();
          const fields = ['price', 'mid'];
          for (let k = 0; k < n; k++) fields.push(strs[vu()]);
          cols[id] = { key, asset, fields, prev: fields.map(() => NaN) };
        } else if (op === OP_STEP) {
          const T = f64(), n = vu();
          const inputs: ColumnInput[] = [];
          for (let k = 0; k < n; k++) {
            const c = cols[vu()], changed = vu(), undef = vu();
            const now = c.prev.slice();
            for (let f = 0; f < c.fields.length; f++) if (changed & (1 << f)) now[f] = undef & (1 << f) ? undefined : f64();
            c.prev = now;
            const values: Record<string, number | undefined> = {};
            for (let f = 2; f < c.fields.length; f++) values[c.fields[f]] = now[f];
            inputs.push({ key: c.key, asset: c.asset, price: now[0], mid: now[1], values });
          }
          yield { op: OP_STEP, T, inputs };
        } else if (op === OP_SCORE) {
          const T = f64(), n = vu();
          const queries: ContractQuery[] = [], ctx: { pYes: number; mid: number; asset: string }[] = [];
          for (let k = 0; k < n; k++) {
            const ticker = strs[vu()], column = strs[vu()], kind = strs[vu()], eventKey = strs[vu()], asset = strs[vu()], fl = b[i++];
            const strike = fl & 1 ? f64() : undefined, cap = fl & 2 ? f64() : undefined;
            const spot = f64(), sigma = f64(), tauSec = f64(), lifeSec = f64(), pYes = f64(), mid = f64();
            queries.push({ ticker, column, kind, strike, cap, spot, sigma, tauSec, lifeSec, eventKey, tag: Boolean(fl & 4) });
            ctx.push({ pYes, mid, asset });
          }
          yield { op: OP_SCORE, T, queries, ctx };
        } else if (op === OP_SETTLE) {
          const ticker = strs[vu()], l = b[i++], now = f64();
          yield { op: OP_SETTLE, ticker, label: l === 2 ? undefined : (l as 0 | 1), now };
        } else if (op === OP_END) return;
        else throw new Error(`${file}: bad tape op ${op}`);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Records the tape of one span (the replay without the network). */
export async function recordSnnTape(dir: string, file: string, o: Omit<SnnReplayOpts, 'tape' | 'tapeOnly'>): Promise<void> {
  const w = new TapeWriter(file);
  try {
    await replaySnn(dir, { ...o, tape: w, tapeOnly: true });
    w.close();
  } catch (e) {
    w.abort();
    throw e;
  }
}

export interface PlayOpts {
  params: SnnParams; domain?: SnnDomain; snnModel?: SnnModelFile; whitelist?: string[];
  checkpoint?: SnnCheckpoint; allowParamChange?: boolean; from?: number;
}

/** A replay from its tape: the same network calls and rows as replaySnn with skipModel (p_model = the
 *  fair value). The asset-choice ranking and the training hooks are not on tapes. */
export function playSnnTape(file: string, o: PlayOpts): SnnReplayResult {
  const m = new TapeMember(o);
  for (const x of readTape(file)) {
    if (x.op === OP_SETTLE) m.settle(x);
    else if (x.op === OP_STEP) {
      const t0 = performance.now();
      m.net.step(x.T, x.inputs);
      m.stepped(performance.now() - t0);
    } else m.score(x);
  }
  return m.result();
}

/** One member playing a tape: its network, and the rows it scores (shared by the CPU player and the GPU group,
 *  research/snnGpu.ts, which steps the networks itself). */
export class TapeMember {
  readonly net: SnnNetwork;
  private readonly pending = new Map<string, Omit<SnnRow, 'y'>[]>();
  private readonly rows: SnnRow[] = [];
  private readonly stepMs: number[] = [];
  private readonly volRef = new Map<string, number>();
  private steps = 0;
  private frozenSteps = 0;

  constructor(private readonly o: PlayOpts, net?: SnnNetwork) {
    this.net = net ?? new SnnNetwork(o.params, { whitelist: o.whitelist, model: o.snnModel });
    this.net.dirLog = [];
    if (o.checkpoint) this.net.restore(o.checkpoint, { allowParamChange: o.allowParamChange });
    if (o.from && this.net.lastTs > o.from) this.net.rewind();
  }

  settle(x: Extract<Op, { op: typeof OP_SETTLE }>): void {
    const ps = this.pending.get(x.ticker) ?? [];
    this.pending.delete(x.ticker);
    if (x.label === undefined) return;
    for (const r of ps) this.rows.push({ ...r, y: x.label });
    this.net.settle(x.ticker, x.label ? 'yes' : 'no', x.now);
  }

  stepped(ms: number): void {
    this.steps++;
    if (this.net.health.freezeLearning) this.frozenSteps++;
    this.stepMs.push(ms);
  }

  score(x: Extract<Op, { op: typeof OP_SCORE }>): void {
    const T = x.T, day = new Date(T).toISOString().slice(0, 10);
    const at = new Map(x.queries.map((q, i) => [q.ticker, i]));
    for (const s of this.net.score(x.queries, T)) {
      const i = at.get(s.ticker)!, q = x.queries[i], c = x.ctx[i];
      if (!q.tag) continue;
      const ref = this.volRef.get(c.asset) ?? q.sigma;
      this.volRef.set(c.asset, ref + (1 - Math.exp(-1 / 1440)) * (q.sigma - ref));
      const arr = this.pending.get(s.ticker) ?? [];
      arr.push({ ticker: s.ticker, eventKey: s.eventKey, column: s.column, ts: T, day, kind: q.kind, pModel: c.pYes, pSnn: s.p, mid: c.mid, surprise: s.surprise, surprise0: s.surprise0, G: s.G, volRatio: q.sigma / ref });
      this.pending.set(s.ticker, arr);
    }
  }

  result(): SnnReplayResult {
    const rows = this.rows.slice();
    if ((this.o.domain ?? 'crypto') === 'perps') rows.push(...directionRows(this.net.dirLog));
    return { rows, net: this.net, stepMs: this.stepMs, frozenSteps: this.frozenSteps, steps: this.steps, ranking: [], collected: [] };
  }
}

// ---- cache --------------------------------------------------------------------------------------

const statSig = (f: string | undefined) => {
  if (!f) return '';
  try { const s = fs.statSync(f); return `${f}:${s.size}:${Math.floor(s.mtimeMs)}`; } catch { return `${f}:-`; }
};
/** Top-level files of a folder (the history store's series files). */
const dirSig = (d: string | undefined) => {
  if (!d || !fs.existsSync(d)) return '';
  const h = crypto.createHash('sha1');
  const walk = (p: string, depth: number) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) { if (depth < 2) walk(f, depth + 1); } else h.update(statSig(f));
    }
  };
  walk(d, 0);
  return h.digest('hex');
};

export interface TapeSpan { domain: SnnDomain; from: number; to: number; fromDay: string; toDay: string }

/** Everything a span's tape depends on besides the span itself, computed once per tournament: the code,
 *  the TA network file the features read, the history store, the decision model's file (its t
 *  degrees of freedom price the contracts). */
export function tapeEnvSig(o: { modelPath?: string; env?: NodeJS.ProcessEnv; code?: string } = {}): string {
  const env = o.env ?? process.env;
  const historyDir = path.resolve(env.HISTORY_DIR ?? path.join(env.DATA_DIR ?? './data', 'history'));
  return crypto.createHash('sha1').update(JSON.stringify([TAPE_VERSION, statSig(o.code ?? process.argv[1]), statSig(env.TA_NET_PATH), dirSig(historyDir), statSig(o.modelPath)])).digest('hex');
}

/** The tape file of a span. */
export function tapeFile(tapeDir: string, recordings: string, span: TapeSpan, envSig: string): string {
  const files = recordingFiles(recordings).filter((f) => f.day >= span.fromDay && f.day <= span.toDay).map((f) => statSig(f.file));
  const key = crypto.createHash('sha1').update(JSON.stringify([envSig, span, files])).digest('hex').slice(0, 20);
  return path.join(tapeDir, `${span.fromDay}_${span.toDay}_${key}.tape`);
}

/** Deletes the least recently used tapes past `capBytes` (never `keep`). */
export function pruneTapes(tapeDir: string, capBytes: number, keep: string[] = []): number {
  if (!fs.existsSync(tapeDir)) return 0;
  const fl = fs.readdirSync(tapeDir).filter((f) => f.endsWith('.tape')).map((f) => { const p = path.join(tapeDir, f); const s = fs.statSync(p); return { p, size: s.size, t: s.mtimeMs }; }).sort((a, b) => a.t - b.t);
  let total = fl.reduce((a, f) => a + f.size, 0), removed = 0;
  for (const f of fl) {
    if (total <= capBytes) break;
    if (keep.includes(f.p)) continue;
    fs.rmSync(f.p, { force: true });
    total -= f.size;
    removed++;
  }
  return removed;
}

/** Marks a tape used (the cache deletes the least recently used first). */
export function touchTape(file: string): void {
  const t = new Date();
  try { fs.utimesSync(file, t, t); } catch { /* gone: rebuilt on next use */ }
}

export const tapeCacheBytes = (env: NodeJS.ProcessEnv = process.env) => (Number(env.SNN_TAPE_CACHE_GB) > 0 ? Number(env.SNN_TAPE_CACHE_GB) : 10) * 2 ** 30;

const spanLabel = (s: TapeSpan) => { const a = new Date(s.from).toISOString().slice(0, 10), b = new Date(s.to - 1).toISOString().slice(0, 10); return a === b ? a : `${a}..${b}`; };

/** The tapes of one run (a tournament, a contest): each span's tape is recorded once (`build`) however
 *  many members ask for it at once, reused from disk when its inputs have not changed, and the cache is
 *  kept under its cap. A tape that cannot be recorded is logged and the members replay the recordings. */
export class TapeCache {
  private readonly memo = new Map<string, Promise<string | undefined>>();
  private readonly recent: string[] = [];
  constructor(private readonly o: {
    dir: string; recordings: string; envSig: string; build: (span: TapeSpan, file: string) => Promise<void>;
    capBytes?: number; log?: (m: string) => void;
  }) {}

  get(span: TapeSpan): Promise<string | undefined> {
    // One tape per span for the whole run, even while a recording in it is still growing (today's file).
    const k = JSON.stringify(span);
    let p = this.memo.get(k);
    if (!p) {
      const file = tapeFile(this.o.dir, this.o.recordings, span, this.o.envSig);
      p = (async () => {
        if (fs.existsSync(file)) touchTape(file);
        else {
          try {
            const t0 = Date.now();
            await this.o.build(span, file);
            this.o.log?.(`${span.domain} SNN tape ${spanLabel(span)}: recorded once for every member in ${((Date.now() - t0) / 1000).toFixed(0)} s (${(fs.statSync(file).size / 2 ** 20).toFixed(1)} MB)`);
          } catch (e) {
            this.o.log?.(`${span.domain} SNN tape ${spanLabel(span)} could not be recorded (${(e as Error).message.split('\n')[0]}); members replay the recordings`);
            return undefined; // the rest of this run replays the recordings for this span
          }
        }
        this.recent.push(file);
        if (this.recent.length > 4) this.recent.shift();
        const removed = pruneTapes(this.o.dir, this.o.capBytes ?? tapeCacheBytes(), this.recent);
        if (removed) this.o.log?.(`SNN tape cache: removed ${removed} least recently used tape(s) (cap ${((this.o.capBytes ?? tapeCacheBytes()) / 2 ** 30).toFixed(0)} GB, SNN_TAPE_CACHE_GB)`);
        return file;
      })();
      this.memo.set(k, p);
      return p;
    }
    // Recorded earlier in this run but since removed from the cache: record it again.
    return p.then((f) => (f && !fs.existsSync(f) ? (this.memo.delete(k), this.get(span)) : f));
  }
}

/** Tapes are on unless SNN_TAPES=false. */
export const tapesEnabled = (env: NodeJS.ProcessEnv = process.env) => env.SNN_TAPES !== 'false';

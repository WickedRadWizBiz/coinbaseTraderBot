// Append-only audit log (JSONL, one file per UTC day, split into parts at maxFileBytes). Every
// decision, order, ack, fill, cancel, risk rejection, reconciliation break and kill-switch event
// is written here with the model version and inputs. Each record carries the SHA-256 of the
// previous record so after-the-fact edits are detectable; the chain continues across days and parts.
//
// Files: audit-YYYY-MM-DD.jsonl, then audit-YYYY-MM-DD.1.jsonl, .2, ... once a part reaches
// maxFileBytes (a busy day once grew one file past 512 MB, more than Node can read into a string,
// and the bot could not start). On startup the chain resumes from the last line of the newest part,
// read from the file's tail only. Files older than retentionDays are deleted at each day change.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { StringDecoder } from 'string_decoder';

export type AuditKind =
  | 'startup' | 'shutdown' | 'config'
  | 'decision' | 'risk_reject'
  | 'order_new' | 'order_ack' | 'order_update' | 'order_reject' | 'order_cancel_req' | 'order_unknown'
  | 'fill' | 'settlement' | 'perp_hedge' | 'perp_order' | 'perp_decision' | 'setup_model' | 'setup_signal' | 'setup_trade' | 'setup_sizing'
  | 'recon_ok' | 'recon_break' | 'recon_repair' | 'recon_pending'
  | 'kill_engaged' | 'kill_reset' | 'kill_suppressed' | 'training'
  | 'data_stale' | 'data_gap'
  | 'vault'
  | 'snn'
  | 'alert' | 'error';

export interface AuditRecord {
  seq: number;
  ts: string;
  kind: AuditKind;
  data: unknown;
  prev: string;
  hash: string;
}

export interface AuditOptions {
  /** Start a new part of the day's file once the current one reaches this size. */
  maxFileBytes?: number;
  /** Delete audit files whose day is older than this (0 = keep everything). */
  retentionDays?: number;
}

const FILE_RE = /^audit-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;
const DAY = 86_400_000;

/** Audit files in a folder with their day and part, oldest first. */
export function auditFiles(dir: string): Array<{ file: string; day: string; part: number }> {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.flatMap((f) => { const m = FILE_RE.exec(f); return m ? [{ file: path.join(dir, f), day: m[1], part: m[2] ? Number(m[2]) : 0 }] : []; })
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.part - b.part));
}

/** The last line of a file, read from its tail only (never the whole file). undefined: the file is
 *  empty (or only newlines); '' : its last line is longer than maxLine (treated as a torn tail). */
export function lastLine(file: string, chunk = 1 << 16, maxLine = 64 << 20): string | undefined {
  const fd = fs.openSync(file, 'r');
  try {
    let pos = fs.fstatSync(fd).size;
    let buf = Buffer.alloc(0);
    for (;;) {
      let end = buf.length;
      while (end > 0 && buf[end - 1] === 0x0a) end--;
      if (end > 0) {
        const nl = buf.lastIndexOf(0x0a, end - 1);
        if (nl >= 0) return buf.subarray(nl + 1, end).toString('utf8');
        if (pos === 0) return buf.subarray(0, end).toString('utf8');
        if (end > maxLine) return '';
      } else if (pos === 0) return undefined;
      const n = Math.min(chunk, pos);
      chunk *= 2; // geometric reads: a long last line costs O(its length), not O(length^2)
      pos -= n;
      const b = Buffer.alloc(n);
      fs.readSync(fd, b, 0, n, pos);
      buf = Buffer.concat([b, buf]);
    }
  } finally {
    fs.closeSync(fd);
  }
}

export class AuditLog {
  private seq = 0;
  private prevHash = 'genesis';
  private currentDay = '';
  private currentFile = '';
  private part = 0;
  private bytes = 0;
  private readonly recent: AuditRecord[] = [];
  private readonly maxFileBytes: number;
  private readonly retentionDays: number;

  constructor(private readonly dir: string, private readonly recentCap = 500, private readonly now: () => number = Date.now, o: AuditOptions = {}) {
    this.maxFileBytes = o.maxFileBytes ?? 256 * 1024 * 1024;
    this.retentionDays = o.retentionDays ?? 30;
    fs.mkdirSync(dir, { recursive: true });
    this.resumeChain();
  }

  write(kind: AuditKind, data: unknown): AuditRecord {
    const tsMs = this.now();
    const day = new Date(tsMs).toISOString().slice(0, 10);
    if (day !== this.currentDay) this.openDay(day, tsMs);
    const body = { seq: ++this.seq, ts: new Date(tsMs).toISOString(), kind, data, prev: this.prevHash };
    const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const rec: AuditRecord = { ...body, hash };
    const line = JSON.stringify(rec) + '\n';
    if (this.bytes > 0 && this.bytes + line.length > this.maxFileBytes) {
      this.part++;
      this.currentFile = this.fileFor(day, this.part);
      this.bytes = 0;
    }
    // Synchronous append: the record is on disk before the caller proceeds
    // (e.g. before an order is sent).
    fs.appendFileSync(this.currentFile, line, { mode: 0o600 });
    this.bytes += Buffer.byteLength(line);
    this.prevHash = hash;
    this.recent.push(rec);
    if (this.recent.length > this.recentCap) this.recent.shift();
    return rec;
  }

  tail(limit = 100, kind?: AuditKind): AuditRecord[] {
    const src = kind ? this.recent.filter((r) => r.kind === kind) : this.recent;
    return src.slice(-limit);
  }

  /** Verify the hash chain of one file (line by line, any size). Returns the first bad seq, or null. */
  static verifyFile(file: string): number | null {
    const fd = fs.openSync(file, 'r');
    try {
      let prev: string | undefined;
      let rest = '';
      const b = Buffer.alloc(1 << 20);
      const dec = new StringDecoder('utf8'); // a character split across two reads stays whole
      for (;;) {
        const n = fs.readSync(fd, b, 0, b.length, null);
        const text = rest + (n > 0 ? dec.write(b.subarray(0, n)) : dec.end());
        const lines = text.split('\n');
        rest = n > 0 ? lines.pop() ?? '' : '';
        for (const line of lines) {
          if (!line) continue;
          const rec = JSON.parse(line) as AuditRecord;
          const { hash, ...body } = rec;
          const expect = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
          if (expect !== hash || (prev !== undefined && rec.prev !== prev)) return rec.seq;
          prev = hash;
        }
        if (n <= 0) return null;
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private fileFor(day: string, part: number): string {
    return path.join(this.dir, part ? `audit-${day}.${part}.jsonl` : `audit-${day}.jsonl`);
  }

  /** Continue the day's newest part (or start it), and apply retention when the day changes. */
  private openDay(day: string, tsMs: number): void {
    this.currentDay = day;
    const parts = auditFiles(this.dir).filter((f) => f.day === day);
    const last = parts[parts.length - 1];
    this.part = last?.part ?? 0;
    this.currentFile = this.fileFor(day, this.part);
    try { this.bytes = fs.statSync(this.currentFile).size; } catch { this.bytes = 0; }
    if (this.retentionDays > 0) {
      const cutoff = new Date(tsMs - this.retentionDays * DAY).toISOString().slice(0, 10);
      for (const f of auditFiles(this.dir)) if (f.day < cutoff) { try { fs.rmSync(f.file, { force: true }); } catch { /* best effort */ } }
    }
  }

  private resumeChain(): void {
    const files = auditFiles(this.dir);
    // The newest part with a line in it (an empty part can exist after a crash right after rolling).
    for (let i = files.length - 1; i >= 0; i--) {
      let line: string | undefined;
      try { line = lastLine(files[i].file); } catch { line = ''; }
      if (line === undefined) continue;
      try {
        const rec = JSON.parse(line) as AuditRecord;
        this.seq = rec.seq;
        this.prevHash = rec.hash;
      } catch {
        // A torn final line (crash mid-write) starts a new chain segment.
        this.prevHash = 'torn-tail';
      }
      return;
    }
  }
}

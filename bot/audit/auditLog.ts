// Append-only audit log (JSONL, one file per UTC day). Every decision, order,
// ack, fill, cancel, risk rejection, reconciliation break and kill-switch event
// is written here with the model version and inputs. Each record carries the
// SHA-256 of the previous record so after-the-fact edits are detectable.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type AuditKind =
  | 'startup' | 'shutdown' | 'config'
  | 'decision' | 'risk_reject'
  | 'order_new' | 'order_ack' | 'order_update' | 'order_reject' | 'order_cancel_req' | 'order_unknown'
  | 'fill' | 'settlement' | 'perp_hedge' | 'perp_order' | 'perp_decision' | 'setup_model' | 'setup_signal' | 'setup_trade'
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

export class AuditLog {
  private seq = 0;
  private prevHash = 'genesis';
  private currentDay = '';
  private currentFile = '';
  private readonly recent: AuditRecord[] = [];

  constructor(private readonly dir: string, private readonly recentCap = 500, private readonly now: () => number = Date.now) {
    fs.mkdirSync(dir, { recursive: true });
    this.resumeChain();
  }

  write(kind: AuditKind, data: unknown): AuditRecord {
    const tsMs = this.now();
    const day = new Date(tsMs).toISOString().slice(0, 10);
    if (day !== this.currentDay) {
      this.currentDay = day;
      this.currentFile = path.join(this.dir, `audit-${day}.jsonl`);
    }
    const body = { seq: ++this.seq, ts: new Date(tsMs).toISOString(), kind, data, prev: this.prevHash };
    const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const rec: AuditRecord = { ...body, hash };
    // Synchronous append: the record is on disk before the caller proceeds
    // (e.g. before an order is sent).
    fs.appendFileSync(this.currentFile, JSON.stringify(rec) + '\n', { mode: 0o600 });
    this.prevHash = hash;
    this.recent.push(rec);
    if (this.recent.length > this.recentCap) this.recent.shift();
    return rec;
  }

  tail(limit = 100, kind?: AuditKind): AuditRecord[] {
    const src = kind ? this.recent.filter((r) => r.kind === kind) : this.recent;
    return src.slice(-limit);
  }

  /** Verify the hash chain of one day's file. Returns the first bad seq, or null. */
  static verifyFile(file: string): number | null {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    let prev: string | undefined;
    for (const line of lines) {
      const rec = JSON.parse(line) as AuditRecord;
      const { hash, ...body } = rec;
      const expect = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
      if (expect !== hash || (prev !== undefined && rec.prev !== prev)) return rec.seq;
      prev = hash;
    }
    return null;
  }

  private resumeChain(): void {
    const files = fs.readdirSync(this.dir).filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    const last = files[files.length - 1];
    if (!last) return;
    const lines = fs.readFileSync(path.join(this.dir, last), 'utf8').split('\n').filter(Boolean);
    const tailLine = lines[lines.length - 1];
    if (!tailLine) return;
    try {
      const rec = JSON.parse(tailLine) as AuditRecord;
      this.seq = rec.seq;
      this.prevHash = rec.hash;
    } catch {
      // A torn final line (crash mid-write) starts a new chain segment.
      this.prevHash = 'torn-tail';
    }
  }
}

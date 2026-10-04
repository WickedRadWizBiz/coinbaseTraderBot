// Logs every maker entry quote the bot places, with its placement features, whether it filled
// within 60 s and the 60 s markout of the fill: the training data of the fill / adverse-selection
// model (bot/tca/fillModel.ts, research/trainFillModel.ts). One JSON line per quote in
// <dir>/fills-YYYY-MM-DD.jsonl, written when its 60 s outcome is known.

import fs from 'fs';
import path from 'path';
import type { BookSide } from '../kalshi/types';
import { FILL_HORIZON_SEC } from './fillModel';

export interface FillLogRow {
  t: number; ticker: string; side: BookSide; price: number; count: number;
  x: Record<string, number>;
  filled: 0 | 1;
  fillDelaySec: number | null;
  /** Side-signed markout per contract 60 s after the fill (negative = picked off); null if unfilled. */
  markout60: number | null;
}

interface Pending { row: Omit<FillLogRow, 'filled' | 'fillDelaySec' | 'markout60'>; fillTs?: number; fillPrice?: number; due: number; markoutDue?: number }

export class FillLog {
  private readonly pending: Pending[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly dir: string, private readonly midOf: (ticker: string) => number | undefined, private readonly now: () => number = Date.now, opts: { timers?: boolean } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    if (opts.timers !== false) { this.timer = setInterval(() => this.flush(), 5000); this.timer.unref(); }
  }

  /** A maker entry quote was sent. */
  onQuote(q: { ticker: string; side: BookSide; price: number; count: number; x: Record<string, number> }): void {
    const t = this.now();
    this.pending.push({ row: { t, ...q, x: Object.fromEntries(Object.entries(q.x).map(([k, v]) => [k, Number.isFinite(v) ? +v.toFixed(5) : NaN])) }, due: t + FILL_HORIZON_SEC * 1000 });
  }

  /** Any fill: the oldest open maker quote on the same ticker / side / price within its 60 s gets it. */
  onFill(f: { ticker: string; side: BookSide; price: number; isTaker: boolean; ts?: number }): void {
    if (f.isTaker) return;
    const ts = f.ts ?? this.now();
    const p = this.pending.find((x) => x.fillTs === undefined && x.row.ticker === f.ticker && x.row.side === f.side && Math.abs(x.row.price - f.price) < 1e-9 && ts <= x.due);
    if (p) { p.fillTs = ts; p.fillPrice = f.price; p.markoutDue = ts + FILL_HORIZON_SEC * 1000; }
  }

  /** Write every quote whose outcome is known (unfilled after 60 s, or filled and 60 s past the fill). */
  flush(now = this.now()): number {
    let n = 0;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      const done = p.fillTs === undefined ? now >= p.due : now >= p.markoutDue!;
      if (!done) continue;
      let markout60: number | null = null;
      if (p.fillTs !== undefined) {
        const mid = this.midOf(p.row.ticker);
        markout60 = mid === undefined ? null : (p.row.side === 'bid' ? 1 : -1) * (mid - p.fillPrice!);
      }
      const row: FillLogRow = { ...p.row, filled: p.fillTs !== undefined ? 1 : 0, fillDelaySec: p.fillTs !== undefined ? (p.fillTs - p.row.t) / 1000 : null, markout60 };
      fs.appendFileSync(path.join(this.dir, `fills-${new Date(p.row.t).toISOString().slice(0, 10)}.jsonl`), JSON.stringify(row) + '\n');
      this.pending.splice(i, 1);
      n++;
    }
    return n;
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }
}

/** All logged quotes in `dir`, oldest first. */
export function readFillLog(dir: string): FillLogRow[] {
  if (!fs.existsSync(dir)) return [];
  const rows: FillLogRow[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^fills-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      try { rows.push(JSON.parse(line) as FillLogRow); } catch { /* torn line */ }
    }
  }
  return rows.sort((a, b) => a.t - b.t);
}

// Drawdown-aware sizing and the weekly loss pause (institutional blueprint 8.4):
//  - Kelly multiplier = max(0, 1 - drawdown / ddScaleAt), drawdown measured from
//    the equity high-water mark.
//  - Pause new risk for 24 h after a 7-day loss beyond weeklyLossPause.
// Equity = cash balance + premium committed to open positions (vault/pocket
// reservations are bookkeeping, not losses). Withdrawals and deposits shift the
// high-water mark and the history by the same amount, so cash flows never
// read as drawdown or gains.

import { readJson, writeJsonAtomic } from '../util/persist';

export interface EquityGuardState {
  peak: number;
  /** Hourly equity samples (flow-adjusted), newest last, 8 days kept. */
  history: Array<{ ts: number; equity: number }>;
  pausedUntil: number;
}

export class EquityGuard {
  private st: EquityGuardState;
  private lastSave = 0;

  constructor(private readonly p: { ddScaleAt: number; weeklyLossPause: number }, private readonly file?: string) {
    this.st = (file && readJson<EquityGuardState>(file)) || { peak: 0, history: [], pausedUntil: 0 };
  }

  update(equity: number, now: number): void {
    if (!(equity > 0)) return;
    this.st.peak = Math.max(this.st.peak, equity);
    const h = this.st.history;
    if (!h.length || now - h[h.length - 1].ts >= 3_600_000) h.push({ ts: now, equity });
    else h[h.length - 1] = { ts: h[h.length - 1].ts, equity: Math.min(h[h.length - 1].equity, equity) };
    while (h.length && h[0].ts < now - 8 * 86_400_000) h.shift();
    const weekAgo = h.find((x) => x.ts >= now - 7 * 86_400_000);
    if (weekAgo && weekAgo.equity > 0 && (weekAgo.equity - equity) / weekAgo.equity >= this.p.weeklyLossPause && now >= this.st.pausedUntil) {
      this.st.pausedUntil = now + 86_400_000;
      this.save(now, true);
    }
    this.save(now);
  }

  /** A withdrawal (negative) or deposit (positive): shift every reference level. */
  onCashFlow(amount: number, now: number): void {
    if (this.st.peak > 0) this.st.peak = Math.max(0, this.st.peak + amount);
    for (const x of this.st.history) x.equity = Math.max(0, x.equity + amount);
    this.save(now, true);
  }

  drawdown(equity: number): number {
    return this.st.peak > 0 ? Math.max(0, 1 - equity / this.st.peak) : 0;
  }

  kellyScale(equity: number): number {
    return Math.max(0, 1 - this.drawdown(equity) / this.p.ddScaleAt);
  }

  paused(now: number): string | undefined {
    return now < this.st.pausedUntil ? `7-day loss beyond ${(this.p.weeklyLossPause * 100).toFixed(0)}%: new risk paused until ${new Date(this.st.pausedUntil).toISOString()}` : undefined;
  }

  status(equity: number | undefined, now: number) {
    return { peak: this.st.peak, drawdown: equity !== undefined ? this.drawdown(equity) : null, kellyScale: equity !== undefined ? this.kellyScale(equity) : null, pausedUntil: this.st.pausedUntil > now ? this.st.pausedUntil : null };
  }

  private save(now: number, force = false): void {
    if (!this.file || (!force && now - this.lastSave < 60_000)) return;
    this.lastSave = now;
    writeJsonAtomic(this.file, this.st);
  }
}

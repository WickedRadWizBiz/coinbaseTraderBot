// Loss-aware sizing and the weekly loss pause:
//  - Size multiplier (sizeScale): measured against the BREAK-EVEN reference, the cash the pool started
//    with (moved by deposits, withdrawals and training refills, never by P&L). At or above break-even the
//    bot trades at full size; as net losses grow the size shrinks linearly, reaching SIZE_FLOOR when the
//    net loss is ddScaleAt of the reference; as wins win the losses back it grows again, and once wins
//    equal losses it is back to full size. Never zero: the bot keeps trading, smaller. The same rule in
//    paper and live, with the kill-switch override on or off.
//  - kellyScale (from the high-water mark) is kept for reporting.
//  - Pause new risk for 24 h after a 7-day loss beyond weeklyLossPause (skipped by the override).
// Equity = cash balance + premium committed to open positions (vault/pocket
// reservations are bookkeeping, not losses). Withdrawals and deposits shift the
// high-water mark and the history by the same amount, so cash flows never
// read as drawdown or gains.

import { readJson, writeJsonAtomic } from '../util/persist';

/** Smallest size multiplier: deep in a drawdown the bot trades at a quarter size, never zero. */
export const SIZE_FLOOR = 0.25;

export interface EquityGuardState {
  peak: number;
  /** Break-even reference: starting cash, moved only by cash flows and training refills. */
  reference?: number;
  /** High-water mark of TRADABLE bankroll (after vault/pocket): picks the sizing tier. */
  peakTradable?: number;
  /** Hourly equity samples (flow-adjusted), newest last, 8 days kept. */
  history: Array<{ ts: number; equity: number }>;
  pausedUntil: number;
}

export class EquityGuard {
  private st: EquityGuardState;
  private lastSave = 0;

  constructor(private readonly p: { ddScaleAt: number; weeklyLossPause: number }, private readonly file?: string) {
    this.st = (file && readJson<EquityGuardState>(file)) || { peak: 0, history: [], pausedUntil: 0 };
    // State saved before the break-even reference existed: the high-water mark is the best estimate.
    if (this.st.reference === undefined && this.st.peak > 0) this.st.reference = this.st.peak;
  }

  /** `tradable`: current tradable bankroll (tier high-water mark). `weeklyLossPause`: per-tier override. */
  update(equity: number, now: number, tradable?: number, weeklyLossPause = this.p.weeklyLossPause): void {
    if (!(equity > 0)) return;
    this.st.reference ??= equity;
    this.st.peak = Math.max(this.st.peak, equity);
    if (tradable !== undefined && tradable > 0) this.st.peakTradable = Math.max(this.st.peakTradable ?? 0, tradable);
    const h = this.st.history;
    if (!h.length || now - h[h.length - 1].ts >= 3_600_000) h.push({ ts: now, equity });
    else h[h.length - 1] = { ts: h[h.length - 1].ts, equity: Math.min(h[h.length - 1].equity, equity) };
    while (h.length && h[0].ts < now - 8 * 86_400_000) h.shift();
    const weekAgo = h.find((x) => x.ts >= now - 7 * 86_400_000);
    if (weekAgo && weekAgo.equity > 0 && (weekAgo.equity - equity) / weekAgo.equity >= weeklyLossPause && now >= this.st.pausedUntil) {
      this.st.pausedUntil = now + 86_400_000;
      this.save(now, true);
    }
    this.save(now);
  }

  /** A withdrawal (negative) or deposit (positive): shift every reference level. `tradableAmount` is the
   * part that changed tradable cash (a withdrawal comes out of the vault first). */
  onCashFlow(amount: number, now: number, tradableAmount = amount): void {
    if (this.st.peak > 0) this.st.peak = Math.max(0, this.st.peak + amount);
    if (this.st.reference !== undefined) this.st.reference = Math.max(0, this.st.reference + amount);
    if (this.st.peakTradable) this.st.peakTradable = Math.max(0, this.st.peakTradable + tradableAmount);
    for (const x of this.st.history) x.equity = Math.max(0, x.equity + amount);
    this.save(now, true);
  }

  /** New training epoch (paper refill): the refilled equity is the new high-water mark; pause cleared. */
  resetEpoch(equity: number, now: number, tradable = equity): void {
    this.st = { peak: equity, reference: equity, peakTradable: tradable, history: [{ ts: now, equity }], pausedUntil: 0 };
    this.save(now, true);
  }

  drawdown(equity: number): number {
    return this.st.peak > 0 ? Math.max(0, 1 - equity / this.st.peak) : 0;
  }

  /** Net P&L against the break-even reference (negative = net loss). */
  netPnl(equity: number): number | undefined {
    return this.st.reference !== undefined ? equity - this.st.reference : undefined;
  }

  /** Size multiplier: 1 at or above break-even, down to SIZE_FLOOR at a net loss of lossAt x reference. */
  sizeScale(equity: number, lossAt = this.p.ddScaleAt, floor = SIZE_FLOOR): number {
    return breakEvenScale(this.st.reference, equity, lossAt, floor);
  }

  kellyScale(equity: number, ddScaleAt = this.p.ddScaleAt): number {
    return Math.max(0, 1 - this.drawdown(equity) / ddScaleAt);
  }

  /** Reference for the sizing tier: the tradable high-water mark (never below the current value). */
  tierReference(tradable: number): number {
    return Math.max(this.st.peakTradable ?? 0, tradable);
  }

  paused(now: number): string | undefined {
    return now < this.st.pausedUntil ? `7-day loss limit hit: new risk paused until ${new Date(this.st.pausedUntil).toISOString()}` : undefined;
  }

  status(equity: number | undefined, now: number, ddScaleAt = this.p.ddScaleAt) {
    return {
      peak: this.st.peak, peakTradable: this.st.peakTradable ?? null, reference: this.st.reference ?? null,
      netPnl: equity !== undefined ? this.netPnl(equity) ?? null : null, sizeScale: equity !== undefined ? this.sizeScale(equity, ddScaleAt) : null,
      drawdown: equity !== undefined ? this.drawdown(equity) : null, kellyScale: equity !== undefined ? this.kellyScale(equity, ddScaleAt) : null,
      pausedUntil: this.st.pausedUntil > now ? this.st.pausedUntil : null,
    };
  }

  private save(now: number, force = false): void {
    if (!this.file || (!force && now - this.lastSave < 60_000)) return;
    this.lastSave = now;
    writeJsonAtomic(this.file, this.st);
  }
}

/**
 * Break-even size scale: 1 when equity >= reference; below it, linear from 1 down to `floor` at a net
 * loss of `lossAt` x reference, then `floor`. Wins that win the losses back raise it again; at break-even
 * it is 1. Shared by the Kalshi pool (EquityGuard) and the perps margin account (BreakEven).
 */
export function breakEvenScale(reference: number | undefined, equity: number, lossAt: number, floor = SIZE_FLOOR): number {
  if (!(reference! > 0) || !Number.isFinite(equity)) return 1;
  const loss = Math.max(0, reference! - equity) / reference!;
  return 1 - (1 - floor) * Math.min(1, loss / Math.max(1e-9, lossAt));
}

/** Break-even reference for a separate account (the perps margin): set on first sight, moved by refills. */
export class BreakEven {
  private st: { reference?: number };
  constructor(private readonly file?: string) { this.st = (file && readJson<{ reference?: number }>(file)) || {}; }
  get reference(): number | undefined { return this.st.reference; }
  /** First equity seen becomes break-even. */
  observe(equity: number): void { if (this.st.reference === undefined && equity > 0) { this.st.reference = equity; this.save(); } }
  /** New epoch (training refill) or a deposit: break-even moves with the cash, not with P&L. */
  reset(equity: number): void { this.st.reference = equity; this.save(); }
  shift(amount: number): void { if (this.st.reference !== undefined) { this.st.reference = Math.max(0, this.st.reference + amount); this.save(); } }
  scale(equity: number, lossAt: number, floor = SIZE_FLOOR): number { return breakEvenScale(this.st.reference, equity, lossAt, floor); }
  private save(): void { if (this.file) writeJsonAtomic(this.file, this.st); }
}

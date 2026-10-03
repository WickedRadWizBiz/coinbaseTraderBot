// Exchange status and schedule from the exchange itself (GET /exchange/status, GET /exchange/schedule),
// instead of a hard-coded weekly maintenance guess.
//
//   status    exchange_active false = maintenance (nothing changes state); trading_active false = trading
//             paused (outside hours or halted). Polled every 30 s.
//   schedule  maintenance_windows (start / end datetimes). Polled hourly; new entries stop
//             `leadMin` minutes before a window starts (orders resting into it would sit through it).
//
// New risk is blocked while any of these hold (exits stay allowed; orders carry cancel_order_on_pause).
// The perps exchange has no schedule endpoint and trades around the clock, so it is blocked only by a
// full exchange outage (exchange_active false). When the endpoints can't be reached the monitor reports
// nothing and the engine's built-in maintenance guess stays in force.

import { logger } from '../util/log';

const log = logger('exchange-status');

export interface ExchangeStatus { exchangeActive: boolean; tradingActive: boolean; resumeTime?: number; at: number }
export interface MaintenanceWindow { start: number; end: number }

export interface ExchangeStatusSource {
  getExchangeStatus(): Promise<Record<string, any>>;
  getExchangeSchedule(): Promise<Record<string, any>>;
}

export function parseExchangeStatus(raw: Record<string, any>, now: number): ExchangeStatus | undefined {
  if (typeof raw?.exchange_active !== 'boolean' && typeof raw?.trading_active !== 'boolean') return undefined;
  const resume = raw.exchange_estimated_resume_time ? Date.parse(String(raw.exchange_estimated_resume_time)) : NaN;
  return { exchangeActive: raw.exchange_active !== false, tradingActive: raw.trading_active !== false, resumeTime: Number.isFinite(resume) ? resume : undefined, at: now };
}

export function parseMaintenanceWindows(raw: Record<string, any>): MaintenanceWindow[] {
  const rows: any[] = raw?.schedule?.maintenance_windows ?? raw?.maintenance_windows ?? [];
  return rows.map((w) => ({ start: Date.parse(String(w.start_datetime)), end: Date.parse(String(w.end_datetime)) }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .sort((a, b) => a.start - b.start);
}

export class ExchangeStatusMonitor {
  status?: ExchangeStatus;
  windows: MaintenanceWindow[] = [];
  lastError?: string;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly src: ExchangeStatusSource, private readonly o: { leadMin?: number; statusMs?: number; scheduleMs?: number } = {}) {}

  async pollStatus(now = Date.now()): Promise<void> {
    try {
      const s = parseExchangeStatus(await this.src.getExchangeStatus(), now);
      if (s && this.status && (s.tradingActive !== this.status.tradingActive || s.exchangeActive !== this.status.exchangeActive)) log.info('exchange status changed', { exchangeActive: s.exchangeActive, tradingActive: s.tradingActive });
      if (s) this.status = s;
      this.lastError = undefined;
    } catch (e) { this.lastError = `status: ${String(e)}`; }
  }

  async pollSchedule(): Promise<void> {
    try { this.windows = parseMaintenanceWindows(await this.src.getExchangeSchedule()); } catch (e) { this.lastError = `schedule: ${String(e)}`; }
  }

  start(): void {
    void this.pollStatus(); void this.pollSchedule();
    this.timers.push(setInterval(() => void this.pollStatus(), this.o.statusMs ?? 30_000), setInterval(() => void this.pollSchedule(), this.o.scheduleMs ?? 3_600_000));
    for (const t of this.timers) t.unref?.();
  }

  stop(): void { for (const t of this.timers) clearInterval(t); }

  /** Why new event-contract risk is blocked right now (undefined = not blocked). A status older than
   *  5 minutes is ignored (the poller is failing; the engine's other guards still apply). */
  entryBlock(now = Date.now()): string | undefined {
    const s = this.status && now - this.status.at < 300_000 ? this.status : undefined;
    if (s && !s.exchangeActive) return `Kalshi exchange under maintenance${s.resumeTime ? ` (estimated resume ${new Date(s.resumeTime).toISOString().slice(11, 16)} UTC)` : ''}`;
    if (s && !s.tradingActive) return 'Kalshi trading paused (exchange status)';
    const lead = (this.o.leadMin ?? 10) * 60_000;
    const w = this.windows.find((x) => now < x.end && now >= x.start - lead);
    if (w) return now >= w.start ? 'Kalshi maintenance window (exchange schedule)' : `Kalshi maintenance in ${Math.ceil((w.start - now) / 60_000)} min (exchange schedule)`;
    return undefined;
  }

  /** Perps: only a full exchange outage blocks new risk. */
  perpsBlock(now = Date.now()): string | undefined {
    const s = this.status && now - this.status.at < 300_000 ? this.status : undefined;
    return s && !s.exchangeActive ? 'Kalshi exchange under maintenance' : undefined;
  }

  /** Whether the live schedule is known (then the hard-coded weekly guess is not needed). */
  scheduleKnown(): boolean { return this.lastError === undefined && this.status !== undefined; }
}

// Persistent kill switch (FIA: "immediately disables all trading activity…
// preventing the ability to enter new orders and cancelling all working
// orders"). State is on disk, so an engaged switch survives a restart. It is
// engaged automatically (loss limit, repeated order errors, persistent
// reconciliation break, heartbeat loss) or manually from the authenticated
// API, and only a manual, authenticated reset clears it.
//
// Paper-mode training override (bot/control.ts): a suppressor may veto AUTOMATIC engagements (risk, OMS,
// reconciliation); the veto is logged as 'kill_suppressed' so training data still shows when the brake
// would have fired. Manual engagement from the dashboard is never suppressed.

import type { AuditLog } from '../audit/auditLog';
import type { Alerter } from '../alerts/alerter';
import { readJson, writeJsonAtomic } from '../util/persist';

export interface KillState {
  engaged: boolean;
  reason?: string;
  source?: string;
  engagedAt?: string;
  resetAt?: string;
  resetBy?: string;
}

export class KillSwitch {
  private state: KillState;
  private cancelAllFn: ((reason: string) => Promise<unknown>) | undefined;
  private suppressor: ((source: string) => string | undefined) | undefined;
  private lastSuppressed = new Map<string, number>();

  constructor(private readonly file: string, private readonly audit: AuditLog, private readonly alerter?: Alerter) {
    this.state = readJson<KillState>(file) ?? { engaged: false };
  }

  /** Wire the order canceller once the OMS exists. */
  bindCancelAll(fn: (reason: string) => Promise<unknown>): void {
    this.cancelAllFn = fn;
  }

  /** Veto automatic engagements: return a reason to suppress (e.g. the paper training override). */
  setSuppressor(fn: (source: string) => string | undefined): void {
    this.suppressor = fn;
  }

  /** Manual = the operator (dashboard / API); everything else is an automatic trip. */
  static isManual(source: string | undefined): boolean {
    return !!source && (source.startsWith('api') || source === 'manual');
  }

  get engaged(): boolean {
    return this.state.engaged;
  }

  status(): KillState {
    return { ...this.state };
  }

  /** Engage (true) or, for a suppressed automatic trip, log it and return false. */
  async engage(reason: string, source: string): Promise<boolean> {
    const veto = !KillSwitch.isManual(source) ? this.suppressor?.(source) : undefined;
    if (veto && !this.state.engaged) {
      const key = `${source}:${reason.replace(/[-\d.$%]+/g, '#')}`;
      const now = Date.now();
      if (now - (this.lastSuppressed.get(key) ?? 0) > 10 * 60_000) {
        this.lastSuppressed.set(key, now);
        this.audit.write('kill_suppressed', { reason, source, veto });
        this.alerter?.notify('info', 'kill-suppressed', `Kill switch would have engaged (${source}): ${reason} — ${veto}`);
      }
      return false;
    }
    const first = !this.state.engaged;
    if (first) {
      this.state = { engaged: true, reason, source, engagedAt: new Date().toISOString() };
      writeJsonAtomic(this.file, this.state, { durable: true });
      this.audit.write('kill_engaged', this.state);
      this.alerter?.notify('critical', 'kill', `KILL SWITCH ENGAGED (${source}): ${reason}`);
    }
    // Always (re)attempt cancellation, even if already engaged.
    if (this.cancelAllFn) {
      const res = await this.cancelAllFn(`kill switch: ${reason}`);
      this.audit.write('kill_engaged', { cancelResult: res, repeat: !first });
    }
    return true;
  }

  reset(by: string): void {
    if (!this.state.engaged) return;
    const prev = this.state;
    this.state = { engaged: false, resetAt: new Date().toISOString(), resetBy: by, reason: prev.reason, source: prev.source };
    writeJsonAtomic(this.file, this.state, { durable: true });
    this.audit.write('kill_reset', { previous: prev, by });
    this.alerter?.notify('warn', 'kill-reset', `Kill switch reset by ${by} (was: ${prev.reason})`);
  }
}

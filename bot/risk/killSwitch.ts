// Persistent kill switch (FIA: "immediately disables all trading activity…
// preventing the ability to enter new orders and cancelling all working
// orders"). State is on disk, so an engaged switch survives a restart. It is
// engaged automatically (loss limit, repeated order errors, persistent
// reconciliation break, heartbeat loss) or manually from the authenticated
// API, and only a manual, authenticated reset clears it.

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

  constructor(private readonly file: string, private readonly audit: AuditLog, private readonly alerter?: Alerter) {
    this.state = readJson<KillState>(file) ?? { engaged: false };
  }

  /** Wire the order canceller once the OMS exists. */
  bindCancelAll(fn: (reason: string) => Promise<unknown>): void {
    this.cancelAllFn = fn;
  }

  get engaged(): boolean {
    return this.state.engaged;
  }

  status(): KillState {
    return { ...this.state };
  }

  async engage(reason: string, source: string): Promise<void> {
    const first = !this.state.engaged;
    if (first) {
      this.state = { engaged: true, reason, source, engagedAt: new Date().toISOString() };
      writeJsonAtomic(this.file, this.state);
      this.audit.write('kill_engaged', this.state);
      this.alerter?.notify('critical', 'kill', `KILL SWITCH ENGAGED (${source}): ${reason}`);
    }
    // Always (re)attempt cancellation, even if already engaged.
    if (this.cancelAllFn) {
      const res = await this.cancelAllFn(`kill switch: ${reason}`);
      this.audit.write('kill_engaged', { cancelResult: res, repeat: !first });
    }
  }

  reset(by: string): void {
    if (!this.state.engaged) return;
    const prev = this.state;
    this.state = { engaged: false, resetAt: new Date().toISOString(), resetBy: by, reason: prev.reason, source: prev.source };
    writeJsonAtomic(this.file, this.state);
    this.audit.write('kill_reset', { previous: prev, by });
    this.alerter?.notify('warn', 'kill-reset', `Kill switch reset by ${by} (was: ${prev.reason})`);
  }
}

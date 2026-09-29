// Operator alerts (Telegram and/or generic webhook). Fire-and-forget,
// de-duplicated per key so a flapping condition does not spam.

import type { AuditLog } from '../audit/auditLog';
import { logger } from '../util/log';

const log = logger('alert');

export type AlertLevel = 'info' | 'warn' | 'critical';

export interface AlertSink {
  send(level: AlertLevel, text: string): Promise<void>;
}

export class Alerter {
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly sinks: AlertSink[],
    private readonly audit?: AuditLog,
    private readonly dedupeMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  notify(level: AlertLevel, key: string, text: string): void {
    const t = this.now();
    const last = this.lastSent.get(key) ?? 0;
    if (level !== 'critical' && t - last < this.dedupeMs) return;
    this.lastSent.set(key, t);
    this.audit?.write('alert', { level, key, text });
    log[level === 'info' ? 'info' : 'warn'](`${key}: ${text}`);
    for (const s of this.sinks) {
      s.send(level, text).catch((e) => log.error('alert sink failed', { error: String(e) }));
    }
  }
}

export class TelegramSink implements AlertSink {
  constructor(private readonly token: string, private readonly chatId: string) {}
  async send(level: AlertLevel, text: string): Promise<void> {
    await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text: `[${level.toUpperCase()}] ${text}` }),
      signal: AbortSignal.timeout(5000),
    });
  }
}

export class WebhookSink implements AlertSink {
  constructor(private readonly url: string) {}
  async send(level: AlertLevel, text: string): Promise<void> {
    await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, text, ts: new Date().toISOString() }),
      signal: AbortSignal.timeout(5000),
    });
  }
}

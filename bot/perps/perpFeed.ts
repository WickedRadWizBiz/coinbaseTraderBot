// Polls the public perps market data (one call returns every market) and the
// funding-rate estimate, and emits PerpSnapshots. Public endpoints only, so it
// works in paper mode without a perps key. Minute-scale features don't need
// the WebSocket; a failure only makes perp features unavailable.

import { EventEmitter } from 'events';
import { logger } from '../util/log';
import { nextFundingTime, type PerpSnapshot } from './perpData';
import type { KalshiPerpsRest } from './perpRest';

const log = logger('perp-feed');

export class PerpFeed extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private readonly funding = new Map<string, { rate?: number; nextTs?: number; at: number }>();
  lastError?: string;
  lastOkTs = 0;

  constructor(private readonly rest: KalshiPerpsRest, private readonly assets: string[], private readonly pollMs = 2000) { super(); }

  private stopped = false;

  start(): void {
    this.stopped = false;
    const loop = async () => {
      await this.poll();
      if (this.stopped) return;
      this.timer = setTimeout(loop, this.pollMs);
      this.timer.unref?.();
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async poll(now = Date.now()): Promise<PerpSnapshot[]> {
    try {
      const snaps = await this.rest.markets(this.assets, now);
      for (const s of snaps) {
        let f = this.funding.get(s.ticker);
        if (!f || now - f.at > 60_000) {
          try {
            const e = await this.rest.fundingEstimate(s.ticker);
            f = { rate: e.rate, nextTs: e.nextTs, at: now };
          } catch {
            f = { ...f, at: now };
          }
          this.funding.set(s.ticker, f);
        }
        s.fundingRate = f.rate;
        s.nextFundingTs = f.nextTs ?? nextFundingTime(now);
        this.emit('snapshot', s);
      }
      this.lastOkTs = now;
      this.lastError = undefined;
      return snaps;
    } catch (e) {
      if (this.lastError !== String(e)) log.warn('perps market data unavailable', { error: String(e) });
      this.lastError = String(e);
      return [];
    }
  }
}

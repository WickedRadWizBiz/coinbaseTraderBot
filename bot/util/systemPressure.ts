// Is the machine too busy for background work right now? Used to freeze the training pipeline (which
// runs at the lowest CPU priority beside the trading bot) the moment trading needs the resources:
//  - the bot's own event loop lags (p99 delay since the last check above maxLoopLagMs): CPU contention;
//  - available memory (MemAvailable) below minAvailableMb: training must never push the box into swap
//    or the OOM killer;
//  - the hypervisor is throttling the VM (CPU steal above maxStealFrac): Lightsail CPUs are burstable,
//    and once the burst credits run out the host caps the whole machine; training backs off first.

import fs from 'fs';
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';

export interface PressureLimits { maxLoopLagMs: number; minAvailableMb: number; maxStealFrac: number }

export class SystemPressure {
  private readonly h: IntervalHistogram;
  private lastStat?: { steal: number; total: number };
  last: { lagMs: number | null; availableMb: number | null; steal: number | null } = { lagMs: null, availableMb: null, steal: null };

  constructor(private readonly lim: PressureLimits, private readonly readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')) {
    this.h = monitorEventLoopDelay({ resolution: 20 });
    this.h.enable();
  }

  /** A reason to back off right now, or undefined. Each call measures since the previous call. */
  check(): string | undefined {
    const lagMs = this.h.count > 0 ? this.h.percentile(99) / 1e6 : null;
    this.h.reset();
    const availableMb = this.availableMb() ?? null;
    const steal = this.stealFrac() ?? null;
    this.last = { lagMs: lagMs === null ? null : Math.round(lagMs), availableMb, steal: steal === null ? null : +steal.toFixed(3) };
    if (lagMs !== null && lagMs > this.lim.maxLoopLagMs) return `trading loop lagging (p99 ${Math.round(lagMs)} ms)`;
    if (availableMb !== null && availableMb < this.lim.minAvailableMb) return `low memory (${availableMb} MB available)`;
    if (steal !== null && steal > this.lim.maxStealFrac) return `CPU throttled by the host (steal ${(steal * 100).toFixed(0)}%)`;
    return undefined;
  }

  availableMb(): number | undefined {
    try {
      const m = /MemAvailable:\s+(\d+)\s*kB/.exec(this.readFile('/proc/meminfo'));
      return m ? Math.round(Number(m[1]) / 1024) : undefined;
    } catch { return undefined; }
  }

  /** Share of CPU time stolen by the hypervisor since the previous call (undefined on the first call). */
  stealFrac(): number | undefined {
    try {
      const v = this.readFile('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
      if (v.length < 8 || v.some((x) => !Number.isFinite(x))) return undefined;
      const total = v.reduce((a, b) => a + b, 0), steal = v[7];
      const prev = this.lastStat;
      this.lastStat = { steal, total };
      if (!prev || total <= prev.total) return undefined;
      return Math.max(0, (steal - prev.steal) / (total - prev.total));
    } catch { return undefined; }
  }

  stop(): void { this.h.disable(); }
}

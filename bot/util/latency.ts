// Measured latencies for the dashboard (Latency / SMP RT badges): an exponentially weighted average of
// recent samples per channel, plus the last sample.
//   kalshiWs    Kalshi WebSocket ping -> pong round trip
//   kalshiRest  Kalshi REST request round trip
//   coinbase    Coinbase ticker delay (exchange timestamp -> received)
//   sample      interval between engine evaluation passes (1 s nominal; longer when the server is busy)
//   kalshiIndex CF Benchmarks index: vendor timestamp -> handled (the index's age; includes any clock offset)
//   kalshiTransit Kalshi's send stamp -> handled (one way: network + local queueing)
//   loopP99/Max main-thread event-loop delay over ~10 s (local queueing every message also waits through)

import { monitorEventLoopDelay } from 'perf_hooks';

const ALPHA = 0.2;
// Main-thread event-loop delay: how long a ready message waits before the bot runs it. A ping round trip
// of seconds with a loop delay of seconds is local CPU starvation, not the network.
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
let loopP99 = 0, loopMax = 0, loopAt = 0;
function loopStats(now: number): { p99: number; max: number } {
  if (now - loopAt >= 10_000) { loopP99 = Math.round(loop.percentile(99) / 1e6); loopMax = Math.round(loop.max / 1e6); loop.reset(); loopAt = now; }
  return { p99: loopP99, max: loopMax };
}
const stats = new Map<string, { ewma: number; last: number; n: number; ts: number }>();

export function recordLatency(channel: string, ms: number, now = Date.now()): void {
  if (!Number.isFinite(ms) || ms < 0 || ms > 120_000) return;
  const s = stats.get(channel);
  if (!s) { stats.set(channel, { ewma: ms, last: ms, n: 1, ts: now }); return; }
  s.ewma += ALPHA * (ms - s.ewma); s.last = ms; s.n++; s.ts = now;
}

/** Rounded averages per channel; null when nothing measured in the last 5 minutes. */
export function latencySnapshot(now = Date.now()): Record<'kalshiWs' | 'kalshiRest' | 'coinbase' | 'sample' | 'kalshiIndex' | 'kalshiTransit' | 'loopP99' | 'loopMax', number | null> {
  const get = (k: string) => { const s = stats.get(k); return s && now - s.ts < 300_000 ? Math.round(s.ewma) : null; };
  const l = loopStats(now);
  return { kalshiWs: get('kalshiWs'), kalshiRest: get('kalshiRest'), coinbase: get('coinbase'), sample: get('sample'), kalshiIndex: get('kalshiIndex'), kalshiTransit: get('kalshiTransit'), loopP99: l.p99, loopMax: l.max };
}

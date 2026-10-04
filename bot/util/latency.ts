// Measured latencies for the dashboard (Latency / SMP RT badges): an exponentially weighted average of
// recent samples per channel, plus the last sample.
//   kalshiWs    Kalshi WebSocket ping -> pong round trip
//   kalshiRest  Kalshi REST request round trip
//   coinbase    Coinbase ticker delay (exchange timestamp -> received)
//   sample      interval between engine evaluation passes (1 s nominal; longer when the server is busy)

const ALPHA = 0.2;
const stats = new Map<string, { ewma: number; last: number; n: number; ts: number }>();

export function recordLatency(channel: string, ms: number, now = Date.now()): void {
  if (!Number.isFinite(ms) || ms < 0 || ms > 120_000) return;
  const s = stats.get(channel);
  if (!s) { stats.set(channel, { ewma: ms, last: ms, n: 1, ts: now }); return; }
  s.ewma += ALPHA * (ms - s.ewma); s.last = ms; s.n++; s.ts = now;
}

/** Rounded averages per channel; null when nothing measured in the last 5 minutes. */
export function latencySnapshot(now = Date.now()): Record<'kalshiWs' | 'kalshiRest' | 'coinbase' | 'sample', number | null> {
  const get = (k: string) => { const s = stats.get(k); return s && now - s.ts < 300_000 ? Math.round(s.ewma) : null; };
  return { kalshiWs: get('kalshiWs'), kalshiRest: get('kalshiRest'), coinbase: get('coinbase'), sample: get('sample') };
}

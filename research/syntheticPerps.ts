// Synthetic perp + index recordings for pipeline tests: an index path (1 print per `stepSec`) and a
// per-contract perp quote tracking it. With `momentum` > 0 the drift is persistent (predictable
// from trailing returns); with 0 the path is a random walk (nothing should validate).

import fs from 'fs';
import path from 'path';
import { rng } from './stats';

export function writeSyntheticPerps(dir: string, o: { days: number; momentum: number; seed?: number; stepSec?: number; start?: number }): void {
  fs.mkdirSync(dir, { recursive: true });
  const r = rng(o.seed ?? 5);
  const gauss = () => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  const step = (o.stepSec ?? 30) * 1000;
  const t0 = o.start ?? Date.parse('2026-06-01T00:00:00Z');
  const n = Math.floor((o.days * 86_400_000) / step);
  let S = 100_000, drift = 0;
  const lines: string[] = [];
  const perMin = 60_000 / step;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * step;
    if (i % perMin === 0) drift = 0.997 * drift + o.momentum * 1.5e-6 * gauss(); // stationary sd ~0.2 bp/min at momentum 1
    S *= Math.exp(drift / perMin + (0.0003 / Math.sqrt(perMin)) * gauss());
    lines.push(JSON.stringify({ t, k: 'index', asset: 'BTC', value: S, ts: t }));
    const px = S * 0.001;
    lines.push(JSON.stringify({ t, k: 'perp', ticker: 'BTC-PERP', asset: 'BTC', ts: t, bid: +(px - 0.01).toFixed(2), ask: +(px + 0.01).toFixed(2), contractSize: 0.001, fractional: true, fundingRate: 0.00005, tickSize: 0.01, leverage: 10 }));
  }
  const byDay = new Map<string, string[]>();
  for (const l of lines) { const d = new Date(JSON.parse(l).t).toISOString().slice(0, 10); (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(l); }
  for (const [d, ls] of byDay) fs.writeFileSync(path.join(dir, `md-${d}.jsonl`), ls.join('\n') + '\n');
}

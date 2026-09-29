// Synthetic recordings for testing the research pipeline end to end.
// Index: log-Brownian at 1 s. Markets: 15-minute windows. Book: quoted around
// a noisy version of the true fair value. Trades print randomly at the touch.
// Synthetic data validates plumbing only; it says nothing about real edge.

import fs from 'fs';
import path from 'path';
import { fairValue } from '../bot/model/fairValue';
import { rng } from './stats';

export function writeSyntheticRecordings(dir: string, opts: { windows: number; seed?: number; sigma?: number; marketNoise?: number; start?: number }): void {
  fs.mkdirSync(dir, { recursive: true });
  const r = rng(opts.seed ?? 11);
  const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const sigma = opts.sigma ?? 0.0004;
  const noise = opts.marketNoise ?? 0.04;
  const start = opts.start ?? Date.parse('2026-01-01T00:00:00Z');
  const W = 15 * 60;
  const lines: string[] = [];
  const hist: number[] = [];
  let x = Math.log(60000);
  // 10 minutes of warm-up index before the first window.
  const total = opts.windows * W + 600 + 120;
  for (let s = 0; s < total; s++) {
    const t = start + s * 1000;
    x += sigma * gauss();
    const S = Math.exp(x);
    hist.push(S);
    lines.push(JSON.stringify({ t, k: 'index', asset: 'BTC', value: S, ts: t, src: 'synthetic' }));
    const rel = s - 600;
    if (rel >= 0 && rel % W === 0 && rel / W < opts.windows) {
      const open = t, close = t + W * 1000;
      const strike = hist.slice(-60).reduce((a, b) => a + b, 0) / 60;
      lines.push(JSON.stringify({ t, k: 'market', ticker: `SYN-${rel / W}`, series: 'KXBTC15M', asset: 'BTC', openTime: open, closeTime: close, strike, tickSize: 0.01 }));
    }
    if (rel >= 0 && rel % 5 === 0) {
      const w = Math.floor(rel / W);
      if (w >= opts.windows) continue;
      const open = start + (600 + w * W) * 1000;
      const close = open + W * 1000;
      const strike = hist.slice(Math.max(0, 600 + w * W - 60), 600 + w * W).reduce((a, b) => a + b, 0) / 60 || S;
      const tau = (close - t) / 1000;
      const obs = tau <= 60 ? hist.slice(-(60 - tau)).reduce((a, b) => a + b, 0) / Math.max(1, 60 - tau) : undefined;
      const fv = fairValue({ spot: S, strike, sigmaPerSqrtSec: sigma, tauSec: tau, observedAvg: obs })?.pYes ?? 0.5;
      const m = Math.min(0.97, Math.max(0.03, fv + noise * gauss()));
      const bid = Math.max(0.01, Math.floor((m - 0.02) * 100) / 100);
      const ask = Math.min(0.99, Math.ceil((m + 0.02) * 100) / 100);
      const ticker = `SYN-${w}`;
      lines.push(JSON.stringify({ t, k: 'book', ticker, bids: [{ price: bid, size: 20 }], asks: [{ price: ask, size: 20 }], ts: t }));
      if (r() < 0.5) lines.push(JSON.stringify({ t, k: 'trade', ticker, price: r() < 0.5 ? bid : ask, count: 5, takerSide: r() < 0.5 ? 'no' : 'yes', ts: t }));
    }
  }
  fs.writeFileSync(path.join(dir, `md-${new Date(start).toISOString().slice(0, 10)}.jsonl`), lines.join('\n') + '\n');
}

// Synthetic recordings for testing the research pipeline end to end.
// Index: log-Brownian at 1 s. Markets: 15-minute windows. Book: quoted around
// a noisy version of the true fair value. Trades print randomly at the touch.
// Synthetic data validates plumbing only; it says nothing about real edge.

import fs from 'fs';
import path from 'path';
import { fairValue } from '../bot/model/fairValue';
import { rng } from './stats';

export function writeSyntheticRecordings(dir: string, opts: { windows: number; seed?: number; sigma?: number; marketNoise?: number; start?: number; dominanceLeadSec?: number; tickerPrefix?: string }): void {
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
  // Coinbase spot leads the settlement index by LEAD seconds (plus noise), so
  // lead-lag features have real signal to find in synthetic data.
  const LEAD = 3;
  const walk: number[] = [];
  // USDT.D moves inversely to where the index will be DOM_LEAD seconds later
  // (0 disables the dominance stream).
  const DOM_LEAD = opts.dominanceLeadSec ?? 20;
  for (let s = 0; s < total + Math.max(LEAD, DOM_LEAD) + 1; s++) { x += sigma * gauss(); walk.push(Math.exp(x)); }
  for (let s = 0; s < total; s++) {
    const t = start + s * 1000;
    const S = walk[s];
    hist.push(S);
    lines.push(JSON.stringify({ t, k: 'index', asset: 'BTC', value: S, ts: t, src: 'synthetic' }));
    lines.push(JSON.stringify({ t, k: 'spot', asset: 'BTC', value: walk[s + LEAD] * (1 + 0.00002 * gauss()), ts: t }));
    if (DOM_LEAD > 0) {
      const usdtd = 5 * Math.pow(walk[s + DOM_LEAD] / walk[0], -0.9) * (1 + 0.00001 * gauss());
      const btcd = 55 * Math.pow(walk[s] / walk[0], 0.1) * (1 + 0.00001 * gauss());
      lines.push(JSON.stringify({ t, k: 'dominance', usdtd, btcd, covered: 0.9, ts: t }));
    }
    const rel = s - 600;
    if (rel >= 0 && rel % W === 0 && rel / W < opts.windows) {
      const open = t, close = t + W * 1000;
      const strike = hist.slice(-60).reduce((a, b) => a + b, 0) / 60;
      lines.push(JSON.stringify({ t, k: 'market', ticker: `${opts.tickerPrefix ?? 'SYN'}-${rel / W}`, series: 'KXBTC15M', asset: 'BTC', openTime: open, closeTime: close, strike, tickSize: 0.01 }));
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
      const ticker = `${opts.tickerPrefix ?? 'SYN'}-${w}`;
      // Five levels a side with uneven sizes, so some levels are "walls".
      const lvls = (p0: number, dir: number) => Array.from({ length: 5 }, (_, i) => ({ price: Math.round((p0 + dir * i * 0.01) * 100) / 100, size: Math.round(3 + r() * 37) }))
        .filter((l) => l.price >= 0.01 && l.price <= 0.99);
      lines.push(JSON.stringify({ t, k: 'book', ticker, bids: lvls(bid, -1), asks: lvls(ask, 1), ts: t }));
      if (r() < 0.5) lines.push(JSON.stringify({ t, k: 'trade', ticker, price: r() < 0.5 ? bid : ask, count: 5, takerSide: r() < 0.5 ? 'no' : 'yes', ts: t }));
    }
  }
  fs.writeFileSync(path.join(dir, `md-${new Date(start).toISOString().slice(0, 10)}.jsonl`), lines.join('\n') + '\n');
}

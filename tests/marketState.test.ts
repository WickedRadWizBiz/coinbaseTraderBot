import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IndexTracker } from '../bot/marketdata/indexTracker';
import { ChangePoint, compactReading, MarketState, observeMarket } from '../bot/marketdata/marketState';

const MIN = 60_000;
const gauss = (seed: number) => {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 1) / 4294967297;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
};
const index = (get: () => number) => ({ latest: () => ({ value: get(), ts: 0 }) }) as unknown as IndexTracker;

test('change point: quiet on a steady process, fires soon after the variance jumps', () => {
  const cp = new ChangePoint();
  const g = gauss(7);
  const before: number[] = [];
  for (let i = 0; i < 200; i++) before.push(cp.update(g()));
  const quiet = before.slice(50).filter((p) => p > 0.5).length;
  assert.ok(quiet <= 3, `false alarms ${quiet}`);
  let fired = -1;
  for (let i = 0; i < 15; i++) if (cp.update(4 * g()) > 0.5 && fired < 0) fired = i;
  assert.ok(fired >= 0 && fired < 8, `fired at ${fired}`);
});

test('volatility horizons, ratio and jump from one-minute index bars', () => {
  const ms = new MarketState();
  const g = gauss(3);
  let px = 100, t = 0;
  const idx = index(() => px);
  // Six hours at 0.1% a minute, then 15 minutes at 0.4%.
  for (let i = 0; i < 380; i++) {
    px *= Math.exp((i < 365 ? 0.001 : 0.004) * g());
    t = i * MIN + 30_000;
    ms.observeIndex('BTC', idx, t);
  }
  const r = ms.reading('BTC', t);
  assert.ok(r.rv6h !== null && r.rv1h !== null && r.rv15m !== null);
  assert.ok(Math.abs(r.rv6h! * Math.sqrt(60) / 0.001 - 1) < 0.4, `rv6h ${r.rv6h}`);
  assert.ok(r.volRatio! > 1.5, `ratio ${r.volRatio}`);
  assert.ok(r.jump! > 2, `jump ${r.jump}`);
  assert.equal(r.minute, Math.floor(t / MIN) * MIN);
});

test('no reading is invented before there is data', () => {
  const ms = new MarketState();
  const r = ms.reading('ETH', 0);
  assert.equal(r.rv15m, null);
  assert.equal(r.changeProb, null);
  assert.equal(r.spread, null);
  assert.equal(r.flowImbalance, null);
  assert.equal(r.correlation, null);
});

test('liquidity medians and taker flow, each trade counted once', () => {
  const ms = new MarketState();
  const idx = index(() => 100);
  const trades = [{ ts: 1000, signed: 5, count: 5 }, { ts: 1000, signed: -1, count: 1 }];
  observeMarket(ms, { asset: 'SOL', ticker: 'A', index: idx, now: 2000, bid: { price: 0.4, size: 10 }, ask: { price: 0.42, size: 20 }, trades });
  // The same trades again plus one more at the same millisecond and one later: only the new two count.
  const r = observeMarket(ms, { asset: 'SOL', ticker: 'A', index: idx, now: 3001, bid: { price: 0.4, size: 30 }, ask: { price: 0.46, size: 30 }, trades: [...trades, { ts: 1000, signed: 2, count: 2 }, { ts: 2500, signed: -4, count: 4 }] });
  assert.equal(r.flowContracts, 12);
  assert.ok(Math.abs(r.flowImbalance! - 2 / 12) < 1e-9);
  assert.ok(Math.abs(r.spread! - 0.04) < 1e-9);
  assert.equal(r.depth, 45);
  // Five minutes later the flow and books have aged out.
  const later = ms.reading('SOL', 3001 + 5 * MIN + 1);
  assert.equal(later.flowContracts, 0);
  assert.equal(later.spread, null);
});

test('correlation across coins and the compact audit form', () => {
  const ms = new MarketState();
  const g = gauss(11);
  let a = 100, b = 50, t = 0;
  for (let i = 0; i < 70; i++) {
    const z = g();
    a *= Math.exp(0.001 * z);
    b *= Math.exp(0.001 * (0.9 * z + 0.3 * g()));
    t = i * MIN + 1000;
    ms.observeIndex('BTC', index(() => a), t);
    ms.observeIndex('ETH', index(() => b), t);
  }
  const r = ms.reading('BTC', t);
  assert.ok(r.correlation! > 0.8, `corr ${r.correlation}`);
  const c = compactReading(r);
  assert.equal(typeof c.rv1h, 'number');
  assert.equal(c.spread, null);
});

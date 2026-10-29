import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import type { MarketStateReading } from '../bot/marketdata/marketState';
import { pageHinkley } from '../bot/health/drift';
import { otherCoinsHeld, REGIME_SCALE_OFF, regimeScale, regimeScaleOn } from '../bot/strategy/regimeScale';

const reading = (over: Partial<MarketStateReading> = {}): MarketStateReading => ({
  asset: 'BTC', minute: 0, rv15m: 4e-4, rv1h: 2e-4, rv6h: 1e-4, volRatio: 2, jump: 1, changeProb: 0.6, spread: 0.02, depth: 100,
  flowImbalance: 0, flowContracts: 0, correlation: 0.8, ...over,
});

test('off by default: size unchanged', () => {
  assert.equal(regimeScaleOn(REGIME_SCALE_OFF), false);
  assert.equal(regimeScale(REGIME_SCALE_OFF, reading(), 3).mult, 1);
  assert.equal(loadConfig({} as NodeJS.ProcessEnv).strategy.regimeScale.volTarget, 0);
});

test('vol targeting, change-point de-risk and correlated coins each shrink the size', () => {
  const vol = regimeScale({ ...REGIME_SCALE_OFF, volTarget: 0.5 }, reading(), 0);
  assert.ok(Math.abs(vol.parts.vol - 0.5) < 1e-12);
  const cp = regimeScale({ ...REGIME_SCALE_OFF, changeDerisk: 0.5 }, reading(), 0);
  assert.ok(Math.abs(cp.mult - 0.7) < 1e-12);
  const corr = regimeScale({ ...REGIME_SCALE_OFF, corrDerisk: 0.5 }, reading(), 2);
  assert.ok(Math.abs(corr.mult - 1 / 1.8) < 1e-12);
  assert.equal(regimeScale({ ...REGIME_SCALE_OFF, corrDerisk: 0.5 }, reading(), 0).mult, 1, 'no other coin held');
  // All together, floored at the minimum.
  const all = regimeScale({ ...REGIME_SCALE_OFF, volTarget: 2, changeDerisk: 1, corrDerisk: 2 }, reading(), 3);
  assert.equal(all.mult, 0.25);
});

test('calm market sizes up only when the max allows it; missing readings leave size alone', () => {
  const calm = reading({ rv15m: 1e-4, rv6h: 4e-4 });
  assert.equal(regimeScale({ ...REGIME_SCALE_OFF, volTarget: 0.5 }, calm, 0).mult, 1);
  assert.equal(regimeScale({ ...REGIME_SCALE_OFF, volTarget: 0.5, max: 1.5 }, calm, 0).mult, 1.5);
  const none = reading({ rv15m: null, rv6h: null, changeProb: null, correlation: null });
  assert.equal(regimeScale({ ...REGIME_SCALE_OFF, volTarget: 1, changeDerisk: 1, corrDerisk: 1 }, none, 4).mult, 1);
});

test('other coins held counts distinct coins, not markets', () => {
  const open = [{ ticker: 'KXBTC-1', asset: 'BTC' }, { ticker: 'KXETH-1', asset: 'ETH' }, { ticker: 'KXETH-2' }, { ticker: 'KXSOL-1' }];
  assert.equal(otherCoinsHeld(open, 'BTC', (t) => (t.startsWith('KXETH') ? 'ETH' : t.startsWith('KXSOL') ? 'SOL' : undefined)), 2);
});

test('drift watch: quiet on a steady record, alarms soon after it turns worse', () => {
  let s = 9;
  const g = () => { s = (s * 1664525 + 1013904223) >>> 0; const u = (s + 1) / 4294967297; s = (s * 1664525 + 1013904223) >>> 0; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * ((s + 1) / 4294967297)); };
  const steady = Array.from({ length: 300 }, (_, i) => ({ ts: i, x: 0.02 * g() }));
  assert.equal(pageHinkley(steady).alarm, false);
  const broke = [...steady, ...Array.from({ length: 60 }, (_, i) => ({ ts: 300 + i, x: 0.02 + 0.02 * g() }))];
  const d = pageHinkley(broke);
  assert.equal(d.alarm, true);
  assert.ok(d.since! >= 280 && d.since! <= 320, `since ${d.since}`);
  assert.equal(pageHinkley(steady.slice(0, 10)).alarm, false, 'too few windows');
});

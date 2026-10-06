import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avgCorrelation, characterOf, classify, efficiencyRatio, hurstVR, realisedCharacter, volPercentile } from '../bot/ta/character';
import type { Candle } from '../bot/ta/indicators';

const H = 3_600_000, D = 24 * H;
const T0 = Date.UTC(2026, 0, 1);

function rng(seed: number) { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function gauss(r: () => number) { const u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/** Hourly candles from a return path (per-bar returns), close-to-close with small wicks. */
function hourly(rets: number[], p0 = 100, t0 = T0): Candle[] {
  let p = p0;
  return rets.map((r, i) => { const o = p; p = p * Math.exp(r); return { ts: t0 + i * H, o, h: Math.max(o, p) * 1.0005, l: Math.min(o, p) * 0.9995, c: p, v: 1 }; });
}
/** Daily bars whose Parkinson volatility is about `vol` (daily). */
function daily(n: number, vol: number, seed = 3): Candle[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => { const k = vol * 2 * Math.sqrt(Math.log(2)) * (0.6 + 0.8 * r()); return { ts: T0 - (n - i) * D, o: 100, h: 100 * Math.exp(k / 2), l: 100 * Math.exp(-k / 2), c: 100, v: 1 }; });
}

test('classify: volatility first (systemic vs coin-specific by correlation), then trend, else calm; the vol forecast nudges', () => {
  const base = { rvPct: 0.5, corr: 0.3, hurst: 0.5, er: 0.1, adx: 15, bbRank: 0.5 };
  assert.equal(classify({ ...base, rvPct: 0.9, corr: 0.8 }).cls, 'volatile_systemic');
  assert.equal(classify({ ...base, rvPct: 0.9, corr: 0.2 }).cls, 'volatile_idio');
  assert.equal(classify({ ...base, er: 0.45 }).cls, 'trending');
  assert.equal(classify({ ...base, adx: 30, hurst: 0.6 }).cls, 'trending');
  assert.equal(classify({ ...base, adx: 30, hurst: 0.45 }).cls, 'calm', 'ADX alone without persistence is not a trend');
  assert.equal(classify(base).cls, 'calm');
  assert.equal(classify({ ...base, rvPct: 0.7, volFc: 0.4 }).cls, 'volatile_idio', 'network expects more volatility: nudged over');
  assert.equal(classify({ ...base, rvPct: 0.8, volFc: -0.4 }).cls, 'calm', 'network expects calm: nudged under');
});

test('building blocks: efficiency ratio, Hurst (trend > 0.5 > mean reversion), correlation, volatility percentile', () => {
  const r = rng(1);
  const trend = hourly(Array.from({ length: 200 }, () => 0.004 + 0.002 * gauss(r)));
  assert.ok(efficiencyRatio(trend) > 0.6);
  // AR(1) with positive vs negative autocorrelation.
  const ar = (phi: number, seed: number) => { const q = rng(seed); let x = 0; return hourly(Array.from({ length: 400 }, () => (x = phi * x + 0.01 * gauss(q)))); };
  assert.ok(hurstVR(ar(0.5, 2)) > 0.6, `persistent ${hurstVR(ar(0.5, 2))}`);
  assert.ok(hurstVR(ar(-0.5, 2)) < 0.4, `anti-persistent ${hurstVR(ar(-0.5, 2))}`);
  const common = Array.from({ length: 100 }, () => 0.01 * gauss(r));
  const a = hourly(common.map((x) => x + 0.002 * gauss(r))), b = hourly(common.map((x) => x + 0.002 * gauss(r))), c = hourly(common.map(() => 0.01 * gauss(r)));
  assert.ok(avgCorrelation(a, [b]) > 0.8);
  assert.ok(Math.abs(avgCorrelation(a, [c])) < 0.35);
  const d1 = daily(180, 0.03);
  assert.ok(volPercentile(0.1, d1) > 0.95 && volPercentile(0.005, d1) < 0.05);
});

test('characterOf on synthetic markets: a steady trend, a quiet range, a coin-specific storm, a market-wide storm', () => {
  const d1 = daily(200, 0.03);
  const quietOthers = [1, 2, 3].map((s) => { const q = rng(100 + s); return hourly(Array.from({ length: 200 }, () => 0.002 * gauss(q))); });
  const r = rng(9);
  assert.equal(characterOf(hourly(Array.from({ length: 200 }, () => 0.002 + 0.002 * gauss(r))), d1, quietOthers).cls, 'trending');
  const q = rng(10); let x = 0;
  assert.equal(characterOf(hourly(Array.from({ length: 200 }, () => (x = -0.5 * x + 0.002 * gauss(q)))), d1, quietOthers).cls, 'calm');
  // A storm in the last day: 3 % hourly moves (about 15 % daily vol, far above the 3 % history).
  const storm = (seed: number) => { const s = rng(seed); return Array.from({ length: 200 }, (_, i) => (i >= 176 ? 0.03 : 0.002) * gauss(s)); };
  const own = storm(11);
  assert.equal(characterOf(hourly(own), d1, quietOthers).cls, 'volatile_idio');
  const others = [1, 2, 3].map((s) => { const z = rng(200 + s); return hourly(own.map((v) => v + 0.003 * gauss(z))); });
  assert.equal(characterOf(hourly(own), d1, others).cls, 'volatile_systemic');
});

test('realised character of a forward window (the label the classifier is scored on)', () => {
  const d1 = daily(200, 0.03);
  const r = rng(4);
  const fwdTrend = hourly(Array.from({ length: 25 }, () => 0.003 + 0.001 * gauss(r)));
  assert.equal(realisedCharacter(fwdTrend, d1, []), 'trending');
  const fwdStorm = hourly(Array.from({ length: 25 }, () => 0.04 * gauss(r)));
  assert.equal(realisedCharacter(fwdStorm, d1, []), 'volatile_idio');
});

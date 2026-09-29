import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fairValue } from '../bot/model/fairValue';

const sigma = 0.0004; // per sqrt(second)

test('at the money before the window is ~50%', () => {
  const fv = fairValue({ spot: 100, strike: 100, sigmaPerSqrtSec: sigma, tauSec: 600 })!;
  assert.ok(Math.abs(fv.pYes - 0.5) < 1e-6);
  assert.equal(fv.regime, 'pre_window');
});

test('monotone in spot and shrinks uncertainty as time passes', () => {
  const a = fairValue({ spot: 100.1, strike: 100, sigmaPerSqrtSec: sigma, tauSec: 600 })!.pYes;
  const b = fairValue({ spot: 100.1, strike: 100, sigmaPerSqrtSec: sigma, tauSec: 120 })!.pYes;
  const c = fairValue({ spot: 99.9, strike: 100, sigmaPerSqrtSec: sigma, tauSec: 600 })!.pYes;
  assert.ok(a > 0.5 && b > a && c < 0.5);
});

test('inside the averaging window the fixed part dominates', () => {
  // Observed average well above strike with 5s left: near-certain YES even if spot dips.
  const fv = fairValue({ spot: 99.95, strike: 100, sigmaPerSqrtSec: sigma, tauSec: 5, observedAvg: 100.2 })!;
  assert.equal(fv.regime, 'in_window');
  assert.ok(fv.pYes > 0.99);
});

test('requires the observed average inside the window (no invented data)', () => {
  assert.equal(fairValue({ spot: 100, strike: 100, sigmaPerSqrtSec: sigma, tauSec: 30 }), undefined);
});

test('tie at determination resolves YES', () => {
  const fv = fairValue({ spot: 100, strike: 100, sigmaPerSqrtSec: sigma, tauSec: 0, observedAvg: 100 })!;
  assert.ok(fv.pYes > 0.99);
});

test('rejects invalid inputs', () => {
  assert.equal(fairValue({ spot: 0, strike: 100, sigmaPerSqrtSec: sigma, tauSec: 600 }), undefined);
  assert.equal(fairValue({ spot: 100, strike: 100, sigmaPerSqrtSec: 0, tauSec: 600 }), undefined);
});

test('matches a Monte Carlo simulation of the 60s-average settlement', () => {
  // Simulate log-BM at 1s steps; settlement = mean of last 60 seconds >= strike.
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const tau = 300, spot = 100.05, strike = 100, sig = 0.0003;
  let yes = 0;
  const N = 6000;
  for (let n = 0; n < N; n++) {
    let x = Math.log(spot), sum = 0;
    for (let s = 1; s <= tau; s++) {
      x += sig * gauss();
      if (s > tau - 60) sum += Math.exp(x);
    }
    if (sum / 60 >= strike) yes++;
  }
  const mc = yes / N;
  const fv = fairValue({ spot, strike, sigmaPerSqrtSec: sig, tauSec: tau })!.pYes;
  assert.ok(Math.abs(mc - fv) < 0.025, `mc=${mc} fv=${fv}`);
});

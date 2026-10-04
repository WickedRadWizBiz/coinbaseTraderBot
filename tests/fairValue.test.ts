import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fairValue, impliedVariance, tailCdf } from '../bot/model/fairValue';
import { normCdf, studentTCdf } from '../bot/util/num';

const sigma = 0.0004; // per sqrt(second)

test('at the money before the window is ~50% (just under: martingale drift -v/2)', () => {
  const fv = fairValue({ spot: 100, strike: 100, sigmaPerSqrtSec: sigma, tauSec: 600 })!;
  assert.ok(fv.pYes < 0.5 && 0.5 - fv.pYes < 0.005);
  assert.ok(Math.abs(fv.vEff - sigma * sigma * (600 - 40)) < 1e-15);
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

test('Student-t CDF matches known values and tends to the normal', () => {
  assert.ok(Math.abs(studentTCdf(0, 5) - 0.5) < 1e-12);
  assert.ok(Math.abs(studentTCdf(2.015, 5) - 0.95) < 1e-3);   // t_{0.95,5} = 2.015
  assert.ok(Math.abs(studentTCdf(-2.228, 10) - 0.025) < 1e-3); // t_{0.975,10} = 2.228
  assert.ok(Math.abs(tailCdf(1.5, 1000) - normCdf(1.5)) < 2e-3);
});

test('fat tails raise far-strike probabilities', () => {
  const g = fairValue({ spot: 100, strike: 103, sigmaPerSqrtSec: sigma, tauSec: 900 })!.pYes;
  const t = fairValue({ spot: 100, strike: 103, sigmaPerSqrtSec: sigma, tauSec: 900, nu: 4 })!.pYes;
  assert.ok(t > g, `t=${t} g=${g}`);
});

test('between bracket = P(>= floor) - P(>= cap), and brackets sum to 1', () => {
  const base = { spot: 100, sigmaPerSqrtSec: sigma, tauSec: 1800 };
  const edges = [0, 99, 99.5, 100, 100.5, 101, 1e9];
  let sum = 0;
  for (let i = 0; i < edges.length - 1; i++) {
    if (i === 0) sum += 1 - fairValue({ ...base, strike: 99 })!.pYes;
    else if (i === edges.length - 2) sum += fairValue({ ...base, strike: 101 })!.pYes;
    else sum += fairValue({ ...base, strike: edges[i], cap: edges[i + 1] })!.pYes;
  }
  assert.ok(Math.abs(sum - 1) < 1e-3, `sum=${sum}`);
  assert.equal(fairValue({ ...base, strike: 100, cap: 99 }), undefined);
});

test('implied variance inverts the pricer away from the money', () => {
  const S = 100, K = 99.5, v = 2e-5;
  const p = normCdf(Math.log(S / K) / Math.sqrt(v));
  assert.ok(Math.abs(impliedVariance(S, K, p)! / v - 1) < 1e-3);
  assert.equal(impliedVariance(100, 100.0001, 0.5), undefined);
});

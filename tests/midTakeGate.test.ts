import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMidGate, fitMidGate, MID_GATE_FEATURES, midGateProbability, type MidGateParams } from '../bot/model/midTakeGate';

test('the mid gate learns an input that moves the win rate and ignores noise', () => {
  let s = 1;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const k = MID_GATE_FEATURES.length;
  const rows = Array.from({ length: 4000 }, () => {
    const x = Array.from({ length: k }, () => r() * 2 - 1);
    const p = 1 / (1 + Math.exp(-(1.2 * x[5])));
    return { x, midSide: 0.5, won: r() < p };
  });
  const fit = fitMidGate(rows, 1);
  assert.ok(fit.w[5] > 0.4, `weight on the informative input ${fit.w[5]}`);
  const noise = fit.w.filter((_, i) => i !== 5).map(Math.abs);
  assert.ok(Math.max(...noise) < 0.2);
  // At the mean of every input, the gate returns the mid.
  const at = midGateProbability({ ...fit, validation: { n: 0, logLossMid: 0, logLossGate: 0, validated: true } }, fit.mean, 0.3);
  assert.ok(Math.abs(at - 0.3) < 0.05);
});

test('an unvalidated gate skips nothing; a validated one skips entries below break-even and never exits', () => {
  const k = MID_GATE_FEATURES.length;
  const p: MidGateParams = { features: [...MID_GATE_FEATURES], mean: new Array(k).fill(0), std: new Array(k).fill(1), w: new Array(k).fill(0), b: -2, validation: { n: 1000, logLossMid: 0.7, logLossGate: 0.6, validated: false } };
  const plan = () => ({ notes: [] as string[], place: [
    { side: 'bid' as const, price: 0.5, postOnly: false, reduceOnly: false, purpose: 'entry', why: 'take YES' },
    { side: 'ask' as const, price: 0.6, postOnly: true, reduceOnly: true, purpose: 'exit', why: 'exit' },
  ] });
  const ctx = { pYes: 0.6, mid: 0.5, features: {}, tauSec: 600, bid: 0.49, ask: 0.51, margin: 0 };
  const a = plan();
  assert.equal(applyMidGate(a, p, ctx), 0);
  const b = plan();
  assert.equal(applyMidGate(b, { ...p, validation: { ...p.validation, validated: true } }, ctx), 1);
  assert.deepEqual(b.place.map((o) => o.purpose), ['exit']);
});

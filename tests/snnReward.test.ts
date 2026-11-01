import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dopamine, energy, paceShortfall, realizedPace, reward } from '../bot/snn/reward';

const hrs = (h: number, usd: number) => ({ elapsedSec: h * 3600, realized24hUsd: usd });

test('pace and shortfall read the pacer', () => {
  assert.equal(realizedPace(hrs(2, 9)), 4.5);
  assert.equal(realizedPace({ elapsedSec: 10, realized24hUsd: 1 }), undefined);
  assert.equal(paceShortfall(hrs(2, 9)), 0);
  assert.equal(paceShortfall(hrs(2, 3)), 3);
  assert.equal(paceShortfall(undefined), 0);
  assert.ok(Math.abs(reward(1, hrs(2, 3)) - 0.7) < 1e-12);
});

test('energy: 1 at pace, floored far below it', () => {
  assert.equal(energy(hrs(1, 5)), 1);
  assert.equal(energy(hrs(1, -10)), 0.25);
  const mid = energy(hrs(1, 2.25));
  assert.ok(mid > 0.25 && mid < 1);
});

test('dopamine: silent during warm-up and for noise, fires on surprise', () => {
  const d = new Dopamine(2, { warmup: 5 });
  for (let i = 0; i < 5; i++) assert.equal(d.settle([1, 0], 10).dopamine, 0); // warm-up
  const small = d.settle([1, 0], 0.01);
  assert.ok(Math.abs(small.z) >= 0 && (Math.abs(small.z) < 1 ? small.dopamine === 0 : true));
  const big = d.settle([1, 0], -100);
  assert.ok(big.dopamine < 0 && big.dopamine >= -3);
});

test('critic learns the expected reward, so a steady reward stops teaching', () => {
  const d = new Dopamine(1, { warmup: 0, criticLr: 0.2 });
  let last = 1;
  for (let i = 0; i < 200; i++) last = d.settle([1], 2).dopamine;
  assert.equal(last, 0);
  assert.ok(Math.abs(d.critic.value([1]) - 2) < 0.01);
  const s = JSON.parse(JSON.stringify(d)); const e = new Dopamine(1); e.load(s);
  assert.equal(e.turn, 200);
});

test('shuffled-reward adversary: random +/- rewards leave the critic near zero', () => {
  const d = new Dopamine(1, { warmup: 0 });
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2000; i++) d.settle([1], rnd() < 0.5 ? -1 : 1);
  assert.ok(Math.abs(d.critic.value([1])) < 0.3);
});

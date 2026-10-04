// Triple-barrier trades (the TA network's fitness, holdout and live forward test) and the continuous
// OBV divergence score.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '../bot/ta/indicators';
import { obv } from '../bot/ta/indicators';
import { obvDivergenceStrength, swings } from '../bot/ta/structure';
import { barrierResult, TANET_STRATEGY, taNetBarrierWidth, tripleBarrier } from '../bot/ta/taNet';

const bar = (o: number, h: number, l: number, c: number, v = 1, ts = 0): Candle => ({ ts, o, h, l, c, v });
const w = Math.log(1.02); // barriers at +/- 2%

test('triple barrier: first touch decides, stop wins a bar that touches both, gaps exit at the open', () => {
  // Long: take-profit touched in bar 2.
  assert.ok(Math.abs(tripleBarrier(100, [bar(100, 101, 99.5, 100.5), bar(100.5, 102.5, 100, 102), bar(102, 103, 101, 101)], 1, w) - w) < 1e-12);
  // Long: stop first even though price later rallies past the take-profit.
  assert.ok(Math.abs(tripleBarrier(100, [bar(100, 100.5, 97.5, 98), bar(98, 103, 98, 103)], 1, w) + w) < 1e-12);
  // A bar touching both barriers counts as the stop (conservative).
  assert.ok(Math.abs(tripleBarrier(100, [bar(100, 103, 97, 100)], 1, w) + w) < 1e-12);
  // A gap below the stop exits at the open, not at the barrier.
  assert.ok(Math.abs(tripleBarrier(100, [bar(95, 96, 94, 95)], 1, w) - Math.log(0.95)) < 1e-12);
  // No barrier: exit at the last close (time barrier).
  assert.ok(Math.abs(tripleBarrier(100, [bar(100, 101, 99, 100.5), bar(100.5, 101, 99.5, 101)], 1, w) - Math.log(1.01)) < 1e-12);
  // Short mirrors: falling price is the take-profit.
  assert.ok(Math.abs(tripleBarrier(100, [bar(100, 100.5, 97.5, 98)], -1, w) - w) < 1e-12);
  assert.ok(Math.abs(tripleBarrier(100, [bar(100, 102.5, 99.5, 102)], -1, w) + w) < 1e-12);
  // Trade result: |position| x return minus entry + exit costs, shared across 4 overlapping trades.
  const next = [bar(100, 102.5, 99.5, 102), bar(102, 103, 101, 102), bar(102, 103, 101, 102), bar(102, 103, 101, 102)];
  const r = barrierResult(0.5, 100, next, w, TANET_STRATEGY, 1);
  assert.ok(Math.abs(r.cost - (2 * TANET_STRATEGY.costPerTurnover * 0.5) / 4) < 1e-12);
  assert.ok(Math.abs(r.ret - ((0.5 * w) / 4 - r.cost)) < 1e-12);
  assert.deepEqual(barrierResult(0, 100, next, w, TANET_STRATEGY, 1), { ret: 0, cost: 0 });
  // Barriers widen with the volatility forecast.
  assert.ok(taNetBarrierWidth(Math.log(2), 0.01) > taNetBarrierWidth(0, 0.01));
});

/** Bars through given closes (high/low around the close, volume per bar). */
function path(closes: number[], vols: number[]): Candle[] {
  return closes.map((c, i) => bar(i ? closes[i - 1] : c, c + 0.2, c - 0.2, c, vols[i], i * 3_600_000));
}

test('OBV divergence strength: hidden bullish positive, regular bearish negative, fades with age, no look-ahead', () => {
  // Price makes a higher low while OBV makes a lower low (heavy selling into the second dip): hidden bullish.
  const closes = [10, 9, 8, 7, 8, 9, 10, 11, 10, 9, 8.5, 9.5, 10.5, 11.5, 12, 12.5];
  const vols = [1, 1, 1, 1, 1, 1, 1, 1, 6, 6, 6, 1, 1, 1, 1, 1];
  const cs = path(closes, vols);
  const s = obvDivergenceStrength(cs, obv(cs), 0.5, swings(cs));
  assert.ok(s.hidden > 0.3 && s.regular === 0, JSON.stringify(s));
  // Same shape two bars later: weaker (older).
  const later = path([...closes, 12.6, 12.7], [...vols, 1, 1]);
  const s2 = obvDivergenceStrength(later, obv(later), 0.5, swings(later));
  assert.ok(s2.hidden > 0 && s2.hidden < s.hidden);
  // Regular bearish: price higher high, OBV lower high (rally on thin volume, falls on heavy volume).
  const up = [10, 11, 12, 13, 12, 11, 10, 11, 12, 13.5, 12.5, 11.5, 11, 10.8, 10.6, 10.5];
  const uv = [5, 5, 5, 5, 6, 6, 6, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  const cu = path(up, uv);
  const b = obvDivergenceStrength(cu, obv(cu), 0.5, swings(cu));
  assert.ok(b.regular < 0 && b.hidden === 0, JSON.stringify(b));
  // A swing needs 3 later bars to exist: cutting the series before then removes the second swing.
  const cut = cs.slice(0, 11);
  const sc = obvDivergenceStrength(cut, obv(cut), 0.5, swings(cut));
  assert.equal(sc.hidden, 0, 'the second low is not confirmed yet');
});

test('coverage floor: sitting out a round loses to trading, a member above the floor is unchanged', async () => {
  const { coverageFloor, TANET_MIN_COVERAGE } = await import('../research/trainTaNet');
  const rep = { fitness: 0, sortino: 0, maxDrawdown: 0, costs: 0, netReturn: 0, interactions: 0, independent: 0, days: 30 };
  assert.equal(coverageFloor(rep, 0, 1000).fitness, -10);
  const losing = { ...rep, fitness: -3 };
  assert.equal(coverageFloor(losing, 100, 1000), losing, 'above the floor: unchanged');
  assert.ok(coverageFloor(rep, 0, 1000).fitness < losing.fitness, 'no trades ranks below a losing trader');
  const half = coverageFloor({ ...rep, fitness: 4 }, (TANET_MIN_COVERAGE / 2) * 1000, 1000);
  assert.ok(Math.abs(half.fitness - -5) < 1e-9, 'half the floor: a lucky few trades cannot score positive');
});

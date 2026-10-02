// Portfolio numerical Kelly: matches closed form on one bet, refuses to double up on comonotonic
// contracts (same index, same close), sizes independent bets separately, caps new orders given held
// positions, normalises edge by lock-up time, and inflates perp risk when capital is locked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { marginalKelly, solveKelly, timeNormalizedEdge, type BinaryBet } from '../bot/sizing/portfolioKelly';

const bet = (id: string, prob: number, cost: number, extra: Partial<BinaryBet> = {}): BinaryBet => ({ id, prob, cost, lockSec: 3600, ...extra });

test('one bet: numerical optimum = closed-form Kelly (p - c) / (1 - c)', () => {
  const s = solveKelly([bet('a', 0.6, 0.5)], [], { scenarios: 20_000 });
  assert.ok(Math.abs(s.f.a - 0.2) < 0.015, `f* ${s.f.a}`);
  assert.equal(solveKelly([bet('b', 0.45, 0.5)]).f.b, 0, 'no edge, no bet');
});

test('correlation: two contracts on the same move are not two independent edges', () => {
  const g = { group: 'BTC:12:00', direction: 1 as const };
  const co = solveKelly([bet('a', 0.6, 0.5, g), bet('b', 0.6, 0.5, g)], [], { scenarios: 20_000 });
  assert.ok(Math.abs(co.f.a + co.f.b - 0.2) < 0.02, `comonotonic total ${co.f.a + co.f.b}`);
  const ind = solveKelly([bet('a', 0.6, 0.5), bet('b', 0.6, 0.5)], [], { scenarios: 20_000 });
  assert.ok(ind.f.a > 0.15 && ind.f.b > 0.15, `independent ${ind.f.a} ${ind.f.b}`);
  // YES above and NO above on the same index hedge each other: allowed more in total than one alone.
  const hedge = solveKelly([bet('y', 0.6, 0.5, g), bet('n', 0.6, 0.5, { group: g.group, direction: -1 })], [], { scenarios: 20_000 });
  assert.ok(hedge.f.y + hedge.f.n > 0.2);
});

test('marginal cap: a held correlated position shrinks the new order; never negative', () => {
  const g = { group: 'ETH:13:00', direction: 1 as const };
  const alone = marginalKelly(bet('new', 0.6, 0.5, g), []);
  const withHeld = marginalKelly(bet('new', 0.6, 0.5, g), [{ ...bet('old', 0.6, 0.5, g), frac: 0.15 }]);
  assert.ok(alone > 0.15 && withHeld < alone - 0.1, `alone ${alone}, with held ${withHeld}`);
  assert.equal(marginalKelly(bet('x', 0.4, 0.5), []), 0);
  assert.equal(marginalKelly(bet('x', 0.9, 0.5), [{ ...bet('o', 0.9, 0.5), frac: 0.95 }]), 0, 'no capital left');
});

test('time-normalised edge and locked-capital perp inflation', () => {
  const short = timeNormalizedEdge(bet('s', 0.6, 0.5, { lockSec: 900 })), long = timeNormalizedEdge(bet('l', 0.6, 0.5, { lockSec: 86_400 }));
  assert.ok(Math.abs(short / long - 96) < 1e-9, 'same edge locked 96x shorter = 96x the daily rate');
  const perp = [{ id: 'p', mu: 0.0002, sigma: 0.02, horizonSec: 14_400 }];
  const free = solveKelly([], perp, { scenarios: 20_000 }).f.p, locked = solveKelly([], perp, { scenarios: 20_000, lockedFrac: 0.6 }).f.p;
  assert.ok(locked < free * 0.5, `perp stake ${free} -> ${locked} with 60% locked`);
});

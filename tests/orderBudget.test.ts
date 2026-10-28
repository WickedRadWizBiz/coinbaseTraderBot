import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderBudget } from '../bot/sizing/orderBudget';

const base = { bankroll: 200, orderFrac: 0.02, sizeMult: 1, riskScale: 1, fCapUsd: Infinity, paperOrderUsd: 0, maxContractsPerOrder: 50 };

test('order budget: tier x session/regime x risk scale, capped by optimal f', () => {
  assert.deepEqual(orderBudget(base), { maxOrderRiskUsd: 4, maxContracts: 50, boundBy: 'tier' });
  const shrunk = orderBudget({ ...base, sizeMult: 0.5, riskScale: 0.5 });
  assert.equal(shrunk.maxOrderRiskUsd, 1);
  assert.equal(shrunk.maxContracts, 25);
  const capped = orderBudget({ ...base, fCapUsd: 2.5 });
  assert.equal(capped.maxOrderRiskUsd, 2.5);
  assert.equal(capped.boundBy, 'optimal_f');
  // A cap above the tier's stake changes nothing; a cap of 0 (no edge, live) stops the order.
  assert.equal(orderBudget({ ...base, fCapUsd: 10 }).boundBy, 'tier');
  assert.equal(orderBudget({ ...base, fCapUsd: 0 }).maxOrderRiskUsd, 0);
});

test('order budget: a paper order size replaces the rest', () => {
  const b = orderBudget({ ...base, paperOrderUsd: 20, sizeMult: 0.5, fCapUsd: 1 });
  assert.deepEqual(b, { maxOrderRiskUsd: 20, maxContracts: 50, fixedOrderUsd: 20, boundBy: 'paper' });
});

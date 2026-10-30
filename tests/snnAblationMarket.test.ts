// The ablation's "vs market" line: the SNN alone against the contract's mid, per settlement window, day-block CI.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vsMarket } from '../research/snnAblation';
import type { SnnRow } from '../research/snnReplay';
import { Xoshiro128 } from '../bot/snn/rng';

function rows(n: number, snn: (truth: number, mid: number) => number, seed = 3): SnnRow[] {
  const r = new Xoshiro128(seed), out: SnnRow[] = [];
  for (let i = 0; i < n; i++) {
    const truth = 0.1 + 0.8 * r.next(), y: 0 | 1 = r.next() < truth ? 1 : 0;
    const mid = Math.min(0.99, Math.max(0.01, truth + 0.25 * r.normal()));
    const day = `2026-10-${String(10 + (i % 6)).padStart(2, '0')}`;
    for (let k = 0; k < 2; k++) out.push({ ticker: `T${i}`, eventKey: `E${i}`, column: 'BTC-15m', ts: i * 1000 + k, day, kind: 'greater', pModel: mid, pSnn: snn(truth, mid), mid, y, surprise: 0, surprise0: 1, G: 0, volRatio: 1 } as SnnRow);
  }
  return out;
}

test('vs market: an SNN that knows the truth beats a noisy mid; one that copies the mid ties; one that adds noise loses', () => {
  const better = vsMarket(rows(1200, (t) => t), 400);
  assert.ok(better.hi < 0, `better: ${JSON.stringify(better)}`);
  const same = vsMarket(rows(1200, (_t, m) => Math.min(0.98, Math.max(0.02, m))), 400);
  assert.ok(Math.abs(same.mean) < 1e-12 && same.lo <= 0 && same.hi >= 0, `copy of the clipped mid ties: ${JSON.stringify(same)}`);
  const r = new Xoshiro128(9);
  const worse = vsMarket(rows(1200, (_t, m) => Math.min(0.99, Math.max(0.01, m + 0.3 * r.normal()))), 400);
  assert.ok(worse.lo > 0, `worse: ${JSON.stringify(worse)}`);
  assert.equal(better.events, 1200, 'two snapshots of one contract are one window');
  assert.equal(better.days, 6);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MarketStateReading } from '../bot/marketdata/marketState';
import { DYNAMIC_EDGE_OFF, dynamicEdge, dynamicEdgeOn } from '../bot/strategy/dynamicEdge';
import { loadConfig } from '../bot/config';

const reading = (over: Partial<MarketStateReading> = {}): MarketStateReading => ({
  asset: 'BTC', minute: 0, rv15m: 2e-4, rv1h: 1e-4, rv6h: 1e-4, volRatio: 2, jump: 1, changeProb: 0.5, spread: 0.04, depth: 100,
  flowImbalance: -0.5, flowContracts: 40, correlation: 0.6, ...over,
});

test('off by default: the static edge is unchanged', () => {
  assert.equal(dynamicEdgeOn(DYNAMIC_EDGE_OFF), false);
  assert.equal(dynamicEdge(DYNAMIC_EDGE_OFF, reading(), 0.1).add, 0);
});

test('each reading adds its part, clamped both ways', () => {
  const p = { ...DYNAMIC_EDGE_OFF, vol: 0.02, change: 0.03, spread: 0.5, flow: 0.02, uncertainty: 0.5 };
  const e = dynamicEdge(p, reading(), 0.02);
  assert.ok(Math.abs(e.parts.vol - 0.02) < 1e-12);
  assert.ok(Math.abs(e.parts.change - 0.015) < 1e-12);
  assert.ok(Math.abs(e.parts.spread - 0.02) < 1e-12);
  assert.ok(Math.abs(e.parts.flow - 0.01) < 1e-12);
  assert.ok(Math.abs(e.parts.uncertainty - 0.01) < 1e-12);
  assert.ok(Math.abs(e.add - 0.05) < 1e-12, 'capped at maxUp');
  // Calm market, vol only: the edge falls, but no further than maxDown.
  const calm = dynamicEdge({ ...DYNAMIC_EDGE_OFF, vol: 0.05 }, reading({ volRatio: 0.2 }), undefined);
  assert.equal(calm.add, -0.01);
});

test('a reading the market state lacks adds nothing', () => {
  const p = { ...DYNAMIC_EDGE_OFF, vol: 0.02, change: 0.03, spread: 0.5, flow: 0.02 };
  const e = dynamicEdge(p, reading({ volRatio: null, changeProb: null, spread: null, flowImbalance: null }), undefined);
  assert.equal(e.add, 0);
  assert.equal(dynamicEdge(p, undefined, undefined).add, 0);
});

test('config reads DYN_EDGE_*', () => {
  const cfg = loadConfig({ DYN_EDGE_CHANGE: '0.03', DYN_EDGE_MAX_UP: '0.04' } as NodeJS.ProcessEnv);
  assert.equal(cfg.strategy.dynamicEdge.change, 0.03);
  assert.equal(cfg.strategy.dynamicEdge.maxUp, 0.04);
  assert.equal(loadConfig({} as NodeJS.ProcessEnv).strategy.dynamicEdge.vol, 0);
});

test('quiet: a coin that has not moved asks more edge, a moving one asks none', () => {
  const p = { ...DYNAMIC_EDGE_OFF, quiet: 0.02 };
  assert.equal(dynamicEdgeOn(p), true);
  assert.ok(Math.abs(dynamicEdge(p, reading({ jump: 1.1 }), 0).parts.quiet - 0.01) < 1e-12, 'half the ref: half the weight');
  assert.equal(dynamicEdge(p, reading({ jump: 3 }), 0).add, 0);
  assert.equal(dynamicEdge(p, reading({ jump: null as unknown as number }), 0).add, 0, 'no reading adds 0');
  assert.equal(loadConfig({ DYN_EDGE_QUIET: '0.03' } as NodeJS.ProcessEnv).strategy.dynamicEdge.quiet, 0.03);
});

test('adversarial controls: bias is a flat add; the placebo returns earlier adds, not the current one', () => {
  assert.ok(Math.abs(dynamicEdge({ ...DYNAMIC_EDGE_OFF, bias: 0.02 }, reading(), 0).add - 0.02) < 1e-12);
  const p = { ...DYNAMIC_EDGE_OFF, spread: 1, placebo: true };
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) seen.add(Math.round(dynamicEdge(p, reading({ spread: (i % 10) / 1000 }), 0).add * 1e6));
  assert.ok(seen.size > 1 && seen.size <= 10, 'only adds already seen come back');
  assert.equal(loadConfig({ DYN_EDGE_PLACEBO: 'true' } as NodeJS.ProcessEnv).strategy.dynamicEdge.placebo, true);
});

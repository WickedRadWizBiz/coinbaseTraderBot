// Neural map helpers: weight samples fill the palette range and stay in [-1, 1].
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupTraderCells, tennisTraderCells, weightTexture } from '../bot/api/neuralMap';

test('weightTexture: n samples in [-1, 1], scaled by the weights\' RMS', () => {
  const w = Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 0.01);
  const t = weightTexture(w);
  assert.equal(t.length, 256);
  assert.ok(t.every((x) => x >= -1 && x <= 1));
  assert.ok(Math.max(...t.map(Math.abs)) > 0.5, 'small weights still use the palette');
  assert.deepEqual(weightTexture([], 0, 0, 4), [0, 0, 0, 0]);
  assert.equal(weightTexture(w, 100, 50, 8).length, 8);
});

test('trader blocks: a flat perps setup trader shows its queue and recent trades; the tennis trader its matches', () => {
  const flat = setupTraderCells({ lanes: { fast: { open: [], queue: [] }, slow: { open: [], queue: [] } }, recentTrades: [] });
  assert.ok(flat.every((x) => x === 0), 'nothing open, queued or traded: dark');
  const recent = setupTraderCells({ lanes: { fast: { open: [], queue: [{ score: 0.3 }] }, slow: {} }, recentTrades: [{ r: -1.2 }, { r: 1.8 }] });
  assert.equal(recent.length, 256);
  assert.ok(recent.filter((x) => x !== 0).length > 200, 'its queue and record light the block');
  assert.ok(recent.every((x) => x >= -1 && x <= 1));
  // The tennis status carries no edge field: the block reads the market lean, the progress and the confluence.
  const matches = [
    { event: 'E1', phase: 'pre', pA: 0.8, progress: 0 },
    { event: 'E2', phase: 'live', pA: 0.45, progress: 0.6, fairA: 0.5, confluence: { 'E2-A': { score: 3 } } },
    { event: 'E3', phase: 'late', progress: 0.95 },
  ];
  const cells = tennisTraderCells(matches);
  assert.ok(cells.filter((x) => x !== 0).length > 100, 'tracked matches light the block');
  assert.ok(cells.every((x) => x >= -1 && x <= 1));
  assert.deepEqual(tennisTraderCells([]).filter((x) => x !== 0), [], 'no matches: dark');
});

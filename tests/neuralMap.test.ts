// Neural map helpers: weight samples fill the palette range and stay in [-1, 1].
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { weightTexture } from '../bot/api/neuralMap';

test('weightTexture: n samples in [-1, 1], scaled by the weights\' RMS', () => {
  const w = Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 0.01);
  const t = weightTexture(w);
  assert.equal(t.length, 256);
  assert.ok(t.every((x) => x >= -1 && x <= 1));
  assert.ok(Math.max(...t.map(Math.abs)) > 0.5, 'small weights still use the palette');
  assert.deepEqual(weightTexture([], 0, 0, 4), [0, 0, 0, 0]);
  assert.equal(weightTexture(w, 100, 50, 8).length, 8);
});

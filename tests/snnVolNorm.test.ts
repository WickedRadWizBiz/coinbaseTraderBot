// Volatility-normalized readout (Oct 31 audit: the anchored correction was ~8x too big in high volatility).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SnnNetwork } from '../bot/snn/network';
import { DEFAULT_SNN, versionHash, withFlags, type SnnParams } from '../bot/snn/params';

const small = (over: Partial<SnnParams> = {}): SnnParams => ({ ...withFlags({ ...DEFAULT_SNN, nE: 32, nI: 8, nL1: 12, maxColumns: 4 }, {}), ...over });
const col = (fast: number, slow: number) => ({ deltaFast: fast, deltaSlow: slow }) as never;

test('vol-normalized readout: absent = features unchanged and the version hash unchanged', () => {
  const net = new SnnNetwork(small({ anchorMid: true }));
  const phi = Float64Array.from([1, 0.5, -0.2]);
  assert.deepEqual([...net.volNormed(col(4, 1), phi)], [1, 0.5, -0.2]);
  assert.equal(versionHash(small({ anchorMid: true })), versionHash({ ...small({ anchorMid: true }), volNorm: undefined }));
});

test('vol-normalized readout: hot activity divides every feature by ratio^k (ratio clipped to 5); calm or quiet leaves them', () => {
  const net = new SnnNetwork(small({ anchorMid: true, volNorm: 1 }));
  const v = (f: number, s: number) => [...net.volNormed(col(f, s), Float64Array.from([1, 0.5]))];
  assert.deepEqual(v(2, 1), [0.5, 0.25]);
  assert.deepEqual(v(50, 1), [0.2, 0.1]);
  assert.deepEqual(v(0.5, 1), [1, 0.5]);
  assert.deepEqual(v(3, 0), [1, 0.5]);
  const k2 = new SnnNetwork(small({ anchorMid: true, volNorm: 2 }));
  assert.deepEqual([...k2.volNormed(col(2, 1), Float64Array.from([1]))], [0.25]);
});

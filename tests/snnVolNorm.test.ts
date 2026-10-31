// Volatility-normalized readout (Oct 31 audit: the anchored correction was ~8x too big in high volatility).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SnnNetwork } from '../bot/snn/network';
import { DEFAULT_SNN, versionHash, withFlags, type SnnParams } from '../bot/snn/params';

const small = (over: Partial<SnnParams> = {}): SnnParams => ({ ...withFlags({ ...DEFAULT_SNN, nE: 32, nI: 8, nL1: 12, maxColumns: 4 }, {}), ...over });
const c = {} as never;

test('vol-normalized readout: absent = features unchanged, ratio 1, and the version hash unchanged', () => {
  const net = new SnnNetwork(small({ anchorMid: true }));
  assert.equal(net.sigmaRatio('BTC', 1e-4, 0), 1);
  assert.deepEqual([...net.volNormed(c, Float64Array.from([1, 0.5, -0.2]), 4)], [1, 0.5, -0.2]);
  assert.equal(versionHash(small({ anchorMid: true })), versionHash({ ...small({ anchorMid: true }), volNorm: undefined }));
});

test('vol-normalized readout: hot volatility divides every feature by ratio^k (clipped to 5); calm leaves them', () => {
  const net = new SnnNetwork(small({ anchorMid: true, volNorm: 1 }));
  const v = (r: number) => [...net.volNormed(c, Float64Array.from([1, 0.5]), r)];
  assert.deepEqual(v(2), [0.5, 0.25]);
  assert.deepEqual(v(50), [0.2, 0.1]);
  assert.deepEqual(v(0.5), [1, 0.5]);
  const k2 = new SnnNetwork(small({ anchorMid: true, volNorm: 2 }));
  assert.deepEqual([...k2.volNormed(c, Float64Array.from([1]), 2)], [0.25]);
});

test('vol-normalized readout: the sigma ratio is against a slow per-asset average that follows the level over hours', () => {
  const net = new SnnNetwork(small({ anchorMid: true, volNorm: 1 }));
  const H = 3_600_000;
  assert.equal(net.sigmaRatio('BTC', 1e-4, 0), 1); // first sight sets the reference
  assert.ok(Math.abs(net.sigmaRatio('BTC', 2e-4, 60_000) - 2) < 1e-9, 'a spike reads as 2x');
  assert.equal(net.sigmaRatio('ETH', 3e-4, 60_000), 1, 'assets keep their own reference');
  let r = 0;
  for (let t = 2; t <= 48; t++) r = net.sigmaRatio('BTC', 2e-4, t * H);
  assert.ok(r < 1.01, `a lasting new level becomes normal: ${r}`);
});

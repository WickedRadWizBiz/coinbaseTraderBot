// Soft labels: the anchored readout also learns from where the market's mid went a few minutes later.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SnnNetwork, type ColumnInput, type ContractQuery } from '../bot/snn/network';
import { DEFAULT_SNN, versionHash, withFlags, type SnnParams } from '../bot/snn/params';
import { Xoshiro128 } from '../bot/snn/rng';

const T0 = Date.UTC(2026, 5, 1);
const small = (over: Partial<SnnParams> = {}): SnnParams => ({ ...withFlags({ ...DEFAULT_SNN, nE: 32, nI: 8, nL1: 12, maxColumns: 4 }, {}), ...over });
const query = (mid: number, extra: Partial<ContractQuery> = {}): ContractQuery => ({ ticker: 'A', column: 'BTC-15m', kind: 'greater', strike: 60000, spot: 60000, sigma: 1e-4, tauSec: 600, lifeSec: 900, eventKey: 'BTC:1', tag: true, mid, ...extra });

function warm(net: SnnNetwork, n = 30) {
  const r = new Xoshiro128(2);
  let spot = 60000;
  for (let s = 0; s < n; s++) {
    spot *= Math.exp(0.0004 * r.normal());
    const inp: ColumnInput[] = [{ key: 'BTC-15m', asset: 'BTC', spot, mid: 0.5, spread: 0.02, imbalance: r.next() * 2 - 1, dAtm: r.normal(), tauFrac: 0.5 }];
    net.step(T0 + s * 1000, inp);
  }
}
const norm = (net: SnnNetwork) => Math.hypot(...net.readouts.get('BTC-15m')!.wf);
const bias = (net: SnnNetwork) => net.readouts.get('BTC-15m')!.wf[0];

test('soft labels: absent = no learning before settlement, and the version hash unchanged', () => {
  const net = new SnnNetwork(small({ anchorMid: true }));
  warm(net);
  net.score([query(0.5)], T0 + 40e3);
  net.score([query(0.7)], T0 + 40e3 + 400e3);
  assert.equal(norm(net), 0);
  assert.equal(versionHash(small({ anchorMid: true })), versionHash({ ...small({ anchorMid: true }), softLabel: undefined }));
});

test('soft labels: a mid that rose lagSec later moves the correction up; too early does nothing', () => {
  const net = new SnnNetwork(small({ anchorMid: true, softLabel: { lagSec: 300, etaScale: 1 } }));
  warm(net);
  net.score([query(0.5)], T0 + 40e3);
  net.score([query(0.7)], T0 + 40e3 + 100e3); // before the lag
  assert.equal(norm(net), 0, 'no update before lagSec');
  net.score([query(0.7)], T0 + 40e3 + 300e3);
  assert.ok(bias(net) > 0, `bias weight up: ${bias(net)}`);
  const net2 = new SnnNetwork(small({ anchorMid: true, softLabel: { lagSec: 300, etaScale: 1 } }));
  warm(net2);
  net2.score([query(0.5)], T0 + 40e3);
  net2.score([query(0.3)], T0 + 40e3 + 300e3);
  assert.ok(bias(net2) < 0, `bias weight down: ${bias(net2)}`);
});

test('soft labels: a "less" contract learns toward 1 - mid; paused learning learns nothing', () => {
  const net = new SnnNetwork(small({ anchorMid: true, softLabel: { lagSec: 300, etaScale: 1 } }));
  warm(net);
  const less = (mid: number) => query(mid, { kind: 'less', cap: 60000, strike: undefined });
  net.score([less(0.5)], T0 + 40e3);
  net.score([less(0.3)], T0 + 340e3); // P(below cap) fell -> P(above cap) rose
  assert.ok(bias(net) > 0, `exceedance correction up: ${bias(net)}`);
  const paused = new SnnNetwork(small({ anchorMid: true, softLabel: { lagSec: 300, etaScale: 1 } }));
  warm(paused);
  paused.pauseLearning = true;
  paused.score([query(0.5)], T0 + 40e3);
  paused.score([query(0.9)], T0 + 340e3);
  assert.equal(norm(paused), 0);
});

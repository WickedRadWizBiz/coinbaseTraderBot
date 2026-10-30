// The mid-anchored contract readout (SNN plan phase 1): the readout starts as the market and learns the correction.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snnParams } from '../bot/snn';
import { loadConfig } from '../bot/config';
import { SnnNetwork, type ColumnInput, type ContractQuery } from '../bot/snn/network';
import { anchorFor, DEFAULT_SNN, versionHash, withFlags, type SnnParams } from '../bot/snn/params';
import { Xoshiro128 } from '../bot/snn/rng';
import { fitLogistic } from '../research/trainSnn';

const T0 = Date.UTC(2026, 5, 1);
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function small(over: Partial<SnnParams> = {}): SnnParams {
  return { ...withFlags({ ...DEFAULT_SNN, nE: 32, nI: 8, nL1: 12, maxColumns: 4 }, {}), ...over };
}

function tape(n: number, seed = 1): ColumnInput[][] {
  const r = new Xoshiro128(seed);
  let spot = 60000, mid = 0.5;
  const out: ColumnInput[][] = [];
  for (let s = 0; s < n; s++) {
    spot *= Math.exp(0.0004 * r.normal());
    mid = Math.min(0.95, Math.max(0.05, mid + 0.01 * r.normal()));
    out.push([{ key: 'BTC-15m', asset: 'BTC', spot, mid, spread: 0.02, imbalance: r.next() * 2 - 1, dAtm: r.normal(), tauFrac: 0.5 }]);
  }
  return out;
}

const query = (ticker: string, extra: Partial<ContractQuery> = {}): ContractQuery => ({ ticker, column: 'BTC-15m', kind: 'greater', strike: 60000, spot: 60000, sigma: 1e-4, tauSec: 600, lifeSec: 900, eventKey: 'BTC:1', tag: true, ...extra });

test('anchored readout: with fresh weights the price is the market, clipped; a "less" contract reads 1 - mid; no mid falls back to the crude fair value', () => {
  const net = new SnnNetwork(small({ anchorMid: true }));
  const tp = tape(5);
  for (let s = 0; s < 5; s++) net.step(T0 + s * 1000, tp[s]);
  const t = T0 + 6e3;
  const at = (q: Partial<ContractQuery>, tk = 'A') => net.score([query(tk, { tag: false, ...q })], t)[0].p;
  assert.ok(Math.abs(at({ mid: 0.3 }) - 0.3) < 1e-9, 'p = mid');
  assert.ok(Math.abs(at({ mid: 0.3, kind: 'less', cap: 60000, strike: undefined }) - 0.3) < 1e-9, 'a less contract: P(below cap) = mid again');
  assert.ok(Math.abs(at({ mid: 0.005 }) - 0.02) < 1e-9, 'clipped at 2%');
  assert.ok(Math.abs(at({ mid: 0.999 }) - 0.98) < 1e-9, 'clipped at 98%');
  // Without a mid: the crude fair value sigma(priorSlope x d), d = ln(spot / K) / (sigma sqrt(tau)).
  const d = Math.log(60000 / 59900) / (1e-4 * Math.sqrt(600));
  assert.ok(Math.abs(at({ strike: 59900 }) - sigmoid(DEFAULT_SNN.priorSlope * d)) < 1e-9, 'fallback prior');
  // The un-anchored network prices the same contract from its prior weights, and ignores the mid.
  const plain = new SnnNetwork(small());
  for (let s = 0; s < 5; s++) plain.step(T0 + s * 1000, tp[s]);
  const a = plain.score([query('P', { tag: false, mid: 0.3 })], t)[0].p, b = plain.score([query('P', { tag: false })], t)[0].p;
  assert.equal(a, b);
  assert.equal(net.anchorLogit({ kind: 'between', mid: 0.4 }, 'strike', 1), DEFAULT_SNN.priorSlope * 1, 'a between contract mid anchors neither threshold');
});

test('anchored readout: it learns where the market is wrong, and the settlement delta is the exact gradient of the anchored p', () => {
  const p = small({ anchorMid: true, readoutEta: 0.05, readoutCap: 1 });
  const net = new SnnNetwork(p);
  const tp = tape(30);
  for (let s = 0; s < 30; s++) net.step(T0 + s * 1000, tp[s]);
  const ro = net.readouts.get('BTC-15m')!;
  assert.ok(ro.wf.every((w) => w === 0), 'weights start at zero');
  const before = Float64Array.from(ro.wf);
  net.score([query('C1', { mid: 0.4 })], T0 + 30e3);
  const tag = ro.tags.get('C1')!.tags[0];
  assert.ok(Math.abs(tag.p - 0.4) < 1e-9, 'the tag holds the anchored p');
  const G = net.columns.get('BTC-15m')!.G;
  net.settle('C1', 'yes', T0 + 40e3);
  const eta = 0.05 * (1 - p.govDelta * G);
  for (let i = 0; i < ro.n; i++) assert.ok(Math.abs(ro.wf[i] - before[i] - eta * (1 - tag.p) * tag.phi[i]) < 1e-9, `dw[${i}]`);
  // The market says 40% while every contract settles YES: the readout learns to price above the market.
  for (let k = 1; k <= 60; k++) { net.score([query(`Z${k}`, { mid: 0.4 })], T0 + (50 + k * 61) * 1000); net.settle(`Z${k}`, 'yes', T0 + (50 + k * 61) * 1000 + 1); }
  const learned = net.score([query('Zend', { tag: false, mid: 0.4 })], T0 + 9000e3)[0].p;
  assert.ok(learned > 0.5, `prices above the 40% market: ${learned}`);
  // ... and the correction travels with the market: at a 70% mid it prices higher still.
  const higher = net.score([query('Zend2', { tag: false, mid: 0.7 })], T0 + 9001e3)[0].p;
  assert.ok(higher > learned, `${higher} > ${learned}`);
  // Checkpoint and restore keep it.
  const copy = new SnnNetwork(p);
  copy.restore(net.serialize());
  assert.equal(copy.score([query('Zend', { tag: false, mid: 0.4 })], T0 + 9000e3)[0].p, learned);
});

test('anchored readout: the setting is a version of its own; absent, every hash and price is as before', () => {
  const base = small();
  assert.equal(versionHash(base), versionHash({ ...base }));
  assert.notEqual(versionHash(base), versionHash({ ...base, anchorMid: true }));
  assert.throws(() => new SnnNetwork(small({ anchorMid: true })).restore(new SnnNetwork(base).serialize()), /version/);
  // On by default (Steven, Oct 30), and only on the crypto contract network, where it was measured.
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40) });
  assert.equal(cfg.snn.anchorMid, true);
  assert.equal(snnParams(cfg.snn, 'crypto').anchorMid, true);
  for (const d of ['perps', 'tennis'] as const) assert.equal('anchorMid' in snnParams(cfg.snn, d), false, `${d}: its params and version hash are unchanged`);
  assert.equal('anchorMid' in snnParams(cfg.snn), false, 'no domain: unchanged');
  assert.equal(anchorFor(true, 'crypto'), true);
  assert.equal(anchorFor(false, 'crypto'), false);
  const off = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), SNN_ANCHOR_MID: 'false' });
  assert.equal('anchorMid' in snnParams(off.snn, 'crypto'), false, 'SNN_ANCHOR_MID=false restores the plain readout');
});

test('anchored readout: weights learned under the other kind are never carried over (checkpoint or model file)', () => {
  const tp = tape(30);
  // A plain network that has learned something.
  const plain = new SnnNetwork(small({ readoutEta: 0.05, readoutCap: 1 }));
  for (let s = 0; s < 30; s++) plain.step(T0 + s * 1000, tp[s]);
  for (let k = 1; k <= 20; k++) { plain.score([query(`P${k}`)], T0 + (40 + k * 61) * 1000); plain.settle(`P${k}`, 'yes', T0 + (40 + k * 61) * 1000 + 1); }
  const cp = plain.serialize();
  assert.equal(cp.anchorMid, undefined, 'a plain checkpoint does not say anchored');
  // Into an anchored network (the history walk and the tournament restore with allowParamChange): columns kept,
  // contract readouts start at zero correction, so the price is the market.
  const anch = new SnnNetwork(small({ anchorMid: true }));
  anch.restore(cp, { allowParamChange: true });
  const ro = anch.readouts.get('BTC-15m')!;
  assert.ok(ro.wf.every((w) => w === 0) && ro.ws.every((w) => w === 0) && ro.tags.size === 0, 'zero correction, no tags');
  assert.deepEqual(anch.columns.get('BTC-15m')!.arrays().U1, plain.columns.get('BTC-15m')!.arrays().U1, 'the column itself is kept');
  assert.ok(Math.abs(anch.score([query('Q', { tag: false, mid: 0.37 })], T0 + 9000e3)[0].p - 0.37) < 1e-9, 'prices at the market');
  // The same through a model file (the daily training's --init from the walk's elite).
  const model = plain.exportModel('plain');
  const fromModel = new SnnNetwork(small({ anchorMid: true }), { model });
  for (let s = 0; s < 3; s++) fromModel.step(T0 + s * 1000, tp[s]);
  assert.ok(fromModel.readouts.get('BTC-15m')!.wf.every((w) => w === 0), 'a plain model lends no contract readout');
  // An anchored checkpoint written and restored keeps its kind and its weights.
  const back = anch.serialize();
  assert.equal(back.anchorMid, true);
  // Anchored -> plain (the setting turned off): the crude prior, as a fresh plain network starts.
  const again = new SnnNetwork(small());
  again.restore(back, { allowParamChange: true });
  const fresh = new SnnNetwork(small());
  for (let s = 0; s < 3; s++) fresh.step(T0 + s * 1000, tp[s]);
  assert.deepEqual([...again.readouts.get('BTC-15m')!.wf], [...fresh.readouts.get('BTC-15m')!.wf], 'the prior weights');
});

test('offline readout fit: with offsets the weights learn the correction to the market, not the market', () => {
  // Rows: the market logit as the offset; the truth is the market plus 1.5 x feature 1. The bias (feature 0) is 1.
  const r = new Xoshiro128(5);
  const X: Float64Array[] = [], y: number[] = [], off: number[] = [];
  for (let i = 0; i < 3000; i++) {
    const mid = 0.2 + 0.6 * r.next(), f = r.normal();
    const pt = sigmoid(logit(mid) + 1.5 * f);
    X.push(Float64Array.from([1, f])); y.push(r.next() < pt ? 1 : 0); off.push(logit(mid));
  }
  const fit = fitLogistic(X, y, new Float64Array(2), 1e-4, 300, off);
  assert.ok(Math.abs(fit.w[1] - 1.5) < 0.25, `slope ${fit.w[1]}`);
  assert.ok(Math.abs(fit.w[0]) < 0.15, `bias ${fit.w[0]}`);
  // Without the offsets the same rows fit a different, worse model (the market is not in the features).
  const plain = fitLogistic(X, y, new Float64Array(2), 1e-4, 300);
  assert.ok(plain.loss > fit.loss + 0.02, `${plain.loss} > ${fit.loss}`);
});

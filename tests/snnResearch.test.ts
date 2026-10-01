// SNN research pipeline end to end on synthetic recordings (plumbing only; synthetic data says
// nothing about real edge): prequential replay, ablation verdict with criteria a-f, offline
// training export loadable by the live network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadSnnModel } from '../bot/snn';
import { SnnNetwork } from '../bot/snn/network';
import { DEFAULT_SNN, stageFlags, versionHash, withFlags } from '../bot/snn/params';
import { blendGain, judge, MAX_GRID, MECHANISMS, pairedEvent, paperPnl, summarize } from '../research/snnAblation';
import { replaySnn } from '../research/snnReplay';
import { writeSyntheticRecordings } from '../research/synthetic';
import { fitLogistic } from '../research/trainSnn';
import { tmpDir } from './helpers';

const small = (stage: 'S0' | 'S1' | 'S5') => withFlags({ ...DEFAULT_SNN, nE: 24, nI: 6, nL1: 10 }, stageFlags(stage));

test('prequential SNN replay labels every scanned contract and the ablation judge applies criteria a-f', async () => {
  const dir = tmpDir();
  writeSyntheticRecordings(dir, { windows: 6, seed: 5 });
  const s1 = await replaySnn(dir, { params: small('S1') });
  const s0 = await replaySnn(dir, { params: small('S0') });
  assert.ok(s1.rows.length > 10, `rows ${s1.rows.length}`);
  assert.ok(s1.rows.every((r) => r.y === 0 || r.y === 1) && s1.rows.every((r) => r.pSnn > 0 && r.pSnn < 1));
  // Strict timestamps: every scored row precedes its contract's settlement.
  assert.ok(s1.rows.every((r) => r.ts < Number(r.eventKey.split(':')[1])));
  assert.ok(s1.steps > 1000 && s1.stepMs.length === s1.steps);
  const d = pairedEvent(s1.rows, s0.rows, (r) => (r.pSnn - r.y) ** 2);
  assert.ok(d.events >= 1);
  const v = judge(MECHANISMS[1], s1, s0, summarize('S1', {}, s1), summarize('S0', {}, s0), []);
  assert.deepEqual(Object.keys(v.criteria).sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(v.accepted, Object.values(v.criteria).every(Boolean));
  assert.ok(v.blend.alpha >= 0 && v.blend.alpha <= 0.25);
  assert.ok(Number.isFinite(paperPnl(s1.rows, (r) => r.pModel)));
  assert.ok(Number.isFinite(blendGain(s1.rows, () => 1).mean));
  assert.equal(MAX_GRID, 20);
  assert.equal(MECHANISMS.filter((m) => /^S\d/.test(m.name)).length, 7, 'S0..S6');
});

test('offline training: logistic fit, e-prop L1 update and an export the live network loads', async () => {
  // Logistic regression recovers a known slope.
  const X: Float64Array[] = [], y: number[] = [];
  let s = 1;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 3000; i++) { const x = r() * 4 - 2; X.push(Float64Array.from([1, x])); y.push(r() < 1 / (1 + Math.exp(-2 * x)) ? 1 : 0); }
  const fit = fitLogistic(X, y, new Float64Array(2), 1e-6, 500);
  assert.ok(Math.abs(fit.w[1] - 2) < 0.3, `slope ${fit.w[1]}`);
  // e-prop changes L1 weights; collected snapshots are labelled.
  const dir = tmpDir();
  writeSyntheticRecordings(dir, { windows: 4, seed: 6 });
  const p = small('S5');
  const tr = await replaySnn(dir, { params: p, training: { eprop: { eta: 0.05 }, collect: true } });
  assert.ok(tr.collected.length > 0 && tr.collected.every((c) => c.y === 0 || c.y === 1));
  const fresh = new SnnNetwork(p);
  fresh.column('BTC-15m', 'BTC');
  assert.notDeepEqual(Array.from(tr.net.columns.get('BTC-15m')!.w1), Array.from(fresh.columns.get('BTC-15m')!.w1), 'e-prop moved the L1 weights');
  const file = path.join(dir, 'snn_model.json');
  const model = { ...tr.net.exportModel('test'), version: versionHash(p) };
  fs.writeFileSync(file, JSON.stringify(model));
  const loaded = loadSnnModel(file)!;
  const live = new SnnNetwork(loaded.params, { model: loaded });
  live.column('BTC-15m', 'BTC');
  assert.deepEqual(Array.from(live.columns.get('BTC-15m')!.w1), Array.from(tr.net.columns.get('BTC-15m')!.w1), 'live network starts from the trained weights');
  assert.deepEqual(Array.from(live.readouts.get('BTC-15m')!.wf), Array.from(tr.net.readouts.get('BTC-15m')!.wf));
  fs.writeFileSync(file, JSON.stringify({ ...model, version: 'tampered' }));
  assert.throws(() => loadSnnModel(file), /version hash/);
});

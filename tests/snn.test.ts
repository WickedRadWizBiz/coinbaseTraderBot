// SNN network, readout, governor, health, blender, host and engine integration.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { Alerter } from '../bot/alerts/alerter';
import { loadConfig } from '../bot/config';
import { Engine, snnColumn } from '../bot/engine';
import type { KalshiRest } from '../bot/kalshi/rest';
import type { MarketInfo } from '../bot/kalshi/types';
import { MarketData, Recorder } from '../bot/marketdata/marketData';
import { MetaModel } from '../bot/model/metaModel';
import { Oms } from '../bot/oms/oms';
import { PaperExchange } from '../bot/paper/paperExchange';
import { Reconciler } from '../bot/recon/reconciler';
import { KillSwitch } from '../bot/risk/killSwitch';
import { RiskGateway } from '../bot/risk/riskGateway';
import { blendedTarget, dayBlockBootstrap, impliedQuantile, SnnBlender, TargetScaler, DEFAULT_BLENDER } from '../bot/snn/blender';
import { SnnHealth } from '../bot/snn/health';
import { SnnHost } from '../bot/snn/host';
import { createSnnFleet, snnParams } from '../bot/snn';
import { SnnNetwork, type ColumnInput, type ContractQuery } from '../bot/snn/network';
import { DEFAULT_SNN, domainParams, stageFlags, versionHash, withFlags, type SnnParams } from '../bot/snn/params';
import { CRYPTO_POP, cryptoValues, l0Width, tennisValues } from '../bot/snn/inputs';
import { exceedLabel, Readout } from '../bot/snn/readout';
import { Xoshiro128 } from '../bot/snn/rng';
import { tmpAudit, tmpDir } from './helpers';

const T0 = Date.UTC(2026, 5, 1);
const KEYS = ['BTC-15m', 'ETH-15m'];

/** Small network for fast tests (same mechanisms, fewer neurons). */
function small(flags: Partial<SnnParams['flags']> = {}): SnnParams {
  return withFlags({ ...DEFAULT_SNN, nE: 32, nI: 8, nL1: 12, maxColumns: 4 }, flags);
}

function tape(n: number, seed = 1): ColumnInput[][] {
  const r = new Xoshiro128(seed);
  let spot = 60000, mid = 0.5;
  const out: ColumnInput[][] = [];
  for (let s = 0; s < n; s++) {
    spot *= Math.exp(0.0004 * r.normal());
    mid = Math.min(0.95, Math.max(0.05, mid + 0.01 * r.normal()));
    out.push(KEYS.map((key) => ({ key, asset: key.split('-')[0], spot: key.startsWith('ETH') ? spot / 20 : spot, mid, spread: 0.02, imbalance: r.next() * 2 - 1, dAtm: r.normal(), tauFrac: 1 - (s % 900) / 900, rsi: 30 + 40 * r.next(), retZ: r.normal() })));
  }
  return out;
}

const query = (ticker: string, strike: number, extra: Partial<ContractQuery> = {}): ContractQuery => ({ ticker, column: 'BTC-15m', kind: 'greater', strike, spot: 60000, sigma: 1e-4, tauSec: 600, lifeSec: 900, eventKey: 'BTC:1', tag: true, ...extra });

test('determinism: the same tick log gives bit-identical outputs; checkpoint/restore continues identically', () => {
  const tp = tape(400);
  const run = (net: SnnNetwork, from: number, to: number) => { for (let s = from; s < to; s++) net.step(T0 + s * 1000, tp[s]); };
  const a = new SnnNetwork(small({ plasticity: true }));
  const b = new SnnNetwork(small({ plasticity: true }));
  run(a, 0, 400); run(b, 0, 200);
  const cp = JSON.parse(JSON.stringify(b.serialize()));
  const c = new SnnNetwork(small({ plasticity: true }));
  c.restore(cp);
  run(b, 200, 400); run(c, 200, 400);
  const qs = [query('A', 59900), query('B', 60100)];
  const pa = a.score(qs, T0 + 400e3).map((s) => s.p), pb = b.score(qs, T0 + 400e3).map((s) => s.p), pc = c.score(qs, T0 + 400e3).map((s) => s.p);
  assert.deepEqual(pa, pb, 'same log -> same output');
  assert.deepEqual(pb, pc, 'restored checkpoint -> same output');
  for (const k of KEYS) {
    const ca = a.columns.get(k)!, cc = c.columns.get(k)!;
    assert.deepEqual(Array.from(ca.v2), Array.from(cc.v2));
    assert.deepEqual(Array.from(ca.w1), Array.from(cc.w1));
    assert.equal(ca.G, cc.G);
  }
  // Connectivity does not depend on the order columns appear.
  const d = new SnnNetwork(small());
  d.step(T0, [tp[0][1]]); d.step(T0 + 1000, [tp[1][0]]);
  assert.deepEqual(Array.from(d.columns.get('BTC-15m')!.src), Array.from(a.columns.get('BTC-15m')!.src));
  // A checkpoint of a different network version is refused.
  assert.throws(() => new SnnNetwork(small({ lateral: false })).restore(cp), /version/);
});

test('architecture sizes match the design (per column) and the step order runs all levels', () => {
  const net = new SnnNetwork(DEFAULT_SNN);
  net.step(T0, [tape(1)[0][0]]);
  const c = net.columns.get('BTC-15m')!;
  // L0 widened beyond the PDF's 64 to carry the TA library, perp and book inputs (8 delta + 24 x 8 bands).
  assert.equal(c.v0.length, l0Width('crypto'), 'L0 crypto channels');
  assert.equal(l0Width('crypto'), 8 + 8 * CRYPTO_POP.length);
  assert.equal(c.v1.length, 48, 'L1 48 Poirazi neurons');
  assert.equal(c.nSyn, 48 * 6 * 16, '6 branches x 16 synapses');
  assert.equal(c.v2.length, 160, '128 E + 32 I');
  assert.equal(c.U1.length, 48 * 128, 'U1: L2/3 -> L1');
  assert.equal(c.U0.length, l0Width('crypto') * 48, 'U0: L1 -> L0');
  assert.equal(c.err0.length, l0Width('crypto'), 'signed L0 error units');
  assert.equal(c.horizonSec, 900, 'BTC-15m predicts 15 minutes ahead');
  assert.ok(Math.abs(c.recW.length / (160 * 159) - 0.1) < 0.02, `~10% recurrent (${c.recW.length})`);
  assert.ok(c.nFeat >= 195 && c.nFeat <= 210, `~200 readout features (${c.nFeat})`);
  const t = new SnnNetwork(DEFAULT_SNN);
  t.step(T0, [{ key: 'TEN:KXATPMATCH-X', asset: 'TENNIS', price: 0.4, values: { momentum: 0.01, flow: 0.2 } }]);
  const tc = t.columns.get('TEN:KXATPMATCH-X')!;
  assert.equal(tc.kind, 'tennis'); assert.equal(tc.v0.length, l0Width('tennis')); assert.equal(tc.horizonSec, 300);
});

test('the network is alive: levels fire in the asynchronous low-rate regime and PC produces a surprise signal', () => {
  const net = new SnnNetwork(small());
  const tp = tape(900);
  for (let s = 0; s < 900; s++) net.step(T0 + s * 1000, tp[s]);
  const c = net.columns.get('BTC-15m')!;
  assert.ok(c.rateL0 > 0.01 && c.rateL0 < 0.6, `L0 ${c.rateL0}`);
  assert.ok(c.rateL1 > 0.001 && c.rateL1 < 0.6, `L1 ${c.rateL1}`);
  assert.ok(c.rateE >= 0 && c.rateE < 0.5 && c.rateI < 0.8, `E ${c.rateE} I ${c.rateI}`);
  assert.ok(c.surprise > 0 && Number.isFinite(c.surprise));
  assert.ok(Object.keys(net.salience).length === 2 && Object.values(net.salience).every((v) => v >= 0 && v < 1));
});

test('whitelist-only and at most maxColumns: the SNN can never add assets', () => {
  const net = new SnnNetwork(small(), { whitelist: ['BTC-15m'] });
  net.step(T0, tape(1)[0]);
  assert.deepEqual([...net.columns.keys()], ['BTC-15m']);
  const capped = new SnnNetwork({ ...small(), maxColumns: 1 });
  capped.step(T0, tape(1)[0]);
  assert.equal(capped.columns.size, 1);
  assert.equal(capped.score([query('X', 60000, { column: 'ETH-15m' })], T0).length, 0);
});

test('strike monotonicity: P(index > K) is non-increasing across an event ladder; between/less map consistently', () => {
  const net = new SnnNetwork(small());
  const tp = tape(60);
  for (let s = 0; s < 60; s++) net.step(T0 + s * 1000, tp[s]);
  // Corrupt the readout so raw predictions violate monotonicity, then check the projection.
  const ro = net.readouts.get('BTC-15m')!;
  ro.wf[1] = -6; ro.wf[2] = 9;
  const qs = [59700, 59900, 60000, 60100, 60300].map((k, i) => query(`K${i}`, k));
  const sc = net.score(qs, T0 + 60e3);
  const ps = qs.map((q) => sc.find((s) => s.ticker === q.ticker)!.p);
  for (let i = 1; i < ps.length; i++) assert.ok(ps[i] <= ps[i - 1] + 1e-12, `monotone: ${ps}`);
  const mixed = net.score([query('G', 59900), query('L', 60100, { kind: 'less', strike: undefined, cap: 60100 }), query('B', 0, { kind: 'between', strike: 59900, cap: 60100 })], T0 + 60e3);
  const g = mixed.find((s) => s.ticker === 'G')!, l = mixed.find((s) => s.ticker === 'L')!, b = mixed.find((s) => s.ticker === 'B')!;
  assert.ok(Math.abs(b.p - Math.max(1e-4, g.pExceed.strike! - (1 - l.p))) < 1e-9, 'between = P(>floor) - P(>cap)');
});

test('per-contract tags: settlement applies dw = eta (y - p) phi exactly, once per contract, and learns', () => {
  const p = small();
  const net = new SnnNetwork({ ...p, readoutEta: 0.05, readoutCap: 1 });
  const tp = tape(30);
  for (let s = 0; s < 30; s++) net.step(T0 + s * 1000, tp[s]);
  const ro = net.readouts.get('BTC-15m')!;
  const before = Float64Array.from(ro.wf);
  net.score([query('C1', 60000)], T0 + 30e3);
  const tag = ro.tags.get('C1')!.tags[0];
  const G = net.columns.get('BTC-15m')!.G;
  const r = net.settle('C1', 'yes', T0 + 40e3);
  assert.deepEqual(r, { column: 'BTC-15m', used: 1 });
  const eta = 0.05 * (1 - p.govDelta * G);
  for (let i = 0; i < ro.n; i++) assert.ok(Math.abs(ro.wf[i] - before[i] - eta * (1 - tag.p) * tag.phi[i]) < 1e-9, `dw[${i}]`);
  assert.equal(net.settle('C1', 'yes', T0 + 41e3).used, 0, 'a contract is credited once');
  // Online logistic regression on a learnable signal: repeated labels move p toward the truth.
  const p0 = net.score([query('Z0', 60000, { tag: false })], T0 + 50e3)[0].p;
  for (let k = 1; k <= 60; k++) { net.score([query(`Z${k}`, 60000)], T0 + (50 + k * 61) * 1000); net.settle(`Z${k}`, 'yes', T0 + (50 + k * 61) * 1000 + 1); }
  const p1 = net.score([query('Zend', 60000, { tag: false })], T0 + 9000e3)[0].p;
  assert.ok(p1 > p0 + 0.05, `learned toward YES: ${p0} -> ${p1}`);
});

test('exceedance labels per contract kind; ambiguous between-NO is not used', () => {
  assert.equal(exceedLabel('greater', 'strike', 'yes'), 1);
  assert.equal(exceedLabel('updown', 'strike', 'no'), 0);
  assert.equal(exceedLabel('less', 'cap', 'yes'), 0);
  assert.equal(exceedLabel('between', 'strike', 'yes'), 1);
  assert.equal(exceedLabel('between', 'cap', 'yes'), 0);
  assert.equal(exceedLabel('between', 'strike', 'no'), undefined);
});

test('S0 decaying-trace credit smears the update across contracts; tags do not', () => {
  const mk = (useTags: boolean) => new Readout(3, { eta: 0.1, cap: 1, tauC: 1e9, eps: 0, tagsPerContract: 8, maxTagged: 10, traceTauSec: 1800, useTags });
  for (const useTags of [true, false]) {
    const r = mk(useTags);
    r.tag('A', 'greater', 'strike', [1, 0, 0], 0.5, 0);
    r.tag('B', 'greater', 'strike', [0, 1, 0], 0.5, 1000);
    r.settle('A', 'yes', 2000);
    if (useTags) assert.equal(r.wf[1], 0, 'tags: B features untouched by A label');
    else assert.ok(r.wf[1] > 0, 'trace: A label leaks into B features');
  }
});

test('two-speed readout: fast weights relax to slow; divergence metric', () => {
  const r = new Readout(2, { eta: 1, cap: 10, tauC: 3600, eps: 1e-6, tagsPerContract: 8, maxTagged: 10, traceTauSec: 1800, useTags: true }, [0.5, 0.5]);
  r.wf[0] = 1.5;
  assert.ok(r.divergence() > 0.1);
  r.relax(4 * 3600);
  assert.ok(r.divergence() < 0.05, `relaxed: ${r.divergence()}`);
  assert.ok(r.ws[0] > 0.5 && r.ws[0] < 0.51, 'slow weights move only slightly');
});

test('governor rises with drive, only reduces learning and gain, and is non-oscillatory', () => {
  const net = new SnnNetwork(small());
  const tp = tape(30);
  for (let s = 0; s < 30; s++) net.step(T0 + s * 1000, tp[s]);
  const c = net.columns.get('BTC-15m')!;
  c.fSat = 0.5; // pretend half the weights saturated
  const gs: number[] = [];
  for (let s = 30; s < 30 + 2 * 3600; s += 1) { c.fSat = 0.5; net.step(T0 + s * 1000, tp[s % 30]); if (s % 600 === 0) gs.push(c.G); }
  for (let i = 1; i < gs.length; i++) assert.ok(gs[i] >= gs[i - 1] - 1e-9, `monotone rise ${gs}`);
  assert.ok(c.G > 0.5 && c.G <= 1);
});

test('health: freezes learning and drops to shadow on a sustained firing-rate breach; recovers in band', () => {
  const h = new SnnHealth({ calibSec: 10, sustainSec: 300, recoverSec: 600, thetaDriftPerHour: 0.5 });
  const base = { rateL0: 0.1, rateL1: 0.1, rateE: 0.02, rateI: 0.1, ei: 1.5, theta: 0.05, fSat: 0, divergence: 0, G: [0.1], surprise: 1, calN: 0 };
  h.observe(T0, base);
  assert.equal(h.shadow, true, 'no vote before the reference exists');
  h.observe(T0 + 11_000, base);
  assert.ok(h.ref);
  h.observe(T0 + 12_000, base);
  assert.equal(h.freezeLearning, false); assert.equal(h.shadow, false);
  for (let t = 13; t <= 13 + 301; t++) h.observe(T0 + t * 1000, { ...base, rateE: 0.2 }); // 10x reference
  assert.equal(h.freezeLearning, true); assert.equal(h.shadow, true);
  assert.ok(h.breaches.some((b) => b.metric === 'firing_rateE'));
  for (let t = 320; t <= 320 + 601; t++) h.observe(T0 + t * 1000, base);
  assert.equal(h.freezeLearning, false, 'recovered after recoverSec in band');
  // Calibration slope out of band => shadow only (learning continues).
  h.observe(T0 + 2000e3, { ...base, calSlope: 0.5, calN: 200 });
  assert.equal(h.shadow, true); assert.equal(h.freezeLearning, false);
  // Saturated weights => freeze.
  h.observe(T0 + 2001e3, { ...base, fSat: 0.2 });
  assert.equal(h.freezeLearning, true);
});

test('PC error clipping: z > 10 for 3 consecutive steps freezes PC weight updates', () => {
  // Online U learning is part of S6 (S4/S5 use offline-pretrained, frozen U); enable it here.
  const net = new SnnNetwork(small({ pcLearn: true }));
  const tp = tape(600);
  for (let s = 0; s < 600; s++) net.step(T0 + s * 1000, tp[s]);
  const c = net.columns.get('BTC-15m')!;
  const U = Float32Array.from(c.U1);
  // Regime break: every L0 channel suddenly saturated.
  c.errVar = 1e-8;
  for (let s = 600; s < 606; s++) { c.rate0.fill(1); c.rate1.fill(1); net.step(T0 + s * 1000, tp[s % 600]); }
  assert.equal(c.pcFrozen, true, `z ${c.errZ}`);
  const U2 = Float32Array.from(c.U1);
  net.step(T0 + 607_000, tp[0]);
  assert.deepEqual(Array.from(c.U1), Array.from(U2), 'U frozen');
  assert.notDeepEqual(Array.from(U2), Array.from(U), 'U had been learning before');
});

test('NaN anywhere restores the last good checkpoint', () => {
  const net = new SnnNetwork(small());
  const tp = tape(30);
  for (let s = 0; s < 20; s++) net.step(T0 + s * 1000, tp[s]);
  net.columns.get('BTC-15m')!.v1[0] = NaN;
  for (let s = 20; s < 30; s++) net.step(T0 + s * 1000, tp[s]);
  assert.equal(net.nanRestores, 1);
  assert.ok(!net.columns.get('BTC-15m')!.hasNaN());
});

test('stages: each adds exactly one mechanism; online plasticity changes weights only in S6', () => {
  assert.deepEqual(Object.entries(stageFlags('S0')).filter(([, v]) => v).map(([k]) => k), []);
  assert.equal(stageFlags('S1').tags, true); assert.equal(stageFlags('S1').dendrites, false);
  assert.equal(stageFlags('S2').dendrites, true); assert.equal(stageFlags('S2').synClasses, false);
  assert.equal(stageFlags('S3').alif, true); assert.equal(stageFlags('S4').pc, true); assert.equal(stageFlags('S5').lateral, true);
  assert.equal(stageFlags('S5').plasticity, false); assert.equal(stageFlags('S6').plasticity, true);
  const tp = tape(300);
  for (const stage of ['S5', 'S6'] as const) {
    const net = new SnnNetwork(small(stageFlags(stage)));
    net.step(T0, tp[0]);
    const w0 = Float32Array.from(net.columns.get('BTC-15m')!.w1);
    for (let s = 1; s < 300; s++) net.step(T0 + s * 1000, tp[s]);
    const changed = !Array.from(net.columns.get('BTC-15m')!.w1).every((v, i) => v === w0[i]);
    assert.equal(changed, stage === 'S6', stage);
  }
  // Deferred mechanisms run when enabled (and stay finite).
  const def = new SnnNetwork(small({ wilsonCowan: true, gapJunctions: true, izhikevichCH: true, dcaap: true }));
  for (let s = 0; s < 120; s++) def.step(T0 + s * 1000, tp[s]);
  assert.ok(def.wc.get('BTC') && Number.isFinite(def.wc.get('BTC')!.E));
  assert.ok(!def.columns.get('BTC-15m')!.hasNaN());
  assert.notEqual(versionHash(small()), versionHash(small({ dcaap: true })));
});

test('clock: catch-up with piecewise-constant inputs; long gaps reset transient state, keep weights', () => {
  const net = new SnnNetwork(small());
  const tp = tape(10);
  net.step(T0, tp[0]);
  assert.equal(net.step(T0 + 5_000, tp[1]).steps, 5);
  assert.equal(net.step(T0 + 5_400, tp[2]).steps, 0, 'sub-second: no step');
  const w = Float32Array.from(net.columns.get('BTC-15m')!.w1);
  assert.equal(net.step(T0 + 3_600_000, tp[3]).steps, 1, 'gap > maxCatchUp: reset + one step');
  assert.deepEqual(Array.from(net.columns.get('BTC-15m')!.w1), Array.from(w));
});

test('blender: alpha starts at 0, is earned only with a significant out-of-sample Brier gain, capped at 0.25', () => {
  const b = new SnnBlender({ ...DEFAULT_BLENDER, minEvents: 50, bootstrapIters: 400, recordEverySec: 0 });
  assert.equal(b.alpha().alpha, 0);
  assert.equal(b.pFinal(0.6, 0.9, 1, false), 0.6, 'alpha 0 => p_model');
  const r = new Xoshiro128(9);
  let n = 0;
  for (let day = 0; day < 10; day++) for (let e = 0; e < 40; e++) {
    const truth = r.next();
    const y = r.next() < truth ? 1 : 0;
    const pModel = Math.min(0.99, Math.max(0.01, 0.5 + 0.3 * (truth - 0.5) + 0.25 * (r.next() - 0.5)));
    const pSnn = Math.min(0.99, Math.max(0.01, truth + 0.05 * (r.next() - 0.5)));
    const t = `T${n++}`;
    b.record({ ticker: t, eventKey: `ev${day}-${e}`, ts: T0 + day * 86_400_000 + e * 60_000, pModel, pSnn, c: 1 });
    b.settle(t, y as 0 | 1);
  }
  const e = b.alpha();
  assert.ok(e.alpha > 0 && e.alpha <= 0.25, JSON.stringify(e));
  assert.ok(e.ciHi! < 0);
  const pf = b.pFinal(0.5, 1, 1, false);
  assert.ok(pf <= 0.5 + 0.25 * 0.5 + 1e-12, 'never more than alpha_max of p_snn');
  assert.equal(b.pFinal(0.5, 1, 1, true), 0.5, 'shadow / timeout / health => alpha 0');
  // A useless SNN never earns alpha.
  const u = new SnnBlender({ ...DEFAULT_BLENDER, minEvents: 50, bootstrapIters: 400, recordEverySec: 0 });
  for (let i = 0; i < 400; i++) { const y = r.next() < 0.5 ? 1 : 0; u.record({ ticker: `U${i}`, eventKey: `u${i}`, ts: T0 + Math.floor(i / 40) * 86_400_000, pModel: 0.5, pSnn: r.next(), c: 1 }); u.settle(`U${i}`, y as 0 | 1); }
  assert.equal(u.alpha().alpha, 0);
});

test('confidence: surprise and governor can only reduce c', () => {
  const b = new SnnBlender({ ...DEFAULT_BLENDER, minEvents: 20, recordEverySec: 0 });
  const r = new Xoshiro128(4);
  for (let i = 0; i < 400; i++) { const p = 0.05 + 0.9 * r.next(); b.record({ ticker: `c${i}`, eventKey: `e${i}`, ts: T0, pModel: p, pSnn: p, c: 1 }); b.settle(`c${i}`, (r.next() < p ? 1 : 0) as 0 | 1); }
  const cCal = b.calibrationConfidence();
  assert.ok(cCal > 0.6, `calibrated SNN gets confidence ${cCal}`);
  assert.ok(Math.abs(b.confidence(0.5, 1, 0) - cCal) < 1e-12, 'low surprise does not raise c');
  assert.ok(Math.abs(b.confidence(2, 1, 0) - cCal / 2) < 1e-12, 'S0/S_t');
  assert.ok(b.confidence(1, 1, 1) < cCal, 'governor reduces');
});

test('event-clustered day-block bootstrap', () => {
  const ci = dayBlockBootstrap(Array.from({ length: 200 }, (_, i) => ({ day: `d${i % 10}`, x: -0.01 + 0.001 * Math.sin(i) })), 500);
  assert.ok(ci.hi < 0 && ci.lo < ci.hi && ci.days === 10);
  assert.ok(Number.isNaN(dayBlockBootstrap([{ day: 'a', x: 1 }]).hi), 'one day: no CI');
});

test('target scaler: conservative only (<= 1, >= 0.85), at most one step per 15 minutes', () => {
  const s = new TargetScaler();
  assert.equal(s.update(T0, 5, 1, 1), 0.95);
  assert.equal(s.update(T0 + 60_000, 5, 1, 1), 0.95, 'no second step within 15 min');
  assert.ok(Math.abs(s.update(T0 + 900_000, 5, 1, 1) - 0.9) < 1e-12);
  for (let k = 2; k < 10; k++) s.update(T0 + k * 900_000, 50, 1, 1);
  assert.ok(Math.abs(s.scale - 0.85) < 1e-12, 'clamped at -15%');
  for (let k = 10; k < 20; k++) s.update(T0 + k * 900_000, 0.1, 1, 0);
  assert.equal(s.scale, 1, 'calm => back to 1, never above');
  assert.ok(Math.abs(blendedTarget(100, 200, 0.25) - 115) < 1e-9, 'blended target clamped +15%');
  assert.equal(impliedQuantile([{ K: 100, pExceed: 0.8 }, { K: 110, pExceed: 0.2 }], 0.5), 105);
});

test('host: in-process and worker-thread runtimes agree; checkpoints are versioned with rollback', async () => {
  const dir = tmpDir();
  const params = small();
  const tp = tape(20);
  const local = new SnnHost({ params, timeoutMs: 200, latencySkipP99Ms: 150, checkpointDir: dir, checkpointEveryMin: 1e9, keepCheckpoints: 2 });
  const worker = new SnnHost({ params, worker: { path: path.resolve('bot/snn/worker.dev.mjs') }, timeoutMs: 200, latencySkipP99Ms: 150, checkpointEveryMin: 1e9, keepCheckpoints: 2 });
  await local.start(T0); await worker.start(T0);
  assert.equal(worker.mode, 'worker');
  let a, b;
  for (let s = 0; s < 20; s++) {
    a = await local.stepAndScore(T0 + s * 1000, tp[s], [query('Q', 60050)]);
    b = await new Promise<Awaited<ReturnType<SnnHost['stepAndScore']>>>((res) => { const go = async () => { const r = await worker.stepAndScore(T0 + s * 1000, tp[s], [query('Q', 60050)]); res(r ?? (await worker.stepAndScore(T0 + s * 1000 + 999, tp[s], [query('Q', 60050)]))); }; void go(); });
  }
  assert.ok(a && b);
  assert.equal(a!.scores[0].p, b!.scores[0].p, 'worker == in-process (deterministic)');
  for (let k = 0; k < 3; k++) await local.checkpoint(T0 + k);
  const files = (await import('node:fs')).readdirSync(dir);
  assert.equal(files.length, 2, 'keeps the newest N');
  (await import('node:fs')).writeFileSync(path.join(dir, files.sort().at(-1)!), '{corrupt');
  assert.ok(local.loadCheckpoint(), 'corrupt newest -> rolls back to the previous file');
  const restarted = new SnnHost({ params, timeoutMs: 200, latencySkipP99Ms: 150, checkpointDir: dir, checkpointEveryMin: 1e9, keepCheckpoints: 2 });
  await restarted.start(T0 + 100);
  assert.match(String(restarted.restoredFrom), /checkpoint @/);
  await worker.stop(); await local.stop(T0 + 10);
});

test('host: a slow readout times out at the deadline (alpha = 0) and feeds latency p99', async () => {
  const host = new SnnHost({ params: small(), timeoutMs: 20, latencySkipP99Ms: 15, checkpointEveryMin: 1e9, keepCheckpoints: 1 });
  await host.start(T0);
  // Simulate a worker that never answers.
  (host as any).worker = { postMessage: () => undefined, terminate: async () => 0 };
  const r = await host.stepAndScore(T0, [], []);
  assert.equal(r, undefined);
  assert.equal(host.timeouts, 1);
  assert.equal(host.latencyOk(), false, 'p99 above band -> skip the vote');
});

test('config: SNN defaults to shadow, alpha capped at 0.25, 200 ms deadline', () => {
  const c = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) });
  assert.equal(c.snn.mode, 'shadow');
  assert.equal(c.snn.alphaMax, 0.25);
  assert.equal(c.snn.timeoutMs, 200);
  assert.throws(() => loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), SNN_ALPHA_MAX: '0.5' }));
  assert.throws(() => loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), SNN_TIMEOUT_MS: '500' }));
  assert.equal(snnParams(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), SNN_STAGE: 'S6' }).snn).flags.plasticity, true);
  assert.equal(createSnnFleet(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), SNN_MODE: 'off' }).snn), undefined);
});

async function engineSetup(mode: 'shadow' | 'blend') {
  const dir = tmpDir();
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), DATA_DIR: dir, DOMINANCE_FEED: 'false', SPOT_FEED: 'false', STRATEGY_SERIES: 'KXBTC15M', TENNIS_ENABLED: 'false', SNN_MODE: mode, SNN_WORKER: 'false', EVAL_IDLE_SEC: '0' });
  const now = Date.now();
  const market: MarketInfo = { ticker: 'KXBTC15M-SNN', seriesTicker: 'KXBTC15M', status: 'open', openTime: now - 300_000, closeTime: now + 600_000, floorStrike: 60000, tickSize: 0.01 };
  const rest = { getSeriesFees: async () => ({ takerMultiplier: 1, makerMultiplier: 0 }), getOpenMarkets: async () => [market], getMarket: async () => market } as unknown as KalshiRest;
  const audit = tmpAudit();
  const md = new MarketData(cfg, rest, undefined, new Recorder(path.join(dir, 'rec')));
  await md.refreshCatalog(now);
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.45, size: 50 }], asks: [{ price: 0.6, size: 50 }] }, now);
  const idx = md.index.get('BTC')!;
  let x = Math.log(60010);
  const r = new Xoshiro128(2);
  for (let s = 600; s >= 0; s--) { x += 0.0002 * (r.next() - 0.5); idx.add(Math.exp(x), now - s * 1000); }
  const paper = new PaperExchange(undefined, 200, (t) => md.books.get(t), () => ({ takerMultiplier: 1, makerMultiplier: 0 }));
  const kill = new KillSwitch(path.join(dir, 'kill.json'), audit);
  const oms = new Oms({ gateway: paper, audit, statePath: path.join(dir, 'oms.json'), feesFor: (t) => md.feesFor(t), sleep: async () => undefined });
  const recon = new Reconciler({ gateway: paper, oms, audit, getMarket: rest.getMarket, onPersistentBreak: (why) => void kill.engage(why, 'recon') });
  const snn = createSnnFleet({ ...cfg.snn, checkpointDir: path.join(dir, 'snn') }, {}, { worker: false })!;
  for (const u of Object.values(snn.units)) await u!.host.start();
  const engine = new Engine({ cfg, audit, alerter: new Alerter([], audit), md, gateway: paper, oms, risk: new RiskGateway(cfg.risk), kill, recon, model: MetaModel.identity(), snn });
  const rr = await recon.run('startup');
  engine.balance = rr!.balance;
  return { engine, market, snn, md };
}

test('engine shadow mode: SNN scores every contract and is logged, but p_model is traded unchanged', async () => {
  const { engine, market, md } = await engineSetup('shadow');
  await engine.tick(); // observe L0 inputs
  await engine.tick(); // step + score with them
  const st = engine.status.get(market.ticker)!;
  assert.equal(snnColumn(md.markets.get(market.ticker)!), 'BTC-15m');
  assert.ok(st.pSnn !== undefined && st.pSnn > 0 && st.pSnn < 1, JSON.stringify(st));
  assert.equal(st.pYes, st.pModel, 'shadow never changes the traded probability');
  assert.equal(st.snnShadow, 'shadow mode');
  // Two isolated networks fed every second (not only while trading): crypto 15m/1h, perps 1h/4h.
  for (const k of ['crypto:BTC-15m', 'crypto:BTC-60m', 'perps:BTC-60m', 'perps:BTC-240m']) assert.ok(engine.snnDirs.has(k), `${k} direction call: ${[...engine.snnDirs.keys()]}`);
  assert.ok(!engine.snnDirs.has('crypto:BTC-240m') && !engine.snnDirs.has('perps:BTC-15m'));
  // Each decision model reads only its own network (SNN_CROSS_FEED off), with the confidence of each call.
  const ctx = engine.snnContext('BTC', market.ticker)!;
  assert.ok(ctx.up?.[15] !== undefined && ctx.up?.[60] !== undefined && ctx.pContract !== undefined);
  assert.equal(ctx.up?.[240], undefined, 'the MLP never reads the perps network');
  assert.ok(ctx.conf?.[15] && 'skill' in ctx.conf[15]!);
  const pctx = engine.snnContext('BTC', market.ticker, 'perps')!;
  assert.ok(pctx.up?.[60] !== undefined && pctx.up?.[240] !== undefined);
  assert.equal(pctx.up?.[15], undefined, 'the perps model never reads the crypto network');
  assert.equal(pctx.pContract, undefined, 'contract scores come from the crypto network only');
  const brief = engine.snnBrief() as { mode: string; alpha: number };
  assert.equal(brief.mode, 'shadow'); assert.equal(brief.alpha, 0);
});

test('engine blend mode: alpha = 0 until earned, then p_final = (1 - alpha c) p_model + alpha c p_snn', async () => {
  const { engine, market, snn } = await engineSetup('blend');
  await engine.tick(); await engine.tick();
  let st = engine.status.get(market.ticker)!;
  assert.equal(st.pYes, st.pModel, 'not earned yet');
  // Force an earned alpha and a voting (non-shadow) health state.
  (snn.blender as any).earned = { alpha: 0.2, alphaStar: 0.2, ciHi: -0.01, meanDiff: -0.01, events: 999, reason: 'test' };
  (snn.blender as any).dirty = false;
  (snn.blender as any).calibrationConfidence = () => 1;
  const net = (snn.units.crypto!.host as any).local.net as SnnNetwork;
  net.health.ref = { rateL0: 1, rateL1: 1, rateE: 1, rateI: 1, ei: 1, theta: 1, surprise: 1, ts: 0 };
  (net.health as any).observe = function () { this.shadow = false; this.freezeLearning = false; };
  net.health.shadow = false;
  await engine.tick();
  st = engine.status.get(market.ticker)!;
  assert.equal(st.snnShadow, undefined, `voting: ${st.snnShadow}`);
  const want = (1 - 0.2 * st.snnC!) * st.pModel! + 0.2 * st.snnC! * st.pSnn!;
  assert.ok(Math.abs(st.pYes! - want) < 1e-12, `${st.pYes} vs ${want}`);
});

test('direction heads: learn continuously from realised moves (no trading, no settlement) and predict the drift', () => {
  const net = new SnnNetwork({ ...small(), dirEta: 0.05, dirCap: 1, dirEverySec: 60 });
  // A steadily rising index with TA readings that say "trend up": the 15m head must learn P(up) > 0.5.
  let px = 60000;
  for (let s = 0; s < 6 * 3600; s++) {
    px *= Math.exp(0.00004 + 0.0001 * Math.sin(s / 13));
    net.step(T0 + s * 1000, [{ key: 'BTC-15m', asset: 'BTC', price: px, values: { ta_rsi_a: 0.4, ta_di_a: 0.5, ret_h_z: 1.5, taconf_net: 4 } }]);
  }
  const d = net.directions().find((x) => x.key === 'BTC-15m')!;
  assert.ok(d.labelled > 200, `labelled ${d.labelled}`);
  assert.ok(d.pUp > 0.6, `P(up) ${d.pUp}`);
  assert.ok(d.expMove > 0 && d.expSignedMove > 0);
  assert.equal(d.horizonSec, 900);
  // Direction heads and their pending tags survive a checkpoint.
  const cp = JSON.parse(JSON.stringify(net.serialize()));
  const r = new SnnNetwork({ ...small(), dirEta: 0.05, dirCap: 1, dirEverySec: 60 });
  r.restore(cp);
  assert.equal(r.directions()[0].pUp, d.pUp);
  assert.equal(r.dirTags.get('BTC-15m')!.length, net.dirTags.get('BTC-15m')!.length);
});

test('inputs: crypto columns read the TA library, perp and book; tennis columns read the 4 signals and the score', () => {
  const f = { ret_15m_z: 1, ret_1h_z: 2, ret_5m_z: 0.5, ta_rsi_15m: 0.2, ta_rsi_1h: 0.3, ta_macd_hist_1h: 0.1, ta_di_diff_4h: -0.2, taconf_net: 3, perp_premium_bps: 4, funding_rate_bps: 1, usdtd_ret_15m_z: -1 } as Record<string, number>;
  const v15 = cryptoValues(15, f, { mid: 0.4, spread: 0.02, imbalance: 0.3, dAtm: 0.5, tauFrac: 0.6 });
  assert.equal(v15.ret_h_z, 1); assert.equal(v15.ta_rsi_a, 0.2); assert.equal(v15.ta_rsi_b, 0.3); assert.equal(v15.perp_premium_bps, 4); assert.equal(v15.mid, 0.4);
  const v240 = cryptoValues(240, f);
  assert.equal(v240.ret_h_z, undefined); assert.equal(v240.ta_di_b, -0.2); assert.equal(v240.mid, undefined, 'perp column: no Kalshi contract');
  const tv = tennisValues({ pA: 0.35, spread: 0.02, momentum: 0.02, opponentMove: -0.015, flow: 0.4, depth: 0.25, confluence: 3, score: { setsA: 1, setsB: 0, gamesA: 3, gamesB: 5, pointsA: 2, pointsB: 3, serverA: true }, tiebreak: false, breaksTotal: [2, 1], progress: 0.55, pStart: 0.4, format: { bestOf: 3, finalSetTiebreak: 7 } as never });
  assert.equal(tv.momentum, 0.02); assert.equal(tv.crossMarket, 0.015); assert.equal(tv.flow, 0.4); assert.equal(tv.depth, 0.25); assert.equal(tv.confluence, 3);
  assert.equal(tv.setDiff, 1); assert.equal(tv.gameDiff, -2); assert.equal(tv.pointDiff, -1); assert.equal(tv.serverA, 1); assert.equal(tv.breakDiff, 1);
  assert.ok(tv.modelPA! > 0 && tv.modelPA! < 1);
});

test('tennis column: P(A wins) readout trained by the match result; removed when the match ends', () => {
  const net = new SnnNetwork(small());
  for (let s = 0; s < 120; s++) net.step(T0 + s * 1000, [{ key: 'TEN:EV1', asset: 'TENNIS', price: 0.4 + 0.001 * s, values: { momentum: 0.01, modelPA: 0.45 } }]);
  const sc = net.score([{ ticker: 'EV1-A', column: 'TEN:EV1', kind: 'match', d: Math.log(0.45 / 0.55), lifeFrac: 0.5, spot: 0, sigma: 0, tauSec: 0, lifeSec: 0, eventKey: 'EV1-A', tag: true }], T0 + 120e3);
  assert.equal(sc.length, 1); assert.ok(sc[0].p > 0 && sc[0].p < 1);
  assert.deepEqual(net.settle('EV1-A', 'yes', T0 + 200e3), { column: 'TEN:EV1', used: 1 });
  net.removeColumn('TEN:EV1');
  assert.equal(net.columns.has('TEN:EV1'), false);
});

test('health: the E/I reference follows a session-scale shift (no all-night freeze), firing-rate collapse still freezes', () => {
  const h = new SnnHealth({ calibSec: 10, sustainSec: 300, recoverSec: 600, thetaDriftPerHour: 0.5, eiAdaptHours: 2, eiBand: 2 });
  const base = { rateL0: 0.1, rateL1: 0.1, rateE: 0.02, rateI: 0.1, ei: 8, theta: 0.05, fSat: 0, divergence: 0, G: [0.1], surprise: 1, calN: 0 };
  h.observe(T0, base); h.observe(T0 + 11_000, base);
  // Night: E/I drifts gradually from 8 to 2.6 over 10 hours, as the live crypto network did.
  let t = 12;
  for (; t <= 12 + 10 * 3600; t += 60) h.observe(T0 + t * 1000, { ...base, ei: 8 * Math.pow(2.6 / 8, (t - 12) / (10 * 3600)) });
  // An abrupt halving within minutes is still a breach.
  const hb = new SnnHealth({ calibSec: 10, sustainSec: 300, recoverSec: 600, thetaDriftPerHour: 0.5, eiAdaptHours: 2, eiBand: 2 });
  hb.observe(T0, base); hb.observe(T0 + 11_000, base);
  for (let k = 12; k <= 12 + 400; k++) hb.observe(T0 + k * 1000, { ...base, ei: 3 });
  assert.equal(hb.freezeLearning, true, 'sudden E/I shift freezes');
  assert.equal(h.freezeLearning, false, `no freeze on a session drift: ${JSON.stringify(h.breaches)}`);
  assert.ok(h.ref!.ei < 8, 'the reference followed');
  // A dead layer is still caught.
  for (let k = 0; k <= 400; k++, t++) h.observe(T0 + t * 1000, { ...base, ei: 2.6, rateE: 0.001 });
  assert.equal(h.freezeLearning, true);
});

test('threshold homeostasis: a silent perps column lowers its E thresholds; crypto keeps its params and checkpoint hash', () => {
  const p = { ...domainParams('perps', small()), ipStep: 0.05 };
  assert.ok(p.ipLow! > 0);
  assert.ok(!('ipLow' in DEFAULT_SNN) && !('ipLow' in domainParams('crypto')), 'crypto params (and so its version hash) unchanged');
  const net = new SnnNetwork(p);
  // A flat tape: almost no input change, so layer 2 stays silent.
  const flat = KEYS.map((key) => ({ key, asset: key.split('-')[0], spot: 60000, mid: 0.5, spread: 0.02, imbalance: 0, dAtm: 0, tauFrac: 0.5, rsi: 50, retZ: 0 }));
  for (let s = 0; s < 1800; s++) net.step(T0 + s * 1000, flat);
  const c = net.columns.get('BTC-15m')!;
  assert.ok(c.theta0E.every((x) => x < p.thetaE * 0.9), `thresholds lowered: ${c.theta0E[0]}`);
  assert.ok(c.theta0E.every((x) => x >= p.thetaE * p.ipMin! - 1e-12), 'never below the floor');
  // Thresholds survive a checkpoint.
  const r = new SnnNetwork(p);
  r.restore(JSON.parse(JSON.stringify(net.serialize())));
  assert.equal(r.columns.get('BTC-15m')!.theta0E[0], c.theta0E[0]);
});

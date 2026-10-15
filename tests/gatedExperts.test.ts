import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { fitGatedExperts, gatedLoss, gatedPredict } from '../bot/model/gatedExperts';
import { applyTakeGate, TAKE_GATED_FEATURES, TAKE_GATED_LAYOUT, takeGatedInputs, takeInputs, takeProbability, type TakeModelParams } from '../bot/model/takeModel';
import { PERP_FEATURES, perpGatedLayout, PerpModel, type PerpModelParams } from '../bot/perps/perpSignal';
import { fitTakeModel } from '../research/trainMetaModel';
import { trainPerp, type PerpRow } from '../research/trainPerpModel';
import { rng } from '../research/stats';
import { tmpDir } from './helpers';

const T0 = 1_800_000_000_000;
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());

/** Rows [t1, t2, m1, m2, d]: the target follows t1 when the driver d is low and m1 when it is high. */
function regimeRows(n: number, seed: number, logistic: boolean): { X: number[][]; y: number[]; base: number[] } {
  const r = rng(seed);
  const X: number[][] = [], y: number[] = [], base: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = [gauss(r), gauss(r), gauss(r), gauss(r), gauss(r)];
    const signal = 1.5 * (x[4] > 0 ? x[2] : x[0]);
    const b = logistic ? 0.3 * gauss(r) : 0;
    X.push(x); base.push(b);
    y.push(logistic ? (r() < 1 / (1 + Math.exp(-(b + signal))) ? 1 : 0) : signal + 0.3 * gauss(r));
  }
  return { X, y, base };
}
const layout = { trend: [0, 1], micro: [2, 3], drivers: [4] };

test('gated experts: the gate learns which expert carries the target as the driver moves (squared loss)', () => {
  const tr = regimeRows(1200, 1, false), va = regimeRows(400, 2, false), te = regimeRows(600, 3, false);
  const m = fitGatedExperts(tr.X, tr.y, { loss: 'squared', ...layout, val: { X: va.X, y: va.y } })!;
  assert.ok(m, 'fitted');
  assert.ok(m.g[0] > 0.5, `gamma rises with the driver: g=${m.g[0]}`);
  assert.ok(m.wT[0] > Math.abs(m.wT[1]) + 0.5 && m.wM[0] > Math.abs(m.wM[1]) + 0.5, JSON.stringify({ wT: m.wT, wM: m.wM }));
  const lo = gatedPredict(m, [0, 0, 0, 0, -2]), hi = gatedPredict(m, [0, 0, 0, 0, 2]);
  assert.ok(lo.gamma < 0.3 && hi.gamma > 0.7, `${lo.gamma} / ${hi.gamma}`);
  const varY = te.y.reduce((s, v) => s + v * v, 0) / te.y.length;
  assert.ok(gatedLoss(m, te.X, te.y) < 0.4 * varY, `held-out MSE ${gatedLoss(m, te.X, te.y)} vs variance ${varY}`);
  assert.ok(m.meanGamma! > 0.3 && m.meanGamma! < 0.7);
});

test('gated experts: logistic loss around a base logit beats the base alone on held-out rows', () => {
  const tr = regimeRows(2000, 4, true), va = regimeRows(600, 5, true), te = regimeRows(1000, 6, true);
  const m = fitGatedExperts(tr.X, tr.y, { loss: 'logistic', ...layout, base: tr.base, val: { X: va.X, y: va.y, base: va.base } })!;
  assert.ok(m.g[0] > 0.3, `g=${m.g[0]}`);
  const ll = (q: number[]) => q.reduce((s, p, i) => s - (te.y[i] ? Math.log(p) : Math.log(1 - p)), 0) / q.length;
  const baseLl = ll(te.base.map((b) => 1 / (1 + Math.exp(-b))));
  assert.ok(gatedLoss(m, te.X, te.y, te.base) < baseLl - 0.05, `${gatedLoss(m, te.X, te.y, te.base)} vs ${baseLl}`);
});

test('gated experts: missing inputs read as the training mean; too few rows fit nothing', () => {
  const tr = regimeRows(300, 7, false);
  const m = fitGatedExperts(tr.X, tr.y, { loss: 'squared', ...layout })!;
  const o = gatedPredict(m, [NaN, NaN, NaN, NaN, NaN], 0.25);
  assert.ok(Number.isFinite(o.y));
  assert.ok(Math.abs(o.gamma - 1 / (1 + Math.exp(-m.g0))) < 1e-12);
  assert.ok(Math.abs(o.y - (0.25 + (1 - o.gamma) * m.bT + o.gamma * m.bM)) < 1e-12);
  assert.equal(fitGatedExperts(tr.X.slice(0, 40), tr.y.slice(0, 40), { loss: 'squared', ...layout }), undefined);
});

/** A hand-built gated take head: the trend expert reads the side-oriented 60 s return, the gate is shut (gamma ~ 0). */
function handTake(): TakeModelParams {
  const d = TAKE_GATED_FEATURES.length;
  const wT = TAKE_GATED_LAYOUT.trend.map((_, k) => (k === 0 ? 2 : 0));
  return {
    features: ['edge', 'logit_p_side', 'price_side', 'spread', 'tau_min', 'snn_up_side', 'snn_bias_side', 'snn_agree_side', 'p_std', 'snn_skill_h', 'snn_cal_h'],
    kind: 'gated',
    gated: {
      loss: 'logistic', ...TAKE_GATED_LAYOUT, mean: new Array(d).fill(0), std: new Array(d).fill(1), features: TAKE_GATED_FEATURES,
      wT, bT: 0, wM: TAKE_GATED_LAYOUT.micro.map(() => 0), bM: 0, g: TAKE_GATED_LAYOUT.drivers.map(() => 0), g0: -30,
    },
    validation: { trades: 1000, windows: 100, logLossBase: 0.69, logLossTake: 0.6, validated: true },
  };
}

test('take model, gated kind: inputs oriented to the side; the gate skips trades against the trend; no gated inputs = fair value', () => {
  const take = handTake();
  assert.equal(takeGatedInputs('yes', { ret_60s_z: 1.2 })[0], 1.2);
  assert.equal(takeGatedInputs('no', { ret_60s_z: 1.2 })[0], -1.2);
  assert.equal(takeGatedInputs('no', { rsi_60: 70 })[3], -20, 'centred at 50, then oriented');
  assert.equal(takeGatedInputs('no', { vpin_300s: 0.4 })[TAKE_GATED_LAYOUT.micro[4]], 0.4, 'toxicity is not oriented');
  assert.ok(Number.isNaN(takeGatedInputs('yes', {})[0]));
  const x = takeInputs('yes', 0.6, 0.42, 0.02, 500, {});
  const pBase = takeProbability(take, x);
  assert.ok(Math.abs(pBase - 0.6) < 1e-9, `without gated inputs: the fair-value probability (${pBase})`);
  const up = takeProbability(take, x, takeGatedInputs('yes', { ret_60s_z: 1 })), dn = takeProbability(take, x, takeGatedInputs('yes', { ret_60s_z: -1 }));
  assert.ok(up > 0.9 && dn < 0.25, `${up} / ${dn}`);
  const plan = { place: [{ side: 'bid', price: 0.42, count: 5, postOnly: false, reduceOnly: false, purpose: 'quote', timeInForce: 'immediate_or_cancel', edge: 0.1, why: '' }] as never[], notes: [] as string[] };
  assert.equal(applyTakeGate(plan, take, { pYes: 0.6, features: { ret_60s_z: -1 }, tauSec: 500, bid: 0.4, ask: 0.42, margin: 0 }), 1);
  const plan2 = { place: [{ side: 'bid', price: 0.42, count: 5, postOnly: false, reduceOnly: false, purpose: 'quote', timeInForce: 'immediate_or_cancel', edge: 0.1, why: '' }] as never[], notes: [] as string[] };
  assert.equal(applyTakeGate(plan2, take, { pYes: 0.6, features: { ret_60s_z: 1 }, tauSec: 500, bid: 0.4, ask: 0.42, margin: 0 }), 0);
  const broken = { ...take, gated: undefined };
  assert.ok(Math.abs(takeProbability(broken, x, takeGatedInputs('yes', { ret_60s_z: 1 })) - 0.6) < 1e-9, 'a gated file without its experts reads the fair value');
});

test('take model trainer: a signal that moves from momentum to order flow as volatility turns is won by the gated candidate', () => {
  const r = rng(9);
  const rows: unknown[] = [], p: number[] = [];
  for (let w = 0; w < 1400; w++) {
    const vol = gauss(r), ret = gauss(r), ofi = gauss(r);
    const s = 1.6 * (vol > 0 ? ofi : ret);
    const y = r() < 1 / (1 + Math.exp(-(0.4 + s))) ? 1 : 0;
    rows.push({ window: T0 + w * 900_000, bid: 0.4, ask: 0.42, tauSec: 500, label: y, fx: { ret_60s_z: ret, ofi_30s: ofi, vol_ratio_15m_4h: 1 + 0.3 * vol } });
    p.push(0.6);
  }
  const take = fitTakeModel(rows as never, p, 0.02, 7)!;
  assert.equal(take.kind, 'gated', JSON.stringify(take.candidates));
  assert.equal(take.validation.validated, true, JSON.stringify(take.validation));
  assert.deepEqual(take.gated!.features, TAKE_GATED_FEATURES);
  assert.ok(take.gated!.g[0] > 0, 'order flow takes over as the volatility ratio rises');
  const x = takeInputs('yes', 0.6, 0.42, 0.02, 500, {});
  const q = (fx: Record<string, number>) => takeProbability(take, x, takeGatedInputs('yes', fx));
  assert.ok(q({ ofi_30s: 1.5, ret_60s_z: 0, vol_ratio_15m_4h: 1.6 }) > q({ ofi_30s: -1.5, ret_60s_z: 0, vol_ratio_15m_4h: 1.6 }) + 0.3);
  assert.ok(q({ ofi_30s: 0, ret_60s_z: 1.5, vol_ratio_15m_4h: 0.4 }) > q({ ofi_30s: 0, ret_60s_z: -1.5, vol_ratio_15m_4h: 0.4 }) + 0.3);
});

/** Perp rows: the label follows the 1h return in calm stretches and the perp premium when volatility turns up. */
function perpRows(n: number, seed: number): PerpRow[] {
  const r = rng(seed);
  const iRet = PERP_FEATURES.indexOf('ret_1h_z'), iPrem = PERP_FEATURES.indexOf('perp_premium_bps'), iVol = PERP_FEATURES.indexOf('vol_ratio_15m_4h');
  const rows: PerpRow[] = [];
  for (let i = 0; i < n; i++) {
    const x = PERP_FEATURES.map(() => NaN);
    x[iRet] = gauss(r); x[iPrem] = 4 * gauss(r); x[iVol] = 1 + 0.3 * gauss(r);
    const y = 25 * (x[iVol] > 1 ? x[iPrem] / 4 : x[iRet]) + 8 * gauss(r);
    rows.push({ ts: T0 + i * 3_600_000, asset: 'BTC', x, y, fundingBps: 0 });
  }
  return rows;
}

test('perps: the gated candidate is walked forward with the others; when it wins it is saved, loaded and predicts within the cap', () => {
  const lay = perpGatedLayout();
  assert.ok(lay.trend.length > 10 && lay.micro.length > 5 && lay.drivers.length === 1, 'every listed input is a perps feature');
  const rows = perpRows(1500, 12);
  const res = trainPerp(rows, { horizonMin: 60, everySec: 3600, minEff: 50, trees: false });
  const gated = res.oos.find((o) => o.lambda === 'gated');
  assert.ok(gated && gated.ic > 0.6, JSON.stringify(res.oos));
  assert.equal(res.params.kind, 'gated', JSON.stringify(res.oos));
  assert.equal(res.params.validation!.trials, 5);
  const file = path.join(tmpDir(), 'perp.json');
  fs.writeFileSync(file, JSON.stringify(res.params));
  const model = PerpModel.load(file)!;
  assert.ok(model, 'loads');
  const f = (ret: number, prem: number, vol: number) => ({ ret_1h_z: ret, perp_premium_bps: prem, vol_ratio_15m_4h: vol });
  assert.ok(model.predict(f(0, 6, 1.6)).muBps > model.predict(f(0, -6, 1.6)).muBps + 15);
  assert.ok(model.predict(f(1.5, 0, 0.4)).muBps > model.predict(f(-1.5, 0, 0.4)).muBps + 15);
  const cap = 3 * res.params.residStdBps;
  assert.ok(Math.abs(model.predict(f(50, 0, 0.4)).muBps) <= cap + 1e-9);
  // A gated file whose experts do not match its feature list is refused.
  const bad: PerpModelParams = { ...res.params, gated: { ...res.params.gated!, mean: [0, 0] } };
  fs.writeFileSync(file, JSON.stringify(bad));
  assert.equal(PerpModel.load(file), undefined);
  const noGated = trainPerp(rows, { horizonMin: 60, everySec: 3600, minEff: 50, trees: false, gated: false });
  assert.ok(!noGated.oos.some((o) => o.lambda === 'gated') && noGated.params.kind === 'linear');
});

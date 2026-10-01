// Round 3: confidence inputs and isolation between the three SNNs in research replay, GBDT squared
// loss, the tree vol forecast, tree candidates (take / perps / tennis) and the self-activating fill
// model.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Alerter } from '../bot/alerts/alerter';
import { AutoTrainer } from '../bot/autotrain';
import { loadConfig } from '../bot/config';
import type { Engine } from '../bot/engine';
import { OrderBook } from '../bot/marketdata/orderBook';
import { MetaModel } from '../bot/model/metaModel';
import { TAKE_FEATURES, takeInputs, takeProbability, type TakeModelParams } from '../bot/model/takeModel';
import { gbdtLogit } from '../bot/model/trees';
import { VolForecaster, VolModel, VOL_MODEL_FEATURES, VOL_MULT_MAX, type VolModelParams } from '../bot/model/volModel';
import { PerpModel } from '../bot/perps/perpSignal';
import type { OrderPlan } from '../bot/strategy/fairValueStrategy';
import { FillLog, readFillLog } from '../bot/tca/fillLog';
import { applyFillModel, FILL_FEATURES, FillModel, fillInputs } from '../bot/tca/fillModel';
import { TennisFairModel } from '../bot/tennis/tennisFair';
import { trainGbdt } from '../research/gbdt';
import { runPipeline } from '../research/pipeline';
import { ReplayState } from '../research/replay';
import { directionRows } from '../research/snnReplay';
import { trainFillModel } from '../research/trainFillModel';
import { trainPerp } from '../research/trainPerpModel';
import { trainVolModel, type VolRow } from '../research/trainVolModel';
import { rng } from '../research/stats';
import { tmpAudit, tmpDir } from './helpers';

const T0 = Date.UTC(2026, 5, 1);

test('replay: each decision model reads only its own network (legacy events split by horizon), with confidence', () => {
  const st = new ReplayState();
  st.apply({ t: T0, k: 'snn', d: 'crypto', dirs: [['BTC-15m', 0.6, 3, 50, 0.1, 0.8, 0.05, 1.2, 0.3], ['BTC-60m', 0.55, 5, 40, null, null, null, null, 0.2]], c: { KXBTC15M: 0.62 } });
  st.apply({ t: T0, k: 'snn', d: 'perps', dirs: [['BTC-60m', 0.4, 8, 30, 0.02, null, null, 0.9, 0.1], ['BTC-240m', 0.35, 20, 10, 0.03, null, null, 0.9, 0.1]], c: {} });
  const c = st.snnContext('BTC', 'KXBTC15M', 'crypto', 180_000, false)!;
  assert.deepEqual(c.up, { 15: 0.6, 60: 0.55 }, 'the MLP never sees the perps network');
  assert.equal(c.pContract, 0.62);
  assert.equal(c.conf?.[15]?.skill, 0.1); assert.equal(c.conf?.[15]?.calConf, 0.8); assert.equal(c.conf?.[60]?.skill, undefined);
  const p = st.snnContext('BTC', undefined, 'perps', 180_000, false)!;
  assert.deepEqual(p.up, { 60: 0.4, 240: 0.35 }, 'the perps model sees only its own 1h/4h calls');
  // SNN_CROSS_FEED: the other network fills only horizons the own one does not have.
  assert.deepEqual(st.snnContext('BTC', undefined, 'perps', 180_000, true)!.up, { 15: 0.6, 60: 0.4, 240: 0.35 });
  // A legacy single-network event (no d): 15m -> crypto, 4h -> perps, 1h -> both.
  const legacy = new ReplayState();
  legacy.apply({ t: T0, k: 'snn', dirs: [['ETH-15m', 0.7, 1, 5], ['ETH-60m', 0.6, 2, 5], ['ETH-240m', 0.3, 4, 5]], c: {} });
  assert.deepEqual(legacy.snnContext('ETH', undefined, 'crypto', 180_000, false)!.up, { 15: 0.7, 60: 0.6 });
  assert.deepEqual(legacy.snnContext('ETH', undefined, 'perps', 180_000, false)!.up, { 60: 0.6, 240: 0.3 });
});

test('perps network is graded on its own direction calls: rows with a prequential no-skill baseline', () => {
  const rows = directionRows([{ key: 'BTC-240m', ts: T0, p: 0.7, y: 1 }, { key: 'BTC-240m', ts: T0 + 300_000, p: 0.6, y: 1 }, { key: 'BTC-240m', ts: T0 + 4 * 3_600_000, p: 0.4, y: 0 }]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].pModel, 0.5, 'prior up-rate before any label');
  assert.ok(rows[1].pModel > 0.5 && rows[2].pModel > rows[1].pModel, 'baseline uses only earlier labels');
  assert.equal(rows[0].eventKey, rows[1].eventKey, 'overlapping calls in the same hour cluster as one event');
  assert.notEqual(rows[0].eventKey, rows[2].eventKey);
});

test('GBDT squared loss fits a regression target (and logistic stays the default)', () => {
  const r = rng(3);
  const X: number[][] = [], y: number[] = [];
  for (let i = 0; i < 1500; i++) { const a = r() * 4 - 2, b = r(); X.push([a, b]); y.push(a > 0 ? 1.5 : -0.5 + 0.1 * (r() - 0.5)); }
  const ones = new Array(1000).fill(1), z = new Array(1000).fill(0);
  const fit = trainGbdt(X.slice(0, 1000), y.slice(0, 1000), ones, z, X.slice(1000), y.slice(1000), ones.slice(0, 500), z.slice(0, 500), { loss: 'squared', nTrees: 200, learningRate: 0.1 });
  assert.ok(fit.trees > 10);
  assert.ok(Math.abs(gbdtLogit(fit.model, [1, 0.5]) - 1.5) < 0.1 && Math.abs(gbdtLogit(fit.model, [-1, 0.5]) + 0.5) < 0.1);
  assert.ok(fit.valLoss < 0.05, `MSE ${fit.valLoss}`);
});

function volRowsSynthetic(n: number): VolRow[] {
  const r = rng(5);
  const rows: VolRow[] = [];
  const iJump = VOL_MODEL_FEATURES.indexOf('jump_ratio_1h');
  for (let i = 0; i < n; i++) {
    const t = T0 + i * 60_000 * 3;
    const x = VOL_MODEL_FEATURES.map(() => r() - 0.5);
    const sigma = 5e-5;
    // Realised vol runs 1.6x the EWMA when the jump feature is high, 0.7x otherwise.
    const k = x[iJump] > 0 ? 1.6 : 0.7;
    const rv = (sigma * k) ** 2 * (0.8 + 0.4 * r());
    rows.push({ asset: 'BTC', t, day: new Date(t).toISOString().slice(0, 10), tauSec: 900, sigma, x, y: 0.5 * Math.log(rv / sigma ** 2), rvPerSec: rv });
  }
  return rows;
}

test('vol model: learns when realised vol will exceed the EWMA, validated by QLIKE on held-out days; clamped; inert unless validated', () => {
  assert.throws(() => trainVolModel(volRowsSynthetic(100)), /need at least/);
  const p = trainVolModel(volRowsSynthetic(5000));
  assert.ok(p.validation.validated, JSON.stringify(p.validation));
  assert.ok(p.validation.qlikeModel < p.validation.qlikeEwma);
  const m = new VolModel(p);
  const f = (jump: number) => Object.fromEntries(VOL_MODEL_FEATURES.map((k) => [k, k === 'jump_ratio_1h' ? jump : 0]));
  const hi = m.multiplier(f(0.4), T0, 5e-5, 900), lo = m.multiplier(f(-0.4), T0, 5e-5, 900);
  assert.ok(hi > 1.3 && lo < 0.85, `${hi} ${lo}`);
  assert.ok(hi <= VOL_MULT_MAX);
  const fc = new VolForecaster(new VolModel({ ...p, validation: { ...p.validation, validated: false } }));
  assert.equal(fc.multiplier('BTC', T0, 5e-5, 900, () => f(0.4)), 1, 'unvalidated: fair value untouched');
  fc.setModel(m);
  let calls = 0;
  fc.multiplier('BTC', T0, 5e-5, 900, () => { calls++; return f(0.4); });
  fc.multiplier('BTC', T0 + 1000, 5e-5, 600, () => { calls++; return f(0.4); });
  assert.equal(calls, 1, 'asset features cached between recomputes');
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'v.json'), JSON.stringify(p));
  assert.ok(VolModel.load(path.join(dir, 'v.json'))!.validated);
});

function book(bid: number, ask: number, bidSize = 50, askSize = 50): OrderBook {
  const b = new OrderBook('T');
  b.applySnapshot({ bids: [{ price: bid, size: bidSize }], asks: [{ price: ask, size: askSize }] }, T0);
  return b;
}

/** Quotes whose fill depends on distance to the touch, and whose markout on queue imbalance. */
function fillRows(n: number, days = 4) {
  const r = rng(11);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = T0 + Math.floor((i / n) * days * 86_400_000);
    const x = Object.fromEntries(FILL_FEATURES.map((k) => [k, r() - 0.5]));
    x.dist_ticks = Math.floor(r() * 4) - 1;
    const pf = x.dist_ticks <= 0 ? 0.6 : 0.08;
    const filled = r() < pf ? 1 : 0;
    out.push({ t, ticker: 'T', side: 'bid' as const, price: 0.5, count: 1, x, filled: filled as 0 | 1, fillDelaySec: filled ? 10 : null, markout60: filled ? (x.imbalance_side > 0 ? 0.01 : -0.03) + 0.005 * (r() - 0.5) : null });
  }
  return out;
}

test('fill log: quotes, maker fills and 60 s markouts; taker fills are ignored', () => {
  const dir = tmpDir();
  let now = T0, mid = 0.5;
  const log = new FillLog(dir, () => mid, () => now, { timers: false });
  log.onQuote({ ticker: 'T', side: 'bid', price: 0.48, count: 2, x: { dist_ticks: 0 } });
  log.onQuote({ ticker: 'T', side: 'ask', price: 0.53, count: 1, x: { dist_ticks: 1 } });
  now += 5000;
  log.onFill({ ticker: 'T', side: 'ask', price: 0.53, isTaker: true });
  log.onFill({ ticker: 'T', side: 'bid', price: 0.48, isTaker: false });
  now += 30_000;
  assert.equal(log.flush(), 0, 'nothing known yet');
  now = T0 + 61_000; mid = 0.47;
  assert.equal(log.flush(), 1, 'the unfilled ask is final after 60 s');
  now = T0 + 66_000;
  assert.equal(log.flush(), 1, 'the bid fill is final 60 s after the fill');
  const rows = readFillLog(dir);
  const bid = rows.find((r) => r.side === 'bid')!, ask = rows.find((r) => r.side === 'ask')!;
  assert.equal(bid.filled, 1); assert.equal(bid.fillDelaySec, 5);
  assert.ok(Math.abs(bid.markout60! - (0.47 - 0.48)) < 1e-12, 'bought at 0.48, mid 0.47 a minute later: picked off by a cent');
  assert.equal(ask.filled, 0); assert.equal(ask.markout60, null);
});

test('fill model: not ready until 500 quotes / 100 fills; validated once it beats the base rate on held-out days', () => {
  assert.throws(() => trainFillModel(fillRows(300)), /not ready/);
  const p = trainFillModel(fillRows(3000));
  assert.ok(p.validation.validated, JSON.stringify(p.validation));
  assert.ok(p.validation.logLossModel < p.validation.logLossBase);
  const m = new FillModel(p);
  const x = (d: number, imb: number) => ({ ...Object.fromEntries(FILL_FEATURES.map((k) => [k, 0])), dist_ticks: d, imbalance_side: imb });
  assert.ok(m.pFill(x(0, 0)) > 0.45 && m.pFill(x(2, 0)) < 0.2);
  assert.ok(m.markout(x(0, 0.3)) > m.markout(x(0, -0.3)));
});

test('fill model: does nothing until validated, then quotes / crosses / skips by expected value', () => {
  const p = trainFillModel(fillRows(3000));
  const b = book(0.45, 0.47);
  const quote = (price: number, edge: number): OrderPlan => ({ side: 'bid', price, count: 3, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', edge, why: 'maker bid' });
  const ctx = { q: 0.5, book: b, tick: 0.01, tauSec: 600, sigma: 5e-5, features: {}, minEv: 0, takerMinEdge: 0.02 };
  const plan = { place: [quote(0.45, 0.04)], notes: [] as string[] };
  assert.deepEqual(applyFillModel(plan, new FillModel({ ...p, validation: { ...p.validation, validated: false } }), ctx), { crossed: 0, skipped: 0 });
  assert.equal(plan.place[0].postOnly, true, 'unvalidated: untouched');
  assert.deepEqual(applyFillModel(plan, undefined, ctx), { crossed: 0, skipped: 0 });
  const m = new FillModel(p);
  // A deep quote (3 ticks behind) rarely fills; with q far above the ask, crossing now is worth more.
  const deep = { place: [quote(0.42, 0.07)], notes: [] as string[] };
  const r1 = applyFillModel(deep, m, { ...ctx, q: 0.56 });
  assert.equal(r1.crossed, 1, deep.notes.join('; '));
  assert.equal(deep.place[0].price, 0.47); assert.equal(deep.place[0].postOnly, false); assert.equal(deep.place[0].purpose, 'entry');
  // A quote whose expected markout eats its edge, with no taker alternative: skipped.
  const thin = { place: [quote(0.45, 0.005)], notes: [] as string[] };
  // (an ask-heavy book: the side imbalance that predicts getting picked off)
  const r2 = applyFillModel(thin, m, { ...ctx, book: book(0.45, 0.47, 10, 200), q: 0.46, minEv: 0.001 });
  assert.equal(r2.skipped, 1, thin.notes.join('; '));
  assert.equal(thin.place.length, 0);
  // Exits, take-profits and taker entries are never touched.
  const other: OrderPlan[] = [{ ...quote(0.45, 0.01), why: 'take-profit 0.45' }, { ...quote(0.46, 0.01), purpose: 'exit', reduceOnly: true, postOnly: false, timeInForce: 'immediate_or_cancel' }];
  const keep = { place: [...other], notes: [] as string[] };
  applyFillModel(keep, m, ctx);
  assert.deepEqual(keep.place, other);
  // Placement features read the live book.
  const fx = fillInputs(quote(0.44, 0.05), { book: b, tick: 0.01, tauSec: 600, sigma: 5e-5, features: { ofi_30s: 2 } });
  assert.ok(Math.abs(fx.dist_ticks - 1) < 1e-9); assert.ok(Math.abs(fx.spread_ticks - 2) < 1e-9); assert.equal(fx.ofi_30s_side, 2);
});

test('fill model brings itself online: pipeline skips while collecting, promotes once validated, the bot hot-swaps it in', async () => {
  const dir = tmpDir();
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), DATA_DIR: dir, AUTO_TRAIN: 'off' });
  const fills = path.join(dir, 'fills');
  fs.mkdirSync(fills, { recursive: true });
  const write = (rows: ReturnType<typeof fillRows>) => {
    for (const f of fs.readdirSync(fills)) fs.rmSync(path.join(fills, f));
    for (const r of rows) fs.appendFileSync(path.join(fills, `fills-${new Date(r.t).toISOString().slice(0, 10)}.jsonl`), JSON.stringify(r) + '\n');
  };
  write(fillRows(200));
  let r = await runPipeline({ cfg, only: ['fill'], log: () => undefined });
  assert.match(String(r.steps.find((s) => s.step === 'fill')!.skipped), /collecting maker quotes.*not ready/);
  assert.ok(!fs.existsSync(path.join(cfg.autoTrain.dir, 'fill_model.json')));
  write(fillRows(3000));
  r = await runPipeline({ cfg, only: ['fill'], log: () => undefined });
  const step = r.steps.find((s) => s.step === 'fill')!;
  assert.equal((step.detail as { promoted: boolean }).promoted, true, JSON.stringify(step));
  // The running bot picks it up on its next watch and it is active immediately.
  const calls: string[] = [];
  const engine = { model: MetaModel.identity(), snn: undefined, setFillModel(m: FillModel | undefined) { calls.push(m?.validated ? 'active' : 'inactive'); } } as unknown as Engine;
  const audit = tmpAudit();
  const t = new AutoTrainer({ cfg, engine, audit, alerter: new Alerter([], audit), now: () => Date.now() + 10_000 });
  await t.watch();
  assert.deepEqual(calls, ['active']);
});

test('take head: tree candidate on the fair-value residual; older files with fewer inputs still load', () => {
  const x = takeInputs('yes', 0.6, 0.5, 0.02, 600, { snn_up_h: 0.6, snn_bias: 0.02, snn_skill_h: 0.1, snn_cal_h: 0.9 });
  assert.equal(x.length, TAKE_FEATURES.length);
  assert.deepEqual(x.slice(-2), [0.1, 0.9]);
  const gb: TakeModelParams = { features: [...TAKE_FEATURES], kind: 'gbdt', gbdt: { trees: [[{ f: -1, t: 0, l: 0, r: 0, ml: false, v: 0 }]], baseScore: 0 }, validation: { trades: 1, windows: 1, logLossBase: 1, logLossTake: 1, validated: true } };
  assert.ok(Math.abs(takeProbability(gb, x) - 0.6) < 1e-9, 'empty trees = the fair-value probability');
  const old: TakeModelParams = { features: TAKE_FEATURES.slice(0, 9), normalization: { mean: new Array(9).fill(0), std: new Array(9).fill(1) }, layers: [{ weights: [new Array(9).fill(0)], bias: [0], activation: 'linear' }], validation: gb.validation };
  assert.equal(takeProbability(old, x), 0.5);
});

test('perps: tree candidate walked forward with the ridge lambdas; a gbdt PerpModel loads and predicts', () => {
  const r = rng(9);
  const rows = [];
  for (let i = 0; i < 600; i++) {
    const x = new Array(36).fill(NaN).map(() => r() - 0.5);
    rows.push({ asset: 'BTC', ts: T0 + i * 300_000, x, y: (x[0] > 0 ? 40 : -40) + 10 * (r() - 0.5), fundingBps: 0 });
  }
  const res = trainPerp(rows as never, { horizonMin: 60, everySec: 300, minEff: 10 });
  assert.ok(res.oos.some((o) => o.lambda === 'gbdt'));
  assert.equal(res.params.validation!.trials, 5);
  assert.equal(res.params.kind, 'gbdt', `step function: trees win (${JSON.stringify(res.oos)})`);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'p.json'), JSON.stringify(res.params));
  const m = PerpModel.load(path.join(dir, 'p.json'))!;
  const f = (v: number) => Object.fromEntries(res.params.features.map((k, i) => [k, i === 0 ? v : 0]));
  assert.ok(m.predict(f(0.3)).muBps > 20 && m.predict(f(-0.3)).muBps < -20);
});

test('tennis: a gbdt tennis model is a residual on the market (no evidence = the market price)', () => {
  const dir = tmpDir();
  const features = ['logit_pA', 'momentum'];
  fs.writeFileSync(path.join(dir, 't.json'), JSON.stringify({ version: 't', features, kind: 'gbdt', gbdt: { trees: [[{ f: 1, t: 0, l: 1, r: 2, ml: true, v: 0 }, { f: -1, t: 0, l: 0, r: 0, ml: false, v: 0 }, { f: -1, t: 0, l: 0, r: 0, ml: false, v: 0.5 }]], baseScore: 0 }, residual: 0, validation: { matches: 1, holdoutMatches: 0, brierModel: 0, brierMarket: 0, validated: false }, trainedAt: 'x' }));
  const m = TennisFairModel.load(path.join(dir, 't.json'))!;
  const lg = (p: number) => Math.log(p / (1 - p));
  assert.ok(Math.abs(m.predict({ logit_pA: lg(0.6), momentum: NaN }) - 0.6) < 1e-9);
  assert.ok(m.predict({ logit_pA: lg(0.6), momentum: 1 }) > 0.6);
  assert.ok(Number.isNaN(m.predict({ logit_pA: NaN, momentum: 1 })));
});

test('vol model file round-trip keeps its validation flag', () => {
  const p: VolModelParams = { version: 'v', features: [...VOL_MODEL_FEATURES], gbdt: { trees: [], baseScore: Math.log(1.2) }, tauMin: [5, 60], validation: { rows: 1, holdoutRows: 1, holdoutDays: 1, qlikeEwma: 1, qlikeModel: 0.9, improvement: { mean: 0.1, lo: 0.05, hi: 0.2 }, validated: true }, trainedAt: 'x' };
  assert.ok(Math.abs(new VolModel(p).multiplier({}, T0, 5e-5, 900) - 1.2) < 1e-9);
});

import assert from 'node:assert/strict';
import path from 'path';
import { test } from 'node:test';
import { loadConfig, type StrategyConfig } from '../bot/config';
import { DEFAULT_FEES } from '../bot/fees';
import { OrderBook } from '../bot/marketdata/orderBook';
import { IndexTracker } from '../bot/marketdata/indexTracker';
import { applyBeta, calibrationSlices, fitBeta, maxExcessCalibrationPp, weightedLogLoss } from '../bot/model/calibration';
import { parseCalendar } from '../bot/model/calendar';
import { contractKind, priceContract } from '../bot/model/fairValue';
import { BarStore, computeFeatureMap } from '../bot/model/featureEngine';
import { isotonicNonIncreasing, neighborGap, scanLadder, type LadderQuote } from '../bot/model/ladder';
import { MetaModel, type MetaModelParams } from '../bot/model/metaModel';
import { ModelHealth } from '../bot/model/modelHealth';
import { kalshiMaintenance, usMarketClock } from '../bot/model/sessions';
import { gbdtLogit } from '../bot/model/trees';
import { EquityGuard } from '../bot/risk/equityGuard';
import { targetEvSize } from '../bot/sizing/kelly';
import { CadenceGate, inEntryWindow } from '../bot/strategy/cadence';
import { decide, type MarketView } from '../bot/strategy/fairValueStrategy';
import { sigmoid } from '../bot/util/num';
import { runBacktest } from '../research/backtest';
import { buildDataset, type DatasetRow } from '../research/buildDataset';
import { trainGbdt } from '../research/gbdt';
import { dieboldMariano, rng } from '../research/stats';
import { writeSyntheticRecordings } from '../research/synthetic';
import { repriceRow, rowWeights, trainMetaModel } from '../research/trainMetaModel';
import { tmpDir } from './helpers';

const relaxed = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) }).strategy;

// ---- Cadence -----------------------------------------------------------------

test('relaxed cadence: bar closes, fair-value triggers, 10 s floor, window changes', () => {
  const g = new CadenceGate(relaxed);
  const t0 = 1_800_000_000_000 - (1_800_000_000_000 % 60_000) + 5_000;
  const base = { fairValue: 0.5, entryWindowOpen: true, hasResting: false, bookThroughQuote: false };
  assert.equal(g.check('T', { ...base, now: t0 }), 'first');
  assert.equal(g.check('T', { ...base, now: t0 + 3_000, fairValue: 0.6 }), undefined, 'never within 10 s');
  assert.equal(g.check('T', { ...base, now: t0 + 12_000 }), undefined, 'nothing changed');
  assert.equal(g.check('T', { ...base, now: t0 + 13_000, fairValue: 0.516 }), 'fv_move');
  assert.equal(g.check('T', { ...base, now: t0 + 56_000, fairValue: 0.516 }), 'bar');
  assert.equal(g.check('T', { ...base, now: t0 + 57_000, entryWindowOpen: false }), 'window', 'window close overrides the floor');
  const c = new CadenceGate({ ...relaxed, cadence: 'continuous' });
  assert.equal(c.check('T', { ...base, now: t0 }), 'continuous');
  assert.equal(c.check('T', { ...base, now: t0 + 1 }), 'continuous');
});

test('entry windows by contract kind', () => {
  assert.ok(inEntryWindow('updown', 600, [840, 120], [3300, 300]));
  assert.ok(!inEntryWindow('updown', 100, [840, 120], [3300, 300]), 'last 2 minutes are a latency race');
  assert.ok(!inEntryWindow('updown', 880, [840, 120], [3300, 300]));
  assert.ok(inEntryWindow('greater', 3000, [840, 120], [3300, 300]));
  assert.ok(!inEntryWindow('greater', 200, [840, 120], [3300, 300]));
});

// ---- Sizing --------------------------------------------------------------------

test('target-EV sizing: shrink toward market, $ target cap, min EV skip', () => {
  const c = { kappa: 0.5, kellyFraction: 0.25, targetEv: 10, minEv: 1, minEdge: 0.03 };
  const big = targetEvSize({ qModel: 0.62, qMarket: 0.5, cost: 0.5, feePerContract: 0, bankroll: 1e6, maxRiskUsd: 1e6, maxContracts: 1e5 }, c);
  assert.ok(Math.abs(big.qAdj - 0.56) < 1e-12);
  assert.equal(big.contracts, Math.ceil(10 / 0.06), 'the $10 target caps size');
  assert.ok(big.ev >= 10 && big.ev < 10.1);
  const small = targetEvSize({ qModel: 0.62, qMarket: 0.5, cost: 0.5, feePerContract: 0, bankroll: 200, maxRiskUsd: 4, maxContracts: 100 }, c);
  assert.equal(small.contracts, 0);
  assert.equal(small.reason, 'below_min_ev');
  const thin = targetEvSize({ qModel: 0.54, qMarket: 0.5, cost: 0.5, feePerContract: 0, bankroll: 1e6, maxRiskUsd: 1e6, maxContracts: 1e5 }, c);
  assert.equal(thin.contracts, 0, '2c after shrink < 3c minimum edge');
});

// ---- Strategy (relaxed) ----------------------------------------------------------

const strat: StrategyConfig = { ...relaxed, style: 'both' };
const view = (o: Partial<MarketView> = {}): MarketView => ({
  ticker: 'T', pYes: 0.7, pMarket: 0.55, bestBid: { price: 0.53, size: 500 }, bestAsk: { price: 0.57, size: 500 }, position: 0,
  bankroll: 10_000, maxOrderRiskUsd: 200, maxContracts: 250, minSidePrice: 0.1, tauSec: 400, noEntryBeforeCloseSec: 15,
  fastMove: false, tickSize: 0.01, fees: DEFAULT_FEES, nowSec: 1000, closeSec: 1400, makerBuffer: 0.01, entryWindowOpen: true, exitWindowOpen: true, ...o,
});

test('relaxed maker bid sits at q_adj - e_min - buffer; takes need >= 5c after fees', () => {
  const out = decide(view(), { ...strat, style: 'maker' });
  const bid = out.place.find((p) => p.side === 'bid')!;
  // q_adj = 0.55 + 0.5 * (0.70 - 0.55) = 0.625 -> floor(0.625 - 0.03 - 0.01) = 0.58, capped below the ask.
  assert.equal(bid.price, 0.56);
  const take = decide(view({ bestAsk: { price: 0.575, size: 500 } }), strat).place.find((p) => p.purpose === 'entry');
  assert.equal(take, undefined, 'q_adj - ask - fee = 3.3c < 5c');
  const take2 = decide(view({ pYes: 0.85, bestAsk: { price: 0.6, size: 500 } }), strat).place.find((p) => p.purpose === 'entry')!;
  assert.ok(take2.edge >= 0.05, `edge ${take2.edge}`);
});

test('final minute rides to settlement; ensemble veto blocks entries; exits-only between evaluations', () => {
  const rich = view({ position: 50, pYes: 0.3, pMarket: 0.3, bestBid: { price: 0.6, size: 100 } });
  assert.ok(decide(rich, strat).place.some((p) => p.purpose === 'exit'));
  assert.ok(!decide({ ...rich, exitWindowOpen: false }, strat).place.some((p) => p.purpose === 'exit'));
  const vetoed = decide(view({ pStd: 0.1 }), strat);
  assert.equal(vetoed.place.length, 0);
  assert.ok(vetoed.notes.some((n) => n.includes('ensemble veto')));
  const between = decide(view({ restingBid: { clientOrderId: 'b', price: 0.4, remaining: 5 } }), strat, { entries: false });
  assert.equal(between.cancel.length, 0, 'resting quotes untouched between evaluations');
  assert.equal(between.place.length, 0);
});

test('Mode B take-profit rests at entry + TP, never below the model value', () => {
  const tp = { ...strat, style: 'maker' as const, exitPolicy: 'take_profit' as const };
  const long = view({ position: 100, entrySidePrice: 0.5, pYes: 0.55, pMarket: 0.55, bestBid: { price: 0.52, size: 100 }, bestAsk: { price: 0.56, size: 100 } });
  const ask = decide(long, tp).place.find((p) => p.side === 'ask')!;
  assert.equal(ask.price, 0.58);
  assert.equal(ask.count, 100);
  const worthMore = decide({ ...long, pYes: 0.75, pMarket: 0.75, bestAsk: { price: 0.8, size: 100 } }, tp).place.find((p) => p.side === 'ask')!;
  assert.ok(worthMore.price >= 0.76, `TP ${worthMore.price} below model value`);
  const shortNo = decide(view({ position: -100, entrySidePrice: 0.4, pYes: 0.6, pMarket: 0.6, bestBid: { price: 0.5, size: 100 }, bestAsk: { price: 0.6, size: 100 } }), tp).place.find((p) => p.side === 'bid')!;
  assert.equal(shortNo.price, 0.52, 'NO take-profit at 0.48 = YES bid 0.52');
});

// ---- Calibration, DM ------------------------------------------------------------

test('beta calibration recovers a favourite-longshot bias; DM detects a better forecaster', () => {
  const r = rng(11);
  const p: number[] = [], y: number[] = [];
  for (let i = 0; i < 20000; i++) {
    const q = 0.03 + 0.94 * r();
    const truth = q < 0.5 ? q * 0.7 : q; // longshots win less often than priced
    p.push(q); y.push(r() < truth ? 1 : 0);
  }
  const cal = fitBeta(p, y);
  assert.ok(weightedLogLoss(p.map((x) => applyBeta(x, cal)), y) < weightedLogLoss(p, y));
  assert.ok(applyBeta(0.1, cal) < 0.09);
  const good = Array.from({ length: 300 }, () => -0.01 + (r() - 0.5) * 0.05);
  assert.ok(dieboldMariano(good).pValue < 0.05);
  const same = Array.from({ length: 300 }, () => (r() - 0.5) * 0.05);
  assert.ok(dieboldMariano(same).pValue > 0.01);
});

test('calibration slices only fail beyond sampling noise', () => {
  const r = rng(3);
  const n = 4000;
  const p = Array.from({ length: n }, () => r());
  const y = p.map((q) => (r() < q ? 1 : 0));
  const win = p.map((_, i) => i);
  const tau = p.map(() => 300);
  assert.ok(maxExcessCalibrationPp(calibrationSlices(p, y, tau, win)) <= 1.5);
  const biased = calibrationSlices(p.map((q) => Math.min(0.99, q + 0.1)), y, tau, win);
  assert.ok(maxExcessCalibrationPp(biased) > 1.5);
});

// ---- Guards --------------------------------------------------------------------

test('Kalshi maintenance window and US market clock (DST-correct)', () => {
  assert.equal(kalshiMaintenance(Date.parse('2026-10-01T07:30:00Z')).inside, true); // Thu 03:30 EDT
  assert.equal(kalshiMaintenance(Date.parse('2026-10-01T06:40:00Z')).minutesTo, 20);
  assert.equal(kalshiMaintenance(Date.parse('2026-12-03T08:30:00Z')).inside, true); // Thu 03:30 EST
  assert.equal(kalshiMaintenance(Date.parse('2026-10-02T07:30:00Z')).inside, false);
  assert.equal(usMarketClock(Date.parse('2026-10-01T13:00:00Z')).toOpen, 30);
  assert.ok(Number.isNaN(usMarketClock(Date.parse('2026-10-03T15:00:00Z')).toOpen));
});

test('equity guard: drawdown scales Kelly, withdrawals are not losses, weekly loss pauses', () => {
  const g = new EquityGuard({ ddScaleAt: 0.15, weeklyLossPause: 0.08 });
  const t = 1_800_000_000_000;
  g.update(1000, t);
  assert.equal(g.kellyScale(1000), 1);
  assert.ok(Math.abs(g.kellyScale(925) - 0.5) < 1e-9);
  g.onCashFlow(-300, t + 1000);
  assert.equal(g.kellyScale(700), 1, 'a $300 withdrawal is not drawdown');
  g.update(690, t + 3_600_000);
  assert.equal(g.paused(t + 3_600_000), undefined);
  g.update(600, t + 2 * 3_600_000);
  assert.ok(g.paused(t + 2 * 3_600_000));
  assert.equal(g.paused(t + 2 * 3_600_000 + 86_400_001), undefined);
});

test('model health halts only when significantly worse than the calibrated market', () => {
  const h = new ModelHealth({ minWindows: 50 });
  const r = rng(5);
  for (let w = 0; w < 60; w++) {
    const y = r() < 0.5 ? 'yes' : 'no';
    h.record(`A${w}`, y === 'yes' ? 0.3 : 0.7, 0.5, w); // confidently wrong
    h.onResult(`A${w}`, y);
  }
  assert.equal(h.status().halt, true);
  const ok = new ModelHealth({ minWindows: 50 });
  for (let w = 0; w < 60; w++) {
    const y = r() < 0.5 ? 'yes' : 'no';
    ok.record(`B${w}`, y === 'yes' ? 0.6 : 0.4, 0.5, w);
    ok.onResult(`B${w}`, y);
  }
  assert.equal(ok.status().halt, false);
  assert.ok(ok.status().advantage! > 0);
});

// ---- Features --------------------------------------------------------------------

test('minute bars feed returns, realized volatility, jump ratio, clock and calendar features', () => {
  const idx = new IndexTracker('BTC', 6 * 3_600_000);
  const bars = new BarStore();
  const t0 = Date.parse('2026-10-01T10:00:00Z');
  let x = Math.log(60000);
  const r = rng(8);
  for (let s = 0; s <= 5 * 3600; s++) {
    x += 0.0001 * (r() - 0.5) + (s === 4 * 3600 ? 0.01 : 0); // one jump
    const ts = t0 + s * 1000;
    idx.add(Math.exp(x), ts);
    bars.onPrice(Math.exp(x), ts);
  }
  const now = t0 + 5 * 3600 * 1000;
  const book = new OrderBook('T');
  book.applySnapshot({ bids: [{ price: 0.5, size: 10 }], asks: [{ price: 0.54, size: 10 }] }, now);
  const cal = parseCalendar([{ ts: '2026-10-01T15:30:00Z', kind: 'cpi' }]);
  const f = computeFeatureMap({
    now, fairValue: 0.55, mid: 0.52, tauSec: 600, sigmaPerSqrtSec: 1e-4, referenceSigma: 1e-4, inWindow: false, book, index: idx,
    kind: 'updown', strike: 60000, d2: 0.1, vEff: 1e-5, bars, openTime: now - 300_000, calendar: cal,
  });
  for (const k of ['ret_5m_z', 'ret_15m_z', 'ret_1h_z', 'log_rv_15m', 'log_rv_1h', 'log_rv_4h', 'jump_ratio_1h', 'efficiency_ratio_15m', 'ewma_vol_ratio', 'logit_gap', 'd2', 'phi_d2', 'p_analytic_t', 'range_pos_4h', 'ret_since_open_z']) {
    assert.ok(Number.isFinite(f[k]), `${k}=${f[k]}`);
  }
  assert.ok(f.jump_ratio_1h > 0.5, `jump dominates the last hour (${f.jump_ratio_1h})`);
  assert.equal(f.kind_updown, 1);
  assert.equal(f.sec_since_quarter, 0);
  assert.equal(f.min_to_macro_event, 30);
  assert.ok(Number.isNaN(f.dist_24h_high_z), 'needs 24 h of bars');
});

// ---- Pricing kinds, ladder ---------------------------------------------------------

test('contract kinds and the ladder scanner', () => {
  assert.equal(contractKind('KXBTC15M'), 'updown');
  assert.equal(contractKind('KXBTCD', 'greater'), 'greater');
  assert.equal(contractKind('KXBTC', 'between'), 'between');
  const less = priceContract({ kind: 'less', cap: 100 }, { spot: 100, sigmaPerSqrtSec: 3e-4, tauSec: 1800 })!;
  const gt = priceContract({ kind: 'greater', strike: 100 }, { spot: 100, sigmaPerSqrtSec: 3e-4, tauSec: 1800 })!;
  assert.ok(Math.abs(less.pYes + gt.pYes - 1) < 1e-9);

  assert.deepEqual(isotonicNonIncreasing([0.9, 0.7, 0.75, 0.3]), [0.9, 0.725, 0.725, 0.3]);
  const q = (ticker: string, strike: number, bid: number, ask: number): LadderQuote => ({ ticker, kind: 'greater', strike, bid, ask, mid: (bid + ask) / 2, bidSize: 50, askSize: 50 });
  const scan = scanLadder([q('A', 100, 0.7, 0.72), q('B', 101, 0.8, 0.82), q('C', 102, 0.2, 0.22)]);
  assert.ok(scan.strikes.find((s) => s.ticker === 'B')!.violationC > 5);
  assert.ok(scan.arbitrage.some((a) => a.buyYes === 'A' && a.buyNo === 'B' && a.profitPerContract > 0), 'YES(100) + NO(101) < $1');
  assert.ok(Math.abs(neighborGap([q('A', 100, 0.7, 0.72), q('B', 101, 0.5, 0.52), q('C', 102, 0.2, 0.22)], 'B')! - 0.05) < 1e-9);
  const clean = scanLadder([q('A', 100, 0.7, 0.72), q('B', 101, 0.5, 0.52)]);
  assert.equal(clean.arbitrage.length, 0);
});

// ---- Trees, ensemble ------------------------------------------------------------------

test('GBDT learns a nonlinear residual, routes missing values, and loads as a live ensemble', () => {
  const r = rng(17);
  const mk = (n: number) => {
    const X: number[][] = [], y: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = r() * 2 - 1, miss = r() < 0.2;
      const z = Math.abs(a) > 0.5 ? 1.5 : -1.5; // non-monotone: invisible to a linear model
      X.push([miss ? NaN : a, 0]);
      y.push(r() < sigmoid(miss ? 1 : z) ? 1 : 0);
    }
    return { X, y, w: X.map(() => 1), init: X.map(() => 0) };
  };
  const tr = mk(4000), va = mk(1500);
  const fit = trainGbdt(tr.X, tr.y, tr.w, tr.init, va.X, va.y, va.w, va.init, { maxDepth: 2, nTrees: 150 });
  assert.ok(fit.trees > 10);
  assert.ok(gbdtLogit(fit.model, [0.9, 0]) > 0.8 && gbdtLogit(fit.model, [0, 0]) < -0.8);
  assert.ok(gbdtLogit(fit.model, [NaN, 0]) > 0.3, 'missing learned its own direction');
  const fit2 = trainGbdt(tr.X, tr.y, tr.w, tr.init, va.X, va.y, va.w, va.init, { maxDepth: 2, nTrees: 150, seed: 99 });
  const params: MetaModelParams = { version: 'g', kind: 'gbdt', features: ['logit_fv', 'spread'], gbdt: fit.model, ensemble: [{ gbdt: fit2.model }], residualFeature: undefined, referenceSigma: 1e-4 };
  params.features = ['imbalance', 'spread'];
  const m = MetaModel.fromJson(JSON.stringify(params));
  const d = m.predictDetailed({ imbalance: 0.9, spread: 0 }, 0.5);
  assert.ok(d.p > 0.65 && d.std !== undefined && d.std >= 0);
  assert.throws(() => MetaModel.fromJson(JSON.stringify({ ...params, gbdt: { trees: [[{ f: 5, t: 0, l: 1, r: 2, ml: false, v: 0 }]], baseScore: 0 } })));
});

// ---- Trainer, backtest ---------------------------------------------------------------

test('row weights: 1 / snapshots per contract, and / strikes per hourly event', () => {
  const row = (ticker: string, kind: 'updown' | 'greater', event: string) => ({ ticker, kind, event, window: 1 } as unknown as DatasetRow);
  const rows = [row('U', 'updown', 'EU'), row('U', 'updown', 'EU'), row('H1', 'greater', 'EH'), row('H2', 'greater', 'EH')];
  const w = rowWeights(rows);
  // Raw: U 1/2 each, H1 1/(1*2), H2 1/(1*2) -> all equal after normalization.
  assert.ok(w.every((x) => Math.abs(x - 1) < 1e-12), JSON.stringify(w));
});

test('re-pricing with Student-t refreshes the fair-value features', () => {
  const r = { spot: 100, strike: 103, sigma: 3e-4, sigmaPricing: 3e-4, tauSec: 900, mid: 0.05, bid: 0.04, ask: 0.06, fv: 0, kind: 'updown', fx: { logit_fv: 0, fv_minus_mid: 0 } } as unknown as DatasetRow;
  repriceRow(r, undefined);
  const g = r.fv;
  repriceRow(r, 4);
  assert.ok(r.fv > g);
  assert.ok(Math.abs(r.fx.fv_minus_mid - (r.fv - 0.05)) < 1e-12);
});

test('trainer: GBDT family, ensemble, market calibration and relaxed gates on synthetic data', async () => {
  const dir = path.join(tmpDir(), 'rec');
  writeSyntheticRecordings(dir, { windows: 14, seed: 6 });
  const rows = await buildDataset(dir, 15);
  const rep = trainMetaModel(rows, { folds: 3, maxEpochs: 30, families: ['gbdt'], depths: [2], ensemble: 2, sets: ['base', 'base+geometry+vol+kalshi'] });
  assert.equal(rep.params.kind, 'gbdt');
  assert.equal(rep.params.ensemble?.length, 1);
  assert.ok(rep.params.marketCalibration);
  const m = MetaModel.fromJson(JSON.stringify(rep.params));
  assert.ok(m.liveBlockers().length > 0, 'tiny sample never passes');
  assert.ok(Number.isFinite(rep.holdout.logLossMarketCal));
  assert.equal(rep.holdout.dm.n, rep.holdout.nWindows);
  // Too few holdout windows for a DM test: recorded as p = 1 (fails the gate), never as a pass.
  if (!Number.isFinite(rep.holdout.dm.pValue)) assert.equal(rep.params.validation!.dmPValue, 1);
  assert.ok(rep.cv.every((c) => Number.isFinite(c.oosLogLoss)));
});

test('relaxed backtest: cadence-gated entries, target-EV sizing, take-profit mode', async () => {
  const dir = path.join(tmpDir(), 'rec');
  writeSyntheticRecordings(dir, { windows: 8, seed: 12, marketNoise: 0.06 });
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), STRATEGY_STYLE: 'both' });
  const bt = await runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 20_000, { exitPolicy: 'take_profit' });
  assert.ok(bt.entryEvaluations > 0);
  assert.ok(Number.isFinite(bt.pnl));
  assert.ok(bt.days > 0);
  for (const t of bt.trades) assert.ok(Number.isFinite(t.pnl) && t.contracts > 0);
});

import { cpcvSplits } from '../research/trainMetaModel';

test('CPCV: N groups, k held out -> C(N, k) splits, every window tested equally often', () => {
  const w = Array.from({ length: 100 }, (_, i) => i * 900_000);
  const sp = cpcvSplits(w, 10, 2);
  assert.equal(sp.length, 45);
  const count = new Map<number, number>();
  for (const s of sp) for (const t of s.test) count.set(t, (count.get(t) ?? 0) + 1);
  assert.ok([...count.values()].every((c) => c === 9), 'each group is tested in 9 of 45 splits (9 paths)');
});

import { pbo } from '../research/stats';

test('PBO treats identical variants as uninformative (0.5), not as overfit', () => {
  const r = rng(4);
  const col = Array.from({ length: 64 }, () => r() - 0.5);
  assert.equal(pbo(col.map((v) => [v, v, v]), 8).pbo, 0.5);
});

import { evThresholds } from '../bot/sizing/kelly';

test('$20 is tradable: EV thresholds scale with bankroll, spec figures from ~$6,250', () => {
  assert.equal(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) }).paperBankrollUsd, 20);
  assert.equal(relaxed.minTradableBankrollUsd, 20);
  const small = evThresholds(relaxed, 20);
  assert.ok(Math.abs(small.targetEv - 0.032) < 1e-9 && Math.abs(small.minEv - 0.0032) < 1e-9);
  const big = evThresholds(relaxed, 6250);
  assert.ok(Math.abs(big.targetEv - 10) < 1e-9 && Math.abs(big.minEv - 1) < 1e-9);
  assert.deepEqual(evThresholds(relaxed, 1e6), { targetEv: 10, minEv: 1 });
  // A $20 account with a 2% per-order cap still quotes (fractional contracts).
  const out = decide(view({ bankroll: 20, maxOrderRiskUsd: 0.4 }), { ...strat, style: 'maker' });
  const bid = out.place.find((p) => p.side === 'bid')!;
  assert.ok(bid && bid.count > 0 && bid.count * bid.price <= 0.4 + 1e-9, JSON.stringify(out));
});

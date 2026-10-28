import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { brier, maxCalibrationErrorPp, reliability, weightedLogLoss } from '../bot/model/calibration';
import { FEATURE_NAMES } from '../bot/model/features';
import { gateBlockers, GO_LIVE_GATES, MetaModel, type MetaModelParams } from '../bot/model/metaModel';
import { addBatch, annotateTally, judgeBatch, tallyEvidence, type GoLiveTally, type HoldoutJudged } from '../research/goLiveTally';
import { dieboldMariano } from '../research/stats';
import { holdoutCut } from '../research/trainMetaModel';
import { tmpDir } from './helpers';

const W0 = Date.UTC(2026, 9, 1);
const WIN = 15 * 60_000;
const TAUS = [60, 400, 1000, 2000];

/** `n` windows from window index `i0`, 4 snapshots each. Calibrated by construction: of every 4 windows at 0.25, 0.5
 *  and 0.75, exactly 1, 2 and 3 settle YES. The market's mid leans 0.15 toward YES. `shift` moves the model's
 *  probabilities (another candidate). Each window traded: P&L 0.5 +- 0.3, 2 contracts. */
function holdout(i0: number, n: number, shift = 0): { h: HoldoutJudged; trades: Map<number, { pnl: number; contracts: number }> } {
  const h: HoldoutJudged = { window: [], tauSec: [], p: [], pMkt: [], mid: [], y: [], w: [], cut: W0 + i0 * WIN };
  const trades = new Map<number, { pnl: number; contracts: number }>();
  for (let i = i0; i < i0 + n; i++) {
    const level = Math.floor(i / 4) % 3;
    const q = [0.25, 0.5, 0.75][level];
    const y = i % 4 < level + 1 ? 1 : 0;
    const w = W0 + i * WIN;
    for (const tau of TAUS) {
      h.window.push(w); h.tauSec.push(tau); h.p.push(q + shift); h.mid.push(Math.min(0.99, q + 0.15)); h.pMkt.push(Math.min(0.99, q + 0.15)); h.y.push(y); h.w.push(0.25);
    }
    trades.set(w, { pnl: 0.5 + 0.3 * Math.sin(i), contracts: 2 });
  }
  return { h, trades };
}

const EMPTY: GoLiveTally = { through: 0, batches: [] };
const at = '2026-10-28T00:00:00.000Z';

test('holdout cut: the final 20%, reaching back to the first window the tally has not judged, never past the middle', () => {
  const ws = Array.from({ length: 100 }, (_, i) => i);
  assert.equal(holdoutCut(ws), 80);
  assert.equal(holdoutCut(ws, 69), 70, 'reaches back to the first unjudged window');
  assert.equal(holdoutCut(ws, 89), 80, 'the tally is ahead: the usual 20%');
  assert.equal(holdoutCut(ws, 10), 50, 'never past the middle');
  assert.equal(holdoutCut(ws, 500), 80, 'nothing new');
});

test('a batch holds the holdout windows after the last judged one, with the backtest windows among them', () => {
  const { h, trades } = holdout(0, 40);
  const b = judgeBatch(h, trades, { after: W0 + 9 * WIN, model: 'm1', trials: 3, at })!;
  assert.equal(b.windows.length, 30);
  assert.equal(b.from, W0 + 9 * WIN + 1, 'from just after the last judged window');
  assert.equal(b.to, W0 + 39 * WIN);
  assert.equal(b.trades.length, 30);
  assert.ok(b.trades.every(([w]) => w >= b.from && w <= b.to));
  assert.equal(b.windows[0][1], 4, 'rows of the window');
  assert.ok(Math.abs(b.windows[0][2] - 1) < 1e-9, 'a contract weighs 1 over its snapshots');
  assert.equal(b.price.reduce((s, x) => s + x[0], 0), 120);
  assert.equal(b.tau.reduce((s, x) => s + x[0], 0), 120);
  assert.equal(b.price.reduce((s, x) => s + x[3], 0), 30, 'each window in one price bin (a constant probability)');
  assert.equal(judgeBatch(h, trades, { after: b.to, model: 'm1', trials: 3, at }), undefined, 'nothing after the last judged window');
  const later = holdout(0, 40);
  later.h.cut = W0 + 35 * WIN;
  assert.equal(judgeBatch(later.h, later.trades, { after: 0, model: 'm2', trials: 3, at })!.from, W0 + 35 * WIN, 'never before the holdout');
});

test('one batch: the numbers the trainer computes for its holdout', () => {
  const { h, trades } = holdout(0, 60, -0.05);
  const ev = tallyEvidence(addBatch(EMPTY, judgeBatch(h, trades, { after: 0, model: 'm1', trials: 1, at })!))!;
  const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-5, `${what}: ${a} vs ${b}`);
  near(ev.brierModel, brier(h.p, h.y), 'Brier');
  near(ev.brierMarket, brier(h.mid, h.y), 'market Brier');
  near(ev.logLossModel!, weightedLogLoss(h.p, h.y, h.w), 'log loss');
  near(ev.logLossMarketCal!, weightedLogLoss(h.pMkt, h.y, h.w), 'calibrated market log loss');
  near(ev.maxCalibrationErrorPp, maxCalibrationErrorPp(reliability(h.p, h.y)), 'reliability');
  const perWindow = [...new Set(h.window)].map((w) => {
    const ix = h.window.flatMap((x, i) => (x === w ? [i] : []));
    return ix.reduce((s, i) => s + h.w[i] * (weightedLogLoss([h.p[i]], [h.y[i]]) - weightedLogLoss([h.pMkt[i]], [h.y[i]])), 0) / ix.reduce((s, i) => s + h.w[i], 0);
  });
  near(ev.dmPValue!, dieboldMariano(perWindow).pValue, 'Diebold-Mariano');
  assert.equal(ev.nWindows, 60);
  assert.equal(ev.windowsTraded, 60);
  assert.equal(ev.days, 1);
});

test('the tally adds up across runs: each window once, the same numbers as one judgement of them all', () => {
  const all = holdout(0, 120);
  const one = tallyEvidence(addBatch(EMPTY, judgeBatch(all.h, all.trades, { after: 0, model: 'm1', trials: 2, at })!))!;
  // Run 1 holds out windows 0-79; run 2's dataset overlaps it (40-119): only 80-119 are added, as its candidate judged them.
  const r1 = holdout(0, 80), r2 = holdout(40, 80);
  let t = addBatch(EMPTY, judgeBatch(r1.h, r1.trades, { after: 0, model: 'm1', trials: 2, at })!);
  t = addBatch(t, judgeBatch(r2.h, r2.trades, { after: t.through, model: 'm2', trials: 2, at })!);
  assert.equal(t.batches[1].windows.length, 40);
  const two = tallyEvidence(t)!;
  assert.equal(two.nWindows, 120);
  assert.equal(two.windowsTraded, 120);
  assert.equal(two.models, 2);
  for (const k of ['brierModel', 'brierMarket', 'logLossModel', 'logLossMarketCal', 'dmPValue', 'maxCalibrationErrorPp', 'maxExcessCalibrationPp', 'netEdgeCiLow', 'deflatedSharpe', 'dsrProbability'] as const) {
    assert.ok(Math.abs((one[k] as number) - (two[k] as number)) < 1e-6, `${k}: ${one[k]} vs ${two[k]}`);
  }
});

test('the bar is reached across runs: the gates read the tally, not one run\'s few days', () => {
  let t = EMPTY;
  const run = (i: number) => { const r = holdout(i * 120, 120); t = addBatch(t, judgeBatch(r.h, r.trades, { after: t.through, model: `m${i}`, trials: 4, at })!); };
  for (let i = 0; i < 5; i++) run(i);
  const early = gateBlockers(tallyEvidence(t)!);
  assert.ok(early.some((b) => b.includes('only 600 validation windows')), early.join('; '));
  assert.ok(early.some((b) => b.includes('only 600 windows traded')), early.join('; '));
  assert.equal(early.length, 2, `only the counts: ${early.join('; ')}`);
  for (let i = 5; i < 9; i++) run(i);
  const ev = tallyEvidence(t)!;
  assert.equal(ev.nWindows, 1080);
  assert.ok(ev.nWindows >= GO_LIVE_GATES.minWindows && ev.windowsTraded >= GO_LIVE_GATES.minWindowsTraded);
  assert.deepEqual(gateBlockers(ev), []);
  assert.equal(JSON.parse(JSON.stringify(t)).batches.length, 9, 'kept as plain JSON');

  // The candidate carries the tally: its own holdout (a day of windows) no longer blocks it, but must beat the market.
  const n = FEATURE_NAMES.length;
  const params: MetaModelParams = {
    version: 'tally-test', kind: 'mlp', features: [...FEATURE_NAMES], referenceSigma: 5e-5,
    normalization: { mean: new Array(n).fill(0), std: new Array(n).fill(1) },
    layers: [{ weights: [[1, ...new Array(n - 1).fill(0)]], bias: [0], activation: 'linear' }],
    validation: { passed: false, nWindows: 96, brierModel: 0.2, brierMarket: 0.21, maxCalibrationErrorPp: 5, logLossModel: 0.6, logLossMarketCal: 0.61, dmPValue: 0.4, evaluatedAt: at },
  };
  const file = path.join(tmpDir(), 'model.candidate.json');
  fs.writeFileSync(file, JSON.stringify(params));
  assert.ok(MetaModel.load(file).liveBlockers().some((b) => b.includes('only 96 validation windows')), 'its own holdout alone is too small');
  assert.deepEqual(annotateTally(file, ev), { passed: true, blockers: [] });
  const m = MetaModel.load(file);
  assert.equal(m.params.validation?.passed, true);
  assert.equal(m.params.validation?.tally?.nWindows, 1080);
  assert.deepEqual(m.liveBlockers(), []);
  fs.writeFileSync(file, JSON.stringify({ ...params, validation: { ...params.validation, logLossModel: 0.62 } }));
  const worse = annotateTally(file, ev);
  assert.equal(worse.passed, false);
  assert.ok(worse.blockers.some((b) => b.startsWith('own holdout')), worse.blockers.join('; '));
  // A tally the model loses on blocks it like its own holdout would.
  let bad = EMPTY;
  for (let i = 0; i < 9; i++) { const r = holdout(i * 120, 120, 0.2); bad = addBatch(bad, judgeBatch(r.h, r.trades, { after: bad.through, model: 'm', trials: 4, at })!); }
  const lost = gateBlockers(tallyEvidence(bad)!);
  assert.ok(lost.some((b) => b.includes('log loss')) && lost.some((b) => b.includes('calibration')), lost.join('; '));
});

test('results more than a year older than the newest are dropped', () => {
  const r1 = holdout(0, 10), r2 = holdout(400 * 96, 10);
  let t = addBatch(EMPTY, judgeBatch(r1.h, r1.trades, { after: 0, model: 'm1', trials: 1, at })!);
  t = addBatch(t, judgeBatch(r2.h, r2.trades, { after: t.through, model: 'm2', trials: 1, at })!);
  assert.equal(t.batches.length, 1);
  assert.equal(tallyEvidence(t)!.nWindows, 10);
});

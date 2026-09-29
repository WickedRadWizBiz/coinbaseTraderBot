import assert from 'node:assert/strict';
import path from 'path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { MetaModel } from '../bot/model/metaModel';
import { runBacktest } from '../research/backtest';
import { buildDataset } from '../research/buildDataset';
import { bootstrapMeanCi, deflatedSharpe, expectedMaxSharpe, pbo, probabilisticSharpe, rng } from '../research/stats';
import { writeSyntheticRecordings } from '../research/synthetic';
import { trainMetaModel } from '../research/trainMetaModel';
import { tmpDir } from './helpers';

test('bootstrap CI brackets the mean', () => {
  const r = rng(5);
  const xs = Array.from({ length: 500 }, () => r() - 0.4);
  const ci = bootstrapMeanCi(xs, 0.05, 2000);
  assert.ok(ci.lo < ci.mean && ci.mean < ci.hi);
  assert.ok(ci.lo > 0);
});

test('deflated Sharpe penalises many trials', () => {
  assert.ok(expectedMaxSharpe(100, 0.01) > expectedMaxSharpe(2, 0.01));
  const r = rng(9);
  const xs = Array.from({ length: 400 }, () => (r() - 0.5) * 0.2 + 0.01);
  const one = deflatedSharpe(xs, 1);
  const many = deflatedSharpe(xs, 1000);
  assert.ok(one.excess > many.excess);
  assert.ok(probabilisticSharpe(xs, 0) > 0.5);
});

test('PBO is high for pure-noise variants and low for a dominant one', () => {
  const r = rng(21);
  const noise = Array.from({ length: 160 }, () => Array.from({ length: 6 }, () => r() - 0.5));
  const p1 = pbo(noise, 8).pbo;
  assert.ok(p1 > 0.2, `noise pbo=${p1}`);
  const skill = noise.map((row) => row.map((v, m) => (m === 0 ? v + 0.6 : v)));
  assert.ok(pbo(skill, 8).pbo < 0.1);
});

test('research pipeline runs end to end on synthetic recordings', async () => {
  const dir = path.join(tmpDir(), 'rec');
  writeSyntheticRecordings(dir, { windows: 14, seed: 3 });
  const rows = await buildDataset(dir, 15);
  assert.ok(rows.length > 300, `rows=${rows.length}`);
  assert.ok(new Set(rows.map((r) => r.window)).size >= 12);

  const rep = trainMetaModel(rows, { folds: 3, maxEpochs: 40 });
  const model = MetaModel.fromJson(JSON.stringify(rep.params));
  // Tiny sample: must NOT pass go-live gates.
  assert.equal(rep.params.validation!.passed, false);
  assert.ok(model.liveBlockers().length > 0);
  // On synthetic data the fair value is the truth, so it beats the noisy market.
  assert.ok(rep.holdout.brierFairValue < rep.holdout.brierMarket);

  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) });
  const bt = await runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 200);
  assert.ok(bt.windows.size > 0);
  assert.ok(Number.isFinite(bt.pnl));
});

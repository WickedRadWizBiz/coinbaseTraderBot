import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { MetaModel } from '../bot/model/metaModel';
import { gatePasses, setProbation } from '../bot/risk/probation';
import type { TrialName } from '../bot/strategy/componentTrials';
import { activeTaNet, setTaNet } from '../bot/ta/taNet';
import { setTaNetEnsemble } from '../bot/ta/taNetEnsemble';
import { engineModels, installProbation, runBacktest, type EvalReading } from '../research/backtest';
import { benchAt, corr, gateAt, nearbyVerdict, paperFromAudit, paperSummary, priceMatcher, readAudit, replayDays, settingsDiffer, stretchStart, verdict } from '../research/replayCheck';
import { writeSyntheticRecordings } from '../research/synthetic';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'replay-check-test-'));

test('backtest paper options: orders sized from the bankroll share, gate and bench wired in', async () => {
  const dir = path.join(tmp(), 'rec');
  writeSyntheticRecordings(dir, { windows: 8, seed: 12, marketNoise: 0.06 });
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), STRATEGY_STYLE: 'both' });
  const rule = { ...cfg.probation, t: 2, minTrades: 30 };
  const small = await runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 200, { exitPolicy: 'take_profit', paper: { orderFrac: 0.02, orderUsd: 0 }, accuracyGate: cfg.strategy.accuracyGate, takeProfitBench: { enforce: true, rule } });
  const big = await runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 200, { exitPolicy: 'take_profit', paper: { orderFrac: 0.2, orderUsd: 0 }, accuracyGate: cfg.strategy.accuracyGate, takeProfitBench: { enforce: true, rule } });
  assert.ok(small.paper && big.paper);
  assert.ok(Number.isFinite(small.pnl) && Number.isFinite(big.pnl));
  // A larger share of the bankroll an order trades more contracts (or the same when nothing traded).
  assert.ok(big.contracts >= small.contracts);
  // The gate starts with an empty scorecard: it cannot block before it has scored enough markets.
  assert.equal(small.paper.accuracyBlocks, 0);
  // The engine's loss-aware size: a quarter at worst, never zero (a drawdown does not stop the replay trading).
  assert.ok((big.sizeScaleMin ?? 1) >= 0.25 && (big.sizeScaleMin ?? 1) <= 1);
  // Every fill has a purpose and an hour; a take-profit queued for the next tick keeps its name (the bench is fed).
  const sum = (o: Record<string, { fills: number; contracts: number }>) => Object.values(o).reduce((a, x) => [a[0] + x.fills, a[1] + x.contracts], [0, 0]);
  const [f, c] = sum(big.byPurpose ?? {});
  assert.equal(f, big.fills);
  assert.ok(Math.abs(c - big.contracts) < 1e-6);
  assert.ok(Math.abs(Object.values(big.contractsByHour ?? {}).reduce((a, x) => a + x, 0) - big.contracts) < 1e-6);
  assert.equal(big.byPurpose?.other, undefined, 'no fill without a purpose');
  assert.ok((big.paper.takeProfitContracts ?? 0) <= (big.exits.contracts ?? 0) + 1e-9, 'take-profit sales are exits');
  assert.equal(big.paper.takeProfitSales, big.takeProfitFills);
});

test('replay check: paper side read from the audit log (crypto only, exits by kind, P&L by hour)', async () => {
  const dir = tmp();
  const L = (kind: string, ts: string, data: object) => JSON.stringify({ ts, kind, data });
  fs.writeFileSync(path.join(dir, 'audit-2026-10-22.jsonl'), [
    L('decision', '2026-10-22T10:01:00.000Z', { decisionId: 'd1', place: [{ purpose: 'exit', side: 'ask', price: 0.7, why: 'take-profit: +5c' }] }),
    L('order_new', '2026-10-22T10:01:00.100Z', { clientOrderId: 'o1', decisionId: 'd1', side: 'ask', price: 0.7, purpose: 'exit' }),
    L('fill', '2026-10-22T10:01:01.000Z', { fill: { ticker: 'KXBTC15M-X', count: 4, price: 0.7, side: 'ask' }, fee: 0.05, clientOrderId: 'o1' }),
    L('decision', '2026-10-22T10:02:00.000Z', { decisionId: 'd2', place: [{ purpose: 'exit', side: 'ask', price: 0.65, why: 'bid 0.65 - fee > q 0.600 + 0.02' }] }),
    L('order_new', '2026-10-22T10:02:00.100Z', { clientOrderId: 'o2', decisionId: 'd2', side: 'ask', price: 0.65, purpose: 'exit' }),
    L('fill', '2026-10-22T10:02:01.000Z', { fill: { ticker: 'KXBTC15M-X', count: 1, price: 0.65, side: 'ask' }, fee: 0.02, clientOrderId: 'o2' }),
    L('fill', '2026-10-22T10:00:01.000Z', { fill: { ticker: 'KXBTC15M-X', count: 6, price: 0.6, side: 'bid' }, fee: 0.1, clientOrderId: 'o0' }),
    L('fill', '2026-10-22T10:00:02.000Z', { fill: { ticker: 'KXATPMATCH-Y', count: 9, price: 0.5, side: 'bid' }, fee: 0.1 }),
    L('settlement', '2026-10-22T10:15:30.000Z', { ticker: 'KXBTC15M-X', result: 'no', realized: -1.25 }),
    L('settlement', '2026-10-22T11:15:30.000Z', { ticker: 'KXATPMATCH-Y', result: 'yes', realized: 4 }),
    L('take_profit_bench', '2026-10-22T10:15:31.000Z', { event: 'scored', ticker: 'KXBTC15M-X', usd: 1.2, result: 'no', sales: 1, contracts: 4 }),
    L('take_profit_bench', '2026-10-22T10:30:31.000Z', { event: 'scored', ticker: 'KXBTC15M-W', usd: -3.5, result: 'yes', sales: 2, contracts: 9.5 }),
    L('take_profit_bench', '2026-10-22T10:30:31.000Z', { event: 'benched', reason: 'r' }),
    L('risk_reject', '2026-10-22T10:03:00.000Z', { intent: { ticker: 'KXBTC15M-X', purpose: 'quote' }, reasons: ['window risk 12.50 > 10.00 cap'] }),
    L('risk_reject', '2026-10-22T10:05:00.000Z', { intent: { ticker: 'KXBTC15M-W', purpose: 'quote' }, reasons: ['window risk 9.10 > 8.00 cap'] }),
    L('risk_reject', '2026-10-22T10:06:00.000Z', { intent: { ticker: 'KXATPMATCH-Y', purpose: 'quote' }, reasons: ['window risk 9.10 > 8.00 cap'] }),
    L('risk_reject', '2026-10-22T10:07:00.000Z', { ticker: 'KXBTC15M-X', reasons: ['exchange: insufficient balance'] }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'audit-2026-10-23.jsonl'), L('settlement', '2026-10-23T01:00:30.000Z', { ticker: 'KXETH15M-Z', result: 'yes', realized: 9 }) + '\n');
  const p = await paperFromAudit(dir, ['2026-10-22']);
  assert.equal(p.fills, 3);
  assert.equal(p.contracts, 11);
  assert.equal(p.markets, 1);
  assert.equal(p.pnl, -1.25);
  assert.deepEqual(p.exits, { 'take-profit': 4, 'model exit': 1 }, 'the model exit names its prices');
  assert.deepEqual(p.byHour, { '2026-10-22T10': -1.25 });
  assert.deepEqual(p.byPurpose, { exit: { fills: 2, contracts: 5 }, other: { fills: 1, contracts: 6 } }, 'an order the log does not name is other');
  assert.deepEqual(p.contractsByHour, { '2026-10-22T10': 11 });
  assert.deepEqual(p.extra, { train: 0, explore: 0 });
  assert.deepEqual(p.bySeries, { KXBTC15M: { markets: 1, pnl: -1.25 } });
  assert.deepEqual(p.takeProfitBench, { scored: 2, netUsd: -2.3, benchedAt: '2026-10-22T10:30:31.000Z', byMarket: {
    'KXBTC15M-X': { usd: 1.2, contracts: 4, t: Date.parse('2026-10-22T10:15:31.000Z') },
    'KXBTC15M-W': { usd: -3.5, contracts: 9.5, t: Date.parse('2026-10-22T10:30:31.000Z') },
  } });
  assert.deepEqual(p.rejected, { 'quote: window risk # > # cap': 2, 'order: exchange: insufficient balance': 1 }, 'crypto only, numbers folded');
});

test('replay check verdict: same sign and within 25% of paper', () => {
  const side = (pnl: number, contracts: number, byHour: Record<string, number>) => ({ fills: 1, contracts, fees: 0, pnl, markets: 1, exits: {}, byHour, byPurpose: {}, contractsByHour: {}, bySeries: {} });
  assert.equal(verdict(side(-90, 1000, { a: -90 }), side(-100, 1000, { a: -100 })).close, true);
  assert.equal(verdict(side(50, 1000, { a: 50 }), side(-100, 1000, { a: -100 })).close, false);
  assert.equal(verdict(side(-60, 1000, { a: -60 }), side(-100, 1000, { a: -100 })).close, false);
  assert.equal(verdict(side(-100, 300, { a: -100 }), side(-100, 1000, { a: -100 })).close, false, 'a third of the volume is not the same bot');
  assert.ok(Math.abs(corr([1, 2, 3], [2, 4, 6])! - 1) < 1e-12);
  assert.equal(corr([1, 2], [1, 2]), null);
});

test('backtest startMs: nothing before it is replayed; fills are counted per window', async () => {
  const dir = path.join(tmp(), 'rec');
  writeSyntheticRecordings(dir, { windows: 6, seed: 12, marketNoise: 0.06 });
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), STRATEGY_STYLE: 'both' });
  const all = await runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 200, { exitPolicy: 'take_profit' });
  const none = await runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 200, { exitPolicy: 'take_profit', startMs: Number.MAX_SAFE_INTEGER });
  assert.ok(all.entryEvaluations > 0);
  assert.equal(none.entryEvaluations, 0);
  assert.equal(none.fills, 0);
  assert.equal([...all.windows.values()].reduce((s, w) => s + (w.fills ?? 0), 0), all.fills);
});

test('replay check: the stretch starts at the paper bot\'s last start; paper counted inside it; settings compared by name', async () => {
  const dir = tmp();
  const L = (kind: string, ts: string, data: object) => JSON.stringify({ seq: 1, ts, kind, data });
  fs.writeFileSync(path.join(dir, 'audit-2026-10-24.jsonl'), [
    L('startup', '2026-10-24T02:00:00.000Z', { pid: 1, config: { strategy: { accuracyGate: { enabled: false } }, dataDir: '/srv/a' } }),
    L('fill', '2026-10-24T09:00:00.000Z', { fill: { ticker: 'KXBTC15M-A', count: 5, price: 0.5, side: 'bid' }, fee: 0.1, clientOrderId: 'a' }),
    L('settlement', '2026-10-24T09:15:30.000Z', { ticker: 'KXBTC15M-A', result: 'yes', realized: 2 }),
    L('startup', '2026-10-24T13:50:00.000Z', { pid: 2, config: { strategy: { accuracyGate: { enabled: true } }, dataDir: '/srv/b' } }),
    L('decision', '2026-10-24T14:00:00.000Z', { event: 'entry_diagnosis', markets: 10, quoting: 2, reasons: { 'accuracy gate: the market has called results better 600-840 s before the close': 6, 'no edge after fees': 2 } }),
    L('fill', '2026-10-24T14:01:00.000Z', { fill: { ticker: 'KXETH15M-B', count: 7, price: 0.4, side: 'bid' }, fee: 0.2, clientOrderId: 'b' }),
    L('settlement', '2026-10-24T14:15:30.000Z', { ticker: 'KXETH15M-B', result: 'no', realized: -3 }),
    L('config', '2026-10-24T15:00:00.000Z', { event: 'model_swapped', from: 'm1', to: 'm2' }),
    L('fill', '2026-10-24T18:00:00.000Z', { fill: { ticker: 'KXSOL15M-C', count: 9, price: 0.3, side: 'bid' }, fee: 0.3, clientOrderId: 'c' }),
  ].join('\n') + '\n');
  const a = await readAudit(dir, ['2026-10-24']);
  const to = Date.parse('2026-10-24T17:00:00Z');
  const from = stretchStart(a.startups.map((s) => s.t), ['2026-10-24'], to);
  assert.equal(new Date(from).toISOString(), '2026-10-24T13:50:00.000Z', 'the last start before the end');
  assert.equal(stretchStart([], ['2026-10-24'], to), Date.parse('2026-10-24T00:00:00Z'), 'no start in the days: from the first midnight');
  assert.deepEqual(replayDays(from, to), ['2026-10-24'], 'warm-up from 05:50: one recorded day');
  assert.deepEqual(replayDays(Date.parse('2026-10-24T03:00:00Z'), Date.parse('2026-10-25T01:00:00Z')), ['2026-10-23', '2026-10-24', '2026-10-25']);
  const p = paperSummary(a, from, to);
  assert.deepEqual([p.fills, p.contracts, p.markets, p.pnl], [1, 7, 1, -3], 'only what happened inside the stretch');
  assert.equal(p.gateShare, 0.6);
  assert.equal(a.modelSwaps.length, 1);
  assert.deepEqual(settingsDiffer({ strategy: { accuracyGate: { enabled: true }, x: [1] }, dataDir: '/a', port: 1 }, a.startups[1].config), ['strategy.x'], 'machine settings (paths, ports) left out');
  assert.deepEqual(settingsDiffer({ strategy: { accuracyGate: { enabled: false } } }, a.startups[1].config), ['strategy.accuracyGate.enabled']);
  // Paper's last fill in the stretch is 14:01: the diagnoses after it give the reasons it stopped (numbers folded).
  fs.appendFileSync(path.join(dir, 'audit-2026-10-24.jsonl'), [
    L('decision', '2026-10-24T15:30:00.000Z', { event: 'entry_diagnosis', markets: 10, quoting: 0, reasons: { 'daily loss limit $12.50 reached': 10 } }),
    L('decision', '2026-10-24T15:35:00.000Z', { event: 'entry_diagnosis', markets: 9, quoting: 0, reasons: { 'daily loss limit $13.10 reached': 9 } }),
  ].join('\n') + '\n');
  const q = paperSummary(await readAudit(dir, ['2026-10-24']), from, to).quiet;
  assert.equal(q.diagnoses, 2);
  assert.equal(q.lastAt, '2026-10-24T15:35:00.000Z');
  assert.deepEqual(q.reasons, { 'daily loss limit # reached': 19, quoting: 0 });
  assert.deepEqual(paperSummary(await readAudit(dir, ['2026-10-24']), from, to).quietHours['2026-10-24T15'], { 'daily loss limit # reached': 19, quoting: 0 }, 'an hour without a fill');
});

test('replay check: prices set beside the paper bot\'s decision records', async () => {
  const dir = tmp();
  const L = (kind: string, ts: string, data: object) => JSON.stringify({ seq: 1, ts, kind, data });
  const D = (ts: string, ticker: string, fv: number, pYes: number, bid: number, ask: number, position: number, features?: object) =>
    L('decision', ts, { decisionId: ts, ticker, model: 'm', tauSec: 300, fv, regime: 'in_window', pYes, ...(features ? { features } : {}), modelShift: 0, bid, ask, position, fastMove: false, place: [{ side: 'bid', price: bid, purpose: 'quote' }], cancel: [] });
  fs.writeFileSync(path.join(dir, 'audit-2026-10-24.jsonl'), [
    D('2026-10-24T09:00:00.000Z', 'KXBTC15M-A', 0.5, 0.5, 0.48, 0.52, 0),
    L('startup', '2026-10-24T13:50:00.000Z', { pid: 2, config: {} }),
    D('2026-10-24T14:00:00.000Z', 'KXBTC15M-A', 0.6, 0.65, 0.58, 0.6, 0, { bid: 0.1, imbalance: 0.3 }),
    D('2026-10-24T14:00:30.000Z', 'KXBTC15M-A', 0.62, 0.6, 0.6, 0.62, 5),
    D('2026-10-24T14:01:00.000Z', 'KXATPMATCH-B', 0.5, 0.5, 0.48, 0.52, 0),
    D('2026-10-24T14:05:00.000Z', 'KXETH15M-C', 0.4, 0.4, 0.38, 0.42, 0),
  ].join('\n') + '\n');
  const to = Date.parse('2026-10-24T17:00:00Z');
  const a = await readAudit(dir, ['2026-10-24'], { to });
  assert.deepEqual([...a.prices.keys()].sort(), ['KXBTC15M-A', 'KXETH15M-C'], 'crypto only, since the last start');
  assert.deepEqual(a.prices.get('KXBTC15M-A')!.map((r) => [r.pYes, r.fv, r.mid, r.position]), [[0.65, 0.6, 0.59, 0], [0.6, 0.62, 0.61, 5]], 'the book after the feature map, not inside it');
  assert.deepEqual(a.prices.get('KXBTC15M-A')!.map((r) => +r.pModel!.toFixed(6)), [0.6, 0.62], 'the model\'s price from its shift (0 here)');
  const from = Date.parse('2026-10-24T13:50:00Z');
  const m = priceMatcher(a.prices, from, to);
  const t0 = Date.parse('2026-10-24T14:00:00Z');
  // The replay evaluates every second; the first within a second of a record is its match.
  m.onEval({ ticker: 'KXBTC15M-A', now: t0 - 1500, pYes: 0.9, fv: 0.9, bid: 0.1, ask: 0.2, position: 0 });
  m.onEval({ ticker: 'KXBTC15M-A', now: t0 + 400, pYes: 0.62, fv: 0.61, bid: 0.58, ask: 0.6, position: 0 });
  m.onEval({ ticker: 'KXBTC15M-A', now: t0 + 1400, pYes: 0.62, fv: 0.61, bid: 0.58, ask: 0.6, position: 0 });
  m.onEval({ ticker: 'KXBTC15M-A', now: t0 + 30_200, pYes: 0.58, fv: 0.62, bid: 0.6, ask: 0.62, position: 3 });
  const s = m.summary();
  assert.equal(s.records, 3);
  assert.equal(s.matched, 2);
  assert.equal(s.fv, 0.005);
  assert.equal(s.price, 0.025);
  assert.equal(s.mid, 0);
  assert.equal(s.shiftPaper, 0.035);
  assert.equal(s.shiftReplay, 0.025);
  assert.equal(s.sides, 1, 'one record 2c or more off the mid');
  assert.equal(s.sameSide, 1);
  assert.equal(s.samePosition, 1);
  assert.deepEqual(s.held, { paper: 0.5, replay: 0.5, paperSize: 5, replaySize: 3 }, 'each held at one of the two records: paper 5 contracts, the replay 3');
  assert.equal(s.spotBp, null, 'records without the fair value\'s inputs');
  assert.equal(s.overlayPaper, 0.035, 'paper priced 5c and 2c off its model');
  assert.equal(s.overlayReplay, null, 'replay readings without the model\'s price');
  // With them: the index 10 bp apart, the same strike, the volatility 20% higher in the replay.
  const t1 = Date.parse('2026-10-24T15:00:00Z');
  const p2 = new Map([['KXBTC15M-D', [{ t: t1, pYes: 0.5, fv: 0.5, mid: 0.5, position: 0, spot: 100_000, strike: 100_000, sigma: 1e-4, sigmaPricing: 1.1e-4, pModel: 0.48 }]]]);
  const m2 = priceMatcher(p2, from, to);
  m2.onEval({ ticker: 'KXBTC15M-D', now: t1, pYes: 0.5, fv: 0.5, bid: 0.49, ask: 0.51, position: 0, spot: 100_100, strike: 100_000, sigma: 1.2e-4, sigmaPricing: 1.32e-4, pModel: 0.49, taVolMult: 1.1, taShift: 0.01, ruleShift: 0 });
  const s2 = m2.summary();
  assert.deepEqual([s2.spotBp, s2.strikeDiffers, s2.sigmaRatio, s2.sigmaPricingRatio], [10, 0, 1.2, 1.2]);
  assert.deepEqual([s2.pricedPaper, s2.pricedReplay, s2.taVolMult], [1.1, 1.1, 1.1], 'the volatility priced with over the EWMA, each side');
  assert.deepEqual([s2.overlayPaper, s2.overlayReplay, s2.taShift, s2.ruleShift], [0.02, 0.01, 0.01, 0]);
});

test('backtest paper options: the maker buffer adapts from the maker markouts as the engine\'s does', async () => {
  const dir = path.join(tmp(), 'rec');
  writeSyntheticRecordings(dir, { windows: 4, seed: 12, marketNoise: 0.06 });
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), STRATEGY_STYLE: 'both', STRATEGY_MAKER_BUFFER: '0.02', STRATEGY_MAKER_BUFFER_RANGE: '0.015,0.03' });
  const paper = { orderFrac: 0.1, orderUsd: 0 };
  // Picked off by 5c a fill on average: the widest buffer the range allows.
  const pickedOff = await runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 200, { exitPolicy: 'take_profit', paper, makerMarkouts: Array(2000).fill(-0.05) });
  assert.equal(pickedOff.makerBufferEnd, 0.03);
  // Fewer than 30 markouts: the setting.
  const few = await runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 200, { exitPolicy: 'take_profit', makerMarkouts: Array(2000).fill(-0.05) });
  assert.equal(few.makerBufferEnd, 0.02, 'without the paper options the setting stays');
  const fresh = await runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 200, { exitPolicy: 'take_profit', paper, makerMarkouts: [0.01] });
  assert.ok(fresh.makerBufferEnd !== undefined && fresh.makerBufferEnd >= 0.015 - 1e-12 && fresh.makerBufferEnd <= 0.03 + 1e-12);
});

test('backtest paper options: paper\'s price follows the component trials; the TA network prices only once installed', async () => {
  const dir = path.join(tmp(), 'rec');
  writeSyntheticRecordings(dir, { windows: 2, seed: 7, marketNoise: 0.05 });
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) });
  // A model that moves the fair value's log-odds by 0.4.
  const model = MetaModel.fromJson(JSON.stringify({ version: 't', kind: 'gbdt', features: ['logit_fv'], referenceSigma: 5e-5, gbdt: { baseScore: 0.4, trees: [] }, residualFeature: 0 }));
  const read = async (trials: { applied(n: TrialName): boolean }) => {
    const seen: EvalReading[] = [];
    await runBacktest(dir, model, cfg.strategy, cfg.risk, 200, { paper: { orderFrac: 0.1, orderUsd: 0 }, trials, taNet: true, onEval: (e) => seen.push(e) });
    return seen;
  };
  const on = await read({ applied: (n) => n === 'mlp' });
  assert.ok(on.length > 0);
  assert.ok(on.some((e) => Math.abs(e.pYes - e.fv) > 0.01), 'the model moves the price');
  assert.ok(on.every((e) => e.pYes === e.pModel && e.taVolMult === 1 && e.taShift === 0 && e.ruleShift === 0), 'no TA network installed: no tilt, sigma as before');
  const off = await read({ applied: () => false });
  assert.ok(off.every((e) => e.pYes === e.fv), 'its trial off: paper prices at the fair value');
});

test('engine models: the TA network and the component trials\' verdicts as the bot loads them', async () => {
  const dir = tmp();
  fs.copyFileSync('params/ta_net.json', path.join(dir, 'ta_net.json'));
  const trialsFile = path.join(dir, 'component_trials.json');
  fs.writeFileSync(trialsFile, JSON.stringify({ mlp: { windows: [], state: 'off', since: 0 } }));
  const before = fs.readFileSync(trialsFile, 'utf8');
  try {
    const m = await engineModels(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), AUTO_TRAIN_DIR: dir }), { trialsFile });
    assert.ok(activeTaNet(), 'installed process-wide, as the bot does');
    assert.ok(m.used.includes('TA network (vol forecast in use)'), m.used.join(', '));
    assert.equal(m.trials?.applied('mlp'), false, 'the bot\'s verdict');
    assert.equal(m.trials?.applied('rules'), true, 'tested in paper\'s price from the start');
    assert.ok(m.used.includes('trials in paper\'s price: rules'), m.used.join(', '));
    assert.ok((JSON.parse(m.sig) as unknown[]).includes(activeTaNet()!.net.version), 'a call tape depends on the network');
    assert.equal(fs.readFileSync(trialsFile, 'utf8'), before, 'read from a copy');
  } finally { setTaNet(undefined); setTaNetEnsemble(undefined); }
});

test('backtest paper options: the paper bot\'s training trades and exploration entries', async () => {
  const dir = path.join(tmp(), 'rec');
  writeSyntheticRecordings(dir, { windows: 6, seed: 12, marketNoise: 0.06 });
  const paper = { orderFrac: 0.1, orderUsd: 0 };
  const run = (env: Record<string, string>, opts: object = { paper }) => {
    const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), STRATEGY_STYLE: 'both', ...env });
    return runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 200, { exitPolicy: 'take_profit', ...opts });
  };
  const on = await run({ PAPER_TRAINING_TRADES_PER_HOUR: '120', PAPER_EXPLORE: 'false' });
  assert.ok((on.paper?.trainTrades ?? 0) > 0, 'training trades when nothing else enters');
  assert.ok((on.paper?.trainTrades ?? 0) <= 120 * Math.ceil(on.days * 24), 'within the hourly budget');
  assert.equal(on.paper?.exploreEntries, 0);
  const off = await run({ PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false' });
  assert.equal(off.paper?.trainTrades, 0);
  const notPaper = await run({ PAPER_TRAINING_TRADES_PER_HOUR: '120' }, {});
  assert.equal(notPaper.paper?.trainTrades, 0, 'only with the paper options');
  assert.ok((on.paper?.extraSent ?? 0) > 0, 'training trades reach the exchange');
  assert.ok(!Object.keys(on.paper?.extraRejected ?? {}).some((k) => k.startsWith('no fee-net edge')), 'training trades need no edge, as in the engine');
});

test('replay check: the take-profit bench and the accuracy gate wound back to the stretch\'s start', async () => {
  const from = 1_000_000;
  const ev = (t: number, event: string) => ({ t, event });
  const state = { results: [1, -2, 3, -4, 5], since: 10, benched: { at: from + 5, reason: 'r' }, sales: [{ ts: from - 1 }, { ts: from + 1 }] };
  const b = benchAt(state, [ev(from - 5, 'scored'), ev(from + 1, 'scored'), ev(from + 2, 'benched'), ev(from + 3, 'scored')], from)!;
  assert.deepEqual(b.results, [1, -2, 3], 'the markets scored since come off the end');
  assert.equal(b.benched, undefined, 'a bench tripped since is not carried back');
  assert.deepEqual(b.sales, [{ ts: from - 1 }]);
  assert.equal(b.since, 10);
  const before = benchAt({ ...state, benched: { at: from - 5, reason: 'r' } }, [], from)!;
  assert.deepEqual(before.benched, { at: from - 5, reason: 'r' });
  assert.equal(before.results.length, 5);
  assert.equal(benchAt(state, [ev(from + 1, 'reset')], from), undefined, 'reset since: what it held before is gone');
  const g = gateAt({ rows: { 'crypto:0': [{ ts: from - 1 }, { ts: from }, { ts: from + 1 }], 'crypto:1': [{ ts: from + 9 }] } }, from);
  assert.deepEqual(g.rows, { 'crypto:0': [{ ts: from - 1 }], 'crypto:1': [] });

  // The backtester starts from such a scoreboard: a benched one sells nothing at take-profit from the first moment on.
  const dir = path.join(tmp(), 'rec');
  writeSyntheticRecordings(dir, { windows: 6, seed: 12, marketNoise: 0.06 });
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), STRATEGY_STYLE: 'both' });
  const rule = { minTrades: 1000, t: 99, maxLossUsd: 1e9, window: 50 };
  const stateFile = path.join(tmp(), 'take-profit-bench.json');
  fs.writeFileSync(stateFile, JSON.stringify({ results: [-1], since: 0, benched: { at: 0, reason: 'seeded' }, sales: [] }));
  const run = (bench: object) => runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 200, { exitPolicy: 'fair_value', paper: { orderFrac: 0.1, orderUsd: 0 }, startMs: 0, takeProfitBench: { enforce: true, rule, ...bench } });
  const fresh = await run({});
  assert.ok((fresh.paper?.takeProfitSales ?? 0) > 0, 'an empty scoreboard lets the take-profit sell');
  assert.ok((fresh.paper?.takeProfitScored ?? 0) > 0, 'its markets are scored as they settle');
  const byMarket = Object.values(fresh.paper?.takeProfitByMarket ?? {});
  assert.equal(byMarket.length, fresh.paper?.takeProfitScored, 'each scored market kept, with what its sales made');
  assert.ok(Math.abs(byMarket.reduce((a, x) => a + x.usd, 0) - (fresh.paper?.takeProfitNetUsd ?? 0)) < 1e-6);
  assert.ok(Math.abs(byMarket.reduce((a, x) => a + x.contracts, 0) - (fresh.paper?.takeProfitContracts ?? 0)) < 1e-6, 'every contract sold is scored once its market settles');
  assert.equal(fresh.paper?.takeProfitBenchedAt, undefined);
  const seeded = await run({ stateFile });
  assert.equal(seeded.paper?.takeProfitBenchedAt, 0);
  assert.equal(seeded.paper?.takeProfitSales, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).benched, { at: 0, reason: 'seeded' });
});

test('backtest: the weekly loss pause stops entries only with the override off; before tradeFromMs the replay only watches', async () => {
  const root = tmp();
  const dir = path.join(root, 'rec');
  writeSyntheticRecordings(dir, { windows: 6, seed: 12, marketNoise: 0.06 });
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), STRATEGY_STYLE: 'both' });
  const base = { exitPolicy: 'take_profit' as const, paper: { orderFrac: 0.1, orderUsd: 0 } };
  const plain = await runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 200, base);
  assert.ok(plain.fills > 0);
  const guard = path.join(root, 'equity_guard.json');
  const paused = () => fs.writeFileSync(guard, JSON.stringify({ peak: 200, reference: 200, history: [], pausedUntil: Date.UTC(2100, 0, 1) }));
  paused();
  const off = await runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 200, { ...base, equityGuardFile: guard, killOverride: false });
  assert.equal(off.fills, 0, 'paused, override off: no entry');
  paused();
  const on = await runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 200, { ...base, equityGuardFile: guard });
  assert.equal(on.fills, plain.fills, 'override on (the default): the pause does not apply');
  const watch = await runBacktest(dir, MetaModel.identity(), cfg.strategy, cfg.risk, 200, { ...base, tradeFromMs: Number.MAX_SAFE_INTEGER });
  assert.equal(watch.fills, 0);
  assert.ok(watch.entryEvaluations > 0, 'it still evaluates (books, features and the gate warm up)');
});

test('the bot\'s validation gates: monitor lets unvalidated models trade unless their book is benched', () => {
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) });
  try {
    assert.deepEqual(installProbation(cfg), [], 'no state: nothing benched');
    assert.equal(gatePasses('kalshi', false), true);
    const file = path.join(tmp(), 'probation.json');
    fs.writeFileSync(file, JSON.stringify({ kalshi: { results: [-5], since: 0, benched: { at: 1, reason: 'lost' } } }));
    assert.deepEqual(installProbation(cfg, file), ['kalshi']);
    assert.equal(gatePasses('kalshi', false), false);
    assert.equal(gatePasses('kalshi', true), true);
    assert.equal(fs.readFileSync(file, 'utf8').includes('"benched"'), true, 'the bot\'s file is only read');
    const enforce = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), VALIDATION_GATES: 'enforce' });
    assert.deepEqual(installProbation(enforce), []);
    assert.equal(gatePasses('kalshi', false), false);
  } finally {
    setProbation(undefined);
  }
});

test('replay check: the verdict over nearby replays holds their median to paper', () => {
  const side = (pnl: number, contracts: number) => ({ fills: 10, contracts, fees: 0, pnl, markets: 5, exits: {}, byHour: {}, byPurpose: {}, contractsByHour: {}, bySeries: {} });
  const paper = side(-10, 1000);
  const runs = [[-2, 900], [-9, 1000], [-30, 1100], [-11, 950], [4, 800]].map(([pnl, c], i) => ({ bankroll: 70 + i, bankrollScale: 1 + i * 0.025, replay: side(pnl, c) }));
  const v = nearbyVerdict(runs, paper);
  assert.equal(v.nearby.median, -9);
  assert.equal(v.nearby.contractsMedian, 950);
  assert.deepEqual([v.nearby.min, v.nearby.max, v.nearby.paperInside], [-30, 4, true]);
  assert.ok(v.close, 'the median, -9, is within 25% of -10 although one replay alone is not');
  assert.ok(Math.abs(v.pnlGap! - 0.1) < 1e-9);
  const off = nearbyVerdict(runs.map((r) => ({ ...r, replay: side(r.replay.pnl + 25, 1000) })), paper);
  assert.equal(off.close, false);
  assert.equal(off.nearby.paperInside, false);
  assert.ok(off.why.length > 0 && off.why.every((w) => w.startsWith('median of 5 replays')));
});

test('replay check: the luck test holds paper within 2 standard deviations of the replays, summed over the stretches', () => {
  const side = (pnl: number, contracts: number) => ({ fills: 10, contracts, fees: 0, pnl, markets: 5, exits: {}, byHour: {}, byPurpose: {}, contractsByHour: {}, bySeries: {} });
  const paper = side(-10, 1000);
  const runs = [[-2, 900], [-9, 1000], [-30, 1100], [-11, 950], [4, 800]].map(([pnl, c], i) => ({ bankroll: 70 + i, bankrollScale: 1 + i * 0.025, replay: side(pnl, c) }));
  const stretch = { from: '2026-10-24T00:00:00.000Z', to: '2026-10-24T07:00:00.000Z', hours: 7, code: 'abc1234' };
  const prices = { fv: 0.004, sameSide: 0.99 };
  const one = nearbyVerdict(runs, paper, { stretch, prices });
  assert.equal(one.nearby.test, 'luck');
  assert.ok(Math.abs(one.nearby.sd! - Math.sqrt(661.2 / 4)) < 1e-9, 'the sample standard deviation of the five replays');
  assert.deepEqual({ ...one.entry!, sd: Math.round(one.entry!.sd * 1000) / 1000 }, { ...stretch, paper: -10, median: -9, sd: 12.857, runs: 5 });
  assert.equal(one.nearby.tally!.stretches, 1);
  assert.ok(one.close, `one stretch, 1 below the median with a spread of 12.9: ${one.why.join('; ')}`);
  // Paper beat the replays by about 30 in each of two earlier stretches: alone each is luck, together they are not.
  const earlier = [
    { from: '2026-10-22T00:00:00.000Z', to: '2026-10-22T07:00:00.000Z', hours: 7, paper: 30, median: 0, sd: 10, runs: 5, code: 'abc1234' },
    { from: '2026-10-23T00:00:00.000Z', to: '2026-10-23T07:00:00.000Z', hours: 7, paper: 25, median: -5, sd: 10, runs: 5, code: 'abc1234' },
  ];
  const all = nearbyVerdict(runs, paper, { stretch, prices, history: earlier });
  assert.equal(all.nearby.tally!.stretches, 3);
  assert.equal(all.nearby.tally!.hours, 21);
  assert.deepEqual([all.nearby.tally!.paper, all.nearby.tally!.median], [45, -14]);
  assert.ok(Math.abs(all.nearby.tally!.z! - 59 / Math.sqrt(661.2 / 4 + 200)) < 1e-9);
  assert.equal(all.close, false);
  assert.ok(all.why[0].startsWith('P&L beyond luck'), all.why[0]);
  // Stretches replayed by another backtester say nothing about this one; a re-check of the same stretch replaces it.
  const other = nearbyVerdict(runs, paper, { stretch, prices, history: earlier.map((h) => ({ ...h, code: 'old0000' })) });
  assert.equal(other.nearby.tally!.stretches, 1);
  assert.ok(other.close);
  const again = nearbyVerdict(runs, paper, { stretch, prices, history: [{ ...stretch, paper: 100, median: 0, sd: 1, runs: 5 }, { ...earlier[1], from: '2026-10-23T20:00:00.000Z', to: '2026-10-24T03:00:00.000Z' }] });
  assert.equal(again.nearby.tally!.stretches, 1, 'the same hours, and hours inside an earlier check, count once');
  assert.ok(again.close);
  // The contracts and the prices still have to match.
  const thin = nearbyVerdict(runs.map((r) => ({ ...r, replay: side(r.replay.pnl, 400) })), paper, { stretch, prices });
  assert.deepEqual(thin.why.map((w) => w.split(':')[0]), ['volume off']);
  const priced = nearbyVerdict(runs, paper, { stretch, prices: { fv: 0.02, sameSide: 0.9 } });
  assert.equal(priced.why.length, 2);
  assert.ok(priced.why[0].startsWith('fair value off') && priced.why[1].startsWith('same side of the mid'));
  // Two replays give no spread: no tally entry, and the verdict falls back to the median within 25%.
  const two = nearbyVerdict(runs.slice(0, 2), paper, { stretch, prices });
  assert.equal(two.entry, undefined);
  assert.equal(two.nearby.test, 'pct');
  // Test 'pct' on request.
  assert.equal(nearbyVerdict(runs, paper, { stretch, prices, history: earlier, test: 'pct' }).close, true);
});

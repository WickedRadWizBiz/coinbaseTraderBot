import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { MetaModel } from '../bot/model/metaModel';
import { runBacktest } from '../research/backtest';
import { corr, paperFromAudit, paperSummary, readAudit, replayDays, settingsDiffer, stretchStart, verdict } from '../research/replayCheck';
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
});

test('replay check: paper side read from the audit log (crypto only, exits by kind, P&L by hour)', async () => {
  const dir = tmp();
  const L = (kind: string, ts: string, data: object) => JSON.stringify({ ts, kind, data });
  fs.writeFileSync(path.join(dir, 'audit-2026-10-22.jsonl'), [
    L('decision', '2026-10-22T10:01:00.000Z', { decisionId: 'd1', place: [{ purpose: 'exit', side: 'ask', price: 0.7, why: 'take-profit: +5c' }] }),
    L('order_new', '2026-10-22T10:01:00.100Z', { clientOrderId: 'o1', decisionId: 'd1', side: 'ask', price: 0.7, purpose: 'exit' }),
    L('fill', '2026-10-22T10:01:01.000Z', { fill: { ticker: 'KXBTC15M-X', count: 4, price: 0.7, side: 'ask' }, fee: 0.05, clientOrderId: 'o1' }),
    L('fill', '2026-10-22T10:00:01.000Z', { fill: { ticker: 'KXBTC15M-X', count: 6, price: 0.6, side: 'bid' }, fee: 0.1, clientOrderId: 'o0' }),
    L('fill', '2026-10-22T10:00:02.000Z', { fill: { ticker: 'KXATPMATCH-Y', count: 9, price: 0.5, side: 'bid' }, fee: 0.1 }),
    L('settlement', '2026-10-22T10:15:30.000Z', { ticker: 'KXBTC15M-X', result: 'no', realized: -1.25 }),
    L('settlement', '2026-10-22T11:15:30.000Z', { ticker: 'KXATPMATCH-Y', result: 'yes', realized: 4 }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'audit-2026-10-23.jsonl'), L('settlement', '2026-10-23T01:00:30.000Z', { ticker: 'KXETH15M-Z', result: 'yes', realized: 9 }) + '\n');
  const p = await paperFromAudit(dir, ['2026-10-22']);
  assert.equal(p.fills, 2);
  assert.equal(p.contracts, 10);
  assert.equal(p.markets, 1);
  assert.equal(p.pnl, -1.25);
  assert.deepEqual(p.exits, { 'take-profit': 4 });
  assert.deepEqual(p.byHour, { '2026-10-22T10': -1.25 });
});

test('replay check verdict: same sign and within 25% of paper', () => {
  const side = (pnl: number, contracts: number, byHour: Record<string, number>) => ({ fills: 1, contracts, fees: 0, pnl, markets: 1, exits: {}, byHour });
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
});

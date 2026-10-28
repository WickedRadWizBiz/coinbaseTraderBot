import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { ExitBenches, TakeProfitBench, scoredExitKind, type TakeProfitBenchEvent } from '../bot/strategy/takeProfitBench';

const RULE = { minTrades: 30, t: 2, maxLossUsd: 25, window: 200 };
const T0 = 1_761_000_000_000;

test('take-profit bench: a market\'s sales are one result, what they made against holding to settlement', () => {
  const b = new TakeProfitBench(true, RULE, undefined, undefined, T0);
  // YES sold at 0.70 and 0.72 paying 1c a contract; the market settled YES, so holding paid $1 a contract.
  b.filled('KXBTC15M-A', 1, 0.70, 10, 0.01, T0);
  b.filled('KXBTC15M-A', 1, 0.72, 5, 0.01, T0 + 1000);
  // NO sold at 0.60 (YES bought back at 0.40); the market settled YES, so the NO held would have paid nothing.
  b.filled('KXETH15M-B', -1, 0.60, 4, 0.01, T0);
  assert.equal(b.status().pending, 3);
  b.settled('KXBTC15M-A', 'yes', T0 + 900_000);
  b.settled('KXETH15M-B', 'yes', T0 + 900_000);
  b.settled('KXSOL15M-C', 'no', T0 + 900_000);
  const s = b.status();
  // (0.69 - 1) x 10 + (0.71 - 1) x 5 = -4.55 in one result; (0.59 - 0) x 4 = +2.36; a market without sales scores nothing.
  assert.deepEqual([s.scored, s.netUsd, s.pending, s.benched, s.wouldBench], [2, -2.19, 0, null, null]);
  assert.equal(b.benched, undefined);
});

test('take-profit bench: benched at the $25 net cost or once losing beyond luck after 30 markets; scored only when not enforced', () => {
  const events: TakeProfitBenchEvent[] = [];
  const b = new TakeProfitBench(true, RULE, undefined, (e) => events.push(e), T0);
  // Each market: 10 YES sold at 0.80 net that settled YES, $2 less than holding.
  for (let i = 0; i < 12; i++) { b.filled(`M${i}`, 1, 0.81, 10, 0.01, T0 + i); b.settled(`M${i}`, 'yes', T0 + i + 1); }
  assert.equal(b.benched, undefined, '-$24: not yet');
  b.filled('M12', 1, 0.81, 10, 0.01, T0 + 12);
  b.settled('M12', 'yes', T0 + 13);
  assert.equal(b.benched, 'take-profit sales cost $26.00 against holding to settlement over 13 markets (limit $25)');
  assert.deepEqual(events.filter((e) => e.event === 'benched').map((e) => e.reason), [b.benched]);
  assert.equal(events.filter((e) => e.event === 'scored').length, 13);

  // Steady small losses: under the dollar limit, benched by the t rule at the 30th market.
  const c = new TakeProfitBench(true, RULE, undefined, undefined, T0);
  for (let i = 0; i < 30; i++) {
    if (i === 29) assert.equal(c.benched, undefined, '29 markets: too few for the t rule');
    c.filled(`N${i}`, 1, i % 2 ? 0.55 : 0.75, 1, 0, T0 + i);
    c.settled(`N${i}`, 'yes', T0 + i + 1);
  }
  assert.match(c.benched!, /^take-profit sales are losing beyond luck against holding to settlement: \$-10\.50 over 30 markets, t -\d+\.\d\d$/);

  // TAKE_PROFIT_BENCH=false: the same record benches nothing; the status says what it would have called.
  const d = new TakeProfitBench(false, RULE, undefined, undefined, T0);
  for (let i = 0; i < 13; i++) { d.filled(`M${i}`, 1, 0.81, 10, 0.01, T0 + i); d.settled(`M${i}`, 'yes', T0 + i + 1); }
  assert.equal(d.benched, undefined);
  assert.deepEqual([d.status().benched, d.status().wouldBench, d.status().netUsd], [null, 'take-profit sales cost $26.00 against holding to settlement over 13 markets (limit $25)', -26]);
});

test('take-profit bench: sales and scores survive a restart; a reset lifts the bench and keeps the sales still waiting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpb-'));
  const file = path.join(dir, 'take-profit-bench.json');
  const a = new TakeProfitBench(true, RULE, file, undefined, T0);
  for (let i = 0; i < 13; i++) { a.filled(`M${i}`, 1, 0.81, 10, 0.01, T0 + i); a.settled(`M${i}`, 'yes', T0 + i + 1); }
  a.filled('OPEN', -1, 0.5, 2, 0.01, T0 + 100);
  const b = new TakeProfitBench(true, RULE, file, undefined, T0 + 1000);
  assert.match(b.benched!, /cost \$26\.00/);
  assert.deepEqual([b.status().scored, b.status().pending], [13, 1]);
  b.reset(T0 + 2000);
  assert.deepEqual([b.benched, b.status().scored, b.status().pending, b.status().since], [undefined, 0, 1, T0 + 2000]);
  // The sale waiting through the reset is scored when its market settles (NO held, settled NO: holding paid $1).
  b.settled('OPEN', 'no', T0 + 3000);
  assert.deepEqual([b.status().scored, b.status().netUsd], [1, -1.02]);
  // A sale whose market never settled is forgotten three hours on.
  b.filled('GONE', 1, 0.6, 1, 0, T0);
  b.filled('NEW', 1, 0.6, 1, 0, T0 + 3 * 3_600_000 + 1);
  assert.equal(b.status().pending, 1);
});

test('take-profit bench: on by default (TAKE_PROFIT_BENCH)', () => {
  assert.equal(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40) }).strategy.takeProfitBench, true);
  assert.equal(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), TAKE_PROFIT_BENCH: 'false' }).strategy.takeProfitBench, false);
});

test('exit benches: each scored exit kind has its own scoreboard; a settlement scores every kind; reset is per kind', () => {
  const benches = new ExitBenches((['model-exit', 'ratchet-stop'] as const).map((kind) => new TakeProfitBench(true, RULE, undefined, undefined, T0, kind)));
  assert.deepEqual(benches.kinds(), ['model-exit', 'ratchet-stop']);
  // The model exit sold YES at 0.70 and the ratchet stop the rest at 0.55, 1c fee each; the market settled YES.
  benches.filled('model-exit', 'KXBTC15M-A', 1, 0.70, 10, 0.01, T0);
  benches.filled('ratchet-stop', 'KXBTC15M-A', 1, 0.55, 10, 0.01, T0 + 1000);
  benches.settled('KXBTC15M-A', 'yes', T0 + 900_000);
  const s = benches.status();
  assert.deepEqual([s['model-exit']!.scored, s['model-exit']!.netUsd, s['ratchet-stop']!.netUsd, s['ratchet-stop']!.kind], [1, -3.1, -4.6, 'ratchet-stop']);
  assert.equal(benches.benched('take-profit'), undefined, 'a kind without a scoreboard here is never benched');
  // $25 of ratchet-stop losses bench that kind alone; a reset of that kind lifts it and leaves the other scoreboard.
  for (let i = 0; i < 5; i++) { benches.filled('ratchet-stop', `KXETH15M-${i}`, 1, 0.50, 10, 0.01, T0); benches.settled(`KXETH15M-${i}`, 'yes', T0 + 1000); }
  assert.match(benches.benched('ratchet-stop')!, /^ratchet-stop sales cost \$/);
  assert.equal(benches.benched('model-exit'), undefined);
  assert.equal(benches.reset('ratchet-stop', T0 + 2000), true);
  assert.equal(benches.benched('ratchet-stop'), undefined);
  assert.equal(benches.status()['model-exit']!.scored, 1);
  assert.equal(benches.reset('take-profit'), false);
});

test('scored exit kinds are read off the exit order\'s reason', () => {
  assert.equal(scoredExitKind('take-profit: +0.112 a contract net of fees (best +0.183, floor +0.040)'), 'take-profit');
  assert.equal(scoredExitKind('bid 0.53 - fee > q 0.400 + 0.01'), 'model-exit');
  assert.equal(scoredExitKind('NO bid 0.60 - fee > q + 0.01'), 'model-exit');
  assert.equal(scoredExitKind('confluence ratchet stop 0.62'), 'ratchet-stop');
  assert.equal(scoredExitKind('exit curve: cross 0.6 (+0.02 a contract net'), undefined);
});

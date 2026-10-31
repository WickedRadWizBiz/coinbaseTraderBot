import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { TakeProfitBench, type TakeProfitBenchEvent } from '../bot/strategy/takeProfitBench';

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

test('take-profit ladder: a $25 net cost or a loss beyond luck after 30 markets makes it one level stricter (never benched); TAKE_PROFIT_BENCH=false holds level 0', () => {
  const events: TakeProfitBenchEvent[] = [];
  const b = new TakeProfitBench(true, RULE, undefined, (e) => events.push(e), T0);
  // Each market: 10 YES sold at 0.80 net that settled YES, $2 less than holding.
  for (let i = 0; i < 12; i++) { b.filled(`M${i}`, 1, 0.81, 10, 0.01, T0 + i); b.settled(`M${i}`, 'yes', T0 + i + 1); }
  assert.equal(b.level, 0, '-$24: not yet');
  b.filled('M12', 1, 0.81, 10, 0.01, T0 + 12);
  b.settled('M12', 'yes', T0 + 13);
  assert.deepEqual([b.level, b.benched, b.status().benched, b.status().scored], [1, undefined, null, 0]);
  const step = events.find((e) => e.event === 'stricter')!;
  assert.deepEqual([step.level, step.from, step.reason], [1, 0, 'take-profit sales (against holding to settlement) cost $26.00 over 13 results (limit $25)']);
  assert.equal(events.filter((e) => e.event === 'scored').length, 13);

  // Steady small losses: under the dollar limit, the t rule steps it at the 30th market.
  const c = new TakeProfitBench(true, RULE, undefined, undefined, T0);
  for (let i = 0; i < 30; i++) {
    if (i === 29) assert.equal(c.level, 0, '29 markets: too few for the t rule');
    c.filled(`N${i}`, 1, i % 2 ? 0.55 : 0.75, 1, 0, T0 + i);
    c.settled(`N${i}`, 'yes', T0 + i + 1);
  }
  assert.equal(c.level, 1);
  // 30 winning markets at level 1 step it back down.
  for (let i = 0; i < 30; i++) { c.filled(`W${i}`, 1, 0.5, 1, 0, T0 + 100 + i); c.settled(`W${i}`, 'no', T0 + 101 + i); }
  assert.equal(c.level, 0);
  // Capped at TP_LEVEL_MAX.
  const capped = new TakeProfitBench(true, RULE, undefined, undefined, T0, { max: 1 });
  for (let i = 0; i < 26; i++) { capped.filled(`C${i}`, 1, 0.81, 10, 0.01, T0 + i); capped.settled(`C${i}`, 'yes', T0 + i + 1); }
  assert.equal(capped.level, 1);

  // TAKE_PROFIT_BENCH=false: level 0 whatever the record; the status says what the old rule would have called.
  const d = new TakeProfitBench(false, RULE, undefined, undefined, T0);
  for (let i = 0; i < 13; i++) { d.filled(`M${i}`, 1, 0.81, 10, 0.01, T0 + i); d.settled(`M${i}`, 'yes', T0 + i + 1); }
  assert.deepEqual([d.level, d.status().levelPinned, d.status().wouldBench, d.status().netUsd], [0, true, 'take-profit sales (against holding to settlement) cost $26.00 over 13 results (limit $25)', -26]);
  // TP_LEVEL pins a level either way.
  assert.equal(new TakeProfitBench(true, RULE, undefined, undefined, T0, { pinned: 2 }).level, 2);
});

test('take-profit ladder: the level and the sales survive a restart; a reset goes back to level 0 and keeps the sales still waiting; an old bench comes back as level 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpb-'));
  const file = path.join(dir, 'take-profit-bench.json');
  const a = new TakeProfitBench(true, RULE, file, undefined, T0);
  for (let i = 0; i < 13; i++) { a.filled(`M${i}`, 1, 0.81, 10, 0.01, T0 + i); a.settled(`M${i}`, 'yes', T0 + i + 1); }
  a.filled('OPEN', -1, 0.5, 2, 0.01, T0 + 100);
  const b = new TakeProfitBench(true, RULE, file, undefined, T0 + 1000);
  assert.deepEqual([b.level, b.status().scored, b.status().pending], [1, 0, 1]);
  b.reset(T0 + 2000);
  assert.deepEqual([b.level, b.status().scored, b.status().pending, b.status().since], [0, 0, 1, T0 + 2000]);
  // The sale waiting through the reset is scored when its market settles (NO held, settled NO: holding paid $1).
  b.settled('OPEN', 'no', T0 + 3000);
  assert.deepEqual([b.status().scored, b.status().netUsd], [1, -1.02]);
  // A sale whose market never settled is forgotten three hours on.
  b.filled('GONE', 1, 0.6, 1, 0, T0);
  b.filled('NEW', 1, 0.6, 1, 0, T0 + 3 * 3_600_000 + 1);
  assert.equal(b.status().pending, 1);
  // A file benched before the ladder (Oct 25-31 in paper): level 1, a fresh window, the sales kept.
  fs.writeFileSync(file, JSON.stringify({ results: [-5, -6], since: T0, benched: { at: T0, reason: 'old bench' }, sales: [{ ticker: 'X', sign: 1, exitNet: 0.7, count: 1, ts: T0 }] }));
  const old = new TakeProfitBench(true, RULE, file, undefined, T0 + 10);
  assert.deepEqual([old.level, old.benched, old.status().scored, old.status().pending], [1, undefined, 0, 1]);
});

test('take-profit bench: on by default (TAKE_PROFIT_BENCH)', () => {
  assert.equal(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40) }).strategy.takeProfitBench, true);
  assert.equal(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), TAKE_PROFIT_BENCH: 'false' }).strategy.takeProfitBench, false);
});

import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { applyTakeGate } from '../bot/model/takeModel';
import { gatePasses, Probation, probationTakeAdd, setProbation, DEFAULT_PROBATION } from '../bot/risk/probation';
import { minScoreFor } from '../bot/setups/lanes';
import { tmpDir } from './helpers';

test('defaults: unvalidated models trade on probation, and contracts exit on the ratchet', () => {
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) });
  assert.equal(cfg.probation.mode, 'monitor');
  assert.equal(cfg.strategy.exitPolicy, 'confluence_ratchet');
  assert.equal(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), VALIDATION_GATES: 'enforce', EXIT_POLICY: 'hold' }).probation.mode, 'enforce');
});

test('a book losing beyond luck, or past the loss limit, moves one level stricter (never benched); a winning window steps it back; a reset starts at 0', () => {
  const steps: string[] = [];
  const file = path.join(tmpDir(), 'probation.json');
  const p = new Probation({ ...DEFAULT_PROBATION, minTrades: 10, maxLossUsd: 50 }, file, (b, _r, m) => steps.push(`${b} ${m.event} ${m.level}`));
  assert.ok(p.open('kalshi') && p.passes('kalshi', false));
  // Noisy but positive: stays at level 0.
  for (let i = 0; i < 30; i++) p.record('kalshi', i % 2 ? 1.2 : -1);
  assert.equal(p.level('kalshi'), 0);
  // Steady losses: t well below -1 after the minimum count: level 1, still open.
  for (let i = 0; i < 12; i++) p.record('setups', i % 3 ? -0.8 : 0.3);
  assert.deepEqual([p.level('setups'), p.open('setups'), p.status().setups.benched, p.status().setups.trades], [1, true, null, 2]);
  assert.deepEqual(steps, ['setups stricter 1']);
  // One big loss: the loss limit, before the minimum count.
  p.record('perps', -60);
  assert.equal(p.level('perps'), 1);
  // Ten winning results at level 1 step it back.
  for (let i = 0; i < 10; i++) p.record('perps', 1);
  assert.equal(p.level('perps'), 0);
  assert.deepEqual(steps, ['setups stricter 1', 'perps stricter 1', 'perps looser 0']);
  // Persisted across a restart.
  const again = new Probation({ ...DEFAULT_PROBATION, minTrades: 10, maxLossUsd: 50 }, file);
  assert.equal(again.level('setups'), 1);
  again.reset('setups');
  assert.deepEqual([again.level('setups'), again.status().setups.trades], [0, 0]);
  // A bench saved before the ladder: level 1, a fresh window, open.
  fs.writeFileSync(file, JSON.stringify({ kalshi: { results: [-5, -6], since: 0, benched: { at: 1, reason: 'old' } } }));
  const old = new Probation(DEFAULT_PROBATION, file);
  assert.deepEqual([old.level('kalshi'), old.open('kalshi'), old.status().kalshi.trades], [1, true, 0]);
  // Enforce: nothing unvalidated passes, nothing is recorded.
  const off = new Probation({ ...DEFAULT_PROBATION, mode: 'enforce' });
  assert.equal(off.passes('kalshi', false), false);
  off.record('kalshi', -100);
  assert.equal(off.status().kalshi.trades, 0);
  assert.ok(fs.existsSync(file));
});

test('the gates open for unvalidated models on probation; each level widens the unvalidated take model\'s margin', () => {
  const take = { validation: { validated: false } } as never;
  const plan = () => ({ place: [{ side: 'bid', price: 0.5, count: 1, postOnly: false, reduceOnly: false, purpose: 'enter', edge: 0, why: '' }] as never[], notes: [] as string[] });
  const ctx = { pYes: 0.5, features: {}, tauSec: 300, bid: 0.49, ask: 0.51, margin: 0 };
  try {
    setProbation(undefined);
    assert.equal(gatePasses('kalshi', false), false, 'no probation (tests, research): the gates as before');
    const p = new Probation();
    setProbation(p);
    assert.equal(gatePasses('kalshi', false), true);
    // The unvalidated take head now judges entries (a malformed head throws: it was consulted).
    assert.throws(() => applyTakeGate(plan(), take, ctx));
    for (let i = 0; i < 25; i++) p.record('kalshi', -1);
    assert.deepEqual([gatePasses('kalshi', false), p.level('kalshi'), probationTakeAdd('kalshi')], [true, 1, 0.02], 'graded: still consulted, asked for 2c more');
    assert.throws(() => applyTakeGate(plan(), take, ctx));
  } finally { setProbation(undefined); }
  // Setup types the model has not proven: traded at the lane's minimum score only while set.
  const L = { maxPositions: 1, riskFrac: 0.01, ttlBars: 1, minScore: 0.8, refScore: 0.5, maxChaseR: 0.3, minScoreByKind: { '1h burst': 0.7 } };
  assert.equal(minScoreFor(L, { tf: '15m', kind: 'burst' }), undefined);
  assert.equal(minScoreFor({ ...L, unlistedMinScore: 0 }, { tf: '15m', kind: 'burst' }), 0);
  assert.equal(minScoreFor({ ...L, unlistedMinScore: 0 }, { tf: '1h', kind: 'burst' }), 0.7);
});

test('the loss limit follows the account: the smaller of $25 and 15% of the book\'s break-even, applied at start too', () => {
  assert.deepEqual([DEFAULT_PROBATION.maxLossUsd, DEFAULT_PROBATION.maxLossPct], [25, 0.15]);
  assert.equal(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) }).probation.maxLossPct, 0.15);
  const file = path.join(tmpDir(), 'probation.json');
  const p = new Probation(DEFAULT_PROBATION, file);
  // A $41.20 live account: 13 settled markets losing $14.51 (the live book on Oct 22), under the old $25 limit.
  for (let i = 0; i < 13; i++) p.record('kalshi', i === 0 ? -2.51 : -1);
  assert.ok(p.open('kalshi'), 'no break-even known yet: $25');
  assert.equal(p.status().kalshi.maxLossUsd, 25);
  // At the next start the break-even is known: 15% of $41.20 is $6.18, and the book is past it.
  const stepped: string[] = [];
  const again = new Probation(DEFAULT_PROBATION, file, (b, reason) => stepped.push(`${b}: ${reason}`));
  again.setBreakEven((book) => (book === 'perps' || book === 'setups' ? 100 : 41.2));
  assert.equal(again.status().kalshi.maxLossUsd, 6.18);
  assert.equal(again.status().perps.maxLossUsd, 15, '15% of a $100 perps account');
  assert.equal(again.level('kalshi'), 0, 'not judged before the review');
  again.review();
  assert.equal(again.level('kalshi'), 1);
  assert.ok(again.open('kalshi'), 'graded, never benched');
  assert.equal(stepped.length, 1);
  assert.match(stepped[0], /^kalshi: net loss \$14\.51 over 13 results reached PROBATION_MAX_LOSS_PCT \(15% of the \$41\.20 break-even: \$6\.18\)/);
  assert.ok(again.level('tennis') === 0 && again.level('perps') === 0, 'books within their limit stay at level 0');
  // A big account keeps the dollar limit: 15% of $400 is $60, so $25 applies.
  const big = new Probation(DEFAULT_PROBATION);
  big.setBreakEven(() => 400);
  assert.equal(big.status().kalshi.maxLossUsd, 25);
  // PROBATION_MAX_LOSS_PCT=0: the dollar limit alone.
  const usdOnly = new Probation({ ...DEFAULT_PROBATION, maxLossPct: 0 });
  usdOnly.setBreakEven(() => 41.2);
  assert.equal(usdOnly.status().kalshi.maxLossUsd, 25);
});

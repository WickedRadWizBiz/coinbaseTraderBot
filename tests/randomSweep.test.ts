import assert from 'node:assert/strict';
import { test } from 'node:test';
import { report, sampleDays, sampleRanking, scoreOf, SPACE, splitDays, stage1Trials, stage2Trials, trialId, type Scope, type TrialResult } from '../research/randomSweep';

const days = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
const trial = (env: Record<string, string>, perDay: (i: number) => number, scope: Scope = 'all'): TrialResult => {
  const byDay: Record<string, number> = {}, byHour: Record<string, number> = {}, tradesByDay: Record<string, number> = {};
  days.forEach((d, i) => { const v = perDay(i); byDay[d] = v; byHour[`${d}T12`] = v; tradesByDay[d] = 10; });
  return { id: trialId(env), stage: 1, scope, env, ok: true, ms: 1, pnl: Object.values(byDay).reduce((a, v) => a + v, 0), fees: 0, contracts: 0, fills: 0, trades: days.length * 10, byDay, tradesByDay, byHour };
};

test('random sweep: stage 1 starts from today, then the evidence trials, then distinct random draws within the space', () => {
  const t = stage1Trials(50, 3);
  assert.equal(t.length, 50);
  assert.deepEqual(t[0], {});
  assert.equal(new Set(t.map(trialId)).size, 50);
  for (const e of t.slice(10)) for (const d of SPACE) assert.ok(d.values.includes(e[d.env]), d.env);
  assert.deepEqual(stage1Trials(50, 3), t, 'the same seed draws the same trials (shards agree)');
  assert.ok(SPACE.every((d) => d.env !== 'PAPER_ORDER_FRAC'), 'order size is not swept');
});

test('random sweep: stage 2 moves one to three settings one step from each of the best, never repeating a trial', () => {
  const best = stage1Trials(12, 5).slice(8);
  const tried = new Set(stage1Trials(12, 5).map(trialId));
  const near = stage2Trials(best, 5, 2, tried);
  assert.equal(near.length, 20);
  for (const n of near) assert.ok(!tried.has(trialId(n)));
});

test('random sweep: the sample is spread over the tune days and never reaches the holdout', () => {
  const { tune, holdout } = splitDays(days);
  assert.equal(tune.length, 28); assert.equal(holdout.length, 12);
  const s = sampleDays(tune, 7);
  assert.equal(s.length, 7);
  assert.equal(new Set(s).size, 7);
  assert.ok(s.every((d) => tune.includes(d)));
  assert.deepEqual(sampleDays(tune, 100), tune);
});

test('random sweep: finalists ranked on the tune days, the best judged once on the holdout, overfitting rules applied', () => {
  const { holdout } = splitDays(days);
  const base = trial({}, () => -1);
  // A steady winner everywhere, and a lucky one: great on the tune days, losing afterwards.
  const steady = trial({ EXIT_POLICY: 'hold' }, (i) => 2 + (i % 3) * 0.1);
  const lucky = trial({ STRATEGY_STYLE: 'maker' }, (i) => (i < 28 ? 5 + (i % 2) : -3));
  const r = report([base, steady, lucky], days, 10);
  assert.equal(r.chosen?.id, lucky.id, 'the tune days pick the lucky one');
  assert.equal(r.accepted, false);
  assert.ok(r.why.some((w) => /holdout/.test(w)));
  assert.deepEqual(r.envLines, []);
  const s = scoreOf(steady, holdout);
  assert.ok(s.perHour > 0 && s.maxDd === 0);
  const r2 = report([base, steady], days, 10);
  assert.equal(r2.chosen?.id, steady.id);
  assert.ok(r2.chosen!.holdout.pnl > 0);
  // Without stage 3 there is no verdict, only the search's ranking.
  const r3 = report([trial({}, () => -1, 'sample'), trial({ EXIT_POLICY: 'hold' }, () => 1, 'sample')], days, 10);
  assert.equal(r3.chosen, null);
  assert.equal(r3.sampleTop[0].env.EXIT_POLICY, 'hold');
  assert.ok(r3.why.some((w) => /stage 3/.test(w)));
  assert.equal(sampleRanking([trial({}, () => 1, 'all')], days).length, 0, 'the ranking reads the sample results only');
});

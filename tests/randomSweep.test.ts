import assert from 'node:assert/strict';
import { test } from 'node:test';
import { report, scoreOf, SPACE, stage1Trials, stage2Trials, splitDays, trialId, type TrialResult } from '../research/randomSweep';

const trial = (env: Record<string, string>, perDay: (i: number) => number, days: string[]): TrialResult => {
  const byDay: Record<string, number> = {}, byHour: Record<string, number> = {}, tradesByDay: Record<string, number> = {};
  days.forEach((d, i) => { const v = perDay(i); byDay[d] = v; byHour[`${d}T12`] = v; tradesByDay[d] = 10; });
  return { id: trialId(env), stage: 1, env, ok: true, ms: 1, pnl: Object.values(byDay).reduce((a, v) => a + v, 0), fees: 0, contracts: 0, fills: 0, trades: days.length * 10, byDay, tradesByDay, byHour };
};
const days = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));

test('random sweep: stage 1 starts from today, then the evidence trials, then distinct random draws within the space', () => {
  const t = stage1Trials(50, 3);
  assert.equal(t.length, 50);
  assert.deepEqual(t[0], {});
  assert.equal(new Set(t.map(trialId)).size, 50);
  for (const e of t.slice(10)) for (const d of SPACE) assert.ok(d.values.includes(e[d.env]), d.env);
  assert.deepEqual(stage1Trials(50, 3), t, 'the same seed draws the same trials (shards agree)');
  assert.ok(SPACE.every((d) => d.env !== 'PAPER_ORDER_FRAC'), 'order size is not swept');
});

test('random sweep: stage 2 moves one to three settings one step from each of the best', () => {
  const best = stage1Trials(12, 5).slice(8);
  const near = stage2Trials(best, 5, 2);
  assert.equal(near.length, 20);
  for (const n of near) assert.ok(!best.some((b) => trialId(b) === trialId(n)));
});

test('random sweep: ranked on the tune days, judged once on the holdout, overfitting rules applied', () => {
  const { tune, holdout } = splitDays(days);
  assert.equal(tune.length, 28); assert.equal(holdout.length, 12);
  const base = trial({}, () => -1, days);
  // A steady winner everywhere, and a lucky one: great on the tune days, losing afterwards.
  const steady = trial({ EXIT_POLICY: 'hold' }, (i) => 2 + (i % 3) * 0.1, days);
  const lucky = trial({ STRATEGY_STYLE: 'maker' }, (i) => (i < 28 ? 5 + (i % 2) : -3), days);
  const r = report([base, steady, lucky], days);
  assert.equal(r.chosen?.id, lucky.id, 'the tune days pick the lucky one');
  assert.equal(r.accepted, false);
  assert.ok(r.why.some((w) => /holdout/.test(w)));
  assert.deepEqual(r.envLines, []);
  const s = scoreOf(steady, holdout);
  assert.ok(s.perHour > 0 && s.maxDd === 0);
  const r2 = report([base, steady], days);
  assert.equal(r2.chosen?.id, steady.id);
  assert.ok(r2.chosen!.holdout.pnl > 0);
});

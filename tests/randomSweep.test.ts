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

test('random sweep: a proposal also needs a close replay check, and to make money on the recorded days and beat today\'s there', () => {
  const hold = { EXIT_POLICY: 'hold' }, steady = (i: number) => 2 + (i % 3) * 0.1;
  const search = [trial({}, () => -1, 'sample'), trial(hold, steady, 'sample'), trial({ STRATEGY_STYLE: 'maker' }, (i) => (i % 2 ? 1 : -1.5), 'sample'), trial({ STRATEGY_MIN_EDGE: '0.05' }, (i) => (i % 3 ? 0.5 : -1), 'sample')];
  const finals = [trial({}, () => -1), trial(hold, steady)];
  const close = { close: true, why: [] };
  const free = report([...search, ...finals], days, 20);
  assert.equal(free.accepted, true, free.why.join('; '));
  // The sweeps of Oct 25: the history replay's winner lost on the recorded day as today's settings did.
  const lostThere = [...search, ...finals, trial({}, () => -0.1, 'recorded'), trial(hold, () => -0.09, 'recorded')];
  const r1 = report(lostThere, days, 20, { replayCheck: close, recorded: true });
  assert.equal(r1.accepted, false);
  assert.ok(r1.why.some((w) => /loses on the recorded days/.test(w)), r1.why.join('; '));
  assert.deepEqual(r1.envLines, []);
  const behind = report([...search, ...finals, trial({}, () => 0.2, 'recorded'), trial(hold, () => 0.1, 'recorded')], days, 20, { replayCheck: close, recorded: true });
  assert.ok(behind.why.some((w) => /not better than today's settings on the recorded days/.test(w)), behind.why.join('; '));
  const ok = [...search, ...finals, trial({}, () => -0.1, 'recorded'), trial(hold, () => 0.1, 'recorded')];
  const r2 = report(ok, days, 20, { replayCheck: { close: false, why: ['P&L beyond luck'] }, recorded: true });
  assert.deepEqual(r2.why, ['the replay check is not close (P&L beyond luck)']);
  assert.deepEqual(report(ok, days, 20, { replayCheck: null, recorded: true }).why, ['no replay check verdict yet']);
  assert.ok(report([...search, ...finals], days, 20, { replayCheck: close, recorded: true }).why.some((w) => /stage 4/.test(w)));
  const r3 = report(ok, days, 20, { replayCheck: close, recorded: true });
  assert.equal(r3.accepted, true, r3.why.join('; '));
  assert.deepEqual(r3.envLines, ['EXIT_POLICY=hold']);
  assert.deepEqual(r3.replayCheck, close);
});

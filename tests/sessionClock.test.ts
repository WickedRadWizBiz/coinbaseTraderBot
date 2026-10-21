// The training session's clock: the networks' part, the decision models' part, and the steps and tournaments that
// stop on it (research/sessionClock.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { runPbt, walkForwardRounds } from '../research/pbt';
import { runPipeline } from '../research/pipeline';
import { capHours, enterDecisionPhase, resetSession, sessionActive, sessionLeftMs, sessionTimeUp, startSession } from '../research/sessionClock';
import { TRAINER_PAGE } from '../research/trainerUiPage';
import { tmpDir } from './helpers';

const MIN = 60_000, DAY = 86_400_000;

test('session clock: the networks get the first 70%, the decision models the rest; budgets are capped to it', () => {
  resetSession();
  assert.equal(sessionTimeUp(), false, 'no clock: never up');
  assert.equal(capHours(2), 2, 'no clock: budgets as they are');
  assert.equal(sessionLeftMs(), Infinity);
  const t = 1_000_000;
  startSession(60, 0.3, t);
  assert.equal(sessionActive(), true);
  startSession(5, 0.3, t + MIN);
  assert.equal(sessionTimeUp(t + 41 * MIN), false, 'a second start is ignored');
  assert.equal(sessionTimeUp(t + 42 * MIN), true, "the networks' part ends 18 minutes before the session");
  assert.ok(Math.abs(capHours(2, t) - 0.7) < 1e-9, "a sweep's 2 hours capped at the networks' 42 minutes");
  assert.equal(capHours(2, t + 50 * MIN), 1 / 60, 'at least a minute');
  enterDecisionPhase();
  assert.equal(sessionTimeUp(t + 42 * MIN), false, "the decision models' phase runs to the session's end");
  assert.equal(sessionTimeUp(t + 60 * MIN), true);
  resetSession();
  assert.equal(sessionActive(), false);
});

test('session clock: a tournament stops before its next round and the next call carries on', async () => {
  const rounds = walkForwardRounds(0, 10 * DAY, 2 * DAY, DAY, DAY);
  const spec = { target: { min: 0.1, max: 10 } };
  const hooks = {
    init: () => ({ x: 0 }),
    clone: (s: { x: number }) => ({ x: s.x }),
    train: (s: { x: number }, h: Record<string, number>) => { s.x += 0.5 * (h.target - s.x); return s; },
    evaluate: (s: { x: number }, _h: Record<string, number>, r: { evalFrom: number }) => {
      const fit = -Math.abs(s.x - 3);
      return { report: { fitness: fit, sortino: fit, maxDrawdown: 0, costs: 0, netReturn: 0, interactions: 1, independent: 1, days: 1 }, interactions: [{ ts: r.evalFrom, ret: fit, cost: 0 }] };
    },
  };
  let played = 0;
  const first = await runPbt({ base: { target: 1 }, spec, rounds, hooks, seed: 5, exploreAfterLast: true, onRound: () => { played++; }, stop: () => played >= 3 });
  assert.equal(first.ran, 3, 'three rounds, then the time was up');
  assert.equal(first.log.length, 3);
  const rest = await runPbt({ base: { target: 1 }, spec, rounds: rounds.slice(first.ran), hooks, seed: 5, resume: { members: first.members, trials: first.trials, log: first.log } });
  assert.equal(rest.ran, rounds.length - 3);
  assert.equal(rest.log.length, rounds.length, 'every round played once over the two calls');
});

test("session clock: once a part is used up its steps wait for the next session (the data steps are outside it)", async (t) => {
  const dir = tmpDir();
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), DATA_DIR: dir, AUTO_TRAIN: 'off', PERP_STRATEGY: 'setups', HISTORY_AUTO_UPDATE: 'false' });
  const was = process.env.TRAIN_SESSION_MIN;
  process.env.TRAIN_SESSION_MIN = '1';
  // Every log line moves the clock a minute on: the 1-minute session's networks' part (42 s) is gone by the time the
  // first training step has started it.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const r = await runPipeline({ cfg, only: ['history', 'setup_snn', 'fill'], log: () => t.mock.timers.tick(MIN) });
    const why = (s: string) => String(r.steps.find((x) => x.step === s)?.skipped);
    assert.equal(why('history'), 'HISTORY_AUTO_UPDATE=false', 'a data step is never held back by the clock');
    assert.match(why('setup_snn'), /networks' part of the 1-minute session is used up/);
    assert.match(why('fill'), /the 1-minute session is used up: it runs next session/);
  } finally {
    t.mock.timers.reset();
    if (was === undefined) delete process.env.TRAIN_SESSION_MIN; else process.env.TRAIN_SESSION_MIN = was;
    resetSession();
  }
  // No clock: the same step runs.
  const r = await runPipeline({ cfg, only: ['setup_snn'], log: () => undefined });
  assert.equal(r.steps.find((x) => x.step === 'setup_snn')?.skipped, undefined);
});

test('session clock: the trainer window asks for a session length, 60 minutes by default', () => {
  assert.match(TRAINER_PAGE, /id="minutes" type="range" min="30" max="120" step="15" value="60"/);
  assert.doesNotMatch(TRAINER_PAGE, /0 = until it stops/);
  assert.match(TRAINER_PAGE, /hours: \(Number\(\$\('minutes'\)\.value\) \|\| 60\) \/ 60/, 'sent to the trainer in hours');
});

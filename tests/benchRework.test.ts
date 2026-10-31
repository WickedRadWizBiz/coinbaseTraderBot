import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { modelSkillWeight } from '../bot/model/modelHealth';
import { decisionProbability } from '../bot/strategy/fairValueStrategy';
import { LevelLadder, levelMargin, parseLevelMargins } from '../bot/strategy/levelLadder';

// Steven, Oct 31: "Anything benched needs to be reworked ... rather than bench them or get rid of them".

test('level ladder: stricter on a rejected window, looser after a winning one, capped, pinned levels never move', () => {
  const L = new LevelLadder({ minTrades: 3, t: 1, maxLossUsd: 5, window: 50 }, 2);
  const st = { results: [] as number[], since: 0, level: 0 };
  assert.equal(L.record(st, -6, 1, 'x')?.event, 'stricter');
  assert.deepEqual([st.level, st.results, st.since], [1, [], 1]);
  assert.equal(L.record(st, -6, 2, 'x')?.level, 2);
  assert.equal(L.record(st, -6, 3, 'x'), undefined, 'capped at 2');
  st.results = [];
  for (let i = 0; i < 2; i++) assert.equal(L.record(st, 1, 4, 'x'), undefined);
  assert.deepEqual(L.record(st, 1, 5, 'x'), { event: 'looser', level: 1, from: 2, reason: 'x made $3.00 over 3+ results at level 2' });
  const pinned = new LevelLadder({ minTrades: 3, t: 1, maxLossUsd: 5, window: 50 }, 4, 2);
  const p = { results: [] as number[], since: 0, level: 0 };
  assert.equal(pinned.record(p, -100, 1, 'x'), undefined);
  assert.equal(pinned.level(p), 2);
});

test('level margins: an unset or empty setting keeps the defaults; level 0 asks nothing; past the list, the last margin', () => {
  assert.deepEqual(parseLevelMargins(undefined, [0.06, 0.03]), [0.06, 0.03]);
  assert.deepEqual(parseLevelMargins('', [0.06, 0.03]), [0.06, 0.03]);
  assert.deepEqual(parseLevelMargins('0.05, 0.02', [0.06]), [0.05, 0.02]);
  assert.equal(levelMargin([0.06, 0.03], 0), undefined);
  assert.equal(levelMargin([0.06, 0.03], 1), 0.06);
  assert.equal(levelMargin([0.06, 0.03], 5), 0.03);
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) });
  assert.deepEqual([cfg.strategy.takeProfitFvMargins, cfg.sinuousExit.crossFvMargins], [[0.06, 0.03, 0.01, 0], [0.04, 0.02, 0.01, 0]]);
  assert.deepEqual([cfg.strategy.takeProfitLevel, cfg.sinuousExit.crossLevel, cfg.probation.levelMax], [-1, -1, 4]);
});

test('model skill weight: replaces the model-vs-market halt; leans toward the market as the evidence says the model is worse, never to 0', () => {
  const p = { on: true, min: 0.25 };
  assert.equal(modelSkillWeight({ pWorse: null }, p), 1, 'too few windows');
  assert.equal(modelSkillWeight({ pWorse: 0.7 }, p), 1, 'not leaning worse');
  assert.equal(modelSkillWeight({ pWorse: 0.25 }, p), 0.625);
  assert.ok(Math.abs(modelSkillWeight({ pWorse: 0.05 }, p) - 0.325) < 1e-9, 'the old halt point');
  assert.equal(modelSkillWeight({ pWorse: 0.05, drift: { alarm: true } }, p), 0.25, 'a drift alarm halves it, floored');
  assert.equal(modelSkillWeight({ pWorse: 0 }, { ...p, on: false }), 1, 'MODEL_SKILL=false');
  assert.equal(modelSkillWeight({ pWorse: 0.9 }, { ...p, pinned: 0.4 }), 0.4, 'MODEL_SKILL_W pins it');
  // The decision price: market + w (model - market), for either sizing.
  assert.equal(decisionProbability({ pYes: 0.7, pMarket: 0.5 }, { sizing: 'kelly', kappa: 1 }), 0.7);
  assert.ok(Math.abs(decisionProbability({ pYes: 0.7, pMarket: 0.5, modelSkillWeight: 0.5 }, { sizing: 'kelly', kappa: 1 }) - 0.6) < 1e-9);
  assert.ok(Math.abs(decisionProbability({ pYes: 0.7, pMarket: 0.5, modelSkillWeight: 0.5 }, { sizing: 'target_ev', kappa: 0.5 }) - 0.55) < 1e-9);
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) });
  assert.deepEqual([cfg.strategy.modelHealthHalt, cfg.strategy.modelSkill.on, cfg.strategy.modelSkill.min], [false, true, 0.25]);
});

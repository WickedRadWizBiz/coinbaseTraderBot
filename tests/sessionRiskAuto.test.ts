import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { loadSessionRiskFile, mergeSessionRisk, parseSessionRisk, sessionRiskFor } from '../bot/model/sessionRisk';
import { orderBudget } from '../bot/sizing/orderBudget';

test('the automatic profile sits under the hand-set one, session by session', () => {
  const auto = parseSessionRisk(JSON.stringify({ london: { sizeMult: 0.5 }, new_york: { sizeMult: 1.25 } }));
  const manual = parseSessionRisk(JSON.stringify({ new_york: { sizeMult: 0.8, minEdgeAdd: 0.01 } }));
  const m = mergeSessionRisk(auto, manual);
  assert.deepEqual(m.london, { sizeMult: 0.5 });
  assert.deepEqual(m.new_york, { sizeMult: 0.8, minEdgeAdd: 0.01 });
  assert.equal(sessionRiskFor(auto, { key: 'new_york', usOpenWindow: false } as never).sizeMult, 1.25);
});

test('session_risk.json loads, and a bad one is ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-'));
  const good = path.join(dir, 'good.json'), bad = path.join(dir, 'bad.json');
  fs.writeFileSync(good, JSON.stringify({ version: 'v1', profile: { asia: { sizeMult: 0 } }, evidence: [] }));
  fs.writeFileSync(bad, JSON.stringify({ version: 'v2', profile: { asia: { sizeMult: 3 } } }));
  assert.deepEqual(loadSessionRiskFile(good), { version: 'v1', profile: { asia: { sizeMult: 0 } } });
  assert.equal(loadSessionRiskFile(bad), undefined);
  assert.equal(loadSessionRiskFile(path.join(dir, 'none.json')), undefined);
  assert.throws(() => parseSessionRisk('{"new_york":{"sizeMult":1.6}}'));
});

test('a session that grows size grows dollars, never contracts per order', () => {
  const b = orderBudget({ bankroll: 1000, orderFrac: 0.02, sizeMult: 1.25, riskScale: 1, fCapUsd: Infinity, paperOrderUsd: 0, maxContractsPerOrder: 50 });
  assert.equal(b.maxOrderRiskUsd, 25);
  assert.equal(b.maxContracts, 50);
});

test('SESSION_RISK_AUTO is on by default', () => {
  assert.equal(loadConfig({} as NodeJS.ProcessEnv).strategy.sessionRiskAuto, true);
  assert.equal(loadConfig({ SESSION_RISK_AUTO: 'false' } as NodeJS.ProcessEnv).strategy.sessionRiskAuto, false);
});

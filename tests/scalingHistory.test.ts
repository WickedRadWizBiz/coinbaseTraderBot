import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnv, regimeGroups, reportLines } from '../research/scalingHistory';
import type { TrialResult } from '../research/randomSweep';

test('parseEnv reads K=V overrides and refuses anything else', () => {
  assert.deepEqual(parseEnv(' DYN_EDGE_FLOW=0.02  REGIME_JUMP=1 '), { DYN_EDGE_FLOW: '0.02', REGIME_JUMP: '1' });
  assert.throws(() => parseEnv('X=$(rm)'));
});

test('regimes: months, then calm / normal / wild terciles when every day has a range', () => {
  const days = Array.from({ length: 9 }, (_, i) => `2026-0${i < 5 ? 8 : 9}-1${i}`);
  const vol = Object.fromEntries(days.map((d, i) => [d, i]));
  const g = regimeGroups(days, vol);
  assert.deepEqual(g.map((x) => x.name), ['2026-08', '2026-09', 'calm days', 'normal days', 'wild days']);
  assert.deepEqual(g[2].days, days.slice(0, 3));
  assert.equal(regimeGroups(days).length, 2, 'months only without ranges');
});

test('report: paired difference against base, per regime $/h', () => {
  const mk = (name: string, byDay: Record<string, number>): TrialResult => ({ id: name, stage: 3, scope: 'all', env: {}, ok: true, ms: 0, pnl: 0, fees: 0, contracts: 0, fills: 0, trades: 1, byDay, tradesByDay: {}, byHour: {} });
  const res = new Map([['base', mk('base', { '2026-09-01': -24, '2026-09-02': 24 })], ['arm', mk('arm', { '2026-09-01': 24, '2026-09-02': 72 })]]);
  const lines = reportLines(res, ['2026-09-01', '2026-09-02'], [{ name: '2026-09', days: ['2026-09-01', '2026-09-02'] }]);
  assert.match(lines[0], /^base\s+\+0\.00\/h over 2 d \(1 up\)/);
  assert.match(lines[2], /arm\s+\+2\.00\/h over 2 d \(2 up\).*vs base \+2\.00\/h/);
  assert.match(lines[3], /2026-09 \+2\.00/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpuProfile, summarise } from '../bot/util/profile';

test('profile summary: self time per function and file from the sample stream', () => {
  const p = {
    startTime: 0, endTime: 4000,
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 } },
      { id: 2, callFrame: { functionName: 'evaluateInner', url: '', lineNumber: 10 } },
      { id: 3, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
    ],
    samples: [2, 2, 3, 2], timeDeltas: [1000, 1000, 1000, 1000],
  };
  const s = summarise(p, 4);
  assert.equal(s.topFunctions[0].fn, 'evaluateInner');
  assert.equal(s.topFunctions[0].ms, 3);
  assert.equal(s.idleShare, 0.25);
});

test('profile: a real 1 s main-thread profile runs and a second within a minute is refused', async () => {
  const r = await cpuProfile(1);
  assert.ok('topFunctions' in r, JSON.stringify(r));
  const again = await cpuProfile(1);
  assert.ok('error' in again);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stateAudit } from '../research/stateAudit';

test('state audit splits trades into thirds by each entry reading', () => {
  const trades = Array.from({ length: 12 }, (_, i) => ({ ticker: `T${i}`, closeTs: i, pnl: i < 4 ? -1 : 1, contracts: 1, kind: 'updown', mstate: { volRatio: i / 10, changeProb: null, flow: -i / 20 } }));
  const lines = stateAudit([...trades, { ticker: 'X', closeTs: 0, pnl: 5, contracts: 1, kind: 'updown' }]);
  assert.match(lines[0], /12 of 13/);
  assert.match(lines.find((l) => l.includes('vol rising'))!, /n=4 \$-4\.00 \| .* n=4 \$4\.00 \| .* n=4 \$4\.00/);
  assert.match(lines.find((l) => l.includes('change point'))!, /too few/);
  assert.match(lines.find((l) => l.includes('|taker flow|'))!, /\[0\.000\.\./);
});

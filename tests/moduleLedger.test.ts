import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLedger, ledgerLine, type LedgerInput } from '../bot/health/moduleLedger';

const base = (over: Partial<LedgerInput> = {}): LedgerInput => ({
  mode: 'paper',
  model: { id: 'mlp-1', liveBlockers: [] },
  modelHealth: { windows: 200, advantage: -0.003, pWorse: 0.01 },
  taHealth: null,
  trials: { mlp: { state: 'on', applied: true, windows: 120, advantage: 0.002, pWorse: 0.9 }, snn: { state: 'testing', applied: false, windows: 40, advantage: null, pWorse: null }, ta: { state: 'off', applied: false, windows: 300, advantage: -0.01, pWorse: 0.01 } },
  snn: { mode: 'shadow', alpha: 0 },
  taNet: { version: 'ta-7', activeHeads: 2 },
  ruleBook: { passed: 0 },
  volModel: null,
  fillModel: { validated: false, active: true },
  playbook: { enabled: false, validated: false },
  compensator: null,
  characterStandAside: true,
  accuracyGate: { enabled: true, blocked: 2, buckets: 6 },
  sessionRisk: { keys: 0 },
  sizing: { paperOrderUsd: 12.5, tier: 'normal', sizeScale: 0.8, optimalF: { cap: 0.04, trades: 90 }, portfolioKelly: true },
  exitPolicy: 'hold',
  takeProfitBench: { scored: 30, netUsd: -41.2, benched: true, enforce: true },
  probation: { kalshi: { trades: 50, netUsd: -3.1, benched: false } },
  indexAgeMs: { BTC: 800, ETH: 9_000, SOL: null },
  maxIndexAgeMs: 5_000,
  ...over,
});

const row = (rows: ReturnType<typeof buildLedger>, name: string) => {
  const r = rows.find((x) => x.module === name);
  assert.ok(r, `row ${name}`);
  return r!;
};

test('trials decide what paper prices with', () => {
  const rows = buildLedger(base());
  assert.equal(row(rows, 'meta model').state, 'on');
  assert.equal(row(rows, 'SNN').state, 'shadow');
  const ta = row(rows, 'TA network');
  assert.equal(ta.state, 'benched');
  assert.ok(ta.flags.some((f) => f.includes('worse')));
  assert.equal(ta.score?.value, -0.01);
  assert.equal(ta.score?.n, 300);
  assert.ok(row(rows, 'pricing vs market').flags[0].includes('worse than the market'));
});

test('the paper order size flags every sizing lever it bypasses', () => {
  const rows = buildLedger(base());
  for (const m of ['sizing tier', 'loss-aware size scale', 'optimal f cap', 'portfolio Kelly cap']) {
    assert.equal(row(rows, m).state, 'shadow', m);
    assert.ok(row(rows, m).flags[0].includes('$12.50'), m);
  }
  assert.ok(row(rows, 'playbook').flags[0].includes('paper order size'));
  assert.ok(row(rows, 'session risk').flags[0].includes('SESSION_RISK'));
  const live = buildLedger(base({ mode: 'live', sizing: { ...base().sizing, paperOrderUsd: 0 } }));
  assert.equal(row(live, 'sizing tier').state, 'on');
  assert.deepEqual(row(live, 'optimal f cap').flags, []);
});

test('live never follows the paper-only parts', () => {
  const rows = buildLedger(base({ mode: 'live', sizing: { ...base().sizing, paperOrderUsd: 0 } }));
  assert.equal(row(rows, 'accuracy gate').state, 'shadow');
  assert.ok(row(rows, 'meta model').flags.includes('trial result applies in paper only'));
});

test('exits, gates and feeds', () => {
  const rows = buildLedger(base({ model: { id: 'm', liveBlockers: ['Brier not better than market'] } }));
  assert.equal(row(rows, 'meta model').validated, false);
  assert.ok(row(rows, 'meta model').flags[0].includes('Brier'));
  const tp = row(rows, 'take-profit');
  assert.equal(tp.state, 'benched');
  assert.equal(tp.score?.value, -41.2);
  assert.equal(row(rows, 'accuracy gate').score?.value, 2);
  assert.equal(row(rows, 'index BTC').state, 'on');
  assert.equal(row(rows, 'index ETH').state, 'off');
  assert.equal(row(rows, 'index SOL').score?.value, null);
  assert.equal(row(rows, 'volatility forecast').state, 'off');
  assert.match(ledgerLine(tp), /dollars vs holding to settlement: -41.2 \(n=30\)/);
});

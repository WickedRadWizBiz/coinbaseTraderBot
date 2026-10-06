import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SettlementSweeper, type SweeperMarket } from '../bot/paper/settlementSweeper';

function harness(o: { paper?: Record<string, number>; oms?: Record<string, number>; cached?: Record<string, number>; market: (t: string) => SweeperMarket | undefined | Promise<SweeperMarket | undefined> }) {
  let now = 1_000_000_000_000;
  const paper = { ...(o.paper ?? {}) };
  const oms = new Map(Object.entries(o.oms ?? {}).map(([t, closeTs]) => [t, { closeTs, settled: false }]));
  const cached = { ...(o.cached ?? {}) };
  const log: { warn: Array<Record<string, unknown>>; info: Array<Record<string, unknown>>; corrected: Array<[string, number]>; calls: string[] } = { warn: [], info: [], corrected: [], calls: [] };
  const sw = new SettlementSweeper({
    paperPositions: async () => Object.entries(paper).map(([ticker, position]) => ({ ticker, position })),
    omsUnsettled: () => [...oms.entries()].filter(([, m]) => !m.settled).map(([ticker, m]) => ({ ticker, closeTs: m.closeTs })),
    getMarket: async (t) => { log.calls.push(t); return o.market(t); },
    settlePaper: (t) => { delete paper[t]; },
    settleOms: (t) => { const m = oms.get(t); if (m) m.settled = true; },
    closeTsOf: (t) => cached[t],
    correctCloseTime: (t, c) => { log.corrected.push([t, c]); cached[t] = c; },
    warn: (_m, meta) => log.warn.push(meta),
    info: (_m, meta) => log.info.push(meta),
    now: () => now,
  });
  return { sw, paper, oms, cached, log, advance: (ms: number) => { now += ms; }, get now() { return now; } };
}

test('settlement sweeper: a missed settlement message no longer leaves the position open', async () => {
  const close = 1_000_000_000_000 - 13 * 3_600_000; // closed 13 hours ago
  const h = harness({ paper: { T: -2.17 }, oms: { T: close }, market: () => ({ status: 'finalized', closeTime: close, result: 'no' }) });
  await h.sw.sweep();
  assert.deepEqual(h.paper, {});
  assert.equal(h.oms.get('T')!.settled, true);
  assert.equal(h.sw.status().awaiting.length, 0);
  assert.equal(h.sw.settledCount, 1);
});

test('settlement sweeper: settles the bot record even when the paper account already dropped it', async () => {
  const close = 1_000_000_000_000 - 3_600_000;
  const h = harness({ oms: { T: close }, market: () => ({ status: 'settled', closeTime: close, result: 'yes' }) });
  await h.sw.sweep();
  assert.equal(h.oms.get('T')!.settled, true);
});

test('settlement sweeper: a wrong (future) cached close time is corrected from Kalshi and the result is used', async () => {
  const realClose = 1_000_000_000_000 - 2 * 3_600_000;
  const wrong = 1_000_000_000_000 + 7 * 86_400_000;
  const h = harness({ paper: { T: 3 }, oms: { T: wrong }, cached: { T: wrong }, market: () => ({ status: 'determined', closeTime: realClose, result: '' }) });
  await h.sw.sweep();
  assert.deepEqual(h.log.corrected, [['T', realClose]]);
  assert.equal(h.oms.get('T')!.settled, false, 'no result yet');
  // Kalshi's close is now the one used: re-checked every minute, reported once overdue.
  assert.equal(h.sw.status().awaiting[0].minutesPastClose, 120);
  assert.equal(h.log.warn.length, 1, 'overdue (2 h past close) is reported');
});

test('settlement sweeper: pacing, overdue reports once per 30 minutes, errors kept for diagnostics', async () => {
  const close = 1_000_000_000_000 - 45 * 60_000;
  let fail = true;
  const h = harness({ paper: { T: 1 }, oms: { T: close }, market: () => { if (fail) throw new Error('HTTP 429'); return { status: 'closed', closeTime: close, result: '' }; } });
  await h.sw.sweep();
  assert.match(h.sw.status().awaiting[0].error ?? '', /429/);
  assert.equal(h.log.warn.length, 1);
  await h.sw.sweep();
  assert.equal(h.log.calls.length, 1, 'not re-queried within a minute');
  fail = false;
  h.advance(61_000);
  await h.sw.sweep();
  assert.equal(h.log.calls.length, 2);
  assert.equal(h.sw.status().awaiting[0].error, null);
  assert.equal(h.sw.status().awaiting[0].kalshiStatus, 'closed');
  assert.equal(h.log.warn.length, 1, 'no repeat warning within 30 minutes');
  h.advance(31 * 60_000);
  await h.sw.sweep();
  assert.equal(h.log.warn.length, 2);
});

test('settlement sweeper: a contract still open is only checked every 10 minutes', async () => {
  const close = 1_000_000_000_000 + 3_600_000;
  const h = harness({ paper: { T: 1 }, oms: { T: close }, cached: { T: close }, market: () => ({ status: 'active', closeTime: close, result: '' }) });
  await h.sw.sweep();
  h.advance(5 * 60_000);
  await h.sw.sweep();
  assert.equal(h.log.calls.length, 1);
  h.advance(6 * 60_000);
  await h.sw.sweep();
  assert.equal(h.log.calls.length, 2);
  assert.equal(h.log.warn.length, 0);
});

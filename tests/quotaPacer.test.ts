import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HourlyQuotaPacer, SnipeGroup, anchorAfter, anchorBefore, wallClock, wallToUtc, type PacerConfig } from '../bot/risk/quotaPacer';
import { PositionBook } from '../bot/oms/positions';

const CFG: PacerConfig = { enabled: true, group: true, hourlyUsd: 4.5, anchorHour: 10, anchorMinute: 0, tz: 'America/New_York', mode: 'cumulative', minTakeUsd: 0.75, maxTargetUsd: 6.5 };
const T = (iso: string) => Date.parse(iso);

test('the cycle anchors on 10:00 AM New York wall time, EDT and EST alike', () => {
  // Oct 29 2026 is EDT (UTC-4): 10 AM is 14:00 UTC.
  assert.equal(anchorBefore(T('2026-10-29T23:40:00Z'), CFG), T('2026-10-29T14:00:00Z'));
  assert.equal(anchorBefore(T('2026-10-30T13:59:59Z'), CFG), T('2026-10-29T14:00:00Z'), 'before 10 AM: yesterday\'s anchor');
  assert.equal(anchorBefore(T('2026-10-30T14:00:00Z'), CFG), T('2026-10-30T14:00:00Z'), 'at 10 AM: today\'s');
  // Clocks fall back Sun Nov 1 2026 at 2 AM: 10 AM EST is 15:00 UTC, and that cycle is 25 hours long.
  assert.equal(anchorAfter(T('2026-10-31T14:00:00Z'), CFG), T('2026-11-01T15:00:00Z'));
  assert.equal(anchorBefore(T('2026-11-01T20:00:00Z'), CFG), T('2026-11-01T15:00:00Z'));
  assert.equal(anchorAfter(T('2026-11-01T15:00:00Z'), CFG), T('2026-11-02T15:00:00Z'));
  // Month ends roll over.
  assert.equal(anchorBefore(T('2026-11-01T05:00:00Z'), CFG), T('2026-10-31T14:00:00Z'));
  assert.deepEqual(wallClock(T('2026-11-01T06:30:00Z'), 'America/New_York'), { y: 2026, mo: 11, d: 1, h: 1, mi: 30, s: 0 });
  assert.equal(wallToUtc({ y: 2026, mo: 7, d: 4, h: 10, mi: 0 }, 'America/New_York'), T('2026-07-04T14:00:00Z'));
  assert.equal(wallToUtc({ y: 2026, mo: 1, d: 4, h: 10, mi: 0 }, 'America/New_York'), T('2026-01-04T15:00:00Z'));
});

test('the clock: hour index, minutes left, the cumulative deficit and its clamp; ahead of pace the floor stands', () => {
  const t0 = T('2026-10-29T14:00:00Z');
  const p = new HourlyQuotaPacer(CFG, t0 + 80 * 60_000); // 11:20 AM: 20 minutes into hour #2
  let s = p.status(t0 + 80 * 60_000);
  assert.deepEqual([s.hourIndex, s.minutesIntoHour, s.minutesRemaining, s.nextHourGoalUsd, s.rawDeficitUsd, s.neededUsd, s.ahead], [2, 20, 40, 9, 9, 6.5, false]);
  assert.equal(s.linearBenchmarkUsd, 6);
  assert.equal(s.nextReset, T('2026-10-30T14:00:00Z'));
  assert.equal(p.neededUsd(t0 + 80 * 60_000), 6.5, 'a cold start never asks one position for more than the cap');
  p.record(3, t0 + 85 * 60_000);
  s = p.status(t0 + 85 * 60_000);
  assert.deepEqual([s.realized24hUsd, s.realizedHourUsd, s.rawDeficitUsd, s.neededUsd, s.ahead], [3, 3, 6, 6, false]);
  p.record(7, t0 + 90 * 60_000);
  s = p.status(t0 + 90 * 60_000);
  assert.deepEqual([s.realized24hUsd, s.rawDeficitUsd, s.neededUsd, s.ahead, s.minutesSinceProfit], [10, -1, 0.75, true, 0], 'ahead: the floor still takes a profit at once');
  // Hour #3 owes 13.50 in total: with 10 realized, 3.50.
  s = p.status(t0 + 130 * 60_000);
  assert.deepEqual([s.hourIndex, s.rawDeficitUsd, s.neededUsd, s.minutesSinceProfit], [3, 3.5, 3.5, 40]);
  // Off: no threshold.
  assert.equal(new HourlyQuotaPacer({ ...CFG, enabled: false }, t0).neededUsd(t0), undefined);
  // The rolling hour owes only this hour's target.
  const r = new HourlyQuotaPacer({ ...CFG, mode: 'rolling_hour' }, t0 + 80 * 60_000);
  r.record(3, t0 + 85 * 60_000);
  assert.deepEqual([r.status(t0 + 85 * 60_000).neededUsd, r.status(t0 + 125 * 60_000).neededUsd], [1.5, 4.5]);
});

test('the cycle rolls over at the next anchor and the 25-hour clock-change day still ends at hour #24', () => {
  const t0 = T('2026-10-31T14:00:00Z');
  const p = new HourlyQuotaPacer(CFG, t0);
  p.record(20, t0 + 3_600_000);
  assert.equal(p.status(t0 + 24.5 * 3_600_000).hourIndex, 24, 'the 25th hour of the fall-back day counts as #24');
  assert.equal(p.status(t0 + 24.5 * 3_600_000).realized24hUsd, 20);
  const s = p.status(T('2026-11-01T15:00:01Z'));
  assert.deepEqual([s.anchorStart, s.hourIndex, s.realized24hUsd, s.rawDeficitUsd, s.neededUsd], [T('2026-11-01T15:00:00Z'), 1, 0, 4.5, 4.5]);
});

test('credits: every reduction credits its realized profit net of its fee, and a settlement the remainder, summing to the book', () => {
  const t0 = T('2026-10-29T14:00:00Z');
  const p = new HourlyQuotaPacer(CFG, t0);
  const book = new PositionBook();
  const fill = (ticker: string, side: 'bid' | 'ask', count: number, price: number, fee: number, at: number) => {
    const after = book.applyFill({ ticker, side, count, price, fee });
    return p.onFill({ ticker, side, count, price }, fee, after, at);
  };
  // Long YES: buy 10 at 0.40 (fee 0.10), sell 5 at 0.50 (fee 0.05), settle YES.
  assert.equal(fill('A', 'bid', 10, 0.4, 0.1, t0 + 1000), 0, 'an entry realizes nothing');
  assert.equal(+fill('A', 'ask', 5, 0.5, 0.05, t0 + 2000).toFixed(4), 0.4, '5 x (0.50 - 0.41 cost with the fee) - 0.05');
  const a = book.settle('A', 'yes', t0 + 3000)!;
  assert.equal(+a.realized!.toFixed(4), 3.35);
  assert.equal(+p.onSettled('A', a.realized!, t0 + 3000).toFixed(4), 2.95);
  assert.equal(+p.status(t0 + 3000).realized24hUsd.toFixed(4), 3.35, 'the market credits sum to the book\'s realized P&L');
  // Long NO (YES sold at 0.60 = NO at 0.40, fee 0.10), bought back at YES 0.50 (NO 0.50, fee 0.10): +0.80, nothing left for the settlement.
  assert.equal(fill('B', 'ask', 10, 0.6, 0.1, t0 + 4000), 0);
  assert.equal(+fill('B', 'bid', 10, 0.5, 0.1, t0 + 5000).toFixed(4), 0.8);
  const b = book.settle('B', 'no', t0 + 6000)!;
  assert.equal(+b.realized!.toFixed(4), 0.8);
  assert.equal(+p.onSettled('B', b.realized!, t0 + 6000).toFixed(4), 0);
  // A losing exit credits a loss; a fill that flips the position credits only the reducing part.
  assert.equal(fill('C', 'bid', 4, 0.5, 0.04, t0 + 7000), 0);
  assert.equal(+fill('C', 'ask', 6, 0.45, 0.06, t0 + 8000).toFixed(4), +(4 * (0.45 - 0.51) - 0.04).toFixed(4));
  assert.equal(+p.status(t0 + 8000).realized24hUsd.toFixed(4), +(3.35 + 0.8 + 4 * (0.45 - 0.51) - 0.04).toFixed(4));
});

test('the group: positions each in profit after fees whose profits together cover the target are all sold', () => {
  const g = new SnipeGroup(120_000, 90_000);
  const t0 = 1_000_000;
  // A alone (+2.50) does not cover 4.50; with B (+2.20) the two do: both are to be sold, B at once and A at its next look.
  assert.deepEqual(g.judge('A', 2.5, 4.5, t0), { sell: false, sumUsd: 2.5, members: 1 });
  assert.deepEqual(g.judge('B', 2.2, 4.5, t0 + 1000), { sell: true, sumUsd: 4.7, members: 2 });
  assert.equal(g.judge('A', 2.4, 2.0, t0 + 2000).sell, true, 'A is sold on its mark even though the target fell after B\'s sale');
  // A member that is no longer in profit is not sold, and drops out of the sum.
  assert.deepEqual(g.judge('A', -0.1, 4.5, t0 + 3000), { sell: false, sumUsd: 0, members: 0 });
  assert.equal(g.judge('B', 2.2, 4.5, t0 + 4000).sell, true, 'B keeps its mark');
  // Marks expire; stale members fall out of the sum; one position never forms a group.
  assert.deepEqual(g.judge('B', 2.2, 4.5, t0 + 100_000), { sell: false, sumUsd: 2.2, members: 1 });
  assert.equal(g.judge('C', 3.0, 4.5, t0 + 101_000).sell, true, 'B (fresh 1 s ago) and C cover 4.50');
  assert.deepEqual(g.judge('C', 3.0, 4.5, t0 + 300_000), { sell: false, sumUsd: 3.0, members: 1 }, 'B went stale and the marks expired');
  assert.equal(g.judge('C', 5.0, 4.5, t0 + 301_000).sell, false, 'alone, the per-position snipe is what sells it');
  g.forget('C');
  assert.deepEqual(g.judge('D', 1.0, 0.75, t0 + 302_000), { sell: false, sumUsd: 1.0, members: 1 });
  assert.equal(g.judge('E', 1.0, undefined, t0 + 303_000).sell, false, 'no target: nothing');
  // Inside the final share of its window a position is not a member (the caller passes undefined).
  assert.deepEqual(g.judge('D', undefined, 0.75, t0 + 304_000), { sell: false, sumUsd: 0, members: 0 });
});

test('the state file resumes the running cycle after a restart and drops it after the anchor, keeping open markets\' credits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacer-'));
  const file = path.join(dir, 'quota_pacer_state.json');
  const t0 = T('2026-10-29T14:00:00Z');
  const p = new HourlyQuotaPacer(CFG, t0 + 60_000, file);
  p.record(2.5, t0 + 30 * 60_000);
  p.onFill({ ticker: 'A', side: 'ask', count: 5, price: 0.5 }, 0.05, { yes: 5, netCash: -1.5, fees: 0.15 }, t0 + 40 * 60_000);
  // Restart at 11:20 AM: 20 minutes into hour #2, the cycle's realized total intact.
  const q = new HourlyQuotaPacer(CFG, t0 + 80 * 60_000, file);
  const s = q.status(t0 + 80 * 60_000);
  assert.deepEqual([s.hourIndex, s.minutesIntoHour, +s.realized24hUsd.toFixed(4), s.rawDeficitUsd], [2, 20, 2.9, 6.1]);
  assert.equal(+q.onSettled('A', 3.35, t0 + 81 * 60_000).toFixed(4), 2.95, 'the open market\'s earlier credit survived the restart');
  // Restart after the next anchor: a fresh cycle.
  const r = new HourlyQuotaPacer(CFG, t0 + 25 * 3_600_000, file);
  assert.equal(r.status(t0 + 25 * 3_600_000).realized24hUsd, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

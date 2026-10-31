import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HourlyQuotaPacer, QuotaFloors, SnipeGroup, anchorAfter, anchorBefore, quotaCall, wallClock, wallToUtc, type PacerConfig } from '../bot/risk/quotaPacer';
import { PositionBook } from '../bot/oms/positions';
import { loadConfig } from '../bot/config';

const CFG: PacerConfig = { enabled: true, group: true, hourlyUsd: 4.5, anchorHour: 10, anchorMinute: 0, tz: 'America/New_York', mode: 'cumulative', minTakeUsd: 0.75, maxTargetUsd: 6.5, floor: 'off', trailKeep: 0.5 };
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

test('slices (Steven, Oct 30): never more than the hourly target, a deficit caught up in rolling slices, a fresh slice each hour, a loss never raising it', () => {
  const S: PacerConfig = { ...CFG, mode: 'slices' };
  const t0 = T('2026-10-29T14:00:00Z');
  // Hour #1 with nothing realized: 108 over 24 blocks is exactly the hourly target, on pace.
  let s = new HourlyQuotaPacer(S, t0 + 10 * 60_000).status(t0 + 10 * 60_000);
  assert.deepEqual([s.hourIndex, s.hoursRemaining, s.requiredPerHourUsd, s.catchUp, s.sliceGoalUsd, s.neededUsd, s.ahead], [1, 24, 4.5, false, 4.5, 4.5, true]);
  // A start at 9:31 PM (hour #12) with nothing realized: 108 over 13 blocks is 8.31 an hour, catch-up, yet one position is
  // never asked for more than 4.50 (the cumulative mode asked its 6.50 cap for the 54 owed).
  const t12 = t0 + 11 * 3_600_000 + 31 * 60_000;
  const p = new HourlyQuotaPacer(S, t12);
  s = p.status(t12);
  assert.deepEqual([s.hourIndex, s.hoursRemaining, s.requiredPerHourUsd, s.catchUp, s.sliceGoalUsd, s.neededUsd, s.ahead], [12, 13, 8.3077, true, 4.5, 4.5, false]);
  p.record(3, t12 + 60_000);
  s = p.status(t12 + 60_000);
  assert.deepEqual([s.sliceRealizedUsd, s.neededUsd], [3, 1.5], 'the running slice owes the rest of its 4.50');
  // 2 more: the slice is reached and rolls over at once with 0.50 carried; still behind, the next slice asks 4.00.
  p.record(2, t12 + 120_000);
  s = p.status(t12 + 120_000);
  assert.deepEqual([s.slicesThisHour, s.sliceRealizedUsd, s.neededUsd, s.catchUp], [1, 0.5, 4, true]);
  // A loss floors the slice at 0: the target never rises above 4.50.
  p.record(-3, t12 + 180_000);
  s = p.status(t12 + 180_000);
  assert.deepEqual([s.realized24hUsd, s.sliceRealizedUsd, s.neededUsd], [2, 0, 4.5]);
  p.record(1.2, t12 + 240_000);
  assert.equal(p.status(t12 + 240_000).neededUsd, 3.3);
  // The next clock hour starts a fresh slice: the partial 1.20 is not owed on top of it.
  s = p.status(t12 + 40 * 60_000);
  assert.deepEqual([s.hourIndex, s.slicesThisHour, s.sliceRealizedUsd, s.neededUsd], [13, 0, 0, 4.5]);
  // One big win banks several slices at once.
  p.record(10, t12 + 41 * 60_000);
  s = p.status(t12 + 41 * 60_000);
  assert.deepEqual([s.slicesThisHour, s.sliceRealizedUsd, s.neededUsd], [2, 1, 3.5]);

  // On pace (cruise): the goal is the required rate, and once a slice is banked in the hour the floor stands.
  const c = new HourlyQuotaPacer(S, t0 + 21 * 3_600_000);
  c.record(100, t0 + 21 * 3_600_000 + 60_000); // hour #22
  s = c.status(t0 + 22 * 3_600_000 + 60_000); // hour #23: 8 left over 2 blocks
  assert.deepEqual([s.hourIndex, s.requiredPerHourUsd, s.catchUp, s.sliceGoalUsd, s.slicesThisHour, s.neededUsd, s.ahead], [23, 4, false, 4, 0, 4, true]);
  c.record(4.2, t0 + 22 * 3_600_000 + 120_000);
  s = c.status(t0 + 22 * 3_600_000 + 120_000);
  assert.deepEqual([s.catchUp, s.slicesThisHour > 0, s.neededUsd], [false, true, 0.75]);
  // The day's target met: the floor.
  c.record(10, t0 + 22 * 3_600_000 + 180_000);
  assert.deepEqual([c.status(t0 + 22 * 3_600_000 + 180_000).requiredPerHourUsd, c.neededUsd(t0 + 22 * 3_600_000 + 180_000)], [0, 0.75]);

  // The state file: a restart in the same hour resumes the slice; in a later hour the cycle's total, not the partial slice.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacer-slices-'));
  const file = path.join(dir, 'quota_pacer_state.json');
  const q = new HourlyQuotaPacer(S, t12, file);
  q.record(3, t12 + 60_000);
  assert.equal(new HourlyQuotaPacer(S, t12 + 5 * 60_000, file).status(t12 + 5 * 60_000).neededUsd, 1.5);
  s = new HourlyQuotaPacer(S, t12 + 45 * 60_000, file).status(t12 + 45 * 60_000);
  assert.deepEqual([s.hourIndex, s.realized24hUsd, s.sliceRealizedUsd, s.neededUsd], [13, 3, 0, 4.5]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('defaults: the pacer is on in slices mode; the group rule is off (Oct 30: it made less on 4 of 5 lab days); PACER_GROUP=true turns it on', () => {
  const p = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) }).strategy.pacer;
  assert.deepEqual([p.enabled, p.mode, p.group], [true, 'slices', false]);
  assert.equal(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), PACER_GROUP: 'true' }).strategy.pacer.group, true);
});

test('quota floors (PACER_FLOOR, Steven Oct 31): armed at the need while a rule aims higher, kept per contract, raised never lowered, gone with the position', () => {
  const f = new QuotaFloors();
  assert.equal(f.floor('A', 10), undefined, 'none armed');
  assert.ok(f.arm('A', 10, 3));
  assert.equal(f.floor('A', 10), 3);
  assert.ok(!f.arm('A', 10, 2.5), 'a lower need does not lower it');
  assert.ok(f.arm('A', 10, 4.5), 'a higher need the profit covers raises it');
  assert.ok(Math.abs(f.floor('A', 4)! - 1.8) < 1e-9, 'a partial sale leaves the rest its share');
  assert.equal(f.floor('A', 6), undefined, 'added to: a new position, no floor');
  assert.ok(f.arm('A', 6, 2));
  assert.equal(f.floor('A', -6), undefined, 'reversed: none');
  assert.ok(f.arm('A', -6, 2));
  assert.equal(f.floor('A', 0), undefined, 'flat: none');
  assert.equal(f.floor('A', -6), undefined, 'and none after');
  assert.ok(!f.arm('B', 5, 1), 'a market never seen is not armed');
  // The call on one position: net now, the need, the floor, why a rule aims higher.
  assert.deepEqual(quotaCall(5, 4.5, undefined, undefined), { sell: 'snipe' }, 'covers the need, nothing aims higher: the snipe');
  assert.deepEqual(quotaCall(5, 4.5, undefined, "the model's sell price 0.80"), { arm: 4.5 }, 'something aims higher: the floor');
  assert.deepEqual(quotaCall(4.4, 4.5, undefined, "the model's sell price 0.80"), {}, 'short of the need: nothing');
  assert.deepEqual(quotaCall(4.49, 3, 4.5, "the model's sell price 0.80"), { sell: 'floor' }, 'below the floor: sold, whatever aims higher');
  // trail (lab): the floor keeps that share of the profit above the need
  assert.deepEqual(quotaCall(6.5, 4.5, undefined, 'the quota trailing its best', 0.5), { arm: 5.5 }, 'trail: half of the $2 above the need kept');
  assert.deepEqual(quotaCall(4.5, 4.5, undefined, 'the quota trailing its best', 0.5), { arm: 4.5 }, 'trail: at the need the floor is the need');
  assert.deepEqual(quotaCall(5.4, 0.75, 5.5, 'the quota trailing its best', 0.5), { sell: 'floor' }, 'trail: below the trailed floor: sold');
  assert.deepEqual(quotaCall(4.5, 3, 4.5, "the model's sell price 0.80"), { arm: 3 }, 'at the floor: held');
  assert.deepEqual(quotaCall(4.6, 6, 4.5, undefined), {}, 'nothing aims higher now but the need is above the profit: the floor holds it');
  assert.deepEqual(quotaCall(-0.5, 3, 4.5, undefined), { sell: 'floor' }, 'gapped through it into a loss: still the stop');
  assert.deepEqual(quotaCall(undefined, 4.5, 4.5, undefined), {});
  // Settings: riding by default; targets and off.
  assert.equal(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) }).strategy.pacer.floor, 'riding');
  assert.equal(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), PACER_FLOOR: 'targets' }).strategy.pacer.floor, 'targets');
  assert.equal(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), PACER_FLOOR: 'off' }).strategy.pacer.floor, 'off');
  assert.throws(() => loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), PACER_FLOOR: 'maybe' }));
});

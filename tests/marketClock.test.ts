// NYSE calendar and the market-clock features (bot/model/sessions.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { marketClockFeatures, MARKET_CLOCK_FEATURES, nyseCalendar, usSession } from '../bot/model/sessions';

test('NYSE holidays and early closes match the published calendars', () => {
  const c24 = nyseCalendar(2024);
  assert.deepEqual([...c24.closed].sort(), ['2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25']);
  assert.deepEqual([...c24.early].sort(), ['2024-07-03', '2024-11-29', '2024-12-24']);
  const c22 = nyseCalendar(2022);
  assert.ok(!c22.closed.has('2021-12-31') && !c22.closed.has('2022-01-01'), "New Year's Day on a Saturday is not observed");
  assert.ok(c22.closed.has('2022-06-20') && c22.closed.has('2022-12-26'), 'Sunday holidays move to Monday');
  assert.ok(!nyseCalendar(2021).closed.has('2021-06-18'), 'no Juneteenth before 2022');
  const c26 = nyseCalendar(2026);
  assert.ok(c26.closed.has('2026-07-03') && !c26.early.has('2026-07-03'), 'Saturday July 4 closes Friday July 3');
  assert.ok(c26.closed.has('2026-04-03'), 'Good Friday 2026');
  assert.ok(nyseCalendar(2025).closed.has('2025-01-09'), 'special closure');
});

test('US session: DST-correct open, holidays, early close', () => {
  // 2026-03-09 (Monday after the US DST switch): 09:30 ET = 13:30 UTC.
  assert.equal(usSession(Date.UTC(2026, 2, 9, 13, 29)).open, false);
  assert.equal(usSession(Date.UTC(2026, 2, 9, 13, 30)).open, true);
  // Winter: 09:30 ET = 14:30 UTC.
  assert.equal(usSession(Date.UTC(2026, 0, 6, 14, 30)).open, true);
  assert.equal(usSession(Date.UTC(2026, 0, 6, 14, 29)).open, false);
  // Thanksgiving closed; the day after closes at 13:00 ET.
  assert.equal(usSession(Date.UTC(2026, 10, 26, 16, 0)).open, false);
  assert.equal(usSession(Date.UTC(2026, 10, 26, 16, 0)).holiday, true);
  assert.equal(usSession(Date.UTC(2026, 10, 27, 17, 59)).open, true);
  assert.equal(usSession(Date.UTC(2026, 10, 27, 18, 0)).open, false);
});

test('market-clock features: open, 11:00 ET, last 30 minutes, CME break, weekend', () => {
  const at = (iso: string) => marketClockFeatures(Date.parse(iso));
  // Tuesday 2026-10-06, EDT (UTC-4).
  const open = at('2026-10-06T13:40:00Z');
  assert.equal(open.us_open30, 1); assert.equal(open.us_open, 1); assert.ok(Math.abs(open.us_since_open_h - 10 / 60) < 1e-9);
  const eleven = at('2026-10-06T15:15:00Z');
  assert.equal(eleven.us_1100, 1); assert.equal(eleven.us_open30, 0); assert.ok(Math.abs(eleven.us_from_1100_h - 0.25) < 1e-9);
  assert.equal(at('2026-10-06T19:45:00Z').us_close30, 1);
  assert.equal(at('2026-10-06T20:30:00Z').us_after_close60, 1);
  assert.equal(at('2026-10-06T12:30:00Z').us_macro_0830, 1);
  assert.equal(at('2026-10-06T21:30:00Z').cme_break, 1);
  const sat = at('2026-10-10T15:00:00Z');
  assert.equal(sat.sess_weekend, 1); assert.equal(sat.us_open, 0); assert.equal(sat.cme_weekend_closed, 1); assert.equal(sat.us_since_open_h, -1);
  assert.equal(at('2026-10-11T22:30:00Z').cme_weekend_closed, 0, 'CME reopens Sunday 18:00 ET');
  assert.deepEqual(Object.keys(open).sort(), [...MARKET_CLOCK_FEATURES].sort());
  for (const v of Object.values(open)) assert.ok(Number.isFinite(v));
});

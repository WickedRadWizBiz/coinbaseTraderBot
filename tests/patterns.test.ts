import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartPatterns, rsiRangeShift } from '../bot/ta/structure';
import { analyze } from '../bot/ta/analyzer';
import { BOOK_RULES, RULES } from '../bot/ta/knowledge';
import type { Candle } from '../bot/ta/indicators';

const H = 3_600_000;
/** Candles through a list of closes (open = previous close, wicks 0.1 beyond the body). */
function path(points: Array<[number, number]>, start = 100): Candle[] {
  // points: [bars, target close] legs, linear between.
  const closes: number[] = [start];
  for (const [bars, to] of points) { const from = closes[closes.length - 1]; for (let k = 1; k <= bars; k++) closes.push(from + ((to - from) * k) / bars); }
  // The wick is longest at the close side, so a turning bar is the strict extreme (the next bar opens there).
  return closes.map((c, i) => { const o = i ? closes[i - 1] : c; const up = c >= o; return { ts: i * H, o, h: up ? c + 0.1 : o + 0.05, l: up ? o - 0.05 : c - 0.1, c, v: 100 }; });
}
// A long flat lead-in so ATR and swings settle (wiggles of +-0.4).
const lead = (n = 30): Array<[number, number]> => Array.from({ length: n }, (_, i) => [1, 100 + (i % 2 ? 0.4 : -0.4)] as [number, number]);

test('double top completes when the close breaks the trough between two equal highs; double bottom mirrors it', () => {
  const top = path([...lead(), [10, 110], [6, 104], [6, 110.2], [5, 104.4], [1, 103.4]]);
  assert.equal(chartPatterns(top).doubleTB, -1);
  assert.equal(chartPatterns(top.slice(0, -1)).doubleTB, 0, 'not before the neckline breaks');
  const bottom = path([...lead(), [10, 90], [6, 96], [6, 89.8], [5, 95.6], [1, 96.6]]);
  assert.equal(chartPatterns(bottom).doubleTB, 1);
});

test('head and shoulders completes on the neckline break; inverse mirrors it', () => {
  const hs = path([...lead(), [6, 106], [5, 102], [6, 111], [6, 102], [5, 106.2], [4, 102.4], [1, 101]]);
  assert.equal(chartPatterns(hs).headShoulders, -1);
  const inv = path([...lead(), [6, 94], [5, 98], [6, 89], [6, 98], [5, 93.8], [4, 97.6], [1, 99]]);
  assert.equal(chartPatterns(inv).headShoulders, 1);
});

test('bull flag: an impulse, a tight pause, and the break up', () => {
  const flag = path([...lead(), [8, 112], [3, 110.5], [3, 111.5], [2, 110.8], [1, 112.6]]);
  assert.equal(chartPatterns(flag).flag, 1);
  const bear = path([...lead(), [8, 88], [3, 89.5], [3, 88.5], [2, 89.2], [1, 87.4]]);
  assert.equal(chartPatterns(bear).flag, -1);
});

test('trendline break and retest: the broken rising line rejects price from below (the break low is a newer swing)', () => {
  // Rising lows 99.9 -> 102.9 (line ~ +0.27/bar), a fall to 101 through the line, a rally back to it
  // (~107.3 by then) and a red close just under it.
  const legs = (end: number): Array<[number, number]> => [...lead(), [6, 106], [5, 100], [6, 108], [5, 103], [5, 109], [6, 101], [4, end + 0.6], [1, end]];
  assert.equal(chartPatterns(path(legs(106.6))).trendlineRetest, -1);
  assert.equal(chartPatterns(path(legs(107.4))).trendlineRetest, 0, 'closed back above the line: no rejection');
  assert.equal(chartPatterns(path(legs(103.5))).trendlineRetest, 0, 'never came back to the line');
});

test('Cardwell range shift: RSI holding 40-80 = bull range, capped at 60 and reaching 20s = bear range', () => {
  const bull = Array.from({ length: 60 }, (_, i) => 55 + 20 * Math.sin(i / 5) * (i % 2 ? 1 : 0.8));
  assert.equal(rsiRangeShift(bull.map((x) => Math.max(40, x))), 1);
  const bear = Array.from({ length: 60 }, (_, i) => 42 - 15 * Math.abs(Math.sin(i / 5)));
  assert.equal(rsiRangeShift(bear.map((x) => Math.min(60, x))), -1);
  assert.equal(rsiRangeShift(Array.from({ length: 60 }, () => 50)), 0);
});

test('rule-book rules are evaluated apart from the trained rules (snapshot.book), so signals and net do not move', () => {
  const ids = new Set(RULES.map((r) => r.id));
  for (const r of BOOK_RULES) assert.ok(!ids.has(r.id), `${r.id} must not duplicate a trained rule`);
  const top = path([...lead(200), [10, 110], [6, 104], [6, 110.2], [5, 104.4], [1, 103.4]]);
  const snap = analyze('TST', { '1h': top }, top[top.length - 1].ts + H);
  assert.ok(snap.book?.some((s) => s.id === 'double_top_bottom' && s.dir === -1), JSON.stringify(snap.book?.map((s) => s.id)));
  assert.ok(!snap.signals.some((s) => BOOK_RULES.some((b) => b.id === s.id)));
});

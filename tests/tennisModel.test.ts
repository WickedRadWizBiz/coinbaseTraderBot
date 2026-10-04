import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { parseTennisScore } from '../bot/tennis/liveScore';
import { impliedModel, scoreProgress, TennisModel, timeProgress } from '../bot/tennis/tennisModel';
import { MatchTracker, type MatchMarket } from '../bot/tennis/tennisStrategy';

const T = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) }).tennis;
const BO3 = { bestOf: 3 as const, finalTiebreak: 7 as const };
const SLAM = { bestOf: 5 as const, finalTiebreak: 10 as const };

test('scoring model: deuce games match the closed form; match lengths are realistic', () => {
  const p = 0.64, q = 1 - p;
  const game = p ** 4 * (1 + 4 * q + 10 * q * q) + 20 * p ** 3 * q ** 3 * (p * p) / (p * p + q * q);
  // A "match" where A serves every point: 1 game decides nothing, so check via a set at 5-0 with A to serve.
  const m = new TennisModel(p, p, BO3);
  const setPoint = m.from(1, 0, 5, 0, 0, 0, 0); // A serves for the match at 1-0, 5-0
  assert.ok(Math.abs(setPoint.pA - (game + (1 - game) * m.from(1, 0, 5, 1, 0, 0, 1).pA)) < 1e-9);
  const even = m.start();
  assert.ok(even.mean > 150 && even.mean < 180, `even best-of-3 ~165 points, got ${even.mean}`);
  assert.ok(Math.abs(m.pointsPerGame() - 6.25) < 0.1);
  const bo5 = new TennisModel(p, p, SLAM).start();
  assert.ok(bo5.mean > 1.5 * even.mean, 'best of 5 is much longer');
  // Lopsided matches are shorter.
  assert.ok(impliedModel(0.92, BO3).start().mean < even.mean - 15);
  // The implied model reproduces the price.
  assert.ok(Math.abs(impliedModel(0.8, BO3).start().pA - 0.8) < 1e-3);
});

test('tiebreaks: 6-6 goes to a tiebreak; the 10-point final-set tiebreak at the Slams is longer', () => {
  const m7 = new TennisModel(0.64, 0.64, { bestOf: 5, finalTiebreak: 7 });
  const m10 = new TennisModel(0.64, 0.64, SLAM);
  const tb7 = m7.from(2, 2, 6, 6, 0, 0, 0).mean;
  const tb10 = m10.from(2, 2, 6, 6, 0, 0, 0).mean;
  assert.ok(tb7 > 10 && tb7 < 14, `7-point tiebreak ~12 points, got ${tb7}`);
  assert.ok(tb10 > tb7 + 4, `10-point tiebreak longer: ${tb10} vs ${tb7}`);
  // A tiebreak in a non-final set is a 7-point one: winning it ends the set 7-6 either way.
  const bo3 = new TennisModel(0.64, 0.64, BO3);
  assert.ok(Math.abs(bo3.from(0, 0, 6, 6, 7, 5, 0).pA - bo3.from(1, 0, 0, 0, 0, 0, 1).pA) < 1e-12);
  // A stronger server wins more tiebreaks.
  assert.ok(new TennisModel(0.7, 0.6, BO3).from(1, 1, 6, 6, 0, 0, 0).pA > 0.6);
});

test('point clock: 0 at the start, rises, never reaches 1 on time alone', () => {
  const xs = [0, 40, 80, 120, 160, 240, 400].map((n) => timeProgress(n, 164, 41));
  assert.equal(xs[0], 0);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1]);
  assert.ok(xs[xs.length - 1] < 1);
});

test('score clock: sets and games move progress; one set up in a best-of-3 is ~40-60% through', () => {
  const m = impliedModel(0.5, BO3);
  const a = scoreProgress(m, { setsA: 0, setsB: 0, gamesA: 0, gamesB: 0, pointsA: 0, pointsB: 0 });
  const b = scoreProgress(m, { setsA: 1, setsB: 0, gamesA: 0, gamesB: 0, pointsA: 0, pointsB: 0 });
  const c = scoreProgress(m, { setsA: 1, setsB: 1, gamesA: 6, gamesB: 6, pointsA: 5, pointsB: 5 });
  assert.equal(a, 0);
  assert.ok(b > 0.35 && b < 0.6, `one set: ${b}`);
  assert.ok(c > 0.9, `final-set tiebreak at 5-5: ${c}`);
  // A best-of-5 set up is less far along.
  assert.ok(scoreProgress(impliedModel(0.5, SLAM), { setsA: 1, setsB: 0, gamesA: 0, gamesB: 0, pointsA: 0, pointsB: 0 }) < b);
});

test('match format from the title: Slams best of 5 with a 10-point final-set tiebreak; qualifying best of 3', () => {
  const tr = new MatchTracker('W', T);
  const m = (title: string): MatchMarket[] => [{ ticker: 'X-A', title, quote: {}, position: 0 }];
  assert.deepEqual(tr.format(m('Will Sinner win the Sinner vs Alcaraz: Wimbledon Final match?')), SLAM);
  assert.deepEqual(tr.format(m('Will X win the X vs Y: US Open Qualifying match?')), { bestOf: 3, finalTiebreak: 10 });
  assert.deepEqual(tr.format(m('Will X win the X vs Y: Cincinnati match?')), BO3);
});

test('tracker: a blowout is further along than a tight match after the same minutes', () => {
  const t0 = 1_800_000_000_000;
  const run = (path: (i: number) => number) => {
    const tr = new MatchTracker('E', T);
    const ms = (p: number): MatchMarket[] => [{ ticker: 'E-A', quote: { bid: p - 0.01, ask: p + 0.01 }, position: 0 }, { ticker: 'E-B', quote: { bid: 1 - p - 0.01, ask: 1 - p + 0.01 }, position: 0 }];
    const start = t0 + 5 * 60_000;
    let last: MatchMarket[] = ms(0.6);
    for (let i = 0; i <= 12 * 40; i++) { // 40 minutes in 5 s steps
      const now = t0 + i * 5000;
      last = ms(now < start ? 0.6 : path((now - start) / 60_000));
      tr.observe({ event: 'E', now, startTime: start, markets: last, closeTime: t0 + 86_400_000 });
    }
    return tr.progressDetail(t0 + 12 * 40 * 5000, last);
  };
  const blowout = run((min) => Math.min(0.97, 0.6 + 0.011 * min));
  const tight = run((min) => 0.5 + 0.08 * Math.sin(min / 3));
  assert.equal(blowout.time, tight.time, 'same start price, same minutes -> same point clock');
  assert.ok(blowout.info! > 0.6 && tight.info! < 0.4, JSON.stringify({ blowout, tight }));
  assert.ok(blowout.progress > tight.progress);
  assert.ok(blowout.expectedMin! > 90 && blowout.expectedMin! < 130);
});

test('tracker: a live score replaces the estimate', () => {
  const tr = new MatchTracker('E', T);
  tr.liveSince = 1;
  tr.pStart = 0.5;
  tr.score = { setsA: 1, setsB: 0, gamesA: 2, gamesB: 1, pointsA: 0, pointsB: 0 };
  const d = tr.progressDetail(1000, [{ ticker: 'E-A', quote: { bid: 0.6, ask: 0.62 }, position: 0 }]);
  assert.ok(d.score !== undefined && d.progress === d.score && d.time === undefined);
});

test('live score parser: common shapes, tennis point strings, unknown payloads rejected', () => {
  assert.deepEqual(parseTennisScore({ home_sets: 1, away_sets: 0, home_games: 5, away_games: 4, home_points: '40', away_points: 'A', server: 'away' }),
    { setsA: 1, setsB: 0, gamesA: 5, gamesB: 4, pointsA: 3, pointsB: 4, serverA: false });
  assert.deepEqual(parseTennisScore({ competitor1: { sets: 0, games: 6, points: 5 }, competitor2: { sets: 1, games: 6, points: 3 } }),
    { setsA: 0, setsB: 1, gamesA: 6, gamesB: 6, pointsA: 5, pointsB: 3, serverA: undefined }, 'tiebreak points are plain numbers');
  assert.equal(parseTennisScore({ home_score: 3, away_score: 1 }), undefined);
  assert.equal(parseTennisScore(null), undefined);
});

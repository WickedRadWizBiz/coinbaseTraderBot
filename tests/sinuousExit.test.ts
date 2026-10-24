import assert from 'node:assert/strict';
import path from 'path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import {
  CURVE_PROFILES, dynamicKnobs, fromLogit, logit, microPrice, SinuousExitGate, SinuousExitTracker, tennisHighLeverage,
  type CurveEvent, type CurveObservation,
} from '../bot/strategy/sinuousExit';
import { tmpDir } from './helpers';

const BENCH = { minTrades: 20, t: 1, maxLossUsd: 25, window: 200 };

/** A YES book whose micro-price is `p`: a 1c spread with equal sizes around it. */
const book = (p: number, size = 50) => ({ bid: { price: +(p - 0.005).toFixed(4), size }, ask: { price: +(p + 0.005).toFixed(4), size } });

const obs = (now: number, p: number, extra: Partial<CurveObservation> = {}): CurveObservation => ({
  now, sign: 1, ...book(p), entrySidePrice: 0.4, entryFeePer: 0.01, exitFeePer: 0.01, minNetProfit: 0.015, ...extra,
});

test('logit and micro-price: bounded prices map to unbounded log-odds; the micro-price leans toward the thin side', () => {
  assert.ok(Math.abs(fromLogit(logit(0.37)) - 0.37) < 1e-12);
  assert.equal(logit(0), logit(0.005), 'clamped at 0.5c');
  assert.equal(logit(1), logit(0.995), 'clamped at 99.5c');
  // Three times the size bidding: the price the book points to is close to the ask.
  assert.ok(Math.abs(microPrice({ price: 0.5, size: 30 }, { price: 0.52, size: 10 })! - 0.515) < 1e-12);
  assert.equal(microPrice({ price: 0.5, size: 0 }, { price: 0.52, size: 0 }), 0.51, 'no sizes: the mid');
  assert.equal(microPrice(undefined, { price: 0.52, size: 5 }), 0.52, 'one side: that side');
  assert.equal(microPrice(), undefined);
});

test('knobs shift with the spread, the time to close and the tennis score', () => {
  const c = CURVE_PROFILES.crypto_15m;
  assert.deepEqual(dynamicKnobs('crypto_15m', { spread: 0.01, sidePrice: 0.5 }), { R: c.R, kappa: c.kappa, z: c.z });
  // A 6c spread: R x (1 + 0.25 x 4^2) = 5x.
  assert.ok(Math.abs(dynamicKnobs('crypto_15m', { spread: 0.06, sidePrice: 0.5 }).R - 5 * c.R) < 1e-12);
  // 60-180 s to close: take the profit sooner near 50c, flatten the curve above 85c.
  assert.ok(Math.abs(dynamicKnobs('crypto_15m', { spread: 0.01, sidePrice: 0.5, tauSec: 120 }).z - 0.75 * c.z) < 1e-12);
  assert.ok(Math.abs(dynamicKnobs('crypto_15m', { spread: 0.01, sidePrice: 0.9, tauSec: 120 }).kappa - 0.2 * c.kappa) < 1e-12);
  // The settlement-average minute: z falls with the time left (never below 1.1), kappa doubles.
  const last = dynamicKnobs('crypto_1h', { spread: 0.01, sidePrice: 0.5, tauSec: 30 });
  assert.ok(Math.abs(last.z - Math.max(1.1, CURVE_PROFILES.crypto_1h.z * 0.5)) < 1e-12);
  assert.ok(Math.abs(last.kappa - 2 * CURVE_PROFILES.crypto_1h.kappa) < 1e-12);
  assert.equal(dynamicKnobs('crypto_1h', { spread: 0.01, sidePrice: 0.5, tauSec: 1 }).z, 1.1);
  // Tennis: a break point follows the jump; routine games scalp the wiggle; no score keeps the baseline.
  const t = CURVE_PROFILES.tennis;
  assert.deepEqual(dynamicKnobs('tennis', { spread: 0.01, sidePrice: 0.5, highLeverage: true }), { R: t.R * 0.5, kappa: t.kappa, z: 1.6 });
  assert.deepEqual(dynamicKnobs('tennis', { spread: 0.01, sidePrice: 0.5, highLeverage: false }), { R: t.R, kappa: 0.35, z: 1.4 });
  assert.deepEqual(dynamicKnobs('tennis', { spread: 0.01, sidePrice: 0.5 }), { R: t.R, kappa: t.kappa, z: t.z });
});

test('tennis leverage: break points and tiebreaks', () => {
  const s = (pointsA: number, pointsB: number, serverA: boolean | undefined, gamesA = 3, gamesB = 2) => ({ setsA: 0, setsB: 0, gamesA, gamesB, pointsA, pointsB, serverA });
  assert.equal(tennisHighLeverage(s(2, 3, true)), true, '30-40 on A\'s serve');
  assert.equal(tennisHighLeverage(s(3, 4, true)), true, 'advantage receiver');
  assert.equal(tennisHighLeverage(s(3, 3, true)), false, 'deuce');
  assert.equal(tennisHighLeverage(s(3, 2, true)), false, 'game point for the server');
  assert.equal(tennisHighLeverage(s(0, 3, false)), false, 'B serving, A has 0, B 40: not a break point');
  assert.equal(tennisHighLeverage(s(3, 1, false)), true, 'B serving at 15-40');
  assert.equal(tennisHighLeverage(s(1, 1, undefined, 6, 6)), true, 'tiebreak');
  assert.equal(tennisHighLeverage(s(1, 1, undefined)), undefined, 'unknown server');
  assert.equal(tennisHighLeverage(undefined), undefined);
});

test('curve: a jump in our favour is a DEVIATION_SPIKE once the exit clears the fees', () => {
  const tr = new SinuousExitTracker('crypto_15m');
  let now = 0;
  for (let i = 0; i < 20; i++) { const r = tr.update(obs((now += 1000), 0.6)); assert.equal(r.signal, false, `calm tick ${i}: ${r.reason}`); }
  const r = tr.update(obs((now += 1000), 0.72, { bid: { price: 0.71, size: 400 }, ask: { price: 0.73, size: 10 } }));
  assert.equal(r.reason, 'DEVIATION_SPIKE');
  assert.equal(r.signal, true);
  assert.ok(r.z! >= CURVE_PROFILES.crypto_15m.z);
  // The same jump without enough profit (entered at 0.70): no signal.
  const tr2 = new SinuousExitTracker('crypto_15m');
  now = 0;
  for (let i = 0; i < 20; i++) tr2.update(obs((now += 1000), 0.6, { entrySidePrice: 0.7 }));
  const r2 = tr2.update(obs((now += 1000), 0.72, { entrySidePrice: 0.7, bid: { price: 0.71, size: 400 }, ask: { price: 0.73, size: 10 } }));
  assert.equal(r2.reason, 'BELOW_PROFIT_FLOOR');
  assert.equal(r2.signal, false);
});

test('curve: a steady climb holds; the roll-over after it is a SINUOUS_CROSS', () => {
  const tr = new SinuousExitTracker('crypto_15m');
  let now = 0, p = 0.5;
  const seen: string[] = [];
  for (let i = 0; i < 40; i++) { p += 0.004; const r = tr.update(obs((now += 1000), p)); seen.push(r.reason); if (i > 8) assert.equal(r.signal, false, `climbing tick ${i}: ${r.reason} z ${r.z}`); }
  assert.ok(seen.includes('WARMING_UP') && seen.includes('HOLD'));
  // The climb stalls and turns: the curve falls under the projection made a few seconds ago, velocity <= 0.
  let crossed = false;
  for (let i = 0; i < 20 && !crossed; i++) { p -= 0.006; const r = tr.update(obs((now += 1000), p)); crossed = r.reason === 'SINUOUS_CROSS' && r.signal; if (crossed) assert.ok(r.velocity! <= 0 && r.curve! < r.projected!); }
  assert.ok(crossed, 'the roll-over signals');
});

test('curve: a NO position is mirrored (profit when YES falls), and a long gap restarts the curve', () => {
  const tr = new SinuousExitTracker('crypto_1h');
  let now = 0;
  // Holding NO bought at 0.40 (YES at 0.60): YES at 0.45 means NO at 0.55.
  for (let i = 0; i < 15; i++) tr.update(obs((now += 1000), 0.45, { sign: -1 }));
  const r = tr.update(obs((now += 1000), 0.45, { sign: -1 }));
  assert.ok(Math.abs(r.micro! - 0.55) < 1e-9);
  assert.ok(r.netProfit! > 0.1, 'NO bid 0.545 - 0.40 - fees');
  const after = tr.update(obs((now += 120_000), 0.45, { sign: -1 }));
  assert.equal(after.reason, 'WARMING_UP', 'restarted after a 2-minute gap');
});

test('gate: a profit exit waits for the curve; stops, small gains and losses never do', () => {
  const events: CurveEvent[] = [];
  const g = new SinuousExitGate({ mode: 'gate', minNetProfit: 0.015 }, BENCH, undefined, (e) => events.push(e), 0);
  let now = 0;
  for (let i = 0; i < 20; i++) g.observe('T', 'crypto_15m', obs((now += 1000), 0.6));
  const exit = { sidePrice: 0.595, count: 10, exitFeePer: 0.01, entrySidePrice: 0.4, entryFeePer: 0.01 };
  const held = g.check('T', { ...exit, protective: false }, now);
  assert.equal(held.allow, false);
  assert.match(held.note!, /holding the profit exit at 0.595/);
  assert.deepEqual(g.status().holding, ['T']);
  assert.equal(events.at(-1)?.event, 'held');
  // Protective exits and exits below the profit floor go out (and score the held exit).
  assert.equal(g.check('T', { ...exit, protective: true }, now).allow, true);
  assert.equal(g.status().scored, 1, 'held exit scored against the stop price');
  assert.equal(g.check('T', { ...exit, sidePrice: 0.42, protective: false }, now).allow, true, 'net below 1.5c: not a profit exit');
  assert.equal(g.check('T', { ...exit, sidePrice: 0.35, protective: false }, now).allow, true, 'a loss cut');
  // A spike releases the profit exit.
  g.check('T', { ...exit, protective: false }, now);
  g.observe('T', 'crypto_15m', obs((now += 1000), 0.72, { bid: { price: 0.71, size: 400 }, ask: { price: 0.73, size: 10 } }));
  const go = g.check('T', { ...exit, sidePrice: 0.71, protective: false }, now);
  assert.equal(go.allow, true);
  assert.match(go.note!, /DEVIATION_SPIKE/);
  assert.ok(events.some((e) => e.event === 'released'));
  // Holding from 0.595 to 0.71 earned (0.71 - 0.595) x 10 = $1.15.
  const last = events.filter((e) => e.event === 'scored').at(-1)!;
  assert.ok(Math.abs((last.usd as number) - 1.15) < 1e-9);
});

test('gate: monitor mode never holds; a settlement scores a held exit at the payout', () => {
  const m = new SinuousExitGate({ mode: 'monitor', minNetProfit: 0.015 }, BENCH, undefined, undefined, 0);
  let now = 0;
  for (let i = 0; i < 20; i++) m.observe('T', 'crypto_15m', obs((now += 1000), 0.6));
  const exit = { sidePrice: 0.595, count: 10, exitFeePer: 0.01, entrySidePrice: 0.4, entryFeePer: 0.01, protective: false };
  const v = m.check('T', exit, now);
  assert.equal(v.allow, true);
  assert.match(v.note!, /monitor\) would hold/);
  const events: CurveEvent[] = [];
  const g = new SinuousExitGate({ mode: 'gate', minNetProfit: 0.015 }, BENCH, undefined, (e) => events.push(e), 0);
  for (let i = 0; i < 20; i++) g.observe('T', 'crypto_15m', obs((now += 1000), 0.6));
  assert.equal(g.check('T', exit, now).allow, false);
  g.settled('T', 'yes', now);
  // Held at 0.585 net of the exit fee, settled at $1: +$4.15.
  assert.ok(Math.abs((events.find((e) => e.event === 'scored')!.usd as number) - 4.15) < 1e-9);
  // A position closed some other way is scored at the last bid seen (net of the exit fee).
  for (let i = 0; i < 20; i++) g.observe('U', 'crypto_15m', obs((now += 1000), 0.6));
  assert.equal(g.check('U', exit, now).allow, false);
  g.flat('U', now);
  const u = events.filter((e) => e.event === 'scored' && e.ticker === 'U').at(-1)!;
  assert.ok(Math.abs((u.usd as number) - 0) < 1e-9, 'bid 0.595 net 0.585, the same as when held');
});

test('gate: benched by the probation rules when holding costs money, and the bench survives a restart', () => {
  const file = path.join(tmpDir(), 'curve-exit.json');
  const events: CurveEvent[] = [];
  const g = new SinuousExitGate({ mode: 'gate', minNetProfit: 0.015 }, { ...BENCH, maxLossUsd: 3 }, file, (e) => events.push(e), 0);
  let now = 0;
  const exit = { sidePrice: 0.595, count: 10, exitFeePer: 0.01, entrySidePrice: 0.4, entryFeePer: 0.01 };
  for (let k = 0; k < 3; k++) {
    const t = `T${k}`;
    for (let i = 0; i < 20; i++) g.observe(t, 'crypto_15m', obs((now += 1000), 0.6));
    assert.equal(g.check(t, { ...exit, protective: false }, now).allow, false);
    // The trailing stop sells 12c lower: holding cost $1.20.
    g.check(t, { ...exit, sidePrice: 0.475, protective: true }, now);
  }
  assert.ok(g.status().benched, 'net -$3.60 reached the $3 limit');
  assert.equal(g.active, false);
  assert.ok(events.some((e) => e.event === 'benched'));
  // Benched: profit exits go out (with a note).
  for (let i = 0; i < 20; i++) g.observe('V', 'crypto_15m', obs((now += 1000), 0.6));
  const v = g.check('V', { ...exit, protective: false }, now);
  assert.equal(v.allow, true);
  assert.match(v.note!, /benched/);
  const again = new SinuousExitGate({ mode: 'gate', minNetProfit: 0.015 }, { ...BENCH, maxLossUsd: 3 }, file, undefined, 0);
  assert.ok(again.status().benched);
  again.reset(now);
  assert.equal(again.status().benched, null);
  assert.equal(again.status().scored, 0);
  assert.equal(again.active, true);
});

test('gate: a scoreboard saved under another restart tag starts over once (the owner turning paper back on); live keeps its own', () => {
  const file = path.join(tmpDir(), 'curve-exit.json');
  const g = new SinuousExitGate({ mode: 'gate', minNetProfit: 0.015 }, { ...BENCH, maxLossUsd: 1 }, file, undefined, 0);
  let now = 0;
  const exit = { sidePrice: 0.595, count: 10, exitFeePer: 0.01, entrySidePrice: 0.4, entryFeePer: 0.01 };
  for (let i = 0; i < 20; i++) g.observe('T', 'crypto_15m', obs((now += 1000), 0.6));
  g.check('T', { ...exit, protective: false }, now);
  g.check('T', { ...exit, sidePrice: 0.475, protective: true }, now);
  assert.ok(g.status().benched, 'held exit cost $1.20: benched');
  // Live (no tag): the bench stays.
  assert.ok(new SinuousExitGate({ mode: 'gate', minNetProfit: 0.015 }, BENCH, file, undefined, now).status().benched);
  // Paper with the tag: started over once, the old scoreboard noted in the event.
  const events: CurveEvent[] = [];
  const paper = new SinuousExitGate({ mode: 'gate', minNetProfit: 0.015 }, { ...BENCH, t: 2, minTrades: 30 }, file, (e) => events.push(e), now, 'owner-on');
  assert.equal(paper.status().benched, null);
  assert.equal(paper.status().scored, 0);
  assert.equal(paper.active, true);
  assert.deepEqual(paper.status().benchRule, { t: 2, minExits: 30, maxLossUsd: 25 });
  assert.equal(events[0]?.event, 'reset');
  assert.deepEqual((events[0] as { before?: unknown }).before, { scored: 1, benched: 'holding profit exits cost $1.20 over 1 exits (limit $1)' });
  // The same tag again (a restart): nothing is reset; a manual reset keeps the tag.
  paper.reset(now + 1);
  const again: CurveEvent[] = [];
  const restarted = new SinuousExitGate({ mode: 'gate', minNetProfit: 0.015 }, BENCH, file, (e) => again.push(e), now + 2, 'owner-on');
  assert.equal(restarted.status().since, now + 1);
  assert.equal(again.length, 0);
});

test('gate: the paper bench rule (t <= -2 after 30 held exits) leaves a curve losing within luck running', () => {
  const run = (bench: { minTrades: number; t: number; maxLossUsd: number; window: number }) => {
    const g = new SinuousExitGate({ mode: 'gate', minNetProfit: 0.015 }, bench, undefined, undefined, 0);
    let now = 0;
    const exit = { sidePrice: 0.595, count: 10, exitFeePer: 0.01, entrySidePrice: 0.4, entryFeePer: 0.01 };
    // 42 held exits, losses and gains interleaved: 4 in 7 cost 1c a contract ($0.10), 3 in 7 gained 1c (net -$0.60).
    for (let k = 0; k < 42; k++) {
      const t = `T${k}`;
      for (let i = 0; i < 20; i++) g.observe(t, 'crypto_15m', obs((now += 1000), 0.6));
      g.check(t, { ...exit, protective: false }, now);
      g.check(t, { ...exit, sidePrice: k % 7 < 4 ? 0.585 : 0.605, protective: true }, now);
    }
    return g.status();
  };
  const loose = run({ minTrades: 20, t: 0.5, maxLossUsd: 25, window: 200 });
  assert.ok(loose.benched, `benched under a loose rule (t ${loose.t})`);
  const paper = run({ minTrades: 30, t: 2, maxLossUsd: 25, window: 200 });
  assert.equal(paper.benched, null, `t ${paper.t} is within luck`);
  assert.equal(paper.scored, 42);
});

test('rest mode: the swing-top estimate rides the curve\'s momentum; no exit is ever held', () => {
  const rest = new SinuousExitGate({ mode: 'rest', minNetProfit: 0.015, restBandSigmas: 0 }, BENCH, undefined, undefined, 0);
  let now = 0;
  // Rising 0.5c a second: the momentum carries the estimate above the curve.
  for (let i = 0; i < 20; i++) rest.observe('T', 'crypto_15m', obs((now += 1000), 0.5 + 0.005 * i));
  const r = rest.reading('T')!;
  const top = rest.restTarget('T')!;
  assert.ok(top > r.curve! + 0.005, `top ${top} vs curve ${r.curve}`);
  // Flat: the estimate is the curve itself (no band); with the band, half the book's noise above it.
  for (let i = 0; i < 60; i++) rest.observe('F', 'crypto_15m', obs((now += 1000), 0.6));
  assert.ok(Math.abs(rest.restTarget('F')! - rest.reading('F')!.curve!) < 0.002);
  const banded = new SinuousExitGate({ mode: 'rest', minNetProfit: 0.015, restBandSigmas: 0.5 }, BENCH, undefined, undefined, 0);
  now = 0;
  for (let i = 0; i < 60; i++) banded.observe('F', 'crypto_15m', obs((now += 1000), 0.6));
  assert.ok(banded.restTarget('F')! > banded.reading('F')!.curve! + 0.01, String(banded.restTarget('F')));
  // Warming up: no estimate. Another mode: none either.
  rest.observe('W', 'crypto_15m', obs(now, 0.6));
  assert.equal(rest.restTarget('W'), undefined);
  const gate = new SinuousExitGate({ mode: 'gate', minNetProfit: 0.015 }, BENCH, undefined, undefined, 0);
  for (let i = 0; i < 20; i++) gate.observe('T', 'crypto_15m', obs((now += 1000), 0.6));
  assert.equal(gate.restTarget('T'), undefined);
  // Rest mode lets every exit go, profit or not.
  assert.equal(rest.check('F', { sidePrice: 0.595, count: 10, exitFeePer: 0.01, entrySidePrice: 0.4, entryFeePer: 0.01, protective: false }, now).allow, true);
  assert.deepEqual(rest.status().holding, []);
});

/** Feeds a curve that rises to 0.695 and then falls a cent a second for six seconds: a roll-over below its projection. */
function rollOver(g: SinuousExitGate, ticker: string, now: number): number {
  for (let i = 0; i < 30; i++) g.observe(ticker, 'crypto_15m', obs((now += 1000), 0.55 + 0.005 * i));
  for (let i = 1; i <= 6; i++) g.observe(ticker, 'crypto_15m', obs((now += 1000), 0.695 - 0.01 * i));
  return now;
}

const CROSS = { sidePrice: 0.63, count: 10, exitFeePer: 0.0165, entrySidePrice: 0.4, entryFeePer: 0.01, floor: 0.041, tauSec: 400, spot: 'against' as const };

test('rest mode, the cross: a roll-over by half the fee with spot turned and the floor cleared sells at once; its fills are scored against holding to settlement', () => {
  const file = path.join(tmpDir(), 'curve.json');
  const g = new SinuousExitGate({ mode: 'rest', minNetProfit: 0.015, restBandSigmas: 0 }, BENCH, file, undefined, 0);
  const now = rollOver(g, 'T', 0);
  const r = g.reading('T')!;
  assert.ok(r.curve! < r.projected! && r.velocity! <= 0, JSON.stringify(r));
  // Spot has not turned against the side: no sale, the resting sell stays.
  const w = g.cross('T', { ...CROSS, spot: 'with' }, now);
  assert.equal(w.sell, false);
  assert.match(w.note ?? '', /spot has not turned \(with\)/);
  assert.equal(g.cross('T', { ...CROSS, spot: 'flat' }, now).sell, false);
  // Below the take-profit floor, or inside the stand-down before the close: no sale (and no resting sell there).
  assert.equal(g.cross('T', { ...CROSS, floor: 0.3 }, now).sell, false);
  assert.equal(g.cross('T', { ...CROSS, tauSec: 100 }, now).sell, false);
  assert.equal(g.restTarget('T', 100), undefined);
  assert.notEqual(g.restTarget('T', 400), undefined);
  // A margin wider than the dip: not a cross. The cross turned off: none either.
  const wide = new SinuousExitGate({ mode: 'rest', minNetProfit: 0.015, crossFeeMargin: 5 }, BENCH, undefined, undefined, 0);
  assert.equal(wide.cross('T', CROSS, rollOver(wide, 'T', 0)).sell, false);
  const off = new SinuousExitGate({ mode: 'rest', minNetProfit: 0.015, cross: false }, BENCH, undefined, undefined, 0);
  assert.equal(off.cross('T', CROSS, rollOver(off, 'T', 0)).sell, false);
  assert.equal(off.status().cross, false);
  // All three hold: sell now.
  const c = g.cross('T', CROSS, now);
  assert.equal(c.sell, true);
  assert.match(c.why!, /^exit curve: cross 0\.63 \(\+0\.203 a contract net, curve 0\.\d+ under projection 0\.\d+, spot against\)$/);
  // Only a fill is a sale: the call alone (its order rejected, or not filled) is not scored.
  assert.equal(g.status().crossesPending, 0);
  assert.equal(g.cross('T', CROSS, now + 2000).sell, true, 'called again: the next order');
  g.crossFilled('T', 1, 0.63, 6, 0.0165, now + 2000);
  g.crossFilled('T', 1, 0.63, 4, 0.0165, now + 2100);
  assert.equal(g.status().crossesPending, 2);
  // The sale waits for its market's result across a restart; NO settles: holding YES would have paid 0, so the sale
  // made its net price x 10.
  const again = new SinuousExitGate({ mode: 'rest', minNetProfit: 0.015 }, BENCH, file, undefined, now);
  assert.equal(again.status().crossesPending, 2);
  again.settled('T', 'no', now + 60_000);
  const s = again.status();
  assert.equal(s.scored, 2);
  assert.equal(s.crossesPending, 0);
  assert.ok(Math.abs(s.netUsd - (0.63 - 0.0165) * 10) < 0.01, String(s.netUsd));
});

test('cross: a NO position\'s fill is scored in NO terms; a cross that never filled leaves nothing to score', () => {
  const g = new SinuousExitGate({ mode: 'cross', minNetProfit: 0.015 }, BENCH, undefined, undefined, 0);
  g.crossFilled('N', -1, 0.7, 5, 0.0147, 0); // sold 5 NO at 70c
  g.cross('U', CROSS, 0); // called, no curve yet: nothing
  g.settled('N', 'no', 1000); // NO won: holding would have paid $1
  g.settled('U', 'yes', 1000);
  const s = g.status();
  assert.equal(s.scored, 1);
  assert.ok(Math.abs(s.netUsd - (0.7 - 0.0147 - 1) * 5) < 0.006, String(s.netUsd));
});

test('cross mode (paper\'s default): the curve sells on a confirmed cross but never rests a sell at the swing top and never holds an exit', () => {
  const g = new SinuousExitGate({ mode: 'cross', minNetProfit: 0.015, restBandSigmas: 0 }, BENCH, undefined, undefined, 0);
  const now = rollOver(g, 'T', 0);
  // No resting sell, however the curve moves.
  assert.equal(g.restTarget('T'), undefined);
  assert.equal(g.restTarget('T', 400), undefined);
  // The cross fires as in rest mode; its fill is what gets scored.
  const c = g.cross('T', CROSS, now);
  assert.equal(c.sell, true);
  assert.match(c.why!, /^exit curve: cross 0\.63 /);
  g.crossFilled('T', 1, 0.63, 10, 0.0165, now);
  assert.deepEqual([g.status().mode, g.status().cross, g.status().crossesPending], ['cross', true, 1]);
  // Every other exit (a profit exit, a stop) goes out at once: nothing is held.
  assert.equal(g.check('T', { sidePrice: 0.66, count: 10, exitFeePer: 0.0157, entrySidePrice: 0.4, entryFeePer: 0.01, protective: false }, now).allow, true);
  assert.equal(g.check('T', { sidePrice: 0.3, count: 10, exitFeePer: 0.0147, entrySidePrice: 0.4, entryFeePer: 0.01, protective: true }, now).allow, true);
  assert.deepEqual(g.status().holding, []);
  // The default in paper and live, with one bench rule (the paper-only names from before Oct 24 still read).
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40) }).sinuousExit;
  assert.deepEqual([cfg.mode, cfg.benchT, cfg.benchMinExits], ['cross', 2, 30]);
  assert.deepEqual([loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), SINUOUS_PAPER_BENCH_T: '3' }).sinuousExit.benchT, loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), SINUOUS_PAPER_BENCH_T: '3', SINUOUS_BENCH_T: '1.5' }).sinuousExit.benchT], [3, 1.5]);
  assert.equal('paperMode' in cfg, false, 'no paper-only mode');
});

test('rest mode: the cross is benched when selling on it loses against holding; the resting sells go on', () => {
  const events: CurveEvent[] = [];
  const g = new SinuousExitGate({ mode: 'rest', minNetProfit: 0.015, restBandSigmas: 0 }, { minTrades: 20, t: 1, maxLossUsd: 5, window: 200 }, undefined, (e) => events.push(e), 0);
  let now = 0;
  for (const t of ['A', 'B']) {
    now = rollOver(g, t, now);
    assert.equal(g.cross(t, CROSS, now).sell, true);
    g.crossFilled(t, 1, CROSS.sidePrice, CROSS.count, CROSS.exitFeePer, now);
    // YES settles: holding would have paid $1 a contract, so each sale lost (1 - 0.6135) x 10.
    g.settled(t, 'yes', now);
  }
  const s = g.status();
  assert.ok(s.benched, JSON.stringify(s));
  assert.match(s.benched!.reason, /^selling on the cross cost \$7\.73 against holding to settlement over 2 exits \(limit \$5\)$/);
  assert.ok(events.some((e) => e.event === 'benched'));
  now = rollOver(g, 'C', now);
  const c = g.cross('C', CROSS, now);
  assert.equal(c.sell, false);
  assert.match(c.note ?? '', /the cross is benched/);
  assert.notEqual(g.restTarget('C', 400), undefined, 'the resting sell goes on');
  g.reset(now);
  assert.equal(g.cross('C', CROSS, now).sell, true, 'a reset turns the cross back on');
});

test('cross on the live line: sells on its break when the sale clears the floor; never without one, under the floor, near the close or benched', () => {
  const g = new SinuousExitGate({ mode: 'cross', minNetProfit: 0.015, crossSource: 'line' }, { minTrades: 20, t: 1, maxLossUsd: 1, window: 200 }, undefined, undefined, 0);
  const line = (broke: boolean) => ({ price: 100, projected: 100.05, underSigmas: broke ? 2.4 : 1.2, slope: -0.3, breakSec: broke ? 2 : 0, broke });
  // The order-book curve does not matter here: the line alone decides (no book curve has been fed at all).
  assert.equal(g.cross('T', { ...CROSS, line: line(false) }, 0).sell, false, 'no break');
  assert.equal(g.cross('T', { ...CROSS, line: undefined }, 0).sell, false, 'no line reading');
  assert.equal(g.cross('T', { ...CROSS, floor: 0.3, line: line(true) }, 0).sell, false, 'under the take-profit floor');
  assert.equal(g.cross('T', { ...CROSS, tauSec: 100, line: line(true) }, 0).sell, false, 'inside the stand-down');
  const c = g.cross('T', { ...CROSS, spot: 'with', line: line(true) }, 0);
  assert.equal(c.sell, true, 'the coin turn of the book source is not needed');
  assert.match(c.why!, /^exit curve: cross 0\.63 \(\+0\.203 a contract net, live line 2\.4 noise under its projection for 2 s\)$/);
  // Scored on the fill like the book cross; losing past the dollar limit benches it.
  g.crossFilled('T', 1, 0.63, 10, 0.0165, 0);
  g.settled('T', 'yes', 1000);
  assert.ok(g.status().benched);
  assert.match(g.cross('U', { ...CROSS, line: line(true) }, 2000).note ?? '', /the cross is benched/);
  // The defaults: the cross watches the live line, and its sell signal is off until it beats the other exits.
  const d = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40) }).sinuousExit;
  assert.deepEqual([d.crossSource, d.cross], ['line', false]);
  const off = new SinuousExitGate({ ...d, minNetProfit: 0.015 }, { minTrades: 20, t: 1, maxLossUsd: 25, window: 200 }, undefined, undefined, 0);
  assert.equal(off.cross('V', { ...CROSS, line: line(true) }, 0).sell, false, 'off by default');
  assert.equal(new SinuousExitGate({ ...loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), SINUOUS_CROSS: 'true' }).sinuousExit, minNetProfit: 0.015 }, { minTrades: 20, t: 1, maxLossUsd: 25, window: 200 }, undefined, undefined, 0).cross('V', { ...CROSS, line: line(true) }, 0).sell, true, 'SINUOUS_CROSS=true turns it on');
});

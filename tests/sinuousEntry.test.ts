import assert from 'node:assert/strict';
import path from 'path';
import { test } from 'node:test';
import { SinuousEntryGate } from '../bot/strategy/sinuousEntry';
import { tmpDir } from './helpers';

/** A YES book whose mid is `p`: a 1c spread with equal sizes. */
const book = (p: number, size = 50) => ({ bid: { price: +(p - 0.005).toFixed(4), size }, ask: { price: +(p + 0.005).toFixed(4), size } });

/** One-second ticks moving the YES mid by `step` a second (a 15-minute contract). */
function drive(g: SinuousEntryGate, ticker: string, from: { now: number; p: number }, secs: number, step: number) {
  let { now, p } = from;
  for (let i = 0; i < secs; i++) { now += 1000; p += step; g.observe(ticker, 'crypto_15m', { now, ...book(p), tauSec: 600 }); }
  return { now, p };
}

test('entry curve: a falling YES book is against a YES bid and with a NO bid; flat or warming up, neither', () => {
  const g = new SinuousEntryGate({ mode: 'monitor', slope: 0.005 });
  assert.deepEqual(g.verdict('T', 'bid'), { against: false }, 'no curve yet');
  g.observe('T', 'crypto_15m', { now: 1000, ...book(0.5) });
  assert.equal(g.verdict('T', 'bid').against, false, 'warming up');
  let s = drive(g, 'T', { now: 1000, p: 0.5 }, 20, -0.004);
  // A slide of 4c a 10 s: the filter's damped slope reads about 1.6c a 10 s, past the 0.5c threshold.
  const yes = g.verdict('T', 'bid'), no = g.verdict('T', 'ask');
  assert.ok(yes.against && yes.slope! < -0.012 && yes.slope! > -0.02, `YES slope ${yes.slope}`);
  assert.ok(!no.against && Math.abs(no.slope! + yes.slope!) < 1e-12, 'the NO side sees the mirror image');
  s = drive(g, 'T', s, 20, 0.004);
  assert.ok(g.verdict('T', 'ask').against && !g.verdict('T', 'bid').against, 'rising: the NO bid is the one against');
  drive(g, 'T', s, 40, 0);
  assert.ok(!g.verdict('T', 'bid').against && !g.verdict('T', 'ask').against, 'flat: under the threshold');
  // A higher threshold needs a steeper slide.
  const wide = new SinuousEntryGate({ mode: 'monitor', slope: 0.02 });
  drive(wide, 'T', { now: 0, p: 0.5 }, 20, -0.004);
  assert.equal(wide.verdict('T', 'bid').against, false);
});

test('entry curve monitor: maker entries are scored by their 60 s markout, split by what the curve said at the fill', () => {
  const file = path.join(tmpDir(), 'curve-entry.json');
  const g = new SinuousEntryGate({ mode: 'monitor', slope: 0.005 }, file, 0);
  // Into a falling book: a YES bid filled at 0.42; a minute later the mid is 0.40, 2c under the price paid.
  const a = drive(g, 'A', { now: 0, p: 0.5 }, 20, -0.004);
  g.onEntryFill({ ticker: 'A', side: 'bid', price: 0.42, count: 3, ts: a.now });
  // On a calm book: a NO bid (a YES ask at 0.61); a minute later the YES mid is 0.60, 1c in the NO buyer's favour.
  const b = drive(g, 'B', { now: 0, p: 0.6 }, 20, 0);
  g.onEntryFill({ ticker: 'B', side: 'ask', price: 0.61, count: 2, ts: b.now });
  // A fill before the curve has warmed up is not scored either way.
  g.observe('C', 'crypto_15m', { now: a.now, ...book(0.5) });
  g.onEntryFill({ ticker: 'C', side: 'bid', price: 0.5, count: 1, ts: a.now });
  assert.equal(g.status().pending, 3);
  for (let t = a.now + 1000; t <= a.now + 61_000; t += 1000) {
    g.observe('A', 'crypto_15m', { now: t, ...book(0.4) });
    g.observe('B', 'crypto_15m', { now: t, ...book(0.6) });
    g.observe('C', 'crypto_15m', { now: t, ...book(0.5) });
  }
  const st = g.status();
  assert.equal(st.pending, 0);
  assert.equal(st.unread, 1);
  assert.deepEqual(st.blocked, { fills: 1, contracts: 3, markoutCents: -2 });
  assert.deepEqual(st.kept, { fills: 1, contracts: 2, markoutCents: 1 });
  // The slide read about 1.6c a 10 s at the fill: against it up to a 1c threshold, not at 2c.
  assert.deepEqual(st.bySlope.map((x) => [x.slopeCents, x.blocked.fills, x.kept.fills]), [[0.25, 1, 1], [0.5, 1, 1], [1, 1, 1], [2, 0, 2]]);
  // The scoreboard survives a restart.
  const again = new SinuousEntryGate({ mode: 'monitor', slope: 0.005 }, file);
  assert.deepEqual([again.status().blocked, again.status().kept], [st.blocked, st.kept]);
});

test('entry curve: a fill whose market stops updating is dropped unscored; off records nothing', () => {
  const g = new SinuousEntryGate({ mode: 'monitor', slope: 0.005 });
  const a = drive(g, 'A', { now: 0, p: 0.5 }, 20, -0.004);
  g.onEntryFill({ ticker: 'A', side: 'bid', price: 0.42, count: 1, ts: a.now });
  drive(g, 'B', { now: a.now, p: 0.5 }, 61, 0);
  assert.equal(g.status().pending, 1, 'waiting for a fresh look at its own market');
  drive(g, 'B', { now: a.now + 61_000, p: 0.5 }, 300, 0);
  assert.equal(g.status().pending, 0);
  assert.equal(g.status().blocked.fills + g.status().kept.fills, 0);
  const off = new SinuousEntryGate({ mode: 'off', slope: 0.005 });
  off.onEntryFill({ ticker: 'A', side: 'bid', price: 0.42, count: 1, ts: 0 });
  assert.equal(off.status().pending, 0);
});

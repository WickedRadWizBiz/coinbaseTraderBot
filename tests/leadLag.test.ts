import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spotPullbackAt, type SetupSeries } from '../bot/setups/detectors';
import { leadLag, secondGrid } from '../research/leadLag';
import { rng } from '../research/stats';

const T0 = Date.UTC(2026, 9, 1);
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());

/** Spot prints twice a second on a random walk (`bps` per second); the perp market is spot `delayS` seconds ago, and
 *  the bot sees it by polling every 2 s with 200 ms of latency. */
function feeds(hours: number, delayS: number, bps: number, seed: number): { spot: Array<[number, number]>; perp: Array<[number, number]> } {
  const r = rng(seed);
  const n = hours * 3600 * 2;
  const px: number[] = [];
  let x = Math.log(60_000);
  for (let i = 0; i < n; i++) { x += (bps / 1e4) * Math.SQRT1_2 * gauss(r); px.push(x); }
  const at = (t: number) => Math.exp(px[Math.max(0, Math.min(n - 1, Math.floor((t - T0) / 500)))]);
  const spot: Array<[number, number]> = px.map((v, i) => [T0 + i * 500, Math.exp(v)]);
  const perp: Array<[number, number]> = [];
  for (let t = T0 + 30_000; t < T0 + n * 500; t += 2000) perp.push([t, at(t - 200 - delayS * 1000)]);
  return { spot, perp };
}

test('lead-lag: the one-second grid carries the last fresh print and its age', () => {
  const g = secondGrid([[1000, 1], [2500, 2], [9000, 3]], 1000, 6000, 2000);
  assert.deepEqual(Array.from(g.v), [1, 1, 2, 2, NaN]);
  assert.deepEqual(Array.from(g.age), [0, 1000, 500, 1500, 2500]);
});

test('lead-lag: a perp that really trails spot by 8 s is found, and the gap pays for itself', () => {
  const { spot, perp } = feeds(30, 8, 3, 1);
  const r = leadLag('BTC', spot, perp);
  assert.equal(r.verdict, 'spot leads', r.why);
  assert.ok(Math.abs(r.perpUpdateMs - 2000) < 1, 'the poll interval is measured');
  assert.equal(r.fromLag, 4, 'lags within two polls are not counted');
  const peak = r.xcorr.reduce((a, b) => (b.rho > a.rho ? b : a));
  assert.ok(peak.lag >= 7 && peak.lag <= 11, `correlation peaks near the delay: ${peak.lag} s`);
  assert.ok(r.lead.lo > 0 && r.lead.score > r.reverse.score);
});

test('lead-lag: polling and latency alone are not a lead (the gaps are too small to trade)', () => {
  const { spot, perp } = feeds(30, 0, 3, 2);
  const r = leadLag('BTC', spot, perp);
  assert.notEqual(r.verdict, 'spot leads', r.why);
  assert.ok(r.gaps.every((g) => !(g.bigLo > r.costBps)), JSON.stringify(r.gaps.map((g) => [g.w, g.L, g.bigBps])));
});

test('lead-lag: a perp that leads spot is called the other way; too little data is said so', () => {
  const { spot, perp } = feeds(30, 0, 3, 3);
  // Swap the roles: spot now trails the (polled) perp by 8 s.
  const lagged: Array<[number, number]> = spot.map(([t], i) => [t, spot[Math.max(0, i - 16)][1]]);
  const r = leadLag('BTC', lagged, perp.map(([t]) => [t, spot[Math.min(spot.length - 1, Math.floor((t - T0) / 500))][1]] as [number, number]));
  assert.equal(r.verdict, 'perp leads', r.why);
  const short = feeds(3, 8, 3, 4);
  assert.equal(leadLag('BTC', short.spot, short.perp).verdict, 'too little data');
});

// ---- The spot pullback (bot/setups/detectors.ts spotpb) ----

/** 21 bars: a bullish fair value gap at bar 14 (zone 100-101), a dip into it with RSI 35, then the 21 EMA reclaimed on a
 *  green bar 20. `tweak` edits the bars / readings before the check. */
function pbSeries(tweak: (b: Array<{ ts: number; o: number; h: number; l: number; c: number; v: number }>, r: number[], e: number[]) => void = () => {}): SetupSeries {
  const b = Array.from({ length: 21 }, (_, i) => ({ ts: T0 + i * 3_600_000, o: 103, h: 103.5, l: 102.5, c: 103, v: 1 }));
  b[12] = { ...b[12], o: 99, h: 100, l: 98.5, c: 99.8 };
  b[13] = { ...b[13], o: 100, h: 102, l: 99.9, c: 101.8 };
  b[14] = { ...b[14], o: 101.8, h: 103, l: 101, c: 102.8 };
  for (const k of [15, 16]) b[k] = { ...b[k], o: 103, h: 103.2, l: 102, c: 102.2 };
  b[17] = { ...b[17], o: 102.2, h: 102.4, l: 100.5, c: 101.2 };
  b[18] = { ...b[18], o: 101.2, h: 101.6, l: 100.6, c: 101.3 };
  b[19] = { ...b[19], o: 101.3, h: 101.7, l: 101, c: 101.5 };
  b[20] = { ...b[20], o: 101.4, h: 102.5, l: 101.2, c: 102.2 };
  const r = b.map(() => 50); r[17] = 35;
  const e = b.map(() => 102); e[20] = 101.8;
  tweak(b, r, e);
  return { cs: b, rsi: r, ema21: e, atr: b.map(() => 1) } as unknown as SetupSeries;
}

test('spot pullback: an RSI dip into a fair value gap, then the 21 EMA reclaimed on a green bar, in an uptrend', () => {
  const sp = spotPullbackAt(pbSeries(), 20, 1)!;
  assert.equal(sp.dir, 1);
  assert.equal(sp.stop, 100 - 0.25, 'under the gap (below the last 3 bars too)');
  assert.equal(spotPullbackAt(pbSeries(), 20, -1), undefined, 'not against the trend');
  assert.equal(spotPullbackAt(pbSeries(), 20, 0), undefined, 'not without a trend');
  assert.equal(spotPullbackAt(pbSeries((_, r) => { r[17] = 45; }), 20, 1), undefined, 'needs the RSI dip');
  assert.equal(spotPullbackAt(pbSeries((b) => { b[18] = { ...b[18], c: 99.5 }; }), 20, 1), undefined, 'a close through the gap kills it');
  assert.equal(spotPullbackAt(pbSeries((b) => { b[20] = { ...b[20], o: 102.4 }; }), 20, 1), undefined, 'needs a green bar');
  assert.equal(spotPullbackAt(pbSeries((_, __, e) => { e[19] = 101; }), 20, 1), undefined, 'needs a reclaim (the bar before closed under the EMA)');
  assert.equal(spotPullbackAt(pbSeries((b) => { b[14] = { ...b[14], l: 99.9 }; b[13] = { ...b[13], l: 99 }; }), 20, 1), undefined, 'needs a gap');
});

test('spot pullback: the short mirror', () => {
  const m = pbSeries();
  const flip = (x: number) => 200 - x;
  const cs = m.cs.map((c) => ({ ...c, o: flip(c.o), c: flip(c.c), h: flip(c.l), l: flip(c.h) }));
  const s = { cs, rsi: m.rsi.map((v) => 100 - v), ema21: m.ema21.map(flip), atr: m.atr } as unknown as SetupSeries;
  const sp = spotPullbackAt(s, 20, -1)!;
  assert.equal(sp.dir, -1);
  assert.equal(sp.stop, 100 + 0.25);
});

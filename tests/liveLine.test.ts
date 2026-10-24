import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveLines } from '../bot/strategy/liveLine';

const SIGMA = 2e-5; // per-second volatility of the line (log units)
const T0 = 1_761_000_000_000;

/** A seeded random walk with per-second steps of about one sigma (a sum of uniforms, roughly normal). */
function walk(seed: number): () => number {
  let s = seed;
  const u = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  return () => (u() + u() + u() + u()) * Math.sqrt(3) * SIGMA;
}

test('live line: a drop out of the wiggle band for two seconds is the sell signal; one second is not; the other side gains', () => {
  const lines = new LiveLines({ aheadSec: 15, bandK: 2, bandMinSec: 60, confirmSec: 2 });
  const step = walk(5);
  let y = Math.log(100);
  for (let i = 0; i <= 300; i++) { y += step(); lines.observe('BTC', T0 + i * 1000, Math.exp(y), SIGMA); }
  // The window opened at T0: 285 seconds of wiggles around the 15 s projection.
  const r0 = lines.read('BTC', 1, false, T0 + 300_000, T0)!;
  assert.ok(r0.band && r0.projected !== undefined && r0.underSd !== undefined, JSON.stringify(r0));
  assert.equal(r0.band.sec, 285, 'the wiggles since the open (from 15 s on, when the first projection matured), the second read left out');
  assert.ok(r0.band.lower < r0.projected && r0.projected < r0.band.upper, JSON.stringify(r0));
  assert.equal(r0.broke, false);
  // The line drops twice the band's half-width under the projection and stays there.
  const half = Math.log(r0.band.upper / r0.band.lower) / 2;
  const low = Math.log(r0.projected) - 2 * half;
  const seen = [301, 302, 303].map((i) => { lines.observe('BTC', T0 + i * 1000, Math.exp(low), SIGMA); return lines.read('BTC', 1, false, T0 + i * 1000, T0)!; });
  assert.deepEqual(seen.map((r) => [r.breakSec, r.broke]), [[1, false], [2, true], [3, true]], JSON.stringify(seen));
  assert.ok(seen[1].underSd! >= 2, JSON.stringify(seen[1]));
  // The side that gains as the coin falls reads the same drop as a move its way: no break.
  const other = lines.read('BTC', -1, false, T0 + 303_000, T0)!;
  assert.deepEqual([other.breakSec, other.broke], [0, false]);
  assert.ok(other.underSd! < 0);
});

test('live line: ordinary wiggles touch a 2 sd band only now and then; a jump up breaks it for the side that gains as the coin falls', () => {
  const lines = new LiveLines({ aheadSec: 15, bandK: 2, bandMinSec: 60, confirmSec: 2 });
  const step = walk(11);
  let y = Math.log(3000);
  let brokeSec = 0, read = 0;
  for (let i = 0; i <= 3600; i++) {
    y += step();
    lines.observe('ETH', T0 + i * 1000, Math.exp(y), SIGMA);
    // A new 15-minute window every 900 s: the band starts over at each open.
    const r = lines.read('ETH', 1, false, T0 + i * 1000, T0 + Math.floor(i / 900) * 900_000);
    if (r?.band) { read++; if (r.broke) brokeSec++; }
  }
  assert.ok(read > 3000, `${read}`);
  // A random walk breaks a 2 sd band for two seconds or more 0.5-3.4% of the time (25 seeds; about 17 breaks an hour).
  assert.ok(brokeSec / read < 0.05, `outside the band for two seconds or more ${brokeSec} of ${read} s`);
  // Read only now (the count is the line's own): a jump up breaks the band for a side that gains as the coin falls.
  const r = lines.read('ETH', 1, false, T0 + 3_600_000, T0 + 3_600_000 - 900_000)!;
  const half = Math.log(r.band!.upper / r.band!.lower) / 2;
  for (let i = 3601; i <= 3603; i++) lines.observe('ETH', T0 + i * 1000, r.projected! * Math.exp(3 * half), SIGMA);
  const since = T0 + 3_600_000 - 900_000;
  assert.equal(lines.read('ETH', -1, false, T0 + 3_603_000, since)!.broke, true, 'the side that gains as the coin falls');
  assert.equal(lines.read('ETH', 1, false, T0 + 3_603_000, since)!.broke, false, 'the side that gains as it rises');
});

test('live line: the band waits for a minute of wiggles since the open; without an open it looks back 15 or 60 minutes', () => {
  const lines = new LiveLines({ aheadSec: 15, bandK: 2, bandMinSec: 60, confirmSec: 2 });
  const step = walk(3);
  let y = Math.log(150);
  for (let i = 0; i <= 200; i++) { y += step(); lines.observe('SOL', T0 + i * 1000, Math.exp(y), SIGMA); }
  const fresh = lines.read('SOL', 1, false, T0 + 200_000, T0 + 170_000)!;
  assert.equal(fresh.band, undefined, 'a window open 30 s: too few wiggles');
  assert.deepEqual([fresh.breakSec, fresh.broke], [0, false]);
  assert.equal(lines.read('SOL', 1, false, T0 + 200_000, T0 + 100_000)!.band?.sec, 100);
  // No open given: the last 15 minutes (all 185 wiggles here, less the one read).
  assert.equal(lines.read('SOL', 1, false, T0 + 200_000)!.band?.sec, 185);
});

test('live line: the heads-up shows a fading rise and its projected top; hourly contracts look three times as far', () => {
  const lines = new LiveLines({ aheadSec: 15, bandK: 2, bandMinSec: 60, confirmSec: 2 });
  // A rise whose speed halves and halves again: the momentum fades before the top.
  let y = 0;
  for (let i = 0; i <= 400; i++) {
    const speed = i < 200 ? 0.8 : i < 300 ? 0.35 : 0.15;
    y += speed * SIGMA;
    lines.observe('SOL', T0 + i * 1000, 100 * Math.exp(y), SIGMA);
  }
  const r = lines.read('SOL', 1, false, T0 + 400_000)!;
  assert.ok(r.peak, JSON.stringify(r));
  assert.ok(r.peak!.top > r.price, 'the projected top is above the line');
  // The hourly filter projects further: right after the line starts, it has no projection yet for 45 s.
  const fresh = new LiveLines({ aheadSec: 15, bandK: 2, bandMinSec: 60, confirmSec: 2 });
  for (let i = 0; i <= 20; i++) fresh.observe('XRP', T0 + i * 1000, 0.5, SIGMA);
  assert.notEqual(fresh.read('XRP', 1, false, T0 + 20_000)!.projected, undefined, '15-minute: projected after 15 s');
  assert.equal(fresh.read('XRP', 1, true, T0 + 20_000)!.projected, undefined, 'hourly: not before 45 s');
  // A line that stopped updating is not read.
  assert.equal(fresh.read('XRP', 1, false, T0 + 30_000), undefined);
});

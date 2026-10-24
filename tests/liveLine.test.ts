import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveLines } from '../bot/strategy/liveLine';

const SIGMA = 2e-5; // per-second volatility of the line (log units)
const T0 = 1_761_000_000_000;

/** Feeds one coin's line a point a second: `path(i)` is the log move from 100 after i seconds. */
function feed(lines: LiveLines, asset: string, from: number, to: number, path: (i: number) => number): void {
  for (let i = from; i <= to; i++) lines.observe(asset, T0 + i * 1000, 100 * Math.exp(path(i)), SIGMA);
}

test('live line: a steady rise holds; a drop below the projection by x noise for two seconds is the sell signal', () => {
  const lines = new LiveLines({ aheadSec: 15, xSigmas: 2, confirmSec: 2 });
  const rise = (i: number) => 0.4 * SIGMA * i;
  feed(lines, 'BTC', 0, 300, rise);
  const r = lines.read('BTC', 1, false, T0 + 300_000)!;
  assert.ok(r.projected !== undefined && r.slope > 0, JSON.stringify(r));
  assert.equal(r.broke, false);
  assert.ok(r.underSigmas! < 1, `a steady rise is on its projection: ${r.underSigmas}`);
  // The line turns and drops 1.5 noise units of the look-ahead a second: the first second it is under the projection
  // by x is a break, the second in a row is the signal.
  const top = rise(300);
  const drop = (i: number) => top - (i - 300) * 1.5 * SIGMA * Math.sqrt(15);
  const seen = [];
  for (let i = 301; i <= 305; i++) {
    lines.observe('BTC', T0 + i * 1000, 100 * Math.exp(drop(i)), SIGMA);
    seen.push(lines.read('BTC', 1, false, T0 + i * 1000)!);
  }
  const first = seen.findIndex((x) => x.breakSec === 1);
  assert.ok(first >= 0, JSON.stringify(seen));
  assert.equal(seen[first].broke, false, 'one second is not enough');
  assert.equal(seen[first + 1].broke, true, JSON.stringify(seen[first + 1]));
  assert.ok(seen[first + 1].underSigmas! >= 2);
  // The side that gains as the coin falls reads the same drop the other way: no break.
  assert.equal(lines.read('BTC', -1, false, T0 + 305_000)!.broke, false);
});

test('live line: noise-sized wiggles never break; the side that gains as the coin falls breaks on a jump up', () => {
  const lines = new LiveLines({ aheadSec: 15, xSigmas: 2, confirmSec: 2 });
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  let y = 0;
  let broke = 0;
  for (let i = 0; i <= 900; i++) {
    y += 0.6 * SIGMA * rnd();
    lines.observe('ETH', T0 + i * 1000, 100 * Math.exp(y), SIGMA);
    if (lines.read('ETH', 1, false, T0 + i * 1000)?.broke) broke++;
  }
  assert.equal(broke, 0, 'small noise never sells');
  // Read only now (the count is the line's own): a side that gains as the coin falls breaks on a jump up.
  for (let i = 901; i <= 903; i++) lines.observe('ETH', T0 + i * 1000, 100 * Math.exp(y + (i - 900) * 3 * SIGMA * Math.sqrt(15)), SIGMA);
  assert.equal(lines.read('ETH', -1, false, T0 + 903_000)!.broke, true, 'the side that gains as the coin falls');
  assert.equal(lines.read('ETH', 1, false, T0 + 903_000)!.broke, false, 'the side that gains as it rises');
});

test('live line: the heads-up shows a fading rise and its projected top; hourly contracts look three times as far', () => {
  const lines = new LiveLines({ aheadSec: 15, xSigmas: 2, confirmSec: 2 });
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
  const fresh = new LiveLines({ aheadSec: 15, xSigmas: 2, confirmSec: 2 });
  feed(fresh, 'XRP', 0, 20, () => 0);
  assert.notEqual(fresh.read('XRP', 1, false, T0 + 20_000)!.projected, undefined, '15-minute: projected after 15 s');
  assert.equal(fresh.read('XRP', 1, true, T0 + 20_000)!.projected, undefined, 'hourly: not before 45 s');
  // A line that stopped updating is not read.
  assert.equal(fresh.read('XRP', 1, false, T0 + 30_000), undefined);
});

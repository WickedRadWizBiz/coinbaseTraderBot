import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpotWallTracker, bandOutcomes, checkIntegrity, secondPath, topPerBand, type SpotBookLine } from '../research/spotWallStudy';

const line = (ts: number, mid: number, ask: number[], bid: number[] = ask): SpotBookLine & { t: number } => ({
  t: ts + 100, ts, b: [[mid - 0.5, 1], [mid - 1, 1]], a: [[mid + 0.5, 1], [mid + 1, 1]], bw: 10, bb: bid, ba: ask,
});

test('spot wall tracker: z against the band\'s own trailing history only, nearest wall past band 0', () => {
  const tr = new SpotWallTracker(240, 3);
  const flat = [5, 5, 5, 5];
  for (let i = 0; i < 3; i++) assert.ok(Number.isNaN(tr.add('BTC', line(i * 15_000, 100_000, flat))!.zAsk[2]));
  // Band 2 jumps to 4x its history: a wall at the near edge of band 2 (20 bps over the mid); band 0 is never a wall.
  const v = tr.add('BTC', line(45_000, 100_000, [50, 5, 20, 5], flat))!;
  assert.equal(v.zAsk[2], 4);
  assert.equal(v.zAsk[0], 10);
  assert.equal(tr.wallLevel('BTC', 50_000, true), 100_000 * (1 + 2 * 0.001));
  assert.equal(tr.wallLevel('BTC', 50_000, false), undefined);
  // Too old: no level.
  assert.equal(tr.wallLevel('BTC', 45_000 + 61_000, true), undefined);
  // The wall itself is now part of band 2's history (the next line's median moves).
  assert.equal(tr.add('BTC', line(60_000, 100_000, flat))!.zAsk[2], 1);
});

test('band outcomes: touch, far edge and bounce per band, either side; holes and short paths give nothing', () => {
  // mid 100, 1% bands: up through band 1 (101), not band 2's edge (102), back down to 100 (a bounce of band 1).
  const px = Float64Array.from([100, 100.5, 101.2, 101.9, 101.5, 100.9, 100, 99.5, 99, 98.9]);
  const up = bandOutcomes(px, 0, 8, 100, 0.01, 3, true)!;
  assert.equal(up.touch[1], 2);
  assert.equal(up.touch[2], Infinity);
  assert.equal(up.bounce[1], 6);
  const down = bandOutcomes(px, 0, 9, 100, 0.01, 3, false)!;
  assert.equal(down.touch[1], 8);
  assert.equal(down.touch[2], Infinity);
  assert.equal(bandOutcomes(px, 0, 10, 100, 0.01, 3, true), undefined); // the path ends inside the horizon
  const hole = Float64Array.from([100, NaN, 101, 101, 101]);
  assert.equal(bandOutcomes(hole, 0, 3, 100, 0.01, 3, true), undefined);
  // Broke through: band 1 touched and its far edge reached, so it did not hold (and a later dip is no bounce).
  const thru = Float64Array.from([100, 101, 102.1, 100, 100, 100]);
  const t = bandOutcomes(thru, 0, 4, 100, 0.01, 3, true)!;
  assert.equal(t.touch[1], 1);
  assert.equal(t.touch[2], 2);
  assert.equal(t.bounce[1], Infinity);
});

test('second path carries the last price of each second forward', () => {
  const { t0, px } = secondPath([1_000_500, 10, 1_000_900, 11, 1_003_100, 12]);
  assert.equal(t0, 1000);
  assert.deepEqual([...px], [11, 11, 11, 12]);
});

test('integrity: a clean book passes; crossed, cut-short or out-of-step books fail', () => {
  const ticks: number[] = [];
  const lines: Array<SpotBookLine & { t: number }> = [];
  for (let i = 0; i < 1200; i++) {
    const ts = 1_000_000 + i * 15_000;
    ticks.push(ts - 1000, 100_000);
    const l = line(ts, 100_000, [5, 5, 5, 5]);
    l.b = [[99_999.5, 1 + (i % 3)], [99_999, 1]];
    lines.push(l);
  }
  // Top levels sit in band 0 (0.5 and 1 off a 100,000 mid = under 1 bps): bands hold 5 >= 2-4.
  assert.deepEqual(topPerBand(lines[0].a, 100_000, 10, 4), [2, 0, 0, 0]);
  const ok = checkIntegrity('BTC', lines, ticks);
  assert.equal(ok.pass, true, ok.why.join('; '));
  assert.ok(ok.coverage > 0.99);
  const cut = lines.map((l) => ({ ...l, ba: [5, 5, 5, 0] }));
  assert.match(checkIntegrity('BTC', cut, ticks).why.join(';'), /outer bands/);
  const off = ticks.map((x, i) => (i % 2 ? 100_100 : x));
  assert.match(checkIntegrity('BTC', lines, off).why.join(';'), /mid vs ticker/);
  const small = lines.map((l) => ({ ...l, ba: [1, 5, 5, 5] }));
  assert.match(checkIntegrity('BTC', small, ticks).why.join(';'), /contain the top/);
});

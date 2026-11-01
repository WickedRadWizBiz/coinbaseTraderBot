import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { test } from 'node:test';
import { fillDayFile, fillQuotes, QUOTE_FILLS, type Ev } from '../research/goLiveTally';
import { asHistory, bridgeSigma, compareWindows, newCarry, onDays, sliceDays } from '../research/replayFidelity';
import { tmpDir } from './helpers';
import { DepthSim, readDepthModel } from '../research/history/depthSim';

const depth = readDepthModel(path.join(import.meta.dirname, 'fixtures', 'depth_model.json'))!;

const D0 = Date.UTC(2026, 9, 20);
const MIN = 60_000;

/** A recorded day's first 20 minutes: BTC's index every second (a slow wave), one 15-minute Up/Down contract opening at
 *  00:00 whose real quotes move every 5 s, and a trade every 20 s. */
function recordedDay(dir: string): { file: string; closeAt: (t: number) => [number, number] } {
  const lines: Ev[] = [{ t: D0 - MIN, k: 'market', ticker: 'KXBTC15M-A', series: 'KXBTC15M', asset: 'BTC', kind: 'updown', strike: 100_000, cap: null, openTime: D0, closeTime: D0 + 15 * MIN }];
  const quote = (t: number): [number, number] => { const b = Math.round(40 + 10 * Math.sin(t / 97_000)); return [b / 100, (b + 2) / 100]; };
  for (let t = D0; t < D0 + 20 * MIN; t += 1000) {
    lines.push({ t, k: 'index', asset: 'BTC', value: 100_000 * (1 + 0.001 * Math.sin(t / 60_000) + 0.0002 * Math.sin(t / 7_000)) });
    if (t % 5000 === 0 && t <= D0 + 15 * MIN) { const [b, a] = quote(t); lines.push({ t, k: 'book', ticker: 'KXBTC15M-A', bids: [{ price: b, size: 50 }], asks: [{ price: a, size: 70 }] }); }
    if (t % 20_000 === 10_000 && t <= D0 + 15 * MIN) lines.push({ t, k: 'trade', ticker: 'KXBTC15M-A', price: 0.41, count: 3, takerSide: 'yes', ts: t });
    if (t === D0 + 15 * MIN + 1000) lines.push({ t, k: 'result', ticker: 'KXBTC15M-A', result: 'yes' });
  }
  const file = path.join(dir, 'md-2026-10-20.jsonl.gz');
  fs.writeFileSync(file, zlib.gzipSync(lines.map((e) => JSON.stringify(e)).join('\n') + '\n'));
  return { file, closeAt: (m: number) => quote(Math.ceil(m / 5000) * 5000 - 5000) };
}

const read = (f: string) => zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Ev);

test('a recorded day cut down to the history\'s minute candles and filled back in as the replay does', async () => {
  const dir = tmpDir();
  const { file, closeAt } = recordedDay(dir);
  const out = path.join(dir, 'out.jsonl.gz');
  const res = await asHistory({ day: '2026-10-20', file }, out, newCarry());
  const evs = read(out);
  // In time order, with everything but the contract's own quotes and trades as recorded.
  assert.ok(evs.every((e, i) => i === 0 || e.t >= evs[i - 1].t));
  assert.equal(evs.filter((e) => e.k === 'index').length, 20 * 60);
  assert.equal(evs.filter((e) => e.k === 'result').length, 1);
  const books = evs.filter((e) => e.k === 'book');
  // No real quote is left: the history's sizes are nominal 100 a side.
  assert.ok(books.every((b) => b.bids![0].size === 100 && b.asks![0].size === 100));
  // A candle's close is the quote standing just before its minute mark, never a later one.
  const candles = books.filter((b) => b.t % MIN === 0);
  assert.ok(candles.length >= 14);
  for (const c of candles.slice(1)) assert.deepEqual([c.bids![0].price, c.asks![0].price], closeAt(c.t), `candle at ${(c.t - D0) / MIN} min`);
  // Between the candles the quote follows the index at the quarter-minute prints.
  assert.ok(books.some((b) => b.t % MIN === 15_000));
  // The minute's trades as one at its last price, just before the candle.
  const trades = evs.filter((e) => e.k === 'trade');
  assert.ok(trades.length >= 14 && trades.every((x) => x.t % MIN === 0 && x.count === 9 && x.ts === x.t - 1));
  assert.ok(res.n > 0 && res.f > 0 && res.r2 >= 0);
});

test('the noise fill-in is pinned at the candles and grows with the measured size', () => {
  const evs: Ev[] = [
    { t: 0, k: 'market', ticker: 'X' },
    { t: MIN, k: 'book', ticker: 'X', bids: [{ price: 0.40, size: 100 }], asks: [{ price: 0.42, size: 100 }] },
    { t: MIN + 15_000, k: 'book', ticker: 'X', bids: [{ price: 0.40, size: 100 }], asks: [{ price: 0.42, size: 100 }] },
    { t: MIN + 30_000, k: 'book', ticker: 'X', bids: [{ price: 0.40, size: 100 }], asks: [{ price: 0.42, size: 100 }] },
  ];
  const quiet = fillQuotes(evs, { how: 'noise', sigma: 0 });
  assert.deepEqual(quiet, evs);
  const loud = fillQuotes(evs, { how: 'noise', sigma: 0.05 });
  assert.deepEqual(loud[1], evs[1]);
  assert.ok(loud.slice(2).some((e, i) => e.bids![0].price !== evs[i + 2].bids![0].price));
  // The spread is kept.
  for (const e of loud.slice(1)) assert.ok(Math.abs(e.asks![0].price - e.bids![0].price - 0.02) < 1e-9);
  // Hold leaves only the candles.
  assert.deepEqual(fillQuotes(evs, { how: 'hold' }).filter((e) => e.k === 'book').map((e) => e.t), [MIN]);
});

test('the bridge size and the window-by-window comparison', () => {
  assert.equal(bridgeSigma([{ r2: 8, f: 2, n: 4 }, { r2: 10, f: 2.5, n: 5 }]), 2);
  const real = new Map([[1, { pnl: 1, contracts: 1, fees: 0 }], [2, { pnl: -1, contracts: 1 }]]);
  const rows = compareWindows(real, { same: real, high: new Map([[1, { pnl: 2, contracts: 1, fees: 0 }], [2, { pnl: 0, contracts: 1 }], [3, { pnl: 1, contracts: 1, fees: 0 }]]) });
  assert.deepEqual(rows[0], { how: 'same', pnl: 0, windowsTraded: 2, biasUsd: 0, rmseUsd: 0, corr: 1 });
  assert.equal(rows[1].biasUsd, 3);
  assert.equal(rows[1].windowsTraded, 3);
  assert.equal(rows[1].rmseUsd, 1);
});

test('a day is filled in line by line exactly as the whole-day fill does it', async () => {
  const dir = tmpDir();
  const { file } = recordedDay(dir);
  const evs = read(file);
  for (const how of QUOTE_FILLS) {
    const out = path.join(dir, `${how}.jsonl.gz`);
    await fillDayFile(file, out, { how, sigma: 0.05 }, depth);
    assert.deepEqual(read(out), fillQuotes(evs, { how, sigma: 0.05 }, depth), how);
  }
});

test('the depth fill-in plays a whole book around each quote, the same every time', () => {
  const dir = tmpDir();
  const evs = read(recordedDay(dir).file);
  const a = fillQuotes(evs, { how: 'depth' }, depth), b = fillQuotes(evs, { how: 'depth' }, depth);
  assert.deepEqual(a, b, 'seeded: the same day plays out the same wherever it is replayed');
  assert.ok(a.every((e, i) => i === 0 || e.t >= a[i - 1].t), 'in time order');
  const books = a.filter((e) => e.k === 'book' && e.ticker === 'KXBTC15M-A');
  const requoted = fillQuotes(evs, { how: 'requote' }).filter((e) => e.k === 'book' && e.ticker === 'KXBTC15M-A');
  // Each quote is still the best bid and ask, now with levels behind it.
  assert.equal(books.length, requoted.length);
  for (let i = 0; i < books.length; i++) assert.deepEqual([books[i].bids![0].price, books[i].asks![0].price], [requoted[i].bids![0].price, requoted[i].asks![0].price]);
  assert.ok(books.some((x) => x.bids!.length > 1 && x.asks!.length > 1));
  assert.ok(a.some((e) => e.k === 'delta') && a.some((e) => e.k === 'trade' && e.sim === 1), 'changes and trades between the quotes');
  // The recorded trades give way to the simulated ones.
  assert.ok(a.filter((e) => e.k === 'trade').every((e) => e.sim === 1));
  assert.throws(() => fillQuotes(evs, { how: 'depth' }), /depth model/);
});

test('the depth simulator steps in tenths of a cent below 10 cents and above 90, whole cents between', () => {
  const sim = new DepthSim(depth);
  const tail = sim.play('KXBTC15M-U', D0, 0.052, 0.054, D0, D0 + 10 * MIN)[0];
  assert.deepEqual([(tail.bids as Array<{ price: number }>)[0].price, (tail.asks as Array<{ price: number }>)[0].price], [0.052, 0.054]);
  assert.ok((tail.bids as Array<{ price: number }>).every((l) => l.price <= 0.052 && l.price > 0.052 - 0.0105), 'ten tenth-cent ticks behind the best bid');
  const mid = sim.play('KXBTC15M-V', D0, 0.45, 0.46, D0, D0 + 10 * MIN)[0];
  assert.ok([...(mid.bids as Array<{ price: number }>), ...(mid.asks as Array<{ price: number }>)].every((l) => Math.round(l.price * 1000) % 10 === 0), 'whole cents in the middle');
});

test('the days split into parts, each read from the day before it, and only their own windows compared', () => {
  const dir = tmpDir();
  for (const d of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']) fs.writeFileSync(path.join(dir, `md-${d}.jsonl.gz`), zlib.gzipSync(''));
  const day = (x: { day: string }) => x.day;
  const whole = sliceDays(dir, 4, 0, 1);
  assert.deepEqual([whole.warm && day(whole.warm), whole.days.map(day)], ['2026-10-20', ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']]);
  const b = sliceDays(dir, 4, 1, 2);
  assert.deepEqual([b.warm && day(b.warm), b.days.map(day)], ['2026-10-22', ['2026-10-23', '2026-10-24']]);
  const at = (d: string, h: number) => Date.parse(`${d}T00:00:00Z`) + h * 3_600_000;
  const w = new Map([[at('2026-10-22', 12), { pnl: 1, contracts: 1, fees: 0 }], [at('2026-10-23', 12), { pnl: 2, contracts: 1, fees: 0 }], [at('2026-10-24', 0), { pnl: 3, contracts: 1, fees: 0 }]]);
  // The warm-up day's windows are left out; a window closing at midnight belongs to the day before.
  assert.deepEqual([...onDays(w, ['2026-10-23']).values()].map((x) => x.pnl), [2, 3]);
});

test('the depth simulator trades the way the price goes: YES takers lift the asks before a rise, NO takers hit the bids before a fall', () => {
  // The fixture's cell, with the study's flow by move: on the way up 90% YES takers, flat 50%, down 10%.
  const moved = { ...depth, shape: depth.shape.map((c) => ({ ...c, byMove: [
    { segs: 100, tradesPerSec: 2, takerYesShare: 0.1 }, { segs: 100, tradesPerSec: 0.5, takerYesShare: 0.5 }, { segs: 100, tradesPerSec: 2, takerYesShare: 0.9 }] })) };
  const yesShare = (nextMid?: number) => {
    let yes = 0, all = 0;
    for (let i = 0; i < 40; i++) {
      const sim = new DepthSim(moved);
      for (const e of sim.play(`KXBTC15M-${i}`, D0 + i * 15_000, 0.45, 0.47, D0 + i * 15_000 + 15_000, D0 + 10 * MIN, nextMid)) if (e.k === 'trade') { all++; if (e.takerSide === 'yes') yes++; }
    }
    return { share: yes / Math.max(1, all), all };
  };
  const up = yesShare(0.50), down = yesShare(0.42), flat = yesShare(0.46);
  assert.ok(up.share > 0.75, `before a rise: ${up.share}`);
  assert.ok(down.share < 0.25, `before a fall: ${down.share}`);
  assert.ok(flat.all < up.all / 2, 'fewer trades while the price stands still');
  // Without the next quote (or without the study's flow by move), the flow over all moves, as before.
  const plain = new DepthSim(depth).play('KXBTC15M-P', D0, 0.45, 0.47, D0 + 15_000, D0 + 10 * MIN, 0.50);
  assert.deepEqual(plain, new DepthSim(depth).play('KXBTC15M-P', D0, 0.45, 0.47, D0 + 15_000, D0 + 10 * MIN));
});

test('the depth fill-in plays each quote with the next one in view, and still writes in time order', () => {
  const dir = tmpDir();
  const evs = read(recordedDay(dir).file);
  const moved = { ...depth, shape: depth.shape.map((c) => ({ ...c, byMove: [
    { segs: 100, tradesPerSec: 3, takerYesShare: 0 }, { segs: 100, tradesPerSec: 0, takerYesShare: 0.5 }, { segs: 100, tradesPerSec: 3, takerYesShare: 1 }] })) };
  const out = fillQuotes(evs, { how: 'depth' }, moved);
  assert.ok(out.every((e, i) => i === 0 || e.t >= out[i - 1].t), 'in time order');
  assert.equal(out.length, new Set(out).size);
  const books = out.filter((e) => e.k === 'book' && e.ticker === 'KXBTC15M-A');
  assert.equal(books.length, fillQuotes(evs, { how: 'requote' }).filter((e) => e.k === 'book' && e.ticker === 'KXBTC15M-A').length);
  // Each simulated trade's side matches where the mid went from its quote to the next one.
  let checked = 0;
  for (let i = 0; i + 1 < books.length; i++) {
    const m0 = (books[i].bids![0].price + books[i].asks![0].price) / 2, m1 = (books[i + 1].bids![0].price + books[i + 1].asks![0].price) / 2;
    const trades = out.filter((e) => e.k === 'trade' && e.t >= books[i].t && e.t < books[i + 1].t);
    if (Math.abs(m1 - m0) < 0.006) { assert.equal(trades.length, 0, 'no trades while the price stands still'); continue; }
    for (const x of trades) { assert.equal(x.takerSide, m1 > m0 ? 'yes' : 'no'); checked++; }
  }
  assert.ok(checked > 0);
  // Every record of the day still comes out, the settlement last.
  assert.equal(out.filter((e) => e.k === 'result').length, 1);
  assert.equal(out.filter((e) => e.k === 'index').length, evs.filter((e) => e.k === 'index').length);
});

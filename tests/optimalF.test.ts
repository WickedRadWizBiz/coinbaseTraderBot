import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binaryTrades, capRisk, drawdownScale, growthOptimalG, maxDrawdownR, optimalF, recencyWeight, type WeightedTrade } from '../bot/strategy/optimalF';
import { LaneBook, DEFAULT_LANES } from '../bot/setups/lanes';
import type { SetupSignal } from '../bot/setups/detectors';

const DAY = 86_400_000;

test('growth-optimal g: Kelly for a two-outcome bet, 0 without an edge, bounded by the worst loss', () => {
  // +2R or -1R at even odds: Kelly g* = p - q / b = 0.5 - 0.5 / 2 = 0.25.
  assert.ok(Math.abs(growthOptimalG([2, -1, 2, -1]) - 0.25) < 1e-6);
  // 60 % at +1R / -1R: g* = 0.2.
  assert.ok(Math.abs(growthOptimalG([1, 1, 1, -1, -1]) - 0.2) < 1e-6);
  assert.equal(growthOptimalG([1, -1]), 0, 'zero mean: nothing');
  assert.equal(growthOptimalG([0.5, -1, -1]), 0, 'negative mean: nothing');
  // A -3R outlier caps g below 1/3 whatever the rest says.
  assert.ok(growthOptimalG([1, 1, 1, 1, 1, 1, 1, 1, -3]) < 1 / 3);
  // Weights: the losing trades weighted down -> larger g.
  assert.ok(growthOptimalG([2, -1, 2, -1], [1, 0.5, 1, 0.5]) > 0.25);
});

test('max drawdown of cumulative R', () => {
  assert.equal(maxDrawdownR([1, 1, -1, -2, 1, 3, -1]), 3);
  assert.equal(maxDrawdownR([1, 2, 3]), 0);
});

/** A repeatable trade stream: win rate p at +winR, else -1R. */
function stream(n: number, p: number, winR: number, seed = 5, t0 = Date.UTC(2024, 0, 1)): WeightedTrade[] {
  let x = seed; const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  return Array.from({ length: n }, (_, i) => ({ ts: t0 + i * DAY, r: rnd() < p ? winR : -1 }));
}

test('optimal f: bootstrap quantiles bracket g*, the cap is the 25th percentile, the drawdown band is positive', () => {
  const rep = optimalF(stream(600, 0.45, 2));
  assert.equal(rep.n, 600);
  assert.ok(rep.gStar > 0.1 && rep.gStar < 0.3, `g* ${rep.gStar}`);
  assert.ok(rep.gP25 <= rep.gP50 && rep.gP50 <= rep.gP75);
  assert.ok(Math.abs(rep.gP50 - rep.gStar) < 0.06, 'the median resample is near the full-history optimum');
  assert.equal(rep.cap, rep.gP25);
  assert.ok(rep.cap < rep.gStar, 'the cap is below full optimal f');
  assert.ok(rep.ddP95R > 3 && rep.ddP95R < 60, `dd p95 ${rep.ddP95R}R`);
  assert.ok(Math.abs(rep.fStar - rep.gStar) < 1e-12, 'worst loss -1R: Vince f* = g*');
});

test('optimal f: a losing history caps at 0; a short one applies no cap', () => {
  const bad = optimalF(stream(300, 0.3, 1.5));
  assert.equal(bad.gStar, 0);
  assert.equal(bad.cap, 0);
  const short = optimalF(stream(20, 0.5, 2));
  assert.equal(short.cap, Infinity);
  assert.match(short.note ?? '', /need 50/);
});

test('optimal f follows recent trades: a strategy that stopped working loses its cap when live trades weigh in', () => {
  const now = Date.UTC(2026, 9, 1);
  const old = stream(400, 0.5, 2, 7, now - 400 * DAY - 400 * DAY).map((t) => ({ ...t, w: recencyWeight(t.ts, now, 365) }));
  const before = optimalF(old);
  const liveBad = stream(150, 0.25, 2, 9, now - 150 * DAY).map((t) => ({ ...t, w: recencyWeight(t.ts, now, 365, 2) }));
  const after = optimalF([...old, ...liveBad]);
  assert.ok(before.cap > 0.1);
  assert.ok(after.cap < before.cap / 2, `cap ${before.cap} -> ${after.cap}`);
});

test('recency weight halves per half-life; live trades count liveMult', () => {
  const now = 1000 * DAY;
  assert.equal(recencyWeight(now, now, 365), 1);
  assert.ok(Math.abs(recencyWeight(now - 365 * DAY, now, 365) - 0.5) < 1e-12);
  assert.equal(recencyWeight(now, now, 365, 2), 2);
});

test('drawdown scale: halves beyond the 95th percentile, holds until back under half of it', () => {
  assert.deepEqual(drawdownScale(5, 10, false), { scale: 1, cut: false });
  assert.deepEqual(drawdownScale(11, 10, false), { scale: 0.5, cut: true });
  assert.deepEqual(drawdownScale(7, 10, true), { scale: 0.5, cut: true });
  assert.deepEqual(drawdownScale(4, 10, true), { scale: 1, cut: false });
  assert.deepEqual(drawdownScale(50, NaN, false), { scale: 1, cut: false }, 'no band: no cut');
  assert.equal(capRisk(0.02, { cap: 0.01 }), 0.01);
  assert.equal(capRisk(0.005, { cap: 0.01 }), 0.005, 'never raises a size');
  assert.equal(capRisk(0.02, { cap: Infinity }), 0.02);
});

test('lane book: the optimal f cap limits risk at the stop, the drawdown scale halves it, a zero cap skips', () => {
  const sig = (asset: string): SetupSignal => ({ asset, lane: 'fast', tf: '1h', kind: 'burst', dir: 1, ref: 100, stop: 98, ts: 0, atr: 1, plan: { target1: 104, trailAtr: 2 } } as unknown as SetupSignal);
  const run = (cap?: { cap: number; scale: number }) => {
    const b = new LaneBook({ ...DEFAULT_LANES, fast: { ...DEFAULT_LANES.fast, riskFrac: 0.02, minScore: 0, refScore: 0.2 }, maxLeverage: 100, maxAssetLeverage: 100 });
    if (cap) b.riskCaps.fast = cap;
    b.offer(sig('ETH'), 0.2, 0);
    return b.select(0, 10_000, () => ({ px: 100, score: 0.2 }));
  };
  const free = run();
  assert.equal(free.length, 1);
  assert.ok(Math.abs(free[0].notional - 10_000) < 1e-6, '2 % of $10k at a 2 % stop = $10k notional');
  const capped = run({ cap: 0.005, scale: 1 });
  assert.ok(Math.abs(capped[0].notional - 2_500) < 1e-6, 'capped at 0.5 % at risk');
  assert.match(capped[0].capped ?? '', /optimal f cap 0\.50%/);
  const cut = run({ cap: 0.005, scale: 0.5 });
  assert.ok(Math.abs(cut[0].notional - 1_250) < 1e-6);
  assert.equal(run({ cap: 0, scale: 1 }).length, 0, 'no edge in the history: no trade');
});

test('Kalshi entries -> one trade per settled market, fee-loaded stake, R per dollar staked', () => {
  const rows = [
    { ts: 1, ticker: 'A', cost: 0.4, count: 2, won: true, book: 'crypto' },
    { ts: 2, ticker: 'A', cost: 0.5, count: 1, won: true, book: 'crypto' },
    { ts: 3, ticker: 'B', cost: 0.6, count: 1, won: false, book: 'crypto' },
    { ts: 4, ticker: 'C', cost: 0.5, count: 1, won: true, book: 'tennis' },
  ];
  const t = binaryTrades(rows, 'crypto');
  assert.equal(t.length, 2);
  const stakeA = 2 * (0.4 + 0.07 * 0.4 * 0.6) + (0.5 + 0.07 * 0.25);
  assert.ok(Math.abs(t[0].r - (3 - stakeA) / stakeA) < 1e-12);
  assert.equal(t[0].ts, 2);
  assert.equal(t[1].r, -1);
  assert.equal(binaryTrades(rows).length, 3, 'no book filter: all markets');
});

// Strategy playbook: per coin regime (character x Hilbert trend/cycle), the weight of each strategy family,
// learned from replay coin-days and switched on only after walk-forward validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cycleState, RegimeTracker } from '../bot/ta/regime';
import { taEngine } from '../bot/ta/talib';
import { Playbook, weightsFor, type PlaybookFile } from '../bot/strategy/playbook';
import { applyWeights, buildPlaybook, learnWeights, MIN_SAMPLES, type CoinDay } from '../research/playbook';
import { LaneBook, DEFAULT_LANES } from '../bot/setups/lanes';
import type { SetupSignal } from '../bot/setups/detectors';

test('regime tracker: a new regime is adopted only after it held for the confirm count', () => {
  const t = new RegimeTracker(2);
  assert.equal(t.update('calm:cycle', 1), 'calm:cycle');
  assert.equal(t.update('trending:trend', 2), 'calm:cycle', 'one hour is not a new regime');
  assert.equal(t.update('calm:cycle', 3), 'calm:cycle', 'flip back: pending cleared');
  assert.equal(t.update('trending:trend', 4), 'calm:cycle');
  assert.equal(t.update('trending:trend', 5), 'trending:trend', 'held twice: adopted');
  assert.equal(t.since, 5);
});

test('cycle state: Hilbert trend mode on log closes is the same at any price scale', { skip: taEngine() !== 'talib' && 'TA-Lib not available' }, () => {
  const bars = (scale: number, f: (i: number) => number) => Array.from({ length: 200 }, (_, i) => { const c = scale * f(i); return { ts: i * 3_600_000, o: c, h: c, l: c, c, v: 1 }; });
  const wave = (i: number) => Math.exp(0.02 * Math.sin((2 * Math.PI * i) / 20));
  const a = cycleState(bars(60000, wave)), b = cycleState(bars(0.1, wave));
  assert.deepEqual(a, b, 'BTC-sized and DOGE-sized prices read alike');
  assert.equal(a.mode, 'cycle');
  assert.ok(a.period! > 15 && a.period! < 25, `dominant cycle ~20 bars (${a.period})`);
  assert.equal(cycleState(bars(100, (i) => Math.exp(0.003 * i))).mode, 'trend');
  assert.deepEqual(cycleState(bars(100, wave).slice(0, 50)), {}, 'too few bars');
});

const pb = (entries: PlaybookFile['entries'], enabled = true): PlaybookFile => ({ schema: 'playbook1', version: 'v1', at: 'x', enabled, entries });

test('playbook lookup: exact regime, then its character, then neutral; off or missing = neutral; weights clamped', () => {
  const f = pb({ 'trending:trend': { kalshi: 0.5, perps: 1.5, days: 20 }, calm: { kalshi: 1, perps: 0, days: 30 }, volatile_systemic: { kalshi: 7, perps: -1, days: 9 } });
  assert.deepEqual(weightsFor(f, 'trending:trend'), { kalshi: 0.5, perps: 1.5, source: 'trending:trend' });
  assert.deepEqual(weightsFor(f, 'calm:cycle'), { kalshi: 1, perps: 0, source: 'calm' });
  assert.deepEqual(weightsFor(f, 'volatile_systemic:trend'), { kalshi: 1, perps: 0, source: 'volatile_systemic' }, 'clamped to [0, 1] and [0, 1.5]');
  assert.equal(weightsFor(f, 'volatile_idio:cycle').kalshi, 1);
  assert.equal(weightsFor(f, undefined).source, 'no regime yet');
  assert.match(weightsFor(pb(f.entries, false), 'calm').source, /off/);
  assert.equal(weightsFor(undefined, 'calm').source, 'no playbook');
});

test('playbook holder: re-reads the file when it changes; PLAYBOOK_APPLY=false ignores it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
  const h = new Playbook(dir);
  assert.equal(h.weights('calm', 0).source, 'no playbook');
  fs.writeFileSync(path.join(dir, 'playbook.json'), JSON.stringify(pb({ calm: { kalshi: 0, perps: 1, days: 10 } })));
  assert.equal(h.weights('calm', 10).source, 'no playbook', 'checked at most every 30 s');
  assert.equal(h.weights('calm', 40_000).kalshi, 0);
  assert.equal(new Playbook(dir, false).weights('calm', 40_000).source, 'no playbook');
});

/** Coin-days: Kalshi earns in calm, loses in trending; perps the opposite; BTC calm, SOL trending the same days. */
function samples(n: number, flip = false): CoinDay[] {
  const out: CoinDay[] = [];
  for (let i = 0; i < n; i++) {
    const day = new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    const j = (i % 5) - 2;
    const s = flip ? -1 : 1;
    out.push({ day, asset: 'BTC', regime: 'calm:cycle', kalshi: s * (3 + j), perps: s * (-2 + 0.5 * j) });
    out.push({ day, asset: 'SOL', regime: 'trending:trend', kalshi: s * (-3 + j), perps: s * (4 + j) });
  }
  return out;
}

test('learned weights: a family that loses in a regime gets no risk there, one that clearly earns gets its maximum', () => {
  const w = learnWeights(samples(40));
  assert.deepEqual([w['calm:cycle'].kalshi, w['calm:cycle'].perps], [1, 0]);
  assert.deepEqual([w['trending:trend'].kalshi, w['trending:trend'].perps], [0, 1.5]);
  assert.ok(w.calm && w.trending, 'character-level entries for the fallback');
  assert.equal(Object.keys(learnWeights(samples(MIN_SAMPLES - 1))).length, 0, 'too few coin-days: no entry (neutral)');
  // Per coin: the same day, BTC calm and SOL trending get different weights.
  const a = applyWeights(samples(1), w);
  assert.deepEqual([a.static[0], a.switched[0]], [(3 - 2 - 2 - 1) + (-3 - 2 + 4 - 2), (3 - 2) * 1 + (-2 - 1) * 0 + (-3 - 2) * 0 + (4 - 2) * 1.5]);
});

test('playbook validation: switched on only when the weights learned early beat the static bot on the later days', () => {
  const good = buildPlaybook(samples(60), { version: 'v', at: 'x' });
  assert.equal(good.enabled, true, good.validation?.why);
  assert.ok(good.validation!.switchedUsd > good.validation!.staticUsd);
  // The relationship flips after the learning span: the early weights hurt on the later days.
  const flipped = [...samples(42), ...samples(60, true).slice(84)];
  const bad = buildPlaybook(flipped, { version: 'v', at: 'x' });
  assert.equal(bad.enabled, false);
  assert.match(bad.validation!.why, /static bot/);
  assert.equal(buildPlaybook(samples(20), { version: 'v', at: 'x' }).enabled, false, 'fewer than 10 validation days');
  assert.equal(buildPlaybook([], { version: 'v', at: 'x' }).enabled, false);
});

test('setup lanes: a playbook weight of 0 skips the entry, 1.5 raises its risk by half', () => {
  const sig = { asset: 'ETH', lane: 'fast', tf: '1h', kind: 'burst', dir: 1, ref: 100, stop: 98, ts: 0, atr: 1, plan: { target1: 104, trailAtr: 2 } } as unknown as SetupSignal;
  const go = (weight?: number) => {
    const b = new LaneBook({ ...DEFAULT_LANES, fast: { ...DEFAULT_LANES.fast, riskFrac: 0.01, minScore: 0, refScore: 0.2 }, maxLeverage: 100, maxAssetLeverage: 100 });
    b.offer(sig, 0.2, 0);
    return b.select(0, 10_000, () => ({ px: 100, score: 0.2, weight }));
  };
  assert.equal(go(0).length, 0);
  assert.ok(Math.abs(go(undefined)[0].notional - 5_000) < 1e-6, '1 % of $10k at a 2 % stop');
  assert.ok(Math.abs(go(1.5)[0].notional - 7_500) < 1e-6);
});

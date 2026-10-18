// The Compensator: per strategy, a learned ramp of its weight on the coin's Librarian reading, fitted against
// hindsight on replay coin-days and switched on only when it beats the static bot and the step playbook later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { Compensator, compInputs, rampWeight, weightOfP, type CompensatorFile, type CompRamp, type LibDayReading } from '../bot/strategy/compensator';
import { applyRamps, buildCompensator, compSamples, fitLogistic, fitRamp, type CompSample } from '../research/compensator';
import type { CoinDay } from '../research/playbook';
import { tmpDir } from './helpers';

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

test('weight of the probability of paying: floor at 0, 1 at even odds, ceiling at 1, linear between', () => {
  assert.equal(weightOfP(0, 0, 1.5), 0);
  assert.equal(weightOfP(0.5, 0, 1.5), 1);
  assert.equal(weightOfP(1, 0, 1.5), 1.5);
  assert.equal(weightOfP(0.25, 0, 1.5), 0.5);
  assert.equal(weightOfP(0.75, 0, 1), 1, 'Kalshi never goes above 1');
});

test('weighted ridge logistic: recovers slope and threshold; the ridge pulls a flat fit toward even odds', () => {
  const r = rng(3), z: number[] = [], y: number[] = [], w: number[] = [];
  for (let i = 0; i < 4000; i++) { const x = r() * 4 - 2; z.push(x); y.push(r() < 1 / (1 + Math.exp(-(0.5 + 2 * x))) ? 1 : 0); w.push(1); }
  const f = fitLogistic(z, y, w, 1);
  assert.ok(Math.abs(f.b - 2) < 0.25 && Math.abs(f.a - 0.5) < 0.15, `a ${f.a} b ${f.b}`);
  const few = fitLogistic([0, 0, 0], [1, 1, 1], [1, 1, 1], 10, true);
  assert.ok(few.a > 0 && few.a < 0.6, `three wins barely move it (${few.a})`);
});

/** Coin-days where the trend family's Librarian weight decides whether the breakout setups pay; Kalshi is noise. */
function world(n: number, seed: number) {
  const r = rng(seed), cds: CoinDay[] = [], bySetup: Record<string, Record<string, Record<string, number>>> = {}, lib = new Map<string, LibDayReading>();
  for (let d = 0; d < n; d++) {
    const day = new Date(Date.UTC(2025, 0, 1) + d * 86_400_000).toISOString().slice(0, 10);
    for (const asset of ['BTC', 'ETH', 'SOL']) {
      const trend = r();
      lib.set(`${asset}|${day}`, { w: [trend, (1 - trend) / 2, (1 - trend) / 2, 0], net: trend - 0.5, transition: 0.3 });
      const breakout = (trend > 0.5 ? 1 : -1) * (1 + r()) + (r() - 0.5) * 0.4;
      const kalshi = (r() - 0.5) * 2;
      cds.push({ day, asset, regime: 'calm:cycle', kalshi, perps: breakout });
      ((bySetup[day] ??= {})[asset] ??= {}).breakout = breakout;
    }
  }
  const index = { at: (asset: string, t: number) => lib.get(`${asset}|${new Date(t).toISOString().slice(0, 10)}`) };
  return { cds, bySetup, index };
}

test('a strategy that pays only when the trend reading is high gets a rising ramp; a noise strategy stays flat', () => {
  const W = world(120, 5);
  const s = compSamples(W.cds, W.bySetup, W.index);
  assert.ok(s.every((x) => x.x), 'every coin-day has its day-start reading');
  const br = fitRamp(s, 'setup:breakout');
  assert.ok(br.input === 'lib_trend' || br.input === 'lib_net' || br.input === 'lib_revert', `breakout ramp on ${br.input}`);
  const lowTrend = compInputs({ w: [0.1, 0.45, 0.45, 0], net: -0.4, transition: 0.3 }), highTrend = compInputs({ w: [0.9, 0.05, 0.05, 0], net: 0.4, transition: 0.3 });
  assert.ok(rampWeight(br, lowTrend, 'setup:breakout') < 0.3, `low trend: ${rampWeight(br, lowTrend, 'setup:breakout')}`);
  assert.ok(rampWeight(br, highTrend, 'setup:breakout') > 1.2, `high trend: ${rampWeight(br, highTrend, 'setup:breakout')}`);
  const k = fitRamp(s, 'kalshi');
  assert.equal(k.input, null, `Kalshi noise: ${k.why}`);
  assert.ok(Math.abs(rampWeight(k, highTrend, 'kalshi') - 1) < 0.3);
  assert.equal(fitRamp(s.slice(0, 5), 'setup:breakout').why?.includes('need'), true, 'too few coin-days: neutral');
});

test('switched on only when the ramps beat the static bot and the step playbook on the later days', () => {
  const W = world(150, 9);
  const s = compSamples(W.cds, W.bySetup, W.index);
  const f = buildCompensator(s, W.cds, { version: 'v', at: 'x' });
  assert.equal(f.enabled, true, f.validation?.why);
  assert.ok(f.validation!.compUsd > f.validation!.staticUsd && f.validation!.compUsd > f.validation!.playbookUsd);
  // No edge in the readings: the breakout P&L no longer follows the trend reading.
  const flat = s.map((x): CompSample => ({ ...x, pnl: { ...x.pnl, 'setup:breakout': (x.pnl['setup:breakout'] ?? 0) * (rng(x.day.length + x.asset.charCodeAt(0))() < 0.5 ? 1 : -1) } }));
  const g = buildCompensator(flat, W.cds, { version: 'v', at: 'x' });
  assert.equal(g.validation!.days > 0, true);
  const noLib = buildCompensator(compSamples(W.cds, W.bySetup, undefined), W.cds, { version: 'v', at: 'x' });
  assert.equal(noLib.enabled, false);
  assert.match(noLib.validation!.why, /Librarian/);
  const t = applyRamps(s, {});
  assert.deepEqual(t.comp, t.static, 'no ramps: the static bot');
});

test('live holder: off or missing = undefined (the playbook applies); one reading per coin per UTC day', () => {
  const dir = tmpDir();
  const ramp: CompRamp = { input: 'lib_trend', k: 10, theta: 0.5, base: 0.5, lo: 0, hi: 1.5, n: 100, devianceDrop: 50 };
  const file: CompensatorFile = { schema: 'comp1', version: 'v1', at: 'x', enabled: true, ramps: { 'setup:breakout': ramp } };
  const day0 = Date.UTC(2026, 0, 5, 0, 30);
  const c = new Compensator(dir);
  assert.equal(c.weight('BTC', 'setup:breakout', day0, () => ({ w: [0.9, 0, 0, 0.1], net: 0.5, transition: 0.1 })), undefined, 'no file');
  fs.writeFileSync(path.join(dir, 'compensator.json'), JSON.stringify(file));
  const c2 = new Compensator(dir);
  let reads = 0;
  const read = (t: number) => () => { reads++; return { w: [t, 0, 0, 1 - t], net: 0, transition: 0.1 }; };
  const a = c2.weight('BTC', 'setup:breakout', day0, read(0.9))!;
  assert.ok(a.w > 1.4, `high trend reading: x${a.w}`);
  const b = c2.weight('BTC', 'setup:breakout', day0 + 3 * 3_600_000, read(0.1))!;
  assert.equal(b.w, a.w, 'same day: the morning reading holds');
  assert.equal(reads, 1);
  const next = c2.weight('BTC', 'setup:breakout', day0 + 86_400_000, read(0.1))!;
  assert.ok(next.w < 0.1, `next day re-read: x${next.w}`);
  assert.equal(c2.weight('BTC', 'kalshi', day0 + 86_400_000, read(0.1))!.w, 1, 'no ramp for the strategy: neutral');
  assert.equal(c2.weight('ETH', 'kalshi', day0, () => undefined), undefined, 'no reading yet: the playbook applies');
  fs.writeFileSync(path.join(dir, 'compensator.json'), JSON.stringify({ ...file, enabled: false }));
  assert.equal(new Compensator(dir).weight('BTC', 'setup:breakout', day0, read(0.9)), undefined, 'failed validation: off');
  fs.writeFileSync(path.join(dir, 'compensator.json'), JSON.stringify(file));
  assert.equal(new Compensator(dir, false).weight('BTC', 'setup:breakout', day0, read(0.9)), undefined, 'COMPENSATOR_APPLY=false');
});

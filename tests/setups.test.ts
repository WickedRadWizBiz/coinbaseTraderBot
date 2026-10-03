// Setup detectors, trade management and the lane book (bot/setups).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '../bot/ta/indicators';
import { detectAt, detectLast, setupSeries, type SetupSignal } from '../bot/setups/detectors';
import { openTrade, stepTrade, tradeResult, type CostModel } from '../bot/setups/exits';

const bar = (ts: number, o: number, h: number, l: number, c: number): Candle => ({ ts, o, h, l, c, v: 1 });
const FREE: CostModel = { entry: 0, makerExit: 0, takerExit: 0, fundingPer8h: 0 };
const M15 = 900_000;
const fade = (dir: 1 | -1, stop: number, t1: number, t2: number): SetupSignal => ({ asset: 'BTC', lane: 'fast', kind: 'fade', tf: '15m', dir, ts: 0, ref: 100, stop, atr: 1, plan: { target1: t1, target2: t2, trailAtr: 1.5, maxBars: 4 }, info: { rsi: 75, pctB: 1, flow: 0.4, bandwidth: 0.05, volRatio: 1 } });

test('trade management: half off at the first target, stop to break-even, rest at the final target', () => {
  const t = openTrade(fade(-1, 102, 98, 96), 100, 0, FREE)!;
  assert.ok(t);
  assert.equal(stepTrade(t, bar(0, 100, 100.5, 97.8, 98.2), M15, FREE), false);
  assert.equal(t.partialDone, true); assert.equal(t.frac, 0.5); assert.equal(t.stop, 100, 'stop to break-even');
  assert.equal(stepTrade(t, bar(M15, 98.2, 98.5, 95.5, 96), M15, FREE), true);
  assert.equal(t.closed?.reason, 'target');
  const r = tradeResult(t);
  assert.ok(Math.abs(r.ret - (0.5 * 0.02 + 0.5 * 0.04)) < 1e-12);
  assert.ok(Math.abs(r.r - 1.5) < 1e-9, '1.5R: 0.5 x 1R + 0.5 x 2R');
});

test('trade management: stop first when a bar touches stop and target; gaps fill at the open; break-even after partial', () => {
  const a = openTrade(fade(1, 98, 102, 104), 100, 0, FREE)!;
  stepTrade(a, bar(0, 100, 102.5, 97.5, 101), M15, FREE);
  assert.equal(a.closed?.reason, 'stop'); assert.ok(Math.abs(tradeResult(a).r + 1) < 1e-12);
  const g = openTrade(fade(1, 98, 102, 104), 100, 0, FREE)!;
  stepTrade(g, bar(0, 97, 97.5, 96, 97), M15, FREE);
  assert.ok(Math.abs(tradeResult(g).ret - -0.03) < 1e-12, 'gap through the stop exits at the open');
  const b = openTrade(fade(1, 98, 102, 104), 100, 0, FREE)!;
  stepTrade(b, bar(0, 100, 102.2, 99.5, 101.5), M15, FREE);
  stepTrade(b, bar(M15, 101.5, 101.6, 99.9, 100.2), M15, FREE);
  assert.equal(b.closed?.reason, 'breakeven');
  assert.ok(Math.abs(tradeResult(b).ret - 0.01) < 1e-12, 'half at +2%, half at 0');
});

test('trade management: trail tightens only after the first target (fast) and from the start (slow); time stop', () => {
  const s: SetupSignal = { ...fade(1, 95, 0, 0), lane: 'slow', kind: 'breakout', tf: '1d', plan: { trailAtr: 2, maxBars: 3 } };
  const t = openTrade(s, 100, 0, FREE)!;
  stepTrade(t, bar(0, 100, 104, 99.5, 104), 86_400_000, FREE, { close: 104, atr: 1 });
  assert.equal(t.stop, 102, 'best close 104 - 2 ATR');
  stepTrade(t, bar(1, 104, 104.5, 103, 103.2), 86_400_000, FREE, { close: 103.2, atr: 1 });
  assert.equal(t.stop, 102, 'never loosens');
  stepTrade(t, bar(2, 103.2, 104, 102.5, 103.5), 86_400_000, FREE, { close: 103.5, atr: 1 });
  assert.equal(t.closed?.reason, 'time');
  const f = openTrade(fade(1, 98, 103, 110), 100, 0, FREE)!;
  stepTrade(f, bar(0, 100, 101, 99.5, 101), M15, FREE, { close: 101, atr: 1 });
  assert.equal(f.stop, 98, 'fast lane: no trail before the first target');
  assert.equal(openTrade(fade(1, 98, 99, 104), 100, 0, FREE), undefined, 'price already past the first target: setup gone');
  assert.equal(openTrade(fade(1, 99.95, 102, 104), 100, 0, FREE), undefined, 'stop too close');
});

test('costs: entry, maker target exits, taker stops, funding', () => {
  const C: CostModel = { entry: 0.001, makerExit: 0.0005, takerExit: 0.001, fundingPer8h: 0.0001 };
  const t = openTrade(fade(1, 98, 102, 104), 100, 0, C)!;
  stepTrade(t, bar(0, 100, 104.5, 99.8, 104), 28_800_000, C);
  assert.ok(Math.abs(t.costs - (0.001 + 0.0001 + 0.5 * 0.0005 + 0.5 * 0.0005)) < 1e-12);
});

/** A random walk with taker flow, long enough for every indicator. */
function walk(n: number, seed: number, step = 900_000): Candle[] {
  let x = seed >>> 0; const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out: Candle[] = []; let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p; p *= Math.exp((rnd() - 0.5) * 0.02 + 0.004 * Math.sin(i / 30));
    const h = Math.max(o, p) * (1 + rnd() * 0.004), l = Math.min(o, p) * (1 - rnd() * 0.004), v = 1 + rnd();
    out.push({ ts: Date.UTC(2025, 0, 1) + i * step, o, h, l, c: p, v, tb: v * (p > o ? 0.5 + rnd() * 0.3 : 0.2 + rnd() * 0.3) });
  }
  return out;
}

test('detectors: same setups on the full history and on the live 320-bar window (parity), and they fire', () => {
  for (const [tf, step] of [['15m', 900_000], ['1h', 3_600_000], ['1d', 86_400_000]] as const) {
    const cs = walk(3000, 7, step);
    const s = setupSeries(cs, tf);
    let fired = 0, checked = 0;
    for (let i = 400; i < cs.length; i++) {
      const full = detectAt('X', tf, s, i);
      if (!full && i % 7) continue;
      const live = detectLast('X', tf, cs.slice(i - 319, i + 1));
      checked++;
      assert.equal(live?.kind, full?.kind, `${tf} bar ${i}`);
      assert.equal(live?.dir, full?.dir);
      if (full) { fired++; assert.ok(Math.abs(live!.stop - full.stop) < 1e-9 * full.ref); assert.ok(full.dir * (full.ref - full.stop) > 0, 'stop on the losing side'); }
    }
    assert.ok(fired > 3, `${tf}: setups fired (${fired} of ${checked})`);
  }
});

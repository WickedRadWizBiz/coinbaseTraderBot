import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyScaleOut, SCALE_OUT, type SetupSignal } from '../bot/setups/detectors';
import { openTrade, stepTrade, tradeResult, type CostModel } from '../bot/setups/exits';

const T0 = Date.UTC(2026, 0, 5);
const H = 3_600_000;
const NOFEE: CostModel = { entry: 0, makerExit: 0, takerExit: 0, fundingPer8h: 0 };
const sig = (o: Partial<SetupSignal> = {}): SetupSignal => ({
  asset: 'BTC', lane: 'fast', kind: 'pullback', tf: '1h', dir: 1, ts: T0, ref: 100, stop: 95, atr: 2,
  plan: { target1: 105, target2: 110, trailAtr: 2, maxBars: 48 }, info: { rsi: 50, pctB: 0.5, flow: 0.5, bandwidth: 0.02, volRatio: 1 },
  ...o,
} as SetupSignal);
const bar = (i: number, o: number, h: number, l: number, c: number) => ({ ts: T0 + i * H, o, h, l, c, v: 1 });
const on = { ...SCALE_OUT, lanes: 'both' as const, r1: 1, f1: 0.33, r2: 2, f2: 0.33, trailAtr: 2.5 };

test('scale-out: off or another lane leaves the signal alone; on, the steps replace both targets and leave a share to trail', () => {
  const s = sig();
  assert.equal(applyScaleOut(s, { ...on, lanes: 'off' }), s);
  assert.equal(applyScaleOut(s, { ...on, lanes: 'slow' }), s);
  const g = applyScaleOut(s, on);
  assert.equal(g.plan.target1, undefined); assert.equal(g.plan.target2, undefined);
  assert.deepEqual(g.plan.scaleOut, { steps: [{ r: 1, frac: 0.33 }, { r: 2, frac: 0.33 }], trailAtr: 2.5 });
  assert.equal(g.plan.trailAtr, 2, 'the lane trail is kept for before the first step');
  const greedy = applyScaleOut(s, { ...on, f1: 0.7, f2: 0.7 });
  assert.ok(Math.abs(greedy.plan.scaleOut!.steps.reduce((a, x) => a + x.frac, 0) - 0.95) < 1e-12, 'at least 5% always trails');
  assert.equal(applyScaleOut(s, { ...on, f2: 0 }).plan.scaleOut!.steps.length, 1);
});

test('scale-out: a share off at each R multiple, break-even after the first, the rest trailed by the setup timeframe ATR', () => {
  const t = openTrade(applyScaleOut(sig(), on), 100, T0, NOFEE)!;
  assert.equal(stepTrade(t, bar(1, 100, 104, 99, 103), H, NOFEE, { close: 103, atr: 2 }), false);
  assert.equal(t.frac, 1);
  // 1R: a third off at 105, stop to break-even.
  assert.equal(stepTrade(t, bar(2, 103, 105.5, 102, 105), H, NOFEE, { close: 105, atr: 2 }), false);
  assert.ok(Math.abs(t.frac - 0.67) < 1e-12 && t.stop === 100 && t.partialDone);
  assert.equal(t.scaled, 1);
  // A gap open above 2R fills the second step at the open; the trail then follows the best close by 2.5 ATR.
  assert.equal(stepTrade(t, bar(3, 111, 113, 110.5, 112), H, NOFEE, { close: 112, atr: 2 }), false);
  assert.ok(Math.abs(t.frac - 0.34) < 1e-12);
  assert.equal(t.scaled, 2);
  assert.equal(t.stop, 107);
  assert.equal(stepTrade(t, bar(4, 110, 110, 106, 106.5), H, NOFEE), true);
  assert.equal(t.closed!.reason, 'trail');
  const want = 0.33 * 0.05 + 0.33 * 0.11 + 0.34 * 0.07;
  assert.ok(Math.abs(tradeResult(t).ret - want) < 1e-12, `${tradeResult(t).ret} vs ${want}`);
  assert.ok(Math.abs(tradeResult(t).r - want / 0.05) < 1e-9);
});

test('scale-out: a bar that touches the stop and a step resolves against the trade; shorts mirror; fees by exit kind', () => {
  const t = openTrade(applyScaleOut(sig(), on), 100, T0, NOFEE)!;
  assert.equal(stepTrade(t, bar(1, 100, 106, 94, 100), H, NOFEE), true);
  assert.equal(t.closed!.reason, 'stop');
  assert.equal(t.scaled, undefined);
  const costs: CostModel = { entry: 0.001, makerExit: 0.0005, takerExit: 0.002, fundingPer8h: 0 };
  const s = openTrade(applyScaleOut(sig({ dir: -1, stop: 105, plan: { target1: 95, trailAtr: 2, maxBars: 48 } }), on), 100, T0, costs)!;
  stepTrade(s, bar(1, 100, 100.5, 94.5, 95), H, costs, { close: 95, atr: 2 });
  assert.ok(Math.abs(s.frac - 0.67) < 1e-12 && s.stop === 100, 'short: a third off at 95, stop to the entry');
  stepTrade(s, bar(2, 95, 100.2, 95, 100), H, costs);
  assert.equal(s.closed!.reason, 'breakeven');
  const r = tradeResult(s);
  assert.ok(Math.abs(r.ret - (0.33 * 0.05 - 0.001 - 0.33 * 0.0005 - 0.67 * 0.002)) < 1e-12, String(r.ret));
});

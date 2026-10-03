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

test('lane book: queue by score, re-check before entry, slow lane first, one position per asset, caps', async () => {
  const { LaneBook } = await import('../bot/setups/lanes');
  const P = {
    fast: { maxPositions: 2, riskFrac: 0.01, ttlBars: 2, minScore: 0.1, refScore: 0.2, maxChaseR: 0.3 },
    slow: { maxPositions: 1, riskFrac: 0.01, ttlBars: 1, minScore: 0.1, refScore: 0.2, maxChaseR: 0.5 },
    maxLeverage: 3, maxAssetLeverage: 2,
  };
  const book = new LaneBook(P);
  const sig = (asset: string, lane: 'fast' | 'slow', dir: 1 | -1 = 1): SetupSignal => ({ ...fade(dir, dir > 0 ? 98 : 102, dir > 0 ? 102 : 98, dir > 0 ? 104 : 96), asset, lane, tf: lane === 'slow' ? '1d' : '15m', ts: 0 });
  assert.equal(book.offer(sig('A', 'fast'), 0.05, 0), false, 'below the minimum score');
  book.offer(sig('A', 'fast'), 0.15, 0);
  book.offer(sig('B', 'fast'), 0.4, 0);
  book.offer(sig('C', 'fast'), 0.3, 0);
  book.offer(sig('B', 'slow'), 0.2, 0);
  assert.deepEqual(book.queues.fast.map((c) => c.sig.asset), ['B', 'C', 'A'], 'best first');
  const px: Record<string, number> = { A: 100, B: 100, C: 100.9 };
  const entries = book.select(60_000, 10_000, (c) => ({ px: px[c.sig.asset], score: c.score }));
  // Slow lane takes B; fast lane: B busy (waits), C chased 0.45R > 0.3R (dropped), A taken.
  assert.deepEqual(entries.map((e) => `${e.cand.sig.lane}:${e.cand.sig.asset}`), ['slow:B', 'fast:A']);
  assert.ok(book.lastSkips.some((s) => s.asset === 'C' && /not chasing/.test(s.reason)));
  assert.deepEqual(book.queues.fast.map((c) => c.sig.asset), ['B'], 'B still queued for the fast lane');
  // Size: 1% risk x scale (0.2 / 0.2 = 1) / 2% stop distance = 50% of equity.
  assert.ok(Math.abs(entries[0].notional - 5000) < 1e-6);
  assert.ok(Math.abs(entries[1].notional - 3750) < 1e-6, 'score 0.15 -> 0.75x: 0.75% risk / 2% stop');
  // A re-check that lowers the score below the minimum drops the candidate.
  const b2 = new LaneBook(P);
  b2.offer(sig('D', 'fast'), 0.5, 0);
  assert.equal(b2.select(1, 10_000, (c) => ({ px: 100, score: 0.05 })).length, 0);
  assert.equal(b2.queues.fast.length, 0);
  // Expiry: a 15m candidate with ttl 2 bars expires 3 bars after its open.
  const b3 = new LaneBook(P);
  b3.offer(sig('E', 'fast'), 0.5, 0);
  assert.equal(b3.select(3 * 900_000, 10_000, () => ({ px: 100, score: 0.5 })).length, 0);
  // Leverage cap: tiny stop distance -> notional capped at maxAssetLeverage x equity.
  const b4 = new LaneBook(P);
  b4.offer({ ...sig('F', 'fast'), stop: 99.9, atr: 0.2 }, 0.2, 0);
  assert.equal(b4.select(1, 10_000, () => ({ px: 100, score: 0.2 }))[0].notional, 20_000);
});

test('live setup trader: detects on a closed candle, queues, re-checks, enters with an exchange stop, exits on the stop', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { CandleSet } = await import('../bot/ta/candleStore');
  const { PerpHub } = await import('../bot/perps/perpData');
  const { SetupTrader, defaultSetupParams } = await import('../bot/setups/setupTrader');
  const { SETUP_FEATURES } = await import('../bot/setups/features');
  const { SETUP_SCHEMA } = await import('../bot/setups/setupModel');
  const { DEFAULT_LANES } = await import('../bot/setups/lanes');
  // Find a 15m setup in a synthetic series; the candle store holds the bars up to and including it.
  const all = walk(3000, 11);
  const s = setupSeries(all, '15m');
  let at = -1;
  for (let i = 1500; i < all.length - 50; i++) if (detectAt('BTC', '15m', s, i)?.lane === 'fast') { at = i; break; }
  assert.ok(at > 0, 'a setup exists');
  const sig = detectAt('BTC', '15m', s, at)!;
  const dir = tmpDir();
  function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'setups-')); }
  const modelFile = path.join(dir, 'setup_model.json');
  fs.writeFileSync(modelFile, JSON.stringify({
    version: 'test', schema: SETUP_SCHEMA, features: SETUP_FEATURES, lanes: { fast: { meanR: 0.4, trades: 1000 }, slow: { meanR: 0.4, trades: 100 } },
    book: { ...DEFAULT_LANES, fast: { ...DEFAULT_LANES.fast, minScore: 0.1, refScore: 0.4 } }, costs: {}, equityUsd: 10000,
    validation: { fast: { periods: {}, trials: 1, passed: true, reasons: [] } }, trainedAt: '', data: {},
  }));
  const set = new CandleSet('BTC');
  const now = all[at].ts + 900_000 + 5_000;
  set.add('15m', all.slice(0, at + 1).slice(-320), now);
  const hourly = (k: number) => all.slice(0, at + 1).filter((c) => c.ts % 3_600_000 === 0).slice(-k);
  set.add('1h', hourly(320).map((c) => ({ ...c })), now);
  const hub = new PerpHub();
  const px = { v: sig.ref };
  hub.apply({ ticker: 'BTC-PERP', asset: 'BTC', ts: now, bid: px.v * 1.001 - 0.01, ask: px.v * 1.001 + 0.01, fractional: true });
  const gateway = { name: 'fake', createOrder: async () => { throw new Error('no'); }, cancelOrder: async () => {}, getOpenOrders: async () => [], getPositions: async () => [], getBalance: async () => ({ equity: 10_000, available: 10_000 }) } as never;
  const trader = new SetupTrader({ params: defaultSetupParams({ pilotMaxNotionalUsd: 1e9 }), hub, gateway, modelPath: modelFile, statePath: path.join(dir, 'state.json'), candles: (a) => (a === 'BTC' ? set : undefined), spot: () => px.v });
  const t1 = await trader.targets({ positions: new Map(), hedge: [], now }, {});
  const tgt = t1.find((t) => t.asset === 'BTC')!;
  assert.notEqual(tgt.target, 0, `entered: ${tgt.reason}`);
  assert.equal(Math.sign(tgt.target), sig.dir);
  assert.ok(tgt.stopPrice && Math.abs(tgt.stopPrice / (sig.stop * 1.001) - 1) < 1e-3, 'exchange stop = spot stop x perp/spot ratio');
  assert.ok(fs.existsSync(path.join(dir, 'state.json')), 'book saved');
  // A restarted trader resumes the open trade.
  const again = new SetupTrader({ params: defaultSetupParams({ pilotMaxNotionalUsd: 1e9 }), hub, gateway, modelPath: modelFile, statePath: path.join(dir, 'state.json'), candles: () => set, spot: () => px.v });
  assert.equal(again.book.positions.size, 1);
  // Price through the stop: flat, urgent, recorded as a stop.
  px.v = sig.stop - sig.dir * sig.atr;
  hub.apply({ ticker: 'BTC-PERP', asset: 'BTC', ts: now + 60_000, bid: px.v - 0.01, ask: px.v + 0.01 });
  const t2 = await trader.targets({ positions: new Map([['BTC-PERP', { ticker: 'BTC-PERP', position: tgt.target } as never]]), hedge: [], now: now + 60_000 }, {});
  const out = t2.find((t) => t.asset === 'BTC')!;
  assert.equal(out.target, 0); assert.equal(out.urgent, true);
  const st = trader.status();
  assert.equal(st.recentTrades[0].reason, 'stop');
  assert.ok(st.recentTrades[0].r < -0.9);
});

test('lane score: percentile of the prediction in the calibration quantiles; no model -> 1 or 0 by the lane average', async () => {
  const { laneScore, quantilesOf } = await import('../bot/setups/setupModel');
  const q = quantilesOf(Array.from({ length: 1001 }, (_, i) => i / 1000 - 0.5));
  assert.equal(q.length, 101);
  // A one-leaf "model" adding a constant to meanR.
  const lane = (add: number) => ({ meanR: 0, trades: 1, quantiles: q, model: { baseScore: 0, trees: [[{ f: -1, t: 0, l: 0, r: 0, v: add }]] } as never });
  assert.ok(Math.abs(laneScore(lane(0), []) - 0.5) < 0.01);
  assert.ok(Math.abs(laneScore(lane(0.4), []) - 0.9) < 0.01);
  assert.equal(laneScore(lane(9), []), 1);
  assert.equal(laneScore(lane(-9), []), 0);
  assert.equal(laneScore({ meanR: 0.3, trades: 10 }, []), 1);
  assert.equal(laneScore({ meanR: -0.3, trades: 10 }, []), 0);
});

test('lane book: fixed dollar risk per trade, and trades whose first target pays under the minimum are skipped', async () => {
  const { LaneBook } = await import('../bot/setups/lanes');
  const P = {
    fast: { maxPositions: 3, riskFrac: 0.004, ttlBars: 2, minScore: 0, refScore: 0.5, maxChaseR: 0.3, riskUsd: 5 },
    slow: { maxPositions: 1, riskFrac: 0.01, ttlBars: 1, minScore: 0, refScore: 0.5, maxChaseR: 0.5 },
    maxLeverage: 10, maxAssetLeverage: 10, minTargetUsd: 2, roundTripFee: 0.0026,
  };
  const book = new LaneBook(P);
  // Stop 2% away, $5 risk -> $250 notional; first target 2% away pays 250 x (0.02 - 0.0026) = $4.35.
  book.offer({ ...fade(1, 98, 102, 104), asset: 'A' }, 0.5, 0);
  // Stop 2% away, first target only 0.5% away: pays 250 x (0.005 - 0.0026) = $0.60 < $2 -> skipped.
  book.offer({ ...fade(1, 98, 100.5, 104), asset: 'B' }, 0.5, 0);
  const e = book.select(1, 100, (c) => ({ px: 100, score: 0.5 }));
  assert.deepEqual(e.map((x) => x.cand.sig.asset), ['A']);
  assert.ok(Math.abs(e[0].notional - 250) < 1e-6, 'fixed $5 at risk over a 2% stop');
  assert.ok(book.lastSkips.some((s) => s.asset === 'B' && /first target pays \$0\.60/.test(s.reason)));
});

test('lane book: per-type thresholds; types missing from the map are not traded', async () => {
  const { LaneBook } = await import('../bot/setups/lanes');
  const book = new LaneBook({
    fast: { maxPositions: 3, riskFrac: 0.01, ttlBars: 2, minScore: 0, refScore: 0.5, maxChaseR: 0.3, minScoreByKind: { '1h burst': 0.8 } },
    slow: { maxPositions: 1, riskFrac: 0.01, ttlBars: 1, minScore: 0, refScore: 0.5, maxChaseR: 0.5 },
    maxLeverage: 10, maxAssetLeverage: 10,
  });
  const burst = (asset: string): SetupSignal => ({ ...fade(1, 98, 102, 104), asset, kind: 'burst', tf: '1h' });
  assert.equal(book.offer({ ...fade(1, 98, 102, 104), asset: 'A' }, 0.99, 0), false, '15m fade not traded');
  assert.equal(book.offer(burst('B'), 0.7, 0), false, 'below its own threshold');
  assert.equal(book.offer(burst('C'), 0.9, 0), true);
});

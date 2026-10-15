// Risk mechanics (task 5.3): liquidation beyond the stop (bot/risk/liquidation.ts), the 4h ATR ratchet exit
// (bot/setups/detectors.ts RATCHET, bot/setups/exits.ts) and the live guards in the setup and perp traders.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liquidationInsideStop, liquidationLeverageCap, maintenanceRate, maxSafeNotional, reservedFor, safeShare } from '../bot/risk/liquidation';
import { applyRatchet, ATR4H_WINDOW_H1, atr4hAt, detectAt, setupSeries, type RatchetSettings, type SetupSignal } from '../bot/setups/detectors';
import { openTrade, stepTrade, type CostModel } from '../bot/setups/exits';
import { aggregate } from '../bot/ta/candleStore';
import { atr, type Candle } from '../bot/ta/indicators';
import { decidePerp, type PerpDecisionInput, type PerpTraderParams } from '../bot/perps/perpTrader';

const bar = (ts: number, o: number, h: number, l: number, c: number): Candle => ({ ts, o, h, l, c, v: 1 });
const FREE: CostModel = { entry: 0, makerExit: 0, takerExit: 0, fundingPer8h: 0 };
const H1 = 3_600_000, D1 = 86_400_000;

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

test('liquidation: the largest safe notional puts the liquidation 25% beyond the stop (buffer 0.2), after the other positions', () => {
  // $1,000 equity, 2% stop, 5% maintenance: N <= 0.8 x 1000 / 0.07.
  const n = maxSafeNotional({ equity: 1000, stopFrac: 0.02, mmr: 0.05, buffer: 0.2 });
  assert.ok(Math.abs(n - 800 / 0.07) < 1e-9, `${n}`);
  // Liquidation after a move of A / N - m: at that size it is stop / 0.8 + 0.2 m / 0.8 away.
  const liqMove = 1000 / n - 0.05;
  assert.ok(Math.abs(liqMove - (0.02 / 0.8 + (0.2 * 0.05) / 0.8)) < 1e-12);
  assert.equal(liquidationInsideStop({ dir: 1, entry: 100, stop: 98, liquidation: 100 * (1 - liqMove), buffer: 0.2 }), false);
  assert.ok(Math.abs(liquidationLeverageCap(0.02, 0.05, 0.2) - n / 1000) < 1e-12);
  // The other positions' losses at their stops and maintenance margin come off the equity first.
  const other = reservedFor({ notional: 2000, entry: 50, stop: 49, dir: 1, mmr: 0.05 });
  assert.ok(Math.abs(other - 2000 * (0.02 + 0.05)) < 1e-9);
  assert.ok(Math.abs(maxSafeNotional({ equity: 1000, reserved: other, stopFrac: 0.02, mmr: 0.05, buffer: 0.2 }) - (0.8 * (1000 - other)) / 0.07) < 1e-9);
  // A stop locking a profit ties up only the maintenance margin; nothing left -> 0.
  assert.ok(Math.abs(reservedFor({ notional: 2000, entry: 50, stop: 51, dir: 1, mmr: 0.05 }) - 100) < 1e-9);
  assert.equal(maxSafeNotional({ equity: 1000, reserved: 1200, stopFrac: 0.02, mmr: 0.05, buffer: 0.2 }), 0);
  // Maintenance rate: configured, else half the initial margin of the exchange's leverage estimate, else 5%.
  assert.equal(maintenanceRate(10), 0.05); assert.equal(maintenanceRate(20, 0.01), 0.01); assert.equal(maintenanceRate(undefined), 0.05);
});

test('liquidation: an estimate too close to the stop is cut back to the required distance; shorts mirror longs', () => {
  // Long from 100, stop 98 (2%): the liquidation must be at least 2.5% away; the exchange says 97.8 (2.2%).
  const o = { dir: 1 as const, entry: 100, stop: 98, liquidation: 97.8, mmr: 0.05, buffer: 0.2 };
  assert.equal(liquidationInsideStop(o), true);
  const k = safeShare(o);
  assert.ok(Math.abs(k - (0.022 + 0.05) / (0.025 + 0.05)) < 1e-12);
  // Cutting N by k moves the liquidation to (L + m) / k - m: exactly the required 2.5%.
  assert.ok(Math.abs((0.022 + 0.05) / k - 0.05 - 0.025) < 1e-12);
  assert.equal(safeShare({ ...o, liquidation: 97 }), 1, 'far enough: unchanged');
  const s = { dir: -1 as const, entry: 100, stop: 102, liquidation: 102.2, mmr: 0.05, buffer: 0.2 };
  assert.ok(Math.abs(safeShare(s) - k) < 1e-12, 'the short mirrors the long');
  // A stop past the entry (profit locked): the liquidation must still lie beyond the stop (below it, for a long).
  assert.equal(liquidationInsideStop({ dir: 1, entry: 100, stop: 101, liquidation: 101.5, buffer: 0.2 }), true);
  assert.equal(liquidationInsideStop({ dir: 1, entry: 100, stop: 101, liquidation: 100.5, buffer: 0.2 }), false);
  assert.equal(safeShare({ dir: 1, entry: 100, stop: 101, liquidation: 101.5, mmr: 0.05, buffer: 0.2 }), 0.5, 'halve and look again');
  assert.equal(liquidationInsideStop({ dir: 1, entry: 100, stop: 98, liquidation: 0, buffer: 0.2 }), false, 'no estimate: nothing to judge');
});

test('4h ATR ratchet: break-even plus fees after 2 ATR, then a 3 ATR trail from 3.5 ATR; only tightens; replaces the regular trail', () => {
  const plan = { trailAtr: 1, maxBars: 50, ratchet: { atr: 10, beAtr: 2, trailStartAtr: 3.5, trailAtr: 3, fee: 0.002 } };
  const sig = { asset: 'BTC', lane: 'slow' as const, kind: 'breakout' as const, tf: '1d' as const, dir: 1 as const, stop: 965, plan, atr: 10 };
  const t = openTrade(sig, 1000, 0, FREE)!;
  // +1.5 ATR: nothing moves (and the regular daily trail, 1 ATR behind the best close, is not applied).
  stepTrade(t, bar(0, 1000, 1015, 999, 1014), D1, FREE, { close: 1014, atr: 10 });
  assert.equal(t.stop, 965);
  // +2.1 ATR: break-even plus round-trip fees.
  stepTrade(t, bar(D1, 1014, 1021, 1010, 1018), D1, FREE, { close: 1018, atr: 10 });
  assert.ok(Math.abs(t.stop - 1002) < 1e-9, `${t.stop}`);
  // +4 ATR: trail 3 ATR behind the best price.
  stepTrade(t, bar(2 * D1, 1018, 1040, 1015, 1030), D1, FREE, { close: 1030, atr: 10 });
  assert.ok(Math.abs(t.stop - 1010) < 1e-9, `${t.stop}`);
  // A pullback never loosens it.
  stepTrade(t, bar(3 * D1, 1030, 1032, 1012, 1015), D1, FREE, { close: 1015, atr: 10 });
  assert.ok(Math.abs(t.stop - 1010) < 1e-9);
  stepTrade(t, bar(4 * D1, 1015, 1016, 1005, 1008), D1, FREE);
  assert.equal(t.closed?.reason, 'trail'); assert.equal(t.closed?.px, 1010);
  // Stopped at break-even plus fees: recorded as break-even.
  const b = openTrade(sig, 1000, 0, FREE)!;
  stepTrade(b, bar(0, 1000, 1025, 999, 1020), D1, FREE);
  stepTrade(b, bar(D1, 1020, 1021, 995, 998), D1, FREE);
  assert.equal(b.closed?.reason, 'breakeven');
  // A short mirrors it.
  const s = openTrade({ ...sig, dir: -1, stop: 1035 }, 1000, 0, FREE)!;
  stepTrade(s, bar(0, 1000, 1001, 960, 965), D1, FREE);
  assert.ok(Math.abs(s.stop - 990) < 1e-9, `${s.stop}: best 960 + 3 ATR`);
});

test('4h ATR ratchet: applyRatchet sets the 3.5 ATR(4h) stop for its lanes only; atr4hAt uses closed 4h bars', () => {
  const h1 = walk(24 * 30, 5, H1);
  const at = h1[400].ts + H1; // bars 0..400 closed
  const a = atr4hAt(h1, at)!;
  const want = atr(aggregate(h1.slice(401 - ATR4H_WINDOW_H1, 401), 4 * H1), 14);
  assert.ok(a > 0 && Math.abs(a - want[want.length - 1]) < 1e-9, `${a} vs ${want[want.length - 1]}`);
  assert.equal(atr4hAt(h1, at + H1 / 2), a, 'an unclosed hourly bar is not used');
  assert.equal(atr4hAt(h1.slice(0, 20), h1[19].ts + H1), undefined, 'too short');
  const sig: SetupSignal = { asset: 'BTC', lane: 'slow', kind: 'breakout', tf: '1d', dir: 1, ts: 0, ref: 100, stop: 95, atr: 2, plan: { trailAtr: 2, maxBars: 10 }, info: {} as never };
  const r: RatchetSettings = { lanes: 'slow', stopAtr: 3.5, beAtr: 2, trailStartAtr: 3.5, trailAtr: 3 };
  const g = applyRatchet(sig, 1.2, 0.0028, r);
  assert.ok(Math.abs(g.stop - (100 - 3.5 * 1.2)) < 1e-12);
  assert.deepEqual(g.plan.ratchet, { atr: 1.2, beAtr: 2, trailStartAtr: 3.5, trailAtr: 3, fee: 0.0028 });
  assert.equal(applyRatchet({ ...sig, lane: 'fast' }, 1.2, 0.0028, r).stop, 95, 'other lane: unchanged');
  assert.equal(applyRatchet(sig, 1.2, 0.0028, { ...r, lanes: 'off' }), sig);
  assert.equal(applyRatchet(sig, undefined, 0.0028, r), sig, 'no 4h ATR: unchanged');
  assert.ok(Math.abs(applyRatchet({ ...sig, dir: -1, stop: 105 }, 1.2, 0.0028, { ...r, lanes: 'both' }).stop - (100 + 3.5 * 1.2)) < 1e-12);
});

test('perp trader: leverage stays under the liquidation cap, which shrinks with the other open positions', () => {
  const P: PerpTraderParams = {
    horizonMin: 240, entryEdgeBps: 5, exitEdgeBps: 0, kellyFraction: 0.25, maxLeverage: 50, maxNotionalUsd: 1e9, maxTotalNotionalUsd: 1e9,
    stopAtrMult: 2, minStopBps: 50, maxHoldMin: 480, dailyLossFrac: 0.1, cooldownMin: 60, pilotMaxNotionalUsd: 25, pilotMaxLeverage: 1,
    priorIc: 0.05, makerBps: 5, requireValidation: false, minEquityUsd: 5, maintMargin: 0.05,
  };
  const base = (o: Partial<PerpDecisionInput> = {}): PerpDecisionInput => ({
    asset: 'BTC', ticker: 'BTC-PERP', muBps: 4000, sigmaHBps: 50, validated: true, source: 'model', bid: 99.99, ask: 100.01, fundingRate: 0,
    current: 0, equity: 1000, atrFrac: 0.02, marketLeverage: 1000, step: 0.01, otherNotional: 0, ...o,
  });
  // Stop 4% (2 x 2% ATR): cap 0.8 / (0.04 + 0.05) = 8.9x (the 0.5 / stop cap is 12.5x).
  const d = decidePerp(base(), P);
  assert.ok(Math.abs(d.leverage! - 0.8 / 0.09) < 1e-9, `${d.leverage}`);
  // $5,000 open elsewhere ties up 5000 x 0.09 = $450: 55% of the cap left.
  const e = decidePerp(base({ otherNotional: 5000 }), P);
  assert.ok(Math.abs(e.leverage! - 0.55 * (0.8 / 0.09)) < 1e-9, `${e.leverage}`);
});

test('paper perps: the liquidation estimate is where equity falls to the maintenance margin', async () => {
  const { PaperPerpExchange } = await import('../bot/perps/paperPerp');
  const { PerpHub } = await import('../bot/perps/perpData');
  const hub = new PerpHub();
  const now = 1_800_000_000_000;
  hub.apply({ ticker: 'BTC-PERP', asset: 'BTC', ts: now, bid: 99.99, ask: 100.01, contractSize: 0.001, fractional: true, fundingRate: 0, tickSize: 0.01, leverage: 10 });
  const sim = new PaperPerpExchange(hub, () => 'BTC', { makerBps: 0, takerBps: 0 }, undefined, () => now, 100);
  assert.deepEqual(await sim.getRisk(), []);
  await sim.createOrder({ ticker: 'BTC-PERP', side: 'bid', count: 5, price: 100.02, clientOrderId: 'e', postOnly: false, reduceOnly: false, timeInForce: 'immediate_or_cancel' });
  const [r] = await sim.getRisk();
  assert.equal(r.position, 5);
  // Equity 100 + 5 x (mark - entry); maintenance 5 x mark x 0.05 (half of 1 / 10x): equity at the liquidation = maintenance there (to first order).
  const { equity } = await sim.getBalance();
  const mark = r.mark!, liq = r.liquidationPrice!;
  assert.ok(liq < mark && liq > 70, `${liq}`);
  assert.ok(Math.abs(equity + 5 * (liq - mark) - 5 * mark * 0.05) < 1e-9);
  const sh = new PaperPerpExchange(hub, () => 'BTC', { makerBps: 0, takerBps: 0 }, undefined, () => now, 100);
  await sh.createOrder({ ticker: 'BTC-PERP', side: 'ask', count: 5, price: 99.98, clientOrderId: 's', postOnly: false, reduceOnly: false, timeInForce: 'immediate_or_cancel' });
  assert.ok((await sh.getRisk())[0].liquidationPrice! > mark, 'a short is liquidated above the mark');
});

test('live setup trader: entry capped so the liquidation sits beyond the stop; the guard cuts an open trade once and waits for the fill', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { CandleSet } = await import('../bot/ta/candleStore');
  const { PerpHub } = await import('../bot/perps/perpData');
  const { SetupTrader, defaultSetupParams } = await import('../bot/setups/setupTrader');
  const { SETUP_FEATURES } = await import('../bot/setups/features');
  const { SETUP_SCHEMA } = await import('../bot/setups/setupModel');
  const { DEFAULT_LANES } = await import('../bot/setups/lanes');
  const all = walk(3000, 11);
  const s = setupSeries(all, '15m');
  let at = -1;
  for (let i = 1500; i < all.length - 50; i++) if (detectAt('BTC', '15m', s, i)?.lane === 'fast') { at = i; break; }
  assert.ok(at > 0, 'a setup exists');
  const sig = detectAt('BTC', '15m', s, at)!;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-'));
  const modelFile = path.join(dir, 'setup_model.json');
  fs.writeFileSync(modelFile, JSON.stringify({
    version: 'test', schema: SETUP_SCHEMA, features: SETUP_FEATURES, lanes: { fast: { meanR: 0.4, trades: 1000 }, slow: { meanR: 0.4, trades: 100 } },
    book: { ...DEFAULT_LANES, fast: { ...DEFAULT_LANES.fast, minScore: 0.1, refScore: 0.4 } }, costs: {}, equityUsd: 10000,
    validation: { fast: { periods: {}, trials: 1, passed: true, reasons: [] } }, trainedAt: '', data: {},
  }));
  const now = all[at].ts + 900_000 + 5_000;
  const candles = () => {
    const set = new CandleSet('BTC');
    set.add('15m', all.slice(0, at + 1).slice(-320), now);
    set.add('1h', all.slice(0, at + 1).filter((c) => c.ts % 3_600_000 === 0).slice(-320).map((c) => ({ ...c })), now);
    return set;
  };
  const px = { v: sig.ref };
  const hub = new PerpHub();
  hub.apply({ ticker: 'BTC-PERP', asset: 'BTC', ts: now, bid: px.v * 1.001 - 0.01, ask: px.v * 1.001 + 0.01, fractional: true });
  const risk: { v: Array<{ ticker: string; position: number; liquidationPrice?: number }> } = { v: [] };
  const gateway = { name: 'fake', createOrder: async () => { throw new Error('no'); }, cancelOrder: async () => {}, getOpenOrders: async () => [], getPositions: async () => [], getBalance: async () => ({ equity: 10_000, available: 10_000 }), getRisk: async () => risk.v } as never;
  const audits: Array<{ kind: string; data: any }> = [];
  const audit = { write: (kind: string, data: unknown) => { audits.push({ kind, data }); } } as never;
  const set = candles();
  const make = (o: { maintMargin: number }, state: string) => new SetupTrader({ params: defaultSetupParams({ pilotMaxNotionalUsd: 1e9, liqBuffer: 0.2, ...o }), hub, gateway, modelPath: modelFile, statePath: path.join(dir, state), candles: () => set, spot: () => px.v, audit });
  // Entry: a 200% maintenance margin makes the liquidation cap bind, 0.8 x 10,000 / (stop + 2).
  const capped = make({ maintMargin: 2 }, 'a.json');
  const c1 = (await capped.targets({ positions: new Map(), hedge: [], now }, {})).find((t) => t.asset === 'BTC')!;
  assert.notEqual(c1.target, 0, `entered: ${c1.reason}`);
  const ct = capped.book.positions.get('BTC')!;
  const cap = maxSafeNotional({ equity: 10_000, stopFrac: Math.abs(ct.entry - ct.stop) / ct.entry, mmr: 2, buffer: 0.2 });
  assert.ok(Math.abs(ct.notional! - cap) < 1e-6, `notional ${ct.notional} = liquidation cap ${cap}`);
  // Guard: the exchange holds the position, and its liquidation estimate is only 1.1 stop distances away (1.25 needed).
  const trader = make({ maintMargin: 0.05 }, 'b.json');
  const t1 = (await trader.targets({ positions: new Map(), hedge: [], now }, {})).find((t) => t.asset === 'BTC')!;
  assert.notEqual(t1.target, 0, `entered: ${t1.reason}`);
  const trade = trader.book.positions.get('BTC')!;
  const ratio = 1.001, perpPx = px.v * ratio;
  const stopDist = Math.abs(trade.entry - trade.stop) * ratio;
  risk.v = [{ ticker: 'BTC-PERP', position: t1.target, liquidationPrice: trade.entry * ratio - trade.dir * 1.1 * stopDist }];
  const held = Math.abs(t1.target) * perpPx;
  const pos = new Map([['BTC-PERP', { ticker: 'BTC-PERP', position: t1.target } as never]]);
  const t2 = (await trader.targets({ positions: pos, hedge: [], now: now + 60_000 }, {})).find((t) => t.asset === 'BTC')!;
  const L = (1.1 * stopDist) / (trade.entry * ratio), need = stopDist / (trade.entry * ratio) / 0.8;
  const share = (L + 0.05) / (need + 0.05);
  assert.ok(share < 0.999);
  assert.ok(Math.abs(trade.notional! - held * share) < 1e-6, `${trade.notional} vs ${held * share}`);
  assert.equal(t2.urgent, true); assert.match(t2.reason, /^liquidation guard/);
  assert.ok(Math.abs(t2.target) < Math.abs(t1.target));
  assert.equal(audits.filter((a) => a.kind === 'liquidation_guard').length, 1);
  // The estimate still shows the old position (the cut is on its way): no second cut.
  const t3 = (await trader.targets({ positions: pos, hedge: [], now: now + 70_000 }, {})).find((t) => t.asset === 'BTC')!;
  assert.equal(t3.target, t2.target); assert.equal(t3.urgent, false);
  // Filled, and the new estimate is far enough: nothing more to do.
  risk.v = [{ ticker: 'BTC-PERP', position: t2.target, liquidationPrice: trade.entry * ratio - trade.dir * 1.3 * stopDist }];
  const t4 = (await trader.targets({ positions: new Map([['BTC-PERP', { ticker: 'BTC-PERP', position: t2.target } as never]]), hedge: [], now: now + 125_000 }, {})).find((t) => t.asset === 'BTC')!;
  assert.equal(t4.target, t2.target); assert.equal(t4.urgent, false);
  assert.equal(audits.filter((a) => a.kind === 'liquidation_guard').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('4h ATR ratchet: the unit can be scaled by the TA network volatility forecast (volK), clamped; 0 = ATR alone', () => {
  const sig: SetupSignal = { asset: 'BTC', lane: 'slow', kind: 'breakout', tf: '1d', dir: 1, ts: 0, ref: 100, stop: 95, atr: 2, plan: { trailAtr: 2, maxBars: 10 }, info: {} as never };
  const r: RatchetSettings = { lanes: 'slow', stopAtr: 3.5, beAtr: 2, trailStartAtr: 3.5, trailAtr: 3, volK: 0.5 };
  const g = applyRatchet(sig, 1, 0.003, r, 0.4);
  assert.ok(Math.abs(g.plan.ratchet!.atr - Math.exp(0.2)) < 1e-12);
  assert.ok(Math.abs(g.stop - (100 - 3.5 * Math.exp(0.2))) < 1e-12);
  assert.equal(applyRatchet(sig, 1, 0.003, r, 5).plan.ratchet!.atr, 1.5, 'clamped at 1.5x');
  assert.equal(applyRatchet(sig, 1, 0.003, r, -5).plan.ratchet!.atr, 0.67, 'clamped at 0.67x');
  assert.equal(applyRatchet(sig, 1, 0.003, r).plan.ratchet!.atr, 1, 'no forecast: ATR alone');
  assert.equal(applyRatchet(sig, 1, 0.003, { ...r, volK: 0 }, 0.4).plan.ratchet!.atr, 1, 'volK 0: ATR alone');
});

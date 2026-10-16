// Cross-coin lead-lag (research/crossLead.ts, bot/ta/crossLead.ts): the walk-forward study finds a follower that makes up
// a leader's move a minute later, finds nothing between unrelated coins, and the reading training and live use.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadMinuteCloses, studyCrossLead, type MinuteSeries } from '../research/crossLead';
import { CL_SCHEMA, CrossLead, crossLeadSetupFeatures, crossLeadSetupReading, crossLeadSum, ret15, setCrossLeadPath, sigma15, type CrossLeadParams } from '../bot/ta/crossLead';
import type { Candle } from '../bot/ta/indicators';
import { crossLeadExitGate, crossLeadExitHook, crossLeadPull, simulateSetup } from '../research/trainSetupModel';
import { setupSeries, type SetupSignal } from '../bot/setups/detectors';
import { DEFAULT_COSTS, tradeResult } from '../bot/setups/exits';
import { BarStore, FEATURES, type FeatureContext } from '../bot/model/featureEngine';
import { tmpDir } from './helpers';

const MIN = 60_000, DAY = 86_400_000;
const T0 = Date.UTC(2023, 0, 1);

function gauss(seed: number) {
  let s = seed >>> 0;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r());
}

/** A leader, a follower that makes 60% of the leader's move at once and the other 40% a minute later, and an unrelated coin. */
function market(days: number): Map<string, MinuteSeries> {
  const n = days * 1440, g = gauss(7), u = gauss(11);
  const L = new Float64Array(n), F = new Float64Array(n), X = new Float64Array(n);
  let l = 100, f = 50, x = 20, prev = 0;
  for (let i = 0; i < n; i++) {
    const rl = 0.001 * g();
    l *= Math.exp(rl);
    f *= Math.exp(0.6 * rl + 0.4 * prev + 0.0004 * g());
    x *= Math.exp(0.001 * u());
    prev = rl;
    L[i] = l; F[i] = f; X[i] = x;
  }
  return new Map([['BTC', { from: T0, c: L }], ['SOL', { from: T0, c: F }], ['XRP', { from: T0, c: X }]]);
}

const OPTS = { horizons: [1, 15], firstFitDays: 60, trainDays: 90, minDays: 30, minTrades: 50, boots: 200 };

test('cross lead: a follower that makes up the leader\'s move a minute later validates at 1 minute, walk-forward; unrelated coins do not', () => {
  const p = studyCrossLead(market(330), OPTS);
  assert.equal(p.schema, CL_SCHEMA);
  assert.equal(p.tests, 2 * 2, 'BTC -> SOL, BTC -> XRP at two horizons (ETH absent)');
  const sol1 = p.pairs.find((x) => x.follower === 'SOL' && x.h === 1)!;
  assert.ok(sol1.validated, sol1.why);
  // The full co-movement (60% at once + 40% a minute later), from hourly returns: not the 0.6 a same-minute beta would give.
  assert.ok(sol1.beta > 0.85 && sol1.beta < 1.15, `beta ${sol1.beta}`);
  assert.ok(sol1.a > 0.3, `catch-up slope ${sol1.a}`);
  assert.ok(sol1.oos.ic > 0.1 && sol1.oos.icLo > 0);
  assert.ok(sol1.walk.length >= 2 && sol1.walk.every(([from, to], i) => to > from && (i === 0 || from === sol1.walk[i - 1][1])), 'contiguous quarters');
  assert.ok(sol1.walk[0][0] >= T0 + 60 * DAY, 'the first fit saw only the data before it');
  for (const x of p.pairs.filter((y) => y.follower === 'XRP')) assert.equal(x.validated, false, `${x.h}m: ${x.why}`);
  // The catch-up is a 0.04% move against 28 bps of costs: predictive, never tradable on its own.
  assert.equal(sol1.tradable, false);
});

test('cross lead: training reads each time through the fit made before it, live through the final fit', () => {
  const pair = { leader: 'BTC', follower: 'SOL', h: 15, beta: 1, a: 0.5, walk: [[1000, 2000, 2, 0.1], [2000, 3000, 1, 0.2]] as Array<[number, number, number, number]>, validated: true, tradable: false, why: '', oos: { ic: 0.1, icLo: 0.05, netBps: 0, netLo: 0, trades: 0, days: 200, quartersUp: 3, quarters: 4 } };
  const params: CrossLeadParams = { schema: CL_SCHEMA, version: 'v', at: '', from: '', to: 3000, costBps: 28, tests: 1, pairs: [pair, { ...pair, follower: 'XRP', validated: false }] };
  const cl = new CrossLead(params);
  const ret = (a: string) => (a === 'BTC' ? 0.01 : a === 'SOL' ? 0.004 : undefined);
  assert.ok(Math.abs(cl.expected('SOL', 15, ret, 1500)! - 0.1 * (2 * 0.01 - 0.004)) < 1e-12, 'first fold');
  assert.ok(Math.abs(cl.expected('SOL', 15, ret, 2500)! - 0.2 * (0.01 - 0.004)) < 1e-12, 'second fold');
  assert.equal(cl.expected('SOL', 15, ret, 500), undefined, 'before the first fit: nothing');
  assert.ok(Math.abs(cl.expected('SOL', 15, ret, 5000)! - 0.5 * (0.01 - 0.004)) < 1e-12, 'after the study: the final fit');
  assert.ok(Math.abs(cl.expected('SOL', 15, ret)! - 0.5 * (0.01 - 0.004)) < 1e-12, 'live: the final fit');
  assert.equal(cl.expected('XRP', 15, ret), undefined, 'not validated: never read');
  assert.equal(cl.expected('SOL', 60, ret), undefined, 'no validated pair at 60 minutes');
});

test('cross lead: the setup reading from 15-minute bars (volatility units, oriented inputs, the exit\'s sum); minute history from the store', async () => {
  const bars = (seed: number, drift: number): Candle[] => { const g = gauss(seed); let p = 100; return Array.from({ length: 400 }, (_, i) => { const o = p; p *= Math.exp(drift + 0.002 * g()); return { ts: T0 + i * 15 * MIN, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: 1 }; }); };
  const btc = bars(3, 0.001), sol = bars(5, 0);
  const t = btc[300].ts + 15 * MIN;
  assert.ok(Math.abs(ret15(btc, t, 60)! - Math.log(btc[300].c / btc[296].c)) < 1e-12);
  assert.equal(ret15(btc.filter((_, i) => i !== 298), t, 60), undefined, 'a missing bar in the span');
  assert.ok(sigma15(sol, t)! > 0);
  const pair = { leader: 'BTC', follower: 'SOL', h: 60, beta: 1, a: 0.3, walk: [], validated: true, tradable: false, why: '', oos: { ic: 0.1, icLo: 0.05, netBps: 0, netLo: 0, trades: 0, days: 200, quartersUp: 3, quarters: 4 } };
  const cl = new CrossLead({ schema: CL_SCHEMA, version: 'v', at: '', from: '', to: 0, costBps: 28, tests: 1, pairs: [pair] });
  const m15 = (a: string) => (a === 'BTC' ? btc : a === 'SOL' ? sol : undefined);
  const r = crossLeadSetupReading(cl, 'SOL', t, m15)!;
  const want = 0.3 * (ret15(btc, t, 60)! - ret15(sol, t, 60)!) / (sigma15(sol, t)! * 2);
  assert.ok(Math.abs(r.exp60! - want) < 1e-9 && r.exp15 === undefined);
  assert.equal(crossLeadSum(r), r.exp60);
  const out: Record<string, number> = {};
  crossLeadSetupFeatures(out, -1, r);
  assert.equal(out.o_cl_exp60, -out.cl_exp60);
  assert.ok(Number.isNaN(out.cl_exp15));
  assert.equal(crossLeadSetupReading(cl, 'XRP', t, m15), undefined);
  // 1-minute closes from a history-store CSV, a missing minute left as NaN.
  const dir = tmpDir(), file = path.join(dir, '1m.csv');
  fs.writeFileSync(file, `ts,o,h,l,c,v,tb\n${[0, 1, 3].map((i) => `${T0 + i * MIN},1,2,0.5,${10 + i},5,2`).join('\n')}\n`);
  const s = (await loadMinuteCloses(file, T0))!;
  assert.deepEqual([s.from, s.c.length, s.c[0], s.c[1], s.c[3]], [T0, 4, 10, 11, 13]);
  assert.ok(Number.isNaN(s.c[2]));
});

test('cross lead exit: kept only when it raises the setups\' net R on the development years with confidence and on the holdout', () => {
  const g = gauss(17), ks = [0.5, 1, 1.5, 2];
  const DEV1 = T0 + 720 * DAY, HOLD1 = DEV1 + 270 * DAY;
  const rows = (n: number, from: number, to: number, gainOf: (j: number) => number) => Array.from({ length: n }, (_, i) => ({ at: from + (i / n) * (to - from), d: ks.map((_, j) => gainOf(j) + 0.3 * g()) }));
  // The exit at k = 1 adds 0.1 R per trade, the others nothing.
  const good = [...rows(2000, T0, DEV1, (j) => (j === 1 ? 0.1 : 0)), ...rows(600, DEV1, HOLD1, (j) => (j === 1 ? 0.1 : 0))];
  const on = crossLeadExitGate(good, { ks, devTo: DEV1, boots: 300 })!;
  assert.ok(on, 'switched on');
  assert.equal(on.k, 1);
  assert.ok(on.devLoR > 0 && on.holdGainR > 0 && on.trades === 2600);
  // The same development years, but the gain is gone on the holdout: off.
  const faded = [...rows(2000, T0, DEV1, (j) => (j === 1 ? 0.1 : 0)), ...rows(600, DEV1, HOLD1, (j) => (j === 1 ? -0.05 : 0))];
  assert.equal(crossLeadExitGate(faded, { ks, devTo: DEV1, boots: 300 }), undefined);
  // No gain anywhere, or too few setups: off.
  assert.equal(crossLeadExitGate(rows(2600, T0, HOLD1, () => 0), { ks, devTo: DEV1, boots: 300 }), undefined);
  assert.equal(crossLeadExitGate(good.slice(0, 150), { ks, devTo: DEV1, boots: 300 }), undefined);
});

test('cross lead exit: a setup closes at the 15-minute close where the leaders pull against it by more than k (taker exit), not when they pull with it', () => {
  // Flat 15-minute and hourly bars around 100; a long 1-hour setup with a far stop and no targets (only the time stop).
  const m15: Candle[] = Array.from({ length: 400 }, (_, i) => ({ ts: T0 + i * 15 * MIN, o: 100, h: 100.2, l: 99.8, c: 100 + 0.01 * (i % 7), v: 1 }));
  const h1: Candle[] = Array.from({ length: 100 }, (_, i) => ({ ts: T0 + i * 60 * MIN, o: 100, h: 100.2, l: 99.8, c: 100, v: 4 }));
  const A = { asset: 'SOL', m15, h1, d1: [], m15Idx: new Map(m15.map((c, i) => [c.ts, i])), series: { '15m': setupSeries(m15, '15m'), '1h': setupSeries(h1, '1h') }, tfIdx: { '15m': new Map(m15.map((c, i) => [c.ts, i])), '1h': new Map(h1.map((c, i) => [c.ts, i])) } } as unknown as Parameters<typeof simulateSetup>[0];
  const sig: SetupSignal = { asset: 'SOL', lane: 'fast', kind: 'pullback', tf: '1h', dir: 1, ts: T0 + 10 * 60 * MIN, ref: 100, stop: 95, atr: 1, plan: { trailAtr: 50, maxBars: 20 }, info: { rsi: 50, pctB: 0.5, flow: 0.5, bandwidth: 0, volRatio: 1 } };
  const base = simulateSetup(A, sig, DEFAULT_COSTS)!;
  assert.equal(base.closed?.reason, 'time');
  const entry = sig.ts + 60 * MIN, at = entry + 5 * 15 * MIN;
  // The pull: -1.5 (against a long) from the fifth 15-minute close after entry; +3 (with it) before.
  const pull = (ts: number) => (ts >= at ? -1.5 : 3);
  const cut = simulateSetup(A, sig, DEFAULT_COSTS, crossLeadExitHook(pull, 1))!;
  assert.equal(cut.closed?.reason, 'leadlag');
  assert.equal(cut.closed?.ts, at);
  assert.equal(cut.closed?.px, m15.find((c) => c.ts + 15 * MIN === at)!.c);
  const fees = DEFAULT_COSTS.entry + DEFAULT_COSTS.takerExit;
  assert.ok(cut.costs >= fees - 1e-12 && cut.costs < fees + DEFAULT_COSTS.fundingPer8h, 'taker exit (plus the funding while held)');
  assert.ok(tradeResult(cut).r < 0 && tradeResult(cut).r > -0.1, 'a flat trade cut for its costs');
  // k above the pull: the trade runs to its time stop as without the exit. A short is cut by the +3 at the first close
  // (from the close of the bar it entered in) and would not be by the -1.5.
  assert.equal(simulateSetup(A, sig, DEFAULT_COSTS, crossLeadExitHook(pull, 2))!.closed?.reason, 'time');
  const short = { ...sig, dir: -1 as const, stop: 105 };
  assert.equal(simulateSetup(A, short, DEFAULT_COSTS, crossLeadExitHook(pull, 1))!.closed?.ts, entry + 15 * MIN);
  assert.equal(simulateSetup(A, short, DEFAULT_COSTS, crossLeadExitHook((ts) => (ts >= at ? -1.5 : 0), 1))!.closed?.reason, 'time');
  // The pull from a study is read once per close and shared by every k and trade.
  let reads = 0;
  const cl = new CrossLead({ schema: CL_SCHEMA, version: 'v', at: '', from: '', to: 0, costBps: 28, tests: 1, pairs: [] });
  const p = crossLeadPull(cl, 'SOL', () => { reads++; return m15; });
  p(at); p(at);
  assert.ok(reads <= 1 && p(at) === undefined, 'no validated pair: no pull');
});

test('cross lead: the Kalshi features read the leaders\' 1-minute index bars over the same minutes (validated pairs only)', () => {
  const dir = tmpDir(), file = path.join(dir, 'cross_lead.json');
  const pair = { leader: 'BTC', follower: 'SOL', h: 5, beta: 1, a: 0.4, walk: [], validated: true, tradable: false, why: '', oos: { ic: 0.1, icLo: 0.05, netBps: 0, netLo: 0, trades: 0, days: 200, quartersUp: 3, quarters: 4 } };
  fs.writeFileSync(file, JSON.stringify({ schema: CL_SCHEMA, version: 'v', at: '', from: '', to: 0, costBps: 28, tests: 1, pairs: [pair, { ...pair, h: 15, validated: false }] }));
  setCrossLeadPath(file);
  try {
    const btc = new BarStore(), sol = new BarStore(), g = gauss(23);
    let pb = 100, ps = 50;
    for (let i = 0; i <= 120; i++) { pb *= Math.exp(0.001 + 0.0005 * g()); ps *= Math.exp(0.0005 * g()); btc.onPrice(pb, T0 + i * MIN); sol.onPrice(ps, T0 + i * MIN); }
    const now = T0 + 120 * MIN + 5000;
    const c = { now, asset: 'SOL', bars: sol, peerBars: new Map([['BTC', btc], ['SOL', sol]]) } as unknown as FeatureContext;
    const cache = { idx: new Map(), spot: new Map(), memo: new Map() } as unknown as Parameters<(typeof FEATURES)[string]['fn']>[1];
    const b = btc.last(6)!, s6 = sol.last(6)!;
    const want = (0.4 * (Math.log(b[5].c / b[0].c) - Math.log(s6[5].c / s6[0].c))) / (sol.sigma1m()! * Math.sqrt(5));
    assert.ok(Math.abs(FEATURES.cl_exp5.fn(c, cache) - want) < 1e-9, 'BTC ran ahead: SOL expected to follow');
    assert.ok(FEATURES.cl_exp5.fn(c, cache) > 0);
    assert.ok(Number.isNaN(FEATURES.cl_exp15.fn(c, cache)), 'not validated');
    assert.ok(Number.isNaN(FEATURES.cl_exp1.fn(c, cache)), 'no pair');
    // The leader's bar for the coin's last minute not in yet: left out (no pair left: NaN).
    const late = new BarStore();
    for (let i = 0; i <= 119; i++) late.onPrice(100 + i * 0.01, T0 + i * MIN);
    assert.ok(Number.isNaN(FEATURES.cl_exp5.fn({ ...c, peerBars: new Map([['BTC', late], ['SOL', sol]]) } as FeatureContext, cache)));
  } finally { setCrossLeadPath(undefined); }
});

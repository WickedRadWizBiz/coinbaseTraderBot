// Fractal Alignment Engine and waterfall mode (bot/macro).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { align, barCloses, DEFAULT_FRACTAL, FractalCache, fractalState, projectedCross, swings } from '../bot/macro/fractalEngine';
import { MacroSeries } from '../bot/macro/macroSeries';
import { MacroService } from '../bot/macro/macroService';
import { DEFAULT_WATERFALL, gateHit, shibVelocity, usdtBreakdown, waterfallPolicy, waterfallReading, WaterfallSwitch } from '../bot/macro/waterfall';
import { FRACTAL_SETUP_KEYS, fractalFeatures } from '../bot/setups/features';
import type { Candle } from '../bot/ta/indicators';

const DAY = 86_400_000;
const bar = (ts: number, c: number, v = 0): Candle => ({ ts, o: c, h: c, l: c, c, v });

// A parent (2016-2017) with a plateau, a first waterfall, a relief rally and the final waterfall, and a child
// (2018 on) replaying it slower (x4 on the plateau, x1.3 in the first waterfall, x3 in the relief, x2 in the last)
// on a compressed scale (12 + 0.6 x parent), with noise.
const shape = (u: number) => (u < 0.55 ? 90 - 5 * u : u < 0.7 ? 87 - ((u - 0.55) / 0.15) * 47 : u < 0.9 ? 40 + ((u - 0.7) / 0.2) * 25 : 65 - ((u - 0.9) / 0.1) * 30);
const P0 = DEFAULT_FRACTAL.parentFrom, P1 = DEFAULT_FRACTAL.parentTo, C0 = DEFAULT_FRACTAL.childFrom;
const parentDays = (P1 - P0) / DAY;
const segs: Array<[number, number]> = [[0.55, 4], [0.15, 1.3], [0.2, 3], [0.1, 2]];
const knots: Array<[number, number]> = [[0, 0]];
{ let cd = 0, pu = 0; for (const [du, dil] of segs) { cd += du * parentDays * dil; pu += du; knots.push([cd, pu]); } }
const uOf = (d: number) => { for (let i = 1; i < knots.length; i++) if (d <= knots[i][0]) return knots[i - 1][1] + ((knots[i][1] - knots[i - 1][1]) * (d - knots[i - 1][0])) / (knots[i][0] - knots[i - 1][0]); return 1; };
function synth(childDays: number, seed = 7): Candle[] {
  let x = seed; const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
  const out: Candle[] = [];
  for (let t = P0; t < P1; t += DAY) out.push(bar(t, shape((t - P0) / (P1 - P0)) + rnd() * 1.5));
  for (let d = 0; d < childDays; d++) out.push(bar(C0 + d * DAY, 12 + 0.6 * shape(uOf(d)) + rnd() * 1.2));
  return out;
}
const CHILD_DAYS = Math.floor(knots[knots.length - 1][0] * 0.93);

test('barCloses: last close per bar, only bars that have ended, carried over a gap', () => {
  const d = [bar(0, 1), bar(DAY, 2), bar(5 * DAY, 6), bar(6 * DAY, 7)];
  assert.deepEqual(barCloses(d, 0, Infinity, 2 * DAY, 7 * DAY).map((x) => x.c), [2, 2, 6], 'days 2-3 empty: carried; days 6-7 not ended at day 7');
  assert.deepEqual(barCloses(d, 0, Infinity, 2 * DAY, 8 * DAY).map((x) => x.c), [2, 2, 6, 7]);
  assert.deepEqual(barCloses(d, 0, 4 * DAY, 2 * DAY).map((x) => x.ts), [2 * DAY, 4 * DAY], 'the window end bounds it');
});

test('swings: zigzag extremes, the steep part after the drift, deep falls marked as waterfalls', () => {
  const p = [90, 89.5, 89, 88.6, 88, 80, 60, 45, 40, 45, 55, 65, 60, 50, 40, 35];
  const sw = swings(p, 6, 15);
  assert.deepEqual(sw.map((s) => [s.from, s.to, s.dir, s.waterfall]), [[0, 8, -1, true], [8, 11, 1, false], [11, 15, -1, true]]);
  assert.equal(sw[0].move, 4, 'the drift from 90 to 88 is the base; the waterfall starts after it');
});

test('align: recovers a known time warp exactly on clean data, open end', () => {
  const p = Array.from({ length: 40 }, (_, j) => 50 + 20 * Math.sin(j / 6));
  const warp = Array.from({ length: 90 }, (_, i) => Math.min(29, Math.floor(i / 3)));
  const c = warp.map((j) => 10 + 0.5 * p[j]);
  const { path: pt, cost } = align(c, p, 10, 0.5, 8, 0.1);
  assert.ok(cost < 1e-9, `${cost}`);
  assert.equal(pt[pt.length - 1], 29, 'the child ends where the parent was at bar 29 (open end)');
  for (let i = 1; i < pt.length; i++) assert.ok(pt[i] - pt[i - 1] >= 0 && pt[i] - pt[i - 1] <= 2);
});

test('fractal state: progress, phase, dilation, fit and projection on a warped, rescaled replay of the parent', () => {
  const daily = synth(CHILD_DAYS);
  // Late in the relief rally (true parent progress ~0.84): located well, fit high.
  const d1 = Math.floor(CHILD_DAYS * 0.95), at1 = C0 + d1 * DAY;
  const s = fractalState(daily, at1)!;
  assert.ok(s, 'a state');
  assert.ok(Math.abs(s.progress - uOf(d1 - 7)) < 0.04, `progress ${s.progress} vs ${uOf(d1 - 7)}`);
  assert.ok(s.fit.r > 0.98 && s.fit.recentR > 0.95, JSON.stringify(s.fit));
  assert.ok(Math.abs(s.map.b - 0.6) < 0.06 && Math.abs(s.map.a - 12) < 4, JSON.stringify(s.map));
  assert.ok(s.dilation > 2.8 && s.dilation < 4, `${s.dilation}`);
  assert.equal(s.swing.dir, 1); assert.match(s.phase, /dominance rising/);
  assert.ok(s.nextWaterfall && !s.nextWaterfall.inside && s.nextWaterfall.weeksAway > 5 && s.nextWaterfall.weeksAway < 60, JSON.stringify(s.nextWaterfall));
  assert.ok(s.low && s.low.btcd < 40, 'the projection reaches the final low (12 + 0.6 x 35 = 33)');
  assert.ok(projectedCross(s, 40)! > s.asOf, 'the projection crosses 40 in the future');
  // Inside the first waterfall: phase says so.
  const d2 = Math.floor(knots[1][0] + 0.5 * (knots[2][0] - knots[1][0]));
  const w = fractalState(daily, C0 + d2 * DAY)!;
  assert.ok(w.swing.waterfall && !w.swing.base, w.phase);
  // On the flat base the exact place is not identifiable: it must say "base", not "waterfall".
  const b = fractalState(daily, C0 + Math.floor(knots[1][0] * 0.6) * DAY)!;
  assert.ok(b.swing.base, b.phase);
  // Nothing before a year of child, nothing without the parent.
  assert.equal(fractalState(daily, C0 + 300 * DAY), undefined);
  assert.equal(fractalState(daily.filter((c) => c.ts >= C0), at1), undefined);
});

test('fractal state is point in time: later data does not change it; the cache keys by week', () => {
  const daily = synth(CHILD_DAYS);
  const at = C0 + 1500 * DAY + 3 * 3_600_000;
  const cut = daily.filter((c) => c.ts + DAY <= at);
  const a = fractalState(daily, at)!, b = fractalState(cut, at)!;
  assert.equal(a.parentTs, b.parentTs); assert.equal(a.btcd, b.btcd); assert.deepEqual(a.map, b.map);
  const cache = new FractalCache(daily);
  const wk = C0 + 214 * 7 * DAY;
  assert.equal(cache.at(wk + 1000), cache.at(wk + 6 * DAY), 'same week, same state object');
  assert.equal(cache.at(wk + 1000)!.asOf, wk, 'as of the last complete week');
  assert.equal(cache.at(C0 - DAY), undefined);
});

test('waterfall legs: USDT.D breakdown, SHIB volume velocity, the gate after a descent, the triangulated trigger', () => {
  const T0 = Date.UTC(2026, 0, 1);
  const days = (n: number, f: (i: number) => number, v?: (i: number) => number) => Array.from({ length: n }, (_, i) => bar(T0 + i * DAY, f(i), v ? v(i) : 0));
  const usdt = days(60, (i) => (i < 53 ? 5 + 0.01 * Math.sin(i) : 4.8 - 0.02 * (i - 53)));
  const at = T0 + 60 * DAY;
  assert.equal(usdtBreakdown(usdt, at), true);
  assert.equal(usdtBreakdown(days(60, () => 5), at), false);
  assert.equal(usdtBreakdown(usdt.slice(0, 20), T0 + 20 * DAY), undefined, 'too short');
  const shib = days(100, () => 0.00001, (i) => (i < 93 ? 1e12 : 3e12));
  assert.ok(Math.abs(shibVelocity(shib, T0 + 100 * DAY)! - 3) < 1e-9);
  // BTC.D falls from 63% to 54%: the gate is hit; a market that never rose 5 points above it is not a descent.
  const btcd = days(400, (i) => (i < 300 ? 63 : 63 - 0.09 * (i - 299)));
  const hit = gateHit(btcd, T0 + 400 * DAY, 55)!;
  assert.ok(hit && hit.level <= 55 && hit.peak === 63);
  assert.equal(gateHit(days(400, () => 54), T0 + 400 * DAY, 55), undefined);
  assert.equal(gateHit(btcd, T0 + 350 * DAY, 55), undefined, 'still above the gate then');
  // The trigger: gate + fractal + (usdt or shib).
  const fractal = { fit: { r: 0.9, recentR: 0.85 }, nextWaterfall: { inside: false, weeksAway: 4 } } as never;
  const r = waterfallReading({ btcd, usdtd: usdt.map((c) => ({ ...c, ts: c.ts + 340 * DAY })), shib: days(400, () => 0.00001, () => 1e12), fractal, at: T0 + 400 * DAY });
  assert.deepEqual(r.legs, { gate: true, fractal: true, usdt: true, shib: false });
  assert.equal(r.signal, true); assert.equal(r.confirmations, 3);
  const noFit = waterfallReading({ btcd, fractal: { fit: { r: 0.5, recentR: 0.9 }, nextWaterfall: { inside: true, weeksAway: 0 } } as never, at: T0 + 400 * DAY });
  assert.equal(noFit.legs.fractal, false); assert.equal(noFit.signal, false);
});

test('waterfall policy: armed pauses tennis and caps Kalshi; triggered pauses Kalshi and leans into alt longs, tapering to the projected low', () => {
  const P = DEFAULT_WATERFALL;
  const off = waterfallPolicy('off', P);
  assert.deepEqual([off.tennisBlocked, off.kalshiBlocked, off.kalshiMaxFrac, off.perpMult('SOL', 1)], [false, false, undefined, 1]);
  const armed = waterfallPolicy('armed', P);
  assert.deepEqual([armed.tennisBlocked, armed.kalshiBlocked, armed.kalshiMaxFrac, armed.perpMult('SOL', -1)], [true, false, 0.125, 1]);
  const t = waterfallPolicy('triggered', P, 54, 35);
  assert.deepEqual([t.tennisBlocked, t.kalshiBlocked], [true, true]);
  assert.equal(t.perpMult('SOL', -1), 0, 'alt shorts off');
  assert.equal(t.perpMult('BTC', 1), 0.5); assert.equal(t.perpMult('BTC', -1), 0.5);
  const full = waterfallPolicy('triggered', P, 55, 35).perpMult('SOL', 1), mid = t.perpMult('SOL', 1), near = waterfallPolicy('triggered', P, 37.5, 35).perpMult('SOL', 1);
  assert.ok(Math.abs(full - 1.5) < 1e-9 && mid < full && mid > 1, `${full} ${mid}`);
  assert.equal(near, 0, 'within 3 points of the projected low: alt longs stop opening');
  assert.equal(waterfallPolicy('triggered', P, 54).perpMult('ETH', 1), 1.5, 'no projection: the full boost');
});

test('waterfall switch: arming refused before the gate, the latch and the switch persist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  const file = path.join(dir, 'waterfall.json');
  const sw = new WaterfallSwitch(file);
  assert.equal(sw.setArmed(true).ok, false);
  assert.equal(sw.armed, false);
  assert.equal(sw.observe({ ts: 1, level: 54.9, peak: 63 }), true);
  assert.equal(sw.observe({ ts: 2, level: 54, peak: 63 }), false, 'latched once');
  assert.equal(sw.setArmed(true, 'test', 5).ok, true);
  const again = new WaterfallSwitch(file);
  assert.deepEqual([again.armed, again.gateHitAt, again.status().armable], [true, 1, true]);
  assert.equal(again.setArmed(false).ok, true);
  assert.equal(new WaterfallSwitch(file).armed, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('macro service: latches the gate, arms, and the level follows the trigger; status for the dashboard', () => {
  const daily = synth(CHILD_DAYS);
  const last = daily[daily.length - 1].ts;
  // Append a descent through the gate after a peak above 60.
  const tail = Array.from({ length: 120 }, (_, i) => bar(last + (i + 1) * DAY, i < 60 ? 62 : 62 - 0.15 * (i - 59)));
  const btcd = [...daily, ...tail];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-'));
  const audits: Array<{ kind: string; data: any }> = [];
  let now = last + 30 * DAY;
  const svc = new MacroService({ index: (a) => (a === 'BTC.D' ? btcd : undefined), file: path.join(dir, 'waterfall.json'), audit: { write: (kind: string, data: unknown) => audits.push({ kind, data }) } as never, now: () => now, refreshMs: 0 });
  assert.equal(svc.policy().level, 'off');
  assert.equal(svc.setArmed(true).ok, false, 'before the gate');
  now = last + 121 * DAY;
  svc.refresh(true);
  assert.ok(svc.sw.gateHitAt, 'latched');
  assert.ok(audits.some((a) => a.kind === 'waterfall' && a.data.event === 'gate_hit'));
  assert.equal(svc.setArmed(true).ok, true);
  const lvl = svc.policy().level;
  assert.ok(lvl === 'armed' || lvl === 'triggered');
  assert.ok(audits.some((a) => a.data.event === 'level' && a.data.to === lvl));
  const st = svc.status();
  assert.equal(st.armed, true); assert.ok(st.fractal && st.fractal.chart.child.length > 50);
  assert.equal(st.legs?.gate, true);
  assert.equal(svc.setArmed(false).ok, true);
  assert.equal(svc.policy().level, 'off');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setup inputs: the fractal group is blank without a state, filled with one; the oriented copy flips for BTC', () => {
  const out: Record<string, number> = {};
  fractalFeatures(out, 'SOL', 1, undefined);
  assert.ok(FRACTAL_SETUP_KEYS.every((k) => Number.isNaN(out[k])));
  const m = new MacroSeries({ btcd: synth(CHILD_DAYS) }).at(C0 + Math.floor(CHILD_DAYS * 0.95) * DAY);
  fractalFeatures(out, 'SOL', 1, m);
  assert.ok(out.fae_progress > 0.7 && out.fae_fit > 0.9 && out.fae_alt === 1 && Number.isFinite(out.fae_proj90) && Number.isFinite(out.mac_gate));
  const sol = out.o_fae_proj90;
  fractalFeatures(out, 'BTC', 1, m);
  assert.equal(out.o_fae_proj90, -sol);
  assert.ok(Number.isNaN(out.mac_usdt_brk) && Number.isNaN(out.mac_shib_vel), 'no USDT.D / SHIB series: blank');
});

test('API: POST /waterfall refuses to arm before the gate (409), arms after it, always disarms', async () => {
  const { createApi } = await import('../bot/api/server');
  const { loadConfig } = await import('../bot/config');
  const { setMacro } = await import('../bot/macro/macroService');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfapi-'));
  const base = Date.UTC(2026, 0, 1);
  const btcd: Candle[] = Array.from({ length: 400 }, (_, i) => bar(base + i * DAY, i < 300 ? 63 : 63 - 0.09 * (i - 299)));
  let now = base + 200 * DAY;
  const svc = new MacroService({ index: (a) => (a === 'BTC.D' ? btcd : undefined), file: path.join(dir, 'waterfall.json'), now: () => now, refreshMs: 0 });
  setMacro(svc);
  const base0 = { cfg: loadConfig({}), startedAt: Date.now(), audit: { write: () => undefined } } as never;
  const deps = new Proxy(base0, { get: (t: any, k) => (k in t ? t[k] : undefined) });
  const srv = createApi(deps).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}/api/waterfall`;
  const post = async (armed: boolean) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ armed }) }); return { status: r.status, json: await r.json() as any }; };
  try {
    const refused = await post(true);
    assert.equal(refused.status, 409); assert.match(refused.json.error, /has not hit the gate/);
    now = base + 400 * DAY;
    const ok = await post(true);
    assert.equal(ok.status, 200); assert.equal(ok.json.waterfall.armed, true);
    const off = await post(false);
    assert.equal(off.status, 200); assert.equal(off.json.waterfall.armed, false);
  } finally { srv.close(); setMacro(undefined); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lane book: a waterfall weight of 0 skips the setup with the waterfall reason; a weight above 1 adds risk', async () => {
  const { LaneBook } = await import('../bot/setups/lanes');
  const P = {
    fast: { maxPositions: 2, riskFrac: 0.01, ttlBars: 2, minScore: 0.1, refScore: 0.2, maxChaseR: 0.3 },
    slow: { maxPositions: 1, riskFrac: 0.01, ttlBars: 1, minScore: 0.1, refScore: 0.2, maxChaseR: 0.5 },
    maxLeverage: 10, maxAssetLeverage: 10,
  };
  const sig = (asset: string, dir: 1 | -1) => ({ asset, lane: 'fast' as const, kind: 'fade' as const, tf: '15m' as const, dir, ts: 0, ref: 100, stop: dir > 0 ? 98 : 102, atr: 1, plan: { target1: dir > 0 ? 102 : 98, target2: dir > 0 ? 104 : 96, trailAtr: 1.5, maxBars: 4 }, info: { rsi: 50, pctB: 0.5, flow: 0.5, bandwidth: 0.05, volRatio: 1 } });
  const book = new LaneBook(P);
  book.offer(sig('SOL', -1), 0.2, 0);
  book.offer(sig('ETH', 1), 0.2, 0);
  const pol = waterfallPolicy('triggered', DEFAULT_WATERFALL, 54);
  const entries = book.select(60_000, 10_000, (c) => { const w = pol.perpMult(c.sig.asset, c.sig.dir); return { px: 100, score: 0.2, weight: w, weightWhy: w === 0 ? `waterfall mode: ${pol.why}` : undefined }; });
  assert.deepEqual(entries.map((e) => e.cand.sig.asset), ['ETH']);
  assert.ok(book.lastSkips.some((s) => s.asset === 'SOL' && /^waterfall mode: triggered/.test(s.reason)));
  // 1% risk x 1.5 at a 2% stop: $150 at risk -> $7,500 notional.
  assert.ok(Math.abs(entries[0].notional - 7500) < 1e-6, `${entries[0].notional}`);
});

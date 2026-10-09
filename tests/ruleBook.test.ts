import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runRuleBook } from '../research/ruleBook';
import { bracketReturn, signed, studyCombos, type Step } from '../research/confluenceBook';
import { buckets, conditionText, studyConditions } from '../research/conditionBook';
import { CONTEXT_PARAMS, contextOf, oriented } from '../bot/strategy/ruleContext';
import { RuleBook, type RuleBookFile, type RuleRow } from '../bot/strategy/ruleBook';
import { breadthOf, riskOf } from '../bot/ta/marketContext';
import { directionalConviction, orientedSignals } from '../bot/strategy/taConviction';
import type { Candle } from '../bot/ta/indicators';
import type { TaSnapshot } from '../bot/ta/analyzer';

const H = 3_600_000, D = 24 * H, T0 = Date.UTC(2020, 0, 1);
function rng(seed: number) { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function gauss(r: () => number) { const u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
/** Hourly series with persistent drift (planted momentum) plus a common factor; daily bars from it. */
function series(n: number, seed: number, common: number[]) {
  const r = rng(seed); let p = 100, mom = 0; const h1: Candle[] = [];
  for (let i = 0; i < n; i++) { mom = 0.995 * mom + 0.0004 * gauss(r); const ret = mom + 0.006 * gauss(r) + common[i]; const o = p; p *= Math.exp(ret); h1.push({ ts: T0 + i * H, o, h: Math.max(o, p) * (1 + 0.002 * r()), l: Math.min(o, p) * (1 - 0.002 * r()), c: p, v: 100 + 50 * r() }); }
  const d1: Candle[] = [];
  for (let i = 0; i + 24 <= n; i += 24) { const w = h1.slice(i, i + 24); d1.push({ ts: w[0].ts, o: w[0].o, h: Math.max(...w.map((c) => c.h)), l: Math.min(...w.map((c) => c.l)), c: w[23].c, v: w.reduce((a, c) => a + c.v, 0) }); }
  return { h1, d1 };
}

test('rule-book study: planted momentum is found and confirmed on the later years; every row carries both periods', () => {
  const n = 2200, cr = rng(99), common = Array.from({ length: n }, () => 0.004 * gauss(cr));
  const f = runRuleBook({ AAA: series(n, 1, common), BBB: series(n, 2, common), CCC: series(n, 3, common) }, { stride: 6 });
  assert.equal(f.schema, 'rulebook1');
  assert.ok(f.rows.length > 20);
  const pass = f.rows.filter((r) => r.pass);
  assert.ok(pass.some((r) => ['ema_stack', 'price_to_ma', 'market_structure', 'ma_regime'].includes(r.id)), `trend rules pass: ${pass.slice(0, 5).map((r) => r.id)}`);
  for (const r of pass) { assert.ok(r.fdr && r.expBps > 0 && r.expConfBps > 0 && r.hitConf >= 0.5 && r.weight > 0 && r.weight <= 1); }
  assert.ok(f.character.n > 0 && f.character.accuracy >= 0 && f.character.accuracy <= 1);
  assert.ok(f.splitAt > f.from && f.splitAt < f.to);
  assert.ok(Array.isArray(f.combos) && f.combos.length > 0, 'pairs of co-active signals are logged');
  for (const c of f.combos!) assert.ok(c.parts[0] !== c.parts[1] && c.n >= 50);
  assert.ok(Array.isArray(f.conditions) && f.conditions.length > 0, 'every rule\'s record is split by the context it fired in');
});

const row = (o: Partial<RuleRow>): RuleRow => ({ id: 'ema_stack', kind: 'rule', tf: '1h', h: 4, cls: 'all', n: 100, hit: 0.6, payoff: 1.2, expBps: 20, p: 0.001, fdr: true, nConf: 50, hitConf: 0.58, expConfBps: 15, pass: true, weight: 0.8, ...o });
const snap = (signals: Array<{ id: string; tf: string; dir: -1 | 0 | 1; strength: number }>, book: typeof signals = []): TaSnapshot =>
  ({ asset: 'ETH', ts: 0, tf: {}, signals: signals.map((s) => ({ ...s, indicator: '', meaning: '' })), book: book.map((s) => ({ ...s, indicator: '', meaning: '' })), confluences: [], net: 0 }) as unknown as TaSnapshot;

test('live rule book: only passing rows count, the character row wins over the all-characters row, hot reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
  const file = path.join(dir, 'rule_book.json');
  const write = (rows: RuleRow[]) => fs.writeFileSync(file, JSON.stringify({ schema: 'rulebook1', generatedAt: '', assets: [], from: '2020-01-01', to: '2026-01-01', splitAt: '2024-01-01', stride: 6, costBps: 10, horizons: [4, 24], character: { n: 1, accuracy: 0.7, baseline: 0.5, confusion: {}, share: {} }, rows } as RuleBookFile));
  write([row({}), row({ id: 'rsi_extreme', weight: 0.5 }), row({ id: 'macd_cross', pass: false, weight: 0 }), row({ id: 'double_top_bottom', kind: 'book', tf: '4h', weight: 1 }),
    row({ id: 'rsi_extreme', cls: 'calm', weight: 1 })]);
  const rb = new RuleBook(() => file);
  const s = snap([{ id: 'ema_stack', tf: '1h', dir: 1, strength: 1 }, { id: 'rsi_extreme', tf: '1h', dir: -1, strength: 1 }, { id: 'macd_cross', tf: '1h', dir: -1, strength: 1 }], [{ id: 'double_top_bottom', tf: '4h', dir: -1, strength: 0.8 }]);
  const all = rb.read(s, 4)!;
  // (0.8 - 0.5 - 0.8) / (0.8 + 0.5 + 1): the failed macd_cross row is ignored.
  assert.ok(Math.abs(all.score - (0.8 - 0.5 - 0.8) / 2.3) < 1e-9, String(all.score));
  assert.equal(all.n, 3);
  const calm = rb.read(s, 4, 'calm')!;
  assert.ok(Math.abs(calm.score - (0.8 - 1 - 0.8) / 2.8) < 1e-9, 'the calm row (weight 1) replaces the all row for rsi_extreme');
  assert.equal(rb.read(snap([{ id: 'adx_trend', tf: '1h', dir: 1, strength: 1 }]), 4)?.n, 0, 'no passing rule present: neutral');
  write([row({ id: 'adx_trend' })]);
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(rb.read(snap([{ id: 'adx_trend', tf: '1h', dir: 1, strength: 1 }]), 4)?.score, 1, 'reloaded on change');
});

test('conviction: the rule book joins the signals; volatile-systemic stands aside (no boost, no altcoin rule)', () => {
  const f = { conf_count: 2, ta_rsi_1h: 0.3, ta_ema_stack_1h: 1, usdtd_ret_15m_z: -1 };
  assert.ok(orientedSignals(f, undefined, false, { score: -0.6, n: 3 }).some(([n, x]) => n === 'rule book' && x === -0.6));
  assert.ok(!orientedSignals(f, undefined, false, { score: 0.05, n: 3 }).some(([n]) => n === 'rule book'), 'dead band');
  const c = { weight: 1, maxShift: 0.06, maxZ: 0.5, live: false, altBoost: 2.5, altUsdtdMaxZ: 0, altRsiMin: 50, nonAlts: ['BTC'], maxBoost: 2, maxTotal: 2.5 };
  const normal = directionalConviction('ETH', 1, f, undefined, c);
  assert.ok(normal.mult > 2, `altcoin risk-on long: ${normal.mult}`);
  const aside = directionalConviction('ETH', 1, f, undefined, { ...c, standAside: 'volatility at the 90th percentile with the market moving together' });
  assert.equal(aside.mult, 1);
  assert.match(aside.why, /stand aside/);
});

test('breadth and risk gauges from daily bars (bars closed by t only)', () => {
  const mk = (n: number, slope: number) => Array.from({ length: n }, (_, i) => { const c = 100 * Math.exp(slope * i); return { ts: T0 + i * D, o: c, h: c * 1.01, l: c * 0.99, c, v: 1 }; });
  const b = breadthOf([mk(80, 0.01), mk(80, 0.01), mk(80, -0.01)])!;
  assert.ok(Math.abs(b.above50 - 2 / 3) < 1e-9 && Math.abs(b.above20 - 2 / 3) < 1e-9);
  assert.ok(Math.abs(b.hiLo - (2 - 1) / 3) < 1e-9);
  assert.equal(breadthOf([mk(30, 0.01), mk(30, 0.01)]), undefined, 'too short');
  const up = mk(40, 0.002), dn = mk(40, -0.002);
  const r = riskOf({ dxy: dn, vix: dn, hyg: up, us10y: dn }, T0 + 40 * D)!;
  assert.ok(r.dxy! < 0 && r.hyg! > 0 && Math.abs(r.dxy! - -0.01) < 1e-9);
  assert.equal(riskOf({ dxy: dn }, T0 + 60 * D), undefined, 'stale series ignored');
});

test('confluence logbook: a pair that only works together passes; a pair no better than its parts does not', () => {
  const r = rng(5);
  const keys = ['rule|a|1h', 'rule|b|4h', 'rule|c|1h', 'rule|d|1h'];
  const steps: Step[] = [];
  const split = T0 + 3000 * H;
  for (let k = 0; k < 6000; k++) {
    const t = T0 + k * H;
    const aOn = r() < 0.4, bOn = r() < 0.4, cOn = r() < 0.5;
    const act: number[] = [];
    if (aOn) act.push(signed(0, 1)); if (bOn) act.push(signed(1, 1)); if (cOn) act.push(signed(2, 1)); act.push(signed(3, 1));
    // Up 40 bps only when a and b are both on; otherwise noise around zero (c, d add nothing).
    const drift = aOn && bOn ? 0.004 : 0;
    const ret = drift + 0.006 * gauss(r);
    if (act.length >= 2) steps.push({ asset: 0, i: k, t, fwd: [ret], active: Int32Array.from(act) });
  }
  const rows = studyCombos(steps, keys, { horizons: [1], splitAt: split, stride: 1, costBps: 2 });
  const ab = rows.find((x) => x.parts.join() === 'rule|a|1h,rule|b|4h')!;
  assert.ok(ab.pass, JSON.stringify(ab));
  assert.ok(ab.liftBps > 10 && ab.liftConfBps > 10 && ab.weight > 0, 'it beat both of its parts on both periods');
  const cd = rows.find((x) => x.parts.join() === 'rule|c|1h,rule|d|1h')!;
  assert.equal(cd.pass, false, 'two signals with no edge together');
  assert.ok(rows.filter((x) => x.pass).every((x) => x.parts.includes('rule|a|1h') || x.parts.includes('rule|b|4h')));
  // A short pays the cost too (the direction flips the move, never the fee).
  const short = studyCombos([{ asset: 0, i: 0, t: T0, fwd: [0], active: Int32Array.from([signed(0, -1), signed(1, -1)]) }], keys, { horizons: [1], splitAt: split, stride: 1, minN: 1, costBps: 10 });
  assert.equal(short[0].expBps, -10);
});

test('bracket: the target or the stop, whichever the hourly bars reach first; both in one bar counts as the stop', () => {
  const bars = (moves: Array<[number, number, number]>): Candle[] => moves.map(([l, h, c], i) => ({ ts: T0 + i * H, o: 100, h, l, c, v: 1 }));
  const up = bars([[99, 100, 100], [99.5, 101, 100.5], [100, 102.5, 102]]);
  assert.equal(bracketReturn(up, 0, 1, 0.02, 0.01, 48, 0), 0.02);
  assert.equal(bracketReturn(up, 0, -1, 0.02, 0.01, 48, 0), -0.01, 'a short is stopped by the rise');
  const both = bars([[100, 100, 100], [98, 103, 100]]);
  assert.equal(bracketReturn(both, 0, 1, 0.02, 0.01, 48, 0), -0.01);
  const flat = bars([[100, 100, 100], [99.8, 100.4, 100.3]]);
  assert.ok(Math.abs(bracketReturn(flat, 0, 1, 0.02, 0.01, 48, 0.001) - (0.003 - 0.001)) < 1e-12, 'neither hit: out at the last close, less the cost');
});

test('live rule book: a passing pair counts when both of its signals are present and agree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbc-'));
  const file = path.join(dir, 'rule_book.json');
  const combo = { parts: ['rule|ema_stack|1h', 'rule|rsi_extreme|4h'] as [string, string], h: 4, n: 80, hit: 0.6, expBps: 30, liftBps: 12, p: 0.001, fdr: true, nConf: 40, hitConf: 0.58, expConfBps: 20, liftConfBps: 8, pass: true, weight: 0.6 };
  fs.writeFileSync(file, JSON.stringify({ schema: 'rulebook1', generatedAt: '', assets: [], from: '', to: '', splitAt: '', stride: 6, costBps: 10, horizons: [4], character: { n: 1, accuracy: 0.7, baseline: 0.5, confusion: {}, share: {} }, rows: [], combos: [combo, { ...combo, parts: ['rule|macd_cross|1h', 'rule|ema_stack|1h'], pass: false }] }));
  const rb = new RuleBook(() => file);
  const both = rb.read(snap([{ id: 'ema_stack', tf: '1h', dir: -1, strength: 1 }, { id: 'rsi_extreme', tf: '4h', dir: -1, strength: 0.6 }]), 4)!;
  assert.ok(Math.abs(both.score - -0.8) < 1e-9, `bearish pair, strength (1 + 0.6) / 2: ${both.score}`);
  assert.deepEqual(both.oppose, ['ema_stack+rsi_extreme']);
  assert.equal(rb.read(snap([{ id: 'ema_stack', tf: '1h', dir: 1, strength: 1 }, { id: 'rsi_extreme', tf: '4h', dir: -1, strength: 1 }]), 4)?.n, 0, 'disagreeing: the pair does not count');
  assert.equal(rb.read(snap([{ id: 'ema_stack', tf: '1h', dir: 1, strength: 1 }]), 4)?.n, 0, 'one of the two: nothing');
  assert.equal(rb.passedCombos().length, 1);
});

test('context: the parameters a signal fired in, directional ones read towards the signal', () => {
  const tf = (o: object) => ({ rsi: 70, adx: 32, atrRank: 0.8, volRatio: 1.5, bbBandwidthRank: 0.2, chg20Atr: 3, cmf: 0.1, ema12: 102, ema26: 100, close: 110, sma200: 100, ...o });
  const s = { asset: 'BTC', ts: Date.UTC(2026, 0, 3, 14), tf: { '1h': tf({}), '4h': tf({ rsi: 40 }), '1d': tf({ ema12: 99 }) }, signals: [], confluences: [], net: 0 } as unknown as TaSnapshot;
  const ctx = contextOf(s, s.ts);
  const at = (name: string, dir = 1) => oriented(ctx, CONTEXT_PARAMS.findIndex((p) => p.name === name), dir);
  assert.equal(at('rsi_1h'), 20); assert.equal(at('rsi_1h', -1), -20, 'RSI 70 is against a bearish signal');
  assert.equal(at('adx_1h', -1), 32, 'trend strength has no side');
  assert.ok(at('trend_4h') > 0 && at('trend_1d') < 0 && at('trend_1d', -1) > 0);
  assert.ok(Math.abs(at('vs_sma200_1d') - 0.1) < 1e-6);
  assert.equal(at('hour_utc'), 14); assert.equal(at('weekend'), 1, '3 January 2026 is a Saturday');
  assert.deepEqual(buckets([1, 0, 1, 0, 0]), [[null, 1], [1, null]], 'a flag splits by value');
  assert.equal(buckets([1, 2, 3, 4, 5, 6, 7, 8, 9]).length, 3);
});

test('conditions: a rule that works in calm trends and fails in strong ones; both learned, the hour of day is not', () => {
  const r = rng(11);
  const keys = ['rule|rsi_extreme|1h'];
  const adx = CONTEXT_PARAMS.findIndex((p) => p.name === 'adx_1h');
  const steps: Step[] = [];
  for (let k = 0; k < 9000; k++) {
    const dir = r() < 0.5 ? 1 : -1;
    const ctx = new Float32Array(CONTEXT_PARAMS.length).fill(NaN);
    ctx[adx] = 10 + 40 * r();
    ctx[CONTEXT_PARAMS.findIndex((p) => p.name === 'hour_utc')] = k % 24;
    // In the signal's direction by 30 bps when ADX < 20, against it by 30 bps when ADX > 37.
    const edge = ctx[adx] < 20 ? 0.003 : ctx[adx] > 37 ? -0.003 : 0;
    steps.push({ asset: 0, i: k, t: T0 + k * H, fwd: [dir * edge + 0.006 * gauss(r)], active: Int32Array.from([signed(0, dir)]), ctx });
  }
  const rows = studyConditions(steps, keys, { horizons: [1], splitAt: T0 + 6000 * H, stride: 1, costBps: 0 });
  const pass = rows.filter((x) => x.pass);
  const makes = pass.find((x) => x.param === 'adx_1h' && x.effect === 'makes'), breaks = pass.find((x) => x.param === 'adx_1h' && x.effect === 'breaks');
  assert.ok(makes && makes.lo === null && makes.hi! < 25, `works below ~20: ${JSON.stringify(makes)}`);
  assert.ok(breaks && breaks.hi === null && breaks.lo! > 33, `fails above ~37: ${JSON.stringify(breaks)}`);
  assert.ok(!pass.some((x) => x.param === 'hour_utc'), 'the hour carries nothing here');
  assert.match(conditionText(makes!), /rsi_extreme\|1h works 1h when trend strength ADX \(1h\) is below/);
});

test('live rule book: a condition under which a rule fails silences it; one under which it works lets it count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbk-'));
  const file = path.join(dir, 'rule_book.json');
  const cond = (o: object) => ({ key: 'rule|rsi_extreme|1h', h: 4, param: 'adx_1h', lo: null, hi: 20, effect: 'makes', n: 90, hit: 0.6, expBps: 25, baseBps: 2, p: 0.001, fdr: true, nConf: 40, hitConf: 0.6, expConfBps: 15, baseConfBps: 1, pass: true, weight: 0.7, ...o });
  fs.writeFileSync(file, JSON.stringify({ schema: 'rulebook1', generatedAt: '', assets: [], from: '', to: '', splitAt: '', stride: 6, costBps: 10, horizons: [4], character: { n: 1, accuracy: 0.7, baseline: 0.5, confusion: {}, share: {} },
    rows: [row({ id: 'ema_stack', weight: 0.5 })], conditions: [cond({}), cond({ key: 'rule|ema_stack|1h', lo: 37, hi: null, effect: 'breaks', expBps: -20, expConfBps: -12 })] }));
  const rb = new RuleBook(() => file);
  const at = (adx: number) => ({ ...snap([{ id: 'rsi_extreme', tf: '1h', dir: 1, strength: 1 }, { id: 'ema_stack', tf: '1h', dir: 1, strength: 1 }]), ts: T0, tf: { '1h': { adx } } }) as unknown as TaSnapshot;
  const calm = rb.read(at(15), 4)!;
  assert.deepEqual(calm.agree.sort(), ['ema_stack@1h', 'rsi_extreme@1h'], 'rsi_extreme counts in a calm trend though it did not pass alone');
  const strong = rb.read(at(45), 4)!;
  assert.deepEqual(strong.agree, [], 'in a strong trend: rsi_extreme has no condition, ema_stack is silenced');
  assert.deepEqual(strong.silenced, ['ema_stack@1h']);
  assert.equal(rb.passedConditions().length, 2);
});

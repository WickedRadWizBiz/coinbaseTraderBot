import assert from 'node:assert/strict';
import { test } from 'node:test';
import { altcoinRiskOn, confluenceBreadth, directionalConviction, orientedSignals, reliability, selectionPriority, taDrift, taNetDirection } from '../bot/strategy/taConviction';
import { evaluateEntry } from '../bot/strategy/adversary';
import { LaneBook, DEFAULT_LANES } from '../bot/setups/lanes';

const CFG = { weight: 1, maxShift: 0.06, maxZ: 0.5, live: false, altBoost: 2.5, altUsdtdMaxZ: 0, altRsiMin: 50, nonAlts: ['BTC'] };

test('TA conviction: reliability follows validation and graded skill', () => {
  assert.equal(reliability(true, undefined, 0, false), 1);
  assert.equal(reliability(true, 0.05, 100, false), 1);
  assert.equal(reliability(true, -0.05, 100, false), 0.5, 'a validated head whose live skill turns clearly negative counts half');
  assert.equal(reliability(true, -0.05, 10, false), 1, 'but not before 24 graded calls');
  assert.equal(reliability(false, undefined, 0, false), 0, 'a head that failed its blind test: nothing, paper or live');
  assert.equal(reliability(false, undefined, 0, true), 0);
  assert.equal(reliability(false, 0.05, 100, false), 0, 'its rolling live skill never promotes it');
});

test('TA conviction: drift points with the forecast and shrinks over shorter contracts', () => {
  const v = { up1: 0.6, validated1: true };
  const d15 = taDrift(v, 900, CFG)!, d60 = taDrift(v, 3600, CFG)!;
  assert.ok(d15.k > 0 && d60.k > d15.k, `${d15.k} ${d60.k}`);
  assert.ok(taDrift({ up1: 0.4, validated1: true }, 900, CFG)!.k < 0);
  assert.equal(taDrift({ up1: 0.7, skill1: 0.05, graded1: 100 }, 900, CFG), undefined, 'an unvalidated head does not move prices, whatever its live skill');
  // Reliability weighs a head once: a half-trusted head alone gives the same drift as a fully trusted one.
  const half = taDrift({ up1: 0.6, validated1: true, skill1: -0.05, graded1: 100 }, 900, CFG)!;
  assert.deepEqual(half.parts, ['1h P(up) 0.600 x0.50']);
  assert.ok(Math.abs(half.k - d15.k) < 1e-12, `${half.k} ${d15.k}`);
  // |z| is capped.
  assert.ok(taDrift({ up1: 0.99, validated1: true }, 3600, CFG)!.k <= 0.5 + 1e-9);
});

test('TA conviction: breadth counts agreeing signals net of those against', () => {
  const f = { conf_count: 2, taconf_net_trend: 3, taconf_trend_alignment: 0.5, ta_rsi_1h: 0.2, ta_ema_stack_1h: -1 };
  const s = orientedSignals(f, { up1: 0.6, validated1: true }, false);
  const up = confluenceBreadth(s, 1), dn = confluenceBreadth(s, -1);
  // One vote per idea: the TA network, the confluence count and the momentum family (3 of its 4 readings bullish).
  assert.deepEqual(s.map(([n]) => n), ['TA net', 'confluence count', 'momentum']);
  assert.ok(Math.abs(s[2][1] - 0.5) < 1e-12, 'momentum: the mean sign of its readings');
  assert.equal(up.agree.length, 3);
  assert.equal(up.oppose.length, 0);
  assert.ok(Math.abs(up.breadth - 3 / 4) < 1e-9);
  assert.equal(dn.breadth, 0);
  assert.equal(orientedSignals(f, { up1: 0.6, validated1: false, skill1: 0.05, graded1: 100 }, false).some(([n]) => n === 'TA net'), false, 'a failed head casts no vote');
  assert.ok(taNetDirection({ up1: 0.6, validated1: true }, false)! > 0);
});

test('TA conviction: altcoin risk-on needs an altcoin, USDT.D falling and RSI above 50', () => {
  assert.equal(altcoinRiskOn('SOL', -0.8, 0.1, CFG).active, true);
  assert.equal(altcoinRiskOn('BTC', -0.8, 0.1, CFG).active, false);
  assert.equal(altcoinRiskOn('SOL', 0.3, 0.1, CFG).active, false, 'USDT.D rising');
  assert.equal(altcoinRiskOn('SOL', -0.8, -0.1, CFG).active, false, 'RSI below 50');
  assert.equal(altcoinRiskOn('SOL', undefined, 0.1, CFG).active, false);
  assert.ok(selectionPriority(true, 0, 0, 0) > selectionPriority(false, 1, 1, 1));
});

test('TA conviction: perp longs on an altcoin in risk-on get 2.5x, capped in total; shorts do not', () => {
  const f = { usdtd_ret_15m_z: -1, ta_rsi_1h: 0.2, conf_count: 2, taconf_net_trend: 2, taconf_trend_alignment: 0.5, taconf_mtf_momentum: 0.4 };
  const c = { ...CFG, maxBoost: 2, maxTotal: 2.5 };
  const long = directionalConviction('XRP', 1, f, undefined, c);
  assert.equal(long.mult, 2.5);
  assert.match(long.why, /altcoin risk-on/);
  const short = directionalConviction('XRP', -1, f, undefined, c);
  assert.equal(short.mult, 1, 'everything agrees with up: no breadth for a short');
  assert.ok(long.priority > short.priority);
  const btc = directionalConviction('BTC', 1, f, undefined, c);
  assert.equal(btc.mult, 1.5, 'two ideas agree (confluence count, momentum) of the four a full boost needs: half the confluence boost');
  const full = directionalConviction('BTC', 1, f, { up1: 0.6, validated1: true }, { ...c, ruleBook: { score: 0.8, n: 3 } });
  assert.equal(full.mult, 2, 'four independent ideas agree: the full confluence boost (max 2x)');
});

test('adversary: the TA network against the side breaks it; breadth scales the boost', () => {
  const base = {
    side: 'yes' as const, cost: 0.5, fee: 0.0175, q: 0.62, features: { conf_count: 3 }, predict: () => 0.62, taFeatures: ['conf_count'], direction: 1,
    fairValue: 0.62, stressFairValue: () => 0.62, pStd: 0, fastMove: false, imbalance: 0.1, seed: 1, maxBoost: 2,
  };
  assert.equal(evaluateEntry({ ...base, taDir: -0.6 }).broken, true);
  const full = evaluateEntry({ ...base, taDir: 0.6, breadth: 1 }).multiplier;
  const half = evaluateEntry({ ...base, taDir: 0.6, breadth: 0.5 }).multiplier;
  assert.ok(full > half && half > 1, `${full} ${half}`);
  assert.equal(evaluateEntry({ ...base, breadth: 0 }).multiplier, 1);
});

test('lanes: higher-priority candidates are entered first and the multiplier scales notional', () => {
  const book = new LaneBook({ ...DEFAULT_LANES, fast: { ...DEFAULT_LANES.fast, maxPositions: 1 }, maxLeverage: 10, maxAssetLeverage: 5 });
  const sig = (asset: string) => ({ asset, lane: 'fast' as const, tf: '15m' as const, kind: 'burst', dir: 1, ts: 0, ref: 100, stop: 99, plan: { target1: 102 } });
  book.offer(sig('BTC') as never, 0.5, 0);
  book.offer(sig('SOL') as never, 0.3, 0);
  const got = book.select(1, 1000, (c) => ({ px: 100, score: c.score, mult: c.sig.asset === 'SOL' ? 2.5 : 1 }), (c) => (c.sig.asset === 'SOL' ? 10 : 0));
  assert.equal(got.length, 1);
  assert.equal(got[0].cand.sig.asset, 'SOL', 'priority beats the higher score');
  assert.equal(got[0].mult, 2.5);
});

test('TA conviction: the altcoin boost on a perp long is vetoed when the TA network or the confluence is against it', () => {
  const c = { ...CFG, maxBoost: 2, maxTotal: 2.5 };
  const riskOn = { usdtd_ret_15m_z: -1, ta_rsi_1h: 0.2 };
  const against = directionalConviction('XRP', 1, riskOn, { up1: 0.4, up4: 0.4, validated1: true, validated4: true }, c);
  assert.equal(against.mult, 1);
  assert.match(against.why, /boost vetoed: TA network against/);
  assert.ok(against.priority < 10, 'a vetoed boost does not jump the queue');
  const bearish = directionalConviction('XRP', 1, { ...riskOn, conf_count: -2, taconf_net_trend: -2, ta_ema_stack_1h: -1 }, undefined, c);
  assert.equal(bearish.mult, 1);
  assert.match(bearish.why, /signals against/);
  assert.equal(directionalConviction('XRP', 1, riskOn, undefined, c).mult, 2.5, 'nothing against: boosted');
});

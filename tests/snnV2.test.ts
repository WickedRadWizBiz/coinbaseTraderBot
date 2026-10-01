// SNN v2 wiring: Live Tennis API scores, SNN features for the MLP, the take/skip head, the tennis
// MLP gate, and the engine feeding every crypto column 24/7.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { computeFeatureMap, FEATURES } from '../bot/model/featureEngine';
import { applyTakeGate, takeInputs, takeProbability, type TakeModelParams } from '../bot/model/takeModel';
import { OrderBook } from '../bot/marketdata/orderBook';
import { IndexTracker } from '../bot/marketdata/indexTracker';
import { diffScore, findMatch, playerIndexForTitle, TennisScoreClient, toTennisScore, type LiveTennisMatch } from '../bot/tennis/liveTennisApi';
import { TENNIS_FAIR_FEATURES, TennisFairModel, tennisFairInputs } from '../bot/tennis/tennisFair';
import { decideMatch, MatchTracker } from '../bot/tennis/tennisStrategy';
import { PERP_FEATURES } from '../bot/perps/perpSignal';
import { fitTakeModel } from '../research/trainMetaModel';
import { Xoshiro128 } from '../bot/snn/rng';
import { tmpDir } from './helpers';

const T0 = Date.UTC(2026, 5, 1, 12);

const match = (o: Partial<LiveTennisMatch> = {}): LiveTennisMatch => ({
  id: 7, status: 'live', tour: 'ATP', sets: [1, 0], games: [[6, 2], [4, 3]], points: ['40', '15'], server: 2, is_tiebreak: false,
  player1: { name: 'Carlos Alcaraz' }, player2: { name: 'Jannik Sinner' }, ...o,
});

test('live tennis: name matching to Kalshi titles, orientation, current-set games, tiebreak points, breaks', () => {
  const m = match();
  assert.equal(playerIndexForTitle(m, 'Will Jannik Sinner win the Alcaraz vs Sinner match?'), 1);
  assert.equal(playerIndexForTitle(m, 'Will Carlos Alcaraz win the Alcaraz vs Sinner match?'), 0);
  const hit = findMatch([match({ id: 1, player1: 'Novak Djokovic', player2: 'Daniil Medvedev' }), m], 'Will Jannik Sinner win the Alcaraz vs Sinner match?', 'Will Carlos Alcaraz win the Alcaraz vs Sinner match?')!;
  assert.equal(hit.match.id, 7); assert.equal(hit.flip, true, 'our player A is API player two');
  const s = toTennisScore(m, true)!;
  assert.deepEqual(s, { setsA: 0, setsB: 1, gamesA: 3, gamesB: 2, pointsA: 1, pointsB: 3, serverA: true });
  const tb = toTennisScore(match({ is_tiebreak: true, points: ['5', '3'] }))!;
  assert.equal(tb.pointsA, 5); assert.equal(tb.pointsB, 3);
  // Player one breaks: 6-2, 4-3 (player two serving) -> 6-2, 5-3.
  const d = diffScore(m, match({ games: [[6, 3], [4, 3]] })); // player one wins a game on player two's serve
  assert.deepEqual(d.breaks, [1, 0]); assert.equal(d.exact, true);
});

test('live tennis client: daily budget with an exit reserve, shared cache, persisted counter, 429 back-off', async () => {
  const file = path.join(tmpDir(), 'budget.json');
  let calls = 0, status = 200, now = T0;
  const fetchFn = (async () => { calls++; return { status, ok: status === 200, headers: { get: () => '30' }, json: async () => ({ data: [match()], meta: { offset: 0, limit: 200, has_more: false } }), text: async () => 'slow down' }; }) as unknown as typeof fetch;
  const c = new TennisScoreClient({ apiKey: 'k', fetchFn, now: () => now, stateFile: file, dailyLimit: 3, exitReserve: 1, cacheTtlMs: 20_000 });
  assert.equal((await c.getLiveSlate())!.length, 1);
  assert.equal((await c.getLiveSlate())!.length, 1); assert.equal(calls, 1, 'cached within 20 s');
  now += 21_000; await c.getLiveSlate();
  now += 21_000; assert.equal(await c.getLiveSlate('normal'), null, 'normal calls stop at limit - reserve');
  assert.ok(await c.getLiveSlate('exit'), 'the reserve is for exit decisions');
  assert.equal(c.usage().callsToday, 3);
  const c2 = new TennisScoreClient({ apiKey: 'k', fetchFn, now: () => now, stateFile: file, dailyLimit: 3 });
  assert.equal(c2.usage().callsToday, 3, 'restart keeps the day\'s count');
  status = 429; now += 86_400_000;
  const c3 = new TennisScoreClient({ apiKey: 'k', fetchFn, now: () => now, stateFile: path.join(tmpDir(), 'b2.json') });
  assert.equal(await c3.getLiveSlate(), null);
  assert.ok(c3.usage().blockedUntil! > now, 'Retry-After honoured');
});

test('features: SNN outputs reach the MLP (and the perps) as features', () => {
  const idx = new IndexTracker('BTC');
  for (let s = 600; s >= 0; s--) idx.add(60000 + s, T0 - s * 1000);
  const f = computeFeatureMap({
    now: T0, fairValue: 0.6, mid: 0.55, tauSec: 600, sigmaPerSqrtSec: 1e-4, referenceSigma: 1e-4, inWindow: true, book: new OrderBook('x'), index: idx, asset: 'BTC',
    openTime: T0 - 300_000, closeTs: T0 + 600_000,
    snn: { up: { 15: 0.7, 60: 0.4, 240: 0.55 }, move: { 15: 12, 60: -5 }, pContract: 0.65 },
  });
  assert.ok(Math.abs(f.snn_up_15m - Math.log(0.7 / 0.3)) < 1e-9);
  assert.ok(Math.abs(f.snn_up_h - f.snn_up_15m) < 1e-12, '15-minute contract uses the 15m call');
  assert.ok(Math.abs(f.snn_bias - (Math.log(0.65 / 0.35) - Math.log(0.6 / 0.4))) < 1e-9);
  assert.equal(f.snn_dir_agree, 1);
  assert.ok(f.snn_move_h_z > 0);
  assert.equal(FEATURES.snn_up_15m.group, 'snn');
  assert.ok(PERP_FEATURES.includes('snn_up_1h') && PERP_FEATURES.includes('snn_up_4h'), 'perps read the 1h and 4h calls');
  const none = computeFeatureMap({ now: T0, fairValue: 0.6, mid: 0.55, tauSec: 600, sigmaPerSqrtSec: 1e-4, referenceSigma: 1e-4, inWindow: true, book: new OrderBook('x'), index: idx, asset: 'BTC' });
  assert.ok(Number.isNaN(none.snn_up_15m), 'no SNN -> NaN (imputed as the training mean)');
});

test('take/skip head: trained out-of-fold, validated only when it beats the fair value, gates entries not exits', () => {
  // Synthetic OOF trades where the SNN direction carries information the fair value lacks.
  const r = new Xoshiro128(5);
  const rows: never[] = [], p: number[] = [];
  for (let w = 0; w < 600; w++) for (let k = 0; k < 2; k++) {
    const up = r.next() < 0.5 ? 1.5 : -1.5;
    const truth = 1 / (1 + Math.exp(-(0.4 + 0.9 * up)));
    const y = r.next() < truth ? 1 : 0;
    (rows as unknown[]).push({ window: T0 + w * 900_000, bid: 0.4, ask: 0.42, tauSec: 500, label: y, fx: { snn_up_h: up, snn_bias: 0 } });
    p.push(0.6);
  }
  const take = fitTakeModel(rows, p, 0.02, 7)!;
  assert.ok(take, 'trained');
  assert.equal(take.validation.validated, true, JSON.stringify(take.validation));
  const qUp = takeProbability(take, takeInputs('yes', 0.6, 0.42, 0.02, 500, { snn_up_h: 1.5 }));
  const qDn = takeProbability(take, takeInputs('yes', 0.6, 0.42, 0.02, 500, { snn_up_h: -1.5 }));
  assert.ok(qUp > qDn + 0.2, `SNN agreement raises P(win): ${qUp} vs ${qDn}`);
  const plan = { place: [
    { side: 'bid', price: 0.42, count: 5, postOnly: false, reduceOnly: false, purpose: 'quote', timeInForce: 'immediate_or_cancel', edge: 0.1, why: '' },
    { side: 'ask', price: 0.5, count: 5, postOnly: false, reduceOnly: true, purpose: 'exit', timeInForce: 'immediate_or_cancel', edge: 0, why: '' },
  ] as never[], notes: [] as string[] };
  const skipped = applyTakeGate(plan, take, { pYes: 0.6, features: { snn_up_h: -1.5 }, tauSec: 500, bid: 0.4, ask: 0.42, margin: 0 });
  assert.equal(skipped, 1); assert.equal(plan.place.length, 1); assert.equal((plan.place[0] as { purpose: string }).purpose, 'exit');
  assert.match(plan.notes[0], /take model: skip YES/);
  const unvalidated: TakeModelParams = { ...take, validation: { ...take.validation, validated: false } };
  const plan2 = { place: [...(plan.place as never[])], notes: [] as string[] };
  assert.equal(applyTakeGate(plan2, unvalidated, { pYes: 0.6, features: { snn_up_h: -1.5 }, tauSec: 500, bid: 0.4, ask: 0.42, margin: 0 }), 0, 'never gates before validation');
});

test('tennis MLP: residual on the market, and a validated model gates tennis entries', () => {
  const n = TENNIS_FAIR_FEATURES.length;
  const zero = { features: [...TENNIS_FAIR_FEATURES], normalization: { mean: new Array(n).fill(0), std: new Array(n).fill(1) }, layers: [{ weights: [new Array(n).fill(0)], bias: [0], activation: 'linear' as const }], residual: 0, version: 't', trainedAt: '', validation: { matches: 150, holdoutMatches: 30, brierModel: 0.2, brierMarket: 0.21, validated: true } };
  const m = new TennisFairModel(zero);
  const f = tennisFairInputs({ mid: 0.3, momentum: 0.02 });
  assert.ok(Math.abs(m.predict(f) - 0.3) < 1e-9, 'no evidence -> the market');
  const file = path.join(tmpDir(), 'tm.json');
  fs.writeFileSync(file, JSON.stringify({ ...zero, layers: [{ weights: [new Array(n).fill(0)], bias: [-1], activation: 'linear' }] }));
  const lower = TennisFairModel.load(file)!;
  assert.ok(lower.predict(f) < 0.3 && lower.validated);
  // Gate: an underdog entry the rules would take is skipped when the model's fair value is below the price.
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), TENNIS_ENTRY_MIN_SIGNALS_PRE: '0' }).tennis;
  const t = new MatchTracker('EV', cfg);
  const mk = (ticker: string, bid: number, ask: number) => ({ ticker, title: ticker, position: 0, quote: { bid, ask, bidSize: 100, askSize: 100 } });
  const markets = [mk('EV-A', 0.17, 0.18), mk('EV-B', 0.81, 0.83)];
  const base = { event: 'EV', now: T0, startTime: T0 + 10 * 60_000, markets, closeTime: T0 + 6 * 3_600_000 };
  const budget = { bankroll: 200, tennisRisk: 0, matchRisk: 0 };
  const free = decideMatch(t, base, cfg, budget);
  const t2 = new MatchTracker('EV', cfg);
  const gated = decideMatch(t2, { ...base, fairA: 0.1 }, cfg, budget);
  assert.ok(free.plans.some((pl) => pl.leg === 'underdog_entry'), 'the rules alone would enter');
  assert.ok(!gated.plans.some((pl) => pl.leg === 'underdog_entry'), JSON.stringify(gated));
  assert.ok(gated.notes.some((x) => /tennis model: fair/.test(x)));
  const t3 = new MatchTracker('EV', cfg);
  assert.ok(decideMatch(t3, { ...base, fairA: 0.3 }, cfg, budget).plans.some((pl) => pl.leg === 'underdog_entry'), 'fair above the price: entry allowed');
});

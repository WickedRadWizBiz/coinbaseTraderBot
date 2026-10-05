// Kill-switch override (paper and live), paper capital-exhaustion refills, break-even sizing (the same in
// every mode), the results-vs-expectation diagnostic, and the tournament rule that sitting out must not win.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Alerter } from '../bot/alerts/alerter';
import { loadConfig } from '../bot/config';
import { RunControl } from '../bot/control';
import type { Engine } from '../bot/engine';
import type { Oms } from '../bot/oms/oms';
import { BreakEven, breakEvenScale, EquityGuard, SIZE_FLOOR } from '../bot/risk/equityGuard';
import { KillSwitch } from '../bot/risk/killSwitch';
import { RiskGateway } from '../bot/risk/riskGateway';
import { DEFAULT_STREAK, StreakScaler } from '../bot/risk/streakScaler';
import { TrainingSupervisor } from '../bot/training/supervisor';
import { coverageFloor, type FitnessReport } from '../bot/util/fitness';
import { tmpAudit, tmpDir } from './helpers';

// mulberry32: small, well-mixed PRNG for reproducible outcome sequences.
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

test('override is ON by default, remembered, and switchable', () => {
  const f = path.join(tmpDir(), 'control.json');
  const c = new RunControl(f);
  assert.equal(c.killOverride, true);
  c.setOverride(false);
  assert.equal(new RunControl(f).killOverride, false, 'persisted');
  c.set(false);
  assert.equal(new RunControl(f).killOverride, false, 'PLAY/STOP keeps the override setting');
  assert.equal(new RunControl(f).active, false);
});

test('kill switch: automatic trips are suppressed while vetoed; manual engagement never is', async () => {
  const audit = tmpAudit();
  const k = new KillSwitch(path.join(tmpDir(), 'kill.json'), audit);
  let veto: string | undefined = 'paper training override';
  k.setSuppressor(() => veto);
  assert.equal(await k.engage('daily loss $4 reached limit $3', 'risk'), false);
  assert.equal(k.engaged, false);
  assert.equal(await k.engage('operator', 'api:127.0.0.1'), true, 'manual');
  assert.equal(k.engaged, true);
  k.reset('test');
  veto = undefined;
  assert.equal(await k.engage('daily loss', 'risk'), true, 'no veto: engages as before');
});

test('streak scaler: ordinary bad luck barely moves it; an overconfident model is cut, never to zero; it recovers', () => {
  const calibrated = new StreakScaler();
  const r = rng(7);
  for (let i = 0; i < 400; i++) { const q = 0.35 + 0.3 * r(); calibrated.observeBinary(q, r() < q); }
  assert.ok(calibrated.scale() > 0.75, `calibrated model keeps most of its size (${calibrated.scale()})`);

  const over = new StreakScaler();
  for (let i = 0; i < 120; i++) { const q = 0.7; over.observeBinary(q, r() < 0.45); } // thinks 70%, wins 45%
  assert.ok(over.scale() <= 0.5, `overconfident model is cut (${over.scale()})`);
  assert.ok(over.scale() >= DEFAULT_STREAK.floor, 'never below the floor');
  for (let i = 0; i < 200; i++) { const q = 0.5; over.observeBinary(q, r() < 0.5); }
  assert.ok(over.scale() > 0.75, `recovers once results match expectations again (${over.scale()})`);

  const early = new StreakScaler();
  for (let i = 0; i < 5; i++) early.observeBinary(0.6, false);
  assert.equal(early.scale(), 1, 'too few observations to judge');
});

test('risk gateway: the daily loss limit is advisory in training mode (no reject, no kill trip)', () => {
  const gw = new RiskGateway(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) }).risk);
  const ctx: Parameters<RiskGateway['check']>[1] = {
    now: Date.now(), mode: 'paper', killEngaged: false, haltReasons: [], bankroll: 100, dailyPnl: -50, bookUsable: true, bestBid: 0.4, bestAsk: 0.42,
    indexFresh: true, marketCloseTs: Date.now() + 600_000, tickSize: 0.01, fees: { takerMultiplier: 0.07, makerMultiplier: 0 }, position: 0,
    marketRiskNow: 0, marketRiskWith: 1, windowRisk: 0, totalRisk: 0, ordersLastMinute: 0, openOrders: 0, modelLiveBlockers: [],
  } as never;
  const intent = { ticker: 'KXBTC15M-X', asset: 'BTC', windowCloseTs: Date.now() + 600_000, side: 'bid', price: 0.4, count: 1, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', fairValue: 0.6, modelId: 'm', decisionId: 'd' } as never;
  const hard = gw.check(intent, ctx);
  assert.ok(hard.tripKill, 'normally trips the kill switch');
  const soft = gw.check(intent, { ...(ctx as object), dailyLossAdvisory: true } as never);
  assert.equal(soft.tripKill, undefined);
  assert.ok(!soft.reasons.some((x) => x.includes('daily loss')), soft.reasons.join('; '));
});

test('supervisor: an exhausted paper pool is logged as a training epoch and refilled; automatic kills are released', async () => {
  const dir = tmpDir();
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), DATA_DIR: dir, PAPER_BANKROLL_USD: '100' });
  const audit = tmpAudit();
  const control = new RunControl(path.join(dir, 'control.json'));
  const kill = new KillSwitch(path.join(dir, 'kill.json'), audit);
  let balance = 6; // $6 left: below the $10 tradable minimum
  const oms = Object.assign(new EventEmitter(), { cancelAll: async () => ({ canceled: 0, errors: 0 }) }) as unknown as Oms;
  const streak = { crypto: new StreakScaler(), tennis: new StreakScaler() };
  const engine = {
    bankroll: () => balance, equity: () => balance, onBalance: (b: number) => { balance = b; },
    riskScale: () => ({ scale: 1, parts: [] }), streak, noteCashFlow: () => {},
  } as unknown as Engine;
  const refills: number[] = [];
  const guard = new EquityGuard({ ddScaleAt: 0.15, weeklyLossPause: 0.08 });
  guard.update(100, Date.now());
  const sup = new TrainingSupervisor({
    cfg, control, kill, engine, oms, audit, alerter: new Alerter([], audit), equityGuard: guard,
    kalshiPaper: { refill: (a) => { refills.push(a); balance += a; }, getBalance: async () => balance },
  });
  await kill.engage('daily loss $4.92 reached limit $3.00', 'risk'); // suppressed now
  assert.equal(kill.engaged, false, 'automatic trip suppressed by the override');
  await sup.tick();
  assert.deepEqual(refills, [94]);
  assert.equal(balance, 100);
  assert.equal(guard.kellyScale(100), 1, 'fresh epoch: the refilled equity is the new high-water mark');
  const epochs = fs.readFileSync(path.join(dir, 'epochs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(epochs.length, 1);
  assert.equal(epochs[0].cause, 'capital_exhaustion');
  assert.equal(epochs[0].endEquity, 6);
  assert.equal(sup.status().kalshi.epoch, 2);
  await sup.tick();
  assert.equal(refills.length, 1, 'no second refill while the pool is healthy');

  // Override off: nothing is refilled, automatic trips engage.
  control.setOverride(false);
  balance = 3;
  await sup.tick();
  assert.equal(refills.length, 1);
  assert.equal(await kill.engage('daily loss', 'risk'), true);
  // Override back on: the automatic kill is released at the next pass.
  control.setOverride(true);
  await sup.tick();
  assert.equal(kill.engaged, false);
  // A kill the operator pressed stays engaged.
  await kill.engage('operator', 'api:1.2.3.4');
  await sup.tick();
  assert.equal(kill.engaged, true);
});

test('break-even sizing: shrinks with net losses, back to full size once wins recoup them; never zero', () => {
  const g = new EquityGuard({ ddScaleAt: 0.15, weeklyLossPause: 0.08 });
  g.update(100, Date.now());
  assert.equal(g.sizeScale(100), 1, 'at break-even');
  assert.equal(g.sizeScale(130), 1, 'in profit: full size');
  assert.ok(Math.abs(g.sizeScale(92.5) - (1 - 0.75 * 0.5)) < 1e-9, 'half way to the threshold: 0.625');
  assert.equal(g.sizeScale(85), SIZE_FLOOR, 'at the threshold: the floor');
  assert.equal(g.sizeScale(10), SIZE_FLOOR, 'deep loss: still the floor, never zero');
  // A run up to 130 and back to 100 is still break-even: wins equal losses -> full size (unlike the
  // high-water-mark brake, which would read 23% drawdown).
  g.update(130, Date.now());
  assert.equal(g.sizeScale(100), 1);
  assert.ok(g.kellyScale(100) < 1, 'the high-water-mark measure would still be cut');
  // Cash flows move break-even; P&L does not.
  g.onCashFlow(50, Date.now());
  assert.equal(g.netPnl(150), 0, 'a $50 deposit is not profit');
  assert.ok(g.sizeScale(140) < 1, '$10 net loss after the deposit');
  // A new training epoch resets break-even to the refilled equity.
  g.resetEpoch(100, Date.now());
  assert.equal(g.sizeScale(100), 1);
  assert.equal(breakEvenScale(undefined, 50, 0.15), 1, 'no reference yet: full size');
  const be = new BreakEven();
  be.observe(40);
  assert.ok(be.scale(37, 0.15) < 1 && be.scale(40, 0.15) === 1);
  be.reset(100);
  assert.equal(be.scale(100, 0.15), 1);
});

test('supervisor: live mode never refills; the override covers only the loss-limit trip', async () => {
  const dir = tmpDir();
  const cfg = { ...loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), DATA_DIR: dir }), mode: 'live' } as never;
  const audit = tmpAudit();
  const kill = new KillSwitch(path.join(dir, 'kill.json'), audit);
  const oms = Object.assign(new EventEmitter(), { cancelAll: async () => ({ canceled: 0, errors: 0 }) }) as unknown as Oms;
  const engine = { bankroll: () => 1, equity: () => 1, onBalance: () => {}, riskScale: () => ({ scale: 1, parts: [] }), streak: { crypto: new StreakScaler(), tennis: new StreakScaler() } } as unknown as Engine;
  const sup = new TrainingSupervisor({ cfg, control: new RunControl(path.join(dir, 'c.json')), kill, engine, oms, audit, alerter: new Alerter([], audit), kalshiPaper: { refill: () => assert.fail('no refill in live'), getBalance: async () => 1 } });
  assert.equal(sup.active(), false, 'no refills in live');
  assert.equal(await kill.engage('daily loss $4 reached limit $3', 'risk'), false, 'override on: the loss limit does not stop live trading');
  assert.equal(await kill.engage('persistent reconciliation break', 'recon'), true, 'malfunctions still trip it');
  await sup.tick();
  assert.equal(kill.engaged, true, 'a malfunction trip is not released by the override');
});

test('tournaments: a member that sits out cannot beat one that trades and loses a little', () => {
  const rep = (fitness: number): FitnessReport => ({ fitness, sortino: 0, maxDrawdown: 0, costs: 0, netReturn: 0, interactions: 0, independent: 0, days: 30 });
  const idle = coverageFloor(rep(0), 0, 1000, 0.05);
  const loser = coverageFloor(rep(-0.8), 120, 1000, 0.05);
  assert.ok(loser.fitness > idle.fitness, `${loser.fitness} > ${idle.fitness}`);
  assert.equal(coverageFloor(rep(1.2), 100, 1000, 0.05).fitness, 1.2, 'enough coverage: unchanged');
});

test('break-even ratchet: moves up with the pool on a $100 profit day, and after two losses that stay above break-even', () => {
  const day = Date.UTC(2026, 9, 5, 12);
  const g = new EquityGuard({ ddScaleAt: 0.15, weeklyLossPause: 0.08, dailyGoalUsd: 100 });
  g.update(100, day);
  assert.equal(g.update(180, day + 1000), undefined, '+$80: not yet');
  const r = g.update(205, day + 2000);
  assert.deepEqual(r && { from: r.from, to: r.to, reason: r.reason }, { from: 100, to: 205, reason: 'daily_goal' });
  assert.ok(g.sizeScale(190) < 1, 'losses from the new break-even shrink size');
  assert.equal(g.sizeScale(205), 1);
  // Two losses in a row that leave the pool above break-even move it up to the pool.
  const h = new EquityGuard({ ddScaleAt: 0.15, weeklyLossPause: 0.08, dailyGoalUsd: 100 });
  h.update(100, day);
  assert.equal(h.onTradeResult(false, 130, day), undefined, 'one loss');
  const r2 = h.onTradeResult(false, 125, day);
  assert.equal(r2?.reason, 'two_losses');
  assert.equal(r2?.to, 125);
  assert.equal(h.onTradeResult(true, 128, day), undefined);
  assert.equal(h.onTradeResult(false, 126, day), undefined, 'a win resets the count');
  // Two losses that take the pool BELOW break-even do not move it (size already shrinks).
  const k = new EquityGuard({ ddScaleAt: 0.15, weeklyLossPause: 0.08 });
  k.update(100, day);
  k.onTradeResult(false, 99, day);
  assert.equal(k.onTradeResult(false, 97, day), undefined);
  assert.equal(k.netPnl(97), -3);
  // Perps: the same rule on its own account.
  const be = new BreakEven();
  be.observe(100);
  be.onEquity(100, day, 100);
  assert.equal(be.onEquity(201, day + 1, 100)?.reason, 'daily_goal');
  assert.equal(be.reference, 201);
});

import { replaySizing, tuneSizing, type TradeRecord } from '../research/tuneSizing';

test('sizing tuner: oversizing loses to the right size through exhaustions, never by not trading; proposal only when enough trades', () => {
  const r = rng(11);
  // A modest real edge: the model says 60% on 50c contracts that win 56% of the time.
  const trades: TradeRecord[] = Array.from({ length: 1500 }, (_, i) => ({ ts: i * 60_000, ticker: `T${i}`, book: 'crypto', q: 0.6, cost: 0.5, count: 1, won: r() < 0.56 }));
  const small = replaySizing(trades, { kelly: 0.15, lossAt: 0.15 }, { maxOrderFrac: 1 });
  const huge = replaySizing(trades, { kelly: 1, lossAt: 1 }, { maxOrderFrac: 1 });
  assert.ok(small.growthPerTrade > huge.growthPerTrade, `${small.growthPerTrade} > ${huge.growthPerTrade}`);
  assert.ok(huge.exhaustions >= small.exhaustions);
  assert.ok(small.trades > 0, 'it keeps trading');
  const p = tuneSizing(trades, { kelly: 0.25, lossAt: 0.15 });
  assert.equal(p.ready, true);
  assert.ok(p.best.growthPerTrade >= p.current.growthPerTrade);
  assert.equal(tuneSizing(trades.slice(0, 50), { kelly: 0.25, lossAt: 0.15 }).ready, false, 'not enough trades yet');
});

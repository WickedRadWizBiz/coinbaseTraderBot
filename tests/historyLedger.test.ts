// History ledger (labelled weekly blocks, what each network trained and was judged on), the readiness
// scores and target, and what the pipeline counts as an improvement.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { championDecision } from '../research/champion';
import { daysOf, HistoryLedger, HOLDOUT_RULE, isHoldout, isoWeek, spread, weekBlocks } from '../research/historyLedger';
import { dailyStats, ledgerStatus, solidWholeBot, targetMet } from '../research/readiness';
import { holdoutDays, perpRuleRecord, type PerpRow } from '../research/trainPerpModel';
import { PERP_FEATURES, PerpModel } from '../bot/perps/perpSignal';
import { tmpDir } from './helpers';

const DAY = 86_400_000;
const daysFrom = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * DAY).toISOString().slice(0, 10));

test('history ledger: ISO weeks, complete weekly blocks, a holdout set that never moves', () => {
  assert.equal(isoWeek('2021-01-04'), '2021-W01');
  assert.equal(isoWeek('2021-01-03'), '2020-W53', 'a Sunday belongs to the week before');
  assert.equal(isoWeek('2024-12-30'), '2025-W01');
  assert.equal(isoWeek('2021-05-16'), '2021-W19');
  const days = daysFrom('2020-01-01', 1000);
  const blocks = weekBlocks(days);
  assert.equal(blocks[0].id, '2020-W02', '2020-01-01 is a Wednesday: its week is incomplete');
  assert.ok(blocks.every((b) => b.days.length === 7 && b.days.every((d) => isoWeek(d) === b.id)));
  assert.equal(weekBlocks(['2021-01-04', '2021-01-06']).length, 0);
  assert.deepEqual(weekBlocks(['2021-01-04', '2021-01-06'], 1).map((b) => b.id), ['2021-W01'], 'sparse histories (tennis)');
  const latest = days[days.length - 1];
  const hold = blocks.filter((b) => isHoldout(b, latest));
  assert.ok(hold.length > 10);
  for (let i = 1; i < hold.length; i++) assert.equal(Date.parse(hold[i].days[0]) - Date.parse(hold[i - 1].days[0]), 8 * 7 * DAY, 'every 8th week');
  assert.ok(hold.every((b) => Date.parse(latest) - Date.parse(b.days[0]) >= 182 * DAY), 'never in the newest half year');
  const later = daysFrom('2020-01-01', 1400);
  const hold2 = new Set(weekBlocks(later).filter((b) => isHoldout(b, later[later.length - 1])).map((b) => b.id));
  assert.ok(hold.every((b) => hold2.has(b.id)), 'more history never moves a week out of the holdout');
  assert.equal(HOLDOUT_RULE, 'w8-182d');
  assert.deepEqual(spread([1, 2, 3, 4, 5, 6, 7, 8, 9], 3), [1, 5, 9]);
  assert.deepEqual(daysOf(blocks, [blocks[1].id]), blocks[1].days);
});

test('history ledger: every generation on fresh weeks, contests on the least-judged holdout weeks, persisted', () => {
  const file = path.join(tmpDir(), 'work', 'history-ledger.json');
  const days = daysFrom('2020-01-06', 7 * 60);
  const blocks = weekBlocks(days), latest = days[days.length - 1];
  const train = blocks.filter((b) => !isHoldout(b, latest)), hold = blocks.filter((b) => isHoldout(b, latest));
  assert.equal(blocks.length, 60);
  assert.ok(hold.length >= 4);
  const L = new HistoryLedger(file);
  const seen = new Set<string>();
  let gens = 0;
  for (;;) {
    const pick = L.pickTrain('snn-perps', blocks, 5, latest);
    if (!pick.length) break;
    assert.ok(pick.every((b) => !isHoldout(b, latest) && !seen.has(b.id)), 'never a holdout week, never a week already trained on');
    if (gens === 0) assert.ok(Date.parse(pick[pick.length - 1].days[0]) - Date.parse(pick[0].days[0]) > 300 * DAY, 'spread over the timeline');
    const g = L.begin('snn-perps', 'tournament', pick, undefined, 1000 + gens);
    assert.equal(g.id, `t${gens + 1}`);
    assert.equal(L.current('snn-perps', 'tournament')?.id, g.id, 'unfinished: continued on the next run');
    L.markTrained('snn-perps', g.blocks);
    L.finish('snn-perps', g.id, 'elite #1');
    assert.equal(L.current('snn-perps', 'tournament'), undefined);
    for (const id of g.blocks) seen.add(id);
    gens++;
  }
  assert.equal(seen.size, train.length, 'every training week used exactly once');
  assert.equal(gens, Math.ceil(train.length / 5));
  // No fresh week left: only a tournament that must run (a new stage) takes the weeks used least.
  assert.deepEqual(L.pickTrain('snn-perps', blocks, 5, latest), []);
  L.markTrained('snn-perps', [train[0].id]);
  const again = L.pickTrain('snn-perps', blocks, 3, latest, true);
  assert.equal(again.length, 3);
  assert.ok(!again.some((b) => b.id === train[0].id), 'the least-used weeks first');
  // Contests: the holdout weeks judged least, so the next contest uses other weeks.
  const c1 = L.pickContest('snn-perps', blocks, 2, latest);
  assert.equal(c1.length, 2);
  assert.ok(c1.every((b) => isHoldout(b, latest)));
  const g = L.begin('snn-perps', 'contest', c1, 'candidate');
  L.markJudged('snn-perps', g.blocks);
  L.finish('snn-perps', g.id);
  const c2 = L.pickContest('snn-perps', blocks, 2, latest);
  assert.ok(!c2.some((b) => c1.some((x) => x.id === b.id)));
  L.save();
  const R = new HistoryLedger(file);
  const s = R.summary('snn-perps', blocks, latest);
  assert.deepEqual([s.weeks, s.trained, s.fresh, s.holdout, s.judged, s.generations], [60, train.length, 0, hold.length, 2, gens]);
  assert.equal(R.lastOf('snn-perps', 'contest')?.note, 'candidate');
  assert.equal(R.lastOf('snn-tennis', 'contest'), undefined);
  assert.deepEqual(R.names(), ['snn-perps']);
  const st = ledgerStatus(R, { 'snn-perps': blocks }, latest);
  assert.deepEqual([st[0].net, st[0].fresh, st[0].judged], ['snn-perps', 0, 2]);
  assert.match(st[0].lastContest!, /candidate/);
});

test('readiness: daily results in % of the pool, the target met only consistently, what solid means', () => {
  const pnl = [10, -4, 6, 0, 8, -2, 5, 3, -1, 7];
  const s = dailyStats(pnl, 200, daysFrom('2026-01-01', 10));
  assert.equal(s.days, 10);
  assert.ok(Math.abs(s.meanPct - 1.6) < 1e-9, '$3.20 a day on $200');
  assert.ok(Math.abs(s.perDayUsd - 3.2) < 1e-9);
  assert.equal(s.winDaysPct, 60);
  assert.equal(s.worstDayPct, -2);
  assert.ok(Math.abs(s.maxDdPct - (100 * 4) / 210) < 1e-9, 'from the $210 peak down to $206');
  assert.ok(s.ciLoPct < s.meanPct && s.meanPct < s.ciHiPct);
  assert.deepEqual([s.from, s.to], ['2026-01-01', '2026-01-10']);
  const t = { poolUsd: 200, dailyPct: 50, maxDdPct: 10, minDays: 30 };
  const miss = targetMet(s, t);
  assert.equal(miss.met, false);
  assert.ok(miss.why.some((w) => /10 held-out day/.test(w)));
  assert.ok(miss.why.some((w) => /\$100 on \$200/.test(w)));
  // $100 or more every day for 40 days, no drawdown: met; and solid.
  const rich = dailyStats(Array.from({ length: 40 }, (_, i) => 100 + (i % 5)), 200);
  assert.deepEqual(targetMet(rich, t), { met: true, why: [] });
  assert.equal(solidWholeBot(rich).solid, true);
  // The same mean with a deep drawdown is not met.
  const wild = dailyStats(Array.from({ length: 40 }, (_, i) => (i % 2 ? 260 : -60)), 200);
  const w = targetMet(wild, t);
  assert.equal(w.met, false);
  assert.ok(w.why.some((x) => /max drawdown 30\.0%/.test(x)));
  // Solid: interval above 0, drawdown within 15%, Sharpe 2+, 30+ days.
  assert.equal(solidWholeBot(s).solid, false);
  const modest = dailyStats(Array.from({ length: 60 }, (_, i) => [1.2, 0.8, -0.4, 1.0, 0.6][i % 5]), 200);
  assert.equal(solidWholeBot(modest).solid, true, '+0.32% a day, steadily');
  assert.equal(targetMet(modest, t).met, false);
  assert.equal(targetMet(modest, { ...t, dailyPct: 0.2 }).met, true);
});

test('champion: a promotion counts as an improvement only when the challenger beat the model in use', () => {
  assert.equal(championDecision(undefined, { validatedParts: 0 }).improved, true, 'the first model of its kind');
  assert.equal(championDecision({ validatedParts: 1, score: 0.2 }, { validatedParts: 1, score: 0.1 }).improved, true);
  assert.equal(championDecision({ validatedParts: 1 }, { validatedParts: 2 }).improved, true);
  const tie = championDecision({ validatedParts: 1, score: 0.2 }, { validatedParts: 1, score: 0.2 });
  assert.deepEqual([tie.promote, tie.improved], [true, false], 'the same score: fresher data, not progress');
  assert.match(tie.reason, /ties the live model/);
  const parts = championDecision({ validatedParts: 1 }, { validatedParts: 1 });
  assert.deepEqual([parts.promote, parts.improved], [true, false]);
  assert.equal(championDecision({ validatedParts: 1, score: 0.1 }, { validatedParts: 1, score: 0.2 }).improved, false);
});

test('perps contest: the live rule scored on held-out rows; the replay\'s holdout days', () => {
  const T0 = Date.parse('2024-03-04T00:00:00Z');
  const model = (w: number) => new PerpModel({ version: `w${w}`, kind: 'linear', horizonMin: 60, features: [PERP_FEATURES[0]], mean: [0], std: [1], weights: [w], bias: 0, residStdBps: 50, lambda: 1, trainedAt: 'x' });
  const rows: PerpRow[] = Array.from({ length: 200 }, (_, i) => {
    const sig = Math.sin(i * 1.7);
    return { ts: T0 + i * 3_600_000, asset: i % 2 ? 'BTC' : 'ETH', x: PERP_FEATURES.map((_, k) => (k === 0 ? sig : 0)), y: 30 * sig, fundingBps: 0 };
  });
  const o = { horizonMin: 60, makerBps: 1, entryEdgeBps: 2 };
  const good = perpRuleRecord(model(30), [...rows].reverse(), o), bad = perpRuleRecord(model(-30), rows, o), flat = perpRuleRecord(model(0), rows, o);
  assert.ok(good.trades >= 20 && good.meanBps > 0 && good.ic > 0.99, 'a model that reads the move earns after fees');
  assert.ok(bad.trades >= 20 && bad.meanBps < 0 && bad.ic < -0.99);
  assert.equal(flat.trades, 0, 'no edge over the fees: it never trades');
  const days = daysFrom('2020-01-06', 7 * 60);
  const held = holdoutDays(days);
  const holdWeeks = weekBlocks(days).filter((b) => isHoldout(b, days[days.length - 1]));
  assert.equal(held.size, 7 * holdWeeks.length);
  assert.ok(holdWeeks.every((b) => b.days.every((d) => held.has(d))));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, runConditioning, runTrial, STAGES, TIERS, WINDOW_DAYS, DEFAULT_RULES, type Stage } from '../research/conditioning';

const stagesFrom = (start = 0): Stage[] => {
  const out: Stage[] = [];
  let i = 0;
  TIERS.forEach((t, ti) => WINDOW_DAYS.forEach((n, wi) => { out.push({ index: i++, tier: ti, win: wi, cash: t.cash, days: Array.from({ length: n }, (_, k) => `d${start + i * 3 + k}`) }); }));
  return out;
};

test('a window passes on the profit held at its end, and fails if it ever fell 35 % below its starting cash', () => {
  assert.deepEqual(judge({ pnl: 120, minPnl: -50, trades: 9 }, 1000, DEFAULT_RULES), { passed: true });
  assert.equal(judge({ pnl: 140, minPnl: -40, trades: 9 }, 100, DEFAULT_RULES).passed, false, 'went 40 % down at $100 even though it ended +$140');
  assert.match(judge({ pnl: 90, minPnl: 0, trades: 3 }, 1000, DEFAULT_RULES).why!, /held \$90.00/, 'reached $100 earlier but did not keep it');
  assert.equal(STAGES, 21);
});

test('trial: instances are culled at their first failed window; the best is the one that got furthest', async () => {
  const stages = stagesFrom();
  // Instance k passes the first k windows; the live settings make $50 a window.
  const settings = [0, 4, 10, 21].map((k) => ({ k }));
  const r = await runTrial({
    trial: 0, stages, instances: settings.map((s, i) => ({ id: `i${i}`, settings: s, origin: 'test' })), baseline: { k: -1 }, rules: { ...DEFAULT_RULES, minTierC: 0 },
    evaluate: async (s, st) => (s.k < 0 ? { pnl: 50, minPnl: 0, trades: 1 } : st.index < s.k ? { pnl: 150, minPnl: -5, trades: 4 } : { pnl: 20, minPnl: -5, trades: 4 }),
  });
  assert.deepEqual(r.instances.map((x) => [x.id, x.passed]), [['i3', 21], ['i2', 10], ['i1', 4], ['i0', 0]]);
  assert.equal(r.elite?.id, 'i3', 'finished every window and made more than the live settings (21 x $150 vs 21 x $50)');
  assert.equal(r.instances.find((x) => x.id === 'i1')!.played.length, 5, 'culled at its first failed window: nothing played after it');
  assert.match(r.instances.find((x) => x.id === 'i1')!.culled!, /Tier 2 2-day/);
  assert.deepEqual(r.saved.map((x) => x.id), ['i3', 'i2'], 'saved: the instances that reached Tier 3 (passed Tiers 1 and 2)');
  assert.equal(r.baseline.length, 21, 'the live settings play every window');
});

test('Tier C fill: too few pass Tier 3, so the best that reached it enter Tier C as wildcards; an Elite must beat the live settings', async () => {
  const stages = stagesFrom();
  // a: passes everything; b and c reach Tier 3 (6 windows) and fail in it; d never gets there.
  const plan: Record<string, (i: number) => boolean> = { a: () => true, b: (i) => i < 7, c: (i) => i < 6 || i >= 9, d: (i) => i < 3 };
  const r = await runTrial({
    trial: 0, stages, instances: Object.keys(plan).map((id) => ({ id, settings: id, origin: 't' })), baseline: 'live', rules: { ...DEFAULT_RULES, minTierC: 3 },
    evaluate: async (s, st) => (s === 'live' ? { pnl: 200, minPnl: 0, trades: 1 } : plan[s](st.index) ? { pnl: 101, minPnl: 0, trades: 1 } : { pnl: 0, minPnl: 0, trades: 1 }),
  });
  const by = Object.fromEntries(r.instances.map((x) => [x.id, x]));
  assert.ok(by.b.wildcard && by.c.wildcard && !by.d.wildcard, 'b and c reached Tier 3; d did not');
  assert.equal(by.c.played.length, 19, 'a wildcard sits out the rest of Tier 3 after its miss, then plays Tier C to the end (7 + 12 windows)');
  assert.ok(by.c.wins > by.b.wins, 'c passed the Tier C+ windows: ranked above b');
  assert.equal(r.elite, undefined, 'a finished every window but made less than the live settings ($101 vs $200 a window)');
  assert.equal(r.best?.id, 'a');
});

test('no Elite: up to 3 retrials on new days, seeded with the best so far; it stops at the first Elite', async () => {
  const trialsSeen: number[] = [];
  let seededWith: string[] = [];
  const res = await runConditioning({
    stagesFor: (t) => { trialsSeen.push(t); return stagesFrom(t * 1000); },
    instancesFor: (t, prev) => { if (t === 2) seededWith = prev.slice(0, 2).map((p) => p.id); return [{ id: `t${t}-x`, settings: t, origin: t ? 'retrial' : 'first' }]; },
    baseline: -1,
    evaluate: async (s) => (s === -1 ? { pnl: 0, minPnl: 0, trades: 0 } : s === 2 ? { pnl: 500, minPnl: 0, trades: 3 } : { pnl: 10, minPnl: 0, trades: 3 }),
    rules: { minTierC: 0 },
  });
  assert.deepEqual(trialsSeen, [0, 1, 2], 'trial 2 found an Elite: no third retrial');
  assert.equal(res.elite?.id, 't2-x');
  assert.deepEqual(seededWith, ['t0-x', 't1-x'], 'retrials see the earlier instances, best first');
  const none = await runConditioning({ stagesFor: () => stagesFrom(), instancesFor: (t) => [{ id: `n${t}`, settings: 0, origin: 'x' }], baseline: 0, evaluate: async () => ({ pnl: 0, minPnl: -1, trades: 0 }) });
  assert.equal(none.trials.length, 4, 'the first trial and 3 retrials');
  assert.equal(none.elite, undefined);
  assert.ok(none.best, 'the best is kept even when nobody finishes');
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { allocateStages, conditioningStep, instancesFor, mutateSettings, paramsOf, randomSettings, rng, unseenDays, COND_PARAMS } from '../research/conditioningRun';
import { settingsFromConfig } from '../research/wholeBot';
import { loadConfig } from '../bot/config';
import { writeSyntheticRecordings } from '../research/synthetic';
import { HistoryLedger, isoWeek } from '../research/historyLedger';

const dayList = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

test('unseen days: no network trained on their week, and outside the decision model\'s fitting span', () => {
  const days = dayList('2024-01-01', 28);
  const ledger = new HistoryLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-')), 'l.json'));
  ledger.markTrained('snn-crypto', [isoWeek('2024-01-08')]);
  ledger.markJudged('conditioning', [isoWeek('2024-01-15')]);
  const u = unseenDays(days, ledger, (d) => d >= '2024-01-22');
  assert.ok(!u.some((d) => isoWeek(d) === isoWeek('2024-01-08')), 'a week a network trained on is out');
  assert.ok(u.includes('2024-01-15'), 'a week conditioning only judged on stays in (it is preferred less, not excluded)');
  assert.ok(!u.some((d) => d >= '2024-01-22'), 'the fitting span is out');
});

test('windows: Tiers 1-3 on consecutive days, Tiers C-S on days of their character, no day twice in a run', () => {
  const pool = dayList('2023-01-01', 120);
  const kinds = ['calm', 'trending', 'volatile_idio', 'volatile_systemic'] as const;
  const characters = new Map(pool.map((d, i) => [d, kinds[i % 4]]));
  const used = new Set<string>();
  const a = allocateStages({ pool, used, characters, judged: () => 0, seed: 1 })!;
  assert.equal(a.length, 21);
  const t1 = a.find((s) => s.tier === 0 && s.win === 0)!;
  assert.equal(t1.days.length, 3);
  assert.equal(Date.parse(t1.days[2]) - Date.parse(t1.days[0]), 2 * 86_400_000, 'a 3-day window of consecutive days');
  assert.ok(a.filter((s) => s.tier === 3).every((s) => s.days.every((d) => characters.get(d) === 'calm')), 'Tier C: calm days');
  assert.ok(a.filter((s) => s.tier === 6).every((s) => s.days.every((d) => characters.get(d) === 'volatile_systemic')), 'Tier S: market-wide volatile days');
  const b = allocateStages({ pool, used, characters, judged: () => 0, seed: 2 })!;
  const all = [...a, ...b].flatMap((s) => s.days);
  assert.equal(new Set(all).size, all.length, 'a retrial plays new days');
  const notes: string[] = [];
  const short = allocateStages({ pool: dayList('2022-01-01', 30), used: new Set(), characters: new Map(), judged: () => 0, seed: 3, notes })!;
  assert.ok(short.length < 21 && short.length >= 9 && notes.length > 0, 'too few days: Tiers 1-3, then a short trial, said in the notes');
  assert.equal(allocateStages({ pool: dayList('2022-01-01', 10), used: new Set(), characters: new Map(), judged: () => 0, seed: 3 }), undefined, 'not even Tiers 1-3: no trial');
});

test('instances: trial 0 has the live settings and random variants; retrials vary the best and add new ones', () => {
  const live = settingsFromConfig(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) }));
  const t0 = instancesFor(0, 8, live, [], 5);
  assert.equal(t0.length, 8);
  assert.deepEqual(paramsOf(t0[0].settings), paramsOf(live), 'the live settings are one of them');
  const r = rng(1);
  for (const p of COND_PARAMS) assert.ok(p.values.includes(p.get(randomSettings(live, r))), `${p.name} drawn from its grid`);
  const m = mutateSettings(t0[3].settings, r);
  const changed = COND_PARAMS.filter((p) => p.get(m) !== p.get(t0[3].settings)).length;
  assert.ok(changed >= 0 && changed <= 3);
  const prev = t0.map((x) => ({ ...x, played: [], passed: 0, wins: 0 }));
  const t1 = instancesFor(1, 8, live, prev, 5);
  assert.equal(t1.filter((x) => x.origin.startsWith('varied from')).length, 2, 'the best quarter varied');
  assert.ok(t1.every((x) => x.id.startsWith('t1-')));
});

test('the step end to end on a small synthetic replay: report written, weeks marked, live settings untouched without an Elite', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cond-'));
  const replay = path.join(root, 'replay'), models = path.join(root, 'models');
  for (const d of dayList('2024-03-01', 20)) writeSyntheticRecordings(replay, { windows: 2, seed: d.length + Number(d.slice(-2)), start: Date.parse(`${d}T00:00:00Z`), tickerPrefix: `SYN${d.replace(/-/g, '')}` });
  const ledger = new HistoryLedger(path.join(root, 'ledger.json'));
  const live = settingsFromConfig(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) }));
  const logs: string[] = [];
  const r = await conditioningStep({ replayDir: replay, historyDir: path.join(root, 'history'), modelsDir: models, live, ledger, fitted: () => false, instances: 3, workers: 1, seed: 7, rules: { retrials: 0 }, log: (m) => logs.push(m), now: Date.parse('2024-04-01T00:00:00Z') });
  assert.equal(r.trials, 1);
  assert.ok(r.windows > 0, 'instances played windows');
  const rep = JSON.parse(fs.readFileSync(path.join(models, 'conditioning_report.json'), 'utf8'));
  assert.equal(rep.unseenDays, 20);
  assert.ok(rep.trials[0].stages.length >= 9, 'Tiers 1-3 at least');
  assert.ok(rep.notes.length > 0, 'the short trial (20 days) is said in the notes');
  assert.ok(!fs.existsSync(path.join(models, 'conditioning_champion.json')), 'a short trial never crowns an Elite: the live settings stay');
  assert.ok(ledger.use('conditioning', isoWeek('2024-03-04')).judged > 0, 'the weeks played are marked');
  assert.ok(logs.some((l) => /trial 0, Tier 1 3-day/.test(l)));
});

import { championEnv, championPath, conditioningStatus, previousPath, readChampion, rollbackChampion } from '../bot/strategy/conditioningOverlay';

test('live overlay: only the conditioning settings, each clamped, loaded through the configuration; rollback brings back the previous champion', () => {
  const base = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), SETUP_FAST_RISK_USD: '2' });
  const k0 = base.sizingTiers[0].kellyFraction;
  const c = championEnv({ schema: 'conditioning1', version: 'cond-x', at: '', id: 'i', params: { STRATEGY_MIN_EDGE: 0.03, tierScale: 2, SETUP_FAST_RISK: 0.01, PERPS_DAILY_LOSS_FRAC: 9, RISK_MAX_DAILY_LOSS_USD: 1e6 } }, base);
  assert.deepEqual(c.skipped, ['RISK_MAX_DAILY_LOSS_USD'], 'any other name is ignored');
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), SETUP_FAST_RISK_USD: '2', ...c.env });
  assert.equal(cfg.strategy.minEdge, 0.03);
  assert.ok(Math.abs(cfg.sizingTiers[0].kellyFraction - Math.min(1, 2 * k0)) < 1e-12, 'aggression scale on the sizing tiers (valid tiers)');
  assert.equal(cfg.perps.setupFastRisk, 0.01);
  assert.equal(cfg.perps.setupFastRiskUsd, 0, 'the fixed-dollar perps risk is cleared: the fraction of equity governs');
  assert.equal(cfg.perps.dailyLossFrac, 0.5, 'clamped to the tested range');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-'));
  const champ = (v: string) => JSON.stringify({ schema: 'conditioning1', version: v, at: '', id: v, params: {} });
  fs.writeFileSync(championPath(dir), champ('new'));
  fs.writeFileSync(previousPath(dir), champ('old'));
  assert.deepEqual([conditioningStatus(dir).available, conditioningStatus(dir).previous], ['new', 'old']);
  assert.deepEqual(rollbackChampion(dir), { to: 'old' });
  assert.equal(readChampion(championPath(dir))?.version, 'old');
  assert.ok(!fs.existsSync(previousPath(dir)));
  assert.deepEqual(rollbackChampion(dir), { to: null }, 'no previous one: the configured settings return');
  assert.ok(!fs.existsSync(championPath(dir)));
  assert.equal(readChampion(path.join(dir, 'missing.json')), undefined);
});

test('every setting conditioning varies loads into a valid configuration at every value it tries', () => {
  const base = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) });
  for (const p of COND_PARAMS) for (const v of p.values) {
    const c = championEnv({ schema: 'conditioning1', version: 'v', at: '', id: 'i', params: { [p.name]: v } }, base);
    assert.deepEqual(c.skipped, [], `${p.name} is a live setting`);
    assert.doesNotThrow(() => loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), ...c.env }), `${p.name}=${v}`);
  }
});

import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { ComponentTrials, DEFAULT_TRIALS, type TrialName, type TrialState } from '../bot/strategy/componentTrials';
import { RuleBook, type RuleBookFile, type RuleRow } from '../bot/strategy/ruleBook';
import { forecastDrift, taDrift } from '../bot/strategy/taConviction';
import type { TaSnapshot } from '../bot/ta/analyzer';
import { loadConfig } from '../bot/config';

const T0 = 1_761_000_000_000;

/** Settles `n` contracts, one per asset and close time, each with five snapshots of every named trial: `pWith(i, y)` is
 *  the price with the component, the price without it a coin flip's 0.5. */
function run(t: ComponentTrials, names: TrialName[], n: number, pWith: (i: number, y: number) => number, from = 0): void {
  let seed = 17 + from;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = from; i < from + n; i++) {
    const y = rnd() < 0.5 ? 1 : 0;
    const ticker = `KXBTC15M-${i}`, close = T0 + i * 900_000;
    for (let k = 0; k < 5; k++) for (const name of names) t.record(name, ticker, 'BTC', close, pWith(i, y), 0.5, close - 600_000);
    t.onResult(ticker, y ? 'yes' : 'no', close + 1000);
  }
}

test('trials: a contribution that prices better turns on in paper after enough settlements; a worse one turns off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trials-'));
  const file = path.join(dir, 'component_trials.json');
  const changes: Array<[TrialName, TrialState, string]> = [];
  const t = new ComponentTrials({ ...DEFAULT_TRIALS, minWindows: 100 }, file, (n, to, why) => changes.push([n, to, why]), T0);
  // snn knows the outcome a little (0.6 on the right side); ta leans the wrong way (0.4 on the right side); rules is noise.
  let seed = 5;
  const noise = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  run(t, ['snn'], 99, (_i, y) => (y ? 0.6 : 0.4));
  run(t, ['ta'], 99, (_i, y) => (y ? 0.4 : 0.6));
  run(t, ['rules'], 99, () => 0.5 + 0.04 * noise());
  assert.equal(changes.length, 0, 'nothing changes before 100 settlements');
  assert.deepEqual(['snn', 'ta', 'rules'].map((n) => t.status()[n as TrialName].state), ['testing', 'testing', 'testing']);
  assert.equal(t.on('snn'), false);
  run(t, ['snn', 'ta'], 5, (_i, y) => (y ? 0.6 : 0.4), 1000);
  const s = t.status();
  assert.equal(s.snn.state, 'on', JSON.stringify(s.snn));
  assert.ok(s.snn.advantage! > 0 && s.snn.pBetter! <= 0.05 && s.snn.windows >= 100);
  assert.equal(t.on('snn'), true);
  assert.match(changes.find(([n]) => n === 'snn')![2], /^better with it over \d+ settlements \(saves 0\.\d{4} of log loss a contract, p 0\.\d{3}\)$/);
  // ta: 99 worse settlements, then 5 better ones: still significantly worse -> off.
  assert.equal(s.ta.state, 'off', JSON.stringify(s.ta));
  assert.equal(t.on('ta'), false);
  // rules: noise never reaches significance either way.
  run(t, ['rules'], 50, () => 0.5 + 0.04 * noise(), 2000);
  assert.equal(t.status().rules.state, 'testing');
  // The scorecards and states survive a restart.
  const again = new ComponentTrials({ ...DEFAULT_TRIALS, minWindows: 100 }, file);
  assert.equal(again.status().snn.state, 'on');
  assert.equal(again.status().ta.state, 'off');
  assert.equal(again.status().snn.windows, s.snn.windows);
  // Off by configuration: nothing is on.
  assert.equal(new ComponentTrials({ ...DEFAULT_TRIALS, enabled: false }, file).on('snn'), false);
});

test('trials: a component that was on goes off once it is significantly worse; contracts closing together are one settlement', () => {
  const t = new ComponentTrials({ ...DEFAULT_TRIALS, minWindows: 40, keep: 120 }, undefined, undefined, T0);
  run(t, ['snn'], 60, (_i, y) => (y ? 0.65 : 0.35));
  assert.equal(t.status().snn.state, 'on');
  // The SNN turns wrong: the oldest good settlements roll out of the 120 kept and it goes off.
  run(t, ['snn'], 150, (_i, y) => (y ? 0.35 : 0.65), 100);
  assert.equal(t.status().snn.state, 'off', JSON.stringify(t.status().snn));
  // Two strikes of one asset closing together count once; another asset at the same close is its own settlement.
  const u = new ComponentTrials(DEFAULT_TRIALS, undefined, undefined, T0);
  for (const [ticker, asset] of [['KXBTCD-1-T1', 'BTC'], ['KXBTCD-1-T2', 'BTC'], ['KXETHD-1-T1', 'ETH']]) {
    u.record('ta', ticker, asset, T0, 0.6, 0.5);
    u.onResult(ticker, 'yes');
  }
  assert.equal(u.status().ta.windows, 2);
  assert.equal(u.status().ta.pending, 0);
});

const row = (o: Partial<RuleRow>): RuleRow => ({ id: 'ema_stack', kind: 'rule', tf: '1h', h: 4, cls: 'all', n: 400, hit: 0.53, payoff: 1, expBps: 4, p: 0.2, fdr: false, nConf: 100, hitConf: 0.54, expConfBps: 3, pass: false, weight: 0, ...o });
const snap = (signals: Array<{ id: string; tf: string; dir: -1 | 0 | 1; strength: number }>): TaSnapshot =>
  ({ asset: 'ETH', ts: 0, tf: {}, signals: signals.map((s) => ({ ...s, indicator: '', meaning: '' })), book: [], confluences: [], net: 0 }) as unknown as TaSnapshot;

test('rule book trial: rows positive on both periods count without passing; hit rates make an implied P(up)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbt-'));
  const file = path.join(dir, 'rule_book.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'rulebook1', generatedAt: '', assets: [], from: '2020-01-01', to: '2026-01-01', splitAt: '2024-01-01', stride: 6, costBps: 10, horizons: [1, 4, 24], character: { n: 1, accuracy: 0.5, baseline: 0.5, confusion: {}, share: {} },
    rows: [row({}), row({ id: 'rsi_extreme', hitConf: 0.52, nConf: 300 }), row({ id: 'macd_cross', expConfBps: -2 }), row({ id: 'obv_trend', nConf: 10 }), row({ id: 'rsi_extreme', cls: 'calm', hitConf: 0.56, nConf: 100 })] } as RuleBookFile));
  const rb = new RuleBook(() => file);
  assert.equal(rb.read(snap([{ id: 'ema_stack', tf: '1h', dir: 1, strength: 1 }]), 4), undefined, 'nothing passed: the rule book itself stays silent');
  assert.deepEqual(rb.trialRows().map((r) => `${r.id}/${r.cls}`).sort(), ['ema_stack/all', 'rsi_extreme/all', 'rsi_extreme/calm'], 'negative confirmation and thin confirmation are left out');
  const s = snap([{ id: 'ema_stack', tf: '1h', dir: 1, strength: 1 }, { id: 'rsi_extreme', tf: '1h', dir: -1, strength: 0.5 }, { id: 'macd_cross', tf: '1h', dir: -1, strength: 1 }]);
  const all = rb.trialRead(s, 1)!;
  // (100 x 0.04 - 300 x 0.5 x 0.02) / 400 = 0.0025 over 0.5; horizon 1 h is not in the rows: the nearest (4 h) is read.
  assert.ok(Math.abs(all.pUp - 0.5025) < 1e-9, String(all.pUp));
  assert.deepEqual([all.h, all.n, all.agree, all.oppose], [4, 2, ['ema_stack@1h'], ['rsi_extreme@1h']]);
  const calm = rb.trialRead(s, 4, 'calm')!;
  assert.ok(Math.abs(calm.pUp - (0.5 + (100 * 0.04 - 100 * 0.5 * 0.06) / 200)) < 1e-9, 'the calm row replaces the all row');
  assert.equal(rb.trialRead(snap([{ id: 'adx_trend', tf: '1h', dir: 1, strength: 1 }]), 4), undefined, 'no trial row present');
  // As a drift: P(up over 4 h) 0.5025 over a 15-minute contract's last 10 minutes.
  const k = forecastDrift(all.pUp, 4 * 3600, 600, 0.5);
  assert.ok(k > 0 && k < 0.01, String(k));
});

test('TA trial: every head at full weight, validated or not', () => {
  const v = { up1: 0.56, up4: 0.53, skill1: 0, graded1: 50, validated1: false, skill4: undefined, graded4: 3, validated4: false };
  // Today: the 1-hour head, graded with no skill, says nothing; the 4-hour head, not graded yet, counts half.
  assert.deepEqual(taDrift(v, 900, { maxZ: 0.5, live: false })!.parts, ['4h P(up) 0.530 x0.50']);
  const full = taDrift(v, 900, { maxZ: 0.5, live: false, full: true })!;
  assert.deepEqual(full.parts, ['1h P(up) 0.560 x1.00', '4h P(up) 0.530 x1.00']);
  assert.ok(full.k > taDrift(v, 900, { maxZ: 0.5, live: false })!.k, JSON.stringify(full));
});

test('trials: on by default with a 100-settlement, p 0.05 test and the SNN at 0.25; the knobs are read', () => {
  const d = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40) }).trials;
  assert.deepEqual(d, { enabled: true, minWindows: 100, p: 0.05, keep: 500, snnAlpha: 0.25 });
  const c = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), TRIALS: 'false', TRIAL_MIN_WINDOWS: '200', TRIAL_P: '0.01', TRIAL_SNN_ALPHA: '0.1' }).trials;
  assert.deepEqual([c.enabled, c.minWindows, c.p, c.snnAlpha], [false, 200, 0.01, 0.1]);
});

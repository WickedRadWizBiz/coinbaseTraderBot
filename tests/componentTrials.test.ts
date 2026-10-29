import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { ComponentTrials, DEFAULT_TRIALS, TRIAL_LABEL, TRIAL_NAMES, type TrialName, type TrialState } from '../bot/strategy/componentTrials';
import { RuleBook, type RuleBookFile, type RuleRow } from '../bot/strategy/ruleBook';
import { taDrift } from '../bot/strategy/taConviction';
import { normInv } from '../bot/util/num';
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
  assert.deepEqual(['mlp', 'snn', 'ta', 'rules'].map((n) => t.status()[n as TrialName].state), ['testing', 'testing', 'testing', 'testing']);
  assert.equal(t.applied('snn'), false);
  run(t, ['snn', 'ta'], 5, (_i, y) => (y ? 0.6 : 0.4), 1000);
  const s = t.status();
  assert.equal(s.snn.state, 'on', JSON.stringify(s.snn));
  assert.ok(s.snn.advantage! > 0 && s.snn.pBetter! <= 0.05 && s.snn.windows >= 100);
  assert.equal(t.applied('snn'), true);
  assert.match(changes.find(([n]) => n === 'snn')![2], /^better with it over \d+ settlements \(saves 0\.\d{4} of log loss a contract, p 0\.\d{3}\)$/);
  // ta: 99 worse settlements, then 5 better ones: still significantly worse -> off.
  assert.equal(s.ta.state, 'off', JSON.stringify(s.ta));
  assert.equal(t.applied('ta'), false);
  // rules: noise never reaches significance either way.
  run(t, ['rules'], 50, () => 0.5 + 0.04 * noise(), 2000);
  assert.equal(t.status().rules.state, 'testing');
  // The scorecards and states survive a restart.
  const again = new ComponentTrials({ ...DEFAULT_TRIALS, minWindows: 100 }, file);
  assert.equal(again.status().snn.state, 'on');
  assert.equal(again.status().ta.state, 'off');
  assert.equal(again.status().snn.windows, s.snn.windows);
  // Off by configuration: nothing is on.
  const disabled = new ComponentTrials({ ...DEFAULT_TRIALS, enabled: false }, file);
  assert.deepEqual(['mlp', 'snn', 'ta', 'rules'].map((n) => disabled.applied(n as TrialName)), [true, false, false, false], 'trials off: paper prices as before');
});

test('trials: the trained model keeps pricing paper while tested and comes out only when worse; the rule book trades in paper from the start', () => {
  const t = new ComponentTrials({ ...DEFAULT_TRIALS, minWindows: 40 }, undefined, undefined, T0);
  assert.deepEqual(['mlp', 'snn', 'ta', 'rules'].map((n) => [t.status()[n as TrialName].state, t.applied(n as TrialName)]),
    [['testing', true], ['testing', false], ['testing', false], ['testing', true]]);
  // The trained model prices worse than the math alone: it comes out of paper's price.
  run(t, ['mlp'], 60, (_i, y) => (y ? 0.38 : 0.62));
  assert.deepEqual([t.status().mlp.state, t.applied('mlp')], ['off', false]);
  // The rule book prices worse too: trading in paper does not keep it in.
  run(t, ['rules'], 60, (_i, y) => (y ? 0.4 : 0.6), 500);
  assert.deepEqual([t.status().rules.state, t.applied('rules')], ['off', false]);
  // TRIAL_PAPER_START empty: the rule book waits for its test like the others.
  assert.equal(new ComponentTrials({ ...DEFAULT_TRIALS, paperStart: [] }).applied('rules'), false);
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

test('rule book trial: rows positive on both periods count without passing; every horizon\'s hit rate makes a drift', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbt-'));
  const file = path.join(dir, 'rule_book.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'rulebook1', generatedAt: '', assets: [], from: '2020-01-01', to: '2026-01-01', splitAt: '2024-01-01', stride: 6, costBps: 10, horizons: [1, 4, 24], character: { n: 1, accuracy: 0.5, baseline: 0.5, confusion: {}, share: {} },
    rows: [row({}), row({ id: 'ema_stack', h: 24, hitConf: 0.55, nConf: 200 }), row({ id: 'rsi_extreme', hitConf: 0.52, nConf: 300 }), row({ id: 'macd_cross', expConfBps: -2 }), row({ id: 'obv_trend', nConf: 10 }),
      row({ id: 'rsi_extreme', cls: 'calm', hitConf: 0.56, nConf: 100 })] } as RuleBookFile));
  const rb = new RuleBook(() => file);
  assert.equal(rb.read(snap([{ id: 'ema_stack', tf: '1h', dir: 1, strength: 1 }]), 4), undefined, 'nothing passed: the rule book itself stays silent');
  assert.deepEqual(rb.trialRows().map((r) => `${r.id}/${r.h}/${r.cls}`).sort(), ['ema_stack/24/all', 'ema_stack/4/all', 'rsi_extreme/4/all', 'rsi_extreme/4/calm'], 'negative confirmation and thin confirmation are left out');
  const s = snap([{ id: 'ema_stack', tf: '1h', dir: 1, strength: 1 }, { id: 'rsi_extreme', tf: '1h', dir: -1, strength: 0.5 }, { id: 'macd_cross', tf: '1h', dir: -1, strength: 1 }]);
  // A 15-minute contract's last 10 minutes: each row a P(move its way over its horizon), z sqrt(tau / H) its way.
  const r4 = Math.sqrt(600 / (4 * 3600)), r24 = Math.sqrt(600 / (24 * 3600));
  const all = rb.trialRead(s, 600, undefined, 0.5)!;
  const want = (100 * normInv(0.54) * r4 + 200 * normInv(0.55) * r24 - 300 * 0.5 * normInv(0.52) * r4) / 600;
  assert.ok(Math.abs(all.k - want) < 1e-12 && all.k > 0, `${all.k} vs ${want}`);
  assert.deepEqual([all.rows, all.agree, all.oppose], [3, ['ema_stack@1h'], ['rsi_extreme@1h']]);
  const calm = rb.trialRead(s, 600, 'calm', 0.5)!;
  assert.ok(Math.abs(calm.k - (100 * normInv(0.54) * r4 + 200 * normInv(0.55) * r24 - 100 * 0.5 * normInv(0.56) * r4) / 400) < 1e-12, 'the calm row replaces the all row');
  assert.equal(rb.trialRead(snap([{ id: 'adx_trend', tf: '1h', dir: 1, strength: 1 }]), 600, undefined, 0.5), undefined, 'no trial row present');
});

test('TA trial: every head at full weight, validated or not', () => {
  const v = { up1: 0.56, up4: 0.53, skill1: 0, graded1: 50, validated1: false, skill4: undefined, graded4: 3, validated4: false };
  // Outside its trial neither unvalidated head moves the price.
  assert.equal(taDrift(v, 900, { maxZ: 0.5, live: false }), undefined);
  const full = taDrift(v, 900, { maxZ: 0.5, live: false, full: true })!;
  assert.deepEqual(full.parts, ['1h P(up) 0.560 x1.00', '4h P(up) 0.530 x1.00']);
  assert.ok(full.k > 0, JSON.stringify(full));
});

test('trials: on by default with a 100-settlement, p 0.05 test, the SNN at 0.25 and the rule book trading in paper; the knobs are read', () => {
  const d = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40) }).trials;
  assert.deepEqual(d, { enabled: true, minWindows: 100, p: 0.05, keep: 500, snnAlpha: 0.25, paperStart: ['rules'] });
  const c = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), TRIALS: 'false', TRIAL_MIN_WINDOWS: '200', TRIAL_P: '0.01', TRIAL_SNN_ALPHA: '0.1', TRIAL_KEEP: '150', TRIAL_PAPER_START: 'snn, ta,bogus' }).trials;
  assert.deepEqual([c.enabled, c.minWindows, c.p, c.snnAlpha, c.keep, c.paperStart], [false, 200, 0.01, 0.1, 200, ['snn', 'ta']], 'never fewer kept than the test needs; unknown names dropped');
  assert.deepEqual(loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), TRIAL_PAPER_START: '' }).trials.paperStart, []);
  // Alerts name each trial (an Oct 24 alert called the trained model 'the rule book').
  assert.deepEqual(TRIAL_NAMES.map((n) => TRIAL_LABEL[n]), ['trained model', 'SNN', 'TA network', 'rule book']);
});

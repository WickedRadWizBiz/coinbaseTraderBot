import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { DEFAULT_SCOREBOARD, dayBlockCi, SCOREBOARD_PRICES, Scoreboard } from '../bot/health/scoreboard';
import { buildLedger } from '../bot/health/moduleLedger';
import { loadConfig } from '../bot/config';

const T0 = Date.UTC(2026, 9, 20, 0, 0);
const DAY = 86_400_000;

/** Settles `n` contracts (one per quarter hour, so about 96 a day) with `snaps` snapshots each. The outcome is drawn from
 *  the true probability `pt`; `market` is a noisy read of it (about +/- 0.1), and each named price is given by `prices(pt, market, y)`. */
function run(sb: Scoreboard, n: number, prices: (pt: number, market: number, rnd: () => number) => Partial<Record<'fair_value' | 'meta_model' | 'bot_price' | 'snn' | 'ta_tilt', number>>, o: { snaps?: number; from?: number; seed?: number } = {}): void {
  let seed = o.seed ?? 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const from = o.from ?? 0;
  for (let i = from; i < from + n; i++) {
    const pt = 0.2 + 0.6 * rnd();
    const y = rnd() < pt ? 1 : 0;
    const market = Math.min(0.95, Math.max(0.05, pt + 0.4 * (rnd() - 0.5)));
    const close = T0 + i * 900_000;
    const ticker = `KXBTC15M-${i}`;
    for (let k = 0; k < (o.snaps ?? 3); k++) {
      const p = prices(pt, market, rnd);
      sb.record(ticker, 'BTC', close, { market, fair_value: p.fair_value ?? market, meta_model: p.meta_model ?? market, bot_price: p.bot_price ?? market, snn: p.snn, ta_tilt: p.ta_tilt }, close - 600_000);
    }
    sb.onResult(ticker, y ? 'yes' : 'no');
  }
}

const row = (sb: Scoreboard, price: typeof SCOREBOARD_PRICES[number]) => sb.status().rows.find((r) => r.price === price)!;

test('scoreboard: a price that knows the truth beats the market, a noisy one loses, and the market itself is level', () => {
  const sb = new Scoreboard({ ...DEFAULT_SCOREBOARD, bootstrap: 200 });
  // 5 days of contracts: the meta-model reads the true probability, the fair value is the market plus noise, the bot's
  // price is the market.
  run(sb, 480, (pt, market, rnd) => ({ meta_model: pt, fair_value: Math.min(0.99, Math.max(0.01, market + 0.3 * (rnd() - 0.5))), bot_price: market }));
  const st = sb.status();
  assert.equal(st.windows, 480);
  assert.equal(st.days, 5);
  assert.equal(st.pending, 0);
  const meta = row(sb, 'meta_model'), fv = row(sb, 'fair_value'), bot = row(sb, 'bot_price');
  assert.equal(meta.vsMarket.verdict, 'better');
  assert.ok(meta.vsMarket.saved! > 0 && meta.vsMarket.ci![0] > 0, JSON.stringify(meta.vsMarket));
  assert.ok(meta.vsMarket.pBetter! < 0.05);
  assert.ok(meta.vsMarket.brierSaved! > 0);
  assert.equal(fv.vsMarket.verdict, 'worse');
  assert.ok(fv.vsMarket.pWorse! < 0.05);
  // The bot's price equals the market: no difference, undecided, and its CI straddles 0.
  assert.equal(bot.vsMarket.saved, 0);
  assert.equal(bot.vsMarket.verdict, 'undecided');
  // The meta-model is compared with the fair value it refines too, and wins; the bot's price vs the meta-model loses.
  assert.equal(meta.vsRefined!.baseline, 'fair_value');
  assert.equal(meta.vsRefined!.verdict, 'better');
  assert.equal(bot.vsRefined!.baseline, 'meta_model');
  assert.equal(bot.vsRefined!.verdict, 'worse');
  // No SNN or TA price was recorded: too few, no score.
  assert.equal(row(sb, 'snn').vsMarket.verdict, 'too few');
  assert.equal(row(sb, 'ta_tilt').vsMarket.windows, 0);
  // Per-day history: one entry a day, windows add up, and the meta-model's saving is positive on every day.
  assert.equal(st.byDay.length, 5);
  assert.equal(st.byDay.reduce((a, d) => a + d.windows, 0), 480);
  assert.ok(st.byDay.every((d) => (d.meta_model ?? 0) > 0));
  assert.equal(st.from, '2026-10-20');
});

test('scoreboard: the SNN blend is derived from the SNN and the meta-model at the configured alpha', () => {
  const sb = new Scoreboard({ ...DEFAULT_SCOREBOARD, snnAlpha: 0.5, bootstrap: 100 });
  // The SNN knows the truth; the meta-model is the market. The blend at 0.5 sits between them.
  run(sb, 480, (pt, market) => ({ meta_model: market, snn: pt }));
  const snn = row(sb, 'snn'), blend = row(sb, 'snn_blend');
  assert.equal(snn.vsMarket.verdict, 'better');
  assert.equal(blend.label, 'SNN blended at 0.5');
  assert.ok(blend.vsMarket.saved! > 0 && blend.vsMarket.saved! < snn.vsMarket.saved!, `${blend.vsMarket.saved} < ${snn.vsMarket.saved}`);
  assert.equal(snn.vsRefined!.baseline, 'meta_model');
  assert.equal(snn.vsRefined!.verdict, 'better');
});

test('scoreboard: contracts closing together are one window, snapshots average, and missing prices are skipped', () => {
  const sb = new Scoreboard({ ...DEFAULT_SCOREBOARD, bootstrap: 50 });
  const close = T0;
  // Two contracts of the same settlement, two snapshots each; the second contract has no SNN reading.
  sb.record('A', 'BTC', close, { market: 0.5, fair_value: 0.6, meta_model: 0.7, bot_price: 0.7, snn: 0.9 }, close - 1000);
  sb.record('A', 'BTC', close, { market: 0.5, fair_value: 0.6, meta_model: 0.9, bot_price: 0.7, snn: 0.9 }, close - 500);
  sb.record('B', 'BTC', close, { market: 0.5, fair_value: 0.6, meta_model: 0.8, bot_price: 0.7 }, close - 1000);
  // An unknown ticker and a bad snapshot change nothing.
  sb.onResult('Z', 'yes');
  sb.record('C', 'ETH', close, { market: NaN, fair_value: 0.6, meta_model: 0.8, bot_price: 0.7 }, close - 1000);
  assert.equal(sb.status().pending, 2);
  sb.onResult('A', 'yes');
  sb.onResult('B', 'yes');
  const st = sb.status();
  assert.equal(st.windows, 1);
  assert.equal(st.pending, 0);
  // Too few windows for a verdict, but the window counts are right: the SNN was scored on the one window (contract A).
  assert.equal(row(sb, 'meta_model').vsMarket.windows, 1);
  assert.equal(row(sb, 'snn').vsMarket.windows, 1);
  assert.equal(row(sb, 'meta_model').vsMarket.verdict, 'too few');
});

test('scoreboard: the kept windows survive a restart, the oldest drop off, and the bootstrap is deterministic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoreboard-'));
  const file = path.join(dir, 'scoreboard.json');
  const a = new Scoreboard({ ...DEFAULT_SCOREBOARD, keep: 150, bootstrap: 100 }, file);
  run(a, 200, (pt, market) => ({ meta_model: pt }));
  const s1 = a.status();
  assert.equal(s1.windows, 150);
  assert.equal(s1.from, new Date(T0 + 50 * 900_000).toISOString().slice(0, 10));
  const b = new Scoreboard({ ...DEFAULT_SCOREBOARD, keep: 150, bootstrap: 100 }, file);
  const s2 = b.status();
  assert.deepEqual(s2.rows, s1.rows);
  assert.deepEqual(s2.byDay, s1.byDay);
  // The CI depends only on the data.
  const d = Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.01 : -0.03));
  const days = d.map((_, i) => `2026-10-${String(1 + Math.floor(i / 10)).padStart(2, '0')}`);
  assert.deepEqual(dayBlockCi(d, days, 300), dayBlockCi(d, days, 300));
  assert.equal(dayBlockCi(d.slice(0, 5), days.slice(0, 5), 300), null, 'too few windows');
  assert.equal(dayBlockCi(d, days.map(() => '2026-10-01'), 300), null, 'one day is no block');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scoreboard: off, it records nothing', () => {
  const sb = new Scoreboard({ ...DEFAULT_SCOREBOARD, enabled: false });
  run(sb, 20, (pt) => ({ meta_model: pt }));
  assert.equal(sb.status().windows, 0);
  assert.equal(sb.status().pending, 0);
});

test('ledger: one shadow row per scored price, validated when it beats the market, flagged when worse', () => {
  const sb = new Scoreboard({ ...DEFAULT_SCOREBOARD, bootstrap: 100 });
  run(sb, 300, (pt, market, rnd) => ({ meta_model: pt, fair_value: Math.min(0.99, Math.max(0.01, market + 0.3 * (rnd() - 0.5))), bot_price: market }));
  const rows = buildLedger({
    mode: 'paper', model: { id: 'mlp-1', liveBlockers: [] }, scoreboard: sb.status(), snn: { mode: 'shadow', alpha: 0 }, taNet: null, ruleBook: null,
    characterStandAside: false, sessionRisk: { keys: 0 }, sizing: { paperOrderUsd: 0, tier: 'normal', sizeScale: 1, optimalF: null, portfolioKelly: false }, exitPolicy: 'hold', indexAgeMs: {}, maxIndexAgeMs: 5000,
  });
  const find = (label: string) => rows.find((r) => r.module === `scoreboard: ${label}`)!;
  const meta = find('meta-model'), fv = find('math fair value'), snn = find('SNN alone');
  assert.equal(meta.state, 'shadow');
  assert.equal(meta.validated, true);
  assert.ok(meta.score!.value! > 0 && meta.score!.n === 300);
  assert.ok(meta.flags.some((f) => f.startsWith('vs fair value: better')));
  assert.equal(fv.validated, false);
  assert.ok(fv.flags.includes('worse than the market (95% CI)'));
  assert.equal(snn.state, 'off');
  assert.equal(snn.validated, null);
  // Six prices, six rows, all in pricing.
  assert.equal(rows.filter((r) => r.module.startsWith('scoreboard:')).length, SCOREBOARD_PRICES.length);
  assert.ok(rows.filter((r) => r.module.startsWith('scoreboard:')).every((r) => r.area === 'pricing'));
});

test('config: SCOREBOARD settings, on by default, the SNN weight shared with its trial', () => {
  const base = { DASHBOARD_TOKEN: 'x'.repeat(40) } as Record<string, string>;
  const a = loadConfig({ ...base });
  assert.equal(a.scoreboard.enabled, true);
  assert.equal(a.scoreboard.keep, DEFAULT_SCOREBOARD.keep);
  assert.equal(a.scoreboard.snnAlpha, 0.25);
  const b = loadConfig({ ...base, SCOREBOARD: 'false', SCOREBOARD_KEEP: '500', TRIAL_SNN_ALPHA: '0.4', SCOREBOARD_BOOTSTRAP: '99' });
  assert.equal(b.scoreboard.enabled, false);
  assert.equal(b.scoreboard.keep, 500);
  assert.equal(b.scoreboard.snnAlpha, 0.4);
  assert.equal(b.scoreboard.bootstrap, 99);
});

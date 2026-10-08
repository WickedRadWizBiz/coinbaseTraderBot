// Genetic programming of trading formulas: the formula language and its evaluation (bot/gp/expr.ts), the
// evolution, champion and promotion (research/gpIndicators.ts), and the live reader (bot/gp/gpSignals.ts).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { assetsOf, buildInputs, depthOf, desiredExposure, evaluate, formulaText, heldExposure, isValid, lookbackOf, type Bar, type Token } from '../bot/gp/expr';
import { GpSignals } from '../bot/gp/gpSignals';
import { orientedSignals } from '../bot/strategy/taConviction';
import { upsertSeries } from '../bot/marketdata/historyStore';
import { backtest, crossover, evolveChampion, exposureOf, gpData, mergeChampions, mutate, randomTree, runGp, type GpChampion, type GpFile } from '../research/gpIndicators';
import { rng } from '../research/stats';
import { loadConfig } from '../bot/config';
import { runPipeline } from '../research/pipeline';
import { tmpDir } from './helpers';

const H = 3_600_000;

/** Hourly bars for BTC and ETH from 2019; `lead` = how much of ETH's last hourly return BTC repeats. */
function market(n: number, lead: number, seed = 7): Record<string, Bar[]> {
  const r = rng(seed);
  const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += r(); return (s - 3) * Math.SQRT2; };
  const out: Record<string, Bar[]> = { BTC: [], ETH: [] };
  let pb = 10_000, pe = 300, prevE = 0;
  for (let i = 0; i < n; i++) {
    const re = 0.008 * gauss(), rb = lead * prevE + 0.007 * gauss();
    prevE = re;
    const ob = pb, oe = pe;
    pb *= Math.exp(rb); pe *= Math.exp(re);
    const ts = Date.UTC(2019, 0, 1) + i * H;
    out.BTC.push({ ts, o: ob, c: pb, h: Math.max(ob, pb) * (1 + 0.003 * r()), l: Math.min(ob, pb) * (1 - 0.003 * r()), v: 100 + 50 * r() });
    out.ETH.push({ ts, o: oe, c: pe, h: Math.max(oe, pe) * (1 + 0.003 * r()), l: Math.min(oe, pe) * (1 - 0.003 * r()), v: 1000 + 500 * r() });
  }
  return out;
}

test('formula language: prefix trees read, printed, measured and checked', () => {
  const t: Token[] = ['add', 'BTC.c', 'mul', '0.5', 'mean24', 'ETH.v'];
  assert.ok(isValid(t));
  assert.equal(formulaText(t), 'BTC.c + (0.5 * mean24(ETH.v))');
  assert.equal(depthOf(t), 3);
  assert.equal(lookbackOf(t), 23 + 23, 'the volume ratio needs 24 bars, then the 24-bar mean of it');
  assert.deepEqual(assetsOf(t), ['BTC', 'ETH']);
  assert.equal(formulaText(['gt', 'BTC.c', 'ETH.c']), 'gt(BTC.c, ETH.c)');
  assert.equal(lookbackOf(['delta4', 'lag2', 'BTC.c']), 4 + 2 + 1);
  for (const bad of [['add', 'BTC.c'], ['BTC.c', 'ETH.c'], ['foo'], ['mean24'], []]) assert.equal(isValid(bad), false, JSON.stringify(bad));
});

test('evaluation: window functions match a direct computation, protected division, not-a-number in the window', () => {
  const r = rng(3);
  const n = 400;
  const x = Array.from({ length: n }, (_, i) => (i === 50 || i === 51 ? NaN : (r() - 0.5) * 0.02));
  const ts = Array.from({ length: n }, (_, i) => i * H);
  // A one-coin "market" whose return column is x (closes built from it).
  let c = 100;
  const bars: Bar[] = ts.map((t, i) => { if (i > 0) c *= Math.exp(Number.isNaN(x[i]) ? 0 : x[i]); return { ts: t, o: c, h: c, l: c, c, v: 1 }; });
  const inp = buildInputs('AAA', { AAA: bars });
  const col = inp.cols.get('AAA.c')!;
  for (let i = 0; i < n; i++) col[i] = x[i]; // feed x directly (with its gaps)
  const direct = (op: string, w: number, i: number) => {
    if (op === 'lag') return i >= w ? x[i - w] : NaN;
    if (op === 'delta') return i >= w ? x[i] - x[i - w] : NaN;
    if (i < w - 1) return NaN;
    const win = x.slice(i - w + 1, i + 1);
    if (win.some(Number.isNaN)) return NaN;
    const m = win.reduce((a, b) => a + b, 0) / w;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / (w - 1));
    return { mean: m, sum: m * w, std: sd, max: Math.max(...win), min: Math.min(...win), z: sd > 1e-12 ? (x[i] - m) / sd : 0 }[op]!;
  };
  for (const [op, w] of [['lag', 2], ['delta', 4], ['mean', 6], ['sum', 12], ['std', 24], ['max', 6], ['min', 12], ['z', 24]] as const) {
    const got = evaluate([`${op}${w}`, 'AAA.c'], inp);
    for (let i = 0; i < n; i++) {
      const want = direct(op, w, i);
      if (Number.isNaN(want)) assert.ok(Number.isNaN(got[i]), `${op}${w} at ${i}: not-a-number expected, got ${got[i]}`);
      else assert.ok(Math.abs(got[i] - want) < 1e-9 * (1 + Math.abs(want)), `${op}${w} at ${i}: ${got[i]} vs ${want}`);
    }
  }
  const div = evaluate(['div', '0.5', 'sub', 'AAA.o', 'AAA.o'], inp);
  assert.equal(div[10], 0.5, 'dividing by ~0 gives the numerator');
  const exp = desiredExposure(evaluate(['mul', '1000', 'AAA.c'], inp));
  assert.ok(exp.every((v) => v >= -1 && v <= 1) && exp[50] === 0, 'clipped to -1..1; not-a-number holds no exposure');
});

test('a formula reads only its lookback: the live bot\'s last 320 bars give what the whole history gave', () => {
  const bars = market(3000, 0.1);
  const r = rng(11);
  const full = buildInputs('BTC', bars);
  let checked = 0;
  for (let k = 0; k < 120; k++) {
    const t = randomTree(r, ['BTC', 'ETH'], 1, 5, k % 2 === 0);
    if (lookbackOf(t) > 240) continue;
    const a = desiredExposure(evaluate(t, full));
    const tail = buildInputs('BTC', { BTC: bars.BTC.slice(-320), ETH: bars.ETH.slice(-320) });
    const b = desiredExposure(evaluate(t, tail));
    assert.ok(Math.abs(a[a.length - 1] - b[b.length - 1]) < 1e-6, `${formulaText(t)}: ${a[a.length - 1]} vs ${b[b.length - 1]}`);
    checked++;
  }
  assert.ok(checked > 80);
});

test('dead band: the position held moves only when the formula asks for more than 10 % more or less', () => {
  const held = heldExposure(new Float64Array([0, 0.05, 0.2, 0.25, 0.1, -0.5, -0.45, 1]), 0.1);
  assert.deepEqual([...held], [0, 0, 0.2, 0.2, 0.2, -0.5, -0.5, 1]);
});

test('backtest: exposure held from the bar before earns the coin\'s return less the cost of what it traded', () => {
  const d = gpData('BTC', market(2000, 0));
  const ones = new Float64Array(d.inp.n).fill(1);
  const s = backtest(ones, d, 1, 1001, 10);
  let hold = 0;
  for (let t = 1; t < 1001; t++) hold += d.ret[t];
  assert.equal(s.trades, 1, 'bought once, at the first bar');
  assert.ok(Math.abs((1 + s.totalReturn) - Math.exp(hold) * (1 - 0.001) / 1) < 2e-3, `${s.totalReturn} vs buy-and-hold ${Math.exp(hold) - 1}`);
  const flat = backtest(new Float64Array(d.inp.n), d, 1, 1001, 10);
  assert.equal(flat.totalReturn, 0); assert.equal(flat.trades, 0);
  // Flipping every bar pays two units of exposure each time.
  const flip = new Float64Array(d.inp.n).map((_, i) => (i % 2 ? 1 : -1));
  assert.ok(backtest(flip, d, 2, 1002, 10).turnover > 1000 * 2 * 0.9 * (8760 / 1000));
});

test('variation: crossover and mutation keep every formula well formed', () => {
  const r = rng(5);
  let swapped = 0;
  for (let k = 0; k < 400; k++) {
    const a = randomTree(r, ['BTC', 'ETH'], 1, 4, false), b = randomTree(r, ['BTC', 'ETH'], 1, 4, true);
    const [c1, c2] = crossover(a, b, r);
    assert.ok(isValid(c1) && isValid(c2), `${a.join(' ')} x ${b.join(' ')}`);
    assert.equal(c1.length + c2.length, a.length + b.length, 'branches swapped, nothing lost');
    if (c1.join() !== a.join()) swapped++;
    const m = mutate(a, r, ['BTC', 'ETH']);
    assert.ok(isValid(m), m.join(' '));
  }
  assert.ok(swapped > 200);
});

test('evolution: finds a planted cross-market lead and validates it on the unseen test years; noise never validates', async () => {
  const planted = await evolveChampion(gpData('BTC', market(12_000, 0.25)), { population: 150, generations: 5, seed: 3 });
  assert.ok(planted.validated, planted.why);
  assert.ok(planted.inputs.includes('ETH'), `the formula reads ETH: ${planted.formula}`);
  assert.ok(planted.test.sharpe > 2 && planted.test.totalReturn > planted.buyHoldTest, JSON.stringify(planted.test));
  assert.ok(planted.history.length === 6 && planted.history[5].best >= planted.history[0].best, 'best score never falls (the best 10% survive)');
  assert.ok(planted.test.from > planted.val.to && planted.val.from > planted.train.to, 'train, validation, test: oldest to newest');
  for (const seed of [1, 2]) {
    const noise = await evolveChampion(gpData('BTC', market(12_000, 0, 20 + seed)), { population: 150, generations: 5, seed });
    assert.equal(noise.validated, false, `${noise.formula}: ${noise.why}`);
  }
  // The video's fitness: e^(-return), minimised (reported for the test years).
  const ret = await evolveChampion(gpData('BTC', market(12_000, 0.25)), { population: 100, generations: 3, seed: 4, fitness: 'return' });
  assert.ok(Math.abs(ret.expNegReturn - Math.exp(-ret.test.totalReturn)) < 1e-4 * Math.max(1, ret.expNegReturn));
});

test('promotion: the formula in use stays unless the new champion beats it on the same test years', () => {
  const champ = (asset: string, score: number, contests = 1): GpChampion => ({ asset, testScore: score, contests, tokens: ['BTC.c'], formula: `f${score}`, validated: true } as unknown as GpChampion);
  const file = (cs: GpChampion[]): GpFile => ({ schema: 'gp1', generatedAt: '', version: 'v', bar: '1h', costBps: 5, band: 0.1, fitness: 'sharpe', champions: Object.fromEntries(cs.map((c) => [c.asset, c])) });
  const inc = file([champ('BTC', 1.5, 2), champ('ETH', 0.5, 1)]);
  const cand = file([champ('BTC', 1.2), champ('ETH', 0.9), champ('SOL', 0.3)]);
  const rejudged: string[] = [];
  const m = mergeChampions(inc, cand, (asset, _t, contests) => { rejudged.push(`${asset}:${contests}`); return champ(asset, asset === 'BTC' ? 1.4 : 0.6, contests); });
  assert.deepEqual(m.kept, ['BTC']);
  assert.deepEqual(m.improved.sort(), ['ETH', 'SOL']);
  assert.equal(m.file.champions.BTC.testScore, 1.4, 'kept, with its numbers on the new test years');
  assert.equal(m.file.champions.ETH.formula, 'f0.9');
  assert.deepEqual(rejudged.sort(), ['BTC:3', 'ETH:2'], 'every comparison on a test window counts as a contest');
  assert.equal(m.file.champions.SOL.contests, 1);
});

test('live reader: the same exposure as the research on the latest bars, re-read when the champion changes, speaks only validated', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'gp_indicators.json');
  const bars = market(2000, 0.1);
  const t1: Token[] = ['z24', 'ETH.c'], t2: Token[] = ['mul', '-1', 'z24', 'ETH.c'];
  const write = (tokens: Token[], validated: boolean, mtime: number) => {
    fs.writeFileSync(file, JSON.stringify({ schema: 'gp1', band: 0.1, champions: { BTC: { tokens, formula: formulaText(tokens), inputs: assetsOf(tokens), lookback: lookbackOf(tokens), validated } } }));
    fs.utimesSync(file, mtime, mtime);
  };
  write(t1, true, 1000);
  const g = new GpSignals(() => file, () => false, 0);
  const live = (a: string) => bars[a]?.slice(-320);
  const r1 = g.read('BTC', live)!;
  const d = gpData('BTC', bars);
  const want = desiredExposure(evaluate(t1, d.inp));
  assert.ok(Math.abs(r1.desired - want[want.length - 1]) < 1e-9, `${r1.desired} vs ${want[want.length - 1]}`);
  assert.ok(Math.abs(r1.exposure) <= 1 && r1.speaks && r1.validated);
  assert.equal(r1.exposure, exposureOf(t1, { ...d, inp: buildInputs('BTC', { BTC: live('BTC')!, ETH: live('ETH')! }) }, 0.1).at(-1));
  write(t2, false, 2000);
  const r2 = g.read('BTC', live)!;
  assert.ok(Math.abs(r2.desired + r1.desired) < 1e-9, 're-read: the new champion is the mirror image');
  assert.equal(r2.speaks, false, 'an unvalidated formula does not speak');
  assert.equal(new GpSignals(() => file, () => true).read('BTC', live)!.speaks, true, 'unless allowed (paper)');
  const slow = new GpSignals(() => file, () => false, 60_000);
  assert.ok(slow.read('BTC', live));
  write(t1, true, 3000);
  assert.equal(slow.read('BTC', live)!.validated, false, 'the file is checked again only after the recheck interval');
  assert.equal(g.read('ETH', live), undefined, 'no champion for ETH');
  assert.equal(g.read('BTC', (a) => bars[a]?.slice(-10)), undefined, 'too few bars for its lookback');
  // As a conviction signal, outside its dead band.
  assert.ok(orientedSignals({}, undefined, false, undefined, { exposure: -0.6 }).some(([n, x]) => n === 'evolved formula' && x === -0.6));
  assert.ok(!orientedSignals({}, undefined, false, undefined, { exposure: 0.05 }).some(([n]) => n === 'evolved formula'));
});

test('runGp: coins from the history store, population scored on worker threads, champions per coin kept or replaced', async () => {
  const dir = tmpDir();
  const bars = market(11_000, 0.25, 9);
  for (const [a, bs] of Object.entries(bars)) upsertSeries(dir, 'binance', a, '1h', bs.map((b) => ({ ...b })));
  const opts = { population: 80, generations: 3, seed: 2, workers: 2 };
  const r = await runGp({ dir, assets: ['BTC', 'ETH', 'SOL'], cross: ['BTC', 'ETH'], opts });
  assert.deepEqual(Object.keys(r.file.champions).sort(), ['BTC', 'ETH']);
  assert.ok(r.skipped.SOL, 'no SOL history');
  assert.deepEqual(r.improved.sort(), ['BTC', 'ETH'], 'the first champions');
  assert.ok(r.file.champions.BTC.evaluated > 80);
  // Again with the first file in use: its formulas are seeded and judged on the same test years.
  const again = await runGp({ dir, assets: ['BTC'], cross: ['BTC', 'ETH'], opts: { ...opts, seed: 5, workers: 1 }, incumbent: r.file });
  assert.equal(again.kept.length + again.improved.length, 1);
  assert.ok(again.file.champions.ETH, 'a coin not re-run keeps its champion');
  assert.equal(again.file.champions.BTC.contests, 2);
});

test('pipeline step gp: champions in the models folder, improved the first time, then not due until GP_EVERY_DAYS', async () => {
  const dir = tmpDir();
  for (const [a, bs] of Object.entries(market(11_000, 0.25, 9))) upsertSeries(path.join(dir, 'history'), 'binance', a, '1h', bs.map((b) => ({ ...b })));
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), DATA_DIR: dir, GP_POPULATION: '40', GP_GENERATIONS: '2', GP_ASSETS: 'BTC' });
  const now = Date.UTC(2026, 9, 1);
  const r = await runPipeline({ cfg, only: ['gp'], log: () => undefined, now });
  const step = r.steps.find((s) => s.step === 'gp')!;
  assert.ok(step.ok && !step.skipped, step.error ?? step.skipped);
  const detail = step.detail as { improved: boolean; promoted: boolean; champions: Record<string, { formula: string }> };
  assert.equal(detail.improved, true, 'the first champion');
  assert.ok(detail.champions.BTC.formula);
  const file = JSON.parse(fs.readFileSync(path.join(cfg.autoTrain.dir, 'gp_indicators.json'), 'utf8')) as GpFile;
  assert.equal(file.schema, 'gp1');
  assert.deepEqual(Object.keys(file.champions), ['BTC']);
  assert.equal(r.state.gpAt, now);
  const again = await runPipeline({ cfg, only: ['gp'], log: () => undefined, now: now + 86_400_000 });
  assert.match(again.steps.find((s) => s.step === 'gp')!.skipped ?? '', /every 7 day/);
});

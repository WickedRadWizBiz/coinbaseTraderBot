// The backtester's model-call tape (research/callTape.ts): the first run over a window records the model call for every
// contract every second, later runs with other strategy settings look up the ones they make (a market with nothing
// working waits a few seconds between evaluations) and must end on exactly the result of a run without the tape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../bot/config';
import { MetaModel } from '../bot/model/metaModel';
import { PRIORITY_TAPE_KEYS, runBacktest, type BacktestResult } from '../research/backtest';
import { openTape, pruneTapes, TapeMiss, TapeReader, TapeWriter, tickerHash } from '../research/callTape';
import { writeSyntheticRecordings } from '../research/synthetic';
import { tmpDir } from './helpers';

test('tape: calls are looked up by second and contract; one the tape does not hold, or on another fair value, is a miss', () => {
  const file = path.join(tmpDir(), 't.tape');
  const w = openTape(file, 'sig', ['a']) as TapeWriter;
  assert.equal(w.mode, 'record');
  // Three contracts a second, 70,000 calls: one second straddles the first chunk's end (65,536 rows).
  const ids = ['X', 'Y', 'Z'].map(tickerHash);
  for (let i = 0; i < 70_000; i++) w.push(Math.floor(i / 3), ids[i % 3], 0.5, i / 70_000, i % 2 ? 0.1 : undefined, [i * 2]);
  w.finish();
  const r = openTape(file, 'sig', ['a']) as TapeReader;
  assert.equal(r.mode, 'replay');
  const c0 = r.next(0, ids[0], 0.5);
  assert.deepEqual([c0.p, c0.std, c0.x[0]], [0, undefined, 0]);
  const z = r.next(0, ids[2], 0.5);
  assert.deepEqual([z.p, z.x[0]], [2 / 70_000, 4], 'another contract in the same second, out of the recorded order');
  const y = r.next(1, ids[1], 0.5);
  assert.deepEqual([y.p, y.std, y.x[0]], [4 / 70_000, undefined, 8], 'contracts the run skips are passed over');
  assert.throws(() => r.next(1, ids[1], 0.5), TapeMiss, 'the same call twice');
  r.abort();
  const s2 = openTape(file, 'sig', ['a']) as TapeReader;
  const cut = 21_845; // rows 65,535 .. 65,537
  assert.deepEqual([s2.next(cut, ids[0], 0.5).x[0], s2.next(cut, ids[1], 0.5).x[0], s2.next(cut, ids[2], 0.5).x[0]], [131_070, 131_072, 131_074], 'a second across two chunks');
  assert.throws(() => s2.next(cut + 1, ids[0], 0.6), TapeMiss, 'another fair value');
  assert.throws(() => s2.next(cut, ids[0], 0.5), TapeMiss, 'back in time');
  s2.abort();
  const gone = openTape(file, 'sig', ['a']) as TapeReader;
  assert.throws(() => gone.next(1, tickerHash('W'), 0.5), TapeMiss, 'a contract the tape never saw');
  gone.abort();
  assert.equal(openTape(file, 'other', ['a']).mode, 'record', 'another signature: recorded afresh');
  assert.equal(openTape(file, 'sig', ['b']).mode, 'record', 'other keys: recorded afresh');
  const short = openTape(file, 'sig', ['a']) as TapeReader;
  for (let i = 0; i < 10; i++) short.next(i, ids[0], 0.5);
  short.finish(); // fewer calls than the tape: markets with nothing working wait
  pruneTapes(path.dirname(file), 1);
  assert.equal(fs.existsSync(file), false, 'over the size cap: dropped');
});

const summary = (r: BacktestResult) => JSON.stringify({ pnl: r.pnl, fills: r.fills, contracts: r.contracts, fees: r.fees, windows: [...r.windows], trades: r.trades, exits: r.exits, evals: r.entryEvaluations, vault: r.vaultEnd });

test('backtest on a tape: other settings played back give exactly the untaped result; a stale tape is re-recorded', async () => {
  const dir = path.join(tmpDir(), 'rec'), tapes = tmpDir();
  writeSyntheticRecordings(dir, { windows: 6, seed: 21, marketNoise: 0.05 });
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), STRATEGY_STYLE: 'both', STRATEGY_CADENCE: 'continuous' });
  const model = MetaModel.identity();
  const B = { ...cfg.strategy, minEdge: cfg.strategy.minEdge + 0.02, kellyFraction: 0.5 };
  for (const exitPolicy of ['fair_value', 'confluence_ratchet'] as const) {
    const tape = { file: path.join(tapes, `${exitPolicy}.tape`), sig: 'days+model' };
    const plain = await runBacktest(dir, model, B, cfg.risk, 200, { exitPolicy });
    assert.ok(plain.fills > 0, 'the run trades');
    await runBacktest(dir, model, cfg.strategy, cfg.risk, 200, { exitPolicy, tape });
    assert.ok(fs.existsSync(`${tape.file}.json`), 'recorded');
    assert.equal(openTape(tape.file, tape.sig, PRIORITY_TAPE_KEYS).mode, 'replay');
    const played = await runBacktest(dir, model, B, cfg.risk, 200, { exitPolicy, tape });
    assert.equal(summary(played), summary(plain), `${exitPolicy}: played back = run afresh`);
  }
  // A tape from other days with the same times and contracts (and the same signature by mistake): the first fair value
  // that differs starts the run over without it.
  const other = path.join(tmpDir(), 'rec2');
  writeSyntheticRecordings(other, { windows: 6, seed: 22, marketNoise: 0.05 });
  const tape = { file: path.join(tapes, 'fair_value.tape'), sig: 'days+model' };
  const fresh = await runBacktest(other, model, B, cfg.risk, 200, { exitPolicy: 'fair_value' });
  const fixed = await runBacktest(other, model, B, cfg.risk, 200, { exitPolicy: 'fair_value', tape });
  assert.equal(summary(fixed), summary(fresh));
  assert.equal(summary(await runBacktest(other, model, B, cfg.risk, 200, { exitPolicy: 'fair_value', tape })), summary(fresh), 're-recorded for these days');
});

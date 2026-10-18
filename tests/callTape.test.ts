// The backtester's model-call tape (research/callTape.ts): the first run over a window records every model call, later
// runs with other strategy settings play them back and must end on exactly the result of a run without the tape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../bot/config';
import { MetaModel } from '../bot/model/metaModel';
import { runBacktest, type BacktestResult } from '../research/backtest';
import { openTape, pruneTapes, TapeMiss, TapeReader, TapeWriter, tickerHash } from '../research/callTape';
import { writeSyntheticRecordings } from '../research/synthetic';
import { tmpDir } from './helpers';

test('tape: rows come back in order; a call out of step, too many or too few is a miss', () => {
  const file = path.join(tmpDir(), 't.tape');
  const w = openTape(file, 'sig', ['a']) as TapeWriter;
  assert.equal(w.mode, 'record');
  for (let i = 0; i < 70_000; i++) w.push(i, tickerHash('X'), 0.5, i / 70_000, i % 2 ? 0.1 : undefined, [i * 2]);
  w.finish();
  const r = openTape(file, 'sig', ['a']) as TapeReader;
  assert.equal(r.mode, 'replay');
  const c0 = r.next(0, tickerHash('X'), 0.5);
  assert.deepEqual([c0.p, c0.std, c0.x[0]], [0, undefined, 0]);
  const c = r.next(1, tickerHash('X'), 0.5);
  assert.deepEqual([c.p, c.std, c.x[0]], [1 / 70_000, 0.1, 2]);
  assert.equal(r.next(2, tickerHash('X'), 0.5).std, undefined);
  assert.throws(() => r.next(3, tickerHash('X'), 0.6), TapeMiss, 'another fair value');
  r.abort();
  assert.equal(openTape(file, 'other', ['a']).mode, 'record', 'another signature: recorded afresh');
  assert.equal(openTape(file, 'sig', ['b']).mode, 'record', 'other keys: recorded afresh');
  const short = openTape(file, 'sig', ['a']) as TapeReader;
  for (let i = 0; i < 10; i++) short.next(i, tickerHash('X'), 0.5);
  assert.throws(() => short.finish(), TapeMiss, 'fewer calls than the tape');
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
    assert.equal(openTape(tape.file, tape.sig, exitPolicy === 'confluence_ratchet' ? ['conf_count'] : []).mode, 'replay');
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

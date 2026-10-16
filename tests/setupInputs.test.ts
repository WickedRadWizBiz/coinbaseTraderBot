// The setup scorer's optional inputs: whether each source is there (research/trainSetupModel.ts setupInputStatus),
// read cheaply from the forecasts files' heads, and what the pipeline reports when one is missing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { upsertSeries } from '../bot/marketdata/historyStore';
import { LIB_SCHEMA } from '../bot/ta/librarian';
import { XG_SCHEMA } from '../bot/ta/crossGraph';
import { TANET_SCHEMA } from '../bot/ta/taNet';
import { macroConfig } from '../bot/config';
import { forecastSchema, setupInputStatus } from '../research/trainSetupModel';
import { tmpDir } from './helpers';

const DAY = 86_400_000;

test('setup inputs: each source found (or not) where its producing step writes it; the schema read from the file head', () => {
  const hist = tmpDir();
  const macro = macroConfig({} as NodeJS.ProcessEnv);
  let st = setupInputStatus(hist, macro);
  assert.deepEqual(st.map((x) => [x.producer.split(' ')[0], x.ok]), [['ta_net_oos', false], ['history', false], ['librarian', false], ['cross_graph', false]]);
  assert.match(st[1].detail!, /no BTC\.D daily/);
  // The producers' files (schema first, as their writers put it) and BTC.D daily back to 2013 (TradingView's 5,000 bars).
  const write = (dir: string, schema: string) => { fs.mkdirSync(path.join(hist, dir), { recursive: true }); fs.writeFileSync(path.join(hist, dir, 'forecasts.json'), JSON.stringify({ schema, version: 'v', assets: { BTC: [[0, 1, 2]] } })); };
  write('.tanet-oos', TANET_SCHEMA); write('.librarian', LIB_SCHEMA); write('.xgraph', 'old-schema');
  const t0 = Date.UTC(2013, 3, 1);
  upsertSeries(hist, 'tradingview', 'BTC.D', '1d', Array.from({ length: 4900 }, (_, i) => ({ ts: t0 + i * DAY, o: 50, h: 51, l: 49, c: 50, v: 0 })));
  st = setupInputStatus(hist, macro);
  assert.deepEqual(st.map((x) => x.ok), [true, true, true, false], 'a cross-graph file of another schema does not count');
  assert.match(st[1].name, /2016-01-01\.\.2017-12-31/);
  write('.xgraph', XG_SCHEMA);
  assert.ok(setupInputStatus(hist, macro).every((x) => x.ok));
  // Only from 2018: the fractal window is not covered.
  const late = tmpDir();
  upsertSeries(late, 'tradingview', 'BTC.D', '1d', Array.from({ length: 3000 }, (_, i) => ({ ts: Date.UTC(2018, 0, 1) + i * DAY, o: 50, h: 51, l: 49, c: 50, v: 0 })));
  const f = setupInputStatus(late, macro)[1];
  assert.equal(f.ok, false);
  assert.match(f.detail!, /BTC\.D daily 2018-01-01\.\./);
  // A schema further in than the head is still found (the whole file is read); a missing file has none.
  const big = path.join(hist, 'big.json');
  fs.writeFileSync(big, JSON.stringify({ assets: { X: Array.from({ length: 2000 }, (_, i) => [i, i]) }, schema: 'late' }));
  assert.equal(forecastSchema(big), 'late');
  assert.equal(forecastSchema(path.join(hist, 'none.json')), undefined);
});

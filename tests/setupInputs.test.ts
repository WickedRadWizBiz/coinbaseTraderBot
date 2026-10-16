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
import { CL_SCHEMA } from '../bot/ta/crossLead';
import { forecastSchema, setupInputStatus } from '../research/trainSetupModel';
import { tmpDir } from './helpers';

const DAY = 86_400_000;

test('setup inputs: each source found (or not) where its producing step writes it; the schema read from the file head', () => {
  const hist = tmpDir();
  const macro = macroConfig({} as NodeJS.ProcessEnv);
  let st = setupInputStatus(hist, macro);
  assert.deepEqual(st.map((x) => [x.producer.split(' ')[0], x.ok]), [['ta_net_oos', false], ['history', false], ['history', false], ['librarian', false], ['cross_graph', false]]);
  assert.match(st[1].detail!, /no BTC\.D daily/);
  assert.match(st[2].detail!, /no USDT\.D daily/);
  // The producers' files (schema first, as their writers put it) and BTC.D daily back to 2013 (TradingView's 5,000 bars).
  const write = (dir: string, schema: string) => { fs.mkdirSync(path.join(hist, dir), { recursive: true }); fs.writeFileSync(path.join(hist, dir, 'forecasts.json'), JSON.stringify({ schema, version: 'v', assets: { BTC: [[0, 1, 2]] } })); };
  write('.tanet-oos', TANET_SCHEMA); write('.librarian', LIB_SCHEMA); write('.xgraph', 'old-schema');
  const t0 = Date.UTC(2013, 3, 1);
  upsertSeries(hist, 'tradingview', 'BTC.D', '1d', Array.from({ length: 4900 }, (_, i) => ({ ts: t0 + i * DAY, o: 50, h: 51, l: 49, c: 50, v: 0 })));
  st = setupInputStatus(hist, macro);
  assert.deepEqual(st.map((x) => x.ok), [true, true, false, true, false], 'a cross-graph file of another schema does not count');
  // USDT.D (the waterfall's USDT.D leg): from 2018 it does not cover the window; TradingView's, from 2015, does.
  upsertSeries(hist, 'tradingview', 'USDT.D', '1d', Array.from({ length: 3000 }, (_, i) => ({ ts: Date.UTC(2018, 0, 1) + i * DAY, o: 5, h: 5.1, l: 4.9, c: 5, v: 0 })));
  st = setupInputStatus(hist, macro);
  assert.equal(st[2].ok, false);
  assert.match(st[2].name, /USDT\.D daily from 2016-01-01/);
  assert.match(st[2].detail!, /USDT\.D daily 2018-01-01\.\./);
  upsertSeries(hist, 'tradingview', 'USDT.D', '1d', Array.from({ length: 1100 }, (_, i) => ({ ts: Date.UTC(2015, 1, 25) + i * DAY, o: 3, h: 3.1, l: 2.9, c: 3, v: 0 })));
  assert.equal(setupInputStatus(hist, macro)[2].ok, true);
  assert.match(st[1].name, /2016-01-01\.\.2017-12-31/);
  write('.xgraph', XG_SCHEMA);
  assert.ok(setupInputStatus(hist, macro).every((x) => x.ok));
  // The cross-coin lead-lag study: there only with a pair validated at 15 or 60 minutes (what the setup scorer reads).
  const clFile = path.join(hist, 'cross_lead.json');
  const lead = (pairs: Array<{ h: number; validated: boolean }>) => fs.writeFileSync(clFile, JSON.stringify({ schema: CL_SCHEMA, pairs: pairs.map((x) => ({ leader: 'BTC', follower: 'SOL', ...x })) }));
  assert.match(setupInputStatus(hist, macro, clFile)[5].detail!, /no study/);
  lead([{ h: 1, validated: true }, { h: 15, validated: false }]);
  let cl = setupInputStatus(hist, macro, clFile)[5];
  assert.deepEqual([cl.producer, cl.ok], ['cross_lead', false]);
  assert.match(cl.detail!, /no leader \/ coin pair predictive at 15 or 60 minutes/);
  lead([{ h: 60, validated: true }]);
  cl = setupInputStatus(hist, macro, clFile)[5];
  assert.deepEqual([cl.ok, cl.detail], [true, 'BTC->SOL 60m']);
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

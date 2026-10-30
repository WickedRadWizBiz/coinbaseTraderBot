import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseCandle, repairLegacyCents } from '../research/history/kalshiHistory';

test('kalshi history: legacy price fields are cents on the live endpoints and dollars on /historical', () => {
  assert.equal(parseCandle({ end_period_ts: 1, yes_bid: { close: 55 }, yes_ask: { close: 57 } })!.bidC, 0.55);
  assert.equal(parseCandle({ end_period_ts: 1, yes_bid: { close: 0.55 }, yes_ask: { close: 0.57 } })!.askC, 0.57);
  assert.equal(parseCandle({ end_period_ts: 1, yes_bid: { close: 1 } })!.bidC, 0.01, 'one cent');
  assert.equal(parseCandle({ end_period_ts: 1, yes_bid: { close_dollars: '0.4300', close: 43 } })!.bidC, 0.43, 'the dollar field wins');
});

test('kalshi history: stored quotes under a cent are repaired in place, once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
  const sd = path.join(dir, 'KXBTC15M'); fs.mkdirSync(sd);
  const bad = { ticker: 'A', series: 'KXBTC15M', openTime: 0, closeTime: 900000, strike: 1, cap: null, result: 'yes', candles: [{ ts: 1, bidO: 0.0055, bidH: 0.0056, bidL: 0.0054, bidC: 0.0055, askO: 0.0057, askH: null, askL: null, askC: 0.0057, last: 0.0056, volume: 3, oi: 1 }] };
  const good = { ...bad, ticker: 'B', candles: [{ ...bad.candles[0], bidO: 0.55, bidH: 0.56, bidL: 0.54, bidC: 0.55, askO: 0.57, askC: 0.57, last: 0.56 }] };
  fs.writeFileSync(path.join(sd, '1970-01-01.jsonl'), `${JSON.stringify(bad)}\n${JSON.stringify(good)}\n`);
  const r = repairLegacyCents(dir);
  assert.deepEqual(r, { files: 1, markets: 1 });
  const lines = fs.readFileSync(path.join(sd, '1970-01-01.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines[0].candles[0].bidC, 0.55); assert.equal(lines[0].candles[0].askC, 0.57); assert.equal(lines[0].candles[0].askH, null);
  assert.deepEqual(lines[1], good);
  assert.deepEqual(repairLegacyCents(dir), { files: 0, markets: 0 }, 'idempotent');
});

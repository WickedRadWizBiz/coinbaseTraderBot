import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { Tca } from '../bot/tca/tca';
import { tmpDir } from './helpers';

const rec = (o: Record<string, unknown>) => JSON.stringify({ tradeId: 't', ticker: 'X', side: 'bid', count: 1, price: 0.5, fee: 0, isTaker: false, markouts: { '5s': -0.01, '30s': -0.01, '60s': -0.02 }, ...o });

test('TCA: a restart reloads the recent maker markouts of its own trading mode, so the maker buffer keeps what it learned', () => {
  const dir = tmpDir();
  const now = Date.parse('2026-10-22T20:00:00Z');
  const day = 86_400_000;
  fs.writeFileSync(path.join(dir, 'tca.jsonl'), [
    rec({ mode: 'live', ts: now - day }),
    rec({ mode: 'live', ts: now - 2 * day, markouts: { '5s': 0, '30s': 0, '60s': -0.01 } }),
    rec({ mode: 'paper', ts: now - day, markouts: { '5s': 0, '30s': 0, '60s': 0.05 } }), // simulated: never in the live buffer
    rec({ ts: now - day }), // written before records carried their mode: skipped
    rec({ mode: 'live', ts: now - 8 * day }), // older than a week: skipped
    rec({ mode: 'live', ts: now - day, isTaker: true }), // a taker fill is kept but is not a maker markout
    '{"partial',
  ].join('\n') + '\n');
  const live = new Tca(dir, () => 0.5, 'live', now);
  assert.deepEqual(live.makerMarkout60(), { n: 2, avg: -0.015 });
  const paper = new Tca(dir, () => 0.5, 'paper', now);
  assert.deepEqual(paper.makerMarkout60(), { n: 1, avg: 0.05 });
  assert.deepEqual(new Tca(dir, () => 0.5, undefined, now).makerMarkout60(), { n: 0, avg: null }, 'no mode: nothing reloaded');
  // New fills carry the mode.
  live.onFill({ tradeId: 'n', orderId: 'o', ticker: 'X', side: 'bid', count: 1, price: 0.4, isTaker: false, ts: now }, undefined, 0);
  const latest = (live.summary().recent as Array<{ tradeId: string; mode?: string }>)[0];
  assert.deepEqual([latest.tradeId, latest.mode], ['n', 'live']);
});

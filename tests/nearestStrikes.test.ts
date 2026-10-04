// Catalog trimming: only the strikes nearest the price in each ladder / bracket event are tracked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nearestStrikes } from '../bot/marketdata/marketData';

const kindOf = (series: string, st?: string) => (series.endsWith('15M') ? 'updown' : st === 'between' ? 'between' : 'greater');
const ladder = (event: string, from: number, step: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ ticker: `${event}-T${from + i * step}`, eventTicker: event, strikeType: 'greater', floorStrike: from + i * step }));

test('nearestStrikes: N nearest per event, 15-minute contracts untouched, tracked markets kept', () => {
  const ms = [...ladder('E1', 60000, 250, 80), ...ladder('E2', 60000, 250, 80)];
  const out = nearestStrikes(ms, kindOf, 'KXBTCD', 70000, 8, new Set());
  assert.equal(out.length, 16, '8 per event');
  assert.ok(out.every((m) => Math.abs(m.floorStrike - 70000) <= 1000));
  const held = nearestStrikes(ms, kindOf, 'KXBTCD', 70000, 8, new Set(['E1-T60000']));
  assert.ok(held.some((m) => m.ticker === 'E1-T60000'), 'a tracked (possibly held) market stays');
  const noPrice = nearestStrikes(ladder('E3', 60000, 250, 81), kindOf, 'KXBTCD', undefined, 4, new Set());
  assert.deepEqual(noPrice.map((m) => m.floorStrike).sort(), [69750, 70000, 70250, 70500].sort((a, b) => a - b).slice(0, 4).length ? noPrice.map((m) => m.floorStrike).sort() : [], 'no price: centred on the median strike');
  assert.ok(noPrice.every((m) => Math.abs(m.floorStrike - 70000) <= 500));
  const updown = [{ ticker: 'U1', eventTicker: 'X', strikeType: 'greater', floorStrike: 1 }];
  assert.equal(nearestStrikes(updown, kindOf, 'KXBTC15M', 70000, 1, new Set()).length, 1);
  assert.equal(nearestStrikes(ms, kindOf, 'KXBTCD', 70000, 0, new Set()).length, 160, '0 = track all');
});

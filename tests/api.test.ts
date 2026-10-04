// Kalshi API conformance: price grids (Fixed-Point Representation), fee rounding, exchange status and
// schedule, scheduled fee changes, and the historical market downloader.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onGrid, parsePriceRanges, snapToGrid, tickAt } from '../bot/kalshi/priceGrid';
import { takerFee, makerFee } from '../bot/fees';
import { ExchangeStatusMonitor, parseExchangeStatus, parseMaintenanceWindows } from '../bot/kalshi/exchangeStatus';
import { parseMarket } from '../bot/kalshi/wire';
import { downloadKalshiHistory, loadKalshiHistory, parseCandle } from '../research/history/kalshiHistory';

// center_half_edge_quint_cent: $0.002 below $0.10 and above $0.90, $0.005 in between.
const QUINT = parsePriceRanges([{ start: '0.0000', end: '0.1000', step: '0.0020' }, { start: '0.1000', end: '0.9000', step: '0.0050' }, { start: '0.9000', end: '1.0000', step: '0.0020' }]);

test('price grid: bands from price_ranges; on-grid checks, snapping and tick per band', () => {
  assert.ok(QUINT && QUINT.length === 3);
  assert.equal(onGrid(0.094, QUINT, 0.01), true);
  assert.equal(onGrid(0.095, QUINT, 0.01), false, '0.095 is a $0.005 multiple but the edge band steps $0.002');
  assert.equal(onGrid(0.105, QUINT, 0.01), true);
  assert.equal(onGrid(0.1, QUINT, 0.01), true, 'band edges are valid');
  assert.equal(onGrid(0.5, QUINT, 0.01), true, 'whole cents are valid in every structure');
  assert.equal(snapToGrid(0.095, QUINT, 0.01, -1), 0.094);
  assert.equal(snapToGrid(0.095, QUINT, 0.01, 1), 0.096);
  assert.equal(snapToGrid(0.503, QUINT, 0.01, -1), 0.5);
  assert.equal(snapToGrid(0.503, QUINT, 0.01, 1), 0.505);
  assert.equal(tickAt(0.05, QUINT, 0.01), 0.002);
  assert.equal(tickAt(0.5, QUINT, 0.01), 0.005);
  // No bands: the market's single tick.
  assert.equal(onGrid(0.505, undefined, 0.01), false);
  assert.equal(snapToGrid(0.505, undefined, 0.01, -1), 0.5);
  assert.equal(parsePriceRanges([{ start: 'x', end: 1, step: 0.01 }]), undefined);
  const m = parseMarket({ ticker: 'KXBTC15M-X', open_time: '2026-10-01T00:00:00Z', close_time: '2026-10-01T00:15:00Z', price_ranges: [{ start: '0.0000', end: '1.0000', step: '0.0010' }] });
  assert.deepEqual(m?.priceRanges, [{ start: 0, end: 1, step: 0.001 }]);
});

test('fee rounding: trade fee to $0.000001, then the balance change back onto the member grid', () => {
  // Whole cents and whole contracts: the familiar "round up to the next cent".
  assert.equal(takerFee(100, 0.5), 1.75);
  assert.equal(takerFee(1, 0.5), 0.02);
  // Sub-cent notional (5.5 contracts at $0.01 = $0.055): model fee $0.0038115 -> trade fee $0.003812;
  // the $0.058812 debit rounds to $0.06 for a non-direct member, so the net fee is $0.005.
  assert.equal(takerFee(5.5, 0.01), 0.005);
  // A direct member's $0.0001 grid: $0.058812 -> $0.0589, net fee $0.0039.
  assert.equal(takerFee(5.5, 0.01, { takerMultiplier: 1, makerMultiplier: 0, balancePrecision: 0.0001 }), 0.0039);
  assert.equal(makerFee(100, 0.5), 0);
});

test('exchange status and schedule: pauses and maintenance block new entries; stale status is ignored', async () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  assert.deepEqual(parseExchangeStatus({ exchange_active: true, trading_active: false }, now), { exchangeActive: true, tradingActive: false, resumeTime: undefined, at: now });
  assert.equal(parseExchangeStatus({}, now), undefined);
  const w = parseMaintenanceWindows({ schedule: { maintenance_windows: [{ start_datetime: '2026-10-08T12:05:00Z', end_datetime: '2026-10-08T13:00:00Z' }, { start_datetime: 'bad', end_datetime: 'x' }] } });
  assert.equal(w.length, 1);
  let status: Record<string, unknown> = { exchange_active: true, trading_active: true };
  const mon = new ExchangeStatusMonitor({ getExchangeStatus: async () => status, getExchangeSchedule: async () => ({ schedule: { maintenance_windows: [] } }) }, { leadMin: 10 });
  await mon.pollStatus(now); await mon.pollSchedule();
  assert.equal(mon.scheduleKnown(), true);
  assert.equal(mon.entryBlock(now), undefined);
  status = { exchange_active: true, trading_active: false };
  await mon.pollStatus(now);
  assert.match(mon.entryBlock(now)!, /trading paused/);
  assert.equal(mon.perpsBlock(now), undefined, 'perps trade around the clock');
  status = { exchange_active: false, trading_active: false, exchange_estimated_resume_time: '2026-10-08T13:00:00Z' };
  await mon.pollStatus(now);
  assert.match(mon.entryBlock(now)!, /maintenance.*13:00/);
  assert.match(mon.perpsBlock(now)!, /maintenance/);
  assert.equal(mon.entryBlock(now + 400_000), undefined, 'a status older than 5 minutes is not trusted');
  status = { exchange_active: true, trading_active: true };
  await mon.pollStatus(now);
  mon.windows = w;
  assert.match(mon.entryBlock(now)!, /maintenance in 5 min/);
  assert.match(mon.entryBlock(now + 10 * 60_000)!, /maintenance window/);
  assert.equal(mon.entryBlock(now + 61 * 60_000), undefined);
});

test('kalshi history: both tiers, 1-minute candles parsed from fixed-point strings, resumable', async () => {
  const c = parseCandle({ end_period_ts: 1_700_000_060, yes_bid: { open_dollars: '0.4100', high_dollars: '0.4500', low_dollars: '0.4000', close_dollars: '0.4400' }, yes_ask: { close_dollars: '0.4600' }, price: { close_dollars: '0.4500' }, volume_fp: '12.00', open_interest_fp: '30.00' });
  assert.deepEqual([c?.ts, c?.bidC, c?.askC, c?.last, c?.volume], [1_700_000_060_000, 0.44, 0.46, 0.45, 12]);
  const now = Date.parse('2026-10-03T00:00:00Z');
  const mk = (t: string, close: string) => ({ ticker: t, event_ticker: 'E', open_time: new Date(Date.parse(close) - 900_000).toISOString(), close_time: close, floor_strike: 60000, result: 'yes' });
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const body = u.pathname.endsWith('/historical/cutoff') ? { market_settled_ts: '2026-09-01T00:00:00Z' }
      : u.pathname.endsWith('/historical/markets') ? { markets: [mk('OLD', '2026-08-20T00:15:00Z')], cursor: '' }
        : u.pathname.endsWith('/markets') ? { markets: [mk('NEW', '2026-10-02T00:15:00Z')], cursor: '' }
          : { candlesticks: [{ end_period_ts: 1_759_363_260, yes_bid: { close_dollars: '0.5000' }, yes_ask: { close_dollars: '0.5200' } }] };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as unknown as typeof fetch;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
  const r = await downloadKalshiHistory({ series: ['KXBTC15M'], days: 60, out, fetchImpl, now, log: () => {} });
  assert.deepEqual(r, { markets: 2, skipped: 0, failed: 0 });
  assert.ok(calls.some((u) => u.includes('/historical/markets/OLD/candlesticks')), 'markets settled before the cutoff read from the historical tier');
  assert.ok(calls.some((u) => u.includes('/series/KXBTC15M/markets/NEW/candlesticks')));
  const stored = loadKalshiHistory(out, 'KXBTC15M');
  assert.deepEqual(stored.map((m) => m.ticker), ['OLD', 'NEW']);
  assert.equal(stored[1].candles[0].askC, 0.52);
  const again = await downloadKalshiHistory({ series: ['KXBTC15M'], days: 60, out, fetchImpl, now, log: () => {} });
  assert.deepEqual(again, { markets: 0, skipped: 2, failed: 0 });
});

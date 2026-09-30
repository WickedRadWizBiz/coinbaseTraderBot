import assert from 'node:assert/strict';
import path from 'path';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import type { KalshiRest } from '../bot/kalshi/rest';
import type { MarketInfo } from '../bot/kalshi/types';
import { MarketData, Recorder } from '../bot/marketdata/marketData';
import { assetFromSeries, selectCryptoSeries } from '../bot/marketdata/seriesDiscovery';
import { tmpDir } from './helpers';

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

test('discovery keeps every 15-minute / hourly crypto series with a settlement index', () => {
  const rows = [
    { ticker: 'KXBTC15M', frequency: 'fifteen_min' }, { ticker: 'KXETH15M' }, { ticker: 'KXSOL15M' }, { ticker: 'KXXRP15M' }, { ticker: 'KXDOGE15M' },
    { ticker: 'KXBTCD', frequency: 'hourly' }, { ticker: 'KXETHD', frequency: 'hourly' }, { ticker: 'KXXRPD', frequency: 'daily' },
    { ticker: 'KXBTC', frequency: 'hourly' }, { ticker: 'KXETH' },
    { ticker: 'KXBTCMAXY', frequency: 'annual' }, { ticker: 'KXBTCMAXY' }, { ticker: 'KXSHIBA15M' }, { ticker: 'KXBTCD', frequency: 'weekly' },
  ];
  const got = selectCryptoSeries(rows, ASSETS);
  assert.deepEqual(Object.keys(got).sort(), ['KXBTC', 'KXBTC15M', 'KXBTCD', 'KXDOGE15M', 'KXETH', 'KXETH15M', 'KXETHD', 'KXSOL15M', 'KXXRP15M', 'KXXRPD']);
  assert.equal(got.KXDOGE15M, 'DOGE');
  assert.equal(assetFromSeries('KXSHIBA15M', ASSETS), undefined, 'no settlement index -> not priceable');
});

test('STRATEGY_SERIES=auto (default) trades discovered series; explicit lists still work', async () => {
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), DOMINANCE_FEED: 'false', SPOT_FEED: 'false' });
  assert.equal(cfg.strategy.seriesAuto, true);
  const now = Date.now();
  const mk = (ticker: string, series: string, extra: Partial<MarketInfo> = {}): MarketInfo => ({ ticker, seriesTicker: series, status: 'open', openTime: now - 60_000, closeTime: now + 600_000, tickSize: 0.01, ...extra });
  const bySeries: Record<string, MarketInfo[]> = {
    KXSOL15M: [mk('KXSOL15M-A', 'KXSOL15M', { floorStrike: 150 })],
    KXETHD: [mk('KXETHD-A-T4000', 'KXETHD', { floorStrike: 4000, strikeType: 'greater' })],
  };
  const rest = {
    listSeries: async () => [{ ticker: 'KXSOL15M' }, { ticker: 'KXETHD', frequency: 'hourly' }, { ticker: 'KXBTCMAXY' }],
    getSeriesFees: async () => ({ takerMultiplier: 1, makerMultiplier: 0 }),
    getOpenMarkets: async (s: string) => bySeries[s] ?? [],
  } as unknown as KalshiRest;
  const md = new MarketData(cfg, rest, undefined, new Recorder(path.join(tmpDir(), 'rec')));
  await md.refreshCatalog(now);
  const active = md.activeMarkets(now);
  assert.deepEqual(active.map((m) => [m.ticker, m.asset, m.kind]).sort(), [['KXETHD-A-T4000', 'ETH', 'greater'], ['KXSOL15M-A', 'SOL', 'updown']]);
  assert.ok(md.index.has('DOGE') && md.index.has('XRP'), 'index trackers for every asset with a settlement index');
  const explicit = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), STRATEGY_SERIES: 'KXBTC15M,KXETHD' });
  assert.equal(explicit.strategy.seriesAuto, false);
  assert.deepEqual(explicit.strategy.series, ['KXBTC15M', 'KXETHD']);
});

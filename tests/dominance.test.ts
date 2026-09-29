import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DominanceCalculator, DominanceService } from '../bot/marketdata/dominance';

const coins = [
  { symbol: 'btc', price: 60000, marketCap: 1_200e9 },
  { symbol: 'eth', price: 3000, marketCap: 360e9 },
  { symbol: 'usdt', price: 1, marketCap: 150e9 },
  { symbol: 'usdc', price: 1, marketCap: 50e9 },
  { symbol: 'sol', price: 150, marketCap: 70e9 },
];
const TOTAL = 2_300e9; // includes a 470e9 long tail not in the list

test('baseline reproduces CoinGecko dominance at anchor prices', () => {
  const c = new DominanceCalculator();
  const live = new Map([['BTC', 60000], ['ETH', 3000], ['SOL', 150]]);
  c.setBaseline(coins, TOTAL, live, 1);
  const d = c.compute(live, 2)!;
  assert.ok(Math.abs(d.totalCap - TOTAL) / TOTAL < 1e-9);
  assert.ok(Math.abs(d.usdtd - (100 * 150e9) / TOTAL) < 1e-9);
  assert.ok(Math.abs(d.btcd - (100 * 1200e9) / TOTAL) < 1e-9);
});

test('USDT.D falls when crypto rallies; BTC.D rises when BTC outperforms', () => {
  const c = new DominanceCalculator();
  const base = new Map([['BTC', 60000], ['ETH', 3000], ['SOL', 150]]);
  c.setBaseline(coins, TOTAL, base, 1);
  const d0 = c.compute(base, 2)!;
  const rally = c.compute(new Map([['BTC', 63000], ['ETH', 3150], ['SOL', 157.5]]), 3)!;
  assert.ok(rally.usdtd < d0.usdtd, 'risk-on lowers USDT.D');
  // Stablecoins don't rally, so BTC.D drifts up slightly even when all coins rise together.
  assert.ok(rally.btcd > d0.btcd && rally.btcd - d0.btcd < 0.5, 'uniform rally moves BTC.D only slightly');
  const btcLeads = c.compute(new Map([['BTC', 63000], ['ETH', 3000], ['SOL', 150]]), 4)!;
  assert.ok(btcLeads.btcd > d0.btcd);
});

test('no BTC price or no baseline means no sample (never invented)', () => {
  const c = new DominanceCalculator();
  assert.equal(c.compute(new Map([['BTC', 1]]), 1), undefined);
  c.setBaseline(coins, TOTAL, new Map(), 1);
  assert.equal(c.compute(new Map([['ETH', 3000]]), 2), undefined);
  assert.throws(() => new DominanceCalculator().setBaseline(coins.filter((x) => x.symbol !== 'usdt'), TOTAL, new Map(), 1));
});

test('service parses Binance mini-tickers and anchors from CoinGecko', async () => {
  const fake = (async (url: string) => {
    if (String(url).includes('/global')) return new Response(JSON.stringify({ data: { total_market_cap: { usd: TOTAL } } }));
    return new Response(JSON.stringify(coins.map((c) => ({ symbol: c.symbol, current_price: c.price, market_cap: c.marketCap }))));
  }) as unknown as typeof fetch;
  const svc = new DominanceService({ binanceWsUrl: 'wss://x', coingeckoUrl: 'https://cg.test/api/v3', fetchImpl: fake });
  const now = Date.now();
  svc.onMiniTickers([{ s: 'BTCUSDT', c: '60000', E: now }, { s: 'ETHUSDT', c: '3000', E: now }, { s: 'ETHBTC', c: '0.05', E: now }, { s: 'SOLUSDT', c: 'bad', E: now }]);
  await svc.refreshBaseline();
  assert.equal(svc.lastError, undefined);
  const s = svc.tick(now)!;
  assert.ok(s.usdtd > 6 && s.usdtd < 7);
  assert.ok(s.coveredShare > 0.6);
  assert.equal(svc.prices.has('ETHBTC'.slice(0, -4)), false);
});

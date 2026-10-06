import assert from 'node:assert/strict';
import path from 'path';
import { test } from 'node:test';
import { Alerter } from '../bot/alerts/alerter';
import { loadConfig } from '../bot/config';
import { Engine } from '../bot/engine';
import type { KalshiRest } from '../bot/kalshi/rest';
import type { MarketInfo } from '../bot/kalshi/types';
import { MarketData, Recorder } from '../bot/marketdata/marketData';
import { MetaModel } from '../bot/model/metaModel';
import { Oms } from '../bot/oms/oms';
import { PaperExchange } from '../bot/paper/paperExchange';
import { KillSwitch } from '../bot/risk/killSwitch';
import { RiskGateway } from '../bot/risk/riskGateway';
import { Reconciler } from '../bot/recon/reconciler';
import { tmpAudit, tmpDir } from './helpers';
import { Vault } from '../bot/vault/vault';
import { BalanceMonitor } from '../bot/vault/balanceMonitor';

async function setup(opts: { dailyLossUsd?: string; exitPolicy?: string; vault?: Vault; monitor?: BalanceMonitor; env?: Record<string, string> } = {}) {
  const dir = tmpDir();
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), DATA_DIR: dir, RISK_DAILY_LOSS_USD: opts.dailyLossUsd ?? '10', DOMINANCE_FEED: 'false', SPOT_FEED: 'false', EXIT_POLICY: opts.exitPolicy, STRATEGY_SERIES: 'KXBTC15M', SESSION_EDGE_NO_ENTRY: 'false', TENNIS_ENABLED: 'false', ...opts.env });
  const now = Date.now();
  const market: MarketInfo = { ticker: 'KXBTC15M-TEST', seriesTicker: 'KXBTC15M', status: 'open', openTime: now - 300_000, closeTime: now + 600_000, floorStrike: 60000, tickSize: 0.01 };
  const rest = {
    getSeriesFees: async () => ({ takerMultiplier: 1, makerMultiplier: 0 }),
    getOpenMarkets: async () => [market],
    getMarket: async () => market,
  } as unknown as KalshiRest;
  const audit = tmpAudit();
  const md = new MarketData(cfg, rest, undefined, new Recorder(path.join(dir, 'rec')));
  await md.refreshCatalog(now);
  // Fresh book and a warmed-up index slightly above the strike.
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.45, size: 50 }], asks: [{ price: 0.6, size: 50 }] }, now);
  const idx = md.index.get('BTC')!;
  let seed = 1;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  let x = Math.log(60010);
  for (let s = 600; s >= 0; s--) { x += 0.0002 * (rand() - 0.5); idx.add(Math.exp(x), now - s * 1000); }

  const paper = new PaperExchange(undefined, 200, (t) => md.books.get(t), () => ({ takerMultiplier: 1, makerMultiplier: 0 }));
  const kill = new KillSwitch(path.join(dir, 'kill.json'), audit);
  const oms = new Oms({ gateway: paper, audit, statePath: path.join(dir, 'oms.json'), feesFor: (t) => md.feesFor(t), sleep: async () => undefined });
  kill.bindCancelAll((r) => oms.cancelAll(r));
  paper.on('fill', (f) => oms.onFill(f));
  paper.on('order', (o) => oms.onExchangeOrder(o));
  const recon = new Reconciler({ gateway: paper, oms, audit, getMarket: rest.getMarket, onPersistentBreak: (r) => void kill.engage(r, 'recon') });
  const engine = new Engine({ cfg, audit, alerter: new Alerter([], audit), md, gateway: paper, oms, risk: new RiskGateway(cfg.risk), kill, recon, model: MetaModel.identity(), vault: opts.vault, balanceMonitor: opts.monitor });
  return { cfg, md, paper, oms, kill, recon, engine, market, audit };
}

test('engine places risk-checked post-only quotes through the OMS and paper exchange', async () => {
  const { engine, recon, paper, oms, market, md } = await setup();
  const r = await recon.run('startup');
  engine.balance = r!.balance;
  await engine.tick();
  const open = await paper.getOpenOrders();
  assert.ok(open.length >= 1, `status: ${JSON.stringify(engine.status.get(market.ticker))}`);
  for (const o of open) {
    const rec = oms.get(o.clientOrderId!)!;
    assert.equal(rec.postOnly, true);
    assert.ok(rec.expirationTime! <= Math.floor(market.closeTime / 1000));
    assert.ok(o.price > 0.45 - 1e-9 && o.price < 0.6 + 1e-9);
  }
  const st = engine.status.get(market.ticker)!;
  assert.ok(st.fairValue! > 0.5, 'spot above strike');
  // Every entry is put to the adversary; without TA / confluence evidence it keeps its normal size.
  assert.ok(st.adversary, 'adversary verdict recorded');
  assert.ok(st.adversary!.multiplier >= 1);
  // Stale index: quotes are pulled (fail closed), not left resting.
  md.index.get('BTC')!.add(60000, Date.now() - 1); // no-op: out of order
  const idx = md.index.get('BTC')!;
  (idx as any).points.forEach((p: { ts: number }) => { p.ts -= 60_000; });
  await engine.tick();
  assert.equal((await paper.getOpenOrders()).length, 0);
  assert.equal(engine.status.get(market.ticker)!.blocked, 'index stale');
});

test('paper training trades: with no edge anywhere, 1 contract is still traded on the model side, once per contract', async () => {
  const { engine, recon, oms, market, md } = await setup({ env: { STRATEGY_MIN_EDGE: '0.5', PAPER_EXPLORE: 'false', PAPER_TRAINING_TRADES_PER_HOUR: '12' } });
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.55, size: 50 }], asks: [{ price: 0.6, size: 50 }] }, Date.now());
  const r = await recon.run('startup');
  engine.balance = r!.balance;
  await engine.tick();
  const entries = oms.allOrders().filter((o) => o.ticker === market.ticker && o.purpose === 'entry');
  assert.equal(entries.length, 1, `status: ${JSON.stringify(engine.status.get(market.ticker))}`);
  assert.equal(entries[0].count, 1);
  // Spot above the strike: the model favours YES, bought at the ask.
  assert.equal(entries[0].side, 'bid');
  assert.equal(entries[0].price, 0.6);
  // One per contract: a second pass does not add another.
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.55, size: 50 }], asks: [{ price: 0.6, size: 50 }] }, Date.now());
  await engine.tick();
  assert.equal(oms.allOrders().filter((o) => o.ticker === market.ticker && o.purpose === 'entry').length, 1);
});

test('paper prices from Coinbase spot when the Kalshi index is stale or too sparse for volatility', async () => {
  const { engine, recon, market, md } = await setup();
  const r = await recon.run('startup');
  engine.balance = r!.balance;
  const now = Date.now();
  (md.index.get('BTC') as any).points.forEach((p: { ts: number }) => { p.ts -= 120_000; });
  const spot = md.spot.get('BTC')!;
  let x = Math.log(60010);
  for (let sec = 600; sec >= 0; sec--) { x += 0.0001 * Math.sin(sec); spot.add(Math.exp(x), now - sec * 1000); }
  await engine.tick();
  const st = engine.status.get(market.ticker)!;
  assert.equal(st.blocked, undefined, JSON.stringify(st));
  assert.ok(Math.abs(st.spot! - 60010) < 50);
});

test('paper prices from Binance when both the Kalshi index and Coinbase are stale (sparse prints)', async () => {
  const { engine, recon, market, md } = await setup();
  const r = await recon.run('startup');
  engine.balance = r!.balance;
  const now = Date.now();
  (md.index.get('BTC') as any).points.forEach((p: { ts: number }) => { p.ts -= 120_000; });
  md.spot.get('BTC')!.add(59000, now - 90_000); // Coinbase quiet for 90 s
  const bn = md.binance.get('BTC')!;
  let x = Math.log(60020);
  for (let sec = 600; sec >= 0; sec--) { x += 0.0001 * Math.cos(sec); bn.add(Math.exp(x), now - sec * 1000); }
  await engine.tick();
  const st = engine.status.get(market.ticker)!;
  assert.equal(st.blocked, undefined, JSON.stringify(st));
  assert.ok(Math.abs(st.spot! - 60020) < 60, `priced from Binance (${st.spot})`);
  assert.ok(engine.feedHealth().BTC.binance!.points > 500);
});

test('market data: Binance prices are copied into their own series, new prints only', async () => {
  const { md } = await setup();
  const prices = new Map([['BTC', { price: 61000, ts: 1000 }]]);
  (md as any).dominance = { priceOf: (s: string) => prices.get(s) };
  md.pullBinance();
  md.pullBinance(); // same print: not duplicated
  assert.equal(md.binance.get('BTC')!.health(2000).points, 1);
  prices.set('BTC', { price: 61010, ts: 2000 });
  md.pullBinance();
  assert.equal(md.binance.get('BTC')!.latest()!.value, 61010);
});

test('paper: an up/down strike comes from the Coinbase opening minute when the Kalshi index missed it', async () => {
  const { md, market } = await setup();
  const am = md.markets.get(market.ticker)!;
  am.strike = undefined;
  (md.index.get('BTC') as any).points.length = 0;
  assert.equal(md.strikeFor(am), undefined);
  const spot = md.spot.get('BTC')!;
  for (let t = market.openTime - 90_000; t <= market.openTime + 5_000; t += 5_000) spot.add(60123, t);
  assert.equal(md.strikeFor(am), 60123);
  assert.equal(am.strikeSource, 'computed');
});

test('live-style limits: paper tolerates late feed data, live does not', () => {
  const paper = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40) });
  assert.equal(paper.risk.maxIndexAgeMs, 15000);
  assert.equal(paper.risk.maxBookAgeMs, 30000);
});

test('no orders until reconciliation is clean and balance known', async () => {
  const { engine, paper } = await setup();
  await engine.tick();
  assert.equal((await paper.getOpenOrders()).length, 0);
});

test('daily loss limit trips the persistent kill switch and cancels everything', async () => {
  const { engine, recon, paper, kill, oms, market } = await setup({ dailyLossUsd: '0.5' });
  const r = await recon.run('startup');
  engine.balance = r!.balance;
  await engine.tick();
  assert.ok((await paper.getOpenOrders()).length >= 1);
  // Simulate a realized loss today.
  oms.onFill({ tradeId: 'L', orderId: '', ticker: 'OTHER', side: 'bid', count: 2, price: 0.5, isTaker: true, fee: 0.02, ts: Date.now() }, { closeTs: Date.now() - 1, asset: 'BTC' });
  oms.settle('OTHER', 'no');
  await engine.tick();
  assert.equal(kill.engaged, true);
  assert.equal((await paper.getOpenOrders()).length, 0);
  assert.ok(engine.status.get(market.ticker));
});

test('opt-in confluence ratchet runs in the engine and starts in fair-value mode', async () => {
  const { engine, recon, market, cfg } = await setup({ exitPolicy: 'confluence_ratchet' });
  assert.equal(cfg.strategy.exitPolicy, 'confluence_ratchet');
  const r = await recon.run('startup');
  engine.balance = r!.balance;
  await engine.tick();
  // No position and no confluence data: normal fair-value behaviour, quotes still placed.
  assert.equal(engine.status.get(market.ticker)!.exitMode, 'fair_value');
});

test('vault and pocket are excluded from the tradable bankroll; wins feed the vault', async () => {
  const vault = new Vault({ enabled: true, quotaUsd: 100, winShare: 0.5, pocketShare: 0.1, quotaReset: 'session', dailyGoalUsd: 100 });
  const { engine, recon, oms } = await setup({ vault, monitor: new BalanceMonitor() });
  const r = await recon.run('startup');
  engine.onBalance(r!.balance!);
  assert.equal(engine.bankroll(), 200);
  // A settled win of $10 (fee-inclusive): $5 vaulted.
  oms.onFill({ tradeId: 'w', orderId: '', ticker: 'W', side: 'bid', count: 20, price: 0.5, isTaker: false, fee: 0, ts: Date.now() }, { closeTs: Date.now() - 1, asset: 'BTC' });
  oms.settle('W', 'yes');
  assert.equal(vault.vaultTotal, 5);
  assert.equal(engine.bankroll(), 195);
});

test('a manually recorded withdrawal is not counted again by the detector', async () => {
  const vault = new Vault({ enabled: true, quotaUsd: 100, winShare: 0.5, pocketShare: 0.1, quotaReset: 'session', dailyGoalUsd: 100 });
  const monitor = new BalanceMonitor();
  const { engine } = await setup({ vault, monitor });
  engine.onBalance(200);
  engine.recordWithdrawal(30, 'test');
  // Kalshi now reports the lower balance on consecutive checks: nothing new is booked.
  engine.onBalance(170);
  engine.onBalance(170);
  assert.equal(vault.status().withdrawnTotal, 30);
});

test('no new risk below the $10 hard floor; $20 trades on the aggressive tier', async () => {
  const { engine, recon, paper } = await setup();
  await recon.run('startup');
  engine.balance = 8;
  assert.ok(engine.haltReasons().some((r) => r.includes('below the $10 minimum')));
  await engine.tick();
  assert.equal((await paper.getOpenOrders()).length, 0);
  engine.balance = 18; // e.g. $20 after one $2 loss: still trading
  assert.ok(!engine.haltReasons().some((r) => r.includes('minimum')));
  engine.balance = 20;
  const g = engine.guardStatus();
  assert.equal(g.tier.name, 'aggressive');
  assert.equal(g.tier.orderRiskUsd, 2);
  assert.equal(g.tier.dailyLossLimitUsd, 4);
});

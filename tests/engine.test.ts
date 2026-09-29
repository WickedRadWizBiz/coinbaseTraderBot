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

async function setup(opts: { dailyLossUsd?: string } = {}) {
  const dir = tmpDir();
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), DATA_DIR: dir, RISK_DAILY_LOSS_USD: opts.dailyLossUsd ?? '10', DOMINANCE_FEED: 'false', SPOT_FEED: 'false' });
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
  const engine = new Engine({ cfg, audit, alerter: new Alerter([], audit), md, gateway: paper, oms, risk: new RiskGateway(cfg.risk), kill, recon, model: MetaModel.identity() });
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
  // Stale index: quotes are pulled (fail closed), not left resting.
  md.index.get('BTC')!.add(60000, Date.now() - 1); // no-op: out of order
  const idx = md.index.get('BTC')!;
  (idx as any).points.forEach((p: { ts: number }) => { p.ts -= 60_000; });
  await engine.tick();
  assert.equal((await paper.getOpenOrders()).length, 0);
  assert.equal(engine.status.get(market.ticker)!.blocked, 'index stale');
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

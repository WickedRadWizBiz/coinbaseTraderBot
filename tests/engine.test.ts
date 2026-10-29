import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { Alerter } from '../bot/alerts/alerter';
import { loadConfig } from '../bot/config';
import { Engine } from '../bot/engine';
import type { KalshiRest } from '../bot/kalshi/rest';
import type { MarketInfo } from '../bot/kalshi/types';
import { MarketData, Recorder } from '../bot/marketdata/marketData';
import { MetaModel } from '../bot/model/metaModel';
import { FEATURE_NAMES } from '../bot/model/features';
import { Oms } from '../bot/oms/oms';
import { PaperExchange } from '../bot/paper/paperExchange';
import { KillSwitch } from '../bot/risk/killSwitch';
import { RiskGateway } from '../bot/risk/riskGateway';
import { Reconciler } from '../bot/recon/reconciler';
import { openExchange, tmpAudit, tmpDir } from './helpers';
import { Vault } from '../bot/vault/vault';
import { LiveLines, type LiveLineReading } from '../bot/strategy/liveLine';
import { ComponentTrials, DEFAULT_TRIALS, type TrialName } from '../bot/strategy/componentTrials';
import type { TaNetView } from '../bot/strategy/taConviction';
import { BalanceMonitor } from '../bot/vault/balanceMonitor';
import { SinuousEntryGate, type EntryVerdict } from '../bot/strategy/sinuousEntry';
import { AccuracyGate } from '../bot/strategy/accuracyGate';
import { SinuousExitGate, type CrossCheck } from '../bot/strategy/sinuousExit';
import { TakeProfitBench } from '../bot/strategy/takeProfitBench';

async function setup(opts: { askSize?: number; dailyLossUsd?: string; exitPolicy?: string; vault?: Vault; monitor?: BalanceMonitor; env?: Record<string, string>; trend?: number; curveExit?: SinuousExitGate; takeProfitBench?: TakeProfitBench; curveEntry?: SinuousEntryGate; accuracyGate?: AccuracyGate; liveLines?: LiveLines; trials?: ComponentTrials; model?: MetaModel } = {}) {
  const dir = tmpDir();
  // The exit tests were written against the ratchet policy and the 1c margin (the defaults until Oct 29; the fallback is now the
  // model exit at a 4c margin).
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), DATA_DIR: dir, RISK_DAILY_LOSS_USD: opts.dailyLossUsd ?? '10', DOMINANCE_FEED: 'false', SPOT_FEED: 'false', EXIT_POLICY: opts.exitPolicy ?? 'confluence_ratchet', STRATEGY_EXIT_MARGIN: '0.01', STRATEGY_SERIES: 'KXBTC15M', SESSION_EDGE_NO_ENTRY: 'false', TENNIS_ENABLED: 'false', ...opts.env });
  const now = Date.now();
  const market: MarketInfo = { ticker: 'KXBTC15M-TEST', seriesTicker: 'KXBTC15M', status: 'open', openTime: now - 300_000, closeTime: now + 600_000, floorStrike: 60000, tickSize: 0.01 };
  const rest = {
    getSeriesFees: async () => ({ feeType: 'quadratic', multiplier: 1 }),
    getOpenMarkets: async () => [market],
    getMarket: async () => market,
  } as unknown as KalshiRest;
  const audit = tmpAudit();
  const md = new MarketData(cfg, rest, undefined, new Recorder(path.join(dir, 'rec')));
  await md.refreshCatalog(now);
  // Fresh book and a warmed-up index slightly above the strike.
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.45, size: 50 }], asks: [{ price: 0.6, size: opts.askSize ?? 50 }] }, now);
  const idx = md.index.get('BTC')!;
  let seed = 1;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  let x = Math.log(60010);
  const span = opts.trend ? 1800 : 600;
  if (opts.trend) x -= opts.trend * span; // end just above the strike, as without a trend
  for (let s = span; s >= 0; s--) { x += (opts.trend ? 0.00004 : 0.0002) * (rand() - 0.5) + (opts.trend ?? 0); idx.add(Math.exp(x), now - s * 1000); }

  const paper = new PaperExchange(undefined, 200, (t) => md.books.get(t), () => ({ takerMultiplier: 1, makerMultiplier: 0 }));
  const kill = new KillSwitch(path.join(dir, 'kill.json'), audit);
  const oms = new Oms({ gateway: paper, audit, statePath: path.join(dir, 'oms.json'), feesFor: (t) => md.feesFor(t), sleep: async () => undefined });
  kill.bindCancelAll((r) => oms.cancelAll(r));
  paper.on('fill', (f) => oms.onFill(f));
  paper.on('order', (o) => oms.onExchangeOrder(o));
  const recon = new Reconciler({ gateway: paper, oms, audit, getMarket: rest.getMarket, onPersistentBreak: (r) => void kill.engage(r, 'recon') });
  const engine = new Engine({ cfg, audit, alerter: new Alerter([], audit), md, gateway: paper, oms, risk: new RiskGateway(cfg.risk), kill, recon, model: opts.model ?? MetaModel.identity(), vault: opts.vault, balanceMonitor: opts.monitor, exchangeStatus: openExchange(), curveExit: opts.curveExit, takeProfitBench: opts.takeProfitBench, curveEntry: opts.curveEntry, accuracyGate: opts.accuracyGate, liveLines: opts.liveLines, trials: opts.trials });
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

/** An entry curve whose verdict the test sets: YES bids against it or not. */
class StubCurve extends SinuousEntryGate {
  againstYes = false;
  override verdict(_ticker: string, side: 'bid' | 'ask'): EntryVerdict {
    return side === 'bid' && this.againstYes ? { against: true, slope: -0.012 } : { against: false, slope: 0 };
  }
}

test('entry curve gate: no YES bid while the book runs against it, and a resting one is pulled; monitor only notes it', async () => {
  const quotes = (oms: Oms, ticker: string, side: 'bid' | 'ask') => oms.liveOrders().filter((o) => o.ticker === ticker && o.side === side && o.purpose === 'quote' && !o.cancelRequested);
  const gate = new StubCurve({ mode: 'gate', slope: 0.005 });
  const g = await setup({ curveEntry: gate });
  g.engine.balance = (await g.recon.run('startup'))!.balance;
  await g.engine.tick();
  assert.equal(quotes(g.oms, g.market.ticker, 'bid').length, 1, `with the curve the bid rests: ${JSON.stringify(g.engine.status.get(g.market.ticker)?.notes)}`);
  gate.againstYes = true;
  await g.engine.tick();
  assert.equal(quotes(g.oms, g.market.ticker, 'bid').length, 0, 'against it: pulled');
  assert.match(g.engine.status.get(g.market.ticker)!.notes.join(' | '), /entry curve holds the YES bid: the book runs 1\.20c a 10 s against it/);
  // Monitor mode: the same verdict is only a note; the bid goes out.
  const watch = new StubCurve({ mode: 'monitor', slope: 0.005 });
  watch.againstYes = true;
  const m = await setup({ curveEntry: watch });
  m.engine.balance = (await m.recon.run('startup'))!.balance;
  await m.engine.tick();
  assert.equal(quotes(m.oms, m.market.ticker, 'bid').length, 1);
  assert.match(m.engine.status.get(m.market.ticker)!.notes.join(' | '), /entry curve would hold the YES bid/);
  assert.equal(m.engine.curveEntryStatus()!.mode, 'monitor');
});

test('until a vol forecast is validated, fair value prices with the EWMA sigma x VOL_FALLBACK_MULT (1.15 by default)', async () => {
  for (const [env, mult] of [[{}, 1.15], [{ VOL_FALLBACK_MULT: '1' }, 1]] as const) {
    const { engine, recon, market } = await setup({ env });
    const r = await recon.run('startup');
    engine.balance = r!.balance;
    await engine.tick();
    const st = engine.status.get(market.ticker)!;
    assert.ok(Math.abs(st.sigmaPricing! / st.sigma! - mult) < 1e-9, `sigma ${st.sigma} priced at ${st.sigmaPricing}`);
    assert.equal(engine.guardStatus().volFallbackMult, mult);
  }
});

test('an order is funded from its market\'s exchange shard: no cash there, no order, and the refusal says where the cash is', async () => {
  const { engine, recon, paper, market, md, audit } = await setup();
  const r = await recon.run('startup');
  engine.balance = r!.balance;
  // Crypto markets trade on shard 2; the account's cash sits on shard 0 (the Kalshi app moves it per order, the API does not).
  md.markets.get(market.ticker)!.exchangeIndex = 2;
  (paper as unknown as { shardBalances: () => Record<number, number> }).shardBalances = () => ({ 0: r!.balance!, 2: 0 });
  assert.equal(engine.freeCash(2), 0);
  assert.equal(engine.freeCash(), r!.balance);
  await engine.tick();
  assert.equal((await paper.getOpenOrders()).length, 0);
  const why = audit.tail(200, 'risk_reject').map((x) => JSON.stringify(x.data)).join('\n');
  assert.match(why, /free cash \$0\.00 on Kalshi exchange shard 2/);
  assert.match(why, /kalshi\.com\/account\/exchange-indexes/);
  // Cash on the market's shard: the quote goes out.
  const f = await setup();
  const r2 = await f.recon.run('startup');
  f.engine.balance = r2!.balance;
  f.md.markets.get(f.market.ticker)!.exchangeIndex = 2;
  (f.paper as unknown as { shardBalances: () => Record<number, number> }).shardBalances = () => ({ 0: 0, 2: r2!.balance! });
  await f.engine.tick();
  assert.ok((await f.paper.getOpenOrders()).length >= 1);
});

test('a location-attestation refusal on a tennis order pauses tennis only; on any other order, all new orders', async () => {
  const { engine, oms, cfg } = await setup();
  await engine.start();
  try {
    const msg = 'HTTP 403: {"error":{"code":"Your_location_attestation_for_API_trading_is_missing_or_expired."}}';
    oms.emit('account_blocked', msg, { ticker: `${cfg.tennis.series[0]}-26OCT22ABCDEF-ABC` });
    assert.match(engine.kalshiAccountStatus().sportsHalt ?? '', /tennis/);
    assert.ok(!engine.haltReasons().some((r) => /location/.test(r)), 'crypto keeps trading');
    oms.emit('account_blocked', msg, { ticker: 'KXBTC15M-TEST' });
    assert.ok(engine.haltReasons().some((r) => /location attestation/.test(r)));
  } finally { engine.stop(); }
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

test('paper (PAPER_OUTSIDE_PRICE_FALLBACK=true) prices from Coinbase spot when the Kalshi index is stale or too sparse for volatility', async () => {
  const { engine, recon, market, md } = await setup({ env: { PAPER_OUTSIDE_PRICE_FALLBACK: 'true' } });
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

test('paper (PAPER_OUTSIDE_PRICE_FALLBACK=true) prices from Binance when both the Kalshi index and Coinbase are stale (sparse prints)', async () => {
  const { engine, recon, market, md } = await setup({ env: { PAPER_OUTSIDE_PRICE_FALLBACK: 'true' } });
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

test('paper (PAPER_OUTSIDE_PRICE_FALLBACK=true): an up/down strike comes from the Coinbase opening minute when the Kalshi index missed it', async () => {
  const { md, market } = await setup({ env: { PAPER_OUTSIDE_PRICE_FALLBACK: 'true' } });
  const am = md.markets.get(market.ticker)!;
  am.strike = undefined;
  (md.index.get('BTC') as any).points.length = 0;
  assert.equal(md.strikeFor(am), undefined);
  const spot = md.spot.get('BTC')!;
  for (let t = market.openTime - 90_000; t <= market.openTime + 5_000; t += 5_000) spot.add(60123, t);
  assert.equal(md.strikeFor(am), 60123);
  assert.equal(am.strikeSource, 'computed');
});

test('paper uses live\'s stale-data limits (a 5 s book, a 3 s index)', () => {
  const paper = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40) });
  assert.equal(paper.risk.maxIndexAgeMs, 3000);
  assert.equal(paper.risk.maxBookAgeMs, 5000);
});

test('paper: an order live would not have sent is tagged at its first fill, for the live-equivalent P&L', async () => {
  // No probation is set in tests and the identity model has no validation report: with the model gating live orders
  // (LIVE_ALLOW_UNVALIDATED_MODEL=false), live would reject every entry.
  const { engine, recon, paper, market, audit } = await setup({ env: { PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false', LIVE_ALLOW_UNVALIDATED_MODEL: 'false' } });
  engine.balance = (await recon.run('startup'))!.balance;
  await engine.tick();
  const o = (await paper.getOpenOrders())[0];
  assert.ok(o, 'a maker quote rests');
  assert.equal(audit.tail(50, 'paper_live_block').length, 0, 'nothing is written before a fill');
  // A taker trades through it.
  if (o.side === 'bid') paper.onTrade(market.ticker, +(o.price - 0.01).toFixed(2), 100, 'no');
  else paper.onTrade(market.ticker, +(o.price + 0.01).toFixed(2), 100, 'yes');
  const tags = audit.tail(50, 'paper_live_block').map((r) => r.data as { clientOrderId: string; reasons: string[] });
  assert.deepEqual(tags, [{ clientOrderId: o.clientOrderId, reasons: ['model not validated, probation benched'] }]);
});

test('paper: by default live sends what an unvalidated model wants, so nothing is tagged for it', async () => {
  const { engine, recon, paper, market, audit } = await setup({ env: { PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false' } });
  engine.balance = (await recon.run('startup'))!.balance;
  await engine.tick();
  const o = (await paper.getOpenOrders())[0];
  assert.ok(o, 'a maker quote rests');
  if (o.side === 'bid') paper.onTrade(market.ticker, +(o.price - 0.01).toFixed(2), 100, 'no');
  else paper.onTrade(market.ticker, +(o.price + 0.01).toFixed(2), 100, 'yes');
  assert.equal(audit.tail(50, 'paper_live_block').length, 0);
});

test('paper, like live: no new entry in a series until its fee schedule is verified; an exit still goes out', async () => {
  const { engine, recon, paper, market, md, oms } = await setup();
  engine.balance = (await recon.run('startup'))!.balance;
  // The series reports a fee type the published schedule does not define as a formula.
  md.feeBook.setSeries(market.seriesTicker, { feeType: 'flat', multiplier: 1 }, Date.now());
  await engine.tick();
  assert.equal((await paper.getOpenOrders()).length, 0);
  const st = engine.status.get(market.ticker)!;
  assert.equal(st.blocked, undefined);
  assert.match(st.feeBlock ?? '', /fee type flat is not a formula the fee schedule defines/);
  // Long 10 NO bought at 0.40; the market bids NO 0.20, above the model's value: cutting the loser goes out.
  oms.onFill({ tradeId: 'fx1', orderId: '', ticker: market.ticker, side: 'ask', count: 10, price: 0.6, isTaker: true, fee: 0.17, ts: Date.now() }, { closeTs: market.closeTime, asset: 'BTC' });
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.78, size: 50 }], asks: [{ price: 0.8, size: 50 }] }, Date.now());
  await engine.tick();
  assert.equal(oms.allOrders(500).filter((o) => o.ticker === market.ticker && o.reduceOnly).length, 1, engine.status.get(market.ticker)!.notes.join(' | '));
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

test('exit curve: a profitable fair-value exit waits for a spike above the curve', async () => {
  const curveExit = new SinuousExitGate({ mode: 'gate', minNetProfit: 0.015 }, { minTrades: 20, t: 1, maxLossUsd: 25, window: 200 });
  const { engine, recon, market, md, oms } = await setup({ curveExit });
  const r = await recon.run('startup');
  engine.balance = r!.balance;
  // Long 10 NO bought at 0.05 (YES sold at 0.95). The model values NO near 0.01 while the market bids it 0.20:
  // the fair-value exit wants out, at a profit, so it waits for the curve.
  oms.onFill({ tradeId: 'e1', orderId: '', ticker: market.ticker, side: 'ask', count: 10, price: 0.95, isTaker: true, fee: 0.04, ts: Date.now() }, { closeTs: market.closeTime, asset: 'BTC' });
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.78, size: 50 }], asks: [{ price: 0.8, size: 50 }] }, Date.now());
  const exits = () => oms.allOrders(500).filter((o) => o.ticker === market.ticker && o.reduceOnly);
  await engine.tick();
  const st = engine.status.get(market.ticker)!;
  assert.equal(st.position, -10);
  assert.equal(exits().length, 0, `held: ${st.notes.join(' | ')}`);
  assert.equal(st.curve?.signal, false);
  assert.ok(st.notes.some((n) => /curve: holding the profit exit at 0.2 /.test(n)), st.notes.join(' | '));
  assert.deepEqual(curveExit.status().holding, [market.ticker]);
  // A sweep into NO (YES offered heavily lower): the NO micro-price jumps well above the curve, and the exit goes out.
  await new Promise((res) => setTimeout(res, 20));
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.6, size: 10 }], asks: [{ price: 0.62, size: 500 }] }, Date.now());
  await engine.tick();
  const st2 = engine.status.get(market.ticker)!;
  assert.equal(st2.curve?.reason, 'DEVIATION_SPIKE', JSON.stringify(st2.curve));
  assert.equal(exits().length, 1, st2.notes.join(' | '));
  assert.ok(st2.notes.some((n) => /curve DEVIATION_SPIKE: profit exit at 0.38/.test(n)), st2.notes.join(' | '));
  assert.deepEqual(curveExit.status().holding, []);
});

/** An exit curve in rest mode whose swing-top estimate the test sets. */
class StubRest extends SinuousExitGate {
  target: number | undefined = 0.55;
  override restTarget(): number | undefined { return this.target; }
}

test('exit curve rest mode: the held position rests its sell at the curve target; an exit crossing the book pulls it', async () => {
  const curveExit = new StubRest({ mode: 'rest', minNetProfit: 0.015 }, { minTrades: 20, t: 1, maxLossUsd: 25, window: 200 });
  const { engine, recon, market, md, oms, audit } = await setup({ curveExit, env: { PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false' } });
  engine.balance = (await recon.run('startup'))!.balance;
  // Long 10 YES bought at 0.40 as a maker: the take-profit floor is 4c, so never below 0.44.
  oms.onFill({ tradeId: 'r1', orderId: '', ticker: market.ticker, side: 'bid', count: 10, price: 0.4, isTaker: false, fee: 0, ts: Date.now() }, { closeTs: market.closeTime, asset: 'BTC' });
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.45, size: 50 }], asks: [{ price: 0.6, size: 50 }] }, Date.now());
  const sells = () => oms.liveOrders().filter((o) => o.ticker === market.ticker && o.side === 'ask' && o.purpose === 'exit' && o.timeInForce === 'good_till_canceled' && !o.cancelRequested);
  await engine.tick();
  const notes = () => engine.status.get(market.ticker)!.notes.join(' | ');
  assert.deepEqual(sells().map((o) => [o.price, o.count, o.postOnly, o.reduceOnly]), [[0.55, 10, true, false]], notes());
  const why = audit.tail(50, 'decision').flatMap((d) => ((d.data as { place?: Array<{ why: string }> }).place ?? []).map((p) => p.why));
  assert.ok(why.some((w) => /^exit curve: rest 0\.55 \(\+0\.150 a contract net, swing top 0\.550\)/.test(w)), why.join(' | '));
  // The bid runs to 0.80 (a book jump without trades, so the resting sell is not filled here): the take-profit arms and
  // the winner runs.
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.8, size: 50 }], asks: [{ price: 0.82, size: 50 }] }, Date.now());
  await engine.tick();
  assert.equal(sells().length, 1, notes());
  // Back to 0.60, more than a third of the best gain given back: the take-profit crosses the book, and the resting sell
  // is pulled first so the two cannot sell more than is held.
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.6, size: 50 }], asks: [{ price: 0.62, size: 50 }] }, Date.now());
  await engine.tick();
  assert.equal(sells().length, 0, notes());
  assert.equal(oms.allOrders(500).filter((o) => o.ticker === market.ticker && o.reduceOnly && o.timeInForce === 'immediate_or_cancel').length, 1, notes());
});

/** An exit curve in rest mode whose cross the test arms: it records what the engine asked and sells on a turned spot. */
class StubCross extends StubRest {
  armed = false;
  asked: CrossCheck[] = [];
  override cross(_ticker: string, e: CrossCheck): { sell: boolean; why?: string } {
    this.asked.push(e);
    return this.armed && e.spot === 'against' ? { sell: true, why: `exit curve: cross ${e.sidePrice} (+0.010 a contract net, curve 0.5 under projection 0.6, spot against)` } : { sell: false };
  }
}

test('exit curve rest mode, the cross: a turned spot sells at the bid at once and pulls the resting sell', async () => {
  const curveExit = new StubCross({ mode: 'rest', minNetProfit: 0.015 }, { minTrades: 20, t: 1, maxLossUsd: 25, window: 200 });
  curveExit.target = 0.7;
  const { engine, recon, market, md, oms, audit } = await setup({ curveExit, env: { PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false' } });
  engine.balance = (await recon.run('startup'))!.balance;
  oms.onFill({ tradeId: 'x1', orderId: '', ticker: market.ticker, side: 'bid', count: 10, price: 0.4, isTaker: false, fee: 0, ts: Date.now() }, { closeTs: market.closeTime, asset: 'BTC' });
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.45, size: 50 }], asks: [{ price: 0.6, size: 50 }] }, Date.now());
  const notes = () => engine.status.get(market.ticker)!.notes.join(' | ');
  const resting = () => oms.liveOrders().filter((o) => o.ticker === market.ticker && o.purpose === 'exit' && o.timeInForce === 'good_till_canceled' && !o.cancelRequested);
  await engine.tick();
  assert.deepEqual(resting().map((o) => o.price), [0.7], notes());
  // What the engine asked: the side's bid, the whole position (the bid holds 50), the take-profit floor (4c on a 40c
  // contract) and the time to close.
  const first = curveExit.asked.at(-1)!;
  assert.deepEqual([first.sidePrice, first.count], [0.45, 10]);
  assert.ok(Math.abs(first.floor - 0.04) < 1e-9, String(first.floor));
  assert.ok(first.tauSec > 500 && first.tauSec <= 600, String(first.tauSec));
  // BTC drops 0.015% in the last five seconds (a quarter of a 5 s standard deviation is the noise floor; a fast move
  // would be twice one): against a YES position on an up/down contract.
  const idx = md.index.get('BTC')!;
  const pts = (idx as unknown as { points: Array<{ ts: number; value: number }> }).points;
  const cut = Date.now() + 200 - 5000;
  const ref = [...pts].reverse().find((p) => p.ts <= cut)!.value;
  idx.add(ref * Math.exp(-1.5e-4), Date.now());
  curveExit.armed = true;
  await engine.tick();
  assert.equal(curveExit.asked.at(-1)!.spot, 'against', notes());
  const iocs = oms.allOrders(500).filter((o) => o.ticker === market.ticker && o.reduceOnly && o.timeInForce === 'immediate_or_cancel');
  assert.deepEqual(iocs.map((o) => [o.side, o.price, o.count]), [['ask', 0.45, 10]], notes());
  assert.equal(resting().length, 0, 'the resting sell is pulled');
  const why = audit.tail(50, 'decision').flatMap((d) => ((d.data as { place?: Array<{ why: string }> }).place ?? []).map((p) => p.why));
  assert.ok(why.some((w) => /^exit curve: cross 0\.45 /.test(w)), why.join(' | '));
});

/** An exit curve in cross mode (paper's default) whose cross the test arms; its swing-top estimate is the real one. */
class StubCrossOnly extends SinuousExitGate {
  armed = false;
  override cross(ticker: string, e: CrossCheck, now: number): { sell: boolean; why?: string } {
    return this.armed ? { sell: true, why: `exit curve: cross ${e.sidePrice} (+0.010 a contract net, curve 0.5 under projection 0.6, spot against)` } : super.cross(ticker, e, now);
  }
}

test('exit curve cross mode (the default, paper and live): no sell rests at the swing top; the cross still sells at the bid', async () => {
  const curveExit = new StubCrossOnly({ mode: 'cross', minNetProfit: 0.015 }, { minTrades: 20, t: 1, maxLossUsd: 25, window: 200 });
  const { engine, recon, market, md, oms } = await setup({ curveExit, env: { PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false' } });
  engine.balance = (await recon.run('startup'))!.balance;
  // Long 10 YES bought at 0.40 on the (paper) exchange, so its sale can fill.
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.38, size: 50 }], asks: [{ price: 0.4, size: 50 }] }, Date.now());
  await oms.submit({ ticker: market.ticker, asset: 'BTC', windowCloseTs: market.closeTime, side: 'bid', price: 0.4, count: 10, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: false, purpose: 'entry', fairValue: 0.5, modelId: 'm', decisionId: 'e' });
  assert.equal(oms.positions.get(market.ticker)?.yes, 10);
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.45, size: 50 }], asks: [{ price: 0.6, size: 50 }] }, Date.now());
  const notes = () => engine.status.get(market.ticker)!.notes.join(' | ');
  const resting = () => oms.liveOrders().filter((o) => o.ticker === market.ticker && o.purpose === 'exit' && o.timeInForce === 'good_till_canceled' && !o.cancelRequested);
  for (let i = 0; i < 3; i++) await engine.tick();
  assert.deepEqual(resting(), [], notes());
  curveExit.armed = true;
  await engine.tick();
  const iocs = oms.allOrders(500).filter((o) => o.ticker === market.ticker && o.reduceOnly && o.timeInForce === 'immediate_or_cancel');
  assert.deepEqual(iocs.map((o) => [o.side, o.price, o.count]), [['ask', 0.45, 10]], notes());
  // Scored on its fill (10 sold at 0.45), paper and live alike: settled YES, holding would have paid $1 a contract.
  assert.equal(curveExit.status().crossesPending, 1);
  oms.settle(market.ticker, 'yes');
  const s = curveExit.status();
  assert.equal(s.scored, 1);
  assert.ok(s.netUsd < -5 && s.netUsd > -6, `(0.45 - fee - 1) x 10: ${s.netUsd}`);
});

test('exit curve on the live line: a break of the coin\'s line sells the held position at the bid', async () => {
  const curveExit = new SinuousExitGate({ mode: 'cross', minNetProfit: 0.015, crossSource: 'line' }, { minTrades: 20, t: 1, maxLossUsd: 25, window: 200 });
  class BrokenLine extends LiveLines {
    override read(_asset: string, orient: 1 | -1): LiveLineReading {
      return { price: 100, projected: 100.1, band: { lower: 100.04, upper: 100.16, k: 2, sec: 300 }, underSd: orient > 0 ? 2.6 : -2.6, slope: -0.4, breakSec: orient > 0 ? 2 : 0, broke: orient > 0 };
    }
  }
  const liveLines = new BrokenLine();
  const { engine, recon, market, md, oms, audit } = await setup({ curveExit, liveLines, env: { PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false' } });
  engine.balance = (await recon.run('startup'))!.balance;
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.38, size: 50 }], asks: [{ price: 0.4, size: 50 }] }, Date.now());
  await oms.submit({ ticker: market.ticker, asset: 'BTC', windowCloseTs: market.closeTime, side: 'bid', price: 0.4, count: 10, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: false, purpose: 'entry', fairValue: 0.5, modelId: 'm', decisionId: 'e' });
  // Far enough in profit to clear the take-profit floor (+10% of the 0.417 cost): the bid is 0.52.
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.52, size: 50 }], asks: [{ price: 0.54, size: 50 }] }, Date.now());
  await engine.tick();
  const st = engine.status.get(market.ticker)!;
  assert.equal(st.line?.broke, true, JSON.stringify(st.line));
  const exits = oms.allOrders(500).filter((o) => o.ticker === market.ticker && o.reduceOnly && o.timeInForce === 'immediate_or_cancel');
  assert.ok(exits.length >= 1, st.notes.join(' | '));
  assert.deepEqual([exits[0].side, exits[0].price], ['ask', 0.52]);
  const why = audit.tail(50, 'decision').flatMap((d) => ((d.data as { place?: Array<{ why: string }> }).place ?? []).map((p) => p.why));
  assert.ok(why.some((w) => /^exit curve: cross 0\.52 \(\+0\.\d+ a contract net, live line outside its wiggle band for 2 s \(2\.6 sd, band \+-2 sd of 300 s since the open\)\)$/.test(w)), why.join(' | '));
  assert.equal(curveExit.status().crossesPending, 1, 'scored on its fill');
});

test('exit curve on the live line, the sell signal off (the default): a break is noted, nothing is sold on it', async () => {
  const curveExit = new SinuousExitGate({ mode: 'cross', minNetProfit: 0.015, crossSource: 'line', cross: false }, { minTrades: 20, t: 1, maxLossUsd: 25, window: 200 });
  class BrokenLine extends LiveLines {
    override read(): LiveLineReading { return { price: 100, projected: 100.1, band: { lower: 100.04, upper: 100.16, k: 2, sec: 300 }, underSd: 2.6, slope: -0.4, breakSec: 2, broke: true }; }
  }
  const { engine, recon, market, md, oms } = await setup({ curveExit, liveLines: new BrokenLine(), env: { PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false' } });
  engine.balance = (await recon.run('startup'))!.balance;
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.38, size: 50 }], asks: [{ price: 0.4, size: 50 }] }, Date.now());
  await oms.submit({ ticker: market.ticker, asset: 'BTC', windowCloseTs: market.closeTime, side: 'bid', price: 0.4, count: 10, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: false, purpose: 'entry', fairValue: 0.5, modelId: 'm', decisionId: 'e' });
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.52, size: 50 }], asks: [{ price: 0.54, size: 50 }] }, Date.now());
  await engine.tick();
  const notes = engine.status.get(market.ticker)!.notes.join(' | ');
  assert.match(notes, /live line: outside its wiggle band for 2 s \(2\.6 sd; the cross would sell; it is off, SINUOUS_CROSS\)/);
  assert.equal(curveExit.status().crossesPending, 0, 'nothing sold on it');
});

test('exit curve: a cross whose order fills nothing is not scored', async () => {
  const curveExit = new StubCrossOnly({ mode: 'cross', minNetProfit: 0.015 }, { minTrades: 20, t: 1, maxLossUsd: 25, window: 200 });
  const { engine, recon, market, md, oms } = await setup({ curveExit, env: { PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false' } });
  engine.balance = (await recon.run('startup'))!.balance;
  oms.onFill({ tradeId: 'k2', orderId: '', ticker: market.ticker, side: 'bid', count: 10, price: 0.4, isTaker: false, fee: 0, ts: Date.now() }, { closeTs: market.closeTime, asset: 'BTC' });
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.45, size: 50 }], asks: [{ price: 0.6, size: 50 }] }, Date.now());
  // The paper exchange holds no position here (the fill above went to the bot's books only): it refuses the
  // reduce-only sale, as Kalshi would, so the cross order fills nothing.
  curveExit.armed = true;
  await engine.tick();
  const sent = oms.allOrders(500).filter((o) => o.ticker === market.ticker && o.reduceOnly);
  assert.equal(sent.length, 1, 'the cross order was sent');
  assert.equal(sent[0].filledCount, 0, sent[0].state);
  assert.equal(curveExit.status().crossesPending, 0);
});

test('exit curve: an exit at a loss goes out at once', async () => {
  const curveExit = new SinuousExitGate({ mode: 'gate', minNetProfit: 0.015 }, { minTrades: 20, t: 1, maxLossUsd: 25, window: 200 });
  const { engine, recon, market, md, oms } = await setup({ curveExit });
  const r = await recon.run('startup');
  engine.balance = r!.balance;
  // Long 10 NO bought at 0.40; the market bids NO 0.20, still above the model's value: cutting the loser never waits.
  oms.onFill({ tradeId: 'e2', orderId: '', ticker: market.ticker, side: 'ask', count: 10, price: 0.6, isTaker: true, fee: 0.17, ts: Date.now() }, { closeTs: market.closeTime, asset: 'BTC' });
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.78, size: 50 }], asks: [{ price: 0.8, size: 50 }] }, Date.now());
  await engine.tick();
  assert.equal(oms.allOrders(500).filter((o) => o.ticker === market.ticker && o.reduceOnly).length, 1, engine.status.get(market.ticker)!.notes.join(' | '));
  assert.deepEqual(curveExit.status().holding, []);
});

test('take-profit: a winner runs, then is sold once it gives back a third of its best gain', async () => {
  const { engine, recon, market, md, oms, audit } = await setup();
  const r = await recon.run('startup');
  engine.balance = r!.balance;
  // Long 10 YES bought at 0.40 as a maker: the floor is 10% of the 0.40 cost, 4c. At a 0.56 bid it is +16c less the
  // 1.8c taker fee, +14.2c net: armed, and a winner at its best runs. Back at 0.50 (+8.2c, more than a third of the best
  // given back) it is sold.
  oms.onFill({ tradeId: 'p1', orderId: '', ticker: market.ticker, side: 'bid', count: 10, price: 0.4, isTaker: false, fee: 0, ts: Date.now() }, { closeTs: market.closeTime, asset: 'BTC' });
  const exits = () => oms.allOrders(500).filter((o) => o.ticker === market.ticker && o.reduceOnly);
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.56, size: 50 }], asks: [{ price: 0.58, size: 50 }] }, Date.now());
  await engine.tick();
  const st = engine.status.get(market.ticker)!;
  assert.equal(exits().length, 0, st.notes.join(' | '));
  assert.ok(st.notes.some((n) => /^take-profit armed: \+0\.142 now, best \+0\.142/.test(n)), st.notes.join(' | '));
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.5, size: 50 }], asks: [{ price: 0.52, size: 50 }] }, Date.now());
  await engine.tick();
  assert.equal(exits().length, 1, engine.status.get(market.ticker)!.notes.join(' | '));
  assert.deepEqual([exits()[0].side, exits()[0].price, exits()[0].count], ['ask', 0.5, 10]);
  const why = audit.tail(50, 'decision').flatMap((d) => ((d.data as { place?: Array<{ why: string }> }).place ?? []).map((p) => p.why));
  assert.ok(why.some((w) => /^take-profit: \+0\.082 a contract net of fees \(best \+0\.142, floor \+0\.040\)/.test(w)), why.join(' | '));
});

test('take-profit bench: a take-profit sale is scored on its fill against holding to settlement; benched, the take-profit sells nothing', async () => {
  const rule = { minTrades: 30, t: 2, maxLossUsd: 25, window: 200 };
  const run = async (bench: TakeProfitBench) => {
    const g = await setup({ takeProfitBench: bench, env: { PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false' } });
    g.engine.balance = (await g.recon.run('startup'))!.balance;
    // Long 10 YES bought at 0.40 on the (paper) exchange, so the take-profit's sale can fill.
    g.md.book(g.market.ticker).applySnapshot({ bids: [{ price: 0.38, size: 50 }], asks: [{ price: 0.4, size: 50 }] }, Date.now());
    await g.oms.submit({ ticker: g.market.ticker, asset: 'BTC', windowCloseTs: g.market.closeTime, side: 'bid', price: 0.4, count: 10, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: false, purpose: 'entry', fairValue: 0.5, modelId: 'm', decisionId: 'e' });
    assert.equal(g.oms.positions.get(g.market.ticker)?.yes, 10);
    // Best 0.56, then back to 0.50: more than a third of the best gain given back.
    g.md.book(g.market.ticker).applySnapshot({ bids: [{ price: 0.56, size: 50 }], asks: [{ price: 0.58, size: 50 }] }, Date.now());
    await g.engine.tick();
    g.md.book(g.market.ticker).applySnapshot({ bids: [{ price: 0.5, size: 50 }], asks: [{ price: 0.52, size: 50 }] }, Date.now());
    await g.engine.tick();
    return { ...g, notes: () => g.engine.status.get(g.market.ticker)!.notes.join(' | '), exits: () => g.oms.allOrders(500).filter((o) => o.ticker === g.market.ticker && o.reduceOnly) };
  };
  const bench = new TakeProfitBench(true, rule);
  const g = await run(bench);
  assert.deepEqual(g.exits().map((o) => [o.side, o.price, o.count, o.filledCount]), [['ask', 0.5, 10, 10]], g.notes());
  assert.equal(bench.status().pending, 1);
  // Settled YES: holding would have paid $1 a contract; the sale got 0.50 less its taker fee.
  g.oms.settle(g.market.ticker, 'yes');
  const s = bench.status();
  assert.deepEqual([s.scored, s.pending], [1, 0]);
  assert.ok(s.netUsd < -5 && s.netUsd > -5.3, `(0.50 - fee - 1) x 10: ${s.netUsd}`);
  assert.equal(g.engine.takeProfitBenchStatus()?.scored, 1);
  // A bench already called (the take-profit cost $26 against holding): the same pull-back sells nothing.
  const benched = new TakeProfitBench(true, rule);
  for (let i = 0; i < 13; i++) { benched.filled(`M${i}`, 1, 0.81, 10, 0.01, i); benched.settled(`M${i}`, 'yes', i + 1); }
  const h = await run(benched);
  assert.equal(h.exits().length, 0, h.notes());
  assert.match(h.notes(), /take-profit benched: \+0\.\d+ now, best \+0\.\d+, not sold \(take-profit sales cost \$26\.00/);
  // The dashboard's reset lifts it.
  assert.equal(h.engine.resetTakeProfitBench(), true);
  assert.equal(benched.benched, undefined);
});

test('take-profit: the last tick above the floor goes out at once, the exit curve never holds it', async () => {
  const curveExit = new SinuousExitGate({ mode: 'gate', minNetProfit: 0.015 }, { minTrades: 20, t: 1, maxLossUsd: 25, window: 200 });
  const { engine, recon, market, md, oms } = await setup({ curveExit });
  const r = await recon.run('startup');
  engine.balance = r!.balance;
  // Long 10 YES at 0.40 (floor 4c). Best 0.48 (+6.2c), then 0.46 (+4.2c): within a tick of the floor, sold to lock it in.
  oms.onFill({ tradeId: 'p3', orderId: '', ticker: market.ticker, side: 'bid', count: 10, price: 0.4, isTaker: false, fee: 0, ts: Date.now() }, { closeTs: market.closeTime, asset: 'BTC' });
  const exits = () => oms.allOrders(500).filter((o) => o.ticker === market.ticker && o.reduceOnly);
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.48, size: 50 }], asks: [{ price: 0.5, size: 50 }] }, Date.now());
  await engine.tick();
  assert.equal(exits().length, 0, engine.status.get(market.ticker)!.notes.join(' | '));
  await new Promise((res) => setTimeout(res, 20));
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.46, size: 50 }], asks: [{ price: 0.48, size: 50 }] }, Date.now());
  await engine.tick();
  assert.equal(exits().length, 1, engine.status.get(market.ticker)!.notes.join(' | '));
  assert.equal(exits()[0].price, 0.46);
  assert.deepEqual(curveExit.status().holding, []);
});

test('an exit never trades against the bot\'s own resting quote (self-trade prevention would cancel it): the quote is pulled first', async () => {
  // PROFIT_GIVE_BACK=0: the take-profit sells as soon as the floor is reached, so the exit is due on the tick under test.
  const { engine, recon, market, md, oms, audit } = await setup({ env: { PROFIT_GIVE_BACK: '0' } });
  const r = await recon.run('startup');
  engine.balance = r!.balance;
  oms.onFill({ tradeId: 'p2', orderId: '', ticker: market.ticker, side: 'bid', count: 10, price: 0.5, isTaker: false, fee: 0, ts: Date.now() }, { closeTs: market.closeTime, asset: 'BTC' });
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.45, size: 50 }], asks: [{ price: 0.65, size: 50 }] }, Date.now());
  await engine.tick(); // the new position is evaluated: no exit at a loss of 5c
  // One of our quotes rests at 0.63, above where the exit will sell.
  const own = await oms.submit({ ticker: market.ticker, asset: 'BTC', windowCloseTs: market.closeTime, side: 'bid', price: 0.63, count: 2, timeInForce: 'good_till_canceled', postOnly: true, reduceOnly: false, purpose: 'quote', fairValue: 0.55, modelId: 'm', decisionId: 'd' });
  md.book(market.ticker).applySnapshot({ bids: [{ price: 0.62, size: 50 }], asks: [{ price: 0.65, size: 50 }] }, Date.now());
  await engine.tick();
  const exit = oms.allOrders(500).find((o) => o.ticker === market.ticker && o.reduceOnly);
  assert.ok(exit, engine.status.get(market.ticker)!.notes.join(' | '));
  assert.deepEqual([exit.side, exit.price], ['ask', 0.62]);
  const cancels = audit.tail(200, 'order_cancel_req').map((c) => c.data as { clientOrderId: string; reason: string });
  assert.ok(cancels.some((c) => c.clientOrderId === own.clientOrderId), `our 0.63 bid was pulled: ${JSON.stringify(cancels)}`);
  assert.ok(!['ACKED', 'PARTIALLY_FILLED'].includes(oms.get(own.clientOrderId)!.state), oms.get(own.clientOrderId)!.state);
  const seqOf = (kind: 'order_cancel_req' | 'order_new', pred: (d: Record<string, unknown>) => boolean) => audit.tail(400, kind).find((x) => pred(x.data as Record<string, unknown>))!.seq;
  assert.ok(seqOf('order_cancel_req', (d) => d.clientOrderId === own.clientOrderId) < seqOf('order_new', (d) => d.clientOrderId === exit.clientOrderId), 'pulled before the exit was sent');
});

test('vault and pocket are excluded from the tradable bankroll; wins feed the vault', async () => {
  // Live always keeps the vault out of the bankroll; paper does with VAULT_IN_PAPER (the same rule).
  const vault = new Vault({ enabled: true, quotaUsd: 100, winShare: 0.5, pocketShare: 0.1, quotaReset: 'session', dailyGoalUsd: 100 });
  const { engine, recon, oms } = await setup({ vault, monitor: new BalanceMonitor(), env: { VAULT_IN_PAPER: 'true' } });
  const r = await recon.run('startup');
  engine.onBalance(r!.balance!);
  assert.equal(engine.bankroll(), 200);
  // A settled win of $10 (fee-inclusive): $5 vaulted.
  oms.onFill({ tradeId: 'w', orderId: '', ticker: 'W', side: 'bid', count: 20, price: 0.5, isTaker: false, fee: 0, ts: Date.now() }, { closeTs: Date.now() - 1, asset: 'BTC' });
  oms.settle('W', 'yes');
  assert.equal(vault.vaultTotal, 5);
  assert.equal(engine.bankroll(), 195);
});

test('vault: a settled loss is won back before a later win is vaulted; the total starts at the account\'s net P&L', async () => {
  const vault = new Vault({ enabled: true, quotaUsd: 100, winShare: 0.5, pocketShare: 0.1, quotaReset: 'session', dailyGoalUsd: 100 });
  const { engine, recon, oms } = await setup({ vault, monitor: new BalanceMonitor(), env: { VAULT_IN_PAPER: 'true' } });
  const r = await recon.run('startup');
  engine.onBalance(r!.balance!);
  assert.equal(vault.status().realized?.total, 0, 'started at the first balance read (no break-even to be under)');
  // A $4 loss, then a $10 win: $6 of it is new profit, $3 vaulted.
  oms.onFill({ tradeId: 'l', orderId: '', ticker: 'L', side: 'bid', count: 8, price: 0.5, isTaker: false, fee: 0, ts: Date.now() }, { closeTs: Date.now() - 1, asset: 'BTC' });
  oms.settle('L', 'no');
  assert.equal(vault.status().realized?.total, -4);
  oms.onFill({ tradeId: 'w', orderId: '', ticker: 'W', side: 'bid', count: 20, price: 0.5, isTaker: false, fee: 0, ts: Date.now() }, { closeTs: Date.now() - 1, asset: 'BTC' });
  oms.settle('W', 'yes');
  assert.equal(vault.vaultTotal, 3);
  // A refilled paper pool (the training supervisor's noteCash) starts the total over.
  engine.noteCashFlow(50);
  assert.deepEqual([vault.status().realized?.total, vault.status().realized?.high], [0, 0]);
});

test('paper: the vault reserve leaves the bankroll, as in live (since Oct 28)', async () => {
  // The vault keeps half of every new realized high (before Oct 23's rule, half of every win and none of the losses:
  // by Oct 23 it held $343 of the $360 paper pool).
  const vault = new Vault({ enabled: true, quotaUsd: 100, winShare: 0.5, pocketShare: 0.1, quotaReset: 'session', dailyGoalUsd: 100 });
  const { engine, recon, oms } = await setup({ vault, monitor: new BalanceMonitor() });
  const r = await recon.run('startup');
  engine.onBalance(r!.balance!);
  oms.onFill({ tradeId: 'w', orderId: '', ticker: 'W', side: 'bid', count: 20, price: 0.5, isTaker: false, fee: 0, ts: Date.now() }, { closeTs: Date.now() - 1, asset: 'BTC' });
  oms.settle('W', 'yes');
  assert.equal(vault.vaultTotal, 5, 'still vaulted on the books');
  assert.equal(engine.bankroll(), 195, 'and not traded, in paper as in live');
});

test('paper size: by default paper sizes as live; PAPER_ORDER_FRAC buys a share of the bankroll; PAPER_ORDER_FRAC=0 with PAPER_ORDER_USD a fixed amount', async () => {
  const quote = (g: Awaited<ReturnType<typeof setup>>) => g.oms.liveOrders().find((o) => o.ticker === g.market.ticker && o.purpose === 'quote' && !o.cancelRequested && o.side === 'bid');
  const env = { PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false' };
  const run = async (extra: Record<string, string>) => {
    const g = await setup({ env: { ...env, ...extra } });
    g.engine.balance = (await g.recon.run('startup'))!.balance;
    await g.engine.tick();
    return { g, q: quote(g)!, notes: g.engine.status.get(g.market.ticker)?.notes ?? [] };
  };
  const near = (q: { count: number; price: number }, usd: number) => { const v = q.count * q.price; return v > usd - q.price - 0.05 && v <= usd + 1e-9; };
  // PAPER_ORDER_FRAC=0.1: 10% of the $200 account, $20 an order.
  const frac = await run({ PAPER_ORDER_FRAC: '0.1' });
  assert.ok(frac.q, JSON.stringify(frac.notes));
  assert.ok(near(frac.q, 20), `${frac.q.count} at ${frac.q.price}`);
  assert.match(frac.notes.join(' | '), /paper size: \$20\.00 an order \(10% of the bankroll, PAPER_ORDER_FRAC\)/);
  assert.equal(frac.g.engine.guardStatus().paperOrderFrac, 0.1);
  // The share follows the bankroll: 2.5% of $200 is $5; the account shrinking to $100 halves the order the same way.
  const half = await run({ PAPER_ORDER_FRAC: '0.025' });
  assert.ok(near(half.q, 5), `${half.q.count} at ${half.q.price}`);
  assert.equal(frac.g.engine.paperOrderUsd(100), 10);
  // PAPER_ORDER_FRAC=0: the fixed PAPER_ORDER_USD, whatever the account.
  const fixed = await run({ PAPER_ORDER_FRAC: '0', PAPER_ORDER_USD: '8' });
  assert.ok(near(fixed.q, 8), `${fixed.q.count} at ${fixed.q.price}`);
  assert.match(fixed.notes.join(' | '), /paper size: \$8 an order \(PAPER_ORDER_USD\)/);
  assert.equal(fixed.g.engine.paperOrderUsd(100), 8);
  // Both off (the default since Oct 28: paper sizes like live): the tier and break-even sizing of a $200 account, a few
  // dollars at most.
  const sized = await run({});
  assert.equal(sized.g.engine.paperOrderUsd(100), 0);
  assert.ok(sized.q.count * sized.q.price < 5, `${sized.q.count} at ${sized.q.price}`);
  assert.ok(sized.q.count < frac.q.count);
});

test('accuracy gate (paper): no new quote in a time-to-close bucket where the market mid called results better', async () => {
  const quote = (g: Awaited<ReturnType<typeof setup>>) => g.oms.liveOrders().find((o) => o.ticker === g.market.ticker && o.purpose === 'quote' && !o.cancelRequested);
  const env = { PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false' };
  // 50 settled 15-minute markets per bucket around 10 minutes out, where the mid leaned the right way and the bot sat at 0.5.
  const scorecard = (enabled: boolean) => {
    const gate = new AccuracyGate({ enabled, window: 150, minMarkets: 40 });
    for (let i = 0; i < 50; i++) for (const tau of [700, 520]) {
      const t = `KXETH15M-M${i}-${tau}`;
      gate.observe(t, tau, 0.5, i % 2 ? 0.65 : 0.35);
      gate.settle(t, i % 2 ? 'yes' : 'no');
    }
    return gate;
  };
  const g = await setup({ env, accuracyGate: scorecard(true) });
  g.engine.balance = (await g.recon.run('startup'))!.balance;
  await g.engine.tick();
  assert.equal(quote(g), undefined);
  const why = Object.keys(g.engine.entryDiagnosis().reasons);
  assert.ok(why.some((r) => /accuracy gate: the market has called results better (450-600|600-840) s before the close/.test(r)), why.join(' | '));
  assert.equal(g.engine.guardStatus().accuracyGate?.enforced, true);
  // ACCURACY_GATE=false: the scorecard is kept, the quote goes out.
  const off = await setup({ env, accuracyGate: scorecard(false) });
  off.engine.balance = (await off.recon.run('startup'))!.balance;
  await off.engine.tick();
  assert.ok(quote(off), JSON.stringify(off.engine.status.get(off.market.ticker)?.notes));
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

test('conviction: every evaluation records the TA overlay; the altcoin risk-on rule boosts a long entry 2.5x', async () => {
  // NON_ALTCOINS empty: the test market (BTC) counts as an altcoin.
  const base = await setup({ env: { PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false' } });
  let r = await base.recon.run('startup');
  base.engine.balance = r!.balance;
  await base.engine.tick();
  const st0 = base.engine.status.get(base.market.ticker)!;
  assert.ok(st0.conviction, 'conviction recorded');
  assert.equal(st0.taShift, 0, 'no TA network loaded: fair value untouched');
  assert.equal(st0.conviction!.alt.active, false);
  assert.match(st0.conviction!.alt.why, /not an altcoin|USDT\.D|RSI/);

  // PAPER_ORDER_FRAC=0 and PAPER_ORDER_USD=0: a paper order size is never boosted, and this test is about the boost.
  const alt = await setup({ trend: 0.000002, env: { NON_ALTCOINS: 'NONE', PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false', ADVERSARIAL_BOOST: 'false', PAPER_ORDER_USD: '0', PAPER_ORDER_FRAC: '0' } });
  const now = Date.now();
  // USDT.D falling over the last 20 minutes (with some noise for its volatility); the index rising (RSI > 50).
  let u = 5.0;
  for (let s = 1800; s >= 0; s -= 10) { u *= 1 - 0.00002 + 0.00001 * Math.sin(s); alt.md.usdtd.add(u, now - s * 1000); }
  r = await alt.recon.run('startup');
  alt.engine.balance = r!.balance;
  await alt.engine.tick();
  const st = alt.engine.status.get(alt.market.ticker)!;
  assert.equal(st.conviction!.alt.active, true, JSON.stringify(st.conviction));
  assert.ok(st.conviction!.priority >= 10, 'altcoin risk-on is selected first');
  assert.ok(st.notes.some((n) => /altcoin risk-on: .* x2\.5/.test(n)), JSON.stringify({ fv: st.fairValue, q: st.q, bid: st.bestBid, ask: st.bestAsk, blocked: st.blocked, ew: st.entryWindow, notes: st.notes }));
  assert.ok(st.notes.some((n) => /conviction x2\.50 on the YES entry: [\d.]+ -> [\d.]+ contracts/.test(n)), st.notes.join(' | '));
});

test('conviction: the adversary vetoes the altcoin boost on an entry it breaks', async () => {
  // Ask-heavy book: the tape attack breaks a YES entry, so it keeps its normal size.
  const alt = await setup({ trend: 0.000002, askSize: 5000, env: { NON_ALTCOINS: 'NONE', PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false' } });
  const now = Date.now();
  let u = 5.0;
  for (let s = 1800; s >= 0; s -= 10) { u *= 1 - 0.00002 + 0.00001 * Math.sin(s); alt.md.usdtd.add(u, now - s * 1000); }
  const r = await alt.recon.run('startup');
  alt.engine.balance = r!.balance;
  await alt.engine.tick();
  const st = alt.engine.status.get(alt.market.ticker)!;
  assert.equal(st.conviction!.alt.active, true, JSON.stringify(st.conviction));
  assert.ok(st.notes.some((n) => /adversary vetoed the x2\.5 boost \(tape/.test(n)), st.notes.join(' | '));
  assert.ok(!st.notes.some((n) => /conviction x2\.50 on the YES/.test(n)), st.notes.join(' | '));
});

test('idle evaluation: a market the bot is not in is re-evaluated every EVAL_IDLE_SEC, not every tick', async () => {
  const { engine, recon, market, oms, paper } = await setup({ env: { EVAL_IDLE_SEC: '30', STRATEGY_STYLE: 'taker', STRATEGY_MIN_EDGE: '0.5', PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false' } });
  const r = await recon.run('startup');
  engine.balance = r!.balance;
  await engine.tick();
  const first = engine.status.get(market.ticker)!.updatedTs;
  assert.equal((await paper.getOpenOrders()).length, 0, 'no order resting');
  assert.equal(oms.positions.position(market.ticker), 0);
  await new Promise((res) => setTimeout(res, 20));
  await engine.tick();
  assert.equal(engine.status.get(market.ticker)!.updatedTs, first, 'skipped: idle and evaluated moments ago');
});

test('contracts are priced on Kalshi data alone by default: a stale Kalshi index blocks, Coinbase does not stand in', async () => {
  const { engine, recon, market, md } = await setup();
  const r = await recon.run('startup');
  engine.balance = r!.balance;
  const now = Date.now();
  (md.index.get('BTC') as any).points.forEach((p: { ts: number }) => { p.ts -= 120_000; });
  const spot = md.spot.get('BTC')!;
  for (let sec = 600; sec >= 0; sec--) spot.add(60010 + Math.sin(sec), now - sec * 1000);
  await engine.tick();
  assert.equal(engine.status.get(market.ticker)!.blocked, 'index stale');
});

test('optimal f on the Kalshi pool: settled trades in trades.jsonl cap the stake per order (paper floors it)', async () => {
  const { cfg, engine } = await setup();
  const now = Date.now();
  // 150 settled markets at 50c with a 30 % win rate: no edge, so the history supports no stake.
  const lines = Array.from({ length: 150 }, (_, i) => JSON.stringify({ ts: now - (150 - i) * 3_600_000, ticker: `KXBTC15M-T${i}`, book: 'crypto', q: 0.6, cost: 0.5, count: 2, won: i % 10 < 3 }));
  fs.writeFileSync(path.join(cfg.dataDir, 'trades.jsonl'), lines.join('\n') + '\n');
  const f = engine.kalshiOptimalF('crypto', now);
  assert.equal(f.rep?.n, 150);
  assert.equal(f.rep?.cap, 0);
  assert.ok(f.cap > 0 && Math.abs(f.cap - cfg.optimalF.paperFloor * engine.tier().orderFrac) < 1e-12, 'paper: floored at a quarter of the per-order fraction');
  assert.equal(engine.kalshiOptimalF('tennis', now).rep?.n, 0, 'books are separate');
  assert.equal(engine.kalshiOptimalF('tennis', now).cap, Infinity, 'too few trades: no cap');
});

test('Kalshi data arriving late: quotes are pulled and nothing is sent until it catches up (paper and live)', async () => {
  const { engine, recon, paper, md, market } = await setup();
  const r = await recon.run('startup');
  engine.balance = r!.balance;
  await engine.tick();
  assert.ok((await paper.getOpenOrders()).length >= 1, 'quoting while the feed is current');
  let lag: number | undefined = 45_000;
  (md as any).kalshiFeedLagMs = () => lag;
  await engine.tick();
  assert.equal((await paper.getOpenOrders()).length, 0, 'resting quotes pulled');
  assert.match(engine.status.get(market.ticker)!.blocked!, /Kalshi data 45\.0 s behind/);
  assert.ok(engine.haltReasons().some((x) => /behind real time/.test(x)));
  lag = 40; // caught up
  // Time passes: an idle market is re-evaluated every EVAL_IDLE_SEC, and entries wait for the next cadence trigger.
  engine.status.get(market.ticker)!.updatedTs -= 10_000;
  (engine as any).cadence.forget(market.ticker);
  await engine.tick();
  assert.ok((await paper.getOpenOrders()).length >= 1, 'quoting again');
  assert.ok(!engine.haltReasons().some((x) => /behind real time/.test(x)));
});

test('paper: a balance move nobody made (a paper book started fresh) re-anchors the books without drawing the vault', async () => {
  const vault = new Vault({ enabled: true, quotaUsd: 100, winShare: 0.5, pocketShare: 0.1, quotaReset: 'session', dailyGoalUsd: 100 });
  const monitor = new BalanceMonitor();
  const { engine } = await setup({ vault, monitor });
  engine.onBalance(210.48);
  engine.onBalance(100);
  engine.onBalance(100);
  assert.equal(vault.status().withdrawnTotal, 0, 'not booked as a withdrawal');
  assert.equal(monitor.state.expected, 100, 'expected balance re-anchored');
});

test('component trials: a trial that passed moves the price in paper and live alike; every contract in its entry window is recorded', async () => {
  class Stub extends ComponentTrials {
    readonly onNames = new Set<TrialName>();
    readonly records: Array<[TrialName, string, number, number]> = [];
    override applied(name: TrialName): boolean { return this.onNames.has(name); }
    override record(name: TrialName, ticker: string, _asset: string, _close: number, pWith: number, pWithout: number): void { this.records.push([name, ticker, pWith, pWithout]); }
  }
  // The TA network's 1 h and 4 h calls, neither validated nor graded yet: today's tilt counts each at half.
  const view: TaNetView = { up1: 0.62, up4: 0.6 };
  const run = async (env: Record<string, string>, on: TrialName[]) => {
    const trials = new Stub(DEFAULT_TRIALS);
    for (const n of on) trials.onNames.add(n);
    const s = await setup({ trials, env: { PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false', ...env } });
    (s.engine as unknown as { taView: () => TaNetView }).taView = () => view;
    s.engine.balance = (await s.recon.run('startup'))!.balance;
    await s.engine.tick();
    return { st: s.engine.status.get(s.market.ticker)!, trials };
  };
  const off = await run({}, []);
  assert.ok(off.st.trials && off.st.trials.ta! > off.st.taShift! && off.st.taShift! > 0, `full ${off.st.trials?.ta}, today ${off.st.taShift}`);
  assert.deepEqual(off.st.trials!.applied, []);
  const rec = off.trials.records.filter(([n]) => n === 'ta');
  assert.ok(rec.length >= 1, 'the contract in its entry window is recorded');
  assert.ok(Math.abs(rec[0][3] - off.st.pModel!) < 1e-12 && Math.abs(rec[0][2] - (off.st.pModel! + off.st.trials!.ta!)) < 1e-4, 'scored with the full tilt against the meta-model\'s price');
  const on = await run({}, ['ta']);
  assert.ok(Math.abs(on.st.taShift! - on.st.trials!.ta!) < 1e-4 && on.st.taShift! > off.st.taShift! * 1.5, `paper prices with the full-weight tilt once its trial passed: ${on.st.taShift}`);
  assert.deepEqual(on.st.trials!.applied, ['ta']);
  // Live: the same passing trial moves live's price the same way (the owner, Oct 28: paper behaves as live).
  const key = path.join(tmpDir(), 'k.pem');
  fs.writeFileSync(key, 'x', { mode: 0o600 });
  const live = await run({ TRADING_MODE: 'live', KALSHI_KEY_ID: 'id', KALSHI_PRIVATE_KEY_PATH: key, KALSHI_ENV: 'prod', LIVE_TRADING_ACKNOWLEDGED: 'I_ACCEPT_REAL_MONEY_RISK' }, ['ta']);
  assert.ok(Math.abs(live.st.taShift! - on.st.taShift!) < 1e-6, `live ${live.st.taShift} vs paper with the trial ${on.st.taShift}`);
  assert.deepEqual(live.st.trials!.applied, ['ta']);
});

test('component trials: the trained model comes out of the price when its trial says so, in paper and live alike', async () => {
  class Stub extends ComponentTrials {
    readonly onNames = new Set<TrialName>();
    readonly records: Array<[TrialName, number, number]> = [];
    override applied(name: TrialName): boolean { return this.onNames.has(name); }
    override record(name: TrialName, _t: string, _a: string, _c: number, pWith: number, pWithout: number): void { this.records.push([name, pWith, pWithout]); }
  }
  // A trained model that leans YES: logit(p) = logit(fair value) + 0.4.
  const n = FEATURE_NAMES.length;
  const model = MetaModel.fromJson(JSON.stringify({ version: 'lean', kind: 'mlp', features: [...FEATURE_NAMES], referenceSigma: 5e-5, normalization: { mean: new Array(n).fill(0), std: new Array(n).fill(1) },
    layers: [{ weights: [[1, ...new Array(n - 1).fill(0)]], bias: [0.4], activation: 'linear' }] }));
  const run = async (env: Record<string, string>, on: TrialName[]) => {
    const trials = new Stub(DEFAULT_TRIALS);
    for (const x of on) trials.onNames.add(x);
    const s = await setup({ trials, model, env: { PAPER_TRAINING_TRADES_PER_HOUR: '0', PAPER_EXPLORE: 'false', ...env } });
    s.engine.balance = (await s.recon.run('startup'))!.balance;
    await s.engine.tick();
    return { st: s.engine.status.get(s.market.ticker)!, trials };
  };
  const lean = (st: { pModel?: number; fairValue?: number }) => Math.log(st.pModel! / (1 - st.pModel!)) - Math.log(st.fairValue! / (1 - st.fairValue!));
  const kept = await run({}, ['mlp']);
  assert.ok(Math.abs(lean(kept.st) - 0.4) < 1e-6, `the trained model prices paper: ${kept.st.pModel} vs ${kept.st.fairValue}`);
  const mlp = kept.trials.records.find(([x]) => x === 'mlp')!;
  assert.ok(Math.abs(mlp[1] - kept.st.pModel!) < 1e-12 && Math.abs(mlp[2] - kept.st.fairValue!) < 1e-12, 'scored against the math fair value');
  const out = await run({}, []);
  assert.ok(Math.abs(out.st.pModel! - out.st.fairValue!) < 1e-12, 'out of paper\'s price: the fair value alone');
  const key = path.join(tmpDir(), 'k.pem');
  fs.writeFileSync(key, 'x', { mode: 0o600 });
  const live = await run({ TRADING_MODE: 'live', KALSHI_KEY_ID: 'id', KALSHI_PRIVATE_KEY_PATH: key, KALSHI_ENV: 'prod', LIVE_TRADING_ACKNOWLEDGED: 'I_ACCEPT_REAL_MONEY_RISK' }, []);
  assert.ok(Math.abs(live.st.pModel! - live.st.fairValue!) < 1e-12, 'out of live\'s price too');
});

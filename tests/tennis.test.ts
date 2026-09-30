import assert from 'node:assert/strict';
import path from 'path';
import { test } from 'node:test';
import { Alerter } from '../bot/alerts/alerter';
import { loadConfig } from '../bot/config';
import { Engine } from '../bot/engine';
import type { KalshiRest } from '../bot/kalshi/rest';
import type { MarketInfo } from '../bot/kalshi/types';
import { MarketData, Recorder } from '../bot/marketdata/marketData';
import { contractKind } from '../bot/model/fairValue';
import { MetaModel } from '../bot/model/metaModel';
import { Oms } from '../bot/oms/oms';
import { PaperExchange } from '../bot/paper/paperExchange';
import { KillSwitch } from '../bot/risk/killSwitch';
import { RiskGateway } from '../bot/risk/riskGateway';
import { Reconciler } from '../bot/recon/reconciler';
import { decideMatch, MatchTracker, tennisSize, type MatchMarket } from '../bot/tennis/tennisStrategy';
import { tmpAudit, tmpDir } from './helpers';

const T = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32) }).tennis;
const t0 = 1_800_000_000_000;
const mk = (ticker: string, bid: number, ask: number, o: Partial<MatchMarket> = {}): MatchMarket => ({ ticker, quote: { bid, ask, bidSize: 50, askSize: 50 }, position: 0, ...o });
const budget = { bankroll: 1000, tennisRisk: 0, matchRisk: 0 };

test('defaults: 25% total tennis cap (and it cannot be raised above 25%)', () => {
  assert.equal(T.maxTotalFrac, 0.25);
  assert.throws(() => loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(32), TENNIS_MAX_TOTAL_FRAC: '0.3' }));
  assert.equal(contractKind('KXATPMATCH'), 'match');
});

test('sizing respects per-order, per-match and the 25% total cap', () => {
  const cost = 0.2 + 0.0175 * 0.2 * 0.8; // price + maker fee per contract
  assert.equal(tennisSize(0.2, T, budget), Math.floor((49.99 / cost) * 100) / 100);                 // 5% of $1000
  assert.equal(tennisSize(0.2, T, { ...budget, matchRisk: 90 }), Math.floor((9.99 / cost) * 100) / 100);   // 10% match cap
  assert.equal(tennisSize(0.2, T, { ...budget, tennisRisk: 245 }), Math.floor((4.99 / cost) * 100) / 100); // 25% total cap
  assert.equal(tennisSize(0.2, T, { ...budget, tennisRisk: 250 }), 0);
  assert.ok(tennisSize(0.2, T, budget) * cost <= 50);
});

test('underdog rule: skewed match about to start -> maker bid on the underdog; not when balanced', () => {
  const tr = new MatchTracker('E', T);
  const snap = { event: 'E', now: t0, startTime: t0 + 10 * 60_000, closeTime: t0 + 86_400_000, markets: [mk('E-ALC', 0.84, 0.86), mk('E-DOG', 0.14, 0.17)] };
  const out = decideMatch(tr, snap, T, budget);
  assert.equal(out.phase, 'underdog_window');
  assert.equal(out.plans.length, 1);
  const p = out.plans[0];
  assert.deepEqual([p.ticker, p.side, p.postOnly, p.leg], ['E-DOG', 'bid', true, 'underdog_entry']);
  assert.equal(p.price, 0.15, 'improves the underdog bid by one tick');
  const balanced = decideMatch(new MatchTracker('F', T), { ...snap, event: 'F', markets: [mk('F-A', 0.55, 0.57), mk('F-B', 0.43, 0.45)] }, T, budget);
  assert.equal(balanced.plans.length, 0);
  assert.ok(balanced.notes.some((n) => n.includes('not skewed')));
  const early = decideMatch(new MatchTracker('G', T), { ...snap, event: 'G', startTime: t0 + 3 * 3_600_000 }, T, budget);
  assert.equal(early.phase, 'pre');
  assert.equal(early.plans.length, 0, 'hours before the start: wait');
});

test('fixed take-profit mode (TENNIS_TRAIL=false): resting take-profit at max(+6c, +40%)', () => {
  const noTrail = { ...T, trail: false };
  const tr = new MatchTracker('E', noTrail);
  const markets = [mk('E-ALC', 0.80, 0.82), mk('E-DOG', 0.18, 0.20, { position: 100, avgEntry: 0.15 })];
  tr.underdogTicker = 'E-DOG';
  const out = decideMatch(tr, { event: 'E', now: t0, startTime: t0 - 60_000, closeTime: t0 + 86_400_000, markets }, noTrail, budget);
  const tp = out.plans[0];
  assert.deepEqual([tp.leg, tp.side, tp.count, tp.price], ['underdog_tp', 'ask', 100, 0.21]); // 0.15 + max(0.06, 0.06)
});

import { OrderBook } from '../bot/marketdata/orderBook';

test('conservative price hunt: no confluence -> take the profit at the target; confluence -> hunt, then the next exit in profit', () => {
  const run = (tr: MatchTracker, now: number, dogBids: Array<[number, number]>, dogAsk: number, favBid: number, flow?: number) => {
    const book = new OrderBook('E-DOG');
    book.applySnapshot({ bids: dogBids.map(([price, size]) => ({ price, size })), asks: [{ price: dogAsk, size: 100 }] }, now);
    const m = [mk('E-ALC', favBid, favBid + 0.02), { ...mk('E-DOG', dogBids[0][0], dogAsk, { position: 100, avgEntry: 0.15, flow }), book }];
    return decideMatch(tr, { event: 'E', now, startTime: t0 - 60_000, closeTime: t0 + 86_400_000, markets: m }, T, budget);
  };
  // Below the 0.21 target: ride, no exit order.
  const a = new MatchTracker('E', T); a.underdogTicker = 'E-DOG';
  const o0 = run(a, t0, [[0.18, 300]], 0.20, 0.80);
  assert.equal(o0.plans.length, 0);
  assert.ok(o0.notes.some((n) => n.includes('hunt starts at 0.21')));
  // Reaches the target with no confirming signals (flat, balanced book): take the profit now.
  const quiet = new MatchTracker('Q', T); quiet.underdogTicker = 'E-DOG';
  for (let i = 0; i < 13; i++) run(quiet, t0 + i * 5000, [[0.21, 100]], 0.23, 0.77);
  const take = run(quiet, t0 + 13 * 5000, [[0.21, 100]], 0.23, 0.77);
  assert.deepEqual([take.plans[0]?.leg, take.plans[0]?.price, take.plans[0]?.reduceOnly], ['underdog_trail', 0.21, true], JSON.stringify(take.notes));
  // A surge with confluence (momentum, heavy bids, opponent falling, buyers lifting): hunt.
  const h = new MatchTracker('H', T); h.underdogTicker = 'E-DOG';
  let now = t0;
  for (let i = 0; i < 13; i++) { run(h, now, [[0.15, 100]], 0.17, 0.83); now += 5000; }
  let o = run(h, now, [[0.24, 400], [0.22, 400]], 0.25, 0.74, 0.6);
  assert.equal(o.plans.length, 0, JSON.stringify(o.notes));
  assert.ok(h.signals.get('E-DOG')!.score >= 2);
  now += 5000;
  o = run(h, now, [[0.27, 400], [0.25, 400]], 0.28, 0.71, 0.6);
  assert.equal(o.plans.length, 0);
  assert.equal(h.stops.get('E-DOG'), 0.25, 'stop trails 2 ticks under the peak bid');
  // The bid breaks the stop: next available exit in profit, where the bids can fill 100.
  now += 5000;
  o = run(h, now, [[0.24, 60], [0.23, 400]], 0.26, 0.74, 0.6);
  assert.deepEqual([o.plans[0].leg, o.plans[0].price], ['underdog_trail', 0.23], 'sell where depth covers the position');
  // Time limit ends a hunt that keeps confirming.
  const lim = new MatchTracker('L', { ...T, huntMaxSec: 10 }); lim.underdogTicker = 'E-DOG';
  now = t0;
  for (let i = 0; i < 13; i++) { run(lim, now, [[0.15, 100]], 0.17, 0.83); now += 5000; }
  const cfgL = { ...T, huntMaxSec: 10 };
  const runL = (bid: number) => { const book = new OrderBook('E-DOG'); book.applySnapshot({ bids: [{ price: bid, size: 400 }], asks: [{ price: bid + 0.01, size: 50 }] }, now); return decideMatch(lim, { event: 'E', now, startTime: t0 - 60_000, closeTime: t0 + 86_400_000, markets: [mk('E-ALC', 1 - bid - 0.02, 1 - bid), { ...mk('E-DOG', bid, bid + 0.01, { position: 100, avgEntry: 0.15, flow: 0.8 }), book }] }, cfgL, budget); };
  assert.equal(runL(0.24).plans.length, 0);
  now += 12_000;
  const late = runL(0.26);
  assert.match(late.plans[0]?.why ?? '', /time limit/);
});

test('in-play detection without a start time, then favorite re-entry once half the match is done', () => {
  const tr = new MatchTracker('E', T);
  let now = t0;
  const snap = (pFav: number) => ({ event: 'E', now, closeTime: t0 + 86_400_000, markets: [mk('E-A', pFav - 0.01, pFav + 0.01), mk('E-B', 1 - pFav - 0.01, 1 - pFav + 0.01)] });
  // Quiet pre-match: not live.
  for (let i = 0; i < 10; i++) { assert.equal(decideMatch(tr, snap(0.6), T, budget).phase, 'pre'); now += 30_000; }
  // A 4c move within 3 minutes: in play.
  decideMatch(tr, snap(0.64), T, budget);
  assert.equal(tr.liveSince, now);
  // 0.6 is not skewed enough for the underdog rule; move to the middle of the match.
  now += 50 * 60_000;
  for (let i = 0; i < 12; i++) { decideMatch(tr, snap(0.85), T, budget); now += 30_000; }
  const out = decideMatch(tr, snap(0.85), T, budget);
  assert.equal(out.phase, 'late');
  const fav = out.plans.find((p) => p.leg === 'fav_entry')!;
  assert.ok(fav, JSON.stringify(out));
  assert.deepEqual([fav.ticker, fav.side], ['E-A', 'bid']);
  // A slipping leader is not bought.
  const tr2 = new MatchTracker('E2', T);
  tr2.liveSince = t0;
  now = t0 + 60 * 60_000;
  for (let i = 0; i < 12; i++) { decideMatch(tr2, snap(0.90 - i * 0.01), T, budget); now += 30_000; }
  const slip = decideMatch(tr2, snap(0.78), T, budget);
  assert.equal(slip.plans.length, 0);
  assert.ok(slip.notes.some((n) => n.includes('slipping')));
});

test('grand slams are best of five (slower progress)', () => {
  const tr = new MatchTracker('W', T);
  assert.equal(tr.bestOf([mk('W-A', 0.5, 0.52, { title: 'Will Sinner win the Sinner vs Alcaraz: Wimbledon Final match?' })]), 5);
  assert.equal(tr.bestOf([mk('X-A', 0.5, 0.52, { title: 'Will Sinner win the Sinner vs Alcaraz: Cincinnati match?' })]), 3);
});

test('engine trades tennis inside its own 25% budget and keeps it out of the crypto book', async () => {
  const dir = tmpDir();
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), DATA_DIR: dir, DOMINANCE_FEED: 'false', SPOT_FEED: 'false', PERPS_FEED: 'false', STRATEGY_SERIES: 'KXBTC15M' });
  const now = Date.now();
  const m = (ticker: string, title: string): MarketInfo => ({ ticker, seriesTicker: 'KXATPMATCH', eventTicker: 'KXATPMATCH-E1', status: 'open', openTime: now - 3_600_000, closeTime: now + 6 * 3_600_000, tickSize: 0.01, title, startTime: now + 5 * 60_000 });
  const markets = [m('KXATPMATCH-E1-FAV', 'Will Fav win?'), m('KXATPMATCH-E1-DOG', 'Will Dog win?')];
  const rest = {
    getSeriesFees: async () => ({ takerMultiplier: 1, makerMultiplier: 1 }),
    getOpenMarkets: async (s: string) => (s === 'KXATPMATCH' ? markets : []),
    getMarket: async () => undefined,
  } as unknown as KalshiRest;
  const audit = tmpAudit();
  const md = new MarketData(cfg, rest, undefined, new Recorder(path.join(dir, 'rec')));
  await md.refreshCatalog(now);
  assert.equal(md.markets.get('KXATPMATCH-E1-DOG')?.kind, 'match');
  md.book('KXATPMATCH-E1-FAV').applySnapshot({ bids: [{ price: 0.84, size: 100 }], asks: [{ price: 0.86, size: 100 }] }, Date.now());
  md.book('KXATPMATCH-E1-DOG').applySnapshot({ bids: [{ price: 0.14, size: 100 }], asks: [{ price: 0.17, size: 100 }] }, Date.now());
  const paper = new PaperExchange(undefined, 200, (t) => md.books.get(t), () => ({ takerMultiplier: 1, makerMultiplier: 1 }));
  const kill = new KillSwitch(path.join(dir, 'kill.json'), audit);
  const oms = new Oms({ gateway: paper, audit, statePath: path.join(dir, 'oms.json'), feesFor: (t) => md.feesFor(t), sleep: async () => undefined });
  paper.on('fill', (f) => oms.onFill(f));
  paper.on('order', (o) => oms.onExchangeOrder(o));
  const recon = new Reconciler({ gateway: paper, oms, audit, getMarket: rest.getMarket, onPersistentBreak: () => undefined });
  const engine = new Engine({ cfg, audit, alerter: new Alerter([], audit), md, gateway: paper, oms, risk: new RiskGateway(cfg.risk), kill, recon, model: MetaModel.identity() });
  const r = await recon.run('startup');
  engine.balance = r!.balance;
  await engine.tick();
  const open = await paper.getOpenOrders();
  assert.equal(open.length, 1, JSON.stringify([...engine.tennisStatus.values()]));
  const o = open[0];
  assert.deepEqual([o.ticker, o.side, o.price], ['KXATPMATCH-E1-DOG', 'bid', 0.15]);
  assert.ok(o.remainingCount * o.price <= 0.05 * 200 + 1e-9, 'per-order cap: 5% of the pool');
  const b = engine.tennisBudget();
  assert.ok(b.used > 0 && b.used <= b.cap, JSON.stringify(b));
  assert.equal(b.cap, 50);
  assert.equal(engine.status.has('KXATPMATCH-E1-DOG'), false, 'tennis never goes through the crypto pricer');
});

import fs from 'fs';
import { runTennisBacktest } from '../research/tennisBacktest';

test('tennis backtest: underdog bought pre-start, trailed up the bounce, sold when it slipped below the stop', async () => {
  const dir = path.join(tmpDir(), 'rec');
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.parse('2026-10-01T12:00:00Z');
  const ev: any[] = [];
  const mkt = (ticker: string) => ({ t: t0, k: 'market', ticker, series: 'KXATPMATCH', asset: 'TENNIS', openTime: t0 - 3_600_000, closeTime: t0 + 4 * 3_600_000, kind: 'match', event: 'KXATPMATCH-E', tickSize: 0.01, startTime: t0 + 10 * 60_000 });
  ev.push(mkt('KXATPMATCH-E-DOG'), mkt('KXATPMATCH-E-FAV'));
  for (let s = 0; s <= 3 * 3600; s += 5) {
    const t = t0 + s * 1000;
    // pre-start 0.14/0.17 -> bounce past the 0.21 target -> run to 0.30 (wall at 0.28) -> slip to 0.27 -> 0.19.
    const dog = s < 1800 ? { bids: [{ price: 0.14, size: 100 }], asks: [{ price: 0.17, size: 100 }] }
      : s < 3600 ? { bids: [{ price: 0.22, size: 300 }], asks: [{ price: 0.24, size: 100 }] }
      : s < 5400 ? { bids: [{ price: 0.30, size: 300 }, { price: 0.28, size: 400 }], asks: [{ price: 0.32, size: 100 }] }
      : s < 5460 ? { bids: [{ price: 0.27, size: 300 }], asks: [{ price: 0.29, size: 100 }] }
      : { bids: [{ price: 0.19, size: 300 }], asks: [{ price: 0.21, size: 100 }] };
    ev.push({ t, k: 'book', ticker: 'KXATPMATCH-E-DOG', ...dog });
    ev.push({ t, k: 'book', ticker: 'KXATPMATCH-E-FAV', bids: [{ price: 1 - dog.asks[0].price, size: 100 }], asks: [{ price: 1 - dog.bids[0].price, size: 100 }] });
    if (s === 60) ev.push({ t, k: 'trade', ticker: 'KXATPMATCH-E-DOG', price: 0.15, count: 1000, takerSide: 'no', ts: t });
  }
  ev.push({ t: t0 + 3 * 3600 * 1000 + 1000, k: 'result', ticker: 'KXATPMATCH-E-DOG', result: 'no' }, { t: t0 + 3 * 3600 * 1000 + 1000, k: 'result', ticker: 'KXATPMATCH-E-FAV', result: 'yes' });
  ev.push({ t: t0 + 3 * 3600 * 1000 + 10_000, k: 'book', ticker: 'KXATPMATCH-E-DOG', bids: [], asks: [] });
  fs.writeFileSync(path.join(dir, 'md-2026-10-01.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const r = await runTennisBacktest(dir, T, 200);
  assert.equal(r.matches, 1);
  assert.ok(r.byLeg.underdog_entry?.fills > 0, JSON.stringify(r.byLeg));
  assert.ok(r.byLeg.underdog_trail?.fills > 0, JSON.stringify(r.byLeg));
  assert.ok(r.pnl > 0, `pnl ${r.pnl}`);
  assert.ok(r.maxTennisRisk <= 0.25 * 200 + 1e-9);
});

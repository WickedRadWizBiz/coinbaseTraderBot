// Fee-inclusive backtest on recorded data using the production strategy,
// risk gateway and the conservative queue-aware fill simulator.
//   npm run research:backtest -- --recordings data/recordings --model params/model.candidate.json \
//       [--grid 0.01,0.02,0.03] [--trials 6] [--annotate]
//
// Reports per-WINDOW results (correlated markets closing together count once),
// a bootstrap CI on net edge per contract, the Deflated Sharpe given every
// variant tried, and PBO across the --grid of minEdge values. With --annotate
// the model file's validation block gets netEdgeCiLow / deflatedSharpe.

import fs from 'fs';
import path from 'path';
import { loadConfig, type StrategyConfig, type RiskLimits } from '../bot/config';
import { DEFAULT_FEES } from '../bot/fees';
import { buildFeatures } from '../bot/model/features';
import { fairValue, SETTLEMENT_AVG_SEC } from '../bot/model/fairValue';
import { MetaModel } from '../bot/model/metaModel';
import type { OrderIntent } from '../bot/oms/oms';
import { PositionBook } from '../bot/oms/positions';
import { PaperExchange } from '../bot/paper/paperExchange';
import { marketWorstLoss } from '../bot/risk/exposure';
import { RiskGateway } from '../bot/risk/riskGateway';
import { decide } from '../bot/strategy/fairValueStrategy';
import { readRecordings, ReplayState } from './replay';
import { bootstrapMeanCi, deflatedSharpe, pbo, sharpe } from './stats';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

export interface BacktestResult {
  minEdge: number;
  windows: Map<number, { pnl: number; contracts: number; fees: number }>;
  fills: number;
  contracts: number;
  fees: number;
  pnl: number;
}

export async function runBacktest(dir: string, model: MetaModel, strategy: StrategyConfig, limits: RiskLimits, bankroll0: number): Promise<BacktestResult> {
  const st = new ReplayState();
  const pos = new PositionBook();
  const ex = new PaperExchange(undefined, bankroll0, (t) => st.books.get(t), () => DEFAULT_FEES, () => st.now);
  const gateway = new RiskGateway(limits);
  const res: BacktestResult = { minEdge: strategy.minEdge, windows: new Map(), fills: 0, contracts: 0, fees: 0, pnl: 0 };
  const closeOf = new Map<string, number>();

  ex.on('fill', (f) => {
    pos.applyFill({ ticker: f.ticker, side: f.side, count: f.count, price: f.price, fee: f.fee ?? 0 }, { closeTs: closeOf.get(f.ticker) });
    const w = closeOf.get(f.ticker)!;
    const b = res.windows.get(w) ?? { pnl: 0, contracts: 0, fees: 0 };
    b.contracts += f.count;
    b.fees += f.fee ?? 0;
    res.windows.set(w, b);
    res.fills++; res.contracts += f.count; res.fees += f.fee ?? 0;
  });

  let lastTick = 0;
  for await (const e of readRecordings(dir)) {
    st.apply(e);
    if (e.k === 'trade') ex.onTrade(e.ticker, e.price, e.count, e.takerSide);
    if (st.now - lastTick < 1000) continue;
    lastTick = st.now;

    for (const m of [...st.markets.values()]) {
      closeOf.set(m.ticker, m.closeTime);
      // Settle closed markets.
      if (st.now >= m.closeTime + 60_000) {
        const out = st.outcome(m);
        if (out) {
          const result = out.label ? 'yes' : 'no';
          ex.settle(m.ticker, result);
          const p = pos.get(m.ticker);
          if (p && !p.settled) {
            pos.settle(m.ticker, result, st.now);
            const b = res.windows.get(m.closeTime) ?? { pnl: 0, contracts: 0, fees: 0 };
            b.pnl += p.realized ?? 0;
            res.windows.set(m.closeTime, b);
            res.pnl += p.realized ?? 0;
          }
        }
        st.markets.delete(m.ticker);
        continue;
      }
      if (st.now < m.openTime || st.now >= m.closeTime) continue;

      const book = st.books.get(m.ticker);
      const idx = st.index.get(m.asset);
      const bid = book?.bestBid(), ask = book?.bestAsk();
      const spot = idx?.fresh(st.now, limits.maxIndexAgeMs);
      const vol = idx?.vol();
      const strike = st.strike(m);
      const open = (await ex.getOpenOrders()).filter((o) => o.ticker === m.ticker);
      if (!book?.isUsable(st.now, limits.maxBookAgeMs) || !bid || !ask || !spot || !vol || !strike) {
        for (const o of open) await ex.cancelOrder(o.orderId);
        continue;
      }
      const tauSec = (m.closeTime - st.now) / 1000;
      const observed = tauSec <= SETTLEMENT_AVG_SEC ? idx!.average(m.closeTime - 60_000, st.now, 3000)?.avg : undefined;
      const fv = fairValue({ spot: spot.value, strike, sigmaPerSqrtSec: vol.sigmaPerSqrtSec, tauSec, observedAvg: observed });
      if (!fv) continue;
      const mid = (bid.price + ask.price) / 2;
      const pYes = model.predict(buildFeatures({ fairValue: fv.pYes, mid, tauSec, sigmaPerSqrtSec: vol.sigmaPerSqrtSec, referenceSigma: model.params.referenceSigma, spread: ask.price - bid.price, imbalance: book.imbalance(), inWindow: fv.regime !== 'pre_window' }), fv.pYes);
      const ret = idx!.trailingLogReturn(st.now, strategy.fastMoveWindowSec * 1000);
      const fastMove = ret !== undefined && Math.abs(ret) > strategy.fastMoveSigmas * vol.sigmaPerSqrtSec * Math.sqrt(strategy.fastMoveWindowSec);
      const bankroll = (await ex.getBalance()) + pos.open().reduce((s, p) => s + PositionBook.maxLoss(p), 0);
      const q = (side: 'bid' | 'ask') => { const o = open.find((x) => x.side === side); return o ? { clientOrderId: o.orderId, price: o.price, remaining: o.remainingCount } : undefined; };
      const plan = decide({
        ticker: m.ticker, pYes, bestBid: bid, bestAsk: ask, position: pos.position(m.ticker), bankroll,
        maxOrderRiskUsd: limits.maxOrderRiskFrac * bankroll, maxContracts: limits.maxContractsPerOrder, minSidePrice: limits.minSidePrice,
        tauSec, noEntryBeforeCloseSec: limits.noEntryBeforeCloseSec, fastMove, tickSize: m.tickSize, fees: DEFAULT_FEES,
        restingBid: q('bid'), restingAsk: q('ask'), nowSec: Math.floor(st.now / 1000), closeSec: Math.floor(m.closeTime / 1000),
      }, strategy);
      for (const c of plan.cancel) await ex.cancelOrder(c.clientOrderId);

      for (const p of plan.place) {
        const openNow = await ex.getOpenOrders();
        const resting = openNow.map((o) => ({ ticker: o.ticker, side: o.side, price: o.price, remaining: o.remainingCount, isTaker: false }));
        const riskOf = (t: string, extra = [] as typeof resting) => marketWorstLoss(pos.get(t), [...resting.filter((r) => r.ticker === t), ...extra], DEFAULT_FEES);
        const tickers = new Set([...pos.unsettled().map((x) => x.ticker), ...resting.map((r) => r.ticker)]);
        let windowRisk = 0, totalRisk = 0;
        for (const t of tickers) { const l = riskOf(t); totalRisk += l; if (closeOf.get(t) === m.closeTime) windowRisk += l; }
        const intent: OrderIntent = { ticker: m.ticker, asset: m.asset, windowCloseTs: m.closeTime, side: p.side, price: p.price, count: p.count, timeInForce: p.timeInForce, postOnly: p.postOnly, reduceOnly: p.reduceOnly, expirationTime: p.expirationTime, purpose: p.purpose, fairValue: pYes, modelId: model.id, decisionId: 'bt' };
        const d = gateway.check(intent, {
          now: st.now, mode: 'paper', killEngaged: false, haltReasons: [], bankroll, dailyPnl: 0, bookUsable: true,
          bestBid: bid.price, bestAsk: ask.price, indexFresh: true, marketCloseTs: m.closeTime, tickSize: m.tickSize, fees: DEFAULT_FEES,
          position: pos.position(m.ticker), marketRiskNow: riskOf(m.ticker),
          marketRiskWith: p.reduceOnly ? riskOf(m.ticker) : riskOf(m.ticker, [{ ticker: m.ticker, side: p.side, price: p.price, remaining: p.count, isTaker: !p.postOnly }]),
          windowRisk, totalRisk, ordersLastMinute: 0, openOrders: openNow.length, modelLiveBlockers: [],
        });
        if (!d.ok) continue;
        try {
          await ex.createOrder({ ticker: m.ticker, side: p.side, count: p.count, price: p.price, timeInForce: p.timeInForce, postOnly: p.postOnly, reduceOnly: p.reduceOnly, selfTradePrevention: 'taker_at_cross', clientOrderId: `${m.ticker}-${st.now}-${p.side}-${p.purpose}`, expirationTime: p.expirationTime });
        } catch { /* rejected like the exchange would */ }
      }
    }
  }
  return res;
}

async function main() {
  const dir = arg('recordings', 'data/recordings');
  const modelPath = arg('model', 'params/model.json');
  const model = fs.existsSync(modelPath) ? MetaModel.load(modelPath) : MetaModel.identity();
  const cfg = loadConfig({ ...process.env, DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32), TRADING_MODE: 'paper' });
  const grid = arg('grid', String(cfg.strategy.minEdge)).split(',').map(Number);
  const bankroll = Number(arg('bankroll', String(cfg.paperBankrollUsd)));
  const priorTrials = Number(arg('trials', String((model.params.validation?.variantsTried ?? 1))));

  const results: BacktestResult[] = [];
  for (const minEdge of grid) results.push(await runBacktest(dir, model, { ...cfg.strategy, minEdge }, cfg.risk, bankroll));
  const allWindows = [...new Set(results.flatMap((r) => [...r.windows.keys()]))].sort((a, b) => a - b);

  const summaries = results.map((r) => {
    const traded = [...r.windows.values()].filter((w) => w.contracts > 0);
    const perContract = traded.map((w) => w.pnl / w.contracts);
    const ci = bootstrapMeanCi(perContract);
    const series = allWindows.map((w) => r.windows.get(w)?.pnl ?? 0);
    const dsr = deflatedSharpe(series, priorTrials * grid.length);
    return { minEdge: r.minEdge, windowsTraded: traded.length, fills: r.fills, contracts: r.contracts, fees: +r.fees.toFixed(2), pnl: +r.pnl.toFixed(2), edgePerContract: ci.mean, edgeCiLo: ci.lo, edgeCiHi: ci.hi, sharpePerWindow: sharpe(series), deflatedExcess: dsr.excess, dsrProb: dsr.probability };
  });
  console.table(summaries);
  if (grid.length > 1) {
    const matrix = allWindows.map((w) => results.map((r) => r.windows.get(w)?.pnl ?? 0));
    console.log('PBO (CSCV):', pbo(matrix));
  }
  const best = summaries.find((s) => s.minEdge === cfg.strategy.minEdge) ?? summaries[0];
  console.log(`windows traded: ${best.windowsTraded} (need >= 1000 independent windows before trusting any edge)`);

  if (process.argv.includes('--annotate') && fs.existsSync(modelPath)) {
    const params = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    params.validation = {
      ...params.validation,
      netEdgeCiLow: best.edgeCiLo,
      deflatedSharpe: best.deflatedExcess,
      variantsTried: priorTrials * grid.length,
      backtestWindowsTraded: best.windowsTraded,
    };
    params.validation.passed = Boolean(params.validation.passed) && best.edgeCiLo > 0 && best.deflatedExcess > 0 && best.windowsTraded >= 1000;
    fs.writeFileSync(modelPath, JSON.stringify(params, null, 2) + '\n');
    console.log(`annotated ${modelPath}: passed=${params.validation.passed}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) void main();

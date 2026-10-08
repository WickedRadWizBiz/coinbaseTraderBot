// Execution-realistic replay of stage-3 perp trading: the SAME PerpTrader and executor the live bot
// runs, against the paper perps exchange driven by recorded perp quotes (maker fills only on
// trade-through, taker fills at the touch, fees in bps, funding at each funding time, exchange-side
// stops on the liquidation mark). Reports P&L after fees and funding, per-day bootstrap CI, deflated
// Sharpe, trades and stop-outs. `--annotate` writes the result into the model file as
// validation.backtest, which (with a passing walk-forward validation) unlocks full-size live trading.
//
//   npm run research:perp-backtest -- --recordings data/recordings --model params/perp_model.candidate.json [--annotate]

import fs from 'fs';
import path from 'path';
import { loadConfig, type PerpsConfig } from '../bot/config';
import { PerpHedger } from '../bot/perps/hedger';
import { PaperPerpExchange } from '../bot/perps/paperPerp';
import { PerpModel } from '../bot/perps/perpSignal';
import { PerpTrader, type PerpTraderParams } from '../bot/perps/perpTrader';
import { readRecordings, ReplayState } from './replay';
import { bootstrapMeanCi, deflatedSharpe } from './stats';

export interface PerpBacktestResult {
  days: number;
  startEquity: number;
  endEquity: number;
  pnlUsd: number;
  fees: number;
  funding: number;
  trades: number;
  stopOuts: number;
  dailyPnl: number[];
  pnlCiLo: number;
  dsrProbability: number;
  ok: boolean;
}

export function traderParams(P: PerpsConfig): PerpTraderParams {
  return {
    horizonMin: P.horizonMin, entryEdgeBps: P.entryEdgeBps, exitEdgeBps: P.exitEdgeBps, kellyFraction: P.kellyFraction, maxLeverage: P.maxLeverage,
    maxNotionalUsd: P.maxTradeNotionalUsd, maxTotalNotionalUsd: P.maxTotalNotionalUsd, stopAtrMult: P.stopAtrMult, minStopBps: P.minStopBps, maxHoldMin: P.maxHoldMin,
    dailyLossFrac: P.dailyLossFrac, cooldownMin: P.cooldownMin, pilotMaxNotionalUsd: P.pilotMaxNotionalUsd, pilotMaxLeverage: P.pilotMaxLeverage, priorIc: P.priorIc,
    makerBps: P.makerFeeBps, requireValidation: P.requireValidation, minEquityUsd: P.minEquityUsd,
  };
}

export async function runPerpBacktest(dir: string, P: PerpsConfig, model: PerpModel | undefined, opts: { startBalance?: number; trials?: number; minDays?: number } = {}): Promise<PerpBacktestResult> {
  const st = new ReplayState();
  const hub = st.features.perps;
  const tickerAsset = (t: string) => [...hub.byAsset.entries()].find(([, s]) => s.latest?.ticker === t)?.[0];
  const start = opts.startBalance ?? P.paperBalanceUsd;
  const sim = new PaperPerpExchange(hub, tickerAsset, { makerBps: P.makerFeeBps, takerBps: P.takerFeeBps }, undefined, () => st.now, start);
  const units = (asset: string) => { const px = hub.get(asset)?.price(st.now, 60_000), ix = st.index.get(asset)?.fresh(st.now, 15_000)?.value; return px && ix ? px / ix : undefined; };
  const ex = new PerpHedger({ gateway: sim, hub, units, now: () => st.now, params: { minDollarDelta: P.minDollarDelta, maxNotionalUsd: P.maxNotionalUsd, excludeTauSec: P.excludeTauSec, repriceSec: P.repriceSec, takerAfterSec: P.takerAfterSec }, risk: { maxOrderNotionalUsd: P.maxOrderNotionalUsd, collarBps: P.collarBps } });
  const trader = new PerpTrader({
    params: traderParams(P), hub, gateway: sim, model,
    sources: (asset) => ({ index: st.index.get(asset), spot: st.spot.get(asset), bars: st.features.bars.get(asset), candles: st.features.candles.get(asset), usdtd: st.usdtd, btcd: st.btcd, perp: hub.get(asset), snn: st.snnContext(asset, undefined, 'perps') }),
  });
  const daily: number[] = [];
  let dayKey = '', dayStart = start, first = 0, lastTick = 0, trades = 0, quoted = false;
  const lastPos = new Map<string, number>();
  for await (const e of readRecordings(dir)) {
    st.apply(e);
    if (!first) first = st.now;
    if (e.k === 'perp') quoted = true;
    // After a quote, once its whole instant is in (the history replay writes every asset's prices and the
    // dominance of an instant as one burst of same-time records).
    if (e.tie || !quoted) continue;
    quoted = false;
    sim.step();
    // Decide right after a quote arrives (live polls every ~2 s, so decisions always see a fresh quote).
    if (st.now - lastTick < 5_000) continue;
    lastTick = st.now;
    await ex.tick([], { directional: (c) => trader.targets(c, {}) });
    for (const p of await sim.getPositions()) {
      if ((lastPos.get(p.ticker) ?? 0) === 0 && p.position !== 0) trades++;
      lastPos.set(p.ticker, p.position);
    }
    for (const t of [...lastPos.keys()]) if (!(await sim.getPositions()).some((p) => p.ticker === t)) lastPos.set(t, 0);
    const key = new Date(st.now).toISOString().slice(0, 10);
    if (key !== dayKey) {
      const eq = (await sim.getBalance()).equity;
      if (dayKey) daily.push(eq - dayStart);
      dayKey = key; dayStart = eq;
    }
  }
  const end = (await sim.getBalance()).equity;
  if (dayKey) daily.push(end - dayStart);
  const led = Object.values(sim.ledger());
  const ci = daily.length >= 2 ? bootstrapMeanCi(daily) : { mean: NaN, lo: NaN, hi: NaN };
  const dsr = daily.length >= 5 ? deflatedSharpe(daily, opts.trials ?? model?.params.validation?.trials ?? 1).probability : 0;
  const days = first ? Math.max(1 / 24, (st.now - first) / 86_400_000) : 0;
  return {
    days, startEquity: start, endEquity: end, pnlUsd: end - start, fees: led.reduce((s, p) => s + p.fees, 0), funding: led.reduce((s, p) => s + p.funding, 0),
    trades, stopOuts: sim.stopFills(), dailyPnl: daily, pnlCiLo: ci.lo, dsrProbability: dsr,
    ok: days >= (opts.minDays ?? 30) && ci.lo > 0 && dsr > 0.95,
  };
}

export async function perpBacktestMain(argOf: (k: string, d: string) => string = cliArg, annotate: boolean = process.argv.includes('--annotate')) {
  const cfg = loadConfig({ ...process.env, DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32), TRADING_MODE: 'paper' });
  const modelPath = argOf('model', cfg.perps.modelPath);
  const model = PerpModel.load(modelPath);
  if (!model) console.warn(`no model at ${modelPath}: backtesting the momentum prior at pilot size`);
  const r = await runPerpBacktest(argOf('recordings', 'data/recordings'), cfg.perps, model, { startBalance: Number(argOf('balance', String(cfg.perps.paperBalanceUsd))) });
  const { dailyPnl: _d, ...summary } = r;
  console.table([{ ...summary, pnlUsd: +r.pnlUsd.toFixed(2), fees: +r.fees.toFixed(2), funding: +r.funding.toFixed(2), days: +r.days.toFixed(1) }]);
  if (annotate && model && fs.existsSync(modelPath)) {
    const p = model.params;
    p.validation = { ...(p.validation ?? { passed: false, nEff: 0, ic: NaN, icCiLo: NaN, pnlBpsPerTrade: NaN, pnlCiLo: NaN, dsrProbability: 0, trials: 1 }), backtest: { ok: r.ok, pnlUsd: r.pnlUsd, pnlCiLo: r.pnlCiLo, dsrProbability: r.dsrProbability, trades: r.trades, days: r.days, fees: r.fees, funding: r.funding } };
    fs.writeFileSync(modelPath, JSON.stringify(p, null, 1));
    console.log(`annotated ${modelPath}: backtest ${r.ok ? 'PASSED' : 'failed'}`);
  }
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void perpBacktestMain();

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

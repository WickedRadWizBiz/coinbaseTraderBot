// Fee-inclusive backtest on recorded data using the production strategy,
// risk gateway and the conservative queue-aware fill simulator.
//   npm run research:backtest -- --recordings data/recordings --model params/model.candidate.json \
//       [--grid 0.01,0.02,0.03] [--exits hold,fair_value,liquidity_ratchet,hybrid,confluence_ratchet] \
//       [--ratchet-fill 1] [--ratchet-age 3] [--ratchet-slip 1] [--hunt-margin 0.02] [--hunt-confluence 2] \
//       [--trials 6] [--annotate]
//
// Exit policies (bot/strategy/exitPolicies.ts) are compared on identical data.
// The exit policy governs every ACTIVE reduction: under hold / liquidity_ratchet,
// taker entries against an existing position are blocked (they are exits in
// disguise). Passive maker quotes unwind at favourable prices under every policy.
// Every exit executes one tick (1 s) after it triggers, against the book at
// that moment, so no policy gets instantaneous reaction for free. Exit
// diagnostics: exit regret (what exited contracts would have paid at
// settlement minus what the exit actually received; positive = the exit cost
// money), stopped-out winners, ratchet slippage vs the stop, and gap-throughs.
//
// Reports per-WINDOW results (correlated markets closing together count once),
// a bootstrap CI on net edge per contract, the Deflated Sharpe given every
// variant tried, and PBO across the --grid of minEdge values. With --annotate
// the model file's validation block gets netEdgeCiLow / deflatedSharpe.

import fs from 'fs';
import path from 'path';
import { loadConfig, type StrategyConfig, type RiskLimits } from '../bot/config';
import { DEFAULT_FEES } from '../bot/fees';
import { computeFeatureMap } from '../bot/model/featureEngine';
import { effectiveSigma, loadVolProfile, type VolProfile } from '../bot/model/volSeasonality';
import { sessionRiskFor, huntBlockedBySession, type SessionRiskProfile } from '../bot/model/sessionRisk';
import { sessionState } from '../bot/model/sessions';
import { Vault, type VaultConfig } from '../bot/vault/vault';
import { fairValue, SETTLEMENT_AVG_SEC } from '../bot/model/fairValue';
import { MetaModel } from '../bot/model/metaModel';
import type { OrderIntent } from '../bot/oms/oms';
import { PositionBook } from '../bot/oms/positions';
import { PaperExchange } from '../bot/paper/paperExchange';
import { marketWorstLoss } from '../bot/risk/exposure';
import { RiskGateway } from '../bot/risk/riskGateway';
import { decide } from '../bot/strategy/fairValueStrategy';
import { ConfluenceRatchetExit, DEFAULT_HUNT, DEFAULT_RATCHET, EXIT_POLICIES, ExitPolicyName, HuntParams, LiquidityRatchet, RatchetParams } from '../bot/strategy/exitPolicies';
import { readRecordings, ReplayState } from './replay';
import { bootstrapMeanCi, deflatedSharpe, pbo, sharpe } from './stats';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

export interface ExitStats {
  orders: number;
  fills: number;
  contracts: number;
  /** Net proceeds of exit fills (side price x count - fees). */
  proceeds: number;
  /** Settlement value of exited contracts minus exit proceeds (positive = exiting cost money). */
  regret: number;
  /** Exit fills whose side went on to settle in the money. */
  stoppedWinners: number;
  ratchetTriggers: number;
  gaps: number;
  hybridHolds: number;
  /** confluence_ratchet: times hunt mode switched on / off, and exits it made. */
  huntActivations: number;
  huntDeactivations: number;
  /** Mean (stop - fill price) in side terms for ratchet exits; positive = filled below the stop. */
  avgSlippage: number | null;
}

export interface SessionBreakdown { windows: number; pnl: number; contracts: number; fees: number }

export interface BacktestResult {
  exitPolicy: ExitPolicyName;
  /** Vault and pocket at the end of the run (bookkeeping; reduces tradable bankroll). */
  vaultEnd: number;
  pocketEnd: number;
  /** P&L attributed to the session in effect when each 15-minute window opened. */
  bySession: Record<string, SessionBreakdown>;
  exits: ExitStats;
  minEdge: number;
  windows: Map<number, { pnl: number; contracts: number; fees: number }>;
  fills: number;
  contracts: number;
  fees: number;
  pnl: number;
}

export async function runBacktest(
  dir: string, model: MetaModel, strategy: StrategyConfig, limits: RiskLimits, bankroll0: number,
  opts: { exitPolicy?: ExitPolicyName; ratchet?: RatchetParams; hunt?: HuntParams; volProfile?: VolProfile; applyVolSeasonality?: boolean; sessionRisk?: SessionRiskProfile; huntSessionGuard?: boolean; huntTransitionBufferMin?: number; vault?: VaultConfig } = {},
): Promise<BacktestResult> {
  const policy = opts.exitPolicy ?? 'fair_value';
  const st = new ReplayState();
  const pos = new PositionBook();
  const ex = new PaperExchange(undefined, bankroll0, (t) => st.books.get(t), () => DEFAULT_FEES, () => st.now);
  const gateway = new RiskGateway(limits);
  const exits: ExitStats = { orders: 0, fills: 0, contracts: 0, proceeds: 0, regret: 0, stoppedWinners: 0, ratchetTriggers: 0, gaps: 0, hybridHolds: 0, huntActivations: 0, huntDeactivations: 0, avgSlippage: null };
  const vault = opts.vault ? new Vault(opts.vault, undefined, () => st.now) : undefined;
  const res: BacktestResult = { exitPolicy: policy, vaultEnd: 0, pocketEnd: 0, bySession: {}, exits, minEdge: strategy.minEdge, windows: new Map(), fills: 0, contracts: 0, fees: 0, pnl: 0 };
  const closeOf = new Map<string, number>();
  const ratchets = new Map<string, LiquidityRatchet>();
  const hunts = new Map<string, ConfluenceRatchetExit>();
  const pending = new Map<string, { side: 'bid' | 'ask'; price: number; count: number; kind: 'fv' | 'rt'; stop?: number }>();
  const stopByOrder = new Map<string, number>();
  const exitLedger = new Map<string, Array<{ sideSign: number; n: number; proceeds: number }>>();
  let slipSum = 0, slipN = 0;

  ex.on('fill', (f) => {
    pos.applyFill({ ticker: f.ticker, side: f.side, count: f.count, price: f.price, fee: f.fee ?? 0 }, { closeTs: closeOf.get(f.ticker) });
    const w = closeOf.get(f.ticker)!;
    const b = res.windows.get(w) ?? { pnl: 0, contracts: 0, fees: 0 };
    b.contracts += f.count;
    b.fees += f.fee ?? 0;
    res.windows.set(w, b);
    res.fills++; res.contracts += f.count; res.fees += f.fee ?? 0;
    if (f.clientOrderId?.includes('-exit-')) {
      const sideSign = f.side === 'ask' ? 1 : -1; // selling YES exits a long YES; buying YES exits a long NO
      const sidePrice = sideSign > 0 ? f.price : 1 - f.price;
      const proceeds = f.count * sidePrice - (f.fee ?? 0);
      exits.fills++; exits.contracts += f.count; exits.proceeds += proceeds;
      const arr = exitLedger.get(f.ticker) ?? [];
      arr.push({ sideSign, n: f.count, proceeds });
      exitLedger.set(f.ticker, arr);
      const stop = stopByOrder.get(f.clientOrderId);
      if (stop !== undefined) { slipSum += stop - sidePrice; slipN++; }
    }
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
          for (const x of exitLedger.get(m.ticker) ?? []) {
            const won = (x.sideSign > 0) === (result === 'yes');
            exits.regret += (won ? x.n : 0) - x.proceeds;
            if (won) exits.stoppedWinners++;
          }
          exitLedger.delete(m.ticker);
          ratchets.delete(m.ticker);
          hunts.delete(m.ticker);
          pending.delete(m.ticker);
          const p = pos.get(m.ticker);
          if (p && !p.settled) {
            pos.settle(m.ticker, result, st.now);
            const b = res.windows.get(m.closeTime) ?? { pnl: 0, contracts: 0, fees: 0 };
            b.pnl += p.realized ?? 0;
            res.windows.set(m.closeTime, b);
            res.pnl += p.realized ?? 0;
            if ((p.realized ?? 0) > 0) vault?.onSettled(p.realized!, m.ticker, st.now);
            const sk = sessionState(m.openTime).key;
            const sb = res.bySession[sk] ?? { windows: 0, pnl: 0, contracts: 0, fees: 0 };
            sb.windows++; sb.pnl += p.realized ?? 0; sb.contracts += b.contracts; sb.fees += b.fees;
            res.bySession[sk] = sb;
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
        pending.delete(m.ticker); // never fire a queued exit into a stale book later
        continue;
      }
      const tauSec = (m.closeTime - st.now) / 1000;
      const observed = tauSec <= SETTLEMENT_AVG_SEC ? idx!.average(m.closeTime - 60_000, st.now, 3000)?.avg : undefined;
      const sigmaFv = opts.applyVolSeasonality ? effectiveSigma(vol.sigmaPerSqrtSec, opts.volProfile, m.asset, st.now, m.closeTime) : vol.sigmaPerSqrtSec;
      const fv = fairValue({ spot: spot.value, strike, sigmaPerSqrtSec: sigmaFv, tauSec, observedAvg: observed });
      if (!fv) continue;
      const mid = (bid.price + ask.price) / 2;
      const fmap = computeFeatureMap({ now: st.now, fairValue: fv.pYes, mid, tauSec, sigmaPerSqrtSec: vol.sigmaPerSqrtSec, referenceSigma: model.params.referenceSigma, inWindow: fv.regime !== 'pre_window', book, micro: st.features.micro.get(m.ticker), index: idx!, spot: st.spot.get(m.asset), asset: m.asset, usdtd: st.usdtd, btcd: st.btcd, closeTs: m.closeTime, volProfile: opts.volProfile, asiaRange: st.features.asiaRange.get(m.asset) });
      const pYes = model.predict(fmap, fv.pYes);
      const ret = idx!.trailingLogReturn(st.now, strategy.fastMoveWindowSec * 1000);
      const fastMove = ret !== undefined && Math.abs(ret) > strategy.fastMoveSigmas * vol.sigmaPerSqrtSec * Math.sqrt(strategy.fastMoveWindowSec);
      vault?.tick(st.now);
      const bankroll = Math.max(0, (await ex.getBalance()) + pos.open().reduce((s, p) => s + PositionBook.maxLoss(p), 0) - (vault?.reserved() ?? 0));
      const q = (side: 'bid' | 'ask') => { const o = open.find((x) => x.side === side); return o ? { clientOrderId: o.orderId, price: o.price, remaining: o.remainingCount } : undefined; };
      // Submit an exit that triggered on the previous tick (1 s reaction delay for every policy).
      const due = pending.get(m.ticker);
      pending.delete(m.ticker);
      const curPos = pos.position(m.ticker);
      if (due && Math.sign(curPos) === (due.side === 'ask' ? 1 : -1)) {
        const count = Math.min(due.count, Math.abs(curPos));
        const intent: OrderIntent = { ticker: m.ticker, asset: m.asset, windowCloseTs: m.closeTime, side: due.side, price: due.price, count, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: true, purpose: 'exit', fairValue: pYes, modelId: model.id, decisionId: 'bt' };
        const d = gateway.check(intent, {
          now: st.now, mode: 'paper', killEngaged: false, haltReasons: [], bankroll: 1, dailyPnl: 0, bookUsable: true, bestBid: bid.price, bestAsk: ask.price,
          indexFresh: true, marketCloseTs: m.closeTime, tickSize: m.tickSize, fees: DEFAULT_FEES, position: curPos, marketRiskNow: 0, marketRiskWith: 0,
          windowRisk: 0, totalRisk: 0, ordersLastMinute: 0, openOrders: 0, modelLiveBlockers: [],
        });
        if (d.ok) {
          const id = `${m.ticker}-${st.now}-exit-${due.kind}`;
          if (due.stop !== undefined) stopByOrder.set(id, due.stop);
          exits.orders++;
          try { await ex.createOrder({ ticker: m.ticker, side: due.side, count, price: due.price, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: true, selfTradePrevention: 'taker_at_cross', clientOrderId: id }); } catch { /* no fill */ }
        }
      }

      // Ratchet / hybrid: evaluate the order-book-anchored stop.
      const posNow = pos.position(m.ticker);
      if ((policy === 'liquidity_ratchet' || policy === 'hybrid') && posNow !== 0) {
        let r = ratchets.get(m.ticker);
        if (!r) { r = new LiquidityRatchet(opts.ratchet ?? DEFAULT_RATCHET); ratchets.set(m.ticker, r); }
        const out = r.evaluate({ position: posNow, book, now: st.now, tick: m.tickSize, fees: DEFAULT_FEES, qSide: posNow > 0 ? pYes : 1 - pYes, hybrid: policy === 'hybrid' });
        if (out.event === 'gapped') exits.gaps++;
        if (out.event === 'hybrid_hold') exits.hybridHolds++;
        if (out.plan && !pending.has(m.ticker)) {
          exits.ratchetTriggers++;
          pending.set(m.ticker, { side: out.plan.side, price: out.plan.price, count: out.plan.count, kind: 'rt', stop: out.plan.stop });
        }
      }

      // Confluence ratchet: fair-value exit normally; hunt mode (ratchet exit, no other reductions)
      // only while the contract has beaten its entry fair value AND confluence agrees.
      const sess = sessionState(st.now);
      const sessRisk = sessionRiskFor(opts.sessionRisk ?? {}, sess);
      let huntMode = false;
      if (policy === 'confluence_ratchet') {
        const posH = pos.position(m.ticker);
        let h = hunts.get(m.ticker);
        if (!h) { h = new ConfluenceRatchetExit(opts.hunt ?? DEFAULT_HUNT, opts.ratchet ?? DEFAULT_RATCHET); hunts.set(m.ticker, h); }
        const d = h.update({
          position: posH, qSide: posH >= 0 ? pYes : 1 - pYes, sideBid: posH > 0 ? bid.price : posH < 0 ? 1 - ask.price : undefined,
          confluence: fmap.conf_count, book, now: st.now, tick: m.tickSize, fees: DEFAULT_FEES,
          sessionBlocked: (opts.huntSessionGuard ?? true) ? huntBlockedBySession(sess, opts.huntTransitionBufferMin ?? 10) : undefined,
        });
        huntMode = d.mode === 'hunt';
        if (d.event === 'activated') exits.huntActivations++;
        if (d.event === 'deactivated_confluence' || d.event === 'deactivated_giveback' || d.event === 'deactivated_session') exits.huntDeactivations++;
        if (d.event === 'gapped') exits.gaps++;
        if (d.plan && !pending.has(m.ticker)) {
          exits.ratchetTriggers++;
          pending.set(m.ticker, { side: d.plan.side, price: d.plan.price, count: d.plan.count, kind: 'rt', stop: d.plan.stop });
        }
      }

      const plan = decide({
        ticker: m.ticker, pYes, bestBid: bid, bestAsk: ask, position: pos.position(m.ticker), bankroll,
        maxOrderRiskUsd: limits.maxOrderRiskFrac * bankroll * sessRisk.sizeMult, maxContracts: Math.floor(limits.maxContractsPerOrder * sessRisk.sizeMult * 100) / 100, minSidePrice: limits.minSidePrice,
        tauSec, noEntryBeforeCloseSec: limits.noEntryBeforeCloseSec, fastMove, tickSize: m.tickSize, fees: DEFAULT_FEES,
        restingBid: q('bid'), restingAsk: q('ask'), nowSec: Math.floor(st.now / 1000), closeSec: Math.floor(m.closeTime / 1000),
      }, { ...strategy, minEdge: strategy.minEdge + sessRisk.minEdgeAdd, inventorySkewPerContract: strategy.inventorySkewPerContract * sessRisk.skewMult }, {
        exits: policy === 'fair_value' || policy === 'hybrid' || (policy === 'confluence_ratchet' && !huntMode),
        blockReductions: huntMode,
      });
      for (const c of plan.cancel) await ex.cancelOrder(c.clientOrderId);

      for (const p of plan.place) {
        if (p.purpose === 'exit') {
          // Queue for next tick, like every other exit.
          if (!pending.has(m.ticker)) pending.set(m.ticker, { side: p.side, price: p.price, count: p.count, kind: 'fv' });
          continue;
        }
        // A taker entry against an existing position is an early exit in disguise
        // (e.g. "buy NO" while long YES). Only policies with fair-value exits may do it,
        // so hold / liquidity_ratchet are compared honestly. Passive maker quotes still
        // unwind at favourable prices under every policy.
        const cur = pos.position(m.ticker);
        if (p.purpose === 'entry' && (policy === 'hold' || policy === 'liquidity_ratchet') && cur !== 0 && Math.sign(cur) !== (p.side === 'bid' ? 1 : -1)) continue;
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
  exits.avgSlippage = slipN ? slipSum / slipN : null;
  res.vaultEnd = vault?.vaultTotal ?? 0;
  res.pocketEnd = vault?.pocketTotal ?? 0;
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
  const policies = arg('exits', EXIT_POLICIES.join(',')).split(',') as ExitPolicyName[];
  for (const p of policies) if (!EXIT_POLICIES.includes(p)) throw new Error(`unknown exit policy ${p}`);
  const ratchet: RatchetParams = {
    minFillRatio: Number(arg('ratchet-fill', String(DEFAULT_RATCHET.minFillRatio))),
    minWallAgeMs: Number(arg('ratchet-age', String(DEFAULT_RATCHET.minWallAgeMs / 1000))) * 1000,
    slippageTicks: Number(arg('ratchet-slip', String(DEFAULT_RATCHET.slippageTicks))),
  };
  const hunt: HuntParams = {
    targetMargin: Number(arg('hunt-margin', String(DEFAULT_HUNT.targetMargin))),
    minConfluence: Number(arg('hunt-confluence', String(DEFAULT_HUNT.minConfluence))),
  };
  const variants = grid.length * policies.length;
  // Price with the seasonal volatility profile when given (mirror production).
  const vpPath = arg('vol-profile', '');
  const volProfile = vpPath ? loadVolProfile(vpPath) : undefined;

  const results: BacktestResult[] = [];
  for (const minEdge of grid) {
    for (const exitPolicy of policies) {
      results.push(await runBacktest(dir, model, { ...cfg.strategy, minEdge }, cfg.risk, bankroll, {
        exitPolicy, ratchet, hunt, volProfile, applyVolSeasonality: Boolean(volProfile),
        sessionRisk: cfg.strategy.sessionRisk, huntSessionGuard: cfg.strategy.huntSessionGuard, huntTransitionBufferMin: cfg.strategy.huntTransitionBufferMin,
        vault: cfg.vault.enabled ? cfg.vault : undefined,
      }));
    }
  }
  const allWindows = [...new Set(results.flatMap((r) => [...r.windows.keys()]))].sort((a, b) => a - b);

  const summaries = results.map((r) => {
    const traded = [...r.windows.values()].filter((w) => w.contracts > 0);
    const perContract = traded.map((w) => w.pnl / w.contracts);
    const ci = bootstrapMeanCi(perContract);
    const series = allWindows.map((w) => r.windows.get(w)?.pnl ?? 0);
    const dsr = deflatedSharpe(series, priorTrials * variants);
    return { exit: r.exitPolicy, minEdge: r.minEdge, vault: +r.vaultEnd.toFixed(2), pocket: +r.pocketEnd.toFixed(2), windowsTraded: traded.length, fills: r.fills, contracts: r.contracts, fees: +r.fees.toFixed(2), pnl: +r.pnl.toFixed(2), edgePerContract: ci.mean, edgeCiLo: ci.lo, edgeCiHi: ci.hi, sharpePerWindow: sharpe(series), deflatedExcess: dsr.excess, dsrProb: dsr.probability };
  });
  console.table(summaries);
  console.log('exit diagnostics (regret > 0 means exiting cost money vs holding to settlement):');
  console.table(results.map((r) => ({
    exit: r.exitPolicy, minEdge: r.minEdge, exitOrders: r.exits.orders, exitFills: r.exits.fills, contracts: +r.exits.contracts.toFixed(2),
    proceeds: +r.exits.proceeds.toFixed(2), regret: +r.exits.regret.toFixed(2), stoppedWinners: r.exits.stoppedWinners,
    ratchetTriggers: r.exits.ratchetTriggers, gaps: r.exits.gaps, hybridHolds: r.exits.hybridHolds,
    huntOn: r.exits.huntActivations, huntOff: r.exits.huntDeactivations,
    avgSlippage: r.exits.avgSlippage === null ? null : +r.exits.avgSlippage.toFixed(4),
  })));
  console.log('P&L by session at window open (fee-inclusive):');
  console.table(results.flatMap((r) => Object.entries(r.bySession).map(([session, b]) => ({
    exit: r.exitPolicy, minEdge: r.minEdge, session, windows: b.windows, contracts: +b.contracts.toFixed(2), fees: +b.fees.toFixed(2),
    pnl: +b.pnl.toFixed(2), perContract: b.contracts ? +(b.pnl / b.contracts).toFixed(4) : null,
  }))));
  if (results.length > 1) {
    const matrix = allWindows.map((w) => results.map((r) => r.windows.get(w)?.pnl ?? 0));
    console.log('PBO (CSCV):', pbo(matrix));
  }
  // The model annotation always uses the production exit (fair_value) at the configured minEdge.
  const best = summaries.find((s) => s.minEdge === cfg.strategy.minEdge && s.exit === 'fair_value') ?? summaries[0];
  console.log(`windows traded: ${best.windowsTraded} (need >= 1000 independent windows before trusting any edge)`);

  if (process.argv.includes('--annotate') && fs.existsSync(modelPath)) {
    const params = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    params.validation = {
      ...params.validation,
      netEdgeCiLow: best.edgeCiLo,
      deflatedSharpe: best.deflatedExcess,
      variantsTried: priorTrials * variants,
      backtestWindowsTraded: best.windowsTraded,
    };
    params.validation.passed = Boolean(params.validation.passed) && best.edgeCiLo > 0 && best.deflatedExcess > 0 && best.windowsTraded >= 1000;
    fs.writeFileSync(modelPath, JSON.stringify(params, null, 2) + '\n');
    console.log(`annotated ${modelPath}: passed=${params.validation.passed}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) void main();

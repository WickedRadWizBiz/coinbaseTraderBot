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
import { assetFeatureMap, computeFeatureMap } from '../bot/model/featureEngine';
import { VolForecaster, VolModel } from '../bot/model/volModel';
import { applyFillModel, FillModel } from '../bot/tca/fillModel';
import { applyTakeGate } from '../bot/model/takeModel';
import { effectiveSigma, loadVolProfile, type VolProfile } from '../bot/model/volSeasonality';
import { sessionRiskFor, huntBlockedBySession, type SessionRiskProfile } from '../bot/model/sessionRisk';
import { sessionState } from '../bot/model/sessions';
import { Vault, type VaultConfig } from '../bot/vault/vault';
import { ladderQuotes } from '../bot/model/ladder';
import { priceContract, SETTLEMENT_AVG_SEC } from '../bot/model/fairValue';
import { kalshiMaintenance } from '../bot/model/sessions';
import { defaultTiers, tierAt, type TierPoint } from '../bot/risk/sizingTiers';
import { CadenceGate, inEntryWindow } from '../bot/strategy/cadence';
import type { MacroEvent } from '../bot/model/featureEngine';
import { loadCalendar } from '../bot/model/calendar';
import { MetaModel } from '../bot/model/metaModel';
import type { OrderIntent } from '../bot/oms/oms';
import { PositionBook } from '../bot/oms/positions';
import { PaperExchange } from '../bot/paper/paperExchange';
import { marketWorstLoss } from '../bot/risk/exposure';
import { RiskGateway } from '../bot/risk/riskGateway';
import { decide } from '../bot/strategy/fairValueStrategy';
import { ConfluenceRatchetExit, DEFAULT_HUNT, DEFAULT_RATCHET, EXIT_POLICIES, ExitPolicyName, HuntParams, LiquidityRatchet, RatchetParams } from '../bot/strategy/exitPolicies';
import { readRecordings, ReplayState } from './replay';
import { bootstrapMeanCi, deflatedSharpe, pbo, rng, sharpe } from './stats';

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
  /** Early take-profits at the bid (confluence flipped, session unsafe, gap through the stop). */
  huntProfitTakes: number;
  /** Mean (stop - fill price) in side terms for ratchet exits; positive = filled below the stop. */
  avgSlippage: number | null;
}

export interface SessionBreakdown { windows: number; pnl: number; contracts: number; fees: number }

/** One traded contract (a market in which a position was taken), settled. */
export interface TradeResult { ticker: string; closeTs: number; pnl: number; contracts: number; kind: string }

export interface BacktestResult {
  exitPolicy: ExitPolicyName;
  /** Variant label (hunt variants carry their parameters). */
  label: string;
  huntParams?: { hunt: HuntParams; ratchet: RatchetParams };
  /** Vault and pocket at the end of the run (bookkeeping; reduces tradable bankroll). */
  vaultEnd: number;
  pocketEnd: number;
  /** P&L attributed to the session in effect when each 15-minute window opened. */
  bySession: Record<string, SessionBreakdown>;
  exits: ExitStats;
  /** Settled contracts that were traded, for EV-per-trade and trades-per-day. */
  trades: TradeResult[];
  /** Mode B take-profit fills. */
  takeProfitFills: number;
  /** Injected latency and its effects (see BacktestLatency). */
  latency?: { orderMs: number; cancelMs: number; jitterMs: number; sent: number; cancelRaceFills: number; cancelRaceContracts: number; lateKills: number };
  /** Evaluations that ran the full (entry) decision under the cadence. */
  entryEvaluations: number;
  days: number;
  minEdge: number;
  windows: Map<number, { pnl: number; contracts: number; fees: number }>;
  fills: number;
  contracts: number;
  fees: number;
  pnl: number;
}

/**
 * Execution latency: every order and cancel the bot sends reaches the exchange `orderMs` /
 * `cancelMs` (+/- jitter) after the decision, against whatever the book and the tape look like
 * THEN. So a taker order fills at the later price, a maker quote joins the queue later (trades that
 * printed in flight cannot fill it), and a cancel can lose the race against a trade that reaches
 * the quote first (counted as `cancelRaceFills`). While a ticker has anything in flight the
 * strategy does not plan new quotes for it, as the engine's per-market busy flag does live.
 */
export interface BacktestLatency { orderMs: number; cancelMs?: number; jitterMs?: number }

export async function runBacktest(
  dir: string, model: MetaModel, strategy: StrategyConfig, limits: RiskLimits, bankroll0: number,
  opts: { exitPolicy?: ExitPolicyName; ratchet?: RatchetParams; hunt?: HuntParams; volProfile?: VolProfile; applyVolSeasonality?: boolean; volModel?: VolModel; fillModel?: FillModel; sessionRisk?: SessionRiskProfile; huntSessionGuard?: boolean; huntTransitionBufferMin?: number; vault?: VaultConfig; calendar?: MacroEvent[]; sizingTiers?: TierPoint[]; latency?: BacktestLatency } = {},
): Promise<BacktestResult> {
  const policy = opts.exitPolicy ?? 'fair_value';
  const st = new ReplayState();
  const volFc = new VolForecaster(opts.volModel);
  const pos = new PositionBook();
  const ex = new PaperExchange(undefined, bankroll0, (t) => st.books.get(t), () => DEFAULT_FEES, () => st.now);
  const gateway = new RiskGateway(limits);
  const exits: ExitStats = { orders: 0, fills: 0, contracts: 0, proceeds: 0, regret: 0, stoppedWinners: 0, ratchetTriggers: 0, gaps: 0, hybridHolds: 0, huntActivations: 0, huntDeactivations: 0, huntProfitTakes: 0, avgSlippage: null };
  const vault = opts.vault ? new Vault(opts.vault, undefined, () => st.now) : undefined;
  const res: BacktestResult = { exitPolicy: policy, label: policy === 'confluence_ratchet' ? `confluence_ratchet[m=${(opts.hunt ?? DEFAULT_HUNT).targetMargin},f=${(opts.ratchet ?? DEFAULT_RATCHET).minFillRatio}]` : policy, huntParams: policy === 'confluence_ratchet' ? { hunt: opts.hunt ?? DEFAULT_HUNT, ratchet: opts.ratchet ?? DEFAULT_RATCHET } : undefined, vaultEnd: 0, pocketEnd: 0, bySession: {}, exits, trades: [], takeProfitFills: 0, latency: { orderMs: opts.latency?.orderMs ?? 0, cancelMs: opts.latency?.cancelMs ?? opts.latency?.orderMs ?? 0, jitterMs: opts.latency?.jitterMs ?? 0, sent: 0, cancelRaceFills: 0, cancelRaceContracts: 0, lateKills: 0 }, entryEvaluations: 0, days: 0, minEdge: strategy.minEdge, windows: new Map(), fills: 0, contracts: 0, fees: 0, pnl: 0 };
  const cadence = new CadenceGate(strategy);
  const lastPos = new Map<string, number>();
  // Bankroll tiers from the tradable high-water mark, with the tier's drawdown brake (mirrors the engine).
  const tiers = opts.sizingTiers ?? defaultTiers({ risk: limits, strategy });
  let peakBank = 0;
  const stratRun: StrategyConfig = { ...strategy, exitPolicy: policy === 'take_profit' ? 'take_profit' : policy === 'hold' ? 'hold' : strategy.exitPolicy === 'take_profit' ? 'fair_value' : strategy.exitPolicy };
  let firstTs = 0;
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
    if (cancelInFlight.has(f.orderId)) { L.cancelRaceFills++; L.cancelRaceContracts += f.count; }
    if (f.clientOrderId?.endsWith('-tp')) res.takeProfitFills++;
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

  // Latency: actions wait in `inflight` until their arrival time; each runs against the state at that time.
  const L = res.latency!;
  const jitter = rng(17);
  const inflight: Array<{ due: number; ticker: string; orderId?: string; run: () => Promise<void> }> = [];
  const cancelInFlight = new Set<string>();
  const send = async (ticker: string, kind: 'order' | 'cancel', run: () => Promise<void>, orderId?: string): Promise<void> => {
    const base = kind === 'cancel' ? L.cancelMs : L.orderMs;
    if (base <= 0 && L.jitterMs <= 0) return run();
    L.sent++;
    const due = st.now + Math.max(0, base + (jitter() * 2 - 1) * L.jitterMs);
    let i = inflight.length;
    while (i > 0 && inflight[i - 1].due > due) i--;
    inflight.splice(i, 0, { due, ticker, orderId: kind === 'cancel' ? orderId : undefined, run });
    if (kind === 'cancel' && orderId) cancelInFlight.add(orderId);
  };
  const inflightFor = (t: string) => inflight.some((x) => x.ticker === t);
  const cancelNow = async (orderId: string) => { cancelInFlight.delete(orderId); try { await ex.cancelOrder(orderId); } catch { /* already gone: the cancel lost the race */ L.lateKills++; } };

  let lastTick = 0;
  for await (const e of readRecordings(dir)) {
    while (inflight.length && inflight[0].due <= e.t) await inflight.shift()!.run();
    st.apply(e);
    if (!firstTs) firstTs = st.now;
    if (e.k === 'trade') ex.onTrade(e.ticker, e.price, e.count, e.takerSide, e.ts);
    if (e.tie) continue; // the rest of this instant first
    if (st.now - lastTick < 1000) continue;
    lastTick = st.now;

    for (const m of [...st.markets.values()]) {
      // Recorded for research, or synthesized from price history (quoted at the model's own fair value): never traded.
      if (m.recordOnly || m.synthetic) { if (st.now >= m.closeTime + 90_000) st.markets.delete(m.ticker); continue; }
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
          cadence.forget(m.ticker);
          pending.delete(m.ticker);
          const p = pos.get(m.ticker);
          if (p && !p.settled) {
            pos.settle(m.ticker, result, st.now);
            const traded = res.windows.get(m.closeTime)?.contracts ?? 0;
            if (traded > 0) res.trades.push({ ticker: m.ticker, closeTs: m.closeTime, pnl: p.realized ?? 0, contracts: traded, kind: m.kind });
            const b = res.windows.get(m.closeTime) ?? { pnl: 0, contracts: 0, fees: 0 };
            b.pnl += p.realized ?? 0;
            res.windows.set(m.closeTime, b);
            res.pnl += p.realized ?? 0;
            if ((p.realized ?? 0) > 0) vault?.onSettled(p.realized!, m.ticker, st.now, peakBank);
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
      const terms = st.terms(m);
      const open = (await ex.getOpenOrders()).filter((o) => o.ticker === m.ticker);
      if (!book?.isUsable(st.now, limits.maxBookAgeMs) || !bid || !ask || !spot || !vol || !terms) {
        for (const o of open) if (!cancelInFlight.has(o.orderId)) await send(m.ticker, 'cancel', () => cancelNow(o.orderId), o.orderId);
        pending.delete(m.ticker); // never fire a queued exit into a stale book later
        continue;
      }
      const tauSec = (m.closeTime - st.now) / 1000;
      const settle = tauSec <= SETTLEMENT_AVG_SEC ? idx!.settlement(m.closeTime, st.now, SETTLEMENT_AVG_SEC) : undefined;
      const observed = settle?.avg, observedCount = settle?.n;
      const sigmaFv = (opts.applyVolSeasonality ? effectiveSigma(vol.sigmaPerSqrtSec, opts.volProfile, m.asset, st.now, m.closeTime) : vol.sigmaPerSqrtSec)
        * volFc.multiplier(m.asset, st.now, vol.sigmaPerSqrtSec, tauSec, () => assetFeatureMap(m.asset, st.now, { index: idx, spot: st.spot.get(m.asset), bars: st.features.bars.get(m.asset), candles: st.features.candles.get(m.asset), usdtd: st.usdtd, btcd: st.btcd, perp: st.features.perps.get(m.asset) }));
      const fv = priceContract(terms, { spot: spot.value, sigmaPerSqrtSec: sigmaFv, tauSec, observedAvg: observed, observedCount, nu: model.params.tNu });
      if (!fv) continue;
      const mid = (bid.price + ask.price) / 2;
      const fmap = computeFeatureMap({
        now: st.now, fairValue: fv.pYes, mid, tauSec, sigmaPerSqrtSec: vol.sigmaPerSqrtSec, referenceSigma: model.params.referenceSigma, inWindow: fv.regime !== 'pre_window', book, micro: st.features.micro.get(m.ticker), index: idx!, spot: st.spot.get(m.asset), asset: m.asset, usdtd: st.usdtd, btcd: st.btcd, closeTs: m.closeTime, volProfile: opts.volProfile, asiaRange: st.features.asiaRange.get(m.asset),
        kind: m.kind, strike: terms.strike, cap: terms.cap, d2: fv.d2, vEff: fv.vEff, sigmaPricing: sigmaFv, tNu: model.params.tNu, bars: st.features.bars.get(m.asset), openTime: m.openTime, calendar: opts.calendar,
        ticker: m.ticker, siblings: m.kind === 'updown' ? undefined : ladderQuotes(st.markets.values(), (t) => st.books.get(t), m.asset, m.closeTime),
        perp: st.features.perps.get(m.asset), candles: st.features.candles.get(m.asset), snn: st.snnContext(m.asset, m.ticker),
      });
      const pred = model.predictDetailed(fmap, fv.pYes);
      const pYes = pred.p;
      const pMarket = model.marketProbability(mid);
      const ret = idx!.trailingLogReturn(st.now, strategy.fastMoveWindowSec * 1000);
      const fastMove = ret !== undefined && Math.abs(ret) > strategy.fastMoveSigmas * vol.sigmaPerSqrtSec * Math.sqrt(strategy.fastMoveWindowSec);
      vault?.tick(st.now);
      const bankroll = Math.max(0, (await ex.getBalance()) + pos.open().reduce((s, p) => s + PositionBook.maxLoss(p), 0) - (vault?.reserved() ?? 0));
      peakBank = Math.max(peakBank, bankroll);
      const tier = tierAt(tiers, peakBank);
      const ddScale = peakBank > 0 ? Math.max(0, 1 - (1 - bankroll / peakBank) / tier.ddScaleAt) : 1;
      const tierLimits = { maxOrderRiskFrac: tier.orderFrac, maxWindowRiskFrac: tier.windowFrac, maxTotalRiskFrac: tier.totalFrac, dailyLossLimitFrac: tier.dailyLossFrac, dailyLossLimitUsd: tier.dailyLossUsd };
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
          await send(m.ticker, 'order', async () => { try { await ex.createOrder({ ticker: m.ticker, side: due.side, count, price: due.price, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: true, selfTradePrevention: 'taker_at_cross', clientOrderId: id }); } catch { /* no fill */ } });
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
        if (d.event === 'deactivated_giveback') exits.huntDeactivations++;
        if (d.event === 'profit_take_confluence' || d.event === 'profit_take_session' || d.event === 'profit_take_gap') exits.huntProfitTakes++;
        if (d.event === 'gapped') exits.gaps++;
        if (d.plan && !pending.has(m.ticker)) {
          exits.ratchetTriggers++;
          pending.set(m.ticker, { side: d.plan.side, price: d.plan.price, count: d.plan.count, kind: 'rt', stop: d.plan.stop });
        }
      }

      if (inflightFor(m.ticker)) continue; // orders/cancels still travelling: no new plan until they land

      // Relaxed cadence and entry windows, mirroring the engine.
      const mt = kalshiMaintenance(st.now);
      const kindWindow = strategy.cadence === 'relaxed'
        ? inEntryWindow(m.kind, tauSec, strategy.entryWindowUpdown, strategy.entryWindowHourly) && (m.kind === 'updown' || (mid >= strategy.hourlyMidBand[0] && mid <= strategy.hourlyMidBand[1]))
        : true;
      const entryWindowOpen = kindWindow && !mt.inside && mt.minutesTo > 30 && bankroll >= strategy.minTradableBankrollUsd;
      const rb = q('bid'), ra = q('ask');
      const through = (r: { price: number } | undefined, best: number) => r !== undefined && Math.abs(best - r.price) >= 2 * strategy.requoteThreshold - 1e-9;
      const posC = pos.position(m.ticker);
      const positionChanged = (lastPos.get(m.ticker) ?? 0) !== posC;
      lastPos.set(m.ticker, posC);
      const reason = cadence.check(m.ticker, { now: st.now, fairValue: pYes, entryWindowOpen, hasResting: Boolean(rb || ra), bookThroughQuote: through(rb, bid.price) || through(ra, ask.price), positionChanged });
      if (reason) res.entryEvaluations++;
      const pNow = pos.get(m.ticker);
      const entrySide = pNow && pNow.yes > 0 ? -pNow.netCash / pNow.yes : pNow && pNow.yes < 0 ? 1 - pNow.netCash / -pNow.yes : undefined;
      const plan = decide({
        ticker: m.ticker, pYes, bestBid: bid, bestAsk: ask, position: pos.position(m.ticker), bankroll,
        maxOrderRiskUsd: tier.orderFrac * bankroll * sessRisk.sizeMult, maxContracts: Math.floor(limits.maxContractsPerOrder * sessRisk.sizeMult * 100) / 100, minSidePrice: limits.minSidePrice,
        tauSec, noEntryBeforeCloseSec: limits.noEntryBeforeCloseSec, fastMove, tickSize: m.tickSize, fees: DEFAULT_FEES,
        restingBid: rb, restingAsk: ra, nowSec: Math.floor(st.now / 1000), closeSec: Math.floor(m.closeTime / 1000),
        pMarket, pStd: pred.std, makerBuffer: strategy.makerBuffer, entrySidePrice: entrySide !== undefined && entrySide > 0 && entrySide < 1 ? entrySide : undefined,
        entryWindowOpen, exitWindowOpen: tauSec > strategy.noExitBeforeCloseSec,
      }, { ...stratRun, kellyFraction: tier.kellyFraction * ddScale, minEdge: strategy.minEdge + sessRisk.minEdgeAdd, inventorySkewPerContract: strategy.inventorySkewPerContract * sessRisk.skewMult }, {
        exits: policy === 'fair_value' || policy === 'take_profit' || policy === 'hybrid' || (policy === 'confluence_ratchet' && !huntMode),
        blockReductions: huntMode,
        entries: Boolean(reason),
      });
      if (strategy.takeGate === 'validated') applyTakeGate(plan, model.params.take, { pYes, features: fmap, tauSec, bid: bid.price, ask: ask.price, pStd: pred.std, margin: strategy.takeMargin });
      // Fill model (validated only), as live: quote, cross or skip each maker entry by expected value.
      applyFillModel(plan, opts.fillModel, { q: pYes, book, tick: m.tickSize, tauSec, sigma: vol.sigmaPerSqrtSec, features: fmap, minEv: strategy.fillMinEv, takerMinEdge: strategy.takerBuffer + strategy.minEdge });
      for (const c of plan.cancel) if (!cancelInFlight.has(c.clientOrderId)) await send(m.ticker, 'cancel', () => cancelNow(c.clientOrderId), c.clientOrderId);

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
          windowRisk, totalRisk, ordersLastMinute: 0, openOrders: openNow.length, modelLiveBlockers: [], limitOverrides: tierLimits,
        });
        if (!d.ok) continue;
        const clientOrderId = `${m.ticker}-${st.now}-${p.side}-${p.purpose}${p.why.startsWith('take-profit') ? '-tp' : ''}`;
        await send(m.ticker, 'order', async () => {
          try {
            await ex.createOrder({ ticker: m.ticker, side: p.side, count: p.count, price: p.price, timeInForce: p.timeInForce, postOnly: p.postOnly, reduceOnly: p.reduceOnly, selfTradePrevention: 'taker_at_cross', clientOrderId, expirationTime: p.expirationTime });
          } catch { /* rejected like the exchange would */ }
        });
      }
    }
  }
  exits.avgSlippage = slipN ? slipSum / slipN : null;
  res.days = Math.max(1 / 24, (st.now - firstTs) / 86_400_000);
  res.vaultEnd = vault?.vaultTotal ?? 0;
  res.pocketEnd = vault?.pocketTotal ?? 0;
  return res;
}

export interface HuntEvaluation {
  baseline: 'fair_value';
  hunt: { targetMargin: number; minConfluence: number; minFillRatio: number; minWallAgeMs: number; slippageTicks: number };
  windows: number;
  pnlHunt: number;
  pnlBaseline: number;
  pairedDiffMean: number;
  pairedDiffCiLo: number;
  pairedDiffCiHi: number;
  /** Deflated for the number of hunt variants tried (the best of the grid is reported). */
  dsrProbability: number;
  activations: number;
  profitTakes: number;
  exitRegret: number;
  variants: number;
  /** Hunt mode may be used live (and its parameters applied) only when true. */
  huntOk: boolean;
}

/** Paired comparison: best hunt variant vs the fair-value exit on identical windows. */
export function evaluateHunt(results: BacktestResult[], allWindows: number[], minEdge: number): HuntEvaluation | undefined {
  const base = results.find((r) => r.exitPolicy === 'fair_value' && r.minEdge === minEdge);
  const hunts = results.filter((r) => r.exitPolicy === 'confluence_ratchet' && r.minEdge === minEdge && r.huntParams);
  if (!base || !hunts.length) return undefined;
  const top = hunts.reduce((a, b) => (b.pnl > a.pnl ? b : a));
  const ws = allWindows.filter((w) => (base.windows.get(w)?.contracts ?? 0) > 0 || (top.windows.get(w)?.contracts ?? 0) > 0);
  const diffs = ws.map((w) => (top.windows.get(w)?.pnl ?? 0) - (base.windows.get(w)?.pnl ?? 0));
  const ci = bootstrapMeanCi(diffs);
  const dsr = diffs.length > 2 ? deflatedSharpe(diffs, hunts.length) : { probability: NaN };
  const hp = top.huntParams!;
  return {
    baseline: 'fair_value',
    hunt: { targetMargin: hp.hunt.targetMargin, minConfluence: hp.hunt.minConfluence, minFillRatio: hp.ratchet.minFillRatio, minWallAgeMs: hp.ratchet.minWallAgeMs, slippageTicks: hp.ratchet.slippageTicks },
    windows: diffs.length, pnlHunt: top.pnl, pnlBaseline: base.pnl,
    pairedDiffMean: ci.mean, pairedDiffCiLo: ci.lo, pairedDiffCiHi: ci.hi, dsrProbability: dsr.probability,
    activations: top.exits.huntActivations, profitTakes: top.exits.huntProfitTakes, exitRegret: top.exits.regret, variants: hunts.length,
    huntOk: diffs.length >= 300 && ci.lo > 0 && dsr.probability > 0.95,
  };
}

export async function backtestMain(argOf: (k: string, d: string) => string = cliArg, annotate: boolean = process.argv.includes('--annotate')) {
  const dir = argOf('recordings', 'data/recordings');
  const modelPath = argOf('model', 'params/model.json');
  const model = fs.existsSync(modelPath) ? MetaModel.load(modelPath) : MetaModel.identity();
  const cfg = loadConfig({ ...process.env, DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32), TRADING_MODE: 'paper' });
  const grid = argOf('grid', String(cfg.strategy.minEdge)).split(',').map(Number);
  const bankroll = Number(argOf('bankroll', String(cfg.paperBankrollUsd)));
  const priorTrials = Number(argOf('trials', String((model.params.validation?.variantsTried ?? 1))));
  const policies = argOf('exits', EXIT_POLICIES.join(',')).split(',') as ExitPolicyName[];
  for (const p of policies) if (!EXIT_POLICIES.includes(p)) throw new Error(`unknown exit policy ${p}`);
  const ratchet: RatchetParams = {
    minFillRatio: Number(argOf('ratchet-fill', String(DEFAULT_RATCHET.minFillRatio))),
    minWallAgeMs: Number(argOf('ratchet-age', String(DEFAULT_RATCHET.minWallAgeMs / 1000))) * 1000,
    slippageTicks: Number(argOf('ratchet-slip', String(DEFAULT_RATCHET.slippageTicks))),
  };
  const hunt: HuntParams = {
    targetMargin: Number(argOf('hunt-margin', String(DEFAULT_HUNT.targetMargin))),
    minConfluence: Number(argOf('hunt-confluence', String(DEFAULT_HUNT.minConfluence))),
  };
  // Hunt mode is evaluated over a parameter grid (target margin x wall fill ratio); every variant
  // counts toward the Deflated Sharpe.
  const huntMargins = argOf('hunt-grid', policies.includes('confluence_ratchet') ? '0.01,0.02,0.04' : String(hunt.targetMargin)).split(',').map(Number);
  const huntFills = argOf('ratchet-fill-grid', policies.includes('confluence_ratchet') ? '1,2' : String(ratchet.minFillRatio)).split(',').map(Number);
  // Price with the seasonal volatility profile when given (mirror production).
  const vpPath = argOf('vol-profile', '');
  const volProfile = vpPath ? loadVolProfile(vpPath) : undefined;
  // Tree vol forecast / fill model, as production applies them (each only when validated).
  const vmPath = argOf('vol-model', '');
  const volModel = vmPath ? VolModel.load(vmPath) : undefined;
  const fmPath = argOf('fill-model', '');
  const fillModel = fmPath ? FillModel.load(fmPath) : undefined;
  const calendar = loadCalendar(argOf('calendar', 'params/calendar.json'));
  // Execution latency (ms): --latency-ms 250 [--cancel-latency-ms 150] [--latency-jitter-ms 100]. Default: none.
  const latency: BacktestLatency | undefined = Number(argOf('latency-ms', '0')) > 0 || Number(argOf('latency-jitter-ms', '0')) > 0
    ? { orderMs: Number(argOf('latency-ms', '0')), cancelMs: argOf('cancel-latency-ms', '') ? Number(argOf('cancel-latency-ms', '0')) : undefined, jitterMs: Number(argOf('latency-jitter-ms', '0')) }
    : undefined;

  const results: BacktestResult[] = [];
  for (const minEdge of grid) {
    for (const exitPolicy of policies) {
      const combos = exitPolicy === 'confluence_ratchet'
        ? huntMargins.flatMap((m) => huntFills.map((f) => ({ hunt: { ...hunt, targetMargin: m }, ratchet: { ...ratchet, minFillRatio: f } })))
        : [{ hunt, ratchet }];
      for (const c of combos) {
        results.push(await runBacktest(dir, model, { ...cfg.strategy, minEdge }, cfg.risk, bankroll, {
          exitPolicy, ratchet: c.ratchet, hunt: c.hunt, volProfile, applyVolSeasonality: Boolean(volProfile), volModel, fillModel,
          sessionRisk: cfg.strategy.sessionRisk, huntSessionGuard: cfg.strategy.huntSessionGuard, huntTransitionBufferMin: cfg.strategy.huntTransitionBufferMin,
          vault: cfg.vault.enabled ? cfg.vault : undefined, calendar, sizingTiers: cfg.sizingTiers, latency,
        }));
      }
    }
  }
  const variants = results.length;
  const allWindows = [...new Set(results.flatMap((r) => [...r.windows.keys()]))].sort((a, b) => a - b);

  const summaries = results.map((r) => {
    const traded = [...r.windows.values()].filter((w) => w.contracts > 0);
    const perContract = traded.map((w) => w.pnl / w.contracts);
    const ci = bootstrapMeanCi(perContract);
    const series = allWindows.map((w) => r.windows.get(w)?.pnl ?? 0);
    const dsr = deflatedSharpe(series, priorTrials * variants);
    const perTrade = bootstrapMeanCi(r.trades.map((t) => t.pnl));
    return {
      exit: r.label, minEdge: r.minEdge, vault: +r.vaultEnd.toFixed(2), pocket: +r.pocketEnd.toFixed(2), windowsTraded: traded.length, fills: r.fills, contracts: r.contracts, fees: +r.fees.toFixed(2), pnl: +r.pnl.toFixed(2),
      trades: r.trades.length, tradesPerDay: +(r.trades.length / r.days).toFixed(1), pnlPerTrade: perTrade.mean, pnlPerTradeCiLo: perTrade.lo, pnlPerDay: +(r.pnl / r.days).toFixed(2), tpFills: r.takeProfitFills, latencyMs: r.latency?.orderMs ?? 0, cancelRaceFills: r.latency?.cancelRaceFills ?? 0,
      edgePerContract: ci.mean, edgeCiLo: ci.lo, edgeCiHi: ci.hi, sharpePerWindow: sharpe(series), deflatedExcess: dsr.excess, dsrProb: dsr.probability,
    };
  });
  console.table(summaries);
  console.log('Relaxed-spec target: $1-$10 average profit per trade at this bankroll, 10-25 trades/day; $100/day is a monthly average.');
  console.log('exit diagnostics (regret > 0 means exiting cost money vs holding to settlement):');
  console.table(results.map((r) => ({
    exit: r.label, minEdge: r.minEdge, exitOrders: r.exits.orders, exitFills: r.exits.fills, contracts: +r.exits.contracts.toFixed(2),
    proceeds: +r.exits.proceeds.toFixed(2), regret: +r.exits.regret.toFixed(2), stoppedWinners: r.exits.stoppedWinners,
    ratchetTriggers: r.exits.ratchetTriggers, gaps: r.exits.gaps, hybridHolds: r.exits.hybridHolds,
    huntOn: r.exits.huntActivations, huntOff: r.exits.huntDeactivations, huntTakes: r.exits.huntProfitTakes,
    avgSlippage: r.exits.avgSlippage === null ? null : +r.exits.avgSlippage.toFixed(4),
  })));
  console.log('P&L by session at window open (fee-inclusive):');
  console.table(results.flatMap((r) => Object.entries(r.bySession).map(([session, b]) => ({
    exit: r.exitPolicy, minEdge: r.minEdge, session, windows: b.windows, contracts: +b.contracts.toFixed(2), fees: +b.fees.toFixed(2),
    pnl: +b.pnl.toFixed(2), perContract: b.contracts ? +(b.pnl / b.contracts).toFixed(4) : null,
  }))));
  let pboValue: number | undefined;
  if (results.length > 1) {
    const matrix = allWindows.map((w) => results.map((r) => r.windows.get(w)?.pnl ?? 0));
    const pb = pbo(matrix, Math.min(16, Math.max(2, Math.floor(allWindows.length / 20) * 2)));
    console.log('PBO (CSCV):', pb);
    if (Number.isFinite(pb.pbo)) pboValue = pb.pbo;
  }
  // The model annotation uses the production exit policy at the configured minEdge.
  const prod = cfg.strategy.exitPolicy === 'confluence_ratchet' ? 'fair_value' : cfg.strategy.exitPolicy;
  const best = summaries.find((s) => s.minEdge === cfg.strategy.minEdge && s.exit === prod) ?? summaries[0];
  const exitEvaluation = evaluateHunt(results, allWindows, cfg.strategy.minEdge);
  if (exitEvaluation) console.log('hunt mode vs fair-value exit (paired per window):', exitEvaluation);
  console.log(`windows traded: ${best.windowsTraded} (need >= 1000 independent windows before trusting any edge)`);

  if (annotate && fs.existsSync(modelPath)) {
    const params = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    params.validation = {
      ...params.validation,
      netEdgeCiLow: best.edgeCiLo,
      deflatedSharpe: best.deflatedExcess,
      dsrProbability: best.dsrProb,
      ...(pboValue !== undefined ? { pbo: pboValue } : {}),
      variantsTried: priorTrials * variants,
      backtestWindowsTraded: best.windowsTraded,
      backtestPnlPerTrade: best.pnlPerTrade,
      backtestTradesPerDay: best.tradesPerDay,
      ...(exitEvaluation ? { exitEvaluation } : {}),
    };
    params.validation.passed = Boolean(params.validation.passed) && best.edgeCiLo > 0 && best.deflatedExcess > 0 && best.dsrProb > 0.95
      && (pboValue === undefined || pboValue < 0.2) && best.windowsTraded >= 1000;
    fs.writeFileSync(modelPath, JSON.stringify(params, null, 2) + '\n');
    console.log(`annotated ${modelPath}: passed=${params.validation.passed}`);
  }
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void backtestMain();

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

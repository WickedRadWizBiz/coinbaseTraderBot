// Trading engine: the only place that turns model output into orders.
//
// Each tick, for each active market:
//   market data (fresh?) -> fair value -> meta-model -> strategy plan
//   -> cancels first -> RiskGateway.check (fails closed) -> OMS.submit
// Every decision is audited with the model id and inputs.

import crypto from 'crypto';
import type { Alerter } from './alerts/alerter';
import type { AuditLog } from './audit/auditLog';
import type { Config } from './config';
import type { ExchangeGateway } from './kalshi/types';
import type { ActiveMarket, MarketData } from './marketdata/marketData';
import { computeFeatureMap } from './model/featureEngine';
import { fairValue, SETTLEMENT_AVG_SEC } from './model/fairValue';
import { explain, type Driver, type MetaModel } from './model/metaModel';
import type { Oms, OrderIntent } from './oms/oms';
import { isLive } from './oms/orderState';
import { PositionBook } from './oms/positions';
import { marketWorstLoss, RestingLike } from './risk/exposure';
import type { KillSwitch } from './risk/killSwitch';
import { RiskContext, RiskGateway } from './risk/riskGateway';
import type { Reconciler } from './recon/reconciler';
import { decide, MarketView, OrderPlan } from './strategy/fairValueStrategy';
import { logger } from './util/log';

const log = logger('engine');

export interface MarketStatus {
  ticker: string;
  asset: string;
  closeTs: number;
  strike?: number;
  strikeSource?: string;
  spot?: number;
  sigma?: number;
  fairValue?: number;
  pYes?: number;
  bestBid?: number;
  bestAsk?: number;
  position: number;
  blocked?: string;
  notes: string[];
  /** Log-odds shift the model applied on top of fair value, and what drove it. */
  modelShift?: number;
  drivers?: Driver[];
  /** Current values of the macro/confluence inputs for display. */
  macro?: Record<string, number | null>;
  updatedTs: number;
}

export interface EngineDeps {
  cfg: Readonly<Config>;
  audit: AuditLog;
  alerter: Alerter;
  md: MarketData;
  gateway: ExchangeGateway;
  oms: Oms;
  risk: RiskGateway;
  kill: KillSwitch;
  recon: Reconciler;
  model: MetaModel;
  now?: () => number;
}

export class Engine {
  private readonly busy = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private lastTickTs = 0;
  private lastDecisionAudit = new Map<string, number>();
  private lastRejectAudit = new Map<string, number>();
  private dataHalt: string | undefined = 'awaiting market data';
  balance: number | undefined;
  readonly status = new Map<string, MarketStatus>();
  private readonly now: () => number;

  constructor(private readonly d: EngineDeps) {
    this.now = d.now ?? Date.now;
  }

  async start(): Promise<void> {
    const { cfg, md, recon, oms, kill } = this.d;
    await md.refreshCatalog();
    const first = await recon.run('startup');
    if (first?.balance !== undefined) this.balance = first.balance;

    this.timers.push(setInterval(() => void this.tick(), 1000));
    this.timers.push(setInterval(() => void md.refreshCatalog(), 20_000));
    this.timers.push(setInterval(async () => {
      const r = await recon.run('interval');
      if (r?.balance !== undefined) this.balance = r.balance;
    }, cfg.reconcileIntervalMs));
    this.timers.push(setInterval(() => this.watchdog(), 1000));

    md.on('reconnected', async () => {
      this.dataHalt = undefined;
      const r = await recon.run('ws_reconnect');
      if (r?.balance !== undefined) this.balance = r.balance;
    });
    md.on('disconnected', () => {
      this.dataHalt = 'market data disconnected';
      void this.cancelAllQuotes('market data disconnected');
    });
    md.on('lifecycle', (e: { ticker: string; event: string; result?: string }) => {
      if ((e.result === 'yes' || e.result === 'no') && /settle|determin/i.test(e.event)) {
        oms.settle(e.ticker, e.result);
      }
    });
    oms.on('order_error', (n: number, msg: string) => {
      if (n >= cfg.risk.maxConsecutiveOrderErrors) void kill.engage(`${n} consecutive order errors (last: ${msg})`, 'oms');
    });
    oms.on('orphan_fill', (f) => this.d.alerter.notify('critical', 'orphan-fill', `Fill for unknown order on ${f.ticker} (${f.count} @ ${f.price})`));
    log.info('engine started', { mode: cfg.mode, model: this.d.model.id, markets: md.activeMarkets().length });
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Dead-man: if the tick loop stalls, pull every resting order. */
  private watchdog(): void {
    if (!this.lastTickTs) return;
    const stalled = this.now() - this.lastTickTs > this.d.cfg.heartbeatTimeoutMs;
    if (stalled && this.dataHalt !== 'engine heartbeat stalled') {
      this.dataHalt = 'engine heartbeat stalled';
      this.d.alerter.notify('critical', 'heartbeat', 'Engine heartbeat stalled; cancelling all orders');
      void this.d.oms.cancelAll('heartbeat stalled');
    }
  }

  haltReasons(): string[] {
    const r: string[] = [];
    if (this.d.recon.halted) r.push('reconciliation not clean');
    if (this.dataHalt) r.push(this.dataHalt);
    if (this.balance === undefined) r.push('balance unknown');
    return r;
  }

  /** Bankroll for fractional limits: cash + premium committed to open positions. */
  bankroll(): number | undefined {
    if (this.balance === undefined) return undefined;
    const committed = this.d.oms.positions.open().reduce((s, m) => s + PositionBook.maxLoss(m), 0);
    return this.balance + committed;
  }

  /** Today's (UTC) PnL: realized settlements + conservative mark-to-market. */
  dailyPnl(): number {
    const dayStart = Date.parse(new Date(this.now()).toISOString().slice(0, 10));
    let pnl = 0;
    for (const m of this.d.oms.positions.all()) {
      if (m.settled) {
        if ((m.settledTs ?? 0) >= dayStart) pnl += m.realized ?? 0;
        continue;
      }
      const book = this.d.md.books.get(m.ticker);
      // Liquidation mark: long YES at the bid, long NO at the ask; no book = worst case.
      const mark = m.yes > 0 ? book?.bestBid()?.price ?? 0 : m.yes < 0 ? book?.bestAsk()?.price ?? 1 : 0;
      pnl += PositionBook.markToMarket(m, mark);
    }
    return pnl;
  }

  private resting(ticker?: string): RestingLike[] {
    return this.d.oms.liveOrders()
      .filter((o) => !o.reduceOnly && (!ticker || o.ticker === ticker))
      .map((o) => ({ ticker: o.ticker, side: o.side, price: o.price, remaining: Math.max(0, o.count - o.exchangeFillCount), isTaker: !o.postOnly }));
  }

  private marketRisk(ticker: string, extra?: RestingLike): number {
    const r = this.resting(ticker);
    if (extra) r.push(extra);
    return marketWorstLoss(this.d.oms.positions.get(ticker), r, this.d.md.feesFor(ticker));
  }

  private riskTotals(windowCloseTs: number): { window: number; total: number } {
    const tickers = new Set<string>([...this.d.oms.positions.unsettled().map((m) => m.ticker), ...this.d.oms.liveOrders().map((o) => o.ticker)]);
    let window = 0, total = 0;
    for (const t of tickers) {
      const loss = this.marketRisk(t);
      total += loss;
      const close = this.d.md.markets.get(t)?.closeTime ?? this.d.oms.positions.get(t)?.closeTs ?? 0;
      if (close === windowCloseTs) window += loss;
    }
    return { window, total };
  }

  async tick(): Promise<void> {
    this.lastTickTs = this.now();
    if (this.dataHalt === 'engine heartbeat stalled') this.dataHalt = undefined;
    if (this.dataHalt === 'awaiting market data' && this.d.md.activeMarkets().length) this.dataHalt = undefined;
    const { kill, risk } = this.d;
    if (kill.engaged) return;

    const limit = risk.dailyLossLimit(this.bankroll());
    const pnl = this.dailyPnl();
    if (pnl <= -limit) {
      await kill.engage(`daily loss $${(-pnl).toFixed(2)} reached limit $${limit.toFixed(2)}`, 'risk');
      return;
    }
    await Promise.all(this.d.md.activeMarkets(this.now()).map((m) => this.evaluate(m)));
    this.prune();
  }

  private prune(): void {
    const cutoff = this.now() - 3_600_000;
    for (const [t, st] of this.status) {
      if (st.closeTs < cutoff) {
        this.status.delete(t);
        this.lastDecisionAudit.delete(t);
      }
    }
    for (const [k, ts] of this.lastRejectAudit) if (ts < cutoff) this.lastRejectAudit.delete(k);
  }

  private async evaluate(m: ActiveMarket): Promise<void> {
    if (this.busy.has(m.ticker)) return;
    this.busy.add(m.ticker);
    try {
      await this.evaluateInner(m);
    } catch (e) {
      log.error('evaluate failed', { ticker: m.ticker, error: String(e) });
      this.d.audit.write('error', { where: 'evaluate', ticker: m.ticker, error: String(e) });
    } finally {
      this.busy.delete(m.ticker);
    }
  }

  private async evaluateInner(m: ActiveMarket): Promise<void> {
    const { cfg, md, oms, model } = this.d;
    const now = this.now();
    const R = cfg.risk;
    const book = md.book(m.ticker);
    const idx = md.index.get(m.asset);
    const st: MarketStatus = { ticker: m.ticker, asset: m.asset, closeTs: m.closeTime, position: oms.positions.position(m.ticker), notes: [], updatedTs: now };
    this.status.set(m.ticker, st);

    const block = async (why: string) => {
      st.blocked = why;
      // Without a trustworthy price we must not leave quotes resting.
      await this.cancelMarketQuotes(m.ticker, why);
    };

    if (cfg.mode === 'live' && !md.hasVerifiedFees(m.seriesTicker)) return block('series fee schedule not verified');
    if (!book.isUsable(now, R.maxBookAgeMs)) return block('book not usable');
    const spot = idx?.fresh(now, R.maxIndexAgeMs);
    if (!spot) return block('index stale');
    const vol = idx!.vol();
    if (!vol) return block('volatility warming up');
    const strike = md.strikeFor(m);
    if (!strike) return block('strike unknown');
    const bid = book.bestBid();
    const ask = book.bestAsk();
    if (!bid || !ask) return block('one-sided book');

    const tauSec = (m.closeTime - now) / 1000;
    const observed = tauSec <= SETTLEMENT_AVG_SEC ? idx!.average(m.closeTime - SETTLEMENT_AVG_SEC * 1000, now, 3000)?.avg : undefined;
    const fv = fairValue({ spot: spot.value, strike, sigmaPerSqrtSec: vol.sigmaPerSqrtSec, tauSec, observedAvg: observed });
    if (!fv) return block('fair value unavailable');
    const mid = (bid.price + ask.price) / 2;
    const features = computeFeatureMap({
      now, fairValue: fv.pYes, mid, tauSec, sigmaPerSqrtSec: vol.sigmaPerSqrtSec, referenceSigma: model.params.referenceSigma,
      inWindow: fv.regime !== 'pre_window', book, micro: md.features.micro.get(m.ticker), index: idx!, spot: md.spot.get(m.asset), asset: m.asset, usdtd: md.usdtd, btcd: md.btcd,
    });
    const pYes = model.predict(features, fv.pYes);
    const why = explain(model, features, fv.pYes);
    st.modelShift = why.shiftFromFairValue;
    st.drivers = why.drivers;
    st.macro = Object.fromEntries(['usdtd_ret_5m_z', 'btcd_rel_5m_z', 'rsi_14_1m', 'conf_riskon_momentum', 'conf_riskon_momentum_rsi', 'conf_count']
      .map((k) => [k, Number.isFinite(features[k]) ? features[k] : null]));
    Object.assign(st, { strike, strikeSource: m.strikeSource, spot: spot.value, sigma: vol.sigmaPerSqrtSec, fairValue: fv.pYes, pYes, bestBid: bid.price, bestAsk: ask.price, blocked: undefined });

    const ret = idx!.trailingLogReturn(now, cfg.strategy.fastMoveWindowSec * 1000);
    const fastMove = ret !== undefined && Math.abs(ret) > cfg.strategy.fastMoveSigmas * vol.sigmaPerSqrtSec * Math.sqrt(cfg.strategy.fastMoveWindowSec);

    const live = oms.liveOrders().filter((o) => o.ticker === m.ticker && o.purpose === 'quote' && isLive(o));
    const quote = (side: 'bid' | 'ask') => {
      const o = live.filter((x) => x.side === side).sort((a, b) => b.createdTs - a.createdTs);
      // Extra same-side quotes (should not happen) are cancelled.
      for (const extra of o.slice(1)) void oms.cancel(extra.clientOrderId, 'duplicate quote');
      const q = o[0];
      return q ? { clientOrderId: q.clientOrderId, price: q.price, remaining: Math.max(0, q.count - q.exchangeFillCount) } : undefined;
    };
    const bankroll = this.bankroll() ?? 0;
    const view: MarketView = {
      ticker: m.ticker, pYes, bestBid: bid, bestAsk: ask, position: st.position, bankroll,
      maxOrderRiskUsd: R.maxOrderRiskFrac * bankroll, maxContracts: R.maxContractsPerOrder, minSidePrice: R.minSidePrice,
      tauSec, noEntryBeforeCloseSec: R.noEntryBeforeCloseSec, fastMove, tickSize: m.tickSize, fees: md.feesFor(m.ticker),
      restingBid: quote('bid'), restingAsk: quote('ask'), nowSec: Math.floor(now / 1000), closeSec: Math.floor(m.closeTime / 1000),
    };
    const plan = decide(view, cfg.strategy);
    st.notes = plan.notes;

    const decisionId = crypto.randomUUID();
    const lastAudit = this.lastDecisionAudit.get(m.ticker) ?? 0;
    if (plan.place.length || plan.cancel.length || now - lastAudit > 30_000) {
      this.lastDecisionAudit.set(m.ticker, now);
      this.d.audit.write('decision', {
        decisionId, ticker: m.ticker, model: model.id, spot: spot.value, strike, strikeSource: m.strikeSource, sigma: vol.sigmaPerSqrtSec,
        tauSec, fv: fv.pYes, regime: fv.regime, pYes, features, modelShift: why.shiftFromFairValue, drivers: why.drivers, bid: bid.price, ask: ask.price, position: st.position, fastMove,
        place: plan.place.map((p) => ({ side: p.side, price: p.price, count: p.count, purpose: p.purpose, edge: p.edge, why: p.why })),
        cancel: plan.cancel,
      });
    }

    await Promise.all(plan.cancel.map((c) => oms.cancel(c.clientOrderId, c.reason)));
    for (const p of plan.place) await this.placeChecked(m, p, pYes, decisionId);
  }

  private async placeChecked(m: ActiveMarket, p: OrderPlan, pYes: number, decisionId: string): Promise<void> {
    const { cfg, md, oms, risk, kill, model } = this.d;
    const now = this.now();
    const intent: OrderIntent = {
      ticker: m.ticker, asset: m.asset, windowCloseTs: m.closeTime, side: p.side, price: p.price, count: p.count,
      timeInForce: p.timeInForce, postOnly: p.postOnly, reduceOnly: p.reduceOnly, expirationTime: p.expirationTime,
      purpose: p.purpose, fairValue: pYes, modelId: model.id, decisionId,
    };
    const book = md.book(m.ticker);
    const totals = this.riskTotals(m.closeTime);
    const extra: RestingLike = { ticker: m.ticker, side: p.side, price: p.price, remaining: p.count, isTaker: !p.postOnly };
    const ctx: RiskContext = {
      now,
      mode: cfg.mode,
      killEngaged: kill.engaged,
      haltReasons: this.haltReasons(),
      bankroll: this.bankroll(),
      dailyPnl: this.dailyPnl(),
      bookUsable: book.isUsable(now, cfg.risk.maxBookAgeMs),
      bestBid: book.bestBid()?.price,
      bestAsk: book.bestAsk()?.price,
      indexFresh: Boolean(md.index.get(m.asset)?.fresh(now, cfg.risk.maxIndexAgeMs)),
      marketCloseTs: m.closeTime,
      tickSize: m.tickSize,
      fees: md.feesFor(m.ticker),
      position: oms.positions.position(m.ticker),
      marketRiskNow: this.marketRisk(m.ticker),
      marketRiskWith: p.reduceOnly ? this.marketRisk(m.ticker) : this.marketRisk(m.ticker, extra),
      windowRisk: totals.window,
      totalRisk: totals.total,
      ordersLastMinute: oms.ordersSentInLast(60_000),
      openOrders: oms.liveOrders().length,
      modelLiveBlockers: model.liveBlockers(),
    };
    const decision = risk.check(intent, ctx);
    if (decision.tripKill) {
      await kill.engage(decision.tripKill, 'risk');
      return;
    }
    if (!decision.ok) {
      // Strip numbers so the same kind of rejection dedupes.
      const key = `${m.ticker}:${p.side}:${p.purpose}:${decision.reasons[0].replace(/[-\d.$%]+/g, '#')}`;
      if (now - (this.lastRejectAudit.get(key) ?? 0) > 60_000) {
        this.lastRejectAudit.set(key, now);
        this.d.audit.write('risk_reject', { decisionId, intent, reasons: decision.reasons });
      }
      return;
    }
    await oms.submit(intent);
  }

  private async cancelMarketQuotes(ticker: string, reason: string): Promise<void> {
    const quotes = this.d.oms.liveOrders().filter((o) => o.ticker === ticker && o.purpose === 'quote' && !o.cancelRequested);
    await Promise.all(quotes.map((q) => this.d.oms.cancel(q.clientOrderId, reason)));
  }

  private async cancelAllQuotes(reason: string): Promise<void> {
    const quotes = this.d.oms.liveOrders().filter((o) => o.purpose === 'quote' && !o.cancelRequested);
    await Promise.all(quotes.map((q) => this.d.oms.cancel(q.clientOrderId, reason)));
  }
}

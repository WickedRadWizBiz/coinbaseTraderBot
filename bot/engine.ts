// Trading engine: the only place that turns model output into orders.
//
// Each tick, for each active market:
//   market data (fresh?) -> fair value -> meta-model -> strategy plan
//   -> cancels first -> RiskGateway.check (fails closed) -> OMS.submit
// Every decision is audited with the model id and inputs.

import crypto from 'crypto';
import type { Alerter } from './alerts/alerter';
import type { AuditLog } from './audit/auditLog';
import type { Config, RiskLimits } from './config';
import type { ExchangeGateway } from './kalshi/types';
import type { ActiveMarket, MarketData } from './marketdata/marketData';
import { computeFeatureMap, FEATURE_SCHEMA_VERSION } from './model/featureEngine';
import { priceContract, SETTLEMENT_AVG_SEC } from './model/fairValue';
import { explain, type Driver, type MetaModel } from './model/metaModel';
import type { Oms, OrderIntent } from './oms/oms';
import { isLive } from './oms/orderState';
import { PositionBook } from './oms/positions';
import { marketWorstLoss, RestingLike } from './risk/exposure';
import type { KillSwitch } from './risk/killSwitch';
import { RiskContext, RiskGateway } from './risk/riskGateway';
import type { Reconciler } from './recon/reconciler';
import { decide, decisionProbability, MarketView, OrderPlan } from './strategy/fairValueStrategy';
import { ConfluenceRatchetExit } from './strategy/exitPolicies';
import { CadenceGate, inEntryWindow, type CadenceReason } from './strategy/cadence';
import { kalshiMaintenance, sessionState, type SessionState } from './model/sessions';
import type { EquityGuard } from './risk/equityGuard';
import type { ModelHealth } from './model/modelHealth';
import type { Tca } from './tca/tca';
import type { MacroEvent } from './model/featureEngine';
import { ladderQuotes } from './model/ladder';
import type { BinaryExposure, DirectionalContext, PerpHedger } from './perps/hedger';
import type { PerpTrader } from './perps/perpTrader';
import { decideMatch, MatchTracker, type MatchMarket } from './tennis/tennisStrategy';
import { parseTennisScore } from './tennis/liveScore';
import type { TennisScore } from './tennis/tennisModel';
import { huntBlockedBySession, sessionRiskFor } from './model/sessionRisk';
import { effectiveSigma, type VolProfile } from './model/volSeasonality';
import { floorCount } from './util/num';
import { evThresholds } from './sizing/kelly';
import { tierAt, type Tier } from './risk/sizingTiers';
import type { ClockSkewMonitor } from './risk/clockSkew';
import { BalanceMonitor, fillCashDelta, settleCashDelta } from './vault/balanceMonitor';
import type { Vault } from './vault/vault';
import { writeJsonAtomic } from './util/persist';
import type { SnnBlender, TargetScaler } from './snn/blender';
import type { SnnHost } from './snn/host';
import type { ColumnInput, ContractQuery, ContractScore } from './snn/network';
import type { StepReply } from './snn/runtime';
import { logger } from './util/log';

const log = logger('engine');

export interface MarketStatus {
  ticker: string;
  asset: string;
  closeTs: number;
  kind?: string;
  strike?: number;
  cap?: number;
  strikeSource?: string;
  /** dP(YES)/dS per $1 of the underlying index (for the perp delta hedge). */
  dPdS?: number;
  spot?: number;
  sigma?: number;
  fairValue?: number;
  pYes?: number;
  /** Calibrated market probability (p_mkt_cal), decision probability q, and ensemble std. */
  pMarket?: number;
  q?: number;
  pStd?: number;
  entryWindow?: boolean;
  /** Why the last full (entry) evaluation ran under the relaxed cadence. */
  lastEval?: { reason: CadenceReason; ts: number };
  bestBid?: number;
  bestAsk?: number;
  position: number;
  blocked?: string;
  notes: string[];
  /** Log-odds shift the model applied on top of fair value, and what drove it. */
  modelShift?: number;
  drivers?: Driver[];
  /** Seasonally adjusted sigma actually used for fair value (equals sigma without a profile). */
  sigmaPricing?: number;
  /** Exit mode: normal fair-value exit, or hunting a winner under the confluence ratchet. */
  exitMode?: 'fair_value' | 'hunt';
  huntTarget?: number;
  huntStop?: number;
  /** Current values of the macro/confluence inputs for display. */
  macro?: Record<string, number | null>;
  /** SNN: model-only probability, p_snn, confidence c, alpha applied, and why it is not voting. */
  pModel?: number;
  pSnn?: number;
  snnC?: number;
  snnAlpha?: number;
  snnShadow?: string;
  updatedTs: number;
}

/** SNN column key of a market: asset x horizon (e.g. BTC-15m, ETH-60m). */
export function snnColumn(m: { asset: string; openTime: number; closeTime: number }): string {
  return `${m.asset}-${Math.round((m.closeTime - m.openTime) / 60_000)}m`;
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
  /** Validated intraday volatility profile, applied to fair value when present. */
  volProfile?: VolProfile;
  /** Profit vault / pocket: reserved cash is excluded from the tradable bankroll. */
  vault?: Vault;
  /** Withdrawal/deposit detector (with its persistence file). */
  balanceMonitor?: BalanceMonitor;
  balanceMonitorPath?: string;
  /** Maker markouts feed the adverse-selection buffer. */
  tca?: Tca;
  /** Drawdown-scaled Kelly and the weekly loss pause. */
  equityGuard?: EquityGuard;
  /** Rolling log-loss advantage vs the calibrated market. */
  modelHealth?: ModelHealth;
  /** Scheduled macro releases (CPI, FOMC, NFP, PCE) for calendar features. */
  calendar?: MacroEvent[];
  /** Perp delta hedge of the binary book (stage 2). */
  hedger?: PerpHedger;
  /** Local clock vs Kalshi's server time. */
  clock?: ClockSkewMonitor;
  /** Stage 3 directional perp trading (targets combined with the hedge by the executor). */
  perpTrader?: PerpTrader;
  /** Cortex-like SNN (bot/snn): worker host, blender with earned alpha, conservative target scaler. */
  snn?: { host: SnnHost; blender: SnnBlender; scaler: TargetScaler };
  /** Where the blender's settled (p_model, p_snn) history is saved (survives restarts). */
  snnBlenderPath?: string;
  now?: () => number;
}

export class Engine {
  private readonly busy = new Set<string>();
  private readonly hunts = new Map<string, ConfluenceRatchetExit>();
  private readonly cadence: CadenceGate;
  private readonly lastPosition = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private lastTickTs = 0;
  private lastDecisionAudit = new Map<string, number>();
  private lastRejectAudit = new Map<string, number>();
  private dataHalt: string | undefined = 'awaiting market data';
  balance: number | undefined;
  readonly status = new Map<string, MarketStatus>();
  private readonly now: () => number;

  private lastSettleTs = 0;
  // SNN: L0 inputs observed during the last tick (one ATM contract per column), the latest readout.
  private readonly snnObs = new Map<string, { input: ColumnInput; absD: number; ts: number }>();
  private snnScores = new Map<string, ContractScore>();
  private snnReply: StepReply | undefined;
  private snnLastAlert = 0;
  private snnLastSave = 0;

  constructor(private readonly d: EngineDeps) {
    this.now = d.now ?? Date.now;
    this.cadence = new CadenceGate(d.cfg.strategy);
    if (d.snn) this.attachBlender(d.snn.blender);
    // Registered before the startup reconciliation replays fills, so the
    // balance monitor sees every cash movement the bot's trading causes.
    d.oms.on('fill', (f: { side: 'bid' | 'ask'; count: number; price: number }, _rec: unknown, fee: number, positionAfter: number) => {
      const signed = f.side === 'bid' ? f.count : -f.count;
      d.balanceMonitor?.onCash(fillCashDelta(f.side, f.count, f.price, fee, positionAfter - signed));
      this.saveMonitor();
    });
    d.oms.on('settled', (e: { ticker: string; result: 'yes' | 'no'; realized: number; positionBefore: number }) => {
      this.lastSettleTs = this.now();
      d.balanceMonitor?.onCash(settleCashDelta(e.positionBefore, e.result));
      this.saveMonitor();
      if (d.vault && e.realized > 0) {
        d.vault.onSettled(e.realized, e.ticker, this.now(), this.d.equityGuard?.tierReference(this.bankroll() ?? 0) ?? this.bankroll());
        d.audit.write('vault', { event: 'win', ticker: e.ticker, realized: e.realized, status: d.vault.status(this.now()) });
      }
    });
  }

  private saveMonitor(): void {
    if (this.d.balanceMonitor && this.d.balanceMonitorPath) writeJsonAtomic(this.d.balanceMonitorPath, this.d.balanceMonitor.state);
  }

  /** Manually recorded withdrawal: book it (vault first) and tell the detector to expect the
   * balance drop, so the same withdrawal is never counted twice. */
  recordWithdrawal(amount: number, by: string) {
    if (!this.d.vault) throw new Error('vault disabled');
    const split = this.d.vault.onWithdrawal(amount, 'manual', this.now());
    this.d.balanceMonitor?.onCash(-amount);
    this.d.equityGuard?.onCashFlow(-amount, this.now(), -split.fromTrading);
    this.saveMonitor();
    this.d.audit.write('vault', { event: 'withdrawal', source: by, amount, ...split });
    return split;
  }

  /** New balance from reconciliation: detect withdrawals/deposits, then store. */
  onBalance(balance: number): void {
    this.balance = balance;
    const { balanceMonitor: mon, vault } = this.d;
    if (!mon) return;
    const now = this.now();
    // Quiet = nothing awaiting settlement and no settlement in the last 10 minutes.
    const awaiting = this.d.oms.positions.unsettled().some((m) => m.closeTs && m.closeTs < now);
    const quiet = !awaiting && now - this.lastSettleTs > 10 * 60_000;
    const res = mon.check(balance, quiet);
    this.saveMonitor();
    if (res.deposit) this.d.equityGuard?.onCashFlow(res.deposit, now);
    if (res.withdrawal && !vault) this.d.equityGuard?.onCashFlow(-res.withdrawal, now);
    if (res.withdrawal && vault) {
      const split = vault.onWithdrawal(res.withdrawal, 'detected', now);
      this.d.equityGuard?.onCashFlow(-res.withdrawal, now, -split.fromTrading);
      this.d.audit.write('vault', { event: 'withdrawal', amount: res.withdrawal, ...split });
      this.d.alerter.notify('info', 'withdrawal', `Withdrawal of $${res.withdrawal.toFixed(2)} detected: vault -$${split.fromVault.toFixed(2)}, pocket -$${split.fromPocket.toFixed(2)}, trading -$${split.fromTrading.toFixed(2)}`);
    }
    if (res.deposit) {
      vault?.onDeposit(res.deposit, now);
      this.d.audit.write('vault', { event: 'deposit', amount: res.deposit });
    }
  }

  async start(): Promise<void> {
    const { cfg, md, recon, oms, kill } = this.d;
    await md.refreshCatalog();
    const first = await recon.run('startup');
    if (first?.balance !== undefined) this.onBalance(first.balance);

    this.timers.push(setInterval(() => void this.tick(), 1000));
    this.timers.push(setInterval(() => void md.refreshCatalog(), 20_000));
    this.timers.push(setInterval(async () => {
      const r = await recon.run('interval');
      if (r?.balance !== undefined) this.onBalance(r.balance);
    }, cfg.reconcileIntervalMs));
    this.timers.push(setInterval(() => this.watchdog(), 1000));

    md.on('reconnected', async () => {
      this.dataHalt = undefined;
      const r = await recon.run('ws_reconnect');
      if (r?.balance !== undefined) this.onBalance(r.balance);
    });
    md.on('disconnected', () => {
      this.dataHalt = 'market data disconnected';
      void this.cancelAllQuotes('market data disconnected');
    });
    md.on('lifecycle', (e: { ticker: string; event: string; result?: string }) => {
      if ((e.result === 'yes' || e.result === 'no') && /settle|determin/i.test(e.event)) {
        oms.settle(e.ticker, e.result);
        this.d.modelHealth?.onResult(e.ticker, e.result);
        this.snnSettle(e.ticker, e.result);
      }
    });
    // Official results of every scanned market (traded or not): the SNN's settlement labels.
    md.on('result', (e: { ticker: string; result: 'yes' | 'no' }) => this.snnSettle(e.ticker, e.result));
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

  /** Current market session, its risk multipliers and the hunt guard, for the dashboard. */
  sessionStatus(now = this.now()): SessionState & { risk: ReturnType<typeof sessionRiskFor>; huntBlocked?: string; volProfile?: { version: string; applied: boolean } } {
    const st = sessionState(now);
    const S = this.d.cfg.strategy;
    return {
      ...st,
      risk: sessionRiskFor(S.sessionRisk, st),
      huntBlocked: S.exitPolicy === 'confluence_ratchet' && S.huntSessionGuard ? huntBlockedBySession(st, S.huntTransitionBufferMin) : undefined,
      volProfile: this.d.volProfile ? { version: this.d.volProfile.version, applied: true } : undefined,
    };
  }

  haltReasons(): string[] {
    const r: string[] = [];
    if (this.d.recon.halted) r.push('reconciliation not clean');
    if (this.dataHalt) r.push(this.dataHalt);
    if (this.balance === undefined) r.push('balance unknown');
    else if (this.bankroll() === 0) r.push('no tradable cash (vault/pocket reserved)');
    r.push(...this.entryGuards());
    return r;
  }

  /** Guards that stop NEW risk (exits stay allowed): weekly loss pause, model health, maintenance. */
  entryGuards(now = this.now()): string[] {
    const r: string[] = [];
    const paused = this.d.equityGuard?.paused(now);
    if (paused) r.push(paused);
    const skew = this.d.cfg.clockSkewMaxMs > 0 ? this.d.clock?.haltReason(Date.now()) : undefined;
    if (skew) r.push(skew);
    const h = this.d.modelHealth?.status();
    if (this.d.cfg.strategy.modelHealthHalt && h?.halt) r.push(`model log loss significantly worse than the calibrated market over ${h.windows} windows (p=${h.pWorse?.toFixed(3)})`);
    const b = this.bankroll();
    const minB = this.d.cfg.strategy.minTradableBankrollUsd;
    if (b !== undefined && b > 0 && b < minB) r.push(`tradable bankroll $${b.toFixed(2)} below the $${minB} minimum`);
    const mt = kalshiMaintenance(now);
    if (mt.inside || mt.minutesTo <= 30) r.push(mt.inside ? 'Kalshi maintenance window' : `Kalshi maintenance in ${mt.minutesTo} min`);
    return r;
  }

  /** Sizing tier for the current tradable high-water mark ($20 aggressive -> $50 moderate -> $100 normal). */
  tier(): Tier {
    const b = this.bankroll() ?? 0;
    return tierAt(this.d.cfg.sizingTiers, this.d.equityGuard?.tierReference(b) ?? b);
  }

  /** Configured limits replaced by the tier's fractions. */
  private tierLimits(t: Tier): Partial<RiskLimits> {
    return { maxOrderRiskFrac: t.orderFrac, maxWindowRiskFrac: t.windowFrac, maxTotalRiskFrac: t.totalFrac, dailyLossLimitFrac: t.dailyLossFrac, dailyLossLimitUsd: t.dailyLossUsd };
  }

  /** Today's loss limit in dollars: the current tier's fraction of bankroll, under its dollar ceiling. */
  dailyLossLimit(): number {
    return this.d.risk.dailyLossLimit(this.bankroll(), this.tierLimits(this.tier()));
  }

  /** Relaxed-cadence and risk-guard state for the dashboard. */
  guardStatus(now = this.now()) {
    const S = this.d.cfg.strategy;
    const eq = this.equity();
    const b = this.bankroll() ?? 0;
    const t = this.tier();
    const ev = evThresholds(S, b, t.orderFrac * b);
    return {
      cadence: S.cadence, sizing: S.sizing, exitPolicy: S.exitPolicy, kappa: S.kappa,
      targetEvUsd: +ev.targetEv.toFixed(2), minTradeEvUsd: +ev.minEv.toFixed(3),
      minTradableBankrollUsd: S.minTradableBankrollUsd,
      tier: { ...t, orderRiskUsd: +(t.orderFrac * b).toFixed(2), dailyLossLimitUsd: +this.d.risk.dailyLossLimit(b, this.tierLimits(t)).toFixed(2) },
      entryWindowUpdown: S.entryWindowUpdown, entryWindowHourly: S.entryWindowHourly,
      makerBuffer: this.makerBuffer(), makerMarkout60: this.d.tca?.makerMarkout60() ?? null,
      clock: this.d.clock?.status(Date.now()) ?? null,
      equity: eq ?? null, equityGuard: this.d.equityGuard?.status(eq, now, t.ddScaleAt) ?? null,
      modelHealth: this.d.modelHealth?.status() ?? null,
      entryGuards: this.entryGuards(now),
    };
  }

  /** Cash + committed premium (before vault/pocket reservations): the drawdown reference. */
  equity(): number | undefined {
    if (this.balance === undefined) return undefined;
    return this.balance + this.d.oms.positions.open().reduce((s, m) => s + PositionBook.maxLoss(m), 0);
  }

  /** Adverse-selection buffer for maker entries: -(average 60 s maker markout), clamped; default until 30 maker fills. */
  makerBuffer(): number {
    const S = this.d.cfg.strategy;
    const m = this.d.tca?.makerMarkout60();
    if (!m || m.n < 30 || m.avg === null) return S.makerBuffer;
    return Math.min(S.makerBufferRange[1], Math.max(S.makerBufferRange[0], -m.avg));
  }

  /** Bankroll for fractional limits: cash + premium committed to open positions. */
  bankroll(): number | undefined {
    if (this.balance === undefined) return undefined;
    const committed = this.d.oms.positions.open().reduce((s, m) => s + PositionBook.maxLoss(m), 0);
    // Vaulted and pocketed profit is not the bot's to trade.
    return Math.max(0, this.balance + committed - (this.d.vault?.reserved() ?? 0));
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

  /** Tennis tickers are budgeted separately (their own 25% cap) from the crypto book. */
  isTennis(ticker: string): boolean {
    const m = this.d.md.markets.get(ticker);
    return m ? m.kind === 'match' : this.d.cfg.tennis.series.some((s) => ticker.startsWith(`${s}-`));
  }

  /** Crypto: window = markets closing together. Tennis (`tennisEvent`): window = the match, total = all tennis. */
  private riskTotals(windowCloseTs: number, tennisEvent?: string): { window: number; total: number } {
    const tickers = new Set<string>([...this.d.oms.positions.unsettled().map((m) => m.ticker), ...this.d.oms.liveOrders().map((o) => o.ticker)]);
    let window = 0, total = 0;
    for (const t of tickers) {
      if (this.isTennis(t) !== (tennisEvent !== undefined)) continue;
      const loss = this.marketRisk(t);
      total += loss;
      if (tennisEvent !== undefined) {
        if ((this.d.md.markets.get(t)?.eventTicker ?? t.slice(0, t.lastIndexOf('-'))) === tennisEvent) window += loss;
        continue;
      }
      const close = this.d.md.markets.get(t)?.closeTime ?? this.d.oms.positions.get(t)?.closeTs ?? 0;
      if (close === windowCloseTs) window += loss;
    }
    return { window, total };
  }

  async tick(): Promise<void> {
    this.lastTickTs = this.now();
    this.d.vault?.tick(this.lastTickTs);
    const eq = this.equity();
    if (eq !== undefined) this.d.equityGuard?.update(eq, this.lastTickTs, this.bankroll(), this.tier().weeklyLossPause);
    if (this.dataHalt === 'engine heartbeat stalled') this.dataHalt = undefined;
    if (this.dataHalt === 'awaiting market data' && this.d.md.activeMarkets().length) this.dataHalt = undefined;
    const { kill, risk } = this.d;
    if (kill.engaged) {
      // A stale hedge must still be unwound when the binaries it offset are gone, and directional
      // perp positions are flattened (leverage: never sit on them unattended).
      await this.d.hedger?.tick(this.exposures(), { reduceOnly: true, directional: this.perpDirectional('kill switch engaged') });
      return;
    }

    const limit = this.dailyLossLimit();
    const pnl = this.dailyPnl();
    if (pnl <= -limit) {
      await kill.engage(`daily loss $${(-pnl).toFixed(2)} reached limit $${limit.toFixed(2)}`, 'risk');
      return;
    }
    await this.snnTick();
    await Promise.all(this.d.md.activeMarkets(this.now()).filter((m) => m.kind !== 'match').map((m) => this.evaluate(m)));
    this.prune();
    // Stage 2: offset the binary book's net delta with perps (reduce-only when new risk is halted).
    // Perps: the hedge is reduce-only while binary risk is halted; directional trading has its own guards.
    await this.d.hedger?.tick(this.exposures(), { reduceOnly: this.haltReasons().length > 0 && !this.d.perpTrader, directional: this.perpDirectional() });
    await this.tennisTick();
  }

  // ---- ATP tennis (bot/tennis/tennisStrategy.ts) --------------------------------------
  private readonly matches = new Map<string, MatchTracker>();
  private lastTennisTick = 0;
  /** Live tennis scores (TENNIS_SCORE_FEED=kalshi): milestone per event, last poll, raw payload. */
  private readonly scores = new Map<string, { milestone?: { id: string; type: string } | null; polledTs: number; score?: TennisScore; raw?: unknown; error?: string }>();
  readonly tennisStatus = new Map<string, { event: string; phase: string; pA?: number; progress: number; progressDetail?: Record<string, unknown>; score?: TennisScore; scoreRaw?: unknown; liveSince?: number; notes: string[]; tickers: string[]; updatedTs: number; trailingStops?: Record<string, number>; confluence?: Record<string, unknown> }>();

  /** Tennis budget use: worst-case loss of all tennis positions + resting orders vs the 25% cap. */
  tennisBudget(): { used: number; cap: number; bankroll: number } {
    const b = this.bankroll() ?? 0;
    return { used: this.riskTotals(0, '__none__').total, cap: this.d.cfg.tennis.maxTotalFrac * b, bankroll: b };
  }

  /** Poll Kalshi's live data for a match (every scorePollSec; milestone looked up once). Never throws. */
  private async pollScore(event: string, now: number) {
    const T = this.d.cfg.tennis;
    const rest = this.d.md.rest;
    let st = this.scores.get(event);
    if (!st) { st = { polledTs: 0 }; this.scores.set(event, st); }
    if (!rest || now - st.polledTs < T.scorePollSec * 1000) return st;
    st.polledTs = now;
    try {
      if (st.milestone === undefined) {
        const ms = await rest.getMilestones(event);
        st.milestone = ms[0] ?? null;
      }
      if (!st.milestone) { st.error = 'no Kalshi milestone for this match'; return st; }
      const ld = await rest.getLiveData(st.milestone.type, st.milestone.id);
      st.raw = ld?.details;
      st.score = parseTennisScore(ld?.details);
      st.error = st.score ? undefined : 'live data not recognised as a tennis score (see scoreRaw)';
    } catch (e) {
      st.error = `score feed: ${(e as Error).message}`;
    }
    return st;
  }

  private async tennisTick(): Promise<void> {
    const { cfg, md, oms } = this.d;
    const T = cfg.tennis;
    const now = this.now();
    if (!T.enabled || now - this.lastTennisTick < 5_000) return;
    this.lastTennisTick = now;
    const tradeable = cfg.mode !== 'live' || T.live;
    const byEvent = new Map<string, ActiveMarket[]>();
    for (const m of md.activeMarkets(now)) {
      if (m.kind !== 'match') continue;
      const ev = m.eventTicker ?? m.ticker.slice(0, m.ticker.lastIndexOf('-'));
      byEvent.set(ev, [...(byEvent.get(ev) ?? []), m]);
    }
    const bankroll = this.bankroll() ?? 0;
    for (const [event, ms] of byEvent) {
      ms.sort((a, b) => a.ticker.localeCompare(b.ticker));
      let tracker = this.matches.get(event);
      if (!tracker) { tracker = new MatchTracker(event, T); this.matches.set(event, tracker); }
      const markets: MatchMarket[] = ms.map((m) => {
        const book = md.book(m.ticker);
        const b = book.isUsable(now, cfg.risk.maxBookAgeMs) ? book.bestBid() : undefined;
        const a = book.isUsable(now, cfg.risk.maxBookAgeMs) ? book.bestAsk() : undefined;
        const pos = oms.positions.get(m.ticker);
        return {
          ticker: m.ticker, title: m.title, position: pos?.yes ?? 0,
          avgEntry: pos && pos.yes > 0 ? -pos.netCash / pos.yes : undefined,
          quote: { bid: b?.price, ask: a?.price, bidSize: b?.size, askSize: a?.size },
          book: book.isUsable(now, cfg.risk.maxBookAgeMs) ? book : undefined,
          flow: (() => {
            const tr = md.features.micro.get(m.ticker)?.tradesIn(now, T.confWindowSec * 1000) ?? [];
            const tot = tr.reduce((x, y) => x + y.count, 0);
            return tot > 0 ? tr.reduce((x, y) => x + y.signed, 0) / tot : undefined;
          })(),
        };
      });
      const totals = this.riskTotals(0, event);
      const sc = T.scoreFeed === 'kalshi' ? await this.pollScore(event, now) : undefined;
      const out = decideMatch(tracker, { event, now, startTime: ms.find((m) => m.startTime)?.startTime, markets, closeTime: Math.min(...ms.map((m) => m.closeTime)), score: sc?.score }, T,
        { bankroll, tennisRisk: totals.total, matchRisk: totals.window }, ms[0].tickSize);
      const notes = [...out.notes, ...(tradeable ? [] : ['tracking only: set TENNIS_LIVE=true to trade tennis with real money'])];
      this.tennisStatus.set(event, { event, phase: out.phase, pA: MatchTracker.probability(markets), progress: tracker.progress(now, markets), progressDetail: tracker.progressDetail(now, markets), score: tracker.score, scoreRaw: sc?.raw ?? sc?.error, liveSince: tracker.liveSince, notes, tickers: ms.map((m) => m.ticker), updatedTs: now, trailingStops: Object.fromEntries(tracker.stops), confluence: Object.fromEntries(tracker.signals) });

      // Reconcile resting tennis orders with the plan (never touch another market's orders).
      const plans = tradeable ? out.plans : [];
      const resting = oms.liveOrders().filter((o) => ms.some((m) => m.ticker === o.ticker) && !o.cancelRequested);
      for (const o of resting) {
        const keep = plans.some((p) => p.ticker === o.ticker && p.side === o.side && p.postOnly && Math.abs(p.price - o.price) < 1e-9 && Math.abs(p.count - (o.count - o.exchangeFillCount)) < 0.01 + 1e-9);
        if (!keep && o.postOnly) await oms.cancel(o.clientOrderId, 'tennis plan changed');
      }
      for (const p of plans) {
        const already = resting.some((o) => o.ticker === p.ticker && o.side === p.side && Math.abs(p.price - o.price) < 1e-9 && Math.abs(p.count - (o.count - o.exchangeFillCount)) < 0.01 + 1e-9);
        if (already) continue;
        const m = ms.find((x) => x.ticker === p.ticker)!;
        const book = md.book(m.ticker);
        const b = book.bestBid()?.price, a = book.bestAsk()?.price;
        const fairValue = b !== undefined && a !== undefined ? (b + a) / 2 : p.price;
        const plan: OrderPlan = {
          side: p.side, price: p.price, count: p.count, timeInForce: p.timeInForce, postOnly: p.postOnly, reduceOnly: p.reduceOnly,
          purpose: p.reduceOnly ? 'exit' : 'quote', expirationTime: p.timeInForce === 'good_till_canceled' ? Math.min(Math.floor(now / 1000) + 3600, Math.floor(m.closeTime / 1000) - 1) : undefined,
          edge: 0, why: `tennis ${p.leg}: ${p.why}`,
        };
        const decisionId = crypto.randomUUID();
        this.d.audit.write('decision', { decisionId, ticker: m.ticker, strategy: 'tennis', event, leg: p.leg, phase: out.phase, why: p.why, price: p.price, count: p.count, side: p.side, pA: MatchTracker.probability(markets) });
        await this.placeChecked(m, plan, fairValue, decisionId, { event });
      }
    }
    for (const ev of this.matches.keys()) if (!byEvent.has(ev)) { this.matches.delete(ev); this.tennisStatus.delete(ev); }
  }

  /** Directional perp targets for the executor, or undefined without a trader. `halt` flattens. */
  private perpDirectional(halt?: string): ((c: DirectionalContext) => Promise<import('./perps/hedger').DirTarget[]>) | undefined {
    const t = this.d.perpTrader;
    if (!t) return undefined;
    return (c) => {
      const f = this.d.md.perpFeed;
      const skew = this.d.cfg.clockSkewMaxMs > 0 ? this.d.clock?.haltReason(Date.now()) : undefined;
      const noEntry = skew ?? (f?.lastError ? `perps feed unavailable (${f.lastError})` : undefined);
      return t.targets(c, { halt, noEntry });
    };
  }

  /** Perp feed and hedge state for the dashboard. */
  perpStatus(now = this.now()) {
    const f = this.d.md.perpFeed;
    const markets = [...this.d.md.features.perps.byAsset.entries()].map(([asset, s]) => {
      const ix = this.d.md.index.get(asset)?.latest()?.value;
      const p = s.price(now);
      return { asset, ticker: s.latest?.ticker, bid: s.latest?.bid, ask: s.latest?.ask, premiumBps: p && ix ? 1e4 * Math.log(p / ix) : null, fundingRate: s.latest?.fundingRate ?? null, nextFundingTs: s.latest?.nextFundingTs ?? null, contractSize: s.latest?.contractSize ?? null, leverage: s.latest?.leverage ?? null };
    });
    return {
      feed: f ? { ok: !f.lastError, lastError: f.lastError ?? null, lastOkTs: f.lastOkTs || null } : null,
      markets,
      hedge: this.d.hedger ? { mode: this.d.cfg.perps.hedge, ...this.d.hedger.status() } : { mode: 'off' },
      trading: this.d.perpTrader ? { mode: this.d.cfg.perps.trading, ...this.d.perpTrader.status() } : { mode: 'off' },
    };
  }

  // ---- Cortex-like SNN (bot/snn) ---------------------------------------------------------

  /** Advance the SNN clock with last tick's inputs and score every active contract (one batched,
   *  200 ms-bounded request). Timeouts and errors leave no scores: the blend uses alpha = 0. */
  private async snnTick(): Promise<void> {
    const snn = this.d.snn;
    if (!snn) return;
    const { md, cfg } = this.d;
    const now = this.now();
    const queries: ContractQuery[] = [];
    for (const m of md.activeMarkets(now)) {
      if (m.kind === 'match') continue;
      const terms = md.termsFor(m), idx = md.index.get(m.asset);
      const spot = idx?.fresh(now, cfg.risk.maxIndexAgeMs), vol = idx?.vol();
      if (!terms || !spot || !vol) continue;
      const tauSec = (m.closeTime - now) / 1000;
      queries.push({
        ticker: m.ticker, column: snnColumn(m), kind: terms.kind, strike: terms.strike, cap: terms.cap, spot: spot.value, sigma: vol.sigmaPerSqrtSec,
        tauSec, lifeSec: (m.closeTime - m.openTime) / 1000, eventKey: `${m.asset}:${m.closeTime}`, tag: tauSec > cfg.risk.noEntryBeforeCloseSec,
      });
    }
    const inputs = [...this.snnObs.values()].filter((o) => now - o.ts < 10_000).map((o) => o.input);
    const r = await snn.host.stepAndScore(now, inputs, queries);
    this.snnReply = r;
    this.snnScores = new Map((r?.scores ?? []).map((s) => [s.ticker, s]));
    if (r && r.scores.length) {
      const n = r.scores.length;
      snn.scaler.update(now, r.scores.reduce((a, s) => a + s.surprise, 0) / n, r.scores.reduce((a, s) => a + s.surprise0, 0) / n, r.scores.reduce((a, s) => a + s.G, 0) / n);
    }
    if (r?.alerts.length && now - this.snnLastAlert > 3_600_000) {
      this.snnLastAlert = now;
      this.d.audit.write('snn', { event: 'health_alert', alerts: r.alerts });
      this.d.alerter.notify('warn', 'snn-health', `SNN health: ${r.alerts.join('; ')}`);
    }
  }

  /** Remember this market's L0 inputs for the next SNN step (the closest-to-the-money contract per column). */
  private snnObserve(m: ActiveMarket, input: Omit<ColumnInput, 'key' | 'asset'>, now: number): void {
    if (!this.d.snn || (m.kind !== 'updown' && m.kind !== 'greater')) return;
    const key = snnColumn(m);
    const absD = Number.isFinite(input.dAtm) ? Math.abs(input.dAtm!) : Infinity;
    const prev = this.snnObs.get(key);
    if (prev && now - prev.ts < 1000 && prev.absD <= absD) return;
    this.snnObs.set(key, { input: { key, asset: m.asset, ...input }, absD, ts: now });
  }

  /** p_final = (1 - alpha c) p_model + alpha c p_snn in blend mode; otherwise p_model (SNN logged only). */
  private snnBlend(m: ActiveMarket, st: MarketStatus, pModel: number, tradable: boolean, now: number): number {
    const snn = this.d.snn;
    st.pModel = pModel;
    if (!snn) return pModel;
    const s = this.snnScores.get(m.ticker);
    if (!s) { st.snnShadow = this.snnReply ? 'not scored' : 'no readout (timeout or warming up)'; return pModel; }
    const c = snn.blender.confidence(s.surprise, s.surprise0, s.G);
    const shadow = this.d.cfg.snn.mode !== 'blend' ? 'shadow mode'
      : !this.snnReply ? 'readout timed out'
      : this.snnReply.shadow ? 'health: shadow'
      : !snn.host.latencyOk() ? `latency p99 ${snn.host.p99().toFixed(0)} ms` : undefined;
    const p = snn.blender.pFinal(pModel, s.p, c, Boolean(shadow));
    Object.assign(st, { pSnn: s.p, snnC: c, snnAlpha: shadow ? 0 : snn.blender.alpha().alpha, snnShadow: shadow });
    if (tradable) snn.blender.record({ ticker: m.ticker, eventKey: s.eventKey, ts: now, pModel, pSnn: s.p, c });
    return p;
  }

  /** Load the blender's saved history; it is discarded when it was recorded against another meta-model. */
  private attachBlender(b: SnnBlender): void {
    const r = this.d.snnBlenderPath ? b.load(this.d.snnBlenderPath, this.d.model.id) : (b.bindModel(this.d.model.id), 'none');
    if (r === 'reset') this.d.audit.write('snn', { event: 'blender_reset', reason: 'meta-model changed since the history was recorded', model: this.d.model.id });
  }

  saveSnnBlender(): void {
    if (this.d.snn && this.d.snnBlenderPath) this.d.snn.blender.save(this.d.snnBlenderPath);
  }

  /** Hot-swap the meta-model (automated pipeline / file watcher). The SNN blend history is reset:
   *  its pairs hold the old model's p_model, so alpha must be re-earned against the new one. */
  setModel(model: MetaModel): void {
    const old = this.d.model.id;
    this.d.model = model;
    this.hunts.clear();
    if (this.d.snn && this.d.snn.blender.bindModel(model.id)) this.saveSnnBlender();
    this.d.audit.write('config', { event: 'model_swapped', from: old, to: model.id });
    log.info('meta-model hot-swapped', { from: old, to: model.id });
  }

  /** Hot-swap the SNN (new trained model file); the old host is stopped by the caller. */
  setSnn(snn: EngineDeps['snn']): void {
    this.d.snn = snn;
    this.snnScores.clear();
    this.snnReply = undefined;
    this.snnObs.clear();
    if (snn) this.attachBlender(snn.blender);
  }

  /** Hot-swap the validated intraday volatility profile (undefined removes it). */
  setVolProfile(vp: VolProfile | undefined): void {
    this.d.volProfile = vp;
  }

  get model(): MetaModel { return this.d.model; }
  get snn(): EngineDeps['snn'] { return this.d.snn; }

  private snnSettle(ticker: string, result: 'yes' | 'no'): void {
    const snn = this.d.snn;
    if (!snn) return;
    void snn.host.settle(ticker, result, this.now());
    const rec = snn.blender.settle(ticker, result === 'yes' ? 1 : 0);
    if (rec && this.now() - this.snnLastSave > 30_000) { this.snnLastSave = this.now(); this.saveSnnBlender(); }
    if (rec) this.d.audit.write('snn', { event: 'settle', ticker, y: rec.y, pModel: rec.pModel, pSnn: rec.pSnn, c: rec.c, eventKey: rec.eventKey, brierModel: (rec.pModel - rec.y!) ** 2, brierSnn: (rec.pSnn - rec.y!) ** 2 });
  }

  /** Compact SNN state for the status endpoint. */
  snnBrief() {
    const snn = this.d.snn;
    if (!snn) return { mode: 'off' };
    const e = snn.blender.alpha();
    return { mode: this.d.cfg.snn.mode, stage: this.d.cfg.snn.stage, alpha: e.alpha, events: e.events, reason: e.reason, shadow: this.snnReply?.shadow ?? true, top: this.snnReply?.top ?? null, p99Ms: +snn.host.p99().toFixed(1), targetScale: snn.scaler.scale };
  }

  /** SNN state for the dashboard. */
  async snnStatus() {
    const snn = this.d.snn;
    if (!snn) return { mode: 'off' };
    return {
      mode: this.d.cfg.snn.mode, stage: this.d.cfg.snn.stage, host: { mode: snn.host.mode, version: snn.host.version, p99Ms: +snn.host.p99().toFixed(1), timeouts: snn.host.timeouts, lastError: snn.host.lastError ?? null, restoredFrom: snn.host.restoredFrom ?? null },
      blender: snn.blender.status(), targetScale: snn.scaler.scale,
      salience: this.snnReply?.salience ?? {}, top: this.snnReply?.top ?? null, shadow: this.snnReply?.shadow ?? true,
      network: await snn.host.status(),
    };
  }

  /** Open binary positions with their sensitivity to the underlying, for the perp hedger. */
  exposures(now = this.now()): BinaryExposure[] {
    const out: BinaryExposure[] = [];
    for (const p of this.d.oms.positions.unsettled()) {
      const st = this.status.get(p.ticker);
      if (!p.yes || !st || st.dPdS === undefined || st.updatedTs < now - 10_000) continue;
      out.push({ asset: st.asset, ticker: p.ticker, position: p.yes, dPdS: st.dPdS, tauSec: (st.closeTs - now) / 1000 });
    }
    return out;
  }

  private prune(): void {
    const cutoff = this.now() - 3_600_000;
    for (const [t, st] of this.status) {
      if (st.closeTs < cutoff) {
        this.status.delete(t);
        this.hunts.delete(t);
        this.cadence.forget(t);
        this.lastPosition.delete(t);
        this.d.modelHealth?.forget(t);
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
    const terms = md.termsFor(m);
    if (!terms) return block('strike unknown');
    const strike = terms.strike ?? terms.cap!;
    const bid = book.bestBid();
    const ask = book.bestAsk();
    if (!bid || !ask) return block('one-sided book');

    const tauSec = (m.closeTime - now) / 1000;
    const settle = tauSec <= SETTLEMENT_AVG_SEC ? idx!.settlement(m.closeTime, now, SETTLEMENT_AVG_SEC) : undefined;
    const observed = settle?.avg, observedCount = settle?.n;
    // Intraday volatility periodicity: scale the backward-looking EWMA sigma to the variance
    // expected over this contract's remaining life (only with a validated profile).
    const sigmaPricing = effectiveSigma(vol.sigmaPerSqrtSec, this.d.volProfile, m.asset, now, m.closeTime);
    const fv = priceContract(terms, { spot: spot.value, sigmaPerSqrtSec: sigmaPricing, tauSec, observedAvg: observed, observedCount, nu: model.params.tNu });
    if (!fv) return block('fair value unavailable');
    const sess = sessionState(now);
    const sessRisk = sessionRiskFor(cfg.strategy.sessionRisk, sess);
    const mid = (bid.price + ask.price) / 2;
    const features = computeFeatureMap({
      now, fairValue: fv.pYes, mid, tauSec, sigmaPerSqrtSec: vol.sigmaPerSqrtSec, referenceSigma: model.params.referenceSigma,
      inWindow: fv.regime !== 'pre_window', book, micro: md.features.micro.get(m.ticker), index: idx!, spot: md.spot.get(m.asset), asset: m.asset, usdtd: md.usdtd, btcd: md.btcd,
      closeTs: m.closeTime, volProfile: this.d.volProfile, asiaRange: md.features.asiaRange.get(m.asset),
      kind: m.kind, strike: terms.strike, cap: terms.cap, d2: fv.d2, vEff: fv.vEff, sigmaPricing, tNu: model.params.tNu,
      bars: md.features.bars.get(m.asset), openTime: m.openTime, calendar: this.d.calendar,
      ticker: m.ticker, siblings: m.kind === 'updown' ? undefined : ladderQuotes(md.markets.values(), (t) => md.books.get(t), m.asset, m.closeTime),
      perp: md.features.perps.get(m.asset), candles: md.features.candles.get(m.asset),
    });
    const pred = model.predictDetailed(features, fv.pYes);
    const pMarket = model.marketProbability(mid);
    // SNN: feed this market's encodings to the next 1 s step, then blend (alpha = 0 unless earned).
    this.snnObserve(m, {
      spot: spot.value, mid, spread: ask.price - bid.price, imbalance: features.imbalance, dAtm: fv.d2, tauFrac: tauSec / Math.max(1, (m.closeTime - m.openTime) / 1000),
      rsi: Number.isFinite(features.rsi_14_1m) ? 50 + 50 * features.rsi_14_1m : undefined, retZ: features.ret_5m_z,
    }, now);
    const pYes = this.snnBlend(m, st, pred.p, tauSec > R.noEntryBeforeCloseSec, now);
    const why = explain(model, features, fv.pYes);
    st.modelShift = why.shiftFromFairValue;
    st.drivers = why.drivers;
    st.macro = Object.fromEntries(['usdtd_ret_5m_z', 'btcd_rel_5m_z', 'rsi_14_1m', 'conf_riskon_momentum', 'conf_riskon_momentum_rsi', 'conf_count']
      .map((k) => [k, Number.isFinite(features[k]) ? features[k] : null]));
    // Sensitivity to the underlying (per $1 of index) for the perp hedge: re-price at S +/- 0.05%.
    const bump = spot.value * 0.0005;
    const up = priceContract(terms, { spot: spot.value + bump, sigmaPerSqrtSec: sigmaPricing, tauSec, observedAvg: observed, observedCount, nu: model.params.tNu });
    const dn = priceContract(terms, { spot: spot.value - bump, sigmaPerSqrtSec: sigmaPricing, tauSec, observedAvg: observed, observedCount, nu: model.params.tNu });
    const dPdS = up && dn ? (up.pYes - dn.pYes) / (2 * bump) : undefined;
    Object.assign(st, { kind: m.kind, strike: terms.strike, cap: terms.cap, strikeSource: m.strikeSource, spot: spot.value, sigma: vol.sigmaPerSqrtSec, sigmaPricing, fairValue: fv.pYes, pYes, pMarket, pStd: pred.std, bestBid: bid.price, bestAsk: ask.price, dPdS, blocked: undefined });

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
    const S = cfg.strategy;
    // Entry window: contract kind and time to close (relaxed spec), hourly strikes only while the
    // market is between 10c and 90c, and never during the guards that stop new risk.
    const guards = this.entryGuards(now);
    const kindWindow = S.cadence === 'relaxed'
      ? inEntryWindow(m.kind, tauSec, S.entryWindowUpdown, S.entryWindowHourly) && (m.kind === 'updown' || (mid >= S.hourlyMidBand[0] && mid <= S.hourlyMidBand[1]))
      : true;
    const entryWindowOpen = kindWindow && guards.length === 0;
    const restingBid = quote('bid');
    const restingAsk = quote('ask');
    const through = (r: { price: number } | undefined, best: number) => r !== undefined && Math.abs(best - r.price) >= 2 * S.requoteThreshold - 1e-9;
    const positionChanged = (this.lastPosition.get(m.ticker) ?? 0) !== st.position;
    this.lastPosition.set(m.ticker, st.position);
    const reason = this.cadence.check(m.ticker, { now, fairValue: pYes, entryWindowOpen, hasResting: Boolean(restingBid || restingAsk), bookThroughQuote: through(restingBid, bid.price) || through(restingAsk, ask.price), positionChanged });
    if (reason) st.lastEval = { reason, ts: now };
    st.entryWindow = entryWindowOpen;
    if (reason && entryWindowOpen) this.d.modelHealth?.record(m.ticker, pred.p, pMarket, m.closeTime);
    const pos = oms.positions.get(m.ticker);
    const entrySidePrice = pos && pos.yes > 0 ? -pos.netCash / pos.yes : pos && pos.yes < 0 ? 1 - pos.netCash / -pos.yes : undefined;
    const tier = this.tier();
    const kellyScale = this.d.equityGuard?.kellyScale(this.equity() ?? 0, tier.ddScaleAt) ?? 1;
    const view: MarketView = {
      ticker: m.ticker, pYes, bestBid: bid, bestAsk: ask, position: st.position, bankroll,
      // Session risk profile can only shrink size (sizeMult in [0, 1]).
      maxOrderRiskUsd: tier.orderFrac * bankroll * sessRisk.sizeMult, maxContracts: floorCount(R.maxContractsPerOrder * sessRisk.sizeMult), minSidePrice: R.minSidePrice,
      tauSec, noEntryBeforeCloseSec: R.noEntryBeforeCloseSec, fastMove, tickSize: m.tickSize, fees: md.feesFor(m.ticker),
      restingBid, restingAsk, nowSec: Math.floor(now / 1000), closeSec: Math.floor(m.closeTime / 1000),
      pMarket, pStd: pred.std, makerBuffer: this.makerBuffer(), entrySidePrice: entrySidePrice !== undefined && entrySidePrice > 0 && entrySidePrice < 1 ? entrySidePrice : undefined,
      entryWindowOpen, exitWindowOpen: tauSec > S.noExitBeforeCloseSec,
    };
    // Exit policy. confluence_ratchet: fair-value exit normally; "hunt" mode (liquidity ratchet
    // manages the exit, nothing else may reduce the position) only while the contract has beaten
    // its entry fair value AND confluence agrees with the position.
    let huntMode = false;
    let huntPlan: OrderPlan | undefined;
    // Hunt mode is evaluated by research:backtest --annotate. With a passing evaluation the winning
    // parameters are used; in live mode an unevaluated (or losing) hunt falls back to the fair-value exit.
    const vh = model.validatedHunt();
    const huntAllowed = cfg.strategy.exitPolicy === 'confluence_ratchet' && (cfg.mode !== 'live' || vh !== undefined);
    const huntNote = cfg.strategy.exitPolicy === 'confluence_ratchet' && !huntAllowed ? 'hunt mode not validated by the backtest: fair-value exit in live' : undefined;
    if (huntAllowed) {
      let h = this.hunts.get(m.ticker);
      if (!h) {
        const S = cfg.strategy;
        h = vh
          ? new ConfluenceRatchetExit({ targetMargin: vh.targetMargin * this.snnTargetScale(), minConfluence: vh.minConfluence }, { minFillRatio: vh.minFillRatio, minWallAgeMs: vh.minWallAgeMs, slippageTicks: vh.slippageTicks })
          : new ConfluenceRatchetExit(
            { targetMargin: S.huntTargetMargin * this.snnTargetScale(), minConfluence: S.huntMinConfluence },
            { minFillRatio: S.ratchetMinFillRatio, minWallAgeMs: S.ratchetMinWallAgeSec * 1000, slippageTicks: S.ratchetSlippageTicks },
          );
        this.hunts.set(m.ticker, h);
      }
      const d = h.update({
        position: st.position, qSide: st.position >= 0 ? pYes : 1 - pYes,
        sideBid: st.position > 0 ? bid.price : st.position < 0 ? 1 - ask.price : undefined,
        confluence: features.conf_count, book, now, tick: m.tickSize, fees: md.feesFor(m.ticker),
        sessionBlocked: cfg.strategy.huntSessionGuard ? huntBlockedBySession(sess, cfg.strategy.huntTransitionBufferMin) : undefined,
      });
      huntMode = d.mode === 'hunt';
      st.exitMode = d.mode;
      st.huntTarget = d.target;
      st.huntStop = d.stop;
      if (d.event && d.event !== 'armed') {
        this.d.audit.write('decision', { ticker: m.ticker, huntEvent: d.event, target: d.target, stop: d.stop, position: st.position, confCount: features.conf_count, pYes });
      }
      if (d.plan) {
        huntPlan = { side: d.plan.side, price: d.plan.price, count: d.plan.count, timeInForce: 'immediate_or_cancel', postOnly: false, reduceOnly: true, purpose: 'exit', edge: 0, why: `confluence ratchet stop ${d.plan.stop}` };
      }
    } else {
      st.exitMode = 'fair_value';
    }
    const strat = {
      ...cfg.strategy,
      minEdge: cfg.strategy.minEdge + sessRisk.minEdgeAdd,
      inventorySkewPerContract: cfg.strategy.inventorySkewPerContract * sessRisk.skewMult,
      kellyFraction: tier.kellyFraction * kellyScale,
    };
    st.q = decisionProbability(view, strat);
    const plan = decide(view, strat, { exits: !huntMode && S.exitPolicy !== 'hold', blockReductions: huntMode, entries: Boolean(reason) });
    plan.notes.push(`tier ${tier.name}: ${(tier.orderFrac * 100).toFixed(1)}%/order, Kelly ${tier.kellyFraction.toFixed(2)} (high-water $${tier.reference.toFixed(2)})`);
    if (kellyScale < 1) plan.notes.push(`drawdown: Kelly x${kellyScale.toFixed(2)}`);
    for (const g of guards) plan.notes.push(g);
    if (sessRisk.applied.length) plan.notes.push(`session risk ${sessRisk.applied.join('+')}: size x${sessRisk.sizeMult}, +${sessRisk.minEdgeAdd} edge`);
    if (huntPlan) plan.place.unshift(huntPlan);
    if (huntMode) plan.notes.push(`hunting: stop ${st.huntStop ?? 'forming'}`);
    if (huntNote) plan.notes.push(huntNote);
    st.notes = plan.notes;

    const decisionId = crypto.randomUUID();
    const lastAudit = this.lastDecisionAudit.get(m.ticker) ?? 0;
    if (plan.place.length || plan.cancel.length || now - lastAudit > 30_000) {
      this.lastDecisionAudit.set(m.ticker, now);
      this.d.audit.write('decision', {
        decisionId, ticker: m.ticker, model: model.id, spot: spot.value, strike, strikeSource: m.strikeSource, sigma: vol.sigmaPerSqrtSec, sigmaPricing,
        session: sess.key, sessionRisk: sessRisk,
        kind: m.kind, cap: terms.cap, cadence: reason ?? null, featureSchema: FEATURE_SCHEMA_VERSION, pMarket, pStd: pred.std, q: st.q,
        tauSec, fv: fv.pYes, regime: fv.regime, pYes, features, modelShift: why.shiftFromFairValue, drivers: why.drivers, bid: bid.price, ask: ask.price, position: st.position, fastMove,
        place: plan.place.map((p) => ({ side: p.side, price: p.price, count: p.count, purpose: p.purpose, edge: p.edge, why: p.why })),
        cancel: plan.cancel,
      });
    }

    await Promise.all(plan.cancel.map((c) => oms.cancel(c.clientOrderId, c.reason)));
    // Orders carry the decision probability (q_adj under target-EV sizing): the gateway's fee-net
    // edge collar and TCA's edge-at-decision then judge the same number the strategy traded on.
    for (const p of plan.place) await this.placeChecked(m, p, st.q ?? pYes, decisionId);
  }

  /** Conservative-only target scale in [0.85, 1] (blend mode with target scaling on), else 1. */
  private snnTargetScale(): number {
    const snn = this.d.snn;
    return snn && this.d.cfg.snn.mode === 'blend' && this.d.cfg.snn.targetScaling ? Math.min(1, snn.scaler.scale) : 1;
  }

  private async placeChecked(m: ActiveMarket, p: OrderPlan, pYes: number, decisionId: string, tennis?: { event: string }): Promise<void> {
    const { cfg, md, oms, risk, kill, model } = this.d;
    const now = this.now();
    const T = cfg.tennis;
    const intent: OrderIntent = {
      ticker: m.ticker, asset: m.asset, windowCloseTs: m.closeTime, side: p.side, price: p.price, count: p.count,
      timeInForce: p.timeInForce, postOnly: p.postOnly, reduceOnly: p.reduceOnly, expirationTime: p.expirationTime,
      purpose: p.purpose, fairValue: pYes, modelId: model.id, decisionId,
    };
    const book = md.book(m.ticker);
    const totals = this.riskTotals(m.closeTime, tennis?.event);
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
      // Tennis has no settlement index.
      indexFresh: tennis ? true : Boolean(md.index.get(m.asset)?.fresh(now, cfg.risk.maxIndexAgeMs)),
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
      limitOverrides: this.tierLimits(this.tier()),
    };
    if (tennis) {
      // Rules-based, budgeted separately: 25% of the working cash pool in total, per-match and
      // per-order caps. The crypto model's live gate doesn't apply (TENNIS_LIVE does), and there is
      // no model fair value to require an edge against.
      ctx.modelLiveBlockers = [];
      ctx.skipEdgeCollar = true;
      ctx.limitOverrides = { maxOrderRiskFrac: T.orderFrac, maxWindowRiskFrac: T.maxMatchFrac, maxTotalRiskFrac: T.maxTotalFrac, minSidePrice: Math.min(T.underdogMin, cfg.risk.minSidePrice) };
    }
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

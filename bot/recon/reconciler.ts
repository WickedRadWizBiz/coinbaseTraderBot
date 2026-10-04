// Reconciliation: the exchange is the source of truth.
//
// Every interval, and on every WebSocket reconnect:
//  1. Replay fills from the exchange since our last fill (minus a margin)
//     through the OMS's de-duplicating fill path. A missed WebSocket fill is
//     repaired here, not reported as a break.
//  2. Compare resting orders: exchange orders we don't know are orphans
//     (cancelled immediately); orders we think are live but the exchange does
//     not list are re-queried and updated.
//  3. Compare positions per market. Markets that closed are settled from the
//     exchange's result before comparing.
//  4. Record the balance.
// The REST views lag the exchange slightly (GET /exchange/user_data_timestamp says how much): a
// position mismatch while that data predates our latest fill is a timing gap, not a break, and is
// re-checked on the next run.
// Any remaining mismatch is a BREAK: new risk halts and the operator is
// alerted. A break that persists for `killAfterBreaks` runs trips the kill
// switch. Two clean runs in a row clear the halt.

import type { AuditLog } from '../audit/auditLog';
import type { Alerter } from '../alerts/alerter';
import type { ExchangeGateway, MarketInfo } from '../kalshi/types';
import type { Oms } from '../oms/oms';
import { isLive } from '../oms/orderState';
import { logger } from '../util/log';

const log = logger('recon');

export interface ReconResult {
  ok: boolean;
  breaks: string[];
  repairedFills: number;
  orphanOrdersCanceled: number;
  balance?: number;
  ts: number;
}

export interface ReconOptions {
  gateway: ExchangeGateway;
  oms: Oms;
  audit: AuditLog;
  alerter?: Alerter;
  /** Look up a market (for settlement results of closed markets). */
  getMarket: (ticker: string) => Promise<MarketInfo | undefined>;
  onSettled?: (ticker: string, result: 'yes' | 'no') => void;
  killAfterBreaks?: number;
  onPersistentBreak: (reason: string) => void;
  now?: () => number;
}

export class Reconciler {
  private consecutiveBreaks = 0;
  private consecutiveClean = 0;
  private running = false;
  halted = true; // until the first clean run
  lastResult: ReconResult | undefined;
  private readonly now: () => number;

  constructor(private readonly o: ReconOptions) {
    this.now = o.now ?? Date.now;
  }

  async run(trigger: string): Promise<ReconResult | undefined> {
    if (this.running) return undefined;
    this.running = true;
    try {
      const res = await this.reconcile();
      this.lastResult = res;
      if (res.ok) {
        this.consecutiveBreaks = 0;
        this.consecutiveClean += 1;
        if (this.halted && (this.consecutiveClean >= 2 || trigger === 'startup')) this.halted = false;
        this.o.audit.write('recon_ok', { trigger, ...res });
      } else {
        this.consecutiveClean = 0;
        this.consecutiveBreaks += 1;
        this.halted = true;
        this.o.audit.write('recon_break', { trigger, consecutive: this.consecutiveBreaks, ...res });
        this.o.alerter?.notify('critical', 'recon-break', `Reconciliation break (${this.consecutiveBreaks}x): ${res.breaks.join('; ')}`);
        if (this.consecutiveBreaks >= (this.o.killAfterBreaks ?? 3)) {
          this.o.onPersistentBreak(`reconciliation break persisted ${this.consecutiveBreaks} runs: ${res.breaks[0]}`);
        }
      }
      return res;
    } catch (e) {
      // Failing to reconcile is itself a reason to halt new risk.
      this.halted = true;
      this.consecutiveClean = 0;
      this.consecutiveBreaks += 1;
      const msg = `reconciliation failed: ${(e as Error).message}`;
      log.error(msg);
      this.o.audit.write('recon_break', { trigger, error: msg, consecutive: this.consecutiveBreaks });
      this.o.alerter?.notify('warn', 'recon-error', msg);
      if (this.consecutiveBreaks >= (this.o.killAfterBreaks ?? 3) + 2) this.o.onPersistentBreak(msg);
      return undefined;
    } finally {
      this.running = false;
    }
  }

  private async reconcile(): Promise<ReconResult> {
    const { gateway, oms } = this.o;
    const breaks: string[] = [];
    const ts = this.now();

    // 1. Fill replay.
    const since = Math.max(0, (oms.lastFillTs || ts - 86_400_000) - 10 * 60_000);
    const fills = await gateway.getFills(since);
    let repairedFills = 0;
    for (const f of fills) if (oms.onFill(f)) repairedFills++;
    if (repairedFills) this.o.audit.write('recon_repair', { repairedFills });

    // 2. Orders.
    const exchangeOpen = await gateway.getOpenOrders();
    let orphanOrdersCanceled = 0;
    for (const ex of exchangeOpen) {
      const rec = (ex.clientOrderId && oms.get(ex.clientOrderId)) || oms.findByExchangeId(ex.orderId);
      if (!rec) {
        breaks.push(`orphan resting order ${ex.orderId} on ${ex.ticker}`);
        try { await gateway.cancelOrder(ex.orderId); orphanOrdersCanceled++; } catch (e) { breaks.push(`failed to cancel orphan ${ex.orderId}: ${String(e)}`); }
        continue;
      }
      oms.onExchangeOrder(ex);
    }
    const exchangeIds = new Set(exchangeOpen.map((o) => o.orderId));
    for (const rec of oms.liveOrders()) {
      if (rec.orderId && exchangeIds.has(rec.orderId)) continue;
      if (!rec.orderId) {
        if (ts - rec.createdTs > 30_000) breaks.push(`order ${rec.clientOrderId} never acknowledged (${rec.state})`);
        continue;
      }
      // Re-query: the order may have been placed or finished since the listing.
      const ex = await gateway.getOrder(rec.orderId);
      if (ex) oms.onExchangeOrder(ex);
      if (!ex) breaks.push(`order ${rec.clientOrderId} (${rec.orderId}) unknown to exchange`);
      else if (isLive(rec) && ex.status !== 'resting' && rec.state !== 'CANCEL_PENDING') breaks.push(`order ${rec.clientOrderId} live internally but ${ex.status} on exchange`);
    }

    // 3. Positions (settle closed markets first).
    const exchangePos = new Map((await gateway.getPositions()).map((p) => [p.ticker, p.position]));
    for (const m of oms.positions.unsettled()) {
      if (!m.closeTs || ts < m.closeTs) continue;
      if (exchangePos.has(m.ticker) && Math.abs(exchangePos.get(m.ticker)!) > 1e-9) continue;
      const info = await this.o.getMarket(m.ticker);
      if (info?.result === 'yes' || info?.result === 'no') {
        oms.settle(m.ticker, info.result);
        this.o.onSettled?.(m.ticker, info.result);
      }
    }
    const mismatches = () => {
      const tickers = new Set<string>([...exchangePos.keys(), ...oms.positions.open().map((m) => m.ticker)]);
      const out: string[] = [];
      for (const t of tickers) {
        const ours = oms.positions.position(t);
        const theirs = exchangePos.get(t) ?? 0;
        if (Math.abs(ours - theirs) > 1e-6) out.push(`position mismatch ${t}: internal ${ours} vs exchange ${theirs}`);
      }
      return out;
    };
    let posBreaks = mismatches();
    if (posBreaks.length) {
      // A fill may have landed between the fill replay and the position read.
      for (const f of await gateway.getFills(since)) if (oms.onFill(f)) repairedFills++;
      posBreaks = mismatches();
    }
    if (posBreaks.length && gateway.getUserDataTimestamp && oms.lastFillTs) {
      const asOf = await gateway.getUserDataTimestamp().catch(() => undefined);
      if (asOf !== undefined && asOf < oms.lastFillTs && ts - asOf < 120_000) {
        this.o.audit.write('recon_pending', { reason: 'exchange user data predates our last fill', asOf, lastFillTs: oms.lastFillTs, mismatches: posBreaks });
        posBreaks = [];
      }
    }
    breaks.push(...posBreaks);

    // 4. Balance.
    let balance: number | undefined;
    try { balance = await gateway.getBalance(); } catch (e) { breaks.push(`balance unavailable: ${String(e)}`); }

    return { ok: breaks.length === 0, breaks, repairedFills, orphanOrdersCanceled, balance, ts };
  }
}

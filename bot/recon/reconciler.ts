// Reconciliation: the exchange is the source of truth.
//
// Every interval, and on every WebSocket reconnect:
//  1. Replay fills from the exchange since our last fill (minus a margin)
//     through the OMS's de-duplicating fill path. A missed WebSocket fill is
//     repaired here, not reported as a break. Fills the bot did not place (the
//     operator trading by hand on Kalshi) are booked the same way: Kalshi keeps
//     one net position per market, and so do the bot's books.
//  2. Compare resting orders: orders we think are live but the exchange does
//     not list are re-queried and updated. Exchange orders we don't know: in
//     live they are the operator's own (the OMS writes every order to disk
//     before sending it), so they are left alone and listed; in paper they are
//     orphans, cancelled and reported as a break.
//  3. Compare positions per market. Markets that closed are settled from the
//     exchange's result before comparing; a market the bot never priced (a
//     manual trade elsewhere) has its close time looked up.
//  4. Record the balance.
// The REST views lag the exchange slightly (GET /exchange/user_data_timestamp says how much): a
// position mismatch while that data predates our latest fill is a timing gap, not a break, and is
// re-checked on the next run.
// A position mismatch that survives the replay is looked for in that market's own fill history, as far
// back as the OMS remembers trade ids (so nothing is booked twice). If the same mismatch is still there
// on the next run, Kalshi's position is adopted (an audit record and an alert say so) instead of halting
// until someone edits the books. At most ADOPT_PER_HOUR automatic adoptions an hour: past that the books
// keep disagreeing for a reason worth a look, and mismatches stay breaks until the operator adopts them
// (POST /api/recon/resolve, the dashboard's Resolve button).
// Any remaining mismatch is a BREAK: new risk halts and the operator is
// alerted. A break that persists for `killAfterBreaks` runs trips the kill
// switch. Two clean runs in a row clear the halt (one after the operator resolves).

import type { AuditLog } from '../audit/auditLog';
import type { Alerter } from '../alerts/alerter';
import type { ExchangeFill, ExchangeGateway, MarketInfo } from '../kalshi/types';
import type { Oms } from '../oms/oms';
import { isLive } from '../oms/orderState';
import { logger } from '../util/log';

const log = logger('recon');

/** Automatic adoptions allowed in any hour. */
const ADOPT_PER_HOUR = 3;
/** Kalshi pays a market out some time after its result (minutes for 15-minute contracts, longer for some daily ones)
 *  and lists the position until then. Settled in the books this recently, that is taken as read; later, Kalshi's own
 *  result for the market is checked (at most every PAYOUT_CHECK_MS). */
const PAYOUT_GRACE_MS = 10 * 60_000;
const PAYOUT_CHECK_MS = 5 * 60_000;
/** A market without a known close time has it looked up at most this often. */
const CLOSE_LOOKUP_MS = 10 * 60_000;

export interface ExternalOrder { orderId: string; ticker: string; side: string; price: number; remaining: number }

export interface ReconResult {
  ok: boolean;
  breaks: string[];
  repairedFills: number;
  orphanOrdersCanceled: number;
  /** Resting orders the bot did not place (live: the operator's own), left alone. */
  externalOrders: ExternalOrder[];
  /** Positions set to Kalshi's this run because no fill explained the difference. */
  adopted: string[];
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
  /** The fills the exchange listed this run, after any the bot missed were applied (the Kalshi check). */
  onFills?: (fills: ExchangeFill[]) => void;
  /** Paper mode: an order the (paper) exchange does not know is closed locally as canceled instead of
   *  being reported as a break every run (a paper book started fresh forgets its resting orders). */
  closeUnknownOrders?: boolean;
  /** Live: a resting order the bot did not place is the operator's own; it is left alone and listed instead of
   *  being cancelled as an orphan (and halting new risk). */
  leaveExternalOrders?: boolean;
  /** Adopt Kalshi's position once the same unexplained mismatch has been seen on this many runs in a row
   *  (default 2; 0 = only when the operator resolves). */
  adoptAfterRuns?: number;
  now?: () => number;
}

interface Mismatch { ticker: string; ours: number; theirs: number }

export class Reconciler {
  private consecutiveBreaks = 0;
  private consecutiveClean = 0;
  private running = false;
  halted = true; // until the first clean run
  lastResult: ReconResult | undefined;
  private readonly now: () => number;
  /** Each mismatched market: the mismatch seen and on how many runs in a row. */
  private readonly pending = new Map<string, { key: string; runs: number }>();
  private readonly adoptTimes: number[] = [];
  private readonly closeLookups = new Map<string, number>();
  /** Kalshi's result for markets settled in the books that Kalshi still lists, and when it was read. */
  private readonly payoutChecks = new Map<string, { ts: number; result?: string }>();
  private unpaidReported = '';

  constructor(private readonly o: ReconOptions) {
    this.now = o.now ?? Date.now;
  }

  /** A run is in progress (run() returns undefined at once until it ends). */
  get busy(): boolean { return this.running; }

  /** `opts.adopt`: the operator resolves the breaks: every position mismatch takes Kalshi's position now, and a
   *  clean run clears the halt at once. */
  async run(trigger: string, opts: { adopt?: boolean } = {}): Promise<ReconResult | undefined> {
    if (this.running) return undefined;
    this.running = true;
    try {
      const res = await this.reconcile(opts.adopt === true);
      this.lastResult = res;
      if (res.ok) {
        this.consecutiveBreaks = 0;
        this.consecutiveClean += 1;
        if (this.halted && (this.consecutiveClean >= 2 || trigger === 'startup' || opts.adopt)) this.halted = false;
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

  private async reconcile(adoptNow: boolean): Promise<ReconResult> {
    const { gateway, oms } = this.o;
    const breaks: string[] = [];
    const ts = this.now();

    // 1. Fill replay.
    const since = Math.max(0, (oms.lastFillTs || ts - 86_400_000) - 10 * 60_000);
    const fills = await gateway.getFills(since);
    let repairedFills = this.apply(fills);
    if (repairedFills) this.o.audit.write('recon_repair', { repairedFills });
    try { this.o.onFills?.(fills); } catch (e) { log.warn('kalshi check (fills) failed', { error: String(e) }); }

    // 2. Orders.
    const exchangeOpen = await gateway.getOpenOrders();
    let orphanOrdersCanceled = 0;
    const externalOrders: ExternalOrder[] = [];
    for (const ex of exchangeOpen) {
      const rec = (ex.clientOrderId && oms.get(ex.clientOrderId)) || oms.findByExchangeId(ex.orderId);
      if (!rec) {
        if (this.o.leaveExternalOrders) {
          externalOrders.push({ orderId: ex.orderId, ticker: ex.ticker, side: ex.side, price: ex.price, remaining: ex.remainingCount });
          continue;
        }
        breaks.push(`orphan resting order ${ex.orderId} on ${ex.ticker}`);
        try { await gateway.cancelOrder(ex.orderId, ex.ticker); orphanOrdersCanceled++; } catch (e) { breaks.push(`failed to cancel orphan ${ex.orderId}: ${String(e)}`); }
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
      if (!ex && this.o.closeUnknownOrders) {
        oms.onExchangeOrder({ orderId: rec.orderId, clientOrderId: rec.clientOrderId, ticker: rec.ticker, side: rec.side, price: rec.price, status: 'canceled', fillCount: rec.exchangeFillCount, remainingCount: 0, lastUpdateReason: 'unknown to the paper exchange' });
        this.o.audit.write('recon_repair', { closedUnknownOrder: rec.clientOrderId, orderId: rec.orderId });
      } else if (!ex) breaks.push(`order ${rec.clientOrderId} (${rec.orderId}) unknown to exchange`);
      else if (isLive(rec) && ex.status !== 'resting' && rec.state !== 'CANCEL_PENDING') breaks.push(`order ${rec.clientOrderId} live internally but ${ex.status} on exchange`);
    }

    // 3. Positions (settle closed markets first).
    const exchangePos = new Map((await gateway.getPositions()).map((p) => [p.ticker, p.position]));
    for (const m of oms.positions.unsettled()) {
      if (exchangePos.has(m.ticker) && Math.abs(exchangePos.get(m.ticker)!) > 1e-9) continue;
      if (!m.closeTs) {
        // A market the bot never priced (a trade by hand on Kalshi): learn when it closes.
        if (ts - (this.closeLookups.get(m.ticker) ?? -Infinity) < CLOSE_LOOKUP_MS) continue;
        this.closeLookups.set(m.ticker, ts);
      } else if (ts < m.closeTs) continue;
      const info = await this.o.getMarket(m.ticker).catch(() => undefined);
      if (info?.closeTime && !m.closeTs) oms.positions.ensure(m.ticker, { closeTs: info.closeTime });
      if (info?.result === 'yes' || info?.result === 'no') {
        oms.settle(m.ticker, info.result);
        this.o.onSettled?.(m.ticker, info.result);
        this.closeLookups.delete(m.ticker);
      }
    }
    const mismatches = (): Mismatch[] => {
      const tickers = new Set<string>([...exchangePos.keys(), ...oms.positions.open().map((m) => m.ticker)]);
      const out: Mismatch[] = [];
      for (const t of tickers) {
        const ours = oms.positions.position(t);
        const theirs = exchangePos.get(t) ?? 0;
        if (Math.abs(ours - theirs) > 1e-6) out.push({ ticker: t, ours, theirs });
      }
      return out;
    };
    // Settled in the books, still listed by Kalshi: not paid out yet, as long as Kalshi's result is the one we settled on.
    const unpaid: string[] = [];
    const unexplained = async (list: Mismatch[]): Promise<Mismatch[]> => {
      const out: Mismatch[] = [];
      for (const b of list) {
        if (await this.awaitingPayout(b.ticker, ts)) { if (!unpaid.includes(b.ticker)) unpaid.push(b.ticker); } else out.push(b);
      }
      return out;
    };
    let posBreaks = await unexplained(mismatches());
    if (posBreaks.length) {
      // A fill may have landed between the fill replay and the position read.
      repairedFills += this.apply(await gateway.getFills(since));
      posBreaks = await unexplained(mismatches());
    }
    if (posBreaks.length && gateway.getFillsForTicker) {
      // Further back on each market that disagrees, as far as the remembered trade ids reach.
      const from = oms.rememberedSince();
      for (const b of posBreaks) repairedFills += this.apply(await gateway.getFillsForTicker(b.ticker, from));
      posBreaks = await unexplained(mismatches());
    }
    const unpaidKey = unpaid.sort().join(',');
    if (unpaidKey !== this.unpaidReported) {
      this.unpaidReported = unpaidKey;
      if (unpaid.length) this.o.audit.write('recon_pending', { reason: 'settled in the books; Kalshi has not paid the market out yet', tickers: unpaid });
    }
    if (posBreaks.length && gateway.getUserDataTimestamp && oms.lastFillTs) {
      const asOf = await gateway.getUserDataTimestamp().catch(() => undefined);
      if (asOf !== undefined && asOf < oms.lastFillTs && ts - asOf < 120_000) {
        this.o.audit.write('recon_pending', { reason: 'exchange user data predates our last fill', asOf, lastFillTs: oms.lastFillTs, mismatches: posBreaks.map(describe) });
        posBreaks = [];
      }
    }
    const adopted = await this.adopt(posBreaks, adoptNow, breaks, ts);

    // 4. Balance.
    let balance: number | undefined;
    try { balance = await gateway.getBalance(); } catch (e) { breaks.push(`balance unavailable: ${String(e)}`); }

    return { ok: breaks.length === 0, breaks, repairedFills, orphanOrdersCanceled, externalOrders, adopted, balance, ts };
  }

  /** Book fills through the OMS (it skips the ones already booked); returns how many were new. One that cannot be
   *  booked (a fill on a market already settled in the books) is logged instead of failing the whole run. */
  private apply(fills: ExchangeFill[]): number {
    let n = 0;
    for (const f of fills) {
      try { if (this.o.oms.onFill(f)) n++; } catch (e) { log.error('fill could not be booked', { tradeId: f.tradeId, ticker: f.ticker, error: String(e) }); }
    }
    return n;
  }

  /** A market settled in the books that Kalshi still lists: true while Kalshi's result for it is the one we settled on
   *  (Kalshi has yet to pay it out). Within PAYOUT_GRACE_MS of our settlement that is assumed without asking. */
  private async awaitingPayout(ticker: string, ts: number): Promise<boolean> {
    const m = this.o.oms.positions.get(ticker);
    if (!m?.settled) { this.payoutChecks.delete(ticker); return false; }
    if (ts - (m.settledTs ?? 0) < PAYOUT_GRACE_MS) return true;
    let c = this.payoutChecks.get(ticker);
    if (!c || ts - c.ts >= PAYOUT_CHECK_MS) {
      const info = await this.o.getMarket(ticker).catch(() => undefined);
      c = { ts, result: info?.result || undefined };
      this.payoutChecks.set(ticker, c);
    }
    return c.result !== undefined && c.result === m.result;
  }

  /** Mismatches no fill explains: Kalshi's position is adopted when the operator resolves, or automatically once the
   *  same mismatch has been seen on adoptAfterRuns runs in a row; the rest are breaks. */
  private async adopt(mismatches: Mismatch[], adoptNow: boolean, breaks: string[], ts: number): Promise<string[]> {
    const { oms } = this.o;
    const adopted: string[] = [];
    const after = this.o.adoptAfterRuns ?? 2;
    while (this.adoptTimes.length && this.adoptTimes[0] <= ts - 3_600_000) this.adoptTimes.shift();
    const seen = new Set<string>();
    for (const b of mismatches) {
      seen.add(b.ticker);
      const key = `${b.ours}|${b.theirs}`;
      const prev = this.pending.get(b.ticker);
      const runs = prev?.key === key ? prev.runs + 1 : 1;
      this.pending.set(b.ticker, { key, runs });
      const m = oms.positions.get(b.ticker);
      const due = after > 0 && runs >= after;
      const allowed = this.adoptTimes.length < ADOPT_PER_HOUR;
      if (m?.settled || !(adoptNow || (due && allowed))) {
        const why = m?.settled ? `settled ${m.result ?? ''} in the books, but Kalshi still holds it and does not report that result`
          : due ? `${ADOPT_PER_HOUR} positions already adopted this hour: check, then Resolve on the dashboard`
            : after > 0 ? "Kalshi's position is adopted if this persists" : 'Resolve on the dashboard adopts Kalshi\'s position';
        breaks.push(`position mismatch ${describe(b)} (${why})`);
        continue;
      }
      const info = await this.o.getMarket(b.ticker).catch(() => undefined);
      // Priced at Kalshi's mid (the best guess of what the trade we never saw was done at), else at our cost.
      const basis = m && Math.abs(m.yes) > 1e-9 ? -m.netCash / m.yes : undefined;
      const mark = [info?.yesMid, basis].find((p): p is number => p !== undefined && p > 0 && p < 1) ?? 0.5;
      const price = Math.round(mark * 1e4) / 1e4;
      oms.adoptPosition(b.ticker, b.theirs, price, { closeTs: info?.closeTime });
      if (!adoptNow) this.adoptTimes.push(ts);
      this.pending.delete(b.ticker);
      const by = adoptNow ? 'operator' : 'auto';
      adopted.push(`${describe(b)}: adopted Kalshi's ${b.theirs} at ${price.toFixed(2)} (${by})`);
      this.o.audit.write('recon_adopt', { ticker: b.ticker, ours: b.ours, theirs: b.theirs, price, by, runs });
      this.o.alerter?.notify('warn', 'recon-adopt', `${b.ticker}: the bot's books held ${b.ours}, Kalshi holds ${b.theirs}, and no fill explains it (a trade made on Kalshi by hand?). Kalshi's position adopted at ${price.toFixed(2)}.`);
    }
    for (const t of [...this.pending.keys()]) if (!seen.has(t)) this.pending.delete(t);
    return adopted;
  }
}

function describe(b: Mismatch): string {
  return `${b.ticker}: internal ${b.ours} vs exchange ${b.theirs}`;
}

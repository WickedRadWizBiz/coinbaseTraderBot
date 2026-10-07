// Kalshi check: the bot's books against Kalshi's own records.
//
// The reconciler already holds positions and resting orders to the exchange (a mismatch halts new
// risk). This adds the money side, comparing what the bot booked with what Kalshi reports:
//   fills        every fill Kalshi lists (the reconciler's replay, every 45 s): the bot knows the trade,
//                with the same side, count, price and fee
//   settlements  every settlement record (GET /portfolio/settlements, every 5 minutes): contracts held at
//                settlement, the payout credited, the fees on the market, and, when the position was only
//                ever added to (never partly closed), the market's net P&L
//   cash         the bot's expected cash (every fill, fee, payout and transfer it knows of) vs the balance.
//                A difference is a deposit / withdrawal only if Kalshi's transfer history shows one;
//                otherwise it is an accounting mismatch, reported as such (it used to be booked as a
//                withdrawal or deposit, which hid it).
// Mismatches are kept (newest 50), written to the audit log and alerted. A UTC-day summary puts the
// bot's and Kalshi's numbers side by side. In paper the "exchange" is the simulator, so the check only
// proves the plumbing; in live it is the real comparison.

import type { AuditLog } from '../audit/auditLog';
import type { Alerter } from '../alerts/alerter';
import type { BookSide, ExchangeFill } from '../kalshi/types';
import type { MarketPosition } from '../oms/positions';
import { readJson, writeJsonAtomic } from '../util/persist';

/** One settlement as Kalshi records it (dollars). */
export interface SettlementRecord {
  ticker: string;
  result: 'yes' | 'no' | 'scalar';
  yesCount: number;
  noCount: number;
  yesCost: number;
  noCost: number;
  /** Payout credited (winning contracts x $1). */
  revenue: number;
  fees: number;
  ts: number;
}

/** A deposit or withdrawal in Kalshi's history. */
export interface TransferRecord { id: string; kind: 'deposit' | 'withdrawal'; amount: number; status: string; ts: number }

/** What the check reads from the exchange beyond the reconciler's fills and balance. */
export interface CheckSource {
  getSettlements?(sinceTs: number): Promise<SettlementRecord[]>;
  getTransfers?(sinceTs: number): Promise<TransferRecord[]>;
}

export type MismatchKind = 'fill' | 'fill_unknown' | 'settlement' | 'settlement_missing' | 'settlement_unknown' | 'cash';
export interface Mismatch { ts: number; kind: MismatchKind; ticker?: string; what: string; bot?: number | string; kalshi?: number | string }

interface Side { fills: number; contracts: number; fees: number; settled: number; payout: number }
/** One UTC day, the bot's numbers next to Kalshi's. P&L is the cash line: Kalshi's balance change over the
 *  day against the change the bot's own bookings imply (they differ only by transfers or a mismatch). */
export interface DaySummary { day: string; bot: Side & { pnl: number }; kalshi: Side; cash?: { kalshiStart: number; kalshiEnd: number; botExpectedChange: number } }

interface BotFill { ticker: string; side: BookSide; count: number; price: number; fee: number; ts: number }
interface BotSettlement { ticker: string; result: 'yes' | 'no'; positionBefore: number; payout: number; fees: number; realized: number; closedPart: boolean; ts: number }

interface State {
  mismatches: Mismatch[];
  days: DaySummary[];
  checked: { fills: number; settlements: number; transfers: number };
  matched: { fills: number; settlements: number };
  cash?: { kalshi: number; botExpected?: number; diff?: number; ts: number };
  settlementsSince: number;
  lastSettlementCheck?: number;
  transfersBooked: string[];
  lastError?: string;
}

const ZERO = (): Side => ({ fills: 0, contracts: 0, fees: 0, settled: 0, payout: 0 });
const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const DAY = 86_400_000;

export interface KalshiCheckOpts {
  file?: string;
  source: CheckSource;
  audit?: AuditLog;
  alerter?: Alerter;
  now?: () => number;
  /** Has the OMS already booked this trade (before a restart)? */
  seenTrade?: (tradeId: string) => boolean;
  /** The bot's position record for a ticker (open or settled). */
  position?: (ticker: string) => MarketPosition | undefined;
  /** Fee tolerance (dollars); Kalshi rounds fees to the cent. */
  feeTol?: number;
}

export class KalshiCheck {
  private st: State;
  private readonly now: () => number;
  private readonly fills = new Map<string, BotFill>();
  /** Exchange trade ids already compared (the replay window lists each fill many times). */
  private readonly compared = new Map<string, number>();
  private readonly settledByBot = new Map<string, BotSettlement>();
  /** Tickers whose position was reduced by a fill (net P&L then spans closes the record does not show). */
  private readonly partlyClosed = new Set<string>();
  private settleTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly o: KalshiCheckOpts) {
    this.now = o.now ?? Date.now;
    this.st = (o.file && readJson<State>(o.file)) || { mismatches: [], days: [], checked: { fills: 0, settlements: 0, transfers: 0 }, matched: { fills: 0, settlements: 0 }, settlementsSince: this.now() - DAY, transfersBooked: [] };
    this.st.transfersBooked ??= [];
  }

  // ---- The bot's side -------------------------------------------------------------------------

  /** A fill the OMS booked (fee as booked, position after it). */
  onBotFill(f: ExchangeFill, fee: number, positionAfter: number): void {
    this.fills.set(f.tradeId, { ticker: f.ticker, side: f.side, count: f.count, price: f.price, fee, ts: f.ts });
    const before = positionAfter - (f.side === 'bid' ? f.count : -f.count);
    if (Math.abs(positionAfter) < Math.abs(before) - 1e-9) this.partlyClosed.add(f.ticker);
    const d = this.day(f.ts).bot;
    d.fills++; d.contracts = r4(d.contracts + f.count); d.fees = r4(d.fees + fee);
    this.prune();
    this.save();
  }

  /** A market the OMS settled (its record just after settlement). */
  onBotSettle(e: { ticker: string; result: 'yes' | 'no'; realized: number; positionBefore: number }, m: MarketPosition | undefined): void {
    const payout = e.positionBefore > 0 && e.result === 'yes' ? e.positionBefore : e.positionBefore < 0 && e.result === 'no' ? -e.positionBefore : 0;
    const ts = m?.settledTs ?? this.now();
    this.settledByBot.set(e.ticker, { ticker: e.ticker, result: e.result, positionBefore: e.positionBefore, payout, fees: m?.fees ?? 0, realized: e.realized, closedPart: this.partlyClosed.has(e.ticker), ts });
    const d = this.day(ts).bot;
    d.settled++; d.pnl = r4(d.pnl + e.realized); d.payout = r4(d.payout + payout);
    this.save();
  }

  // ---- Kalshi's side --------------------------------------------------------------------------

  /** Fills as Kalshi lists them (after the reconciler has applied any the bot missed). */
  onExchangeFills(fills: ExchangeFill[]): void {
    let changed = false;
    for (const f of fills) {
      if (this.compared.has(f.tradeId)) continue;
      this.compared.set(f.tradeId, f.ts);
      changed = true;
      this.st.checked.fills++;
      const d = this.day(f.ts).kalshi;
      d.fills++; d.contracts = r4(d.contracts + f.count); if (f.fee !== undefined) d.fees = r4(d.fees + f.fee);
      const b = this.fills.get(f.tradeId);
      if (!b) {
        // Booked before a restart (the OMS remembers it): nothing to compare it with here.
        if (this.o.seenTrade?.(f.tradeId)) { this.st.matched.fills++; continue; }
        this.flag({ kind: 'fill_unknown', ticker: f.ticker, what: `fill ${f.tradeId} (${f.side} ${f.count} @ ${f.price}) is on Kalshi but not in the bot's books` });
        continue;
      }
      const diffs: string[] = [];
      if (b.side !== f.side) diffs.push(`side ${b.side} vs ${f.side}`);
      if (Math.abs(b.count - f.count) > 1e-6) diffs.push(`count ${b.count} vs ${f.count}`);
      if (Math.abs(b.price - f.price) > 1e-6) diffs.push(`price ${b.price} vs ${f.price}`);
      if (f.fee !== undefined && Math.abs(b.fee - f.fee) > (this.o.feeTol ?? 0.005)) diffs.push(`fee $${b.fee.toFixed(4)} vs $${f.fee.toFixed(4)}`);
      if (diffs.length) this.flag({ kind: 'fill', ticker: f.ticker, what: `fill ${f.tradeId}: bot vs Kalshi ${diffs.join(', ')}` });
      else this.st.matched.fills++;
    }
    if (changed) { this.prune(); this.save(); }
  }

  /** The balance Kalshi reports and the cash the bot expects (before any transfer is booked). */
  onBalance(kalshi: number, botExpected: number | undefined): void {
    const ts = this.now();
    this.st.cash = { kalshi: r4(kalshi), botExpected: botExpected === undefined ? undefined : r4(botExpected), diff: botExpected === undefined ? undefined : r4(kalshi - botExpected), ts };
    const day = this.day(ts);
    if (!day.cash) day.cash = { kalshiStart: r4(kalshi), kalshiEnd: r4(kalshi), botExpectedChange: 0 };
    day.cash.kalshiEnd = r4(kalshi);
  }

  /** Track the bot's own expected cash change for the day summary. */
  onBotCash(delta: number): void {
    const day = this.day(this.now());
    if (day.cash) day.cash.botExpectedChange = r4(day.cash.botExpectedChange + delta);
  }

  /**
   * The balance moved without a trade by `amount` (> 0 in, < 0 out), stable across checks. A transfer
   * only if Kalshi's history shows applied deposits / withdrawals not yet booked that add up to it;
   * otherwise an accounting mismatch. 'unverifiable': no transfer history (paper) or it could not be read.
   */
  async verifyTransfer(amount: number, sinceTs = this.now() - 7 * DAY): Promise<'verified' | 'unexplained' | 'unverifiable'> {
    if (!this.o.source.getTransfers) return 'unverifiable';
    let rows: TransferRecord[];
    try { rows = await this.o.source.getTransfers(sinceTs); } catch (e) { this.st.lastError = `transfer history: ${(e as Error).message}`; return 'unverifiable'; }
    this.st.checked.transfers++;
    const fresh = rows.filter((r) => r.status === 'applied' && !this.st.transfersBooked.includes(r.id));
    const signed = (r: TransferRecord) => (r.kind === 'deposit' ? r.amount : -r.amount);
    // One transfer, or all the new ones together, matching to the cent.
    const one = fresh.find((r) => Math.abs(signed(r) - amount) < 0.01);
    const all = fresh.reduce((s, r) => s + signed(r), 0);
    const used = one ? [one] : fresh.length && Math.abs(all - amount) < 0.01 ? fresh : [];
    if (used.length) {
      this.st.transfersBooked.push(...used.map((r) => r.id));
      this.st.transfersBooked = this.st.transfersBooked.slice(-200);
      this.save();
      return 'verified';
    }
    this.flag({ kind: 'cash', what: `cash ${amount > 0 ? 'rose' : 'fell'} by $${Math.abs(amount).toFixed(2)} with no trade and no ${amount > 0 ? 'deposit' : 'withdrawal'} in Kalshi's history: the bot's books were off by that much (books re-anchored to Kalshi's balance)`, kalshi: r4(amount) });
    return 'unexplained';
  }

  /** Compare Kalshi's settlement records since the last check with the bot's settlements. */
  async checkSettlements(): Promise<void> {
    if (!this.o.source.getSettlements || this.running) return;
    this.running = true;
    const now = this.now();
    try {
      const since = this.st.settlementsSince - 3_600_000;
      const rows = await this.o.source.getSettlements(since);
      for (const k of rows) this.compareSettlement(k, now);
      // Bot settlements Kalshi has not recorded two hours on.
      for (const b of this.settledByBot.values()) {
        if (now - b.ts > 2 * 3_600_000 && !rows.some((k) => k.ticker === b.ticker) && Math.abs(b.positionBefore) > 1e-9) {
          this.flag({ kind: 'settlement_missing', ticker: b.ticker, what: `the bot settled ${b.ticker} (${b.positionBefore} contracts, ${b.result}) but Kalshi has no settlement record for it` });
          this.settledByBot.delete(b.ticker);
        }
      }
      this.st.settlementsSince = Math.max(this.st.settlementsSince, ...rows.map((r) => r.ts), now - 3_600_000);
      this.st.lastSettlementCheck = now;
      this.st.lastError = undefined;
    } catch (e) {
      this.st.lastError = `settlements: ${(e as Error).message}`;
    } finally {
      this.running = false;
      this.save();
    }
  }

  private readonly seenSettlements = new Set<string>();
  private compareSettlement(k: SettlementRecord, now: number): void {
    const key = `${k.ticker}|${k.ts}`;
    if (this.seenSettlements.has(key)) return;
    const b = this.settledByBot.get(k.ticker);
    if (!b) {
      const pos = this.o.position?.(k.ticker);
      if (pos && !pos.settled && now - k.ts < 30 * 60_000) return; // the bot settles it shortly (sweeper / lifecycle)
      if (pos?.settled) return; // settled before a restart: no record of the bot's side to compare with
      this.seenSettlements.add(key);
      this.st.checked.settlements++;
      this.flag({ kind: 'settlement_unknown', ticker: k.ticker, what: `Kalshi settled ${k.ticker} (${k.yesCount} YES / ${k.noCount} NO, result ${k.result}) but the bot ${pos ? 'still holds it open' : 'has no position there'}` });
      return;
    }
    this.seenSettlements.add(key);
    this.st.checked.settlements++;
    const d = this.day(k.ts).kalshi;
    d.settled++; d.payout = r4(d.payout + k.revenue);
    const kalshiNet = k.revenue - k.yesCost - k.noCost - k.fees;
    const diffs: string[] = [];
    const held = k.yesCount - k.noCount;
    if (Math.abs(held - b.positionBefore) > 1e-6) diffs.push(`contracts held ${b.positionBefore} vs ${held}`);
    if (k.result !== 'scalar' && k.result !== b.result) diffs.push(`result ${b.result} vs ${k.result}`);
    if (Math.abs(k.revenue - b.payout) > 0.005) diffs.push(`payout $${b.payout.toFixed(2)} vs $${k.revenue.toFixed(2)}`);
    if (Math.abs(k.fees - b.fees) > (this.o.feeTol ?? 0.005)) diffs.push(`fees $${b.fees.toFixed(4)} vs $${k.fees.toFixed(4)}`);
    if (!b.closedPart && Math.abs(kalshiNet - b.realized) > 0.01) diffs.push(`net P&L $${b.realized.toFixed(4)} vs $${kalshiNet.toFixed(4)}`);
    if (diffs.length) this.flag({ kind: 'settlement', ticker: k.ticker, what: `settlement ${k.ticker}: bot vs Kalshi ${diffs.join(', ')}` });
    else this.st.matched.settlements++;
    this.settledByBot.delete(k.ticker);
  }

  /** Poll settlements every `everyMs` (5 minutes). */
  start(everyMs = 5 * 60_000): void {
    if (this.settleTimer) return;
    this.settleTimer = setInterval(() => void this.checkSettlements(), everyMs);
    this.settleTimer.unref();
  }
  stop(): void { if (this.settleTimer) clearInterval(this.settleTimer); this.settleTimer = null; }

  // ---- Reporting ------------------------------------------------------------------------------

  status() {
    const s = this.st;
    const today = s.days.find((d) => d.day === dayOf(this.now()));
    const recent = s.mismatches.filter((m) => this.now() - m.ts < DAY);
    return {
      ok: recent.length === 0,
      mismatches24h: recent.length,
      checked: s.checked,
      matched: s.matched,
      cash: s.cash ?? null,
      today: today ?? null,
      lastSettlementCheck: s.lastSettlementCheck ?? null,
      lastError: s.lastError ?? null,
    };
  }

  report() {
    return { ...this.status(), mismatches: this.st.mismatches.slice(-50).reverse(), days: this.st.days.slice(-7).reverse() };
  }

  private flag(m: Omit<Mismatch, 'ts'>): void {
    const rec: Mismatch = { ts: this.now(), ...m };
    this.st.mismatches.push(rec);
    if (this.st.mismatches.length > 200) this.st.mismatches = this.st.mismatches.slice(-200);
    this.o.audit?.write('recon_break', { kalshiCheck: true, ...rec });
    this.o.alerter?.notify('warn', `kalshi-check-${m.kind}`, `Kalshi check: ${m.what}`);
  }

  private day(ts: number): DaySummary {
    const k = dayOf(ts);
    let d = this.st.days.find((x) => x.day === k);
    if (!d) {
      d = { day: k, bot: { ...ZERO(), pnl: 0 }, kalshi: ZERO() };
      this.st.days.push(d);
      this.st.days.sort((a, b) => (a.day < b.day ? -1 : 1));
      if (this.st.days.length > 14) this.st.days = this.st.days.slice(-14);
    }
    return d;
  }

  private prune(): void {
    const cut = this.now() - 2 * DAY;
    if (this.fills.size > 5000) for (const [id, f] of this.fills) if (f.ts < cut) this.fills.delete(id);
    if (this.compared.size > 5000) for (const [id, ts] of this.compared) if (ts < cut) this.compared.delete(id);
  }

  private saveTimer: NodeJS.Timeout | null = null;
  private save(): void {
    if (!this.o.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; writeJsonAtomic(this.o.file!, this.st, { compact: true }); }, 2000);
    this.saveTimer.unref();
  }
  flush(): void { if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; } if (this.o.file) writeJsonAtomic(this.o.file, this.st, { compact: true }); }
}

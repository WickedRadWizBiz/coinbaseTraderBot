// Paper settlement sweeper: settles the paper account AND the bot's own position records from Kalshi's
// official results, for every contract either side still holds.
//
// The live-event path (a "determined"/"settled" lifecycle message) settles nothing when the bot is not
// running at that moment, and the reconciler only settles the bot's records once the paper account has
// dropped the position, so one missed message used to leave a position open forever. This sweep asks
// Kalshi directly, trusting Kalshi's own close time and result over the cached ones: a contract the bot
// thinks is still open is re-checked every 10 minutes, one past its close every minute, until settled.
// A contract still unsettled 30 minutes after its close is reported (once per 30 minutes) with the reason.

export interface SweeperMarket { status?: string; closeTime?: number; result?: string }

export interface SweeperDeps {
  paperPositions: () => Promise<Array<{ ticker: string; position: number }>>;
  /** The bot's unsettled position records (closeTs from the order that opened them; 0 if unknown). */
  omsUnsettled: () => Array<{ ticker: string; closeTs: number }>;
  getMarket: (ticker: string) => Promise<SweeperMarket | undefined>;
  settlePaper: (ticker: string, result: 'yes' | 'no') => void;
  settleOms: (ticker: string, result: 'yes' | 'no') => void;
  recordResult?: (ticker: string, result: 'yes' | 'no') => void;
  /** The close time the bot is currently using for a contract (market catalog), if it has one. */
  closeTsOf?: (ticker: string) => number | undefined;
  /** Kalshi reports an earlier close than the cached one: fix the cache (the market then stops being "open"). */
  correctCloseTime?: (ticker: string, closeTime: number) => void;
  warn?: (msg: string, meta: Record<string, unknown>) => void;
  info?: (msg: string, meta: Record<string, unknown>) => void;
  now?: () => number;
}

interface Check { checkedTs: number; status?: string; result?: string; kalshiCloseTs?: number; error?: string; warnedTs?: number }

export interface AwaitingSettlement { ticker: string; closeTs: number | null; minutesPastClose: number | null; kalshiStatus: string | null; result: string | null; lastCheck: number | null; error: string | null }

const PAST_CLOSE_EVERY_MS = 60_000;
const BEFORE_CLOSE_EVERY_MS = 10 * 60_000;
const OVERDUE_MS = 30 * 60_000;

export class SettlementSweeper {
  private readonly checks = new Map<string, Check>();
  private readonly known = new Map<string, number | undefined>();
  private busy = false;
  settledCount = 0;

  constructor(private readonly d: SweeperDeps) {}

  private get now(): number { return (this.d.now ?? Date.now)(); }

  /** One pass (also called by tests). */
  async sweep(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const held = new Map<string, number | undefined>();
      for (const p of await this.d.paperPositions()) held.set(p.ticker, this.d.closeTsOf?.(p.ticker));
      for (const m of this.d.omsUnsettled()) held.set(m.ticker, (m.closeTs > 0 ? m.closeTs : undefined) ?? held.get(m.ticker) ?? this.d.closeTsOf?.(m.ticker));
      for (const t of [...this.checks.keys()]) if (!held.has(t)) { this.checks.delete(t); this.known.delete(t); }
      for (const [ticker, cached] of held) {
        this.known.set(ticker, cached);
        await this.check(ticker, cached);
      }
    } finally { this.busy = false; }
  }

  private async check(ticker: string, cached: number | undefined): Promise<void> {
    const now = this.now;
    const prev = this.checks.get(ticker);
    const kalshiClose = prev?.kalshiCloseTs;
    const closeTs = kalshiClose ?? cached;
    const pastClose = closeTs !== undefined && now >= closeTs;
    if (prev && now - prev.checkedTs < (pastClose ? PAST_CLOSE_EVERY_MS : BEFORE_CLOSE_EVERY_MS)) return;
    let info: SweeperMarket | undefined;
    try {
      info = await this.d.getMarket(ticker);
    } catch (e) {
      this.checks.set(ticker, { ...prev, checkedTs: now, error: String(e).slice(0, 200) });
      this.maybeWarn(ticker, closeTs);
      return;
    }
    const rec: Check = { ...prev, checkedTs: now, status: info?.status, result: info?.result || undefined, kalshiCloseTs: info?.closeTime ?? prev?.kalshiCloseTs, error: info ? undefined : 'market not found' };
    this.checks.set(ticker, rec);
    if (info?.closeTime !== undefined && cached !== undefined && info.closeTime < cached - 1000) this.d.correctCloseTime?.(ticker, info.closeTime);
    if (info?.result === 'yes' || info?.result === 'no') {
      this.d.settlePaper(ticker, info.result);
      this.d.settleOms(ticker, info.result);
      this.d.recordResult?.(ticker, info.result);
      this.settledCount++;
      this.checks.delete(ticker);
      this.known.delete(ticker);
      this.d.info?.('position settled from the official result', { ticker, result: info.result, minutesPastClose: closeTs !== undefined ? Math.round((now - closeTs) / 60_000) : null });
      return;
    }
    this.maybeWarn(ticker, rec.kalshiCloseTs ?? closeTs);
  }

  private maybeWarn(ticker: string, closeTs: number | undefined): void {
    const now = this.now;
    const c = this.checks.get(ticker);
    if (!c || closeTs === undefined || now - closeTs < OVERDUE_MS) return;
    if (c.warnedTs !== undefined && now - c.warnedTs < OVERDUE_MS) return;
    c.warnedTs = now;
    this.d.warn?.('position still unsettled after its close', { ticker, minutesPastClose: Math.round((now - closeTs) / 60_000), kalshiStatus: c.status ?? null, result: c.result ?? null, error: c.error ?? null });
  }

  /** Every held contract not yet settled, with what Kalshi last said about it. */
  status(): { settled: number; awaiting: AwaitingSettlement[] } {
    const now = this.now;
    const awaiting = [...this.known.entries()].map(([ticker, cached]) => {
      const c = this.checks.get(ticker);
      const closeTs = c?.kalshiCloseTs ?? cached ?? null;
      return {
        ticker, closeTs, minutesPastClose: closeTs !== null && now >= closeTs ? Math.round((now - closeTs) / 60_000) : null,
        kalshiStatus: c?.status ?? null, result: c?.result ?? null, lastCheck: c?.checkedTs ?? null, error: c?.error ?? null,
      };
    }).sort((a, b) => (b.minutesPastClose ?? -1) - (a.minutesPastClose ?? -1));
    return { settled: this.settledCount, awaiting };
  }
}

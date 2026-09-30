// Profit vault and pocket: rules for how much of the Kalshi cash pool the bot
// treats as its own to trade. Nothing moves on the exchange; reserved money is
// simply excluded from the tradable bankroll (sizing and risk limits).
//
// Vault (quota): 50% of every win (market settled with positive, fee-inclusive
//   realized PnL) is vaulted until the quota ($100) is met. Vaulting then stops
//   until the next market session opens (any session: Asia, London, overlap,
//   New York, twilight, weekend), when the quota resets. Vaulted money is
//   permanent until withdrawn.
// Pocket: only while the quota is met, 10% of each win is pocketed. Pocket
//   cycles run from one US market open (NYSE 09:30 ET) to the next; money
//   pocketed in a cycle is released back to trading at the next US open.
//   A win that crosses the quota fills it, and the rest of that win is
//   subject to the pocket.
// Withdrawals from the Kalshi account come out of the vault first, then the
//   pocket, then trading cash. Deposits add to trading cash.
// Graduation ramp: a small account has to compound to reach the larger sizing tiers, so the vault and
//   pocket shares are scaled by a factor that is 0 at rampStartUsd (the aggressive tier's $20) and
//   reaches 1 at rampFullUsd (the normal tier's $100), interpolated in log(bankroll) like the tiers.
//   The factor reads the tier high-water mark, so once an account has graduated it stays skimmed at
//   the full rate. rampFullUsd = 0 turns the ramp off (full shares at any size).

import { readJson, writeJsonAtomic } from '../util/persist';
import { sessionState, VENUES, zoneTime } from '../model/sessions';

export interface VaultConfig {
  enabled: boolean;
  quotaUsd: number;
  winShare: number;      // 0.5
  pocketShare: number;   // 0.1
  /** When the quota resets: at every session open, or once per day at the US open. */
  quotaReset: 'session' | 'us_open';
  /** Headline daily vault goal (US open to next US open). Exceeding it is fine. */
  dailyGoalUsd: number;
  /** Graduation ramp (see header): tradable high-water mark where skimming starts / reaches full share. 0 full = off. */
  rampStartUsd?: number;
  rampFullUsd?: number;
}

export const DEFAULT_VAULT: VaultConfig = { enabled: true, quotaUsd: 100, winShare: 0.5, pocketShare: 0.1, quotaReset: 'session', dailyGoalUsd: 100, rampStartUsd: 20, rampFullUsd: 100 };

/** Share of the vault/pocket rules applied at a tradable high-water mark: 0 at rampStartUsd, 1 at rampFullUsd. */
export function vaultRamp(cfg: Pick<VaultConfig, 'rampStartUsd' | 'rampFullUsd'>, reference: number | undefined): number {
  const full = cfg.rampFullUsd ?? 0, start = cfg.rampStartUsd ?? 0;
  if (!(full > 0) || reference === undefined || !(full > start)) return 1;
  if (reference >= full) return 1;
  if (reference <= start || start <= 0) return reference <= start ? 0 : 1;
  return (Math.log(reference) - Math.log(start)) / (Math.log(full) - Math.log(start));
}

export type VaultEventKind = 'vault' | 'pocket' | 'release' | 'withdrawal' | 'deposit' | 'quota_reset' | 'skip';

export interface VaultEvent {
  ts: number;
  kind: VaultEventKind;
  amount: number;
  ticker?: string;
  note?: string;
}

interface PocketEntry { amount: number; ts: number; releaseAt: number }

export interface VaultState {
  vault: number;
  pocket: PocketEntry[];
  quotaPeriodStart: number;
  quotaFilled: number;
  withdrawnTotal: number;
  /** Vaulted since the day (US open) began, and when that day began. */
  dailyVaulted?: number;
  dailyStart?: number;
  events: VaultEvent[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Next NYSE open (09:30 America/New_York on a weekday) strictly after ts. */
export function nextUsOpen(ts: number): number {
  const step = 30 * 60_000;
  let t = Math.floor(ts / step) * step + step;
  for (let i = 0; i < 7 * 48; i++, t += step) {
    const z = zoneTime(t, VENUES.newYork.tz);
    if (z.weekday >= 1 && z.weekday <= 5 && z.minutes === VENUES.newYork.open) return t;
  }
  return ts + 86_400_000;
}

/** Most recent NYSE open at or before ts. */
export function prevUsOpen(ts: number): number {
  const step = 30 * 60_000;
  let t = Math.floor(ts / step) * step;
  for (let i = 0; i < 7 * 48; i++, t -= step) {
    const z = zoneTime(t, VENUES.newYork.tz);
    if (z.weekday >= 1 && z.weekday <= 5 && z.minutes === VENUES.newYork.open) return t;
  }
  return ts - 86_400_000;
}

/** Start of the quota period containing ts. */
export function quotaPeriodStart(ts: number, mode: VaultConfig['quotaReset']): number {
  return mode === 'session' ? sessionState(ts).since ?? ts : prevUsOpen(ts);
}

export class Vault {
  private st: VaultState;
  private lastRamp = 1;

  constructor(private readonly cfg: VaultConfig, private readonly file?: string, private readonly now: () => number = Date.now) {
    this.st = (file && readJson<VaultState>(file)) || { vault: 0, pocket: [], quotaPeriodStart: 0, quotaFilled: 0, withdrawnTotal: 0, events: [] };
  }

  private save(): void {
    if (this.st.events.length > 500) this.st.events = this.st.events.slice(-500);
    if (this.file) writeJsonAtomic(this.file, this.st);
  }

  private log(e: VaultEvent): void {
    this.st.events.push(e);
  }

  get vaultTotal(): number { return r2(this.st.vault); }
  get pocketTotal(): number { return r2(this.st.pocket.reduce((s, p) => s + p.amount, 0)); }
  /** Money excluded from the tradable bankroll. */
  reserved(): number { return this.cfg.enabled ? r2(this.st.vault + this.pocketTotal) : 0; }

  /** Roll the quota period and release matured pocket entries. */
  tick(now = this.now()): void {
    if (!this.cfg.enabled) return;
    let changed = false;
    const start = quotaPeriodStart(now, this.cfg.quotaReset);
    if (start !== this.st.quotaPeriodStart) {
      if (this.st.quotaPeriodStart && this.st.quotaFilled > 0) this.log({ ts: now, kind: 'quota_reset', amount: this.st.quotaFilled, note: 'new period: 50% vaulting resumes' });
      this.st.quotaPeriodStart = start;
      this.st.quotaFilled = 0;
      changed = true;
    }
    const day = prevUsOpen(now);
    if (day !== this.st.dailyStart) {
      this.st.dailyStart = day;
      this.st.dailyVaulted = 0;
      changed = true;
    }
    const due = this.st.pocket.filter((p) => p.releaseAt <= now);
    if (due.length) {
      const amt = r2(due.reduce((s, p) => s + p.amount, 0));
      this.st.pocket = this.st.pocket.filter((p) => p.releaseAt > now);
      this.log({ ts: now, kind: 'release', amount: amt, note: 'US market open: pocket released to trading' });
      changed = true;
    }
    if (changed) this.save();
  }

  /** A market settled. Only positive realized PnL (a win) is shared. */
  onSettled(realized: number, ticker: string, now = this.now(), reference?: number): void {
    if (!this.cfg.enabled || !(realized > 0)) return;
    this.tick(now);
    const ramp = vaultRamp(this.cfg, reference);
    this.lastRamp = ramp;
    if (ramp <= 0) {
      this.log({ ts: now, kind: 'skip', amount: 0, ticker, note: `$${realized.toFixed(2)} win kept for trading: high-water $${(reference ?? 0).toFixed(2)} is at or below the $${this.cfg.rampStartUsd} ramp start` });
      this.save();
      return;
    }
    const toQuota = Math.max(0, this.cfg.quotaUsd - this.st.quotaFilled);
    const wantVault = ramp * this.cfg.winShare * realized;
    const v = r2(Math.min(wantVault, toQuota));
    if (v > 0) {
      this.st.vault = r2(this.st.vault + v);
      this.st.quotaFilled = r2(this.st.quotaFilled + v);
      this.st.dailyVaulted = r2((this.st.dailyVaulted ?? 0) + v);
      this.log({ ts: now, kind: 'vault', amount: v, ticker, note: `${Math.round(ramp * this.cfg.winShare * 100)}% of $${realized.toFixed(2)} win` });
    }
    // Portion of the win after the quota was met is subject to the pocket.
    const postQuotaShare = wantVault > 0 ? 1 - v / wantVault : 1;
    const p = r2(ramp * this.cfg.pocketShare * realized * postQuotaShare);
    if (p > 0 && this.st.quotaFilled >= this.cfg.quotaUsd - 1e-9) {
      const releaseAt = nextUsOpen(now);
      this.st.pocket.push({ amount: p, ts: now, releaseAt });
      this.log({ ts: now, kind: 'pocket', amount: p, ticker, note: `${Math.round(ramp * this.cfg.pocketShare * 100)}% pocketed until ${new Date(releaseAt).toISOString()}` });
    }
    this.save();
  }

  /** Withdrawal: vault first, then pocket (newest first), then trading cash. */
  onWithdrawal(amount: number, source: 'detected' | 'manual', now = this.now()): { fromVault: number; fromPocket: number; fromTrading: number } {
    const amt = r2(Math.abs(amount));
    const fromVault = r2(Math.min(this.st.vault, amt));
    this.st.vault = r2(this.st.vault - fromVault);
    let rest = r2(amt - fromVault);
    let fromPocket = 0;
    this.st.pocket.sort((a, b) => b.ts - a.ts);
    for (const e of this.st.pocket) {
      if (rest <= 0) break;
      const take = Math.min(e.amount, rest);
      e.amount = r2(e.amount - take);
      rest = r2(rest - take);
      fromPocket = r2(fromPocket + take);
    }
    this.st.pocket = this.st.pocket.filter((e) => e.amount > 0);
    this.st.withdrawnTotal = r2(this.st.withdrawnTotal + amt);
    this.log({ ts: now, kind: 'withdrawal', amount: amt, note: `${source}: vault -$${fromVault.toFixed(2)}, pocket -$${fromPocket.toFixed(2)}, trading -$${rest.toFixed(2)}` });
    this.save();
    return { fromVault, fromPocket, fromTrading: rest };
  }

  onDeposit(amount: number, now = this.now()): void {
    this.log({ ts: now, kind: 'deposit', amount: r2(amount), note: 'added to trading cash' });
    this.save();
  }

  status(now = this.now()) {
    const quotaMet = this.st.quotaFilled >= this.cfg.quotaUsd - 1e-9;
    return {
      enabled: this.cfg.enabled,
      vault: this.vaultTotal,
      pocket: this.pocketTotal,
      reserved: this.reserved(),
      quotaUsd: this.cfg.quotaUsd,
      quotaFilled: r2(this.st.quotaFilled),
      quotaReset: this.cfg.quotaReset,
      quotaPeriodStart: this.st.quotaPeriodStart || null,
      dailyGoalUsd: this.cfg.dailyGoalUsd,
      dailyVaulted: r2(this.st.dailyVaulted ?? 0),
      dailyGoalMet: (this.st.dailyVaulted ?? 0) >= this.cfg.dailyGoalUsd - 1e-9,
      phase: quotaMet ? 'pocketing' : 'vaulting',
      winShare: this.cfg.winShare,
      pocketShare: this.cfg.pocketShare,
      ramp: { startUsd: this.cfg.rampStartUsd ?? 0, fullUsd: this.cfg.rampFullUsd ?? 0, lastFactor: +this.lastRamp.toFixed(3) },
      nextRelease: this.st.pocket.length ? Math.min(...this.st.pocket.map((p) => p.releaseAt)) : null,
      nextUsOpen: nextUsOpen(now),
      withdrawnTotal: this.st.withdrawnTotal,
      events: this.st.events.slice(-30).reverse(),
    };
  }
}

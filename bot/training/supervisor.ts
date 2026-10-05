// Paper training supervisor: the kill-switch override and capital-exhaustion refills.
//
// With the override on (bot/control.ts, default ON) and TRADING_MODE=paper:
//  - automatic kill-switch trips (daily loss, order errors, reconciliation) are logged, not engaged, and a
//    switch an automatic trip left engaged is reset; the brakes de-risk instead (Engine.riskScale);
//  - when a paper cash pool can no longer trade (the Kalshi pool's tradable bankroll below
//    MIN_TRADABLE_BANKROLL_USD, the perps margin below PERP_MIN_EQUITY_USD) the epoch ends: it is logged as
//    a capital-exhaustion failure (DATA_DIR/epochs.jsonl), resting orders are cancelled, and the pool is
//    refilled to its starting amount so trading, and the data it produces, continues. Open positions are
//    left to settle on their own.
//
// How epochs are used in training: never as a penalty on individual trades (that teaches the bot that
// not trading is safest). The price models learn from every market's outcome, traded or not; an
// exhaustion says the SIZING was too large for the edge, so epochs are the data for tuning the risk
// scale (Kelly fraction, streak half-life and floor) by long-run growth across epochs.

import fs from 'fs';
import path from 'path';
import type { AuditLog } from '../audit/auditLog';
import type { Alerter } from '../alerts/alerter';
import type { Config } from '../config';
import type { RunControl } from '../control';
import type { Engine } from '../engine';
import type { Oms } from '../oms/oms';
import { KillSwitch } from '../risk/killSwitch';
import type { StreakScaler } from '../risk/streakScaler';
import type { EquityGuard } from '../risk/equityGuard';
import { logger } from '../util/log';
import { readJson, writeJsonAtomic } from '../util/persist';

const log = logger('training');

type Book = 'kalshi' | 'perps';

interface EpochState { epoch: number; startTs: number; startEquity: number; peak: number; trough: number; fills: number; refills: number; refilled: number }
interface TrainingState { kalshi: EpochState; perps: EpochState; last?: EpochRecord }

export interface EpochRecord {
  book: Book; epoch: number; startTs: number; endTs: number; hours: number;
  startEquity: number; peak: number; trough: number; endEquity: number; refill: number; fills: number;
  cause: 'capital_exhaustion'; risk?: unknown;
}

/** The paper accounts the supervisor can refill. */
export interface RefillableKalshi { refill(amount: number): void; getBalance(): Promise<number> }
export interface RefillablePerps { refill(amount: number): void; getBalance(): Promise<{ equity: number }> }

export class TrainingSupervisor {
  private st: TrainingState;
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly d: {
    cfg: Readonly<Config>; control: RunControl; kill: KillSwitch; engine: Engine; oms: Oms; audit: AuditLog; alerter: Alerter;
    equityGuard?: EquityGuard; kalshiPaper?: RefillableKalshi; perpsPaper?: RefillablePerps;
    cancelPerps?: (reason: string) => Promise<void>; perpsMinEquity?: number; perpsStart?: number; perpsStreak?: StreakScaler;
    /** Tell the balance monitor about cash the bot added itself (so it is not read as a deposit). */
    noteCash?: (amount: number) => void;
    now?: () => number;
  }) {
    const fresh = (equity: number): EpochState => ({ epoch: 1, startTs: this.now, startEquity: equity, peak: equity, trough: equity, fills: 0, refills: 0, refilled: 0 });
    const saved = readJson<TrainingState>(this.file);
    this.st = saved ?? { kalshi: fresh(d.cfg.paperBankrollUsd), perps: fresh(d.perpsStart ?? d.cfg.perps.paperBalanceUsd) };
    // Automatic trips are vetoed while the override is active (manual STOP ALL still engages).
    d.kill.setSuppressor(() => (this.active() ? 'paper training override is on: de-risking instead of halting' : undefined));
    d.oms.on('fill', () => { this.st.kalshi.fills++; });
  }

  private get now(): number { return (this.d.now ?? Date.now)(); }
  private get file(): string { return path.join(this.d.cfg.dataDir, 'training.json'); }

  /** Paper mode with the override on. */
  active(): boolean { return this.d.cfg.mode === 'paper' && this.d.control.killOverride; }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref();
    void this.tick();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  /** One supervision pass (also called by tests). */
  async tick(): Promise<void> {
    if (this.busy || !this.active()) return;
    this.busy = true;
    try {
      this.releaseAutomaticKill();
      await this.checkKalshi();
      await this.checkPerps();
      writeJsonAtomic(this.file, this.st);
    } catch (e) {
      log.warn('training supervisor pass failed', { error: String(e) });
    } finally { this.busy = false; }
  }

  /** A kill switch an automatic trip left engaged (before the override, or from a previous run) is reset. */
  private releaseAutomaticKill(): void {
    const k = this.d.kill.status();
    if (!k.engaged || KillSwitch.isManual(k.source)) return;
    this.d.kill.reset('training override');
    this.d.audit.write('training', { event: 'kill_released', previous: k });
    log.info('kill switch released by the paper training override', { reason: k.reason, source: k.source });
  }

  private async checkKalshi(): Promise<void> {
    const e = this.d.engine, paper = this.d.kalshiPaper;
    const bank = e.bankroll(), eq = e.equity();
    if (!paper || bank === undefined || eq === undefined) return;
    const s = this.st.kalshi;
    s.peak = Math.max(s.peak, eq); s.trough = Math.min(s.trough, eq);
    const floor = this.d.cfg.strategy.minTradableBankrollUsd;
    const start = this.d.cfg.paperBankrollUsd;
    if (bank >= floor || bank >= start) return;
    await this.d.oms.cancelAll('capital exhaustion: new training epoch');
    const amount = +(start - bank).toFixed(2);
    paper.refill(amount);
    this.d.noteCash?.(amount);
    e.onBalance(await paper.getBalance());
    this.d.equityGuard?.resetEpoch(e.equity() ?? start, this.now, e.bankroll() ?? start);
    this.endEpoch('kalshi', eq, amount, { crypto: e.riskScale('crypto'), tennis: e.riskScale('tennis'), streak: { crypto: e.streak.crypto.status(), tennis: e.streak.tennis.status() } });
  }

  private async checkPerps(): Promise<void> {
    const paper = this.d.perpsPaper;
    if (!paper) return;
    const { equity } = await paper.getBalance();
    if (!Number.isFinite(equity)) return;
    const s = this.st.perps;
    s.peak = Math.max(s.peak, equity); s.trough = Math.min(s.trough, equity);
    const floor = this.d.perpsMinEquity ?? 5, start = this.d.perpsStart ?? this.d.cfg.perps.paperBalanceUsd;
    if (equity >= floor || equity >= start) return;
    await this.d.cancelPerps?.('capital exhaustion: new training epoch');
    const amount = +(start - equity).toFixed(2);
    paper.refill(amount);
    this.endEpoch('perps', equity, amount);
  }

  private endEpoch(book: Book, endEquity: number, refill: number, risk?: unknown): void {
    const s = this.st[book], now = this.now;
    const rec: EpochRecord = {
      book, epoch: s.epoch, startTs: s.startTs, endTs: now, hours: +((now - s.startTs) / 3_600_000).toFixed(2),
      startEquity: +s.startEquity.toFixed(2), peak: +s.peak.toFixed(2), trough: +Math.min(s.trough, endEquity).toFixed(2), endEquity: +endEquity.toFixed(2),
      refill, fills: s.fills, cause: 'capital_exhaustion', risk,
    };
    try { fs.mkdirSync(this.d.cfg.dataDir, { recursive: true }); fs.appendFileSync(path.join(this.d.cfg.dataDir, 'epochs.jsonl'), JSON.stringify(rec) + '\n'); } catch (err) { log.warn('could not write epochs.jsonl', { error: String(err) }); }
    this.d.audit.write('training', { event: 'capital_exhaustion', ...rec });
    this.d.alerter.notify('warn', `training-${book}`, `${book === 'kalshi' ? 'Kalshi' : 'Perps'} paper pool exhausted (epoch ${s.epoch}, ${rec.hours} h, $${rec.endEquity} left): logged as a training failure and refilled with $${refill}`);
    const start = endEquity + refill;
    this.st[book] = { epoch: s.epoch + 1, startTs: now, startEquity: start, peak: start, trough: start, fills: 0, refills: s.refills + 1, refilled: +(s.refilled + refill).toFixed(2) };
    this.st.last = rec;
  }

  status() {
    const e = this.d.engine;
    return {
      override: this.d.control.killOverride, active: this.active(), mode: this.d.cfg.mode,
      kalshi: this.st.kalshi, perps: this.st.perps, lastExhaustion: this.st.last ?? null,
      risk: { crypto: e.riskScale('crypto'), tennis: e.riskScale('tennis') },
      streak: { crypto: e.streak.crypto.status(), tennis: e.streak.tennis.status(), perps: this.d.perpsStreak?.status() ?? null },
    };
  }
}

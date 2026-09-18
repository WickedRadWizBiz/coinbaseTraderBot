// Market Testing & Session Pre-Market Protocol Engine
// Implements the user's automated market testing & confluence override lifecycle:
// 1. One hour before market close / next market open (T-60m to T-30m):
//    30-minute Market Testing Period where Override Confluence is NOT engaged (false),
//    allowing the market to be gauged under natural strict confluence rules.
// 2. At T-30m: Override Confluence toggle is ACTIVATED (true).
// 3. Once $100 in profit is reached: Override Confluence toggle is DEACTIVATED (false),
//    transitioning the bot to trade much more conservatively to protect profits.

export type MarketTestingPhase = 
  | 'NORMAL_CONSERVATIVE' 
  | 'TESTING_PERIOD' 
  | 'OVERRIDE_ACTIVE' 
  | 'GOAL_REACHED_CONSERVATIVE';

export interface MarketTestingStatus {
  phase: MarketTestingPhase;
  isTestingPeriod: boolean;
  isOverrideActive: boolean;
  isConservativeProtection: boolean;
  overrideConfluenceEngaged: boolean;
  nextSessionName: string;
  nextSessionTimeStr: string;
  nextSessionOpenUtcMinute: number;
  minutesUntilNextOpen: number;
  testingTimeRemainingSec: number;
  cycleEarnedProfitInWindow: number; // Net PnL (Wins minus Losses)
  totalWinsInWindow: number;
  totalLossesInWindow: number;
  winCountInWindow: number;
  lossCountInWindow: number;
  profitTargetUsd: number; // $100.00
  profitProgressPct: number;
  statusMessage: string;
  lastStateChangeTime: number;
}

export class MarketTestingProtocolEngine {
  private profitTargetUsd: number = 100.0;
  private cycleEarnedProfitInWindow: number = 0; // Net PnL (Wins minus Losses)
  private totalWinsInWindow: number = 0;
  private totalLossesInWindow: number = 0;
  private winCountInWindow: number = 0;
  private lossCountInWindow: number = 0;
  private hasReachedTargetInWindow: boolean = false;
  private currentPhase: MarketTestingPhase = 'NORMAL_CONSERVATIVE';
  private lastPhase: MarketTestingPhase = 'NORMAL_CONSERVATIVE';
  private lastStateChangeTime: number = Date.now();
  private lastActiveSessionKey: string = '';

  // Market open times in UTC minutes from midnight:
  // 00:00 UTC = 0 (Asian Open)
  // 08:00 UTC = 480 (London Open)
  // 13:00 UTC = 780 (New York Open)
  // 21:00 UTC = 1260 (Asian Pre-Market / Re-Open)
  private readonly marketOpenSchedules = [
    { name: 'Asian Markets Open', utcMinutes: 0, timeStr: '00:00 UTC' },
    { name: 'London Market Open', utcMinutes: 480, timeStr: '08:00 UTC' },
    { name: 'New York Market Open', utcMinutes: 780, timeStr: '13:00 UTC' },
    { name: 'Asian Markets Re-Open', utcMinutes: 1260, timeStr: '21:00 UTC' },
  ];

  /**
   * Find the next market open schedule and minutes remaining.
   */
  public getNextMarketOpen(now: Date = new Date()): {
    name: string;
    utcMinutes: number;
    timeStr: string;
    minutesUntilOpen: number;
  } {
    const currentUtcMin = now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60;

    for (const sched of this.marketOpenSchedules) {
      if (sched.utcMinutes > currentUtcMin) {
        return {
          name: sched.name,
          utcMinutes: sched.utcMinutes,
          timeStr: sched.timeStr,
          minutesUntilOpen: sched.utcMinutes - currentUtcMin
        };
      }
    }

    // Wrap around to midnight (00:00 UTC next day)
    const minutesUntilMidnight = (1440 - currentUtcMin);
    return {
      name: 'Asian Markets Open',
      utcMinutes: 0,
      timeStr: '00:00 UTC',
      minutesUntilOpen: minutesUntilMidnight
    };
  }

  /**
   * Record trade outcome (both wins and losses) toward the $100 net profit milestone.
   * Cumulative profit = wins - losses until $100 net profit is reached.
   */
  public recordTradeResult(pnlUsd: number): void {
    this.cycleEarnedProfitInWindow += pnlUsd;
    if (pnlUsd > 0) {
      this.totalWinsInWindow += pnlUsd;
      this.winCountInWindow += 1;
    } else if (pnlUsd < 0) {
      this.totalLossesInWindow += Math.abs(pnlUsd);
      this.lossCountInWindow += 1;
    }

    if (this.cycleEarnedProfitInWindow >= this.profitTargetUsd) {
      this.hasReachedTargetInWindow = true;
    }
  }

  /**
   * Backwards compatible alias for recordTradeResult
   */
  public recordTradeProfit(pnlUsd: number): void {
    this.recordTradeResult(pnlUsd);
  }

  /**
   * Evaluate the automated protocol and determine whether overrideConfluence should be enabled.
   * Returns whether overrideConfluence should be active, plus full telemetry status.
   */
  public evaluate(
    currentSettingsOverride: boolean,
    now: Date = new Date(),
    onLog?: (type: string, message: string) => void
  ): { overrideConfluence: boolean; status: MarketTestingStatus } {
    const nextOpen = this.getNextMarketOpen(now);
    const minsUntilOpen = nextOpen.minutesUntilOpen;
    let newPhase: MarketTestingPhase = this.currentPhase;
    let targetOverrideConfluence = currentSettingsOverride;
    let testingTimeRemainingSec = 0;

    // Phase 1: 30-Minute Market Testing Period (from 60 min before open down to 30 min before open)
    if (minsUntilOpen <= 60 && minsUntilOpen > 30) {
      newPhase = 'TESTING_PERIOD';
      targetOverrideConfluence = false; // Override Confluence NOT engaged
      testingTimeRemainingSec = Math.max(0, Math.round((minsUntilOpen - 30) * 60));

      // Reset cycle metrics at the start of a fresh testing window
      if (this.lastPhase !== 'TESTING_PERIOD') {
        this.cycleEarnedProfitInWindow = 0;
        this.totalWinsInWindow = 0;
        this.totalLossesInWindow = 0;
        this.winCountInWindow = 0;
        this.lossCountInWindow = 0;
        this.hasReachedTargetInWindow = false;
      }
    } 
    // Phase 2 or 3: Inside 30 minutes before open or while override milestone is in progress
    else if (minsUntilOpen <= 30 || (this.currentPhase === 'OVERRIDE_ACTIVE' && !this.hasReachedTargetInWindow)) {
      if (this.hasReachedTargetInWindow || this.cycleEarnedProfitInWindow >= this.profitTargetUsd) {
        // Phase 3: $100 net target reached! Deactivate Override Confluence to protect profits
        newPhase = 'GOAL_REACHED_CONSERVATIVE';
        targetOverrideConfluence = false;
        this.hasReachedTargetInWindow = true;
      } else {
        // Phase 2: Override Confluence active until $100 net profit is reached (tracking both wins and losses)
        newPhase = 'OVERRIDE_ACTIVE';
        targetOverrideConfluence = true;
      }
    } 
    // Outside the pre-market window: Normal trading
    else {
      if (this.hasReachedTargetInWindow || this.cycleEarnedProfitInWindow >= this.profitTargetUsd) {
        newPhase = 'GOAL_REACHED_CONSERVATIVE';
        targetOverrideConfluence = false;
      } else {
        newPhase = 'NORMAL_CONSERVATIVE';
      }
    }

    // Handle phase transitions and logging
    if (newPhase !== this.currentPhase) {
      const prev = this.currentPhase;
      this.lastPhase = prev;
      this.currentPhase = newPhase;
      this.lastStateChangeTime = Date.now();

      if (onLog) {
        if (newPhase === 'TESTING_PERIOD') {
          onLog('ANALYZE', `[MARKET TESTING PERIOD INITIATED] 30-minute market gauge window active (T-60m to T-30m before ${nextOpen.name} at ${nextOpen.timeStr}). Override Confluence is DISENGAGED (false) to evaluate organic market liquidity and spread dynamics.`);
        } else if (newPhase === 'OVERRIDE_ACTIVE') {
          onLog('PROFIT', `[OVERRIDE CONFLUENCE ACTIVATED] 30-minute testing period completed! Override Confluence toggle is now ENGAGED (true) leading into ${nextOpen.name}. Trading with full win/loss accounting until $100 net profit target is reached (Current Net: $${this.cycleEarnedProfitInWindow.toFixed(2)} | Wins: +$${this.totalWinsInWindow.toFixed(2)}, Losses: -$${this.totalLossesInWindow.toFixed(2)}).`);
        } else if (newPhase === 'GOAL_REACHED_CONSERVATIVE') {
          onLog('PROFIT', `[PROFIT TARGET REACHED - CONSERVATIVE MODE] $100.00 net profit milestone achieved ($${this.cycleEarnedProfitInWindow.toFixed(2)} net | +$${this.totalWinsInWindow.toFixed(2)} wins, -$${this.totalLossesInWindow.toFixed(2)} losses across ${this.winCountInWindow + this.lossCountInWindow} trades)! Override Confluence toggle is now DEACTIVATED (false) to trade conservatively and safeguard profits.`);
        } else if (newPhase === 'NORMAL_CONSERVATIVE') {
          onLog('INFO', `[SESSION SCHEDULE] Transitioned to Normal Conservative phase. Next 30m Market Testing Period starts 60m before ${nextOpen.name} (${nextOpen.timeStr}).`);
        }
      }
    }

    const pnlSign = this.cycleEarnedProfitInWindow >= 0 ? '+' : '';
    const statsDetail = `Net: ${pnlSign}$${this.cycleEarnedProfitInWindow.toFixed(2)} (+$${this.totalWinsInWindow.toFixed(2)} [${this.winCountInWindow}W] / -$${this.totalLossesInWindow.toFixed(2)} [${this.lossCountInWindow}L])`;

    let statusMessage = '';
    if (this.currentPhase === 'TESTING_PERIOD') {
      const mins = Math.floor(testingTimeRemainingSec / 60);
      const secs = testingTimeRemainingSec % 60;
      statusMessage = `Market Testing Active (${mins}m ${secs}s left) — Confluence Override DISENGAGED before ${nextOpen.name} | ${statsDetail}`;
    } else if (this.currentPhase === 'OVERRIDE_ACTIVE') {
      statusMessage = `Confluence Override ACTIVE — Tracking wins and losses toward $100 net target | ${statsDetail} / $100.00`;
    } else if (this.currentPhase === 'GOAL_REACHED_CONSERVATIVE') {
      statusMessage = `$100 Net Milestone Reached | ${statsDetail} — Confluence Override DEACTIVATED (Conservative Mode Active to protect profits)`;
    } else {
      const minsToTesting = Math.max(0, Math.round(minsUntilOpen - 60));
      const hours = Math.floor(minsToTesting / 60);
      const mins = minsToTesting % 60;
      statusMessage = `Normal Trading — Next 30m testing period starts in ${hours > 0 ? `${hours}h ` : ''}${mins}m before ${nextOpen.name} | ${statsDetail}`;
    }

    const profitProgressPct = Math.min(100, Math.max(0, (this.cycleEarnedProfitInWindow / this.profitTargetUsd) * 100));

    const status: MarketTestingStatus = {
      phase: this.currentPhase,
      isTestingPeriod: this.currentPhase === 'TESTING_PERIOD',
      isOverrideActive: this.currentPhase === 'OVERRIDE_ACTIVE',
      isConservativeProtection: this.currentPhase === 'GOAL_REACHED_CONSERVATIVE',
      overrideConfluenceEngaged: targetOverrideConfluence,
      nextSessionName: nextOpen.name,
      nextSessionTimeStr: nextOpen.timeStr,
      nextSessionOpenUtcMinute: nextOpen.utcMinutes,
      minutesUntilNextOpen: Math.round(minsUntilOpen),
      testingTimeRemainingSec,
      cycleEarnedProfitInWindow: this.cycleEarnedProfitInWindow,
      totalWinsInWindow: this.totalWinsInWindow,
      totalLossesInWindow: this.totalLossesInWindow,
      winCountInWindow: this.winCountInWindow,
      lossCountInWindow: this.lossCountInWindow,
      profitTargetUsd: this.profitTargetUsd,
      profitProgressPct,
      statusMessage,
      lastStateChangeTime: this.lastStateChangeTime
    };

    return {
      overrideConfluence: targetOverrideConfluence,
      status
    };
  }

  /**
   * Reset the profit window metrics (e.g., at Midnight EST or 9:00 AM EST resets).
   */
  public resetWindowProfit(): void {
    this.cycleEarnedProfitInWindow = 0;
    this.totalWinsInWindow = 0;
    this.totalLossesInWindow = 0;
    this.winCountInWindow = 0;
    this.lossCountInWindow = 0;
    this.hasReachedTargetInWindow = false;
    if (this.currentPhase === 'GOAL_REACHED_CONSERVATIVE') {
      this.currentPhase = 'NORMAL_CONSERVATIVE';
    }
    this.lastStateChangeTime = Date.now();
  }

  public getStatus(): MarketTestingStatus {
    const nextOpen = this.getNextMarketOpen();
    const minsUntilOpen = nextOpen.minutesUntilOpen;
    const testingTimeRemainingSec = this.currentPhase === 'TESTING_PERIOD' ? Math.max(0, Math.round((minsUntilOpen - 30) * 60)) : 0;
    const profitProgressPct = Math.min(100, Math.max(0, (this.cycleEarnedProfitInWindow / this.profitTargetUsd) * 100));
    const pnlSign = this.cycleEarnedProfitInWindow >= 0 ? '+' : '';
    const statsDetail = `Net: ${pnlSign}$${this.cycleEarnedProfitInWindow.toFixed(2)} (+$${this.totalWinsInWindow.toFixed(2)} [${this.winCountInWindow}W] / -$${this.totalLossesInWindow.toFixed(2)} [${this.lossCountInWindow}L])`;

    let statusMessage = '';
    if (this.currentPhase === 'TESTING_PERIOD') {
      const mins = Math.floor(testingTimeRemainingSec / 60);
      const secs = testingTimeRemainingSec % 60;
      statusMessage = `Market Testing Active (${mins}m ${secs}s left) — Confluence Override DISENGAGED before ${nextOpen.name} | ${statsDetail}`;
    } else if (this.currentPhase === 'OVERRIDE_ACTIVE') {
      statusMessage = `Confluence Override ACTIVE — Tracking wins and losses toward $100 net target | ${statsDetail} / $100.00`;
    } else if (this.currentPhase === 'GOAL_REACHED_CONSERVATIVE') {
      statusMessage = `$100 Net Milestone Reached | ${statsDetail} — Confluence Override DEACTIVATED (Conservative Mode)`;
    } else {
      const minsToTesting = Math.max(0, Math.round(minsUntilOpen - 60));
      const hours = Math.floor(minsToTesting / 60);
      const mins = minsToTesting % 60;
      statusMessage = `Normal Trading — Next 30m testing period starts in ${hours > 0 ? `${hours}h ` : ''}${mins}m before ${nextOpen.name} | ${statsDetail}`;
    }

    return {
      phase: this.currentPhase,
      isTestingPeriod: this.currentPhase === 'TESTING_PERIOD',
      isOverrideActive: this.currentPhase === 'OVERRIDE_ACTIVE',
      isConservativeProtection: this.currentPhase === 'GOAL_REACHED_CONSERVATIVE',
      overrideConfluenceEngaged: this.currentPhase === 'OVERRIDE_ACTIVE',
      nextSessionName: nextOpen.name,
      nextSessionTimeStr: nextOpen.timeStr,
      nextSessionOpenUtcMinute: nextOpen.utcMinutes,
      minutesUntilNextOpen: Math.round(minsUntilOpen),
      testingTimeRemainingSec,
      cycleEarnedProfitInWindow: this.cycleEarnedProfitInWindow,
      totalWinsInWindow: this.totalWinsInWindow,
      totalLossesInWindow: this.totalLossesInWindow,
      winCountInWindow: this.winCountInWindow,
      lossCountInWindow: this.lossCountInWindow,
      profitTargetUsd: this.profitTargetUsd,
      profitProgressPct,
      statusMessage,
      lastStateChangeTime: this.lastStateChangeTime
    };
  }
}

export const marketTestingEngine = new MarketTestingProtocolEngine();

import fs from 'fs';
import path from 'path';

export interface GoalWindowStatus {
  target: number;
  current_profit: number;
  previous_profit: number;
  progress_pct: number;
  goal_reached: boolean;
  session_name: string;
  window_id: string;
  next_reset_time: string;
  time_remaining: string;
  schedule: string;
  goal_achieved_timestamp?: number | null;
  paper_auto_reset_seconds_remaining?: number | null;
  training_on_the_job?: {
    enabled: boolean;
    untouched_vault_balance: number;
    untouched_vault_target: number;
    is_untouched_vault_full: boolean;
    temporary_vault_balance: number;
    is_temporary_vault_active: boolean;
    temporary_vault_seconds_remaining: number | null;
    current_goal_target: number;
    total_compounded_to_working_capital: number;
    completed_cycles: number;
  };
  history?: Array<{
    windowId: string;
    closedAt: string;
    profitUsd: number;
    targetReached: boolean;
  }>;
}

export interface GoalResetState {
  currentProfitUsd: number;
  previousProfitUsd: number;
  windowStartEquity: number;
  lastWindowId: string;
  hasLoggedGoalAchieved: boolean;
  goalAchievedTimestamp?: number | null;
  profitTargetUsd?: number;
  trainingOnTheJob?: boolean;
  untouchedVaultBalance?: number;
  temporaryVaultBalance?: number;
  isTemporaryVaultActive?: boolean;
  totalCompoundedToWorkingCapital?: number;
  trainingCyclesCompleted?: number;
  history: Array<{
    windowId: string;
    closedAt: string;
    profitUsd: number;
    targetReached: boolean;
  }>;
}

export class GoalResetScheduler {
  private profitTargetUsd: number = 100.0;
  private currentProfitUsd: number = 0;
  private previousProfitUsd: number = 0;
  private windowStartEquity: number = 0;
  private lastWindowId: string = '';
  private hasLoggedGoalAchieved: boolean = false;
  private goalAchievedTimestamp: number | null = null;
  
  // Training on the Job State
  private trainingOnTheJob: boolean = false;
  private untouchedVaultBalance: number = 0;
  private readonly untouchedVaultTarget: number = 200.0;
  private temporaryVaultBalance: number = 0;
  private isTemporaryVaultActive: boolean = false;
  private totalCompoundedToWorkingCapital: number = 0;
  private trainingCyclesCompleted: number = 0;

  private history: Array<{
    windowId: string;
    closedAt: string;
    profitUsd: number;
    targetReached: boolean;
  }> = [];

  private filePath: string;

  constructor(filePath: string = 'goal_reset_state.json') {
    this.filePath = path.join(process.cwd(), filePath);
    this.loadFromFile();
  }

  public updateCapitalScaling(workingBalance: number): void {
    if (this.trainingOnTheJob && this.untouchedVaultBalance >= this.untouchedVaultTarget) {
      // Scale goal target with capital at hand (e.g., 50% of working balance or minimum $100)
      const scaledTarget = Math.max(100, Math.round(workingBalance * 0.5));
      if (scaledTarget !== this.profitTargetUsd && !this.isTemporaryVaultActive) {
        this.profitTargetUsd = scaledTarget;
        this.saveToFile();
      }
    }
  }

  public getProfitTarget(): number {
    return this.profitTargetUsd;
  }

  public setProfitTarget(target: number): void {
    if (typeof target === 'number' && target > 0) {
      this.profitTargetUsd = target;
      this.saveToFile();
    }
  }

  public setTrainingOnTheJob(enabled: boolean): void {
    this.trainingOnTheJob = !!enabled;
    this.saveToFile();
  }

  public isTrainingOnTheJob(): boolean {
    return this.trainingOnTheJob;
  }

  public getUntouchedVaultBalance(): number {
    return this.untouchedVaultBalance;
  }

  public getTemporaryVaultBalance(): number {
    return this.temporaryVaultBalance;
  }

  private getEstParts(date: Date = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(date);
    const get = (t: string) => {
      const match = parts.find(p => p.type === t);
      return match ? parseInt(match.value, 10) : 0;
    };
    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      hour: get('hour') % 24,
      minute: get('minute'),
      second: get('second')
    };
  }

  public getWindowInfo(now: Date = new Date()) {
    const est = this.getEstParts(now);
    const currentMins = est.hour * 60 + est.minute;

    // Resets:
    // 1. Midnight EST (00:00 EST / 0 mins)
    // 2. 9:00 AM EST (09:00 EST / 540 mins)
    let sessionName = '';
    let windowId = '';
    let nextResetStr = '';
    let minutesUntilReset = 0;

    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${est.year}-${pad(est.month)}-${pad(est.day)}`;

    if (currentMins < 540) {
      // Midnight EST (00:00) to 9:00 AM EST (540 mins)
      sessionName = 'Overnight / Pre-Market Session';
      windowId = `${dateStr}_00:00`;
      nextResetStr = '9:00 AM EST';
      minutesUntilReset = 540 - currentMins;
    } else {
      // 9:00 AM EST (540 mins) to Midnight EST (1440 mins)
      sessionName = 'Regular / Evening Session';
      windowId = `${dateStr}_09:00`;
      nextResetStr = '12:00 AM EST (Midnight)';
      minutesUntilReset = 1440 - currentMins;
    }

    const hrs = Math.floor(minutesUntilReset / 60);
    const mins = minutesUntilReset % 60;
    const timeRemainingStr = (hrs > 0 ? `${hrs}h ` : '') + `${mins}m`;

    return {
      est,
      sessionName,
      windowId,
      nextResetStr,
      minutesUntilReset,
      timeRemainingStr
    };
  }

  public checkTransition(
    currentTotalEquity: number,
    now: Date = new Date(),
    onReset?: (event: {
      prevWindowId: string;
      prevProfit: number;
      newWindowId: string;
      sessionName: string;
      nextResetStr: string;
      currentTotalEquity: number;
    }) => void
  ): boolean {
    const info = this.getWindowInfo(now);

    if (!this.lastWindowId) {
      this.lastWindowId = info.windowId;
      this.windowStartEquity = currentTotalEquity;
      this.saveToFile();
      return false;
    }

    if (this.lastWindowId !== info.windowId) {
      const prevProfit = this.currentProfitUsd;
      const prevWindowId = this.lastWindowId;

      this.previousProfitUsd = prevProfit;
      this.history.unshift({
        windowId: prevWindowId,
        closedAt: now.toISOString(),
        profitUsd: parseFloat(prevProfit.toFixed(2)),
        targetReached: prevProfit >= this.profitTargetUsd
      });
      if (this.history.length > 30) this.history.pop();

      // Reset for fresh session window
      this.currentProfitUsd = 0;
      this.windowStartEquity = currentTotalEquity;
      this.lastWindowId = info.windowId;
      this.hasLoggedGoalAchieved = false;
      this.goalAchievedTimestamp = null;

      this.saveToFile();

      if (onReset) {
        onReset({
          prevWindowId,
          prevProfit,
          newWindowId: info.windowId,
          sessionName: info.sessionName,
          nextResetStr: info.nextResetStr,
          currentTotalEquity
        });
      }
      return true;
    }

    return false;
  }

  /**
   * Checks if 5 minutes have passed since the goal was earned.
   * If Training on the Job is active:
   *   - Injects the temporary vault balance (goal amount + 5min profits) into working capital.
   *   - Resets goal target cycle without wiping 24h P/L or trade history.
   * If standard Paper Mode:
   *   - Executes standard reset.
   */
  public checkPaperGoalCooldown(
    isPaperTrading: boolean,
    currentTotalEquity: number,
    now: Date = new Date(),
    onReset?: (event: {
      profitSecured: number;
      target: number;
      elapsedMinutes: number;
      newWindowId: string;
      sessionName: string;
      nextResetStr: string;
      currentTotalEquity: number;
      isTrainingOnTheJob?: boolean;
      temporaryVaultAmount?: number;
      untouchedVaultBalance?: number;
    }) => void
  ): boolean {
    if (!isPaperTrading && !this.trainingOnTheJob) return false;
    if (!this.goalAchievedTimestamp) return false;

    const elapsedMs = now.getTime() - this.goalAchievedTimestamp;
    const cooldownMs = 5 * 60 * 1000; // 5 minutes

    if (elapsedMs >= cooldownMs) {
      const profitSecured = this.currentProfitUsd;
      const prevWindowId = this.lastWindowId || 'paper_window';
      const info = this.getWindowInfo(now);

      if (this.trainingOnTheJob) {
        // Training on the Job 5-Minute Compounding Transfer:
        const tempVaultAmount = this.temporaryVaultBalance > 0 ? this.temporaryVaultBalance : profitSecured;
        this.totalCompoundedToWorkingCapital += tempVaultAmount;
        this.trainingCyclesCompleted += 1;
        this.temporaryVaultBalance = 0;
        this.isTemporaryVaultActive = false;

        this.previousProfitUsd = profitSecured;
        this.history.unshift({
          windowId: `${prevWindowId}_training_cycle_${now.toISOString().slice(11, 16)}`,
          closedAt: now.toISOString(),
          profitUsd: parseFloat(profitSecured.toFixed(2)),
          targetReached: true
        });
        if (this.history.length > 30) this.history.pop();

        // Reset goal cycle tracker without wiping 24h P/L
        this.currentProfitUsd = 0;
        this.windowStartEquity = currentTotalEquity;
        this.hasLoggedGoalAchieved = false;
        this.goalAchievedTimestamp = null;

        this.saveToFile();

        if (onReset) {
          onReset({
            profitSecured,
            target: this.profitTargetUsd,
            elapsedMinutes: Math.round((elapsedMs / (60 * 1000)) * 10) / 10,
            newWindowId: info.windowId,
            sessionName: info.sessionName,
            nextResetStr: info.nextResetStr,
            currentTotalEquity,
            isTrainingOnTheJob: true,
            temporaryVaultAmount: tempVaultAmount,
            untouchedVaultBalance: this.untouchedVaultBalance
          });
        }
        return true;
      }

      // Standard Paper Mode Reset
      this.previousProfitUsd = profitSecured;
      this.history.unshift({
        windowId: `${prevWindowId}_paper_cycle_${now.toISOString().slice(11, 16)}`,
        closedAt: now.toISOString(),
        profitUsd: parseFloat(profitSecured.toFixed(2)),
        targetReached: true
      });
      if (this.history.length > 30) this.history.pop();

      // Reset goal metrics to 0 for next iteration
      this.currentProfitUsd = 0;
      this.windowStartEquity = currentTotalEquity;
      this.hasLoggedGoalAchieved = false;
      this.goalAchievedTimestamp = null;

      this.saveToFile();

      if (onReset) {
        onReset({
          profitSecured,
          target: this.profitTargetUsd,
          elapsedMinutes: Math.round((elapsedMs / (60 * 1000)) * 10) / 10,
          newWindowId: info.windowId,
          sessionName: info.sessionName,
          nextResetStr: info.nextResetStr,
          currentTotalEquity,
          isTrainingOnTheJob: false
        });
      }
      return true;
    }

    return false;
  }

  public recordTrade(
    pnlUsd: number,
    onGoalReached?: (currentProfit: number, target: number, isTrainingMode?: boolean) => void
  ): void {
    this.currentProfitUsd += pnlUsd;

    if (this.trainingOnTheJob) {
      // If temporary vault is active during the 5-minute cooldown, accumulate additional gains into the temporary vault
      if (this.isTemporaryVaultActive && pnlUsd > 0) {
        this.temporaryVaultBalance += pnlUsd;
      }

      // Check if current profit has reached the target
      if (this.currentProfitUsd >= this.profitTargetUsd && !this.isTemporaryVaultActive) {
        // Step 1: Initial $200 Untouched Vault Check
        if (this.untouchedVaultBalance < this.untouchedVaultTarget) {
          const needed = this.untouchedVaultTarget - this.untouchedVaultBalance;
          const toVault = Math.min(this.currentProfitUsd, needed);
          this.untouchedVaultBalance += toVault;
          const remainingProfit = this.currentProfitUsd - toVault;

          if (this.untouchedVaultBalance >= this.untouchedVaultTarget) {
            // Untouched vault is now complete ($200)! Any remaining profit goes into the temporary vault
            this.temporaryVaultBalance = Math.max(0, remainingProfit);
            this.isTemporaryVaultActive = true;
            this.goalAchievedTimestamp = Date.now();
          } else {
            // Untouched vault still needs more funds to hit $200. Reset profit counter to accumulate next batch
            this.currentProfitUsd = 0;
            this.hasLoggedGoalAchieved = false;
            this.goalAchievedTimestamp = null;
          }
        } else {
          // Untouched vault already fulfilled ($200). Goal reached -> place in temporary vault for 5m cooldown
          this.temporaryVaultBalance = this.currentProfitUsd;
          this.isTemporaryVaultActive = true;
          this.goalAchievedTimestamp = Date.now();
        }

        if (!this.hasLoggedGoalAchieved) {
          this.hasLoggedGoalAchieved = true;
          if (onGoalReached) {
            onGoalReached(this.currentProfitUsd, this.profitTargetUsd, true);
          }
        }
      }
    } else {
      // Standard Mode
      if (this.currentProfitUsd >= this.profitTargetUsd) {
        if (!this.goalAchievedTimestamp) {
          this.goalAchievedTimestamp = Date.now();
        }
        if (!this.hasLoggedGoalAchieved) {
          this.hasLoggedGoalAchieved = true;
          if (onGoalReached) {
            onGoalReached(this.currentProfitUsd, this.profitTargetUsd, false);
          }
        }
      }
    }

    this.saveToFile();
  }

  public resetManual(currentTotalEquity: number): void {
    const info = this.getWindowInfo();
    this.currentProfitUsd = 0;
    this.windowStartEquity = currentTotalEquity;
    this.lastWindowId = info.windowId;
    this.hasLoggedGoalAchieved = false;
    this.goalAchievedTimestamp = null;
    this.temporaryVaultBalance = 0;
    this.isTemporaryVaultActive = false;
    this.saveToFile();
  }

  public getStatus(now: Date = new Date()): GoalWindowStatus {
    const info = this.getWindowInfo(now);
    const progressPct = Math.min(100, Math.max(0, (this.currentProfitUsd / this.profitTargetUsd) * 100));

    let paperAutoResetSecondsRemaining: number | null = null;
    if (this.goalAchievedTimestamp) {
      const elapsedMs = now.getTime() - this.goalAchievedTimestamp;
      const remainingMs = Math.max(0, (5 * 60 * 1000) - elapsedMs);
      paperAutoResetSecondsRemaining = Math.ceil(remainingMs / 1000);
    }

    return {
      target: this.profitTargetUsd,
      current_profit: parseFloat(this.currentProfitUsd.toFixed(2)),
      previous_profit: parseFloat(this.previousProfitUsd.toFixed(2)),
      progress_pct: parseFloat(progressPct.toFixed(1)),
      goal_reached: this.currentProfitUsd >= this.profitTargetUsd,
      session_name: info.sessionName,
      window_id: info.windowId,
      next_reset_time: info.nextResetStr,
      time_remaining: info.timeRemainingStr,
      schedule: this.trainingOnTheJob 
        ? 'Training on the Job (5m Temporary Vault -> Working Capital)'
        : 'Midnight EST & 9:00 AM EST (or 5m post-goal in Paper Mode)',
      goal_achieved_timestamp: this.goalAchievedTimestamp,
      paper_auto_reset_seconds_remaining: paperAutoResetSecondsRemaining,
      training_on_the_job: {
        enabled: this.trainingOnTheJob,
        untouched_vault_balance: parseFloat(this.untouchedVaultBalance.toFixed(2)),
        untouched_vault_target: this.untouchedVaultTarget,
        is_untouched_vault_full: this.untouchedVaultBalance >= this.untouchedVaultTarget,
        temporary_vault_balance: parseFloat(this.temporaryVaultBalance.toFixed(2)),
        is_temporary_vault_active: this.isTemporaryVaultActive,
        temporary_vault_seconds_remaining: paperAutoResetSecondsRemaining,
        current_goal_target: this.profitTargetUsd,
        total_compounded_to_working_capital: parseFloat(this.totalCompoundedToWorkingCapital.toFixed(2)),
        completed_cycles: this.trainingCyclesCompleted
      },
      history: this.history.slice(0, 5)
    };
  }

  private loadFromFile(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const data: GoalResetState = JSON.parse(raw);
        if (typeof data.currentProfitUsd === 'number') this.currentProfitUsd = data.currentProfitUsd;
        if (typeof data.previousProfitUsd === 'number') this.previousProfitUsd = data.previousProfitUsd;
        if (typeof data.windowStartEquity === 'number') this.windowStartEquity = data.windowStartEquity;
        if (typeof data.lastWindowId === 'string') this.lastWindowId = data.lastWindowId;
        if (typeof data.hasLoggedGoalAchieved === 'boolean') this.hasLoggedGoalAchieved = data.hasLoggedGoalAchieved;
        if (typeof data.goalAchievedTimestamp === 'number' || data.goalAchievedTimestamp === null) {
          this.goalAchievedTimestamp = data.goalAchievedTimestamp;
        }
        if (typeof data.profitTargetUsd === 'number' && data.profitTargetUsd > 0) {
          this.profitTargetUsd = data.profitTargetUsd;
        }
        if (typeof data.trainingOnTheJob === 'boolean') {
          this.trainingOnTheJob = data.trainingOnTheJob;
        }
        if (typeof data.untouchedVaultBalance === 'number') {
          this.untouchedVaultBalance = data.untouchedVaultBalance;
        }
        if (typeof data.temporaryVaultBalance === 'number') {
          this.temporaryVaultBalance = data.temporaryVaultBalance;
        }
        if (typeof data.isTemporaryVaultActive === 'boolean') {
          this.isTemporaryVaultActive = data.isTemporaryVaultActive;
        }
        if (typeof data.totalCompoundedToWorkingCapital === 'number') {
          this.totalCompoundedToWorkingCapital = data.totalCompoundedToWorkingCapital;
        }
        if (typeof data.trainingCyclesCompleted === 'number') {
          this.trainingCyclesCompleted = data.trainingCyclesCompleted;
        }
        if (Array.isArray(data.history)) this.history = data.history;
      }
    } catch (err) {
      console.error('[GOAL SCHEDULER] Could not load state from disk:', err);
    }
  }

  private saveToFile(): void {
    try {
      const state: GoalResetState = {
        currentProfitUsd: this.currentProfitUsd,
        previousProfitUsd: this.previousProfitUsd,
        windowStartEquity: this.windowStartEquity,
        lastWindowId: this.lastWindowId,
        hasLoggedGoalAchieved: this.hasLoggedGoalAchieved,
        goalAchievedTimestamp: this.goalAchievedTimestamp,
        profitTargetUsd: this.profitTargetUsd,
        trainingOnTheJob: this.trainingOnTheJob,
        untouchedVaultBalance: this.untouchedVaultBalance,
        temporaryVaultBalance: this.temporaryVaultBalance,
        isTemporaryVaultActive: this.isTemporaryVaultActive,
        totalCompoundedToWorkingCapital: this.totalCompoundedToWorkingCapital,
        trainingCyclesCompleted: this.trainingCyclesCompleted,
        history: this.history
      };
      fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
      console.error('[GOAL SCHEDULER] Could not save state to disk:', err);
    }
  }
}

export const goalResetScheduler = new GoalResetScheduler();

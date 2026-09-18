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

  public recordTrade(
    pnlUsd: number,
    onGoalReached?: (currentProfit: number, target: number) => void
  ): void {
    this.currentProfitUsd += pnlUsd;

    if (this.currentProfitUsd >= this.profitTargetUsd && !this.hasLoggedGoalAchieved) {
      this.hasLoggedGoalAchieved = true;
      if (onGoalReached) {
        onGoalReached(this.currentProfitUsd, this.profitTargetUsd);
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
    this.saveToFile();
  }

  public getStatus(now: Date = new Date()): GoalWindowStatus {
    const info = this.getWindowInfo(now);
    const progressPct = Math.min(100, Math.max(0, (this.currentProfitUsd / this.profitTargetUsd) * 100));

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
      schedule: 'Midnight EST & 9:00 AM EST',
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
        history: this.history
      };
      fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
      console.error('[GOAL SCHEDULER] Could not save state to disk:', err);
    }
  }
}

export const goalResetScheduler = new GoalResetScheduler();

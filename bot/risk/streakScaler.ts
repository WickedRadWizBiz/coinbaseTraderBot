// Losing-streak sizing: shrink risk when results are worse than the model expected by more than luck
// explains, and grow it back as they return to expectation. It never reaches zero (the floor), so the
// bot keeps trading, keeps producing data, and can recover; it only bets smaller.
//
// Every settled entry is one observation of how the model's probability q for the side it bought
// compared with what happened: z = (outcome - q) / sqrt(q (1 - q)). For a calibrated model z has mean 0
// and variance 1 whatever the run of wins and losses, so ordinary bad luck (many losses on 40c bets)
// does not move the scale much, while a model that overstates its edge on the bets it takes produces
// persistently negative z. The scale follows an exponentially weighted mean of z, measured in standard
// errors of that mean under the null:
//     evidence s = ewma(z) / sqrt(alpha / (2 - alpha))
//     scale      = clamp(1 + slope * min(0, s + deadband), floor, 1)
// With deadband 1 and slope 0.2: s = -2 -> 0.8, -3 -> 0.6, -4 -> 0.4, beyond -4.75 -> the floor. The dead
// band keeps ordinary noise (|s| < 1 most of the time for a calibrated model) from trimming size.
// The same class serves other books with their own standardised results (perp trades in R multiples).

import { readJson, writeJsonAtomic } from '../util/persist';

export interface StreakParams {
  /** Half-life of the moving mean, in observations. */
  halfLife: number;
  /** Size multiplier per standard error of underperformance. */
  slope: number;
  /** Lowest multiplier (> 0: never stops trading). */
  floor: number;
  /** Observations before the scale may move. */
  minObs: number;
  /** Standard errors of underperformance tolerated as noise before size is trimmed. */
  deadband: number;
}

export const DEFAULT_STREAK: StreakParams = { halfLife: 30, slope: 0.2, floor: 0.25, minObs: 10, deadband: 1 };

interface StreakState { mean: number; n: number; lastTs: number; wins: number; losses: number; streak: number }

export class StreakScaler {
  private st: StreakState;
  private readonly alpha: number;

  constructor(private readonly p: StreakParams = DEFAULT_STREAK, private readonly file?: string) {
    this.st = (file && readJson<StreakState>(file, { quarantine: true })) || { mean: 0, n: 0, lastTs: 0, wins: 0, losses: 0, streak: 0 };
    this.alpha = 1 - Math.pow(2, -1 / Math.max(1, p.halfLife));
  }

  /** One settled binary entry: q = the model's probability for the side bought, won = it paid out. */
  observeBinary(q: number, won: boolean, ts = Date.now()): void {
    if (!(q > 0.005 && q < 0.995)) return;
    const z = ((won ? 1 : 0) - q) / Math.sqrt(q * (1 - q));
    this.observe(Math.max(-6, Math.min(6, z)), won, ts);
  }

  /** One standardised result (mean 0, sd 1 when the model is right), e.g. a perp trade's R / sd(R). */
  observe(z: number, won: boolean, ts = Date.now()): void {
    if (!Number.isFinite(z)) return;
    this.st.mean = this.st.n === 0 ? z * this.alpha : this.st.mean + this.alpha * (z - this.st.mean);
    this.st.n++;
    this.st.lastTs = ts;
    if (won) { this.st.wins++; this.st.streak = this.st.streak > 0 ? this.st.streak + 1 : 1; }
    else { this.st.losses++; this.st.streak = this.st.streak < 0 ? this.st.streak - 1 : -1; }
    if (this.file) writeJsonAtomic(this.file, this.st);
  }

  /** Underperformance vs expectation in standard errors (negative = worse than the model expected). */
  evidence(): number {
    if (this.st.n < this.p.minObs) return 0;
    return this.st.mean / Math.sqrt(this.alpha / (2 - this.alpha));
  }

  /** Size multiplier in [floor, 1]. */
  scale(): number {
    const s = this.evidence();
    return Math.max(this.p.floor, Math.min(1, 1 + this.p.slope * Math.min(0, s + this.p.deadband)));
  }

  status() {
    return { scale: +this.scale().toFixed(3), evidence: +this.evidence().toFixed(2), observations: this.st.n, wins: this.st.wins, losses: this.st.losses, streak: this.st.streak, lastTs: this.st.lastTs || null };
  }
}

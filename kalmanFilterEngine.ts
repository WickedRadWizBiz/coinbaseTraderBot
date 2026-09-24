/**
 * Dynamic Kalman Filter for Latent Implied Probability State Estimation
 * 
 * Filters microstructure noise (spoofing, flash spreads, phantom order sizes) from
 * raw Kalshi order book feeds to reconstruct the true continuous latent fair probability.
 */

export interface KalmanState {
  symbol: string;
  x: number;       // State estimate (Latent probability: 0.0 to 1.0)
  p: number;       // Estimate covariance (Uncertainty)
  q: number;       // Process noise covariance (Rate of true drift)
  r: number;       // Measurement noise covariance (Microstructure noise)
  k: number;       // Kalman Gain
  lastUpdated: number;
  smoothedMid: number;
  velocity: number;// Rate of change of latent probability (dx/dt)
  innovationZ: number; // Innovation / residual error
}

export class LatentKalmanFilterEngine {
  private states: Map<string, KalmanState> = new Map();

  // Baseline calibration
  private defaultProcessNoise = 0.0001; // Low process variance (latent belief drifts smoothly)
  private defaultMeasurementNoise = 0.0025; // Moderate microstructure observation noise

  public getOrCreateState(symbol: string, initialPrice: number = 0.50): KalmanState {
    let state = this.states.get(symbol);
    if (!state) {
      state = {
        symbol,
        x: Math.max(0.01, Math.min(0.99, initialPrice)),
        p: 0.01,
        q: this.defaultProcessNoise,
        r: this.defaultMeasurementNoise,
        k: 0.5,
        lastUpdated: Date.now(),
        smoothedMid: initialPrice,
        velocity: 0,
        innovationZ: 0
      };
      this.states.set(symbol, state);
    }
    return state;
  }

  /**
   * Filter step: Updates state with newly observed order book mid/last tick
   * @param symbol Market Ticker
   * @param rawObservation Observed price or mid-market probability (0.00 to 1.00)
   * @param orderBookSpread Current bid-ask spread (used to dynamically adjust measurement noise R)
   * @param volumeWeight Depth weighting factor (thicker books = lower measurement noise)
   */
  public update(
    symbol: string,
    rawObservation: number,
    orderBookSpread: number = 0.02,
    volumeWeight: number = 1.0
  ): KalmanState {
    const state = this.getOrCreateState(symbol, rawObservation);
    const now = Date.now();
    const dt = Math.max(0.001, (now - state.lastUpdated) / 1000); // in seconds

    // 1. Prediction Step:
    // x_prior = x + velocity * dt
    const x_prior = Math.max(0.001, Math.min(0.999, state.x + state.velocity * dt));
    // P_prior = P + Q * dt
    const p_prior = state.p + state.q * dt;

    // Dynamically adjust measurement noise R based on book thickness and spread
    // Wider spread or thinner book = higher measurement uncertainty R
    const dynamicR = Math.max(0.0005, (this.defaultMeasurementNoise * (1 + orderBookSpread * 10)) / Math.max(0.1, volumeWeight));

    // 2. Correction Step:
    // Innovation residual: y = z - x_prior
    const y = rawObservation - x_prior;
    state.innovationZ = y;

    // Kalman Gain: K = P_prior / (P_prior + R)
    const K = p_prior / (p_prior + dynamicR);
    state.k = K;

    // Updated State Estimate: x = x_prior + K * y
    const x_updated = Math.max(0.001, Math.min(0.999, x_prior + K * y));
    state.velocity = (x_updated - state.x) / dt;
    state.x = x_updated;
    state.smoothedMid = Math.round(x_updated * 100) / 100;

    // Updated Covariance: P = (1 - K) * P_prior
    state.p = (1 - K) * p_prior;
    state.lastUpdated = now;

    return state;
  }

  /**
   * Check if a sudden quote move is statistically significant or phantom noise
   * @param symbol Market Ticker
   * @param observedPrice New candidate quote
   * @param zThreshold Number of standard deviations (e.g., 2.5)
   */
  public isStatisticallySignificantMove(symbol: string, observedPrice: number, zThreshold = 2.0): boolean {
    const state = this.states.get(symbol);
    if (!state) return true;
    const stdDev = Math.sqrt(state.p + state.r);
    const residual = Math.abs(observedPrice - state.x);
    return residual >= zThreshold * stdDev;
  }

  public getLatentEstimate(symbol: string): number {
    const state = this.states.get(symbol);
    return state ? state.x : 0.50;
  }

  public getAllStates(): Record<string, KalmanState> {
    const obj: Record<string, KalmanState> = {};
    this.states.forEach((val, key) => {
      obj[key] = { ...val };
    });
    return obj;
  }
}

export const kalmanFilterEngine = new LatentKalmanFilterEngine();

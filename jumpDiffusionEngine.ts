/**
 * Merton Jump-Diffusion Stochastic Option Pricing Kernel for Binary Prediction Markets
 * Computes real-time theoretical fair value p_t of a binary contract (pays $1 if S_T > K, else $0)
 * by integrating continuous Brownian diffusion with discontinuous Poisson-driven price jumps.
 *
 * Formula:
 * p_t = \sum_{n=0}^{\infty} \frac{e^{-\lambda \tau} (\lambda \tau)^n}{n!} \Phi(d_{2,n})
 */

export interface JumpDiffusionParams {
  spotPrice: number;        // S_0 (Current Spot Price from Coinbase)
  strikePrice: number;      // K (Kalshi Binary Strike Price)
  timeToExpiryYears: number;// \tau (Time to expiration in years)
  riskFreeRate: number;     // r (Continuous risk-free interest rate, e.g., 0.04)
  diffusionVol: number;     // \sigma (Continuous diffusion volatility, e.g., 0.45)
  jumpIntensity: number;    // \lambda (Poisson arrival rate of jumps per year, e.g., 25)
  meanJumpSize: number;     // \mu_J (Mean percentage jump size, e.g., 0.0)
  jumpVol: number;          // \sigma_J (Jump standard deviation, e.g., 0.025)
  maxJumpIterations?: number;// Max Poisson expansion terms (default 15)
}

export interface BinaryPricingResult {
  fairValueProbability: number; // p_t: Fair value binary probability (0.00 to 1.00)
  fairValueCents: number;       // In cents (0 to 100)
  bsContinuousProbability: number; // Pure Black-Scholes baseline probability without jumps
  jumpAlphaDelta: number;       // Difference p_t - bsContinuous (jump premium)
  spotJumpDetected: boolean;
  delta: number;                // Instantaneous sensitivity to spot move
  gamma: number;
  theta: number;                // Time decay per hour
}

// Standard Normal Cumulative Distribution Function \Phi(x)
export function standardNormalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -0.145315202;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;

  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return 0.5 * (1.0 + sign * y);
}

// Standard Normal Probability Density Function \phi(x)
export function standardNormalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export class JumpDiffusionPricingEngine {
  private defaultJumpIntensity = 40.0; // 40 jump events per year baseline
  private defaultJumpVol = 0.035;      // 3.5% jump std dev
  private maxIterations = 20;

  /**
   * Calculates the exact theoretical binary probability under Merton Jump-Diffusion
   */
  public calculateBinaryFairValue(params: JumpDiffusionParams): BinaryPricingResult {
    const {
      spotPrice: S,
      strikePrice: K,
      timeToExpiryYears: tau,
      riskFreeRate: r = 0.04,
      diffusionVol: sigma = 0.50,
      jumpIntensity: lambda = this.defaultJumpIntensity,
      meanJumpSize: muJ = 0.0,
      jumpVol: sigmaJ = this.defaultJumpVol,
      maxJumpIterations = this.maxIterations
    } = params;

    // Handle edge case of expiration
    if (tau <= 0.000001) {
      const isITM = S >= K ? 1.0 : 0.0;
      return {
        fairValueProbability: isITM,
        fairValueCents: Math.round(isITM * 100),
        bsContinuousProbability: isITM,
        jumpAlphaDelta: 0,
        spotJumpDetected: false,
        delta: 0,
        gamma: 0,
        theta: 0
      };
    }

    // Expected jump multiplier k = exp(muJ + 0.5 * sigmaJ^2) - 1
    const k = Math.exp(muJ + 0.5 * sigmaJ * sigmaJ) - 1;
    const lambdaPrime = lambda * (1 + k);

    // 1. Pure Continuous Black-Scholes Binary Probability \Phi(d_2)
    const d2_bs = (Math.log(S / K) + (r - 0.5 * sigma * sigma) * tau) / (sigma * Math.sqrt(tau));
    const bsProbability = Math.max(0.0001, Math.min(0.9999, standardNormalCDF(d2_bs)));

    // 2. Merton Jump-Diffusion Expansion
    let mertonProbability = 0.0;
    let poissonFactor = Math.exp(-lambdaPrime * tau);
    let factorial = 1;

    for (let n = 0; n < maxJumpIterations; n++) {
      if (n > 0) factorial *= n;
      const weight = (poissonFactor * Math.pow(lambdaPrime * tau, n)) / factorial;

      const sigma_n = Math.sqrt(sigma * sigma + (n * sigmaJ * sigmaJ) / tau);
      const r_n = r - lambda * k + (n * Math.log(1 + k)) / tau;

      const d2_n = (Math.log(S / K) + (r_n - 0.5 * sigma_n * sigma_n) * tau) / (sigma_n * Math.sqrt(tau));
      const phi_d2_n = standardNormalCDF(d2_n);

      mertonProbability += weight * phi_d2_n;
    }

    const fairValue = Math.max(0.0001, Math.min(0.9999, mertonProbability));
    const jumpDelta = fairValue - bsProbability;
    const spotJumpDetected = Math.abs(jumpDelta) > 0.02;

    // Greek estimates
    const totalVol = Math.sqrt(sigma * sigma + lambda * sigmaJ * sigmaJ);
    const d2_eff = (Math.log(S / K) + (r - 0.5 * totalVol * totalVol) * tau) / (totalVol * Math.sqrt(tau));
    const delta = (standardNormalPDF(d2_eff) / (S * totalVol * Math.sqrt(tau))) * Math.exp(-r * tau);
    const gamma = (delta / (S * totalVol * Math.sqrt(tau))) * (-d2_eff / totalVol - 1);
    const theta = -(fairValue * 0.05) / 24; // Decay per hour approximation

    return {
      fairValueProbability: fairValue,
      fairValueCents: Math.round(fairValue * 100),
      bsContinuousProbability: bsProbability,
      jumpAlphaDelta: jumpDelta,
      spotJumpDetected,
      delta,
      gamma,
      theta
    };
  }

  /**
   * Helper: Convert remaining minutes into years fraction
   */
  public minutesToYears(minutes: number): number {
    return Math.max(0.000005, minutes / (365.25 * 24 * 60));
  }
}

export const jumpDiffusionEngine = new JumpDiffusionPricingEngine();

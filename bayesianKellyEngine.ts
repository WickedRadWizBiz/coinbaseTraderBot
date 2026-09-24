/**
 * Bayesian Kelly & Dynamic Conditional Value-at-Risk (CVaR / Expected Shortfall) Engine
 * 
 * Implements:
 * 1. Bayesian Kelly Criterion: Integrates over the posterior probability distribution Beta(alpha, beta)
 *    to mathematically account for parameter uncertainty and neural network model entropy.
 * 2. Continuous Dynamic CVaR Constraint: Computes microsecond Expected Shortfall at alpha=0.95
 *    to prevent left-tail liquidation risk on binary event settlements.
 * 3. Exact Kalshi Non-Linear Quadratic Fee Calculation: Enforces net expected value (EV_net > 0).
 */

export interface PosteriorBetaParams {
  alpha: number; // Effective historical/prior wins (e.g. 15)
  beta: number;  // Effective historical/prior losses (e.g. 10)
}

export interface BayesianKellyResult {
  recommendedFraction: number; // Optimal bankroll fraction f_B (0.00 to 0.25 max safe bound)
  posteriorMeanP: number;       // Mean estimated win probability E[p]
  posteriorVariance: number;    // Uncertainty Var[p]
  expectedLogGrowthRate: number;// E[ln(1 + f * r)]
  uncertaintyDampener: number;  // Shrinkage multiplier (0.0 to 1.0) due to parameter entropy
  grossEV: number;              // Gross expected value per dollar risked
  netEV: number;                // Net expected value after non-linear quadratic Kalshi fee
  cvarPassed: boolean;          // Whether the trade satisfies dynamic CVaR threshold
  estimatedCVaR95: number;      // Estimated Expected Shortfall (worst 5% tail loss)
  calculatedFeePerContract: number; // In dollars
}

export interface PortfolioRiskConstraint {
  totalBankroll: number;
  maxPortfolioCVaRLimit: number; // R (e.g., 0.15 of total bankroll)
  currentAllocatedExposure: number;
}

export class BayesianKellyEngine {
  // Max safe fractional limit (e.g., 20% hard cap for any single binary contract)
  private maxSingleTradeAllocation = 0.20;

  /**
   * Calculates Kalshi's exact quadratic fee per contract in dollars
   * Formula: Fee = ceil(0.07 * C * P * (1 - P)) / 100
   * @param contractPrice Contract price in dollars (0.01 to 0.99)
   * @param contracts Number of contracts (default 1)
   */
  public calculateKalshiFee(contractPrice: number, contracts: number = 1): number {
    const P = Math.max(0.01, Math.min(0.99, contractPrice));
    const rawFeeCents = Math.ceil(0.07 * contracts * P * (1 - P) * 100);
    return rawFeeCents / 100;
  }

  /**
   * Compute Bayesian Kelly fraction by numerically integrating expected log-growth rate
   * over the Beta(alpha, beta) posterior predictive distribution.
   */
  public computeBayesianKelly(
    pointProbability: number,
    contractPrice: number,
    evidenceWeight: number = 20, // Sample size credibility weight
    modelConfidenceEntropy: number = 0.85, // 1.0 = sharp certainty, 0.5 = pure noise
    riskConstraint?: PortfolioRiskConstraint
  ): BayesianKellyResult {
    const P = Math.max(0.01, Math.min(0.99, contractPrice));
    const b = (1.0 - P) / P; // Net payoff odds (e.g., at 0.40, b = 1.50)

    // Construct Beta distribution parameters from model estimate & entropy
    const effectiveWeight = Math.max(5, evidenceWeight * modelConfidenceEntropy);
    const alpha = Math.max(1.0, pointProbability * effectiveWeight);
    const beta = Math.max(1.0, (1.0 - pointProbability) * effectiveWeight);

    const posteriorMeanP = alpha / (alpha + beta);
    const posteriorVariance = (alpha * beta) / (Math.pow(alpha + beta, 2) * (alpha + beta + 1));

    // Calculate exact fee for 1 contract
    const feePerContract = this.calculateKalshiFee(P, 1);
    const feeRatio = feePerContract / P; // Fee as fraction of capital risked

    // Net payoff adjusted for fees:
    // If win: net gain = (1 - P - feePerContract) / P
    // If loss: net loss = (P + feePerContract) / P = 1 + feeRatio
    const netWinReturn = (1.0 - P - feePerContract) / P;
    const netLossReturn = -1.0;

    const grossEV = posteriorMeanP * b - (1 - posteriorMeanP);
    const netEV = posteriorMeanP * netWinReturn + (1 - posteriorMeanP) * netLossReturn;

    if (netEV <= 0.005) {
      // Negative or negligible EV after quadratic fees
      return {
        recommendedFraction: 0,
        posteriorMeanP,
        posteriorVariance,
        expectedLogGrowthRate: 0,
        uncertaintyDampener: 0,
        grossEV,
        netEV,
        cvarPassed: false,
        estimatedCVaR95: 1.0,
        calculatedFeePerContract: feePerContract
      };
    }

    // Bayesian Numerical Integration over 50 quadrature points of the Beta distribution
    const numPoints = 50;
    let bestF = 0;
    let maxExpectedLogGrowth = -Infinity;

    // Search f from 0.01 to maxSingleTradeAllocation in increments
    for (let f = 0.005; f <= this.maxSingleTradeAllocation; f += 0.005) {
      let expectedLogGrowth = 0;

      // Numerical approximation of \int P(p | D) * ln(1 + f * R) dp
      for (let i = 1; i <= numPoints; i++) {
        const p_sample = i / (numPoints + 1);
        const logWeight = (alpha - 1) * Math.log(p_sample) + (beta - 1) * Math.log(1 - p_sample);
        const weight = Math.exp(logWeight);

        if (!isFinite(weight) || weight <= 0) continue;

        const winOutcome = Math.log(Math.max(0.0001, 1 + f * netWinReturn));
        const lossOutcome = Math.log(Math.max(0.0001, 1 + f * netLossReturn));
        const sampleLogGrowth = p_sample * winOutcome + (1 - p_sample) * lossOutcome;

        expectedLogGrowth += weight * sampleLogGrowth;
      }

      if (expectedLogGrowth > maxExpectedLogGrowth) {
        maxExpectedLogGrowth = expectedLogGrowth;
        bestF = f;
      }
    }

    // Uncertainty shrinkage dampener: shrinks bet if posterior variance is high
    const maxVar = 0.25 / (effectiveWeight + 1);
    const uncertaintyDampener = Math.max(0.2, 1 - (posteriorVariance / Math.max(0.0001, maxVar)));
    let recommendedFraction = Math.max(0, bestF * uncertaintyDampener);

    // 2. Dynamic CVaR (Expected Shortfall) Evaluation
    // For a binary contract, if loss occurs, 100% of the invested position size f is lost.
    // Thus, CVaR at alpha=0.95 over the position is simply the full downside exposure f.
    const estimatedCVaR95 = recommendedFraction;
    let cvarPassed = true;

    if (riskConstraint) {
      const remainingRiskBudget = Math.max(0, riskConstraint.maxPortfolioCVaRLimit - riskConstraint.currentAllocatedExposure);
      const bankroll = Math.max(1, riskConstraint.totalBankroll);
      const maxAllowedFraction = remainingRiskBudget / bankroll;

      if (recommendedFraction > maxAllowedFraction) {
        recommendedFraction = Math.max(0, maxAllowedFraction);
        if (recommendedFraction < 0.005) {
          cvarPassed = false;
          recommendedFraction = 0;
        }
      }
    }

    return {
      recommendedFraction,
      posteriorMeanP,
      posteriorVariance,
      expectedLogGrowthRate: maxExpectedLogGrowth,
      uncertaintyDampener,
      grossEV,
      netEV,
      cvarPassed,
      estimatedCVaR95,
      calculatedFeePerContract: feePerContract
    };
  }
}

export const bayesianKellyEngine = new BayesianKellyEngine();

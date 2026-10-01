// SNN hyperparameters, stage flags (S0..S6 of the staging plan) and deferred-mechanism flags.
// Every knob is here so the ablation grid (<= 20 configs per mechanism) is explicit and so the
// checkpoint version hash covers exactly what defines the network.

import crypto from 'crypto';
import type { TripletParams } from './formulas';

export type Stage = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6';
export const STAGES: Stage[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'];

export interface SnnFlags {
  /** S0 "plain online logistic regression on raw features": readout on L0 rates, no hidden levels. */
  rawReadout: boolean;
  /** S1: per-contract tags (else one decaying trace with tau = traceTauSec) and strike monotonicity. */
  tags: boolean;
  monotone: boolean;
  /** S2: Poirazi dendritic L1 (else point-LIF L1 with the same synapses summed linearly). */
  dendrites: boolean;
  /** S3: multi-timescale synapse classes (AMPA/NMDA/GABA) + ALIF adaptation (else one tau, plain LIF). */
  synClasses: boolean;
  alif: boolean;
  /** S4: predictive-coding pathway, surprise S_t, surprise -> c. */
  pc: boolean;
  surpriseToC: boolean;
  /** S5: cross-column lateral inhibition and the salience ranking (shadow only for asset choice). */
  lateral: boolean;
  /** S6: online plasticity (minimal triplet/BCM x NMDA gate x governor) and online PC weight learning. */
  plasticity: boolean;
  pcLearn: boolean;
  /** Cheap proxies the deferred mechanisms must beat (readout extra features): realized-vol regime
   *  ratio (vs Wilson-Cowan), BTC-ETH return correlation (vs gap junctions), delta-spike burst
   *  counter (vs Izhikevich CH). The 2-branch XOR proxy for dCaAP is the plain Poirazi neuron. */
  proxies: boolean;
  /** Deferred mechanisms, off until each beats its cheap proxy in an ablation. */
  wilsonCowan: boolean;
  gapJunctions: boolean;
  izhikevichCH: boolean;
  dcaap: boolean;
}

export interface SnnParams {
  seed: number;
  flags: SnnFlags;
  /** Sizes per column (PDF section 4.2). L0 width is set by the column kind (bot/snn/inputs.ts);
   *  nL0 is kept only for model-file compatibility. */
  nL0: number; nL1: number; branches: number; synPerBranch: number; nE: number; nI: number;
  maxColumns: number;
  /** Live tennis matches with their own column (created and removed with the match). */
  maxTennisColumns: number;
  /** Direction heads: learning rate (dense labels, one per column per minute) and sampling period. */
  dirEta: number; dirCap: number; dirEverySec: number;
  /** L0 encoders. */
  deltaBps: number[]; midDelta: number; tauL0: number; popGain: number; deltaGain: number; thetaL0: number;
  /** L1 (Poirazi). */
  branchTaus: number[]; tauL1: number; thetaL1: number; l1Gain: number; nmdaWeight: number; mg: number; branchTheta: number; wInitL1: number;
  feedbackGain: number;
  /** L2/3. */
  tauE: number; tauA: number; betaA: number; thetaE: number; tauI: number; thetaI: number;
  pFF: number; wFF: number; pRec: number; wEE: number; wEI: number; wIE: number; wII: number; wLat: number;
  /** Rate filters (s). */
  tauRateL0: number; tauRateL1: number; tauRateL23: number;
  /** Salience: soft divisive normalisation. */
  salienceN: number; salienceSigma: number;
  /** Predictive coding. */
  pcK1: number; pcK2: number; pcSigma2: number; pcSigmaTd2: number; pcLambda: number; pcEMax: number; pcPriorL2: number;
  pcSigmaLearnTau: number; pcSigma2Min: number; pcSigma2Max: number; surpriseTau: number; errZTau: number;
  /** Governor (astrocyte-like). */
  tauG: number; govK: [number, number, number, number]; govDelta: number; govDeltaP: number;
  /** Plasticity. */
  triplet: TripletParams; eta: number; kappa: number; wMin: number; wMax: number; tauRho: number;
  /** Two-speed weights. */
  tauC: number; eps: number; slowEverySec: number;
  /** Readout. */
  readoutEta: number; readoutCap: number; tagEverySec: number; tagsPerContract: number; maxTaggedContracts: number; traceTauSec: number;
  priorSlope: number;
  /** Wilson-Cowan regime drive gain; gap-junction coupling factor (<< 1). */
  wcGain: number; gapCoupling: number;
  /** Catch-up: at most this many 1 s steps per call; larger gaps reset transient state. */
  maxCatchUpSteps: number;
}

export const ALL_ON_FLAGS: SnnFlags = {
  rawReadout: false, tags: true, monotone: true, dendrites: true, synClasses: true, alif: true, pc: true, surpriseToC: true,
  lateral: true, plasticity: false, pcLearn: true, proxies: false, wilsonCowan: false, gapJunctions: false, izhikevichCH: false, dcaap: false,
};

/** Flags for each stage: S(n) adds its mechanism to S(n-1). */
export function stageFlags(stage: Stage): SnnFlags {
  const k = STAGES.indexOf(stage);
  return {
    rawReadout: false,
    tags: k >= 1, monotone: k >= 1,
    dendrites: k >= 2,
    synClasses: k >= 3, alif: k >= 3,
    pc: k >= 4, surpriseToC: k >= 4,
    lateral: k >= 5,
    plasticity: k >= 6, pcLearn: k >= 6,
    proxies: false, wilsonCowan: false, gapJunctions: false, izhikevichCH: false, dcaap: false,
  };
}

export const DEFAULT_SNN: SnnParams = {
  seed: 20260601,
  flags: { ...stageFlags('S5') },
  nL0: 64, nL1: 48, branches: 6, synPerBranch: 16, nE: 128, nI: 32,
  maxColumns: 18, maxTennisColumns: 8,
  dirEta: 2e-3, dirCap: 0.02, dirEverySec: 60,
  deltaBps: [3, 6, 12], midDelta: 0.01, tauL0: 2, popGain: 1.2, deltaGain: 1.5, thetaL0: 0.5,
  branchTaus: [5, 5, 30, 30, 120, 120], tauL1: 5, thetaL1: 0.5, l1Gain: 1.2, nmdaWeight: 0.02, mg: 1, branchTheta: 0.5, wInitL1: 0.25,
  feedbackGain: 0.2,
  tauE: 10, tauA: 300, betaA: 0.01, thetaE: 0.5, tauI: 3, thetaI: 0.5,
  pFF: 0.25, wFF: 0.1, pRec: 0.1, wEE: 0.05, wEI: 0.08, wIE: 0.15, wII: 0.1, wLat: 0.5,
  tauRateL0: 5, tauRateL1: 30, tauRateL23: 60,
  salienceN: 2, salienceSigma: 0.02,
  pcK1: 0.05, pcK2: 0.002, pcSigma2: 0.05, pcSigmaTd2: 0.5, pcLambda: 1e-3, pcEMax: 2, pcPriorL2: 0.01,
  pcSigmaLearnTau: 6 * 3600, pcSigma2Min: 0.005, pcSigma2Max: 1, surpriseTau: 60, errZTau: 3600,
  tauG: 3600, govK: [0.5, 0.05, 5, 2], govDelta: 0.8, govDeltaP: 0.5,
  // Minimal triplet (A2+ = A3- = 0): four parameters (A3+, A2-, tau+, tau-) plus the post trace tau_y.
  // Biological fits are ~17/34/114 ms; here re-expressed in market seconds (see the open question).
  triplet: { tauPlus: 17, tauMinus: 34, tauY: 114, A3plus: 6.5e-3, A2minus: 7.1e-3, rho0: 0.05, p: 1 },
  eta: 0.05, kappa: 0.002, wMin: -1, wMax: 1, tauRho: 45 * 60,
  tauC: 4 * 3600, eps: 5e-6, slowEverySec: 60,
  readoutEta: 1e-4, readoutCap: 0.01, tagEverySec: 60, tagsPerContract: 8, maxTaggedContracts: 5000, traceTauSec: 45 * 60,
  priorSlope: 1.7,
  wcGain: 4, gapCoupling: 0.05,
  maxCatchUpSteps: 120,
};

export function withFlags(p: SnnParams, flags: Partial<SnnFlags>): SnnParams {
  return { ...p, flags: { ...p.flags, ...flags } };
}

/** Model version hash: everything that defines the network's shape and dynamics. */
export function versionHash(p: SnnParams): string {
  return crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16);
}

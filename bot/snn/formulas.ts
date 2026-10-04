// Every equation of "From Flat SNN to Cortex-Like Predictor" in code form, in its CORRECTED
// form (the review's corrections table). Pure functions with no state, so each one is asserted
// against hand-computed values and against the stdlib-only Python reference
// (research/snn_reference.py -> tests/fixtures/snn_golden.json, tolerance 1e-5).
//
// Status per the review, kept next to each formula:
//   ADOPT     used by the live network (bot/snn/network.ts)
//   DEFER     implemented and wired behind a flag that is off; it must beat its cheap proxy first
//   REJECT    reference only (never stepped by the network): HH, Nernst-Planck, cable, memantine
//
// Units: all time constants are MARKET seconds (clock dt = 1 s); voltages are dimensionless
// "mV-equivalent" unless stated.

// ---------------------------------------------------------------------------------------------
// Neurons
// ---------------------------------------------------------------------------------------------

/** Exact exponential decay factor e^{-dt/tau} (precomputed once per tau). */
export const decay = (dt: number, tau: number): number => Math.exp(-dt / tau);

/** ADOPT. LIF exact update, unconditionally stable, exact for input piecewise-constant over dt:
 *  V_{t+1} = V_inf + (V_t - V_inf) e^{-dt/tau_m},  V_inf = E_L + R I_t. */
export function lifStep(v: number, I: number, p: { EL: number; R: number; tauM: number }, dt = 1): number {
  const vInf = p.EL + p.R * I;
  return vInf + (v - vInf) * Math.exp(-dt / p.tauM);
}

/** ADOPT. Adaptive LIF threshold: theta = theta_0 + beta_a * a. */
export const alifThreshold = (theta0: number, betaA: number, a: number): number => theta0 + betaA * a;

/** ADOPT. Adaptation variable: a_{t+1} = a_t e^{-dt/tau_a} + s_t. */
export const alifAdapt = (a: number, s: number, tauA: number, dt = 1): number => a * Math.exp(-dt / tauA) + s;

/** One full ALIF step (LIF membrane, threshold test, reset, adaptation). Spike if V >= theta_0 + beta_a a. */
export function alifStep(st: { v: number; a: number }, I: number, p: { EL: number; R: number; tauM: number; theta0: number; betaA: number; tauA: number; vReset: number }, dt = 1): { v: number; a: number; s: 0 | 1 } {
  let v = lifStep(st.v, I, p, dt);
  const s: 0 | 1 = v >= alifThreshold(p.theta0, p.betaA, st.a) ? 1 : 0;
  if (s) v = p.vReset;
  return { v, a: alifAdapt(st.a, s, p.tauA, dt), s };
}

/** DEFER. Izhikevich (2003) parameter table (a, b, c, d). CH: c = -50, d = 2. */
export const IZH = {
  RS: { a: 0.02, b: 0.2, c: -65, d: 8 },
  FS: { a: 0.1, b: 0.2, c: -65, d: 2 },
  CH: { a: 0.02, b: 0.2, c: -50, d: 2 },
} as const;

/** DEFER. Izhikevich step of 1 ms (model time): two 0.5 ms half-steps of v "for numerical
 *  stability" (as in the original MATLAB), then u; v clamped at the 30 mV peak before reset.
 *  v' = 0.04v^2 + 5v + 140 - u + I;  u' = a(bv - u);  if v >= 30: v <- c, u <- u + d. */
export function izhikevichStep(v: number, u: number, I: number, p: { a: number; b: number; c: number; d: number }): { v: number; u: number; spike: boolean } {
  v += 0.5 * (0.04 * v * v + 5 * v + 140 - u + I);
  v += 0.5 * (0.04 * v * v + 5 * v + 140 - u + I);
  u += p.a * (p.b * v - u);
  if (v >= 30) return { v: p.c, u: u + p.d, spike: true };
  return { v, u, spike: false };
}

// ---- REJECT: Hodgkin-Huxley (corrected; modern -65 mV rest convention). Reference only. ------

/** HH alpha_n = 0.01 (V+55) / (1 - e^{-(V+55)/10}); limit 0.1 at V = -55. */
export function hhAlphaN(V: number): number {
  const x = V + 55;
  return Math.abs(x) < 1e-9 ? 0.1 : (0.01 * x) / (1 - Math.exp(-x / 10));
}
/** HH beta_n = 0.125 e^{-(V+65)/80} (the PDF's 0.125 exp(-0.01125(V+55)) is wrong). */
export const hhBetaN = (V: number): number => 0.125 * Math.exp(-(V + 65) / 80);

// ---- REJECT: electrodiffusion and cable theory. Reference only (the time-constant hierarchy is
// the one idea kept: per-branch tau in {5, 30, 120} s). -----------------------------------------

export const PHYS = { F: 96485.33212, R: 8.314462618, kB: 1.380649e-23, e: 1.602176634e-19 } as const;

/** Nernst-Planck flux J = -D (dC/dx + (zF/RT) C dV/dx). The drift term is proportional to C. */
export const nernstPlanckFlux = (D: number, dCdx: number, z: number, T: number, C: number, dVdx: number): number =>
  -D * (dCdx + ((z * PHYS.F) / (PHYS.R * T)) * C * dVdx);

/** Einstein relation D = mu k_B T / |q|. */
export const einsteinD = (mu: number, T: number, q: number): number => (mu * PHYS.kB * T) / Math.abs(q);

/** Rall cable length constant lambda = sqrt((d/4) R_m / R_i). */
export const cableLambda = (d: number, Rm: number, Ri: number): number => Math.sqrt(((d / 4) * Rm) / Ri);

/** Cable equation residual lambda^2 d2V/dx2 - (tau_m dV/dt + V); zero for a solution. */
export const cableResidual = (lambda: number, d2Vdx2: number, tauM: number, dVdt: number, V: number): number =>
  lambda * lambda * d2Vdx2 - (tauM * dVdt + V);

// ---------------------------------------------------------------------------------------------
// Dendrites
// ---------------------------------------------------------------------------------------------

export const sigmoid = (x: number): number => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));
export const logit = (p: number): number => { const q = Math.min(1 - 1e-12, Math.max(1e-12, p)); return Math.log(q / (1 - q)); };

/** ADOPT. Poirazi, Brannon & Mel (2003) two-layer neuron (corrected):
 *  y = g( sum_j alpha_j s( sum_{i in D_j} w_i x_i ) ), s sigmoidal. `theta` is the per-branch
 *  offset of the handoff form b_j = sigma(sum w x - theta_j). */
export function poirazi(branches: { w: ArrayLike<number>; x: ArrayLike<number>; theta?: number }[], alpha: ArrayLike<number>, g: (z: number) => number = (z) => z, s: (z: number) => number = sigmoid): number {
  let y = 0;
  for (let j = 0; j < branches.length; j++) {
    const b = branches[j];
    let u = -(b.theta ?? 0);
    for (let i = 0; i < b.w.length; i++) u += b.w[i] * b.x[i];
    y += alpha[j] * s(u);
  }
  return g(y);
}

/** DEFER. dCaAP non-monotonic branch activation (Gidon 2020): s(x) = exp(-(x - theta)^2 / 2w^2),
 *  maximal at threshold-level input and dampened for stronger input. */
export const dcaap = (x: number, theta: number, w: number): number => Math.exp(-((x - theta) ** 2) / (2 * w * w));

// ---------------------------------------------------------------------------------------------
// Synapses
// ---------------------------------------------------------------------------------------------

/** Double-exponential peak time t_pk = tau_d tau_r / (tau_d - tau_r) ln(tau_d / tau_r). */
export const dexpPeakTime = (tauR: number, tauD: number): number => ((tauD * tauR) / (tauD - tauR)) * Math.log(tauD / tauR);

/** Peak normalisation K = 1 / (e^{-t_pk/tau_d} - e^{-t_pk/tau_r}), so the kernel peaks at gbar. */
export function dexpNorm(tauR: number, tauD: number): number {
  const t = dexpPeakTime(tauR, tauD);
  return 1 / (Math.exp(-t / tauD) - Math.exp(-t / tauR));
}

/** ADOPT. Synaptic kernel g(t) = gbar K (e^{-t/tau_d} - e^{-t/tau_r}), t >= 0. */
export const dexpKernel = (t: number, gbar: number, tauR: number, tauD: number): number =>
  t < 0 ? 0 : gbar * dexpNorm(tauR, tauD) * (Math.exp(-t / tauD) - Math.exp(-t / tauR));

/** Exact clocked double-exponential: two traces x <- x e^{-dt/tau} + spikes; g = gbar K (xd - xr). */
export function dexpTraceStep(xr: number, xd: number, spikes: number, tauR: number, tauD: number, dt = 1): { xr: number; xd: number } {
  return { xr: xr * Math.exp(-dt / tauR) + spikes, xd: xd * Math.exp(-dt / tauD) + spikes };
}

/** Synapse classes (current-based, shared tau per class). AMPA-like 5 s, NMDA-like 90 s, GABA-like 10 s. */
export const SYN_CLASSES = {
  ampa: { tauR: 0.5, tauD: 5 },
  nmda: { tauR: 2, tauD: 90 },
  gaba: { tauR: 0.5, tauD: 10 },
} as const;

/** ADOPT. Jahr & Stevens (1990) NMDA Mg2+ block: G(V) = 1 / (1 + ([Mg]/3.57) e^{-0.062 V}),
 *  V in mV(-equivalent), [Mg] in mM. Used as the coincidence gate on learning and on the NMDA class. */
export const nmdaGate = (V: number, mg = 1): number => 1 / (1 + (mg / 3.57) * Math.exp(-0.062 * V));

/** Rescale a dimensionless membrane value to mV-equivalent for the gate:
 *  V~ = vRest + (v - EL)/(theta - EL) * (vThresh - vRest), mapping rest -> -65 mV, threshold -> -50 mV. */
export const toMvEquivalent = (v: number, EL: number, theta: number, vRest = -65, vThresh = -50): number =>
  vRest + ((v - EL) / (theta - EL)) * (vThresh - vRest);

/** DEFER. Gap junction current I = g_j (V1 - V2). */
export const gapCurrent = (gj: number, V1: number, V2: number): number => gj * (V1 - V2);

/** DEFER. Steady-state coupling coefficient CC = R2/(R2 + Rj) = g_j/(g_j + g2). */
export const couplingCoefficientR = (R2: number, Rj: number): number => R2 / (R2 + Rj);
export const couplingCoefficientG = (gj: number, g2: number): number => gj / (gj + g2);

// ---------------------------------------------------------------------------------------------
// Astrocyte-like governor
// ---------------------------------------------------------------------------------------------

/** Postnov, Ryazanova & Sosnovtseva (2007) tripartite-synapse currents (functional model):
 *  I_syn = (k_s - delta G_m)(z - z0),  I_ast = gamma G_m. The governor deliberately EXCLUDES the
 *  +gamma G_m excitatory term (hyperexcitability is the opposite of what a governor should do). */
export const postnovISyn = (ks: number, delta: number, Gm: number, z: number, z0: number): number => (ks - delta * Gm) * (z - z0);
export const postnovIAst = (gamma: number, Gm: number): number => gamma * Gm;

export const sat01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export interface GovernorDrive { rhoHat: number; zE: number; fSat: number; dBrier: number }
export interface GovernorGains { k1: number; k2: number; k3: number; k4: number }

/** ADOPT. Governor tau_G dG/dt = -G + sat(k1 rho^ + k2 z_e + k3 f_sat + k4 dB), G in [0, 1],
 *  integrated exactly as a first-order low-pass (input held over dt). Non-oscillatory. */
export function governorStep(G: number, d: GovernorDrive, k: GovernorGains, tauG: number, dt = 1): number {
  const u = sat01(k.k1 * d.rhoHat + k.k2 * d.zE + k.k3 * d.fSat + k.k4 * d.dBrier);
  return sat01(u + (G - u) * Math.exp(-dt / tauG));
}

/** Governor effects (one-directional: only ever reduce): eta_eff = eta (1 - delta G); gain x (1 - delta' G). */
export const etaEff = (eta: number, delta: number, G: number): number => eta * (1 - delta * sat01(G));
export const columnGain = (deltaP: number, G: number): number => 1 - deltaP * sat01(G);

// ---------------------------------------------------------------------------------------------
// Plasticity
// ---------------------------------------------------------------------------------------------

/** BCM sliding threshold, Intrator-Cooper (1992) form: theta_M = <y^2> / rho0. */
export const bcmThetaIC = (meanY2: number, rho0: number): number => meanY2 / rho0;
/** BCM sliding threshold, 1982 original super-linear form: theta_M = (ybar/y0)^p ybar. */
export const bcmTheta1982 = (ybar: number, y0: number, p: number): number => (ybar / y0) ** p * ybar;
/** BCM rate rule dw_i/dt = eta x_i y (y - theta_M). */
export const bcmDw = (eta: number, x: number, y: number, theta: number): number => eta * x * y * (y - theta);

export interface TripletParams { tauPlus: number; tauMinus: number; tauY: number; A3plus: number; A2minus: number; rho0: number; p: number }

/** Minimal triplet traces (A2+ = A3- = 0): r1 <- r1 e^{-dt/tau+} + s_pre; o1 <- o1 e^{-dt/tau-} + s_post;
 *  o2 <- o2 e^{-dt/tau_y} + s_post. */
export function tripletTraces(r1: number, o1: number, o2: number, sPre: number, sPost: number, p: TripletParams, dt = 1): { r1: number; o1: number; o2: number } {
  return { r1: r1 * Math.exp(-dt / p.tauPlus) + sPre, o1: o1 * Math.exp(-dt / p.tauMinus) + sPost, o2: o2 * Math.exp(-dt / p.tauY) + sPost };
}

/** BCM slide of depression: A2-(rhobar) = A2- (rhobar/rho0)^p. */
export const a2MinusSlide = (A2minus: number, rhoBar: number, rho0: number, p: number): number => A2minus * Math.max(0, rhoBar / rho0) ** p;

/** Minimal triplet STDP increments, given traces BEFORE this step's own spikes are added
 *  (o2 is read at t - epsilon): on post spike dw+ = A3+ r1 o2; on pre spike dw- = -A2-(rhobar) o1. */
export function tripletDw(sPre: number, sPost: number, r1: number, o1: number, o2Prev: number, rhoBar: number, p: TripletParams): { plus: number; minus: number } {
  return {
    plus: sPost ? p.A3plus * r1 * o2Prev : 0,
    minus: sPre ? -a2MinusSlide(p.A2minus, rhoBar, p.rho0, p.p) * o1 : 0,
  };
}

/** Gated update dw = eta_eff G(V_post) (dw+ + dw-), per-update cap |dw| <= kappa, then w clipped to [wMin, wMax]. */
export function gatedUpdate(w: number, plus: number, minus: number, etaEffective: number, gate: number, kappa: number, wMin: number, wMax: number): number {
  let dw = etaEffective * gate * (plus + minus);
  if (dw > kappa) dw = kappa; else if (dw < -kappa) dw = -kappa;
  const v = w + dw;
  return v < wMin ? wMin : v > wMax ? wMax : v;
}

/** Two-speed weights, exact for a step with no plasticity input:
 *  dw_f/dt = -(w_f - w_s)/tau_c,  dw_s/dt = eps (w_f - w_s).  With d = w_f - w_s and k = 1/tau_c + eps:
 *  d(t) = d0 e^{-kt},  w_s(t) = w_s0 + eps d0 (1 - e^{-kt})/k,  w_f = w_s + d. (Plasticity enters w_f as impulses.) */
export function twoSpeedStep(wf: number, ws: number, tauC: number, eps: number, dt = 1): { wf: number; ws: number } {
  const k = 1 / tauC + eps;
  const d0 = wf - ws;
  const e = Math.exp(-k * dt);
  const ws1 = ws + (eps * d0 * (1 - e)) / k;
  return { wf: ws1 + d0 * e, ws: ws1 };
}

/** Forgetting half-life of a fast-weight deviation under two-speed weights: ln 2 / (1/tau_c + eps). */
export const twoSpeedHalfLife = (tauC: number, eps: number): number => Math.LN2 / (1 / tauC + eps);

/** Reward-modulated eligibility (Izhikevich 2007) for comparison: c <- c e^{-dt/tau_c}; tau_c = 1 s biologically. */
export const eligibilityDecay = (c: number, tauC: number, dt = 1): number => c * Math.exp(-dt / tauC);

/** ADOPT. Supervised third factor at settlement (per-contract tag): logistic readout under log-loss,
 *  dw = eta (y_k - p_k) phi_k, each component capped at `cap`. */
export function readoutDelta(phi: ArrayLike<number>, y: number, p: number, eta: number, cap: number, out?: Float64Array): Float64Array {
  const dw = out ?? new Float64Array(phi.length);
  const g = eta * (y - p);
  for (let i = 0; i < phi.length; i++) { const v = g * phi[i]; dw[i] = v > cap ? cap : v < -cap ? -cap : v; }
  return dw;
}

// ---------------------------------------------------------------------------------------------
// Predictive coding (Rao & Ballard 1999, corrected precision weighting)
// ---------------------------------------------------------------------------------------------

export interface PcParams { k1: number; k2: number; sigma2: number; sigmaTd2: number; lambda: number; eMax: number; priorL2: number }

/** f = tanh predictor and its derivative. */
export const pcF = Math.tanh;
export const pcFPrime = (u: number): number => { const t = Math.tanh(u); return 1 - t * t; };

/** Clip a vector to norm <= eMax in place; returns the pre-clip norm. */
export function clipNorm(e: Float64Array | number[], eMax: number): number {
  let s = 0;
  for (let i = 0; i < e.length; i++) s += e[i] * e[i];
  const n = Math.sqrt(s);
  if (n > eMax && n > 0) { const k = eMax / n; for (let i = 0; i < e.length; i++) e[i] *= k; }
  return n;
}

export interface PcScratch { u: Float64Array; e: Float64Array; fe: Float64Array; r0: Float64Array }
export const pcScratch = (nx: number, nr: number): PcScratch => ({ u: new Float64Array(nx), e: new Float64Array(nx), fe: new Float64Array(nx), r0: new Float64Array(nr) });

/** Prediction half of a Rao-Ballard step. U row-major (nx x nr): u = U r, xhat = f(u), e = x - xhat.
 *  Returns the UNCLIPPED error norm (the caller decides the clip, e.g. tighter at error z > 6). */
export function pcPredict(U: ArrayLike<number>, r: ArrayLike<number>, x: ArrayLike<number>, s: PcScratch): number {
  const nx = x.length, nr = r.length;
  let n2 = 0;
  for (let i = 0; i < nx; i++) {
    let v = 0;
    const row = i * nr;
    for (let j = 0; j < nr; j++) v += U[row + j] * r[j];
    s.u[i] = v;
    const e = x[i] - pcF(v);
    s.e[i] = e;
    n2 += e * e;
  }
  return Math.sqrt(n2);
}

/** Update half: clip |e| <= eMax, then
 *  r <- r + (k1/sigma^2) U^T (f' . e) + (k1/sigma_td^2)(r_td - r) - (k1/2) g'(r),  g(r) = priorL2 |r|^2;
 *  U <- U + (k2/sigma^2) (f' . e) r^T - k2 lambda U   (skipped when learnU is false). */
export function pcUpdate(U: Float32Array | Float64Array, r: Float64Array, rTd: ArrayLike<number> | undefined, s: PcScratch, p: PcParams, learnU: boolean, eMax = p.eMax): void {
  const nx = s.e.length, nr = r.length;
  clipNorm(s.e, eMax);
  for (let i = 0; i < nx; i++) s.fe[i] = pcFPrime(s.u[i]) * s.e[i];
  const a = p.k1 / p.sigma2, b = p.k1 / p.sigmaTd2;
  const r0 = s.r0;
  r0.set(r);
  for (let j = 0; j < nr; j++) {
    let v = 0;
    for (let i = 0; i < nx; i++) v += U[i * nr + j] * s.fe[i];
    const td = rTd ? b * (rTd[j] - r0[j]) : 0;
    r[j] = r0[j] + a * v + td - (p.k1 / 2) * (2 * p.priorL2 * r0[j]);
  }
  if (learnU) {
    const c = p.k2 / p.sigma2, dec = 1 - p.k2 * p.lambda;
    for (let i = 0; i < nx; i++) {
      const row = i * nr, g = c * s.fe[i];
      for (let j = 0; j < nr; j++) U[row + j] = U[row + j] * dec + g * r0[j];
    }
  }
}

/** One full Rao-Ballard step for one level (predict, clip, update). Mutates r and U. */
export function pcStep(U: Float32Array | Float64Array, r: Float64Array, x: ArrayLike<number>, rTd: ArrayLike<number> | undefined, p: PcParams, learnU = true, scratch?: PcScratch): { e: Float64Array; norm: number } {
  const s = scratch ?? pcScratch(x.length, r.length);
  const norm = pcPredict(U, r, x, s);
  pcUpdate(U, r, rTd, s, p, learnU);
  return { e: s.e, norm };
}

/** Precision-weighted, dimension-normalised error norm s = |e| / (sigma sqrt(n)), the instantaneous surprise. */
export const surpriseOf = (norm: number, sigma2: number, n: number): number => norm / Math.sqrt(sigma2 * Math.max(1, n));

/** Stable step size bound for the r update: (k1/sigma^2) lambda_max(U^T U) < 2. Power iteration estimate. */
export function pcLambdaMax(U: ArrayLike<number>, nx: number, nr: number, iters = 30): number {
  let v = new Float64Array(nr).fill(1 / Math.sqrt(nr));
  let lam = 0;
  for (let it = 0; it < iters; it++) {
    const Uv = new Float64Array(nx);
    for (let i = 0; i < nx; i++) { let s = 0; for (let j = 0; j < nr; j++) s += U[i * nr + j] * v[j]; Uv[i] = s; }
    const w = new Float64Array(nr);
    for (let j = 0; j < nr; j++) { let s = 0; for (let i = 0; i < nx; i++) s += U[i * nr + j] * Uv[i]; w[j] = s; }
    let n = 0; for (let j = 0; j < nr; j++) n += w[j] * w[j];
    n = Math.sqrt(n);
    if (n === 0) return 0;
    lam = n;
    for (let j = 0; j < nr; j++) w[j] /= n;
    v = w;
  }
  return lam;
}

// ---------------------------------------------------------------------------------------------
// Wilson-Cowan regime layer (DEFER; must beat an HMM/EWMA-vol regime feature)
// ---------------------------------------------------------------------------------------------

export const WC_PARAMS = { c1: 12, c2: 4, c3: 13, c4: 11, ae: 1.2, thetaE: 2.8, ai: 1, thetaI: 4, rE: 1, rI: 1, kE: 0.97, kI: 0.98, tauE: 10, tauI: 10 } as const;
export type WcParams = { -readonly [K in keyof typeof WC_PARAMS]: number };

/** Wilson-Cowan sigmoid S(x) = 1 / (1 + e^{-a(x - theta)}). */
export const wcS = (x: number, a: number, theta: number): number => 1 / (1 + Math.exp(-a * (x - theta)));

/** tau_E dE/dt = -E + (k_E - r_E E) S_E(c1 E - c2 I + P);  tau_I dI/dt = -I + (k_I - r_I I) S_I(c3 E - c4 I + Q). */
export function wcDeriv(E: number, I: number, P: number, Q: number, w: WcParams): [number, number] {
  const dE = (-E + (w.kE - w.rE * E) * wcS(w.c1 * E - w.c2 * I + P, w.ae, w.thetaE)) / w.tauE;
  const dI = (-I + (w.kI - w.rI * I) * wcS(w.c3 * E - w.c4 * I + Q, w.ai, w.thetaI)) / w.tauI;
  return [dE, dI];
}

/** RK2 (midpoint) step; callers sub-step so dt <= tau/10. A 2-D autonomous pair cannot be chaotic. */
export function wcStepRk2(E: number, I: number, P: number, Q: number, dt: number, w: WcParams = WC_PARAMS): { E: number; I: number } {
  const n = Math.max(1, Math.ceil(dt / (Math.min(w.tauE, w.tauI) / 10)));
  const h = dt / n;
  for (let k = 0; k < n; k++) {
    const [a1, b1] = wcDeriv(E, I, P, Q, w);
    const [a2, b2] = wcDeriv(E + 0.5 * h * a1, I + 0.5 * h * b1, P, Q, w);
    E += h * a2; I += h * b2;
  }
  return { E, I };
}

// ---------------------------------------------------------------------------------------------
// Training and readout helpers
// ---------------------------------------------------------------------------------------------

/** snnTorch fast-sigmoid surrogate dS/dU = 1 / (1 + k|U|)^2, k = 25 by default. */
export const fastSigmoidSurrogate = (U: number, k = 25): number => 1 / (1 + k * Math.abs(U)) ** 2;

/** ADOPT. Soft divisive normalisation salience_i = r_i^n / (sigma^n + sum_j r_j^n). */
export function divisiveNormalization(r: ArrayLike<number>, n: number, sigma: number): number[] {
  let den = sigma ** n;
  for (let i = 0; i < r.length; i++) den += Math.max(0, r[i]) ** n;
  return Array.from(r, (x) => (den > 0 ? Math.max(0, x) ** n / den : 0));
}

/** ADOPT. Weighted isotonic regression by pool-adjacent-violators: the L2-closest sequence that is
 *  non-increasing (default; P(index > strike) falls with the strike) or non-decreasing. */
export function isotonic(y: ArrayLike<number>, w?: ArrayLike<number>, decreasing = true): number[] {
  const n = y.length;
  const val: number[] = [], wt: number[] = [], len: number[] = [];
  for (let i = 0; i < n; i++) {
    let v = decreasing ? -y[i] : y[i], ww = w ? w[i] : 1, l = 1;
    while (val.length && val[val.length - 1] > v) {
      const pv = val.pop()!, pw = wt.pop()!, pl = len.pop()!;
      v = (pv * pw + v * ww) / (pw + ww); ww += pw; l += pl;
    }
    val.push(v); wt.push(ww); len.push(l);
  }
  const out: number[] = [];
  for (let k = 0; k < val.length; k++) for (let i = 0; i < len[k]; i++) out.push(decreasing ? -val[k] : val[k]);
  return out;
}

/** Blend p_final = (1 - alpha c) p_model + alpha c p_snn, alpha clamped to [0, alphaMax], c to [0, 1]. */
export function blend(pModel: number, pSnn: number, alpha: number, c: number, alphaMax = 0.25): number {
  const a = Math.min(alphaMax, Math.max(0, alpha)) * sat01(c);
  return (1 - a) * pModel + a * pSnn;
}

/** Confidence: calibration-derived c times min(1, S0/S_t), so surprise can only REDUCE confidence. */
export const surpriseConfidence = (cCal: number, S0: number, St: number): number => sat01(cCal) * (St > 0 ? Math.min(1, S0 / St) : 1);

/** Brier score of one forecast. */
export const brier = (p: number, y: number): number => (p - y) * (p - y);

/** Ranked probability score over an ordered ladder of K thresholds. cdfExceed[k] = P(X > K_k)
 *  (non-increasing); the outcome indicator is 1{x > K_k}. RPS = (1/K) sum_k (P_k - O_k)^2. Proper. */
export function rankedProbabilityScore(cdfExceed: ArrayLike<number>, outcomeExceed: ArrayLike<number>): number {
  let s = 0;
  for (let k = 0; k < cdfExceed.length; k++) s += (cdfExceed[k] - outcomeExceed[k]) ** 2;
  return cdfExceed.length ? s / cdfExceed.length : NaN;
}

/** Calibration slope: logistic regression of y on logit(p) (Newton, intercept + slope). 1 = calibrated. */
export function calibrationSlope(p: ArrayLike<number>, y: ArrayLike<number>, iters = 25): number {
  let a = 0, b = 1;
  const n = p.length;
  if (n < 3) return NaN;
  const x = Array.from(p, logit);
  for (let it = 0; it < iters; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let i = 0; i < n; i++) {
      const q = sigmoid(a + b * x[i]);
      const r = y[i] - q, w = q * (1 - q);
      g0 += r; g1 += r * x[i]; h00 += w; h01 += w * x[i]; h11 += w * x[i] * x[i];
    }
    h00 += 1e-9; h11 += 1e-9;
    const det = h00 * h11 - h01 * h01;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (h11 * g0 - h01 * g1) / det, db = (h00 * g1 - h01 * g0) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-10) break;
  }
  return b;
}

/** Pearson correlation. */
export function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return NaN;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

/** Population code: 8 Gaussian tuning curves on [lo, hi]; returns activation per band in [0, 1]. */
export function populationCode(x: number, lo: number, hi: number, bands = 8, out?: Float64Array, offset = 0): Float64Array {
  const o = out ?? new Float64Array(bands);
  const step = (hi - lo) / (bands - 1);
  const v = Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : NaN;
  for (let k = 0; k < bands; k++) {
    const c = lo + k * step;
    o[offset + k] = Number.isFinite(v) ? Math.exp(-0.5 * ((v - c) / (0.6 * step)) ** 2) : 0;
  }
  return o;
}

/** Send-on-delta encoder: emits floor(|acc|/theta) spikes on the up or down channel, keeps the remainder. */
export function deltaEncode(acc: number, dx: number, theta: number): { acc: number; up: number; down: number } {
  let a = acc + dx;
  const n = Math.floor(Math.abs(a) / theta);
  if (n === 0) return { acc: a, up: 0, down: 0 };
  const up = a > 0 ? n : 0, down = a < 0 ? n : 0;
  a -= Math.sign(a) * n * theta;
  return { acc: a, up, down };
}

/** EWMA with an exact time-constant weight: m <- m + (1 - e^{-dt/tau}) (x - m). */
export const ewma = (m: number, x: number, tau: number, dt = 1): number => m + (1 - Math.exp(-dt / tau)) * (x - m);

// One SNN column step (bot/snn/column.ts Column.step + pcStep) in C that compiles both as plain C (the
// CPU parity harness, tests/snnKernel.test.ts) and as CUDA (python/snn/bench.py: one thread per member x
// column). Every loop, every operation and its order follow the TypeScript, the transcendental functions
// are V8's own (fdlibm.h), weights round to float32 where the TypeScript stores them in Float32Arrays, and
// the build turns fused multiply-add off -- so the GPU produces the same bits as the live network.
//
// Prototype scope: the column step only (the network's cross-column terms -- lateral inhibition, gap
// junctions, the readouts' Brier drift, the health reference -- arrive as inputs). e-prop training,
// dCaAP branches and the Izhikevich detectors are not ported (the host refuses those flags).

#ifdef __CUDACC_RTC__
typedef unsigned long long uint64_t;
typedef int int32_t;
typedef unsigned int uint32_t;
#endif
#include "fdlibm.h"

typedef struct {
  // ints first (20, so the doubles start 8-aligned at byte 80; research/snnKernel.ts writes this layout)
  int nL0, nL1, B, K, nE, N, nSyn, nThr, nPop, kindTennis;
  int synClasses, dendrites, pc, lateral, gapJunctions, alif, plasticity, pcLearn, slowEverySec, pad_;
  // encoders
  double deltaGain, midDelta, popGain, thetaL0, tauRateL0;
  // L1
  double nmdaWeight, mg, thetaL1, l1Gain, feedbackGain, tauRateL1;
  // L2/3
  double govDeltaP, thetaE, thetaI, gapCoupling, betaA, tauRateL23;
  double ipLow, ipHigh, ipStep, ipMin;
  // plasticity
  double eta, govDelta, kappa, wMin, wMax, tauRho, A3plus, A2minus, rho0, tripP;
  double tauC, eps;
  // governor
  double govK0, govK1, govK2, govK3, tauG;
  // predictive coding
  double pcK1, pcK2, pcSigmaTd2, pcLambda, pcEMax, pcPriorL2, errZTau, surpriseTau, pcSigma2Max, pcSigma2Min, pcSigmaLearnTau;
  // the column's precomputed decays and kernel norms (Column.dec, Ka, Kn, Kg)
  double dL0, dL1, dE, dI, dA, daR, daD, dnR, dnD, dgR, dgD, dtp, dtm, dty, Ka, Kn, Kg;
} SnnP;

typedef struct {
  double *thr, *popLo, *popHi, *decBranch;
  double *I0, *v0, *rate0, *deltaAcc, *aR0, *aD0, *nR0, *nD0, *gA0, *gN0;
  double *theta1, *alpha1, *u1, *b1, *bbar, *v1, *rate1, *gate1, *preR1, *postO1, *postO2, *rho1;
  double *v2, *a2, *rate2, *aR2, *aD2, *nR2, *nD2, *gR2, *gD2, *preRE, *postO1E, *postO2E, *rhoE, *theta0E, *theta0I;
  double *z2, *z1, *xhat1, *err0;
  double *s1u, *s1t, *s1e, *s1fe, *s1r0, *s1acc, *s0u, *s0t, *s0e, *s0fe, *s0r0, *s0acc;
  unsigned char *s0, *s1, *s2;
  float *w1, *w1s, *ffW, *recW, *recWs, *U1, *U0;
  int *src, *ffPtr, *ffCol, *recPtr, *recCol, *inPtr, *inEdge, *inPre, *revPtr, *revSyn, *prevSpikes;
  // scalars (Column.SCALARS order, plus the private counters)
  double *sc; // 25 doubles, see SC_*
  int *si;    // pcFrozen, nPrev, stepsSinceSlow, ipCount
} Col;

enum { SC_midAcc, SC_lastSpot, SC_lastMid, SC_sigma2_1, SC_sigma2_0, SC_surprise, SC_surpriseInst, SC_errMean, SC_errVar, SC_errN, SC_errZ,
  SC_zHighRun, SC_pcNormalRun, SC_G, SC_rateL0, SC_rateL1, SC_rateE, SC_rateI, SC_exc, SC_inh, SC_fSat, SC_chBurst, SC_deltaFast, SC_deltaSlow, SC_lastRetBp, SC_COUNT };
enum { SI_pcFrozen, SI_nPrev, SI_stepsSinceSlow, SI_ipCount, SI_COUNT };

/** One call's inputs: price/mid NaN when absent, vals[nPop] NaN when absent, refRateE 0 when absent; kind 1 = a step,
 *  2 = resetTransient, 0 = nothing this round (the batch kernel). 72 bytes. */
typedef struct { double price, mid, latInh, dBrier, refRateE; int first, frozen, kind, pad_; const double *vals, *gapV; } StepIn;

SNN_FN double s_min(double a, double b) { return a < b ? a : b; } // Math.min/Math.max on non-NaN operands
SNN_FN double s_max(double a, double b) { return a > b ? a : b; }
SNN_FN int s_finite(double x) { return x == x && x - x == 0.0; }
SNN_FN double ewma(double m, double x, double tau) { return m + (1 - fd_exp(-1.0 / tau)) * (x - m); }
SNN_FN double sigmoid(double x) { return x >= 0 ? 1 / (1 + fd_exp(-x)) : fd_exp(x) / (1 + fd_exp(x)); }
SNN_FN double nmdaGate(double V, double mg) { return 1 / (1 + (mg / 3.57) * fd_exp(-0.062 * V)); }
SNN_FN double toMv(double v, double theta) { return -65 + ((v - 0) / (theta - 0)) * (-50 - -65); }
SNN_FN double sat01(double x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
SNN_FN double gatedUpdate(double w, double plus, double minus, double eta, double gate, double kappa, double wMin, double wMax) {
  double dw = eta * gate * (plus + minus);
  if (dw > kappa) dw = kappa; else if (dw < -kappa) dw = -kappa;
  double v = w + dw;
  return v < wMin ? wMin : v > wMax ? wMax : v;
}
/** a2MinusSlide with the exponent p of 1 (fdlibm pow returns x for y = 1) or 2 (x * x). */
SNN_FN double a2Minus(const SnnP *p, double rhoBar) {
  double r = s_max(0, rhoBar / p->rho0);
  return p->A2minus * (p->tripP == 2 ? r * r : r);
}
SNN_FN void popCode(double x, double lo, double hi, double *o) {
  double step = (hi - lo) / (8 - 1);
  int fin = s_finite(x);
  double v = fin ? s_min(hi, s_max(lo, x)) : x;
  for (int k = 0; k < 8; k++) {
    double c = lo + k * step;
    double z = (v - c) / (0.6 * step);
    o[k] = fin ? fd_exp(-0.5 * (z * z)) : 0;
  }
}
SNN_FN void deltaEnc(double *acc, double dx, double theta, double *up, double *down) {
  double a = *acc + dx;
  double n = floor(fabs(a) / theta);
  *up = 0; *down = 0;
  if (n == 0) { *acc = a; return; }
  *up = a > 0 ? n : 0; *down = a < 0 ? n : 0;
  double sg = a > 0 ? 1 : a < 0 ? -1 : a;
  a -= sg * n * theta;
  *acc = a;
}
SNN_FN void twoSpeed(float *wf, float *ws, double tauC, double eps, double dt) {
  double k = 1 / tauC + eps;
  double d0 = (double)*wf - (double)*ws;
  double e = fd_exp(-k * dt);
  double ws1 = (double)*ws + (eps * d0 * (1 - e)) / k;
  *wf = (float)(ws1 + d0 * e);
  *ws = (float)ws1;
}
SNN_FN double pcPredict(const float *U, const double *r, const double *x, int nx, int nr, double *su, double *st, double *se) {
  double n2 = 0;
  for (int i = 0; i < nx; i++) {
    double v = 0;
    int row = i * nr;
    for (int j = 0; j < nr; j++) v += (double)U[row + j] * r[j];
    su[i] = v;
    double t = fd_tanh(v);
    st[i] = t;
    double e = x[i] - t;
    se[i] = e;
    n2 += e * e;
  }
  return sqrt(n2);
}
SNN_FN void pcUpdate(float *U, double *r, const double *rTd, int nx, int nr, double *st, double *se, double *sfe, double *r0, double *acc,
    double k1, double k2, double sigma2, double sigmaTd2, double lambda, double priorL2, int learnU, double eMax) {
  double s = 0;
  for (int i = 0; i < nx; i++) s += se[i] * se[i];
  double nrm = sqrt(s);
  if (nrm > eMax && nrm > 0) { double k = eMax / nrm; for (int i = 0; i < nx; i++) se[i] *= k; }
  for (int i = 0; i < nx; i++) { double t = st[i]; sfe[i] = (1 - t * t) * se[i]; }
  double a = k1 / sigma2, b = k1 / sigmaTd2;
  for (int j = 0; j < nr; j++) { r0[j] = r[j]; acc[j] = 0; }
  if (learnU) {
    double c = k2 / sigma2, dec = 1 - k2 * lambda;
    for (int i = 0; i < nx; i++) {
      int row = i * nr; double f = sfe[i], g = c * f;
      for (int j = 0; j < nr; j++) { double u = (double)U[row + j]; acc[j] += u * f; U[row + j] = (float)(u * dec + g * r0[j]); }
    }
  } else {
    for (int i = 0; i < nx; i++) { int row = i * nr; double f = sfe[i]; for (int j = 0; j < nr; j++) acc[j] += (double)U[row + j] * f; }
  }
  for (int j = 0; j < nr; j++) {
    double td = b * (rTd[j] - r0[j]);
    r[j] = r0[j] + a * acc[j] + td - (k1 / 2) * (2 * priorL2 * r0[j]);
  }
}

SNN_FN void pcStep(const SnnP *p, Col *c, int frozen) {
  double *sc = c->sc; int *si = c->si;
  const int nL0 = p->nL0, nL1 = p->nL1, nE = p->nE;
  double k2 = p->pcK2 * (1 - p->govDelta * sc[SC_G]);
  double n1 = pcPredict(c->U1, c->z2, c->rate1, nL1, nE, c->s1u, c->s1t, c->s1e);
  double n0 = pcPredict(c->U0, c->z1, c->rate0, nL0, nL1, c->s0u, c->s0t, c->s0e);
  double s = sqrt((n1 * n1 / sc[SC_sigma2_1] + n0 * n0 / sc[SC_sigma2_0]) / (nL1 + nL0));
  sc[SC_surpriseInst] = s;
  double sd = sqrt(sc[SC_errVar]);
  sc[SC_errZ] = sc[SC_errN] > 300 && sd > 1e-9 ? (s - sc[SC_errMean]) / sd : 0;
  sc[SC_errN] += 1;
  double a = 1 - fd_exp(-1 / s_min(p->errZTau, sc[SC_errN]));
  double dm = s - sc[SC_errMean];
  sc[SC_errMean] += a * dm;
  sc[SC_errVar] = (1 - a) * (sc[SC_errVar] + a * dm * dm);
  double e1 = p->pcEMax, e0 = p->pcEMax;
  if (sc[SC_errZ] > 6) {
    double s6 = sc[SC_errMean] + 6 * sd;
    e1 = s_min(e1, s6 * sqrt(sc[SC_sigma2_1] * nL1));
    e0 = s_min(e0, s6 * sqrt(sc[SC_sigma2_0] * nL0));
  }
  sc[SC_zHighRun] = sc[SC_errZ] > 10 ? sc[SC_zHighRun] + 1 : 0;
  if (sc[SC_zHighRun] >= 3) { si[SI_pcFrozen] = 1; sc[SC_pcNormalRun] = 0; }
  if (si[SI_pcFrozen]) { sc[SC_pcNormalRun] = sc[SC_errZ] < 6 ? sc[SC_pcNormalRun] + 1 : 0; if (sc[SC_pcNormalRun] >= 3600) si[SI_pcFrozen] = 0; }
  int learnU = p->pcLearn && !si[SI_pcFrozen] && !frozen;
  pcUpdate(c->U1, c->z2, c->rate2, nL1, nE, c->s1t, c->s1e, c->s1fe, c->s1r0, c->s1acc, p->pcK1, k2, sc[SC_sigma2_1], p->pcSigmaTd2, p->pcLambda, p->pcPriorL2, learnU, e1);
  pcUpdate(c->U0, c->z1, c->rate1, nL0, nL1, c->s0t, c->s0e, c->s0fe, c->s0r0, c->s0acc, p->pcK1, k2, sc[SC_sigma2_0], p->pcSigmaTd2, p->pcLambda, p->pcPriorL2, learnU, e0);
  for (int i = 0; i < nL0; i++) c->err0[i] = c->s0e[i];
  for (int i = 0; i < nL1; i++) {
    double v = 0;
    for (int j = 0; j < nE; j++) v += (double)c->U1[i * nE + j] * c->z2[j];
    c->xhat1[i] = fd_tanh(v);
  }
  sc[SC_surprise] = sc[SC_surprise] != 0 && sc[SC_surprise] == sc[SC_surprise] ? ewma(sc[SC_surprise], s, p->surpriseTau) : s;
  if (learnU) {
    sc[SC_sigma2_1] = s_min(p->pcSigma2Max, s_max(p->pcSigma2Min, ewma(sc[SC_sigma2_1], (n1 * n1) / nL1, p->pcSigmaLearnTau)));
    sc[SC_sigma2_0] = s_min(p->pcSigma2Max, s_max(p->pcSigma2Min, ewma(sc[SC_sigma2_0], (n0 * n0) / nL0, p->pcSigmaLearnTau)));
  }
}

SNN_FN void colStep(const SnnP *p, Col *c, const StepIn *in) {
  double *sc = c->sc; int *si = c->si;
  const int nL0 = p->nL0, nL1 = p->nL1, B = p->B, K = p->K, nE = p->nE, N = p->N;
  double *I0 = c->I0;
  // ---- 1. inputs -> L0 encoder currents
  for (int i = 0; i < nL0; i++) I0[i] = 0;
  sc[SC_lastRetBp] = 0;
  double price = in->price;
  int havePrice = price == price && price != 0 && price > 0;
  if (in->first) {
    if (havePrice && sc[SC_lastSpot] > 0) {
      double dx = p->kindTennis ? price - sc[SC_lastSpot] : 1e4 * fd_log(price / sc[SC_lastSpot]);
      sc[SC_lastRetBp] = p->kindTennis ? 1e4 * dx : dx;
      for (int k = 0; k < p->nThr; k++) {
        double up, down;
        deltaEnc(&c->deltaAcc[k], dx, c->thr[k], &up, &down);
        I0[2 * k] = p->deltaGain * up; I0[2 * k + 1] = p->deltaGain * down;
      }
    }
    if (havePrice) sc[SC_lastSpot] = price;
    if (!p->kindTennis && s_finite(in->mid)) {
      if (s_finite(sc[SC_lastMid])) {
        double up, down;
        deltaEnc(&sc[SC_midAcc], in->mid - sc[SC_lastMid], p->midDelta, &up, &down);
        I0[6] = p->deltaGain * up; I0[7] = p->deltaGain * down;
      }
      sc[SC_lastMid] = in->mid;
    }
  }
  for (int f = 0; f < p->nPop; f++) popCode(in->vals[f], c->popLo[f], c->popHi[f], I0 + 8 + f * 8);
  for (int i = 8; i < nL0; i++) I0[i] *= p->popGain;
  double deltas = 0;
  for (int k = 0; k < 2 * p->nThr; k++) deltas += I0[k] / p->deltaGain;
  sc[SC_deltaFast] = ewma(sc[SC_deltaFast], deltas, 60);
  sc[SC_deltaSlow] = ewma(sc[SC_deltaSlow], deltas, 3600);
  // ---- 2. L0 LIF
  int spk0 = 0;
  for (int i = 0; i < nL0; i++) {
    double v = I0[i] + (c->v0[i] - I0[i]) * p->dL0;
    int s = v >= p->thetaL0 ? 1 : 0;
    if (s) { v = 0; spk0++; }
    c->v0[i] = v; c->s0[i] = (unsigned char)s;
    c->rate0[i] = ewma(c->rate0[i], s, p->tauRateL0);
  }
  // ---- 3. synaptic currents from L0
  for (int i = 0; i < nL0; i++) {
    double s = c->s0[i];
    c->aD0[i] = c->aD0[i] * p->daD + s;
    if (p->synClasses) {
      c->aR0[i] = c->aR0[i] * p->daR + s;
      c->nR0[i] = c->nR0[i] * p->dnR + s; c->nD0[i] = c->nD0[i] * p->dnD + s;
      c->gA0[i] = p->Ka * (c->aD0[i] - c->aR0[i]);
      c->gN0[i] = p->Kn * (c->nD0[i] - c->nR0[i]);
    } else {
      c->gA0[i] = c->aD0[i];
      c->gN0[i] = 0;
    }
  }
  // ---- 4. L1 dendrites and soma
  int spk1 = 0;
  for (int n = 0; n < nL1; n++) {
    double gate = p->synClasses ? nmdaGate(toMv(c->v1[n], p->thetaL1), p->mg) : 0;
    c->gate1[n] = gate;
    double I = 0;
    for (int j = 0; j < B; j++) {
      int nb = n * B + j, base = nb * K;
      double A = 0, Nn = 0;
      for (int k = 0; k < K; k++) { int s = base + k; double w = c->w1[s]; int i = c->src[s]; A += w * c->gA0[i]; Nn += w * c->gN0[i]; }
      double u = A + p->nmdaWeight * gate * Nn - c->theta1[nb];
      c->u1[nb] = u;
      if (p->dendrites) {
        double b = sigmoid(u);
        c->b1[nb] = b;
        c->bbar[nb] = b + (c->bbar[nb] - b) * c->decBranch[j];
      } else {
        c->b1[nb] = u + c->theta1[nb];
        c->bbar[nb] = c->b1[nb];
      }
      I += c->alpha1[nb] * c->bbar[nb];
    }
    I = p->l1Gain * I + (p->pc ? p->feedbackGain * c->xhat1[n] : 0);
    double v = I + (c->v1[n] - I) * p->dL1;
    int s = v >= p->thetaL1 ? 1 : 0;
    if (s) { v = 0; spk1++; }
    c->v1[n] = v; c->s1[n] = (unsigned char)s;
    c->rate1[n] = ewma(c->rate1[n], s, p->tauRateL1);
  }
  // ---- 5. L2/3
  for (int k = 0; k < N; k++) {
    c->aD2[k] *= p->daD; c->gD2[k] *= p->dgD;
    if (p->synClasses) { c->aR2[k] *= p->daR; c->nR2[k] *= p->dnR; c->nD2[k] *= p->dnD; c->gR2[k] *= p->dgR; }
  }
  double gain = 1 - p->govDeltaP * sat01(sc[SC_G]);
  for (int i = 0; i < nL1; i++) {
    if (!c->s1[i]) continue;
    for (int e = c->ffPtr[i]; e < c->ffPtr[i + 1]; e++) {
      int j = c->ffCol[e]; double w = (double)c->ffW[e] * gain;
      c->aD2[j] += w;
      if (p->synClasses) { c->aR2[j] += w; c->nR2[j] += 0.5 * w; c->nD2[j] += 0.5 * w; }
    }
  }
  for (int q = 0; q < si[SI_nPrev]; q++) {
    int i = c->prevSpikes[q];
    for (int e = c->recPtr[i]; e < c->recPtr[i + 1]; e++) {
      int j = c->recCol[e]; double w = c->recW[e];
      if (w >= 0) { c->aD2[j] += w; if (p->synClasses) c->aR2[j] += w; }
      else { c->gD2[j] -= w; if (p->synClasses) c->gR2[j] -= w; }
    }
  }
  double excSum = 0, inhSum = 0; int spkE = 0, spkI = 0;
  si[SI_nPrev] = 0;
  for (int k = 0; k < N; k++) {
    int isE = k < nE;
    double Iexc = p->Ka * (c->aD2[k] - (p->synClasses ? c->aR2[k] : 0));
    if (p->synClasses) {
      double theta = isE ? p->thetaE : p->thetaI;
      Iexc += nmdaGate(toMv(c->v2[k], theta), p->mg) * p->Kn * (c->nD2[k] - c->nR2[k]);
    }
    double Iinh = p->Kg * (c->gD2[k] - (p->synClasses ? c->gR2[k] : 0));
    double I = Iexc - Iinh;
    if (isE) { excSum += Iexc; inhSum += Iinh; if (p->lateral) I -= in->latInh; }
    else if (p->gapJunctions && in->gapV) I += p->gapCoupling * (in->gapV[k - nE] - c->v2[k]);
    double v = I + (c->v2[k] - I) * (isE ? p->dE : p->dI);
    double th = isE ? (p->alif ? c->theta0E[k] + p->betaA * c->a2[k] : c->theta0E[k]) : c->theta0I[k - nE];
    int s = v >= th ? 1 : 0;
    if (s) { v = 0; c->prevSpikes[si[SI_nPrev]++] = k; if (isE) spkE++; else spkI++; }
    c->v2[k] = v; c->s2[k] = (unsigned char)s;
    if (isE) c->a2[k] = c->a2[k] * p->dA + s;
    c->rate2[k] = ewma(c->rate2[k], s, p->tauRateL23);
  }
  sc[SC_rateL0] = ewma(sc[SC_rateL0], (double)spk0 / nL0, 300); sc[SC_rateL1] = ewma(sc[SC_rateL1], (double)spk1 / nL1, 300);
  sc[SC_rateE] = ewma(sc[SC_rateE], (double)spkE / nE, 300); sc[SC_rateI] = ewma(sc[SC_rateI], (double)spkI / (N - nE), 300);
  sc[SC_exc] = ewma(sc[SC_exc], excSum / nE, 300); sc[SC_inh] = ewma(sc[SC_inh], inhSum / nE, 300);
  // ---- intrinsic threshold homeostasis
  if (p->ipLow != 0 && ++si[SI_ipCount] >= 60) {
    si[SI_ipCount] = 0;
    double f = sc[SC_rateE] < p->ipLow ? 1 - p->ipStep : p->ipHigh != 0 && sc[SC_rateE] > p->ipHigh ? 1 + p->ipStep : 1;
    if (f != 1) { double lo = p->ipMin * p->thetaE; for (int k = 0; k < nE; k++) c->theta0E[k] = s_max(lo, s_min(p->thetaE, c->theta0E[k] * f)); }
    double g = sc[SC_rateI] < p->ipLow ? 1 - p->ipStep : p->ipHigh != 0 && sc[SC_rateI] > p->ipHigh ? 1 + p->ipStep : 1;
    if (g != 1) { double lo = p->ipMin * p->thetaI; for (int k = 0; k < N - nE; k++) c->theta0I[k] = s_max(lo, s_min(p->thetaI, c->theta0I[k] * g)); }
  }
  // ---- 6. traces and plasticity
  int learn = p->plasticity && !in->frozen;
  for (int i = 0; i < nL0; i++) c->preR1[i] = c->preR1[i] * p->dtp + c->s0[i];
  for (int n = 0; n < nL1; n++) { c->postO1[n] *= p->dtm; c->postO2[n] *= p->dty; }
  for (int i = 0; i < nE; i++) c->preRE[i] = c->preRE[i] * p->dtp + c->s2[i];
  for (int n = 0; n < nE; n++) { c->postO1E[n] *= p->dtm; c->postO2E[n] *= p->dty; }
  if (learn) {
    double eta = p->eta * (1 - p->govDelta * sat01(sc[SC_G]));
    for (int n = 0; n < nL1; n++) {
      if (!c->s1[n]) continue;
      double g = c->gate1[n], o2 = c->postO2[n];
      for (int s = n * B * K, e = s + B * K; s < e; s++) c->w1[s] = (float)gatedUpdate(c->w1[s], p->A3plus * c->preR1[c->src[s]] * o2, 0, eta, g, p->kappa, p->wMin, p->wMax);
    }
    for (int i = 0; i < nL0; i++) {
      if (!c->s0[i]) continue;
      for (int q = c->revPtr[i]; q < c->revPtr[i + 1]; q++) {
        int s = c->revSyn[q], n = s / (B * K);
        c->w1[s] = (float)gatedUpdate(c->w1[s], 0, -a2Minus(p, c->rho1[n]) * c->postO1[n], eta, c->gate1[n], p->kappa, p->wMin, p->wMax);
      }
    }
    for (int j = 0; j < nE; j++) {
      if (!c->s2[j]) continue;
      double g = nmdaGate(toMv(p->thetaE, p->thetaE), p->mg);
      for (int q = c->inPtr[j]; q < c->inPtr[j + 1]; q++) {
        int e = c->inEdge[q];
        c->recW[e] = (float)gatedUpdate(c->recW[e], p->A3plus * c->preRE[c->inPre[q]] * c->postO2E[j], 0, eta, g, p->kappa, 0, p->wMax);
      }
    }
    for (int i = 0; i < nE; i++) {
      if (!c->s2[i]) continue;
      for (int e = c->recPtr[i]; e < c->recPtr[i + 1]; e++) {
        int j = c->recCol[e];
        if (j >= nE) continue;
        double g = nmdaGate(toMv(c->v2[j], p->thetaE), p->mg);
        c->recW[e] = (float)gatedUpdate(c->recW[e], 0, -a2Minus(p, c->rhoE[j]) * c->postO1E[j], eta, g, p->kappa, 0, p->wMax);
      }
    }
  }
  for (int n = 0; n < nL1; n++) { c->postO1[n] += c->s1[n]; c->postO2[n] += c->s1[n]; c->rho1[n] = ewma(c->rho1[n], c->s1[n], p->tauRho); }
  for (int n = 0; n < nE; n++) { c->postO1E[n] += c->s2[n]; c->postO2E[n] += c->s2[n]; c->rhoE[n] = ewma(c->rhoE[n], c->s2[n], p->tauRho); }
  if (++si[SI_stepsSinceSlow] >= p->slowEverySec) {
    double dt = si[SI_stepsSinceSlow];
    si[SI_stepsSinceSlow] = 0;
    int sat = 0, tot = 0;
    if (p->plasticity) {
      for (int s = 0; s < p->nSyn; s++) twoSpeed(&c->w1[s], &c->w1s[s], p->tauC, p->eps, dt);
      for (int i = 0; i < nE; i++) for (int e = c->recPtr[i]; e < c->recPtr[i + 1]; e++) {
        if (c->recCol[e] >= nE) continue;
        twoSpeed(&c->recW[e], &c->recWs[e], p->tauC, p->eps, dt);
      }
    }
    for (int s = 0; s < p->nSyn; s++) { tot++; if (c->w1[s] <= p->wMin + 1e-6 || c->w1[s] >= p->wMax - 1e-6) sat++; }
    for (int i = 0; i < nE; i++) for (int e = c->recPtr[i]; e < c->recPtr[i + 1]; e++) {
      if (c->recCol[e] >= nE) continue;
      tot++; if (c->recW[e] <= 1e-9 || c->recW[e] >= p->wMax - 1e-6) sat++;
    }
    sc[SC_fSat] = tot ? (double)sat / tot : 0;
  }
  // ---- 7. governor
  double rhoHat = in->refRateE > 0 ? s_max(0, sc[SC_rateE] / in->refRateE - 1) : 0;
  {
    double zE = s_max(0, sc[SC_errZ]);
    double u = sat01(p->govK0 * rhoHat + p->govK1 * zE + p->govK2 * sc[SC_fSat] + p->govK3 * in->dBrier);
    sc[SC_G] = sat01(u + (sc[SC_G] - u) * fd_exp(-1.0 / p->tauG));
  }
  // ---- 8. predictive coding
  if (p->pc) pcStep(p, c, in->frozen);
}

/** Column.resetTransient: voltages, traces and encoders to zero after a long gap; weights kept. */
SNN_FN void colReset(const SnnP *p, Col *c) {
  const int nL0 = p->nL0, nL1 = p->nL1, nb = p->nL1 * p->B, nE = p->nE, N = p->N;
  for (int i = 0; i < nL0; i++) { c->v0[i] = 0; c->s0[i] = 0; c->rate0[i] = 0; c->aR0[i] = 0; c->aD0[i] = 0; c->nR0[i] = 0; c->nD0[i] = 0; c->preR1[i] = 0; c->err0[i] = 0; }
  for (int k = 0; k < p->nThr; k++) c->deltaAcc[k] = 0;
  for (int i = 0; i < nb; i++) c->bbar[i] = 0;
  for (int i = 0; i < nL1; i++) { c->v1[i] = 0; c->s1[i] = 0; c->postO1[i] = 0; c->postO2[i] = 0; c->z1[i] = 0; c->xhat1[i] = 0; }
  for (int k = 0; k < N; k++) { c->v2[k] = 0; c->s2[k] = 0; c->aR2[k] = 0; c->aD2[k] = 0; c->nR2[k] = 0; c->nD2[k] = 0; c->gR2[k] = 0; c->gD2[k] = 0; }
  for (int k = 0; k < nE; k++) { c->a2[k] = 0; c->preRE[k] = 0; c->postO1E[k] = 0; c->postO2E[k] = 0; c->z2[k] = 0; }
  c->sc[SC_midAcc] = 0; c->sc[SC_lastSpot] = 0; c->sc[SC_lastMid] = SNN_DBL(0x7FF8000000000000ull); /* JS NaN */ c->si[SI_nPrev] = 0;
}

#ifdef __CUDACC__
/** Every member x column (thread t: params[pIdx[t]], cols[t], inputs of column colOf[t]) runs `rounds` rounds of the
 *  recorded calls: ins[r * nCols + colOf[t]] is that column's call in round r. Members share their column's inputs. */
extern "C" __global__ void snn_columns_run(const SnnP *params, const int *pIdx, Col *cols, const StepIn *ins, const int *colOf, int n, int nCols, int r0, int rounds) {
  int t = blockIdx.x * blockDim.x + threadIdx.x;
  if (t >= n) return;
  SnnP p = params[pIdx[t]];
  Col c = cols[t];
  for (int r = r0; r < r0 + rounds; r++) {
    const StepIn *in = &ins[(size_t)r * nCols + colOf[t]];
    if (in->kind == 1) colStep(&p, &c, in);
    else if (in->kind == 2) colReset(&p, &c);
  }
}
#endif

#if !defined(__CUDACC__) && !defined(__wasm__)
/** The batch kernel's loop on the CPU (python/snn/bench.py --cpu, the test of the GPU path's data layout). */
void snn_columns_run_cpu(const SnnP *params, const int *pIdx, Col *cols, const StepIn *ins, const int *colOf, int n, int nCols, int r0, int rounds) {
  for (int t = 0; t < n; t++) {
    SnnP p = params[pIdx[t]];
    Col c = cols[t];
    for (int r = r0; r < r0 + rounds; r++) {
      const StepIn *in = &ins[(size_t)r * nCols + colOf[t]];
      if (in->kind == 1) colStep(&p, &c, in);
      else if (in->kind == 2) colReset(&p, &c);
    }
  }
}
#endif

#ifdef __wasm__
/** The live and training networks' column step in WebAssembly (bot/snn/kernel.ts). */
__attribute__((export_name("col_step"))) void col_step(const SnnP *p, Col *c, const StepIn *in) { colStep(p, c, in); }
__attribute__((export_name("col_reset"))) void col_reset(const SnnP *p, Col *c) { colReset(p, c); }
#endif

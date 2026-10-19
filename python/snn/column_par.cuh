// The SNN column step for a team of threads: one CUDA thread block per member x column (python/snn/bench.py), every
// neuron, dendritic branch, synapse and predictive-coding row of the column on its own thread, and still the
// TypeScript network's bits. Include after column.cu (it reuses its types and helpers; column.cu itself, the live
// WebAssembly kernel, is untouched).
//
// What keeps it exact:
//   - every value is computed by the same operations in the same order as colStep (column.cu); only independent
//     work is spread over the threads;
//   - sums whose order matters (the excitatory drive, the prediction errors' norms, spike counts) are taken by thread
//     0 in the original order; dot products stay on one thread each, in the original order;
//   - the synaptic scatters (each spiking source adding to its targets) become gathers (each target adding its
//     spiking sources), over the sources in the order the scatter visited them, so every target's accumulator sees
//     the same additions in the same order; the transposed indexes are built once per launch;
//   - the decay constants of the running averages (1 - exp(-1/tau)) are taken once: the same expression, so the
//     same bits, without an exp per neuron per step.
// The CPU twin (par_cpu.c) runs the same code on POSIX threads with barriers, for the parity check without a GPU.

typedef struct { int tid, T; void *bar; } Tc;

#ifdef __CUDACC__
SNN_FN void pbar(Tc *tc) { (void)tc; __syncthreads(); }
#else
static void par_barrier_wait(void *b);
SNN_FN void pbar(Tc *tc) { par_barrier_wait(tc->bar); }
#endif
#define PFOR(i, n) for (int i = tc->tid; i < (n); i += tc->T)
#define ONE if (tc->tid == 0)

/** Per-block scratch: the transposed synapse indexes, the per-neuron drives, spike flags, partial counts. */
typedef struct { int *ffTPtr, *ffTSrc, *ffTEdge, *recTPtr, *recTSrc, *recTEdge, *tmp, *cnt; double *iexc, *iinh; unsigned char *flag; } ParScr;

/** Scratch bytes for one block (python/snn/bench.py and par_cpu.c allocate it; keep the two formulas the same). */
SNN_FN size_t parScrBytes(int N, int nFF, int nRec, int T) {
  size_t o = 0;
#define PAR_SZ(cnt, sz) o += (((size_t)(cnt) * (sz)) + 15) & ~(size_t)15;
  PAR_SZ(N, 8) PAR_SZ(N, 8) PAR_SZ(N + 1, 4) PAR_SZ(nFF, 4) PAR_SZ(nFF, 4) PAR_SZ(N + 1, 4) PAR_SZ(nRec, 4) PAR_SZ(nRec, 4) PAR_SZ(N, 4) PAR_SZ(2 * T, 4) PAR_SZ(N, 1)
#undef PAR_SZ
  return o;
}
SNN_FN void parCarve(ParScr *x, char *base, int N, int nFF, int nRec, int T) {
  size_t o = 0;
#define PAR_TAKE(f, type, cnt) x->f = (type *)(base + o); o += (((size_t)(cnt) * sizeof(type)) + 15) & ~(size_t)15;
  PAR_TAKE(iexc, double, N) PAR_TAKE(iinh, double, N) PAR_TAKE(ffTPtr, int, N + 1) PAR_TAKE(ffTSrc, int, nFF) PAR_TAKE(ffTEdge, int, nFF)
  PAR_TAKE(recTPtr, int, N + 1) PAR_TAKE(recTSrc, int, nRec) PAR_TAKE(recTEdge, int, nRec) PAR_TAKE(tmp, int, N) PAR_TAKE(cnt, int, 2 * T) PAR_TAKE(flag, unsigned char, N)
#undef PAR_TAKE
}

/** Shared by the team: the decay constants, and the scalars thread 0 hands to the others within a step. */
typedef struct {
  double kL0, kL1, kL23, k60, k3600, k300, kRho, kSur, kSig, gNmdaE;
  double n1, n0, s, e1, e0, clip, dt;
  int learnU, doClip, doSlow, pad_;
} ParSh;

SNN_FN double ewk(double m, double x, double k) { return m + k * (x - m); }
SNN_FN double kOf(double tau) { return 1 - fd_exp(-1.0 / tau); }

/** CSR (by source) -> CSC (by target), the sources and edges of each target in the order the CSR visits them. */
SNN_FN void parTranspose(int nSrc, int nTgt, const int *ptr, const int *col, int *tPtr, int *tSrc, int *tEdge, int *tmp) {
  for (int j = 0; j <= nTgt; j++) tPtr[j] = 0;
  for (int e = 0; e < ptr[nSrc]; e++) tPtr[col[e] + 1]++;
  for (int j = 0; j < nTgt; j++) { tPtr[j + 1] += tPtr[j]; tmp[j] = tPtr[j]; }
  for (int i = 0; i < nSrc; i++) for (int e = ptr[i]; e < ptr[i + 1]; e++) { int q = tmp[col[e]]++; tSrc[q] = i; tEdge[q] = e; }
}

/** Thread 0, once per launch: the constants and the transposed indexes. */
SNN_FN void parSetup(const SnnP *p, const Col *c, ParSh *S, ParScr *x) {
  S->kL0 = kOf(p->tauRateL0); S->kL1 = kOf(p->tauRateL1); S->kL23 = kOf(p->tauRateL23);
  S->k60 = kOf(60); S->k3600 = kOf(3600); S->k300 = kOf(300); S->kRho = kOf(p->tauRho); S->kSur = kOf(p->surpriseTau); S->kSig = kOf(p->pcSigmaLearnTau);
  S->gNmdaE = nmdaGate(toMv(p->thetaE, p->thetaE), p->mg);
  parTranspose(p->nL1, p->N, c->ffPtr, c->ffCol, x->ffTPtr, x->ffTSrc, x->ffTEdge, x->tmp);
  parTranspose(p->N, p->N, c->recPtr, c->recCol, x->recTPtr, x->recTSrc, x->recTEdge, x->tmp);
}

SNN_FN void pcUpdatePar(float *U, double *r, const double *rTd, int nx, int nr, double *st, double *se, double *sfe, double *r0, double *acc,
    double k1, double k2, double sigma2, double sigmaTd2, double lambda, double priorL2, int learnU, double eMax, ParSh *S, Tc *tc) {
  ONE {
    double s = 0;
    for (int i = 0; i < nx; i++) s += se[i] * se[i];
    double nrm = sqrt(s);
    S->doClip = nrm > eMax && nrm > 0;
    S->clip = S->doClip ? eMax / nrm : 1;
  }
  pbar(tc);
  PFOR(i, nx) { if (S->doClip) se[i] *= S->clip; double t = st[i]; sfe[i] = (1 - t * t) * se[i]; }
  PFOR(j, nr) { r0[j] = r[j]; acc[j] = 0; }
  pbar(tc);
  double a = k1 / sigma2, b = k1 / sigmaTd2;
  if (learnU) {
    double c = k2 / sigma2, dec = 1 - k2 * lambda;
    PFOR(j, nr) {
      double aj = acc[j], rj = r0[j];
      for (int i = 0; i < nx; i++) { int q = i * nr + j; double f = sfe[i], g = c * f; double u = (double)U[q]; aj += u * f; U[q] = (float)(u * dec + g * rj); }
      acc[j] = aj;
    }
  } else {
    PFOR(j, nr) { double aj = acc[j]; for (int i = 0; i < nx; i++) aj += (double)U[i * nr + j] * sfe[i]; acc[j] = aj; }
  }
  PFOR(j, nr) {
    double td = b * (rTd[j] - r0[j]);
    r[j] = r0[j] + a * acc[j] + td - (k1 / 2) * (2 * priorL2 * r0[j]);
  }
  pbar(tc);
}

SNN_FN void pcStepPar(const SnnP *p, Col *c, int frozen, ParSh *S, Tc *tc) {
  double *sc = c->sc; int *si = c->si;
  const int nL0 = p->nL0, nL1 = p->nL1, nE = p->nE;
  double k2 = p->pcK2 * (1 - p->govDelta * sc[SC_G]);
  PFOR(i, nL1) {
    double v = 0; int row = i * nE;
    for (int j = 0; j < nE; j++) v += (double)c->U1[row + j] * c->z2[j];
    c->s1u[i] = v; double t = fd_tanh(v); c->s1t[i] = t; c->s1e[i] = c->rate1[i] - t;
  }
  PFOR(i, nL0) {
    double v = 0; int row = i * nL1;
    for (int j = 0; j < nL1; j++) v += (double)c->U0[row + j] * c->z1[j];
    c->s0u[i] = v; double t = fd_tanh(v); c->s0t[i] = t; c->s0e[i] = c->rate0[i] - t;
  }
  pbar(tc);
  ONE {
    double q1 = 0, q0 = 0;
    for (int i = 0; i < nL1; i++) q1 += c->s1e[i] * c->s1e[i];
    for (int i = 0; i < nL0; i++) q0 += c->s0e[i] * c->s0e[i];
    double n1 = sqrt(q1), n0 = sqrt(q0);
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
    S->learnU = p->pcLearn && !si[SI_pcFrozen] && !frozen;
    S->n1 = n1; S->n0 = n0; S->s = s; S->e1 = e1; S->e0 = e0;
  }
  pbar(tc);
  double sig1 = sc[SC_sigma2_1], sig0 = sc[SC_sigma2_0];
  int learnU = S->learnU;
  double e1 = S->e1, e0 = S->e0;
  pcUpdatePar(c->U1, c->z2, c->rate2, nL1, nE, c->s1t, c->s1e, c->s1fe, c->s1r0, c->s1acc, p->pcK1, k2, sig1, p->pcSigmaTd2, p->pcLambda, p->pcPriorL2, learnU, e1, S, tc);
  pcUpdatePar(c->U0, c->z1, c->rate1, nL0, nL1, c->s0t, c->s0e, c->s0fe, c->s0r0, c->s0acc, p->pcK1, k2, sig0, p->pcSigmaTd2, p->pcLambda, p->pcPriorL2, learnU, e0, S, tc);
  PFOR(i, nL0) c->err0[i] = c->s0e[i];
  PFOR(i, nL1) {
    double v = 0;
    for (int j = 0; j < nE; j++) v += (double)c->U1[i * nE + j] * c->z2[j];
    c->xhat1[i] = fd_tanh(v);
  }
  ONE {
    double s = S->s, n1 = S->n1, n0 = S->n0;
    sc[SC_surprise] = sc[SC_surprise] != 0 && sc[SC_surprise] == sc[SC_surprise] ? ewk(sc[SC_surprise], s, S->kSur) : s;
    if (learnU) {
      sc[SC_sigma2_1] = s_min(p->pcSigma2Max, s_max(p->pcSigma2Min, ewk(sc[SC_sigma2_1], (n1 * n1) / nL1, S->kSig)));
      sc[SC_sigma2_0] = s_min(p->pcSigma2Max, s_max(p->pcSigma2Min, ewk(sc[SC_sigma2_0], (n0 * n0) / nL0, S->kSig)));
    }
  }
}

SNN_FN void colStepPar(const SnnP *p, Col *c, const StepIn *in, ParSh *S, ParScr *x, Tc *tc) {
  double *sc = c->sc; int *si = c->si;
  const int nL0 = p->nL0, nL1 = p->nL1, B = p->B, K = p->K, nE = p->nE, N = p->N, nb1 = p->nL1 * p->B, nsyn1 = p->nL1 * p->B * p->K;
  double *I0 = c->I0;
  // ---- 1. inputs -> L0 encoder currents (and the previous step's L2/3 spikes as flags, for the recurrent gather)
  PFOR(i, nL0) I0[i] = 0;
  PFOR(k, N) x->flag[k] = 0;
  pbar(tc);
  PFOR(q, si[SI_nPrev]) x->flag[c->prevSpikes[q]] = 1;
  ONE {
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
  }
  PFOR(f, p->nPop) popCode(in->vals[f], c->popLo[f], c->popHi[f], I0 + 8 + f * 8);
  pbar(tc);
  PFOR(q, nL0 - 8) I0[8 + q] *= p->popGain;
  pbar(tc);
  ONE {
    double deltas = 0;
    for (int k = 0; k < 2 * p->nThr; k++) deltas += I0[k] / p->deltaGain;
    sc[SC_deltaFast] = ewk(sc[SC_deltaFast], deltas, S->k60);
    sc[SC_deltaSlow] = ewk(sc[SC_deltaSlow], deltas, S->k3600);
  }
  // ---- 2./3. L0 LIF and its synaptic currents
  PFOR(i, nL0) {
    double v = I0[i] + (c->v0[i] - I0[i]) * p->dL0;
    int s = v >= p->thetaL0 ? 1 : 0;
    if (s) v = 0;
    c->v0[i] = v; c->s0[i] = (unsigned char)s;
    c->rate0[i] = ewk(c->rate0[i], s, S->kL0);
    double sd = s;
    c->aD0[i] = c->aD0[i] * p->daD + sd;
    if (p->synClasses) {
      c->aR0[i] = c->aR0[i] * p->daR + sd;
      c->nR0[i] = c->nR0[i] * p->dnR + sd; c->nD0[i] = c->nD0[i] * p->dnD + sd;
      c->gA0[i] = p->Ka * (c->aD0[i] - c->aR0[i]);
      c->gN0[i] = p->Kn * (c->nD0[i] - c->nR0[i]);
    } else {
      c->gA0[i] = c->aD0[i];
      c->gN0[i] = 0;
    }
  }
  PFOR(n, nL1) c->gate1[n] = p->synClasses ? nmdaGate(toMv(c->v1[n], p->thetaL1), p->mg) : 0;
  pbar(tc);
  // ---- 4. L1 dendritic branches (each on its own thread), then somata
  PFOR(nb, nb1) {
    int n = nb / B, j = nb - n * B, base = nb * K;
    double gate = c->gate1[n];
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
  }
  pbar(tc);
  PFOR(n, nL1) {
    double I = 0;
    for (int j = 0; j < B; j++) { int nb = n * B + j; I += c->alpha1[nb] * c->bbar[nb]; }
    I = p->l1Gain * I + (p->pc ? p->feedbackGain * c->xhat1[n] : 0);
    double v = I + (c->v1[n] - I) * p->dL1;
    int s = v >= p->thetaL1 ? 1 : 0;
    if (s) v = 0;
    c->v1[n] = v; c->s1[n] = (unsigned char)s;
    c->rate1[n] = ewk(c->rate1[n], s, S->kL1);
  }
  pbar(tc);
  // ---- 5. L2/3: decay, then each neuron gathers its spiking feedforward and recurrent sources
  double gain = 1 - p->govDeltaP * sat01(sc[SC_G]);
  PFOR(k, N) {
    c->aD2[k] *= p->daD; c->gD2[k] *= p->dgD;
    if (p->synClasses) { c->aR2[k] *= p->daR; c->nR2[k] *= p->dnR; c->nD2[k] *= p->dnD; c->gR2[k] *= p->dgR; }
    for (int q = x->ffTPtr[k]; q < x->ffTPtr[k + 1]; q++) {
      if (!c->s1[x->ffTSrc[q]]) continue;
      double w = (double)c->ffW[x->ffTEdge[q]] * gain;
      c->aD2[k] += w;
      if (p->synClasses) { c->aR2[k] += w; c->nR2[k] += 0.5 * w; c->nD2[k] += 0.5 * w; }
    }
    for (int q = x->recTPtr[k]; q < x->recTPtr[k + 1]; q++) {
      if (!x->flag[x->recTSrc[q]]) continue;
      double w = c->recW[x->recTEdge[q]];
      if (w >= 0) { c->aD2[k] += w; if (p->synClasses) c->aR2[k] += w; }
      else { c->gD2[k] -= w; if (p->synClasses) c->gR2[k] -= w; }
    }
  }
  PFOR(k, N) {
    int isE = k < nE;
    double Iexc = p->Ka * (c->aD2[k] - (p->synClasses ? c->aR2[k] : 0));
    if (p->synClasses) {
      double theta = isE ? p->thetaE : p->thetaI;
      Iexc += nmdaGate(toMv(c->v2[k], theta), p->mg) * p->Kn * (c->nD2[k] - c->nR2[k]);
    }
    double Iinh = p->Kg * (c->gD2[k] - (p->synClasses ? c->gR2[k] : 0));
    double I = Iexc - Iinh;
    x->iexc[k] = Iexc; x->iinh[k] = Iinh;
    if (isE) { if (p->lateral) I -= in->latInh; }
    else if (p->gapJunctions && in->gapV) I += p->gapCoupling * (in->gapV[k - nE] - c->v2[k]);
    double v = I + (c->v2[k] - I) * (isE ? p->dE : p->dI);
    double th = isE ? (p->alif ? c->theta0E[k] + p->betaA * c->a2[k] : c->theta0E[k]) : c->theta0I[k - nE];
    int s = v >= th ? 1 : 0;
    if (s) v = 0;
    c->v2[k] = v; c->s2[k] = (unsigned char)s;
    if (isE) c->a2[k] = c->a2[k] * p->dA + s;
    c->rate2[k] = ewk(c->rate2[k], s, S->kL23);
  }
  pbar(tc);
  ONE {
    int spk0 = 0, spk1 = 0, spkE = 0, spkI = 0, np = 0;
    double excSum = 0, inhSum = 0;
    for (int i = 0; i < nL0; i++) spk0 += c->s0[i];
    for (int i = 0; i < nL1; i++) spk1 += c->s1[i];
    for (int k = 0; k < N; k++) {
      if (k < nE) { excSum += x->iexc[k]; inhSum += x->iinh[k]; }
      if (c->s2[k]) { c->prevSpikes[np++] = k; if (k < nE) spkE++; else spkI++; }
    }
    si[SI_nPrev] = np;
    sc[SC_rateL0] = ewk(sc[SC_rateL0], (double)spk0 / nL0, S->k300); sc[SC_rateL1] = ewk(sc[SC_rateL1], (double)spk1 / nL1, S->k300);
    sc[SC_rateE] = ewk(sc[SC_rateE], (double)spkE / nE, S->k300); sc[SC_rateI] = ewk(sc[SC_rateI], (double)spkI / (N - nE), S->k300);
    sc[SC_exc] = ewk(sc[SC_exc], excSum / nE, S->k300); sc[SC_inh] = ewk(sc[SC_inh], inhSum / nE, S->k300);
    if (p->ipLow != 0 && ++si[SI_ipCount] >= 60) {
      si[SI_ipCount] = 0;
      double f = sc[SC_rateE] < p->ipLow ? 1 - p->ipStep : p->ipHigh != 0 && sc[SC_rateE] > p->ipHigh ? 1 + p->ipStep : 1;
      if (f != 1) { double lo = p->ipMin * p->thetaE; for (int k = 0; k < nE; k++) c->theta0E[k] = s_max(lo, s_min(p->thetaE, c->theta0E[k] * f)); }
      double g = sc[SC_rateI] < p->ipLow ? 1 - p->ipStep : p->ipHigh != 0 && sc[SC_rateI] > p->ipHigh ? 1 + p->ipStep : 1;
      if (g != 1) { double lo = p->ipMin * p->thetaI; for (int k = 0; k < N - nE; k++) c->theta0I[k] = s_max(lo, s_min(p->thetaI, c->theta0I[k] * g)); }
    }
  }
  // ---- 6. traces and plasticity
  int learn = p->plasticity && !in->frozen;
  PFOR(i, nL0) c->preR1[i] = c->preR1[i] * p->dtp + c->s0[i];
  PFOR(n, nL1) { c->postO1[n] *= p->dtm; c->postO2[n] *= p->dty; }
  PFOR(i, nE) { c->preRE[i] = c->preRE[i] * p->dtp + c->s2[i]; c->postO1E[i] *= p->dtm; c->postO2E[i] *= p->dty; }
  pbar(tc);
  if (learn) {
    double eta = p->eta * (1 - p->govDelta * sat01(sc[SC_G]));
    PFOR(s, nsyn1) {
      int n = s / (B * K);
      if (!c->s1[n]) continue;
      c->w1[s] = (float)gatedUpdate(c->w1[s], p->A3plus * c->preR1[c->src[s]] * c->postO2[n], 0, eta, c->gate1[n], p->kappa, p->wMin, p->wMax);
    }
    pbar(tc);
    // Each synapse whose source spiked (column.cu walks them source by source through revPtr/revSyn: each once).
    PFOR(s, nsyn1) {
      if (!c->s0[c->src[s]]) continue;
      int n = s / (B * K);
      c->w1[s] = (float)gatedUpdate(c->w1[s], 0, -a2Minus(p, c->rho1[n]) * c->postO1[n], eta, c->gate1[n], p->kappa, p->wMin, p->wMax);
    }
    PFOR(j, nE) {
      if (!c->s2[j]) continue;
      for (int q = c->inPtr[j]; q < c->inPtr[j + 1]; q++) {
        int e = c->inEdge[q];
        c->recW[e] = (float)gatedUpdate(c->recW[e], p->A3plus * c->preRE[c->inPre[q]] * c->postO2E[j], 0, eta, S->gNmdaE, p->kappa, 0, p->wMax);
      }
    }
    pbar(tc);
    PFOR(i, nE) {
      if (!c->s2[i]) continue;
      for (int e = c->recPtr[i]; e < c->recPtr[i + 1]; e++) {
        int j = c->recCol[e];
        if (j >= nE) continue;
        double g = nmdaGate(toMv(c->v2[j], p->thetaE), p->mg);
        c->recW[e] = (float)gatedUpdate(c->recW[e], 0, -a2Minus(p, c->rhoE[j]) * c->postO1E[j], eta, g, p->kappa, 0, p->wMax);
      }
    }
    pbar(tc);
  }
  PFOR(n, nL1) { c->postO1[n] += c->s1[n]; c->postO2[n] += c->s1[n]; c->rho1[n] = ewk(c->rho1[n], c->s1[n], S->kRho); }
  PFOR(n, nE) { c->postO1E[n] += c->s2[n]; c->postO2E[n] += c->s2[n]; c->rhoE[n] = ewk(c->rhoE[n], c->s2[n], S->kRho); }
  ONE {
    S->doSlow = ++si[SI_stepsSinceSlow] >= p->slowEverySec;
    if (S->doSlow) { S->dt = si[SI_stepsSinceSlow]; si[SI_stepsSinceSlow] = 0; }
  }
  pbar(tc);
  if (S->doSlow) {
    double dt = S->dt;
    if (p->plasticity) {
      PFOR(s, p->nSyn) twoSpeed(&c->w1[s], &c->w1s[s], p->tauC, p->eps, dt);
      PFOR(i, nE) for (int e = c->recPtr[i]; e < c->recPtr[i + 1]; e++) {
        if (c->recCol[e] >= nE) continue;
        twoSpeed(&c->recW[e], &c->recWs[e], p->tauC, p->eps, dt);
      }
    }
    pbar(tc);
    int sat = 0, tot = 0;
    PFOR(s, p->nSyn) { tot++; if (c->w1[s] <= p->wMin + 1e-6 || c->w1[s] >= p->wMax - 1e-6) sat++; }
    PFOR(i, nE) for (int e = c->recPtr[i]; e < c->recPtr[i + 1]; e++) {
      if (c->recCol[e] >= nE) continue;
      tot++; if (c->recW[e] <= 1e-9 || c->recW[e] >= p->wMax - 1e-6) sat++;
    }
    x->cnt[2 * tc->tid] = sat; x->cnt[2 * tc->tid + 1] = tot;
    pbar(tc);
    ONE {
      int sa = 0, to = 0;
      for (int t = 0; t < tc->T; t++) { sa += x->cnt[2 * t]; to += x->cnt[2 * t + 1]; }
      sc[SC_fSat] = to ? (double)sa / to : 0;
    }
  }
  // ---- 7. governor
  ONE {
    double rhoHat = in->refRateE > 0 ? s_max(0, sc[SC_rateE] / in->refRateE - 1) : 0;
    double zE = s_max(0, sc[SC_errZ]);
    double u = sat01(p->govK0 * rhoHat + p->govK1 * zE + p->govK2 * sc[SC_fSat] + p->govK3 * in->dBrier);
    sc[SC_G] = sat01(u + (sc[SC_G] - u) * fd_exp(-1.0 / p->tauG));
  }
  pbar(tc);
  // ---- 8. predictive coding
  if (p->pc) pcStepPar(p, c, in->frozen, S, tc);
  pbar(tc);
}

SNN_FN void colResetPar(const SnnP *p, Col *c, Tc *tc) {
  const int nL0 = p->nL0, nL1 = p->nL1, nb = p->nL1 * p->B, nE = p->nE, N = p->N;
  PFOR(i, nL0) { c->v0[i] = 0; c->s0[i] = 0; c->rate0[i] = 0; c->aR0[i] = 0; c->aD0[i] = 0; c->nR0[i] = 0; c->nD0[i] = 0; c->preR1[i] = 0; c->err0[i] = 0; }
  PFOR(k, p->nThr) c->deltaAcc[k] = 0;
  PFOR(i, nb) c->bbar[i] = 0;
  PFOR(i, nL1) { c->v1[i] = 0; c->s1[i] = 0; c->postO1[i] = 0; c->postO2[i] = 0; c->z1[i] = 0; c->xhat1[i] = 0; }
  PFOR(k, N) { c->v2[k] = 0; c->s2[k] = 0; c->aR2[k] = 0; c->aD2[k] = 0; c->nR2[k] = 0; c->nD2[k] = 0; c->gR2[k] = 0; c->gD2[k] = 0; }
  PFOR(k, nE) { c->a2[k] = 0; c->preRE[k] = 0; c->postO1E[k] = 0; c->postO2E[k] = 0; c->z2[k] = 0; }
  ONE { c->sc[SC_midAcc] = 0; c->sc[SC_lastSpot] = 0; c->sc[SC_lastMid] = SNN_DBL(0x7FF8000000000000ull); /* JS NaN */ c->si[SI_nPrev] = 0; }
  pbar(tc);
}

/** One member x column's rounds of recorded calls for a team: setup on thread 0, then every round in step. */
SNN_FN void parRun(const SnnP *p, Col *c, ParSh *S, char *scratch, const StepIn *ins, int nCols, int col, int r0, int rounds, Tc *tc) {
  ParScr x;
  parCarve(&x, scratch, p->N, c->ffPtr[p->nL1], c->recPtr[p->N], tc->T);
  ONE parSetup(p, c, S, &x);
  pbar(tc);
  for (int r = r0; r < r0 + rounds; r++) {
    const StepIn *in = &ins[(size_t)r * nCols + col];
    if (in->kind == 1) colStepPar(p, c, in, S, &x, tc);
    else if (in->kind == 2) colResetPar(p, c, tc);
  }
}

#ifdef __CUDACC__
/** One thread block per member x column (blockIdx.x = t; params[pIdx[t]], cols[t], the inputs of column colOf[t]),
 *  its threads sharing the column's work; `scratch` holds `stride` bytes per block (parScrBytes). */
extern "C" __global__ void snn_columns_run_par(const SnnP *params, const int *pIdx, Col *cols, const StepIn *ins, const int *colOf, char *scratch, int stride, int n, int nCols, int r0, int rounds) {
  __shared__ SnnP P;
  __shared__ Col C;
  __shared__ ParSh S;
  int t = blockIdx.x;
  if (t >= n) return;
  if (threadIdx.x == 0) { P = params[pIdx[t]]; C = cols[t]; }
  __syncthreads();
  Tc tc = { (int)threadIdx.x, (int)blockDim.x, 0 };
  parRun(&P, &C, &S, scratch + (size_t)t * stride, ins, nCols, colOf[t], r0, rounds, &tc);
}
#endif

// One network step for every column of a group of tournament members (research/snnGpu.ts): the columns live on the device
// (python/snn/pool.py), the network-level logic stays on the host. Per column and step the host sends a record (its
// inputs and cross-column terms) and gets back a summary: the column's scalars, its mean rates, the BCM threshold, and on
// request the NaN check and the rate vectors the readouts read. Include after column.cu and column_par.cuh.
//
// The summary's values are computed with the TypeScript's own operations and order (Column.meanRateE/I/L0, bcmTheta,
// hasNaN), so the host's network sees exactly what it would see with the columns on the CPU.

/** One column's call this round: kind 1 = a step, 2 = resetTransient, 0 = nothing. 64 bytes. */
typedef struct { int col, kind, first, frozen, want, valsOff; double price, mid, latInh, dBrier, refRateE; } GRec;
enum { WANT_NAN = 1, WANT_FEAT = 2 };
/** Summary doubles per record: Column.SCALARS' doubles (25), its int counters (4), meanRateE, meanRateI, meanRateL0, bcmTheta,
 *  hasNaN (1/0; -1 when not asked). */
#define GSUM 34

SNN_FN void gSummary(const SnnP *p, const Col *c, int want, double *out) {
  for (int i = 0; i < SC_COUNT; i++) out[i] = c->sc[i];
  for (int i = 0; i < SI_COUNT; i++) out[SC_COUNT + i] = c->si[i];
  const int nE = p->nE, N = p->N, nL0 = p->nL0, nL1 = p->nL1;
  double s = 0;
  for (int i = 0; i < nE; i++) s += c->rate2[i];
  out[29] = s / nE;
  s = 0;
  for (int i = nE; i < N; i++) s += c->rate2[i];
  out[30] = s / (N - nE);
  s = 0;
  for (int i = 0; i < nL0; i++) s += c->rate0[i];
  out[31] = s / nL0;
  // bcmTheta: (r / rho0)^p * r over rho1 then rhoE (p is 1 or 2: fdlibm's pow returns x and x * x exactly).
  s = 0;
  for (int i = 0; i < nL1; i++) { double x = c->rho1[i] / p->rho0; s += (p->tripP == 2 ? x * x : x) * c->rho1[i]; }
  for (int i = 0; i < nE; i++) { double x = c->rhoE[i] / p->rho0; s += (p->tripP == 2 ? x * x : x) * c->rhoE[i]; }
  out[32] = (nL1 + nE) ? s / (nL1 + nE) : 0;
  out[33] = -1;
  if (want & WANT_NAN) {
    int bad = !s_finite(c->sc[SC_G]) || !s_finite(c->sc[SC_surprise]);
#define GNAN(a, n) for (int i = 0; !bad && i < (n); i++) if (!s_finite((double)(a)[i])) bad = 1;
    GNAN(c->v0, nL0) GNAN(c->v1, nL1) GNAN(c->v2, N) GNAN(c->w1, p->nSyn) GNAN(c->recW, c->recPtr[N]) GNAN(c->U1, nL1 * nE) GNAN(c->U0, nL0 * nL1) GNAN(c->z1, nL1) GNAN(c->z2, nE)
#undef GNAN
    out[33] = bad;
  }
}

/** The readouts' rate features: rate2[0..nE), rate1, rate0 (Column.features). */
SNN_FN void gFeatures(const SnnP *p, const Col *c, double *f) {
  for (int i = 0; i < p->nE; i++) f[i] = c->rate2[i];
  for (int i = 0; i < p->nL1; i++) f[p->nE + i] = c->rate1[i];
  for (int i = 0; i < p->nL0; i++) f[p->nE + p->nL1 + i] = c->rate0[i];
}

SNN_FN StepIn gStepIn(const GRec *r, const double *vals) {
  StepIn in;
  in.price = r->price; in.mid = r->mid; in.latInh = r->latInh; in.dBrier = r->dBrier; in.refRateE = r->refRateE;
  in.first = r->first; in.frozen = r->frozen; in.kind = 1; in.pad_ = 0;
  in.vals = vals + r->valsOff; in.gapV = 0;
  return in;
}

/** gSummary for a team: the four sums each on its own thread, each in gSummary's order (so the same bits), and the NaN
 *  check spread over every thread (whether any value is not finite does not depend on the order). The team's state must be
 *  complete (after a barrier); x->cnt is free by then. */
SNN_FN void gSummaryPar(const SnnP *p, const Col *c, int want, double *out, ParScr *x, Tc *tc) {
  const int nE = p->nE, N = p->N, nL0 = p->nL0, nL1 = p->nL1;
  for (int j = tc->tid; j < 4; j += tc->T) {
    double s = 0;
    if (j == 0) { for (int i = 0; i < nE; i++) s += c->rate2[i]; out[29] = s / nE; }
    else if (j == 1) { for (int i = nE; i < N; i++) s += c->rate2[i]; out[30] = s / (N - nE); }
    else if (j == 2) { for (int i = 0; i < nL0; i++) s += c->rate0[i]; out[31] = s / nL0; }
    else {
      for (int i = 0; i < nL1; i++) { double y = c->rho1[i] / p->rho0; s += (p->tripP == 2 ? y * y : y) * c->rho1[i]; }
      for (int i = 0; i < nE; i++) { double y = c->rhoE[i] / p->rho0; s += (p->tripP == 2 ? y * y : y) * c->rhoE[i]; }
      out[32] = (nL1 + nE) ? s / (nL1 + nE) : 0;
    }
  }
  PFOR(i, SC_COUNT) out[i] = c->sc[i];
  PFOR(i, SI_COUNT) out[SC_COUNT + i] = c->si[i];
  if (!(want & WANT_NAN)) { ONE out[33] = -1; return; }
  int bad = tc->tid == 0 && (!s_finite(c->sc[SC_G]) || !s_finite(c->sc[SC_surprise]));
#define GNANP(a, n) for (int i = tc->tid; !bad && i < (n); i += tc->T) if (!s_finite((double)(a)[i])) bad = 1;
  GNANP(c->v0, nL0) GNANP(c->v1, nL1) GNANP(c->v2, N) GNANP(c->w1, p->nSyn) GNANP(c->recW, c->recPtr[N]) GNANP(c->U1, nL1 * nE) GNANP(c->U0, nL0 * nL1) GNANP(c->z1, nL1) GNANP(c->z2, nE)
#undef GNANP
  x->cnt[tc->tid] = bad;
  pbar(tc);
  ONE {
    int any = 0;
    for (int t = 0; t < tc->T; t++) any |= x->cnt[t];
    out[33] = any;
  }
}

/** The column's constants (the running averages' decay constants and the NMDA gate at threshold), kept after its scratch:
 *  computed once, on the column's first launch, by the same expressions (so the same bits as computing them every step). */
#define GK 10
SNN_FN double *gConstsAt(const SnnP *P, const Col *C, char *scratch, int T) {
  return (double *)(scratch + parScrBytes(P->N, C->ffPtr[P->nL1], C->recPtr[P->N], T));
}

/** A record's work for a team (a CUDA block, or POSIX threads in group_cpu.c): the column's block-kernel scratch (its
 *  transposed indexes and constants made on first use, `built`), the step or reset spread over the team, then the summary
 *  (and the rate vectors). P, C, S and R are shared by the team. */
SNN_FN void gBlock(const SnnP *P, Col *C, ParSh *S, const GRec *R, char *scratch, int *built, const double *vals, double *sum, double *feat, Tc *tc) {
  ParScr x;
  parCarve(&x, scratch, P->N, C->ffPtr[P->nL1], C->recPtr[P->N], tc->T);
  if (tc->tid == 0) {
    double *K = gConstsAt(P, C, scratch, tc->T);
    if (!*built) {
      K[0] = kOf(P->tauRateL0); K[1] = kOf(P->tauRateL1); K[2] = kOf(P->tauRateL23);
      K[3] = kOf(60); K[4] = kOf(3600); K[5] = kOf(300); K[6] = kOf(P->tauRho); K[7] = kOf(P->surpriseTau); K[8] = kOf(P->pcSigmaLearnTau);
      K[9] = nmdaGate(toMv(P->thetaE, P->thetaE), P->mg);
      parTranspose(P->nL1, P->N, C->ffPtr, C->ffCol, x.ffTPtr, x.ffTSrc, x.ffTEdge, x.tmp);
      parTranspose(P->N, P->N, C->recPtr, C->recCol, x.recTPtr, x.recTSrc, x.recTEdge, x.tmp);
      *built = 1;
    }
    S->kL0 = K[0]; S->kL1 = K[1]; S->kL23 = K[2]; S->k60 = K[3]; S->k3600 = K[4]; S->k300 = K[5]; S->kRho = K[6]; S->kSur = K[7]; S->kSig = K[8]; S->gNmdaE = K[9];
  }
  pbar(tc);
  if (R->kind == 1) { StepIn in = gStepIn(R, vals); colStepPar(P, C, &in, S, &x, tc); }
  else if (R->kind == 2) colResetPar(P, C, tc);
  gSummaryPar(P, C, R->want, sum, &x, tc);
  if (R->want & WANT_FEAT) {
    PFOR(i, P->nE) feat[i] = C->rate2[i];
    PFOR(i, P->nL1) feat[P->nE + i] = C->rate1[i];
    PFOR(i, P->nL0) feat[P->nE + P->nL1 + i] = C->rate0[i];
  }
}

#ifdef __CUDACC__
typedef char gWords_[(sizeof(SnnP) % 4 == 0 && sizeof(Col) % 4 == 0 && sizeof(GRec) % 4 == 0) ? 1 : -1];
/** One block per record: params[r.col], cols[r.col], scratch[r.col], built[r.col]. */
extern "C" __global__ void snn_group_step(const SnnP *params, Col *cols, char *const *scratch, int *built, const GRec *recs, const double *vals,
    double *sum, double *feat, int featStride, int n) {
  __shared__ SnnP P;
  __shared__ Col C;
  __shared__ ParSh S;
  __shared__ GRec R;
  int t = blockIdx.x;
  if (t >= n) return;
  // The record, then its column's params and state struct, copied word by word by the whole block.
  for (int i = threadIdx.x; i < (int)(sizeof(GRec) / 4); i += blockDim.x) ((int *)&R)[i] = ((const int *)&recs[t])[i];
  __syncthreads();
  const int *ps = (const int *)&params[R.col], *cs = (const int *)&cols[R.col];
  for (int i = threadIdx.x; i < (int)(sizeof(SnnP) / 4); i += blockDim.x) ((int *)&P)[i] = ps[i];
  for (int i = threadIdx.x; i < (int)(sizeof(Col) / 4); i += blockDim.x) ((int *)&C)[i] = cs[i];
  __syncthreads();
  Tc tc = { (int)threadIdx.x, (int)blockDim.x, 0 };
  gBlock(&P, &C, &S, &R, scratch[R.col], &built[R.col], vals, sum + (size_t)t * GSUM, feat + (size_t)t * featStride, &tc);
}
#else
/** The CPU pool's serial path (python/snn/pool.py --cpu): the column step of column.cu, record by record. */
void snn_group_step_cpu(const SnnP *params, Col *cols, const GRec *recs, const double *vals, double *sum, double *feat, int featStride, int n) {
  for (int t = 0; t < n; t++) {
    const GRec *r = &recs[t];
    const SnnP *p = &params[r->col];
    Col *c = &cols[r->col];
    if (r->kind == 1) { StepIn in = gStepIn(r, vals); colStep(p, c, &in); }
    else if (r->kind == 2) colReset(p, c);
    gSummary(p, c, r->want, sum + (size_t)t * GSUM);
    if (r->want & WANT_FEAT) gFeatures(p, c, feat + (size_t)t * featStride);
  }
}
#endif

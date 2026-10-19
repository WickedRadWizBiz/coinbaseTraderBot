// The team-of-threads column kernel (column_par.cuh) on POSIX threads: what the GPU's thread blocks do, with real
// concurrency and barriers, so its exactness is checked without a GPU (parity.c with a thread count; python/snn/
// bench.py --cpu). Build with -pthread.

#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include "column.cu"

static void par_barrier_wait(void *b) { pthread_barrier_wait((pthread_barrier_t *)b); }

#include "column_par.cuh"

typedef struct { const SnnP *p; Col *c; ParSh *S; char *scratch; const StepIn *ins; int nCols, col, r0, rounds, tid, T; pthread_barrier_t *bar; } ParJob;

static void *par_worker(void *a) {
  ParJob *j = (ParJob *)a;
  Tc tc = { j->tid, j->T, j->bar };
  parRun(j->p, j->c, j->S, j->scratch, j->ins, j->nCols, j->col, j->r0, j->rounds, &tc);
  return 0;
}

/** One member x column through `rounds` rounds with a team of T threads. */
static void par_run_one(const SnnP *p, Col *c, const StepIn *ins, int nCols, int col, int r0, int rounds, int T) {
  char *scratch = (char *)calloc(1, parScrBytes(p->N, c->ffPtr[p->nL1], c->recPtr[p->N], T) + 64);
  ParSh S; memset(&S, 0, sizeof S);
  pthread_barrier_t bar; pthread_barrier_init(&bar, 0, (unsigned)T);
  pthread_t *th = (pthread_t *)malloc(sizeof(pthread_t) * T);
  ParJob *jobs = (ParJob *)malloc(sizeof(ParJob) * T);
  for (int t = 0; t < T; t++) {
    ParJob j = { p, c, &S, scratch, ins, nCols, col, r0, rounds, t, T, &bar };
    jobs[t] = j;
    pthread_create(&th[t], 0, par_worker, &jobs[t]);
  }
  for (int t = 0; t < T; t++) pthread_join(th[t], 0);
  pthread_barrier_destroy(&bar);
  free(th); free(jobs); free(scratch);
}

/** The batch kernel's work (snn_columns_run_par) on the CPU: member x column after member x column, each by a team. */
void snn_columns_run_par_cpu(const SnnP *params, const int *pIdx, Col *cols, const StepIn *ins, const int *colOf, int n, int nCols, int r0, int rounds, int T) {
  for (int t = 0; t < n; t++) par_run_one(&params[pIdx[t]], &cols[t], ins, nCols, colOf[t], r0, rounds, T);
}

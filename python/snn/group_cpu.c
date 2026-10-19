// The device pool's C build (python/snn/pool.py --cpu): the group step serially (column.cu's colStep), and, with a thread
// count, the GPU's group kernel (group.cuh gBlock: the team-of-threads column step) on POSIX threads with barriers, so
// the GPU path's own code is checked without a GPU. Build with -pthread.

#include "par_cpu.c"
#include "group.cuh"

typedef struct { const SnnP *P; Col *C; ParSh *S; const GRec *R; char *scratch; int *built; const double *vals; double *sum, *feat; int tid, T; pthread_barrier_t *bar; } GJob;

static void *g_worker(void *a) {
  GJob *j = (GJob *)a;
  Tc tc = { j->tid, j->T, j->bar };
  gBlock(j->P, j->C, j->S, j->R, j->scratch, j->built, j->vals, j->sum, j->feat, &tc);
  return 0;
}

/** snn_group_step's work on the CPU: each record by a team of T threads (params and cols indexed by the record's column). */
void snn_group_step_par_cpu(const SnnP *params, Col *cols, char **scratch, int *built, const GRec *recs, const double *vals, double *sum, double *feat, int featStride, int n, int T) {
  pthread_t *th = (pthread_t *)malloc(sizeof(pthread_t) * T);
  GJob *jobs = (GJob *)malloc(sizeof(GJob) * T);
  for (int t = 0; t < n; t++) {
    const GRec *r = &recs[t];
    ParSh S; memset(&S, 0, sizeof S);
    pthread_barrier_t bar; pthread_barrier_init(&bar, 0, (unsigned)T);
    for (int k = 0; k < T; k++) {
      GJob j = { &params[r->col], &cols[r->col], &S, r, scratch[r->col], &built[r->col], vals, sum + (size_t)t * GSUM, feat + (size_t)t * featStride, k, T, &bar };
      jobs[k] = j;
      pthread_create(&th[k], 0, g_worker, &jobs[k]);
    }
    for (int k = 0; k < T; k++) pthread_join(th[k], 0);
    pthread_barrier_destroy(&bar);
  }
  free(th); free(jobs);
}

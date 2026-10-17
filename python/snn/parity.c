// CPU parity harness for the SNN column kernel: replays a trace written by research/snnKernel.ts
// (recordKernelTrace) through column.cu compiled as C, then compares every column's final state with the
// TypeScript network's bit for bit. Build: cc -O2 -ffp-contract=off -fno-fast-math parity.c -lm
// Usage: parity <trace>   (exit 0 = identical; otherwise prints the first differing array and index)

#include <stdio.h>
#include <stdlib.h>
#include <stddef.h>
#include "column.cu"

static FILE *f;
static uint32_t u32(void) { uint32_t x; if (fread(&x, 4, 1, f) != 1) { fprintf(stderr, "trace ends early\n"); exit(2); } return x; }
static int32_t i32(void) { return (int32_t)u32(); }
static double f64(void) { double x; if (fread(&x, 8, 1, f) != 1) { fprintf(stderr, "trace ends early\n"); exit(2); } return x; }
static const size_t ES[4] = {8, 4, 4, 1};
typedef struct { uint32_t dt, n; void *p; } Arr;
static Arr typed(void) { Arr a; a.dt = u32(); a.n = u32(); a.p = malloc(a.n * ES[a.dt] + 8); if (a.n && fread(a.p, ES[a.dt], a.n, f) != a.n) { fprintf(stderr, "trace ends early\n"); exit(2); } return a; }

#define NSLOTS (sizeof(Col) / sizeof(void *))

int main(int argc, char **argv) {
  if (argc < 2 || !(f = fopen(argv[1], "rb"))) { fprintf(stderr, "usage: parity <trace>\n"); return 2; }
  char magic[4]; if (fread(magic, 1, 4, f) != 4 || memcmp(magic, "SNNK", 4)) { fprintf(stderr, "not a kernel trace\n"); return 2; }
  if (u32() != 1) { fprintf(stderr, "trace version\n"); return 2; }
  uint32_t nc = u32();
  SnnP *P = calloc(nc, sizeof(SnnP)); Col *C = calloc(nc, sizeof(Col));
  for (uint32_t c = 0; c < nc; c++) {
    uint32_t ni = u32(); if (ni * 4 != offsetof(SnnP, deltaGain)) { fprintf(stderr, "SnnP ints %u\n", ni); return 2; }
    if (fread(&P[c], 4, ni, f) != ni) return 2;
    uint32_t nd = u32(); if (offsetof(SnnP, deltaGain) + nd * 8 != sizeof(SnnP)) { fprintf(stderr, "SnnP doubles %u\n", nd); return 2; }
    if (fread((char *)&P[c] + offsetof(SnnP, deltaGain), 8, nd, f) != nd) return 2;
    uint32_t na = u32(); if (na != NSLOTS) { fprintf(stderr, "Col slots %u vs %zu\n", na, NSLOTS); return 2; }
    void **slot = (void **)&C[c];
    for (uint32_t k = 0; k < na; k++) slot[k] = typed().p;
  }
  uint32_t calls = u32();
  long spikes[3] = {0, 0, 0};
  for (uint32_t q = 0; q < calls; q++) {
    uint32_t op = u32(), c = u32();
    if (op == 1) { colReset(&P[c], &C[c]); continue; }
    StepIn in; in.kind = 1; in.pad_ = 0; in.first = i32(); in.frozen = i32();
    in.price = f64(); in.mid = f64(); in.latInh = f64(); in.dBrier = f64(); in.refRateE = f64();
    Arr v = typed(); in.vals = (const double *)v.p;
    Arr g = {0, 0, 0}; if (u32()) g = typed(); in.gapV = (const double *)g.p;
    colStep(&P[c], &C[c], &in);
    for (int i = 0; i < P[c].nL0; i++) spikes[0] += C[c].s0[i];
    for (int i = 0; i < P[c].nL1; i++) spikes[1] += C[c].s1[i];
    for (int i = 0; i < P[c].N; i++) spikes[2] += C[c].s2[i];
    free(v.p); free(g.p);
  }
  int bad = 0;
  for (uint32_t c = 0; c < nc; c++) {
    void **slot = (void **)&C[c];
    for (uint32_t k = 0; k < NSLOTS; k++) {
      Arr want = typed();
      if (memcmp(slot[k], want.p, want.n * ES[want.dt]) != 0) {
        size_t es = ES[want.dt], i = 0;
        while (memcmp((char *)slot[k] + i * es, (char *)want.p + i * es, es) == 0) i++;
        if (bad++ < 10) {
          if (want.dt == 0) printf("column %u slot %u [%zu]: kernel %.17g ts %.17g\n", c, k, i, ((double *)slot[k])[i], ((double *)want.p)[i]);
          else if (want.dt == 1) printf("column %u slot %u [%zu]: kernel %.9g ts %.9g\n", c, k, i, ((float *)slot[k])[i], ((float *)want.p)[i]);
          else printf("column %u slot %u [%zu] differs\n", c, k, i);
        }
      }
      free(want.p);
    }
  }
  printf("%u columns, %u calls (spikes L0 %ld, L1 %ld, L2/3 %ld): %s\n", nc, calls, spikes[0], spikes[1], spikes[2], bad ? "DIFFERENT" : "bit-identical");
  return bad ? 1 : 0;
}

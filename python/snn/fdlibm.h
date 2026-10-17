// fdlibm exp, log, expm1 and tanh exactly as V8 computes Math.exp, Math.log and Math.tanh (V8 12.4
// src/base/ieee754.cc, from FreeBSD msun / Sun fdlibm). Ported mechanically (casts, statics) so the
// SNN kernel (python/snn/column.cu) gets the same bits as the TypeScript network, compiled as C on the
// CPU, as WebAssembly or as CUDA with fused multiply-add off. Do not edit by hand; tests/snnKernel.test.ts checks every
// function against Node bit for bit.
//
// ====================================================
// Copyright (C) 1993-2004 by Sun Microsystems, Inc. All rights reserved.
//
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================
#pragma once
#ifdef __CUDACC__
#define SNN_FN __device__ static inline
#define SNN_BITS(d) ((uint64_t)__double_as_longlong(d))
#define SNN_DBL(b) __longlong_as_double((long long)(b))
#elif defined(__wasm__)
// WebAssembly (bot/snn/kernelWasm.ts): freestanding, no C library; floor/fabs/sqrt are single IEEE instructions.
#include <stdint.h>
#define SNN_FN static inline
#define fabs __builtin_fabs
#define floor __builtin_floor
#define sqrt __builtin_sqrt
static inline uint64_t snn_bits(double d) { uint64_t b; __builtin_memcpy(&b, &d, 8); return b; }
static inline double snn_dbl(uint64_t b) { double d; __builtin_memcpy(&d, &b, 8); return d; }
#define SNN_BITS(d) snn_bits(d)
#define SNN_DBL(b) snn_dbl(b)
#else
#include <stdint.h>
#include <string.h>
#include <math.h>
#define SNN_FN static inline
static inline uint64_t snn_bits(double d) { uint64_t b; memcpy(&b, &d, 8); return b; }
static inline double snn_dbl(uint64_t b) { double d; memcpy(&d, &b, 8); return d; }
#define SNN_BITS(d) snn_bits(d)
#define SNN_DBL(b) snn_dbl(b)
#endif
#define EXTRACT_WORDS(ix0, ix1, d) do { uint64_t bits_ = SNN_BITS(d); (ix0) = (int32_t)(bits_ >> 32); (ix1) = (uint32_t)(bits_ & 0xFFFFFFFFu); } while (0)
#define GET_HIGH_WORD(i, d) do { uint64_t bits_ = SNN_BITS(d); (i) = (int32_t)(bits_ >> 32); } while (0)
#define GET_LOW_WORD(i, d) do { uint64_t bits_ = SNN_BITS(d); (i) = (uint32_t)(bits_ & 0xFFFFFFFFu); } while (0)
#define INSERT_WORDS(d, ix0, ix1) do { uint64_t bits_ = ((uint64_t)(uint32_t)(ix0) << 32) | (uint32_t)(ix1); (d) = SNN_DBL(bits_); } while (0)
#define SET_HIGH_WORD(d, v) do { uint64_t bits_ = SNN_BITS(d); bits_ &= 0x00000000FFFFFFFFull; bits_ |= (uint64_t)(uint32_t)(v) << 32; (d) = SNN_DBL(bits_); } while (0)
#define SET_LOW_WORD(d, v) do { uint64_t bits_ = SNN_BITS(d); bits_ &= 0xFFFFFFFF00000000ull; bits_ |= (uint32_t)(v); (d) = SNN_DBL(bits_); } while (0)

SNN_FN double fd_exp(double x) {
  const double
      one = 1.0,
      halF[2] = {0.5, -0.5},
      o_threshold = 7.09782712893383973096e+02,  /* 0x40862E42, 0xFEFA39EF */
      u_threshold = -7.45133219101941108420e+02, /* 0xC0874910, 0xD52D3051 */
      ln2HI[2] = {6.93147180369123816490e-01,    /* 0x3FE62E42, 0xFEE00000 */
                  -6.93147180369123816490e-01},  /* 0xBFE62E42, 0xFEE00000 */
      ln2LO[2] = {1.90821492927058770002e-10,    /* 0x3DEA39EF, 0x35793C76 */
                  -1.90821492927058770002e-10},  /* 0xBDEA39EF, 0x35793C76 */
      invln2 = 1.44269504088896338700e+00,       /* 0x3FF71547, 0x652B82FE */
      P1 = 1.66666666666666019037e-01,           /* 0x3FC55555, 0x5555553E */
      P2 = -2.77777777770155933842e-03,          /* 0xBF66C16C, 0x16BEBD93 */
      P3 = 6.61375632143793436117e-05,           /* 0x3F11566A, 0xAF25DE2C */
      P4 = -1.65339022054652515390e-06,          /* 0xBEBBBD41, 0xC5D26BF1 */
      P5 = 4.13813679705723846039e-08,           /* 0x3E663769, 0x72BEA4D0 */
      E = 2.718281828459045;                     /* 0x4005BF0A, 0x8B145769 */

  const double
      huge = 1.0e+300,
      twom1000 = 9.33263618503218878990e-302, /* 2**-1000=0x01700000,0*/
      two1023 = 8.988465674311579539e307;     /* 0x1p1023 */

  double y, hi = 0.0, lo = 0.0, c, t, twopk;
  int32_t k = 0, xsb;
  uint32_t hx;

  GET_HIGH_WORD(hx, x);
  xsb = (hx >> 31) & 1; /* sign bit of x */
  hx &= 0x7FFFFFFF;     /* high word of |x| */

  /* filter out non-finite argument */
  if (hx >= 0x40862E42) { /* if |x|>=709.78... */
    if (hx >= 0x7FF00000) {
      uint32_t lx;
      GET_LOW_WORD(lx, x);
      if (((hx & 0xFFFFF) | lx) != 0)
        return x + x; /* NaN */
      else
        return (xsb == 0) ? x : 0.0; /* exp(+-inf)={inf,0} */
    }
    if (x > o_threshold) return huge * huge;         /* overflow */
    if (x < u_threshold) return twom1000 * twom1000; /* underflow */
  }

  /* argument reduction */
  if (hx > 0x3FD62E42) {   /* if  |x| > 0.5 ln2 */
    if (hx < 0x3FF0A2B2) { /* and |x| < 1.5 ln2 */
      /* TODO(rtoy): We special case exp(1) here to return the correct
       * value of E, as the computation below would get the last bit
       * wrong. We should probably fix the algorithm instead.
       */
      if (x == 1.0) return E;
      hi = x - ln2HI[xsb];
      lo = ln2LO[xsb];
      k = 1 - xsb - xsb;
    } else {
      k = ((int)(invln2 * x + halF[xsb]));
      t = k;
      hi = x - t * ln2HI[0]; /* t*ln2HI is exact here */
      lo = t * ln2LO[0];
    }
    x = hi - lo;
  } else if (hx < 0x3E300000) {         /* when |x|<2**-28 */
    if (huge + x > one) return one + x; /* trigger inexact */
  } else {
    k = 0;
  }

  /* x is now in primary range */
  t = x * x;
  if (k >= -1021) {
    INSERT_WORDS(
        twopk,
        0x3FF00000 + ((int32_t)(((uint32_t)(k)) << 20)), 0);
  } else {
    INSERT_WORDS(twopk, 0x3FF00000 + (((uint32_t)(k + 1000)) << 20),
                 0);
  }
  c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k == 0) {
    return one - ((x * c) / (c - 2.0) - x);
  } else {
    y = one - ((lo - (x * c) / (2.0 - c)) - hi);
  }
  if (k >= -1021) {
    if (k == 1024) return y * 2.0 * two1023;
    return y * twopk;
  } else {
    return y * twopk * twom1000;
  }
}

SNN_FN double fd_log(double x) {
  const double                      /* -- */
      ln2_hi = 6.93147180369123816490e-01, /* 3fe62e42 fee00000 */
      ln2_lo = 1.90821492927058770002e-10, /* 3dea39ef 35793c76 */
      two54 = 1.80143985094819840000e+16,  /* 43500000 00000000 */
      Lg1 = 6.666666666666735130e-01,      /* 3FE55555 55555593 */
      Lg2 = 3.999999999940941908e-01,      /* 3FD99999 9997FA04 */
      Lg3 = 2.857142874366239149e-01,      /* 3FD24924 94229359 */
      Lg4 = 2.222219843214978396e-01,      /* 3FCC71C5 1D8E78AF */
      Lg5 = 1.818357216161805012e-01,      /* 3FC74664 96CB03DE */
      Lg6 = 1.531383769920937332e-01,      /* 3FC39A09 D078C69F */
      Lg7 = 1.479819860511658591e-01;      /* 3FC2F112 DF3E5244 */

  const double zero = 0.0;

  double hfsq, f, s, z, R, w, t1, t2, dk;
  int32_t k, hx, i, j;
  uint32_t lx;

  EXTRACT_WORDS(hx, lx, x);

  k = 0;
  if (hx < 0x00100000) { /* x < 2**-1022  */
    if (((hx & 0x7FFFFFFF) | lx) == 0) {
      return -(1.0/0.0); /* log(+-0)=-inf */
    }
    if (hx < 0) {
      return (0.0/0.0); /* log(-#) = NaN */
    }
    k -= 54;
    x *= two54; /* subnormal number, scale up x */
    GET_HIGH_WORD(hx, x);
  }
  if (hx >= 0x7FF00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000FFFFF;
  i = (hx + 0x95F64) & 0x100000;
  SET_HIGH_WORD(x, hx | (i ^ 0x3FF00000)); /* normalize x or x/2 */
  k += (i >> 20);
  f = x - 1.0;
  if ((0x000FFFFF & (2 + hx)) < 3) { /* -2**-20 <= f < 2**-20 */
    if (f == zero) {
      if (k == 0) {
        return zero;
      } else {
        dk = ((double)(k));
        return dk * ln2_hi + dk * ln2_lo;
      }
    }
    R = f * f * (0.5 - 0.33333333333333333 * f);
    if (k == 0) {
      return f - R;
    } else {
      dk = ((double)(k));
      return dk * ln2_hi - ((R - dk * ln2_lo) - f);
    }
  }
  s = f / (2.0 + f);
  dk = ((double)(k));
  z = s * s;
  i = hx - 0x6147A;
  w = z * z;
  j = 0x6B851 - hx;
  t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
  t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
  i |= j;
  R = t2 + t1;
  if (i > 0) {
    hfsq = 0.5 * f * f;
    if (k == 0)
      return f - (hfsq - s * (hfsq + R));
    else
      return dk * ln2_hi - ((hfsq - (s * (hfsq + R) + dk * ln2_lo)) - f);
  } else {
    if (k == 0)
      return f - s * (f - R);
    else
      return dk * ln2_hi - ((s * (f - R) - dk * ln2_lo) - f);
  }
}

SNN_FN double fd_expm1(double x) {
  const double
      one = 1.0,
      tiny = 1.0e-300,
      o_threshold = 7.09782712893383973096e+02, /* 0x40862E42, 0xFEFA39EF */
      ln2_hi = 6.93147180369123816490e-01,      /* 0x3FE62E42, 0xFEE00000 */
      ln2_lo = 1.90821492927058770002e-10,      /* 0x3DEA39EF, 0x35793C76 */
      invln2 = 1.44269504088896338700e+00,      /* 0x3FF71547, 0x652B82FE */
      /* Scaled Q's: Qn_here = 2**n * Qn_above, for R(2*z) where z = hxs =
         x*x/2: */
      Q1 = -3.33333333333331316428e-02, /* BFA11111 111110F4 */
      Q2 = 1.58730158725481460165e-03,  /* 3F5A01A0 19FE5585 */
      Q3 = -7.93650757867487942473e-05, /* BF14CE19 9EAADBB7 */
      Q4 = 4.00821782732936239552e-06,  /* 3ED0CFCA 86E65239 */
      Q5 = -2.01099218183624371326e-07; /* BE8AFDB7 6E09C32D */

  const double huge = 1.0e+300;

  double y, hi, lo, c, t, e, hxs, hfx, r1, twopk;
  int32_t k, xsb;
  uint32_t hx;

  GET_HIGH_WORD(hx, x);
  xsb = hx & 0x80000000; /* sign bit of x */
  hx &= 0x7FFFFFFF;      /* high word of |x| */

  /* filter out huge and non-finite argument */
  if (hx >= 0x4043687A) {   /* if |x|>=56*ln2 */
    if (hx >= 0x40862E42) { /* if |x|>=709.78... */
      if (hx >= 0x7FF00000) {
        uint32_t low;
        GET_LOW_WORD(low, x);
        if (((hx & 0xFFFFF) | low) != 0)
          return x + x; /* NaN */
        else
          return (xsb == 0) ? x : -1.0; /* exp(+-inf)={inf,-1} */
      }
      if (x > o_threshold) return huge * huge; /* overflow */
    }
    if (xsb != 0) {        /* x < -56*ln2, return -1.0 with inexact */
      if (x + tiny < 0.0)  /* raise inexact */
        return tiny - one; /* return -1 */
    }
  }

  /* argument reduction */
  if (hx > 0x3FD62E42) {   /* if  |x| > 0.5 ln2 */
    if (hx < 0x3FF0A2B2) { /* and |x| < 1.5 ln2 */
      if (xsb == 0) {
        hi = x - ln2_hi;
        lo = ln2_lo;
        k = 1;
      } else {
        hi = x + ln2_hi;
        lo = -ln2_lo;
        k = -1;
      }
    } else {
      k = invln2 * x + ((xsb == 0) ? 0.5 : -0.5);
      t = k;
      hi = x - t * ln2_hi; /* t*ln2_hi is exact here */
      lo = t * ln2_lo;
    }
    x = hi - lo;
    c = (hi - x) - lo;
  } else if (hx < 0x3C900000) { /* when |x|<2**-54, return x */
    t = huge + x;               /* return x with inexact flags when x!=0 */
    return x - (t - (huge + x));
  } else {
    k = 0;
  }

  /* x is now in primary range */
  hfx = 0.5 * x;
  hxs = x * hfx;
  r1 = one + hxs * (Q1 + hxs * (Q2 + hxs * (Q3 + hxs * (Q4 + hxs * Q5))));
  t = 3.0 - r1 * hfx;
  e = hxs * ((r1 - t) / (6.0 - x * t));
  if (k == 0) {
    return x - (x * e - hxs); /* c is 0 */
  } else {
    INSERT_WORDS(
        twopk,
        0x3FF00000 + ((int32_t)(((uint32_t)(k)) << 20)),
        0); /* 2^k */
    e = (x * (e - c) - c);
    e -= hxs;
    if (k == -1) return 0.5 * (x - e) - 0.5;
    if (k == 1) {
      if (x < -0.25)
        return -2.0 * (e - (x + 0.5));
      else
        return one + 2.0 * (x - e);
    }
    if (k <= -2 || k > 56) { /* suffice to return exp(x)-1 */
      y = one - (e - x);
      // TODO(mvstanton): is this replacement for the hex float
      // sufficient?
      // if (k == 1024) y = y*2.0*0x1p1023;
      if (k == 1024)
        y = y * 2.0 * 8.98846567431158e+307;
      else
        y = y * twopk;
      return y - one;
    }
    t = one;
    if (k < 20) {
      SET_HIGH_WORD(t, 0x3FF00000 - (0x200000 >> k)); /* t=1-2^-k */
      y = t - (e - x);
      y = y * twopk;
    } else {
      SET_HIGH_WORD(t, ((0x3FF - k) << 20)); /* 2^-k */
      y = x - (e + t);
      y += one;
      y = y * twopk;
    }
  }
  return y;
}

SNN_FN double fd_tanh(double x) {
  const double tiny = 1.0e-300;
  const double one = 1.0, two = 2.0, huge = 1.0e300;
  double t, z;
  int32_t jx, ix;

  GET_HIGH_WORD(jx, x);
  ix = jx & 0x7FFFFFFF;

  /* x is INF or NaN */
  if (ix >= 0x7FF00000) {
    if (jx >= 0)
      return one / x + one; /* tanh(+-inf)=+-1 */
    else
      return one / x - one; /* tanh(NaN) = NaN */
  }

  /* |x| < 22 */
  if (ix < 0x40360000) {            /* |x|<22 */
    if (ix < 0x3E300000) {          /* |x|<2**-28 */
      if (huge + x > one) return x; /* tanh(tiny) = tiny with inexact */
    }
    if (ix >= 0x3FF00000) { /* |x|>=1  */
      t = fd_expm1(two * fabs(x));
      z = one - two / (t + two);
    } else {
      t = fd_expm1(-two * fabs(x));
      z = -t / (t + two);
    }
    /* |x| >= 22, return +-1 */
  } else {
    z = one - tiny; /* raise inexact flag */
  }
  return (jx >= 0) ? z : -z;
}

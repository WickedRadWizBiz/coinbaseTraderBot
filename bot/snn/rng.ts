// Deterministic PRNG for the SNN: xoshiro128** (Blackman & Vigna) with a splitmix32 seeder.
// Its 4-word state is serialised in every checkpoint; Math.random is never used by the network.

export class Xoshiro128 {
  s: Uint32Array;

  constructor(seed: number | number[] = 1) {
    this.s = new Uint32Array(4);
    if (Array.isArray(seed)) { for (let i = 0; i < 4; i++) this.s[i] = seed[i] >>> 0; return; }
    let x = seed >>> 0;
    for (let i = 0; i < 4; i++) {
      // splitmix32
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      this.s[i] = (z ^ (z >>> 16)) >>> 0;
    }
  }

  /** Next 32-bit unsigned integer. */
  nextU32(): number {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  }

  /** Uniform in [0, 1). */
  next(): number { return this.nextU32() / 4294967296; }

  /** Standard normal (Box-Muller, one value per call). */
  normal(): number {
    const u = Math.max(1e-12, this.next()), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Integer in [0, n). */
  int(n: number): number { return Math.floor(this.next() * n); }

  state(): number[] { return Array.from(this.s); }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

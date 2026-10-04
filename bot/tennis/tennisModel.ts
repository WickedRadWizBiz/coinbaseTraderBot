// Tennis scoring model: point -> game -> set -> match, with the real rules, used to measure how
// far along a match is.
//  - Games: first to 4 points, win by 2 (deuce/advantage).
//  - Sets: first to 6 games, win by 2; at 6-6 a tiebreak (first to 7 points, win by 2). The first
//    tiebreak server serves 1 point, then serves alternate every 2 points; the other player serves
//    first in the next set.
//  - Final set at the Grand Slams (since 2022): at 6-6 a 10-point tiebreak.
//  - Best of 3 sets on the ATP tour, best of 5 in Grand Slam main draws.
// Each player wins their own service points with a fixed probability (the standard iid-point
// model; Klaassen & Magnus 2001). From any score it gives P(player A wins) and the mean and variance
// of the points still to play, so progress can be expressed in expected points rather than minutes:
// a lopsided match is short, a tight one with tiebreaks is long.

export interface MatchFormat {
  bestOf: 3 | 5;
  /** Final-set tiebreak target (10 at the Slams, 7 elsewhere). */
  finalTiebreak: 7 | 10;
}

/** Live score. Points are counted (0,1,2,3,4...), tiebreak points likewise. */
export interface TennisScore {
  setsA: number; setsB: number;
  gamesA: number; gamesB: number;
  pointsA: number; pointsB: number;
  /** true when player A serves the current game (or served first in the current tiebreak). */
  serverA?: boolean;
}

export interface Moments { pA: number; mean: number; m2: number }

const other = (s: 0 | 1): 0 | 1 => (s === 0 ? 1 : 0);

/** Model for one pair of serve-point win probabilities and a format. */
export class TennisModel {
  private readonly memo = new Map<string, Moments>();
  private readonly toWin: number;

  /** @param spA P(A wins a point on A's serve); @param spB P(B wins a point on B's serve). */
  constructor(readonly spA: number, readonly spB: number, readonly format: MatchFormat) {
    this.toWin = format.bestOf === 5 ? 3 : 2;
  }

  /** P(A wins the point) when `server` serves. */
  private q(server: 0 | 1): number {
    return server === 0 ? this.spA : 1 - this.spB;
  }

  /** Moments of the rest of the match from a score (server: 0 = A serves this game / served first in the tiebreak). */
  from(sa: number, sb: number, ga: number, gb: number, pa: number, pb: number, server: 0 | 1): Moments {
    if (sa >= this.toWin) return { pA: 1, mean: 0, m2: 0 };
    if (sb >= this.toWin) return { pA: 0, mean: 0, m2: 0 };
    const tb = ga === 6 && gb === 6;
    const target = tb ? (sa === this.toWin - 1 && sb === this.toWin - 1 ? this.format.finalTiebreak : 7) : 4;
    // Tied at deuce (or at target-1 all in a tiebreak): resolve in closed form. Points come in pairs
    // until one player wins both; the number of pairs is geometric and independent of the winner.
    if (pa === pb && pa >= target - 1) {
      let pAA: number, pBB: number;
      if (tb) {
        pAA = this.q(0) * this.q(1);
        pBB = (1 - this.q(0)) * (1 - this.q(1));
      } else {
        const w = this.q(server);
        pAA = w * w;
        pBB = (1 - w) * (1 - w);
      }
      const r = pAA + pBB;
      const pw = pAA / r;
      const n1 = 2 / r;
      const n2 = (4 * (2 - r)) / (r * r);
      const a = this.afterUnit(sa, sb, ga, gb, server, tb, true);
      const b = this.afterUnit(sa, sb, ga, gb, server, tb, false);
      const eR = pw * a.mean + (1 - pw) * b.mean;
      return { pA: pw * a.pA + (1 - pw) * b.pA, mean: n1 + eR, m2: n2 + 2 * n1 * eR + pw * a.m2 + (1 - pw) * b.m2 };
    }
    if (pa >= target && pa - pb >= 2) return this.afterUnit(sa, sb, ga, gb, server, tb, true);
    if (pb >= target && pb - pa >= 2) return this.afterUnit(sa, sb, ga, gb, server, tb, false);
    const key = `${sa},${sb},${ga},${gb},${pa},${pb},${server}`;
    const hit = this.memo.get(key);
    if (hit) return hit;
    const k = pa + pb;
    const ps: 0 | 1 = tb ? (Math.floor((k + 1) / 2) % 2 === 0 ? server : other(server)) : server;
    const w = this.q(ps);
    const A = this.from(sa, sb, ga, gb, pa + 1, pb, server);
    const B = this.from(sa, sb, ga, gb, pa, pb + 1, server);
    const eR = w * A.mean + (1 - w) * B.mean;
    const res = { pA: w * A.pA + (1 - w) * B.pA, mean: 1 + eR, m2: 1 + 2 * eR + w * A.m2 + (1 - w) * B.m2 };
    this.memo.set(key, res);
    return res;
  }

  /** State after a game or tiebreak ends. */
  private afterUnit(sa: number, sb: number, ga: number, gb: number, server: 0 | 1, tb: boolean, aWon: boolean): Moments {
    if (tb) return aWon ? this.from(sa + 1, sb, 0, 0, 0, 0, other(server)) : this.from(sa, sb + 1, 0, 0, 0, 0, other(server));
    const na = ga + (aWon ? 1 : 0);
    const nb = gb + (aWon ? 0 : 1);
    const next = other(server);
    if (na >= 6 && na - nb >= 2) return this.from(sa + 1, sb, 0, 0, 0, 0, next);
    if (nb >= 6 && nb - na >= 2) return this.from(sa, sb + 1, 0, 0, 0, 0, next);
    return this.from(sa, sb, na, nb, 0, 0, next);
  }

  /** From the first point, averaged over who serves first. */
  start(): { pA: number; mean: number; sd: number } {
    const a = this.from(0, 0, 0, 0, 0, 0, 0);
    const b = this.from(0, 0, 0, 0, 0, 0, 1);
    const mean = (a.mean + b.mean) / 2;
    const m2 = (a.m2 + b.m2) / 2;
    return { pA: (a.pA + b.pA) / 2, mean, sd: Math.sqrt(Math.max(0, m2 - mean * mean)) };
  }

  /** Remaining points from a live score (server unknown -> averaged). */
  remaining(s: TennisScore): { pA: number; mean: number; sd: number } {
    const at = (srv: 0 | 1) => this.from(s.setsA, s.setsB, s.gamesA, s.gamesB, s.pointsA, s.pointsB, srv);
    const ms = s.serverA === undefined ? [at(0), at(1)] : [at(s.serverA ? 0 : 1)];
    const mean = ms.reduce((x, m) => x + m.mean, 0) / ms.length;
    const m2 = ms.reduce((x, m) => x + m.m2, 0) / ms.length;
    return { pA: ms.reduce((x, m) => x + m.pA, 0) / ms.length, mean, sd: Math.sqrt(Math.max(0, m2 - mean * mean)) };
  }

  /** Expected points in one service game (average of both servers), for converting a score to points played. */
  pointsPerGame(): number {
    const g = (w: number) => {
      // Closed form: points to reach 4 or deuce, plus the deuce tail.
      const l = 1 - w;
      const p40 = [4 * w ** 4 + 4 * l ** 4, 5 * 4 * (w ** 4 * l + l ** 4 * w), 6 * 10 * (w ** 4 * l ** 2 + l ** 4 * w ** 2)];
      const pDeuce = 20 * w ** 3 * l ** 3;
      return p40[0] + p40[1] + p40[2] + pDeuce * (6 + 2 / (w * w + l * l));
    };
    return (g(this.spA) + g(this.spB)) / 2;
  }
}

const cache = new Map<string, TennisModel>();

/**
 * Serve-point probabilities implied by a match price: spA = base + d, spB = base - d, with d solved
 * so that P(A wins the match) equals the price. `base` is the tour-average serve-point win rate.
 */
export function impliedModel(pA: number, format: MatchFormat, base = 0.64): TennisModel {
  const p = Math.min(0.995, Math.max(0.005, Math.round(pA * 200) / 200));
  const key = `${p},${format.bestOf},${format.finalTiebreak},${base}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let lo = -Math.min(base - 0.3, 0.95 - base);
  let hi = -lo;
  for (let i = 0; i < 30; i++) {
    const d = (lo + hi) / 2;
    if (new TennisModel(base + d, base - d, format).start().pA < p) lo = d;
    else hi = d;
  }
  const d = (lo + hi) / 2;
  const m = new TennisModel(base + d, base - d, format);
  if (cache.size > 500) cache.clear();
  cache.set(key, m);
  return m;
}

const phi = (z: number) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
/** Standard normal CDF (Abramowitz-Stegun 7.1.26). */
function Phi(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/**
 * Progress after `played` points when the match length is ~N(mean, sd): played / (played + E[N - played | N > played]).
 * Never reaches 1 on time alone: a match running long is assumed to have more to go.
 */
export function timeProgress(played: number, mean: number, sd: number): number {
  if (played <= 0) return 0;
  const s = Math.max(1, sd);
  const z = (played - mean) / s;
  const tail = Math.max(1e-12, 1 - Phi(z));
  const rem = Math.max(1, mean + (s * phi(z)) / tail - played);
  return played / (played + rem);
}

/** Progress from a live score: points already played (estimated from games) vs expected remaining. */
export function scoreProgress(m: TennisModel, s: TennisScore): number {
  const games = (s.setsA + s.setsB) * 10 + s.gamesA + s.gamesB; // ~10 games per completed set
  const played = games * m.pointsPerGame() + s.pointsA + s.pointsB;
  const rem = m.remaining(s).mean;
  return played + rem > 0 ? played / (played + rem) : 0;
}

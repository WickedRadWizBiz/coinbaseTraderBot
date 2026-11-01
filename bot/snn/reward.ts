/**
 * Reward, critic and dopamine for the SNN (design: snn-lead/dopamine-fear-memory-design.md, phase P2b-1).
 * Pure functions and small state objects, no I/O, so paper, live and the Windows trainer run the same code.
 *
 *   r = realized P&L after fees - lambda * shortfall          ("eating": the pacer's quota pace, read, not reimplemented)
 *   V = critic(phi)                                             (linear head on the readout's features, delta rule on r)
 *   delta = r - V;  z = delta / running spread of delta
 *   dopamine = 0 for the first `warmup` settled trades and whenever |z| < zFloor (noise never teaches), else z clipped.
 *   energy = learning-rate scale from the pacer: 1 at or above quota pace, down to `minEnergy` far below it.
 */
import type { PacerStatus } from '../risk/quotaPacer';

export interface RewardOpts {
  hourlyUsd?: number;  // quota pace ($/h), 4.50 by Steven's rule
  lambda?: number;     // weight of the pace shortfall ($ of reward per $/h short)
  warmup?: number;     // settled trades before any dopamine (REWARD_FROM_TURN)
  zFloor?: number;     // |z| below this is noise (Z_FLOOR)
  zMax?: number;       // clip on the dopamine signal
  spreadDecay?: number; // EW decay of the running spread of delta
  priorSd?: number;    // starting spread of delta, $ (so the first trades are not read as huge surprises)
  criticLr?: number;   // critic delta-rule rate
  minEnergy?: number;  // floor of the learning-rate scale when far below pace
}
const D: Required<RewardOpts> = { hourlyUsd: 4.5, lambda: 0.1, warmup: 5, zFloor: 1, zMax: 3, spreadDecay: 0.95, priorSd: 1.5, criticLr: 0.02, minEnergy: 0.25 };

type PaceView = Pick<PacerStatus, 'realized24hUsd' | 'elapsedSec'>;

/** Realized $/h over the pacer's running cycle (undefined before a minute has passed). */
export function realizedPace(s: PaceView | undefined): number | undefined {
  if (!s || !Number.isFinite(s.realized24hUsd) || !(s.elapsedSec >= 60)) return undefined;
  return s.realized24hUsd / (s.elapsedSec / 3600);
}

/** How far realized pace runs below quota, $/h, at least 0 (0 when unknown). */
export function paceShortfall(s: PaceView | undefined, hourlyUsd = D.hourlyUsd): number {
  const p = realizedPace(s);
  return p === undefined ? 0 : Math.max(0, hourlyUsd - p);
}

/** One settled trade's reward. */
export function reward(pnlAfterFees: number, s: PaceView | undefined, o: RewardOpts = {}): number {
  const q = { ...D, ...o };
  return pnlAfterFees - q.lambda * paceShortfall(s, q.hourlyUsd);
}

/** The ATP term: learning slows when the bot is not eating (below pace) instead of trading stopping. */
export function energy(s: PaceView | undefined, o: RewardOpts = {}): number {
  const q = { ...D, ...o }, p = realizedPace(s);
  if (p === undefined || p >= q.hourlyUsd) return 1;
  return Math.max(q.minEnergy, Math.min(1, q.minEnergy + (1 - q.minEnergy) * Math.max(0, p) / q.hourlyUsd));
}

/** Linear critic on the readout's features. */
export class Critic {
  w: number[];
  constructor(n: number, readonly lr = D.criticLr) { this.w = new Array(n).fill(0); }
  value(phi: number[]): number { let v = 0; for (let i = 0; i < this.w.length; i++) v += this.w[i] * (phi[i] ?? 0); return v; }
  update(phi: number[], r: number): number {
    const d = r - this.value(phi);
    if (Number.isFinite(d)) for (let i = 0; i < this.w.length; i++) this.w[i] += this.lr * d * (phi[i] ?? 0);
    return d;
  }
  toJSON() { return { w: this.w }; }
  load(s: { w: number[] }) { if (s?.w?.length === this.w.length && s.w.every(Number.isFinite)) this.w = s.w.slice(); }
}

export interface DopamineOut { r: number; v: number; delta: number; z: number; dopamine: number; energy: number; turn: number }

/** Dopamine: the critic's reward-prediction error, normalised by its running spread, floored and warmed up. */
export class Dopamine {
  private q: Required<RewardOpts>;
  private varD: number; turn = 0;
  readonly critic: Critic;
  constructor(nFeatures: number, o: RewardOpts = {}) {
    this.q = { ...D, ...o }; this.varD = this.q.priorSd ** 2; this.critic = new Critic(nFeatures, this.q.criticLr);
  }
  /** Feed one settled trade; returns the signal to scale eligibility tags by (0 = do not learn). */
  settle(phi: number[], pnlAfterFees: number, pacer?: PaceView): DopamineOut {
    const r = reward(pnlAfterFees, pacer, this.q), v = this.critic.value(phi), delta = r - v;
    const sd = Math.sqrt(Math.max(this.varD, 1e-9)), z = delta / sd;
    this.turn++;
    const live = this.turn > this.q.warmup && Math.abs(z) >= this.q.zFloor;
    const dopamine = live ? Math.max(-this.q.zMax, Math.min(this.q.zMax, z)) : 0;
    if (Number.isFinite(delta)) { const a = this.q.spreadDecay; this.varD = a * this.varD + (1 - a) * delta * delta; this.critic.update(phi, r); }
    return { r, v, delta, z, dopamine, energy: energy(pacer, this.q), turn: this.turn };
  }
  toJSON() { return { varD: this.varD, turn: this.turn, critic: this.critic.toJSON() }; }
  load(s: { varD: number; turn: number; critic: { w: number[] } }) {
    if (!s) return;
    if (Number.isFinite(s.varD) && s.varD > 0) this.varD = s.varD;
    if (Number.isFinite(s.turn)) this.turn = s.turn;
    this.critic.load(s.critic);
  }
}

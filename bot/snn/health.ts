// SNN health metrics (PDF section 5.3). A breach of a "freeze" metric freezes all learning and
// drops the SNN to shadow (alpha = 0 in the blender); alerts are logged only. Learning resumes
// after every freeze metric has been back in band for `recoverSec`.
//
//   metric                               band / trigger                                    action
//   population firing rate per level     [0.2x, 5x] of reference, sustained > 5 min        freeze
//   E/I balance (L2/3 exc vs inh input)  reference +/- 30% (sustained > 5 min)             freeze
//   BCM theta_M drift                    theta in [0.5x, 2x] of initial; |dtheta/dt| cap   freeze
//   weight saturation                    fraction at bounds < 5%                           freeze
//   fast-slow weight divergence          |w_f - w_s| / |w_s| < 0.1                          freeze
//   governor G                           G >= 0.9 < 10% of the day                         freeze
//                                        G stuck at a bound > 1 h                          alert
//   prediction-error norm                z > 6 clip; > 10 for 3 steps freeze PC            (column)
//   surprise S_t                         logged; never raises c                            -
//   salience persistence                 same top asset > 90% of a 6 h window              alert
//   readout calibration                  rolling reliability slope 0.8-1.2                 shadow*
//   NaN/Inf                              any -> restore last checkpoint                    (network)
//   latency p99                          > 150 ms -> skip the SNN vote                     (host)
// The reference is taken after calibSec (3 h: two BCM rate time constants, so theta_M has
// converged) unless an offline reference ships in the model file.
// * Calibration only drops to shadow: freezing the readout would also freeze the only thing that
//   can bring its calibration back into band.

export interface HealthRef { rateL0: number; rateL1: number; rateE: number; rateI: number; ei: number; theta: number; surprise: number; ts: number }

export interface HealthSample {
  rateL0: number; rateL1: number; rateE: number; rateI: number; ei: number; theta: number;
  fSat: number; divergence: number; G: number[]; surprise: number; topSalience?: string; calSlope?: number; calN: number;
}

export interface Breach { metric: string; value: number; band: string; action: 'freeze' | 'shadow' | 'alert'; since: number }

export interface HealthOpts { calibSec: number; sustainSec: number; recoverSec: number; thetaDriftPerHour: number }
export const DEFAULT_HEALTH: HealthOpts = { calibSec: 3 * 3600, sustainSec: 300, recoverSec: 1800, thetaDriftPerHour: 0.5 };

export class SnnHealth {
  ref?: HealthRef;
  private start = 0;
  private readonly outSince = new Map<string, number>();
  private lastMinute = 0;
  private readonly gHigh: number[] = [];
  private readonly gBound = new Map<number, number>();
  private readonly top: string[] = [];
  private lastTheta?: { ts: number; v: number };
  private inBandSince = 0;
  freezeLearning = false;
  shadow = false;
  breaches: Breach[] = [];
  alerts: string[] = [];

  constructor(private readonly o: HealthOpts = DEFAULT_HEALTH) {}

  observe(now: number, m: HealthSample): void {
    if (!this.start) this.start = now;
    if (!this.ref) {
      if (now - this.start >= this.o.calibSec * 1000) this.ref = { rateL0: m.rateL0, rateL1: m.rateL1, rateE: m.rateE, rateI: m.rateI, ei: m.ei, theta: m.theta, surprise: m.surprise, ts: now };
      this.shadow = true; // no vote before the reference exists
      return;
    }
    const r = this.ref;
    const out: Breach[] = [];
    const sustained = (metric: string, bad: boolean, value: number, band: string, action: Breach['action'], sustainSec = this.o.sustainSec) => {
      if (!bad) { this.outSince.delete(metric); return; }
      const since = this.outSince.get(metric) ?? now;
      this.outSince.set(metric, since);
      if (now - since >= sustainSec * 1000) out.push({ metric, value, band, action, since });
    };
    for (const k of ['rateL0', 'rateL1', 'rateE', 'rateI'] as const) {
      if (!(r[k] > 0)) continue;
      const x = m[k] / r[k];
      sustained(`firing_${k}`, x < 0.2 || x > 5, x, '[0.2x, 5x] of reference', 'freeze');
    }
    if (r.ei > 0 && Number.isFinite(m.ei)) { const x = m.ei / r.ei; sustained('ei_balance', x < 0.7 || x > 1.3, x, 'reference +/-30%', 'freeze'); }
    if (r.theta > 0) {
      const x = m.theta / r.theta;
      sustained('bcm_theta', x < 0.5 || x > 2, x, '[0.5x, 2x] of initial', 'freeze', 0);
      if (this.lastTheta && now - this.lastTheta.ts >= 600_000) {
        const rate = Math.abs(m.theta - this.lastTheta.v) / r.theta / ((now - this.lastTheta.ts) / 3_600_000);
        sustained('bcm_theta_drift', rate > this.o.thetaDriftPerHour, rate, `|dtheta/dt| < ${this.o.thetaDriftPerHour}/h`, 'freeze', 0);
        this.lastTheta = { ts: now, v: m.theta };
      }
      if (!this.lastTheta) this.lastTheta = { ts: now, v: m.theta };
    }
    sustained('weight_saturation', m.fSat >= 0.05, m.fSat, '< 5% at bounds', 'freeze', 0);
    sustained('fast_slow_divergence', m.divergence >= 0.1, m.divergence, '< 0.1', 'freeze', 0);
    if (m.calN >= 100 && m.calSlope !== undefined && Number.isFinite(m.calSlope)) sustained('readout_calibration', m.calSlope < 0.8 || m.calSlope > 1.2, m.calSlope, 'slope 0.8-1.2', 'shadow', 0);
    // Minute-sampled windows: governor time-high and stuck, salience lock-in.
    if (now - this.lastMinute >= 60_000) {
      this.lastMinute = now;
      this.gHigh.push(m.G.some((g) => g >= 0.9) ? 1 : 0);
      if (this.gHigh.length > 1440) this.gHigh.shift();
      m.G.forEach((g, i) => {
        const atBound = g >= 0.99 || g <= 1e-6;
        if (!atBound) this.gBound.delete(i);
        else if (!this.gBound.has(i)) this.gBound.set(i, now);
      });
      if (m.topSalience) { this.top.push(m.topSalience); if (this.top.length > 360) this.top.shift(); }
    }
    const fracHigh = this.gHigh.length >= 60 ? this.gHigh.reduce((a, b) => a + b, 0) / this.gHigh.length : 0;
    sustained('governor_high', fracHigh >= 0.1, fracHigh, 'G >= 0.9 < 10% of day', 'freeze', 0);
    for (const [i, since] of this.gBound) if (now - since > 3_600_000) out.push({ metric: `governor_stuck_${i}`, value: m.G[i], band: 'not at a bound > 1 h', action: 'alert', since });
    if (this.top.length >= 360) {
      const counts = new Map<string, number>();
      for (const t of this.top) counts.set(t, (counts.get(t) ?? 0) + 1);
      const [best, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (n / this.top.length > 0.9) out.push({ metric: 'salience_lock_in', value: n / this.top.length, band: `same top (${best}) <= 90% of 6 h`, action: 'alert', since: now });
    }
    this.breaches = out;
    this.alerts = out.filter((b) => b.action === 'alert').map((b) => `${b.metric}: ${b.value.toFixed(3)} (${b.band})`);
    const freezeNow = out.some((b) => b.action === 'freeze');
    if (freezeNow) { this.freezeLearning = true; this.inBandSince = 0; }
    else if (this.freezeLearning) {
      if (!this.inBandSince) this.inBandSince = now;
      if (now - this.inBandSince >= this.o.recoverSec * 1000) this.freezeLearning = false;
    }
    this.shadow = this.freezeLearning || out.some((b) => b.action === 'shadow');
  }

  state() {
    return { ref: this.ref ?? null, start: this.start, freezeLearning: this.freezeLearning, shadow: this.shadow, gHigh: this.gHigh, top: this.top, outSince: [...this.outSince], gBound: [...this.gBound], lastTheta: this.lastTheta ?? null, inBandSince: this.inBandSince, lastMinute: this.lastMinute };
  }

  restore(s: ReturnType<SnnHealth['state']>): void {
    this.ref = s.ref ?? undefined; this.start = s.start; this.freezeLearning = s.freezeLearning; this.shadow = s.shadow;
    this.gHigh.splice(0, this.gHigh.length, ...s.gHigh); this.top.splice(0, this.top.length, ...s.top);
    this.outSince.clear(); for (const [k, v] of s.outSince) this.outSince.set(k, v);
    this.gBound.clear(); for (const [k, v] of s.gBound) this.gBound.set(k, v);
    this.lastTheta = s.lastTheta ?? undefined; this.inBandSince = s.inBandSince; this.lastMinute = s.lastMinute;
  }
}

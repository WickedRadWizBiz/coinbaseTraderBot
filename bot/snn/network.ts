// The multi-level cortex-like SNN: one column per whitelisted market (asset x horizon), a 1 s
// market-time clock, cross-column lateral inhibition -> salience, an L5 readout per column trained
// by settlement through per-contract tags, the health monitor and checkpointing.
//
// Determinism: seeded xoshiro128** (connectivity per column is seeded from seed ^ hash(key), so it
// does not depend on the order columns appear), fixed iteration order (columns sorted by key),
// no Math.random, no allocation-order dependence. Same tick log + same params => bit-identical
// outputs; checkpoint -> restore -> continue equals an uninterrupted run.

import { calibrationSlope, divisiveNormalization, isotonic, logit, sigmoid, wcStepRk2, WC_PARAMS } from './formulas';
import { Column, N_BASE, type ColumnInput, type TypedArr } from './column';
import { DEFAULT_HEALTH, SnnHealth, type HealthOpts, type HealthRef } from './health';
import { DEFAULT_SNN, versionHash, type SnnParams } from './params';
import { Readout, type ThresholdRole } from './readout';

export type { ColumnInput } from './column';

export interface ContractQuery {
  ticker: string;
  /** Tennis (kind 'match'): the threshold distance is given directly as d = logit(model P(A)),
   *  and the life fraction as 1 - progress; spot/sigma/strike are unused. */
  d?: number;
  lifeFrac?: number;
  /** Column key (asset-horizon). */
  column: string;
  kind: 'updown' | 'greater' | 'less' | 'between' | string;
  strike?: number;
  cap?: number;
  spot: number;
  /** Volatility per sqrt(second) and seconds to close. */
  sigma: number;
  tauSec: number;
  /** Contract life in seconds (for the life fraction). */
  lifeSec: number;
  /** Settlement event (asset + close time): unit of evidence and isotonic group. */
  eventKey: string;
  /** Store a tag for the settlement label (scanned while tradable). */
  tag: boolean;
}

export interface ContractScore {
  ticker: string;
  column: string;
  eventKey: string;
  /** p_snn for this contract (after the strike-monotonicity projection). */
  p: number;
  /** Raw readout P(index > threshold) per role, before projection. */
  pExceed: Partial<Record<ThresholdRole, number>>;
  /** Column surprise S_t, reference S0 and governor G (the blender turns these into c). */
  surprise: number;
  surprise0: number;
  G: number;
}

export interface SnnStepResult {
  salience: Record<string, number>;
  top?: string;
  steps: number;
}

/** A column's market-direction call: P(price higher in horizonSec), the expected absolute move
 *  (crypto: bps; tennis: probability points x 1e4), and how well the head has scored so far. */
export interface DirectionPred {
  key: string; asset: string; kind: 'crypto' | 'tennis'; horizonSec: number;
  pUp: number; expMove: number; expSignedMove: number;
  labelled: number; brier: number | null;
}

interface DirTag { ts: number; phi: Float32Array; p: number; price0: number }

export interface SnnModelFile {
  version: string;
  params: SnnParams;
  /** Offline-trained weights by column key (base64 Float32 per array name). */
  columns?: Record<string, Record<string, string>>;
  readouts?: Record<string, number[]>;
  dirReadouts?: Record<string, number[]>;
  healthRef?: HealthRef;
  trainedAt?: string;
  notes?: string;
}

const DT_MS = 1000;

export function priorWeights(nFeat: number, slope: number): Float64Array {
  // p_snn starts as a crude fair value P(index > K) ~ sigma(1.7 d) on the clipped-d feature (d/4).
  const w = new Float64Array(nFeat);
  w[1] = slope * 4;
  return w;
}

export class SnnNetwork {
  readonly p: SnnParams;
  readonly version: string;
  readonly columns = new Map<string, Column>();
  readonly readouts = new Map<string, Readout>();
  /** Direction heads (one per column): trained continuously on realised price moves, traded or not. */
  readonly dirReadouts = new Map<string, Readout>();
  readonly dirTags = new Map<string, DirTag[]>();
  readonly dirStats = new Map<string, { absMove: number; n: number }>();
  readonly health: SnnHealth;
  readonly wc = new Map<string, { E: number; I: number }>();
  /** Proxy: EWMA BTC-ETH return co-moments per horizon (correlation feature vs gap junctions). */
  readonly corr = new Map<string, { ab: number; aa: number; bb: number }>();
  lastTs = 0;
  steps = 0;
  salience: Record<string, number> = {};
  top?: string;
  private readonly inputs = new Map<string, ColumnInput>();
  private readonly lastTag = new Map<string, number>();
  private readonly whitelist?: string[];
  private readonly preset?: SnnModelFile;
  private lastGood?: string;
  private lastGoodTs = 0;
  nanRestores = 0;
  /** Offline training only: accumulate e-prop eligibility in columns that carry an `elig` array. */
  training = false;

  constructor(p: SnnParams = DEFAULT_SNN, opts: { whitelist?: string[]; model?: SnnModelFile; health?: HealthOpts } = {}) {
    this.p = p;
    this.version = versionHash(p);
    this.whitelist = opts.whitelist?.length ? opts.whitelist : undefined;
    this.preset = opts.model;
    this.health = new SnnHealth(opts.health ?? DEFAULT_HEALTH);
    if (opts.model?.healthRef) this.health.ref = opts.model.healthRef;
  }

  /** Get or create a column (whitelist-only; at most maxColumns). The SNN can never add assets. */
  column(key: string, asset: string): Column | undefined {
    let c = this.columns.get(key);
    if (c) return c;
    const tennis = key.startsWith('TEN:');
    if (!tennis && this.whitelist && !this.whitelist.includes(key) && !this.whitelist.includes(asset)) return undefined;
    const count = [...this.columns.keys()].filter((k) => k.startsWith('TEN:') === tennis).length;
    if (count >= (tennis ? this.p.maxTennisColumns : this.p.maxColumns)) return undefined;
    c = new Column(key, asset, this.p, this.columns.size);
    const pre = this.preset?.columns?.[key];
    if (pre) for (const [name, b64] of Object.entries(pre)) copyInto(c.arrays()[name], decodeArr(b64, c.arrays()[name]));
    this.columns.set(key, c);
    const ro = new Readout(c.nFeat, { eta: this.p.readoutEta, cap: this.p.readoutCap, tauC: this.p.tauC, eps: this.p.eps, tagsPerContract: this.p.tagsPerContract, maxTagged: this.p.maxTaggedContracts, traceTauSec: this.p.traceTauSec, useTags: this.p.flags.tags },
      this.preset?.readouts?.[key] ?? priorWeights(c.nFeat, this.p.priorSlope));
    this.readouts.set(key, ro);
    const dir = new Readout(c.nFeat, { eta: this.p.dirEta, cap: this.p.dirCap, tauC: this.p.tauC, eps: this.p.eps, tagsPerContract: 1, maxTagged: 1, traceTauSec: this.p.traceTauSec, useTags: true },
      (this.preset as { dirReadouts?: Record<string, number[]> } | undefined)?.dirReadouts?.[key]);
    this.dirReadouts.set(key, dir);
    this.dirTags.set(key, []);
    return c;
  }

  /** Drop a column (a tennis match that ended): its state, readouts and pending tags. */
  removeColumn(key: string): void {
    this.columns.delete(key); this.readouts.delete(key); this.dirReadouts.delete(key); this.dirTags.delete(key); this.dirStats.delete(key); this.inputs.delete(key);
  }

  /** Direction calls of every column (state-only features: d = 0, no contract). */
  directions(): DirectionPred[] {
    return this.sortedColumns().map((c) => {
      const ro = this.dirReadouts.get(c.key)!;
      const pUp = ro.predict(c.features(0, 0, this.extras(c)));
      const st = this.dirStats.get(c.key);
      const expMove = st?.absMove ?? 0;
      return {
        key: c.key, asset: c.asset, kind: c.kind, horizonSec: c.horizonSec, pUp, expMove, expSignedMove: (2 * pUp - 1) * expMove,
        labelled: ro.history.length, brier: Number.isFinite(ro.brierSlow) ? ro.brierSlow : null,
      };
    });
  }

  /** Direction heads: tag the state every dirEverySec; label each tag when its horizon has passed
   *  (y = price higher than at the tag). Runs every step whether or not anything is traded. */
  private stepDirections(ts: number, cols: Column[]): void {
    const sample = ts % (this.p.dirEverySec * 1000) === 0;
    const learn = !this.health.freezeLearning;
    for (const c of cols) {
      const ro = this.dirReadouts.get(c.key)!, tags = this.dirTags.get(c.key)!;
      const price = c.lastSpot;
      while (tags.length && tags[0].ts + c.horizonSec * 1000 <= ts) {
        const t = tags.shift()!;
        if (!(price > 0) || !(t.price0 > 0) || price === t.price0) continue; // no move: no label
        const y: 0 | 1 = price > t.price0 ? 1 : 0;
        const move = c.kind === 'tennis' ? 1e4 * Math.abs(price - t.price0) : 1e4 * Math.abs(Math.log(price / t.price0));
        const st = this.dirStats.get(c.key) ?? { absMove: move, n: 0 };
        st.absMove += (move - st.absMove) / Math.min(200, ++st.n);
        this.dirStats.set(c.key, st);
        ro.tag('dir', 'greater', 'strike', t.phi, t.p, t.ts);
        ro.settle('dir', y ? 'yes' : 'no', ts, 1 - this.p.govDelta * c.G, learn);
      }
      if (sample && price > 0) {
        const phi = c.features(0, 0, this.extras(c));
        tags.push({ ts, phi: Float32Array.from(phi), p: ro.predict(phi), price0: price });
      }
    }
  }

  private sortedColumns(): Column[] {
    return [...this.columns.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** Advance the 1 s clock to `now` with the latest inputs (piecewise-constant within the gap). */
  step(now: number, inputs: ColumnInput[]): SnnStepResult {
    for (const inp of [...inputs].sort((a, b) => (a.key < b.key ? -1 : 1))) if (this.column(inp.key, inp.asset)) this.inputs.set(inp.key, inp);
    const t = Math.floor(now / DT_MS) * DT_MS;
    if (!this.lastTs) this.lastTs = t - DT_MS;
    let n = Math.floor((t - this.lastTs) / DT_MS);
    if (n <= 0) return { salience: this.salience, top: this.top, steps: 0 };
    if (n > this.p.maxCatchUpSteps) {
      // Long gap (restart, stall): transient state is stale; weights and tags are kept.
      for (const c of this.columns.values()) c.resetTransient();
      n = 1;
    }
    for (let k = 0; k < n; k++) this.stepOnce(t - (n - 1 - k) * DT_MS, k === 0);
    this.lastTs = t;
    return { salience: this.salience, top: this.top, steps: n };
  }

  private stepOnce(ts: number, first: boolean): void {
    const cols = this.sortedColumns();
    const F = this.p.flags;
    // Lateral inhibition source: other columns' mean I rate (previous step), and gap partners.
    const rateI = cols.map((c) => c.meanRateI());
    const totalI = rateI.reduce((a, b) => a + b, 0);
    const byKey = new Map(cols.map((c) => [c.key, c]));
    const frozen = this.health.freezeLearning;
    cols.forEach((c, i) => {
      const inp = this.inputs.get(c.key) ?? { key: c.key, asset: c.asset };
      const partner = F.gapJunctions ? byKey.get(gapPartner(c.key)) : undefined;
      c.step(inp, first, {
        latInh: F.lateral ? this.p.wLat * (totalI - rateI[i]) : 0,
        gapV: partner?.v2.subarray(this.p.nE),
        dBrier: this.readouts.get(c.key)!.brierDeterioration(),
        refRateE: this.health.ref?.rateE,
        frozen,
        training: this.training,
      });
    });
    // Deferred Wilson-Cowan regime pair per asset group, driven by aggregate L0 activity.
    if (F.wilsonCowan) {
      const byAsset = new Map<string, number[]>();
      for (const c of cols) byAsset.set(c.asset, [...(byAsset.get(c.asset) ?? []), c.meanRateL0()]);
      for (const [asset, rs] of [...byAsset].sort()) {
        const s = this.wc.get(asset) ?? { E: 0, I: 0 };
        this.wc.set(asset, wcStepRk2(s.E, s.I, this.p.wcGain * (rs.reduce((a, b) => a + b, 0) / rs.length) * 10, 0, 1, WC_PARAMS));
      }
    }
    if (F.proxies) {
      for (const c of cols) {
        if (!c.key.startsWith('BTC-')) continue;
        const e = byKey.get(gapPartner(c.key));
        if (!e) continue;
        const m = this.corr.get(c.key.slice(4)) ?? { ab: 0, aa: 0, bb: 0 };
        const k = 1 - Math.exp(-1 / 900);
        m.ab += k * (c.lastRetBp * e.lastRetBp - m.ab); m.aa += k * (c.lastRetBp ** 2 - m.aa); m.bb += k * (e.lastRetBp ** 2 - m.bb);
        this.corr.set(c.key.slice(4), m);
      }
    }
    // Salience: soft divisive normalisation of column E rates (shadow ranking only).
    if (F.lateral && cols.length) {
      const sal = divisiveNormalization(cols.map((c) => c.meanRateE()), this.p.salienceN, this.p.salienceSigma);
      this.salience = Object.fromEntries(cols.map((c, i) => [c.key, sal[i]]));
      let best = -1;
      cols.forEach((c, i) => { if (sal[i] > best) { best = sal[i]; this.top = c.key; } });
    }
    this.stepDirections(ts, cols);
    // Readout two-speed relaxation (multi-rate, exact).
    if ((this.steps + 1) % this.p.slowEverySec === 0) for (const r of [...this.readouts.values(), ...this.dirReadouts.values()]) r.relax(this.p.slowEverySec);
    this.steps++;
    this.observeHealth(ts, cols);
    // NaN/Inf anywhere -> restore the last good in-memory checkpoint.
    if (this.steps % 10 === 0 && cols.some((c) => c.hasNaN())) {
      if (this.lastGood) { this.restore(JSON.parse(this.lastGood)); this.nanRestores++; }
      else for (const c of cols) c.resetTransient();
    } else if (ts - this.lastGoodTs >= 10 * 60_000) {
      this.lastGood = JSON.stringify(this.serialize());
      this.lastGoodTs = ts;
    }
  }

  private observeHealth(ts: number, cols: Column[]): void {
    if (!cols.length) return;
    const avg = (f: (c: Column) => number) => cols.reduce((s, c) => s + f(c), 0) / cols.length;
    const inh = avg((c) => c.inh);
    const hist = [...this.readouts.values()].flatMap((r) => r.history.slice(-300));
    this.health.observe(ts, {
      rateL0: avg((c) => c.rateL0), rateL1: avg((c) => c.rateL1), rateE: avg((c) => c.rateE), rateI: avg((c) => c.rateI),
      ei: inh > 1e-9 ? avg((c) => c.exc) / inh : NaN,
      theta: avg((c) => c.bcmTheta()),
      fSat: this.p.flags.plasticity ? Math.max(...cols.map((c) => c.fSat)) : 0,
      divergence: Math.max(0, ...[...this.readouts.values()].map((r) => r.divergence())),
      G: cols.map((c) => c.G),
      surprise: avg((c) => c.surprise),
      topSalience: this.p.flags.lateral ? this.top : undefined,
      calSlope: hist.length >= 100 ? calibrationSlope(hist.map((h) => h.p), hist.map((h) => h.y)) : undefined,
      calN: hist.length,
    });
  }

  /** Readout extra slots: the deferred mechanisms when enabled, else their cheap proxies (if on). */
  extras(c: Column): [number, number, number] {
    const F = this.p.flags;
    const w = this.wc.get(c.asset);
    const m = this.corr.get(c.key.slice(c.key.indexOf('-') + 1));
    const corr = m && m.aa > 0 && m.bb > 0 ? m.ab / Math.sqrt(m.aa * m.bb) : 0;
    return [
      F.wilsonCowan && w ? w.E : F.proxies ? c.proxyVolRatio() : 0,
      F.wilsonCowan && w ? w.I : F.proxies && (c.asset === 'BTC' || c.asset === 'ETH') ? corr : 0,
      F.izhikevichCH ? c.chBurst : F.proxies ? c.proxyBurst() : 0,
    ];
  }

  /** Score candidate contracts (batched): readout P(index > K) per threshold, isotonic projection
   *  across the strikes of each settlement event, then mapped to each contract's payoff. */
  score(queries: ContractQuery[], now: number): ContractScore[] {
    type Th = { q: ContractQuery; role: ThresholdRole; K: number; p: number; phi: Float64Array };
    const ths: Th[] = [];
    for (const q of queries) {
      const c = this.columns.get(q.column);
      const ro = this.readouts.get(q.column);
      if (!c || !ro) continue;
      if (q.d !== undefined) {
        // Tennis: one threshold, distance given directly.
        if (!Number.isFinite(q.d)) continue;
        const phi = c.features(q.d, q.lifeFrac ?? 0, this.extras(c));
        ths.push({ q, role: 'strike', K: 1, p: ro.predict(phi), phi });
        continue;
      }
      if (!(q.spot > 0) || !(q.sigma > 0) || !(q.tauSec > 0)) continue;
      const roles: [ThresholdRole, number | undefined][] = q.kind === 'less' ? [['cap', q.cap]] : q.kind === 'between' ? [['strike', q.strike], ['cap', q.cap]] : [['strike', q.strike]];
      const life = q.lifeSec > 0 ? Math.min(1, q.tauSec / q.lifeSec) : 0;
      for (const [role, K] of roles) {
        if (!(K && K > 0)) continue;
        const d = Math.log(q.spot / K) / (q.sigma * Math.sqrt(q.tauSec));
        const phi = c.features(d, life, this.extras(c));
        ths.push({ q, role, K, p: ro.predict(phi), phi });
      }
    }
    // Strike monotonicity: within an event, P(index > K) must be non-increasing in K.
    const proj = new Map<Th, number>();
    if (this.p.flags.monotone) {
      const groups = new Map<string, Th[]>();
      for (const t of ths) groups.set(t.q.eventKey, [...(groups.get(t.q.eventKey) ?? []), t]);
      for (const g of groups.values()) {
        const byK = [...new Map(g.map((t) => [t.K, t])).values()].sort((a, b) => a.K - b.K);
        const iso = isotonic(byK.map((t) => t.p));
        const at = new Map(byK.map((t, i) => [t.K, iso[i]]));
        for (const t of g) proj.set(t, at.get(t.K)!);
      }
    }
    const out = new Map<string, ContractScore>();
    for (const t of ths) {
      const c = this.columns.get(t.q.column)!;
      let s = out.get(t.q.ticker);
      if (!s) { s = { ticker: t.q.ticker, column: t.q.column, eventKey: t.q.eventKey, p: NaN, pExceed: {}, surprise: c.surprise, surprise0: this.health.ref?.surprise ?? c.surprise, G: c.G }; out.set(t.q.ticker, s); }
      s.pExceed[t.role] = proj.get(t) ?? t.p;
    }
    for (const s of out.values()) {
      const q = queries.find((x) => x.ticker === s.ticker)!;
      const ps = s.pExceed.strike, pc = s.pExceed.cap;
      s.p = q.kind === 'less' ? 1 - pc! : q.kind === 'between' ? Math.max(1e-4, (ps ?? 0) - (pc ?? 0)) : ps!;
      s.p = Math.min(1 - 1e-4, Math.max(1e-4, s.p));
    }
    // Per-contract tags: the readout's own (unprojected) prediction, so the delta rule is the exact
    // log-loss gradient; at most one tag per contract per tagEverySec.
    for (const t of ths) {
      if (!t.q.tag) continue;
      const k = `${t.q.ticker}:${t.role}`;
      if (now - (this.lastTag.get(k) ?? -Infinity) < this.p.tagEverySec * 1000) continue;
      this.lastTag.set(k, now);
      this.readouts.get(t.q.column)!.tag(t.q.ticker, t.q.kind, t.role, t.phi, t.p, now);
    }
    if (this.lastTag.size > 4 * this.p.maxTaggedContracts) for (const [k, ts] of this.lastTag) if (now - ts > 6 * 3_600_000) this.lastTag.delete(k);
    return [...out.values()];
  }

  /** Settlement: tag lookup -> readout delta rule (scaled by the column governor, off while frozen). */
  settle(ticker: string, result: 'yes' | 'no', now: number): { column?: string; used: number } {
    for (const [key, ro] of this.readouts) {
      if (!ro.tags.has(ticker)) continue;
      const c = this.columns.get(key)!;
      const used = ro.settle(ticker, result, now, 1 - this.p.govDelta * c.G, !this.health.freezeLearning);
      return { column: key, used };
    }
    return { used: 0 };
  }

  status() {
    return {
      version: this.version, steps: this.steps, lastTs: this.lastTs, top: this.top ?? null, salience: this.salience,
      health: { reference: this.health.ref ?? null, freezeLearning: this.health.freezeLearning, shadow: this.health.shadow, breaches: this.health.breaches, alerts: this.health.alerts },
      nanRestores: this.nanRestores,
      columns: this.sortedColumns().map((c) => {
        const ro = this.readouts.get(c.key)!;
        return {
          key: c.key, G: +c.G.toFixed(4), surprise: +c.surprise.toFixed(4), errZ: +c.errZ.toFixed(2), pcFrozen: c.pcFrozen,
          rates: { L0: +c.rateL0.toFixed(4), L1: +c.rateL1.toFixed(4), E: +c.rateE.toFixed(4), I: +c.rateI.toFixed(4) },
          ei: c.inh > 1e-9 ? +(c.exc / c.inh).toFixed(3) : null, fSat: +c.fSat.toFixed(4),
          readout: { tagged: ro.tags.size, updates: ro.updates, settled: ro.history.length, brier: Number.isFinite(ro.brierSlow) ? +ro.brierSlow.toFixed(4) : null, divergence: +ro.divergence().toFixed(4) },
          direction: (() => { const d = this.directions().find((x) => x.key === c.key)!; return { horizonSec: d.horizonSec, pUp: +d.pUp.toFixed(4), expMove: +d.expMove.toFixed(2), labelled: d.labelled, brier: d.brier === null ? null : +d.brier.toFixed(4), pending: this.dirTags.get(c.key)?.length ?? 0 }; })(),
        };
      }),
    };
  }

  // ---- checkpointing -----------------------------------------------------------------------

  serialize(): SnnCheckpoint {
    return {
      version: this.version, lastTs: this.lastTs, steps: this.steps, salience: this.salience, top: this.top ?? null,
      wc: [...this.wc], corr: [...this.corr], health: this.health.state(), lastTag: [...this.lastTag], nanRestores: this.nanRestores,
      columns: this.sortedColumns().map((c) => ({
        key: c.key, asset: c.asset,
        arrays: Object.fromEntries(Object.entries(c.arrays()).map(([k, a]) => [k, encodeArr(a)])),
        scalars: c.scalars(),
        inputs: this.inputs.get(c.key) ?? null,
        dir: (() => {
          const r = this.dirReadouts.get(c.key)!;
          return {
            wf: encodeArr(r.wf), ws: encodeArr(r.ws), brierFast: r.brierFast, brierSlow: r.brierSlow, updates: r.updates, history: r.history.slice(-500),
            tags: (this.dirTags.get(c.key) ?? []).map((t) => ({ ts: t.ts, phi: encodeArr(t.phi), p: t.p, price0: t.price0 })),
            stats: this.dirStats.get(c.key) ?? null,
          };
        })(),
        readout: (() => {
          const r = this.readouts.get(c.key)!;
          return {
            wf: encodeArr(r.wf), ws: encodeArr(r.ws), trace: encodeArr(r.trace), traceTs: r.traceTs, brierFast: r.brierFast, brierSlow: r.brierSlow, updates: r.updates, history: r.history,
            tags: [...r.tags].map(([t, e]) => [t, { kind: e.kind, tags: e.tags.map((g) => ({ phi: encodeArr(g.phi), p: g.p, ts: g.ts, role: g.role })) }]),
          };
        })(),
      })),
    };
  }

  /** Restore a checkpoint (must match the version hash). Columns are recreated in their saved order. */
  restore(cp: SnnCheckpoint): void {
    if (cp.version !== this.version) throw new Error(`SNN checkpoint version ${cp.version} does not match ${this.version}`);
    this.columns.clear(); this.readouts.clear(); this.inputs.clear(); this.dirReadouts.clear(); this.dirTags.clear(); this.dirStats.clear();
    for (const col of cp.columns) {
      const c = new Column(col.key, col.asset, this.p, this.columns.size);
      for (const [k, b64] of Object.entries(col.arrays)) copyInto(c.arrays()[k], decodeArr(b64, c.arrays()[k]));
      c.setScalars(col.scalars);
      this.columns.set(c.key, c);
      if (col.inputs) this.inputs.set(c.key, col.inputs);
      const r = new Readout(c.nFeat, { eta: this.p.readoutEta, cap: this.p.readoutCap, tauC: this.p.tauC, eps: this.p.eps, tagsPerContract: this.p.tagsPerContract, maxTagged: this.p.maxTaggedContracts, traceTauSec: this.p.traceTauSec, useTags: this.p.flags.tags });
      const ro = col.readout;
      copyInto(r.wf, decodeArr(ro.wf, r.wf)); copyInto(r.ws, decodeArr(ro.ws, r.ws)); copyInto(r.trace, decodeArr(ro.trace, r.trace));
      r.traceTs = ro.traceTs; r.brierFast = ro.brierFast ?? NaN; r.brierSlow = ro.brierSlow ?? NaN; r.updates = ro.updates;
      r.history.splice(0, r.history.length, ...ro.history);
      for (const [t, e] of ro.tags) r.tags.set(t, { kind: e.kind, tags: e.tags.map((g) => ({ phi: decodeArr(g.phi, new Float32Array(c.nFeat)) as Float32Array, p: g.p, ts: g.ts, role: g.role })) });
      this.readouts.set(c.key, r);
      const dr = new Readout(c.nFeat, { eta: this.p.dirEta, cap: this.p.dirCap, tauC: this.p.tauC, eps: this.p.eps, tagsPerContract: 1, maxTagged: 1, traceTauSec: this.p.traceTauSec, useTags: true });
      if (col.dir) {
        copyInto(dr.wf, decodeArr(col.dir.wf, dr.wf)); copyInto(dr.ws, decodeArr(col.dir.ws, dr.ws));
        dr.brierFast = col.dir.brierFast ?? NaN; dr.brierSlow = col.dir.brierSlow ?? NaN; dr.updates = col.dir.updates;
        dr.history.splice(0, dr.history.length, ...col.dir.history);
        this.dirTags.set(c.key, col.dir.tags.map((t) => ({ ts: t.ts, phi: decodeArr(t.phi, new Float32Array(c.nFeat)) as Float32Array, p: t.p, price0: t.price0 })));
        if (col.dir.stats) this.dirStats.set(c.key, col.dir.stats);
      } else this.dirTags.set(c.key, []);
      this.dirReadouts.set(c.key, dr);
    }
    this.lastTs = cp.lastTs; this.steps = cp.steps; this.salience = cp.salience; this.top = cp.top ?? undefined;
    this.wc.clear(); for (const [k, v] of cp.wc) this.wc.set(k, v);
    this.corr.clear(); for (const [k, v] of cp.corr ?? []) this.corr.set(k, v);
    this.health.restore(cp.health);
    this.lastTag.clear(); for (const [k, v] of cp.lastTag) this.lastTag.set(k, v);
    this.nanRestores = cp.nanRestores ?? 0;
  }

  /** Offline-trained weights for the model file (research/trainSnn.ts). */
  exportModel(notes?: string): SnnModelFile {
    const trained = ['w1', 'w1s', 'theta1', 'alpha1', 'U1', 'U0'];
    return {
      version: this.version, params: this.p, trainedAt: new Date().toISOString(), notes,
      columns: Object.fromEntries(this.sortedColumns().map((c) => [c.key, Object.fromEntries(trained.map((k) => [k, encodeArr(c.arrays()[k])]))])),
      readouts: Object.fromEntries([...this.readouts].map(([k, r]) => [k, Array.from(r.wf)])),
      dirReadouts: Object.fromEntries([...this.dirReadouts].map(([k, r]) => [k, Array.from(r.wf)])),
      healthRef: this.health.ref,
    };
  }

  /** Column readout probability for one threshold (training helpers). */
  readoutLogit(key: string, phi: Float64Array): number { return this.readouts.get(key)!.logit(phi); }
}

export interface SnnCheckpoint {
  version: string; lastTs: number; steps: number; salience: Record<string, number>; top: string | null;
  wc: [string, { E: number; I: number }][]; corr?: [string, { ab: number; aa: number; bb: number }][]; health: ReturnType<SnnHealth['state']>; lastTag: [string, number][]; nanRestores?: number;
  columns: {
    key: string; asset: string; arrays: Record<string, string>; scalars: Record<string, number | boolean>; inputs: ColumnInput | null;
    dir?: { wf: string; ws: string; brierFast: number | null; brierSlow: number | null; updates: number; history: { p: number; y: number; ts: number }[]; tags: { ts: number; phi: string; p: number; price0: number }[]; stats: { absMove: number; n: number } | null };
    readout: { wf: string; ws: string; trace: string; traceTs: number; brierFast: number | null; brierSlow: number | null; updates: number; history: { p: number; y: number; ts: number }[]; tags: [string, { kind: string; tags: { phi: string; p: number; ts: number; role: ThresholdRole }[] }][] };
  }[];
}

/** BTC <-> ETH columns of the same horizon are gap-junction partners (deferred mechanism). */
export function gapPartner(key: string): string {
  return key.startsWith('BTC-') ? `ETH-${key.slice(4)}` : key.startsWith('ETH-') ? `BTC-${key.slice(4)}` : '';
}

export function encodeArr(a: TypedArr): string {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
}

export function decodeArr(b64: string, like: TypedArr): TypedArr {
  const buf = Buffer.from(b64, 'base64');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (like instanceof Float32Array) return new Float32Array(ab);
  if (like instanceof Float64Array) return new Float64Array(ab);
  if (like instanceof Int32Array) return new Int32Array(ab);
  return new Uint8Array(ab);
}

function copyInto(dst: TypedArr | undefined, src: TypedArr): void {
  if (!dst) return;
  if (dst.length !== src.length) throw new Error(`SNN state shape mismatch (${src.length} vs ${dst.length})`);
  dst.set(src as never);
}

export const FEATURE_BASE = N_BASE;
export { logit, sigmoid };

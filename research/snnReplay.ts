// Replays recordings through the SNN exactly as the engine drives it: one 1 s step per market
// second with the closest-to-the-money contract's encodings per column, batched scoring of every
// open contract every `scoreEverySec`, settlement labels applied when each contract resolves.
// Evaluation is prequential walk-forward with strict timestamps: every prediction is recorded
// before its own label (or any later label) can touch the weights.

import { computeFeatureMap, type MacroEvent } from '../bot/model/featureEngine';
import { priceContract, SETTLEMENT_AVG_SEC } from '../bot/model/fairValue';
import { ladderQuotes } from '../bot/model/ladder';
import { MetaModel } from '../bot/model/metaModel';
import { N_BASE } from '../bot/snn/column';
import { brier, sigmoid } from '../bot/snn/formulas';
import { SnnNetwork, type ColumnInput, type ContractQuery, type SnnModelFile } from '../bot/snn/network';
import type { SnnParams } from '../bot/snn/params';
import { exceedLabel } from '../bot/snn/readout';
import { readRecordings, ReplayState, type RecMarket } from './replay';

export interface SnnRow {
  ticker: string; eventKey: string; column: string; ts: number; day: string; kind: string;
  pModel: number; pSnn: number; mid: number; y: 0 | 1;
  surprise: number; surprise0: number; G: number; volRatio: number;
}

export interface SnnReplayResult {
  rows: SnnRow[];
  net: SnnNetwork;
  stepMs: number[];
  frozenSteps: number;
  steps: number;
  /** Per scoring time: column ranked top by salience vs by readout edge, and the realised captured mispricing of each. */
  ranking: { ts: number; bySalience: number; byEdge: number }[];
  collected: { column: string; phi: Float64Array; y: 0 | 1 }[];
}

export interface SnnReplayOpts {
  params: SnnParams;
  model?: MetaModel;
  snnModel?: SnnModelFile;
  whitelist?: string[];
  from?: number;
  to?: number;
  scoreEverySec?: number;
  noEntryBeforeCloseSec?: number;
  /** Offline training hooks (research/trainSnn.ts). */
  training?: { eprop?: { eta: number }; collect?: boolean };
  calendar?: MacroEvent[];
  onProgress?: (ts: number) => void;
}

export const columnOf = (m: { asset: string; openTime: number; closeTime: number }) => `${m.asset}-${Math.round((m.closeTime - m.openTime) / 60_000)}m`;

export async function replaySnn(dir: string, o: SnnReplayOpts): Promise<SnnReplayResult> {
  const st = new ReplayState();
  const net = new SnnNetwork(o.params, { whitelist: o.whitelist, model: o.snnModel });
  net.training = Boolean(o.training?.eprop);
  const model = o.model ?? MetaModel.identity();
  const scoreEvery = (o.scoreEverySec ?? 60) * 1000;
  const noEntry = (o.noEntryBeforeCloseSec ?? 60) * 1000;
  const pending = new Map<string, Omit<SnnRow, 'y'>[]>();
  const rows: SnnRow[] = [];
  const stepMs: number[] = [];
  const ranking: SnnReplayResult['ranking'] = [];
  type Mid = { col: string; mid: number; p: number; y?: number };
  const pendingRank: { ts: number; sal: string; edge: string; mids: Map<string, Mid> }[] = [];
  const rankRefs = new Map<string, Mid[]>();
  const collected: SnnReplayResult['collected'] = [];
  const eprop = new Map<string, { column: string; elig: Float32Array; p: number; kind: string }>();
  const pendingPhi = new Map<string, { column: string; phi: Float64Array; kind: string; role: 'strike' | 'cap' }[]>();
  let nextSec = 0, frozenSteps = 0, steps = 0;
  const volRef = new Map<string, number>();

  const fx = (m: RecMarket, now: number) => {
    const book = st.books.get(m.ticker), idx = st.index.get(m.asset);
    const bid = book?.bestBid(), ask = book?.bestAsk(), spot = idx?.fresh(now, 3000), vol = idx?.vol(), terms = st.terms(m);
    if (!book?.isUsable(now, 5000) || !bid || !ask || !spot || !vol || !terms) return undefined;
    const tauSec = (m.closeTime - now) / 1000;
    if (tauSec <= 0) return undefined;
    const settle = tauSec <= SETTLEMENT_AVG_SEC ? idx!.settlement(m.closeTime, now, SETTLEMENT_AVG_SEC) : undefined;
    const fv = priceContract(terms, { spot: spot.value, sigmaPerSqrtSec: vol.sigmaPerSqrtSec, tauSec, observedAvg: settle?.avg, observedCount: settle?.n, nu: model.params.tNu });
    if (!fv) return undefined;
    return { book, idx: idx!, bid, ask, spot, vol, terms, tauSec, fv, mid: (bid.price + ask.price) / 2 };
  };
  const featureMap = (m: RecMarket, now: number, x: NonNullable<ReturnType<typeof fx>>) => computeFeatureMap({
    now, fairValue: x.fv.pYes, mid: x.mid, tauSec: x.tauSec, sigmaPerSqrtSec: x.vol.sigmaPerSqrtSec, referenceSigma: model.params.referenceSigma, inWindow: x.fv.regime !== 'pre_window',
    book: x.book, micro: st.features.micro.get(m.ticker), index: x.idx, spot: st.spot.get(m.asset), asset: m.asset, usdtd: st.usdtd, btcd: st.btcd,
    closeTs: m.closeTime, asiaRange: st.features.asiaRange.get(m.asset), kind: m.kind, strike: x.terms.strike, cap: x.terms.cap, d2: x.fv.d2, vEff: x.fv.vEff,
    sigmaPricing: x.vol.sigmaPerSqrtSec, tNu: model.params.tNu, bars: st.features.bars.get(m.asset), openTime: m.openTime, calendar: o.calendar, ticker: m.ticker,
    siblings: m.kind === 'updown' ? undefined : ladderQuotes(st.markets.values(), (t) => st.books.get(t), m.asset, m.closeTime),
    perp: st.features.perps.get(m.asset), candles: st.features.candles.get(m.asset),
  });

  const settleMarket = (m: RecMarket) => {
    const out = st.outcome(m);
    const ps = pending.get(m.ticker) ?? [];
    pending.delete(m.ticker);
    if (!out) { eprop.delete(m.ticker); pendingPhi.delete(m.ticker); return; }
    for (const r of ps) rows.push({ ...r, y: out.label });
    const result = out.label ? 'yes' : 'no';
    // e-prop: truncated surrogate gradient for the L1 branch weights through the L1-rate readout features.
    const ep = eprop.get(m.ticker);
    if (ep && o.training?.eprop) {
      const y = exceedLabel(ep.kind, 'strike', result);
      const c = net.columns.get(ep.column), ro = net.readouts.get(ep.column);
      if (y !== undefined && c && ro) {
        const per = o.params.branches * o.params.synPerBranch;
        for (let s = 0; s < c.nSyn; s++) {
          const n = Math.floor(s / per);
          const g = (ep.p - y) * ro.wf[N_BASE + o.params.nE + n] * ep.elig[s];
          c.w1[s] -= o.training.eprop.eta * g;
          c.w1s[s] = c.w1[s];
        }
      }
    }
    eprop.delete(m.ticker);
    for (const t of pendingPhi.get(m.ticker) ?? []) { const y = exceedLabel(t.kind, t.role, result); if (y !== undefined) collected.push({ column: t.column, phi: t.phi, y }); }
    pendingPhi.delete(m.ticker);
    net.settle(m.ticker, result, st.now);
    for (const v of rankRefs.get(m.ticker) ?? []) v.y = out.label;
    rankRefs.delete(m.ticker);
  };

  for await (const e of readRecordings(dir)) {
    if (o.to && e.t >= o.to) break;
    st.apply(e);
    if (o.from && st.now < o.from) continue;
    if (st.now < nextSec) continue;
    const T = Math.floor(st.now / 1000) * 1000;
    nextSec = T + 1000;
    // Settle closed markets (90 s after close, when the official average is fully observed).
    for (const m of [...st.markets.values()]) {
      if (st.now >= m.closeTime + 90_000) { if (!m.recordOnly && m.kind !== 'match') settleMarket(m); st.markets.delete(m.ticker); }
    }
    // L0 inputs: the closest-to-the-money Up/Down or "greater" contract per column.
    const active = [...st.markets.values()].filter((m) => !m.recordOnly && m.kind !== 'match' && st.now >= m.openTime && st.now < m.closeTime);
    const priced = new Map<string, NonNullable<ReturnType<typeof fx>>>();
    for (const m of active) { const x = fx(m, st.now); if (x) priced.set(m.ticker, x); }
    const atm = new Map<string, RecMarket>();
    for (const m of active) {
      const x = priced.get(m.ticker);
      if (!x || (m.kind !== 'updown' && m.kind !== 'greater')) continue;
      const k = columnOf(m), cur = atm.get(k);
      if (!cur || Math.abs(x.fv.d2) < Math.abs(priced.get(cur.ticker)!.fv.d2)) atm.set(k, m);
    }
    const inputs: ColumnInput[] = [];
    for (const [key, m] of atm) {
      const x = priced.get(m.ticker)!;
      const f = featureMap(m, st.now, x);
      inputs.push({ key, asset: m.asset, spot: x.spot.value, mid: x.mid, spread: x.ask.price - x.bid.price, imbalance: f.imbalance, dAtm: x.fv.d2, tauFrac: x.tauSec / Math.max(1, (m.closeTime - m.openTime) / 1000), rsi: Number.isFinite(f.rsi_14_1m) ? 50 + 50 * f.rsi_14_1m : undefined, retZ: f.ret_5m_z });
    }
    const t0 = performance.now();
    net.step(T, inputs);
    if (o.training?.eprop) for (const c of net.columns.values()) if (!c.elig) c.elig = new Float32Array(c.nSyn);
    steps++;
    if (net.health.freezeLearning) frozenSteps++;
    if (T % scoreEvery !== 0) { stepMs.push(performance.now() - t0); continue; }
    // Score every open contract.
    const queries: ContractQuery[] = [];
    for (const m of active) {
      const x = priced.get(m.ticker);
      if (!x) continue;
      queries.push({ ticker: m.ticker, column: columnOf(m), kind: x.terms.kind, strike: x.terms.strike, cap: x.terms.cap, spot: x.spot.value, sigma: x.vol.sigmaPerSqrtSec, tauSec: x.tauSec, lifeSec: (m.closeTime - m.openTime) / 1000, eventKey: `${m.asset}:${m.closeTime}`, tag: m.closeTime - st.now > noEntry });
    }
    const scores = net.score(queries, T);
    stepMs.push(performance.now() - t0);
    const day = new Date(T).toISOString().slice(0, 10);
    const edgeByCol = new Map<string, number[]>();
    const mids = new Map<string, Mid>();
    for (const s of scores) {
      const m = st.markets.get(s.ticker)!, x = priced.get(s.ticker)!, q = queries.find((qq) => qq.ticker === s.ticker)!;
      if (!q.tag) continue;
      const pModel = model.predictDetailed(featureMap(m, T, x), x.fv.pYes).p;
      const ref = volRef.get(m.asset) ?? x.vol.sigmaPerSqrtSec;
      volRef.set(m.asset, ref + (1 - Math.exp(-1 / 1440)) * (x.vol.sigmaPerSqrtSec - ref));
      const arr = pending.get(s.ticker) ?? [];
      arr.push({ ticker: s.ticker, eventKey: s.eventKey, column: s.column, ts: T, day, kind: x.terms.kind, pModel, pSnn: s.p, mid: x.mid, surprise: s.surprise, surprise0: s.surprise0, G: s.G, volRatio: x.vol.sigmaPerSqrtSec / ref });
      pending.set(s.ticker, arr);
      edgeByCol.set(s.column, [...(edgeByCol.get(s.column) ?? []), Math.abs(s.p - x.mid)]);
      mids.set(s.ticker, { col: s.column, mid: x.mid, p: s.p });
      const c = net.columns.get(s.column)!;
      if (o.training?.collect) {
        const roles: ['strike' | 'cap', number | undefined][] = q.kind === 'less' ? [['cap', q.cap]] : q.kind === 'between' ? [['strike', q.strike], ['cap', q.cap]] : [['strike', q.strike]];
        for (const [role, K] of roles) if (K) {
          const d = Math.log(q.spot / K) / (q.sigma * Math.sqrt(q.tauSec));
          pendingPhi.set(s.ticker, [...(pendingPhi.get(s.ticker) ?? []), { column: s.column, phi: c.features(d, Math.min(1, q.tauSec / q.lifeSec), net.extras(c)), kind: q.kind, role }]);
        }
      }
      if (o.training?.eprop && c.elig && (q.kind === 'updown' || q.kind === 'greater')) {
        const d = Math.log(q.spot / q.strike!) / (q.sigma * Math.sqrt(q.tauSec));
        const pRaw = sigmoid(net.readoutLogit(s.column, c.features(d, Math.min(1, q.tauSec / q.lifeSec), net.extras(c))));
        eprop.set(s.ticker, { column: s.column, elig: Float32Array.from(c.elig), p: pRaw, kind: q.kind });
      }
    }
    // Asset-choice shadow test (S5): top column by salience vs by mean readout edge |p_snn - mid|.
    if (edgeByCol.size >= 2 && Object.keys(net.salience).length) {
      const byEdge = [...edgeByCol].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length] as const).sort((a, b) => b[1] - a[1])[0][0];
      const bySal = Object.entries(net.salience).filter(([k]) => edgeByCol.has(k)).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (bySal) {
        pendingRank.push({ ts: T, sal: bySal, edge: byEdge, mids });
        for (const [t, v] of mids) rankRefs.set(t, [...(rankRefs.get(t) ?? []), v]);
      }
    }
    o.onProgress?.(T);
  }
  // Remaining markets that closed inside the recording.
  for (const m of [...st.markets.values()]) if (!m.recordOnly && m.kind !== 'match' && st.now >= m.closeTime + 60_000) settleMarket(m);
  // Captured mispricing of a column choice: mean over its contracts of (y - mid) * sign(p_snn - mid).
  for (const pr of pendingRank) {
    const cap = (col: string) => {
      const xs = [...pr.mids.values()].filter((v) => v.col === col && v.y !== undefined).map((v) => (v.y! - v.mid) * Math.sign(v.p - v.mid));
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
    };
    const a = cap(pr.sal), b = cap(pr.edge);
    if (Number.isFinite(a) && Number.isFinite(b)) ranking.push({ ts: pr.ts, bySalience: a, byEdge: b });
  }
  return { rows, net, stepMs, frozenSteps, steps, ranking, collected };
}

export const meanBrier = (rows: SnnRow[], f: (r: SnnRow) => number) => rows.reduce((a, r) => a + brier(f(r), r.y), 0) / Math.max(1, rows.length);

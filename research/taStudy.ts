// Empirical study of the TA library: for every rule x timeframe and every confluence, what did the
// spot price actually do next? Walks forward over closed 15-minute bars (no look-ahead: each
// timeframe only sees candles closed by then), records each signal's direction, and measures the
// direction-adjusted forward return over the Kalshi horizons (15 and 60 minutes):
//   hit rate, mean excess return (bps, drift removed), a moving-block bootstrap CI and p-value,
//   then a Benjamini-Hochberg false-discovery-rate cut across ALL tested hypotheses
//   (Sullivan-Timmermann-White 1999, Bajgrowicz-Scaillet 2012: many rules => many false edges).
// The result (params/ta_study.json) is what the bot shows next to each live signal; the meta-model
// separately learns how much each reading is worth for the contract (ta / taconf features).
//
//   npm run research:ta -- --assets BTC,ETH,SOL --days 120            (Coinbase history)
//   npm run research:ta -- --recordings data/recordings                (recorded candles)
//   npm run research:ta -- --history data/history                      (years of hourly history:
//                                                                       base 1h, horizons 60/240 min)

import fs from 'fs';
import path from 'path';
import { evaluate, TF_MS, tfState, type TfState } from '../bot/ta/analyzer';
import { aggregate, fromRow, type CandleRow } from '../bot/ta/candleStore';
import type { Candle } from '../bot/ta/indicators';
import type { Timeframe } from '../bot/ta/knowledge';
import { readRecordings } from './replay';
import { rng } from './stats';
import { loadHistory, storedAssets } from './history/candles';

export interface StudyRow {
  id: string;
  kind: 'rule' | 'confluence';
  tf: Timeframe | 'multi';
  horizonMin: number;
  n: number;
  hitRate: number;
  meanBps: number;
  ciLo: number;
  ciHi: number;
  p: number;
  fdrPass: boolean;
}

export interface StudyResult {
  generatedAt: string;
  source: string;
  assets: string[];
  steps: number;
  fdr: number;
  rows: StudyRow[];
}

type History = Partial<Record<Timeframe, Candle[]>>;
const STUDY_TFS: Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];
const WINDOW = 260;

/** Largest index with candle.ts + period <= t (closed by t), via binary search. */
function closedUpTo(cs: Candle[], tf: Timeframe, t: number): number {
  let lo = 0, hi = cs.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (cs[m].ts + TF_MS[tf] <= t) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}

/** Moving-block bootstrap of the mean (blocks keep the serial correlation of overlapping signals). */
function blockBootstrap(xs: number[], block = 8, iters = 2000, seed = 7): { lo: number; hi: number; p: number } {
  const n = xs.length;
  if (n < 2) return { lo: NaN, hi: NaN, p: 1 };
  const r = rng(seed);
  const means: number[] = [];
  const b = Math.min(block, n);
  for (let it = 0; it < iters; it++) {
    let s = 0, k = 0;
    while (k < n) {
      const start = Math.floor(r() * (n - b + 1));
      for (let j = 0; j < b && k < n; j++, k++) s += xs[start + j];
    }
    means.push(s / n);
  }
  means.sort((a, c) => a - c);
  return { lo: means[Math.floor(0.025 * iters)], hi: means[Math.floor(0.975 * iters)], p: (means.filter((m) => m <= 0).length + 1) / (iters + 1) };
}

/** Benjamini-Hochberg: which p-values pass at FDR q. */
export function benjaminiHochberg(ps: number[], q = 0.1): boolean[] {
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let cut = -1;
  order.forEach((o, k) => { if (o.p <= ((k + 1) / ps.length) * q) cut = k; });
  const pass = new Array(ps.length).fill(false);
  for (let k = 0; k <= cut; k++) pass[order[k].i] = true;
  return pass;
}

export function runTaStudy(histories: Record<string, History>, opts: { horizons?: number[]; stride?: number; fdr?: number; minN?: number; source?: string; baseTf?: '15m' | '1h' } = {}): StudyResult {
  const baseTf = opts.baseTf ?? '15m';
  const baseMin = TF_MS[baseTf] / 60_000;
  const horizons = opts.horizons ?? (baseTf === '1h' ? [60, 240] : [15, 60]);
  for (const h of horizons) if (h % baseMin) throw new Error(`horizon ${h} min is not a multiple of the ${baseTf} base`);
  const stride = opts.stride ?? 1;
  const fdr = opts.fdr ?? 0.1;
  const minN = opts.minN ?? 30;
  // (id|tf|kind) -> horizon -> direction-adjusted forward log returns
  const obs = new Map<string, { id: string; kind: 'rule' | 'confluence'; tf: Timeframe | 'multi'; byH: Map<number, { adj: number[]; hits: number }> }>();
  let steps = 0;
  for (const [asset, hist] of Object.entries(histories)) {
    const base = hist[baseTf];
    if (!base || base.length < WINDOW + 10) continue;
    if (hist['1h'] && !hist['4h']) hist['4h'] = aggregate(hist['1h'], TF_MS['4h']);
    const closes = base.map((c) => c.c);
    // Unconditional mean forward return per horizon (drift removed from every signal).
    const drift = new Map(horizons.map((h) => {
      const k = h / baseMin;
      const rs: number[] = [];
      for (let i = 0; i + k < closes.length; i++) rs.push(Math.log(closes[i + k] / closes[i]));
      return [h, rs.reduce((a, x) => a + x, 0) / Math.max(1, rs.length)];
    }));
    const cache = new Map<Timeframe, { idx: number; state?: TfState }>();
    const maxK = Math.max(...horizons) / baseMin;
    for (let i = WINDOW; i + maxK < base.length; i += stride) {
      const t = base[i].ts + TF_MS[baseTf]; // just after bar i closed
      const states: Partial<Record<Timeframe, TfState>> = {};
      for (const tf of STUDY_TFS) {
        const cs = hist[tf];
        if (!cs?.length) continue;
        const j = closedUpTo(cs, tf, t);
        if (j < 30) continue;
        const c = cache.get(tf);
        if (!c || c.idx !== j) cache.set(tf, { idx: j, state: tfState(tf, cs.slice(Math.max(0, j - WINDOW + 1), j + 1)) });
        const st = cache.get(tf)!.state;
        if (st) states[tf] = st;
      }
      const snap = evaluate(asset, states, t);
      steps++;
      const record = (id: string, kind: 'rule' | 'confluence', tf: Timeframe | 'multi', dir: number) => {
        if (!dir) return;
        const key = `${kind}|${id}|${tf}`;
        let o = obs.get(key);
        if (!o) { o = { id, kind, tf, byH: new Map() }; obs.set(key, o); }
        for (const h of horizons) {
          const r = Math.log(closes[i + h / baseMin] / closes[i]);
          const adj = dir * (r - drift.get(h)!);
          let b = o.byH.get(h);
          if (!b) { b = { adj: [], hits: 0 }; o.byH.set(h, b); }
          b.adj.push(adj);
          if (dir * r > 0) b.hits++;
        }
      };
      for (const s of snap.signals) record(s.id, 'rule', s.tf, s.dir);
      for (const c of snap.confluences) record(c.id, 'confluence', 'multi', Math.sign(c.score));
    }
  }
  const rows: StudyRow[] = [];
  for (const o of obs.values()) {
    for (const [h, b] of o.byH) {
      if (b.adj.length < minN) continue;
      const mean = b.adj.reduce((a, x) => a + x, 0) / b.adj.length;
      const bs = blockBootstrap(b.adj, Math.max(2, (h / baseMin) * 2));
      rows.push({ id: o.id, kind: o.kind, tf: o.tf, horizonMin: h, n: b.adj.length, hitRate: b.hits / b.adj.length, meanBps: mean * 1e4, ciLo: bs.lo * 1e4, ciHi: bs.hi * 1e4, p: bs.p, fdrPass: false });
    }
  }
  const pass = benjaminiHochberg(rows.map((r) => r.p), fdr);
  rows.forEach((r, i) => { r.fdrPass = pass[i]; });
  rows.sort((a, b) => a.p - b.p);
  return { generatedAt: new Date().toISOString(), source: opts.source ?? 'candles', assets: Object.keys(histories), steps, fdr, rows };
}

// ---- Data sources -----------------------------------------------------------------------------

const GRAN: Partial<Record<Timeframe, number>> = { '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 };

export async function fetchCoinbaseHistory(asset: string, days: number, tfs: Timeframe[] = ['15m', '1h', '1d'], baseUrl = 'https://api.exchange.coinbase.com'): Promise<History> {
  const out: History = {};
  const end = Date.now();
  for (const tf of tfs) {
    const g = GRAN[tf];
    if (!g) continue;
    const span = 300 * g * 1000;
    const from = end - Math.max(days, tf === '1d' ? 400 : days) * 86_400_000;
    const rows = new Map<number, Candle>();
    for (let s = from; s < end; s += span) {
      const e = Math.min(end, s + span);
      const url = `${baseUrl}/products/${asset}-USD/candles?granularity=${g}&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`;
      const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'kalshi-bot-ta-study' } });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      for (const r of (await res.json()) as CandleRow[]) { const c = fromRow(r); if (c.ts + g * 1000 <= end) rows.set(c.ts, c); }
      await new Promise((r) => setTimeout(r, 150));
    }
    out[tf] = [...rows.values()].sort((a, b) => a.ts - b.ts);
  }
  return out;
}

/** Candle history per asset from recordings (`candles` events), merged exactly as the live store does. */
export async function historyFromRecordings(dir: string): Promise<Record<string, History>> {
  const sets = new Map<string, Map<Timeframe, Map<number, Candle>>>();
  for await (const e of readRecordings(dir)) {
    if (e.k !== 'candles') continue;
    const a = (e as any).asset as string, tf = (e as any).tf as Timeframe;
    if (!sets.has(a)) sets.set(a, new Map());
    const m = sets.get(a)!;
    if (!m.has(tf)) m.set(tf, new Map());
    for (const r of ((e as any).rows ?? []) as CandleRow[]) m.get(tf)!.set(r[0] * 1000, fromRow(r));
  }
  const out: Record<string, History> = {};
  for (const [a, m] of sets) {
    out[a] = {};
    for (const [tf, rows] of m) out[a][tf] = [...rows.values()].sort((x, y) => x.ts - y.ts);
  }
  return out;
}

async function main() {
  const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const rec = arg('recordings', '');
  const histDir = arg('history', '');
  const assets = arg('assets', 'BTC,ETH,SOL,XRP,DOGE').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const days = Number(arg('days', '120'));
  let hist: Record<string, History>;
  let source: string;
  let baseTf: '15m' | '1h' = '15m';
  if (histDir) {
    hist = {};
    const list = arg('assets', 'all') === 'all' ? storedAssets(histDir) : assets;
    for (const a of list) hist[a] = loadHistory(histDir, a, ['1h', '4h', '1d']);
    baseTf = '1h';
    source = `history:${histDir}`;
  } else if (rec) { hist = await historyFromRecordings(rec); source = `recordings:${rec}`; }
  else {
    hist = {};
    for (const a of assets) {
      try { hist[a] = await fetchCoinbaseHistory(a, days, ['5m', '15m', '1h', '1d']); console.log(`${a}: ${hist[a]['15m']?.length ?? 0} 15m candles`); }
      catch (e) { console.warn(`${a}: ${(e as Error).message}`); }
    }
    source = `coinbase:${days}d`;
  }
  const res = runTaStudy(hist, { stride: Number(arg('stride', '1')), fdr: Number(arg('fdr', '0.1')), source, baseTf });
  const out = arg('out', 'params/ta_study.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(res, null, 1));
  const passed = res.rows.filter((r) => r.fdrPass);
  console.log(`${res.steps} steps, ${res.rows.length} hypotheses, ${passed.length} pass FDR ${res.fdr}`);
  console.table(passed.slice(0, 40).map((r) => ({ id: r.id, tf: r.tf, h: r.horizonMin, n: r.n, hit: +r.hitRate.toFixed(3), bps: +r.meanBps.toFixed(2), lo: +r.ciLo.toFixed(2), hi: +r.ciHi.toFixed(2), p: +r.p.toFixed(4) })));
  console.log(`wrote ${out}`);
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void main();

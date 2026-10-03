// Walk-forward forecasts of the TA network over the whole history, for models that use its outputs as
// inputs (the setup scorer). A forecast at hour t comes from a network that only trained on data that
// had closed before t's month started, so a backtest reading these forecasts doesn't cheat.
//
//   npm run research:ta-net-oos -- --history data/history [--params params/ta_net.json] [--hours 2]
//
// One network with the tournament winner's settings (params/ta_net.json: hyperparameters, branch gates,
// input scaling) walks forward month by month: train one epoch on the trailing 12 months (stride 2,
// three catch-up epochs on the first block), forecast every hour of the next month, roll on. The
// state (weights, optimizer) and the forecasts are saved after every month, so the export resumes,
// and later runs only add the new months. The tail month is forecast from the latest weights too.
//
// Output (in <history>/.tanet-oos/): forecasts.json ({asset: [[barTs, up1h, up4h, vol4h], ...]}) and
// ta_net_wf.json, the walking network's latest weights as a TA network file. The live setup trader
// reads that file, so live forecasts come from the same network that produced the training inputs.

import fs from 'fs';
import path from 'path';
import { initBranchParams, branchLayout } from '../bot/ta/branchNet';
import { TANET_SCHEMA, type TaNetParams } from '../bot/ta/taNet';
import type { Hyper } from './pbt';
import { storedAssets } from './history/candles';
import { buildData, forecast, taNetDims, trainEpoch, type Member, type TaNetData } from './trainTaNet';

const H = 3_600_000;
const DAY = 86_400_000;
const MONTH = 30.44 * DAY;

export type OosRow = [number, number, number, number];
export interface OosForecasts { schema: string; source: string; through: number; assets: Record<string, OosRow[]> }

interface OosState { schema: string; source: string; nextEval: number; rounds: number; step: number; w: string; m: string; v: string }

const b64 = (a: Float64Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const unb64 = (s: string) => { const b = Buffer.from(s, 'base64'); return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

/** Where the export lives for a history folder. */
export const oosDir = (hist: string) => path.join(hist, '.tanet-oos');

/** Read the exported forecasts (undefined when missing or for another network schema). */
export function loadOos(hist: string): OosForecasts | undefined {
  const f = path.join(oosDir(hist), 'forecasts.json');
  if (!fs.existsSync(f)) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8')) as OosForecasts;
    return j.schema === TANET_SCHEMA ? j : undefined;
  } catch { return undefined; }
}

/** Lookup by asset and hourly bar open time. */
export class OosIndex {
  private readonly by = new Map<string, Map<number, OosRow>>();
  constructor(readonly f: OosForecasts | undefined) {
    for (const [a, rows] of Object.entries(f?.assets ?? {})) this.by.set(a, new Map(rows.map((r) => [r[0], r])));
  }
  /** The forecast made at the close of the last hourly bar closed by time t (bar open <= t - 1h). */
  at(asset: string, t: number): { up1: number; up4: number; vol: number } | undefined {
    const m = this.by.get(asset);
    if (!m) return undefined;
    const bar = Math.floor(t / H) * H - H;
    const r = m.get(bar);
    return r ? { up1: r[1], up4: r[2], vol: r[3] } : undefined;
  }
}

export interface OosOpts { paramsPath: string; cacheDir?: string; hours?: number; trainMonths?: number; stride?: number; catchUp?: number; log?: (m: string) => void; data?: TaNetData }

export async function exportTaNetOos(hist: string, o: OosOpts): Promise<{ rounds: number; complete: boolean; rows: number }> {
  const log = o.log ?? ((m: string) => console.log(`[ta-net-oos] ${m}`));
  const deadline = Date.now() + (o.hours ?? 6) * H;
  const P = JSON.parse(fs.readFileSync(o.paramsPath, 'utf8')) as TaNetParams & { pbt?: { elite?: { hyper?: Hyper } } };
  const hyper = P.pbt?.elite?.hyper;
  if (!hyper) throw new Error(`${o.paramsPath} has no tournament winner (pbt.elite.hyper): train the TA network first`);
  if (P.schema !== TANET_SCHEMA) throw new Error(`${o.paramsPath} is schema ${P.schema}, code expects ${TANET_SCHEMA}`);
  const source = `${P.version}|${JSON.stringify(hyper)}`;
  const dir = oosDir(hist);
  fs.mkdirSync(dir, { recursive: true });
  const D = o.data ?? buildData(hist, storedAssets(hist), o.cacheDir ?? path.join(hist, '.tanet-cache'), log);
  const dims = taNetDims();
  if (JSON.stringify(dims) !== JSON.stringify(P.dims)) throw new Error('network layout in the params differs from the code');
  const norm = P.norm;
  const n = D.ts.length;
  const t0 = D.ts[0], tEnd = D.ts[n - 1] + H;
  const trainMs = (o.trainMonths ?? 12) * MONTH, stride = o.stride ?? 2, catchUp = o.catchUp ?? 3, emb = 5 * H;
  const stateFile = path.join(dir, 'state.json'), fcFile = path.join(dir, 'forecasts.json');
  let st: OosState | undefined;
  try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as OosState; } catch { st = undefined; }
  if (st && (st.schema !== TANET_SCHEMA || st.source !== source)) { log('network settings changed since the last export: starting over'); st = undefined; }
  const prior = st ? loadOos(hist) : undefined;
  if (st && prior?.source !== source) { log('saved forecasts missing: starting over'); st = undefined; }
  const fc: OosForecasts = (st && prior) || { schema: TANET_SCHEMA, source, through: 0, assets: {} };
  const size = branchLayout(dims).size;
  const mem: Member = st ? { w: unb64(st.w), m: unb64(st.m), v: unb64(st.v), step: st.step } : { w: initBranchParams(dims, 7), m: new Float64Array(size), v: new Float64Array(size), step: 0 };
  let next = st?.nextEval ?? Math.floor((t0 + trainMs) / DAY) * DAY, rounds = st?.rounds ?? 0;
  const between = (a: number, b: number, k = 1) => { const out: number[] = []; let c = 0; for (let i = 0; i < n; i++) if (D.ts[i] >= a && D.ts[i] < b) { if (c++ % k === 0) out.push(i); } return out; };
  const save = () => {
    const s: OosState = { schema: TANET_SCHEMA, source, nextEval: next, rounds, step: mem.step, w: b64(mem.w), m: b64(mem.m), v: b64(mem.v) };
    for (const [f, body] of [[stateFile, JSON.stringify(s)], [fcFile, JSON.stringify(fc)]] as const) { const tmp = `${f}.tmp`; fs.writeFileSync(tmp, body); fs.renameSync(tmp, f); }
    // The walking network as a TA network file (the shipped file's settings and validation, these weights).
    const wf = { ...P, version: `${P.version}-wf${rounds}`, weights: Array.from(mem.w), trainedAt: new Date().toISOString() };
    const tmp = path.join(dir, 'ta_net_wf.json.tmp'); fs.writeFileSync(tmp, JSON.stringify(wf)); fs.renameSync(tmp, path.join(dir, 'ta_net_wf.json'));
  };
  const put = (from: number, to: number) => {
    // Drop anything already stored in [from, to) (the tail month is re-forecast as it fills in).
    for (const a of Object.keys(fc.assets)) fc.assets[a] = fc.assets[a].filter((r) => r[0] < from || r[0] >= to);
    const idx = between(from, to);
    if (!idx.length) return 0;
    const f = forecast(D, dims, norm, mem.w, hyper, idx);
    idx.forEach((i, k) => {
      const a = D.assets[D.sa[i]].asset;
      (fc.assets[a] ??= []).push([D.ts[i], +f.up1[k].toFixed(5), +f.up4[k].toFixed(5), +f.vol[k].toFixed(5)]);
    });
    for (const a of Object.keys(fc.assets)) fc.assets[a].sort((x, y) => x[0] - y[0]);
    fc.through = Math.max(fc.through, to);
    return idx.length;
  };
  log(`${n} hourly rows ${new Date(t0).toISOString().slice(0, 10)}..${new Date(tEnd).toISOString().slice(0, 10)}; ${st ? `resuming at ${new Date(next).toISOString().slice(0, 10)} (${rounds} months done)` : 'fresh walk'}`);
  while (next + MONTH <= tEnd && Date.now() < deadline) {
    const t1 = Date.now();
    const idx = between(next - trainMs, next - emb, stride);
    const epochs = 1 + (mem.step === 0 ? catchUp : 0);
    for (let e = 0; e < epochs; e++) trainEpoch(D, dims, norm, mem, hyper, idx, 7 + rounds * 131 + e);
    const rows = put(next, next + MONTH);
    next += MONTH; rounds++;
    save();
    log(`month ${rounds} -> ${new Date(next).toISOString().slice(0, 10)}: trained on ${idx.length} rows (${epochs} epoch${epochs > 1 ? 's' : ''}), forecast ${rows} rows in ${((Date.now() - t1) / 1000).toFixed(0)} s`);
  }
  const complete = next + MONTH > tEnd;
  if (complete) { const rows = put(next, tEnd); save(); log(`tail ${new Date(next).toISOString().slice(0, 10)}..: ${rows} rows from the latest weights`); }
  const total = Object.values(fc.assets).reduce((a, r) => a + r.length, 0);
  log(`${complete ? 'complete' : 'time budget reached; run again to continue'}: ${total} forecasts through ${new Date(fc.through).toISOString().slice(0, 16)}`);
  return { rounds, complete, rows: total };
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) {
  void exportTaNetOos(cliArg('history', 'data/history'), { paramsPath: cliArg('params', 'params/ta_net.json'), hours: Number(cliArg('hours', '6')) }).catch((e) => { console.error(e); process.exitCode = 1; });
}

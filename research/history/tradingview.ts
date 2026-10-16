// TradingView in the bot's history (deploy/tv_history.py, tvdatafeed): what to fetch and importing it.
//
//   index series   BTC.D, USDT.D, TOTAL3, OTHERS.D (CRYPTOCAP), RTY (US Russell 2000) for the TA
//                  network's market context, and DXY, US10Y, VIX, HYG for the macro_risk rule. A series
//                  gets the full 5,000-bar backfill (1d, 4h, 1h: daily back to 2013 in one request) when it
//                  has fewer than INDEX_MIN_DAILY daily bars, or when it does not reach back to a date the
//                  bot needs (BTC.D: the Fractal Alignment Engine's 2016-2017 parent window), at most weekly.
//                  A series whose newest daily bar is older than STALE_DAYS has its last month refreshed:
//                  TOTAL3, OTHERS.D and the traditional-market series always (the bot has no live feed for
//                  them), BTC.D / USDT.D too when the bot's own bars are not there (the laptop trainer).
//   spot holes     every (asset, timeframe) of the spot store, within the last 5,000 bars (tvdatafeed's
//                  reach) and older than RECENT_DAYS (the exchange archives lag a day or two), is checked
//                  for missing bars; the worst MAX_SPOT get that window from TradingView, stored as source
//                  "tvspot", which ranks below every exchange archive, so it only fills the holes.
//
// The daily pipeline runs tvFill in its history step (TV_FILL=false turns it off). Downloading through
// an unofficial client is against TradingView's terms; the calls are kept to what is missing.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HIST_TF_MS, loadIndexSeries, type HistTf } from '../../bot/marketdata/historyStore';
import { loadSeries } from './candles';
import { collectFiles, importFile, type ImportResult } from './importCsv';

const DAY = 86_400_000;
export const TV_INDEXES = ['BTC.D', 'USDT.D', 'TOTAL3', 'OTHERS.D', 'RTY', 'DXY', 'US10Y', 'VIX', 'HYG'];
/** Traditional-market series (trading days only, weekends closed): fewer daily bars, staler by design.
 *  DXY / US10Y / VIX / HYG feed the macro_risk rule (bot/ta/marketContext.ts). */
export const TV_TRADFI = ['RTY', 'DXY', 'US10Y', 'VIX', 'HYG'];
/** Specs for deploy/tv_history.py --indexes, by store name. */
export const TV_INDEX_SPECS: Record<string, string> = {
  'BTC.D': 'CRYPTOCAP:BTC.D', 'USDT.D': 'CRYPTOCAP:USDT.D', TOTAL3: 'CRYPTOCAP:TOTAL3', 'OTHERS.D': 'CRYPTOCAP:OTHERS.D',
  RTY: 'RTY=TVC:RUT|RUSSELL:RUT|CME_MINI:RTY1!|AMEX:IWM',
  DXY: 'DXY=TVC:DXY|ICEUS:DX1!', US10Y: 'US10Y=TVC:US10Y|TVC:TNX', VIX: 'VIX=TVC:VIX|CBOE:VIX', HYG: 'HYG=AMEX:HYG|NYSEARCA:HYG',
};
/** Series without a live feed in the bot (kept current from TradingView). */
export const TV_REFRESHED = ['TOTAL3', 'OTHERS.D', 'RTY', 'DXY', 'US10Y', 'VIX', 'HYG'];
export const INDEX_MIN_DAILY = 3000;
export const STALE_DAYS = 2;
export const RECENT_DAYS = 3;
export const TV_MAX_BARS = 5000;

export interface SpotHole { asset: string; tf: HistTf; missing: number; first: number; last: number }

/** Missing bars per (asset, tf) in the last `maxBars` bars (excluding the most recent `recentDays`). */
export function findSpotHoles(dir: string, assets: string[], tfs: HistTf[] = ['15m', '1h', '4h', '1d'], o: { now?: number; maxBars?: number; recentDays?: number } = {}): SpotHole[] {
  const now = o.now ?? Date.now(), maxBars = o.maxBars ?? TV_MAX_BARS, recent = (o.recentDays ?? RECENT_DAYS) * DAY;
  const out: SpotHole[] = [];
  for (const asset of assets) {
    for (const tf of tfs) {
      const ms = HIST_TF_MS[tf];
      const end = Math.floor((now - recent) / ms) * ms;              // bars opening before this are checked
      const start = Math.floor(now / ms) * ms - maxBars * ms;          // tvdatafeed's reach
      const cs = loadSeries(dir, asset, tf).candles;
      const have = new Set(cs.map((c) => c.ts));
      // Before the asset's first bar there is no history to repair (listing), unless there is none at all.
      const from = cs.length ? Math.max(start, cs[0].ts) : start;
      let missing = 0, first = NaN, last = NaN;
      for (let t = Math.ceil(from / ms) * ms; t < end; t += ms) if (!have.has(t)) { missing++; if (!Number.isFinite(first)) first = t; last = t; }
      if (missing > 0) out.push({ asset, tf, missing, first, last });
    }
  }
  return out.sort((a, b) => b.missing * HIST_TF_MS[b.tf] - a.missing * HIST_TF_MS[a.tf]);
}

/** Which index series need the full backfill, and which need their recent daily bars refreshed. `needFrom`: the
 *  first day a series must reach back to (a store that starts later gets the full backfill, retried at most weekly
 *  through `tried`, in case TradingView itself starts later). */
export function indexNeeds(dir: string, now = Date.now(), o: { needFrom?: Record<string, number>; tried?: Record<string, number> } = {}): { full: string[]; refresh: string[]; daily: Record<string, { bars: number; first: string | null; last: string | null }> } {
  const full: string[] = [], refresh: string[] = [], daily: Record<string, { bars: number; first: string | null; last: string | null }> = {};
  const today = Math.floor(now / DAY) * DAY;
  const day = (t: number | undefined) => (t !== undefined ? new Date(t).toISOString().slice(0, 10) : null);
  for (const name of TV_INDEXES) {
    let cs: Array<{ ts: number }> = [];
    try { cs = loadIndexSeries(dir, name, '1d').candles; } catch { cs = []; }
    const first = cs[0]?.ts, last = cs[cs.length - 1]?.ts;
    daily[name] = { bars: cs.length, first: day(first), last: day(last) };
    const tradfi = TV_TRADFI.includes(name);
    if (cs.length < (tradfi ? INDEX_MIN_DAILY * 0.6 : INDEX_MIN_DAILY)) { full.push(name); continue; }
    const from = o.needFrom?.[name], key = `index|${name}`;
    if (from !== undefined && first !== undefined && first > from + 7 * DAY && !(now - (o.tried?.[key] ?? 0) < 7 * DAY)) {
      full.push(name);
      if (o.tried) o.tried[key] = now;
      continue;
    }
    const staleDays = tradfi ? STALE_DAYS + 2 : STALE_DAYS;
    if (last === undefined || today - last > staleDays * DAY) refresh.push(name);
  }
  return { full, refresh, daily };
}

export type TvRunner = (args: string[], log: (m: string) => void) => Promise<number>;

/** deploy/tv_history.py <args>: with TV_PYTHON (a Python with tvdatafeed: the laptop trainer's, research/tvSetup.ts)
 *  run directly, else through deploy/history.sh tvfetch (the server's venv, set up on first use). */
export const runTvFetch: TvRunner = (args, log) => new Promise((resolve) => {
  const py = process.env.TV_PYTHON;
  const [cmd, argv] = py ? [py, [path.resolve('deploy', 'tv_history.py'), ...args]] : ['bash', [path.resolve('deploy', 'history.sh'), 'tvfetch', ...args]];
  const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const relay = (b: Buffer) => { for (const line of b.toString().split('\n')) if (line.trim()) log(line.trim()); };
  child.stdout.on('data', relay); child.stderr.on('data', relay);
  const timer = setTimeout(() => child.kill('SIGTERM'), 45 * 60_000);
  child.on('close', (code) => { clearTimeout(timer); resolve(code ?? 1); });
  child.on('error', (e) => { clearTimeout(timer); log(`tvfetch: ${String(e)}`); resolve(1); });
});

export interface TvFillReport { indexesFull: string[]; indexesRefreshed: string[]; spotHoles: SpotHole[]; fetched: string[]; imported: Array<{ file: string; ok: boolean; asset?: string; tf?: string; stored?: number; error?: string }>; exitCodes: number[]; skipped?: string }

/** Find what is missing, fetch it from TradingView and import it. */
export async function tvFill(o: { histDir: string; assets: string[]; now?: number; log?: (m: string) => void; run?: TvRunner; maxSpot?: number; workDir?: string; tried?: Record<string, number>; needFrom?: Record<string, number> }): Promise<TvFillReport> {
  const log = o.log ?? ((m: string) => console.log(`[tradingview] ${m}`));
  const run = o.run ?? runTvFetch;
  const now = o.now ?? Date.now();
  const tried = o.tried ?? {};
  const need = indexNeeds(o.histDir, now, { needFrom: o.needFrom, tried });
  const holes = findSpotHoles(o.histDir, o.assets, undefined, { now });
  // A hole TradingView couldn't fill either (an exchange outage on every venue) is retried weekly, not daily.
  const key = (h: SpotHole) => `${h.asset}|${h.tf}|${h.missing}`;
  const spot = holes.filter((h) => !(now - (tried[key(h)] ?? 0) < 7 * DAY)).slice(0, o.maxSpot ?? 20);
  for (const h of spot) tried[key(h)] = now;
  for (const k of Object.keys(tried)) if (now - tried[k] > 30 * DAY) delete tried[k];
  const report: TvFillReport = { indexesFull: need.full, indexesRefreshed: need.refresh, spotHoles: holes, fetched: [], imported: [], exitCodes: [] };
  log(`index series: ${Object.entries(need.daily).map(([k, v]) => `${k} ${v.bars} daily bars${v.first ? ` ${v.first}..${v.last}` : ''}`).join(', ')}; full backfill: ${need.full.join(', ') || 'none'}; refresh: ${need.refresh.join(', ') || 'none'}; spot holes: ${holes.length ? holes.map((h) => `${h.asset} ${h.tf} ${h.missing}`).join(', ') : 'none'}`);
  if (!need.full.length && !need.refresh.length && !spot.length) { report.skipped = 'nothing missing'; return report; }
  const out = o.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tvfill-'));
  fs.mkdirSync(out, { recursive: true });
  if (need.full.length) report.exitCodes.push(await run(['--out', out, '--indexes', need.full.map((n) => TV_INDEX_SPECS[n]).join(','), '--intervals', '1d,4h,1h', '--bars', String(TV_MAX_BARS)], log));
  if (need.refresh.length) report.exitCodes.push(await run(['--out', out, '--indexes', need.refresh.map((n) => TV_INDEX_SPECS[n]).join(','), '--intervals', '1d', '--bars', '40'], log));
  if (spot.length) report.exitCodes.push(await run(['--out', out, '--spot', spot.map((h) => `${h.asset}:${h.tf}`).join(','), '--bars', String(TV_MAX_BARS)], log));
  for (const file of collectFiles([out])) {
    report.fetched.push(path.basename(file));
    const m = /^tvspot__([A-Z0-9]+)__(15m|1h|4h|1d)__/.exec(path.basename(file));
    const res: ImportResult[] = m ? importFile(file, { out: o.histDir, source: 'tvspot', asset: m[1], tf: m[2] as HistTf }) : importFile(file, { out: o.histDir });
    for (const r of res) report.imported.push({ file: path.basename(file), ok: r.ok, asset: r.asset, tf: r.tf, stored: r.stored, error: r.error });
  }
  if (!o.workDir) fs.rmSync(out, { recursive: true, force: true });
  log(`imported ${report.imported.filter((r) => r.ok).length} of ${report.imported.length} series`);
  return report;
}

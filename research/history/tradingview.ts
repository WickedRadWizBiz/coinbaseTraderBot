// TradingView in the bot's history (deploy/tv_history.py, tvdatafeed): what to fetch and importing it.
//
//   index series   BTC.D, USDT.D, TOTAL3, OTHERS.D (CRYPTOCAP) and RTY (US Russell 2000) for the TA
//                  network's market context. A series with fewer than INDEX_MIN_DAILY daily bars gets
//                  the full 5,000-bar backfill (1d, 4h, 1h); TOTAL3, OTHERS.D and RTY have no live feed in
//                  the bot, so their last month of daily bars is refreshed when the newest is older than
//                  STALE_DAYS (BTC.D / USDT.D are kept current by the bot's own bars).
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
export const TV_INDEXES = ['BTC.D', 'USDT.D', 'TOTAL3', 'OTHERS.D', 'RTY'];
/** Specs for deploy/tv_history.py --indexes, by store name. */
export const TV_INDEX_SPECS: Record<string, string> = {
  'BTC.D': 'CRYPTOCAP:BTC.D', 'USDT.D': 'CRYPTOCAP:USDT.D', TOTAL3: 'CRYPTOCAP:TOTAL3', 'OTHERS.D': 'CRYPTOCAP:OTHERS.D',
  RTY: 'RTY=TVC:RUT|RUSSELL:RUT|CME_MINI:RTY1!|AMEX:IWM',
};
/** Series without a live feed in the bot (kept current from TradingView). */
export const TV_REFRESHED = ['TOTAL3', 'OTHERS.D', 'RTY'];
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

/** Which index series need the full backfill, and which need their recent daily bars refreshed. */
export function indexNeeds(dir: string, now = Date.now()): { full: string[]; refresh: string[]; daily: Record<string, { bars: number; last: string | null }> } {
  const full: string[] = [], refresh: string[] = [], daily: Record<string, { bars: number; last: string | null }> = {};
  const today = Math.floor(now / DAY) * DAY;
  for (const name of TV_INDEXES) {
    let cs: Array<{ ts: number }> = [];
    try { cs = loadIndexSeries(dir, name, '1d').candles; } catch { cs = []; }
    const last = cs[cs.length - 1]?.ts;
    daily[name] = { bars: cs.length, last: last !== undefined ? new Date(last).toISOString().slice(0, 10) : null };
    if (cs.length < (name === 'RTY' ? INDEX_MIN_DAILY * 0.6 : INDEX_MIN_DAILY)) { full.push(name); continue; }
    const staleDays = name === 'RTY' ? STALE_DAYS + 2 : STALE_DAYS;
    if (TV_REFRESHED.includes(name) && (last === undefined || today - last > staleDays * DAY)) refresh.push(name);
  }
  return { full, refresh, daily };
}

export type TvRunner = (args: string[], log: (m: string) => void) => Promise<number>;

/** deploy/history.sh tvfetch <args> (sets up the tvdatafeed venv on first use). */
export const runTvFetch: TvRunner = (args, log) => new Promise((resolve) => {
  const child = spawn('bash', [path.resolve('deploy', 'history.sh'), 'tvfetch', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const relay = (b: Buffer) => { for (const line of b.toString().split('\n')) if (line.trim()) log(line.trim()); };
  child.stdout.on('data', relay); child.stderr.on('data', relay);
  const timer = setTimeout(() => child.kill('SIGTERM'), 45 * 60_000);
  child.on('close', (code) => { clearTimeout(timer); resolve(code ?? 1); });
  child.on('error', (e) => { clearTimeout(timer); log(`tvfetch: ${String(e)}`); resolve(1); });
});

export interface TvFillReport { indexesFull: string[]; indexesRefreshed: string[]; spotHoles: SpotHole[]; fetched: string[]; imported: Array<{ file: string; ok: boolean; asset?: string; tf?: string; stored?: number; error?: string }>; exitCodes: number[]; skipped?: string }

/** Find what is missing, fetch it from TradingView and import it. */
export async function tvFill(o: { histDir: string; assets: string[]; now?: number; log?: (m: string) => void; run?: TvRunner; maxSpot?: number; workDir?: string; tried?: Record<string, number> }): Promise<TvFillReport> {
  const log = o.log ?? ((m: string) => console.log(`[tradingview] ${m}`));
  const run = o.run ?? runTvFetch;
  const now = o.now ?? Date.now();
  const need = indexNeeds(o.histDir, now);
  const holes = findSpotHoles(o.histDir, o.assets, undefined, { now });
  // A hole TradingView couldn't fill either (an exchange outage on every venue) is retried weekly, not daily.
  const tried = o.tried ?? {};
  const key = (h: SpotHole) => `${h.asset}|${h.tf}|${h.missing}`;
  const spot = holes.filter((h) => !(now - (tried[key(h)] ?? 0) < 7 * DAY)).slice(0, o.maxSpot ?? 20);
  for (const h of spot) tried[key(h)] = now;
  for (const k of Object.keys(tried)) if (now - tried[k] > 30 * DAY) delete tried[k];
  const report: TvFillReport = { indexesFull: need.full, indexesRefreshed: need.refresh, spotHoles: holes, fetched: [], imported: [], exitCodes: [] };
  log(`index series: ${Object.entries(need.daily).map(([k, v]) => `${k} ${v.bars} daily bars${v.last ? ` to ${v.last}` : ''}`).join(', ')}; full backfill: ${need.full.join(', ') || 'none'}; refresh: ${need.refresh.join(', ') || 'none'}; spot holes: ${holes.length ? holes.map((h) => `${h.asset} ${h.tf} ${h.missing}`).join(', ') : 'none'}`);
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

// The scaling lab on the history days (thread "Plan dynamic scaling across the bot", Nov 1): the whole bot, as paper runs
// it, replayed on months of Kalshi history with each dynamic-edge / regime-sizing arm, scored day by day against the
// baseline. Steven's rule (Nov 1): research on history must be deep on days and cover several market regimes, so the report
// splits the days by month and into calm / normal / wild terciles of BTC's daily range (high - low) / open, from the
// Binance daily candles the history download keeps (data/history/binance/BTC/1d.csv).
//
//   node --import tsx research/scalingHistory.ts run    --arm <tag> --env "K=V K=V" --days data/sweep-days --model data/models/model.json --out research/out/scaling-history
//   node --import tsx research/scalingHistory.ts report --out research/out/scaling-history [--candles data/history/binance/BTC/1d.csv] [--last 120]
//
// Prints aggregates only (the repository is public).
import fs from 'fs';
import path from 'path';
import { rng } from './stats';
import type { TrialResult } from './randomSweep';
import { parseCandleCsv } from './history/csvFormats';

/** BTC's daily range (high - low) / open by UTC day, from a daily candle CSV. */
export function dailyRange(csv: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of parseCandleCsv(csv, '1d.csv', { asset: 'BTC', tf: '1d' }).candles) if (c.o > 0) out[new Date(c.ts).toISOString().slice(0, 10)] = (c.h - c.l) / c.o;
  return out;
}

function arg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const f2 = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);

/** Mean of `xs` with a percentile bootstrap interval (days resampled). */
export function bootMean(xs: number[], draws = 4000, seed = 5): { mean: number; lo: number; hi: number } {
  if (!xs.length) return { mean: NaN, lo: NaN, hi: NaN };
  const mean = xs.reduce((a, v) => a + v, 0) / xs.length;
  const r = rng(seed);
  const ms: number[] = [];
  for (let d = 0; d < draws; d++) { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r() * xs.length)]; ms.push(s / xs.length); }
  ms.sort((a, b) => a - b);
  return { mean, lo: ms[Math.floor(draws * 0.025)], hi: ms[Math.floor(draws * 0.975)] };
}

export function parseEnv(s: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const kv of s.split(/\s+/).filter(Boolean)) {
    const m = /^([A-Z][A-Z0-9_]*)=([A-Za-z0-9_.,:-]*)$/.exec(kv);
    if (!m) throw new Error(`bad override ${kv}`);
    env[m[1]] = m[2];
  }
  return env;
}

/** Split days into groups: by month, and (when `vol` has a value for each day) into calm / normal / wild terciles. */
export function regimeGroups(days: string[], vol: Record<string, number> = {}): Array<{ name: string; days: string[] }> {
  const out: Array<{ name: string; days: string[] }> = [];
  const months = [...new Set(days.map((d) => d.slice(0, 7)))].sort();
  for (const m of months) out.push({ name: m, days: days.filter((d) => d.startsWith(m)) });
  const withVol = days.filter((d) => Number.isFinite(vol[d]));
  if (withVol.length >= 9) {
    const sorted = [...withVol].sort((a, b) => vol[a] - vol[b]);
    const n = sorted.length;
    out.push({ name: 'calm days', days: sorted.slice(0, Math.floor(n / 3)) });
    out.push({ name: 'normal days', days: sorted.slice(Math.floor(n / 3), Math.floor((2 * n) / 3)) });
    out.push({ name: 'wild days', days: sorted.slice(Math.floor((2 * n) / 3)) });
  }
  return out;
}

/** One line per arm: $/h over all days and the paired difference against the baseline with its day-bootstrap interval. */
export function reportLines(res: Map<string, TrialResult>, days: string[], groups: Array<{ name: string; days: string[] }>): string[] {
  const lines: string[] = [];
  const base = res.get('base');
  const perH = (r: TrialResult, ds: string[]) => (ds.length ? ds.reduce((a, d) => a + (r.byDay[d] ?? 0), 0) / (24 * ds.length) : NaN);
  const names = [...res.keys()].sort((a, b) => (a === 'base' ? -1 : b === 'base' ? 1 : a.localeCompare(b)));
  for (const name of names) {
    const r = res.get(name)!;
    if (!r.ok) { lines.push(`${name}: FAILED ${r.error}`); continue; }
    const up = days.filter((d) => (r.byDay[d] ?? 0) > 0).length;
    let vs = '';
    if (base?.ok && name !== 'base') {
      const bm = bootMean(days.map((d) => ((r.byDay[d] ?? 0) - (base.byDay[d] ?? 0)) / 24));
      vs = ` | vs base ${f2(bm.mean)}/h [${f2(bm.lo)}, ${f2(bm.hi)}]`;
    }
    lines.push(`${name.padEnd(14)} ${f2(perH(r, days))}/h over ${days.length} d (${up} up), ${r.trades} trades, fees ${r.fees.toFixed(0)}${vs}`);
    lines.push(`${''.padEnd(14)} ${groups.map((g) => `${g.name} ${f2(perH(r, g.days))}`).join(' | ')}`);
  }
  return lines;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const out = arg('out', 'research/out/scaling-history');
  const days = arg('days', 'data/sweep-days');
  if (cmd === 'run') {
    const tag = arg('arm', 'base');
    const env = parseEnv(arg('env', ''));
    const { evalTrial } = await import('./randomSweep');
    const t0 = Date.now();
    const r = await evalTrial(days, arg('model', 'data/models/model.json'), env, 3, 'all', undefined, { refill: true });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${tag}.json`), JSON.stringify({ name: tag, ...r }));
    console.log(`[scaling-history] ${tag}: ${r.ok ? `P&L ${f2(r.pnl)}, fees ${r.fees.toFixed(2)}, ${r.trades} trades, ${r.contracts} contracts` : `FAILED ${r.error}`} in ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
    return;
  }
  if (cmd === 'report') {
    const res = new Map<string, TrialResult>();
    for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) if (f.endsWith('.json')) { const j = JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')); res.set(j.name, j); }
    const all = [...new Set([...res.values()].flatMap((r) => Object.keys(r.byDay ?? {})))].sort();
    const want = Number(arg('last', '0'));
    const ds = want > 0 ? all.slice(-want) : all;
    const candles = arg('candles', 'data/history/binance/BTC/1d.csv');
    let vol: Record<string, number> = {};
    try { if (fs.existsSync(candles)) vol = dailyRange(fs.readFileSync(candles, 'utf8')); } catch (e) { console.log(`no regimes from ${candles}: ${(e as Error).message}`); }
    console.log(`days ${ds[0]}..${ds[ds.length - 1]} (${ds.length}); regimes: months${Object.keys(vol).length ? ' + calm/normal/wild terciles of the BTC daily range' : ''}`);
    for (const l of reportLines(res, ds, regimeGroups(ds, vol))) console.log(l);
    return;
  }
  throw new Error('usage: scalingHistory.ts run|report (see the header)');
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error((e as Error).stack ?? e); process.exitCode = 1; });

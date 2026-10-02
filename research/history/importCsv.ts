// Import historical candle CSVs (and Binance .zip archives) into the history store.
//
//   npm run history:import -- data/incoming/                 # every .csv / .zip under a folder
//   npm run history:import -- Bittrex_BTCUSD_1h.csv --source bittrex
//   npm run history:import -- BTC-USD.csv --asset BTC --tf 1d
//
// Options: --out <dir> (default data/history), --source / --asset / --tf (override detection),
// --shift-bars k (move every bar by k bars; -1 fixes close-time stamps), --allow-non-usd,
// --force (import even when the alignment check suggests a shifted clock), --dry-run.
//
// Per file: parse -> drop impossible/duplicate bars -> report gaps, jumps, misaligned stamps ->
// compare against what is already stored for the same asset and timeframe from OTHER sources
// (return correlation at shifts -2..+2: the best match must be at 0, else the file's clock
// convention is off and the import is refused unless --shift-bars or --force) -> merge.

import fs from 'fs';
import path from 'path';
import { alignmentCheck, cleanAndValidate, loadSeries, shiftCandles, upsertSeries, type AlignmentResult, type HistTf, type ValidationReport } from './candles';
import { parseCandleCsv } from './csvFormats';
import { unzip } from './zip';

export interface ImportOpts {
  out: string;
  source?: string;
  asset?: string;
  tf?: HistTf;
  shiftBars?: number;
  allowNonUsd?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

export interface ImportResult {
  file: string;
  ok: boolean;
  error?: string;
  format?: string;
  source?: string;
  asset?: string;
  quote?: string;
  tf?: HistTf;
  stored?: number;
  report?: ValidationReport;
  alignment?: AlignmentResult & { against: string };
  notes: string[];
}

/** Import one CSV text (already read / unzipped). */
export function importCsvText(text: string, name: string, o: ImportOpts): ImportResult {
  const res: ImportResult = { file: name, ok: false, notes: [] };
  try {
    const p = parseCandleCsv(text, name, { asset: o.asset, tf: o.tf, source: o.source });
    Object.assign(res, { format: p.format, source: p.source, asset: p.asset, quote: p.quote, tf: p.tf });
    res.notes.push(...p.notes);
    if (!p.asset) throw new Error('could not tell the asset from the file name or symbol column: pass --asset');
    if (!p.tf) throw new Error('could not tell the timeframe: pass --tf (1m, 5m, 15m, 1h, 4h, 1d)');
    if (!p.quote && !o.asset) res.notes.push('quote currency unknown (assumed USD-like)');
    if (p.quote && !/^USD/.test(p.quote) && p.quote !== 'DAI' && !o.allowNonUsd) throw new Error(`quote ${p.quote} is not USD-like`);
    const { candles: clean, report } = cleanAndValidate(shiftCandles(p.candles, p.tf, o.shiftBars ?? 0), p.tf);
    res.report = report;
    if (!clean.length) throw new Error('no valid bars');
    if (report.misaligned > clean.length * 0.01) res.notes.push(`${report.misaligned} bars are not on ${p.tf} boundaries`);
    // Alignment against the other sources already stored.
    const ref = loadSeries(o.out, p.asset, p.tf);
    const others = ref.candles.filter((c) => !ref.segments.some((s) => s.source === p.source && c.ts >= s.from && c.ts <= s.to));
    const al = others.length ? alignmentCheck(clean, others, p.tf) : undefined;
    if (al) {
      res.alignment = { ...al, against: [...new Set(ref.segments.filter((s) => s.source !== p.source).map((s) => s.source))].join('+') };
      if (!al.aligned && !o.force && o.shiftBars === undefined) {
        throw new Error(`clock looks shifted by ${al.bestShift} bar(s) vs ${res.alignment.against} (return correlation by shift ${JSON.stringify(al.corrByShift)}); re-run with --shift-bars ${-al.bestShift} to fix it or --force to keep it`);
      }
    }
    res.stored = o.dryRun ? clean.length : upsertSeries(o.out, p.source, p.asset, p.tf, clean);
    res.ok = true;
  } catch (e) {
    res.error = (e as Error).message;
  }
  return res;
}

/** Import a .csv or .zip file (a zip may hold several CSVs). */
export function importFile(file: string, o: ImportOpts): ImportResult[] {
  if (file.toLowerCase().endsWith('.zip')) return unzip(fs.readFileSync(file)).filter((e) => e.name.toLowerCase().endsWith('.csv')).map((e) => importCsvText(e.data.toString('utf8'), e.name, o));
  return [importCsvText(fs.readFileSync(file, 'utf8'), path.basename(file), o)];
}

export function collectFiles(inputs: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const f of fs.readdirSync(p).sort()) walk(path.join(p, f));
    else if (/\.(csv|zip)$/i.test(p)) out.push(p);
  };
  for (const i of inputs) walk(i);
  return out;
}

export function printSummary(results: ImportResult[]): void {
  console.table(results.map((r) => ({
    file: r.file.length > 40 ? `...${r.file.slice(-37)}` : r.file, ok: r.ok, source: r.source, asset: r.asset, tf: r.tf, bars: r.report?.bars,
    from: r.report?.from?.slice(0, 10), to: r.report?.to?.slice(0, 10), gaps: r.report?.gaps.count, missing: r.report?.gaps.missingBars,
    jumps: r.report?.jumps.length, shift: r.alignment ? r.alignment.bestShift : '', error: r.error?.slice(0, 80) ?? '',
  })));
  for (const r of results) for (const n of r.notes) console.log(`  ${r.file}: ${n}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const flag = (k: string) => argv.includes(`--${k}`);
  const valued = new Set(['out', 'source', 'asset', 'tf', 'shift-bars']);
  const inputs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && valued.has(argv[i - 1].slice(2))));
  if (!inputs.length) { console.error('usage: npm run history:import -- <file.csv|file.zip|folder> ... [--source s] [--asset A] [--tf 1h] [--shift-bars k] [--out data/history]'); process.exitCode = 2; return; }
  const o: ImportOpts = {
    out: opt('out') ?? 'data/history', source: opt('source'), asset: opt('asset')?.toUpperCase(), tf: opt('tf') as HistTf | undefined,
    shiftBars: opt('shift-bars') !== undefined ? Number(opt('shift-bars')) : undefined, allowNonUsd: flag('allow-non-usd'), force: flag('force'), dryRun: flag('dry-run'),
  };
  const results = collectFiles(inputs).flatMap((f) => importFile(f, o));
  printSummary(results);
  if (!o.dryRun) {
    fs.mkdirSync(o.out, { recursive: true });
    fs.writeFileSync(path.join(o.out, 'import-report.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
  }
  const bad = results.filter((r) => !r.ok).length;
  console.log(`${results.length - bad}/${results.length} imported into ${o.out}${bad ? ` (${bad} failed; see errors above)` : ''}`);
  process.exitCode = bad ? 1 : 0;
}

if (process.argv[1] && /importCsv\.(ts|js|cjs)$/.test(process.argv[1])) void main();

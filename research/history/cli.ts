// One entry point for the historical-data tools, bundled to dist/history.cjs for the server (which
// has no tsx). On the server use deploy/history.sh, which points it at ~/bot/data/history.
//
//   history import <files|folders> [--source s] [--asset A] [--tf 1h] [--shift-bars k] [--force]
//   history binance [--assets auto|BTC,ETH] [--intervals 1h,15m,1d] [--markets spot,um] [--dry-run]
//   history coinbase [--assets auto|BTC,ETH] [--tfs 15m,1h,1d] [--from 2017-01-01]
//   history status                       what is stored: per asset, source and timeframe
//   history ta-net [--assets ...]        train the TA network (writes --out, default params/ta_net.json)
//
// Every command reads/writes --out (default $HISTORY_DIR, else $DATA_DIR/history, else data/history).

import fs from 'fs';
import path from 'path';
import { binanceMain } from './binanceVision';
import { loadSeries, listSeries, readSeries, storedAssets } from './candles';
import { coinbaseMain } from './coinbaseBackfill';
import { collectFiles, importFile, printSummary, type ImportOpts } from './importCsv';
import { trainTaNetMain } from '../trainTaNet';
import type { HistTf } from './candles';

const defaultDir = () => process.env.HISTORY_DIR ?? path.join(process.env.DATA_DIR ?? 'data', 'history');

export function historyStatus(dir: string): Array<Record<string, string | number>> {
  const rows: Array<Record<string, string | number>> = [];
  for (const s of listSeries(dir).sort((a, b) => a.asset.localeCompare(b.asset) || a.source.localeCompare(b.source) || a.tf.localeCompare(b.tf))) {
    const cs = readSeries(s.file);
    rows.push({ asset: s.asset, source: s.source, tf: s.tf, bars: cs.length, from: cs.length ? new Date(cs[0].ts).toISOString().slice(0, 10) : '', to: cs.length ? new Date(cs[cs.length - 1].ts).toISOString().slice(0, 16).replace('T', ' ') : '' });
  }
  return rows;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (k: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : undefined; };
  const argOf = (k: string, d: string) => opt(k) ?? (k === 'out' || k === 'history' ? defaultDir() : d);
  const dir = argOf('out', defaultDir());
  switch (cmd) {
    case 'import': {
      const valued = new Set(['out', 'source', 'asset', 'tf', 'shift-bars']);
      const inputs = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && valued.has(rest[i - 1].slice(2))));
      if (!inputs.length) { console.error('usage: history import <file.csv|file.zip|folder> ...'); return 2; }
      const o: ImportOpts = { out: dir, source: opt('source'), asset: opt('asset')?.toUpperCase(), tf: opt('tf') as HistTf | undefined, shiftBars: opt('shift-bars') !== undefined ? Number(opt('shift-bars')) : undefined, allowNonUsd: rest.includes('--allow-non-usd'), force: rest.includes('--force'), dryRun: rest.includes('--dry-run') };
      const results = collectFiles(inputs).flatMap((f) => importFile(f, o));
      printSummary(results);
      if (!o.dryRun) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'import-report.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 1)); }
      const bad = results.filter((r) => !r.ok).length;
      console.log(`${results.length - bad}/${results.length} imported into ${dir}`);
      return bad ? 1 : 0;
    }
    case 'binance': {
      const r = await binanceMain((k, d) => (k === 'out' ? dir : opt(k) ?? d), (k) => rest.includes(`--${k}`));
      return r.some((x) => x.failed) ? 1 : 0;
    }
    case 'coinbase':
      await coinbaseMain((k, d) => (k === 'out' ? dir : opt(k) ?? d));
      return 0;
    case 'status': {
      const rows = historyStatus(dir);
      if (!rows.length) { console.log(`nothing stored in ${dir} yet`); return 0; }
      console.table(rows);
      for (const a of storedAssets(dir)) {
        const s = loadSeries(dir, a, '1h');
        if (s.candles.length) console.log(`${a} 1h as the network sees it: ${s.candles.length} bars from ${s.segments.map((g) => `${g.source} ${new Date(g.from).toISOString().slice(0, 10)}..${new Date(g.to).toISOString().slice(0, 10)}`).join(' + ')}`);
      }
      return 0;
    }
    case 'ta-net':
      await trainTaNetMain((k, d) => (k === 'history' ? dir : opt(k) ?? d));
      return 0;
    default:
      console.error('commands: import, binance, coinbase, status, ta-net (see research/history/cli.ts)');
      return 2;
  }
}

if (process.argv[1] && /(history\.cjs|history[\\/]cli\.(ts|js))$/.test(process.argv[1])) void main().then((c) => { process.exitCode = c; }).catch((e) => { console.error(e); process.exitCode = 1; });

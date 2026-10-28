// Scratch, not for merging: times one history-walk block on a GitHub runner. Downloads the block's Binance history
// (data.binance.vision, nothing from the server), builds its replay days, then trains one spiking network on them as
// the pipeline's snn-<domain>-train does (research/trainSnn.ts: PC pretraining, e-prop + readout data, readout fit,
// out-of-sample eval), sampling the heap. Prints minutes and MB only (TIMING lines).
//
//   node --import tsx scratch/walkTiming.ts <crypto|perps> <first day> <days>

import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, paperEnv } from '../bot/config';
import type { HistTf } from '../bot/marketdata/historyStore';
import { downloadBinance, downloadBinanceFunding, downloadBinanceOpenInterest } from '../research/history/binanceVision';
import { buildHistoryReplay, replayPerpDays } from '../research/history/historyReplay';
import { trainSnnMain } from '../research/trainSnn';

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const month = (t: number) => new Date(t).toISOString().slice(0, 7);
const mins = (t: number) => ((Date.now() - t) / 60000).toFixed(1);
const mb = (x: number) => Math.round(x / 1048576);

(async () => {
  const domain = (process.argv[2] ?? 'crypto') as 'crypto' | 'perps';
  const first = Date.parse(process.argv[3] ?? '2021-03-01');
  const n = Number(process.argv[4] ?? 6);
  const last = first + (n - 1) * DAY;
  const cfg = loadConfig(paperEnv(process.env));
  const assets = cfg.taNet.historyReplayAssets;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-timing-'));
  const hist = path.join(work, 'history'), rep = path.join(work, 'replay');
  const quiet = () => undefined;

  let t = Date.now();
  const to = month(last);
  const dl = async (intervals: HistTf[], fromT: number, markets: Array<'spot' | 'um'>, source?: string) =>
    (await downloadBinance({ out: hist, assets, intervals, markets, source, fromMonth: month(fromT), toMonth: to, log: quiet })).reduce((a, s) => a + s.fetched, 0);
  const got = {
    spot1m: await dl(['1m'], first - DAY, ['spot'], 'binance-1m'),
    perp1m: domain === 'perps' ? await dl(['1m'], first - DAY, ['um']) : 0,
    candles: await dl(['15m', '1h'], first - 14 * DAY, ['spot']) + await dl(['1d'], first - 310 * DAY, ['spot']),
    funding: domain === 'perps' ? (await downloadBinanceFunding({ out: hist, assets, fromMonth: month(first - DAY), toMonth: to, log: quiet })).reduce((a, s) => a + s.fetched, 0) : 0,
    oi: domain === 'perps' ? (await downloadBinanceOpenInterest({ out: hist, assets, fromDay: iso(first - DAY), toDay: iso(last), log: quiet })).reduce((a, s) => a + s.fetched, 0) : 0,
  };
  const sizeMb = (d: string): number => !fs.existsSync(d) ? 0 : fs.readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? sizeMb(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size / 1048576), 0);
  console.log(`TIMING download ${domain} block ${iso(first)}..${iso(last)} (${n} days, ${assets.length} coins): ${mins(t)} min | archives: 1m spot ${got.spot1m}, 1m perp ${got.perp1m}, candles ${got.candles}, funding ${got.funding}, open interest ${got.oi}; ${Math.round(sizeMb(hist))} MB on disk`);

  t = Date.now();
  const r = await buildHistoryReplay({ historyDir: hist, outDir: rep, assets, fromDay: iso(first - DAY), toDay: iso(last), log: quiet });
  console.log(`TIMING replay build ${n + 1} days (1 warm-up): ${mins(t)} min | written ${r.written}, synthetic contracts ${r.synthetic}, coins ${r.assets.length}, perp days ${replayPerpDays(rep).length}; ${Math.round(sizeMb(rep))} MB`);

  // The pipeline's split: the newest 20% of the span is the out-of-sample eval window.
  const days = Array.from({ length: n }, (_, i) => iso(first + i * DAY));
  const nEval = Math.max(1, Math.round(n * 0.2));
  const trainDays = days.slice(0, n - nEval), evalDays = days.slice(n - nEval);
  const args: Record<string, string> = {
    recordings: rep, domain, stage: cfg.snn.domains[domain].stage, out: path.join(work, `snn_${domain}.json`), 'skip-model': 'true',
    from: trainDays[0], to: evalDays[0], 'eval-from': evalDays[0], 'eval-to': iso(Date.parse(evalDays[evalDays.length - 1]) + DAY),
  };
  // Phases from trainSnnMain's own progress lines; the heap sampled every 10 s, its peak kept per phase.
  const phases: Array<{ name: string; at: number; peak: number; samples: number[] }> = [];
  const mark = (name: string) => phases.push({ name, at: Date.now(), peak: 0, samples: [] });
  const sample = () => { const p = phases[phases.length - 1]; if (!p) return; const h = process.memoryUsage().heapUsed; p.peak = Math.max(p.peak, h); p.samples.push(h); };
  const timer = setInterval(sample, 10_000);
  const err = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const s = String(chunk);
    if (/PC pretraining/.test(s)) mark('PC pretraining');
    else if (/surrogate-gradient/.test(s)) mark('e-prop + readout data');
    return (err as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  const log = console.log;
  let readoutMarked = false;
  console.log = (...a: unknown[]) => {
    const s = a.map(String).join(' ');
    if (/^readout /.test(s) && !readoutMarked) { readoutMarked = true; mark('readout fit'); }
    else if (/^train window/.test(s)) mark('eval (out of sample)');
  };
  t = Date.now();
  let res: Awaited<ReturnType<typeof trainSnnMain>> | undefined, failure: string | undefined;
  try { res = await trainSnnMain((k, d) => args[k] ?? d, false); } catch (e) { failure = (e as Error).message; }
  sample();
  clearInterval(timer);
  console.log = log;
  mark('end');
  for (let i = 0; i + 1 < phases.length; i++) {
    const p = phases[i], next = phases[i + 1];
    // The heap's path through the phase: 6 evenly spaced samples (a steady climb is memory growing with the days).
    const path6 = p.samples.length ? Array.from({ length: 6 }, (_, k) => mb(p.samples[Math.min(p.samples.length - 1, Math.round((k * (p.samples.length - 1)) / 5))])).join(' > ') : 'n/a';
    console.log(`TIMING snn ${domain} ${p.name}: ${((next.at - p.at) / 60000).toFixed(1)} min, peak heap ${mb(p.peak)} MB | heap path ${path6}`);
  }
  const s = (x?: { n: number; snn: number; model: number }) => (x ? `n ${x.n}, Brier snn ${x.snn.toFixed(4)} vs fair value ${x.model.toFixed(4)}` : 'n/a');
  console.log(`TIMING snn ${domain} train on ${trainDays.length} day(s) + eval ${evalDays.length}: ${mins(t)} min | ${failure ? `failed: ${failure.slice(0, 120)}` : `train ${s(res?.train)} | eval ${s(res?.eval)}`}; heap limit ${mb((await import('v8')).getHeapStatistics().heap_size_limit)} MB`);
})().catch((e) => { console.error(`TIMING failed: ${(e as Error).message}`); process.exitCode = 1; });

// SNN history training on Kalshi's own contract history (Steven, Oct 31: "the SNNs haven't really been able to learn
// ... fix this expeditiously"). The anchored crypto network learns its correction to the market only when a contract
// settles: about 460 windows a day, and the ablations replay 8 recorded days. Kalshi's settled crypto contracts with
// their 1-minute bid / ask candles (history/kalshi, repaired by PR #219) cover months more. This walks ONE anchored
// crypto network through them in time order, week by week, carrying its whole state (research/snnReplay.ts with a
// checkpoint), real contracts only (no synthetic ones), and prints after every month how it priced that month BEFORE
// learning each outcome (prequential: every price precedes the settlement that trains on it), against the market:
// the learning curve. The checkpoint at the end is the network a recorded-days ablation then starts from (--init).
//
// This is prediction learning, not trading: no fills are simulated, so the depth simulator's fill check does not gate it.
//
//   node --import tsx research/snnHistoryTrain.ts --from 2026-01-01 --to 2026-09-30 --history <dir with kalshi/> \
//     --work <scratch> [--checkpoint-in in.json] --checkpoint-out out.json [--minutes 330] [--vol-norm 1] [--synthetic true]

import fs from 'fs';
import path from 'path';
import { loadConfig, paperEnv } from '../bot/config';
import { loadCalendar } from '../bot/model/calendar';
import type { SnnCheckpoint } from '../bot/snn/network';
import { DEFAULT_SNN, domainParams, stageFlags, type SnnParams, type Stage } from '../bot/snn/params';
import { downloadBinance } from './history/binanceVision';
import { buildHistoryReplay } from './history/historyReplay';
import { addDays } from './historyWalkState';
import { correctionStats, vsMarket } from './snnAblation';
import { replaySnn } from './snnReplay';

const arg = (k: string, d = '') => { const i = process.argv.indexOf(`--${k}`); return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d; };

/** Month chunks [first, last] covering from..to (inclusive days). */
export function monthChunks(from: string, to: string): [string, string][] {
  const out: [string, string][] = [];
  let a = from;
  while (a <= to) {
    const [y, m] = a.split('-').map(Number);
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // last day of a's month
    const b = end < to ? end : to;
    out.push([a, b]);
    a = addDays(b, 1);
  }
  return out;
}

/** The month chunks cut into pieces of at most `days` days, so the checkpoint (and the learning curve) is saved often
 *  and a job stopped by its time limit loses at most one piece. */
export function trainChunks(from: string, to: string, days = 7): [string, string][] {
  const out: [string, string][] = [];
  for (const [a, b] of monthChunks(from, to)) {
    let x = a;
    while (x <= b) { const y = addDays(x, days - 1) < b ? addDays(x, days - 1) : b; out.push([x, y]); x = addDays(y, 1); }
  }
  return out;
}

/** Where a continued training starts: the day after the checkpoint's last scored moment (never before --from). */
export function resumeDay(from: string, lastTs: number | undefined): string {
  if (!lastTs || !Number.isFinite(lastTs)) return from;
  const next = addDays(new Date(lastTs).toISOString().slice(0, 10), 1);
  return next > from ? next : from;
}

/** How many of the days a..b have a Kalshi day file in any series (building a replay without one scores nothing). */
export function kalshiDays(kalshiDir: string, a: string, b: string): number {
  if (!fs.existsSync(kalshiDir)) return 0;
  const series = fs.readdirSync(kalshiDir);
  let n = 0;
  for (let d = a; d <= b; d = addDays(d, 1)) if (series.some((s) => fs.existsSync(path.join(kalshiDir, s, `${d}.jsonl`)))) n++;
  return n;
}

export function trainParams(stage: Stage, volNorm?: number, soft = false): SnnParams {
  return domainParams('crypto', { ...DEFAULT_SNN, anchorMid: true, ...(volNorm ? { volNorm } : {}), ...(soft ? { softLabel: { lagSec: 300, etaScale: 0.3 } } : {}), flags: { ...stageFlags(stage) } });
}

async function main() {
  const from = arg('from'), to = arg('to');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new Error('--from / --to YYYY-MM-DD');
  const work = arg('work', 'research/out/snn-history'), hist = arg('history', path.join(work, 'history')), rep = path.join(work, 'replay');
  const deadline = Date.now() + Number(arg('minutes', '330')) * 60_000;
  const cfg = loadConfig(paperEnv(process.env));
  const assets = cfg.taNet.historyReplayAssets;
  const stage = (arg('stage', '') || cfg.snn.domains.crypto.stage) as Stage;
  const volNorm = Number(arg('vol-norm', '0')) || undefined;
  const soft = arg('soft', '') === 'true';
  // Synthetic contracts (Steven, Nov 1): where Kalshi has no contract history, the same 15m Up/Down and hourly ladders
  // built from the price path, quoted at a no-skill fair value (research/history/historyReplay.ts). They teach the
  // network the price path's direction only, never Kalshi's pricing: real days judge what that is worth.
  const synthetic = arg('synthetic', '') === 'true';
  // Adversary (Steven, Nov 1: try to break whatever is producing gains): with --requote true the real contracts'
  // quotes follow the index at every print between their minute candles instead of standing still for the minute.
  // An edge that only exists against the standing minute quote is the replay's staleness, not the market's.
  const requote = arg('requote', '') === 'true';
  const params = trainParams(stage, volNorm, soft);
  const calendar = loadCalendar(path.resolve('params/calendar.json'));
  let checkpoint: SnnCheckpoint | undefined;
  const ckIn = arg('checkpoint-in');
  let start = from;
  if (ckIn && fs.existsSync(ckIn)) {
    checkpoint = JSON.parse(fs.readFileSync(ckIn, 'utf8')) as SnnCheckpoint;
    start = resumeDay(from, checkpoint.lastTs);
    const upd = checkpoint.columns.reduce((s, c) => s + (c.readout?.updates ?? 0), 0);
    console.log(`[hist-train] continuing from ${ckIn}: last scored ${checkpoint.lastTs ? new Date(checkpoint.lastTs).toISOString() : 'never'}, ${upd} readout updates so far; resuming at ${start}`);
  }
  const ckOut = arg('checkpoint-out', path.join(work, 'checkpoint.json'));
  console.log(`[hist-train] anchored crypto SNN, stage ${stage}${volNorm ? `, volNorm ${volNorm}` : ''}${soft ? ', soft labels' : ''}${synthetic ? ', synthetic contracts where Kalshi has none' : ''}${requote ? ', ADVERSARY: quotes requoted between candles' : ''}, ${from}..${to}, ${assets.join(',')}`);

  const f5 = (x: { mean: number; lo: number; hi: number }) => `${x.mean.toFixed(5)} [${x.lo.toFixed(5)}, ${x.hi.toFixed(5)}]`;
  if (start > to) { console.log(`[hist-train] the checkpoint already covers ${from}..${to}`); if (checkpoint) { fs.mkdirSync(path.dirname(ckOut), { recursive: true }); fs.writeFileSync(ckOut, JSON.stringify(checkpoint)); } return; }
  for (const [a, b] of trainChunks(start, to)) {
    if (Date.now() > deadline) { console.log(`[hist-train] time is up before ${a}: the next run continues from the checkpoint`); break; }
    const warm = addDays(a, -1), t0 = Date.now();
    if (!synthetic && !kalshiDays(path.join(hist, 'kalshi'), a, b)) { console.log(`[hist-train] ${a}..${b}: no Kalshi history on these days, skipped`); continue; }
    console.log(`[hist-train] ${a}..${b}: building and replaying`);
    const month = (d: string) => d.slice(0, 7);
    const dl = async (intervals: ('1m' | '15m' | '1h' | '1d')[], f: string, source?: string) =>
      (await downloadBinance({ out: hist, assets, intervals, markets: ['spot'], source, fromMonth: month(f), toMonth: month(b), log: () => undefined })).reduce((s, x) => s + x.fetched, 0);
    await dl(['1m'], warm, 'binance-1m');
    await dl(['15m', '1h'], addDays(warm, -14));
    await dl(['1d'], addDays(warm, -310));
    const built = await buildHistoryReplay({ historyDir: hist, outDir: rep, assets, fromDay: warm, toDay: b, synthetic, requote, log: () => undefined });
    const res = await replaySnn(rep, { params, from: Date.parse(`${a}T00:00:00Z`), to: Date.parse(`${b}T23:59:59Z`), fromDay: warm, toDay: b, calendar, domain: 'crypto', checkpoint, skipModel: true });
    checkpoint = res.net.serialize();
    fs.mkdirSync(path.dirname(ckOut), { recursive: true });
    fs.writeFileSync(ckOut, JSON.stringify(checkpoint));
    const windows = new Set(res.rows.map((r) => r.eventKey)).size;
    const frozen = res.steps ? (100 * res.frozenSteps) / res.steps : 0;
    if (!res.rows.length) { console.log(`[hist-train] ${a}..${b}: no contracts scored (${built.written} day(s) built; Kalshi history missing for these days?)`); continue; }
    const vm = vsMarket(res.rows, 1000), c = correctionStats(res.rows);
    console.log(`[hist-train] ${a}..${b}: ${windows} windows, vs market ${f5(vm)} ${vm.hi < 0 ? 'BEATS the market' : vm.lo > 0 ? 'worse' : 'undecided'}; correction size ${c.sizeCents.toFixed(2)}c edge ${c.edgeCents.toFixed(2)}c b ${c.slope.toFixed(2)}; learning frozen ${frozen.toFixed(1)}%;${built.synthetic ? ` ${built.synthetic} synthetic contracts;` : ''} ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    // Rows of this month are not needed any more (memory over months).
    res.rows.length = 0;
  }
  console.log(`[hist-train] checkpoint -> ${ckOut}`);
}

if (process.argv[1] && /snnHistoryTrain\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(`history training failed: ${e instanceof Error ? e.stack : e}`); process.exit(1); });

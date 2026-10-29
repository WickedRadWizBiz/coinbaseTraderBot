// TA contract study (the TA network review, Oct 29: phases 1 and 2). Does technical analysis on the spot candles say
// anything about a 15-minute contract's settlement that the mathematical fair value does not, and anything Kalshi's own
// price does not? Years of history, the contract's own question, the existing trainer.
//
//   node --import tsx research/taContractStudy.ts --from 2025-10-01 --to 2026-09-30 [--assets BTC,ETH,SOL,XRP,DOGE]
//        [--history data/history] [--replay data/ta-study-replay] [--out research/out/ta-contract-study]
//        [--sets base,base+ta,...] [--max-rows 250000] [--max-contracts 60000] [--kalshi-budget-min 20] [--skip-download] [--skip-replay] [--rebuild-replay]
//
// 1. Binance's 1-minute spot bars for the assets and months (data.binance.vision, research/history/binanceVision.ts),
//    and Kalshi's settled 15-minute contracts over the same days with their minute quotes (public API,
//    research/history/kalshiHistory.ts; at most --kalshi-budget-min of requests a run, the rest next run).
// 2. The history replay turns them into recording days (research/history/historyReplay.ts): a synthetic 15-minute
//    Up/Down contract every quarter hour per coin, with Kalshi's rules (the strike is the 60 s index average before
//    the open, the result the 60 s average before the close), plus Kalshi's real contracts where <history>/kalshi has
//    them. Every candle timeframe the live feature engine reads comes along.
// 3. One dataset row per contract per minute of its entry window (research/buildDataset.ts, synthetic contracts
//    included): the exact production feature vector, the fair value, the settlement label.
// 4. Phase 1, on the SYNTHETIC rows (their quotes are the fair value itself, so no market view leaks in): gradient-
//    boosted trees over the fair value's log-odds with the trainer's purged walk-forward folds, embargo and 1-SE rule
//    (research/trainMetaModel.ts), one run per feature set. The 'base' set is the fair value's own geometry, so a TA
//    set earns its place only by beating 'base' out of fold by more than one standard error, and the final 20% of
//    windows is an untouched holdout where the chosen model is judged against the fair value.
// 5. Phase 2, on the REAL rows (Kalshi's contracts, their minute quotes): the chosen model's price against Kalshi's
//    mid (log loss, Diebold-Mariano), and the stack p = sigmoid(logit(mid) + w x (logit(model) - logit(fair value)))
//    with w chosen on the first half of the real windows and judged on the second: how much of the model's view the
//    market has not priced already. w near zero means TA stays out of the price.
// Prints aggregates only (this repository is public): row counts, log losses, the chosen set, w. The report goes to
// <out>/report.json. Never run inside the daily training's window (train.yml copies to and from the server then);
// this study touches no server.

import fs from 'fs';
import path from 'path';
import { brier, weightedLogLoss } from '../bot/model/calibration';
import crypto from 'crypto';
import { featuresInGroups, type FeatureGroup } from '../bot/model/featureEngine';
import { MetaModel } from '../bot/model/metaModel';
import { clamp, logit, sigmoid } from '../bot/util/num';
import { buildDataset, readDataset, type DatasetRow } from './buildDataset';
import { downloadBinance } from './history/binanceVision';
import { buildHistoryReplay, replayKalshiDays } from './history/historyReplay';
import { downloadKalshiHistory } from './history/kalshiHistory';
import { series15m } from './kalshiReplayData';
import { gradeHorizons, IFTRADES_TRIGGERS, loadTriggers, type CoinTriggers, type HorizonGrade } from './iftradesTriggers';
import { dieboldMariano } from './stats';
import { rowWeights, trainMetaModel, type TrainReport } from './trainMetaModel';

/** The feature sets compared: the fair value's geometry alone, then the TA library and the confluence readings on top. */
export const STUDY_SETS = ['base', 'base+ta', 'base+ta+taconf', 'base+momentum+confluence', 'base+ta+taconf+momentum+confluence', 'base+ta+taconf+momentum+confluence+vol+clock', 'base+iftrades', 'base+momentum+confluence+iftrades'];
/** Study-only group: the operator's iftrades strategy triggers (research/iftradesTriggers.ts), read into every row. */
export const IFTRADES_GROUP = 'iftrades';

export interface TriggerContracts { trigger: string; side: 1 | -1; contracts: number; upShare: number; fvMean: number; z: number }

/** Per trigger and side, over the first row of each contract: how often the contract settled Up against what the fair
 *  value said, and the normal z of that difference (binomial, independent contracts). */
export function triggerContracts(rows: DatasetRow[]): TriggerContracts[] {
  const first = new Map<string, DatasetRow>();
  for (const r of rows) { const k = `${r.asset}:${r.window}`; const f = first.get(k); if (!f || r.t < f.t) first.set(k, r); }
  const out: TriggerContracts[] = [];
  for (const trigger of IFTRADES_TRIGGERS) for (const side of [1, -1] as const) {
    let n = 0, up = 0, fv = 0;
    for (const r of first.values()) if (r.fx[trigger] === side) { n++; up += r.label; fv += r.fv; }
    const fvMean = n ? fv / n : NaN, upShare = n ? up / n : NaN;
    const z = n ? (upShare - fvMean) / Math.sqrt(Math.max(1e-9, (fvMean * (1 - fvMean)) / n)) : NaN;
    out.push({ trigger, side, contracts: n, upShare, fvMean, z });
  }
  return out;
}

export interface StackFit { w: number; devLogLoss: number; testLogLoss: number; testMidLogLoss: number; dm: ReturnType<typeof dieboldMariano> }

export interface StudyReport {
  from: string; to: string; assets: string[];
  replay: { days: number; synthetic: number; kalshiDays: number };
  rows: { total: number; kept: number; synthetic: number; real: number; windows: number };
  phase1: { cv: TrainReport['cv']; base?: TrainReport['cv'][number]; selected: TrainReport['selected']; holdout: TrainReport['holdout']; dropped: TrainReport['dropped'];
    /** Each set's out-of-fold edge over 'base' in standard errors of its own log loss (> 1 earns its place). */
    edge: Array<{ set: string; model: string; features: number; dLogLoss: number; se: number; sigma: number }> };
  iftrades?: { contracts: TriggerContracts[]; horizons: HorizonGrade[] };
  phase2?: { rows: number; windows: number; logLoss: { model: number; fairValue: number; mid: number }; dm: ReturnType<typeof dieboldMariano>;
    stack: StackFit };
}

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DAY = 86_400_000;

/** The stack's weight w fitted by a grid on the dev rows (weighted log loss), the fit judged on the test rows. The
 *  Diebold-Mariano p is one-sided: P(the stack beats the mid alone) under no difference (research/stats.ts). */
export function fitStack(dev: Array<{ mid: number; model: number; fv: number; y: 0 | 1; w: number }>, test: typeof dev): StackFit {
  const p = (r: { mid: number; model: number; fv: number }, w: number) => sigmoid(logit(clamp(r.mid, 0.01, 0.99)) + w * (logit(clamp(r.model, 0.001, 0.999)) - logit(clamp(r.fv, 0.001, 0.999))));
  const loss = (rs: typeof dev, w: number) => weightedLogLoss(rs.map((r) => p(r, w)), rs.map((r) => r.y), rs.map((r) => r.w));
  let best = { w: 0, devLogLoss: loss(dev, 0) };
  for (let w = -0.5; w <= 2.0001; w += 0.05) { const l = loss(dev, w); if (l < best.devLogLoss - 1e-12) best = { w: +w.toFixed(2), devLogLoss: l }; }
  const testLogLoss = loss(test, best.w), testMidLogLoss = loss(test, 0);
  const ll = (q: number, y: number) => -(y * Math.log(clamp(q, 1e-6, 1 - 1e-6)) + (1 - y) * Math.log(1 - clamp(q, 1e-6, 1 - 1e-6)));
  const dm = dieboldMariano(test.map((r) => ll(r.mid, r.y) - ll(p(r, best.w), r.y)));
  return { w: best.w, devLogLoss: best.devLogLoss, testLogLoss, testMidLogLoss, dm };
}

export async function taContractStudyMain(): Promise<StudyReport> {
  const t0 = Date.now();
  const log = (m: string) => console.log(`[ta-study +${((Date.now() - t0) / 60_000).toFixed(0)}m] ${m}`);
  const history = arg('history', 'data/history'), replay = arg('replay', 'data/ta-study-replay'), out = arg('out', 'research/out/ta-contract-study');
  const assets = arg('assets', 'BTC,ETH,SOL,XRP,DOGE').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const to = arg('to', new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10));
  const from = arg('from', new Date(Date.parse(to) - 120 * DAY).toISOString().slice(0, 10));
  const sets = arg('sets', STUDY_SETS.join(',')).split(',');
  // Rows in memory: past this, each contract's snapshots are thinned evenly (readDataset), never below one a contract.
  // 193k rows of 111 inputs fit the runner's 12 GB heap; 250k did not (a year of five coins with Kalshi's contracts).
  const maxRows = Number(arg('max-rows', '150000'));
  // Contracts kept (a deterministic share by ticker hash): a year of five coins makes ~175k contracts, and a row is kept
  // for each of them, so this caps the rows a run reads back into memory (the trainer weights contracts equally anyway).
  const maxContracts = Number(arg('max-contracts', '60000'));
  // Only the inputs the compared sets read go into the rows (the full production vector is ~400 inputs a row).
  const keep = new Set(featuresInGroups([...new Set(sets.flatMap((x) => x.split('+')))].filter((g) => g !== IFTRADES_GROUP) as FeatureGroup[]));
  const iftrades = !process.argv.includes('--no-iftrades') && sets.some((x) => x.split('+').includes(IFTRADES_GROUP));
  fs.mkdirSync(out, { recursive: true });

  // 1. History. The 1-minute bars make the index prints and the 1m / 5m candles; the replay reads the 15m, hourly and
  //    daily candles from the spot store (research/history/historyReplay.ts loadSeries), and its first day starts with
  //    the last 300 closed bars of each, so the daily series reaches back about a year before `from`.
  if (!process.argv.includes('--skip-download')) {
    const month = (ms: number) => new Date(ms).toISOString().slice(0, 7);
    const toMonth = to.slice(0, 7);
    const rs = await downloadBinance({ out: history, assets, intervals: ['1m'], markets: ['spot'], source: 'binance-1m', fromMonth: month(Date.parse(from) - 31 * DAY), toMonth, log: (m) => log(`binance: ${m}`) });
    const slow = await downloadBinance({ out: history, assets, intervals: ['15m', '1h', '1d'], markets: ['spot'], fromMonth: month(Date.parse(from) - 400 * DAY), toMonth, log: (m) => log(`binance: ${m}`) });
    log(`binance: ${rs.length + slow.length} series checked`);
    const budgetMin = Number(arg('kalshi-budget-min', '20'));
    if (budgetMin > 0) {
      const days = Math.ceil((Date.now() - Date.parse(from)) / DAY) + 1;
      const k = await downloadKalshiHistory({ baseUrl: process.env.KALSHI_REST_URL ?? 'https://external-api.kalshi.com/trade-api/v2', series: series15m(assets), days, out: path.join(history, 'kalshi'), budgetMs: budgetMin * 60_000, ratePerSec: 5, log: (m) => log(`kalshi: ${m}`) });
      log(`kalshi: ${k.markets} markets stored, ${k.skipped} already there, ${k.remaining} left for the next run${k.budgetHit ? ' (budget hit)' : ''}`);
    }
  }
  // 2. Replay days with synthetic contracts (and Kalshi's real ones where the history has them).
  let rep = { days: 0, synthetic: 0 };
  if (!process.argv.includes('--skip-replay')) {
    // --rebuild-replay: days already built are built again (the replay otherwise skips them, e.g. after a history fix).
    const r = await buildHistoryReplay({ historyDir: history, outDir: replay, assets, fromDay: from, toDay: to, synthetic: true, force: process.argv.includes('--rebuild-replay'), log: (m) => log(`replay: ${m}`) });
    rep = { days: r.days, synthetic: r.synthetic };
    for (const n of r.notes) log(`replay: ${n}`);
  }
  const kalshiDays = replayKalshiDays(replay).length;
  // 2b. The iftrades triggers, from the same 1-minute history (every row gets their values at its time).
  const triggers: Map<string, CoinTriggers> = iftrades ? await loadTriggers(history, assets, from, to, (m) => log(`iftrades: ${m}`)) : new Map();
  // 3. Rows, streamed to disk as contracts settle.
  const file = path.join(out, 'rows.jsonl');
  let total = 0, synth = 0, contracts = 0, skippedContracts = 0;
  const kept = new Map<string, boolean>();
  const keepContract = (ticker: string) => {
    let k = kept.get(ticker);
    if (k === undefined) {
      // Real contracts are few and all kept; synthetic ones by a fixed share of their ticker hash.
      const h = parseInt(crypto.createHash('sha1').update(ticker).digest('hex').slice(0, 8), 16) / 0x100000000;
      k = h < Math.min(1, maxContracts / Math.max(1, expectedContracts));
      kept.set(ticker, k);
      if (k) contracts++; else skippedContracts++;
    }
    return k;
  };
  // Synthetic 15-minute contracts expected: one a quarter hour per coin over every replay day on disk (the dataset reads
  // them all, not only this run's from..to: a cache carries earlier blocks).
  const replayDays = fs.existsSync(replay) ? fs.readdirSync(replay).filter((f) => /^md-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f)).length : 0;
  const expectedContracts = Math.max(1, Math.max(replayDays, Math.round((Date.parse(to) - Date.parse(from)) / DAY + 1)) * 96 * assets.length);
  const fd = fs.openSync(`${file}.tmp`, 'w');
  let buf: string[] = [];
  const drain = () => { if (buf.length) { fs.writeSync(fd, buf.join('')); buf = []; } };
  try {
    // Snapshots every 3 minutes (4 a contract; the trainer keeps one or two) and only the sampled contracts: the
    // feature vector is the expensive part, so neither is computed for a contract the rows will not hold.
    await buildDataset(replay, Number(arg('every', '180')), 5e-5, {
      entryWindowOnly: true, includeSynthetic: true,
      skipMarket: (m) => (m.kind ?? 'updown') !== 'updown' || (!!m.synthetic && !keepContract(m.ticker)),
      // The 15-minute Up/Down contracts only: the replay's hourly ladder is another question (and four times the rows).
      onRow: (r) => {
        const fx: Record<string, number> = {};
        for (const k of Object.keys(r.fx)) if (keep.has(k)) fx[k] = r.fx[k];
        const tg = triggers.get(r.asset);
        if (tg) Object.assign(fx, tg.at(r.t));
        buf.push(JSON.stringify({ ...r, fx }) + '\n'); total++; if (r.synthetic) synth++; if (buf.length >= 2000) drain();
        if (total % 100_000 === 0) log(`rows: ${total} so far (${new Date(r.t).toISOString().slice(0, 10)})`);
      },
    });
    drain();
  } finally { fs.closeSync(fd); }
  fs.renameSync(`${file}.tmp`, file);
  log(`rows: ${total} (${synth} synthetic, ${total - synth} real) over ${replayDays} replay day(s); ${contracts} synthetic contracts kept, ${skippedContracts} left out (max ${maxContracts}); ${keep.size} inputs a row`);
  const { rows } = await readDataset(file, maxRows > 0 ? maxRows : Infinity);
  const synthRows = rows.filter((r) => r.synthetic), realRows = rows.filter((r) => !r.synthetic);
  const windows = new Set(rows.map((r) => r.window)).size;
  log(`kept ${rows.length} rows (${synthRows.length} synthetic, ${realRows.length} real) over ${windows} windows`);
  if (synthRows.length < 1000) throw new Error(`too few synthetic rows (${synthRows.length}): is the 1-minute history there?`);

  // 4. Phase 1: the trainer, trees only, one configuration per set; no take model, no Student-t search.
  const t = await trainMetaModel(synthRows, { sets, families: ['gbdt'], takeModel: false, ensemble: 1, cpcvGroups: 0, fixedNu: null, depths: [2, 3], extraGroups: iftrades ? { [IFTRADES_GROUP]: [...IFTRADES_TRIGGERS] } : undefined, log: (m) => log(`train: ${m}`) });
  const base = t.cv.filter((c) => c.set === 'base').sort((a, b) => a.oosLogLoss - b.oosLogLoss)[0];
  const edge = t.cv.map((c) => ({ set: c.set, model: c.model, features: c.features, dLogLoss: base ? base.oosLogLoss - c.oosLogLoss : NaN, se: c.se, sigma: base && c.se > 0 ? (base.oosLogLoss - c.oosLogLoss) / c.se : NaN }));
  console.table(edge.map((e) => ({ ...e, dLogLoss: +e.dLogLoss.toFixed(5), se: +e.se.toFixed(5), sigma: +e.sigma.toFixed(2) })));
  // A set missing from the table resolved to another set's features once its mostly-missing inputs were dropped.
  for (const [set, names] of Object.entries(t.dropped)) log(`train: dropped from ${set}: ${names.length} input(s): ${names.slice(0, 12).join('; ')}${names.length > 12 ? '; ...' : ''}`);
  const present = (name: string) => synthRows.filter((r) => Number.isFinite(r.fx[name])).length / synthRows.length;
  log(`inputs present in synthetic rows: ${['ta_rsi_1h', 'ta_rsi_15m', 'ta_ema_stack_1h', 'taconf_net_trend', 'taconf_mtf_momentum', 'conf_count', 'ret_1h_z', 'tanet_up_1h', 'if_rsi20_15m', 'if_dip_2_4h'].map((n) => `${n} ${(present(n) * 100).toFixed(0)}%`).join(', ')}`);
  log(`phase 1: selected ${t.selected.set} / ${t.selected.model} (${t.selected.rule}); holdout log loss model ${t.holdout.logLossModel.toFixed(5)} vs fair value ${t.holdout.logLossMarket.toFixed(5)} over ${t.holdout.nWindows} windows (Brier ${t.holdout.brierModel.toFixed(5)} vs ${t.holdout.brierFairValue.toFixed(5)})`);
  const report: StudyReport = { from, to, assets, replay: { ...rep, kalshiDays }, rows: { total, kept: rows.length, synthetic: synthRows.length, real: realRows.length, windows }, phase1: { cv: t.cv, base, selected: t.selected, holdout: t.holdout, dropped: t.dropped, edge } };

  // 4b. The iftrades triggers on their own: contracts that settled Up after each, and the spot path after each firing.
  if (triggers.size) {
    const contracts = triggerContracts(rows), horizons = gradeHorizons(triggers, [15, 60, 240], from, to);
    report.iftrades = { contracts, horizons };
    log('iftrades: contracts whose first snapshot had the trigger on (side +1 = the strategy\'s buy condition), share settled Up vs the fair value\'s share; 200+ contracts shown');
    console.table(contracts.filter((c) => c.contracts >= 200).map((c) => ({ ...c, upShare: +c.upShare.toFixed(4), fvMean: +c.fvMean.toFixed(4), z: +c.z.toFixed(2) })));
    log('iftrades: spot log return after each non-overlapping firing, in the firing\'s direction (bps, before fees; a spot round trip costs ~10 bps)');
    console.table(horizons.filter((h) => h.n >= 30).map((h) => ({ ...h, hit: +h.hit.toFixed(3), meanBps: +h.meanBps.toFixed(1), tStat: +h.tStat.toFixed(2) })));
  }

  // 5. Phase 2: the chosen model on Kalshi's real contracts, against the mid; then the stack.
  if (realRows.length >= 500) {
    const live = MetaModel.fromJson(JSON.stringify(t.params));
    const sorted = [...realRows].sort((a, b) => a.window - b.window || a.t - b.t);
    const w = rowWeights(sorted);
    const y = sorted.map((r) => r.label);
    const pm = sorted.map((r) => live.predict(r.fx, r.fv));
    const ll = (q: number, yy: number) => -(yy * Math.log(clamp(q, 1e-6, 1 - 1e-6)) + (1 - yy) * Math.log(1 - clamp(q, 1e-6, 1 - 1e-6)));
    const dm = dieboldMariano(sorted.map((r, i) => ll(r.mid, y[i]) - ll(pm[i], y[i])));
    const rw = sorted.map((r, i) => ({ mid: r.mid, model: pm[i], fv: r.fv, y: r.label, w: w[i] }));
    const wins = [...new Set(sorted.map((r) => r.window))].sort((a, b) => a - b);
    const cut = wins[Math.floor(wins.length / 2)];
    const stack = fitStack(rw.filter((_, i) => sorted[i].window < cut), rw.filter((_, i) => sorted[i].window >= cut));
    report.phase2 = { rows: sorted.length, windows: wins.length, logLoss: { model: weightedLogLoss(pm, y, w), fairValue: weightedLogLoss(sorted.map((r) => r.fv), y, w), mid: weightedLogLoss(sorted.map((r) => r.mid), y, w) }, dm, stack };
    log(`phase 2: ${sorted.length} real rows over ${wins.length} windows: log loss model ${report.phase2.logLoss.model.toFixed(5)}, fair value ${report.phase2.logLoss.fairValue.toFixed(5)}, Kalshi mid ${report.phase2.logLoss.mid.toFixed(5)} (DM mid - model: ${dm.meanDiff.toFixed(5)}, P(model better) ${dm.pValue.toFixed(3)})`);
    log(`phase 2: stack w = ${stack.w} (dev log loss ${stack.devLogLoss.toFixed(5)}); test log loss ${stack.testLogLoss.toFixed(5)} vs mid alone ${stack.testMidLogLoss.toFixed(5)} (P(stack better) ${stack.dm.pValue.toFixed(3)}); Brier mid ${brier(sorted.map((r) => r.mid), y).toFixed(5)}`);
  } else log(`phase 2 skipped: ${realRows.length} real rows (Kalshi's history has ${kalshiDays} replayed day(s) here)`);

  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  log(`wrote ${path.join(out, 'report.json')}`);
  return report;
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void taContractStudyMain().catch((e) => { console.error(e); process.exit(1); });

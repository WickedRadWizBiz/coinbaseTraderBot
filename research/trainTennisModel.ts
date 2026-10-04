// Train the tennis MLP on recorded matches: fair P(player A wins) from the four confluence signals
// (momentum, flow, depth, cross-market) with magnitudes, the live score (Live Tennis API recordings),
// progress, the score model, the book, and the SNN's logged P(A) / direction call. A residual
// network on the market's log-odds, split by MATCH in time order (80/20). Validated only with
// >= 100 matches and a held-out Brier better than the market's.
//
//   npm run research:tennis-train -- --recordings data/recordings [--out params/tennis_model.candidate.json]

import fs from 'fs';
import path from 'path';
import { loadConfig, type TennisConfig } from '../bot/config';
import { tennisSnapshotValues } from '../bot/snn/inputs';
import { TENNIS_FAIR_FEATURES, tennisFairInputs, type TennisFairParams } from '../bot/tennis/tennisFair';
import { MatchTracker, type MatchMarket } from '../bot/tennis/tennisStrategy';
import { sigmoid } from '../bot/util/num';
import { predictLogits, train } from './mlp';
import { predictGbdtLogits, trainGbdt } from './gbdt';
import { readRecordings, ReplayState } from './replay';

export interface TennisRow { event: string; t: number; f: Record<string, number>; pA: number; y: 0 | 1 }

function flowOf(st: ReplayState, ticker: string, windowSec: number): number | undefined {
  const tr = st.features.micro.get(ticker)?.tradesIn(st.now, windowSec * 1000) ?? [];
  const tot = tr.reduce((x, y) => x + y.count, 0);
  return tot > 0 ? tr.reduce((x, y) => x + y.signed, 0) / tot : undefined;
}

/** One row per match per `everySec` while it trades, built with the engine's own input function. */
export async function buildTennisDataset(dir: string, cfg: TennisConfig, everySec = 60): Promise<TennisRow[]> {
  const st = new ReplayState();
  const trackers = new Map<string, MatchTracker>();
  const pending = new Map<string, Omit<TennisRow, 'y'>[]>();
  const lastSample = new Map<string, number>();
  const rows: TennisRow[] = [];
  const eventOf = (t: string) => st.markets.get(t)?.event ?? t.slice(0, t.lastIndexOf('-'));
  let last = 0;
  for await (const e of readRecordings(dir)) {
    st.apply(e);
    if (st.now - last < 5000) continue;
    last = st.now;
    const byEvent = new Map<string, string[]>();
    for (const m of st.markets.values()) if (m.kind === 'match') byEvent.set(eventOf(m.ticker), [...(byEvent.get(eventOf(m.ticker)) ?? []), m.ticker]);
    for (const [event, tickers] of byEvent) {
      tickers.sort();
      const ms = tickers.map((t) => st.markets.get(t)!);
      const rA = st.results.get(ms[0].ticker);
      if (rA || st.now >= Math.min(...ms.map((m) => m.closeTime)) + 60_000) {
        if (rA) for (const r of pending.get(event) ?? []) rows.push({ ...r, y: rA === 'yes' ? 1 : 0 });
        pending.delete(event); trackers.delete(event);
        for (const m of ms) st.markets.delete(m.ticker);
        continue;
      }
      let tr = trackers.get(event);
      if (!tr) { tr = new MatchTracker(event, cfg); trackers.set(event, tr); }
      const markets: MatchMarket[] = ms.map((m) => {
        const b = st.books.get(m.ticker);
        const usable = b?.isUsable(st.now, 10_000);
        return { ticker: m.ticker, title: m.title, position: 0, quote: { bid: usable ? b!.bestBid()?.price : undefined, ask: usable ? b!.bestAsk()?.price : undefined }, book: usable ? b : undefined, flow: flowOf(st, m.ticker, cfg.confWindowSec) };
      });
      const sc = st.tennisScores.get(event);
      const score = sc && st.now - sc.ts <= 10 * 60_000 ? sc : undefined;
      tr.observe({ event, now: st.now, startTime: ms.find((m) => m.startTime)?.startTime, markets, closeTime: Math.min(...ms.map((m) => m.closeTime)), score });
      if (st.now - (lastSample.get(event) ?? 0) < everySec * 1000) continue;
      const v = tennisSnapshotValues(tr, markets, st.now, cfg, { tiebreak: score?.tiebreak, breaksTotal: score?.breaksTotal ?? undefined });
      if (!v || v.mid === undefined) continue;
      lastSample.set(event, st.now);
      // Only the tennis network's own outputs (the networks never read each other).
      const snnP = st.snnContract.get(ms[0].ticker), snnD = st.snnDirs.get(`tennis:TEN:${event}`);
      const dFresh = snnD && st.now - snnD.ts < 180_000 ? snnD : undefined;
      const f = tennisFairInputs(v, { p: snnP && st.now - snnP.ts < 180_000 && snnP.domain !== 'crypto' && snnP.domain !== 'perps' ? snnP.p : undefined, up: dFresh?.pUp, skill: dFresh?.conf.skill, calConf: dFresh?.conf.calConf });
      pending.set(event, [...(pending.get(event) ?? []), { event, t: st.now, f, pA: v.mid }]);
    }
  }
  return rows;
}

export function trainTennisModel(rows: TennisRow[], seed = 7): TennisFairParams {
  const names = [...TENNIS_FAIR_FEATURES];
  const residual = names.indexOf('logit_pA');
  const byMatch = [...new Set(rows.map((r) => r.event))].map((ev) => ({ ev, t: Math.min(...rows.filter((r) => r.event === ev).map((r) => r.t)) })).sort((a, b) => a.t - b.t).map((x) => x.ev);
  if (byMatch.length < 5) throw new Error(`need at least 5 matches, have ${byMatch.length}`);
  const cut = new Set(byMatch.slice(Math.floor(byMatch.length * 0.8)));
  const dev = rows.filter((r) => !cut.has(r.event)), hold = rows.filter((r) => cut.has(r.event));
  // Each match counts once: row weight = 1 / rows in its match.
  const perMatch = new Map<string, number>();
  for (const r of rows) perMatch.set(r.event, (perMatch.get(r.event) ?? 0) + 1);
  const w = (rs: TennisRow[]) => rs.map((r) => 1 / perMatch.get(r.event)!);
  const X = (rs: TennisRow[]) => rs.map((r) => names.map((n) => r.f[n]));
  const devMatches = byMatch.filter((m) => !cut.has(m));
  const vcut = new Set(devMatches.slice(Math.floor(devMatches.length * 0.8)));
  const tr = dev.filter((r) => !vcut.has(r.event)), va = dev.filter((r) => vcut.has(r.event));
  const trv = va.length ? va : tr;
  const m = train(X(tr), tr.map((r) => r.y), X(trv), trv.map((r) => r.y), { hidden: 8, l2: 1e-2, lr: 0.01, maxEpochs: 400, patience: 60, seed, residual }, w(tr), w(trv));
  // Tree candidate: boosted trees on the residual of the market's log-odds (missing inputs routed natively).
  const init = (rs: TennisRow[]) => rs.map((r) => (Number.isFinite(r.f.logit_pA) ? r.f.logit_pA : 0));
  const g = trainGbdt(X(tr), tr.map((r) => r.y), w(tr), init(tr), X(trv), trv.map((r) => r.y), w(trv), init(trv), { nTrees: 200, learningRate: 0.05, maxDepth: 2, minLeafWeight: 2, seed });
  const pMlp = (rs: TennisRow[]) => predictLogits(m.layers, m.norm, X(rs), residual).map(sigmoid);
  const pTree = (rs: TennisRow[]) => predictGbdtLogits(g.model, X(rs), residual).map(sigmoid);
  const llW = (p: number[], rs: TennisRow[]) => { const ww = w(rs); const s = ww.reduce((a, b) => a + b, 0); return p.reduce((a, q, i) => { const c = Math.min(1 - 1e-6, Math.max(1e-6, q)); return a - ww[i] * (rs[i].y ? Math.log(c) : Math.log(1 - c)); }, 0) / Math.max(1e-9, s); };
  const candidates = [{ kind: 'mlp' as const, valLogLoss: llW(pMlp(trv), trv) }, { kind: 'gbdt' as const, valLogLoss: g.trees > 0 ? llW(pTree(trv), trv) : Infinity }];
  const kind = candidates[1].valLogLoss < candidates[0].valLogLoss ? 'gbdt' : 'mlp';
  const brierW = (p: number[], rs: TennisRow[]) => { const ww = w(rs); const s = ww.reduce((a, b) => a + b, 0); return p.reduce((a, q, i) => a + ww[i] * (q - rs[i].y) ** 2, 0) / Math.max(1e-9, s); };
  const pHold = kind === 'gbdt' ? pTree(hold) : pMlp(hold);
  const brierModel = brierW(pHold, hold), brierMarket = brierW(hold.map((r) => r.pA), hold);
  return {
    version: `tennis-${kind}-${new Date().toISOString().slice(0, 10)}`, features: names, kind,
    ...(kind === 'gbdt' ? { gbdt: g.model } : { normalization: m.norm, layers: m.layers }), residual, candidates,
    validation: { matches: byMatch.length, holdoutMatches: cut.size, brierModel, brierMarket, validated: byMatch.length >= 100 && cut.size >= 20 && brierModel < brierMarket },
    trainedAt: new Date().toISOString(),
  };
}

export async function trainTennisMain(argOf: (k: string, d: string) => string = cliArg) {
  const cfg = loadConfig({ ...process.env, DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? 'x'.repeat(32), TRADING_MODE: 'paper' });
  const rows = await buildTennisDataset(argOf('recordings', 'data/recordings'), cfg.tennis, Number(argOf('every', '60')));
  const matches = new Set(rows.map((r) => r.event)).size;
  console.log(`${rows.length} tennis rows over ${matches} settled matches`);
  const params = trainTennisModel(rows);
  console.log('tennis model validation:', params.validation);
  const out = argOf('out', 'params/tennis_model.candidate.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(params));
  console.log(`wrote ${out}`);
  return params;
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void trainTennisMain();

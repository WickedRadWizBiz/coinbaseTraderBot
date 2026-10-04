// Build a labelled dataset for the meta-model from recorded market data.
//   npm run research:dataset -- --recordings data/recordings --out research/out/dataset.jsonl \
//        [--every 60] [--entry-window-only] [--calendar params/calendar.json] [--vol-profile params/vol_profile.json]
//
// One row per (market, sample time) with the exact production feature vector,
// the market mid, and the settlement label. Labels are about the CONTRACT
// OUTCOME (did YES settle), so they do not depend on our fills or fees.
// Relaxed-cadence spec: one snapshot per eligible contract every 60 s inside
// its entry window (~12 per 15-minute contract, up to 50 per hourly strike);
// the trainer weights rows by 1 / snapshots per contract (and per event).

import fs from 'fs';
import path from 'path';
import { assetFeatureMap, computeFeatureMap } from '../bot/model/featureEngine';
import { VolForecaster, VolModel } from '../bot/model/volModel';
import { effectiveSigma, loadVolProfile, type VolProfile } from '../bot/model/volSeasonality';
import { ladderQuotes } from '../bot/model/ladder';
import { priceContract, SETTLEMENT_AVG_SEC, type MarketKind } from '../bot/model/fairValue';
import { FEATURE_SCHEMA_VERSION, type MacroEvent } from '../bot/model/featureEngine';
import { loadCalendar } from '../bot/model/calendar';
import { inEntryWindow } from '../bot/strategy/cadence';
import { readRecordings, RecMarket, ReplayState } from './replay';

export interface DatasetRow {
  t: number;
  ticker: string;
  asset: string;
  window: number;
  tauSec: number;
  fv: number;
  mid: number;
  bid: number;
  ask: number;
  sigma: number;
  /** Inputs needed to re-price (volatility profile validation, Student-t nu selection). */
  spot: number;
  strike: number;
  cap?: number;
  /** Optional for datasets written before schema 3 (then: updown, event from the ticker, sigma). */
  kind?: MarketKind;
  /** Kalshi event: strikes of one event share one outcome variable. */
  event?: string;
  sigmaPricing?: number;
  observedAvg?: number;
  schema?: string;
  /** Every registered feature by name (NaN/null = unavailable). */
  fx: Record<string, number>;
  label: 0 | 1;
  labelSource: 'official' | 'computed';
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/** Event id: the recorded event ticker, else the ticker minus its strike suffix. */
export function eventOf(ticker: string, event?: string): string {
  if (event) return event;
  const i = ticker.lastIndexOf('-');
  return i > 0 ? ticker.slice(0, i) : ticker;
}

export async function buildDataset(
  dir: string, everySec: number, referenceSigma = 5e-5,
  opts: { volProfile?: VolProfile; applyVolSeasonality?: boolean; volModel?: VolModel; entryWindowOnly?: boolean; calendar?: MacroEvent[]; entryWindowUpdown?: [number, number]; entryWindowHourly?: [number, number] } = {},
): Promise<DatasetRow[]> {
  const volProfile = opts.volProfile;
  const st = new ReplayState();
  const volFc = new VolForecaster(opts.volModel);
  const pending = new Map<string, Omit<DatasetRow, 'label' | 'labelSource'>[]>();
  const rows: DatasetRow[] = [];
  let nextSample = 0;

  const flush = (m: RecMarket) => {
    const out = st.outcome(m);
    for (const r of pending.get(m.ticker) ?? []) if (out) rows.push({ ...r, label: out.label, labelSource: out.source });
    pending.delete(m.ticker);
  };

  for await (const e of readRecordings(dir)) {
    st.apply(e);
    if (st.now < nextSample) continue;
    nextSample = Math.floor(st.now / 1000 / everySec + 1) * everySec * 1000;
    for (const m of st.markets.values()) {
      if (m.recordOnly) { if (st.now >= m.closeTime + 90_000) st.markets.delete(m.ticker); continue; } // recorded for research, never priced
      if (st.now >= m.closeTime + 90_000) { flush(m); st.markets.delete(m.ticker); continue; }
      if (st.now < m.openTime || st.now >= m.closeTime) continue;
      const book = st.books.get(m.ticker);
      const idx = st.index.get(m.asset);
      const bid = book?.bestBid();
      const ask = book?.bestAsk();
      const spot = idx?.fresh(st.now, 3000);
      const vol = idx?.vol();
      const terms = st.terms(m);
      if (!book?.isUsable(st.now, 5000) || !bid || !ask || !spot || !vol || !terms) continue;
      const tauSec = (m.closeTime - st.now) / 1000;
      if (opts.entryWindowOnly && !inEntryWindow(m.kind, tauSec, opts.entryWindowUpdown ?? [840, 120], opts.entryWindowHourly ?? [3300, 300])) continue;
      const settle = tauSec <= SETTLEMENT_AVG_SEC ? idx!.settlement(m.closeTime, st.now, SETTLEMENT_AVG_SEC) : undefined;
      const observed = settle?.avg, observedCount = settle?.n;
      const sigmaFv = (opts.applyVolSeasonality ? effectiveSigma(vol.sigmaPerSqrtSec, volProfile, m.asset, st.now, m.closeTime) : vol.sigmaPerSqrtSec)
        * volFc.multiplier(m.asset, st.now, vol.sigmaPerSqrtSec, tauSec, () => assetFeatureMap(m.asset, st.now, { index: idx, spot: st.spot.get(m.asset), bars: st.features.bars.get(m.asset), candles: st.features.candles.get(m.asset), usdtd: st.usdtd, btcd: st.btcd, perp: st.features.perps.get(m.asset) }));
      const fv = priceContract(terms, { spot: spot.value, sigmaPerSqrtSec: sigmaFv, tauSec, observedAvg: observed, observedCount });
      if (!fv) continue;
      const mid = (bid.price + ask.price) / 2;
      const fx = computeFeatureMap({
        now: st.now, fairValue: fv.pYes, mid, tauSec, sigmaPerSqrtSec: vol.sigmaPerSqrtSec, referenceSigma, inWindow: fv.regime !== 'pre_window',
        book, micro: st.features.micro.get(m.ticker), index: idx!, spot: st.spot.get(m.asset), asset: m.asset, usdtd: st.usdtd, btcd: st.btcd,
        closeTs: m.closeTime, volProfile, asiaRange: st.features.asiaRange.get(m.asset),
        kind: m.kind, strike: terms.strike, cap: terms.cap, d2: fv.d2, vEff: fv.vEff, sigmaPricing: sigmaFv,
        bars: st.features.bars.get(m.asset), openTime: m.openTime, calendar: opts.calendar,
        ticker: m.ticker, siblings: m.kind === 'updown' ? undefined : ladderQuotes(st.markets.values(), (t) => st.books.get(t), m.asset, m.closeTime),
        perp: st.features.perps.get(m.asset), candles: st.features.candles.get(m.asset), snn: st.snnContext(m.asset, m.ticker),
      });
      const arr = pending.get(m.ticker) ?? [];
      arr.push({
        t: st.now, ticker: m.ticker, asset: m.asset, window: m.closeTime, tauSec, fv: fv.pYes, mid, bid: bid.price, ask: ask.price, sigma: vol.sigmaPerSqrtSec,
        spot: spot.value, strike: terms.strike ?? terms.cap!, cap: terms.kind === 'between' ? terms.cap : terms.kind === 'less' ? terms.cap : undefined,
        kind: m.kind, event: eventOf(m.ticker, m.event), sigmaPricing: sigmaFv, observedAvg: observed, schema: FEATURE_SCHEMA_VERSION, fx,
      });
      pending.set(m.ticker, arr);
    }
  }
  for (const m of st.markets.values()) if (!m.recordOnly && st.now >= m.closeTime + 60_000) flush(m);
  return rows;
}

export async function buildDatasetMain(argOf: (k: string, d: string) => string = cliArg, annotate: boolean = process.argv.includes('--annotate')) {
  const dir = argOf('recordings', 'data/recordings');
  const out = argOf('out', 'research/out/dataset.jsonl');
  const every = Number(argOf('every', '60'));
  const cal = argOf('calendar', 'params/calendar.json');
  // Match production pricing: pass --vol-profile when production applies the seasonal profile.
  const vp = argOf('vol-profile', '');
  const volProfile = vp ? loadVolProfile(vp) : undefined;
  // ...and --vol-model when production applies the tree vol forecast (used only if validated).
  const vm = argOf('vol-model', '');
  const volModel = vm ? VolModel.load(vm) : undefined;
  const rows = await buildDataset(dir, every, 5e-5, { volProfile, applyVolSeasonality: Boolean(volProfile), volModel, entryWindowOnly: process.argv.includes('--entry-window-only'), calendar: loadCalendar(cal) });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const windows = new Set(rows.map((r) => r.window)).size;
  const official = rows.filter((r) => r.labelSource === 'official').length;
  console.log(`wrote ${rows.length} rows over ${windows} windows (${official} with official labels) to ${out}`);
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void buildDatasetMain();

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

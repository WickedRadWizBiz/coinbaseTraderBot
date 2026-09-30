// Build a labelled dataset for the meta-model from recorded market data.
//   npm run research:dataset -- --recordings data/recordings --out research/out/dataset.jsonl --every 10
//
// One row per (market, sample time) with the exact production feature vector,
// the market mid, and the settlement label. Labels are about the CONTRACT
// OUTCOME (did YES settle), so they do not depend on our fills or fees.

import fs from 'fs';
import path from 'path';
import { computeFeatureMap } from '../bot/model/featureEngine';
import { effectiveSigma, loadVolProfile, type VolProfile } from '../bot/model/volSeasonality';
import { fairValue, SETTLEMENT_AVG_SEC } from '../bot/model/fairValue';
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
  /** Inputs needed to re-price (e.g. to validate a volatility profile). */
  spot: number;
  strike: number;
  observedAvg?: number;
  /** Every registered feature by name (NaN/null = unavailable). */
  fx: Record<string, number>;
  label: 0 | 1;
  labelSource: 'official' | 'computed';
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

export async function buildDataset(
  dir: string, everySec: number, referenceSigma = 5e-5,
  opts: { volProfile?: VolProfile; applyVolSeasonality?: boolean } = {},
): Promise<DatasetRow[]> {
  const volProfile = opts.volProfile;
  const st = new ReplayState();
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
      if (st.now >= m.closeTime + 90_000) { flush(m); st.markets.delete(m.ticker); continue; }
      if (st.now < m.openTime || st.now >= m.closeTime) continue;
      const book = st.books.get(m.ticker);
      const idx = st.index.get(m.asset);
      const bid = book?.bestBid();
      const ask = book?.bestAsk();
      const spot = idx?.fresh(st.now, 3000);
      const vol = idx?.vol();
      const strike = st.strike(m);
      if (!book?.isUsable(st.now, 5000) || !bid || !ask || !spot || !vol || !strike) continue;
      const tauSec = (m.closeTime - st.now) / 1000;
      const observed = tauSec <= SETTLEMENT_AVG_SEC ? idx!.average(m.closeTime - 60_000, st.now, 3000)?.avg : undefined;
      const sigmaFv = opts.applyVolSeasonality ? effectiveSigma(vol.sigmaPerSqrtSec, volProfile, m.asset, st.now, m.closeTime) : vol.sigmaPerSqrtSec;
      const fv = fairValue({ spot: spot.value, strike, sigmaPerSqrtSec: sigmaFv, tauSec, observedAvg: observed });
      if (!fv) continue;
      const mid = (bid.price + ask.price) / 2;
      const fx = computeFeatureMap({
        now: st.now, fairValue: fv.pYes, mid, tauSec, sigmaPerSqrtSec: vol.sigmaPerSqrtSec, referenceSigma, inWindow: fv.regime !== 'pre_window',
        book, micro: st.features.micro.get(m.ticker), index: idx!, spot: st.spot.get(m.asset), asset: m.asset, usdtd: st.usdtd, btcd: st.btcd,
        closeTs: m.closeTime, volProfile, asiaRange: st.features.asiaRange.get(m.asset),
      });
      const arr = pending.get(m.ticker) ?? [];
      arr.push({ t: st.now, ticker: m.ticker, asset: m.asset, window: m.closeTime, tauSec, fv: fv.pYes, mid, bid: bid.price, ask: ask.price, sigma: vol.sigmaPerSqrtSec, spot: spot.value, strike, observedAvg: observed, fx });
      pending.set(m.ticker, arr);
    }
  }
  for (const m of st.markets.values()) if (st.now >= m.closeTime + 60_000) flush(m);
  return rows;
}

async function main() {
  const dir = arg('recordings', 'data/recordings');
  const out = arg('out', 'research/out/dataset.jsonl');
  const every = Number(arg('every', '10'));
  // Match production pricing: pass --vol-profile when production applies the seasonal profile.
  const vp = arg('vol-profile', '');
  const volProfile = vp ? loadVolProfile(vp) : undefined;
  const rows = await buildDataset(dir, every, 5e-5, { volProfile, applyVolSeasonality: Boolean(volProfile) });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const windows = new Set(rows.map((r) => r.window)).size;
  const official = rows.filter((r) => r.labelSource === 'official').length;
  console.log(`wrote ${rows.length} rows over ${windows} windows (${official} with official labels) to ${out}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) void main();

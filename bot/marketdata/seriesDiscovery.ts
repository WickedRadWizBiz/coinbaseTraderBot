// Automatic discovery of every crypto price-prediction series the bot can
// price: 15-minute Up/Down (KX<ASSET>15M), hourly/daily greater-than ladders
// (KX<ASSET>D) and range brackets (KX<ASSET>). A series is tradable only if its
// asset has a settlement index the bot receives (INDEX_ID_MAP), because the
// pricer needs the index the contract settles on. Other crypto series (yearly
// highs, "will BTC hit X by ...", etc.) are skipped: they do not settle on a
// 60-second index average and would be mispriced.

export interface SeriesRow { ticker: string; title?: string; frequency?: string }

const PATTERN = /^KX([A-Z0-9]+?)(15M|D)?$/;
/** Frequencies we can price when the exchange reports one (absent = decide by ticker). */
const FREQUENCIES = new Set(['fifteen_min', '15min', 'hourly', 'daily']);

/** Asset symbol for a series ticker, if it names a known asset. */
export function assetFromSeries(ticker: string, assets: Iterable<string>): string | undefined {
  const m = PATTERN.exec(ticker);
  if (!m) return undefined;
  const set = new Set(assets);
  return set.has(m[1]) ? m[1] : undefined;
}

/** series ticker -> asset for every priceable crypto series in the listing. */
export function selectCryptoSeries(rows: SeriesRow[], assets: Iterable<string>): Record<string, string> {
  const known = [...assets];
  const out: Record<string, string> = {};
  for (const r of rows) {
    const asset = assetFromSeries(r.ticker, known);
    if (!asset) continue;
    const f = r.frequency?.toLowerCase();
    if (f && !FREQUENCIES.has(f)) continue;
    out[r.ticker] = asset;
  }
  return out;
}

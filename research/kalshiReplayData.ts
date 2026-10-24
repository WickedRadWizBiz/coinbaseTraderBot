// The data the random sweep replays besides the bot's own recordings: Kalshi's settled 15-minute crypto contracts
// (public API, research/history/kalshiHistory.ts) over the coins' 1-minute Binance history, built into recording files
// by the history replay (research/history/historyReplay.ts) with real contracts only (no synthetic ones: the strategy
// never trades those). Everything is incremental: a run adds what is new and resumes what a time budget cut short, so a
// cached folder grows run by run (the Kalshi download runs at half Kalshi's public rate limit).
//
//   npm run research:kalshi-replay-data -- --history data/history --out data/history-replay [--days 365]
//       [--assets BTC,ETH,SOL,XRP,DOGE] [--series KXBTC15M,...] [--budget-min 60]
//
// Prints the days with real Kalshi contracts it has, and writes nothing else.

import fs from 'fs';
import path from 'path';

export const REPLAY_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
export const series15m = (assets: string[]) => assets.map((a) => `KX${a}15M`);

function arg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

export async function kalshiReplayData(o: { history: string; out: string; days: number; assets: string[]; series: string[]; budgetMin: number; restBaseUrl?: string; log?: (m: string) => void }): Promise<string[]> {
  const log = o.log ?? ((m: string) => console.log(`[kalshi-replay-data] ${m}`));
  const { downloadBinance } = await import('./history/binanceVision');
  const { downloadKalshiHistory } = await import('./history/kalshiHistory');
  const { buildHistoryReplay, replayKalshiDays } = await import('./history/historyReplay');
  const t0 = Date.now();
  const now = Date.now();
  const fromDay = new Date(now - o.days * 86_400_000).toISOString().slice(0, 10);
  const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
  fs.mkdirSync(o.history, { recursive: true });
  // The candles the replay's feature bars start from, then the 1-minute bars its index prints are drawn from.
  await downloadBinance({ out: o.history, assets: o.assets, intervals: ['15m', '1h', '1d'], markets: ['spot'], fromMonth: fromDay.slice(0, 7), log: (m) => log(`binance: ${m}`) });
  await downloadBinance({ out: o.history, assets: o.assets, intervals: ['1m'], markets: ['spot'], source: 'binance-1m', fromMonth: fromDay.slice(0, 7), log: (m) => log(`binance 1m: ${m}`) });
  const left = Math.max(60_000, o.budgetMin * 60_000 - (Date.now() - t0));
  const k = await downloadKalshiHistory({ baseUrl: o.restBaseUrl ?? process.env.KALSHI_REST_URL ?? 'https://external-api.kalshi.com/trade-api/v2', series: o.series, days: o.days, out: path.join(o.history, 'kalshi'), budgetMs: left, log: (m) => log(`kalshi: ${m}`) });
  log(`kalshi: ${k.markets} new market(s), ${k.remaining} left for the next run${k.budgetHit ? ' (time budget reached)' : ''}`);
  const r = await buildHistoryReplay({ historyDir: o.history, outDir: o.out, assets: o.assets, fromDay, toDay: yesterday, synthetic: false, log: (m) => log(`replay: ${m}`) });
  log(`replay: ${r.written} day(s) written, ${r.skipped} already built${r.notes.length ? ` | ${r.notes.join('; ')}` : ''}`);
  const days = replayKalshiDays(o.out);
  log(`${days.length} day(s) with real Kalshi contracts${days.length ? `: ${days[0]}..${days[days.length - 1]}` : ''}`);
  return days;
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) {
  const assets = arg('assets', REPLAY_ASSETS.join(',')).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  kalshiReplayData({
    history: arg('history', 'data/history'), out: arg('out', 'data/history-replay'), days: Number(arg('days', '365')), assets,
    series: arg('series', series15m(assets).join(',')).split(',').map((x) => x.trim()).filter(Boolean), budgetMin: Number(arg('budget-min', '60')),
  }).catch((e) => { console.error((e as Error).stack ?? e); process.exitCode = 1; });
}

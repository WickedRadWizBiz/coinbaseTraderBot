// Sizing tuner: replays the bot's own settled Kalshi entries (DATA_DIR/trades.jsonl: the probability each
// order was placed on, the price, the outcome) under a grid of sizing policies and proposes the one with
// the best long-run growth. A PROPOSAL, never auto-applied (set STRATEGY_KELLY_FRACTION / RISK_DD_SCALE_AT).
//
// Each policy sizes every trade as the live bot does: fractional Kelly on (q, price), times the break-even
// scale (full size at or above break-even, down to a quarter at a net loss of lossAt), capped per order.
// The bankroll starts at the paper pool; when it can no longer trade (below the tradable minimum) that is
// a capital exhaustion: counted, and the pool refilled to its start, exactly like a paper training epoch.
// Objective: mean log growth per trade over the whole path (exhaustions included: the fall to the floor
// is in the log), so too-large sizing loses to the right size through ruin, never by not trading.
//
//   npm run research:tune-sizing -- --trades data/trades.jsonl --out data/models/sizing_proposal.json

import fs from 'fs';
import path from 'path';
import { breakEvenScale, SIZE_FLOOR } from '../bot/risk/equityGuard';

export interface TradeRecord { ts: number; ticker: string; book: 'crypto' | 'tennis'; q: number; cost: number; count: number; won: boolean }
export interface SizingPolicy { kelly: number; lossAt: number }
export interface PolicyResult extends SizingPolicy { growthPerTrade: number; exhaustions: number; finalBank: number; trades: number }

/** Kalshi taker fee per contract at price c (0.07 x c x (1 - c), rounded up to the cent on the order). */
const fee = (c: number) => 0.07 * c * (1 - c);

/** Replay one policy over the trades (time order). */
export function replaySizing(trades: TradeRecord[], p: SizingPolicy, o: { start?: number; floorUsd?: number; maxOrderFrac?: number } = {}): PolicyResult {
  const start = o.start ?? 100, floorUsd = o.floorUsd ?? 10, cap = o.maxOrderFrac ?? 0.05;
  let bank = start, ref = start, logSum = 0, n = 0, exhaustions = 0;
  for (const t of trades) {
    const c = t.cost;
    if (!(c > 0.01 && c < 0.99) || !(t.q > 0 && t.q < 1)) continue;
    const edge = t.q - c - fee(c);
    const kellyFrac = edge > 0 ? edge / (1 - c) : 0;
    const frac = Math.min(cap, p.kelly * kellyFrac) * breakEvenScale(ref, bank, p.lossAt, SIZE_FLOOR);
    const contracts = Math.floor((frac * bank) / c);
    if (contracts <= 0) continue;
    const pnl = contracts * ((t.won ? 1 : 0) - c - fee(c));
    const next = bank + pnl;
    logSum += Math.log(Math.max(1e-6, next) / bank);
    n++;
    bank = next;
    if (bank < floorUsd) { exhaustions++; bank = start; ref = start; }
  }
  return { ...p, growthPerTrade: n ? logSum / n : 0, exhaustions, finalBank: +bank.toFixed(2), trades: n };
}

export function readTrades(file: string): TradeRecord[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as TradeRecord; } catch { return undefined; } })
    .filter((t): t is TradeRecord => !!t).sort((a, b) => a.ts - b.ts);
}

export const KELLY_GRID = [0.1, 0.15, 0.25, 0.35, 0.5];
export const LOSS_AT_GRID = [0.1, 0.15, 0.25, 0.35];

export interface SizingProposal {
  at: string; trades: number; epochs: number; minTrades: number; ready: boolean;
  current: PolicyResult; best: PolicyResult; grid: PolicyResult[]; note: string;
}

export function tuneSizing(trades: TradeRecord[], current: SizingPolicy, o: { epochs?: number; minTrades?: number; start?: number; floorUsd?: number } = {}): SizingProposal {
  const minTrades = o.minTrades ?? 200;
  const grid = KELLY_GRID.flatMap((kelly) => LOSS_AT_GRID.map((lossAt) => replaySizing(trades, { kelly, lossAt }, o)));
  const cur = replaySizing(trades, current, o);
  const best = grid.reduce((a, b) => (b.growthPerTrade > a.growthPerTrade ? b : a), cur);
  const ready = trades.length >= minTrades;
  return {
    at: new Date().toISOString(), trades: trades.length, epochs: o.epochs ?? 0, minTrades, ready, current: cur, best, grid,
    note: !ready ? `collecting trades (${trades.length}/${minTrades})`
      : best === cur || best.growthPerTrade <= cur.growthPerTrade ? 'the current sizing is already the best on this history'
      : `proposal: STRATEGY_KELLY_FRACTION=${best.kelly} RISK_DD_SCALE_AT=${best.lossAt} (growth/trade ${best.growthPerTrade.toFixed(5)} vs ${cur.growthPerTrade.toFixed(5)}, exhaustions ${best.exhaustions} vs ${cur.exhaustions})`,
  };
}

function arg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

export async function tuneSizingMain(argOf: (k: string, d: string) => string = arg): Promise<SizingProposal> {
  const dataDir = argOf('data-dir', 'data');
  const trades = readTrades(argOf('trades', path.join(dataDir, 'trades.jsonl')));
  const epochsFile = path.join(dataDir, 'epochs.jsonl');
  const epochs = fs.existsSync(epochsFile) ? fs.readFileSync(epochsFile, 'utf8').split('\n').filter(Boolean).length : 0;
  const r = tuneSizing(trades, { kelly: Number(argOf('kelly', '0.25')), lossAt: Number(argOf('loss-at', '0.15')) }, { epochs, minTrades: Number(argOf('min-trades', '200')), start: Number(argOf('start', '100')), floorUsd: Number(argOf('floor', '10')) });
  const out = argOf('out', path.join(dataDir, 'models', 'sizing_proposal.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(r, null, 1));
  console.log(`[tune-sizing] ${r.note} -> ${out}`);
  return r;
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) void tuneSizingMain();

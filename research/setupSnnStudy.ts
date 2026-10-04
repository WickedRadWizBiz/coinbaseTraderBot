// Does the perps SNN help the setup trader? Measured on the bot's own trades (the SNN has no history to
// replay), and switched on only once proven.
//
//   npm run research:setup-snn -- --journal data/setups --out data/models/setup_snn_gate.json
//
// Every closed setup trade in the journal (bot/setups/journal.ts) carries the SNN's calls at entry.
// Agreement = trade side x (P(up) - 0.5) at the horizon that fits the lane (1h for the fast lane, 4h
// for the slow lane). A gate "enter only when agreement >= m" is chosen on the earlier 70% of trades
// (m from a short grid; it must keep at least half of them) and must then prove itself on the later
// 30%: the trades it would have blocked there must have lost money (mean net R below zero with the
// bootstrap 90% upper bound below zero), and it must keep at least 20 of them. Until there are
// MIN_TRADES trades with SNN readings the gate stays off and the file says how many there are.
// The live setup trader reads the file (hot reload) and applies the gate at entry.

import fs from 'fs';
import path from 'path';
import { readJournalTrades, type JournalTrade } from '../bot/setups/journal';

export const SNN_GATE_MIN_TRADES = 150;
const GRID = [-0.05, 0, 0.02, 0.05, 0.1];

export interface SnnGate {
  enabled: boolean;
  /** Minimum agreement per lane (trade side x (P(up) - 0.5)). */
  minAgree?: { fast: number; slow: number };
  decidedAt: string;
  trades: number;
  needed: number;
  reason: string;
  stats?: { chosenOn: number; testedOn: number; blockedMeanR: number; blockedHi: number; blocked: number; keptMeanR: number; kept: number; allMeanR: number };
}

const agree = (t: JournalTrade): number | undefined => {
  const p = t.lane === 'slow' ? t.snn_up4 ?? t.snn_up1 : t.snn_up1 ?? t.snn_up4;
  return p === null || p === undefined ? undefined : t.dir * (p - 0.5);
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : NaN);
function bootHi(xs: number[], iters = 2000, seed = 5): number {
  if (xs.length < 2) return NaN;
  let x = seed >>> 0; const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const ms: number[] = [];
  for (let k = 0; k < iters; k++) { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rnd() * xs.length)]; ms.push(s / xs.length); }
  ms.sort((a, b) => a - b);
  return ms[Math.floor(0.95 * iters)];
}

export function studySnnGate(trades: JournalTrade[], now = Date.now()): SnnGate {
  const withSnn = trades.filter((t) => agree(t) !== undefined).sort((a, b) => a.entryTs - b.entryTs);
  const base = { decidedAt: new Date(now).toISOString(), trades: withSnn.length, needed: SNN_GATE_MIN_TRADES };
  if (withSnn.length < SNN_GATE_MIN_TRADES) return { ...base, enabled: false, reason: `collecting: ${withSnn.length} of ${SNN_GATE_MIN_TRADES} closed setup trades with SNN readings` };
  const cut = Math.floor(withSnn.length * 0.7);
  const early = withSnn.slice(0, cut), late = withSnn.slice(cut);
  let best = { m: -Infinity, meanR: mean(early.map((t) => t.r)) };
  for (const m of GRID) {
    const kept = early.filter((t) => agree(t)! >= m);
    if (kept.length < early.length / 2) continue;
    const mr = mean(kept.map((t) => t.r));
    if (mr > best.meanR) best = { m, meanR: mr };
  }
  if (best.m === -Infinity) return { ...base, enabled: false, reason: `no SNN agreement level improved the earlier ${early.length} trades` };
  const blocked = late.filter((t) => agree(t)! < best.m).map((t) => t.r), kept = late.filter((t) => agree(t)! >= best.m).map((t) => t.r);
  const stats = { chosenOn: early.length, testedOn: late.length, blockedMeanR: mean(blocked), blockedHi: bootHi(blocked), blocked: blocked.length, keptMeanR: mean(kept), kept: kept.length, allMeanR: mean(late.map((t) => t.r)) };
  const ok = kept.length >= 20 && blocked.length >= 5 && stats.blockedMeanR < 0 && stats.blockedHi < 0;
  return {
    ...base, enabled: ok, minAgree: ok ? { fast: best.m, slow: best.m } : undefined, stats,
    reason: ok ? `on the later ${late.length} trades the ${blocked.length} the SNN disagreed with lost ${stats.blockedMeanR.toFixed(3)}R on average (90% bound ${stats.blockedHi.toFixed(3)}R): gate on at agreement >= ${best.m}`
      : `gate at agreement >= ${best.m} not proven on the later ${late.length} trades (blocked ${blocked.length}, mean ${stats.blockedMeanR.toFixed(3)}R, 90% bound ${Number.isFinite(stats.blockedHi) ? stats.blockedHi.toFixed(3) : 'n/a'}R)`,
  };
}

/** Read a gate file (undefined when missing / unreadable). */
export function loadSnnGate(file: string): SnnGate | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as SnnGate; } catch { return undefined; }
}

function cliArg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

export function setupSnnMain(argOf: (k: string, d: string) => string = cliArg): SnnGate {
  const g = studySnnGate(readJournalTrades(argOf('journal', 'data/setups')));
  const out = argOf('out', 'data/models/setup_snn_gate.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(g, null, 1));
  console.log(`[setup-snn] ${g.reason}; wrote ${out}`);
  return g;
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) setupSnnMain();

// Market-state audit of a replay's trades (the dynamic-scaling lab, Oct 31): which market states the bot's trades lost or
// earned in, by the reading at the last evaluation before each market's entry (bot/marketdata/marketState.ts). Each
// reading splits the trades into thirds by its value; the line gives each third's range, trades and net dollars, so a
// losing state shows where the entry edge or the size should move.
import type { TradeResult } from './backtest';

const DIMS: Array<{ key: string; label: string; abs?: boolean }> = [
  { key: 'volRatio', label: 'vol rising (rv15m/rv1h)' },
  { key: 'changeProb', label: 'change point P' },
  { key: 'spread', label: 'Kalshi spread' },
  { key: 'flow', label: '|taker flow|', abs: true },
  { key: 'jump', label: 'jump (1h sigmas)' },
  { key: 'corr', label: 'cross-coin corr' },
  { key: 'rv1h', label: 'rv1h' },
];

const fmt = (x: number) => (Math.abs(x) >= 0.01 || x === 0 ? x.toFixed(3) : x.toExponential(1));

export function stateAudit(trades: TradeResult[]): string[] {
  const out: string[] = [];
  const withState = trades.filter((t) => t.mstate);
  out.push(`market-state audit: ${withState.length} of ${trades.length} traded markets carry the entry reading`);
  for (const d of DIMS) {
    const rows = withState
      .map((t) => ({ v: t.mstate![d.key], pnl: t.pnl }))
      .filter((r): r is { v: number; pnl: number } => typeof r.v === 'number' && Number.isFinite(r.v))
      .map((r) => ({ v: d.abs ? Math.abs(r.v) : r.v, pnl: r.pnl }))
      .sort((a, b) => a.v - b.v);
    if (rows.length < 9) { out.push(`  ${d.label}: too few readings (${rows.length})`); continue; }
    const parts = [0, 1, 2].map((i) => rows.slice(Math.floor((i * rows.length) / 3), Math.floor(((i + 1) * rows.length) / 3)));
    out.push(`  ${d.label}: ${parts.map((p) => `[${fmt(p[0].v)}..${fmt(p[p.length - 1].v)}] n=${p.length} $${p.reduce((s, r) => s + r.pnl, 0).toFixed(2)}`).join(' | ')}`);
  }
  return out;
}

// Replay check: does the backtester trade like the paper bot did? Replays recorded days with today's settings through
// the production backtester (paper sizing, the accuracy gate and the take-profit bench as the engine runs them) and puts
// the result next to what paper actually did on the same days, from the bot's audit log: fills, contracts, fees, exits by
// kind, and settled P&L by UTC hour. No sweep result counts until the replay is close (the plan approved on Oct 24:
// the same sign and total P&L within 25%).
//
//   npm run research:replay-check -- --recordings data/recordings --audit data/audit --days 2026-10-22,2026-10-23 \
//       [--model data/models/model.json] [--bankroll 150] [--out data/sweeps/replay-check.json]
//
// Tennis is left out of both sides (the backtester trades crypto contracts only). Read-only: writes only --out.

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import zlib from 'zlib';

export interface SideSummary {
  fills: number; contracts: number; fees: number; pnl: number; markets: number;
  /** Exit contracts by kind (take-profit, model exit, ratchet stop, cross, other). */
  exits: Record<string, number>;
  /** Settled P&L by UTC hour (YYYY-MM-DDTHH). */
  byHour: Record<string, number>;
}
export interface ReplayCheck {
  days: string[]; bankroll: number; exitPolicy: string;
  replay: SideSummary & { accuracyBlocks: number; takeProfitBenchedAt: string | null };
  paper: SideSummary;
  /** Correlation of hourly P&L (hours either side traded). */
  hourCorr: number | null;
  /** |replay - paper| / |paper| on total P&L. */
  pnlGap: number | null;
  close: boolean;
  why: string[];
}

const hourOf = (ms: number) => new Date(ms).toISOString().slice(0, 13);
const isTennis = (t: string) => t.startsWith('KXATP') || t.startsWith('KXWTA');
const exitKind = (why: string) => /^take-profit/.test(why) ? 'take-profit' : /ratchet|stop/i.test(why) ? 'ratchet' : /cross|curve/i.test(why) ? 'cross' : /exit|fair|model/i.test(why) ? 'model exit' : 'other';
const empty = (): SideSummary => ({ fills: 0, contracts: 0, fees: 0, pnl: 0, markets: 0, exits: {}, byHour: {} });

/** What paper did on `days`, from the audit log's fill, order and settlement records (crypto only). */
export async function paperFromAudit(auditDir: string, days: string[]): Promise<SideSummary> {
  const want = new Set(days);
  const out = empty();
  const files = fs.existsSync(auditDir) ? fs.readdirSync(auditDir).filter((f) => /^audit-\d{4}-\d{2}-\d{2}.*\.jsonl(\.gz)?$/.test(f) && want.has(f.slice(6, 16))).sort() : [];
  const orders = new Map<string, { purpose?: string; why?: string }>();
  const fills: Array<{ coid?: string; count: number }> = [];
  const whyOf = new Map<string, string>();
  for (const f of files) {
    const raw = fs.createReadStream(path.join(auditDir, f));
    const rl = readline.createInterface({ input: f.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw, crlfDelay: Infinity });
    for await (const line of rl) {
      const head = line.slice(0, 160);
      // The decision that planned an exit names why (deploy/pnl_report.py reads it the same way).
      const decision = head.includes('"kind":"decision"') && line.includes('"purpose":"exit"');
      if (!decision && !head.includes('"kind":"fill"') && !head.includes('"kind":"settlement"') && !head.includes('"kind":"order_new"')) continue;
      let r: { kind?: string; ts?: string; data?: Record<string, any> };
      try { r = JSON.parse(line); } catch { continue; }
      const d = r.data ?? {};
      if (!r.ts || !want.has(r.ts.slice(0, 10))) continue;
      if (decision) {
        for (const p of (d.place ?? []) as Array<{ purpose?: string; side?: string; price?: number; why?: string }>) if (p.purpose === 'exit') whyOf.set(`${d.decisionId}|${p.side}|${p.price}`, String(p.why ?? ''));
        continue;
      }
      if (r.kind === 'order_new') { orders.set(d.clientOrderId, { purpose: d.purpose, why: whyOf.get(`${d.decisionId}|${d.side}|${d.price}`) }); continue; }
      if (r.kind === 'fill') {
        const fl = d.fill ?? {};
        if (isTennis(String(fl.ticker ?? ''))) continue;
        out.fills++; out.contracts += Number(fl.count) || 0; out.fees += Number(d.fee) || 0;
        fills.push({ coid: d.clientOrderId, count: Number(fl.count) || 0 });
        continue;
      }
      // settlement: realized P&L of the market (fees included).
      const t = String(d.ticker ?? '');
      if (isTennis(t)) continue;
      const pnl = Number(d.realized) || 0;
      out.pnl += pnl; out.markets++;
      const h = r.ts.slice(0, 13);
      out.byHour[h] = (out.byHour[h] ?? 0) + pnl;
    }
  }
  for (const f of fills) {
    const o = f.coid ? orders.get(f.coid) : undefined;
    if (o?.purpose !== 'exit') continue;
    const k = exitKind(o?.why ?? '');
    out.exits[k] = (out.exits[k] ?? 0) + f.count;
  }
  return out;
}

export function corr(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/** The verdict: the same sign and total P&L within `tol` of paper's. */
export function verdict(replay: SideSummary, paper: SideSummary, tol = 0.25): { close: boolean; pnlGap: number | null; hourCorr: number | null; why: string[] } {
  const why: string[] = [];
  const hours = [...new Set([...Object.keys(replay.byHour), ...Object.keys(paper.byHour)])].sort();
  const hourCorr = corr(hours.map((h) => replay.byHour[h] ?? 0), hours.map((h) => paper.byHour[h] ?? 0));
  const pnlGap = Math.abs(paper.pnl) > 1e-9 ? Math.abs(replay.pnl - paper.pnl) / Math.abs(paper.pnl) : null;
  if (Math.sign(replay.pnl) !== Math.sign(paper.pnl)) why.push(`opposite sign: replay ${replay.pnl.toFixed(2)} vs paper ${paper.pnl.toFixed(2)}`);
  if (pnlGap === null || pnlGap > tol) why.push(`total P&L gap ${pnlGap === null ? 'n/a' : `${(pnlGap * 100).toFixed(0)}%`} (limit ${(tol * 100).toFixed(0)}%)`);
  if (paper.contracts > 0 && (replay.contracts / paper.contracts < 0.5 || replay.contracts / paper.contracts > 2)) why.push(`volume off: replay ${replay.contracts.toFixed(0)} vs paper ${paper.contracts.toFixed(0)} contracts`);
  return { close: why.length === 0, pnlGap, hourCorr, why };
}

export async function replayCheck(o: { recordings: string; audit: string; days: string[]; model: string; bankroll?: number }): Promise<ReplayCheck> {
  const { loadConfig, paperEnv } = await import('../bot/config');
  const { MetaModel } = await import('../bot/model/metaModel');
  const { EXIT_POLICIES } = await import('../bot/strategy/exitPolicies');
  const { recordingFiles, linkDays } = await import('../bot/marketdata/recordingFiles');
  const { runBacktest } = await import('./backtest');
  const cfg = loadConfig(paperEnv(process.env));
  const model = fs.existsSync(o.model) ? MetaModel.load(o.model) : MetaModel.identity();
  const want = new Set(o.days);
  const files = recordingFiles(o.recordings).filter((d) => want.has(d.day));
  if (!files.length) throw new Error(`none of ${o.days.join(', ')} is in ${o.recordings}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-check-'));
  linkDays(files, dir);
  const S = cfg.strategy;
  const policy = (EXIT_POLICIES as readonly string[]).includes(S.exitPolicy) ? S.exitPolicy : 'fair_value';
  const curveBench = { ...cfg.probation, t: cfg.sinuousExit.benchT ?? cfg.probation.t, minTrades: cfg.sinuousExit.benchMinExits ?? cfg.probation.minTrades };
  const bankroll = o.bankroll ?? cfg.paperBankrollUsd;
  const r = await runBacktest(dir, model, S, cfg.risk, bankroll, {
    exitPolicy: policy as never, sessionRisk: S.sessionRisk, huntSessionGuard: S.huntSessionGuard, huntTransitionBufferMin: S.huntTransitionBufferMin,
    sizingTiers: cfg.sizingTiers, paper: { orderFrac: S.paperOrderFrac, orderUsd: S.paperOrderUsd }, accuracyGate: S.accuracyGate,
    takeProfitBench: { enforce: S.takeProfitBench, rule: curveBench },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const replay = { ...empty(), accuracyBlocks: r.paper?.accuracyBlocks ?? 0, takeProfitBenchedAt: r.paper?.takeProfitBenchedAt ? new Date(r.paper.takeProfitBenchedAt).toISOString() : null };
  replay.fills = r.fills; replay.contracts = r.contracts; replay.fees = r.fees; replay.pnl = r.pnl; replay.markets = r.trades.length;
  for (const t of r.trades) { const h = hourOf(t.closeTs); replay.byHour[h] = (replay.byHour[h] ?? 0) + t.pnl; }
  if (r.takeProfitFills) replay.exits['take-profit'] = r.paper?.takeProfitSales ?? r.takeProfitFills;
  if (r.exits.contracts) replay.exits['model exit / ratchet'] = r.exits.contracts;
  const paper = await paperFromAudit(o.audit, o.days);
  const v = verdict(replay, paper);
  return { days: o.days, bankroll, exitPolicy: policy, replay, paper, ...v };
}

function arg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }

async function main(): Promise<void> {
  const days = arg('days', '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!days.length) throw new Error('--days YYYY-MM-DD[,YYYY-MM-DD...] is required');
  const res = await replayCheck({ recordings: arg('recordings', 'data/recordings'), audit: arg('audit', 'data/audit'), days, model: arg('model', 'params/model.json'), bankroll: process.argv.includes('--bankroll') ? Number(arg('bankroll', '0')) : undefined });
  const out = arg('out', '');
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(res, null, 2)); }
  const f = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
  const row = (n: string, s: SideSummary) => console.log(`${n.padEnd(7)} fills ${String(s.fills).padStart(6)}  contracts ${s.contracts.toFixed(0).padStart(7)}  fees ${s.fees.toFixed(2).padStart(7)}  markets ${String(s.markets).padStart(5)}  P&L ${f(s.pnl).padStart(8)}  exits ${JSON.stringify(Object.fromEntries(Object.entries(s.exits).map(([k, v]) => [k, Math.round(v)])))}`);
  console.log(`replay check ${days.join(', ')} | exit policy ${res.exitPolicy} | start bankroll $${res.bankroll}`);
  row('replay', res.replay);
  row('paper', res.paper);
  console.log(`replay: accuracy gate held back ${res.replay.accuracyBlocks} entry evaluations; take-profit benched ${res.replay.takeProfitBenchedAt ?? 'never'}`);
  console.log(`hourly P&L correlation ${res.hourCorr === null ? 'n/a' : res.hourCorr.toFixed(2)} | total gap ${res.pnlGap === null ? 'n/a' : `${(res.pnlGap * 100).toFixed(0)}%`}`);
  console.log(res.close ? 'VERDICT close: sweep results can count' : `VERDICT not close: ${res.why.join('; ')}`);
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error((e as Error).message); process.exit(1); });

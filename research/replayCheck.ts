// Replay check: does the backtester trade like the paper bot did? Replays the bot's own recordings with today's
// settings through the production backtester (paper sizing, the accuracy gate and the take-profit bench as the engine
// runs them) and puts the result next to what paper actually did, from the bot's audit log: fills, contracts, fees,
// exits by kind, and settled P&L by UTC hour. No sweep result counts until the replay is close (the plan approved on
// Oct 24: the same sign and total P&L within 25%).
//
// Only a stretch run by one version of the bot compares. Every deploy restarts it and the bot changes most days: the
// first check (Oct 22-23, run Oct 24) set today's rules against days that ran without the accuracy gate, with the old
// exits and the flat $10 order, and the replay traded 304 contracts to paper's 18,317. So the stretch starts at the
// bot's last start in the audit log (--from auto) and ends at --to (when the recordings were copied); the replay
// starts --warmup-hours earlier, so its books, features and gate scorecard are warm by then, and only markets closing
// inside the stretch count on either side. The replay's bankroll is the paper account's at the start of the stretch:
// --paper-balance-now less what paper settled since (or --bankroll).
//
//   npm run research:replay-check -- --recordings data/recordings --audit data/audit --days 2026-10-23,2026-10-24 \
//       [--from auto|ISO] [--to ISO] [--min-hours 3] [--warmup-hours 8] [--model data/models/model.json] \
//       [--paper-balance-now 512.30 | --bankroll 150] [--out data/sweeps/replay-check.json]
//   ... --plan   prints only the recorded days the stretch and its warm-up need (from the audit log)
//
// Tennis is left out of both sides (the backtester trades crypto contracts only). Read-only: writes only --out.

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import zlib from 'zlib';
import type { Config } from '../bot/config';

export interface SideSummary {
  fills: number; contracts: number; fees: number; pnl: number; markets: number;
  /** Exit contracts by kind (take-profit, model exit, ratchet stop, cross, other). */
  exits: Record<string, number>;
  /** Settled P&L by UTC hour (YYYY-MM-DDTHH). */
  byHour: Record<string, number>;
}
export interface ReplayCheck {
  days: string[]; bankroll: number; exitPolicy: string;
  /** The compared stretch [from, to), its length, and the paper bot's starts in the days' audit log. */
  from: string; to: string; hours: number; startups: string[];
  /** Settings that differ from the ones the paper bot logged at the stretch's start (names only; null: no start in the
   *  days to compare with); model swaps in the stretch. */
  settingsDiffer: string[] | null; modelSwaps: string[];
  /** Exits and the gate's counts are the whole replay's, warm-up included. */
  replay: SideSummary & { accuracyBlocks: number; entryEvaluations: number; takeProfitBenchedAt: string | null };
  /** gateShare: of the markets in paper's entry diagnoses (one every 5 minutes), the share the accuracy gate kept out. */
  paper: SideSummary & { gateShare: number | null };
  /** Correlation of hourly P&L (hours either side traded). */
  hourCorr: number | null;
  /** |replay - paper| / |paper| on total P&L. */
  pnlGap: number | null;
  /** False when the stretch is shorter than --min-hours: no verdict yet. */
  checked: boolean;
  close: boolean;
  why: string[];
}

const HOUR = 3_600_000;
const hourOf = (ms: number) => new Date(ms).toISOString().slice(0, 13);
const isTennis = (t: string) => t.startsWith('KXATP') || t.startsWith('KXWTA');
const exitKind = (why: string) => /^take-profit/.test(why) ? 'take-profit' : /ratchet|stop/i.test(why) ? 'ratchet' : /cross|curve/i.test(why) ? 'cross' : /exit|fair|model/i.test(why) ? 'model exit' : 'other';
const empty = (): SideSummary => ({ fills: 0, contracts: 0, fees: 0, pnl: 0, markets: 0, exits: {}, byHour: {} });

/** What the check reads from the audit log (crypto only), each with its time. */
export interface AuditRecords {
  fills: Array<{ t: number; coid?: string; count: number; fee: number }>;
  orders: Map<string, { purpose?: string; why?: string }>;
  settlements: Array<{ t: number; pnl: number }>;
  /** The bot's starts, with the settings it logged (bot/main.ts: publicConfig). */
  startups: Array<{ t: number; config: Record<string, unknown> }>;
  diagnoses: Array<{ t: number; markets: number; gated: number }>;
  modelSwaps: number[];
}

export async function readAudit(auditDir: string, days: string[]): Promise<AuditRecords> {
  const want = new Set(days);
  const a: AuditRecords = { fills: [], orders: new Map(), settlements: [], startups: [], diagnoses: [], modelSwaps: [] };
  const files = fs.existsSync(auditDir) ? fs.readdirSync(auditDir).filter((f) => /^audit-\d{4}-\d{2}-\d{2}.*\.jsonl(\.gz)?$/.test(f) && want.has(f.slice(6, 16))).sort() : [];
  const whyOf = new Map<string, string>();
  for (const f of files) {
    const raw = fs.createReadStream(path.join(auditDir, f));
    const rl = readline.createInterface({ input: f.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw, crlfDelay: Infinity });
    for await (const line of rl) {
      const head = line.slice(0, 160);
      const decision = head.includes('"kind":"decision"');
      // The decision that planned an exit names why (deploy/pnl_report.py reads it the same way).
      const exitPlan = decision && line.includes('"purpose":"exit"');
      const diagnosis = decision && head.includes('"event":"entry_diagnosis"');
      const swap = head.includes('"kind":"config"') && head.includes('"event":"model_swapped"');
      if (!exitPlan && !diagnosis && !swap && !head.includes('"kind":"startup"') && !head.includes('"kind":"fill"') && !head.includes('"kind":"settlement"') && !head.includes('"kind":"order_new"')) continue;
      let r: { kind?: string; ts?: string; data?: Record<string, any> };
      try { r = JSON.parse(line); } catch { continue; }
      const d = r.data ?? {};
      if (!r.ts || !want.has(r.ts.slice(0, 10))) continue;
      const t = Date.parse(r.ts);
      if (r.kind === 'startup') { a.startups.push({ t, config: d.config ?? {} }); continue; }
      if (swap) { a.modelSwaps.push(t); continue; }
      if (diagnosis) {
        let gated = 0;
        for (const [why, n] of Object.entries((d.reasons ?? {}) as Record<string, number>)) if (why.startsWith('accuracy gate')) gated += Number(n) || 0;
        a.diagnoses.push({ t, markets: Number(d.markets) || 0, gated });
        continue;
      }
      if (exitPlan) {
        for (const p of (d.place ?? []) as Array<{ purpose?: string; side?: string; price?: number; why?: string }>) if (p.purpose === 'exit') whyOf.set(`${d.decisionId}|${p.side}|${p.price}`, String(p.why ?? ''));
        continue;
      }
      if (r.kind === 'order_new') { a.orders.set(d.clientOrderId, { purpose: d.purpose, why: whyOf.get(`${d.decisionId}|${d.side}|${d.price}`) }); continue; }
      if (r.kind === 'fill') {
        const fl = d.fill ?? {};
        if (isTennis(String(fl.ticker ?? ''))) continue;
        a.fills.push({ t, coid: d.clientOrderId, count: Number(fl.count) || 0, fee: Number(d.fee) || 0 });
        continue;
      }
      // settlement: realized P&L of the market (fees included).
      if (isTennis(String(d.ticker ?? ''))) continue;
      a.settlements.push({ t, pnl: Number(d.realized) || 0 });
    }
  }
  return a;
}

/** What paper did in [from, to). */
export function paperSummary(a: AuditRecords, from = -Infinity, to = Infinity): SideSummary & { gateShare: number | null } {
  const out = { ...empty(), gateShare: null as number | null };
  const inside = (t: number) => t >= from && t < to;
  for (const f of a.fills) {
    if (!inside(f.t)) continue;
    out.fills++; out.contracts += f.count; out.fees += f.fee;
    const o = f.coid ? a.orders.get(f.coid) : undefined;
    if (o?.purpose !== 'exit') continue;
    const k = exitKind(o.why ?? '');
    out.exits[k] = (out.exits[k] ?? 0) + f.count;
  }
  for (const s of a.settlements) {
    if (!inside(s.t)) continue;
    out.pnl += s.pnl; out.markets++;
    const h = hourOf(s.t);
    out.byHour[h] = (out.byHour[h] ?? 0) + s.pnl;
  }
  let markets = 0, gated = 0;
  for (const d of a.diagnoses) if (inside(d.t)) { markets += d.markets; gated += d.gated; }
  out.gateShare = markets > 0 ? gated / markets : null;
  return out;
}

/** What paper did on `days`, from the audit log's fill, order and settlement records (crypto only). */
export async function paperFromAudit(auditDir: string, days: string[], from?: number, to?: number): Promise<SideSummary & { gateShare: number | null }> {
  return paperSummary(await readAudit(auditDir, days), from, to);
}

/** Where the compared stretch starts: the bot's last start before `to` (each deploy restarts it, so from there on one
 *  version ran), or the first day's midnight when it did not restart in the days. */
export function stretchStart(startups: number[], days: string[], to: number): number {
  const first = Date.parse(`${[...days].sort()[0]}T00:00:00Z`);
  const last = startups.filter((t) => t < to).sort((x, y) => x - y).pop();
  return last !== undefined && last > first ? last : first;
}

/** Settings that differ between two logged configs, by name (never the values): paths, hosts, ports and credentials
 *  differ between the server and a runner by design and are left out. */
const MACHINE = /(Path|Dir|File|Host|Port|Url|Token|Password|Secret|KeyId|Webhook)$|^(port|alerts)$/;
export function settingsDiffer(a: unknown, b: unknown, at = ''): string[] {
  const obj = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
  if (!obj(a) || !obj(b)) return JSON.stringify(a) === JSON.stringify(b) ? [] : [at || '(all)'];
  const out: string[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (MACHINE.test(k)) continue;
    out.push(...settingsDiffer(a[k], b[k], at ? `${at}.${k}` : k));
  }
  return out;
}

/** The recorded days the replay needs: from the warm-up's start to the end of the stretch. */
export function replayDays(from: number, to: number, warmupHours = 8): string[] {
  const out: string[] = [];
  for (let d = Date.parse(new Date(from - warmupHours * HOUR).toISOString().slice(0, 10)); d < to; d += 24 * HOUR) out.push(new Date(d).toISOString().slice(0, 10));
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

export interface ReplayCheckOpts {
  recordings: string; audit: string; days: string[]; model: string;
  /** Start of the stretch (ms), or undefined for the bot's last start; end of it (ms), default the end of the days. */
  from?: number; to?: number;
  minHours?: number; warmupHours?: number;
  /** The replay's bankroll; else the paper balance at the start of the stretch, from the balance now. */
  bankroll?: number; paperBalanceNow?: number;
}

export async function replayCheck(o: ReplayCheckOpts): Promise<ReplayCheck> {
  const { loadConfig, paperEnv, publicConfig } = await import('../bot/config');
  const { MetaModel } = await import('../bot/model/metaModel');
  const { EXIT_POLICIES } = await import('../bot/strategy/exitPolicies');
  const { recordingFiles, linkDays } = await import('../bot/marketdata/recordingFiles');
  const { runBacktest } = await import('./backtest');
  const cfg = loadConfig(paperEnv(process.env));
  const model = fs.existsSync(o.model) ? MetaModel.load(o.model) : MetaModel.identity();
  const days = [...o.days].sort();
  const audit = await readAudit(o.audit, days);
  const to = o.to ?? Date.parse(`${days[days.length - 1]}T00:00:00Z`) + 24 * HOUR;
  const from = o.from ?? stretchStart(audit.startups.map((s) => s.t), days, to);
  const hours = (to - from) / HOUR;
  const startedAt = audit.startups.filter((s) => s.t <= from).pop();
  const paperStart = (o.paperBalanceNow ?? NaN) - audit.settlements.filter((s) => s.t >= from).reduce((x, s) => x + s.pnl, 0);
  const bankroll = o.bankroll ?? (Number.isFinite(paperStart) && paperStart > 0 ? Math.round(paperStart * 100) / 100 : cfg.paperBankrollUsd);

  const want = new Set(days);
  const files = recordingFiles(o.recordings).filter((d) => want.has(d.day));
  if (!files.length) throw new Error(`none of ${days.join(', ')} is in ${o.recordings}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-check-'));
  linkDays(files, dir);
  const S = cfg.strategy;
  const policy = (EXIT_POLICIES as readonly string[]).includes(S.exitPolicy) ? S.exitPolicy : 'fair_value';
  const curveBench = { ...cfg.probation, t: cfg.sinuousExit.benchT ?? cfg.probation.t, minTrades: cfg.sinuousExit.benchMinExits ?? cfg.probation.minTrades };
  const r = await runBacktest(dir, model, S, cfg.risk, bankroll, {
    exitPolicy: policy as never, sessionRisk: S.sessionRisk, huntSessionGuard: S.huntSessionGuard, huntTransitionBufferMin: S.huntTransitionBufferMin,
    sizingTiers: cfg.sizingTiers, paper: { orderFrac: S.paperOrderFrac, orderUsd: S.paperOrderUsd }, accuracyGate: S.accuracyGate,
    takeProfitBench: { enforce: S.takeProfitBench, rule: curveBench }, startMs: from - (o.warmupHours ?? 8) * HOUR,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const replay = {
    ...empty(), accuracyBlocks: r.paper?.accuracyBlocks ?? 0, entryEvaluations: r.entryEvaluations,
    takeProfitBenchedAt: r.paper?.takeProfitBenchedAt ? new Date(r.paper.takeProfitBenchedAt).toISOString() : null,
  };
  const inside = (t: number) => t >= from && t < to;
  for (const [w, b] of r.windows) if (inside(w)) { replay.fills += b.fills ?? 0; replay.contracts += b.contracts; replay.fees += b.fees; }
  for (const t of r.trades) {
    if (!inside(t.closeTs)) continue;
    replay.pnl += t.pnl; replay.markets++;
    const h = hourOf(t.closeTs);
    replay.byHour[h] = (replay.byHour[h] ?? 0) + t.pnl;
  }
  if (r.takeProfitFills) replay.exits['take-profit'] = r.paper?.takeProfitSales ?? r.takeProfitFills;
  if (r.exits.contracts) replay.exits['model exit / ratchet'] = r.exits.contracts;
  const paper = paperSummary(audit, from, to);
  const minHours = o.minHours ?? 3;
  const checked = hours >= minHours;
  const v = verdict(replay, paper);
  return {
    days, bankroll, exitPolicy: policy, from: new Date(from).toISOString(), to: new Date(to).toISOString(), hours,
    startups: audit.startups.map((s) => new Date(s.t).toISOString()),
    settingsDiffer: startedAt ? settingsDiffer(JSON.parse(JSON.stringify(publicConfig(cfg as Config))), startedAt.config) : null,
    modelSwaps: audit.modelSwaps.filter(inside).map((t) => new Date(t).toISOString()),
    replay, paper, ...v, checked, close: checked && v.close,
    why: checked ? v.why : [`the stretch on one start of the paper bot is ${hours.toFixed(1)} h (from ${new Date(from).toISOString()}), the check needs ${minHours} h`],
  };
}

function arg(k: string, d: string): string { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const time = (k: string): number | undefined => {
  const v = arg(k, 'auto');
  if (v === 'auto' || v === '') return undefined;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`--${k} must be an ISO time or auto`);
  return t;
};
const opt = (k: string): number | undefined => (process.argv.includes(`--${k}`) ? Number(arg(k, 'NaN')) : undefined);

async function main(): Promise<void> {
  const days = arg('days', '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!days.length) throw new Error('--days YYYY-MM-DD[,YYYY-MM-DD...] is required');
  if (process.argv.includes('--plan')) {
    // Only the audit log is read: prints the recorded days the stretch and its warm-up need.
    const a = await readAudit(arg('audit', 'data/audit'), days);
    const to = time('to') ?? Date.parse(`${[...days].sort().pop()}T00:00:00Z`) + 24 * HOUR;
    console.log(replayDays(time('from') ?? stretchStart(a.startups.map((x) => x.t), days, to), to, opt('warmup-hours')).join(','));
    return;
  }
  const res = await replayCheck({
    recordings: arg('recordings', 'data/recordings'), audit: arg('audit', 'data/audit'), days, model: arg('model', 'params/model.json'),
    from: time('from'), to: time('to'), minHours: opt('min-hours'), warmupHours: opt('warmup-hours'), bankroll: opt('bankroll'), paperBalanceNow: opt('paper-balance-now'),
  });
  const out = arg('out', '');
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(res, null, 2)); }
  const f = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
  const hm = (iso: string) => iso.slice(0, 16).replace('T', ' ');
  const row = (n: string, s: SideSummary) => console.log(`${n.padEnd(7)} fills ${String(s.fills).padStart(6)}  contracts ${s.contracts.toFixed(0).padStart(7)}  fees ${s.fees.toFixed(2).padStart(7)}  markets ${String(s.markets).padStart(5)}  P&L ${f(s.pnl).padStart(8)}  exits ${JSON.stringify(s.exits)}`);
  console.log(`replay check ${hm(res.from)} to ${hm(res.to)} UTC (${res.hours.toFixed(1)} h on one start of the paper bot) | exit policy ${res.exitPolicy} | bankroll $${res.bankroll}`);
  console.log(`paper bot starts in ${res.days.join(', ')}: ${res.startups.length ? res.startups.map(hm).join(', ') : 'none'}`);
  row('replay', res.replay);
  row('paper', res.paper);
  console.log(`accuracy gate: replay held back ${pct(res.replay.entryEvaluations ? res.replay.accuracyBlocks / res.replay.entryEvaluations : null)} of its entry evaluations; paper's diagnoses show it keeping out ${pct(res.paper.gateShare)} of the markets | take-profit benched ${res.replay.takeProfitBenchedAt ?? 'never'}`);
  console.log(`settings that differ from the paper bot's at that start: ${res.settingsDiffer === null ? 'no start logged in these days' : res.settingsDiffer.length ? res.settingsDiffer.join(', ') : 'none'} | model swaps in the stretch: ${res.modelSwaps.length ? res.modelSwaps.map(hm).join(', ') : 'none'}`);
  console.log(`hourly P&L correlation ${res.hourCorr === null ? 'n/a' : res.hourCorr.toFixed(2)} | total gap ${pct(res.pnlGap)}`);
  console.log(!res.checked ? `VERDICT not checked yet: ${res.why.join('; ')}` : res.close ? 'VERDICT close: sweep results can count' : `VERDICT not close: ${res.why.join('; ')}`);
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error((e as Error).message); process.exit(1); });

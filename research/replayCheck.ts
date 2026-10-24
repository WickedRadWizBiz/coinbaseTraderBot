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
// inside the stretch count on either side. The replay only watches until the stretch begins, then trades from the
// paper account's bankroll at that point (--paper-balance-now less what paper settled since, or --bankroll), its
// equity guard started from the bot's own (--paper-guard: equity_guard.json, so it sizes against the same break-even)
// and the dashboard's kill-switch override as the bot has it (--kill-override, on unless turned off).
//
// Where they part, it shows: fills by order purpose (quote, entry, exit), contracts and P&L hour by hour, the reasons
// paper's entry diagnoses gave once it stopped filling, and the price each side traded on, set side by side at the
// paper bot's own decision records (the replay's evaluation of the same market within a second): the math fair value
// (the index, its volatility and the strike), the book's mid, the price after the model and paper's overlays (the TA
// tilt, the component trials), and the side of the market each would trade.
//
//   npm run research:replay-check -- --recordings data/recordings --audit data/audit --days 2026-10-23,2026-10-24 \
//       [--from auto|ISO] [--to ISO] [--min-hours 3] [--warmup-hours 8] [--model data/models/model.json] \
//       [--paper-balance-now 512.30 | --bankroll 150] [--paper-guard equity_guard.json] [--kill-override true|false]
//       [--out data/sweeps/replay-check.json]
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
  /** Fills and contracts by order purpose (quote, entry, exit; other: an order the log does not name). */
  byPurpose: Record<string, { fills: number; contracts: number }>;
  /** Contracts filled by UTC hour. */
  contractsByHour: Record<string, number>;
}
/** The two sides' prices at the paper bot's decision records (the replay's evaluation of the market within 1 s). */
export interface PriceMatch {
  /** Paper's crypto decision records in the stretch, and those the replay evaluated within a second. */
  records: number; matched: number;
  /** Mean absolute differences, replay vs paper: the math fair value, the book's mid, the price traded on. */
  fv: number | null; mid: number | null; price: number | null;
  /** Mean absolute shift of the price from the fair value on each side (the model plus overlays). */
  shiftPaper: number | null; shiftReplay: number | null;
  /** Where paper's price was 2c or more off the mid: the share where the replay's sat on the same side of it. */
  sameSide: number | null; sides: number;
  /** The share of matched records where both held the same side of the market (or both were flat). */
  samePosition: number | null;
}
export interface ReplayCheck {
  days: string[]; bankroll: number; exitPolicy: string;
  /** Whether the replay's equity guard started from the bot's, and the override it ran with. */
  guardSeeded: boolean; killOverride: boolean;
  /** The compared stretch [from, to), its length, and the paper bot's starts in the days' audit log. */
  from: string; to: string; hours: number; startups: string[];
  /** Settings that differ from the ones the paper bot logged at the stretch's start (names only; null: no start in the
   *  days to compare with); model swaps in the stretch. */
  settingsDiffer: string[] | null; modelSwaps: string[];
  /** Exits and the gate's counts are the whole replay's, warm-up included. */
  replay: SideSummary & { accuracyBlocks: number; entryEvaluations: number; takeProfitBenchedAt: string | null; sizeScaleMin: number };
  /** gateShare: of the markets in paper's entry diagnoses (one every 5 minutes), the share the accuracy gate kept out.
   *  quiet: the diagnoses after paper's last fill in the stretch (how many, the last one, and their reasons summed). */
  paper: PaperSide;
  prices: PriceMatch;
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
// The model exit names its prices ("bid 0.55 - fee > q 0.520 + 0.02", "NO bid 0.45 - fee > q + 0.02").
const exitKind = (why: string) => /^take-profit/.test(why) ? 'take-profit' : /ratchet|stop/i.test(why) ? 'ratchet' : /cross|curve/i.test(why) ? 'cross' : /exit|fair|model|- fee > q/i.test(why) ? 'model exit' : 'other';
const empty = (): SideSummary => ({ fills: 0, contracts: 0, fees: 0, pnl: 0, markets: 0, exits: {}, byHour: {}, byPurpose: {}, contractsByHour: {} });
export type PaperSide = SideSummary & {
  gateShare: number | null; lastFillAt: string | null;
  quiet: { diagnoses: number; lastAt: string | null; reasons: Record<string, number> };
};

/** What the check reads from the audit log (crypto only), each with its time. */
export interface AuditRecords {
  fills: Array<{ t: number; coid?: string; count: number; fee: number }>;
  orders: Map<string, { purpose?: string; why?: string }>;
  settlements: Array<{ t: number; pnl: number }>;
  /** The bot's starts, with the settings it logged (bot/main.ts: publicConfig). */
  startups: Array<{ t: number; config: Record<string, unknown> }>;
  diagnoses: Array<{ t: number; markets: number; gated: number; reasons: Record<string, number> }>;
  modelSwaps: number[];
  /** The price each crypto decision record traded on, by ticker in time order (with readAudit's `prices` option). */
  prices: Map<string, Array<{ t: number; pYes: number; fv: number; mid: number; position: number }>>;
}

// A decision record's numbers sit before its feature map: read with a pattern, not parsed (the records are many).
const numAt = (line: string, key: string): number | undefined => {
  const m = new RegExp(`"${key}":(-?[0-9.eE+-]+)`).exec(line);
  const x = m ? Number(m[1]) : NaN;
  return Number.isFinite(x) ? x : undefined;
};

/** `prices`: also keep each crypto decision record's price, from `prices.from` on (undefined: since the bot's last
 *  start before `prices.to`, each such start clearing what came before). */
export async function readAudit(auditDir: string, days: string[], prices?: { from?: number; to?: number }): Promise<AuditRecords> {
  const want = new Set(days);
  const a: AuditRecords = { fills: [], orders: new Map(), settlements: [], startups: [], diagnoses: [], modelSwaps: [], prices: new Map() };
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
      if (prices && decision && !diagnosis) {
        const ts = /"ts":"([^"]+)"/.exec(head)?.[1];
        const ticker = /"ticker":"([^"]+)"/.exec(line.slice(0, 400))?.[1];
        const t = ts && want.has(ts.slice(0, 10)) ? Date.parse(ts) : NaN;
        if (ticker && !isTennis(ticker) && Number.isFinite(t) && (prices.from === undefined || t >= prices.from)) {
          // pYes and fv come before the feature map; the book and the position after it, in this order.
          const pre = line.slice(0, 2500);
          const pYes = numAt(pre, 'pYes'), fv = numAt(pre, 'fv');
          const b = /"bid":(-?[0-9.eE+-]+),"ask":(-?[0-9.eE+-]+),"position":(-?[0-9.eE+-]+)/.exec(line);
          const bid = Number(b?.[1]), ask = Number(b?.[2]), position = Number(b?.[3]);
          if (pYes !== undefined && fv !== undefined && Number.isFinite(bid) && Number.isFinite(ask)) {
            const arr = a.prices.get(ticker) ?? [];
            arr.push({ t, pYes, fv, mid: (bid + ask) / 2, position: Number.isFinite(position) ? position : 0 });
            a.prices.set(ticker, arr);
          }
        }
      }
      if (!exitPlan && !diagnosis && !swap && !head.includes('"kind":"startup"') && !head.includes('"kind":"fill"') && !head.includes('"kind":"settlement"') && !head.includes('"kind":"order_new"')) continue;
      let r: { kind?: string; ts?: string; data?: Record<string, any> };
      try { r = JSON.parse(line); } catch { continue; }
      const d = r.data ?? {};
      if (!r.ts || !want.has(r.ts.slice(0, 10))) continue;
      const t = Date.parse(r.ts);
      if (r.kind === 'startup') {
        a.startups.push({ t, config: d.config ?? {} });
        if (prices && prices.from === undefined && t < (prices.to ?? Infinity)) a.prices.clear();
        continue;
      }
      if (swap) { a.modelSwaps.push(t); continue; }
      if (diagnosis) {
        let gated = 0;
        const reasons: Record<string, number> = {};
        for (const [why, n] of Object.entries((d.reasons ?? {}) as Record<string, number>)) {
          if (why.startsWith('accuracy gate')) gated += Number(n) || 0;
          // Reasons carry numbers (a bucket, a price): summed under their wording without them.
          const k = why.replace(/[-+]?\$?\d[\d.,]*%?/g, '#').slice(0, 90);
          reasons[k] = (reasons[k] ?? 0) + (Number(n) || 0);
        }
        reasons.quoting = Number(d.quoting) || 0;
        a.diagnoses.push({ t, markets: Number(d.markets) || 0, gated, reasons });
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
        a.fills.push({ t, coid: d.clientOrderId ?? fl.clientOrderId, count: Number(fl.count) || 0, fee: Number(d.fee) || 0 });
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
export function paperSummary(a: AuditRecords, from = -Infinity, to = Infinity): PaperSide {
  const out: PaperSide = { ...empty(), gateShare: null, lastFillAt: null, quiet: { diagnoses: 0, lastAt: null, reasons: {} } };
  const inside = (t: number) => t >= from && t < to;
  let lastFill = -Infinity;
  for (const f of a.fills) {
    if (!inside(f.t)) continue;
    out.fills++; out.contracts += f.count; out.fees += f.fee;
    out.lastFillAt = new Date(f.t).toISOString();
    lastFill = Math.max(lastFill, f.t);
    const h = hourOf(f.t);
    out.contractsByHour[h] = (out.contractsByHour[h] ?? 0) + f.count;
    const o = f.coid ? a.orders.get(f.coid) : undefined;
    const bp = (out.byPurpose[o?.purpose ?? 'other'] ??= { fills: 0, contracts: 0 });
    bp.fills++; bp.contracts += f.count;
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
  for (const d of a.diagnoses) {
    if (!inside(d.t)) continue;
    markets += d.markets; gated += d.gated;
    if (d.t <= lastFill) continue;
    out.quiet.diagnoses++;
    out.quiet.lastAt = new Date(d.t).toISOString();
    for (const [k, n] of Object.entries(d.reasons)) out.quiet.reasons[k] = (out.quiet.reasons[k] ?? 0) + n;
  }
  out.gateShare = markets > 0 ? gated / markets : null;
  return out;
}

/** Sets the replay's evaluations beside paper's decision records: feed it every evaluation (in time order), then read
 *  the summary. A record is matched by the first evaluation of its market within a second of it. */
export function priceMatcher(prices: AuditRecords['prices'], from: number, to: number): { onEval: (e: { ticker: string; now: number; pYes: number; fv: number; bid: number; ask: number; position: number }) => void; summary: () => PriceMatch } {
  const next = new Map<string, number>();
  let matched = 0, dFv = 0, dMid = 0, dP = 0, shiftP = 0, shiftR = 0, sides = 0, same = 0, samePos = 0;
  let records = 0;
  for (const arr of prices.values()) for (const r of arr) if (r.t >= from && r.t < to) records++;
  return {
    onEval: (e) => {
      if (e.now < from - 1000 || e.now >= to + 1000) return;
      const arr = prices.get(e.ticker);
      if (!arr) return;
      let i = next.get(e.ticker) ?? 0;
      while (i < arr.length && (arr[i].t < e.now - 1000 || arr[i].t < from)) i++;
      if (i < arr.length && arr[i].t <= e.now + 1000 && arr[i].t < to) {
        const r = arr[i++];
        const mid = (e.bid + e.ask) / 2;
        matched++;
        dFv += Math.abs(e.fv - r.fv); dMid += Math.abs(mid - r.mid); dP += Math.abs(e.pYes - r.pYes);
        shiftP += Math.abs(r.pYes - r.fv); shiftR += Math.abs(e.pYes - e.fv);
        if (Math.abs(r.pYes - r.mid) >= 0.02) { sides++; if (Math.sign(e.pYes - mid) === Math.sign(r.pYes - r.mid)) same++; }
        if (Math.sign(e.position) === Math.sign(r.position)) samePos++;
      }
      next.set(e.ticker, i);
    },
    summary: () => {
      const m = (x: number) => (matched ? +(x / matched).toFixed(4) : null);
      return { records, matched, fv: m(dFv), mid: m(dMid), price: m(dP), shiftPaper: m(shiftP), shiftReplay: m(shiftR), sameSide: sides ? +(same / sides).toFixed(3) : null, sides, samePosition: m(samePos) };
    },
  };
}

/** What paper did on `days`, from the audit log's fill, order and settlement records (crypto only). */
export async function paperFromAudit(auditDir: string, days: string[], from?: number, to?: number): Promise<ReturnType<typeof paperSummary>> {
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
const MACHINE = /(Path|Dir|File|Host|Port|Url|Token|Password|Secret|KeyId|Webhook)$|^(port|alerts|dir|host|keyId)$/;
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
  /** The paper bot's equity_guard.json (read from a copy) and its kill-switch override (default on, as bot/control.ts). */
  paperGuard?: string; killOverride?: boolean;
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
  const audit = await readAudit(o.audit, days, { from: o.from, to: o.to });
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
  // The guard writes its state as it goes: it gets a copy of the bot's.
  const guardFile = o.paperGuard && fs.existsSync(o.paperGuard) ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'replay-guard-')), 'equity_guard.json') : undefined;
  if (guardFile) fs.copyFileSync(o.paperGuard!, guardFile);
  const killOverride = o.killOverride ?? true;
  const S = cfg.strategy;
  const policy = (EXIT_POLICIES as readonly string[]).includes(S.exitPolicy) ? S.exitPolicy : 'fair_value';
  const curveBench = { ...cfg.probation, t: cfg.sinuousExit.benchT ?? cfg.probation.t, minTrades: cfg.sinuousExit.benchMinExits ?? cfg.probation.minTrades };
  const match = priceMatcher(audit.prices, from, to);
  const r = await runBacktest(dir, model, S, cfg.risk, bankroll, {
    exitPolicy: policy as never, sessionRisk: S.sessionRisk, huntSessionGuard: S.huntSessionGuard, huntTransitionBufferMin: S.huntTransitionBufferMin,
    sizingTiers: cfg.sizingTiers, paper: { orderFrac: S.paperOrderFrac, orderUsd: S.paperOrderUsd }, accuracyGate: S.accuracyGate,
    takeProfitBench: { enforce: S.takeProfitBench, rule: curveBench }, startMs: from - (o.warmupHours ?? 8) * HOUR, tradeFromMs: from,
    dailyGoalUsd: cfg.vault.dailyGoalUsd, equityGuardFile: guardFile, killOverride, onEval: match.onEval,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  if (guardFile) fs.rmSync(path.dirname(guardFile), { recursive: true, force: true });
  const replay = {
    ...empty(), accuracyBlocks: r.paper?.accuracyBlocks ?? 0, entryEvaluations: r.entryEvaluations,
    takeProfitBenchedAt: r.paper?.takeProfitBenchedAt ? new Date(r.paper.takeProfitBenchedAt).toISOString() : null, sizeScaleMin: r.sizeScaleMin ?? 1,
  };
  const inside = (t: number) => t >= from && t < to;
  for (const [w, b] of r.windows) if (inside(w)) { replay.fills += b.fills ?? 0; replay.contracts += b.contracts; replay.fees += b.fees; }
  for (const t of r.trades) {
    if (!inside(t.closeTs)) continue;
    replay.pnl += t.pnl; replay.markets++;
    const h = hourOf(t.closeTs);
    replay.byHour[h] = (replay.byHour[h] ?? 0) + t.pnl;
  }
  replay.byPurpose = r.byPurpose ?? {};
  replay.contractsByHour = r.contractsByHour ?? {};
  // Contracts, as paper's: the take-profit's sales, and the other exits (the model exit and the ratchet).
  const tpContracts = r.paper?.takeProfitContracts ?? 0;
  if (tpContracts) replay.exits['take-profit'] = +tpContracts.toFixed(2);
  if (r.exits.contracts - tpContracts > 1e-9) replay.exits['model exit / ratchet'] = +(r.exits.contracts - tpContracts).toFixed(2);
  const paper = paperSummary(audit, from, to);
  const minHours = o.minHours ?? 3;
  const checked = hours >= minHours;
  const v = verdict(replay, paper);
  return {
    days, bankroll, exitPolicy: policy, guardSeeded: Boolean(guardFile), killOverride, from: new Date(from).toISOString(), to: new Date(to).toISOString(), hours,
    startups: audit.startups.map((s) => new Date(s.t).toISOString()),
    settingsDiffer: startedAt ? settingsDiffer(JSON.parse(JSON.stringify(publicConfig(cfg as Config))), startedAt.config) : null,
    modelSwaps: audit.modelSwaps.filter(inside).map((t) => new Date(t).toISOString()),
    replay, paper, prices: match.summary(), ...v, checked, close: checked && v.close,
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
    paperGuard: arg('paper-guard', '') || undefined, killOverride: arg('kill-override', 'true') !== 'false',
  });
  const out = arg('out', '');
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(res, null, 2)); }
  const f = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
  const hm = (iso: string) => iso.slice(0, 16).replace('T', ' ');
  const row = (n: string, s: SideSummary) => console.log(`${n.padEnd(7)} fills ${String(s.fills).padStart(6)}  contracts ${s.contracts.toFixed(0).padStart(7)}  fees ${s.fees.toFixed(2).padStart(7)}  markets ${String(s.markets).padStart(5)}  P&L ${f(s.pnl).padStart(8)}  exits ${JSON.stringify(s.exits)}`);
  console.log(`replay check ${hm(res.from)} to ${hm(res.to)} UTC (${res.hours.toFixed(1)} h on one start of the paper bot) | exit policy ${res.exitPolicy} | bankroll $${res.bankroll} | equity guard ${res.guardSeeded ? "the bot's" : 'fresh'}, override ${res.killOverride ? 'on' : 'off'}`);
  console.log(`paper bot starts in ${res.days.join(', ')}: ${res.startups.length ? res.startups.map(hm).join(', ') : 'none'}`);
  row('replay', res.replay);
  row('paper', res.paper);
  const purposes = (s: SideSummary) => Object.entries(s.byPurpose).sort().map(([k, x]) => `${k} ${x.fills}/${x.contracts.toFixed(0)}`).join(', ') || 'none';
  console.log(`fills/contracts by order purpose: replay ${purposes(res.replay)} | paper ${purposes(res.paper)}`);
  console.log('hour (UTC)      replay contracts  paper contracts   replay P&L   paper P&L');
  for (const h of [...new Set([...Object.keys(res.replay.contractsByHour), ...Object.keys(res.paper.contractsByHour), ...Object.keys(res.replay.byHour), ...Object.keys(res.paper.byHour)])].sort()) {
    console.log(`${h.replace('T', ' ')}:00  ${(res.replay.contractsByHour[h] ?? 0).toFixed(0).padStart(16)}  ${(res.paper.contractsByHour[h] ?? 0).toFixed(0).padStart(15)}  ${f(res.replay.byHour[h] ?? 0).padStart(11)}  ${f(res.paper.byHour[h] ?? 0).padStart(10)}`);
  }
  console.log(`paper's last fill in the stretch: ${res.paper.lastFillAt ? hm(res.paper.lastFillAt) : 'none'}`);
  if (res.paper.quiet.diagnoses) {
    const top = Object.entries(res.paper.quiet.reasons).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, n]) => `${k} x${n}`).join('; ');
    console.log(`after it, ${res.paper.quiet.diagnoses} entry diagnoses (the last ${hm(res.paper.quiet.lastAt!)}), markets by reason summed over them: ${top}`);
  }
  const P = res.prices;
  const c = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}c`);
  console.log(`prices at paper's decision records: ${P.matched} of ${P.records} matched within 1 s | mean gap replay vs paper: fair value ${c(P.fv)}, mid ${c(P.mid)}, price traded on ${c(P.price)} | shift from fair value: paper ${c(P.shiftPaper)}, replay ${c(P.shiftReplay)} | same side of the mid ${pct(P.sameSide)} of ${P.sides} | same position ${pct(P.samePosition)}`);
  console.log(`accuracy gate: replay held back ${pct(res.replay.entryEvaluations ? res.replay.accuracyBlocks / res.replay.entryEvaluations : null)} of its entry evaluations; paper's diagnoses show it keeping out ${pct(res.paper.gateShare)} of the markets | take-profit benched ${res.replay.takeProfitBenchedAt ?? 'never'} | replay's loss-aware size went down to x${res.replay.sizeScaleMin.toFixed(2)}`);
  console.log(`settings that differ from the paper bot's at that start: ${res.settingsDiffer === null ? 'no start logged in these days' : res.settingsDiffer.length ? res.settingsDiffer.join(', ') : 'none'} | model swaps in the stretch: ${res.modelSwaps.length ? res.modelSwaps.map(hm).join(', ') : 'none'}`);
  console.log(`hourly P&L correlation ${res.hourCorr === null ? 'n/a' : res.hourCorr.toFixed(2)} | total gap ${pct(res.pnlGap)}`);
  console.log(!res.checked ? `VERDICT not checked yet: ${res.why.join('; ')}` : res.close ? 'VERDICT close: sweep results can count' : `VERDICT not close: ${res.why.join('; ')}`);
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error((e as Error).message); process.exit(1); });

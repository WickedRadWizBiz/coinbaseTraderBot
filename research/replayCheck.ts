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
// paper account's bankroll at that point (--paper-balance-now, its cash plus the cost of the contracts it holds, less
// what paper settled since and the refills when its pool ran dry; or --bankroll), its
// equity guard started from the bot's own (--paper-guard: equity_guard.json, so it sizes against the same break-even)
// and the dashboard's kill-switch override as the bot has it (--kill-override, on unless turned off), and a pool that
// runs dry refilled as the bot's training supervisor does it.
//
// Where they part, it shows: fills by order purpose (quote, entry, exit), contracts and P&L hour by hour, the reasons
// paper's entry diagnoses gave once it stopped filling, and the price each side traded on, set side by side at the
// paper bot's own decision records (the replay's evaluation of the same market within a second): the math fair value
// (the index, its volatility and the strike), the book's mid, the price after the model and paper's overlays (the TA
// tilt, the component trials), and the side of the market each would trade. The replay's maker buffer adapts as the
// engine's does, from the paper bot's own recent maker markouts (--maker-markouts, from its TCA log) on.
//
//   npm run research:replay-check -- --recordings data/recordings --audit data/audit --days 2026-10-23,2026-10-24 \
//       [--from auto|ISO] [--to ISO] [--min-hours 3] [--warmup-hours 8] [--model data/models/model.json] \
//       [--paper-balance-now 512.30 | --bankroll 150] [--paper-guard equity_guard.json] [--kill-override true|false] \
//       [--maker-markouts markouts.json] [--paper-probation probation.json] [--paper-trials component_trials.json]
//       [--bankroll-scale 1] [--tick-phase-ms 0] [--out data/sweeps/replay-check.json]
//   ... --plan   prints only the recorded days the stretch and its warm-up need (from the audit log)
//   npm run research:replay-check -- --combine main.json --nearby a.json,b.json [--out replay-check.json]
//         the verdict over nearby replays: one replay's P&L is path-sensitive (the same code at a $64 or a $74 bankroll
//         made -$11.63 or -$32.76 over one stretch), so the same stretch is replayed at bankrolls a few percent apart,
//         each evaluating at another point of the second as paper's 1 s timer could (--bankroll-scale, --tick-phase-ms,
//         run side by side), and their median is held to paper's
//
// Tennis is left out of both sides (the backtester trades crypto contracts only). Read-only: writes only --out.

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import zlib from 'zlib';
import type { Config } from '../bot/config';
import type { EvalReading } from './backtest';

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
  /** Settled markets and P&L by series (the ticker before its first dash: KXBTC15M, KXETHD, ...). */
  bySeries: Record<string, { markets: number; pnl: number }>;
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
  /** At the matched records: the share where each side held a position, and the mean contracts it held then. */
  held: { paper: number | null; replay: number | null; paperSize: number | null; replaySize: number | null };
  /** What the fair value is made of, replay vs paper: the index (mean |gap| in basis points), the strike (the share of
   *  records where it differs) and the volatility (mean ratio replay / paper: the EWMA, and the one priced with). */
  spotBp: number | null; strikeDiffers: number | null; sigmaRatio: number | null; sigmaPricingRatio: number | null;
  /** The volatility priced with over the EWMA, paper and replay (mean ratio), and the replay's TA network multiplier. */
  pricedPaper: number | null; pricedReplay: number | null; taVolMult: number | null;
  /** The price beyond the trained model's (mean |price - model's price|: the TA tilt, the rule book's, the SNN's), paper
   *  and replay, and the replay's own tilts (mean |shift|). */
  overlayPaper: number | null; overlayReplay: number | null; taShift: number | null; ruleShift: number | null;
  /** The same over the stretch's first hour (after a start of the bot: its first windows). */
  firstHour?: PriceMatch;
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
  /** Each side's refills of a pool that ran dry, in the stretch (bot/training/supervisor.ts). */
  refills?: { paper: Array<{ t: string; usd: number }>; replay: Array<{ t: string; usd: number }> };
  /** Exits and the gate's counts are the whole replay's, warm-up included. */
  replay: SideSummary & { accuracyBlocks: number; entryEvaluations: number; takeProfitBenchedAt: string | null; takeProfitScored: number; takeProfitNetUsd: number; takeProfitByMarket: Record<string, TakeProfitMarket>; rejected: Record<string, number>; sizeScaleMin: number; makerBufferEnd: number | null; extra: { train: number; explore: number; sent: number; rejected: Record<string, number> } };
  /** The paper bot's maker buffer now, from the maker markouts it was seeded with (null: fewer than 30, the setting). */
  makerBufferPaper: number | null;
  /** The engine's other models the replay priced with (engineModels), the validation gates' mode and benched books. */
  models: string[]; gates: string; benched: string[];
  /** What the replay started from that paper had at the stretch's start (the take-profit bench, the accuracy gate). */
  seeded: string[];
  /** The replay's take-profit sold or sat out as paper's bench did (benchTimeline): benched at the start or not, and
   *  paper's benches and resets in the stretch; null: the replay's own bench decided (--own-bench). */
  benchFollowed: { benched: string | null; events: Array<{ t: string; benched: string | null }> } | null;
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
  /** The replay's bankroll over paper's at the stretch's start, and where in each second it evaluated (nearby replays). */
  bankrollScale?: number; tickPhaseMs?: number;
  /** With --combine: every replay of the stretch (this one and the nearby ones), their median, range and whether paper's
   *  P&L falls inside it; pnlGap, close and why are then the median's. */
  nearby?: {
    runs: Array<{ bankrollScale: number; tickPhaseMs?: number; bankroll: number; pnl: number; contracts: number; fills: number }>; median: number; contractsMedian: number; min: number; max: number; paperInside: boolean;
    /** The replays' standard deviation (null under 3 replays): how far luck alone moves this stretch's P&L. */
    sd: number | null;
    /** Every stretch checked with this backtester so far, this one included: paper's P&L and the replays' medians summed,
     *  their combined standard deviation, and how many of those apart paper is (z). */
    tally?: { stretches: number; hours: number; paper: number; median: number; sd: number; z: number | null };
    /** The P&L test the verdict used: 'luck' (paper within 2 standard deviations of the replays over the tally, with
     *  contracts and prices matching) or 'pct' (the replays' median within 25% of paper's, one stretch). */
    test: 'luck' | 'pct';
  };
}

/** One checked stretch, kept for the tally across stretches (research/replayCheck.ts --history). `code` names the
 *  backtester the replays ran (a change starts a new tally: old replays say nothing about new code). */
export interface StretchTally { from: string; to: string; hours: number; paper: number; median: number; sd: number; runs: number; code: string }
/** Whether two stretches share any time (ISO times compare as text): a later check of the same hours replaces the earlier. */
const overlaps = (a: { from: string; to: string }, b: { from: string; to: string }) => a.from < b.to && b.from < a.to;

const HOUR = 3_600_000;
const hourOf = (ms: number) => new Date(ms).toISOString().slice(0, 13);
const isTennis = (t: string) => t.startsWith('KXATP') || t.startsWith('KXWTA');
// The model exit names its prices ("bid 0.55 - fee > q 0.520 + 0.02", "NO bid 0.45 - fee > q + 0.02").
const exitKind = (why: string) => /^take-profit/.test(why) ? 'take-profit' : /ratchet|stop/i.test(why) ? 'ratchet' : /cross|curve/i.test(why) ? 'cross' : /exit|fair|model|- fee > q/i.test(why) ? 'model exit' : 'other';
/** A rejection reason with its numbers folded, so the same kind counts together (as research/backtest.ts folds them). */
export const foldReason = (r: string) => r.replace(/[-+]?\$?\d[\d.,]*%?/g, '#');
const empty = (): SideSummary => ({ fills: 0, contracts: 0, fees: 0, pnl: 0, markets: 0, exits: {}, byHour: {}, byPurpose: {}, contractsByHour: {}, bySeries: {} });
/** One market the take-profit bench scored: what its sales made against holding to settlement, the contracts sold, when. */
export interface TakeProfitMarket { usd: number; contracts: number; t: number }
const addSeries = (s: SideSummary, ticker: string, pnl: number) => { const x = (s.bySeries[ticker.split('-')[0]] ??= { markets: 0, pnl: 0 }); x.markets++; x.pnl += pnl; };
export type PaperSide = SideSummary & {
  gateShare: number | null; lastFillAt: string | null;
  /** Fills of paper's own extra entries: training trades and exploration entries. */
  extra: { train: number; explore: number };
  quiet: { diagnoses: number; lastAt: string | null; reasons: Record<string, number> };
  /** Hours in the stretch with entry diagnoses but no fill: their reasons, summed. */
  quietHours: Record<string, Record<string, number>>;
  /** The take-profit bench in the stretch (its audit events): markets scored, what the sales made against holding to
   *  settlement in total, and when it benched. */
  takeProfitBench: { scored: number; netUsd: number; benchedAt: string | null; byMarket: Record<string, TakeProfitMarket> };
  /** The risk gateway's rejections in the stretch ("purpose: reason", as logged). */
  rejected: Record<string, number>;
};

/** What the check reads from the audit log (crypto only), each with its time. */
export interface AuditRecords {
  fills: Array<{ t: number; coid?: string; count: number; fee: number }>;
  orders: Map<string, { purpose?: string; why?: string }>;
  settlements: Array<{ t: number; pnl: number; ticker?: string }>;
  /** The bot's starts, with the settings it logged (bot/main.ts: publicConfig). */
  startups: Array<{ t: number; config: Record<string, unknown> }>;
  diagnoses: Array<{ t: number; markets: number; gated: number; reasons: Record<string, number> }>;
  modelSwaps: number[];
  /** The take-profit bench's events (bot/strategy/takeProfitBench.ts): a market scored, the bench tripped or reset. */
  benchEvents: Array<{ t: number; event: string; usd?: number; ticker?: string; contracts?: number; reason?: string }>;
  /** The risk gateway's rejections as the engine logs them (one a market, side, purpose and reason a minute), crypto
   *  only: "purpose: reason" with the numbers folded. */
  rejects: Array<{ t: number; key: string }>;
  /** Refills of the Kalshi paper pool after it ran dry (bot/training/supervisor.ts: a new training epoch), cash added. */
  refills: Array<{ t: number; usd: number }>;
  /** The price each crypto decision record traded on, by ticker in time order (with readAudit's `prices` option). */
  prices: Map<string, PriceRecord[]>;
}
/** A crypto decision record's price, its fair value and what went into it, the book's mid and the position then. */
export interface PriceRecord { t: number; pYes: number; fv: number; mid: number; position: number; spot?: number; strike?: number; sigma?: number; sigmaPricing?: number; pModel?: number }

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
  const a: AuditRecords = { fills: [], orders: new Map(), settlements: [], startups: [], diagnoses: [], modelSwaps: [], benchEvents: [], rejects: [], refills: [], prices: new Map() };
  const files = fs.existsSync(auditDir) ? fs.readdirSync(auditDir).filter((f) => /^audit-\d{4}-\d{2}-\d{2}.*\.jsonl(\.gz)?$/.test(f) && want.has(f.slice(6, 16))).sort() : [];
  const whyOf = new Map<string, string>();
  for (const f of files) {
    const raw = fs.createReadStream(path.join(auditDir, f));
    const rl = readline.createInterface({ input: f.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw, crlfDelay: Infinity });
    for await (const line of rl) {
      const head = line.slice(0, 160);
      const decision = head.includes('"kind":"decision"');
      // The decision that planned an exit names why (deploy/pnl_report.py reads it the same way); so does paper's training
      // trade or exploration entry.
      const exitPlan = decision && (line.includes('"purpose":"exit"') || line.includes('"why":"train (paper)') || line.includes('"why":"explore'));
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
          // The model's shift (log-odds over the fair value) sits just before the book.
          const b = /(?:"modelShift":(-?[0-9.eE+-]+),)?"bid":(-?[0-9.eE+-]+),"ask":(-?[0-9.eE+-]+),"position":(-?[0-9.eE+-]+)/.exec(line);
          const shift = b?.[1] === undefined ? NaN : Number(b[1]), bid = Number(b?.[2]), ask = Number(b?.[3]), position = Number(b?.[4]);
          if (pYes !== undefined && fv !== undefined && Number.isFinite(bid) && Number.isFinite(ask)) {
            const arr = a.prices.get(ticker) ?? [];
            const pModel = Number.isFinite(shift) && fv > 0 && fv < 1 ? 1 / (1 + Math.exp(-(Math.log(fv / (1 - fv)) + shift))) : undefined;
            arr.push({ t, pYes, fv, mid: (bid + ask) / 2, position: Number.isFinite(position) ? position : 0, spot: numAt(pre, 'spot'), strike: numAt(pre, 'strike'), sigma: numAt(pre, 'sigma'), sigmaPricing: numAt(pre, 'sigmaPricing'), pModel });
            a.prices.set(ticker, arr);
          }
        }
      }
      const bench = head.includes('"kind":"take_profit_bench"');
      const reject = head.includes('"kind":"risk_reject"');
      const training = head.includes('"kind":"training"');
      if (!exitPlan && !diagnosis && !swap && !bench && !reject && !training && !head.includes('"kind":"startup"') && !head.includes('"kind":"fill"') && !head.includes('"kind":"settlement"') && !head.includes('"kind":"order_new"')) continue;
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
      if (training) { if (d.event === 'capital_exhaustion' && d.book === 'kalshi' && typeof d.refill === 'number') a.refills.push({ t, usd: d.refill }); continue; }
      if (reject) {
        const ticker = String(d.intent?.ticker ?? d.ticker ?? '');
        if (ticker && !isTennis(ticker)) a.rejects.push({ t, key: `${String(d.intent?.purpose ?? 'order')}: ${foldReason(String(d.reasons?.[0] ?? 'rejected'))}` });
        continue;
      }
      if (bench) { a.benchEvents.push({ t, event: String(d.event ?? ''), ...(typeof d.usd === 'number' ? { usd: d.usd } : {}), ...(typeof d.ticker === 'string' ? { ticker: d.ticker } : {}), ...(typeof d.contracts === 'number' ? { contracts: d.contracts } : {}), ...(typeof d.reason === 'string' ? { reason: d.reason } : {}) }); continue; }
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
        for (const p of (d.place ?? []) as Array<{ purpose?: string; side?: string; price?: number; why?: string }>) {
          if (p.purpose === 'exit' || /^(train|explore)/.test(String(p.why ?? ''))) whyOf.set(`${d.decisionId}|${p.side}|${p.price}`, String(p.why ?? ''));
        }
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
      a.settlements.push({ t, pnl: Number(d.realized) || 0, ticker: typeof d.ticker === 'string' ? d.ticker : undefined });
    }
  }
  return a;
}

/** What paper did in [from, to). */
export function paperSummary(a: AuditRecords, from = -Infinity, to = Infinity): PaperSide {
  const out: PaperSide = { ...empty(), gateShare: null, lastFillAt: null, extra: { train: 0, explore: 0 }, quiet: { diagnoses: 0, lastAt: null, reasons: {} }, quietHours: {}, takeProfitBench: { scored: 0, netUsd: 0, benchedAt: null, byMarket: {} }, rejected: {} };
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
    if (o?.why?.startsWith('train')) out.extra.train++;
    if (o?.why?.startsWith('explore')) out.extra.explore++;
    if (o?.purpose !== 'exit') continue;
    const k = exitKind(o.why ?? '');
    out.exits[k] = (out.exits[k] ?? 0) + f.count;
  }
  for (const s of a.settlements) {
    if (!inside(s.t)) continue;
    out.pnl += s.pnl; out.markets++;
    const h = hourOf(s.t);
    out.byHour[h] = (out.byHour[h] ?? 0) + s.pnl;
    if (s.ticker) addSeries(out, s.ticker, s.pnl);
  }
  let markets = 0, gated = 0;
  for (const d of a.diagnoses) {
    if (!inside(d.t)) continue;
    markets += d.markets; gated += d.gated;
    const h = hourOf(d.t);
    if (!out.contractsByHour[h]) {
      const q = (out.quietHours[h] ??= {});
      for (const [k, n] of Object.entries(d.reasons)) q[k] = (q[k] ?? 0) + n;
    }
    if (d.t <= lastFill) continue;
    out.quiet.diagnoses++;
    out.quiet.lastAt = new Date(d.t).toISOString();
    for (const [k, n] of Object.entries(d.reasons)) out.quiet.reasons[k] = (out.quiet.reasons[k] ?? 0) + n;
  }
  out.gateShare = markets > 0 ? gated / markets : null;
  for (const r of a.rejects) if (inside(r.t)) out.rejected[r.key] = (out.rejected[r.key] ?? 0) + 1;
  for (const e of a.benchEvents) {
    if (!inside(e.t)) continue;
    if (e.event === 'scored') {
      out.takeProfitBench.scored++; out.takeProfitBench.netUsd += e.usd ?? 0;
      if (e.ticker) out.takeProfitBench.byMarket[e.ticker] = { usd: e.usd ?? 0, contracts: e.contracts ?? 0, t: e.t };
    }
    if (e.event === 'benched' && !out.takeProfitBench.benchedAt) out.takeProfitBench.benchedAt = new Date(e.t).toISOString();
  }
  return out;
}

/** Sets the replay's evaluations beside paper's decision records: feed it every evaluation (in time order), then read
 *  the summary. A record is matched by the first evaluation of its market within a second of it. */
export function priceMatcher(prices: AuditRecords['prices'], from: number, to: number): { onEval: (e: EvalReading) => void; summary: () => PriceMatch } {
  const next = new Map<string, number>();
  // The whole stretch, and its first hour apart: after a start of the bot, paper's first window is where the two parted.
  const all = priceTally(), first = priceTally();
  let records = 0, firstRecords = 0;
  for (const arr of prices.values()) for (const r of arr) if (r.t >= from && r.t < to) { records++; if (r.t < from + HOUR) firstRecords++; }
  return {
    onEval: (e) => {
      if (e.now < from - 1000 || e.now >= to + 1000) return;
      const arr = prices.get(e.ticker);
      if (!arr) return;
      let i = next.get(e.ticker) ?? 0;
      while (i < arr.length && (arr[i].t < e.now - 1000 || arr[i].t < from)) i++;
      if (i < arr.length && arr[i].t <= e.now + 1000 && arr[i].t < to) {
        const r = arr[i++];
        all.add(e, r);
        if (r.t < from + HOUR) first.add(e, r);
      }
      next.set(e.ticker, i);
    },
    summary: () => ({ ...all.summary(records), firstHour: first.summary(firstRecords) }),
  };
}

/** One tally of the replay's prices beside paper's decision records (priceMatcher). */
function priceTally(): { add: (e: EvalReading, r: PriceRecord) => void; summary: (records: number) => PriceMatch } {
  let matched = 0, dFv = 0, dMid = 0, dP = 0, shiftP = 0, shiftR = 0, sides = 0, same = 0, samePos = 0;
  const held = { paper: 0, replay: 0, paperSize: 0, replaySize: 0 };
  const parts = { spot: [0, 0], strike: [0, 0], sigma: [0, 0], sigmaPricing: [0, 0], pricedPaper: [0, 0], pricedReplay: [0, 0], taVolMult: [0, 0], overlayPaper: [0, 0], overlayReplay: [0, 0], taShift: [0, 0], ruleShift: [0, 0] };
  const add = (k: keyof typeof parts, x: number | undefined) => { if (x !== undefined && Number.isFinite(x)) { parts[k][0] += x; parts[k][1]++; } };
  return {
    add: (e, r) => {
      const mid = (e.bid + e.ask) / 2;
      matched++;
      dFv += Math.abs(e.fv - r.fv); dMid += Math.abs(mid - r.mid); dP += Math.abs(e.pYes - r.pYes);
      shiftP += Math.abs(r.pYes - r.fv); shiftR += Math.abs(e.pYes - e.fv);
      if (Math.abs(r.pYes - r.mid) >= 0.02) { sides++; if (Math.sign(e.pYes - mid) === Math.sign(r.pYes - r.mid)) same++; }
      if (Math.sign(e.position) === Math.sign(r.position)) samePos++;
      if (r.position !== 0) { held.paper++; held.paperSize += Math.abs(r.position); }
      if (e.position !== 0) { held.replay++; held.replaySize += Math.abs(e.position); }
      if (e.spot && r.spot) { parts.spot[0] += Math.abs(e.spot - r.spot) / r.spot * 1e4; parts.spot[1]++; }
      if (e.strike !== undefined && r.strike !== undefined) { parts.strike[0] += Math.abs(e.strike - r.strike) > 1e-9 * Math.max(1, Math.abs(r.strike)) ? 1 : 0; parts.strike[1]++; }
      if (e.sigma && r.sigma) { parts.sigma[0] += e.sigma / r.sigma; parts.sigma[1]++; }
      if (e.sigmaPricing && r.sigmaPricing) { parts.sigmaPricing[0] += e.sigmaPricing / r.sigmaPricing; parts.sigmaPricing[1]++; }
      if (r.sigma && r.sigmaPricing) add('pricedPaper', r.sigmaPricing / r.sigma);
      if (e.sigma && e.sigmaPricing) add('pricedReplay', e.sigmaPricing / e.sigma);
      add('taVolMult', e.taVolMult);
      if (r.pModel !== undefined) add('overlayPaper', Math.abs(r.pYes - r.pModel));
      if (e.pModel !== undefined) add('overlayReplay', Math.abs(e.pYes - e.pModel));
      if (e.taShift !== undefined) add('taShift', Math.abs(e.taShift));
      if (e.ruleShift !== undefined) add('ruleShift', Math.abs(e.ruleShift));
    },
    summary: (records) => {
      const m = (x: number) => (matched ? +(x / matched).toFixed(4) : null);
      const avg = ([x, n]: number[], d = 3) => (n ? +(x / n).toFixed(d) : null);
      return {
        records, matched, fv: m(dFv), mid: m(dMid), price: m(dP), shiftPaper: m(shiftP), shiftReplay: m(shiftR), sameSide: sides ? +(same / sides).toFixed(3) : null, sides, samePosition: m(samePos),
        held: { paper: m(held.paper), replay: m(held.replay), paperSize: held.paper ? +(held.paperSize / held.paper).toFixed(1) : null, replaySize: held.replay ? +(held.replaySize / held.replay).toFixed(1) : null },
        spotBp: avg(parts.spot, 2), strikeDiffers: avg(parts.strike), sigmaRatio: avg(parts.sigma), sigmaPricingRatio: avg(parts.sigmaPricing),
        pricedPaper: avg(parts.pricedPaper), pricedReplay: avg(parts.pricedReplay), taVolMult: avg(parts.taVolMult),
        overlayPaper: avg(parts.overlayPaper, 4), overlayReplay: avg(parts.overlayReplay, 4), taShift: avg(parts.taShift, 4), ruleShift: avg(parts.ruleShift, 4),
      };
    },
  };
}

/** What paper did on `days`, from the audit log's fill, order and settlement records (crypto only). */
export async function paperFromAudit(auditDir: string, days: string[], from?: number, to?: number): Promise<ReturnType<typeof paperSummary>> {
  return paperSummary(await readAudit(auditDir, days), from, to);
}

/** Paper's bankroll when the stretch began: its equity at cost now, less what it settled since and less the cash put back
 *  in each time the pool ran dry since (a refill is no P&L). */
export function paperBankrollAt(equityNow: number, a: Pick<AuditRecords, 'settlements' | 'refills'>, from: number): number {
  return equityNow - a.settlements.filter((s) => s.t >= from).reduce((x, s) => x + s.pnl, 0) - a.refills.filter((x) => x.t >= from).reduce((x, f) => x + f.usd, 0);
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

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

/** The verdict over replays of one stretch at nearby bankrolls (the first is the check's own). The replays' spread is
 *  how much luck alone moves the stretch's P&L. Test 'luck' (the default): paper's P&L within 2 standard deviations of
 *  the replays' median, summed over every stretch checked with this backtester (`history`, this one replacing any
 *  earlier check of the same hours), the median's contracts within 0.5-2x of paper's, and prices that match (fair
 *  value within 1c, the same side of the mid 95% of the time). Test 'pct': the median within `tol` of paper's P&L and the
 *  same contracts rule, as verdict() holds one replay. Returns the stretch's tally entry (with 3 replays or more). */
export function nearbyVerdict(runs: Array<Pick<ReplayCheck, 'bankroll' | 'bankrollScale' | 'tickPhaseMs'> & { replay: SideSummary }>, paper: SideSummary,
  o: { tol?: number; test?: 'luck' | 'pct'; prices?: Pick<PriceMatch, 'fv' | 'sameSide'>; history?: StretchTally[]; stretch?: { from: string; to: string; hours: number; code: string } } = {},
): { nearby: NonNullable<ReplayCheck['nearby']>; close: boolean; pnlGap: number | null; why: string[]; entry?: StretchTally } {
  const tol = o.tol ?? 0.25;
  const rows = runs.map((r) => ({ bankrollScale: r.bankrollScale ?? 1, ...(r.tickPhaseMs !== undefined ? { tickPhaseMs: r.tickPhaseMs } : {}), bankroll: r.bankroll, pnl: r.replay.pnl, contracts: r.replay.contracts, fills: r.replay.fills }));
  const pnls = rows.map((r) => r.pnl), min = Math.min(...pnls), max = Math.max(...pnls), mean = pnls.reduce((a, x) => a + x, 0) / pnls.length;
  const sd = pnls.length >= 3 ? Math.sqrt(pnls.reduce((a, x) => a + (x - mean) ** 2, 0) / (pnls.length - 1)) : null;
  const med = median(pnls), contractsMedian = median(rows.map((r) => r.contracts));
  const entry = o.stretch && sd !== null ? { ...o.stretch, paper: paper.pnl, median: med, sd, runs: rows.length } : undefined;
  const all = [...(o.history ?? []).filter((h) => o.stretch && h.code === o.stretch.code && !overlaps(h, o.stretch)), ...(entry ? [entry] : [])];
  const T = all.length ? { stretches: all.length, hours: all.reduce((a, h) => a + h.hours, 0), paper: all.reduce((a, h) => a + h.paper, 0), median: all.reduce((a, h) => a + h.median, 0), sd: Math.sqrt(all.reduce((a, h) => a + h.sd ** 2, 0)) } : undefined;
  const tally = T ? { ...T, z: T.sd > 0 ? (T.paper - T.median) / T.sd : null } : undefined;
  const test = (o.test ?? 'luck') === 'luck' && tally ? 'luck' : 'pct';
  const nearby = { runs: rows, median: med, contractsMedian, min, max, paperInside: paper.pnl >= min - 1e-9 && paper.pnl <= max + 1e-9, sd, ...(tally ? { tally } : {}), test } as NonNullable<ReplayCheck['nearby']>;
  const v = verdict({ ...runs[0].replay, pnl: med, contracts: contractsMedian }, paper, tol);
  if (test === 'pct') return { nearby, close: v.close, pnlGap: v.pnlGap, why: v.why.map((w) => `median of ${rows.length} replays: ${w}`), entry };
  const why: string[] = [];
  const f = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
  if (tally!.z === null || Math.abs(tally!.z) > 2) why.push(`P&L beyond luck: paper ${f(tally!.paper)} vs the replays' ${f(tally!.median)} +/- ${tally!.sd.toFixed(2)} over ${tally!.stretches} stretch(es), ${tally!.z === null ? 'n/a' : Math.abs(tally!.z).toFixed(1)} standard deviations apart (limit 2)`);
  if (paper.contracts > 0 && (contractsMedian / paper.contracts < 0.5 || contractsMedian / paper.contracts > 2)) why.push(`volume off: the replays' median ${contractsMedian.toFixed(0)} vs paper ${paper.contracts.toFixed(0)} contracts`);
  if (o.prices && (o.prices.fv === null || o.prices.fv > 0.01)) why.push(`fair value off paper's by ${o.prices.fv === null ? 'n/a' : `${(o.prices.fv * 100).toFixed(1)}c`} (limit 1c)`);
  if (o.prices && (o.prices.sameSide === null || o.prices.sameSide < 0.95)) why.push(`same side of the mid ${o.prices.sameSide === null ? 'n/a' : `${(o.prices.sameSide * 100).toFixed(0)}%`} of the time (needs 95%)`);
  return { nearby, close: why.length === 0, pnlGap: v.pnlGap, why, entry };
}

export interface ReplayCheckOpts {
  recordings: string; audit: string; days: string[]; model: string;
  /** Start of the stretch (ms), or undefined for the bot's last start; end of it (ms), default the end of the days. */
  from?: number; to?: number;
  minHours?: number; warmupHours?: number;
  /** The replay's bankroll; else the paper account's at the start of the stretch, from its equity at cost now (cash plus
   *  the cost of the contracts held: cash alone leaves out what open positions tie up). */
  bankroll?: number; paperBalanceNow?: number;
  /** The replay's bankroll times this (nearby replays, default 1). */
  bankrollScale?: number;
  /** Where in each second the replay evaluates (BacktestOpts.tickPhaseMs; nearby replays differ in it as paper's timer could). */
  tickPhaseMs?: number;
  /** The paper bot's equity_guard.json (read from a copy) and its kill-switch override (default on, as bot/control.ts). */
  paperGuard?: string; killOverride?: boolean;
  /** The paper bot's recent maker fills' 60 s markouts (its TCA log), which seed the replay's adaptive maker buffer. */
  makerMarkouts?: number[];
  /** The paper bot's probation.json (read from a copy): which books' unvalidated models are benched. */
  paperProbation?: string;
  /** The paper bot's component_trials.json (read from a copy): which components paper's price includes. */
  paperTrials?: string;
  /** The paper bot's take-profit-bench.json and accuracy_gate.json now: the replay starts from them as they stood when
   *  the stretch began (benchAt, gateAt). */
  paperTpBench?: string; paperAccuracyGate?: string;
  /** The replay's take-profit benches on its own scoreboard instead of following paper's bench (benchTimeline). */
  ownBench?: boolean;
}

/** The take-profit bench as paper had it when the stretch began: its state file now less the markets it scored since
 *  (the audit's 'scored' events; results are appended in order) and a bench tripped since. Undefined when it was reset
 *  since: what it held before is gone. */
export function benchAt(state: { results?: number[]; since?: number; benched?: { at: number; reason: string }; sales?: Array<{ ts: number }> }, events: AuditRecords['benchEvents'], from: number): { results: number[]; since: number; benched?: { at: number; reason: string }; sales: Array<{ ts: number }> } | undefined {
  const after = events.filter((e) => e.t >= from);
  if (after.some((e) => e.event === 'reset')) return undefined;
  const scored = after.filter((e) => e.event === 'scored').length;
  const results = Array.isArray(state.results) ? state.results.slice(0, Math.max(0, state.results.length - scored)) : [];
  return { results, since: state.since ?? from, ...(state.benched && state.benched.at < from ? { benched: state.benched } : {}), sales: (state.sales ?? []).filter((x) => x.ts < from) };
}

/** Paper's take-profit bench through the stretch, for the replay to follow: benched at its start or not (`startBenched`,
 *  from its state file wound back; undefined: the last bench or reset logged before the stretch), then each bench and
 *  reset in it. One early run of bad luck benches a bench on its own scoreboard for the rest of the day, and the
 *  replay's luck in its first minutes is its own: followed, both sell or sit out together and the rest compares. */
export function benchTimeline(events: AuditRecords['benchEvents'], from: number, to: number, startBenched?: string | null): { benched: string | null; events: Array<{ t: number; benched: string | null }> } {
  const turn = (e: AuditRecords['benchEvents'][number]) => e.event === 'benched' || e.event === 'reset';
  const before = events.filter((e) => e.t < from && turn(e)).pop();
  const benched = startBenched !== undefined ? startBenched : before?.event === 'benched' ? before.reason ?? 'benched' : null;
  return { benched, events: events.filter((e) => e.t >= from && e.t < to && turn(e)).map((e) => ({ t: e.t, benched: e.event === 'benched' ? e.reason ?? 'benched' : null })) };
}

/** The accuracy gate's scorecard as it stood when the stretch began: the snapshots scored before it. */
export function gateAt(state: { rows?: Record<string, Array<{ ts: number }>> }, from: number): { rows: Record<string, Array<{ ts: number }>> } {
  return { rows: Object.fromEntries(Object.entries(state.rows ?? {}).map(([k, rows]) => [k, rows.filter((r) => r.ts < from)])) };
}

export async function replayCheck(o: ReplayCheckOpts): Promise<ReplayCheck> {
  const { loadConfig, paperEnv, publicConfig } = await import('../bot/config');
  const { MetaModel } = await import('../bot/model/metaModel');
  const { EXIT_POLICIES } = await import('../bot/strategy/exitPolicies');
  const { recordingFiles, linkDays } = await import('../bot/marketdata/recordingFiles');
  const { engineModels, installProbation, runBacktest } = await import('./backtest');
  const cfg = loadConfig(paperEnv(process.env));
  const models = await engineModels(cfg as Config, { trialsFile: o.paperTrials });
  const benched = installProbation(cfg as Config, o.paperProbation);
  const model = fs.existsSync(o.model) ? MetaModel.load(o.model) : MetaModel.identity();
  const days = [...o.days].sort();
  const audit = await readAudit(o.audit, days, { from: o.from, to: o.to });
  const to = o.to ?? Date.parse(`${days[days.length - 1]}T00:00:00Z`) + 24 * HOUR;
  const from = o.from ?? stretchStart(audit.startups.map((s) => s.t), days, to);
  const hours = (to - from) / HOUR;
  const startedAt = audit.startups.filter((s) => s.t <= from).pop();
  const paperStart = paperBankrollAt(o.paperBalanceNow ?? NaN, audit, from);
  const bankroll = Math.round((o.bankroll ?? (Number.isFinite(paperStart) && paperStart > 0 ? paperStart : cfg.paperBankrollUsd)) * (o.bankrollScale ?? 1) * 100) / 100;

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
  // The take-profit bench and the accuracy gate start from paper's own scoreboards as they stood when the stretch began
  // (private copies: both write as they go), not from empty ones.
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-seed-'));
  const readState = (f?: string) => { try { return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined; } catch { return undefined; } };
  const seeded: string[] = [];
  let benchFile: string | undefined, gateFile: string | undefined, startBenched: string | null | undefined;
  const benchNow = readState(o.paperTpBench);
  if (benchNow) {
    const b = benchAt(benchNow, audit.benchEvents, from);
    if (b) {
      startBenched = b.benched?.reason ?? null;
      benchFile = path.join(seedDir, 'take-profit-bench.json');
      fs.writeFileSync(benchFile, JSON.stringify(b));
      seeded.push(`take-profit bench (${b.results.length} markets scored${b.benched ? ', benched' : ''})`);
    } else seeded.push('take-profit bench reset during the stretch: started empty');
  }
  const gateNow = readState(o.paperAccuracyGate);
  if (gateNow) {
    const g = gateAt(gateNow, from);
    gateFile = path.join(seedDir, 'accuracy_gate.json');
    fs.writeFileSync(gateFile, JSON.stringify(g));
    seeded.push(`accuracy gate (${Object.values(g.rows).reduce((a, r) => a + r.length, 0)} scored snapshots)`);
  }
  const follow = o.ownBench ? undefined : benchTimeline(audit.benchEvents, from, to, startBenched);
  const match = priceMatcher(audit.prices, from, to);
  const r = await runBacktest(dir, model, S, cfg.risk, bankroll, {
    exitPolicy: policy as never, sessionRisk: S.sessionRisk, huntSessionGuard: S.huntSessionGuard, huntTransitionBufferMin: S.huntTransitionBufferMin,
    sizingTiers: cfg.sizingTiers, paper: { orderFrac: S.paperOrderFrac, orderUsd: S.paperOrderUsd }, accuracyGate: S.accuracyGate,
    takeProfitBench: { enforce: S.takeProfitBench, rule: curveBench, stateFile: benchFile, ...(follow ? { follow } : {}) }, accuracyGateFile: gateFile, startMs: from - (o.warmupHours ?? 8) * HOUR, tradeFromMs: from,
    dailyGoalUsd: cfg.vault.dailyGoalUsd, equityGuardFile: guardFile, killOverride, refillUsd: cfg.paperBankrollUsd, onEval: match.onEval, makerMarkouts: o.makerMarkouts,
    volProfile: models.volProfile, applyVolSeasonality: Boolean(models.volProfile), volModel: models.volModel, fillModel: models.fillModel, calendar: models.calendar,
    taNet: true, trials: models.trials, marketContext: true, ...(o.tickPhaseMs !== undefined ? { tickPhaseMs: o.tickPhaseMs } : {}),
  });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(seedDir, { recursive: true, force: true });
  if (guardFile) fs.rmSync(path.dirname(guardFile), { recursive: true, force: true });
  const replay = {
    ...empty(), accuracyBlocks: r.paper?.accuracyBlocks ?? 0, entryEvaluations: r.entryEvaluations,
    takeProfitBenchedAt: r.paper?.takeProfitBenchedAt ? new Date(r.paper.takeProfitBenchedAt).toISOString() : null, takeProfitScored: r.paper?.takeProfitScored ?? 0, takeProfitNetUsd: r.paper?.takeProfitNetUsd ?? 0, takeProfitByMarket: r.paper?.takeProfitByMarket ?? {}, rejected: r.paper?.rejected ?? {}, sizeScaleMin: r.sizeScaleMin ?? 1,
    makerBufferEnd: r.makerBufferEnd ?? null, extra: { train: r.paper?.trainTrades ?? 0, explore: r.paper?.exploreEntries ?? 0, sent: r.paper?.extraSent ?? 0, rejected: r.paper?.extraRejected ?? {} },
  };
  const mk = (o.makerMarkouts ?? []).slice(-2000);
  const makerBufferPaper = mk.length >= 30 ? Math.min(S.makerBufferRange[1], Math.max(S.makerBufferRange[0], -mk.reduce((a, x) => a + x, 0) / mk.length)) : null;
  const inside = (t: number) => t >= from && t < to;
  for (const [w, b] of r.windows) if (inside(w)) { replay.fills += b.fills ?? 0; replay.contracts += b.contracts; replay.fees += b.fees; }
  for (const t of r.trades) {
    if (!inside(t.closeTs)) continue;
    replay.pnl += t.pnl; replay.markets++;
    const h = hourOf(t.closeTs);
    replay.byHour[h] = (replay.byHour[h] ?? 0) + t.pnl;
    addSeries(replay, t.ticker, t.pnl);
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
    days, bankroll, bankrollScale: o.bankrollScale ?? 1, ...(o.tickPhaseMs !== undefined ? { tickPhaseMs: o.tickPhaseMs } : {}), exitPolicy: policy, guardSeeded: Boolean(guardFile), killOverride, from: new Date(from).toISOString(), to: new Date(to).toISOString(), hours,
    startups: audit.startups.map((s) => new Date(s.t).toISOString()),
    settingsDiffer: startedAt ? settingsDiffer(JSON.parse(JSON.stringify(publicConfig(cfg as Config))), startedAt.config) : null,
    modelSwaps: audit.modelSwaps.filter(inside).map((t) => new Date(t).toISOString()),
    refills: { paper: audit.refills.filter((x) => inside(x.t)).map((x) => ({ t: new Date(x.t).toISOString(), usd: x.usd })), replay: (r.refills ?? []).filter((x) => inside(x.t)).map((x) => ({ t: new Date(x.t).toISOString(), usd: x.usd })) },
    replay, paper, prices: match.summary(), makerBufferPaper, models: models.used, gates: cfg.probation.mode, benched, seeded,
    benchFollowed: follow ? { benched: follow.benched, events: follow.events.map((e) => ({ t: new Date(e.t).toISOString(), benched: e.benched })) } : null,
    ...v, checked, close: checked && v.close,
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
  const f = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
  if (process.argv.includes('--combine')) {
    // The check's own replay and the nearby ones (each a --out of this script; a missing or broken one is left out), and
    // the tally of stretches checked before (--history: read, this stretch added or replaced, written back).
    const read = <T>(p: string): T | undefined => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return undefined; } };
    const own = read<ReplayCheck>(arg('combine', ''));
    if (!own) throw new Error('--combine: the check\'s own result is missing');
    const others = arg('nearby', '').split(',').filter(Boolean).map((p) => read<ReplayCheck>(p)).filter((r): r is ReplayCheck => Boolean(r && r.replay && r.from === own.from && r.to === own.to));
    const historyFile = arg('history', '');
    const history = (historyFile && read<StretchTally[]>(historyFile)) || [];
    const code = arg('code', 'unknown');
    const nv = nearbyVerdict([own, ...others], own.paper, { test: arg('pnl-test', 'luck') === 'pct' ? 'pct' : 'luck', prices: own.prices, history: Array.isArray(history) ? history : [], stretch: own.checked ? { from: own.from, to: own.to, hours: own.hours, code } : undefined });
    const res: ReplayCheck = { ...own, nearby: nv.nearby, pnlGap: nv.pnlGap, close: own.checked && nv.close, why: own.checked ? nv.why : own.why };
    if (historyFile && nv.entry) {
      fs.mkdirSync(path.dirname(historyFile), { recursive: true });
      fs.writeFileSync(historyFile, JSON.stringify([...(Array.isArray(history) ? history : []).filter((h) => !overlaps(h, nv.entry!)), nv.entry].slice(-200), null, 1));
    }
    const out = arg('out', '');
    if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(res, null, 2)); }
    const N = nv.nearby;
    console.log(`nearby replays of the stretch: ${[...N.runs].sort((a, b) => a.bankrollScale - b.bankrollScale).map((r) => `x${r.bankrollScale}${r.tickPhaseMs !== undefined ? ` at +${r.tickPhaseMs} ms` : ''} ($${r.bankroll}) ${f(r.pnl)} / ${r.contracts.toFixed(0)} c`).join(' | ')}`);
    console.log(`median ${f(N.median)} (range ${f(N.min)} to ${f(N.max)}, standard deviation ${N.sd === null ? 'n/a' : N.sd.toFixed(2)}), ${N.contractsMedian.toFixed(0)} contracts | paper ${f(own.paper.pnl)} / ${own.paper.contracts.toFixed(0)} c, ${N.paperInside ? 'inside' : 'outside'} the range | median gap ${pct(nv.pnlGap)}`);
    if (N.tally) console.log(`stretches checked with this backtester (${code}): ${N.tally.stretches}, ${N.tally.hours.toFixed(1)} h | paper ${f(N.tally.paper)} vs the replays' ${f(N.tally.median)} +/- ${N.tally.sd.toFixed(2)}: ${N.tally.z === null ? 'n/a' : Math.abs(N.tally.z).toFixed(1)} standard deviations apart | test: ${N.test === 'luck' ? 'within 2 standard deviations' : 'median within 25%'}`);
    console.log(!res.checked ? `VERDICT not checked yet: ${res.why.join('; ')}` : res.close ? 'VERDICT close: sweep results can count' : `VERDICT not close: ${res.why.join('; ')}`);
    return;
  }
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
    from: time('from'), to: time('to'), minHours: opt('min-hours'), warmupHours: opt('warmup-hours'), bankroll: opt('bankroll'), paperBalanceNow: opt('paper-balance-now'), bankrollScale: opt('bankroll-scale'), tickPhaseMs: opt('tick-phase-ms'),
    paperGuard: arg('paper-guard', '') || undefined, killOverride: arg('kill-override', 'true') !== 'false',
    makerMarkouts: arg('maker-markouts', '') && fs.existsSync(arg('maker-markouts', '')) ? (JSON.parse(fs.readFileSync(arg('maker-markouts', ''), 'utf8')) as unknown[]).map(Number).filter(Number.isFinite) : undefined,
    paperProbation: arg('paper-probation', '') || undefined, paperTrials: arg('paper-trials', '') || undefined,
    paperTpBench: arg('paper-tp-bench', '') || undefined, paperAccuracyGate: arg('paper-accuracy-gate', '') || undefined,
    ownBench: process.argv.includes('--own-bench'),
  });
  const out = arg('out', '');
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(res, null, 2)); }
  const hm = (iso: string) => iso.slice(0, 16).replace('T', ' ');
  const row = (n: string, s: SideSummary) => console.log(`${n.padEnd(7)} fills ${String(s.fills).padStart(6)}  contracts ${s.contracts.toFixed(0).padStart(7)}  fees ${s.fees.toFixed(2).padStart(7)}  markets ${String(s.markets).padStart(5)}  P&L ${f(s.pnl).padStart(8)}  exits ${JSON.stringify(s.exits)}`);
  console.log(`replay check ${hm(res.from)} to ${hm(res.to)} UTC (${res.hours.toFixed(1)} h on one start of the paper bot) | exit policy ${res.exitPolicy} | bankroll $${res.bankroll}${res.bankrollScale !== undefined && res.bankrollScale !== 1 ? ` (x${res.bankrollScale} paper's)` : ''}${res.tickPhaseMs !== undefined ? ` | evaluating ${res.tickPhaseMs} ms into each second` : ''} | equity guard ${res.guardSeeded ? "the bot's" : 'fresh'}, override ${res.killOverride ? 'on' : 'off'}`);
  console.log(`paper bot starts in ${res.days.join(', ')}: ${res.startups.length ? res.startups.map(hm).join(', ') : 'none'}`);
  const refilled = (xs: Array<{ t: string; usd: number }> = []) => xs.map((x) => `${hm(x.t)} (+$${x.usd.toFixed(2)})`).join(', ') || 'none';
  if (res.refills?.paper.length || res.refills?.replay.length) console.log(`the pool ran dry and was refilled (a new training epoch): paper ${refilled(res.refills.paper)} | replay ${refilled(res.refills.replay)}`);
  row('replay', res.replay);
  row('paper', res.paper);
  const purposes = (s: SideSummary) => Object.entries(s.byPurpose).sort().map(([k, x]) => `${k} ${x.fills}/${x.contracts.toFixed(0)}`).join(', ') || 'none';
  console.log(`fills/contracts by order purpose: replay ${purposes(res.replay)} | paper ${purposes(res.paper)}`);
  const X = res.replay.extra, rej = Object.entries(X.rejected).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, n]) => `${k} x${n}`).join('; ');
  console.log(`paper's extra entries: training trades replay ${X.train} planned, paper ${res.paper.extra.train} filled | exploration replay ${X.explore} planned, paper ${res.paper.extra.explore} filled | replay sent ${X.sent} past the risk gateway${rej ? `, turned down: ${rej}` : ''}`);
  console.log('hour (UTC)      replay contracts  paper contracts   replay P&L   paper P&L');
  for (const h of [...new Set([...Object.keys(res.replay.contractsByHour), ...Object.keys(res.paper.contractsByHour), ...Object.keys(res.replay.byHour), ...Object.keys(res.paper.byHour)])].sort()) {
    console.log(`${h.replace('T', ' ')}:00  ${(res.replay.contractsByHour[h] ?? 0).toFixed(0).padStart(16)}  ${(res.paper.contractsByHour[h] ?? 0).toFixed(0).padStart(15)}  ${f(res.replay.byHour[h] ?? 0).padStart(11)}  ${f(res.paper.byHour[h] ?? 0).padStart(10)}`);
  }
  console.log(`paper's last fill in the stretch: ${res.paper.lastFillAt ? hm(res.paper.lastFillAt) : 'none'}`);
  const series = [...new Set([...Object.keys(res.replay.bySeries), ...Object.keys(res.paper.bySeries)])].sort((x, y) => (res.paper.bySeries[y]?.markets ?? 0) - (res.paper.bySeries[x]?.markets ?? 0));
  console.log(`settled markets / P&L by series: ${series.map((k) => `${k} replay ${res.replay.bySeries[k]?.markets ?? 0} / ${f(res.replay.bySeries[k]?.pnl ?? 0)}, paper ${res.paper.bySeries[k]?.markets ?? 0} / ${f(res.paper.bySeries[k]?.pnl ?? 0)}`).join(' | ') || 'none'}`);
  const top = (r: Record<string, number>) => Object.entries(r).filter(([k]) => k !== 'quoting').sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, n]) => `${k} x${n}`).join('; ');
  for (const [h, r] of Object.entries(res.paper.quietHours).sort()) console.log(`paper filled nothing in ${h.replace('T', ' ')}:00; its entry diagnoses then, markets by reason: ${top(r)}`);
  if (res.paper.quiet.diagnoses) console.log(`after it, ${res.paper.quiet.diagnoses} entry diagnoses (the last ${hm(res.paper.quiet.lastAt!)}), markets by reason summed over them: ${top(res.paper.quiet.reasons)}`);
  const P = res.prices;
  const c = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}c`);
  console.log(`prices at paper's decision records: ${P.matched} of ${P.records} matched within 1 s | mean gap replay vs paper: fair value ${c(P.fv)}, mid ${c(P.mid)}, price traded on ${c(P.price)} | shift from fair value: paper ${c(P.shiftPaper)}, replay ${c(P.shiftReplay)} | same side of the mid ${pct(P.sameSide)} of ${P.sides} | same position ${pct(P.samePosition)}`);
  console.log(`the fair value's inputs, replay vs paper: index gap ${P.spotBp ?? 'n/a'} bp | strike differs on ${pct(P.strikeDiffers)} | volatility ratio: EWMA x${P.sigmaRatio ?? 'n/a'}, priced with x${P.sigmaPricingRatio ?? 'n/a'} | priced over the EWMA: paper x${P.pricedPaper ?? 'n/a'}, replay x${P.pricedReplay ?? 'n/a'} (TA network x${P.taVolMult ?? 'n/a'})`);
  console.log(`the price beyond the trained model's (TA tilt, rule book, SNN): paper ${c(P.overlayPaper)}, replay ${c(P.overlayReplay)} (TA tilt ${c(P.taShift)}, rule book ${c(P.ruleShift)})`);
  const F = P.firstHour;
  if (F?.matched) console.log(`the stretch's first hour: ${F.matched} of ${F.records} matched | fair value gap ${c(F.fv)}, mid ${c(F.mid)}, price traded on ${c(F.price)} | same side of the mid ${pct(F.sameSide)} of ${F.sides} | same position ${pct(F.samePosition)}, held paper ${pct(F.held.paper)} (${F.held.paperSize ?? 'n/a'} c), replay ${pct(F.held.replay)} (${F.held.replaySize ?? 'n/a'} c) | index gap ${F.spotBp ?? 'n/a'} bp, EWMA x${F.sigmaRatio ?? 'n/a'}, priced with x${F.sigmaPricingRatio ?? 'n/a'} | beyond the model: paper ${c(F.overlayPaper)}, replay ${c(F.overlayReplay)}`);
  console.log(`accuracy gate: replay held back ${pct(res.replay.entryEvaluations ? res.replay.accuracyBlocks / res.replay.entryEvaluations : null)} of its entry evaluations; paper's diagnoses show it keeping out ${pct(res.paper.gateShare)} of the markets | replay's break-even size scale went down to x${res.replay.sizeScaleMin.toFixed(2)} (paper's orders, a share of the bankroll, ignore it)`);
  const tb = (scored: number, net: number, at: string | null, would = false) => `${scored} markets scored, ${f(net)} against holding to settlement, ${would ? 'its own scoreboard would have benched it' : 'benched'} ${at ? hm(at) : 'never'}`;
  console.log(`take-profit bench in the stretch: replay ${tb(res.replay.takeProfitScored, res.replay.takeProfitNetUsd, res.replay.takeProfitBenchedAt, Boolean(res.benchFollowed))} | paper ${tb(res.paper.takeProfitBench.scored, res.paper.takeProfitBench.netUsd, res.paper.takeProfitBench.benchedAt)}`);
  const BF = res.benchFollowed;
  console.log(BF ? `the replay's take-profit sold or sat out as paper's bench did: ${BF.benched ? 'benched' : 'selling'} at the start${BF.events.map((e) => `, ${e.benched ? 'benched' : 'selling again'} ${hm(e.t)}`).join('')}` : "the replay's take-profit benched on its own scoreboard (--own-bench)");
  // Market by market: the first ones each side scored, with what the other side's sales made on the same market.
  const RB = res.replay.takeProfitByMarket ?? {}, PB = res.paper.takeProfitBench.byMarket ?? {};
  const one = (x: TakeProfitMarket | undefined) => (x ? `${x.contracts.toFixed(0)} c ${f(x.usd)}` : 'none');
  const firsts = (own: Record<string, TakeProfitMarket>) => Object.entries(own).sort((x, y) => x[1].t - y[1].t).slice(0, 6).map(([k]) => k);
  const both = Object.keys(RB).filter((k) => PB[k]);
  const sum = (o: Record<string, TakeProfitMarket>, ks: string[]) => ks.reduce((a, k) => ({ c: a.c + o[k].contracts, usd: a.usd + o[k].usd }), { c: 0, usd: 0 });
  const sR = sum(RB, both), sP = sum(PB, both);
  console.log(`take-profit by market: ${both.length} scored on both sides (replay ${sR.c.toFixed(0)} c ${f(sR.usd)}, paper ${sP.c.toFixed(0)} c ${f(sP.usd)}), ${Object.keys(RB).length - both.length} the replay's only, ${Object.keys(PB).length - both.length} paper's only`);
  console.log(`  the replay's first: ${firsts(RB).map((k) => `${k} ${new Date(RB[k].t).toISOString().slice(11, 16)} replay ${one(RB[k])} / paper ${one(PB[k])}`).join(' | ') || 'none'}`);
  console.log(`  paper's first: ${firsts(PB).map((k) => `${k} ${new Date(PB[k].t).toISOString().slice(11, 16)} paper ${one(PB[k])} / replay ${one(RB[k])}`).join(' | ') || 'none'}`);
  const H = P.held;
  if (H) console.log(`positions at paper's decision records: paper held one in ${pct(H.paper)} (${H.paperSize ?? 'n/a'} contracts on average), the replay in ${pct(H.replay)} (${H.replaySize ?? 'n/a'})`);
  console.log(`risk gateway turned down (one a market, side, purpose and reason a minute, as paper logs it): replay ${top(res.replay.rejected) || 'none'} | paper ${top(res.paper.rejected) || 'none'}`);
  const b = (x: number | null) => (x === null ? 'the setting' : `${(x * 100).toFixed(2)}c`);
  console.log(`maker buffer: paper's now ${b(res.makerBufferPaper)}, the replay's at its end ${b(res.replay.makerBufferEnd)} | the engine's other models in the replay: ${res.models.join(', ') || 'none'} | validation gates ${res.gates}${res.benched.length ? ` (benched: ${res.benched.join(', ')})` : ''}`);
  console.log(`started from paper's own state at the stretch's start: ${res.seeded.join(', ') || 'nothing (empty take-profit bench and accuracy gate)'}`);
  console.log(`settings that differ from the paper bot's at that start: ${res.settingsDiffer === null ? 'no start logged in these days' : res.settingsDiffer.length ? res.settingsDiffer.join(', ') : 'none'} | model swaps in the stretch: ${res.modelSwaps.length ? res.modelSwaps.map(hm).join(', ') : 'none'}`);
  console.log(`hourly P&L correlation ${res.hourCorr === null ? 'n/a' : res.hourCorr.toFixed(2)} | total gap ${pct(res.pnlGap)}`);
  console.log(!res.checked ? `VERDICT not checked yet: ${res.why.join('; ')}` : res.close ? 'VERDICT close: sweep results can count' : `VERDICT not close: ${res.why.join('; ')}`);
  console.log(`peak memory ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB`);
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error((e as Error).message); process.exit(1); });

// Kalshi's fee schedule, exactly (the owner on Oct 23: "rather than guessing the bot should do a check on the Kalshi
// Fee Schedule that they list on their site, that way the bot knows exactly what the fees will be").
//
// Three sources, checked against each other:
//  1. The published schedule (kalshi.com/docs/kalshi-fee-schedule.pdf), read every KALSHI_FEE_SCHEDULE_HOURS: the
//     general (taker) formula fees = round up(M x 0.07 x C x P x (1-P)), the maker formula (M x 0.0175 x ...), the
//     rounding rule, the date it took effect, the General Trading Fees Table (the bot's formula must reproduce it), and
//     the Non-Standard Fees table (each listed series' maker and taker multipliers; unlisted series pay the general
//     taker fee and no maker fee).
//  2. The API, per series (GET /series/{t}: fee_type, fee_multiplier; hourly), its scheduled changes (GET
//     /series/fee_changes) and per-event overrides (GET /events/fee_changes). The fee types are the schedule's tables
//     (Kalshi's API reference): quadratic = the general table, no maker fee; quadratic_with_maker_fees = plus the maker
//     fee (maker multiplier M); quadratic_with_combo_maker_fees = the maker fee at twice that (0.5 x 0.07 instead of
//     0.25 x 0.07); flat = a table the current schedule does not carry, so such a series is not traded.
//  3. Every live fill: the fee Kalshi charged against the fee the schedule predicts. The same check learns the
//     account's rounding grid ($0.0001 for direct members, $0.01 through an FCM) from the fees actually charged.
// A series is verified when the API gave a fee type the schedule defines. Where the published table and the API
// disagree, the higher fee is used (a cost is never underestimated) and the status says so.

import { DEFAULT_FEES, orderFee, takerFee, type FeeSchedule } from '../fees';
import { readJson, writeJsonAtomic } from '../util/persist';
import { pdfLines, pdfText } from '../util/pdfText';

export const FEE_SCHEDULE_URL = 'https://kalshi.com/docs/kalshi-fee-schedule.pdf';

export interface PublishedSchedule {
  checkedAt: number;
  /** "Last updated and effective: July 7, 2026". */
  effective?: string;
  takerRate: number;
  makerRate: number;
  /** "rounds up such that the fee + positionCost is rounded to a centicent". */
  centicent: boolean;
  /** Series listed in the Non-Standard Fees table, with their maker and taker multipliers. */
  nonStandard: Record<string, { maker: number; taker: number }>;
  /** Series listed twice with different multipliers: left out of nonStandard. */
  conflicts: string[];
  /** The General Trading Fees Table: price of one contract, fee for 1 and for 100 contracts. */
  table: Array<{ price: number; fee1: number; fee100: number }>;
  etag?: string;
  lastModified?: string;
}

const FOOTER = /Last updated and effective:\s*([A-Z][a-z]+\.? \d{1,2}, \d{4})/g;
const FORMULA = /fees\s*=\s*round\s*up\s*\(\s*M\s*[x×*]\s*(\d*\.?\d+)\s*[x×*]\s*C\s*[x×*]\s*P\s*[x×*]\s*\(\s*1\s*[-−–]\s*P\s*\)\s*\)/i;
const ROW = /^(KX[A-Z0-9]+)\b(?:.*\s)?(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/;
const TABLE_ROW = /^\$(\d*\.\d+)\s+\$(\d*\.\d+)\s+\$(\d+(?:\.\d+)?)\s+\$(\d*\.\d+)$/;

/** The schedule's terms, from the text lines of the published PDF. */
export function parsePublishedSchedule(lines: string[], checkedAt: number): PublishedSchedule | { error: string } {
  let effective: string | undefined;
  const clean = lines.map((l) => {
    for (const m of l.matchAll(FOOTER)) effective ??= m[1];
    return l.replace(FOOTER, '').replace(/\s+/g, ' ').trim();
  }).filter(Boolean);
  const makerAt = clean.findIndex((l) => /^Maker Fees$/i.test(l));
  let takerRate: number | undefined, makerRate: number | undefined;
  clean.forEach((l, i) => {
    const m = FORMULA.exec(l);
    if (!m) return;
    if (makerAt >= 0 && i > makerAt) makerRate ??= Number(m[1]);
    else takerRate ??= Number(m[1]);
  });
  if (takerRate === undefined || !(takerRate > 0 && takerRate < 0.5)) return { error: 'general trading fee formula not found' };
  if (makerRate === undefined || !(makerRate >= 0 && makerRate < 0.5)) return { error: 'maker fee formula not found' };

  const table: PublishedSchedule['table'] = [];
  for (const l of clean) {
    const m = TABLE_ROW.exec(l);
    if (m) table.push({ price: Number(m[1]), fee1: Number(m[2]), fee100: Number(m[4]) });
  }

  // The Non-Standard Fees table runs from its heading to the next section. Its header names the column order.
  const start = clean.findIndex((l) => /^Non-Standard Fees/i.test(l));
  const stop = clean.findIndex((l, i) => i > start && /^Perpetual Futures Fees/i.test(l));
  const rows = start >= 0 ? clean.slice(start + 1, stop > start ? stop : undefined) : [];
  const header = rows.find((l) => /maker/i.test(l) && /taker/i.test(l))?.toLowerCase();
  const makerFirst = !header || header.indexOf('maker') < header.indexOf('taker');
  const found = new Map<string, { maker: number; taker: number }>();
  const conflicts = new Set<string>();
  for (const l of rows) {
    const m = ROW.exec(l);
    if (!m) continue;
    const a = Number(m[2]), b = Number(m[3]);
    // Overprinted rows in the PDF read as doubled digits ("11 11"); no real multiplier is that large.
    if (a > 10 || b > 10) continue;
    const v = makerFirst ? { maker: a, taker: b } : { maker: b, taker: a };
    const prev = found.get(m[1]);
    if (prev && (prev.maker !== v.maker || prev.taker !== v.taker)) conflicts.add(m[1]);
    else found.set(m[1], v);
  }
  for (const c of conflicts) found.delete(c);
  return {
    checkedAt, effective, takerRate, makerRate,
    centicent: clean.some((l) => /rounded to a centicent/i.test(l)),
    nonStandard: Object.fromEntries([...found].sort((x, y) => x[0].localeCompare(y[0]))),
    conflicts: [...conflicts].sort(),
    table,
  };
}

/** Read the published schedule PDF. */
export function readPublishedSchedulePdf(pdf: Buffer, checkedAt: number): PublishedSchedule | { error: string } {
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') return { error: 'not a PDF' };
  return parsePublishedSchedule(pdfLines(pdfText(pdf)).map((l) => l.text), checkedAt);
}

/** Taker and maker multipliers for a series' fee type and multiplier (GET /series), or undefined when the type is not
 *  one the schedule defines as a formula. */
export function feeTypeMultipliers(type: string | undefined, m: number | undefined): { taker: number; maker: number } | undefined {
  if (m === undefined || !Number.isFinite(m) || m < 0) return undefined;
  switch (type) {
    case 'quadratic': return { taker: m, maker: 0 };
    case 'quadratic_with_maker_fees': return { taker: m, maker: m };
    case 'quadratic_with_combo_maker_fees': return { taker: m, maker: 2 * m };
    default: return undefined;
  }
}

/** Does the bot's fee formula, at the published rates and a whole-cent grid, reproduce the published fee table? */
export function tableCheck(p: PublishedSchedule): { rows: number; matched: number; firstMiss?: string } {
  const fees: FeeSchedule = { ...DEFAULT_FEES, balancePrecision: 0.01, takerRate: p.takerRate };
  let matched = 0, firstMiss: string | undefined;
  for (const r of p.table) {
    const f1 = takerFee(1, r.price, fees), f100 = takerFee(100, r.price, fees);
    if (Math.abs(f1 - r.fee1) < 1e-9 && Math.abs(f100 - r.fee100) < 1e-9) matched++;
    else firstMiss ??= `$${r.price.toFixed(2)}: the bot computes $${f1.toFixed(2)} / $${f100.toFixed(2)}, the table says $${r.fee1.toFixed(2)} / $${r.fee100.toFixed(2)}`;
  }
  return { rows: p.table.length, matched, firstMiss };
}

export interface FeeChange { type?: string | null; multiplier?: number | null; ts: number }

export interface FillFeeCheck {
  /** exact: the charged fee is the predicted one; rebate: lower by whole steps of the rounding grid (Kalshi's fee
   *  accumulator refunding earlier rounding); mismatch: anything else. */
  result: 'exact' | 'rebate' | 'mismatch';
  predicted: number;
  charged: number;
  note?: string;
}

interface SeriesFees { type?: string; multiplier?: number; fetchedAt: number }
interface FillTally { checked: number; exact: number; rebate: number; mismatch: number; last?: FillFeeCheck & { ticker: string; ts: number } }
interface Saved { published?: PublishedSchedule; learnedPrecision?: number; votes?: { direct: number; fcm: number }; fills?: FillTally }

const MIN_VOTES = 3;

export class FeeBook {
  private readonly series = new Map<string, SeriesFees>();
  private readonly seriesChanges = new Map<string, FeeChange[]>();
  private readonly events = new Map<string, FeeChange[]>();
  private eventsAt = 0;
  private publishedAt = 0;
  private publishedError?: string;
  published?: PublishedSchedule;
  private learned?: number;
  private votes = { direct: 0, fcm: 0 };
  private fills: FillTally = { checked: 0, exact: 0, rebate: 0, mismatch: 0 };
  private readonly perSeries = new Map<string, { checked: number; mismatch: number }>();

  constructor(private readonly configuredPrecision: number, private readonly file?: string) {
    const s = file ? readJson<Saved>(file, { quarantine: true }) : undefined;
    if (s?.published && typeof s.published.takerRate === 'number') this.published = s.published;
    if (s?.learnedPrecision === 0.01 || s?.learnedPrecision === 0.0001) this.learned = s.learnedPrecision;
    if (s?.votes) this.votes = { direct: Number(s.votes.direct) || 0, fcm: Number(s.votes.fcm) || 0 };
    if (s?.fills && typeof s.fills.checked === 'number') this.fills = { ...s.fills };
  }

  // ---- inputs --------------------------------------------------------------------------------------------------

  /** GET /series/{t}: its fee type and multiplier (undefined: the response carried neither). */
  setSeries(series: string, f: { feeType?: string; multiplier?: number } | undefined, now: number): void {
    this.series.set(series, { type: f?.feeType, multiplier: f?.multiplier, fetchedAt: now });
  }

  seriesFetchedAt(series: string): number { return this.series.get(series)?.fetchedAt ?? 0; }

  /** GET /series/fee_changes for the series: each takes effect at its time. */
  setSeriesChanges(series: string, changes: Array<{ feeType?: string; multiplier?: number; scheduledTs: number }>): void {
    this.seriesChanges.set(series, changes.map((c) => ({ type: c.feeType, multiplier: c.multiplier, ts: c.scheduledTs })).sort((a, b) => a.ts - b.ts));
  }

  /** GET /events/fee_changes, kept for the series the bot trades. A null field clears that part of the override. */
  setEventChanges(changes: Array<{ eventTicker: string; seriesTicker: string; type: string | null; multiplier: number | null; scheduledTs: number }>, keep: (series: string) => boolean, now: number): void {
    this.events.clear();
    for (const c of changes) {
      if (!keep(c.seriesTicker)) continue;
      const l = this.events.get(c.eventTicker) ?? [];
      l.push({ type: c.type, multiplier: c.multiplier, ts: c.scheduledTs });
      this.events.set(c.eventTicker, l);
    }
    for (const l of this.events.values()) l.sort((a, b) => a.ts - b.ts);
    this.eventsAt = now;
  }

  eventsCheckedAt(): number { return this.eventsAt; }

  /** The published schedule just read (or why it could not be). A failed read keeps the last good one. */
  setPublished(p: PublishedSchedule | { error: string }, now: number): { changed: boolean } {
    this.publishedAt = now;
    if ('error' in p) { this.publishedError = p.error; return { changed: false }; }
    const before = this.published;
    this.published = p;
    this.publishedError = undefined;
    this.save();
    const changed = !before || before.effective !== p.effective || before.takerRate !== p.takerRate || before.makerRate !== p.makerRate
      || JSON.stringify(before.nonStandard) !== JSON.stringify(p.nonStandard);
    return { changed };
  }

  publishedCheckedAt(): number { return this.publishedAt; }

  // ---- the schedule --------------------------------------------------------------------------------------------

  /** The rounding grid in use: what the account's fills showed, else the configured one. */
  precision(): number { return this.learned ?? this.configuredPrecision; }

  /** The series' fee type and multiplier at `now`: the API's, a scheduled change that has taken effect since it was
   *  read, then the event's override. */
  private effective(series: string, event: string | undefined, now: number): { type?: string; multiplier?: number } | undefined {
    const s = this.series.get(series);
    if (!s) return undefined;
    let type = s.type, multiplier = s.multiplier;
    for (const c of this.seriesChanges.get(series) ?? []) {
      if (c.ts > s.fetchedAt && c.ts <= now) { if (c.type) type = c.type; if (c.multiplier !== undefined && c.multiplier !== null) multiplier = c.multiplier; }
    }
    const evs = event ? this.events.get(event) : undefined;
    let ev: FeeChange | undefined;
    if (evs) for (let i = evs.length - 1; i >= 0 && !ev; i--) if (evs[i].ts <= now) ev = evs[i];
    if (ev) { if (ev.type) type = ev.type; if (ev.multiplier !== null && ev.multiplier !== undefined) multiplier = ev.multiplier; }
    return { type, multiplier };
  }

  /** The published table's multipliers for the series (unlisted: the general fee, no maker fee). */
  private publishedFor(series: string): { maker: number; taker: number } | undefined {
    if (!this.published) return undefined;
    return this.published.nonStandard[series] ?? { maker: 0, taker: 1 };
  }

  /** Is the series' fee schedule known exactly? */
  verified(series: string, event?: string, now = Date.now()): { ok: boolean; why?: string } {
    const s = this.series.get(series);
    if (!s) return { ok: false, why: 'series fee schedule not read yet' };
    const e = this.effective(series, event, now);
    if (!feeTypeMultipliers(e?.type, e?.multiplier)) return { ok: false, why: e?.type ? `series fee type ${e.type} is not a formula the fee schedule defines` : 'series fee schedule not verified (no fee type)' };
    return { ok: true };
  }

  /** The schedule to price with. Unverified: a cautious one (the published row, else maker fees assumed). */
  feesFor(series: string, event: string | undefined, now = Date.now()): FeeSchedule & { feeType?: string; source: string } {
    const e = this.effective(series, event, now);
    const api = feeTypeMultipliers(e?.type, e?.multiplier);
    const pub = this.publishedFor(series);
    const base = { balancePrecision: this.precision(), takerRate: this.published?.takerRate, makerRate: this.published?.makerRate };
    if (!api) {
      const t = Math.max(pub?.taker ?? 1, 1), m = Math.max(pub?.maker ?? 1, 1);
      return { ...base, takerMultiplier: t, makerMultiplier: m, feeType: e?.type, source: 'unverified: cautious' };
    }
    if (pub && (pub.taker !== api.taker || pub.maker !== api.maker)) {
      return { ...base, takerMultiplier: Math.max(pub.taker, api.taker), makerMultiplier: Math.max(pub.maker, api.maker), feeType: e?.type, source: 'api and published schedule disagree: the higher' };
    }
    return { ...base, takerMultiplier: api.taker, makerMultiplier: api.maker, feeType: e?.type, source: pub ? 'api, matches the published schedule' : 'api' };
  }

  // ---- live fills ----------------------------------------------------------------------------------------------

  /** Check the fee Kalshi charged on one live fill against the schedule, and learn the rounding grid from it. */
  checkFill(f: { ticker: string; series: string; event?: string; count: number; sidePrice: number; isTaker: boolean; charged: number; ts: number }): FillFeeCheck & { learned?: number } {
    const fees = this.feesFor(f.series, f.event, f.ts);
    const at = (grid: number) => orderFee(f.count, f.sidePrice, f.isTaker, { ...fees, balancePrecision: grid });
    const exact = (p: number) => Math.abs(f.charged - p) < 1e-6;
    const p4 = at(0.0001), p2 = at(0.01);
    let learned: number | undefined;
    if (exact(p4) !== exact(p2)) {
      if (exact(p4)) this.votes.direct++; else this.votes.fcm++;
      const want = this.votes.direct >= MIN_VOTES && this.votes.fcm === 0 ? 0.0001 : this.votes.fcm >= MIN_VOTES && this.votes.direct === 0 ? 0.01 : undefined;
      if (want !== undefined && want !== this.learned) { this.learned = want; learned = want; }
    }
    const grid = this.precision();
    const predicted = at(grid);
    const steps = (predicted - f.charged) / grid;
    const result: FillFeeCheck['result'] = exact(predicted) ? 'exact'
      : f.charged >= -1e-9 && steps > 0 && steps <= 2 + 1e-6 && Math.abs(steps - Math.round(steps)) < 1e-4 ? 'rebate'
      : 'mismatch';
    const note = result === 'mismatch'
      ? `${f.ticker}: charged $${f.charged.toFixed(6)} for ${f.count} @ ${f.sidePrice} ${f.isTaker ? 'taker' : 'maker'}, the schedule says $${predicted.toFixed(6)} (${fees.source}; ${fees.feeType ?? 'no fee type'} x${fees.takerMultiplier}/${fees.makerMultiplier})`
      : undefined;
    this.fills.checked++;
    this.fills[result]++;
    const ps = this.perSeries.get(f.series) ?? { checked: 0, mismatch: 0 };
    ps.checked++;
    if (result === 'mismatch') { ps.mismatch++; this.fills.last = { result, predicted, charged: f.charged, note, ticker: f.ticker, ts: f.ts }; }
    this.perSeries.set(f.series, ps);
    this.save();
    return { result, predicted, charged: f.charged, note, learned };
  }

  // ---- status --------------------------------------------------------------------------------------------------

  status(series: string[], now = Date.now()) {
    const p = this.published;
    const tc = p ? tableCheck(p) : undefined;
    return {
      published: {
        url: FEE_SCHEDULE_URL,
        checkedAt: this.publishedAt || null,
        error: this.publishedError ?? null,
        effective: p?.effective ?? null,
        readAt: p?.checkedAt ?? null,
        takerRate: p?.takerRate ?? null,
        makerRate: p?.makerRate ?? null,
        centicent: p?.centicent ?? null,
        nonStandardListed: p ? Object.keys(p.nonStandard).length : null,
        conflicts: p?.conflicts ?? [],
        tableCheck: tc ?? null,
      },
      precision: { configured: this.configuredPrecision, learned: this.learned ?? null, using: this.precision(), votes: { ...this.votes } },
      series: series.map((s) => {
        const e = this.effective(s, undefined, now);
        const f = this.feesFor(s, undefined, now);
        const v = this.verified(s, undefined, now);
        const pub = this.publishedFor(s);
        return {
          series: s, verified: v.ok, why: v.why ?? null, feeType: e?.type ?? null, multiplier: e?.multiplier ?? null,
          taker: f.takerMultiplier, maker: f.makerMultiplier, source: f.source,
          published: pub ?? null, fills: this.perSeries.get(s) ?? { checked: 0, mismatch: 0 },
        };
      }),
      eventOverrides: this.events.size,
      eventsCheckedAt: this.eventsAt || null,
      fills: { checked: this.fills.checked, exact: this.fills.exact, rebate: this.fills.rebate, mismatch: this.fills.mismatch, lastMismatch: this.fills.last ?? null },
    };
  }

  private save(): void {
    if (this.file) writeJsonAtomic(this.file, { published: this.published, learnedPrecision: this.learned, votes: this.votes, fills: this.fills } satisfies Saved);
  }
}

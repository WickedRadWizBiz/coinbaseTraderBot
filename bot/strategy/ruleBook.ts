// Live rule book: the rules that passed the walk-forward study (research/ruleBook.ts, data/models/
// rule_book.json) combined by the coin's current character (bot/ta/character.ts):
//
//   score = sum(dir x strength x weight) / sum(weight)     over the signals present now whose
//                                                          (rule, timeframe, horizon, character) row
//                                                          passed; the 'all characters' row stands in
//                                                          when the character's own row was not tested
//
// What makes or breaks a rule (research/conditionBook.ts): a passing condition under which it failed on both
// periods silences it while the condition holds; one under which it worked lets a rule that did not pass on its
// own count. The context comes from the same snapshot (bot/strategy/ruleContext.ts).
//
// What invalidates a call (research/invalidationBook.ts): a signal whose call lost money and did worse when
// another signal (or several pointing against it) was present, on both periods, is silenced while that holds.
//
// Pairs of signals seen active together that did better than either alone, on years of history and again on
// later years (the confluence logbook, research/confluenceBook.ts), count the same way when both are present
// now and agree (strength: the mean of the two).
//
// -1 (every passing rule bearish) .. +1 (every passing rule bullish), 0 when none is present. It joins
// the TA / confluence signals of the conviction overlay (bot/strategy/taConviction.ts), so a direction
// the historically proven rules agree on widens the size and one they oppose cuts the boost.
//
// Character also gates the overlay: in a volatile-systemic market (high volatility, everything moving
// together) directional signals have the weakest record, so the conviction boosts stand aside there
// (size stays at the Kelly fair value; the math still prices every contract).

import fs from 'fs';
import type { TaSignal, TaSnapshot } from '../ta/analyzer';
import type { Character } from '../ta/character';
import type { Timeframe } from '../ta/knowledge';
import { CONTEXT_PARAMS, contextOf, oriented } from './ruleContext';

/** research/ruleBook.ts output (data/models/rule_book.json). */
export interface RuleRow {
  id: string; kind: 'rule' | 'book' | 'confluence'; tf: Timeframe | 'multi'; h: number; cls: Character | 'all';
  n: number; hit: number; payoff: number; expBps: number; p: number; fdr: boolean;
  nConf: number; hitConf: number; expConfBps: number;
  pass: boolean; weight: number;
}

/** A pair of signals seen active together (research/confluenceBook.ts): parts are 'kind|id|tf' keys. */
export interface Bracket { tp: number; sl: number; expBps: number; expConfBps: number; hitConf: number; n: number; nConf: number; ok: boolean }
export interface ComboRow {
  parts: [string, string]; h: number;
  n: number; hit: number; expBps: number; liftBps: number; p: number; fdr: boolean;
  nConf: number; hitConf: number; expConfBps: number; liftConfBps: number;
  pass: boolean; weight: number; bracket?: Bracket;
}

/** A condition under which a rule works ('makes') or fails ('breaks') (research/conditionBook.ts): the rule's key
 *  ('kind|id|tf'), a context parameter (bot/strategy/ruleContext.ts) as seen by the signal, and its range [lo, hi)
 *  (null = open). */
export interface ConditionRow {
  key: string; h: number; param: string; lo: number | null; hi: number | null; effect: 'makes' | 'breaks';
  n: number; hit: number; expBps: number; baseBps: number; p: number; fdr: boolean;
  nConf: number; hitConf: number; expConfBps: number; baseConfBps: number; pass: boolean; weight: number;
}

/** A signal or several whose presence turned a rule's call around (research/invalidationBook.ts): `by` is the
 *  other signal's key ('kind|id|tf') or a count ('against>=2': two or more others pointing against it). */
export interface InvalidationRow {
  key: string; by: string; rel: 'with' | 'against'; h: number;
  n: number; hit: number; expBps: number; aloneBps: number; p: number; fdr: boolean;
  nConf: number; hitConf: number; expConfBps: number; aloneConfBps: number; pass: boolean; weight: number;
}

export interface RuleBookFile {
  schema: string;
  generatedAt: string;
  assets: string[];
  from: string; to: string; splitAt: string;
  stride: number; costBps: number; horizons: number[];
  /** Classifier check: accuracy of the class at t for the next 24 h's character, the most-common-class
   *  baseline, and the confusion counts (predicted -> realised). */
  character: { n: number; accuracy: number; baseline: number; confusion: Record<string, Record<string, number>>; share: Record<string, number> };
  rows: RuleRow[];
  /** The confluence logbook: pairs of signals seen active together and what followed (the passing ones count live). */
  combos?: ComboRow[];
  /** What makes or breaks each rule: its record split by the context it fired in (the passing ones apply live). */
  conditions?: ConditionRow[];
  /** What invalidates each rule's call: other signals present at the same time (the passing ones apply live). */
  invalidations?: InvalidationRow[];
}

export interface RuleBookReading { score: number; n: number; agree: string[]; oppose: string[]; cls?: Character; /** Signals present but silenced by a condition under which they fail. */ silenced?: string[]; /** Signals present but invalidated by another signal (or several) present now: 'id@tf by ...'. */ invalidated?: string[] }

export class RuleBook {
  private file?: { mtime: number; f?: RuleBookFile; idx: Map<string, RuleRow>; combos: ComboRow[]; conds: Map<string, ConditionRow[]>; inval: Map<string, InvalidationRow[]> };

  constructor(private readonly path: () => string) {}

  private load(): Map<string, RuleRow> | undefined {
    let p: string;
    try { p = this.path(); } catch { return undefined; }
    let mtime = 0;
    try { mtime = fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0; } catch { mtime = 0; }
    if (!mtime) { this.file = undefined; return undefined; }
    if (this.file?.mtime !== mtime) {
      try {
        const f = JSON.parse(fs.readFileSync(p, 'utf8')) as RuleBookFile;
        const idx = new Map<string, RuleRow>();
        for (const r of f.rows ?? []) if (r.pass && r.weight > 0) idx.set(`${r.kind}|${r.id}|${r.tf}|${r.h}|${r.cls}`, r);
        const conds = new Map<string, ConditionRow[]>();
        for (const c of f.conditions ?? []) if (c.pass) { const k = `${c.key}|${c.h}`; const l = conds.get(k); if (l) l.push(c); else conds.set(k, [c]); }
        const inval = new Map<string, InvalidationRow[]>();
        for (const v of f.invalidations ?? []) if (v.pass) { const k = `${v.key}|${v.h}`; const l = inval.get(k); if (l) l.push(v); else inval.set(k, [v]); }
        this.file = { mtime, f, idx, combos: (f.combos ?? []).filter((c) => c.pass && c.weight > 0), conds, inval };
      } catch { this.file = { mtime, idx: new Map(), combos: [], conds: new Map(), inval: new Map() }; }
    }
    return this.file.idx;
  }

  /** Passing rows (for status). */
  passed(): RuleRow[] { const idx = this.load(); return idx ? [...idx.values()] : []; }
  /** Passing pairs of signals (for status). */
  passedCombos(): ComboRow[] { this.load(); return this.file?.combos ?? []; }
  /** Passing make-or-break conditions (for status). */
  passedConditions(): ConditionRow[] { this.load(); return [...(this.file?.conds.values() ?? [])].flat(); }
  /** Passing invalidations (for status). */
  passedInvalidations(): InvalidationRow[] { this.load(); return [...(this.file?.inval.values() ?? [])].flat(); }
  meta(): Pick<RuleBookFile, 'generatedAt' | 'from' | 'to' | 'splitAt' | 'character'> | undefined { this.load(); const f = this.file?.f; return f ? { generatedAt: f.generatedAt, from: f.from, to: f.to, splitAt: f.splitAt, character: f.character } : undefined; }

  /** Combined direction of the passing rules present in `snap` for horizon h (hours) and character cls. */
  read(snap: TaSnapshot | undefined, h: number, cls?: Character): RuleBookReading | undefined {
    const idx = this.load();
    const combos = this.file?.combos ?? [], conds = this.file?.conds ?? new Map<string, ConditionRow[]>(), inval = this.file?.inval ?? new Map<string, InvalidationRow[]>();
    if ((!idx?.size && !combos.length && !conds.size && !inval.size) || !idx || !snap) return undefined;
    const horizons = [...new Set([...idx.values(), ...combos, ...[...conds.values()].flat(), ...[...inval.values()].flat()].map((r) => r.h))].sort((a, b) => Math.abs(a - h) - Math.abs(b - h));
    const hh = horizons[0];
    if (hh === undefined) return undefined;
    let num = 0, den = 0;
    const agree: string[] = [], oppose: string[] = [], silenced: string[] = [], invalidated: string[] = [];
    // What is active now, as 'kind|id|tf' -> direction and strength (the pairs and invalidations are keyed the same way).
    const present = new Map<string, { dir: number; strength: number }>();
    for (const s of snap.signals) if (s.dir) present.set(`rule|${s.id}|${s.tf}`, s);
    for (const s of snap.book ?? []) if (s.dir) present.set(`book|${s.id}|${s.tf}`, s);
    for (const c of snap.confluences) if (c.score) present.set(`confluence|${c.id}|multi`, { dir: Math.sign(c.score), strength: Math.abs(c.score) });
    /** The passing invalidation of this signal that holds now, if any. */
    const invalidator = (key: string, dir: number) => {
      const vs = inval.get(`${key}|${hh}`);
      if (!vs) return undefined;
      let withA = 0, against = 0;
      for (const [k, o] of present) if (k !== key) { if (Math.sign(o.dir) === Math.sign(dir)) withA++; else against++; }
      return vs.find((v) => {
        const m = /^(with|against)>=(\d+)$/.exec(v.by);
        if (m) return (m[1] === 'with' ? withA : against) >= Number(m[2]);
        const o = present.get(v.by);
        return !!o && (Math.sign(o.dir) === Math.sign(dir) ? 'with' : 'against') === v.rel;
      });
    };
    let ctx: Float32Array | undefined;
    const holds = (c: ConditionRow, dir: number) => {
      const i = CONTEXT_PARAMS.findIndex((p) => p.name === c.param);
      if (i < 0) return false;
      const v = oriented((ctx ??= contextOf(snap, snap.ts)), i, dir);
      return Number.isFinite(v) && (c.lo === null || v >= c.lo) && (c.hi === null || v < c.hi);
    };
    const add = (kind: RuleRow['kind'], s: Pick<TaSignal, 'id' | 'dir' | 'strength'> & { tf: string }) => {
      if (!s.dir) return;
      // What makes or breaks this rule (research/conditionBook.ts): a condition under which it failed on both
      // periods silences it; one under which it worked lets it count even if it did not pass on its own.
      // A signal (or several) present now that turned this rule's call around on both periods silences it.
      const v = invalidator(`${kind}|${s.id}|${s.tf}`, s.dir);
      if (v) { invalidated.push(`${s.id}@${s.tf} by ${v.by}`); return; }
      const cs = conds.get(`${kind}|${s.id}|${s.tf}|${hh}`) ?? [];
      if (cs.some((c) => c.effect === 'breaks' && holds(c, s.dir))) { silenced.push(`${s.id}@${s.tf}`); return; }
      const row = (cls && idx.get(`${kind}|${s.id}|${s.tf}|${hh}|${cls}`)) || idx.get(`${kind}|${s.id}|${s.tf}|${hh}|all`);
      const weight = row?.weight ?? Math.max(0, ...cs.filter((c) => c.effect === 'makes' && holds(c, s.dir)).map((c) => c.weight));
      if (!(weight > 0)) return;
      num += s.dir * s.strength * weight; den += weight;
      (s.dir > 0 ? agree : oppose).push(`${s.id}@${s.tf}`);
    };
    for (const s of snap.signals) add('rule', s);
    for (const s of snap.book ?? []) add('book', s);
    for (const c of snap.confluences) if (c.score) add('confluence', { id: c.id, tf: 'multi', dir: Math.sign(c.score) as -1 | 1, strength: Math.abs(c.score) });
    // Pairs seen together on years of history that did better than either alone (research/confluenceBook.ts).
    for (const c of combos) {
      if (c.h !== hh) continue;
      const a = present.get(c.parts[0]), b = present.get(c.parts[1]);
      if (!a || !b || Math.sign(a.dir) !== Math.sign(b.dir)) continue;
      num += Math.sign(a.dir) * ((a.strength + b.strength) / 2) * c.weight; den += c.weight;
      (a.dir > 0 ? agree : oppose).push(`${c.parts[0].split('|')[1]}+${c.parts[1].split('|')[1]}`);
    }
    if (!(den > 0)) return { score: 0, n: 0, agree, oppose, cls, silenced, invalidated };
    return { score: Math.max(-1, Math.min(1, num / den)), n: agree.length + oppose.length, agree, oppose, cls, silenced, invalidated };
  }
}

let book: RuleBook | undefined;
export function setRuleBook(b: RuleBook | undefined): void { book = b; }
export function activeRuleBook(): RuleBook | undefined { return book; }

/** Characters in which the conviction boosts stand aside. */
export const STAND_ASIDE: Character[] = ['volatile_systemic'];

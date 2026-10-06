// Live rule book: the rules that passed the walk-forward study (research/ruleBook.ts, data/models/
// rule_book.json) combined by the coin's current character (bot/ta/character.ts):
//
//   score = sum(dir x strength x weight) / sum(weight)     over the signals present now whose
//                                                          (rule, timeframe, horizon, character) row
//                                                          passed; the 'all characters' row stands in
//                                                          when the character's own row was not tested
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

/** research/ruleBook.ts output (data/models/rule_book.json). */
export interface RuleRow {
  id: string; kind: 'rule' | 'book' | 'confluence'; tf: Timeframe | 'multi'; h: number; cls: Character | 'all';
  n: number; hit: number; payoff: number; expBps: number; p: number; fdr: boolean;
  nConf: number; hitConf: number; expConfBps: number;
  pass: boolean; weight: number;
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
}

export interface RuleBookReading { score: number; n: number; agree: string[]; oppose: string[]; cls?: Character }

export class RuleBook {
  private file?: { mtime: number; f?: RuleBookFile; idx: Map<string, RuleRow> };

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
        this.file = { mtime, f, idx };
      } catch { this.file = { mtime, idx: new Map() }; }
    }
    return this.file.idx;
  }

  /** Passing rows (for status). */
  passed(): RuleRow[] { const idx = this.load(); return idx ? [...idx.values()] : []; }
  meta(): Pick<RuleBookFile, 'generatedAt' | 'from' | 'to' | 'splitAt' | 'character'> | undefined { this.load(); const f = this.file?.f; return f ? { generatedAt: f.generatedAt, from: f.from, to: f.to, splitAt: f.splitAt, character: f.character } : undefined; }

  /** Combined direction of the passing rules present in `snap` for horizon h (hours) and character cls. */
  read(snap: TaSnapshot | undefined, h: number, cls?: Character): RuleBookReading | undefined {
    const idx = this.load();
    if (!idx?.size || !snap) return undefined;
    const horizons = [...new Set([...idx.values()].map((r) => r.h))].sort((a, b) => Math.abs(a - h) - Math.abs(b - h));
    const hh = horizons[0];
    if (hh === undefined) return undefined;
    let num = 0, den = 0;
    const agree: string[] = [], oppose: string[] = [];
    const add = (kind: RuleRow['kind'], s: Pick<TaSignal, 'id' | 'dir' | 'strength'> & { tf: string }) => {
      if (!s.dir) return;
      const row = (cls && idx.get(`${kind}|${s.id}|${s.tf}|${hh}|${cls}`)) || idx.get(`${kind}|${s.id}|${s.tf}|${hh}|all`);
      if (!row) return;
      num += s.dir * s.strength * row.weight; den += row.weight;
      (s.dir > 0 ? agree : oppose).push(`${s.id}@${s.tf}`);
    };
    for (const s of snap.signals) add('rule', s);
    for (const s of snap.book ?? []) add('book', s);
    for (const c of snap.confluences) if (c.score) add('confluence', { id: c.id, tf: 'multi', dir: Math.sign(c.score) as -1 | 1, strength: Math.abs(c.score) });
    if (!(den > 0)) return { score: 0, n: 0, agree, oppose, cls };
    return { score: Math.max(-1, Math.min(1, num / den)), n: agree.length + oppose.length, agree, oppose, cls };
  }
}

let book: RuleBook | undefined;
export function setRuleBook(b: RuleBook | undefined): void { book = b; }
export function activeRuleBook(): RuleBook | undefined { return book; }

/** Characters in which the conviction boosts stand aside. */
export const STAND_ASIDE: Character[] = ['volatile_systemic'];

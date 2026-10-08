// History ledger: the replay's days cut into labelled weekly blocks (ISO weeks, Monday to Sunday UTC,
// labelled like 2021-W19), and for every network which blocks it has trained on and been judged on.
//
//   holdout weeks   every 8th week older than half a year. No network ever trains on them: they are where a
//                   challenger has to beat the model in use (a contest) before it may replace it, so a
//                   champion is never crowned on data it learned from. The newest half year is left to the
//                   networks that must train on the latest market (the live SNN training window).
//   training weeks  all the others. Each tournament generation takes weeks the network has never trained
//                   on, spread over all the years, so tournaments that keep running never grind the same
//                   weeks again; when every week has been used, there is no fresh history left for it
//                   until new weeks complete.
//   contests        judged on the holdout weeks the network has been judged on least, so repeated contests
//                   do not keep re-using the same few weeks either.
//
// The ledger lives in the models' work folder (models/work/history-ledger.json), with the rest of the
// pipeline state, so it moves with it between the laptop and the server.

import fs from 'fs';
import path from 'path';

const DAY = 86_400_000;
/** One week in this many is held out; weeks newer than this many days are never held out. */
export const HOLDOUT_EVERY = 8;
export const HOLDOUT_MIN_AGE_DAYS = 182;
/** Names the holdout rule (stored on models trained under it: a contest is fair only between those). */
export const HOLDOUT_RULE = `w${HOLDOUT_EVERY}-${HOLDOUT_MIN_AGE_DAYS}d`;

export interface Block { id: string; days: string[] }
export interface BlockUse { trained: number; judged: number; last?: string }
export interface Generation { id: string; kind: 'tournament' | 'contest' | 'train'; blocks: string[]; started: string; done?: string; note?: string }
interface NetLedger { blocks: Record<string, BlockUse>; gens: Generation[] }
interface LedgerFile { version: 1; nets: Record<string, NetLedger> }

/** ISO week label of a day (YYYY-MM-DD, UTC): its Thursday's year and week number. */
export function isoWeek(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday 0
  const thu = new Date(t + (3 - dow) * DAY);
  const y = thu.getUTCFullYear();
  const week = 1 + Math.floor((thu.getTime() - Date.UTC(y, 0, 1)) / (7 * DAY));
  return `${y}-W${String(week).padStart(2, '0')}`;
}

/** Complete weeks (7 days present; `minDays` fewer for sparse histories such as tennis) of a day list, in time order. */
export function weekBlocks(days: string[], minDays = 7): Block[] {
  const by = new Map<string, string[]>();
  for (const d of days) { const w = isoWeek(d); const l = by.get(w); if (l) l.push(d); else by.set(w, [d]); }
  return [...by.entries()].filter(([, ds]) => ds.length >= minDays).map(([id, ds]) => ({ id, days: ds.sort() })).sort((a, b) => (a.days[0] < b.days[0] ? -1 : 1));
}

/** Is this week (its first day) one of the held-out weeks, given the latest day of history? */
export function isHoldout(b: Block, latestDay: string): boolean {
  const start = Date.parse(`${b.days[0]}T00:00:00Z`);
  if (Date.parse(`${latestDay}T00:00:00Z`) - start < HOLDOUT_MIN_AGE_DAYS * DAY) return false;
  // Weeks counted from a fixed Monday (1970-01-05), so the set never moves as history grows.
  const index = Math.round((start - Date.UTC(1970, 0, 5)) / (7 * DAY));
  return index % HOLDOUT_EVERY === 3;
}

/** `n` items spread evenly over `xs` (first and last included). */
export function spread<T>(xs: T[], n: number): T[] {
  if (n >= xs.length) return [...xs];
  if (n <= 0) return [];
  if (n === 1) return [xs[xs.length - 1]];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (n - 1))]);
  return out;
}

export class HistoryLedger {
  private data: LedgerFile;
  constructor(private readonly file: string) {
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')) as LedgerFile; if (this.data.version !== 1) throw new Error('version'); } catch { this.data = { version: 1, nets: {} }; }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  private net(name: string): NetLedger { return (this.data.nets[name] ??= { blocks: {}, gens: [] }); }
  use(name: string, id: string): BlockUse { return this.net(name).blocks[id] ?? { trained: 0, judged: 0 }; }

  /** Training weeks the network has never trained on, spread over the whole timeline (none once every
   *  training week has been used: no fresh history left). With `reuse`, once none is fresh, the weeks it
   *  has trained on least (a tournament that must run, e.g. for a new stage). */
  pickTrain(name: string, blocks: Block[], n: number, latestDay: string, reuse = false): Block[] {
    const train = blocks.filter((b) => !isHoldout(b, latestDay));
    const fresh = train.filter((b) => this.use(name, b.id).trained === 0);
    if (fresh.length || !reuse || !train.length) return spread(fresh, n);
    const least = Math.min(...train.map((b) => this.use(name, b.id).trained));
    return spread(train.filter((b) => this.use(name, b.id).trained === least), n);
  }

  /** Holdout weeks for a contest: the ones the network has been judged on least, spread over the timeline. */
  pickContest(name: string, blocks: Block[], n: number, latestDay: string): Block[] {
    const hold = blocks.filter((b) => isHoldout(b, latestDay));
    const counts = [...new Set(hold.map((b) => this.use(name, b.id).judged))].sort((a, b) => a - b);
    const out: Block[] = [];
    for (const c of counts) {
      if (out.length >= n) break;
      out.push(...spread(hold.filter((b) => this.use(name, b.id).judged === c), n - out.length));
    }
    return out.sort((a, b) => (a.days[0] < b.days[0] ? -1 : 1));
  }

  /** The latest unfinished generation of this kind. */
  current(name: string, kind: Generation['kind']): Generation | undefined {
    const g = this.lastOf(name, kind);
    return g && !g.done ? g : undefined;
  }

  /** The latest generation of this kind, finished or not. */
  lastOf(name: string, kind: Generation['kind']): Generation | undefined {
    return [...(this.data.nets[name]?.gens ?? [])].reverse().find((x) => x.kind === kind);
  }

  begin(name: string, kind: Generation['kind'], blocks: Block[], note?: string, now = Date.now()): Generation {
    const n = this.net(name);
    const g: Generation = { id: `${kind[0]}${n.gens.filter((x) => x.kind === kind).length + 1}`, kind, blocks: blocks.map((b) => b.id), started: new Date(now).toISOString(), note };
    n.gens.push(g);
    return g;
  }

  finish(name: string, id: string, note?: string, now = Date.now()): void {
    const g = this.net(name).gens.find((x) => x.id === id);
    if (g) { g.done = new Date(now).toISOString(); if (note) g.note = note; }
  }

  markTrained(name: string, ids: string[], now = Date.now()): void {
    const n = this.net(name);
    for (const id of ids) { const u = (n.blocks[id] ??= { trained: 0, judged: 0 }); u.trained++; u.last = new Date(now).toISOString(); }
  }

  markJudged(name: string, ids: string[], now = Date.now()): void {
    const n = this.net(name);
    for (const id of ids) { const u = (n.blocks[id] ??= { trained: 0, judged: 0 }); u.judged++; u.last = new Date(now).toISOString(); }
  }

  /** Where a network stands on the given history. */
  summary(name: string, blocks: Block[], latestDay: string): { weeks: number; holdout: number; training: number; trained: number; fresh: number; judged: number; generations: number; last?: Generation } {
    const hold = blocks.filter((b) => isHoldout(b, latestDay)), train = blocks.filter((b) => !isHoldout(b, latestDay));
    const trained = train.filter((b) => this.use(name, b.id).trained > 0).length;
    const n = this.net(name);
    return {
      weeks: blocks.length, holdout: hold.length, training: train.length, trained, fresh: train.length - trained,
      judged: hold.filter((b) => this.use(name, b.id).judged > 0).length, generations: n.gens.filter((g) => g.kind === 'tournament' && g.done).length, last: n.gens[n.gens.length - 1],
    };
  }

  /** Every network in the ledger. */
  names(): string[] { return Object.keys(this.data.nets).sort(); }
}

/** The days of the given week labels (from a block list). */
export function daysOf(blocks: Block[], ids: string[]): string[] {
  const set = new Set(ids);
  return blocks.filter((b) => set.has(b.id)).flatMap((b) => b.days);
}

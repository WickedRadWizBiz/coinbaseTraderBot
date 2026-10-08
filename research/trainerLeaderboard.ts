// The trainer window's champions leaderboard (research/trainerUi.ts): every tournament drawn as a bracket that
// narrows to its champion, with the champion's top attributes.
//
//   tournaments   the TA network (models/work/tanet-population.json) and the spiking networks (models/work/
//                 snnpbt/<domain>/state.json): their last four rounds, the round's best 8 -> 4 -> 2 -> the
//                 champion (the elite of the latest round). Attributes: its fitness, Sortino, drawdown, how
//                 many rounds it won, its genetic generation, and the settings that most set it apart from
//                 the rest of the population (furthest from the population's median, on a log scale for
//                 positive settings).
//   formulas      each coin's evolved formula (models/gp_indicators.json): the best score of four of its
//                 generations up to the champion; attributes: the formula and its test record.
// Champions are ranked by how many rounds they have won (formulas by their test Sharpe), best first.

import fs from 'fs';
import path from 'path';

export interface Entrant { name: string; score: number | null; won?: boolean }
export interface ChampionCard { name: string; headline: string; attrs: Array<[string, string]>; validated?: boolean }
export interface Bracket { id: string; title: string; subtitle: string; columns: Array<{ label: string; entrants: Entrant[] }>; champion: ChampionCard; rank: number }

interface Ranked { member: number; fitness: number; sortino?: number; maxDrawdown?: number; hyper?: Record<string, number> }
interface Saved { log?: Array<{ round: number; evalFrom?: string; evalTo?: string; ranking: Ranked[]; elite: number }>; members?: Array<{ id: number; hyper: Record<string, number>; parents?: [number, number] }>; ga?: { generation: number } }

const read = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
const fmt = (x: number | undefined | null, d = 3) => (x === undefined || x === null || !Number.isFinite(x) ? 'n/a' : Math.abs(x) >= 1000 || (Math.abs(x) < 0.001 && x !== 0) ? x.toExponential(2) : String(+x.toFixed(d)));
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

/** The settings that most set this member apart from the population's median. */
export function distinctive(hyper: Record<string, number>, population: Array<Record<string, number>>, n = 4): Array<[string, string]> {
  const scored = Object.entries(hyper).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => {
    const others = population.map((h) => h[k]).filter((x) => Number.isFinite(x));
    const m = median(others);
    const pos = others.every((x) => x > 0) && v > 0 && m > 0;
    const dist = !Number.isFinite(m) ? 0 : pos ? Math.abs(Math.log(v / m)) : Math.abs(v - m) / (Math.abs(m) + 1e-9);
    return { k, v, dist, up: v >= m };
  });
  return scored.sort((a, b) => b.dist - a.dist).slice(0, n).map((s) => [s.k, `${fmt(s.v)}${s.dist > 0.05 ? (s.up ? ' ▲' : ' ▼') : ''}`]);
}

/** A tournament's bracket: the best 8 -> 4 -> 2 of its last rounds and the champion. */
export function tournamentBracket(id: string, title: string, saved: Saved | undefined): Bracket | undefined {
  const log = saved?.log ?? [];
  if (!log.length) return undefined;
  const last = log.slice(-4);
  const sizes = [8, 4, 2, 1].slice(4 - last.length);
  const columns = last.map((r, i) => ({
    label: i === last.length - 1 ? `Round ${r.round + 1} (final)` : `Round ${r.round + 1}`,
    entrants: r.ranking.slice(0, sizes[i]).map((x, j) => ({ name: `#${x.member}`, score: x.fitness, won: j === 0 })),
  }));
  const fin = last[last.length - 1];
  const top = fin.ranking[0];
  const wins = log.filter((r) => r.ranking[0]?.member === top?.member).length;
  const member = saved?.members?.find((m) => m.id === top?.member);
  const hyper = member?.hyper ?? top?.hyper ?? {};
  const population = (saved?.members ?? []).filter((m) => m.id !== top?.member).map((m) => m.hyper);
  const attrs: Array<[string, string]> = [
    ['fitness', fmt(top?.fitness)], ['Sortino', fmt(top?.sortino, 2)], ['max drawdown', top?.maxDrawdown !== undefined ? `${fmt(100 * top.maxDrawdown, 1)}%` : 'n/a'],
    ['rounds won', `${wins} of ${log.length}`], ...(saved?.ga ? [['generation', String(saved.ga.generation)] as [string, string]] : []),
    ...(member?.parents ? [['parents', `#${member.parents[0]} x #${member.parents[1]}`] as [string, string]] : []),
    ...distinctive(hyper, population),
  ];
  return { id, title, subtitle: `${log.length} rounds${fin.evalTo ? `, last judged on ${fin.evalFrom?.slice(0, 10)}..${fin.evalTo.slice(0, 10)}` : ''}`, columns, champion: { name: `#${top?.member}`, headline: `won ${wins} of ${log.length} rounds`, attrs }, rank: wins };
}

/** Each coin's evolved-formula champion as a bracket of its generations' best scores. */
export function formulaBrackets(file: any): Bracket[] {
  if (!file?.champions) return [];
  return Object.values(file.champions as Record<string, any>).map((c) => {
    const h: Array<{ gen: number; best: number }> = c.history ?? [];
    const pick = h.length <= 4 ? h : [h[0], h[Math.floor(h.length / 3)], h[Math.floor((2 * h.length) / 3)], h[h.length - 1]];
    // Only each generation's best score is kept: one entrant per column, the best of that generation.
    const columns = pick.map((g, i) => ({ label: `Generation ${g.gen}`, entrants: [{ name: i === pick.length - 1 ? 'champion' : 'best', score: g.best, won: true }] }));
    const t = c.test ?? {};
    return {
      id: `gp-${c.asset}`, title: `${c.asset} evolved formula`, subtitle: `${c.population ?? '?'} formulas x ${c.generations ?? '?'} generations, ${c.evaluated ?? '?'} tried`, columns,
      champion: {
        name: c.asset, headline: c.validated ? 'validated on unseen years' : 'not validated', validated: !!c.validated,
        attrs: [['formula', String(c.formula ?? '').slice(0, 90)], ['test Sharpe', fmt(t.sharpe, 2)], ['test return', t.totalReturn !== undefined ? `${fmt(100 * t.totalReturn, 1)}%` : 'n/a'], ['buy and hold', c.buyHoldTest !== undefined ? `${fmt(100 * c.buyHoldTest, 1)}%` : 'n/a'], ['max drawdown', t.maxDd !== undefined ? `${fmt(100 * t.maxDd, 1)}%` : 'n/a'], ['trades', String(t.trades ?? 'n/a')]],
      },
      rank: Number.isFinite(t.sharpe) ? t.sharpe : -Infinity,
    } as Bracket;
  });
}

/** Every bracket the models folder holds: tournaments first (most rounds won first), then the formulas. */
export function leaderboard(models: string): Bracket[] {
  const work = path.join(models, 'work');
  const t: Bracket[] = [];
  const ta = tournamentBracket('ta_net', 'TA network', read(path.join(work, 'tanet-population.json')));
  if (ta) t.push(ta);
  for (const d of ['crypto', 'perps', 'tennis']) { const b = tournamentBracket(`snn-${d}`, `${d[0].toUpperCase()}${d.slice(1)} spiking network`, read(path.join(work, 'snnpbt', d, 'state.json'))); if (b) t.push(b); }
  return [...t.sort((a, b) => b.rank - a.rank), ...formulaBrackets(read(path.join(models, 'gp_indicators.json'))).sort((a, b) => b.rank - a.rank)];
}

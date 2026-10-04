// Optional live tennis score from Kalshi's milestone live data
// (GET /milestones?related_event_ticker=..., then GET /live_data/{type}/milestone/{id}).
// The endpoints come from Kalshi's official SDK, but the tennis `details` payload is undocumented,
// so this parser accepts the common shapes (home/away, competitor1/2, player1/2 counters; tennis
// point strings "0/15/30/40/A") and returns undefined for anything it doesn't recognise. The raw
// payload is shown in /api/status so the mapping can be checked on real matches.
// Which player is "home" doesn't matter much here: progress is nearly symmetric in the two players.

import type { TennisScore } from './tennisModel';

const SIDES: Array<[RegExp, RegExp]> = [
  [/^home/, /^away/],
  [/^competitor_?1|^competitor_?a/, /^competitor_?2|^competitor_?b/],
  [/^player_?1|^player_?a|^p1/, /^player_?2|^player_?b|^p2/],
];

const POINTS: Record<string, number> = { '0': 0, love: 0, '15': 1, '30': 2, '40': 3, a: 4, ad: 4, adv: 4, advantage: 4 };

function num(v: unknown, tennisPoints: boolean): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (tennisPoints && s in POINTS) return POINTS[s];
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Flatten nested objects one level deep ({home: {sets: 1}} -> home_sets). */
function flatten(o: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}, depth = 0): Record<string, unknown> {
  for (const [k, v] of Object.entries(o)) {
    const key = (prefix ? `${prefix}_${k}` : k).toLowerCase();
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) flatten(v as Record<string, unknown>, key, out, depth + 1);
    else out[key] = v;
  }
  return out;
}

export function parseTennisScore(details: unknown): TennisScore | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const f = flatten(details as Record<string, unknown>);
  for (const [ra, rb] of SIDES) {
    const pick = (re: RegExp, what: RegExp, pts = false) => {
      for (const [k, v] of Object.entries(f)) if (re.test(k) && what.test(k)) { const n = num(v, pts); if (n !== undefined) return n; }
      return undefined;
    };
    const setsA = pick(ra, /sets?(_won)?$/), setsB = pick(rb, /sets?(_won)?$/);
    const gamesA = pick(ra, /games?$/), gamesB = pick(rb, /games?$/);
    if (setsA === undefined || setsB === undefined || gamesA === undefined || gamesB === undefined) continue;
    const tb = gamesA === 6 && gamesB === 6;
    const pointsA = pick(ra, /points?$|game_score$/, !tb) ?? 0;
    const pointsB = pick(rb, /points?$|game_score$/, !tb) ?? 0;
    const srv = Object.entries(f).find(([k]) => /serv(er|ing)$/.test(k))?.[1];
    const serverA = typeof srv === 'string' ? (ra.test(srv.toLowerCase()) ? true : rb.test(srv.toLowerCase()) ? false : undefined) : undefined;
    const ok = [setsA, setsB, gamesA, gamesB, pointsA, pointsB].every((x) => x >= 0 && x <= 30);
    if (ok) return { setsA, setsB, gamesA, gamesB, pointsA, pointsB, serverA };
  }
  return undefined;
}

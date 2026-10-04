// Live Tennis API score client (free tier), adapted from the supplied tennisScores.ts.
//
// - One call to GET /matches?status=live&limit=200 returns every live match on all tours.
// - Free tier: 30 requests/minute and 100/day. Each page of the slate costs one request.
// - The key is read from LIVE_TENNIS_API_KEY. Never hard-code it.
// - Score arrays are player-major: index 0 is player one, index 1 is player two;
//   games[0] is player one's games in each set, not the first set's score.
//
// Not confirmed from the provider docs (check the full API reference before relying on them):
// - The player name fields (needed to match a score to its Kalshi market). `playerNames` accepts
//   the common shapes and the match is by surname against the Kalshi market titles.
// - When the daily allowance resets (assumed midnight UTC).
// - The exact 429 response (the body is logged and Retry-After honoured if present).
// The call counter is persisted (optional file) so a restart does not reset the daily budget.

import fs from 'fs';
import path from 'path';
import type { TennisScore } from './tennisModel';
import { logger } from '../util/log';

const log = logger('tennis-api');
const BASE_URL = 'https://api.livetennisapi.com/api/public/v1';

export interface LiveTennisMatch {
  id: number;
  status: string;
  tour: string;
  sets: [number, number];        // sets won: [player one, player two]
  games: [number[], number[]];   // games[player][setIndex]
  points: [string, string];      // current game, e.g. ["40", "30"]
  server: 1 | 2;                 // 1 = player one serving
  is_tiebreak: boolean;
  [field: string]: unknown;      // player fields and anything else
}

interface SlatePage { data: LiveTennisMatch[]; meta: { offset: number; limit: number; has_more: boolean } }

export type Priority = 'normal' | 'exit';

export interface ScoreClientOptions {
  dailyLimit?: number;     // provider's daily cap (free tier: 100)
  exitReserve?: number;    // calls only "exit" requests may use
  perMinuteLimit?: number; // provider's burst cap (free tier: 30)
  cacheTtlMs?: number;     // requests within this window share one snapshot
  maxPages?: number;       // never read more pages than this per refresh
  /** Persist the daily call counter here (survives restarts). */
  stateFile?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export class TennisScoreClient {
  private readonly apiKey: string;
  private readonly opts: Required<Omit<ScoreClientOptions, 'stateFile' | 'apiKey' | 'fetchFn' | 'now'>>;
  private dayKey = '';
  private callsToday = 0;
  private recentCalls: number[] = [];
  private blockedUntil = 0;
  private cache: { at: number; matches: LiveTennisMatch[] } | null = null;
  private inFlight: Promise<LiveTennisMatch[] | null> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  lastError?: string;

  constructor(private readonly options: ScoreClientOptions = {}) {
    const key = options.apiKey ?? process.env.LIVE_TENNIS_API_KEY;
    if (!key) throw new Error('LIVE_TENNIS_API_KEY is not set');
    this.apiKey = key;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.opts = { dailyLimit: 100, exitReserve: 10, perMinuteLimit: 30, cacheTtlMs: 20_000, maxPages: 2, ...stripUndef(options) };
    this.loadState();
  }

  /** Calls used today, for logs and health checks. */
  usage(): { callsToday: number; dailyLimit: number; blockedUntil: number | null } {
    this.rollDay();
    return { callsToday: this.callsToday, dailyLimit: this.opts.dailyLimit, blockedUntil: this.blockedUntil > this.now() ? this.blockedUntil : null };
  }

  /** Cached slate if still fresh (no call). */
  cached(): { at: number; matches: LiveTennisMatch[] } | null { return this.cache; }

  /** Returns the live slate, or null when the budget or the API refuses a call. */
  async getLiveSlate(priority: Priority = 'normal'): Promise<LiveTennisMatch[] | null> {
    if (this.cache && this.now() - this.cache.at < this.opts.cacheTtlMs) return this.cache.matches;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchSlate(priority).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async fetchSlate(priority: Priority): Promise<LiveTennisMatch[] | null> {
    const matches: LiveTennisMatch[] = [];
    let offset = 0;
    try {
      for (let page = 0; page < this.opts.maxPages; page++) {
        if (!this.reserveCall(priority)) break;
        const url = `${BASE_URL}/matches?status=live&limit=200&offset=${offset}`;
        const res = await this.fetchFn(url, { headers: { 'X-API-Key': this.apiKey }, signal: AbortSignal.timeout(10_000) });
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after'));
          this.blockedUntil = this.now() + (retryAfter > 0 ? retryAfter * 1000 : 60_000);
          this.lastError = `429 rate limited: ${(await res.text()).slice(0, 200)}`;
          log.warn(this.lastError);
          break;
        }
        if (!res.ok) {
          // 401 = bad or missing key, 403 = the plan lacks this capability
          this.lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
          log.warn(this.lastError);
          break;
        }
        const body = (await res.json()) as SlatePage;
        matches.push(...(body.data ?? []));
        if (!body.meta?.has_more) break;
        offset = body.meta.offset + body.meta.limit;
        if (page + 1 === this.opts.maxPages) log.warn('live slate truncated at maxPages; some matches are missing');
      }
    } catch (err) {
      this.lastError = `request failed: ${String(err)}`;
      log.warn(this.lastError);
    }
    this.saveState();
    if (matches.length === 0) return null;
    this.lastError = undefined;
    this.cache = { at: this.now(), matches };
    return matches;
  }

  private reserveCall(priority: Priority): boolean {
    this.rollDay();
    const now = this.now();
    if (now < this.blockedUntil) return false;
    this.recentCalls = this.recentCalls.filter((t) => now - t < 60_000);
    if (this.recentCalls.length >= this.opts.perMinuteLimit) return false;
    const cap = priority === 'exit' ? this.opts.dailyLimit : this.opts.dailyLimit - this.opts.exitReserve;
    if (this.callsToday >= cap) return false;
    this.callsToday++;
    this.recentCalls.push(now);
    return true;
  }

  private rollDay(): void {
    const key = new Date(this.now()).toISOString().slice(0, 10); // UTC date
    if (key !== this.dayKey) { this.dayKey = key; this.callsToday = 0; }
  }

  private loadState(): void {
    const f = this.options.stateFile;
    if (!f) return;
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8')) as { dayKey: string; callsToday: number; blockedUntil?: number };
      this.dayKey = s.dayKey; this.callsToday = s.callsToday; this.blockedUntil = s.blockedUntil ?? 0;
    } catch { /* first run */ }
  }

  private saveState(): void {
    const f = this.options.stateFile;
    if (!f) return;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ dayKey: this.dayKey, callsToday: this.callsToday, blockedUntil: this.blockedUntil }));
    } catch (e) { log.warn('could not persist tennis API budget', { error: String(e) }); }
  }
}

function stripUndef<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && !['stateFile', 'apiKey', 'fetchFn', 'now'].includes(k))) as Partial<T>;
}

export interface ScoreChange {
  gamesWon: [number, number]; // games each player won between the two snapshots
  setsWon: [number, number];
  breaks: [number, number];   // games won on the opponent's serve
  exact: boolean;             // false when more than one game passed, so breaks are unknown
}

/** What happened between two snapshots of the same match: was that price move a break? */
export function diffScore(prev: LiveTennisMatch, next: LiveTennisMatch): ScoreChange {
  const total = (m: LiveTennisMatch, p: 0 | 1) => (m.games?.[p] ?? []).reduce((a, b) => a + b, 0);
  const gamesWon: [number, number] = [total(next, 0) - total(prev, 0), total(next, 1) - total(prev, 1)];
  const setsWon: [number, number] = [next.sets[0] - prev.sets[0], next.sets[1] - prev.sets[1]];
  const exact = gamesWon[0] + gamesWon[1] === 1;
  const breaks: [number, number] = [0, 0];
  if (exact && !prev.is_tiebreak) {
    const winner = gamesWon[0] === 1 ? 0 : 1;
    if (winner !== prev.server - 1) breaks[winner] = 1;
  }
  return { gamesWon, setsWon, breaks, exact };
}

// ---- mapping to the bot's score model and Kalshi markets -------------------------------------

const PTS: Record<string, number> = { '0': 0, love: 0, '15': 1, '30': 2, '40': 3, a: 4, ad: 4, adv: 4, advantage: 4 };

/** The two player names, from whichever of the common shapes the payload uses. */
export function playerNames(m: LiveTennisMatch): [string, string] | undefined {
  const s = (v: unknown): string | undefined => {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') { const o = v as Record<string, unknown>; return s(o.name ?? o.full_name ?? o.fullName ?? o.short_name ?? o.display_name ?? (o.first_name && o.last_name ? `${o.first_name} ${o.last_name}` : undefined)); }
    return undefined;
  };
  const pairs: [string, string][] = [['player1', 'player2'], ['player_1', 'player_2'], ['player_one', 'player_two'], ['playerOne', 'playerTwo'], ['home', 'away'], ['home_player', 'away_player'], ['p1', 'p2'], ['player1_name', 'player2_name'], ['team1', 'team2']];
  for (const [a, b] of pairs) { const x = s(m[a]), y = s(m[b]); if (x && y) return [x, y]; }
  for (const k of ['players', 'competitors', 'participants', 'teams']) {
    const arr = m[k];
    if (Array.isArray(arr) && arr.length >= 2) { const x = s(arr[0]), y = s(arr[1]); if (x && y) return [x, y]; }
  }
  return undefined;
}

const norm = (x: string) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s-]/g, ' ');
/** Surname tokens (last word, and hyphenated parts) used for matching. */
const surnames = (name: string) => { const w = norm(name).split(/\s+/).filter((t) => t.length >= 3); const last = w[w.length - 1] ?? ''; return [last, ...last.split('-')].filter((t) => t.length >= 3); };

/** Which API player (0/1) a Kalshi market title refers to, or undefined. */
export function playerIndexForTitle(m: LiveTennisMatch, title: string): 0 | 1 | undefined {
  const names = playerNames(m);
  if (!names) return undefined;
  // Kalshi titles read "Will <player> win the <A> vs <B> ...": the player named before "win".
  const t = norm(title);
  const subject = /will\s+(.+?)\s+win/.exec(t)?.[1] ?? t;
  const hit = (i: 0 | 1) => surnames(names[i]).some((sn) => new RegExp(`\\b${sn}\\b`).test(subject));
  const a = hit(0), b = hit(1);
  return a && !b ? 0 : b && !a ? 1 : undefined;
}

/** Find the live match for a Kalshi event from its two market titles; `flip` = API player 2 is our A. */
export function findMatch(slate: LiveTennisMatch[], titleA: string, titleB?: string): { match: LiveTennisMatch; flip: boolean } | undefined {
  for (const m of slate) {
    const ia = playerIndexForTitle(m, titleA);
    const ib = titleB ? playerIndexForTitle(m, titleB) : undefined;
    if (ia !== undefined && (ib === undefined || ib !== ia)) return { match: m, flip: ia === 1 };
    if (ia === undefined && ib !== undefined) return { match: m, flip: ib === 0 };
  }
  return undefined;
}

/** Convert to the bot's TennisScore (current-set games, numeric points), oriented to our player A. */
export function toTennisScore(m: LiveTennisMatch, flip = false): TennisScore | undefined {
  if (!Array.isArray(m.sets) || !Array.isArray(m.games)) return undefined;
  const a = flip ? 1 : 0, b = flip ? 0 : 1;
  const setIdx = (m.sets[0] ?? 0) + (m.sets[1] ?? 0);
  const g = (p: number) => { const arr = m.games[p] ?? []; return arr[setIdx] ?? 0; };
  const pt = (v: string | undefined) => {
    const s = String(v ?? '0').trim().toLowerCase();
    if (m.is_tiebreak) { const n = Number(s); return Number.isFinite(n) ? n : 0; }
    return s in PTS ? PTS[s] : Number.isFinite(Number(s)) ? Number(s) : 0;
  };
  return {
    setsA: m.sets[a] ?? 0, setsB: m.sets[b] ?? 0, gamesA: g(a), gamesB: g(b),
    pointsA: pt(m.points?.[a]), pointsB: pt(m.points?.[b]),
    serverA: m.server ? (m.server - 1 === a) : undefined,
  };
}

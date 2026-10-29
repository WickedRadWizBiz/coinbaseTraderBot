// Session-aware risk logic.
//
// 1. Session risk profile: per-session multipliers applied on top of the global limits:
//      sizeMult   in [0, 1.5] scales Kelly size / the per-order dollar cap (0 = no new risk; above 1 only where a
//                            session reliably earned, and never past the hard caps: contracts per order stay capped)
//      minEdgeAdd in [0, .2] extra edge required before quoting/taking
//      skewMult   in [0, 5]  scales inventory skew (Cartea-Jaimungal's idea of a
//                            session-dependent running inventory penalty)
//    Keys: any SessionKey plus 'us_open' (first 30 min after the NYSE open);
//    when both apply, the stricter value wins. Default: neutral (no change).
//    research:sessions recommends values from recorded data; the training pipeline writes them to
//    session_risk.json and the bot applies them (SESSION_RISK_AUTO, the owner's choice on Oct 28: automatic, and it
//    may size up at about half the weight it sizes down). SESSION_RISK set by hand wins per session.
//
// 2. Hunt session guard: the confluence ratchet's stops sit on resting book
//    liquidity. In thin, transitional liquidity (US close -> Asia open,
//    weekends, and the minutes around a session change) displayed size is
//    pulled and spreads blow out — the "phantom stop-out" failure. There,
//    hunt mode cannot start, and an active hunt reverts to the value-based
//    fair-value exit, which never sells below model value.

import fs from 'fs';
import { SESSION_KEYS, type SessionKey, type SessionState } from './sessions';

export type SessionRiskKey = SessionKey | 'us_open';
export const SESSION_RISK_KEYS: SessionRiskKey[] = [...SESSION_KEYS, 'us_open'];

export interface SessionRiskEntry {
  sizeMult: number;
  minEdgeAdd: number;
  skewMult: number;
}

export type SessionRiskProfile = Partial<Record<SessionRiskKey, Partial<SessionRiskEntry>>>;

/** Most a session can grow size (the auto profile's winning-session value is 1.25). */
export const SESSION_SIZE_MAX = 1.5;

export const NEUTRAL_RISK: SessionRiskEntry = { sizeMult: 1, minEdgeAdd: 0, skewMult: 1 };

export function parseSessionRisk(raw: string | undefined): SessionRiskProfile {
  if (!raw) return {};
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch (e) { throw new Error(`SESSION_RISK must be JSON: ${(e as Error).message}`); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('SESSION_RISK must be a JSON object');
  const out: SessionRiskProfile = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!SESSION_RISK_KEYS.includes(k as SessionRiskKey)) throw new Error(`SESSION_RISK: unknown session "${k}" (valid: ${SESSION_RISK_KEYS.join(', ')})`);
    const e = v as Partial<SessionRiskEntry>;
    const entry: Partial<SessionRiskEntry> = {};
    const check = (name: keyof SessionRiskEntry, lo: number, hi: number) => {
      if (e[name] === undefined) return;
      const n = Number(e[name]);
      if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`SESSION_RISK.${k}.${name}=${e[name]} must be in [${lo}, ${hi}]`);
      entry[name] = n;
    };
    check('sizeMult', 0, SESSION_SIZE_MAX);
    check('minEdgeAdd', 0, 0.2);
    check('skewMult', 0, 5);
    out[k as SessionRiskKey] = entry;
  }
  return out;
}

/** The automatic profile with the hand-set one on top: a session set by hand keeps its values. */
export function mergeSessionRisk(auto: SessionRiskProfile, manual: SessionRiskProfile): SessionRiskProfile {
  const out: SessionRiskProfile = {};
  for (const k of new Set([...Object.keys(auto), ...Object.keys(manual)]) as Set<SessionRiskKey>) out[k] = { ...(auto[k] ?? {}), ...(manual[k] ?? {}) };
  return out;
}

/** The pipeline's session_risk.json ({ version, profile, evidence }); undefined when missing or invalid. */
export function loadSessionRiskFile(file: string): { version: string; profile: SessionRiskProfile } | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string; profile?: unknown };
    return { version: String(raw.version ?? 'unknown'), profile: parseSessionRisk(JSON.stringify(raw.profile ?? {})) };
  } catch { return undefined; }
}

/** Effective multipliers now: the session's entry, tightened by 'us_open' inside its window. */
export function sessionRiskFor(p: SessionRiskProfile, st: SessionState): SessionRiskEntry & { applied: SessionRiskKey[] } {
  const applied: SessionRiskKey[] = [];
  let r: SessionRiskEntry = { ...NEUTRAL_RISK };
  const merge = (key: SessionRiskKey) => {
    const e = p[key];
    if (!e) return;
    // The first entry sets the values (a session may grow size); a second ('us_open') can only tighten them.
    const first = applied.length === 0;
    applied.push(key);
    r = {
      sizeMult: first ? (e.sizeMult ?? 1) : Math.min(r.sizeMult, e.sizeMult ?? r.sizeMult),
      minEdgeAdd: Math.max(r.minEdgeAdd, e.minEdgeAdd ?? 0),
      skewMult: Math.max(r.skewMult, e.skewMult ?? 1),
    };
  };
  merge(st.key);
  if (st.usOpenWindow) merge('us_open');
  return { ...r, applied };
}

/** Why hunt mode must not run now, or undefined if it may. */
export function huntBlockedBySession(st: SessionState, bufferMin: number): string | undefined {
  if (st.key === 'twilight') return 'twilight liquidity (US close -> Asia open)';
  if (st.key === 'weekend') return 'weekend liquidity';
  if (st.minutesToTransition < bufferMin) return `${Math.ceil(st.minutesToTransition)} min to ${st.next?.label ?? 'session change'}`;
  if (st.minutesSinceTransition < bufferMin) return `${Math.floor(st.minutesSinceTransition)} min into ${st.label}`;
  return undefined;
}

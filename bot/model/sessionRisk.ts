// Session-aware risk logic.
//
// 1. Session risk profile (SESSION_RISK): per-session multipliers applied on
//    top of the global limits — they can only REDUCE risk:
//      sizeMult   in [0, 1]  scales Kelly size / per-order caps (0 = no new risk)
//      minEdgeAdd in [0, .2] extra edge required before quoting/taking
//      skewMult   in [0, 5]  scales inventory skew (Cartea-Jaimungal's idea of a
//                            session-dependent running inventory penalty)
//    Keys: any SessionKey plus 'us_open' (first 30 min after the NYSE open);
//    when both apply, the stricter value wins. Default: neutral (no change).
//    research:sessions recommends values from recorded data — they are set by
//    a reviewed config change, never automatically.
//
// 2. Hunt session guard: the confluence ratchet's stops sit on resting book
//    liquidity. In thin, transitional liquidity (US close -> Asia open,
//    weekends, and the minutes around a session change) displayed size is
//    pulled and spreads blow out — the "phantom stop-out" failure. There,
//    hunt mode cannot start, and an active hunt reverts to the value-based
//    fair-value exit, which never sells below model value.

import { SESSION_KEYS, type SessionKey, type SessionState } from './sessions';

export type SessionRiskKey = SessionKey | 'us_open';
export const SESSION_RISK_KEYS: SessionRiskKey[] = [...SESSION_KEYS, 'us_open'];

export interface SessionRiskEntry {
  sizeMult: number;
  minEdgeAdd: number;
  skewMult: number;
}

export type SessionRiskProfile = Partial<Record<SessionRiskKey, Partial<SessionRiskEntry>>>;

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
    check('sizeMult', 0, 1);
    check('minEdgeAdd', 0, 0.2);
    check('skewMult', 0, 5);
    out[k as SessionRiskKey] = entry;
  }
  return out;
}

/** Effective multipliers now: the session's entry, tightened by 'us_open' inside its window. */
export function sessionRiskFor(p: SessionRiskProfile, st: SessionState): SessionRiskEntry & { applied: SessionRiskKey[] } {
  const applied: SessionRiskKey[] = [];
  let r: SessionRiskEntry = { ...NEUTRAL_RISK };
  const merge = (key: SessionRiskKey) => {
    const e = p[key];
    if (!e) return;
    applied.push(key);
    r = {
      sizeMult: Math.min(r.sizeMult, e.sizeMult ?? 1),
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

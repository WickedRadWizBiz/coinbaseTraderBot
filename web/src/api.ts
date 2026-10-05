// API client. When the bot has DASHBOARD_PASSWORD set, the password is sent as the bearer and kept in
// sessionStorage for this tab only; without one the dashboard is open.
const TOKEN_KEY = 'bot-console-token';

export function getToken(): string {
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

export function setToken(t: string): void {
  try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  window.dispatchEvent(new Event('token_changed'));
}

export class Unauthorized extends Error {}

/** Whether the bot asks for a password (GET /api/auth needs no login). */
export async function authRequired(): Promise<boolean> {
  try { const r = await fetch('/api/auth'); return r.ok ? !!(await r.json()).required : true; } catch { return true; }
}

/** A request the server has not answered in this long is reported as a link failure, not left spinning. */
const TIMEOUT_MS = 15_000;

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (e) {
    throw new Error(ctl.signal.aborted ? `bot server not responding (no reply in ${TIMEOUT_MS / 1000}s)` : `bot server unreachable (${(e as Error).message})`);
  } finally { clearTimeout(timer); }
  if (res.status === 401) {
    setToken('');
    throw new Unauthorized('unauthorized');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const usd = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`);
export const pct = (x: number | null | undefined, dp = 1) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(dp)}%`);
export const px = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x.toFixed(2));
export const clock = (ts: number) => new Date(ts).toLocaleTimeString();

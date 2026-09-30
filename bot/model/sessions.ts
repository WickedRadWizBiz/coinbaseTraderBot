// Global market-session clock (DST-correct).
//
// Crypto trades 24/7, but its liquidity and volatility follow the hours of
// the equity markets where most participants sit: volume, spreads and
// volatility are n-shaped around European/US hours, spike at the US equity
// open (9:30-10:00 ET, strongest since spot BTC ETFs), and thin out after
// the US close and on weekends. Sessions are therefore defined from the
// LOCAL hours of the anchor exchanges, resolved through IANA time zones, so
// US/UK daylight-saving shifts (which happen on different dates) are right.
//
//   asia               Tokyo (09:00-15:30 JST) or Hong Kong (09:30-16:00 HKT) open
//   london             London open (08:00-16:30 UK), New York closed
//   london_ny_overlap  London and New York both open (the deepest hours)
//   new_york           New York open (09:30-16:00 ET), London closed
//   twilight           weekday gap after the NY close until Asia opens
//                      (the "US-to-Asia transition" / liquidity trough)
//   weekend            Saturday and Sunday UTC (spreads roughly double)
//
// Exchange holidays are not modelled (crypto trades through them); the
// session describes the usual liquidity regime, not an exchange calendar.

export type SessionKey = 'asia' | 'london' | 'london_ny_overlap' | 'new_york' | 'twilight' | 'weekend';

export const SESSION_KEYS: SessionKey[] = ['asia', 'london', 'london_ny_overlap', 'new_york', 'twilight', 'weekend'];

export const SESSION_LABEL: Record<SessionKey, string> = {
  asia: 'Asian Session',
  london: 'London Session',
  london_ny_overlap: 'London / New York Overlap',
  new_york: 'New York Session',
  twilight: 'US Close → Asia Open (Twilight)',
  weekend: 'Weekend',
};

interface Venue { tz: string; open: number; close: number }

export const VENUES: Record<'tokyo' | 'hongkong' | 'london' | 'newYork', Venue> = {
  tokyo: { tz: 'Asia/Tokyo', open: 9 * 60, close: 15 * 60 + 30 },
  hongkong: { tz: 'Asia/Hong_Kong', open: 9 * 60 + 30, close: 16 * 60 },
  london: { tz: 'Europe/London', open: 8 * 60, close: 16 * 60 + 30 },
  newYork: { tz: 'America/New_York', open: 9 * 60 + 30, close: 16 * 60 },
};

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

export interface ZoneTime { weekday: number; minutes: number; ymd: string; hhmm: string }

/** Local weekday (0 = Sunday), minutes since local midnight, and date in a time zone. */
export function zoneTime(ts: number, tz: string): ZoneTime {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formatters.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ts))) p[part.type] = part.value;
  const h = Number(p.hour), m = Number(p.minute);
  return { weekday: WD[p.weekday], minutes: h * 60 + m, ymd: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` };
}

export function venueOpen(v: Venue, ts: number): boolean {
  const z = zoneTime(ts, v.tz);
  return z.weekday >= 1 && z.weekday <= 5 && z.minutes >= v.open && z.minutes < v.close;
}

/** Session label at an instant. */
export function sessionAt(ts: number): SessionKey {
  const utcDay = new Date(ts).getUTCDay();
  if (utcDay === 0 || utcDay === 6) return 'weekend';
  const ny = venueOpen(VENUES.newYork, ts);
  const ldn = venueOpen(VENUES.london, ts);
  if (ny && ldn) return 'london_ny_overlap';
  if (ny) return 'new_york';
  if (ldn) return 'london';
  if (venueOpen(VENUES.tokyo, ts) || venueOpen(VENUES.hongkong, ts)) return 'asia';
  return 'twilight';
}

// All venue boundaries fall on :00 or :30 UTC (zone offsets are whole hours),
// so transitions can be found on a 30-minute grid.
const STEP = 30 * 60_000;
const gridFloor = (ts: number) => Math.floor(ts / STEP) * STEP;

function scan(ts: number, dir: 1 | -1, maxSteps = 4 * 48): { key: SessionKey; at: number } | undefined {
  const cur = sessionAt(ts);
  // Forward: first grid point after ts. Backward: grid point at or before ts,
  // testing the instant just before each boundary.
  let t = dir > 0 ? gridFloor(ts) + STEP : gridFloor(ts);
  for (let i = 0; i < maxSteps; i++, t += dir * STEP) {
    const k = sessionAt(dir > 0 ? t : t - 1);
    if (dir > 0 && k !== cur) return { key: k, at: t };
    if (dir < 0 && k !== cur) return { key: cur, at: t };
  }
  return undefined;
}

export interface SessionState {
  key: SessionKey;
  label: string;
  /** When the current session started / the next one begins (ms). */
  since: number | undefined;
  next: { key: SessionKey; label: string; at: number } | undefined;
  minutesSinceTransition: number;
  minutesToTransition: number;
  /** First 30 minutes after the NYSE open (the ETF-era volatility spike). */
  usOpenWindow: boolean;
  /** First 3 hours after the Tokyo open on a Monday. */
  mondayAsiaOpen: boolean;
  venues: Record<keyof typeof VENUES, { open: boolean; local: string }>;
}

const cache = new Map<number, SessionState>();

/** Full session state; cached per minute. */
export function sessionState(ts: number): SessionState {
  const minute = Math.floor(ts / 60_000);
  const hit = cache.get(minute);
  if (hit) return hit;
  const key = sessionAt(ts);
  const prev = scan(ts, -1);
  const next = scan(ts, 1);
  const nyT = zoneTime(ts, VENUES.newYork.tz);
  const tkT = zoneTime(ts, VENUES.tokyo.tz);
  const venues = Object.fromEntries(
    (Object.keys(VENUES) as Array<keyof typeof VENUES>).map((k) => [k, { open: venueOpen(VENUES[k], ts), local: zoneTime(ts, VENUES[k].tz).hhmm }]),
  ) as SessionState['venues'];
  const st: SessionState = {
    key,
    label: SESSION_LABEL[key],
    since: prev?.at,
    next: next ? { key: next.key, label: SESSION_LABEL[next.key], at: next.at } : undefined,
    minutesSinceTransition: prev ? (ts - prev.at) / 60_000 : 24 * 60,
    minutesToTransition: next ? (next.at - ts) / 60_000 : 24 * 60,
    usOpenWindow: venues.newYork.open && nyT.minutes - VENUES.newYork.open < 30,
    mondayAsiaOpen: tkT.weekday === 1 && tkT.minutes >= VENUES.tokyo.open && tkT.minutes < VENUES.tokyo.open + 180,
    venues,
  };
  if (cache.size > 5000) cache.clear();
  cache.set(minute, st);
  return st;
}

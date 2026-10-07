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
//   weekend            Friday 16:00 ET (US close) to Sunday 18:00 ET: its own thin, low-volume market
//                      (spreads roughly double)
//   pre_week           Sunday 18:00 ET (CME reopens) to Monday 09:30 ET (US open): the pre-week phase,
//                      when Asia and London open into a market that has been closed for two days
//
// Exchange holidays are not modelled (crypto trades through them); the
// session describes the usual liquidity regime, not an exchange calendar.

export type SessionKey = 'asia' | 'london' | 'london_ny_overlap' | 'new_york' | 'twilight' | 'weekend' | 'pre_week';

/** Order matters: model feature vectors list sess_<key> in this order (append new keys at the end). */
export const SESSION_KEYS: SessionKey[] = ['asia', 'london', 'london_ny_overlap', 'new_york', 'twilight', 'weekend', 'pre_week'];

export const SESSION_LABEL: Record<SessionKey, string> = {
  asia: 'Asian Session',
  london: 'London Session',
  london_ny_overlap: 'London / New York Overlap',
  new_york: 'New York Session',
  twilight: 'US Close → Asia Open (Twilight)',
  weekend: 'Weekend (Fri US close → Sun 18:00 ET)',
  pre_week: 'Pre-Week (Sun 18:00 ET → Mon US open)',
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

const zoneMemo = new Map<string, ZoneTime>();

/** Local weekday (0 = Sunday), minutes since local midnight, and date in a time zone. Minute resolution,
 *  so results are reused within the minute (Intl formatting is slow and every evaluation asks several
 *  times). Shared objects: callers must not modify them. */
export function zoneTime(ts: number, tz: string): ZoneTime {
  const key = `${tz}|${Math.floor(ts / 60_000)}`;
  const hit = zoneMemo.get(key);
  if (hit) return hit;
  const z = zoneTimeUncached(ts, tz);
  if (zoneMemo.size > 20_000) zoneMemo.clear();
  zoneMemo.set(key, z);
  return z;
}

function zoneTimeUncached(ts: number, tz: string): ZoneTime {
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

/** Weekend boundaries in New York time: Friday close, Sunday 18:00 (CME reopen), Monday US open. */
export const WEEK_PHASES = { weekendStart: VENUES.newYork.close, preWeekStart: 18 * 60, preWeekEnd: VENUES.newYork.open };

/** 'weekend' (Fri 16:00 - Sun 18:00 ET), 'pre_week' (Sun 18:00 - Mon 09:30 ET) or undefined (the trading week). */
export function weekPhase(ts: number): 'weekend' | 'pre_week' | undefined {
  const z = zoneTime(ts, VENUES.newYork.tz);
  const P = WEEK_PHASES;
  if ((z.weekday === 5 && z.minutes >= P.weekendStart) || z.weekday === 6 || (z.weekday === 0 && z.minutes < P.preWeekStart)) return 'weekend';
  if ((z.weekday === 0 && z.minutes >= P.preWeekStart) || (z.weekday === 1 && z.minutes < P.preWeekEnd)) return 'pre_week';
  return undefined;
}

/** Session label at an instant. */
export function sessionAt(ts: number): SessionKey {
  const phase = weekPhase(ts);
  if (phase) return phase;
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

/** Kalshi's weekly maintenance: Thursday 03:00-05:00 America/New_York (per the crypto contract terms). */
export const KALSHI_MAINTENANCE = { weekday: 4, start: 3 * 60, end: 5 * 60 };

/** Minutes until the maintenance window starts (0 while inside it; Infinity if more than a day away). */
export function kalshiMaintenance(ts: number): { inside: boolean; minutesTo: number } {
  const z = zoneTime(ts, VENUES.newYork.tz);
  const M = KALSHI_MAINTENANCE;
  if (z.weekday === M.weekday && z.minutes >= M.start && z.minutes < M.end) return { inside: true, minutesTo: 0 };
  if (z.weekday === M.weekday && z.minutes < M.start) return { inside: false, minutesTo: M.start - z.minutes };
  if (z.weekday === (M.weekday + 6) % 7) return { inside: false, minutesTo: 24 * 60 - z.minutes + M.start };
  return { inside: false, minutesTo: Infinity };
}

/** Minutes to the next NYSE open/close today (clipped to +/-240; NaN on weekends). Negative = already passed. */
export function usMarketClock(ts: number): { toOpen: number; toClose: number } {
  const z = zoneTime(ts, VENUES.newYork.tz);
  if (z.weekday === 0 || z.weekday === 6) return { toOpen: NaN, toClose: NaN };
  const c = (x: number) => Math.max(-240, Math.min(240, x));
  return { toOpen: c(VENUES.newYork.open - z.minutes), toClose: c(VENUES.newYork.close - z.minutes) };
}

// ---- US equity market calendar (NYSE) and the market-clock features ------------------------------
//
// Crypto trades 24/7, but its intraday behaviour bends around the US equity day: the open (first 30
// minutes), the late-morning turn around 11:00 ET, the last 30 minutes, and days the NYSE is closed.
// The holiday rules are the NYSE's: weekend holidays move to the nearest weekday (Saturday -> Friday,
// Sunday -> Monday), except New Year's Day on a Saturday, which is not observed.

const dayKey = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const utcDow = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
/** n-th weekday (0 = Sunday) of a month; n = -1 for the last one. */
function nthWeekday(y: number, m: number, wd: number, n: number): number {
  if (n > 0) { const first = utcDow(y, m, 1); return 1 + ((wd - first + 7) % 7) + 7 * (n - 1); }
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lastDow = utcDow(y, m, days);
  return days - ((lastDow - wd + 7) % 7);
}
/** Easter Sunday (Anonymous Gregorian algorithm): [month, day]. */
function easter(y: number): [number, number] {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}
function observed(y: number, m: number, d: number, satToFri = true): string | undefined {
  const w = utcDow(y, m, d);
  if (w === 6) { if (!satToFri) return undefined; const t = new Date(Date.UTC(y, m - 1, d - 1)); return dayKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
  if (w === 0) { const t = new Date(Date.UTC(y, m - 1, d + 1)); return dayKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
  return dayKey(y, m, d);
}
/** One-off closures (national days of mourning). */
const NYSE_SPECIAL_CLOSED = new Set(['2018-12-05', '2025-01-09']);
const holidayCache = new Map<number, { closed: Set<string>; early: Set<string> }>();

/** NYSE full holidays and 13:00 ET early closes for a year (local New York dates, YYYY-MM-DD). */
export function nyseCalendar(y: number): { closed: Set<string>; early: Set<string> } {
  const hit = holidayCache.get(y);
  if (hit) return hit;
  const closed = new Set<string>();
  const add = (k: string | undefined) => { if (k) closed.add(k); };
  add(observed(y, 1, 1, false));
  add(dayKey(y, 1, nthWeekday(y, 1, 1, 3))); // Martin Luther King Jr. Day
  add(dayKey(y, 2, nthWeekday(y, 2, 1, 3))); // Washington's Birthday
  const [em, ed] = easter(y);
  const gf = new Date(Date.UTC(y, em - 1, ed - 2));
  add(dayKey(gf.getUTCFullYear(), gf.getUTCMonth() + 1, gf.getUTCDate())); // Good Friday
  add(dayKey(y, 5, nthWeekday(y, 5, 1, -1))); // Memorial Day
  if (y >= 2022) add(observed(y, 6, 19)); // Juneteenth
  add(observed(y, 7, 4));
  add(dayKey(y, 9, nthWeekday(y, 9, 1, 1))); // Labor Day
  const thanks = nthWeekday(y, 11, 4, 4);
  add(dayKey(y, 11, thanks));
  add(observed(y, 12, 25));
  for (const k of NYSE_SPECIAL_CLOSED) if (k.startsWith(`${y}-`)) closed.add(k);
  const early = new Set<string>();
  const weekdayOpen = (m: number, d: number) => { const w = utcDow(y, m, d); return w >= 1 && w <= 5 && !closed.has(dayKey(y, m, d)); };
  if (weekdayOpen(7, 3) && utcDow(y, 7, 4) !== 1) early.add(dayKey(y, 7, 3)); // day before Independence Day
  if (weekdayOpen(11, thanks + 1)) early.add(dayKey(y, 11, thanks + 1)); // day after Thanksgiving
  if (weekdayOpen(12, 24)) early.add(dayKey(y, 12, 24)); // Christmas Eve
  const out = { closed, early };
  holidayCache.set(y, out);
  return out;
}

export interface UsSession {
  /** Today is a NYSE trading day (weekday, not a holiday). */
  tradingDay: boolean;
  /** Regular hours are open now (09:30 to 16:00 ET, or 13:00 on early-close days). */
  open: boolean;
  /** Minutes since the open / to the close (only meaningful on trading days). */
  sinceOpen: number;
  toClose: number;
  /** Minutes since local New York midnight. */
  minutes: number;
  closeMin: number;
  holiday: boolean;
  earlyClose: boolean;
}

/** The US equity session at an instant (DST-correct, NYSE holidays and early closes). */
export function usSession(ts: number): UsSession {
  const z = zoneTime(ts, VENUES.newYork.tz);
  const cal = nyseCalendar(Number(z.ymd.slice(0, 4)));
  const holiday = cal.closed.has(z.ymd), earlyClose = cal.early.has(z.ymd);
  const tradingDay = z.weekday >= 1 && z.weekday <= 5 && !holiday;
  const closeMin = earlyClose ? 13 * 60 : VENUES.newYork.close;
  const open = tradingDay && z.minutes >= VENUES.newYork.open && z.minutes < closeMin;
  return { tradingDay, open, sinceOpen: z.minutes - VENUES.newYork.open, toClose: closeMin - z.minutes, minutes: z.minutes, closeMin, holiday: holiday && z.weekday >= 1 && z.weekday <= 5, earlyClose };
}

/** Feature names of marketClockFeatures, in order. */
export const MARKET_CLOCK_FEATURES = [
  ...SESSION_KEYS.map((k) => `sess_${k}`),
  'us_trading_day', 'us_open', 'us_since_open_h', 'us_to_close_h', 'us_open30', 'us_open60', 'us_1100', 'us_from_1100_h',
  'us_close30', 'us_after_close60', 'us_premarket', 'us_macro_0830', 'us_holiday', 'us_early_close',
  'ldn_open30', 'ldn_close30', 'asia_open30', 'cme_break', 'cme_weekend_closed',
  'et_hour_sin', 'et_hour_cos', 'et_dow_sin', 'et_dow_cos',
];

/**
 * The market clock as numbers: which session, where in the US equity day (first 30 / 60 minutes,
 * the 11:00 ET window, the last 30 minutes, the hour after the close, pre-market and the 08:30 ET
 * data releases), the London and Tokyo opens, the CME daily break and weekend closure, holidays, and
 * the New York hour and weekday. Values outside the US day are 0 (flags) or -1 (hours).
 */
export function marketClockFeatures(ts: number): Record<string, number> {
  const out: Record<string, number> = {};
  const key = sessionAt(ts);
  for (const k of SESSION_KEYS) out[`sess_${k}`] = k === key ? 1 : 0;
  const us = usSession(ts);
  const z = zoneTime(ts, VENUES.newYork.tz);
  const td = us.tradingDay;
  out.us_trading_day = td ? 1 : 0;
  out.us_open = us.open ? 1 : 0;
  out.us_since_open_h = us.open ? us.sinceOpen / 60 : -1;
  out.us_to_close_h = us.open ? us.toClose / 60 : -1;
  out.us_open30 = us.open && us.sinceOpen < 30 ? 1 : 0;
  out.us_open60 = us.open && us.sinceOpen < 60 ? 1 : 0;
  out.us_1100 = us.open && z.minutes >= 11 * 60 && z.minutes < 12 * 60 ? 1 : 0;
  out.us_from_1100_h = td ? Math.max(-3, Math.min(3, (z.minutes - 11 * 60) / 60)) : -1;
  out.us_close30 = us.open && us.toClose <= 30 ? 1 : 0;
  out.us_after_close60 = td && z.minutes >= us.closeMin && z.minutes < us.closeMin + 60 ? 1 : 0;
  out.us_premarket = td && z.minutes >= 4 * 60 && z.minutes < VENUES.newYork.open ? 1 : 0;
  out.us_macro_0830 = td && z.minutes >= 8 * 60 + 25 && z.minutes < 9 * 60 ? 1 : 0;
  out.us_holiday = us.holiday ? 1 : 0;
  out.us_early_close = us.earlyClose ? 1 : 0;
  const ldn = zoneTime(ts, VENUES.london.tz), tk = zoneTime(ts, VENUES.tokyo.tz);
  const wkLdn = ldn.weekday >= 1 && ldn.weekday <= 5, wkTk = tk.weekday >= 1 && tk.weekday <= 5;
  out.ldn_open30 = wkLdn && ldn.minutes >= VENUES.london.open && ldn.minutes < VENUES.london.open + 30 ? 1 : 0;
  out.ldn_close30 = wkLdn && ldn.minutes >= VENUES.london.close - 30 && ldn.minutes < VENUES.london.close ? 1 : 0;
  out.asia_open30 = wkTk && tk.minutes >= VENUES.tokyo.open && tk.minutes < VENUES.tokyo.open + 30 ? 1 : 0;
  // CME crypto futures: daily break 17:00-18:00 ET Monday-Thursday; closed Friday 17:00 to Sunday 18:00 ET.
  out.cme_break = z.weekday >= 1 && z.weekday <= 4 && z.minutes >= 17 * 60 && z.minutes < 18 * 60 ? 1 : 0;
  out.cme_weekend_closed = (z.weekday === 5 && z.minutes >= 17 * 60) || z.weekday === 6 || (z.weekday === 0 && z.minutes < 18 * 60) ? 1 : 0;
  const h = z.minutes / 60;
  out.et_hour_sin = Math.sin((2 * Math.PI * h) / 24); out.et_hour_cos = Math.cos((2 * Math.PI * h) / 24);
  out.et_dow_sin = Math.sin((2 * Math.PI * z.weekday) / 7); out.et_dow_cos = Math.cos((2 * Math.PI * z.weekday) / 7);
  return out;
}

// ---- Session edges (training windows) ------------------------------------------------------------
// The first and last N minutes of each market session: Asia (Tokyo open .. Hong Kong close), London and
// New York, weekdays, local exchange hours (DST-correct). The bot opens no new positions in them, and the
// training pipeline runs only in them (paused the rest of the time), so training never competes with
// trading for the CPU.

export const SESSION_EDGES: Array<{ name: string; open: Venue; close: Venue }> = [
  { name: 'Asia', open: VENUES.tokyo, close: VENUES.hongkong },
  { name: 'London', open: VENUES.london, close: VENUES.london },
  { name: 'New York', open: VENUES.newYork, close: VENUES.newYork },
];

/** The session edge an instant falls in ("London open", "New York close"), or undefined. */
export function sessionEdge(ts: number, minutes = 40): string | undefined {
  for (const s of SESSION_EDGES) {
    const o = zoneTime(ts, s.open.tz);
    if (o.weekday >= 1 && o.weekday <= 5 && o.minutes >= s.open.open && o.minutes < s.open.open + minutes) return `${s.name} open`;
    const c = zoneTime(ts, s.close.tz);
    if (c.weekday >= 1 && c.weekday <= 5 && c.minutes >= s.close.close - minutes && c.minutes < s.close.close) return `${s.name} close`;
  }
  return undefined;
}

/** The current or next session-edge window: start, end and label (scanned on a one-minute grid, up to 4 days). */
export function nextSessionEdge(ts: number, minutes = 40): { start: number; end: number; label: string } | undefined {
  const M = 60_000;
  let t = Math.floor(ts / M) * M;
  // Coarse 5-minute steps to find the next minute inside a window, then refine to its first minute.
  let label = sessionEdge(t, minutes);
  if (!label) {
    const limit = t + 4 * 86_400_000;
    while (t < limit && !(label = sessionEdge(t, minutes))) t += 5 * M;
    if (!label) return undefined;
    while (sessionEdge(t - M, minutes)) t -= M;
    label = sessionEdge(t, minutes)!;
  } else {
    while (sessionEdge(t - M, minutes)) t -= M;
  }
  let end = t;
  while (sessionEdge(end, minutes) && end - t < 6 * 3_600_000) end += M;
  return { start: t, end, label };
}

// ---- Weekend training ------------------------------------------------------------------------------
// The weekly full training run starts at midnight New York time at the end of Friday (00:00 Saturday ET)
// and runs unpaused until it finishes; the bot opens no new positions while it runs (it needs the CPU,
// and the models it trades with are being replaced). After it finishes the bot trades the weekend
// market as its own regime. Outside the weekend the session-edge windows pace training again.

const WEEKEND_TZ = VENUES.newYork.tz;

/** Weekend free time (training may run unpaused) and the Friday-midnight start hour (a due run may start). */
export function weekendTraining(ts: number): { free: boolean; start: boolean } {
  const z = zoneTime(ts, WEEKEND_TZ);
  const free = weekPhase(ts) === 'weekend';
  return { free, start: free && z.weekday === 6 && z.minutes < 60 };
}

/** The next Friday midnight (00:00 Saturday, New York) at or after ts (within the start hour counts as now). */
export function nextWeekendMidnight(ts: number): number | undefined {
  const H = 3_600_000;
  if (weekendTraining(ts).start) return ts;
  for (let t = Math.ceil(ts / H) * H, i = 0; i < 9 * 24; i++, t += H) if (weekendTraining(t).start) return t;
  return undefined;
}

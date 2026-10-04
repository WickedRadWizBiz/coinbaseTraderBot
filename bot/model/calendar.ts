// Scheduled macro releases (CPI, FOMC, NFP, PCE) for the calendar features.
// Operator-maintained params/calendar.json: [{ "ts": "2026-10-15T12:30:00Z", "kind": "CPI" }, ...].
// Missing file = no calendar (the features read as unavailable, never as "no event").

import fs from 'fs';
import type { MacroEvent } from './featureEngine';

const KINDS = new Set(['CPI', 'FOMC', 'NFP', 'PCE', 'OTHER']);

export function parseCalendar(raw: unknown): MacroEvent[] {
  if (!Array.isArray(raw)) throw new Error('calendar must be a JSON array');
  return raw.map((e, i) => {
    const ts = typeof e?.ts === 'number' ? e.ts : Date.parse(String(e?.ts));
    const kind = String(e?.kind ?? 'OTHER').toUpperCase();
    if (!Number.isFinite(ts)) throw new Error(`calendar[${i}]: bad ts`);
    if (!KINDS.has(kind)) throw new Error(`calendar[${i}]: kind must be one of ${[...KINDS].join(', ')}`);
    return { ts, kind: kind as MacroEvent['kind'] };
  }).sort((a, b) => a.ts - b.ts);
}

export function loadCalendar(file: string): MacroEvent[] | undefined {
  if (!fs.existsSync(file)) return undefined;
  return parseCalendar(JSON.parse(fs.readFileSync(file, 'utf8')));
}

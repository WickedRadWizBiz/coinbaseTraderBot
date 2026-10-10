// When each history source was last checked completely (HISTORY_RECHECK_HOURS): a source checked within that
// window is not asked again, so a run with nothing new flies past the sources checked earlier today instead of
// listing years of archives to find out. One small JSON file per downloader, next to its data.

import fs from 'fs';
import path from 'path';

export const DEFAULT_RECHECK_HOURS = 24;

export interface CheckedStore {
  /** Checked within `recheckMs` of `now` (always false when recheckMs is 0 or undefined). */
  fresh(key: string, now: number, recheckMs?: number): boolean;
  /** Ever checked completely (with this key): later checks may list only what is newer. */
  seen(key: string): boolean;
  mark(key: string, now: number): void;
  forget(key: string): void;
  save(): void;
}

export function checkedStore(file: string): CheckedStore {
  let at: Record<string, number> = {};
  try { at = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { /* first run */ }
  let dirty = false;
  return {
    fresh: (key, now, recheckMs) => Boolean(recheckMs && recheckMs > 0 && at[key] !== undefined && now - at[key] >= 0 && now - at[key] < recheckMs),
    seen: (key) => at[key] !== undefined,
    mark: (key, now) => { at[key] = now; dirty = true; },
    forget: (key) => { if (key in at) { delete at[key]; dirty = true; } },
    save: () => {
      if (!dirty) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(at));
      fs.renameSync(`${file}.tmp`, file);
      dirty = false;
    },
  };
}

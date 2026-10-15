// Real regime transitions for the tournaments' transition penalty (research/selection.ts): each coin's regime at the
// start of each day (research/playbook.ts dayRegimes: bot/ta/regime.ts on bars closed before midnight, the live
// bot's view) and the confirmed changes in it. Labels are cached in <history>/.regime-days.json and only missing
// days are computed, so after the first run this costs a day's worth of work per day.

import fs from 'fs';
import path from 'path';
import { dayRegimes } from './playbook';
import { transitionsOf, type Transition } from './selection';

const D = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

interface Cache { v: 1; labels: Record<string, Record<string, string>> }

/** Each coin's regime label per day ('YYYY-MM-DD' -> key; days without one are left out) between `from` and `to`. */
export function regimeDayLabels(historyDir: string, assets: string[], from: number, to: number, log: (m: string) => void = () => {}): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  if (!assets.length || !(to > from)) return out;
  const file = path.join(historyDir, '.regime-days.json');
  let cache: Cache = { v: 1, labels: {} };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Cache; if (j?.v === 1 && j.labels) cache = j; } catch { /* first run */ }
  const days: string[] = [];
  for (let t = Math.floor(from / D) * D; t < to; t += D) days.push(iso(t));
  const missing = days.filter((d) => assets.some((a) => cache.labels[a]?.[d] === undefined));
  if (missing.length) {
    const t0 = Date.now();
    for (let i = 0; i < missing.length; i += 90) {
      const chunk = missing.slice(i, i + 90);
      const got = dayRegimes(historyDir, chunk, assets);
      for (const d of chunk) for (const a of assets) (cache.labels[a] ??= {})[d] = got.get(d)?.get(a) ?? '';
    }
    try { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(cache)); fs.renameSync(tmp, file); } catch { /* read-only: recomputed next time */ }
    log(`regime labels for ${missing.length} day(s) x ${assets.length} coin(s) in ${((Date.now() - t0) / 1000).toFixed(0)} s (cached in ${path.basename(file)})`);
  }
  for (const a of assets) out.set(a, new Map(days.map((d) => [d, cache.labels[a]?.[d] ?? '']).filter(([, k]) => k) as Array<[string, string]>));
  return out;
}

/** Confirmed regime transitions of `assets` between `from` and `to` (UTC ms). `assets` empty or no history: none. */
export function regimeTransitions(historyDir: string, assets: string[], from: number, to: number, log: (m: string) => void = () => {}): Transition[] {
  const out: Transition[] = [];
  for (const [a, m] of regimeDayLabels(historyDir, assets, from, to, log)) out.push(...transitionsOf([...m].map(([d, key]) => ({ ts: Date.parse(`${d}T00:00:00Z`), key })), a));
  return out.sort((x, y) => x.ts - y.ts);
}

/** The coin a tournament interaction belongs to, from its group (an asset, or a series / event key naming one). */
export function assetOfGroup(assets: string[]): (x: { group?: string }) => string | undefined {
  const sorted = [...assets].sort((a, b) => b.length - a.length);
  return (x) => {
    const g = (x.group ?? '').toUpperCase();
    if (!g) return undefined;
    return sorted.find((a) => g === a || g.includes(a));
  };
}

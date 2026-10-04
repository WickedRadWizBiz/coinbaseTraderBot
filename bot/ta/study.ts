// Measured performance of each TA rule / confluence (research/taStudy.ts output), shown next to the
// live signal so the operator (and the dashboard) sees what the signal historically did, not just
// what the textbook says. Reloaded when the file changes.

import fs from 'fs';

export interface StudyStat { horizonMin: number; n: number; hitRate: number; meanBps: number; ciLo: number; ciHi: number; p: number; fdrPass: boolean }

let cache: { path: string; mtime: number; rows: Map<string, StudyStat[]>; meta: { generatedAt?: string; source?: string; steps?: number } } | undefined;

function load(path: string) {
  try {
    const st = fs.statSync(path);
    if (cache && cache.path === path && cache.mtime === st.mtimeMs) return cache;
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    const rows = new Map<string, StudyStat[]>();
    for (const r of data.rows ?? []) {
      const key = `${r.kind}|${r.id}|${r.tf}`;
      rows.set(key, [...(rows.get(key) ?? []), { horizonMin: r.horizonMin, n: r.n, hitRate: r.hitRate, meanBps: r.meanBps, ciLo: r.ciLo, ciHi: r.ciHi, p: r.p, fdrPass: !!r.fdrPass }]);
    }
    cache = { path, mtime: st.mtimeMs, rows, meta: { generatedAt: data.generatedAt, source: data.source, steps: data.steps } };
    return cache;
  } catch {
    return undefined;
  }
}

export function studyFor(path: string, kind: 'rule' | 'confluence', id: string, tf: string): StudyStat[] | undefined {
  return load(path)?.rows.get(`${kind}|${id}|${tf}`);
}

export function studyMeta(path: string) {
  return load(path)?.meta;
}

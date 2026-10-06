// Champion / challenger: a retrained model replaces the live one only when it is at least as good, so a
// better model is never lost to a worse retrain, and every replaced model is archived (the live TA
// network ensemble reads the archive: bot/ta/taNetEnsemble.ts).
//
// Decision, in order:
//   1. no live model (or it cannot be read)            -> promote the candidate
//   2. both scored on the same held-out data           -> promote only if the candidate scores at least
//                                                         as well (lower is better)
//   3. otherwise, by validated parts (heads / lanes /  -> promote only if the candidate has at least as
//      a passed validation)                               many; on a tie the fresher candidate wins
// AUTO_TRAIN_CHAMPION=false turns the gate off (the candidate always replaces the live model).

import fs from 'fs';
import path from 'path';

export interface Contender { validatedParts: number; score?: number | null; version?: string }
export interface ChampionDecision { promote: boolean; reason: string }

export function championDecision(incumbent: Contender | undefined, candidate: Contender): ChampionDecision {
  if (!incumbent) return { promote: true, reason: 'no live model' };
  const sc = candidate.score, si = incumbent.score;
  if (sc !== undefined && sc !== null && Number.isFinite(sc) && si !== undefined && si !== null && Number.isFinite(si)) {
    return sc <= si
      ? { promote: true, reason: `beats the live model on the same held-out data (${sc.toFixed(5)} vs ${si.toFixed(5)})` }
      : { promote: false, reason: `worse than the live model ${incumbent.version ?? ''} on the same held-out data (${sc.toFixed(5)} vs ${si.toFixed(5)}): kept the live model`.replace('  ', ' ') };
  }
  if (candidate.validatedParts < incumbent.validatedParts) {
    return { promote: false, reason: `validates ${candidate.validatedParts} part(s), the live model ${incumbent.validatedParts}: kept the live model` };
  }
  return { promote: true, reason: candidate.validatedParts > incumbent.validatedParts ? `validates more parts (${candidate.validatedParts} vs ${incumbent.validatedParts})` : `validates as many parts (${candidate.validatedParts}); fresher data` };
}

const readJson = (file: string): Record<string, unknown> | undefined => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };

/** How many parts of a model file passed validation (heads, lanes, or the model itself), by kind. */
export function validatedParts(kind: string, file: string): number | undefined {
  if (!fs.existsSync(file)) return undefined;
  const p = readJson(file) as Record<string, any> | undefined;
  if (!p) return undefined;
  switch (kind) {
    case 'ta_net': return Object.values(p.heads ?? {}).filter((h: any) => h?.validation?.validated).length;
    case 'setups': return (['fast', 'slow'] as const).filter((l) => p.validation?.[l]?.passed).length;
    case 'mlp': return p.validation?.passed ? 1 : 0;
    case 'perp': return p.validation?.passed && p.validation?.backtest?.ok ? 1 : 0;
    default: return p.validation?.validated ? 1 : 0;
  }
}

/** Copy a model file into <dir>/archive/<kind>/ (named by time and version), keeping the newest `keep`. */
export function archiveModel(dir: string, kind: string, file: string, keep = 8, now = Date.now()): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const p = readJson(file);
  const ver = String(p?.version ?? p?.id ?? 'model').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  const ad = path.join(dir, 'archive', kind);
  fs.mkdirSync(ad, { recursive: true });
  const out = path.join(ad, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${ver}.json`);
  fs.copyFileSync(file, out);
  const all = fs.readdirSync(ad).filter((f) => f.endsWith('.json')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(ad, f), { force: true });
  return out;
}

/** Gate and promote: decide, archive the live model when it is replaced, then copy the candidate in. */
export function promoteIfChampion(o: { dir: string; kind: string; candidate: string; live: string; enabled: boolean; candidateScore?: number | null; incumbentScore?: number | null; keep?: number }): ChampionDecision & { archived?: string } {
  const candParts = validatedParts(o.kind, o.candidate) ?? 0;
  const incParts = validatedParts(o.kind, o.live);
  const inc = incParts === undefined ? undefined : { validatedParts: incParts, score: o.incumbentScore, version: String((readJson(o.live) as any)?.version ?? (readJson(o.live) as any)?.id ?? '') };
  const d = o.enabled ? championDecision(inc, { validatedParts: candParts, score: o.candidateScore }) : { promote: true, reason: 'champion gate off (AUTO_TRAIN_CHAMPION=false)' };
  if (!d.promote) return d;
  const archived = inc ? archiveModel(o.dir, o.kind, o.live, o.keep) : undefined;
  fs.copyFileSync(o.candidate, o.live);
  return { ...d, archived };
}

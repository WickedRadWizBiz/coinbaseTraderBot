// The oracle cull's file (research/oracleCull.ts writes it, the TA network's and the Librarian's trainers read it): the
// TA readings the oracle cull switched off, and why.

import fs from 'fs';

export const CULL_SCHEMA = 'cull1';

export type CullLevel = 'noise' | 'unproven';
export interface CullItem {
  name: string;
  /** Mean out-of-sample cross-entropy drop per row (nats), its weekly-block bootstrap 90% interval and p-value. */
  gain: number; lo: number; hi: number; p: number;
  /** Correlation of the reading with the oracle's position (weights x the families' positions, -1..1). */
  capture: number;
  /** Share of scored rows with a value. */
  coverage: number;
  verdict: 'proven' | 'kept' | 'culled';
}
export interface OracleCullFile {
  schema: string; version: string; trainedAt: string; level: CullLevel; q: number;
  rows: number; scoredRows: number; days: number; from: string; to: string;
  culled: string[]; proven: string[];
  items: CullItem[];
  /** Per indicator across timeframes (the name without its m15_ / h1_ / h4_ / d1_ prefix). */
  groups: Record<string, { proven: number; kept: number; culled: number }>;
}

/** The culled readings of a cull file (empty when missing, unreadable or another schema). */
export function readCull(file: string | undefined): string[] {
  if (!file) return [];
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')) as OracleCullFile; return j.schema === CULL_SCHEMA && Array.isArray(j.culled) ? j.culled : []; } catch { return []; }
}


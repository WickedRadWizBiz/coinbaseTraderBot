// Setup journal: every setup the live trader sees and every trade it opens / closes, with what the rest
// of the bot said at that moment (the TA network's forecast, the perps SNN's calls and confidence).
// One JSON line per record in <dir>/journal-YYYY-MM-DD.jsonl (UTC day). The SNN has no history to
// replay, so this is how its value for the setups becomes measurable: as the journal grows, the
// pipeline's setup-snn step (research/setupSnnStudy.ts) tests whether trades the SNN agreed with did
// better, and switches an SNN filter on only once that is proven.

import fs from 'fs';
import path from 'path';

export class SetupJournal {
  constructor(private readonly dir: string, private readonly onError: (e: unknown) => void = () => {}) {}

  private write(kind: 'signal' | 'trade', rec: Record<string, unknown>): void {
    try {
      const ts = typeof rec.ts === 'number' ? rec.ts : Date.now();
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(path.join(this.dir, `journal-${new Date(ts).toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({ ...rec, type: kind })}\n`);
    } catch (e) { this.onError(e); }
  }

  signal(rec: Record<string, unknown>): void { this.write('signal', rec); }
  trade(rec: Record<string, unknown>): void { this.write('trade', rec); }
}

/** One closed trade joined with the readings at its entry. */
export interface JournalTrade {
  asset: string; lane: string; kind: string; tf: string; dir: number; entryTs: number; exitTs: number; r: number; usd: number; pilot?: boolean;
  tn_up1: number | null; tn_up4: number | null; tn_vol: number | null;
  snn_up1: number | null; snn_up4: number | null; snn_skill1: number | null; snn_skill4: number | null;
}

/** Every closed trade in the journal folder (opened + closed records joined by asset and entry time). */
export function readJournalTrades(dir: string): JournalTrade[] {
  if (!fs.existsSync(dir)) return [];
  const opened = new Map<string, Record<string, unknown>>();
  const out: JournalTrade[] = [];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  for (const f of fs.readdirSync(dir).filter((x) => /^journal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r: Record<string, unknown>;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.type !== 'trade') continue;
      const key = `${r.asset}|${r.entryTs}`;
      if (r.event === 'opened') { opened.set(key, r); continue; }
      if (r.event !== 'closed') continue;
      const o = opened.get(key);
      if (!o || typeof r.r !== 'number') continue;
      opened.delete(key);
      out.push({
        asset: String(r.asset), lane: String(r.lane), kind: String(r.kind), tf: String(r.tf), dir: Number(r.dir), entryTs: Number(r.entryTs), exitTs: Number(r.ts), r: r.r, usd: Number(r.usd ?? 0), pilot: Boolean(o.pilot),
        tn_up1: num(o.tn_up1), tn_up4: num(o.tn_up4), tn_vol: num(o.tn_vol), snn_up1: num(o.snn_up1), snn_up4: num(o.snn_up4), snn_skill1: num(o.snn_skill1), snn_skill4: num(o.snn_skill4),
      });
    }
  }
  return out;
}

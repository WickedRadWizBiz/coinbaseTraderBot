// Refresh the built-in copy of Kalshi's published fee schedule (bot/kalshi/feeScheduleSnapshot.json) from the PDF.
//
// kalshi.com answers the server's own download with its bot check (HTTP 429), so the bot falls back to this copy until
// a read of its own succeeds. When Kalshi publishes a new schedule: save kalshi.com/docs/kalshi-fee-schedule.pdf from a
// browser, then
//   npx tsx scripts/feeScheduleSnapshot.ts ~/Downloads/kalshi-fee-schedule.pdf [--etag '"..."'] [--last-modified '...']
// and commit the JSON (the script refuses a PDF it cannot read the formulas and table from).

import fs from 'fs';
import path from 'path';
import { readPublishedSchedulePdf, tableCheck } from '../bot/kalshi/feeSchedule';

const args = process.argv.slice(2);
const pdf = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
if (!pdf) { console.error('usage: tsx scripts/feeScheduleSnapshot.ts <kalshi-fee-schedule.pdf> [--etag E] [--last-modified L]'); process.exit(2); }
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

const p = readPublishedSchedulePdf(fs.readFileSync(pdf), Date.now());
if ('error' in p) { console.error(`cannot read the schedule: ${p.error}`); process.exit(1); }
const tc = tableCheck(p);
if (!p.effective || tc.rows === 0 || tc.matched < tc.rows || Object.keys(p.nonStandard).length === 0) {
  console.error(`refusing: effective ${p.effective}, table ${tc.matched}/${tc.rows}${tc.firstMiss ? ` (${tc.firstMiss})` : ''}, ${Object.keys(p.nonStandard).length} listed series`);
  process.exit(1);
}
p.etag = opt('--etag') ?? p.etag;
p.lastModified = opt('--last-modified') ?? p.lastModified;
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'bot', 'kalshi', 'feeScheduleSnapshot.json');
fs.writeFileSync(out, JSON.stringify(p, null, 1) + '\n');
console.log(`wrote ${out}: effective ${p.effective}, taker ${p.takerRate}, maker ${p.makerRate}, ${Object.keys(p.nonStandard).length} listed series, table ${tc.matched}/${tc.rows}`);

// Render the TA knowledge library (bot/ta/knowledge.ts) as Markdown: npm run ta:docs
import fs from 'fs';
import path from 'path';
import { CONFLUENCES, KNOWLEDGE, RULES } from '../bot/ta/knowledge';

const tf = (x: string[] | string) => (Array.isArray(x) ? x.join(', ') : x);
let md = `# TA knowledge library\n\nGenerated from \`bot/ta/knowledge.ts\` by \`npm run ta:docs\`. Do not edit by hand.\n\n`;
md += 'Every indicator is computed on closed Coinbase spot USD candles (1m, 5m, 15m, 1h, 4h, 1d) for the asset behind each contract. ';
md += 'Rules and confluences are candidates: the meta-model learns their weight walk-forward (feature groups `ta` and `taconf`), and `npm run research:ta` measures each one\'s forward-return edge with a false-discovery-rate cut.\n\n';
md += '## Indicators\n\n';
for (const k of KNOWLEDGE) {
  md += `### ${k.name}${k.implemented ? '' : ' (documented, not computed)'}\n\n`;
  md += `- **Category:** ${k.category}${k.author ? ` · **Author:** ${k.author}` : ''}\n- **Formula:** \`${k.formula}\`\n- **Parameters:** ${k.params || '—'}\n`;
  md += `- **Best timeframes (reference):** ${tf(k.bestTimeframes)} · **Bot computes on:** ${k.botTimeframes.join(', ') || '—'}\n`;
  md += `- **Evidence:** ${k.evidence.rating}${k.evidence.notes ? ` (${k.evidence.notes})` : ''}\n\n`;
  md += '| When | Meaning | Bias |\n|---|---|---|\n' + k.states.map((s) => `| ${s.when} | ${s.meaning} | ${s.bias} |`).join('\n') + '\n\n';
  if (k.caveats.length) md += '**Caveats:** ' + k.caveats.join(' ') + '\n\n';
  md += '**Sources:**\n' + k.evidence.sources.map((s) => `- ${s}`).join('\n') + '\n\n';
}
md += '## Rules (live signals)\n\n| Rule | Indicator | Kind | Timeframes | Bullish | Bearish / neutral |\n|---|---|---|---|---|---|\n';
md += RULES.map((r) => `| \`${r.id}\` | ${r.indicator} | ${r.kind} | ${r.timeframes.join(', ')} | ${r.bullish || '—'} | ${r.bearish || r.neutral || '—'} |`).join('\n') + '\n\n';
md += '## Confluences\n\n';
for (const c of CONFLUENCES) {
  md += `### ${c.name} (\`${c.id}\`)\n\nSource: ${c.source}. Needs ${c.minAgree} of ${c.members.length} members agreeing${c.required.length ? `, including ${c.required.map((x) => `\`${x}\``).join(', ')}` : ''}.\n\n`;
  md += 'Members: ' + c.members.map((m) => `\`${m.rule}@${m.tf}\``).join(', ') + '\n\n';
  md += `- Bullish: ${c.bullish}\n- Bearish: ${c.bearish}\n\n`;
}
const out = path.resolve('docs/TA_LIBRARY.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, md);
console.log(`wrote ${out}`);

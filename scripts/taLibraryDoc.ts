// Render the TA knowledge library (bot/ta/knowledge.ts) as Markdown: npm run ta:docs
import fs from 'fs';
import path from 'path';
import { CONFLUENCES, KNOWLEDGE, RULES } from '../bot/ta/knowledge';

const tf = (x: string[] | string) => (Array.isArray(x) ? x.join(', ') : x);
// The engine section (TA-Lib first, this library for the rest; bot/ta/talib.ts).
const ENGINE = `## Engine: TA-Lib first, this library for the rest

The core indicators come from **TA-Lib** (https://ta-lib.org, the C library behind ta-lib-python), through the native Node binding in \`vendor/talib\`. It is compiled from TA-Lib's C sources on \`npm ci\`; the published package shipped macOS object files, so it is vendored with those removed. TA-Lib provides:
- ATR, EMA 12/21/26/50, SMA 50/200
- ADX with +DI/-DI
- Bollinger Bands (20, 2)
- RSI (14), MACD (12/26/9)
- Stochastic (14, 3, 3 slow)
- Williams %R, OBV, MFI

Every rule, confluence and model input that reads those reads TA-Lib's values.

**TA-Lib adds** inputs this library didn't have, at every timeframe, for the TA network and the setup scorer (\`bot/ta/talib.ts\`):
- CCI, momentum, the Aroon oscillator, the Ultimate Oscillator, NATR, TRIX, PPO, CMO
- balance of power, distance to the Parabolic SAR, the Hilbert trend-vs-cycle mode
- linear-regression slope, standard deviation, distance to KAMA, the A/D oscillator, Stochastic RSI
- **all 61 candlestick patterns**: summed into bullish / bearish / net scores for the last bar and the last 3 bars, plus 22 well-known patterns as their own inputs (engulfing, hammer, inverted hammer, shooting star, hanging man, the dojis, morning and evening star, three white soldiers, three black crows, harami, piercing, dark cloud cover, marubozu, three inside and outside, belt hold, kicking, abandoned baby, spinning top)

**This library keeps** what TA-Lib doesn't do, as extra nuance:
- market structure (swings, BOS, CHoCH), liquidity sweeps, true breakouts, equal highs and lows, fair-value gaps
- regular and hidden divergences, the continuous OBV divergence
- volume profile with the 80% rule, VWAP, Ichimoku, the Keltner squeeze, Donchian breakouts, Chaikin Money Flow, round numbers
- its own engulfing, pin bar and doji reads
- the knowledge base's rules and confluences

If the native module can't load, everything falls back to this library's own implementations of the core indicators, and the TA-Lib-only inputs read as missing. The TA network and setup model files record the engine they were trained with, and the bot logs a warning on a mismatch. \`TA_ENGINE=builtin\` forces the fallback.

`;
let md = `# TA knowledge library\n\nGenerated from \`bot/ta/knowledge.ts\` by \`npm run ta:docs\`. Do not edit by hand.\n\n`;
md += 'Every indicator is computed on closed Coinbase spot USD candles (1m, 5m, 15m, 1h, 4h, 1d) for the asset behind each contract. ';
md += 'Rules and confluences are candidates: the meta-model learns their weight walk-forward (feature groups `ta` and `taconf`), and `npm run research:ta` measures each one\'s forward-return edge with a false-discovery-rate cut.\n\n';
md += ENGINE;
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

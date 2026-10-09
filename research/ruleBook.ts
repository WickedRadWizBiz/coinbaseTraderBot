// Rule book: every TA rule (knowledge.ts RULES and BOOK_RULES) and confluence tested walk-forward on
// years of hourly history, after costs, by market character (bot/ta/character.ts), with a multiple-
// testing control. Only rules that pass trade (bot/strategy/ruleBook.ts combines them live).
//
// Walk: every `stride` hours of each coin's closed hourly bars, the 1h / 4h / 1d states (closed bars
// only), the breadth across the coins and the traditional risk gauges at that hour, the coin's
// character, and every signal's direction. Each signal is a trade in its direction held for H hours:
//   trade return = dir x log(close[t+H] / close[t]) - round-trip cost
// Per rule x timeframe x horizon x character (and 'all' characters): trades, hit rate, payoff (mean win
// / mean loss), expectancy (bps), and a moving-block bootstrap p-value (blocks cover the overlap of
// consecutive trades).
//
// Pass (discovery = the first `discovery` share of the timeline, confirmation = the rest):
//   discovery    n >= minN, mean > 0, Benjamini-Hochberg pass at q over every test run
//   confirmation n >= minConf, mean > 0, hit rate >= 50 %      (the edge held on later, unseen years)
// A passing row's weight (0..1) grows with its t-statistic on both periods (overlap-adjusted).
//
// The character classifier is scored on the same walk: how often the class at t matches the character
// the next 24 hours actually had (character.ts realisedCharacter), against always guessing the most
// common class.
//
//   npx tsx research/ruleBook.ts --history data/history [--assets BTC,ETH,SOL,XRP,DOGE] [--stride 6]
//                                [--cost-bps 10] [--out data/models/rule_book.json]

import fs from 'fs';
import path from 'path';
import { evaluate, TF_MS, tfState, type MacroInput, type TfState } from '../bot/ta/analyzer';
import { aggregate } from '../bot/ta/candleStore';
import type { Candle } from '../bot/ta/indicators';
import type { Timeframe } from '../bot/ta/knowledge';
import { CHARACTERS, characterOf, realisedCharacter, type Character } from '../bot/ta/character';
import { breadthOf, riskOf, RISK_SERIES, type RiskKey } from '../bot/ta/marketContext';
import { loadIndexSeries } from '../bot/marketdata/historyStore';
import { benjaminiHochberg, blockBootstrap } from './taStudy';
import { loadHistory, storedAssets } from './history/candles';
import type { RuleBookFile, RuleRow } from '../bot/strategy/ruleBook';
import { bestBracket, signed, studyCombos, type Step } from './confluenceBook';
export type { RuleBookFile, RuleRow };

const H = 3_600_000;
export const RULEBOOK_SCHEMA = 'rulebook1';

export interface RuleBookOptions {
  horizons?: number[]; stride?: number; costBps?: number; discovery?: number; minN?: number; minConf?: number; fdr?: number;
  risk?: Partial<Record<RiskKey, Candle[]>>;
  log?: (m: string) => void;
}

type Hist = { h1: Candle[]; d1: Candle[] };

const closedIdx = (cs: Candle[], period: number, t: number) => { let lo = 0, hi = cs.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (cs[m].ts + period <= t) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)); };

interface Obs { ts: number; r: number }

export function runRuleBook(hist: Record<string, Hist>, o: RuleBookOptions = {}): RuleBookFile {
  const horizons = o.horizons ?? [4, 24];
  const stride = o.stride ?? 6, cost = (o.costBps ?? 10) / 1e4, minN = o.minN ?? 50, minConf = o.minConf ?? 20, q = o.fdr ?? 0.1;
  const log = o.log ?? (() => {});
  const assets = Object.keys(hist).filter((a) => hist[a].h1.length > 400);
  const maxH = Math.max(...horizons);
  let t0 = Infinity, t1 = -Infinity;
  for (const a of assets) { t0 = Math.min(t0, hist[a].h1[300].ts); t1 = Math.max(t1, hist[a].h1[hist[a].h1.length - 1].ts); }
  const splitAt = t0 + (o.discovery ?? 0.7) * (t1 - t0);
  const obs = new Map<string, Obs[]>();
  const push = (key: string, x: Obs) => { let l = obs.get(key); if (!l) obs.set(key, (l = [])); l.push(x); };
  const confusion: Record<string, Record<string, number>> = {};
  let charN = 0, charHit = 0;
  const realisedCount: Record<string, number> = {};
  const d1All = assets.map((a) => hist[a].d1);
  // The confluence logbook: every step's set of active signals (research/confluenceBook.ts).
  const keys: string[] = [], keyIdx = new Map<string, number>();
  const keyOf = (k: string) => { let i = keyIdx.get(k); if (i === undefined) { i = keys.length; keys.push(k); keyIdx.set(k, i); } return i; };
  const steps: Step[] = [];
  for (const [ai, asset] of assets.entries()) {
    const { h1, d1 } = hist[asset];
    const others = assets.filter((x) => x !== asset).map((x) => hist[x].h1);
    const h4cache: { j: number; s?: TfState } = { j: -1 };
    const d1cache: { j: number; s?: TfState } = { j: -1 };
    let nSteps = 0;
    for (let i = 300; i + maxH < h1.length; i += stride) {
      const t = h1[i].ts + H;
      // A gap in the hourly series (missing bars) would mislabel the horizon: skip such steps.
      if (h1[i + maxH].ts - h1[i].ts !== maxH * H) continue;
      const states: Partial<Record<Timeframe, TfState>> = {};
      const s1 = tfState('1h', h1.slice(i - 259, i + 1));
      if (s1) states['1h'] = s1;
      const j4 = Math.floor((h1[i].ts + H) / TF_MS['4h']);
      if (h4cache.j !== j4) { h4cache.j = j4; const w = aggregate(h1.slice(Math.max(0, i - 1119), i + 1), TF_MS['4h']).filter((c) => c.ts + TF_MS['4h'] <= t); h4cache.s = w.length >= 30 ? tfState('4h', w) : undefined; }
      if (h4cache.s) states['4h'] = h4cache.s;
      const jd = closedIdx(d1, TF_MS['1d'], t);
      if (jd >= 30 && d1cache.j !== jd) { d1cache.j = jd; d1cache.s = tfState('1d', d1.slice(Math.max(0, jd - 259), jd + 1)); }
      if (jd >= 30 && d1cache.s) states['1d'] = d1cache.s;
      const macro: MacroInput = { asset, breadth: breadthOf(d1All, t), risk: o.risk ? riskOf(o.risk, t) : undefined };
      const snap = evaluate(asset, states, t, macro);
      const dClosed = jd >= 0 ? d1.slice(0, jd + 1) : [];
      const ch = characterOf(h1.slice(i - 159, i + 1), dClosed, others.map((x) => { const k = closedIdx(x, H, t); return k >= 0 ? x.slice(Math.max(0, k - 159), k + 1) : []; }));
      // The classifier against what the next 24 hours did.
      const real = realisedCharacter(h1.slice(i, i + 25), dClosed, others.map((x) => { const k = closedIdx(x, H, t); return k >= 0 ? x.slice(k, k + 25) : []; }));
      (confusion[ch.cls] ??= {})[real] = (confusion[ch.cls]?.[real] ?? 0) + 1;
      realisedCount[real] = (realisedCount[real] ?? 0) + 1;
      charN++; if (real === ch.cls) charHit++;
      const fwd = horizons.map((hh) => Math.log(h1[i + hh].c / h1[i].c));
      const active: number[] = [];
      const record = (id: string, kind: RuleRow['kind'], tf: string, dir: number) => {
        if (!dir) return;
        active.push(signed(keyOf(`${kind}|${id}|${tf}`), dir));
        horizons.forEach((hh, k) => {
          const r = Math.sign(dir) * fwd[k] - cost;
          push(`${kind}|${id}|${tf}|${hh}|${ch.cls}`, { ts: t, r });
          push(`${kind}|${id}|${tf}|${hh}|all`, { ts: t, r });
        });
      };
      for (const s of snap.signals) record(s.id, 'rule', s.tf, s.dir);
      for (const s of snap.book ?? []) record(s.id, 'book', s.tf, s.dir);
      for (const c of snap.confluences) record(c.id, 'confluence', 'multi', Math.sign(c.score));
      if (active.length >= 2) steps.push({ asset: ai, i, t, fwd, active: Int32Array.from(active) });
      nSteps++;
    }
    log(`[rule-book] ${asset}: ${nSteps} steps`);
  }
  // Statistics per key, discovery vs confirmation.
  const rows: RuleRow[] = [];
  for (const [key, list] of obs) {
    const [kind, id, tf, hs, cls] = key.split('|');
    const h = Number(hs);
    const disc = list.filter((x) => x.ts < splitAt).map((x) => x.r), conf = list.filter((x) => x.ts >= splitAt).map((x) => x.r);
    if (disc.length < minN) continue;
    const wins = disc.filter((r) => r > 0), losses = disc.filter((r) => r <= 0);
    const overlap = Math.max(1, h / stride);
    const bs = blockBootstrap(disc, Math.max(2, Math.ceil(2 * overlap)), 1000);
    rows.push({
      id, kind: kind as RuleRow['kind'], tf: tf as RuleRow['tf'], h, cls: cls as RuleRow['cls'],
      n: disc.length, hit: wins.length / disc.length, payoff: losses.length && mean(losses) < 0 ? mean(wins) / -mean(losses) : Infinity,
      expBps: mean(disc) * 1e4, p: bs.p, fdr: false,
      nConf: conf.length, hitConf: conf.length ? conf.filter((r) => r > 0).length / conf.length : NaN, expConfBps: conf.length ? mean(conf) * 1e4 : NaN,
      pass: false, weight: 0,
    });
  }
  const passBh = benjaminiHochberg(rows.map((r) => r.p), q);
  rows.forEach((r, i) => {
    r.fdr = passBh[i];
    r.pass = r.fdr && r.expBps > 0 && r.nConf >= minConf && r.expConfBps > 0 && r.hitConf >= 0.5;
    if (r.pass) {
      const list = obs.get(`${r.kind}|${r.id}|${r.tf}|${r.h}|${r.cls}`)!;
      const overlap = Math.max(1, r.h / stride);
      const tstat = (xs: number[]) => (xs.length > 1 && sd(xs) > 0 ? (mean(xs) / sd(xs)) * Math.sqrt(xs.length / overlap) : 0);
      const tD = tstat(list.filter((x) => x.ts < splitAt).map((x) => x.r)), tC = tstat(list.filter((x) => x.ts >= splitAt).map((x) => x.r));
      r.weight = +Math.max(0, Math.min(1, 0.5 * (tD / 3) + 0.5 * (tC / 2))).toFixed(3);
    }
    r.expBps = +r.expBps.toFixed(2); r.expConfBps = +r.expConfBps.toFixed(2); r.hit = +r.hit.toFixed(4); r.hitConf = +r.hitConf.toFixed(4); r.payoff = +r.payoff.toFixed(3); r.p = +r.p.toFixed(5);
  });
  rows.sort((a, b) => Number(b.pass) - Number(a.pass) || b.weight - a.weight || a.p - b.p);
  const share = Object.fromEntries(CHARACTERS.map((c) => [c, +((realisedCount[c] ?? 0) / Math.max(1, charN)).toFixed(4)]));
  const iso = (x: number) => new Date(x).toISOString().slice(0, 10);
  // Pairs seen together, and a small take-profit / stop-loss grid for the ones that passed.
  const combos = studyCombos(steps, keys, { horizons, splitAt, stride, minN, minConf, fdr: q, costBps: cost * 1e4 });
  for (const c of combos.filter((x) => x.pass)) c.bracket = bestBracket(steps, keys, c.parts, assets.map((a) => hist[a].h1), { splitAt, costBps: cost * 1e4 });
  log(`[rule-book] confluence logbook: ${steps.length} steps with 2+ signals, ${combos.length} pairs logged, ${combos.filter((x) => x.pass).length} passed`);
  return {
    schema: RULEBOOK_SCHEMA, generatedAt: new Date().toISOString(), assets, from: iso(t0), to: iso(t1), splitAt: iso(splitAt), stride, costBps: cost * 1e4, horizons,
    character: { n: charN, accuracy: +(charHit / Math.max(1, charN)).toFixed(4), baseline: Math.max(0, ...Object.values(share)), confusion, share },
    rows, combos,
  };
}

/** History for the study: hourly and daily bars per coin, and the risk gauges' daily bars. */
export function loadRuleBookHistory(dir: string, assets?: string[]): { hist: Record<string, Hist>; risk: Partial<Record<RiskKey, Candle[]>> } {
  const list = assets ?? ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'].filter((a) => storedAssets(dir).includes(a));
  const hist: Record<string, Hist> = {};
  for (const a of list) { const h = loadHistory(dir, a, ['1h', '1d']); if (h['1h']?.length && h['1d']?.length) hist[a] = { h1: h['1h'], d1: h['1d'] }; }
  const risk: Partial<Record<RiskKey, Candle[]>> = {};
  for (const [k, name] of Object.entries(RISK_SERIES) as Array<[RiskKey, string]>) { try { const cs = loadIndexSeries(dir, name, '1d').candles; if (cs.length) risk[k] = cs; } catch { /* absent */ } }
  return { hist, risk };
}

export function ruleBookSummary(f: RuleBookFile): string[] {
  const passed = f.rows.filter((r) => r.pass);
  const out = [`${f.rows.length} rule x timeframe x horizon x character tests on ${f.assets.join(', ')} ${f.from}..${f.to} (confirmation from ${f.splitAt}), cost ${f.costBps} bps: ${passed.length} passed`,
    `character: ${(100 * f.character.accuracy).toFixed(1)} % of next-24h characters called right (most-common-class baseline ${(100 * f.character.baseline).toFixed(1)} %), shares ${JSON.stringify(f.character.share)}`];
  const combos = f.combos ?? [], cp = combos.filter((c) => c.pass);
  out.push(`confluence logbook: ${combos.length} pairs of signals seen together logged, ${cp.length} did better than either alone on both periods`);
  for (const c of cp.slice(0, 15)) out.push(`  PAIR ${c.parts[0]} + ${c.parts[1]} ${c.h}h: n ${c.n}, hit ${(100 * c.hit).toFixed(1)} %, ${c.expBps} bps (lift ${c.liftBps}) | later years n ${c.nConf}, ${c.expConfBps} bps (lift ${c.liftConfBps}) -> weight ${c.weight}${c.bracket ? `; bracket TP ${100 * c.bracket.tp}% / SL ${100 * c.bracket.sl}%: ${c.bracket.expBps} bps, later ${c.bracket.expConfBps} bps${c.bracket.ok ? '' : ' (not confirmed)'}` : ''}`);
  for (const r of passed.slice(0, 25)) out.push(`  PASS ${r.kind} ${r.id} ${r.tf} ${r.h}h [${r.cls}]: n ${r.n}, hit ${(100 * r.hit).toFixed(1)} %, payoff ${r.payoff}, ${r.expBps} bps | later years n ${r.nConf}, hit ${(100 * r.hitConf).toFixed(1)} %, ${r.expConfBps} bps -> weight ${r.weight}`);
  return out;
}

async function main() {
  const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const dir = arg('history', 'data/history');
  const assetsArg = arg('assets', '');
  const { hist, risk } = loadRuleBookHistory(dir, assetsArg ? assetsArg.split(',').map((s) => s.trim().toUpperCase()) : undefined);
  const f = runRuleBook(hist, { stride: Number(arg('stride', '6')), costBps: Number(arg('cost-bps', '10')), risk, log: console.log });
  const out = arg('out', 'data/models/rule_book.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(f));
  for (const l of ruleBookSummary(f)) console.log(l);
  console.log(`wrote ${out}`);
}

if (process.argv[1] && /ruleBook\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });

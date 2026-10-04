// The dashboard's neural map: every network of the bot as a small block of pixels, laid out in the order
// information flows (data feeds -> TA indicator families -> TA network -> SNNs -> decision models -> MLP ->
// traders). Each block carries:
//   cells     values in [-1, 1], one per pixel: live inputs where the block has them (the TA network's own
//             z-scored inputs per family, SNN column firing rates, each market's edge), otherwise a sample
//             of the block's trained weights
//   score     how it is doing, in [-1, 1] (null = no evidence yet): live skill, hit rate, validation, P&L
//   activity  how much it is contributing right now, in [0, 1]
// It is a picture, not a report: the numbers behind it are on the other pages.

import { branchLayout } from '../ta/branchNet';
import { activeTaNet, familyOf, TANET_CTX_FEATURES, TANET_TREND_FEATURES, type TaNetRuntime } from '../ta/taNet';
import type { ApiDeps } from './server';

export interface MapBlock { id: string; label: string; short: string; cols: number; cells: number[]; score: number | null; activity: number; note: string }
export interface MapLayer { id: string; label: string; blocks: MapBlock[] }
export interface NeuralMap { ts: number; layers: MapLayer[]; links: Array<[string, string, number]> }

const H = 3_600_000;
/** Pixels per block (16 x 16); the meta-model gets twice as many (32 x 16). */
const CELLS = 256, COLS = 16;
const clamp = (x: number, a = -1, b = 1) => (Number.isFinite(x) ? Math.max(a, Math.min(b, x)) : 0);
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** n values sampled evenly from a weight array, scaled by its RMS (so every block uses the full palette). */
export function weightTexture(w: ArrayLike<number>, from = 0, len = w.length - from, n = CELLS): number[] {
  if (len <= 0) return new Array(n).fill(0);
  let ss = 0;
  for (let i = 0; i < len; i++) ss += w[from + i] ** 2;
  const rms = Math.sqrt(ss / len) || 1;
  return Array.from({ length: n }, (_, i) => clamp(Math.tanh(w[from + Math.floor((i * len) / n)] / (1.5 * rms))));
}

/** Rows (assets) x columns (inputs) flattened to `n` cells, wrapping or truncating as needed. */
function grid(rows: number[][], n = CELLS): number[] {
  const flat = rows.flat();
  if (!flat.length) return new Array(n).fill(0);
  return Array.from({ length: n }, (_, i) => clamp(flat[i % flat.length]));
}

const FAMILY_ORDER = ['trend', 'momentum', 'volatility', 'volume', 'structure', 'candles', 'confluence', 'market', 'dominance', 'slow', 'timing'];
const FAMILY_LABEL: Record<string, string> = {
  trend: 'Trend', momentum: 'Momentum', volatility: 'Volatility', volume: 'Volume', structure: 'Structure', candles: 'Candles',
  confluence: 'Confluence', market: 'Market', dominance: 'Dominance', slow: 'Slow (TOTAL3/RTY)', timing: 'Timing', other: 'Other',
};

// Hit rate of each family as a direction signal over the network's stored hours (sign of the family's
// mean input vs the next hour's return), recomputed once per new hour.
let famCache: { key: string; hits: Record<string, { hit: number; n: number }> } | undefined;
function familyHits(rt: TaNetRuntime, assets: string[]): Record<string, { hit: number; n: number }> {
  const hist = assets.map((a) => rt.inputHistory(a));
  const key = hist.map((h) => `${h.length}:${h[h.length - 1]?.ts ?? 0}`).join('|');
  if (famCache?.key === key) return famCache.hits;
  const tIdx = new Map<string, number[]>(), cIdx = new Map<string, number[]>();
  TANET_TREND_FEATURES.forEach((f, i) => { const k = familyOf(f); tIdx.set(k, [...(tIdx.get(k) ?? []), i]); });
  TANET_CTX_FEATURES.forEach((f, i) => { const k = familyOf(f); cIdx.set(k, [...(cIdx.get(k) ?? []), i]); });
  const hits: Record<string, { hit: number; n: number }> = {};
  for (const h of hist) {
    const byTs = new Map(h.map((r) => [r.ts, r.close]));
    for (const r of h) {
      const next = byTs.get(r.ts + H);
      if (next === undefined || next === r.close) continue;
      const up = next > r.close;
      for (const fam of new Set([...tIdx.keys(), ...cIdx.keys()])) {
        const vals = [...(tIdx.get(fam) ?? []).map((i) => r.trend[i]), ...(cIdx.get(fam) ?? []).filter((i) => i < r.ctx.length).map((i) => r.ctx[i])].filter((v) => Number.isFinite(v) && v !== 0);
        if (!vals.length) continue;
        const m = mean(vals);
        if (Math.abs(m) < 0.05) continue;
        const s = (hits[fam] ??= { hit: 0, n: 0 });
        s.n++; if ((m > 0) === up) s.hit++;
      }
    }
  }
  famCache = { key, hits };
  return hits;
}

/** Live readings per family from the TA analyzer (used while no TA network is loaded). */
function analyzerReadings(d: ApiDeps): Record<string, number[][]> {
  const out: Record<string, number[][]> = {};
  const now = Date.now();
  for (const set of d.md.features.candles.values()) {
    const snap = set.snapshot(now, { usdtdChg: undefined, btcdChg: undefined });
    const row: Record<string, number[]> = {};
    for (const s of Object.values(snap.tf)) {
      if (!s) continue;
      const push = (fam: string, ...v: Array<number | undefined>) => { for (const x of v) if (x !== undefined) (row[fam] ??= []).push(clamp(x)); };
      const px = s.close;
      push('trend', s.trend === 'up' ? 1 : s.trend === 'down' ? -1 : 0, num(s.ema50) && px ? (px / s.ema50! - 1) * 20 : undefined, num(s.adx) !== undefined ? (s.adx! - 20) / 30 : undefined);
      push('momentum', num(s.rsi) !== undefined ? (s.rsi! - 50) / 25 : undefined, num(s.stochK) !== undefined ? (s.stochK! - 50) / 50 : undefined, num(s.macdHist) !== undefined && px ? Math.tanh((s.macdHist! / px) * 500) : undefined);
      push('volatility', num(s.bbPctB) !== undefined ? (s.bbPctB! - 0.5) * 2 : undefined, s.squeeze ? 1 : -0.3, num(s.atrPct) !== undefined ? Math.tanh(s.atrPct! * 50) : undefined);
      push('volume', num(s.cmf) !== undefined ? s.cmf! * 3 : undefined, num(s.mfi) !== undefined ? (s.mfi! - 50) / 40 : undefined, num(s.obvSlope) !== undefined ? Math.tanh(s.obvSlope!) : undefined);
      push('structure', s.bos, s.choch, s.sweep, s.breakout);
      const tl = (s as { tl?: Record<string, number> }).tl;
      if (tl) push('candles', num(tl.cdl_net) !== undefined ? tl.cdl_net / 2 : undefined, num(tl.cdl_bull) !== undefined ? tl.cdl_bull / 2 : undefined, num(tl.cdl_bear) !== undefined ? -tl.cdl_bear / 2 : undefined);
    }
    row.confluence = [clamp((snap.net ?? 0) / 5), ...snap.confluences.slice(0, 6).map((c) => clamp(c.score / 3))];
    for (const [k, v] of Object.entries(row)) (out[k] ??= []).push(v);
  }
  return out;
}

function taBlocks(rt: TaNetRuntime | undefined, d: ApiDeps): { families: MapBlock[]; net: MapBlock[] } {
  const assets = [...d.md.features.candles.keys()];
  const families: MapBlock[] = [];
  const live = rt ? assets.map((a) => rt.latestInputs(a)).filter((x): x is NonNullable<typeof x> => !!x) : [];
  const hits = rt ? familyHits(rt, assets) : {};
  const fallback = live.length ? {} : analyzerReadings(d);
  const p = rt?.net.params;
  const outs = rt ? assets.map((a) => rt.outputFor(a, d.md.features.candles.get(a)!, Date.now())).filter((o): o is NonNullable<typeof o> => !!o) : [];
  const attention: Record<string, number[]> = {};
  for (const o of outs) for (const [k, v] of Object.entries(o.families ?? {})) (attention[k] ??= []).push(v);
  for (const fam of FAMILY_ORDER) {
    const tI = TANET_TREND_FEATURES.map((f, i) => (familyOf(f) === fam ? i : -1)).filter((i) => i >= 0);
    const cI = TANET_CTX_FEATURES.map((f, i) => (familyOf(f) === fam ? i : -1)).filter((i) => i >= 0);
    let rows: number[][] = live.map((x) => [...tI.map((i) => x.trend[i]), ...cI.filter((i) => i < x.ctx.length).map((i) => x.ctx[i])].map((z) => Math.tanh(z / 2)));
    if (!rows.some((r) => r.length)) rows = fallback[fam] ?? [];
    const flat = rows.flat();
    const h = hits[fam];
    const att = attention[fam]?.length ? mean(attention[fam]) : undefined;
    const nFam = Object.keys(attention).length || 1;
    families.push({
      id: `fam_${fam}`, label: FAMILY_LABEL[fam] ?? fam, short: fam.slice(0, 4).toUpperCase(), cols: COLS, cells: grid(rows),
      score: h && h.n >= 30 ? clamp((h.hit / h.n - 0.5) * 8) : null,
      activity: att !== undefined ? clamp(att * nFam, 0, 1) : flat.length ? clamp(mean(flat.map(Math.abs)) * 1.5, 0, 1) : 0,
      note: `${tI.length + cI.length} network inputs${h ? ` · next-hour hit rate ${(100 * h.hit / Math.max(1, h.n)).toFixed(1)}% over ${h.n}` : ''}${att !== undefined ? ` · attention ${(att * 100).toFixed(1)}%` : ''}${live.length ? '' : ' · analyzer readings (TA network not loaded)'}`,
    });
  }
  const net: MapBlock[] = [];
  if (!rt || !p) {
    net.push({ id: 'ta_net', label: 'TA network', short: 'TANET', cols: COLS, cells: new Array(CELLS).fill(0), score: null, activity: 0, note: 'not loaded (waiting for a model for this build)' });
    return { families, net };
  }
  const { layout } = branchLayout(p.dims);
  const w = p.weights;
  const skill = mean(outs.map((o) => o.skill[60]).filter((x): x is number => Number.isFinite(x)));
  const conviction = outs.length ? clamp(mean(outs.map((o) => Math.abs((o.up[60] ?? 0.5) - 0.5) * 4)), 0, 1) : 0;
  const gates = p.gates as unknown as Record<string, number>;
  const block = (id: string, label: string, short: string, parts: string[], gate?: number) => {
    const segs = parts.filter((k) => layout[k]);
    const total = segs.reduce((a, k) => a + layout[k].n, 0);
    const cells: number[] = [];
    for (const k of segs) cells.push(...weightTexture(w, layout[k].off, layout[k].n, Math.max(1, Math.round((CELLS * layout[k].n) / Math.max(1, total)))));
    net.push({ id, label, short, cols: COLS, cells: grid([cells]), score: Number.isFinite(skill) ? clamp(skill * 6) : null, activity: clamp(conviction * (gate ?? 1), 0, 1), note: `${total} weights${gate !== undefined ? ` · gate ${gate.toFixed(2)}` : ''}` });
  };
  block('ta_micro', 'Micro CNN (15m)', 'MICRO', ['Wpm', 'Fm'], gates.micro);
  block('ta_swing', 'Swing CNN', 'SWING', ['Wps', 'Fs'], gates.swing);
  if (p.dims.fam) block('ta_fam', 'Family attention', 'FAM', ['Wft', 'Wfc', 'Vg']);
  block('ta_trend', 'Trend GRU', 'GRU', ['Wz', 'Wr', 'Wh', 'Uz', 'Ur', 'Uh'], gates.trend);
  block('ta_daily', 'Daily attention', 'DAILY', ['We', 'Wq', 'Wk'], gates.macro);
  block('ta_ctx', 'Context', 'CTX', ['Wc'], gates.ctx);
  block('ta_head', 'Merge + heads', 'HEADS', ['W1', 'W2']);
  return { families, net };
}

function snnBlocks(snn: any): MapBlock[] {
  const out: MapBlock[] = [];
  for (const dom of ['crypto', 'perps', 'tennis']) {
    const u = snn?.units?.[dom];
    const cols: any[] = u?.network?.columns ?? u?.network?.network?.columns ?? [];
    if (!u) { out.push({ id: `snn_${dom}`, label: `SNN ${dom}`, short: dom.slice(0, 4).toUpperCase(), cols: COLS, cells: new Array(CELLS).fill(0), score: null, activity: 0, note: 'off' }); continue; }
    const rows = cols.slice(0, 8).map((c) => [
      Math.tanh((c.rates?.L0 ?? 0) * 20), Math.tanh((c.rates?.L1 ?? 0) * 20), Math.tanh((c.rates?.E ?? 0) * 20), -Math.tanh((c.rates?.I ?? 0) * 20),
      clamp((c.G ?? 0) * 2 - 1), clamp(c.surprise ?? 0), clamp((c.errZ ?? 0) / 3), clamp(((c.direction?.pUp ?? 0.5) - 0.5) * 4),
    ]);
    const briers = cols.map((c) => c.readout?.brier ?? c.direction?.brier).filter((b: unknown): b is number => typeof b === 'number');
    const skill = briers.length ? 1 - mean(briers) / 0.25 : NaN;
    out.push({
      id: `snn_${dom}`, label: `SNN ${dom}`, short: dom.slice(0, 4).toUpperCase(), cols: COLS, cells: grid(rows),
      score: Number.isFinite(skill) ? clamp(skill * 6) : null,
      activity: cols.length ? clamp(mean(cols.map((c) => c.rates?.E ?? 0)) * 25, 0, 1) : 0,
      note: `${u.stage ?? ''} · ${cols.length} columns${u.shadow ? ' · shadow' : ''}${Number.isFinite(skill) ? ` · skill ${(skill * 100).toFixed(1)}%` : ''}`,
    });
  }
  return out;
}

/** A fixed pattern from a string (blocks without live numbers or readable weights still look like themselves). */
function seeded(key: string, n = CELLS, amp = 0.6): number[] {
  let s = 2166136261;
  for (const ch of key) s = Math.imul(s ^ ch.charCodeAt(0), 16777619) >>> 0;
  return Array.from({ length: n }, () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return ((s / 4294967296) * 2 - 1) * amp; });
}

const modelScore = (present: boolean, validated: boolean | undefined) => (!present ? null : validated ? 0.6 : -0.4);

export async function buildNeuralMap(d: ApiDeps): Promise<NeuralMap> {
  const now = Date.now();
  const e = d.engine;
  const markets = [...e.status.values()];
  const perps = e.perpStatus(now);
  const trees = e.treeModelStatus();
  const snn = await e.snnStatus().catch(() => ({ mode: 'off' }));
  const rt = activeTaNet();
  const ta = taBlocks(rt, d);
  const trading: any = perps.trading ?? {};

  // Feeds.
  const candleAssets = [...d.md.features.candles.values()];
  const spotRows = candleAssets.map((set) => { const snap = set.snapshot(now, { usdtdChg: undefined, btcdChg: undefined }); return Object.values(snap.tf).filter(Boolean).map((s) => (s!.ema21 && s!.close ? Math.tanh((s!.close / s!.ema21 - 1) * 40) : 0)); });
  const dom = (d.md as any).usdtd?.fresh?.(now, 10_000);
  const feeds: MapBlock[] = [
    { id: 'feed_spot', label: 'Spot candles', short: 'SPOT', cols: COLS, cells: grid(spotRows), score: candleAssets.length ? 0.5 : -1, activity: candleAssets.length ? 0.8 : 0, note: `${candleAssets.length} assets` },
    { id: 'feed_kalshi', label: 'Kalshi books', short: 'KLSH', cols: COLS, cells: grid([markets.map((m) => (m.bestBid !== undefined && m.bestAsk !== undefined ? (m.bestBid + m.bestAsk) - 1 : 0))]), score: d.md.wsConnected ? 0.5 : -1, activity: d.md.wsConnected ? clamp(markets.length / 20, 0.2, 1) : 0, note: `${markets.length} markets · websocket ${d.md.wsConnected ? 'up' : 'down'}` },
    { id: 'feed_dom', label: 'Dominance feed', short: 'DOM', cols: COLS, cells: seeded(`dom${Math.floor(now / 60_000)}`, CELLS, dom ? 0.7 : 0.1), score: dom ? 0.5 : null, activity: dom ? 0.6 : 0, note: dom ? 'USDT.D / BTC.D live' : 'no live dominance' },
    { id: 'feed_perps', label: 'Perps feed', short: 'PERP', cols: COLS, cells: grid([perps.markets.map((m: any) => clamp((m.premiumBps ?? 0) / 20)), perps.markets.map((m: any) => clamp((m.fundingRate ?? 0) * 2000))]), score: perps.feed ? (perps.feed.ok ? 0.5 : -1) : null, activity: perps.feed?.ok ? 0.6 : 0, note: perps.feed ? (perps.feed.ok ? `${perps.markets.length} markets` : `error: ${perps.feed.lastError}`) : 'off' },
    { id: 'feed_tennis', label: 'Tennis scores', short: 'TENN', cols: COLS, cells: grid([[...e.tennisStatus.values()].map((m: any) => clamp(((m.pA ?? m.pModel ?? 0.5) - 0.5) * 4))]), score: d.cfg.tennis.enabled ? 0.3 : null, activity: d.cfg.tennis.enabled ? clamp(e.tennisStatus.size / 6, 0.1, 1) : 0, note: d.cfg.tennis.enabled ? `${e.tennisStatus.size} matches` : 'off' },
  ];

  // Decision models next to the MLP.
  const sm = trading.model;
  const decision: MapBlock[] = [
    { id: 'dm_setup', label: 'Setup scorer (GBDT)', short: 'SETUP', cols: COLS, cells: seeded(`setup${sm?.version ?? ''}`, CELLS, sm ? 0.8 : 0.1), score: modelScore(!!sm, sm?.fast?.validated || sm?.slow?.validated), activity: sm ? clamp(((trading.lanes?.fast?.queue?.length ?? 0) + (trading.lanes?.slow?.queue?.length ?? 0)) / 6, 0.15, 1) : 0, note: sm ? `${sm.version}${trading.inputs?.taNetFeatures ? ' · reads the TA network' : ''}` : (trading.modelError ?? 'no model') },
    { id: 'dm_vol', label: 'Vol forecast', short: 'VOL', cols: COLS, cells: seeded(`vol${trees.volModel?.version ?? ''}`, CELLS, trees.volModel ? 0.7 : 0.1), score: modelScore(!!trees.volModel, trees.volModel?.validated), activity: trees.volModel?.applied ? 0.7 : 0.1, note: trees.volModel ? `${trees.volModel.version}${trees.volModel.applied ? ' · applied' : ''}` : 'no model' },
    { id: 'dm_fill', label: 'Fill model', short: 'FILL', cols: COLS, cells: seeded(`fill${trees.fill?.version ?? ''}`, CELLS, trees.fill ? 0.7 : 0.1), score: modelScore(!!trees.fill, trees.fill?.validated), activity: trees.fill?.active ? 0.7 : 0.1, note: trees.fill ? `${trees.fill.fills ?? 0} fills / ${trees.fill.quotes ?? 0} quotes` : 'self-activates once enough fills are recorded' },
  ];

  // The MLP meta-model (Kalshi contracts).
  const mp = e.model.params;
  const mlpW = (mp.layers ?? []).flatMap((l) => l.weights.flat());
  const v = mp.validation as any;
  const mlpScore = v && num(v.brierModel) !== undefined && num(v.brierMarket) ? clamp(((v.brierMarket - v.brierModel) / v.brierMarket) * 20) : null;
  const shift = markets.map((m: any) => Math.abs(m.modelShift ?? 0)).filter((x) => x > 0);
  const blend = (snn as any).blender;
  const mlp: MapBlock = {
    id: 'mlp', label: mp.kind === 'identity' ? 'MLP (fair value only)' : `MLP meta-model (${mp.kind})`, short: 'MLP', cols: 2 * COLS,
    cells: mlpW.length ? weightTexture(mlpW, 0, mlpW.length, 2 * CELLS) : grid([markets.map((m: any) => clamp(((m.pYes ?? 0.5) - (m.fairValue ?? 0.5)) * 10))], 2 * CELLS),
    score: mlpScore, activity: shift.length ? clamp(mean(shift) * 5, 0.1, 1) : mp.kind === 'identity' ? 0.1 : 0.3,
    note: `${mp.version} · ${mp.features.length} features${blend?.alpha !== undefined ? ` · SNN blend ${(blend.alpha * 100).toFixed(0)}%` : ''}${v ? ` · Brier ${num(v.brierModel)?.toFixed(4) ?? '—'} vs market ${num(v.brierMarket)?.toFixed(4) ?? '—'}` : ' · not validated'}`,
  };

  // Traders (the bot as a whole).
  const open = [...d.oms.positions.unsettled()];
  const dayPnl = e.dailyPnl(), lossLim = e.dailyLossLimit();
  const setupOpen = [...(trading.lanes?.fast?.open ?? []), ...(trading.lanes?.slow?.open ?? [])];
  const bots: MapBlock[] = [
    { id: 'bot_kalshi', label: 'Kalshi trader', short: 'KALSHI', cols: COLS, cells: grid([markets.map((m: any) => clamp(((m.pYes ?? 0.5) - ((m.bestBid ?? 0.5) + (m.bestAsk ?? 0.5)) / 2) * 8))]), score: lossLim ? clamp(dayPnl / lossLim) : null, activity: clamp(open.length / 5, 0.1, 1), note: `${open.length} open positions · today ${dayPnl >= 0 ? '+' : ''}$${dayPnl.toFixed(2)}` },
    { id: 'bot_setups', label: 'Perps setup trader', short: 'SETUPS', cols: COLS, cells: grid([setupOpen.map((t: any) => clamp((t.open_r ?? 0) / 2))]), score: trading.today?.goalUsd ? clamp((trading.today.realizedUsd ?? 0) / trading.today.goalUsd) : null, activity: clamp(setupOpen.length / 3, 0.05, 1), note: trading.strategy === 'setups' ? `${setupOpen.length} open · today $${(trading.today?.realizedUsd ?? 0).toFixed(2)}` : `mode ${trading.mode ?? 'off'}` },
  ];
  if (d.cfg.tennis.enabled) bots.push({ id: 'bot_tennis', label: 'Tennis trader', short: 'TENNIS', cols: COLS, cells: grid([[...e.tennisStatus.values()].map((m: any) => clamp((m.edge ?? 0) * 8))]), score: null, activity: clamp(e.tennisStatus.size / 6, 0.05, 1), note: `${e.tennisStatus.size} matches` });

  const layers: MapLayer[] = [
    { id: 'feeds', label: 'Data feeds', blocks: feeds },
    { id: 'families', label: 'TA indicator families', blocks: ta.families },
    { id: 'tanet', label: 'TA network', blocks: ta.net },
    { id: 'snn', label: 'Spiking networks', blocks: snnBlocks(snn) },
    { id: 'models', label: 'Decision models', blocks: decision },
    { id: 'mlp', label: 'Meta-model', blocks: [mlp] },
    { id: 'bots', label: 'Traders', blocks: bots },
  ];

  // Links: who feeds whom (strength = the source's activity).
  const act = new Map(layers.flatMap((l) => l.blocks).map((b) => [b.id, b.activity]));
  const links: Array<[string, string, number]> = [];
  const link = (a: string, b: string) => { if (act.has(a) && act.has(b)) links.push([a, b, +(act.get(a)! as number).toFixed(3)]); };
  for (const f of ta.families) {
    const fam = f.id.slice(4);
    link(['market', 'slow', 'timing'].includes(fam) ? 'feed_spot' : fam === 'dominance' ? 'feed_dom' : 'feed_spot', f.id);
    for (const n of ta.net) link(f.id, n.id);
  }
  for (const n of ta.net) { link(n.id, 'dm_setup'); link(n.id, 'dm_vol'); }
  link('feed_kalshi', 'snn_crypto'); link('feed_spot', 'snn_crypto'); link('feed_perps', 'snn_perps'); link('feed_tennis', 'snn_tennis');
  link('snn_crypto', 'mlp'); link('snn_perps', 'dm_setup'); link('snn_tennis', 'bot_tennis');
  link('feed_kalshi', 'dm_fill'); link('dm_vol', 'mlp'); link('dm_fill', 'mlp');
  link('mlp', 'bot_kalshi'); link('dm_setup', 'bot_setups');
  for (const L of layers) for (const b of L.blocks) b.cells = b.cells.map((x) => Math.round(x * 100) / 100);
  return { ts: now, layers, links };
}

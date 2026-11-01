// Can a deep-history day stand in for a real recorded Kalshi day? (Steven, Nov 1: "its methodology has to be identical
// or at least indistinguishable from the real Kalshi contracts ... judge against real days with its own adversarial
// evaluator".)
//
// research/replayFidelity.ts tests one piece: it cuts a recorded day down to minute quotes and fills them back in, but
// keeps the recording's own index, contract list and settlement. A deep-history day has none of those: its index is
// Binance 1-minute bars bridged to 15 s prints and scaled by a basis, its quotes are Kalshi's public minute candles,
// its results come from Kalshi's API. This builds the deep-history twin of each recorded day with exactly the pipeline
// the deep history uses (research/kalshiReplayData.ts: Binance + Kalshi public history, requote; then the tally's
// fill-in), and judges the twin against the real day three ways:
//
//   1. paired mechanics   the same contract both ways: the twin's minute quote against the real book's mid at that
//                         minute, the twin's index against the real index, result agreement, contracts missing.
//   2. discriminator      the adversary. Each contract's life becomes a row of what the bot sees (spread, top size,
//                         depth, quote changes, 15 s mid moves, how the mid follows the index, trades, calibration);
//                         a logistic classifier, trained leaving one day out, tries to tell twin rows from real rows.
//                         AUC 0.5 = indistinguishable. Each feature's own AUC names what gives the twin away.
//   3. outcome            the decision model's backtest on the real days (restricted to the twin's contracts, so both
//                         trade the same universe) against the twin, window by window, beside a placebo: the real days
//                         again at +250 ms latency, the noise floor a difference must clear to mean anything.
//
// Pre-registered pass (all must hold, on days the depth model never saw): discriminator AUC <= 0.60; the twin's mean
// per-window P&L difference has a 95% bootstrap interval that contains 0; its per-window error <= 1.5x the placebo's;
// windows traded within 10% of real.
//
//   npm run research:history-twin -- --stage match --real data/recordings --twin data/history-replay --days 2026-10-28,... --out data/twin
//   ... --stage features --dirs real=data/twin/real,requote=data/twin/requote,depth=data/twin/depth --days ... --out data/twin
//   ... --stage backtest --dir data/twin/real --name real [--latency-ms 250] --days ... --out data/twin
//   ... --stage verdict --out data/twin   (reads features-*.json and windows-*.json)
//
// Prints counts, cents and $ only (the repository is public).

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { OrderBook } from '../bot/marketdata/orderBook';
import { recordingLines } from '../bot/marketdata/recordingFiles';

const MIN = 60_000, SLOT = 15_000;
const logit = (p: number) => { const q = Math.min(0.995, Math.max(0.005, p)); return Math.log(q / (1 - q)); };
const is15m = (series: string | undefined, ticker: string) => /15M/.test(series ?? '') || /15M-/.test(ticker);
const dayFile = (dir: string, day: string) => ['.jsonl.gz', '.jsonl'].map((x) => path.join(dir, `md-${day}${x}`)).find((f) => fs.existsSync(f));
const arg = (k: string, d = ''): string => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };

async function* events(file: string): AsyncGenerator<Record<string, any>> {
  for await (const line of recordingLines(file)) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch { /* a cut line */ }
  }
}

async function writeGz(file: string, lines: AsyncIterable<string>): Promise<void> {
  const gz = zlib.createGzip({ level: 1 });
  const done = new Promise<void>((ok, fail) => gz.pipe(fs.createWriteStream(file)).on('finish', ok).on('error', fail));
  for await (const s of lines) if (!gz.write(s)) await new Promise<void>((ok) => gz.once('drain', ok));
  gz.end();
  await done;
}

/** The tickers a day file lists (market records), with their series. */
async function tickersOf(file: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for await (const e of events(file)) if (e.k === 'market' && e.ticker) out.set(e.ticker, e.series ?? '');
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Stage match: the real days restricted to the contracts the twin has (same universe for the backtests), and the
// paired mechanics.

export interface Paired { day: string; realContracts: number; twinContracts: number; both: number; onlyReal15m: number; onlyTwin: number; quoteN: number; quoteMaeC: number; quoteBiasC: number; spreadRealC: number; spreadTwinC: number; indexN: number; indexMaeBps: number; indexBiasBps: number; results: number; resultsAgree: number }

/** The real day with every contract the twin lacks taken out (its market, book, delta, trade, result records; alive
 *  marks keep only the twin's tickers). */
async function restrictDay(src: string, dst: string, keep: Set<string>): Promise<void> {
  async function* lines(): AsyncGenerator<string> {
    for await (const line of recordingLines(src)) {
      if (!line) continue;
      if (line.includes('"ticker"') || line.includes('"tickers"')) {
        let e: Record<string, any>;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.ticker && !keep.has(e.ticker)) continue;
        if (Array.isArray(e.tickers)) { e.tickers = e.tickers.filter((t: string) => keep.has(t)); if (!e.tickers.length) continue; yield JSON.stringify(e) + '\n'; continue; }
      }
      yield line + '\n';
    }
  }
  await writeGz(dst, lines());
}

/** Per contract both ways at each minute mark: the twin's candle quote against the real book there; per asset the
 *  index at each 15 s print; the results. */
async function pairDay(day: string, realFile: string, twinFile: string, realT: Map<string, string>, twinT: Map<string, string>): Promise<Paired> {
  const both = [...twinT.keys()].filter((t) => realT.has(t));
  const bothSet = new Set(both);
  // The real side: book mid and spread at each minute mark, index at each 15 s slot.
  const realQ = new Map<string, { mid: number; spread: number }>(), realIx = new Map<string, number>(), realRes = new Map<string, string>();
  const books = new Map<string, OrderBook>(), lastIx = new Map<string, number>();
  let mark = -1;
  const reach = (t: number) => {
    const s = Math.floor(t / SLOT);
    if (mark < 0) { mark = s; return; }
    for (; mark < s; mark++) {
      const at = (mark + 1) * SLOT;
      for (const [a, v] of lastIx) realIx.set(`${a}|${at}`, v);
      if (at % MIN === 0) for (const [tk, b] of books) {
        const bb = b.bestBid()?.price, ba = b.bestAsk()?.price;
        if (bb !== undefined && ba !== undefined && ba > bb) realQ.set(`${tk}|${at}`, { mid: (bb + ba) / 2, spread: ba - bb });
      }
    }
  };
  for await (const e of events(realFile)) {
    reach(e.t);
    if (e.k === 'book' && bothSet.has(e.ticker)) { const b = books.get(e.ticker) ?? new OrderBook(e.ticker); books.set(e.ticker, b); b.applySnapshot({ bids: e.bids ?? [], asks: e.asks ?? [] }, e.t); }
    else if (e.k === 'delta' && bothSet.has(e.ticker)) { const b = books.get(e.ticker) ?? new OrderBook(e.ticker); books.set(e.ticker, b); b.applyDelta(e.side, e.price, e.delta, e.t); }
    else if (e.k === 'index' && e.asset && e.value > 0) lastIx.set(e.asset, e.value);
    else if (e.k === 'result' && e.ticker && e.result) realRes.set(e.ticker, String(e.result));
  }
  const p: Paired = { day, realContracts: realT.size, twinContracts: twinT.size, both: both.length, onlyReal15m: [...realT].filter(([t, s]) => is15m(s, t) && !twinT.has(t)).length, onlyTwin: [...twinT.keys()].filter((t) => !realT.has(t)).length, quoteN: 0, quoteMaeC: 0, quoteBiasC: 0, spreadRealC: 0, spreadTwinC: 0, indexN: 0, indexMaeBps: 0, indexBiasBps: 0, results: 0, resultsAgree: 0 };
  for await (const e of events(twinFile)) {
    if (e.k === 'book' && bothSet.has(e.ticker) && e.t % MIN === 0 && e.bids?.[0] && e.asks?.[0]) {
      const r = realQ.get(`${e.ticker}|${e.t}`);
      if (r === undefined) continue;
      const realMid = r.mid, rSpread = r.spread, tMid = (e.bids[0].price + e.asks[0].price) / 2;
      p.quoteN++; p.quoteMaeC += Math.abs(tMid - realMid) * 100; p.quoteBiasC += (tMid - realMid) * 100;
      p.spreadRealC += rSpread * 100; p.spreadTwinC += (e.asks[0].price - e.bids[0].price) * 100;
    } else if (e.k === 'index' && e.asset && e.value > 0 && e.t % SLOT === 0) {
      const r = realIx.get(`${e.asset}|${e.t}`);
      if (r === undefined) continue;
      const bps = (e.value / r - 1) * 1e4;
      p.indexN++; p.indexMaeBps += Math.abs(bps); p.indexBiasBps += bps;
    } else if (e.k === 'result' && bothSet.has(e.ticker) && realRes.has(e.ticker)) {
      p.results++; if (String(e.result) === realRes.get(e.ticker)) p.resultsAgree++;
    }
  }
  if (p.quoteN) { p.quoteMaeC /= p.quoteN; p.quoteBiasC /= p.quoteN; p.spreadRealC /= p.quoteN; p.spreadTwinC /= p.quoteN; }
  if (p.indexN) { p.indexMaeBps /= p.indexN; p.indexBiasBps /= p.indexN; }
  return p;
}

async function stageMatch(): Promise<void> {
  const realDir = arg('real', 'data/recordings'), twinDir = arg('twin', 'data/history-replay'), out = arg('out', 'data/twin');
  const days = arg('days').split(',').filter(Boolean);
  fs.mkdirSync(path.join(out, 'real'), { recursive: true });
  fs.mkdirSync(path.join(out, 'requote'), { recursive: true });
  const paired: Paired[] = [];
  for (const day of days) {
    const rf = dayFile(realDir, day), tf = dayFile(twinDir, day);
    if (!rf || !tf) { console.log(`[twin] ${day}: ${rf ? '' : 'no real recording '}${tf ? '' : 'no history twin'}; left out`); continue; }
    const realT = await tickersOf(rf), twinT = await tickersOf(tf);
    // Contracts open at midnight are listed the day before: keep every twin ticker of this day and the day before.
    const keep = new Set(twinT.keys());
    const prev = dayFile(twinDir, new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10));
    if (prev) for (const t of (await tickersOf(prev)).keys()) keep.add(t);
    await restrictDay(rf, path.join(out, 'real', `md-${day}.jsonl.gz`), keep);
    fs.copyFileSync(tf, path.join(out, 'requote', path.basename(tf)));
    const p = await pairDay(day, rf, tf, realT, twinT);
    paired.push(p);
    console.log(`[twin] ${day}: contracts real ${p.realContracts} / twin ${p.twinContracts} / both ${p.both} (real 15m missing from the twin ${p.onlyReal15m}, twin-only ${p.onlyTwin}); minute quote vs real mid: ${p.quoteN} pts, off ${p.quoteMaeC.toFixed(2)}c (bias ${p.quoteBiasC.toFixed(2)}c), spread real ${p.spreadRealC.toFixed(2)}c twin ${p.spreadTwinC.toFixed(2)}c; index ${p.indexN} pts off ${p.indexMaeBps.toFixed(1)} bps (bias ${p.indexBiasBps.toFixed(1)}); results agree ${p.resultsAgree}/${p.results}`);
  }
  fs.writeFileSync(path.join(out, 'paired.json'), JSON.stringify(paired, null, 1));
}

// ---------------------------------------------------------------------------------------------------------------
// Stage features: one row per contract life, what the bot sees, sampled at the 15 s prints both sources share.

export const FEATURES = ['spreadC', 'topSize', 'depth10', 'quotedShare', 'quoteChangesPerMin', 'midMoveSd', 'minuteJumpShare', 'followIx', 'followIxLag', 'tradesPerMin', 'tradeSize', 'ixMoveBps', 'brierT5'] as const;
export type Row = { day: string; ticker: string; src: string; f: number[] };

const corr = (a: number[], b: number[]) => {
  const n = a.length; if (n < 5) return 0;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
};

interface Life { ticker: string; asset: string; open: number; close: number; book: OrderBook; changes: number; lastTop: string; slots: Array<{ t: number; mid?: number; spread?: number; top?: number; depth?: number; ix?: number }>; trades: number; size: number }

export async function dayRows(file: string, day: string, src: string, results: ReadonlyMap<string, string>, keep?: ReadonlySet<string>): Promise<Row[]> {
  const lives = new Map<string, Life>(), ix = new Map<string, number>();
  const d0 = Date.parse(`${day}T00:00:00Z`), d1 = d0 + 86_400_000;
  let slot = -1;
  const sample = (at: number) => {
    for (const l of lives.values()) {
      if (at < l.open || at > l.close) continue;
      const b = l.book.bestBid(), a = l.book.bestAsk();
      const ok = b && a && a.price > b.price;
      let depth = 0;
      if (ok) { const s = l.book.snapshot(10); for (const x of s.bids ?? []) if (b!.price - x.price <= 0.1 + 1e-9) depth += x.size; for (const x of s.asks ?? []) if (x.price - a!.price <= 0.1 + 1e-9) depth += x.size; }
      l.slots.push({ t: at, mid: ok ? (b!.price + a!.price) / 2 : undefined, spread: ok ? a!.price - b!.price : undefined, top: ok ? b!.size + a!.size : undefined, depth: ok ? depth : undefined, ix: ix.get(l.asset) });
    }
  };
  const reach = (t: number) => { const s = Math.floor(t / SLOT); if (slot < 0) slot = s; for (; slot < s; slot++) sample((slot + 1) * SLOT); };
  const touch = (l: Life) => { const b = l.book.bestBid(), a = l.book.bestAsk(); const k = `${b?.price}|${a?.price}`; if (k !== l.lastTop) { l.changes++; l.lastTop = k; } };
  for await (const e of events(file)) {
    reach(e.t);
    if (e.k === 'market' && e.ticker && is15m(e.series, e.ticker) && (!keep || keep.has(e.ticker))) {
      if (!lives.has(e.ticker)) lives.set(e.ticker, { ticker: e.ticker, asset: e.asset, open: e.openTime, close: e.closeTime, book: new OrderBook(e.ticker), changes: 0, lastTop: '', slots: [], trades: 0, size: 0 });
    } else if (e.k === 'book' && lives.has(e.ticker)) { const l = lives.get(e.ticker)!; l.book.applySnapshot({ bids: e.bids ?? [], asks: e.asks ?? [] }, e.t); touch(l); }
    else if (e.k === 'delta' && lives.has(e.ticker)) { const l = lives.get(e.ticker)!; l.book.applyDelta(e.side, e.price, e.delta, e.t); touch(l); }
    else if (e.k === 'trade' && lives.has(e.ticker)) { const l = lives.get(e.ticker)!; l.trades++; l.size += e.count ?? 0; }
    else if (e.k === 'index' && e.asset && e.value > 0) ix.set(e.asset, e.value);
  }
  const rows: Row[] = [];
  for (const l of lives.values()) {
    // Only contracts that close on this day and lived through it (the day before warms the books).
    if (l.close <= d0 || l.close > d1 || l.open < d0) continue;
    const q = l.slots.filter((s) => s.mid !== undefined);
    if (q.length < 20) continue;
    const mins = (l.close - l.open) / MIN;
    const dm: number[] = [], di: number[] = [], dmNext: number[] = [];
    let jumpAtMin = 0, jumpAll = 0;
    for (let i = 1; i < l.slots.length; i++) {
      const a = l.slots[i - 1], b = l.slots[i];
      if (a.mid === undefined || b.mid === undefined || !a.ix || !b.ix) continue;
      const m = logit(b.mid) - logit(a.mid), x = Math.log(b.ix / a.ix) * 1e4;
      dm.push(m); di.push(x);
      const c = l.slots[i + 1];
      dmNext.push(c?.mid !== undefined && b.mid !== undefined ? logit(c.mid) - logit(b.mid) : 0);
      jumpAll += Math.abs(m); if (b.t % MIN === 0) jumpAtMin += Math.abs(m);
    }
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
    const t5 = [...q].reverse().find((s) => s.t <= l.close - 5 * MIN);
    const res = results.get(l.ticker);
    const y = res === 'yes' ? 1 : res === 'no' ? 0 : NaN;
    rows.push({ day, ticker: l.ticker, src, f: [
      mean(q.map((s) => s.spread! * 100)), Math.log1p(mean(q.map((s) => s.top!))), Math.log1p(mean(q.map((s) => s.depth!))), q.length / Math.max(1, l.slots.length),
      l.changes / mins, sd(dm), jumpAll > 0 ? jumpAtMin / jumpAll : 0, corr(dm, di), corr(dmNext, di),
      l.trades / mins, l.trades ? Math.log1p(l.size / l.trades) : 0, sd(di), t5 && Number.isFinite(y) ? (t5.mid! - y) ** 2 : NaN,
    ] });
  }
  return rows;
}

async function resultsOf(dir: string, days: string[]): Promise<Map<string, string>> {
  const r = new Map<string, string>();
  for (const d of days) { const f = dayFile(dir, d); if (f) for await (const e of events(f)) if (e.k === 'result' && e.ticker && e.result) r.set(e.ticker, String(e.result)); }
  return r;
}

async function stageFeatures(): Promise<void> {
  const out = arg('out', 'data/twin');
  const days = arg('days').split(',').filter(Boolean);
  const dirs = Object.fromEntries(arg('dirs').split(',').filter(Boolean).map((kv) => kv.split('=') as [string, string]));
  // Labels from Kalshi's own results (the twin carries them for every contract), the same for both sides.
  const results = await resultsOf(dirs.requote ?? Object.values(dirs)[0], days);
  for (const [src, dir] of Object.entries(dirs)) {
    const rows: Row[] = [];
    for (const d of days) { const f = dayFile(dir, d); if (f) rows.push(...(await dayRows(f, d, src, results))); }
    fs.writeFileSync(path.join(out, `features-${src}.json`), JSON.stringify(rows));
    console.log(`[twin] features ${src}: ${rows.length} contract lives over ${days.length} day(s)`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The adversary: tell twin rows from real rows, leaving one day out.

export function auc(scores: number[], labels: number[]): number {
  const idx = scores.map((s, i) => [s, labels[i]] as const).sort((a, b) => a[0] - b[0]);
  let sumPos = 0, nPos = 0;
  for (let i = 0; i < idx.length;) {
    let j = i; while (j < idx.length && idx[j][0] === idx[i][0]) j++;
    const r = (i + j + 1) / 2; // average rank (1-based) of the tie group
    for (let k = i; k < j; k++) if (idx[k][1]) { sumPos += r; nPos++; }
    i = j;
  }
  const nNeg = idx.length - nPos;
  return nPos && nNeg ? (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : 0.5;
}

/** Logistic regression (L2, plain gradient descent) on standardized features; NaN features impute to the mean. */
export function fitLogit(X: number[][], y: number[], l2 = 0.01, iters = 400, lr = 0.3): (x: number[]) => number {
  const d = X[0]?.length ?? 0;
  const mu = Array.from({ length: d }, (_, j) => { const v = X.map((r) => r[j]).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; });
  const sg = Array.from({ length: d }, (_, j) => { const v = X.map((r) => r[j]).filter(Number.isFinite); const s = Math.sqrt(v.reduce((a, b) => a + (b - mu[j]) ** 2, 0) / Math.max(1, v.length)); return s > 1e-12 ? s : 1; });
  const z = (r: number[]) => r.map((v, j) => (Number.isFinite(v) ? (v - mu[j]) / sg[j] : 0));
  const Z = X.map(z);
  const w = new Array(d).fill(0); let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < Z.length; i++) {
      let s = b; for (let j = 0; j < d; j++) s += w[j] * Z[i][j];
      const e = 1 / (1 + Math.exp(-s)) - y[i];
      gb += e; for (let j = 0; j < d; j++) gw[j] += e * Z[i][j];
    }
    b -= (lr * gb) / Z.length;
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / Z.length + l2 * w[j]);
  }
  return (x: number[]) => { const zz = z(x); let s = b; for (let j = 0; j < d; j++) s += w[j] * zz[j]; return 1 / (1 + Math.exp(-s)); };
}

/** Leave-one-day-out AUC of telling `twin` rows (label 1) from `real` rows (label 0), on the feature columns `cols`. */
export function discriminate(real: Row[], twin: Row[], cols: number[]): number {
  const all = [...real.map((r) => ({ r, y: 0 })), ...twin.map((r) => ({ r, y: 1 }))];
  const days = [...new Set(all.map((a) => a.r.day))].sort();
  const sc: number[] = [], lb: number[] = [];
  for (const d of days) {
    const tr = all.filter((a) => a.r.day !== d), te = all.filter((a) => a.r.day === d);
    if (!te.length || new Set(tr.map((a) => a.y)).size < 2) continue;
    const f = fitLogit(tr.map((a) => cols.map((c) => a.r.f[c])), tr.map((a) => a.y));
    for (const a of te) { sc.push(f(cols.map((c) => a.r.f[c]))); lb.push(a.y); }
  }
  return auc(sc, lb);
}

// ---------------------------------------------------------------------------------------------------------------
// Stage verdict.

type Win = Map<number, { pnl: number; contracts: number }>;
const readWin = (f: string): Win => new Map(JSON.parse(fs.readFileSync(f, 'utf8')));

export function outcome(real: Win, other: Win, seed = 1): { pnl: number; realPnl: number; traded: number; realTraded: number; meanDiff: number; lo: number; hi: number; rmse: number; corr: number } {
  const keys = [...new Set([...real.keys(), ...other.keys()])].filter((k) => (real.get(k)?.contracts ?? 0) > 0 || (other.get(k)?.contracts ?? 0) > 0);
  const a = keys.map((k) => real.get(k)?.pnl ?? 0), b = keys.map((k) => other.get(k)?.pnl ?? 0), d = b.map((x, i) => x - a[i]);
  const n = d.length, mean = n ? d.reduce((x, y) => x + y, 0) / n : 0;
  let s = seed >>> 0 || 1; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const boots: number[] = [];
  for (let k = 0; k < 2000 && n; k++) { let t = 0; for (let i = 0; i < n; i++) t += d[Math.floor(rnd() * n)]; boots.push(t / n); }
  boots.sort((x, y) => x - y);
  return { pnl: b.reduce((x, y) => x + y, 0), realPnl: a.reduce((x, y) => x + y, 0), traded: keys.filter((k) => (other.get(k)?.contracts ?? 0) > 0).length, realTraded: keys.filter((k) => (real.get(k)?.contracts ?? 0) > 0).length, meanDiff: mean, lo: boots[Math.floor(0.025 * boots.length)] ?? 0, hi: boots[Math.floor(0.975 * boots.length)] ?? 0, rmse: Math.sqrt(n ? d.reduce((x, y) => x + y * y, 0) / n : 0), corr: corr(a, b) };
}

/** The decision model's backtest on one folder (replayFidelity's, the production settings), windows of `days` only. */
async function stageBacktest(): Promise<void> {
  const { backtestDir, onDays } = await import('./replayFidelity');
  const dir = arg('dir'), model = arg('model', 'data/models/model.json'), out = arg('out', 'data/twin'), name = arg('name');
  const days = arg('days').split(',').filter(Boolean);
  const extra: Record<string, string> = arg('latency-ms') ? { 'latency-ms': arg('latency-ms') } : {};
  const w = onDays(await backtestDir(dir, model, extra), days);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `windows-${name}.json`), JSON.stringify([...w.entries()]));
}

/** The twin's days through the tally's fill-in (research/goLiveTally.ts fillDayFile), as the deep history plays them. */
async function stageFill(): Promise<void> {
  const { fillDayFile } = await import('./goLiveTally');
  const { readDepthModel } = await import('./history/depthSim');
  const src = arg('src'), dst = arg('dst'), how = arg('how', 'depth') as 'depth' | 'worst' | 'hold' | 'requote';
  const depth = arg('depth-model') ? readDepthModel(arg('depth-model')) : undefined;
  if (how === 'depth' && !depth) throw new Error('the depth fill-in needs --depth-model');
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src).filter((x) => x.startsWith('md-'))) await fillDayFile(path.join(src, f), path.join(dst, f), { how }, depth);
  console.log(`[twin] ${how} fill-in written for ${fs.readdirSync(dst).length} day(s)`);
}

async function stageVerdict(): Promise<void> {
  const out = arg('out', 'data/twin');
  const rows = (src: string): Row[] => { const f = path.join(out, `features-${src}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []; };
  const real = rows('real');
  const report: Record<string, any> = { at: new Date().toISOString(), paired: fs.existsSync(path.join(out, 'paired.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'paired.json'), 'utf8')) : [], twins: {} };
  const placebo = fs.existsSync(path.join(out, 'windows-placebo.json')) && fs.existsSync(path.join(out, 'windows-real.json')) ? outcome(readWin(path.join(out, 'windows-real.json')), readWin(path.join(out, 'windows-placebo.json'))) : undefined;
  report.placebo = placebo;
  // The adversary's sanity check: real against real (two halves of the real days' contracts) must score ~0.5.
  const half = real.filter((_, i) => i % 2 === 0), other = real.filter((_, i) => i % 2 === 1).map((r) => ({ ...r, src: 'real-b' }));
  report.realVsReal = +discriminate(half, other, FEATURES.map((_, j) => j)).toFixed(3);
  console.log(`[twin] adversary sanity, real vs real: AUC ${report.realVsReal}`);
  if (placebo) console.log(`[twin] placebo (real at +250 ms): P&L $${placebo.pnl.toFixed(2)} vs $${placebo.realPnl.toFixed(2)}, per-window error $${placebo.rmse.toFixed(2)}, corr ${placebo.corr.toFixed(2)}`);
  for (const src of ['requote', 'depth', 'worst', 'hold']) {
    const tw = rows(src);
    if (!tw.length) continue;
    const all = FEATURES.map((_, j) => j);
    const a = discriminate(real, tw, all);
    const each = FEATURES.map((name, j) => ({ name, auc: +discriminate(real, tw, [j]).toFixed(3), real: +med(real.map((r) => r.f[j])).toFixed(4), twin: +med(tw.map((r) => r.f[j])).toFixed(4) })).sort((x, y) => Math.abs(y.auc - 0.5) - Math.abs(x.auc - 0.5));
    const wf = path.join(out, `windows-${src}.json`), rf = path.join(out, 'windows-real.json');
    const o = fs.existsSync(wf) && fs.existsSync(rf) ? outcome(readWin(rf), readWin(wf)) : undefined;
    const checks = {
      indistinguishable: a <= 0.6,
      noBias: o ? o.lo <= 0 && o.hi >= 0 : false,
      errorWithinNoise: o && placebo ? o.rmse <= 1.5 * Math.max(placebo.rmse, 1e-9) : false,
      sameActivity: o ? Math.abs(o.traded - o.realTraded) <= 0.1 * Math.max(1, o.realTraded) : false,
    };
    const pass = Object.values(checks).every(Boolean);
    // Regimes (Steven, Nov 1: dynamics wherever possible): the adversary again within calm / normal / volatile contract
    // lives (terciles of the index's 15 s move over the real rows), so a fill-in can be fitted per regime where they differ.
    const vi = FEATURES.indexOf('ixMoveBps');
    const cuts = [1 / 3, 2 / 3].map((q) => { const v = real.map((r) => r.f[vi]).filter(Number.isFinite).sort((x, y) => x - y); return v[Math.floor(q * v.length)] ?? 0; });
    const regimeOf = (r: Row) => (r.f[vi] <= cuts[0] ? 'calm' : r.f[vi] <= cuts[1] ? 'normal' : 'volatile');
    const regimes = Object.fromEntries(['calm', 'normal', 'volatile'].map((g) => {
      const rr = real.filter((r) => regimeOf(r) === g), tt = tw.filter((r) => regimeOf(r) === g);
      const top = FEATURES.map((name, j) => ({ name, auc: discriminate(rr, tt, [j]) })).sort((x, y) => Math.abs(y.auc - 0.5) - Math.abs(x.auc - 0.5))[0];
      return [g, { real: rr.length, twin: tt.length, auc: rr.length > 20 && tt.length > 20 ? +discriminate(rr, tt, all).toFixed(3) : null, top: top ? `${top.name} ${top.auc.toFixed(3)}` : '' }];
    }));
    console.log(`[twin] ${src}: by regime: ${Object.entries(regimes).map(([g, x]) => `${g} AUC ${x.auc ?? 'n/a'} (${x.real}/${x.twin}; worst ${x.top})`).join('; ')}`);
    report.twins[src] = { auc: +a.toFixed(3), features: each, regimes, outcome: o, checks, pass };
    console.log(`[twin] ${src}: adversary AUC ${a.toFixed(3)} (0.5 = can't tell; pass <= 0.60) over ${real.length} real / ${tw.length} twin contract lives`);
    console.log(`[twin] ${src}: gives it away most: ${each.slice(0, 5).map((e) => `${e.name} ${e.auc} (real ${e.real}, twin ${e.twin})`).join('; ')}`);
    if (o) console.log(`[twin] ${src}: backtest P&L $${o.pnl.toFixed(2)} vs real $${o.realPnl.toFixed(2)}; windows ${o.traded} vs ${o.realTraded}; per-window diff $${o.meanDiff.toFixed(3)} [${o.lo.toFixed(3)}, ${o.hi.toFixed(3)}]; error $${o.rmse.toFixed(2)} (placebo $${placebo?.rmse.toFixed(2) ?? '?'}); corr ${o.corr.toFixed(2)}`);
    console.log(`[twin] ${src}: ${pass ? 'PASS' : 'FAIL'} (${Object.entries(checks).map(([k, v]) => `${k} ${v ? 'ok' : 'no'}`).join(', ')})`);
  }
  fs.writeFileSync(path.join(out, 'verdict.json'), JSON.stringify(report, null, 1));
}

const med = (xs: number[]) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : NaN; };

export async function historyTwinMain(): Promise<void> {
  const stage = arg('stage', 'verdict');
  if (stage === 'match') return stageMatch();
  if (stage === 'features') return stageFeatures();
  if (stage === 'backtest') return stageBacktest();
  if (stage === 'fill') return stageFill();
  if (stage === 'verdict') return stageVerdict();
  throw new Error(`unknown --stage ${stage}`);
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) historyTwinMain().catch((e) => { console.error(e); process.exit(1); });

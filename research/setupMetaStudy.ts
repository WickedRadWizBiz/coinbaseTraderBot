// Meta-labeling study: the setup picks the side (research/intradaySetupStudy.ts), a gradient-boosted
// model on the full TA library + market context decides which setups to take. Trained on 2017-2022,
// early-stopped on 2023, tested once on 2024 onward.
//
//   npx tsx research/setupMetaStudy.ts [historyDir]
import { buildData } from './trainTaNet';
import { trainGbdt } from './gbdt';
import { gbdtLogit } from '../bot/model/trees';
import { TANET_FEATURES } from '../bot/ta/taNet';
import { loadSeries } from './history/candles';
import { signals, simulate, type Trade } from './intradaySetupStudy';
import path from 'path';

const HIST = process.argv[2] ?? 'data/history';
const H = 3_600_000;
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
const VAL = Date.UTC(2023, 0, 1), TEST = Date.UTC(2024, 0, 1);
const SETUPS = [['15m', 'fade70'], ['15m', 'pullback'], ['1h', 'fade70'], ['1h', 'pullback']] as const;
const TF_MS = { '15m': 900_000, '1h': H };

const D = buildData(HIST, ASSETS, path.join(HIST, '.tanet-cache'), () => {});
const F = TANET_FEATURES.length;
interface Row { x: number[]; y: number; t: Trade; setup: string }
const rows: Row[] = [];
for (const A of D.assets) {
  const rowOf = new Map(A.rowTs.map((t, r) => [t, r]));
  for (const [tf, kind] of SETUPS) {
    const cs = loadSeries(HIST, A.asset, tf).candles;
    for (const t of simulate(cs, signals(cs, kind))) {
      // The last hourly row closed by the setup bar's close (row ts = hour open; known at ts + H).
      const close = cs[t.i].ts + TF_MS[tf];
      const hr = Math.floor(close / H) * H - H;
      const r = rowOf.get(hr);
      if (r === undefined) continue;
      const base = Array.from(A.X.subarray(r * F, (r + 1) * F));
      const x = [t.dir, tf === '15m' ? 1 : 0, kind === 'fade70' ? 1 : 0, Math.log(t.risk), ...base, ...base.map((v) => t.dir * v)];
      rows.push({ x, y: Math.max(-5, Math.min(5, t.ret * 100)), t, setup: `${tf} ${kind}` });
    }
  }
}
const tr = rows.filter((r) => r.t.ts < VAL), va = rows.filter((r) => r.t.ts >= VAL && r.t.ts < TEST), te = rows.filter((r) => r.t.ts >= TEST);
console.log(`setup trades: train ${tr.length}, validation ${va.length}, test ${te.length}; ${tr[0].x.length} inputs`);
const mean = tr.reduce((a, r) => a + r.y, 0) / tr.length;
const fit = trainGbdt(tr.map((r) => r.x), tr.map((r) => r.y), tr.map(() => 1), tr.map(() => mean),
  va.map((r) => r.x), va.map((r) => r.y), va.map(() => 1), va.map(() => mean), { loss: 'squared', nTrees: 600, learningRate: 0.02, maxDepth: 3, minLeafWeight: 100 });
console.log(`model: ${fit.trees} trees (early stopping on 2023)`);
const pred = (r: Row) => mean + gbdtLogit({ ...fit.model, baseScore: 0 }, r.x);

function report(label: string, xs: Row[]) {
  if (xs.length < 30) return;
  const ps = xs.map(pred), sorted = [...ps].sort((a, b) => a - b);
  console.log(`\n${label}: ${xs.length} test trades, avg net ${(xs.reduce((a, r) => a + r.t.ret, 0) / xs.length * 100).toFixed(3)}%`);
  for (const q of [0, 0.5, 0.8, 0.9, 0.95]) {
    const cut = sorted[Math.floor(q * (sorted.length - 1))];
    const sel = xs.filter((_, k) => ps[k] >= cut);
    const n = sel.length, avg = sel.reduce((a, r) => a + r.t.ret, 0) / n;
    const sd = Math.sqrt(sel.reduce((a, r) => a + (r.t.ret - avg) ** 2, 0) / n);
    const win = sel.filter((r) => r.t.ret > 0).length / n;
    console.log(`  take top ${String(Math.round((1 - q) * 100)).padStart(3)}%: ${String(n).padStart(6)} trades, win ${(win * 100).toFixed(1)}%, avg net ${(avg * 100).toFixed(3)}%/trade (t ${(avg / (sd / Math.sqrt(n))).toFixed(2)})`);
  }
}
report('ALL setups (2024-26)', te);
for (const [tf, kind] of SETUPS) report(`${tf} ${kind} (2024-26)`, te.filter((r) => r.setup === `${tf} ${kind}`));

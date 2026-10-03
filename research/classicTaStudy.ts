// Classic TA rules with textbook parameters (nothing fitted), hourly vs daily bars, after costs.
//   npx tsx research/classicTaStudy.ts [historyDir]
import { loadSeries } from './history/candles';
import { ema, rsi, sma, type Candle } from '../bot/ta/indicators';

const HIST = process.argv[2] ?? 'data/history';
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
const COST = 0.001; // per unit of turnover (10 bp a side)

type Rule = (cs: Candle[]) => number[]; // position (0/1 or -1/0/1) decided at bar i's close
const cl = (cs: Candle[]) => cs.map((c) => c.c);

const rules: Record<string, Rule> = {
  buy_hold: (cs) => cs.map(() => 1),
  tsmom20_long: (cs) => { const c = cl(cs); return c.map((x, i) => (i >= 20 && x > c[i - 20] ? 1 : 0)); },
  tsmom20_ls: (cs) => { const c = cl(cs); return c.map((x, i) => (i >= 20 ? (x > c[i - 20] ? 1 : -1) : 0)); },
  ema20_50: (cs) => { const c = cl(cs), a = ema(c, 20), b = ema(c, 50); return c.map((_, i) => (a[i] > b[i] ? 1 : 0)); },
  above_sma200: (cs) => { const c = cl(cs), s = sma(c, 200); return c.map((x, i) => (x > s[i] ? 1 : 0)); },
  donchian20_10: (cs) => {
    const out: number[] = []; let pos = 0;
    for (let i = 0; i < cs.length; i++) {
      if (i >= 20) {
        let hi = -Infinity; for (let j = i - 20; j < i; j++) hi = Math.max(hi, cs[j].h);
        let lo = Infinity; for (let j = i - 10; j < i; j++) lo = Math.min(lo, cs[j].l);
        if (pos === 0 && cs[i].c > hi) pos = 1; else if (pos === 1 && cs[i].c < lo) pos = 0;
      }
      out.push(pos);
    }
    return out;
  },
  rsi2_meanrev: (cs) => {
    const c = cl(cs), r = rsi(c, 2), s200 = sma(c, 200), s5 = sma(c, 5); const out: number[] = []; let pos = 0;
    for (let i = 0; i < c.length; i++) { if (pos === 0 && r[i] < 10 && c[i] > s200[i]) pos = 1; else if (pos === 1 && c[i] > s5[i]) pos = 0; out.push(pos); }
    return out;
  },
  rsi14_30_50: (cs) => {
    const c = cl(cs), r = rsi(c, 14); const out: number[] = []; let pos = 0;
    for (let i = 0; i < c.length; i++) { if (pos === 0 && r[i] < 30) pos = 1; else if (pos === 1 && r[i] > 50) pos = 0; out.push(pos); }
    return out;
  },
};

function run(cs: Candle[], pos: number[], perYear: number) {
  const rets: number[] = []; let prev = 0; const trades: number[] = []; let tr = 0, inT = false, exposure = 0;
  for (let i = 0; i < cs.length - 1; i++) {
    const p = Number.isFinite(pos[i]) ? pos[i] : 0;
    const r = Math.log(cs[i + 1].c / cs[i].c);
    const cost = Math.abs(p - prev) * COST;
    rets.push(p * r - cost);
    if (p !== 0) exposure++;
    if (p !== prev) { if (inT) trades.push(tr); tr = 0; inT = p !== 0; }
    if (inT) tr += p * r - cost;
    prev = p;
  }
  if (inT) trades.push(tr);
  const n = rets.length, m = rets.reduce((a, x) => a + x, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, x) => a + (x - m) ** 2, 0) / n);
  let eq = 0, pk = 0, dd = 0; for (const r of rets) { eq += r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const wins = trades.filter((x) => x > 0), losses = trades.filter((x) => x <= 0);
  return {
    ann: m * perYear, sharpe: sd > 0 ? (m / sd) * Math.sqrt(perYear) : 0, dd, expo: exposure / n, trades: trades.length,
    win: trades.length ? wins.length / trades.length : NaN,
    payoff: wins.length && losses.length ? (wins.reduce((a, x) => a + x, 0) / wins.length) / Math.abs(losses.reduce((a, x) => a + x, 0) / losses.length) : NaN,
  };
}

for (const tf of ['1d', '1h'] as const) {
  const perYear = tf === '1d' ? 365 : 8760;
  for (const [lab, from, to] of [['all', 0, Infinity], ['2017-21', 0, Date.UTC(2022, 0, 1)], ['2022-26', Date.UTC(2022, 0, 1), Infinity]] as const) {
    console.log(`\n=== ${tf} bars, ${lab} (mean over ${ASSETS.join('/')}; costs 10 bp a side) ===`);
    console.log('rule              ann.ret  Sharpe  maxDD(log)  in-mkt  trades/asset  win%   avgW/avgL');
    for (const [name, rule] of Object.entries(rules)) {
      const rs = ASSETS.map((a) => {
        const all = loadSeries(HIST, a, tf).candles;
        const pos = rule(all); // computed on full history (indicators warm up), then sliced: no look-ahead, rules use past bars only
        const k = all.map((c, i) => [c, pos[i]] as const).filter(([c]) => c.ts >= from && c.ts < to);
        return run(k.map((x) => x[0]), k.map((x) => x[1]), perYear);
      });
      const av = (f: (r: ReturnType<typeof run>) => number) => rs.map(f).filter(Number.isFinite).reduce((a, x, _, arr) => a + x / arr.length, 0);
      console.log(`${name.padEnd(17)} ${(av((r) => r.ann) * 100).toFixed(0).padStart(6)}%  ${av((r) => r.sharpe).toFixed(2).padStart(6)}  ${av((r) => r.dd).toFixed(2).padStart(9)}  ${(av((r) => r.expo) * 100).toFixed(0).padStart(5)}%  ${av((r) => r.trades).toFixed(0).padStart(12)}  ${(av((r) => r.win) * 100).toFixed(1).padStart(5)}  ${av((r) => r.payoff).toFixed(2).padStart(8)}`);
    }
  }
}

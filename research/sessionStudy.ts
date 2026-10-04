// Time-of-day study on 15-minute bars: how volatile each 30-minute slot of the New York day is, whether
// the next hour continues or reverses the prior two hours, and how the intraday setups fare by slot.
//
//   npx tsx research/sessionStudy.ts [historyDir]
import path from 'path';
import { loadSeries } from './history/candles';
import { usSession, zoneTime, VENUES } from '../bot/model/sessions';
import { signals, simulate } from './intradaySetupStudy';
import type { Candle } from '../bot/ta/indicators';

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
const M15 = 900_000;

function slotOf(ts: number): string {
  const us = usSession(ts);
  if (!us.tradingDay) return new Date(ts).getUTCDay() % 6 === 0 ? 'weekend' : 'us-holiday';
  const z = zoneTime(ts, VENUES.newYork.tz);
  const m = Math.floor(z.minutes / 30) * 30;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

interface Acc { n: number; vol: number; xy: number; xx: number; yy: number; agree: number; m: number; setupN: number; setupR: number; setupWin: number }
const acc = () => ({ n: 0, vol: 0, xy: 0, xx: 0, yy: 0, agree: 0, m: 0, setupN: 0, setupR: 0, setupWin: 0 });

function main(hist: string, from: number) {
  const slots = new Map<string, Acc>();
  const get = (k: string) => { let a = slots.get(k); if (!a) { a = acc(); slots.set(k, a); } return a; };
  for (const asset of ASSETS) {
    const cs: Candle[] = loadSeries(hist, asset, '15m').candles;
    const idx = new Map(cs.map((c, i) => [c.ts, i]));
    const r = cs.map((c, i) => (i ? Math.log(c.c / cs[i - 1].c) : 0));
    // Trailing 7-day mean |return| (regime normaliser).
    const W = 672; let s = 0; const base: number[] = [];
    for (let i = 0; i < cs.length; i++) { s += Math.abs(r[i]); if (i >= W) s -= Math.abs(r[i - W]); base.push(i >= W ? s / W : NaN); }
    for (let i = W; i < cs.length - 4; i++) {
      if (cs[i].ts < from) continue;
      const a = get(slotOf(cs[i].ts));
      if (base[i] > 0) { a.vol += Math.abs(r[i]) / base[i]; a.n++; }
      // At slot starts: prior 2 h return vs next 1 h return (both regime-scaled).
      if ((cs[i].ts / M15) % 2 === 0 && i >= 8 && idx.get(cs[i].ts - 8 * M15) === i - 8 && idx.get(cs[i].ts + 4 * M15) === i + 4 && base[i] > 0) {
        const x = Math.log(cs[i - 1].c / cs[i - 9].c) / base[i], y = Math.log(cs[i + 3].c / cs[i - 1].c) / base[i];
        a.xy += x * y; a.xx += x * x; a.yy += y * y; a.m++;
        if (Math.sign(x) === Math.sign(y)) a.agree++;
      }
    }
    for (const kind of ['fade70', 'pullback'] as const) {
      for (const t of simulate(cs, signals(cs, kind))) {
        if (t.ts < from) continue;
        const a = get(slotOf(t.ts));
        a.setupN++; a.setupR += t.ret + 0.0014; if (t.ret + 0.0014 > 0) a.setupWin++;
      }
    }
  }
  const order = [...slots.keys()].sort();
  console.log(`\nfrom ${new Date(from).toISOString().slice(0, 10)}: slot (New York time, NYSE trading days)  vol vs 7-day avg | next 1h vs prior 2h: corr, same direction | 15m setups: trades, gross avg/trade`);
  for (const k of order) {
    const a = slots.get(k)!;
    const corr = a.xx > 0 && a.yy > 0 ? a.xy / Math.sqrt(a.xx * a.yy) : NaN;
    console.log(`  ${k.padEnd(10)}  vol ${(a.vol / a.n).toFixed(2)}x | corr ${corr >= 0 ? '+' : ''}${corr.toFixed(3)}, same dir ${(100 * a.agree / Math.max(1, a.m)).toFixed(1)}% (${a.m}) | setups ${String(a.setupN).padStart(5)}, gross ${(100 * a.setupR / Math.max(1, a.setupN)).toFixed(3)}%`);
  }
}

if (process.argv[1] && import.meta.url?.endsWith(path.basename(process.argv[1]))) {
  const hist = process.argv[2] ?? 'data/history';
  main(hist, Date.UTC(2019, 0, 1));
  main(hist, Date.UTC(2024, 0, 11)); // spot bitcoin ETFs trading
}

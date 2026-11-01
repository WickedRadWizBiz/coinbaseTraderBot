#!/usr/bin/env python3
"""Adversary for the daily health check (read-only): tries to break the last day's paper P&L.
Usage: adversary_report.py <data dir> [hours=24] [lag file]
  - luck: the day's realized P&L against 0 +/- the hourly SD of the last days x sqrt(hours)
  - settlement truth: the bot's settlements against the Kalshi check's verdicts (audit 'kalshi_check' events)
  - fill realism: P&L and contracts from maker quote fills (simulated by the paper exchange) vs taker fills
  - stale quotes: fills within 60 s after a data-lag / feed-drop warning (lag file: one ISO time per line)
  - concentration: the day without its 3 best markets
Runs on a GitHub runner from files copied off the server; prints aggregates only."""
import collections, glob, json, math, os, sys, time
from datetime import datetime, timezone

data = sys.argv[1] if len(sys.argv) > 1 else 'data'
hours = float(sys.argv[2]) if len(sys.argv) > 2 else 24.0
lag_file = sys.argv[3] if len(sys.argv) > 3 else ''

def t_of(iso):
    try: return datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp()
    except Exception: return None

now = time.time()
day_from = now - hours * 3600
fills, settles, orders, checks = [], [], {}, collections.Counter()
want = ('"kind":"fill"', '"kind":"settlement"', '"kind":"order_new"', '"kind":"kalshi_check')
for f in sorted(glob.glob(os.path.join(data, 'audit', 'audit-*.jsonl'))):
    with open(f, 'rb') as fh:
        for raw in fh:
            line = raw.decode('utf8', 'replace')
            if not any(w in line[:200] for w in want): continue
            try: r = json.loads(line)
            except Exception: continue
            k, d, ts = r.get('kind'), r.get('data') or {}, t_of(r.get('ts', ''))
            if ts is None: continue
            if k == 'fill':
                fl = d.get('fill') or {}
                fills.append({'ts': ts, 'ticker': fl.get('ticker', ''), 'count': fl.get('count') or 0, 'price': fl.get('price') or 0,
                              'taker': bool(fl.get('isTaker')), 'fee': d.get('fee') or 0, 'coid': d.get('clientOrderId')})
            elif k == 'settlement':
                settles.append({'ts': ts, 'ticker': d.get('ticker', ''), 'realized': d.get('realized') or 0})
            elif k == 'order_new':
                orders[d.get('clientOrderId')] = d.get('purpose') or '?'
            elif str(k).startswith('kalshi_check') and ts >= day_from:
                checks[f"{k}:{d.get('event') or d.get('type') or ''}"] += 1

day = [s for s in settles if s['ts'] >= day_from]
total = sum(s['realized'] for s in day)
print(f"== adversary: last {hours:g} h to {time.strftime('%Y-%m-%d %H:%M', time.gmtime(now))} UTC | settled markets {len(day)} | realized ${total:.2f}")

# 1. luck: hourly realized over every full hour in the files, the day's own hours included
by_hour = collections.defaultdict(float)
for s in settles: by_hour[int(s['ts'] // 3600)] += s['realized']
if by_hour:
    lo, hi = min(by_hour), max(by_hour)
    series = [by_hour.get(h, 0.0) for h in range(lo, hi)]
    if len(series) >= 12:
        m = sum(series) / len(series)
        sd = math.sqrt(sum((x - m) ** 2 for x in series) / (len(series) - 1))
        band = sd * math.sqrt(hours)
        z = total / band if band else float('nan')
        verdict = 'beyond luck' if abs(z) >= 2 else 'not distinguishable from luck'
        print(f"luck: hourly SD ${sd:.2f} over {len(series)} h (mean ${m:.2f}/h) -> day 0 +/- ${band:.2f} per SD; z {z:+.2f}: {verdict}")
    else:
        print(f"luck: only {len(series)} hours of settlements in the files")

# 2. settlement truth
print(f"settlement truth: Kalshi check events in the window {dict(checks) or 'none in the audit (see /api/status kalshiCheck)'}")

# 3. fill realism and 4. stale quotes
lags = []
if lag_file and os.path.exists(lag_file):
    for l in open(lag_file):
        t = t_of(l.strip())
        if t: lags.append(t)
lags.sort()
def stale(ts):
    import bisect
    i = bisect.bisect_right(lags, ts) - 1
    return i >= 0 and ts - lags[i] <= 60
dfills = [x for x in fills if x['ts'] >= day_from]
agg = collections.defaultdict(lambda: [0, 0.0, 0.0])  # n, contracts, fees
for x in dfills:
    key = ('taker' if x['taker'] else 'maker (simulated queue)', orders.get(x['coid'], '?'))
    a = agg[key]; a[0] += 1; a[1] += x['count']; a[2] += x['fee']
print("fills by type and purpose (n, contracts, fees):")
for (typ, pur), (n, c, fe) in sorted(agg.items(), key=lambda kv: -kv[1][1]):
    print(f"   {typ:24s} {pur:12s} {n:5d} {c:10.1f} ${fe:.2f}")
maker_markets = collections.Counter(x['ticker'] for x in dfills if not x['taker'])
taker_markets = collections.Counter(x['ticker'] for x in dfills if x['taker'])
mk = sum(s['realized'] for s in day if maker_markets[s['ticker']] and not taker_markets[s['ticker']])
tk = sum(s['realized'] for s in day if taker_markets[s['ticker']] and not maker_markets[s['ticker']])
mixed = total - mk - tk
print(f"realized by how the market was traded: maker fills only ${mk:.2f} | taker fills only ${tk:.2f} | both ${mixed:.2f}")
st = [x for x in dfills if stale(x['ts'])]
st_m = {x['ticker'] for x in st}
print(f"stale-quote fills (within 60 s after {len(lags)} lag / feed-drop warnings): {len(st)} fills, {sum(x['count'] for x in st):.1f} contracts,"
      f" in {len(st_m)} markets realizing ${sum(s['realized'] for s in day if s['ticker'] in st_m):.2f}")

# 5. concentration
per = collections.defaultdict(float)
for s in day: per[s['ticker']] += s['realized']
top = sorted(per.items(), key=lambda kv: -kv[1])[:3]
print(f"concentration: best 3 markets ${sum(v for _, v in top):.2f} ({', '.join(f'{t} ${v:.2f}' for t, v in top)}) -> without them ${total - sum(v for _, v in top):.2f}")
worst = sorted(per.items(), key=lambda kv: kv[1])[:3]
print(f"   worst 3 markets: {', '.join(f'{t} ${v:.2f}' for t, v in worst)}")

# replay check verdict, when copied
rc = os.path.join(data, 'replay-check-latest.json')
if os.path.exists(rc):
    try:
        v = json.load(open(rc))
        print("latest replay check:", json.dumps({k: v.get(k) for k in ('verdict', 'close', 'from', 'to', 'stretch', 'replay', 'paper') if k in v}, default=str)[:600])
    except Exception as e:
        print("latest replay check: unreadable", str(e)[:80])

#!/usr/bin/env python3
"""P&L forensics from the bot's own records (read-only): settled markets, fills and orders by UTC hour,
by contract kind and side, around each restart. Usage: pnl_report.py <data dir> [days=3]
Reads the audit log (fills, settlements, orders, startups) with a cheap substring filter first."""
import collections, glob, json, os, sys, time

data = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/bot/data')
days = int(sys.argv[2]) if len(sys.argv) > 2 else 3
now = time.time()
since_day = time.strftime('%Y-%m-%d', time.gmtime(now - (days - 1) * 86400))

def kind_of(t):
    if t.startswith('KXATP'): return 'tennis'
    if '15M-' in t: return 'updown15m'
    seg = t.rsplit('-', 1)[-1]
    if seg.startswith('T'): return 'greater'
    if seg.startswith('B'): return 'between'
    return 'other'

def hour(ts_iso):
    return ts_iso[:13]  # YYYY-MM-DDTHH

files = sorted(f for f in glob.glob(os.path.join(data, 'audit', 'audit-*.jsonl')) if os.path.basename(f)[6:16] >= since_day)
fills, settles, orders, starts, other = [], [], {}, [], collections.Counter()
want = ('"kind":"fill"', '"kind":"settlement"', '"kind":"order_new"', '"kind":"startup"', '"kind":"training"', '"kind":"kill_')
for f in files:
    with open(f, 'rb') as fh:
        for raw in fh:
            line = raw.decode('utf8', 'replace')
            if not any(w in line[:160] for w in want): continue
            try: r = json.loads(line)
            except Exception: continue
            k, d, ts = r.get('kind'), r.get('data') or {}, r.get('ts', '')
            if k == 'fill':
                fl = d.get('fill') or {}
                fills.append({'ts': ts, 'ticker': fl.get('ticker', ''), 'side': fl.get('side'), 'count': fl.get('count', 0), 'price': fl.get('price', 0), 'taker': fl.get('isTaker'), 'fee': d.get('fee', 0), 'coid': d.get('clientOrderId'), 'pos': d.get('position')})
            elif k == 'settlement':
                settles.append({'ts': ts, 'ticker': d.get('ticker', ''), 'result': d.get('result'), 'realized': d.get('realized') or 0, 'fees': d.get('fees') or 0})
            elif k == 'order_new':
                orders[d.get('clientOrderId')] = {'ts': ts, 'purpose': d.get('purpose'), 'fv': d.get('fairValue'), 'price': d.get('price'), 'side': d.get('side'), 'count': d.get('count'), 'ticker': d.get('ticker', ''), 'tif': d.get('timeInForce'), 'post': d.get('postOnly'), 'decision': d.get('decisionId')}
            elif k == 'startup':
                starts.append(ts)
            else:
                ev = d.get('event') if isinstance(d, dict) else None
                other[f"{k}:{ev}"] += 1

print(f'audit files: {[os.path.basename(f) for f in files]}')
print(f'fills {len(fills)}  settlements {len(settles)}  orders {len(orders)}  startups {len(starts)}')
print('startups (restarts):', ', '.join(s[5:16] for s in starts))
print('other events:', dict(other.most_common(12)))

# Settled P&L by hour, kind
print('\n== realized P&L by UTC hour (settlements; tennis separate)')
byh = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0.0, 0]))
for s in settles:
    b = byh[hour(s['ts'])][kind_of(s['ticker'])]
    b[0] += 1; b[1] += s['realized']; b[2] += 1 if s['realized'] > 0 else 0
for h in sorted(byh):
    tot = sum(v[1] for v in byh[h].values()); n = sum(v[0] for v in byh[h].values())
    parts = '  '.join(f"{k}:{v[0]}/{v[1]:+.2f}" for k, v in sorted(byh[h].items()))
    print(f'{h}  n={n:3d}  pnl={tot:+7.2f}   {parts}')

print('\n== realized P&L by UTC day and kind (n / pnl / win%)')
byd = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0.0, 0]))
for s in settles:
    b = byd[s['ts'][:10]][kind_of(s['ticker'])]
    b[0] += 1; b[1] += s['realized']; b[2] += 1 if s['realized'] > 0 else 0
for d in sorted(byd):
    print(d, '  '.join(f"{k}: {v[0]} / {v[1]:+.2f} / {100*v[2]/max(1,v[0]):.0f}%" for k, v in sorted(byd[d].items())), f"  TOTAL {sum(v[1] for v in byd[d].values()):+.2f}")

# Fills by day: side, taker share, avg price, size, purpose, edge at entry
print('\n== fills by UTC day: count, contracts, $cost, taker%, YES-buy%, avg side price, avg contracts/fill, purpose mix, avg entry edge (fv vs price)')
fd = collections.defaultdict(list)
for f in fills: fd[f['ts'][:10]].append(f)
for d in sorted(fd):
    L = fd[d]
    cost = sum((f['price'] if f['side'] == 'bid' else 1 - f['price']) * f['count'] for f in L)
    tk = sum(1 for f in L if f['taker']); yes = sum(1 for f in L if f['side'] == 'bid')
    sp = [f['price'] if f['side'] == 'bid' else 1 - f['price'] for f in L]
    purp = collections.Counter((orders.get(f['coid']) or {}).get('purpose') for f in L)
    edges = []
    for f in L:
        o = orders.get(f['coid'])
        if o and o.get('fv') is not None:
            edges.append((o['fv'] - f['price']) if f['side'] == 'bid' else (f['price'] - o['fv']))
    print(f"{d}  fills {len(L)}  contracts {sum(f['count'] for f in L):.1f}  cost ${cost:.2f}  fees ${sum(f['fee'] or 0 for f in L):.2f}  taker {100*tk/max(1,len(L)):.0f}%  YES-buy {100*yes/max(1,len(L)):.0f}%  avg side px {sum(sp)/max(1,len(sp)):.3f}  avg size {sum(f['count'] for f in L)/max(1,len(L)):.2f}  purposes {dict(purp)}  avg edge {sum(edges)/max(1,len(edges)):+.4f} (n={len(edges)})")

print('\n== fills by UTC hour (last 30 h): n, contracts, cost, taker%, avg edge')
fh_ = collections.defaultdict(list)
for f in fills: fh_[hour(f['ts'])].append(f)
for h in sorted(fh_)[-30:]:
    L = fh_[h]
    cost = sum((f['price'] if f['side'] == 'bid' else 1 - f['price']) * f['count'] for f in L)
    edges = [((o['fv'] - f['price']) if f['side'] == 'bid' else (f['price'] - o['fv'])) for f in L for o in [orders.get(f['coid'])] if o and o.get('fv') is not None]
    print(f"{h}  n={len(L):3d}  contracts={sum(f['count'] for f in L):7.1f}  cost=${cost:7.2f}  taker={100*sum(1 for f in L if f['taker'])/max(1,len(L)):3.0f}%  edge={sum(edges)/max(1,len(edges)):+.4f}")

# Worst settlements in the last day
print('\n== 25 worst settlements in the last 24 h')
recent = [s for s in settles if s['ts'] >= time.strftime('%Y-%m-%dT%H', time.gmtime(now - 86400))]
for s in sorted(recent, key=lambda s: s['realized'])[:25]:
    tf = [f for f in fills if f['ticker'] == s['ticker']]
    pos = sum(f['count'] if f['side'] == 'bid' else -f['count'] for f in tf)
    cost = sum((f['price'] if f['side'] == 'bid' else 1 - f['price']) * f['count'] for f in tf)
    eds = [((o['fv'] - f['price']) if f['side'] == 'bid' else (f['price'] - o['fv'])) for f in tf for o in [orders.get(f['coid'])] if o and o.get('fv') is not None]
    print(f"{s['ts'][5:16]}  {s['ticker']:34s} {s['result']:3s} realized {s['realized']:+7.2f}  fills {len(tf):2d}  net pos {pos:+7.2f}  cost ${cost:6.2f}  taker {sum(1 for f in tf if f['taker'])}  edge@entry {(sum(eds)/len(eds)) if eds else float('nan'):+.3f}")

# Open positions now
try:
    st = json.load(open(os.path.join(data, 'oms_state.json')))
    op = [m for m in st.get('positions', []) if not m.get('settled') and abs(m.get('yes', 0)) > 1e-9]
    print(f"\n== open positions now: {len(op)}")
    for m in op:
        print(f"  {m['ticker']:34s} yes={m['yes']:+.2f}  netCash={m['netCash']:+.2f}  fees={m['fees']:.2f}  ifYes={m['netCash']+m['yes']-m['fees']:+.2f} ifNo={m['netCash']-m['fees']:+.2f}")
except Exception as e:
    print('oms_state:', e)

# Settled trades log (probability at entry vs outcome)
try:
    rows = [json.loads(l) for l in open(os.path.join(data, 'trades.jsonl')) if l.strip()]
    by = collections.defaultdict(lambda: [0, 0, 0.0, 0.0])
    for r in rows:
        d = time.strftime('%Y-%m-%d', time.gmtime(r['ts'] / 1000))
        b = by[(d, r.get('book'))]; b[0] += 1; b[1] += 1 if r.get('won') else 0; b[2] += r.get('q', 0); b[3] += r.get('cost', 0)
    print('\n== trades.jsonl by day/book: n, win%, mean q (prob. of winning at entry), mean cost')
    for (d, bk), b in sorted(by.items())[-12:]:
        print(f"  {d} {bk}: n={b[0]} win={100*b[1]/b[0]:.0f}%  mean q={b[2]/b[0]:.3f}  mean cost={b[3]/b[0]:.3f}")
except Exception as e:
    print('trades.jsonl:', e)

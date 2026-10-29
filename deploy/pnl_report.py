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
want = ('"kind":"fill"', '"kind":"settlement"', '"kind":"order_new"', '"kind":"startup"', '"kind":"training"', '"kind":"kill_', '"kind":"risk_reject"', '"kind":"paper_live_block"')
rate_rejects = collections.Counter()
live_block = {}  # paper: clientOrderId -> why live would not have sent that order (first fill's time, reasons)
exit_why = {}  # decisionId -> [(side, price, why)] of the exits it planned
for f in files:
    with open(f, 'rb') as fh:
        for raw in fh:
            line = raw.decode('utf8', 'replace')
            if '"kind":"decision"' in line[:160] and '"purpose":"exit"' in line:
                try: d = json.loads(line).get('data') or {}
                except Exception: continue
                exit_why[d.get('decisionId')] = [(p.get('side'), p.get('price'), str(p.get('why') or '')) for p in d.get('place') or [] if p.get('purpose') == 'exit']
                continue
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
            elif k == 'paper_live_block':
                live_block[d.get('clientOrderId')] = (ts, d.get('reasons') or [])
            elif k == 'risk_reject':
                rs = d.get('reasons') or []
                if any('order rate' in str(x) for x in rs): rate_rejects[((d.get('intent') or {}).get('purpose') or '?', ts[:13])] += 1
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

# Paper: what live would have made. Each paper order live would not have sent under its own rules is tagged at its first
# fill (paper_live_block: an entry while the model has not passed validation and the Kalshi probation is benched, a
# paper training or exploration trade, a ratchet stop live would not run). A settled market's realized P&L counts in
# proportion to its entry contracts live would also have bought. Ratchet stops cannot be replayed the way live would
# have exited, so they are only counted. Tags begin at the deploy that added them (Oct 23).
if live_block:
    first = min(t for t, _ in live_block.values())
    entry_ct = collections.defaultdict(lambda: [0.0, 0.0])  # ticker -> [entry contracts, of them live-blocked]
    why_ct = collections.Counter()
    ratchet = [0, 0.0]
    for fl in fills:
        o = orders.get(fl['coid']) or {}
        tag = live_block.get(fl['coid'])
        if tag: why_ct.update(tag[1])
        if o.get('purpose') == 'exit':
            if tag: ratchet[0] += 1; ratchet[1] += fl['count']
            continue
        e = entry_ct[fl['ticker']]; e[0] += fl['count']
        if tag: e[1] += fl['count']
    print(f"\n== live-equivalent realized P&L (paper trades live would also have made; tags since {first[5:16]} UTC)")
    byh = collections.defaultdict(lambda: [0.0, 0.0, 0])
    for x in settles:
        if x['ts'] < first or x['ticker'].startswith('KXATP'): continue
        tot, blk = entry_ct.get(x['ticker'], [0.0, 0.0])
        share = 1 - blk / tot if tot > 0 else 1.0
        b = byh[hour(x['ts'])]; b[0] += x['realized']; b[1] += x['realized'] * share; b[2] += 1
    for h in sorted(byh):
        print(f"  {h}  markets {byh[h][2]:3d}  paper {byh[h][0]:+8.2f}  live-equivalent {byh[h][1]:+8.2f}")
    pt, lt = sum(v[0] for v in byh.values()), sum(v[1] for v in byh.values())
    print(f"  total  paper {pt:+.2f}  live-equivalent {lt:+.2f}")
    print('  fills live would not have had, by reason:', dict(why_ct.most_common()) or 'none')
    if ratchet[0]: print(f"  ratchet stops live would not have run (it would have used the model exit): {ratchet[0]} fills, {ratchet[1]:.2f} contracts")
else:
    print('\n== live-equivalent realized P&L: no paper_live_block records yet (the tags begin at the Oct 23 deploy)')

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

# Order traffic: the risk gateway allows RISK_MAX_ORDERS_PER_MIN (30) submissions a minute; new risk stops short of
# that so exits always have room. Rejections are audited at most once a minute per market, side and purpose.
print('\n== order submissions per minute, last 24 h (minutes with at least one order): p50 / p90 / p99 / max, by purpose')
cut = time.strftime('%Y-%m-%dT%H:%M', time.gmtime(now - 86400))
pm = collections.defaultdict(collections.Counter)
for o in orders.values():
    if o['ts'][:16] >= cut: pm[o['ts'][:16]][o['purpose'] or '?'] += 1
def pct(xs, q): return sorted(xs)[min(len(xs) - 1, int(q * len(xs)))] if xs else 0
tot = [sum(c.values()) for c in pm.values()]
print(f"  all: minutes {len(tot)}  p50 {pct(tot, .5)}  p90 {pct(tot, .9)}  p99 {pct(tot, .99)}  max {max(tot, default=0)}  minutes >= 24: {sum(1 for x in tot if x >= 24)}  >= 30: {sum(1 for x in tot if x >= 30)}")
for pu in sorted({k for c in pm.values() for k in c}):
    xs = [c[pu] for c in pm.values() if c[pu]]
    print(f"  {pu}: orders {sum(xs)}  p50 {pct(xs, .5)}  p90 {pct(xs, .9)}  max {max(xs, default=0)}")
print('  order-rate rejections (audited, by purpose):', dict(collections.Counter(k[0] for k in rate_rejects.elements())) or 'none')

# Exit fills by why they were sold (the decision that planned them): the take-profit (trailing since Oct 22 23:03 UTC;
# before it, the profit target sold as soon as it was reached), the model exit (the market pays more than the model's
# value), the hunt's ratchet stop, anything else by its first words. Net a contract after fees is the take-profit's own.
import re
TP = re.compile(r'take-profit( NO)?: \+(-?[0-9.]+) a contract net of fees \(best \+(-?[0-9.]+), floor \+(-?[0-9.]+)')
OLD_TP = re.compile(r'profit target: (NO )?\+(-?[0-9.]+) a contract net of fees')  # sold at the target (before Oct 22 23:03)
# The exit curve's resting sell (rest mode, paper since Oct 23): net a contract at its price, and the swing-top estimate.
REST = re.compile(r'exit curve: rest( NO)? ([0-9.]+) \(\+(-?[0-9.]+) a contract net, swing top ([0-9.]+)\)')
# The exit curve's cross (rest mode, paper since Oct 23): sold at the bid on a confirmed roll-over; net a contract.
CROSS = re.compile(r'exit curve: cross( NO)? ([0-9.]+) \(\+(-?[0-9.]+) a contract net')
def exit_kind(why):
    m = TP.match(why)
    if m: return 'take-profit (trailing)', m
    m = OLD_TP.match(why)
    if m: return 'profit target (old: sold at once)', m
    m = REST.match(why)
    if m: return 'exit curve (resting sell)', m
    m = CROSS.match(why)
    if m: return 'exit curve (cross)', m
    if '- fee > q' in why: return 'model exit (market pays more)', None
    if why.startswith('confluence ratchet wall ask'): return 'ratchet wall ask (resting sell)', None
    if why.startswith('confluence ratchet stop'): return 'ratchet stop', None
    return re.sub(r'[-+]?[0-9][0-9.]*', '#', why)[:40] or '?', None
print('\n== exit fills by reason, by UTC day: fills, contracts, net a contract after fees (take-profit, exit curve; contract-weighted),'
      '\n   and vs holding: what each exit made against holding those contracts to settlement, after its fee (settled markets only)')
byk = collections.defaultdict(lambda: [0, 0.0, 0.0, 0.0, 0.0, 0.0])
result_of = {x['ticker']: x['result'] for x in settles if x.get('result') in ('yes', 'no')}
tp_rows, rest_rows = [], []
for fl in fills:
    o = orders.get(fl['coid']) or {}
    if o.get('purpose') != 'exit': continue
    plans = exit_why.get(o.get('decision')) or []
    why = next((w for sd, px, w in plans if sd == fl['side'] and px == o.get('price')), plans[0][2] if plans else '(no decision record)')
    k, m = exit_kind(why)
    b = byk[(fl['ts'][:10], k)]; b[0] += 1; b[1] += fl['count']
    res = result_of.get(fl['ticker'])
    if res:
        # Selling YES at p (side ask) vs holding YES; buying YES at p to close NO (side bid) vs holding NO.
        y = 1.0 if res == 'yes' else 0.0
        per = fl['price'] - y if fl['side'] == 'ask' else y - fl['price']
        b[4] += per * fl['count'] - (fl['fee'] or 0); b[5] += fl['count']
    if m:
        b[2] += float(m.group(3) if m.re in (REST, CROSS) else m.group(2)) * fl['count']; b[3] += fl['count']
        if m.re is TP: tp_rows.append((fl['ts'], fl['ticker'], fl['count'], m))
        if m.re is REST: rest_rows.append((fl['ts'], fl['ticker'], fl['count'], m))
for (d, k), b in sorted(byk.items()):
    print(f"  {d}  {k:34s} fills {b[0]:4d}  contracts {b[1]:7.2f}" + (f"  net {b[2] / b[3]:+.3f} a contract" if b[3] else '')
          + (f"  vs holding ${b[4]:+.2f} ({b[4] / b[5]:+.3f}/ct on {b[5]:.0f} ct)" if b[5] else ''))
print('  last 12 take-profit fills (net now / best / floor, a contract after fees):')
for ts, t, n, m in tp_rows[-12:]:
    print(f"    {ts[5:16]}  {t:34s} {n:6.2f} ct  +{float(m.group(2)):.3f} / +{float(m.group(3)):.3f} / +{float(m.group(4)):.3f}")
if rest_rows:
    print('  last 12 exit-curve resting sells (side price, net a contract after fees, the swing-top estimate when placed; $ for the fill):')
    for ts, t, n, m in rest_rows[-12:]:
        print(f"    {ts[5:16]}  {t:34s} {n:6.2f} ct  at {float(m.group(2)):.2f}{' NO' if m.group(1) else ''}  +{float(m.group(3)):.3f}  top {float(m.group(4)):.3f}  ${n * float(m.group(3)):+.2f}")

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

#!/usr/bin/env python3
"""Up/Down decision study (read-only, stdlib only): did the move from Coinbase to Kalshi's index for pricing
(Oct 6 ~15:00 UTC), or a later change, turn paper P&L negative?

Joins the bot's own decision records (audit log: fair value from the price feed, the final probability, the
market's bid / ask, sigma, strike) and its fills with Kalshi's official results, strikes and expiration
values (public markets API; the bot's settlement records as a fallback), by period between deploys:
  1. model vs market per settled 15-minute market at 600 / 300 / 120 s before the close: log loss, and when
     the model disagrees with the mid, which side the result lands on
  2. the sigma multiplier k that would have fit best (fair value re-scored as Phi(z / k))
  3. strike check: the bot's strike vs Kalshi's floor_strike
  4. realised 15-minute volatility (Kalshi's expiration value vs strike) vs the bot's sigma at the open
  5. fills: P&L to settlement by origin (train / explore / entry / quote / exit), side price, maker / taker
Usage: decision_study.py <data dir> [days=3]
"""
import collections, glob, json, math, os, re, sys, time, urllib.request
from datetime import datetime

data = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/bot/data')
days = int(sys.argv[2]) if len(sys.argv) > 2 else 3
now = time.time()
since_day = time.strftime('%Y-%m-%d', time.gmtime(now - (days - 1) * 86400))


def iso(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()


CUTS = [  # deploys that could change trading: (label, start)
    ('A coinbase-priced', 0),
    ('B kalshi-index', iso('2026-10-06T15:00:00Z')),
    ('C +optimal-f', iso('2026-10-06T22:08:00Z')),
    ('D +rule-book', iso('2026-10-07T02:01:00Z')),
    ('E +cpu/https', iso('2026-10-07T08:09:00Z')),
]
PERIODS = [c[0] for c in CUTS]


def period(t):
    lab = CUTS[0][0]
    for l, s in CUTS:
        if t >= s: lab = l
    return lab


def kind_of(t):
    if t.startswith('KXATP'): return 'tennis'
    if '15M-' in t: return 'updown15m'
    seg = t.rsplit('-', 1)[-1]
    return 'greater' if seg.startswith('T') else 'between' if seg.startswith('B') else 'other'


NUM = rb'(-?[0-9.]+(?:[eE][-+]?[0-9]+)?)'
RX = {k: re.compile(b'"' + k.encode() + b'":' + NUM) for k in ('spot', 'strike', 'sigma', 'sigmaPricing', 'pMarket', 'q', 'tauSec', 'fv', 'pYes')}
R_TICKER = re.compile(rb'"ticker":"([^"]+)"')
R_SRC = re.compile(rb'"strikeSource":"([a-z]+)"')
R_MODEL = re.compile(rb'"model":"([^"]*)"')
R_DID = re.compile(rb'"decisionId":"([^"]+)"')
R_TS = re.compile(rb'"ts":"([^"]+)"')
R_BA = re.compile(rb'"modelShift":[^,]*,"bid":' + NUM + rb',"ask":' + NUM + rb',"position":' + NUM)


def fkey(f):
    d, _, p = os.path.basename(f)[6:-6].partition('.')
    return (d, int(p or 0))


files = sorted((f for f in glob.glob(os.path.join(data, 'audit', 'audit-*.jsonl')) if os.path.basename(f)[6:16] >= since_day), key=fkey)
D = collections.namedtuple('D', 't tau fv p q bid ask pm spot strike src sigma sigp model pos')
dec = collections.defaultdict(list)  # ticker -> [D] (Up/Down only)
places = {}                           # decisionId -> placed orders (side, price, purpose, why)
dec_of = {}                           # decisionId -> D
orders, fills, settled = {}, [], {}
t0 = time.time()
nbytes = 0
for f in files:
    nbytes += os.path.getsize(f)
    with open(f, 'rb') as fh:
        for line in fh:
            h = line[:120]
            if b'"kind":"decision"' in h:
                did_m = R_DID.search(line, 0, 200)
                ms = line.find(b'"modelShift":')
                if ms < 0: continue
                fi = line.find(b'"features":', 0, ms)  # every field read below comes before the feature map
                head, tail = line[:fi if fi > 0 else ms], line[ms:]
                pi, ci = tail.rfind(b'"place":['), tail.rfind(b',"cancel":')
                placed = did_m is not None and pi >= 0 and ci > pi and tail[pi + 9:pi + 10] != b']'
                if placed and (b'"why":"train' in tail or b'"why":"explore' in tail or b'"why":"take-profit' in tail):
                    try: places[did_m.group(1).decode()] = json.loads(tail[pi + 8:ci])
                    except Exception: pass
                tk = R_TICKER.search(head)
                if not tk or b'15M-' not in tk.group(1): continue
                v = {}
                for k, rx in RX.items():
                    m = rx.search(head)
                    v[k] = float(m.group(1)) if m else None
                ba = R_BA.search(tail)
                if not ba or v['tauSec'] is None or v['fv'] is None: continue
                src, mod = R_SRC.search(head), R_MODEL.search(head)
                d = D(iso(R_TS.search(line, 0, 80).group(1).decode()), v['tauSec'], v['fv'], v['pYes'], v['q'], float(ba.group(1)), float(ba.group(2)), v['pMarket'],
                      v['spot'], v['strike'], src.group(1).decode() if src else '?', v['sigma'], v['sigmaPricing'], mod.group(1).decode() if mod else '?', float(ba.group(3)))
                dec[tk.group(1).decode()].append(d)
                if placed: dec_of[did_m.group(1).decode()] = d
            elif b'"kind":"fill"' in h or b'"kind":"order_new"' in h or b'"kind":"settlement"' in h:
                try: r = json.loads(line)
                except Exception: continue
                k, x = r.get('kind'), r.get('data') or {}
                if k == 'order_new':
                    orders[x.get('clientOrderId')] = x
                elif k == 'fill':
                    fl = x.get('fill') or {}
                    fills.append({'t': iso(r['ts']), 'ticker': fl.get('ticker', ''), 'side': fl.get('side'), 'count': fl.get('count') or 0, 'price': fl.get('price') or 0,
                                  'taker': bool(fl.get('isTaker')), 'fee': x.get('fee') or 0, 'coid': x.get('clientOrderId')})
                else:
                    if x.get('result') in ('yes', 'no'): settled[x.get('ticker')] = x['result']
print(f'audit: {len(files)} files, {nbytes / 1e6:.0f} MB read in {time.time() - t0:.0f}s; Up/Down markets with decisions {len(dec)}, decisions {sum(len(v) for v in dec.values())}, '
      f'orders {len(orders)}, fills {len(fills)}, settlement records {len(settled)}')

# Kalshi's official results, strikes and expiration values for the Up/Down series seen.
official = {}
first_t = min((l[0].t for l in dec.values() if l), default=now) - 3600
for series in sorted({t.split('-')[0] for t in dec}):
    cursor, pages = '', 0
    try:
        while pages < 20:
            url = (f'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker={series}&status=settled&min_close_ts={int(first_t)}&max_close_ts={int(now)}&limit=1000'
                   + (f'&cursor={cursor}' if cursor else ''))
            with urllib.request.urlopen(urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': 'bot-diagnostics'}), timeout=30) as resp:
                j = json.load(resp)
            for m in j.get('markets', []):
                def num(x):
                    try: return float(x)
                    except (TypeError, ValueError): return None
                official[m['ticker']] = {'result': m.get('result'), 'strike': num(m.get('floor_strike')), 'ev': num(m.get('expiration_value'))}
            cursor, pages = j.get('cursor') or '', pages + 1
            if not cursor: break
    except Exception as e:
        print(f'markets API {series}: {e}')
print(f'official results fetched: {len(official)}')


def outcome(t):
    r = (official.get(t) or {}).get('result') or settled.get(t)
    return 1 if r == 'yes' else 0 if r == 'no' else None


def ll(p, y):
    p = min(1 - 1e-3, max(1e-3, p))
    return -(y * math.log(p) + (1 - y) * math.log(1 - p))


def phi(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def phi_inv(p):
    p = min(1 - 1e-9, max(1e-9, p))
    lo, hi = -10.0, 10.0
    for _ in range(60):
        mid = (lo + hi) / 2
        if phi(mid) < p: lo = mid
        else: hi = mid
    return (lo + hi) / 2


def snap(lst, tau, tol=25):
    best = None
    for r in lst:
        dd = abs(r.tau - tau)
        if dd <= tol and (best is None or dd < best[0]): best = (dd, r)
    return best[1] if best else None


# ---- 0. what the bot ran with, per period
print('\n== 0. decisions per period: model ids, strike sources, median sigma (per sqrt s) by asset')
mods, srcs, sig = collections.defaultdict(collections.Counter), collections.defaultdict(collections.Counter), collections.defaultdict(list)
for t, lst in dec.items():
    a = t.split('-')[0].replace('KX', '').replace('15M', '')
    for d in lst:
        pr = period(d.t)
        mods[pr][d.model[:40]] += 1; srcs[pr][d.src] += 1
        if d.sigp: sig[(pr, a)].append(d.sigp)
for pr in PERIODS:
    if not mods[pr]: continue
    sg = '  '.join(f"{a}:{sorted(v)[len(v) // 2]:.2e}" for (p2, a), v in sorted(sig.items()) if p2 == pr)
    print(f'{pr:18s} models {dict(mods[pr].most_common(3))}  strike {dict(srcs[pr])}\n{"":18s} sigmaPricing {sg}')

# ---- 1. model vs market per settled market
print('\n== 1. per settled Up/Down market: log loss of fv (feed fair value), p (final probability), mid; lower is better.')
print('   disagree = mean of sign(x - mid) * (outcome - mid) where |x - mid| >= 0.03: > 0 means the result lands on the model\'s side of the mid')
for tau in (600, 300, 120):
    print(f'-- {tau} s before the close')
    for pr in PERIODS:
        n = 0; s = collections.Counter(); dis = collections.Counter()
        for t, lst in dec.items():
            y = outcome(t)
            if y is None: continue
            d = snap(lst, tau)
            if not d or period(d.t) != pr: continue
            mid = (d.bid + d.ask) / 2
            n += 1
            s['fv'] += ll(d.fv, y); s['mid'] += ll(mid, y); s['y'] += y; s['mfv'] += d.fv; s['mmid'] += mid; s['spr'] += d.ask - d.bid
            if d.p is not None: s['p'] += ll(d.p, y); s['np'] += 1
            for name, x in (('fv', d.fv), ('p', d.p)):
                if x is not None and abs(x - mid) >= 0.03:
                    dis['n' + name] += 1; dis[name] += (1 if x > mid else -1) * (y - mid)
        if not n: continue
        print(f"   {pr:18s} n={n:4d}  ll fv={s['fv'] / n:.4f}  p={s['p'] / max(1, s['np']):.4f}  mid={s['mid'] / n:.4f}   mean fv={s['mfv'] / n:.3f} mid={s['mmid'] / n:.3f} yes-rate={s['y'] / n:.3f} spread={s['spr'] / n:.3f}"
              f"   disagree fv={dis['fv'] / max(1, dis['nfv']):+.4f} (n={dis['nfv']})  p={dis['p'] / max(1, dis['np']):+.4f} (n={dis['np']})")

print('\n   by size of the disagreement (all decisions from 840 to 90 s before the close, one per market per minute): fv - mid bucket -> mean(outcome - mid), n')
edges = [-1, -0.15, -0.08, -0.04, -0.015, 0.015, 0.04, 0.08, 0.15, 1]
for pr in PERIODS:
    b = collections.defaultdict(lambda: [0, 0.0])
    for t, lst in dec.items():
        y = outcome(t)
        if y is None: continue
        seen = set()
        for d in lst:
            if period(d.t) != pr or not (90 <= d.tau <= 840): continue
            mnt = int(d.tau // 60)
            if mnt in seen: continue
            seen.add(mnt)
            mid = (d.bid + d.ask) / 2; x = d.fv - mid
            for i in range(len(edges) - 1):
                if edges[i] <= x < edges[i + 1]: b[i][0] += 1; b[i][1] += y - mid; break
    if b: print(f"   {pr:18s} " + '  '.join(f"[{edges[i]:+.3f},{edges[i + 1]:+.3f}): {b[i][1] / b[i][0]:+.3f} n={b[i][0]}" for i in sorted(b)))

# ---- 2. sigma multiplier
print('\n== 2. sigma multiplier: fair value re-scored as Phi(Phi^-1(fv) / k) at 600/300/120 s; log loss by k (best marked *)')
KS = (0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.15, 1.3, 1.5)
for pr in PERIODS:
    acc = collections.Counter(); n = 0
    for t, lst in dec.items():
        y = outcome(t)
        if y is None: continue
        for tau in (600, 300, 120):
            d = snap(lst, tau)
            if not d or period(d.t) != pr or not (0.001 < d.fv < 0.999): continue
            z = phi_inv(d.fv); n += 1
            for k in KS: acc[k] += ll(phi(z / k), y)
    if not n: continue
    best = min(KS, key=lambda k: acc[k])
    print(f"   {pr:18s} n={n:4d}  " + '  '.join(f"k={k}:{acc[k] / n:.4f}{'*' if k == best else ''}" for k in KS))

# ---- 3. strike check
print('\n== 3. strike: the bot\'s strike vs Kalshi\'s floor_strike (bps); for scale, sigma x sqrt(860 s) in bps')
for pr in PERIODS:
    rows = collections.defaultdict(list)
    for t, lst in dec.items():
        o = official.get(t)
        if not o or not o.get('strike') or not lst: continue
        d = lst[-1]
        if period(d.t) != pr or not d.strike: continue
        rows[d.src].append((1e4 * (d.strike / o['strike'] - 1), 1e4 * (d.sigp or 0) * math.sqrt(860)))
    for src, v in sorted(rows.items()):
        diffs = sorted(x for x, _ in v)
        print(f"   {pr:18s} {src:9s} n={len(v):4d}  mean {sum(diffs) / len(v):+.2f}  mean|.| {sum(abs(x) for x in diffs) / len(v):.2f}  median {diffs[len(v) // 2]:+.2f}  p90|.| {sorted(abs(x) for x in diffs)[int(0.9 * (len(v) - 1))]:.2f}   sigma-move {sorted(s for _, s in v)[len(v) // 2]:.1f}")

# ---- 4. realised vs predicted 15-minute volatility
print('\n== 4. realised 15-minute move ln(expiration value / strike) (Kalshi) vs the bot\'s sigma at the open x sqrt(880 s): ratio < 1 = the bot overstates volatility')
for pr in PERIODS:
    per = collections.defaultdict(lambda: [0, 0.0, []])
    for t, lst in dec.items():
        o = official.get(t)
        if not o or not o.get('strike') or not o.get('ev') or not lst: continue
        d0 = max(lst, key=lambda d: d.tau)
        if period(d0.t) != pr or not d0.sigp or d0.tau < 600: continue
        a = t.split('-')[0].replace('KX', '').replace('15M', '')
        r = math.log(o['ev'] / o['strike'])
        x = per[a]; x[0] += 1; x[1] += r * r; x[2].append(d0.sigp * math.sqrt(880))
    if per: print(f"   {pr:18s} " + '  '.join(f"{a}: realised {math.sqrt(v[1] / v[0]) * 1e4:.1f}bp vs bot {sorted(v[2])[len(v[2]) // 2] * 1e4:.1f}bp = {math.sqrt(v[1] / v[0]) / (sorted(v[2])[len(v[2]) // 2] or 1):.2f} (n={v[0]})" for a, v in sorted(per.items())))

# ---- 5. fills
print('\n== 5. fills held to settlement: P&L = signed contracts x (outcome - price) - fee, by period and origin')
print('   q-cost = the decision probability of the side bought minus its price; y-cost = what it was worth; mid-cost = the market mid of that side minus the price')


def origin(f, o):
    if not o: return 'unknown'
    if o.get('reduceOnly') or o.get('purpose') == 'exit': return 'exit'
    for p in places.get(o.get('decisionId'), []) or []:
        if p.get('side') == f['side'] and abs((p.get('price') or 0) - (o.get('price') or 0)) < 1e-9:
            w = p.get('why') or ''
            if w.startswith('train'): return 'train'
            if w.startswith('explore'): return 'explore'
            if w.startswith('take-profit'): return 'take-profit'
            break
    return o.get('purpose') or 'unknown'


groups = collections.defaultdict(lambda: collections.Counter())
for f in fills:
    y = outcome(f['ticker'])
    if y is None: continue
    o = orders.get(f['coid'])
    sgn = 1 if f['side'] == 'bid' else -1
    c = f['count']
    pnl = sgn * c * (y - f['price']) - f['fee']
    cost = f['price'] if sgn > 0 else 1 - f['price']
    ys = y if sgn > 0 else 1 - y
    d = dec_of.get((o or {}).get('decisionId'))
    qs = (o or {}).get('fairValue')
    qs = None if qs is None else (qs if sgn > 0 else 1 - qs)
    mid = None if not d else ((d.bid + d.ask) / 2 if sgn > 0 else 1 - (d.bid + d.ask) / 2)
    pr, kd, org = period(f['t']), kind_of(f['ticker']), origin(f, o)
    bucket = f"side px {min(4, int(cost * 5)) * 0.2:.1f}-{min(4, int(cost * 5)) * 0.2 + 0.2:.1f}"
    asset = 'coin ' + f['ticker'].split('-')[0].replace('KX', '').replace('15M', '')[:8]
    for key in ((pr, kd, org), (pr, kd, 'ALL'), (pr, kd, 'taker' if f['taker'] else 'maker'), (pr, kd, bucket), (pr, kd, asset)):
        g = groups[key]
        g['n'] += 1; g['c'] += c; g['pnl'] += pnl; g['fee'] += f['fee']; g['win'] += 1 if ys == 1 else 0; g['cost'] += cost * c; g['ys'] += ys * c
        if qs is not None: g['nq'] += c; g['q'] += qs * c
        if mid is not None: g['nm'] += c; g['mid'] += mid * c
for kd in ('updown15m', 'greater', 'between', 'tennis', 'other'):
    keys = [k for k in groups if k[1] == kd]
    if not keys: continue
    print(f'-- {kd}')
    order_ = {'ALL': 0, 'train': 1, 'explore': 2, 'entry': 3, 'quote': 4, 'take-profit': 5, 'exit': 6, 'unknown': 7, 'taker': 8, 'maker': 9}
    for k in sorted(keys, key=lambda k: (PERIODS.index(k[0]), order_.get(k[2], 10), k[2])):
        g = groups[k]
        c = g['c'] or 1
        q = f"{g['q'] / g['nq'] - g['cost'] / c:+.3f}" if g['nq'] else '  n/a '
        m = f"{g['mid'] / g['nm'] - g['cost'] / c:+.3f}" if g['nm'] else '  n/a '
        print(f"   {k[0]:18s} {k[2]:14s} fills {g['n']:4d}  contracts {g['c']:7.1f}  P&L {g['pnl']:+8.2f} ({g['pnl'] / c:+.3f}/ct)  fees {g['fee']:6.2f}  won {100 * g['win'] / g['n']:3.0f}%  "
              f"avg side px {g['cost'] / c:.3f}  q-cost {q}  y-cost {g['ys'] / c - g['cost'] / c:+.3f}  mid-cost {m}")

#!/usr/bin/env python3
"""Which price source predicts the 15-minute Up/Down settlements better: Kalshi's CF RTI (what they
settle on) or Coinbase spot (what paper priced from before Oct 6 15:00)? Read-only, stdlib only.

From the recordings (index / spot / market / result records) it measures, per asset:
  - lead-lag: correlation of 1 s returns of spot vs RTI at lags -5..+5 s (who moves first)
  - variance ratio VR(k) = Var(k s returns) / (k Var(1 s returns)) for RTI and spot: whether the 1 s
    volatility the bot scales up (sigma * sqrt(tau)) under- or over-states the volatility that matters
and per settled Up/Down market, at 600 / 300 / 120 s before the close, a simple fair value
    P(YES) = Phi( ln(S/K) / (sigma sqrt(tau - 40)) )      (60 s settlement average ~ tau - 40)
under four variants: RTI price + RTI sigma; spot price + spot sigma (strike from the same source, as
paper did); RTI price + spot sigma; RTI price + RTI sigma scaled by sqrt(VR(300)).
Scores: log loss, Brier, mean prediction vs hit rate. Usage: price_study.py <recordings dir> [days=2]
"""
import collections, glob, gzip, json, math, os, sys, time

rec_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/bot/data/recordings')
days = int(sys.argv[2]) if len(sys.argv) > 2 else 2
first_day = time.strftime('%Y-%m-%d', time.gmtime(time.time() - (days - 1) * 86400))
files = sorted(f for f in glob.glob(os.path.join(rec_dir, 'md-*.jsonl*')) if os.path.basename(f)[3:13] >= first_day)

idx = collections.defaultdict(list)   # asset -> [(ts, v)] (Kalshi RTI)
spot = collections.defaultdict(list)  # asset -> [(ts, v)] (Coinbase)
markets, results = {}, {}
keys = (b'"k":"index"', b'"k":"spot"', b'"k":"market"', b'"k":"result"', b'"k":"lifecycle"')
t0 = time.time()
for f in files:
    op = gzip.open if f.endswith('.gz') else open
    with op(f, 'rb') as fh:
        for line in fh:
            head = line[:40]
            if not any(k in head for k in keys): continue
            try: r = json.loads(line)
            except Exception: continue
            k = r.get('k')
            if k == 'index' and r.get('src') == 'kalshi': idx[r['asset']].append((r['ts'], r['value']))
            elif k == 'spot': spot[r['asset']].append((r['ts'], r['value']))
            elif k == 'market' and r.get('kind') == 'updown': markets[r['ticker']] = r
            elif k == 'result': results[r['ticker']] = r['result']
            # Positions settled by the live lifecycle message write no 'result' record; the message itself has it.
            elif k == 'lifecycle' and r.get('result') in ('yes', 'no'): results.setdefault(r['ticker'], r['result'])
print(f'files {[os.path.basename(f) for f in files]}  read in {time.time()-t0:.0f}s')
print('index prints', {a: len(v) for a, v in idx.items()}, ' spot prints', {a: len(v) for a, v in spot.items()})
print('updown markets', len(markets), ' with result', sum(1 for t in markets if t in results))

def grid(pts):
    """Last value at each whole second (forward-filled up to 15 s), as dict sec -> value."""
    pts.sort()
    out = {}
    j = 0
    if not pts: return out
    s0, s1 = pts[0][0] // 1000 + 1, pts[-1][0] // 1000
    last_ts, last_v = None, None
    for s in range(s0, s1 + 1):
        t = s * 1000
        while j < len(pts) and pts[j][0] <= t:
            last_ts, last_v = pts[j]; j += 1
        if last_v is not None and t - last_ts <= 15000: out[s] = last_v
    return out

def rets(g, lag=1):
    return {s: math.log(g[s] / g[s - lag]) for s in g if s - lag in g and g[s] > 0 and g[s - lag] > 0}

def corr(xs, ys):
    n = len(xs)
    if n < 100: return float('nan')
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys)); sxx = sum((x - mx) ** 2 for x in xs); syy = sum((y - my) ** 2 for y in ys)
    return sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else float('nan')

def vr(g, k):
    r1 = list(rets(g, 1).values())
    rk = [v for s, v in rets(g, k).items() if s % k == 0]
    if len(r1) < 1000 or len(rk) < 30: return float('nan')
    v1 = sum(x * x for x in r1) / len(r1); vk = sum(x * x for x in rk) / len(rk)
    return vk / (k * v1) if v1 > 0 else float('nan')

grids = {}
for a in sorted(set(idx) | set(spot)):
    gi, gs = grid(idx.get(a, [])), grid(spot.get(a, []))
    grids[a] = (gi, gs)
    ri, rs = rets(gi), rets(gs)
    lags = {}
    for L in range(-5, 6):
        # corr(spot return at s, RTI return at s+L): peak at L>0 = spot moves first
        common = [s for s in rs if s + L in ri]
        lags[L] = corr([rs[s] for s in common], [ri[s + L] for s in common])
    best = max(lags, key=lambda L: lags[L] if not math.isnan(lags[L]) else -9)
    print(f"\n{a}: lead-lag corr(spot_t, RTI_t+L): " + ' '.join(f"{L:+d}:{lags[L]:.2f}" for L in lags) + f"   peak at L={best:+d} ({'spot leads' if best > 0 else 'RTI leads' if best < 0 else 'same second'})")
    print(f"{a}: variance ratio RTI  VR(60)={vr(gi,60):.2f} VR(300)={vr(gi,300):.2f} VR(900)={vr(gi,900):.2f}   spot VR(60)={vr(gs,60):.2f} VR(300)={vr(gs,300):.2f} VR(900)={vr(gs,900):.2f}")

def ewma_sigma(g, end_s, half=300, look=3600):
    """The bot's estimator: EWMA of squared 1 s log returns (half-life 300 s), up to end_s."""
    var, a = None, 1 - 0.5 ** (1 / half)
    prev = None
    for s in range(end_s - look, end_s + 1):
        v = g.get(s)
        if v is None: continue
        if prev is not None:
            r = math.log(v / prev); var = r * r if var is None else (1 - a) * var + a * r * r
        prev = v
    return math.sqrt(var) if var else None

def open_avg(g, open_s):
    vals = [g[s] for s in range(open_s - 59, open_s + 1) if s in g]
    return sum(vals) / len(vals) if len(vals) >= 50 else None

def phi(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))

VR300 = {a: vr(grids[a][0], 300) for a in grids}
for a, (gi, gs) in grids.items():
    ki, ks = sorted(gi), sorted(gs)
    print(f"grid {a}: RTI {len(ki)} s [{ki[0] if ki else None}..{ki[-1] if ki else None}]  spot {len(ks)} s [{ks[0] if ks else None}..{ks[-1] if ks else None}]")
shown = 0
for t, m in markets.items():
    if results.get(t) not in ('yes', 'no') or m['asset'] not in grids or shown >= 4: continue
    gi, gs = grids[m['asset']]
    o, c = m['openTime'] // 1000, m['closeTime'] // 1000
    print('debug', t, 'open', o, 'close', c, 'strike', m.get('strike'), 'RTI open avg', open_avg(gi, o), 'RTI at -300', gi.get(c - 300), 'sigma', ewma_sigma(gi, c - 300), 'spot at -300', gs.get(c - 300))
    shown += 1
scores = collections.defaultdict(lambda: [0, 0.0, 0.0, 0.0, 0])  # (variant, tau) -> n, logloss, brier, sum p, hits
for t, m in markets.items():
    res = results.get(t)
    if res not in ('yes', 'no'): continue
    a = m['asset']
    if a not in grids: continue
    gi, gs = grids[a]
    open_s, close_s = m['openTime'] // 1000, m['closeTime'] // 1000
    Ki = m.get('strike') or open_avg(gi, open_s)
    Ks = open_avg(gs, open_s)
    y = 1 if res == 'yes' else 0
    for tau in (600, 300, 120):
        s = close_s - tau
        Si, Ss = gi.get(s), gs.get(s)
        sgi, sgs = ewma_sigma(gi, s), ewma_sigma(gs, s)
        teff = max(1, tau - 40)
        variants = {}
        if Si and Ki and sgi: variants['RTI price, RTI vol'] = phi(math.log(Si / Ki) / (sgi * math.sqrt(teff)))
        if Ss and Ks and sgs: variants['spot price, spot vol (old paper)'] = phi(math.log(Ss / Ks) / (sgs * math.sqrt(teff)))
        if Si and Ki and sgs: variants['RTI price, spot vol'] = phi(math.log(Si / Ki) / (sgs * math.sqrt(teff)))
        vr3 = VR300.get(a)
        if Si and Ki and sgi and vr3 and not math.isnan(vr3): variants['RTI price, RTI vol x sqrt(VR300)'] = phi(math.log(Si / Ki) / (sgi * math.sqrt(vr3) * math.sqrt(teff)))
        for name, p in variants.items():
            p = min(1 - 1e-4, max(1e-4, p))
            sc = scores[(name, tau)]
            sc[0] += 1; sc[1] += -(y * math.log(p) + (1 - y) * math.log(1 - p)); sc[2] += (p - y) ** 2; sc[3] += p; sc[4] += y

print('\n== Up/Down fair value vs settlement (lower log loss / Brier is better; mean p vs hit rate shows bias)')
for tau in (600, 300, 120):
    print(f'-- {tau} s before close')
    for (name, tt), sc in sorted(scores.items()):
        if tt != tau or not sc[0]: continue
        print(f"   {name:36s} n={sc[0]:4d}  logloss={sc[1]/sc[0]:.4f}  brier={sc[2]/sc[0]:.4f}  mean p={sc[3]/sc[0]:.3f}  hit rate={sc[4]/sc[0]:.3f}")

# Calibration by confidence bucket (RTI price, RTI vol) at 300 s: overconfident if hits < p at the extremes
print('\n== calibration at 300 s, by |p - 0.5| bucket: predicted P(side favoured) vs how often that side won')
for name in ('RTI price, RTI vol', 'spot price, spot vol (old paper)'):
    b = collections.defaultdict(lambda: [0, 0.0, 0])
    for t, m in markets.items():
        res = results.get(t)
        if res not in ('yes', 'no') or m['asset'] not in grids: continue
        gi, gs = grids[m['asset']]
        open_s, s = m['openTime'] // 1000, m['closeTime'] // 1000 - 300
        if name.startswith('RTI'):
            K, S, sg = m.get('strike') or open_avg(gi, open_s), gi.get(s), ewma_sigma(gi, s)
        else:
            K, S, sg = open_avg(gs, open_s), gs.get(s), ewma_sigma(gs, s)
        if not (K and S and sg): continue
        p = phi(math.log(S / K) / (sg * math.sqrt(260)))
        fav = max(p, 1 - p); won = (res == 'yes') == (p >= 0.5)
        key = min(4, int((fav - 0.5) / 0.1))
        b[key][0] += 1; b[key][1] += fav; b[key][2] += 1 if won else 0
    print(f'  {name}:')
    for key in sorted(b):
        n, sp, w = b[key]
        print(f"    favoured side p in [{0.5+0.1*key:.1f},{0.6+0.1*key:.1f}): n={n:4d}  mean p={sp/n:.3f}  won={w/n:.3f}")

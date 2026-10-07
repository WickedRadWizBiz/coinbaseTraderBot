#!/usr/bin/env python3
"""When does each price reach the bot? Read-only, stdlib only.

From today's recordings (index = Kalshi's CF RTI feed, spot = Coinbase), using both timestamps every record
carries: t (when the bot received it) and ts (the source's own time stamp):
  - delay t - ts per feed and asset (quantiles, ms)
  - lead-lag of 250 ms returns, Coinbase vs RTI, on RECEIVE time (what the bot can act on) and on source time:
    a peak at a positive lag means Coinbase moves first
  - how often the RTI value the bot holds actually changes
Usage: latency_study.py <recordings dir> [hours=6]
"""
import collections, glob, json, math, os, sys, time

rec_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/bot/data/recordings')
hours = float(sys.argv[2]) if len(sys.argv) > 2 else 6
now_ms = time.time() * 1000
since = now_ms - hours * 3_600_000
day = time.strftime('%Y-%m-%d', time.gmtime())
files = sorted(glob.glob(os.path.join(rec_dir, f'md-{day}.jsonl*')))
idx, spot = collections.defaultdict(list), collections.defaultdict(list)  # asset -> [(t, ts, v)]
t0 = time.time()
for f in files:
    with open(f, 'rb') as fh:
        for line in fh:
            head = line[:40]
            is_idx = b'"k":"index"' in head
            if not is_idx and b'"k":"spot"' not in head: continue
            try: r = json.loads(line)
            except Exception: continue
            if r['t'] < since: continue
            if is_idx:
                if r.get('src') == 'kalshi': idx[r['asset']].append((r['t'], r['ts'], r['value']))
            else:
                spot[r['asset']].append((r['t'], r['ts'], r['value']))
print(f'files {[os.path.basename(f) for f in files]} read in {time.time() - t0:.0f}s; last {hours} h; index prints', {a: len(v) for a, v in idx.items()}, 'spot prints', {a: len(v) for a, v in spot.items()})


def q(xs, p):
    return xs[min(len(xs) - 1, int(p * (len(xs) - 1)))] if xs else float('nan')


print('\n== delay from the source time stamp to the bot (ms): p10 / p50 / p90 / p99')
for a in sorted(set(idx) | set(spot)):
    di = sorted(t - ts for t, ts, _ in idx.get(a, []))
    ds = sorted(t - ts for t, ts, _ in spot.get(a, []))
    print(f"   {a:5s} RTI {q(di, .1):7.0f} {q(di, .5):7.0f} {q(di, .9):7.0f} {q(di, .99):7.0f}     Coinbase {q(ds, .1):7.0f} {q(ds, .5):7.0f} {q(ds, .9):7.0f} {q(ds, .99):7.0f}")

STEP = 250  # ms


def grid(pts, key):
    """Last value at each STEP mark (by the chosen clock), forward-filled up to 15 s: dict mark -> value."""
    pts = sorted(pts, key=lambda p: p[key])
    out, j, last = {}, 0, None
    if not pts: return out
    m0, m1 = pts[0][key] // STEP + 1, pts[-1][key] // STEP
    for m in range(m0, m1 + 1):
        t = m * STEP
        while j < len(pts) and pts[j][key] <= t:
            last = pts[j]; j += 1
        if last is not None and t - last[key] <= 15000: out[m] = last[2]
    return out


def rets(g):
    return {m: math.log(g[m] / g[m - 1]) for m in g if m - 1 in g and g[m] > 0 and g[m - 1] > 0}


def corr(xs, ys):
    n = len(xs)
    if n < 500: return float('nan')
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys)); sxx = sum((x - mx) ** 2 for x in xs); syy = sum((y - my) ** 2 for y in ys)
    return sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else float('nan')


LAGS = range(-8, 13)  # x 250 ms
print(f'\n== lead-lag: corr(Coinbase return at m, RTI return at m + L), L in {STEP} ms steps; peak at L > 0 = Coinbase moves first')
for a in sorted(set(idx) & set(spot)):
    for key, name in ((0, 'receive time'), (1, 'source time ')):
        ri, rs = rets(grid(idx[a], key)), rets(grid(spot[a], key))
        cs = {}
        for L in LAGS:
            common = [m for m in rs if m + L in ri and rs[m] != 0]
            cs[L] = corr([rs[m] for m in common], [ri[m + L] for m in common])
        best = max(cs, key=lambda L: cs[L] if not math.isnan(cs[L]) else -9)
        print(f"   {a:5s} {name}: peak L={best:+d} ({best * STEP:+d} ms)  " + ' '.join(f"{L * STEP / 1000:+.2f}s:{cs[L]:.2f}" for L in LAGS if L % 2 == 0))

print('\n== RTI value changes as received: share of seconds with a new value, median and p90 gap between changes (ms)')
for a in sorted(idx):
    pts = sorted(idx[a])
    ch = [pts[i][0] for i in range(1, len(pts)) if pts[i][2] != pts[i - 1][2]]
    gaps = sorted(ch[i] - ch[i - 1] for i in range(1, len(ch)))
    secs = len({t // 1000 for t in ch})
    span = (pts[-1][0] - pts[0][0]) / 1000 if len(pts) > 1 else 1
    print(f"   {a:5s} changes {len(ch)}  seconds with a change {100 * secs / max(1, span):.0f}%  gap p50 {q(gaps, .5):.0f}  p90 {q(gaps, .9):.0f}")

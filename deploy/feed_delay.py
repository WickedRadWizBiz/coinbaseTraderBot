#!/usr/bin/env python3
"""How late did market data reach the bot, hour by hour? Read-only, stdlib only.

Every recording carries t (when the bot processed it) and, for Kalshi trades, the exchange's own trade time
(ts, whole seconds) - so t - ts is how stale the bot's view of Kalshi was. Coinbase prints and Kalshi's index
carry their source time too. A backlog (event-loop stalls, compressed frames queued) shows up as large delays.
Usage: feed_delay.py <recordings dir> [days=3]
"""
import collections, glob, json, os, sys, time

rec_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/bot/data/recordings')
days = int(sys.argv[2]) if len(sys.argv) > 2 else 3
first_day = time.strftime('%Y-%m-%d', time.gmtime(time.time() - (days - 1) * 86400))
files = sorted(f for f in glob.glob(os.path.join(rec_dir, 'md-*.jsonl*')) if os.path.basename(f)[3:13] >= first_day)
lag = collections.defaultdict(lambda: collections.defaultdict(list))  # hour -> feed -> [ms]
t0 = time.time()
for f in files:
    with open(f, 'rb') as fh:
        for line in fh:
            head = line[:40]
            if b'"k":"trade"' in head: feed = 'kalshi trade'
            elif b'"k":"spot"' in head: feed = 'coinbase'
            elif b'"k":"index"' in head: feed = 'kalshi index'
            else: continue
            try: r = json.loads(line)
            except Exception: continue
            t, ts = r.get('t'), r.get('ts')
            if not isinstance(t, (int, float)) or not isinstance(ts, (int, float)): continue
            if feed == 'kalshi index' and r.get('src') != 'kalshi': continue
            # Kalshi trade times are whole seconds: +500 ms centres the truncation.
            d = t - ts - (500 if feed == 'kalshi trade' else 0)
            lst = lag[time.strftime('%m-%d %H', time.gmtime(t / 1000))][feed]
            if feed != 'kalshi trade' and len(lst) >= 20000: continue  # plenty for quantiles
            lst.append(d)
print(f'files {[os.path.basename(f) for f in files]} read in {time.time() - t0:.0f}s')


def q(xs, p): return xs[min(len(xs) - 1, int(p * (len(xs) - 1)))]


print('\n== delay of data reaching the bot, by UTC hour: p50 / p90 / p99 / max in ms (n)')
for h in sorted(lag):
    parts = []
    for feed in ('kalshi trade', 'kalshi index', 'coinbase'):
        xs = sorted(lag[h].get(feed, []))
        if xs: parts.append(f"{feed} {q(xs, .5):6.0f} {q(xs, .9):6.0f} {q(xs, .99):7.0f} {xs[-1]:7.0f} (n={len(xs)})")
    print(f'{h}  ' + '   '.join(parts))

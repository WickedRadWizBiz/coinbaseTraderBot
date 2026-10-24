#!/usr/bin/env python3
"""Component study (read-only): would the SNN or the TA network have priced the bot's crypto contracts better, on the
bot's own records? The offline half of the component trials (bot/strategy/componentTrials.ts, which score the same
contributions live from now on), and what the rule book's trial would read.

On the audit log's decision records that carry the full feature map (every market at least every 5 minutes, and with
every order that is not a requote), inside each contract's entry window, against the official results (the audit's
settlements and the recordings' result lines, every scanned market):
  - the meta-model's price: the fair value moved by the record's modelShift (logit(model) - logit(fair value));
  - the SNN: its probability for the contract, from the record's snn_bias (logit(p_snn) - logit(fair value)), blended
    in at weights 0.1 / 0.25 / 0.5 / 1 times its confidence c (calibration x surprise x governor, bot/snn/blender.ts);
  - the TA network: the tilt the bot applied (the record's price minus the meta-model's), at 0.5 / 1 / 2 times.
Each against the meta-model's price: log loss per snapshot, averaged per contract and per settlement (one asset's
contracts closing together), then a Diebold-Mariano test over the settlements in time order (Newey-West variance),
as bot/model/modelHealth.ts does.

Usage: component_study.py <data dir> [days=3]
"""
import collections, datetime, glob, json, math, os, re, subprocess, sys, time

TICKER = re.compile(r'^KX([A-Z]+?)(15M|D)?-')
TRIAL_MIN_CONF = 20


def logit(p):
    p = min(1 - 1e-6, max(1e-6, p))
    return math.log(p / (1 - p))


def sigmoid(x):
    return 1 / (1 + math.exp(-x)) if x > -700 else 0.0


def ll(p, y):
    q = min(1 - 1e-6, max(1e-6, p))
    return -math.log(q) if y else -math.log(1 - q)


def norm_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def dm(d):
    """bot/model/modelHealth.ts dmStat: mean and mean / standard error (Newey-West, lag cbrt(n))."""
    n = len(d)
    m = sum(d) / n
    L = int(n ** (1 / 3))
    g = lambda k: sum((d[t] - m) * (d[t - k] - m) for t in range(k, n)) / n
    v = g(0) + sum(2 * (1 - k / (L + 1)) * g(k) for k in range(1, L + 1))
    return m, m / math.sqrt(max(1e-18, v / n))


def num(x):
    return x if isinstance(x, (int, float)) and math.isfinite(x) else None


def iso_ms(ts):
    return int(datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp() * 1000)


def in_window(kind, tau, mid):
    if tau is None: return False
    if kind == 'updown': return 300 <= tau <= 840
    return 600 <= tau <= 3300 and mid is not None and 0.1 <= mid <= 0.9


def main():
    data = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/bot/data')
    days = float(sys.argv[2]) if len(sys.argv) > 2 else 3.0
    sys.stdout.reconfigure(line_buffering=True)
    t0 = time.time()
    since_ms = int((time.time() - days * 86400) * 1000)
    first_day = time.strftime('%Y-%m-%d', time.gmtime(since_ms / 1000))
    since_iso = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(since_ms / 1000)).encode()

    # -- Results: the audit's settlements (positions) and the recordings' result lines (every scanned market).
    results = {}
    audit_files = sorted(f for f in glob.glob(os.path.join(data, 'audit', 'audit-*.jsonl')) if os.path.basename(f)[6:16] >= first_day)
    snaps = []
    for f in audit_files:
        with open(f, 'rb') as fh:
            for line in fh:
                head = line[:200]
                i = head.find(b'"ts":"')
                if i >= 0 and head[i + 6:i + 25] < since_iso: continue
                if b'"kind":"settlement"' in head:
                    try: d = json.loads(line).get('data') or {}
                    except Exception: continue
                    if d.get('result') in ('yes', 'no'): results[d.get('ticker')] = d['result']
                    continue
                if b'"kind":"decision"' not in head or b'"features":' not in line: continue
                try: r = json.loads(line)
                except Exception: continue
                d = r.get('data') or {}
                fv, p, shift, tau = num(d.get('fv')), num(d.get('pYes')), num(d.get('modelShift')), num(d.get('tauSec'))
                bid, ask = num(d.get('bid')), num(d.get('ask'))
                mid = (bid + ask) / 2 if bid is not None and ask is not None else None
                t = d.get('ticker') or ''
                m = TICKER.match(t)
                if fv is None or p is None or shift is None or not m or not in_window(d.get('kind'), tau, mid): continue
                ft = d.get('features') or {}
                snaps.append({'ticker': t, 'asset': m.group(1), 'close': round((iso_ms(r['ts']) + tau * 1000) / 60000) * 60000,
                              'fv': fv, 'p': p, 'model': sigmoid(logit(fv) + shift), 'market': num(d.get('pMarket')), 'mid': mid,
                              'snnBias': num(ft.get('snn_bias')), 'snnCal': num(ft.get('snn_cal_h')), 'snnSurprise': num(ft.get('snn_surprise_h')), 'snnGov': num(ft.get('snn_gov_h'))})
    rec = sorted(f for f in glob.glob(os.path.join(data, 'recordings', 'md-*.jsonl*')) if os.path.basename(f)[3:13] >= first_day and not f.endswith('.tmp'))
    for f in rec:
        # grep reads a day's recordings far faster than Python does (zcat feeds it a gzipped day; no shell).
        try:
            if f.endswith('.gz'):
                z = subprocess.Popen(['zcat', '--', f], stdout=subprocess.PIPE)
                out = subprocess.run(['grep', '-a', '-F', '"k":"result"'], stdin=z.stdout, capture_output=True).stdout
                z.stdout.close(); z.wait()
            else:
                out = subprocess.run(['grep', '-a', '-F', '"k":"result"', '--', f], capture_output=True).stdout
        except Exception as e:
            print(f'  ({os.path.basename(f)}: {e})'); continue
        for line in out.splitlines():
            try: x = json.loads(line)
            except Exception: continue
            if x.get('result') in ('yes', 'no'): results[x.get('ticker')] = x['result']
    snaps = [s for s in snaps if s['ticker'] in results]
    for s in snaps: s['y'] = 1 if results[s['ticker']] == 'yes' else 0
    markets = {s['ticker'] for s in snaps}
    windows = {(s['asset'], s['close']) for s in snaps}
    with_snn = sum(1 for s in snaps if s['snnBias'] is not None)
    tilted = sum(1 for s in snaps if abs(s['p'] - s['model']) > 1e-6)
    print(f"audit {[os.path.basename(f) for f in audit_files]}, recordings {[os.path.basename(f) for f in rec]}: {len(results)} results  ({time.time() - t0:.0f} s)")
    print(f"snapshots in the entry window with a result: {len(snaps)} on {len(markets)} contracts, {len(windows)} settlements;"
          f" with an SNN reading {with_snn}, with a TA tilt {tilted} (last {days:g} days)")
    if not snaps: return

    def compare(name, variant, base, only=None):
        """variant / base: functions of a snapshot -> probability (None = not available)."""
        per_ticker = collections.defaultdict(list)
        key = {}
        for s in snaps:
            if only and not only(s): continue
            a, b = variant(s), base(s)
            if a is None or b is None: continue
            per_ticker[s['ticker']].append(ll(a, s['y']) - ll(b, s['y']))
            key[s['ticker']] = (s['close'], s['asset'])
        per_window = collections.defaultdict(list)
        for t, ds in per_ticker.items(): per_window[key[t]].append(sum(ds) / len(ds))
        series = [sum(v) / len(v) for k, v in sorted(per_window.items())]
        if len(series) < 10:
            print(f"  {name:58s} {len(series)} settlements: too few"); return
        m, stat = dm(series)
        print(f"  {name:58s} {len(series):5d} settlements  log loss {'saved' if m <= 0 else 'added'} {abs(m):.5f} a contract"
              f"  p(better) {norm_cdf(stat):.3f}  p(worse) {1 - norm_cdf(stat):.3f}")

    model = lambda s: s['model']
    print('\n== 1. baselines: each price against Kalshi\'s (calibrated mid; saved = better than the market)')
    market = lambda s: s['market']
    compare('math fair value', lambda s: s['fv'], market)
    compare('meta-model', model, market)
    compare('the bot\'s price (meta-model + TA tilt)', lambda s: s['p'], market)
    print('\n== 2. the SNN blended into the meta-model\'s price (saved = better than the meta-model alone)')

    def conf(s):
        c = s['snnCal'] if s['snnCal'] is not None else 1.0
        if s['snnSurprise'] is not None and s['snnSurprise'] > 0: c *= min(1.0, 1 / s['snnSurprise'])
        if s['snnGov'] is not None: c *= 1 - 0.5 * s['snnGov']
        return max(0.0, min(1.0, c))

    def snn_blend(a, use_c=True):
        def f(s):
            if s['snnBias'] is None: return None
            ps = sigmoid(logit(s['fv']) + s['snnBias'])
            w = a * (conf(s) if use_c else 1.0)
            return (1 - w) * s['model'] + w * ps
        return f
    for a in (0.1, 0.25, 0.5, 1.0):
        compare(f'SNN at {a} x confidence', snn_blend(a), model)
    compare('SNN at 0.25, confidence ignored', snn_blend(0.25, False), model)
    compare('SNN alone (its own probability)', snn_blend(1.0, False), model)
    print('\n== 3. the TA network\'s tilt on the meta-model\'s price (saved = better than the meta-model alone)')
    for k in (0.5, 1.0, 2.0):
        compare(f'TA tilt x {k}', lambda s, k=k: max(0.001, min(0.999, s['model'] + k * (s['p'] - s['model']))), model, only=lambda s: abs(s['p'] - s['model']) > 1e-6)

    print('\n== 4. the rule book\'s trial rows (data/models/rule_book.json): passing rows, and rows positive on both periods')
    f = os.path.join(data, 'models', 'rule_book.json')
    try: book = json.load(open(f))
    except Exception as e: print(f'  no rule book: {e}'); book = None
    if book:
        rows = book.get('rows') or []
        trial = [r for r in rows if r.get('pass') or ((r.get('expBps') or 0) > 0 and (r.get('expConfBps') or 0) > 0 and (r.get('hitConf') or 0) >= 0.5 and (r.get('nConf') or 0) >= TRIAL_MIN_CONF)]
        by = collections.Counter((r.get('h'), r.get('kind')) for r in trial)
        print(f"  {len(rows)} rows ({book.get('from')}..{book.get('to')}, confirmation from {book.get('splitAt')}): {sum(1 for r in rows if r.get('pass'))} passed, {len(trial)} trial rows"
              f"  by horizon and kind: {dict(sorted(by.items(), key=lambda kv: (kv[0][0] or 0, str(kv[0][1]))))}")
        for r in sorted(trial, key=lambda r: -(r.get('hitConf', 0) - 0.5) * r.get('nConf', 0))[:12]:
            print(f"    {r.get('kind')}|{r.get('id')}|{r.get('tf')} {r.get('h')}h {r.get('cls')}: discovery n {r.get('n')} hit {r.get('hit')} {r.get('expBps')} bps (p {r.get('p')}),"
                  f" confirmation n {r.get('nConf')} hit {r.get('hitConf')} {r.get('expConfBps')} bps")
    print(f"\n(done in {time.time() - t0:.0f} s)")


if __name__ == '__main__':
    main()

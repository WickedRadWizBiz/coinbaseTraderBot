#!/usr/bin/env python3
"""Sinusoid study (read-only; Steven, Oct 30 2026): can a sine-wave model of the price call the direction of the next
seconds to minutes (for snipe entries) or the turns and peaks (for exits) better than a coin flip and simple baselines,
after the spread and the taker fee? The exit curve (bot/strategy/sinuousExit.ts) was meant to do this; its cross has been
off since the Oct 23-24 exit labs (SINUOUS_CROSS=false).

Reads a copy of the market-data recordings (md-YYYY-MM-DD.jsonl[.gz]): every 15-minute crypto contract's YES book top a
second at a time and each coin's settlement index a second at a time. Nothing about the bot's own trades is read.

Usage: sine_study.py <data dir> [hours=24] [until=now]   (the contracts open in the `hours` up to `until`, ISO UTC)
       sine_study.py --selftest                           (the methods on a known wave and on a random walk)

Methods (causal, one-second bars; each gives a signal whose sign is the direction it calls):
  ehlers L   John Ehlers' frequency-domain predictor ("A New Look at Prediction", 2026): a roofing high-pass, a one-octave
             band-pass (SuperSmoother L, high-pass 2L), RMS-normalised in-phase wave, its two-bar-difference quadrature
             (the Hilbert transform) and a 45 degree phase lead: the lead wave minus the in-phase wave, the cycle's predicted
             change over the next eighth of a cycle.
  corr N     Ehlers' correlation cycle ("Correlation as a Cycle Indicator", 2019): the phasor angle of the last N seconds
             against a cosine and a negative sine of period N, never regressing; cycle mode is long below 0 degrees and
             short above it, trend mode (the angle advancing under half the cycle's rate) holds the trend's side.
  osc P      a harmonic-oscillator Kalman filter (Harvey's stochastic cycle: period P, damped over one period) on the
             high-passed price: its predicted change an eighth of a cycle ahead.
  ou curve   the bot's exit curve (deploy/cross_study.py's port of sinuousExit.ts, crypto_15m): its velocity.
Baselines: momentum (the change over the last h seconds), reversal (minus that), the book's top-size imbalance, the coin's
last 10 s (for a contract), and a coin flip (50%).

Prints:
  S0. the methods on a known wave and on a random walk (each must call the wave and nothing on the walk);
  S1. is there a cycle to find: variance ratios and autocorrelations of the index and of the contracts' mid;
  S2. direction: hit rate on the next 10 / 30 / 60 / 120 s against 50%, and a taker round trip's net after fees;
  S3. turns: after a predicted top, does the price fall 1c / 2c before it rises as much (50% on a fair coin)?
  S4. snipe trades: entries at predicted bottoms (YES) and tops (NO) taken at the ask and sold at +2c / +4c net, against
      entries at every minute on both sides; and exits at the method's predicted top on those every-minute entries.
"""
import bisect, collections, datetime, glob, json, math, os, random, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cross_study import Tracker, js_round, lines_of, logit, micro_price, opener, seek_time, taker_fee  # noqa: E402

ASSETS = ('BTC', 'ETH', 'SOL', 'XRP', 'DOGE')
ORDER = 20             # contracts an order ($10-$20 at 50-100c): the taker fee's rounding is per order
WARM = 120             # seconds of a contract's window before its first call (the short filters settle)
LAST_SHARE = 0.10      # Steven's rule: the last 10% of the window rides to settlement (no entry or snipe there)
HORIZONS = (10, 30, 60, 120)
MIN_PROFIT = 0.015     # SINUOUS_MIN_PROFIT_CENTS: the curve's take-profit floor, a contract after fees
REFRACTORY = 10        # seconds between two turn calls of one kind


# ---- Filters ---------------------------------------------------------------------------------------------------------

def _poles(period):
    q = math.exp(-1.414 * math.pi / period)
    return 2 * q * math.cos(1.414 * math.pi / period), q * q


def highpass(xs, period):
    """Ehlers' two-pole high-pass ($Highpass): 12 dB an octave below `period`; zero for the first three bars."""
    c1, c2 = _poles(period)
    a0 = (1 + c1 + c2) / 4
    out = [0.0] * len(xs)
    for i in range(3, len(xs)):
        out[i] = a0 * (xs[i] - 2 * xs[i - 1] + xs[i - 2]) + c1 * out[i - 1] - c2 * out[i - 2]
    return out


def supersmoother(xs, period):
    """Ehlers' two-pole SuperSmoother ($SuperSmoother): the input itself for the first three bars."""
    c1, c2 = _poles(period)
    a0 = (1 - c1 + c2) / 2
    out = list(xs[:3]) + [0.0] * max(0, len(xs) - 3)
    for i in range(3, len(xs)):
        out[i] = a0 * (xs[i] + xs[i - 1]) + c1 * out[i - 1] - c2 * out[i - 2]
    return out


def rms(xs, n):
    out, s = [0.0] * len(xs), 0.0
    for i, x in enumerate(xs):
        s += x * x
        if i >= n: s -= xs[i - n] * xs[i - n]
        out[i] = math.sqrt(s / min(i + 1, n)) if s > 0 else 0.0
    return out


def ehlers(xs, lp, lead=45.0):
    """The dominant cycle's predicted change over the next `lead` degrees, in standard deviations."""
    bp = supersmoother(highpass(highpass(xs, 5 * lp), 2 * lp), lp)
    r = rms(bp, 10 * lp)
    inph = [b / v if v > 0 else 0.0 for b, v in zip(bp, r)]
    quad = [0.0, 0.0] + [inph[i] - inph[i - 2] for i in range(2, len(inph))]
    qr = rms(quad, 10 * lp)
    c, s = math.cos(math.radians(lead)), math.sin(math.radians(lead))
    return [(c - 1) * a + s * (q / v if v > 0 else 0.0) for a, q, v in zip(inph, quad, qr)]


def corr_cycle(xs, n):
    """Ehlers' correlation cycle: the position (+1 / -1) its phasor angle implies each second, 0 before a full window.
    The correlations against a cosine and a negative sine over one period are the real and minus the imaginary part of
    the window's DFT bin at that period (the cosine and sine sum to zero over a period), kept as a running sum."""
    w = 2 * math.pi / n
    e = complex(math.cos(w), math.sin(w))
    trend_rate = 180.0 / n   # degrees a second: under half the cycle's own rate the cycle has failed (trend mode)
    out = [0] * len(xs)
    acc, prev = 0j, None
    for i, x in enumerate(xs):
        acc = x + e * acc - (xs[i - n] if i >= n else 0.0)
        if i < n - 1: continue
        if i % 600 == 0: acc = sum(xs[i - k] * complex(math.cos(w * k), math.sin(w * k)) for k in range(n))  # rounding
        real, imag = acc.real, -acc.imag
        if imag == 0: angle = prev if prev is not None else 0.0
        else:
            angle = 90 + math.degrees(math.atan(real / imag))
            if imag > 0: angle -= 180
        if prev is not None and prev - angle < 270 and angle < prev: angle = prev   # the phase never runs backwards
        state = -1 if angle < 0 else 1
        trend = prev is not None and abs(angle - prev) < trend_rate
        out[i] = state if trend else -state      # cycle mode: long while the angle is below 0 (the wave rising)
        prev = angle
    return out


def osc_kalman(xs, period, q=0.05):
    """Harvey's stochastic cycle on the high-passed price (RMS-normalised, unit observation noise): [c, c*] rotating
    360/period degrees a second, damped over one period; its predicted change an eighth of a cycle ahead."""
    y = highpass(xs, 5 * period)
    r = rms(y, 10 * period)
    lam, rho = 2 * math.pi / period, math.exp(-1.0 / period)
    cl, sl = rho * math.cos(lam), rho * math.sin(lam)
    h = period / 8.0
    ch, sh = rho ** h * math.cos(lam * h), rho ** h * math.sin(lam * h)
    c = cs = 0.0
    p00, p01, p10, p11 = 1.0, 0.0, 0.0, 1.0
    out = [0.0] * len(xs)
    for i in range(len(xs)):
        obs = y[i] / r[i] if r[i] > 0 else 0.0
        nc, ncs = cl * c + sl * cs, -sl * c + cl * cs
        a00, a01 = cl * p00 + sl * p10, cl * p01 + sl * p11
        a10, a11 = -sl * p00 + cl * p10, -sl * p01 + cl * p11
        n00, n01 = a00 * cl + a01 * sl + q, -a00 * sl + a01 * cl
        n10, n11 = a10 * cl + a11 * sl, -a10 * sl + a11 * cl + q
        k0, k1 = n00 / (n00 + 1.0), n10 / (n00 + 1.0)
        err = obs - nc
        c, cs = nc + k0 * err, ncs + k1 * err
        p00, p01, p10, p11 = (1 - k0) * n00, (1 - k0) * n01, n10 - k1 * n00, n11 - k1 * n01
        out[i] = ch * c + sh * cs - c
    return out


def momentum(xs, h):
    return [xs[i] - xs[i - h] if i >= h else 0.0 for i in range(len(xs))]


def sgn(x):
    return 1 if x > 0 else -1 if x < 0 else 0


CYCLE_METHODS = [('ehlers 10', lambda xs: ehlers(xs, 10)), ('ehlers 30', lambda xs: ehlers(xs, 30)), ('ehlers 90', lambda xs: ehlers(xs, 90)),
                 ('corr 20', lambda xs: corr_cycle(xs, 20)), ('corr 60', lambda xs: corr_cycle(xs, 60)), ('corr 180', lambda xs: corr_cycle(xs, 180)),
                 ('osc 20', lambda xs: osc_kalman(xs, 20)), ('osc 60', lambda xs: osc_kalman(xs, 60)), ('osc 180', lambda xs: osc_kalman(xs, 180))]
# On a 15-minute contract's own price only the short ones settle within the window.
CONTRACT_CYCLES = [m for m in CYCLE_METHODS if m[0] in ('ehlers 10', 'ehlers 30', 'corr 20', 'corr 60', 'osc 20', 'osc 60')]


def turns(sig, lo, hi):
    """Predicted tops (the call flips from up to down) and bottoms, at most one of a kind every REFRACTORY seconds."""
    tops, bottoms, prev, lt, lb = [], [], 0, -10 ** 9, -10 ** 9
    for i in range(max(1, lo), hi):
        d = sgn(sig[i])
        if d == 0: continue
        if prev > 0 and d < 0 and i - lt >= REFRACTORY: tops.append(i); lt = i
        elif prev < 0 and d > 0 and i - lb >= REFRACTORY: bottoms.append(i); lb = i
        prev = d
    return tops, bottoms


def first_passage(xs, i, b, hi):
    """+1 when xs rises b above xs[i] before falling b below it (before index hi), -1 for the fall, 0 for neither."""
    x0 = xs[i]
    for j in range(i + 1, hi):
        if xs[j] >= x0 + b - 1e-12: return 1
        if xs[j] <= x0 - b + 1e-12: return -1
    return 0


def zline(hits, n, p0=0.5):
    return (hits / n - p0) / math.sqrt(p0 * (1 - p0) / n) if n and 0 < p0 < 1 else 0.0


def cell(hits, n, p0=0.5):
    """A rate and its z against p0 (a fair coin; or chance given how often the method calls up and the price goes up)."""
    return f'{100 * hits / n:5.1f}% z{zline(hits, n, p0):+5.1f}' if n else '    -        '


def cluster_se(groups):
    """The mean a trade and its standard error with the trades clustered by contract: groups = [(trades, sum), ...]."""
    n = sum(g[0] for g in groups)
    if not n: return 0.0, 0.0
    m, k = sum(g[1] for g in groups) / n, len(groups)
    v = sum((g[1] - m * g[0]) ** 2 for g in groups) * (k / (k - 1) if k > 1 else 1.0)
    return m, math.sqrt(v) / n


def chance(calls_up, moves_up, n):
    """The hit rate a call independent of the move would get, given the shares of up calls and up moves."""
    a, b = calls_up / n, moves_up / n
    return a * b + (1 - a) * (1 - b) if n else 0.5


# ---- Data ------------------------------------------------------------------------------------------------------------

def load(data, need_from, need_to):
    """Every 15-minute contract's YES top of book a second at a time, each coin's index, the contracts' terms and the
    settlement results the bot recorded."""
    rec_dir = os.path.join(data, 'recordings')
    d0, d1 = (time.strftime('%Y-%m-%d', time.gmtime(t / 1000)) for t in (need_from, need_to))
    files = sorted(f for f in glob.glob(os.path.join(rec_dir, 'md-*.jsonl*')) if d0 <= os.path.basename(f)[3:13] <= d1 and not f.endswith('.tmp'))
    plain = {os.path.basename(f)[3:13] for f in files if f.endswith('.jsonl')}
    files = [f for f in files if f.endswith('.jsonl') or os.path.basename(f)[3:13] not in plain]
    books, tops, cur, index, terms, results = {}, collections.defaultdict(list), {}, collections.defaultdict(list), {}, {}
    lines = 0

    def top_of(t):
        bids, asks = books[t]
        bb = max(bids) if bids else None
        ba = min(asks) if asks else None
        return (bb / 1e4 if bb is not None else None, bids[bb] if bb is not None else 0, ba / 1e4 if ba is not None else None, asks[ba] if ba is not None else 0)

    for f in files:
        with opener(f) as fh:
            if not f.endswith('.gz'): seek_time(fh, os.path.getsize(f), need_from)
            for line in lines_of(fh):
                lines += 1
                tm = line[5:18]
                if tm.isdigit():
                    tv = int(tm)
                    if tv < need_from: continue
                    if tv > need_to: break
                ks = line.find(b'"k":"', 0, 48)
                if ks < 0: continue
                ke = line.find(b'"', ks + 5)
                kind = line[ks + 5:ke]
                if kind in (b'delta', b'book', b'market', b'result'):
                    ts_ = line.find(b'"ticker":"', ke)
                    if ts_ < 0 or line.find(b'15M-', ts_ + 10, ts_ + 40) < 0: continue
                    r = json.loads(line)
                    t = r['ticker']
                    if kind == b'market': terms[t] = r; continue
                    if kind == b'result':
                        if r.get('result') in ('yes', 'no'): results[t] = r['result']
                        continue
                    sec = (r.get('t') or r.get('ts')) // 1000
                    if t in books and sec > cur.get(t, 0):
                        top = top_of(t)
                        if not tops[t] or tops[t][-1][1:] != top: tops[t].append((cur.get(t, sec - 1) + 1, *top))
                    cur[t] = sec
                    if kind == b'book':
                        books[t] = ({js_round(l['price'] * 1e4): l['size'] for l in r.get('bids') or [] if l.get('size', 0) > 0},
                                    {js_round(l['price'] * 1e4): l['size'] for l in r.get('asks') or [] if l.get('size', 0) > 0})
                    elif t in books:
                        m = books[t][0] if r.get('side') == 'bid' else books[t][1]
                        key = js_round(r['price'] * 1e4)
                        nxt = m.get(key, 0) + r['delta']
                        if nxt <= 1e-9: m.pop(key, None)
                        else: m[key] = nxt
                elif kind == b'index':
                    r = json.loads(line)
                    if r.get('src') == 'proxy' or r.get('asset') not in ASSETS: continue
                    sec = int((r.get('ts') or r.get('t')) // 1000)
                    s = index[r['asset']]
                    if s and s[-1][0] == sec: s[-1] = (sec, float(r['value']))
                    elif not s or sec > s[-1][0]: s.append((sec, float(r['value'])))
    for t in books:
        top = top_of(t)
        if not tops[t] or tops[t][-1][1:] != top: tops[t].append((cur.get(t, 0) + 1, *top))
    return tops, index, terms, results, files, lines


def ms_of(v):
    if isinstance(v, (int, float)): return int(v)
    if isinstance(v, str) and v:
        try: return int(datetime.datetime.fromisoformat(v.replace('Z', '+00:00')).timestamp() * 1000)
        except ValueError: return None
    return None


def index_grid(series, t0, t1, stale=5):
    """The index's log a second at a time over [t0, t1): forward filled (the first print backfills), and fresh flags."""
    n = t1 - t0
    xs, fresh = [None] * n, [False] * n
    j, last, last_sec = 0, None, None
    for k in range(n):
        sec = t0 + k
        while j < len(series) and series[j][0] <= sec:
            last, last_sec = math.log(series[j][1]), series[j][0]; j += 1
        if last is not None:
            xs[k] = last
            fresh[k] = sec - last_sec <= stale
    first = next((x for x in xs if x is not None), None)
    if first is None: return None, None
    for k in range(n):
        if xs[k] is None: xs[k] = first
        else: break
    return xs, fresh


class Contract:
    """One 15-minute contract a second at a time from its open to its close: the YES book's top, mid and micro-price."""

    def __init__(self, ticker, open_s, close_s, changes, result=None):
        self.ticker, self.open, self.close = ticker, open_s, close_s
        self.asset = ticker[2:ticker.index('15M')]
        n = close_s - open_s
        secs = [c[0] for c in changes]
        self.bid, self.bsz, self.ask, self.asz = [None] * n, [0] * n, [None] * n, [0] * n
        for k in range(n):
            i = bisect.bisect_right(secs, open_s + k) - 1
            if i >= 0: _, self.bid[k], self.bsz[k], self.ask[k], self.asz[k] = changes[i]
        self.ok = [b is not None and a is not None and 0 < b < a < 1 for b, a in zip(self.bid, self.ask)]
        self.mid = [(b + a) / 2 if o else None for b, a, o in zip(self.bid, self.ask, self.ok)]
        mp = [micro_price((b, bs), (a, az)) if o else None for b, bs, a, az, o in zip(self.bid, self.bsz, self.ask, self.asz, self.ok)]
        first = next((x for x in mp if x is not None), None)
        self.valid = first is not None and sum(self.ok) >= 0.8 * n
        if not self.valid: return
        last = first
        self.x = []
        for v in mp:
            if v is not None: last = v
            self.x.append(logit(last))
        lastm, self.midf = None, []
        for v in self.mid:
            if v is not None: lastm = v
            self.midf.append(lastm if lastm is not None else first)
        # The result the bot recorded, else the book's last top in the last ten seconds: a YES bid of 90c or more, or a YES
        # ask of 10c or less (once the close is decided the losing side's bids empty, so the book is often one-sided);
        # unknown when the close was still in doubt.
        self.payout = {'yes': 1.0, 'no': 0.0}.get(result) if result else None
        if self.payout is None:
            for b, a in zip(reversed(self.bid[-10:]), reversed(self.ask[-10:])):
                if b is None and a is None: continue
                if b is not None and b >= 0.9: self.payout = 1.0
                elif a is not None and a <= 0.1: self.payout = 0.0
                break
        self.lo = WARM
        self.hi = n - int(LAST_SHARE * n)   # the last 10% rides to settlement: no call is acted on there

    def side_bid(self, k, side):
        if not self.ok[k]: return None
        return self.bid[k] if side > 0 else round(1 - self.ask[k], 4)

    def side_ask(self, k, side):
        if not self.ok[k]: return None
        return self.ask[k] if side > 0 else round(1 - self.bid[k], 4)


def fee1(price):
    return taker_fee(ORDER, price) / ORDER if 0 < price < 1 else 0.0


# ---- Sections --------------------------------------------------------------------------------------------------------

def variance_ratios(rets, qs):
    """Lo-MacKinlay variance ratios of a list of return runs (each run a list of one-second returns) and their z."""
    out = {}
    n1 = sum(len(r) for r in rets)
    if n1 < 100: return out
    mu = sum(sum(r) for r in rets) / n1
    v1 = sum((x - mu) ** 2 for r in rets for x in r) / n1
    if v1 <= 0: return out
    for q in qs:
        num, cnt = 0.0, 0
        for r in rets:
            if len(r) < q: continue
            s = sum(r[:q])
            num += (s - q * mu) ** 2; cnt += 1
            for i in range(q, len(r)):
                s += r[i] - r[i - q]
                num += (s - q * mu) ** 2; cnt += 1
        if cnt:
            vr = num / cnt / (q * v1)
            out[q] = (vr, (vr - 1) / math.sqrt(2 * (2 * q - 1) * (q - 1) / (3 * q * n1)))
    return out


def autocorr(rets, lags):
    n1 = sum(len(r) for r in rets)
    if n1 < 100: return {}
    mu = sum(sum(r) for r in rets) / n1
    v = sum((x - mu) ** 2 for r in rets for x in r)
    out = {}
    for L in lags:
        c = sum((r[i] - mu) * (r[i - L] - mu) for r in rets for i in range(L, len(r)))
        out[L] = c / v if v > 0 else 0.0
    return out, 2 / math.sqrt(n1)


def selftest_series(seed=7, n=6000):
    rng = random.Random(seed)
    wave = [0.6 * math.sin(2 * math.pi * k / 60) + 0.25 * math.sin(2 * math.pi * k / 23 + 1) + rng.gauss(0, 0.15) for k in range(n)]
    walk, x = [], 0.0
    for _ in range(n):
        x += rng.gauss(0, 0.1); walk.append(x)
    return wave, walk


def section0():
    print('== S0. the methods on a known wave (a 60 s sine plus a 23 s one and noise) and on a random walk: the hit rate of each'
          '\n   call on the next 5 / 10 / 20 s (at random times after a 1000 s warm-up, so the samples do not lock onto the wave\'s'
          '\n   phase). A method must call the wave well above 50% and stay at 50% on the walk.')
    wave, walk = selftest_series()
    rows = [(name, f) for name, f in CYCLE_METHODS] + [('momentum', None), ('reversal', None)]
    hs = (5, 10, 20)
    print(f"   {'method':<12} " + ' '.join(f'{"wave " + str(h) + "s":>14}' for h in hs) + ' ' + ' '.join(f'{"walk " + str(h) + "s":>14}' for h in hs))
    for name, f in rows:
        cells = []
        for xs in (wave, walk):
            for h in hs:
                rng = random.Random(h)
                sig = f(xs) if f else [(1 if name == 'momentum' else -1) * v for v in momentum(xs, h)]
                hits = cnt = 0
                i = 1000
                while i < len(xs) - h:
                    d, y = sgn(sig[i]), sgn(xs[i + h] - xs[i])
                    if d and y: cnt += 1; hits += d == y
                    i += h + rng.randrange(h)
                cells.append(cell(hits, cnt))
        print(f'   {name:<12} ' + ' '.join(f'{c:>14}' for c in cells))

class Sparse:
    """Range maxima (or minima) in O(1) after O(n log n) setup, to find the first second a path reaches a level."""

    def __init__(self, xs, fn):
        self.t = [list(xs)]
        w = 1
        while 2 * w <= len(xs):
            prev = self.t[-1]
            self.t.append([fn(prev[i], prev[i + w]) for i in range(len(xs) - 2 * w + 1)])
            w *= 2

    def first(self, lo, hi, ok):
        """The first index in [lo, hi) whose value passes ok (ok monotone: it passes a block's max (min) when any value in
        the block passes), or None: skip whole blocks that miss, largest first (the distance's binary digits)."""
        if lo >= hi: return None
        p = lo
        for k in range(len(self.t) - 1, -1, -1):
            w = 1 << k
            if p + w <= hi and not ok(self.t[k][p]): p += w
        return p if p < hi and ok(self.t[0][p]) else None


def fp_fast(up, dn, x0, b, lo, hi):
    """first_passage on sparse tables: +1 when the path rises b first, -1 when it falls b first, 0 for neither."""
    u = up.first(lo, hi, lambda v: v >= x0 + b - 1e-12)
    d = dn.first(lo, hi, lambda v: v <= x0 - b + 1e-12)
    if u is None and d is None: return 0
    if d is None or (u is not None and u < d): return 1
    return -1


def main():
    sys.stdout.reconfigure(line_buffering=True)
    if len(sys.argv) > 1 and sys.argv[1] == '--selftest':
        section0(); return
    data = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/bot/data')
    hours = float(sys.argv[2]) if len(sys.argv) > 2 else 24.0
    until = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] not in ('', 'now') else None
    now = datetime.datetime.strptime(until, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc).timestamp() if until else time.time()
    since = int(now - hours * 3600)
    t0 = time.time()
    section0()

    # The index from 20 minutes before the window (the long filters' warm-up); the contracts open in the window.
    i0, i1 = since - 1200, int(now) + 1
    tops, index, terms, results, files, lines = load(data, i0 * 1000, i1 * 1000 + 1_800_000)
    contracts = []
    for t, tm in terms.items():
        o, c = ms_of(tm.get('openTime')), ms_of(tm.get('closeTime'))
        if not o or not c or not tops.get(t) or not (since * 1000 <= o and c <= i1 * 1000) or not (600_000 <= c - o <= 1_200_000): continue
        k = Contract(t, o // 1000, c // 1000, tops[t], results.get(t))
        if k.valid: contracts.append(k)
    contracts.sort(key=lambda k: (k.open, k.ticker))
    by_asset = collections.Counter(k.asset for k in contracts)
    print(f"\nrecordings {[os.path.basename(f) for f in files]}: {lines} lines; {len(contracts)} 15-minute contracts with a book "
          f"({', '.join(f'{a} {n}' for a, n in sorted(by_asset.items()))}; {sum(1 for k in contracts if k.payout is not None)} with a result, "
          f"{sum(1 for t in results if any(k.ticker == t for k in contracts))} of them recorded); "
          f"index for {sorted(a for a in index if index[a])}  ({time.time() - t0:.0f} s)")
    if not contracts: return

    # Index signals over the whole stretch, per coin.
    grids, isig = {}, {}
    for a in ASSETS:
        if not index.get(a): continue
        xs, fresh = index_grid(index[a], i0, i1)
        if xs is None: continue
        grids[a] = (xs, fresh)
        isig[a] = {name: f(xs) for name, f in CYCLE_METHODS}
        isig[a]['coin 10 s'] = momentum(xs, 10)
    print(f'index signals ready ({time.time() - t0:.0f} s)')

    # ---- S1. Is there a cycle to find?
    print('\n== S1. is there a cycle to find? Variance ratios VR(q) of one-second returns (1 = a random walk; under 1 the price'
          '\n   reverts, a cycle\'s mark; over 1 it trends) and autocorrelations (a cycle of period P shows a negative one near P/2)')
    for a, (xs, fresh) in sorted(grids.items()):
        run, rets = [], []
        for k in range(1200, len(xs)):
            if fresh[k] and fresh[k - 1]: run.append(xs[k] - xs[k - 1])
            elif run: rets.append(run); run = []
        if run: rets.append(run)
        vr = variance_ratios(rets, (5, 15, 30, 60, 120, 300))
        ac = autocorr(rets, (1, 2, 5, 10, 30, 60, 120))
        if not vr or not ac: continue
        acs, band = ac
        print(f"   {a:<5} index  VR " + '  '.join(f'{q}s {v:.2f} (z{z:+.1f})' for q, (v, z) in vr.items())
              + f"\n               autocorr " + '  '.join(f'{L}s {c:+.3f}' for L, c in acs.items()) + f'  (noise band +-{band:.3f})')
    crets = []
    for k in contracts:
        run = []
        for j in range(k.lo, k.hi):
            if k.ok[j] and k.ok[j - 1]: run.append(100 * (k.mid[j] - k.mid[j - 1]))
            elif run: crets.append(run); run = []
        if run: crets.append(run)
    vr = variance_ratios(crets, (5, 15, 30, 60, 120))
    ac = autocorr(crets, (1, 2, 5, 10, 30, 60))
    if vr and ac:
        print(f"   15-minute contracts' YES mid (cents, pooled)  VR " + '  '.join(f'{q}s {v:.2f}' for q, (v, z) in vr.items())
              + f"\n               autocorr " + '  '.join(f'{L}s {c:+.3f}' for L, c in ac[0].items()) + f'  (noise band +-{ac[1]:.3f}; the bid-ask bounce makes lag 1 negative)')
    # ---- Per contract: the signals, then S2-S4 accumulated (the signals are dropped after each contract).
    names = [m[0] for m in CONTRACT_CYCLES] + ['ou curve'] + ['coin ' + m[0] for m in CYCLE_METHODS] + ['coin 10 s', 'imbalance', 'momentum 10 s']
    entry_names = ['every minute (ref)', 'momentum 10 s'] + [n for n in names if n not in ('imbalance', 'momentum 10 s')]
    s2 = collections.defaultdict(lambda: [0, 0, 0, 0, 0, 0.0, 0.0, 0, 0])   # (name, h) -> hits, moves, flat, calls, trades, move, net, up calls, up moves
    s3 = collections.defaultdict(lambda: {'tops': 0, 'bottoms': 0, 'top': {1: [0, 0], 2: [0, 0]}, 'bottom': {1: [0, 0], 2: [0, 0]}, 'mk': [0.0, 0.0, 0]})
    s4 = collections.defaultdict(lambda: [0, 0, 0.0, 0, 0.0, 0.0])    # entries -> trades, hits +2c, net +2c, hits +4c, net +4c, hold
    s4x = collections.defaultdict(lambda: [0, 0, 0.0])                 # exit rule on the every-minute entries -> trades, sold at a top, net
    s4g, s4d = collections.defaultdict(list), collections.defaultdict(list)   # per contract: (trades, +4c net) / (trades, net minus the +4c snipe's)
    n_settled = 0
    for ci, k in enumerate(contracts):
        s = {name: f(k.x) for name, f in CONTRACT_CYCLES}
        tr, v = Tracker('crypto_15m'), []
        for j in range(len(k.x)):
            r = tr.update((k.open + j) * 1000, 1, (k.bid[j], k.bsz[j]) if k.ok[j] else None, (k.ask[j], k.asz[j]) if k.ok[j] else None, k.close - k.open - j)
            v.append(r['velocity'] if r else (v[-1] if v else 0.0))
        s['ou curve'] = v
        s['imbalance'] = [((b - a) / (b + a)) if o and b + a > 0 else 0.0 for b, a, o in zip(k.bsz, k.asz, k.ok)]
        s['momentum 10 s'] = [0.0] * 10 + [k.midf[j] - k.midf[j - 10] for j in range(10, len(k.midf))]
        if k.asset in grids:
            off = k.open - i0
            for name in [m[0] for m in CYCLE_METHODS]: s['coin ' + name] = isig[k.asset][name][off:off + len(k.x)]
            s['coin 10 s'] = isig[k.asset]['coin 10 s'][off:off + len(k.x)]
        lo, hi, n = k.lo, k.hi, len(k.x)

        # S2: calls sampled every h seconds; momentum and reversal over the same h.
        for h in HORIZONS:
            for name in names + ['momentum', 'reversal']:
                if name in ('momentum', 'reversal'): sig = None
                else:
                    sig = s.get(name)
                    if sig is None: continue
                acc = s2[(name, h)]
                for j in range(lo, hi - h, h):
                    if not (k.ok[j] and k.ok[j + h]): continue
                    if sig is None:
                        if j < h or not k.ok[j - h]: continue
                        d = sgn(k.mid[j] - k.mid[j - h]) * (1 if name == 'momentum' else -1)
                    else: d = sgn(sig[j])
                    if d == 0: continue
                    y = k.mid[j + h] - k.mid[j]
                    acc[3] += 1
                    if abs(y) < 1e-9: acc[2] += 1
                    else: acc[1] += 1; acc[0] += sgn(y) == d; acc[7] += d > 0; acc[8] += y > 0
                    buy, sell = k.side_ask(j, d), k.side_bid(j + h, d)
                    acc[4] += 1; acc[5] += d * y; acc[6] += sell - buy - fee1(buy) - fee1(sell)

        # S3: first passage of the mid after each predicted top / bottom (and every 15 s for reference).
        up, dn = Sparse(k.midf, max), Sparse(k.midf, min)
        events = {'every 15 s (ref)': (list(range(lo, hi, 15)), list(range(lo, hi, 15)))}
        for name in names:
            if s.get(name) is not None: events[name] = turns(s[name], lo, hi)
        for name, (tps, bts) in events.items():
            acc = s3[name]
            for kind, evs in (('top', tps), ('bottom', bts)):
                for j in evs:
                    if not k.ok[j]: continue
                    acc['tops' if kind == 'top' else 'bottoms'] += 1
                    if kind == 'top' and j + 60 < hi and k.ok[j + 30] and k.ok[j + 60]:
                        acc['mk'][0] += k.mid[j] - k.mid[j + 30]; acc['mk'][1] += k.mid[j] - k.mid[j + 60]; acc['mk'][2] += 1
                    for c in (1, 2):
                        f = fp_fast(up, dn, k.midf[j], c / 100, j + 1, min(hi, j + 301))
                        if f == 0: continue
                        acc[kind][c][0] += f < 0 if kind == 'top' else f > 0
                        acc[kind][c][1] += 1
        del up, dn

        # S4: snipe trades (contracts with a clear result).
        if k.payout is None: continue
        n_settled += 1
        sides = {}
        for side in (1, -1):
            sb = [k.side_bid(j, side) for j in range(n)]
            sides[side] = (sb, Sparse([x if x is not None else -1.0 for x in sb], max))

        def trade_out(j, side, rule, top_evs=None):
            buy = k.side_ask(j, side)
            if buy is None: return None
            fin = fee1(buy)
            pay = k.payout if side > 0 else 1 - k.payout
            if rule == 'hold': return pay - buy - fin, False
            sb, st = sides[side]
            if isinstance(rule, float):
                t = st.first(j + 1, hi, lambda x: x > 0 and x - fee1(x) >= buy + fin + rule - 1e-9)
                if t is not None: return sb[t] - buy - fin - fee1(sb[t]), True
            else:
                i = bisect.bisect_right(top_evs, j)
                while i < len(top_evs) and top_evs[i] < hi:
                    t = top_evs[i]; i += 1
                    if sb[t] is not None and sb[t] - buy - fin - fee1(sb[t]) >= MIN_PROFIT - 1e-9: return sb[t] - buy - fin - fee1(sb[t]), True
            x = sb[hi] if hi < n else None
            net = None if x is None else x - buy - fin - fee1(x)
            if net is None or net > 0: return pay - buy - fin, False   # in profit at the last 10%: rides to settlement
            return net, False

        def entries(name):
            if name == 'every minute (ref)': return [(j, side) for j in range(lo, hi - 60, 60) for side in (1, -1)]
            sig = s.get(name)
            if sig is None: return []
            tps, bts = turns(sig, lo, hi - 60)
            out, last = [], {1: -10 ** 9, -1: -10 ** 9}
            for j, side in sorted([(j, 1) for j in bts] + [(j, -1) for j in tps]):
                if j - last[side] >= 30: out.append((j, side)); last[side] = j
            return out

        for name in entry_names:
            acc, nc, sc = s4[name], 0, 0.0
            for j, side in entries(name):
                a, b, c = trade_out(j, side, 0.02), trade_out(j, side, 0.04), trade_out(j, side, 'hold')
                if a is None or b is None or c is None: continue
                acc[0] += 1; acc[1] += a[1]; acc[2] += a[0]; acc[3] += b[1]; acc[4] += b[0]; acc[5] += c[0]
                nc += 1; sc += b[0]
            if nc: s4g[name].append((nc, sc))
        ref = entries('every minute (ref)')
        o4 = {e: trade_out(*e, 0.04) for e in ref}
        rules = [('snipe +2c', 0.02, None), ('snipe +4c', 0.04, None), ('hold', 'hold', None)]
        for name in ['momentum 10 s'] + [m for m in names if m not in ('imbalance', 'momentum 10 s')]:
            sig = s.get(name)
            if sig is not None: rules.append(('top: ' + name, 'top', turns(sig, lo, hi)))
        for label, rule, evs in rules:
            x, nc, dc = s4x[label], 0, 0.0
            for e in ref:
                o = o4[e] if rule == 0.04 else trade_out(*e, rule, (evs[0] if e[1] > 0 else evs[1]) if evs else None)
                if o is None: continue
                x[0] += 1; x[1] += o[1]; x[2] += o[0]
                if o4[e] is not None: nc += 1; dc += o[0] - o4[e][0]
            if nc: s4d[label].append((nc, dc))
        del sides
        if ci % 100 == 99: print(f'  {ci + 1} of {len(contracts)} contracts ({time.time() - t0:.0f} s)')

    # ---- Reports.
    print('\n== S2. direction: does the call say where the YES mid goes over the next h seconds? Hit rate on moves (flat ones'
          '\n   left out), sampled every h seconds from 2 minutes into each contract to its last 10%, and z against chance (the hit'
          '\n   rate a call independent of the move would get, given how often it calls up and the mid goes up: about 50%). "coin X"'
          '\n   runs the method on the coin\'s index (the contract follows the coin); the rest on the contract\'s own micro-price.')
    print(f"   {'method':<16} " + ' '.join(f'{str(h) + " s":>15}' for h in HORIZONS) + '   flat')
    for name in names + ['momentum', 'reversal']:
        accs = [s2.get((name, h)) for h in HORIZONS]
        if not any(accs): continue
        flat = sum(a[2] for a in accs if a); tot = sum(a[3] for a in accs if a)
        print(f'   {name:<16} ' + ' '.join(f'{cell(a[0], a[1], chance(a[7], a[8], a[1])) if a else "-":>15}' for a in accs) + (f'   {100 * flat / tot:3.0f}%' if tot else ''))
    print('\n   the same calls as trades: buy the called side at the ask, sell it at the bid h seconds later (taker both ways,'
          f'\n   a {ORDER}-contract order\'s fee): the mid\'s move in the call\'s favour / the net after the spread and fees, cents a contract')
    print(f"   {'method':<16} " + ' '.join(f'{str(h) + " s":>17}' for h in HORIZONS))
    for name in names + ['momentum', 'reversal']:
        accs = [s2.get((name, h)) for h in HORIZONS]
        if not any(accs): continue
        print(f'   {name:<16} ' + ' '.join(f'{(f"{100 * a[5] / a[4]:+.2f} / {100 * a[6] / a[4]:+.2f}" if a and a[4] else "-"):>17}' for a in accs))

    print('\n   the coin itself: does the call on the index say where the index goes (hit rate on the next h seconds)?')
    print(f"   {'method':<16} " + ' '.join(f'{str(h) + " s":>15}' for h in HORIZONS))
    for name in [m[0] for m in CYCLE_METHODS] + ['momentum', 'reversal']:
        cells = []
        for h in HORIZONS:
            hits = cnt = cu = mu = 0
            for a, (xs, fresh) in grids.items():
                sig = isig[a].get(name)
                for j in range(1200, len(xs) - h, h):
                    if not (fresh[j] and fresh[j + h]): continue
                    d = sgn(sig[j]) if sig is not None else sgn(xs[j] - xs[j - h]) * (1 if name == 'momentum' else -1)
                    y = sgn(xs[j + h] - xs[j])
                    if d and y: cnt += 1; hits += d == y; cu += d > 0; mu += y > 0
            cells.append(cell(hits, cnt, chance(cu, mu, cnt)))
        print(f'   {name:<16} ' + ' '.join(f'{c:>15}' for c in cells))

    print('\n== S3. turns: after a call flips from up to down (a predicted top), does the YES mid fall 1c / 2c before it rises as'
          '\n   much (within 5 minutes and before the last 10%)? Bottoms the other way. The reference row is the same question every'
          '\n   15 s (z against a fair coin); each method\'s z is against the reference row\'s rate. Markout: the mid at the call'
          '\n   minus the mid 30 / 60 s later after a top (+ = it fell: a sale there was well timed), cents.')
    print(f"   {'method':<16} {'tops':>6} {'fall 1c first':>15} {'fall 2c first':>15} {'markout 30/60s':>15}   {'bottoms':>7} {'rise 1c first':>15} {'rise 2c first':>15}")
    r0 = s3.get('every 15 s (ref)')
    base = {(kd, c): (r0[kd][c][0] / r0[kd][c][1] if r0 and r0[kd][c][1] else 0.5) for kd in ('top', 'bottom') for c in (1, 2)}
    for name in ['every 15 s (ref)'] + names:
        a = s3.get(name)
        if not a: continue
        mk = f"{100 * a['mk'][0] / a['mk'][2]:+.2f}/{100 * a['mk'][1] / a['mk'][2]:+.2f}" if a['mk'][2] else '-'
        cs = [cell(*a[kd][c], 0.5 if name == 'every 15 s (ref)' else base[(kd, c)]) for kd, c in (('top', 1), ('top', 2), ('bottom', 1), ('bottom', 2))]
        print(f"   {name:<16} {a['tops']:>6} {cs[0]:>15} {cs[1]:>15} {mk:>15}   {a['bottoms']:>7} {cs[2]:>15} {cs[3]:>15}")

    print(f'\n== S4. snipe trades on the {n_settled} of {len(contracts)} contracts with a clear result: buy the called side at the ask (a predicted bottom'
          f'\n   buys YES, a predicted top buys NO; at most one a side every 30 s, none in the last 10% or its minute before), {ORDER}'
          '\n   contracts, taker fees both ways. The snipe sells at the bid once the net is +2c (or +4c) a contract; unsold by the'
          '\n   last 10%, it rides to settlement in profit and is sold at the bid otherwise. "hold": every contract to settlement.'
          '\n   Net cents a contract; hit: the snipe filled; se: the +4c net\'s standard error with trades clustered by contract.')
    print(f"   {'entries':<20} {'trades':>7} {'snipe +2c: hit / net':>22} {'snipe +4c: hit / net':>22} {'se':>6} {'hold':>8}")
    for name in entry_names:
        a = s4.get(name)
        if not a or not a[0]: continue
        se = cluster_se(s4g.get(name, []))[1]
        print(f'   {name:<20} {a[0]:>7} {100 * a[1] / a[0]:>11.0f}% / {100 * a[2] / a[0]:+6.2f} {100 * a[3] / a[0]:>11.0f}% / {100 * a[4] / a[0]:+6.2f} {100 * se:>6.2f} {100 * a[5] / a[0]:+8.2f}')
    print('\n   exits at the predicted top, on the every-minute entries (both sides; a held NO\'s top is a predicted YES bottom):'
          f'\n   sell at the bid at the first predicted top once the net is at least {100 * MIN_PROFIT:.1f}c a contract (the curve\'s floor), else as'
          '\n   the snipe rows end. Against the +2c / +4c snipe and holding, on the same entries; "vs +4c": the net minus the +4c'
          '\n   snipe\'s on the same entries, +- its standard error with trades clustered by contract.')
    print(f"   {'exit':<26} {'trades':>7} {'sold at a top':>14} {'net':>8} {'vs +4c':>16}")
    for label in ['snipe +2c', 'snipe +4c', 'hold'] + ['top: ' + m for m in ['momentum 10 s'] + [m for m in names if m not in ('imbalance', 'momentum 10 s')]]:
        x = s4x.get(label)
        if not x or not x[0]: continue
        dm, ds = cluster_se(s4d.get(label, []))
        print(f"   {label:<26} {x[0]:>7} {(f'{100 * x[1] / x[0]:.0f}%' if label.startswith('top') else ''):>14} {100 * x[2] / x[0]:+8.2f} {(f'{100 * dm:+.2f} +- {100 * ds:.2f}' if label != 'snipe +4c' else ''):>16}")
    print(f'\n(done in {time.time() - t0:.0f} s)')

if __name__ == '__main__':
    main()

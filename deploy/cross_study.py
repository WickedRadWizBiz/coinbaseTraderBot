#!/usr/bin/env python3
"""Exit study (read-only): does the exit curve's cross sell at turns, as it is meant to, and what would watching the
curve's projected peak and selling once the bid reaches it have done on the same positions?

On the bot's own records: the audit log (fills, orders, the decisions that planned each exit, settlements, the curve's
scoreboard events) and the market-data recordings (order books, the settlement index), replayed a second at a time
through a port of the bot's curve (bot/strategy/sinuousExit.ts: tests/crossStudy.test.ts keeps the two identical).

Usage: cross_study.py <data dir> [days=1]   (days counts UTC days back from today, today included)
       cross_study.py --selftest <series.json>   (the curve port on a series, for the test)

Prints:
  1. every exit fill by reason: net a contract, against holding to settlement, and markouts: the held side's bid
     10 / 30 / 60 / 120 s after the sale against the sale price (+ = it fell after the sale: well timed; - = it rose);
  2. the cross's scoreboard against its fills (the scoreboard counts a cross when it is called, filled or not);
  3. rules replayed on every position, each acting alongside the bot's other exits (it sells what is still held when
     it fires): the cross as written, without its spot test and with deeper margins; and the owner's "watch the
     projected peak" rule (sell at the bid once it reaches the curve's swing-top estimate), with the estimate made
     each second as rest mode did, or the highest estimate since the rise began (kept until the curve stops rising). Each against what those contracts actually got, and
     against holding them to settlement.
"""
import bisect, collections, datetime, glob, gzip, json, math, os, re, sys, time

# ---- The curve (a port of bot/strategy/sinuousExit.ts) ------------------------------------------------------------

EDGE = 0.005
Q_X, Q_V, P0 = 1e-4, 1e-3, 0.1
MAX_GAP_SEC = 60
PROFILES = {'crypto_15m': (0.015, 0.35, 1.65, 3), 'crypto_1h': (0.03, 0.15, 2.1, 6), 'tennis': (0.065, 0.08, 1.8, 2)}


def js_round(x):
    """Math.round: halves go up."""
    return math.floor(x + 0.5)


def fixed(x, d):
    """+x.toFixed(d): both round the exact binary value (they differ only on exact ties, which floats rarely hit)."""
    return round(x, d)


def logit(p):
    c = min(1 - EDGE, max(EDGE, p))
    return math.log(c / (1 - c))


def from_logit(x):
    return 1 / (1 + math.exp(-x))


def micro_price(bid, ask):
    if not bid and not ask: return None
    if not bid: return ask[0]
    if not ask: return bid[0]
    w = bid[1] + ask[1]
    return (bid[1] * ask[0] + ask[1] * bid[0]) / w if w > 0 else (bid[0] + ask[0]) / 2


def dynamic_knobs(profile, spread, side_price, tau):
    R0, k0, z0, _ = PROFILES[profile]
    R = R0 * (1 + 0.25 * max(0.0, spread * 100 - 2) ** 2)
    kappa, z = k0, z0
    cents = side_price * 100
    if profile != 'tennis' and tau is not None:
        if tau <= 60:
            z = max(1.1, z0 * max(0.2, tau / 60)); kappa = k0 * 2
        elif tau <= 180:
            if 35 <= cents <= 65: z *= 0.75
            elif cents > 85: kappa *= 0.2
    return R, kappa, z


class Tracker:
    """SinuousExitTracker: a Kalman filter on [curve, velocity] with decaying momentum, projected look-ahead seconds on."""

    def __init__(self, profile):
        self.profile = profile
        self.x = 0.0; self.v = 0.0
        self.p00, self.p01, self.p10, self.p11 = P0, 0.0, 0.0, P0
        self.last = None
        self.pending = collections.deque()
        self.matured = None
        self.knobs = None

    def swing_top(self, band):
        if self.last is None or self.matured is None or not self.knobs: return None
        R, kappa, _ = self.knobs
        return from_logit(self.x + max(0.0, self.v) / kappa + band * math.sqrt(R))

    def restart(self, obs, now):
        self.x = obs; self.v = 0.0
        self.p00, self.p01, self.p10, self.p11 = P0, 0.0, 0.0, P0
        self.last = now
        self.pending.clear()
        self.matured = None

    def update(self, now, sign, bid, ask, tau):
        """bid / ask: (price, size) of YES or None. Returns the reading (side terms) or None without a book."""
        micro = micro_price(bid, ask)
        if micro is None: return None
        side = micro if sign > 0 else 1 - micro
        spread = max(0.0, ask[0] - bid[0]) if bid and ask else 0.1
        knobs = dynamic_knobs(self.profile, spread, side, tau)
        self.knobs = knobs
        R, kappa, zk = knobs
        obs = logit(side)
        gap = math.inf if self.last is None else (now - self.last) / 1000
        z = 0.0
        if not (0 < gap <= MAX_GAP_SEC):
            if self.last is None or gap > MAX_GAP_SEC: self.restart(obs, now)
        else:
            dt = gap; d = math.exp(-kappa * dt)
            xp = self.x + dt * self.v; vp = d * self.v
            a00 = self.p00 + dt * (self.p10 + self.p01) + dt * dt * self.p11 + Q_X * dt
            a01 = d * (self.p01 + dt * self.p11)
            a10 = d * (self.p10 + dt * self.p11)
            a11 = d * d * self.p11 + Q_V * dt
            y = obs - xp; S = a00 + R
            k0 = a00 / S; k1 = a10 / S
            self.x = xp + k0 * y
            self.v = vp + k1 * y
            self.p00 = (1 - k0) * a00; self.p01 = (1 - k0) * a01
            self.p10 = a10 - k1 * a00; self.p11 = a11 - k1 * a01
            self.last = now
            z = y / math.sqrt(S)
        h = PROFILES[self.profile][3]
        self.pending.append((now + h * 1000, self.x + (self.v * (1 - math.exp(-kappa * h))) / kappa))
        while self.pending and self.pending[0][0] <= now: self.matured = self.pending.popleft()[1]
        return {
            'micro': fixed(side, 4), 'curve': fixed(from_logit(self.x), 4),
            'projected': None if self.matured is None else fixed(from_logit(self.matured), 4),
            'velocity': fixed(self.v, 5), 'z': fixed(z, 2),
        }


class LineTracker:
    """The live-line curve (the owner's description, Oct 23): the same filter (level and decaying momentum) on the log of
    Kalshi's index, the line the contract settles on and the app draws, its noise scaled to the coin's per-second
    volatility so one setting fits every coin and hour; projections for several look-aheads."""

    def __init__(self, kappa, horizons):
        self.kappa = kappa
        self.horizons = horizons
        self.x = None; self.v = 0.0
        self.p00 = self.p01 = self.p10 = self.p11 = 0.0
        self.last = None
        self.pending = {h: collections.deque() for h in horizons}
        self.matured = {h: None for h in horizons}

    def update(self, now, y, sigma):
        R, qx, qv = (0.5 * sigma) ** 2, (0.5 * sigma) ** 2, (0.05 * sigma) ** 2
        k = self.kappa
        if self.last is None or now - self.last > MAX_GAP_SEC:
            self.x, self.v = y, 0.0
            self.p00, self.p01, self.p10, self.p11 = R, 0.0, 0.0, (0.5 * sigma) ** 2
            for h in self.horizons: self.pending[h].clear(); self.matured[h] = None
        elif now > self.last:
            dt = now - self.last; d = math.exp(-k * dt)
            xp = self.x + dt * self.v; vp = d * self.v
            a00 = self.p00 + dt * (self.p10 + self.p01) + dt * dt * self.p11 + qx * dt
            a01 = d * (self.p01 + dt * self.p11)
            a10 = d * (self.p10 + dt * self.p11)
            a11 = d * d * self.p11 + qv * dt
            S = a00 + R; k0 = a00 / S; k1 = a10 / S; e = y - xp
            self.x = xp + k0 * e; self.v = vp + k1 * e
            self.p00 = (1 - k0) * a00; self.p01 = (1 - k0) * a01
            self.p10 = a10 - k1 * a00; self.p11 = a11 - k1 * a01
        self.last = now
        for h in self.horizons:
            self.pending[h].append((now + h, self.x + self.v * (1 - math.exp(-k * h)) / k))
            while self.pending[h] and self.pending[h][0][0] <= now: self.matured[h] = self.pending[h].popleft()[1]


# ---- Fees (bot/fees.ts: Kalshi's taker fee, rounded onto a $0.01 balance grid) ---------------------------------------

def taker_fee(count, price, precision=0.01, rate=0.07, mult=1.0):
    if not (count > 0) or not (mult > 0) or not (0 < price < 1): return 0.0
    model = mult * rate * count * price * (1 - price) * 1e6
    trade = math.ceil(js_round(model * 1e3) / 1e3)
    notional = js_round(count * price * 1e6)
    grid = js_round(precision * 1e6)
    charged = math.ceil((notional + trade) / grid) * grid
    return (charged - notional) / 1e6


def selftest(path):
    spec = json.load(open(path))
    t = Tracker(spec['profile'])
    out = []
    for o in spec['obs']:
        r = t.update(o['now'], o['sign'], tuple(o['bid']) if o.get('bid') else None, tuple(o['ask']) if o.get('ask') else None, o.get('tau'))
        st = t.swing_top(spec.get('band', 0.5))
        out.append(None if r is None else {**r, 'swingTop': None if st is None else round(st, 9)})
    fees = [taker_fee(c, p) for c, p in spec.get('fees', [])]
    print(json.dumps({'readings': out, 'fees': fees}))


# ---- The study --------------------------------------------------------------------------------------------------------

STAND_DOWN_SEC = 120          # SINUOUS_REST_STAND_DOWN_SEC: no cross in the last two minutes
FAST_MOVE_SEC = 5             # STRATEGY_FAST_MOVE_WINDOW_SEC: the cross's spot test window
PROFIT_TARGET = 0.02          # PROFIT_TARGET_CENTS / 100
PROFIT_TARGET_PCT = 0.10      # PROFIT_TARGET_PCT
MARKOUTS = (10, 30, 60, 120)

TP = re.compile(r'take-profit( NO)?: \+(-?[0-9.]+) a contract net of fees')
REST = re.compile(r'exit curve: rest( NO)? ')
CROSS = re.compile(r'exit curve: cross( NO)? ')


def exit_kind(why):
    if TP.match(why): return 'take-profit (trailing)'
    if why.startswith('profit target'): return 'profit target (old)'
    if REST.match(why): return 'exit curve (resting sell)'
    if CROSS.match(why): return 'exit curve (cross)'
    if '- fee > q' in why: return 'model exit (market pays more)'
    if why.startswith('confluence ratchet stop'): return 'ratchet stop'
    if why.startswith('tennis'): return 'tennis'
    return re.sub(r'[-+]?[0-9][0-9.]*', '#', why)[:40] or '?'


def iso_ms(ts):
    return int(datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp() * 1000)


def opener(f):
    return gzip.open(f, 'rb') if f.endswith('.gz') else open(f, 'rb')


def pct(xs, q):
    return sorted(xs)[min(len(xs) - 1, int(q * len(xs)))] if xs else float('nan')


def mean(xs):
    return sum(xs) / len(xs) if xs else float('nan')


def main():
    data = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/bot/data')
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    now = time.time()
    since_day = time.strftime('%Y-%m-%d', time.gmtime(now - (days - 1) * 86400))
    t0 = time.time()

    # -- The audit log.
    files = sorted(f for f in glob.glob(os.path.join(data, 'audit', 'audit-*.jsonl')) if os.path.basename(f)[6:16] >= since_day)
    fills, orders, results, exit_why, curve_events = [], {}, {}, {}, []
    want = (b'"kind":"fill"', b'"kind":"settlement"', b'"kind":"order_new"', b'"kind":"curve_exit"')
    for f in files:
        with open(f, 'rb') as fh:
            for line in fh:
                head = line[:160]
                if b'"kind":"decision"' in head:
                    if b'"purpose":"exit"' not in line: continue
                    try: d = json.loads(line).get('data') or {}
                    except Exception: continue
                    exit_why[d.get('decisionId')] = [(p.get('side'), p.get('price'), str(p.get('why') or '')) for p in d.get('place') or [] if p.get('purpose') == 'exit']
                    continue
                if not any(w in head for w in want): continue
                try: r = json.loads(line)
                except Exception: continue
                k, d, ts = r.get('kind'), r.get('data') or {}, r.get('ts', '')
                if k == 'fill':
                    fl = d.get('fill') or {}
                    fills.append({'ms': iso_ms(ts), 'ticker': fl.get('ticker', ''), 'side': fl.get('side'), 'count': float(fl.get('count') or 0), 'price': float(fl.get('price') or 0), 'fee': float(d.get('fee') or 0), 'coid': d.get('clientOrderId')})
                elif k == 'order_new':
                    orders[d.get('clientOrderId')] = {'purpose': d.get('purpose'), 'price': d.get('price'), 'side': d.get('side'), 'decision': d.get('decisionId'), 'close': d.get('windowCloseTs'), 'asset': d.get('asset')}
                elif k == 'settlement':
                    if d.get('result') in ('yes', 'no'): results[d.get('ticker', '')] = (d['result'], iso_ms(ts))
                elif k == 'curve_exit':
                    curve_events.append((ts, d))
    fills.sort(key=lambda x: x['ms'])
    print(f"audit files {[os.path.basename(f) for f in files]}: fills {len(fills)}  orders {len(orders)}  settled markets {len(results)}  ({time.time() - t0:.0f} s)")

    def why_of(fl):
        o = orders.get(fl['coid']) or {}
        if o.get('purpose') != 'exit': return None
        plans = exit_why.get(o.get('decision')) or []
        return next((w for sd, px, w in plans if sd == fl['side'] and px == o.get('price')), plans[0][2] if plans else '(no decision record)')

    # -- Positions: one episode per ticker from flat to flat (or to settlement), in the held side's prices.
    episodes = []
    open_ep = {}
    for fl in fills:
        t = fl['ticker']
        if not t or t.startswith('KXATP') or t.startswith('KXWTA'): continue
        o = orders.get(fl['coid']) or {}
        signed = fl['count'] if fl['side'] == 'bid' else -fl['count']
        ep = open_ep.get(t)
        held = ep['held'] if ep else 0.0
        rest = signed
        if ep and held * signed < 0:  # reduces
            n = min(abs(signed), abs(held))
            px = fl['price'] if ep['sign'] > 0 else 1 - fl['price']
            ep['exits'].append({'ms': fl['ms'], 'n': n, 'px': round(px, 4), 'fee': fl['fee'] * n / fl['count'], 'kind': exit_kind(why_of(fl) or '(entry order)') if o.get('purpose') == 'exit' else 'a quote that reduced it', 'why': why_of(fl) or ''})
            ep['held'] = held + (n if signed > 0 else -n)
            rest = signed - (n if signed > 0 else -n)
            if abs(ep['held']) < 1e-9:
                ep['flat_ms'] = fl['ms']; episodes.append(ep); del open_ep[t]; ep = None
        if abs(rest) > 1e-9:
            if ep is None:
                ep = {'ticker': t, 'sign': 1 if rest > 0 else -1, 'start_ms': fl['ms'], 'entries': [], 'exits': [], 'held': 0.0, 'close_ms': o.get('close'), 'asset': o.get('asset')}
                open_ep[t] = ep
            px = fl['price'] if ep['sign'] > 0 else 1 - fl['price']
            ep['entries'].append({'ms': fl['ms'], 'n': abs(rest), 'px': round(px, 4), 'fee': fl['fee'] * abs(rest) / fl['count']})
            ep['held'] += rest
            if not ep.get('close_ms') and o.get('close'): ep['close_ms'] = o.get('close')
    episodes.extend(open_ep.values())
    for ep in episodes:
        res = results.get(ep['ticker'])
        ep['payout'] = None if not res else (1.0 if (ep['sign'] > 0) == (res[0] == 'yes') else 0.0)

    # -- 1. Exit fills by reason (vs holding; markouts after the book is loaded).
    # -- The recordings: top of book a second at a time for the episodes' markets, the settlement index, market terms.
    wanted = {ep['ticker'] for ep in episodes}
    win = {}
    for ep in episodes:
        end = (ep.get('close_ms') or (ep['start_ms'] + 3_600_000)) + 1000
        a, b = win.get(ep['ticker'], (ep['start_ms'], end))
        win[ep['ticker']] = (min(a, ep['start_ms'] - 120_000), max(b, end))
    assets = {ep.get('asset') for ep in episodes if ep.get('asset')}
    rec_dir = os.path.join(data, 'recordings')
    first_day = time.strftime('%Y-%m-%d', time.gmtime(min((w[0] for w in win.values()), default=now * 1000) / 1000))
    rec_files = sorted(f for f in glob.glob(os.path.join(rec_dir, 'md-*.jsonl*')) if os.path.basename(f)[3:13] >= first_day and not f.endswith('.tmp'))
    plain_days = {os.path.basename(f)[3:13] for f in rec_files if f.endswith('.jsonl')}
    rec_files = [f for f in rec_files if f.endswith('.jsonl') or os.path.basename(f)[3:13] not in plain_days]
    books = {}       # ticker -> (bids, asks) price -> size
    tops = collections.defaultdict(list)   # ticker -> [(sec, bid, bidSize, ask, askSize)] when the top changed
    cur_sec = {}
    index = collections.defaultdict(list)  # asset -> [(sec, value)]
    terms = {}
    wanted_b = {t.encode() for t in wanted}
    assets_b = {a.encode() for a in assets}
    lines = 0

    def top_of(t):
        bids, asks = books[t]
        bb = max(bids) if bids else None
        ba = min(asks) if asks else None
        return (bb / 1e4 if bb is not None else None, bids[bb] if bb is not None else 0, ba / 1e4 if ba is not None else None, asks[ba] if ba is not None else 0)

    for f in rec_files:
        with opener(f) as fh:
            for line in fh:
                lines += 1
                ks = line.find(b'"k":"', 0, 48)
                if ks < 0: continue
                ke = line.find(b'"', ks + 5)
                kind = line[ks + 5:ke]
                if kind in (b'delta', b'book'):
                    ts_ = line.find(b'"ticker":"', ke)
                    if ts_ < 0: continue
                    te = line.find(b'"', ts_ + 10)
                    tb = line[ts_ + 10:te]
                    if tb not in wanted_b: continue
                    r = json.loads(line)
                    t = r['ticker']; ms = r.get('t') or r.get('ts')
                    a, b = win[t]
                    if ms < a or ms > b: continue
                    sec = ms // 1000
                    if t in books and sec > cur_sec.get(t, 0):
                        top = top_of(t)
                        if not tops[t] or tops[t][-1][1:] != top: tops[t].append((cur_sec.get(t, sec - 1) + 1, *top))
                    cur_sec[t] = sec
                    if kind == b'book':
                        books[t] = ({js_round(l['price'] * 1e4): l['size'] for l in r.get('bids') or [] if l.get('size', 0) > 0}, {js_round(l['price'] * 1e4): l['size'] for l in r.get('asks') or [] if l.get('size', 0) > 0})
                    elif t in books:
                        m = books[t][0] if r.get('side') == 'bid' else books[t][1]
                        key = js_round(r['price'] * 1e4)
                        nxt = m.get(key, 0) + r['delta']
                        if nxt <= 1e-9: m.pop(key, None)
                        else: m[key] = nxt
                elif kind == b'index':
                    as_ = line.find(b'"asset":"', ke)
                    if as_ < 0: continue
                    ae = line.find(b'"', as_ + 9)
                    if line[as_ + 9:ae] not in assets_b: continue
                    r = json.loads(line)
                    if r.get('src') == 'proxy': continue
                    sec = int((r.get('ts') or r.get('t')) // 1000)
                    s = index[r['asset']]
                    if s and s[-1][0] == sec: s[-1] = (sec, float(r['value']))
                    elif not s or sec > s[-1][0]: s.append((sec, float(r['value'])))
                elif kind == b'market':
                    ts_ = line.find(b'"ticker":"', ke)
                    if ts_ < 0: continue
                    te = line.find(b'"', ts_ + 10)
                    if line[ts_ + 10:te] not in wanted_b: continue
                    r = json.loads(line)
                    terms[r['ticker']] = r
    for t in books:  # the last state
        top = top_of(t)
        if not tops[t] or tops[t][-1][1:] != top: tops[t].append((cur_sec.get(t, 0) + 1, *top))
    print(f"recordings {[os.path.basename(f) for f in rec_files]}: {lines} lines, books for {sum(1 for t in wanted if tops.get(t))} of {len(wanted)} markets, index for {sorted(a for a in index if index[a])}  ({time.time() - t0:.0f} s)")
    top_secs = {t: [x[0] for x in v] for t, v in tops.items()}
    idx_secs = {a: [x[0] for x in v] for a, v in index.items()}

    def top_at(t, sec):
        v = tops.get(t)
        if not v: return None
        i = bisect.bisect_right(top_secs[t], sec) - 1
        return v[i] if i >= 0 else None

    def side_bid_at(ep, sec):
        tp = top_at(ep['ticker'], sec)
        if not tp: return None
        if ep['sign'] > 0: return tp[1]
        return None if tp[3] is None else round(1 - tp[3], 4)

    def index_at(asset, sec):
        v = index.get(asset)
        if not v: return None
        i = bisect.bisect_right(idx_secs[asset], sec) - 1
        return v[i][1] if i >= 0 and sec - v[i][0] <= 30 else None

    def sigma_at(asset, sec):
        """Per-second volatility of the index over the last 15 minutes (a stand-in for the engine's estimate)."""
        v = index.get(asset)
        if not v: return None
        j = bisect.bisect_right(idx_secs[asset], sec)
        i = bisect.bisect_left(idx_secs[asset], sec - 900)
        pts = v[i:j]
        rs = [math.log(b[1] / a[1]) / math.sqrt(b[0] - a[0]) for a, b in zip(pts, pts[1:]) if b[0] > a[0] and a[1] > 0 and b[1] > 0]
        if len(rs) < 30: return None
        m = mean(rs)
        return math.sqrt(sum((x - m) ** 2 for x in rs) / (len(rs) - 1))

    sig_cache = {}

    def sigma_cached(asset, sec):
        k = (asset, sec // 60)
        if k not in sig_cache: sig_cache[k] = sigma_at(asset, sec) if asset else None
        return sig_cache[k]

    def direction(ep, sec):
        t = ep['ticker']
        if '15M-' in t: return 1
        seg = t.rsplit('-', 1)[-1]
        if seg.startswith('T'): return 1
        tm = terms.get(t) or {}
        if tm.get('kind') == 'less': return -1
        if seg.startswith('B') and tm.get('strike') is not None and tm.get('cap') is not None:
            s = index_at(ep.get('asset'), sec)
            if s is None: return 0
            return 1 if s < (tm['strike'] + tm['cap']) / 2 else -1
        return 0

    def spot_turn(ep, sec):
        a = ep.get('asset')
        s1, s0 = index_at(a, sec), index_at(a, sec - FAST_MOVE_SEC)
        sig = sigma_at(a, sec)
        d = direction(ep, sec)
        if s1 is None or s0 is None or not sig or d == 0: return 'flat'
        ret = math.log(s1 / s0)
        if abs(ret) < 0.25 * sig * math.sqrt(FAST_MOVE_SEC): return 'flat'
        return 'against' if (1 if ret > 0 else -1) * d * ep['sign'] < 0 else 'with'

    # -- 1. Exit fills by reason.
    print('\n== 1. exit fills by reason: fills, contracts, net a contract after fees, vs holding to settlement (settled markets),'
          '\n   and markouts: sale price minus the side\'s bid N s later, contract-weighted (+ = it fell after the sale, well timed)')
    rows = collections.defaultdict(lambda: {'fills': 0, 'n': 0.0, 'net': 0.0, 'netn': 0.0, 'vs': 0.0, 'vsn': 0.0, 'mk': collections.defaultdict(lambda: [0.0, 0.0])})
    for ep in episodes:
        cost = sum(e['n'] * e['px'] for e in ep['entries']); en = sum(e['n'] for e in ep['entries']); ef = sum(e['fee'] for e in ep['entries'])
        avg = cost / en if en else None
        for x in ep['exits']:
            r = rows[x['kind']]
            r['fills'] += 1; r['n'] += x['n']
            if avg is not None:
                r['net'] += (x['px'] - avg - ef / en) * x['n'] - x['fee']; r['netn'] += x['n']
            if ep['payout'] is not None:
                r['vs'] += (x['px'] - ep['payout']) * x['n'] - x['fee']; r['vsn'] += x['n']
            for h in MARKOUTS:
                sec = x['ms'] // 1000 + h
                if ep.get('close_ms') and sec * 1000 > ep['close_ms']: continue
                b = side_bid_at(ep, sec)
                if b is None: continue
                m = r['mk'][h]; m[0] += (x['px'] - b) * x['n']; m[1] += x['n']
    for k, r in sorted(rows.items(), key=lambda kv: -kv[1]['n']):
        mk = '  '.join(f"{h}s {r['mk'][h][0] / r['mk'][h][1]:+.3f}" if r['mk'][h][1] else f"{h}s  n/a " for h in MARKOUTS)
        print(f"  {k:32s} fills {r['fills']:4d}  contracts {r['n']:8.1f}  net {r['net'] / r['netn']:+.3f}/ct" if r['netn'] else f"  {k:32s} fills {r['fills']:4d}  contracts {r['n']:8.1f}  net   n/a  ", end='')
        print(f"  vs holding ${r['vs']:+8.2f} ({r['vs'] / r['vsn']:+.3f}/ct)" if r['vsn'] else '  vs holding      n/a', f"  markouts {mk}")

    # -- 2. The cross's scoreboard against its fills.
    print('\n== 2. the cross\'s scoreboard (curve_exit events) against its fills')
    scored = [d for ts, d in curve_events if d.get('event') == 'scored' and str(d.get('how', '')).startswith('cross vs settled')]
    resets = [ts[5:16] for ts, d in curve_events if d.get('event') in ('reset', 'benched')]
    cf = rows.get('exit curve (cross)')
    print(f"  scoreboard: {len(scored)} cross results, ${sum(float(d.get('usd') or 0) for d in scored):+.2f} against holding to settlement (resets / benches: {resets or 'none'})")
    print(f"  fills: {cf['fills'] if cf else 0} cross fills, {cf['n'] if cf else 0:.1f} contracts, ${cf['vs'] if cf else 0:+.2f} against holding on {cf['vsn'] if cf else 0:.0f} settled contracts")
    print('  (the scoreboard records a cross when it is called, before its order is sent; a cross whose order did not fill is still scored)')

    # -- 3. Rules replayed on every position, alongside the other exits.
    def actual_value(ep, sec, held):
        """What the contracts held at `sec` actually got a contract: the exits after it, then settlement for the rest."""
        left, got = held, 0.0
        for x in ep['exits']:
            if x['ms'] // 1000 < sec or left <= 1e-9: continue
            n = min(left, x['n'])
            got += n * x['px'] - x['fee'] * n / x['n']; left -= n
        if left > 1e-9:
            if ep['payout'] is None: return None
            got += left * ep['payout']
        return got / held

    rules = {
        'cross as written': {'margin': 0.5, 'spot': True},
        'cross, no spot test': {'margin': 0.5, 'spot': False},
        'cross, 1x fee margin': {'margin': 1.0, 'spot': True},
        'cross, 2x fee margin': {'margin': 2.0, 'spot': True},
        'peak watch, estimate each second, band 0.5': {'peak': 0.5},
        'peak watch, estimate each second, band 1.0': {'peak': 1.0},
        'peak watch, estimate each second, band 2.0': {'peak': 2.0},
        'peak watch, highest estimate of the rise, band 0.5': {'peak': 0.5, 'rise': True},
        'peak watch, highest estimate of the rise, band 1.0': {'peak': 1.0, 'rise': True},
    }
    # The owner's description: a curve predicting Kalshi's live line; sell when the line falls below it (for the side
    # held) by more than x, x in the line's own noise over the look-ahead (k x sigma x sqrt(h)), for two seconds running.
    for h15, kx in ((10, 1.5), (10, 2.5), (20, 1.5), (20, 2.5), (30, 2.0)):
        rules[f'live line, {h15} s ahead ({3 * h15} s hourly), x = {kx} noise'] = {'line': (h15, kx)}
    out = {k: {'fired': 0, 'ct': 0.0, 'sale': 0.0, 'vsActual': 0.0, 'vsHold': 0.0, 'better': 0, 'mk': collections.defaultdict(lambda: [0.0, 0.0])} for k in rules}
    replayed = 0
    for ep in episodes:
        t = ep['ticker']
        if not tops.get(t) or not ep.get('close_ms') or ep['payout'] is None: continue
        tm = terms.get(t) or {}
        o_ms, c_ms = tm.get('openTime'), ep['close_ms']
        profile = 'crypto_15m' if ('15M-' in t or (o_ms and (c_ms - o_ms) / 60_000 <= 20)) else 'crypto_1h'
        tr = Tracker(profile)
        start = ep['start_ms'] // 1000 + 1
        flat = (ep.get('flat_ms') or c_ms) // 1000
        last_sec = min(flat, c_ms // 1000 - STAND_DOWN_SEC)
        if last_sec <= start: continue
        replayed += 1
        done = set()
        prev_top, rise_target = None, None
        line = LineTracker(0.05 if profile == 'crypto_15m' else 0.02, sorted({(h if profile == 'crypto_15m' else 3 * h) for h, _ in (r['line'] for r in rules.values() if 'line' in r)}))
        line_run = collections.Counter()
        line_dir = None
        ent = sorted(ep['entries'], key=lambda e: e['ms'])
        exits = sorted(ep['exits'], key=lambda e: e['ms'])
        for sec in range(start, last_sec + 1):
            px, sig, dnow = index_at(ep.get('asset'), sec), sigma_cached(ep.get('asset'), sec), direction(ep, sec)
            if line_dir is None and dnow: line_dir = dnow
            line_ok = bool(px and sig and dnow and dnow == line_dir)
            if line_ok: line.update(sec, ep['sign'] * line_dir * math.log(px), sig)
            tp = top_at(t, sec)
            if not tp: continue
            bid = (tp[1], tp[2]) if tp[1] is not None else None
            ask = (tp[3], tp[4]) if tp[3] is not None else None
            tau = c_ms / 1000 - sec
            r = tr.update(sec * 1000, ep['sign'], bid, ask, tau)
            if r is None: continue
            en = sum(e['n'] for e in ent if e['ms'] // 1000 <= sec)
            if en <= 0: continue
            ex = sum(x['n'] for x in exits if x['ms'] // 1000 < sec)
            held = en - ex
            if held <= 1e-9: continue
            entry = sum(e['n'] * e['px'] for e in ent if e['ms'] // 1000 <= sec) / en
            entry_fee = sum(e['fee'] for e in ent if e['ms'] // 1000 <= sec) / en
            side_bid = tp[1] if ep['sign'] > 0 else (None if tp[3] is None else round(1 - tp[3], 4))
            if side_bid is None or not (0 < side_bid < 1): prev_top = {b: tr.swing_top(b) for b in (0.5, 1.0, 2.0)}; continue
            top_size = tp[2] if ep['sign'] > 0 else tp[4]
            n = max(0.0, math.floor(min(held, top_size) * 100) / 100)
            fee_per = taker_fee(held, side_bid) / held
            floor = max(PROFIT_TARGET, PROFIT_TARGET_PCT * (entry + entry_fee))
            net = side_bid - entry - entry_fee - fee_per
            v = r['velocity']
            for name, rule in rules.items():
                if name in done: continue
                fire = False
                if 'line' in rule:
                    h15, kx = rule['line']
                    hh = h15 if profile == 'crypto_15m' else 3 * h15
                    proj = line.matured.get(hh) if line_ok else None
                    broke = proj is not None and proj - ep['sign'] * line_dir * math.log(px) >= kx * sig * math.sqrt(hh)
                    line_run[name] = line_run[name] + 1 if broke else 0
                    fire = line_run[name] >= 2 and net >= floor - 1e-9 and tau > STAND_DOWN_SEC
                elif 'margin' in rule:
                    if n > 0 and r['projected'] is not None and tau > STAND_DOWN_SEC:
                        depth = r['projected'] - r['curve']
                        cross_fee = taker_fee(n, side_bid) / n  # the engine prices the cross on what the top of the book takes
                        cross_net = side_bid - entry - entry_fee - cross_fee
                        if cross_net >= floor - 1e-9 and v <= 0 and depth > 0 and depth >= rule['margin'] * cross_fee - 1e-9:
                            fire = not rule['spot'] or spot_turn(ep, sec) == 'against'
                else:
                    if rule.get('rise'): target = rise_target.get(rule['peak']) if rise_target else None
                    else: target = prev_top.get(rule['peak']) if prev_top else None
                    fire = target is not None and side_bid >= target - 1e-9 and net >= floor - 1e-9 and tau > STAND_DOWN_SEC
                if not fire: continue
                done.add(name)
                act = actual_value(ep, sec, held)
                if act is None: continue
                sale = side_bid - fee_per
                o = out[name]
                o['fired'] += 1; o['ct'] += held; o['sale'] += sale * held
                o['vsActual'] += (sale - act) * held; o['vsHold'] += (sale - ep['payout']) * held
                o['better'] += 1 if sale > act + 1e-9 else 0
                for h in MARKOUTS:
                    if (sec + h) * 1000 > c_ms: continue
                    b = side_bid_at(ep, sec + h)
                    if b is None: continue
                    m = o['mk'][h]; m[0] += (side_bid - b) * held; m[1] += held
            # Swing-top estimates for the next second: the one made this second, and the highest made since the curve
            # started rising (the rise's projected peak, kept until the curve stops rising).
            prev_top = {b: tr.swing_top(b) for b in (0.5, 1.0, 2.0)}
            if v > 0:
                rise_target = rise_target or {}
                for band in (0.5, 1.0):
                    if prev_top[band] is not None: rise_target[band] = max(rise_target.get(band, prev_top[band]), prev_top[band])
            else:
                rise_target = None
    print(f"\n== 3. rules replayed on {replayed} positions with a book, a close time and a result (each sells what is still held"
          f"\n   when it first fires, at the side's bid less the taker fee; no cross or peak sale in the last {STAND_DOWN_SEC} s)")
    print('   vs actual: against what those contracts got from the bot\'s own exits and settlement; better: positions where it beat them')
    for name, o in out.items():
        if not o['fired']:
            print(f"  {name:48s} never fired"); continue
        mk = '  '.join(f"{h}s {o['mk'][h][0] / o['mk'][h][1]:+.3f}" if o['mk'][h][1] else f"{h}s  n/a " for h in MARKOUTS)
        print(f"  {name:48s} fired {o['fired']:4d}  contracts {o['ct']:8.1f}  sale {o['sale'] / o['ct']:.3f}  vs actual ${o['vsActual']:+8.2f} ({o['vsActual'] / o['ct']:+.3f}/ct)"
              f"  vs holding ${o['vsHold']:+8.2f}  better {100 * o['better'] / o['fired']:3.0f}%  markouts {mk}")
    print(f"\n(done in {time.time() - t0:.0f} s)")


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == '--selftest':
        selftest(sys.argv[2])
    else:
        main()

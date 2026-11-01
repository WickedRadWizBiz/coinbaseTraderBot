#!/usr/bin/env python3
"""Exit study (read-only): does the exit curve's cross sell at turns, as it is meant to, and what would watching the
curve's projected peak and selling once the bid reaches it have done on the same positions?

On the bot's own records: the audit log (fills, orders, the decisions that planned each exit, settlements, the curve's
scoreboard events) and the market-data recordings (order books, the settlement index), replayed a second at a time
through a port of the bot's curve (bot/strategy/sinuousExit.ts: tests/crossStudy.test.ts keeps the two identical).

Usage: cross_study.py <data dir> [hours=8] [until=now]  (the positions closed in the `hours` up to `until`, an ISO UTC
       time such as 2026-10-28T03:10:00Z; the recordings are read only
       for those positions' windows: a plain day file is entered at its first needed line, a gzipped one is streamed)
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


BAND_SD_FLOOR = 0.1   # the band's sd floor, a share of the line's noise over the look-ahead (bot/strategy/liveLine.ts)
BAND_MAX_RUN = 60


class LineTracker:
    """The live-line curve (the owner's description, Oct 23): the same filter (level and decaying momentum) on the log of
    Kalshi's index, the line the contract settles on and the app draws, its noise scaled to the coin's per-second
    volatility so one setting fits every coin and hour; projections for several look-aheads. And the wiggle band (the
    owner, Oct 24): the line minus the projection made look-ahead seconds ago, a second at a time, whose mean +- k sd
    since the contract opened is the band the line breaks out of."""

    def __init__(self, kappa, horizons):
        self.kappa = kappa
        self.horizons = horizons
        self.x = None; self.v = 0.0
        self.p00 = self.p01 = self.p10 = self.p11 = 0.0
        self.last = None
        self.pending = {h: collections.deque() for h in horizons}
        self.matured = {h: None for h in horizons}
        self.secs = {h: [] for h in horizons}; self.wig = {h: [] for h in horizons}; self.floor = {h: [] for h in horizons}
        self.s1 = {h: [] for h in horizons}; self.s2 = {h: [] for h in horizons}

    def band_at(self, h, j, i0, min_n):
        n = j - i0
        if n < min_n or n < 2: return None
        s1, s2 = self.s1[h], self.s2[h]
        total = s1[j - 1] - (s1[i0 - 1] if i0 > 0 else 0.0)
        sq = s2[j - 1] - (s2[i0 - 1] if i0 > 0 else 0.0)
        mean = total / n
        return mean, max(math.sqrt(max(0.0, (sq - n * mean * mean) / (n - 1))), self.floor[h][j]), n

    def band(self, h, start_sec, orient, k, min_n):
        """LineFilter.band: the band since start_sec for the latest second, where the line is in it for the side (+ =
        against it, in sd) and the seconds running it has been outside the band against the side."""
        secs = self.secs[h]
        last = len(secs) - 1
        if last < 0: return None
        lo = bisect.bisect_left(secs, start_sec)
        now = self.band_at(h, last, lo, min_n)
        if now is None: return None
        run, j = 0, last
        while j > lo and run < BAND_MAX_RUN:
            if j < last and secs[j + 1] - secs[j] != 1: break
            b = now if j == last else self.band_at(h, j, lo, min_n)
            if b is None or orient * (b[0] - self.wig[h][j]) / b[1] < k: break
            run += 1; j -= 1
        return {'mean': now[0], 'sd': now[1], 'n': now[2], 'against': orient * (now[0] - self.wig[h][last]) / now[1], 'run': run}

    def update(self, now, y, sigma):
        R, qx, qv = (0.5 * sigma) ** 2, (0.5 * sigma) ** 2, (0.05 * sigma) ** 2
        k = self.kappa
        if self.last is None or now - self.last > MAX_GAP_SEC:
            self.x, self.v = y, 0.0
            self.p00, self.p01, self.p10, self.p11 = R, 0.0, 0.0, (0.5 * sigma) ** 2
            for h in self.horizons:
                self.pending[h].clear(); self.matured[h] = None
                for a in (self.secs, self.wig, self.floor, self.s1, self.s2): a[h].clear()
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
        else: return
        self.last = now
        for h in self.horizons:
            self.pending[h].append((now + h, self.x + self.v * (1 - math.exp(-k * h)) / k))
            while self.pending[h] and self.pending[h][0][0] <= now: self.matured[h] = self.pending[h].popleft()[1]
            m = self.matured[h]
            if m is None: continue
            w, n = y - m, len(self.secs[h])
            self.secs[h].append(now); self.wig[h].append(w); self.floor[h].append(BAND_SD_FLOOR * sigma * math.sqrt(h))
            self.s1[h].append((self.s1[h][-1] if n else 0.0) + w); self.s2[h].append((self.s2[h][-1] if n else 0.0) + w * w)


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
    line = []
    if spec.get('line'):
        ln = spec['line']
        h = ln['ahead']
        lt = LineTracker(ln['kappa'], [h])
        for sec, price, sigma in ln['points']:
            lt.update(sec, math.log(price), sigma)
            m = lt.matured[h]
            if m is None: line.append(None); continue
            bands = {}
            for o in (1, -1):
                b = lt.band(h, ln['start'], o, ln['k'], ln['minN'])
                bands[str(o)] = None if b is None else {'lower': math.exp(m + b['mean'] - ln['k'] * b['sd']), 'upper': math.exp(m + b['mean'] + ln['k'] * b['sd']), 'underSd': round(b['against'], 2), 'run': b['run'], 'n': b['n']}
            line.append({'projected': math.exp(m), 'band': bands})
    print(json.dumps({'readings': out, 'fees': fees, 'line': line}))


def ratchet_lab(acts, episodes, tops, terms, index_at, sigma_cached, top_at, taker_fee, trades=None, entry_sigs=(), mres=None, more_books=None, orders=None):
    """1e. Information-anchored ratchets on the recorded paths: the price trail with guards (fair value, spot momentum, the
    book's top), trails on the spot-implied fair value, resting (maker, fee-free) profit sales, and the same from entry
    with the policy's own lock. Dollars against holding the same contracts to settlement."""
    import math, bisect, collections
    print('\n== 1e. ratchet lab: what the ratchet would need (dollars against holding the same contracts to settlement)')
    TICK = 0.01
    W = 60  # SETTLEMENT_AVG_SEC

    def ncdf(z): return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))

    def p_above(S, K, v):
        if not (v > 1e-16): return 1.0 if S >= K else 0.0
        return ncdf((math.log(S / K) - 0.5 * v) / math.sqrt(v))

    strikes = {}

    def strike_of(ep):
        t = ep['ticker']
        if t in strikes: return strikes[t]
        tm = terms.get(t) or {}
        K, cap, kind = tm.get('strike'), tm.get('cap'), tm.get('kind')
        if not (K and K > 0) and tm.get('openTime') and ep.get('asset'):
            o = int(tm['openTime'] // 1000)
            for s in range(o, o + 120):
                S = index_at(ep['asset'], s)
                if S: K = S; break
        strikes[t] = ((K if K and K > 0 else None), (cap if cap and cap > 0 else None), kind)
        return strikes[t]

    def side_fv(ep, sec, c_sec):
        K, cap, kind = strike_of(ep)
        a = ep.get('asset')
        S = index_at(a, sec) if a else None
        sig = sigma_cached(a, sec) if a else None
        if K is None or S is None or not sig: return None
        tau = max(0.0, c_sec - sec)
        v = sig * sig * max(tau - 2.0 * W / 3.0, 1e-6) if tau > W else sig * sig * max(tau, 1e-6) / 3.0
        if kind == 'less':
            p = 1.0 - p_above(S, cap if cap else K, v)
        else:
            p = p_above(S, K, v)
            if cap: p -= p_above(S, cap, v)
        p = min(max(p, 1e-4), 1 - 1e-4)
        return p if ep['sign'] > 0 else 1.0 - p

    def side_top(ep, sec):
        tp = top_at(ep['ticker'], sec)
        if not tp: return None
        if ep['sign'] > 0:
            return (tp[1], tp[2], tp[3], tp[4])
        b = None if tp[3] is None else round(1 - tp[3], 4)
        a = None if tp[1] is None else round(1 - tp[1], 4)
        return (b, tp[4], a, tp[2])

    def fee1(px, n): return taker_fee(n, px) / n if n > 0 and 0 < px < 1 else 0.0
    def cost_of(entries, until_ms):
        """Average entry cost a contract, fee in, of the fills up to until_ms (Steven's accounting: sold in profit or not)."""
        ce = [e for e in entries if e['ms'] <= until_ms]
        k = sum(e['n'] for e in ce)
        return (sum(e['n'] * e['px'] + e['fee'] for e in ce) / k) if k > 0 else None
    def market_len(p):
        t = (p.get('ep') or {}).get('ticker') or p.get('ticker') or ''
        return 900.0 if '15M' in t else 3600.0

    trade_secs = {t: [x[0] for x in v] for t, v in (trades or {}).items()}

    def flow(ep, sec, win=60):
        """Net taker contracts on the held side over the last `win` s (+ = buyers lifting our side): None without a tape."""
        v = (trades or {}).get(ep['ticker'])
        if not v: return None
        ss = trade_secs[ep['ticker']]
        i0 = bisect.bisect_left(ss, sec - win); i1 = bisect.bisect_right(ss, sec)
        if i1 <= i0: return 0.0
        mine = 'yes' if ep['sign'] > 0 else 'no'
        return sum((x[2] if x[1] == mine else -x[2]) for x in v[i0:i1])

    def bid_std(path, i, win=120):
        """Realized standard deviation of the side bid's one-second changes over the last `win` s (the contract's own noise)."""
        xs = [b for b in path['bids'][max(0, i - win):i + 1] if b is not None]
        if len(xs) < 20: return None
        d = [b - a for a, b in zip(xs, xs[1:]) if abs(b - a) > 1e-12]
        if len(d) < 5: return None
        m = sum(d) / len(d)
        return math.sqrt(sum((x - m) ** 2 for x in d) / (len(d) - 1))

    def build_path(ep, s0, c_sec):
        """Per-second series from s0 to c_sec: side bid, its size, side ask, its size, spot-implied side fair value, spot."""
        bids, bsz, asks, asz, fvs, spots = [], [], [], [], [], []
        lb = la = lbs = las = None
        a = ep.get('asset')
        for sec in range(s0, c_sec + 1):
            tp = side_top(ep, sec)
            if tp:
                if tp[0] is not None and 0 < tp[0] < 1: lb, lbs = tp[0], tp[1]
                if tp[2] is not None and 0 < tp[2] < 1: la, las = tp[2], tp[3]
            bids.append(lb); bsz.append(lbs); asks.append(la); asz.append(las)
            fvs.append(side_fv(ep, sec, c_sec))
            spots.append(index_at(a, sec) if a else None)
        return {'bids': bids, 'bsz': bsz, 'asks': asks, 'asz': asz, 'fv': fvs, 'spot': spots, 's0': s0}

    def spot_with(path, i, ep, sig):
        """Spot moved with the held side over the last 60 s by more than a quarter of its noise: True / False / None."""
        s1 = path['spot'][i]
        s0 = path['spot'][i - 60] if i >= 60 else index_at(ep.get('asset'), path['s0'] + i - 60)
        if s1 is None or s0 is None or not sig or s0 <= 0: return None
        K, cap, kind = strike_of(ep)
        d = -1 if kind == 'less' else 1
        ret = math.log(s1 / s0)
        if abs(ret) < 0.25 * sig * math.sqrt(60): return False
        return (1 if ret > 0 else -1) * d * ep['sign'] > 0

    # ---- the simulator ---------------------------------------------------------------------------------------------
    def sim(p, lock, trail, sale, guard, window, extra=None):
        """Run one policy on a path. Returns (value a contract, sold n, sale px, sale sec, armed) with value=None if never sold.
        lock: ('armed',) | ('bid', T) | ('fv', T) | ('both', T).  trail: ('none',) | ('bid', d ticks) | ('fv', D).
        sale: ('taker',) | ('rest', k ticks, 'fixed' | 'fv').  guard: None | G (a stop sale only when bid >= fv - G).
        extra: None | 'spot' (hold when spot still moves with us) | 'book' (hold when the top bid is 3x the top ask)
        | {'first_only': True} (a stop whose guard fails holds to settlement instead of trailing on).
        sale ('any', m): sell the first second the bid pays fv + m, no trail. A guard G < 0 asks for bid >= fv + |G|.
        Steven's variants (Oct 29): sale ('anyscale', m0, a): sell any second the bid pays fv + m0 + a x (peak - lock); guard
        ('scale', m0, a): a stop sale only when the bid pays fv + m0 + a x (peak - lock); sale ('wall', ratio, m0 | None): rest an
        ask at the first top-of-book sell wall (ask size >= ratio x bid size and >= the position) that pays fv + m0, filled when
        the bid reaches it (no fee)."""
        n, pay, bids, fv = p['n'], p['payout'], p['bids'], p['fv']
        # window: no taker sale in the last `window` seconds; ('frac', f): none in the last f of the market's length (Steven's
        # risk rule, Oct 29: get out in profit at the dip unless less than 10% of the window is left, then let it settle).
        share_from = None
        if isinstance(window, tuple) and window[0] == 'frac_profit':
            last_taker = p['c_sec'] - (window[2] if len(window) > 2 else 60)
            share_from = p['c_sec'] - window[1] * market_len(p)
        else:
            last_taker = p['c_sec'] - (window[1] * market_len(p) if isinstance(window, tuple) else window)

        def may_sell(sec, b):
            if sec > last_taker: return False
            c = p.get('cost')
            return not (share_from is not None and sec > share_from and c is not None and b - fee1(b, n) > c + 1e-9)
        armed = lock[0] == 'armed'
        confirm = (extra or {}).get('confirm', 0) if isinstance(extra, dict) else 0
        first_only = bool((extra or {}).get('first_only')) if isinstance(extra, dict) else False
        under = 0  # seconds running under the stop
        floor = p.get('floor')
        b0 = p['b0']; q0 = p['q0']
        peak = None; qpeak = None; stop = None; qstop = None; L = None
        for i, b in enumerate(bids):
            sec = p['s0'] + i
            q = fv[i]
            if b is None: continue
            if not armed:
                ok_b = b0 is not None and b >= b0 + lock[1] - 1e-9
                ok_q = q is not None and q0 is not None and q >= q0 + lock[1] - 1e-9
                if (lock[0] == 'bid' and ok_b) or (lock[0] == 'fv' and ok_q) or (lock[0] == 'both' and ok_b and ok_q):
                    armed = True
                    floor = b
                else:
                    continue
            if peak is None:
                peak = max(b, floor or 0.0)
                # sell at the lock when the market pays over the spot-implied fair value (into strength)
                if sale[0] == 'lock':
                    cond = sale[3] if len(sale) > 3 else 'fv'
                    fv_ok = q is not None and b >= q + sale[1] - 1e-9
                    f = flow(p['ep'], sec) if cond != 'fv' else None
                    fl_ok = f is not None and f > 0
                    hit = fv_ok if cond == 'fv' else fl_ok if cond == 'flow' else (fv_ok or fl_ok) if cond == 'either' else (fv_ok and fl_ok)
                    if hit and may_sell(sec, b): return (b - fee1(b, n), n, b, sec, True)
                    if sale[2] == 'else_hold': return (None, 0.0, None, None, True)
                    # else: carry on with the trail given in `trail`
            if b > peak + 1e-9: peak = b
            if q is not None and (qpeak is None or q > qpeak): qpeak = q
            if trail[0] == 'bid': stop = max(floor or 0.0, peak - trail[1] * TICK)
            elif trail[0] == 'vol':
                sd = bid_std(p['path'], i)
                w = max(TICK, trail[1] * (sd if sd else TICK))
                cand = max(floor or 0.0, peak - w)
                stop = cand if stop is None else max(stop, cand)
            elif trail[0] == 'fv' and qpeak is not None: qstop = qpeak - trail[1]
            # the resting sale: an ask at L, lifted (no fee) when the bid reaches it
            if sale[0] == 'rest':
                if sale[2] == 'fixed':
                    if L is None: L = round(max(b, q or 0.0, floor or 0.0) + sale[1] * TICK, 4)
                else:
                    cand = round((q if q is not None else b) + sale[1] * TICK, 4)
                    if L is None or cand > L: L = cand
                if L is not None and b >= L - 1e-9:
                    return (L, n, L, sec, True)
            # sell into a stale-high bid: any second after the lock when the bid pays over the spot-implied fair value (no trail)
            if sale[0] == 'any' and q is not None and b >= q + sale[1] - 1e-9 and may_sell(sec, b):
                return (b - fee1(b, n), n, b, sec, True)
            if sale[0] == 'anyscale' and q is not None and may_sell(sec, b):
                thr = sale[1] + sale[2] * max(0.0, peak - (floor if floor is not None else peak))
                if b >= q + thr - 1e-9: return (b - fee1(b, n), n, b, sec, True)
            # Steven's wall exit: rest an ask at a top-of-book sell wall that pays the premium; it fills when the bid reaches it
            if sale[0] == 'wall':
                if L is None:
                    a_px, a_sz, b_sz = p['path']['asks'][i], p['path']['asz'][i], p['path']['bsz'][i]
                    if a_px is not None and a_sz and b_sz is not None and a_sz >= sale[1] * max(b_sz, 1e-9) and a_sz >= n \
                            and (sale[2] is None or (q is not None and a_px >= q + sale[2] - 1e-9)):
                        L = a_px
                if L is not None and b >= L - 1e-9:
                    return (L, n, L, sec, True)
            # the stop
            trig = False
            if trail[0] in ('bid', 'vol') and stop is not None and b < stop - 1e-9: trig = True
            if trail[0] == 'fv' and qstop is not None and q is not None and q < qstop - 1e-9: trig = True
            if trig and confirm:
                under += 1
                if under < confirm: continue
            elif confirm: under = 0
            if trig and may_sell(sec, b):
                if isinstance(guard, tuple) and guard[0] == 'scale':
                    thr = guard[1] + guard[2] * max(0.0, peak - (floor if floor is not None else peak))
                    if q is None or b < q + thr - 1e-9:
                        if first_only: return (None, 0.0, None, None, True)
                        continue
                elif isinstance(guard, tuple) and guard[0] == 'profit':
                    c = p.get('cost')
                    if c is not None and b - fee1(b, n) <= c + 1e-9:
                        if first_only: return (None, 0.0, None, None, True)
                        continue
                elif guard is not None and q is not None and b < q - guard - 1e-9:
                    if first_only: return (None, 0.0, None, None, True)
                    continue
                if extra == 'spot':
                    w = spot_with(p['path'], i, p['ep'], p['sig'])
                    if w: continue
                if extra == 'book':
                    bs, as_ = p['path']['bsz'][i], p['path']['asz'][i]
                    if bs and as_ and bs >= 3 * as_: continue
                if extra == 'flow':
                    f = flow(p['ep'], sec)
                    if f is not None and f > 0: continue
                return (b - fee1(b, n), n, b, sec, True)
        return (None, 0.0, None, None, armed)

    def table(paths, rules, title, with_actual):
        if not paths:
            print(f'  {title}: no position with a path'); return
        N = sum(p['n'] for p in paths)
        won = sum(p['payout'] * p['n'] for p in paths) / N
        orc = 0.0
        for p in paths:
            pk = max((x for x in p['bids'] if x is not None), default=None)
            if p['payout'] < 0.5 and pk is not None: orc += max(0.0, pk - fee1(pk, p['n'])) * p['n']
        act = sum((p['actual'] - p['payout']) * p['n'] for p in paths) if with_actual else None
        costed = [p for p in paths if p.get('cost') is not None]
        hold_real = sum((p['payout'] - p['cost']) * p['n'] for p in costed)
        print(f'  {title}: {len(paths)} positions, {N:.1f} contracts, held side won {100 * won:.0f}%; hindsight (hold winners, sell losers at the peak) {orc:+.2f}'
              + (f"; the ratchet's actual {act:+.2f}" if act is not None else '')
              + f"; holding every one realizes {hold_real:+.2f} against entry cost (fee in) on {len(costed)} costed positions")
        print('    rule                                                   vs holding   sold  contracts  won%  avg sale  avg fv@sale  armed  realized $  held  sold in profit%')
        out = {}
        for name, (lock, trail, sale, guard, window, extra) in rules:
            vs = sold_n = sold_won = sold_px = sold_fv = real = 0.0; sold_cnt = armed_cnt = fvn = held_cnt = prof_cnt = 0
            for p in paths:
                v, sn, px, sec, armed = sim(p, lock, trail, sale, guard, window, extra)
                armed_cnt += 1 if armed else 0
                c = p.get('cost')
                if v is None:
                    held_cnt += 1
                    if c is not None: real += (p['payout'] - c) * p['n']
                    continue
                if c is not None:
                    real += (v - c) * sn + (p['payout'] - c) * (p['n'] - sn)
                    if v > c + 1e-9: prof_cnt += 1
                vs += (v - p['payout']) * sn; sold_n += sn; sold_won += p['payout'] * sn; sold_px += px * sn; sold_cnt += 1
                q = p['fv'][sec - p['s0']]
                if q is not None: sold_fv += q * sn; fvn += sn
            out[name] = vs
            print(f"    {name:54s} {vs:+10.2f}  {sold_cnt:5d}  {sold_n:9.1f}  {(100 * sold_won / sold_n) if sold_n else 0:4.0f}  {(sold_px / sold_n) if sold_n else 0:8.3f}  {(sold_fv / fvn) if fvn else 0:11.3f}  {armed_cnt:5d}  {real:+10.2f}  {held_cnt:4d}  {(100 * prof_cnt / sold_cnt) if sold_cnt else 0:14.0f}")
        return out

    # ---- F. the hourly quota pacer (PACER, PR #204: Steven Oct 29-30) run in time order across the positions ----------
    try:
        from zoneinfo import ZoneInfo
        NY = ZoneInfo('America/New_York')
    except Exception:
        NY = None
    import datetime as _dt
    anchors = {}

    def ny_anchor(sec):
        """The most recent 10:00 AM America/New_York at or before `sec` (EDT/EST from the zone database; fixed 2026 dates
        without it)."""
        h = sec // 3600
        if h in anchors: return anchors[h]
        if NY is not None:
            d = _dt.datetime.fromtimestamp(h * 3600, NY)
            a = d.replace(hour=10, minute=0, second=0, microsecond=0)
            if d < a: a = (d - _dt.timedelta(days=1)).replace(hour=10, minute=0, second=0, microsecond=0)
            r = int(a.timestamp())
        else:
            off = 4 * 3600 if h * 3600 < 1793512800 else 5 * 3600  # EDT until 2026-11-01 06:00 UTC, then EST
            r = ((h * 3600 - off - 10 * 3600) // 86400) * 86400 + 10 * 3600 + off
        anchors[h] = r
        return r

    sig_secs = [x[0] for x in entry_sigs]
    paper_at = collections.defaultdict(list)
    for ep in episodes:
        if ep.get('entries'): paper_at[ep['ticker']].append(min(e['ms'] for e in ep['entries']) // 1000)
    sig_cache = {}
    sig_miss = set()

    def settle_of(tk, close_ms):
        """A market's YES / NO from the recorded settlement index: the average of the last 60 s before the close against the
        strike (the recorder logs few 'result' records); the last recorded YES bid when there is no index."""
        tm = terms.get(tk) or {}
        ep = {'ticker': tk, 'asset': tm.get('asset')}
        c = close_ms // 1000
        K, cap, kind = strike_of(ep)
        xs = [index_at(ep['asset'], x) for x in range(c - 60, c)] if ep['asset'] else []
        xs = [x for x in xs if x]
        if K and len(xs) >= 30:
            S = sum(xs) / len(xs)
            if kind == 'less': return 'yes' if S < (cap or K) else 'no'
            return 'yes' if S >= K and (not cap or S < cap) else 'no'
        tp = top_at(tk, c - 1)
        if tp and tp[1] is not None and tp[1] >= 0.9: return 'yes'
        if tp and tp[3] is not None and tp[3] <= 0.1: return 'no'
        return None

    def sig_pos(j):
        """A position from entry signal j: the side's recorded ask at the signal second, the market's recorded result."""
        if j in sig_cache: return sig_cache[j]
        sec, tk, sign, px, edge = entry_sigs[j]
        tm = terms.get(tk) or {}
        out = None
        if not tops.get(tk): sig_miss.add(tk)
        res = (mres or {}).get(tk) or (settle_of(tk, int(tm['closeTime'])) if tm.get('closeTime') and tops.get(tk) else None)
        if res in ('yes', 'no') and tm.get('closeTime') and tops.get(tk):
            ep = {'ticker': tk, 'sign': sign, 'asset': tm.get('asset'), 'close_ms': int(tm['closeTime']), 'entries': [], 'exits': []}
            ep['payout'] = 1.0 if (sign > 0) == (res == 'yes') else 0.0
            c_sec = ep['close_ms'] // 1000
            mk = {'ep': ep}
            if sec + 1 < c_sec - 0.10 * market_len(mk) - 60:
                path = build_path(ep, sec, c_sec)
                a = path['asks'][0]
                if a is not None and 0.01 <= a <= 0.98:
                    out = {'n': 1.0, 'floor': None, 'payout': ep['payout'], 'actual': None, 'bids': path['bids'], 'fv': path['fv'], 'path': path,
                           'cost': a, 'costF': a, 'c_sec': c_sec, 's0': sec, 'b0': a, 'q0': next((x for x in path['fv'] if x is not None), None),
                           'ep': ep, 'sig': sigma_cached(ep.get('asset'), sec) if ep.get('asset') else None}
        sig_cache[j] = out
        return out

    def pacer_run(paths, base, pacer, hourly=4.5, floor=0.75, cap=6.5, frac=0.10, no_exit_sec=60, size=None, reenter=False, depth=False, stake_fn=None, remap=None, loser=None, depth_px=0.02):
        """One base exit with (or without) the pacer on top, every position in time order on one clock. base: a sim() rule or
        None (hold everything); pacer: None | (mode, group) with mode 'cumulative' | 'rolling_hour' | 'slices' (Steven's
        non-stacking spec of Oct 30, bot/risk/quotaPacer.ts: catch-up slices of at most the hourly target).
        size=(lo, hi, mult): each position's stake (contracts x entry cost, fee in) clamped to [lo, hi] then scaled by mult, the
        contract count rescaled to match (Steven, Oct 30: $10-$20 now, $50-$100 asked). reenter=True (same market at the ask, kept
        only for old runs; Steven, Oct 31: not a method the bot uses, so the lab no longer measures it); reenter='any': once a
        pacer snipe banks its target, take the bot's next own taker entry
        signal (any market, either side) from the snipe to the end of its clock hour (at least 120 s), at the recorded ask, same stake. depth: contracts beyond the top-of-book size pay 2c worse
        (the ask on entry, the bid on a sale): the lab otherwise fills every size at the top.
        loser (Steven, Oct 31: nothing holds to settlement unless it is in the last 10% of its window and in profit): a dict of
        exits for positions not in profit, each a taker sale at the bid. 'window': inside the last share (or the final minute)
        sell whenever net after fees <= 0; 'stop': f sells once net <= -f x stake; 'fvbid': sells when the spot fair value is
        below the bid less its fee (holding is worth less than selling); 'fvcost': m sells when fair value < entry cost - m;
        'time': f sells when only f of the window is left and net < 0; 'grace': s seconds after entry before any cut but the window;
        'confirm': s seconds the cut must hold in a row before it sells; 'split': each second sells at most the top bid's size."""
        DEPTH_PX = depth_px
        ps = []
        for k0, p in enumerate(paths):
            p0 = p
            if p.get('costF') is None: continue
            p = dict(p, src=k0)
            if size is not None:
                lo, hi, mult = size
                stake = min(max(p['n'] * p['costF'], lo), hi) * mult
                p = dict(p, n=stake / p['costF'])
            if remap is not None:  # a different set or sizing of the same positions (None leaves one out)
                p = remap(p)
                if p is None: continue
            if stake_fn is not None:  # a sizing variant: the stake from the position (None skips the entry)
                stake = stake_fn(p)
                if stake is None or stake <= 0: continue
                p = dict(p, n=stake / p['costF'])
            ps.append(p)
        if not ps: return None
        if depth:  # entry depth folded into the cost a contract. The fidelity thread (Nov 1): a fill must remove what it took from
            # the book, so entries on the same market and ask within 60 s share its top size (refilled after 60 s, as
            # PAPER_TAKEN_REPLENISH_MS); without this, bigger stakes on repeated thin entries look better than they are.
            taken = collections.defaultdict(list)  # (ticker, ask) -> [(sec, contracts)]
            for k in sorted(range(len(ps)), key=lambda j: ps[j]['s0']):
                p = ps[k]; a0 = p['path']['asks'][0] if p['path']['asks'] else None
                key = (p['ep']['ticker'], a0); s0 = p['s0']
                used_ = sum(n_ for t_, n_ in taken[key] if s0 - t_ < 60)
                avail = max(0.0, (p['path']['asz'][0] or 0.0) - used_)
                taken[key].append((s0, p['n']))
                c = DEPTH_PX * max(0.0, p['n'] - avail)
                if c > 0: ps[k] = dict(p, costF=p['costF'] + c / p['n'], thin_in=c)

        sold = collections.defaultdict(list)  # (ticker, bid) -> [(sec, contracts)]: sales share the bid's size for 60 s too

        def bid_used(p, k):
            bs_ = p['path']['bids']; b = bs_[k] if 0 <= k < len(bs_) else None
            key = (p['ep']['ticker'], b); t_now = p['s0'] + k
            return key, sum(n_ for t_, n_ in sold[key] if t_now - t_ < 60)

        def took(p, k, n):  # a sale at path index k removes n contracts from that bid for 60 s (depth rows only)
            if depth: sold[bid_used(p, k)[0]].append((p['s0'] + k, n))

        def thin(p, k, px_sz, n):  # the depth charge: contracts over the top-of-book size at path index k
            if not depth: return 0.0
            sz = px_sz[k] if 0 <= k < len(px_sz) else None
            if p is not None and px_sz is p['path']['bsz']: sz = max(0.0, (sz or 0.0) - bid_used(p, k)[1])
            return DEPTH_PX * max(0.0, n - (sz or 0.0))

        outs = []
        for p in ps:
            v, sn, px, sec, armed = sim(p, *base) if base is not None else (None, 0.0, None, None, False)
            outs.append((v, sec))
        T0 = min(p['s0'] for p in ps); T1 = max(p['c_sec'] for p in ps); T_end = [T1]
        starts = collections.defaultdict(list); closes = collections.defaultdict(list)
        for i, p in enumerate(ps):
            starts[p['s0']].append(i)
            v, sec = outs[i]
            closes[sec if v is not None else p['c_sec']].append(i)
        st = {'real': 0.0, 'cyc': None, 'cyc_real': 0.0, 'bk': collections.defaultdict(float), 'base': 0, 'held': 0, 'snipe': 0, 'group': 0, 'cts': 0.0,
              'hours': 0, 'on_pace': 0, 'hkey': None, 'slice': 0.0, 'sl_h': 0,
              'per': {}, 'stk': {}, 'entries': len(ps), 're': 0, 're_real': 0.0, 'cap_now': 0.0, 'cap_peak': 0.0, 'thin_n': 0, 'thin_usd': 0.0,
              'held_w': 0, 'held_w_usd': 0.0, 'held_l': 0, 'held_l_usd': 0.0, 'cut': 0, 'cut_usd': 0.0, 'cut_win': 0, 'nobid': 0}
        live = set(); done = [False] * len(ps); child = [False] * len(ps); conf = {}
        for p in ps:
            if p.get('thin_in'): st['thin_n'] += 1; st['thin_usd'] += p['thin_in']

        def reenter_any(i, t):
            """The bot's next taker entry signal after the snipe at t on a market neither held here nor traded by paper nearby."""
            stake = ps[i]['n'] * ps[i]['costF']
            j0 = bisect.bisect_right(sig_secs, t)
            for j in range(j0, len(entry_sigs)):
                sec, tk, sign, px, edge = entry_sigs[j]
                if sec > max(t + 120, (t // 3600 + 1) * 3600): return None  # the rest of the clock hour (Steven: 'on repeat within the hour')
                if j in used or any(ps[x]['ep']['ticker'] == tk for x in live) or any(abs(s0 - sec) <= 300 for s0 in paper_at.get(tk, ())): continue
                q = sig_pos(j)
                if q is None: continue
                used.add(j)
                a = q['cost']; n0 = stake / a; n = stake / (a + fee1(a, n0)); cF = a + fee1(a, n)
                c = thin(None, 0, q['path']['asz'], n)
                if c > 0: cF += c / n; st['thin_n'] += 1; st['thin_usd'] += c
                q = dict(q, n=n, costF=cF)
                ps.append(q); done.append(False); child.append(True)
                v, sn, spx, ssec, armed = sim(q, *base) if base is not None else (None, 0.0, None, None, False)
                outs.append((v, ssec)); k = len(ps) - 1
                closes[ssec if v is not None else q['c_sec']].append(k); starts[sec].append(k); T_end[0] = max(T_end[0], q['c_sec'])
                st['re'] += 1; st['entries'] += 1
                return k
            return None

        used = set()

        def reenter_at(i, t):
            """Buy the same side again at the ask at t + 1 with the same stake; returns the new position's index or None."""
            p = ps[i]; t1 = t + 1; k = t1 - p['s0']
            if t1 > p['c_sec'] - no_exit_sec or t1 > p['c_sec'] - frac * market_len(p) - 60: return None
            pa = p['path']
            if not (0 <= k < len(pa['asks'])): return None
            a = pa['asks'][k]
            if a is None or not (0.01 <= a <= 0.98): return None
            stake = p['n'] * p['costF']
            n0 = stake / a; cF = a + fee1(a, n0)
            n = stake / cF; cF = a + fee1(a, n)
            c = thin(None, k, pa['asz'], n)
            if c > 0: cF += c / n; st['thin_n'] += 1; st['thin_usd'] += c
            sub = {key: pa[key][k:] for key in ('bids', 'bsz', 'asks', 'asz', 'fv', 'spot')}
            sub['s0'] = t1
            q = dict(p, n=n, bids=sub['bids'], fv=sub['fv'], path=sub, cost=a, costF=cF, s0=t1, b0=a, floor=None,
                     q0=next((x for x in sub['fv'] if x is not None), None), actual=None)
            ps.append(q); done.append(False); child.append(True)
            v, sn, px, sec, armed = sim(q, *base) if base is not None else (None, 0.0, None, None, False)
            outs.append((v, sec)); j = len(ps) - 1
            closes[sec if v is not None else q['c_sec']].append(j); starts[t1].append(j)
            st['re'] += 1; st['entries'] += 1
            return j

        def hidx(t): return min(int((t - st['cyc']) // 3600) + 1, 24)

        def req(h):  # what the rest of the cycle owes an hour block, this one included
            return max(0.0, 24 * hourly - st['cyc_real']) / max(1, 24 - h + 1)

        def slice_goal(h): return min(hourly, req(h))

        def credit(x, t):
            st['real'] += x; st['cyc_real'] += x; st['bk'][hidx(t)] += x
            if pacer is not None and pacer[0] == 'slices':
                h = hidx(t); st['slice'] += x; g = slice_goal(h); n = 0
                while g > 0 and st['slice'] >= g - 1e-9 and n < 1000:  # a slice reached is banked, the excess carried
                    st['slice'] -= g; st['sl_h'] += 1; n += 1; g = slice_goal(h)
                    if g < floor: break
                if st['slice'] < 0: st['slice'] = 0.0  # a loss never raises the target

        def need(t):
            h = hidx(t)
            if pacer[0] == 'slices':
                catch = req(h) > hourly + 1e-9
                raw = floor if st['sl_h'] > 0 and not catch else slice_goal(h) - st['slice']
                return max(floor, min(raw, hourly))
            raw = h * hourly - st['cyc_real'] if pacer[0] == 'cumulative' else hourly - st['bk'][h]
            return max(floor, min(raw, cap))

        def close(i, t, x, kind):
            done[i] = True; live.discard(i); credit(x, t); st[kind] += 1
            if not child[i]: st['per'][ps[i]['src']] = st['per'].get(ps[i]['src'], 0.0) + x; st['stk'][ps[i]['src']] = ps[i]['n'] * ps[i]['costF']
            st['cap_now'] -= ps[i]['n'] * ps[i]['costF']
            if child[i]: st['re_real'] += x

        t = T0 - 1
        while t < T_end[0]:
            t += 1
            a = ny_anchor(t)
            if st['cyc'] is None or a > st['cyc']:
                st['cyc'] = a; st['cyc_real'] = 0.0; st['bk'] = collections.defaultdict(float)
            hk = (st['cyc'], hidx(t))
            if st['hkey'] is not None and hk != st['hkey']:
                # the clock hour that just ended: on pace if the cycle's realized total had reached its goal
                st['hours'] += 1
                c0, h0 = st['hkey']
                if c0 == st['cyc'] and st['cyc_real'] >= h0 * hourly - 1e-9: st['on_pace'] += 1
                elif c0 != st['cyc'] and st.get('last_cyc_real', 0.0) >= h0 * hourly - 1e-9: st['on_pace'] += 1
                st['slice'] = 0.0; st['sl_h'] = 0  # slices: a new clock hour starts a fresh slice (a partial one is not owed)
            st['hkey'] = hk; st['last_cyc_real'] = st['cyc_real']
            for i in starts.get(t, ()):
                live.add(i); st['cap_now'] += ps[i]['n'] * ps[i]['costF']
            st['cap_peak'] = max(st['cap_peak'], st['cap_now'])
            for i in list(closes.get(t, ())):
                if done[i]: continue
                p = ps[i]; v, sec = outs[i]
                if v is not None and sec == t:
                    c = thin(p, t - p['s0'], p['path']['bsz'], p['n'])
                    if c > 0: st['thin_n'] += 1; st['thin_usd'] += c
                    took(p, t - p['s0'], p['n'])
                    close(i, t, (v - p['costF']) * p['n'] - c, 'base')
                else:
                    x = (p['payout'] - p['costF']) * p['n']; close(i, t, x, 'held')
                    if x > 0: st['held_w'] += 1; st['held_w_usd'] += x
                    else: st['held_l'] += 1; st['held_l_usd'] += x
            if loser is not None:
                for i in sorted(live):
                    p = ps[i]; k = t - p['s0']
                    b = p['bids'][k] if 0 <= k < len(p['bids']) else None
                    inwin = t > p['c_sec'] - no_exit_sec or t > p['c_sec'] - loser.get('wfrac', frac) * market_len(p)
                    if b is None:
                        if inwin and t == p['c_sec'] - 1: st['nobid'] += 1
                        continue
                    c = thin(p, k, p['path']['bsz'], p['n'])
                    net = p['n'] * (b - p['costF']) - taker_fee(p['n'], b) - c
                    if net > 1e-9: continue
                    if loser.get('slip'):  # adversary: every loser sale fills this much under the recorded bid
                        b = max(0.01, b - loser['slip']); net = p['n'] * (b - p['costF']) - taker_fee(p['n'], b) - c
                    cut = inwin and loser.get('window', True)
                    if not cut and t - p['s0'] >= loser.get('grace', 0):
                        stake = p['n'] * p['costF']; kd = k - loser.get('delay', 0)  # adversary: the cut sees the book d s late
                        q = p['fv'][kd] if 0 <= kd < len(p['fv']) else None
                        if loser.get('delay'): bd = p['bids'][kd] if 0 <= kd < len(p['bids']) else None; b_sig = bd if bd is not None else b
                        else: b_sig = b
                        if 'stop' in loser and net <= -loser['stop'] * stake: cut = True
                        elif 'fvbid' in loser and q is not None and q < b_sig - fee1(b_sig, p['n']) - loser['fvbid']: cut = True
                        elif 'fvcost' in loser and q is not None and q < p['costF'] - loser['fvcost']: cut = True
                        elif 'time' in loser and t > p['c_sec'] - loser['time'] * market_len(p): cut = True
                    if cut and not inwin and loser.get('confirm'):
                        conf[i] = conf.get(i, 0) + 1
                        if conf[i] < loser['confirm']: cut = False
                    elif not cut: conf.pop(i, None)
                    if cut:
                        sz = p['path']['bsz'][k] if 0 <= k < len(p['path']['bsz']) else None
                        if depth and sz is not None: sz = max(0.0, sz - bid_used(p, k)[1])
                        if loser.get('split') and depth and sz is not None and sz <= 1e-9: continue  # the bid is used up: wait
                        if loser.get('split') and sz and sz < p['n'] - 1e-9:  # only the top bid's size this second, the rest waits
                            m = sz; x = m * (b - p['costF']) - taker_fee(m, b)
                            credit(x, t); st['cut_usd'] += x; st['cap_now'] -= m * p['costF']
                            if not child[i]: st['per'][p['src']] = st['per'].get(p['src'], 0.0) + x
                            took(p, k, m); p['n'] -= m
                            continue
                        if c > 0: st['thin_n'] += 1; st['thin_usd'] += c
                        took(p, k, p['n']); close(i, t, net, 'cut'); st['cut_usd'] += net
                        if p['payout'] > 0.5: st['cut_win'] += 1  # would have settled a winner
            if pacer is None: continue
            members = []
            for i in sorted(live):
                p = ps[i]
                if t > p['c_sec'] - no_exit_sec or t > p['c_sec'] - frac * market_len(p): continue  # final minute / last share
                k = t - p['s0']
                b = p['bids'][k] if 0 <= k < len(p['bids']) else None
                if b is None: continue
                c = thin(p, k, p['path']['bsz'], p['n'])
                net = p['n'] * (b - p['costF']) - taker_fee(p['n'], b) - c
                if net >= need(t) - 1e-9:
                    if c > 0: st['thin_n'] += 1; st['thin_usd'] += c
                    took(p, k, p['n']); close(i, t, net, 'snipe'); st['cts'] += p['n']
                    if reenter == 'any': reenter_any(i, t)
                    elif reenter: reenter_at(i, t)
                elif net > 1e-9:
                    members.append((i, net))
            if pacer[1] and len(members) >= 2 and sum(x for _, x in members) >= need(t) - 1e-9:
                for i, net in members:
                    close(i, t, net, 'group'); st['cts'] += ps[i]['n']
        st['span_h'] = (T1 - T0) / 3600.0
        st['n'] = len(ps)
        return st

    def pacer_table(paths, title, bases):
        print(f'  F. the hourly quota pacer (PACER) in time order on {title}: $4.50 an hour from 10:00 AM New York. cumulative (PR #204):')
        print('     the deficit since the anchor clamped to [0.75, 6.50]; slices (Steven, Oct 30, PR #205): the required rate (108 less the')
        print('     cycle realized, over the hour blocks left) caps a slice at 4.50 when behind, else the rate; the threshold is the slice goal')
        print('     less what it banked, a fresh slice each clock hour, 0.75 once a slice is banked on pace, floored at 0.75. One position (or,')
        print('     with the group rule, several each in profit) sold at the bid once its net profit after fees covers it; the last 10% of a')
        print('     window holds a position in profit, the final 60 s every one. Realized $ after fees against entry cost (fee in), the clock')
        print('     counting only these positions.')
        print('    base exit; pacer                                                  realized $     $/h  base sales  snipes  group  contracts sniped  held  hours on pace')
        for bname, base in bases:
            for pname, pacer in (('no pacer', None), ('pacer (cumulative, group rule)', ('cumulative', True)), ('pacer (slices, group rule)', ('slices', True)), ('pacer (slices, no group rule)', ('slices', False))):
                r = pacer_run(paths, base, pacer)
                if r is None: print('    (no costed position)'); return
                lab = f'{bname}; {pname}'
                print(f"    {lab:66s} {r['real']:+10.2f}  {r['real'] / max(r['span_h'], 1e-9):+6.2f}  {r['base']:10d}  {r['snipe']:6d}  {r['group']:5d}  {r['cts']:16.1f}  {r['held']:4d}  {r['on_pace']:5d} of {r['hours']}")

    # ---- A. from the actual locks (the same positions as 1d) -------------------------------------------------------
    pathsA = []
    for a in acts:
        ep = a['ep']
        if ep['payout'] is None or not ep.get('close_ms') or not tops.get(ep['ticker']) or a['floor'] is None: continue
        c_sec = ep['close_ms'] // 1000; s0 = a['act_ms'] // 1000
        if c_sec <= s0 + 1: continue
        en = sum(e['n'] for e in ep['entries'] if e['ms'] <= a['act_ms']); ex = sum(x['n'] for x in ep['exits'] if x['ms'] < a['act_ms'])
        n = round(en - ex, 2)
        if n <= 0: continue
        left, got = n, 0.0
        for x in sorted(ep['exits'], key=lambda x: x['ms']):
            if x['ms'] < a['act_ms'] or left <= 1e-9: continue
            k = min(left, x['n']); got += k * x['px'] - x['fee'] * k / x['n']; left -= k
        got += left * ep['payout']
        path = build_path(ep, s0, c_sec)
        b0 = next((x for x in path['bids'] if x is not None), None)
        q0 = next((x for x in path['fv'] if x is not None), None)
        pathsA.append({'n': n, 'floor': a['floor'], 'payout': ep['payout'], 'actual': got / n, 'bids': path['bids'], 'fv': path['fv'], 'path': path, 'cost': cost_of(ep['entries'], a['act_ms']), 'costF': cost_of(ep['entries'], a['act_ms']),
                       'c_sec': c_sec, 's0': s0, 'b0': b0, 'q0': q0, 'ep': ep, 'sig': sigma_cached(ep.get('asset'), s0) if ep.get('asset') else None})
    have_fv = sum(1 for p in pathsA if p['q0'] is not None)
    print(f'  spot-implied fair value available on {have_fv} of {len(pathsA)} hunted positions (strike from the market record or the index at the open)')
    R = lambda lock, trail, sale, guard=None, window=0, extra=None: (lock, trail, sale, guard, window, extra)
    A = ('armed',)
    rulesA = [
        ('bid trail 1 tick (as 1d)', R(A, ('bid', 1), ('taker',))),
        ('bid trail 2 ticks', R(A, ('bid', 2), ('taker',))),
        ('bid trail 1, guard: bid >= fv', R(A, ('bid', 1), ('taker',), 0.0)),
        ('bid trail 1, guard: bid >= fv - 2c', R(A, ('bid', 1), ('taker',), 0.02)),
        ('bid trail 1, guard: bid >= fv - 5c', R(A, ('bid', 1), ('taker',), 0.05)),
        ('bid trail 1, hold while spot moves with us', R(A, ('bid', 1), ('taker',), None, 0, 'spot')),
        ('bid trail 1, hold on a 3x top-bid wall', R(A, ('bid', 1), ('taker',), None, 0, 'book')),
        ('bid trail 1, no sale in the last 300 s', R(A, ('bid', 1), ('taker',), None, 300)),
        ('fv trail 3 pts', R(A, ('fv', 0.03), ('taker',))),
        ('fv trail 5 pts', R(A, ('fv', 0.05), ('taker',))),
        ('fv trail 5 pts, guard: bid >= fv - 2c', R(A, ('fv', 0.05), ('taker',), 0.02)),
        ('fv trail 8 pts', R(A, ('fv', 0.08), ('taker',))),
        ('fv trail 8 pts, guard: bid >= fv - 2c', R(A, ('fv', 0.08), ('taker',), 0.02)),
        ('fv trail 12 pts', R(A, ('fv', 0.12), ('taker',))),
        ('rest an ask at lock + 1 tick (no fee)', R(A, ('none',), ('rest', 1, 'fixed'))),
        ('rest an ask at lock + 2 ticks', R(A, ('none',), ('rest', 2, 'fixed'))),
        ('rest an ask at lock + 3 ticks', R(A, ('none',), ('rest', 3, 'fixed'))),
        ('rest an ask at lock + 5 ticks', R(A, ('none',), ('rest', 5, 'fixed'))),
        ('rest an ask at fv + 2c, ratcheting up', R(A, ('none',), ('rest', 2, 'fv'))),
        ('rest an ask at fv + 3c, ratcheting up', R(A, ('none',), ('rest', 3, 'fv'))),
        ('rest an ask at fv + 5c, ratcheting up', R(A, ('none',), ('rest', 5, 'fv'))),
        ('rest lock + 2 & bid trail 1', R(A, ('bid', 1), ('rest', 2, 'fixed'))),
        ('rest lock + 3 & bid trail 1, guard fv - 2c', R(A, ('bid', 1), ('rest', 3, 'fixed'), 0.02)),
        ('rest fv + 3 & fv trail 8, guard fv - 2c', R(A, ('fv', 0.08), ('rest', 3, 'fv'), 0.02)),
        ('rest lock + 3 & fv trail 8', R(A, ('fv', 0.08), ('rest', 3, 'fixed'))),
        ('bid trail 1, confirmed 2 s under the stop', R(A, ('bid', 1), ('taker',), None, 0, {'confirm': 2})),
        ('bid trail 1, confirmed 5 s', R(A, ('bid', 1), ('taker',), None, 0, {'confirm': 5})),
        ('bid trail 1, confirmed 10 s', R(A, ('bid', 1), ('taker',), None, 0, {'confirm': 10})),
        ('bid trail 2, confirmed 5 s', R(A, ('bid', 2), ('taker',), None, 0, {'confirm': 5})),
        ('vol trail 1 sd of the bid (120 s)', R(A, ('vol', 1.0), ('taker',))),
        ('vol trail 2 sd', R(A, ('vol', 2.0), ('taker',))),
        ('vol trail 3 sd', R(A, ('vol', 3.0), ('taker',))),
        ('vol trail 2 sd, guard fv - 2c', R(A, ('vol', 2.0), ('taker',), 0.02)),
        ('bid trail 1, hold while taker flow favours us (60 s)', R(A, ('bid', 1), ('taker',), None, 0, 'flow')),
        ('sell at the lock if bid >= fv, else hold', R(A, ('none',), ('lock', 0.0, 'else_hold'))),
        ('sell at the lock if bid >= fv + 2c, else hold', R(A, ('none',), ('lock', 0.02, 'else_hold'))),
        ('sell at the lock if bid >= fv + 4c, else hold', R(A, ('none',), ('lock', 0.04, 'else_hold'))),
        ('sell at the lock if bid >= fv - 2c, else hold', R(A, ('none',), ('lock', -0.02, 'else_hold'))),
        ('sell at the lock if taker flow favours us, else hold', R(A, ('none',), ('lock', 0.0, 'else_hold', 'flow'))),
        ('sell at the lock if bid >= fv - 2c or flow favours us', R(A, ('none',), ('lock', -0.02, 'else_hold', 'either'))),
        ('sell at the lock if bid >= fv - 2c and flow favours us', R(A, ('none',), ('lock', -0.02, 'else_hold', 'both'))),
        ('sell at the lock if bid >= fv - 2c, else fv trail 8', R(A, ('fv', 0.08), ('lock', -0.02, 'else_trail'))),
        ('sell at the lock if bid >= fv + 2c, else bid trail 1', R(A, ('bid', 1), ('lock', 0.02, 'else_trail'))),
        ('sell at the lock if bid >= fv + 2c, else vol trail 2 sd', R(A, ('vol', 2.0), ('lock', 0.02, 'else_trail'))),
        ('sell at the lock if bid >= fv + 2c, else fv trail 8', R(A, ('fv', 0.08), ('lock', 0.02, 'else_trail'))),
        # v5: the stop sale judged against the fair value the other way round: sell only into a bid over fair value
        ('bid trail 1, sell only if bid >= fv + 2c (else keep trailing)', R(A, ('bid', 1), ('taker',), -0.02)),
        ('bid trail 1, sell only if bid >= fv + 4c (else keep trailing)', R(A, ('bid', 1), ('taker',), -0.04)),
        ('bid trail 2, sell only if bid >= fv + 2c (else keep trailing)', R(A, ('bid', 2), ('taker',), -0.02)),
        ('bid trail 4, sell only if bid >= fv + 2c (else keep trailing)', R(A, ('bid', 4), ('taker',), -0.02)),
        ('bid trail 1, first trigger: sell if bid >= fv, else hold', R(A, ('bid', 1), ('taker',), 0.0, 0, {'first_only': True})),
        ('bid trail 1, first trigger: sell if bid >= fv + 2c, else hold', R(A, ('bid', 1), ('taker',), -0.02, 0, {'first_only': True})),
        ('bid trail 1, first trigger: sell if bid >= fv + 4c, else hold', R(A, ('bid', 1), ('taker',), -0.04, 0, {'first_only': True})),
        ('bid trail 2, first trigger: sell if bid >= fv + 2c, else hold', R(A, ('bid', 2), ('taker',), -0.02, 0, {'first_only': True})),
        ('fv trail 5 pts, sell only if bid >= fv + 2c (else keep trailing)', R(A, ('fv', 0.05), ('taker',), -0.02)),
        ('fv trail 5 pts, first trigger: sell if bid >= fv + 2c, else hold', R(A, ('fv', 0.05), ('taker',), -0.02, 0, {'first_only': True})),
        ('sell at the lock if bid >= fv + 2c, else trail 1 with the same test (keep trailing)', R(A, ('bid', 1), ('lock', 0.02, 'else_trail'), -0.02)),
        ('sell at the lock if bid >= fv + 2c, else trail 1, first trigger with the same test, else hold', R(A, ('bid', 1), ('lock', 0.02, 'else_trail'), -0.02, 0, {'first_only': True})),
        ('sell at the lock if bid >= fv, else trail 1 sell only if bid >= fv (keep trailing)', R(A, ('bid', 1), ('lock', 0.0, 'else_trail'), 0.0)),
        ('sell any second the bid >= fv, else hold', R(A, ('none',), ('any', 0.0))),
        ('sell any second the bid >= fv + 2c, else hold', R(A, ('none',), ('any', 0.02))),
        ('sell any second the bid >= fv + 4c, else hold', R(A, ('none',), ('any', 0.04))),
        ('sell any second the bid >= fv + 2c, none in the last 120 s', R(A, ('none',), ('any', 0.02), None, 120)),
        # v6: Steven's variants: keep checking the premium, scale it with the rise since the lock, rest at sell walls
        ('Steven: sell any second the bid >= fv + 2c + 0.5 x the rise since the lock', R(A, ('none',), ('anyscale', 0.02, 0.5))),
        ('Steven: sell any second the bid >= fv + 2c + 1 x the rise since the lock', R(A, ('none',), ('anyscale', 0.02, 1.0))),
        ('Steven: sell any second the bid >= fv + 2c + 2 x the rise since the lock', R(A, ('none',), ('anyscale', 0.02, 2.0))),
        ('Steven: sell any second the bid >= fv + 4c + 1 x the rise since the lock', R(A, ('none',), ('anyscale', 0.04, 1.0))),
        ('Steven: at every dip (trail 1) sell if bid >= fv + 2c + 0.5 x the rise, else keep trailing', R(A, ('bid', 1), ('taker',), ('scale', 0.02, 0.5))),
        ('Steven: at every dip (trail 1) sell if bid >= fv + 2c + 1 x the rise, else keep trailing', R(A, ('bid', 1), ('taker',), ('scale', 0.02, 1.0))),
        ('Steven: at every dip (trail 2) sell if bid >= fv + 2c + 1 x the rise, else keep trailing', R(A, ('bid', 2), ('taker',), ('scale', 0.02, 1.0))),
        ('first dip only (trail 1): sell if bid >= fv + 2c + 0.5 x the rise, else hold', R(A, ('bid', 1), ('taker',), ('scale', 0.02, 0.5), 0, {'first_only': True})),
        ('Steven: rest an ask at a sell wall (ask 3x the bid, >= the position) paying fv + 2c', R(A, ('none',), ('wall', 3, 0.02))),
        ('Steven: rest an ask at a sell wall (ask 5x the bid) paying fv + 2c', R(A, ('none',), ('wall', 5, 0.02))),
        ('Steven: rest an ask at a sell wall (ask 3x the bid), any premium', R(A, ('none',), ('wall', 3, None))),
        ('Steven: rest an ask at a sell wall (3x, fv + 2c) and trail 1 under the peak', R(A, ('bid', 1), ('wall', 3, 0.02))),
        ('Steven: rest an ask at a sell wall (3x, fv + 2c), first-dip judgement (fv + 2c) else hold', R(A, ('bid', 1), ('wall', 3, 0.02), -0.02, 0, {'first_only': True})),
        # Steven's risk rule (Oct 29 23:15): out in profit at the dip, unless less than 10% of the window is left, then settle
        ('Steven RM: trailing stop (trail 1), no sale in the last 10% of the window', R(A, ('bid', 1), ('taker',), None, ('frac', 0.10))),
        ('Steven RM: trailing stop (trail 2), no sale in the last 10%', R(A, ('bid', 2), ('taker',), None, ('frac', 0.10))),
        ('Steven RM: trail 1, last 20% settles', R(A, ('bid', 1), ('taker',), None, ('frac', 0.20))),
        ('Steven RM: trail 1, last 5% settles', R(A, ('bid', 1), ('taker',), None, ('frac', 0.05))),
        ('Steven RM: trail 1, last 10%, sell only in profit vs cost (else keep trailing)', R(A, ('bid', 1), ('taker',), ('profit',), ('frac', 0.10))),
        ('Steven RM: trail 1, last 10%, with the sell wall (3x, fv + 2c)', R(A, ('bid', 1), ('wall', 3, 0.02), None, ('frac', 0.10))),
        ('Steven RM: trail 1, last 10%, sell wall, first dip judged vs fv + 2c else hold', R(A, ('bid', 1), ('wall', 3, 0.02), -0.02, ('frac', 0.10), {'first_only': True})),
    ]
    table(pathsA, rulesA, 'A. from the actual locks', True)
    print('    PR #204 window: no sale in the final 60 s; in the last 10% of the window none that would be in profit (it rides)')
    rows204 = [
        ('PR #204: first dip judged vs fv + 2c else hold', R(A, ('bid', 1), ('taker',), -0.02, ('frac_profit', 0.10), {'first_only': True})),
        ('PR #204 + #203: sell wall, first-dip judgement', R(A, ('bid', 1), ('wall', 3, 0.02), -0.02, ('frac_profit', 0.10), {'first_only': True})),
        ('PR #204 window, trailing stop (trail 1)', R(A, ('bid', 1), ('taker',), None, ('frac_profit', 0.10))),
    ]
    table(pathsA, rows204, 'A. (same positions), PR #204\'s window', True)
    pacer_table(pathsA, 'the hunted positions from their locks (A)', [('hold all', None)] + [(n, r) for n, r in rows204[:2]])

    # ---- B. from entry on every position, with the policy's own lock -------------------------------------------------
    pathsB = []
    for ep in episodes:
        if ep['payout'] is None or not ep.get('close_ms') or not tops.get(ep['ticker']) or not ep['entries']: continue
        c_sec = ep['close_ms'] // 1000
        ents = sorted(ep['entries'], key=lambda e: e['ms'])
        s0 = ents[0]['ms'] // 1000 + 1
        if c_sec <= s0 + 1: continue
        n = round(sum(e['n'] for e in ents), 2)
        if n <= 0: continue
        cost = sum(e['n'] * e['px'] for e in ents) / n
        nb = cb = 0.0
        for e in ents:
            o = (orders or {}).get(e.get('coid')) or {}
            try: stake_o = float(o.get('count') or 0) * e['px']
            except Exception: stake_o = 0.0
            fct = min(max(stake_o, 10.0), 20.0) / stake_o if stake_o > 0 else 1.0
            nb += e['n'] * fct; cb += e['n'] * fct * (e['px'] + (e['fee'] / e['n'] if e['n'] else 0.0))
        path = build_path(ep, s0, c_sec)
        q0 = next((x for x in path['fv'] if x is not None), None)
        pathsB.append({'origin': ep.get('origin', 'normal'), 'n_band': nb, 'costF_band': (cb / nb) if nb > 0 else None, 'n': n, 'floor': None, 'payout': ep['payout'], 'actual': None, 'bids': path['bids'], 'fv': path['fv'], 'path': path, 'cost': cost, 'costF': cost_of(ents, ep['close_ms']),
                       'c_sec': c_sec, 's0': s0, 'b0': cost, 'q0': q0, 'ep': ep, 'sig': sigma_cached(ep.get('asset'), s0) if ep.get('asset') else None})
    print(f'  (B: the lock is the policy\'s own: \'bid\' = the side bid 2c over the average entry price, \'fv\' = the spot-implied fair value 3 pts over its value at entry)')
    for lname, lock in (('lock: bid +2c', ('bid', 0.02)), ('lock: fv +3 pts', ('fv', 0.03)), ('lock: bid +2c and fv +3 pts', ('both', 0.02))):
        rulesB = [
            (f'{lname}; bid trail 1', R(lock, ('bid', 1), ('taker',))),
            (f'{lname}; bid trail 1, guard fv - 2c', R(lock, ('bid', 1), ('taker',), 0.02)),
            (f'{lname}; fv trail 5', R(lock, ('fv', 0.05), ('taker',))),
            (f'{lname}; fv trail 8, guard fv - 2c', R(lock, ('fv', 0.08), ('taker',), 0.02)),
            (f'{lname}; rest lock + 2', R(lock, ('none',), ('rest', 2, 'fixed'))),
            (f'{lname}; rest lock + 3', R(lock, ('none',), ('rest', 3, 'fixed'))),
            (f'{lname}; rest fv + 3, ratcheting', R(lock, ('none',), ('rest', 3, 'fv'))),
            (f'{lname}; rest lock + 2 & bid trail 1', R(lock, ('bid', 1), ('rest', 2, 'fixed'))),
            (f'{lname}; rest fv + 3 & fv trail 8, guard fv - 2c', R(lock, ('fv', 0.08), ('rest', 3, 'fv'), 0.02)),
            (f'{lname}; bid trail 1, confirmed 5 s', R(lock, ('bid', 1), ('taker',), None, 0, {'confirm': 5})),
            (f'{lname}; vol trail 2 sd', R(lock, ('vol', 2.0), ('taker',))),
            (f'{lname}; sell at the lock if bid >= fv + 2c, else hold', R(lock, ('none',), ('lock', 0.02, 'else_hold'))),
            (f'{lname}; sell at the lock if bid >= fv + 2c, else vol trail 2 sd', R(lock, ('vol', 2.0), ('lock', 0.02, 'else_trail'))),
            (f'{lname}; sell at the lock if bid >= fv - 2c, else hold', R(lock, ('none',), ('lock', -0.02, 'else_hold'))),
            (f'{lname}; sell at the lock if taker flow favours us, else hold', R(lock, ('none',), ('lock', 0.0, 'else_hold', 'flow'))),
            (f'{lname}; sell at the lock if bid >= fv - 2c or flow favours us', R(lock, ('none',), ('lock', -0.02, 'else_hold', 'either'))),
            (f'{lname}; sell at the lock if bid >= fv - 2c and flow favours us', R(lock, ('none',), ('lock', -0.02, 'else_hold', 'both'))),
            (f'{lname}; bid trail 1, sell only if bid >= fv + 2c (keep trailing)', R(lock, ('bid', 1), ('taker',), -0.02)),
            (f'{lname}; bid trail 1, first trigger: sell if bid >= fv + 2c, else hold', R(lock, ('bid', 1), ('taker',), -0.02, 0, {'first_only': True})),
            (f'{lname}; sell any second the bid >= fv + 2c, else hold', R(lock, ('none',), ('any', 0.02))),
        ]
        table(pathsB, rulesB, f'B. from entry, {lname}', False)
    lockB = ('bid', 0.02)
    pacer_table(pathsB, 'every position from its entry (B: the bot\'s whole clock)', [
        ('hold all', None),
        ('lock bid +2c, first dip judged vs fv + 2c else hold (PR #204 window)', R(lockB, ('bid', 1), ('taker',), -0.02, ('frac_profit', 0.10), {'first_only': True})),
    ])

    # ---- G. Steven, Oct 30: bigger stakes ($50-$100 an order) and buying again after each target is banked ------------
    print('  G. sizes and re-entry on every position from its entry (B), current exits (lock bid +2c, first dip judged vs fv + 2c')
    print('     else hold, PR #204 window) and the slices pacer with no group rule unless the row says otherwise. Stakes: each position\'s')
    print('     entry cost clamped to the band, the contract count rescaled (x5 for $50-$100). Re-entry: after a pacer snipe banks its')
    print('     target, take the bot\'s next own entry signal in any market, either side, to the end of the clock hour (same stake).')
    print('     Depth: contracts over the top-of-book size pay 2c worse on entry and sale (top-of-book only, no deeper levels).')
    baseG = R(lockB, ('bid', 1), ('taker',), -0.02, ('frac_profit', 0.10), {'first_only': True})
    SL = ('slices', False)
    ANY = ({'size': (10, 20, 1), 'reenter': 'any'}, {'size': (10, 20, 1), 'reenter': 'any', 'depth': True},
           {'size': (10, 20, 5), 'reenter': 'any'}, {'size': (10, 20, 5), 'reenter': 'any', 'depth': True})
    tried = set()
    for gen in range(3 if more_books else 0):  # the signal markets a re-entry reaches (each pass can reach further)
        sig_miss.clear()
        for kw in ANY: pacer_run(pathsB, baseG, SL, **kw)
        new = sig_miss - tried
        if not new: break
        tried |= new
        more_books(new)
        for j in [j for j in sig_cache if entry_sigs[j][1] in new]: del sig_cache[j]
    ok = sum(1 for j in range(len(entry_sigs)) if sig_pos(j) is not None)
    agree = []
    for ep in episodes:
        if ep.get('payout') is None or not ep.get('close_ms'): continue
        r = settle_of(ep['ticker'], ep['close_ms'])
        if r: agree.append((1.0 if r == ('yes' if ep['sign'] > 0 else 'no') else 0.0) == ep['payout'])
    print(f"     'next signal' (to the end of the snipe's clock hour): the bot's own taker entry signals (decision records placing an entry): {len(entry_sigs)} in the window, {ok} with a")
    print(f"     book path and a recorded result; signal markets paper itself traded within 5 min are skipped. Settled from the index (last 60 s vs strike); that rule agrees with paper's settlements on {sum(agree)} of {len(agree)} of paper's markets.")
    print('    stake; pacer; re-entry; depth                                     realized $     $/h  entries  re-entries  re-entry $  base sales  snipes  held  peak $ at work  thin fills  depth $')
    for lab, pacer, kw in (
            ("paper's own sizes; slices no group", SL, {}),
            ('$10-$20; no pacer', None, {'size': (10, 20, 1)}),
            ('$10-$20; slices no group [BASELINE]', SL, {'size': (10, 20, 1)}),
            ('$10-$20; slices no group; depth', SL, {'size': (10, 20, 1), 'depth': True}),
            ('$50-$100; no pacer', None, {'size': (10, 20, 5)}),
            ('$50-$100; slices no group', SL, {'size': (10, 20, 5)}),
            ('$50-$100; slices no group; depth', SL, {'size': (10, 20, 5), 'depth': True}),
            ('$10-$20; slices no group; next signal any market', SL, {'size': (10, 20, 1), 'reenter': 'any'}),
            ('$10-$20; slices no group; next signal; depth', SL, {'size': (10, 20, 1), 'reenter': 'any', 'depth': True}),
            ('$50-$100; slices no group; next signal any market', SL, {'size': (10, 20, 5), 'reenter': 'any'}),
            ('$50-$100; slices no group; next signal; depth', SL, {'size': (10, 20, 5), 'reenter': 'any', 'depth': True})):
        r = pacer_run(pathsB, baseG, pacer, **kw)
        if r is None: print('    (no costed position)'); break
        print(f"    {lab:66s} {r['real']:+10.2f}  {r['real'] / max(r['span_h'], 1e-9):+6.2f}  {r['entries']:7d}  {r['re']:10d}  {r['re_real']:+10.2f}  {r['base']:10d}  {r['snipe']:6d}  {r['held']:4d}  {r['cap_peak']:14.2f}  {r['thin_n']:10d}  {r['thin_usd']:7.2f}")

    # ---- G2. (sizing thread, Oct 31) where the $10-$20 band loses: by the price paid, and price-aware sizing variants ------
    print('  G2. by the price paid for the side bought (average entry price, fee out), current exits + slices pacer, no group rule:')
    print('     positions, $ staked and realized $ after fees at paper\'s own sizes and at the $10-$20 band (one joint run each, each')
    print('     position\'s own realized $).')
    own = pacer_run(pathsB, baseG, SL)
    band = pacer_run(pathsB, baseG, SL, size=(10, 20, 1))
    if own is not None and band is not None:
        cuts = ((0.0, 0.10, 'under 10c'), (0.10, 0.20, '10-20c'), (0.20, 0.35, '20-35c'), (0.35, 0.65, '35-65c'), (0.65, 0.80, '65-80c'), (0.80, 1.01, 'over 80c'))
        print('    price paid    positions   won%   own: staked   realized    band: staked   realized')
        for lo, hi, nm in cuts:
            ks = [k for k, p in enumerate(pathsB) if p.get('costF') is not None and lo <= p['cost'] < hi]
            won = sum(1 for k in ks if pathsB[k]['payout'] > 0.5)
            print(f"    {nm:12s} {len(ks):10d}  {100 * won / len(ks) if ks else 0:5.0f}  {sum(own['stk'].get(k, 0) for k in ks):12.2f}  {sum(own['per'].get(k, 0) for k in ks):+9.2f}  {sum(band['stk'].get(k, 0) for k in ks):14.2f}  {sum(band['per'].get(k, 0) for k in ks):+9.2f}")
    def bandv(p): return min(max(p['n'] * p['costF'], 10.0), 20.0)
    def ownv(p): return p['n'] * p['costF']
    print('    sizing variant                                                    realized $     $/h  entries  snipes  held  peak $ at work  depth $')
    rows = [("paper's own sizes", {}), ('$10-$20 band [BASELINE]', {'size': (10, 20, 1)})]
    for cut in (0.10, 0.20, 0.35):
        c = int(round(cut * 100))
        rows.append((f'(a) band at {c}c and up, own size below', {'stake_fn': (lambda cut: lambda p: bandv(p) if p['cost'] >= cut else ownv(p))(cut)}))
        rows.append((f'(b) band at {c}c and up, no entry below', {'stake_fn': (lambda cut: lambda p: bandv(p) if p['cost'] >= cut else None)(cut)}))
    rows += [('(c) band x min(1, price / 0.35)', {'stake_fn': lambda p: bandv(p) * min(1.0, p['cost'] / 0.35)}),
             ('(c) band x min(1, price / 0.35); depth', {'stake_fn': lambda p: bandv(p) * min(1.0, p['cost'] / 0.35), 'depth': True}),
             ("(d) paper's own sizes x8", {'stake_fn': lambda p: ownv(p) * 8}),
             ("(d) paper's own sizes x8; depth", {'stake_fn': lambda p: ownv(p) * 8, 'depth': True})]
    for lab, kw in rows:
        r = pacer_run(pathsB, baseG, SL, **kw)
        if r is None: print('    (no costed position)'); break
        print(f"    {lab:66s} {r['real']:+10.2f}  {r['real'] / max(r['span_h'], 1e-9):+6.2f}  {r['entries']:7d}  {r['snipe']:6d}  {r['held']:4d}  {r['cap_peak']:14.2f}  {r['thin_usd']:7.2f}")
    print('  G3. how far paper\'s own sizes scale: own stakes x1-x4, with and without the top-of-book depth charge')
    print('    sizing variant                                                    realized $     $/h  entries  snipes  held  peak $ at work  depth $')
    for m in (1, 2, 3, 4):
        for dep in (False, True):
            r = pacer_run(pathsB, baseG, SL, stake_fn=(lambda m: lambda p: ownv(p) * m)(m), depth=dep)
            if r is None: break
            lab = f"own sizes x{m}" + ('; depth' if dep else '')
            print(f"    {lab:66s} {r['real']:+10.2f}  {r['real'] / max(r['span_h'], 1e-9):+6.2f}  {r['entries']:7d}  {r['snipe']:6d}  {r['held']:4d}  {r['cap_peak']:14.2f}  {r['thin_usd']:7.2f}")
    # G4 (sizing thread, Oct 31): paper's training (1-contract 'train (paper)') and exploration ('explore (p=...)') trades are
    # off in today's bot and the real band never sized them; the band applies to each ORDER's stake (a partial fill keeps its share).
    org = collections.Counter(p['origin'] for p in pathsB if p.get('costF') is not None)
    print(f"  G4. positions by origin of their first entry: {dict(org)}; training and exploration trades are off in today's bot.")
    if own is not None and band is not None:
        for g in ('train', 'explore', 'normal'):
            ks = [k for k, p in enumerate(pathsB) if p.get('costF') is not None and p['origin'] == g]
            print(f"    {g:8s} {len(ks):5d} positions: own staked {sum(own['stk'].get(k, 0) for k in ks):9.2f} realized {sum(own['per'].get(k, 0) for k in ks):+9.2f}; position-clamp band staked {sum(band['stk'].get(k, 0) for k in ks):9.2f} realized {sum(band['per'].get(k, 0) for k in ks):+9.2f}")
    normal = lambda p: p if p['origin'] == 'normal' else None
    bando = lambda p: dict(p, n=p['n_band'], costF=p['costF_band']) if p['origin'] == 'normal' and p.get('costF_band') else None
    own_n = pacer_run(pathsB, baseG, SL, remap=normal)
    band_n = pacer_run(pathsB, baseG, SL, remap=bando)
    print('    normal entries only (the band per order):')
    print('    price paid    positions   won%   own: staked   realized    band: staked   realized')
    if own_n is not None and band_n is not None:
        for lo, hi, nm in cuts:
            ks = [k for k, p in enumerate(pathsB) if p.get('costF') is not None and p['origin'] == 'normal' and lo <= p['cost'] < hi]
            won = sum(1 for k in ks if pathsB[k]['payout'] > 0.5)
            print(f"    {nm:12s} {len(ks):10d}  {100 * won / len(ks) if ks else 0:5.0f}  {sum(own_n['stk'].get(k, 0) for k in ks):12.2f}  {sum(own_n['per'].get(k, 0) for k in ks):+9.2f}  {sum(band_n['stk'].get(k, 0) for k in ks):14.2f}  {sum(band_n['per'].get(k, 0) for k in ks):+9.2f}")
    print('    sizing (normal entries only)                                      realized $     $/h  entries  snipes  held  peak $ at work  depth $')
    rows4 = [('own sizes', {'remap': normal}), ('own sizes; depth', {'remap': normal, 'depth': True}),
             ('$10-$20 band per order', {'remap': bando}), ('$10-$20 band per order; depth', {'remap': bando, 'depth': True}),
             ('own sizes; no pacer', {'remap': normal, 'pacer': None}), ('$10-$20 band per order; no pacer', {'remap': bando, 'pacer': None})]
    for m in (2, 3, 4):
        rows4 += [(f'own sizes x{m}', {'remap': normal, 'stake_fn': (lambda m: lambda p: ownv(p) * m)(m)}),
                  (f'own sizes x{m}; depth', {'remap': normal, 'stake_fn': (lambda m: lambda p: ownv(p) * m)(m), 'depth': True})]
    for lab, kw in rows4:
        kw = dict(kw); pc = kw.pop('pacer', SL)
        r = pacer_run(pathsB, baseG, pc, **kw)
        if r is None: print('    (no costed position)'); break
        print(f"    {lab:66s} {r['real']:+10.2f}  {r['real'] / max(r['span_h'], 1e-9):+6.2f}  {r['entries']:7d}  {r['snipe']:6d}  {r['held']:4d}  {r['cap_peak']:14.2f}  {r['thin_usd']:7.2f}")
    sn = sorted(ownv(p) for p in pathsB if p.get('costF') is not None and p['origin'] == 'normal')
    if sn: print(f"    (normal entries' own stakes: median ${sn[len(sn) // 2]:.2f}, p10 ${sn[len(sn) // 10]:.2f}, p90 ${sn[9 * len(sn) // 10]:.2f})")
    # G5: Steven's asks (Oct 30) again on normal entries only with the band per order (G counted training trades, clamped)
    band5 = lambda p: dict(p, n=5 * p['n_band'], costF=p['costF_band']) if p['origin'] == 'normal' and p.get('costF_band') else None
    ANY5 = ({'remap': bando, 'reenter': 'any'}, {'remap': band5, 'reenter': 'any'}, {'remap': band5, 'reenter': 'any', 'depth': True})
    for gen in range(3 if more_books else 0):
        sig_miss.clear()
        for kw in ANY5: pacer_run(pathsB, baseG, SL, **kw)
        new = sig_miss - tried
        if not new: break
        tried |= new
        more_books(new)
        for j in [j for j in sig_cache if entry_sigs[j][1] in new]: del sig_cache[j]
    print('  G5. Steven\'s asks on normal entries only (no training or exploration trades), the $10-$20 band per order, x5 = $50-$100')
    print('    stake; pacer; re-entry; depth                                     realized $     $/h  entries  re-entries  re-entry $  snipes  held  peak $ at work  depth $')
    rows5 = [('$10-$20; slices [BASELINE]', {'remap': bando}), ('$10-$20; slices; depth', {'remap': bando, 'depth': True}),
             ('$10-$20; no pacer', {'remap': bando, 'pacer': None}), ('$10-$20; no pacer; depth', {'remap': bando, 'pacer': None, 'depth': True}),
             ('$50-$100; slices', {'remap': band5}), ('$50-$100; slices; depth', {'remap': band5, 'depth': True}),
             ('$50-$100; no pacer', {'remap': band5, 'pacer': None}), ('$50-$100; no pacer; depth', {'remap': band5, 'pacer': None, 'depth': True}),
             ('$10-$20; slices; next signal any market', {'remap': bando, 'reenter': 'any'}),
             ('$10-$20; slices; next signal; depth', {'remap': bando, 'reenter': 'any', 'depth': True}),
             ('$50-$100; slices; next signal any market', {'remap': band5, 'reenter': 'any'}),
             ('$50-$100; slices; next signal; depth', {'remap': band5, 'reenter': 'any', 'depth': True})]
    for lab, kw in rows5:
        kw = dict(kw); pc = kw.pop('pacer', SL)
        r = pacer_run(pathsB, baseG, pc, **kw)
        if r is None: print('    (no costed position)'); break
        print(f"    {lab:66s} {r['real']:+10.2f}  {r['real'] / max(r['span_h'], 1e-9):+6.2f}  {r['entries']:7d}  {r['re']:10d}  {r['re_real']:+10.2f}  {r['snipe']:6d}  {r['held']:4d}  {r['cap_peak']:14.2f}  {r['thin_usd']:7.2f}")
    stakes = sorted(ownv(p) for p in pathsB if p.get('costF') is not None)
    if stakes: print(f"    (paper's own stakes: median ${stakes[len(stakes) // 2]:.2f}, p10 ${stakes[len(stakes) // 10]:.2f}, p90 ${stakes[9 * len(stakes) // 10]:.2f})")
    # ---- L. Steven, Oct 31: no holding to settlement unless in the last 10% and in profit; exits for losers, iterated ------
    print('  L. loser exits on normal entries, the $10-$20 band per order, slices pacer: every position not in profit is sold at the bid')
    print('     by the rule shown, and always inside the last 10% (or final minute) unless in profit. held W/L = settled winners/losers.')
    print('     cut$ = what the cuts realized; cutW = cuts on positions that would have settled as winners.')
    print('    loser rule                                                        realized $     $/h  snipes  heldW  heldW $  heldL  heldL $   cuts    cut $  cutW  nobid  depth $')
    gate = lambda m: (lambda p: (lambda q: None if q is None or (q.get('q0') is not None and q['q0'] < q['costF'] - m) else q)(bando(p)))
    S3 = {'fvbid': 0.03, 'split': True}
    rowsL = [('none (today)', None, bando), ('window only', {}, bando),
             ('fv < bid - fee - 3c, top size (round 2 best)', S3, bando),
             ('fv < bid - fee - 2c, top size', {'fvbid': 0.02, 'split': True}, bando), ('fv < bid - fee - 4c, top size', {'fvbid': 0.04, 'split': True}, bando),
             ('entry gate fv >= cost; window only', {}, gate(0.0)), ('entry gate fv >= cost; 3c top size', S3, gate(0.0)),
             ('entry gate fv >= cost - 3c; 3c top size', S3, gate(0.03)), ('entry gate fv >= cost - 6c; 3c top size', S3, gate(0.06)),
             ('entry gate fv >= cost + 3c; 3c top size', S3, gate(-0.03)), ('entry gate fv >= cost + 6c; 3c top size', S3, gate(-0.06)),
             ('entry gate fv >= cost + 6c; window only', {}, gate(-0.06)), ('entry gate fv >= cost + 9c; 3c top size', S3, gate(-0.09)),
             ('entry gate fv >= cost + 12c; 3c top size', S3, gate(-0.12))]
    gx = lambda m, k: (lambda p: (lambda q: None if q is None else dict(q, n=k * q['n']))(gate(m)(p)))
    for m, nm in ((-0.06, '6c'), (-0.03, '3c'), (0.0, '0c')):
        for k in (2, 3, 5):  # the gated entries carry their edge: a bigger stake on them ($20-$40 .. $50-$100)
            rowsL.append((f'entry gate fv >= cost + {nm}; 3c top size; stake x{k}', S3, gx(m, k)))
    # the gate scaled by how far fair value clears the cost: x1 at the margin, up to x5 at +20c
    gs = lambda p: (lambda q: None if q is None else dict(q, n=q['n'] * min(5.0, 1 + max(0.0, (q['q0'] or 0) - q['costF'] - 0.06) * 20)))(gate(-0.06)(p))
    rowsL.append(('entry gate fv >= cost + 6c; 3c top size; stake x1-x5 by edge', S3, gs))
    # round 6: more gated trades. Training and exploration entries (off in today's bot) as candidates too, each at the band
    def band_all(p):
        if p['origin'] == 'normal': return bando(p)
        st_ = min(max(p['n'] * p['costF'], 10.0), 20.0)
        return dict(p, n=st_ / p['costF'])
    gall = lambda m, k=1: (lambda p: (lambda q: None if q is None or q.get('q0') is None or q['q0'] < q['costF'] - m else dict(q, n=k * q['n']))(band_all(p)))
    for m, nm in ((-0.06, '6c'), (-0.09, '9c'), (-0.03, '3c')):
        for k in (1, 2):
            rowsL.append((f'ALL origins, gate fv >= cost + {nm}; 3c top size' + (f'; stake x{k}' if k > 1 else ''), S3, gall(m, k)))
    # round 7: where the window cut starts (PR #230's replay: the last 90 s have thin bids). Today's rules plus the window
    # cut alone, and the gate (every origin) + 3c cut, with the cut of anything not in profit starting at 10/20/30% left
    for wf in (0.10, 0.20, 0.30):
        rowsL.append((f'window cut from {int(wf * 100)}% left, top size', {'split': True, 'wfrac': wf}, bando))
        rowsL.append((f'ALL origins, gate 6c; 3c top size; window cut from {int(wf * 100)}% left', dict(S3, wfrac=wf), gall(-0.06)))
    # round 8 (Steven, Nov 1: turn what we get wrong into profit): the entries the gate rejects (fair value under cost) as the
    # OTHER side of the same market at the same second: buy it at 1 - our bid, its bids are 1 - our asks, it pays 1 - ours
    def flip_of(q, m):
        if q is None or q.get('q0') is None or q['q0'] >= q['costF'] - m: return None
        pa = q['path']; b0 = pa['bids'][0] if pa['bids'] else None
        if b0 is None or not (0.02 <= 1 - b0 <= 0.98): return None
        inv = lambda xs: [None if x is None else round(1 - x, 4) for x in xs]
        sub = dict(pa, bids=inv(pa['asks']), bsz=pa['asz'], asks=inv(pa['bids']), asz=pa['bsz'], fv=inv(pa['fv']))
        a = 1 - b0; stake = q['n'] * q['costF']; n = stake / (a + fee1(a, stake / a)); cF = a + fee1(a, n)
        return dict(q, n=n, cost=a, costF=cF, b0=a, path=sub, bids=sub['bids'], fv=sub['fv'], payout=1 - q['payout'],
                    q0=next((x for x in sub['fv'] if x is not None), None), floor=None, actual=None)
    flip = lambda m, alsokeep=None: (lambda p: (lambda q: flip_of(q, m) or (alsokeep(p) if alsokeep else None))(band_all(p)))
    rowsL += [('FLIP: only the rejected entries, other side (fv < cost)', S3, flip(0.0)),
              ('FLIP: rejected entries other side (fv < cost - 6c)', S3, flip(0.06)),
              ('FLIP + gate 6c: gated entries kept, rejected ones flipped', S3, flip(0.0, gall(-0.06))),
              ('FLIP + gate 6c, flips only where fv < cost - 6c', S3, flip(0.06, gall(-0.06)))]
    # ---- adversary (Steven, Nov 1: try to break whatever makes the gains) on the best rule: gate 6c over every origin + 3c cut
    # strict: the gate reads fair value at the entry second only (q0 was the first fair value at or after it: look-ahead)
    def gstrict(m, slip=0.0):
        def f(p):
            q = band_all(p)
            if q is None: return None
            v = q['fv'][0] if q['fv'] else None
            if v is None or v < q['costF'] - m: return None
            return dict(q, costF=q['costF'] + slip) if slip else q
        return f
    # placebo: skip the same share of entries at random (seeded), not by fair value
    import random as _rnd
    cand = [p for p in pathsB if p.get('costF') is not None and band_all(p) is not None and band_all(p).get('q0') is not None]
    kept = sum(1 for p in cand if gall(-0.06)(p) is not None)
    share = kept / len(cand) if cand else 0.0
    def placebo(seed):
        r = _rnd.Random(seed)
        keep = {id(p): r.random() < share for p in pathsB}
        return lambda p: (lambda q: q if q is not None and keep.get(id(p)) else None)(band_all(p))
    print(f'     adversary: the gate keeps {kept} of {len(cand)} entries with a fair value ({100 * share:.0f}%); the placebo keeps the same share at random')
    rowsL += [('ADV strict: gate on the entry second\'s fair value only', S3, gstrict(-0.06)),
              ('ADV strict + 1c worse entry fill', S3, gstrict(-0.06, 0.01)),
              ('ADV strict + cut sold 1c under the bid', dict(S3, slip=0.01), gstrict(-0.06)),
              ('ADV strict + cut decided 2 s late', dict(S3, delay=2), gstrict(-0.06)),
              ('ADV strict + cut decided 5 s late', dict(S3, delay=5), gstrict(-0.06)),
              ('ADV strict + all of: 1c entry, 1c sale, 2 s late', dict(S3, slip=0.01, delay=2), gstrict(-0.06, 0.01))]
    rowsL += [(f'ADV placebo: random skip, same share (seed {s})', S3, placebo(s)) for s in (1, 2, 3)]
    print('     entry gate: the position is skipped when the spot fair value at its entry is under its cost (fee in) less the margin shown.')
    for lab, lz, rm in rowsL:
        for dp in (False, True):
            r = pacer_run(pathsB, baseG, SL, remap=rm, loser=lz, depth=dp, depth_px=0.04 if (dp and lab.startswith('ADV')) else 0.02)
            if r is None: print('    (no costed position)'); break
            lb = lab + ('; depth' if dp else '')
            print(f"    {lb:66s} {r['real']:+10.2f}  {r['real'] / max(r['span_h'], 1e-9):+6.2f}  {r['snipe']:6d}  {r['held_w']:5d}  {r['held_w_usd']:+8.2f}  {r['held_l']:5d}  {r['held_l_usd']:+8.2f}  {r['cut']:5d}  {r['cut_usd']:+8.2f}  {r['cut_win']:4d}  {r['nobid']:5d}  {r['thin_usd']:7.2f}")

    # ---- R. regime-conditional stakes (Steven, Nov 1 dynamics rule: x2-x5 on gated entries paid on Oct 24-25 only, so build the
    # condition in rather than scale everywhere or nowhere; tested under the conditions it targets before it goes into the bot).
    # Regime at each entry from what the bot could see then: trend z = 1 h log move of the index / (15-min sigma x sqrt(3600));
    # |z| >= 1 is a trend, signed with or against the held side (range brackets have no side); vol ratio = 15-min sigma / mean of
    # the hourly 15-min sigmas over the 6 h before (>= 1.25 rising, <= 0.8 falling). Base rule: every origin, gate 6c, 3c cut.
    def regime_of(p):
        a = p['ep'].get('asset'); s = p['s0']
        if not a: return None
        sg = sigma_cached(a, s); S1 = index_at(a, s); S0 = index_at(a, s - 3600)
        if not sg or not S1 or not S0 or S0 <= 0: return None
        z = math.log(S1 / S0) / (sg * math.sqrt(3600))
        longs = [x for x in (sigma_cached(a, s - h * 3600) for h in range(1, 7)) if x]
        vr = sg / mean(longs) if len(longs) >= 3 else None
        K, cap, kind = strike_of(p['ep'])
        if abs(z) < 1.0: tr = 'ranging'
        elif cap and kind != 'less': tr = 'trend, bracket'
        else:
            d = -1 if kind == 'less' else 1
            tr = 'trend with us' if (1 if z > 0 else -1) * d * p['ep']['sign'] > 0 else 'trend against us'
        vb = 'vol n/a' if vr is None else ('vol rising' if vr >= 1.25 else 'vol falling' if vr <= 0.8 else 'vol steady')
        return tr, vb, z, vr
    baseR = gall(-0.06)
    r1 = pacer_run(pathsB, baseG, SL, remap=baseR, loser=S3)
    print('  R. regime-conditional stakes on the gated entries (every origin, gate fv >= cost + 6c, 3c cut, slices pacer)')
    if r1 is None:
        print('    (no costed position)')
    else:
        per, stk = r1['per'], r1['stk']
        reg = {s: regime_of(pathsB[s]) for s in per}
        cnt = collections.Counter(p['ep'].get('asset') for p in pathsB if p.get('costF') is not None)
        if cnt:
            a0 = cnt.most_common(1)[0][0]
            T0 = min(pathsB[s]['s0'] for s in per); T1 = max(pathsB[s]['c_sec'] for s in per)
            I0, I1 = index_at(a0, T0), index_at(a0, T1)
            sgs = [x for x in (sigma_cached(a0, t) for t in range(T0, T1, 900)) if x]
            zs = [abs(v[2]) for v in reg.values() if v]
            if I0 and I1 and sgs:
                print(f"     window regime ({a0}): index {I0:,.0f} -> {I1:,.0f} ({100 * math.log(I1 / I0):+.2f}%), mean 15-min sigma {1e4 * mean(sgs):.2f} bp/s^0.5,"
                      f" entries trending (|z| >= 1) {100 * sum(1 for x in zs if x >= 1) / max(1, len(zs)):.0f}%")
        print('     bucket                                   trades  won %  realized x1 $  $ per trade  return per $')
        def show(name, keyf):
            agg = collections.defaultdict(lambda: [0, 0, 0.0, 0.0])
            for s, x in per.items():
                b = keyf(s)
                if b is None: b = 'no regime'
                g = agg[b]; g[0] += 1; g[1] += x > 0; g[2] += x; g[3] += stk.get(s, 0.0)
            for b, g in sorted(agg.items()):
                print(f"     {name + ': ' + b:40s} {g[0]:6d}  {100 * g[1] / g[0]:5.0f}  {g[2]:+13.2f}  {g[2] / g[0]:+11.3f}  {g[2] / g[3] if g[3] else 0:+12.4f}")
            return agg
        kT = lambda s: reg[s][0] if reg.get(s) else None
        kV = lambda s: reg[s][1] if reg.get(s) else None
        kTV = lambda s: f'{reg[s][0]}, {reg[s][1]}' if reg.get(s) else None
        aT = show('trend', kT); aV = show('vol', kV); aTV = show('both', kTV)
        def online(keyf, nmin=8):
            """Causal: scale an entry when its bucket's earlier gated trades (closed before it opens, x1 return per $) are net positive."""
            memo = {}
            def pick(s):
                if s in memo: return memo[s]
                b = keyf(s); ok = False
                if b is not None:
                    s0 = pathsB[s]['s0']
                    xs = [per[j] / stk[j] for j in per if j != s and stk.get(j) and pathsB[j]['c_sec'] <= s0 and keyf(j) == b]
                    ok = len(xs) >= nmin and mean(xs) > 0
                memo[s] = ok
                return ok
            return pick
        def oracle(keyf, agg):  # look-ahead ceiling: the buckets that ended net positive in this very window
            return lambda s: keyf(s) is not None and agg[keyf(s)][2] > 0
        def scaled(k, pick, slip=0.0):
            def f(p):
                q = baseR(p)
                if q is None: return None
                if slip: q = dict(q, costF=q['costF'] + slip)
                return dict(q, n=k * q['n']) if pick(p['src']) else q
            return f
        rowsR = [('gated x1 (reference)', baseR, None)]
        rowsR += [(f'gated x{k} everywhere (reference)', scaled(k, lambda s: True), None) for k in (2, 3, 5)]
        picks = {}
        for nm, kf, ag in (('trend', kT, aT), ('vol', kV, aV), ('trend+vol', kTV, aTV)):
            on = online(kf); picks[nm] = on
            for k in (2, 3, 5):
                rowsR.append((f'ONLINE {nm}: x{k} where the bucket has paid so far', scaled(k, on), on))
            rowsR.append((f'ORACLE {nm}: x3 where the bucket paid this window (look-ahead)', scaled(3, oracle(kf, ag)), oracle(kf, ag)))
        rowsR.append(('ONLINE trend, nmin 20: x3', scaled(3, online(kT, 20)), online(kT, 20)))
        # adversary: the same number of scaled entries chosen at random; 1c worse entry fills; 4c depth
        n_on = sum(1 for s in per if picks['trend'](s))
        share = n_on / max(1, len(per))
        import random as _rr
        for sd in (1, 2, 3):
            rr = _rr.Random(sd); keep = {s: rr.random() < share for s in per}
            rowsR.append((f'ADV placebo: x3 on a random {100 * share:.0f}% (seed {sd})', scaled(3, lambda s, kp=keep: kp.get(s, False)), None))
        rowsR.append(('ADV ONLINE trend x3 + 1c worse entry fill', scaled(3, picks['trend'], 0.01), picks['trend']))
        print('     stake rule                                                         realized $     $/h  scaled  snipes   cuts  peak $ at work  depth $')
        for lab, rm, pk in rowsR:
            nsc = sum(1 for s in per if pk(s)) if pk else (len(per) if 'everywhere' in lab else 0)
            for dp in (False, True):
                r = pacer_run(pathsB, baseG, SL, remap=rm, loser=S3, depth=dp, depth_px=0.04 if (dp and lab.startswith('ADV')) else 0.02)
                if r is None: continue
                lb = lab + ('; depth' if dp else '')
                print(f"    {lb:68s} {r['real']:+10.2f}  {r['real'] / max(r['span_h'], 1e-9):+6.2f}  {nsc:6d}  {r['snipe']:6d}  {r['cut']:5d}  {r['cap_peak']:14.2f}  {r['thin_usd']:7.2f}")

    # ---- C. what separates the right stop sales from the wrong ones (at the 1-tick trail's trigger, from the locks) --
    print('  C. at the 1-tick trail\'s trigger (from the actual locks): the sale against settlement by what the rule could see')
    buckets = collections.defaultdict(lambda: [0, 0.0, 0.0, 0.0, 0.0])  # hunts, contracts, won, px, sell-vs-hold $
    for p in pathsA:
        v, sn, px, sec, armed = sim(p, A, ('bid', 1), ('taker',), None, 0, None)
        if v is None: continue
        i = sec - p['s0']; q = p['fv'][i]
        tau = p['c_sec'] - sec
        keys = []
        keys.append(('fair value vs bid', 'no fv' if q is None else ('bid < fv - 5c' if px < q - 0.05 else 'bid < fv - 2c' if px < q - 0.02 else 'bid >= fv + 2c' if px >= q + 0.02 else 'within 2c')))
        w = spot_with(p['path'], i, p['ep'], p['sig'])
        keys.append(('spot last 60 s', 'n/a' if w is None else ('with us' if w else 'flat or against')))
        keys.append(('time to close', '< 120 s' if tau < 120 else '120-300 s' if tau < 300 else '300-600 s' if tau < 600 else '> 600 s'))
        bs, as_ = p['path']['bsz'][i], p['path']['asz'][i]
        keys.append(('top of book', 'n/a' if not bs or not as_ else ('bid 3x ask' if bs >= 3 * as_ else 'ask 3x bid' if as_ >= 3 * bs else 'balanced')))
        keys.append(('sale price', '< 0.30' if px < 0.3 else '0.30-0.50' if px < 0.5 else '0.50-0.70' if px < 0.7 else '>= 0.70'))
        for k in keys:
            r = buckets[k]; r[0] += 1; r[1] += sn; r[2] += p['payout'] * sn; r[3] += px * sn; r[4] += (v - p['payout']) * sn
    for (feat, val), r in sorted(buckets.items()):
        print(f"    {feat:18s} {val:18s} hunts {r[0]:4d}  contracts {r[1]:8.1f}  won {100 * r[2] / r[1] if r[1] else 0:4.0f}%  sale {r[3] / r[1] if r[1] else 0:.3f}  selling vs holding ${r[4]:+8.2f}")
    print("  (a bucket whose won% sits well under its sale price is where the stop sale was right; the fair value is the spot-implied one, the bot's math price)")
    print('  D. at the lock itself (the actual locks): selling right there against settlement, by what the rule could see')
    dk = collections.defaultdict(lambda: [0, 0.0, 0.0, 0.0, 0.0])
    tape = 0
    for p in pathsA:
        i = next((j for j, b in enumerate(p['bids']) if b is not None), None)
        if i is None: continue
        b = p['bids'][i]; q = p['fv'][i]; sec = p['s0'] + i; tau = p['c_sec'] - sec; n = p['n']
        v = b - fee1(b, n)
        keys = [('fv vs bid at lock', 'no fv' if q is None else ('bid < fv - 2c' if b < q - 0.02 else 'bid >= fv + 4c' if b >= q + 0.04 else 'bid >= fv + 2c' if b >= q + 0.02 else 'within 2c')),
                ('time to close', '< 120 s' if tau < 120 else '120-300 s' if tau < 300 else '300-600 s' if tau < 600 else '> 600 s'),
                ('lock price', '< 0.30' if b < 0.3 else '0.30-0.50' if b < 0.5 else '0.50-0.70' if b < 0.7 else '>= 0.70')]
        w = spot_with(p['path'], i, p['ep'], p['sig'])
        keys.append(('spot last 60 s', 'n/a' if w is None else ('with us' if w else 'flat or against')))
        f = flow(p['ep'], sec)
        if f is not None: tape += 1
        keys.append(('taker flow 60 s', 'no tape' if f is None else ('with us' if f > 0 else 'against us' if f < 0 else 'none')))
        sd = bid_std(p['path'], i)
        keys.append(('bid noise (sd/s)', 'n/a' if sd is None else ('< 0.5c' if sd < 0.005 else '0.5-1c' if sd < 0.01 else '1-2c' if sd < 0.02 else '>= 2c')))
        for k in keys:
            r = dk[k]; r[0] += 1; r[1] += n; r[2] += p['payout'] * n; r[3] += b * n; r[4] += (v - p['payout']) * n
    for (feat, val), r in sorted(dk.items()):
        print(f"    {feat:18s} {val:18s} hunts {r[0]:4d}  contracts {r[1]:8.1f}  won {100 * r[2] / r[1] if r[1] else 0:4.0f}%  lock bid {r[3] / r[1] if r[1] else 0:.3f}  selling at the lock vs holding ${r[4]:+8.2f}")
    print(f"  (tape seen on {tape} of {len(pathsA)} locks; a bucket whose won% sits under its lock bid is where selling at the lock beat holding)")
    # how the hunts the 1-tick trail never sold ended
    ends = collections.Counter(); endn = collections.defaultdict(float); endw = collections.defaultdict(float)
    for p in pathsA:
        v, sn, px, sec, armed = sim(p, A, ('bid', 1), ('taker',), None, 0, None)
        if v is not None: continue
        bs = [b for b in p['bids'] if b is not None]
        lastb = bs[-1] if bs else None
        k = 'no bid at all' if lastb is None else ('bid ended >= 0.90' if lastb >= 0.9 else 'bid ended <= 0.10' if lastb <= 0.1 else 'bid ended mid')
        ends[k] += 1; endn[k] += p['n']; endw[k] += p['payout'] * p['n']
    print('  E. the hunts the 1-tick trail never sold, by how their recorded bid ended: ' + '; '.join(f"{k}: {c} hunts, {endn[k]:.0f} ct, won {100 * endw[k] / endn[k] if endn[k] else 0:.0f}%" for k, c in ends.items()))
    # E2. why a hunt has no recorded side bid at all: the recorder's tops for its market around the lock
    why = collections.Counter(); shown = 0
    for p in pathsA:
        if any(b is not None for b in p['bids']): continue
        ep = p['ep']; t = ep['ticker']; v = tops.get(t) or []
        at0 = top_at(t, p['s0']); atc = top_at(t, p['c_sec'])
        if not v: r = 'no tops for the market'
        elif at0 is None: r = f"tops start after the lock (first key {v[0][0] - p['s0']:+d} s)"
        else:
            yb, ya = at0[1], at0[3]
            r = ('yes bid side empty at the lock' if ep['sign'] > 0 and yb is None else 'yes ask side empty at the lock' if ep['sign'] < 0 and ya is None else 'side bid present at the lock?!')
            if v[-1][0] < p['s0']: r += f"; last top {p['s0'] - v[-1][0]} s before the lock"
        why[(('YES' if ep['sign'] > 0 else 'NO'), r)] += 1
        if shown < 8:
            shown += 1
            print(f"    E2 example: {t} {'YES' if ep['sign'] > 0 else 'NO'} lock {p['s0']} close {p['c_sec']} tops {len(v)} first {v[0][0] - p['s0'] if v else 'n/a'} s last {v[-1][0] - p['s0'] if v else 'n/a'} s (rel. to the lock); at lock {None if at0 is None else at0[1:]}; at close {None if atc is None else atc[1:]}")
    for (side, r), c in why.most_common():
        print(f"    E2 {side:3s} {c:4d} hunts: {r}")
    sides = collections.Counter(('YES' if p['ep']['sign'] > 0 else 'NO', any(b is not None for b in p['bids'])) for p in pathsA)
    print('    E2 hunts by side and whether a side bid was recorded: ' + ', '.join(f"{s} {'with' if w else 'without'} path: {c}" for (s, w), c in sorted(sides.items())))


# ---- The study --------------------------------------------------------------------------------------------------------

STAND_DOWN_SEC = 120          # SINUOUS_REST_STAND_DOWN_SEC: no cross in the last two minutes
FAST_MOVE_SEC = 5             # STRATEGY_FAST_MOVE_WINDOW_SEC: the cross's spot test window
PROFIT_TARGET = 0.02          # PROFIT_TARGET_CENTS / 100
PROFIT_TARGET_PCT = 0.10      # PROFIT_TARGET_PCT
MARKOUTS = (10, 30, 60, 120)
BAND_MIN_SEC = 60             # LIVE_LINE_BAND_MIN_SEC: seconds of wiggles since the open before the band is used
LINE_CONFIRM_SEC = 2          # LIVE_LINE_CONFIRM_SEC
# Exits the bot no longer places (the resting sell went Oct 23, the book cross and the old profit target before it): a
# replayed rule that sells before one of them is also scored on the positions without them.
RETIRED_EXITS = {'exit curve (resting sell)', 'exit curve (cross)', 'profit target (old)'}

TP = re.compile(r'take-profit( NO)?: \+(-?[0-9.]+) a contract net of fees')
REST = re.compile(r'exit curve: rest( NO)? ')
CROSS = re.compile(r'exit curve: cross( NO)? ')


def exit_kind(why):
    if why.startswith('quota snipe'): return 'quota snipe (sold to pace)'
    if TP.match(why): return 'take-profit (trailing)'
    if why.startswith('profit target'): return 'profit target (old)'
    if REST.match(why): return 'exit curve (resting sell)'
    if CROSS.match(why): return 'exit curve (cross)'
    if '- fee > q' in why: return 'model exit (market pays more)'
    if why.startswith('confluence ratchet stop'): return 'ratchet stop'
    if why.startswith('tennis'): return 'tennis'
    return re.sub(r'[-+]?[0-9][0-9.]*', '#', why)[:40] or '?'


def pacer_audit(recs, startups, since_ms, until_ms):
    """Section 0: the hourly quota pacer as paper ran it, from its audit records (bot/engine.ts writes one per credit,
    settlement and snipe, each with the clock's status after it)."""
    recs = sorted(r for r in recs if since_ms <= r[0] <= until_ms)
    if not recs:
        print('== 0. the hourly quota pacer in paper: no audit pacer records in the window'); return
    try:
        from zoneinfo import ZoneInfo
        NY = ZoneInfo('America/New_York')
    except Exception:
        NY = None

    def when(ms):
        u = time.strftime('%m-%d %H:%M', time.gmtime(ms / 1000))
        if NY is None: return u + ' UTC'
        return u + ' UTC (' + datetime.datetime.fromtimestamp(ms / 1000, NY).strftime('%I:%M %p %Z').lstrip('0') + ')'

    print(f'== 0. the hourly quota pacer in paper (PACER): {len(recs)} audit pacer records, {when(recs[0][0])} to {when(recs[-1][0])}')
    st = [m for m in startups if since_ms - 7200_000 <= m <= until_ms]
    print('  bot starts: ' + (', '.join(when(m) for m in st) or 'none in the window'))
    # integrity: each credit's usd moves realized24hUsd by exactly that much within a cycle; a snipe moves nothing; a start
    # between two records must not lose the cycle's realized total (the state file)
    prev = None; bad = []; resumed = []
    for ms, d in recs:
        a, r, u, ev = d.get('anchorStart'), float(d.get('realized24hUsd') or 0), float(d.get('usd') or 0), d.get('event')
        if prev is not None:
            pms, pa, pr = prev
            restarted = any(pms < m <= ms for m in st)
            if a == pa:
                exp = pr + (u if ev in ('credit', 'settled') else 0.0)
                if abs(exp - r) > 0.011: bad.append((ms, ev, pr, u, r, restarted))
                elif restarted: resumed.append((ms, pr, r))
            elif restarted or a != pa:
                if a is not None and pa is not None and a < pa: bad.append((ms, 'cycle went back', pr, u, r, restarted))
        prev = (ms, a, r)
    print(f'  integrity: {len(recs) - len(bad)} of {len(recs)} records continue the running total' + (f'; restarts resumed with the total intact: {len(resumed)}' if resumed else ''))
    for ms, ev, pr, u, r, rs in bad[:12]:
        print(f'    MISMATCH {when(ms)} {ev}: before {pr:+.2f}, credit {u:+.2f}, after {r:+.2f}' + (' (a bot start in between: the state file did not carry the cycle)' if rs else ''))
    cr = [d for _, d in recs if d.get('event') == 'credit']; se = [d for _, d in recs if d.get('event') == 'settled']; sn = [(ms, d) for ms, d in recs if d.get('event') == 'snipe']
    f = lambda xs: sum(float(x.get('usd') or 0) for x in xs)
    pos = lambda xs: sum(max(0.0, float(x.get('usd') or 0)) for x in xs)
    print(f"  credits: {len(cr)} reducing fills {f(cr):+.2f} (gains {pos(cr):+.2f}, losses {f(cr) - pos(cr):+.2f}); {len(se)} settlements {f(se):+.2f} (gains {pos(se):+.2f}, losses {f(se) - pos(se):+.2f})")
    grp = [x for x in sn if '(group)' in str(x[1].get('why') or '')]
    print(f"  quota snipes: {len(sn)} ({len(grp)} by the group rule), {sum(float(d.get('count') or 0) for _, d in sn):.0f} contracts")
    print('    clock hour (cycle, hour #)          credits     fills $  settled $  snipes  realized in cycle  goal by hour end  needed  ahead  mode (slices: banked, req/h)')
    hours = collections.OrderedDict()
    for ms, d in recs:
        k = (d.get('anchorStart'), d.get('hourIndex'))
        h = hours.setdefault(k, {'n': 0, 'fill': 0.0, 'set': 0.0, 'snipe': 0, 'last': None, 'ms': ms})
        ev = d.get('event'); u = float(d.get('usd') or 0)
        if ev == 'credit': h['n'] += 1; h['fill'] += u
        elif ev == 'settled': h['n'] += 1; h['set'] += u
        elif ev == 'snipe': h['snipe'] += 1
        h['last'] = d
    for (a, hi), h in hours.items():
        d = h['last']
        lab = (datetime.datetime.fromtimestamp(a / 1000, NY).strftime('%m-%d %I %p') if (NY and a) else str(a)) + f', #{hi}'
        sl = f" {d.get('slicesThisHour')}, {float(d.get('requiredPerHourUsd') or 0):.2f}" if d.get('mode') == 'slices' else ''
        print(f"    {lab:34s} {h['n']:7d}  {h['fill']:+9.2f}  {h['set']:+9.2f}  {h['snipe']:6d}  {float(d.get('realized24hUsd') or 0):+17.2f}  {float(d.get('nextHourGoalUsd') or 0):16.2f}  {float(d.get('neededUsd') or 0):6.2f}  {'yes' if d.get('ahead') else 'no':5s}  {d.get('mode') or 'cumulative'}{sl}")
    for ms, d in sn[:30]:
        print(f"    snipe {when(ms)}: {str(d.get('why') or '')[:140]} | needed {float(d.get('neededUsd') or 0):.2f}")


def pool_audit(training, rejects, since_ms, until_ms, other=()):
    """Section 0c: the paper pool (the training supervisor's pool_raised / capital_exhaustion records) and why orders were
    refused (risk_reject reasons with the numbers stripped; the engine writes one per market, side and kind a minute)."""
    try:
        from zoneinfo import ZoneInfo
        NY = ZoneInfo('America/New_York')
    except Exception:
        NY = None

    def when(ms):
        u = time.strftime('%m-%d %H:%M', time.gmtime(ms / 1000))
        if NY is None: return u + ' UTC'
        return u + ' UTC (' + datetime.datetime.fromtimestamp(ms / 1000, NY).strftime('%I:%M %p %Z').lstrip('0') + ')'
    ev = sorted([(ms, 'training', d) for ms, d in training if since_ms <= ms <= until_ms] + [x for x in other if since_ms <= x[0] <= until_ms], key=lambda x: x[0])
    print(f'== 0c. the paper pool, the kill switch and its override: {len(ev)} events in the window' + ('' if ev else ' (no training, kill, override or paper rebase records)'))
    for ms, k, d in ev[-40:]:
        e = d.get('event')
        if e == 'pool_raised':
            print(f"   {when(ms)}  pool raised ${d.get('from')} -> ${d.get('to')}: bankroll ${d.get('bankroll')} equity ${d.get('equity')}, topped up ${d.get('topUp')} (epoch {d.get('epoch')})")
        elif e == 'capital_exhaustion':
            print(f"   {when(ms)}  capital exhaustion (epoch {d.get('epoch')}, {d.get('hours')} h): ${d.get('endEquity')} left, refilled ${d.get('refill')}")
        elif e == 'daily_limit_breach':
            print(f"   {when(ms)}  daily loss limit breached (override on, trading continues): P&L ${d.get('pnl')} limit ${d.get('limit')}")
        elif e == 'paper_rebase':
            print(f"   {when(ms)}  paper balance moved (paper exchange top-up or a fresh book): deposit {d.get('deposit')} withdrawal {d.get('withdrawal')} balance ${d.get('balance')}")
        elif k.startswith('kill'):
            st = d.get('previous') if k == 'kill_reset' else d
            st = st if isinstance(st, dict) else {}
            print(f"   {when(ms)}  {k}: {str(st.get('reason') or d.get('reason') or '')[:90]} (source {st.get('source') or d.get('source')}{', by ' + str(d.get('by')) if d.get('by') else ''})")
        else:
            print(f"   {when(ms)}  {k} {e}")
    c = collections.Counter(re.sub(r'[-\d.$%]+', '#', str((d.get('reasons') or ['?'])[0]))[:100] for ms, d in rejects if since_ms <= ms <= until_ms)
    print(f'   risk rejections: {sum(c.values())} records (one per market, side and kind a minute)')
    for why, n in c.most_common(8): print(f'     {n:5d}  {why}')


def size_audit(orders, fills, sizing, since_ms, until_ms):
    """Section 0b: what each entry stakes (order_new: contracts x price; taker entries and maker quotes that add) by clock hour,
    and the sizer's state from the module ledger's sizing rows (paper sizes like live since PR #183, Oct 28 22:19 UTC)."""
    try:
        from zoneinfo import ZoneInfo
        NY = ZoneInfo('America/New_York')
    except Exception:
        NY = None

    def when(ms):
        u = time.strftime('%m-%d %H:%M', time.gmtime(ms / 1000))
        return u + ' UTC' + ('' if NY is None else ' (' + datetime.datetime.fromtimestamp(ms / 1000, NY).strftime('%I:%M %p %Z').lstrip('0') + ')')

    adds = lambda o: o.get('purpose') == 'entry' or (o.get('purpose') == 'quote' and not o.get('ro'))
    ent = sorted((o for o in orders.values() if o.get('ms') is not None and since_ms <= o['ms'] <= until_ms and adds(o)), key=lambda o: o['ms'])
    ef = [fl for fl in fills if since_ms <= fl['ms'] <= until_ms and adds(orders.get(fl['coid']) or {})]
    usd = lambda o: float(o.get('count') or 0) * float(o.get('price') or 0)
    print(f'== 0b. position sizes: {len(ent)} entry orders (taker entries and maker quotes that add), {len(ef)} entry fills')
    if ent:
        c = [float(o.get('count') or 0) for o in ent]; u = [usd(o) for o in ent]
        print(f'  per order: contracts median {pct(c, .5):.2f} (p10 {pct(c, .1):.2f}, p90 {pct(c, .9):.2f}); stake median ${pct(u, .5):.2f} (p10 ${pct(u, .1):.2f}, p90 ${pct(u, .9):.2f})')
    if ef:
        print(f"  filled: {sum(x['count'] for x in ef):.1f} contracts, ${sum(x['count'] * x['price'] for x in ef):.2f} staked; per fill median {pct([x['count'] for x in ef], .5):.2f} contracts")
    by = collections.OrderedDict()
    for o in ent: by.setdefault(o['ms'] // 3600_000, []).append(o)
    if by: print('    clock hour                     orders  contracts (median)  stake $ (median)  stake $ (p90)')
    for hk, xs in list(by.items())[-36:]:
        print(f"    {when(hk * 3600_000):30s} {len(xs):6d}  {pct([float(o.get('count') or 0) for o in xs], .5):18.2f}  {pct([usd(o) for o in xs], .5):16.2f}  {pct([usd(o) for o in xs], .9):13.2f}")
    sz = [(ms, rows) for ms, rows in sizing if since_ms - 3600_000 <= ms <= until_ms and rows]
    for ms, rows in (sz[:1] + sz[-1:] if len(sz) > 1 else sz):
        parts = []
        for r in rows:
            sc = r.get('score') or {}
            parts.append(f"{r.get('module')}: {r.get('state')}" + (f" ({sc.get('label')} {sc.get('value')}, n {sc.get('n')})" if sc else '') + (f" [{r.get('note')}]" if r.get('note') else '') + (' {' + '; '.join(r.get('flags') or []) + '}' if r.get('flags') else ''))
        print(f'  sizer at {when(ms)}: ' + ' | '.join(parts))
    if not sz: print('  sizer: no module ledger record in the window')


def iso_ms(ts):
    return int(datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp() * 1000)


def opener(f):
    return gzip.open(f, 'rb') if f.endswith('.gz') else open(f, 'rb')


def lines_of(fh):
    """Lines of an open day file; today's gzipped file may end in a member still being written."""
    try:
        yield from fh
    except EOFError:
        return


def pct(xs, q):
    return sorted(xs)[min(len(xs) - 1, int(q * len(xs)))] if xs else float('nan')


def mean(xs):
    return sum(xs) / len(xs) if xs else float('nan')


def seek_time(fh, size, t_ms):
    """Byte offset of the first line written at or after t_ms in a plain recording (lines are in time order)."""
    lo, hi = 0, size
    while hi - lo > 1 << 16:
        mid = (lo + hi) // 2
        fh.seek(mid); fh.readline()
        line = fh.readline()
        m = re.match(rb'\{"t":(\d+)', line)
        if not m: hi = mid; continue
        if int(m.group(1)) < t_ms: lo = mid
        else: hi = mid
    fh.seek(lo)
    if lo: fh.readline()
    return fh.tell()


def main():
    sys.stdout.reconfigure(line_buffering=True)  # a run stopped by its time limit still shows what it printed
    data = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/bot/data')
    hours = float(sys.argv[2]) if len(sys.argv) > 2 else 8.0
    until = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] not in ('', 'now') else None
    now = datetime.datetime.strptime(until, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc).timestamp() if until else time.time()
    since_ms = int((now - hours * 3600) * 1000)
    # Fills from two hours earlier, so a position opened before the window and closed inside it is whole.
    from_iso = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(since_ms / 1000 - 7200)).encode()
    t0 = time.time()

    # -- The audit log.
    files = sorted(f for f in glob.glob(os.path.join(data, 'audit', 'audit-*.jsonl')) if os.path.basename(f)[6:16] >= from_iso[:10].decode())
    fills, orders, results, exit_why, curve_events = [], {}, {}, {}, []
    hunts = collections.defaultdict(list)  # ticker -> the hunt's decision records (activated / ratcheted / triggered / profit takes / deactivations)
    want = (b'"kind":"fill"', b'"kind":"settlement"', b'"kind":"order_new"', b'"kind":"curve_exit"', b'"kind":"pacer"', b'"kind":"startup"', b'"kind":"modules"', b'"kind":"training"', b'"kind":"risk_reject"', b'"kind":"kill_', b'"kind":"config"', b'"kind":"vault"')
    pacer_recs, startups = [], []  # the quota pacer's audit records (credit / settled / snipe, each with the clock) and bot starts
    sizing_recs = []  # the module ledger's sizing rows (audit 'modules': tier, loss-aware scale, optimal f cap, portfolio Kelly)
    training_recs, reject_recs = [], []  # the training supervisor's events (pool raised, exhaustion) and risk rejections
    entry_why = {}  # decisionId -> [(side, price, why)] of the non-exit orders it placed (training / exploration tags)
    entry_sigs = []  # the bot's own taker entry signals (decision records placing an 'entry'): (sec, ticker, sign, price, edge)
    control_recs = []  # kill switch trips and resets, the override's toggles (audit config), paper balance rebases (audit vault)
    for f in files:
        with open(f, 'rb') as fh:
            for line in fh:
                head = line[:160]
                i = head.find(b'"ts":"')
                if i >= 0 and head[i + 6:i + 25] < from_iso: continue
                if b'"kind":"decision"' in head:
                    if b'"huntEvent":"' in line:
                        try: r = json.loads(line)
                        except Exception: continue
                        d = r.get('data') or {}
                        hunts[d.get('ticker', '')].append({'ms': iso_ms(r.get('ts', '')), 'ev': d.get('huntEvent'), 'target': d.get('target'), 'stop': d.get('stop'), 'pYes': d.get('pYes'), 'pos': d.get('position')})
                        continue
                    if b'"purpose":"entry"' in line or b'explore (p=' in line:
                        try: r = json.loads(line)
                        except Exception: r = {}
                        d = r.get('data') or {}
                        ws = []
                        for p in d.get('place') or []:
                            if p.get('purpose') == 'exit': continue
                            w = str(p.get('why') or '')
                            ws.append((p.get('side'), p.get('price'), w))
                            # the bot's own entry signals (training and exploration trades are off in today's bot: left out)
                            if p.get('purpose') == 'entry' and p.get('side') in ('bid', 'ask') and not w.startswith(('train (paper)', 'explore (p=')):
                                entry_sigs.append((iso_ms(r.get('ts', '')) // 1000, d.get('ticker', ''), 1 if p['side'] == 'bid' else -1, p.get('price'), p.get('edge')))
                        if d.get('decisionId') and ws: entry_why[d['decisionId']] = ws
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
                    orders[d.get('clientOrderId')] = {'purpose': d.get('purpose'), 'price': d.get('price'), 'side': d.get('side'), 'decision': d.get('decisionId'), 'close': d.get('windowCloseTs'), 'asset': d.get('asset'), 'fv': d.get('fairValue'),
                                                      'count': d.get('count'), 'ro': bool(d.get('reduceOnly')), 'ms': iso_ms(ts)}
                elif k == 'settlement':
                    if d.get('result') in ('yes', 'no'): results[d.get('ticker', '')] = (d['result'], iso_ms(ts))
                elif k == 'curve_exit':
                    curve_events.append((ts, d))
                elif k == 'pacer':
                    pacer_recs.append((iso_ms(ts), d))
                elif k == 'startup':
                    startups.append(iso_ms(ts))
                elif k == 'modules':
                    sizing_recs.append((iso_ms(ts), [x for x in d.get('rows') or [] if x.get('area') == 'sizing']))
                elif k == 'training':
                    training_recs.append((iso_ms(ts), d))
                elif k == 'risk_reject':
                    reject_recs.append((iso_ms(ts), d))
                elif k in ('kill_engaged', 'kill_reset', 'kill_suppressed'):
                    control_recs.append((iso_ms(ts), k, d))
                elif k == 'config' and str(d.get('event') or '').startswith('kill_override'):
                    control_recs.append((iso_ms(ts), 'override', d))
                elif k == 'vault' and d.get('event') == 'paper_rebase':
                    control_recs.append((iso_ms(ts), 'vault', d))
    fills.sort(key=lambda x: x['ms'])
    print(f"audit files {[os.path.basename(f) for f in files]}: fills {len(fills)}  orders {len(orders)}  settled markets {len(results)}  ({time.time() - t0:.0f} s)")
    pacer_audit(pacer_recs, startups, since_ms, int(now * 1000))
    size_audit(orders, fills, sizing_recs, since_ms, int(now * 1000))
    pool_audit(training_recs, reject_recs, since_ms, int(now * 1000), control_recs)

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
            ep['exits'].append({'ms': fl['ms'], 'why': (why_of(fl) or '') if o.get('purpose') == 'exit' else '', 'fv': o.get('fv'), 'n': n, 'px': round(px, 4), 'fee': fl['fee'] * n / fl['count'], 'kind': exit_kind(why_of(fl) or '(entry order)') if o.get('purpose') == 'exit' else 'a quote that reduced it', 'why': why_of(fl) or ''})
            ep['held'] = held + (n if signed > 0 else -n)
            rest = signed - (n if signed > 0 else -n)
            if abs(ep['held']) < 1e-9:
                ep['flat_ms'] = fl['ms']; episodes.append(ep); del open_ep[t]; ep = None
        if abs(rest) > 1e-9:
            # An exit whose entry fell before the parsed range opens nothing.
            if ep is None and o.get('purpose') == 'exit': continue
            if ep is None:
                ep = {'ticker': t, 'sign': 1 if rest > 0 else -1, 'start_ms': fl['ms'], 'entries': [], 'exits': [], 'held': 0.0, 'close_ms': o.get('close'), 'asset': o.get('asset')}
                open_ep[t] = ep
            px = fl['price'] if ep['sign'] > 0 else 1 - fl['price']
            ep['entries'].append({'ms': fl['ms'], 'n': abs(rest), 'px': round(px, 4), 'fee': fl['fee'] * abs(rest) / fl['count'], 'coid': fl['coid']})
            if 'origin' not in ep:
                ws = entry_why.get(o.get('decision')) or []
                w = next((w for sd, pr, w in ws if sd == fl['side'] and pr == o.get('price')), ws[0][2] if ws else '')
                ep['origin'] = 'train' if w.startswith('train (paper)') else 'explore' if w.startswith('explore (p=') else 'normal'
            ep['held'] += rest
            if not ep.get('close_ms') and o.get('close'): ep['close_ms'] = o.get('close')
    episodes.extend(open_ep.values())
    # The positions closed (flat or settled) in the window.
    episodes = [ep for ep in episodes if ep['start_ms'] <= now * 1000 and max(ep.get('flat_ms') or 0, (results.get(ep['ticker']) or (None, 0))[1]) >= since_ms or (not ep.get('flat_ms') and ep['ticker'] not in results)]
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
    # The book is kept from the market's OPEN, not from two minutes before the first fill: the recorder's only full
    # snapshot usually comes with the subscription at the open, and deltas before a snapshot cannot be applied (the
    # old window dropped the snapshot for most hunted markets, leaving two thirds of the hunts without a path).
    close_of = {}
    for ep in episodes:
        if ep.get('close_ms'): close_of[ep['ticker']] = max(close_of.get(ep['ticker'], 0), ep['close_ms'])
    entry_sigs = sorted(x for x in entry_sigs if since_ms // 1000 <= x[0] <= now)
    bookwin = {t: ((min(a, close_of[t] - (900_000 if '15M-' in t else 3_600_000) - 300_000) if t in close_of else a), b) for t, (a, b) in win.items()}
    assets = {ep.get('asset') for ep in episodes if ep.get('asset')}
    rec_dir = os.path.join(data, 'recordings')
    # The line needs 15 minutes of index before its first point for its volatility, and starts 10 minutes before a
    # position or 5 before its contract's window opened (the wiggle band looks back to the open: at most the 15 or 60
    # minutes before the close).
    starts = [min(ep['start_ms'] - 600_000, ep['close_ms'] - (900_000 if '15M-' in ep['ticker'] else 3_600_000) - 300_000) for ep in episodes if ep.get('close_ms')]
    need_from = min([w[0] for w in win.values()] + starts, default=now * 1000) - 960_000
    need_to = max((w[1] for w in win.values()), default=now * 1000)
    first_day = time.strftime('%Y-%m-%d', time.gmtime(need_from / 1000))
    rec_files = sorted(f for f in glob.glob(os.path.join(rec_dir, 'md-*.jsonl*')) if os.path.basename(f)[3:13] >= first_day and not f.endswith('.tmp'))
    plain_days = {os.path.basename(f)[3:13] for f in rec_files if f.endswith('.jsonl')}
    rec_files = [f for f in rec_files if f.endswith('.jsonl') or os.path.basename(f)[3:13] not in plain_days]
    books = {}       # ticker -> (bids, asks) price -> size
    tops = collections.defaultdict(list)   # ticker -> [(sec, bid, bidSize, ask, askSize)] when the top changed
    cur_sec = {}
    index = collections.defaultdict(list)  # asset -> [(sec, value)]
    trades = collections.defaultdict(list)  # ticker -> [(sec, takerSide, count, price)]
    terms = {}
    rec_results = {}  # ticker -> 'yes' | 'no' (the recorder's settlement results)
    wanted_b = {t.encode() for t in wanted}
    assets_b = {a.encode() for a in assets}
    lines = 0

    def top_of(t):
        bids, asks = books[t]
        bb = max(bids) if bids else None
        ba = min(asks) if asks else None
        return (bb / 1e4 if bb is not None else None, bids[bb] if bb is not None else 0, ba / 1e4 if ba is not None else None, asks[ba] if ba is not None else 0)

    def load_recordings(wanted_b, assets_b, need_from, need_to, bookwin):
        """One pass over the recordings: books (tops), index, trades, market terms and results for the wanted tickers."""
        n = 0
        for f in rec_files:
            with opener(f) as fh:
                if not f.endswith('.gz'): seek_time(fh, os.path.getsize(f), need_from)
                for line in lines_of(fh):
                    n += 1
                    tm = line[5:18]
                    if tm.isdigit():
                        tv = int(tm)
                        if tv < need_from: continue
                        if tv > need_to: break
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
                        a, b = bookwin[t]
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
                    elif kind == b'trade':
                        ts_ = line.find(b'"ticker":"', ke)
                        if ts_ < 0: continue
                        te = line.find(b'"', ts_ + 10)
                        if line[ts_ + 10:te] not in wanted_b: continue
                        r = json.loads(line)
                        tsec = int((r.get('ts') or r.get('t') or 0) // 1000)
                        if tsec: trades[r['ticker']].append((tsec, r.get('takerSide'), float(r.get('count') or 0), r.get('price')))
                    elif kind == b'market':
                        ts_ = line.find(b'"ticker":"', ke)
                        if ts_ < 0: continue
                        te = line.find(b'"', ts_ + 10)
                        if line[ts_ + 10:te] not in wanted_b: continue
                        r = json.loads(line)
                        terms[r['ticker']] = r
                    elif kind == b'result':
                        ts_ = line.find(b'"ticker":"', ke)
                        if ts_ < 0: continue
                        te = line.find(b'"', ts_ + 10)
                        if line[ts_ + 10:te] not in wanted_b: continue
                        r = json.loads(line)
                        if r.get('result') in ('yes', 'no'): rec_results[r['ticker']] = r['result']
        for t in books:  # the last state
            top = top_of(t)
            if not tops[t] or tops[t][-1][1:] != top: tops[t].append((cur_sec.get(t, 0) + 1, *top))
        return n

    lines = load_recordings(wanted_b, assets_b, need_from, need_to, bookwin)
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
        # computed at the minute's start whichever second asks first: no later index point reaches an earlier second
        if k not in sig_cache: sig_cache[k] = sigma_at(asset, (sec // 60) * 60) if asset else None
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

    # -- 1b. Why the ratchet stop and the model exit lose: each sale against settlement, the side the market and the model
    #        gave the held side, and the price after the sale, by what the rule saw. Model exit: the claimed edge at the sale
    #        (side bid - the fee paid - side q, q from the order's fair value or the reason). Ratchet: the stop against the
    #        average entry (a profit lock or a loss stop). Both: the time to the close and the series.
    LONG_MK = (60, 300, 900)
    def bucket_rows():
        return collections.defaultdict(lambda: {'fills': 0, 'n': 0.0, 'fee': 0.0, 'vs': 0.0, 'vsn': 0.0, 'won': 0.0, 'px': 0.0, 'q': 0.0, 'qn': 0.0, 'mk': collections.defaultdict(lambda: [0.0, 0.0])})
    def add(rows, key, ep, x, side_q):
        r = rows[key]; r['fills'] += 1; r['n'] += x['n']; r['fee'] += x['fee']
        if ep['payout'] is not None:
            r['vs'] += (x['px'] - ep['payout']) * x['n'] - x['fee']; r['vsn'] += x['n']; r['won'] += ep['payout'] * x['n']; r['px'] += x['px'] * x['n']
            if side_q is not None: r['q'] += side_q * x['n']; r['qn'] += x['n']
        for h in LONG_MK:
            sec = x['ms'] // 1000 + h
            if ep.get('close_ms') and sec * 1000 > ep['close_ms']: continue
            b = side_bid_at(ep, sec)
            if b is None: continue
            m = r['mk'][h]; m[0] += (x['px'] - b) * x['n']; m[1] += x['n']
    def show(title, rows):
        print(f"  {title}")
        if not rows: print('    (no such sales in the window)')
        for k, r in sorted(rows.items(), key=lambda kv: -kv[1]['n']):
            mk = '  '.join(f"{h}s {r['mk'][h][0] / r['mk'][h][1]:+.3f}" if r['mk'][h][1] else f"{h}s  n/a " for h in LONG_MK)
            if r['vsn']:
                won = f"won {100 * r['won'] / r['vsn']:3.0f}%, sold at {r['px'] / r['vsn']:.3f}" + (f", model said {r['q'] / r['qn']:.3f}" if r['qn'] else '')
                print(f"    {k:34s} fills {r['fills']:4d}  contracts {r['n']:7.1f}  fee {r['fee'] / r['n']:.4f}/ct  vs holding ${r['vs']:+8.2f} ({r['vs'] / r['vsn']:+.3f}/ct)  {won}  markouts {mk}")
            else:
                print(f"    {k:34s} fills {r['fills']:4d}  contracts {r['n']:7.1f}  vs holding      n/a  markouts {mk}")
    edge_rows, stop_rows, tau_rows, series_rows = bucket_rows(), bucket_rows(), bucket_rows(), bucket_rows()
    for ep in episodes:
        en = sum(e['n'] for e in ep['entries']); avg = (sum(e['n'] * e['px'] for e in ep['entries']) / en) if en else None
        for x in ep['exits']:
            kind = x['kind']
            if kind not in ('ratchet stop', 'model exit (market pays more)'): continue
            short = 'ratchet' if kind == 'ratchet stop' else 'model exit'
            fv = x.get('fv')
            if fv is None:
                m = re.search(r'q ([0-9.]+)', x.get('why') or '')
                side_q = float(m.group(1)) if m and ep['sign'] > 0 else None
            else:
                side_q = float(fv) if ep['sign'] > 0 else 1 - float(fv)
            if short == 'model exit':
                if side_q is None: eb = 'claimed edge unknown'
                else:
                    e = x['px'] - x['fee'] / x['n'] - side_q
                    eb = 'claimed edge <1c' if e < 0.01 else 'claimed edge 1-2c' if e < 0.02 else 'claimed edge 2-4c' if e < 0.04 else 'claimed edge >=4c'
                add(edge_rows, f"{short}: {eb}", ep, x, side_q)
            else:
                m = re.search(r'stop ([0-9.]+)', x.get('why') or ''); stop = float(m.group(1)) if m else None
                if avg is None or stop is None: sb = 'stop vs entry unknown'
                else:
                    d = stop - avg
                    sb = 'stop below the entry (a loss)' if d < -0.005 else 'stop at the entry' if d <= 0.005 else 'stop above the entry (a profit)'
                add(stop_rows, f"{short}: {sb}", ep, x, side_q)
            tau = (ep['close_ms'] - x['ms']) / 60000 if ep.get('close_ms') else None
            tb = 'time to close n/a' if tau is None else '<2 min to the close' if tau < 2 else '2-5 min to the close' if tau < 5 else '5-10 min to the close' if tau < 10 else '>10 min to the close'
            add(tau_rows, f"{short}: {tb}", ep, x, side_q)
            add(series_rows, f"{short}: {ep['ticker'].split('-')[0]}", ep, x, side_q)
    print('\n== 1b. why the ratchet stop and the model exit lose: each sale against settlement (vs holding, after the fee), how often'
          '\n   the held side won and what it was sold at (the market\'s probability) against the model\'s q, and the held side\'s bid'
          '\n   60 / 300 / 900 s after the sale (+ = it fell, the sale was timed well; - = it came back), by what the rule saw')
    show("by the model's claimed edge at the sale (side bid - fee paid - side q)", edge_rows)
    show('by the ratchet stop against the average entry', stop_rows)
    show('by the time to the close', tau_rows)
    show('by series', series_rows)

    # -- 1c. The ratchet's anatomy: the hunt's decision records (activated / ratcheted / triggered / profit takes /
    #        deactivations) joined to the positions and the recorded top of book. Where the lock sits against the entry
    #        and the model, how far the stop walked up, what the bid did between the lock and the sale, and what the
    #        sold contracts then paid.
    def anatomy():
        print('\n== 1c. the ratchet\'s anatomy (hunt decision records joined to the positions and the top of book; side terms)')
        ev_count = collections.Counter(h['ev'] for hs in hunts.values() for h in hs if since_ms <= h['ms'] <= now * 1000)
        print('  hunt events in the window: ' + (', '.join(f"{k} {v}" for k, v in sorted(ev_count.items(), key=lambda kv: -kv[1])) if ev_count else 'none (no hunt decision records)'))

        def side_q_of(ep, p):
            return None if p is None else (float(p) if ep['sign'] > 0 else 1 - float(p))

        def peak_bid(ep, a_ms, b_ms):
            t = ep['ticker']; v = tops.get(t)
            if not v: return None
            i0 = max(0, bisect.bisect_right(top_secs[t], a_ms // 1000) - 1); i1 = bisect.bisect_right(top_secs[t], b_ms // 1000)
            vals = [e[1] if ep['sign'] > 0 else (None if e[3] is None else round(1 - e[3], 4)) for e in v[i0:i1]]
            vals = [x for x in vals if x is not None]
            return max(vals) if vals else None

        ENDS = ('triggered', 'profit_take_confluence', 'profit_take_session', 'profit_take_gap', 'deactivated_giveback', 'deactivated_session')
        acts, sale_rows = [], []
        for ep in episodes:
            end_ms = (ep.get('flat_ms') or ep.get('close_ms') or int(now * 1000)) + 1000
            hs = sorted((h for h in hunts.get(ep['ticker'], []) if ep['start_ms'] - 1000 <= h['ms'] <= end_ms), key=lambda h: h['ms'])
            if not hs: continue
            en = sum(e['n'] for e in ep['entries']); avg = (sum(e['n'] * e['px'] for e in ep['entries']) / en) if en else None
            cur = None
            for h in hs:
                if h['ev'] == 'activated':
                    cur = {'ep': ep, 'avg': avg, 'act_ms': h['ms'], 'floor': h['stop'] if h['stop'] is not None else h['target'], 'ratchets': 0, 'max_stop': h['stop'], 'end': None, 'sales': [], 'giveback': None}
                    acts.append(cur)
                elif cur is None: continue
                elif h['ev'] == 'ratcheted':
                    cur['ratchets'] += 1
                    if h['stop'] is not None and (cur['max_stop'] is None or h['stop'] > cur['max_stop']): cur['max_stop'] = h['stop']
                elif h['ev'] in ENDS and cur['end'] is None:
                    cur['end'] = h
                if h['ev'] == 'deactivated_giveback': cur['giveback'] = h
                if h['ev'] in ('deactivated_giveback', 'deactivated_session'): cur = None
            eacts = [a for a in acts if a['ep'] is ep]
            for x in ep['exits']:
                if x['kind'] != 'ratchet stop': continue
                a = next((a for a in reversed(eacts) if a['act_ms'] <= x['ms'] + 1000), None)
                if a is None: continue
                a['sales'].append(x)
                m = re.search(r'stop ([0-9.]+)', x.get('why') or ''); stop = float(m.group(1)) if m else a['max_stop']
                if stop is None or a['floor'] is None: continue
                pk = peak_bid(ep, a['act_ms'], x['ms'])
                trig = a['end'] if a['end'] and a['end']['ev'] == 'triggered' else None
                q = side_q_of(ep, trig['pYes']) if trig else None
                fee_per = taker_fee(x['n'], stop) / x['n'] if x['n'] else 0.0
                sale_rows.append({'n': x['n'], 'px': x['px'], 'fee': x['fee'], 'lock': (a['floor'] - a['avg']) if a['avg'] is not None else None, 'walk': stop - a['floor'],
                                  'peak': pk, 'give': (pk - x['px']) if pk is not None else None, 'slip': stop - x['px'], 'q': q, 'q_over': (q - stop) if q is not None else None,
                                  'hyb': (q >= stop + fee_per) if q is not None else None, 'held': (x['ms'] - a['act_ms']) / 1000,
                                  'tau': (ep['close_ms'] - x['ms']) / 60000 if ep.get('close_ms') else None, 'payout': ep['payout'], 'end': a['end']['ev'] if a['end'] else 'none'})

        def wmean(rows, k):
            s = [(r[k], r['n']) for r in rows if r.get(k) is not None]
            return (sum(v * n for v, n in s) / sum(n for _, n in s)) if s else None

        def wshare(rows, k):
            s = [(1.0 if r[k] else 0.0, r['n']) for r in rows if r.get(k) is not None]
            return (sum(v * n for v, n in s) / sum(n for _, n in s)) if s else None

        f3 = lambda v: 'n/a' if v is None else f"{v:+.3f}"
        pc = lambda v: 'n/a' if v is None else f"{100 * v:.0f}%"
        walked = sum(1 for a in acts if a['max_stop'] is not None and a['floor'] is not None and a['max_stop'] > a['floor'] + 1e-9)
        print(f"  hunts (activations) {len(acts)} on {len({id(a['ep']) for a in acts})} positions; the stop walked above the lock in {walked} of them"
              f" ({mean([a['ratchets'] for a in acts]) if acts else 0:.1f} ratchet steps a hunt)")
        how = collections.defaultdict(lambda: {'acts': 0, 'n': 0.0, 'lock': 0.0, 'lockn': 0.0, 'won': 0.0, 'wonn': 0.0})
        for a in acts:
            ep = a['ep']; e = a['end']
            kind = ('stopped out (ratchet sale)' if a['sales'] else ('profit take at the bid: ' + e['ev'][12:]) if e and e['ev'].startswith('profit_take')
                    else ('lock given back: ' + e['ev'][12:]) if e and e['ev'].startswith('deactivated') else 'stop hit, no sale recorded' if e else 'ran on (stop never hit)')
            r = how[kind]; r['acts'] += 1
            n_held = sum(x['n'] for x in ep['entries']); r['n'] += n_held
            if a['floor'] is not None and a['avg'] is not None: r['lock'] += (a['floor'] - a['avg']) * n_held; r['lockn'] += n_held
            if ep['payout'] is not None: r['won'] += ep['payout'] * n_held; r['wonn'] += n_held
        print("  how each hunt ended (contracts = the position's size; lock = the floor above the average entry; won = the held side at settlement):")
        for k, r in sorted(how.items(), key=lambda kv: -kv[1]['acts']):
            print(f"    {k:44s} hunts {r['acts']:4d}  contracts {r['n']:7.1f}  lock {f3(r['lock'] / r['lockn'] if r['lockn'] else None)}/ct  won {pc(r['won'] / r['wonn'] if r['wonn'] else None)}")
        if not sale_rows:
            print('  no ratchet sale in the window has a recorded hunt (older audit logs have no hunt decision records)')
            return acts
        settled = [r for r in sale_rows if r['payout'] is not None]
        vs = sum((r['px'] - r['payout']) * r['n'] - r['fee'] for r in settled); vsn = sum(r['n'] for r in settled)
        print(f"  ratchet sales with a recorded hunt: {len(sale_rows)} sales, {sum(r['n'] for r in sale_rows):.1f} contracts, vs holding ${vs:+.2f} on {vsn:.0f} settled contracts, won {pc(wmean(settled, 'payout'))}")
        up = wmean([{'n': r['n'], 'w': 1.0 if r['walk'] > 0.005 else 0.0} for r in sale_rows], 'w')
        print(f"    the lock (floor - average entry) {f3(wmean(sale_rows, 'lock'))}/ct; the stop at the sale {f3(wmean(sale_rows, 'walk'))}/ct above the lock, above it at all on {pc(up)} of the contracts")
        print(f"    the side bid's peak between the lock and the sale {f3(wmean(sale_rows, 'peak'))}; the sale gave back {f3(wmean(sale_rows, 'give'))}/ct of it and filled {f3(wmean(sale_rows, 'slip'))}/ct under the stop (the wall it leaned on was gone)")
        print(f"    the model's value at the trigger {f3(wmean(sale_rows, 'q'))}, {f3(wmean(sale_rows, 'q_over'))}/ct above the stop; the hybrid rule would have held {pc(wshare(sale_rows, 'hyb'))} of the contracts sold")
        print(f"    from the lock to the sale {wmean(sale_rows, 'held') or 0:.0f} s; {wmean(sale_rows, 'tau') or 0:.1f} min to the close at the sale")
        for lo, hi, lab in ((None, 0.005, 'stop at the lock'), (0.005, 0.03, 'stop 1-2c above the lock'), (0.03, None, 'stop 3c+ above the lock')):
            rs = [r for r in settled if (lo is None or r['walk'] >= lo) and (hi is None or r['walk'] < hi)]
            if not rs: continue
            print(f"    {lab:26s} contracts {sum(r['n'] for r in rs):7.1f}  vs holding ${sum((r['px'] - r['payout']) * r['n'] - r['fee'] for r in rs):+8.2f}  won {pc(wmean(rs, 'payout'))}  sold at {wmean(rs, 'px'):.3f}  peak {f3(wmean(rs, 'peak'))}  gave back {f3(wmean(rs, 'give'))}/ct")
        for lo, hi, lab in ((None, 2, 'sold <2 min to the close'), (2, 5, 'sold 2-5 min to the close'), (5, None, 'sold 5+ min to the close')):
            rs = [r for r in settled if r['tau'] is not None and (lo is None or r['tau'] >= lo) and (hi is None or r['tau'] < hi)]
            if not rs: continue
            print(f"    {lab:26s} contracts {sum(r['n'] for r in rs):7.1f}  vs holding ${sum((r['px'] - r['payout']) * r['n'] - r['fee'] for r in rs):+8.2f}  won {pc(wmean(rs, 'payout'))}  sold at {wmean(rs, 'px'):.3f}  peak {f3(wmean(rs, 'peak'))}  gave back {f3(wmean(rs, 'give'))}/ct")
        for ev in ('triggered', 'profit_take_gap', 'profit_take_confluence', 'profit_take_session', 'none'):
            rs = [r for r in settled if r['end'] == ev]
            if not rs: continue
            print(f"    {('hunt ended by ' + ev):26s} contracts {sum(r['n'] for r in rs):7.1f}  vs holding ${sum((r['px'] - r['payout']) * r['n'] - r['fee'] for r in rs):+8.2f}  won {pc(wmean(rs, 'payout'))}  sold at {wmean(rs, 'px'):.3f}  peak {f3(wmean(rs, 'peak'))}  gave back {f3(wmean(rs, 'give'))}/ct")
        # The lock given back: the bid at the moment the hunt dropped it, against what the contracts then paid.
        gb = []
        for a in acts:
            g = a.get('giveback')
            if not g: continue
            ep = a['ep']; n = abs(float(g.get('pos') or 0)) or sum(x['n'] for x in ep['entries'])
            gb.append({'n': n, 'bid': side_bid_at(ep, g['ms'] // 1000), 'floor': a['floor'], 'avg': a['avg'], 'payout': ep['payout']})
        if gb:
            s_ = [r for r in gb if r['bid'] is not None and r['payout'] is not None]
            vs_gb = sum((r['bid'] - r['payout']) * r['n'] - taker_fee(r['n'], r['bid']) for r in s_)
            under = wmean([{'n': r['n'], 'd': r['floor'] - r['bid']} for r in s_ if r['floor'] is not None], 'd')
            vs_entry = wmean([{'n': r['n'], 'd': r['bid'] - r['avg']} for r in s_ if r['avg'] is not None], 'd')
            print(f"  the lock given back ({len(gb)} hunts, {sum(r['n'] for r in gb):.1f} contracts): the bid at the giveback {f3(wmean(s_, 'bid'))}, {f3(under)}/ct under the lock and {f3(vs_entry)}/ct against the entry;"
                  f" won {pc(wmean(s_, 'payout'))}; selling at that bid instead of dropping the lock: ${vs_gb:+.2f} against holding on {sum(r['n'] for r in s_):.0f} settled contracts")
        return acts

    # -- 1d. The oracle on the hunted positions: the best exit hindsight allows, against what the ratchet got, holding, and
    #        a family of causal trailing stops run on the same recorded paths (no walls: a trail of d ticks under the running
    #        peak of the side bid since the lock, never below the lock; the gap either sold at the bid or waited for the bid to
    #        come back within a tick of the stop; with and without the 120 s close window).
    def oracle(acts):
        print('\n== 1d. the oracle on the hunted positions: hindsight\'s best exit, the ratchet\'s actual result, holding from the lock,'
              '\n   and causal trailing stops replayed on the same recorded paths (dollars against holding the same contracts to settlement)')
        TICK = 0.01
        paths = []
        for a in acts:
            ep = a['ep']
            if ep['payout'] is None or not ep.get('close_ms') or not tops.get(ep['ticker']) or a['floor'] is None: continue
            c_sec = ep['close_ms'] // 1000
            s0 = a['act_ms'] // 1000
            if c_sec <= s0 + 1: continue
            en = sum(e['n'] for e in ep['entries'] if e['ms'] <= a['act_ms'])
            ex = sum(x['n'] for x in ep['exits'] if x['ms'] < a['act_ms'])
            n = round(en - ex, 2)
            if n <= 0: continue
            # What the contracts held at the lock actually got: the exits after it, then settlement for the rest.
            left, got = n, 0.0
            for x in sorted(ep['exits'], key=lambda x: x['ms']):
                if x['ms'] < a['act_ms'] or left <= 1e-9: continue
                k = min(left, x['n']); got += k * x['px'] - x['fee'] * k / x['n']; left -= k
            got += left * ep['payout']
            bids = []
            last = None
            for sec in range(s0, c_sec + 1):
                b = side_bid_at(ep, sec)
                if b is not None and 0 < b < 1: last = b
                bids.append(last)
            paths.append({'n': n, 'floor': a['floor'], 'payout': ep['payout'], 'actual': got / n, 'bids': bids, 'c_sec': c_sec, 's0': s0, 'ticker': ep['ticker']})
        if not paths:
            print('  no hunted position with a book, a close time and a result'); return
        N = sum(p['n'] for p in paths)
        def fee1(px, n): return taker_fee(n, px) / n
        def run(d, gap, window):
            vs, sold_n, sold_won, sold_px, sold_cnt = 0.0, 0.0, 0.0, 0.0, 0
            for p in paths:
                n, floor, pay, bids = p['n'], p['floor'], p['payout'], p['bids']
                last_sec = p['c_sec'] - window
                peak = max(floor, bids[0] or floor)
                stop = max(floor, peak - d * TICK)
                value = pay
                for i, b in enumerate(bids):
                    sec = p['s0'] + i
                    if sec > last_sec: break
                    if b is None: continue
                    if b > peak + 1e-9: peak = b; stop = max(floor, peak - d * TICK)
                    if b < stop - 1e-9:
                        if gap == 'sell' or b >= stop - TICK - 1e-9:
                            value = b - fee1(b, n); sold_n += n; sold_won += pay * n; sold_px += b * n; sold_cnt += 1
                            break
                vs += (value - pay) * n
            return vs, sold_n, sold_won, sold_px, sold_cnt
        f = lambda v: f"{v:+9.2f}"
        orc = sum(((1.0 if p['payout'] >= 0.5 else max(0.0, max(x for x in p['bids'] if x is not None) - fee1(max(x for x in p['bids'] if x is not None), p['n']))) - p['payout']) * p['n'] for p in paths if any(x is not None for x in p['bids']))
        act = sum((p['actual'] - p['payout']) * p['n'] for p in paths)
        print(f"  hunted positions with a path: {len(paths)}, {N:.1f} contracts; held side won {100 * sum(p['payout'] * p['n'] for p in paths) / N:.0f}%")
        print(f"  hindsight's best exit (hold the winners, sell the losers at their peak bid, fee paid): {f(orc)} against holding; the ratchet's actual result: {f(act)}; holding from the lock: {f(0.0)}")
        print('  trailing stops on the same paths (trail d ticks under the running peak since the lock, never below the lock):')
        print('    trail  gap    window   vs holding   hunts sold  contracts sold  won%  avg sale')
        for window in (0, 120):
            for gap in ('sell', 'wait'):
                for d in (1, 2, 3, 4, 6, 8, 12, 20):
                    vs, sn, sw, spx, sc = run(d, gap, window)
                    print(f"    {d:5d}  {gap:5s}  {window:4d} s   {f(vs)}   {sc:10d}  {sn:14.1f}  {(100 * sw / sn) if sn else 0:4.0f}  {(spx / sn) if sn else 0:8.3f}")
        print("  (gap 'sell' = sell at the bid whenever it is under the stop, as today; 'wait' = sell only when the bid is within a tick of the stop, otherwise"
              "\n   hold on; the hunted position's actual result includes the model exit and settlement after the hunt ended)")

    try:
        acts = anatomy()
        oracle(acts or [])
        for t, v in results.items(): rec_results.setdefault(t, v[0])

        def more_books(tks):
            """A second pass over the recordings for the entry signals' markets section G asks for (books from 65 min before
            the first signal, the market's open, to an hour after the last)."""
            t1 = time.time()
            bw = {}
            for sec, t, *_ in entry_sigs:
                if t not in tks: continue
                a, b = bw.get(t, (sec * 1000 - 3_900_000, sec * 1000 + 4_500_000))
                bw[t] = (min(a, sec * 1000 - 3_900_000), max(b, sec * 1000 + 4_500_000))
            if not bw: return 0
            nl = load_recordings({t.encode() for t in bw}, set(), min(a for a, b in bw.values()), max(b for a, b in bw.values()), bw)
            got = sum(1 for t in bw if tops.get(t))
            for t in bw:
                top_secs[t] = [x[0] for x in tops.get(t, [])]
            print(f'  (G: second recordings pass for {len(bw)} signal markets: {nl} lines, books for {got}, results for {sum(1 for t in bw if t in rec_results)}; {time.time() - t1:.0f} s)')
            return got
        ratchet_lab(acts or [], episodes, tops, terms, index_at, sigma_cached, top_at, taker_fee, trades, entry_sigs, rec_results, more_books, orders)
    except Exception as e:  # a one-shot run on the server: the sections after this one still print
        print(f"  (1c/1d stopped: {type(e).__name__}: {e})")

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
    # The owner's description (Oct 23): a curve predicting Kalshi's live line; sell when the line falls below it (for the
    # side held) by more than x for two seconds running. Oct 23's x: the line's own noise over the look-ahead (x sigma
    # sqrt(h)). Oct 24's x (the owner): the wiggle band, the wiggles around the curve since the contract opened, mean
    # +- k sd like Bollinger bands; the engine's default is k = 2 on the 15 s projection (45 s hourly).
    rules['live line, 15 s ahead, x = 2 noise (Oct 23)'] = {'line': {'h': 15, 'kind': 'sigma', 'x': 2.0, 'floor': True}}
    for h15, kb, fl in ((15, 2.0, True), (15, 1.5, True), (15, 2.5, True), (15, 3.0, True), (10, 2.0, True), (30, 2.0, True), (15, 2.0, False)):
        rules[f'live line band, {h15} s ahead, k = {kb}{"" if fl else ", no profit floor"}'] = {'line': {'h': h15, 'kind': 'band', 'k': kb, 'floor': fl}}
    line_rules = {k: r['line'] for k, r in rules.items() if 'line' in r}
    out = {k: {'fired': 0, 'ct': 0.0, 'sale': 0.0, 'vsActual': 0.0, 'vsHold': 0.0, 'better': 0, 'breaks': 0, 'heldSec': 0, 'mk': collections.defaultdict(lambda: [0.0, 0.0]),
               'nowFired': 0, 'nowCt': 0.0, 'nowVs': 0.0, 'nowBetter': 0} for k in rules}
    replayed = 0
    windows = collections.Counter()
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
        hz = lambda h: h if profile == 'crypto_15m' else 3 * h
        line = LineTracker(0.05 if profile == 'crypto_15m' else 0.02, sorted({hz(lr['h']) for lr in line_rules.values()}))
        line_run = collections.Counter()
        line_dir = direction(ep, start)
        orient = ep['sign'] * line_dir
        # The wiggle band's window: from the contract's open, at most its 15 or 60 minutes before the close.
        window_ms = 900_000 if profile == 'crypto_15m' else 3_600_000
        band_start = max(o_ms or 0, c_ms - window_ms) // 1000
        windows[(profile, 'opened in the window' if o_ms and c_ms - o_ms <= window_ms else 'opened earlier')] += 1
        # The bot keeps one live-line curve per coin, running all the time: warm this one on the minutes before (and
        # since the window opened, for the band).
        if line_dir:
            for wsec in range(min(start - 600, band_start - 300), start):
                wpx, wsig = index_at(ep.get('asset'), wsec), sigma_cached(ep.get('asset'), wsec)
                if wpx and wsig: line.update(wsec, math.log(wpx), wsig)
        ent = sorted(ep['entries'], key=lambda e: e['ms'])
        exits = sorted(ep['exits'], key=lambda e: e['ms'])
        for sec in range(start, last_sec + 1):
            px, sig, dnow = index_at(ep.get('asset'), sec), sigma_cached(ep.get('asset'), sec), direction(ep, sec)
            line_ok = bool(px and sig and line_dir and dnow == line_dir)
            if line_ok: line.update(sec, math.log(px), sig)
            # The break is counted on the line itself every second, as the bot's per-coin curve counts it.
            for name, lr in line_rules.items():
                hh = hz(lr['h'])
                if not line_ok: line_run[name] = 0; continue
                if lr['kind'] == 'sigma':
                    proj = line.matured.get(hh)
                    broke = proj is not None and orient * (proj - math.log(px)) >= lr['x'] * sig * math.sqrt(hh)
                    line_run[name] = line_run[name] + 1 if broke else 0
                else:
                    b = line.band(hh, band_start, orient, lr['k'], BAND_MIN_SEC)
                    line_run[name] = b['run'] if b else 0
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
            for name, lr in line_rules.items():
                # How often the line breaks while held (fired or not): a 2 sd band is touched by ordinary wiggles.
                out[name]['heldSec'] += 1
                if line_run[name] == LINE_CONFIRM_SEC: out[name]['breaks'] += 1
            for name, rule in rules.items():
                if name in done: continue
                fire = False
                if 'line' in rule:
                    lr = rule['line']
                    fire = line_run[name] >= LINE_CONFIRM_SEC and (not lr['floor'] or net >= floor - 1e-9) and tau > STAND_DOWN_SEC
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
                # Against today's exits only: the positions whose contracts were not sold after this second by an exit
                # since retired (the resting sell at the projected peak, the book cross, the old profit target).
                if not any(x['kind'] in RETIRED_EXITS for x in ep['exits'] if x['ms'] // 1000 >= sec):
                    o['nowFired'] += 1; o['nowCt'] += held; o['nowVs'] += (sale - act) * held; o['nowBetter'] += 1 if sale > act + 1e-9 else 0
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
    print('   live line rules: also the breaks while held (fired or not; the floor and the close hold most) per held hour')
    print(f"   today's exits only: the same, on the positions no retired exit ({', '.join(sorted(RETIRED_EXITS))}) sold after the rule fired")
    print(f"   windows: {', '.join(f'{p} {w} {n}' for (p, w), n in sorted(windows.items()))}")
    for name, o in out.items():
        brk = f"  breaks {o['breaks']} ({3600 * o['breaks'] / o['heldSec']:.1f}/held h)" if name in line_rules and o['heldSec'] else ''
        if not o['fired']:
            print(f"  {name:52s} never fired{brk}"); continue
        mk = '  '.join(f"{h}s {o['mk'][h][0] / o['mk'][h][1]:+.3f}" if o['mk'][h][1] else f"{h}s  n/a " for h in MARKOUTS)
        now_ = (f"  | today's exits only: fired {o['nowFired']}  vs actual ${o['nowVs']:+.2f} ({o['nowVs'] / o['nowCt']:+.3f}/ct)  better {100 * o['nowBetter'] / o['nowFired']:.0f}%"
                if o['nowFired'] else "  | today's exits only: none")
        print(f"  {name:52s} fired {o['fired']:4d}  contracts {o['ct']:8.1f}  sale {o['sale'] / o['ct']:.3f}  vs actual ${o['vsActual']:+8.2f} ({o['vsActual'] / o['ct']:+.3f}/ct)"
              f"  vs holding ${o['vsHold']:+8.2f}  better {100 * o['better'] / o['fired']:3.0f}%  markouts {mk}{brk}{now_}")
    print(f"\n(done in {time.time() - t0:.0f} s)")


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == '--selftest':
        selftest(sys.argv[2])
    else:
        main()

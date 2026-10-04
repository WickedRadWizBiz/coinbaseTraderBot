#!/usr/bin/env python3
"""Independent Python reference of the SNN equations (stdlib `math` only, no numpy/torch).

Writes tests/fixtures/snn_golden.json. tests/snn.test.ts recomputes every case with the
TypeScript kernel (bot/snn/formulas.ts, bot/snn/rng.ts) and requires agreement within 1e-5,
the golden-vector parity check the design calls for.

    python3 research/snn_reference.py
"""
import json
import math
import os

# ---- neurons ---------------------------------------------------------------------------------

def lif_step(v, I, EL, R, tauM, dt=1.0):
    vinf = EL + R * I
    return vinf + (v - vinf) * math.exp(-dt / tauM)

def alif_seq(I_seq, EL, R, tauM, theta0, betaA, tauA, vReset):
    v, a, out = EL, 0.0, []
    for I in I_seq:
        v = lif_step(v, I, EL, R, tauM)
        s = 1 if v >= theta0 + betaA * a else 0
        if s:
            v = vReset
        a = a * math.exp(-1.0 / tauA) + s
        out.append([v, a, s])
    return out

def izh_seq(I_seq, a, b, c, d, v0=-65.0):
    v, u, out = v0, b * v0, []
    for I in I_seq:
        v += 0.5 * (0.04 * v * v + 5 * v + 140 - u + I)
        v += 0.5 * (0.04 * v * v + 5 * v + 140 - u + I)
        u += a * (b * v - u)
        spk = 0
        if v >= 30:
            v, u, spk = c, u + d, 1
        out.append([v, u, spk])
    return out

def hh_alpha_n(V):
    x = V + 55
    return 0.1 if abs(x) < 1e-9 else 0.01 * x / (1 - math.exp(-x / 10))

def hh_beta_n(V):
    return 0.125 * math.exp(-(V + 65) / 80)

F, Rgas, kB = 96485.33212, 8.314462618, 1.380649e-23

def nernst_planck(D, dCdx, z, T, C, dVdx):
    return -D * (dCdx + (z * F / (Rgas * T)) * C * dVdx)

def einstein(mu, T, q):
    return mu * kB * T / abs(q)

def cable_lambda(d, Rm, Ri):
    return math.sqrt((d / 4) * Rm / Ri)

# ---- dendrites and synapses ------------------------------------------------------------------

def sigmoid(x):
    return 1 / (1 + math.exp(-x)) if x >= 0 else math.exp(x) / (1 + math.exp(x))

def poirazi(W, X, thetas, alpha):
    y = 0.0
    for j in range(len(W)):
        u = -thetas[j] + sum(w * x for w, x in zip(W[j], X[j]))
        y += alpha[j] * sigmoid(u)
    return y

def dcaap(x, theta, w):
    return math.exp(-((x - theta) ** 2) / (2 * w * w))

def dexp_tpk(tr, td):
    return td * tr / (td - tr) * math.log(td / tr)

def dexp_K(tr, td):
    t = dexp_tpk(tr, td)
    return 1 / (math.exp(-t / td) - math.exp(-t / tr))

def dexp_kernel(t, g, tr, td):
    return 0.0 if t < 0 else g * dexp_K(tr, td) * (math.exp(-t / td) - math.exp(-t / tr))

def nmda_gate(V, mg=1.0):
    return 1 / (1 + (mg / 3.57) * math.exp(-0.062 * V))

# ---- governor, plasticity --------------------------------------------------------------------

def sat01(x):
    return 0.0 if x < 0 else 1.0 if x > 1 else x

def governor_seq(drives, k, tauG):
    G, out = 0.0, []
    for (rho, ze, fs, db) in drives:
        u = sat01(k[0] * rho + k[1] * ze + k[2] * fs + k[3] * db)
        G = sat01(u + (G - u) * math.exp(-1.0 / tauG))
        out.append(G)
    return out

def triplet_seq(pre, post, P, w0, eta, kappa, wmin, wmax, gate, rho_bar):
    r1 = o1 = o2 = 0.0
    w, out = w0, []
    for sp, so in zip(pre, post):
        # decay first, read o2 at t-eps (before this step's post spike), then add spikes
        r1 *= math.exp(-1 / P['tauPlus'])
        o1 *= math.exp(-1 / P['tauMinus'])
        o2p = o2 * math.exp(-1 / P['tauY'])
        r1 += sp
        plus = P['A3plus'] * r1 * o2p if so else 0.0
        minus = -P['A2minus'] * max(0.0, rho_bar / P['rho0']) ** P['p'] * o1 if sp else 0.0
        dw = eta * gate * (plus + minus)
        dw = max(-kappa, min(kappa, dw))
        w = max(wmin, min(wmax, w + dw))
        o1 += so
        o2 = o2p + so
        out.append([w, r1, o1, o2])
    return out

def two_speed_seq(wf, ws, tauC, eps, n):
    out = []
    k = 1 / tauC + eps
    for _ in range(n):
        d0 = wf - ws
        e = math.exp(-k)
        ws = ws + eps * d0 * (1 - e) / k
        wf = ws + d0 * e
        out.append([wf, ws])
    return out

# ---- predictive coding -----------------------------------------------------------------------

def pc_seq(U, r, xs, rtd, P, steps):
    nx, nr = len(xs[0]), len(r)
    out = []
    for t in range(steps):
        x = xs[t % len(xs)]
        u = [sum(U[i * nr + j] * r[j] for j in range(nr)) for i in range(nx)]
        e = [x[i] - math.tanh(u[i]) for i in range(nx)]
        n = math.sqrt(sum(v * v for v in e))
        if n > P['eMax'] and n > 0:
            e = [v * P['eMax'] / n for v in e]
        fe = [(1 - math.tanh(u[i]) ** 2) * e[i] for i in range(nx)]
        a, b = P['k1'] / P['sigma2'], P['k1'] / P['sigmaTd2']
        r0 = list(r)
        r = [r0[j] + a * sum(U[i * nr + j] * fe[i] for i in range(nx)) + b * (rtd[j] - r0[j]) - (P['k1'] / 2) * (2 * P['priorL2'] * r0[j]) for j in range(nr)]
        c, dec = P['k2'] / P['sigma2'], 1 - P['k2'] * P['lambda']
        U = [U[i * nr + j] * dec + c * fe[i] * r0[j] for i in range(nx) for j in range(nr)]
        out.append({'r': r, 'norm': n, 'U0': U[0], 'Ulast': U[-1]})
    return out

# ---- Wilson-Cowan ----------------------------------------------------------------------------

WC = dict(c1=12, c2=4, c3=13, c4=11, ae=1.2, thetaE=2.8, ai=1, thetaI=4, rE=1, rI=1, kE=0.97, kI=0.98, tauE=10, tauI=10)

def wcS(x, a, th):
    return 1 / (1 + math.exp(-a * (x - th)))

def wc_deriv(E, I, P, Q, w):
    dE = (-E + (w['kE'] - w['rE'] * E) * wcS(w['c1'] * E - w['c2'] * I + P, w['ae'], w['thetaE'])) / w['tauE']
    dI = (-I + (w['kI'] - w['rI'] * I) * wcS(w['c3'] * E - w['c4'] * I + Q, w['ai'], w['thetaI'])) / w['tauI']
    return dE, dI

def wc_rk2(E, I, P, Q, dt, w=WC):
    n = max(1, math.ceil(dt / (min(w['tauE'], w['tauI']) / 10)))
    h = dt / n
    for _ in range(n):
        a1, b1 = wc_deriv(E, I, P, Q, w)
        a2, b2 = wc_deriv(E + 0.5 * h * a1, I + 0.5 * h * b1, P, Q, w)
        E += h * a2
        I += h * b2
    return E, I

# ---- readout helpers -------------------------------------------------------------------------

def isotonic_dec(y, w=None):
    vals, wts, lens = [], [], []
    for i, yi in enumerate(y):
        v, ww, l = -yi, (w[i] if w else 1.0), 1
        while vals and vals[-1] > v:
            pv, pw, pl = vals.pop(), wts.pop(), lens.pop()
            v = (pv * pw + v * ww) / (pw + ww)
            ww += pw
            l += pl
        vals.append(v); wts.append(ww); lens.append(l)
    out = []
    for v, l in zip(vals, lens):
        out += [-v] * l
    return out

def divnorm(r, n, sigma):
    den = sigma ** n + sum(max(0, x) ** n for x in r)
    return [max(0, x) ** n / den for x in r]

def rps(cdf, out):
    return sum((a - b) ** 2 for a, b in zip(cdf, out)) / len(cdf)

def fast_sig(U, k=25):
    return 1 / (1 + k * abs(U)) ** 2

def blend(pm, ps, alpha, c, amax=0.25):
    a = min(amax, max(0, alpha)) * sat01(c)
    return (1 - a) * pm + a * ps

# ---- xoshiro128** ----------------------------------------------------------------------------

M32 = 0xFFFFFFFF

def rotl(x, k):
    return ((x << k) | (x >> (32 - k))) & M32

def xoshiro_seed(seed):
    s, x = [], seed & M32
    for _ in range(4):
        x = (x + 0x9E3779B9) & M32
        z = x
        z = ((z ^ (z >> 16)) * 0x85EBCA6B) & M32
        z = ((z ^ (z >> 13)) * 0xC2B2AE35) & M32
        s.append((z ^ (z >> 16)) & M32)
    return s

def xoshiro_next(s):
    result = (rotl((s[1] * 5) & M32, 7) * 9) & M32
    t = (s[1] << 9) & M32
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]
    s[2] ^= t
    s[3] = rotl(s[3], 11)
    return result

# ---- cases -----------------------------------------------------------------------------------

def lcg(seed):
    st = [seed]
    def nxt():
        st[0] = (st[0] * 1664525 + 1013904223) & M32
        return st[0] / 4294967296
    return nxt

def main():
    g = {}
    g['lif'] = [[v, I, lif_step(v, I, -0.2, 1.5, 10.0)] for v, I in [(0, 0), (0.3, 1), (-0.5, 2.5), (1.2, -1)]]
    I_seq = [0.0, 0.9, 1.4, 1.4, 1.4, 0.2, 2.0, 2.0, 2.0, 2.0, 0.0, 1.1]
    g['alif'] = {'I': I_seq, 'p': dict(EL=0.0, R=1.0, tauM=10.0, theta0=0.25, betaA=0.1, tauA=300.0, vReset=0.0), 'out': alif_seq(I_seq, 0.0, 1.0, 10.0, 0.25, 0.1, 300.0, 0.0)}
    izI = [10.0] * 60
    g['izh'] = {k: izh_seq(izI, *p) for k, p in {'RS': (0.02, 0.2, -65, 8), 'FS': (0.1, 0.2, -65, 2), 'CH': (0.02, 0.2, -50, 2)}.items()}
    g['hh'] = [[V, hh_alpha_n(V), hh_beta_n(V)] for V in (-80, -65, -55, -40, 0, 20)]
    g['np'] = [[1e-9, 2.0, 2, 310.0, 0.5, 1e-3, nernst_planck(1e-9, 2.0, 2, 310.0, 0.5, 1e-3)], [3e-10, -1.0, -1, 300.0, 1.2, -4e-3, nernst_planck(3e-10, -1.0, -1, 300.0, 1.2, -4e-3)]]
    g['einstein'] = [[5e-8, 310.0, 1.602176634e-19, einstein(5e-8, 310.0, 1.602176634e-19) * 1e9]]
    g['lambda'] = [[2e-6, 2.0, 1.0, cable_lambda(2e-6, 2.0, 1.0)], [1e-6, 20000.0, 100.0, cable_lambda(1e-6, 20000.0, 100.0)]]
    r = lcg(7)
    W = [[r() * 2 - 1 for _ in range(16)] for _ in range(6)]
    X = [[r() for _ in range(16)] for _ in range(6)]
    th = [r() - 0.5 for _ in range(6)]
    al = [r() for _ in range(6)]
    g['poirazi'] = {'W': W, 'X': X, 'theta': th, 'alpha': al, 'y': poirazi(W, X, th, al)}
    g['dcaap'] = [[x, 1.0, 0.4, dcaap(x, 1.0, 0.4)] for x in (0, 0.6, 1.0, 1.5, 3.0)]
    g['dexp'] = [[tr, td, dexp_tpk(tr, td), dexp_K(tr, td), dexp_kernel(t, 0.7, tr, td), t] for tr, td, t in [(0.5, 5, 1.0), (2, 90, 10.0), (0.5, 10, 3.0)]]
    g['nmda'] = [[V, mg, nmda_gate(V, mg)] for V, mg in [(-80, 1), (-65, 1), (-50, 1), (-20, 1.2), (0, 1), (20, 2)]]
    drives = [(0.2, 0, 0, 0)] * 30 + [(1.5, 2.0, 0.1, 0.3)] * 60 + [(0, 0, 0, 0)] * 30
    g['governor'] = {'drives': drives, 'k': [0.5, 0.1, 2.0, 1.0], 'tauG': 40.0, 'out': governor_seq(drives, [0.5, 0.1, 2.0, 1.0], 40.0)}
    P = dict(tauPlus=17.0, tauMinus=34.0, tauY=114.0, A3plus=6.5e-3, A2minus=7.1e-3, rho0=0.05, p=1.0)
    pre = [1 if (t % 3 == 0) else 0 for t in range(40)]
    post = [1 if (t % 4 == 1) else 0 for t in range(40)]
    g['triplet'] = {'pre': pre, 'post': post, 'P': P, 'w0': 0.5, 'eta': 1.0, 'kappa': 0.004, 'wmin': 0.0, 'wmax': 1.0, 'gate': 0.8, 'rhoBar': 0.08,
                    'out': triplet_seq(pre, post, P, 0.5, 1.0, 0.004, 0.0, 1.0, 0.8, 0.08)}
    # [meanY2, rho0, ybar, y0, p, eta, x, y] -> thetaIC, theta1982, dw (with theta1982)
    g['bcm'] = []
    for mY2, rho0, yb, y0, pw, eta, x, y in [(0.0025, 0.05, 0.04, 0.05, 2, 0.01, 0.7, 0.06), (0.01, 0.1, 0.12, 0.1, 1, 0.1, 0.2, 0.05)]:
        t82 = (yb / y0) ** pw * yb
        g['bcm'].append([mY2, rho0, yb, y0, pw, eta, x, y, mY2 / rho0, t82, eta * x * y * (y - t82)])
    g['two_speed'] = {'wf': 1.0, 'ws': 0.2, 'tauC': 7200.0, 'eps': 1e-5, 'out': two_speed_seq(1.0, 0.2, 7200.0, 1e-5, 5)}
    r = lcg(11)
    nx, nr = 5, 4
    U = [(r() - 0.5) * 0.4 for _ in range(nx * nr)]
    r0 = [r() * 0.5 for _ in range(nr)]
    xs = [[r() * 0.8 for _ in range(nx)] for _ in range(3)]
    rtd = [r() * 0.5 for _ in range(nr)]
    PP = dict(k1=0.1, k2=0.01, sigma2=0.5, sigmaTd2=2.0, **{'lambda': 0.01}, eMax=1.0, priorL2=0.05)
    g['pc'] = {'U': U, 'r': r0, 'xs': xs, 'rtd': rtd, 'P': PP, 'out': pc_seq(U, r0, xs, rtd, PP, 6)}
    g['wc'] = [[E, I, Pv, Qv, dt, *wc_rk2(E, I, Pv, Qv, dt)] for E, I, Pv, Qv, dt in [(0.1, 0.05, 1.25, 0.0, 1.0), (0.3, 0.2, 0.5, 0.0, 5.0), (0.0, 0.0, 2.0, 0.5, 50.0)]]
    g['isotonic'] = [{'y': y, 'out': isotonic_dec(y)} for y in ([0.9, 0.7, 0.75, 0.4, 0.45, 0.42, 0.1], [0.2, 0.3, 0.1], [0.8, 0.6, 0.4])]
    g['divnorm'] = [{'r': [0.1, 0.3, 0.05, 0.2], 'n': 2, 'sigma': 0.1, 'out': divnorm([0.1, 0.3, 0.05, 0.2], 2, 0.1)}]
    g['rps'] = [[[0.95, 0.8, 0.5, 0.2, 0.05], [1, 1, 1, 0, 0], rps([0.95, 0.8, 0.5, 0.2, 0.05], [1, 1, 1, 0, 0])]]
    g['fastsig'] = [[U, fast_sig(U)] for U in (-0.2, 0, 0.01, 0.1, 1.0)]
    g['blend'] = [[pm, ps, a, c, blend(pm, ps, a, c)] for pm, ps, a, c in [(0.6, 0.4, 0.1, 0.5), (0.3, 0.9, 0.5, 1.0), (0.5, 0.2, 0.25, 1.5)]]
    s = xoshiro_seed(42)
    g['xoshiro'] = {'seed': 42, 'state0': list(s), 'out': [xoshiro_next(s) for _ in range(16)]}
    path = os.path.join(os.path.dirname(__file__), '..', 'tests', 'fixtures', 'snn_golden.json')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(g, f, indent=0)
    print('wrote', os.path.normpath(path))

if __name__ == '__main__':
    main()

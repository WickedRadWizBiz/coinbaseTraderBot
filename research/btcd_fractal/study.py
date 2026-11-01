#!/usr/bin/env python3
"""BTC.D fractal walk-forward study (Steven, 2026-11-01).

Thesis (docs/FRACTAL.md): since 2018, BTC dominance has been replaying the shape of its 2016-2017 cycle (the
parent), slowed down several times and on a compressed scale. The parent's stages: a long BTC-dominant stretch,
a first waterfall, a relief rally, a final waterfall into alt season. The final waterfall has yet to play out
in the child (2018 -> today).

This study, on weekly closes of TradingView's CRYPTOCAP:BTC.D:
  1. Aligns the child onto the parent with constrained, open-ended dynamic time warping (each child week moves
     the parent 0..maxstep weeks, at most `cap` child weeks on one parent week) and a refitted level map
     child = a + b * parent, plus an optional shape term (local trend over the same span of parent time).
  2. Iterates: round 1 is a grid of settings and windows; each setting is scored OUT OF SAMPLE by walking it
     forward (at each past week, fit on data known then, project 13/26/52 weeks, compare with what happened and
     with "no change"); round 2 refines around the best settings. The ensemble is weighted by that walk-forward
     skill, not by in-sample fit.
  3. Places today in the parent with a range: the band of parent weeks whose open-end cost is within 10% of the
     best, across the weighted ensemble; and projects the parent's remaining path (waterfalls run in a fixed
     number of weeks, the rest stretched by the dilation) as a fan.
  4. Adversary: the same machinery with placebo parents (IAAFT surrogates, block-shuffled, matched random walks,
     the time-reversed parent, other real BTC.D windows), random window offsets, and placebo child starts.
     The real parent must beat them out of sample, or the fit is DTW's flexibility, not a fractal.

  python3 research/btcd_fractal/study.py --data research/btcd_fractal/data --out research/btcd_fractal/out
"""
import argparse
import json
import math
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from numba import njit

INF = 1e18
HORIZONS = (13, 26, 52)


# ----------------------------------------------------------------------------------------------- data
def load(data_dir, name):
    f = os.path.join(data_dir, f"{name}_1d.csv")
    if not os.path.exists(f):
        return None
    df = pd.read_csv(f)
    s = pd.Series(df["c"].values, index=pd.DatetimeIndex(pd.to_datetime(df["ts"], unit="ms", utc=True)).tz_convert(None))
    return s[~s.index.duplicated()].sort_index()


def weekly(s):
    return s.resample("W-SUN").last().dropna()


# ----------------------------------------------------------------------------------------------- DTW
@njit(cache=True)
def dtw_open_end(child, parent, a, b, wshape, cshape, ptab, kidx, j0max, maxstep, cap):
    """Open-begin (first child week in parent[0..j0max]), open-end DTW with a run-length cap on stalls.
    a[i], b[i]: the level map at child week i (it may evolve along the path: Steven's dynamic factor).
    ptab[k, j]: the parent's change over k parent weeks ending at j; kidx[i]: which k matches child week i's
    shape window at the local dilation there. Returns (last-row cost per parent column, path)."""
    n = child.shape[0]
    m = parent.shape[0]
    R = cap + 1
    D = np.full((n, m, R), INF)
    B = np.full((n, m, R), -1, dtype=np.int64)
    for j in range(min(j0max + 1, m)):
        e = child[0] - a[0] - b[0] * parent[j]
        D[0, j, 0] = e * e
    rowmin = np.full(m, INF)
    rowarg = np.full(m, -1, dtype=np.int64)
    for i in range(1, n):
        for jp in range(m):
            rowmin[jp] = INF
            rowarg[jp] = -1
            for r in range(R):
                v = D[i - 1, jp, r]
                if v < rowmin[jp]:
                    rowmin[jp] = v
                    rowarg[jp] = jp * R + r
        for j in range(m):
            e = child[i] - a[i] - b[i] * parent[j]
            c = e * e
            if wshape > 0.0:
                s = cshape[i] - b[i] * ptab[kidx[i], j]
                c += wshape * s * s
            # stay on parent week j (stall): run length r-1 -> r
            for r in range(1, R):
                v = D[i - 1, j, r - 1]
                if v < INF:
                    D[i, j, r] = v + c
                    B[i, j, r] = j * R + (r - 1)
            # advance 1..maxstep parent weeks: run length resets
            best = INF
            bi = -1
            for st in range(1, maxstep + 1):
                jp = j - st
                if jp < 0:
                    break
                if rowmin[jp] < best:
                    best = rowmin[jp]
                    bi = rowarg[jp]
            if bi >= 0:
                D[i, j, 0] = best + c
                B[i, j, 0] = bi
    last = np.full(m, INF)
    lastr = np.zeros(m, dtype=np.int64)
    for j in range(m):
        for r in range(R):
            if D[n - 1, j, r] < last[j]:
                last[j] = D[n - 1, j, r]
                lastr[j] = r
    jb = 0
    for j in range(m):
        if last[j] < last[jb]:
            jb = j
    path = np.zeros(n, dtype=np.int64)
    k = jb * R + lastr[jb]
    for i in range(n - 1, -1, -1):
        path[i] = k // R
        if i > 0:
            k = B[i, k // R, k % R]
    return last, path


def shift_diff(x, k):
    k = max(1, int(k))
    out = np.zeros_like(x)
    out[k:] = x[k:] - x[:-k]
    out[:k] = x[:k] - x[0]
    return out


def level_map(child, pp, cfg):
    """The level map child ~ a + b * parent on the aligned pairs, per child week.
    dynmap 0: one fixed (a, b). dynmap 1: a and b drift linearly along the child's time.
    dynmap 2: a and b re-estimated locally (Gaussian kernel over `bw` child weeks): the template is squished
    and re-levelled progressively as the cycle advances."""
    n = len(child)
    lo, hi = cfg["bmin"], cfg["bmax"]
    mode = cfg.get("dynmap", 0)
    if mode == 0:
        vp = np.var(pp)
        b = float(np.clip(np.cov(child, pp, bias=True)[0, 1] / vp, lo, hi)) if vp > 1e-9 else 1.0
        a = float(np.mean(child - b * pp))
        return np.full(n, a), np.full(n, b)
    tau = np.arange(n) / max(n - 1, 1)
    if mode == 1:
        X = np.column_stack([np.ones(n), pp, tau, pp * tau])
        coef, *_ = np.linalg.lstsq(X, child, rcond=None)
        b = np.clip(coef[1] + coef[3] * tau, lo, hi)
        # with b clipped, refit the drifting offset on what b leaves
        c2, *_ = np.linalg.lstsq(np.column_stack([np.ones(n), tau]), child - b * pp, rcond=None)
        return c2[0] + c2[1] * tau, b
    bw = float(cfg.get("bw", 52))
    a = np.zeros(n)
    b = np.zeros(n)
    idx = np.arange(n)
    for i in range(n):
        w = np.exp(-0.5 * ((idx - i) / bw) ** 2)
        sw = w.sum()
        mp = (w * pp).sum() / sw
        mc = (w * child).sum() / sw
        vp = (w * (pp - mp) ** 2).sum() / sw
        cv = (w * (pp - mp) * (child - mc)).sum() / sw
        bi = float(np.clip(cv / vp, lo, hi)) if vp > 1e-6 else (b[i - 1] if i else 1.0)
        b[i] = bi
        a[i] = mc - bi * mp
    return a, b


def fit(child, parent, cfg, iters=4):
    n, m = len(child), len(parent)
    b0 = float(np.clip(np.std(child) / max(np.std(parent), 1e-9), cfg["bmin"], cfg["bmax"]))
    a = np.full(n, float(np.mean(child) - b0 * np.mean(parent)))
    b = np.full(n, b0)
    j0max = int(cfg["j0"] * m)
    kc = int(cfg["shapew"])
    cshape = shift_diff(child, kc)
    ptab = np.zeros((kc + 1, m))
    for k in range(1, kc + 1):
        ptab[k] = shift_diff(parent, k)
    kidx = np.full(n, max(1, round(kc / (n / (0.8 * m)))), dtype=np.int64)
    last = path = None
    for _ in range(iters):
        last, path = dtw_open_end(child, parent, a, b, float(cfg["wshape"]), cshape, ptab, kidx, j0max, int(cfg["maxstep"]), int(cfg["cap"]))
        pp = parent[path]
        a, b = level_map(child, pp, cfg)
        # local dilation along the path (child weeks per parent week over the last `kc` child weeks): the shape
        # term compares the child's last kc weeks with the parent's matching span, which shrinks or grows as the
        # warp speeds up or slows down
        for i in range(n):
            i0 = max(0, i - kc)
            adv = path[i] - path[i0]
            kidx[i] = int(np.clip(round(adv if adv > 0 else 1), 1, kc))
    span = path[-1] - path[0] + 1
    dil = n / max(span, 1)
    pred = a + b * parent[path]
    err = child - pred
    rec = slice(max(0, n - 52), n)
    r = float(np.corrcoef(child, pred)[0, 1]) if np.std(pred) > 0 else 0.0
    rr = float(np.corrcoef(child[rec], pred[rec])[0, 1]) if np.std(pred[rec]) > 0 and np.std(child[rec]) > 0 else 0.0
    k26 = min(26, n - 1)
    rdil = k26 / max(path[-1] - path[-1 - k26], 0.25)
    best = float(last.min())
    band = np.where(last <= best * 1.10 + 1e-9)[0]
    return {"a": float(a[-1]), "b": float(b[-1]), "aPath": a, "bPath": b, "path": path, "jend": int(path[-1]), "dil": float(dil),
            "rdil": float(min(rdil, 64.0)), "r": r, "recentR": rr, "mae": float(np.mean(np.abs(err))),
            "recentMae": float(np.mean(np.abs(err[rec]))), "cost": best / n, "band": band, "last": last}


# ----------------------------------------------------------------------------------------------- parent structure
def zigzag(x, rev):
    """Pivots of a zigzag with reversals of `rev` points. Returns list of (index, value)."""
    piv = [0]
    direction = 0
    ext = 0
    for i in range(1, len(x)):
        if direction >= 0:
            if x[i] > x[ext]:
                ext = i
            elif x[ext] - x[i] >= rev:
                if direction == 0 and ext == 0:
                    pass
                piv.append(ext)
                direction = -1
                ext = i
                continue
        if direction <= 0:
            if x[i] < x[ext]:
                ext = i
            elif x[i] - x[ext] >= rev:
                piv.append(ext)
                direction = 1
                ext = i
    piv.append(ext if ext != piv[-1] else len(x) - 1)
    out = []
    for p in piv:
        if not out or out[-1] != p:
            out.append(p)
    return out


def waterfalls(parent, rev=6.0, minfall=15.0, drift=0.15):
    """Waterfall steep parts in the parent: zigzag falls of >= minfall points, from the week the fall has done
    `drift` of its depth to its trough."""
    piv = zigzag(parent, rev)
    out = []
    for p, q in zip(piv[:-1], piv[1:]):
        depth = parent[p] - parent[q]
        if depth >= minfall:
            start = p
            for k in range(p, q + 1):
                if parent[p] - parent[k] >= drift * depth:
                    start = max(p, k - 1)
                    break
            out.append((start, q))
    return out, piv


# ----------------------------------------------------------------------------------------------- projection
def project(child, parent, f, cfg, H, wf):
    """The parent's remaining path from the matched week, on the child's scale and anchored at today's level.
    Non-waterfall parent weeks last `stretch` child weeks (geometric mean of overall and recent dilation);
    a waterfall's steep part runs in cfg['wfweeks'] child weeks (0 = stretched like the rest)."""
    j = f["jend"]
    m = len(parent)
    stretch = float(np.clip(math.sqrt(max(f["dil"], 0.25) * max(f["rdil"], 0.25)), 0.5, 16.0))
    dur = np.full(m, stretch)
    if cfg["wfweeks"] > 0:
        for s, e in wf:
            L = e - s
            if L > 0:
                dur[s:e] = cfg["wfweeks"] / L
    # time (child weeks from now) at which each parent week from j is reached
    t = [0.0]
    v = [float(child[-1])]
    for k in range(j + 1, m):
        t.append(t[-1] + dur[k - 1])
        v.append(float(child[-1] + f["b"] * (parent[k] - parent[j])))
    t = np.array(t)
    v = np.array(v)
    hs = np.arange(1, H + 1)
    out = np.interp(hs, t, v)  # beyond the parent's end: holds its last level
    return out, t, v


# ----------------------------------------------------------------------------------------------- one config
def evaluate(child_full, parent, cfg, dates, step=4, start=52, H=78, wf=None, want_paths=True):
    """Full fit on all data plus the walk-forward skill of its projection."""
    child = child_full
    f = fit(child, parent, cfg)
    res = {"cfg": cfg, "fit": {k: (v if not isinstance(v, np.ndarray) else None) for k, v in f.items() if k not in ("path", "band", "last", "aPath", "bPath")}}
    res["jend"] = f["jend"]
    res["band"] = [int(f["band"].min()), int(f["band"].max())] if len(f["band"]) else [f["jend"], f["jend"]]
    res["bandAll"] = f["band"].tolist()
    if want_paths:
        res["path"] = f["path"].tolist()
        res["aPath"] = [round(float(x), 3) for x in f["aPath"]]
        res["bPath"] = [round(float(x), 4) for x in f["bPath"]]
        proj, _, _ = project(child, parent, f, cfg, H, wf)
        res["proj"] = proj.tolist()
        # projections from every near-optimal end in the band (position uncertainty)
        bp = []
        for jb in f["band"][:: max(1, len(f["band"]) // 6)]:
            g = dict(f)
            g["jend"] = int(jb)
            bp.append(project(child, parent, g, cfg, H, wf)[0].tolist())
        res["bandProj"] = bp
    # walk forward
    errs = {h: [] for h in HORIZONS}
    flat = {h: [] for h in HORIZONS}
    hit = {h: [] for h in HORIZONS}
    prs = {h: [] for h in HORIZONS}
    acts = {h: [] for h in HORIZONS}
    track = []
    n = len(child)
    for t in range(start, n, step):
        g = fit(child[: t + 1], parent, cfg, iters=3)
        p, _, _ = project(child[: t + 1], parent, g, cfg, max(HORIZONS), wf)
        track.append((t, g["jend"], g["r"]))
        for h in HORIZONS:
            if t + h < n:
                act = child[t + h] - child[t]
                pr = p[h - 1] - child[t]
                errs[h].append(abs(pr - act))
                prs[h].append(pr)
                acts[h].append(act)
                flat[h].append(abs(act))
                if abs(act) > 0.5:
                    hit[h].append(1.0 if np.sign(pr) == np.sign(act) else 0.0)
    sk = {}
    for h in HORIZONS:
        if errs[h]:
            sk[f"h{h}"] = {"n": len(errs[h]), "mae": float(np.mean(errs[h])), "maeFlat": float(np.mean(flat[h])),
                           "ratio": float(np.mean(errs[h]) / max(np.mean(flat[h]), 1e-9)),
                           "hit": float(np.mean(hit[h])) if hit[h] else None,
                           # behaviour, not level: does the projected move line up with the realized one?
                           "ic": float(np.corrcoef(prs[h], acts[h])[0, 1]) if len(prs[h]) > 3 and np.std(prs[h]) > 0 else 0.0}
    res["skill"] = sk
    res["track"] = track
    return res


def score(res):
    """Out-of-sample score: mean walk-forward error ratio vs 'no change' over the horizons (lower is better)."""
    rs = [res["skill"][k]["ratio"] for k in res["skill"]]
    return float(np.mean(rs)) if rs else 9.0


# ----------------------------------------------------------------------------------------------- surrogates
def iaaft(x, rng, iters=200):
    xs = np.sort(x)
    amp = np.abs(np.fft.rfft(x - x.mean()))
    y = rng.permutation(x)
    for _ in range(iters):
        Y = np.fft.rfft(y - y.mean())
        Y = amp * np.exp(1j * np.angle(Y))
        y = np.fft.irfft(Y, n=len(x)) + x.mean()
        y = xs[np.argsort(np.argsort(y))]
    return y


def block_shuffle(x, rng, blk=8):
    d = np.diff(x)
    blocks = [d[i:i + blk] for i in range(0, len(d), blk)]
    order = rng.permutation(len(blocks))
    dd = np.concatenate([blocks[k] for k in order])
    y = np.concatenate([[x[0]], x[0] + np.cumsum(dd)])
    return y


def matched_walk(x, rng):
    d = np.diff(x)
    sd = d.std()
    lo, hi = x.min(), x.max()
    y = [x[0]]
    for _ in range(len(d)):
        v = y[-1] + rng.normal(0, sd)
        if v < lo or v > hi:
            v = y[-1] - (v - y[-1])
        y.append(float(np.clip(v, lo, hi)))
    return np.array(y)


# ----------------------------------------------------------------------------------------------- workers
_G = {}


def _init(child, parent, dates, wf):
    _G.update(child=child, parent=parent, dates=dates, wf=wf)


def _eval_cfg(cfg):
    return evaluate(_G["child"], _G["parent"], cfg, _G["dates"], wf=_G["wf"], want_paths=True)


def _eval_parent(args):
    kind, par, cfg = args
    wf, _ = waterfalls(par)
    r = evaluate(_G["child"], par, cfg, _G["dates"], step=8, wf=wf, want_paths=False)
    return {"kind": kind, "score": score(r), "r": r["fit"]["r"], "mae": r["fit"]["mae"], "cost": r["fit"]["cost"],
            "h26": r["skill"].get("h26", {}).get("ratio"), "hit26": r["skill"].get("h26", {}).get("hit"), "ic26": r["skill"].get("h26", {}).get("ic")}


def _eval_child(args):
    kind, ch, cfg = args
    wf, _ = waterfalls(_G["parent"])
    r = evaluate(ch, _G["parent"], cfg, None, step=8, wf=wf, want_paths=False)
    return {"kind": kind, "score": score(r), "r": r["fit"]["r"], "mae": r["fit"]["mae"], "cost": r["fit"]["cost"]}


# ----------------------------------------------------------------------------------------------- main
def wquant(vals, w, qs):
    o = np.argsort(vals)
    v = np.asarray(vals)[o]
    ww = np.asarray(w)[o]
    c = np.cumsum(ww) / ww.sum()
    return [float(v[min(np.searchsorted(c, q), len(v) - 1)]) for q in qs]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--surrogates", type=int, default=60, help="per surrogate kind")
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 2)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    t0 = time.time()

    btcd = load(a.data, "BTC.D")
    if btcd is None or len(btcd) < 400:
        print("no BTC.D history")
        return 1
    W = weekly(btcd)
    print(f"BTC.D daily {btcd.index[0].date()}..{btcd.index[-1].date()} ({len(btcd)} bars), weekly {len(W)}")

    def window(fr, to=None):
        s = W[(W.index >= pd.Timestamp(fr)) & ((W.index < pd.Timestamp(to)) if to else True)]
        return s.values.astype(float), s.index

    # --- round 1 grid
    parents = {"2016-01..2018-01-15": ("2016-01-01", "2018-01-15"), "2015-06..2018-01-15": ("2015-06-01", "2018-01-15"),
               "2016-01..2018-03": ("2016-01-01", "2018-03-01")}
    childs = {"2018-01-01": "2018-01-01", "2018-01-15": "2018-01-15"}
    base = {"maxstep": 2, "cap": 16, "j0": 0.15, "dynmap": 0, "bw": 0, "wshape": 1.0, "shapew": 8, "bmin": 0.35, "bmax": 2.5, "wfweeks": 13}
    grid = []
    for pk in parents:
        for ck in childs:
            for wsh in (0.0, 1.0, 3.0):
                for ms in (2, 3):
                    for dm, bw in ((0, 0), (1, 0), (2, 52), (2, 104)):
                        grid.append(dict(base, parent=pk, child=ck, wshape=wsh, maxstep=ms, dynmap=dm, bw=bw))
    spec = dict(base, parent="2016-01..2018-01-15", child="2018-01-01")  # docs/FRACTAL.md defaults

    results = []

    def run_cfgs(cfgs):
        out = []
        by = {}
        for c in cfgs:
            by.setdefault((c["parent"], c["child"]), []).append(c)
        for (pk, ck), cs in by.items():
            par, pidx = window(*parents[pk])
            ch, cidx = window(childs[ck])
            wf, _ = waterfalls(par)
            with ProcessPoolExecutor(a.workers, initializer=_init, initargs=(ch, par, None, wf)) as ex:
                for r in ex.map(_eval_cfg, cs):
                    r["score"] = score(r)
                    out.append(r)
        return out

    results += run_cfgs(grid)
    print(f"round 1: {len(results)} settings in {time.time() - t0:.0f}s")
    results.sort(key=lambda r: r["score"])
    for r in results[:5]:
        c = r["cfg"]
        print(f"  score {r['score']:.3f} r {r['fit']['r']:.3f} | parent {c['parent']} child {c['child']} wshape {c['wshape']} maxstep {c['maxstep']} j0 {c['j0']}")

    # --- round 2: refine around the best 4 settings
    seen = {json.dumps(r["cfg"], sort_keys=True) for r in results}
    r2 = []
    for r in results[:4]:
        c = r["cfg"]
        for var in ({"wfweeks": 8}, {"wfweeks": 26}, {"wfweeks": 0}, {"shapew": 4}, {"shapew": 13}, {"cap": 24},
                    {"cap": 10}, {"bmin": 0.2, "bmax": 4.0}, {"j0": 0.30}, {"dynmap": 2, "bw": 26}, {"dynmap": 2, "bw": 78}):
            nc = dict(c, **var)
            k = json.dumps(nc, sort_keys=True)
            if k not in seen:
                seen.add(k)
                r2.append(nc)
    if json.dumps(spec, sort_keys=True) not in seen:
        r2.append(spec)
    results += run_cfgs(r2)
    results.sort(key=lambda r: r["score"])
    print(f"round 2: {len(r2)} more settings, {time.time() - t0:.0f}s")
    for r in results[:5]:
        c = r["cfg"]
        print(f"  score {r['score']:.3f} r {r['fit']['r']:.3f} | {c}")

    for dm in (0, 1, 2):
        rs = [r for r in results if r["cfg"].get("dynmap", 0) == dm]
        if rs:
            b_ = min(rs, key=lambda r: r["score"])
            print(f"  dynmap {dm}: {len(rs)} settings, best score {b_['score']:.3f}, median {np.median([r['score'] for r in rs]):.3f}, best r {max(r['fit']['r'] for r in rs):.3f}, "
                  f"best hit26 {max((r['skill'].get('h26', {}).get('hit') or 0) for r in rs):.2f}, best ic26 {max((r['skill'].get('h26', {}).get('ic') or 0) for r in rs):.2f}")

    # --- ensemble: weights from out-of-sample score (softmax over the best third)
    top = results[: max(8, len(results) // 3)]
    sc = np.array([r["score"] for r in top])
    w = np.exp(-(sc - sc.min()) / 0.05)
    w /= w.sum()
    spec_res = next(r for r in results if json.dumps(r["cfg"], sort_keys=True) == json.dumps(spec, sort_keys=True))
    best = results[0]

    # parent dates for the reference parent (spec window) to express positions on one calendar
    refpar, refidx = window(*parents[spec["parent"]])
    refwf, refpiv = waterfalls(refpar)

    def to_date(r, j):
        _, pidx = window(*parents[r["cfg"]["parent"]])
        return pidx[min(j, len(pidx) - 1)]

    def progress(r, j):
        _, pidx = window(*parents[r["cfg"]["parent"]])
        d = pidx[min(j, len(pidx) - 1)]
        return (d - refidx[0]).days / max((refidx[-1] - refidx[0]).days, 1)

    pos_vals, pos_w = [], []
    for r, ww in zip(top, w):
        band = r["bandAll"] or [r["jend"]]
        for j in band:
            pos_vals.append(to_date(r, j).value)
            pos_w.append(ww / len(band))
    q = wquant(pos_vals, pos_w, [0.1, 0.5, 0.9])
    pos_q = [pd.Timestamp(int(v)).date().isoformat() for v in q]

    # projection fan from every top setting's band projections
    H = 78
    fan_paths, fan_w = [], []
    for r, ww in zip(top, w):
        bp = r["bandProj"] or [r["proj"]]
        for p in bp:
            fan_paths.append(p)
            fan_w.append(ww / len(bp))
    fan_paths = np.array(fan_paths)
    fan_w = np.array(fan_w)
    fan = {k: [] for k in ("p10", "p25", "p50", "p75", "p90")}
    for h in range(H):
        qs = wquant(fan_paths[:, h], fan_w, [0.1, 0.25, 0.5, 0.75, 0.9])
        for k, v in zip(fan, qs):
            fan[k].append(v)

    # --- adversary
    rng = np.random.default_rng(20261101)
    ch_spec, cidx_spec = window(childs[spec["child"]])
    par_spec = refpar
    adv_cfg = dict(best["cfg"])
    par_best, _ = window(*parents[adv_cfg["parent"]])
    ch_best, cidx_best = window(childs[adv_cfg["child"]])
    jobs = []
    N = a.surrogates
    for i in range(N):
        jobs.append(("iaaft", iaaft(par_best, rng), adv_cfg))
        jobs.append(("block8", block_shuffle(par_best, rng), adv_cfg))
        jobs.append(("walk", matched_walk(par_best, rng), adv_cfg))
    jobs.append(("reversed", par_best[::-1].copy(), adv_cfg))
    # other real BTC.D windows of the same length that do not overlap the child (before the parent)
    L = len(par_best)
    early = W[W.index < pd.Timestamp("2018-01-01")]
    for s0 in range(0, max(0, len(early) - L), 6):
        seg = early.values[s0:s0 + L].astype(float)
        if len(seg) == L and early.index[s0] < pd.Timestamp(parents[adv_cfg["parent"]][0]) - pd.Timedelta(days=60):
            jobs.append((f"btcd@{early.index[s0].date()}", seg, adv_cfg))
    # random offsets of the real parent window
    for i in range(24):
        so = int(rng.integers(-26, 27))
        eo = int(rng.integers(-8, 9))
        p0 = pd.Timestamp(parents[adv_cfg["parent"]][0]) + pd.Timedelta(weeks=so)
        p1 = pd.Timestamp(parents[adv_cfg["parent"]][1]) + pd.Timedelta(weeks=eo)
        seg = W[(W.index >= p0) & (W.index < p1)].values.astype(float)
        jobs.append((f"offset{so:+d}w/{eo:+d}w", seg, adv_cfg))
    real_wf, _ = waterfalls(par_best)
    with ProcessPoolExecutor(a.workers, initializer=_init, initargs=(ch_best, par_best, None, real_wf)) as ex:
        adv = list(ex.map(_eval_parent, jobs))
        # placebo child starts: the same parent against the child started at other dates
        cjobs = []
        for d0 in ("2017-06-01", "2018-06-01", "2019-01-01", "2019-07-01", "2020-01-01"):
            cc, _ = window(d0)
            cjobs.append((f"child@{d0}", cc, adv_cfg))
        advc = list(ex.map(_eval_child, cjobs))
    real = {"score": best["score"], "r": best["fit"]["r"], "mae": best["fit"]["mae"], "cost": best["fit"]["cost"],
            "h26": best["skill"].get("h26", {}).get("ratio"), "hit26": best["skill"].get("h26", {}).get("hit"), "ic26": best["skill"].get("h26", {}).get("ic")}
    kinds = {}
    for x in adv:
        k = x["kind"] if x["kind"] in ("iaaft", "block8", "walk", "reversed") else ("offset" if x["kind"].startswith("offset") else "otherBTCD")
        kinds.setdefault(k, []).append(x)
    adv_sum = {}
    for k, xs in kinds.items():
        s = np.array([x["score"] for x in xs])
        rr = np.array([x["r"] for x in xs])
        cst = np.array([x["cost"] for x in xs])
        adv_sum[k] = {"n": len(xs), "scoreMedian": float(np.median(s)), "scoreBest": float(s.min()),
                      "pScore": float((np.sum(s <= real["score"]) + 1) / (len(s) + 1)),
                      "rMedian": float(np.median(rr)), "pR": float((np.sum(rr >= real["r"]) + 1) / (len(rr) + 1)),
                      "costMedian": float(np.median(cst)), "pCost": float((np.sum(cst <= real["cost"]) + 1) / (len(cst) + 1))}
        hs = np.array([x["hit26"] if x.get("hit26") is not None else np.nan for x in xs])
        ics = np.array([x["ic26"] if x.get("ic26") is not None else np.nan for x in xs])
        if real.get("hit26") is not None and np.isfinite(hs).any():
            adv_sum[k]["hit26Median"] = float(np.nanmedian(hs))
            adv_sum[k]["pHit26"] = float((np.nansum(hs >= real["hit26"]) + 1) / (np.isfinite(hs).sum() + 1))
        if real.get("ic26") is not None and np.isfinite(ics).any():
            adv_sum[k]["ic26Median"] = float(np.nanmedian(ics))
            adv_sum[k]["pIc26"] = float((np.nansum(ics >= real["ic26"]) + 1) / (np.isfinite(ics).sum() + 1))
    print("adversary (real parent score %.3f, r %.3f, cost %.2f):" % (real["score"], real["r"], real["cost"]))
    for k, v in adv_sum.items():
        print(f"  {k:10s} hit26 median {v.get('hit26Median')} p {v.get('pHit26')} | ic26 median {v.get('ic26Median')} p {v.get('pIc26')}")
        print(f"  {k:10s} n {v['n']:3d} score median {v['scoreMedian']:.3f} best {v['scoreBest']:.3f} p {v['pScore']:.3f} | r median {v['rMedian']:.3f} p {v['pR']:.3f} | cost p {v['pCost']:.3f}")
    for x in advc:
        print(f"  {x['kind']}: score {x['score']:.3f} r {x['r']:.3f} cost {x['cost']:.2f}")

    # --- stages of the reference parent, and today's
    stages = []
    for p, qq in zip(refpiv[:-1], refpiv[1:]):
        stages.append({"from": refidx[p].date().isoformat(), "to": refidx[qq].date().isoformat(),
                       "fromLvl": round(float(refpar[p]), 1), "toLvl": round(float(refpar[qq]), 1)})
    wfl = [{"start": refidx[s].date().isoformat(), "end": refidx[e].date().isoformat(), "from": round(float(refpar[s]), 1), "to": round(float(refpar[e]), 1)} for s, e in refwf]

    # --- context series (institutional read): last values and changes
    ctx = {}
    for name in ("BTC.D", "USDT.D", "TOTAL", "TOTAL2", "TOTAL3", "OTHERS.D", "ETH.D", "BTCUSD", "ETHBTC", "DXY", "US10Y", "SPX", "M2"):
        s = load(a.data, name)
        if s is None or len(s) < 30:
            continue
        last = float(s.iloc[-1])

        def chg(days):
            past = s[s.index <= s.index[-1] - pd.Timedelta(days=days)]
            return round((last / float(past.iloc[-1]) - 1) * 100, 2) if len(past) and float(past.iloc[-1]) else None
        yr = s[s.index > s.index[-1] - pd.Timedelta(days=365)]
        ctx[name] = {"last": round(last, 4), "asOf": s.index[-1].date().isoformat(), "chg30dPct": chg(30), "chg90dPct": chg(90),
                     "chg365dPct": chg(365), "hi52w": round(float(yr.max()), 4), "lo52w": round(float(yr.min()), 4),
                     "ath": round(float(s.max()), 4), "athDate": s.idxmax().date().isoformat()}

    # halving clock: days since the last halving, and the parent-cycle date at the same distance
    halvings = [pd.Timestamp("2012-11-28"), pd.Timestamp("2016-07-09"), pd.Timestamp("2020-05-11"), pd.Timestamp("2024-04-20")]
    today = W.index[-1]
    since = (today - halvings[-1]).days
    halving_clock = {"daysSince2024Halving": since, "same distance after 2016 halving": (halvings[1] + pd.Timedelta(days=since)).date().isoformat(),
                     "same distance after 2020 halving": (halvings[2] + pd.Timedelta(days=since)).date().isoformat()}

    def brief(r):
        c = r["cfg"]
        return {"cfg": c, "score": r["score"], "fit": r["fit"], "skill": r["skill"], "nowParent": to_date(r, r["jend"]).date().isoformat(),
                "band": [to_date(r, r["band"][0]).date().isoformat(), to_date(r, r["band"][1]).date().isoformat()],
                "progress": round(progress(r, r["jend"]), 3), "proj": {f"w{h}": round(r["proj"][h - 1], 2) for h in (4, 13, 26, 52, 78)}}

    out = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "btcdLast": {"date": btcd.index[-1].date().isoformat(), "close": round(float(btcd.iloc[-1]), 2)},
        "weeklyLast": {"date": W.index[-1].date().isoformat(), "close": round(float(W.iloc[-1]), 2)},
        "settings": len(results),
        "best": brief(best),
        "spec": brief(spec_res),
        "top": [brief(r) | {"weight": round(float(ww), 4)} for r, ww in zip(top[:12], w[:12])],
        "nowParentQuantiles": {"p10": pos_q[0], "p50": pos_q[1], "p90": pos_q[2]},
        "fan": {k: [round(v, 2) for v in vs] for k, vs in fan.items()},
        "fanWeeks": {f"w{h}": {k: round(fan[k][h - 1], 2) for k in fan} for h in (4, 13, 26, 52, 78)},
        "parentStages": stages, "parentWaterfalls": wfl,
        "adversary": {"real": real, "byKind": adv_sum, "placeboChildren": advc, "cfg": adv_cfg},
        "context": ctx, "halvingClock": halving_clock,
        "elapsedSec": round(time.time() - t0, 1),
        "allSettings": [{"cfg": r["cfg"], "score": round(r["score"], 4), "r": round(r["fit"]["r"], 3), "cost": round(r["fit"]["cost"], 2),
                         "nowParent": to_date(r, r["jend"]).date().isoformat(), "bNow": round(r["fit"]["b"], 3),
                         "skill": {k: {kk: (round(vv, 3) if isinstance(vv, float) else vv) for kk, vv in v.items()} for k, v in r["skill"].items()}} for r in results],
    }
    with open(os.path.join(a.out, "results.json"), "w") as fh:
        json.dump(out, fh, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o))

    # walk-forward track for the best and the spec settings (child date -> parent date)
    def track_rows(r, cidx):
        rows = []
        for t, j, rr in r["track"]:
            rows.append({"child": cidx[t].date().isoformat(), "parent": to_date(r, j).date().isoformat(), "r": round(rr, 3)})
        return rows
    with open(os.path.join(a.out, "track.json"), "w") as fh:
        json.dump({"best": track_rows(best, cidx_best), "spec": track_rows(spec_res, cidx_spec)}, fh)

    charts(a.out, W, refpar, refidx, refwf, best, spec_res, parents, childs, window, fan, adv, real, track_rows(best, cidx_best), ctx, a.data)
    print(f"done in {time.time() - t0:.0f}s; today's parent week (weighted p10/p50/p90): {pos_q}")
    print("fan (BTC.D %):", json.dumps(out["fanWeeks"]))
    return 0


# ----------------------------------------------------------------------------------------------- charts
BLUE, ORANGE, AQUA, YELLOW, GREY = "#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#8a8984"


def _style(ax, title):
    ax.set_title(title, loc="left", fontsize=11, color="#0b0b0b")
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color("#c3c2b7")
    ax.tick_params(colors="#52514e", labelsize=8)
    ax.grid(axis="y", color="#ecebe8", linewidth=0.8)


def charts(out, W, refpar, refidx, refwf, best, spec_res, parents, childs, window, fan, adv, real, track, ctx, data_dir):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.dates as mdates
    import matplotlib.pyplot as plt

    plt.rcParams.update({"font.family": "DejaVu Sans", "figure.facecolor": "#fcfcfb", "axes.facecolor": "#fcfcfb"})

    # 1) the whole history with parent and child windows
    fig, ax = plt.subplots(figsize=(10, 3.6), dpi=140)
    ax.plot(W.index, W.values, color=GREY, lw=1.2)
    p0, p1 = pd.Timestamp(parents[spec_res["cfg"]["parent"]][0]), pd.Timestamp(parents[spec_res["cfg"]["parent"]][1])
    ax.axvspan(p0, p1, color=ORANGE, alpha=0.10)
    ax.axvspan(pd.Timestamp("2018-01-01"), W.index[-1], color=BLUE, alpha=0.07)
    ax.text(p0, W.max(), " parent 2016-2017", color="#52514e", fontsize=8, va="top")
    ax.text(pd.Timestamp("2018-02-01"), W.max(), " child 2018 to today", color="#52514e", fontsize=8, va="top")
    ax.set_ylabel("BTC.D %", color="#52514e", fontsize=8)
    _style(ax, "BTC dominance, weekly closes (TradingView CRYPTOCAP:BTC.D)")
    fig.tight_layout(); fig.savefig(os.path.join(out, "1_history.png")); plt.close(fig)

    # 2) aligned overlay for the best setting: child vs the mapped parent at the matched weeks
    for tag, r in (("best", best), ("spec", spec_res)):
        par, pidx = window(*parents[r["cfg"]["parent"]])
        ch, cidx = window(childs[r["cfg"]["child"]])
        path = np.array(r["path"])
        fb = r["fit"]["b"]
        amap = np.array(r["aPath"]); bmap = np.array(r["bPath"])
        fig, axs = plt.subplots(2, 1, figsize=(10, 6.4), dpi=140, gridspec_kw={"height_ratios": [3, 2]})
        ax = axs[0]
        ax.plot(cidx, ch, color=BLUE, lw=2, label="child: BTC.D 2018 to today")
        ax.plot(cidx, amap + bmap * par[path], color=ORANGE, lw=2, label=f"parent 2016-17 warped onto child time, mapped a(t) + b(t) x parent (b now {fb:.2f})")
        projx = [cidx[-1] + pd.Timedelta(weeks=h) for h in range(1, len(fan["p50"]) + 1)]
        if tag == "best":
            ax.fill_between(projx, fan["p10"], fan["p90"], color=BLUE, alpha=0.12, lw=0, label="projection p10-p90 (weighted ensemble)")
            ax.fill_between(projx, fan["p25"], fan["p75"], color=BLUE, alpha=0.22, lw=0)
            ax.plot(projx, fan["p50"], color=BLUE, lw=2, ls="--", label="projection median")
        else:
            ax.plot(projx, r["proj"], color=BLUE, lw=2, ls="--", label="projection (this setting)")
        ax.legend(fontsize=8, frameon=False, loc="lower left")
        ax.set_ylabel("BTC.D %", color="#52514e", fontsize=8)
        _style(ax, f"Child vs warped parent, {'best walk-forward setting' if tag == 'best' else 'docs/FRACTAL.md default setting'} (r = {r['fit']['r']:.2f})")
        ax = axs[1]
        ax.plot(cidx, pidx[path], color=ORANGE, lw=2)
        b0, b1 = r["band"]
        ax.axhspan(pidx[b0], pidx[min(b1, len(pidx) - 1)], color=ORANGE, alpha=0.12)
        ax.set_ylabel("matched parent date", color="#52514e", fontsize=8)
        ax.yaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
        for s, e in refwf:
            ax.axhspan(refidx[s], refidx[e], color=GREY, alpha=0.10)
        _style(ax, "Time warp: parent week matched by each child week (grey: waterfalls; band: today's range)")
        fig.tight_layout(); fig.savefig(os.path.join(out, f"2_overlay_{tag}.png")); plt.close(fig)

    # 2b) the dynamic factor: how the level map evolved along the child (best setting)
    if best.get("bPath"):
        ch, cidx = window(childs[best["cfg"]["child"]])
        fig, axs = plt.subplots(1, 2, figsize=(10, 3.2), dpi=140)
        axs[0].plot(cidx, best["bPath"], color=BLUE, lw=2)
        _style(axs[0], "Scale b(t): child points per parent point")
        axs[1].plot(cidx, best["aPath"], color=BLUE, lw=2)
        _style(axs[1], "Offset a(t), BTC.D points")
        fig.tight_layout(); fig.savefig(os.path.join(out, "2b_dynamic_factor.png")); plt.close(fig)

    # 3) parent with its stages and today's position band
    fig, ax = plt.subplots(figsize=(10, 3.6), dpi=140)
    ax.plot(refidx, refpar, color=ORANGE, lw=2)
    for s, e in refwf:
        ax.axvspan(refidx[s], refidx[e], color=GREY, alpha=0.12)
    _, pidx = window(*parents[best["cfg"]["parent"]])
    b0, b1 = best["band"]
    ax.axvspan(pidx[b0], pidx[min(b1, len(pidx) - 1)], color=BLUE, alpha=0.15)
    ax.axvline(pidx[best["jend"]], color=BLUE, lw=2)
    ax.text(pidx[best["jend"]], refpar.max(), " today (best setting)", color="#52514e", fontsize=8, va="top")
    ax.set_ylabel("BTC.D %", color="#52514e", fontsize=8)
    _style(ax, "Where today sits on the 2016-2017 parent (grey: waterfalls; blue band: near-optimal range)")
    fig.tight_layout(); fig.savefig(os.path.join(out, "3_parent_position.png")); plt.close(fig)

    # 4) adversary: out-of-sample score of the real parent against placebo parents
    fig, ax = plt.subplots(figsize=(10, 3.6), dpi=140)
    groups = {}
    for x in adv:
        k = x["kind"] if x["kind"] in ("iaaft", "block8", "walk", "reversed") else ("offset" if x["kind"].startswith("offset") else "other BTC.D windows")
        groups.setdefault(k, []).append(x["score"])
    names = list(groups)
    for i, k in enumerate(names):
        ys = groups[k]
        xs = np.full(len(ys), i) + np.random.default_rng(i).uniform(-0.18, 0.18, len(ys))
        ax.scatter(xs, ys, s=14, color=GREY, alpha=0.7)
    ax.axhline(real["score"], color=BLUE, lw=2)
    ax.text(len(names) - 0.5, real["score"], " real parent", color="#52514e", fontsize=8, va="bottom", ha="right")
    ax.axhline(1.0, color="#c3c2b7", lw=1, ls=":")
    ax.text(-0.4, 1.0, "no-change baseline", color="#52514e", fontsize=8, va="bottom")
    ax.set_xticks(range(len(names)), names)
    ax.set_ylabel("walk-forward error / no-change (lower = better)", color="#52514e", fontsize=8)
    _style(ax, "Adversary: does the real 2016-17 parent forecast better than placebo parents?")
    fig.tight_layout(); fig.savefig(os.path.join(out, "4_adversary.png")); plt.close(fig)

    # 5) walk-forward track: the matched parent date as the child advanced
    fig, ax = plt.subplots(figsize=(10, 3.6), dpi=140)
    xs = [pd.Timestamp(t["child"]) for t in track]
    ys = [pd.Timestamp(t["parent"]) for t in track]
    ax.plot(xs, ys, color=BLUE, lw=2, marker="o", ms=3)
    for s, e in refwf:
        ax.axhspan(refidx[s], refidx[e], color=GREY, alpha=0.10)
    ax.yaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    ax.set_ylabel("parent date matched then", color="#52514e", fontsize=8)
    _style(ax, "Walk forward: where the fractal placed 'now' at each past date (data known then only)")
    fig.tight_layout(); fig.savefig(os.path.join(out, "5_walkforward_track.png")); plt.close(fig)

    # 6) context: BTC.D, USDT.D, ETHBTC, DXY indexed small multiples (last 3 years)
    names = [n for n in ("BTC.D", "USDT.D", "OTHERS.D", "ETHBTC", "DXY", "US10Y") if n in ctx]
    if names:
        fig, axs = plt.subplots(2, 3, figsize=(10, 5), dpi=140)
        for ax, n in zip(axs.flat, names):
            s = load(data_dir, n)
            s = s[s.index > s.index[-1] - pd.Timedelta(days=3 * 365)]
            ax.plot(s.index, s.values, color=BLUE, lw=1.4)
            ax.xaxis.set_major_formatter(mdates.DateFormatter("%y"))
            _style(ax, n)
        for ax in list(axs.flat)[len(names):]:
            ax.axis("off")
        fig.tight_layout(); fig.savefig(os.path.join(out, "6_context.png")); plt.close(fig)


if __name__ == "__main__":
    sys.exit(main())

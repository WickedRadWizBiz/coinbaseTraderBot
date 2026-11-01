#!/usr/bin/env python3
"""BTC.D fractal, round 5: model the time-dilation factor itself, and test it on the 2021 waterfall out of sample.

Round 3 measured the dilation (child weeks per parent week) stage by stage and found no law that beat placebos.
This round asks what drives it, and whether a driver would have timed the 2021 waterfall in advance.

A. Dilation series: along the reference warp (logit, fixed map, shape 3, and three sibling settings), the local
   dilation by child week (26-week trailing and leading windows).
B. Drivers: log leading-26w dilation against halving phase (weeks since the last halving), M2 year-on-year, BTC
   distance from its high, BTC 13-week return, and BTC.D's own activity (|26-week change|, the trivial one). Rank
   correlation, with the driver circularly shifted 26+ weeks (400 times) as the null.
C. Out of sample, the 2021 waterfall: at every 4th week from Jan 2019 to Dec 2020, each model predicts the child date
   at which the warp reaches the parent's first waterfall (26 Mar 2017). Point in time: the warp, the dilation and
   the drivers use only data up to that week. Models:
     overall   parent weeks left x the dilation since 2018;
     local     parent weeks left x the last 26 weeks' dilation;
     driver    a regression of log dilation on the drivers, fitted on the point-in-time warp, drivers held at
               their last value;
     halving   the cycle clock: the child's halving + the parent's weeks from its own halving (9 Jul 2016) to the
               pivot, at 1x. Known years ahead.
   Scored against the date the final warp crossed the pivot and against BTC.D's actual top (3 Jan 2021).
D. The halving clock's adversary: the same "halving + parent offset" rule from 400 random anchor dates; how often a
   random anchor lands as close to the real BTC.D falls (5+ points, round 4's list) as the real halvings do.
E. Now: each model's reading for the parent's final waterfall (10 Dec 2017).
"""
import argparse
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from study import fit, load, weekly  # noqa: E402
from study2 import fwd  # noqa: E402
from study3 import stages_of  # noqa: E402
import study4  # noqa: E402

HALVINGS = [pd.Timestamp(x) for x in ["2012-11-28", "2016-07-09", "2020-05-11", "2024-04-20", "2028-04-15"]]
PARENT_HALVING = pd.Timestamp("2016-07-09")
PIVOTS = {"first waterfall": "2017-03-26", "second waterfall": "2017-07-09", "final waterfall": "2017-12-10"}


def spearman(a, b):
    m = np.isfinite(a) & np.isfinite(b)
    if m.sum() < 20:
        return None
    return float(pd.Series(a[m]).rank().corr(pd.Series(b[m]).rank()))


def local_dil(path, L=26, lead=False):
    n = len(path)
    out = np.full(n, np.nan)
    for i in range(n):
        if lead:
            if i + L < n:
                out[i] = L / max(path[i + L] - path[i], 0.5)
        elif i >= L:
            out[i] = L / max(path[i] - path[i - L], 0.5)
    return out


def drivers(data, idx):
    F, b, _ = study4.features(data)
    F = F.reindex(idx).ffill()
    b = b.reindex(idx).ffill()
    D = pd.DataFrame(index=idx)
    D["halving_weeks"] = [min((t - h).days for h in HALVINGS if h <= t) / 7 for t in idx]
    D["m2_yoy"] = F["m2_yoy"]
    D["btc_dd"] = F["btc_dd"]
    D["btc_13w"] = F["btc_13w"]
    D["btcd_activity"] = (b - b.shift(26)).abs()
    return D


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--nulls", type=int, default=400)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    rng = np.random.default_rng(5)
    W = weekly(load(a.data, "BTC.D"))
    px = W[(W.index >= pd.Timestamp("2016-01-01")) & (W.index < pd.Timestamp("2018-03-01"))]
    cx = W[W.index >= pd.Timestamp("2018-01-01")]
    parent, child = px.values.astype(float), cx.values.astype(float)
    pidx, cidx = px.index, cx.index
    pw = {k: int(np.searchsorted(pidx, pd.Timestamp(v))) for k, v in PIVOTS.items()}
    p_halv = int(np.searchsorted(pidx, PARENT_HALVING))
    base = {"maxstep": 2, "cap": 16, "j0": 0.15, "shapew": 8, "wfweeks": 13, "res": "W", "space": "logit", "bmin": 0.1, "bmax": 5.0}
    cfgs = [dict(base, dynmap=0, bw=0, wshape=3.0), dict(base, dynmap=0, bw=0, wshape=1.0), dict(base, dynmap=2, bw=104, wshape=3.0), dict(base, dynmap=2, bw=104, wshape=1.0)]
    c, p = fwd(child, "logit"), fwd(parent, "logit")
    D = drivers(a.data, cidx)
    res = {"pivots": PIVOTS, "settings": []}

    # A + B
    for cfg in cfgs:
        f = fit(c, p, cfg)
        path = f["path"]
        lead = np.log(local_dil(path, 26, lead=True))
        row = {"cfg": f"dyn{cfg['dynmap']} wsh{cfg['wshape']}", "now": str(pidx[path[-1]].date()),
               "crossed": {k: (str(cidx[np.where(path >= v)[0][0]].date()) if (path >= v).any() else None) for k, v in pw.items()}}
        cor = {}
        for col in D.columns:
            x = D[col].values.astype(float)
            r = spearman(x, lead)
            nul = []
            for _ in range(a.nulls):
                k = int(rng.integers(26, len(x) - 26))
                v = spearman(np.roll(x, k), lead)
                nul.append(abs(v) if v is not None else 0)
            cor[col] = {"r": None if r is None else round(r, 3), "p": round(float((np.array(nul) >= abs(r or 0)).mean()), 3)}
        row["driverCorr"] = cor
        if cfg is cfgs[0]:
            ref_path = path
            res["dilSeries"] = [{"t": str(cidx[i].date()), "lead26": None if np.isnan(lead[i]) else round(float(np.exp(lead[i])), 2)} for i in range(0, len(path), 4)]
        res["settings"].append(row)

    # C: the 2021 waterfall out of sample (reference setting)
    cfg = cfgs[0]
    actual_cross = int(np.where(ref_path >= pw["first waterfall"])[0][0])
    actual_top = int(np.searchsorted(cidx, pd.Timestamp("2021-01-03")))
    preds = []
    t0, t1 = int(np.searchsorted(cidx, pd.Timestamp("2019-01-06"))), int(np.searchsorted(cidx, pd.Timestamp("2020-12-27")))
    for t in range(t0, t1 + 1, 4):
        g = fit(c[: t + 1], p, cfg, iters=3)
        j, gp = g["jend"], g["path"]
        row = {"t": str(cidx[t].date()), "now": str(pidx[j].date())}
        left = pw["first waterfall"] - j
        if left <= 0:
            row["note"] = "already past the pivot"
            preds.append(row)
            continue
        ld = local_dil(gp, 26)
        row["overall"] = t + left * g["dil"]
        row["local"] = t + left * (ld[-1] if np.isfinite(ld[-1]) else g["dil"])
        # driver regression on the point-in-time warp: log trailing dilation ~ drivers (known then)
        y = np.log(ld)
        X = D.iloc[: t + 1][["halving_weeks", "m2_yoy", "btc_dd", "btc_13w"]].values.astype(float)
        m = np.isfinite(y) & np.isfinite(X).all(1)
        if m.sum() > 30:
            Xm = np.c_[np.ones(m.sum()), (X[m] - X[m].mean(0)) / (X[m].std(0) + 1e-9)]
            beta = np.linalg.lstsq(Xm, y[m], rcond=None)[0]
            xl = np.r_[1.0, (X[-1] - X[m].mean(0)) / (X[m].std(0) + 1e-9)]
            row["driver"] = t + left * float(np.exp(np.clip(xl @ beta, np.log(0.5), np.log(64))))
        ch = max(h for h in HALVINGS if h <= cidx[t]) if cidx[t] >= pd.Timestamp("2020-05-11") else pd.Timestamp("2020-05-11")
        row["halving"] = int(np.searchsorted(cidx, ch + pd.Timedelta(weeks=pw["first waterfall"] - p_halv)))
        preds.append(row)
    score = {}
    for k in ["overall", "local", "driver", "halving"]:
        v = [(r[k], r["t"]) for r in preds if k in r]
        if not v:
            continue
        e_cross = np.array([x - actual_cross for x, _ in v])
        e_top = np.array([x - actual_top for x, _ in v])
        score[k] = {"n": len(v), "maeWeeksVsCross": round(float(np.mean(np.abs(e_cross))), 1), "maeWeeksVsTop": round(float(np.mean(np.abs(e_top))), 1),
                    "medianBiasVsTop": round(float(np.median(e_top)), 1),
                    "lastCallDate": str((cidx[0] + pd.Timedelta(weeks=float(v[-1][0]))).date())}
    res["oos2021"] = {"actualCross": str(cidx[actual_cross].date()), "actualTop": str(cidx[actual_top].date()), "score": score,
                      "calls": [{k: (str((cidx[0] + pd.Timedelta(weeks=float(r[k]))).date()) if k in ("overall", "local", "driver", "halving") and k in r else r.get(k))
                                 for k in ["t", "now", "overall", "local", "driver", "halving", "note"]} for r in preds]}

    # D: halving-clock adversary on all BTC.D falls of 5+ points since 2016 (round 4's medium list)
    F, b, _ = study4.features(a.data)
    ev = [pd.Timestamp(e["peak"]) for e in study4.events(b[b.index >= pd.Timestamp("2016-01-01")], 5.0)]
    offs = [pw["first waterfall"] - p_halv, pw["second waterfall"] - p_halv, pw["final waterfall"] - p_halv]

    def hits(anchors):
        calls = [h + pd.Timedelta(weeks=o) for h in anchors for o in offs]
        calls = [x for x in calls if pd.Timestamp("2018-01-01") <= x <= b.index[-1]]
        if not calls:
            return None, 0
        err = [min(abs((x - e).days) for e in ev) / 7 for x in calls]
        return float(np.mean(err)), len(calls)
    real_err, ncalls = hits([pd.Timestamp("2016-07-09"), pd.Timestamp("2020-05-11"), pd.Timestamp("2024-04-20")])
    null = []
    for _ in range(a.nulls):
        a1 = pd.Timestamp("2016-05-11") + pd.Timedelta(days=int(rng.integers(0, 1441)))
        e, _ = hits([a1, a1 + pd.Timedelta(days=1441), a1 + pd.Timedelta(days=2882)])
        if e is not None:
            null.append(e)
    # one-event check: how often does a random anchor's first-waterfall call land as close to the 2021 top as the real halving did
    top = pd.Timestamp("2021-01-03")
    real_gap = abs((pd.Timestamp("2020-05-11") + pd.Timedelta(weeks=offs[0]) - top).days) / 7
    gaps = [abs((pd.Timestamp("2016-05-11") + pd.Timedelta(days=int(rng.integers(0, 1441))) + pd.Timedelta(weeks=offs[0]) + pd.Timedelta(days=1441) - top).days) / 7 for _ in range(4000)]
    res["halving2021"] = {"realGapWeeks": round(real_gap, 1), "p": round(float((np.array(gaps) <= real_gap).mean()), 3)}
    res["halvingClock"] = {"offsetsWeeks": offs, "events": [str(e.date()) for e in ev], "realMeanWeeksToNearestFall": round(real_err, 1), "calls": ncalls,
                           "randomAnchorMedian": round(float(np.median(null)), 1), "p": round(float((np.array(null) <= real_err).mean()), 3),
                           "callDates": [str((h + pd.Timedelta(weeks=o)).date()) for h in HALVINGS[2:] for o in offs]}

    # E: now
    t = len(c) - 1
    ld = local_dil(ref_path, 26)
    res["now"] = {"parentWeek": str(pidx[ref_path[-1]].date()), "finalWaterfallCrossed": res["settings"][0]["crossed"]["final waterfall"],
                  "localDil": round(float(ld[-1]), 1), "halvingClockNext": [str((HALVINGS[4] + pd.Timedelta(weeks=o)).date()) for o in offs]}
    with open(os.path.join(a.out, "results5.json"), "w") as fh:
        json.dump(res, fh, indent=1, default=str)
    for s in res["settings"]:
        print(s["cfg"], "now", s["now"], "crossed", s["crossed"])
        for k, v in s["driverCorr"].items():
            print(f"   {k:15s} r {v['r']} p {v['p']}")
    print("2021 out of sample:", json.dumps(res["oos2021"]["score"]))
    for r in res["oos2021"]["calls"]:
        print("  ", r)
    print("halving clock:", json.dumps(res["halvingClock"]))
    print("halving 2021 one-event:", json.dumps(res["halving2021"]))
    print("now:", json.dumps(res["now"]))


if __name__ == "__main__":
    main()

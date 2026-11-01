#!/usr/bin/env python3
"""BTC.D fractal study, round 2 (the second pass on the parent mapping, 2026-11-01).

Round 1 (study.py) placed today at the parent's Dec 2017 top and found the walk-forward pinned there since
early 2023, with no timing edge. Round 2 asks why, and whether a finer mapping fixes it:

  A. Resolution: the parent at weekly or 3-day bars (Dec 2017's internal structure: the Nov 12 -> Dec 10 rally,
     the top, the first leg down), the child weekly.
  B. Scale: raw dominance, log, or logit (dominance is a share: logit treats 90 -> 95 like 50 -> 70).
  C. Other parents under the same machinery: 2014-16 against the 2018-now child; the 2019-21 swing (peak to
     waterfall) against the 2021-now child (the child's own smaller cycle).
  D. A fair adversary: every placebo parent gets the same small search over settings (best of K) that the real
     parent gets, on both the forecast score and the move-size correlation (IC).
  E. When the move-size signal works: walk-forward points split by projected move size, fit quality, whether
     the match sits in a parent waterfall, and the stablecoin trend (USDT.D).

  python3 research/btcd_fractal/study2.py --data research/btcd_fractal/data --out research/btcd_fractal/out2
"""
import argparse
import itertools
import json
import math
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from study import block_shuffle, fit, iaaft, load, matched_walk, project, waterfalls, weekly  # noqa: E402

HORIZONS = (13, 26, 52)


def fwd(x, space):
    if space == "log":
        return np.log(np.clip(x, 0.1, None))
    if space == "logit":
        p = np.clip(x / 100.0, 0.005, 0.995)
        return np.log(p / (1 - p))
    return x.astype(float)


def inv(y, space):
    if space == "log":
        return np.exp(y)
    if space == "logit":
        return 100.0 / (1.0 + np.exp(-y))
    return y


def evaluate2(child_raw, parent_raw, cfg, step=4, start=52, H=78, want=True):
    """Fit in the chosen space; walk forward; errors in raw BTC.D points. Returns skill and per-point records."""
    sp = cfg["space"]
    child = fwd(child_raw, sp)
    parent = fwd(parent_raw, sp)
    wf, _ = waterfalls(parent_raw)
    inwf = np.zeros(len(parent_raw), dtype=bool)
    for s, e in wf:
        inwf[max(0, s - cfg.get("wflead", 0)): e + 1] = True
    n = len(child)
    f = fit(child, parent, cfg)
    res = {"cfg": cfg, "jend": f["jend"], "fit": {"r": f["r"], "recentR": f["recentR"], "cost": f["cost"], "b": f["b"], "dil": f["dil"], "rdil": f["rdil"]},
           "band": [int(f["band"].min()), int(f["band"].max())] if len(f["band"]) else [f["jend"], f["jend"]]}
    if want:
        p, _, _ = project(child, parent, f, cfg, H, wf)
        res["proj"] = inv(p, sp).tolist()
        res["path"] = f["path"].tolist()
        res["bandAll"] = f["band"].tolist()
        bp = []
        for jb in f["band"][:: max(1, len(f["band"]) // 6)]:
            g = dict(f)
            g["jend"] = int(jb)
            bp.append(inv(project(child, parent, g, cfg, H, wf)[0], sp).tolist())
        res["bandProj"] = bp
    pts = []
    for t in range(start, n, step):
        g = fit(child[: t + 1], parent, cfg, iters=3)
        pr, _, _ = project(child[: t + 1], parent, g, cfg, max(HORIZONS), wf)
        prr = inv(pr, sp)
        rec = {"t": t, "j": g["jend"], "recentR": g["recentR"], "inWf": bool(inwf[g["jend"]])}
        for h in HORIZONS:
            if t + h < n:
                rec[f"p{h}"] = float(prr[h - 1] - child_raw[t])
                rec[f"a{h}"] = float(child_raw[t + h] - child_raw[t])
        pts.append(rec)
    res["pts"] = pts
    res["skill"] = skill(pts)
    res["score"] = float(np.mean([res["skill"][k]["ratio"] for k in res["skill"]])) if res["skill"] else 9.0
    return res


def skill(pts, horizons=HORIZONS):
    out = {}
    for h in horizons:
        P = np.array([p[f"p{h}"] for p in pts if f"a{h}" in p])
        A = np.array([p[f"a{h}"] for p in pts if f"a{h}" in p])
        if len(P) < 4:
            continue
        m = np.abs(A) > 0.5
        out[f"h{h}"] = {"n": int(len(P)), "mae": float(np.mean(np.abs(P - A))), "maeFlat": float(np.mean(np.abs(A))),
                        "ratio": float(np.mean(np.abs(P - A)) / max(np.mean(np.abs(A)), 1e-9)),
                        "hit": float(np.mean(np.sign(P[m]) == np.sign(A[m]))) if m.any() else None,
                        "ic": float(np.corrcoef(P, A)[0, 1]) if np.std(P) > 1e-9 and np.std(A) > 1e-9 else 0.0}
    return out


# ------------------------------------------------------------------------------------------------ workers
_G = {}


def _init(G):
    _G.update(G)


def _job(args):
    tag, cfg = args
    ch = _G["childs"][cfg["child"]]
    par = _G["parents"][(cfg["parent"], cfg["res"])]
    r = evaluate2(ch, par, cfg)
    r["tag"] = tag
    return r


def _placebo(args):
    kind, par, cfgs = args
    ch = _G["childs"][cfgs[0]["child"]]
    best_s, best_ic, best_hit = 9e9, -9.0, 0.0
    for c in cfgs:
        r = evaluate2(ch, par, c, step=8, want=False)
        s26 = r["skill"].get("h26", {})
        best_s = min(best_s, r["score"])
        best_ic = max(best_ic, s26.get("ic") or -9.0)
        best_hit = max(best_hit, s26.get("hit") or 0.0)
    return {"kind": kind, "bestScore": best_s, "bestIc": best_ic, "bestHit": best_hit}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--placebos", type=int, default=30, help="per placebo kind")
    ap.add_argument("--k", type=int, default=6, help="settings each placebo may search (best of K)")
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 2)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    t0 = time.time()
    btcd = load(a.data, "BTC.D")
    W = weekly(btcd)
    D3 = btcd.resample("3D").last().dropna()
    usdt = load(a.data, "USDT.D")
    print(f"BTC.D {btcd.index[0].date()}..{btcd.index[-1].date()}, weekly {len(W)}")

    def win(s, fr, to=None):
        x = s[(s.index >= pd.Timestamp(fr)) & ((s.index < pd.Timestamp(to)) if to else True)]
        return x

    PARENTS = {"2016-01..2018-01-15": ("2016-01-01", "2018-01-15"), "2016-01..2018-03": ("2016-01-01", "2018-03-01"),
               "2014-04..2016-07": ("2014-04-01", "2016-07-01"), "2019-06..2021-07": ("2019-06-01", "2021-07-20")}
    CHILDS = {"2018-01-01": "2018-01-01", "2021-07-20": "2021-07-20"}
    parents, pidx = {}, {}
    for k, (fr, to) in PARENTS.items():
        for res, s in (("W", W), ("3D", D3)):
            x = win(s, fr, to)
            parents[(k, res)] = x.values.astype(float)
            pidx[(k, res)] = x.index
    childs = {k: win(W, v).values.astype(float) for k, v in CHILDS.items()}
    cidx = {k: win(W, v).index for k, v in CHILDS.items()}

    base = {"maxstep": 2, "cap": 16, "j0": 0.15, "shapew": 8, "wfweeks": 13, "wshape": 1.0, "dynmap": 0, "bw": 0}
    jobs = []
    # A + B on the spec parent family (child 2018)
    for pk, res, sp, (dm, bw), wsh in itertools.product(["2016-01..2018-01-15", "2016-01..2018-03"], ["W", "3D"], ["raw", "log", "logit"],
                                                       [(0, 0), (2, 52), (2, 104)], [1.0, 3.0]):
        c = dict(base, parent=pk, child="2018-01-01", res=res, space=sp, dynmap=dm, bw=bw, wshape=wsh)
        if res == "3D":
            c.update(cap=32, maxstep=4, kmax=40)
        c["bmin"], c["bmax"] = (0.35, 2.5) if sp == "raw" else (0.1, 5.0)
        jobs.append(("main", c))
    # C: other parents
    for pk, ck in (("2014-04..2016-07", "2018-01-01"), ("2019-06..2021-07", "2021-07-20")):
        for sp, (dm, bw), wsh in itertools.product(["raw", "logit"], [(0, 0), (2, 52), (2, 104)], [1.0, 3.0]):
            c = dict(base, parent=pk, child=ck, res="W", space=sp, dynmap=dm, bw=bw, wshape=wsh)
            if ck == "2021-07-20":
                c.update(j0=0.30)
            c["bmin"], c["bmax"] = (0.35, 2.5) if sp == "raw" else (0.1, 5.0)
            jobs.append(("alt:" + pk, c))
    G = {"childs": childs, "parents": parents}
    with ProcessPoolExecutor(a.workers, initializer=_init, initargs=(G,)) as ex:
        results = list(ex.map(_job, jobs))
    print(f"{len(results)} settings in {time.time() - t0:.0f}s")

    def label(r):
        c = r["cfg"]
        return f"{c['parent']} {c['res']} {c['space']} dyn{c['dynmap']}/{c['bw']} wsh{c['wshape']}"

    def nowdate(r, j=None):
        ix = pidx[(r["cfg"]["parent"], r["cfg"]["res"])]
        return ix[min(r["jend"] if j is None else j, len(ix) - 1)].date().isoformat()

    def ic26(r):
        return r["skill"].get("h26", {}).get("ic") or -9

    # summaries by factor
    summ = {}
    for key in ("res", "space", "dynmap"):
        for v in sorted({str(r["cfg"][key]) for r in results if r["tag"] == "main"}):
            rs = [r for r in results if r["tag"] == "main" and str(r["cfg"][key]) == v]
            summ[f"{key}={v}"] = {"n": len(rs), "bestScore": round(min(r["score"] for r in rs), 3), "medianScore": round(float(np.median([r["score"] for r in rs])), 3),
                                  "bestIc26": round(max(ic26(r) for r in rs), 3), "medianIc26": round(float(np.median([ic26(r) for r in rs])), 3),
                                  "bestHit26": round(max((r["skill"].get("h26", {}).get("hit") or 0) for r in rs), 3)}
    for tag in sorted({r["tag"] for r in results}):
        rs = [r for r in results if r["tag"] == tag]
        summ[tag] = {"n": len(rs), "bestScore": round(min(r["score"] for r in rs), 3), "medianScore": round(float(np.median([r["score"] for r in rs])), 3),
                     "bestIc26": round(max(ic26(r) for r in rs), 3), "medianIc26": round(float(np.median([ic26(r) for r in rs])), 3),
                     "bestHit26": round(max((r["skill"].get("h26", {}).get("hit") or 0) for r in rs), 3)}
    for k, v in summ.items():
        print(f"  {k:28s} {v}")

    main_rs = sorted([r for r in results if r["tag"] == "main"], key=lambda r: r["score"])
    print("best by score:")
    for r in main_rs[:5]:
        print(f"  {r['score']:.3f} ic26 {ic26(r):.2f} now {nowdate(r)} | {label(r)}")
    by_ic = sorted([r for r in results if r["tag"] == "main"], key=lambda r: -ic26(r))
    print("best by ic26:")
    for r in by_ic[:5]:
        print(f"  ic26 {ic26(r):.2f} hit {r['skill'].get('h26', {}).get('hit')} score {r['score']:.3f} now {nowdate(r)} | {label(r)}")

    # the walk-forward track at 3-day resolution: does 'now' move inside Dec 2017?
    tracks = {}
    for nm, r in (("bestScore", main_rs[0]), ("bestIc", by_ic[0]), ("best3D", min([x for x in main_rs if x["cfg"]["res"] == "3D"], key=lambda x: x["score"]))):
        ix = pidx[(r["cfg"]["parent"], r["cfg"]["res"])]
        tracks[nm] = {"label": label(r), "rows": [{"child": cidx[r["cfg"]["child"]][p["t"]].date().isoformat(), "parent": ix[min(p["j"], len(ix) - 1)].date().isoformat()} for p in r["pts"]]}
        last = tracks[nm]["rows"][-12:]
        print(f"track {nm} ({label(r)}) last 12 (child->parent): " + ", ".join(f"{x['child'][:7]}->{x['parent']}" for x in last))

    # E: when does the move-size signal work? (the best-IC setting and the best 3-day setting)
    cw = cidx["2018-01-01"]
    uw = weekly(usdt) if usdt is not None else None

    def usdt_trend(t):
        if uw is None:
            return None
        d = cw[t]
        x = uw[uw.index <= d]
        if len(x) < 14:
            return None
        return float(x.iloc[-1] / x.iloc[-14] - 1)

    cond = {}
    for nm, r in (("bestIc", by_ic[0]), ("bestScore", main_rs[0])):
        pts = r["pts"]
        if r["cfg"]["child"] != "2018-01-01":
            continue
        for p in pts:
            p["usdt13"] = usdt_trend(p["t"])
        groups = {
            "all": pts,
            "|proj26| >= 3 pts": [p for p in pts if abs(p.get("p26", 0)) >= 3],
            "|proj26| >= 6 pts": [p for p in pts if abs(p.get("p26", 0)) >= 6],
            "|proj26| < 3 pts": [p for p in pts if abs(p.get("p26", 0)) < 3],
            "recent fit r >= 0.5": [p for p in pts if p["recentR"] >= 0.5],
            "recent fit r < 0.5": [p for p in pts if p["recentR"] < 0.5],
            "match inside a parent waterfall": [p for p in pts if p["inWf"]],
            "match outside": [p for p in pts if not p["inWf"]],
            "USDT.D falling (13w)": [p for p in pts if p["usdt13"] is not None and p["usdt13"] < 0],
            "USDT.D rising (13w)": [p for p in pts if p["usdt13"] is not None and p["usdt13"] >= 0],
            "projects a fall, USDT.D falling": [p for p in pts if p.get("p26", 0) < 0 and p["usdt13"] is not None and p["usdt13"] < 0],
            "projects a fall, USDT.D rising": [p for p in pts if p.get("p26", 0) < 0 and p["usdt13"] is not None and p["usdt13"] >= 0],
        }
        cond[nm] = {"label": label(r)}
        for g, ps in groups.items():
            sk = skill(ps, (26,))
            if "h26" in sk:
                cond[nm][g] = {k: (round(v, 3) if isinstance(v, float) else v) for k, v in sk["h26"].items()}
        print(f"conditions ({nm}: {label(r)}):")
        for g, v in cond[nm].items():
            if g != "label":
                print(f"  {g:34s} n {v['n']:3d} ratio {v['ratio']:.2f} hit {v['hit']} ic {v['ic']:.2f}")

    # D: fair adversary. The real parent's best of K settings vs each placebo's best of the same K.
    fam = sorted([r for r in results if r["tag"] == "main" and r["cfg"]["parent"] == "2016-01..2018-01-15" and r["cfg"]["res"] == "W"], key=lambda r: -ic26(r))[: a.k]
    fam_cfgs = [r["cfg"] for r in fam]
    real_par = parents[("2016-01..2018-01-15", "W")]
    real = {"bestScore": min(r["score"] for r in fam), "bestIc": max(ic26(r) for r in fam),
            "bestHit": max((r["skill"].get("h26", {}).get("hit") or 0) for r in fam)}
    rng = np.random.default_rng(20261102)
    pj = []
    for i in range(a.placebos):
        pj.append(("iaaft", iaaft(real_par, rng), fam_cfgs))
        pj.append(("block8", block_shuffle(real_par, rng), fam_cfgs))
        pj.append(("walk", matched_walk(real_par, rng), fam_cfgs))
    L = len(real_par)
    early = W[W.index < pd.Timestamp("2015-11-01")]
    for s0 in range(0, max(0, len(early) - L) + 1, 4):
        seg = early.values[s0:s0 + L].astype(float)
        if len(seg) == L:
            pj.append(("otherBTCD", seg, fam_cfgs))
    with ProcessPoolExecutor(a.workers, initializer=_init, initargs=(G,)) as ex:
        adv = list(ex.map(_placebo, pj))
    # the real parent's family re-scored at the placebo step (8) so the comparison is like for like
    with ProcessPoolExecutor(a.workers, initializer=_init, initargs=(G,)) as ex:
        realK = list(ex.map(_placebo, [("real", real_par, fam_cfgs)]))[0]
    fair = {"family": [label(r) for r in fam], "real": realK, "byKind": {}}
    print(f"fair adversary, best of {len(fam_cfgs)} (real: score {realK['bestScore']:.3f}, ic26 {realK['bestIc']:.3f}, hit26 {realK['bestHit']:.3f}):")
    for kind in sorted({x["kind"] for x in adv}):
        xs = [x for x in adv if x["kind"] == kind]
        s = np.array([x["bestScore"] for x in xs])
        ic = np.array([x["bestIc"] for x in xs])
        ht = np.array([x["bestHit"] for x in xs])
        fair["byKind"][kind] = {"n": len(xs), "pScore": float((np.sum(s <= realK["bestScore"]) + 1) / (len(s) + 1)),
                                "pIc": float((np.sum(ic >= realK["bestIc"]) + 1) / (len(ic) + 1)),
                                "pHit": float((np.sum(ht >= realK["bestHit"]) + 1) / (len(ht) + 1)),
                                "medScore": float(np.median(s)), "medIc": float(np.median(ic)), "medHit": float(np.median(ht))}
        v = fair["byKind"][kind]
        print(f"  {kind:10s} n {v['n']:3d} score med {v['medScore']:.3f} p {v['pScore']:.3f} | ic med {v['medIc']:.3f} p {v['pIc']:.3f} | hit med {v['medHit']:.3f} p {v['pHit']:.3f}")

    # position quantiles (main family, weighted by score), in parent dates
    top = main_rs[: max(8, len(main_rs) // 3)]
    w = np.exp(-(np.array([r["score"] for r in top]) - top[0]["score"]) / 0.05)
    vals, ws = [], []
    for r, ww in zip(top, w):
        for j in r["bandAll"]:
            vals.append(pd.Timestamp(nowdate(r, j)).value)
            ws.append(ww / len(r["bandAll"]))
    o = np.argsort(vals)
    cv = np.cumsum(np.array(ws)[o]) / np.sum(ws)
    q = [pd.Timestamp(int(np.array(vals)[o][min(np.searchsorted(cv, x), len(vals) - 1)])).date().isoformat() for x in (0.1, 0.5, 0.9)]
    print(f"today's parent date p10/p50/p90 (round 2 main family): {q}")
    alt = {}
    for tag in ("alt:2014-04..2016-07", "alt:2019-06..2021-07"):
        rs = sorted([r for r in results if r["tag"] == tag], key=lambda r: r["score"])
        if rs:
            alt[tag] = {"best": {"label": label(rs[0]), "score": rs[0]["score"], "skill": rs[0]["skill"], "now": nowdate(rs[0]),
                                 "proj": {f"w{h}": round(rs[0]["proj"][h - 1], 2) for h in (13, 26, 52, 78)}},
                        "bestIc": {"label": label(max(rs, key=ic26)), "ic26": ic26(max(rs, key=ic26)), "now": nowdate(max(rs, key=ic26))}}
            print(f"{tag}: best {alt[tag]['best']['label']} score {rs[0]['score']:.3f} now {alt[tag]['best']['now']} proj {alt[tag]['best']['proj']}")

    out = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "btcdLast": round(float(btcd.iloc[-1]), 2),
           "summary": summ, "bestScore": {"label": label(main_rs[0]), "score": main_rs[0]["score"], "skill": main_rs[0]["skill"], "now": nowdate(main_rs[0]),
                                           "band": [nowdate(main_rs[0], main_rs[0]["band"][0]), nowdate(main_rs[0], main_rs[0]["band"][1])],
                                           "proj": {f"w{h}": round(main_rs[0]["proj"][h - 1], 2) for h in (4, 13, 26, 52, 78)}},
           "bestIc": {"label": label(by_ic[0]), "score": by_ic[0]["score"], "skill": by_ic[0]["skill"], "now": nowdate(by_ic[0]),
                      "proj": {f"w{h}": round(by_ic[0]["proj"][h - 1], 2) for h in (4, 13, 26, 52, 78)}},
           "nowQuantiles": q, "tracks": tracks, "conditions": cond, "fairAdversary": fair, "altParents": alt,
           "all": [{"label": label(r), "tag": r["tag"], "score": round(r["score"], 3), "ic26": round(ic26(r), 3), "hit26": r["skill"].get("h26", {}).get("hit"), "now": nowdate(r), "r": round(r["fit"]["r"], 3)} for r in results],
           "elapsedSec": round(time.time() - t0)}
    with open(os.path.join(a.out, "results2.json"), "w") as fh:
        json.dump(out, fh, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o))
    charts(a.out, tracks, pidx, parents, main_rs, by_ic, cidx, childs, label, adv, realK, cond)
    print(f"done in {time.time() - t0:.0f}s")
    return 0


BLUE, ORANGE, GREY = "#2a78d6", "#eb6834", "#8a8984"


def _style(ax, title):
    ax.set_title(title, loc="left", fontsize=11, color="#0b0b0b")
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color("#c3c2b7")
    ax.tick_params(colors="#52514e", labelsize=8)
    ax.grid(axis="y", color="#ecebe8", linewidth=0.8)


def charts(out, tracks, pidx, parents, main_rs, by_ic, cidx, childs, label, adv, realK, cond):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.dates as mdates
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "DejaVu Sans", "figure.facecolor": "#fcfcfb", "axes.facecolor": "#fcfcfb"})

    # 1) walk-forward tracks: weekly best vs 3-day best
    fig, ax = plt.subplots(figsize=(10, 3.8), dpi=140)
    for nm, col in (("bestScore", GREY), ("best3D", BLUE), ("bestIc", ORANGE)):
        t = tracks[nm]
        ax.plot([pd.Timestamp(x["child"]) for x in t["rows"]], [pd.Timestamp(x["parent"]) for x in t["rows"]], color=col, lw=1.8, label=f"{nm}: {t['label']}")
    ax.yaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    ax.legend(fontsize=7, frameon=False, loc="upper left")
    ax.set_ylabel("parent date matched then", color="#52514e", fontsize=8)
    _style(ax, "Walk forward, round 2: where 'now' sat on the parent at each past date")
    fig.tight_layout(); fig.savefig(os.path.join(out, "r2_tracks.png")); plt.close(fig)

    # 2) the best 3-day setting's overlay, zoomed to the parent's late 2017
    r = min([x for x in main_rs if x["cfg"]["res"] == "3D"], key=lambda x: x["score"])
    ix = pidx[(r["cfg"]["parent"], "3D")]
    par = parents[(r["cfg"]["parent"], "3D")]
    fig, axs = plt.subplots(1, 2, figsize=(10, 3.6), dpi=140)
    sel = ix >= pd.Timestamp("2017-07-01")
    axs[0].plot(ix[sel], par[sel], color=ORANGE, lw=1.8)
    b0, b1 = r["band"]
    axs[0].axvspan(ix[b0], ix[min(b1, len(ix) - 1)], color=BLUE, alpha=0.15)
    axs[0].axvline(ix[r["jend"]], color=BLUE, lw=2)
    axs[0].xaxis.set_major_formatter(mdates.DateFormatter("%b %y"))
    _style(axs[0], "Parent at 3-day bars, Jul 2017 on; today in blue")
    ch = childs[r["cfg"]["child"]]
    ci = cidx[r["cfg"]["child"]]
    sel2 = ci >= pd.Timestamp("2022-01-01")
    axs[1].plot(ci[sel2], ch[sel2], color=BLUE, lw=1.8)
    axs[1].xaxis.set_major_formatter(mdates.DateFormatter("%y"))
    _style(axs[1], "Child, 2022 on (the relief-rally analogue)")
    fig.tight_layout(); fig.savefig(os.path.join(out, "r2_dec2017_zoom.png")); plt.close(fig)

    # 3) fair adversary: best-of-K IC
    fig, ax = plt.subplots(figsize=(10, 3.4), dpi=140)
    kinds = sorted({x["kind"] for x in adv})
    for i, k in enumerate(kinds):
        ys = [x["bestIc"] for x in adv if x["kind"] == k]
        xs = np.full(len(ys), i) + np.random.default_rng(i).uniform(-0.18, 0.18, len(ys))
        ax.scatter(xs, ys, s=14, color=GREY, alpha=0.7)
    ax.axhline(realK["bestIc"], color=BLUE, lw=2)
    ax.text(len(kinds) - 0.5, realK["bestIc"], " real parent", color="#52514e", fontsize=8, va="bottom", ha="right")
    ax.set_xticks(range(len(kinds)), kinds)
    ax.set_ylabel("best 26-week move correlation", color="#52514e", fontsize=8)
    _style(ax, "Fair adversary: each placebo searched the same settings as the real parent")
    fig.tight_layout(); fig.savefig(os.path.join(out, "r2_fair_adversary.png")); plt.close(fig)


if __name__ == "__main__":
    sys.exit(main())

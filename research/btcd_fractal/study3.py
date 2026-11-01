#!/usr/bin/env python3
"""BTC.D fractal, round 3: the time-dilation factor along the walk (Steven, 2026-11-01 20:32 UTC).

"Find some correlation within the parent fractal vs now to determine a pattern in the time dilation factor as
the walk forward happens. It may shed light on how long."

For a family of good settings (round 2: weekly bars, logit and raw scale, fixed and re-fitted level maps):
  1. Stage dilation: for each parent swing (zigzag, 6-point reversals), the child weeks it took / the parent weeks
     it took, and the child's move against the parent's (amplitude ratio).
  2. Laws tested on those stages, each a candidate pattern for "how long":
       a. dilation by stage kind (waterfall vs rally/drift);
       b. dilation against parent progress (does the cycle keep slowing: log dilation linear in progress?);
       c. constant child speed: child weeks = |child move| / v, with v a property of the stage kind; then
          dilation = (|parent move| x amp ratio / v) / parent weeks;
       d. dilation against the parent's slope (steeper parent legs stretch less).
  3. Walk-forward test of "how long": at each past date, the time to the next parent pivot predicted from the
     parent's weeks to that pivot x the local dilation known then (and x the law's dilation), against when the
     child actually crossed it (in the final fit), next to a naive baseline (the median child stage length).
  4. Adversary: the same stage laws on placebo parents (IAAFT, block-shuffled, random walks): a pattern that
     placebo parents show as strongly is the warp's own artefact, not the fractal's.
  5. "How long" for the stage now: the current stage's expected child duration under each law, with the range
     across settings.

  python3 research/btcd_fractal/study3.py --data research/btcd_fractal/data --out research/btcd_fractal/out3
"""
import argparse
import itertools
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from study import block_shuffle, fit, iaaft, load, matched_walk, weekly, zigzag  # noqa: E402
from study2 import fwd  # noqa: E402


def stages_of(parent_raw, rev=6.0, wfpts=15.0):
    piv = zigzag(parent_raw, rev)
    out = []
    for p, q in zip(piv[:-1], piv[1:]):
        mv = parent_raw[q] - parent_raw[p]
        out.append({"from": int(p), "to": int(q), "move": float(mv), "kind": "waterfall" if mv <= -wfpts else ("fall" if mv < 0 else "rise")})
    return out


def stage_table(child_raw, parent_raw, path, st):
    """Child time and move spent on each parent stage (by the warp path)."""
    rows = []
    n = len(child_raw)
    for k, s in enumerate(st):
        # a pivot week ends the stage that leads into it (the top week belongs to the rally, not the waterfall)
        lo = (path >= s["from"]) if k == 0 else (path > s["from"])
        idx = np.where(lo & (path <= s["to"]))[0]
        pw = s["to"] - s["from"]
        if len(idx) == 0 or pw <= 0:
            rows.append({**s, "childWeeks": 0, "parentWeeks": pw, "dil": None, "childMove": None, "ampRatio": None, "complete": False, "i0": None, "i1": None})
            continue
        i0, i1 = int(idx[0]), int(idx[-1])
        complete = i1 < n - 1 and path[-1] > s["to"]
        cw = i1 - i0 + 1
        cm = float(child_raw[min(i1 + 1, n - 1)] - child_raw[max(i0 - 1, 0)]) if complete else float(child_raw[-1] - child_raw[max(i0 - 1, 0)])
        rows.append({**s, "childWeeks": cw, "parentWeeks": pw, "dil": cw / pw, "childMove": cm,
                     "ampRatio": cm / s["move"] if abs(s["move"]) > 1e-9 else None, "complete": bool(complete), "i0": i0, "i1": i1,
                     "childSpeed": abs(cm) / cw if cw else None})
    return rows


def laws(rows):
    """Fit the candidate dilation laws on completed stages. Returns coefficients and fit quality."""
    done = [r for r in rows if r["complete"] and r["dil"]]
    out = {"nStages": len(done)}
    if len(done) < 3:
        return out
    wf = [r for r in done if r["kind"] == "waterfall"]
    ot = [r for r in done if r["kind"] != "waterfall"]
    out["dilWaterfall"] = float(np.median([r["dil"] for r in wf])) if wf else None
    out["dilOther"] = float(np.median([r["dil"] for r in ot])) if ot else None
    if out["dilWaterfall"] and out["dilOther"]:
        out["kindRatio"] = out["dilOther"] / out["dilWaterfall"]  # how much more rallies/bases stretch than waterfalls
    # b. log dilation vs parent progress (stage midpoint), all completed stages
    x = np.array([(r["from"] + r["to"]) / 2 for r in done], dtype=float)
    y = np.log(np.array([r["dil"] for r in done]))
    if np.std(x) > 0:
        bcoef = np.polyfit(x, y, 1)
        out["logDilVsProgress"] = {"slopePerParentWeek": float(bcoef[0]), "r": float(np.corrcoef(x, y)[0, 1])}
    # c. child speed by kind (pts/week), and its spread
    for nm, grp in (("Waterfall", wf), ("Other", ot)):
        sp = [r["childSpeed"] for r in grp if r.get("childSpeed")]
        out[f"speed{nm}"] = float(np.median(sp)) if sp else None
        out[f"speed{nm}Cv"] = float(np.std(sp) / np.mean(sp)) if len(sp) > 1 and np.mean(sp) > 0 else None
    # d. log dilation vs log |parent slope|
    sl = np.array([abs(r["move"]) / max(r["parentWeeks"], 1) for r in done])
    if np.std(np.log(sl + 1e-6)) > 0:
        out["logDilVsLogSlope"] = {"slope": float(np.polyfit(np.log(sl + 1e-6), y, 1)[0]), "r": float(np.corrcoef(np.log(sl + 1e-6), y)[0, 1])}
    return out


def one(child_raw, parent_raw, cfg, wf_test=True):
    sp = cfg["space"]
    f = fit(fwd(child_raw, sp), fwd(parent_raw, sp), cfg)
    st = stages_of(parent_raw)
    rows = stage_table(child_raw, parent_raw, f["path"], st)
    res = {"cfg": cfg, "path": f["path"], "rows": rows, "laws": laws(rows), "jend": f["jend"], "r": f["r"]}
    if wf_test:
        res["walk"] = walk_test(child_raw, parent_raw, cfg, f["path"], st)
    return res


def walk_test(child_raw, parent_raw, cfg, final_path, st, start=52, step=4):
    """At each past date t: the next parent pivot after the match then; predicted child weeks to reach it
    (parent weeks to it x local dilation known then); actual child weeks until the final path crossed it."""
    sp = cfg["space"]
    c = fwd(child_raw, sp)
    p = fwd(parent_raw, sp)
    pivots = sorted({s["to"] for s in st})
    n = len(c)
    pts = []
    for t in range(start, n, step):
        g = fit(c[: t + 1], p, cfg, iters=3)
        j = g["jend"]
        nxt = next((q for q in pivots if q > j), None)
        if nxt is None:
            continue
        L = min(26, t)
        adv = g["path"][-1] - g["path"][-1 - L]
        ldil = L / max(adv, 0.5)
        cross = np.where(final_path >= nxt)[0]
        actual = int(cross[0] - t) if len(cross) and cross[0] > t else None
        pts.append({"t": t, "j": int(j), "next": int(nxt), "parentWeeksTo": int(nxt - j), "localDil": float(ldil), "overallDil": float(g["dil"]),
                    "predLocal": float((nxt - j) * ldil), "predOverall": float((nxt - j) * g["dil"]), "actual": actual})
    return pts


def walk_skill(pts):
    ok = [p for p in pts if p["actual"] is not None and p["actual"] > 0]
    if len(ok) < 5:
        return {"n": len(ok)}
    A = np.array([p["actual"] for p in ok], dtype=float)
    out = {"n": len(ok)}
    naive = np.median(A)
    out["maeNaive"] = float(np.mean(np.abs(A - naive)))
    for k in ("predLocal", "predOverall"):
        P = np.array([p[k] for p in ok])
        out[k] = {"mae": float(np.mean(np.abs(P - A))), "logCorr": float(np.corrcoef(np.log(P + 1), np.log(A + 1))[0, 1]) if np.std(P) > 0 else 0.0,
                  "medianRatio": float(np.median((P + 1) / (A + 1)))}
    return out


_G = {}


def _init(G):
    _G.update(G)


def _real(cfg):
    return one(_G["child"], _G["parents"][cfg["parent"]], cfg)


def _placebo(args):
    kind, par, cfg = args
    r = one(_G["child"], par, cfg, wf_test=False)
    return {"kind": kind, "laws": r["laws"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--placebos", type=int, default=40)
    ap.add_argument("--cap", type=int, default=16, help="most child weeks on one parent week (the warp's stretch limit)")
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 2)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    t0 = time.time()
    W = weekly(load(a.data, "BTC.D"))
    PARENTS = {"2016-01..2018-03": ("2016-01-01", "2018-03-01"), "2016-01..2018-01-15": ("2016-01-01", "2018-01-15")}
    parents, pidx = {}, {}
    for k, (fr, to) in PARENTS.items():
        x = W[(W.index >= pd.Timestamp(fr)) & (W.index < pd.Timestamp(to))]
        parents[k], pidx[k] = x.values.astype(float), x.index
    cx = W[W.index >= pd.Timestamp("2018-01-01")]
    child, cidx = cx.values.astype(float), cx.index
    base = {"maxstep": 2, "cap": a.cap, "j0": 0.15, "shapew": 8, "wfweeks": 13, "res": "W"}
    cfgs = []
    for pk, sp, (dm, bw), wsh in itertools.product(PARENTS, ["logit", "raw"], [(0, 0), (2, 104)], [1.0, 3.0]):
        c = dict(base, parent=pk, space=sp, dynmap=dm, bw=bw, wshape=wsh)
        c["bmin"], c["bmax"] = (0.35, 2.5) if sp == "raw" else (0.1, 5.0)
        cfgs.append(c)
    G = {"child": child, "parents": parents}
    with ProcessPoolExecutor(a.workers, initializer=_init, initargs=(G,)) as ex:
        res = list(ex.map(_real, cfgs))
    print(f"{len(res)} settings in {time.time() - t0:.0f}s")

    def lab(c):
        return f"{c['parent']} {c['space']} dyn{c['dynmap']}/{c['bw']} wsh{c['wshape']}"

    def d(k, i):
        ix = pidx[k]
        return ix[min(i, len(ix) - 1)].date().isoformat()

    def cd(i):
        return cidx[min(i, len(cidx) - 1)].date().isoformat() if i is not None else None

    # stage tables per setting (printed for the reference setting: round 2's best, logit fixed map, shape 3)
    ref = next(r for r in res if r["cfg"]["parent"] == "2016-01..2018-03" and r["cfg"]["space"] == "logit" and r["cfg"]["dynmap"] == 0 and r["cfg"]["wshape"] == 3.0)
    print(f"reference: {lab(ref['cfg'])}")
    for row in ref["rows"]:
        k = ref["cfg"]["parent"]
        print(f"  {row['kind']:9s} parent {d(k, row['from'])}..{d(k, row['to'])} ({row['parentWeeks']:3d} w, {row['move']:+6.1f} pts) | child {cd(row['i0'])}..{cd(row['i1'])} "
              f"({row['childWeeks']:3d} w, move {row['childMove'] if row['childMove'] is None else round(row['childMove'], 1)}) dil {row['dil'] if row['dil'] is None else round(row['dil'], 1)} "
              f"amp {row['ampRatio'] if row['ampRatio'] is None else round(row['ampRatio'], 2)} speed {row.get('childSpeed') and round(row['childSpeed'], 2)} {'done' if row['complete'] else 'OPEN'}")
    print("laws (reference):", json.dumps(ref["laws"]))
    for r in res:
        r["walkSkill"] = walk_skill(r["walk"])
        print(f"  {lab(r['cfg']):42s} now {d(r['cfg']['parent'], r['jend'])} | laws {json.dumps({k: (round(v, 3) if isinstance(v, float) else v) for k, v in r['laws'].items() if not isinstance(v, dict)})} | walk {json.dumps(r['walkSkill'])}")

    # adversary: stage laws on placebo parents (reference setting)
    rng = np.random.default_rng(20261103)
    par = parents[ref["cfg"]["parent"]]
    jobs = []
    for i in range(a.placebos):
        jobs.append(("iaaft", iaaft(par, rng), ref["cfg"]))
        jobs.append(("block8", block_shuffle(par, rng), ref["cfg"]))
        jobs.append(("walk", matched_walk(par, rng), ref["cfg"]))
    with ProcessPoolExecutor(a.workers, initializer=_init, initargs=(G,)) as ex:
        adv = list(ex.map(_placebo, jobs))

    def stat(xs, key, sub=None):
        v = [(x["laws"].get(key) or {}).get(sub) if sub else x["laws"].get(key) for x in xs]
        v = np.array([q for q in v if q is not None], dtype=float)
        return v

    realL = ref["laws"]
    advs = {}
    for kind in ("iaaft", "block8", "walk"):
        xs = [x for x in adv if x["kind"] == kind]
        out = {"n": len(xs)}
        for key, sub, better in (("logDilVsProgress", "r", "higher"), ("logDilVsLogSlope", "r", "lower"), ("speedOtherCv", None, "lower"), ("speedWaterfallCv", None, "lower"), ("kindRatio", None, "higher")):
            v = stat(xs, key, sub)
            rv = (realL.get(key) or {}).get(sub) if sub else realL.get(key)
            if rv is None or not len(v):
                continue
            p = (np.sum(v >= rv) + 1) / (len(v) + 1) if better == "higher" else (np.sum(v <= rv) + 1) / (len(v) + 1)
            out[f"{key}{'.' + sub if sub else ''}"] = {"real": rv, "median": float(np.median(v)), "p": float(p)}
        advs[kind] = out
        print(f"adversary {kind}: {json.dumps(out)}")

    # how long: the open stage now under each law, per setting
    howlong = []
    for r in res:
        k = r["cfg"]["parent"]
        L = r["laws"]
        open_rows = [x for x in r["rows"] if not x["complete"] and x["childWeeks"]]
        ci = r["rows"].index(open_rows[-1])
        nxt_rows = r["rows"][ci + 1: ci + 2]
        if not open_rows:
            continue
        cur = open_rows[-1]
        est = {"setting": lab(r["cfg"]), "stage": f"{cur['kind']} {d(k, cur['from'])}..{d(k, cur['to'])}", "spentWeeks": cur["childWeeks"],
               "parentWeeks": cur["parentWeeks"], "parentWeeksLeft": int(cur["to"] - r["jend"])}
        dk = L.get("dilWaterfall") if cur["kind"] == "waterfall" else L.get("dilOther")
        if dk:
            est["byKindTotalWeeks"] = dk * cur["parentWeeks"]
        lp = L.get("logDilVsProgress")
        if lp:
            done = [x for x in r["rows"] if x["complete"] and x["dil"]]
            x = np.array([(q["from"] + q["to"]) / 2 for q in done], dtype=float)
            y = np.log([q["dil"] for q in done])
            co = np.polyfit(x, y, 1)
            est["byProgressTotalWeeks"] = float(np.exp(np.polyval(co, (cur["from"] + cur["to"]) / 2)) * cur["parentWeeks"])
        spk = L.get("speedWaterfall") if cur["kind"] == "waterfall" else L.get("speedOther")
        amp = np.median([q["ampRatio"] for q in r["rows"] if q["complete"] and q["ampRatio"] and q["ampRatio"] > 0] or [0.5])
        if spk:
            est["bySpeedTotalWeeks"] = float(abs(cur["move"]) * amp / spk)
        if nxt_rows:
            nx = nxt_rows[0]
            dkn = L.get("dilWaterfall") if nx["kind"] == "waterfall" else L.get("dilOther")
            spn = L.get("speedWaterfall") if nx["kind"] == "waterfall" else L.get("speedOther")
            est["next"] = {"stage": f"{nx['kind']} {d(k, nx['from'])}..{d(k, nx['to'])}", "parentWeeks": nx["parentWeeks"], "move": nx["move"],
                           "byKindWeeks": dkn * nx["parentWeeks"] if dkn else None, "bySpeedWeeks": float(abs(nx["move"]) * amp / spn) if spn else None}
        howlong.append(est)
        print("how long:", json.dumps(est, default=float))

    out = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "childLast": cidx[-1].date().isoformat(),
           "reference": {"setting": lab(ref["cfg"]), "laws": ref["laws"], "walkSkill": ref["walkSkill"],
                         "rows": [{**{k: v for k, v in x.items() if k not in ("i0", "i1")}, "parentFrom": d(ref["cfg"]["parent"], x["from"]), "parentTo": d(ref["cfg"]["parent"], x["to"]),
                                   "childFrom": cd(x["i0"]), "childTo": cd(x["i1"])} for x in ref["rows"]]},
           "settings": [{"setting": lab(r["cfg"]), "now": d(r["cfg"]["parent"], r["jend"]), "laws": r["laws"], "walkSkill": r["walkSkill"],
                         "rows": [{k: v for k, v in x.items() if k not in ("i0", "i1")} for x in r["rows"]]} for r in res],
           "adversary": advs, "howLong": howlong, "elapsedSec": round(time.time() - t0)}
    with open(os.path.join(a.out, "results3.json"), "w") as fh:
        json.dump(out, fh, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o))
    charts(a.out, ref, res, pidx, cidx, child, lab)
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


def charts(out, ref, res, pidx, cidx, child, lab):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "DejaVu Sans", "figure.facecolor": "#fcfcfb", "axes.facecolor": "#fcfcfb"})
    k = ref["cfg"]["parent"]
    ix = pidx[k]
    # 1) dilation per parent stage, reference (bars) with the spread across settings (dots)
    rows = ref["rows"]
    fig, ax = plt.subplots(figsize=(10, 3.8), dpi=140)
    names = [f"{ix[r['from']].strftime('%b %y')}-{ix[min(r['to'], len(ix) - 1)].strftime('%b %y')}\n{r['kind']}{'' if r['complete'] else ' (open)'}" for r in rows]
    vals = [r["dil"] or 0 for r in rows]
    cols = [BLUE if r["kind"] == "waterfall" else GREY for r in rows]
    ax.bar(range(len(rows)), vals, color=cols, width=0.6)
    for r2 in res:
        if r2["cfg"]["parent"] != k:
            continue
        for i, rr in enumerate(r2["rows"][: len(rows)]):
            if rr["dil"]:
                ax.scatter(i + np.random.default_rng(i).uniform(-0.15, 0.15), rr["dil"], s=10, color="#0b0b0b", alpha=0.35, zorder=3)
    for i, v in enumerate(vals):
        ax.text(i, v, f" {v:.1f}x", ha="center", va="bottom", fontsize=8, color="#52514e")
    ax.set_xticks(range(len(rows)), names, fontsize=7)
    ax.set_ylabel("child weeks per parent week", color="#52514e", fontsize=8)
    ax.set_yscale("log")
    _style(ax, "Time dilation by parent stage (bars: reference setting; dots: the other settings; blue: waterfalls)")
    fig.tight_layout(); fig.savefig(os.path.join(out, "r3_stage_dilation.png")); plt.close(fig)

    # 2) local dilation along the child (13-week window) for the reference setting
    path = np.array(ref["path"])
    L = 13
    ld = [np.nan] * L + [L / max(path[i] - path[i - L], 0.5) for i in range(L, len(path))]
    fig, ax = plt.subplots(figsize=(10, 3.4), dpi=140)
    ax.plot(cidx, ld, color=BLUE, lw=1.8)
    ax.set_yscale("log")
    ax.set_ylabel("child weeks per parent week (13 w)", color="#52514e", fontsize=8)
    _style(ax, "Local time dilation along the child (reference setting)")
    fig.tight_layout(); fig.savefig(os.path.join(out, "r3_local_dilation.png")); plt.close(fig)

    # 3) walk-forward: predicted vs actual weeks to the next parent pivot
    w = [p for p in ref["walk"] if p["actual"]]
    if w:
        fig, ax = plt.subplots(figsize=(5.5, 4.2), dpi=140)
        ax.scatter([p["actual"] for p in w], [p["predLocal"] for p in w], s=14, color=BLUE, label="parent weeks x local dilation then")
        mx = max(max(p["actual"] for p in w), max(p["predLocal"] for p in w))
        ax.plot([1, mx], [1, mx], color=GREY, lw=1, ls=":")
        ax.set_xscale("log"); ax.set_yscale("log")
        ax.set_xlabel("actual child weeks to the next parent pivot", color="#52514e", fontsize=8)
        ax.set_ylabel("predicted then", color="#52514e", fontsize=8)
        _style(ax, "Walk forward: how long to the next stage")
        fig.tight_layout(); fig.savefig(os.path.join(out, "r3_howlong_walk.png")); plt.close(fig)


if __name__ == "__main__":
    sys.exit(main())

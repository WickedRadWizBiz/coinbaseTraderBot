"""Round 4 of the BTC.D fractal walk-forward: is the final waterfall ready?

Rounds 1-3 placed today at the parent's Dec 2017 top but gave no timing: the template has sat on that week since
early 2023. This round asks the institutional question instead: what did the market look like before BTC.D's past
waterfalls (alt seasons), and does today look like that?

A. Events: BTC.D falls from a 13-week local peak. Big = 10+ points within 26 weeks (Feb 2017, Dec 2017, Jan 2021);
   medium = 5+ points (adds the smaller rotations, including the 2024-2025 ones that faded).
B. Features, weekly and point in time (only data up to that week; M2 lagged 6 weeks for publication):
   ETH/BTC momentum and its distance from the 30-week mean, USDT.D 13-week change, BTC above its 30-week mean,
   BTC drawdown from its high, BTC 13-week return, BTC.D distance from its 52-week high and 13-week slope,
   OTHERS.D 13-week change, DXY 13-week change, US10Y 13-week change, M2 year-on-year growth, SPX above its
   30-week mean, days since the halving.
C. The checklist: each feature's value at every event start against today, as a percentile of all weeks.
D. Prediction: target = BTC.D logit change over the next 13 weeks. Rank IC per feature, out of sample by era
   (2017-2019 / 2020-2022 / 2023-2026), and a composite (sign-agreeing z-scores, signs learned on the other eras).
E. Adversary: the target circularly shifted by a random 26+ week offset (keeps both series' autocorrelation, breaks
   the timing), and random-walk placebo features searched the same way. A feature counts only if its IC beats the
   shifted null in every era it was not chosen on.
"""
import argparse, json, os
import numpy as np
import pandas as pd

H = 13
HALVINGS = [pd.Timestamp(x) for x in ["2012-11-28", "2016-07-09", "2020-05-11", "2024-04-20"]]
ERAS = [("2017-2019", "2016-06-01", "2020-01-01"), ("2020-2022", "2020-01-01", "2023-01-01"), ("2023-2026", "2023-01-01", "2100-01-01")]


def load(data, n):
    p = os.path.join(data, f"{n}_1d.csv")
    if not os.path.exists(p):
        return None
    d = pd.read_csv(p)
    d.index = pd.to_datetime(d.ts, unit="ms")
    return d.c.astype(float).sort_index()


def weekly(s):
    return s.resample("W").last().ffill()


def logit(p):
    p = np.clip(p / 100.0, 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def features(data):
    W = {}
    for n in ["BTC.D", "ETHBTC", "USDT.D", "BTCUSD", "OTHERS.D", "DXY", "US10Y", "M2", "SPX"]:
        s = load(data, n)
        if s is not None:
            W[n] = weekly(s)
    idx = W["BTC.D"].index
    W = {k: v.reindex(idx).ffill() for k, v in W.items()}
    b = W["BTC.D"]
    F = pd.DataFrame(index=idx)
    e = np.log(W["ETHBTC"])
    F["ethbtc_13w"] = e.diff(13)
    F["ethbtc_vs30w"] = e - e.rolling(30).mean()
    F["usdtd_13w"] = np.log(W["USDT.D"]).diff(13)
    btc = np.log(W["BTCUSD"])
    F["btc_vs30w"] = btc - btc.rolling(30).mean()
    F["btc_dd"] = btc - btc.cummax()
    F["btc_13w"] = btc.diff(13)
    F["btcd_from52wHigh"] = b - b.rolling(52).max()
    F["btcd_13w"] = b.diff(13)
    F["othersd_13w"] = np.log(W["OTHERS.D"]).diff(13)
    F["dxy_13w"] = np.log(W["DXY"]).diff(13)
    F["us10y_13w"] = W["US10Y"].diff(13)
    m2 = W["M2"].shift(6)  # monthly, published with a lag
    F["m2_yoy"] = np.log(m2).diff(52)
    spx = np.log(W["SPX"])
    F["spx_vs30w"] = spx - spx.rolling(30).mean()
    F["days_since_halving"] = [min((t - h).days for h in HALVINGS if h <= t) for t in idx]
    y = logit(b).shift(-H) - logit(b)
    return F, b, y


def events(b, min_pts, peak_w=13, within=26):
    out = []
    vals = b.values
    for i in range(len(b)):
        lo, hi = max(0, i - peak_w), min(len(b), i + peak_w + 1)
        if vals[i] < vals[lo:hi].max():
            continue
        w = vals[i:i + within + 1]
        j = int(np.argmin(w))
        if vals[i] - w[j] >= min_pts:
            if out and (b.index[i] - pd.Timestamp(out[-1]["trough"])).days < 0:
                continue
            out.append({"peak": b.index[i], "trough": b.index[i + j], "from": round(float(vals[i]), 1), "to": round(float(w[j]), 1), "days": int((b.index[i + j] - b.index[i]).days)})
    return out


def pct_rank(col, v):
    c = col.dropna()
    return float((c < v).mean()) if len(c) else None


def spearman(a, b):
    m = a.notna() & b.notna()
    if m.sum() < 20:
        return None
    return float(a[m].rank().corr(b[m].rank()))


def era_mask(idx, fr, to):
    return (idx >= pd.Timestamp(fr)) & (idx < pd.Timestamp(to))


def ic_table(F, y):
    rows = {}
    for c in F.columns:
        rows[c] = {"all": spearman(F[c], y)}
        for name, fr, to in ERAS:
            m = era_mask(F.index, fr, to)
            rows[c][name] = spearman(F[c][m], y[m])
    return rows


def composite_oos(F, y, cols, thr=0.05):
    """Signs and scales learned on two eras, scored on the third."""
    out, score = {}, pd.Series(np.nan, index=F.index)
    for name, fr, to in ERAS:
        test = era_mask(F.index, fr, to)
        train = ~test & y.notna()
        z = pd.Series(0.0, index=F.index)
        used = 0
        for c in cols:
            ic = spearman(F[c][train], y[train])
            if ic is None or abs(ic) < thr:
                continue
            mu, sd = F[c][train].mean(), F[c][train].std()
            if not sd:
                continue
            z = z + np.sign(ic) * ((F[c] - mu) / sd).clip(-3, 3).fillna(0)
            used += 1
        if used:
            score[test] = (z / used)[test]
        out[name] = spearman(score[test], y[test])
    out["pooled"] = spearman(score, y)
    return out, score


def shift_null(F, y, cols, n, rng, fn):
    vals = []
    yv = y.dropna()
    for _ in range(n):
        k = int(rng.integers(26, len(yv) - 26))
        ys = pd.Series(np.roll(yv.values, k), index=yv.index).reindex(y.index)
        vals.append(fn(F, ys, cols))
    return vals


def precision(d, b, big):
    """Weeks at least as event-like as a cut, away from the events themselves: how often a 5+ / 10+ point fall followed."""
    pct = d.rank(pct=True)
    fut = pd.concat([b.shift(-k) for k in range(1, 27)], axis=1).min(axis=1) - b
    away = pd.Series(True, index=d.index)
    for t in big:
        away &= ~((d.index > t - pd.Timedelta(weeks=12)) & (d.index <= t + pd.Timedelta(weeks=26)))
    out = {}
    for cut in [0.1, 0.2, 0.3]:
        m = (pct <= cut) & away & fut.notna()
        out[str(cut)] = {"weeks": int(m.sum()), "fall5in26w": round(float((fut[m] <= -5).mean()), 2) if m.sum() else None,
                         "fall10in26w": round(float((fut[m] <= -10).mean()), 2) if m.sum() else None}
    m = away & fut.notna()
    out["allAway"] = {"weeks": int(m.sum()), "fall5in26w": round(float((fut[m] <= -5).mean()), 2), "fall10in26w": round(float((fut[m] <= -10).mean()), 2)}
    return out


def chart(out, b, score, d, big):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return
    fig, ax = plt.subplots(3, 1, figsize=(11, 8), sharex=True)
    ax[0].plot(b.index, b.values, color="#3b6fb6", lw=1.2)
    for t in big:
        for a_ in ax:
            a_.axvline(t, color="#c0504d", lw=0.8, ls="--")
    ax[0].set_ylabel("BTC.D %")
    ax[1].plot(score.index, score.values, color="#4f8a3c", lw=1)
    ax[1].axhline(0, color="#888", lw=0.6)
    ax[1].set_ylabel("composite\n(+ = BTC.D down)")
    ax[2].plot(d.index, d.rank(pct=True).values, color="#8064a2", lw=1)
    ax[2].set_ylabel("similarity pct\n(low = like a\nwaterfall start)")
    ax[2].invert_yaxis()
    ax[0].set_title("BTC.D, out-of-sample composite and similarity to past waterfall starts (dashed)")
    fig.tight_layout()
    fig.savefig(os.path.join(out, "7_readiness.png"), dpi=110)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--nulls", type=int, default=400)
    ap.add_argument("--seed", type=int, default=4)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    rng = np.random.default_rng(a.seed)
    F, b, y = features(a.data)
    F = F[F.index >= pd.Timestamp("2016-06-01")]
    b, y = b.reindex(F.index), y.reindex(F.index)
    now = F.index[-1]
    res = {"now": str(now.date()), "btcd": round(float(b.iloc[-1]), 2), "horizonWeeks": H}

    # A + C: events and the checklist
    for kind, pts in [("big", 10.0), ("medium", 5.0)]:
        ev = events(b, pts)
        for e in ev:
            t = e["peak"]
            e["features"] = {c: (None if pd.isna(F.at[t, c]) else round(float(F.at[t, c]), 4)) for c in F.columns}
            e["pct"] = {c: (None if pd.isna(F.at[t, c]) else round(pct_rank(F[c], F.at[t, c]), 2)) for c in F.columns}
            e["peak"], e["trough"] = str(e["peak"].date()), str(e["trough"].date())
        res[f"events_{kind}"] = ev
    res["today"] = {c: (None if pd.isna(F[c].iloc[-1]) else round(float(F[c].iloc[-1]), 4)) for c in F.columns}
    res["todayPct"] = {c: (None if pd.isna(F[c].iloc[-1]) else round(pct_rank(F[c], F[c].iloc[-1]), 2)) for c in F.columns}
    # checklist: for each feature, the range of percentiles at the big events; is today inside it?
    chk = {}
    for c in F.columns:
        ps = [e["pct"][c] for e in res["events_big"] if e["pct"][c] is not None]
        if not ps:
            continue
        lo, hi = min(ps), max(ps)
        t = res["todayPct"][c]
        chk[c] = {"eventsPct": ps, "today": t, "inside": (t is not None and lo - 0.05 <= t <= hi + 0.05)}
    res["checklist"] = chk
    res["checklistScore"] = f"{sum(v['inside'] for v in chk.values())}/{len(chk)}"

    # D: IC per feature by era, against the shifted null
    cols = [c for c in F.columns if c != "days_since_halving"]
    ics = ic_table(F, y)
    nulls = {c: [] for c in F.columns}
    yv = y.dropna()
    for _ in range(a.nulls):
        k = int(rng.integers(26, len(yv) - 26))
        ys = pd.Series(np.roll(yv.values, k), index=yv.index).reindex(y.index)
        for c in F.columns:
            v = spearman(F[c], ys)
            nulls[c].append(abs(v) if v is not None else 0)
    for c in F.columns:
        real = abs(ics[c]["all"] or 0)
        ics[c]["pShift"] = round(float((np.array(nulls[c]) >= real).mean()), 3)
        eras = [ics[c][e[0]] for e in ERAS if ics[c][e[0]] is not None]
        ics[c]["signStable"] = bool(eras) and (all(v > 0 for v in eras) or all(v < 0 for v in eras))
    res["ic"] = {c: {k: (round(v, 3) if isinstance(v, float) else v) for k, v in d.items()} for c, d in ics.items()}

    # composites: all features (thr 0.05) and strict (only features with |train IC| >= 0.2, chosen inside each fold)
    for tag, thr in [("", 0.05), ("Strict", 0.2)]:
        comp, sc = composite_oos(F, y, cols, thr)
        if tag == "Strict":
            score = sc
        res["compositeOOS" + tag] = {k: (round(v, 3) if v is not None else None) for k, v in comp.items()}
        cn = shift_null(F, y, cols, max(60, a.nulls // 4), rng, lambda F_, ys, cs: composite_oos(F_, ys, cs, thr)[0]["pooled"] or 0)
        res["compositeNull" + tag] = {"median": round(float(np.median(cn)), 3), "p95": round(float(np.quantile(cn, 0.95)), 3),
                                      "p": round(float((np.array(cn) >= (comp["pooled"] or 0)).mean()), 3)}
        res["compositeEraNull" + tag] = {}
        for name, fr, to in ERAS:
            m = era_mask(F.index, fr, to)
            ce = shift_null(F, y, cols, max(40, a.nulls // 10), rng, lambda F_, ys, cs, m=m: spearman(composite_oos(F_, ys, cs, thr)[1][m], ys[m]) or 0)
            res["compositeEraNull" + tag][name] = round(float((np.array(ce) >= (comp[name] or 0)).mean()), 3)
    # similarity to past waterfall starts (percentile space), leave-one-event-out
    P = F.apply(lambda c: c.rank(pct=True))
    big = [pd.Timestamp(e["peak"]) for e in res["events_big"] if pd.Timestamp(e["peak"]) in P.index]
    def dist(others):
        D = pd.concat([(P - P.loc[t]).abs().mean(axis=1) for t in others], axis=1)
        return D.min(axis=1)
    loo = {}
    for t in big:
        d = dist([u for u in big if u != t])
        pre = d[(d.index > t - pd.Timedelta(weeks=8)) & (d.index <= t)]
        loo[str(t.date())] = {"bestPctWithin8wBefore": round(float((d < pre.min()).mean()), 3) if len(pre) else None}
    dall = dist(big)
    res["similarity"] = {"today": round(float(dall.iloc[-1]), 3), "todayPct": round(float((dall < dall.iloc[-1]).mean()), 3),
                         "looEvents": loo, "precision": precision(dall, b, big), "note": "share of weeks closer to a past waterfall start than the given week (low = event-like)"}
    # placebo features: random walks searched the same way (best |IC| out of len(cols))
    best = []
    for _ in range(max(60, a.nulls // 4)):
        P = pd.DataFrame({f"rw{i}": np.cumsum(rng.standard_normal(len(F))) for i in range(len(cols))}, index=F.index)
        P = P.diff(13)
        best.append(max(abs(spearman(P[c], y) or 0) for c in P.columns))
    top = max(abs(ics[c]["all"] or 0) for c in cols)
    res["placeboBestOf"] = {"real": round(top, 3), "median": round(float(np.median(best)), 3), "p": round(float((np.array(best) >= top).mean()), 3)}

    # today's composite reading against history: percentile, and what followed similar readings
    s = score.dropna()
    t = s.iloc[-1] if len(s) and s.index[-1] == now else np.nan
    res["compositeToday"] = None if pd.isna(t) else round(float(t), 3)
    if not pd.isna(t):
        res["compositeTodayPct"] = round(float((s < t).mean()), 2)
        near = s[(s - t).abs() <= s.std() * 0.25].index
        fut = y.reindex(near).dropna()
        bf = (b.shift(-H) - b).reindex(fut.index)
        res["afterSimilar"] = {"n": int(len(fut)), "btcdMedianPts13w": round(float(bf.median()), 2),
                               "fallOver5ptsShare": round(float((bf <= -5).mean()), 2)}
    # E bis: how often a 13-week window holds a 5+ point BTC.D drop at all (base rate)
    bf = (b.shift(-H) - b).dropna()
    res["baseRate"] = {"fallOver5ptsShare13w": round(float((bf <= -5).mean()), 3), "fallOver10ptsShare13w": round(float((bf <= -10).mean()), 3)}

    # the composite is built so that + means BTC.D rises; flip for the chart so + reads as "BTC.D falls" (alt season)
    chart(a.out, b, -score, dall, big)
    with open(os.path.join(a.out, "results4.json"), "w") as f:
        json.dump(res, f, indent=1, default=str)
    # log
    print(f"now {res['now']} BTC.D {res['btcd']}")
    for kind in ["big", "medium"]:
        print(f"events {kind}:")
        for e in res[f"events_{kind}"]:
            print(f"  {e['peak']} {e['from']} -> {e['to']} {e['trough']} ({e['days']} d) halving+{e['features']['days_since_halving']} d")
    print("checklist (percentile at big events | today):", res["checklistScore"])
    for c, v in chk.items():
        print(f"  {c:20s} events {v['eventsPct']} today {v['today']} {'IN' if v['inside'] else 'out'}")
    print("IC with next-13w BTC.D logit change (all / eras / p vs shifted target / sign stable):")
    for c, d in res["ic"].items():
        print(f"  {c:20s} {d['all']} | {d.get('2017-2019')} {d.get('2020-2022')} {d.get('2023-2026')} | p {d['pShift']} | {d['signStable']}")
    print("composite OOS:", res["compositeOOS"], "null", res["compositeNull"], "era p", res["compositeEraNull"])
    print("composite strict OOS:", res["compositeOOSStrict"], "null", res["compositeNullStrict"], "era p", res["compositeEraNullStrict"])
    print("similarity to past waterfall starts:", res["similarity"])
    print("placebo best-of:", res["placeboBestOf"])
    print("today composite:", res.get("compositeToday"), "pct", res.get("compositeTodayPct"), "after similar", res.get("afterSimilar"))
    print("base rate:", res["baseRate"])


if __name__ == "__main__":
    main()

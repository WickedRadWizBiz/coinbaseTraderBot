#!/usr/bin/env python3
"""TradingView history for the bot's history store, through tvdatafeed (an unofficial TradingView
client, no login): https://github.com/rongardF/tvdatafeed

Two jobs (both used by the daily pipeline, research/history/tradingview.ts, via deploy/history.sh tvfetch):

  1. Index series for the TA network's market context, up to 5,000 bars each (tvdatafeed's maximum):
       CRYPTOCAP:BTC.D, CRYPTOCAP:USDT.D     dominance (BTC, USDT)
       CRYPTOCAP:TOTAL3                     crypto market cap excluding BTC and ETH
       CRYPTOCAP:OTHERS.D                   dominance of everything outside the top 10
       RTY                                  US Russell 2000 (first symbol that answers: TVC:RUT,
                                            RUSSELL:RUT, CME_MINI:RTY1!, AMEX:IWM)
     python3 tv_history.py --out DIR --indexes default --intervals 1d,4h,1h --bars 5000

  2. Gap filling for spot pairs: bars for the (asset, timeframe) pairs the pipeline found holes in,
     from the first exchange that has the pair (COINBASE:{A}USD, BINANCE:{A}USDT, BITSTAMP:{A}USD,
     KRAKEN:{A}USD). The store ranks these below the exchanges' own archives, so they only fill gaps.
     python3 tv_history.py --out DIR --spot BTC:1h,SOL:15m --bars 5000

Output: one CSV per series, `time,open,high,low,close,volume` with time = bar open in UTC epoch seconds:
  CRYPTOCAP_<SYMBOL>_<tf>.csv, TVINDEX_<NAME>_<tf>.csv (non-crypto indexes such as RTY), and
  tvspot__<ASSET>__<tf>__<EXCHANGE>-<SYMBOL>.csv (spot gap fills).

Install: pip install --upgrade --no-cache-dir git+https://github.com/rongardF/tvdatafeed.git
"""

import argparse
import calendar
import csv
import os
import sys
import time

# tvdatafeed converts TradingView's epoch stamps with datetime.fromtimestamp (local time): run in UTC
# so the stamps convert back exactly (no daylight-saving gaps or repeated hours).
os.environ["TZ"] = "UTC"
if hasattr(time, "tzset"):
    time.tzset()

DEFAULT_INDEXES = ["CRYPTOCAP:BTC.D", "CRYPTOCAP:USDT.D", "CRYPTOCAP:TOTAL3", "CRYPTOCAP:OTHERS.D", "RTY=TVC:RUT|RUSSELL:RUT|CME_MINI:RTY1!|AMEX:IWM"]
SPOT_EXCHANGES = ["COINBASE:{A}USD", "BINANCE:{A}USDT", "BITSTAMP:{A}USD", "KRAKEN:{A}USD"]
INTERVAL_NAMES = {"1d": "in_daily", "4h": "in_4_hour", "1h": "in_1_hour", "15m": "in_15_minute"}


def epoch_seconds(ts) -> int:
    dt = ts.to_pydatetime() if hasattr(ts, "to_pydatetime") else ts
    if dt.tzinfo is not None:
        return int(dt.timestamp())
    if hasattr(time, "tzset"):
        return calendar.timegm(dt.timetuple())  # naive UTC (TZ forced above)
    return int(dt.timestamp())  # Windows: naive local time


def fetch(tv, exchange: str, symbol: str, interval, bars: int, tries: int = 3):
    for attempt in range(1, tries + 1):
        try:
            df = tv.get_hist(symbol=symbol, exchange=exchange, interval=interval, n_bars=bars)
            if df is not None and len(df):
                return df
            print(f"  {exchange}:{symbol}: no data (attempt {attempt}/{tries})")
        except Exception as e:  # network hiccups, TradingView throttling
            print(f"  {exchange}:{symbol}: {e} (attempt {attempt}/{tries})")
        time.sleep(3 * attempt)
    return None


def write_csv(path: str, df) -> int:
    rows = 0
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "open", "high", "low", "close", "volume"])
        for ts, r in df.iterrows():
            vol = r.get("volume", 0)
            w.writerow([epoch_seconds(ts), r["open"], r["high"], r["low"], r["close"], 0 if vol != vol else vol])
            rows += 1
    return rows


def parse_index(spec: str):
    """'CRYPTOCAP:BTC.D' -> ('BTC.D', [('CRYPTOCAP', 'BTC.D')]); 'RTY=TVC:RUT|CME_MINI:RTY1!' -> ('RTY', [...])."""
    name, _, cands = spec.partition("=") if "=" in spec else ("", "", spec)
    pairs = []
    for c in cands.split("|"):
        ex, _, sym = c.strip().partition(":")
        if ex and sym:
            pairs.append((ex.upper(), sym.upper()))
    return (name.strip().upper() or pairs[0][1]), pairs


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="tradingview", help="output folder (default ./tradingview)")
    ap.add_argument("--indexes", default="", help="'default' or a comma list like CRYPTOCAP:TOTAL3,RTY=TVC:RUT|CME_MINI:RTY1!")
    ap.add_argument("--intervals", default="1d,4h,1h", help="index intervals: comma list of 1d, 4h, 1h, 15m")
    ap.add_argument("--spot", default="", help="spot gap fills: comma list of ASSET:tf, e.g. BTC:1h,SOL:15m")
    ap.add_argument("--bars", type=int, default=5000, help="bars per series (tvdatafeed's maximum is 5000)")
    a = ap.parse_args()
    try:
        from tvDatafeed import Interval, TvDatafeed
    except ImportError:
        sys.exit("tvdatafeed is not installed: pip install --upgrade --no-cache-dir git+https://github.com/rongardF/tvdatafeed.git")
    os.makedirs(a.out, exist_ok=True)
    bars = max(1, min(5000, a.bars))
    tv = TvDatafeed()  # no login
    written = failed = 0

    specs = DEFAULT_INDEXES if a.indexes.strip().lower() == "default" else [s for s in a.indexes.split(",") if s.strip()]
    intervals = [i.strip().lower() for i in a.intervals.split(",") if i.strip()]
    for spec in specs:
        name, cands = parse_index(spec)
        for tf in intervals:
            if tf not in INTERVAL_NAMES:
                sys.exit(f"unknown interval {tf} (use {', '.join(INTERVAL_NAMES)})")
            got = None
            for ex, sym in cands:
                df = fetch(tv, ex, sym, getattr(Interval, INTERVAL_NAMES[tf]), bars, tries=2)
                if df is not None:
                    got = (ex, sym, df)
                    break
            if not got:
                print(f"{name} {tf}: no symbol answered ({', '.join(f'{e}:{s}' for e, s in cands)})")
                failed += 1
                continue
            ex, sym, df = got
            fname = f"CRYPTOCAP_{name}_{tf}.csv" if ex == "CRYPTOCAP" else f"TVINDEX_{name}_{tf}.csv"
            n = write_csv(os.path.join(a.out, fname), df)
            written += 1
            print(f"{name} {tf}: {n} bars from {ex}:{sym} -> {fname}")
            time.sleep(1)

    for item in [s.strip() for s in a.spot.split(",") if s.strip()]:
        asset, _, tf = item.partition(":")
        asset, tf = asset.upper(), (tf or "1h").lower()
        if tf not in INTERVAL_NAMES:
            print(f"{item}: unknown interval")
            failed += 1
            continue
        got = None
        for pat in SPOT_EXCHANGES:
            ex, _, sym = pat.replace("{A}", asset).partition(":")
            df = fetch(tv, ex, sym, getattr(Interval, INTERVAL_NAMES[tf]), bars, tries=1)
            if df is not None:
                got = (ex, sym, df)
                break
        if not got:
            print(f"{asset} {tf}: no exchange answered")
            failed += 1
            continue
        ex, sym, df = got
        fname = f"tvspot__{asset}__{tf}__{ex}-{sym}.csv"
        n = write_csv(os.path.join(a.out, fname), df)
        written += 1
        print(f"{asset} {tf}: {n} bars from {ex}:{sym} -> {fname}")
        time.sleep(1)

    print(f"done: {written} series written, {failed} failed")
    return 0 if written or not failed else 1


if __name__ == "__main__":
    sys.exit(main())

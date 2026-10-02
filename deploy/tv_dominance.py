#!/usr/bin/env python3
"""One-off export of TradingView's crypto dominance and total-market-cap charts for the bot's
history store (docs/TA_NETWORK.md, "Dominance").

  python3 tv_dominance.py --out ~/incoming/tradingview
  node dist/history.cjs import ~/incoming/tradingview       # or: deploy/history.sh tradingview (does both)

Symbols (TradingView's CRYPTOCAP index): BTC.D, USDT.D, TOTAL, TOTAL2, TOTAL3, OTHERS.D.
Intervals: 1d (5,000 bars: the whole history), 4h (about 2.3 years), 1h (about 7 months).

Uses tvdatafeed, an UNOFFICIAL TradingView client, without logging in (so no account is involved).
Automated downloading is against TradingView's terms: run this once to backfill history, not on a
schedule. The bot keeps the series up to date itself from its live dominance feed.

Install: pip install --upgrade --no-cache-dir git+https://github.com/rongardF/tvdatafeed.git
Output: CRYPTOCAP_<SYMBOL>_<interval>.csv with `time,open,high,low,close,volume`, time = bar open in
UTC epoch seconds.
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

try:
    from tvDatafeed import Interval, TvDatafeed
except ImportError:
    sys.exit("tvdatafeed is not installed: pip install --upgrade --no-cache-dir git+https://github.com/rongardF/tvdatafeed.git")

SYMBOLS = ["BTC.D", "USDT.D", "TOTAL", "TOTAL2", "TOTAL3", "OTHERS.D"]
INTERVALS = {"1d": Interval.in_daily, "4h": Interval.in_4_hour, "1h": Interval.in_1_hour}


def epoch_seconds(ts) -> int:
    dt = ts.to_pydatetime() if hasattr(ts, "to_pydatetime") else ts
    if dt.tzinfo is not None:
        return int(dt.timestamp())
    if hasattr(time, "tzset"):
        return calendar.timegm(dt.timetuple())  # naive UTC (TZ forced above)
    return int(dt.timestamp())  # Windows: naive local time


def fetch(tv, symbol: str, interval, bars: int, tries: int = 3):
    for attempt in range(1, tries + 1):
        try:
            df = tv.get_hist(symbol=symbol, exchange="CRYPTOCAP", interval=interval, n_bars=bars)
            if df is not None and len(df):
                return df
            print(f"  {symbol}: no data (attempt {attempt}/{tries})")
        except Exception as e:  # network hiccups, TradingView throttling
            print(f"  {symbol}: {e} (attempt {attempt}/{tries})")
        time.sleep(3 * attempt)
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="tradingview", help="output folder (default ./tradingview)")
    ap.add_argument("--symbols", default=",".join(SYMBOLS), help=f"comma list (default {','.join(SYMBOLS)})")
    ap.add_argument("--intervals", default="1d,4h,1h", help="comma list of 1d, 4h, 1h (default all three)")
    ap.add_argument("--bars", type=int, default=5000, help="bars per series (tvdatafeed's maximum is 5000)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    symbols = [s.strip().upper() for s in a.symbols.split(",") if s.strip()]
    intervals = [i.strip().lower() for i in a.intervals.split(",") if i.strip()]
    bad = [i for i in intervals if i not in INTERVALS]
    if bad:
        sys.exit(f"unknown interval(s): {', '.join(bad)} (use 1d, 4h, 1h)")
    tv = TvDatafeed()  # no login
    written = 0
    for symbol in symbols:
        for name in intervals:
            df = fetch(tv, symbol, INTERVALS[name], min(5000, a.bars))
            if df is None:
                print(f"{symbol} {name}: FAILED (TradingView may be blocking this machine; try from another network)")
                continue
            path = os.path.join(a.out, f"CRYPTOCAP_{symbol}_{name}.csv")
            rows = 0
            with open(path, "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(["time", "open", "high", "low", "close", "volume"])
                for ts, r in df.iterrows():
                    vol = r["volume"] if "volume" in r and r["volume"] == r["volume"] else 0  # NaN-safe
                    w.writerow([epoch_seconds(ts), r["open"], r["high"], r["low"], r["close"], vol])
                    rows += 1
            first, last = df.index[0], df.index[-1]
            print(f"{symbol} {name}: {rows} bars, {first:%Y-%m-%d %H:%M} .. {last:%Y-%m-%d %H:%M} UTC -> {path}")
            written += 1
            time.sleep(1)
    print(f"done: {written} file(s) in {a.out}")
    return 0 if written else 1


if __name__ == "__main__":
    sys.exit(main())

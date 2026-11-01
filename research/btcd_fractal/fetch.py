#!/usr/bin/env python3
"""Daily history for the BTC.D fractal walk-forward study, from TradingView through tvdatafeed (no login).

Writes one CSV per series into --out: ts,o,h,l,c,v with ts = bar open in UTC epoch milliseconds (the bot's
history-store format, so the same files feed bot/macro/fractalEngine.ts through research/fractalStudy.ts).

  python3 research/btcd_fractal/fetch.py --out research/btcd_fractal/data

Runs on a GitHub runner: the cloud session container cannot reach TradingView.
"""
import argparse
import calendar
import os
import sys
import time

os.environ["TZ"] = "UTC"
if hasattr(time, "tzset"):
    time.tzset()

# name -> candidate TradingView symbols (first one that answers wins)
SERIES = {
    "BTC.D": ["CRYPTOCAP:BTC.D"],
    "USDT.D": ["CRYPTOCAP:USDT.D"],
    "TOTAL": ["CRYPTOCAP:TOTAL"],
    "TOTAL2": ["CRYPTOCAP:TOTAL2"],
    "TOTAL3": ["CRYPTOCAP:TOTAL3"],
    "OTHERS.D": ["CRYPTOCAP:OTHERS.D"],
    "ETH.D": ["CRYPTOCAP:ETH.D"],
    "BTCUSD": ["BITSTAMP:BTCUSD", "INDEX:BTCUSD", "COINBASE:BTCUSD"],
    "ETHBTC": ["BITFINEX:ETHBTC", "BINANCE:ETHBTC", "POLONIEX:ETHBTC"],
    "DXY": ["TVC:DXY"],
    "US10Y": ["TVC:US10Y"],
    "SPX": ["SP:SPX", "TVC:SPX"],
    "M2": ["ECONOMICS:USM2", "FRED:M2SL"],
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--bars", type=int, default=5000)
    a = ap.parse_args()
    from tvDatafeed import Interval, TvDatafeed

    os.makedirs(a.out, exist_ok=True)
    tv = TvDatafeed()
    got = 0
    for name, cands in SERIES.items():
        df = None
        for full in cands:
            ex, sym = full.split(":", 1)
            for attempt in range(3):
                try:
                    df = tv.get_hist(symbol=sym, exchange=ex, interval=Interval.in_daily, n_bars=a.bars)
                except Exception as e:  # noqa: BLE001
                    print(f"  {full}: {type(e).__name__} (attempt {attempt + 1})")
                    df = None
                if df is not None and len(df):
                    break
                time.sleep(2 + attempt * 3)
            if df is not None and len(df):
                break
        if df is None or not len(df):
            print(f"{name}: no data")
            continue
        rows = []
        for ts, r in df.iterrows():
            dt = ts.to_pydatetime()
            ms = calendar.timegm(dt.timetuple()) * 1000
            rows.append(f"{ms},{r['open']},{r['high']},{r['low']},{r['close']},{r.get('volume', 0) or 0}")
        with open(os.path.join(a.out, f"{name}_1d.csv"), "w") as f:
            f.write("ts,o,h,l,c,v\n" + "\n".join(rows) + "\n")
        got += 1
        print(f"{name}: {len(rows)} bars {df.index[0].date()}..{df.index[-1].date()} ({full})")
        time.sleep(1)
    return 0 if got else 1


if __name__ == "__main__":
    sys.exit(main())

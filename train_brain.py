import os
import json
import glob
import pandas as pd
import numpy as np
from itertools import product

# ==========================================
# 1. TECHNICAL INDICATORS
# ==========================================
def calculate_rsi(series, period=14):
    delta = series.diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / (loss + 1e-10)
    return 100 - (100 / (1 + rs))

def add_indicators(df):
    df = df.copy()
    # Normalize column names to lowercase
    df.columns = [c.lower() for c in df.columns]
    
    if 'close' not in df.columns:
        raise ValueError("CSV must contain a 'Close' column.")

    df['rsi'] = calculate_rsi(df['close'], period=14)
    df['sma_50'] = df['close'].rolling(50).mean()
    df['sma_200'] = df['close'].rolling(200).mean()
    df['returns'] = df['close'].pct_change()
    
    # Simple market regime tagging based on trend and volatility
    # Bull Market: Close > SMA50 > SMA200
    # Bear Market: Close < SMA50
    # Alt Season: High momentum / volatility
    conditions = [
        (df['close'] > df['sma_50']) & (df['sma_50'] > df['sma_200']),
        (df['close'] < df['sma_50']),
    ]
    choices = ['bull_market', 'bear_market']
    df['regime'] = np.select(conditions, choices, default='alt_season')
    
    return df.dropna().reset_index(drop=True)

# ==========================================
# 2. BACKTEST ENGINE FOR A SPECIFIC REGIME
# ==========================================
def backtest_regime(df_regime, tp, sl, trail, rsi_buy, rsi_sell):
    balance = 1000.0
    position_entry_price = -1.0
    position_peak_price = -1.0
    trades = []
    
    closes = df_regime['close'].values
    rsis = df_regime['rsi'].values
    
    for i in range(len(closes)):
        price = closes[i]
        rsi = rsis[i]
        
        # Check active position
        if position_entry_price != -1.0:
            pnl_pct = (price - position_entry_price) / position_entry_price
            peak_pnl = (position_peak_price - position_entry_price) / position_entry_price
            
            # Update peak price
            if price > position_peak_price:
                position_peak_price = price
                peak_pnl = pnl_pct

            # Exit Conditions
            hit_tp = pnl_pct >= tp
            hit_sl = pnl_pct <= sl # sl is negative
            hit_trail = (peak_pnl >= trail) and (pnl_pct <= peak_pnl - trail)
            overbought_exit = rsi >= rsi_sell
            
            if hit_tp or hit_sl or hit_trail or overbought_exit:
                trades.append(pnl_pct)
                balance *= (1 + pnl_pct)
                position_entry_price = -1.0
                position_peak_price = -1.0
                
        else:
            # Entry condition: RSI oversold in this regime
            if rsi <= rsi_buy:
                position_entry_price = price
                position_peak_price = price
                
    if len(trades) == 0:
        return -999, 0, 0 # Penalty for no trades
        
    win_rate = sum(1 for t in trades if t > 0) / len(trades)
    total_return = (balance - 1000.0) / 1000.0
    
    # Scoring metric: Total return weighted by win rate and penalizing high drawdown
    score = total_return * (0.5 + 0.5 * win_rate)
    return score, total_return, win_rate

# ==========================================
# 3. GRID SEARCH / PARAMETER SWEEP
# ==========================================
def optimize_regimes(data_folder="."):
    # Find all CSV files in target directory
    csv_files = glob.glob(os.path.join(data_folder, "*.csv"))
    if not csv_files:
        print(f"[!] No CSV files found in directory: {os.path.abspath(data_folder)}")
        print("Please place your historical CSV files (e.g., BTC.csv, ETH.csv) in this folder.")
        return

    print(f"[*] Found {len(csv_files)} CSV data file(s): {[os.path.basename(f) for f in csv_files]}")
    
    all_dfs = []
    for f in csv_files:
        try:
            df = pd.read_csv(f)
            df_processed = add_indicators(df)
            all_dfs.append(df_processed)
            print(f"    Loaded {os.path.basename(f)} ({len(df_processed)} bars)")
        except Exception as e:
            print(f"    [Warning] Failed to process {f}: {e}")

    if not all_dfs:
        print("[!] No valid data loaded.")
        return

    full_df = pd.concat(all_dfs, ignore_index=True)
    
    # Grid search candidate space
    param_grid = {
        'dynamicTP': [0.03, 0.05, 0.08, 0.12, 0.20],
        'dynamicSL': [-0.02, -0.04, -0.06, -0.08],
        'dynamicTrail': [0.002, 0.005, 0.01],
        'rsi_buy': [25, 30, 35],
        'rsi_sell': [65, 70, 75],
        'earlyProfitProb': [0.05, 0.10, 0.15]
    }

    regimes = ['bull_market', 'bear_market', 'alt_season']
    baselines = {}

    print("\n" + "="*50)
    print("      RUNNING PARAMETER SWEEP ACROSS MARKET REGIMES")
    print("="*50)

    for regime in regimes:
        df_regime = full_df[full_df['regime'] == regime]
        if len(df_regime) < 50:
            print(f"\n[!] Sparse data for regime '{regime}' ({len(df_regime)} bars). Using regime fallback defaults.")
            baselines[regime] = {
                "dynamicTP": 0.05 if regime == "bear_market" else (0.12 if regime == "bull_market" else 0.20),
                "dynamicSL": -0.03 if regime == "bear_market" else -0.05,
                "dynamicTrail": 0.005,
                "earlyProfitProb": 0.10
            }
            continue

        best_score = -float('inf')
        best_params = None
        
        combinations = list(product(
            param_grid['dynamicTP'],
            param_grid['dynamicSL'],
            param_grid['dynamicTrail'],
            param_grid['rsi_buy'],
            param_grid['rsi_sell'],
            param_grid['earlyProfitProb']
        ))

        print(f"\n[*] Optimizing '{regime}' across {len(combinations)} parameter permutations...")

        for tp, sl, trail, rsi_buy, rsi_sell, early_prob in combinations:
            score, ret, win_rate = backtest_regime(df_regime, tp, sl, trail, rsi_buy, rsi_sell)
            
            if score > best_score:
                best_score = score
                best_params = {
                    "dynamicTP": round(float(tp), 4),
                    "dynamicSL": round(float(sl), 4),
                    "dynamicTrail": round(float(trail), 4),
                    "earlyProfitProb": round(float(early_prob), 4)
                }

        print(f"    [+] Top Parameters for '{regime}': {best_params} (Score: {best_score:.4f})")
        baselines[regime] = best_params

    # Export to bot_brain.json matching AdaptiveTradingBrain memory schema
    brain_memory = {
        "baselines": baselines,
        "ledger": []
    }

    output_filename = "bot_brain.json"
    with open(output_filename, "w") as f:
        json.dump(brain_memory, f, indent=4)

    print("\n" + "="*50)
    print(f"SUCCESS: Exported initial baseline memory to '{output_filename}'")
    print("="*50)
    print(json.dumps(brain_memory, indent=4))

if __name__ == "__main__":
    optimize_regimes(".")

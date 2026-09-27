"""
pre_trade_risk_manager.py
=========================
Institutional Cross-Asset Risk & Gating Engine (SR 11-7 Compliance).

Enforces:
1. Macro Regime Filter: Zero 'YES' (Long) altcoin positions permitted in 'TRENDING_BEARISH' regime.
2. USDT Dominance Macro Veto: Prohibits altcoin Longs when USDT.D 1m delta > 0 (rising Tether dominance).
3. Feature Pipeline Integrity: Rejects trades with insufficient candle depth (N < 50) or static defaults.
4. Adverse Selection Circuit Breaker: Rejects blacklisted symbols with negative markout trajectories.
5. Dynamic Volatility Stop-Loss bounds: Calibrates asymmetric 1.5x ATR stops in CHOPPY_SIDEWAYS.
"""

from typing import Dict, Any, Tuple, Optional


class PreTradeRiskManager:
    ALTCOIN_IDENTIFIERS = [
        'SOL', 'KXSOL', 'XRP', 'KXXRP', 'DOGE', 'KXDOGE', 'HYPE', 'KXHYPE',
        'SHIB', 'KXSHIB', 'SUI', 'KXSUI', 'ADA', 'KXADA', 'LINK', 'KXLINK',
        'LTC', 'KXLTC', 'BCH', 'KXBCH', 'AAVE', 'KXAAVE', 'AVAX', 'KXAVAX',
        'ETH', 'KXETH', 'WLD', 'KXWLD'
    ]

    @classmethod
    def evaluate_trade(
        cls,
        symbol: str,
        side: str,
        market_regime: str,
        delta_usdt_d: float,
        rsi: float,
        atr: float,
        vpin: float = 0.22,
        candle_count: Optional[int] = None,
        is_blacklisted: bool = False,
        blacklist_remaining_sec: int = 3600
    ) -> Dict[str, Any]:
        sym = (symbol or '').upper()
        is_altcoin = any(alt in sym for alt in cls.ALTCOIN_IDENTIFIERS)
        regime = market_regime or 'CHOPPY_SIDEWAYS'

        # 1. Adverse Selection Circuit Breaker
        if is_blacklisted:
            return {
                'allowed': False,
                'code': 'ADVERSE_SELECTION_VETO',
                'reason': f"[ADVERSE SELECTION REJECTION] Suppressed trade on {symbol}. Symbol is blacklisted ({blacklist_remaining_sec}s remaining).",
                'recommended_sl': -0.02,
                'recommended_tp': 0.10
            }

        # 2. Candle Buffer Depth Warm-Up Check
        if candle_count is not None and candle_count < 50:
            return {
                'allowed': False,
                'code': 'INSUFFICIENT_BUFFER_VETO',
                'reason': f"[FEATURE BUFFER HALT] Suppressed trade on {symbol}. Insufficient candle depth ({candle_count}/50 required).",
                'recommended_sl': -0.02,
                'recommended_tp': 0.10
            }

        # 3. Feature Stasis & Static Default Check
        if abs(float(rsi) - 50.0) < 1e-6 and abs(float(atr) - 0.001) < 1e-6:
            return {
                'allowed': False,
                'code': 'FEATURE_STASIS_VETO',
                'reason': f"[FEATURE STASIS REJECTION] Suppressed trade on {symbol}. Static defaults detected (RSI=50.0, ATR=0.001).",
                'recommended_sl': -0.02,
                'recommended_tp': 0.10
            }

        # 4. Macro Regime Constraint (TRENDING_BEARISH Lockout)
        if regime == 'TRENDING_BEARISH' and side == 'YES':
            if is_altcoin:
                return {
                    'allowed': False,
                    'code': 'REGIME_VETO',
                    'reason': f"[REGIME FILTER REJECTION] Rejected YES (Long) trade on altcoin {symbol}. Zero YES altcoin positions in TRENDING_BEARISH.",
                    'recommended_sl': -0.02,
                    'recommended_tp': 0.10
                }
            else:
                if vpin >= 0.10:
                    return {
                        'allowed': False,
                        'code': 'REGIME_VETO',
                        'reason': f"[REGIME GATE DISCARD] Discarded YES (Long) on {symbol} in TRENDING_BEARISH (VPIN {vpin:.4f} >= 0.10).",
                        'recommended_sl': -0.02,
                        'recommended_tp': 0.10
                    }

        # 5. USDT Dominance Positive Delta Altcoin Long Veto
        if is_altcoin and side == 'YES':
            if delta_usdt_d > 0.0:
                return {
                    'allowed': False,
                    'code': 'USDT_DOMINANCE_VETO',
                    'reason': f"[USDT.D POSITIVE DELTA VETO] USDT.D 1m delta (+{delta_usdt_d:.4f}%) > 0. Rejected altcoin YES on {symbol}.",
                    'recommended_sl': -0.02,
                    'recommended_tp': 0.10
                }

        # 6. Dynamic Volatility-Based Stop-Loss Calibration
        live_atr = max(0.005, float(atr))
        if regime == 'CHOPPY_SIDEWAYS':
            recommended_sl = -max(0.02, min(0.05, 1.5 * live_atr))
            recommended_tp = max(0.08, 2.0 * live_atr)
        else:
            recommended_sl = -max(0.025, min(0.06, 2.0 * live_atr))
            recommended_tp = max(0.12, 3.0 * live_atr)

        return {
            'allowed': True,
            'code': 'APPROVED',
            'recommended_sl': recommended_sl,
            'recommended_tp': recommended_tp
        }

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
        blacklist_remaining_sec: int = 3600,
        **kwargs
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

        # 6. Adaptive Toxicity & Spread Quoting Guard (Audit Batch Remediation)
        # When VPIN >= 0.15 or OFI diverges against signal direction, enforce POST_ONLY_LIMIT with spread widening
        ofi_val = kwargs.get('order_flow_imbalance', 0.0)
        ob_imbalance = kwargs.get('order_book_imbalance', 1.0)
        is_elevated_vpin = vpin >= 0.15
        is_ofi_diverging = (side.upper() == 'YES' and ofi_val < 0) or (side.upper() == 'NO' and ofi_val > 0)
        is_high_imbalance = ob_imbalance > 1.30
        is_toxic_flow = is_elevated_vpin or is_ofi_diverging or is_high_imbalance

        spread_widening_bps = 0
        if is_elevated_vpin:
            spread_widening_bps = max(16, round((vpin - 0.15) * 200 + 16))
        if is_ofi_diverging:
            spread_widening_bps = max(spread_widening_bps, max(16, round(abs(ofi_val) * 100 + 16)))
        if is_high_imbalance:
            spread_widening_bps = max(spread_widening_bps, 18)

        execution_order_type = 'POST_ONLY_LIMIT' if is_toxic_flow else 'MARKET_ORDER'

        # 7. Dynamic Volatility-Based Stop-Loss Calibration
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
            'recommended_tp': recommended_tp,
            'execution_order_type': execution_order_type,
            'is_toxic_flow': is_toxic_flow,
            'spread_widening_bps': spread_widening_bps
        }

    @classmethod
    def compute_dynamic_market_regime(
        cls,
        symbol: str = '',
        base_regime: str = 'CHOPPY_SIDEWAYS',
        rsi: float = 50.0,
        atr: float = 0.012,
        band_width: float = 0.03,
        ichimoku_state: str = 'NEUTRAL_IN_CLOUD',
        delta_usdt_d: float = 0.0,
        usdt_dominance_signal: str = 'NEUTRAL',
        pattern_type: str = '',
        btc_dominance_signal: str = 'NEUTRAL',
        delta_btc_d: float = 0.0
    ) -> str:
        is_rising_usdt = (usdt_dominance_signal == 'UP') or (delta_usdt_d > 0)
        is_rising_btc_d = (btc_dominance_signal == 'UP') or (delta_btc_d > 0.01)
        is_falling_btc_d = (btc_dominance_signal == 'DOWN') or (delta_btc_d < -0.01)
        sym = (symbol or '').upper()
        is_altcoin = not ('BTC' in sym)

        # 1. Extreme overbought momentum (RSI >= 70) or Bearish Divergence
        if rsi >= 70 or pattern_type == 'STRONG_BEARISH_DIVERGENCE' or ichimoku_state == 'BEARISH_CLOUD' or (is_rising_usdt and is_altcoin):
            if rsi >= 75 or ichimoku_state == 'BEARISH_CLOUD' or pattern_type == 'STRONG_BEARISH_DIVERGENCE':
                return 'TRENDING_BEARISH'
            return 'MEAN_REVERTING'

        # 2. Extreme oversold momentum (RSI <= 30) or Bullish Cloud
        if rsi <= 30 or pattern_type == 'STRONG_BULLISH_DIVERGENCE' or (ichimoku_state == 'BULLISH_CLOUD' and not is_rising_usdt):
            if ichimoku_state == 'BULLISH_CLOUD' and not is_rising_usdt:
                return 'TRENDING_BULLISH'
            return 'MEAN_REVERTING'

        # 3. Multi-timeframe BTC.D & USDT.D Altcoin relief flow
        if is_altcoin and is_falling_btc_d and not is_rising_usdt and 45 < rsi < 65:
            return 'TRENDING_BULLISH'

        if is_altcoin and is_rising_btc_d and base_regime == 'TRENDING_BULLISH':
            return 'MEAN_REVERTING'

        # 4. Low volatility compression
        if band_width <= 0.025 and atr <= 0.008:
            return 'CHOPPY_SIDEWAYS'

        # 5. Prevent rigid TRENDING_BULLISH lockouts
        if base_regime == 'TRENDING_BULLISH' and (rsi >= 65 or is_rising_usdt or is_rising_btc_d):
            return 'MEAN_REVERTING'

        return base_regime or 'CHOPPY_SIDEWAYS'

    @classmethod
    def calculate_liquidity_tiered_sizing(
        cls,
        symbol: str,
        base_order_size: int = 10,
        order_book_imbalance: float = 1.0,
        volume_surge_ratio: float = 1.0,
        volatility_atr: float = 0.012,
        historical_slippage_usd: float = 0.0
    ) -> Dict[str, Any]:
        sym = (symbol or '').upper()
        if 'BTC' in sym or 'ETH' in sym:
            tier = 'TIER_1_MAJORS'
            tier_mult = 1.0
        elif 'SOL' in sym or 'XRP' in sym:
            tier = 'TIER_2_MIDCAP'
            tier_mult = 0.75
        else:
            tier = 'TIER_3_TAIL_ALT'
            tier_mult = 0.50

        ob_imb = max(0.01, float(order_book_imbalance))
        dist = abs(1.0 - ob_imb)
        imb_scale = round(1.0 / (1.0 + min(3.0, dist) * 0.50), 3)

        if ob_imb < 0.75:
            imb_scale = round(imb_scale * 0.50, 3)
        elif ob_imb > 1.8:
            imb_scale = round(imb_scale * max(0.35, 1.8 / ob_imb), 3)

        surge = max(0.1, float(volume_surge_ratio))
        surge_scale = round(max(0.40, min(1.20, 1.0 + (surge - 1.0) * 0.1 if surge >= 1.0 else surge)), 3)

        atr_val = max(0.001, float(volatility_atr))
        vol_scale = round(max(0.35, min(1.0, 0.015 / max(0.008, atr_val))), 3)

        slip_val = float(historical_slippage_usd)
        slip_scale = round(max(0.10, 0.008 / max(0.008, slip_val)) if slip_val > 0.008 else 1.0, 3)

        is_perp = 'PERP' in sym
        perp_mult = 0.50 if is_perp else 1.0

        combined = tier_mult * imb_scale * surge_scale * vol_scale * slip_scale * perp_mult
        scaled_size = max(1, round(base_order_size * combined))

        return {
            'scaled_order_size': scaled_size,
            'tier': tier,
            'tier_mult': tier_mult,
            'imbalance_scale': imb_scale,
            'volatility_scale': vol_scale,
            'slippage_scale': slip_scale,
            'reason': f"Tier: {tier} (x{tier_mult}) | OB Imbalance: x{imb_scale} | Vol: x{vol_scale} | Slip: x{slip_scale} => Sized {scaled_size} contracts"
        }

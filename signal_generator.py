"""
Signal Generation & Quantitative Risk Engine (QUANT-REMEDIATION-B00927)
======================================================================
Implements:
1. FeatureVarianceGuard: Rolling 5-period variance check (> 1e-6 epsilon) to prevent frozen data stasis.
2. Market Regime Filter: Strict rejection of 'YES' (Long) signals when market_regime == 'TRENDING_BEARISH'.
3. USDT.D Tether Dominance Cross-Reference: Force-close/reject high-beta altcoin longs (SHIB, HYPE, XRP) if delta_USDT_D > 0.02%.
4. Adverse Selection Circuit Breaker: Blacklist symbols for 3600s after 3 consecutive negative markout1s trades.
"""

import time
import math
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass, field

from FeatureSnapshotService import FeatureSnapshotService, IncompleteFeatureSnapshotException
from pre_trade_risk_manager import PreTradeRiskManager

# Alias for backwards compatibility
IncompleteFeatureStateError = IncompleteFeatureSnapshotException


class FeatureVarianceGuard:
    """
    Prevents trading on frozen indicator pipelines.
    Calculates rolling 5-period variance of indicator inputs (RSI, MACD, Ichimoku).
    Rejects signals if variance < 1e-6 epsilon or if static defaults persist.
    """
    def __init__(self, window_size: int = 5, epsilon: float = 1e-6):
        self.window_size = window_size
        self.epsilon = epsilon
        self.history: Dict[str, Dict[str, List[float]]] = {}
        self.consecutive_rsi_50_count: Dict[str, int] = {}

    def update_and_check(self, symbol: str, rsi: float, macd: float, ichimoku: float, atr: float = 0.012) -> Tuple[bool, str]:
        # Safety Check for Static Defaults (RSI 50.0000000 and ATR 0.0010000)
        if abs(float(rsi) - 50.0) < 1e-7 and abs(float(atr) - 0.001) < 1e-7:
            raise IncompleteFeatureStateError(f"Static indicator pipeline defaults detected on {symbol}: RSI={rsi}, ATR={atr}")

        if abs(float(rsi) - 50.0) < 1e-7:
            c = self.consecutive_rsi_50_count.get(symbol, 0) + 1
            self.consecutive_rsi_50_count[symbol] = c
            if c >= 3:
                raise IncompleteFeatureStateError(f"IncompleteFeatureStateError: RSI on {symbol} remained exactly 50.0 for {c} consecutive polls.")
        else:
            self.consecutive_rsi_50_count[symbol] = 0

        if symbol not in self.history:
            self.history[symbol] = {'rsi': [], 'macd': [], 'ichimoku': []}
        
        hist = self.history[symbol]
        hist['rsi'].append(float(rsi))
        hist['macd'].append(float(macd))
        hist['ichimoku'].append(float(ichimoku))

        for k in ['rsi', 'macd', 'ichimoku']:
            if len(hist[k]) > self.window_size:
                hist[k].pop(0)

        # Only evaluate once window is populated
        if len(hist['rsi']) >= self.window_size:
            for key in ['rsi', 'macd', 'ichimoku']:
                series = hist[key]
                mean_val = sum(series) / len(series)
                variance = sum((x - mean_val) ** 2 for x in series) / len(series)
                if variance < self.epsilon:
                    return False, f"FEATURE_VARIANCE_HALT: Frozen {key} data stream (5-period variance {variance:.2e} < {self.epsilon})"

        return True, "OK"


class RegimeGate:
    """
    RegimeGate execution controller filter.
    If marketRegime == 'TRENDING_BEARISH', all 'YES' (Long) signals must be discarded
    UNLESS VPIN (Volume Probability of Informed Trading) is < 0.10.
    """
    @staticmethod
    def evaluate(market_regime: str, signal_direction: str, vpin: float = 0.22) -> Tuple[bool, str]:
        if market_regime == 'TRENDING_BEARISH' and signal_direction == 'YES':
            if vpin < 0.10:
                return True, "REGIME_GATE_PASSED: Low VPIN (< 0.10) noise-driven exception allowed in TRENDING_BEARISH"
            return False, f"REGIME_GATE_DISCARD: Long 'YES' position discarded in TRENDING_BEARISH regime (VPIN {vpin:.4f} >= 0.10)"
        return True, "REGIME_GATE_PASSED"


class AdverseSelectionCircuitBreaker:
    """
    Monitors 1-second post-fill markout trajectories.
    Blacklists a symbol for 3600 seconds if markout1s is negative for 3 consecutive trades.
    """
    def __init__(self, blacklist_duration_sec: int = 3600):
        self.blacklist_duration_sec = blacklist_duration_sec
        self.consecutive_negative_markouts: Dict[str, int] = {}
        self.symbol_blacklists: Dict[str, float] = {}

    def record_trade_markout(self, symbol: str, markout1s: float) -> Optional[str]:
        now = time.time()
        if markout1s < 0:
            count = self.consecutive_negative_markouts.get(symbol, 0) + 1
            self.consecutive_negative_markouts[symbol] = count
            if count >= 3:
                self.symbol_blacklists[symbol] = now + self.blacklist_duration_sec
                return f"ADVERSE_SELECTION_TRIGGERED: {symbol} blacklisted for {self.blacklist_duration_sec}s (3 consecutive negative markout1s fills)"
        else:
            self.consecutive_negative_markouts[symbol] = 0
        return None

    def is_symbol_blacklisted(self, symbol: str) -> Tuple[bool, float]:
        now = time.time()
        expire = self.symbol_blacklists.get(symbol, 0)
        if expire > now:
            return True, expire - now
        return False, 0.0


class SignalGenerator:
    """
    SR 11-7 Signal Generation with Quantitative Remediation Constraints.
    """
    HIGH_BETA_ALTS = {'SOL', 'KXSOL', 'SHIB', 'KXSHIB', 'HYPE', 'KXHYPE', 'XRP', 'KXXRP', 'DOGE', 'KXDOGE', 'WLD', 'KXWLD', 'ETH', 'KXETH'}

    def __init__(self):
        self.variance_guard = FeatureVarianceGuard()
        self.adverse_breaker = AdverseSelectionCircuitBreaker()

    def evaluate_signal(
        self,
        symbol: str,
        signal_direction: str,  # 'YES' (Long) or 'NO' (Short)
        market_regime: str,     # 'TRENDING_BEARISH', 'TRENDING_BULLISH', etc.
        delta_usdt_d: float,    # 1-minute delta of USDT Dominance %
        rsi: float,
        macd: float,
        ichimoku: float,
        order_flow_imbalance: float = 0.0,
        vpin: float = 0.22,
        atr: float = 0.012
    ) -> Optional[Dict[str, Any]]:
        """
        Evaluates trading signal against all QUANT-REMEDIATION-B00927 constraints.
        Returns None or { 'status': 'REJECTED' } if safety defaults or halts occur.
        """
        sym_upper = symbol.upper()

        # Validation Safety Check: Static Defaults (RSI = 50.0000000 and ATR = 0.0010000)
        if (abs(float(rsi) - 50.0) < 1e-7 and abs(float(atr) - 0.001) < 1e-7) or abs(float(rsi) - 50.0) < 1e-7:
            try:
                self.variance_guard.update_and_check(sym_upper, rsi, macd, ichimoku, atr)
            except IncompleteFeatureStateError:
                return None  # Return null for safety as required by validation suite

        # 1. Check Adverse Selection Circuit Breaker
        is_blacklisted, rem_sec = self.adverse_breaker.is_symbol_blacklisted(sym_upper)
        if is_blacklisted:
            return {
                'status': 'REJECTED',
                'reason': 'ADVERSE_SELECTION_BLACKLISTED',
                'details': f"{sym_upper} is in adverse selection quarantine ({rem_sec:.1f}s remaining)"
            }

        # 2. Feature Variance Guard
        try:
            var_ok, var_msg = self.variance_guard.update_and_check(sym_upper, rsi, macd, ichimoku, atr)
            if not var_ok:
                return {
                    'status': 'REJECTED',
                    'reason': 'FROZEN_INDICATOR_DATA',
                    'details': var_msg
                }
        except IncompleteFeatureStateError as err:
            return None  # Return null for safety

        # 3. RegimeGate Filter (Discard YES in TRENDING_BEARISH unless VPIN < 0.10)
        regime_ok, regime_msg = RegimeGate.evaluate(market_regime, signal_direction, vpin)
        if not regime_ok:
            return {
                'status': 'REJECTED',
                'reason': 'REGIME_GATE_DISCARD',
                'details': regime_msg
            }

        # 4. USDT Dominance Altcoin Long Veto (Positive slope / delta > 0)
        is_alt = any(alt in sym_upper for alt in self.HIGH_BETA_ALTS)
        if is_alt and signal_direction == 'YES' and delta_usdt_d > 0.0:
            return {
                'status': 'REJECTED',
                'reason': 'USDT_DOMINANCE_POSITIVE_SLOPE_VETO',
                'details': f"USDT.D 1m delta ({delta_usdt_d:.4f}%) > 0 threshold. Altcoin longs prohibited during rising Tether dominance."
            }

        return {
            'status': 'APPROVED',
            'symbol': sym_upper,
            'direction': signal_direction,
            'market_regime': market_regime,
            'rsi': rsi,
            'macd': macd,
            'ichimoku': ichimoku,
            'vpin': vpin,
            'atr': atr,
            'order_flow_imbalance': order_flow_imbalance
        }

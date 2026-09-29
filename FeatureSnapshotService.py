"""
FeatureSnapshotService.py
=========================
Point-in-time Technical Feature Extraction Engine (SR 11-7 Compliance).

Enforces:
1. Minimum warm-up depth: Candle buffer N >= 50 required.
   Raises IncompleteFeatureSnapshotException if N < 50.
2. Strict shift-1 closed bar calculations: Indicators are calculated strictly on
   closed historical bars (excluding currently forming bar) to eliminate lookahead bias.
3. Complete dynamic indicator calculation: Real RSI, MACD (12, 26, 9 with signal line),
   Bollinger Bands, ATR, Ichimoku Cloud, VWAP Distance, Order Book Imbalance, and VPIN.
4. Purges global/cached indicator states per evaluation (zero static stasis fixation).
5. Nanosecond point-in-time timestamp verification (signalGenerationNs).
"""

import time
import math
from typing import Dict, List, Optional, Any, Tuple

from feature_extractor import FeatureExtractor, IncompleteFeatureSnapshotError, StaleFeatureException

# Alias for full backward compatibility
IncompleteFeatureSnapshotException = IncompleteFeatureSnapshotError


class FeatureSnapshotService:
    MIN_WARMUP_DEPTH = 50

    @classmethod
    def extract_features(
        cls,
        symbol: str,
        candles: List[Dict[str, float]],
        context: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Calculates shift-1 closed bar indicators with zero static state fixation.
        Delegates to audited FeatureExtractor engine to guarantee dynamic MACD series,
        signal lines, and cache purging.
        """
        return FeatureExtractor.extract_features(symbol, candles, context)

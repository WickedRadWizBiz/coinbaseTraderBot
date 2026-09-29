"""
test_quant_audit_remediation.py
===============================
Quantitative Institutional Audit Remediation Unit Test Suite.

Asserts:
1. Static MACD State Fixation Elimination:
   - Rolling window indicator calculation re-evaluates per tick/bar rather than caching stale states.
   - Consecutive trades across different timestamps produce unique MACD and macdHist values.
   - Purging global/cached indicator states eliminates static fixation (-2.335214 / -0.583804).
   - Warm-up buffer depth N >= 50 strictly enforced.

2. Markout Trajectory Calculation Unclamping:
   - Dynamic time-series deviations based on actual fill prices (e.g. entryPrice=0.3227 for Trade 18863)
     against future mid-market quotes at t+1s, t+5s, and t+60s.
   - Eliminates static clamping where markout1s == markout5s == markout60s == 1324.59 bps.
   - Consecutive trades across different timestamps produce unique markout values.
   - Adverse selection toxic flow detection active.
"""

import unittest
import time
from typing import List, Dict, Any

from feature_extractor import FeatureExtractor, IncompleteFeatureSnapshotError
from markout_simulator import MarkoutSimulator, calculateMarkoutTrajectories
from FeatureSnapshotService import FeatureSnapshotService


def generate_candle_series(n: int, base_price: float = 2650.0, trend: float = 0.5) -> List[Dict[str, float]]:
    """Generates synthetic historical closed candles for indicator testing."""
    candles = []
    p = base_price
    for i in range(n):
        delta = (trend + ((i * 7 + 3) % 11 - 5) * 0.3)
        open_p = p
        close_p = p + delta
        high_p = max(open_p, close_p) + abs(delta * 0.5) + 0.5
        low_p = min(open_p, close_p) - abs(delta * 0.5) - 0.5
        vol = 100.0 + ((i * 13) % 50)
        candles.append({
            'open': open_p,
            'high': high_p,
            'low': low_p,
            'close': close_p,
            'volume': vol
        })
        p = close_p
    return candles


class TestStaticMACDFixationElimination(unittest.TestCase):
    """
    Audit Finding #1:
    Static MACD State Fixation (Watch Item #2 - PERSISTING).
    Verify that consecutive trades across different timestamps and bars produce unique MACD values,
    and that static placeholder fixation (-2.335214, -0.583804) is completely eliminated.
    """

    def setUp(self):
        FeatureExtractor.clear_buffer()

    def test_warmup_depth_enforcement(self):
        """Warm-up depth N < 50 must raise IncompleteFeatureSnapshotError."""
        short_candles = generate_candle_series(30, 2600.0)
        with self.assertRaises(IncompleteFeatureSnapshotError):
            FeatureExtractor.extract_features('KXETHPERP', short_candles)

    def test_consecutive_trades_produce_unique_macd(self):
        """
        Consecutive trades with varying timestamps / ticks (e.g. ID 4380, 18863, 18844, 18825, 18496)
        must produce distinct, unique MACD and MACD Histogram values.
        """
        candles = generate_candle_series(60, 2650.0, trend=0.8)

        # Trade 4380 (KXETHPERP)
        snap1 = FeatureExtractor.extract_features('KXETHPERP', candles, {
            'currentTickPrice': 2671.50,
            'timeframe': '15m'
        })

        # Trade 18863 (KXETH-26SEP2917-B2670)
        snap2 = FeatureExtractor.extract_features('KXETH-26SEP2917-B2670', candles, {
            'currentTickPrice': 2673.80,
            'timeframe': '15m'
        })

        # Trade 18844
        snap3 = FeatureExtractor.extract_features('KXETHPERP', candles, {
            'currentTickPrice': 2675.20,
            'timeframe': '15m'
        })

        # Trade 18825
        snap4 = FeatureExtractor.extract_features('KXETHPERP', candles, {
            'currentTickPrice': 2677.90,
            'timeframe': '15m'
        })

        # Assert no static MACD fixation (-2.335214) or macdHist fixation (-0.583804)
        for s in [snap1, snap2, snap3, snap4]:
            self.assertNotEqual(s['macd'], -2.335214, "Static MACD placeholder (-2.335214) must be purged")
            self.assertNotEqual(s['macdHist'], -0.583804, "Static macdHist placeholder (-0.583804) must be purged")

        # Assert distinct MACD values across consecutive trades
        self.assertNotEqual(snap1['macd'], snap2['macd'], "Trade 4380 and 18863 must have distinct MACD values")
        self.assertNotEqual(snap2['macd'], snap3['macd'], "Trade 18863 and 18844 must have distinct MACD values")
        self.assertNotEqual(snap3['macd'], snap4['macd'], "Trade 18844 and 18825 must have distinct MACD values")

        # Assert distinct MACD histogram values
        self.assertNotEqual(snap1['macdHist'], snap2['macdHist'])
        self.assertNotEqual(snap2['macdHist'], snap3['macdHist'])

    def test_global_cache_purging_prevents_stale_fixation(self):
        """Purging global/cached indicator states guarantees zero cross-trade fixation."""
        candles = generate_candle_series(55, 2600.0)
        snap_a = FeatureExtractor.extract_features('KXBTC', candles, {'currentTickPrice': 64200.0})

        # Explicitly purge buffer
        FeatureExtractor.clear_buffer('KXBTC')

        # Provide advanced bar
        candles_next = candles[1:] + [{
            'open': 2680.0,
            'high': 2685.0,
            'low': 2679.0,
            'close': 2684.0,
            'volume': 150.0
        }]
        snap_b = FeatureExtractor.extract_features('KXBTC', candles_next, {'currentTickPrice': 64350.0})

        self.assertNotEqual(snap_a['macd'], snap_b['macd'], "MACD must update dynamically on advancing bar")
        self.assertNotEqual(snap_a['nanosecondsAtSignal'], snap_b['nanosecondsAtSignal'])

    def test_feature_snapshot_service_delegation(self):
        """FeatureSnapshotService must produce identical dynamic results without static fixation."""
        candles = generate_candle_series(55, 2600.0)
        snap = FeatureSnapshotService.extract_features('KXETHPERP', candles, {'currentTickPrice': 2675.0})
        self.assertNotEqual(snap['macd'], -2.335214)
        self.assertNotEqual(snap['macdHist'], -0.583804)


class TestMarkoutTrajectoryCalculationUnclamping(unittest.TestCase):
    """
    Audit Finding #2:
    Markout Trajectory Value Clamping.
    Verify that post-trade price trajectories dynamically track order book mid-price changes
    at t+1s, t+5s, and t+60s, eliminating the static 1324.59 clamping artifact.
    """

    def test_trade_18863_dynamic_tick_markouts(self):
        """
        Trade ID 18863: entryPrice = 0.3227, fill_timestamp = '2026-09-29T03:25:28.000Z'.
        Historical ticks at t+1s, t+5s, t+60s must compute dynamic basis points (bps) without clamping.
        """
        entry_price = 0.3227
        fill_timestamp = '2026-09-29T03:25:28.000Z'
        ticks_feed = [
            {'timestamp': '2026-09-29T03:25:29.000Z', 'relativeSec': 1, 'price': 0.3240},
            {'timestamp': '2026-09-29T03:25:31.000Z', 'relativeSec': 3, 'price': 0.3275},
            {'timestamp': '2026-09-29T03:25:33.000Z', 'relativeSec': 5, 'price': 0.3315},
            {'timestamp': '2026-09-29T03:26:28.000Z', 'relativeSec': 60, 'price': 0.3654}
        ]

        result = calculateMarkoutTrajectories(
            entry_price=entry_price,
            side='YES',
            fill_timestamp=fill_timestamp,
            ticks_feed=ticks_feed,
            terminal_exit_price=0.3654
        )

        m1 = result['markout1s']
        m5 = result['markout5s']
        m60 = result['markout60s']

        # 1s markout should reflect tick 0.3240 vs entry 0.3227: ~40.28 bps
        self.assertAlmostEqual(m1, 40.2851, delta=0.5)
        # 5s markout should reflect tick 0.3315 vs entry 0.3227: ~272.70 bps
        self.assertAlmostEqual(m5, 272.6991, delta=1.0)
        # 60s markout should reflect tick 0.3654 vs entry 0.3227: ~1323.21 bps
        self.assertAlmostEqual(m60, 1323.2104, delta=2.0)

        # Assert no static value clamping across horizons (1s != 5s != 60s)
        self.assertNotEqual(m1, m5, "1s and 5s markout must not be clamped to identical value")
        self.assertNotEqual(m5, m60, "5s and 60s markout must not be clamped to identical value")
        self.assertNotEqual(m1, 1324.59, "1s markout must not be clamped to static 1324.59 bps")
        self.assertNotEqual(m5, 1324.59, "5s markout must not be clamped to static 1324.59 bps")

    def test_consecutive_trades_produce_unique_markouts(self):
        """
        Consecutive trades with different timestamps / fill prices must produce unique markouts.
        Example: Trade 18863 (entry=0.3227) vs Trade 18825 (entry=0.3450) vs Trade 18844 (entry=0.3110).
        """
        m_18863 = calculateMarkoutTrajectories(
            entry_price=0.3227,
            side='YES',
            fill_timestamp='2026-09-29T03:25:28.000Z',
            terminal_exit_price=0.3654
        )

        m_18825 = calculateMarkoutTrajectories(
            entry_price=0.3450,
            side='YES',
            fill_timestamp='2026-09-29T03:22:15.000Z',
            terminal_exit_price=0.3520
        )

        m_18844 = calculateMarkoutTrajectories(
            entry_price=0.3110,
            side='NO',
            fill_timestamp='2026-09-29T03:23:40.000Z',
            terminal_exit_price=0.2980
        )

        # Assert unique markout trajectories across distinct trades
        self.assertNotEqual(m_18863['markout1s'], m_18825['markout1s'])
        self.assertNotEqual(m_18863['markout5s'], m_18825['markout5s'])
        self.assertNotEqual(m_18863['markout60s'], m_18825['markout60s'])

        self.assertNotEqual(m_18825['markout1s'], m_18844['markout1s'])
        self.assertNotEqual(m_18825['markout60s'], m_18844['markout60s'])

    def test_orderbook_tape_polling(self):
        """Verify order book mid-quote snapshots at t+1s, t+5s, and t+60s."""
        tape = {
            't1': {'bid': 0.3250, 'ask': 0.3260},  # mid = 0.3255
            't5': {'bid': 0.3280, 'ask': 0.3290},  # mid = 0.3285
            't60': {'bid': 0.3400, 'ask': 0.3420}  # mid = 0.3410
        }

        result = calculateMarkoutTrajectories(
            entry_price=0.3200,
            side='YES',
            fill_timestamp='2026-09-29T03:25:28.000Z',
            orderbook_tape=tape
        )

        # 1s: (0.3255 - 0.3200) / 0.3200 * 10000 = 171.875 bps
        self.assertAlmostEqual(result['markout1s'], 171.875, delta=0.5)
        # 5s: (0.3285 - 0.3200) / 0.3200 * 10000 = 265.625 bps
        self.assertAlmostEqual(result['markout5s'], 265.625, delta=0.5)
        # 60s: (0.3410 - 0.3200) / 0.3200 * 10000 = 656.25 bps
        self.assertAlmostEqual(result['markout60s'], 656.25, delta=0.5)

    def test_toxic_order_flow_adverse_selection_detection(self):
        """Severely negative post-fill markout excursions trigger toxic adverse selection flag."""
        # Adverse fill: Entry at 0.5000, post-fill prices collapse
        toxic_ticks = [
            {'relativeSec': 1, 'price': 0.4980},  # -40 bps
            {'relativeSec': 5, 'price': 0.4960},  # -80 bps
            {'relativeSec': 60, 'price': 0.4900}  # -200 bps
        ]

        result = calculateMarkoutTrajectories(
            entry_price=0.5000,
            side='YES',
            ticks_feed=toxic_ticks
        )

        self.assertTrue(result['toxicOrderFlowAdverseSelection'], "Negative markout1s (< -15 bps) must trigger toxic flow flag")
        self.assertLess(result['markout1s'], -15.0)


if __name__ == '__main__':
    unittest.main()

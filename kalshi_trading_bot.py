"""
Kalshi High-Frequency Trading Bot Architecture & RL Neural Network Engine
=========================================================================
Implements:
1. KalshiFeeCalculator (Probability-curve fee schedules, Net PnL, Dynamic TSL Net Floor)
2. RateLimitManager (Asynchronous Token Bucket with 4 independent channels, 3s burst bank, 429 backoff)
3. TradingEnvironment & Neural Network (Gym-compatible RL environment, Tennis live state, Net reward)
"""

import time
import math
import random
import asyncio
from typing import Dict, Tuple, Optional, Any
from dataclasses import dataclass
from enum import Enum

try:
    import torch
    import torch.nn as nn
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False
    torch = None
    nn = object  # type: ignore

try:
    import numpy as np
except ImportError:
    class MockNP:
        float32 = float
        ndarray = Any
        @staticmethod
        def array(lst, dtype=None):
            return lst
        @staticmethod
        def concatenate(arrays):
            res = []
            for a in arrays:
                if isinstance(a, list):
                    res.extend(a)
                elif hasattr(a, 'tolist'):
                    res.extend(a.tolist())
                else:
                    res.extend(list(a))
            return res
    np = MockNP()  # type: ignore


# =====================================================================
# 1. KALSHI FEE CALCULATOR & NET PNL ENGINE
# =====================================================================

class MarketType(Enum):
    PREDICTION = "PREDICTION"
    PERPETUAL = "PERPETUAL"
    TENNIS = "TENNIS"


class KalshiFeeCalculator:
    """
    Implements Kalshi's exact variable probability-curve fee logic,
    settlement rules, and dynamic net-profit trailing stop loss (TSL).
    """

    @staticmethod
    def calculate_contract_fee(
        price: float, 
        contracts: int, 
        is_maker: bool = False, 
        is_settlement: bool = False,
        is_perp: bool = False,
        perp_fee_bps: float = 5.0
    ) -> float:
        """
        Calculates the execution fee in USD.
        
        Event Contracts & Tennis:
            Taker Fee = ceil(0.07 * Contracts * Price * (1 - Price)) in dollars (cents ceiling)
            Maker Fee = 50% of Taker Fee
            Settlement Fee = $0.00 (holding to expiry incurs zero exit fees)
            
        Perpetuals:
            Fee = Notional * (bps / 10,000)
        """
        if is_settlement:
            return 0.0  # Settlement incurs $0 exit fees

        if is_perp:
            notional = price * contracts
            bps = perp_fee_bps * 0.5 if is_maker else perp_fee_bps
            return notional * (bps / 10000.0)

        # Normalize probability price to [0.01, 0.99]
        p = max(0.01, min(0.99, float(price)))
        
        # Raw variable fee curve in cents: ceil(7 * contracts * p * (1 - p))
        # Scaled to dollars: ceil(0.07 * contracts * p * (1-p) * 100) / 100
        raw_taker_fee_cents = math.ceil(7.0 * contracts * p * (1.0 - p))
        max_taker_fee_cents = 7.0 * contracts
        taker_fee_cents = min(raw_taker_fee_cents, max_taker_fee_cents)

        if is_maker:
            # Maker fee is exactly 50% of the taker fee
            maker_fee_cents = math.ceil(taker_fee_cents * 0.5)
            return maker_fee_cents / 100.0
        else:
            return taker_fee_cents / 100.0

    @classmethod
    def calculate_net_pnl(
        cls,
        entry_price: float,
        exit_price: float,
        contracts: int,
        is_long: bool = True,
        is_maker_entry: bool = True,
        is_maker_exit: bool = False,
        is_settlement: bool = False,
        is_perp: bool = False,
        perp_fee_bps: float = 5.0
    ) -> Tuple[float, float, float, float]:
        """
        Calculates Net PnL strictly accounting for entry fees, exit fees,
        and settlement cost structures.

        Returns: (net_pnl, gross_pnl, entry_fee, exit_fee)
        """
        # Gross PnL
        if is_long:
            gross_pnl = (exit_price - entry_price) * contracts
        else:
            gross_pnl = (entry_price - exit_price) * contracts

        # Entry Fee
        entry_fee = cls.calculate_contract_fee(
            price=entry_price,
            contracts=contracts,
            is_maker=is_maker_entry,
            is_settlement=False,
            is_perp=is_perp,
            perp_fee_bps=perp_fee_bps
        )

        # Exit Fee ($0 if held to settlement)
        exit_fee = cls.calculate_contract_fee(
            price=exit_price,
            contracts=contracts,
            is_maker=is_maker_exit,
            is_settlement=is_settlement,
            is_perp=is_perp,
            perp_fee_bps=perp_fee_bps
        )

        net_pnl = gross_pnl - (entry_fee + exit_fee)
        return net_pnl, gross_pnl, entry_fee, exit_fee

    @classmethod
    def calculate_dynamic_tsl_price(
        cls,
        entry_price: float,
        contracts: int,
        target_net_profit: float = 0.01,
        is_long: bool = True,
        is_maker_entry: bool = True,
        is_perp: bool = False,
        perp_fee_bps: float = 5.0
    ) -> float:
        """
        Dynamically solves for the exact stop price that guarantees the
        Trailing Stop Loss (TSL) executes with a positive Net PnL floor
        even after paying full market Taker exit fees.
        """
        entry_fee = cls.calculate_contract_fee(
            price=entry_price,
            contracts=contracts,
            is_maker=is_maker_entry,
            is_settlement=False,
            is_perp=is_perp,
            perp_fee_bps=perp_fee_bps
        )

        # Binary search / iterative solver for the exit price
        low, high = 0.01, 0.99
        best_price = entry_price

        for _ in range(25):
            mid = (low + high) / 2.0
            taker_exit_fee = cls.calculate_contract_fee(
                price=mid,
                contracts=contracts,
                is_maker=False,  # TSL fires as aggressive market taker
                is_settlement=False,
                is_perp=is_perp,
                perp_fee_bps=perp_fee_bps
            )

            if is_long:
                net = (mid - entry_price) * contracts - (entry_fee + taker_exit_fee)
                if net >= target_net_profit:
                    best_price = mid
                    high = mid
                else:
                    low = mid
            else:
                net = (entry_price - mid) * contracts - (entry_fee + taker_exit_fee)
                if net >= target_net_profit:
                    best_price = mid
                    low = mid
                else:
                    high = mid

        return round(best_price, 2)


# =====================================================================
# 2. ASYNCHRONOUS KALSHI RATE LIMIT MANAGER (TOKEN BUCKET)
# =====================================================================

class BucketCategory(Enum):
    PREDICTIONS_READ = "PREDICTIONS_READ"
    PREDICTIONS_WRITE = "PREDICTIONS_WRITE"
    PERPS_READ = "PERPS_READ"
    PERPS_WRITE = "PERPS_WRITE"


@dataclass
class TokenBucket:
    name: BucketCategory
    capacity: float
    refill_rate_per_sec: float
    tokens: float
    last_refill: float
    circuit_open: bool = False
    cooldown_until: float = 0.0
    consecutive_429s: int = 0


class RateLimitManager:
    """
    Asynchronous continuous token bucket manager.
    - 4 Independent sharded buckets
    - Continuous millisecond token refills
    - 3s burst capacity for write buckets (Advanced tier)
    - Dynamic exponential backoff + jitter on 429
    - Priority reservation: CRITICAL (stops/cancels) never blocked; LOW shed under load
    """

    def __init__(self, tier: str = "Advanced"):
        self.tier = tier
        now = time.time()

        # Tier capacities: Advanced = 300R/300W with 3s write burst bank
        read_rate = 300.0 if tier == "Advanced" else 200.0
        write_rate = 300.0 if tier == "Advanced" else 100.0
        write_burst = write_rate * 3.0 if tier != "Basic" else write_rate

        self.buckets: Dict[BucketCategory, TokenBucket] = {
            BucketCategory.PREDICTIONS_READ: TokenBucket(
                name=BucketCategory.PREDICTIONS_READ,
                capacity=read_rate,
                refill_rate_per_sec=read_rate,
                tokens=read_rate,
                last_refill=now
            ),
            BucketCategory.PREDICTIONS_WRITE: TokenBucket(
                name=BucketCategory.PREDICTIONS_WRITE,
                capacity=write_burst,
                refill_rate_per_sec=write_rate,
                tokens=write_burst,
                last_refill=now
            ),
            BucketCategory.PERPS_READ: TokenBucket(
                name=BucketCategory.PERPS_READ,
                capacity=read_rate,
                refill_rate_per_sec=read_rate,
                tokens=read_rate,
                last_refill=now
            ),
            BucketCategory.PERPS_WRITE: TokenBucket(
                name=BucketCategory.PERPS_WRITE,
                capacity=write_burst,
                refill_rate_per_sec=write_rate,
                tokens=write_burst,
                last_refill=now
            )
        }

    def _refill(self, bucket: TokenBucket):
        now = time.time()
        elapsed = now - bucket.last_refill
        if elapsed > 0:
            added = elapsed * bucket.refill_rate_per_sec
            bucket.tokens = min(bucket.capacity, bucket.tokens + added)
            bucket.last_refill = now

        if bucket.circuit_open and now >= bucket.cooldown_until:
            bucket.circuit_open = False

    def get_token_cost(self, category: BucketCategory, is_cancel: bool = False, batch_size: int = 1) -> float:
        """
        Exact token cost calculation:
        - Default request: 10 tokens
        - Batch request: 10 * N tokens
        - Perps cancel: 1 token
        - Predictions batch cancel: 2 tokens per order
        """
        if is_cancel:
            if category == BucketCategory.PERPS_WRITE:
                return 1.0 * batch_size
            else:
                return 2.0 * batch_size if batch_size > 1 else 10.0
        return 10.0 * batch_size

    async def acquire_tokens(
        self,
        category: BucketCategory,
        cost: float,
        priority: str = "NORMAL"
    ) -> bool:
        """
        Asynchronously acquires tokens from the specific bucket.
        Priority 'CRITICAL' waits for refills; 'LOW' sheds if bucket is saturated.
        """
        bucket = self.buckets[category]

        while True:
            self._refill(bucket)

            if bucket.circuit_open and priority != "CRITICAL":
                return False  # Shed non-critical during backoff cooldown

            # Shed low priority if bucket saturation < 35%
            saturation = bucket.tokens / bucket.capacity
            if priority == "LOW" and saturation < 0.35:
                return False

            if bucket.tokens >= cost:
                bucket.tokens -= cost
                return True

            if priority == "LOW":
                return False

            # Wait exact deficit time
            deficit = cost - bucket.tokens
            wait_time = max(0.01, deficit / bucket.refill_rate_per_sec)
            await asyncio.sleep(wait_time)

    def handle_429(self, category: BucketCategory):
        """
        Triggered when a 429 Too Many Requests is returned.
        Applies exponential backoff with randomized jitter.
        """
        bucket = self.buckets[category]
        bucket.tokens = 0.0
        bucket.circuit_open = True
        bucket.consecutive_429s += 1

        # Exponential backoff: Base 250ms * 1.8^N + jitter (max 2.5s)
        base = min(2.5, 0.25 * (1.8 ** min(4, bucket.consecutive_429s - 1)))
        jitter = random.uniform(0.02, 0.15)
        bucket.cooldown_until = time.time() + base + jitter

    def get_state_vector(self) -> np.ndarray:
        """
        Returns normalized token availability across all 4 buckets for the RL observation space.
        """
        now = time.time()
        ratios = []
        for cat in [
            BucketCategory.PREDICTIONS_READ,
            BucketCategory.PREDICTIONS_WRITE,
            BucketCategory.PERPS_READ,
            BucketCategory.PERPS_WRITE
        ]:
            b = self.buckets[cat]
            self._refill(b)
            ratios.append(b.tokens / b.capacity)
        return np.array(ratios, dtype=np.float32)


# =====================================================================
# 3. LIVE TENNIS MATCH STATE INGESTION
# =====================================================================

@dataclass
class TennisMatchState:
    set_score: Tuple[int, int] = (0, 0)      # (Player1 Sets, Player2 Sets)
    game_score: Tuple[int, int] = (0, 0)     # (Player1 Games, Player2 Games)
    point_score: Tuple[str, str] = ("0", "0") # e.g. ("40", "30"), ("AD", "40")
    is_p1_serving: bool = True
    is_break_point: bool = False
    is_set_point: bool = False
    is_match_point: bool = False
    momentum_index: float = 0.0              # [-1.0 (P2 dominance) to +1.0 (P1 dominance)]
    game_state_changed_ms_ago: float = 50.0  # Latency since last point update

    def to_vector(self) -> np.ndarray:
        p_map = {"0": 0.0, "15": 0.25, "30": 0.5, "40": 0.75, "AD": 1.0}
        p1_pt = p_map.get(self.point_score[0], 0.0)
        p2_pt = p_map.get(self.point_score[1], 0.0)

        return np.array([
            self.set_score[0] / 3.0,
            self.set_score[1] / 3.0,
            self.game_score[0] / 7.0,
            self.game_score[1] / 7.0,
            p1_pt,
            p2_pt,
            1.0 if self.is_p1_serving else 0.0,
            1.0 if self.is_break_point else 0.0,
            1.0 if self.is_set_point else 0.0,
            1.0 if self.is_match_point else 0.0,
            (self.momentum_index + 1.0) / 2.0,
            min(1.0, self.game_state_changed_ms_ago / 2000.0)
        ], dtype=np.float32)


# =====================================================================
# 4. PYTORCH TRADING ENVIRONMENT & RL STEP FUNCTION
# =====================================================================

class TradingEnvironment:
    """
    Reinforcement Learning environment implementing:
    - State Space: Orderbook, Token Buckets, Net PnL, Time-to-Expiry, Live Tennis State
    - Action Space: [0] Hold, [1] Taker Order, [2] Maker Order, [3] Cancel All Orders
    - Reward Function: Pure Net PnL + Maker Incentive + Over-trading penalty + Adverse Selection Guard
    """

    def __init__(self):
        self.fee_calc = KalshiFeeCalculator()
        self.rate_limiter = RateLimitManager(tier="Advanced")
        self.reset()

    def reset(self) -> np.ndarray:
        self.time_step = 0
        self.max_steps = 200
        self.position = 0               # Contracts held (+ Long, - Short)
        self.entry_price = 0.0
        self.is_maker_entry = False
        self.resting_order_side: Optional[str] = None
        self.resting_order_price = 0.0
        self.total_net_pnl = 0.0
        self.trade_count = 0
        self.maker_fills = 0
        self.taker_fills = 0

        # Market simulation
        self.mid_price = 0.50
        self.spread = 0.02
        self.bid_depth = 150
        self.ask_depth = 150
        self.time_to_expiration_norm = 1.0
        self.tennis_state = TennisMatchState()

        return self._get_observation()

    def _get_observation(self) -> np.ndarray:
        """
        Constructs the comprehensive 24-dimensional state space.
        """
        bid = round(self.mid_price - self.spread / 2.0, 2)
        ask = round(self.mid_price + self.spread / 2.0, 2)

        # Current hypothetical net exit value
        unrealized_net_pnl = 0.0
        if self.position != 0:
            exit_price = bid if self.position > 0 else ask
            unrealized_net_pnl, _, _, _ = self.fee_calc.calculate_net_pnl(
                entry_price=self.entry_price,
                exit_price=exit_price,
                contracts=abs(self.position),
                is_long=(self.position > 0),
                is_maker_entry=self.is_maker_entry,
                is_maker_exit=False,  # Immediate taker exit scenario
                is_settlement=False
            )

        # 1. Orderbook & Market State (6)
        ob_state = np.array([
            self.mid_price,
            self.spread,
            bid,
            ask,
            min(1.0, self.bid_depth / 500.0),
            min(1.0, self.ask_depth / 500.0)
        ], dtype=np.float32)

        # 2. Position & Risk State (4)
        pos_state = np.array([
            self.position / 100.0,
            self.entry_price,
            unrealized_net_pnl,
            self.time_to_expiration_norm
        ], dtype=np.float32)

        # 3. Rate Limit Token Buckets (4)
        rate_state = self.rate_limiter.get_state_vector()

        # 4. Live Tennis Match Context (12)
        tennis_vector = self.tennis_state.to_vector()

        # Combine into complete state observation vector (26 features)
        return np.concatenate([ob_state, pos_state, rate_state, tennis_vector])

    def step(self, action: int) -> Tuple[np.ndarray, float, bool, Dict[str, Any]]:
        """
        Executes trading actions and computes the Net PnL reward.

        Action Space:
            0: Hold / Do Nothing
            1: Taker Market Order (Cross the spread immediately)
            2: Maker Limit Order (Rest at inside bid/ask)
            3: Cancel All Resting Orders
        """
        self.time_step += 1
        self.time_to_expiration_norm = max(0.0, 1.0 - (self.time_step / self.max_steps))
        reward = 0.0
        info = {"action_executed": action, "net_pnl": 0.0}

        bid = round(max(0.01, self.mid_price - self.spread / 2.0), 2)
        ask = round(min(0.99, self.mid_price + self.spread / 2.0), 2)
        is_settlement = (self.time_step >= self.max_steps)

        # -------------------------------------------------------------
        # 1. Action Execution
        # -------------------------------------------------------------
        if action == 0:
            # HOLD: Passive step
            reward += 0.0001  # Micro reward for patience / avoiding churn

        elif action == 1:
            # TAKER ORDER: Cross spread immediately (High urgency)
            self.trade_count += 1
            self.taker_fills += 1
            order_contracts = 10

            if self.position == 0:
                # Open Long at Ask
                self.position = order_contracts
                self.entry_price = ask
                self.is_maker_entry = False
                # Penalize immediate entry fee to teach model crossing costs
                fee = self.fee_calc.calculate_contract_fee(ask, order_contracts, is_maker=False)
                reward -= fee * 1.2  # Slight deterrence against over-crossing
            else:
                # Close existing position at market
                exit_price = bid if self.position > 0 else ask
                net_pnl, _, entry_fee, exit_fee = self.fee_calc.calculate_net_pnl(
                    entry_price=self.entry_price,
                    exit_price=exit_price,
                    contracts=abs(self.position),
                    is_long=(self.position > 0),
                    is_maker_entry=self.is_maker_entry,
                    is_maker_exit=False,
                    is_settlement=False
                )
                self.total_net_pnl += net_pnl
                reward += net_pnl
                info["net_pnl"] = net_pnl
                self.position = 0

        elif action == 2:
            # MAKER ORDER: Place resting limit order
            self.resting_order_side = "BUY"
            self.resting_order_price = bid
            
            # Simulate 40% fill probability on next tick
            filled = random.random() < 0.40
            if filled and self.position == 0:
                self.trade_count += 1
                self.maker_fills += 1
                self.position = 10
                self.entry_price = bid
                self.is_maker_entry = True
                
                # Maker Incentive Bonus: Reward model for liquidity provision
                maker_bonus = 0.005 * 10
                reward += maker_bonus

        elif action == 3:
            # CANCEL RESTING ORDERS: Avoid adverse selection on score shift
            had_resting = self.resting_order_side is not None
            self.resting_order_side = None

            if had_resting:
                # If adverse game state occurred (e.g. break point against us), reward timely cancellation
                if self.tennis_state.is_break_point:
                    reward += 0.015  # Adverse selection avoided!
                else:
                    reward -= 0.001  # Minor token cost penalty

        # -------------------------------------------------------------
        # 2. Settlement / Expiration Logic ($0 Exit Fees)
        # -------------------------------------------------------------
        if is_settlement and self.position != 0:
            settle_price = 1.0 if self.mid_price >= 0.50 else 0.0
            net_pnl, gross, _, _ = self.fee_calc.calculate_net_pnl(
                entry_price=self.entry_price,
                exit_price=settle_price,
                contracts=abs(self.position),
                is_long=(self.position > 0),
                is_maker_entry=self.is_maker_entry,
                is_settlement=True  # 100% Zero exit fee
            )
            self.total_net_pnl += net_pnl
            # Settlement incentive: Reward holding winning predictions to zero-fee settlement
            reward += net_pnl + (0.01 * abs(self.position) if net_pnl > 0 else 0.0)
            self.position = 0

        # -------------------------------------------------------------
        # 3. Over-Trading Churn Penalty
        # -------------------------------------------------------------
        if self.trade_count > 15:
            churn_penalty = 0.002 * (self.trade_count - 15)
            reward -= churn_penalty

        # -------------------------------------------------------------
        # 4. Market & Tennis Score Simulation Step
        # -------------------------------------------------------------
        self.mid_price = max(0.05, min(0.95, self.mid_price + random.gauss(0, 0.015)))
        # Momentum random walk
        self.tennis_state.momentum_index = max(-1.0, min(1.0, self.tennis_state.momentum_index + random.gauss(0, 0.1)))
        self.tennis_state.is_break_point = (random.random() < 0.12)

        done = (self.time_step >= self.max_steps)
        obs = self._get_observation()

        return obs, reward, done, info


# =====================================================================
# 5. HIGH-FREQUENCY NEURAL NETWORK ACTOR-CRITIC POLICY
# =====================================================================

base_nn_module = nn.Module if HAS_TORCH else object

class KalshiPolicyNetwork(base_nn_module):  # type: ignore
    """
    Actor-Critic PyTorch neural network for high-frequency Kalshi execution.
    Ingests market microstructures, tennis state, rate limits, and net PnL.
    """

    def __init__(self, input_dim: int = 26, action_dim: int = 4):
        if HAS_TORCH:
            super(KalshiPolicyNetwork, self).__init__()

            # Feature Extractor Backbone
            self.shared_net = nn.Sequential(
                nn.Linear(input_dim, 128),
                nn.LayerNorm(128),
                nn.SiLU(),
                nn.Linear(128, 128),
                nn.LayerNorm(128),
                nn.SiLU()
            )

            # Actor Head (Action Logits)
            self.actor = nn.Sequential(
                nn.Linear(128, 64),
                nn.SiLU(),
                nn.Linear(64, action_dim)
            )

            # Critic Head (Value function for Net PnL expectation)
            self.critic = nn.Sequential(
                nn.Linear(128, 64),
                nn.SiLU(),
                nn.Linear(64, 1)
            )

    def forward(self, state: Any) -> Tuple[Any, Any]:
        if not HAS_TORCH:
            raise RuntimeError("PyTorch is required to execute forward pass")
        features = self.shared_net(state)
        action_logits = self.actor(features)
        value = self.critic(features)
        return action_logits, value

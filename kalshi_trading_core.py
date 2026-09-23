"""
Kalshi High-Frequency Trading Bot Architecture & Neural Network Implementation
Components:
1. KalshiFeeCalculator: Net PnL, probability-curve taker/maker fee schedule, and TSL projection.
2. RateLimitManager: Dual-engine token-bucket manager (Predictions vs. Perps, Read vs. Write, 3x burst).
3. TradingEnvironment: PyTorch/Gymnasium-compatible RL trading environment with Tennis state space.
"""

import math
import time
import asyncio
from typing import Dict, Tuple, Optional, Any
from dataclasses import dataclass

try:
    import torch
    import numpy as np
except ImportError:
    torch = None
    np = None


# =====================================================================
# 1. KALSHI FEE CALCULATOR & NET PnL LOGIC
# =====================================================================

class KalshiFeeCalculator:
    """
    Computes exact Kalshi exchange fees and Net PnL.
    
    Kalshi Event Contracts & Live Sports (Tennis) Fee Schedule:
      - Variable fee based on probability curve: Price * (1 - Price).
      - Taker Fee: ceil(0.07 * Contracts * Price * (1 - Price)), capped at $0.07 per contract.
      - Maker Fee: 50% of Taker fee, capped at $0.035 per contract.
      - Settlement Fee: $0.00 when held through contract resolution/expiry.
    
    Perpetual Futures Fee Schedule:
      - Variable bps schedule based on dynamic API rates (e.g. 2 to 5 bps on notional).
    """

    MAX_PREDICTION_TAKER_FEE_PER_CONTRACT = 0.07
    MAX_PREDICTION_MAKER_FEE_PER_CONTRACT = 0.035

    @classmethod
    def calculate_prediction_fee(
        cls,
        price: float,
        contracts: int,
        is_maker: bool = False,
        is_settlement: bool = False
    ) -> float:
        """
        Calculates fee in USD for a Predictions (Event/Tennis) contract order.
        Settlement incurs $0 exit fee.
        """
        if is_settlement or contracts <= 0:
            return 0.0

        # Price normalized to [0.0, 1.0]
        p = max(0.0, min(1.0, float(price)))
        
        # Raw probability curve fee: 0.07 * Contracts * P * (1 - P)
        raw_taker_fee = 0.07 * contracts * p * (1.0 - p)
        # Apply ceiling to the cent
        taker_fee = math.ceil(raw_taker_fee * 100.0) / 100.0
        # Cap at maximum taker fee ($0.07 * contracts)
        taker_fee = min(taker_fee, cls.MAX_PREDICTION_TAKER_FEE_PER_CONTRACT * contracts)

        if is_maker:
            # Maker orders receive 50% discount
            maker_fee = round(taker_fee * 0.50, 4)
            return min(maker_fee, cls.MAX_PREDICTION_MAKER_FEE_PER_CONTRACT * contracts)

        return taker_fee

    @classmethod
    def calculate_perpetual_fee(
        cls,
        price: float,
        contracts: int,
        contract_size: float = 1.0,
        bps: float = 2.0,
        is_maker: bool = False
    ) -> float:
        """
        Calculates fee in USD for Perpetual contracts based on dynamic basis points (bps).
        """
        if contracts <= 0 or price <= 0:
            return 0.0
        notional = price * contracts * contract_size
        effective_bps = (bps * 0.5) if is_maker else bps
        return round(notional * (effective_bps / 10000.0), 4)

    @classmethod
    def calculate_net_pnl(
        cls,
        entry_price: float,
        exit_price: float,
        contracts: int,
        is_maker_entry: bool = True,
        is_maker_exit: bool = False,
        is_settlement: bool = False,
        is_perpetual: bool = False,
        contract_size: float = 1.0,
        perps_bps: float = 2.0,
        side: str = 'YES'
    ) -> Dict[str, float]:
        """
        Calculates true Net PnL factoring in entry and exit fees.
        
        Returns:
            {
                'gross_pnl': float,
                'entry_fee': float,
                'exit_fee': float,
                'total_fees': float,
                'net_pnl': float,
                'net_roi': float
            }
        """
        if contracts <= 0:
            return {'gross_pnl': 0.0, 'entry_fee': 0.0, 'exit_fee': 0.0, 'total_fees': 0.0, 'net_pnl': 0.0, 'net_roi': 0.0}

        if is_perpetual:
            # Perpetuals gross PnL
            if side.upper() == 'YES':  # Long
                gross_pnl = (exit_price - entry_price) * contracts * contract_size
            else:  # Short
                gross_pnl = (entry_price - exit_price) * contracts * contract_size

            capital_cost = entry_price * contracts * contract_size
            entry_fee = cls.calculate_perpetual_fee(entry_price, contracts, contract_size, perps_bps, is_maker_entry)
            exit_fee = cls.calculate_perpetual_fee(exit_price, contracts, contract_size, perps_bps, is_maker_exit)
        else:
            # Binary Event Contracts (Predictions / Tennis)
            # Payoff is $1.00 at resolution
            p_entry = max(0.01, min(0.99, float(entry_price)))
            p_exit = 1.0 if is_settlement else max(0.01, min(0.99, float(exit_price)))

            if side.upper() == 'YES':
                gross_pnl = (p_exit - p_entry) * contracts
            else:
                # NO side
                gross_pnl = ((1.0 - p_exit) - (1.0 - p_entry)) * contracts

            capital_cost = p_entry * contracts
            entry_fee = cls.calculate_prediction_fee(p_entry, contracts, is_maker=is_maker_entry, is_settlement=False)
            exit_fee = cls.calculate_prediction_fee(p_exit, contracts, is_maker=is_maker_exit, is_settlement=is_settlement)

        total_fees = round(entry_fee + exit_fee, 4)
        net_pnl = round(gross_pnl - total_fees, 4)
        net_roi = round(net_pnl / max(0.01, capital_cost), 4)

        return {
            'gross_pnl': round(gross_pnl, 4),
            'entry_fee': entry_fee,
            'exit_fee': exit_fee,
            'total_fees': total_fees,
            'net_pnl': net_pnl,
            'net_roi': net_roi
        }

    @classmethod
    def calculate_tsl_floor_for_guaranteed_net_profit(
        cls,
        entry_price: float,
        contracts: int,
        target_net_profit: float = 0.50,
        is_maker_entry: bool = True,
        is_maker_exit: bool = False,
        side: str = 'YES'
    ) -> float:
        """
        Dynamically calculates the exact exit stop price required to ensure the
        Trailing Stop Loss (TSL) executes in true positive net profit after deducting projected exit fees.
        """
        p_entry = max(0.01, min(0.99, float(entry_price)))
        entry_fee = cls.calculate_prediction_fee(p_entry, contracts, is_maker=is_maker_entry)

        # Iterative search over valid tick prices [p_entry, 0.99]
        best_stop = p_entry
        for tick_int in range(int(p_entry * 100), 100):
            p_candidate = tick_int / 100.0
            exit_fee = cls.calculate_prediction_fee(p_candidate, contracts, is_maker=is_maker_exit)
            gross = (p_candidate - p_entry) * contracts if side == 'YES' else ((1.0 - p_candidate) - (1.0 - p_entry)) * contracts
            net = gross - (entry_fee + exit_fee)
            if net >= target_net_profit:
                return p_candidate

        return 0.99


# =====================================================================
# 2. ASYNCHRONOUS KALSHI RATE LIMIT & TOKEN BUCKET MANAGER
# =====================================================================

@dataclass
class TokenBucket:
    capacity: float
    tokens: float
    refill_rate_per_sec: float
    last_update: float

    def refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self.last_update
        if elapsed > 0:
            self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_rate_per_sec)
            self.last_update = now

    def can_consume(self, cost: float) -> bool:
        self.refill()
        return self.tokens >= cost

    def consume(self, cost: float) -> bool:
        self.refill()
        if self.tokens >= cost:
            self.tokens -= cost
            return True
        return False


class RateLimitManager:
    """
    Continuous Token Bucket Rate Limiter modeled precisely on Kalshi exchange architecture.
    
    Architectural Rules:
      - Independent Buckets: Predictions vs. Perpetuals are separate.
      - Read vs. Write Separation: GET endpoints separate from POST/PUT/DELETE.
      - Costs: Default = 10 tokens. Batch = 10 * N. Perps cancel = 1 token. Batch prediction cancel = 2 tokens/order.
      - Bursting: Write buckets bank up to 3 seconds of capacity. Read buckets hold 1 second.
      - 429 Handling: Continuous exponential backoff without header reliance.
    """

    TIERS = {
        'Basic':     {'read_tps': 200,   'write_tps': 100},
        'Advanced':  {'read_tps': 300,   'write_tps': 300},
        'Expert':    {'read_tps': 600,   'write_tps': 600},
        'Premier':   {'read_tps': 1200,  'write_tps': 1200},
        'Paragon':   {'read_tps': 2400,  'write_tps': 2400},
        'Prime':     {'read_tps': 4800,  'write_tps': 4800},
        'Prestige':  {'read_tps': 12000, 'write_tps': 9600},
    }

    def __init__(self, tier: str = 'Advanced'):
        self.tier = tier if tier in self.TIERS else 'Advanced'
        cfg = self.TIERS[self.tier]
        read_tps = cfg['read_tps']
        write_tps = cfg['write_tps']

        # Burst capacities: Write buckets bank up to 3 seconds; Read buckets bank 1 second
        now = time.monotonic()
        self.predictions_read = TokenBucket(
            capacity=read_tps * 1.0, tokens=read_tps * 1.0, refill_rate_per_sec=read_tps, last_update=now
        )
        self.predictions_write = TokenBucket(
            capacity=write_tps * 3.0, tokens=write_tps * 3.0, refill_rate_per_sec=write_tps, last_update=now
        )
        self.perps_read = TokenBucket(
            capacity=read_tps * 1.0, tokens=read_tps * 1.0, refill_rate_per_sec=read_tps, last_update=now
        )
        self.perps_write = TokenBucket(
            capacity=write_tps * 3.0, tokens=write_tps * 3.0, refill_rate_per_sec=write_tps, last_update=now
        )

        self._backoff_duration = 0.05
        self._consecutive_429s = 0
        self._lock = asyncio.Lock()

    def set_tier(self, new_tier: str) -> None:
        if new_tier not in self.TIERS:
            return
        self.tier = new_tier
        cfg = self.TIERS[new_tier]
        r_tps = cfg['read_tps']
        w_tps = cfg['write_tps']
        self.predictions_read.refill_rate_per_sec = r_tps
        self.predictions_read.capacity = r_tps * 1.0
        self.predictions_write.refill_rate_per_sec = w_tps
        self.predictions_write.capacity = w_tps * 3.0
        self.perps_read.refill_rate_per_sec = r_tps
        self.perps_read.capacity = r_tps * 1.0
        self.perps_write.refill_rate_per_sec = w_tps
        self.perps_write.capacity = w_tps * 3.0

    def get_token_cost(
        self,
        endpoint_type: str,  # 'READ' | 'WRITE'
        market_type: str = 'PREDICTIONS',  # 'PREDICTIONS' | 'PERPS'
        action: str = 'DEFAULT',  # 'DEFAULT' | 'BATCH_CREATE' | 'PERPS_CANCEL' | 'BATCH_PRED_CANCEL'
        count: int = 1
    ) -> float:
        if endpoint_type.upper() == 'READ':
            return 10.0
        if action == 'PERPS_CANCEL':
            return 1.0 * count
        if action == 'BATCH_PRED_CANCEL':
            return 2.0 * count
        if action == 'BATCH_CREATE':
            return 10.0 * count
        return 10.0

    def _select_bucket(self, endpoint_type: str, market_type: str) -> TokenBucket:
        is_write = endpoint_type.upper() == 'WRITE'
        is_perps = market_type.upper() == 'PERPS'
        if is_perps:
            return self.perps_write if is_write else self.perps_read
        return self.predictions_write if is_write else self.predictions_read

    async def acquire(
        self,
        endpoint_type: str,
        market_type: str = 'PREDICTIONS',
        action: str = 'DEFAULT',
        count: int = 1
    ) -> None:
        """
        Asynchronously waits until tokens are available and consumes them.
        """
        cost = self.get_token_cost(endpoint_type, market_type, action, count)
        bucket = self._select_bucket(endpoint_type, market_type)

        while True:
            async with self._lock:
                if self._consecutive_429s > 0:
                    await asyncio.sleep(self._backoff_duration)
                
                if bucket.consume(cost):
                    # Tokens acquired successfully
                    if self._consecutive_429s > 0:
                        self._consecutive_429s = max(0, self._consecutive_429s - 1)
                        self._backoff_duration = max(0.05, self._backoff_duration * 0.8)
                    return

            # Tokens unavailable; compute wait duration
            deficit = cost - bucket.tokens
            wait_time = max(0.005, deficit / bucket.refill_rate_per_sec)
            await asyncio.sleep(wait_time)

    def handle_429(self) -> None:
        """
        Registers a 429 Too Many Requests response and activates exponential backoff.
        """
        self._consecutive_429s += 1
        # Exponential backoff clamped between 50ms and 5.0 seconds
        self._backoff_duration = min(5.0, 0.05 * (2 ** min(self._consecutive_429s, 6)))

    def get_bucket_fill_ratio(self, market_type: str = 'PREDICTIONS', endpoint_type: str = 'WRITE') -> float:
        """
        Normalized fill ratio [0.0, 1.0] passed to neural network observation space.
        """
        bucket = self._select_bucket(endpoint_type, market_type)
        bucket.refill()
        return max(0.0, min(1.0, bucket.tokens / max(1.0, bucket.capacity)))


# =====================================================================
# 3. PYTORCH TRADING ENVIRONMENT WITH LIVE SPORTS (TENNIS) STATE SPACE
# =====================================================================

class TradingEnvironment:
    """
    High-Frequency Trading Environment for Kalshi Event Contracts, Perps, and Live Tennis.
    
    Action Space:
      [0] Hold / Do Nothing
      [1] Taker Buy / Taker Sell (Immediate crossing of spread)
      [2] Maker Buy / Maker Sell (Place resting limit order at best bid/ask)
      [3] Cancel all resting orders (Adverse selection protection on game-state shifts)
      
    Observation Space (State Vector):
      0: Spread Width (ask - bid)
      1: Bid Depth Volume
      2: Ask Depth Volume
      3: Write Token Bucket Balance Ratio [0, 1] (rate limit pacing)
      4: Current Position Net PnL (including immediate exit fee)
      5: Time to Contract Expiration (normalized)
      6: Tennis Score Differential (Server games - Returner games)
      7: Tennis Current Server Indicator (1 = Player A, -1 = Player B)
      8: Tennis Break Point Active (1 = True, 0 = False)
      9: Tennis Set Point / Match Point Active (1 = True, 0 = False)
    """

    def __init__(self, rate_limiter: Optional[RateLimitManager] = None):
        self.fee_calc = KalshiFeeCalculator()
        self.rate_limiter = rate_limiter or RateLimitManager(tier='Advanced')

        # Environment parameters
        self.churn_penalty_factor = 0.05
        self.maker_bonus_factor = 0.02

        # Active state tracking
        self.has_position = False
        self.position_side = 'YES'
        self.position_entry_price = 0.50
        self.position_contracts = 10
        self.is_maker_entry = True
        self.resting_maker_orders = 0
        self.time_to_expiry_sec = 3600.0
        self.current_step = 0

    def get_state_vector(
        self,
        best_bid: float,
        best_ask: float,
        bid_vol: float,
        ask_vol: float,
        tennis_game_state: Optional[Dict[str, Any]] = None
    ) -> Any:
        """
        Constructs the state space observation vector.
        """
        spread = max(0.01, best_ask - best_bid)
        token_balance = self.rate_limiter.get_bucket_fill_ratio('PREDICTIONS', 'WRITE')

        # Net PnL calculation for active position including hypothetical immediate exit fee
        if self.has_position:
            immediate_exit_price = best_bid if self.position_side == 'YES' else best_ask
            pnl_info = self.fee_calc.calculate_net_pnl(
                entry_price=self.position_entry_price,
                exit_price=immediate_exit_price,
                contracts=self.position_contracts,
                is_maker_entry=self.is_maker_entry,
                is_maker_exit=False,  # Immediate exit crosses spread (Taker)
                is_settlement=False,
                side=self.position_side
            )
            net_pnl = pnl_info['net_pnl']
        else:
            net_pnl = 0.0

        norm_time_to_expiry = max(0.0, min(1.0, self.time_to_expiry_sec / 86400.0))

        # Tennis Match State
        t_state = tennis_game_state or {}
        score_diff = float(t_state.get('game_diff', 0.0)) / 6.0
        server_indicator = 1.0 if t_state.get('serving_player', 'A') == 'A' else -1.0
        is_break_point = 1.0 if t_state.get('is_break_point', False) else 0.0
        is_set_point = 1.0 if t_state.get('is_set_point', False) else 0.0

        state = [
            spread,
            min(1.0, bid_vol / 500.0),
            min(1.0, ask_vol / 500.0),
            token_balance,
            net_pnl,
            norm_time_to_expiry,
            score_diff,
            server_indicator,
            is_break_point,
            is_set_point
        ]

        if torch is not None:
            return torch.tensor(state, dtype=torch.float32)
        return state

    def step(
        self,
        action: int,
        market_data: Dict[str, Any],
        tennis_game_state: Optional[Dict[str, Any]] = None
    ) -> Tuple[Any, float, bool, Dict[str, Any]]:
        """
        Executes one environment step incorporating Net PnL, Maker incentives,
        over-trading penalties, and Tennis adverse-selection cancellation logic.
        
        Actions:
          0 = Hold / Do Nothing
          1 = Taker Order (Cross Spread)
          2 = Maker Order (Post Limit at Bid/Ask)
          3 = Cancel All Resting Orders
          
        Returns:
            (next_state, reward, done, info)
        """
        best_bid = float(market_data.get('bid', 0.50))
        best_ask = float(market_data.get('ask', 0.52))
        bid_vol = float(market_data.get('bid_vol', 100))
        ask_vol = float(market_data.get('ask_vol', 100))
        self.time_to_expiry_sec = max(0.0, float(market_data.get('time_to_expiry_sec', self.time_to_expiry_sec - 1.0)))

        reward = 0.0
        done = self.time_to_expiry_sec <= 0
        info = {'action_taken': action, 'events': []}

        # -------------------------------------------------------------
        # Action [3]: CANCEL ALL RESTING ORDERS
        # -------------------------------------------------------------
        if action == 3:
            if self.resting_maker_orders > 0:
                self.resting_maker_orders = 0
                info['events'].append('RESTING_ORDERS_CANCELLED')
                
                # Check for significant game state change (e.g. Break Point conceded)
                t_state = tennis_game_state or {}
                if t_state.get('momentum_shift', False) or t_state.get('is_break_point', False):
                    # Reward model for avoiding adverse selection fill at stale odds
                    reward += 0.05
                    info['events'].append('ADVERSE_SELECTION_AVOIDED')
            else:
                # Small penalty for redundant cancel spam (wasting rate limit tokens)
                reward -= 0.01

        # -------------------------------------------------------------
        # Action [1]: TAKER EXECUTION (Cross the spread)
        # -------------------------------------------------------------
        elif action == 1:
            if not self.has_position:
                # Open position as Taker
                self.has_position = True
                self.position_side = 'YES'
                self.position_entry_price = best_ask
                self.position_contracts = 10
                self.is_maker_entry = False
                
                entry_fee = self.fee_calc.calculate_prediction_fee(
                    self.position_entry_price, self.position_contracts, is_maker=False
                )
                # Over-trading churn penalty: discourages needless flipping
                reward -= (entry_fee + self.churn_penalty_factor)
                info['events'].append(f'OPENED_TAKER_YES_AT_{best_ask}')
            else:
                # Close active position as Taker
                pnl = self.fee_calc.calculate_net_pnl(
                    entry_price=self.position_entry_price,
                    exit_price=best_bid,
                    contracts=self.position_contracts,
                    is_maker_entry=self.is_maker_entry,
                    is_maker_exit=False,
                    is_settlement=False,
                    side=self.position_side
                )
                net_profit = pnl['net_pnl']
                # Pure Net Profit reward
                reward += net_profit
                # High frequency churn penalty
                reward -= self.churn_penalty_factor
                self.has_position = False
                info['events'].append(f'CLOSED_TAKER_NET_PNL_{net_profit}')

        # -------------------------------------------------------------
        # Action [2]: MAKER EXECUTION (Place limit order)
        # -------------------------------------------------------------
        elif action == 2:
            if not self.has_position and self.resting_maker_orders == 0:
                # Post resting maker order
                self.resting_maker_orders += 1
                self.has_position = True
                self.position_side = 'YES'
                self.position_entry_price = best_bid
                self.position_contracts = 10
                self.is_maker_entry = True

                # Maker incentive bonus: rewards providing liquidity & saving on fees
                reward += self.maker_bonus_factor
                info['events'].append(f'POSTED_MAKER_YES_AT_{best_bid}')

        # -------------------------------------------------------------
        # Action [0]: HOLD / DO NOTHING
        # -------------------------------------------------------------
        elif action == 0:
            if self.has_position:
                # Small incentive for patience if current unrealized net PnL is healthy
                immediate_exit = best_bid if self.position_side == 'YES' else best_ask
                pnl = self.fee_calc.calculate_net_pnl(
                    entry_price=self.position_entry_price,
                    exit_price=immediate_exit,
                    contracts=self.position_contracts,
                    is_maker_entry=self.is_maker_entry,
                    is_maker_exit=False,
                    side=self.position_side
                )
                if pnl['net_pnl'] > 0:
                    reward += 0.005

        # -------------------------------------------------------------
        # SETTLEMENT RESOLUTION ($0 EXIT FEE)
        # -------------------------------------------------------------
        if done and self.has_position:
            # Held through settlement! Resolution incurs $0 exit fees.
            settlement_win = market_data.get('settlement_outcome', 'YES') == self.position_side
            settlement_price = 1.0 if settlement_win else 0.0
            
            pnl = self.fee_calc.calculate_net_pnl(
                entry_price=self.position_entry_price,
                exit_price=settlement_price,
                contracts=self.position_contracts,
                is_maker_entry=self.is_maker_entry,
                is_maker_exit=False,
                is_settlement=True,  # $0 exit fee
                side=self.position_side
            )
            net_profit = pnl['net_pnl']
            # Reward includes saving exit fee through settlement
            reward += net_profit
            info['events'].append(f'SETTLEMENT_RESOLUTION_NET_{net_profit}')
            self.has_position = False

        self.current_step += 1
        next_state = self.get_state_vector(best_bid, best_ask, bid_vol, ask_vol, tennis_game_state)
        return next_state, reward, done, info

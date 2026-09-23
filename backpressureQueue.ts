export type PriorityLevel = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

export interface QueueTask<T = any> {
  id: string;
  type: string;
  priority: PriorityLevel;
  action: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
  timestamp: number;
  symbol?: string;
  dropOnSaturation?: boolean;
}

export interface DropLogEntry {
  id: string;
  time: string;
  type: string;
  priority: PriorityLevel;
  symbol?: string;
  reason: string;
}

export interface BackpressureStats {
  queueDepth: number;
  maxCapacity: number;
  saturationPct: number;
  status: 'OPTIMAL' | 'THROTTLED' | 'SHEDDING_LOAD' | 'CIRCUIT_TRIPPED';
  depthByPriority: Record<PriorityLevel, number>;
  totalProcessed: number;
  totalDropped: number;
  droppedByPriority: Record<PriorityLevel, number>;
  throughputReqSec: number;
  circuitBreaker: {
    state: 'CLOSED' | 'HALF_OPEN' | 'OPEN';
    failureCount: number;
    lastTripTime: number | null;
    cooldownRemainingMs: number;
  };
  recentDropLogs: DropLogEntry[];
}

export class BackpressureQueueManager {
  private queue: QueueTask[] = [];
  private readonly maxCapacity: number = 35;
  private readonly rateLimitMax: number = 5;
  private readonly rateLimitWindowMs: number = 1000;
  private requestTimestamps: number[] = [];
  private isProcessing: boolean = false;
  
  // Circuit breaker state
  private circuitState: 'CLOSED' | 'HALF_OPEN' | 'OPEN' = 'CLOSED';
  private circuitFailureCount: number = 0;
  private lastCircuitTripTime: number | null = null;
  private circuitCooldownMs: number = 4000;

  // Metrics
  private totalProcessed: number = 0;
  private totalDropped: number = 0;
  private droppedByPriority: Record<PriorityLevel, number> = {
    CRITICAL: 0,
    HIGH: 0,
    NORMAL: 0,
    LOW: 0
  };
  private recentDropLogs: DropLogEntry[] = [];
  private processedInLastSecond: number = 0;
  private lastThroughputCalcTime: number = Date.now();
  private currentThroughput: number = 0;

  constructor() {
    // Background throughput calculation loop
    setInterval(() => {
      const now = Date.now();
      const elapsed = (now - this.lastThroughputCalcTime) / 1000;
      this.currentThroughput = elapsed > 0 ? parseFloat((this.processedInLastSecond / elapsed).toFixed(2)) : 0;
      this.processedInLastSecond = 0;
      this.lastThroughputCalcTime = now;

      // Circuit breaker auto-recovery check
      if (this.circuitState === 'OPEN' && this.lastCircuitTripTime) {
        if (now - this.lastCircuitTripTime >= this.circuitCooldownMs) {
          this.circuitState = 'HALF_OPEN';
        }
      }
    }, 1000);
  }

  public enqueue<T>(
    action: () => Promise<T>,
    options: {
      type: string;
      priority?: PriorityLevel;
      symbol?: string;
      dropOnSaturation?: boolean;
    }
  ): Promise<T> {
    const priority: PriorityLevel = options.priority || 'NORMAL';
    const type = options.type;
    const symbol = options.symbol;
    const dropOnSaturation = options.dropOnSaturation ?? (priority === 'LOW');
    const queueDepth = this.queue.length;

    // Check circuit breaker status
    if (this.circuitState === 'OPEN' && priority !== 'CRITICAL') {
      this.recordDrop({
        type,
        priority,
        symbol,
        reason: `Circuit Breaker is OPEN (HTTP 429 Backoff). Shedding non-critical request.`
      });
      return Promise.reject(new Error(`[BACKPRESSURE] Circuit breaker active. Dropped ${priority} request.`));
    }

    // High-load shedding policy:
    // Drop LOW priority requests if queue depth >= 12 (approx 35% capacity)
    if (priority === 'LOW' && (queueDepth >= 12 || this.circuitState === 'HALF_OPEN')) {
      this.recordDrop({
        type,
        priority,
        symbol,
        reason: `Queue depth (${queueDepth}/${this.maxCapacity}) exceeds low-priority threshold. Shedding quote refresh to protect execution latency.`
      });
      return Promise.reject(new Error(`[BACKPRESSURE] Dropped low-priority request under load.`));
    }

    // Drop NORMAL priority requests if queue depth >= 25 (approx 70% capacity) and dropOnSaturation is set
    if (priority === 'NORMAL' && dropOnSaturation && queueDepth >= 25) {
      this.recordDrop({
        type,
        priority,
        symbol,
        reason: `Queue saturated (${queueDepth}/${this.maxCapacity}). Shedding non-critical normal update.`
      });
      return Promise.reject(new Error(`[BACKPRESSURE] Saturated queue shed normal request.`));
    }

    // Reject all new normal/low if at hard capacity (save remaining buffer for CRITICAL / HIGH)
    if (queueDepth >= this.maxCapacity && priority !== 'CRITICAL' && priority !== 'HIGH') {
      this.recordDrop({
        type,
        priority,
        symbol,
        reason: `Hard queue capacity reached (${this.maxCapacity}). Request rejected.`
      });
      return Promise.reject(new Error(`[BACKPRESSURE] Hard capacity reached.`));
    }

    return new Promise<T>((resolve, reject) => {
      const task: QueueTask<T> = {
        id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        type,
        priority,
        action,
        resolve,
        reject,
        timestamp: Date.now(),
        symbol,
        dropOnSaturation
      };

      // Priority insertion: CRITICAL first, then HIGH, then NORMAL, then LOW
      this.insertByPriority(task);
      this.triggerProcess();
    });
  }

  private insertByPriority(task: QueueTask) {
    const priorityWeight: Record<PriorityLevel, number> = {
      CRITICAL: 0,
      HIGH: 1,
      NORMAL: 2,
      LOW: 3
    };

    const taskWeight = priorityWeight[task.priority];
    let insertIdx = this.queue.length;

    for (let i = 0; i < this.queue.length; i++) {
      if (taskWeight < priorityWeight[this.queue[i].priority]) {
        insertIdx = i;
        break;
      }
    }

    this.queue.splice(insertIdx, 0, task);
  }

  private async triggerProcess() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      // Apply rolling rate limit
      await this.enforceRateLimit();

      const task = this.queue.shift();
      if (!task) break;

      try {
        const result = await task.action();
        this.totalProcessed++;
        this.processedInLastSecond++;
        if (this.circuitState === 'HALF_OPEN') {
          // Successful probe closes circuit breaker
          this.circuitState = 'CLOSED';
          this.circuitFailureCount = 0;
        }
        task.resolve(result);
      } catch (err: any) {
        // Check for 429 status or rate limit indicators
        if (err?.status === 429 || (err?.message && /429|rate limit|too many requests/i.test(err.message))) {
          this.tripCircuitBreaker(task.symbol);
        }
        task.reject(err);
      }
    }

    this.isProcessing = false;
  }

  private async enforceRateLimit() {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < this.rateLimitWindowMs);
    if (this.requestTimestamps.length >= this.rateLimitMax) {
      const oldest = this.requestTimestamps[0];
      const waitTime = Math.max(10, this.rateLimitWindowMs - (now - oldest) + 5);
      await new Promise(r => setTimeout(r, waitTime));
      return this.enforceRateLimit();
    }
    this.requestTimestamps.push(Date.now());
  }

  public tripCircuitBreaker(symbol?: string) {
    this.circuitState = 'OPEN';
    this.circuitFailureCount++;
    this.lastCircuitTripTime = Date.now();
    this.recordDrop({
      type: 'CIRCUIT_BREAKER',
      priority: 'CRITICAL',
      symbol,
      reason: `HTTP 429 Received. Tripping Circuit Breaker to OPEN state for ${this.circuitCooldownMs / 1000}s cooldown.`
    });
  }

  private recordDrop(entry: Omit<DropLogEntry, 'id' | 'time'>) {
    this.totalDropped++;
    this.droppedByPriority[entry.priority]++;
    const log: DropLogEntry = {
      id: `drop_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      time: new Date().toISOString(),
      ...entry
    };
    this.recentDropLogs.unshift(log);
    if (this.recentDropLogs.length > 20) {
      this.recentDropLogs.length = 20;
    }
  }

  public getStats(): BackpressureStats {
    const depthByPriority: Record<PriorityLevel, number> = {
      CRITICAL: 0,
      HIGH: 0,
      NORMAL: 0,
      LOW: 0
    };

    for (const task of this.queue) {
      depthByPriority[task.priority]++;
    }

    const queueDepth = this.queue.length;
    const saturationPct = Math.min(100, Math.round((queueDepth / this.maxCapacity) * 100));

    let status: BackpressureStats['status'] = 'OPTIMAL';
    if (this.circuitState === 'OPEN') {
      status = 'CIRCUIT_TRIPPED';
    } else if (saturationPct >= 70 || this.recentDropLogs.length > 0 && (Date.now() - new Date(this.recentDropLogs[0].time).getTime() < 10000)) {
      status = 'SHEDDING_LOAD';
    } else if (saturationPct >= 35 || this.currentThroughput >= 4) {
      status = 'THROTTLED';
    }

    const now = Date.now();
    const cooldownRemainingMs = this.lastCircuitTripTime && this.circuitState === 'OPEN'
      ? Math.max(0, this.circuitCooldownMs - (now - this.lastCircuitTripTime))
      : 0;

    return {
      queueDepth,
      maxCapacity: this.maxCapacity,
      saturationPct,
      status,
      depthByPriority,
      totalProcessed: this.totalProcessed,
      totalDropped: this.totalDropped,
      droppedByPriority: { ...this.droppedByPriority },
      throughputReqSec: this.currentThroughput,
      circuitBreaker: {
        state: this.circuitState,
        failureCount: this.circuitFailureCount,
        lastTripTime: this.lastCircuitTripTime,
        cooldownRemainingMs
      },
      recentDropLogs: [...this.recentDropLogs]
    };
  }
}

export const backpressureQueue = new BackpressureQueueManager();

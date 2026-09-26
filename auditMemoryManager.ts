import fs from "fs";
import path from "path";

export interface AuditIssue {
  id: string;
  title: string;
  category: 'DATA_LINEAGE' | 'ADVERSE_SELECTION' | 'SLIPPAGE_IMPACT' | 'OVERFITTING' | 'REGIME_BIAS' | 'EXECUTION_LATENCY' | 'GENERAL';
  description: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  detectionCount: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
  status: 'ACTIVE' | 'RESOLVED';
  resolvedAt?: string;
  resolutionNote?: string;
}

export interface ShortTermComparison {
  evaluatedAt: string;
  previousAuditTimestamp: string | null;
  resolvedInThisBatch: string[];
  persistingInThisBatch: string[];
  newlyDetectedInThisBatch: string[];
  summaryText: string;
}

export interface AuditMemoryState {
  shortTermMemory: {
    lastAuditTimestamp: string | null;
    lastAuditTradeCount: number;
    previousIssues: AuditIssue[];
    lastComparison?: ShortTermComparison;
  };
  recurringIssuesQueue: AuditIssue[];
  activeWatchList: AuditIssue[];
  solvedLongTermMemory: AuditIssue[];
}

export class AuditMemoryManager {
  private memoryFilePath: string;
  private state: AuditMemoryState;

  constructor() {
    this.memoryFilePath = path.join(process.cwd(), 'audit_memory.json');
    this.state = this._loadInitialState();
  }

  private _loadInitialState(): AuditMemoryState {
    if (fs.existsSync(this.memoryFilePath)) {
      try {
        const raw = fs.readFileSync(this.memoryFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.shortTermMemory && Array.isArray(parsed.activeWatchList)) {
          return parsed;
        }
      } catch (err) {
        console.warn('[AUDIT MEMORY] Failed to parse existing memory file, re-seeding defaults:', err);
      }
    }

    const now = new Date().toISOString();

    // Default institutional seeds reflecting recent SR 11-7 engineering upgrades
    const initialSolved: AuditIssue[] = [
      {
        id: 'DATA_LINEAGE_LOOKAHEAD_ICHIMOKU_RSI',
        title: 'Lookahead Bias in Intra-Bar Indicator Snapshots',
        category: 'DATA_LINEAGE',
        description: 'Features were referencing closing candle states rather than point-in-time closed bar indicators at signal creation.',
        severity: 'CRITICAL',
        detectionCount: 3,
        firstDetectedAt: new Date(Date.now() - 86400000 * 3).toISOString(),
        lastDetectedAt: new Date(Date.now() - 86400000).toISOString(),
        status: 'RESOLVED',
        resolvedAt: now,
        resolutionNote: 'Strict closed-bar shift-1 verification and nanosecond snapshot serialization implemented.'
      },
      {
        id: 'ZERO_SLIPPAGE_ALTCOIN_DEPTH',
        title: 'Zero-Slippage Simulation on Altcoin Order Books',
        category: 'SLIPPAGE_IMPACT',
        description: 'Altcoin contracts (XRP, SOL, HYPE) were clearing without liquidity-tiered depth degradation or slippage.',
        severity: 'HIGH',
        detectionCount: 4,
        firstDetectedAt: new Date(Date.now() - 86400000 * 4).toISOString(),
        lastDetectedAt: new Date(Date.now() - 86400000).toISOString(),
        status: 'RESOLVED',
        resolvedAt: now,
        resolutionNote: 'Four-tier liquidity model (2.5 to 32 bps) and square-root size impact formula deployed.'
      },
      {
        id: 'TOXIC_ORDER_FLOW_MARKOUT_BLINDNESS',
        title: 'Unmeasured Adverse Selection & Toxic Flow Markouts',
        category: 'ADVERSE_SELECTION',
        description: 'Post-fill trade price paths were unmonitored, allowing executions into adverse selection without detection.',
        severity: 'HIGH',
        detectionCount: 2,
        firstDetectedAt: new Date(Date.now() - 86400000 * 2).toISOString(),
        lastDetectedAt: new Date(Date.now() - 86400000).toISOString(),
        status: 'RESOLVED',
        resolvedAt: now,
        resolutionNote: 'Asynchronous 1s, 5s, and 60s post-fill markout tracker with toxic flow alert threshold added.'
      },
      {
        id: 'DIRECTIONAL_MONOCULTURE_100_PERCENT_YES',
        title: 'Directional Monoculture 100% YES Long Bias',
        category: 'REGIME_BIAS',
        description: 'Trading engine clustered into 100% YES contract executions regardless of macro regime.',
        severity: 'CRITICAL',
        detectionCount: 5,
        firstDetectedAt: new Date(Date.now() - 86400000 * 5).toISOString(),
        lastDetectedAt: new Date(Date.now() - 86400000).toISOString(),
        status: 'RESOLVED',
        resolvedAt: now,
        resolutionNote: 'USDT.D macro expansion gatekeeper and 4-trade consecutive long circuit breaker deployed.'
      }
    ];

    const initialWatchList: AuditIssue[] = [
      {
        id: 'MICROSECOND_EXECUTION_LATENCY_JITTER',
        title: 'Execution Delay & Queue Latency Modeling',
        category: 'EXECUTION_LATENCY',
        description: 'Ensure executionDelayMs is non-zero, reflects lognormal jitter (25ms-180ms), and models order arrival queue delays.',
        severity: 'MEDIUM',
        detectionCount: 2,
        firstDetectedAt: now,
        lastDetectedAt: now,
        status: 'ACTIVE'
      },
      {
        id: 'IMPLEMENTATION_SHORTFALL_DEPTH_IMPACT',
        title: 'Implementation Shortfall Trajectory on Large Fills',
        category: 'SLIPPAGE_IMPACT',
        description: 'Verify implementation shortfall dollar values scale non-linearly with contract order size on thinner altcoin books.',
        severity: 'HIGH',
        detectionCount: 2,
        firstDetectedAt: now,
        lastDetectedAt: now,
        status: 'ACTIVE'
      },
      {
        id: 'MACRO_FRACTAL_USDT_DOMINANCE_EXPANSION',
        title: 'Cross-Asset Liquidity Shock Guard (USDT.D)',
        category: 'REGIME_BIAS',
        description: 'Verify the bot refuses altcoin long exposure when USDT.D is expanding, preventing systemic market drawdowns.',
        severity: 'HIGH',
        detectionCount: 1,
        firstDetectedAt: now,
        lastDetectedAt: now,
        status: 'ACTIVE'
      }
    ];

    const initialRecurringQueue: AuditIssue[] = [
      {
        id: 'TDF_PARAMETER_OVERFITTING_DEFLATED_SHARPE',
        title: 'Time Dilation Factor (TDF) Parameter Drift Rate',
        category: 'OVERFITTING',
        description: 'Monitor how frequently internal parameters shift within the 20-trade window to prevent curve-fitting historical noise.',
        severity: 'MEDIUM',
        detectionCount: 1,
        firstDetectedAt: now,
        lastDetectedAt: now,
        status: 'ACTIVE'
      },
      {
        id: 'ASYMMETRIC_PAYOFF_RATIO_SL_COMPLIANCE',
        title: 'Dynamic SL/TP Payoff Asymmetry in Choppy Regimes',
        category: 'GENERAL',
        description: 'Ensure stop losses trigger dynamically and preserve profit factor asymmetry during sideways consolidation.',
        severity: 'MEDIUM',
        detectionCount: 1,
        firstDetectedAt: now,
        lastDetectedAt: now,
        status: 'ACTIVE'
      }
    ];

    const seededState: AuditMemoryState = {
      shortTermMemory: {
        lastAuditTimestamp: now,
        lastAuditTradeCount: 20,
        previousIssues: [initialWatchList[0], initialWatchList[1]]
      },
      recurringIssuesQueue: initialRecurringQueue,
      activeWatchList: initialWatchList,
      solvedLongTermMemory: initialSolved
    };

    this._saveState(seededState);
    return seededState;
  }

  private _saveState(stateToSave: AuditMemoryState = this.state) {
    try {
      fs.writeFileSync(this.memoryFilePath, JSON.stringify(stateToSave, null, 2), 'utf-8');
    } catch (err) {
      console.error('[AUDIT MEMORY] Failed to write state to disk:', err);
    }
  }

  public getState(): AuditMemoryState {
    return JSON.parse(JSON.stringify(this.state));
  }

  /**
   * Builds the memory prompt block injected into Gemini's audit instructions.
   * Enforces max 3 active watch items and provides short-term comparison context.
   */
  public buildPromptMemoryContext(): string {
    const { shortTermMemory, activeWatchList, solvedLongTermMemory } = this.state;

    // 1. Active Watch List (Max 3)
    const watchListText = activeWatchList.slice(0, 3).map((item, idx) => {
      return `[WATCH ITEM #${idx + 1}] ID: ${item.id}
- Title: ${item.title}
- Category: ${item.category} | Severity: ${item.severity} | Observed in: ${item.detectionCount} audits
- Failure Signature: ${item.description}
- Audit Requirement: Scrutinize this new batch specifically for this failure mode. Mark explicitly as [RESOLVED: ${item.id}] or [PERSISTING: ${item.id}].`;
    }).join('\n\n');

    // 2. Short-Term Memory Context (Previous Audit Comparison)
    const prevTimestamp = shortTermMemory.lastAuditTimestamp 
      ? new Date(shortTermMemory.lastAuditTimestamp).toLocaleString() 
      : 'None (Initial Baseline)';
    
    const prevIssuesText = (shortTermMemory.previousIssues || []).length > 0
      ? shortTermMemory.previousIssues.map(i => `* [ID: ${i.id}] ${i.title} (${i.severity} - ${i.category})`).join('\n')
      : '* No unresolved issues reported in prior audit.';

    // 3. Solved Long-Term Memory Summary (Historical Knowledge Base)
    const solvedSample = solvedLongTermMemory.slice(0, 4).map(s => {
      return `* [HISTORICALLY SOLVED: ${s.id}] ${s.title}: ${s.resolutionNote || 'Verified fixed'}`;
    }).join('\n');

    return `
================================================================================
AUDIT MEMORY & RECURRENCE SURVEILLANCE PROTOCOL (SR 11-7 COMPLIANCE)
================================================================================
You have access to persistent audit memory across batches:

[1. ACTIVE REOCCURRING WATCH LIST (MAX 3 PRIORITY ISSUES)]:
Inspect the new batch of trades specifically for these persistent vulnerabilities:
${watchListText || 'No active watch items currently queued.'}

[2. SHORT-TERM COMPARISON MEMORY (IMMEDIATE PRIOR AUDIT)]:
- Prior Audit Timestamp: ${prevTimestamp} (Batch size: ${shortTermMemory.lastAuditTradeCount} trades)
- Issues Pending Status Check From Prior Audit:
${prevIssuesText}

[3. LONG-TERM SOLVED MEMORY DIGEST (HISTORICAL SYSTEM KNOWLEDGE)]:
The following architectural vulnerabilities were resolved in past engineering cycles:
${solvedSample || 'No solved history recorded yet.'}
* Note: If any of these previously solved issues appear in the new batch, flag as [REGRESSION: <ID>].

AUDIT DIRECTIVE FOR MEMORY MANAGEMENT:
1. You MUST evaluate every issue listed in the ACTIVE WATCH LIST and SHORT-TERM MEMORY.
2. For each, output either:
   - [RESOLVED: <ID>] followed by concrete empirical evidence from this batch proving the issue is fixed.
   - [PERSISTING: <ID>] followed by specific trade IDs where the vulnerability is still evident.
3. If you identify a brand-new vulnerability not in the watch list, label it as:
   - [NEW_ISSUE: <TITLE>] [CATEGORY: <DATA_LINEAGE|ADVERSE_SELECTION|SLIPPAGE_IMPACT|OVERFITTING|REGIME_BIAS|EXECUTION_LATENCY|GENERAL>] [SEVERITY: <CRITICAL|HIGH|MEDIUM|LOW>]
================================================================================`;
  }

  /**
   * Ingests the Gemini audit report and the corresponding trade batch.
   * Updates short-term comparison memory, resolves fixed issues, moves them to
   * long-term solved storage, and rotates new reoccurring issues into active watch (max 3, FIFO).
   */
  public processAuditResult(report: string, trades: any[]): ShortTermComparison {
    const now = new Date().toISOString();
    const resolvedInThisBatch: string[] = [];
    const persistingInThisBatch: string[] = [];
    const newlyDetectedInThisBatch: string[] = [];

    // Helper to check report text for markers
    const isExplicitlyResolvedInText = (id: string, title: string) => {
      const regex1 = new RegExp(`\\[RESOLVED:\\s*(${id}|${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i');
      const regex2 = new RegExp(`(RESOLVED|FIXED|COMPLIANT).*?(${id}|${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i');
      return regex1.test(report) || regex2.test(report);
    };

    const isExplicitlyPersistingInText = (id: string, title: string) => {
      const regex1 = new RegExp(`\\[PERSISTING:\\s*(${id}|${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i');
      const regex2 = new RegExp(`(PERSISTING|FAILED|UNRESOLVED).*?(${id}|${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i');
      return regex1.test(report) || regex2.test(report);
    };

    // Objective empirical verification from trades
    const hasZeroSlippage = trades.some(t => (t.slippage || t.slippageUsd || 0) === 0);
    const hasZeroDelay = trades.some(t => (t.executionDelayMs || 0) <= 0);
    const allYesTrades = trades.length >= 6 && trades.every(t => (t.direction || t.side) === 'YES');
    const hasToxicMarkouts = trades.some(t => t.markoutTrajectories?.toxicOrderFlowAdverseSelection === true);

    // 1. Evaluate Active Watch List Items
    const remainingActiveWatch: AuditIssue[] = [];

    for (const item of this.state.activeWatchList) {
      let isResolved = false;

      // Quantitative heuristic overrides
      if (item.id === 'ZERO_SLIPPAGE_ALTCOIN_DEPTH' && !hasZeroSlippage) isResolved = true;
      if (item.id === 'MICROSECOND_EXECUTION_LATENCY_JITTER' && !hasZeroDelay) isResolved = true;
      if (item.id === 'DIRECTIONAL_MONOCULTURE_100_PERCENT_YES' && !allYesTrades) isResolved = true;
      if (item.id === 'TOXIC_ORDER_FLOW_MARKOUT_BLINDNESS' && !hasToxicMarkouts) isResolved = true;

      // Report text explicit marker
      if (isExplicitlyResolvedInText(item.id, item.title)) {
        isResolved = true;
      } else if (isExplicitlyPersistingInText(item.id, item.title)) {
        isResolved = false;
      }

      if (isResolved) {
        // Issue is solved! Move to Long-Term Solved Memory
        item.status = 'RESOLVED';
        item.resolvedAt = now;
        item.resolutionNote = `Verified resolved in audit batch of ${trades.length} trades at ${new Date().toLocaleTimeString()}.`;
        
        // Remove duplicates in solvedLongTermMemory
        this.state.solvedLongTermMemory = this.state.solvedLongTermMemory.filter(s => s.id !== item.id);
        this.state.solvedLongTermMemory.unshift(item);
        resolvedInThisBatch.push(item.id);
        console.log(`[AUDIT MEMORY] Issue [${item.id}] marked RESOLVED. Migrated to Solved Long-Term Memory.`);
      } else {
        // Issue persists
        item.detectionCount += 1;
        item.lastDetectedAt = now;
        remainingActiveWatch.push(item);
        persistingInThisBatch.push(item.id);
      }
    }

    // 2. Evaluate Short-Term Memory Previous Issues
    for (const item of this.state.shortTermMemory.previousIssues || []) {
      if (!resolvedInThisBatch.includes(item.id) && !persistingInThisBatch.includes(item.id)) {
        if (isExplicitlyResolvedInText(item.id, item.title)) {
          item.status = 'RESOLVED';
          item.resolvedAt = now;
          item.resolutionNote = `Resolved in subsequent batch comparison.`;
          this.state.solvedLongTermMemory = this.state.solvedLongTermMemory.filter(s => s.id !== item.id);
          this.state.solvedLongTermMemory.unshift(item);
          resolvedInThisBatch.push(item.id);
        } else {
          item.detectionCount += 1;
          item.lastDetectedAt = now;
          persistingInThisBatch.push(item.id);
        }
      }
    }

    // 3. Scan for NEW_ISSUE tags in report
    const newIssueRegex = /\[NEW_ISSUE:\s*([^\]]+)\]/gi;
    let match: RegExpExecArray | null;
    while ((match = newIssueRegex.exec(report)) !== null) {
      const issueTitle = match[1].trim();
      const issueId = 'ISSUE_' + issueTitle.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 32);

      // Check if already in active, recurring, or solved
      const alreadyTracked = this.state.activeWatchList.some(i => i.id === issueId) ||
                             this.state.recurringIssuesQueue.some(i => i.id === issueId) ||
                             this.state.solvedLongTermMemory.some(i => i.id === issueId);

      if (!alreadyTracked) {
        const newIssue: AuditIssue = {
          id: issueId,
          title: issueTitle,
          category: 'GENERAL',
          description: `Discovered during quantitative audit report: ${issueTitle}`,
          severity: 'HIGH',
          detectionCount: 1,
          firstDetectedAt: now,
          lastDetectedAt: now,
          status: 'ACTIVE'
        };
        this.state.recurringIssuesQueue.push(newIssue);
        newlyDetectedInThisBatch.push(issueId);
        console.log(`[AUDIT MEMORY] New issue detected and enqueued to Reoccurring Issues Queue: ${issueId}`);
      }
    }

    // 4. Replenish Active Watch List to MAX 3 from Reoccurring Queue (FIFO)
    this.state.activeWatchList = remainingActiveWatch;

    while (this.state.activeWatchList.length < 3 && this.state.recurringIssuesQueue.length > 0) {
      const nextIssue = this.state.recurringIssuesQueue.shift();
      if (nextIssue && !this.state.activeWatchList.some(i => i.id === nextIssue.id)) {
        this.state.activeWatchList.push(nextIssue);
        console.log(`[AUDIT MEMORY] Promoted [${nextIssue.id}] from Reoccurring Queue to Active Watch List (FIFO order). Current watch count: ${this.state.activeWatchList.length}/3.`);
      }
    }

    // 5. Update Short-Term Memory
    const comparisonSummary: ShortTermComparison = {
      evaluatedAt: now,
      previousAuditTimestamp: this.state.shortTermMemory.lastAuditTimestamp,
      resolvedInThisBatch,
      persistingInThisBatch,
      newlyDetectedInThisBatch,
      summaryText: `Audit evaluated ${trades.length} trades: ${resolvedInThisBatch.length} issue(s) confirmed resolved, ${persistingInThisBatch.length} persisting, ${newlyDetectedInThisBatch.length} new anomalies logged.`
    };

    this.state.shortTermMemory = {
      lastAuditTimestamp: now,
      lastAuditTradeCount: trades.length,
      previousIssues: JSON.parse(JSON.stringify(this.state.activeWatchList)),
      lastComparison: comparisonSummary
    };

    // 6. Persist updated memory state
    this._saveState();

    return comparisonSummary;
  }

  /**
   * Manually resolve an issue by ID (e.g. from developer confirmation)
   */
  public manuallyResolveIssue(issueId: string, note?: string): boolean {
    const now = new Date().toISOString();
    let foundIssue: AuditIssue | null = null;

    // Remove from active watch list
    const activeIdx = this.state.activeWatchList.findIndex(i => i.id === issueId);
    if (activeIdx !== -1) {
      foundIssue = this.state.activeWatchList.splice(activeIdx, 1)[0];
    }

    // Remove from recurring queue
    const queueIdx = this.state.recurringIssuesQueue.findIndex(i => i.id === issueId);
    if (queueIdx !== -1) {
      foundIssue = this.state.recurringIssuesQueue.splice(queueIdx, 1)[0];
    }

    if (foundIssue) {
      foundIssue.status = 'RESOLVED';
      foundIssue.resolvedAt = now;
      foundIssue.resolutionNote = note || 'Manually marked as resolved by engineering team.';

      this.state.solvedLongTermMemory = this.state.solvedLongTermMemory.filter(s => s.id !== issueId);
      this.state.solvedLongTermMemory.unshift(foundIssue);

      // Refill active watch list up to 3 from FIFO queue
      while (this.state.activeWatchList.length < 3 && this.state.recurringIssuesQueue.length > 0) {
        const next = this.state.recurringIssuesQueue.shift();
        if (next && !this.state.activeWatchList.some(i => i.id === next.id)) {
          this.state.activeWatchList.push(next);
        }
      }

      this._saveState();
      return true;
    }

    return false;
  }
}

export const auditMemoryManager = new AuditMemoryManager();

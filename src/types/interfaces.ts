/**
 * AgentsGate — Shared Type Definitions
 *
 * THIS FILE IS ARCHITECT-OWNED.
 * Builder Agents implement these interfaces but NEVER modify this file.
 * All changes require Architect Agent approval and an ADR entry.
 *
 * @version 0.1.0
 */

// ============================================================
// Core Operation Types
// ============================================================

/**
 * Represents a single MCP tool call intercepted by the AgentsGate proxy.
 * Created when an AI Agent attempts to call any MCP tool.
 */
export interface MCPOperation {
  /** Unique identifier (UUID v4) */
  id: string;
  /** Identifier of the AI Agent making the call */
  agentId: string;
  /** MCP tool name (e.g., "filesystem", "github", "database") */
  tool: string;
  /** Tool method being called (e.g., "write_file", "delete_record") */
  method: string;
  /** Parameters passed to the tool method */
  params: Record<string, unknown>;
  /** When the call was intercepted */
  timestamp: Date;
  /** Session grouping multiple operations from the same agent run */
  sessionId: string;
  /**
   * Optional ID of the parent operation that triggered this one.
   * Enables causality tracing across chained tool calls within a session.
   */
  parentId?: string;
  /**
   * Optional free-form labels for grouping, filtering, and compliance tagging.
   * Example: ["pci-scope", "high-value-target"]
   */
  tags?: string[];
}

/**
 * A single risk rule that fired during assessment — surfaced for
 * transparency so callers can understand exactly why a score was reached.
 */
export interface FiredRule {
  /** Rule identifier (e.g. "L1_DELETE_FILE", "POLICY_SCORE_OVERRIDE") */
  id: string;
  /** Risk score this rule contributed [0.0, 1.0] */
  score: number;
  /** Which scoring layer produced this rule */
  layer: 'L1' | 'L2' | 'L3' | 'policy';
  /** Optional human-readable rule description */
  description?: string;
}

/**
 * The proxy's verdict on whether to allow, block, or escalate an operation.
 */
export interface ProxyDecision {
  /** Whether to allow the operation, block it, or require human approval */
  action: 'allow' | 'block' | 'require_approval';
  /** Overall risk score [0.0 = safe, 1.0 = extremely risky] */
  riskScore: number;
  /** Human-readable reasons for this decision */
  reasons: string[];
  /** ID of checkpoint created before this operation (if any) */
  checkpointId?: string;
  /**
   * Structured list of risk rules that fired for this operation.
   * Enables callers to understand the exact rationale for the score.
   */
  firedRules?: FiredRule[];
  /**
   * When true, the proxy is operating in dry-run mode.
   * The operation was forwarded regardless of the assessed action.
   */
  dryRun?: boolean;
}

// ============================================================
// Logging
// ============================================================

/**
 * Persisted log entry for an operation, combining operation data,
 * the proxy decision, and (optionally) the execution result.
 */
export interface OperationLog {
  /** Matches MCPOperation.id */
  operationId: string;
  /** The intercepted operation */
  operation: MCPOperation;
  /** The proxy's verdict */
  decision: ProxyDecision;
  /** Result of executing the operation (undefined if blocked) */
  executionResult?: ExecutionResult;
  /** When this log entry was created */
  createdAt: Date;
  /**
   * HMAC-SHA256 hex signature over the canonical log content.
   * Present when the logger was initialised with a signing secret.
   * Absence does not mean the log is invalid — it may predate signing.
   */
  hmac?: string;
  /**
   * Signature of the record written immediately before this one, or "" for the
   * first. It is part of the signed content, which is what turns the log into a
   * chain: removing a record leaves the next one committing to a predecessor
   * that is no longer there.
   *
   * Recorded on the entry so a single record can still be checked on its own —
   * `verifyLog(log, secret, log.prevHmac)` — without holding the record before
   * it. Continuity is a separate, cheap check that each prevHmac matches the
   * actual predecessor's hmac.
   */
  prevHmac?: string;
}

/**
 * Result of actually calling the MCP tool after proxy approval.
 */
export interface ExecutionResult {
  /** Whether the tool call succeeded */
  success: boolean;
  /** Tool's return value (if successful) */
  output?: unknown;
  /** Error message (if failed) */
  error?: string;
  /** How long the tool call took */
  durationMs: number;
}

// ============================================================
// Checkpoint & Snapshot
// ============================================================

/**
 * A point-in-time snapshot of system state, captured before a risky operation.
 * Used as the source for rollback.
 */
export interface Checkpoint {
  /** Unique identifier (UUID v4) */
  id: string;
  /** The operation this checkpoint was created for */
  operationId: string;
  /** Currently only 'pre_operation'; reserved for future checkpoint types */
  type: 'pre_operation';
  /** File-level snapshots */
  fileSnapshots: FileSnapshot[];
  /** Database-level snapshot (if applicable) */
  dbSnapshot?: DatabaseSnapshot;
  /** When this checkpoint was created */
  createdAt: Date;
}

/**
 * A reference to a single file's state at checkpoint time.
 * The actual content is stored in the shadow git repository.
 */
export interface FileSnapshot {
  /** Absolute file path */
  path: string;
  /** SHA-256 hash of file content (for integrity verification) */
  contentHash: string;
  /** Git commit SHA in the shadow repository where content is stored */
  gitCommitSha: string;
}

/**
 * A snapshot of database state. Extensible for different DB backends.
 */
export interface DatabaseSnapshot {
  /** Database type identifier */
  type: 'sqlite' | 'postgres' | 'mysql';
  /** Connection reference or backup file path */
  reference: string;
  /** Tables included in this snapshot */
  tables: string[];
}

// ============================================================
// Risk Assessment
// ============================================================

/**
 * Full risk breakdown for an operation, combining all scoring layers.
 */
export interface RiskAssessment {
  /** Matches MCPOperation.id */
  operationId: string;
  /**
   * L1: Static rule-based score.
   * Day 1 score. Derived from operation type and params alone.
   * Range: [0.0, 1.0]
   */
  staticScore: number;
  /**
   * L2: User history score.
   * Available after user has enough operation history (typically week 2+).
   * Range: [0.0, 1.0] or -1 if insufficient data
   */
  userHistoryScore: number;
  /**
   * L3: Community collaborative score.
   * Available after community data submission opt-in (typically month 3+).
   * Range: [0.0, 1.0] or -1 if unavailable
   */
  communityScore: number;
  /**
   * Weighted final score:
   * finalScore = w1*staticScore + w2*userHistoryScore + w3*communityScore
   * Range: [0.0, 1.0]
   */
  finalScore: number;
  /** Static rules that fired for this operation */
  triggeredRules: string[];
  /**
   * Structured rule details — same data as triggeredRules but richer.
   * Populated by RiskScoringEngine and preserved through the pipeline.
   */
  firedRuleDetails?: FiredRule[];
  /** When this assessment was computed */
  assessedAt: Date;
}

// ============================================================
// Rollback
// ============================================================

/**
 * A request to restore system state to a previous checkpoint.
 */
export interface RollbackRequest {
  /** The checkpoint to restore to */
  checkpointId: string;
  /** Who initiated the rollback */
  requestedBy: 'user' | 'system';
  /** Why the rollback was requested */
  reason: string;
}

/**
 * The outcome of a rollback attempt.
 */
export interface RollbackResult {
  /** Whether the rollback completed successfully */
  success: boolean;
  /** Files that were successfully restored */
  restoredFiles: string[];
  /** Files that could not be restored */
  failedFiles: string[];
  /** Error message if rollback failed or partially failed */
  error?: string;
}

// ============================================================
// Plugin Adapter SDK
// @public — This interface is stable and part of AgentsGate's public API.
// Changes must be backward-compatible and versioned.
// ============================================================

/**
 * @public
 * Interface that community-contributed rollback adapters must implement.
 * Enables rollback for SaaS tools and external services beyond the filesystem.
 *
 * @example
 * class GitHubIssueAdapter implements RollbackAdapter {
 *   readonly adapterId = 'github-issues';
 *   readonly version = '1.0.0';
 *   readonly supportedTools = ['github'];
 *   // ... implement all methods
 * }
 */
export interface RollbackAdapter {
  /** Unique adapter identifier (e.g., 'github-issues', 'notion-pages') */
  readonly adapterId: string;
  /** Adapter version following semver */
  readonly version: string;
  /** MCP tool names this adapter can handle (e.g., ['github', 'github-mcp']) */
  readonly supportedTools: string[];

  /** Check if this adapter can roll back a specific operation */
  canRollback(operation: MCPOperation): Promise<RollbackCapability>;
  /** Capture current state before the operation executes */
  captureState(context: MCPOperation): Promise<StateSnapshot>;
  /** Restore state from a previously captured snapshot */
  rollback(snapshot: StateSnapshot): Promise<RollbackResult>;
  /** Preview what rollback would do without actually executing it */
  previewRollback(snapshot: StateSnapshot): Promise<RollbackPreview>;
}

/**
 * @public
 * An adapter's self-reported capability to roll back a specific operation.
 */
export interface RollbackCapability {
  /** Whether rollback is possible for this operation */
  canRollback: boolean;
  /** Confidence level [0.0, 1.0] that rollback will succeed */
  confidence: number;
  /** Estimated time for rollback in milliseconds */
  estimatedDuration?: number;
  /** Known limitations of this rollback (e.g., "cannot restore file attachments") */
  limitations?: string[];
}

/**
 * @public
 * External service state captured by a plugin adapter before an operation.
 */
export interface StateSnapshot {
  /** ID of the adapter that captured this snapshot */
  adapterId: string;
  /** The operation this snapshot was taken for */
  operationId: string;
  /** Adapter-specific state data (opaque to AgentsGate core) */
  data: Record<string, unknown>;
  /** When this snapshot was captured */
  capturedAt: Date;
}

/**
 * @public
 * Dry-run preview of what a rollback would do.
 */
export interface RollbackPreview {
  /** Resources/actions that will be restored */
  willRestore: string[];
  /** Resources/actions that cannot be restored */
  cannotRestore: string[];
  /** Non-blocking warnings the user should be aware of */
  warnings: string[];
}

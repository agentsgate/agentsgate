import http from 'node:http';
import type { MCPOperation, ProxyDecision, ExecutionResult, RiskAssessment } from '../../types/interfaces.js';
import type { RiskScoringEngine } from '../m6-risk/index.js';
import type { InterventionController } from '../m7-intervention/index.js';
import type { CheckpointEngine } from '../m4-checkpoint/index.js';
import type { OperationLogger } from '../m3-logger/index.js';
import type { RiskIntelligenceEngine } from '../m11-intelligence/index.js';
import type { ApprovalQueue } from '../m10-dashboard/index.js';
import type { TelemetryService } from '../m13-telemetry/index.js';
import type { AgentRateLimiter } from '../../utils/rate-limiter.js';
import type { AgentQuotaManager } from '../../utils/agent-quota.js';
import type { VelocityDetector } from '../../utils/velocity-detector.js';
import type { AgentsGatePolicy } from '../../policy.js';
import { evaluatePolicyScore, evaluatePolicyAction, evaluatePolicyActionWithRule, getPolicyRedactKeys, watchPolicy, loadPolicy } from '../../policy.js';
import type { WSGateway } from '../../utils/ws-gateway.js';
import type { AgentCircuitBreaker } from '../../utils/circuit-breaker.js';
import type { ErrorTracker } from '../../utils/error-tracker.js';

/**
 * Configuration for MCPProxy — both fields are optional and default to
 * pass-through behaviour so the proxy works out of the box.
 */
export interface ProxyConfig {
  /**
   * Risk evaluation function. Called for every intercepted operation.
   * Defaults to allow-all (riskScore 0.0).
   * Use createPipeline() to wire in the full M6 → M7 → M4 stack.
   */
  evaluateRisk?: (operation: MCPOperation) => Promise<ProxyDecision>;
  /**
   * Forwards an allowed operation to the real MCP tool and returns its result.
   * Defaults to a no-op that returns success immediately.
   */
  forwardToTool?: (operation: MCPOperation) => Promise<ExecutionResult>;
  /**
   * Optional — retry configuration for `forwardToTool`.
   * When set, failed tool forwarding calls are retried with exponential back-off.
   * Default: no retries (fail immediately on first error).
   */
  forwardRetry?: {
    /** Maximum total attempts (including the first). Default: 3. Min: 1. */
    maxAttempts: number;
    /** Delay before the 2nd attempt in ms (default: 100). */
    initialDelayMs: number;
    /** Multiplier applied to delay each attempt (default: 2.0). */
    backoffMultiplier: number;
  };
}

/**
 * Modules needed to build the full protection pipeline.
 */
export interface PipelineModules {
  riskEngine: RiskScoringEngine;
  interventionController: InterventionController;
  /** Optional — if present, pre-operation checkpoints are created for risky ops. */
  checkpointEngine?: CheckpointEngine;
  /** Optional — if present, every intercepted operation is logged. */
  logger?: OperationLogger;
  /**
   * Optional — if present, L2 user-history and L3 community scores are fetched
   * from M11 and blended into the final risk score before the intervention decision.
   */
  intelligenceEngine?: RiskIntelligenceEngine;
  /**
   * Optional — if present, operations that receive a `require_approval` decision
   * are automatically added to this queue for human review.
   */
  approvalQueue?: ApprovalQueue;
  /**
   * Optional — if present, every intercepted operation and its decision are
   * recorded in the telemetry buffer (anonymized, no PII).
   */
  telemetry?: TelemetryService;
  /**
   * Optional — if present, operations from agents exceeding the configured
   * rate limit are blocked immediately before risk assessment.
   */
  rateLimiter?: AgentRateLimiter;
  /**
   * Minimum finalScore that triggers a checkpoint (default: 0.3).
   * Operations scoring at or above this threshold get a checkpoint before execution.
   */
  checkpointThreshold?: number;
  /**
   * Optional — if present, a velocity-based risk boost is added to the final
   * score for agents that fire many operations in a short window.
   */
  velocityDetector?: VelocityDetector;
  /**
   * Optional — custom risk rules and intervention threshold overrides.
   * Policy score rules replace the L1 static score for matching operations.
   * Policy action rules force allow/block/require_approval after all scoring.
   */
  policy?: AgentsGatePolicy;
  /**
   * Optional — called after every operation is evaluated.
   * Use to push live-update notifications (e.g. SSE) to connected clients.
   */
  onOperation?: (operation: MCPOperation, decision: ProxyDecision) => void;
  /**
   * Optional — path to a policy JSON file that will be watched for changes.
   * When the file changes, the policy is hot-reloaded without restarting the proxy.
   * Takes precedence over the `policy` field once loaded.
   */
  policyPath?: string;
  /**
   * Optional — if present, every proxy decision is broadcast to all connected
   * WebSocket clients via WSGateway.broadcast(). This is a convenience wrapper
   * around onOperation; both can be used simultaneously.
   */
  wsGateway?: WSGateway;
  /**
   * Optional — set of session IDs that have been force-expired.
   * Any operation whose sessionId is in this set is immediately blocked.
   * Use `POST /sessions/:id/expire` on the DashboardAPI to populate this at runtime.
   */
  expiredSessions?: Set<string>;
  /**
   * When true, the pipeline logs and scores every operation normally but always
   * forwards it — actions of 'block' and 'require_approval' are downgraded to
   * 'allow'.  The ProxyDecision is annotated with dryRun: true.
   * Useful for testing a new policy without disrupting real agent workflows.
   */
  dryRun?: boolean;
  /**
   * Optional — if present, agents whose circuit is open (too many consecutive
   * blocks) are blocked immediately before risk assessment.
   */
  circuitBreaker?: AgentCircuitBreaker;
  /**
   * Optional — if present, per-agent daily operation quotas are enforced.
   * Operations from agents that have exceeded their daily quota are blocked immediately.
   */
  quotaManager?: AgentQuotaManager;
  /**
   * Optional — if present, errors thrown inside the pipeline are recorded in the
   * ErrorTracker ring buffer and optionally streamed to stderr (debug mode).
   */
  errorTracker?: ErrorTracker;
  /**
   * Optional — if present, applies hit-count decay to repeated rule firings.
   * When the same rule fires N times for the same agentId, the effective score
   * is multiplied by `max(minMultiplier, 1 / (1 + N * decayRate))`.
   *
   * Example: decayRate=0.3, minMultiplier=0.3 — after 10 hits, score is multiplied by ~0.25 (floored at 0.3)
   */
  hitDecay?: {
    /** Decay rate per hit (0–1). Higher = faster decay. Default 0.3. */
    decayRate: number;
    /** Minimum multiplier floor — score never decays below this fraction. Default 0.2. */
    minMultiplier: number;
  };
  /**
   * Optional — if present, only operations whose tool+method matches an entry
   * are forwarded. All others are blocked immediately before risk assessment.
   *
   * Format:
   *   - "tool:method"  — exact tool + method match
   *   - "tool:*"       — all methods of this tool
   *   - "*"            — allow everything (same as not setting this field)
   *
   * Example: ["slack:send_message", "database:*"]
   */
  allowTools?: string[];
}

const DEFAULT_CHECKPOINT_THRESHOLD = 0.3;

/**
 * Build a ProxyConfig.evaluateRisk function that runs the full protection pipeline:
 *   MCPOperation → M6 (risk assess) → M4 (checkpoint if risky) → M7 (decide) → M3 (log)
 *
 * @example
 * const proxy = new MCPProxy(createPipeline({ riskEngine, interventionController, ... }));
 */
export function createPipeline(modules: PipelineModules): ProxyConfig {
  const {
    riskEngine,
    interventionController,
    checkpointEngine,
    logger,
    intelligenceEngine,
    approvalQueue,
    telemetry,
    rateLimiter,
    velocityDetector,
    checkpointThreshold = DEFAULT_CHECKPOINT_THRESHOLD,
    onOperation,
    policyPath,
    expiredSessions,
    dryRun = false,
    quotaManager,
    wsGateway,
    circuitBreaker,
    errorTracker,
    allowTools,
    hitDecay,
  } = modules;

  // Hit-count map for R4 decay — keyed by "agentId:ruleId"
  const hitCounts = new Map<string, number>();

  // Mutable policy ref — updated via hot-reload watcher when policyPath is set
  let activePolicy = modules.policy;
  if (policyPath) {
    // Load initial policy from file (non-blocking; first few ops may use modules.policy)
    loadPolicy(policyPath).then(p => { activePolicy = p; }).catch(() => { /* use default */ });
    watchPolicy(policyPath, updated => { activePolicy = updated; });
  }

  return {
    evaluateRisk: async (operation: MCPOperation): Promise<ProxyDecision> => {
      try {
      // Expired-session check — blocks immediately before any scoring
      if (expiredSessions && operation.sessionId && expiredSessions.has(operation.sessionId)) {
        const blocked: ProxyDecision = {
          action: 'block',
          riskScore: 1.0,
          reasons: [`Session ${operation.sessionId} has been force-expired`],
        };
        if (logger) await logger.log(operation, blocked);
        if (telemetry) await telemetry.record(operation, blocked);
        if (onOperation) onOperation(operation, blocked);
        if (wsGateway) wsGateway.broadcast(operation, blocked);
        return blocked;
      }

      // Daily quota check — block if agent has exceeded their daily operation cap
      if (quotaManager && !quotaManager.check(operation.agentId)) {
        const blocked: ProxyDecision = {
          action: 'block',
          riskScore: 1.0,
          reasons: [`Daily quota exceeded for agent ${operation.agentId}`],
        };
        if (logger) await logger.log(operation, blocked);
        if (telemetry) await telemetry.record(operation, blocked);
        if (onOperation) onOperation(operation, blocked);
        if (wsGateway) wsGateway.broadcast(operation, blocked);
        return blocked;
      }

      // Circuit-breaker check — block if agent has too many consecutive failures
      if (circuitBreaker && circuitBreaker.isOpen(operation.agentId)) {
        const blocked: ProxyDecision = {
          action: 'block',
          riskScore: 1.0,
          reasons: [`Circuit open: agent ${operation.agentId} has too many consecutive blocked operations`],
        };
        if (logger) await logger.log(operation, blocked);
        if (telemetry) await telemetry.record(operation, blocked);
        if (onOperation) onOperation(operation, blocked);
        if (wsGateway) wsGateway.broadcast(operation, blocked);
        return blocked;
      }

      // Tool allow-list — block immediately if tool+method not in the allow-list
      if (allowTools && allowTools.length > 0 && !allowTools.includes('*')) {
        const key = `${operation.tool}:${operation.method}`;
        const wildcardKey = `${operation.tool}:*`;
        if (!allowTools.includes(key) && !allowTools.includes(wildcardKey)) {
          const blocked: ProxyDecision = {
            action: 'block',
            riskScore: 1.0,
            reasons: [`Tool '${operation.tool}:${operation.method}' is not in the allow-list`],
          };
          if (logger) await logger.log(operation, blocked);
          if (telemetry) await telemetry.record(operation, blocked);
          if (onOperation) onOperation(operation, blocked);
          if (wsGateway) wsGateway.broadcast(operation, blocked);
          return blocked;
        }
      }

      // Rate-limit check — fast path before any scoring
      if (rateLimiter && !rateLimiter.check(operation.agentId)) {
        const blocked: ProxyDecision = {
          action: 'block',
          riskScore: 1.0,
          reasons: ['Rate limit exceeded: too many operations per minute for this agent'],
        };
        if (logger) await logger.log(operation, blocked);
        if (telemetry) await telemetry.record(operation, blocked);
        if (wsGateway) wsGateway.broadcast(operation, blocked);
        return blocked;
      }

      // L1 static risk assessment
      let l1Assessment = await riskEngine.assess(operation);

      // Rule score overrides — replace individual rule scores before muting
      if (activePolicy?.ruleOverrides && l1Assessment.firedRuleDetails) {
        const overrides = activePolicy.ruleOverrides;
        const overriddenDetails = l1Assessment.firedRuleDetails.map(r =>
          Object.prototype.hasOwnProperty.call(overrides, r.id) ? { ...r, score: overrides[r.id] ?? r.score } : r
        );
        const hasChange = overriddenDetails.some((r, i) => r.score !== l1Assessment.firedRuleDetails![i]!.score);
        if (hasChange) {
          const newScore = overriddenDetails.reduce((max, r) => Math.max(max, r.score ?? 0), 0);
          l1Assessment = {
            ...l1Assessment,
            firedRuleDetails: overriddenDetails,
            finalScore: newScore,
            staticScore: newScore,
          };
        }
      }

      // Muted rules — strip suppressed rules and recompute the score
      if (activePolicy?.mutedRules && activePolicy.mutedRules.length > 0 && l1Assessment.firedRuleDetails) {
        const muted = new Set(activePolicy.mutedRules);
        const kept = l1Assessment.firedRuleDetails.filter(r => !muted.has(r.id));
        const mutedIds = l1Assessment.firedRuleDetails.filter(r => muted.has(r.id)).map(r => r.id);
        if (mutedIds.length > 0) {
          const newScore = kept.reduce((max, r) => Math.max(max, r.score), 0);
          l1Assessment = {
            ...l1Assessment,
            finalScore: newScore,
            staticScore: newScore,
            firedRuleDetails: kept,
            triggeredRules: [
              ...l1Assessment.triggeredRules.filter(id => !muted.has(id)),
              ...mutedIds.map(id => `MUTED:${id}`),
            ],
          };
        }
      }

      // Policy score override — replaces L1 staticScore when a rule matches
      let baseAssessment: RiskAssessment = l1Assessment;
      if (activePolicy) {
        const policyScore = evaluatePolicyScore(activePolicy, operation);
        if (policyScore !== null) {
          // Find which rule produced the score so we can show it in the dashboard
          const scoringRule = activePolicy.rules.find(r => r.score !== undefined);
          const policyScoreFiredRule: import('../../types/interfaces.js').FiredRule | undefined = scoringRule
            ? { id: scoringRule.id, score: policyScore, layer: 'policy', description: scoringRule.description }
            : undefined;
          baseAssessment = {
            ...l1Assessment,
            staticScore: policyScore,
            finalScore: policyScore,
            triggeredRules: [...l1Assessment.triggeredRules, `POLICY_SCORE_OVERRIDE`],
            firedRuleDetails: policyScoreFiredRule
              ? [...(l1Assessment.firedRuleDetails ?? []), policyScoreFiredRule]
              : l1Assessment.firedRuleDetails,
          };
        }
      }

      // R4: Hit-count decay — reduce score for repeatedly-fired rules
      let assessment: RiskAssessment = baseAssessment;
      if (hitDecay && assessment.firedRuleDetails && assessment.firedRuleDetails.length > 0) {
        const { decayRate, minMultiplier } = hitDecay;
        const decayedDetails = assessment.firedRuleDetails.map(r => {
          const key = `${operation.agentId}:${r.id}`;
          const hits = (hitCounts.get(key) ?? 0) + 1;
          hitCounts.set(key, hits);
          const multiplier = Math.max(minMultiplier, 1 / (1 + hits * decayRate));
          return { ...r, score: r.score * multiplier };
        });
        const newScore = decayedDetails.length > 0
          ? Math.max(...decayedDetails.map(r => r.score))
          : assessment.staticScore;
        assessment = {
          ...assessment,
          firedRuleDetails: decayedDetails,
          staticScore: newScore,
          finalScore: newScore,
        };
      }

      // L2 / L3 — blend in scores from M11 when available
      if (intelligenceEngine) {
        const [l2, l3] = await Promise.all([
          intelligenceEngine.getUserHistoryScore(operation.agentId, operation.tool),
          intelligenceEngine.getCommunityScore(operation),
        ]);
        if (l2 >= 0 || l3 >= 0) {
          const finalScore = blendScores(baseAssessment.staticScore, l2, l3);
          assessment = { ...baseAssessment, userHistoryScore: l2, communityScore: l3, finalScore };
        }
      }

      // Velocity boost — rapid-fire operations get an additive risk penalty
      if (velocityDetector) {
        const boost = velocityDetector.record(operation.agentId);
        if (boost > 0) {
          const boostedScore = Math.min(1, assessment.finalScore + boost);
          const velocityRule: import('../../types/interfaces.js').FiredRule = {
            id: 'VELOCITY_BOOST',
            score: boost,
            layer: 'L1',
            description: `Agent fired ${velocityDetector.getCount(operation.agentId)} ops in ${velocityDetector.config.windowMs / 1000}s window`,
          };
          assessment = {
            ...assessment,
            finalScore: boostedScore,
            firedRuleDetails: [...(assessment.firedRuleDetails ?? []), velocityRule],
          };
        }
      }

      // Create a pre-operation checkpoint when the risk score warrants it
      let checkpointId: string | undefined;
      if (checkpointEngine && assessment.finalScore >= checkpointThreshold) {
        const cp = await checkpointEngine.create(operation);
        checkpointId = cp.id;
      }

      // Translate assessment into allow/require_approval/block decision
      let decision = await interventionController.decide(assessment, checkpointId);

      // Attach structured fired-rule details for transparency
      if (assessment.firedRuleDetails && assessment.firedRuleDetails.length > 0) {
        decision = { ...decision, firedRules: assessment.firedRuleDetails };
      }

      // Policy action override — forces action after threshold-based decision
      if (activePolicy) {
        const policyMatch = evaluatePolicyActionWithRule(activePolicy, operation);
        if (policyMatch !== null) {
          const { action: policyAction, rule: matchedRule } = policyMatch;
          const policyActionFiredRule: import('../../types/interfaces.js').FiredRule = {
            id: matchedRule.id,
            score: matchedRule.score ?? assessment.finalScore,
            layer: 'policy',
            description: matchedRule.description,
          };
          decision = {
            ...decision,
            action: policyAction,
            reasons: [`Policy rule forced action: ${policyAction}`, ...decision.reasons],
            firedRules: [...(decision.firedRules ?? []), policyActionFiredRule],
          };
        }
      }

      // Dry-run override — downgrade any non-allow decision to allow
      if (dryRun && decision.action !== 'allow') {
        decision = {
          ...decision,
          action: 'allow',
          reasons: [`[DRY-RUN] Would have ${decision.action}`, ...decision.reasons],
          dryRun: true,
        };
      } else if (dryRun) {
        decision = { ...decision, dryRun: true };
      }

      // Queue for human review when approval is required
      if (approvalQueue && decision.action === 'require_approval') {
        approvalQueue.enqueue(operation, decision.riskScore, checkpointId);
      }

      // Audit log — apply any per-rule extra redaction keys from policy
      const extraRedactKeys = activePolicy ? getPolicyRedactKeys(activePolicy, operation) : [];
      if (logger) await logger.log(operation, decision, undefined, extraRedactKeys);

      // Anonymized telemetry (no PII)
      if (telemetry) await telemetry.record(operation, decision);

      // Circuit-breaker feedback
      if (circuitBreaker) {
        if (decision.action === 'block') circuitBreaker.recordBlock(operation.agentId);
        else if (decision.action === 'allow') circuitBreaker.recordAllow(operation.agentId);
      }

      // Live-update notification (e.g. SSE push)
      if (onOperation) onOperation(operation, decision);

      // WebSocket broadcast
      if (wsGateway) wsGateway.broadcast(operation, decision);

      return decision;
      } catch (err) {
        errorTracker?.track('proxy', err, { operationId: operation.id });
        throw err;
      }
    },
  };
}

/**
 * M1: MCP Proxy Core
 * Intercepts MCP tool calls, applies the risk pipeline, and forwards or blocks them.
 */
export class MCPProxy {
  private server: http.Server | null = null;
  private readonly evaluateRisk: (op: MCPOperation) => Promise<ProxyDecision>;
  private readonly forwardToTool: (op: MCPOperation) => Promise<ExecutionResult>;
  private readonly forwardRetry?: ProxyConfig['forwardRetry'];

  constructor(config: ProxyConfig = {}) {
    this.evaluateRisk = config.evaluateRisk ?? defaultEvaluateRisk;
    this.forwardToTool = config.forwardToTool ?? defaultForwardToTool;
    this.forwardRetry = config.forwardRetry;
  }

  /**
   * Start the proxy HTTP server on the given port.
   * Binds to loopback (`127.0.0.1`) by default; this transport is unauthenticated,
   * so only pass a routable host when a trusted authenticating reverse proxy fronts it.
   */
  async start(port: number, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      this.server.once('error', reject);
      this.server.listen(port, host, () => resolve());
    });
  }

  /** Stop the proxy and close the HTTP server. */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(err => {
        this.server = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Core intercept method. Runs the risk pipeline and, if allowed,
   * forwards the operation to the real tool.
   */
  async intercept(operation: MCPOperation): Promise<ProxyDecision> {
    const decision = await this.evaluateRisk(operation);

    if (decision.action === 'allow') {
      await this.forwardWithRetry(operation);
    }

    return decision;
  }

  private async forwardWithRetry(operation: MCPOperation): Promise<ExecutionResult> {
    if (!this.forwardRetry) {
      return this.forwardToTool(operation);
    }
    const { maxAttempts, initialDelayMs, backoffMultiplier } = this.forwardRetry;
    let attempt = 0;
    let delayMs = initialDelayMs;
    while (true) {
      attempt++;
      try {
        return await this.forwardToTool(operation);
      } catch (err) {
        if (attempt >= maxAttempts) throw err;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        delayMs = Math.round(delayMs * backoffMultiplier);
      }
    }
  }

  // ── HTTP request handler ─────────────────────────────────────────────────

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      if (err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE') {
        // Drain the rest of the incoming body so the client can finish writing
        // and receive this response cleanly instead of a reset connection.
        req.resume();
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('Payload Too Large');
        return;
      }
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
      return;
    }

    let operation: MCPOperation;
    try {
      const raw = JSON.parse(body) as unknown as MCPOperation & { timestamp: string };
      operation = { ...raw, timestamp: new Date(raw.timestamp) };
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid JSON');
      return;
    }

    const decision = await this.intercept(operation);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(decision));
  }
}

// ── Private helpers ──────────────────────────────────────────────────────────

/** Maximum accepted request body (1 MiB) — bounds memory against oversized POSTs. */
const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering; the handler drains and responds 413. Discard the rest.
        chunks.length = 0;
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function defaultEvaluateRisk(_operation: MCPOperation): Promise<ProxyDecision> {
  return {
    action: 'allow',
    riskScore: 0.0,
    reasons: ['pass-through: no risk rules configured'],
  };
}

async function defaultForwardToTool(_operation: MCPOperation): Promise<ExecutionResult> {
  return { success: true, durationMs: 0 };
}

/**
 * Recompute the final risk score after L2/L3 scores become available.
 * Mirrors the weighting logic in M6 RiskScoringEngine.computeFinalScore.
 */
function blendScores(l1: number, l2: number, l3: number): number {
  const hasL2 = l2 >= 0;
  const hasL3 = l3 >= 0;
  if (hasL2 && hasL3) return clamp(0.5 * l1 + 0.3 * l2 + 0.2 * l3);
  if (hasL2) return clamp(0.6 * l1 + 0.4 * l2);
  return clamp(l1);
}

function clamp(v: number): number {
  return Math.min(1, Math.max(0, v));
}

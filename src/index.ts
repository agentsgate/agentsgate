/**
 * AgentsGate — Main Entry Point
 * Re-exports all 13 module stubs.
 */

export { MCPProxy, createPipeline } from './modules/m1-proxy/index.js';
export type { PipelineModules } from './modules/m1-proxy/index.js';
export { MCPStdioProxy } from './modules/m1-proxy/stdio.js';
export type { StdioProxyOptions } from './modules/m1-proxy/stdio.js';
export { MCPStreamableHttpProxy } from './modules/m1-proxy/streamable-http.js';
export type { StreamableHttpProxyOptions } from './modules/m1-proxy/streamable-http.js';
export { StateStore } from './modules/m2-store/index.js';
export { OperationLogger, redactParams } from './modules/m3-logger/index.js';
export { CheckpointEngine } from './modules/m4-checkpoint/index.js';
export { FileShadowSystem } from './modules/m5-shadow/index.js';
export { RiskScoringEngine } from './modules/m6-risk/index.js';
export { InterventionController } from './modules/m7-intervention/index.js';
export { RollbackEngine } from './modules/m8-rollback/index.js';
export { PluginAdapterRegistry, BaseRollbackAdapter, GitHubPRRollbackAdapter, DatabaseTableRollbackAdapter } from './modules/m9-plugin-sdk/index.js';
export type { RollbackAdapter, GitHubPRAdapterOptions, DatabaseRollbackAdapterOptions } from './modules/m9-plugin-sdk/index.js';
export { DatabaseRollbackAdapter } from './modules/m9-adapters/database-rollback-adapter.js';
export { PostgreSQLRollbackAdapter } from './modules/m9-adapters/pg-rollback-adapter.js';
export { MySQLRollbackAdapter } from './modules/m9-adapters/mysql-rollback-adapter.js';
export { SlackRollbackAdapter } from './modules/m9-adapters/slack-rollback-adapter.js';
export { DashboardAPI, ApprovalQueue } from './modules/m10-dashboard/index.js';
export type { PendingApproval, DashboardOptions, ApprovalQueueOptions } from './modules/m10-dashboard/index.js';
export { RiskIntelligenceEngine } from './modules/m11-intelligence/index.js';
export type { IntelligenceOptions, ToolBreakdown } from './modules/m11-intelligence/index.js';
export { CommunityAdapterRegistry } from './modules/m12-registry/index.js';
export { TelemetryService } from './modules/m13-telemetry/index.js';
export type { TelemetryStats, TelemetryExportResult, AnomalyAlert, SessionTelemetryStats } from './modules/m13-telemetry/index.js';

export { quoteIdentifier, quoteIdentifierMysql } from './utils/sql.js';
export { AgentRateLimiter, ToolRateLimiter } from './utils/rate-limiter.js';
export type { ToolRateLimitConfig } from './utils/rate-limiter.js';
export { AgentQuotaManager } from './utils/agent-quota.js';
export type { AgentQuotaOptions } from './utils/agent-quota.js';
export { signLog, verifyLog, stampLog, auditLogs, verifyChain, GENESIS_HMAC } from './utils/audit-hmac.js';
export { SlackNotifier } from './utils/slack-notifier.js';
export type { SlackNotifierOptions } from './utils/slack-notifier.js';
export { MCPServerRegistry } from './utils/mcp-server-registry.js';
export type { MCPServerConfig } from './utils/mcp-server-registry.js';
export { inject as injectClaudeDesktop, eject as ejectClaudeDesktop, status as claudeDesktopStatus, getClaudeDesktopConfigPath } from './utils/claude-desktop-injector.js';
export type { InjectionStatus, InjectionResult, EjectResult } from './utils/claude-desktop-injector.js';
export { GracefulShutdown } from './utils/graceful-shutdown.js';
export type { GracefulShutdownOptions } from './utils/graceful-shutdown.js';
export { VelocityDetector } from './utils/velocity-detector.js';
export type { VelocityDetectorOptions } from './utils/velocity-detector.js';
export { WSGateway } from './utils/ws-gateway.js';
export type { WSGatewayOptions } from './utils/ws-gateway.js';
export { AgentCircuitBreaker } from './utils/circuit-breaker.js';
export type { CircuitBreakerOptions } from './utils/circuit-breaker.js';
export { ErrorTracker } from './utils/error-tracker.js';
export type { ErrorEntry } from './utils/error-tracker.js';
export { loadConfig, saveConfig, DEFAULT_CONFIG } from './config.js';
export type { AgentsGateConfig } from './config.js';
export { loadPolicy, savePolicy, watchPolicy, matchRule, evaluatePolicyScore, evaluatePolicyAction, evaluatePolicyActionWithRule, mergePolicies, loadPolicies } from './policy.js';
export type { PolicyRule, PolicyRuleMatch, AgentsGatePolicy } from './policy.js';
export { PRESETS as POLICY_PRESETS, PRESET_NAMES, getPreset } from './utils/policy-presets.js';
export type { OperationFilter } from './modules/m2-store/index.js';

// Re-export all shared types
export type {
  MCPOperation,
  ProxyDecision,
  FiredRule,
  OperationLog,
  ExecutionResult,
  Checkpoint,
  FileSnapshot,
  DatabaseSnapshot,
  RiskAssessment,
  RollbackRequest,
  RollbackResult,
  RollbackCapability,
  StateSnapshot,
  RollbackPreview,
} from './types/interfaces.js';

export {
  AgentsGateError,
  CheckpointError,
  RollbackError,
  RiskAssessmentError,
  ProxyError,
} from './types/errors.js';

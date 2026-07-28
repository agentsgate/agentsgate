/**
 * AgentsGate — Error Types
 *
 * THIS FILE IS ARCHITECT-OWNED.
 */

export class AgentsGateError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AgentsGateError';
  }
}

export class CheckpointError extends AgentsGateError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CHECKPOINT_ERROR', context);
    this.name = 'CheckpointError';
  }
}

export class RollbackError extends AgentsGateError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'ROLLBACK_ERROR', context);
    this.name = 'RollbackError';
  }
}

export class RiskAssessmentError extends AgentsGateError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'RISK_ASSESSMENT_ERROR', context);
    this.name = 'RiskAssessmentError';
  }
}

export class ProxyError extends AgentsGateError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'PROXY_ERROR', context);
    this.name = 'ProxyError';
  }
}

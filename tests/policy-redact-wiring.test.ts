/**
 * T240 — Policy-rule-driven parameter redaction wiring.
 *
 * Verifies that:
 *  1. getPolicyRedactKeys returns [] when no rule matches
 *  2. getPolicyRedactKeys returns redact keys from the first matching rule
 *  3. redactParams with extraKeys redacts those keys in addition to built-in patterns
 *  4. OperationLogger.log() with extraRedactKeys redacts the specified fields
 *  5. createPipeline: policy redact rule causes customToken to be '[REDACTED]' in saved log
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getPolicyRedactKeys } from '../src/policy.js';
import type { AgentsGatePolicy } from '../src/policy.js';
import { redactParams, OperationLogger } from '../src/modules/m3-logger/index.js';
import { StateStore } from '../src/modules/m2-store/index.js';
import { createPipeline } from '../src/modules/m1-proxy/index.js';
import type { MCPOperation, RiskAssessment, ProxyDecision } from '../src/types/interfaces.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeOp(overrides: Partial<MCPOperation> = {}): MCPOperation {
  return {
    id: 'op-test-1',
    agentId: 'agent-1',
    tool: 'safe-tool',
    method: 'read',
    params: { data: 'value' },
    timestamp: new Date(),
    sessionId: 'sess-1',
    ...overrides,
  };
}

// ── Test 1: getPolicyRedactKeys — no matching rule ────────────────────────────

describe('getPolicyRedactKeys', () => {
  it('1. returns empty array when no rule matches', () => {
    const policy: AgentsGatePolicy = {
      rules: [
        {
          id: 'R1',
          match: { tool: 'other-tool' },
          redact: ['sensitiveKey'],
        },
      ],
    };
    const op = makeOp({ tool: 'safe-tool' });
    const keys = getPolicyRedactKeys(policy, op);
    expect(keys).toEqual([]);
  });

  // ── Test 2: getPolicyRedactKeys — first matching rule wins ─────────────────

  it('2. returns redact keys from the first matching rule', () => {
    const policy: AgentsGatePolicy = {
      rules: [
        {
          id: 'R-no-redact',
          match: { tool: 'secret-tool' },
          // no redact field
        },
        {
          id: 'R-with-redact',
          match: { tool: 'secret-tool' },
          redact: ['customToken', 'internalKey'],
        },
        {
          id: 'R-other',
          match: { tool: 'secret-tool' },
          redact: ['shouldNotBeReturned'],
        },
      ],
    };
    const op = makeOp({ tool: 'secret-tool' });
    // R-no-redact matches but has no redact field; R-with-redact is the first with redact
    const keys = getPolicyRedactKeys(policy, op);
    expect(keys).toEqual(['customToken', 'internalKey']);
  });
});

// ── Test 3: redactParams with extraKeys ───────────────────────────────────────

describe('redactParams with extraKeys', () => {
  it('3. redacts extraKeys in addition to built-in patterns', () => {
    const params = {
      customToken: 'abc123',
      other: 'visible',
      password: 'hunter2',
    };
    const result = redactParams(params, ['customToken']);
    // extraKey should be redacted
    expect(result['customToken']).toBe('[REDACTED]');
    // built-in pattern should still be redacted
    expect(result['password']).toBe('[REDACTED]');
    // safe field should pass through
    expect(result['other']).toBe('visible');
  });
});

// ── Test 4: OperationLogger.log() with extraRedactKeys ───────────────────────

describe('OperationLogger.log() with extraRedactKeys', () => {
  let store: StateStore;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
  });

  it('4. redacts the specified extraRedactKeys fields in the persisted log', async () => {
    const logger = new OperationLogger(store);
    const op = makeOp({
      id: 'op-extra-redact',
      params: {
        customToken: 'super-secret-value',
        visibleField: 'keep-me',
        password: 'also-secret',
      },
    });
    const decision: ProxyDecision = { action: 'allow', riskScore: 0, reasons: [] };

    const log = await logger.log(op, decision, undefined, ['customToken']);

    // customToken should be redacted via extraKeys
    expect(log.operation.params['customToken']).toBe('[REDACTED]');
    // visibleField should pass through
    expect(log.operation.params['visibleField']).toBe('keep-me');
    // password should be redacted by built-in pattern
    expect(log.operation.params['password']).toBe('[REDACTED]');

    // Also verify what was persisted
    const retrieved = await logger.getLog('op-extra-redact');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.operation.params['customToken']).toBe('[REDACTED]');
    expect(retrieved!.operation.params['visibleField']).toBe('keep-me');
  });
});

// ── Test 5: createPipeline end-to-end with policy redact wiring ───────────────

describe('createPipeline — policy redact wiring (end-to-end)', () => {
  let store: StateStore;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
  });

  it('5. policy rule with redact:[customToken] causes customToken=[REDACTED] in saved log', async () => {
    const logger = new OperationLogger(store);

    // Minimal mock riskEngine: always returns score 0
    const riskEngine = {
      async assess(_op: MCPOperation): Promise<RiskAssessment> {
        return {
          staticScore: 0,
          finalScore: 0,
          triggeredRules: [],
          firedRuleDetails: [],
        };
      },
    };

    // Minimal mock interventionController: always returns allow
    const interventionController = {
      async decide(_assessment: RiskAssessment, _checkpointId?: string): Promise<ProxyDecision> {
        return { action: 'allow', riskScore: 0, reasons: ['mock-allow'] };
      },
    };

    // Policy with a rule that matches 'secret-tool' and redacts 'customToken'
    const policy: AgentsGatePolicy = {
      rules: [
        {
          id: 'R1',
          match: { tool: 'secret-tool' },
          redact: ['customToken'],
        },
      ],
    };

    const config = createPipeline({
      riskEngine: riskEngine as import('../src/modules/m6-risk/index.js').RiskScoringEngine,
      interventionController: interventionController as import('../src/modules/m7-intervention/index.js').InterventionController,
      logger,
      policy,
    });

    const op: MCPOperation = {
      id: 'op-pipeline-redact',
      agentId: 'agent-pipeline',
      tool: 'secret-tool',
      method: 'execute',
      params: {
        customToken: 'abc123',
        other: 'visible',
      },
      timestamp: new Date(),
      sessionId: 'sess-pipeline',
    };

    // Trigger the pipeline
    await config.evaluateRisk!(op);

    // Retrieve the saved log and verify redaction
    const savedLog = await logger.getLog('op-pipeline-redact');
    expect(savedLog).not.toBeNull();
    expect(savedLog!.operation.params['customToken']).toBe('[REDACTED]');
    expect(savedLog!.operation.params['other']).toBe('visible');
  });
});

/**
 * T232 — PolicyRule.max field: score ceiling applied by evaluatePolicyScore().
 */
import { describe, it, expect } from 'vitest';
import { evaluatePolicyScore } from '../src/policy.js';
import type { AgentsGatePolicy } from '../src/policy.js';
import type { MCPOperation } from '../src/types/interfaces.js';

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeOp(overrides: Partial<MCPOperation> = {}): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId: 'test-agent',
    tool: 'filesystem',
    method: 'write_file',
    params: {},
    timestamp: new Date(),
    sessionId: 'session-1',
    ...overrides,
  };
}

function makePolicy(score: number, max?: number): AgentsGatePolicy {
  return {
    rules: [
      {
        id: 'TEST_RULE',
        match: { tool: 'filesystem' },
        score,
        ...(max !== undefined ? { max } : {}),
      },
    ],
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('evaluatePolicyScore — PolicyRule.max ceiling', () => {
  it('1. score: 0.9, max: 0.7 → returns 0.7 (max caps the score)', () => {
    const policy = makePolicy(0.9, 0.7);
    const result = evaluatePolicyScore(policy, makeOp());
    expect(result).toBeCloseTo(0.7, 10);
  });

  it('2. score: 0.5, max: 0.8 → returns 0.5 (max does not restrict score below max)', () => {
    const policy = makePolicy(0.5, 0.8);
    const result = evaluatePolicyScore(policy, makeOp());
    expect(result).toBeCloseTo(0.5, 10);
  });

  it('3. no max field → returns score unchanged', () => {
    const policy = makePolicy(0.65);
    const result = evaluatePolicyScore(policy, makeOp());
    expect(result).toBeCloseTo(0.65, 10);
  });

  it('4. max: 0 → score capped to 0', () => {
    const policy = makePolicy(0.8, 0);
    const result = evaluatePolicyScore(policy, makeOp());
    expect(result).toBeCloseTo(0, 10);
  });

  it('5. max higher than score → score unchanged (max does not boost score)', () => {
    const policy = makePolicy(0.3, 0.9);
    const result = evaluatePolicyScore(policy, makeOp());
    expect(result).toBeCloseTo(0.3, 10);
  });
});

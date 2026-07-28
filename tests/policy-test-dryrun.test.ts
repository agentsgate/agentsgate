/**
 * T202 — Policy dry-run test command.
 * Tests evaluatePolicyAction and evaluatePolicyScore with various
 * simulated operation parameters (the underlying logic of `policy test`).
 */
import { describe, it, expect } from 'vitest';
import { evaluatePolicyAction, evaluatePolicyScore } from '../src/policy.js';
import type { AgentsGatePolicy } from '../src/policy.js';
import type { MCPOperation } from '../src/types/interfaces.js';

function makeSimOp(overrides: Partial<MCPOperation>): MCPOperation {
  return {
    id: 'dry-run',
    agentId: 'test-agent',
    tool: 'filesystem',
    method: 'read_file',
    params: {},
    timestamp: new Date(),
    sessionId: 'dry-run',
    ...overrides,
  };
}

describe('Policy dry-run evaluation (policy test command logic)', () => {
  it('returns null action and null score when no rules match', () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'R1', match: { tool: 'database' }, action: 'block' }],
    };
    const op = makeSimOp({ tool: 'filesystem' });
    expect(evaluatePolicyAction(policy, op)).toBeNull();
    expect(evaluatePolicyScore(policy, op)).toBeNull();
  });

  it('returns forced action when rule matches by tool', () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'R1', match: { tool: 'database', method: '/delete|drop/' }, action: 'block' }],
    };
    const op = makeSimOp({ tool: 'database', method: 'delete_record' });
    expect(evaluatePolicyAction(policy, op)).toBe('block');
  });

  it('returns score override when score rule matches', () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'R1', match: { tool: 'shell' }, score: 0.95 }],
    };
    const op = makeSimOp({ tool: 'shell', method: 'run' });
    expect(evaluatePolicyScore(policy, op)).toBe(0.95);
  });

  it('evaluates path pattern match via params.path', () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'R1', match: { pathPattern: '/secrets/' }, action: 'block' }],
    };
    const op = makeSimOp({ params: { path: '/app/secrets/api-key.txt' } });
    expect(evaluatePolicyAction(policy, op)).toBe('block');
  });

  it('evaluates tag match in dry-run mode', () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'R1', match: { tags: ['prod', 'pci-scope'] }, action: 'require_approval' }],
    };
    const op = makeSimOp({ tags: ['prod', 'pci-scope', 'extra'] });
    expect(evaluatePolicyAction(policy, op)).toBe('require_approval');
  });

  it('evaluates agentId denylist block', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { denylist: ['bad-agent'] },
    };
    const op = makeSimOp({ agentId: 'bad-agent' });
    expect(evaluatePolicyAction(policy, op)).toBe('block');
  });
});

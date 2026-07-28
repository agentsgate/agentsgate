/**
 * T141 — Per-agent tool allowlist/denylist.
 */
import { describe, it, expect } from 'vitest';
import { evaluatePolicyAction } from '../src/policy.js';
import type { AgentsGatePolicy } from '../src/policy.js';
import type { MCPOperation } from '../src/types/interfaces.js';

function makeOp(agentId: string, tool: string, method = 'call'): MCPOperation {
  return { id: 'op-1', agentId, tool, method, params: {}, timestamp: new Date(), sessionId: 's1' };
}

describe('toolRules — denylist', () => {
  it('blocks denied tool for matching agent', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { toolRules: { 'agent-1': { denylist: ['shell'] } } },
    };
    expect(evaluatePolicyAction(policy, makeOp('agent-1', 'shell'))).toBe('block');
  });

  it('allows non-denied tool for matching agent', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { toolRules: { 'agent-1': { denylist: ['shell'] } } },
    };
    expect(evaluatePolicyAction(policy, makeOp('agent-1', 'filesystem'))).toBeNull();
  });

  it('does not apply denylist to non-matching agent', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { toolRules: { 'agent-1': { denylist: ['shell'] } } },
    };
    expect(evaluatePolicyAction(policy, makeOp('agent-2', 'shell'))).toBeNull();
  });

  it('denylist supports /regex/ patterns', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { toolRules: { 'agent-1': { denylist: ['/^exec_/'] } } },
    };
    expect(evaluatePolicyAction(policy, makeOp('agent-1', 'exec_bash'))).toBe('block');
    expect(evaluatePolicyAction(policy, makeOp('agent-1', 'filesystem'))).toBeNull();
  });
});

describe('toolRules — allowlist', () => {
  it('blocks tool not in allowlist for matching agent', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { toolRules: { 'agent-1': { allowlist: ['filesystem'] } } },
    };
    expect(evaluatePolicyAction(policy, makeOp('agent-1', 'shell'))).toBe('block');
  });

  it('allows tool in allowlist for matching agent', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { toolRules: { 'agent-1': { allowlist: ['filesystem'] } } },
    };
    expect(evaluatePolicyAction(policy, makeOp('agent-1', 'filesystem'))).toBeNull();
  });

  it('empty allowlist allows all tools', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { toolRules: { 'agent-1': { allowlist: [] } } },
    };
    expect(evaluatePolicyAction(policy, makeOp('agent-1', 'any-tool'))).toBeNull();
  });

  it('does not restrict non-matching agent', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { toolRules: { 'agent-1': { allowlist: ['filesystem'] } } },
    };
    expect(evaluatePolicyAction(policy, makeOp('agent-2', 'shell'))).toBeNull();
  });
});

describe('toolRules — denylist takes priority over allowlist', () => {
  it('blocks tool when both listed in deny and allow', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: {
        toolRules: {
          'agent-1': { allowlist: ['filesystem'], denylist: ['filesystem'] },
        },
      },
    };
    expect(evaluatePolicyAction(policy, makeOp('agent-1', 'filesystem'))).toBe('block');
  });
});

describe('toolRules — agent pattern matching', () => {
  it('matches agent via /regex/ pattern key', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { toolRules: { '/^readonly-/': { denylist: ['shell'] } } },
    };
    expect(evaluatePolicyAction(policy, makeOp('readonly-bot', 'shell'))).toBe('block');
    expect(evaluatePolicyAction(policy, makeOp('admin-bot', 'shell'))).toBeNull();
  });
});

describe('toolRules — interaction with agent denylist', () => {
  it('agent denylist fires before tool rules are checked', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: {
        denylist: ['blocked-agent'],
        toolRules: { 'blocked-agent': { allowlist: ['filesystem'] } },
      },
    };
    // Should be blocked by denylist, not by tool allowlist
    expect(evaluatePolicyAction(policy, makeOp('blocked-agent', 'filesystem'))).toBe('block');
  });
});

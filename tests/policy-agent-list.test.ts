/**
 * T134 — Agent allowlist/denylist policy enforcement.
 */
import { describe, it, expect } from 'vitest';
import { evaluatePolicyAction } from '../src/policy.js';
import type { AgentsGatePolicy, PolicyRule } from '../src/policy.js';
import type { MCPOperation } from '../src/types/interfaces.js';

function makeOp(agentId: string, tool = 'filesystem', method = 'write_file'): MCPOperation {
  return { id: 'op-1', agentId, tool, method, params: {}, timestamp: new Date(), sessionId: 'sess-1' };
}

describe('evaluatePolicyAction — denylist', () => {
  it('blocks exact-match agentId on denylist', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { denylist: ['bad-agent'] },
    };
    expect(evaluatePolicyAction(policy, makeOp('bad-agent'))).toBe('block');
  });

  it('allows agent not on denylist', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { denylist: ['bad-agent'] },
    };
    expect(evaluatePolicyAction(policy, makeOp('good-agent'))).toBeNull();
  });

  it('denylist supports /regex/ patterns', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { denylist: ['/^untrusted-/'] },
    };
    expect(evaluatePolicyAction(policy, makeOp('untrusted-bot'))).toBe('block');
    expect(evaluatePolicyAction(policy, makeOp('trusted-bot'))).toBeNull();
  });

  it('denylist takes priority over allowlist', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { allowlist: ['agent-x'], denylist: ['agent-x'] },
    };
    // Denylist evaluated first — still blocked even though in allowlist
    expect(evaluatePolicyAction(policy, makeOp('agent-x'))).toBe('block');
  });
});

describe('evaluatePolicyAction — allowlist', () => {
  it('blocks agents not on allowlist when allowlist is non-empty', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { allowlist: ['approved-agent'] },
    };
    expect(evaluatePolicyAction(policy, makeOp('unknown-agent'))).toBe('block');
  });

  it('allows agents on the allowlist', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { allowlist: ['approved-agent'] },
    };
    expect(evaluatePolicyAction(policy, makeOp('approved-agent'))).toBeNull();
  });

  it('empty allowlist allows all agents', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { allowlist: [] },
    };
    expect(evaluatePolicyAction(policy, makeOp('any-agent'))).toBeNull();
  });

  it('allowlist supports /regex/ patterns', () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { allowlist: ['/^claude-/'] },
    };
    expect(evaluatePolicyAction(policy, makeOp('claude-dev'))).toBeNull();
    expect(evaluatePolicyAction(policy, makeOp('gpt-4'))).toBe('block');
  });
});

describe('evaluatePolicyAction — agent checks before rules', () => {
  it('denylist fires before allow-all rule', () => {
    const allowAll: PolicyRule = { id: 'ALLOW_ALL', match: {}, action: 'allow' };
    const policy: AgentsGatePolicy = {
      rules: [allowAll],
      agents: { denylist: ['blocked-agent'] },
    };
    // Rule says allow, but denylist should win
    expect(evaluatePolicyAction(policy, makeOp('blocked-agent'))).toBe('block');
    // Other agents fall through to the rule
    expect(evaluatePolicyAction(policy, makeOp('other-agent'))).toBe('allow');
  });

  it('no agents config — rules apply as normal', () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'BLOCK_ALL', match: {}, action: 'block' }],
    };
    expect(evaluatePolicyAction(policy, makeOp('any-agent'))).toBe('block');
  });
});

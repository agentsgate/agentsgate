/**
 * `/pattern/flags` in a policy match must be treated as a regular expression.
 *
 * `matchesField` only recognised a pattern that both started *and ended* with a
 * slash, so anything carrying flags — `/delete|drop/i`, the form written in the
 * README, in this project's own policy guide, and in every built-in preset —
 * fell through to an exact string comparison and never matched.
 *
 * That made `agentsgate policy preset apply readonly` inert: its rules claim to
 * block every write, delete and exec, and blocked none of them. Someone
 * applying it to lock an agent down got no rule enforcement at all.
 */
import { describe, it, expect } from 'vitest';
import { evaluatePolicyAction, evaluatePolicyScore } from '../src/policy.js';
import type { AgentsGatePolicy } from '../src/policy.js';
import type { MCPOperation } from '../src/types/interfaces.js';
import { getPreset } from '../src/utils/policy-presets.js';

function op(over: Partial<MCPOperation> = {}): MCPOperation {
  return {
    id: 'op-1',
    agentId: 'agent-1',
    tool: 'filesystem',
    method: 'delete_file',
    params: {},
    timestamp: new Date(),
    sessionId: 's-1',
    ...over,
  } as MCPOperation;
}

const block = (match: AgentsGatePolicy['rules'][number]['match']): AgentsGatePolicy => ({
  rules: [{ id: 'R', match, action: 'block' }],
});

describe('regex patterns with flags', () => {
  it('matches a method with an alternation and an /i flag', () => {
    const policy = block({ method: '/delete|drop/i' });
    expect(evaluatePolicyAction(policy, op({ method: 'delete_file' }))).toBe('block');
  });

  it('still matches without flags', () => {
    const policy = block({ method: '/delete|drop/' });
    expect(evaluatePolicyAction(policy, op({ method: 'delete_file' }))).toBe('block');
  });

  it('applies to tool, agentId and pathPattern too', () => {
    expect(evaluatePolicyAction(block({ tool: '/^prod-/i' }), op({ tool: 'prod-db' }))).toBe('block');
    expect(evaluatePolicyAction(block({ agentId: '/^test-/i' }), op({ agentId: 'test-7' }))).toBe('block');
  });

  it('does not apply to pathPattern, which is a bare regex source', () => {
    // pathPattern goes straight to the regex engine — no surrounding slashes,
    // no flag suffix. `/secrets/` therefore means the literal path segment.
    expect(
      evaluatePolicyAction(block({ pathPattern: 'secrets' }), op({ params: { path: '/var/secrets/k' } }))
    ).toBe('block');
    expect(
      evaluatePolicyAction(block({ pathPattern: '/secrets/' }), op({ params: { path: '/var/secrets/k' } }))
    ).toBe('block');
    expect(
      evaluatePolicyAction(block({ pathPattern: '/secrets/i' }), op({ params: { path: '/var/secrets/k' } }))
    ).toBeNull();
  });

  it('applies to paramsMatch values', () => {
    const policy = block({ paramsMatch: { channel: '/^D[A-Z0-9]+/i' } });
    expect(evaluatePolicyAction(policy, op({ params: { channel: 'D01ABC' } }))).toBe('block');
    expect(evaluatePolicyAction(policy, op({ params: { channel: 'C01ABC' } }))).toBeNull();
  });

  it('honours a case-sensitive flag set, rather than forcing /i', () => {
    // No flags keeps the historical case-insensitive behaviour...
    expect(evaluatePolicyAction(block({ method: '/DELETE/' }), op({ method: 'delete_file' }))).toBe('block');
    // ...but asking for case sensitivity gets it.
    expect(evaluatePolicyAction(block({ method: '/DELETE/g' }), op({ method: 'delete_file' }))).toBeNull();
    expect(evaluatePolicyAction(block({ method: '/DELETE/g' }), op({ method: 'DELETE_ROW' }))).toBe('block');
  });

  it('does not treat a plain string as a pattern', () => {
    expect(evaluatePolicyAction(block({ method: 'delete' }), op({ method: 'delete_file' }))).toBeNull();
    expect(evaluatePolicyAction(block({ method: 'delete_file' }), op({ method: 'delete_file' }))).toBe('block');
  });

  it('ignores an unparseable pattern instead of throwing', () => {
    expect(evaluatePolicyAction(block({ method: '/[unclosed/i' }), op())).toBeNull();
    expect(evaluatePolicyAction(block({ method: '/delete/zzz' }), op())).toBeNull();
  });

  it('scores through the same path', () => {
    const policy: AgentsGatePolicy = { rules: [{ id: 'S', match: { method: '/delete/i' }, score: 0.9 }] };
    expect(evaluatePolicyScore(policy, op({ method: 'delete_file' }))).toBe(0.9);
  });
});

describe('built-in presets actually fire', () => {
  it('strict blocks a delete and holds a write for approval', () => {
    const strict = getPreset('strict')!;
    expect(evaluatePolicyAction(strict, op({ method: 'delete_file' }))).toBe('block');
    expect(evaluatePolicyAction(strict, op({ method: 'write_file' }))).toBe('require_approval');
    expect(evaluatePolicyAction(strict, op({ tool: 'shell', method: 'run' }))).toBe('require_approval');
  });

  it('readonly blocks writes, deletes and shell', () => {
    const readonly = getPreset('readonly')!;
    expect(evaluatePolicyAction(readonly, op({ method: 'write_file' }))).toBe('block');
    expect(evaluatePolicyAction(readonly, op({ method: 'delete_file' }))).toBe('block');
    expect(evaluatePolicyAction(readonly, op({ tool: 'bash', method: 'exec' }))).toBe('block');
  });

  it('readonly leaves reads alone', () => {
    const readonly = getPreset('readonly')!;
    expect(evaluatePolicyAction(readonly, op({ method: 'read_file' }))).toBeNull();
  });

  it('permissive blocks only the irreversible operations', () => {
    const permissive = getPreset('permissive')!;
    expect(evaluatePolicyAction(permissive, op({ tool: 'database', method: 'drop_table' }))).toBe('block');
    expect(evaluatePolicyAction(permissive, op({ tool: 'database', method: 'delete_row' }))).toBe('require_approval');
    expect(evaluatePolicyAction(permissive, op({ method: 'write_file' }))).toBeNull();
  });
});

describe('the ReDoS guard still applies to a flagged pattern', () => {
  it('refuses a nested quantifier rather than hanging', () => {
    const policy = block({ method: '/(a+)+$/i' });
    expect(evaluatePolicyAction(policy, op({ method: 'a'.repeat(60) + 'b' }))).toBeNull();
  });
});

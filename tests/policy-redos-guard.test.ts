/**
 * Regression tests for the policy ReDoS guard (2026-07 security review).
 */

import { describe, it, expect } from 'vitest';
import { isLikelyCatastrophicRegex, matchRule } from '../src/policy.js';
import type { PolicyRule, MCPOperation } from '../src/types/interfaces.js';

const makeOp = (over: Partial<MCPOperation> = {}): MCPOperation => ({
  id: 'op', agentId: 'a', tool: 't', method: 'm',
  params: {}, timestamp: new Date(), sessionId: 's', ...over,
});

describe('isLikelyCatastrophicRegex', () => {
  it('flags nested quantifiers', () => {
    expect(isLikelyCatastrophicRegex('(a+)+')).toBe(true);
    expect(isLikelyCatastrophicRegex('(a*)*')).toBe(true);
    expect(isLikelyCatastrophicRegex('(.+)+$')).toBe(true);
  });

  it('does not flag ordinary policy patterns', () => {
    expect(isLikelyCatastrophicRegex('file|fs')).toBe(false);
    expect(isLikelyCatastrophicRegex('DELETE|REMOVE')).toBe(false);
    expect(isLikelyCatastrophicRegex('\\.env')).toBe(false);
    expect(isLikelyCatastrophicRegex('secrets')).toBe(false);
  });
});

describe('matchRule refuses catastrophic patterns without hanging', () => {
  it('a catastrophic pathPattern returns quickly (no match) instead of hanging', () => {
    const rule: PolicyRule = { id: 'R', match: { pathPattern: '(a+)+$' } };
    const evilInput = 'a'.repeat(60) + '!';
    const start = Date.now();
    const result = matchRule(rule, makeOp({ params: { path: evilInput } }));
    expect(Date.now() - start).toBeLessThan(500); // would be seconds if executed
    expect(result).toBe(false); // refused pattern → no match
  });

  it('a catastrophic /regex/ tool pattern is refused', () => {
    const rule: PolicyRule = { id: 'R', match: { tool: '/(a+)+$/' } };
    const start = Date.now();
    matchRule(rule, makeOp({ tool: 'a'.repeat(60) + '!' }));
    expect(Date.now() - start).toBeLessThan(500);
  });
});

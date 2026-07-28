/**
 * T211 — Policy rule priority field in policy list output.
 *
 * Tests cover:
 *   - Priority-ordered rule evaluation (lower number wins)
 *   - Declaration order preserved when priorities are equal (stable sort)
 *   - Rules with no explicit priority treated as default 100
 *   - `tags` field in PolicyRuleMatch filters operations correctly
 *   - Mixed priority / no-priority rules resolve in expected order
 */
import { describe, it, expect } from 'vitest';
import {
  evaluatePolicyScore,
  evaluatePolicyAction,
  matchRule,
} from '../src/policy.js';
import type { AgentsGatePolicy, PolicyRule } from '../src/policy.js';
import type { MCPOperation } from '../src/types/interfaces.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOp(overrides: Partial<MCPOperation> = {}): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId: 'agent-1',
    tool: 'filesystem',
    method: 'write_file',
    params: {},
    timestamp: new Date(),
    sessionId: 'sess-1',
    ...overrides,
  };
}

// ── Priority ordering — evaluatePolicyScore ───────────────────────────────────

describe('Policy rule priority — evaluatePolicyScore', () => {
  it('lower priority rule wins over higher priority rule (even if declared later)', () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'RULE_LOW_PRIO',  match: { tool: 'filesystem' }, score: 0.8, priority: 200 },
        { id: 'RULE_HIGH_PRIO', match: { tool: 'filesystem' }, score: 0.1, priority: 10 },
      ],
    };

    const score = evaluatePolicyScore(policy, makeOp('filesystem' as any));
    expect(score).toBe(0.1); // RULE_HIGH_PRIO (priority 10) evaluated first
  });

  it('maintains declaration order for equal priority (stable sort)', () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'FIRST',  match: { tool: 'filesystem' }, score: 0.9, priority: 50 },
        { id: 'SECOND', match: { tool: 'filesystem' }, score: 0.2, priority: 50 },
      ],
    };

    const score = evaluatePolicyScore(policy, makeOp());
    expect(score).toBe(0.9); // FIRST declared earlier, same priority → wins
  });

  it('uses default priority 100 for rules without explicit priority', () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'NO_PRIO',       match: { tool: 'filesystem' }, score: 0.5 },            // implicit 100
        { id: 'EXPLICIT_PRIO', match: { tool: 'filesystem' }, score: 0.2, priority: 50 },
      ],
    };

    // EXPLICIT_PRIO (50) < NO_PRIO (100) → EXPLICIT_PRIO wins
    const score = evaluatePolicyScore(policy, makeOp());
    expect(score).toBe(0.2);
  });

  it('does not affect rules that do not match the operation', () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'SHELL_BLOCK', match: { tool: 'shell' }, score: 1.0, priority: 1 },
        { id: 'FS_LOW',      match: { tool: 'filesystem' }, score: 0.2, priority: 100 },
      ],
    };

    const score = evaluatePolicyScore(policy, makeOp());
    expect(score).toBe(0.2); // SHELL_BLOCK (priority 1) doesn't match → FS_LOW fires
  });

  it('evaluates in declaration order when no rules have explicit priority', () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'ALPHA', match: { tool: 'filesystem' }, score: 0.3 },
        { id: 'BETA',  match: { tool: 'filesystem' }, score: 0.7 },
      ],
    };

    // Both have implicit priority 100; ALPHA declared first → wins
    const score = evaluatePolicyScore(policy, makeOp());
    expect(score).toBe(0.3);
  });
});

// ── Priority ordering — evaluatePolicyAction ──────────────────────────────────

describe('Policy rule priority — evaluatePolicyAction', () => {
  it('lower priority action rule wins over higher priority', () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'ALLOW_LOW_PRIO',  match: { tool: 'filesystem' }, action: 'allow',  priority: 200 },
        { id: 'BLOCK_HIGH_PRIO', match: { tool: 'filesystem' }, action: 'block',  priority: 5   },
      ],
    };

    const action = evaluatePolicyAction(policy, makeOp());
    expect(action).toBe('block'); // BLOCK_HIGH_PRIO (priority 5) wins
  });

  it('emergency block at priority 1 overrides allow at priority 50', () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'GENERAL_ALLOW',  match: { tool: 'filesystem' },                          action: 'allow', priority: 50 },
        { id: 'EMERGENCY_BLOCK', match: { tool: 'filesystem', method: 'delete_file' }, action: 'block', priority: 1  },
      ],
    };

    // delete_file → emergency block fires first
    expect(evaluatePolicyAction(policy, makeOp({ method: 'delete_file' }))).toBe('block');

    // write_file → emergency block does not match; general allow fires
    expect(evaluatePolicyAction(policy, makeOp({ method: 'write_file' }))).toBe('allow');
  });

  it('require_approval fires before block when given lower priority number', () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'HARD_BLOCK',    match: { tool: 'filesystem' }, action: 'block',            priority: 10 },
        { id: 'SOFT_APPROVAL', match: { tool: 'filesystem' }, action: 'require_approval', priority: 5  },
      ],
    };

    const action = evaluatePolicyAction(policy, makeOp());
    expect(action).toBe('require_approval'); // priority 5 < 10 → wins
  });
});

// ── tags field in PolicyRuleMatch ─────────────────────────────────────────────

describe('matchRule — tags field', () => {
  it('matches when operation has ALL required tags', () => {
    const rule: PolicyRule = {
      id: 'TAG_RULE',
      match: { tags: ['sensitive', 'prod'] },
    };
    const op = makeOp({ tags: ['sensitive', 'prod', 'extra'] });
    expect(matchRule(rule, op)).toBe(true);
  });

  it('does not match when operation is missing one required tag', () => {
    const rule: PolicyRule = {
      id: 'TAG_RULE',
      match: { tags: ['sensitive', 'prod'] },
    };
    const op = makeOp({ tags: ['sensitive'] }); // 'prod' absent
    expect(matchRule(rule, op)).toBe(false);
  });

  it('does not match when operation has no tags at all', () => {
    const rule: PolicyRule = {
      id: 'TAG_RULE',
      match: { tags: ['sensitive'] },
    };
    const op = makeOp(); // tags undefined
    expect(matchRule(rule, op)).toBe(false);
  });

  it('matches when rule has empty tags array (no constraint)', () => {
    const rule: PolicyRule = {
      id: 'NO_TAG_CONSTRAINT',
      match: { tags: [] },
    };
    const op = makeOp(); // no tags on operation
    expect(matchRule(rule, op)).toBe(true);
  });

  it('tags combined with other match fields use AND logic', () => {
    const rule: PolicyRule = {
      id: 'COMBINED',
      match: { tool: 'filesystem', tags: ['sensitive'] },
    };

    // Correct tool + correct tag → match
    expect(matchRule(rule, makeOp({ tool: 'filesystem', tags: ['sensitive'] }))).toBe(true);

    // Wrong tool → no match even with correct tag
    expect(matchRule(rule, makeOp({ tool: 'database', tags: ['sensitive'] }))).toBe(false);

    // Correct tool but missing tag → no match
    expect(matchRule(rule, makeOp({ tool: 'filesystem', tags: [] }))).toBe(false);
  });

  it('tags filter routes priority-ordered rules correctly', () => {
    // Two rules for filesystem, but one also requires a tag.
    // The tag-required rule has LOWER priority number (wins first), but only
    // if the operation actually carries the tag.
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'SENSITIVE_BLOCK', match: { tool: 'filesystem', tags: ['sensitive'] }, action: 'block',  priority: 1   },
        { id: 'GENERAL_ALLOW',  match: { tool: 'filesystem' },                       action: 'allow',  priority: 100 },
      ],
    };

    // With the sensitive tag → SENSITIVE_BLOCK (priority 1) fires
    const withTag = evaluatePolicyAction(policy, makeOp({ tags: ['sensitive'] }));
    expect(withTag).toBe('block');

    // Without the tag → SENSITIVE_BLOCK doesn't match; GENERAL_ALLOW fires
    const withoutTag = evaluatePolicyAction(policy, makeOp({ tags: [] }));
    expect(withoutTag).toBe('allow');
  });
});

// ── Default priority semantics (priority display logic via evaluation) ─────────

describe('Default priority value (100) semantics', () => {
  it('rule without priority behaves identically to rule with explicit priority 100', () => {
    const policyImplicit: AgentsGatePolicy = {
      rules: [
        { id: 'IMPLICIT', match: { tool: 'filesystem' }, score: 0.6 },
      ],
    };
    const policyExplicit: AgentsGatePolicy = {
      rules: [
        { id: 'EXPLICIT', match: { tool: 'filesystem' }, score: 0.6, priority: 100 },
      ],
    };

    const op = makeOp();
    expect(evaluatePolicyScore(policyImplicit, op)).toBe(evaluatePolicyScore(policyExplicit, op));
  });

  it('priority 99 fires before implicit-default (100) even when declared after', () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'DEFAULT',  match: { tool: 'filesystem' }, action: 'allow'            }, // implicit 100
        { id: 'NEARDEFAULT', match: { tool: 'filesystem' }, action: 'block', priority: 99 },
      ],
    };

    const action = evaluatePolicyAction(policy, makeOp());
    expect(action).toBe('block'); // priority 99 < 100 → fires first even though declared second
  });

  it('priority 101 fires after implicit-default (100) when declared first', () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'ABOVE_DEFAULT', match: { tool: 'filesystem' }, action: 'block', priority: 101 },
        { id: 'DEFAULT',       match: { tool: 'filesystem' }, action: 'allow'                  },
      ],
    };

    // ABOVE_DEFAULT has priority 101, DEFAULT has implicit priority 100
    // 100 < 101 → DEFAULT wins despite being declared second
    const action = evaluatePolicyAction(policy, makeOp());
    expect(action).toBe('allow');
  });
});

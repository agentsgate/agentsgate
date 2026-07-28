/**
 * T193 — Operation tags field.
 * Tests tags on MCPOperation, OperationFilter.tags (ALL-match), and PolicyRuleMatch.tags.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { StateStore } from '../src/modules/m2-store/index.js';
import { OperationLogger } from '../src/modules/m3-logger/index.js';
import { matchRule, evaluatePolicyAction } from '../src/policy.js';
import type { MCPOperation } from '../src/types/interfaces.js';
import type { PolicyRule, AgentsGatePolicy } from '../src/policy.js';

function makeOp(overrides: Partial<MCPOperation> = {}): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId: 'test-agent',
    tool: 'filesystem',
    method: 'read_file',
    params: {},
    timestamp: new Date(),
    sessionId: 'sess-1',
    ...overrides,
  };
}

describe('Operation tags — MCPOperation field', () => {
  it('tags field is optional and defaults to undefined', () => {
    const op = makeOp();
    expect(op.tags).toBeUndefined();
  });

  it('tags can be set and retrieved', () => {
    const op = makeOp({ tags: ['pci-scope', 'high-value'] });
    expect(op.tags).toEqual(['pci-scope', 'high-value']);
  });
});

describe('OperationFilter.tags — ALL-match semantics', () => {
  let store: StateStore;
  let logger: OperationLogger;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-tags-'));
    store = new StateStore(path.join(tmpDir, 'test.db'));
    await store.initialize();
    logger = new OperationLogger(store);
  });

  afterEach(async () => {
    await store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function logOp(tags?: string[]) {
    const op = makeOp({ tags });
    await logger.log(op, { action: 'allow', riskScore: 0.1, reasons: [] });
    return op;
  }

  it('returns ops with all requested tags (single tag)', async () => {
    await logOp(['pci-scope']);
    await logOp(['other']);
    await logOp();
    const results = await store.listOperationLogs(100, 0, { tags: ['pci-scope'] });
    expect(results).toHaveLength(1);
    expect(results[0].operation.tags).toContain('pci-scope');
  });

  it('returns ops that have ALL tags when multiple requested', async () => {
    await logOp(['pci-scope', 'high-value']);
    await logOp(['pci-scope']);
    await logOp(['high-value']);
    const results = await store.listOperationLogs(100, 0, { tags: ['pci-scope', 'high-value'] });
    expect(results).toHaveLength(1);
    expect(results[0].operation.tags).toEqual(expect.arrayContaining(['pci-scope', 'high-value']));
  });

  it('returns empty when no ops match all tags', async () => {
    await logOp(['pci-scope']);
    await logOp(['high-value']);
    const results = await store.listOperationLogs(100, 0, { tags: ['pci-scope', 'high-value'] });
    expect(results).toHaveLength(0);
  });

  it('no tag filter returns all ops', async () => {
    await logOp(['pci-scope']);
    await logOp();
    const results = await store.listOperationLogs(100, 0);
    expect(results).toHaveLength(2);
  });
});

describe('PolicyRuleMatch.tags — rule fires only when all tags present', () => {
  const rule: PolicyRule = {
    id: 'TAG_RULE',
    match: { tags: ['pci-scope', 'prod'] },
    action: 'block',
  };

  it('rule matches when op has all required tags', () => {
    const op = makeOp({ tags: ['pci-scope', 'prod', 'extra'] });
    expect(matchRule(rule, op)).toBe(true);
  });

  it('rule does not match when op is missing one tag', () => {
    const op = makeOp({ tags: ['pci-scope'] });
    expect(matchRule(rule, op)).toBe(false);
  });

  it('rule does not match when op has no tags', () => {
    const op = makeOp();
    expect(matchRule(rule, op)).toBe(false);
  });

  it('evaluatePolicyAction returns block for tagged op matching rule', () => {
    const policy: AgentsGatePolicy = { rules: [rule] };
    const op = makeOp({ tags: ['pci-scope', 'prod'] });
    expect(evaluatePolicyAction(policy, op)).toBe('block');
  });

  it('evaluatePolicyAction returns null when tags do not match', () => {
    const policy: AgentsGatePolicy = { rules: [rule] };
    const op = makeOp({ tags: ['pci-scope'] });
    expect(evaluatePolicyAction(policy, op)).toBeNull();
  });
});

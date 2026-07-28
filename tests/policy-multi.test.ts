/**
 * T160 — Multi-policy support: mergePolicies() and loadPolicies().
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergePolicies, loadPolicies, evaluatePolicyScore, evaluatePolicyAction } from '../src/policy.js';
import type { AgentsGatePolicy, MCPOperation } from '../src/index.js';

function makeOp(tool: string, method = 'write_file'): MCPOperation {
  return {
    id: 'op-1', agentId: 'agent-1', tool, method,
    params: {}, timestamp: new Date(), sessionId: 'sess-1',
  };
}

describe('mergePolicies', () => {
  it('merges rules from multiple policies in order', () => {
    const p1: AgentsGatePolicy = {
      rules: [{ id: 'RULE_A', match: { tool: 'shell' }, score: 0.9 }],
    };
    const p2: AgentsGatePolicy = {
      rules: [{ id: 'RULE_B', match: { tool: 'filesystem' }, action: 'block' }],
    };

    const merged = mergePolicies([p1, p2]);
    expect(merged.rules).toHaveLength(2);
    expect(merged.rules[0].id).toBe('RULE_A');
    expect(merged.rules[1].id).toBe('RULE_B');
  });

  it('later policy thresholds override earlier ones', () => {
    const p1: AgentsGatePolicy = {
      rules: [],
      thresholds: { allowBelow: 0.2, blockAtOrAbove: 0.6 },
    };
    const p2: AgentsGatePolicy = {
      rules: [],
      thresholds: { blockAtOrAbove: 0.8 },
    };

    const merged = mergePolicies([p1, p2]);
    expect(merged.thresholds?.allowBelow).toBe(0.2);    // from p1
    expect(merged.thresholds?.blockAtOrAbove).toBe(0.8); // overridden by p2
  });

  it('accumulates agent denylists from all policies', () => {
    const p1: AgentsGatePolicy = {
      rules: [],
      agents: { denylist: ['bad-agent-1'] },
    };
    const p2: AgentsGatePolicy = {
      rules: [],
      agents: { denylist: ['bad-agent-2'] },
    };

    const merged = mergePolicies([p1, p2]);
    expect(merged.agents?.denylist).toContain('bad-agent-1');
    expect(merged.agents?.denylist).toContain('bad-agent-2');
  });

  it('later toolRules override earlier for same agent pattern', () => {
    const p1: AgentsGatePolicy = {
      rules: [],
      agents: { toolRules: { 'agent-x': { denylist: ['shell'] } } },
    };
    const p2: AgentsGatePolicy = {
      rules: [],
      agents: { toolRules: { 'agent-x': { denylist: ['shell', 'database'] } } },
    };

    const merged = mergePolicies([p1, p2]);
    expect(merged.agents?.toolRules?.['agent-x'].denylist).toContain('database');
  });

  it('returns empty policy for empty array', () => {
    const merged = mergePolicies([]);
    expect(merged.rules).toHaveLength(0);
    expect(merged.thresholds).toBeUndefined();
  });

  it('merged policy works correctly with evaluatePolicyScore', () => {
    const p1: AgentsGatePolicy = {
      rules: [{ id: 'LOW_FS', match: { tool: 'filesystem' }, score: 0.1, priority: 200 }],
    };
    const p2: AgentsGatePolicy = {
      rules: [{ id: 'HIGH_FS', match: { tool: 'filesystem' }, score: 0.9, priority: 1 }],
    };

    const merged = mergePolicies([p1, p2]);
    const score = evaluatePolicyScore(merged, makeOp('filesystem'));
    expect(score).toBe(0.9); // HIGH_FS has priority 1, wins
  });
});

describe('loadPolicies', () => {
  it('loads and merges two policy files from disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-mpol-'));
    try {
      const pol1: AgentsGatePolicy = {
        rules: [{ id: 'FILE_A', match: { tool: 'shell' }, action: 'block' }],
      };
      const pol2: AgentsGatePolicy = {
        rules: [{ id: 'FILE_B', match: { tool: 'database' }, score: 0.8 }],
        thresholds: { blockAtOrAbove: 0.9 },
      };

      const f1 = path.join(dir, '01-base.json');
      const f2 = path.join(dir, '02-team.json');
      await fs.writeFile(f1, JSON.stringify(pol1));
      await fs.writeFile(f2, JSON.stringify(pol2));

      const merged = await loadPolicies([f1, f2]);
      expect(merged.rules).toHaveLength(2);
      expect(merged.rules.map(r => r.id)).toContain('FILE_A');
      expect(merged.rules.map(r => r.id)).toContain('FILE_B');
      expect(merged.thresholds?.blockAtOrAbove).toBe(0.9);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('sorts paths alphabetically before loading', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-mpol-sort-'));
    try {
      // Pass in reverse order — should still load 01 first
      const f1 = path.join(dir, '01-first.json');
      const f2 = path.join(dir, '02-second.json');
      await fs.writeFile(f1, JSON.stringify({ rules: [{ id: 'FIRST', match: { tool: 'shell' }, score: 0.3 }] }));
      await fs.writeFile(f2, JSON.stringify({ rules: [{ id: 'SECOND', match: { tool: 'shell' }, score: 0.9 }] }));

      const merged = await loadPolicies([f2, f1]); // reversed input order
      expect(merged.rules[0].id).toBe('FIRST');   // 01 sorts before 02
      expect(merged.rules[1].id).toBe('SECOND');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('skips non-existent files silently', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-mpol-miss-'));
    try {
      const f1 = path.join(dir, 'exists.json');
      await fs.writeFile(f1, JSON.stringify({ rules: [{ id: 'EXISTS', match: { tool: 'shell' }, score: 0.5 }] }));
      const merged = await loadPolicies([f1, path.join(dir, 'missing.json')]);
      expect(merged.rules).toHaveLength(1);
      expect(merged.rules[0].id).toBe('EXISTS');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

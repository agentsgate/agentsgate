/**
 * Tests for policy CLI helpers — matchRule and friends are tested in policy.test.ts.
 * Here we test the policy CRUD operations: loadPolicy + savePolicy round-trips
 * that would be exercised by the CLI add/remove/set-threshold commands.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadPolicy, savePolicy, type AgentsGatePolicy } from '../src/policy.js';

async function withTmpPolicy(fn: (filePath: string) => Promise<void>): Promise<void> {
  const filePath = path.join(os.tmpdir(), `as-policy-cli-${Date.now()}.json`);
  try {
    await fn(filePath);
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
}

describe('policy CLI operations (CRUD via loadPolicy + savePolicy)', () => {
  it('add a rule to an empty policy', async () => {
    await withTmpPolicy(async (fp) => {
      let policy = await loadPolicy(fp);
      policy.rules.push({ id: 'BLOCK_DB', match: { tool: 'database' }, action: 'block' });
      await savePolicy(policy, fp);

      const loaded = await loadPolicy(fp);
      expect(loaded.rules).toHaveLength(1);
      expect(loaded.rules[0].id).toBe('BLOCK_DB');
      expect(loaded.rules[0].action).toBe('block');
    });
  });

  it('remove a rule by id', async () => {
    await withTmpPolicy(async (fp) => {
      const initial: AgentsGatePolicy = {
        rules: [
          { id: 'RULE_A', match: { tool: 'filesystem' }, score: 0.9 },
          { id: 'RULE_B', match: { agentId: 'trusted' }, score: 0.05 },
        ],
      };
      await savePolicy(initial, fp);

      let policy = await loadPolicy(fp);
      policy.rules = policy.rules.filter(r => r.id !== 'RULE_A');
      await savePolicy(policy, fp);

      const loaded = await loadPolicy(fp);
      expect(loaded.rules).toHaveLength(1);
      expect(loaded.rules[0].id).toBe('RULE_B');
    });
  });

  it('set-threshold updates thresholds without touching rules', async () => {
    await withTmpPolicy(async (fp) => {
      const initial: AgentsGatePolicy = {
        rules: [{ id: 'EXISTING', match: {}, score: 0.5 }],
      };
      await savePolicy(initial, fp);

      let policy = await loadPolicy(fp);
      policy.thresholds = { ...(policy.thresholds ?? {}), blockAtOrAbove: 0.9 };
      await savePolicy(policy, fp);

      const loaded = await loadPolicy(fp);
      expect(loaded.thresholds?.blockAtOrAbove).toBe(0.9);
      expect(loaded.rules).toHaveLength(1); // rules unchanged
    });
  });

  it('adding a rule preserves existing rules and thresholds', async () => {
    await withTmpPolicy(async (fp) => {
      const initial: AgentsGatePolicy = {
        rules: [{ id: 'FIRST', match: { tool: 'git' }, action: 'require_approval' }],
        thresholds: { allowBelow: 0.15 },
      };
      await savePolicy(initial, fp);

      let policy = await loadPolicy(fp);
      policy.rules.push({ id: 'SECOND', match: { pathPattern: 'production' }, action: 'block' });
      await savePolicy(policy, fp);

      const loaded = await loadPolicy(fp);
      expect(loaded.rules).toHaveLength(2);
      expect(loaded.rules[0].id).toBe('FIRST');
      expect(loaded.rules[1].id).toBe('SECOND');
      expect(loaded.thresholds?.allowBelow).toBe(0.15);
    });
  });

  it('duplicate rule id is detected before save', async () => {
    await withTmpPolicy(async (fp) => {
      const policy: AgentsGatePolicy = {
        rules: [{ id: 'DUPE', match: {}, action: 'block' }],
      };
      await savePolicy(policy, fp);
      const loaded = await loadPolicy(fp);
      const alreadyExists = loaded.rules.some(r => r.id === 'DUPE');
      expect(alreadyExists).toBe(true);
    });
  });
});

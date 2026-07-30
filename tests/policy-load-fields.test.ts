/**
 * `loadPolicy` must return every field the policy file declares.
 *
 * It used to rebuild the object from three named keys — rules, thresholds,
 * agents — so `mutedRules` and `ruleOverrides` were dropped on the floor. Both
 * are documented, and the proxy reads them off the active policy
 * (`src/modules/m1-proxy/index.ts`), but nothing could ever set them from the
 * file: muting a noisy L1 rule or re-scoring one silently did nothing.
 *
 * `mergePolicies` has always handled both fields, which hid the gap — it merges
 * policies that `loadPolicy` had already stripped.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadPolicy, loadPolicies, savePolicy } from '../src/policy.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-policy-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(name: string, policy: unknown): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(policy, null, 2));
  return file;
}

describe('loadPolicy', () => {
  it('keeps mutedRules', async () => {
    const file = await write('policy.json', {
      rules: [],
      mutedRules: ['L1_SENSITIVE_FILE_TYPE', 'L1_LARGE_WRITE'],
    });
    const policy = await loadPolicy(file);
    expect(policy.mutedRules).toEqual(['L1_SENSITIVE_FILE_TYPE', 'L1_LARGE_WRITE']);
  });

  it('keeps ruleOverrides', async () => {
    const file = await write('policy.json', {
      rules: [],
      ruleOverrides: { L1_DELETE_FILE: 0.5, L1_EXEC_COMMAND: 0.9 },
    });
    const policy = await loadPolicy(file);
    expect(policy.ruleOverrides).toEqual({ L1_DELETE_FILE: 0.5, L1_EXEC_COMMAND: 0.9 });
  });

  it('keeps every field at once, alongside rules, thresholds and agents', async () => {
    const file = await write('policy.json', {
      rules: [{ id: 'R', match: { tool: 'filesystem' }, score: 0.9 }],
      thresholds: { allowBelow: 0.2, blockAtOrAbove: 0.8 },
      agents: { denylist: ['bad-agent'] },
      mutedRules: ['L1_OVERWRITE_FILE'],
      ruleOverrides: { L1_DELETE_FILE: 0.5 },
    });
    const policy = await loadPolicy(file);
    expect(policy.rules).toHaveLength(1);
    expect(policy.thresholds).toEqual({ allowBelow: 0.2, blockAtOrAbove: 0.8 });
    expect(policy.agents?.denylist).toEqual(['bad-agent']);
    expect(policy.mutedRules).toEqual(['L1_OVERWRITE_FILE']);
    expect(policy.ruleOverrides).toEqual({ L1_DELETE_FILE: 0.5 });
  });

  it('leaves absent fields undefined rather than inventing empties', async () => {
    const file = await write('policy.json', { rules: [] });
    const policy = await loadPolicy(file);
    expect(policy.mutedRules).toBeUndefined();
    expect(policy.ruleOverrides).toBeUndefined();
  });

  it('still returns an empty policy when the file does not exist', async () => {
    const policy = await loadPolicy(path.join(dir, 'nope.json'));
    expect(policy).toEqual({ rules: [] });
  });

  it('survives a save/load round trip', async () => {
    const file = path.join(dir, 'rt.json');
    await savePolicy(
      { rules: [], mutedRules: ['L1_LARGE_WRITE'], ruleOverrides: { L1_DELETE_FILE: 0.4 } },
      file
    );
    const policy = await loadPolicy(file);
    expect(policy.mutedRules).toEqual(['L1_LARGE_WRITE']);
    expect(policy.ruleOverrides).toEqual({ L1_DELETE_FILE: 0.4 });
  });
});

describe('loadPolicies', () => {
  it('merges mutedRules and ruleOverrides across files', async () => {
    // mergePolicies concatenates mutedRules and last-wins for ruleOverrides;
    // that logic was unreachable while loadPolicy stripped both fields.
    const a = await write('00-base.json', {
      rules: [],
      mutedRules: ['L1_LARGE_WRITE'],
      ruleOverrides: { L1_DELETE_FILE: 0.4 },
    });
    const b = await write('10-team.json', {
      rules: [],
      mutedRules: ['L1_SENSITIVE_FILE_TYPE'],
      ruleOverrides: { L1_DELETE_FILE: 0.6, L1_EXEC_COMMAND: 0.9 },
    });
    const policy = await loadPolicies([b, a]);   // sorted internally, so 00 then 10
    expect(policy.mutedRules).toEqual(['L1_LARGE_WRITE', 'L1_SENSITIVE_FILE_TYPE']);
    expect(policy.ruleOverrides).toEqual({ L1_DELETE_FILE: 0.6, L1_EXEC_COMMAND: 0.9 });
  });
});

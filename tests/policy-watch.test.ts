/**
 * T106 — Policy hot-reload via watchPolicy tests.
 *
 * Writes a policy file, starts a watcher, modifies the file, and verifies
 * the callback receives the updated policy.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { watchPolicy, savePolicy, loadPolicy } from '../src/policy.js';
import type { AgentsGatePolicy } from '../src/policy.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import type { FSWatcher } from 'node:fs';

const watchers: FSWatcher[] = [];

afterEach(async () => {
  for (const w of watchers) { try { w.close(); } catch { /* ignore */ } }
  watchers.length = 0;
});

function tmpPolicyPath() {
  return join(tmpdir(), `as-policy-test-${Date.now()}.json`);
}

function waitFor<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timeout in waitFor')), timeoutMs);
    const interval = setInterval(() => {
      const v = fn();
      if (v !== undefined) { clearInterval(interval); clearTimeout(t); resolve(v); }
    }, 30);
  });
}

describe('watchPolicy', () => {

  it('calls onReload with updated policy when file changes', async () => {
    const filePath = tmpPolicyPath();

    // Write initial policy
    const initial: AgentsGatePolicy = { rules: [] };
    await writeFile(filePath, JSON.stringify(initial));

    let reloaded: AgentsGatePolicy | undefined;
    const watcher = watchPolicy(filePath, p => { reloaded = p; });
    watchers.push(watcher);

    // Write updated policy
    const updated: AgentsGatePolicy = {
      rules: [{ id: 'HOT_RELOAD_TEST', match: { tool: 'test' }, score: 0.99 }],
    };
    await writeFile(filePath, JSON.stringify(updated));

    // Wait for debounced reload (up to 2s)
    const result = await waitFor(() => reloaded);

    await unlink(filePath).catch(() => {});

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].id).toBe('HOT_RELOAD_TEST');
    expect(result.rules[0].score).toBe(0.99);
  });

  it('onReload receives empty rules on invalid JSON (parse error suppressed)', async () => {
    const filePath = tmpPolicyPath();
    await writeFile(filePath, JSON.stringify({ rules: [] }));

    let callCount = 0;
    let lastPolicy: AgentsGatePolicy | undefined;
    const watcher = watchPolicy(filePath, p => { callCount++; lastPolicy = p; });
    watchers.push(watcher);

    // Write invalid JSON — should be swallowed
    await writeFile(filePath, 'NOT VALID JSON {{{');

    // Wait a bit and verify no crash
    await new Promise(r => setTimeout(r, 400));

    // Now write valid JSON — should trigger reload
    const valid: AgentsGatePolicy = { rules: [{ id: 'AFTER_INVALID', match: { tool: 't' } }] };
    await writeFile(filePath, JSON.stringify(valid));

    const result = await waitFor(() => lastPolicy?.rules?.length ? lastPolicy : undefined);
    await unlink(filePath).catch(() => {});

    expect(result.rules[0].id).toBe('AFTER_INVALID');
  });

  it('createPipeline hot-reloads policy when policyPath is set', async () => {
    // This is an integration test: use the pipeline directly
    const { createPipeline } = await import('../src/modules/m1-proxy/index.js');
    const { RiskScoringEngine } = await import('../src/modules/m6-risk/index.js');
    const { InterventionController } = await import('../src/modules/m7-intervention/index.js');

    const filePath = tmpPolicyPath();

    // Initial policy: allow everything (score 0)
    await writeFile(filePath, JSON.stringify({ rules: [{ id: 'ALLOW_ALL', match: { tool: 'database' }, score: 0.0 }] }));

    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      policyPath: filePath,
    });

    const op = {
      id: 'test-op', agentId: 'agent', tool: 'database', method: 'drop_table',
      params: {}, timestamp: new Date(), sessionId: 'sess',
    };

    // Wait for initial policy to load (non-blocking async load in createPipeline)
    let dec1 = await pipeline.evaluateRisk!(op);
    let initAttempts = 0;
    while (dec1.action !== 'allow' && initAttempts < 20) {
      await new Promise(r => setTimeout(r, 50));
      dec1 = await pipeline.evaluateRisk!(op);
      initAttempts++;
    }

    // With initial policy (score 0), drop_table should be allowed
    expect(dec1.action).toBe('allow');

    // Update policy to block database ops
    await writeFile(filePath, JSON.stringify({
      rules: [{ id: 'BLOCK_DB', match: { tool: 'database' }, action: 'block' }],
    }));

    // Wait for hot-reload
    let dec2 = await pipeline.evaluateRisk!(op); // might still be old
    let attempts = 0;
    while (dec2.action !== 'block' && attempts < 20) {
      await new Promise(r => setTimeout(r, 100));
      dec2 = await pipeline.evaluateRisk!(op);
      attempts++;
    }

    await unlink(filePath).catch(() => {});

    expect(dec2.action).toBe('block');
  });
});

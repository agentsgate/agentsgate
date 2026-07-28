/**
 * E2E tests for AgentsGate policy engine via MCPStdioProxy.
 *
 * Covers:
 *   - Score override rules (raise / lower L1 static scores)
 *   - Action force rules (bypass threshold decision)
 *   - Agent denylist / allowlist
 *   - Muted L1 rules (suppress false positives)
 *   - Rule score overrides (ruleOverrides map)
 *   - Dry-run mode (observe without blocking)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { McpClientHarness } from '../helpers/mcp-client-harness.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import { createPipeline } from '../../src/modules/m1-proxy/index.js';
import type { AgentsGatePolicy } from '../../src/policy.js';

let h: McpClientHarness;

afterEach(async () => { await h?.stop(); });

function makePipelineWithPolicy(policy: AgentsGatePolicy) {
  return createPipeline({
    riskEngine: new RiskScoringEngine(),
    interventionController: new InterventionController(),
    policy,
  });
}

// ── 1. Policy score override rules ───────────────────────────────────────────

describe('Policy score override rules', () => {

  it('score override allows a normally-blocked method (execute_command 0.8 → 0.1)', async () => {
    const policy: AgentsGatePolicy = {
      rules: [{
        id: 'TRUST_EXEC_FOR_TEST',
        match: { method: 'execute_command' },
        score: 0.1,
      }],
    };
    const pipeline = makePipelineWithPolicy(policy);
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    // execute_command normally scores 0.8 → block; policy drops to 0.1 → allow
    await h.request('tools/call', { name: 'execute_command', arguments: {} });
    expect(h.lastIntercept?.decision.action).toBe('allow');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.1, 5);
  });

  it('score override includes POLICY_SCORE_OVERRIDE in decision reasons', async () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'LOWER_EXEC', match: { method: 'execute_command' }, score: 0.1 }],
    };
    const pipeline = makePipelineWithPolicy(policy);
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.request('tools/call', { name: 'execute_command', arguments: {} });
    const reasons = h.lastIntercept?.decision.reasons ?? [];
    expect(reasons.some(r => r.includes('POLICY_SCORE_OVERRIDE'))).toBe(true);
  });

  it('score override raises echo (DEFAULT 0.2) into require_approval range', async () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'ELEVATE_ECHO', match: { method: 'echo' }, score: 0.5 }],
    };
    const pipeline = makePipelineWithPolicy(policy);
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    // score 0.5 → 0.3 ≤ 0.5 < 0.7 → require_approval; server still called
    const result = await h.callTool('echo', { message: 'elevated' });
    expect((result as { content: Array<{ text: string }> }).content[0]?.text).toBe('elevated');
    expect(h.lastIntercept?.decision.action).toBe('require_approval');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.5, 5);
  });

  it('score override rule is method-specific and does not affect other methods', async () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'LOWER_EXEC', match: { method: 'execute_command' }, score: 0.1 }],
    };
    const pipeline = makePipelineWithPolicy(policy);
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    // execute_command → allowed by policy
    await h.request('tools/call', { name: 'execute_command', arguments: {} });
    expect(h.intercepts[0]?.decision.action).toBe('allow');

    // drop_table → not covered by policy → L1_DROP_TABLE fires → 0.95 → block
    await h.request('tools/call', { name: 'drop_table', arguments: {} });
    expect(h.intercepts[1]?.decision.action).toBe('block');
    expect(h.intercepts[1]?.decision.riskScore).toBeCloseTo(0.95, 5);
  });

});

// ── 2. Policy action override rules ──────────────────────────────────────────

describe('Policy action override rules', () => {

  it('force-block overrides a low-risk allow for a specific method', async () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'FORCE_BLOCK_ECHO', match: { method: 'echo' }, action: 'block' }],
    };
    const pipeline = makePipelineWithPolicy(policy);
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    const resp = await h.request('tools/call', { name: 'echo', arguments: { message: 'blocked' } });
    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(h.lastIntercept?.decision.action).toBe('block');
    expect(h.lastIntercept?.decision.reasons.some(r => r.includes('Policy rule forced action: block'))).toBe(true);
  });

  it('force-allow overrides a high-risk block for a specific method', async () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'FORCE_ALLOW_EXEC', match: { method: 'execute_command' }, action: 'allow' }],
    };
    const pipeline = makePipelineWithPolicy(policy);
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    // execute_command scores 0.8 → would block; policy forces allow
    await h.request('tools/call', { name: 'execute_command', arguments: {} });
    expect(h.lastIntercept?.decision.action).toBe('allow');
    expect(h.lastIntercept?.decision.reasons.some(r => r.includes('Policy rule forced action: allow'))).toBe(true);
  });

  it('rule with matching agentId match forces action for that agent only', async () => {
    const policy: AgentsGatePolicy = {
      rules: [{
        id: 'BLOCK_UNTRUSTED',
        match: { agentId: 'untrusted-agent' },
        action: 'block',
      }],
    };
    const pipeline = makePipelineWithPolicy(policy);

    // untrusted-agent is force-blocked even for echo
    const hUntrusted = new McpClientHarness();
    await hUntrusted.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'untrusted-agent' });
    const blocked = await hUntrusted.request('tools/call', { name: 'echo', arguments: { message: 'x' } });
    expect(blocked.error?.message).toContain('AgentsGate blocked');
    await hUntrusted.stop();

    // trusted-agent is unaffected
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'trusted-agent' });
    const result = await h.callTool('echo', { message: 'trusted' });
    expect((result as { content: Array<{ text: string }> }).content[0]?.text).toBe('trusted');
  });

});

// ── 3. Agent denylist / allowlist ─────────────────────────────────────────────

describe('Policy agent denylist / allowlist', () => {

  it('denylisted agentId is blocked regardless of tool call risk', async () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { denylist: ['evil-agent'] },
    };
    const pipeline = makePipelineWithPolicy(policy);
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'evil-agent' });

    const resp = await h.request('tools/call', { name: 'echo', arguments: { message: 'x' } });
    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(h.lastIntercept?.decision.action).toBe('block');
  });

  it('non-denylisted agentId is not affected by the denylist', async () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { denylist: ['evil-agent'] },
    };
    const pipeline = makePipelineWithPolicy(policy);
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'good-agent' });

    const result = await h.callTool('echo', { message: 'good' });
    expect((result as { content: Array<{ text: string }> }).content[0]?.text).toBe('good');
    expect(h.lastIntercept?.decision.action).toBe('allow');
  });

  it('agent not on allowlist is blocked when allowlist is non-empty', async () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { allowlist: ['trusted-agent'] },
    };
    const pipeline = makePipelineWithPolicy(policy);
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'unknown-agent' });

    const resp = await h.request('tools/call', { name: 'echo', arguments: { message: 'x' } });
    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(h.lastIntercept?.decision.action).toBe('block');
  });

  it('allowlisted agent passes through normally', async () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { allowlist: ['trusted-agent'] },
    };
    const pipeline = makePipelineWithPolicy(policy);
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'trusted-agent' });

    const result = await h.callTool('echo', { message: 'trusted' });
    expect((result as { content: Array<{ text: string }> }).content[0]?.text).toBe('trusted');
    expect(h.lastIntercept?.decision.action).toBe('allow');
  });

  it('regex denylist pattern matches agentId', async () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      agents: { denylist: ['/^bot-/'] },
    };
    const pipeline = makePipelineWithPolicy(policy);
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'bot-crawler-42' });

    const resp = await h.request('tools/call', { name: 'echo', arguments: { message: 'x' } });
    expect(resp.error?.message).toContain('AgentsGate blocked');
  });

});

// ── 4. Muted L1 rules ────────────────────────────────────────────────────────

describe('Policy mutedRules', () => {

  it('muting L1_EXECUTE_COMMAND allows execute_command through', async () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      mutedRules: ['L1_EXECUTE_COMMAND'],
    };
    const pipeline = makePipelineWithPolicy(policy);
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    // L1_EXECUTE_COMMAND muted → no rules fire → score 0 → allow
    await h.request('tools/call', { name: 'execute_command', arguments: {} });
    expect(h.lastIntercept?.decision.action).toBe('allow');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0, 5);
  });

  it('muting one rule does not affect other L1 rules', async () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      mutedRules: ['L1_EXECUTE_COMMAND'],
    };
    const pipeline = makePipelineWithPolicy(policy);
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    // execute_command allowed (muted)
    await h.request('tools/call', { name: 'execute_command', arguments: {} });
    expect(h.intercepts[0]?.decision.action).toBe('allow');

    // drop_table NOT muted → L1_DROP_TABLE fires → 0.95 → block
    await h.request('tools/call', { name: 'drop_table', arguments: {} });
    expect(h.intercepts[1]?.decision.action).toBe('block');
    expect(h.intercepts[1]?.decision.riskScore).toBeCloseTo(0.95, 5);
  });

});

// ── 5. Rule score overrides (ruleOverrides map) ───────────────────────────────

describe('Policy ruleOverrides', () => {

  it('overriding L1_EXECUTE_COMMAND to 0.1 allows execute_command', async () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      ruleOverrides: { 'L1_EXECUTE_COMMAND': 0.1 },
    };
    const pipeline = makePipelineWithPolicy(policy);
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.request('tools/call', { name: 'execute_command', arguments: {} });
    expect(h.lastIntercept?.decision.action).toBe('allow');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.1, 5);
  });

  it('overriding L1_DROP_TABLE to 0.5 yields require_approval', async () => {
    const policy: AgentsGatePolicy = {
      rules: [],
      ruleOverrides: { 'L1_DROP_TABLE': 0.5 },
    };
    const pipeline = makePipelineWithPolicy(policy);
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    // 0.5 is in [0.3, 0.7) → require_approval; server is still called
    await h.request('tools/call', { name: 'drop_table', arguments: {} });
    expect(h.lastIntercept?.decision.action).toBe('require_approval');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.5, 5);
  });

});

// ── 6. Dry-run mode ───────────────────────────────────────────────────────────

describe('Dry-run mode', () => {

  it('would-be blocked operations are allowed in dry-run mode', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      dryRun: true,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    // execute_command would score 0.8 → block; in dry-run it's forwarded
    const resp = await h.request('tools/call', { name: 'execute_command', arguments: {} });
    // AgentsGate did NOT block (-32600); the server returned -32601 (unknown tool)
    expect(resp.error?.code).not.toBe(-32600);
    expect(h.lastIntercept?.decision.action).toBe('allow');
  });

  it('dry-run decision.reasons includes [DRY-RUN] marker', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      dryRun: true,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.request('tools/call', { name: 'execute_command', arguments: {} });
    const reasons = h.lastIntercept?.decision.reasons ?? [];
    expect(reasons.some(r => r.includes('[DRY-RUN]'))).toBe(true);
  });

  it('dry-run still records the real risk score (not zeroed out)', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      dryRun: true,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.request('tools/call', { name: 'execute_command', arguments: {} });
    // Risk score is still 0.8 (the real L1 score), not zeroed out
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.8, 5);
  });

  it('dry-run low-risk calls (echo) pass through unchanged', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      dryRun: true,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    const result = await h.callTool('echo', { message: 'dry-run-ok' });
    expect((result as { content: Array<{ text: string }> }).content[0]?.text).toBe('dry-run-ok');
    expect(h.lastIntercept?.decision.action).toBe('allow');
  });

});

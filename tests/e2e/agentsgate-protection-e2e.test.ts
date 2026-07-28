/**
 * E2E tests for AgentsGate protection layers via MCPStdioProxy:
 *   - Session expiry
 *   - Per-agent rate limiter
 *   - Per-agent daily quota
 *   - Circuit breaker (consecutive-block trip)
 *   - Velocity detector (rapid-fire boost)
 *
 * Each test exercises the full wire path through createPipeline so that the
 * protection mechanism is driven by real tool calls over JSON-RPC 2.0.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { McpClientHarness } from '../helpers/mcp-client-harness.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import { createPipeline } from '../../src/modules/m1-proxy/index.js';
import { AgentRateLimiter } from '../../src/utils/rate-limiter.js';
import { AgentQuotaManager } from '../../src/utils/agent-quota.js';
import { AgentCircuitBreaker } from '../../src/utils/circuit-breaker.js';
import { VelocityDetector } from '../../src/utils/velocity-detector.js';

let h: McpClientHarness;

afterEach(async () => { await h?.stop(); });

// ── Session expiry ────────────────────────────────────────────────────────────

describe('Session expiry', () => {

  it('blocks immediately when sessionId is in expiredSessions', async () => {
    const expiredSessions = new Set(['expired-session-1']);
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      expiredSessions,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, sessionId: 'expired-session-1' });

    const resp = await h.request('tools/call', { name: 'echo', arguments: { message: 'x' } });
    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(h.lastIntercept?.decision.action).toBe('block');
    expect(h.lastIntercept?.decision.riskScore).toBe(1.0);
    expect(h.lastIntercept?.decision.reasons.some(r => r.includes('force-expired'))).toBe(true);
  });

  it('active session is allowed while an unrelated session is expired', async () => {
    const expiredSessions = new Set(['expired-session-2']);
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      expiredSessions,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, sessionId: 'active-session' });

    const result = await h.callTool('echo', { message: 'active' });
    expect((result as { content: Array<{ text: string }> }).content[0]?.text).toBe('active');
    expect(h.lastIntercept?.decision.action).toBe('allow');
  });

  it('adding a sessionId to expiredSessions mid-run blocks subsequent calls', async () => {
    const expiredSessions = new Set<string>();
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      expiredSessions,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, sessionId: 'dynamic-session' });

    // Before expiry — allowed
    const ok = await h.callTool('echo', { message: 'before' });
    expect((ok as { content: Array<{ text: string }> }).content[0]?.text).toBe('before');

    // Expire the session
    expiredSessions.add('dynamic-session');

    // After expiry — blocked
    const resp = await h.request('tools/call', { name: 'echo', arguments: { message: 'after' } });
    expect(resp.error?.message).toContain('AgentsGate blocked');
  });

});

// ── Rate limiter ──────────────────────────────────────────────────────────────

describe('Rate limiter', () => {

  it('blocks after exceeding maxOpsPerWindow within the window', async () => {
    const rateLimiter = new AgentRateLimiter({ maxOpsPerWindow: 2, windowMs: 60_000 });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      rateLimiter,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'rate-agent-1' });

    await h.callTool('echo', { message: 'first' });
    await h.callTool('echo', { message: 'second' });

    const resp = await h.request('tools/call', { name: 'echo', arguments: { message: 'third' } });
    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(h.lastIntercept?.decision.reasons.some(r => r.includes('Rate limit exceeded'))).toBe(true);
  });

  it('rate-limit block has action=block and riskScore=1.0', async () => {
    const rateLimiter = new AgentRateLimiter({ maxOpsPerWindow: 1, windowMs: 60_000 });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      rateLimiter,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'rate-agent-2' });

    await h.callTool('echo', { message: 'ok' });
    await h.request('tools/call', { name: 'echo', arguments: { message: 'blocked' } });

    expect(h.lastIntercept?.decision.action).toBe('block');
    expect(h.lastIntercept?.decision.riskScore).toBe(1.0);
  });

  it('different agentIds have independent rate limit counters', async () => {
    const rateLimiter = new AgentRateLimiter({ maxOpsPerWindow: 1, windowMs: 60_000 });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      rateLimiter,
    });

    // Agent A exhausts its quota
    const hA = new McpClientHarness();
    await hA.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'agent-a' });
    await hA.callTool('echo', { message: 'a1' });
    const respA = await hA.request('tools/call', { name: 'echo', arguments: { message: 'a2' } });
    expect(respA.error?.message).toContain('AgentsGate blocked');
    await hA.stop();

    // Agent B still has budget
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'agent-b' });
    const result = await h.callTool('echo', { message: 'b1' });
    expect((result as { content: Array<{ text: string }> }).content[0]?.text).toBe('b1');
  });

});

// ── Quota manager ─────────────────────────────────────────────────────────────

describe('Quota manager', () => {

  it('blocks after exceeding defaultQuota operations', async () => {
    const quotaManager = new AgentQuotaManager({ defaultQuota: 2 });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      quotaManager,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'quota-agent-1' });

    await h.callTool('echo', { message: 'first' });
    await h.callTool('echo', { message: 'second' });
    const resp = await h.request('tools/call', { name: 'echo', arguments: { message: 'third' } });

    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(h.lastIntercept?.decision.reasons.some(r => r.includes('Daily quota exceeded'))).toBe(true);
    expect(h.lastIntercept?.decision.riskScore).toBe(1.0);
  });

  it('per-agent quota overrides the default', async () => {
    const quotaManager = new AgentQuotaManager({
      defaultQuota: 100,
      agentQuotas: { 'restricted-agent': 1 },
    });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      quotaManager,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'restricted-agent' });

    await h.callTool('echo', { message: 'ok' });
    const resp = await h.request('tools/call', { name: 'echo', arguments: { message: 'blocked' } });

    expect(resp.error?.message).toContain('AgentsGate blocked');
  });

  it('agents with no quota are never blocked by the quota manager', async () => {
    // agentQuotas only covers 'other-agent' — 'unlimited-agent' has no quota
    const quotaManager = new AgentQuotaManager({ agentQuotas: { 'other-agent': 1 } });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      quotaManager,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'unlimited-agent' });

    for (let i = 0; i < 5; i++) {
      await h.callTool('echo', { message: `call-${i}` });
    }

    const allowedActions = h.intercepts.map(r => r.decision.action);
    expect(allowedActions.every(a => a === 'allow')).toBe(true);
  });

});

// ── Circuit breaker ───────────────────────────────────────────────────────────

describe('Circuit breaker', () => {

  it('trips after threshold consecutive blocks and blocks all subsequent ops', async () => {
    // threshold=3; no auto-reset so circuit stays open for the test
    const circuitBreaker = new AgentCircuitBreaker({ threshold: 3, resetAfterMs: 0 });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      circuitBreaker,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'circuit-agent-1' });

    // execute_command is blocked by L1_EXECUTE_COMMAND; each block feeds recordBlock()
    await h.request('tools/call', { name: 'execute_command', arguments: {} }); // block 1
    await h.request('tools/call', { name: 'execute_command', arguments: {} }); // block 2
    await h.request('tools/call', { name: 'execute_command', arguments: {} }); // block 3 → trips

    // Now even a low-risk echo is blocked because the circuit is open
    const resp = await h.request('tools/call', { name: 'echo', arguments: { message: 'x' } });
    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(h.lastIntercept?.decision.reasons.some(r => r.includes('Circuit open'))).toBe(true);
  });

  it('circuit-blocked decision has riskScore=1.0 and action=block', async () => {
    const circuitBreaker = new AgentCircuitBreaker({ threshold: 2, resetAfterMs: 0 });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      circuitBreaker,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'circuit-agent-2' });

    await h.request('tools/call', { name: 'execute_command', arguments: {} }); // block 1
    await h.request('tools/call', { name: 'execute_command', arguments: {} }); // block 2 → trips
    await h.request('tools/call', { name: 'echo', arguments: { message: 'x' } }); // circuit blocked

    expect(h.lastIntercept?.decision.riskScore).toBe(1.0);
    expect(h.lastIntercept?.decision.action).toBe('block');
  });

  it('an allow resets the consecutive-block counter', async () => {
    const circuitBreaker = new AgentCircuitBreaker({ threshold: 3, resetAfterMs: 0 });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      circuitBreaker,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'circuit-agent-3' });

    await h.request('tools/call', { name: 'execute_command', arguments: {} }); // block 1
    await h.request('tools/call', { name: 'execute_command', arguments: {} }); // block 2
    // Allow resets the counter
    await h.callTool('echo', { message: 'ok' });                                // allow → reset

    expect(circuitBreaker.getConsecutiveBlocks('circuit-agent-3')).toBe(0);

    // Two more blocks are below threshold — circuit should remain closed
    await h.request('tools/call', { name: 'execute_command', arguments: {} }); // block 1 again
    await h.request('tools/call', { name: 'execute_command', arguments: {} }); // block 2
    // echo still allowed
    const result = await h.callTool('echo', { message: 'still-ok' });
    expect((result as { content: Array<{ text: string }> }).content[0]?.text).toBe('still-ok');
  });

});

// ── Velocity detector ─────────────────────────────────────────────────────────

describe('Velocity detector', () => {

  it('applies velocity boost when ops exceed threshold, bumping score to block', async () => {
    // threshold=2, decayFactor=0.6, maxBoost=1.0: on 3rd op, excess=1, boost=0.6
    // echo → DEFAULT=0.2, boosted=0.8 → block (≥ blockAtOrAbove=0.7)
    const velocityDetector = new VelocityDetector({ threshold: 2, decayFactor: 0.6, maxBoost: 1.0, windowMs: 60_000 });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      velocityDetector,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'velocity-agent-1' });

    // First two ops — no boost (opsInWindow ≤ threshold)
    await h.callTool('echo', { message: 'first' });
    await h.callTool('echo', { message: 'second' });
    expect(h.intercepts[0]?.decision.action).toBe('allow');
    expect(h.intercepts[1]?.decision.action).toBe('allow');

    // Third op — velocity boost: 0.2 + 0.6 = 0.8 → block
    const resp = await h.request('tools/call', { name: 'echo', arguments: { message: 'third' } });
    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.8, 5);
  });

  it('velocity boost is additive on top of L1 static score', async () => {
    // stat → L1_READ_ONLY=0.05; threshold=1, decayFactor=0.3
    // op 1: opsInWindow=1, no boost (1 ≤ threshold=1)
    // op 2: opsInWindow=2 > threshold → excess=1, boost=0.3 → 0.05+0.3=0.35 → require_approval
    const velocityDetector = new VelocityDetector({ threshold: 1, decayFactor: 0.3, windowMs: 60_000 });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      velocityDetector,
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'velocity-agent-2' });

    await h.request('tools/call', { name: 'stat', arguments: {} }); // op 1, no boost
    expect(h.intercepts[0]?.decision.action).toBe('allow');
    expect(h.intercepts[0]?.decision.riskScore).toBeCloseTo(0.05, 5);

    await h.request('tools/call', { name: 'stat', arguments: {} }); // op 2, boost 0.3
    expect(h.intercepts[1]?.decision.action).toBe('require_approval');
    expect(h.intercepts[1]?.decision.riskScore).toBeCloseTo(0.35, 5);
  });

  it('velocity boost does not carry across different agentIds', async () => {
    const velocityDetector = new VelocityDetector({ threshold: 2, decayFactor: 0.6, maxBoost: 1.0, windowMs: 60_000 });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      velocityDetector,
    });

    // Agent A fires 3 ops — 3rd gets a boost and is blocked
    const hA = new McpClientHarness();
    await hA.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'vel-agent-a' });
    await hA.callTool('echo', { message: '1' });
    await hA.callTool('echo', { message: '2' });
    await hA.request('tools/call', { name: 'echo', arguments: { message: '3' } }); // boosted → block
    expect(hA.lastIntercept?.decision.action).toBe('block');
    await hA.stop();

    // Agent B is unaffected — first call should be allow
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk!, agentId: 'vel-agent-b' });
    const result = await h.callTool('echo', { message: 'fresh' });
    expect((result as { content: Array<{ text: string }> }).content[0]?.text).toBe('fresh');
    expect(h.lastIntercept?.decision.action).toBe('allow');
  });

});

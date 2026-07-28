import { describe, it, expect } from 'vitest';
import { AgentRateLimiter, type RateLimitConfig } from '../../src/utils/rate-limiter.js';

describe('AgentRateLimiter', () => {
  it('allows operations within the limit', () => {
    const limiter = new AgentRateLimiter(5);
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('agent-a')).toBe(true);
    }
  });

  it('blocks the operation that exceeds the limit', () => {
    const limiter = new AgentRateLimiter(3);
    limiter.check('agent-a');
    limiter.check('agent-a');
    limiter.check('agent-a');
    expect(limiter.check('agent-a')).toBe(false);
  });

  it('isolates limits per agent', () => {
    const limiter = new AgentRateLimiter(2);
    limiter.check('agent-a');
    limiter.check('agent-a');
    // agent-a is at limit, agent-b should still be free
    expect(limiter.check('agent-a')).toBe(false);
    expect(limiter.check('agent-b')).toBe(true);
  });

  it('getCount reflects in-window operations', () => {
    const limiter = new AgentRateLimiter(10);
    limiter.check('agent-x');
    limiter.check('agent-x');
    expect(limiter.getCount('agent-x')).toBe(2);
  });

  it('reset clears all timestamps', () => {
    const limiter = new AgentRateLimiter(2);
    limiter.check('agent-a');
    limiter.check('agent-a');
    limiter.reset();
    expect(limiter.getCount('agent-a')).toBe(0);
    expect(limiter.check('agent-a')).toBe(true);
  });

  // ── Burst allowance ─────────────────────────────────────────────────────────

  it('burst allowance lets an agent spike over the sustained limit', () => {
    // 3 ops/window, 2 extra allowed in burst window (5s)
    const limiter = new AgentRateLimiter(
      { maxOpsPerWindow: 3, windowMs: 60_000, burstAllowance: 2, burstWindowMs: 5_000 }
    );
    // First 3: within sustained limit
    expect(limiter.check('agent-a')).toBe(true);
    expect(limiter.check('agent-a')).toBe(true);
    expect(limiter.check('agent-a')).toBe(true);
    // 4th and 5th: over limit but within burst (all 5 happen within burstWindowMs)
    expect(limiter.check('agent-a')).toBe(true);  // burst op 1
    expect(limiter.check('agent-a')).toBe(true);  // burst op 2
    // 6th: exceeds burst allowance too
    expect(limiter.check('agent-a')).toBe(false);
  });

  it('burst allowance=0 disables bursting', () => {
    const limiter = new AgentRateLimiter(
      { maxOpsPerWindow: 2, windowMs: 60_000, burstAllowance: 0 }
    );
    limiter.check('agent-a');
    limiter.check('agent-a');
    expect(limiter.check('agent-a')).toBe(false);
  });

  // ── Per-agent config ─────────────────────────────────────────────────────────

  it('per-agent limit overrides global limit', () => {
    const limiter = new AgentRateLimiter(
      10, // global: 10 ops/min
      60_000,
      { 'strict-agent': { maxOpsPerWindow: 2 } } // strict-agent: only 2
    );
    expect(limiter.check('strict-agent')).toBe(true);
    expect(limiter.check('strict-agent')).toBe(true);
    expect(limiter.check('strict-agent')).toBe(false); // blocked at 3

    // Normal agent unaffected
    for (let i = 0; i < 10; i++) expect(limiter.check('normal-agent')).toBe(true);
    expect(limiter.check('normal-agent')).toBe(false);
  });

  it('getConfig returns per-agent config when set', () => {
    const limiter = new AgentRateLimiter(
      10,
      60_000,
      { 'vip-agent': { maxOpsPerWindow: 100, burstAllowance: 20 } }
    );
    expect(limiter.getConfig('vip-agent').maxOpsPerWindow).toBe(100);
    expect(limiter.getConfig('vip-agent').burstAllowance).toBe(20);
    expect(limiter.getConfig('other-agent').maxOpsPerWindow).toBe(10);
  });

  it('getBurstCount tracks ops in burst window', () => {
    const limiter = new AgentRateLimiter(
      { maxOpsPerWindow: 5, windowMs: 60_000, burstAllowance: 3, burstWindowMs: 5_000 }
    );
    limiter.check('agent-b');
    limiter.check('agent-b');
    expect(limiter.getBurstCount('agent-b')).toBe(2);
  });

  it('rate limiter in pipeline blocks over-limit agents', async () => {
    const { MCPProxy, createPipeline } = await import('../../src/modules/m1-proxy/index.js');
    const { RiskScoringEngine } = await import('../../src/modules/m6-risk/index.js');
    const { InterventionController } = await import('../../src/modules/m7-intervention/index.js');
    const type = await import('../../src/types/interfaces.js');
    void type;

    const limiter = new AgentRateLimiter(2);
    const proxy = new MCPProxy(
      createPipeline({
        riskEngine: new RiskScoringEngine(),
        interventionController: new InterventionController(),
        rateLimiter: limiter,
      })
    );

    const makeOp = (id: string) => ({
      id, agentId: 'fast-agent', tool: 'filesystem', method: 'read_file',
      params: {}, timestamp: new Date(), sessionId: 's',
    });

    const d1 = await proxy.intercept(makeOp('op-1'));
    const d2 = await proxy.intercept(makeOp('op-2'));
    const d3 = await proxy.intercept(makeOp('op-3')); // should be blocked

    expect(d1.action).toBe('allow');
    expect(d2.action).toBe('allow');
    expect(d3.action).toBe('block');
    expect(d3.riskScore).toBe(1.0);
    expect(d3.reasons[0]).toContain('Rate limit');
  });
});

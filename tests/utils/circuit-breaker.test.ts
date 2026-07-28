/**
 * T172 — Agent circuit breaker tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentCircuitBreaker } from '../../src/utils/circuit-breaker.js';
import { createPipeline } from '../../src/modules/m1-proxy/index.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import type { MCPOperation } from '../../src/types/interfaces.js';

function makeOp(agentId = 'agent-1'): MCPOperation {
  return { id: 'op-1', agentId, tool: 'filesystem', method: 'read_file', params: {}, timestamp: new Date(), sessionId: 's1' };
}

describe('AgentCircuitBreaker', () => {
  it('circuit starts closed', () => {
    const cb = new AgentCircuitBreaker({ threshold: 3 });
    expect(cb.isOpen('agent-1')).toBe(false);
  });

  it('trips after threshold consecutive blocks', () => {
    const cb = new AgentCircuitBreaker({ threshold: 3 });
    cb.recordBlock('agent-1');
    cb.recordBlock('agent-1');
    expect(cb.isOpen('agent-1')).toBe(false);
    cb.recordBlock('agent-1'); // 3rd block — trips
    expect(cb.isOpen('agent-1')).toBe(true);
  });

  it('recordAllow resets consecutive count', () => {
    const cb = new AgentCircuitBreaker({ threshold: 3 });
    cb.recordBlock('agent-1');
    cb.recordBlock('agent-1');
    cb.recordAllow('agent-1'); // resets to 0
    cb.recordBlock('agent-1');
    expect(cb.isOpen('agent-1')).toBe(false); // only 1 block after reset
  });

  it('manual reset closes the circuit', () => {
    const cb = new AgentCircuitBreaker({ threshold: 1 });
    cb.recordBlock('agent-1');
    expect(cb.isOpen('agent-1')).toBe(true);
    cb.reset('agent-1');
    expect(cb.isOpen('agent-1')).toBe(false);
  });

  it('reset() with no arg clears all agents', () => {
    const cb = new AgentCircuitBreaker({ threshold: 1 });
    cb.recordBlock('agent-1');
    cb.recordBlock('agent-2');
    cb.reset();
    expect(cb.isOpen('agent-1')).toBe(false);
    expect(cb.isOpen('agent-2')).toBe(false);
  });

  it('auto-resets after resetAfterMs', async () => {
    const cb = new AgentCircuitBreaker({ threshold: 1, resetAfterMs: 50 });
    cb.recordBlock('agent-1');
    expect(cb.isOpen('agent-1')).toBe(true);
    await new Promise(r => setTimeout(r, 60));
    expect(cb.isOpen('agent-1')).toBe(false);
  });

  it('does not auto-reset when resetAfterMs=0', async () => {
    const cb = new AgentCircuitBreaker({ threshold: 1, resetAfterMs: 0 });
    cb.recordBlock('agent-1');
    await new Promise(r => setTimeout(r, 50));
    expect(cb.isOpen('agent-1')).toBe(true);
  });

  it('independent circuits per agent', () => {
    const cb = new AgentCircuitBreaker({ threshold: 2 });
    cb.recordBlock('agent-1');
    cb.recordBlock('agent-1');
    expect(cb.isOpen('agent-1')).toBe(true);
    expect(cb.isOpen('agent-2')).toBe(false);
  });

  it('getConsecutiveBlocks tracks count before trip', () => {
    const cb = new AgentCircuitBreaker({ threshold: 5 });
    cb.recordBlock('agent-1');
    cb.recordBlock('agent-1');
    expect(cb.getConsecutiveBlocks('agent-1')).toBe(2);
  });
});

describe('createPipeline — circuit breaker integration', () => {
  it('blocks agent when circuit is open', async () => {
    const cb = new AgentCircuitBreaker({ threshold: 1 });
    cb.recordBlock('agent-1'); // pre-trip

    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      circuitBreaker: cb,
    });

    const result = await pipeline.evaluateRisk!(makeOp('agent-1'));
    expect(result.action).toBe('block');
    expect(result.reasons[0]).toContain('Circuit open');
  });

  it('allows agent when circuit is closed', async () => {
    const cb = new AgentCircuitBreaker({ threshold: 5 });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      circuitBreaker: cb,
    });

    const result = await pipeline.evaluateRisk!(makeOp('agent-1'));
    expect(result.action).toBe('allow');
  });
});

/**
 * T170 — WSGateway integration in createPipeline.
 */
import { describe, it, expect } from 'vitest';
import { createPipeline } from '../../src/modules/m1-proxy/index.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

function makeOp(agentId = 'agent-1'): MCPOperation {
  return { id: 'op-1', agentId, tool: 'filesystem', method: 'read_file', params: {}, timestamp: new Date(), sessionId: 's1' };
}

/** Minimal WSGateway stub that records broadcast calls. */
class StubGateway {
  readonly calls: Array<{ operation: MCPOperation; decision: ProxyDecision }> = [];
  broadcast(operation: MCPOperation, decision: ProxyDecision): void {
    this.calls.push({ operation, decision });
  }
  get clientCount() { return 0; }
}

describe('createPipeline — WSGateway integration', () => {
  it('broadcasts every allowed decision to wsGateway', async () => {
    const stub = new StubGateway();
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      wsGateway: stub as never,
    });

    await pipeline.evaluateRisk!(makeOp());
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].decision.action).toBe('allow');
  });

  it('broadcasts session-expire blocks to wsGateway', async () => {
    const stub = new StubGateway();
    const expired = new Set(['s1']);
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      wsGateway: stub as never,
      expiredSessions: expired,
    });

    await pipeline.evaluateRisk!(makeOp());
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].decision.action).toBe('block');
    expect(stub.calls[0].decision.reasons[0]).toContain('force-expired');
  });

  it('broadcasts quota-exceeded blocks to wsGateway', async () => {
    const stub = new StubGateway();
    const { AgentQuotaManager } = await import('../../src/utils/agent-quota.js');
    const quotaManager = new AgentQuotaManager({ agentQuotas: { 'agent-1': 0 } });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      wsGateway: stub as never,
      quotaManager,
    });

    await pipeline.evaluateRisk!(makeOp());
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].decision.reasons[0]).toContain('Daily quota exceeded');
  });

  it('broadcasts multiple operations independently', async () => {
    const stub = new StubGateway();
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      wsGateway: stub as never,
    });

    await pipeline.evaluateRisk!(makeOp('agent-1'));
    await pipeline.evaluateRisk!(makeOp('agent-2'));
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0].operation.agentId).toBe('agent-1');
    expect(stub.calls[1].operation.agentId).toBe('agent-2');
  });

  it('works without wsGateway (no error)', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
    });
    await expect(pipeline.evaluateRisk!(makeOp())).resolves.toBeDefined();
  });
});

/**
 * T164 — Per-agent daily quota tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentQuotaManager } from '../../src/utils/agent-quota.js';
import { createPipeline } from '../../src/modules/m1-proxy/index.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import type { MCPOperation } from '../../src/types/interfaces.js';

function makeOp(agentId = 'agent-1'): MCPOperation {
  return { id: 'op-1', agentId, tool: 'filesystem', method: 'read_file', params: {}, timestamp: new Date(), sessionId: 'sess-1' };
}

describe('AgentQuotaManager', () => {
  it('allows operations under the quota', () => {
    const mgr = new AgentQuotaManager({ agentQuotas: { 'agent-1': 3 } });
    expect(mgr.check('agent-1')).toBe(true);
    expect(mgr.check('agent-1')).toBe(true);
    expect(mgr.check('agent-1')).toBe(true);
  });

  it('blocks operations when quota is exceeded', () => {
    const mgr = new AgentQuotaManager({ agentQuotas: { 'agent-1': 2 } });
    mgr.check('agent-1');
    mgr.check('agent-1');
    expect(mgr.check('agent-1')).toBe(false);
  });

  it('agents without a quota are always allowed', () => {
    const mgr = new AgentQuotaManager({ agentQuotas: { 'agent-1': 1 } });
    for (let i = 0; i < 100; i++) {
      expect(mgr.check('agent-2')).toBe(true); // no quota for agent-2
    }
  });

  it('applies defaultQuota to unconfigured agents', () => {
    const mgr = new AgentQuotaManager({ defaultQuota: 2 });
    expect(mgr.check('any-agent')).toBe(true);
    expect(mgr.check('any-agent')).toBe(true);
    expect(mgr.check('any-agent')).toBe(false);
  });

  it('per-agent quota overrides defaultQuota', () => {
    const mgr = new AgentQuotaManager({ defaultQuota: 10, agentQuotas: { 'agent-1': 1 } });
    expect(mgr.check('agent-1')).toBe(true);
    expect(mgr.check('agent-1')).toBe(false);
    // Other agents still use defaultQuota
    for (let i = 0; i < 10; i++) expect(mgr.check('agent-2')).toBe(true);
    expect(mgr.check('agent-2')).toBe(false);
  });

  it('getCount returns current day count', () => {
    const mgr = new AgentQuotaManager({ agentQuotas: { 'agent-1': 10 } });
    mgr.check('agent-1');
    mgr.check('agent-1');
    expect(mgr.getCount('agent-1')).toBe(2);
    expect(mgr.getCount('agent-2')).toBe(0);
  });

  it('getQuota returns configured quota', () => {
    const mgr = new AgentQuotaManager({ defaultQuota: 50, agentQuotas: { 'agent-x': 5 } });
    expect(mgr.getQuota('agent-x')).toBe(5);
    expect(mgr.getQuota('agent-unknown')).toBe(50);
  });

  it('reset clears all counters', () => {
    const mgr = new AgentQuotaManager({ agentQuotas: { 'agent-1': 2 } });
    mgr.check('agent-1');
    mgr.check('agent-1');
    expect(mgr.check('agent-1')).toBe(false);
    mgr.reset();
    expect(mgr.check('agent-1')).toBe(true);
  });
});

describe('createPipeline — agent quota enforcement', () => {
  it('blocks operations from quota-exceeded agents', async () => {
    const quotaManager = new AgentQuotaManager({ agentQuotas: { 'agent-1': 2 } });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      quotaManager,
    });

    expect((await pipeline.evaluateRisk!(makeOp())).action).toBe('allow');
    expect((await pipeline.evaluateRisk!(makeOp())).action).toBe('allow');
    const blocked = await pipeline.evaluateRisk!(makeOp());
    expect(blocked.action).toBe('block');
    expect(blocked.reasons[0]).toContain('Daily quota exceeded');
  });

  it('does not block other agents when one is over quota', async () => {
    const quotaManager = new AgentQuotaManager({ agentQuotas: { 'agent-1': 0 } });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      quotaManager,
    });

    const blocked = await pipeline.evaluateRisk!(makeOp('agent-1'));
    expect(blocked.action).toBe('block');

    const allowed = await pipeline.evaluateRisk!(makeOp('agent-2'));
    expect(allowed.action).toBe('allow');
  });
});

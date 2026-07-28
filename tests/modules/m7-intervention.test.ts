import { describe, it, expect } from 'vitest';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import type { RiskAssessment } from '../../src/types/interfaces.js';

function makeAssessment(finalScore: number, triggeredRules: string[] = []): RiskAssessment {
  return {
    operationId: 'op-test',
    staticScore: finalScore,
    userHistoryScore: -1,
    communityScore: -1,
    finalScore,
    triggeredRules,
    assessedAt: new Date(),
  };
}

describe('InterventionController', () => {
  const controller = new InterventionController();

  it('should return action "allow" for risk score below 0.3', async () => {
    const decision = await controller.decide(makeAssessment(0.05));
    expect(decision.action).toBe('allow');

    const boundary = await controller.decide(makeAssessment(0.29));
    expect(boundary.action).toBe('allow');
  });

  it('should return action "require_approval" for risk score between 0.3 and 0.7', async () => {
    const mid = await controller.decide(makeAssessment(0.5));
    expect(mid.action).toBe('require_approval');

    const low = await controller.decide(makeAssessment(0.3));
    expect(low.action).toBe('require_approval');

    const high = await controller.decide(makeAssessment(0.699));
    expect(high.action).toBe('require_approval');
  });

  it('should return action "block" for risk score at or above 0.7', async () => {
    const at = await controller.decide(makeAssessment(0.7));
    expect(at.action).toBe('block');

    const above = await controller.decide(makeAssessment(0.95));
    expect(above.action).toBe('block');
  });

  it('should include riskScore and reasons in the ProxyDecision', async () => {
    const decision = await controller.decide(
      makeAssessment(0.85, ['L1_DELETE_FILE'])
    );
    expect(decision.riskScore).toBe(0.85);
    expect(decision.reasons.length).toBeGreaterThan(0);
    expect(decision.reasons.some(r => r.includes('0.85'))).toBe(true);
    expect(decision.reasons).toContain('Triggered rule: L1_DELETE_FILE');
  });

  it('should set checkpointId when a checkpoint was created', async () => {
    const withCp = await controller.decide(makeAssessment(0.8), 'cp-abc123');
    expect(withCp.checkpointId).toBe('cp-abc123');

    const withoutCp = await controller.decide(makeAssessment(0.1));
    expect(withoutCp.checkpointId).toBeUndefined();
  });
});

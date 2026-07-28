/**
 * T182 — Risk rule muting via policy mutedRules.
 */
import { describe, it, expect } from 'vitest';
import { createPipeline } from '../src/modules/m1-proxy/index.js';
import { RiskScoringEngine } from '../src/modules/m6-risk/index.js';
import { InterventionController } from '../src/modules/m7-intervention/index.js';
import { mergePolicies } from '../src/policy.js';
import type { MCPOperation } from '../src/types/interfaces.js';

// An operation that hits L1_DELETE_FILE (score 0.7)
function makeDeleteOp(): MCPOperation {
  return {
    id: 'op-1', agentId: 'agent-1', tool: 'filesystem',
    method: 'delete_file', params: { path: '/tmp/test.txt' },
    timestamp: new Date(), sessionId: 's1',
  };
}

// An operation targeting a .env file — triggers L1_SENSITIVE_FILE_TYPE (0.75)
function makeSensitiveOp(): MCPOperation {
  return {
    id: 'op-2', agentId: 'agent-1', tool: 'filesystem',
    method: 'write_file', params: { path: '/app/.env' },
    timestamp: new Date(), sessionId: 's1',
  };
}

describe('Policy mutedRules — rule silencing', () => {
  it('without mutedRules, delete op has elevated risk', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
    });
    const dec = await pipeline.evaluateRisk!(makeDeleteOp());
    expect(dec.riskScore).toBeGreaterThan(0.3);
  });

  it('mutedRules suppresses the named rule, reducing risk score', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      policy: { rules: [], mutedRules: ['L1_DELETE_FILE'] },
    });
    const dec = await pipeline.evaluateRisk!(makeDeleteOp());
    // With L1_DELETE_FILE muted, the score should drop significantly
    expect(dec.riskScore).toBeLessThan(0.7);
  });

  it('muting a rule not applicable to the op has no effect', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      policy: { rules: [], mutedRules: ['NONEXISTENT_RULE'] },
    });
    const decBase = await createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
    }).evaluateRisk!(makeDeleteOp());
    const decMuted = await pipeline.evaluateRisk!(makeDeleteOp());
    expect(decMuted.riskScore).toBeCloseTo(decBase.riskScore, 2);
  });

  it('mutedRules applies to sensitive file type rule (muting both overlapping rules)', async () => {
    // /app/.env triggers L1_SENSITIVE_PATH_WRITE (0.9) AND L1_SENSITIVE_FILE_TYPE (0.75).
    // Mute both to see a meaningful score reduction.
    const withMute = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      policy: { rules: [], mutedRules: ['L1_SENSITIVE_FILE_TYPE', 'L1_SENSITIVE_PATH_WRITE'] },
    });
    const withoutMute = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
    });
    const muteScore = (await withMute.evaluateRisk!(makeSensitiveOp())).riskScore;
    const baseScore = (await withoutMute.evaluateRisk!(makeSensitiveOp())).riskScore;
    expect(muteScore).toBeLessThan(baseScore);
  });

  it('mergePolicies accumulates mutedRules from all policies', () => {
    const merged = mergePolicies([
      { rules: [], mutedRules: ['RULE_A'] },
      { rules: [], mutedRules: ['RULE_B', 'RULE_C'] },
    ]);
    expect(merged.mutedRules).toContain('RULE_A');
    expect(merged.mutedRules).toContain('RULE_B');
    expect(merged.mutedRules).toContain('RULE_C');
  });

  it('mutedRules is optional — absent means no muting', () => {
    const merged = mergePolicies([{ rules: [] }, { rules: [] }]);
    expect(merged.mutedRules ?? []).toHaveLength(0);
  });
});

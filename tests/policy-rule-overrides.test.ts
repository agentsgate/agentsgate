/**
 * T190 — Policy ruleOverrides: customize built-in L1 rule scores.
 */
import { describe, it, expect } from 'vitest';
import { createPipeline } from '../src/modules/m1-proxy/index.js';
import { RiskScoringEngine } from '../src/modules/m6-risk/index.js';
import { InterventionController } from '../src/modules/m7-intervention/index.js';
import { mergePolicies } from '../src/policy.js';
import type { MCPOperation } from '../src/types/interfaces.js';

function makeDeleteOp(): MCPOperation {
  return { id: 'op-1', agentId: 'a', tool: 'filesystem', method: 'delete_file',
    params: { path: '/tmp/test.txt' }, timestamp: new Date(), sessionId: 's1' };
}

describe('Policy ruleOverrides — score customization', () => {
  it('without override, delete op uses built-in L1_DELETE_FILE score (0.9)', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
    });
    const dec = await pipeline.evaluateRisk!(makeDeleteOp());
    expect(dec.riskScore).toBeCloseTo(0.9, 1);
  });

  it('ruleOverrides lowers the score for L1_DELETE_FILE', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      policy: { rules: [], ruleOverrides: { 'L1_DELETE_FILE': 0.3 } },
    });
    const dec = await pipeline.evaluateRisk!(makeDeleteOp());
    expect(dec.riskScore).toBeLessThan(0.9);
    expect(dec.riskScore).toBeCloseTo(0.3, 1);
  });

  it('ruleOverrides raises a rule score above its default', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      policy: { rules: [], ruleOverrides: { 'L1_DELETE_FILE': 1.0 } },
    });
    const dec = await pipeline.evaluateRisk!(makeDeleteOp());
    expect(dec.riskScore).toBeCloseTo(1.0, 2);
  });

  it('overriding a non-firing rule has no effect', async () => {
    const baseP = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
    });
    const withOverride = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      policy: { rules: [], ruleOverrides: { 'L1_DROP_TABLE': 0.1 } },
    });
    const base = (await baseP.evaluateRisk!(makeDeleteOp())).riskScore;
    const withOv = (await withOverride.evaluateRisk!(makeDeleteOp())).riskScore;
    expect(withOv).toBeCloseTo(base, 2);
  });

  it('mergePolicies merges ruleOverrides with last-wins semantics', () => {
    const merged = mergePolicies([
      { rules: [], ruleOverrides: { 'L1_DELETE_FILE': 0.5, 'L1_DROP_TABLE': 0.3 } },
      { rules: [], ruleOverrides: { 'L1_DELETE_FILE': 0.2 } },
    ]);
    expect(merged.ruleOverrides!['L1_DELETE_FILE']).toBe(0.2); // last wins
    expect(merged.ruleOverrides!['L1_DROP_TABLE']).toBe(0.3);  // from first
  });

  it('ruleOverrides fires before mutedRules — muted+overridden rule is still discarded', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      policy: { rules: [], ruleOverrides: { 'L1_DELETE_FILE': 0.99 }, mutedRules: ['L1_DELETE_FILE'] },
    });
    const dec = await pipeline.evaluateRisk!(makeDeleteOp());
    // Muting takes final priority — rule discarded even though overridden
    expect(dec.riskScore).toBeLessThan(0.9);
  });
});

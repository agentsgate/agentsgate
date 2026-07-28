/**
 * T150 — Dry-run mode tests.
 *
 * When dryRun: true, the pipeline:
 *   - Scores operations normally
 *   - Downgrades 'block' and 'require_approval' to 'allow'
 *   - Annotates the decision with dryRun: true
 *   - Prepends "[DRY-RUN] Would have <action>" to reasons
 */
import { describe, it, expect } from 'vitest';
import { createPipeline } from '../../src/modules/m1-proxy/index.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import type { MCPOperation } from '../../src/types/interfaces.js';

function makeOp(method = 'read_file', tool = 'filesystem'): MCPOperation {
  return {
    id: 'op-1',
    agentId: 'agent-1',
    tool,
    method,
    params: {},
    timestamp: new Date(),
    sessionId: 'sess-1',
  };
}

describe('createPipeline — dry-run mode', () => {
  it('allows a normally-blocked operation in dry-run mode', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController({ allowBelow: 0.3, blockAtOrAbove: 0.5 }),
      dryRun: true,
    });

    // delete_file should score high and normally be blocked
    const decision = await pipeline.evaluateRisk!(makeOp('delete_file'));
    expect(decision.action).toBe('allow');
    expect(decision.dryRun).toBe(true);
    expect(decision.reasons[0]).toContain('[DRY-RUN]');
    expect(decision.reasons[0]).toContain('block');
  });

  it('annotates allowed operations with dryRun: true', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      dryRun: true,
    });

    // read_file is low risk → normally allowed; dryRun should still be set
    const decision = await pipeline.evaluateRisk!(makeOp('read_file'));
    expect(decision.action).toBe('allow');
    expect(decision.dryRun).toBe(true);
    // No "[DRY-RUN] Would have" prefix since it was already allow
    expect(decision.reasons[0]).not.toContain('[DRY-RUN]');
  });

  it('preserves the assessed riskScore even when downgrading', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController({ allowBelow: 0.3, blockAtOrAbove: 0.5 }),
      dryRun: true,
    });

    const decision = await pipeline.evaluateRisk!(makeOp('delete_file'));
    // Risk score should still reflect the real assessment, not 0
    expect(decision.riskScore).toBeGreaterThan(0.3);
    expect(decision.action).toBe('allow');
  });

  it('does not downgrade decisions when dryRun is false', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController({ allowBelow: 0.3, blockAtOrAbove: 0.5 }),
      dryRun: false,
    });

    const decision = await pipeline.evaluateRisk!(makeOp('delete_file'));
    expect(decision.action).toBe('block');
    expect(decision.dryRun).toBeUndefined();
  });

  it('does not downgrade decisions when dryRun is not set', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController({ allowBelow: 0.3, blockAtOrAbove: 0.5 }),
    });

    const decision = await pipeline.evaluateRisk!(makeOp('delete_file'));
    expect(decision.action).toBe('block');
    expect(decision.dryRun).toBeUndefined();
  });

  it('session-expired ops are still blocked even in dry-run mode', async () => {
    const expiredSessions = new Set(['sess-1']);
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      expiredSessions,
      dryRun: true,
    });

    // Session is expired — this should block before dry-run logic runs
    const decision = await pipeline.evaluateRisk!(makeOp('read_file'));
    expect(decision.action).toBe('block');
    expect(decision.reasons[0]).toContain('force-expired');
  });
});

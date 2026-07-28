/**
 * T095 — Risk rule explanation tests.
 *
 * Verifies that RiskScoringEngine populates firedRuleDetails on the
 * RiskAssessment, and that the pipeline forwards them as ProxyDecision.firedRules.
 */
import { describe, it, expect } from 'vitest';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import { createPipeline } from '../../src/modules/m1-proxy/index.js';
import type { MCPOperation, FiredRule } from '../../src/types/interfaces.js';
import { randomUUID } from 'node:crypto';

function makeOp(tool: string, method: string, params: Record<string, unknown> = {}): MCPOperation {
  return {
    id: randomUUID(),
    agentId: 'test-agent',
    tool,
    method,
    params,
    timestamp: new Date(),
    sessionId: 'test-session',
  };
}

describe('RiskScoringEngine — firedRuleDetails', () => {

  it('populates firedRuleDetails with L1 rules that fired', async () => {
    const engine = new RiskScoringEngine();
    const op = makeOp('filesystem', 'delete_file', { path: '/data/file.txt' });
    const assessment = await engine.assess(op);

    expect(assessment.firedRuleDetails).toBeDefined();
    expect(assessment.firedRuleDetails!.length).toBeGreaterThan(0);

    const rule = assessment.firedRuleDetails![0] as FiredRule;
    expect(rule.id).toBe('L1_DELETE_FILE');
    expect(rule.score).toBe(0.9);
    expect(rule.layer).toBe('L1');
    expect(rule.description).toContain('delete');
  });

  it('returns empty firedRuleDetails when no specific rule fires', async () => {
    const engine = new RiskScoringEngine();
    // tool: 'unknown' + method: 'unknown_action' → no rule fires
    const op = makeOp('unknown', 'unknown_action');
    const assessment = await engine.assess(op);

    expect(assessment.firedRuleDetails).toBeDefined();
    expect(assessment.firedRuleDetails!).toHaveLength(0);
  });

  it('includes multiple fired rules when several match', async () => {
    const engine = new RiskScoringEngine();
    // delete on a sensitive path fires both L1_DELETE_RECORD and L1_SENSITIVE_PATH_WRITE
    const op = makeOp('database', 'delete_record', { path: '/app/.env' });
    const assessment = await engine.assess(op);

    const ids = assessment.firedRuleDetails!.map(r => r.id);
    expect(ids).toContain('L1_DELETE_RECORD');
    expect(ids).toContain('L1_SENSITIVE_PATH_WRITE');
  });

  it('L1_READ_ONLY rule has low score and correct description', async () => {
    const engine = new RiskScoringEngine();
    const op = makeOp('filesystem', 'read_file', { path: '/tmp/data.txt' });
    const assessment = await engine.assess(op);

    expect(assessment.firedRuleDetails).toBeDefined();
    const readRule = assessment.firedRuleDetails!.find(r => r.id === 'L1_READ_ONLY');
    expect(readRule).toBeDefined();
    expect(readRule!.score).toBe(0.05);
    expect(readRule!.layer).toBe('L1');
  });
});

describe('createPipeline — ProxyDecision.firedRules', () => {

  it('attaches firedRules to decision for operations with matching L1 rules', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
    });

    const op = makeOp('filesystem', 'delete_file', { path: '/data/file.txt' });
    const decision = await pipeline.evaluateRisk!(op);

    expect(decision.firedRules).toBeDefined();
    expect(decision.firedRules!.length).toBeGreaterThan(0);
    expect(decision.firedRules![0].id).toBe('L1_DELETE_FILE');
    expect(decision.firedRules![0].layer).toBe('L1');
  });

  it('firedRules is absent when no L1 rules fire', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
    });

    const op = makeOp('unknown', 'unknown_action');
    const decision = await pipeline.evaluateRisk!(op);

    // No rules fired → firedRules should be undefined or empty
    expect(!decision.firedRules || decision.firedRules.length === 0).toBe(true);
  });

  it('firedRules carries description text', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
    });

    const op = makeOp('database', 'drop_table', {});
    const decision = await pipeline.evaluateRisk!(op);

    const dropRule = decision.firedRules?.find(r => r.id === 'L1_DROP_TABLE');
    expect(dropRule).toBeDefined();
    expect(dropRule!.description).toBeTruthy();
    expect(typeof dropRule!.description).toBe('string');
  });
});

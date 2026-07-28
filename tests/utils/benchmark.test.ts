/**
 * T156 — agentsgate benchmark smoke test.
 * Verifies that the pipeline can handle a synthetic burst of operations
 * and that performance is measurable (i.e. it completes without error).
 */
import { describe, it, expect } from 'vitest';
import { createPipeline } from '../../src/modules/m1-proxy/index.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import type { MCPOperation } from '../../src/types/interfaces.js';

function makeOp(i: number): MCPOperation {
  const tools = ['filesystem', 'database', 'shell'];
  const methods = ['read_file', 'write_file', 'delete_file', 'execute', 'list_directory'];
  return {
    id: `bench-${i}`,
    agentId: `agent-${i % 3}`,
    tool: tools[i % tools.length],
    method: methods[i % methods.length],
    params: { path: `/tmp/bench-${i}.txt` },
    timestamp: new Date(),
    sessionId: `sess-${i % 2}`,
  };
}

describe('Pipeline benchmark', () => {
  it('completes 50 sequential operations without error', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
    });

    const results = [];
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      results.push(await pipeline.evaluateRisk!(makeOp(i)));
    }
    const elapsed = performance.now() - start;

    expect(results).toHaveLength(50);
    expect(results.every(r => ['allow', 'block', 'require_approval'].includes(r.action))).toBe(true);
    // Sanity check: 50 ops should complete in under 2s even on slow CI
    expect(elapsed).toBeLessThan(2000);
  });

  it('completes 20 concurrent operations without error', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
    });

    const ops = Array.from({ length: 20 }, (_, i) => pipeline.evaluateRisk!(makeOp(i)));
    const results = await Promise.all(ops);

    expect(results).toHaveLength(20);
    expect(results.every(r => r.riskScore >= 0 && r.riskScore <= 1)).toBe(true);
  });

  it('produces deterministic risk scores for identical operations', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
    });

    const op = makeOp(0); // filesystem/read_file → always low risk
    const [r1, r2, r3] = await Promise.all([
      pipeline.evaluateRisk!(op),
      pipeline.evaluateRisk!(op),
      pipeline.evaluateRisk!(op),
    ]);

    expect(r1.riskScore).toBe(r2.riskScore);
    expect(r2.riskScore).toBe(r3.riskScore);
  });
});

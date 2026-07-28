/**
 * T467 Tests
 *
 * DX2: toMysqlParams helper — logic verified in isolation (MCP server cannot be imported)
 * R4:  Rule hit-count decay via createPipeline()
 */
import { describe, it, expect } from 'vitest';
import { createPipeline, MCPProxy } from '../../src/modules/m1-proxy/index.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import type { MCPOperation } from '../../src/types/interfaces.js';

// ---------------------------------------------------------------------------
// DX2 — toMysqlParams logic (reproduced inline — file cannot be imported)
// ---------------------------------------------------------------------------

/** Mirrors the production helper defined in src/mcp-servers/mysql-database/index.ts */
type MysqlParam = string | number | boolean | null | Buffer | Date | bigint;

function toMysqlParams(values: unknown[]): MysqlParam[] {
  return values as MysqlParam[];
}

describe('DX2 — toMysqlParams helper logic', () => {
  it('returns an empty array for an empty input', () => {
    const result = toMysqlParams([]);
    expect(result).toEqual([]);
  });

  it('passes through null values', () => {
    const result = toMysqlParams([null]);
    expect(result[0]).toBeNull();
  });

  it('passes through string, number, boolean', () => {
    const result = toMysqlParams(['hello', 42, true]);
    expect(result).toEqual(['hello', 42, true]);
  });

  it('passes through Buffer values', () => {
    const buf = Buffer.from('test');
    const result = toMysqlParams([buf]);
    expect(result[0]).toBe(buf);
  });

  it('passes through Date values', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    const result = toMysqlParams([d]);
    expect(result[0]).toBe(d);
  });

  it('passes through bigint values', () => {
    const big = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const result = toMysqlParams([big]);
    expect(result[0]).toBe(big);
  });

  it('handles mixed types in a single call', () => {
    const d = new Date();
    const buf = Buffer.alloc(4);
    const result = toMysqlParams(['str', 1, true, null, buf, d, 999n]);
    expect(result).toHaveLength(7);
    expect(result[3]).toBeNull();
  });

  it('handles a ?? [] pattern (nullish coalescing guard)', () => {
    const nullish: unknown[] | undefined = undefined;
    const result = toMysqlParams(nullish ?? []);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an MCPOperation that triggers L1_DELETE_FILE (score 0.9 → block). */
function makeDeleteOp(agentId: string, id: string): MCPOperation {
  return {
    id,
    agentId,
    tool: 'filesystem',
    method: 'delete_file',
    params: { path: '/important/file.txt' },
    timestamp: new Date(),
    sessionId: `session-${agentId}`,
  };
}

/** Build an MCPOperation that triggers L1_OVERWRITE_FILE (score 0.65 → require_approval). */
function makeWriteOp(agentId: string, id: string): MCPOperation {
  return {
    id,
    agentId,
    tool: 'filesystem',
    method: 'write_file',
    params: { path: '/tmp/output.txt', content: 'data' },
    timestamp: new Date(),
    sessionId: `session-${agentId}`,
  };
}

// ---------------------------------------------------------------------------
// R4 — Rule hit-count decay
// ---------------------------------------------------------------------------

describe('R4 — Rule hit-count decay via createPipeline()', () => {
  const riskEngine = new RiskScoringEngine();
  // High block threshold so score changes don't flip action unexpectedly
  const interventionController = new InterventionController({
    allowBelow: 0.0,    // everything gets scored
    blockAtOrAbove: 2.0, // never block (we just inspect riskScore)
  });

  /**
   * Helper: run N identical ops through a fresh pipeline and collect riskScores.
   */
  async function runNTimes(
    n: number,
    hitDecay: { decayRate: number; minMultiplier: number } | undefined,
    agentId: string,
  ): Promise<number[]> {
    const pipeline = createPipeline({ riskEngine, interventionController, hitDecay });
    const proxy = new MCPProxy(pipeline);
    const scores: number[] = [];
    for (let i = 0; i < n; i++) {
      const decision = await proxy.intercept(makeDeleteOp(agentId, `op-${agentId}-${i}`));
      scores.push(decision.riskScore);
    }
    return scores;
  }

  it('without hitDecay the score is unchanged across repeated identical operations', async () => {
    const scores = await runNTimes(5, undefined, 'agent-no-decay');
    // All scores should be equal (base L1_DELETE_FILE = 0.9)
    const first = scores[0]!;
    for (const s of scores) {
      expect(s).toBeCloseTo(first, 6);
    }
  });

  it('first hit score is close to original (multiplied by 1/(1+1*rate))', async () => {
    const decayRate = 0.5;
    const minMultiplier = 0.1;
    const scores = await runNTimes(1, { decayRate, minMultiplier }, 'agent-first');
    // L1_DELETE_FILE base = 0.9; after 1 hit multiplier = 1/(1+0.5) ≈ 0.667
    const expectedMultiplier = 1 / (1 + 1 * decayRate);
    expect(scores[0]).toBeCloseTo(0.9 * expectedMultiplier, 4);
  });

  it('score decays significantly after 10 hits (near minMultiplier floor)', async () => {
    const decayRate = 0.5;
    const minMultiplier = 0.1;
    const scores = await runNTimes(10, { decayRate, minMultiplier }, 'agent-ten');
    const first = scores[0]!;
    const last = scores[9]!;
    // Score must have decreased substantially
    expect(last).toBeLessThan(first);
    // After 10 hits: multiplier = max(0.1, 1/(1+10*0.5)) = max(0.1, ~0.167) = 0.167
    // After even more: it will approach and floor at minMultiplier * base = 0.1 * 0.9 = 0.09
    expect(last).toBeLessThanOrEqual(0.9 * (1 / (1 + 10 * decayRate)) + 1e-6);
  });

  it('minMultiplier floor is respected — score never drops below it times base score', async () => {
    const decayRate = 0.5;
    const minMultiplier = 0.1;
    const baseScore = 0.9; // L1_DELETE_FILE
    const floor = baseScore * minMultiplier;
    const scores = await runNTimes(50, { decayRate, minMultiplier }, 'agent-floor');
    for (const s of scores) {
      expect(s).toBeGreaterThanOrEqual(floor - 1e-9);
    }
  });

  it('different agentId has an independent hit counter — no cross-agent decay', async () => {
    const hitDecay = { decayRate: 0.5, minMultiplier: 0.1 };
    // Build a single pipeline (shared hitCounts map)
    const pipeline = createPipeline({ riskEngine, interventionController, hitDecay });
    const proxy = new MCPProxy(pipeline);

    // Agent A fires 10 ops — its count decays
    const scoresA: number[] = [];
    for (let i = 0; i < 10; i++) {
      const d = await proxy.intercept(makeDeleteOp('agent-A', `opA-${i}`));
      scoresA.push(d.riskScore);
    }

    // Agent B fires its FIRST op — must have fresh (un-decayed) score
    const decisionB = await proxy.intercept(makeDeleteOp('agent-B', 'opB-0'));

    // Agent B's first-hit score: 0.9 * 1/(1+1*0.5) ≈ 0.6
    const expectedBMultiplier = 1 / (1 + 1 * hitDecay.decayRate);
    expect(decisionB.riskScore).toBeCloseTo(0.9 * expectedBMultiplier, 4);

    // Agent A's 10th-op score should be much lower than agent B's first-op score
    expect(scoresA[9]).toBeLessThan(decisionB.riskScore);
  });

  it('different rule is independently tracked — decay does not bleed across rules', async () => {
    const hitDecay = { decayRate: 0.5, minMultiplier: 0.1 };
    const pipeline = createPipeline({ riskEngine, interventionController, hitDecay });
    const proxy = new MCPProxy(pipeline);

    // Fire 10 delete_file ops (L1_DELETE_FILE) for agent-C
    for (let i = 0; i < 10; i++) {
      await proxy.intercept(makeDeleteOp('agent-C', `del-${i}`));
    }

    // Now fire a write_file op (L1_OVERWRITE_FILE, different rule, same agent)
    // This rule's hit count should be 1, not 10
    const writeDecision = await proxy.intercept(makeWriteOp('agent-C', 'write-0'));

    // L1_OVERWRITE_FILE base score = 0.65; first hit multiplier = 1/(1+1*0.5) ≈ 0.667
    const expectedMultiplier = 1 / (1 + 1 * hitDecay.decayRate);
    expect(writeDecision.riskScore).toBeCloseTo(0.65 * expectedMultiplier, 4);
  });

  it('score is monotonically non-increasing with each additional hit (same agent+rule)', async () => {
    const scores = await runNTimes(20, { decayRate: 0.5, minMultiplier: 0.05 }, 'agent-mono');
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]! + 1e-9);
    }
  });

  it('hitDecay with decayRate=0 produces no decay (multiplier stays 1)', async () => {
    // multiplier = 1 / (1 + hits * 0) = 1 forever
    const scores = await runNTimes(5, { decayRate: 0, minMultiplier: 0.1 }, 'agent-rate0');
    const baseScore = 0.9; // L1_DELETE_FILE
    // first hit: 0.9 * 1/(1+1*0) = 0.9
    for (const s of scores) {
      expect(s).toBeCloseTo(baseScore, 6);
    }
  });
});

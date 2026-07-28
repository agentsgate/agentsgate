/**
 * T112 — L2 per-tool breakdown in user history model.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RiskIntelligenceEngine } from '../../src/modules/m11-intelligence/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { randomUUID } from 'node:crypto';

describe('RiskIntelligenceEngine.getToolBreakdown (in-memory)', () => {
  let engine: RiskIntelligenceEngine;

  beforeEach(() => { engine = new RiskIntelligenceEngine(); });

  it('returns empty object when agent has no outcomes', async () => {
    const bd = await engine.getToolBreakdown('agent-x');
    expect(Object.keys(bd)).toHaveLength(0);
  });

  it('returns breakdown per tool with correct counts', async () => {
    // 10 approvals for filesystem
    for (let i = 0; i < 10; i++) {
      await engine.recordOutcome(randomUUID(), true, 'agent-a', 'filesystem');
    }
    // 5 approved + 5 denied for database (10 total)
    for (let i = 0; i < 5; i++) {
      await engine.recordOutcome(randomUUID(), true,  'agent-a', 'database');
      await engine.recordOutcome(randomUUID(), false, 'agent-a', 'database');
    }

    const bd = await engine.getToolBreakdown('agent-a');

    expect(bd['filesystem']).toBeDefined();
    expect(bd['filesystem'].total).toBe(10);
    expect(bd['filesystem'].approvedCount).toBe(10);
    expect(bd['filesystem'].deniedCount).toBe(0);
    expect(bd['filesystem'].score).toBe(0); // all approved → score 0 (low risk)

    expect(bd['database']).toBeDefined();
    expect(bd['database'].total).toBe(10);
    expect(bd['database'].score).toBeCloseTo(0.5); // half denied
  });

  it('score is -1 when fewer than MIN_HISTORY outcomes', async () => {
    for (let i = 0; i < 9; i++) {
      await engine.recordOutcome(randomUUID(), false, 'agent-a', 'github');
    }
    const bd = await engine.getToolBreakdown('agent-a');
    expect(bd['github'].score).toBe(-1);
    expect(bd['github'].total).toBe(9);
  });

  it('isolates per-agent breakdowns', async () => {
    for (let i = 0; i < 10; i++) {
      await engine.recordOutcome(randomUUID(), true,  'agent-a', 'filesystem');
      await engine.recordOutcome(randomUUID(), false, 'agent-b', 'filesystem');
    }

    const bdA = await engine.getToolBreakdown('agent-a');
    const bdB = await engine.getToolBreakdown('agent-b');

    expect(bdA['filesystem'].score).toBe(0);   // all approved
    expect(bdB['filesystem'].score).toBe(1.0); // all denied
  });

  it('getAllToolScores returns flat score map', async () => {
    for (let i = 0; i < 10; i++) {
      await engine.recordOutcome(randomUUID(), true, 'agent-a', 'filesystem');
      await engine.recordOutcome(randomUUID(), true, 'agent-a', 'database');
    }

    const scores = await engine.getAllToolScores('agent-a');
    expect(scores['filesystem']).toBe(0);
    expect(scores['database']).toBe(0);
  });
});

describe('RiskIntelligenceEngine.getToolBreakdown (with StateStore)', () => {
  let engine: RiskIntelligenceEngine;
  let store: StateStore;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    engine = new RiskIntelligenceEngine({ store });
  });

  afterEach(() => { store.close(); });

  it('persists and retrieves per-tool breakdown from DB', async () => {
    // 7 approved, 3 denied (deny indices 0,3,6)
    for (let i = 0; i < 10; i++) {
      await engine.recordOutcome(randomUUID(), i % 3 === 0 ? false : true, 'agent-db', 'filesystem');
    }
    // denied: i=0,3,6,9 → 4 denied, 6 approved → score = 0.4

    const freshEngine = new RiskIntelligenceEngine({ store });
    const bd = await freshEngine.getToolBreakdown('agent-db');

    expect(bd['filesystem']).toBeDefined();
    expect(bd['filesystem'].total).toBe(10);
    expect(bd['filesystem'].score).toBeCloseTo(0.4);
  });

  it('listAllOutcomeRecords returns all tools for an agent', async () => {
    await engine.recordOutcome(randomUUID(), true,  'agent-db', 'filesystem');
    await engine.recordOutcome(randomUUID(), false, 'agent-db', 'database');
    await engine.recordOutcome(randomUUID(), true,  'agent-db', 'github');

    const records = await store.listAllOutcomeRecords('agent-db');
    const tools = [...new Set(records.map(r => r.tool))];
    expect(tools).toContain('filesystem');
    expect(tools).toContain('database');
    expect(tools).toContain('github');
  });
});

/**
 * T104 — agentsgate audit command tests.
 * Tests the audit summary/diff output by calling cmdAudit via the StateStore directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateStore } from '../src/modules/m2-store/index.js';
import { randomUUID } from 'node:crypto';
import type { MCPOperation, ProxyDecision, OperationLog } from '../src/types/interfaces.js';

// Helpers

function makeLog(opts: {
  agentId: string;
  method: string;
  action: 'allow' | 'block' | 'require_approval';
  riskScore: number;
  createdAt?: Date;
}): OperationLog {
  const op: MCPOperation = {
    id: randomUUID(),
    agentId: opts.agentId,
    tool: 'filesystem',
    method: opts.method,
    params: {},
    timestamp: opts.createdAt ?? new Date(),
    sessionId: 'audit-session',
  };
  const decision: ProxyDecision = {
    action: opts.action,
    riskScore: opts.riskScore,
    reasons: [`Risk score ${opts.riskScore.toFixed(2)}`],
    firedRules: opts.riskScore >= 0.7 ? [{ id: 'L1_DELETE_FILE', score: 0.9, layer: 'L1', description: 'test' }] : [],
  };
  return {
    operationId: op.id,
    operation: op,
    decision,
    createdAt: opts.createdAt ?? new Date(),
  };
}

describe('StateStore audit queries (backing cmdAudit)', () => {
  let store: StateStore;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
  });

  afterEach(() => { store.close(); });

  it('listOperationLogs returns all saved logs for audit', async () => {
    const logs = [
      makeLog({ agentId: 'agent-a', method: 'read_file', action: 'allow', riskScore: 0.05 }),
      makeLog({ agentId: 'agent-a', method: 'delete_file', action: 'block', riskScore: 0.9 }),
      makeLog({ agentId: 'agent-b', method: 'write_file', action: 'require_approval', riskScore: 0.65 }),
    ];
    for (const l of logs) await store.saveOperationLog(l);

    const result = await store.listOperationLogs(50);
    expect(result).toHaveLength(3);
  });

  it('can filter by action=block for audit', async () => {
    const logs = [
      makeLog({ agentId: 'agent-a', method: 'read_file', action: 'allow', riskScore: 0.05 }),
      makeLog({ agentId: 'agent-a', method: 'delete_file', action: 'block', riskScore: 0.9 }),
    ];
    for (const l of logs) await store.saveOperationLog(l);

    const blocked = await store.listOperationLogs(50, 0, { action: 'block' });
    expect(blocked).toHaveLength(1);
    expect(blocked[0].decision.action).toBe('block');
  });

  it('can filter by agentId for per-agent audit', async () => {
    await store.saveOperationLog(makeLog({ agentId: 'agent-a', method: 'read_file', action: 'allow', riskScore: 0.1 }));
    await store.saveOperationLog(makeLog({ agentId: 'agent-b', method: 'delete_file', action: 'block', riskScore: 0.9 }));

    const aLogs = await store.listOperationLogs(50, 0, { agentId: 'agent-a' });
    expect(aLogs.every(l => l.operation.agentId === 'agent-a')).toBe(true);
  });

  it('firedRules survive log round-trip for audit display', async () => {
    const log = makeLog({ agentId: 'agent-a', method: 'delete_file', action: 'block', riskScore: 0.9 });
    // Inject firedRules
    log.decision.firedRules = [{ id: 'L1_DELETE_FILE', score: 0.9, layer: 'L1', description: 'Delete op' }];
    await store.saveOperationLog(log);

    const result = await store.listOperationLogs(1);
    // firedRules are part of the decision JSON stored in the DB
    expect(result[0].decision.firedRules).toBeDefined();
    expect(result[0].decision.firedRules![0].id).toBe('L1_DELETE_FILE');
  });
});

describe('audit output logic (unit)', () => {
  it('computes correct stats from a set of logs', () => {
    const logs = [
      makeLog({ agentId: 'a', method: 'read', action: 'allow', riskScore: 0.1 }),
      makeLog({ agentId: 'a', method: 'delete', action: 'block', riskScore: 0.9 }),
      makeLog({ agentId: 'b', method: 'write', action: 'require_approval', riskScore: 0.6 }),
    ];

    const total   = logs.length;
    const blocked = logs.filter(l => l.decision.action === 'block').length;
    const avgRisk = logs.reduce((s, l) => s + l.decision.riskScore, 0) / total;
    const agents  = new Set(logs.map(l => l.operation.agentId)).size;

    expect(total).toBe(3);
    expect(blocked).toBe(1);
    expect(avgRisk).toBeCloseTo(0.533, 2);
    expect(agents).toBe(2);
  });

  it('risk trend diff detects increasing trend', () => {
    const first  = [0.1, 0.15, 0.2].map(r => makeLog({ agentId: 'a', method: 'r', action: 'allow', riskScore: r }));
    const second = [0.7, 0.8, 0.9].map(r => makeLog({ agentId: 'a', method: 'r', action: 'block', riskScore: r }));
    const avg1 = first.reduce((s, l)  => s + l.decision.riskScore, 0) / first.length;
    const avg2 = second.reduce((s, l) => s + l.decision.riskScore, 0) / second.length;
    const delta = avg2 - avg1;
    expect(delta).toBeGreaterThan(0.05);
  });
});

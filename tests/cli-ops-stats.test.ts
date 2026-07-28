/**
 * T212 — agentsgate ops stats
 * Tests the aggregation logic backing cmdOpsStats() by exercising
 * StateStore + OperationLogger directly with an in-memory SQLite DB.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { StateStore } from '../src/modules/m2-store/index.js';
import { OperationLogger } from '../src/modules/m3-logger/index.js';
import type { MCPOperation, OperationLog } from '../src/types/interfaces.js';

const stores: StateStore[] = [];

async function makeStore(): Promise<{ store: StateStore; logger: OperationLogger }> {
  const store = new StateStore(':memory:');
  await store.initialize();
  stores.push(store);
  const logger = new OperationLogger(store, undefined, { redact: false });
  return { store, logger };
}

afterEach(async () => {
  for (const s of stores.splice(0)) {
    await s.close();
  }
});

function makeOp(agentId: string, tool: string, method = 'call'): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId,
    tool,
    method,
    params: {},
    timestamp: new Date(),
    sessionId: crypto.randomUUID(),
  };
}

/** Replicate the aggregation logic from cmdOpsStats() so we can unit-test it. */
function aggregateLogs(logs: OperationLog[]) {
  const total = logs.length;
  const byAction: Record<string, number> = { allow: 0, block: 0, require_approval: 0 };
  let riskSum = 0;
  let riskMax = 0;
  const toolCount: Map<string, number> = new Map();
  const toolBlocked: Map<string, number> = new Map();
  const agentCount: Map<string, number> = new Map();
  const agentRiskSum: Map<string, number> = new Map();

  for (const l of logs) {
    const action = l.decision.action;
    byAction[action] = (byAction[action] ?? 0) + 1;
    const rs = l.decision.riskScore;
    riskSum += rs;
    if (rs > riskMax) riskMax = rs;

    const t = l.operation.tool;
    toolCount.set(t, (toolCount.get(t) ?? 0) + 1);
    if (action === 'block') toolBlocked.set(t, (toolBlocked.get(t) ?? 0) + 1);

    const a = l.operation.agentId;
    agentCount.set(a, (agentCount.get(a) ?? 0) + 1);
    agentRiskSum.set(a, (agentRiskSum.get(a) ?? 0) + rs);
  }

  const avgRisk = total > 0 ? riskSum / total : 0;

  const topTools = [...toolCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tool, cnt]) => ({
      tool,
      cnt,
      blockRate: ((toolBlocked.get(tool) ?? 0) / cnt),
    }));

  const topAgents = [...agentCount.entries()]
    .map(([agent, cnt]) => ({ agent, cnt, avg: (agentRiskSum.get(agent) ?? 0) / cnt }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 10);

  return { total, byAction, avgRisk, riskMax, topTools, topAgents };
}

describe('cmdOpsStats aggregation logic', () => {
  it('empty DB returns zero counts without crashing', async () => {
    const { store } = await makeStore();
    const logs = await store.listOperationLogs(1000, 0);
    expect(logs.length).toBe(0);

    const result = aggregateLogs(logs);
    expect(result.total).toBe(0);
    expect(result.byAction.allow).toBe(0);
    expect(result.byAction.block).toBe(0);
    expect(result.byAction.require_approval).toBe(0);
    expect(result.avgRisk).toBe(0);
    expect(result.riskMax).toBe(0);
    expect(result.topTools).toHaveLength(0);
    expect(result.topAgents).toHaveLength(0);
  });

  it('single allow operation produces correct counts and risk score', async () => {
    const { store, logger } = await makeStore();
    await logger.log(makeOp('agent-a', 'filesystem'), { action: 'allow', riskScore: 0.25, reasons: [] });

    const logs = await store.listOperationLogs(1000, 0);
    const result = aggregateLogs(logs);

    expect(result.total).toBe(1);
    expect(result.byAction.allow).toBe(1);
    expect(result.byAction.block).toBe(0);
    expect(result.byAction.require_approval).toBe(0);
    expect(result.avgRisk).toBeCloseTo(0.25);
    expect(result.riskMax).toBeCloseTo(0.25);
    expect(result.topTools[0].tool).toBe('filesystem');
    expect(result.topTools[0].cnt).toBe(1);
    expect(result.topTools[0].blockRate).toBe(0);
    expect(result.topAgents[0].agent).toBe('agent-a');
    expect(result.topAgents[0].avg).toBeCloseTo(0.25);
  });

  it('mixed allow and block operations have correct percentages and block rate', async () => {
    const { store, logger } = await makeStore();
    // 2 allows + 1 block on 'database' tool
    await logger.log(makeOp('agent-a', 'database'), { action: 'allow', riskScore: 0.1, reasons: [] });
    await logger.log(makeOp('agent-a', 'database'), { action: 'allow', riskScore: 0.2, reasons: [] });
    await logger.log(makeOp('agent-a', 'database'), { action: 'block', riskScore: 0.9, reasons: [] });

    const logs = await store.listOperationLogs(1000, 0);
    const result = aggregateLogs(logs);

    expect(result.total).toBe(3);
    expect(result.byAction.allow).toBe(2);
    expect(result.byAction.block).toBe(1);
    expect(result.byAction.require_approval).toBe(0);

    // avg = (0.1 + 0.2 + 0.9) / 3 = 0.4
    expect(result.avgRisk).toBeCloseTo(0.4);
    expect(result.riskMax).toBeCloseTo(0.9);

    // block rate for 'database' = 1/3
    const dbTool = result.topTools.find(t => t.tool === 'database')!;
    expect(dbTool).toBeDefined();
    expect(dbTool.blockRate).toBeCloseTo(1 / 3);
  });

  it('max risk score is the highest riskScore across all operations', async () => {
    const { store, logger } = await makeStore();
    const scores = [0.1, 0.5, 0.95, 0.3, 0.7];
    for (const rs of scores) {
      await logger.log(makeOp('agent-x', 'shell'), { action: 'allow', riskScore: rs, reasons: [] });
    }

    const logs = await store.listOperationLogs(1000, 0);
    const result = aggregateLogs(logs);

    expect(result.riskMax).toBeCloseTo(0.95);
  });

  it('require_approval ops are counted separately', async () => {
    const { store, logger } = await makeStore();
    await logger.log(makeOp('agent-a', 'filesystem'), { action: 'allow', riskScore: 0.1, reasons: [] });
    await logger.log(makeOp('agent-a', 'filesystem'), { action: 'require_approval', riskScore: 0.6, reasons: [] });
    await logger.log(makeOp('agent-a', 'filesystem'), { action: 'require_approval', riskScore: 0.7, reasons: [] });
    await logger.log(makeOp('agent-a', 'filesystem'), { action: 'block', riskScore: 0.95, reasons: [] });

    const logs = await store.listOperationLogs(1000, 0);
    const result = aggregateLogs(logs);

    expect(result.total).toBe(4);
    expect(result.byAction.allow).toBe(1);
    expect(result.byAction.require_approval).toBe(2);
    expect(result.byAction.block).toBe(1);
  });

  it('per-tool breakdown lists tools sorted by operation count descending', async () => {
    const { store, logger } = await makeStore();
    // filesystem: 3 ops, database: 5 ops, shell: 1 op
    for (let i = 0; i < 3; i++) {
      await logger.log(makeOp('agent-a', 'filesystem'), { action: 'allow', riskScore: 0.1, reasons: [] });
    }
    for (let i = 0; i < 5; i++) {
      await logger.log(makeOp('agent-a', 'database'), { action: 'allow', riskScore: 0.2, reasons: [] });
    }
    await logger.log(makeOp('agent-a', 'shell'), { action: 'block', riskScore: 0.8, reasons: [] });

    const logs = await store.listOperationLogs(1000, 0);
    const result = aggregateLogs(logs);

    expect(result.topTools[0].tool).toBe('database');
    expect(result.topTools[0].cnt).toBe(5);
    expect(result.topTools[1].tool).toBe('filesystem');
    expect(result.topTools[1].cnt).toBe(3);
    expect(result.topTools[2].tool).toBe('shell');
    expect(result.topTools[2].cnt).toBe(1);
    // shell block rate = 1/1 = 100%
    expect(result.topTools[2].blockRate).toBeCloseTo(1.0);
  });

  it('per-agent avg risk is correct and sorted by avg risk descending', async () => {
    const { store, logger } = await makeStore();
    // risky-agent: 2 ops with scores 0.8, 0.6 → avg 0.7
    await logger.log(makeOp('risky-agent', 'shell'), { action: 'block', riskScore: 0.8, reasons: [] });
    await logger.log(makeOp('risky-agent', 'shell'), { action: 'block', riskScore: 0.6, reasons: [] });
    // safe-agent: 3 ops with scores 0.1, 0.2, 0.15 → avg 0.15
    await logger.log(makeOp('safe-agent', 'filesystem'), { action: 'allow', riskScore: 0.1, reasons: [] });
    await logger.log(makeOp('safe-agent', 'filesystem'), { action: 'allow', riskScore: 0.2, reasons: [] });
    await logger.log(makeOp('safe-agent', 'filesystem'), { action: 'allow', riskScore: 0.15, reasons: [] });

    const logs = await store.listOperationLogs(1000, 0);
    const result = aggregateLogs(logs);

    expect(result.topAgents[0].agent).toBe('risky-agent');
    expect(result.topAgents[0].avg).toBeCloseTo(0.7);
    expect(result.topAgents[0].cnt).toBe(2);
    expect(result.topAgents[1].agent).toBe('safe-agent');
    expect(result.topAgents[1].avg).toBeCloseTo(0.15);
    expect(result.topAgents[1].cnt).toBe(3);
  });

  it('filter by agentId only returns that agent operations', async () => {
    const { store, logger } = await makeStore();
    await logger.log(makeOp('agent-alpha', 'filesystem'), { action: 'allow', riskScore: 0.1, reasons: [] });
    await logger.log(makeOp('agent-alpha', 'filesystem'), { action: 'block', riskScore: 0.9, reasons: [] });
    await logger.log(makeOp('agent-beta', 'database'), { action: 'allow', riskScore: 0.3, reasons: [] });
    await logger.log(makeOp('agent-beta', 'database'), { action: 'allow', riskScore: 0.4, reasons: [] });
    await logger.log(makeOp('agent-beta', 'database'), { action: 'allow', riskScore: 0.5, reasons: [] });

    const logs = await store.listOperationLogs(1000, 0, { agentId: 'agent-alpha' });
    const result = aggregateLogs(logs);

    expect(result.total).toBe(2);
    expect(result.byAction.allow).toBe(1);
    expect(result.byAction.block).toBe(1);
    expect(result.topAgents.every(a => a.agent === 'agent-alpha')).toBe(true);
  });

  it('filter by tool only returns that tool operations', async () => {
    const { store, logger } = await makeStore();
    await logger.log(makeOp('agent-a', 'filesystem'), { action: 'allow', riskScore: 0.2, reasons: [] });
    await logger.log(makeOp('agent-a', 'filesystem'), { action: 'block', riskScore: 0.8, reasons: [] });
    await logger.log(makeOp('agent-a', 'database'), { action: 'allow', riskScore: 0.5, reasons: [] });
    await logger.log(makeOp('agent-b', 'shell'), { action: 'block', riskScore: 0.9, reasons: [] });

    const logs = await store.listOperationLogs(1000, 0, { tool: 'filesystem' });
    const result = aggregateLogs(logs);

    expect(result.total).toBe(2);
    expect(result.topTools.every(t => t.tool === 'filesystem')).toBe(true);
    expect(result.avgRisk).toBeCloseTo(0.5);
    expect(result.riskMax).toBeCloseTo(0.8);
  });

  it('top-10 cap: more than 10 tools only shows top 10 by count', async () => {
    const { store, logger } = await makeStore();
    // Create 12 distinct tools with varying counts (tool-01 has 12 ops, tool-12 has 1 op)
    for (let i = 1; i <= 12; i++) {
      const tool = `tool-${String(i).padStart(2, '0')}`;
      const count = 13 - i; // tool-01: 12 ops, tool-02: 11 ops ... tool-12: 1 op
      for (let j = 0; j < count; j++) {
        await logger.log(makeOp('agent-a', tool), { action: 'allow', riskScore: 0.1, reasons: [] });
      }
    }

    const logs = await store.listOperationLogs(1000, 0);
    const result = aggregateLogs(logs);

    expect(result.topTools.length).toBe(10);
    expect(result.topTools[0].tool).toBe('tool-01');
    expect(result.topTools[9].tool).toBe('tool-10');
  });
});

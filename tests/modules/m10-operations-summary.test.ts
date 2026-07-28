/**
 * T224 — GET /operations/summary endpoint
 * Ports 51700–51799
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import type { OperationLog } from '../../src/types/interfaces.js';

const PORT_BASE = 51700;
let portOffset = 0;

interface SummaryResponse {
  totalOps: number;
  byAction: { allow: number; block: number; require_approval: number };
  avgRiskScore: number;
  topAgents: Array<{ agentId: string; count: number }>;
  topTools: Array<{ tool: string; count: number }>;
}

async function startDash(): Promise<{ store: StateStore; dashboard: DashboardAPI; port: number }> {
  const store = new StateStore(':memory:');
  await store.initialize();
  const port = PORT_BASE + portOffset++;
  const dashboard = new DashboardAPI(store);
  await dashboard.start(port);
  return { store, dashboard, port };
}

async function getJson(port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function makeLog(opts: {
  agentId?: string;
  tool?: string;
  action?: 'allow' | 'block' | 'require_approval';
  riskScore?: number;
}): OperationLog {
  const id = randomUUID();
  return {
    operationId: id,
    operation: {
      id,
      agentId: opts.agentId ?? 'agent-default',
      tool: opts.tool ?? 'tool-default',
      method: 'call',
      params: {},
      timestamp: new Date(),
      sessionId: 'sess-1',
    },
    decision: {
      action: opts.action ?? 'allow',
      riskScore: opts.riskScore ?? 0,
      reasons: [],
    },
    createdAt: new Date(),
  };
}

describe('GET /operations/summary (T224)', () => {
  let store: StateStore;
  let dashboard: DashboardAPI;
  let port: number;

  beforeEach(async () => {
    ({ store, dashboard, port } = await startDash());
  });

  afterEach(async () => {
    await dashboard.stop();
    await store.close();
  });

  it('returns zero values on empty DB', async () => {
    const body = await getJson(port, '/operations/summary') as SummaryResponse;
    expect(body.totalOps).toBe(0);
    expect(body.avgRiskScore).toBe(0);
    expect(body.topAgents).toEqual([]);
    expect(body.topTools).toEqual([]);
    expect(body.byAction).toEqual({ allow: 0, block: 0, require_approval: 0 });
  });

  it('reports correct totalOps and byAction counts for mixed ops', async () => {
    await store.saveOperationLog(makeLog({ action: 'allow' }));
    await store.saveOperationLog(makeLog({ action: 'allow' }));
    await store.saveOperationLog(makeLog({ action: 'block' }));
    await store.saveOperationLog(makeLog({ action: 'require_approval' }));

    const body = await getJson(port, '/operations/summary') as SummaryResponse;
    expect(body.totalOps).toBe(4);
    expect(body.byAction.allow).toBe(2);
    expect(body.byAction.block).toBe(1);
    expect(body.byAction.require_approval).toBe(1);
  });

  it('computes avgRiskScore correctly', async () => {
    await store.saveOperationLog(makeLog({ riskScore: 0.2 }));
    await store.saveOperationLog(makeLog({ riskScore: 0.4 }));
    await store.saveOperationLog(makeLog({ riskScore: 0.6 }));

    const body = await getJson(port, '/operations/summary') as SummaryResponse;
    expect(body.totalOps).toBe(3);
    expect(body.avgRiskScore).toBeCloseTo(0.4, 5);
  });

  it('topAgents sorted by count descending, max 5 entries', async () => {
    // Insert 6 agents with decreasing counts
    const agents = ['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e', 'agent-f'];
    const counts = [10, 8, 6, 4, 2, 1];
    for (let i = 0; i < agents.length; i++) {
      for (let j = 0; j < counts[i]; j++) {
        await store.saveOperationLog(makeLog({ agentId: agents[i] }));
      }
    }

    const body = await getJson(port, '/operations/summary') as SummaryResponse;
    expect(body.topAgents.length).toBeLessThanOrEqual(5);
    // Sorted descending
    for (let i = 0; i < body.topAgents.length - 1; i++) {
      expect(body.topAgents[i].count).toBeGreaterThanOrEqual(body.topAgents[i + 1].count);
    }
    // agent-a should be first with highest count
    expect(body.topAgents[0].agentId).toBe('agent-a');
    expect(body.topAgents[0].count).toBe(10);
    // agent-f (count=1) should be excluded (only top 5)
    const agentIds = body.topAgents.map(a => a.agentId);
    expect(agentIds).not.toContain('agent-f');
  });

  it('topTools sorted by count descending, max 5 entries', async () => {
    // Insert 6 tools with different counts
    const tools = ['tool-a', 'tool-b', 'tool-c', 'tool-d', 'tool-e', 'tool-f'];
    const counts = [7, 5, 4, 3, 2, 1];
    for (let i = 0; i < tools.length; i++) {
      for (let j = 0; j < counts[i]; j++) {
        await store.saveOperationLog(makeLog({ tool: tools[i] }));
      }
    }

    const body = await getJson(port, '/operations/summary') as SummaryResponse;
    expect(body.topTools.length).toBeLessThanOrEqual(5);
    // Sorted descending
    for (let i = 0; i < body.topTools.length - 1; i++) {
      expect(body.topTools[i].count).toBeGreaterThanOrEqual(body.topTools[i + 1].count);
    }
    // tool-a should be first
    expect(body.topTools[0].tool).toBe('tool-a');
    expect(body.topTools[0].count).toBe(7);
    // tool-f (count=1) should be excluded
    const toolNames = body.topTools.map(t => t.tool);
    expect(toolNames).not.toContain('tool-f');
  });
});

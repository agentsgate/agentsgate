/**
 * T213 — Dashboard GET /agents endpoint.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

// Ports come from start(0). A hand-picked base sits inside the OS ephemeral
// range (49152-65535 on macOS), so any concurrent listen(0) can be handed the
// same number and this suite loses the race with EADDRINUSE.

// ── helpers ──────────────────────────────────────────────────────────────────

function makeOp(agentId: string, tool = 'fs'): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId,
    tool,
    method: 'call',
    params: {},
    timestamp: new Date(),
  };
}

function dec(
  action: ProxyDecision['action'] = 'allow',
  riskScore = 0.2
): ProxyDecision {
  return { action, riskScore, reasons: [] };
}

interface SetupResult {
  dash: DashboardAPI;
  port: number;
  store: StateStore;
  logger: OperationLogger;
  tmpDir: string;
}

async function setup(): Promise<SetupResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-agents-'));
  const store = new StateStore(path.join(tmpDir, 'test.db'));
  await store.initialize();
  const logger = new OperationLogger(store);
  const dash = new DashboardAPI(store, {});
  await dash.start(0);
  const port = dash.getPort();
  return { dash, port, store, logger, tmpDir };
}

async function getJSON(port: number, p: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, body: await res.json() };
}

async function teardown(ctx: SetupResult): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('DashboardAPI — GET /agents', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. empty DB returns { agents: [], count: 0 }', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as { agents: unknown[]; count: number };
    expect(b.agents).toEqual([]);
    expect(b.count).toBe(0);
  });

  it('2. single agent with one allow op — correct totalOps, byAction, avgRiskScore', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as {
      agents: Array<{
        agentId: string;
        totalOps: number;
        byAction: { allow: number; block: number; require_approval: number };
        avgRiskScore: number;
        maxRiskScore: number;
        lastSeen: string;
      }>;
      count: number;
    };
    expect(b.count).toBe(1);
    expect(b.agents).toHaveLength(1);

    const a = b.agents[0];
    expect(a.agentId).toBe('agent-a');
    expect(a.totalOps).toBe(1);
    expect(a.byAction.allow).toBe(1);
    expect(a.byAction.block).toBe(0);
    expect(a.byAction.require_approval).toBe(0);
    expect(a.avgRiskScore).toBeCloseTo(0.3, 5);
    expect(a.maxRiskScore).toBeCloseTo(0.3, 5);
  });

  it('3. single agent with mixed allow+block — correct counts and avgRiskScore', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-b', 'shell'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-b', 'db'), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-b', 'fs'), dec('require_approval', 0.5));

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as {
      agents: Array<{
        agentId: string;
        totalOps: number;
        byAction: { allow: number; block: number; require_approval: number };
        avgRiskScore: number;
        maxRiskScore: number;
      }>;
    };
    const a = b.agents.find(x => x.agentId === 'agent-b')!;
    expect(a).toBeDefined();
    expect(a.totalOps).toBe(3);
    expect(a.byAction.allow).toBe(1);
    expect(a.byAction.block).toBe(1);
    expect(a.byAction.require_approval).toBe(1);
    // avg = (0.2 + 0.8 + 0.5) / 3 = 0.5
    expect(a.avgRiskScore).toBeCloseTo(0.5, 5);
  });

  it('4. two agents — both appear, sorted by totalOps descending', async () => {
    ctx = await setup();
    // agent-x gets 3 ops, agent-y gets 1 op
    await ctx.logger.log(makeOp('agent-x', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-x', 'db'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-x', 'shell'), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-y', 'fs'), dec('allow', 0.4));

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as {
      agents: Array<{ agentId: string; totalOps: number }>;
      count: number;
    };
    expect(b.count).toBe(2);
    expect(b.agents).toHaveLength(2);
    // sorted descending by totalOps
    expect(b.agents[0].agentId).toBe('agent-x');
    expect(b.agents[0].totalOps).toBe(3);
    expect(b.agents[1].agentId).toBe('agent-y');
    expect(b.agents[1].totalOps).toBe(1);
  });

  it('5. maxRiskScore is the highest riskScore for that agent', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-c', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-c', 'db'), dec('block', 0.95));
    await ctx.logger.log(makeOp('agent-c', 'shell'), dec('allow', 0.4));

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as {
      agents: Array<{ agentId: string; maxRiskScore: number }>;
    };
    const a = b.agents.find(x => x.agentId === 'agent-c')!;
    expect(a).toBeDefined();
    expect(a.maxRiskScore).toBeCloseTo(0.95, 5);
  });

  it('6. lastSeen is the ISO timestamp of the most recent operation', async () => {
    ctx = await setup();
    const early = new Date('2026-01-01T00:00:00.000Z');
    const late  = new Date('2026-06-15T12:00:00.000Z');

    const opEarly = { ...makeOp('agent-d', 'fs'), timestamp: early };
    const opLate  = { ...makeOp('agent-d', 'db'), timestamp: late };

    await ctx.logger.log(opEarly, dec('allow', 0.1));
    await ctx.logger.log(opLate,  dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as {
      agents: Array<{ agentId: string; lastSeen: string }>;
    };
    const a = b.agents.find(x => x.agentId === 'agent-d')!;
    expect(a).toBeDefined();
    expect(a.lastSeen).toBe(late.toISOString());
  });
});

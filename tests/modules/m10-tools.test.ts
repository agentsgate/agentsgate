/**
 * T215 — Dashboard GET /tools endpoint.
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

function makeOp(agentId: string, tool: string): MCPOperation {
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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-tools-'));
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

describe('DashboardAPI — GET /tools', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. empty DB returns { tools: [], count: 0 }', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as { tools: unknown[]; count: number };
    expect(b.tools).toEqual([]);
    expect(b.count).toBe(0);
  });

  it('2. single tool, one allow op — correct totalOps, byAction, avgRiskScore, maxRiskScore', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as {
      tools: Array<{
        tool: string;
        totalOps: number;
        byAction: { allow: number; block: number; require_approval: number };
        avgRiskScore: number;
        maxRiskScore: number;
        topAgents: string[];
      }>;
      count: number;
    };
    expect(b.count).toBe(1);
    expect(b.tools).toHaveLength(1);

    const t = b.tools[0];
    expect(t.tool).toBe('fs');
    expect(t.totalOps).toBe(1);
    expect(t.byAction.allow).toBe(1);
    expect(t.byAction.block).toBe(0);
    expect(t.byAction.require_approval).toBe(0);
    expect(t.avgRiskScore).toBeCloseTo(0.3, 5);
    expect(t.maxRiskScore).toBeCloseTo(0.3, 5);
    expect(t.topAgents).toContain('agent-a');
  });

  it('3. single tool, mixed allow+block+require_approval — correct counts and avgRiskScore', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-b', 'shell'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-c', 'shell'), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-d', 'shell'), dec('require_approval', 0.5));

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as {
      tools: Array<{
        tool: string;
        totalOps: number;
        byAction: { allow: number; block: number; require_approval: number };
        avgRiskScore: number;
        maxRiskScore: number;
      }>;
    };
    const t = b.tools.find(x => x.tool === 'shell')!;
    expect(t).toBeDefined();
    expect(t.totalOps).toBe(3);
    expect(t.byAction.allow).toBe(1);
    expect(t.byAction.block).toBe(1);
    expect(t.byAction.require_approval).toBe(1);
    // avg = (0.2 + 0.8 + 0.5) / 3 = 0.5
    expect(t.avgRiskScore).toBeCloseTo(0.5, 5);
  });

  it('4. two tools — both appear, sorted by totalOps descending', async () => {
    ctx = await setup();
    // db-tool gets 3 ops, fs-tool gets 1 op
    await ctx.logger.log(makeOp('agent-x', 'db-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-x', 'db-tool'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-x', 'db-tool'), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-y', 'fs-tool'), dec('allow', 0.4));

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as {
      tools: Array<{ tool: string; totalOps: number }>;
      count: number;
    };
    expect(b.count).toBe(2);
    expect(b.tools).toHaveLength(2);
    // sorted descending by totalOps
    expect(b.tools[0].tool).toBe('db-tool');
    expect(b.tools[0].totalOps).toBe(3);
    expect(b.tools[1].tool).toBe('fs-tool');
    expect(b.tools[1].totalOps).toBe(1);
  });

  it('5. topAgents — tool used by 3 agents with different counts — topAgents in correct order', async () => {
    ctx = await setup();
    // agent-high: 4 ops, agent-mid: 2 ops, agent-low: 1 op — all on same tool
    await ctx.logger.log(makeOp('agent-high', 'net-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-high', 'net-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-high', 'net-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-high', 'net-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-mid',  'net-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-mid',  'net-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-low',  'net-tool'), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as {
      tools: Array<{ tool: string; topAgents: string[] }>;
    };
    const t = b.tools.find(x => x.tool === 'net-tool')!;
    expect(t).toBeDefined();
    expect(t.topAgents).toHaveLength(3);
    // sorted by op count desc
    expect(t.topAgents[0]).toBe('agent-high');
    expect(t.topAgents[1]).toBe('agent-mid');
    expect(t.topAgents[2]).toBe('agent-low');
  });

  it('6. maxRiskScore is the highest riskScore across ops for that tool', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-c', 'risk-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-c', 'risk-tool'), dec('block', 0.95));
    await ctx.logger.log(makeOp('agent-c', 'risk-tool'), dec('allow', 0.4));

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as {
      tools: Array<{ tool: string; maxRiskScore: number }>;
    };
    const t = b.tools.find(x => x.tool === 'risk-tool')!;
    expect(t).toBeDefined();
    expect(t.maxRiskScore).toBeCloseTo(0.95, 5);
  });

  it('7. tool used by 4 agents — topAgents has exactly 3 entries', async () => {
    ctx = await setup();
    // 4 distinct agents using the same tool
    await ctx.logger.log(makeOp('agent-1', 'multi-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-1', 'multi-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-1', 'multi-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-2', 'multi-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-2', 'multi-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-3', 'multi-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-4', 'multi-tool'), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as {
      tools: Array<{ tool: string; topAgents: string[] }>;
    };
    const t = b.tools.find(x => x.tool === 'multi-tool')!;
    expect(t).toBeDefined();
    // must cap at 3 even though 4 agents used this tool
    expect(t.topAgents).toHaveLength(3);
    // top 3 should be agent-1, agent-2, agent-3 (agent-4 tied with agent-3 at 1, order may vary)
    expect(t.topAgents).toContain('agent-1');
    expect(t.topAgents).toContain('agent-2');
  });
});

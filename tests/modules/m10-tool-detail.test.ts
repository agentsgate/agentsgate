/**
 * T231 — Dashboard GET /tools/:tool endpoint.
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

function makeOp(agentId: string, tool: string, method = 'call'): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId,
    tool,
    method,
    params: {},
    timestamp: new Date(),
    sessionId: 'session-1',
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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-tooldetail-'));
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

describe('DashboardAPI — GET /tools/:tool', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. unknown tool returns 404', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/tools/nonexistent-tool');
    expect(status).toBe(404);
    const b = body as { error: string };
    expect(b.error).toMatch(/nonexistent-tool/);
  });

  it('2. single op — correct tool, totalOps, byAction, avgRiskScore, maxRiskScore', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'detail-fs'), dec('allow', 0.35));

    const { status, body } = await getJSON(ctx.port, '/tools/detail-fs');
    expect(status).toBe(200);

    const b = body as {
      tool: string;
      totalOps: number;
      byAction: { allow: number; block: number; require_approval: number };
      avgRiskScore: number;
      maxRiskScore: number;
      topAgents: Array<{ agentId: string; count: number }>;
    };

    expect(b.tool).toBe('detail-fs');
    expect(b.totalOps).toBe(1);
    expect(b.byAction.allow).toBe(1);
    expect(b.byAction.block).toBe(0);
    expect(b.byAction.require_approval).toBe(0);
    expect(b.avgRiskScore).toBeCloseTo(0.35, 5);
    expect(b.maxRiskScore).toBeCloseTo(0.35, 5);
    expect(b.topAgents).toHaveLength(1);
    expect(b.topAgents[0].agentId).toBe('agent-a');
    expect(b.topAgents[0].count).toBe(1);
  });

  it('3. multiple agents — topAgents sorted descending by count', async () => {
    ctx = await setup();
    // agent-high: 4 ops, agent-mid: 2 ops, agent-low: 1 op — all on same tool
    await ctx.logger.log(makeOp('agent-high', 'rank-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-high', 'rank-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-high', 'rank-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-high', 'rank-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-mid', 'rank-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-mid', 'rank-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-low', 'rank-tool'), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, '/tools/rank-tool');
    expect(status).toBe(200);

    const b = body as {
      tool: string;
      totalOps: number;
      topAgents: Array<{ agentId: string; count: number }>;
    };

    expect(b.totalOps).toBe(7);
    expect(b.topAgents.length).toBeGreaterThanOrEqual(3);
    expect(b.topAgents[0].agentId).toBe('agent-high');
    expect(b.topAgents[0].count).toBe(4);
    expect(b.topAgents[1].agentId).toBe('agent-mid');
    expect(b.topAgents[1].count).toBe(2);
    expect(b.topAgents[2].agentId).toBe('agent-low');
    expect(b.topAgents[2].count).toBe(1);
  });

  it('4. maxRiskScore is the highest riskScore across all ops for that tool', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-x', 'maxrisk-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-x', 'maxrisk-tool'), dec('block', 0.92));
    await ctx.logger.log(makeOp('agent-x', 'maxrisk-tool'), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/tools/maxrisk-tool');
    expect(status).toBe(200);

    const b = body as {
      tool: string;
      totalOps: number;
      avgRiskScore: number;
      maxRiskScore: number;
    };

    expect(b.totalOps).toBe(3);
    // avg = (0.1 + 0.92 + 0.3) / 3 ≈ 0.44
    expect(b.avgRiskScore).toBeCloseTo((0.1 + 0.92 + 0.3) / 3, 5);
    expect(b.maxRiskScore).toBeCloseTo(0.92, 5);
  });
});

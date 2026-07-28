/**
 * T230 — Dashboard GET /agents/:agentId endpoint.
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

function makeOp(agentId: string, tool = 'fs', method = 'call'): MCPOperation {
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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-agentdetail-'));
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

describe('DashboardAPI — GET /agents/:agentId', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. unknown agentId returns 404', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/agents/nonexistent-agent');
    expect(status).toBe(404);
    const b = body as { error: string };
    expect(b.error).toMatch(/nonexistent-agent/);
  });

  it('2. single op — correct totalOps, byAction, avgRiskScore, maxRiskScore, lastSeen', async () => {
    ctx = await setup();
    const ts = new Date('2026-03-01T10:00:00.000Z');
    const op = { ...makeOp('agent-detail-a', 'fs'), timestamp: ts };
    await ctx.logger.log(op, dec('allow', 0.4));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-detail-a');
    expect(status).toBe(200);

    const b = body as {
      agentId: string;
      totalOps: number;
      byAction: { allow: number; block: number; require_approval: number };
      avgRiskScore: number;
      maxRiskScore: number;
      lastSeen: string;
      topTools: Array<{ tool: string; count: number }>;
      recentOps: Array<{
        operationId: string;
        tool: string;
        method: string;
        action: string;
        riskScore: number;
        timestamp: string;
      }>;
    };

    expect(b.agentId).toBe('agent-detail-a');
    expect(b.totalOps).toBe(1);
    expect(b.byAction.allow).toBe(1);
    expect(b.byAction.block).toBe(0);
    expect(b.byAction.require_approval).toBe(0);
    expect(b.avgRiskScore).toBeCloseTo(0.4, 5);
    expect(b.maxRiskScore).toBeCloseTo(0.4, 5);
    expect(b.lastSeen).toBe(ts.toISOString());
  });

  it('3. multiple ops with different tools — topTools has correct descending order', async () => {
    ctx = await setup();
    // 'db' tool used 3 times, 'fs' used 2 times, 'shell' used 1 time
    await ctx.logger.log(makeOp('agent-toptools', 'db'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-toptools', 'db'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-toptools', 'db'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-toptools', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-toptools', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-toptools', 'shell'), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-toptools');
    expect(status).toBe(200);

    const b = body as {
      topTools: Array<{ tool: string; count: number }>;
    };

    expect(b.topTools.length).toBeGreaterThanOrEqual(3);
    expect(b.topTools[0].tool).toBe('db');
    expect(b.topTools[0].count).toBe(3);
    expect(b.topTools[1].tool).toBe('fs');
    expect(b.topTools[1].count).toBe(2);
    expect(b.topTools[2].tool).toBe('shell');
    expect(b.topTools[2].count).toBe(1);
  });

  it('4. recentOps has up to 10 entries when 12 ops are inserted', async () => {
    ctx = await setup();
    for (let i = 0; i < 12; i++) {
      await ctx.logger.log(makeOp('agent-recent', 'fs'), dec('allow', 0.1));
    }

    const { status, body } = await getJSON(ctx.port, '/agents/agent-recent');
    expect(status).toBe(200);

    const b = body as {
      totalOps: number;
      recentOps: Array<{ operationId: string }>;
    };

    expect(b.totalOps).toBe(12);
    expect(b.recentOps).toHaveLength(10);
  });

  it('5. avgRiskScore is computed correctly across multiple ops', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-avg', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-avg', 'db'), dec('block', 0.6));
    await ctx.logger.log(makeOp('agent-avg', 'shell'), dec('allow', 0.4));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-avg');
    expect(status).toBe(200);

    const b = body as {
      totalOps: number;
      avgRiskScore: number;
      maxRiskScore: number;
    };

    expect(b.totalOps).toBe(3);
    // avg = (0.2 + 0.6 + 0.4) / 3 = 0.4
    expect(b.avgRiskScore).toBeCloseTo(0.4, 5);
    expect(b.maxRiskScore).toBeCloseTo(0.6, 5);
  });
});

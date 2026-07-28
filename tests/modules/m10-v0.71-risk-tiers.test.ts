/**
 * v0.71 — T469/T470/T471/T472/T473: Risk tier counts on detail endpoints
 *
 * Tests that GET /agents/:agentId, GET /tools/:tool, and GET /sessions/:sessionId
 * all return highRiskCount, mediumRiskCount, and lowRiskCount.
 *
 * Tier boundaries (inclusive lower bound):
 *   high   : riskScore >= 0.7
 *   medium : 0.3 <= riskScore < 0.7
 *   low    : riskScore < 0.3
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeOp(overrides: Partial<MCPOperation> = {}): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId: 'agent-default',
    tool: 'tool-default',
    method: 'call',
    params: {},
    timestamp: new Date(),
    sessionId: 'sess-default',
    ...overrides,
  };
}

function dec(riskScore: number, action: ProxyDecision['action'] = 'allow'): ProxyDecision {
  return { action, riskScore, reasons: [] };
}

interface Ctx {
  store: StateStore;
  logger: OperationLogger;
  dash: DashboardAPI;
  port: number;
}

async function setup(): Promise<Ctx> {
  const store = new StateStore(':memory:');
  await store.initialize();
  const logger = new OperationLogger(store);
  const dash = new DashboardAPI(store, {});
  await dash.start(0);
  const port = (
    (dash as unknown as { server: http.Server }).server.address() as { port: number }
  ).port;
  return { store, logger, dash, port };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
}

async function getJSON(
  port: number,
  path: string
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

// ── GET /agents/:agentId — risk tier counts ───────────────────────────────────

describe('GET /agents/:agentId — highRiskCount, mediumRiskCount, lowRiskCount (T469/T470)', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  /**
   * Seeds 3 ops for the agent:
   *   1 high   (0.8, >= 0.7)
   *   1 medium (0.5, >= 0.3 and < 0.7)
   *   1 low    (0.1, < 0.3)
   */
  async function seedAgentOps(agentId: string): Promise<void> {
    await ctx.logger.log(makeOp({ id: crypto.randomUUID(), agentId }), dec(0.8));
    await ctx.logger.log(makeOp({ id: crypto.randomUUID(), agentId }), dec(0.5));
    await ctx.logger.log(makeOp({ id: crypto.randomUUID(), agentId }), dec(0.1));
  }

  it('1. highRiskCount, mediumRiskCount, lowRiskCount are all present', async () => {
    ctx = await setup();
    const agentId = 'agent-tier-fields';
    await seedAgentOps(agentId);

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['highRiskCount']).toBeDefined();
    expect(b['mediumRiskCount']).toBeDefined();
    expect(b['lowRiskCount']).toBeDefined();
  });

  it('2. all three counts are number types', async () => {
    ctx = await setup();
    const agentId = 'agent-tier-types';
    await seedAgentOps(agentId);

    const { body } = await getJSON(ctx.port, `/agents/${agentId}`);
    const b = body as Record<string, unknown>;
    expect(typeof b['highRiskCount']).toBe('number');
    expect(typeof b['mediumRiskCount']).toBe('number');
    expect(typeof b['lowRiskCount']).toBe('number');
  });

  it('3. highRiskCount === 1, mediumRiskCount === 1, lowRiskCount === 1 for scores 0.8, 0.5, 0.1', async () => {
    ctx = await setup();
    const agentId = 'agent-tier-values';
    await seedAgentOps(agentId);

    const { body } = await getJSON(ctx.port, `/agents/${agentId}`);
    const b = body as { highRiskCount: number; mediumRiskCount: number; lowRiskCount: number };
    expect(b.highRiskCount).toBe(1);
    expect(b.mediumRiskCount).toBe(1);
    expect(b.lowRiskCount).toBe(1);
  });

  it('4. sum of all three counts equals totalOps', async () => {
    ctx = await setup();
    const agentId = 'agent-tier-sum';
    await seedAgentOps(agentId);

    const { body } = await getJSON(ctx.port, `/agents/${agentId}`);
    const b = body as {
      highRiskCount: number;
      mediumRiskCount: number;
      lowRiskCount: number;
      totalOps: number;
    };
    expect(b.highRiskCount + b.mediumRiskCount + b.lowRiskCount).toBe(b.totalOps);
  });

  it('5. boundary: riskScore === 0.7 counts as highRiskCount (not medium)', async () => {
    ctx = await setup();
    const agentId = 'agent-tier-boundary-high';
    await ctx.logger.log(makeOp({ id: crypto.randomUUID(), agentId }), dec(0.7));

    const { body } = await getJSON(ctx.port, `/agents/${agentId}`);
    const b = body as { highRiskCount: number; mediumRiskCount: number; lowRiskCount: number };
    expect(b.highRiskCount).toBe(1);
    expect(b.mediumRiskCount).toBe(0);
    expect(b.lowRiskCount).toBe(0);
  });

  it('6. boundary: riskScore === 0.3 counts as mediumRiskCount (not low)', async () => {
    ctx = await setup();
    const agentId = 'agent-tier-boundary-medium';
    await ctx.logger.log(makeOp({ id: crypto.randomUUID(), agentId }), dec(0.3));

    const { body } = await getJSON(ctx.port, `/agents/${agentId}`);
    const b = body as { highRiskCount: number; mediumRiskCount: number; lowRiskCount: number };
    expect(b.highRiskCount).toBe(0);
    expect(b.mediumRiskCount).toBe(1);
    expect(b.lowRiskCount).toBe(0);
  });

  it('7. sum === totalOps holds with multiple ops of mixed tiers', async () => {
    ctx = await setup();
    const agentId = 'agent-tier-multi';
    // 2 high, 3 medium, 2 low = 7 total
    const scores = [0.8, 0.9, 0.5, 0.4, 0.6, 0.1, 0.2];
    for (const score of scores) {
      await ctx.logger.log(makeOp({ id: crypto.randomUUID(), agentId }), dec(score));
    }

    const { body } = await getJSON(ctx.port, `/agents/${agentId}`);
    const b = body as {
      highRiskCount: number;
      mediumRiskCount: number;
      lowRiskCount: number;
      totalOps: number;
    };
    expect(b.highRiskCount).toBe(2);
    expect(b.mediumRiskCount).toBe(3);
    expect(b.lowRiskCount).toBe(2);
    expect(b.highRiskCount + b.mediumRiskCount + b.lowRiskCount).toBe(b.totalOps);
    expect(b.totalOps).toBe(7);
  });
});

// ── GET /tools/:tool — risk tier counts ───────────────────────────────────────

describe('GET /tools/:tool — highRiskCount, mediumRiskCount, lowRiskCount (T471/T472)', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  /**
   * Seeds 3 ops for the tool:
   *   1 high   (0.8)
   *   1 medium (0.5)
   *   1 low    (0.1)
   */
  async function seedToolOps(tool: string): Promise<void> {
    await ctx.logger.log(makeOp({ id: crypto.randomUUID(), tool }), dec(0.8));
    await ctx.logger.log(makeOp({ id: crypto.randomUUID(), tool }), dec(0.5));
    await ctx.logger.log(makeOp({ id: crypto.randomUUID(), tool }), dec(0.1));
  }

  it('8. highRiskCount, mediumRiskCount, lowRiskCount are all present', async () => {
    ctx = await setup();
    const tool = 'tool-tier-fields';
    await seedToolOps(tool);

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['highRiskCount']).toBeDefined();
    expect(b['mediumRiskCount']).toBeDefined();
    expect(b['lowRiskCount']).toBeDefined();
  });

  it('9. all three counts are number types', async () => {
    ctx = await setup();
    const tool = 'tool-tier-types';
    await seedToolOps(tool);

    const { body } = await getJSON(ctx.port, `/tools/${tool}`);
    const b = body as Record<string, unknown>;
    expect(typeof b['highRiskCount']).toBe('number');
    expect(typeof b['mediumRiskCount']).toBe('number');
    expect(typeof b['lowRiskCount']).toBe('number');
  });

  it('10. highRiskCount === 1, mediumRiskCount === 1, lowRiskCount === 1 for scores 0.8, 0.5, 0.1', async () => {
    ctx = await setup();
    const tool = 'tool-tier-values';
    await seedToolOps(tool);

    const { body } = await getJSON(ctx.port, `/tools/${tool}`);
    const b = body as { highRiskCount: number; mediumRiskCount: number; lowRiskCount: number };
    expect(b.highRiskCount).toBe(1);
    expect(b.mediumRiskCount).toBe(1);
    expect(b.lowRiskCount).toBe(1);
  });

  it('11. sum of all three counts equals totalOps', async () => {
    ctx = await setup();
    const tool = 'tool-tier-sum';
    await seedToolOps(tool);

    const { body } = await getJSON(ctx.port, `/tools/${tool}`);
    const b = body as {
      highRiskCount: number;
      mediumRiskCount: number;
      lowRiskCount: number;
      totalOps: number;
    };
    expect(b.highRiskCount + b.mediumRiskCount + b.lowRiskCount).toBe(b.totalOps);
  });

  it('12. boundary: riskScore === 0.7 counts as highRiskCount (not medium)', async () => {
    ctx = await setup();
    const tool = 'tool-boundary-high';
    await ctx.logger.log(makeOp({ id: crypto.randomUUID(), tool }), dec(0.7));

    const { body } = await getJSON(ctx.port, `/tools/${tool}`);
    const b = body as { highRiskCount: number; mediumRiskCount: number; lowRiskCount: number };
    expect(b.highRiskCount).toBe(1);
    expect(b.mediumRiskCount).toBe(0);
    expect(b.lowRiskCount).toBe(0);
  });

  it('13. boundary: riskScore === 0.3 counts as mediumRiskCount (not low)', async () => {
    ctx = await setup();
    const tool = 'tool-boundary-medium';
    await ctx.logger.log(makeOp({ id: crypto.randomUUID(), tool }), dec(0.3));

    const { body } = await getJSON(ctx.port, `/tools/${tool}`);
    const b = body as { highRiskCount: number; mediumRiskCount: number; lowRiskCount: number };
    expect(b.highRiskCount).toBe(0);
    expect(b.mediumRiskCount).toBe(1);
    expect(b.lowRiskCount).toBe(0);
  });

  it('14. sum === totalOps holds with multiple ops of mixed tiers', async () => {
    ctx = await setup();
    const tool = 'tool-tier-multi';
    // 2 high, 3 medium, 2 low = 7 total
    const scores = [0.8, 0.9, 0.5, 0.4, 0.6, 0.1, 0.2];
    for (const score of scores) {
      await ctx.logger.log(makeOp({ id: crypto.randomUUID(), tool }), dec(score));
    }

    const { body } = await getJSON(ctx.port, `/tools/${tool}`);
    const b = body as {
      highRiskCount: number;
      mediumRiskCount: number;
      lowRiskCount: number;
      totalOps: number;
    };
    expect(b.highRiskCount).toBe(2);
    expect(b.mediumRiskCount).toBe(3);
    expect(b.lowRiskCount).toBe(2);
    expect(b.highRiskCount + b.mediumRiskCount + b.lowRiskCount).toBe(b.totalOps);
    expect(b.totalOps).toBe(7);
  });
});

// ── GET /sessions/:sessionId — risk tier counts ───────────────────────────────

describe('GET /sessions/:sessionId — highRiskCount, mediumRiskCount, lowRiskCount (T473)', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  /**
   * Seeds 3 ops for the session:
   *   1 high   (0.8)
   *   1 medium (0.5)
   *   1 low    (0.1)
   */
  async function seedSessionOps(sessionId: string): Promise<void> {
    await ctx.logger.log(makeOp({ id: crypto.randomUUID(), sessionId }), dec(0.8));
    await ctx.logger.log(makeOp({ id: crypto.randomUUID(), sessionId }), dec(0.5));
    await ctx.logger.log(makeOp({ id: crypto.randomUUID(), sessionId }), dec(0.1));
  }

  it('15. highRiskCount, mediumRiskCount, lowRiskCount are all present', async () => {
    ctx = await setup();
    const sessionId = 'sess-tier-fields';
    await seedSessionOps(sessionId);

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['highRiskCount']).toBeDefined();
    expect(b['mediumRiskCount']).toBeDefined();
    expect(b['lowRiskCount']).toBeDefined();
  });

  it('16. all three counts are number types', async () => {
    ctx = await setup();
    const sessionId = 'sess-tier-types';
    await seedSessionOps(sessionId);

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as Record<string, unknown>;
    expect(typeof b['highRiskCount']).toBe('number');
    expect(typeof b['mediumRiskCount']).toBe('number');
    expect(typeof b['lowRiskCount']).toBe('number');
  });

  it('17. highRiskCount === 1, mediumRiskCount === 1, lowRiskCount === 1 for scores 0.8, 0.5, 0.1', async () => {
    ctx = await setup();
    const sessionId = 'sess-tier-values';
    await seedSessionOps(sessionId);

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as { highRiskCount: number; mediumRiskCount: number; lowRiskCount: number };
    expect(b.highRiskCount).toBe(1);
    expect(b.mediumRiskCount).toBe(1);
    expect(b.lowRiskCount).toBe(1);
  });

  it('18. sum of all three counts equals totalOps', async () => {
    ctx = await setup();
    const sessionId = 'sess-tier-sum';
    await seedSessionOps(sessionId);

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as {
      highRiskCount: number;
      mediumRiskCount: number;
      lowRiskCount: number;
      totalOps: number;
    };
    expect(b.highRiskCount + b.mediumRiskCount + b.lowRiskCount).toBe(b.totalOps);
  });

  it('19. boundary: riskScore === 0.7 counts as highRiskCount (not medium)', async () => {
    ctx = await setup();
    const sessionId = 'sess-boundary-high';
    await ctx.logger.log(makeOp({ id: crypto.randomUUID(), sessionId }), dec(0.7));

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as { highRiskCount: number; mediumRiskCount: number; lowRiskCount: number };
    expect(b.highRiskCount).toBe(1);
    expect(b.mediumRiskCount).toBe(0);
    expect(b.lowRiskCount).toBe(0);
  });

  it('20. boundary: riskScore === 0.3 counts as mediumRiskCount (not low)', async () => {
    ctx = await setup();
    const sessionId = 'sess-boundary-medium';
    await ctx.logger.log(makeOp({ id: crypto.randomUUID(), sessionId }), dec(0.3));

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as { highRiskCount: number; mediumRiskCount: number; lowRiskCount: number };
    expect(b.highRiskCount).toBe(0);
    expect(b.mediumRiskCount).toBe(1);
    expect(b.lowRiskCount).toBe(0);
  });

  it('21. sum === totalOps holds with multiple ops of mixed tiers', async () => {
    ctx = await setup();
    const sessionId = 'sess-tier-multi';
    // 2 high, 3 medium, 2 low = 7 total
    const scores = [0.8, 0.9, 0.5, 0.4, 0.6, 0.1, 0.2];
    for (const score of scores) {
      await ctx.logger.log(makeOp({ id: crypto.randomUUID(), sessionId }), dec(score));
    }

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as {
      highRiskCount: number;
      mediumRiskCount: number;
      lowRiskCount: number;
      totalOps: number;
    };
    expect(b.highRiskCount).toBe(2);
    expect(b.mediumRiskCount).toBe(3);
    expect(b.lowRiskCount).toBe(2);
    expect(b.highRiskCount + b.mediumRiskCount + b.lowRiskCount).toBe(b.totalOps);
    expect(b.totalOps).toBe(7);
  });
});

/**
 * v0.46 tests
 *
 * T345 — GET /telemetry/agents?limit=N&offset=M: pagination (count, limit, offset)
 * T346 — GET /telemetry/tools?limit=N&offset=M: pagination (count, limit, offset)
 * T344 — GET /agents?minAvgRiskScore=N and ?maxAvgRiskScore=N: filter by avgRiskScore
 * T347 — GET /operations/summary includes totalBlocked and totalAllowed matching byAction fields
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeOp(
  agentId: string,
  tool: string,
  overrides: Partial<MCPOperation> = {}
): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId,
    tool,
    method: 'call',
    params: {},
    timestamp: new Date(),
    sessionId: 'sess-1',
    ...overrides,
  };
}

function dec(
  action: ProxyDecision['action'] = 'allow',
  riskScore = 0.2
): ProxyDecision {
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
  const port = ((dash as unknown as { server: http.Server }).server.address() as { port: number }).port;
  return { store, logger, dash, port };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
}

async function getJSON(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

// ── T345 — GET /telemetry/agents?limit=N&offset=M ────────────────────────────

describe('GET /telemetry/agents pagination (T345)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. limit=1&offset=0 returns 1 agent with correct count/limit/offset fields', async () => {
    ctx = await setup();
    // 3 distinct agents
    await ctx.logger.log(makeOp('agent-alpha', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-beta', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-gamma', 'fs'), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/telemetry/agents?limit=1&offset=0');
    expect(status).toBe(200);
    const b = body as { agents: Array<unknown>; count: number; limit: number; offset: number };
    expect(b.agents).toHaveLength(1);
    expect(b.count).toBe(3);
    expect(b.limit).toBe(1);
    expect(b.offset).toBe(0);
  });

  it('2. offset=1 returns the second agent from the full list', async () => {
    ctx = await setup();
    // 2 distinct agents
    await ctx.logger.log(makeOp('agent-first', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-second', 'fs'), dec('allow', 0.2));

    const allRes = await getJSON(ctx.port, '/telemetry/agents?limit=10&offset=0');
    const allB = allRes.body as { agents: Array<{ agentId: string }> };
    expect(allB.agents).toHaveLength(2);
    const secondAgentId = allB.agents[1]!.agentId;

    const { body } = await getJSON(ctx.port, '/telemetry/agents?limit=1&offset=1');
    const b = body as { agents: Array<{ agentId: string }>; count: number; limit: number; offset: number };
    expect(b.agents).toHaveLength(1);
    expect(b.agents[0]!.agentId).toBe(secondAgentId);
    expect(b.count).toBe(2);
    expect(b.limit).toBe(1);
    expect(b.offset).toBe(1);
  });

  it('3. count reflects total agents regardless of limit/offset', async () => {
    ctx = await setup();
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) {
      await ctx.logger.log(makeOp(id, 'fs'), dec('allow', 0.1));
    }

    const { body } = await getJSON(ctx.port, '/telemetry/agents?limit=2&offset=3');
    const b = body as { agents: Array<unknown>; count: number; limit: number; offset: number };
    expect(b.count).toBe(5);
    expect(b.agents).toHaveLength(2); // items 4 and 5
    expect(b.limit).toBe(2);
    expect(b.offset).toBe(3);
  });

  it('4. offset beyond total returns empty agents array with correct count', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-only', 'fs'), dec('allow', 0.1));

    const { body } = await getJSON(ctx.port, '/telemetry/agents?limit=10&offset=100');
    const b = body as { agents: Array<unknown>; count: number; offset: number };
    expect(b.agents).toHaveLength(0);
    expect(b.count).toBe(1);
    expect(b.offset).toBe(100);
  });

  it('5. limit=1&offset=0 and limit=1&offset=1 return different agents (no overlap)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-x', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-y', 'fs'), dec('allow', 0.2));

    const page1 = await getJSON(ctx.port, '/telemetry/agents?limit=1&offset=0');
    const page2 = await getJSON(ctx.port, '/telemetry/agents?limit=1&offset=1');
    const b1 = page1.body as { agents: Array<{ agentId: string }> };
    const b2 = page2.body as { agents: Array<{ agentId: string }> };
    expect(b1.agents).toHaveLength(1);
    expect(b2.agents).toHaveLength(1);
    expect(b1.agents[0]!.agentId).not.toBe(b2.agents[0]!.agentId);
  });
});

// ── T346 — GET /telemetry/tools?limit=N&offset=M ─────────────────────────────

describe('GET /telemetry/tools pagination (T346)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('6. limit=1&offset=0 returns 1 tool with correct count/limit/offset fields', async () => {
    ctx = await setup();
    // 3 distinct tools
    await ctx.logger.log(makeOp('agent-a', 'tool-one'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-two'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'tool-three'), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/telemetry/tools?limit=1&offset=0');
    expect(status).toBe(200);
    const b = body as { tools: Array<unknown>; count: number; limit: number; offset: number };
    expect(b.tools).toHaveLength(1);
    expect(b.count).toBe(3);
    expect(b.limit).toBe(1);
    expect(b.offset).toBe(0);
  });

  it('7. offset=1 returns the second tool from the full list', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-first'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-second'), dec('allow', 0.2));

    const allRes = await getJSON(ctx.port, '/telemetry/tools?limit=10&offset=0');
    const allB = allRes.body as { tools: Array<{ tool: string }> };
    expect(allB.tools).toHaveLength(2);
    const secondToolName = allB.tools[1]!.tool;

    const { body } = await getJSON(ctx.port, '/telemetry/tools?limit=1&offset=1');
    const b = body as { tools: Array<{ tool: string }>; count: number; limit: number; offset: number };
    expect(b.tools).toHaveLength(1);
    expect(b.tools[0]!.tool).toBe(secondToolName);
    expect(b.count).toBe(2);
    expect(b.limit).toBe(1);
    expect(b.offset).toBe(1);
  });

  it('8. count reflects total tools regardless of limit/offset', async () => {
    ctx = await setup();
    for (const t of ['t1', 't2', 't3', 't4', 't5']) {
      await ctx.logger.log(makeOp('agent-a', t), dec('allow', 0.1));
    }

    const { body } = await getJSON(ctx.port, '/telemetry/tools?limit=2&offset=3');
    const b = body as { tools: Array<unknown>; count: number; limit: number; offset: number };
    expect(b.count).toBe(5);
    expect(b.tools).toHaveLength(2);
    expect(b.limit).toBe(2);
    expect(b.offset).toBe(3);
  });

  it('9. offset beyond total returns empty tools array with correct count', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-only'), dec('allow', 0.1));

    const { body } = await getJSON(ctx.port, '/telemetry/tools?limit=10&offset=100');
    const b = body as { tools: Array<unknown>; count: number; offset: number };
    expect(b.tools).toHaveLength(0);
    expect(b.count).toBe(1);
    expect(b.offset).toBe(100);
  });

  it('10. limit=1&offset=0 and limit=1&offset=1 return different tools (no overlap)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-alpha'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-beta'), dec('allow', 0.2));

    const page1 = await getJSON(ctx.port, '/telemetry/tools?limit=1&offset=0');
    const page2 = await getJSON(ctx.port, '/telemetry/tools?limit=1&offset=1');
    const b1 = page1.body as { tools: Array<{ tool: string }> };
    const b2 = page2.body as { tools: Array<{ tool: string }> };
    expect(b1.tools).toHaveLength(1);
    expect(b2.tools).toHaveLength(1);
    expect(b1.tools[0]!.tool).not.toBe(b2.tools[0]!.tool);
  });
});

// ── T344 — GET /agents?minAvgRiskScore=N and ?maxAvgRiskScore=N ───────────────

describe('GET /agents avgRiskScore filter (T344)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('11. minAvgRiskScore=0.5 returns only agents with avgRiskScore >= 0.5', async () => {
    ctx = await setup();
    // agent-low: single op with riskScore=0.2 => avgRiskScore=0.2
    await ctx.logger.log(makeOp('agent-low', 'fs'), dec('allow', 0.2));
    // agent-high: single op with riskScore=0.8 => avgRiskScore=0.8
    await ctx.logger.log(makeOp('agent-high', 'fs'), dec('block', 0.8));
    // agent-exact: single op with riskScore=0.5 => avgRiskScore=0.5 (boundary)
    await ctx.logger.log(makeOp('agent-exact', 'fs'), dec('allow', 0.5));

    const { status, body } = await getJSON(ctx.port, '/agents?minAvgRiskScore=0.5');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; avgRiskScore: number }>; count: number };
    expect(b.agents.every(a => a.avgRiskScore >= 0.5)).toBe(true);
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-high');
    expect(ids).toContain('agent-exact');
    expect(ids).not.toContain('agent-low');
  });

  it('12. minAvgRiskScore=0.5 with multi-op agents uses the true average', async () => {
    ctx = await setup();
    // agent-mixed: 2 ops at 0.3 and 0.5 => avg=0.4 => should be excluded at minAvgRiskScore=0.5
    await ctx.logger.log(makeOp('agent-mixed', 'fs', { id: crypto.randomUUID() }), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-mixed', 'db', { id: crypto.randomUUID() }), dec('allow', 0.5));
    // agent-above: 2 ops at 0.6 and 0.8 => avg=0.7 => should be included
    await ctx.logger.log(makeOp('agent-above', 'fs', { id: crypto.randomUUID() }), dec('allow', 0.6));
    await ctx.logger.log(makeOp('agent-above', 'db', { id: crypto.randomUUID() }), dec('block', 0.8));

    const { body } = await getJSON(ctx.port, '/agents?minAvgRiskScore=0.5');
    const b = body as { agents: Array<{ agentId: string; avgRiskScore: number }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-above');
    expect(ids).not.toContain('agent-mixed');
  });

  it('13. maxAvgRiskScore=0.3 returns only agents with avgRiskScore <= 0.3', async () => {
    ctx = await setup();
    // agent-safe: riskScore=0.1 => avgRiskScore=0.1
    await ctx.logger.log(makeOp('agent-safe', 'fs'), dec('allow', 0.1));
    // agent-risky: riskScore=0.9 => avgRiskScore=0.9
    await ctx.logger.log(makeOp('agent-risky', 'fs'), dec('block', 0.9));
    // agent-border: riskScore=0.3 => avgRiskScore=0.3 (on boundary)
    await ctx.logger.log(makeOp('agent-border', 'fs'), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/agents?maxAvgRiskScore=0.3');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; avgRiskScore: number }>; count: number };
    expect(b.agents.every(a => a.avgRiskScore <= 0.3)).toBe(true);
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-safe');
    expect(ids).toContain('agent-border');
    expect(ids).not.toContain('agent-risky');
  });

  it('14. maxAvgRiskScore=0.3 with multi-op agents uses the true average', async () => {
    ctx = await setup();
    // agent-ok: 2 ops at 0.1 and 0.3 => avg=0.2 => should be included
    await ctx.logger.log(makeOp('agent-ok', 'fs', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-ok', 'db', { id: crypto.randomUUID() }), dec('allow', 0.3));
    // agent-too-high: 2 ops at 0.3 and 0.7 => avg=0.5 => should be excluded
    await ctx.logger.log(makeOp('agent-too-high', 'fs', { id: crypto.randomUUID() }), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-too-high', 'db', { id: crypto.randomUUID() }), dec('block', 0.7));

    const { body } = await getJSON(ctx.port, '/agents?maxAvgRiskScore=0.3');
    const b = body as { agents: Array<{ agentId: string; avgRiskScore: number }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-ok');
    expect(ids).not.toContain('agent-too-high');
  });

  it('15. minAvgRiskScore and maxAvgRiskScore together define a range', async () => {
    ctx = await setup();
    // agent-low: avg=0.1 (excluded)
    await ctx.logger.log(makeOp('agent-low', 'fs'), dec('allow', 0.1));
    // agent-mid: avg=0.5 (included)
    await ctx.logger.log(makeOp('agent-mid', 'fs'), dec('allow', 0.5));
    // agent-high: avg=0.9 (excluded)
    await ctx.logger.log(makeOp('agent-high', 'fs'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/agents?minAvgRiskScore=0.4&maxAvgRiskScore=0.7');
    const b = body as { agents: Array<{ agentId: string; avgRiskScore: number }> };
    expect(b.agents.every(a => a.avgRiskScore >= 0.4 && a.avgRiskScore <= 0.7)).toBe(true);
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-mid');
    expect(ids).not.toContain('agent-low');
    expect(ids).not.toContain('agent-high');
  });

  it('16. minAvgRiskScore above all agents returns empty array', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-b', 'fs'), dec('allow', 0.4));

    const { body } = await getJSON(ctx.port, '/agents?minAvgRiskScore=0.9');
    const b = body as { agents: Array<unknown>; count: number };
    expect(b.agents).toHaveLength(0);
    expect(b.count).toBe(0);
  });

  it('17. maxAvgRiskScore below all agents returns empty array', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.6));
    await ctx.logger.log(makeOp('agent-b', 'fs'), dec('block', 0.8));

    const { body } = await getJSON(ctx.port, '/agents?maxAvgRiskScore=0.1');
    const b = body as { agents: Array<unknown>; count: number };
    expect(b.agents).toHaveLength(0);
    expect(b.count).toBe(0);
  });

  it('18. minAvgRiskScore=0.0 returns all agents (nothing has avg < 0)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.0));
    await ctx.logger.log(makeOp('agent-b', 'fs'), dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-c', 'fs'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/agents?minAvgRiskScore=0.0');
    const b = body as { agents: Array<unknown>; count: number };
    expect(b.count).toBe(3);
    expect(b.agents).toHaveLength(3);
  });
});

// ── T347 — GET /operations/summary includes totalBlocked and totalAllowed ─────

describe('GET /operations/summary totalBlocked and totalAllowed (T347)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('19. totalBlocked matches byAction.block', async () => {
    ctx = await setup();
    // 3 allow, 2 block
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-b', 'fs'), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-b', 'fs'), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as {
      totalBlocked: number;
      totalAllowed: number;
      byAction: { allow: number; block: number; require_approval: number };
    };
    expect(b.totalBlocked).toBe(2);
    expect(b.totalBlocked).toBe(b.byAction.block);
  });

  it('20. totalAllowed matches byAction.allow', async () => {
    ctx = await setup();
    // 3 allow, 1 block
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'db'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'net'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-b', 'fs'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as {
      totalBlocked: number;
      totalAllowed: number;
      byAction: { allow: number; block: number; require_approval: number };
    };
    expect(b.totalAllowed).toBe(3);
    expect(b.totalAllowed).toBe(b.byAction.allow);
  });

  it('21. totalBlocked and totalAllowed both present even when zero', async () => {
    ctx = await setup();
    // only allow operations
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.1));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as {
      totalBlocked: number;
      totalAllowed: number;
      byAction: { allow: number; block: number; require_approval: number };
    };
    expect(typeof b.totalBlocked).toBe('number');
    expect(typeof b.totalAllowed).toBe('number');
    expect(b.totalBlocked).toBe(0);
    expect(b.totalAllowed).toBe(1);
    expect(b.totalBlocked).toBe(b.byAction.block);
    expect(b.totalAllowed).toBe(b.byAction.allow);
  });

  it('22. totalBlocked and totalAllowed sum to totalOps when no require_approval', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'db'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-b', 'fs'), dec('block', 0.7));
    await ctx.logger.log(makeOp('agent-b', 'db'), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-b', 'net'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as {
      totalOps: number;
      totalBlocked: number;
      totalAllowed: number;
      byAction: { allow: number; block: number; require_approval: number };
    };
    expect(b.totalBlocked + b.totalAllowed).toBe(b.totalOps);
    expect(b.totalBlocked).toBe(3);
    expect(b.totalAllowed).toBe(2);
  });

  it('23. totalBlocked and totalAllowed correct with mixed actions including require_approval', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'db'), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-a', 'net'), dec('require_approval', 0.6));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as {
      totalOps: number;
      totalBlocked: number;
      totalAllowed: number;
      byAction: { allow: number; block: number; require_approval: number };
    };
    expect(b.totalBlocked).toBe(1);
    expect(b.totalAllowed).toBe(1);
    expect(b.byAction.require_approval).toBe(1);
    expect(b.totalBlocked).toBe(b.byAction.block);
    expect(b.totalAllowed).toBe(b.byAction.allow);
    expect(b.totalOps).toBe(3);
  });

  it('24. summary returns 200 with zero counts when no operations logged', async () => {
    ctx = await setup();

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as {
      totalOps: number;
      totalBlocked: number;
      totalAllowed: number;
      byAction: { allow: number; block: number };
    };
    expect(b.totalOps).toBe(0);
    expect(b.totalBlocked).toBe(0);
    expect(b.totalAllowed).toBe(0);
    expect(b.totalBlocked).toBe(b.byAction.block);
    expect(b.totalAllowed).toBe(b.byAction.allow);
  });
});

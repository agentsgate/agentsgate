/**
 * v0.53 tests
 *
 * T379 — GET /agents/:agentId/tools supports ?sort= and ?order= query params
 *         sort options: totalOps (default), blockRate, avgRisk
 *         order: asc | desc (default desc)
 *
 * T380 — GET /agents supports ?sort=firstSeen and ?sort=lastSeen
 *         these sort options work correctly with asc/desc order
 *
 * T381 — GET /tools supports ?sort=firstSeen and ?sort=lastSeen
 *         these sort options work correctly with asc/desc order
 *
 * T382 — GET /agents supports ?since=<iso> filter
 *         only agents whose lastSeen >= since are returned
 *         agents with lastSeen before since are excluded
 *
 * T383 — CLI ops count --from/--to flags (tested via HTTP endpoint)
 *         GET /operations/count?from=<iso> returns ops at or after that time
 *         GET /operations/count?to=<iso> returns ops at or before that time
 *         combined from+to range works
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
    sessionId: 'sess-default',
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

// ── T379 — GET /agents/:agentId/tools sort/order params ───────────────────────

describe('GET /agents/:agentId/tools sort/order (T379)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds tools for agent-sort-test with distinct totalOps, blockRate, avgRisk:
   *   tool-heavy:  4 ops, 1 blocked  => totalOps=4, blockRate=0.25, avgRisk=(0.1+0.1+0.1+0.8)/4=0.275
   *   tool-mid:    2 ops, 1 blocked  => totalOps=2, blockRate=0.5,  avgRisk=(0.8+0.2)/2=0.5
   *   tool-light:  1 op,  1 blocked  => totalOps=1, blockRate=1.0,  avgRisk=0.9
   */
  async function seedAgentTools(ctx: Ctx, agentId = 'agent-sort-test'): Promise<void> {
    // tool-heavy: 4 ops, 1 blocked
    await ctx.logger.log(makeOp(agentId, 'tool-heavy', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp(agentId, 'tool-heavy', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp(agentId, 'tool-heavy', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp(agentId, 'tool-heavy', { id: crypto.randomUUID() }), dec('block', 0.8));

    // tool-mid: 2 ops, 1 blocked
    await ctx.logger.log(makeOp(agentId, 'tool-mid', { id: crypto.randomUUID() }), dec('block', 0.8));
    await ctx.logger.log(makeOp(agentId, 'tool-mid', { id: crypto.randomUUID() }), dec('allow', 0.2));

    // tool-light: 1 op, 1 blocked
    await ctx.logger.log(makeOp(agentId, 'tool-light', { id: crypto.randomUUID() }), dec('block', 0.9));
  }

  it('1. sort=totalOps&order=desc (default): tool with most ops is first', async () => {
    ctx = await setup();
    await seedAgentTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents/agent-sort-test/tools?sort=totalOps&order=desc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; totalOps: number }> };
    expect(b.tools.length).toBe(3);

    // tool-heavy (4) first, tool-light (1) last
    expect(b.tools[0]!.tool).toBe('tool-heavy');
    expect(b.tools[0]!.totalOps).toBe(4);
    expect(b.tools[b.tools.length - 1]!.tool).toBe('tool-light');
  });

  it('2. sort=totalOps&order=asc: tool with fewest ops is first', async () => {
    ctx = await setup();
    await seedAgentTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents/agent-sort-test/tools?sort=totalOps&order=asc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; totalOps: number }> };

    // Verify ascending order
    const ops = b.tools.map(t => t.totalOps);
    for (let i = 1; i < ops.length; i++) {
      expect(ops[i]).toBeGreaterThanOrEqual(ops[i - 1]!);
    }
    // tool-light (1) first
    expect(b.tools[0]!.tool).toBe('tool-light');
    expect(b.tools[0]!.totalOps).toBe(1);
  });

  it('3. sort=blockRate&order=desc: tool with highest blockRate is first', async () => {
    ctx = await setup();
    await seedAgentTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents/agent-sort-test/tools?sort=blockRate&order=desc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };

    // Verify descending order
    const rates = b.tools.map(t => t.blockRate);
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]).toBeLessThanOrEqual(rates[i - 1]!);
    }
    // tool-light (1.0) first
    expect(b.tools[0]!.tool).toBe('tool-light');
    expect(b.tools[0]!.blockRate).toBeCloseTo(1.0, 5);
  });

  it('4. sort=blockRate&order=asc: tool with lowest blockRate is first', async () => {
    ctx = await setup();
    await seedAgentTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents/agent-sort-test/tools?sort=blockRate&order=asc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };

    // Verify ascending order
    const rates = b.tools.map(t => t.blockRate);
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]).toBeGreaterThanOrEqual(rates[i - 1]!);
    }
    // tool-heavy (0.25) first
    expect(b.tools[0]!.tool).toBe('tool-heavy');
    expect(b.tools[0]!.blockRate).toBeCloseTo(0.25, 5);
  });

  it('5. sort=avgRisk&order=desc: tool with highest avgRisk is first', async () => {
    ctx = await setup();
    await seedAgentTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents/agent-sort-test/tools?sort=avgRisk&order=desc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; avgRisk: number }> };

    // Verify descending order
    const risks = b.tools.map(t => t.avgRisk);
    for (let i = 1; i < risks.length; i++) {
      expect(risks[i]).toBeLessThanOrEqual(risks[i - 1]!);
    }
    // tool-light (avgRisk=0.9) first
    expect(b.tools[0]!.tool).toBe('tool-light');
    expect(b.tools[0]!.avgRisk).toBeCloseTo(0.9, 5);
  });

  it('6. sort=avgRisk&order=asc: tool with lowest avgRisk is first', async () => {
    ctx = await setup();
    await seedAgentTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents/agent-sort-test/tools?sort=avgRisk&order=asc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; avgRisk: number }> };

    // Verify ascending order
    const risks = b.tools.map(t => t.avgRisk);
    for (let i = 1; i < risks.length; i++) {
      expect(risks[i]).toBeGreaterThanOrEqual(risks[i - 1]!);
    }
    // tool-heavy avgRisk = (0.1+0.1+0.1+0.8)/4 = 0.275 — lowest
    expect(b.tools[0]!.tool).toBe('tool-heavy');
    expect(b.tools[0]!.avgRisk).toBeCloseTo(0.275, 5);
  });

  it('7. default sort (no params) is by totalOps descending', async () => {
    ctx = await setup();
    await seedAgentTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents/agent-sort-test/tools');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; totalOps: number }> };

    // Default is totalOps desc — tool-heavy (4) should be first
    expect(b.tools[0]!.tool).toBe('tool-heavy');
    const ops = b.tools.map(t => t.totalOps);
    for (let i = 1; i < ops.length; i++) {
      expect(ops[i]).toBeLessThanOrEqual(ops[i - 1]!);
    }
  });

  it('8. response includes agentId and count fields', async () => {
    ctx = await setup();
    await seedAgentTools(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-sort-test/tools?sort=blockRate&order=desc');
    const b = body as { agentId: string; count: number; tools: unknown[] };
    expect(b.agentId).toBe('agent-sort-test');
    expect(b.count).toBe(3);
    expect(b.tools).toHaveLength(3);
  });

  it('9. each tool entry has tool, totalOps, blockRate, avgRisk fields', async () => {
    ctx = await setup();
    await seedAgentTools(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-sort-test/tools?sort=avgRisk&order=asc');
    const b = body as { tools: Array<Record<string, unknown>> };
    for (const t of b.tools) {
      expect(typeof t['tool']).toBe('string');
      expect(typeof t['totalOps']).toBe('number');
      expect(typeof t['blockRate']).toBe('number');
      expect(typeof t['avgRisk']).toBe('number');
    }
  });

  it('10. sort=blockRate&order=desc: mid-blockRate tool is between highest and lowest', async () => {
    ctx = await setup();
    await seedAgentTools(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-sort-test/tools?sort=blockRate&order=desc');
    const b = body as { tools: Array<{ tool: string }> };

    const lightIdx = b.tools.findIndex(t => t.tool === 'tool-light');
    const midIdx   = b.tools.findIndex(t => t.tool === 'tool-mid');
    const heavyIdx = b.tools.findIndex(t => t.tool === 'tool-heavy');
    expect(lightIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(heavyIdx);
  });
});

// ── T380 — GET /agents sort=firstSeen / sort=lastSeen ─────────────────────────

describe('GET /agents sort=firstSeen and sort=lastSeen (T380)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds 3 agents with well-separated first/lastSeen times by using
   * explicit createdAt values via saveOperationLog.
   *
   *   agent-old:    firstSeen = 3h ago, lastSeen = 3h ago  (1 op)
   *   agent-mid:    firstSeen = 2h ago, lastSeen = 2h ago  (1 op)
   *   agent-recent: firstSeen = 1h ago, lastSeen = 1h ago  (1 op)
   */
  async function seedTimedAgents(ctx: Ctx): Promise<{ tOld: Date; tMid: Date; tRecent: Date }> {
    const now = Date.now();
    const tOld    = new Date(now - 3 * 60 * 60 * 1000);
    const tMid    = new Date(now - 2 * 60 * 60 * 1000);
    const tRecent = new Date(now - 1 * 60 * 60 * 1000);

    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-old',    'tool-x', { id: crypto.randomUUID(), timestamp: tOld }),
      decision: dec('allow', 0.1),
      createdAt: tOld,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-mid',    'tool-x', { id: crypto.randomUUID(), timestamp: tMid }),
      decision: dec('allow', 0.2),
      createdAt: tMid,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-recent', 'tool-x', { id: crypto.randomUUID(), timestamp: tRecent }),
      decision: dec('allow', 0.3),
      createdAt: tRecent,
    });

    return { tOld, tMid, tRecent };
  }

  it('11. sort=lastSeen&order=desc: most-recently-seen agent is first', async () => {
    ctx = await setup();
    await seedTimedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?sort=lastSeen&order=desc');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; lastSeen: string }> };
    expect(b.agents.length).toBeGreaterThanOrEqual(3);

    // agent-recent should be first
    expect(b.agents[0]!.agentId).toBe('agent-recent');
  });

  it('12. sort=lastSeen&order=asc: oldest-seen agent is first', async () => {
    ctx = await setup();
    await seedTimedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?sort=lastSeen&order=asc');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; lastSeen: string }> };
    expect(b.agents.length).toBeGreaterThanOrEqual(3);

    // agent-old should be first
    expect(b.agents[0]!.agentId).toBe('agent-old');
  });

  it('13. sort=lastSeen&order=asc: lastSeen values are in ascending ISO string order', async () => {
    ctx = await setup();
    await seedTimedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?sort=lastSeen&order=asc');
    const b = body as { agents: Array<{ lastSeen: string }> };

    const seenValues = b.agents.map(a => a.lastSeen);
    for (let i = 1; i < seenValues.length; i++) {
      expect(seenValues[i]! >= seenValues[i - 1]!).toBe(true);
    }
  });

  it('14. sort=firstSeen&order=asc: agent first seen earliest is first', async () => {
    ctx = await setup();
    await seedTimedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?sort=firstSeen&order=asc');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; firstSeen: string }> };
    expect(b.agents.length).toBeGreaterThanOrEqual(3);

    // agent-old has earliest firstSeen — should be first in asc order
    expect(b.agents[0]!.agentId).toBe('agent-old');
  });

  it('15. sort=firstSeen&order=desc: agent first seen most recently is first', async () => {
    ctx = await setup();
    await seedTimedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?sort=firstSeen&order=desc');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; firstSeen: string }> };
    expect(b.agents.length).toBeGreaterThanOrEqual(3);

    // agent-recent has latest firstSeen — should be first in desc order
    expect(b.agents[0]!.agentId).toBe('agent-recent');
  });

  it('16. sort=firstSeen&order=desc: firstSeen values are in descending ISO string order', async () => {
    ctx = await setup();
    await seedTimedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?sort=firstSeen&order=desc');
    const b = body as { agents: Array<{ firstSeen: string }> };

    const seenValues = b.agents.map(a => a.firstSeen);
    for (let i = 1; i < seenValues.length; i++) {
      expect(seenValues[i]! <= seenValues[i - 1]!).toBe(true);
    }
  });

  it('17. sort=lastSeen&order=desc: agent-mid is between agent-recent and agent-old', async () => {
    ctx = await setup();
    await seedTimedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?sort=lastSeen&order=desc');
    const b = body as { agents: Array<{ agentId: string }> };

    const recentIdx = b.agents.findIndex(a => a.agentId === 'agent-recent');
    const midIdx    = b.agents.findIndex(a => a.agentId === 'agent-mid');
    const oldIdx    = b.agents.findIndex(a => a.agentId === 'agent-old');
    expect(recentIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(oldIdx);
  });

  it('18. response includes firstSeen and lastSeen fields for each agent', async () => {
    ctx = await setup();
    await seedTimedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?sort=lastSeen&order=asc');
    const b = body as { agents: Array<Record<string, unknown>> };
    for (const agent of b.agents) {
      expect(typeof agent['firstSeen']).toBe('string');
      expect(typeof agent['lastSeen']).toBe('string');
    }
  });
});

// ── T381 — GET /tools sort=firstSeen / sort=lastSeen ──────────────────────────

describe('GET /tools sort=firstSeen and sort=lastSeen (T381)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds 3 tools with well-separated first/lastSeen times:
   *   tool-old:    firstSeen = 3h ago, lastSeen = 3h ago  (1 op)
   *   tool-mid:    firstSeen = 2h ago, lastSeen = 2h ago  (1 op)
   *   tool-recent: firstSeen = 1h ago, lastSeen = 1h ago  (1 op)
   */
  async function seedTimedTools(ctx: Ctx): Promise<{ tOld: Date; tMid: Date; tRecent: Date }> {
    const now = Date.now();
    const tOld    = new Date(now - 3 * 60 * 60 * 1000);
    const tMid    = new Date(now - 2 * 60 * 60 * 1000);
    const tRecent = new Date(now - 1 * 60 * 60 * 1000);

    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-a', 'tool-old',    { id: crypto.randomUUID(), timestamp: tOld }),
      decision: dec('allow', 0.1),
      createdAt: tOld,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-b', 'tool-mid',    { id: crypto.randomUUID(), timestamp: tMid }),
      decision: dec('allow', 0.2),
      createdAt: tMid,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-c', 'tool-recent', { id: crypto.randomUUID(), timestamp: tRecent }),
      decision: dec('allow', 0.3),
      createdAt: tRecent,
    });

    return { tOld, tMid, tRecent };
  }

  it('19. sort=lastSeen&order=desc: most-recently-seen tool is first', async () => {
    ctx = await setup();
    await seedTimedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?sort=lastSeen&order=desc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; lastSeen: string }> };
    expect(b.tools.length).toBeGreaterThanOrEqual(3);

    // tool-recent should be first
    expect(b.tools[0]!.tool).toBe('tool-recent');
  });

  it('20. sort=lastSeen&order=asc: oldest-seen tool is first', async () => {
    ctx = await setup();
    await seedTimedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?sort=lastSeen&order=asc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; lastSeen: string }> };
    expect(b.tools.length).toBeGreaterThanOrEqual(3);

    // tool-old should be first
    expect(b.tools[0]!.tool).toBe('tool-old');
  });

  it('21. sort=firstSeen&order=asc: tool first seen earliest is first', async () => {
    ctx = await setup();
    await seedTimedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?sort=firstSeen&order=asc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; firstSeen: string }> };
    expect(b.tools.length).toBeGreaterThanOrEqual(3);

    // tool-old has earliest firstSeen
    expect(b.tools[0]!.tool).toBe('tool-old');
  });

  it('22. sort=firstSeen&order=desc: tool first seen most recently is first', async () => {
    ctx = await setup();
    await seedTimedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?sort=firstSeen&order=desc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; firstSeen: string }> };
    expect(b.tools.length).toBeGreaterThanOrEqual(3);

    // tool-recent has latest firstSeen
    expect(b.tools[0]!.tool).toBe('tool-recent');
  });

  it('23. sort=lastSeen&order=asc: lastSeen values are in ascending ISO string order', async () => {
    ctx = await setup();
    await seedTimedTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?sort=lastSeen&order=asc');
    const b = body as { tools: Array<{ lastSeen: string }> };

    const seenValues = b.tools.map(t => t.lastSeen);
    for (let i = 1; i < seenValues.length; i++) {
      expect(seenValues[i]! >= seenValues[i - 1]!).toBe(true);
    }
  });

  it('24. sort=firstSeen&order=desc: firstSeen values are in descending ISO string order', async () => {
    ctx = await setup();
    await seedTimedTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?sort=firstSeen&order=desc');
    const b = body as { tools: Array<{ firstSeen: string }> };

    const seenValues = b.tools.map(t => t.firstSeen);
    for (let i = 1; i < seenValues.length; i++) {
      expect(seenValues[i]! <= seenValues[i - 1]!).toBe(true);
    }
  });

  it('25. sort=lastSeen&order=desc: tool-mid is between tool-recent and tool-old', async () => {
    ctx = await setup();
    await seedTimedTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?sort=lastSeen&order=desc');
    const b = body as { tools: Array<{ tool: string }> };

    const recentIdx = b.tools.findIndex(t => t.tool === 'tool-recent');
    const midIdx    = b.tools.findIndex(t => t.tool === 'tool-mid');
    const oldIdx    = b.tools.findIndex(t => t.tool === 'tool-old');
    expect(recentIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(oldIdx);
  });

  it('26. response includes firstSeen and lastSeen fields for each tool', async () => {
    ctx = await setup();
    await seedTimedTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?sort=lastSeen&order=asc');
    const b = body as { tools: Array<Record<string, unknown>> };
    for (const tool of b.tools) {
      expect(typeof tool['firstSeen']).toBe('string');
      expect(typeof tool['lastSeen']).toBe('string');
    }
  });
});

// ── T382 — GET /agents?since=<iso> filter ─────────────────────────────────────

describe('GET /agents ?since= filter (T382)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds 3 agents with distinct timestamps:
   *   agent-old:    lastSeen = 3h ago
   *   agent-mid:    lastSeen = 2h ago
   *   agent-recent: lastSeen = 1h ago
   */
  async function seedAgentsWithTimes(ctx: Ctx): Promise<{ tOld: Date; tMid: Date; tRecent: Date }> {
    const now = Date.now();
    const tOld    = new Date(now - 3 * 60 * 60 * 1000);
    const tMid    = new Date(now - 2 * 60 * 60 * 1000);
    const tRecent = new Date(now - 1 * 60 * 60 * 1000);

    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-old',    'tool-x', { id: crypto.randomUUID(), timestamp: tOld }),
      decision: dec('allow', 0.1),
      createdAt: tOld,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-mid',    'tool-x', { id: crypto.randomUUID(), timestamp: tMid }),
      decision: dec('allow', 0.2),
      createdAt: tMid,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-recent', 'tool-x', { id: crypto.randomUUID(), timestamp: tRecent }),
      decision: dec('allow', 0.3),
      createdAt: tRecent,
    });

    return { tOld, tMid, tRecent };
  }

  it('27. since= before all agents returns all agents', async () => {
    ctx = await setup();
    const { tOld } = await seedAgentsWithTimes(ctx);

    const since = new Date(tOld.getTime() - 60 * 60 * 1000); // 1h before oldest
    const { status, body } = await getJSON(ctx.port, `/agents?since=${encodeURIComponent(since.toISOString())}`);
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-old');
    expect(ids).toContain('agent-mid');
    expect(ids).toContain('agent-recent');
  });

  it('28. since= set after agent-old excludes agent-old but includes newer agents', async () => {
    ctx = await setup();
    const { tOld, tMid } = await seedAgentsWithTimes(ctx);

    // since = midpoint between tOld and tMid — excludes tOld, includes tMid and tRecent
    const since = new Date(tOld.getTime() + 30 * 60 * 1000);
    expect(since.getTime()).toBeLessThan(tMid.getTime()); // Sanity check window

    const { body } = await getJSON(ctx.port, `/agents?since=${encodeURIComponent(since.toISOString())}`);
    const b = body as { agents: Array<{ agentId: string }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).not.toContain('agent-old');
    expect(ids).toContain('agent-mid');
    expect(ids).toContain('agent-recent');
  });

  it('29. since= set after agent-mid returns only agent-recent', async () => {
    ctx = await setup();
    const { tMid, tRecent } = await seedAgentsWithTimes(ctx);

    // since = midpoint between tMid and tRecent
    const since = new Date(tMid.getTime() + 30 * 60 * 1000);
    expect(since.getTime()).toBeLessThan(tRecent.getTime()); // Sanity check

    const { body } = await getJSON(ctx.port, `/agents?since=${encodeURIComponent(since.toISOString())}`);
    const b = body as { agents: Array<{ agentId: string }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).not.toContain('agent-old');
    expect(ids).not.toContain('agent-mid');
    expect(ids).toContain('agent-recent');
  });

  it('30. since= in the future returns empty agents array', async () => {
    ctx = await setup();
    await seedAgentsWithTimes(ctx);

    const since = new Date(Date.now() + 60 * 60 * 1000); // 1h from now
    const { body } = await getJSON(ctx.port, `/agents?since=${encodeURIComponent(since.toISOString())}`);
    const b = body as { agents: Array<unknown>; count: number };
    expect(b.agents).toHaveLength(0);
    expect(b.count).toBe(0);
  });

  it('31. since= filter respects the exact boundary (agents with lastSeen equal to since are included)', async () => {
    ctx = await setup();
    const { tMid } = await seedAgentsWithTimes(ctx);

    // Use tMid exactly as the since value — agent-mid should be included
    const { body } = await getJSON(ctx.port, `/agents?since=${encodeURIComponent(tMid.toISOString())}`);
    const b = body as { agents: Array<{ agentId: string }> };
    const ids = b.agents.map(a => a.agentId);
    // agent-mid's lastSeen == since, so it must be included
    expect(ids).toContain('agent-mid');
    expect(ids).toContain('agent-recent');
  });

  it('32. since= can be combined with sort=lastSeen&order=asc', async () => {
    ctx = await setup();
    const { tOld } = await seedAgentsWithTimes(ctx);

    const since = new Date(tOld.getTime() + 30 * 60 * 1000); // after agent-old
    const { body } = await getJSON(ctx.port, `/agents?since=${encodeURIComponent(since.toISOString())}&sort=lastSeen&order=asc`);
    const b = body as { agents: Array<{ agentId: string; lastSeen: string }> };

    // agent-old must be excluded
    const ids = b.agents.map(a => a.agentId);
    expect(ids).not.toContain('agent-old');

    // Remaining agents should be sorted by lastSeen ascending
    const seenValues = b.agents.map(a => a.lastSeen);
    for (let i = 1; i < seenValues.length; i++) {
      expect(seenValues[i]! >= seenValues[i - 1]!).toBe(true);
    }
  });

  it('33. count field reflects filtered agent count (not total)', async () => {
    ctx = await setup();
    const { tMid } = await seedAgentsWithTimes(ctx);

    // Only agent-recent has lastSeen >= midpoint
    const since = new Date(tMid.getTime() + 30 * 60 * 1000);
    const { body } = await getJSON(ctx.port, `/agents?since=${encodeURIComponent(since.toISOString())}`);
    const b = body as { agents: Array<unknown>; count: number };
    expect(b.agents).toHaveLength(1);
    expect(b.count).toBe(1);
  });
});

// ── T383 — GET /operations/count with from/to flags ───────────────────────────

describe('GET /operations/count ?from= and ?to= (T383)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds 3 operations at well-separated times:
   *   tOld:    3h ago
   *   tMid:    2h ago
   *   tRecent: 1h ago
   */
  async function seedTimedOps(ctx: Ctx): Promise<{ tOld: Date; tMid: Date; tRecent: Date }> {
    const now = Date.now();
    const tOld    = new Date(now - 3 * 60 * 60 * 1000);
    const tMid    = new Date(now - 2 * 60 * 60 * 1000);
    const tRecent = new Date(now - 1 * 60 * 60 * 1000);

    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-a', 'tool-old',    { id: crypto.randomUUID() }),
      decision: dec('allow', 0.1),
      createdAt: tOld,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-b', 'tool-mid',    { id: crypto.randomUUID() }),
      decision: dec('allow', 0.2),
      createdAt: tMid,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-c', 'tool-recent', { id: crypto.randomUUID() }),
      decision: dec('allow', 0.3),
      createdAt: tRecent,
    });

    return { tOld, tMid, tRecent };
  }

  it('34. ?from= set before all ops returns total count of 3', async () => {
    ctx = await setup();
    const { tOld } = await seedTimedOps(ctx);

    const from = new Date(tOld.getTime() - 60 * 60 * 1000);
    const { status, body } = await getJSON(ctx.port, `/operations/count?from=${encodeURIComponent(from.toISOString())}`);
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(3);
  });

  it('35. ?from= after tOld excludes tOld op (returns 2)', async () => {
    ctx = await setup();
    const { tOld, tMid } = await seedTimedOps(ctx);

    const from = new Date(tOld.getTime() + 30 * 60 * 1000); // between tOld and tMid
    expect(from.getTime()).toBeLessThan(tMid.getTime());

    const { body } = await getJSON(ctx.port, `/operations/count?from=${encodeURIComponent(from.toISOString())}`);
    const b = body as { count: number };
    expect(b.count).toBe(2);
  });

  it('36. ?from= after tMid returns only tRecent op (count=1)', async () => {
    ctx = await setup();
    const { tMid, tRecent } = await seedTimedOps(ctx);

    const from = new Date(tMid.getTime() + 30 * 60 * 1000);
    expect(from.getTime()).toBeLessThan(tRecent.getTime());

    const { body } = await getJSON(ctx.port, `/operations/count?from=${encodeURIComponent(from.toISOString())}`);
    const b = body as { count: number };
    expect(b.count).toBe(1);
  });

  it('37. ?to= after all ops returns total count of 3', async () => {
    ctx = await setup();
    const { tRecent } = await seedTimedOps(ctx);

    const to = new Date(tRecent.getTime() + 60 * 60 * 1000);
    const { status, body } = await getJSON(ctx.port, `/operations/count?to=${encodeURIComponent(to.toISOString())}`);
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(3);
  });

  it('38. ?to= before tRecent excludes tRecent op (returns 2)', async () => {
    ctx = await setup();
    const { tMid, tRecent } = await seedTimedOps(ctx);

    const to = new Date(tMid.getTime() + 30 * 60 * 1000);
    expect(to.getTime()).toBeLessThan(tRecent.getTime());

    const { body } = await getJSON(ctx.port, `/operations/count?to=${encodeURIComponent(to.toISOString())}`);
    const b = body as { count: number };
    expect(b.count).toBe(2);
  });

  it('39. ?to= before tMid returns only tOld op (count=1)', async () => {
    ctx = await setup();
    const { tOld, tMid } = await seedTimedOps(ctx);

    const to = new Date(tOld.getTime() + 30 * 60 * 1000);
    expect(to.getTime()).toBeLessThan(tMid.getTime());

    const { body } = await getJSON(ctx.port, `/operations/count?to=${encodeURIComponent(to.toISOString())}`);
    const b = body as { count: number };
    expect(b.count).toBe(1);
  });

  it('40. combined ?from= and ?to= bracketing only tMid returns count=1', async () => {
    ctx = await setup();
    const { tOld, tMid, tRecent } = await seedTimedOps(ctx);

    const from = new Date(tOld.getTime() + 30 * 60 * 1000);  // after tOld
    const to   = new Date(tRecent.getTime() - 30 * 60 * 1000); // before tRecent
    expect(from.getTime()).toBeLessThan(tMid.getTime());
    expect(to.getTime()).toBeGreaterThan(tMid.getTime());

    const { body } = await getJSON(
      ctx.port,
      `/operations/count?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`
    );
    const b = body as { count: number };
    expect(b.count).toBe(1);
  });

  it('41. combined from+to range containing all ops returns 3', async () => {
    ctx = await setup();
    const { tOld, tRecent } = await seedTimedOps(ctx);

    const from = new Date(tOld.getTime()    - 60 * 60 * 1000);
    const to   = new Date(tRecent.getTime() + 60 * 60 * 1000);

    const { body } = await getJSON(
      ctx.port,
      `/operations/count?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`
    );
    const b = body as { count: number };
    expect(b.count).toBe(3);
  });

  it('42. ?from= in the future returns count=0', async () => {
    ctx = await setup();
    await seedTimedOps(ctx);

    const from = new Date(Date.now() + 60 * 60 * 1000);
    const { body } = await getJSON(ctx.port, `/operations/count?from=${encodeURIComponent(from.toISOString())}`);
    const b = body as { count: number };
    expect(b.count).toBe(0);
  });

  it('43. ?to= before all ops returns count=0', async () => {
    ctx = await setup();
    const { tOld } = await seedTimedOps(ctx);

    const to = new Date(tOld.getTime() - 60 * 60 * 1000);
    const { body } = await getJSON(ctx.port, `/operations/count?to=${encodeURIComponent(to.toISOString())}`);
    const b = body as { count: number };
    expect(b.count).toBe(0);
  });

  it('44. /operations/count returns 200 with a numeric count field', async () => {
    ctx = await setup();
    await seedTimedOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/count');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(typeof b['count']).toBe('number');
    expect(b['count']).toBe(3);
  });

  it('45. ?from= can be combined with ?agentId= to narrow both dimensions', async () => {
    ctx = await setup();
    const now = Date.now();
    const tEarly = new Date(now - 3 * 60 * 60 * 1000);
    const tLate  = new Date(now - 1 * 60 * 60 * 1000);

    // agent-target: one early op, one late op
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-target', 'tool-x', { id: crypto.randomUUID() }),
      decision: dec('allow', 0.2),
      createdAt: tEarly,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-target', 'tool-y', { id: crypto.randomUUID() }),
      decision: dec('allow', 0.3),
      createdAt: tLate,
    });
    // Other agent late op — excluded by agentId filter
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-other', 'tool-z', { id: crypto.randomUUID() }),
      decision: dec('allow', 0.1),
      createdAt: tLate,
    });

    // from = between tEarly and tLate — only the late agent-target op should match
    const from = new Date(tEarly.getTime() + 30 * 60 * 1000);
    const { body } = await getJSON(
      ctx.port,
      `/operations/count?agentId=agent-target&from=${encodeURIComponent(from.toISOString())}`
    );
    const b = body as { count: number };
    expect(b.count).toBe(1);
  });
});

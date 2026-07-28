/**
 * v0.47 tests
 *
 * T349 — GET /telemetry/agents?sort=blockRate&order=asc: agents sorted ascending by blockRate
 *         GET /telemetry/agents?sort=avgRisk&order=desc: sorted descending by avgRisk
 * T350 — GET /telemetry/tools?sort=blockRate&order=asc: tools sorted ascending by blockRate
 *         GET /telemetry/tools?sort=avgRisk&order=asc: ascending by avgRisk
 * T353 — GET /operations/summary response includes recentOps array of up to 5 operations,
 *         each with operationId, agentId, tool, method, action, riskScore, timestamp
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

// ── T349 — GET /telemetry/agents sort ────────────────────────────────────────

describe('GET /telemetry/agents sort (T349)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed 3 agents with clearly different blockRates:
   *   agent-low:  1 allow, 0 block  => blockRate = 0.0,  avgRisk = 0.1
   *   agent-mid:  2 allow, 1 block  => blockRate = 0.33, avgRisk = 0.4
   *   agent-high: 1 allow, 2 block  => blockRate = 0.67, avgRisk = 0.7
   */
  async function seedAgents(ctx: Ctx): Promise<void> {
    // agent-low
    await ctx.logger.log(makeOp('agent-low', 'fs'), dec('allow', 0.1));
    // agent-mid
    await ctx.logger.log(makeOp('agent-mid', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-mid', 'fs'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-mid', 'fs'), dec('block', 0.7));
    // agent-high
    await ctx.logger.log(makeOp('agent-high', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-high', 'fs'), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-high', 'fs'), dec('block', 0.9));
  }

  it('1. sort=blockRate&order=asc returns agents in ascending blockRate order', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/agents?sort=blockRate&order=asc');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };
    expect(b.agents.length).toBeGreaterThanOrEqual(3);

    const blockRates = b.agents.map(a => a.blockRate);
    for (let i = 1; i < blockRates.length; i++) {
      expect(blockRates[i]).toBeGreaterThanOrEqual(blockRates[i - 1]!);
    }
    // First should be agent-low (0.0), last should be agent-high (0.67)
    expect(b.agents[0]!.agentId).toBe('agent-low');
    expect(b.agents[b.agents.length - 1]!.agentId).toBe('agent-high');
  });

  it('2. sort=blockRate&order=desc returns agents in descending blockRate order', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/agents?sort=blockRate&order=desc');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };
    expect(b.agents.length).toBeGreaterThanOrEqual(3);

    const blockRates = b.agents.map(a => a.blockRate);
    for (let i = 1; i < blockRates.length; i++) {
      expect(blockRates[i]).toBeLessThanOrEqual(blockRates[i - 1]!);
    }
    // First should be agent-high (highest blockRate), last should be agent-low
    expect(b.agents[0]!.agentId).toBe('agent-high');
    expect(b.agents[b.agents.length - 1]!.agentId).toBe('agent-low');
  });

  it('3. sort=avgRisk&order=desc returns agents in descending avgRisk order', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/agents?sort=avgRisk&order=desc');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; avgRisk: number }> };
    expect(b.agents.length).toBeGreaterThanOrEqual(3);

    const avgRisks = b.agents.map(a => a.avgRisk);
    for (let i = 1; i < avgRisks.length; i++) {
      expect(avgRisks[i]).toBeLessThanOrEqual(avgRisks[i - 1]!);
    }
    // agent-high has avgRisk=(0.1+0.8+0.9)/3=0.6 (highest), agent-low has avgRisk=0.1 (lowest)
    expect(b.agents[0]!.agentId).toBe('agent-high');
    expect(b.agents[b.agents.length - 1]!.agentId).toBe('agent-low');
  });

  it('4. sort=avgRisk&order=asc returns agents in ascending avgRisk order', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/agents?sort=avgRisk&order=asc');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; avgRisk: number }> };
    expect(b.agents.length).toBeGreaterThanOrEqual(3);

    const avgRisks = b.agents.map(a => a.avgRisk);
    for (let i = 1; i < avgRisks.length; i++) {
      expect(avgRisks[i]).toBeGreaterThanOrEqual(avgRisks[i - 1]!);
    }
    // agent-low has lowest avgRisk=0.1, agent-high has highest avgRisk~0.6
    expect(b.agents[0]!.agentId).toBe('agent-low');
    expect(b.agents[b.agents.length - 1]!.agentId).toBe('agent-high');
  });

  it('5. response includes blockRate and avgRisk fields for each agent', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/agents?sort=blockRate&order=asc');
    const b = body as { agents: Array<{ agentId: string; blockRate: number; avgRisk: number; totalOps: number }> };
    for (const agent of b.agents) {
      expect(typeof agent.agentId).toBe('string');
      expect(typeof agent.blockRate).toBe('number');
      expect(typeof agent.avgRisk).toBe('number');
      expect(typeof agent.totalOps).toBe('number');
      expect(agent.blockRate).toBeGreaterThanOrEqual(0);
      expect(agent.blockRate).toBeLessThanOrEqual(1);
    }
  });

  it('6. blockRate values are computed correctly (blocked / total)', async () => {
    ctx = await setup();
    // agent-precise: 2 block, 2 allow => blockRate = 0.5
    await ctx.logger.log(makeOp('agent-precise', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-precise', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-precise', 'fs'), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-precise', 'fs'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/telemetry/agents?sort=blockRate&order=asc');
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };
    const agent = b.agents.find(a => a.agentId === 'agent-precise');
    expect(agent).toBeDefined();
    expect(agent!.blockRate).toBeCloseTo(0.5, 5);
  });
});

// ── T350 — GET /telemetry/tools sort ─────────────────────────────────────────

describe('GET /telemetry/tools sort (T350)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed 3 tools with clearly different blockRates and avgRisk values:
   *   tool-safe:   2 allow, 0 block => blockRate=0.0,  avgRisk=0.1
   *   tool-medium: 2 allow, 1 block => blockRate=0.33, avgRisk=0.4
   *   tool-risky:  1 allow, 2 block => blockRate=0.67, avgRisk=0.75
   */
  async function seedTools(ctx: Ctx): Promise<void> {
    // tool-safe
    await ctx.logger.log(makeOp('agent-a', 'tool-safe'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-safe'), dec('allow', 0.1));
    // tool-medium
    await ctx.logger.log(makeOp('agent-a', 'tool-medium'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'tool-medium'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-a', 'tool-medium'), dec('block', 0.7));
    // tool-risky
    await ctx.logger.log(makeOp('agent-a', 'tool-risky'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-a', 'tool-risky'), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-a', 'tool-risky'), dec('block', 0.9));
  }

  it('7. sort=blockRate&order=asc returns tools in ascending blockRate order', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/tools?sort=blockRate&order=asc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };
    expect(b.tools.length).toBeGreaterThanOrEqual(3);

    const blockRates = b.tools.map(t => t.blockRate);
    for (let i = 1; i < blockRates.length; i++) {
      expect(blockRates[i]).toBeGreaterThanOrEqual(blockRates[i - 1]!);
    }
    // tool-safe has blockRate=0.0 (lowest), tool-risky has blockRate=0.67 (highest)
    expect(b.tools[0]!.tool).toBe('tool-safe');
    expect(b.tools[b.tools.length - 1]!.tool).toBe('tool-risky');
  });

  it('8. sort=blockRate&order=desc returns tools in descending blockRate order', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/tools?sort=blockRate&order=desc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };
    expect(b.tools.length).toBeGreaterThanOrEqual(3);

    const blockRates = b.tools.map(t => t.blockRate);
    for (let i = 1; i < blockRates.length; i++) {
      expect(blockRates[i]).toBeLessThanOrEqual(blockRates[i - 1]!);
    }
    expect(b.tools[0]!.tool).toBe('tool-risky');
    expect(b.tools[b.tools.length - 1]!.tool).toBe('tool-safe');
  });

  it('9. sort=avgRisk&order=asc returns tools in ascending avgRisk order', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/tools?sort=avgRisk&order=asc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; avgRisk: number }> };
    expect(b.tools.length).toBeGreaterThanOrEqual(3);

    const avgRisks = b.tools.map(t => t.avgRisk);
    for (let i = 1; i < avgRisks.length; i++) {
      expect(avgRisks[i]).toBeGreaterThanOrEqual(avgRisks[i - 1]!);
    }
    // tool-safe avgRisk=0.1 (lowest)
    expect(b.tools[0]!.tool).toBe('tool-safe');
    // tool-risky avgRisk=(0.3+0.8+0.9)/3=0.67 (highest)
    expect(b.tools[b.tools.length - 1]!.tool).toBe('tool-risky');
  });

  it('10. sort=avgRisk&order=desc returns tools in descending avgRisk order', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/tools?sort=avgRisk&order=desc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; avgRisk: number }> };
    expect(b.tools.length).toBeGreaterThanOrEqual(3);

    const avgRisks = b.tools.map(t => t.avgRisk);
    for (let i = 1; i < avgRisks.length; i++) {
      expect(avgRisks[i]).toBeLessThanOrEqual(avgRisks[i - 1]!);
    }
    expect(b.tools[0]!.tool).toBe('tool-risky');
    expect(b.tools[b.tools.length - 1]!.tool).toBe('tool-safe');
  });

  it('11. response includes blockRate, avgRisk and totalOps fields for each tool', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/tools?sort=blockRate&order=asc');
    const b = body as { tools: Array<{ tool: string; blockRate: number; avgRisk: number; totalOps: number }> };
    for (const tool of b.tools) {
      expect(typeof tool.tool).toBe('string');
      expect(typeof tool.blockRate).toBe('number');
      expect(typeof tool.avgRisk).toBe('number');
      expect(typeof tool.totalOps).toBe('number');
      expect(tool.blockRate).toBeGreaterThanOrEqual(0);
      expect(tool.blockRate).toBeLessThanOrEqual(1);
    }
  });

  it('12. avgRisk values are computed correctly (riskSum / totalOps)', async () => {
    ctx = await setup();
    // tool-exact: 2 ops with known riskScores => avgRisk = (0.3 + 0.7) / 2 = 0.5
    await ctx.logger.log(makeOp('agent-a', 'tool-exact'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-a', 'tool-exact'), dec('block', 0.7));

    const { body } = await getJSON(ctx.port, '/telemetry/tools?sort=avgRisk&order=asc');
    const b = body as { tools: Array<{ tool: string; avgRisk: number }> };
    const tool = b.tools.find(t => t.tool === 'tool-exact');
    expect(tool).toBeDefined();
    expect(tool!.avgRisk).toBeCloseTo(0.5, 5);
  });
});

// ── T353 — GET /operations/summary recentOps ─────────────────────────────────

describe('GET /operations/summary recentOps (T353)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('13. recentOps is present in the summary response', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { recentOps: unknown };
    expect(Array.isArray(b.recentOps)).toBe(true);
  });

  it('14. recentOps contains at most 5 operations', async () => {
    ctx = await setup();
    // Log 8 operations — recentOps should be capped at 5
    for (let i = 0; i < 8; i++) {
      await ctx.logger.log(makeOp('agent-a', `tool-${i}`), dec('allow', 0.1 * (i + 1)));
    }

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { recentOps: Array<unknown> };
    expect(b.recentOps.length).toBeLessThanOrEqual(5);
    expect(b.recentOps).toHaveLength(5);
  });

  it('15. each recentOps entry has operationId, agentId, tool, method, action, riskScore, timestamp', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-x', 'tool-y', { method: 'call' }), dec('allow', 0.42));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { recentOps: Array<Record<string, unknown>> };
    expect(b.recentOps).toHaveLength(1);

    const op = b.recentOps[0]!;
    expect(typeof op['operationId']).toBe('string');
    expect(op['operationId']).toBeTruthy();
    expect(op['agentId']).toBe('agent-x');
    expect(op['tool']).toBe('tool-y');
    expect(op['method']).toBe('call');
    expect(op['action']).toBe('allow');
    expect(typeof op['riskScore']).toBe('number');
    expect(op['riskScore']).toBeCloseTo(0.42, 5);
    expect(typeof op['timestamp']).toBe('string');
    // Timestamp should be a valid ISO-8601 string
    expect(() => new Date(op['timestamp'] as string)).not.toThrow();
    expect(new Date(op['timestamp'] as string).getTime()).not.toBeNaN();
  });

  it('16. recentOps action reflects the decision action (block)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-b', 'dangerous-tool'), dec('block', 0.95));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { recentOps: Array<{ action: string; riskScore: number }> };
    expect(b.recentOps).toHaveLength(1);
    expect(b.recentOps[0]!.action).toBe('block');
    expect(b.recentOps[0]!.riskScore).toBeCloseTo(0.95, 5);
  });

  it('17. recentOps action reflects require_approval decision', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-c', 'sensitive-tool'), dec('require_approval', 0.6));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { recentOps: Array<{ action: string }> };
    expect(b.recentOps).toHaveLength(1);
    expect(b.recentOps[0]!.action).toBe('require_approval');
  });

  it('18. recentOps is empty array when no operations have been logged', async () => {
    ctx = await setup();

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { recentOps: Array<unknown> };
    expect(Array.isArray(b.recentOps)).toBe(true);
    expect(b.recentOps).toHaveLength(0);
  });

  it('19. recentOps with exactly 5 operations returns all 5', async () => {
    ctx = await setup();
    const agents = ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5'];
    const tools  = ['tool-a', 'tool-b', 'tool-c', 'tool-d', 'tool-e'];
    for (let i = 0; i < 5; i++) {
      await ctx.logger.log(makeOp(agents[i]!, tools[i]!), dec('allow', 0.1 * (i + 1)));
    }

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { recentOps: Array<Record<string, unknown>> };
    expect(b.recentOps).toHaveLength(5);
    // All required fields present in every entry
    for (const op of b.recentOps) {
      expect(op['operationId']).toBeTruthy();
      expect(op['agentId']).toBeTruthy();
      expect(op['tool']).toBeTruthy();
      expect(op['method']).toBeTruthy();
      expect(op['action']).toBeTruthy();
      expect(typeof op['riskScore']).toBe('number');
      expect(typeof op['timestamp']).toBe('string');
    }
  });

  it('20. recentOps agentId matches agents from the logged operations', async () => {
    ctx = await setup();
    const expectedAgentIds = ['agent-alpha', 'agent-beta', 'agent-gamma'];
    for (const agentId of expectedAgentIds) {
      await ctx.logger.log(makeOp(agentId, 'fs'), dec('allow', 0.2));
    }

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { recentOps: Array<{ agentId: string }> };
    const returnedAgentIds = b.recentOps.map(op => op.agentId);
    for (const agentId of expectedAgentIds) {
      expect(returnedAgentIds).toContain(agentId);
    }
  });
});

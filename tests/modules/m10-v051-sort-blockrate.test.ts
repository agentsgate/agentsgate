/**
 * v0.51 tests
 *
 * T369 — GET /agents?sort=blockRate&order=asc: agents sorted ascending by blockRate
 *         GET /agents?sort=blockRate&order=desc: agents sorted descending by blockRate
 * T370 — GET /tools?sort=blockRate&order=asc: tools sorted by blockRate ascending
 * T371 — GET /sessions?sort=avgRisk&order=asc: sessions sorted by avgRisk ascending
 *         GET /sessions?sort=blockRate&order=desc: sessions sorted descending by blockRate
 * T372 — GET /telemetry/agents?minBlockRate=0.5: only agents with blockRate >= 0.5
 *         GET /telemetry/agents?maxBlockRate=0.2: only agents with blockRate <= 0.2
 * T373 — GET /telemetry/tools?minBlockRate=0.5: only tools with blockRate >= 0.5
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

/**
 * Seeds 3 agents with clearly distinct blockRates:
 *   agent-low:  2 ops, 0 blocked  => blockRate = 0.0,  avgRisk ~0.15
 *   agent-mid:  2 ops, 1 blocked  => blockRate = 0.5,  avgRisk ~0.45
 *   agent-high: 2 ops, 2 blocked  => blockRate = 1.0,  avgRisk ~0.925
 */
async function seedAgents(ctx: Ctx): Promise<void> {
  // agent-low: blockRate = 0.0 (0/2), avgRisk = (0.1+0.2)/2 = 0.15
  await ctx.logger.log(makeOp('agent-low', 'tool-x', { id: crypto.randomUUID() }), dec('allow', 0.1));
  await ctx.logger.log(makeOp('agent-low', 'tool-y', { id: crypto.randomUUID() }), dec('allow', 0.2));

  // agent-mid: blockRate = 0.5 (1/2), avgRisk = (0.8+0.1)/2 = 0.45
  await ctx.logger.log(makeOp('agent-mid', 'tool-x', { id: crypto.randomUUID() }), dec('block', 0.8));
  await ctx.logger.log(makeOp('agent-mid', 'tool-y', { id: crypto.randomUUID() }), dec('allow', 0.1));

  // agent-high: blockRate = 1.0 (2/2), avgRisk = (0.9+0.95)/2 = 0.925
  await ctx.logger.log(makeOp('agent-high', 'tool-x', { id: crypto.randomUUID() }), dec('block', 0.9));
  await ctx.logger.log(makeOp('agent-high', 'tool-y', { id: crypto.randomUUID() }), dec('block', 0.95));
}

/**
 * Seeds 3 tools with clearly distinct blockRates:
 *   tool-safe:   2 ops, 0 blocked  => blockRate = 0.0
 *   tool-risky:  2 ops, 1 blocked  => blockRate = 0.5
 *   tool-danger: 2 ops, 2 blocked  => blockRate = 1.0
 */
async function seedTools(ctx: Ctx): Promise<void> {
  // tool-safe: blockRate = 0.0 (0/2)
  await ctx.logger.log(makeOp('agent-a', 'tool-safe', { id: crypto.randomUUID() }), dec('allow', 0.1));
  await ctx.logger.log(makeOp('agent-b', 'tool-safe', { id: crypto.randomUUID() }), dec('allow', 0.15));

  // tool-risky: blockRate = 0.5 (1/2)
  await ctx.logger.log(makeOp('agent-a', 'tool-risky', { id: crypto.randomUUID() }), dec('block', 0.7));
  await ctx.logger.log(makeOp('agent-b', 'tool-risky', { id: crypto.randomUUID() }), dec('allow', 0.2));

  // tool-danger: blockRate = 1.0 (2/2)
  await ctx.logger.log(makeOp('agent-a', 'tool-danger', { id: crypto.randomUUID() }), dec('block', 0.95));
  await ctx.logger.log(makeOp('agent-b', 'tool-danger', { id: crypto.randomUUID() }), dec('block', 0.9));
}

/**
 * Seeds 3 sessions with clearly distinct blockRates and avgRisk values:
 *   sess-clean:     3 ops, 0 blocked  => blockRate=0.0,  avgRisk=(0.1+0.15+0.2)/3 = 0.15
 *   sess-half:      2 ops, 1 blocked  => blockRate=0.5,  avgRisk=(0.8+0.1)/2 = 0.45
 *   sess-all-block: 2 ops, 2 blocked  => blockRate=1.0,  avgRisk=(0.9+0.95)/2 = 0.925
 */
async function seedSessions(ctx: Ctx): Promise<void> {
  // sess-clean: blockRate=0.0, avgRisk=0.15
  await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-clean' }), dec('allow', 0.1));
  await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-clean' }), dec('allow', 0.15));
  await ctx.logger.log(makeOp('agent-a', 'tool-z', { id: crypto.randomUUID(), sessionId: 'sess-clean' }), dec('allow', 0.2));

  // sess-half: blockRate=0.5, avgRisk=0.45
  await ctx.logger.log(makeOp('agent-b', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-half' }), dec('block', 0.8));
  await ctx.logger.log(makeOp('agent-b', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-half' }), dec('allow', 0.1));

  // sess-all-block: blockRate=1.0, avgRisk=0.925
  await ctx.logger.log(makeOp('agent-c', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-all-block' }), dec('block', 0.9));
  await ctx.logger.log(makeOp('agent-c', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-all-block' }), dec('block', 0.95));
}

// ── T369 — GET /agents?sort=blockRate ────────────────────────────────────────

describe('GET /agents sort=blockRate (T369)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. sort=blockRate&order=asc returns agents in ascending blockRate order', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?sort=blockRate&order=asc');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };
    expect(b.agents.length).toBeGreaterThanOrEqual(3);

    // Verify ascending order
    const blockRates = b.agents.map(a => a.blockRate);
    for (let i = 1; i < blockRates.length; i++) {
      expect(blockRates[i]).toBeGreaterThanOrEqual(blockRates[i - 1]!);
    }

    // agent-low (0.0) must be first, agent-high (1.0) must be last
    expect(b.agents[0]!.agentId).toBe('agent-low');
    expect(b.agents[b.agents.length - 1]!.agentId).toBe('agent-high');
  });

  it('2. sort=blockRate&order=desc returns agents in descending blockRate order', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?sort=blockRate&order=desc');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };
    expect(b.agents.length).toBeGreaterThanOrEqual(3);

    // Verify descending order
    const blockRates = b.agents.map(a => a.blockRate);
    for (let i = 1; i < blockRates.length; i++) {
      expect(blockRates[i]).toBeLessThanOrEqual(blockRates[i - 1]!);
    }

    // agent-high (1.0) must be first, agent-low (0.0) must be last
    expect(b.agents[0]!.agentId).toBe('agent-high');
    expect(b.agents[b.agents.length - 1]!.agentId).toBe('agent-low');
  });

  it('3. sort=blockRate&order=asc blockRate values are correct for each agent', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?sort=blockRate&order=asc');
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };

    const low  = b.agents.find(a => a.agentId === 'agent-low');
    const mid  = b.agents.find(a => a.agentId === 'agent-mid');
    const high = b.agents.find(a => a.agentId === 'agent-high');
    expect(low).toBeDefined();
    expect(mid).toBeDefined();
    expect(high).toBeDefined();
    expect(low!.blockRate).toBeCloseTo(0.0, 5);
    expect(mid!.blockRate).toBeCloseTo(0.5, 5);
    expect(high!.blockRate).toBeCloseTo(1.0, 5);
  });

  it('4. sort=blockRate&order=desc: agent-mid is between agent-high and agent-low', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?sort=blockRate&order=desc');
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };

    const highIdx = b.agents.findIndex(a => a.agentId === 'agent-high');
    const midIdx  = b.agents.findIndex(a => a.agentId === 'agent-mid');
    const lowIdx  = b.agents.findIndex(a => a.agentId === 'agent-low');
    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);
  });

  it('5. sort=blockRate&order=asc: all three agents present in result', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?sort=blockRate&order=asc');
    const b = body as { agents: Array<{ agentId: string }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-low');
    expect(ids).toContain('agent-mid');
    expect(ids).toContain('agent-high');
  });
});

// ── T370 — GET /tools?sort=blockRate ─────────────────────────────────────────

describe('GET /tools sort=blockRate (T370)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('6. sort=blockRate&order=asc returns tools in ascending blockRate order', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?sort=blockRate&order=asc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };
    expect(b.tools.length).toBeGreaterThanOrEqual(3);

    // Verify ascending order
    const blockRates = b.tools.map(t => t.blockRate);
    for (let i = 1; i < blockRates.length; i++) {
      expect(blockRates[i]).toBeGreaterThanOrEqual(blockRates[i - 1]!);
    }

    // tool-safe (0.0) must be first, tool-danger (1.0) must be last
    expect(b.tools[0]!.tool).toBe('tool-safe');
    expect(b.tools[b.tools.length - 1]!.tool).toBe('tool-danger');
  });

  it('7. sort=blockRate&order=desc returns tools in descending blockRate order', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?sort=blockRate&order=desc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };
    expect(b.tools.length).toBeGreaterThanOrEqual(3);

    // Verify descending order
    const blockRates = b.tools.map(t => t.blockRate);
    for (let i = 1; i < blockRates.length; i++) {
      expect(blockRates[i]).toBeLessThanOrEqual(blockRates[i - 1]!);
    }

    // tool-danger (1.0) must be first, tool-safe (0.0) must be last
    expect(b.tools[0]!.tool).toBe('tool-danger');
    expect(b.tools[b.tools.length - 1]!.tool).toBe('tool-safe');
  });

  it('8. sort=blockRate&order=asc: blockRate values are correct for each tool', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?sort=blockRate&order=asc');
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };

    const safe   = b.tools.find(t => t.tool === 'tool-safe');
    const risky  = b.tools.find(t => t.tool === 'tool-risky');
    const danger = b.tools.find(t => t.tool === 'tool-danger');
    expect(safe).toBeDefined();
    expect(risky).toBeDefined();
    expect(danger).toBeDefined();
    expect(safe!.blockRate).toBeCloseTo(0.0, 5);
    expect(risky!.blockRate).toBeCloseTo(0.5, 5);
    expect(danger!.blockRate).toBeCloseTo(1.0, 5);
  });

  it('9. sort=blockRate&order=asc: tool-risky is between tool-safe and tool-danger', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?sort=blockRate&order=asc');
    const b = body as { tools: Array<{ tool: string }> };

    const safeIdx   = b.tools.findIndex(t => t.tool === 'tool-safe');
    const riskyIdx  = b.tools.findIndex(t => t.tool === 'tool-risky');
    const dangerIdx = b.tools.findIndex(t => t.tool === 'tool-danger');
    expect(safeIdx).toBeLessThan(riskyIdx);
    expect(riskyIdx).toBeLessThan(dangerIdx);
  });

  it('10. sort=blockRate&order=asc: all three tools present in result', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?sort=blockRate&order=asc');
    const b = body as { tools: Array<{ tool: string }> };
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-safe');
    expect(names).toContain('tool-risky');
    expect(names).toContain('tool-danger');
  });
});

// ── T371 — GET /sessions?sort=avgRisk / sort=blockRate ───────────────────────

describe('GET /sessions sort=avgRisk and sort=blockRate (T371)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('11. sort=avgRisk&order=asc returns sessions in ascending avgRisk order', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions?sort=avgRisk&order=asc');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; avgRisk: number }> };
    expect(b.data.length).toBeGreaterThanOrEqual(3);

    // Verify ascending order
    const avgRisks = b.data.map(s => s.avgRisk);
    for (let i = 1; i < avgRisks.length; i++) {
      expect(avgRisks[i]).toBeGreaterThanOrEqual(avgRisks[i - 1]!);
    }

    // sess-clean (avgRisk~0.15) must be first, sess-all-block (avgRisk~0.925) must be last
    expect(b.data[0]!.sessionId).toBe('sess-clean');
    expect(b.data[b.data.length - 1]!.sessionId).toBe('sess-all-block');
  });

  it('12. sort=avgRisk&order=desc returns sessions in descending avgRisk order', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions?sort=avgRisk&order=desc');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; avgRisk: number }> };
    expect(b.data.length).toBeGreaterThanOrEqual(3);

    // Verify descending order
    const avgRisks = b.data.map(s => s.avgRisk);
    for (let i = 1; i < avgRisks.length; i++) {
      expect(avgRisks[i]).toBeLessThanOrEqual(avgRisks[i - 1]!);
    }

    // sess-all-block (highest avgRisk) must be first
    expect(b.data[0]!.sessionId).toBe('sess-all-block');
    expect(b.data[b.data.length - 1]!.sessionId).toBe('sess-clean');
  });

  it('13. sort=blockRate&order=desc returns sessions in descending blockRate order', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions?sort=blockRate&order=desc');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; blockRate: number }> };
    expect(b.data.length).toBeGreaterThanOrEqual(3);

    // Verify descending order
    const blockRates = b.data.map(s => s.blockRate);
    for (let i = 1; i < blockRates.length; i++) {
      expect(blockRates[i]).toBeLessThanOrEqual(blockRates[i - 1]!);
    }

    // sess-all-block (1.0) must be first, sess-clean (0.0) must be last
    expect(b.data[0]!.sessionId).toBe('sess-all-block');
    expect(b.data[b.data.length - 1]!.sessionId).toBe('sess-clean');
  });

  it('14. sort=blockRate&order=asc returns sessions in ascending blockRate order', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions?sort=blockRate&order=asc');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; blockRate: number }> };
    expect(b.data.length).toBeGreaterThanOrEqual(3);

    // Verify ascending order
    const blockRates = b.data.map(s => s.blockRate);
    for (let i = 1; i < blockRates.length; i++) {
      expect(blockRates[i]).toBeGreaterThanOrEqual(blockRates[i - 1]!);
    }

    // sess-clean (0.0) first, sess-all-block (1.0) last
    expect(b.data[0]!.sessionId).toBe('sess-clean');
    expect(b.data[b.data.length - 1]!.sessionId).toBe('sess-all-block');
  });

  it('15. sort=avgRisk&order=asc: avgRisk values are correct for each session', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?sort=avgRisk&order=asc');
    const b = body as { data: Array<{ sessionId: string; avgRisk: number }> };

    const clean    = b.data.find(s => s.sessionId === 'sess-clean');
    const half     = b.data.find(s => s.sessionId === 'sess-half');
    const allBlock = b.data.find(s => s.sessionId === 'sess-all-block');
    expect(clean).toBeDefined();
    expect(half).toBeDefined();
    expect(allBlock).toBeDefined();
    // sess-clean avgRisk = (0.1+0.15+0.2)/3 = 0.15
    expect(clean!.avgRisk).toBeCloseTo(0.15, 3);
    // sess-half avgRisk = (0.8+0.1)/2 = 0.45
    expect(half!.avgRisk).toBeCloseTo(0.45, 3);
    // sess-all-block avgRisk = (0.9+0.95)/2 = 0.925
    expect(allBlock!.avgRisk).toBeCloseTo(0.925, 3);
  });

  it('16. sort=blockRate&order=desc: blockRate values are correct for each session', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?sort=blockRate&order=desc');
    const b = body as { data: Array<{ sessionId: string; blockRate: number }> };

    const allBlock = b.data.find(s => s.sessionId === 'sess-all-block');
    const half     = b.data.find(s => s.sessionId === 'sess-half');
    const clean    = b.data.find(s => s.sessionId === 'sess-clean');
    expect(allBlock).toBeDefined();
    expect(half).toBeDefined();
    expect(clean).toBeDefined();
    expect(allBlock!.blockRate).toBeCloseTo(1.0, 5);
    expect(half!.blockRate).toBeCloseTo(0.5, 5);
    expect(clean!.blockRate).toBeCloseTo(0.0, 5);
  });
});

// ── T372 — GET /telemetry/agents?minBlockRate / ?maxBlockRate ─────────────────

describe('GET /telemetry/agents minBlockRate/maxBlockRate filter (T372)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('17. ?minBlockRate=0.5 returns only telemetry agents with blockRate >= 0.5', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/agents?minBlockRate=0.5');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };
    expect(Array.isArray(b.agents)).toBe(true);

    // All returned agents must have blockRate >= 0.5
    for (const agent of b.agents) {
      expect(agent.blockRate).toBeGreaterThanOrEqual(0.5);
    }

    // agent-high (1.0) and agent-mid (0.5) must be included
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-high');
    expect(ids).toContain('agent-mid');
    // agent-low (0.0) must be excluded
    expect(ids).not.toContain('agent-low');
  });

  it('18. ?maxBlockRate=0.2 returns only telemetry agents with blockRate <= 0.2', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/agents?maxBlockRate=0.2');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };
    expect(Array.isArray(b.agents)).toBe(true);

    // All returned agents must have blockRate <= 0.2
    for (const agent of b.agents) {
      expect(agent.blockRate).toBeLessThanOrEqual(0.2);
    }

    // agent-low (0.0) must be included
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-low');
    // agent-mid (0.5) and agent-high (1.0) must be excluded
    expect(ids).not.toContain('agent-mid');
    expect(ids).not.toContain('agent-high');
  });

  it('19. ?minBlockRate=1.0 returns only fully-blocked telemetry agents', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/agents?minBlockRate=1.0');
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };

    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-high');
    expect(ids).not.toContain('agent-mid');
    expect(ids).not.toContain('agent-low');
    for (const agent of b.agents) {
      expect(agent.blockRate).toBeCloseTo(1.0, 5);
    }
  });

  it('20. ?maxBlockRate=0.0 returns only telemetry agents with no blocked ops', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/agents?maxBlockRate=0.0');
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };

    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-low');
    expect(ids).not.toContain('agent-mid');
    expect(ids).not.toContain('agent-high');
    for (const agent of b.agents) {
      expect(agent.blockRate).toBe(0);
    }
  });

  it('21. ?minBlockRate=0.5 with no matching agents returns empty agents array', async () => {
    ctx = await setup();
    // Only a fully-clean agent (blockRate = 0.0)
    await ctx.logger.log(makeOp('agent-clean-only', 'fs', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-clean-only', 'db', { id: crypto.randomUUID() }), dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/telemetry/agents?minBlockRate=0.5');
    expect(status).toBe(200);
    const b = body as { agents: Array<unknown> };
    expect(b.agents).toHaveLength(0);
  });

  it('22. no blockRate filter returns all telemetry agents', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/agents');
    const b = body as { agents: Array<{ agentId: string }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-low');
    expect(ids).toContain('agent-mid');
    expect(ids).toContain('agent-high');
  });

  it('23. ?minBlockRate=0.5 telemetry agent blockRate values in response are correct', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/agents?minBlockRate=0.5');
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };

    const high = b.agents.find(a => a.agentId === 'agent-high');
    const mid  = b.agents.find(a => a.agentId === 'agent-mid');
    expect(high).toBeDefined();
    expect(mid).toBeDefined();
    expect(high!.blockRate).toBeCloseTo(1.0, 5);
    expect(mid!.blockRate).toBeCloseTo(0.5, 5);
  });

  it('24. response includes count field reflecting filtered count', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/agents?minBlockRate=0.5');
    const b = body as { agents: Array<unknown>; count: number };
    // agent-mid (0.5) and agent-high (1.0) match => count = 2
    expect(b.count).toBe(2);
    expect(b.agents).toHaveLength(2);
  });
});

// ── T373 — GET /telemetry/tools?minBlockRate ──────────────────────────────────

describe('GET /telemetry/tools minBlockRate filter (T373)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('25. ?minBlockRate=0.5 returns only telemetry tools with blockRate >= 0.5', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/tools?minBlockRate=0.5');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };
    expect(Array.isArray(b.tools)).toBe(true);

    // All returned tools must have blockRate >= 0.5
    for (const tool of b.tools) {
      expect(tool.blockRate).toBeGreaterThanOrEqual(0.5);
    }

    // tool-danger (1.0) and tool-risky (0.5) must be included
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-danger');
    expect(names).toContain('tool-risky');
    // tool-safe (0.0) must be excluded
    expect(names).not.toContain('tool-safe');
  });

  it('26. ?minBlockRate=1.0 returns only tools that are always blocked', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/tools?minBlockRate=1.0');
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };

    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-danger');
    expect(names).not.toContain('tool-risky');
    expect(names).not.toContain('tool-safe');
    for (const tool of b.tools) {
      expect(tool.blockRate).toBeCloseTo(1.0, 5);
    }
  });

  it('27. ?maxBlockRate=0.2 returns only telemetry tools with blockRate <= 0.2', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/tools?maxBlockRate=0.2');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };

    for (const tool of b.tools) {
      expect(tool.blockRate).toBeLessThanOrEqual(0.2);
    }

    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-safe');
    expect(names).not.toContain('tool-danger');
    expect(names).not.toContain('tool-risky');
  });

  it('28. ?minBlockRate=0.5 with no matching tools returns empty tools array', async () => {
    ctx = await setup();
    // Only a safe tool (blockRate = 0)
    await ctx.logger.log(makeOp('agent-a', 'safe-only-tool', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'safe-only-tool', { id: crypto.randomUUID() }), dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/telemetry/tools?minBlockRate=0.5');
    expect(status).toBe(200);
    const b = body as { tools: Array<unknown> };
    expect(b.tools).toHaveLength(0);
  });

  it('29. no blockRate filter returns all telemetry tools', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/tools');
    const b = body as { tools: Array<{ tool: string }> };
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-safe');
    expect(names).toContain('tool-risky');
    expect(names).toContain('tool-danger');
  });

  it('30. ?minBlockRate=0.5 telemetry tool blockRate values in response are correct', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/tools?minBlockRate=0.5');
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };

    const danger = b.tools.find(t => t.tool === 'tool-danger');
    const risky  = b.tools.find(t => t.tool === 'tool-risky');
    expect(danger).toBeDefined();
    expect(risky).toBeDefined();
    expect(danger!.blockRate).toBeCloseTo(1.0, 5);
    expect(risky!.blockRate).toBeCloseTo(0.5, 5);
  });

  it('31. response count field reflects filtered tool count', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/tools?minBlockRate=0.5');
    const b = body as { tools: Array<unknown>; count: number };
    // tool-risky (0.5) and tool-danger (1.0) match => count = 2
    expect(b.count).toBe(2);
    expect(b.tools).toHaveLength(2);
  });

  it('32. ?minBlockRate=0.5 combined with sort=blockRate&order=asc sorts filtered results correctly', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/tools?minBlockRate=0.5&sort=blockRate&order=asc');
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };

    // Should have tool-risky first (0.5), then tool-danger (1.0)
    expect(b.tools).toHaveLength(2);
    const blockRates = b.tools.map(t => t.blockRate);
    for (let i = 1; i < blockRates.length; i++) {
      expect(blockRates[i]).toBeGreaterThanOrEqual(blockRates[i - 1]!);
    }
    expect(b.tools[0]!.tool).toBe('tool-risky');
    expect(b.tools[1]!.tool).toBe('tool-danger');
  });
});

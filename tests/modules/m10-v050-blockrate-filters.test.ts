/**
 * v0.50 tests
 *
 * T364 — GET /agents?minBlockRate=0.5: only agents with blockRate (block/totalOps) >= 0.5
 *         GET /agents?maxBlockRate=0.3: only agents with blockRate <= 0.3
 * T365 — GET /tools?minBlockRate=0.5: only tools with blockRate >= 0.5
 * T366 — GET /sessions?maxBlockRate=0.3: only sessions with blocked/operationCount <= 0.3
 * T367 — GET /risk?sessionId=sess-1: only risk entries from that specific session
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
 *   agent-high:  2 ops, 2 blocked  => blockRate = 1.0
 *   agent-mid:   2 ops, 1 blocked  => blockRate = 0.5
 *   agent-low:   2 ops, 0 blocked  => blockRate = 0.0
 */
async function seedAgents(ctx: Ctx): Promise<void> {
  // agent-high: blockRate = 1.0 (2/2)
  await ctx.logger.log(makeOp('agent-high', 'tool-x', { id: crypto.randomUUID() }), dec('block', 0.9));
  await ctx.logger.log(makeOp('agent-high', 'tool-y', { id: crypto.randomUUID() }), dec('block', 0.95));

  // agent-mid: blockRate = 0.5 (1/2)
  await ctx.logger.log(makeOp('agent-mid', 'tool-x', { id: crypto.randomUUID() }), dec('block', 0.8));
  await ctx.logger.log(makeOp('agent-mid', 'tool-y', { id: crypto.randomUUID() }), dec('allow', 0.1));

  // agent-low: blockRate = 0.0 (0/2)
  await ctx.logger.log(makeOp('agent-low', 'tool-x', { id: crypto.randomUUID() }), dec('allow', 0.1));
  await ctx.logger.log(makeOp('agent-low', 'tool-y', { id: crypto.randomUUID() }), dec('allow', 0.2));
}

/**
 * Seeds 3 tools with clearly distinct blockRates:
 *   tool-danger:  3 ops, 3 blocked  => blockRate = 1.0
 *   tool-risky:   2 ops, 1 blocked  => blockRate = 0.5
 *   tool-safe:    2 ops, 0 blocked  => blockRate = 0.0
 */
async function seedTools(ctx: Ctx): Promise<void> {
  // tool-danger: blockRate = 1.0 (3/3)
  await ctx.logger.log(makeOp('agent-a', 'tool-danger', { id: crypto.randomUUID() }), dec('block', 0.95));
  await ctx.logger.log(makeOp('agent-b', 'tool-danger', { id: crypto.randomUUID() }), dec('block', 0.9));
  await ctx.logger.log(makeOp('agent-c', 'tool-danger', { id: crypto.randomUUID() }), dec('block', 0.98));

  // tool-risky: blockRate = 0.5 (1/2)
  await ctx.logger.log(makeOp('agent-a', 'tool-risky', { id: crypto.randomUUID() }), dec('block', 0.7));
  await ctx.logger.log(makeOp('agent-b', 'tool-risky', { id: crypto.randomUUID() }), dec('allow', 0.2));

  // tool-safe: blockRate = 0.0 (0/2)
  await ctx.logger.log(makeOp('agent-a', 'tool-safe', { id: crypto.randomUUID() }), dec('allow', 0.1));
  await ctx.logger.log(makeOp('agent-b', 'tool-safe', { id: crypto.randomUUID() }), dec('allow', 0.15));
}

/**
 * Seeds 3 sessions with clearly distinct blockRates:
 *   sess-all-block:  2 ops, 2 blocked  => blockRate = 1.0
 *   sess-half:       2 ops, 1 blocked  => blockRate = 0.5
 *   sess-clean:      3 ops, 0 blocked  => blockRate = 0.0
 */
async function seedSessions(ctx: Ctx): Promise<void> {
  // sess-all-block: blockRate = 1.0
  await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-all-block' }), dec('block', 0.9));
  await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-all-block' }), dec('block', 0.95));

  // sess-half: blockRate = 0.5
  await ctx.logger.log(makeOp('agent-b', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-half' }), dec('block', 0.8));
  await ctx.logger.log(makeOp('agent-b', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-half' }), dec('allow', 0.1));

  // sess-clean: blockRate = 0.0
  await ctx.logger.log(makeOp('agent-c', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-clean' }), dec('allow', 0.1));
  await ctx.logger.log(makeOp('agent-c', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-clean' }), dec('allow', 0.2));
  await ctx.logger.log(makeOp('agent-c', 'tool-z', { id: crypto.randomUUID(), sessionId: 'sess-clean' }), dec('allow', 0.15));
}

// ── T364 — GET /agents?minBlockRate / ?maxBlockRate ──────────────────────────

describe('GET /agents minBlockRate/maxBlockRate filter (T364)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. ?minBlockRate=0.5 returns only agents with blockRate >= 0.5', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?minBlockRate=0.5');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };
    expect(Array.isArray(b.agents)).toBe(true);

    // All returned agents must have blockRate >= 0.5
    for (const agent of b.agents) {
      expect(agent.blockRate).toBeGreaterThanOrEqual(0.5);
    }

    // agent-high (1.0) and agent-mid (0.5) should be included
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-high');
    expect(ids).toContain('agent-mid');
    // agent-low (0.0) should be excluded
    expect(ids).not.toContain('agent-low');
  });

  it('2. ?maxBlockRate=0.3 returns only agents with blockRate <= 0.3', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?maxBlockRate=0.3');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };
    expect(Array.isArray(b.agents)).toBe(true);

    // All returned agents must have blockRate <= 0.3
    for (const agent of b.agents) {
      expect(agent.blockRate).toBeLessThanOrEqual(0.3);
    }

    // agent-low (0.0) should be included
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-low');
    // agent-high (1.0) and agent-mid (0.5) should be excluded
    expect(ids).not.toContain('agent-high');
    expect(ids).not.toContain('agent-mid');
  });

  it('3. ?minBlockRate=1.0 returns only fully-blocked agents', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?minBlockRate=1.0');
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };

    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-high');
    expect(ids).not.toContain('agent-mid');
    expect(ids).not.toContain('agent-low');
    for (const agent of b.agents) {
      expect(agent.blockRate).toBeCloseTo(1.0, 5);
    }
  });

  it('4. ?maxBlockRate=0.0 returns only agents with no blocked ops', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?maxBlockRate=0.0');
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };

    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-low');
    expect(ids).not.toContain('agent-mid');
    expect(ids).not.toContain('agent-high');
    for (const agent of b.agents) {
      expect(agent.blockRate).toBe(0);
    }
  });

  it('5. ?minBlockRate=0.5 with no matching agents returns empty array', async () => {
    ctx = await setup();
    // Only agent with blockRate = 0.0
    await ctx.logger.log(makeOp('agent-clean', 'fs', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-clean', 'db', { id: crypto.randomUUID() }), dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/agents?minBlockRate=0.5');
    expect(status).toBe(200);
    const b = body as { agents: Array<unknown> };
    expect(b.agents).toHaveLength(0);
  });

  it('6. no blockRate filter returns all agents', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-high');
    expect(ids).toContain('agent-mid');
    expect(ids).toContain('agent-low');
  });

  it('7. blockRate values in filtered response are correct', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?minBlockRate=0.5');
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };

    const high = b.agents.find(a => a.agentId === 'agent-high');
    const mid  = b.agents.find(a => a.agentId === 'agent-mid');
    expect(high).toBeDefined();
    expect(mid).toBeDefined();
    expect(high!.blockRate).toBeCloseTo(1.0, 5);
    expect(mid!.blockRate).toBeCloseTo(0.5, 5);
  });
});

// ── T365 — GET /tools?minBlockRate ───────────────────────────────────────────

describe('GET /tools minBlockRate filter (T365)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('8. ?minBlockRate=0.5 returns only tools with blockRate >= 0.5', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?minBlockRate=0.5');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };
    expect(Array.isArray(b.tools)).toBe(true);

    // All returned tools must have blockRate >= 0.5
    for (const tool of b.tools) {
      expect(tool.blockRate).toBeGreaterThanOrEqual(0.5);
    }

    // tool-danger (1.0) and tool-risky (0.5) should be included
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-danger');
    expect(names).toContain('tool-risky');
    // tool-safe (0.0) should be excluded
    expect(names).not.toContain('tool-safe');
  });

  it('9. ?minBlockRate=1.0 returns only tools that are always blocked', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?minBlockRate=1.0');
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };

    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-danger');
    expect(names).not.toContain('tool-risky');
    expect(names).not.toContain('tool-safe');
    for (const tool of b.tools) {
      expect(tool.blockRate).toBeCloseTo(1.0, 5);
    }
  });

  it('10. ?maxBlockRate=0.3 returns only tools with blockRate <= 0.3', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?maxBlockRate=0.3');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };

    for (const tool of b.tools) {
      expect(tool.blockRate).toBeLessThanOrEqual(0.3);
    }

    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-safe');
    expect(names).not.toContain('tool-danger');
    expect(names).not.toContain('tool-risky');
  });

  it('11. ?minBlockRate=0.5 with no matching tools returns empty array', async () => {
    ctx = await setup();
    // Only a safe tool (blockRate = 0)
    await ctx.logger.log(makeOp('agent-a', 'safe-only', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'safe-only', { id: crypto.randomUUID() }), dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/tools?minBlockRate=0.5');
    expect(status).toBe(200);
    const b = body as { tools: Array<unknown> };
    expect(b.tools).toHaveLength(0);
  });

  it('12. no blockRate filter returns all tools', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string }> };
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-danger');
    expect(names).toContain('tool-risky');
    expect(names).toContain('tool-safe');
  });

  it('13. blockRate values in filtered tool response are correct', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?minBlockRate=0.5');
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };

    const danger = b.tools.find(t => t.tool === 'tool-danger');
    const risky  = b.tools.find(t => t.tool === 'tool-risky');
    expect(danger).toBeDefined();
    expect(risky).toBeDefined();
    expect(danger!.blockRate).toBeCloseTo(1.0, 5);
    expect(risky!.blockRate).toBeCloseTo(0.5, 5);
  });
});

// ── T366 — GET /sessions?maxBlockRate ────────────────────────────────────────

describe('GET /sessions maxBlockRate filter (T366)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('14. ?maxBlockRate=0.3 returns only sessions with blockRate <= 0.3', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions?maxBlockRate=0.3');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; blockRate: number; blocked: number; operationCount: number }> };
    expect(Array.isArray(b.data)).toBe(true);

    // All returned sessions must have blockRate <= 0.3
    for (const sess of b.data) {
      const rate = sess.blockRate ?? (sess.blocked / sess.operationCount);
      expect(rate).toBeLessThanOrEqual(0.3);
    }

    // sess-clean (0.0) should be included
    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('sess-clean');
    // sess-all-block (1.0) and sess-half (0.5) should be excluded
    expect(ids).not.toContain('sess-all-block');
    expect(ids).not.toContain('sess-half');
  });

  it('15. ?minBlockRate=0.5 returns only sessions with blockRate >= 0.5', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions?minBlockRate=0.5');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; blockRate: number; blocked: number; operationCount: number }> };

    // All returned sessions must have blockRate >= 0.5
    for (const sess of b.data) {
      const rate = sess.blockRate ?? (sess.blocked / sess.operationCount);
      expect(rate).toBeGreaterThanOrEqual(0.5);
    }

    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('sess-all-block');
    expect(ids).toContain('sess-half');
    expect(ids).not.toContain('sess-clean');
  });

  it('16. ?maxBlockRate=0.0 returns only fully-clean sessions', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?maxBlockRate=0.0');
    const b = body as { data: Array<{ sessionId: string; blockRate: number; blocked: number; operationCount: number }> };

    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('sess-clean');
    expect(ids).not.toContain('sess-half');
    expect(ids).not.toContain('sess-all-block');
    for (const sess of b.data) {
      const rate = sess.blockRate ?? (sess.blocked / sess.operationCount);
      expect(rate).toBe(0);
    }
  });

  it('17. ?minBlockRate=1.0 returns only fully-blocked sessions', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?minBlockRate=1.0');
    const b = body as { data: Array<{ sessionId: string; blockRate: number; blocked: number; operationCount: number }> };

    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('sess-all-block');
    expect(ids).not.toContain('sess-half');
    expect(ids).not.toContain('sess-clean');
  });

  it('18. ?maxBlockRate=0.3 with no matching sessions returns empty data array', async () => {
    ctx = await setup();
    // Only a fully-blocked session
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-only-blocked' }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-only-blocked' }), dec('block', 0.95));

    const { status, body } = await getJSON(ctx.port, '/sessions?maxBlockRate=0.3');
    expect(status).toBe(200);
    const b = body as { data: Array<unknown> };
    expect(b.data).toHaveLength(0);
  });

  it('19. no blockRate filter returns all sessions', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { data: Array<{ sessionId: string }> };
    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('sess-all-block');
    expect(ids).toContain('sess-half');
    expect(ids).toContain('sess-clean');
  });

  it('20. blockRate boundary — ?maxBlockRate=0.5 includes sess-half (exactly 0.5) and sess-clean (0.0)', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?maxBlockRate=0.5');
    const b = body as { data: Array<{ sessionId: string }> };
    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('sess-half');
    expect(ids).toContain('sess-clean');
    expect(ids).not.toContain('sess-all-block');
  });
});

// ── T367 — GET /risk?sessionId=sess-1 ────────────────────────────────────────

describe('GET /risk?sessionId filter (T367)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds operations across two sessions so we can verify sessionId filtering.
   * sess-1: 3 ops
   * sess-2: 2 ops
   */
  async function seedRiskSessions(ctx: Ctx): Promise<{ sess1Ids: string[]; sess2Ids: string[] }> {
    const sess1Ids: string[] = [];
    const sess2Ids: string[] = [];

    for (let i = 0; i < 3; i++) {
      const id = crypto.randomUUID();
      sess1Ids.push(id);
      await ctx.logger.log(
        makeOp('agent-a', `tool-${i}`, { id, sessionId: 'sess-1', timestamp: new Date(Date.now() - (10 - i) * 1000) }),
        dec(i % 2 === 0 ? 'block' : 'allow', 0.5 + i * 0.1)
      );
    }

    for (let i = 0; i < 2; i++) {
      const id = crypto.randomUUID();
      sess2Ids.push(id);
      await ctx.logger.log(
        makeOp('agent-b', `tool-${i}`, { id, sessionId: 'sess-2', timestamp: new Date(Date.now() - (5 - i) * 1000) }),
        dec('allow', 0.2 + i * 0.1)
      );
    }

    return { sess1Ids, sess2Ids };
  }

  it('21. ?sessionId=sess-1 returns only risk entries from sess-1', async () => {
    ctx = await setup();
    const { sess1Ids } = await seedRiskSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/risk?sessionId=sess-1');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; operationId: string }> };
    expect(Array.isArray(b.data)).toBe(true);
    expect(b.data.length).toBeGreaterThanOrEqual(1);

    // All entries must belong to sess-1
    for (const entry of b.data) {
      expect(entry.sessionId).toBe('sess-1');
    }

    // All sess-1 operationIds must be present
    const returnedIds = b.data.map(e => e.operationId);
    for (const id of sess1Ids) {
      expect(returnedIds).toContain(id);
    }
  });

  it('22. ?sessionId=sess-2 returns only risk entries from sess-2', async () => {
    ctx = await setup();
    const { sess2Ids } = await seedRiskSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/risk?sessionId=sess-2');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; operationId: string }> };

    for (const entry of b.data) {
      expect(entry.sessionId).toBe('sess-2');
    }

    const returnedIds = b.data.map(e => e.operationId);
    for (const id of sess2Ids) {
      expect(returnedIds).toContain(id);
    }
  });

  it('23. ?sessionId filter excludes entries from other sessions', async () => {
    ctx = await setup();
    const { sess1Ids, sess2Ids } = await seedRiskSessions(ctx);

    const { body: body1 } = await getJSON(ctx.port, '/risk?sessionId=sess-1');
    const b1 = body1 as { data: Array<{ operationId: string }> };
    const ids1 = b1.data.map(e => e.operationId);

    // sess-2 operationIds must not appear in sess-1 results
    for (const id of sess2Ids) {
      expect(ids1).not.toContain(id);
    }

    const { body: body2 } = await getJSON(ctx.port, '/risk?sessionId=sess-2');
    const b2 = body2 as { data: Array<{ operationId: string }> };
    const ids2 = b2.data.map(e => e.operationId);

    // sess-1 operationIds must not appear in sess-2 results
    for (const id of sess1Ids) {
      expect(ids2).not.toContain(id);
    }
  });

  it('24. ?sessionId=nonexistent returns empty data array', async () => {
    ctx = await setup();
    await seedRiskSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/risk?sessionId=nonexistent-session');
    expect(status).toBe(200);
    const b = body as { data: Array<unknown> };
    expect(b.data).toHaveLength(0);
  });

  it('25. ?sessionId filter result count matches the number of ops in that session', async () => {
    ctx = await setup();
    await seedRiskSessions(ctx);

    const { body } = await getJSON(ctx.port, '/risk?sessionId=sess-1&limit=100');
    const b = body as { data: Array<unknown>; count: number };
    // We seeded 3 ops for sess-1
    expect(b.data).toHaveLength(3);
  });

  it('26. no sessionId filter returns risk entries from all sessions', async () => {
    ctx = await setup();
    const { sess1Ids, sess2Ids } = await seedRiskSessions(ctx);

    const { body } = await getJSON(ctx.port, '/risk?limit=100');
    const b = body as { data: Array<{ operationId: string }> };
    const returnedIds = b.data.map(e => e.operationId);

    // Entries from both sessions should be present
    for (const id of sess1Ids) {
      expect(returnedIds).toContain(id);
    }
    for (const id of sess2Ids) {
      expect(returnedIds).toContain(id);
    }
  });

  it('27. each entry in ?sessionId=sess-1 response has sessionId field matching sess-1', async () => {
    ctx = await setup();
    await seedRiskSessions(ctx);

    const { body } = await getJSON(ctx.port, '/risk?sessionId=sess-1');
    const b = body as { data: Array<Record<string, unknown>> };

    expect(b.data.length).toBeGreaterThan(0);
    for (const entry of b.data) {
      expect(entry['sessionId']).toBeDefined();
      expect(entry['sessionId']).toBe('sess-1');
    }
  });

  it('28. ?sessionId filter can be combined with ?limit pagination', async () => {
    ctx = await setup();
    // Seed 5 ops in sess-paginate
    for (let i = 0; i < 5; i++) {
      await ctx.logger.log(
        makeOp('agent-a', `tool-${i}`, { id: crypto.randomUUID(), sessionId: 'sess-paginate', timestamp: new Date(Date.now() - i * 1000) }),
        dec('allow', 0.3)
      );
    }
    // Seed 3 ops in another session
    for (let i = 0; i < 3; i++) {
      await ctx.logger.log(
        makeOp('agent-b', `other-tool-${i}`, { id: crypto.randomUUID(), sessionId: 'sess-other' }),
        dec('block', 0.8)
      );
    }

    const { body } = await getJSON(ctx.port, '/risk?sessionId=sess-paginate&limit=2');
    const b = body as { data: Array<{ sessionId: string }>; count: number };
    // Exactly 2 results returned due to limit
    expect(b.data).toHaveLength(2);
    // All entries are from sess-paginate
    for (const entry of b.data) {
      expect(entry.sessionId).toBe('sess-paginate');
    }
  });
});

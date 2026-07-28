/**
 * v0.69 tests
 *
 * T459 — GET /agents?sort=minRiskScore&order=asc sorts by minimum risk score ascending
 * T460 — GET /agents/:agentId returns topBlockedTools[] (per-agent blocked tool counts)
 * T461 — GET /tools/:tool returns riskBuckets (distribution across 5 risk tiers)
 * T462 — GET /operations/summary returns topBlockedTools[] (global blocked tool counts)
 * T463 — GET /sessions?sort=blockCount&order=desc|asc sorts by block count
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
  riskScore = 0.1
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

// ── T459 — GET /agents?sort=minRiskScore&order=asc ────────────────────────────

describe('GET /agents?sort=minRiskScore&order=asc (T459)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * agent-A has risks [0.8, 0.9] => minRiskScore = 0.8
   * agent-B has risks [0.1, 0.2] => minRiskScore = 0.1
   * With order=asc, agent-B (lower min) should appear first.
   */
  async function seedMinRiskAgents(ctx: Ctx): Promise<void> {
    await ctx.logger.log(makeOp('agent-A', 'tool-x', { id: crypto.randomUUID() }), dec('allow', 0.8));
    await ctx.logger.log(makeOp('agent-A', 'tool-y', { id: crypto.randomUUID() }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-B', 'tool-x', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-B', 'tool-y', { id: crypto.randomUUID() }), dec('allow', 0.2));
  }

  it('1. GET /agents?sort=minRiskScore&order=asc returns 200', async () => {
    ctx = await setup();
    await seedMinRiskAgents(ctx);

    const { status } = await getJSON(ctx.port, '/agents?sort=minRiskScore&order=asc');
    expect(status).toBe(200);
  });

  it('2. agents[0].agentId is agent-B (lowest minRiskScore = 0.1)', async () => {
    ctx = await setup();
    await seedMinRiskAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?sort=minRiskScore&order=asc');
    const b = body as { agents: Array<{ agentId: string }> };
    expect(Array.isArray(b.agents)).toBe(true);
    expect(b.agents.length).toBeGreaterThanOrEqual(2);
    expect(b.agents[0]!.agentId).toBe('agent-B');
  });

  it('3. agents[1].agentId is agent-A (higher minRiskScore = 0.8)', async () => {
    ctx = await setup();
    await seedMinRiskAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?sort=minRiskScore&order=asc');
    const b = body as { agents: Array<{ agentId: string }> };
    expect(b.agents[1]!.agentId).toBe('agent-A');
  });

  it('4. each agent entry has a minRiskScore field', async () => {
    ctx = await setup();
    await seedMinRiskAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?sort=minRiskScore&order=asc');
    const b = body as { agents: Array<Record<string, unknown>> };
    for (const agent of b.agents) {
      expect(agent['minRiskScore']).toBeDefined();
      expect(typeof agent['minRiskScore']).toBe('number');
    }
  });

  it('5. minRiskScore values are in ascending order', async () => {
    ctx = await setup();
    await seedMinRiskAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?sort=minRiskScore&order=asc');
    const b = body as { agents: Array<{ minRiskScore: number }> };
    const scores = b.agents.map(a => a.minRiskScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]!);
    }
  });

  it('6. agent-B minRiskScore is approximately 0.1', async () => {
    ctx = await setup();
    await seedMinRiskAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?sort=minRiskScore&order=asc');
    const b = body as { agents: Array<{ agentId: string; minRiskScore: number }> };
    const agentB = b.agents.find(a => a.agentId === 'agent-B');
    expect(agentB).toBeDefined();
    expect(agentB!.minRiskScore).toBeCloseTo(0.1, 5);
  });

  it('7. agent-A minRiskScore is approximately 0.8', async () => {
    ctx = await setup();
    await seedMinRiskAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?sort=minRiskScore&order=asc');
    const b = body as { agents: Array<{ agentId: string; minRiskScore: number }> };
    const agentA = b.agents.find(a => a.agentId === 'agent-A');
    expect(agentA).toBeDefined();
    expect(agentA!.minRiskScore).toBeCloseTo(0.8, 5);
  });

  it('8. order=desc reverses the order — agent-A first', async () => {
    ctx = await setup();
    await seedMinRiskAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?sort=minRiskScore&order=desc');
    const b = body as { agents: Array<{ agentId: string }> };
    expect(b.agents[0]!.agentId).toBe('agent-A');
  });
});

// ── T460 — GET /agents/:agentId returns topBlockedTools[] ────────────────────

describe('GET /agents/:agentId — topBlockedTools[] (T460)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * agent-X:
   *   tool_A: 3 blocks
   *   tool_B: 1 block
   *   tool_C: 2 allows (no blocks)
   * topBlockedTools should be [{tool:'tool_A', blocked:3}, {tool:'tool_B', blocked:1}]
   * tool_C should NOT appear (zero blocks)
   */
  async function seedAgentXOps(ctx: Ctx): Promise<void> {
    const sessId = 'sess-x';
    // tool_A: 3 blocks
    await ctx.logger.log(makeOp('agent-X', 'tool_A', { id: crypto.randomUUID(), sessionId: sessId }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-X', 'tool_A', { id: crypto.randomUUID(), sessionId: sessId }), dec('block', 0.85));
    await ctx.logger.log(makeOp('agent-X', 'tool_A', { id: crypto.randomUUID(), sessionId: sessId }), dec('block', 0.9));
    // tool_B: 1 block
    await ctx.logger.log(makeOp('agent-X', 'tool_B', { id: crypto.randomUUID(), sessionId: sessId }), dec('block', 0.7));
    // tool_C: 2 allows (no blocks)
    await ctx.logger.log(makeOp('agent-X', 'tool_C', { id: crypto.randomUUID(), sessionId: sessId }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-X', 'tool_C', { id: crypto.randomUUID(), sessionId: sessId }), dec('allow', 0.15));
  }

  it('9. GET /agents/:agentId returns 200', async () => {
    ctx = await setup();
    await seedAgentXOps(ctx);

    const { status } = await getJSON(ctx.port, '/agents/agent-X');
    expect(status).toBe(200);
  });

  it('10. response includes topBlockedTools array', async () => {
    ctx = await setup();
    await seedAgentXOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-X');
    const b = body as Record<string, unknown>;
    expect(b['topBlockedTools']).toBeDefined();
    expect(Array.isArray(b['topBlockedTools'])).toBe(true);
  });

  it('11. topBlockedTools[0].tool === "tool_A"', async () => {
    ctx = await setup();
    await seedAgentXOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-X');
    const b = body as { topBlockedTools: Array<{ tool: string; blocked: number }> };
    expect(b.topBlockedTools[0]!.tool).toBe('tool_A');
  });

  it('12. topBlockedTools[0].blocked === 3', async () => {
    ctx = await setup();
    await seedAgentXOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-X');
    const b = body as { topBlockedTools: Array<{ tool: string; blocked: number }> };
    expect(b.topBlockedTools[0]!.blocked).toBe(3);
  });

  it('13. topBlockedTools[1].tool === "tool_B"', async () => {
    ctx = await setup();
    await seedAgentXOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-X');
    const b = body as { topBlockedTools: Array<{ tool: string; blocked: number }> };
    expect(b.topBlockedTools[1]!.tool).toBe('tool_B');
  });

  it('14. topBlockedTools[1].blocked === 1', async () => {
    ctx = await setup();
    await seedAgentXOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-X');
    const b = body as { topBlockedTools: Array<{ tool: string; blocked: number }> };
    expect(b.topBlockedTools[1]!.blocked).toBe(1);
  });

  it('15. tool_C does not appear in topBlockedTools (no blocks)', async () => {
    ctx = await setup();
    await seedAgentXOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-X');
    const b = body as { topBlockedTools: Array<{ tool: string }> };
    const toolNames = b.topBlockedTools.map(t => t.tool);
    expect(toolNames).not.toContain('tool_C');
  });

  it('16. topBlockedTools has at most 5 entries', async () => {
    ctx = await setup();
    await seedAgentXOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-X');
    const b = body as { topBlockedTools: unknown[] };
    expect(b.topBlockedTools.length).toBeLessThanOrEqual(5);
  });

  it('17. topBlockedTools is sorted by blocked count descending', async () => {
    ctx = await setup();
    await seedAgentXOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-X');
    const b = body as { topBlockedTools: Array<{ blocked: number }> };
    const counts = b.topBlockedTools.map(t => t.blocked);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]!);
    }
  });

  it('18. agent with no blocks has empty topBlockedTools', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-no-blocks', 'tool_X', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-no-blocks', 'tool_Y', { id: crypto.randomUUID() }), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/agents/agent-no-blocks');
    const b = body as { topBlockedTools: unknown[] };
    expect(Array.isArray(b.topBlockedTools)).toBe(true);
    expect(b.topBlockedTools).toHaveLength(0);
  });
});

// ── T461 — GET /tools/:tool returns riskBuckets ───────────────────────────────

describe('GET /tools/:tool — riskBuckets (T461)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed 5 ops for tool='io_write' with risks 0.1, 0.3, 0.5, 0.7, 0.9.
   * Each falls into a distinct bucket:
   *   0.1 → '0.0-0.2'
   *   0.3 → '0.2-0.4'
   *   0.5 → '0.4-0.6'
   *   0.7 → '0.6-0.8'
   *   0.9 → '0.8-1.0'
   */
  async function seedToolBuckets(ctx: Ctx): Promise<void> {
    await ctx.logger.log(makeOp('agent-a', 'io_write', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'io_write', { id: crypto.randomUUID() }), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-a', 'io_write', { id: crypto.randomUUID() }), dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-b', 'io_write', { id: crypto.randomUUID() }), dec('block', 0.7));
    await ctx.logger.log(makeOp('agent-b', 'io_write', { id: crypto.randomUUID() }), dec('block', 0.9));
  }

  it('19. GET /tools/:tool returns 200', async () => {
    ctx = await setup();
    await seedToolBuckets(ctx);

    const { status } = await getJSON(ctx.port, '/tools/io_write');
    expect(status).toBe(200);
  });

  it('20. response includes riskBuckets object', async () => {
    ctx = await setup();
    await seedToolBuckets(ctx);

    const { body } = await getJSON(ctx.port, '/tools/io_write');
    const b = body as Record<string, unknown>;
    expect(b['riskBuckets']).toBeDefined();
    expect(typeof b['riskBuckets']).toBe('object');
  });

  it('21. riskBuckets["0.0-0.2"] === 1 (risk 0.1)', async () => {
    ctx = await setup();
    await seedToolBuckets(ctx);

    const { body } = await getJSON(ctx.port, '/tools/io_write');
    const b = body as { riskBuckets: Record<string, number> };
    expect(b.riskBuckets['0.0-0.2']).toBe(1);
  });

  it('22. riskBuckets["0.8-1.0"] === 1 (risk 0.9)', async () => {
    ctx = await setup();
    await seedToolBuckets(ctx);

    const { body } = await getJSON(ctx.port, '/tools/io_write');
    const b = body as { riskBuckets: Record<string, number> };
    expect(b.riskBuckets['0.8-1.0']).toBe(1);
  });

  it('23. all 5 risk buckets are present in the response', async () => {
    ctx = await setup();
    await seedToolBuckets(ctx);

    const { body } = await getJSON(ctx.port, '/tools/io_write');
    const b = body as { riskBuckets: Record<string, number> };
    const buckets = b.riskBuckets;
    expect(buckets['0.0-0.2']).toBeDefined();
    expect(buckets['0.2-0.4']).toBeDefined();
    expect(buckets['0.4-0.6']).toBeDefined();
    expect(buckets['0.6-0.8']).toBeDefined();
    expect(buckets['0.8-1.0']).toBeDefined();
  });

  it('24. all 5 bucket counts sum to 5 (total ops)', async () => {
    ctx = await setup();
    await seedToolBuckets(ctx);

    const { body } = await getJSON(ctx.port, '/tools/io_write');
    const b = body as { riskBuckets: Record<string, number> };
    const total = Object.values(b.riskBuckets).reduce((acc, n) => acc + n, 0);
    expect(total).toBe(5);
  });

  it('25. riskBuckets["0.2-0.4"] === 1 (risk 0.3)', async () => {
    ctx = await setup();
    await seedToolBuckets(ctx);

    const { body } = await getJSON(ctx.port, '/tools/io_write');
    const b = body as { riskBuckets: Record<string, number> };
    expect(b.riskBuckets['0.2-0.4']).toBe(1);
  });

  it('26. riskBuckets["0.4-0.6"] === 1 (risk 0.5)', async () => {
    ctx = await setup();
    await seedToolBuckets(ctx);

    const { body } = await getJSON(ctx.port, '/tools/io_write');
    const b = body as { riskBuckets: Record<string, number> };
    expect(b.riskBuckets['0.4-0.6']).toBe(1);
  });

  it('27. riskBuckets["0.6-0.8"] === 1 (risk 0.7)', async () => {
    ctx = await setup();
    await seedToolBuckets(ctx);

    const { body } = await getJSON(ctx.port, '/tools/io_write');
    const b = body as { riskBuckets: Record<string, number> };
    expect(b.riskBuckets['0.6-0.8']).toBe(1);
  });

  it('28. multiple ops in same bucket accumulate correctly', async () => {
    ctx = await setup();
    // Seed 3 low-risk ops: all go to '0.0-0.2'
    await ctx.logger.log(makeOp('agent-a', 'low_risk_tool', { id: crypto.randomUUID() }), dec('allow', 0.05));
    await ctx.logger.log(makeOp('agent-a', 'low_risk_tool', { id: crypto.randomUUID() }), dec('allow', 0.10));
    await ctx.logger.log(makeOp('agent-a', 'low_risk_tool', { id: crypto.randomUUID() }), dec('allow', 0.15));

    const { body } = await getJSON(ctx.port, '/tools/low_risk_tool');
    const b = body as { riskBuckets: Record<string, number> };
    expect(b.riskBuckets['0.0-0.2']).toBe(3);
    expect(b.riskBuckets['0.2-0.4']).toBe(0);
  });
});

// ── T462 — GET /operations/summary returns topBlockedTools[] ─────────────────

describe('GET /operations/summary — topBlockedTools[] (T462)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * delete_file: 3 blocks
   * read_file:   0 blocks (all allows)
   * write_file:  2 blocks
   * topBlockedTools should be [{tool:'delete_file', blocked:3}, {tool:'write_file', blocked:2}]
   * read_file should NOT appear.
   */
  async function seedSummaryBlocks(ctx: Ctx): Promise<void> {
    // delete_file: 3 blocks
    await ctx.logger.log(makeOp('agent-a', 'delete_file', { id: crypto.randomUUID() }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-a', 'delete_file', { id: crypto.randomUUID() }), dec('block', 0.85));
    await ctx.logger.log(makeOp('agent-b', 'delete_file', { id: crypto.randomUUID() }), dec('block', 0.95));
    // read_file: 0 blocks (all allows)
    await ctx.logger.log(makeOp('agent-a', 'read_file', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'read_file', { id: crypto.randomUUID() }), dec('allow', 0.15));
    // write_file: 2 blocks
    await ctx.logger.log(makeOp('agent-a', 'write_file', { id: crypto.randomUUID() }), dec('block', 0.75));
    await ctx.logger.log(makeOp('agent-b', 'write_file', { id: crypto.randomUUID() }), dec('block', 0.8));
  }

  it('29. GET /operations/summary returns 200', async () => {
    ctx = await setup();
    await seedSummaryBlocks(ctx);

    const { status } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
  });

  it('30. response includes topBlockedTools array', async () => {
    ctx = await setup();
    await seedSummaryBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as Record<string, unknown>;
    expect(b['topBlockedTools']).toBeDefined();
    expect(Array.isArray(b['topBlockedTools'])).toBe(true);
  });

  it('31. topBlockedTools[0].tool === "delete_file"', async () => {
    ctx = await setup();
    await seedSummaryBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedTools: Array<{ tool: string; blocked: number }> };
    expect(b.topBlockedTools[0]!.tool).toBe('delete_file');
  });

  it('32. topBlockedTools[0].blocked === 3', async () => {
    ctx = await setup();
    await seedSummaryBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedTools: Array<{ tool: string; blocked: number }> };
    expect(b.topBlockedTools[0]!.blocked).toBe(3);
  });

  it('33. topBlockedTools[1].tool === "write_file"', async () => {
    ctx = await setup();
    await seedSummaryBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedTools: Array<{ tool: string; blocked: number }> };
    expect(b.topBlockedTools[1]!.tool).toBe('write_file');
  });

  it('34. topBlockedTools[1].blocked === 2', async () => {
    ctx = await setup();
    await seedSummaryBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedTools: Array<{ tool: string; blocked: number }> };
    expect(b.topBlockedTools[1]!.blocked).toBe(2);
  });

  it('35. read_file does not appear in topBlockedTools (no blocks)', async () => {
    ctx = await setup();
    await seedSummaryBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedTools: Array<{ tool: string }> };
    const toolNames = b.topBlockedTools.map(t => t.tool);
    expect(toolNames).not.toContain('read_file');
  });

  it('36. topBlockedTools has at most 5 entries', async () => {
    ctx = await setup();
    await seedSummaryBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedTools: unknown[] };
    expect(b.topBlockedTools.length).toBeLessThanOrEqual(5);
  });

  it('37. topBlockedTools sorted descending by block count', async () => {
    ctx = await setup();
    await seedSummaryBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedTools: Array<{ blocked: number }> };
    const counts = b.topBlockedTools.map(t => t.blocked);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]!);
    }
  });

  it('38. topBlockedTools is empty when no ops are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'safe_tool', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'safe_tool', { id: crypto.randomUUID() }), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topBlockedTools: unknown[] };
    expect(Array.isArray(b.topBlockedTools)).toBe(true);
    expect(b.topBlockedTools).toHaveLength(0);
  });
});

// ── T463 — GET /sessions?sort=blockCount&order=desc|asc ──────────────────────

describe('GET /sessions?sort=blockCount (T463)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * session-A: 5 blocks
   * session-B: 1 block
   * order=desc → session-A first
   * order=asc  → session-B first
   */
  async function seedSessionBlocks(ctx: Ctx): Promise<void> {
    // session-A: 5 blocks
    for (let i = 0; i < 5; i++) {
      await ctx.logger.log(
        makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'session-A' }),
        dec('block', 0.8)
      );
    }
    // session-B: 1 block + 2 allows (blockCount = 1)
    await ctx.logger.log(
      makeOp('agent-b', 'tool-y', { id: crypto.randomUUID(), sessionId: 'session-B' }),
      dec('block', 0.7)
    );
    await ctx.logger.log(
      makeOp('agent-b', 'tool-y', { id: crypto.randomUUID(), sessionId: 'session-B' }),
      dec('allow', 0.2)
    );
    await ctx.logger.log(
      makeOp('agent-b', 'tool-z', { id: crypto.randomUUID(), sessionId: 'session-B' }),
      dec('allow', 0.15)
    );
  }

  it('39. GET /sessions?sort=blockCount&order=desc returns 200', async () => {
    ctx = await setup();
    await seedSessionBlocks(ctx);

    const { status } = await getJSON(ctx.port, '/sessions?sort=blockCount&order=desc');
    expect(status).toBe(200);
  });

  it('40. order=desc — data[0].sessionId === "session-A" (5 blocks)', async () => {
    ctx = await setup();
    await seedSessionBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?sort=blockCount&order=desc');
    const b = body as { data: Array<{ sessionId: string }> };
    expect(Array.isArray(b.data)).toBe(true);
    expect(b.data.length).toBeGreaterThanOrEqual(2);
    expect(b.data[0]!.sessionId).toBe('session-A');
  });

  it('41. order=desc — data[1].sessionId === "session-B" (1 block)', async () => {
    ctx = await setup();
    await seedSessionBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?sort=blockCount&order=desc');
    const b = body as { data: Array<{ sessionId: string }> };
    expect(b.data[1]!.sessionId).toBe('session-B');
  });

  it('42. order=asc — data[0].sessionId === "session-B" (1 block, lowest)', async () => {
    ctx = await setup();
    await seedSessionBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?sort=blockCount&order=asc');
    const b = body as { data: Array<{ sessionId: string }> };
    expect(Array.isArray(b.data)).toBe(true);
    expect(b.data[0]!.sessionId).toBe('session-B');
  });

  it('43. order=asc — data[1].sessionId === "session-A" (5 blocks, highest)', async () => {
    ctx = await setup();
    await seedSessionBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?sort=blockCount&order=asc');
    const b = body as { data: Array<{ sessionId: string }> };
    expect(b.data[1]!.sessionId).toBe('session-A');
  });

  it('44. session entries have a blocked field reflecting block count', async () => {
    ctx = await setup();
    await seedSessionBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?sort=blockCount&order=desc');
    const b = body as { data: Array<Record<string, unknown>> };
    for (const session of b.data) {
      expect(session['blocked']).toBeDefined();
      expect(typeof session['blocked']).toBe('number');
    }
  });

  it('45. session-A blocked count is 5 in the desc-sorted response', async () => {
    ctx = await setup();
    await seedSessionBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?sort=blockCount&order=desc');
    const b = body as { data: Array<{ sessionId: string; blocked: number }> };
    const sessA = b.data.find(s => s.sessionId === 'session-A');
    expect(sessA).toBeDefined();
    expect(sessA!.blocked).toBe(5);
  });

  it('46. session-B blocked count is 1 in the asc-sorted response', async () => {
    ctx = await setup();
    await seedSessionBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?sort=blockCount&order=asc');
    const b = body as { data: Array<{ sessionId: string; blocked: number }> };
    const sessB = b.data.find(s => s.sessionId === 'session-B');
    expect(sessB).toBeDefined();
    expect(sessB!.blocked).toBe(1);
  });

  it('47. blocked counts in desc order are non-increasing', async () => {
    ctx = await setup();
    await seedSessionBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?sort=blockCount&order=desc');
    const b = body as { data: Array<{ blocked: number }> };
    const counts = b.data.map(s => s.blocked);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]!);
    }
  });

  it('48. blocked counts in asc order are non-decreasing', async () => {
    ctx = await setup();
    await seedSessionBlocks(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?sort=blockCount&order=asc');
    const b = body as { data: Array<{ blocked: number }> };
    const counts = b.data.map(s => s.blocked);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]!);
    }
  });
});

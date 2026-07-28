/**
 * v0.61 tests
 *
 * T419 — GET /agents/:agentId returns topSessions[] sorted by op count desc
 * T420 — GET /tools/:tool returns topSessions[] sorted by op count desc
 * T421 — GET /operations/summary returns totalPending (alias for byAction.require_approval)
 * T422 — GET /agents returns sessionCount per agent (distinct sessionIds)
 * T423 — GET /tools returns sessionCount per tool (distinct sessionIds)
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import type { MCPOperation, OperationLog, ProxyDecision } from '../../src/types/interfaces.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeOp(agentId: string, tool: string, extra: Partial<MCPOperation> = {}): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId,
    tool,
    method: 'tools/call',
    params: {},
    timestamp: new Date(),
    sessionId: 'sess-default',
    ...extra,
  };
}

function dec(action: ProxyDecision['action'], riskScore: number): ProxyDecision {
  return { action, riskScore, reasons: [], checkpointId: undefined };
}

interface Ctx {
  store: StateStore;
  dash: DashboardAPI;
  port: number;
}

async function setup(): Promise<Ctx> {
  const store = new StateStore(':memory:');
  await store.initialize();
  const dash = new DashboardAPI(store, {});
  await dash.start(0);
  const port = ((dash as unknown as { server: http.Server }).server.address() as { port: number }).port;
  return { store, dash, port };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
}

async function getJSON(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

async function seed(
  ctx: Ctx,
  agentId: string,
  tool: string,
  action: ProxyDecision['action'],
  riskScore: number,
  sessionId?: string
): Promise<void> {
  const op = makeOp(agentId, tool, { sessionId });
  const log: OperationLog = {
    operationId: crypto.randomUUID(),
    operation: op,
    decision: dec(action, riskScore),
    createdAt: new Date(),
  };
  await ctx.store.saveOperationLog(log);
}

// ── T419 — GET /agents/:agentId returns topSessions[] ────────────────────────

describe('GET /agents/:agentId — topSessions (T419)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed 3 ops for agent-A in session-1, and 2 ops for agent-A in session-2.
   * topSessions[0] should be session-1 (count=3), topSessions[1] session-2 (count=2).
   */
  async function seedAgentSessions(ctx: Ctx): Promise<void> {
    await seed(ctx, 'agent-A', 'tool-x', 'allow', 0.1, 'session-1');
    await seed(ctx, 'agent-A', 'tool-y', 'allow', 0.2, 'session-1');
    await seed(ctx, 'agent-A', 'tool-z', 'allow', 0.3, 'session-1');
    await seed(ctx, 'agent-A', 'tool-x', 'allow', 0.1, 'session-2');
    await seed(ctx, 'agent-A', 'tool-y', 'allow', 0.2, 'session-2');
  }

  it('1. topSessions is present in GET /agents/:agentId response', async () => {
    ctx = await setup();
    await seedAgentSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents/agent-A');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['topSessions']).toBeDefined();
  });

  it('2. topSessions is an array', async () => {
    ctx = await setup();
    await seedAgentSessions(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-A');
    const b = body as { topSessions: unknown };
    expect(Array.isArray(b.topSessions)).toBe(true);
  });

  it('3. topSessions[0].sessionId === session-1 (highest op count)', async () => {
    ctx = await setup();
    await seedAgentSessions(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-A');
    const b = body as { topSessions: Array<{ sessionId: string; count: number }> };
    expect(b.topSessions[0]!.sessionId).toBe('session-1');
  });

  it('4. topSessions[0].count === 3', async () => {
    ctx = await setup();
    await seedAgentSessions(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-A');
    const b = body as { topSessions: Array<{ sessionId: string; count: number }> };
    expect(b.topSessions[0]!.count).toBe(3);
  });

  it('5. topSessions[1].sessionId === session-2', async () => {
    ctx = await setup();
    await seedAgentSessions(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-A');
    const b = body as { topSessions: Array<{ sessionId: string; count: number }> };
    expect(b.topSessions[1]!.sessionId).toBe('session-2');
  });

  it('6. topSessions[1].count === 2', async () => {
    ctx = await setup();
    await seedAgentSessions(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-A');
    const b = body as { topSessions: Array<{ sessionId: string; count: number }> };
    expect(b.topSessions[1]!.count).toBe(2);
  });

  it('7. topSessions contains at most 5 entries', async () => {
    ctx = await setup();
    // Seed 6 distinct sessions (1 op each)
    for (let i = 1; i <= 6; i++) {
      await seed(ctx, 'agent-A', 'tool-x', 'allow', 0.1, `sess-many-${i}`);
    }

    const { body } = await getJSON(ctx.port, '/agents/agent-A');
    const b = body as { topSessions: unknown[] };
    expect(b.topSessions.length).toBeLessThanOrEqual(5);
  });

  it('8. topSessions entries have both sessionId and count fields', async () => {
    ctx = await setup();
    await seedAgentSessions(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-A');
    const b = body as { topSessions: Array<Record<string, unknown>> };
    for (const entry of b.topSessions) {
      expect(typeof entry['sessionId']).toBe('string');
      expect(typeof entry['count']).toBe('number');
    }
  });
});

// ── T420 — GET /tools/:tool returns topSessions[] ────────────────────────────

describe('GET /tools/:tool — topSessions (T420)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed 4 ops with tool='file_write' in session-X, 1 op in session-Y.
   * topSessions[0] should be session-X (count=4).
   */
  async function seedToolSessions(ctx: Ctx): Promise<void> {
    await seed(ctx, 'agent-1', 'file_write', 'allow', 0.2, 'session-X');
    await seed(ctx, 'agent-2', 'file_write', 'allow', 0.3, 'session-X');
    await seed(ctx, 'agent-3', 'file_write', 'allow', 0.2, 'session-X');
    await seed(ctx, 'agent-4', 'file_write', 'allow', 0.1, 'session-X');
    await seed(ctx, 'agent-1', 'file_write', 'allow', 0.2, 'session-Y');
  }

  it('9. topSessions is present in GET /tools/:tool response', async () => {
    ctx = await setup();
    await seedToolSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools/file_write');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['topSessions']).toBeDefined();
  });

  it('10. topSessions is an array', async () => {
    ctx = await setup();
    await seedToolSessions(ctx);

    const { body } = await getJSON(ctx.port, '/tools/file_write');
    const b = body as { topSessions: unknown };
    expect(Array.isArray(b.topSessions)).toBe(true);
  });

  it('11. topSessions[0].sessionId === session-X (highest op count)', async () => {
    ctx = await setup();
    await seedToolSessions(ctx);

    const { body } = await getJSON(ctx.port, '/tools/file_write');
    const b = body as { topSessions: Array<{ sessionId: string; count: number }> };
    expect(b.topSessions[0]!.sessionId).toBe('session-X');
  });

  it('12. topSessions[0].count === 4', async () => {
    ctx = await setup();
    await seedToolSessions(ctx);

    const { body } = await getJSON(ctx.port, '/tools/file_write');
    const b = body as { topSessions: Array<{ sessionId: string; count: number }> };
    expect(b.topSessions[0]!.count).toBe(4);
  });

  it('13. topSessions is sorted descending by count', async () => {
    ctx = await setup();
    await seedToolSessions(ctx);

    const { body } = await getJSON(ctx.port, '/tools/file_write');
    const b = body as { topSessions: Array<{ sessionId: string; count: number }> };
    expect(b.topSessions.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < b.topSessions.length; i++) {
      expect(b.topSessions[i]!.count).toBeLessThanOrEqual(b.topSessions[i - 1]!.count);
    }
  });

  it('14. topSessions entries have both sessionId and count fields', async () => {
    ctx = await setup();
    await seedToolSessions(ctx);

    const { body } = await getJSON(ctx.port, '/tools/file_write');
    const b = body as { topSessions: Array<Record<string, unknown>> };
    for (const entry of b.topSessions) {
      expect(typeof entry['sessionId']).toBe('string');
      expect(typeof entry['count']).toBe('number');
    }
  });
});

// ── T421 — GET /operations/summary returns totalPending ──────────────────────

describe('GET /operations/summary — totalPending (T421)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('15. totalPending is present in GET /operations/summary response', async () => {
    ctx = await setup();
    await seed(ctx, 'agent-q', 'tool-a', 'require_approval', 0.7, 'sess-p');

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['totalPending']).toBeDefined();
  });

  it('16. totalPending === 2 when 2 require_approval ops are seeded', async () => {
    ctx = await setup();
    await seed(ctx, 'agent-q', 'tool-a', 'require_approval', 0.7, 'sess-p1');
    await seed(ctx, 'agent-q', 'tool-b', 'require_approval', 0.8, 'sess-p2');

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { totalPending: number };
    expect(b.totalPending).toBe(2);
  });

  it('17. totalPending === byAction.require_approval', async () => {
    ctx = await setup();
    await seed(ctx, 'agent-q', 'tool-a', 'require_approval', 0.7, 'sess-p1');
    await seed(ctx, 'agent-q', 'tool-b', 'require_approval', 0.8, 'sess-p2');
    await seed(ctx, 'agent-q', 'tool-c', 'allow', 0.1, 'sess-p3');

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { totalPending: number; byAction: { require_approval: number } };
    expect(b.totalPending).toBe(b.byAction.require_approval);
  });

  it('18. totalPending is 0 when no require_approval ops exist', async () => {
    ctx = await setup();
    await seed(ctx, 'agent-q', 'tool-a', 'allow', 0.1, 'sess-p1');
    await seed(ctx, 'agent-q', 'tool-b', 'block', 0.9, 'sess-p2');

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { totalPending: number };
    expect(b.totalPending).toBe(0);
  });

  it('19. totalPending is a number type', async () => {
    ctx = await setup();

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { totalPending: unknown };
    expect(typeof b.totalPending).toBe('number');
  });
});

// ── T422 — GET /agents returns sessionCount per agent ────────────────────────

describe('GET /agents — sessionCount per agent (T422)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * agent-B has ops in sessions 's1' and 's2' (2 distinct sessions).
   * agent-C has all ops in session 's3' (1 distinct session).
   */
  async function seedAgentListSessions(ctx: Ctx): Promise<void> {
    await seed(ctx, 'agent-B', 'tool-x', 'allow', 0.1, 's1');
    await seed(ctx, 'agent-B', 'tool-y', 'allow', 0.2, 's1');
    await seed(ctx, 'agent-B', 'tool-z', 'allow', 0.3, 's2');
    await seed(ctx, 'agent-C', 'tool-x', 'allow', 0.1, 's3');
    await seed(ctx, 'agent-C', 'tool-y', 'allow', 0.2, 's3');
  }

  it('20. sessionCount is present in GET /agents response entries', async () => {
    ctx = await setup();
    await seedAgentListSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as { agents: Array<Record<string, unknown>> };
    expect(b.agents.length).toBeGreaterThan(0);
    expect(b.agents[0]!['sessionCount']).toBeDefined();
  });

  it('21. agent-B has sessionCount === 2', async () => {
    ctx = await setup();
    await seedAgentListSessions(ctx);

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; sessionCount: number }> };
    const agentB = b.agents.find(a => a.agentId === 'agent-B');
    expect(agentB).toBeDefined();
    expect(agentB!.sessionCount).toBe(2);
  });

  it('22. agent-C has sessionCount === 1 (all ops in same session)', async () => {
    ctx = await setup();
    await seedAgentListSessions(ctx);

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; sessionCount: number }> };
    const agentC = b.agents.find(a => a.agentId === 'agent-C');
    expect(agentC).toBeDefined();
    expect(agentC!.sessionCount).toBe(1);
  });

  it('23. sessionCount is a number type for all agents', async () => {
    ctx = await setup();
    await seedAgentListSessions(ctx);

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ sessionCount: unknown }> };
    for (const agent of b.agents) {
      expect(typeof agent.sessionCount).toBe('number');
    }
  });

  it('24. sessionCount reflects distinct sessions (multiple ops in same session count once)', async () => {
    ctx = await setup();
    // 4 ops for agent-D but only 2 distinct sessions
    await seed(ctx, 'agent-D', 'tool-a', 'allow', 0.1, 'sess-d1');
    await seed(ctx, 'agent-D', 'tool-b', 'allow', 0.2, 'sess-d1');
    await seed(ctx, 'agent-D', 'tool-c', 'allow', 0.3, 'sess-d2');
    await seed(ctx, 'agent-D', 'tool-d', 'allow', 0.4, 'sess-d2');

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; sessionCount: number }> };
    const agentD = b.agents.find(a => a.agentId === 'agent-D');
    expect(agentD).toBeDefined();
    expect(agentD!.sessionCount).toBe(2);
  });
});

// ── T423 — GET /tools returns sessionCount per tool ──────────────────────────

describe('GET /tools — sessionCount per tool (T423)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * tool='bash_exec' is used in sessions 'sA' and 'sB' (2 distinct sessions).
   * tool='safe_read' is used only in session 'sA' (1 distinct session).
   */
  async function seedToolListSessions(ctx: Ctx): Promise<void> {
    await seed(ctx, 'agent-1', 'bash_exec', 'allow', 0.3, 'sA');
    await seed(ctx, 'agent-2', 'bash_exec', 'allow', 0.4, 'sA');
    await seed(ctx, 'agent-1', 'bash_exec', 'block', 0.8, 'sB');
    await seed(ctx, 'agent-1', 'safe_read', 'allow', 0.1, 'sA');
    await seed(ctx, 'agent-2', 'safe_read', 'allow', 0.1, 'sA');
  }

  it('25. sessionCount is present in GET /tools response entries', async () => {
    ctx = await setup();
    await seedToolListSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as { tools: Array<Record<string, unknown>> };
    expect(b.tools.length).toBeGreaterThan(0);
    expect(b.tools[0]!['sessionCount']).toBeDefined();
  });

  it('26. bash_exec has sessionCount === 2', async () => {
    ctx = await setup();
    await seedToolListSessions(ctx);

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string; sessionCount: number }> };
    const bashExec = b.tools.find(t => t.tool === 'bash_exec');
    expect(bashExec).toBeDefined();
    expect(bashExec!.sessionCount).toBe(2);
  });

  it('27. safe_read has sessionCount === 1 (all ops in same session)', async () => {
    ctx = await setup();
    await seedToolListSessions(ctx);

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string; sessionCount: number }> };
    const safeRead = b.tools.find(t => t.tool === 'safe_read');
    expect(safeRead).toBeDefined();
    expect(safeRead!.sessionCount).toBe(1);
  });

  it('28. sessionCount is a number type for all tools', async () => {
    ctx = await setup();
    await seedToolListSessions(ctx);

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ sessionCount: unknown }> };
    for (const tool of b.tools) {
      expect(typeof tool.sessionCount).toBe('number');
    }
  });

  it('29. sessionCount counts distinct sessions (multiple ops in same session count once)', async () => {
    ctx = await setup();
    // 3 ops for 'file_delete' but only 1 distinct session
    await seed(ctx, 'agent-x', 'file_delete', 'block', 0.9, 'sess-only');
    await seed(ctx, 'agent-y', 'file_delete', 'block', 0.85, 'sess-only');
    await seed(ctx, 'agent-z', 'file_delete', 'block', 0.95, 'sess-only');

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string; sessionCount: number }> };
    const fileDelete = b.tools.find(t => t.tool === 'file_delete');
    expect(fileDelete).toBeDefined();
    expect(fileDelete!.sessionCount).toBe(1);
  });
});

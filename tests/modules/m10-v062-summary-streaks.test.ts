/**
 * v0.62 tests
 *
 * T424 — GET /sessions returns totalRequireApproval in response
 * T425 — GET /operations/summary returns uniqueAgents
 * T426 — GET /operations/summary returns uniqueTools
 * T427 — GET /agents/:agentId returns blockStreak
 * T428 — GET /tools/:tool returns topMethods[]
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
    sessionId: undefined as unknown as string,
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
  extra: Partial<MCPOperation> = {},
  createdAt?: Date,
): Promise<void> {
  const op = makeOp(agentId, tool, extra);
  const log: OperationLog = {
    operationId: crypto.randomUUID(),
    operation: op,
    decision: dec(action, riskScore),
    createdAt: createdAt ?? new Date(),
  };
  await ctx.store.saveOperationLog(log);
}

// ── T424 — GET /sessions returns totalRequireApproval ────────────────────────

describe('GET /sessions — totalRequireApproval (T424)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. totalRequireApproval is present in GET /sessions response', async () => {
    ctx = await setup();
    await seed(ctx, 'agent-a', 'tool-x', 'require_approval', 0.7, { sessionId: 'sess-ra-1' });

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['totalRequireApproval']).toBeDefined();
  });

  it('2. totalRequireApproval equals count of require_approval ops when seeded', async () => {
    ctx = await setup();
    await seed(ctx, 'agent-a', 'tool-x', 'require_approval', 0.7, { sessionId: 'sess-ra-1' });
    await seed(ctx, 'agent-b', 'tool-y', 'require_approval', 0.8, { sessionId: 'sess-ra-2' });
    await seed(ctx, 'agent-a', 'tool-z', 'allow',            0.1, { sessionId: 'sess-ra-1' });
    await seed(ctx, 'agent-b', 'tool-w', 'block',            0.9, { sessionId: 'sess-ra-2' });

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalRequireApproval: number };
    expect(b.totalRequireApproval).toBe(2);
  });

  it('3. totalRequireApproval is 0 when no require_approval ops exist', async () => {
    ctx = await setup();
    await seed(ctx, 'agent-a', 'tool-x', 'allow', 0.1, { sessionId: 'sess-no-ra' });
    await seed(ctx, 'agent-a', 'tool-y', 'block', 0.9, { sessionId: 'sess-no-ra' });

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalRequireApproval: number };
    expect(b.totalRequireApproval).toBe(0);
  });

  it('4. totalRequireApproval is a number type', async () => {
    ctx = await setup();

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalRequireApproval: unknown };
    expect(typeof b.totalRequireApproval).toBe('number');
  });

  it('5. totalRequireApproval aggregates across all sessions', async () => {
    ctx = await setup();
    // 3 require_approval ops across different sessions
    await seed(ctx, 'agent-a', 'tool-x', 'require_approval', 0.7, { sessionId: 'sess-1' });
    await seed(ctx, 'agent-b', 'tool-y', 'require_approval', 0.75, { sessionId: 'sess-2' });
    await seed(ctx, 'agent-c', 'tool-z', 'require_approval', 0.8, { sessionId: 'sess-3' });
    // Other action types
    await seed(ctx, 'agent-a', 'tool-w', 'allow', 0.1, { sessionId: 'sess-1' });
    await seed(ctx, 'agent-b', 'tool-v', 'block', 0.9, { sessionId: 'sess-2' });

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalRequireApproval: number };
    expect(b.totalRequireApproval).toBe(3);
  });
});

// ── T425/T426 — GET /operations/summary returns uniqueAgents and uniqueTools ──

describe('GET /operations/summary — uniqueAgents and uniqueTools (T425/T426)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed ops from 2 different agents using 3 different tools.
   */
  async function seedUniqueAgentsTools(ctx: Ctx): Promise<void> {
    // agent-alpha uses tool-1 and tool-2
    await seed(ctx, 'agent-alpha', 'tool-1', 'allow', 0.1, { sessionId: 'sess-u1' });
    await seed(ctx, 'agent-alpha', 'tool-2', 'allow', 0.2, { sessionId: 'sess-u1' });
    // agent-beta uses tool-2 and tool-3
    await seed(ctx, 'agent-beta', 'tool-2', 'block', 0.8, { sessionId: 'sess-u2' });
    await seed(ctx, 'agent-beta', 'tool-3', 'allow', 0.3, { sessionId: 'sess-u2' });
  }

  it('6. uniqueAgents is present in GET /operations/summary response', async () => {
    ctx = await setup();
    await seedUniqueAgentsTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['uniqueAgents']).toBeDefined();
  });

  it('7. uniqueAgents === 2 when 2 distinct agents are seeded', async () => {
    ctx = await setup();
    await seedUniqueAgentsTools(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { uniqueAgents: number };
    expect(b.uniqueAgents).toBe(2);
  });

  it('8. uniqueTools is present in GET /operations/summary response', async () => {
    ctx = await setup();
    await seedUniqueAgentsTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['uniqueTools']).toBeDefined();
  });

  it('9. uniqueTools === 3 when 3 distinct tools are seeded', async () => {
    ctx = await setup();
    await seedUniqueAgentsTools(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { uniqueTools: number };
    expect(b.uniqueTools).toBe(3);
  });

  it('10. uniqueAgents is a number type', async () => {
    ctx = await setup();
    await seedUniqueAgentsTools(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { uniqueAgents: unknown };
    expect(typeof b.uniqueAgents).toBe('number');
  });

  it('11. uniqueTools is a number type', async () => {
    ctx = await setup();
    await seedUniqueAgentsTools(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { uniqueTools: unknown };
    expect(typeof b.uniqueTools).toBe('number');
  });

  it('12. uniqueAgents counts distinct agents (multiple ops from same agent count once)', async () => {
    ctx = await setup();
    // 5 ops but only 1 agent
    await seed(ctx, 'agent-solo', 'tool-a', 'allow', 0.1, { sessionId: 'sess-s1' });
    await seed(ctx, 'agent-solo', 'tool-b', 'allow', 0.2, { sessionId: 'sess-s1' });
    await seed(ctx, 'agent-solo', 'tool-c', 'block', 0.8, { sessionId: 'sess-s2' });

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { uniqueAgents: number };
    expect(b.uniqueAgents).toBe(1);
  });

  it('13. uniqueTools counts distinct tools (multiple ops using same tool count once)', async () => {
    ctx = await setup();
    // 4 ops but only 2 tools
    await seed(ctx, 'agent-a', 'tool-dup', 'allow', 0.1, { sessionId: 'sess-d1' });
    await seed(ctx, 'agent-b', 'tool-dup', 'allow', 0.2, { sessionId: 'sess-d1' });
    await seed(ctx, 'agent-c', 'tool-other', 'block', 0.8, { sessionId: 'sess-d2' });
    await seed(ctx, 'agent-d', 'tool-other', 'allow', 0.3, { sessionId: 'sess-d2' });

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { uniqueTools: number };
    expect(b.uniqueTools).toBe(2);
  });

  it('14. uniqueAgents is 0 when no ops exist', async () => {
    ctx = await setup();

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { uniqueAgents: number };
    expect(b.uniqueAgents).toBe(0);
  });

  it('15. uniqueTools is 0 when no ops exist', async () => {
    ctx = await setup();

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { uniqueTools: number };
    expect(b.uniqueTools).toBe(0);
  });
});

// ── T427 — GET /agents/:agentId returns blockStreak ──────────────────────────

describe('GET /agents/:agentId — blockStreak (T427)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Logs are returned DESC by createdAt (most recent first).
   * To get blockStreak=3, the 3 most recent ops must be blocked.
   * Seed oldest → newest: allow, block, block, block.
   */
  async function seedBlockStreak(ctx: Ctx): Promise<void> {
    const now = Date.now();
    await seed(ctx, 'agent-streak', 'tool-x', 'allow', 0.1, { sessionId: 'sess-str' }, new Date(now - 3000));
    await seed(ctx, 'agent-streak', 'tool-x', 'block', 0.8, { sessionId: 'sess-str' }, new Date(now - 2000));
    await seed(ctx, 'agent-streak', 'tool-x', 'block', 0.85, { sessionId: 'sess-str' }, new Date(now - 1000));
    await seed(ctx, 'agent-streak', 'tool-x', 'block', 0.9, { sessionId: 'sess-str' }, new Date(now));
  }

  it('16. blockStreak is present in GET /agents/:agentId response', async () => {
    ctx = await setup();
    await seedBlockStreak(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents/agent-streak');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['blockStreak']).toBeDefined();
  });

  it('17. blockStreak === 3 when the 3 most recent ops are blocked', async () => {
    ctx = await setup();
    await seedBlockStreak(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-streak');
    const b = body as { blockStreak: number };
    expect(b.blockStreak).toBe(3);
  });

  it('18. blockStreak is 0 when the most recent op is allowed', async () => {
    ctx = await setup();
    const now = Date.now();
    // block then allow (allow is most recent)
    await seed(ctx, 'agent-no-streak', 'tool-x', 'block', 0.9, { sessionId: 'sess-ns' }, new Date(now - 1000));
    await seed(ctx, 'agent-no-streak', 'tool-x', 'allow', 0.1, { sessionId: 'sess-ns' }, new Date(now));

    const { body } = await getJSON(ctx.port, '/agents/agent-no-streak');
    const b = body as { blockStreak: number };
    expect(b.blockStreak).toBe(0);
  });

  it('19. blockStreak is 1 when only the most recent op is blocked', async () => {
    ctx = await setup();
    const now = Date.now();
    await seed(ctx, 'agent-one-streak', 'tool-x', 'allow', 0.1, { sessionId: 'sess-os' }, new Date(now - 2000));
    await seed(ctx, 'agent-one-streak', 'tool-x', 'allow', 0.2, { sessionId: 'sess-os' }, new Date(now - 1000));
    await seed(ctx, 'agent-one-streak', 'tool-x', 'block', 0.9, { sessionId: 'sess-os' }, new Date(now));

    const { body } = await getJSON(ctx.port, '/agents/agent-one-streak');
    const b = body as { blockStreak: number };
    expect(b.blockStreak).toBe(1);
  });

  it('20. blockStreak is a number type', async () => {
    ctx = await setup();
    await seedBlockStreak(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-streak');
    const b = body as { blockStreak: unknown };
    expect(typeof b.blockStreak).toBe('number');
  });

  it('21. blockStreak stops counting when a non-block op is encountered', async () => {
    ctx = await setup();
    const now = Date.now();
    // allow, block, allow, block, block (most recent = block, block, allow → streak=2)
    await seed(ctx, 'agent-mixed', 'tool-x', 'allow', 0.1, { sessionId: 'sess-mx' }, new Date(now - 4000));
    await seed(ctx, 'agent-mixed', 'tool-x', 'block', 0.9, { sessionId: 'sess-mx' }, new Date(now - 3000));
    await seed(ctx, 'agent-mixed', 'tool-x', 'allow', 0.2, { sessionId: 'sess-mx' }, new Date(now - 2000));
    await seed(ctx, 'agent-mixed', 'tool-x', 'block', 0.85, { sessionId: 'sess-mx' }, new Date(now - 1000));
    await seed(ctx, 'agent-mixed', 'tool-x', 'block', 0.88, { sessionId: 'sess-mx' }, new Date(now));

    const { body } = await getJSON(ctx.port, '/agents/agent-mixed');
    const b = body as { blockStreak: number };
    expect(b.blockStreak).toBe(2);
  });
});

// ── T428 — GET /tools/:tool returns topMethods[] ──────────────────────────────

describe('GET /tools/:tool — topMethods (T428)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed 3 ops with tool='shell_exec' using method='tools/call',
   * and 2 ops using method='resources/read'.
   */
  async function seedToolMethods(ctx: Ctx): Promise<void> {
    await seed(ctx, 'agent-a', 'shell_exec', 'allow', 0.5, { method: 'tools/call',    sessionId: 'sess-tm' });
    await seed(ctx, 'agent-b', 'shell_exec', 'allow', 0.5, { method: 'tools/call',    sessionId: 'sess-tm' });
    await seed(ctx, 'agent-c', 'shell_exec', 'allow', 0.5, { method: 'tools/call',    sessionId: 'sess-tm' });
    await seed(ctx, 'agent-a', 'shell_exec', 'block', 0.8, { method: 'resources/read', sessionId: 'sess-tm' });
    await seed(ctx, 'agent-b', 'shell_exec', 'block', 0.8, { method: 'resources/read', sessionId: 'sess-tm' });
  }

  it('22. topMethods is present in GET /tools/:tool response', async () => {
    ctx = await setup();
    await seedToolMethods(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools/shell_exec');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['topMethods']).toBeDefined();
  });

  it('23. topMethods is an array', async () => {
    ctx = await setup();
    await seedToolMethods(ctx);

    const { body } = await getJSON(ctx.port, '/tools/shell_exec');
    const b = body as { topMethods: unknown };
    expect(Array.isArray(b.topMethods)).toBe(true);
  });

  it('24. topMethods[0].method === tools/call (highest count)', async () => {
    ctx = await setup();
    await seedToolMethods(ctx);

    const { body } = await getJSON(ctx.port, '/tools/shell_exec');
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    expect(b.topMethods[0]!.method).toBe('tools/call');
  });

  it('25. topMethods[0].count === 3', async () => {
    ctx = await setup();
    await seedToolMethods(ctx);

    const { body } = await getJSON(ctx.port, '/tools/shell_exec');
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    expect(b.topMethods[0]!.count).toBe(3);
  });

  it('26. topMethods[1].method === resources/read', async () => {
    ctx = await setup();
    await seedToolMethods(ctx);

    const { body } = await getJSON(ctx.port, '/tools/shell_exec');
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    expect(b.topMethods[1]!.method).toBe('resources/read');
  });

  it('27. topMethods[1].count === 2', async () => {
    ctx = await setup();
    await seedToolMethods(ctx);

    const { body } = await getJSON(ctx.port, '/tools/shell_exec');
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    expect(b.topMethods[1]!.count).toBe(2);
  });

  it('28. topMethods is sorted descending by count', async () => {
    ctx = await setup();
    await seedToolMethods(ctx);

    const { body } = await getJSON(ctx.port, '/tools/shell_exec');
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    expect(b.topMethods.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < b.topMethods.length; i++) {
      expect(b.topMethods[i]!.count).toBeLessThanOrEqual(b.topMethods[i - 1]!.count);
    }
  });

  it('29. topMethods entries have both method and count fields', async () => {
    ctx = await setup();
    await seedToolMethods(ctx);

    const { body } = await getJSON(ctx.port, '/tools/shell_exec');
    const b = body as { topMethods: Array<Record<string, unknown>> };
    for (const entry of b.topMethods) {
      expect(typeof entry['method']).toBe('string');
      expect(typeof entry['count']).toBe('number');
    }
  });

  it('30. topMethods contains at most 5 entries', async () => {
    ctx = await setup();
    // Seed 6 distinct methods
    const methods = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    for (const m of methods) {
      await seed(ctx, 'agent-a', 'shell_many', 'allow', 0.2, { method: m, sessionId: 'sess-many' });
    }

    const { body } = await getJSON(ctx.port, '/tools/shell_many');
    const b = body as { topMethods: unknown[] };
    expect(b.topMethods.length).toBeLessThanOrEqual(5);
  });
});

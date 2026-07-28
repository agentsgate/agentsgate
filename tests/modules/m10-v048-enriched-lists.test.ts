/**
 * v0.48 tests
 *
 * T354 — GET /agents list entries include `firstSeen` field (ISO string);
 *         firstSeen <= lastSeen
 * T355 — GET /tools list entries include `firstSeen` and `lastSeen` fields;
 *         both present, firstSeen <= lastSeen
 * T356 — GET /sessions list entries include `avgRisk` field (number 0-1);
 *         correct calculation
 * T357 — GET /telemetry/agents?q=agent-a returns only matching agents;
 *         empty q returns all
 * T358 — GET /telemetry/tools?q=fs returns only matching tools;
 *         empty q returns all
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

// ── T354 — GET /agents firstSeen field ───────────────────────────────────────

describe('GET /agents firstSeen field (T354)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. each agent entry includes a firstSeen field that is a valid ISO string', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-alpha', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-beta', 'db'), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as { agents: Array<Record<string, unknown>> };
    expect(b.agents.length).toBeGreaterThanOrEqual(2);

    for (const agent of b.agents) {
      expect(typeof agent['firstSeen']).toBe('string');
      const d = new Date(agent['firstSeen'] as string);
      expect(d.getTime()).not.toBeNaN();
    }
  });

  it('2. firstSeen is earlier than or equal to lastSeen for each agent', async () => {
    ctx = await setup();
    const t1 = new Date('2025-01-01T10:00:00.000Z');
    const t2 = new Date('2025-01-01T11:00:00.000Z');

    await ctx.logger.log(
      makeOp('agent-time', 'fs', { timestamp: t1, id: crypto.randomUUID() }),
      dec('allow', 0.2)
    );
    await ctx.logger.log(
      makeOp('agent-time', 'db', { timestamp: t2, id: crypto.randomUUID() }),
      dec('allow', 0.3)
    );

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; firstSeen: string; lastSeen: string }> };
    const agent = b.agents.find(a => a.agentId === 'agent-time');
    expect(agent).toBeDefined();
    expect(new Date(agent!.firstSeen).getTime()).toBeLessThanOrEqual(
      new Date(agent!.lastSeen).getTime()
    );
    expect(agent!.firstSeen).toBe(t1.toISOString());
    expect(agent!.lastSeen).toBe(t2.toISOString());
  });

  it('3. agent with a single op has firstSeen equal to lastSeen', async () => {
    ctx = await setup();
    const ts = new Date('2025-06-15T08:30:00.000Z');
    await ctx.logger.log(
      makeOp('agent-single', 'tool-x', { timestamp: ts, id: crypto.randomUUID() }),
      dec('allow', 0.1)
    );

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; firstSeen: string; lastSeen: string }> };
    const agent = b.agents.find(a => a.agentId === 'agent-single');
    expect(agent).toBeDefined();
    expect(agent!.firstSeen).toBe(ts.toISOString());
    expect(agent!.lastSeen).toBe(ts.toISOString());
    expect(agent!.firstSeen).toBe(agent!.lastSeen);
  });

  it('4. firstSeen is the earliest timestamp across multiple ops for the same agent', async () => {
    ctx = await setup();
    const early = new Date('2025-01-01T06:00:00.000Z');
    const mid   = new Date('2025-01-01T12:00:00.000Z');
    const late  = new Date('2025-01-01T18:00:00.000Z');

    // Log in non-chronological order to confirm min is taken
    await ctx.logger.log(makeOp('agent-multi', 'fs', { timestamp: mid, id: crypto.randomUUID() }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-multi', 'db', { timestamp: early, id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-multi', 'net', { timestamp: late, id: crypto.randomUUID() }), dec('block', 0.8));

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; firstSeen: string; lastSeen: string }> };
    const agent = b.agents.find(a => a.agentId === 'agent-multi');
    expect(agent).toBeDefined();
    expect(agent!.firstSeen).toBe(early.toISOString());
    expect(agent!.lastSeen).toBe(late.toISOString());
  });

  it('5. multiple distinct agents all have valid firstSeen <= lastSeen', async () => {
    ctx = await setup();
    for (const id of ['ag-1', 'ag-2', 'ag-3']) {
      await ctx.logger.log(makeOp(id, 'fs'), dec('allow', 0.2));
      await ctx.logger.log(makeOp(id, 'db'), dec('block', 0.7));
    }

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; firstSeen: string; lastSeen: string }> };
    for (const agent of b.agents) {
      expect(typeof agent.firstSeen).toBe('string');
      expect(typeof agent.lastSeen).toBe('string');
      expect(new Date(agent.firstSeen).getTime()).toBeLessThanOrEqual(
        new Date(agent.lastSeen).getTime()
      );
    }
  });
});

// ── T355 — GET /tools firstSeen and lastSeen fields ───────────────────────────

describe('GET /tools firstSeen and lastSeen fields (T355)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('6. each tool entry includes firstSeen and lastSeen fields that are valid ISO strings', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs-read'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'db-query'), dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as { tools: Array<Record<string, unknown>> };
    expect(b.tools.length).toBeGreaterThanOrEqual(2);

    for (const tool of b.tools) {
      expect(typeof tool['firstSeen']).toBe('string');
      expect(typeof tool['lastSeen']).toBe('string');
      expect(new Date(tool['firstSeen'] as string).getTime()).not.toBeNaN();
      expect(new Date(tool['lastSeen'] as string).getTime()).not.toBeNaN();
    }
  });

  it('7. firstSeen <= lastSeen for each tool entry', async () => {
    ctx = await setup();
    const t1 = new Date('2025-03-01T09:00:00.000Z');
    const t2 = new Date('2025-03-01T10:00:00.000Z');

    await ctx.logger.log(
      makeOp('agent-a', 'fs-write', { timestamp: t1, id: crypto.randomUUID() }),
      dec('allow', 0.3)
    );
    await ctx.logger.log(
      makeOp('agent-a', 'fs-write', { timestamp: t2, id: crypto.randomUUID() }),
      dec('block', 0.8)
    );

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string; firstSeen: string; lastSeen: string }> };
    const tool = b.tools.find(t => t.tool === 'fs-write');
    expect(tool).toBeDefined();
    expect(new Date(tool!.firstSeen).getTime()).toBeLessThanOrEqual(
      new Date(tool!.lastSeen).getTime()
    );
    expect(tool!.firstSeen).toBe(t1.toISOString());
    expect(tool!.lastSeen).toBe(t2.toISOString());
  });

  it('8. tool with a single op has firstSeen equal to lastSeen', async () => {
    ctx = await setup();
    const ts = new Date('2025-07-04T12:00:00.000Z');
    await ctx.logger.log(
      makeOp('agent-a', 'tool-once', { timestamp: ts, id: crypto.randomUUID() }),
      dec('allow', 0.15)
    );

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string; firstSeen: string; lastSeen: string }> };
    const tool = b.tools.find(t => t.tool === 'tool-once');
    expect(tool).toBeDefined();
    expect(tool!.firstSeen).toBe(ts.toISOString());
    expect(tool!.lastSeen).toBe(ts.toISOString());
    expect(tool!.firstSeen).toBe(tool!.lastSeen);
  });

  it('9. firstSeen reflects earliest use of tool across all agents', async () => {
    ctx = await setup();
    const early = new Date('2025-02-01T00:00:00.000Z');
    const late  = new Date('2025-02-01T23:59:00.000Z');

    await ctx.logger.log(makeOp('agent-b', 'shared-tool', { timestamp: late, id: crypto.randomUUID() }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'shared-tool', { timestamp: early, id: crypto.randomUUID() }), dec('allow', 0.1));

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string; firstSeen: string; lastSeen: string }> };
    const tool = b.tools.find(t => t.tool === 'shared-tool');
    expect(tool).toBeDefined();
    expect(tool!.firstSeen).toBe(early.toISOString());
    expect(tool!.lastSeen).toBe(late.toISOString());
  });

  it('10. all returned tools have firstSeen and lastSeen as strings where firstSeen <= lastSeen', async () => {
    ctx = await setup();
    for (const name of ['tool-a', 'tool-b', 'tool-c']) {
      await ctx.logger.log(makeOp('agent-a', name), dec('allow', 0.2));
      await ctx.logger.log(makeOp('agent-b', name), dec('block', 0.7));
    }

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string; firstSeen: string; lastSeen: string }> };
    for (const t of b.tools) {
      expect(typeof t.firstSeen).toBe('string');
      expect(typeof t.lastSeen).toBe('string');
      expect(new Date(t.firstSeen).getTime()).toBeLessThanOrEqual(
        new Date(t.lastSeen).getTime()
      );
    }
  });
});

// ── T356 — GET /sessions avgRisk field ───────────────────────────────────────

describe('GET /sessions avgRisk field (T356)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('11. each session entry includes an avgRisk field that is a number', async () => {
    ctx = await setup();
    await ctx.logger.log(
      makeOp('agent-a', 'fs', { sessionId: 'session-x' }),
      dec('allow', 0.4)
    );

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { data: Array<Record<string, unknown>> };
    expect(Array.isArray(b.data)).toBe(true);
    expect(b.data.length).toBeGreaterThanOrEqual(1);

    for (const session of b.data) {
      expect(typeof session['avgRisk']).toBe('number');
    }
  });

  it('12. avgRisk is between 0 and 1 inclusive', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-low' }), dec('allow', 0.0));
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-hi' }), dec('block', 1.0));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { data: Array<{ sessionId: string; avgRisk: number }> };
    for (const s of b.data) {
      expect(s.avgRisk).toBeGreaterThanOrEqual(0);
      expect(s.avgRisk).toBeLessThanOrEqual(1);
    }
  });

  it('13. avgRisk calculated correctly as mean riskScore for single-op session', async () => {
    ctx = await setup();
    await ctx.logger.log(
      makeOp('agent-a', 'fs', { sessionId: 'sess-single', id: crypto.randomUUID() }),
      dec('allow', 0.65)
    );

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { data: Array<{ sessionId: string; avgRisk: number }> };
    const sess = b.data.find(s => s.sessionId === 'sess-single');
    expect(sess).toBeDefined();
    expect(sess!.avgRisk).toBeCloseTo(0.65, 5);
  });

  it('14. avgRisk calculated correctly as mean riskScore across multiple ops', async () => {
    ctx = await setup();
    // 3 ops with riskScores 0.2, 0.4, 0.9 => avg = (0.2+0.4+0.9)/3 = 0.5
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-avg', id: crypto.randomUUID() }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'db', { sessionId: 'sess-avg', id: crypto.randomUUID() }), dec('allow', 0.4));
    await ctx.logger.log(makeOp('agent-a', 'net', { sessionId: 'sess-avg', id: crypto.randomUUID() }), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { data: Array<{ sessionId: string; avgRisk: number }> };
    const sess = b.data.find(s => s.sessionId === 'sess-avg');
    expect(sess).toBeDefined();
    expect(sess!.avgRisk).toBeCloseTo((0.2 + 0.4 + 0.9) / 3, 5);
  });

  it('15. avgRisk is independent per session — two sessions computed separately', async () => {
    ctx = await setup();
    // sess-low: 2 ops at risk 0.1, 0.1 => avg = 0.1
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-low', id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-low', id: crypto.randomUUID() }), dec('allow', 0.1));
    // sess-high: 2 ops at risk 0.8, 0.8 => avg = 0.8
    await ctx.logger.log(makeOp('agent-b', 'fs', { sessionId: 'sess-high', id: crypto.randomUUID() }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-b', 'fs', { sessionId: 'sess-high', id: crypto.randomUUID() }), dec('block', 0.8));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { data: Array<{ sessionId: string; avgRisk: number }> };
    const low  = b.data.find(s => s.sessionId === 'sess-low');
    const high = b.data.find(s => s.sessionId === 'sess-high');
    expect(low).toBeDefined();
    expect(high).toBeDefined();
    expect(low!.avgRisk).toBeCloseTo(0.1, 5);
    expect(high!.avgRisk).toBeCloseTo(0.8, 5);
  });

  it('16. avgRisk with mixed actions (allow, block, require_approval) uses all op riskScores', async () => {
    ctx = await setup();
    // riskScores: 0.1 (allow), 0.7 (block), 0.5 (require_approval) => avg = 0.4333...
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-mixed', id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'db', { sessionId: 'sess-mixed', id: crypto.randomUUID() }), dec('block', 0.7));
    await ctx.logger.log(makeOp('agent-a', 'net', { sessionId: 'sess-mixed', id: crypto.randomUUID() }), dec('require_approval', 0.5));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { data: Array<{ sessionId: string; avgRisk: number }> };
    const sess = b.data.find(s => s.sessionId === 'sess-mixed');
    expect(sess).toBeDefined();
    expect(sess!.avgRisk).toBeCloseTo((0.1 + 0.7 + 0.5) / 3, 5);
  });
});

// ── T357 — GET /telemetry/agents?q= search filter ────────────────────────────

describe('GET /telemetry/agents q= search filter (T357)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  async function seedTelAgents(ctx: Ctx): Promise<void> {
    // 3 distinct agents: "agent-a-prod", "agent-b-prod", "service-worker"
    await ctx.logger.log(makeOp('agent-a-prod', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a-prod', 'db'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-b-prod', 'fs'), dec('block', 0.7));
    await ctx.logger.log(makeOp('service-worker', 'net'), dec('allow', 0.1));
  }

  it('17. q=agent-a returns only agents whose agentId contains "agent-a"', async () => {
    ctx = await setup();
    await seedTelAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/agents?q=agent-a');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }> };
    expect(b.agents.length).toBeGreaterThanOrEqual(1);
    for (const a of b.agents) {
      expect(a.agentId.toLowerCase()).toContain('agent-a');
    }
    // agent-a-prod should be present, service-worker should NOT
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-a-prod');
    expect(ids).not.toContain('service-worker');
    expect(ids).not.toContain('agent-b-prod');
  });

  it('18. empty q (no q param) returns all agents', async () => {
    ctx = await setup();
    await seedTelAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/agents');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    expect(b.agents.length).toBe(3);
    expect(b.count).toBe(3);
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-a-prod');
    expect(ids).toContain('agent-b-prod');
    expect(ids).toContain('service-worker');
  });

  it('19. q=prod matches all agents whose name includes "prod"', async () => {
    ctx = await setup();
    await seedTelAgents(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/agents?q=prod');
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    expect(b.count).toBe(2);
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-a-prod');
    expect(ids).toContain('agent-b-prod');
    expect(ids).not.toContain('service-worker');
  });

  it('20. q= (empty string) returns all agents', async () => {
    ctx = await setup();
    await seedTelAgents(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/agents?q=');
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    expect(b.count).toBe(3);
  });

  it('21. q=nonexistent returns empty agents array with count 0', async () => {
    ctx = await setup();
    await seedTelAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/agents?q=nonexistent');
    expect(status).toBe(200);
    const b = body as { agents: Array<unknown>; count: number };
    expect(b.agents).toHaveLength(0);
    expect(b.count).toBe(0);
  });

  it('22. q= is case-insensitive', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('Agent-XYZ', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('other-agent', 'fs'), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/telemetry/agents?q=agent-xyz');
    const b = body as { agents: Array<{ agentId: string }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('Agent-XYZ');
    expect(ids).not.toContain('other-agent');
  });
});

// ── T358 — GET /telemetry/tools?q= search filter ─────────────────────────────

describe('GET /telemetry/tools q= search filter (T358)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  async function seedTelTools(ctx: Ctx): Promise<void> {
    // 4 distinct tools: "fs-read", "fs-write", "db-query", "net-fetch"
    await ctx.logger.log(makeOp('agent-a', 'fs-read'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'fs-write'), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-b', 'db-query'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-b', 'net-fetch'), dec('allow', 0.15));
  }

  it('23. q=fs returns only tools whose name contains "fs"', async () => {
    ctx = await setup();
    await seedTelTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/tools?q=fs');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }> };
    expect(b.tools.length).toBeGreaterThanOrEqual(1);
    for (const t of b.tools) {
      expect(t.tool.toLowerCase()).toContain('fs');
    }
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('fs-read');
    expect(names).toContain('fs-write');
    expect(names).not.toContain('db-query');
    expect(names).not.toContain('net-fetch');
  });

  it('24. empty q (no q param) returns all tools', async () => {
    ctx = await setup();
    await seedTelTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/tools');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(4);
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('fs-read');
    expect(names).toContain('fs-write');
    expect(names).toContain('db-query');
    expect(names).toContain('net-fetch');
  });

  it('25. q=db returns only db-query, not fs or net tools', async () => {
    ctx = await setup();
    await seedTelTools(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/tools?q=db');
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(1);
    expect(b.tools[0]!.tool).toBe('db-query');
  });

  it('26. q= (empty string) returns all tools', async () => {
    ctx = await setup();
    await seedTelTools(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/tools?q=');
    const b = body as { tools: Array<unknown>; count: number };
    expect(b.count).toBe(4);
  });

  it('27. q=nonexistent returns empty tools array with count 0', async () => {
    ctx = await setup();
    await seedTelTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/telemetry/tools?q=nonexistent-tool');
    expect(status).toBe(200);
    const b = body as { tools: Array<unknown>; count: number };
    expect(b.tools).toHaveLength(0);
    expect(b.count).toBe(0);
  });

  it('28. q= is case-insensitive for tool names', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'FS-DELETE'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-a', 'db-query'), dec('allow', 0.1));

    const { body } = await getJSON(ctx.port, '/telemetry/tools?q=fs');
    const b = body as { tools: Array<{ tool: string }> };
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('FS-DELETE');
    expect(names).not.toContain('db-query');
  });

  it('29. q=net matches only net-fetch among seeded tools', async () => {
    ctx = await setup();
    await seedTelTools(ctx);

    const { body } = await getJSON(ctx.port, '/telemetry/tools?q=net');
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(1);
    expect(b.tools[0]!.tool).toBe('net-fetch');
  });
});

/**
 * T315 — GET /operations/summary includes blockRate
 * T316 — GET /agents/:agentId includes firstSeen
 * T310 — GET /agents?q=<term> (verify working correctly)
 * T311 — GET /tools?q=<term>
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

// ── T315 — GET /operations/summary includes blockRate ─────────────────────────

describe('GET /operations/summary — blockRate field (T315)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. blockRate is present in summary response', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'shell'), dec('block', 0.8));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('blockRate');
  });

  it('2. blockRate equals byAction.block / totalOps', async () => {
    ctx = await setup();
    // 2 allow, 1 block → totalOps=3, blockRate=1/3
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'db'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-c', 'shell'), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { totalOps: number; byAction: { allow: number; block: number; require_approval: number }; blockRate: number };
    expect(b.totalOps).toBe(3);
    expect(b.byAction.block).toBe(1);
    expect(b.blockRate).toBeCloseTo(1 / 3, 5);
  });

  it('3. blockRate is 0 when no operations exist', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { totalOps: number; blockRate: number };
    expect(b.totalOps).toBe(0);
    expect(b.blockRate).toBe(0);
  });

  it('4. blockRate is 0 when all operations are allowed', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'db'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-c', 'net'), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { blockRate: number };
    expect(b.blockRate).toBe(0);
  });

  it('5. blockRate is 1 when all operations are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'shell'), dec('block', 0.95));
    await ctx.logger.log(makeOp('agent-b', 'shell'), dec('block', 0.99));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { blockRate: number };
    expect(b.blockRate).toBe(1);
  });

  it('6. blockRate matches byAction.block / totalOps with require_approval ops present', async () => {
    ctx = await setup();
    // 3 allow, 2 block, 1 require_approval → totalOps=6, blockRate=2/6=1/3
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'shell'), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-b', 'shell'), dec('block', 0.95));
    await ctx.logger.log(makeOp('agent-c', 'db'), dec('require_approval', 0.5));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { totalOps: number; byAction: { block: number }; blockRate: number };
    expect(b.totalOps).toBe(6);
    expect(b.byAction.block).toBe(2);
    expect(b.blockRate).toBeCloseTo(2 / 6, 5);
  });
});

// ── T316 — GET /agents/:agentId includes firstSeen ────────────────────────────

describe('GET /agents/:agentId — firstSeen field (T316)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. response includes firstSeen field as ISO timestamp', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-a');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('firstSeen');
    expect(typeof b.firstSeen).toBe('string');
    // Must be a valid ISO timestamp
    expect(new Date(b.firstSeen as string).toISOString()).toBe(b.firstSeen);
  });

  it('2. firstSeen is <= lastSeen', async () => {
    ctx = await setup();
    const early = new Date('2026-01-01T08:00:00.000Z');
    const late  = new Date('2026-06-15T18:00:00.000Z');

    await ctx.logger.log(makeOp('agent-timeline', 'fs', { timestamp: early }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-timeline', 'db', { timestamp: late }),  dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-timeline');
    expect(status).toBe(200);
    const b = body as { firstSeen: string; lastSeen: string };
    expect(new Date(b.firstSeen).getTime()).toBeLessThanOrEqual(new Date(b.lastSeen).getTime());
  });

  it('3. firstSeen matches the timestamp of the earliest operation', async () => {
    ctx = await setup();
    const earliest = new Date('2026-01-01T00:00:00.000Z');
    const middle   = new Date('2026-03-01T12:00:00.000Z');
    const latest   = new Date('2026-06-15T23:59:59.000Z');

    await ctx.logger.log(makeOp('agent-b', 'db',    { timestamp: middle }),   dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-b', 'shell', { timestamp: latest }),   dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-b', 'fs',    { timestamp: earliest }), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-b');
    expect(status).toBe(200);
    const b = body as { firstSeen: string; lastSeen: string };
    expect(b.firstSeen).toBe(earliest.toISOString());
    expect(b.lastSeen).toBe(latest.toISOString());
  });

  it('4. firstSeen equals lastSeen when there is only one operation', async () => {
    ctx = await setup();
    const ts = new Date('2026-05-10T10:30:00.000Z');
    await ctx.logger.log(makeOp('agent-solo', 'fs', { timestamp: ts }), dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-solo');
    expect(status).toBe(200);
    const b = body as { firstSeen: string; lastSeen: string };
    expect(b.firstSeen).toBe(ts.toISOString());
    expect(b.lastSeen).toBe(ts.toISOString());
    expect(b.firstSeen).toBe(b.lastSeen);
  });

  it('5. firstSeen is not contaminated by operations of another agent', async () => {
    ctx = await setup();
    const agentAFirst  = new Date('2026-02-01T00:00:00.000Z');
    const agentBEarly  = new Date('2026-01-01T00:00:00.000Z'); // earlier but belongs to agent-b

    await ctx.logger.log(makeOp('agent-c', 'fs',    { timestamp: agentAFirst  }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-d', 'shell', { timestamp: agentBEarly }), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-c');
    expect(status).toBe(200);
    const b = body as { firstSeen: string };
    // firstSeen must be agent-c's own earliest op, not agent-d's
    expect(b.firstSeen).toBe(agentAFirst.toISOString());
  });

  it('6. response also includes agentId, totalOps, lastSeen, byAction alongside firstSeen', async () => {
    ctx = await setup();
    const ts = new Date('2026-03-15T09:00:00.000Z');
    await ctx.logger.log(makeOp('agent-fields', 'fs', { timestamp: ts }), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-fields');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('agentId', 'agent-fields');
    expect(b).toHaveProperty('totalOps', 1);
    expect(b).toHaveProperty('firstSeen');
    expect(b).toHaveProperty('lastSeen');
    expect(b).toHaveProperty('byAction');
    expect(b).toHaveProperty('avgRiskScore');
  });
});

// ── T310 — GET /agents?q=<term> (verify working correctly) ───────────────────

describe('GET /agents?q= search filter — correctness verification (T310)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. q=agent1 returns only agents whose agentId contains "agent1"', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent1-primary', 'fs'), dec());
    await ctx.logger.log(makeOp('agent1-secondary', 'db'), dec());
    await ctx.logger.log(makeOp('agent2-other', 'shell'), dec());
    await ctx.logger.log(makeOp('totally-different', 'net'), dec());

    const { status, body } = await getJSON(ctx.port, '/agents?q=agent1');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    expect(b.count).toBe(2);
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent1-primary');
    expect(ids).toContain('agent1-secondary');
    expect(ids).not.toContain('agent2-other');
    expect(ids).not.toContain('totally-different');
  });

  it('2. q=agent1 is case-insensitive — matches AGENT1, Agent1, agent1', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('AGENT1-UPPER', 'fs'), dec());
    await ctx.logger.log(makeOp('Agent1-Mixed', 'db'), dec());
    await ctx.logger.log(makeOp('agent1-lower', 'shell'), dec());
    await ctx.logger.log(makeOp('unrelated-bot', 'net'), dec());

    const { status, body } = await getJSON(ctx.port, '/agents?q=agent1');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    expect(b.count).toBe(3);
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('AGENT1-UPPER');
    expect(ids).toContain('Agent1-Mixed');
    expect(ids).toContain('agent1-lower');
    expect(ids).not.toContain('unrelated-bot');
  });

  it('3. q= term only filters by agentId, not by tool name', async () => {
    ctx = await setup();
    // tool name contains "agent1" but agentId does not
    await ctx.logger.log(makeOp('plain-bot', 'agent1-tool'), dec());
    // agentId contains "agent1"
    await ctx.logger.log(makeOp('agent1-correct', 'fs'), dec());

    const { status, body } = await getJSON(ctx.port, '/agents?q=agent1');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    expect(b.count).toBe(1);
    expect(b.agents[0].agentId).toBe('agent1-correct');
  });

  it('4. q= with no matching agentId returns empty list', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent1-primary', 'fs'), dec());
    await ctx.logger.log(makeOp('agent2-secondary', 'db'), dec());

    const { status, body } = await getJSON(ctx.port, '/agents?q=agent99');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    expect(b.count).toBe(0);
    expect(b.agents).toHaveLength(0);
  });

  it('5. q= absent (no filter) returns all agents including multiple agent1 variants', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent1-a', 'fs'), dec());
    await ctx.logger.log(makeOp('agent1-b', 'db'), dec());
    await ctx.logger.log(makeOp('agent2-x', 'shell'), dec());

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    expect(b.count).toBe(3);
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent1-a');
    expect(ids).toContain('agent1-b');
    expect(ids).toContain('agent2-x');
  });
});

// ── T311 — GET /tools?q=<term> ────────────────────────────────────────────────

describe('GET /tools?q= search filter — database term (T311)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. q=database returns only tools whose name contains "database"', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'database-read'), dec());
    await ctx.logger.log(makeOp('agent-b', 'database-write'), dec());
    await ctx.logger.log(makeOp('agent-c', 'filesystem-read'), dec());
    await ctx.logger.log(makeOp('agent-d', 'shell-exec'), dec());

    const { status, body } = await getJSON(ctx.port, '/tools?q=database');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(2);
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('database-read');
    expect(names).toContain('database-write');
    expect(names).not.toContain('filesystem-read');
    expect(names).not.toContain('shell-exec');
  });

  it('2. q=database is case-insensitive — matches DATABASE, Database, database', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'DATABASE-QUERY'), dec());
    await ctx.logger.log(makeOp('agent-b', 'Database-Insert'), dec());
    await ctx.logger.log(makeOp('agent-c', 'database-delete'), dec());
    await ctx.logger.log(makeOp('agent-d', 'network-call'), dec());

    const { status, body } = await getJSON(ctx.port, '/tools?q=database');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(3);
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('DATABASE-QUERY');
    expect(names).toContain('Database-Insert');
    expect(names).toContain('database-delete');
    expect(names).not.toContain('network-call');
  });

  it('3. q=database filters by tool name only, not by agentId', async () => {
    ctx = await setup();
    // agentId contains "database" but tool name does not
    await ctx.logger.log(makeOp('database-agent', 'filesystem-read'), dec());
    // tool name contains "database"
    await ctx.logger.log(makeOp('other-agent', 'database-read'), dec());

    const { status, body } = await getJSON(ctx.port, '/tools?q=database');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(1);
    expect(b.tools[0].tool).toBe('database-read');
  });

  it('4. q=database with no matching tool returns empty list', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'filesystem-read'), dec());
    await ctx.logger.log(makeOp('agent-b', 'shell-exec'), dec());
    await ctx.logger.log(makeOp('agent-c', 'network-call'), dec());

    const { status, body } = await getJSON(ctx.port, '/tools?q=database');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(0);
    expect(b.tools).toHaveLength(0);
  });

  it('5. q= absent returns all tools including database ones', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'database-read'), dec());
    await ctx.logger.log(makeOp('agent-b', 'database-write'), dec());
    await ctx.logger.log(makeOp('agent-c', 'shell-exec'), dec());

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(3);
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('database-read');
    expect(names).toContain('database-write');
    expect(names).toContain('shell-exec');
  });

  it('6. q=DATABASE (uppercase) matches lowercase database tool names', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'database-query'), dec());
    await ctx.logger.log(makeOp('agent-b', 'network-tool'), dec());

    const { status, body } = await getJSON(ctx.port, '/tools?q=DATABASE');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(1);
    expect(b.tools[0].tool).toBe('database-query');
  });
});

/**
 * T319 — GET /tools/:tool includes firstSeen/lastSeen
 * T320 — GET /operations/summary includes totalSessions
 * T322 — GET /risk?minRisk=X&maxRisk=Y range filter
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

// ── T319 — GET /tools/:tool includes firstSeen/lastSeen ───────────────────────

describe('GET /tools/:tool — firstSeen/lastSeen fields (T319)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. response includes firstSeen and lastSeen as ISO timestamp strings', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs-read'), dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/tools/fs-read');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('firstSeen');
    expect(b).toHaveProperty('lastSeen');
    expect(typeof b.firstSeen).toBe('string');
    expect(typeof b.lastSeen).toBe('string');
    // Must be valid ISO timestamps
    expect(new Date(b.firstSeen as string).toISOString()).toBe(b.firstSeen);
    expect(new Date(b.lastSeen as string).toISOString()).toBe(b.lastSeen);
  });

  it('2. firstSeen <= lastSeen when multiple operations exist', async () => {
    ctx = await setup();
    const early = new Date('2026-01-01T08:00:00.000Z');
    const late  = new Date('2026-06-15T18:00:00.000Z');

    await ctx.logger.log(makeOp('agent-a', 'db-query', { timestamp: early }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'db-query', { timestamp: late }),  dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/tools/db-query');
    expect(status).toBe(200);
    const b = body as { firstSeen: string; lastSeen: string };
    expect(new Date(b.firstSeen).getTime()).toBeLessThanOrEqual(new Date(b.lastSeen).getTime());
  });

  it('3. firstSeen matches the earliest operation timestamp for the tool', async () => {
    ctx = await setup();
    const earliest = new Date('2026-01-01T00:00:00.000Z');
    const middle   = new Date('2026-03-01T12:00:00.000Z');
    const latest   = new Date('2026-06-15T23:59:59.000Z');

    // Log in non-chronological order to verify min/max is computed correctly
    await ctx.logger.log(makeOp('agent-a', 'shell-exec', { timestamp: middle }),   dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-b', 'shell-exec', { timestamp: latest }),   dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-c', 'shell-exec', { timestamp: earliest }), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, '/tools/shell-exec');
    expect(status).toBe(200);
    const b = body as { firstSeen: string; lastSeen: string };
    expect(b.firstSeen).toBe(earliest.toISOString());
    expect(b.lastSeen).toBe(latest.toISOString());
  });

  it('4. firstSeen equals lastSeen when there is only one operation for the tool', async () => {
    ctx = await setup();
    const ts = new Date('2026-05-10T10:30:00.000Z');
    await ctx.logger.log(makeOp('agent-solo', 'net-fetch', { timestamp: ts }), dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/tools/net-fetch');
    expect(status).toBe(200);
    const b = body as { firstSeen: string; lastSeen: string };
    expect(b.firstSeen).toBe(ts.toISOString());
    expect(b.lastSeen).toBe(ts.toISOString());
    expect(b.firstSeen).toBe(b.lastSeen);
  });

  it('5. firstSeen is not contaminated by operations of a different tool', async () => {
    ctx = await setup();
    const toolAFirst = new Date('2026-02-01T00:00:00.000Z');
    const toolBEarly = new Date('2026-01-01T00:00:00.000Z'); // earlier but belongs to a different tool

    await ctx.logger.log(makeOp('agent-a', 'fs-write', { timestamp: toolAFirst }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-b', 'db-write', { timestamp: toolBEarly }), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, '/tools/fs-write');
    expect(status).toBe(200);
    const b = body as { firstSeen: string };
    // firstSeen must be fs-write's own earliest op, not db-write's
    expect(b.firstSeen).toBe(toolAFirst.toISOString());
  });

  it('6. response also includes tool, totalOps, byAction, avgRiskScore alongside firstSeen/lastSeen', async () => {
    ctx = await setup();
    const ts = new Date('2026-03-15T09:00:00.000Z');
    await ctx.logger.log(makeOp('agent-fields', 'net-call', { timestamp: ts }), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/tools/net-call');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('tool', 'net-call');
    expect(b).toHaveProperty('totalOps', 1);
    expect(b).toHaveProperty('firstSeen');
    expect(b).toHaveProperty('lastSeen');
    expect(b).toHaveProperty('byAction');
    expect(b).toHaveProperty('avgRiskScore');
  });
});

// ── T320 — GET /operations/summary includes totalSessions ─────────────────────

describe('GET /operations/summary — totalSessions field (T320)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. totalSessions is present in the summary response', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-1' }), dec());

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('totalSessions');
  });

  it('2. totalSessions equals the count of unique sessionIds across all operations', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs',    { sessionId: 'sess-1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'db',    { sessionId: 'sess-2' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-b', 'shell', { sessionId: 'sess-3' }), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { totalSessions: number };
    expect(b.totalSessions).toBe(3);
  });

  it('3. multiple operations in the same session count as one session', async () => {
    ctx = await setup();
    // 4 operations but only 2 distinct sessions
    await ctx.logger.log(makeOp('agent-a', 'fs',    { sessionId: 'sess-A' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'db',    { sessionId: 'sess-A' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-b', 'shell', { sessionId: 'sess-B' }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-b', 'net',   { sessionId: 'sess-B' }), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { totalOps: number; totalSessions: number };
    expect(b.totalOps).toBe(4);
    expect(b.totalSessions).toBe(2);
  });

  it('4. totalSessions is 0 when there are no operations', async () => {
    ctx = await setup();

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { totalOps: number; totalSessions: number };
    expect(b.totalOps).toBe(0);
    expect(b.totalSessions).toBe(0);
  });

  it('5. totalSessions is 1 when all operations share the same sessionId', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs',    { sessionId: 'single-sess' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'db',    { sessionId: 'single-sess' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-c', 'shell', { sessionId: 'single-sess' }), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { totalOps: number; totalSessions: number };
    expect(b.totalOps).toBe(3);
    expect(b.totalSessions).toBe(1);
  });

  it('6. totalSessions counts sessions across multiple agents and tools', async () => {
    ctx = await setup();
    // 5 operations across 4 distinct sessions
    await ctx.logger.log(makeOp('agent-a', 'fs',    { sessionId: 'sess-X1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'db',    { sessionId: 'sess-X2' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-c', 'net',   { sessionId: 'sess-X3' }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-d', 'shell', { sessionId: 'sess-X4' }), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-a', 'fs',    { sessionId: 'sess-X1' }), dec('allow', 0.15)); // duplicate sess

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { totalSessions: number };
    expect(b.totalSessions).toBe(4);
  });
});

// ── T322 — GET /risk?minRisk=X&maxRisk=Y range filter ────────────────────────

describe('GET /risk — minRisk/maxRisk range filter (T322)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. /risk?minRisk=0.5 returns only operations with riskScore >= 0.5', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs',    { sessionId: 'sess-1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'db',    { sessionId: 'sess-1' }), dec('allow', 0.4));
    await ctx.logger.log(makeOp('agent-c', 'shell', { sessionId: 'sess-2' }), dec('block', 0.7));
    await ctx.logger.log(makeOp('agent-d', 'net',   { sessionId: 'sess-2' }), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/risk?minRisk=0.5');
    expect(status).toBe(200);
    const b = body as { data: Array<{ riskScore: number }>; count: number };
    expect(b.count).toBe(2);
    for (const entry of b.data) {
      expect(entry.riskScore).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('2. /risk?maxRisk=0.3 returns only operations with riskScore <= 0.3', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs',    { sessionId: 'sess-1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'db',    { sessionId: 'sess-1' }), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-c', 'shell', { sessionId: 'sess-2' }), dec('block', 0.6));
    await ctx.logger.log(makeOp('agent-d', 'net',   { sessionId: 'sess-2' }), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/risk?maxRisk=0.3');
    expect(status).toBe(200);
    const b = body as { data: Array<{ riskScore: number }>; count: number };
    expect(b.count).toBe(2);
    for (const entry of b.data) {
      expect(entry.riskScore).toBeLessThanOrEqual(0.3);
    }
  });

  it('3. /risk?minRisk=0.4&maxRisk=0.7 returns only operations within that inclusive range', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs',    { sessionId: 'sess-1' }), dec('allow', 0.1));  // excluded
    await ctx.logger.log(makeOp('agent-b', 'db',    { sessionId: 'sess-1' }), dec('allow', 0.4));  // included (boundary)
    await ctx.logger.log(makeOp('agent-c', 'shell', { sessionId: 'sess-2' }), dec('allow', 0.55)); // included
    await ctx.logger.log(makeOp('agent-d', 'net',   { sessionId: 'sess-2' }), dec('block', 0.7));  // included (boundary)
    await ctx.logger.log(makeOp('agent-e', 'git',   { sessionId: 'sess-3' }), dec('block', 0.95)); // excluded

    const { status, body } = await getJSON(ctx.port, '/risk?minRisk=0.4&maxRisk=0.7');
    expect(status).toBe(200);
    const b = body as { data: Array<{ riskScore: number }>; count: number };
    expect(b.count).toBe(3);
    for (const entry of b.data) {
      expect(entry.riskScore).toBeGreaterThanOrEqual(0.4);
      expect(entry.riskScore).toBeLessThanOrEqual(0.7);
    }
  });

  it('4. /risk with no minRisk/maxRisk returns all operations', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs',    { sessionId: 'sess-1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'shell', { sessionId: 'sess-2' }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-c', 'db',    { sessionId: 'sess-3' }), dec('allow', 0.5));

    const { status, body } = await getJSON(ctx.port, '/risk');
    expect(status).toBe(200);
    const b = body as { data: Array<{ riskScore: number }>; count: number };
    expect(b.count).toBe(3);
  });

  it('5. /risk?minRisk=0.99 returns only ops at the very high end of the scale', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs',    { sessionId: 'sess-1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'shell', { sessionId: 'sess-2' }), dec('block', 0.99));
    await ctx.logger.log(makeOp('agent-c', 'net',   { sessionId: 'sess-3' }), dec('block', 0.85));

    const { status, body } = await getJSON(ctx.port, '/risk?minRisk=0.99');
    expect(status).toBe(200);
    const b = body as { data: Array<{ riskScore: number }>; count: number };
    expect(b.count).toBe(1);
    expect(b.data[0]!.riskScore).toBe(0.99);
  });

  it('6. /risk?minRisk=0.8 returns no results when all ops are below threshold', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs',    { sessionId: 'sess-1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'db',    { sessionId: 'sess-1' }), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-c', 'shell', { sessionId: 'sess-2' }), dec('allow', 0.6));

    const { status, body } = await getJSON(ctx.port, '/risk?minRisk=0.8');
    expect(status).toBe(200);
    const b = body as { data: Array<{ riskScore: number }>; count: number };
    expect(b.count).toBe(0);
    expect(b.data).toHaveLength(0);
  });

  it('7. each risk entry includes expected fields: operationId, agentId, tool, riskScore, action', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-check', 'fs-read', { sessionId: 'sess-1' }), dec('allow', 0.6));

    const { status, body } = await getJSON(ctx.port, '/risk?minRisk=0.5');
    expect(status).toBe(200);
    const b = body as { data: Array<Record<string, unknown>>; count: number };
    expect(b.count).toBe(1);
    const entry = b.data[0]!;
    expect(entry).toHaveProperty('operationId');
    expect(entry).toHaveProperty('agentId', 'agent-check');
    expect(entry).toHaveProperty('tool', 'fs-read');
    expect(entry).toHaveProperty('riskScore', 0.6);
    expect(entry).toHaveProperty('action', 'allow');
  });
});

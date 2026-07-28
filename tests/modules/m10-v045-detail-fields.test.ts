/**
 * v0.45 detail field tests
 *
 * T339 — GET /operations/summary includes topSessions array sorted by count desc
 * T340 — GET /agents/:agentId includes blockRate field with correct calculation
 * T341 — GET /tools/:tool includes blockRate field with correct calculation
 * T342 — GET /risk entries include sessionId field alongside agentId, tool, etc.
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

// ── T339 — GET /operations/summary topSessions ────────────────────────────────

describe('GET /operations/summary — topSessions (T339)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. topSessions is an empty array when no operations have sessionIds', async () => {
    ctx = await setup();
    // Insert ops with no sessionId (empty string or undefined simulated via overrides)
    // The store/logger always sets sessionId — insert via store directly with blank sessionId
    // Since makeOp always sets sessionId, we omit to verify empty state on a truly fresh DB
    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { topSessions: Array<{ sessionId: string; count: number }> };
    expect(Array.isArray(b.topSessions)).toBe(true);
    expect(b.topSessions).toHaveLength(0);
  });

  it('2. topSessions appears when operations have sessionIds', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-alpha' }), dec());
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-alpha' }), dec());
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-beta' }), dec());

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { topSessions: Array<{ sessionId: string; count: number }> };
    expect(b.topSessions.length).toBeGreaterThanOrEqual(1);
    // sess-alpha has 2 ops — should appear
    const alpha = b.topSessions.find(s => s.sessionId === 'sess-alpha');
    expect(alpha).toBeDefined();
    expect(alpha!.count).toBe(2);
  });

  it('3. topSessions is sorted by count descending', async () => {
    ctx = await setup();
    // sess-high: 5, sess-mid: 3, sess-low: 1
    for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-high' }), dec());
    for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-mid' }), dec());
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-low' }), dec());

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topSessions: Array<{ sessionId: string; count: number }> };
    expect(b.topSessions.length).toBeGreaterThanOrEqual(3);
    // Verify descending order
    for (let i = 0; i < b.topSessions.length - 1; i++) {
      expect(b.topSessions[i].count).toBeGreaterThanOrEqual(b.topSessions[i + 1].count);
    }
    // First entry should be the highest-count session
    expect(b.topSessions[0].sessionId).toBe('sess-high');
    expect(b.topSessions[0].count).toBe(5);
  });

  it('4. topSessions entries have the correct shape: { sessionId, count }', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-shape' }), dec());

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topSessions: Array<{ sessionId: string; count: number }> };
    expect(b.topSessions.length).toBeGreaterThanOrEqual(1);
    const entry = b.topSessions[0];
    expect(typeof entry.sessionId).toBe('string');
    expect(typeof entry.count).toBe('number');
    expect(entry.count).toBeGreaterThan(0);
  });

  it('5. topSessions with 6 different sessions returns at most 5 (top-5 cap)', async () => {
    ctx = await setup();
    const sessions = ['s1', 's2', 's3', 's4', 's5', 's6'];
    const counts    = [10,   8,   6,   4,   2,   1];
    for (let i = 0; i < sessions.length; i++) {
      for (let j = 0; j < counts[i]; j++) {
        await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: sessions[i] }), dec());
      }
    }

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topSessions: Array<{ sessionId: string; count: number }> };
    expect(b.topSessions.length).toBeLessThanOrEqual(5);
    // s6 with count=1 should be excluded from top-5
    const sessionIds = b.topSessions.map(s => s.sessionId);
    expect(sessionIds).not.toContain('s6');
    // s1 with count=10 must be first
    expect(b.topSessions[0].sessionId).toBe('s1');
    expect(b.topSessions[0].count).toBe(10);
  });
});

// ── T340 — GET /agents/:agentId blockRate ────────────────────────────────────

describe('GET /agents/:agentId — blockRate (T340)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('6. blockRate is 0.0 when all operations are allowed', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-allallow', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-allallow', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-allallow', 'fs'), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-allallow');
    expect(status).toBe(200);
    const b = body as { blockRate: number };
    expect(b.blockRate).toBeCloseTo(0.0, 5);
  });

  it('7. blockRate is 1.0 when all operations are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-allblock', 'fs'), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-allblock', 'fs'), dec('block', 0.8));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-allblock');
    expect(status).toBe(200);
    const b = body as { blockRate: number };
    expect(b.blockRate).toBeCloseTo(1.0, 5);
  });

  it('8. blockRate is correct for mixed allow/block: 2 blocked out of 5 total = 0.4', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-mixed', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-mixed', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-mixed', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-mixed', 'fs'), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-mixed', 'fs'), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-mixed');
    expect(status).toBe(200);
    const b = body as { blockRate: number; totalOps: number };
    expect(b.totalOps).toBe(5);
    // blockRate = 2 / 5 = 0.4
    expect(b.blockRate).toBeCloseTo(0.4, 5);
  });

  it('9. blockRate is within [0.0, 1.0] range', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-range', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-range', 'fs'), dec('block', 0.7));
    await ctx.logger.log(makeOp('agent-range', 'fs'), dec('require_approval', 0.5));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-range');
    expect(status).toBe(200);
    const b = body as { blockRate: number };
    expect(b.blockRate).toBeGreaterThanOrEqual(0.0);
    expect(b.blockRate).toBeLessThanOrEqual(1.0);
  });

  it('10. blockRate = blocked / total (1 blocked, 3 total = 0.333...)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-onethird', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-onethird', 'db'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-onethird', 'shell'), dec('block', 0.8));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-onethird');
    expect(status).toBe(200);
    const b = body as { blockRate: number; totalOps: number };
    expect(b.totalOps).toBe(3);
    expect(b.blockRate).toBeCloseTo(1 / 3, 5);
  });
});

// ── T341 — GET /tools/:tool blockRate ────────────────────────────────────────

describe('GET /tools/:tool — blockRate (T341)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('11. blockRate is 0.0 when all uses of a tool are allowed', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'safe-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'safe-tool'), dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/tools/safe-tool');
    expect(status).toBe(200);
    const b = body as { blockRate: number };
    expect(b.blockRate).toBeCloseTo(0.0, 5);
  });

  it('12. blockRate is 1.0 when all uses of a tool are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'danger-tool'), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-b', 'danger-tool'), dec('block', 0.95));
    await ctx.logger.log(makeOp('agent-c', 'danger-tool'), dec('block', 0.85));

    const { status, body } = await getJSON(ctx.port, '/tools/danger-tool');
    expect(status).toBe(200);
    const b = body as { blockRate: number };
    expect(b.blockRate).toBeCloseTo(1.0, 5);
  });

  it('13. blockRate = blocked / total for mixed operations (3 blocked, 6 total = 0.5)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'half-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'half-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'half-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'half-tool'), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-b', 'half-tool'), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-b', 'half-tool'), dec('block', 0.85));

    const { status, body } = await getJSON(ctx.port, '/tools/half-tool');
    expect(status).toBe(200);
    const b = body as { blockRate: number; totalOps: number };
    expect(b.totalOps).toBe(6);
    // blockRate = 3 / 6 = 0.5
    expect(b.blockRate).toBeCloseTo(0.5, 5);
  });

  it('14. blockRate is within [0.0, 1.0] range', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'range-tool'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'range-tool'), dec('block', 0.7));

    const { status, body } = await getJSON(ctx.port, '/tools/range-tool');
    expect(status).toBe(200);
    const b = body as { blockRate: number };
    expect(b.blockRate).toBeGreaterThanOrEqual(0.0);
    expect(b.blockRate).toBeLessThanOrEqual(1.0);
  });

  it('15. blockRate = 1 blocked out of 4 total = 0.25', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'quarter-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'quarter-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'quarter-tool'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'quarter-tool'), dec('block', 0.8));

    const { status, body } = await getJSON(ctx.port, '/tools/quarter-tool');
    expect(status).toBe(200);
    const b = body as { blockRate: number; totalOps: number };
    expect(b.totalOps).toBe(4);
    expect(b.blockRate).toBeCloseTo(0.25, 5);
  });
});

// ── T342 — GET /risk entries include sessionId ────────────────────────────────

describe('GET /risk — sessionId field (T342)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('16. each /risk entry includes a sessionId field', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'risk-sess-1' }), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/risk');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string }> };
    expect(b.data.length).toBeGreaterThanOrEqual(1);
    expect('sessionId' in b.data[0]).toBe(true);
  });

  it('17. sessionId in /risk response matches the sessionId of the inserted operation', async () => {
    ctx = await setup();
    const knownSessionId = 'risk-sess-known-42';
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: knownSessionId }), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/risk');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; agentId: string }> };
    expect(b.data.length).toBeGreaterThanOrEqual(1);
    const entry = b.data.find(e => e.agentId === 'agent-a');
    expect(entry).toBeDefined();
    expect(entry!.sessionId).toBe(knownSessionId);
  });

  it('18. /risk entries include all expected fields: operationId, agentId, sessionId, tool, method, riskScore, action', async () => {
    ctx = await setup();
    await ctx.logger.log(
      makeOp('agent-fields', 'shell', { sessionId: 'risk-sess-fields', method: 'call' }),
      dec('block', 0.75)
    );

    const { body } = await getJSON(ctx.port, '/risk');
    const b = body as { data: Array<Record<string, unknown>> };
    expect(b.data.length).toBeGreaterThanOrEqual(1);
    const entry = b.data.find(e => e['agentId'] === 'agent-fields');
    expect(entry).toBeDefined();
    expect(typeof entry!['operationId']).toBe('string');
    expect(entry!['agentId']).toBe('agent-fields');
    expect(entry!['sessionId']).toBe('risk-sess-fields');
    expect(entry!['tool']).toBe('shell');
    expect(entry!['method']).toBe('call');
    expect(entry!['riskScore']).toBeCloseTo(0.75, 5);
    expect(entry!['action']).toBe('block');
  });

  it('19. multiple /risk entries each have their own correct sessionId', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs',  { sessionId: 'risk-sess-A' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'db',  { sessionId: 'risk-sess-B' }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-c', 'net', { sessionId: 'risk-sess-C' }), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/risk');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; agentId: string }> };
    expect(b.data.length).toBeGreaterThanOrEqual(3);

    const byAgent = (id: string) => b.data.find(e => e.agentId === id);
    expect(byAgent('agent-a')!.sessionId).toBe('risk-sess-A');
    expect(byAgent('agent-b')!.sessionId).toBe('risk-sess-B');
    expect(byAgent('agent-c')!.sessionId).toBe('risk-sess-C');
  });

  it('20. /risk returns 200 with empty data array on a fresh store', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/risk');
    expect(status).toBe(200);
    const b = body as { data: Array<unknown>; count: number };
    expect(b.data).toHaveLength(0);
    expect(b.count).toBe(0);
  });
});

/**
 * v0.44 filter tests
 *
 * T334 — GET /sessions?limit=N&offset=M: pagination (limit, offset, count fields)
 * T338 — GET /sessions?minOps=N&maxOps=M: filter sessions by operationCount
 * T336 — GET /agents?maxRiskScore=N: filter agents by maxRiskScore
 * T337 — GET /tools?maxRiskScore=N: filter tools by maxRiskScore
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

// ── T334 — GET /sessions?limit=N&offset=M ────────────────────────────────────

describe('GET /sessions?limit&offset (T334)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. limit=2&offset=0 returns at most 2 sessions', async () => {
    ctx = await setup();
    // Create 4 distinct sessions
    for (let i = 1; i <= 4; i++) {
      await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: `sess-${i}` }), dec());
    }

    const { status, body } = await getJSON(ctx.port, '/sessions?limit=2&offset=0');
    expect(status).toBe(200);
    const b = body as { data: Array<unknown>; count: number; limit: number; offset: number };
    expect(b.data).toHaveLength(2);
    expect(b.limit).toBe(2);
    expect(b.offset).toBe(0);
  });

  it('2. response includes count, limit, offset fields', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-alpha' }), dec());
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-beta' }), dec());
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-gamma' }), dec());

    // Use limit=10 so all 3 sessions are fetched from the store; verify field presence and types
    const { body } = await getJSON(ctx.port, '/sessions?limit=10&offset=0');
    const b = body as { data: Array<unknown>; count: number; limit: number; offset: number };
    expect(typeof b.count).toBe('number');
    expect(typeof b.limit).toBe('number');
    expect(typeof b.offset).toBe('number');
    expect(b.count).toBe(3);
    expect(b.limit).toBe(10);
    expect(b.offset).toBe(0);
  });

  it('3. offset=2 skips the first 2 sessions', async () => {
    ctx = await setup();
    // 4 sessions: sess-1, sess-2, sess-3, sess-4
    for (let i = 1; i <= 4; i++) {
      await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: `sess-${i}` }), dec());
    }

    // Get all 4 session IDs with default params to know order
    const allRes = await getJSON(ctx.port, '/sessions?limit=10&offset=0');
    const allB = allRes.body as { data: Array<{ sessionId: string }>; count: number };
    const allIds = allB.data.map(s => s.sessionId);
    expect(allIds).toHaveLength(4);

    // Now get with offset=2 — should skip first 2
    const { body } = await getJSON(ctx.port, '/sessions?limit=10&offset=2');
    const b = body as { data: Array<{ sessionId: string }>; count: number; limit: number; offset: number };
    expect(b.offset).toBe(2);
    expect(b.count).toBe(4); // total is still 4
    expect(b.data).toHaveLength(2);
    // The returned sessions should be the last 2 from the full list
    const returnedIds = b.data.map(s => s.sessionId);
    expect(returnedIds).toEqual(allIds.slice(2));
  });

  it('4. limit=4&offset=0 and limit=4&offset=2 produce non-overlapping slices of 4 sessions', async () => {
    ctx = await setup();
    for (let i = 1; i <= 4; i++) {
      await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: `sess-p${i}` }), dec());
    }

    // Use limit=4 so all 4 ops (1 per session) are fetched from the store
    const page1 = await getJSON(ctx.port, '/sessions?limit=4&offset=0');
    const page2 = await getJSON(ctx.port, '/sessions?limit=4&offset=2');
    const b1 = page1.body as { data: Array<{ sessionId: string }>; count: number };
    const b2 = page2.body as { data: Array<{ sessionId: string }>; count: number };

    // First page: all 4 sessions visible, limit=4 returns all 4
    expect(b1.data).toHaveLength(4);
    expect(b1.count).toBe(4);

    // Second page: offset=2 skips first 2, returns last 2
    expect(b2.data).toHaveLength(2);
    expect(b2.count).toBe(4); // total is still 4

    const ids1 = b1.data.map(s => s.sessionId);
    const ids2 = b2.data.map(s => s.sessionId);
    // ids2 must be the last 2 from ids1 (same sort order)
    expect(ids2).toEqual(ids1.slice(2));
    // No overlap between first 2 and last 2
    const first2 = ids1.slice(0, 2);
    const overlap = first2.filter(id => ids2.includes(id));
    expect(overlap).toHaveLength(0);
  });

  it('5. offset beyond total returns empty data array', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-only' }), dec());

    const { body } = await getJSON(ctx.port, '/sessions?limit=10&offset=100');
    const b = body as { data: Array<unknown>; count: number; offset: number };
    expect(b.data).toHaveLength(0);
    expect(b.count).toBe(1); // total is still 1
    expect(b.offset).toBe(100);
  });
});

// ── T338 — GET /sessions?minOps=N&maxOps=M ───────────────────────────────────

describe('GET /sessions?minOps=N (T338)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('6. minOps=3 returns only sessions with operationCount >= 3', async () => {
    ctx = await setup();
    // sess-heavy: 5 ops, sess-mid: 3 ops, sess-light: 1 op
    for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-heavy' }), dec());
    for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-mid' }), dec());
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-light' }), dec());

    const { status, body } = await getJSON(ctx.port, '/sessions?minOps=3');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; operationCount: number }>; count: number };
    expect(b.data.every(s => s.operationCount >= 3)).toBe(true);
    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('sess-heavy');
    expect(ids).toContain('sess-mid');
    expect(ids).not.toContain('sess-light');
  });

  it('7. minOps=exact match includes sessions with exactly that operationCount', async () => {
    ctx = await setup();
    // sess-exact: exactly 2 ops, sess-under: 1 op
    for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-exact' }), dec());
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-under' }), dec());

    const { body } = await getJSON(ctx.port, '/sessions?minOps=2');
    const b = body as { data: Array<{ sessionId: string; operationCount: number }> };
    expect(b.data.some(s => s.sessionId === 'sess-exact')).toBe(true);
    expect(b.data.every(s => s.operationCount >= 2)).toBe(true);
    expect(b.data.map(s => s.sessionId)).not.toContain('sess-under');
  });

  it('8. minOps higher than all session operationCounts returns empty array', async () => {
    ctx = await setup();
    for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-a' }), dec());

    const { body } = await getJSON(ctx.port, '/sessions?minOps=999');
    const b = body as { data: Array<unknown>; count: number };
    expect(b.data).toHaveLength(0);
    expect(b.count).toBe(0);
  });
});

describe('GET /sessions?maxOps=N (T338)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('9. maxOps=2 returns only sessions with operationCount <= 2', async () => {
    ctx = await setup();
    // sess-heavy: 5 ops, sess-light: 1 op
    for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-heavy' }), dec());
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-light' }), dec());

    const { status, body } = await getJSON(ctx.port, '/sessions?maxOps=2');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; operationCount: number }>; count: number };
    expect(b.data.every(s => s.operationCount <= 2)).toBe(true);
    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('sess-light');
    expect(ids).not.toContain('sess-heavy');
  });

  it('10. maxOps=exact match includes sessions with exactly that operationCount', async () => {
    ctx = await setup();
    for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-exact' }), dec());
    for (let i = 0; i < 4; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-over' }), dec());

    const { body } = await getJSON(ctx.port, '/sessions?maxOps=3');
    const b = body as { data: Array<{ sessionId: string; operationCount: number }> };
    expect(b.data.some(s => s.sessionId === 'sess-exact')).toBe(true);
    expect(b.data.every(s => s.operationCount <= 3)).toBe(true);
    expect(b.data.map(s => s.sessionId)).not.toContain('sess-over');
  });

  it('11. maxOps lower than all session operationCounts returns empty array', async () => {
    ctx = await setup();
    for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-a' }), dec());
    for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-b' }), dec());

    const { body } = await getJSON(ctx.port, '/sessions?maxOps=0');
    const b = body as { data: Array<unknown>; count: number };
    expect(b.data).toHaveLength(0);
    expect(b.count).toBe(0);
  });

  it('12. minOps and maxOps together define an operationCount range', async () => {
    ctx = await setup();
    // sess-low: 1, sess-mid: 4, sess-high: 8
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-low' }), dec());
    for (let i = 0; i < 4; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-mid' }), dec());
    for (let i = 0; i < 8; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-high' }), dec());

    const { body } = await getJSON(ctx.port, '/sessions?minOps=3&maxOps=6');
    const b = body as { data: Array<{ sessionId: string; operationCount: number }> };
    expect(b.data.every(s => s.operationCount >= 3 && s.operationCount <= 6)).toBe(true);
    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('sess-mid');
    expect(ids).not.toContain('sess-low');
    expect(ids).not.toContain('sess-high');
  });
});

// ── T336 — GET /agents?maxRiskScore=N ────────────────────────────────────────

describe('GET /agents?maxRiskScore=N (T336)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('13. maxRiskScore=0.5 returns only agents whose maxRiskScore <= 0.5', async () => {
    ctx = await setup();
    // agent-safe: riskScore=0.2, agent-risky: riskScore=0.9
    await ctx.logger.log(makeOp('agent-safe', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-risky', 'fs'), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/agents?maxRiskScore=0.5');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; maxRiskScore: number }>; count: number };
    expect(b.agents.every(a => a.maxRiskScore <= 0.5)).toBe(true);
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-safe');
    expect(ids).not.toContain('agent-risky');
  });

  it('14. maxRiskScore=exact boundary includes agents at exactly that value', async () => {
    ctx = await setup();
    // agent-boundary: maxRiskScore exactly 0.5, agent-over: maxRiskScore 0.6
    await ctx.logger.log(makeOp('agent-boundary', 'fs'), dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-over', 'fs'), dec('allow', 0.6));

    const { body } = await getJSON(ctx.port, '/agents?maxRiskScore=0.5');
    const b = body as { agents: Array<{ agentId: string; maxRiskScore: number }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-boundary');
    expect(ids).not.toContain('agent-over');
  });

  it('15. maxRiskScore=1.0 returns all agents (nothing exceeds 1.0)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-b', 'fs'), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-c', 'fs'), dec('allow', 0.1));

    const { body } = await getJSON(ctx.port, '/agents?maxRiskScore=1.0');
    const b = body as { agents: Array<unknown>; count: number };
    expect(b.count).toBe(3);
    expect(b.agents).toHaveLength(3);
  });

  it('16. maxRiskScore=0.0 returns only agents with maxRiskScore of 0', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-zero', 'fs'), dec('allow', 0.0));
    await ctx.logger.log(makeOp('agent-nonzero', 'fs'), dec('allow', 0.1));

    const { body } = await getJSON(ctx.port, '/agents?maxRiskScore=0.0');
    const b = body as { agents: Array<{ agentId: string; maxRiskScore: number }>; count: number };
    expect(b.agents.every(a => a.maxRiskScore <= 0.0)).toBe(true);
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-zero');
    expect(ids).not.toContain('agent-nonzero');
  });

  it('17. maxRiskScore filter on agent with multiple ops uses the max of their risk scores', async () => {
    ctx = await setup();
    // agent-mixed has one low-risk op and one high-risk op => maxRiskScore=0.8
    await ctx.logger.log(makeOp('agent-mixed', 'fs', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-mixed', 'db', { id: crypto.randomUUID() }), dec('block', 0.8));
    // agent-safe has only low-risk ops
    await ctx.logger.log(makeOp('agent-safe', 'fs'), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/agents?maxRiskScore=0.5');
    const b = body as { agents: Array<{ agentId: string; maxRiskScore: number }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-safe');
    expect(ids).not.toContain('agent-mixed');
  });

  it('18. maxRiskScore below all agents maxRiskScore returns empty array', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.6));
    await ctx.logger.log(makeOp('agent-b', 'fs'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/agents?maxRiskScore=0.3');
    const b = body as { agents: Array<unknown>; count: number };
    expect(b.agents).toHaveLength(0);
    expect(b.count).toBe(0);
  });
});

// ── T337 — GET /tools?maxRiskScore=N ─────────────────────────────────────────

describe('GET /tools?maxRiskScore=N (T337)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('19. maxRiskScore=0.5 returns only tools whose maxRiskScore <= 0.5', async () => {
    ctx = await setup();
    // tool-safe: riskScore=0.2, tool-dangerous: riskScore=0.9
    await ctx.logger.log(makeOp('agent-a', 'tool-safe'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'tool-dangerous'), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/tools?maxRiskScore=0.5');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; maxRiskScore: number }>; count: number };
    expect(b.tools.every(t => t.maxRiskScore <= 0.5)).toBe(true);
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-safe');
    expect(names).not.toContain('tool-dangerous');
  });

  it('20. maxRiskScore=exact boundary includes tools at exactly that value', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-boundary'), dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-a', 'tool-over'), dec('allow', 0.6));

    const { body } = await getJSON(ctx.port, '/tools?maxRiskScore=0.5');
    const b = body as { tools: Array<{ tool: string; maxRiskScore: number }> };
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-boundary');
    expect(names).not.toContain('tool-over');
  });

  it('21. maxRiskScore=1.0 returns all tools', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-y'), dec('block', 0.7));
    await ctx.logger.log(makeOp('agent-a', 'tool-z'), dec('allow', 0.4));

    const { body } = await getJSON(ctx.port, '/tools?maxRiskScore=1.0');
    const b = body as { tools: Array<unknown>; count: number };
    expect(b.count).toBe(3);
    expect(b.tools).toHaveLength(3);
  });

  it('22. maxRiskScore filter on tool with multiple ops uses the max of their risk scores', async () => {
    ctx = await setup();
    // tool-mixed: one low-risk use + one high-risk use => maxRiskScore=0.85
    await ctx.logger.log(makeOp('agent-a', 'tool-mixed', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-mixed', { id: crypto.randomUUID() }), dec('block', 0.85));
    // tool-safe: only low risk
    await ctx.logger.log(makeOp('agent-a', 'tool-safe'), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/tools?maxRiskScore=0.5');
    const b = body as { tools: Array<{ tool: string; maxRiskScore: number }> };
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-safe');
    expect(names).not.toContain('tool-mixed');
  });

  it('23. maxRiskScore below all tools maxRiskScore returns empty array', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-a'), dec('allow', 0.7));
    await ctx.logger.log(makeOp('agent-a', 'tool-b'), dec('block', 0.95));

    const { body } = await getJSON(ctx.port, '/tools?maxRiskScore=0.3');
    const b = body as { tools: Array<unknown>; count: number };
    expect(b.tools).toHaveLength(0);
    expect(b.count).toBe(0);
  });

  it('24. maxRiskScore with no matching tools still returns 200 with empty tools array', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-risky'), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/tools?maxRiskScore=0.1');
    expect(status).toBe(200);
    const b = body as { tools: Array<unknown>; count: number };
    expect(b.tools).toHaveLength(0);
    expect(b.count).toBe(0);
  });
});

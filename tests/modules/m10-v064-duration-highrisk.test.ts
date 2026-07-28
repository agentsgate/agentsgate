/**
 * v0.64 tests
 *
 * T434 — GET /agents/:agentId returns pendingCount
 * T435 — GET /tools/:tool returns pendingCount
 * T436 — GET /sessions/:sessionId returns sessionDuration
 * T437 — GET /sessions returns avgBlockRate
 * T438 — GET /operations/summary returns highRiskCount
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

// ── T434 — GET /agents/:agentId returns pendingCount ─────────────────────────

describe('GET /agents/:agentId — pendingCount (T434)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. pendingCount is present in GET /agents/:agentId response', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-X', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-t434' }), dec('require_approval', 0.7));
    await ctx.logger.log(makeOp('agent-X', 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-t434' }), dec('require_approval', 0.75));

    const { status, body } = await getJSON(ctx.port, '/agents/agent-X');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['pendingCount']).toBeDefined();
  });

  it('2. pendingCount === 2 when 2 require_approval ops are seeded for agent-X', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-X', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-t434-cnt' }), dec('require_approval', 0.7));
    await ctx.logger.log(makeOp('agent-X', 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-t434-cnt' }), dec('require_approval', 0.75));

    const { body } = await getJSON(ctx.port, '/agents/agent-X');
    const b = body as { pendingCount: number };
    expect(b.pendingCount).toBe(2);
  });

  it('3. pendingCount === byAction.require_approval', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-X', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-t434-eq' }), dec('require_approval', 0.7));
    await ctx.logger.log(makeOp('agent-X', 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-t434-eq' }), dec('require_approval', 0.75));

    const { body } = await getJSON(ctx.port, '/agents/agent-X');
    const b = body as { pendingCount: number; byAction: { require_approval: number } };
    expect(b.pendingCount).toBe(b.byAction.require_approval);
  });

  it('4. pendingCount is 0 when no require_approval ops exist for that agent', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-X', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-t434-zero' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-X', 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-t434-zero' }), dec('block', 0.8));

    const { body } = await getJSON(ctx.port, '/agents/agent-X');
    const b = body as { pendingCount: number };
    expect(b.pendingCount).toBe(0);
  });

  it('5. pendingCount is a number type', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-X', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-t434-type' }), dec('require_approval', 0.7));

    const { body } = await getJSON(ctx.port, '/agents/agent-X');
    const b = body as { pendingCount: unknown };
    expect(typeof b.pendingCount).toBe('number');
  });
});

// ── T435 — GET /tools/:tool returns pendingCount ─────────────────────────────

describe('GET /tools/:tool — pendingCount (T435)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('6. pendingCount is present in GET /tools/:tool response', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'db_query', { id: crypto.randomUUID(), sessionId: 'sess-t435' }), dec('require_approval', 0.7));

    const { status, body } = await getJSON(ctx.port, '/tools/db_query');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['pendingCount']).toBeDefined();
  });

  it('7. pendingCount === 3 when 3 require_approval ops are seeded for db_query', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'db_query', { id: crypto.randomUUID(), sessionId: 'sess-t435-cnt' }), dec('require_approval', 0.7));
    await ctx.logger.log(makeOp('agent-b', 'db_query', { id: crypto.randomUUID(), sessionId: 'sess-t435-cnt' }), dec('require_approval', 0.72));
    await ctx.logger.log(makeOp('agent-c', 'db_query', { id: crypto.randomUUID(), sessionId: 'sess-t435-cnt' }), dec('require_approval', 0.75));

    const { body } = await getJSON(ctx.port, '/tools/db_query');
    const b = body as { pendingCount: number };
    expect(b.pendingCount).toBe(3);
  });

  it('8. pendingCount is 0 when no require_approval ops exist for that tool', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'db_query', { id: crypto.randomUUID(), sessionId: 'sess-t435-zero' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'db_query', { id: crypto.randomUUID(), sessionId: 'sess-t435-zero' }), dec('block', 0.8));

    const { body } = await getJSON(ctx.port, '/tools/db_query');
    const b = body as { pendingCount: number };
    expect(b.pendingCount).toBe(0);
  });

  it('9. pendingCount is a number type', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'db_query', { id: crypto.randomUUID(), sessionId: 'sess-t435-type' }), dec('require_approval', 0.7));

    const { body } = await getJSON(ctx.port, '/tools/db_query');
    const b = body as { pendingCount: unknown };
    expect(typeof b.pendingCount).toBe('number');
  });
});

// ── T436 — GET /sessions/:sessionId returns sessionDuration ──────────────────

describe('GET /sessions/:sessionId — sessionDuration (T436)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('10. sessionDuration is present in GET /sessions/:sessionId response', async () => {
    ctx = await setup();
    const op1 = makeOp('agentA', 'tool1', { timestamp: new Date(Date.now() - 5 * 60 * 1000), sessionId: 'sess-dur-present' });
    const op2 = makeOp('agentA', 'tool1', { timestamp: new Date(), sessionId: 'sess-dur-present' });
    await ctx.store.saveOperationLog({ operationId: op1.id, operation: op1, decision: dec('allow', 0.1), createdAt: new Date() });
    await ctx.store.saveOperationLog({ operationId: op2.id, operation: op2, decision: dec('allow', 0.1), createdAt: new Date() });

    const { status, body } = await getJSON(ctx.port, '/sessions/sess-dur-present');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['sessionDuration']).toBeDefined();
  });

  it('11. sessionDuration is approximately 5 minutes (within 1000ms tolerance)', async () => {
    ctx = await setup();
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const now = new Date();
    const op1 = makeOp('agentA', 'tool1', { timestamp: fiveMinAgo, sessionId: 'sess-dur' });
    const op2 = makeOp('agentA', 'tool1', { timestamp: now, sessionId: 'sess-dur' });
    await ctx.store.saveOperationLog({ operationId: op1.id, operation: op1, decision: dec('allow', 0.1), createdAt: new Date() });
    await ctx.store.saveOperationLog({ operationId: op2.id, operation: op2, decision: dec('allow', 0.1), createdAt: new Date() });

    const { body } = await getJSON(ctx.port, '/sessions/sess-dur');
    const b = body as { sessionDuration: number };
    const expected = 5 * 60 * 1000;
    expect(Math.abs(b.sessionDuration - expected)).toBeLessThanOrEqual(1000);
  });

  it('12. sessionDuration >= 0', async () => {
    ctx = await setup();
    const op1 = makeOp('agentA', 'tool1', { timestamp: new Date(Date.now() - 5 * 60 * 1000), sessionId: 'sess-dur-gte' });
    const op2 = makeOp('agentA', 'tool1', { timestamp: new Date(), sessionId: 'sess-dur-gte' });
    await ctx.store.saveOperationLog({ operationId: op1.id, operation: op1, decision: dec('allow', 0.1), createdAt: new Date() });
    await ctx.store.saveOperationLog({ operationId: op2.id, operation: op2, decision: dec('allow', 0.1), createdAt: new Date() });

    const { body } = await getJSON(ctx.port, '/sessions/sess-dur-gte');
    const b = body as { sessionDuration: number };
    expect(b.sessionDuration).toBeGreaterThanOrEqual(0);
  });

  it('13. sessionDuration is 0 when only one op exists in session', async () => {
    ctx = await setup();
    const op = makeOp('agentA', 'tool1', { timestamp: new Date(), sessionId: 'sess-dur-one' });
    await ctx.store.saveOperationLog({ operationId: op.id, operation: op, decision: dec('allow', 0.1), createdAt: new Date() });

    const { body } = await getJSON(ctx.port, '/sessions/sess-dur-one');
    const b = body as { sessionDuration: number };
    expect(b.sessionDuration).toBe(0);
  });

  it('14. sessionDuration is a number type', async () => {
    ctx = await setup();
    const op1 = makeOp('agentA', 'tool1', { timestamp: new Date(Date.now() - 60 * 1000), sessionId: 'sess-dur-type' });
    const op2 = makeOp('agentA', 'tool1', { timestamp: new Date(), sessionId: 'sess-dur-type' });
    await ctx.store.saveOperationLog({ operationId: op1.id, operation: op1, decision: dec('allow', 0.1), createdAt: new Date() });
    await ctx.store.saveOperationLog({ operationId: op2.id, operation: op2, decision: dec('allow', 0.1), createdAt: new Date() });

    const { body } = await getJSON(ctx.port, '/sessions/sess-dur-type');
    const b = body as { sessionDuration: unknown };
    expect(typeof b.sessionDuration).toBe('number');
  });
});

// ── T437 — GET /sessions returns avgBlockRate ─────────────────────────────────

describe('GET /sessions — avgBlockRate (T437)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * session-A: 2 blocked, 2 allowed → blockRate = 0.5
   * session-B: 0 blocked, 4 allowed → blockRate = 0.0
   * avgBlockRate = (0.5 + 0.0) / 2 = 0.25
   */
  async function seedTwoSessions(ctx: Ctx): Promise<void> {
    // session-A: 2 blocked, 2 allowed
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'session-A' }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID(), sessionId: 'session-A' }), dec('block', 0.85));
    await ctx.logger.log(makeOp('agent-a', 'tool-z', { id: crypto.randomUUID(), sessionId: 'session-A' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-w', { id: crypto.randomUUID(), sessionId: 'session-A' }), dec('allow', 0.2));
    // session-B: 0 blocked, 4 allowed
    await ctx.logger.log(makeOp('agent-b', 'tool-a', { id: crypto.randomUUID(), sessionId: 'session-B' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-b', { id: crypto.randomUUID(), sessionId: 'session-B' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-c', { id: crypto.randomUUID(), sessionId: 'session-B' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-d', { id: crypto.randomUUID(), sessionId: 'session-B' }), dec('allow', 0.1));
  }

  it('15. avgBlockRate is present in GET /sessions response', async () => {
    ctx = await setup();
    await seedTwoSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['avgBlockRate']).toBeDefined();
  });

  it('16. avgBlockRate === 0.25 for session-A (blockRate=0.5) and session-B (blockRate=0.0)', async () => {
    ctx = await setup();
    await seedTwoSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { avgBlockRate: number };
    expect(b.avgBlockRate).toBeCloseTo(0.25, 5);
  });

  it('17. avgBlockRate is 0 when all sessions have 0 blocked ops', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-all-allow-1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-all-allow-2' }), dec('allow', 0.1));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { avgBlockRate: number };
    expect(b.avgBlockRate).toBeCloseTo(0.0, 5);
  });

  it('18. avgBlockRate is 1.0 when all sessions have all ops blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-all-block-1' }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-all-block-2' }), dec('block', 0.95));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { avgBlockRate: number };
    expect(b.avgBlockRate).toBeCloseTo(1.0, 5);
  });

  it('19. avgBlockRate is a number type', async () => {
    ctx = await setup();
    await seedTwoSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { avgBlockRate: unknown };
    expect(typeof b.avgBlockRate).toBe('number');
  });
});

// ── T438 — GET /operations/summary returns highRiskCount ─────────────────────

describe('GET /operations/summary — highRiskCount (T438)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('20. highRiskCount is present in GET /operations/summary response', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID() }), dec('block', 0.8));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['highRiskCount']).toBeDefined();
  });

  it('21. highRiskCount === 2 when ops with riskScore 0.8, 0.9, 0.3 are seeded', async () => {
    ctx = await setup();
    // Two high-risk ops (>= 0.7)
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID() }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID() }), dec('block', 0.9));
    // One below the threshold
    await ctx.logger.log(makeOp('agent-a', 'tool-z', { id: crypto.randomUUID() }), dec('allow', 0.3));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { highRiskCount: number };
    expect(b.highRiskCount).toBe(2);
  });

  it('22. highRiskCount === 0 when no ops have riskScore >= 0.7', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID() }), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-a', 'tool-z', { id: crypto.randomUUID() }), dec('allow', 0.5));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { highRiskCount: number };
    expect(b.highRiskCount).toBe(0);
  });

  it('23. highRiskCount counts ops at the boundary (riskScore exactly 0.7)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID() }), dec('block', 0.7));
    await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID() }), dec('allow', 0.3));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { highRiskCount: number };
    expect(b.highRiskCount).toBe(1);
  });

  it('24. highRiskCount is a number type', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID() }), dec('block', 0.8));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { highRiskCount: unknown };
    expect(typeof b.highRiskCount).toBe('number');
  });

  it('25. highRiskCount is 0 when there are no operations', async () => {
    ctx = await setup();

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { highRiskCount: number };
    expect(b.highRiskCount).toBe(0);
  });
});

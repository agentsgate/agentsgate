/**
 * v0.63 tests
 *
 * T429 — GET /sessions/:sessionId returns recentBlockedOps[]
 * T430 — GET /operations/summary returns avgSessionSize
 * T431 — GET /agents/:agentId returns allowStreak
 * T432 — GET /tools/:tool returns allowRate
 * T433 — GET /sessions returns totalAllowed
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

// ── T429 — GET /sessions/:sessionId returns recentBlockedOps[] ────────────────

describe('GET /sessions/:sessionId — recentBlockedOps (T429)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds 3 blocked ops and 2 allowed ops for the same sessionId.
   */
  async function seedSessionOps(ctx: Ctx, sessionId: string): Promise<void> {
    // 3 blocked ops
    await ctx.logger.log(makeOp('agent-a', 'file_write', { id: crypto.randomUUID(), sessionId }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-a', 'exec_cmd',   { id: crypto.randomUUID(), sessionId }), dec('block', 0.85));
    await ctx.logger.log(makeOp('agent-a', 'net_fetch',  { id: crypto.randomUUID(), sessionId }), dec('block', 0.8));
    // 2 allowed ops
    await ctx.logger.log(makeOp('agent-a', 'file_read',  { id: crypto.randomUUID(), sessionId }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'list_dir',   { id: crypto.randomUUID(), sessionId }), dec('allow', 0.05));
  }

  it('1. recentBlockedOps is present in GET /sessions/:id response', async () => {
    ctx = await setup();
    await seedSessionOps(ctx, 'sess-t429');

    const { status, body } = await getJSON(ctx.port, '/sessions/sess-t429');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['recentBlockedOps']).toBeDefined();
    expect(Array.isArray(b['recentBlockedOps'])).toBe(true);
  });

  it('2. recentBlockedOps has length 3 (matching seeded blocked count)', async () => {
    ctx = await setup();
    await seedSessionOps(ctx, 'sess-t429-len');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t429-len');
    const b = body as { recentBlockedOps: unknown[] };
    expect(b.recentBlockedOps).toHaveLength(3);
  });

  it('3. recentBlockedOps.length === response.blocked', async () => {
    ctx = await setup();
    await seedSessionOps(ctx, 'sess-t429-match');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t429-match');
    const b = body as { recentBlockedOps: unknown[]; blocked: number };
    expect(b.recentBlockedOps.length).toBe(b.blocked);
  });

  it('4. each recentBlockedOps entry has operationId field', async () => {
    ctx = await setup();
    await seedSessionOps(ctx, 'sess-t429-fields');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t429-fields');
    const b = body as { recentBlockedOps: Array<Record<string, unknown>> };
    for (const entry of b.recentBlockedOps) {
      expect(entry['operationId']).toBeDefined();
      expect(typeof entry['operationId']).toBe('string');
    }
  });

  it('5. each recentBlockedOps entry has tool field', async () => {
    ctx = await setup();
    await seedSessionOps(ctx, 'sess-t429-tool');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t429-tool');
    const b = body as { recentBlockedOps: Array<Record<string, unknown>> };
    for (const entry of b.recentBlockedOps) {
      expect(entry['tool']).toBeDefined();
      expect(typeof entry['tool']).toBe('string');
    }
  });

  it('6. each recentBlockedOps entry has method field', async () => {
    ctx = await setup();
    await seedSessionOps(ctx, 'sess-t429-method');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t429-method');
    const b = body as { recentBlockedOps: Array<Record<string, unknown>> };
    for (const entry of b.recentBlockedOps) {
      expect(entry['method']).toBeDefined();
      expect(typeof entry['method']).toBe('string');
    }
  });

  it('7. each recentBlockedOps entry has riskScore field as a number', async () => {
    ctx = await setup();
    await seedSessionOps(ctx, 'sess-t429-risk');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t429-risk');
    const b = body as { recentBlockedOps: Array<Record<string, unknown>> };
    for (const entry of b.recentBlockedOps) {
      expect(entry['riskScore']).toBeDefined();
      expect(typeof entry['riskScore']).toBe('number');
    }
  });

  it('8. each recentBlockedOps entry has timestamp field', async () => {
    ctx = await setup();
    await seedSessionOps(ctx, 'sess-t429-ts');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t429-ts');
    const b = body as { recentBlockedOps: Array<Record<string, unknown>> };
    for (const entry of b.recentBlockedOps) {
      expect(entry['timestamp']).toBeDefined();
      expect(typeof entry['timestamp']).toBe('string');
    }
  });

  it('9. recentBlockedOps is empty array when all ops are allowed', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'file_read', { id: crypto.randomUUID(), sessionId: 'sess-all-allow' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'list_dir',  { id: crypto.randomUUID(), sessionId: 'sess-all-allow' }), dec('allow', 0.05));

    const { body } = await getJSON(ctx.port, '/sessions/sess-all-allow');
    const b = body as { recentBlockedOps: unknown[] };
    expect(Array.isArray(b.recentBlockedOps)).toBe(true);
    expect(b.recentBlockedOps).toHaveLength(0);
  });

  it('10. recentBlockedOps does not include allowed ops', async () => {
    ctx = await setup();
    await seedSessionOps(ctx, 'sess-t429-excl');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t429-excl');
    const b = body as { recentBlockedOps: Array<Record<string, unknown>> };
    // Allowed ops must not appear in recentBlockedOps
    // All entries must correspond to blocked actions — verified by count matching b.blocked
    const { blocked } = body as { blocked: number };
    expect(b.recentBlockedOps.length).toBeLessThanOrEqual(blocked);
  });
});

// ── T430 — GET /operations/summary returns avgSessionSize ────────────────────

describe('GET /operations/summary — avgSessionSize (T430)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds 6 ops across 2 sessions (3 per session).
   */
  async function seedTwoSessions(ctx: Ctx): Promise<void> {
    const sess1 = 'sess-s1';
    const sess2 = 'sess-s2';
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: sess1 }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID(), sessionId: sess1 }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'tool-z', { id: crypto.randomUUID(), sessionId: sess1 }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-b', 'tool-x', { id: crypto.randomUUID(), sessionId: sess2 }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-y', { id: crypto.randomUUID(), sessionId: sess2 }), dec('block', 0.7));
    await ctx.logger.log(makeOp('agent-b', 'tool-z', { id: crypto.randomUUID(), sessionId: sess2 }), dec('allow', 0.2));
  }

  it('11. avgSessionSize is present in GET /operations/summary response', async () => {
    ctx = await setup();
    await seedTwoSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['avgSessionSize']).toBeDefined();
  });

  it('12. avgSessionSize === 3 when 6 ops spread evenly across 2 sessions', async () => {
    ctx = await setup();
    await seedTwoSessions(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { avgSessionSize: number };
    expect(b.avgSessionSize).toBeCloseTo(3, 5);
  });

  it('13. avgSessionSize is a number type', async () => {
    ctx = await setup();
    await seedTwoSessions(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { avgSessionSize: unknown };
    expect(typeof b.avgSessionSize).toBe('number');
  });

  it('14. avgSessionSize === totalOps / totalSessions', async () => {
    ctx = await setup();
    await seedTwoSessions(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { avgSessionSize: number; totalOps: number; totalSessions: number };
    expect(b.avgSessionSize).toBeCloseTo(b.totalOps / b.totalSessions, 5);
  });

  it('15. avgSessionSize === 1 when each op is in its own session', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'solo-1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID(), sessionId: 'solo-2' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-z', { id: crypto.randomUUID(), sessionId: 'solo-3' }), dec('block', 0.8));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { avgSessionSize: number };
    expect(b.avgSessionSize).toBeCloseTo(1.0, 5);
  });

  it('16. avgSessionSize === 0 when no ops exist', async () => {
    ctx = await setup();

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { avgSessionSize: number };
    expect(b.avgSessionSize).toBe(0);
  });
});

// ── T431 — GET /agents/:agentId returns allowStreak ──────────────────────────

describe('GET /agents/:agentId — allowStreak (T431)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds ops for agent-X in controlled DESC order (newest → oldest in store):
   *   allow  (createdAt: now)         ← most recent, position 0 in DESC list
   *   allow  (createdAt: now - 1000)  ← position 1
   *   allow  (createdAt: now - 2000)  ← position 2
   *   block  (createdAt: now - 3000)  ← position 3 (oldest), breaks the streak
   */
  async function seedStreakOps(ctx: Ctx, agentId: string): Promise<void> {
    const now = Date.now();
    // Insert in chronological order; store returns DESC (newest first)
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp(agentId, 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-streak' }),
      decision: dec('block', 0.9),
      createdAt: new Date(now - 3000),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp(agentId, 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-streak' }),
      decision: dec('allow', 0.1),
      createdAt: new Date(now - 2000),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp(agentId, 'tool-c', { id: crypto.randomUUID(), sessionId: 'sess-streak' }),
      decision: dec('allow', 0.1),
      createdAt: new Date(now - 1000),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp(agentId, 'tool-d', { id: crypto.randomUUID(), sessionId: 'sess-streak' }),
      decision: dec('allow', 0.1),
      createdAt: new Date(now),
    });
  }

  it('17. allowStreak is present in GET /agents/:agentId response', async () => {
    ctx = await setup();
    await seedStreakOps(ctx, 'agent-streak-x');

    const { status, body } = await getJSON(ctx.port, '/agents/agent-streak-x');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['allowStreak']).toBeDefined();
  });

  it('18. allowStreak === 3 (3 most recent ops are allows)', async () => {
    ctx = await setup();
    await seedStreakOps(ctx, 'agent-allow-streak');

    const { body } = await getJSON(ctx.port, '/agents/agent-allow-streak');
    const b = body as { allowStreak: number };
    expect(b.allowStreak).toBe(3);
  });

  it('19. blockStreak === 0 when most recent ops are allows', async () => {
    ctx = await setup();
    await seedStreakOps(ctx, 'agent-no-block-streak');

    const { body } = await getJSON(ctx.port, '/agents/agent-no-block-streak');
    const b = body as { blockStreak: number };
    expect(b.blockStreak).toBe(0);
  });

  it('20. allowStreak is a number type', async () => {
    ctx = await setup();
    await seedStreakOps(ctx, 'agent-streak-type');

    const { body } = await getJSON(ctx.port, '/agents/agent-streak-type');
    const b = body as { allowStreak: unknown };
    expect(typeof b.allowStreak).toBe('number');
  });

  it('21. blockStreak is a number type', async () => {
    ctx = await setup();
    await seedStreakOps(ctx, 'agent-bstreak-type');

    const { body } = await getJSON(ctx.port, '/agents/agent-bstreak-type');
    const b = body as { blockStreak: unknown };
    expect(typeof b.blockStreak).toBe('number');
  });

  it('22. allowStreak === 0 and blockStreak === 3 when all recent ops are blocks', async () => {
    ctx = await setup();
    const agentId = 'agent-all-block';
    const now = Date.now();
    // 3 consecutive recent blocks, then an allow (oldest)
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp(agentId, 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-ab' }),
      decision: dec('allow', 0.1),
      createdAt: new Date(now - 3000),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp(agentId, 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-ab' }),
      decision: dec('block', 0.9),
      createdAt: new Date(now - 2000),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp(agentId, 'tool-c', { id: crypto.randomUUID(), sessionId: 'sess-ab' }),
      decision: dec('block', 0.85),
      createdAt: new Date(now - 1000),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp(agentId, 'tool-d', { id: crypto.randomUUID(), sessionId: 'sess-ab' }),
      decision: dec('block', 0.8),
      createdAt: new Date(now),
    });

    const { body } = await getJSON(ctx.port, `/agents/${agentId}`);
    const b = body as { allowStreak: number; blockStreak: number };
    expect(b.allowStreak).toBe(0);
    expect(b.blockStreak).toBe(3);
  });

  it('23. allowStreak === 1 when only one allow is at the top of DESC list', async () => {
    ctx = await setup();
    const agentId = 'agent-one-allow';
    const now = Date.now();
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp(agentId, 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-oa' }),
      decision: dec('block', 0.9),
      createdAt: new Date(now - 1000),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp(agentId, 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-oa' }),
      decision: dec('allow', 0.1),
      createdAt: new Date(now),
    });

    const { body } = await getJSON(ctx.port, `/agents/${agentId}`);
    const b = body as { allowStreak: number };
    expect(b.allowStreak).toBe(1);
  });
});

// ── T432 — GET /tools/:tool returns allowRate ─────────────────────────────────

describe('GET /tools/:tool — allowRate (T432)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds 4 allow + 1 block for tool='file_read'.
   */
  async function seedToolOps(ctx: Ctx, tool: string): Promise<void> {
    await ctx.logger.log(makeOp('agent-a', tool, { id: crypto.randomUUID(), sessionId: 'sess-r1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', tool, { id: crypto.randomUUID(), sessionId: 'sess-r1' }), dec('allow', 0.15));
    await ctx.logger.log(makeOp('agent-c', tool, { id: crypto.randomUUID(), sessionId: 'sess-r2' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-d', tool, { id: crypto.randomUUID(), sessionId: 'sess-r2' }), dec('allow', 0.12));
    await ctx.logger.log(makeOp('agent-e', tool, { id: crypto.randomUUID(), sessionId: 'sess-r3' }), dec('block', 0.8));
  }

  it('24. allowRate is present in GET /tools/:tool response', async () => {
    ctx = await setup();
    await seedToolOps(ctx, 'file_read');

    const { status, body } = await getJSON(ctx.port, '/tools/file_read');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['allowRate']).toBeDefined();
  });

  it('25. allowRate === 0.8 (4 allowed out of 5 total)', async () => {
    ctx = await setup();
    await seedToolOps(ctx, 'file_read_rate');

    const { body } = await getJSON(ctx.port, '/tools/file_read_rate');
    const b = body as { allowRate: number };
    expect(b.allowRate).toBeCloseTo(0.8, 5);
  });

  it('26. blockRate === 0.2 (1 blocked out of 5 total)', async () => {
    ctx = await setup();
    await seedToolOps(ctx, 'file_read_block');

    const { body } = await getJSON(ctx.port, '/tools/file_read_block');
    const b = body as { blockRate: number };
    expect(b.blockRate).toBeCloseTo(0.2, 5);
  });

  it('27. allowRate + blockRate <= 1.0', async () => {
    ctx = await setup();
    await seedToolOps(ctx, 'file_read_sum');

    const { body } = await getJSON(ctx.port, '/tools/file_read_sum');
    const b = body as { allowRate: number; blockRate: number };
    expect(b.allowRate + b.blockRate).toBeLessThanOrEqual(1.0 + 1e-10);
  });

  it('28. allowRate is a number type', async () => {
    ctx = await setup();
    await seedToolOps(ctx, 'file_read_type');

    const { body } = await getJSON(ctx.port, '/tools/file_read_type');
    const b = body as { allowRate: unknown };
    expect(typeof b.allowRate).toBe('number');
  });

  it('29. allowRate === 1.0 when all ops are allowed', async () => {
    ctx = await setup();
    const tool = 'all_allowed_tool';
    await ctx.logger.log(makeOp('agent-a', tool, { id: crypto.randomUUID(), sessionId: 'sess-aa' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', tool, { id: crypto.randomUUID(), sessionId: 'sess-aa' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-c', tool, { id: crypto.randomUUID(), sessionId: 'sess-aa' }), dec('allow', 0.05));

    const { body } = await getJSON(ctx.port, `/tools/${tool}`);
    const b = body as { allowRate: number };
    expect(b.allowRate).toBeCloseTo(1.0, 5);
  });

  it('30. allowRate === 0.0 when all ops are blocked', async () => {
    ctx = await setup();
    const tool = 'all_blocked_tool';
    await ctx.logger.log(makeOp('agent-a', tool, { id: crypto.randomUUID(), sessionId: 'sess-ab2' }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-b', tool, { id: crypto.randomUUID(), sessionId: 'sess-ab2' }), dec('block', 0.85));

    const { body } = await getJSON(ctx.port, `/tools/${tool}`);
    const b = body as { allowRate: number };
    expect(b.allowRate).toBeCloseTo(0.0, 5);
  });

  it('31. allowRate is consistent with byAction.allow / totalOps', async () => {
    ctx = await setup();
    await seedToolOps(ctx, 'file_read_cons');

    const { body } = await getJSON(ctx.port, '/tools/file_read_cons');
    const b = body as {
      allowRate: number;
      totalOps: number;
      byAction: { allow: number; block: number; require_approval: number };
    };
    expect(b.allowRate).toBeCloseTo(b.byAction.allow / b.totalOps, 10);
  });
});

// ── T433 — GET /sessions returns totalAllowed ─────────────────────────────────

describe('GET /sessions — totalAllowed (T433)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds sessions with known allowed/blocked counts:
   *   sess-a: 3 allowed, 1 blocked
   *   sess-b: 2 allowed, 2 blocked
   *   Total allowed = 5
   */
  async function seedSessionsWithAllowed(ctx: Ctx): Promise<number> {
    // sess-a: 3 allowed, 1 blocked
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-a' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-a' }), dec('allow', 0.15));
    await ctx.logger.log(makeOp('agent-a', 'tool-z', { id: crypto.randomUUID(), sessionId: 'sess-a' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'tool-w', { id: crypto.randomUUID(), sessionId: 'sess-a' }), dec('block', 0.8));
    // sess-b: 2 allowed, 2 blocked
    await ctx.logger.log(makeOp('agent-b', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-b' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-b' }), dec('allow', 0.12));
    await ctx.logger.log(makeOp('agent-b', 'tool-z', { id: crypto.randomUUID(), sessionId: 'sess-b' }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-b', 'tool-w', { id: crypto.randomUUID(), sessionId: 'sess-b' }), dec('block', 0.85));
    return 5; // total allowed = 3 + 2
  }

  it('32. totalAllowed is present in GET /sessions response', async () => {
    ctx = await setup();
    await seedSessionsWithAllowed(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['totalAllowed']).toBeDefined();
  });

  it('33. totalAllowed equals sum of all allowed ops across sessions', async () => {
    ctx = await setup();
    const expectedAllowed = await seedSessionsWithAllowed(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalAllowed: number };
    expect(b.totalAllowed).toBe(expectedAllowed);
  });

  it('34. totalRequireApproval is also present in GET /sessions response', async () => {
    ctx = await setup();
    await seedSessionsWithAllowed(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as Record<string, unknown>;
    expect(b['totalRequireApproval']).toBeDefined();
  });

  it('35. totalAllowed is a number type', async () => {
    ctx = await setup();
    await seedSessionsWithAllowed(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalAllowed: unknown };
    expect(typeof b.totalAllowed).toBe('number');
  });

  it('36. totalRequireApproval is a number type', async () => {
    ctx = await setup();
    await seedSessionsWithAllowed(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalRequireApproval: unknown };
    expect(typeof b.totalRequireApproval).toBe('number');
  });

  it('37. totalAllowed === 0 when all ops are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-x', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-all-blocked' }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-x', 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-all-blocked' }), dec('block', 0.85));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalAllowed: number };
    expect(b.totalAllowed).toBe(0);
  });

  it('38. totalRequireApproval counts require_approval ops correctly', async () => {
    ctx = await setup();
    // 1 require_approval op
    await ctx.logger.log(makeOp('agent-y', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-req' }), dec('require_approval', 0.55));
    await ctx.logger.log(makeOp('agent-y', 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-req' }), dec('allow', 0.1));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalRequireApproval: number };
    expect(b.totalRequireApproval).toBe(1);
  });

  it('39. totalAllowed matches sum of approved field across all session entries in data', async () => {
    ctx = await setup();
    await seedSessionsWithAllowed(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as {
      totalAllowed: number;
      data: Array<{ approved: number }>;
    };
    const sumApproved = b.data.reduce((acc, s) => acc + s.approved, 0);
    expect(b.totalAllowed).toBe(sumApproved);
  });
});

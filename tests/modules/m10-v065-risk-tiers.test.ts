/**
 * v0.65 tests
 *
 * T439 — GET /sessions/:sessionId returns firstSeen and lastSeen
 * T440 — GET /sessions returns totalBlocked
 * T441 — GET /agents/:agentId returns medianRiskScore
 * T442 — GET /operations/summary returns mediumRiskCount and lowRiskCount
 * T443 — GET /tools/:tool returns blockStreak
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

// ── T439 — GET /sessions/:sessionId returns firstSeen and lastSeen ────────────

describe('GET /sessions/:sessionId — firstSeen and lastSeen (T439)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds 2 ops in the same session with timestamps 1 hour apart.
   * The session detail endpoint derives firstSeen/lastSeen from operation.timestamp.
   */
  async function seedSessionWithTwoTimestamps(ctx: Ctx): Promise<{ earlierTs: Date; laterTs: Date }> {
    const now = Date.now();
    const earlierTs = new Date(now - 60 * 60 * 1000); // 1 hour ago
    const laterTs   = new Date(now);

    const op1 = makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-t439', timestamp: earlierTs });
    const op2 = makeOp('agent-a', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-t439', timestamp: laterTs });

    await ctx.store.saveOperationLog({ operationId: op1.id, operation: op1, decision: dec('allow', 0.2), createdAt: new Date() });
    await ctx.store.saveOperationLog({ operationId: op2.id, operation: op2, decision: dec('allow', 0.3), createdAt: new Date() });

    return { earlierTs, laterTs };
  }

  it('1. firstSeen is present in GET /sessions/:sessionId response', async () => {
    ctx = await setup();
    await seedSessionWithTwoTimestamps(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions/sess-t439');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['firstSeen']).toBeDefined();
  });

  it('2. lastSeen is present in GET /sessions/:sessionId response', async () => {
    ctx = await setup();
    await seedSessionWithTwoTimestamps(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions/sess-t439');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['lastSeen']).toBeDefined();
  });

  it('3. firstSeen < lastSeen (string comparison) when ops are 1 hour apart', async () => {
    ctx = await setup();
    await seedSessionWithTwoTimestamps(ctx);

    const { body } = await getJSON(ctx.port, '/sessions/sess-t439');
    const b = body as { firstSeen: string; lastSeen: string };
    expect(b.firstSeen < b.lastSeen).toBe(true);
  });

  it('4. firstSeen is a valid ISO 8601 string', async () => {
    ctx = await setup();
    await seedSessionWithTwoTimestamps(ctx);

    const { body } = await getJSON(ctx.port, '/sessions/sess-t439');
    const b = body as { firstSeen: string };
    const parsed = new Date(b.firstSeen);
    expect(isNaN(parsed.getTime())).toBe(false);
    expect(b.firstSeen).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('5. lastSeen is a valid ISO 8601 string', async () => {
    ctx = await setup();
    await seedSessionWithTwoTimestamps(ctx);

    const { body } = await getJSON(ctx.port, '/sessions/sess-t439');
    const b = body as { lastSeen: string };
    const parsed = new Date(b.lastSeen);
    expect(isNaN(parsed.getTime())).toBe(false);
    expect(b.lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('6. firstSeen matches the earlier op timestamp', async () => {
    ctx = await setup();
    const { earlierTs } = await seedSessionWithTwoTimestamps(ctx);

    const { body } = await getJSON(ctx.port, '/sessions/sess-t439');
    const b = body as { firstSeen: string };
    // Compare at second precision to avoid floating point issues
    expect(b.firstSeen.substring(0, 19)).toBe(earlierTs.toISOString().substring(0, 19));
  });

  it('7. lastSeen matches the later op timestamp', async () => {
    ctx = await setup();
    const { laterTs } = await seedSessionWithTwoTimestamps(ctx);

    const { body } = await getJSON(ctx.port, '/sessions/sess-t439');
    const b = body as { lastSeen: string };
    expect(b.lastSeen.substring(0, 19)).toBe(laterTs.toISOString().substring(0, 19));
  });

  it('8. firstSeen === lastSeen when session has only one op', async () => {
    ctx = await setup();
    const ts = new Date(Date.now() - 30 * 60 * 1000);
    const op = makeOp('agent-b', 'tool-z', { id: crypto.randomUUID(), sessionId: 'sess-t439-solo', timestamp: ts });
    await ctx.store.saveOperationLog({ operationId: op.id, operation: op, decision: dec('allow', 0.1), createdAt: new Date() });

    const { body } = await getJSON(ctx.port, '/sessions/sess-t439-solo');
    const b = body as { firstSeen: string; lastSeen: string };
    expect(b.firstSeen).toBe(b.lastSeen);
  });
});

// ── T440 — GET /sessions returns totalBlocked ─────────────────────────────────

describe('GET /sessions — totalBlocked (T440)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * session-A: 3 blocked ops
   * session-B: 2 blocked ops
   * totalBlocked should be 5
   */
  async function seedBlockedSessions(ctx: Ctx): Promise<void> {
    // session-A: 3 blocks
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'session-A' }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID(), sessionId: 'session-A' }), dec('block', 0.85));
    await ctx.logger.log(makeOp('agent-a', 'tool-z', { id: crypto.randomUUID(), sessionId: 'session-A' }), dec('block', 0.8));

    // session-B: 2 blocks
    await ctx.logger.log(makeOp('agent-b', 'tool-a', { id: crypto.randomUUID(), sessionId: 'session-B' }), dec('block', 0.75));
    await ctx.logger.log(makeOp('agent-b', 'tool-b', { id: crypto.randomUUID(), sessionId: 'session-B' }), dec('block', 0.72));
  }

  it('9. totalBlocked is present in GET /sessions response', async () => {
    ctx = await setup();
    await seedBlockedSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['totalBlocked']).toBeDefined();
  });

  it('10. totalBlocked === 5 when session-A has 3 blocks and session-B has 2 blocks', async () => {
    ctx = await setup();
    await seedBlockedSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalBlocked: number };
    expect(b.totalBlocked).toBe(5);
  });

  it('11. totalBlocked is a number type', async () => {
    ctx = await setup();
    await seedBlockedSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalBlocked: unknown };
    expect(typeof b.totalBlocked).toBe('number');
  });

  it('12. totalBlocked === 0 when no sessions have blocked ops', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-all-allow-t440' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-allow-2-t440' }), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalBlocked: number };
    expect(b.totalBlocked).toBe(0);
  });

  it('13. totalBlocked increments correctly when a third session with 1 block is added', async () => {
    ctx = await setup();
    await seedBlockedSessions(ctx); // session-A=3, session-B=2

    // Add a third session with 1 block
    await ctx.logger.log(makeOp('agent-c', 'tool-c', { id: crypto.randomUUID(), sessionId: 'session-C' }), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { totalBlocked: number };
    expect(b.totalBlocked).toBe(6);
  });
});

// ── T441 — GET /agents/:agentId returns medianRiskScore ───────────────────────

describe('GET /agents/:agentId — medianRiskScore (T441)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds 5 ops for agent-X with riskScores: 0.1, 0.3, 0.5, 0.7, 0.9
   * Sorted: [0.1, 0.3, 0.5, 0.7, 0.9], mid index = 2 → median = 0.5
   */
  async function seedFiveOps(ctx: Ctx): Promise<void> {
    const scores = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (const score of scores) {
      await ctx.logger.log(
        makeOp('agent-X', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-t441' }),
        dec('allow', score)
      );
    }
  }

  /**
   * Seeds 4 ops for agent-Y with riskScores: 0.2, 0.4, 0.6, 0.8
   * Sorted: [0.2, 0.4, 0.6, 0.8], mid=2 → median = (0.4+0.6)/2 = 0.5
   */
  async function seedFourOps(ctx: Ctx): Promise<void> {
    const scores = [0.2, 0.4, 0.6, 0.8];
    for (const score of scores) {
      await ctx.logger.log(
        makeOp('agent-Y', 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-t441-even' }),
        dec('allow', score)
      );
    }
  }

  it('14. medianRiskScore is present in GET /agents/:agentId response', async () => {
    ctx = await setup();
    await seedFiveOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents/agent-X');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['medianRiskScore']).toBeDefined();
  });

  it('15. medianRiskScore === 0.5 for 5 ops with scores [0.1, 0.3, 0.5, 0.7, 0.9]', async () => {
    ctx = await setup();
    await seedFiveOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-X');
    const b = body as { medianRiskScore: number };
    expect(b.medianRiskScore).toBeCloseTo(0.5, 10);
  });

  it('16. medianRiskScore === 0.5 for 4 ops with scores [0.2, 0.4, 0.6, 0.8] (even count)', async () => {
    ctx = await setup();
    await seedFourOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-Y');
    const b = body as { medianRiskScore: number };
    // Even count: (0.4 + 0.6) / 2 = 0.5
    expect(b.medianRiskScore).toBeCloseTo(0.5, 10);
  });

  it('17. medianRiskScore is a number type', async () => {
    ctx = await setup();
    await seedFiveOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-X');
    const b = body as { medianRiskScore: unknown };
    expect(typeof b.medianRiskScore).toBe('number');
  });

  it('18. medianRiskScore === single op riskScore when only 1 op exists', async () => {
    ctx = await setup();
    await ctx.logger.log(
      makeOp('agent-solo', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-solo' }),
      dec('allow', 0.42)
    );

    const { body } = await getJSON(ctx.port, '/agents/agent-solo');
    const b = body as { medianRiskScore: number };
    expect(b.medianRiskScore).toBeCloseTo(0.42, 10);
  });

  it('19. medianRiskScore is the lower-middle value for 3 ops', async () => {
    ctx = await setup();
    // Scores: 0.2, 0.6, 0.9 → sorted: [0.2, 0.6, 0.9] → median = 0.6
    await ctx.logger.log(makeOp('agent-three', 'tool-a', { id: crypto.randomUUID() }), dec('allow', 0.9));
    await ctx.logger.log(makeOp('agent-three', 'tool-b', { id: crypto.randomUUID() }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-three', 'tool-c', { id: crypto.randomUUID() }), dec('allow', 0.6));

    const { body } = await getJSON(ctx.port, '/agents/agent-three');
    const b = body as { medianRiskScore: number };
    expect(b.medianRiskScore).toBeCloseTo(0.6, 10);
  });
});

// ── T442 — GET /operations/summary returns mediumRiskCount and lowRiskCount ───

describe('GET /operations/summary — mediumRiskCount and lowRiskCount (T442)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds:
   *   2 ops with risk 0.8 (high: >= 0.7)
   *   3 ops with risk 0.5 (medium: 0.3 <= risk < 0.7)
   *   2 ops with risk 0.1 (low: < 0.3)
   */
  async function seedRiskTierOps(ctx: Ctx): Promise<void> {
    // High risk (>= 0.7)
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID() }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID() }), dec('block', 0.9));

    // Medium risk (0.3 <= risk < 0.7)
    await ctx.logger.log(makeOp('agent-b', 'tool-a', { id: crypto.randomUUID() }), dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-b', 'tool-b', { id: crypto.randomUUID() }), dec('allow', 0.4));
    await ctx.logger.log(makeOp('agent-b', 'tool-c', { id: crypto.randomUUID() }), dec('allow', 0.6));

    // Low risk (< 0.3)
    await ctx.logger.log(makeOp('agent-c', 'tool-p', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-c', 'tool-q', { id: crypto.randomUUID() }), dec('allow', 0.2));
  }

  it('20. mediumRiskCount is present in GET /operations/summary response', async () => {
    ctx = await setup();
    await seedRiskTierOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['mediumRiskCount']).toBeDefined();
  });

  it('21. lowRiskCount is present in GET /operations/summary response', async () => {
    ctx = await setup();
    await seedRiskTierOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['lowRiskCount']).toBeDefined();
  });

  it('22. highRiskCount === 2 for ops with risk 0.8, 0.9', async () => {
    ctx = await setup();
    await seedRiskTierOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { highRiskCount: number };
    expect(b.highRiskCount).toBe(2);
  });

  it('23. mediumRiskCount === 3 for ops with risk 0.5, 0.4, 0.6', async () => {
    ctx = await setup();
    await seedRiskTierOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { mediumRiskCount: number };
    expect(b.mediumRiskCount).toBe(3);
  });

  it('24. lowRiskCount === 2 for ops with risk 0.1, 0.2', async () => {
    ctx = await setup();
    await seedRiskTierOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { lowRiskCount: number };
    expect(b.lowRiskCount).toBe(2);
  });

  it('25. highRiskCount + mediumRiskCount + lowRiskCount === totalOps', async () => {
    ctx = await setup();
    await seedRiskTierOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { highRiskCount: number; mediumRiskCount: number; lowRiskCount: number; totalOps: number };
    expect(b.highRiskCount + b.mediumRiskCount + b.lowRiskCount).toBe(b.totalOps);
  });

  it('26. risk tier counts are all 0 when no operations exist', async () => {
    ctx = await setup();

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { highRiskCount: number; mediumRiskCount: number; lowRiskCount: number };
    expect(b.highRiskCount).toBe(0);
    expect(b.mediumRiskCount).toBe(0);
    expect(b.lowRiskCount).toBe(0);
  });

  it('27. op with riskScore exactly 0.3 is counted as medium (not low)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID() }), dec('allow', 0.3));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { mediumRiskCount: number; lowRiskCount: number };
    expect(b.mediumRiskCount).toBe(1);
    expect(b.lowRiskCount).toBe(0);
  });

  it('28. op with riskScore exactly 0.7 is counted as high (not medium)', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID() }), dec('block', 0.7));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { highRiskCount: number; mediumRiskCount: number };
    expect(b.highRiskCount).toBe(1);
    expect(b.mediumRiskCount).toBe(0);
  });

  it('29. mediumRiskCount and lowRiskCount are number types', async () => {
    ctx = await setup();
    await seedRiskTierOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { mediumRiskCount: unknown; lowRiskCount: unknown };
    expect(typeof b.mediumRiskCount).toBe('number');
    expect(typeof b.lowRiskCount).toBe('number');
  });
});

// ── T443 — GET /tools/:tool returns blockStreak ───────────────────────────────

describe('GET /tools/:tool — blockStreak (T443)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds 5 ops for tool 'bash_run' with explicit createdAt timestamps (oldest → newest):
   *   1. allow  (4s ago)
   *   2. allow  (3s ago)
   *   3. block  (2s ago)
   *   4. block  (1s ago)
   *   5. block  (now)
   *
   * The store returns logs DESC by createdAt (most recent first):
   *   block, block, block, allow, allow
   * blockStreak counts consecutive blocks from the start → 3
   */
  async function seedBlockStreakOps(ctx: Ctx): Promise<void> {
    const now = Date.now();
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('a', 'bash_run', { timestamp: new Date(now - 4000) }),
      decision: dec('allow', 0.1),
      createdAt: new Date(now - 4000),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('a', 'bash_run', { timestamp: new Date(now - 3000) }),
      decision: dec('allow', 0.2),
      createdAt: new Date(now - 3000),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('a', 'bash_run', { timestamp: new Date(now - 2000) }),
      decision: dec('block', 0.8),
      createdAt: new Date(now - 2000),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('a', 'bash_run', { timestamp: new Date(now - 1000) }),
      decision: dec('block', 0.85),
      createdAt: new Date(now - 1000),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('a', 'bash_run', { timestamp: new Date(now) }),
      decision: dec('block', 0.9),
      createdAt: new Date(now),
    });
  }

  it('30. blockStreak is present in GET /tools/:tool response', async () => {
    ctx = await setup();
    await seedBlockStreakOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools/bash_run');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['blockStreak']).toBeDefined();
  });

  it('31. blockStreak === 3 when 3 most recent ops are blocks followed by 2 allows', async () => {
    ctx = await setup();
    await seedBlockStreakOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools/bash_run');
    const b = body as { blockStreak: number };
    expect(b.blockStreak).toBe(3);
  });

  it('32. blockStreak is a number type', async () => {
    ctx = await setup();
    await seedBlockStreakOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools/bash_run');
    const b = body as { blockStreak: unknown };
    expect(typeof b.blockStreak).toBe('number');
  });

  it('33. blockStreak === 0 when the most recent op is not a block', async () => {
    ctx = await setup();
    const now = Date.now();
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('a', 'tool_no_streak'),
      decision: dec('block', 0.8),
      createdAt: new Date(now - 2000),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('a', 'tool_no_streak'),
      decision: dec('allow', 0.1),
      createdAt: new Date(now),
    });

    const { body } = await getJSON(ctx.port, '/tools/tool_no_streak');
    const b = body as { blockStreak: number };
    expect(b.blockStreak).toBe(0);
  });

  it('34. blockStreak equals totalOps when all ops for the tool are blocks', async () => {
    ctx = await setup();
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      await ctx.store.saveOperationLog({
        operationId: crypto.randomUUID(),
        operation: makeOp('a', 'tool_all_blocks'),
        decision: dec('block', 0.9),
        createdAt: new Date(now - (3 - i) * 1000),
      });
    }

    const { body } = await getJSON(ctx.port, '/tools/tool_all_blocks');
    const b = body as { blockStreak: number; totalOps: number };
    expect(b.blockStreak).toBe(4);
    expect(b.blockStreak).toBe(b.totalOps);
  });

  it('35. blockStreak resets when allow op interrupts streak from the start (DESC order)', async () => {
    ctx = await setup();
    const now = Date.now();
    // Oldest to newest: block, allow, block, block
    // DESC order (most recent first): block, block, allow, block
    // streak from start: block, block — breaks on allow → streak = 2
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('a', 'tool_partial_streak'),
      decision: dec('block', 0.8),
      createdAt: new Date(now - 3000),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('a', 'tool_partial_streak'),
      decision: dec('allow', 0.2),
      createdAt: new Date(now - 2000),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('a', 'tool_partial_streak'),
      decision: dec('block', 0.85),
      createdAt: new Date(now - 1000),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('a', 'tool_partial_streak'),
      decision: dec('block', 0.9),
      createdAt: new Date(now),
    });

    const { body } = await getJSON(ctx.port, '/tools/tool_partial_streak');
    const b = body as { blockStreak: number };
    expect(b.blockStreak).toBe(2);
  });
});

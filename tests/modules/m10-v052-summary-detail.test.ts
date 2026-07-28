/**
 * v0.52 tests
 *
 * T374 — GET /operations/summary includes topRiskOps array (up to 5 ops sorted by riskScore desc),
 *         each entry has operationId, riskScore, agentId, tool fields
 * T375 — GET /agents/:agentId includes sessionCount field (distinct sessionIds in that agent's ops)
 * T376 — GET /tools/:tool includes sessionCount field (distinct sessionIds for that tool)
 * T377 — GET /sessions/:id includes blockRate field (blocked / totalOps)
 * T378 — GET /operations/count?from=<iso>&to=<iso> filters by date range;
 *         createdFrom parameter works the same as from
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

// ── T374 — GET /operations/summary topRiskOps ─────────────────────────────────

describe('GET /operations/summary — topRiskOps (T374)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds 7 operations with distinct risk scores across different agents and tools
   * so we can verify the top-5-by-riskScore selection and sort order.
   *
   * riskScores (descending): 0.99, 0.95, 0.90, 0.85, 0.80, 0.50, 0.10
   * Expected topRiskOps: the first 5 entries in that order.
   */
  async function seedSummaryOps(ctx: Ctx): Promise<string[]> {
    const entries: Array<{ riskScore: number; action: ProxyDecision['action']; agentId: string; tool: string }> = [
      { riskScore: 0.10, action: 'allow',  agentId: 'agent-a', tool: 'tool-safe'   },
      { riskScore: 0.50, action: 'allow',  agentId: 'agent-b', tool: 'tool-mid'    },
      { riskScore: 0.80, action: 'block',  agentId: 'agent-c', tool: 'tool-risky'  },
      { riskScore: 0.85, action: 'block',  agentId: 'agent-a', tool: 'tool-risky'  },
      { riskScore: 0.90, action: 'block',  agentId: 'agent-b', tool: 'tool-danger' },
      { riskScore: 0.95, action: 'block',  agentId: 'agent-c', tool: 'tool-danger' },
      { riskScore: 0.99, action: 'block',  agentId: 'agent-a', tool: 'tool-danger' },
    ];
    const ids: string[] = [];
    for (const e of entries) {
      const id = crypto.randomUUID();
      ids.push(id);
      await ctx.logger.log(
        makeOp(e.agentId, e.tool, { id }),
        dec(e.action, e.riskScore)
      );
    }
    return ids;
  }

  it('1. topRiskOps is present in /operations/summary response', async () => {
    ctx = await setup();
    await seedSummaryOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['topRiskOps']).toBeDefined();
    expect(Array.isArray(b['topRiskOps'])).toBe(true);
  });

  it('2. topRiskOps contains at most 5 entries', async () => {
    ctx = await setup();
    await seedSummaryOps(ctx); // 7 ops seeded

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topRiskOps: unknown[] };
    expect(b.topRiskOps.length).toBeLessThanOrEqual(5);
  });

  it('3. topRiskOps is sorted by riskScore descending', async () => {
    ctx = await setup();
    await seedSummaryOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topRiskOps: Array<{ riskScore: number }> };
    expect(b.topRiskOps.length).toBeGreaterThanOrEqual(1);

    const scores = b.topRiskOps.map(op => op.riskScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]!);
    }
  });

  it('4. topRiskOps first entry has highest riskScore (0.99)', async () => {
    ctx = await setup();
    await seedSummaryOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topRiskOps: Array<{ riskScore: number }> };
    expect(b.topRiskOps[0]!.riskScore).toBeCloseTo(0.99, 5);
  });

  it('5. topRiskOps entries include operationId field', async () => {
    ctx = await setup();
    await seedSummaryOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topRiskOps: Array<Record<string, unknown>> };
    for (const op of b.topRiskOps) {
      expect(op['operationId']).toBeDefined();
      expect(typeof op['operationId']).toBe('string');
    }
  });

  it('6. topRiskOps entries include riskScore field as a number', async () => {
    ctx = await setup();
    await seedSummaryOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topRiskOps: Array<Record<string, unknown>> };
    for (const op of b.topRiskOps) {
      expect(op['riskScore']).toBeDefined();
      expect(typeof op['riskScore']).toBe('number');
    }
  });

  it('7. topRiskOps entries include agentId field', async () => {
    ctx = await setup();
    await seedSummaryOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topRiskOps: Array<Record<string, unknown>> };
    for (const op of b.topRiskOps) {
      expect(op['agentId']).toBeDefined();
      expect(typeof op['agentId']).toBe('string');
    }
  });

  it('8. topRiskOps entries include tool field', async () => {
    ctx = await setup();
    await seedSummaryOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topRiskOps: Array<Record<string, unknown>> };
    for (const op of b.topRiskOps) {
      expect(op['tool']).toBeDefined();
      expect(typeof op['tool']).toBe('string');
    }
  });

  it('9. topRiskOps with <= 5 total ops returns all ops sorted by riskScore desc', async () => {
    ctx = await setup();
    // Seed exactly 3 ops
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID() }), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-b', 'tool-y', { id: crypto.randomUUID() }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-c', 'tool-z', { id: crypto.randomUUID() }), dec('block', 0.6));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topRiskOps: Array<{ riskScore: number }> };
    expect(b.topRiskOps).toHaveLength(3);
    expect(b.topRiskOps[0]!.riskScore).toBeCloseTo(0.9, 5);
    expect(b.topRiskOps[1]!.riskScore).toBeCloseTo(0.6, 5);
    expect(b.topRiskOps[2]!.riskScore).toBeCloseTo(0.3, 5);
  });

  it('10. topRiskOps is empty array when no ops exist', async () => {
    ctx = await setup();
    // Fresh DB — no ops

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topRiskOps: unknown[] };
    expect(Array.isArray(b.topRiskOps)).toBe(true);
    expect(b.topRiskOps).toHaveLength(0);
  });

  it('11. topRiskOps fifth entry riskScore is 0.80 (lowest of the top 5)', async () => {
    ctx = await setup();
    await seedSummaryOps(ctx); // scores: 0.10, 0.50, 0.80, 0.85, 0.90, 0.95, 0.99

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topRiskOps: Array<{ riskScore: number }> };
    expect(b.topRiskOps).toHaveLength(5);
    // Scores in topRiskOps should be [0.99, 0.95, 0.90, 0.85, 0.80]
    expect(b.topRiskOps[4]!.riskScore).toBeCloseTo(0.80, 5);
    // The two low scores (0.50 and 0.10) must NOT appear
    const scores = b.topRiskOps.map(op => op.riskScore);
    expect(scores).not.toContain(0.10);
    expect(scores.every(s => s >= 0.80)).toBe(true);
  });
});

// ── T375 — GET /agents/:agentId sessionCount ──────────────────────────────────

describe('GET /agents/:agentId — sessionCount (T375)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * agent-multi: 3 ops across 3 distinct sessions
   * agent-single: 2 ops in the same session
   */
  async function seedAgentSessions(ctx: Ctx): Promise<void> {
    // agent-multi: 3 distinct sessions
    await ctx.logger.log(makeOp('agent-multi', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-m1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-multi', 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-m2' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-multi', 'tool-c', { id: crypto.randomUUID(), sessionId: 'sess-m3' }), dec('block', 0.8));

    // agent-single: all ops in same session
    await ctx.logger.log(makeOp('agent-single', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-s1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-single', 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-s1' }), dec('allow', 0.2));
  }

  it('12. sessionCount is present in GET /agents/:agentId response', async () => {
    ctx = await setup();
    await seedAgentSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents/agent-multi');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['sessionCount']).toBeDefined();
  });

  it('13. sessionCount reflects the number of distinct sessions for that agent', async () => {
    ctx = await setup();
    await seedAgentSessions(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-multi');
    const b = body as { sessionCount: number };
    expect(b.sessionCount).toBe(3);
  });

  it('14. agent with all ops in one session has sessionCount of 1', async () => {
    ctx = await setup();
    await seedAgentSessions(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-single');
    const b = body as { sessionCount: number };
    expect(b.sessionCount).toBe(1);
  });

  it('15. sessionCount is a number type', async () => {
    ctx = await setup();
    await seedAgentSessions(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-multi');
    const b = body as { sessionCount: unknown };
    expect(typeof b.sessionCount).toBe('number');
  });

  it('16. agent with single op in a unique session has sessionCount of 1', async () => {
    ctx = await setup();
    const id = crypto.randomUUID();
    await ctx.logger.log(makeOp('agent-one-op', 'tool-x', { id, sessionId: 'sess-solo' }), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/agents/agent-one-op');
    const b = body as { sessionCount: number };
    expect(b.sessionCount).toBe(1);
  });

  it('17. adding same agent ops to an additional session increments sessionCount', async () => {
    ctx = await setup();
    // Start: 2 sessions
    await ctx.logger.log(makeOp('agent-grow', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-g1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-grow', 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-g2' }), dec('allow', 0.1));

    const { body: body1 } = await getJSON(ctx.port, '/agents/agent-grow');
    const b1 = body1 as { sessionCount: number };
    expect(b1.sessionCount).toBe(2);

    // Add a third session
    await ctx.logger.log(makeOp('agent-grow', 'tool-c', { id: crypto.randomUUID(), sessionId: 'sess-g3' }), dec('block', 0.9));

    const { body: body2 } = await getJSON(ctx.port, '/agents/agent-grow');
    const b2 = body2 as { sessionCount: number };
    expect(b2.sessionCount).toBe(3);
  });

  it('18. sessionCount counts distinct sessions even if multiple ops share same session', async () => {
    ctx = await setup();
    // 4 ops but only 2 distinct sessions
    await ctx.logger.log(makeOp('agent-dup', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-d1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-dup', 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-d1' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-dup', 'tool-c', { id: crypto.randomUUID(), sessionId: 'sess-d2' }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-dup', 'tool-d', { id: crypto.randomUUID(), sessionId: 'sess-d2' }), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/agents/agent-dup');
    const b = body as { sessionCount: number };
    expect(b.sessionCount).toBe(2);
  });
});

// ── T376 — GET /tools/:tool sessionCount ──────────────────────────────────────

describe('GET /tools/:tool — sessionCount (T376)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * tool-multi: used in 3 distinct sessions
   * tool-one: used in 1 session
   */
  async function seedToolSessions(ctx: Ctx): Promise<void> {
    // tool-multi: 3 different sessions
    await ctx.logger.log(makeOp('agent-a', 'tool-multi', { id: crypto.randomUUID(), sessionId: 'sess-t1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-multi', { id: crypto.randomUUID(), sessionId: 'sess-t2' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-c', 'tool-multi', { id: crypto.randomUUID(), sessionId: 'sess-t3' }), dec('block', 0.8));

    // tool-one: only one session
    await ctx.logger.log(makeOp('agent-a', 'tool-one', { id: crypto.randomUUID(), sessionId: 'sess-t1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-one', { id: crypto.randomUUID(), sessionId: 'sess-t1' }), dec('allow', 0.2));
  }

  it('19. sessionCount is present in GET /tools/:tool response', async () => {
    ctx = await setup();
    await seedToolSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools/tool-multi');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['sessionCount']).toBeDefined();
  });

  it('20. sessionCount reflects the number of distinct sessions for that tool', async () => {
    ctx = await setup();
    await seedToolSessions(ctx);

    const { body } = await getJSON(ctx.port, '/tools/tool-multi');
    const b = body as { sessionCount: number };
    expect(b.sessionCount).toBe(3);
  });

  it('21. tool used in a single session reports sessionCount of 1', async () => {
    ctx = await setup();
    await seedToolSessions(ctx);

    const { body } = await getJSON(ctx.port, '/tools/tool-one');
    const b = body as { sessionCount: number };
    expect(b.sessionCount).toBe(1);
  });

  it('22. sessionCount is a number type', async () => {
    ctx = await setup();
    await seedToolSessions(ctx);

    const { body } = await getJSON(ctx.port, '/tools/tool-multi');
    const b = body as { sessionCount: unknown };
    expect(typeof b.sessionCount).toBe('number');
  });

  it('23. tool with multiple ops in same session still has sessionCount of 1', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-repeat', { id: crypto.randomUUID(), sessionId: 'sess-only' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-repeat', { id: crypto.randomUUID(), sessionId: 'sess-only' }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-c', 'tool-repeat', { id: crypto.randomUUID(), sessionId: 'sess-only' }), dec('allow', 0.3));

    const { body } = await getJSON(ctx.port, '/tools/tool-repeat');
    const b = body as { sessionCount: number };
    expect(b.sessionCount).toBe(1);
  });

  it('24. tool not found returns 404', async () => {
    ctx = await setup();

    const { status } = await getJSON(ctx.port, '/tools/nonexistent-tool-xyz');
    expect(status).toBe(404);
  });

  it('25. sessionCount counts distinct sessions correctly with 2 sessions', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-two-sess', { id: crypto.randomUUID(), sessionId: 'sess-x1' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'tool-two-sess', { id: crypto.randomUUID(), sessionId: 'sess-x1' }), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-b', 'tool-two-sess', { id: crypto.randomUUID(), sessionId: 'sess-x2' }), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/tools/tool-two-sess');
    const b = body as { sessionCount: number };
    expect(b.sessionCount).toBe(2);
  });
});

// ── T377 — GET /sessions/:id blockRate ───────────────────────────────────────

describe('GET /sessions/:id — blockRate (T377)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('26. blockRate is present in GET /sessions/:id response', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-br-test' }), dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/sessions/sess-br-test');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['blockRate']).toBeDefined();
  });

  it('27. blockRate is 0 when all ops are allowed', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-all-allow' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-all-allow' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'tool-z', { id: crypto.randomUUID(), sessionId: 'sess-all-allow' }), dec('allow', 0.3));

    const { body } = await getJSON(ctx.port, '/sessions/sess-all-allow');
    const b = body as { blockRate: number };
    expect(b.blockRate).toBeCloseTo(0.0, 5);
  });

  it('28. blockRate is 1.0 when all ops are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-all-block' }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-a', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-all-block' }), dec('block', 0.95));

    const { body } = await getJSON(ctx.port, '/sessions/sess-all-block');
    const b = body as { blockRate: number };
    expect(b.blockRate).toBeCloseTo(1.0, 5);
  });

  it('29. blockRate is 0.5 when half of ops are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-b', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-half' }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-b', 'tool-y', { id: crypto.randomUUID(), sessionId: 'sess-half' }), dec('allow', 0.1));

    const { body } = await getJSON(ctx.port, '/sessions/sess-half');
    const b = body as { blockRate: number };
    expect(b.blockRate).toBeCloseTo(0.5, 5);
  });

  it('30. blockRate is calculated as blocked / totalOps (1/3 = ~0.333)', async () => {
    ctx = await setup();
    // 1 blocked, 2 allowed => blockRate = 1/3
    await ctx.logger.log(makeOp('agent-c', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-third' }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-c', 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-third' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-c', 'tool-c', { id: crypto.randomUUID(), sessionId: 'sess-third' }), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/sessions/sess-third');
    const b = body as { blockRate: number; blocked: number; totalOps: number };
    expect(b.blockRate).toBeCloseTo(1 / 3, 5);
    expect(b.blocked).toBe(1);
    expect(b.totalOps).toBe(3);
  });

  it('31. blockRate is a number type', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID(), sessionId: 'sess-type-check' }), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/sessions/sess-type-check');
    const b = body as { blockRate: unknown };
    expect(typeof b.blockRate).toBe('number');
  });

  it('32. session not found returns 404', async () => {
    ctx = await setup();

    const { status } = await getJSON(ctx.port, '/sessions/nonexistent-session-xyz');
    expect(status).toBe(404);
  });

  it('33. blockRate is consistent with blocked and totalOps fields in same response', async () => {
    ctx = await setup();
    // 2 blocked, 3 allowed, 1 require_approval => totalOps=6, blockRate=2/6=0.333...
    await ctx.logger.log(makeOp('agent-x', 'tool-a', { id: crypto.randomUUID(), sessionId: 'sess-consistent' }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-x', 'tool-b', { id: crypto.randomUUID(), sessionId: 'sess-consistent' }), dec('block', 0.85));
    await ctx.logger.log(makeOp('agent-x', 'tool-c', { id: crypto.randomUUID(), sessionId: 'sess-consistent' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-x', 'tool-d', { id: crypto.randomUUID(), sessionId: 'sess-consistent' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-x', 'tool-e', { id: crypto.randomUUID(), sessionId: 'sess-consistent' }), dec('allow', 0.15));
    await ctx.logger.log(makeOp('agent-x', 'tool-f', { id: crypto.randomUUID(), sessionId: 'sess-consistent' }), dec('require_approval', 0.5));

    const { body } = await getJSON(ctx.port, '/sessions/sess-consistent');
    const b = body as { blockRate: number; blocked: number; totalOps: number };
    expect(b.totalOps).toBe(6);
    expect(b.blocked).toBe(2);
    expect(b.blockRate).toBeCloseTo(b.blocked / b.totalOps, 10);
  });
});

// ── T378 — GET /operations/count with date range filters ─────────────────────

describe('GET /operations/count — date range filter (T378)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds ops with explicit createdAt values spread 1 hour apart so that
   * time-range filters can reliably distinguish them.
   *
   * Timestamps (all in the past):
   *   t-old:    3 hours ago
   *   t-mid:    2 hours ago
   *   t-recent: 1 hour ago
   */
  async function seedTimedOps(ctx: Ctx): Promise<{ tOld: Date; tMid: Date; tRecent: Date }> {
    const now = Date.now();
    const tOld    = new Date(now - 3 * 60 * 60 * 1000);
    const tMid    = new Date(now - 2 * 60 * 60 * 1000);
    const tRecent = new Date(now - 1 * 60 * 60 * 1000);

    const makeLogEntry = (agentId: string, tool: string, createdAt: Date) => ({
      operationId: crypto.randomUUID(),
      operation: makeOp(agentId, tool, { id: crypto.randomUUID() }),
      decision: dec('allow', 0.2),
      createdAt,
    });

    await ctx.store.saveOperationLog({ ...makeLogEntry('agent-a', 'tool-old',    tOld),    operationId: crypto.randomUUID() });
    await ctx.store.saveOperationLog({ ...makeLogEntry('agent-b', 'tool-mid',    tMid),    operationId: crypto.randomUUID() });
    await ctx.store.saveOperationLog({ ...makeLogEntry('agent-c', 'tool-recent', tRecent), operationId: crypto.randomUUID() });

    return { tOld, tMid, tRecent };
  }

  it('34. /operations/count returns 200 with count field', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { id: crypto.randomUUID() }), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, '/operations/count');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['count']).toBeDefined();
    expect(typeof b['count']).toBe('number');
  });

  it('35. count without filter returns total op count', async () => {
    ctx = await setup();
    await seedTimedOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/count');
    const b = body as { count: number };
    expect(b.count).toBe(3);
  });

  it('36. ?from= set before all ops returns all ops', async () => {
    ctx = await setup();
    const { tOld } = await seedTimedOps(ctx);

    const from = new Date(tOld.getTime() - 60 * 60 * 1000); // 1 hour before oldest
    const { body } = await getJSON(ctx.port, `/operations/count?from=${encodeURIComponent(from.toISOString())}`);
    const b = body as { count: number };
    expect(b.count).toBe(3);
  });

  it('37. ?to= set after all ops returns all ops', async () => {
    ctx = await setup();
    const { tRecent } = await seedTimedOps(ctx);

    const to = new Date(tRecent.getTime() + 60 * 60 * 1000); // 1 hour after most recent
    const { body } = await getJSON(ctx.port, `/operations/count?to=${encodeURIComponent(to.toISOString())}`);
    const b = body as { count: number };
    expect(b.count).toBe(3);
  });

  it('38. ?from=&to= range bracketing only the oldest op returns count of 1', async () => {
    ctx = await setup();
    const { tOld, tMid } = await seedTimedOps(ctx);

    // Window: tOld - 30min → tOld + 30min: only the oldest op should be in range
    const from = new Date(tOld.getTime() - 30 * 60 * 1000);
    const to   = new Date(tOld.getTime() + 30 * 60 * 1000);

    // Ensure window does not overlap tMid
    expect(to.getTime()).toBeLessThan(tMid.getTime());

    const { body } = await getJSON(
      ctx.port,
      `/operations/count?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`
    );
    const b = body as { count: number };
    expect(b.count).toBe(1);
  });

  it('39. count within a range containing all 3 ops returns 3', async () => {
    ctx = await setup();
    const { tOld, tRecent } = await seedTimedOps(ctx);

    const from = new Date(tOld.getTime() - 60 * 60 * 1000);
    const to   = new Date(tRecent.getTime() + 60 * 60 * 1000);
    const { body } = await getJSON(
      ctx.port,
      `/operations/count?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`
    );
    const b = body as { count: number };
    expect(b.count).toBe(3);
  });

  it('40. count in the future returns 0', async () => {
    ctx = await setup();
    await seedTimedOps(ctx);

    const from = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
    const to   = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const { body } = await getJSON(
      ctx.port,
      `/operations/count?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`
    );
    const b = body as { count: number };
    expect(b.count).toBe(0);
  });

  it('41. ?createdFrom= works the same as ?from= for date filtering', async () => {
    ctx = await setup();
    const { tOld } = await seedTimedOps(ctx);

    const from = new Date(tOld.getTime() - 60 * 60 * 1000); // before all ops

    const { body: bodyFrom }        = await getJSON(ctx.port, `/operations/count?from=${encodeURIComponent(from.toISOString())}`);
    const { body: bodyCreatedFrom } = await getJSON(ctx.port, `/operations/count?createdFrom=${encodeURIComponent(from.toISOString())}`);

    const bFrom        = bodyFrom        as { count: number };
    const bCreatedFrom = bodyCreatedFrom as { count: number };
    expect(bCreatedFrom.count).toBe(bFrom.count);
    expect(bCreatedFrom.count).toBe(3);
  });

  it('42. ?createdFrom= filters to ops at or after that timestamp', async () => {
    ctx = await setup();
    const { tMid } = await seedTimedOps(ctx);

    // createdFrom just before tMid → should include tMid and tRecent ops (2 total)
    const createdFrom = new Date(tMid.getTime() - 30 * 60 * 1000); // 30 min before tMid
    const { body } = await getJSON(
      ctx.port,
      `/operations/count?createdFrom=${encodeURIComponent(createdFrom.toISOString())}`
    );
    const b = body as { count: number };
    expect(b.count).toBe(2);
  });

  it('43. ?to= in the past (before all seeded ops) returns 0', async () => {
    ctx = await setup();
    const { tOld } = await seedTimedOps(ctx);

    // Set to before tOld — none of the ops should be included
    const pastTo = new Date(tOld.getTime() - 60 * 60 * 1000);

    const { body } = await getJSON(
      ctx.port,
      `/operations/count?to=${encodeURIComponent(pastTo.toISOString())}`
    );
    const b = body as { count: number };
    expect(b.count).toBe(0);
  });

  it('44. date range filter can be combined with agentId filter', async () => {
    ctx = await setup();

    const now = Date.now();
    const tEarly = new Date(now - 3 * 60 * 60 * 1000); // 3 h ago
    const tLate  = new Date(now - 1 * 60 * 60 * 1000); // 1 h ago

    const makeEntry = (agentId: string, tool: string, createdAt: Date) => ({
      operationId: crypto.randomUUID(),
      operation: makeOp(agentId, tool, { id: crypto.randomUUID() }),
      decision: dec('allow', 0.2),
      createdAt,
    });

    // agent-filter-test: one early op, one late op
    await ctx.store.saveOperationLog(makeEntry('agent-filter-test', 'tool-x', tEarly));
    await ctx.store.saveOperationLog(makeEntry('agent-filter-test', 'tool-y', tLate));
    // Other agent late op (excluded by agentId filter)
    await ctx.store.saveOperationLog(makeEntry('agent-other', 'tool-z', tLate));

    // from = between tEarly and tLate — only the late agent-filter-test op matches
    const from = new Date(tEarly.getTime() + 30 * 60 * 1000); // 30 min after tEarly
    const { body } = await getJSON(
      ctx.port,
      `/operations/count?agentId=agent-filter-test&from=${encodeURIComponent(from.toISOString())}`
    );
    const b = body as { count: number };
    expect(b.count).toBe(1);
  });
});

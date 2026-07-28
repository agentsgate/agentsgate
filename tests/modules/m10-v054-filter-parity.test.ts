/**
 * v0.54 filter-parity tests
 *
 * T384 — GET /tools supports ?maxOps=N (excludes tools with more than N ops)
 *         AND ?minAvgRiskScore=0.N + ?maxAvgRiskScore=0.N range filter on avgRiskScore
 *
 * T385 — GET /sessions supports ?minAvgRisk=0.N (only sessions with avgRisk >= n)
 *         AND ?maxAvgRisk=0.N (only sessions with avgRisk <= n)
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeOp(
  agentId: string,
  tool: string,
  sessionId = 'sess-default',
  overrides: Partial<MCPOperation> = {}
): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId,
    tool,
    method: 'call',
    params: {},
    timestamp: new Date(),
    sessionId,
    ...overrides,
  };
}

function dec(
  action: ProxyDecision['action'] = 'allow',
  riskScore = 0.3
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
  const port = (
    (dash as unknown as { server: http.Server }).server.address() as { port: number }
  ).port;
  return { store, logger, dash, port };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
}

async function getJSON(
  port: number,
  path: string
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

// ── T384 — GET /tools ?maxOps=N filter ───────────────────────────────────────

describe('GET /tools ?maxOps=N filter (T384)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed three tools with distinct op counts:
   *   tool-heavy: 5 ops  avgRiskScore = (0.2*4 + 0.8) / 5 = 1.6/5 = 0.32
   *   tool-mid:   3 ops  avgRiskScore = (0.5 + 0.6 + 0.7) / 3 = 0.6
   *   tool-light: 1 op   avgRiskScore = 0.9
   */
  async function seedTools(ctx: Ctx): Promise<void> {
    // tool-heavy: 5 ops
    for (let i = 0; i < 4; i++) {
      await ctx.logger.log(makeOp('agent-a', 'tool-heavy'), dec('allow', 0.2));
    }
    await ctx.logger.log(makeOp('agent-a', 'tool-heavy'), dec('block', 0.8));

    // tool-mid: 3 ops
    await ctx.logger.log(makeOp('agent-b', 'tool-mid'), dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-b', 'tool-mid'), dec('allow', 0.6));
    await ctx.logger.log(makeOp('agent-b', 'tool-mid'), dec('allow', 0.7));

    // tool-light: 1 op
    await ctx.logger.log(makeOp('agent-c', 'tool-light'), dec('block', 0.9));
  }

  it('1. ?maxOps=3 excludes tool-heavy (5 ops) but includes tool-mid (3) and tool-light (1)', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?maxOps=3');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; totalOps: number }>; count: number };
    const names = b.tools.map(t => t.tool);
    expect(names).not.toContain('tool-heavy');
    expect(names).toContain('tool-mid');
    expect(names).toContain('tool-light');
    // count reflects only the filtered set
    expect(b.count).toBe(2);
  });

  it('2. ?maxOps=1 returns only tool-light (1 op), excludes tool-mid and tool-heavy', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?maxOps=1');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; totalOps: number }>; count: number };
    expect(b.count).toBe(1);
    expect(b.tools).toHaveLength(1);
    expect(b.tools[0]!.tool).toBe('tool-light');
    expect(b.tools[0]!.totalOps).toBe(1);
  });

  it('3. ?maxOps=5 includes all tools (none has more than 5 ops)', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?maxOps=5');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(3);
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-heavy');
    expect(names).toContain('tool-mid');
    expect(names).toContain('tool-light');
  });

  it('4. ?maxOps=0 excludes all tools (none has 0 or fewer ops)', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?maxOps=0');
    expect(status).toBe(200);
    const b = body as { tools: Array<unknown>; count: number };
    expect(b.count).toBe(0);
    expect(b.tools).toHaveLength(0);
  });

  it('5. tools returned by ?maxOps=N all have totalOps <= N', async () => {
    ctx = await setup();
    await seedTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?maxOps=4');
    const b = body as { tools: Array<{ tool: string; totalOps: number }> };
    for (const t of b.tools) {
      expect(t.totalOps).toBeLessThanOrEqual(4);
    }
    // tool-heavy (5) must not be present
    expect(b.tools.map(t => t.tool)).not.toContain('tool-heavy');
  });
});

// ── T384 — GET /tools ?minAvgRiskScore / ?maxAvgRiskScore filter ──────────────

describe('GET /tools ?minAvgRiskScore / ?maxAvgRiskScore filter (T384)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed three tools with distinct avgRiskScore values:
   *   tool-low:  2 ops at 0.1 each  → avgRiskScore = 0.1
   *   tool-mid:  2 ops at 0.5 each  → avgRiskScore = 0.5
   *   tool-high: 2 ops at 0.9 each  → avgRiskScore = 0.9
   */
  async function seedRiskTools(ctx: Ctx): Promise<void> {
    await ctx.logger.log(makeOp('agent-a', 'tool-low'),  dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-low'),  dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-mid'),  dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-b', 'tool-mid'),  dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-c', 'tool-high'), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-c', 'tool-high'), dec('block', 0.9));
  }

  it('6. ?minAvgRiskScore=0.5 returns tool-mid and tool-high, excludes tool-low', async () => {
    ctx = await setup();
    await seedRiskTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?minAvgRiskScore=0.5');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; avgRiskScore: number }>; count: number };
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-mid');
    expect(names).toContain('tool-high');
    expect(names).not.toContain('tool-low');
    expect(b.count).toBe(2);
    // All returned tools must satisfy the filter
    for (const t of b.tools) {
      expect(t.avgRiskScore).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('7. ?maxAvgRiskScore=0.5 returns tool-low and tool-mid, excludes tool-high', async () => {
    ctx = await setup();
    await seedRiskTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?maxAvgRiskScore=0.5');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; avgRiskScore: number }>; count: number };
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-low');
    expect(names).toContain('tool-mid');
    expect(names).not.toContain('tool-high');
    expect(b.count).toBe(2);
    for (const t of b.tools) {
      expect(t.avgRiskScore).toBeLessThanOrEqual(0.5);
    }
  });

  it('8. ?minAvgRiskScore=0.5&maxAvgRiskScore=0.5 returns only tool-mid (exact boundary)', async () => {
    ctx = await setup();
    await seedRiskTools(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?minAvgRiskScore=0.5&maxAvgRiskScore=0.5');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; avgRiskScore: number }>; count: number };
    expect(b.count).toBe(1);
    expect(b.tools[0]!.tool).toBe('tool-mid');
    expect(b.tools[0]!.avgRiskScore).toBeCloseTo(0.5, 5);
  });

  it('9. ?minAvgRiskScore=0.9 returns only tool-high', async () => {
    ctx = await setup();
    await seedRiskTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?minAvgRiskScore=0.9');
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.count).toBe(1);
    expect(b.tools[0]!.tool).toBe('tool-high');
  });

  it('10. ?maxAvgRiskScore=0.09 excludes all tools (none has avgRiskScore that low)', async () => {
    ctx = await setup();
    await seedRiskTools(ctx);

    const { body } = await getJSON(ctx.port, '/tools?maxAvgRiskScore=0.09');
    const b = body as { tools: Array<unknown>; count: number };
    expect(b.count).toBe(0);
    expect(b.tools).toHaveLength(0);
  });

  it('11. ?minAvgRiskScore combined with ?maxOps narrows both dimensions', async () => {
    ctx = await setup();
    // tool-low:  1 op, avgRiskScore=0.1  (totalOps=1, avgRisk=0.1 — excluded by minAvgRiskScore)
    // tool-mid:  2 ops, avgRiskScore=0.5 (totalOps=2, avgRisk=0.5 — passes both)
    // tool-high: 5 ops, avgRiskScore=0.9 (totalOps=5 — excluded by maxOps=3)
    await ctx.logger.log(makeOp('agent-a', 'tool-low'),  dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-mid'),  dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-b', 'tool-mid'),  dec('allow', 0.5));
    for (let i = 0; i < 5; i++) {
      await ctx.logger.log(makeOp('agent-c', 'tool-high'), dec('block', 0.9));
    }

    const { status, body } = await getJSON(ctx.port, '/tools?minAvgRiskScore=0.4&maxOps=3');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; totalOps: number; avgRiskScore: number }>; count: number };
    expect(b.count).toBe(1);
    expect(b.tools[0]!.tool).toBe('tool-mid');
    expect(b.tools[0]!.totalOps).toBeLessThanOrEqual(3);
    expect(b.tools[0]!.avgRiskScore).toBeGreaterThanOrEqual(0.4);
  });
});

// ── T385 — GET /sessions ?minAvgRisk filter ───────────────────────────────────

describe('GET /sessions ?minAvgRisk filter (T385)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed three sessions with distinct avgRisk values:
   *   sess-low:  2 ops at 0.1 each → avgRisk = 0.1
   *   sess-mid:  2 ops at 0.5 each → avgRisk = 0.5
   *   sess-high: 2 ops at 0.9 each → avgRisk = 0.9
   */
  async function seedSessions(ctx: Ctx): Promise<void> {
    await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-low'),  dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-low'),  dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-mid'),  dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-mid'),  dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-high'), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-high'), dec('block', 0.9));
  }

  it('12. ?minAvgRisk=0.5 returns sess-mid and sess-high, excludes sess-low', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions?minAvgRisk=0.5');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; avgRisk: number }>; count: number };
    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('sess-mid');
    expect(ids).toContain('sess-high');
    expect(ids).not.toContain('sess-low');
    expect(b.count).toBe(2);
    // Every returned session must satisfy the filter
    for (const s of b.data) {
      expect(s.avgRisk).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('13. ?minAvgRisk=0.9 returns only sess-high', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions?minAvgRisk=0.9');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; avgRisk: number }>; count: number };
    expect(b.count).toBe(1);
    expect(b.data[0]!.sessionId).toBe('sess-high');
    expect(b.data[0]!.avgRisk).toBeCloseTo(0.9, 5);
  });

  it('14. ?minAvgRisk=0.95 excludes all sessions (none has avgRisk that high)', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?minAvgRisk=0.95');
    const b = body as { data: Array<unknown>; count: number };
    expect(b.count).toBe(0);
    expect(b.data).toHaveLength(0);
  });

  it('15. ?minAvgRisk=0.0 returns all sessions (trivial lower bound)', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?minAvgRisk=0.0');
    const b = body as { data: Array<unknown>; count: number };
    expect(b.count).toBe(3);
  });
});

// ── T385 — GET /sessions ?maxAvgRisk filter ───────────────────────────────────

describe('GET /sessions ?maxAvgRisk filter (T385)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  async function seedSessions(ctx: Ctx): Promise<void> {
    await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-low'),  dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-low'),  dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-mid'),  dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-mid'),  dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-high'), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-high'), dec('block', 0.9));
  }

  it('16. ?maxAvgRisk=0.5 returns sess-low and sess-mid, excludes sess-high', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions?maxAvgRisk=0.5');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; avgRisk: number }>; count: number };
    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('sess-low');
    expect(ids).toContain('sess-mid');
    expect(ids).not.toContain('sess-high');
    expect(b.count).toBe(2);
    for (const s of b.data) {
      expect(s.avgRisk).toBeLessThanOrEqual(0.5);
    }
  });

  it('17. ?maxAvgRisk=0.1 returns only sess-low', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions?maxAvgRisk=0.1');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; avgRisk: number }>; count: number };
    expect(b.count).toBe(1);
    expect(b.data[0]!.sessionId).toBe('sess-low');
    expect(b.data[0]!.avgRisk).toBeCloseTo(0.1, 5);
  });

  it('18. ?maxAvgRisk=0.05 excludes all sessions (none has avgRisk that low)', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?maxAvgRisk=0.05');
    const b = body as { data: Array<unknown>; count: number };
    expect(b.count).toBe(0);
    expect(b.data).toHaveLength(0);
  });

  it('19. ?maxAvgRisk=1.0 returns all sessions (trivial upper bound)', async () => {
    ctx = await setup();
    await seedSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?maxAvgRisk=1.0');
    const b = body as { data: Array<unknown>; count: number };
    expect(b.count).toBe(3);
  });
});

// ── T385 — GET /sessions combined minAvgRisk + maxAvgRisk range ───────────────

describe('GET /sessions combined ?minAvgRisk + ?maxAvgRisk range (T385)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed four sessions with well-separated avgRisk values:
   *   sess-very-low:  avgRisk = 0.1
   *   sess-low-mid:   avgRisk = 0.3
   *   sess-mid:       avgRisk = 0.6
   *   sess-high:      avgRisk = 0.9
   */
  async function seedFourSessions(ctx: Ctx): Promise<void> {
    await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-very-low'),  dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'fs', 'sess-low-mid'),   dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-b', 'fs', 'sess-mid'),       dec('allow', 0.6));
    await ctx.logger.log(makeOp('agent-c', 'fs', 'sess-high'),      dec('block', 0.9));
  }

  it('20. ?minAvgRisk=0.3&maxAvgRisk=0.6 returns only sess-low-mid and sess-mid', async () => {
    ctx = await setup();
    await seedFourSessions(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions?minAvgRisk=0.3&maxAvgRisk=0.6');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; avgRisk: number }>; count: number };
    expect(b.count).toBe(2);
    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('sess-low-mid');
    expect(ids).toContain('sess-mid');
    expect(ids).not.toContain('sess-very-low');
    expect(ids).not.toContain('sess-high');
    for (const s of b.data) {
      expect(s.avgRisk).toBeGreaterThanOrEqual(0.3);
      expect(s.avgRisk).toBeLessThanOrEqual(0.6);
    }
  });

  it('21. ?minAvgRisk=0.1&maxAvgRisk=0.1 returns only sess-very-low (exact boundary match)', async () => {
    ctx = await setup();
    await seedFourSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?minAvgRisk=0.1&maxAvgRisk=0.1');
    const b = body as { data: Array<{ sessionId: string; avgRisk: number }>; count: number };
    expect(b.count).toBe(1);
    expect(b.data[0]!.sessionId).toBe('sess-very-low');
    expect(b.data[0]!.avgRisk).toBeCloseTo(0.1, 5);
  });

  it('22. ?minAvgRisk=0.5&maxAvgRisk=0.95 returns sess-mid and sess-high', async () => {
    ctx = await setup();
    await seedFourSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?minAvgRisk=0.5&maxAvgRisk=0.95');
    const b = body as { data: Array<{ sessionId: string; avgRisk: number }>; count: number };
    expect(b.count).toBe(2);
    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('sess-mid');
    expect(ids).toContain('sess-high');
    expect(ids).not.toContain('sess-very-low');
    expect(ids).not.toContain('sess-low-mid');
  });

  it('23. reversed range (minAvgRisk > maxAvgRisk) returns empty result', async () => {
    ctx = await setup();
    await seedFourSessions(ctx);

    // min > max is a logically empty range
    const { body } = await getJSON(ctx.port, '/sessions?minAvgRisk=0.8&maxAvgRisk=0.2');
    const b = body as { data: Array<unknown>; count: number };
    expect(b.count).toBe(0);
    expect(b.data).toHaveLength(0);
  });

  it('24. ?minAvgRisk filter can be combined with ?agentId to narrow both dimensions', async () => {
    ctx = await setup();
    // agent-x has a low-risk session and a high-risk session
    await ctx.logger.log(makeOp('agent-x', 'fs', 'sess-x-low'),  dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-x', 'fs', 'sess-x-high'), dec('block', 0.9));
    // agent-y also has a high-risk session but should be excluded by agentId filter
    await ctx.logger.log(makeOp('agent-y', 'fs', 'sess-y-high'), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/sessions?agentId=agent-x&minAvgRisk=0.5');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; avgRisk: number }>; count: number };
    expect(b.count).toBe(1);
    expect(b.data[0]!.sessionId).toBe('sess-x-high');
    expect(b.data[0]!.avgRisk).toBeGreaterThanOrEqual(0.5);
  });

  it('25. avgRisk field is present in each returned session object', async () => {
    ctx = await setup();
    await seedFourSessions(ctx);

    const { body } = await getJSON(ctx.port, '/sessions?minAvgRisk=0.0');
    const b = body as { data: Array<Record<string, unknown>> };
    for (const s of b.data) {
      expect(s).toHaveProperty('avgRisk');
      expect(typeof s['avgRisk']).toBe('number');
    }
  });
});

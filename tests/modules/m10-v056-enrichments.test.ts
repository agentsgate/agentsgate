/**
 * v0.56 enrichment tests
 *
 * T394 — GET /operations/summary includes minRiskScore and maxRiskScore fields
 *         - minRiskScore is the minimum riskScore across all ops
 *         - maxRiskScore is the maximum riskScore across all ops
 *         - both are 0 when no ops exist
 *
 * T395 — GET /sessions/:id includes topTools array
 *         - topTools is sorted by count desc
 *         - contains entries with {tool, count} shape
 *         - top 5 tools in the session
 *
 * T396 — GET /tools/:tool includes recentOps array
 *         - recentOps contains at most 5 entries
 *         - each entry has operationId, agentId, method, action, riskScore, timestamp
 *         - sorted by most recent first (default store ordering)
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

// ── T394 — GET /operations/summary minRiskScore and maxRiskScore ───────────────

describe('GET /operations/summary — minRiskScore and maxRiskScore (T394)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds 3 ops with clearly separated risk scores:
   *   low  = 0.1
   *   mid  = 0.5
   *   high = 0.9
   */
  async function seedMixedRiskOps(ctx: Ctx): Promise<void> {
    await ctx.logger.log(makeOp('agent-a', 'tool-x', 'sess-a'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-y', 'sess-b'), dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-c', 'tool-z', 'sess-c'), dec('block', 0.9));
  }

  it('1. minRiskScore and maxRiskScore are present in /operations/summary response', async () => {
    ctx = await setup();
    await seedMixedRiskOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['minRiskScore']).toBeDefined();
    expect(b['maxRiskScore']).toBeDefined();
  });

  it('2. minRiskScore equals the lowest riskScore across all ops (0.1)', async () => {
    ctx = await setup();
    await seedMixedRiskOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { minRiskScore: number };
    expect(b.minRiskScore).toBeCloseTo(0.1, 5);
  });

  it('3. maxRiskScore equals the highest riskScore across all ops (0.9)', async () => {
    ctx = await setup();
    await seedMixedRiskOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { maxRiskScore: number };
    expect(b.maxRiskScore).toBeCloseTo(0.9, 5);
  });

  it('4. empty DB — minRiskScore and maxRiskScore are both 0', async () => {
    ctx = await setup();
    // No ops seeded

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { minRiskScore: number; maxRiskScore: number };
    expect(b.minRiskScore).toBe(0);
    expect(b.maxRiskScore).toBe(0);
  });

  it('5. single op — minRiskScore equals maxRiskScore equals that op riskScore', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-solo', 'tool-solo', 'sess-solo'), dec('allow', 0.42));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { minRiskScore: number; maxRiskScore: number };
    expect(b.minRiskScore).toBeCloseTo(0.42, 5);
    expect(b.maxRiskScore).toBeCloseTo(0.42, 5);
  });

  it('6. minRiskScore and maxRiskScore are numeric types', async () => {
    ctx = await setup();
    await seedMixedRiskOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { minRiskScore: unknown; maxRiskScore: unknown };
    expect(typeof b.minRiskScore).toBe('number');
    expect(typeof b.maxRiskScore).toBe('number');
  });

  it('7. minRiskScore is less than or equal to maxRiskScore', async () => {
    ctx = await setup();
    await seedMixedRiskOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { minRiskScore: number; maxRiskScore: number };
    expect(b.minRiskScore).toBeLessThanOrEqual(b.maxRiskScore);
  });

  it('8. two ops with same riskScore — minRiskScore equals maxRiskScore', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-a', 'sess-1'), dec('allow', 0.55));
    await ctx.logger.log(makeOp('agent-b', 'tool-b', 'sess-2'), dec('allow', 0.55));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { minRiskScore: number; maxRiskScore: number };
    expect(b.minRiskScore).toBeCloseTo(0.55, 5);
    expect(b.maxRiskScore).toBeCloseTo(0.55, 5);
  });

  it('9. adding a higher-risk op updates maxRiskScore without changing minRiskScore', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-a', 'sess-1'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'tool-a', 'sess-2'), dec('allow', 0.4));

    // Before adding the high-risk op
    const { body: body1 } = await getJSON(ctx.port, '/operations/summary');
    const b1 = body1 as { minRiskScore: number; maxRiskScore: number };
    expect(b1.minRiskScore).toBeCloseTo(0.2, 5);
    expect(b1.maxRiskScore).toBeCloseTo(0.4, 5);

    // Add higher-risk op
    await ctx.logger.log(makeOp('agent-b', 'tool-b', 'sess-3'), dec('block', 0.95));

    const { body: body2 } = await getJSON(ctx.port, '/operations/summary');
    const b2 = body2 as { minRiskScore: number; maxRiskScore: number };
    expect(b2.minRiskScore).toBeCloseTo(0.2, 5);
    expect(b2.maxRiskScore).toBeCloseTo(0.95, 5);
  });

  it('10. extreme values — minRiskScore 0.01, maxRiskScore 0.99 are captured correctly', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-a', 'sess-1'), dec('allow', 0.01));
    await ctx.logger.log(makeOp('agent-b', 'tool-b', 'sess-2'), dec('allow', 0.5));
    await ctx.logger.log(makeOp('agent-c', 'tool-c', 'sess-3'), dec('block', 0.99));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { minRiskScore: number; maxRiskScore: number };
    expect(b.minRiskScore).toBeCloseTo(0.01, 5);
    expect(b.maxRiskScore).toBeCloseTo(0.99, 5);
  });
});

// ── T395 — GET /sessions/:id includes topTools array ──────────────────────────

describe('GET /sessions/:id — topTools array (T395)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds a session with ops using multiple different tools:
   *   tool-a: 3 ops
   *   tool-b: 2 ops
   *   tool-c: 1 op
   */
  async function seedSessionWithTools(ctx: Ctx, sessionId = 'sess-tools'): Promise<void> {
    await ctx.logger.log(makeOp('agent-a', 'tool-a', sessionId), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'tool-a', sessionId), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-a', 'tool-a', sessionId), dec('allow', 0.4));
    await ctx.logger.log(makeOp('agent-a', 'tool-b', sessionId), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-b', sessionId), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'tool-c', sessionId), dec('allow', 0.1));
  }

  it('11. topTools is present in GET /sessions/:id response', async () => {
    ctx = await setup();
    await seedSessionWithTools(ctx, 'sess-t395-a');

    const { status, body } = await getJSON(ctx.port, '/sessions/sess-t395-a');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['topTools']).toBeDefined();
    expect(Array.isArray(b['topTools'])).toBe(true);
  });

  it('12. topTools entries have {tool, count} shape', async () => {
    ctx = await setup();
    await seedSessionWithTools(ctx, 'sess-t395-b');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t395-b');
    const b = body as { topTools: Array<Record<string, unknown>> };
    expect(b.topTools.length).toBeGreaterThanOrEqual(1);
    for (const entry of b.topTools) {
      expect(entry).toHaveProperty('tool');
      expect(entry).toHaveProperty('count');
      expect(typeof entry['tool']).toBe('string');
      expect(typeof entry['count']).toBe('number');
    }
  });

  it('13. topTools[0].tool is tool-a (most used) and topTools[0].count is 3', async () => {
    ctx = await setup();
    await seedSessionWithTools(ctx, 'sess-t395-c');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t395-c');
    const b = body as { topTools: Array<{ tool: string; count: number }> };
    expect(b.topTools[0]!.tool).toBe('tool-a');
    expect(b.topTools[0]!.count).toBe(3);
  });

  it('14. topTools is sorted by count descending', async () => {
    ctx = await setup();
    await seedSessionWithTools(ctx, 'sess-t395-d');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t395-d');
    const b = body as { topTools: Array<{ tool: string; count: number }> };
    expect(b.topTools.length).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < b.topTools.length - 1; i++) {
      expect(b.topTools[i]!.count).toBeGreaterThanOrEqual(b.topTools[i + 1]!.count);
    }
  });

  it('15. topTools correctly shows tool-b with count 2, tool-c with count 1', async () => {
    ctx = await setup();
    await seedSessionWithTools(ctx, 'sess-t395-e');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t395-e');
    const b = body as { topTools: Array<{ tool: string; count: number }> };
    const toolB = b.topTools.find(t => t.tool === 'tool-b');
    const toolC = b.topTools.find(t => t.tool === 'tool-c');
    expect(toolB).toBeDefined();
    expect(toolB!.count).toBe(2);
    expect(toolC).toBeDefined();
    expect(toolC!.count).toBe(1);
  });

  it('16. topTools contains at most 5 entries when session has 6+ distinct tools', async () => {
    ctx = await setup();
    // Seed a session with 7 distinct tools
    const sess = 'sess-t395-f';
    const tools = ['tool-1', 'tool-2', 'tool-3', 'tool-4', 'tool-5', 'tool-6', 'tool-7'];
    for (let i = 0; i < tools.length; i++) {
      // Give each tool a distinct count by seeding i+1 ops
      for (let j = 0; j <= i; j++) {
        await ctx.logger.log(makeOp('agent-a', tools[i]!, sess), dec('allow', 0.2));
      }
    }

    const { body } = await getJSON(ctx.port, `/sessions/${sess}`);
    const b = body as { topTools: Array<{ tool: string; count: number }> };
    expect(b.topTools.length).toBeLessThanOrEqual(5);
  });

  it('17. session with single-tool ops returns topTools with one entry', async () => {
    ctx = await setup();
    const sess = 'sess-t395-g';
    await ctx.logger.log(makeOp('agent-a', 'only-tool', sess), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'only-tool', sess), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, `/sessions/${sess}`);
    const b = body as { topTools: Array<{ tool: string; count: number }> };
    expect(b.topTools).toHaveLength(1);
    expect(b.topTools[0]!.tool).toBe('only-tool');
    expect(b.topTools[0]!.count).toBe(2);
  });

  it('18. topTools only includes tools for the requested session, not other sessions', async () => {
    ctx = await setup();
    // Seed target session with tool-target
    await ctx.logger.log(makeOp('agent-a', 'tool-target', 'sess-t395-h'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-target', 'sess-t395-h'), dec('allow', 0.2));
    // Seed another session with tool-other (higher count, but different session)
    await ctx.logger.log(makeOp('agent-b', 'tool-other', 'sess-other'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-other', 'sess-other'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-b', 'tool-other', 'sess-other'), dec('allow', 0.3));

    const { body } = await getJSON(ctx.port, '/sessions/sess-t395-h');
    const b = body as { topTools: Array<{ tool: string; count: number }> };
    const toolNames = b.topTools.map(t => t.tool);
    expect(toolNames).toContain('tool-target');
    expect(toolNames).not.toContain('tool-other');
  });

  it('19. topTools count values total to the session totalOps', async () => {
    ctx = await setup();
    await seedSessionWithTools(ctx, 'sess-t395-i');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t395-i');
    const b = body as { topTools: Array<{ tool: string; count: number }>; totalOps: number };
    const toolCountSum = b.topTools.reduce((acc, t) => acc + t.count, 0);
    // All 3 distinct tools are in top 5, so sum should equal totalOps
    expect(toolCountSum).toBe(b.totalOps);
  });

  it('20. topTools second entry is tool-b with count 2', async () => {
    ctx = await setup();
    await seedSessionWithTools(ctx, 'sess-t395-j');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t395-j');
    const b = body as { topTools: Array<{ tool: string; count: number }> };
    expect(b.topTools.length).toBeGreaterThanOrEqual(2);
    expect(b.topTools[1]!.tool).toBe('tool-b');
    expect(b.topTools[1]!.count).toBe(2);
  });
});

// ── T396 — GET /tools/:tool includes recentOps array ─────────────────────────

describe('GET /tools/:tool — recentOps array (T396)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds tool-x with 7 ops to verify the 5-entry cap.
   */
  async function seedToolWithManyOps(ctx: Ctx, tool = 'tool-x'): Promise<void> {
    for (let i = 0; i < 7; i++) {
      await ctx.logger.log(
        makeOp(`agent-${i}`, tool, `sess-${i}`),
        dec('allow', 0.1 + i * 0.1)
      );
    }
  }

  it('21. recentOps is present in GET /tools/:tool response', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-r396', 'sess-1'), dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/tools/tool-r396');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['recentOps']).toBeDefined();
    expect(Array.isArray(b['recentOps'])).toBe(true);
  });

  it('22. recentOps contains at most 5 entries when 7 ops exist', async () => {
    ctx = await setup();
    await seedToolWithManyOps(ctx, 'tool-r396-cap');

    const { body } = await getJSON(ctx.port, '/tools/tool-r396-cap');
    const b = body as { recentOps: unknown[] };
    expect(b.recentOps.length).toBeLessThanOrEqual(5);
  });

  it('23. recentOps entries have operationId field', async () => {
    ctx = await setup();
    await seedToolWithManyOps(ctx, 'tool-r396-oid');

    const { body } = await getJSON(ctx.port, '/tools/tool-r396-oid');
    const b = body as { recentOps: Array<Record<string, unknown>> };
    for (const entry of b.recentOps) {
      expect(entry).toHaveProperty('operationId');
      expect(typeof entry['operationId']).toBe('string');
    }
  });

  it('24. recentOps entries have agentId field', async () => {
    ctx = await setup();
    await seedToolWithManyOps(ctx, 'tool-r396-aid');

    const { body } = await getJSON(ctx.port, '/tools/tool-r396-aid');
    const b = body as { recentOps: Array<Record<string, unknown>> };
    expect(b.recentOps.length).toBeGreaterThanOrEqual(1);
    for (const entry of b.recentOps) {
      expect(entry).toHaveProperty('agentId');
      expect(typeof entry['agentId']).toBe('string');
    }
  });

  it('25. recentOps entries have method field', async () => {
    ctx = await setup();
    await seedToolWithManyOps(ctx, 'tool-r396-mth');

    const { body } = await getJSON(ctx.port, '/tools/tool-r396-mth');
    const b = body as { recentOps: Array<Record<string, unknown>> };
    for (const entry of b.recentOps) {
      expect(entry).toHaveProperty('method');
      expect(typeof entry['method']).toBe('string');
    }
  });

  it('26. recentOps entries have action field', async () => {
    ctx = await setup();
    await seedToolWithManyOps(ctx, 'tool-r396-act');

    const { body } = await getJSON(ctx.port, '/tools/tool-r396-act');
    const b = body as { recentOps: Array<Record<string, unknown>> };
    for (const entry of b.recentOps) {
      expect(entry).toHaveProperty('action');
      expect(typeof entry['action']).toBe('string');
    }
  });

  it('27. recentOps entries have riskScore field as a number', async () => {
    ctx = await setup();
    await seedToolWithManyOps(ctx, 'tool-r396-rs');

    const { body } = await getJSON(ctx.port, '/tools/tool-r396-rs');
    const b = body as { recentOps: Array<Record<string, unknown>> };
    for (const entry of b.recentOps) {
      expect(entry).toHaveProperty('riskScore');
      expect(typeof entry['riskScore']).toBe('number');
    }
  });

  it('28. recentOps entries have timestamp field as a string', async () => {
    ctx = await setup();
    await seedToolWithManyOps(ctx, 'tool-r396-ts');

    const { body } = await getJSON(ctx.port, '/tools/tool-r396-ts');
    const b = body as { recentOps: Array<Record<string, unknown>> };
    for (const entry of b.recentOps) {
      expect(entry).toHaveProperty('timestamp');
      expect(typeof entry['timestamp']).toBe('string');
    }
  });

  it('29. recentOps is empty when tool has no ops (unknown tool returns 404)', async () => {
    ctx = await setup();

    const { status } = await getJSON(ctx.port, '/tools/tool-r396-unknown');
    expect(status).toBe(404);
  });

  it('30. recentOps contains exactly 1 entry when tool has 1 op', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-r396-one', 'sess-one'), dec('allow', 0.25));

    const { body } = await getJSON(ctx.port, '/tools/tool-r396-one');
    const b = body as { recentOps: Array<Record<string, unknown>> };
    expect(b.recentOps).toHaveLength(1);
  });

  it('31. recentOps entries reflect the correct agentId for each seeded op', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-alpha', 'tool-r396-chk', 'sess-1'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-beta',  'tool-r396-chk', 'sess-2'), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/tools/tool-r396-chk');
    const b = body as { recentOps: Array<{ agentId: string }> };
    const agentIds = b.recentOps.map(e => e.agentId);
    expect(agentIds).toContain('agent-alpha');
    expect(agentIds).toContain('agent-beta');
  });

  it('32. recentOps length is exactly 5 when tool has exactly 5 ops', async () => {
    ctx = await setup();
    for (let i = 0; i < 5; i++) {
      await ctx.logger.log(
        makeOp(`agent-${i}`, 'tool-r396-five', `sess-${i}`),
        dec('allow', 0.2)
      );
    }

    const { body } = await getJSON(ctx.port, '/tools/tool-r396-five');
    const b = body as { recentOps: unknown[] };
    expect(b.recentOps).toHaveLength(5);
  });

  it('33. recentOps riskScore values match the seeded dec riskScore values', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-r396-val', 'sess-1'), dec('allow', 0.11));
    await ctx.logger.log(makeOp('agent-b', 'tool-r396-val', 'sess-2'), dec('block', 0.88));

    const { body } = await getJSON(ctx.port, '/tools/tool-r396-val');
    const b = body as { recentOps: Array<{ riskScore: number }> };
    const scores = b.recentOps.map(e => e.riskScore);
    expect(scores.some(s => Math.abs(s - 0.11) < 0.001 || Math.abs(s - 0.88) < 0.001)).toBe(true);
  });

  it('34. recentOps all entries action values are valid action strings', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-r396-action', 'sess-1'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-r396-action', 'sess-2'), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-c', 'tool-r396-action', 'sess-3'), dec('require_approval', 0.5));

    const { body } = await getJSON(ctx.port, '/tools/tool-r396-action');
    const b = body as { recentOps: Array<{ action: string }> };
    const validActions = new Set(['allow', 'block', 'require_approval']);
    for (const entry of b.recentOps) {
      expect(validActions.has(entry.action)).toBe(true);
    }
  });

  it('35. recentOps length is capped at 5 when tool has many more than 5 ops', async () => {
    ctx = await setup();
    // Seed 10 ops
    for (let i = 0; i < 10; i++) {
      await ctx.logger.log(
        makeOp(`agent-${i}`, 'tool-r396-ten', `sess-${i}`),
        dec('allow', 0.1 + i * 0.05)
      );
    }

    const { body } = await getJSON(ctx.port, '/tools/tool-r396-ten');
    const b = body as { recentOps: unknown[] };
    expect(b.recentOps).toHaveLength(5);
  });
});

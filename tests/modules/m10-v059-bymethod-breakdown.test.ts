/**
 * v0.59 feature tests
 *
 * T409 — GET /agents/:agentId includes byMethod object
 *   - byMethod is a Record<string, number> with method names as keys
 *   - The counts reflect how many ops used each method
 *
 * T410 — GET /tools/:tool includes byMethod object (same shape)
 *
 * T411 — GET /sessions/:id includes byMethod object (same shape)
 *
 * T412 — GET /risk supports ?method=<name> filter
 *   - Only returns risk entries for ops with that method
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeOp(agentId: string, tool: string, overrides: Partial<MCPOperation> = {}): MCPOperation {
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

// ── T409 — GET /agents/:agentId includes byMethod ────────────────────────────

describe('GET /agents/:agentId — byMethod object (T409)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds agent-bm with:
   *   'call'  → 3 ops
   *   'read'  → 2 ops
   *   'write' → 1 op
   */
  async function seedAgentWithMethods(agentId = 'agent-bm'): Promise<void> {
    await ctx.logger.log(makeOp(agentId, 'tool-a', { method: 'call', sessionId: 'sess-c1' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp(agentId, 'tool-a', { method: 'call', sessionId: 'sess-c2' }), dec('allow', 0.3));
    await ctx.logger.log(makeOp(agentId, 'tool-b', { method: 'call', sessionId: 'sess-c3' }), dec('allow', 0.4));
    await ctx.logger.log(makeOp(agentId, 'tool-b', { method: 'read', sessionId: 'sess-r1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp(agentId, 'tool-c', { method: 'read', sessionId: 'sess-r2' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp(agentId, 'tool-c', { method: 'write', sessionId: 'sess-w1' }), dec('block', 0.8));
  }

  it('1. GET /agents/:agentId response includes byMethod field', async () => {
    ctx = await setup();
    await seedAgentWithMethods('agent-t409-1');

    const { status, body } = await getJSON(ctx.port, '/agents/agent-t409-1');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['byMethod']).toBeDefined();
    expect(typeof b['byMethod']).toBe('object');
    expect(b['byMethod']).not.toBeNull();
  });

  it('2. byMethod is a Record<string, number> — keys are method names, values are counts', async () => {
    ctx = await setup();
    await seedAgentWithMethods('agent-t409-2');

    const { body } = await getJSON(ctx.port, '/agents/agent-t409-2');
    const b = body as { byMethod: Record<string, number> };
    expect(typeof b.byMethod['call']).toBe('number');
    expect(typeof b.byMethod['read']).toBe('number');
    expect(typeof b.byMethod['write']).toBe('number');
  });

  it('3. byMethod counts accurately reflect how many ops used each method', async () => {
    ctx = await setup();
    await seedAgentWithMethods('agent-t409-3');

    const { body } = await getJSON(ctx.port, '/agents/agent-t409-3');
    const b = body as { byMethod: Record<string, number> };
    expect(b.byMethod['call']).toBe(3);
    expect(b.byMethod['read']).toBe(2);
    expect(b.byMethod['write']).toBe(1);
  });

  it('4. byMethod only contains methods actually used by this agent (no zero-count entries)', async () => {
    ctx = await setup();
    await seedAgentWithMethods('agent-t409-4');

    const { body } = await getJSON(ctx.port, '/agents/agent-t409-4');
    const b = body as { byMethod: Record<string, number> };
    // All values should be positive integers
    for (const [, count] of Object.entries(b.byMethod)) {
      expect(count).toBeGreaterThan(0);
      expect(Number.isInteger(count)).toBe(true);
    }
  });

  it('5. byMethod sum equals totalOps when all ops are for this agent', async () => {
    ctx = await setup();
    await seedAgentWithMethods('agent-t409-5');

    const { body } = await getJSON(ctx.port, '/agents/agent-t409-5');
    const b = body as { byMethod: Record<string, number>; totalOps: number };
    const methodSum = Object.values(b.byMethod).reduce((acc, v) => acc + v, 0);
    expect(methodSum).toBe(b.totalOps);
  });

  it('6. single-method agent — byMethod has exactly one key with correct count', async () => {
    ctx = await setup();
    const agentId = 'agent-t409-6';
    await ctx.logger.log(makeOp(agentId, 'tool-a', { method: 'call', sessionId: 's1' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp(agentId, 'tool-b', { method: 'call', sessionId: 's2' }), dec('allow', 0.3));
    await ctx.logger.log(makeOp(agentId, 'tool-c', { method: 'call', sessionId: 's3' }), dec('allow', 0.4));

    const { body } = await getJSON(ctx.port, `/agents/${agentId}`);
    const b = body as { byMethod: Record<string, number> };
    const keys = Object.keys(b.byMethod);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe('call');
    expect(b.byMethod['call']).toBe(3);
  });

  it('7. byMethod does not include methods used by other agents', async () => {
    ctx = await setup();
    const agentId = 'agent-t409-7';
    // Our agent uses only 'call'
    await ctx.logger.log(makeOp(agentId, 'tool-a', { method: 'call', sessionId: 's1' }), dec('allow', 0.2));
    // Another agent uses 'notify'
    await ctx.logger.log(makeOp('agent-other', 'tool-b', { method: 'notify', sessionId: 's2' }), dec('allow', 0.1));

    const { body } = await getJSON(ctx.port, `/agents/${agentId}`);
    const b = body as { byMethod: Record<string, number> };
    expect(Object.keys(b.byMethod)).not.toContain('notify');
    expect(b.byMethod['call']).toBe(1);
  });

  it('8. byMethod key count matches number of distinct methods used by the agent', async () => {
    ctx = await setup();
    await seedAgentWithMethods('agent-t409-8');

    const { body } = await getJSON(ctx.port, '/agents/agent-t409-8');
    const b = body as { byMethod: Record<string, number> };
    // We seeded 3 distinct methods: call, read, write
    expect(Object.keys(b.byMethod)).toHaveLength(3);
    expect(Object.keys(b.byMethod)).toContain('call');
    expect(Object.keys(b.byMethod)).toContain('read');
    expect(Object.keys(b.byMethod)).toContain('write');
  });
});

// ── T410 — GET /tools/:tool includes byMethod ─────────────────────────────────

describe('GET /tools/:tool — byMethod object (T410)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds tool-bm with:
   *   'call'  → 4 ops across multiple agents/sessions
   *   'read'  → 3 ops
   *   'write' → 2 ops
   */
  async function seedToolWithMethods(tool = 'tool-bm'): Promise<void> {
    await ctx.logger.log(makeOp('agent-a', tool, { method: 'call', sessionId: 'sc1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', tool, { method: 'call', sessionId: 'sc2' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-b', tool, { method: 'call', sessionId: 'sc3' }), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-b', tool, { method: 'call', sessionId: 'sc4' }), dec('allow', 0.4));
    await ctx.logger.log(makeOp('agent-a', tool, { method: 'read', sessionId: 'sr1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', tool, { method: 'read', sessionId: 'sr2' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-c', tool, { method: 'read', sessionId: 'sr3' }), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-a', tool, { method: 'write', sessionId: 'sw1' }), dec('block', 0.7));
    await ctx.logger.log(makeOp('agent-c', tool, { method: 'write', sessionId: 'sw2' }), dec('block', 0.8));
  }

  it('9. GET /tools/:tool response includes byMethod field', async () => {
    ctx = await setup();
    await seedToolWithMethods('tool-t410-1');

    const { status, body } = await getJSON(ctx.port, '/tools/tool-t410-1');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['byMethod']).toBeDefined();
    expect(typeof b['byMethod']).toBe('object');
    expect(b['byMethod']).not.toBeNull();
  });

  it('10. byMethod is a Record<string, number> — keys are method names, values are counts', async () => {
    ctx = await setup();
    await seedToolWithMethods('tool-t410-2');

    const { body } = await getJSON(ctx.port, '/tools/tool-t410-2');
    const b = body as { byMethod: Record<string, number> };
    for (const [key, val] of Object.entries(b.byMethod)) {
      expect(typeof key).toBe('string');
      expect(typeof val).toBe('number');
      expect(val).toBeGreaterThan(0);
    }
  });

  it('11. byMethod counts reflect total ops for each method across all agents for this tool', async () => {
    ctx = await setup();
    await seedToolWithMethods('tool-t410-3');

    const { body } = await getJSON(ctx.port, '/tools/tool-t410-3');
    const b = body as { byMethod: Record<string, number> };
    expect(b.byMethod['call']).toBe(4);
    expect(b.byMethod['read']).toBe(3);
    expect(b.byMethod['write']).toBe(2);
  });

  it('12. byMethod sum equals totalOps for this tool', async () => {
    ctx = await setup();
    await seedToolWithMethods('tool-t410-4');

    const { body } = await getJSON(ctx.port, '/tools/tool-t410-4');
    const b = body as { byMethod: Record<string, number>; totalOps: number };
    const methodSum = Object.values(b.byMethod).reduce((acc, v) => acc + v, 0);
    expect(methodSum).toBe(b.totalOps);
  });

  it('13. single-method tool — byMethod has exactly one key', async () => {
    ctx = await setup();
    const tool = 'tool-t410-5';
    await ctx.logger.log(makeOp('agent-a', tool, { method: 'read', sessionId: 's1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', tool, { method: 'read', sessionId: 's2' }), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, `/tools/${tool}`);
    const b = body as { byMethod: Record<string, number> };
    const keys = Object.keys(b.byMethod);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe('read');
    expect(b.byMethod['read']).toBe(2);
  });

  it('14. byMethod does not include methods used with other tools', async () => {
    ctx = await setup();
    const tool = 'tool-t410-6';
    // Our tool uses only 'write'
    await ctx.logger.log(makeOp('agent-a', tool, { method: 'write', sessionId: 's1' }), dec('block', 0.9));
    // Another tool uses 'subscribe'
    await ctx.logger.log(makeOp('agent-a', 'other-tool', { method: 'subscribe', sessionId: 's2' }), dec('allow', 0.1));

    const { body } = await getJSON(ctx.port, `/tools/${tool}`);
    const b = body as { byMethod: Record<string, number> };
    expect(Object.keys(b.byMethod)).not.toContain('subscribe');
    expect(b.byMethod['write']).toBe(1);
  });

  it('15. byMethod key count matches number of distinct methods used with this tool', async () => {
    ctx = await setup();
    await seedToolWithMethods('tool-t410-7');

    const { body } = await getJSON(ctx.port, '/tools/tool-t410-7');
    const b = body as { byMethod: Record<string, number> };
    expect(Object.keys(b.byMethod)).toHaveLength(3);
    expect(Object.keys(b.byMethod)).toContain('call');
    expect(Object.keys(b.byMethod)).toContain('read');
    expect(Object.keys(b.byMethod)).toContain('write');
  });

  it('16. byMethod values are all positive integers (no zero or negative counts)', async () => {
    ctx = await setup();
    await seedToolWithMethods('tool-t410-8');

    const { body } = await getJSON(ctx.port, '/tools/tool-t410-8');
    const b = body as { byMethod: Record<string, number> };
    for (const [, count] of Object.entries(b.byMethod)) {
      expect(count).toBeGreaterThan(0);
      expect(Number.isInteger(count)).toBe(true);
    }
  });
});

// ── T411 — GET /sessions/:id includes byMethod ────────────────────────────────

describe('GET /sessions/:id — byMethod object (T411)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds a single session with:
   *   'call'  → 3 ops
   *   'read'  → 2 ops
   *   'write' → 1 op
   */
  async function seedSessionWithMethods(sessionId = 'sess-bm', agentId = 'agent-sess'): Promise<void> {
    await ctx.logger.log(makeOp(agentId, 'tool-a', { method: 'call', sessionId }), dec('allow', 0.1));
    await ctx.logger.log(makeOp(agentId, 'tool-b', { method: 'call', sessionId }), dec('allow', 0.2));
    await ctx.logger.log(makeOp(agentId, 'tool-c', { method: 'call', sessionId }), dec('allow', 0.3));
    await ctx.logger.log(makeOp(agentId, 'tool-a', { method: 'read', sessionId }), dec('allow', 0.1));
    await ctx.logger.log(makeOp(agentId, 'tool-b', { method: 'read', sessionId }), dec('allow', 0.2));
    await ctx.logger.log(makeOp(agentId, 'tool-c', { method: 'write', sessionId }), dec('block', 0.9));
  }

  it('17. GET /sessions/:id response includes byMethod field', async () => {
    ctx = await setup();
    await seedSessionWithMethods('sess-t411-1');

    const { status, body } = await getJSON(ctx.port, '/sessions/sess-t411-1');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['byMethod']).toBeDefined();
    expect(typeof b['byMethod']).toBe('object');
    expect(b['byMethod']).not.toBeNull();
  });

  it('18. byMethod is a Record<string, number> — all keys are strings, all values are positive numbers', async () => {
    ctx = await setup();
    await seedSessionWithMethods('sess-t411-2');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t411-2');
    const b = body as { byMethod: Record<string, number> };
    for (const [key, val] of Object.entries(b.byMethod)) {
      expect(typeof key).toBe('string');
      expect(typeof val).toBe('number');
      expect(val).toBeGreaterThan(0);
    }
  });

  it('19. byMethod counts match actual ops per method in the session', async () => {
    ctx = await setup();
    await seedSessionWithMethods('sess-t411-3');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t411-3');
    const b = body as { byMethod: Record<string, number> };
    expect(b.byMethod['call']).toBe(3);
    expect(b.byMethod['read']).toBe(2);
    expect(b.byMethod['write']).toBe(1);
  });

  it('20. byMethod sum equals totalOps for this session', async () => {
    ctx = await setup();
    await seedSessionWithMethods('sess-t411-4');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t411-4');
    const b = body as { byMethod: Record<string, number>; totalOps: number };
    const methodSum = Object.values(b.byMethod).reduce((acc, v) => acc + v, 0);
    expect(methodSum).toBe(b.totalOps);
  });

  it('21. single-method session — byMethod has exactly one key', async () => {
    ctx = await setup();
    const sessionId = 'sess-t411-5';
    await ctx.logger.log(makeOp('agent-a', 'tool-a', { method: 'read', sessionId }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'tool-b', { method: 'read', sessionId }), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-a', 'tool-c', { method: 'read', sessionId }), dec('allow', 0.4));

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as { byMethod: Record<string, number> };
    const keys = Object.keys(b.byMethod);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe('read');
    expect(b.byMethod['read']).toBe(3);
  });

  it('22. byMethod only reflects ops from this session, not other sessions', async () => {
    ctx = await setup();
    const sessionId = 'sess-t411-6';
    // Our session uses only 'call'
    await ctx.logger.log(makeOp('agent-a', 'tool-a', { method: 'call', sessionId }), dec('allow', 0.2));
    // Another session uses 'delete'
    await ctx.logger.log(makeOp('agent-a', 'tool-b', { method: 'delete', sessionId: 'sess-other' }), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as { byMethod: Record<string, number> };
    expect(Object.keys(b.byMethod)).not.toContain('delete');
    expect(b.byMethod['call']).toBe(1);
  });

  it('23. byMethod key count matches distinct methods used in the session', async () => {
    ctx = await setup();
    await seedSessionWithMethods('sess-t411-7');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t411-7');
    const b = body as { byMethod: Record<string, number> };
    // We seeded 3 distinct methods: call, read, write
    expect(Object.keys(b.byMethod)).toHaveLength(3);
  });

  it('24. byMethod is present alongside existing session fields (totalOps, allowed, blocked)', async () => {
    ctx = await setup();
    await seedSessionWithMethods('sess-t411-8');

    const { body } = await getJSON(ctx.port, '/sessions/sess-t411-8');
    const b = body as Record<string, unknown>;
    // Verify byMethod coexists with other standard session fields
    expect(b['byMethod']).toBeDefined();
    expect(b['totalOps']).toBeDefined();
    expect(b['allowed']).toBeDefined();
    expect(b['blocked']).toBeDefined();
  });
});

// ── T412 — GET /risk ?method= filter ─────────────────────────────────────────

describe('GET /risk — ?method= filter (T412)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds a mixed set of ops:
   *   3 ops with method: 'call'
   *   2 ops with method: 'read'
   *   1 op  with method: 'write'
   */
  async function seedMixedMethodRiskOps(): Promise<void> {
    // 3 call ops
    await ctx.logger.log(makeOp('agent-a', 'tool-x', { method: 'call', sessionId: 'sc1' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-b', 'tool-y', { method: 'call', sessionId: 'sc2' }), dec('allow', 0.4));
    await ctx.logger.log(makeOp('agent-a', 'tool-z', { method: 'call', sessionId: 'sc3' }), dec('block', 0.7));
    // 2 read ops
    await ctx.logger.log(makeOp('agent-b', 'tool-x', { method: 'read', sessionId: 'sr1' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-c', 'tool-z', { method: 'read', sessionId: 'sr2' }), dec('allow', 0.3));
    // 1 write op
    await ctx.logger.log(makeOp('agent-c', 'tool-w', { method: 'write', sessionId: 'sw1' }), dec('block', 0.9));
  }

  it('25. GET /risk?method=call returns only risk entries with method=call', async () => {
    ctx = await setup();
    await seedMixedMethodRiskOps();

    const { status, body } = await getJSON(ctx.port, '/risk?method=call');
    expect(status).toBe(200);
    const b = body as { data: Array<{ method: string }> };
    expect(b.data.length).toBeGreaterThan(0);
    for (const entry of b.data) {
      expect(entry.method).toBe('call');
    }
  });

  it('26. GET /risk?method=call returns exactly 3 entries (matching the 3 call ops seeded)', async () => {
    ctx = await setup();
    await seedMixedMethodRiskOps();

    const { body } = await getJSON(ctx.port, '/risk?method=call');
    const b = body as { data: Array<unknown>; count: number };
    expect(b.data).toHaveLength(3);
    expect(b.count).toBe(3);
  });

  it('27. GET /risk?method=read returns only risk entries with method=read', async () => {
    ctx = await setup();
    await seedMixedMethodRiskOps();

    const { body } = await getJSON(ctx.port, '/risk?method=read');
    const b = body as { data: Array<{ method: string }> };
    for (const entry of b.data) {
      expect(entry.method).toBe('read');
    }
    expect(b.data).toHaveLength(2);
  });

  it('28. GET /risk?method=write returns only the single write risk entry', async () => {
    ctx = await setup();
    await seedMixedMethodRiskOps();

    const { body } = await getJSON(ctx.port, '/risk?method=write');
    const b = body as { data: Array<{ method: string }> };
    expect(b.data).toHaveLength(1);
    expect(b.data[0]!.method).toBe('write');
  });

  it('29. GET /risk?method=nonexistent returns empty data array with count 0', async () => {
    ctx = await setup();
    await seedMixedMethodRiskOps();

    const { status, body } = await getJSON(ctx.port, '/risk?method=nonexistent');
    expect(status).toBe(200);
    const b = body as { data: Array<unknown>; count: number };
    expect(b.data).toHaveLength(0);
    expect(b.count).toBe(0);
  });

  it('30. GET /risk without method filter returns all 6 entries', async () => {
    ctx = await setup();
    await seedMixedMethodRiskOps();

    const { body } = await getJSON(ctx.port, '/risk');
    const b = body as { data: Array<unknown>; count: number };
    expect(b.count).toBe(6);
    expect(b.data).toHaveLength(6);
  });

  it('31. risk entries returned by ?method= filter include expected fields (operationId, agentId, tool, method, riskScore, action)', async () => {
    ctx = await setup();
    await seedMixedMethodRiskOps();

    const { body } = await getJSON(ctx.port, '/risk?method=call');
    const b = body as { data: Array<Record<string, unknown>> };
    for (const entry of b.data) {
      expect(entry).toHaveProperty('operationId');
      expect(entry).toHaveProperty('agentId');
      expect(entry).toHaveProperty('tool');
      expect(entry).toHaveProperty('method');
      expect(entry).toHaveProperty('riskScore');
      expect(entry).toHaveProperty('action');
    }
  });

  it('32. GET /risk?method=call data count equals count field (pagination integrity)', async () => {
    ctx = await setup();
    await seedMixedMethodRiskOps();

    const { body } = await getJSON(ctx.port, '/risk?method=call');
    const b = body as { data: Array<unknown>; count: number };
    // count field should match the total number of matching entries
    expect(b.count).toBe(3);
    expect(b.data.length).toBeLessThanOrEqual(b.count);
  });

  it('33. call + read + write counts via ?method= filter sum to total count (all methods present)', async () => {
    ctx = await setup();
    await seedMixedMethodRiskOps();

    const { body: allBody } = await getJSON(ctx.port, '/risk');
    const { body: callBody } = await getJSON(ctx.port, '/risk?method=call');
    const { body: readBody } = await getJSON(ctx.port, '/risk?method=read');
    const { body: writeBody } = await getJSON(ctx.port, '/risk?method=write');

    const total = (allBody as { count: number }).count;
    const callCount = (callBody as { count: number }).count;
    const readCount = (readBody as { count: number }).count;
    const writeCount = (writeBody as { count: number }).count;
    expect(callCount + readCount + writeCount).toBe(total);
  });

  it('34. GET /risk?method=call only returns entries for ops where method=call (excludes read/write)', async () => {
    ctx = await setup();
    await seedMixedMethodRiskOps();

    const { body } = await getJSON(ctx.port, '/risk?method=call');
    const b = body as { data: Array<{ method: string }> };
    const methodsInResponse = new Set(b.data.map(e => e.method));
    expect(methodsInResponse.has('read')).toBe(false);
    expect(methodsInResponse.has('write')).toBe(false);
    expect(methodsInResponse.has('call')).toBe(true);
  });

  it('35. GET /risk?method=write blocked entry has correct riskScore', async () => {
    ctx = await setup();
    await seedMixedMethodRiskOps();

    const { body } = await getJSON(ctx.port, '/risk?method=write');
    const b = body as { data: Array<{ method: string; riskScore: number; action: string }> };
    expect(b.data).toHaveLength(1);
    const entry = b.data[0]!;
    expect(entry.method).toBe('write');
    expect(entry.riskScore).toBeCloseTo(0.9, 5);
    expect(entry.action).toBe('block');
  });

  it('36. GET /risk?method=read entries all have numeric riskScore and valid action', async () => {
    ctx = await setup();
    await seedMixedMethodRiskOps();

    const { body } = await getJSON(ctx.port, '/risk?method=read');
    const b = body as { data: Array<{ riskScore: number; action: string }> };
    for (const entry of b.data) {
      expect(typeof entry.riskScore).toBe('number');
      expect(entry.riskScore).toBeGreaterThanOrEqual(0);
      expect(entry.riskScore).toBeLessThanOrEqual(1);
      expect(['allow', 'block', 'require_approval']).toContain(entry.action);
    }
  });
});

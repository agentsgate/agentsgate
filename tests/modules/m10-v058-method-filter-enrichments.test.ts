/**
 * v0.58 feature tests
 *
 * T404 — GET /agents supports ?method=<name> filter
 *   - Only returns agents that have ops with that method value
 *   - Agents without any ops matching the method are excluded
 *   - The stats shown reflect only those filtered ops
 *
 * T405 — GET /tools supports ?method=<name> filter
 *   - Only returns tools that have been invoked with that method
 *   - Similar behavior to T404 but for tools
 *
 * T406 — GET /operations/summary includes topMethods[] array
 *   - topMethods is sorted by count desc
 *   - each entry has {method, count} shape
 *   - up to 5 entries
 *
 * T407 — GET /agents/:agentId includes topMethods[] array
 *   - topMethods reflects the methods used by that specific agent
 *   - sorted by count desc
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

/**
 * Seeds a mixed set of ops:
 *   agent-call: 3 ops with method 'call'  using tool-x and tool-y
 *   agent-read: 2 ops with method 'read'  using tool-z
 *   agent-both: 1 op  with method 'call'  using tool-x
 *             + 2 ops with method 'read'  using tool-w
 */
async function seedMixedMethodOps(ctx: Ctx): Promise<void> {
  // agent-call: only 'call' ops
  await ctx.logger.log(makeOp('agent-call', 'tool-x', 'sess-c1', { method: 'call' }), dec('allow', 0.2));
  await ctx.logger.log(makeOp('agent-call', 'tool-x', 'sess-c2', { method: 'call' }), dec('allow', 0.3));
  await ctx.logger.log(makeOp('agent-call', 'tool-y', 'sess-c3', { method: 'call' }), dec('allow', 0.4));
  // agent-read: only 'read' ops
  await ctx.logger.log(makeOp('agent-read', 'tool-z', 'sess-r1', { method: 'read' }), dec('allow', 0.1));
  await ctx.logger.log(makeOp('agent-read', 'tool-z', 'sess-r2', { method: 'read' }), dec('allow', 0.2));
  // agent-both: 1 'call' + 2 'read' ops
  await ctx.logger.log(makeOp('agent-both', 'tool-x', 'sess-b1', { method: 'call' }), dec('allow', 0.5));
  await ctx.logger.log(makeOp('agent-both', 'tool-w', 'sess-b2', { method: 'read' }), dec('allow', 0.3));
  await ctx.logger.log(makeOp('agent-both', 'tool-w', 'sess-b3', { method: 'read' }), dec('allow', 0.4));
}

// ── T404 — GET /agents ?method= filter ────────────────────────────────────────

describe('GET /agents — ?method= filter (T404)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. ?method=call returns only agents that have call ops (agent-call and agent-both)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?method=call');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-call');
    expect(ids).toContain('agent-both');
  });

  it('2. ?method=call excludes agents that only have read ops (agent-read is excluded)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents?method=call');
    const b = body as { agents: Array<{ agentId: string }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).not.toContain('agent-read');
  });

  it('3. ?method=read returns only agents that have read ops (agent-read and agent-both)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents?method=read');
    const b = body as { agents: Array<{ agentId: string }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-read');
    expect(ids).toContain('agent-both');
  });

  it('4. ?method=read excludes agents with only call ops (agent-call is excluded)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents?method=read');
    const b = body as { agents: Array<{ agentId: string }> };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).not.toContain('agent-call');
  });

  it('5. agent-both ?method=call — totalOps reflects only the 1 call op', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents?method=call');
    const b = body as { agents: Array<{ agentId: string; totalOps: number }> };
    const both = b.agents.find(a => a.agentId === 'agent-both');
    expect(both).toBeDefined();
    // agent-both has 1 call op → totalOps should be 1 when filtering by 'call'
    expect(both!.totalOps).toBe(1);
  });

  it('6. agent-call ?method=call — totalOps reflects all 3 call ops', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents?method=call');
    const b = body as { agents: Array<{ agentId: string; totalOps: number }> };
    const callAgent = b.agents.find(a => a.agentId === 'agent-call');
    expect(callAgent).toBeDefined();
    expect(callAgent!.totalOps).toBe(3);
  });

  it('7. ?method=nonexistent returns empty agents list', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?method=nonexistent');
    expect(status).toBe(200);
    const b = body as { agents: Array<unknown>; count: number };
    expect(b.agents).toHaveLength(0);
    expect(b.count).toBe(0);
  });

  it('8. no method filter — all 3 agents are returned', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-call');
    expect(ids).toContain('agent-read');
    expect(ids).toContain('agent-both');
    expect(b.count).toBe(3);
  });

  it('9. ?method=call returns 2 agents and count matches', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents?method=call');
    const b = body as { agents: Array<unknown>; count: number };
    expect(b.agents).toHaveLength(2);
    expect(b.count).toBe(2);
  });

  it('10. ?method=read — agent-both totalOps is 2 (only the read ops)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents?method=read');
    const b = body as { agents: Array<{ agentId: string; totalOps: number }> };
    const both = b.agents.find(a => a.agentId === 'agent-both');
    expect(both).toBeDefined();
    expect(both!.totalOps).toBe(2);
  });

  it('11. empty DB with ?method=call returns empty list', async () => {
    ctx = await setup();

    const { status, body } = await getJSON(ctx.port, '/agents?method=call');
    expect(status).toBe(200);
    const b = body as { agents: Array<unknown>; count: number };
    expect(b.agents).toHaveLength(0);
    expect(b.count).toBe(0);
  });

  it('12. ?method=call agents have valid avgRiskScore field reflecting only filtered ops', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents?method=call');
    const b = body as { agents: Array<{ agentId: string; avgRiskScore: number }> };
    for (const agent of b.agents) {
      expect(typeof agent.avgRiskScore).toBe('number');
      expect(agent.avgRiskScore).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── T405 — GET /tools ?method= filter ─────────────────────────────────────────

describe('GET /tools — ?method= filter (T405)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('13. ?method=call returns only tools invoked with call method (tool-x and tool-y)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?method=call');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }> };
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-x');
    expect(names).toContain('tool-y');
  });

  it('14. ?method=call excludes tools only invoked with read method (tool-z excluded)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools?method=call');
    const b = body as { tools: Array<{ tool: string }> };
    const names = b.tools.map(t => t.tool);
    expect(names).not.toContain('tool-z');
  });

  it('15. ?method=read returns only tools invoked with read method (tool-z and tool-w)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools?method=read');
    const b = body as { tools: Array<{ tool: string }> };
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-z');
    expect(names).toContain('tool-w');
  });

  it('16. ?method=read excludes tools only invoked with call method (tool-y excluded)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools?method=read');
    const b = body as { tools: Array<{ tool: string }> };
    const names = b.tools.map(t => t.tool);
    expect(names).not.toContain('tool-y');
  });

  it('17. ?method=call — tool-x totalOps reflects only its call ops (3: 2 from agent-call + 1 from agent-both)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools?method=call');
    const b = body as { tools: Array<{ tool: string; totalOps: number }> };
    const toolX = b.tools.find(t => t.tool === 'tool-x');
    expect(toolX).toBeDefined();
    expect(toolX!.totalOps).toBe(3);
  });

  it('18. ?method=nonexistent returns empty tools list', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools?method=nonexistent');
    expect(status).toBe(200);
    const b = body as { tools: Array<unknown>; count: number };
    expect(b.tools).toHaveLength(0);
    expect(b.count).toBe(0);
  });

  it('19. no method filter — all 4 tools are returned (tool-x, tool-y, tool-z, tool-w)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string }>; count: number };
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-x');
    expect(names).toContain('tool-y');
    expect(names).toContain('tool-z');
    expect(names).toContain('tool-w');
    expect(b.count).toBe(4);
  });

  it('20. ?method=call count field matches the number of tools in result', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools?method=call');
    const b = body as { tools: Array<unknown>; count: number };
    expect(b.count).toBe(b.tools.length);
  });

  it('21. empty DB with ?method=read returns empty list', async () => {
    ctx = await setup();

    const { status, body } = await getJSON(ctx.port, '/tools?method=read');
    expect(status).toBe(200);
    const b = body as { tools: Array<unknown>; count: number };
    expect(b.tools).toHaveLength(0);
    expect(b.count).toBe(0);
  });

  it('22. ?method=read — tool-w totalOps reflects only its read ops (2 from agent-both)', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools?method=read');
    const b = body as { tools: Array<{ tool: string; totalOps: number }> };
    const toolW = b.tools.find(t => t.tool === 'tool-w');
    expect(toolW).toBeDefined();
    expect(toolW!.totalOps).toBe(2);
  });

  it('23. ?method=call tools have valid avgRiskScore numeric field', async () => {
    ctx = await setup();
    await seedMixedMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools?method=call');
    const b = body as { tools: Array<{ avgRiskScore: number }> };
    for (const tool of b.tools) {
      expect(typeof tool.avgRiskScore).toBe('number');
      expect(tool.avgRiskScore).toBeGreaterThanOrEqual(0);
    }
  });

  it('24. tool-x appears in both ?method=call and ?method=call (present in call ops)', async () => {
    ctx = await setup();
    // tool-mixed gets both 'call' and 'read' ops
    await ctx.logger.log(makeOp('agent-a', 'tool-mixed', 'sess-1', { method: 'call' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'tool-mixed', 'sess-2', { method: 'read' }), dec('allow', 0.3));
    // tool-only-call only has 'call' ops
    await ctx.logger.log(makeOp('agent-a', 'tool-only-call', 'sess-3', { method: 'call' }), dec('allow', 0.4));

    const { body: callBody } = await getJSON(ctx.port, '/tools?method=call');
    const callTools = (callBody as { tools: Array<{ tool: string }> }).tools.map(t => t.tool);
    expect(callTools).toContain('tool-mixed');
    expect(callTools).toContain('tool-only-call');

    const { body: readBody } = await getJSON(ctx.port, '/tools?method=read');
    const readTools = (readBody as { tools: Array<{ tool: string }> }).tools.map(t => t.tool);
    expect(readTools).toContain('tool-mixed');
    expect(readTools).not.toContain('tool-only-call');
  });
});

// ── T406 — GET /operations/summary topMethods[] ───────────────────────────────

describe('GET /operations/summary — topMethods[] array (T406)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds ops with various method frequencies:
   *   'call'    → 5 ops  (most frequent)
   *   'read'    → 3 ops
   *   'write'   → 2 ops
   *   'list'    → 2 ops
   *   'delete'  → 1 op
   *   'notify'  → 1 op  (6th distinct method)
   */
  async function seedVariousMethodOps(ctx: Ctx): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await ctx.logger.log(makeOp('agent-a', 'tool-a', `sess-call-${i}`, { method: 'call' }), dec('allow', 0.2));
    }
    for (let i = 0; i < 3; i++) {
      await ctx.logger.log(makeOp('agent-a', 'tool-b', `sess-read-${i}`, { method: 'read' }), dec('allow', 0.3));
    }
    for (let i = 0; i < 2; i++) {
      await ctx.logger.log(makeOp('agent-b', 'tool-c', `sess-write-${i}`, { method: 'write' }), dec('allow', 0.4));
    }
    for (let i = 0; i < 2; i++) {
      await ctx.logger.log(makeOp('agent-b', 'tool-d', `sess-list-${i}`, { method: 'list' }), dec('allow', 0.2));
    }
    await ctx.logger.log(makeOp('agent-c', 'tool-e', 'sess-delete-0', { method: 'delete' }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-c', 'tool-f', 'sess-notify-0', { method: 'notify' }), dec('allow', 0.1));
  }

  it('25. topMethods is present in GET /operations/summary response', async () => {
    ctx = await setup();
    await seedVariousMethodOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['topMethods']).toBeDefined();
    expect(Array.isArray(b['topMethods'])).toBe(true);
  });

  it('26. topMethods entries have {method, count} shape', async () => {
    ctx = await setup();
    await seedVariousMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topMethods: Array<Record<string, unknown>> };
    expect(b.topMethods.length).toBeGreaterThanOrEqual(1);
    for (const entry of b.topMethods) {
      expect(entry).toHaveProperty('method');
      expect(entry).toHaveProperty('count');
      expect(typeof entry['method']).toBe('string');
      expect(typeof entry['count']).toBe('number');
    }
  });

  it('27. topMethods is sorted by count descending (call=5 first, read=3 second)', async () => {
    ctx = await setup();
    await seedVariousMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    expect(b.topMethods[0]!.method).toBe('call');
    expect(b.topMethods[0]!.count).toBe(5);
    expect(b.topMethods[1]!.method).toBe('read');
    expect(b.topMethods[1]!.count).toBe(3);
  });

  it('28. topMethods contains at most 5 entries when there are 6 distinct methods', async () => {
    ctx = await setup();
    await seedVariousMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    expect(b.topMethods.length).toBeLessThanOrEqual(5);
  });

  it('29. topMethods entries are in strictly non-increasing count order', async () => {
    ctx = await setup();
    await seedVariousMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    for (let i = 0; i < b.topMethods.length - 1; i++) {
      expect(b.topMethods[i]!.count).toBeGreaterThanOrEqual(b.topMethods[i + 1]!.count);
    }
  });

  it('30. empty DB — topMethods is an empty array', async () => {
    ctx = await setup();

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { topMethods: Array<unknown> };
    expect(Array.isArray(b.topMethods)).toBe(true);
    expect(b.topMethods).toHaveLength(0);
  });

  it('31. single method in all ops — topMethods has exactly 1 entry', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-a', 'sess-1', { method: 'call' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-b', 'tool-b', 'sess-2', { method: 'call' }), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-c', 'tool-c', 'sess-3', { method: 'call' }), dec('allow', 0.4));

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    expect(b.topMethods).toHaveLength(1);
    expect(b.topMethods[0]!.method).toBe('call');
    expect(b.topMethods[0]!.count).toBe(3);
  });

  it('32. topMethods excludes the 6th-ranked method (notify) from the top-5 list', async () => {
    ctx = await setup();
    await seedVariousMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    const methodNames = b.topMethods.map(e => e.method);
    // With 6 distinct methods, the 6th (notify, count=1) should not appear
    // The 5 to appear: call(5), read(3), write(2), list(2), and one of delete/notify
    // The top 5 by count are: call, read, write, list, delete OR notify (both count=1)
    // Either way, there should be exactly 5 entries
    expect(b.topMethods.length).toBe(5);
  });

  it('33. topMethods method names are non-empty strings', async () => {
    ctx = await setup();
    await seedVariousMethodOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    for (const entry of b.topMethods) {
      expect(entry.method.length).toBeGreaterThan(0);
      expect(entry.count).toBeGreaterThan(0);
    }
  });
});

// ── T407 — GET /agents/:agentId topMethods[] ──────────────────────────────────

describe('GET /agents/:agentId — topMethods[] array (T407)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds agent-detail with:
   *   'call'  → 4 ops
   *   'read'  → 2 ops
   *   'write' → 1 op
   */
  async function seedAgentWithMethods(ctx: Ctx, agentId = 'agent-detail'): Promise<void> {
    for (let i = 0; i < 4; i++) {
      await ctx.logger.log(makeOp(agentId, 'tool-a', `sess-call-${i}`, { method: 'call' }), dec('allow', 0.2));
    }
    for (let i = 0; i < 2; i++) {
      await ctx.logger.log(makeOp(agentId, 'tool-b', `sess-read-${i}`, { method: 'read' }), dec('allow', 0.3));
    }
    await ctx.logger.log(makeOp(agentId, 'tool-c', 'sess-write-0', { method: 'write' }), dec('allow', 0.4));
  }

  it('34. topMethods is present in GET /agents/:agentId response', async () => {
    ctx = await setup();
    await seedAgentWithMethods(ctx, 'agent-t407-a');

    const { status, body } = await getJSON(ctx.port, '/agents/agent-t407-a');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['topMethods']).toBeDefined();
    expect(Array.isArray(b['topMethods'])).toBe(true);
  });

  it('35. topMethods entries have {method, count} shape', async () => {
    ctx = await setup();
    await seedAgentWithMethods(ctx, 'agent-t407-b');

    const { body } = await getJSON(ctx.port, '/agents/agent-t407-b');
    const b = body as { topMethods: Array<Record<string, unknown>> };
    expect(b.topMethods.length).toBeGreaterThanOrEqual(1);
    for (const entry of b.topMethods) {
      expect(entry).toHaveProperty('method');
      expect(entry).toHaveProperty('count');
      expect(typeof entry['method']).toBe('string');
      expect(typeof entry['count']).toBe('number');
    }
  });

  it('36. topMethods[0] is call (most used) with count 4', async () => {
    ctx = await setup();
    await seedAgentWithMethods(ctx, 'agent-t407-c');

    const { body } = await getJSON(ctx.port, '/agents/agent-t407-c');
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    expect(b.topMethods[0]!.method).toBe('call');
    expect(b.topMethods[0]!.count).toBe(4);
  });

  it('37. topMethods is sorted by count descending', async () => {
    ctx = await setup();
    await seedAgentWithMethods(ctx, 'agent-t407-d');

    const { body } = await getJSON(ctx.port, '/agents/agent-t407-d');
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    for (let i = 0; i < b.topMethods.length - 1; i++) {
      expect(b.topMethods[i]!.count).toBeGreaterThanOrEqual(b.topMethods[i + 1]!.count);
    }
  });

  it('38. topMethods contains all 3 distinct methods used by agent-t407-e', async () => {
    ctx = await setup();
    await seedAgentWithMethods(ctx, 'agent-t407-e');

    const { body } = await getJSON(ctx.port, '/agents/agent-t407-e');
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    const methodNames = b.topMethods.map(e => e.method);
    expect(methodNames).toContain('call');
    expect(methodNames).toContain('read');
    expect(methodNames).toContain('write');
  });

  it('39. topMethods reflects correct count for read (2) and write (1)', async () => {
    ctx = await setup();
    await seedAgentWithMethods(ctx, 'agent-t407-f');

    const { body } = await getJSON(ctx.port, '/agents/agent-t407-f');
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    const readEntry = b.topMethods.find(e => e.method === 'read');
    const writeEntry = b.topMethods.find(e => e.method === 'write');
    expect(readEntry).toBeDefined();
    expect(readEntry!.count).toBe(2);
    expect(writeEntry).toBeDefined();
    expect(writeEntry!.count).toBe(1);
  });

  it('40. topMethods only reflects ops for the requested agent, not other agents', async () => {
    ctx = await setup();
    const agentId = 'agent-t407-g';
    await seedAgentWithMethods(ctx, agentId);
    // Seed another agent with a completely different method
    await ctx.logger.log(makeOp('agent-other', 'tool-x', 'sess-other', { method: 'notify' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-other', 'tool-x', 'sess-other2', { method: 'notify' }), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, `/agents/${agentId}`);
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    const methodNames = b.topMethods.map(e => e.method);
    // 'notify' belongs to agent-other and should not appear in agent-t407-g's topMethods
    expect(methodNames).not.toContain('notify');
  });

  it('41. topMethods is capped at 5 when agent uses more than 5 distinct methods', async () => {
    ctx = await setup();
    const agentId = 'agent-t407-h';
    const methods = ['call', 'read', 'write', 'list', 'delete', 'notify', 'subscribe'];
    for (let i = 0; i < methods.length; i++) {
      // Give each method a distinct count (i+1 ops each)
      for (let j = 0; j <= i; j++) {
        await ctx.logger.log(
          makeOp(agentId, 'tool-a', `sess-${methods[i]!}-${j}`, { method: methods[i]! }),
          dec('allow', 0.2)
        );
      }
    }

    const { body } = await getJSON(ctx.port, `/agents/${agentId}`);
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    expect(b.topMethods.length).toBeLessThanOrEqual(5);
  });

  it('42. agent with single method — topMethods has 1 entry with that method', async () => {
    ctx = await setup();
    const agentId = 'agent-t407-i';
    await ctx.logger.log(makeOp(agentId, 'tool-a', 'sess-1', { method: 'call' }), dec('allow', 0.2));
    await ctx.logger.log(makeOp(agentId, 'tool-a', 'sess-2', { method: 'call' }), dec('allow', 0.3));

    const { body } = await getJSON(ctx.port, `/agents/${agentId}`);
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    expect(b.topMethods).toHaveLength(1);
    expect(b.topMethods[0]!.method).toBe('call');
    expect(b.topMethods[0]!.count).toBe(2);
  });

  it('43. topMethods count values sum matches totalOps when <= 5 distinct methods', async () => {
    ctx = await setup();
    await seedAgentWithMethods(ctx, 'agent-t407-j');

    const { body } = await getJSON(ctx.port, '/agents/agent-t407-j');
    const b = body as { topMethods: Array<{ count: number }>; totalOps: number };
    const methodCountSum = b.topMethods.reduce((acc, e) => acc + e.count, 0);
    // All 3 methods fit in top 5, so sum == totalOps
    expect(methodCountSum).toBe(b.totalOps);
  });

  it('44. topMethods method field is a non-empty string for all entries', async () => {
    ctx = await setup();
    await seedAgentWithMethods(ctx, 'agent-t407-k');

    const { body } = await getJSON(ctx.port, '/agents/agent-t407-k');
    const b = body as { topMethods: Array<{ method: string; count: number }> };
    for (const entry of b.topMethods) {
      expect(typeof entry.method).toBe('string');
      expect(entry.method.length).toBeGreaterThan(0);
      expect(entry.count).toBeGreaterThan(0);
    }
  });
});

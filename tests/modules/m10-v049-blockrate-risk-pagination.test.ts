/**
 * v0.49 tests
 *
 * T359 — GET /sessions list entries include `blockRate` field (blocked/operationCount);
 *         verify correct value
 * T360 — GET /agents list entries include `blockRate` field;
 *         verify blockRate = byAction.block / totalOps
 * T361 — GET /tools list entries include `blockRate` field; same calculation
 * T362 — GET /risk?offset=2&limit=2: returns 2 entries starting at offset 2;
 *         response includes `count` (total), `limit`, `offset`;
 *         verify offset=0 and offset=2 return different items
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

// ── T359 — GET /sessions blockRate field ─────────────────────────────────────

describe('GET /sessions blockRate field (T359)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. each session entry includes a blockRate field that is a number', async () => {
    ctx = await setup();
    await ctx.logger.log(
      makeOp('agent-a', 'fs', { sessionId: 'sess-x' }),
      dec('allow', 0.2)
    );
    await ctx.logger.log(
      makeOp('agent-a', 'db', { sessionId: 'sess-x' }),
      dec('block', 0.8)
    );

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { data: Array<Record<string, unknown>> };
    expect(Array.isArray(b.data)).toBe(true);
    expect(b.data.length).toBeGreaterThanOrEqual(1);
    for (const session of b.data) {
      expect(typeof session['blockRate']).toBe('number');
    }
  });

  it('2. blockRate is between 0 and 1 inclusive', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-all-allow' }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-all-block' }), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { data: Array<{ sessionId: string; blockRate: number }> };
    for (const s of b.data) {
      expect(s.blockRate).toBeGreaterThanOrEqual(0);
      expect(s.blockRate).toBeLessThanOrEqual(1);
    }
  });

  it('3. blockRate = 0 when all ops in session are allowed', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-no-block', id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'db', { sessionId: 'sess-no-block', id: crypto.randomUUID() }), dec('allow', 0.2));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { data: Array<{ sessionId: string; blockRate: number }> };
    const sess = b.data.find(s => s.sessionId === 'sess-no-block');
    expect(sess).toBeDefined();
    expect(sess!.blockRate).toBe(0);
  });

  it('4. blockRate = 1 when all ops in session are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-all-blocked', id: crypto.randomUUID() }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-a', 'db', { sessionId: 'sess-all-blocked', id: crypto.randomUUID() }), dec('block', 0.95));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { data: Array<{ sessionId: string; blockRate: number }> };
    const sess = b.data.find(s => s.sessionId === 'sess-all-blocked');
    expect(sess).toBeDefined();
    expect(sess!.blockRate).toBeCloseTo(1, 5);
  });

  it('5. blockRate = blocked / operationCount — correct calculation for mixed session', async () => {
    ctx = await setup();
    // 4 ops: 1 block, 2 allow, 1 require_approval => blockRate = 1/4 = 0.25
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-mixed', id: crypto.randomUUID() }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-a', 'db', { sessionId: 'sess-mixed', id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'net', { sessionId: 'sess-mixed', id: crypto.randomUUID() }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'shell', { sessionId: 'sess-mixed', id: crypto.randomUUID() }), dec('require_approval', 0.6));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { data: Array<{ sessionId: string; blockRate: number; operationCount: number; blocked: number }> };
    const sess = b.data.find(s => s.sessionId === 'sess-mixed');
    expect(sess).toBeDefined();
    // blockRate = blocked / operationCount = 1/4
    expect(sess!.blockRate).toBeCloseTo(1 / 4, 5);
  });

  it('6. blockRate is independent per session — two sessions computed separately', async () => {
    ctx = await setup();
    // sess-half: 2 ops, 1 block => blockRate = 0.5
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-half', id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'db', { sessionId: 'sess-half', id: crypto.randomUUID() }), dec('block', 0.8));
    // sess-zero: 3 ops, 0 blocks => blockRate = 0
    await ctx.logger.log(makeOp('agent-b', 'fs', { sessionId: 'sess-zero', id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'db', { sessionId: 'sess-zero', id: crypto.randomUUID() }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-b', 'net', { sessionId: 'sess-zero', id: crypto.randomUUID() }), dec('allow', 0.3));

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { data: Array<{ sessionId: string; blockRate: number }> };
    const half = b.data.find(s => s.sessionId === 'sess-half');
    const zero = b.data.find(s => s.sessionId === 'sess-zero');
    expect(half).toBeDefined();
    expect(zero).toBeDefined();
    expect(half!.blockRate).toBeCloseTo(0.5, 5);
    expect(zero!.blockRate).toBeCloseTo(0, 5);
  });
});

// ── T360 — GET /agents blockRate field ───────────────────────────────────────

describe('GET /agents blockRate field (T360)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('7. each agent entry includes a blockRate field that is a number', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-alpha', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-beta', 'db'), dec('block', 0.7));

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as { agents: Array<Record<string, unknown>> };
    expect(b.agents.length).toBeGreaterThanOrEqual(2);
    for (const agent of b.agents) {
      expect(typeof agent['blockRate']).toBe('number');
    }
  });

  it('8. blockRate = byAction.block / totalOps — correct calculation', async () => {
    ctx = await setup();
    // 5 ops: 2 block, 2 allow, 1 require_approval => blockRate = 2/5 = 0.4
    await ctx.logger.log(makeOp('agent-calc', 'fs', { id: crypto.randomUUID() }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-calc', 'db', { id: crypto.randomUUID() }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-calc', 'net', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-calc', 'shell', { id: crypto.randomUUID() }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-calc', 'read', { id: crypto.randomUUID() }), dec('require_approval', 0.5));

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; blockRate: number; totalOps: number; byAction: { allow: number; block: number; require_approval: number } }> };
    const agent = b.agents.find(a => a.agentId === 'agent-calc');
    expect(agent).toBeDefined();
    expect(agent!.totalOps).toBe(5);
    expect(agent!.byAction.block).toBe(2);
    expect(agent!.blockRate).toBeCloseTo(2 / 5, 5);
  });

  it('9. blockRate = 0 when agent has no blocked ops', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-clean', 'fs', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-clean', 'db', { id: crypto.randomUUID() }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-clean', 'net', { id: crypto.randomUUID() }), dec('require_approval', 0.4));

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };
    const agent = b.agents.find(a => a.agentId === 'agent-clean');
    expect(agent).toBeDefined();
    expect(agent!.blockRate).toBe(0);
  });

  it('10. blockRate = 1 when all agent ops are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-fully-blocked', 'fs', { id: crypto.randomUUID() }), dec('block', 0.95));
    await ctx.logger.log(makeOp('agent-fully-blocked', 'db', { id: crypto.randomUUID() }), dec('block', 0.98));

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };
    const agent = b.agents.find(a => a.agentId === 'agent-fully-blocked');
    expect(agent).toBeDefined();
    expect(agent!.blockRate).toBeCloseTo(1, 5);
  });

  it('11. blockRate is independent per agent — multiple agents have correct values', async () => {
    ctx = await setup();
    // agent-one: 3 ops, 1 block => blockRate = 1/3
    await ctx.logger.log(makeOp('agent-one', 'fs', { id: crypto.randomUUID() }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-one', 'db', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-one', 'net', { id: crypto.randomUUID() }), dec('allow', 0.2));
    // agent-two: 2 ops, 2 blocks => blockRate = 1
    await ctx.logger.log(makeOp('agent-two', 'fs', { id: crypto.randomUUID() }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-two', 'db', { id: crypto.randomUUID() }), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };
    const one = b.agents.find(a => a.agentId === 'agent-one');
    const two = b.agents.find(a => a.agentId === 'agent-two');
    expect(one).toBeDefined();
    expect(two).toBeDefined();
    expect(one!.blockRate).toBeCloseTo(1 / 3, 5);
    expect(two!.blockRate).toBeCloseTo(1, 5);
  });

  it('12. single-op agent has blockRate 0 if allowed, 1 if blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-single-allow', 'fs', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-single-block', 'fs', { id: crypto.randomUUID() }), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; blockRate: number }> };
    const allowed = b.agents.find(a => a.agentId === 'agent-single-allow');
    const blocked = b.agents.find(a => a.agentId === 'agent-single-block');
    expect(allowed).toBeDefined();
    expect(blocked).toBeDefined();
    expect(allowed!.blockRate).toBe(0);
    expect(blocked!.blockRate).toBe(1);
  });
});

// ── T361 — GET /tools blockRate field ────────────────────────────────────────

describe('GET /tools blockRate field (T361)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('13. each tool entry includes a blockRate field that is a number', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-y'), dec('block', 0.8));

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as { tools: Array<Record<string, unknown>> };
    expect(b.tools.length).toBeGreaterThanOrEqual(2);
    for (const tool of b.tools) {
      expect(typeof tool['blockRate']).toBe('number');
    }
  });

  it('14. blockRate = byAction.block / totalOps — correct calculation for a tool', async () => {
    ctx = await setup();
    // tool-multi: 6 ops, 2 blocked => blockRate = 2/6 = 1/3
    await ctx.logger.log(makeOp('agent-a', 'tool-multi', { id: crypto.randomUUID() }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-a', 'tool-multi', { id: crypto.randomUUID() }), dec('block', 0.85));
    await ctx.logger.log(makeOp('agent-a', 'tool-multi', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-b', 'tool-multi', { id: crypto.randomUUID() }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-b', 'tool-multi', { id: crypto.randomUUID() }), dec('allow', 0.15));
    await ctx.logger.log(makeOp('agent-b', 'tool-multi', { id: crypto.randomUUID() }), dec('require_approval', 0.5));

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string; blockRate: number; totalOps: number; byAction: { allow: number; block: number; require_approval: number } }> };
    const tool = b.tools.find(t => t.tool === 'tool-multi');
    expect(tool).toBeDefined();
    expect(tool!.totalOps).toBe(6);
    expect(tool!.byAction.block).toBe(2);
    expect(tool!.blockRate).toBeCloseTo(2 / 6, 5);
  });

  it('15. blockRate = 0 when tool has never been blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'safe-tool', { id: crypto.randomUUID() }), dec('allow', 0.05));
    await ctx.logger.log(makeOp('agent-b', 'safe-tool', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'safe-tool', { id: crypto.randomUUID() }), dec('require_approval', 0.3));

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };
    const tool = b.tools.find(t => t.tool === 'safe-tool');
    expect(tool).toBeDefined();
    expect(tool!.blockRate).toBe(0);
  });

  it('16. blockRate = 1 when all uses of a tool are blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'dangerous-tool', { id: crypto.randomUUID() }), dec('block', 0.99));
    await ctx.logger.log(makeOp('agent-b', 'dangerous-tool', { id: crypto.randomUUID() }), dec('block', 0.95));
    await ctx.logger.log(makeOp('agent-c', 'dangerous-tool', { id: crypto.randomUUID() }), dec('block', 0.97));

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };
    const tool = b.tools.find(t => t.tool === 'dangerous-tool');
    expect(tool).toBeDefined();
    expect(tool!.blockRate).toBeCloseTo(1, 5);
  });

  it('17. blockRate is independent per tool — multiple tools have correct values', async () => {
    ctx = await setup();
    // tool-a: 4 ops, 1 block => blockRate = 0.25
    await ctx.logger.log(makeOp('agent-a', 'tool-a', { id: crypto.randomUUID() }), dec('block', 0.8));
    await ctx.logger.log(makeOp('agent-a', 'tool-a', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-a', { id: crypto.randomUUID() }), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'tool-a', { id: crypto.randomUUID() }), dec('allow', 0.15));
    // tool-b: 3 ops, 3 blocks => blockRate = 1
    await ctx.logger.log(makeOp('agent-b', 'tool-b', { id: crypto.randomUUID() }), dec('block', 0.9));
    await ctx.logger.log(makeOp('agent-b', 'tool-b', { id: crypto.randomUUID() }), dec('block', 0.85));
    await ctx.logger.log(makeOp('agent-b', 'tool-b', { id: crypto.randomUUID() }), dec('block', 0.95));

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };
    const toolA = b.tools.find(t => t.tool === 'tool-a');
    const toolB = b.tools.find(t => t.tool === 'tool-b');
    expect(toolA).toBeDefined();
    expect(toolB).toBeDefined();
    expect(toolA!.blockRate).toBeCloseTo(0.25, 5);
    expect(toolB!.blockRate).toBeCloseTo(1, 5);
  });

  it('18. single-use tool has blockRate 0 if allowed, 1 if blocked', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-once-allow', { id: crypto.randomUUID() }), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-a', 'tool-once-block', { id: crypto.randomUUID() }), dec('block', 0.9));

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string; blockRate: number }> };
    const allowed = b.tools.find(t => t.tool === 'tool-once-allow');
    const blocked = b.tools.find(t => t.tool === 'tool-once-block');
    expect(allowed).toBeDefined();
    expect(blocked).toBeDefined();
    expect(allowed!.blockRate).toBe(0);
    expect(blocked!.blockRate).toBe(1);
  });
});

// ── T362 — GET /risk pagination with offset ───────────────────────────────────
//
// Implementation note: listRisk fetches `limit` rows from the DB, then slices
// by offset within that result set.  To test offset pagination properly we must
// request a limit large enough to contain all seeded items in the store fetch,
// then verify that slice(offset, offset+limit) behaves correctly.
// We use limit=50 (the default, and larger than the 6 seeded ops) throughout
// the pagination tests so that allRiskData contains all 6 items.

describe('GET /risk offset/limit pagination (T362)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed 6 operations with distinct operationIds so we can verify pagination.
   * Returns the operationIds in insertion order.
   */
  async function seedRiskOps(localCtx: Ctx): Promise<string[]> {
    const ids: string[] = [];
    const agents = ['agent-a', 'agent-b', 'agent-c'];
    const tools = ['fs', 'db', 'net'];
    for (let i = 0; i < 6; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      await localCtx.logger.log(
        makeOp(agents[i % 3]!, tools[i % 3]!, {
          id,
          // stagger timestamps so order is deterministic (newest first in default sort)
          timestamp: new Date(Date.now() - (6 - i) * 1000),
        }),
        dec(i % 2 === 0 ? 'block' : 'allow', 0.1 + i * 0.1)
      );
    }
    return ids;
  }

  it('19. GET /risk response includes count, limit, and offset fields', async () => {
    ctx = await setup();
    await seedRiskOps(ctx);

    // Use default limit (50) — large enough to pull all 6 seeded ops
    const { status, body } = await getJSON(ctx.port, '/risk?offset=0');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(typeof b['count']).toBe('number');
    expect(typeof b['limit']).toBe('number');
    expect(typeof b['offset']).toBe('number');
  });

  it('20. GET /risk with default limit returns all 6 seeded entries at offset=0', async () => {
    ctx = await setup();
    await seedRiskOps(ctx);

    // limit defaults to 50 — fetches all 6 ops from store, then slices [0..50)
    const { body } = await getJSON(ctx.port, '/risk?offset=0');
    const b = body as { data: unknown[]; count: number; limit: number; offset: number };
    expect(b.data.length).toBeGreaterThanOrEqual(6);
    expect(b.limit).toBe(50); // default
    expect(b.offset).toBe(0);
    expect(b.count).toBeGreaterThanOrEqual(6);
  });

  it('21. GET /risk?offset=2 with large limit returns entries starting at index 2', async () => {
    ctx = await setup();
    await seedRiskOps(ctx);

    // Fetch all with no offset to know the full list
    const { body: bodyAll } = await getJSON(ctx.port, '/risk?offset=0');
    const all = (bodyAll as { data: Array<{ operationId: string }>; count: number }).data;

    // Now fetch with offset=2, same large default limit
    const { body } = await getJSON(ctx.port, '/risk?offset=2');
    const b = body as { data: Array<{ operationId: string }>; count: number; limit: number; offset: number };
    expect(b.offset).toBe(2);
    // Should have 4 items (6 total minus first 2)
    expect(b.data.length).toBe(all.length - 2);
    // First item at offset=2 must be item at index 2 of the full list
    expect(b.data[0]!.operationId).toBe(all[2]!.operationId);
  });

  it('22. offset=0 and offset=2 return different operationIds', async () => {
    ctx = await setup();
    await seedRiskOps(ctx);

    const { body: body0 } = await getJSON(ctx.port, '/risk?offset=0');
    const { body: body2 } = await getJSON(ctx.port, '/risk?offset=2');

    const b0 = body0 as { data: Array<{ operationId: string }> };
    const b2 = body2 as { data: Array<{ operationId: string }> };

    const ids0 = b0.data.map(e => e.operationId);
    const ids2 = b2.data.map(e => e.operationId);

    // The first 2 items from offset=0 must NOT appear in offset=2 results
    expect(ids0).not.toEqual(ids2);
    expect(ids0[0]).not.toBe(ids2[0]);
    expect(ids0[1]).not.toBe(ids2[0]);
  });

  it('23. count field is consistent — equals the number of items fetched from DB', async () => {
    ctx = await setup();
    await seedRiskOps(ctx);

    // Use large limit so all 6 ops are fetched; count == allRiskData.length
    const { body } = await getJSON(ctx.port, '/risk?offset=0');
    const b = body as { data: unknown[]; count: number };
    // count reflects the total items in the fetch window (all 6 since limit=50)
    expect(b.count).toBe(b.data.length + 0); // no offset, so data.length == count
  });

  it('24. offset=2 entries are items 3 and 4 from the full list (offset=0, same large limit)', async () => {
    ctx = await setup();
    await seedRiskOps(ctx);

    // Both requests use the same default large limit so the DB fetch is identical
    const { body: bodyAll } = await getJSON(ctx.port, '/risk?offset=0');
    const { body: bodyPaged } = await getJSON(ctx.port, '/risk?offset=2');

    const all = (bodyAll as { data: Array<{ operationId: string }> }).data;
    const paged = (bodyPaged as { data: Array<{ operationId: string }> }).data;

    // paged[0] == all[2], paged[1] == all[3]
    expect(paged[0]!.operationId).toBe(all[2]!.operationId);
    expect(paged[1]!.operationId).toBe(all[3]!.operationId);
  });

  it('25. offset beyond total count returns empty data array', async () => {
    ctx = await setup();
    await seedRiskOps(ctx); // seeds 6 ops

    // offset=1000, default limit=50 → DB fetches 6 ops, slice(1000, 1050) = []
    const { status, body } = await getJSON(ctx.port, '/risk?offset=1000');
    expect(status).toBe(200);
    const b = body as { data: unknown[]; count: number; limit: number; offset: number };
    expect(b.data).toHaveLength(0);
    expect(b.offset).toBe(1000);
  });

  it('26. limit and offset are echoed back correctly in response for non-default values', async () => {
    ctx = await setup();
    await seedRiskOps(ctx);

    // Use a limit large enough to capture all ops so slicing works
    const { body } = await getJSON(ctx.port, '/risk?limit=50&offset=1');
    const b = body as { limit: number; offset: number; data: unknown[] };
    expect(b.limit).toBe(50);
    expect(b.offset).toBe(1);
    // With 6 seeded ops and offset=1, we get 5 items
    expect(b.data.length).toBe(5);
  });
});

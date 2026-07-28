/**
 * v0.43 sort-control tests
 *
 * T329 — GET /agents?sort=avgRiskScore&order=asc   : agents sorted ascending by avgRiskScore
 *         GET /agents?sort=totalOps&order=asc       : agents sorted ascending by totalOps
 *         GET /agents (default)                     : agents sorted descending by totalOps
 * T330 — GET /tools?sort=avgRiskScore&order=asc    : tools sorted ascending by avgRiskScore
 *         GET /tools?sort=totalOps&order=asc        : tools sorted ascending by totalOps
 * T333 — GET /sessions?sort=totalOps&order=asc     : sessions sorted ascending by operationCount
 *         GET /sessions?sort=firstSeen&order=asc    : sessions sorted ascending by firstSeen
 *         GET /sessions (default)                   : sessions sorted descending by lastSeen
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

// ── T329 — GET /agents sort controls ─────────────────────────────────────────

describe('GET /agents sort controls (T329)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('1. sort=avgRiskScore&order=asc returns agents sorted ascending by avgRiskScore', async () => {
    ctx = await setup();
    // agent-low:  2 ops at risk 0.1  → avgRisk ≈ 0.1
    // agent-mid:  2 ops at risk 0.5  → avgRisk ≈ 0.5
    // agent-high: 2 ops at risk 0.9  → avgRisk ≈ 0.9
    for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-low',  'fs'), dec('allow', 0.1));
    for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-mid',  'fs'), dec('allow', 0.5));
    for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-high', 'fs'), dec('allow', 0.9));

    const { status, body } = await getJSON(ctx.port, '/agents?sort=avgRiskScore&order=asc');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; avgRiskScore: number }>; count: number };
    expect(b.count).toBe(3);
    expect(b.agents).toHaveLength(3);

    // Each avgRiskScore must be >= the previous (ascending)
    const scores = b.agents.map(a => a.avgRiskScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
    // First agent has the lowest avgRiskScore
    expect(b.agents[0].agentId).toBe('agent-low');
    expect(b.agents[b.agents.length - 1].agentId).toBe('agent-high');
  });

  it('2. sort=avgRiskScore&order=asc with 4 agents preserves correct ascending order', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agent-b', 'fs'), dec('allow', 0.8));
    await ctx.logger.log(makeOp('agent-c', 'fs'), dec('allow', 0.1));
    await ctx.logger.log(makeOp('agent-d', 'fs'), dec('allow', 0.6));

    const { body } = await getJSON(ctx.port, '/agents?sort=avgRiskScore&order=asc');
    const b = body as { agents: Array<{ agentId: string; avgRiskScore: number }> };
    const scores = b.agents.map(a => a.avgRiskScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
    expect(b.agents[0].agentId).toBe('agent-c');
    expect(b.agents[b.agents.length - 1].agentId).toBe('agent-b');
  });

  it('3. sort=totalOps&order=asc returns agents sorted ascending by totalOps', async () => {
    ctx = await setup();
    // agent-many: 5 ops, agent-few: 1 op, agent-mid: 3 ops
    for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp('agent-many', 'fs'), dec());
    await ctx.logger.log(makeOp('agent-few', 'fs'), dec());
    for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-mid',  'fs'), dec());

    const { status, body } = await getJSON(ctx.port, '/agents?sort=totalOps&order=asc');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; totalOps: number }>; count: number };
    expect(b.count).toBe(3);

    const ops = b.agents.map(a => a.totalOps);
    for (let i = 1; i < ops.length; i++) {
      expect(ops[i]).toBeGreaterThanOrEqual(ops[i - 1]);
    }
    expect(b.agents[0].agentId).toBe('agent-few');
    expect(b.agents[b.agents.length - 1].agentId).toBe('agent-many');
  });

  it('4. sort=totalOps&order=asc: fewest ops agent comes first', async () => {
    ctx = await setup();
    for (let i = 0; i < 4; i++) await ctx.logger.log(makeOp('agent-busy', 'fs'), dec());
    await ctx.logger.log(makeOp('agent-idle', 'net'), dec());
    for (let i = 0; i < 2; i++) await ctx.logger.log(makeOp('agent-avg', 'db'), dec());

    const { body } = await getJSON(ctx.port, '/agents?sort=totalOps&order=asc');
    const b = body as { agents: Array<{ agentId: string; totalOps: number }> };
    expect(b.agents[0].agentId).toBe('agent-idle');
    expect(b.agents[0].totalOps).toBe(1);
  });

  it('5. default sort (no params) returns agents sorted descending by totalOps', async () => {
    ctx = await setup();
    // agent-high: 5 ops, agent-low: 1 op, agent-mid: 3 ops
    for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp('agent-high', 'fs'), dec());
    await ctx.logger.log(makeOp('agent-low', 'fs'), dec());
    for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-mid',  'fs'), dec());

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; totalOps: number }>; count: number };
    expect(b.count).toBe(3);

    const ops = b.agents.map(a => a.totalOps);
    for (let i = 1; i < ops.length; i++) {
      expect(ops[i]).toBeLessThanOrEqual(ops[i - 1]);
    }
    expect(b.agents[0].agentId).toBe('agent-high');
    expect(b.agents[b.agents.length - 1].agentId).toBe('agent-low');
  });

  it('6. default sort returns 200 with agents array and count', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agt-a', 'fs'), dec('allow', 0.3));
    await ctx.logger.log(makeOp('agt-b', 'fs'), dec('allow', 0.7));

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as { agents: Array<unknown>; count: number };
    expect(b.count).toBe(2);
    expect(b.agents).toHaveLength(2);
  });
});

// ── T330 — GET /tools sort controls ──────────────────────────────────────────

describe('GET /tools sort controls (T330)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('7. sort=avgRiskScore&order=asc returns tools sorted ascending by avgRiskScore', async () => {
    ctx = await setup();
    // tool-safe:  3 uses at 0.1   → avgRisk ≈ 0.1
    // tool-risky: 3 uses at 0.8   → avgRisk ≈ 0.8
    // tool-mid:   3 uses at 0.45  → avgRisk ≈ 0.45
    for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-a', 'tool-safe'),  dec('allow', 0.1));
    for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-a', 'tool-risky'), dec('allow', 0.8));
    for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-a', 'tool-mid'),   dec('allow', 0.45));

    const { status, body } = await getJSON(ctx.port, '/tools?sort=avgRiskScore&order=asc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; avgRiskScore: number }>; count: number };
    expect(b.count).toBe(3);
    expect(b.tools).toHaveLength(3);

    const scores = b.tools.map(t => t.avgRiskScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
    expect(b.tools[0].tool).toBe('tool-safe');
    expect(b.tools[b.tools.length - 1].tool).toBe('tool-risky');
  });

  it('8. sort=avgRiskScore&order=asc with 4 tools preserves correct ascending order', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'tool-x'), dec('allow', 0.6));
    await ctx.logger.log(makeOp('agent-a', 'tool-y'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'tool-z'), dec('allow', 0.9));
    await ctx.logger.log(makeOp('agent-a', 'tool-w'), dec('allow', 0.4));

    const { body } = await getJSON(ctx.port, '/tools?sort=avgRiskScore&order=asc');
    const b = body as { tools: Array<{ tool: string; avgRiskScore: number }> };
    const scores = b.tools.map(t => t.avgRiskScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
    expect(b.tools[0].tool).toBe('tool-y');
    expect(b.tools[b.tools.length - 1].tool).toBe('tool-z');
  });

  it('9. sort=totalOps&order=asc returns tools sorted ascending by totalOps', async () => {
    ctx = await setup();
    // tool-heavy: 6 uses, tool-light: 1 use, tool-med: 3 uses
    for (let i = 0; i < 6; i++) await ctx.logger.log(makeOp('agent-a', 'tool-heavy'), dec());
    await ctx.logger.log(makeOp('agent-a', 'tool-light'), dec());
    for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-a', 'tool-med'),   dec());

    const { status, body } = await getJSON(ctx.port, '/tools?sort=totalOps&order=asc');
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; totalOps: number }>; count: number };
    expect(b.count).toBe(3);

    const ops = b.tools.map(t => t.totalOps);
    for (let i = 1; i < ops.length; i++) {
      expect(ops[i]).toBeGreaterThanOrEqual(ops[i - 1]);
    }
    expect(b.tools[0].tool).toBe('tool-light');
    expect(b.tools[b.tools.length - 1].tool).toBe('tool-heavy');
  });

  it('10. sort=totalOps&order=asc: least-used tool comes first', async () => {
    ctx = await setup();
    for (let i = 0; i < 5; i++) await ctx.logger.log(makeOp('agent-a', 'popular-tool'), dec());
    await ctx.logger.log(makeOp('agent-a', 'rare-tool'), dec());

    const { body } = await getJSON(ctx.port, '/tools?sort=totalOps&order=asc');
    const b = body as { tools: Array<{ tool: string; totalOps: number }> };
    expect(b.tools[0].tool).toBe('rare-tool');
    expect(b.tools[0].totalOps).toBe(1);
  });

  it('11. sort=avgRiskScore&order=asc returns 200 with non-empty tools array', async () => {
    ctx = await setup();
    await ctx.logger.log(makeOp('agent-a', 'fs'), dec('allow', 0.2));
    await ctx.logger.log(makeOp('agent-a', 'db'), dec('allow', 0.7));

    const { status, body } = await getJSON(ctx.port, '/tools?sort=avgRiskScore&order=asc');
    expect(status).toBe(200);
    const b = body as { tools: Array<unknown>; count: number };
    expect(b.count).toBe(2);
    expect(b.tools).toHaveLength(2);
  });
});

// ── T333 — GET /sessions sort controls ───────────────────────────────────────

describe('GET /sessions sort controls (T333)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  it('12. sort=totalOps&order=asc returns sessions sorted ascending by operationCount', async () => {
    ctx = await setup();
    const t0 = new Date('2024-06-01T10:00:00Z');
    // sess-few: 1 op, sess-mid: 3 ops, sess-many: 6 ops
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-few',  timestamp: new Date(t0.getTime() + 1000) }), dec());
    for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-mid',  timestamp: new Date(t0.getTime() + 2000 + i * 100) }), dec());
    for (let i = 0; i < 6; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-many', timestamp: new Date(t0.getTime() + 5000 + i * 100) }), dec());

    const { status, body } = await getJSON(ctx.port, '/sessions?sort=totalOps&order=asc');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; operationCount: number }>; count: number };
    expect(b.count).toBe(3);
    expect(b.data).toHaveLength(3);

    const counts = b.data.map(s => s.operationCount);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    }
    expect(b.data[0].sessionId).toBe('sess-few');
    expect(b.data[b.data.length - 1].sessionId).toBe('sess-many');
  });

  it('13. sort=totalOps&order=asc: session with 1 op is first', async () => {
    ctx = await setup();
    const t0 = new Date('2024-07-01T08:00:00Z');
    for (let i = 0; i < 4; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-busy',  timestamp: new Date(t0.getTime() + i * 1000) }), dec());
    await ctx.logger.log(makeOp('agent-a', 'net', { sessionId: 'sess-quiet', timestamp: new Date(t0.getTime() + 5000) }), dec());

    const { body } = await getJSON(ctx.port, '/sessions?sort=totalOps&order=asc');
    const b = body as { data: Array<{ sessionId: string; operationCount: number }> };
    expect(b.data[0].sessionId).toBe('sess-quiet');
    expect(b.data[0].operationCount).toBe(1);
  });

  it('14. sort=firstSeen&order=asc returns sessions sorted ascending by firstSeen timestamp', async () => {
    ctx = await setup();
    // sess-early:  firstSeen = 2024-01-01T06:00
    // sess-latest: firstSeen = 2024-01-01T18:00
    // sess-noon:   firstSeen = 2024-01-01T12:00
    const early  = new Date('2024-01-01T06:00:00Z');
    const noon   = new Date('2024-01-01T12:00:00Z');
    const latest = new Date('2024-01-01T18:00:00Z');

    // Insert in reverse order to ensure sort is actually applied
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-latest', timestamp: latest }), dec());
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-noon',   timestamp: noon   }), dec());
    await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'sess-early',  timestamp: early  }), dec());

    const { status, body } = await getJSON(ctx.port, '/sessions?sort=firstSeen&order=asc');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; firstSeen: string }>; count: number };
    expect(b.count).toBe(3);
    expect(b.data).toHaveLength(3);

    // Verify ascending order of firstSeen timestamps
    const times = b.data.map(s => new Date(s.firstSeen).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }
    expect(b.data[0].sessionId).toBe('sess-early');
    expect(b.data[b.data.length - 1].sessionId).toBe('sess-latest');
  });

  it('15. sort=firstSeen&order=asc: earliest-started session is first', async () => {
    ctx = await setup();
    const t1 = new Date('2023-11-01T09:00:00Z');
    const t2 = new Date('2023-12-01T09:00:00Z');

    await ctx.logger.log(makeOp('agent-a', 'fs',  { sessionId: 'sess-dec', timestamp: t2 }), dec());
    await ctx.logger.log(makeOp('agent-a', 'net', { sessionId: 'sess-nov', timestamp: t1 }), dec());

    const { body } = await getJSON(ctx.port, '/sessions?sort=firstSeen&order=asc');
    const b = body as { data: Array<{ sessionId: string }> };
    expect(b.data[0].sessionId).toBe('sess-nov');
  });

  it('16. default sort (no params) returns sessions sorted descending by lastSeen', async () => {
    ctx = await setup();
    // sess-old:   lastSeen = 2024-03-01T08:00
    // sess-new:   lastSeen = 2024-03-01T20:00
    // sess-mid:   lastSeen = 2024-03-01T14:00
    const old = new Date('2024-03-01T08:00:00Z');
    const mid = new Date('2024-03-01T14:00:00Z');
    const fresh = new Date('2024-03-01T20:00:00Z');

    await ctx.logger.log(makeOp('agent-a', 'fs',  { sessionId: 'sess-old', timestamp: old   }), dec());
    await ctx.logger.log(makeOp('agent-a', 'net', { sessionId: 'sess-mid', timestamp: mid   }), dec());
    await ctx.logger.log(makeOp('agent-a', 'db',  { sessionId: 'sess-new', timestamp: fresh }), dec());

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string; lastSeen: string }>; count: number };
    expect(b.count).toBe(3);
    expect(b.data).toHaveLength(3);

    // Default: descending by lastSeen → most-recent first
    const times = b.data.map(s => new Date(s.lastSeen).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
    }
    expect(b.data[0].sessionId).toBe('sess-new');
    expect(b.data[b.data.length - 1].sessionId).toBe('sess-old');
  });

  it('17. default sort returns 200 with data array and count', async () => {
    ctx = await setup();
    const t1 = new Date('2024-04-01T10:00:00Z');
    const t2 = new Date('2024-04-01T11:00:00Z');
    await ctx.logger.log(makeOp('agent-a', 'fs',  { sessionId: 'sess-a', timestamp: t1 }), dec());
    await ctx.logger.log(makeOp('agent-a', 'net', { sessionId: 'sess-b', timestamp: t2 }), dec());

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { data: Array<unknown>; count: number };
    expect(b.count).toBe(2);
    expect(b.data).toHaveLength(2);
  });

  it('18. sort=totalOps&order=asc with a single session returns that session', async () => {
    ctx = await setup();
    const t = new Date('2024-05-01T10:00:00Z');
    for (let i = 0; i < 3; i++) await ctx.logger.log(makeOp('agent-a', 'fs', { sessionId: 'only-sess', timestamp: new Date(t.getTime() + i * 1000) }), dec());

    const { body } = await getJSON(ctx.port, '/sessions?sort=totalOps&order=asc');
    const b = body as { data: Array<{ sessionId: string; operationCount: number }>; count: number };
    expect(b.count).toBe(1);
    expect(b.data[0].sessionId).toBe('only-sess');
    expect(b.data[0].operationCount).toBe(3);
  });
});

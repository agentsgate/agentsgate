/**
 * v0.55 advanced-filter tests
 *
 * T389 — GET /agents supports ?minMaxRiskScore=0.N
 *         only agents whose maxRiskScore >= n are returned
 *
 * T390 — GET /tools supports ?since=<iso>
 *         only tools whose lastSeen >= since are returned
 *
 * T391 — GET /sessions supports ?since=<iso>
 *         only sessions whose lastSeen >= since are returned
 *
 * T392/T393 are CLI-only changes — skipped.
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

// ── T389 — GET /agents ?minMaxRiskScore=N filter ──────────────────────────────

describe('GET /agents ?minMaxRiskScore=N filter (T389)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds three agents with clearly separated maxRiskScore values via explicit
   * saveOperationLog calls so we control the risk scores precisely:
   *   agent-low:  maxRiskScore = 0.3  (one op at 0.3)
   *   agent-mid:  maxRiskScore = 0.6  (one op at 0.6)
   *   agent-high: maxRiskScore = 0.9  (one op at 0.9)
   */
  async function seedAgents(ctx: Ctx): Promise<void> {
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-low', 'tool-x', 'sess-a', { id: crypto.randomUUID() }),
      decision: dec('allow', 0.3),
      createdAt: new Date(),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-mid', 'tool-x', 'sess-b', { id: crypto.randomUUID() }),
      decision: dec('allow', 0.6),
      createdAt: new Date(),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-high', 'tool-x', 'sess-c', { id: crypto.randomUUID() }),
      decision: dec('block', 0.9),
      createdAt: new Date(),
    });
  }

  it('1. ?minMaxRiskScore=0.5 returns agent-mid and agent-high, excludes agent-low', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?minMaxRiskScore=0.5');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; maxRiskScore: number }>; count: number };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-mid');
    expect(ids).toContain('agent-high');
    expect(ids).not.toContain('agent-low');
    expect(b.count).toBe(2);
  });

  it('2. ?minMaxRiskScore=0.8 returns only agent-high', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?minMaxRiskScore=0.8');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; maxRiskScore: number }>; count: number };
    expect(b.count).toBe(1);
    expect(b.agents[0]!.agentId).toBe('agent-high');
    expect(b.agents[0]!.maxRiskScore).toBeGreaterThanOrEqual(0.8);
  });

  it('3. ?minMaxRiskScore=0.0 returns all agents (trivial lower bound)', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?minMaxRiskScore=0.0');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string }>; count: number };
    expect(b.count).toBe(3);
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain('agent-low');
    expect(ids).toContain('agent-mid');
    expect(ids).toContain('agent-high');
  });

  it('4. all returned agents satisfy maxRiskScore >= minMaxRiskScore', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?minMaxRiskScore=0.5');
    const b = body as { agents: Array<{ agentId: string; maxRiskScore: number }> };
    for (const a of b.agents) {
      expect(a.maxRiskScore).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('5. ?minMaxRiskScore=1.0 excludes all agents (none has maxRiskScore >= 1.0)', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?minMaxRiskScore=1.0');
    expect(status).toBe(200);
    const b = body as { agents: Array<unknown>; count: number };
    expect(b.count).toBe(0);
    expect(b.agents).toHaveLength(0);
  });

  it('6. invalid ?minMaxRiskScore=abc is ignored, all agents returned', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents?minMaxRiskScore=abc');
    expect(status).toBe(200);
    const b = body as { agents: Array<unknown>; count: number };
    // Invalid value: filter skipped, all 3 agents returned
    expect(b.count).toBe(3);
  });

  it('7. ?minMaxRiskScore=0.6 includes agent with maxRiskScore exactly at boundary', async () => {
    ctx = await setup();
    await seedAgents(ctx);

    const { body } = await getJSON(ctx.port, '/agents?minMaxRiskScore=0.6');
    const b = body as { agents: Array<{ agentId: string; maxRiskScore: number }>; count: number };
    const ids = b.agents.map(a => a.agentId);
    // agent-mid maxRiskScore = 0.6 exactly — must be included (>=)
    expect(ids).toContain('agent-mid');
    expect(ids).toContain('agent-high');
    expect(ids).not.toContain('agent-low');
    expect(b.count).toBe(2);
  });

  it('8. ?minMaxRiskScore combined with ?minOps narrows both dimensions', async () => {
    ctx = await setup();
    // agent-single: 1 op at 0.9 (excluded by minOps=2)
    // agent-multi:  2 ops, max risk 0.9 (passes minOps=2 and minMaxRiskScore=0.7)
    // agent-low-multi: 2 ops, max risk 0.2 (passes minOps=2 but excluded by minMaxRiskScore=0.7)
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-single', 'tool-x', 'sess-s1', { id: crypto.randomUUID() }),
      decision: dec('block', 0.9),
      createdAt: new Date(),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-multi', 'tool-x', 'sess-m1', { id: crypto.randomUUID() }),
      decision: dec('allow', 0.3),
      createdAt: new Date(),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-multi', 'tool-x', 'sess-m2', { id: crypto.randomUUID() }),
      decision: dec('block', 0.9),
      createdAt: new Date(),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-low-multi', 'tool-x', 'sess-lm1', { id: crypto.randomUUID() }),
      decision: dec('allow', 0.1),
      createdAt: new Date(),
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-low-multi', 'tool-x', 'sess-lm2', { id: crypto.randomUUID() }),
      decision: dec('allow', 0.2),
      createdAt: new Date(),
    });

    const { status, body } = await getJSON(ctx.port, '/agents?minMaxRiskScore=0.7&minOps=2');
    expect(status).toBe(200);
    const b = body as { agents: Array<{ agentId: string; maxRiskScore: number; totalOps: number }>; count: number };
    expect(b.count).toBe(1);
    expect(b.agents[0]!.agentId).toBe('agent-multi');
    expect(b.agents[0]!.maxRiskScore).toBeGreaterThanOrEqual(0.7);
    expect(b.agents[0]!.totalOps).toBeGreaterThanOrEqual(2);
  });
});

// ── T390 — GET /tools ?since=<iso> filter ─────────────────────────────────────

describe('GET /tools ?since=<iso> filter (T390)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds 3 tools with distinct operation timestamps (which determines lastSeen):
   *   tool-old:    lastSeen = 3h ago
   *   tool-mid:    lastSeen = 2h ago
   *   tool-recent: lastSeen = 1h ago
   *
   * The dashboard derives lastSeen from operation.timestamp, so we set timestamp
   * explicitly via saveOperationLog.
   */
  async function seedToolsWithTimes(ctx: Ctx): Promise<{ tOld: Date; tMid: Date; tRecent: Date }> {
    const now = Date.now();
    const tOld    = new Date(now - 3 * 60 * 60 * 1000);
    const tMid    = new Date(now - 2 * 60 * 60 * 1000);
    const tRecent = new Date(now - 1 * 60 * 60 * 1000);

    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-a', 'tool-old', 'sess-a', { id: crypto.randomUUID(), timestamp: tOld }),
      decision: dec('allow', 0.2),
      createdAt: tOld,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-b', 'tool-mid', 'sess-b', { id: crypto.randomUUID(), timestamp: tMid }),
      decision: dec('allow', 0.4),
      createdAt: tMid,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-c', 'tool-recent', 'sess-c', { id: crypto.randomUUID(), timestamp: tRecent }),
      decision: dec('allow', 0.6),
      createdAt: tRecent,
    });

    return { tOld, tMid, tRecent };
  }

  it('9. ?since= before all tools returns all tools', async () => {
    ctx = await setup();
    const { tOld } = await seedToolsWithTimes(ctx);

    const since = new Date(tOld.getTime() - 60 * 60 * 1000); // 1h before oldest
    const { status, body } = await getJSON(ctx.port, `/tools?since=${encodeURIComponent(since.toISOString())}`);
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    const names = b.tools.map(t => t.tool);
    expect(names).toContain('tool-old');
    expect(names).toContain('tool-mid');
    expect(names).toContain('tool-recent');
    expect(b.count).toBe(3);
  });

  it('10. ?since= set after tool-old excludes tool-old but includes newer tools', async () => {
    ctx = await setup();
    const { tOld, tMid } = await seedToolsWithTimes(ctx);

    // since = midpoint between tOld and tMid
    const since = new Date(tOld.getTime() + 30 * 60 * 1000);
    expect(since.getTime()).toBeLessThan(tMid.getTime());

    const { status, body } = await getJSON(ctx.port, `/tools?since=${encodeURIComponent(since.toISOString())}`);
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    const names = b.tools.map(t => t.tool);
    expect(names).not.toContain('tool-old');
    expect(names).toContain('tool-mid');
    expect(names).toContain('tool-recent');
    expect(b.count).toBe(2);
  });

  it('11. ?since= set after tool-mid returns only tool-recent', async () => {
    ctx = await setup();
    const { tMid, tRecent } = await seedToolsWithTimes(ctx);

    const since = new Date(tMid.getTime() + 30 * 60 * 1000);
    expect(since.getTime()).toBeLessThan(tRecent.getTime());

    const { status, body } = await getJSON(ctx.port, `/tools?since=${encodeURIComponent(since.toISOString())}`);
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    const names = b.tools.map(t => t.tool);
    expect(names).not.toContain('tool-old');
    expect(names).not.toContain('tool-mid');
    expect(names).toContain('tool-recent');
    expect(b.count).toBe(1);
  });

  it('12. ?since= in the future returns an empty tools array', async () => {
    ctx = await setup();
    await seedToolsWithTimes(ctx);

    const since = new Date(Date.now() + 60 * 60 * 1000); // 1h from now
    const { status, body } = await getJSON(ctx.port, `/tools?since=${encodeURIComponent(since.toISOString())}`);
    expect(status).toBe(200);
    const b = body as { tools: Array<unknown>; count: number };
    expect(b.count).toBe(0);
    expect(b.tools).toHaveLength(0);
  });

  it('13. ?since= exactly at tool-mid boundary includes tool-mid (lastSeen >= since)', async () => {
    ctx = await setup();
    const { tMid } = await seedToolsWithTimes(ctx);

    const { body } = await getJSON(ctx.port, `/tools?since=${encodeURIComponent(tMid.toISOString())}`);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    const names = b.tools.map(t => t.tool);
    // tool-mid's lastSeen == since, must be included
    expect(names).toContain('tool-mid');
    expect(names).toContain('tool-recent');
    expect(names).not.toContain('tool-old');
    expect(b.count).toBe(2);
  });

  it('14. tool with multiple ops uses the most recent timestamp as lastSeen', async () => {
    ctx = await setup();
    const now = Date.now();
    const tEarly = new Date(now - 4 * 60 * 60 * 1000);
    const tLate  = new Date(now - 1 * 60 * 60 * 1000);

    // Same tool used at two different times
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-a', 'tool-two-times', 'sess-e', { id: crypto.randomUUID(), timestamp: tEarly }),
      decision: dec('allow', 0.2),
      createdAt: tEarly,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-a', 'tool-two-times', 'sess-l', { id: crypto.randomUUID(), timestamp: tLate }),
      decision: dec('allow', 0.3),
      createdAt: tLate,
    });

    // since = between the two ops — tool should still appear because lastSeen = tLate
    const since = new Date(now - 2 * 60 * 60 * 1000);
    expect(since.getTime()).toBeGreaterThan(tEarly.getTime());
    expect(since.getTime()).toBeLessThan(tLate.getTime());

    const { body } = await getJSON(ctx.port, `/tools?since=${encodeURIComponent(since.toISOString())}`);
    const b = body as { tools: Array<{ tool: string }>; count: number };
    expect(b.tools.map(t => t.tool)).toContain('tool-two-times');
  });

  it('15. ?since= can be combined with ?minOps to narrow both time and ops dimensions', async () => {
    ctx = await setup();
    const now = Date.now();
    const tOld    = new Date(now - 3 * 60 * 60 * 1000);
    const tRecent = new Date(now - 1 * 60 * 60 * 1000);

    // tool-old-single:  1 op, old timestamp — excluded by since AND has only 1 op
    // tool-new-single:  1 op, recent timestamp — passes since but excluded by minOps=2
    // tool-new-multi:   2 ops, both recent — passes both since and minOps=2
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-a', 'tool-old-single', 'sess-a1', { id: crypto.randomUUID(), timestamp: tOld }),
      decision: dec('allow', 0.2),
      createdAt: tOld,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-b', 'tool-new-single', 'sess-b1', { id: crypto.randomUUID(), timestamp: tRecent }),
      decision: dec('allow', 0.3),
      createdAt: tRecent,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-c', 'tool-new-multi', 'sess-c1', { id: crypto.randomUUID(), timestamp: tRecent }),
      decision: dec('allow', 0.4),
      createdAt: tRecent,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-c', 'tool-new-multi', 'sess-c2', { id: crypto.randomUUID(), timestamp: tRecent }),
      decision: dec('allow', 0.5),
      createdAt: tRecent,
    });

    const since = new Date(tOld.getTime() + 30 * 60 * 1000);
    const { status, body } = await getJSON(
      ctx.port,
      `/tools?since=${encodeURIComponent(since.toISOString())}&minOps=2`
    );
    expect(status).toBe(200);
    const b = body as { tools: Array<{ tool: string; totalOps: number }>; count: number };
    expect(b.count).toBe(1);
    expect(b.tools[0]!.tool).toBe('tool-new-multi');
    expect(b.tools[0]!.totalOps).toBeGreaterThanOrEqual(2);
  });
});

// ── T391 — GET /sessions ?since=<iso> filter ──────────────────────────────────

describe('GET /sessions ?since=<iso> filter (T391)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds 3 sessions with distinct lastSeen timestamps driven by operation.timestamp:
   *   sess-old:    lastSeen = 3h ago
   *   sess-mid:    lastSeen = 2h ago
   *   sess-recent: lastSeen = 1h ago
   */
  async function seedSessionsWithTimes(ctx: Ctx): Promise<{ tOld: Date; tMid: Date; tRecent: Date }> {
    const now = Date.now();
    const tOld    = new Date(now - 3 * 60 * 60 * 1000);
    const tMid    = new Date(now - 2 * 60 * 60 * 1000);
    const tRecent = new Date(now - 1 * 60 * 60 * 1000);

    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-a', 'fs', 'sess-old', { id: crypto.randomUUID(), timestamp: tOld }),
      decision: dec('allow', 0.2),
      createdAt: tOld,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-b', 'fs', 'sess-mid', { id: crypto.randomUUID(), timestamp: tMid }),
      decision: dec('allow', 0.4),
      createdAt: tMid,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-c', 'fs', 'sess-recent', { id: crypto.randomUUID(), timestamp: tRecent }),
      decision: dec('allow', 0.6),
      createdAt: tRecent,
    });

    return { tOld, tMid, tRecent };
  }

  it('16. ?since= before all sessions returns all sessions', async () => {
    ctx = await setup();
    const { tOld } = await seedSessionsWithTimes(ctx);

    const since = new Date(tOld.getTime() - 60 * 60 * 1000); // 1h before oldest
    const { status, body } = await getJSON(ctx.port, `/sessions?since=${encodeURIComponent(since.toISOString())}`);
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string }> };
    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('sess-old');
    expect(ids).toContain('sess-mid');
    expect(ids).toContain('sess-recent');
  });

  it('17. ?since= set after sess-old excludes sess-old but includes newer sessions', async () => {
    ctx = await setup();
    const { tOld, tMid } = await seedSessionsWithTimes(ctx);

    const since = new Date(tOld.getTime() + 30 * 60 * 1000);
    expect(since.getTime()).toBeLessThan(tMid.getTime());

    const { status, body } = await getJSON(ctx.port, `/sessions?since=${encodeURIComponent(since.toISOString())}`);
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string }>; count: number };
    const ids = b.data.map(s => s.sessionId);
    expect(ids).not.toContain('sess-old');
    expect(ids).toContain('sess-mid');
    expect(ids).toContain('sess-recent');
    expect(b.count).toBe(2);
  });

  it('18. ?since= set after sess-mid returns only sess-recent', async () => {
    ctx = await setup();
    const { tMid, tRecent } = await seedSessionsWithTimes(ctx);

    const since = new Date(tMid.getTime() + 30 * 60 * 1000);
    expect(since.getTime()).toBeLessThan(tRecent.getTime());

    const { status, body } = await getJSON(ctx.port, `/sessions?since=${encodeURIComponent(since.toISOString())}`);
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string }>; count: number };
    const ids = b.data.map(s => s.sessionId);
    expect(ids).not.toContain('sess-old');
    expect(ids).not.toContain('sess-mid');
    expect(ids).toContain('sess-recent');
    expect(b.count).toBe(1);
  });

  it('19. ?since= in the future returns an empty sessions array', async () => {
    ctx = await setup();
    await seedSessionsWithTimes(ctx);

    const since = new Date(Date.now() + 60 * 60 * 1000); // 1h from now
    const { status, body } = await getJSON(ctx.port, `/sessions?since=${encodeURIComponent(since.toISOString())}`);
    expect(status).toBe(200);
    const b = body as { data: Array<unknown>; count: number };
    expect(b.count).toBe(0);
    expect(b.data).toHaveLength(0);
  });

  it('20. ?since= exactly at sess-mid boundary includes sess-mid (lastSeen >= since)', async () => {
    ctx = await setup();
    const { tMid } = await seedSessionsWithTimes(ctx);

    const { body } = await getJSON(ctx.port, `/sessions?since=${encodeURIComponent(tMid.toISOString())}`);
    const b = body as { data: Array<{ sessionId: string }>; count: number };
    const ids = b.data.map(s => s.sessionId);
    // sess-mid's lastSeen == since — must be included
    expect(ids).toContain('sess-mid');
    expect(ids).toContain('sess-recent');
    expect(ids).not.toContain('sess-old');
    expect(b.count).toBe(2);
  });

  it('21. session with multiple ops uses the most recent op timestamp as lastSeen', async () => {
    ctx = await setup();
    const now = Date.now();
    const tEarly = new Date(now - 4 * 60 * 60 * 1000);
    const tLate  = new Date(now - 1 * 60 * 60 * 1000);

    // Same session gets two ops at different times
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-a', 'fs', 'sess-two-ops', { id: crypto.randomUUID(), timestamp: tEarly }),
      decision: dec('allow', 0.2),
      createdAt: tEarly,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-a', 'fs', 'sess-two-ops', { id: crypto.randomUUID(), timestamp: tLate }),
      decision: dec('allow', 0.3),
      createdAt: tLate,
    });

    // since = between the two ops — session should appear because lastSeen = tLate
    const since = new Date(now - 2 * 60 * 60 * 1000);
    expect(since.getTime()).toBeGreaterThan(tEarly.getTime());
    expect(since.getTime()).toBeLessThan(tLate.getTime());

    const { body } = await getJSON(ctx.port, `/sessions?since=${encodeURIComponent(since.toISOString())}`);
    const b = body as { data: Array<{ sessionId: string }> };
    expect(b.data.map(s => s.sessionId)).toContain('sess-two-ops');
  });

  it('22. ?since= can be combined with ?agentId to narrow both dimensions', async () => {
    ctx = await setup();
    const now = Date.now();
    const tOld    = new Date(now - 3 * 60 * 60 * 1000);
    const tRecent = new Date(now - 1 * 60 * 60 * 1000);

    // agent-x: two sessions — one old, one recent
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-x', 'fs', 'sess-x-old', { id: crypto.randomUUID(), timestamp: tOld }),
      decision: dec('allow', 0.2),
      createdAt: tOld,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-x', 'fs', 'sess-x-recent', { id: crypto.randomUUID(), timestamp: tRecent }),
      decision: dec('allow', 0.5),
      createdAt: tRecent,
    });
    // agent-y: also has a recent session but should be excluded by agentId filter
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-y', 'fs', 'sess-y-recent', { id: crypto.randomUUID(), timestamp: tRecent }),
      decision: dec('allow', 0.5),
      createdAt: tRecent,
    });

    const since = new Date(tOld.getTime() + 30 * 60 * 1000);
    const { status, body } = await getJSON(
      ctx.port,
      `/sessions?agentId=agent-x&since=${encodeURIComponent(since.toISOString())}`
    );
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string }>; count: number };
    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain('sess-x-recent');
    expect(ids).not.toContain('sess-x-old');
    expect(ids).not.toContain('sess-y-recent');
    expect(b.count).toBe(1);
  });

  it('23. ?since= response includes lastSeen field in ISO format on each session', async () => {
    ctx = await setup();
    await seedSessionsWithTimes(ctx);

    const { body } = await getJSON(ctx.port, '/sessions');
    const b = body as { data: Array<Record<string, unknown>> };
    for (const s of b.data) {
      expect(s).toHaveProperty('lastSeen');
      expect(typeof s['lastSeen']).toBe('string');
      // Verify it's a valid ISO date
      expect(new Date(s['lastSeen'] as string).toISOString()).toBe(s['lastSeen']);
    }
  });

  it('24. ?since= combined with ?minAvgRisk narrows both time and risk dimensions', async () => {
    ctx = await setup();
    const now = Date.now();
    const tOld    = new Date(now - 3 * 60 * 60 * 1000);
    const tRecent = new Date(now - 1 * 60 * 60 * 1000);

    // sess-old-low:    old + low risk (0.1)  → excluded by both since and minAvgRisk
    // sess-recent-low: recent + low risk (0.1) → excluded by minAvgRisk only
    // sess-old-high:   old + high risk (0.9)  → excluded by since only
    // sess-recent-high: recent + high risk (0.9) → passes both
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-a', 'fs', 'sess-old-low', { id: crypto.randomUUID(), timestamp: tOld }),
      decision: dec('allow', 0.1),
      createdAt: tOld,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-b', 'fs', 'sess-recent-low', { id: crypto.randomUUID(), timestamp: tRecent }),
      decision: dec('allow', 0.1),
      createdAt: tRecent,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-c', 'fs', 'sess-old-high', { id: crypto.randomUUID(), timestamp: tOld }),
      decision: dec('block', 0.9),
      createdAt: tOld,
    });
    await ctx.store.saveOperationLog({
      operationId: crypto.randomUUID(),
      operation: makeOp('agent-d', 'fs', 'sess-recent-high', { id: crypto.randomUUID(), timestamp: tRecent }),
      decision: dec('block', 0.9),
      createdAt: tRecent,
    });

    const since = new Date(tOld.getTime() + 30 * 60 * 1000);
    const { status, body } = await getJSON(
      ctx.port,
      `/sessions?since=${encodeURIComponent(since.toISOString())}&minAvgRisk=0.5`
    );
    expect(status).toBe(200);
    const b = body as { data: Array<{ sessionId: string }>; count: number };
    expect(b.count).toBe(1);
    expect(b.data[0]!.sessionId).toBe('sess-recent-high');
  });

  it('25. invalid ?since= value is ignored, all sessions returned', async () => {
    ctx = await setup();
    await seedSessionsWithTimes(ctx);

    const { status, body } = await getJSON(ctx.port, '/sessions?since=not-a-date');
    expect(status).toBe(200);
    const b = body as { data: Array<unknown>; count: number };
    // Invalid since: filter skipped, all 3 sessions returned
    expect(b.count).toBe(3);
  });
});

/**
 * v0.86 tests — opsLast1h in GET /agents/:agentId, GET /tools/:tool,
 * GET /sessions/:sessionId, GET /operations/summary, and
 * blockedSessionRate in GET /operations/summary.
 *
 * T547 — opsLast1h in GET /agents/:agentId
 *   Agent with 2 ops at Date.now() and 1 op at Date.now()-2h
 *   → opsLast1h === 2, opsLast24h === 3
 *
 * T548 — opsLast1h in GET /tools/:tool
 *   Same pattern per tool.
 *
 * T549 — opsLast1h in GET /sessions/:sessionId
 *   Same pattern per session.
 *
 * T550 — opsLast1h in GET /operations/summary
 *   Verify opsLast1h is present and correctly counts recent ops.
 *
 * T551 — blockedSessionRate in GET /operations/summary
 *   3 sessions: sessionA (1 block), sessionB (1 block), sessionC (0 blocks)
 *   → blockedSessionRate ≈ 0.667 (2/3 sessions with blocks)
 *   Edge case: 0 sessions → blockedSessionRate === 0
 *
 * Store:  StateStore ':memory:'
 * Server: http.createServer / port 0
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import type { MCPOperation, OperationLog, ProxyDecision } from '../../src/types/interfaces.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeOp(overrides: Partial<MCPOperation> = {}): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId: 'agent-default',
    tool: 'tool-default',
    method: 'call',
    params: {},
    timestamp: new Date(),
    sessionId: 'sess-default',
    ...overrides,
  };
}

function dec(
  action: ProxyDecision['action'] = 'allow',
  riskScore = 0.1,
): ProxyDecision {
  return { action, riskScore, reasons: [] };
}

interface Ctx {
  store: StateStore;
  dash: DashboardAPI;
  port: number;
}

async function setup(): Promise<Ctx> {
  const store = new StateStore(':memory:');
  await store.initialize();
  const dash = new DashboardAPI(store, {});
  await dash.start(0);
  const port = (
    (dash as unknown as { server: http.Server }).server.address() as { port: number }
  ).port;
  return { store, dash, port };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
}

async function getJSON(
  port: number,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

async function saveLog(
  store: StateStore,
  op: MCPOperation,
  decision: ProxyDecision,
  createdAtMs?: number,
): Promise<void> {
  const log: OperationLog = {
    operationId: op.id,
    operation: op,
    decision,
    createdAt: createdAtMs != null ? new Date(createdAtMs) : new Date(),
  };
  await store.saveOperationLog(log);
}

// ── T547 — opsLast1h in GET /agents/:agentId ─────────────────────────────────

describe('T547 — opsLast1h in GET /agents/:agentId', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. opsLast1h === 2 and opsLast24h === 3 when agent has 2 recent ops and 1 op 2h ago', async () => {
    ctx = await setup();

    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    const agentId = 'agent-547-counts';

    // 2 ops within the last 1h
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-547', sessionId: 'sess-547', timestamp: new Date(now) }),
      dec('allow', 0.2),
      now,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-547', sessionId: 'sess-547', timestamp: new Date(now - 1000) }),
      dec('allow', 0.3),
      now - 1000,
    );

    // 1 op exactly 2h ago (outside 1h window, inside 24h window)
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-547', sessionId: 'sess-547-old', timestamp: new Date(twoHoursAgo) }),
      dec('allow', 0.4),
      twoHoursAgo,
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as { opsLast1h: number; opsLast24h: number };
    expect(b.opsLast1h).toBe(2);
    expect(b.opsLast24h).toBe(3);
  });

  it('2. opsLast1h === 0 when all ops are 2h old', async () => {
    ctx = await setup();

    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const agentId = 'agent-547-allold';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-547b', sessionId: 'sess-547b', timestamp: new Date(twoHoursAgo) }),
      dec('allow', 0.3),
      twoHoursAgo,
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as { opsLast1h: number };
    expect(b.opsLast1h).toBe(0);
  });

  it('3. opsLast1h field is present in GET /agents/:agentId response', async () => {
    ctx = await setup();

    const now = Date.now();
    const agentId = 'agent-547-field';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-547c', sessionId: 'sess-547c', timestamp: new Date(now) }),
      dec('allow', 0.1),
      now,
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('opsLast1h' in b).toBe(true);
  });
});

// ── T548 — opsLast1h in GET /tools/:tool ─────────────────────────────────────

describe('T548 — opsLast1h in GET /tools/:tool', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('4. opsLast1h === 2 and opsLast24h === 3 when tool has 2 recent ops and 1 op 2h ago', async () => {
    ctx = await setup();

    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    const tool = 'tool-548-counts';
    const agentId = 'agent-548';

    // 2 ops within the last 1h
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool, sessionId: 'sess-548', timestamp: new Date(now) }),
      dec('allow', 0.2),
      now,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool, sessionId: 'sess-548', timestamp: new Date(now - 2000) }),
      dec('allow', 0.3),
      now - 2000,
    );

    // 1 op exactly 2h ago (outside 1h window, inside 24h window)
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool, sessionId: 'sess-548-old', timestamp: new Date(twoHoursAgo) }),
      dec('allow', 0.4),
      twoHoursAgo,
    );

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);

    const b = body as { opsLast1h: number; opsLast24h: number };
    expect(b.opsLast1h).toBe(2);
    expect(b.opsLast24h).toBe(3);
  });

  it('5. opsLast1h === 0 when all tool ops are 2h old', async () => {
    ctx = await setup();

    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const tool = 'tool-548-allold';
    const agentId = 'agent-548-old';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool, sessionId: 'sess-548b', timestamp: new Date(twoHoursAgo) }),
      dec('allow', 0.3),
      twoHoursAgo,
    );

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);

    const b = body as { opsLast1h: number };
    expect(b.opsLast1h).toBe(0);
  });

  it('6. opsLast1h field is present in GET /tools/:tool response', async () => {
    ctx = await setup();

    const now = Date.now();
    const tool = 'tool-548-field';
    const agentId = 'agent-548-field';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool, sessionId: 'sess-548c', timestamp: new Date(now) }),
      dec('allow', 0.1),
      now,
    );

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('opsLast1h' in b).toBe(true);
  });
});

// ── T549 — opsLast1h in GET /sessions/:sessionId ─────────────────────────────

describe('T549 — opsLast1h in GET /sessions/:sessionId', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('7. opsLast1h === 2 and opsLast24h === 3 when session has 2 recent ops and 1 op 2h ago', async () => {
    ctx = await setup();

    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    const sessionId = 'sess-549-counts';
    const agentId = 'agent-549';

    // 2 ops within the last 1h
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-549', sessionId, timestamp: new Date(now) }),
      dec('allow', 0.2),
      now,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-549', sessionId, timestamp: new Date(now - 3000) }),
      dec('allow', 0.3),
      now - 3000,
    );

    // 1 op exactly 2h ago (outside 1h window, inside 24h window)
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-549', sessionId, timestamp: new Date(twoHoursAgo) }),
      dec('allow', 0.4),
      twoHoursAgo,
    );

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);

    const b = body as { opsLast1h: number; opsLast24h: number };
    expect(b.opsLast1h).toBe(2);
    expect(b.opsLast24h).toBe(3);
  });

  it('8. opsLast1h === 0 when all session ops are 2h old', async () => {
    ctx = await setup();

    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const sessionId = 'sess-549-allold';
    const agentId = 'agent-549-old';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-549b', sessionId, timestamp: new Date(twoHoursAgo) }),
      dec('allow', 0.3),
      twoHoursAgo,
    );

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);

    const b = body as { opsLast1h: number };
    expect(b.opsLast1h).toBe(0);
  });

  it('9. opsLast1h field is present in GET /sessions/:sessionId response', async () => {
    ctx = await setup();

    const now = Date.now();
    const sessionId = 'sess-549-field';
    const agentId = 'agent-549-field';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-549c', sessionId, timestamp: new Date(now) }),
      dec('allow', 0.1),
      now,
    );

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('opsLast1h' in b).toBe(true);
  });
});

// ── T550 — opsLast1h in GET /operations/summary ───────────────────────────────

describe('T550 — opsLast1h in GET /operations/summary', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('10. opsLast1h field is present in GET /operations/summary response', async () => {
    ctx = await setup();

    const now = Date.now();
    const agentId = 'agent-550-field';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-550', sessionId: 'sess-550', timestamp: new Date(now) }),
      dec('allow', 0.2),
      now,
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('opsLast1h' in b).toBe(true);
  });

  it('11. opsLast1h === 2 when 2 recent ops and 1 op 2h ago', async () => {
    ctx = await setup();

    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    const agentId = 'agent-550-counts';

    // 2 ops within the last 1h
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-550b', sessionId: 'sess-550b', timestamp: new Date(now) }),
      dec('allow', 0.2),
      now,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-550b', sessionId: 'sess-550b', timestamp: new Date(now - 4000) }),
      dec('allow', 0.3),
      now - 4000,
    );

    // 1 op exactly 2h ago (outside 1h window)
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-550b', sessionId: 'sess-550b-old', timestamp: new Date(twoHoursAgo) }),
      dec('allow', 0.4),
      twoHoursAgo,
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { opsLast1h: number };
    expect(b.opsLast1h).toBe(2);
  });

  it('12. opsLast1h === 0 when all ops are 2h old', async () => {
    ctx = await setup();

    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const agentId = 'agent-550-allold';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-550c', sessionId: 'sess-550c', timestamp: new Date(twoHoursAgo) }),
      dec('allow', 0.5),
      twoHoursAgo,
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { opsLast1h: number };
    expect(b.opsLast1h).toBe(0);
  });
});

// ── T551 — blockedSessionRate in GET /operations/summary ─────────────────────

describe('T551 — blockedSessionRate in GET /operations/summary', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('13. blockedSessionRate ≈ 0.667 when 2 of 3 sessions have at least one block', async () => {
    ctx = await setup();

    const now = Date.now();
    const agentId = 'agent-551-rate';

    // sessionA — 1 block
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-551', sessionId: 'sess-551-A', timestamp: new Date(now) }),
      dec('block', 0.9),
      now,
    );

    // sessionB — 1 block
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-551', sessionId: 'sess-551-B', timestamp: new Date(now - 1000) }),
      dec('block', 0.8),
      now - 1000,
    );

    // sessionC — 1 allow (no blocks)
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-551', sessionId: 'sess-551-C', timestamp: new Date(now - 2000) }),
      dec('allow', 0.1),
      now - 2000,
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { blockedSessionRate: number };
    expect(b.blockedSessionRate).toBeCloseTo(2 / 3, 5);
  });

  it('14. blockedSessionRate === 0 when no sessions have any blocks', async () => {
    ctx = await setup();

    const now = Date.now();
    const agentId = 'agent-551-noblocks';

    // 2 sessions, all allowed
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-551b', sessionId: 'sess-551-D', timestamp: new Date(now) }),
      dec('allow', 0.1),
      now,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-551b', sessionId: 'sess-551-E', timestamp: new Date(now - 1000) }),
      dec('allow', 0.2),
      now - 1000,
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { blockedSessionRate: number };
    expect(b.blockedSessionRate).toBe(0);
  });

  it('15. blockedSessionRate === 0 when there are no sessions at all (edge case)', async () => {
    ctx = await setup();

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { blockedSessionRate: number };
    expect(b.blockedSessionRate).toBe(0);
  });

  it('16. blockedSessionRate === 1 when all sessions have at least one block', async () => {
    ctx = await setup();

    const now = Date.now();
    const agentId = 'agent-551-allblocked';

    // sessionF — 1 block + 1 allow
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-551c', sessionId: 'sess-551-F', timestamp: new Date(now) }),
      dec('block', 0.9),
      now,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-551c', sessionId: 'sess-551-F', timestamp: new Date(now - 500) }),
      dec('allow', 0.2),
      now - 500,
    );

    // sessionG — 1 block
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-551c', sessionId: 'sess-551-G', timestamp: new Date(now - 1000) }),
      dec('block', 0.85),
      now - 1000,
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { blockedSessionRate: number };
    expect(b.blockedSessionRate).toBe(1);
  });

  it('17. blockedSessionRate field is present in GET /operations/summary response', async () => {
    ctx = await setup();

    const now = Date.now();
    const agentId = 'agent-551-field';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-551d', sessionId: 'sess-551-H', timestamp: new Date(now) }),
      dec('allow', 0.1),
      now,
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('blockedSessionRate' in b).toBe(true);
  });
});

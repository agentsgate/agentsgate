/**
 * v0.82 tests — minAllowRate filter on sessions/agents, topSessionsByRisk, pendingTrend
 *
 * T527 — minAllowRate filter in GET /sessions
 *   sessionA: 2 allowed → allowRate=1.0
 *   sessionB: 1 allowed + 1 blocked → allowRate=0.5
 *   sessionC: 1 blocked → allowRate=0.0
 *   Query GET /sessions?minAllowRate=0.6 → only sessionA returned.
 *
 * T528 — topSessionsByRisk in GET /agents/:agentId
 *   Agent with session-X (ops riskScore 0.9, 0.8 → avgRisk=0.85)
 *   and session-Y (ops riskScore 0.2, 0.1 → avgRisk=0.15).
 *   topSessionsByRisk[0].sessionId === 'session-X'.
 *
 * T530 — pendingTrend in GET /operations/summary
 *   20 ops: first 10 (most recent) all require_approval,
 *   previous 10 (older) all allow.
 *   pendingTrend === 'rising'.
 *
 * T531 — minAllowRate filter in GET /agents
 *   agent-A: allowRate=0.9 (9 allowed + 1 blocked)
 *   agent-B: allowRate=0.1 (1 allowed + 9 blocked)
 *   Query GET /agents?minAllowRate=0.5 → only agent-A returned.
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

// ── T527 — minAllowRate filter in GET /sessions ───────────────────────────────

describe('T527 — minAllowRate filter in GET /sessions', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. only sessions with allowRate >= minAllowRate are returned', async () => {
    ctx = await setup();

    const BASE = 1_970_000_000_000;
    const sessA = 'sess-527-A'; // allowRate = 1.0  (2 allowed)
    const sessB = 'sess-527-B'; // allowRate = 0.5  (1 allowed + 1 blocked)
    const sessC = 'sess-527-C'; // allowRate = 0.0  (1 blocked)
    const agentId = 'agent-527';

    // sessionA — 2 allowed
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-527', sessionId: sessA, timestamp: new Date(BASE) }),
      dec('allow', 0.1),
      BASE,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-527', sessionId: sessA, timestamp: new Date(BASE + 1_000) }),
      dec('allow', 0.2),
      BASE + 1_000,
    );

    // sessionB — 1 allowed + 1 blocked
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-527', sessionId: sessB, timestamp: new Date(BASE + 2_000) }),
      dec('allow', 0.1),
      BASE + 2_000,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-527', sessionId: sessB, timestamp: new Date(BASE + 3_000) }),
      dec('block', 0.9),
      BASE + 3_000,
    );

    // sessionC — 1 blocked
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-527', sessionId: sessC, timestamp: new Date(BASE + 4_000) }),
      dec('block', 0.95),
      BASE + 4_000,
    );

    const { status, body } = await getJSON(ctx.port, '/sessions?minAllowRate=0.6');
    expect(status).toBe(200);

    const b = body as { data: { sessionId: string }[] };
    expect(Array.isArray(b.data)).toBe(true);

    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain(sessA);
    expect(ids).not.toContain(sessB);
    expect(ids).not.toContain(sessC);
  });

  it('2. minAllowRate=0 returns all sessions', async () => {
    ctx = await setup();

    const BASE = 1_970_100_000_000;
    const sessA = 'sess-527b-A';
    const sessB = 'sess-527b-B';
    const agentId = 'agent-527b';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-527b', sessionId: sessA, timestamp: new Date(BASE) }),
      dec('allow', 0.1),
      BASE,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-527b', sessionId: sessB, timestamp: new Date(BASE + 1_000) }),
      dec('block', 0.9),
      BASE + 1_000,
    );

    const { status, body } = await getJSON(ctx.port, '/sessions?minAllowRate=0');
    expect(status).toBe(200);

    const b = body as { data: { sessionId: string }[] };
    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain(sessA);
    expect(ids).toContain(sessB);
  });

  it('3. minAllowRate=1.0 returns only fully-allowed sessions', async () => {
    ctx = await setup();

    const BASE = 1_970_200_000_000;
    const sessA = 'sess-527c-A'; // allowRate = 1.0
    const sessB = 'sess-527c-B'; // allowRate = 0.5
    const agentId = 'agent-527c';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-527c', sessionId: sessA, timestamp: new Date(BASE) }),
      dec('allow', 0.1),
      BASE,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-527c', sessionId: sessB, timestamp: new Date(BASE + 1_000) }),
      dec('allow', 0.1),
      BASE + 1_000,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-527c', sessionId: sessB, timestamp: new Date(BASE + 2_000) }),
      dec('block', 0.9),
      BASE + 2_000,
    );

    const { status, body } = await getJSON(ctx.port, '/sessions?minAllowRate=1.0');
    expect(status).toBe(200);

    const b = body as { data: { sessionId: string }[] };
    const ids = b.data.map(s => s.sessionId);
    expect(ids).toContain(sessA);
    expect(ids).not.toContain(sessB);
  });
});

// ── T528 — topSessionsByRisk in GET /agents/:agentId ─────────────────────────

describe('T528 — topSessionsByRisk in GET /agents/:agentId', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('4. topSessionsByRisk starts with the session that has the highest avgRisk', async () => {
    ctx = await setup();

    const BASE = 1_971_000_000_000;
    const agentId = 'agent-528';
    const sessX = 'session-X-528'; // avgRisk = (0.9 + 0.8) / 2 = 0.85
    const sessY = 'session-Y-528'; // avgRisk = (0.2 + 0.1) / 2 = 0.15

    // session-X: 2 ops with high risk
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-528', sessionId: sessX, timestamp: new Date(BASE) }),
      dec('block', 0.9),
      BASE,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-528', sessionId: sessX, timestamp: new Date(BASE + 1_000) }),
      dec('block', 0.8),
      BASE + 1_000,
    );

    // session-Y: 2 ops with low risk
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-528', sessionId: sessY, timestamp: new Date(BASE + 2_000) }),
      dec('allow', 0.2),
      BASE + 2_000,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-528', sessionId: sessY, timestamp: new Date(BASE + 3_000) }),
      dec('allow', 0.1),
      BASE + 3_000,
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as { topSessionsByRisk: { sessionId: string; avgRisk: number }[] };
    expect(Array.isArray(b.topSessionsByRisk)).toBe(true);
    expect(b.topSessionsByRisk.length).toBeGreaterThanOrEqual(2);

    // session-X must be first (highest avgRisk)
    expect(b.topSessionsByRisk[0]!.sessionId).toBe(sessX);
    expect(b.topSessionsByRisk[0]!.avgRisk).toBeCloseTo(0.85, 5);
  });

  it('5. topSessionsByRisk avgRisk values are correct for both sessions', async () => {
    ctx = await setup();

    const BASE = 1_971_100_000_000;
    const agentId = 'agent-528b';
    const sessX = 'session-X-528b';
    const sessY = 'session-Y-528b';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-528b', sessionId: sessX, timestamp: new Date(BASE) }),
      dec('block', 0.9),
      BASE,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-528b', sessionId: sessX, timestamp: new Date(BASE + 1_000) }),
      dec('block', 0.8),
      BASE + 1_000,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-528b', sessionId: sessY, timestamp: new Date(BASE + 2_000) }),
      dec('allow', 0.2),
      BASE + 2_000,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-528b', sessionId: sessY, timestamp: new Date(BASE + 3_000) }),
      dec('allow', 0.1),
      BASE + 3_000,
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as { topSessionsByRisk: { sessionId: string; avgRisk: number }[] };
    const entryX = b.topSessionsByRisk.find(s => s.sessionId === sessX);
    const entryY = b.topSessionsByRisk.find(s => s.sessionId === sessY);

    expect(entryX).toBeDefined();
    expect(entryY).toBeDefined();
    expect(entryX!.avgRisk).toBeCloseTo(0.85, 5);
    expect(entryY!.avgRisk).toBeCloseTo(0.15, 5);
  });

  it('6. topSessionsByRisk field is present and is an array', async () => {
    ctx = await setup();

    const BASE = 1_971_200_000_000;
    const agentId = 'agent-528c';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-528c', sessionId: 'sess-528c', timestamp: new Date(BASE) }),
      dec('allow', 0.3),
      BASE,
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('topSessionsByRisk' in b).toBe(true);
    expect(Array.isArray(b['topSessionsByRisk'])).toBe(true);
  });
});

// ── T530 — pendingTrend in GET /operations/summary ───────────────────────────

describe('T530 — pendingTrend in GET /operations/summary', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('7. pendingTrend === "rising" when most recent 10 ops all require_approval and previous 10 all allow', async () => {
    ctx = await setup();

    // Logs returned DESC by created_at.
    // logs[0..9]   = summLast10 (most recent)  — all require_approval
    // logs[10..19] = summPrev10 (older)         — all allow
    // summLast10PendingRate = 1.0, summPrev10PendingRate = 0.0 → diff > 0.05 → 'rising'

    const OLDER_BASE = 1_972_000_000_000;
    const NEWER_BASE = 1_973_000_000_000;

    // Previous 10 (older) — all allowed
    for (let i = 0; i < 10; i++) {
      const ts = OLDER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId: 'agent-530', tool: 'tool-530', sessionId: 'sess-530-old', timestamp: new Date(ts) }),
        dec('allow', 0.1),
        ts,
      );
    }

    // Last 10 (most recent) — all require_approval
    for (let i = 0; i < 10; i++) {
      const ts = NEWER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId: 'agent-530', tool: 'tool-530', sessionId: 'sess-530-new', timestamp: new Date(ts) }),
        dec('require_approval', 0.8),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { pendingTrend: string };
    expect(b.pendingTrend).toBe('rising');
  });

  it('8. pendingTrend === "falling" when most recent 10 all allow and previous 10 all require_approval', async () => {
    ctx = await setup();

    const OLDER_BASE = 1_972_100_000_000;
    const NEWER_BASE = 1_973_100_000_000;

    // Previous 10 (older) — all require_approval
    for (let i = 0; i < 10; i++) {
      const ts = OLDER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId: 'agent-530b', tool: 'tool-530b', sessionId: 'sess-530b-old', timestamp: new Date(ts) }),
        dec('require_approval', 0.8),
        ts,
      );
    }

    // Last 10 (most recent) — all allow
    for (let i = 0; i < 10; i++) {
      const ts = NEWER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId: 'agent-530b', tool: 'tool-530b', sessionId: 'sess-530b-new', timestamp: new Date(ts) }),
        dec('allow', 0.1),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { pendingTrend: string };
    expect(b.pendingTrend).toBe('falling');
  });

  it('9. pendingTrend field is present and is a string', async () => {
    ctx = await setup();

    const BASE = 1_972_200_000_000;
    await saveLog(
      ctx.store,
      makeOp({ agentId: 'agent-530c', tool: 'tool-530c', sessionId: 'sess-530c', timestamp: new Date(BASE) }),
      dec('allow', 0.1),
      BASE,
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('pendingTrend' in b).toBe(true);
    expect(typeof b['pendingTrend']).toBe('string');
  });

  it('10. pendingTrend === "stable" when fewer than 11 ops (no prev10 to compare)', async () => {
    ctx = await setup();

    const BASE = 1_972_300_000_000;
    // Only 5 ops — prev10 slice will be empty → 'stable'
    for (let i = 0; i < 5; i++) {
      const ts = BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId: 'agent-530d', tool: 'tool-530d', sessionId: 'sess-530d', timestamp: new Date(ts) }),
        dec('require_approval', 0.8),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { pendingTrend: string };
    expect(b.pendingTrend).toBe('stable');
  });
});

// ── T531 — minAllowRate filter in GET /agents ─────────────────────────────────

describe('T531 — minAllowRate filter in GET /agents', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('11. only agents with allowRate >= minAllowRate are returned', async () => {
    ctx = await setup();

    const BASE = 1_973_000_000_000;
    const agentA = 'agent-531-A'; // allowRate = 0.9 (9 allowed + 1 blocked)
    const agentB = 'agent-531-B'; // allowRate = 0.1 (1 allowed + 9 blocked)

    // agent-A: 9 allowed + 1 blocked
    for (let i = 0; i < 9; i++) {
      const ts = BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId: agentA, tool: 'tool-531', sessionId: 'sess-531-A', timestamp: new Date(ts) }),
        dec('allow', 0.1),
        ts,
      );
    }
    await saveLog(
      ctx.store,
      makeOp({ agentId: agentA, tool: 'tool-531', sessionId: 'sess-531-A', timestamp: new Date(BASE + 9_000) }),
      dec('block', 0.9),
      BASE + 9_000,
    );

    // agent-B: 1 allowed + 9 blocked
    await saveLog(
      ctx.store,
      makeOp({ agentId: agentB, tool: 'tool-531', sessionId: 'sess-531-B', timestamp: new Date(BASE + 10_000) }),
      dec('allow', 0.1),
      BASE + 10_000,
    );
    for (let i = 0; i < 9; i++) {
      const ts = BASE + 11_000 + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId: agentB, tool: 'tool-531', sessionId: 'sess-531-B', timestamp: new Date(ts) }),
        dec('block', 0.9),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, '/agents?minAllowRate=0.5');
    expect(status).toBe(200);

    const b = body as { agents: { agentId: string }[] };
    expect(Array.isArray(b.agents)).toBe(true);

    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain(agentA);
    expect(ids).not.toContain(agentB);
  });

  it('12. minAllowRate=0 returns all agents', async () => {
    ctx = await setup();

    const BASE = 1_973_100_000_000;
    const agentA = 'agent-531b-A';
    const agentB = 'agent-531b-B';

    await saveLog(
      ctx.store,
      makeOp({ agentId: agentA, tool: 'tool-531b', sessionId: 'sess-531b-A', timestamp: new Date(BASE) }),
      dec('allow', 0.1),
      BASE,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId: agentB, tool: 'tool-531b', sessionId: 'sess-531b-B', timestamp: new Date(BASE + 1_000) }),
      dec('block', 0.9),
      BASE + 1_000,
    );

    const { status, body } = await getJSON(ctx.port, '/agents?minAllowRate=0');
    expect(status).toBe(200);

    const b = body as { agents: { agentId: string }[] };
    const ids = b.agents.map(a => a.agentId);
    expect(ids).toContain(agentA);
    expect(ids).toContain(agentB);
  });

  it('13. allowRate field is present and numeric in agent list entries', async () => {
    ctx = await setup();

    const BASE = 1_973_200_000_000;
    const agentA = 'agent-531c-A';

    for (let i = 0; i < 9; i++) {
      const ts = BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId: agentA, tool: 'tool-531c', sessionId: 'sess-531c-A', timestamp: new Date(ts) }),
        dec('allow', 0.1),
        ts,
      );
    }
    await saveLog(
      ctx.store,
      makeOp({ agentId: agentA, tool: 'tool-531c', sessionId: 'sess-531c-A', timestamp: new Date(BASE + 9_000) }),
      dec('block', 0.9),
      BASE + 9_000,
    );

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);

    const b = body as { agents: { agentId: string; allowRate: number }[] };
    const entry = b.agents.find(a => a.agentId === agentA);
    expect(entry).toBeDefined();
    expect(typeof entry!.allowRate).toBe('number');
    expect(entry!.allowRate).toBeCloseTo(0.9, 5);
  });
});

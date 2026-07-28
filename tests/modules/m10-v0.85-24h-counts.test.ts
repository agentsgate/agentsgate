/**
 * v0.85 tests — avgRiskLast24h in GET /tools/:tool and GET /sessions/:sessionId,
 * opsLast24h in GET /agents/:agentId and GET /operations/summary,
 * and sort=pendingCount in GET /sessions.
 *
 * T542 — avgRiskLast24h in GET /tools/:tool
 *   Tool with 1 recent op (timestamp = Date.now()) at riskScore=0.6 → avgRiskLast24h ≈ 0.6
 *   Tool with only an old op (timestamp = now - 48h) → avgRiskLast24h === null
 *
 * T543 — avgRiskLast24h in GET /sessions/:sessionId
 *   Session with 1 recent op at riskScore=0.7 → avgRiskLast24h ≈ 0.7
 *   Session with only old ops → avgRiskLast24h === null
 *
 * T544/T545 — opsLast24h in GET /agents/:agentId and GET /operations/summary
 *   Agent with 2 recent ops and 1 old op → opsLast24h === 2 in agent detail
 *   GET /operations/summary → opsLast24h === 2 (only this agent's data)
 *
 * T546 — sort=pendingCount in GET /sessions
 *   sessionA: 2 pending, sessionB: 0 pending, sessionC: 1 pending
 *   Query GET /sessions?sort=pendingCount&order=desc → order: A, C, B
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

// ── T542 — avgRiskLast24h in GET /tools/:tool ─────────────────────────────────

describe('T542 — avgRiskLast24h in GET /tools/:tool', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. avgRiskLast24h ≈ 0.6 when tool has 1 recent op at riskScore=0.6', async () => {
    ctx = await setup();

    const now = Date.now();
    const tool = 'tool-542-recent';
    const agentId = 'agent-542-recent';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool, sessionId: 'sess-542-recent', timestamp: new Date(now) }),
      dec('allow', 0.6),
      now,
    );

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);

    const b = body as { avgRiskLast24h: number | null };
    expect(b.avgRiskLast24h).not.toBeNull();
    expect(b.avgRiskLast24h).toBeCloseTo(0.6, 5);
  });

  it('2. avgRiskLast24h === null when tool has only an old op (timestamp = now - 48h)', async () => {
    ctx = await setup();

    const oldTs = Date.now() - 48 * 60 * 60 * 1000;
    const tool = 'tool-542-old';
    const agentId = 'agent-542-old';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool, sessionId: 'sess-542-old', timestamp: new Date(oldTs) }),
      dec('allow', 0.6),
      oldTs,
    );

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);

    const b = body as { avgRiskLast24h: number | null };
    expect(b.avgRiskLast24h).toBeNull();
  });

  it('3. avgRiskLast24h field is present in GET /tools/:tool response', async () => {
    ctx = await setup();

    const now = Date.now();
    const tool = 'tool-542-field';
    const agentId = 'agent-542-field';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool, sessionId: 'sess-542-field', timestamp: new Date(now) }),
      dec('allow', 0.3),
      now,
    );

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('avgRiskLast24h' in b).toBe(true);
  });
});

// ── T543 — avgRiskLast24h in GET /sessions/:sessionId ─────────────────────────

describe('T543 — avgRiskLast24h in GET /sessions/:sessionId', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('4. avgRiskLast24h ≈ 0.7 when session has 1 recent op at riskScore=0.7', async () => {
    ctx = await setup();

    const now = Date.now();
    const sessionId = 'sess-543-recent';
    const agentId = 'agent-543-recent';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-543', sessionId, timestamp: new Date(now) }),
      dec('allow', 0.7),
      now,
    );

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);

    const b = body as { avgRiskLast24h: number | null };
    expect(b.avgRiskLast24h).not.toBeNull();
    expect(b.avgRiskLast24h).toBeCloseTo(0.7, 5);
  });

  it('5. avgRiskLast24h === null when session has only old ops (timestamp = now - 48h)', async () => {
    ctx = await setup();

    const oldTs = Date.now() - 48 * 60 * 60 * 1000;
    const sessionId = 'sess-543-old';
    const agentId = 'agent-543-old';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-543b', sessionId, timestamp: new Date(oldTs) }),
      dec('allow', 0.7),
      oldTs,
    );

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);

    const b = body as { avgRiskLast24h: number | null };
    expect(b.avgRiskLast24h).toBeNull();
  });

  it('6. avgRiskLast24h field is present in GET /sessions/:sessionId response', async () => {
    ctx = await setup();

    const now = Date.now();
    const sessionId = 'sess-543-field';
    const agentId = 'agent-543-field';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-543c', sessionId, timestamp: new Date(now) }),
      dec('allow', 0.4),
      now,
    );

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('avgRiskLast24h' in b).toBe(true);
  });
});

// ── T544 — opsLast24h in GET /agents/:agentId ─────────────────────────────────

describe('T544 — opsLast24h in GET /agents/:agentId', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('7. opsLast24h === 2 when agent has 2 recent ops and 1 old op (48h ago)', async () => {
    ctx = await setup();

    const now = Date.now();
    const oldTs = now - 48 * 60 * 60 * 1000;
    const agentId = 'agent-544-counts';

    // 2 recent ops
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-544', sessionId: 'sess-544', timestamp: new Date(now) }),
      dec('allow', 0.3),
      now,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-544', sessionId: 'sess-544', timestamp: new Date(now - 1000) }),
      dec('allow', 0.4),
      now - 1000,
    );

    // 1 old op
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-544', sessionId: 'sess-544-old', timestamp: new Date(oldTs) }),
      dec('allow', 0.5),
      oldTs,
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as { opsLast24h: number };
    expect(b.opsLast24h).toBe(2);
  });

  it('8. opsLast24h === 0 when agent has only old ops (48h ago)', async () => {
    ctx = await setup();

    const oldTs = Date.now() - 48 * 60 * 60 * 1000;
    const agentId = 'agent-544-allold';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-544b', sessionId: 'sess-544b', timestamp: new Date(oldTs) }),
      dec('allow', 0.5),
      oldTs,
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as { opsLast24h: number };
    expect(b.opsLast24h).toBe(0);
  });

  it('9. opsLast24h field is present in GET /agents/:agentId response', async () => {
    ctx = await setup();

    const now = Date.now();
    const agentId = 'agent-544-field';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-544c', sessionId: 'sess-544c', timestamp: new Date(now) }),
      dec('allow', 0.2),
      now,
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('opsLast24h' in b).toBe(true);
  });
});

// ── T545 — opsLast24h in GET /operations/summary ──────────────────────────────

describe('T545 — opsLast24h in GET /operations/summary', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('10. opsLast24h === 2 in summary when there are 2 recent ops and 1 old op', async () => {
    ctx = await setup();

    const now = Date.now();
    const oldTs = now - 48 * 60 * 60 * 1000;
    const agentId = 'agent-545-summary';

    // 2 recent ops
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-545', sessionId: 'sess-545', timestamp: new Date(now) }),
      dec('allow', 0.3),
      now,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-545', sessionId: 'sess-545', timestamp: new Date(now - 1000) }),
      dec('allow', 0.4),
      now - 1000,
    );

    // 1 old op
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-545', sessionId: 'sess-545-old', timestamp: new Date(oldTs) }),
      dec('allow', 0.5),
      oldTs,
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { opsLast24h: number };
    expect(b.opsLast24h).toBe(2);
  });

  it('11. opsLast24h field is present in GET /operations/summary response', async () => {
    ctx = await setup();

    const now = Date.now();
    const agentId = 'agent-545-field';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-545b', sessionId: 'sess-545b', timestamp: new Date(now) }),
      dec('allow', 0.2),
      now,
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('opsLast24h' in b).toBe(true);
  });
});

// ── T546 — sort=pendingCount in GET /sessions ──────────────────────────────────

describe('T546 — sort=pendingCount in GET /sessions', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('12. GET /sessions?sort=pendingCount&order=desc returns sessionA, sessionC, sessionB in order', async () => {
    ctx = await setup();

    const BASE = 1_990_000_000_000;
    const agentId = 'agent-546-sort';
    const sessA = 'sess-546-A'; // 2 pending ops
    const sessB = 'sess-546-B'; // 0 pending ops
    const sessC = 'sess-546-C'; // 1 pending op

    // sessionA — 2 require_approval ops
    for (let i = 0; i < 2; i++) {
      const ts = BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-546', sessionId: sessA, timestamp: new Date(ts) }),
        dec('require_approval', 0.8),
        ts,
      );
    }

    // sessionB — 2 allow ops, 0 pending
    for (let i = 0; i < 2; i++) {
      const ts = BASE + 10_000 + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-546', sessionId: sessB, timestamp: new Date(ts) }),
        dec('allow', 0.1),
        ts,
      );
    }

    // sessionC — 1 require_approval op + 1 allow op
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-546', sessionId: sessC, timestamp: new Date(BASE + 20_000) }),
      dec('require_approval', 0.7),
      BASE + 20_000,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-546', sessionId: sessC, timestamp: new Date(BASE + 21_000) }),
      dec('allow', 0.2),
      BASE + 21_000,
    );

    const { status, body } = await getJSON(ctx.port, '/sessions?sort=pendingCount&order=desc');
    expect(status).toBe(200);

    const b = body as { data: { sessionId: string }[] };
    expect(Array.isArray(b.data)).toBe(true);

    const sessionIds = b.data.map(s => s.sessionId);

    // All three sessions must appear
    expect(sessionIds).toContain(sessA);
    expect(sessionIds).toContain(sessB);
    expect(sessionIds).toContain(sessC);

    // Verify ordering: sessionA (2 pending) before sessionC (1 pending) before sessionB (0 pending)
    const idxA = sessionIds.indexOf(sessA);
    const idxC = sessionIds.indexOf(sessC);
    const idxB = sessionIds.indexOf(sessB);

    expect(idxA).toBeLessThan(idxC);
    expect(idxC).toBeLessThan(idxB);
  });

  it('13. sessions have requireApproval / pendingCount field reflecting pending op count', async () => {
    ctx = await setup();

    const BASE = 1_990_100_000_000;
    const agentId = 'agent-546-field';
    const sessA = 'sess-546f-A'; // 2 pending

    for (let i = 0; i < 2; i++) {
      const ts = BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-546f', sessionId: sessA, timestamp: new Date(ts) }),
        dec('require_approval', 0.8),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);

    const b = body as { data: Record<string, unknown>[] };
    const entry = b.data.find(s => s['sessionId'] === sessA);
    expect(entry).toBeDefined();

    // The session entry should expose either requireApproval or pendingCount with value 2
    const pendingVal = entry!['pendingCount'] ?? entry!['requireApproval'];
    expect(pendingVal).toBe(2);
  });

  it('14. sort=pendingCount asc returns sessionB before sessionC before sessionA', async () => {
    ctx = await setup();

    const BASE = 1_990_200_000_000;
    const agentId = 'agent-546-asc';
    const sessA = 'sess-546asc-A'; // 2 pending
    const sessB = 'sess-546asc-B'; // 0 pending
    const sessC = 'sess-546asc-C'; // 1 pending

    // sessionA — 2 require_approval ops
    for (let i = 0; i < 2; i++) {
      const ts = BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-546asc', sessionId: sessA, timestamp: new Date(ts) }),
        dec('require_approval', 0.8),
        ts,
      );
    }

    // sessionB — 1 allow op, 0 pending
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-546asc', sessionId: sessB, timestamp: new Date(BASE + 10_000) }),
      dec('allow', 0.1),
      BASE + 10_000,
    );

    // sessionC — 1 require_approval op
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-546asc', sessionId: sessC, timestamp: new Date(BASE + 20_000) }),
      dec('require_approval', 0.7),
      BASE + 20_000,
    );

    const { status, body } = await getJSON(ctx.port, '/sessions?sort=pendingCount&order=asc');
    expect(status).toBe(200);

    const b = body as { data: { sessionId: string }[] };
    const sessionIds = b.data.map(s => s.sessionId);

    const idxA = sessionIds.indexOf(sessA);
    const idxB = sessionIds.indexOf(sessB);
    const idxC = sessionIds.indexOf(sessC);

    // Ascending: B (0) before C (1) before A (2)
    expect(idxB).toBeLessThan(idxC);
    expect(idxC).toBeLessThan(idxA);
  });
});

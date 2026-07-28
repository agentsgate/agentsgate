/**
 * v0.84 tests — blockRateTrend in GET /tools/:tool, avgRiskLast24h in GET /agents/:agentId,
 * minPendingRate filter in GET /sessions, and riskTrend in GET /sessions/:sessionId.
 *
 * T537 — blockRateTrend in GET /tools/:tool
 *   Tool with 20 ops:
 *     first 10 (most recent, highest timestamps) all blocked → blockRate = 1.0 for last10
 *     previous 10 (older, lower timestamps) all allowed → blockRate = 0.0 for prev10
 *     diff > 0.05 → blockRateTrend === 'rising'
 *
 * T538 — avgRiskLast24h in GET /agents/:agentId
 *   Agent with 1 recent op (timestamp = now) at riskScore=0.8 → avgRiskLast24h === 0.8
 *   Agent with only an old op (timestamp = 3 days ago) → avgRiskLast24h === null
 *
 * T540 — minPendingRate filter in GET /sessions
 *   sessionA: 2 require_approval + 1 allow → pendingRate ≈ 0.67
 *   sessionB: 0 pending + 2 allowed → pendingRate = 0
 *   Query GET /sessions?minPendingRate=0.5 → only sessionA returned
 *
 * T541 — riskTrend in GET /sessions/:sessionId
 *   Session with 20 ops:
 *     first 10 (most recent) at riskScore=0.9 → last10Avg = 0.9
 *     previous 10 at riskScore=0.1 → prev10Avg = 0.1
 *     diff = 0.8 > 0.05 → riskTrend === 'rising'
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

// ── T537 — blockRateTrend in GET /tools/:tool ─────────────────────────────────

describe('T537 — blockRateTrend in GET /tools/:tool', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. blockRateTrend === "rising" when most recent 10 ops all blocked and previous 10 all allowed', async () => {
    ctx = await setup();

    // Logs ordered DESC by created_at (most recent first).
    // logs[0..9]  = last10  (most recent) — all blocked  → blockRate = 1.0
    // logs[10..19] = prev10 (older)       — all allowed  → blockRate = 0.0
    // diff = 1.0 - 0.0 = 1.0 > 0.05 → 'rising'

    const OLDER_BASE = 1_985_000_000_000;
    const NEWER_BASE = 1_986_000_000_000;
    const agentId = 'agent-537-rising';
    const tool = 'tool-537-rising';

    // Previous 10 (older) — all allowed
    for (let i = 0; i < 10; i++) {
      const ts = OLDER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool, sessionId: 'sess-537-old', timestamp: new Date(ts) }),
        dec('allow', 0.1),
        ts,
      );
    }

    // Last 10 (most recent) — all blocked
    for (let i = 0; i < 10; i++) {
      const ts = NEWER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool, sessionId: 'sess-537-new', timestamp: new Date(ts) }),
        dec('block', 0.9),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);

    const b = body as { blockRateTrend: string };
    expect(b.blockRateTrend).toBe('rising');
  });

  it('2. blockRateTrend field is present and is a string', async () => {
    ctx = await setup();

    const BASE = 1_985_100_000_000;
    const agentId = 'agent-537-field';
    const tool = 'tool-537-field';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool, sessionId: 'sess-537-field', timestamp: new Date(BASE) }),
      dec('allow', 0.2),
      BASE,
    );

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('blockRateTrend' in b).toBe(true);
    expect(typeof b['blockRateTrend']).toBe('string');
  });

  it('3. blockRateTrend === "stable" when tool has only 5 ops (prev10 is empty)', async () => {
    ctx = await setup();

    const BASE = 1_985_200_000_000;
    const agentId = 'agent-537-stable';
    const tool = 'tool-537-stable';

    for (let i = 0; i < 5; i++) {
      const ts = BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool, sessionId: 'sess-537-stable', timestamp: new Date(ts) }),
        dec('block', 0.9),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);

    const b = body as { blockRateTrend: string };
    expect(b.blockRateTrend).toBe('stable');
  });
});

// ── T538 — avgRiskLast24h in GET /agents/:agentId ────────────────────────────

describe('T538 — avgRiskLast24h in GET /agents/:agentId', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('4. avgRiskLast24h === 0.8 when agent has 1 recent op (timestamp = now) at riskScore=0.8', async () => {
    ctx = await setup();

    const now = Date.now();
    const agentId = 'agent-538-recent';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-538', sessionId: 'sess-538-recent', timestamp: new Date(now) }),
      dec('allow', 0.8),
      now,
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as { avgRiskLast24h: number | null };
    expect(b.avgRiskLast24h).not.toBeNull();
    expect(b.avgRiskLast24h).toBeCloseTo(0.8, 5);
  });

  it('5. avgRiskLast24h === null when agent has only an old op (timestamp = 3 days ago)', async () => {
    ctx = await setup();

    const oldTs = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const agentId = 'agent-538-old';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-538b', sessionId: 'sess-538-old', timestamp: new Date(oldTs) }),
      dec('allow', 0.8),
      oldTs,
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as { avgRiskLast24h: number | null };
    expect(b.avgRiskLast24h).toBeNull();
  });

  it('6. avgRiskLast24h field is present in the response', async () => {
    ctx = await setup();

    const now = Date.now();
    const agentId = 'agent-538-field';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-538c', sessionId: 'sess-538c', timestamp: new Date(now) }),
      dec('allow', 0.3),
      now,
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('avgRiskLast24h' in b).toBe(true);
  });
});

// ── T540 — minPendingRate filter in GET /sessions ────────────────────────────

describe('T540 — minPendingRate filter in GET /sessions', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('7. only sessionA (pendingRate≈0.67) returned when minPendingRate=0.5; sessionB (pendingRate=0) excluded', async () => {
    ctx = await setup();

    const BASE = 1_987_000_000_000;
    const agentId = 'agent-540';
    const sessA = 'sess-540-A'; // 2 require_approval + 1 allow → pendingRate ≈ 0.667
    const sessB = 'sess-540-B'; // 0 pending + 2 allowed → pendingRate = 0

    // sessionA — 2 require_approval ops
    for (let i = 0; i < 2; i++) {
      const ts = BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-540', sessionId: sessA, timestamp: new Date(ts) }),
        dec('require_approval', 0.7),
        ts,
      );
    }
    // sessionA — 1 allow op
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-540', sessionId: sessA, timestamp: new Date(BASE + 2_000) }),
      dec('allow', 0.2),
      BASE + 2_000,
    );

    // sessionB — 2 allowed ops, 0 pending
    for (let i = 0; i < 2; i++) {
      const ts = BASE + 10_000 + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-540', sessionId: sessB, timestamp: new Date(ts) }),
        dec('allow', 0.1),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, '/sessions?minPendingRate=0.5');
    expect(status).toBe(200);

    const b = body as { data: { sessionId: string }[]; count: number };
    expect(Array.isArray(b.data)).toBe(true);

    const sessionIds = b.data.map(s => s.sessionId);
    expect(sessionIds).toContain(sessA);
    expect(sessionIds).not.toContain(sessB);
  });

  it('8. minPendingRate=0 returns all sessions', async () => {
    ctx = await setup();

    const BASE = 1_987_100_000_000;
    const agentId = 'agent-540b';
    const sessA = 'sess-540b-A';
    const sessB = 'sess-540b-B';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-540b', sessionId: sessA, timestamp: new Date(BASE) }),
      dec('require_approval', 0.7),
      BASE,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-540b', sessionId: sessB, timestamp: new Date(BASE + 1_000) }),
      dec('allow', 0.1),
      BASE + 1_000,
    );

    const { status, body } = await getJSON(ctx.port, '/sessions?minPendingRate=0');
    expect(status).toBe(200);

    const b = body as { data: { sessionId: string }[] };
    const sessionIds = b.data.map(s => s.sessionId);
    expect(sessionIds).toContain(sessA);
    expect(sessionIds).toContain(sessB);
  });

  it('9. pendingRate field is present and correctly computed on each session entry', async () => {
    ctx = await setup();

    const BASE = 1_987_200_000_000;
    const agentId = 'agent-540c';
    const sessA = 'sess-540c-A'; // 1 require_approval + 1 allow → pendingRate = 0.5

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-540c', sessionId: sessA, timestamp: new Date(BASE) }),
      dec('require_approval', 0.7),
      BASE,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-540c', sessionId: sessA, timestamp: new Date(BASE + 1_000) }),
      dec('allow', 0.1),
      BASE + 1_000,
    );

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);

    const b = body as { data: { sessionId: string; pendingRate: number }[] };
    const entry = b.data.find(s => s.sessionId === sessA);
    expect(entry).toBeDefined();
    expect(typeof entry!.pendingRate).toBe('number');
    expect(entry!.pendingRate).toBeCloseTo(0.5, 5);
  });
});

// ── T541 — riskTrend in GET /sessions/:sessionId ──────────────────────────────

describe('T541 — riskTrend in GET /sessions/:sessionId', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('10. riskTrend === "rising" when most recent 10 ops at riskScore=0.9 and previous 10 at riskScore=0.1', async () => {
    ctx = await setup();

    // Logs ordered DESC by created_at (most recent first).
    // last10  (most recent) at riskScore=0.9 → last10Avg = 0.9
    // prev10  (older)       at riskScore=0.1 → prev10Avg = 0.1
    // diff = 0.8 > 0.05 → 'rising'

    const OLDER_BASE = 1_988_000_000_000;
    const NEWER_BASE = 1_989_000_000_000;
    const agentId = 'agent-541-rising';
    const sessionId = 'sess-541-rising';

    // Previous 10 (older) — riskScore=0.1
    for (let i = 0; i < 10; i++) {
      const ts = OLDER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-541', sessionId, timestamp: new Date(ts) }),
        dec('allow', 0.1),
        ts,
      );
    }

    // Last 10 (most recent) — riskScore=0.9
    for (let i = 0; i < 10; i++) {
      const ts = NEWER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-541', sessionId, timestamp: new Date(ts) }),
        dec('block', 0.9),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);

    const b = body as { riskTrend: string };
    expect(b.riskTrend).toBe('rising');
  });

  it('11. riskTrend === "stable" when session has only 5 ops (prev10 is empty)', async () => {
    ctx = await setup();

    const BASE = 1_988_100_000_000;
    const agentId = 'agent-541-stable';
    const sessionId = 'sess-541-stable';

    for (let i = 0; i < 5; i++) {
      const ts = BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-541b', sessionId, timestamp: new Date(ts) }),
        dec('allow', 0.5),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);

    const b = body as { riskTrend: string };
    expect(b.riskTrend).toBe('stable');
  });

  it('12. riskTrend field is present and is a string', async () => {
    ctx = await setup();

    const BASE = 1_988_200_000_000;
    const agentId = 'agent-541-field';
    const sessionId = 'sess-541-field';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-541c', sessionId, timestamp: new Date(BASE) }),
      dec('allow', 0.3),
      BASE,
    );

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('riskTrend' in b).toBe(true);
    expect(typeof b['riskTrend']).toBe('string');
  });

  it('13. riskTrend === "falling" when most recent 10 at riskScore=0.1 and previous 10 at riskScore=0.9', async () => {
    ctx = await setup();

    const OLDER_BASE = 1_988_300_000_000;
    const NEWER_BASE = 1_989_300_000_000;
    const agentId = 'agent-541-falling';
    const sessionId = 'sess-541-falling';

    // Previous 10 (older) — riskScore=0.9
    for (let i = 0; i < 10; i++) {
      const ts = OLDER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-541d', sessionId, timestamp: new Date(ts) }),
        dec('block', 0.9),
        ts,
      );
    }

    // Last 10 (most recent) — riskScore=0.1
    for (let i = 0; i < 10; i++) {
      const ts = NEWER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-541d', sessionId, timestamp: new Date(ts) }),
        dec('allow', 0.1),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);

    const b = body as { riskTrend: string };
    expect(b.riskTrend).toBe('falling');
  });
});

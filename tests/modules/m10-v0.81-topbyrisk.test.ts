/**
 * v0.81 tests — topToolsByRisk, topAgentsByRisk, allowTrend, allowCount/blockCount
 *
 * T522 — topToolsByRisk in GET /agents/:agentId
 *   Agent with 2 ops on tool-A (riskScores 0.9, 0.8) and 1 op on tool-B (riskScore 0.1).
 *   Expect topToolsByRisk = [{tool:'tool-A', avgRisk:0.85}, {tool:'tool-B', avgRisk:0.1}]
 *   sorted descending by avgRisk.
 *
 * T523 — topAgentsByRisk in GET /tools/:tool
 *   Tool used by agent-X (riskScore 0.9) and agent-Y (riskScore 0.2).
 *   Expect topAgentsByRisk[0].agentId === 'agent-X' (highest avgRisk first).
 *
 * T524 — allowTrend in GET /operations/summary
 *   20 ops: first 10 (most recent, stored with higher timestamps) all 'allow',
 *   previous 10 (older, lower timestamps) all 'block'.
 *   Logs are returned DESC by created_at, so logs[0..9] are the most recent (all allow),
 *   logs[10..19] are the older ones (all block).
 *   summLast10AllowRate = 1.0, summPrev10AllowRate = 0.0 → diff > 0.05 → 'rising'.
 *
 * T526 — allowCount/blockCount in GET /sessions/:sessionId
 *   Session with 2 allowed + 1 blocked.
 *   Expect allowCount === 2 and blockCount === 1.
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

// ── T522 — topToolsByRisk in GET /agents/:agentId ─────────────────────────────

describe('T522 — topToolsByRisk in GET /agents/:agentId', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. topToolsByRisk is sorted descending by avgRisk with correct values', async () => {
    ctx = await setup();

    const BASE = 1_960_000_000_000;
    const agentId = 'agent-522';
    const toolA = 'tool-522-A';
    const toolB = 'tool-522-B';

    // tool-A: 2 ops with riskScores 0.9 and 0.8 → avgRisk = 0.85
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: toolA, sessionId: 'sess-522', timestamp: new Date(BASE) }),
      dec('allow', 0.9),
      BASE,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: toolA, sessionId: 'sess-522', timestamp: new Date(BASE + 1_000) }),
      dec('allow', 0.8),
      BASE + 1_000,
    );

    // tool-B: 1 op with riskScore 0.1 → avgRisk = 0.1
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: toolB, sessionId: 'sess-522', timestamp: new Date(BASE + 2_000) }),
      dec('allow', 0.1),
      BASE + 2_000,
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as { topToolsByRisk: { tool: string; avgRisk: number }[] };
    expect(Array.isArray(b.topToolsByRisk)).toBe(true);
    expect(b.topToolsByRisk.length).toBeGreaterThanOrEqual(2);

    const entryA = b.topToolsByRisk.find(t => t.tool === toolA);
    const entryB = b.topToolsByRisk.find(t => t.tool === toolB);

    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
    expect(entryA!.avgRisk).toBeCloseTo(0.85, 5);
    expect(entryB!.avgRisk).toBeCloseTo(0.1, 5);

    // tool-A (avgRisk=0.85) must appear before tool-B (avgRisk=0.1)
    const idxA = b.topToolsByRisk.findIndex(t => t.tool === toolA);
    const idxB = b.topToolsByRisk.findIndex(t => t.tool === toolB);
    expect(idxA).toBeLessThan(idxB);
  });

  it('2. topToolsByRisk field is present and is an array', async () => {
    ctx = await setup();

    const BASE = 1_960_100_000_000;
    const agentId = 'agent-522-p';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-522-p', sessionId: 'sess-522-p', timestamp: new Date(BASE) }),
      dec('allow', 0.5),
      BASE,
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('topToolsByRisk' in b).toBe(true);
    expect(Array.isArray(b['topToolsByRisk'])).toBe(true);
  });

  it('3. topToolsByRisk first entry has the highest avgRisk', async () => {
    ctx = await setup();

    const BASE = 1_960_200_000_000;
    const agentId = 'agent-522-order';
    const toolA = 'tool-522-order-A';
    const toolB = 'tool-522-order-B';

    // tool-A: avgRisk = (0.9 + 0.8) / 2 = 0.85
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: toolA, sessionId: 'sess-522-order', timestamp: new Date(BASE) }),
      dec('block', 0.9),
      BASE,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: toolA, sessionId: 'sess-522-order', timestamp: new Date(BASE + 1_000) }),
      dec('block', 0.8),
      BASE + 1_000,
    );

    // tool-B: avgRisk = 0.1
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: toolB, sessionId: 'sess-522-order', timestamp: new Date(BASE + 2_000) }),
      dec('allow', 0.1),
      BASE + 2_000,
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as { topToolsByRisk: { tool: string; avgRisk: number }[] };
    expect(b.topToolsByRisk[0]!.tool).toBe(toolA);
  });
});

// ── T523 — topAgentsByRisk in GET /tools/:tool ────────────────────────────────

describe('T523 — topAgentsByRisk in GET /tools/:tool', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('4. topAgentsByRisk starts with the agent that has the highest avgRisk', async () => {
    ctx = await setup();

    const BASE = 1_961_000_000_000;
    const tool = 'tool-523';
    const agentX = 'agent-523-X';
    const agentY = 'agent-523-Y';

    // agent-X uses the tool once with riskScore 0.9
    await saveLog(
      ctx.store,
      makeOp({ agentId: agentX, tool, sessionId: 'sess-523-X', timestamp: new Date(BASE) }),
      dec('block', 0.9),
      BASE,
    );

    // agent-Y uses the tool once with riskScore 0.2
    await saveLog(
      ctx.store,
      makeOp({ agentId: agentY, tool, sessionId: 'sess-523-Y', timestamp: new Date(BASE + 1_000) }),
      dec('allow', 0.2),
      BASE + 1_000,
    );

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);

    const b = body as { topAgentsByRisk: { agentId: string; avgRisk: number }[] };
    expect(Array.isArray(b.topAgentsByRisk)).toBe(true);
    expect(b.topAgentsByRisk.length).toBeGreaterThanOrEqual(2);

    // agent-X (avgRisk=0.9) must be first
    expect(b.topAgentsByRisk[0]!.agentId).toBe(agentX);
  });

  it('5. topAgentsByRisk contains correct avgRisk values', async () => {
    ctx = await setup();

    const BASE = 1_961_100_000_000;
    const tool = 'tool-523-vals';
    const agentX = 'agent-523-vals-X';
    const agentY = 'agent-523-vals-Y';

    // agent-X: riskScore 0.9
    await saveLog(
      ctx.store,
      makeOp({ agentId: agentX, tool, sessionId: 'sess-523v-X', timestamp: new Date(BASE) }),
      dec('block', 0.9),
      BASE,
    );

    // agent-Y: riskScore 0.2
    await saveLog(
      ctx.store,
      makeOp({ agentId: agentY, tool, sessionId: 'sess-523v-Y', timestamp: new Date(BASE + 1_000) }),
      dec('allow', 0.2),
      BASE + 1_000,
    );

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);

    const b = body as { topAgentsByRisk: { agentId: string; avgRisk: number }[] };
    const entryX = b.topAgentsByRisk.find(a => a.agentId === agentX);
    const entryY = b.topAgentsByRisk.find(a => a.agentId === agentY);

    expect(entryX).toBeDefined();
    expect(entryY).toBeDefined();
    expect(entryX!.avgRisk).toBeCloseTo(0.9, 5);
    expect(entryY!.avgRisk).toBeCloseTo(0.2, 5);
  });

  it('6. topAgentsByRisk field is present and is an array', async () => {
    ctx = await setup();

    const BASE = 1_961_200_000_000;
    const tool = 'tool-523-presence';

    await saveLog(
      ctx.store,
      makeOp({ agentId: 'agent-523-pres', tool, sessionId: 'sess-523-pres', timestamp: new Date(BASE) }),
      dec('allow', 0.3),
      BASE,
    );

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('topAgentsByRisk' in b).toBe(true);
    expect(Array.isArray(b['topAgentsByRisk'])).toBe(true);
  });
});

// ── T524 — allowTrend in GET /operations/summary ─────────────────────────────

describe('T524 — allowTrend in GET /operations/summary', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('7. allowTrend === "rising" when most recent 10 ops all allowed and previous 10 all blocked', async () => {
    ctx = await setup();

    // Logs are returned DESC by created_at.
    // logs[0..9]  = summLast10  (most recent)
    // logs[10..19] = summPrev10  (older)
    //
    // We want:
    //   summLast10AllowRate  = 1.0 (all allow)
    //   summPrev10AllowRate  = 0.0 (all block)
    //   diff = 1.0 > 0.05 → 'rising'
    //
    // Use distinct timestamps: older 10 ops get lower timestamps (block),
    // newer 10 ops get higher timestamps (allow).

    const OLDER_BASE = 1_962_000_000_000;
    const NEWER_BASE = 1_963_000_000_000;

    // Previous 10 (older) — all blocked
    for (let i = 0; i < 10; i++) {
      const ts = OLDER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId: 'agent-524', tool: 'tool-524', sessionId: 'sess-524-old', timestamp: new Date(ts) }),
        dec('block', 0.9),
        ts,
      );
    }

    // Last 10 (most recent) — all allowed
    for (let i = 0; i < 10; i++) {
      const ts = NEWER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId: 'agent-524', tool: 'tool-524', sessionId: 'sess-524-new', timestamp: new Date(ts) }),
        dec('allow', 0.1),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { allowTrend: string };
    expect(b.allowTrend).toBe('rising');
  });

  it('8. allowTrend === "falling" when most recent 10 ops all blocked and previous 10 all allowed', async () => {
    ctx = await setup();

    const OLDER_BASE = 1_962_100_000_000;
    const NEWER_BASE = 1_963_100_000_000;

    // Previous 10 (older) — all allowed
    for (let i = 0; i < 10; i++) {
      const ts = OLDER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId: 'agent-524b', tool: 'tool-524b', sessionId: 'sess-524b-old', timestamp: new Date(ts) }),
        dec('allow', 0.1),
        ts,
      );
    }

    // Last 10 (most recent) — all blocked
    for (let i = 0; i < 10; i++) {
      const ts = NEWER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId: 'agent-524b', tool: 'tool-524b', sessionId: 'sess-524b-new', timestamp: new Date(ts) }),
        dec('block', 0.9),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { allowTrend: string };
    expect(b.allowTrend).toBe('falling');
  });

  it('9. allowTrend field is present in the summary response', async () => {
    ctx = await setup();

    const BASE = 1_962_200_000_000;
    await saveLog(
      ctx.store,
      makeOp({ agentId: 'agent-524-pres', tool: 'tool-524-pres', sessionId: 'sess-524-pres', timestamp: new Date(BASE) }),
      dec('allow', 0.2),
      BASE,
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('allowTrend' in b).toBe(true);
    expect(typeof b['allowTrend']).toBe('string');
  });

  it('10. allowTrend === "stable" when there are fewer than 11 ops (no prev10 to compare)', async () => {
    ctx = await setup();

    const BASE = 1_962_300_000_000;
    // Only 5 ops — prev10 slice will be empty → 'stable'
    for (let i = 0; i < 5; i++) {
      const ts = BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId: 'agent-524s', tool: 'tool-524s', sessionId: 'sess-524s', timestamp: new Date(ts) }),
        dec('allow', 0.1),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { allowTrend: string };
    expect(b.allowTrend).toBe('stable');
  });
});

// ── T526 — allowCount/blockCount in GET /sessions/:sessionId ─────────────────

describe('T526 — allowCount/blockCount in GET /sessions/:sessionId', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('11. allowCount === 2 and blockCount === 1 for session with 2 allowed and 1 blocked', async () => {
    ctx = await setup();

    const BASE = 1_963_000_000_000;
    const sessionId = 'sess-526-main';

    // 2 allowed ops
    await saveLog(
      ctx.store,
      makeOp({ agentId: 'agent-526', tool: 'tool-526', sessionId, timestamp: new Date(BASE) }),
      dec('allow', 0.2),
      BASE,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId: 'agent-526', tool: 'tool-526', sessionId, timestamp: new Date(BASE + 1_000) }),
      dec('allow', 0.3),
      BASE + 1_000,
    );

    // 1 blocked op
    await saveLog(
      ctx.store,
      makeOp({ agentId: 'agent-526', tool: 'tool-526', sessionId, timestamp: new Date(BASE + 2_000) }),
      dec('block', 0.9),
      BASE + 2_000,
    );

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);

    const b = body as { allowCount: number; blockCount: number };
    expect(b.allowCount).toBe(2);
    expect(b.blockCount).toBe(1);
  });

  it('12. allowCount and blockCount fields are present and numeric', async () => {
    ctx = await setup();

    const BASE = 1_963_100_000_000;
    const sessionId = 'sess-526-presence';

    await saveLog(
      ctx.store,
      makeOp({ agentId: 'agent-526p', tool: 'tool-526p', sessionId, timestamp: new Date(BASE) }),
      dec('allow', 0.1),
      BASE,
    );

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('allowCount' in b).toBe(true);
    expect('blockCount' in b).toBe(true);
    expect(typeof b['allowCount']).toBe('number');
    expect(typeof b['blockCount']).toBe('number');
  });

  it('13. allowCount === 0 and blockCount === 0 for session with only pending ops', async () => {
    ctx = await setup();

    const BASE = 1_963_200_000_000;
    const sessionId = 'sess-526-pending';

    // All require_approval — neither allowed nor blocked
    await saveLog(
      ctx.store,
      makeOp({ agentId: 'agent-526q', tool: 'tool-526q', sessionId, timestamp: new Date(BASE) }),
      dec('require_approval', 0.8),
      BASE,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId: 'agent-526q', tool: 'tool-526q', sessionId, timestamp: new Date(BASE + 1_000) }),
      dec('require_approval', 0.75),
      BASE + 1_000,
    );

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);

    const b = body as { allowCount: number; blockCount: number };
    expect(b.allowCount).toBe(0);
    expect(b.blockCount).toBe(0);
  });

  it('14. allowCount and blockCount match the allowed/blocked fields', async () => {
    ctx = await setup();

    const BASE = 1_963_300_000_000;
    const sessionId = 'sess-526-match';

    await saveLog(
      ctx.store,
      makeOp({ agentId: 'agent-526m', tool: 'tool-526m', sessionId, timestamp: new Date(BASE) }),
      dec('allow', 0.1),
      BASE,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId: 'agent-526m', tool: 'tool-526m', sessionId, timestamp: new Date(BASE + 1_000) }),
      dec('block', 0.85),
      BASE + 1_000,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId: 'agent-526m', tool: 'tool-526m', sessionId, timestamp: new Date(BASE + 2_000) }),
      dec('allow', 0.2),
      BASE + 2_000,
    );

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);

    const b = body as { allowed: number; blocked: number; allowCount: number; blockCount: number };
    // allowCount must equal the allowed field
    expect(b.allowCount).toBe(b.allowed);
    // blockCount must equal the blocked field
    expect(b.blockCount).toBe(b.blocked);
    // explicit values
    expect(b.allowCount).toBe(2);
    expect(b.blockCount).toBe(1);
  });
});

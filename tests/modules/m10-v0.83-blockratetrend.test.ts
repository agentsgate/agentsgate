/**
 * v0.83 tests — minAllowRate filter on GET /tools, blockRateTrend in GET /agents/:agentId,
 * and avgBlocksPerSession in GET /operations/summary.
 *
 * T532 — minAllowRate filter in GET /tools
 *   toolA: 3 allowed → allowRate=1.0
 *   toolB: 0 allowed + 2 blocked → allowRate=0.0
 *   Query GET /tools?minAllowRate=0.5 → only toolA returned (count === 1).
 *
 * T533 — blockRateTrend in GET /agents/:agentId
 *   Agent with 20 ops:
 *     first 10 (most recent, highest timestamps) all blocked → blockRate = 1.0 for last10
 *     previous 10 (older, lower timestamps) all allowed → blockRate = 0.0 for prev10
 *     diff > 0.05 → blockRateTrend === 'rising'
 *   Also: agent with only 5 ops → blockRateTrend === 'stable' (prev10 is empty).
 *
 * T536 — avgBlocksPerSession in GET /operations/summary
 *   2 sessions each with 2 blocks → totalBlocks=4, totalSessions=2 → avgBlocksPerSession === 2.
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

// ── T532 — minAllowRate filter in GET /tools ──────────────────────────────────

describe('T532 — minAllowRate filter in GET /tools', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. only toolA (allowRate=1.0) is returned when minAllowRate=0.5; toolB (allowRate=0.0) is excluded', async () => {
    ctx = await setup();

    const BASE = 1_980_000_000_000;
    const agentId = 'agent-532';
    const toolA = 'tool-532-A'; // 3 allowed → allowRate = 1.0
    const toolB = 'tool-532-B'; // 0 allowed + 2 blocked → allowRate = 0.0

    // toolA — 3 allowed ops
    for (let i = 0; i < 3; i++) {
      const ts = BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: toolA, sessionId: 'sess-532-A', timestamp: new Date(ts) }),
        dec('allow', 0.1),
        ts,
      );
    }

    // toolB — 2 blocked ops, 0 allowed
    for (let i = 0; i < 2; i++) {
      const ts = BASE + 10_000 + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: toolB, sessionId: 'sess-532-B', timestamp: new Date(ts) }),
        dec('block', 0.9),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, '/tools?minAllowRate=0.5');
    expect(status).toBe(200);

    const b = body as { tools: { tool: string }[]; count: number };
    expect(Array.isArray(b.tools)).toBe(true);

    // count reflects the filtered total
    expect(b.count).toBe(1);

    const toolNames = b.tools.map(t => t.tool);
    expect(toolNames).toContain(toolA);
    expect(toolNames).not.toContain(toolB);
  });

  it('2. minAllowRate=0 returns all tools', async () => {
    ctx = await setup();

    const BASE = 1_980_100_000_000;
    const agentId = 'agent-532b';
    const toolA = 'tool-532b-A';
    const toolB = 'tool-532b-B';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: toolA, sessionId: 'sess-532b-A', timestamp: new Date(BASE) }),
      dec('allow', 0.1),
      BASE,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: toolB, sessionId: 'sess-532b-B', timestamp: new Date(BASE + 1_000) }),
      dec('block', 0.9),
      BASE + 1_000,
    );

    const { status, body } = await getJSON(ctx.port, '/tools?minAllowRate=0');
    expect(status).toBe(200);

    const b = body as { tools: { tool: string }[]; count: number };
    const toolNames = b.tools.map(t => t.tool);
    expect(toolNames).toContain(toolA);
    expect(toolNames).toContain(toolB);
  });

  it('3. allowRate field is present and correctly computed on each tool entry', async () => {
    ctx = await setup();

    const BASE = 1_980_200_000_000;
    const agentId = 'agent-532c';
    const toolA = 'tool-532c-A'; // 3 allowed → allowRate = 1.0

    for (let i = 0; i < 3; i++) {
      const ts = BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: toolA, sessionId: 'sess-532c', timestamp: new Date(ts) }),
        dec('allow', 0.1),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);

    const b = body as { tools: { tool: string; allowRate: number }[] };
    const entry = b.tools.find(t => t.tool === toolA);
    expect(entry).toBeDefined();
    expect(typeof entry!.allowRate).toBe('number');
    expect(entry!.allowRate).toBeCloseTo(1.0, 5);
  });
});

// ── T533 — blockRateTrend in GET /agents/:agentId ────────────────────────────

describe('T533 — blockRateTrend in GET /agents/:agentId', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('4. blockRateTrend === "rising" when most recent 10 ops all blocked and previous 10 all allowed', async () => {
    ctx = await setup();

    // Logs are ordered DESC by created_at (most recent first).
    // logs[0..9]  = last10  (most recent) — all blocked  → blockRate = 1.0
    // logs[10..19] = prev10 (older)       — all allowed  → blockRate = 0.0
    // diff = 1.0 - 0.0 = 1.0 > 0.05 → 'rising'

    const OLDER_BASE = 1_981_000_000_000;
    const NEWER_BASE = 1_982_000_000_000;
    const agentId = 'agent-533-rising';

    // Previous 10 (older) — all allowed
    for (let i = 0; i < 10; i++) {
      const ts = OLDER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-533', sessionId: 'sess-533-old', timestamp: new Date(ts) }),
        dec('allow', 0.1),
        ts,
      );
    }

    // Last 10 (most recent) — all blocked
    for (let i = 0; i < 10; i++) {
      const ts = NEWER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-533', sessionId: 'sess-533-new', timestamp: new Date(ts) }),
        dec('block', 0.9),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as { blockRateTrend: string };
    expect(b.blockRateTrend).toBe('rising');
  });

  it('5. blockRateTrend === "stable" when agent has only 5 ops (not enough data for prev10 comparison)', async () => {
    ctx = await setup();

    const BASE = 1_981_100_000_000;
    const agentId = 'agent-533-stable';

    // Only 5 ops — prev10 slice is empty → 'stable'
    for (let i = 0; i < 5; i++) {
      const ts = BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-533b', sessionId: 'sess-533-stable', timestamp: new Date(ts) }),
        dec('block', 0.9),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as { blockRateTrend: string };
    expect(b.blockRateTrend).toBe('stable');
  });

  it('6. blockRateTrend === "falling" when most recent 10 all allowed and previous 10 all blocked', async () => {
    ctx = await setup();

    const OLDER_BASE = 1_981_200_000_000;
    const NEWER_BASE = 1_982_200_000_000;
    const agentId = 'agent-533-falling';

    // Previous 10 (older) — all blocked
    for (let i = 0; i < 10; i++) {
      const ts = OLDER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-533c', sessionId: 'sess-533-fall-old', timestamp: new Date(ts) }),
        dec('block', 0.9),
        ts,
      );
    }

    // Last 10 (most recent) — all allowed
    for (let i = 0; i < 10; i++) {
      const ts = NEWER_BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-533c', sessionId: 'sess-533-fall-new', timestamp: new Date(ts) }),
        dec('allow', 0.1),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as { blockRateTrend: string };
    expect(b.blockRateTrend).toBe('falling');
  });

  it('7. blockRateTrend field is present and is a string', async () => {
    ctx = await setup();

    const BASE = 1_981_300_000_000;
    const agentId = 'agent-533-field';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-533d', sessionId: 'sess-533d', timestamp: new Date(BASE) }),
      dec('allow', 0.3),
      BASE,
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('blockRateTrend' in b).toBe(true);
    expect(typeof b['blockRateTrend']).toBe('string');
  });
});

// ── T536 — avgBlocksPerSession in GET /operations/summary ────────────────────

describe('T536 — avgBlocksPerSession in GET /operations/summary', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('8. avgBlocksPerSession === 2 when 2 sessions each with 2 blocks (total 4 blocks / 2 sessions)', async () => {
    ctx = await setup();

    const BASE = 1_983_000_000_000;
    const agentId = 'agent-536';
    const sessA = 'sess-536-A'; // 2 blocks
    const sessB = 'sess-536-B'; // 2 blocks

    // session A — 2 blocked ops
    for (let i = 0; i < 2; i++) {
      const ts = BASE + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-536', sessionId: sessA, timestamp: new Date(ts) }),
        dec('block', 0.9),
        ts,
      );
    }

    // session B — 2 blocked ops
    for (let i = 0; i < 2; i++) {
      const ts = BASE + 10_000 + i * 1_000;
      await saveLog(
        ctx.store,
        makeOp({ agentId, tool: 'tool-536', sessionId: sessB, timestamp: new Date(ts) }),
        dec('block', 0.9),
        ts,
      );
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { avgBlocksPerSession: number };
    expect(b.avgBlocksPerSession).toBe(2);
  });

  it('9. avgBlocksPerSession === 0 when no ops are blocked', async () => {
    ctx = await setup();

    const BASE = 1_983_100_000_000;
    const agentId = 'agent-536b';

    // 2 allowed ops across 2 sessions — no blocks
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-536b', sessionId: 'sess-536b-A', timestamp: new Date(BASE) }),
      dec('allow', 0.1),
      BASE,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-536b', sessionId: 'sess-536b-B', timestamp: new Date(BASE + 1_000) }),
      dec('allow', 0.1),
      BASE + 1_000,
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { avgBlocksPerSession: number };
    expect(b.avgBlocksPerSession).toBe(0);
  });

  it('10. avgBlocksPerSession field is present and numeric', async () => {
    ctx = await setup();

    const BASE = 1_983_200_000_000;
    const agentId = 'agent-536c';

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-536c', sessionId: 'sess-536c', timestamp: new Date(BASE) }),
      dec('block', 0.9),
      BASE,
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('avgBlocksPerSession' in b).toBe(true);
    expect(typeof b['avgBlocksPerSession']).toBe('number');
  });

  it('11. avgBlocksPerSession rounds correctly for mixed sessions (3 blocks across 2 sessions = 1.5)', async () => {
    ctx = await setup();

    const BASE = 1_983_300_000_000;
    const agentId = 'agent-536d';
    const sessA = 'sess-536d-A'; // 2 blocks
    const sessB = 'sess-536d-B'; // 1 block

    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-536d', sessionId: sessA, timestamp: new Date(BASE) }),
      dec('block', 0.9),
      BASE,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-536d', sessionId: sessA, timestamp: new Date(BASE + 1_000) }),
      dec('block', 0.9),
      BASE + 1_000,
    );
    await saveLog(
      ctx.store,
      makeOp({ agentId, tool: 'tool-536d', sessionId: sessB, timestamp: new Date(BASE + 2_000) }),
      dec('block', 0.9),
      BASE + 2_000,
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { avgBlocksPerSession: number };
    expect(b.avgBlocksPerSession).toBeCloseTo(1.5, 5);
  });
});

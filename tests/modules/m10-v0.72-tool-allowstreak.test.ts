/**
 * v0.72 — T477/T478: allowStreak on GET /tools/:tool  +  pendingCount on GET /sessions/:sessionId
 *
 * T477: allowStreak counts consecutive 'allow' ops from the head of the DESC-sorted log
 *       (most recent first).  It resets to 0 as soon as the most recent op is not 'allow'.
 *
 * T478: pendingCount equals the number of 'require_approval' ops for the session,
 *       and is identical to the `pending` field already returned by the route.
 *
 * Store:  StateStore ':memory:'
 * Server: http.createServer / port 0  (resolved via server.address())
 * Order:  listOperationLogs returns DESC by timestamp (most recent first).
 *         Timestamps are spread explicitly so ordering is deterministic.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

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

function dec(action: ProxyDecision['action'], riskScore = 0.1): ProxyDecision {
  return { action, riskScore, reasons: [] };
}

// Spread n ops over distinct timestamps so DESC order is predictable.
// t(0) = oldest, t(n-1) = newest.
function ts(offsetMs: number): Date {
  return new Date(1_700_000_000_000 + offsetMs);
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
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

// ── T477 — GET /tools/:tool  allowStreak ─────────────────────────────────────

describe('T477 — GET /tools/:tool allowStreak', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. allowStreak field is present and is a number', async () => {
    ctx = await setup();
    const tool = 'tool-streak-field';
    await ctx.logger.log(makeOp({ tool, timestamp: ts(1000) }), dec('allow'));

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['allowStreak']).toBeDefined();
    expect(typeof b['allowStreak']).toBe('number');
  });

  it('2. allowStreak === 3 when the three most recent ops are all allow', async () => {
    ctx = await setup();
    const tool = 'tool-streak-3allow';
    // Insert from oldest to newest; DESC order will give newest first.
    // ops:  oldest=block(t=0), then allow(t=1), allow(t=2), allow(t=3)=newest
    // DESC: allow(t=3), allow(t=2), allow(t=1), block(t=0)
    // streak should be 3.
    await ctx.logger.log(makeOp({ tool, timestamp: ts(0) }), dec('block'));
    await ctx.logger.log(makeOp({ tool, timestamp: ts(1000) }), dec('allow'));
    await ctx.logger.log(makeOp({ tool, timestamp: ts(2000) }), dec('allow'));
    await ctx.logger.log(makeOp({ tool, timestamp: ts(3000) }), dec('allow'));

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as { allowStreak: number };
    expect(b.allowStreak).toBe(3);
  });

  it('3. allowStreak === 0 when most recent op is blocked', async () => {
    ctx = await setup();
    const tool = 'tool-streak-0';
    // DESC: block(t=3), allow(t=2), allow(t=1), allow(t=0)
    // Most recent is block → streak = 0.
    await ctx.logger.log(makeOp({ tool, timestamp: ts(0) }), dec('allow'));
    await ctx.logger.log(makeOp({ tool, timestamp: ts(1000) }), dec('allow'));
    await ctx.logger.log(makeOp({ tool, timestamp: ts(2000) }), dec('allow'));
    await ctx.logger.log(makeOp({ tool, timestamp: ts(3000) }), dec('block'));

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as { allowStreak: number };
    expect(b.allowStreak).toBe(0);
  });

  it('4. allowStreak === 0 when most recent op is require_approval', async () => {
    ctx = await setup();
    const tool = 'tool-streak-0-pending';
    // DESC: require_approval(t=2), allow(t=1), allow(t=0)
    await ctx.logger.log(makeOp({ tool, timestamp: ts(0) }), dec('allow'));
    await ctx.logger.log(makeOp({ tool, timestamp: ts(1000) }), dec('allow'));
    await ctx.logger.log(makeOp({ tool, timestamp: ts(2000) }), dec('require_approval'));

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as { allowStreak: number };
    expect(b.allowStreak).toBe(0);
  });

  it('5. allowStreak === 1 when only the single most recent op is allow (preceded by block)', async () => {
    ctx = await setup();
    const tool = 'tool-streak-1';
    // DESC: allow(t=2), block(t=1), allow(t=0)
    await ctx.logger.log(makeOp({ tool, timestamp: ts(0) }), dec('allow'));
    await ctx.logger.log(makeOp({ tool, timestamp: ts(1000) }), dec('block'));
    await ctx.logger.log(makeOp({ tool, timestamp: ts(2000) }), dec('allow'));

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as { allowStreak: number };
    expect(b.allowStreak).toBe(1);
  });

  it('6. allowStreak equals totalOps when every op is allow', async () => {
    ctx = await setup();
    const tool = 'tool-streak-all-allow';
    const n = 5;
    for (let i = 0; i < n; i++) {
      await ctx.logger.log(makeOp({ tool, timestamp: ts(i * 1000) }), dec('allow'));
    }

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as { allowStreak: number; totalOps: number };
    expect(b.allowStreak).toBe(n);
    expect(b.allowStreak).toBe(b.totalOps);
  });
});

// ── T478 — GET /sessions/:sessionId  pendingCount ────────────────────────────

describe('T478 — GET /sessions/:sessionId pendingCount', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('7. pendingCount field is present and is a number', async () => {
    ctx = await setup();
    const sessionId = 'sess-pending-field';
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(0) }), dec('allow'));

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['pendingCount']).toBeDefined();
    expect(typeof b['pendingCount']).toBe('number');
  });

  it('8. pendingCount === 2 when the session has 2 require_approval ops', async () => {
    ctx = await setup();
    const sessionId = 'sess-pending-2';
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(0) }), dec('allow'));
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(1000) }), dec('require_approval'));
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(2000) }), dec('block'));
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(3000) }), dec('require_approval'));
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(4000) }), dec('allow'));

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { pendingCount: number };
    expect(b.pendingCount).toBe(2);
  });

  it('9. pendingCount === 0 when there are no require_approval ops', async () => {
    ctx = await setup();
    const sessionId = 'sess-pending-0';
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(0) }), dec('allow'));
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(1000) }), dec('block'));
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(2000) }), dec('allow'));

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { pendingCount: number };
    expect(b.pendingCount).toBe(0);
  });

  it('10. pendingCount equals the `pending` field in the response', async () => {
    ctx = await setup();
    const sessionId = 'sess-pending-parity';
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(0) }), dec('require_approval'));
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(1000) }), dec('allow'));
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(2000) }), dec('require_approval'));
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(3000) }), dec('require_approval'));

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { pendingCount: number; pending: number };
    // pendingCount must equal the existing `pending` field (they count the same thing)
    expect(b.pendingCount).toBe(b.pending);
    expect(b.pendingCount).toBe(3);
  });

  it('11. pendingCount === totalOps when every op is require_approval', async () => {
    ctx = await setup();
    const sessionId = 'sess-pending-all';
    const n = 4;
    for (let i = 0; i < n; i++) {
      await ctx.logger.log(
        makeOp({ sessionId, timestamp: ts(i * 1000) }),
        dec('require_approval'),
      );
    }

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { pendingCount: number; totalOps: number };
    expect(b.pendingCount).toBe(n);
    expect(b.pendingCount).toBe(b.totalOps);
  });

  it('12. pendingCount is stable across allow/block/require_approval mix', async () => {
    ctx = await setup();
    const sessionId = 'sess-pending-mix';
    // 1 allow, 2 block, 3 require_approval => pendingCount = 3
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(0) }), dec('allow'));
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(1000) }), dec('block'));
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(2000) }), dec('require_approval'));
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(3000) }), dec('block'));
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(4000) }), dec('require_approval'));
    await ctx.logger.log(makeOp({ sessionId, timestamp: ts(5000) }), dec('require_approval'));

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as {
      pendingCount: number;
      pending: number;
      allowed: number;
      blocked: number;
      totalOps: number;
    };
    expect(b.pendingCount).toBe(3);
    expect(b.pendingCount).toBe(b.pending);
    expect(b.allowed).toBe(1);
    expect(b.blocked).toBe(2);
    expect(b.totalOps).toBe(6);
  });
});

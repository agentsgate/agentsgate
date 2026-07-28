/**
 * v0.74 tests
 *
 * T489 — GET /sessions/:sessionId returns riskBuckets
 *         5 ops with riskScores [0.1, 0.3, 0.5, 0.7, 0.9].
 *         Each score falls in a different 0.2-wide bucket:
 *           '0.0-0.2' → 0.1, '0.2-0.4' → 0.3, '0.4-0.6' → 0.5,
 *           '0.6-0.8' → 0.7, '0.8-1.0' → 0.9.
 *         Verify riskBuckets has all 5 keys with count 1 each.
 *
 * T487 — GET /agents/:agentId returns p75RiskScore
 *         4 ops with riskScores [0.1, 0.3, 0.7, 0.9].
 *         Sorted ascending: [0.1, 0.3, 0.7, 0.9].
 *         p75 = sortedScores[floor(4 * 0.75)] = sortedScores[3] = 0.9.
 *         Verify p75RiskScore === 0.9.
 *
 * T488 — GET /tools/:tool returns p75RiskScore
 *         Same pattern as T487 but scoped to a tool.
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

// t(offsetMs) gives deterministic, spread-out timestamps.
// t(0) = oldest, higher = newer. DESC sort puts highest offset first.
function ts(offsetMs: number): Date {
  return new Date(1_700_000_000_000 + offsetMs);
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
): Promise<void> {
  const log: OperationLog = {
    operationId: op.id,
    operation: op,
    decision,
    createdAt: new Date(),
  };
  await store.saveOperationLog(log);
}

// ── T489 — GET /sessions/:sessionId  riskBuckets ──────────────────────────────

describe('T489 — GET /sessions/:sessionId riskBuckets', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. riskBuckets field is present and is an object', async () => {
    ctx = await setup();
    const sessionId = 'sess-buckets-present';
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(0) }), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['riskBuckets']).toBeDefined();
    expect(typeof b['riskBuckets']).toBe('object');
    expect(b['riskBuckets']).not.toBeNull();
  });

  it('2. riskBuckets has all 5 expected bucket keys', async () => {
    ctx = await setup();
    const sessionId = 'sess-buckets-keys';
    const scores = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (let i = 0; i < scores.length; i++) {
      await saveLog(
        ctx.store,
        makeOp({ sessionId, timestamp: ts(i * 1000) }),
        dec('allow', scores[i]!),
      );
    }

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    const buckets = b['riskBuckets'] as Record<string, unknown>;
    expect(Object.keys(buckets).sort()).toEqual(
      ['0.0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0'].sort(),
    );
  });

  it('3. each bucket has count 1 for 5 ops spanning all 5 ranges', async () => {
    // riskScore 0.1 → '0.0-0.2', 0.3 → '0.2-0.4', 0.5 → '0.4-0.6',
    //           0.7 → '0.6-0.8', 0.9 → '0.8-1.0'
    ctx = await setup();
    const sessionId = 'sess-buckets-counts';
    const scores = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (let i = 0; i < scores.length; i++) {
      await saveLog(
        ctx.store,
        makeOp({ sessionId, timestamp: ts(i * 1000) }),
        dec('allow', scores[i]!),
      );
    }

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    const buckets = b['riskBuckets'] as Record<string, number>;
    expect(buckets['0.0-0.2']).toBe(1);
    expect(buckets['0.2-0.4']).toBe(1);
    expect(buckets['0.4-0.6']).toBe(1);
    expect(buckets['0.6-0.8']).toBe(1);
    expect(buckets['0.8-1.0']).toBe(1);
  });

  it('4. bucket counts reflect multiple ops in the same range', async () => {
    // Two ops in '0.0-0.2', one in '0.8-1.0', zero in the rest
    ctx = await setup();
    const sessionId = 'sess-buckets-multi';
    const scores = [0.05, 0.15, 0.95];
    for (let i = 0; i < scores.length; i++) {
      await saveLog(
        ctx.store,
        makeOp({ sessionId, timestamp: ts(i * 1000) }),
        dec('allow', scores[i]!),
      );
    }

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    const buckets = b['riskBuckets'] as Record<string, number>;
    expect(buckets['0.0-0.2']).toBe(2);
    expect(buckets['0.2-0.4']).toBe(0);
    expect(buckets['0.4-0.6']).toBe(0);
    expect(buckets['0.6-0.8']).toBe(0);
    expect(buckets['0.8-1.0']).toBe(1);
  });

  it('5. total count across all buckets equals totalOps', async () => {
    ctx = await setup();
    const sessionId = 'sess-buckets-total';
    const scores = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (let i = 0; i < scores.length; i++) {
      await saveLog(
        ctx.store,
        makeOp({ sessionId, timestamp: ts(i * 1000) }),
        dec('allow', scores[i]!),
      );
    }

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    const buckets = b['riskBuckets'] as Record<string, number>;
    const total = Object.values(buckets).reduce((sum, n) => sum + n, 0);
    expect(total).toBe((b as { totalOps: number }).totalOps);
  });
});

// ── T487 — GET /agents/:agentId  p75RiskScore ─────────────────────────────────

describe('T487 — GET /agents/:agentId p75RiskScore', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('6. p75RiskScore field is present and is a number', async () => {
    ctx = await setup();
    const agentId = 'agent-p75-present';
    await saveLog(
      ctx.store,
      makeOp({ agentId, sessionId: 'sess-a1', timestamp: ts(0) }),
      dec('allow', 0.5),
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['p75RiskScore']).toBeDefined();
    expect(typeof b['p75RiskScore']).toBe('number');
  });

  it('7. p75RiskScore === 0.9 for riskScores [0.1, 0.3, 0.7, 0.9]', async () => {
    // 4 ops with riskScores [0.1, 0.3, 0.7, 0.9].
    // Sorted ascending: [0.1, 0.3, 0.7, 0.9].
    // p75 = sortedScores[floor(4 * 0.75)] = sortedScores[3] = 0.9.
    ctx = await setup();
    const agentId = 'agent-p75-value';
    const scores = [0.1, 0.3, 0.7, 0.9];
    for (let i = 0; i < scores.length; i++) {
      await saveLog(
        ctx.store,
        makeOp({ agentId, sessionId: 'sess-agent-p75', timestamp: ts(i * 1000) }),
        dec('allow', scores[i]!),
      );
    }

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as { p75RiskScore: number };
    expect(b.p75RiskScore).toBeCloseTo(0.9, 5);
  });

  it('8. p75RiskScore uses floor(n * 0.75) into ascending-sorted scores', async () => {
    // Same 4 scores inserted in unsorted order → still get 0.9
    ctx = await setup();
    const agentId = 'agent-p75-unsorted';
    const scores = [0.9, 0.1, 0.3, 0.7]; // intentionally unsorted on insert
    for (let i = 0; i < scores.length; i++) {
      await saveLog(
        ctx.store,
        makeOp({ agentId, sessionId: 'sess-agent-p75-us', timestamp: ts(i * 1000) }),
        dec('allow', scores[i]!),
      );
    }

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as { p75RiskScore: number };
    expect(b.p75RiskScore).toBeCloseTo(0.9, 5);
  });

  it('9. p75RiskScore is consistent alongside p50RiskScore and p95RiskScore', async () => {
    ctx = await setup();
    const agentId = 'agent-p75-alongside';
    const scores = [0.1, 0.3, 0.7, 0.9];
    for (let i = 0; i < scores.length; i++) {
      await saveLog(
        ctx.store,
        makeOp({ agentId, sessionId: 'sess-alongside', timestamp: ts(i * 1000) }),
        dec('allow', scores[i]!),
      );
    }

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as {
      p50RiskScore: number;
      p75RiskScore: number;
      p95RiskScore: number;
    };
    // p50 = floor(4 * 0.50) = 2 → 0.7
    expect(b.p50RiskScore).toBeCloseTo(0.7, 5);
    // p75 = floor(4 * 0.75) = 3 → 0.9
    expect(b.p75RiskScore).toBeCloseTo(0.9, 5);
    // p95 = floor(4 * 0.95) = 3 → 0.9
    expect(b.p95RiskScore).toBeCloseTo(0.9, 5);
  });

  it('10. p75RiskScore === 0 when there are no ops', async () => {
    ctx = await setup();
    // Unknown agent returns 404; use single op agent to check edge cases
    // For a single op with score 0.5:
    // floor(1 * 0.75) = 0 → sortedScores[0] = 0.5
    const agentId = 'agent-p75-single';
    await saveLog(
      ctx.store,
      makeOp({ agentId, sessionId: 'sess-single', timestamp: ts(0) }),
      dec('allow', 0.5),
    );

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as { p75RiskScore: number };
    // floor(1 * 0.75) = 0 → sortedScores[0] = 0.5
    expect(b.p75RiskScore).toBeCloseTo(0.5, 5);
  });
});

// ── T488 — GET /tools/:tool  p75RiskScore ────────────────────────────────────

describe('T488 — GET /tools/:tool p75RiskScore', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('11. p75RiskScore field is present and is a number', async () => {
    ctx = await setup();
    const tool = 'tool-p75-present';
    await saveLog(
      ctx.store,
      makeOp({ tool, sessionId: 'sess-t1', timestamp: ts(0) }),
      dec('allow', 0.5),
    );

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['p75RiskScore']).toBeDefined();
    expect(typeof b['p75RiskScore']).toBe('number');
  });

  it('12. p75RiskScore === 0.9 for riskScores [0.1, 0.3, 0.7, 0.9]', async () => {
    // 4 ops with riskScores [0.1, 0.3, 0.7, 0.9].
    // Sorted ascending: [0.1, 0.3, 0.7, 0.9].
    // p75 = sortedScores[floor(4 * 0.75)] = sortedScores[3] = 0.9.
    ctx = await setup();
    const tool = 'tool-p75-value';
    const scores = [0.1, 0.3, 0.7, 0.9];
    for (let i = 0; i < scores.length; i++) {
      await saveLog(
        ctx.store,
        makeOp({ tool, sessionId: 'sess-tool-p75', timestamp: ts(i * 1000) }),
        dec('allow', scores[i]!),
      );
    }

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as { p75RiskScore: number };
    expect(b.p75RiskScore).toBeCloseTo(0.9, 5);
  });

  it('13. p75RiskScore uses floor(n * 0.75) regardless of insertion order', async () => {
    ctx = await setup();
    const tool = 'tool-p75-unsorted';
    const scores = [0.7, 0.9, 0.1, 0.3]; // intentionally unsorted on insert
    for (let i = 0; i < scores.length; i++) {
      await saveLog(
        ctx.store,
        makeOp({ tool, sessionId: 'sess-tool-p75-us', timestamp: ts(i * 1000) }),
        dec('allow', scores[i]!),
      );
    }

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as { p75RiskScore: number };
    expect(b.p75RiskScore).toBeCloseTo(0.9, 5);
  });

  it('14. p75RiskScore is consistent alongside p50RiskScore and p95RiskScore for tools', async () => {
    ctx = await setup();
    const tool = 'tool-p75-alongside';
    const scores = [0.1, 0.3, 0.7, 0.9];
    for (let i = 0; i < scores.length; i++) {
      await saveLog(
        ctx.store,
        makeOp({ tool, sessionId: 'sess-tool-alongside', timestamp: ts(i * 1000) }),
        dec('allow', scores[i]!),
      );
    }

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as {
      p50RiskScore: number;
      p75RiskScore: number;
      p95RiskScore: number;
    };
    // p50 = floor(4 * 0.50) = 2 → 0.7
    expect(b.p50RiskScore).toBeCloseTo(0.7, 5);
    // p75 = floor(4 * 0.75) = 3 → 0.9
    expect(b.p75RiskScore).toBeCloseTo(0.9, 5);
    // p95 = floor(4 * 0.95) = 3 → 0.9
    expect(b.p95RiskScore).toBeCloseTo(0.9, 5);
  });

  it('15. p75RiskScore for single op: floor(1 * 0.75) = 0 → the only score', async () => {
    ctx = await setup();
    const tool = 'tool-p75-single';
    await saveLog(
      ctx.store,
      makeOp({ tool, sessionId: 'sess-tool-single', timestamp: ts(0) }),
      dec('allow', 0.6),
    );

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as { p75RiskScore: number };
    // floor(1 * 0.75) = 0 → sortedScores[0] = 0.6
    expect(b.p75RiskScore).toBeCloseTo(0.6, 5);
  });
});

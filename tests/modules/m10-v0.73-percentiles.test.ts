/**
 * v0.73 tests
 *
 * T479 — GET /operations/summary returns p75RiskScore
 *         4 ops with riskScores [0.1, 0.4, 0.7, 0.9].
 *         Sorted ascending: [0.1, 0.4, 0.7, 0.9].
 *         p75 = allScores[floor(4*0.75)] = allScores[3] = 0.9.
 *         Also verifies p50 and p95 are present.
 *
 * T483 — GET /sessions/:sessionId returns blockStreak / allowStreak
 *         Store returns DESC order (most recent timestamp first).
 *         Two most-recent ops blocked → blockStreak=2, allowStreak=0.
 *         First (most recent) op allowed → allowStreak=1, blockStreak=0.
 *
 * T486 — GET /sessions/:sessionId returns medianRiskScore / p50RiskScore / p95RiskScore
 *         5 ops with known riskScores; verify all three fields are present.
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

// ── T479 — GET /operations/summary  p75RiskScore ──────────────────────────────

describe('T479 — GET /operations/summary p75RiskScore', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. p75RiskScore field is present and is a number', async () => {
    ctx = await setup();
    await saveLog(ctx.store, makeOp({ timestamp: ts(0) }), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['p75RiskScore']).toBeDefined();
    expect(typeof b['p75RiskScore']).toBe('number');
  });

  it('2. p75RiskScore === 0.9 for riskScores [0.1, 0.4, 0.7, 0.9]', async () => {
    // 4 ops with riskScores [0.1, 0.4, 0.7, 0.9].
    // Sorted ascending: [0.1, 0.4, 0.7, 0.9].
    // p75 = allScores[floor(4 * 0.75)] = allScores[3] = 0.9.
    ctx = await setup();
    const scores = [0.1, 0.4, 0.7, 0.9];
    for (let i = 0; i < scores.length; i++) {
      await saveLog(
        ctx.store,
        makeOp({ sessionId: 'sess-p75', timestamp: ts(i * 1000) }),
        dec('allow', scores[i]!),
      );
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { p75RiskScore: number };
    expect(b.p75RiskScore).toBeCloseTo(0.9, 5);
  });

  it('3. p50RiskScore is also present in the response', async () => {
    ctx = await setup();
    const scores = [0.1, 0.4, 0.7, 0.9];
    for (let i = 0; i < scores.length; i++) {
      await saveLog(
        ctx.store,
        makeOp({ sessionId: 'sess-p50-check', timestamp: ts(i * 1000) }),
        dec('allow', scores[i]!),
      );
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['p50RiskScore']).toBeDefined();
    expect(typeof b['p50RiskScore']).toBe('number');
  });

  it('4. p95RiskScore is also present in the response', async () => {
    ctx = await setup();
    const scores = [0.1, 0.4, 0.7, 0.9];
    for (let i = 0; i < scores.length; i++) {
      await saveLog(
        ctx.store,
        makeOp({ sessionId: 'sess-p95-check', timestamp: ts(i * 1000) }),
        dec('allow', scores[i]!),
      );
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['p95RiskScore']).toBeDefined();
    expect(typeof b['p95RiskScore']).toBe('number');
  });

  it('5. p75RiskScore index formula: floor(n * 0.75) into ascending-sorted scores', async () => {
    // 4 scores [0.1, 0.4, 0.7, 0.9] → sorted ascending → index 3 → 0.9
    // Confirm the formula: floor(4 * 0.75) = floor(3.0) = 3 → sortedScores[3] = 0.9
    ctx = await setup();
    const scores = [0.9, 0.1, 0.7, 0.4]; // intentionally unsorted when inserted
    for (let i = 0; i < scores.length; i++) {
      await saveLog(
        ctx.store,
        makeOp({ sessionId: 'sess-p75-order', timestamp: ts(i * 1000) }),
        dec('allow', scores[i]!),
      );
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { p75RiskScore: number; p50RiskScore: number };
    expect(b.p75RiskScore).toBeCloseTo(0.9, 5);
    // p50 = floor(4 * 0.50) = 2 → sortedScores[2] = 0.7
    expect(b.p50RiskScore).toBeCloseTo(0.7, 5);
  });
});

// ── T483 — GET /sessions/:sessionId  blockStreak / allowStreak ─────────────────

describe('T483 — GET /sessions/:sessionId blockStreak/allowStreak', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('6. blockStreak and allowStreak fields are present and are numbers', async () => {
    ctx = await setup();
    const sessionId = 'sess-streak-fields';
    await saveLog(
      ctx.store,
      makeOp({ sessionId, timestamp: ts(0) }),
      dec('allow', 0.1),
    );

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['blockStreak']).toBeDefined();
    expect(typeof b['blockStreak']).toBe('number');
    expect(b['allowStreak']).toBeDefined();
    expect(typeof b['allowStreak']).toBe('number');
  });

  it('7. blockStreak=2, allowStreak=0 when first 2 (most recent) ops are blocked', async () => {
    // DESC order (most recent first):
    //   block(t=2000) ← most recent
    //   block(t=1000)
    //   allow(t=0)    ← oldest
    // blockStreak counts consecutive blocks from head → 2
    // allowStreak sees block first → 0
    ctx = await setup();
    const sessionId = 'sess-block-streak-2';
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(0) }),    dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(1000) }), dec('block', 0.8));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(2000) }), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { blockStreak: number; allowStreak: number };
    expect(b.blockStreak).toBe(2);
    expect(b.allowStreak).toBe(0);
  });

  it('8. allowStreak=1, blockStreak=0 when first (most recent) op is allowed', async () => {
    // DESC order (most recent first):
    //   allow(t=2000) ← most recent
    //   block(t=1000)
    //   block(t=0)    ← oldest
    // allowStreak counts consecutive allows from head → 1
    // blockStreak sees allow first → 0
    ctx = await setup();
    const sessionId = 'sess-allow-streak-1';
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(0) }),    dec('block', 0.8));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(1000) }), dec('block', 0.9));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(2000) }), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { blockStreak: number; allowStreak: number };
    expect(b.allowStreak).toBe(1);
    expect(b.blockStreak).toBe(0);
  });

  it('9. blockStreak=0, allowStreak=0 when most recent op is require_approval', async () => {
    // DESC order: require_approval(t=2000), block(t=1000), allow(t=0)
    ctx = await setup();
    const sessionId = 'sess-pending-streak';
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(0) }),    dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(1000) }), dec('block', 0.8));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(2000) }), dec('require_approval', 0.6));

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { blockStreak: number; allowStreak: number };
    expect(b.blockStreak).toBe(0);
    expect(b.allowStreak).toBe(0);
  });

  it('10. blockStreak equals totalOps when every op is blocked', async () => {
    ctx = await setup();
    const sessionId = 'sess-all-blocked';
    const n = 3;
    for (let i = 0; i < n; i++) {
      await saveLog(
        ctx.store,
        makeOp({ sessionId, timestamp: ts(i * 1000) }),
        dec('block', 0.9),
      );
    }

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { blockStreak: number; allowStreak: number; totalOps: number };
    expect(b.blockStreak).toBe(n);
    expect(b.blockStreak).toBe(b.totalOps);
    expect(b.allowStreak).toBe(0);
  });
});

// ── T486 — GET /sessions/:sessionId  medianRiskScore / p50 / p95 ──────────────

describe('T486 — GET /sessions/:sessionId medianRiskScore/p50RiskScore/p95RiskScore', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('11. medianRiskScore field is present and is a number', async () => {
    ctx = await setup();
    const sessionId = 'sess-median-field';
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
    expect(b['medianRiskScore']).toBeDefined();
    expect(typeof b['medianRiskScore']).toBe('number');
  });

  it('12. p50RiskScore field is present and is a number', async () => {
    ctx = await setup();
    const sessionId = 'sess-p50-field';
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
    expect(b['p50RiskScore']).toBeDefined();
    expect(typeof b['p50RiskScore']).toBe('number');
  });

  it('13. p95RiskScore field is present and is a number', async () => {
    ctx = await setup();
    const sessionId = 'sess-p95-field';
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
    expect(b['p95RiskScore']).toBeDefined();
    expect(typeof b['p95RiskScore']).toBe('number');
  });

  it('14. all three percentile fields are present simultaneously', async () => {
    ctx = await setup();
    const sessionId = 'sess-all-percentiles';
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
    const b = body as {
      medianRiskScore: unknown;
      p50RiskScore: unknown;
      p95RiskScore: unknown;
    };
    expect(b.medianRiskScore).toBeDefined();
    expect(b.p50RiskScore).toBeDefined();
    expect(b.p95RiskScore).toBeDefined();
  });

  it('15. medianRiskScore === 0.5 for 5 ops with riskScores [0.1, 0.3, 0.5, 0.7, 0.9]', async () => {
    // Sorted ascending: [0.1, 0.3, 0.5, 0.7, 0.9].
    // Median of 5 (odd) = middle element = index 2 = 0.5.
    ctx = await setup();
    const sessionId = 'sess-median-value';
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
    const b = body as { medianRiskScore: number };
    expect(b.medianRiskScore).toBeCloseTo(0.5, 5);
  });

  it('16. p50RiskScore for 5 ops with riskScores [0.1,0.3,0.5,0.7,0.9] = floor(5*0.50)=2 → 0.5', async () => {
    ctx = await setup();
    const sessionId = 'sess-p50-value';
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
    const b = body as { p50RiskScore: number };
    // floor(5 * 0.50) = 2 → sortedScores[2] = 0.5
    expect(b.p50RiskScore).toBeCloseTo(0.5, 5);
  });

  it('17. p95RiskScore for 5 ops with riskScores [0.1,0.3,0.5,0.7,0.9] = floor(5*0.95)=4 → 0.9', async () => {
    ctx = await setup();
    const sessionId = 'sess-p95-value';
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
    const b = body as { p95RiskScore: number };
    // floor(5 * 0.95) = 4 → sortedScores[4] = 0.9
    expect(b.p95RiskScore).toBeCloseTo(0.9, 5);
  });
});

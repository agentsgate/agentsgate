/**
 * v0.75 tests
 *
 * T492 — GET /sessions returns allowRate per entry
 *         allowRate = approved / operationCount
 *
 * T493 — GET /sessions returns pendingRate per entry
 *         pendingRate = requireApproval / operationCount
 *
 * T494 — GET /operations/summary returns topRiskAgents[]
 *         Sorted descending by avgRisk, each entry has agentId and avgRisk.
 *
 * Store:  StateStore ':memory:'
 * Server: http.createServer / port 0  (resolved via server.address())
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

// ── T492/T493 — GET /sessions allowRate and pendingRate ───────────────────────

describe('T492 — GET /sessions allowRate field', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. allowRate field is present and is a number in each session entry', async () => {
    ctx = await setup();
    const sessionId = 'sess-ar-present';
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(0) }), dec('allow', 0.2));

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { data: Record<string, unknown>[] };
    const entry = b.data.find(s => s['sessionId'] === sessionId);
    expect(entry).toBeDefined();
    expect(typeof entry!['allowRate']).toBe('number');
  });

  it('2. allowRate = approved / operationCount (2 allow, 1 block, 0 pending → 2/3)', async () => {
    ctx = await setup();
    const sessionId = 'sess-ar-2-allow';
    // 2 allow, 1 block → approved=2, operationCount=3, allowRate=2/3
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(0) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(1000) }), dec('allow', 0.2));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(2000) }), dec('block', 0.8));

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { data: Record<string, unknown>[] };
    const entry = b.data.find(s => s['sessionId'] === sessionId);
    expect(entry).toBeDefined();
    expect(entry!['allowRate'] as number).toBeCloseTo(2 / 3, 5);
  });

  it('3. allowRate = 1.0 when all ops are allowed', async () => {
    ctx = await setup();
    const sessionId = 'sess-ar-all-allow';
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(0) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(1000) }), dec('allow', 0.2));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(2000) }), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { data: Record<string, unknown>[] };
    const entry = b.data.find(s => s['sessionId'] === sessionId);
    expect(entry).toBeDefined();
    expect(entry!['allowRate'] as number).toBeCloseTo(1.0, 5);
  });

  it('4. allowRate = 0.0 when no ops are allowed (all blocked)', async () => {
    ctx = await setup();
    const sessionId = 'sess-ar-no-allow';
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(0) }), dec('block', 0.9));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(1000) }), dec('block', 0.95));

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { data: Record<string, unknown>[] };
    const entry = b.data.find(s => s['sessionId'] === sessionId);
    expect(entry).toBeDefined();
    expect(entry!['allowRate'] as number).toBeCloseTo(0.0, 5);
  });

  it('5. allowRate is consistent with approved and operationCount fields', async () => {
    ctx = await setup();
    const sessionId = 'sess-ar-consistent';
    // 3 allow, 1 block, 1 require_approval → approved=3, operationCount=5, allowRate=0.6
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(0) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(1000) }), dec('allow', 0.2));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(2000) }), dec('allow', 0.3));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(3000) }), dec('block', 0.8));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(4000) }), dec('require_approval', 0.6));

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { data: Record<string, unknown>[] };
    const entry = b.data.find(s => s['sessionId'] === sessionId) as Record<string, number> | undefined;
    expect(entry).toBeDefined();
    const expectedAllowRate = entry!['approved'] / entry!['operationCount'];
    expect(entry!['allowRate']).toBeCloseTo(expectedAllowRate, 5);
    expect(entry!['allowRate']).toBeCloseTo(3 / 5, 5);
  });
});

describe('T493 — GET /sessions pendingRate field', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('6. pendingRate field is present and is a number in each session entry', async () => {
    ctx = await setup();
    const sessionId = 'sess-pr-present';
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(0) }), dec('require_approval', 0.6));

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { data: Record<string, unknown>[] };
    const entry = b.data.find(s => s['sessionId'] === sessionId);
    expect(entry).toBeDefined();
    expect(typeof entry!['pendingRate']).toBe('number');
  });

  it('7. pendingRate = requireApproval / operationCount (1 pending out of 4)', async () => {
    ctx = await setup();
    const sessionId = 'sess-pr-1-of-4';
    // 2 allow, 1 block, 1 require_approval → requireApproval=1, operationCount=4, pendingRate=0.25
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(0) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(1000) }), dec('allow', 0.2));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(2000) }), dec('block', 0.9));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(3000) }), dec('require_approval', 0.65));

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { data: Record<string, unknown>[] };
    const entry = b.data.find(s => s['sessionId'] === sessionId);
    expect(entry).toBeDefined();
    expect(entry!['pendingRate'] as number).toBeCloseTo(1 / 4, 5);
  });

  it('8. pendingRate = 1.0 when all ops are require_approval', async () => {
    ctx = await setup();
    const sessionId = 'sess-pr-all-pending';
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(0) }), dec('require_approval', 0.6));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(1000) }), dec('require_approval', 0.65));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(2000) }), dec('require_approval', 0.7));

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { data: Record<string, unknown>[] };
    const entry = b.data.find(s => s['sessionId'] === sessionId);
    expect(entry).toBeDefined();
    expect(entry!['pendingRate'] as number).toBeCloseTo(1.0, 5);
  });

  it('9. pendingRate = 0.0 when no ops are pending (all allowed/blocked)', async () => {
    ctx = await setup();
    const sessionId = 'sess-pr-no-pending';
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(0) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(1000) }), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { data: Record<string, unknown>[] };
    const entry = b.data.find(s => s['sessionId'] === sessionId);
    expect(entry).toBeDefined();
    expect(entry!['pendingRate'] as number).toBeCloseTo(0.0, 5);
  });

  it('10. both allowRate and pendingRate are present and correct simultaneously', async () => {
    ctx = await setup();
    const sessionId = 'sess-ar-pr-both';
    // 3 allow, 2 require_approval, 0 block
    // operationCount=5, approved=3, requireApproval=2
    // allowRate=3/5=0.6, pendingRate=2/5=0.4
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(0) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(1000) }), dec('allow', 0.2));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(2000) }), dec('allow', 0.3));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(3000) }), dec('require_approval', 0.6));
    await saveLog(ctx.store, makeOp({ sessionId, timestamp: ts(4000) }), dec('require_approval', 0.65));

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { data: Record<string, unknown>[] };
    const entry = b.data.find(s => s['sessionId'] === sessionId);
    expect(entry).toBeDefined();
    expect(entry!['allowRate'] as number).toBeCloseTo(3 / 5, 5);
    expect(entry!['pendingRate'] as number).toBeCloseTo(2 / 5, 5);
    // allowRate + pendingRate + blockRate should sum to 1
    const arPrSum = (entry!['allowRate'] as number) + (entry!['pendingRate'] as number) + (entry!['blockRate'] as number);
    expect(arPrSum).toBeCloseTo(1.0, 5);
  });
});

// ── T494 — GET /operations/summary topRiskAgents[] ───────────────────────────

describe('T494 — GET /operations/summary topRiskAgents', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('11. topRiskAgents field is present and is an array', async () => {
    ctx = await setup();
    const agentId = 'agent-tra-present';
    await saveLog(
      ctx.store,
      makeOp({ agentId, sessionId: 'sess-tra-present', timestamp: ts(0) }),
      dec('allow', 0.5),
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['topRiskAgents']).toBeDefined();
    expect(Array.isArray(b['topRiskAgents'])).toBe(true);
  });

  it('12. each topRiskAgents entry has agentId and avgRisk fields', async () => {
    ctx = await setup();
    const agentId = 'agent-tra-fields';
    await saveLog(
      ctx.store,
      makeOp({ agentId, sessionId: 'sess-tra-fields', timestamp: ts(0) }),
      dec('allow', 0.7),
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { topRiskAgents: Record<string, unknown>[] };
    const entry = b.topRiskAgents.find(e => e['agentId'] === agentId);
    expect(entry).toBeDefined();
    expect(typeof entry!['agentId']).toBe('string');
    expect(typeof entry!['avgRisk']).toBe('number');
  });

  it('13. topRiskAgents is sorted descending by avgRisk', async () => {
    ctx = await setup();
    // agent-A: 2 ops with scores 0.9 and 0.9 → avgRisk=0.9
    // agent-B: 2 ops with scores 0.5 and 0.5 → avgRisk=0.5
    // agent-C: 2 ops with scores 0.1 and 0.1 → avgRisk=0.1
    const agentA = 'agent-tra-sort-A';
    const agentB = 'agent-tra-sort-B';
    const agentC = 'agent-tra-sort-C';
    await saveLog(ctx.store, makeOp({ agentId: agentA, sessionId: 'sess-tra-A', timestamp: ts(0) }), dec('allow', 0.9));
    await saveLog(ctx.store, makeOp({ agentId: agentA, sessionId: 'sess-tra-A', timestamp: ts(1000) }), dec('allow', 0.9));
    await saveLog(ctx.store, makeOp({ agentId: agentB, sessionId: 'sess-tra-B', timestamp: ts(2000) }), dec('allow', 0.5));
    await saveLog(ctx.store, makeOp({ agentId: agentB, sessionId: 'sess-tra-B', timestamp: ts(3000) }), dec('allow', 0.5));
    await saveLog(ctx.store, makeOp({ agentId: agentC, sessionId: 'sess-tra-C', timestamp: ts(4000) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ agentId: agentC, sessionId: 'sess-tra-C', timestamp: ts(5000) }), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { topRiskAgents: { agentId: string; avgRisk: number }[] };
    const agents = b.topRiskAgents;

    // All three should be present
    const idxA = agents.findIndex(e => e.agentId === agentA);
    const idxB = agents.findIndex(e => e.agentId === agentB);
    const idxC = agents.findIndex(e => e.agentId === agentC);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxC).toBeGreaterThanOrEqual(0);

    // A (highest risk) should appear before B, B before C
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);
  });

  it('14. topRiskAgents avgRisk values are correct (riskSum / count)', async () => {
    ctx = await setup();
    // agent-A: scores [0.9, 0.9] → avgRisk = 0.9
    // agent-B: scores [0.4, 0.6] → avgRisk = 0.5
    // agent-C: scores [0.1, 0.1] → avgRisk = 0.1
    const agentA = 'agent-tra-avg-A';
    const agentB = 'agent-tra-avg-B';
    const agentC = 'agent-tra-avg-C';
    await saveLog(ctx.store, makeOp({ agentId: agentA, sessionId: 'sess-avg-A', timestamp: ts(0) }), dec('allow', 0.9));
    await saveLog(ctx.store, makeOp({ agentId: agentA, sessionId: 'sess-avg-A', timestamp: ts(1000) }), dec('allow', 0.9));
    await saveLog(ctx.store, makeOp({ agentId: agentB, sessionId: 'sess-avg-B', timestamp: ts(2000) }), dec('allow', 0.4));
    await saveLog(ctx.store, makeOp({ agentId: agentB, sessionId: 'sess-avg-B', timestamp: ts(3000) }), dec('allow', 0.6));
    await saveLog(ctx.store, makeOp({ agentId: agentC, sessionId: 'sess-avg-C', timestamp: ts(4000) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ agentId: agentC, sessionId: 'sess-avg-C', timestamp: ts(5000) }), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { topRiskAgents: { agentId: string; avgRisk: number }[] };
    const agents = b.topRiskAgents;

    const entryA = agents.find(e => e.agentId === agentA);
    const entryB = agents.find(e => e.agentId === agentB);
    const entryC = agents.find(e => e.agentId === agentC);
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
    expect(entryC).toBeDefined();
    expect(entryA!.avgRisk).toBeCloseTo(0.9, 5);
    expect(entryB!.avgRisk).toBeCloseTo(0.5, 5);
    expect(entryC!.avgRisk).toBeCloseTo(0.1, 5);
  });

  it('15. topRiskAgents is capped at 5 agents when more exist', async () => {
    ctx = await setup();
    // Create 7 agents with distinct risk scores
    const agents = [
      { id: 'agent-tra-cap-1', score: 0.9 },
      { id: 'agent-tra-cap-2', score: 0.8 },
      { id: 'agent-tra-cap-3', score: 0.7 },
      { id: 'agent-tra-cap-4', score: 0.6 },
      { id: 'agent-tra-cap-5', score: 0.5 },
      { id: 'agent-tra-cap-6', score: 0.4 },
      { id: 'agent-tra-cap-7', score: 0.3 },
    ];
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]!;
      await saveLog(
        ctx.store,
        makeOp({ agentId: a.id, sessionId: `sess-cap-${i}`, timestamp: ts(i * 1000) }),
        dec('allow', a.score),
      );
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { topRiskAgents: { agentId: string; avgRisk: number }[] };
    expect(b.topRiskAgents.length).toBeLessThanOrEqual(5);
  });

  it('16. topRiskAgents descending order is maintained with 3 agents of very different scores', async () => {
    ctx = await setup();
    // Intentionally insert in ascending risk order to verify sorting is not insertion-order
    const agentLow  = 'agent-tra-order-low';
    const agentMid  = 'agent-tra-order-mid';
    const agentHigh = 'agent-tra-order-high';
    await saveLog(ctx.store, makeOp({ agentId: agentLow,  sessionId: 'sess-order-low',  timestamp: ts(0) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ agentId: agentMid,  sessionId: 'sess-order-mid',  timestamp: ts(1000) }), dec('allow', 0.5));
    await saveLog(ctx.store, makeOp({ agentId: agentHigh, sessionId: 'sess-order-high', timestamp: ts(2000) }), dec('allow', 0.9));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { topRiskAgents: { agentId: string; avgRisk: number }[] };

    // Verify descending order by checking each consecutive pair
    const risksInOrder = b.topRiskAgents.map(e => e.avgRisk);
    for (let i = 1; i < risksInOrder.length; i++) {
      expect(risksInOrder[i]!).toBeLessThanOrEqual(risksInOrder[i - 1]!);
    }

    // Highest risk agent should be first
    expect(b.topRiskAgents[0]!.agentId).toBe(agentHigh);
  });
});

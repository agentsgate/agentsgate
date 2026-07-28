/**
 * v0.76 tests
 *
 * T498 — GET /agents returns allowRate and pendingRate per agent entry.
 *         allowRate  = allow / totalOps
 *         pendingRate = require_approval / totalOps
 *
 * T499/T500 — GET /tools returns allowRate and pendingRate per tool entry.
 *         allowRate  = allow / totalOps
 *         pendingRate = require_approval / totalOps
 *
 * T501 — GET /operations/summary returns topRiskTools[]
 *         Sorted descending by avgRisk, each entry has tool and avgRisk fields.
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

// ── T498 — GET /agents allowRate and pendingRate ──────────────────────────────

describe('T498 — GET /agents allowRate and pendingRate', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. agentA has correct allowRate (2 allow + 1 block = 2/3 ≈ 0.667)', async () => {
    ctx = await setup();
    const agentA = 'agent-498-A';
    // 2 allowed, 1 blocked → totalOps=3, allowRate=2/3
    await saveLog(ctx.store, makeOp({ agentId: agentA, sessionId: 'sess-498-A', timestamp: ts(0) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ agentId: agentA, sessionId: 'sess-498-A', timestamp: ts(1000) }), dec('allow', 0.2));
    await saveLog(ctx.store, makeOp({ agentId: agentA, sessionId: 'sess-498-A', timestamp: ts(2000) }), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as { agents: Record<string, unknown>[] };
    const entry = b.agents.find(a => a['agentId'] === agentA);
    expect(entry).toBeDefined();
    expect(typeof entry!['allowRate']).toBe('number');
    expect(entry!['allowRate'] as number).toBeCloseTo(2 / 3, 5);
  });

  it('2. agentA pendingRate = 0 (no require_approval ops)', async () => {
    ctx = await setup();
    const agentA = 'agent-498-B';
    await saveLog(ctx.store, makeOp({ agentId: agentA, sessionId: 'sess-498-B', timestamp: ts(0) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ agentId: agentA, sessionId: 'sess-498-B', timestamp: ts(1000) }), dec('allow', 0.2));
    await saveLog(ctx.store, makeOp({ agentId: agentA, sessionId: 'sess-498-B', timestamp: ts(2000) }), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as { agents: Record<string, unknown>[] };
    const entry = b.agents.find(a => a['agentId'] === agentA);
    expect(entry).toBeDefined();
    expect(typeof entry!['pendingRate']).toBe('number');
    expect(entry!['pendingRate'] as number).toBeCloseTo(0, 5);
  });

  it('3. agentB has correct pendingRate (1 require_approval + 1 block = 0.5)', async () => {
    ctx = await setup();
    const agentB = 'agent-498-C';
    // 1 require_approval, 1 blocked → totalOps=2, pendingRate=1/2=0.5
    await saveLog(ctx.store, makeOp({ agentId: agentB, sessionId: 'sess-498-C', timestamp: ts(0) }), dec('require_approval', 0.65));
    await saveLog(ctx.store, makeOp({ agentId: agentB, sessionId: 'sess-498-C', timestamp: ts(1000) }), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as { agents: Record<string, unknown>[] };
    const entry = b.agents.find(a => a['agentId'] === agentB);
    expect(entry).toBeDefined();
    expect(typeof entry!['pendingRate']).toBe('number');
    expect(entry!['pendingRate'] as number).toBeCloseTo(0.5, 5);
  });

  it('4. agentB allowRate = 0 (no allow ops)', async () => {
    ctx = await setup();
    const agentB = 'agent-498-D';
    await saveLog(ctx.store, makeOp({ agentId: agentB, sessionId: 'sess-498-D', timestamp: ts(0) }), dec('require_approval', 0.65));
    await saveLog(ctx.store, makeOp({ agentId: agentB, sessionId: 'sess-498-D', timestamp: ts(1000) }), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as { agents: Record<string, unknown>[] };
    const entry = b.agents.find(a => a['agentId'] === agentB);
    expect(entry).toBeDefined();
    expect(entry!['allowRate'] as number).toBeCloseTo(0, 5);
  });

  it('5. both agentA and agentB appear simultaneously with correct rates', async () => {
    ctx = await setup();
    const agentA = 'agent-498-both-A';
    const agentB = 'agent-498-both-B';

    // agentA: 2 allow, 1 block → allowRate=2/3, pendingRate=0
    await saveLog(ctx.store, makeOp({ agentId: agentA, sessionId: 'sess-both-A', timestamp: ts(0) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ agentId: agentA, sessionId: 'sess-both-A', timestamp: ts(1000) }), dec('allow', 0.2));
    await saveLog(ctx.store, makeOp({ agentId: agentA, sessionId: 'sess-both-A', timestamp: ts(2000) }), dec('block', 0.9));

    // agentB: 1 require_approval, 1 block → allowRate=0, pendingRate=0.5
    await saveLog(ctx.store, makeOp({ agentId: agentB, sessionId: 'sess-both-B', timestamp: ts(3000) }), dec('require_approval', 0.65));
    await saveLog(ctx.store, makeOp({ agentId: agentB, sessionId: 'sess-both-B', timestamp: ts(4000) }), dec('block', 0.9));

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as { agents: Record<string, unknown>[] };

    const entryA = b.agents.find(a => a['agentId'] === agentA);
    const entryB = b.agents.find(a => a['agentId'] === agentB);
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();

    // agentA: 2 allow / 3 total = 0.667
    expect(entryA!['allowRate'] as number).toBeCloseTo(2 / 3, 5);
    expect(entryA!['pendingRate'] as number).toBeCloseTo(0, 5);

    // agentB: 1 require_approval / 2 total = 0.5
    expect(entryB!['allowRate'] as number).toBeCloseTo(0, 5);
    expect(entryB!['pendingRate'] as number).toBeCloseTo(0.5, 5);
  });
});

// ── T499/T500 — GET /tools allowRate and pendingRate ─────────────────────────

describe('T499/T500 — GET /tools allowRate and pendingRate', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('6. toolX allowRate = 1.0 (3 allow ops)', async () => {
    ctx = await setup();
    const toolX = 'tool-499-X';
    // 3 allowed → totalOps=3, allowRate=1.0
    await saveLog(ctx.store, makeOp({ tool: toolX, sessionId: 'sess-499-X', timestamp: ts(0) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ tool: toolX, sessionId: 'sess-499-X', timestamp: ts(1000) }), dec('allow', 0.2));
    await saveLog(ctx.store, makeOp({ tool: toolX, sessionId: 'sess-499-X', timestamp: ts(2000) }), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as { tools: Record<string, unknown>[] };
    const entry = b.tools.find(t => t['tool'] === toolX);
    expect(entry).toBeDefined();
    expect(typeof entry!['allowRate']).toBe('number');
    expect(entry!['allowRate'] as number).toBeCloseTo(1.0, 5);
  });

  it('7. toolX pendingRate = 0 (no require_approval)', async () => {
    ctx = await setup();
    const toolX = 'tool-500-X2';
    await saveLog(ctx.store, makeOp({ tool: toolX, sessionId: 'sess-500-X2', timestamp: ts(0) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ tool: toolX, sessionId: 'sess-500-X2', timestamp: ts(1000) }), dec('allow', 0.2));
    await saveLog(ctx.store, makeOp({ tool: toolX, sessionId: 'sess-500-X2', timestamp: ts(2000) }), dec('allow', 0.3));

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as { tools: Record<string, unknown>[] };
    const entry = b.tools.find(t => t['tool'] === toolX);
    expect(entry).toBeDefined();
    expect(typeof entry!['pendingRate']).toBe('number');
    expect(entry!['pendingRate'] as number).toBeCloseTo(0, 5);
  });

  it('8. toolY allowRate = 0 (1 block + 1 require_approval)', async () => {
    ctx = await setup();
    const toolY = 'tool-499-Y';
    // 1 block, 1 require_approval → totalOps=2, allowRate=0
    await saveLog(ctx.store, makeOp({ tool: toolY, sessionId: 'sess-499-Y', timestamp: ts(0) }), dec('block', 0.9));
    await saveLog(ctx.store, makeOp({ tool: toolY, sessionId: 'sess-499-Y', timestamp: ts(1000) }), dec('require_approval', 0.65));

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as { tools: Record<string, unknown>[] };
    const entry = b.tools.find(t => t['tool'] === toolY);
    expect(entry).toBeDefined();
    expect(entry!['allowRate'] as number).toBeCloseTo(0, 5);
  });

  it('9. toolY pendingRate = 0.5 (1 require_approval out of 2)', async () => {
    ctx = await setup();
    const toolY = 'tool-500-Y';
    // 1 block, 1 require_approval → totalOps=2, pendingRate=0.5
    await saveLog(ctx.store, makeOp({ tool: toolY, sessionId: 'sess-500-Y', timestamp: ts(0) }), dec('block', 0.9));
    await saveLog(ctx.store, makeOp({ tool: toolY, sessionId: 'sess-500-Y', timestamp: ts(1000) }), dec('require_approval', 0.65));

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as { tools: Record<string, unknown>[] };
    const entry = b.tools.find(t => t['tool'] === toolY);
    expect(entry).toBeDefined();
    expect(typeof entry!['pendingRate']).toBe('number');
    expect(entry!['pendingRate'] as number).toBeCloseTo(0.5, 5);
  });

  it('10. both toolX and toolY appear simultaneously with correct rates', async () => {
    ctx = await setup();
    const toolX = 'tool-both-X';
    const toolY = 'tool-both-Y';

    // toolX: 3 allow → allowRate=1.0, pendingRate=0
    await saveLog(ctx.store, makeOp({ tool: toolX, sessionId: 'sess-tx', timestamp: ts(0) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ tool: toolX, sessionId: 'sess-tx', timestamp: ts(1000) }), dec('allow', 0.2));
    await saveLog(ctx.store, makeOp({ tool: toolX, sessionId: 'sess-tx', timestamp: ts(2000) }), dec('allow', 0.3));

    // toolY: 1 block, 1 require_approval → allowRate=0, pendingRate=0.5
    await saveLog(ctx.store, makeOp({ tool: toolY, sessionId: 'sess-ty', timestamp: ts(3000) }), dec('block', 0.9));
    await saveLog(ctx.store, makeOp({ tool: toolY, sessionId: 'sess-ty', timestamp: ts(4000) }), dec('require_approval', 0.65));

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as { tools: Record<string, unknown>[] };

    const entryX = b.tools.find(t => t['tool'] === toolX);
    const entryY = b.tools.find(t => t['tool'] === toolY);
    expect(entryX).toBeDefined();
    expect(entryY).toBeDefined();

    // toolX: 3 allow / 3 total = 1.0
    expect(entryX!['allowRate'] as number).toBeCloseTo(1.0, 5);
    expect(entryX!['pendingRate'] as number).toBeCloseTo(0, 5);

    // toolY: 0 allow / 2 total = 0; 1 require_approval / 2 total = 0.5
    expect(entryY!['allowRate'] as number).toBeCloseTo(0, 5);
    expect(entryY!['pendingRate'] as number).toBeCloseTo(0.5, 5);
  });
});

// ── T501 — GET /operations/summary topRiskTools[] ────────────────────────────

describe('T501 — GET /operations/summary topRiskTools', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('11. topRiskTools field is present and is an array', async () => {
    ctx = await setup();
    await saveLog(
      ctx.store,
      makeOp({ tool: 'tool-501-present', sessionId: 'sess-501-p', timestamp: ts(0) }),
      dec('allow', 0.5),
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['topRiskTools']).toBeDefined();
    expect(Array.isArray(b['topRiskTools'])).toBe(true);
  });

  it('12. each topRiskTools entry has tool and avgRisk fields', async () => {
    ctx = await setup();
    const toolName = 'tool-501-fields';
    await saveLog(
      ctx.store,
      makeOp({ tool: toolName, sessionId: 'sess-501-f', timestamp: ts(0) }),
      dec('allow', 0.7),
    );

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { topRiskTools: Record<string, unknown>[] };
    const entry = b.topRiskTools.find(e => e['tool'] === toolName);
    expect(entry).toBeDefined();
    expect(typeof entry!['tool']).toBe('string');
    expect(typeof entry!['avgRisk']).toBe('number');
  });

  it('13. topRiskTools is sorted descending by avgRisk (tool-A: 0.9, tool-B: 0.5, tool-C: 0.1)', async () => {
    ctx = await setup();
    const toolA = 'tool-501-sort-A';
    const toolB = 'tool-501-sort-B';
    const toolC = 'tool-501-sort-C';

    // tool-A: riskScore=0.9 → avgRisk=0.9
    await saveLog(ctx.store, makeOp({ tool: toolA, sessionId: 'sess-501-A', timestamp: ts(0) }), dec('allow', 0.9));
    // tool-B: riskScore=0.5 → avgRisk=0.5
    await saveLog(ctx.store, makeOp({ tool: toolB, sessionId: 'sess-501-B', timestamp: ts(1000) }), dec('allow', 0.5));
    // tool-C: riskScore=0.1 → avgRisk=0.1
    await saveLog(ctx.store, makeOp({ tool: toolC, sessionId: 'sess-501-C', timestamp: ts(2000) }), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { topRiskTools: { tool: string; avgRisk: number }[] };
    const tools = b.topRiskTools;

    const idxA = tools.findIndex(e => e.tool === toolA);
    const idxB = tools.findIndex(e => e.tool === toolB);
    const idxC = tools.findIndex(e => e.tool === toolC);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxC).toBeGreaterThanOrEqual(0);

    // A (highest risk) should appear before B, B before C
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);
  });

  it('14. topRiskTools avgRisk values are correct', async () => {
    ctx = await setup();
    const toolA = 'tool-501-avg-A';
    const toolB = 'tool-501-avg-B';
    const toolC = 'tool-501-avg-C';

    // tool-A: 2 ops, scores [0.9, 0.9] → avgRisk=0.9
    await saveLog(ctx.store, makeOp({ tool: toolA, sessionId: 'sess-avg-A', timestamp: ts(0) }), dec('allow', 0.9));
    await saveLog(ctx.store, makeOp({ tool: toolA, sessionId: 'sess-avg-A', timestamp: ts(1000) }), dec('allow', 0.9));
    // tool-B: 2 ops, scores [0.4, 0.6] → avgRisk=0.5
    await saveLog(ctx.store, makeOp({ tool: toolB, sessionId: 'sess-avg-B', timestamp: ts(2000) }), dec('allow', 0.4));
    await saveLog(ctx.store, makeOp({ tool: toolB, sessionId: 'sess-avg-B', timestamp: ts(3000) }), dec('allow', 0.6));
    // tool-C: 2 ops, scores [0.1, 0.1] → avgRisk=0.1
    await saveLog(ctx.store, makeOp({ tool: toolC, sessionId: 'sess-avg-C', timestamp: ts(4000) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ tool: toolC, sessionId: 'sess-avg-C', timestamp: ts(5000) }), dec('allow', 0.1));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { topRiskTools: { tool: string; avgRisk: number }[] };
    const tools = b.topRiskTools;

    const entryA = tools.find(e => e.tool === toolA);
    const entryB = tools.find(e => e.tool === toolB);
    const entryC = tools.find(e => e.tool === toolC);
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
    expect(entryC).toBeDefined();
    expect(entryA!.avgRisk).toBeCloseTo(0.9, 5);
    expect(entryB!.avgRisk).toBeCloseTo(0.5, 5);
    expect(entryC!.avgRisk).toBeCloseTo(0.1, 5);
  });

  it('15. topRiskTools descending order with 3 tools inserted in ascending risk order', async () => {
    ctx = await setup();
    // Insert in ascending risk order to verify sorting is not insertion-order
    const toolLow  = 'tool-501-order-low';
    const toolMid  = 'tool-501-order-mid';
    const toolHigh = 'tool-501-order-high';

    await saveLog(ctx.store, makeOp({ tool: toolLow,  sessionId: 'sess-order-low',  timestamp: ts(0) }), dec('allow', 0.1));
    await saveLog(ctx.store, makeOp({ tool: toolMid,  sessionId: 'sess-order-mid',  timestamp: ts(1000) }), dec('allow', 0.5));
    await saveLog(ctx.store, makeOp({ tool: toolHigh, sessionId: 'sess-order-high', timestamp: ts(2000) }), dec('allow', 0.9));

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { topRiskTools: { tool: string; avgRisk: number }[] };

    // Verify each consecutive pair is in descending order
    const risksInOrder = b.topRiskTools.map(e => e.avgRisk);
    for (let i = 1; i < risksInOrder.length; i++) {
      expect(risksInOrder[i]!).toBeLessThanOrEqual(risksInOrder[i - 1]!);
    }

    // Highest risk tool should be first
    expect(b.topRiskTools[0]!.tool).toBe(toolHigh);
  });

  it('16. topRiskTools is capped at 5 when more than 5 tools exist', async () => {
    ctx = await setup();
    const toolList = [
      { name: 'tool-501-cap-1', score: 0.9 },
      { name: 'tool-501-cap-2', score: 0.8 },
      { name: 'tool-501-cap-3', score: 0.7 },
      { name: 'tool-501-cap-4', score: 0.6 },
      { name: 'tool-501-cap-5', score: 0.5 },
      { name: 'tool-501-cap-6', score: 0.4 },
      { name: 'tool-501-cap-7', score: 0.3 },
    ];
    for (let i = 0; i < toolList.length; i++) {
      const t = toolList[i]!;
      await saveLog(
        ctx.store,
        makeOp({ tool: t.name, sessionId: `sess-cap-${i}`, timestamp: ts(i * 1000) }),
        dec('allow', t.score),
      );
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { topRiskTools: { tool: string; avgRisk: number }[] };
    expect(b.topRiskTools.length).toBeLessThanOrEqual(5);
  });
});

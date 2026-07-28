/**
 * v0.80 tests — sort options and uniqueSessionsWithBlocks
 *
 * T517 — GET /tools?sort=pendingRate&order=desc
 *   Create 3 tools:
 *     toolA: 2 require_approval + 1 allow  → pendingRate = 2/3 ≈ 0.67
 *     toolB: 0 require_approval + 3 allow  → pendingRate = 0
 *     toolC: 1 require_approval + 2 allow  → pendingRate = 1/3 ≈ 0.33
 *   Expected order descending: toolA, toolC, toolB
 *
 * T519 — GET /agents?sort=allowRate&order=desc
 *   Create 2 agents:
 *     agentX: 3 allowed + 0 blocked → allowRate = 1.0
 *     agentY: 1 allowed + 2 blocked → allowRate = 1/3 ≈ 0.33
 *   Expected order descending: agentX first
 *
 * T521 — uniqueSessionsWithBlocks in GET /operations/summary
 *   Create 3 sessions:
 *     sessionA: 1 block
 *     sessionB: only allows
 *     sessionC: 1 block
 *   Verify uniqueSessionsWithBlocks === 2
 *
 * Store:  StateStore ':memory:'
 * Server: http.createServer / port 0
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import type { MCPOperation, OperationLog, ProxyDecision } from '../../src/types/interfaces.js';

// ── helpers ────────────────────────────────────────────────────────────────────

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

// ── T517 — GET /tools?sort=pendingRate&order=desc ─────────────────────────────

describe('T517 — GET /tools?sort=pendingRate&order=desc', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. tools are ordered toolA, toolC, toolB when sorted by pendingRate descending', async () => {
    ctx = await setup();

    const BASE = 1_950_000_000_000;
    const toolA = 'tool-517-A';
    const toolB = 'tool-517-B';
    const toolC = 'tool-517-C';

    // toolA: 2 require_approval + 1 allow → pendingRate = 2/3 ≈ 0.667
    await saveLog(ctx.store, makeOp({ tool: toolA, agentId: 'agent-517', sessionId: 'sess-517-A', timestamp: new Date(BASE) }),      dec('require_approval', 0.7), BASE);
    await saveLog(ctx.store, makeOp({ tool: toolA, agentId: 'agent-517', sessionId: 'sess-517-A', timestamp: new Date(BASE + 1_000) }), dec('require_approval', 0.8), BASE + 1_000);
    await saveLog(ctx.store, makeOp({ tool: toolA, agentId: 'agent-517', sessionId: 'sess-517-A', timestamp: new Date(BASE + 2_000) }), dec('allow', 0.1),             BASE + 2_000);

    // toolB: 0 require_approval + 3 allow → pendingRate = 0
    await saveLog(ctx.store, makeOp({ tool: toolB, agentId: 'agent-517', sessionId: 'sess-517-B', timestamp: new Date(BASE + 3_000) }), dec('allow', 0.1), BASE + 3_000);
    await saveLog(ctx.store, makeOp({ tool: toolB, agentId: 'agent-517', sessionId: 'sess-517-B', timestamp: new Date(BASE + 4_000) }), dec('allow', 0.2), BASE + 4_000);
    await saveLog(ctx.store, makeOp({ tool: toolB, agentId: 'agent-517', sessionId: 'sess-517-B', timestamp: new Date(BASE + 5_000) }), dec('allow', 0.3), BASE + 5_000);

    // toolC: 1 require_approval + 2 allow → pendingRate = 1/3 ≈ 0.333
    await saveLog(ctx.store, makeOp({ tool: toolC, agentId: 'agent-517', sessionId: 'sess-517-C', timestamp: new Date(BASE + 6_000) }),  dec('require_approval', 0.6), BASE + 6_000);
    await saveLog(ctx.store, makeOp({ tool: toolC, agentId: 'agent-517', sessionId: 'sess-517-C', timestamp: new Date(BASE + 7_000) }),  dec('allow', 0.2),             BASE + 7_000);
    await saveLog(ctx.store, makeOp({ tool: toolC, agentId: 'agent-517', sessionId: 'sess-517-C', timestamp: new Date(BASE + 8_000) }),  dec('allow', 0.3),             BASE + 8_000);

    const { status, body } = await getJSON(ctx.port, '/tools?sort=pendingRate&order=desc');
    expect(status).toBe(200);

    const b = body as { tools: { tool: string; pendingRate: number }[] };
    expect(Array.isArray(b.tools)).toBe(true);

    const idxA = b.tools.findIndex(t => t.tool === toolA);
    const idxB = b.tools.findIndex(t => t.tool === toolB);
    const idxC = b.tools.findIndex(t => t.tool === toolC);

    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxC).toBeGreaterThanOrEqual(0);

    // toolA (pendingRate≈0.67) should appear before toolC (≈0.33)
    expect(idxA).toBeLessThan(idxC);
    // toolC (pendingRate≈0.33) should appear before toolB (0.0)
    expect(idxC).toBeLessThan(idxB);
  });

  it('2. pendingRate values are correct for each tool', async () => {
    ctx = await setup();

    const BASE = 1_950_100_000_000;
    const toolA = 'tool-517-rates-A';
    const toolC = 'tool-517-rates-C';

    // toolA: 2 require_approval out of 3 → pendingRate ≈ 0.667
    await saveLog(ctx.store, makeOp({ tool: toolA, agentId: 'agent-517r', sessionId: 'sess-517r-A', timestamp: new Date(BASE) }),          dec('require_approval', 0.7), BASE);
    await saveLog(ctx.store, makeOp({ tool: toolA, agentId: 'agent-517r', sessionId: 'sess-517r-A', timestamp: new Date(BASE + 1_000) }),   dec('require_approval', 0.8), BASE + 1_000);
    await saveLog(ctx.store, makeOp({ tool: toolA, agentId: 'agent-517r', sessionId: 'sess-517r-A', timestamp: new Date(BASE + 2_000) }),   dec('allow', 0.1),             BASE + 2_000);

    // toolC: 1 require_approval out of 3 → pendingRate ≈ 0.333
    await saveLog(ctx.store, makeOp({ tool: toolC, agentId: 'agent-517r', sessionId: 'sess-517r-C', timestamp: new Date(BASE + 3_000) }),   dec('require_approval', 0.6), BASE + 3_000);
    await saveLog(ctx.store, makeOp({ tool: toolC, agentId: 'agent-517r', sessionId: 'sess-517r-C', timestamp: new Date(BASE + 4_000) }),   dec('allow', 0.2),             BASE + 4_000);
    await saveLog(ctx.store, makeOp({ tool: toolC, agentId: 'agent-517r', sessionId: 'sess-517r-C', timestamp: new Date(BASE + 5_000) }),   dec('allow', 0.3),             BASE + 5_000);

    const { status, body } = await getJSON(ctx.port, '/tools?sort=pendingRate&order=desc');
    expect(status).toBe(200);

    const b = body as { tools: { tool: string; pendingRate: number }[] };
    const entryA = b.tools.find(t => t.tool === toolA);
    const entryC = b.tools.find(t => t.tool === toolC);

    expect(entryA).toBeDefined();
    expect(entryC).toBeDefined();
    expect(entryA!.pendingRate).toBeCloseTo(2 / 3, 5);
    expect(entryC!.pendingRate).toBeCloseTo(1 / 3, 5);
  });

  it('3. toolB with pendingRate=0 appears last when sorted desc', async () => {
    ctx = await setup();

    const BASE = 1_950_200_000_000;
    const toolA = 'tool-517-last-A';
    const toolB = 'tool-517-last-B';

    // toolA: 1 require_approval + 1 allow → pendingRate = 0.5
    await saveLog(ctx.store, makeOp({ tool: toolA, agentId: 'agent-517L', sessionId: 'sess-517L-A', timestamp: new Date(BASE) }),        dec('require_approval', 0.6), BASE);
    await saveLog(ctx.store, makeOp({ tool: toolA, agentId: 'agent-517L', sessionId: 'sess-517L-A', timestamp: new Date(BASE + 1_000) }), dec('allow', 0.2),             BASE + 1_000);

    // toolB: 0 require_approval + 2 allow → pendingRate = 0
    await saveLog(ctx.store, makeOp({ tool: toolB, agentId: 'agent-517L', sessionId: 'sess-517L-B', timestamp: new Date(BASE + 2_000) }), dec('allow', 0.1), BASE + 2_000);
    await saveLog(ctx.store, makeOp({ tool: toolB, agentId: 'agent-517L', sessionId: 'sess-517L-B', timestamp: new Date(BASE + 3_000) }), dec('allow', 0.2), BASE + 3_000);

    const { status, body } = await getJSON(ctx.port, '/tools?sort=pendingRate&order=desc');
    expect(status).toBe(200);

    const b = body as { tools: { tool: string; pendingRate: number }[] };

    const idxA = b.tools.findIndex(t => t.tool === toolA);
    const idxB = b.tools.findIndex(t => t.tool === toolB);

    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);

    // toolA (0.5) should appear before toolB (0.0)
    expect(idxA).toBeLessThan(idxB);
  });
});

// ── T519 — GET /agents?sort=allowRate&order=desc ──────────────────────────────

describe('T519 — GET /agents?sort=allowRate&order=desc', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('4. agentX (allowRate=1.0) appears before agentY (allowRate≈0.33) when sorted desc', async () => {
    ctx = await setup();

    const BASE = 1_951_000_000_000;
    const agentX = 'agent-519-X';
    const agentY = 'agent-519-Y';

    // agentX: 3 allowed + 0 blocked → allowRate = 1.0
    await saveLog(ctx.store, makeOp({ agentId: agentX, tool: 'tool-519', sessionId: 'sess-519-X', timestamp: new Date(BASE) }),          dec('allow', 0.1), BASE);
    await saveLog(ctx.store, makeOp({ agentId: agentX, tool: 'tool-519', sessionId: 'sess-519-X', timestamp: new Date(BASE + 1_000) }),   dec('allow', 0.2), BASE + 1_000);
    await saveLog(ctx.store, makeOp({ agentId: agentX, tool: 'tool-519', sessionId: 'sess-519-X', timestamp: new Date(BASE + 2_000) }),   dec('allow', 0.1), BASE + 2_000);

    // agentY: 1 allowed + 2 blocked → allowRate = 1/3 ≈ 0.333
    await saveLog(ctx.store, makeOp({ agentId: agentY, tool: 'tool-519', sessionId: 'sess-519-Y', timestamp: new Date(BASE + 3_000) }),   dec('allow', 0.2),  BASE + 3_000);
    await saveLog(ctx.store, makeOp({ agentId: agentY, tool: 'tool-519', sessionId: 'sess-519-Y', timestamp: new Date(BASE + 4_000) }),   dec('block', 0.9),  BASE + 4_000);
    await saveLog(ctx.store, makeOp({ agentId: agentY, tool: 'tool-519', sessionId: 'sess-519-Y', timestamp: new Date(BASE + 5_000) }),   dec('block', 0.85), BASE + 5_000);

    const { status, body } = await getJSON(ctx.port, '/agents?sort=allowRate&order=desc');
    expect(status).toBe(200);

    const b = body as { agents: { agentId: string; allowRate: number }[] };
    expect(Array.isArray(b.agents)).toBe(true);

    const idxX = b.agents.findIndex(a => a.agentId === agentX);
    const idxY = b.agents.findIndex(a => a.agentId === agentY);

    expect(idxX).toBeGreaterThanOrEqual(0);
    expect(idxY).toBeGreaterThanOrEqual(0);

    // agentX (allowRate=1.0) should appear before agentY (allowRate≈0.33)
    expect(idxX).toBeLessThan(idxY);
  });

  it('5. allowRate values are correct for agentX and agentY', async () => {
    ctx = await setup();

    const BASE = 1_951_100_000_000;
    const agentX = 'agent-519-rates-X';
    const agentY = 'agent-519-rates-Y';

    // agentX: 3 allowed → allowRate = 1.0
    await saveLog(ctx.store, makeOp({ agentId: agentX, tool: 'tool-519r', sessionId: 'sess-519r-X', timestamp: new Date(BASE) }),          dec('allow', 0.1), BASE);
    await saveLog(ctx.store, makeOp({ agentId: agentX, tool: 'tool-519r', sessionId: 'sess-519r-X', timestamp: new Date(BASE + 1_000) }),   dec('allow', 0.2), BASE + 1_000);
    await saveLog(ctx.store, makeOp({ agentId: agentX, tool: 'tool-519r', sessionId: 'sess-519r-X', timestamp: new Date(BASE + 2_000) }),   dec('allow', 0.1), BASE + 2_000);

    // agentY: 1 allowed + 2 blocked → allowRate = 1/3
    await saveLog(ctx.store, makeOp({ agentId: agentY, tool: 'tool-519r', sessionId: 'sess-519r-Y', timestamp: new Date(BASE + 3_000) }),   dec('allow', 0.2),  BASE + 3_000);
    await saveLog(ctx.store, makeOp({ agentId: agentY, tool: 'tool-519r', sessionId: 'sess-519r-Y', timestamp: new Date(BASE + 4_000) }),   dec('block', 0.9),  BASE + 4_000);
    await saveLog(ctx.store, makeOp({ agentId: agentY, tool: 'tool-519r', sessionId: 'sess-519r-Y', timestamp: new Date(BASE + 5_000) }),   dec('block', 0.85), BASE + 5_000);

    const { status, body } = await getJSON(ctx.port, '/agents?sort=allowRate&order=desc');
    expect(status).toBe(200);

    const b = body as { agents: { agentId: string; allowRate: number }[] };
    const entryX = b.agents.find(a => a.agentId === agentX);
    const entryY = b.agents.find(a => a.agentId === agentY);

    expect(entryX).toBeDefined();
    expect(entryY).toBeDefined();
    expect(entryX!.allowRate).toBeCloseTo(1.0, 5);
    expect(entryY!.allowRate).toBeCloseTo(1 / 3, 5);
  });

  it('6. sort=allowRate&order=asc places lower allowRate first', async () => {
    ctx = await setup();

    const BASE = 1_951_200_000_000;
    const agentX = 'agent-519-asc-X';
    const agentY = 'agent-519-asc-Y';

    // agentX: 3 allowed → allowRate = 1.0
    await saveLog(ctx.store, makeOp({ agentId: agentX, tool: 'tool-519a', sessionId: 'sess-519a-X', timestamp: new Date(BASE) }),          dec('allow', 0.1), BASE);
    await saveLog(ctx.store, makeOp({ agentId: agentX, tool: 'tool-519a', sessionId: 'sess-519a-X', timestamp: new Date(BASE + 1_000) }),   dec('allow', 0.1), BASE + 1_000);
    await saveLog(ctx.store, makeOp({ agentId: agentX, tool: 'tool-519a', sessionId: 'sess-519a-X', timestamp: new Date(BASE + 2_000) }),   dec('allow', 0.1), BASE + 2_000);

    // agentY: 1 allowed + 2 blocked → allowRate = 1/3 ≈ 0.333
    await saveLog(ctx.store, makeOp({ agentId: agentY, tool: 'tool-519a', sessionId: 'sess-519a-Y', timestamp: new Date(BASE + 3_000) }),   dec('allow', 0.2),  BASE + 3_000);
    await saveLog(ctx.store, makeOp({ agentId: agentY, tool: 'tool-519a', sessionId: 'sess-519a-Y', timestamp: new Date(BASE + 4_000) }),   dec('block', 0.9),  BASE + 4_000);
    await saveLog(ctx.store, makeOp({ agentId: agentY, tool: 'tool-519a', sessionId: 'sess-519a-Y', timestamp: new Date(BASE + 5_000) }),   dec('block', 0.85), BASE + 5_000);

    const { status, body } = await getJSON(ctx.port, '/agents?sort=allowRate&order=asc');
    expect(status).toBe(200);

    const b = body as { agents: { agentId: string; allowRate: number }[] };

    const idxX = b.agents.findIndex(a => a.agentId === agentX);
    const idxY = b.agents.findIndex(a => a.agentId === agentY);

    expect(idxX).toBeGreaterThanOrEqual(0);
    expect(idxY).toBeGreaterThanOrEqual(0);

    // ascending: agentY (0.33) should appear before agentX (1.0)
    expect(idxY).toBeLessThan(idxX);
  });
});

// ── T521 — uniqueSessionsWithBlocks in GET /operations/summary ────────────────

describe('T521 — uniqueSessionsWithBlocks in GET /operations/summary', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('7. uniqueSessionsWithBlocks === 2 when 2 of 3 sessions have at least one block', async () => {
    ctx = await setup();

    const BASE = 1_952_000_000_000;
    const sessionA = 'sess-521-A';  // has 1 block
    const sessionB = 'sess-521-B';  // only allows
    const sessionC = 'sess-521-C';  // has 1 block

    // sessionA: 1 allow + 1 block
    await saveLog(ctx.store, makeOp({ agentId: 'agent-521', tool: 'tool-521', sessionId: sessionA, timestamp: new Date(BASE) }),          dec('allow', 0.2), BASE);
    await saveLog(ctx.store, makeOp({ agentId: 'agent-521', tool: 'tool-521', sessionId: sessionA, timestamp: new Date(BASE + 1_000) }),   dec('block', 0.9), BASE + 1_000);

    // sessionB: 2 allows, no blocks
    await saveLog(ctx.store, makeOp({ agentId: 'agent-521', tool: 'tool-521', sessionId: sessionB, timestamp: new Date(BASE + 2_000) }),   dec('allow', 0.1), BASE + 2_000);
    await saveLog(ctx.store, makeOp({ agentId: 'agent-521', tool: 'tool-521', sessionId: sessionB, timestamp: new Date(BASE + 3_000) }),   dec('allow', 0.2), BASE + 3_000);

    // sessionC: 1 allow + 1 block
    await saveLog(ctx.store, makeOp({ agentId: 'agent-521', tool: 'tool-521', sessionId: sessionC, timestamp: new Date(BASE + 4_000) }),   dec('allow', 0.1), BASE + 4_000);
    await saveLog(ctx.store, makeOp({ agentId: 'agent-521', tool: 'tool-521', sessionId: sessionC, timestamp: new Date(BASE + 5_000) }),   dec('block', 0.85), BASE + 5_000);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { uniqueSessionsWithBlocks: number };
    expect(b.uniqueSessionsWithBlocks).toBe(2);
  });

  it('8. uniqueSessionsWithBlocks field is present and numeric in the summary response', async () => {
    ctx = await setup();

    const BASE = 1_952_100_000_000;

    const op = makeOp({ agentId: 'agent-521-p', tool: 'tool-521-p', sessionId: 'sess-521-p', timestamp: new Date(BASE) });
    await saveLog(ctx.store, op, dec('allow', 0.1), BASE);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect('uniqueSessionsWithBlocks' in b).toBe(true);
    expect(typeof b['uniqueSessionsWithBlocks']).toBe('number');
  });

  it('9. uniqueSessionsWithBlocks === 0 when no sessions have any blocks', async () => {
    ctx = await setup();

    const BASE = 1_952_200_000_000;

    // All ops are allowed — no blocks
    await saveLog(ctx.store, makeOp({ agentId: 'agent-521-z', tool: 'tool-521', sessionId: 'sess-521-Z1', timestamp: new Date(BASE) }),          dec('allow', 0.1), BASE);
    await saveLog(ctx.store, makeOp({ agentId: 'agent-521-z', tool: 'tool-521', sessionId: 'sess-521-Z2', timestamp: new Date(BASE + 1_000) }),   dec('allow', 0.2), BASE + 1_000);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { uniqueSessionsWithBlocks: number };
    expect(b.uniqueSessionsWithBlocks).toBe(0);
  });

  it('10. uniqueSessionsWithBlocks counts each session once even when it has multiple blocks', async () => {
    ctx = await setup();

    const BASE = 1_952_300_000_000;
    const sessionA = 'sess-521-multi-A';  // 3 blocks — still counts as 1
    const sessionB = 'sess-521-multi-B';  // 2 blocks — still counts as 1

    // sessionA: 3 blocks
    await saveLog(ctx.store, makeOp({ agentId: 'agent-521-m', tool: 'tool-521', sessionId: sessionA, timestamp: new Date(BASE) }),          dec('block', 0.9),  BASE);
    await saveLog(ctx.store, makeOp({ agentId: 'agent-521-m', tool: 'tool-521', sessionId: sessionA, timestamp: new Date(BASE + 1_000) }),   dec('block', 0.85), BASE + 1_000);
    await saveLog(ctx.store, makeOp({ agentId: 'agent-521-m', tool: 'tool-521', sessionId: sessionA, timestamp: new Date(BASE + 2_000) }),   dec('block', 0.95), BASE + 2_000);

    // sessionB: 2 blocks
    await saveLog(ctx.store, makeOp({ agentId: 'agent-521-m', tool: 'tool-521', sessionId: sessionB, timestamp: new Date(BASE + 3_000) }),   dec('block', 0.9),  BASE + 3_000);
    await saveLog(ctx.store, makeOp({ agentId: 'agent-521-m', tool: 'tool-521', sessionId: sessionB, timestamp: new Date(BASE + 4_000) }),   dec('block', 0.8),  BASE + 4_000);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { uniqueSessionsWithBlocks: number };
    // 2 distinct sessions with blocks, not 5 (the total block count)
    expect(b.uniqueSessionsWithBlocks).toBe(2);
  });

  it('11. uniqueSessionsWithBlocks === 0 when there are no operations at all', async () => {
    ctx = await setup();

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);

    const b = body as { uniqueSessionsWithBlocks: number };
    expect(b.uniqueSessionsWithBlocks).toBe(0);
  });
});

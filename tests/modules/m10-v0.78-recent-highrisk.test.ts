/**
 * v0.78 tests
 *
 * T507 — recentHighRiskOps in GET /agents/:agentId
 *   Create 3 ops with riskScore 0.9, 0.5, 0.8 for the same agent.
 *   Verify recentHighRiskOps contains exactly the 2 ops with riskScore >= 0.7
 *   (scores 0.9 and 0.8), sorted by timestamp DESC (most recent first).
 *   Verify each entry has: operationId, tool, method, action, riskScore, timestamp.
 *
 * T508 — recentHighRiskOps in GET /tools/:tool
 *   Same pattern for a tool with some high-risk and some low-risk ops.
 *   Verify recentHighRiskOps only includes ops with riskScore >= 0.7, max 5.
 *
 * T511 — totalOps in GET /sessions
 *   Create 2 sessions — session-A with 3 ops, session-B with 2 ops.
 *   Query GET /sessions and verify totalOps in the response equals 5.
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
  createdAtMs: number,
): Promise<void> {
  const log: OperationLog = {
    operationId: op.id,
    operation: op,
    decision,
    createdAt: new Date(createdAtMs),
  };
  await store.saveOperationLog(log);
}

// ── T507 — recentHighRiskOps in GET /agents/:agentId ──────────────────────────

describe('T507 — recentHighRiskOps in GET /agents/:agentId', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. recentHighRiskOps contains exactly 2 ops (riskScore 0.9 and 0.8), not the 0.5 op', async () => {
    ctx = await setup();

    const agentId = 'agent-507-count';
    const BASE = 1_800_000_000_000;

    // Op 1: riskScore 0.9 — most recent
    const op1 = makeOp({ id: crypto.randomUUID(), agentId, tool: 'fs', method: 'write_file', sessionId: 'sess-507', timestamp: new Date(BASE + 2_000) });
    await saveLog(ctx.store, op1, dec('block', 0.9), BASE + 2_000);

    // Op 2: riskScore 0.5 — middle
    const op2 = makeOp({ id: crypto.randomUUID(), agentId, tool: 'fs', method: 'read_file', sessionId: 'sess-507', timestamp: new Date(BASE + 1_000) });
    await saveLog(ctx.store, op2, dec('allow', 0.5), BASE + 1_000);

    // Op 3: riskScore 0.8 — oldest
    const op3 = makeOp({ id: crypto.randomUUID(), agentId, tool: 'db', method: 'delete_record', sessionId: 'sess-507', timestamp: new Date(BASE) });
    await saveLog(ctx.store, op3, dec('block', 0.8), BASE);

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as { recentHighRiskOps: unknown[] };
    expect(Array.isArray(b.recentHighRiskOps)).toBe(true);
    expect(b.recentHighRiskOps).toHaveLength(2);
  });

  it('2. recentHighRiskOps does not include the op with riskScore 0.5', async () => {
    ctx = await setup();

    const agentId = 'agent-507-exclude';
    const BASE = 1_800_100_000_000;

    const op1 = makeOp({ id: crypto.randomUUID(), agentId, tool: 'fs', method: 'write_file', sessionId: 'sess-507b', timestamp: new Date(BASE + 2_000) });
    await saveLog(ctx.store, op1, dec('block', 0.9), BASE + 2_000);

    const op2 = makeOp({ id: crypto.randomUUID(), agentId, tool: 'fs', method: 'read_file', sessionId: 'sess-507b', timestamp: new Date(BASE + 1_000) });
    await saveLog(ctx.store, op2, dec('allow', 0.5), BASE + 1_000);

    const op3 = makeOp({ id: crypto.randomUUID(), agentId, tool: 'db', method: 'delete_record', sessionId: 'sess-507b', timestamp: new Date(BASE) });
    await saveLog(ctx.store, op3, dec('block', 0.8), BASE);

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as { recentHighRiskOps: { riskScore: number }[] };
    const scores = b.recentHighRiskOps.map(e => e.riskScore);
    expect(scores).not.toContain(0.5);
    expect(scores.every(s => s >= 0.7)).toBe(true);
  });

  it('3. recentHighRiskOps is sorted DESC by timestamp — 0.9 before 0.8', async () => {
    ctx = await setup();

    const agentId = 'agent-507-sort';
    const BASE = 1_800_200_000_000;

    // Op with riskScore 0.9 is most recent (BASE + 2000)
    const op1 = makeOp({ id: crypto.randomUUID(), agentId, tool: 'fs', method: 'write_file', sessionId: 'sess-507c', timestamp: new Date(BASE + 2_000) });
    await saveLog(ctx.store, op1, dec('block', 0.9), BASE + 2_000);

    // Op with riskScore 0.5 — excluded
    const op2 = makeOp({ id: crypto.randomUUID(), agentId, tool: 'fs', method: 'read_file', sessionId: 'sess-507c', timestamp: new Date(BASE + 1_000) });
    await saveLog(ctx.store, op2, dec('allow', 0.5), BASE + 1_000);

    // Op with riskScore 0.8 is oldest (BASE)
    const op3 = makeOp({ id: crypto.randomUUID(), agentId, tool: 'db', method: 'delete_record', sessionId: 'sess-507c', timestamp: new Date(BASE) });
    await saveLog(ctx.store, op3, dec('block', 0.8), BASE);

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as { recentHighRiskOps: { riskScore: number; timestamp: string }[] };
    expect(b.recentHighRiskOps).toHaveLength(2);
    // First entry should be the most recent (riskScore 0.9), second should be riskScore 0.8
    expect(b.recentHighRiskOps[0]!.riskScore).toBe(0.9);
    expect(b.recentHighRiskOps[1]!.riskScore).toBe(0.8);
    // Timestamps should be in descending order
    const ts0 = new Date(b.recentHighRiskOps[0]!.timestamp).getTime();
    const ts1 = new Date(b.recentHighRiskOps[1]!.timestamp).getTime();
    expect(ts0).toBeGreaterThan(ts1);
  });

  it('4. each recentHighRiskOps entry has fields: operationId, tool, method, action, riskScore, timestamp', async () => {
    ctx = await setup();

    const agentId = 'agent-507-fields';
    const BASE = 1_800_300_000_000;

    const op1 = makeOp({ id: crypto.randomUUID(), agentId, tool: 'fs', method: 'write_file', sessionId: 'sess-507d', timestamp: new Date(BASE) });
    await saveLog(ctx.store, op1, dec('block', 0.9), BASE);

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as { recentHighRiskOps: Record<string, unknown>[] };
    expect(b.recentHighRiskOps.length).toBeGreaterThan(0);
    const entry = b.recentHighRiskOps[0]!;
    expect(typeof entry['operationId']).toBe('string');
    expect(typeof entry['tool']).toBe('string');
    expect(typeof entry['method']).toBe('string');
    expect(typeof entry['action']).toBe('string');
    expect(typeof entry['riskScore']).toBe('number');
    expect(typeof entry['timestamp']).toBe('string');
  });

  it('5. recentHighRiskOps field values match the logged operation', async () => {
    ctx = await setup();

    const agentId = 'agent-507-values';
    const BASE = 1_800_400_000_000;
    const opId = crypto.randomUUID();

    const op = makeOp({ id: opId, agentId, tool: 'github', method: 'delete_repo', sessionId: 'sess-507e', timestamp: new Date(BASE) });
    await saveLog(ctx.store, op, dec('block', 0.95), BASE);

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as { recentHighRiskOps: { operationId: string; tool: string; method: string; action: string; riskScore: number; timestamp: string }[] };
    expect(b.recentHighRiskOps).toHaveLength(1);
    const entry = b.recentHighRiskOps[0]!;
    expect(entry.operationId).toBe(opId);
    expect(entry.tool).toBe('github');
    expect(entry.method).toBe('delete_repo');
    expect(entry.action).toBe('block');
    expect(entry.riskScore).toBe(0.95);
  });

  it('6. recentHighRiskOps is empty when all ops are below 0.7', async () => {
    ctx = await setup();

    const agentId = 'agent-507-empty';
    const BASE = 1_800_500_000_000;

    const op1 = makeOp({ id: crypto.randomUUID(), agentId, tool: 'fs', method: 'read_file', sessionId: 'sess-507f', timestamp: new Date(BASE) });
    await saveLog(ctx.store, op1, dec('allow', 0.3), BASE);

    const op2 = makeOp({ id: crypto.randomUUID(), agentId, tool: 'fs', method: 'list_dir', sessionId: 'sess-507f', timestamp: new Date(BASE + 1_000) });
    await saveLog(ctx.store, op2, dec('allow', 0.1), BASE + 1_000);

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);
    const b = body as { recentHighRiskOps: unknown[] };
    expect(b.recentHighRiskOps).toHaveLength(0);
  });
});

// ── T508 — recentHighRiskOps in GET /tools/:tool ──────────────────────────────

describe('T508 — recentHighRiskOps in GET /tools/:tool', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('7. recentHighRiskOps only contains ops with riskScore >= 0.7', async () => {
    ctx = await setup();

    const tool = 'tool-508-filter';
    const BASE = 1_801_000_000_000;

    // High-risk ops
    const op1 = makeOp({ id: crypto.randomUUID(), agentId: 'agent-a', tool, method: 'write', sessionId: 'sess-508', timestamp: new Date(BASE + 3_000) });
    await saveLog(ctx.store, op1, dec('block', 0.9), BASE + 3_000);

    const op2 = makeOp({ id: crypto.randomUUID(), agentId: 'agent-a', tool, method: 'delete', sessionId: 'sess-508', timestamp: new Date(BASE + 2_000) });
    await saveLog(ctx.store, op2, dec('block', 0.85), BASE + 2_000);

    // Low-risk ops
    const op3 = makeOp({ id: crypto.randomUUID(), agentId: 'agent-b', tool, method: 'read', sessionId: 'sess-508', timestamp: new Date(BASE + 1_000) });
    await saveLog(ctx.store, op3, dec('allow', 0.2), BASE + 1_000);

    const op4 = makeOp({ id: crypto.randomUUID(), agentId: 'agent-b', tool, method: 'list', sessionId: 'sess-508', timestamp: new Date(BASE) });
    await saveLog(ctx.store, op4, dec('allow', 0.1), BASE);

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as { recentHighRiskOps: { riskScore: number }[] };
    expect(Array.isArray(b.recentHighRiskOps)).toBe(true);
    expect(b.recentHighRiskOps.every(e => e.riskScore >= 0.7)).toBe(true);
  });

  it('8. recentHighRiskOps count is exactly 2 for tool with 2 high-risk and 2 low-risk ops', async () => {
    ctx = await setup();

    const tool = 'tool-508-count';
    const BASE = 1_801_100_000_000;

    // 2 high-risk
    for (let i = 0; i < 2; i++) {
      const createdAtMs = BASE + (2 + i) * 1_000;
      const op = makeOp({ id: crypto.randomUUID(), agentId: 'agent-a', tool, method: 'write', sessionId: 'sess-508b', timestamp: new Date(createdAtMs) });
      await saveLog(ctx.store, op, dec('block', 0.8 + i * 0.05), createdAtMs);
    }
    // 2 low-risk
    for (let i = 0; i < 2; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({ id: crypto.randomUUID(), agentId: 'agent-b', tool, method: 'read', sessionId: 'sess-508b', timestamp: new Date(createdAtMs) });
      await saveLog(ctx.store, op, dec('allow', 0.2), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as { recentHighRiskOps: unknown[] };
    expect(b.recentHighRiskOps).toHaveLength(2);
  });

  it('9. recentHighRiskOps is capped at 5 even when more than 5 high-risk ops exist', async () => {
    ctx = await setup();

    const tool = 'tool-508-cap';
    const BASE = 1_801_200_000_000;

    // 7 high-risk ops
    for (let i = 0; i < 7; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({ id: crypto.randomUUID(), agentId: 'agent-a', tool, method: 'write', sessionId: 'sess-508c', timestamp: new Date(createdAtMs) });
      await saveLog(ctx.store, op, dec('block', 0.9), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as { recentHighRiskOps: unknown[] };
    expect(b.recentHighRiskOps.length).toBeLessThanOrEqual(5);
  });

  it('10. recentHighRiskOps is present as an array field in the tool response', async () => {
    ctx = await setup();

    const tool = 'tool-508-present';
    const BASE = 1_801_300_000_000;

    const op = makeOp({ id: crypto.randomUUID(), agentId: 'agent-a', tool, method: 'write', sessionId: 'sess-508d', timestamp: new Date(BASE) });
    await saveLog(ctx.store, op, dec('block', 0.9), BASE);

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect('recentHighRiskOps' in b).toBe(true);
    expect(Array.isArray(b['recentHighRiskOps'])).toBe(true);
  });

  it('11. recentHighRiskOps is empty when tool has no high-risk ops', async () => {
    ctx = await setup();

    const tool = 'tool-508-empty';
    const BASE = 1_801_400_000_000;

    // Only low-risk ops
    for (let i = 0; i < 3; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({ id: crypto.randomUUID(), agentId: 'agent-b', tool, method: 'read', sessionId: 'sess-508e', timestamp: new Date(createdAtMs) });
      await saveLog(ctx.store, op, dec('allow', 0.3), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as { recentHighRiskOps: unknown[] };
    expect(b.recentHighRiskOps).toHaveLength(0);
  });

  it('12. recentHighRiskOps entries have operationId, method, action, riskScore, timestamp fields', async () => {
    ctx = await setup();

    const tool = 'tool-508-fields';
    const BASE = 1_801_500_000_000;

    const op = makeOp({ id: crypto.randomUUID(), agentId: 'agent-a', tool, method: 'delete', sessionId: 'sess-508f', timestamp: new Date(BASE) });
    await saveLog(ctx.store, op, dec('block', 0.75), BASE);

    const { status, body } = await getJSON(ctx.port, `/tools/${tool}`);
    expect(status).toBe(200);
    const b = body as { recentHighRiskOps: Record<string, unknown>[] };
    expect(b.recentHighRiskOps.length).toBeGreaterThan(0);
    const entry = b.recentHighRiskOps[0]!;
    expect(typeof entry['operationId']).toBe('string');
    expect(typeof entry['method']).toBe('string');
    expect(typeof entry['action']).toBe('string');
    expect(typeof entry['riskScore']).toBe('number');
    expect(typeof entry['timestamp']).toBe('string');
  });
});

// ── T511 — totalOps in GET /sessions ──────────────────────────────────────────

describe('T511 — totalOps in GET /sessions', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('13. totalOps equals 5 when session-A has 3 ops and session-B has 2 ops', async () => {
    ctx = await setup();

    const BASE = 1_802_000_000_000;
    const agentId = 'agent-511';

    // session-A: 3 ops
    for (let i = 0; i < 3; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({ id: crypto.randomUUID(), agentId, tool: 'fs', method: 'write', sessionId: 'session-A', timestamp: new Date(createdAtMs) });
      await saveLog(ctx.store, op, dec('allow', 0.2), createdAtMs);
    }

    // session-B: 2 ops
    for (let i = 0; i < 2; i++) {
      const createdAtMs = BASE + 10_000 + i * 1_000;
      const op = makeOp({ id: crypto.randomUUID(), agentId, tool: 'db', method: 'read', sessionId: 'session-B', timestamp: new Date(createdAtMs) });
      await saveLog(ctx.store, op, dec('allow', 0.1), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { totalOps: number };
    expect(b.totalOps).toBe(5);
  });

  it('14. totalOps is present as a numeric field in the sessions response', async () => {
    ctx = await setup();

    const BASE = 1_802_100_000_000;
    const op = makeOp({ id: crypto.randomUUID(), agentId: 'agent-511b', tool: 'fs', method: 'read', sessionId: 'sess-511b', timestamp: new Date(BASE) });
    await saveLog(ctx.store, op, dec('allow', 0.1), BASE);

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect('totalOps' in b).toBe(true);
    expect(typeof b['totalOps']).toBe('number');
  });

  it('15. totalOps is 0 when there are no sessions', async () => {
    ctx = await setup();

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { totalOps: number };
    expect(b.totalOps).toBe(0);
  });

  it('16. totalOps reflects sum across multiple sessions with varying op counts', async () => {
    ctx = await setup();

    const BASE = 1_802_200_000_000;
    const agentId = 'agent-511c';

    // session-A: 3 ops, session-B: 2 ops, total = 5
    const sessionOps: { sessionId: string; count: number }[] = [
      { sessionId: 'sess-511-A', count: 3 },
      { sessionId: 'sess-511-B', count: 2 },
    ];

    let offset = 0;
    for (const { sessionId, count } of sessionOps) {
      for (let i = 0; i < count; i++) {
        const createdAtMs = BASE + offset * 1_000;
        const op = makeOp({ id: crypto.randomUUID(), agentId, tool: 'fs', method: 'call', sessionId, timestamp: new Date(createdAtMs) });
        await saveLog(ctx.store, op, dec('allow', 0.2), createdAtMs);
        offset++;
      }
    }

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { totalOps: number };
    expect(b.totalOps).toBe(5);
  });

  it('17. totalOps equals operationCount sum across all sessions in the data array', async () => {
    ctx = await setup();

    const BASE = 1_802_300_000_000;
    const agentId = 'agent-511d';

    // 3 different sessions with different op counts
    const sessions = [
      { sessionId: 'sess-511-d1', count: 4 },
      { sessionId: 'sess-511-d2', count: 1 },
      { sessionId: 'sess-511-d3', count: 3 },
    ];

    let offset = 0;
    for (const { sessionId, count } of sessions) {
      for (let i = 0; i < count; i++) {
        const createdAtMs = BASE + offset * 1_000;
        const op = makeOp({ id: crypto.randomUUID(), agentId, tool: 'fs', method: 'call', sessionId, timestamp: new Date(createdAtMs) });
        await saveLog(ctx.store, op, dec('allow', 0.1), createdAtMs);
        offset++;
      }
    }

    const { status, body } = await getJSON(ctx.port, '/sessions');
    expect(status).toBe(200);
    const b = body as { totalOps: number; data: { operationCount: number }[] };
    // totalOps must equal the sum of operationCount across all session entries
    const sumFromData = b.data.reduce((sum, s) => sum + s.operationCount, 0);
    expect(b.totalOps).toBe(sumFromData);
    // And the absolute total is 8 (4+1+3)
    expect(b.totalOps).toBe(8);
  });
});

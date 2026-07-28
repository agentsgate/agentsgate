/**
 * v0.77 tests
 *
 * T502/T503 — blockTrend and avgRiskTrend in GET /operations/summary
 *   The summary endpoint takes all logs (ordered DESC by created_at) and
 *   splits them into:
 *     last10  = logs[0..9]   (most recently created)
 *     prev10  = logs[10..19] (older)
 *   rising  when last10 metric > prev10 metric + 0.05
 *   falling when last10 metric < prev10 metric - 0.05
 *   stable  when prev10 is empty OR difference ≤ 0.05
 *
 * T506 — topMethods in GET /sessions/:sessionId
 *   Array of { method, count } sorted descending by count, capped at 5.
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

/**
 * Save a log with an explicit createdAt so we control DESC ordering.
 * Higher createdAtMs  → appears earlier in DESC result (= more recent, in last10).
 * Lower  createdAtMs  → appears later in DESC result  (= older,  in prev10).
 */
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

// ── T502/T503 — blockTrend and avgRiskTrend ───────────────────────────────────

describe('T502/T503 — blockTrend and avgRiskTrend in GET /operations/summary', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. blockTrend is "rising" when last10 blockRate=1.0 > prev10 blockRate=0.0', async () => {
    ctx = await setup();

    const BASE = 1_700_000_000_000;
    // 20 ops total.
    // We want the first 10 in DESC order (last10, most recent) to all be blocked with riskScore=0.9.
    // The next 10 in DESC order (prev10, older) to all be allow with riskScore=0.1.
    // Higher createdAtMs = comes first in DESC = goes into last10.
    for (let i = 0; i < 10; i++) {
      // last10: createdAt in range [BASE+10000 .. BASE+19000] — more recent
      const createdAtMs = BASE + 10_000 + i * 1_000;
      const op = makeOp({
        id: crypto.randomUUID(),
        sessionId: 'sess-trend-rising',
        timestamp: new Date(createdAtMs),
      });
      await saveLog(ctx.store, op, dec('block', 0.9), createdAtMs);
    }
    for (let i = 0; i < 10; i++) {
      // prev10: createdAt in range [BASE+0 .. BASE+9000] — older
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({
        id: crypto.randomUUID(),
        sessionId: 'sess-trend-rising',
        timestamp: new Date(createdAtMs),
      });
      await saveLog(ctx.store, op, dec('allow', 0.1), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['blockTrend']).toBe('rising');
  });

  it('2. avgRiskTrend is "rising" when last10 avgRisk=0.9 > prev10 avgRisk=0.1', async () => {
    ctx = await setup();

    const BASE = 1_700_100_000_000;
    for (let i = 0; i < 10; i++) {
      // last10 (most recent): riskScore=0.9
      const createdAtMs = BASE + 10_000 + i * 1_000;
      const op = makeOp({
        id: crypto.randomUUID(),
        sessionId: 'sess-risk-rising',
        timestamp: new Date(createdAtMs),
      });
      await saveLog(ctx.store, op, dec('block', 0.9), createdAtMs);
    }
    for (let i = 0; i < 10; i++) {
      // prev10 (older): riskScore=0.1
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({
        id: crypto.randomUUID(),
        sessionId: 'sess-risk-rising',
        timestamp: new Date(createdAtMs),
      });
      await saveLog(ctx.store, op, dec('allow', 0.1), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['avgRiskTrend']).toBe('rising');
  });

  it('3. blockTrend and avgRiskTrend are both "stable" when fewer than 11 ops (prev10 is empty)', async () => {
    ctx = await setup();

    const BASE = 1_700_200_000_000;
    // Only 5 ops — prev10 will be empty, both trends must be 'stable'
    for (let i = 0; i < 5; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({
        id: crypto.randomUUID(),
        sessionId: 'sess-trend-stable',
        timestamp: new Date(createdAtMs),
      });
      await saveLog(ctx.store, op, dec('block', 0.9), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['blockTrend']).toBe('stable');
    expect(b['avgRiskTrend']).toBe('stable');
  });

  it('4. blockTrend and avgRiskTrend fields are present in the response', async () => {
    ctx = await setup();

    const BASE = 1_700_300_000_000;
    const op = makeOp({ id: crypto.randomUUID(), sessionId: 'sess-fields', timestamp: new Date(BASE) });
    await saveLog(ctx.store, op, dec('allow', 0.5), BASE);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect('blockTrend' in b).toBe(true);
    expect('avgRiskTrend' in b).toBe(true);
  });

  it('5. blockTrend and avgRiskTrend values are valid trend strings', async () => {
    ctx = await setup();

    const BASE = 1_700_400_000_000;
    for (let i = 0; i < 20; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({
        id: crypto.randomUUID(),
        sessionId: 'sess-valid-trend',
        timestamp: new Date(createdAtMs),
      });
      await saveLog(ctx.store, op, dec('allow', 0.3), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(['rising', 'falling', 'stable']).toContain(b['blockTrend']);
    expect(['rising', 'falling', 'stable']).toContain(b['avgRiskTrend']);
  });
});

// ── T506 — topMethods in GET /sessions/:sessionId ─────────────────────────────

describe('T506 — topMethods in GET /sessions/:sessionId', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('6. topMethods is present and is an array', async () => {
    ctx = await setup();

    const sessionId = 'sess-506-present';
    const BASE = 1_700_500_000_000;
    const op = makeOp({ id: crypto.randomUUID(), sessionId, method: 'tools/call', timestamp: new Date(BASE) });
    await saveLog(ctx.store, op, dec('allow', 0.1), BASE);

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['topMethods']).toBeDefined();
    expect(Array.isArray(b['topMethods'])).toBe(true);
  });

  it('7. topMethods entries have method and count fields', async () => {
    ctx = await setup();

    const sessionId = 'sess-506-fields';
    const BASE = 1_700_600_000_000;
    const op = makeOp({ id: crypto.randomUUID(), sessionId, method: 'tools/call', timestamp: new Date(BASE) });
    await saveLog(ctx.store, op, dec('allow', 0.1), BASE);

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { topMethods: Record<string, unknown>[] };
    expect(b.topMethods.length).toBeGreaterThan(0);
    const entry = b.topMethods[0]!;
    expect(typeof entry['method']).toBe('string');
    expect(typeof entry['count']).toBe('number');
  });

  it('8. topMethods sorted by count desc: tools/call (3) before tools/list (2)', async () => {
    ctx = await setup();

    const sessionId = 'sess-506-sort';
    const BASE = 1_700_700_000_000;

    // 3 ops with method 'tools/call'
    for (let i = 0; i < 3; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({
        id: crypto.randomUUID(),
        sessionId,
        method: 'tools/call',
        timestamp: new Date(createdAtMs),
      });
      await saveLog(ctx.store, op, dec('allow', 0.1), createdAtMs);
    }
    // 2 ops with method 'tools/list'
    for (let i = 0; i < 2; i++) {
      const createdAtMs = BASE + 10_000 + i * 1_000;
      const op = makeOp({
        id: crypto.randomUUID(),
        sessionId,
        method: 'tools/list',
        timestamp: new Date(createdAtMs),
      });
      await saveLog(ctx.store, op, dec('allow', 0.2), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { topMethods: { method: string; count: number }[] };

    expect(b.topMethods.length).toBeGreaterThanOrEqual(2);
    // First entry must be tools/call with count=3
    expect(b.topMethods[0]!.method).toBe('tools/call');
    expect(b.topMethods[0]!.count).toBe(3);
  });

  it('9. topMethods first entry has method tools/call and count 3', async () => {
    ctx = await setup();

    const sessionId = 'sess-506-first';
    const BASE = 1_700_800_000_000;

    // 3 ops with method 'tools/call'
    for (let i = 0; i < 3; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({
        id: crypto.randomUUID(),
        sessionId,
        method: 'tools/call',
        timestamp: new Date(createdAtMs),
      });
      await saveLog(ctx.store, op, dec('allow', 0.1), createdAtMs);
    }
    // 2 ops with method 'tools/list'
    for (let i = 0; i < 2; i++) {
      const createdAtMs = BASE + 10_000 + i * 1_000;
      const op = makeOp({
        id: crypto.randomUUID(),
        sessionId,
        method: 'tools/list',
        timestamp: new Date(createdAtMs),
      });
      await saveLog(ctx.store, op, dec('allow', 0.2), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { topMethods: { method: string; count: number }[] };
    const first = b.topMethods[0]!;
    expect(first.method).toBe('tools/call');
    expect(first.count).toBe(3);
  });

  it('10. topMethods second entry is tools/list with count 2', async () => {
    ctx = await setup();

    const sessionId = 'sess-506-second';
    const BASE = 1_700_900_000_000;

    // 3 ops with method 'tools/call'
    for (let i = 0; i < 3; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({
        id: crypto.randomUUID(),
        sessionId,
        method: 'tools/call',
        timestamp: new Date(createdAtMs),
      });
      await saveLog(ctx.store, op, dec('allow', 0.1), createdAtMs);
    }
    // 2 ops with method 'tools/list'
    for (let i = 0; i < 2; i++) {
      const createdAtMs = BASE + 10_000 + i * 1_000;
      const op = makeOp({
        id: crypto.randomUUID(),
        sessionId,
        method: 'tools/list',
        timestamp: new Date(createdAtMs),
      });
      await saveLog(ctx.store, op, dec('allow', 0.2), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { topMethods: { method: string; count: number }[] };
    const second = b.topMethods[1]!;
    expect(second.method).toBe('tools/list');
    expect(second.count).toBe(2);
  });

  it('11. topMethods is capped at 5 when more than 5 distinct methods exist', async () => {
    ctx = await setup();

    const sessionId = 'sess-506-cap';
    const BASE = 1_701_000_000_000;
    const methods = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];

    for (let i = 0; i < methods.length; i++) {
      const createdAtMs = BASE + i * 1_000;
      const op = makeOp({
        id: crypto.randomUUID(),
        sessionId,
        method: methods[i]!,
        timestamp: new Date(createdAtMs),
      });
      await saveLog(ctx.store, op, dec('allow', 0.1), createdAtMs);
    }

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { topMethods: { method: string; count: number }[] };
    expect(b.topMethods.length).toBeLessThanOrEqual(5);
  });

  it('12. topMethods entries are in descending order of count', async () => {
    ctx = await setup();

    const sessionId = 'sess-506-desc';
    const BASE = 1_701_100_000_000;

    // 4 ops: methodA, 3 ops: methodB, 2 ops: methodC, 1 op: methodD
    const counts = [
      { method: 'methodA', count: 4 },
      { method: 'methodB', count: 3 },
      { method: 'methodC', count: 2 },
      { method: 'methodD', count: 1 },
    ];
    let offset = 0;
    for (const { method, count } of counts) {
      for (let i = 0; i < count; i++) {
        const createdAtMs = BASE + offset * 1_000;
        const op = makeOp({
          id: crypto.randomUUID(),
          sessionId,
          method,
          timestamp: new Date(createdAtMs),
        });
        await saveLog(ctx.store, op, dec('allow', 0.1), createdAtMs);
        offset++;
      }
    }

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as { topMethods: { method: string; count: number }[] };
    const countsInOrder = b.topMethods.map(e => e.count);
    for (let i = 1; i < countsInOrder.length; i++) {
      expect(countsInOrder[i]!).toBeLessThanOrEqual(countsInOrder[i - 1]!);
    }
  });
});

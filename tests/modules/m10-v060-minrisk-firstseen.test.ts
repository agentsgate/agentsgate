/**
 * v0.60 tests
 *
 * T416 — GET /sessions/:sessionId returns minRisk field
 *         (minimum riskScore across all ops in that session)
 *         Also asserts maxRisk, avgRisk, blockRate are present.
 *
 * T417 — GET /operations/summary returns firstSeen and lastSeen
 *         firstSeen is the earliest operation timestamp ISO string,
 *         lastSeen is the latest. When no ops exist both are undefined.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import type { MCPOperation, OperationLog, ProxyDecision } from '../../src/types/interfaces.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeOp(agentId: string, tool: string, extra: Partial<MCPOperation> = {}): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId,
    tool,
    method: 'tools/call',
    params: {},
    timestamp: new Date(),
    ...extra,
  };
}

function dec(action: ProxyDecision['action'], riskScore: number): ProxyDecision {
  return { action, riskScore, reasons: [], checkpointId: undefined };
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
  const port = ((dash as unknown as { server: http.Server }).server.address() as { port: number }).port;
  return { store, dash, port };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
}

async function getJSON(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

// ── T416 — GET /sessions/:sessionId returns minRisk ───────────────────────────

describe('GET /sessions/:sessionId — minRisk (T416)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed three logs for the same session with riskScores 0.1, 0.5, 0.9.
   * minRisk should be 0.1, maxRisk 0.9, avgRisk ~0.5, blockRate 1/3.
   */
  async function seedSessionLogs(ctx: Ctx, sessionId: string): Promise<void> {
    const entries: Array<{ riskScore: number; action: ProxyDecision['action'] }> = [
      { riskScore: 0.1, action: 'allow' },
      { riskScore: 0.5, action: 'allow' },
      { riskScore: 0.9, action: 'block' },
    ];
    for (const e of entries) {
      const op = makeOp('agent-a', 'tool-x', { sessionId });
      const log: OperationLog = {
        operationId: op.id,
        operation: op,
        decision: dec(e.action, e.riskScore),
        createdAt: new Date(),
      };
      await ctx.store.saveOperationLog(log);
    }
  }

  it('1. minRisk is present in GET /sessions/:sessionId response', async () => {
    ctx = await setup();
    const sessionId = 'sess-minrisk-present';
    await seedSessionLogs(ctx, sessionId);

    const { status, body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['minRisk']).toBeDefined();
  });

  it('2. minRisk equals 0.1 (the minimum riskScore in the session)', async () => {
    ctx = await setup();
    const sessionId = 'sess-minrisk-value';
    await seedSessionLogs(ctx, sessionId);

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as { minRisk: number };
    expect(b.minRisk).toBeCloseTo(0.1, 5);
  });

  it('3. maxRisk is present in session detail response', async () => {
    ctx = await setup();
    const sessionId = 'sess-maxrisk-present';
    await seedSessionLogs(ctx, sessionId);

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as Record<string, unknown>;
    expect(b['maxRisk']).toBeDefined();
  });

  it('4. maxRisk equals 0.9 (the maximum riskScore in the session)', async () => {
    ctx = await setup();
    const sessionId = 'sess-maxrisk-value';
    await seedSessionLogs(ctx, sessionId);

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as { maxRisk: number };
    expect(b.maxRisk).toBeCloseTo(0.9, 5);
  });

  it('5. avgRisk is present in session detail response', async () => {
    ctx = await setup();
    const sessionId = 'sess-avgrisk-present';
    await seedSessionLogs(ctx, sessionId);

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as Record<string, unknown>;
    // The field may be avgRisk or avgRiskScore — check both
    const hasAvg = 'avgRisk' in b || 'avgRiskScore' in b;
    expect(hasAvg).toBe(true);
  });

  it('6. avgRisk is approximately 0.5 (mean of 0.1, 0.5, 0.9)', async () => {
    ctx = await setup();
    const sessionId = 'sess-avgrisk-value';
    await seedSessionLogs(ctx, sessionId);

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as Record<string, number>;
    const avg = b['avgRisk'] ?? b['avgRiskScore'];
    expect(avg).toBeDefined();
    expect(avg!).toBeCloseTo(0.5, 5);
  });

  it('7. blockRate is present in session detail response', async () => {
    ctx = await setup();
    const sessionId = 'sess-blockrate-present';
    await seedSessionLogs(ctx, sessionId);

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as Record<string, unknown>;
    expect(b['blockRate']).toBeDefined();
  });

  it('8. blockRate equals ~0.333 (1 blocked out of 3 ops)', async () => {
    ctx = await setup();
    const sessionId = 'sess-blockrate-value';
    await seedSessionLogs(ctx, sessionId);

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as { blockRate: number };
    expect(b.blockRate).toBeCloseTo(1 / 3, 5);
  });

  it('9. minRisk is 0 when session has a single op with riskScore 0', async () => {
    ctx = await setup();
    const sessionId = 'sess-zero-risk';
    const op = makeOp('agent-b', 'tool-y', { sessionId });
    await ctx.store.saveOperationLog({
      operationId: op.id,
      operation: op,
      decision: dec('allow', 0),
      createdAt: new Date(),
    });

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as { minRisk: number };
    expect(b.minRisk).toBeCloseTo(0, 5);
  });

  it('10. minRisk is a number type', async () => {
    ctx = await setup();
    const sessionId = 'sess-minrisk-type';
    await seedSessionLogs(ctx, sessionId);

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as { minRisk: unknown };
    expect(typeof b.minRisk).toBe('number');
  });

  it('11. minRisk is always <= maxRisk', async () => {
    ctx = await setup();
    const sessionId = 'sess-minmax-order';
    await seedSessionLogs(ctx, sessionId);

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as { minRisk: number; maxRisk: number };
    expect(b.minRisk).toBeLessThanOrEqual(b.maxRisk);
  });

  it('12. single-op session: minRisk equals maxRisk equals that op riskScore', async () => {
    ctx = await setup();
    const sessionId = 'sess-single-op';
    const op = makeOp('agent-c', 'tool-z', { sessionId });
    await ctx.store.saveOperationLog({
      operationId: op.id,
      operation: op,
      decision: dec('block', 0.77),
      createdAt: new Date(),
    });

    const { body } = await getJSON(ctx.port, `/sessions/${sessionId}`);
    const b = body as { minRisk: number; maxRisk: number };
    expect(b.minRisk).toBeCloseTo(0.77, 5);
    expect(b.maxRisk).toBeCloseTo(0.77, 5);
  });
});

// ── T417 — GET /operations/summary returns firstSeen and lastSeen ─────────────

describe('GET /operations/summary — firstSeen and lastSeen (T417)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seeds three ops with operation.timestamp values spread 1 hour apart:
   *   tOld:    3 hours ago
   *   tMid:    2 hours ago
   *   tRecent: 1 hour ago
   * Returns the three timestamps for assertion use.
   */
  async function seedTimedOps(ctx: Ctx): Promise<{ tOld: Date; tMid: Date; tRecent: Date }> {
    const now = Date.now();
    const tOld    = new Date(now - 3 * 60 * 60 * 1000);
    const tMid    = new Date(now - 2 * 60 * 60 * 1000);
    const tRecent = new Date(now - 1 * 60 * 60 * 1000);

    const timestamps = [tOld, tMid, tRecent];
    const agents     = ['agent-a', 'agent-b', 'agent-c'];
    const tools      = ['tool-old', 'tool-mid', 'tool-recent'];

    for (let i = 0; i < 3; i++) {
      const ts = timestamps[i]!;
      const op = makeOp(agents[i]!, tools[i]!, { timestamp: ts });
      const log: OperationLog = {
        operationId: op.id,
        operation: op,
        decision: dec('allow', 0.2),
        createdAt: new Date(ts),
      };
      await ctx.store.saveOperationLog(log);
    }

    return { tOld, tMid, tRecent };
  }

  it('13. firstSeen is present in /operations/summary response when ops exist', async () => {
    ctx = await setup();
    await seedTimedOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['firstSeen']).toBeDefined();
  });

  it('14. lastSeen is present in /operations/summary response when ops exist', async () => {
    ctx = await setup();
    await seedTimedOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as Record<string, unknown>;
    expect(b['lastSeen']).toBeDefined();
  });

  it('15. firstSeen equals the earliest operation timestamp (tOld)', async () => {
    ctx = await setup();
    const { tOld } = await seedTimedOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { firstSeen: string };
    expect(b.firstSeen).toBe(tOld.toISOString());
  });

  it('16. lastSeen equals the latest operation timestamp (tRecent)', async () => {
    ctx = await setup();
    const { tRecent } = await seedTimedOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { lastSeen: string };
    expect(b.lastSeen).toBe(tRecent.toISOString());
  });

  it('17. firstSeen <= lastSeen (chronological ordering holds)', async () => {
    ctx = await setup();
    await seedTimedOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { firstSeen: string; lastSeen: string };
    expect(b.firstSeen <= b.lastSeen).toBe(true);
  });

  it('18. firstSeen is a valid ISO 8601 string', async () => {
    ctx = await setup();
    await seedTimedOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { firstSeen: string };
    expect(() => new Date(b.firstSeen)).not.toThrow();
    expect(new Date(b.firstSeen).toISOString()).toBe(b.firstSeen);
  });

  it('19. lastSeen is a valid ISO 8601 string', async () => {
    ctx = await setup();
    await seedTimedOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { lastSeen: string };
    expect(() => new Date(b.lastSeen)).not.toThrow();
    expect(new Date(b.lastSeen).toISOString()).toBe(b.lastSeen);
  });

  it('20. firstSeen is undefined when no ops exist', async () => {
    ctx = await setup();
    // Fresh DB — no ops seeded

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['firstSeen']).toBeUndefined();
  });

  it('21. lastSeen is undefined when no ops exist', async () => {
    ctx = await setup();
    // Fresh DB — no ops seeded

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as Record<string, unknown>;
    expect(b['lastSeen']).toBeUndefined();
  });

  it('22. single-op: firstSeen === lastSeen === that op timestamp', async () => {
    ctx = await setup();
    const ts = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    const op = makeOp('agent-solo', 'tool-solo', { timestamp: ts });
    await ctx.store.saveOperationLog({
      operationId: op.id,
      operation: op,
      decision: dec('allow', 0.3),
      createdAt: new Date(ts),
    });

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { firstSeen: string; lastSeen: string };
    expect(b.firstSeen).toBe(ts.toISOString());
    expect(b.lastSeen).toBe(ts.toISOString());
    expect(b.firstSeen).toBe(b.lastSeen);
  });

  it('23. firstSeen and lastSeen are both string type when ops exist', async () => {
    ctx = await setup();
    await seedTimedOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { firstSeen: unknown; lastSeen: unknown };
    expect(typeof b.firstSeen).toBe('string');
    expect(typeof b.lastSeen).toBe('string');
  });

  it('24. adding a newer op updates lastSeen but not firstSeen', async () => {
    ctx = await setup();
    const { tOld, tRecent } = await seedTimedOps(ctx);

    const { body: body1 } = await getJSON(ctx.port, '/operations/summary');
    const b1 = body1 as { firstSeen: string; lastSeen: string };
    expect(b1.firstSeen).toBe(tOld.toISOString());
    expect(b1.lastSeen).toBe(tRecent.toISOString());

    // Add a newer op (30 minutes from now)
    const tNewer = new Date(Date.now() + 30 * 60 * 1000);
    const op = makeOp('agent-newer', 'tool-new', { timestamp: tNewer });
    await ctx.store.saveOperationLog({
      operationId: op.id,
      operation: op,
      decision: dec('block', 0.8),
      createdAt: new Date(tNewer),
    });

    const { body: body2 } = await getJSON(ctx.port, '/operations/summary');
    const b2 = body2 as { firstSeen: string; lastSeen: string };
    // firstSeen should remain tOld
    expect(b2.firstSeen).toBe(tOld.toISOString());
    // lastSeen should now be tNewer
    expect(b2.lastSeen).toBe(tNewer.toISOString());
  });
});

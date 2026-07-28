/**
 * v0.67 tests
 *
 * T449 — GET /agents returns minRiskScore per agent
 * T450 — GET /tools returns minRiskScore per tool
 * T451 — GET /agents/:agentId returns riskTrend
 * T452 — GET /operations/summary returns p50RiskScore and p95RiskScore
 * T453 — GET /tools/:tool returns medianRiskScore
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import type { MCPOperation, OperationLog, ProxyDecision } from '../../src/types/interfaces.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeOp(
  agentId: string,
  tool: string,
  overrides: Partial<MCPOperation> = {}
): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId,
    tool,
    method: 'call',
    params: {},
    timestamp: new Date(),
    sessionId: 'sess-default',
    ...overrides,
  };
}

function dec(
  action: ProxyDecision['action'] = 'allow',
  riskScore = 0.1
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

// ── T449 — GET /agents returns minRiskScore per agent ─────────────────────────

describe('GET /agents — minRiskScore per agent (T449)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed 3 ops for agent-M with riskScores 0.1, 0.5, 0.9.
   * minRiskScore should be 0.1, maxRiskScore should be 0.9.
   */
  async function seedAgentMOps(ctx: Ctx): Promise<void> {
    const scores = [0.1, 0.5, 0.9];
    for (const riskScore of scores) {
      const op = makeOp('agent-M', 'tool-any');
      const log: OperationLog = {
        operationId: op.id,
        operation: op,
        decision: dec('allow', riskScore),
        createdAt: new Date(),
      };
      await ctx.store.saveOperationLog(log);
    }
  }

  it('1. minRiskScore is present in GET /agents response per agent entry', async () => {
    ctx = await setup();
    await seedAgentMOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents');
    expect(status).toBe(200);
    const b = body as { agents: Array<Record<string, unknown>> };
    const agentM = b.agents.find(a => a['agentId'] === 'agent-M');
    expect(agentM).toBeDefined();
    expect(agentM!['minRiskScore']).toBeDefined();
  });

  it('2. agent-M minRiskScore === 0.1 (the minimum riskScore)', async () => {
    ctx = await setup();
    await seedAgentMOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; minRiskScore: number }> };
    const agentM = b.agents.find(a => a.agentId === 'agent-M');
    expect(agentM).toBeDefined();
    expect(agentM!.minRiskScore).toBeCloseTo(0.1, 5);
  });

  it('3. agent-M maxRiskScore === 0.9 (the maximum riskScore)', async () => {
    ctx = await setup();
    await seedAgentMOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; maxRiskScore: number }> };
    const agentM = b.agents.find(a => a.agentId === 'agent-M');
    expect(agentM).toBeDefined();
    expect(agentM!.maxRiskScore).toBeCloseTo(0.9, 5);
  });

  it('4. minRiskScore is a number type', async () => {
    ctx = await setup();
    await seedAgentMOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; minRiskScore: unknown }> };
    const agentM = b.agents.find(a => a.agentId === 'agent-M');
    expect(agentM).toBeDefined();
    expect(typeof agentM!.minRiskScore).toBe('number');
  });

  it('5. minRiskScore is always <= maxRiskScore for agent-M', async () => {
    ctx = await setup();
    await seedAgentMOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; minRiskScore: number; maxRiskScore: number }> };
    const agentM = b.agents.find(a => a.agentId === 'agent-M');
    expect(agentM).toBeDefined();
    expect(agentM!.minRiskScore).toBeLessThanOrEqual(agentM!.maxRiskScore);
  });

  it('6. single-op agent has minRiskScore === maxRiskScore === that op riskScore', async () => {
    ctx = await setup();
    const op = makeOp('agent-solo', 'tool-x');
    await ctx.store.saveOperationLog({
      operationId: op.id,
      operation: op,
      decision: dec('allow', 0.42),
      createdAt: new Date(),
    });

    const { body } = await getJSON(ctx.port, '/agents');
    const b = body as { agents: Array<{ agentId: string; minRiskScore: number; maxRiskScore: number }> };
    const agent = b.agents.find(a => a.agentId === 'agent-solo');
    expect(agent).toBeDefined();
    expect(agent!.minRiskScore).toBeCloseTo(0.42, 5);
    expect(agent!.maxRiskScore).toBeCloseTo(0.42, 5);
  });
});

// ── T450 — GET /tools returns minRiskScore per tool ───────────────────────────

describe('GET /tools — minRiskScore per tool (T450)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed 3 ops for tool='network_fetch' with riskScores 0.2, 0.4, 0.8.
   * minRiskScore should be 0.2.
   */
  async function seedNetworkFetchOps(ctx: Ctx): Promise<void> {
    const scores = [0.2, 0.4, 0.8];
    for (const riskScore of scores) {
      const op = makeOp('agent-x', 'network_fetch');
      const log: OperationLog = {
        operationId: op.id,
        operation: op,
        decision: dec('allow', riskScore),
        createdAt: new Date(),
      };
      await ctx.store.saveOperationLog(log);
    }
  }

  it('7. minRiskScore is present in GET /tools response per tool entry', async () => {
    ctx = await setup();
    await seedNetworkFetchOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools');
    expect(status).toBe(200);
    const b = body as { tools: Array<Record<string, unknown>> };
    const tool = b.tools.find(t => t['tool'] === 'network_fetch');
    expect(tool).toBeDefined();
    expect(tool!['minRiskScore']).toBeDefined();
  });

  it('8. network_fetch minRiskScore === 0.2 (the minimum riskScore)', async () => {
    ctx = await setup();
    await seedNetworkFetchOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string; minRiskScore: number }> };
    const toolEntry = b.tools.find(t => t.tool === 'network_fetch');
    expect(toolEntry).toBeDefined();
    expect(toolEntry!.minRiskScore).toBeCloseTo(0.2, 5);
  });

  it('9. minRiskScore is a number type in /tools list', async () => {
    ctx = await setup();
    await seedNetworkFetchOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string; minRiskScore: unknown }> };
    const toolEntry = b.tools.find(t => t.tool === 'network_fetch');
    expect(toolEntry).toBeDefined();
    expect(typeof toolEntry!.minRiskScore).toBe('number');
  });

  it('10. minRiskScore is always <= maxRiskScore for network_fetch', async () => {
    ctx = await setup();
    await seedNetworkFetchOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string; minRiskScore: number; maxRiskScore: number }> };
    const toolEntry = b.tools.find(t => t.tool === 'network_fetch');
    expect(toolEntry).toBeDefined();
    expect(toolEntry!.minRiskScore).toBeLessThanOrEqual(toolEntry!.maxRiskScore);
  });

  it('11. single-op tool has minRiskScore === maxRiskScore === that op riskScore', async () => {
    ctx = await setup();
    const op = makeOp('agent-y', 'tool-unique-solo');
    await ctx.store.saveOperationLog({
      operationId: op.id,
      operation: op,
      decision: dec('block', 0.77),
      createdAt: new Date(),
    });

    const { body } = await getJSON(ctx.port, '/tools');
    const b = body as { tools: Array<{ tool: string; minRiskScore: number; maxRiskScore: number }> };
    const toolEntry = b.tools.find(t => t.tool === 'tool-unique-solo');
    expect(toolEntry).toBeDefined();
    expect(toolEntry!.minRiskScore).toBeCloseTo(0.77, 5);
    expect(toolEntry!.maxRiskScore).toBeCloseTo(0.77, 5);
  });
});

// ── T451 — GET /agents/:agentId returns riskTrend ────────────────────────────

describe('GET /agents/:agentId — riskTrend (T451)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed 20 ops for agent-N.
   * First 10 (oldest, lowest createdAt): riskScore 0.3
   * Next 10 (newest, highest createdAt): riskScore 0.8
   *
   * Since logs are fetched DESC (newest first):
   *   last10 (indices 0..9)  → newest 10 → risk 0.8 → last10Avg = 0.8
   *   prev10 (indices 10..19) → oldest 10 → risk 0.3 → prev10Avg = 0.3
   *   0.8 > 0.3 + 0.05 → riskTrend = 'rising'
   */
  async function seedAgentNOps(ctx: Ctx): Promise<void> {
    const now = Date.now();

    // First 10: oldest ops, risk 0.3
    for (let i = 0; i < 10; i++) {
      const createdAt = new Date(now - (20 - i) * 1000);
      const op = makeOp('agent-N', 'tool-low', { timestamp: createdAt });
      const log: OperationLog = {
        operationId: op.id,
        operation: op,
        decision: dec('allow', 0.3),
        createdAt,
      };
      await ctx.store.saveOperationLog(log);
    }

    // Next 10: newest ops, risk 0.8
    for (let i = 0; i < 10; i++) {
      const createdAt = new Date(now - (10 - i) * 1000);
      const op = makeOp('agent-N', 'tool-high', { timestamp: createdAt });
      const log: OperationLog = {
        operationId: op.id,
        operation: op,
        decision: dec('block', 0.8),
        createdAt,
      };
      await ctx.store.saveOperationLog(log);
    }
  }

  it('12. riskTrend is present in GET /agents/:agentId response', async () => {
    ctx = await setup();
    await seedAgentNOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/agents/agent-N');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['riskTrend']).toBeDefined();
  });

  it('13. riskTrend === "rising" when newest 10 ops avg (0.8) > oldest 10 ops avg (0.3) + 0.05', async () => {
    ctx = await setup();
    await seedAgentNOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-N');
    const b = body as { riskTrend: string };
    expect(b.riskTrend).toBe('rising');
  });

  it('14. riskTrend is a string type', async () => {
    ctx = await setup();
    await seedAgentNOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-N');
    const b = body as { riskTrend: unknown };
    expect(typeof b.riskTrend).toBe('string');
  });

  it('15. riskTrend === "stable" when only 1 op exists (prev10 is empty)', async () => {
    ctx = await setup();
    const op = makeOp('agent-N-single', 'tool-x');
    await ctx.store.saveOperationLog({
      operationId: op.id,
      operation: op,
      decision: dec('allow', 0.5),
      createdAt: new Date(),
    });

    const { status, body } = await getJSON(ctx.port, '/agents/agent-N-single');
    expect(status).toBe(200);
    const b = body as { riskTrend: string };
    expect(b.riskTrend).toBe('stable');
  });

  it('16. riskTrend is one of "rising", "falling", or "stable"', async () => {
    ctx = await setup();
    await seedAgentNOps(ctx);

    const { body } = await getJSON(ctx.port, '/agents/agent-N');
    const b = body as { riskTrend: string };
    expect(['rising', 'falling', 'stable']).toContain(b.riskTrend);
  });

  it('17. riskTrend === "stable" when last10Avg equals prev10Avg (all same risk)', async () => {
    ctx = await setup();
    const now = Date.now();
    // 20 ops all with same risk score 0.5
    for (let i = 0; i < 20; i++) {
      const createdAt = new Date(now - (20 - i) * 1000);
      const op = makeOp('agent-N-stable', 'tool-flat', { timestamp: createdAt });
      await ctx.store.saveOperationLog({
        operationId: op.id,
        operation: op,
        decision: dec('allow', 0.5),
        createdAt,
      });
    }

    const { body } = await getJSON(ctx.port, '/agents/agent-N-stable');
    const b = body as { riskTrend: string };
    expect(b.riskTrend).toBe('stable');
  });

  it('18. riskTrend === "falling" when newest ops avg < oldest ops avg - 0.05', async () => {
    ctx = await setup();
    const now = Date.now();

    // First 10: oldest, high risk 0.8
    for (let i = 0; i < 10; i++) {
      const createdAt = new Date(now - (20 - i) * 1000);
      const op = makeOp('agent-N-fall', 'tool-high', { timestamp: createdAt });
      await ctx.store.saveOperationLog({
        operationId: op.id,
        operation: op,
        decision: dec('block', 0.8),
        createdAt,
      });
    }

    // Next 10: newest, low risk 0.2
    for (let i = 0; i < 10; i++) {
      const createdAt = new Date(now - (10 - i) * 1000);
      const op = makeOp('agent-N-fall', 'tool-low', { timestamp: createdAt });
      await ctx.store.saveOperationLog({
        operationId: op.id,
        operation: op,
        decision: dec('allow', 0.2),
        createdAt,
      });
    }

    const { body } = await getJSON(ctx.port, '/agents/agent-N-fall');
    const b = body as { riskTrend: string };
    expect(b.riskTrend).toBe('falling');
  });
});

// ── T452 — GET /operations/summary returns p50RiskScore and p95RiskScore ──────

describe('GET /operations/summary — p50RiskScore and p95RiskScore (T452)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed 20 ops with riskScores 0.05, 0.10, 0.15, ..., 1.0 (step 0.05).
   * Sorted ascending: [0.05, 0.10, 0.15, ..., 1.0]
   * p50 index = Math.floor(20 * 0.50) = 10 → value = 0.55 (between 0.45 and 0.55 inclusive)
   * p95 index = Math.floor(20 * 0.95) = 19 → value = 1.0 (between 0.85 and 1.0 inclusive)
   */
  async function seedPercentileOps(ctx: Ctx): Promise<void> {
    for (let i = 1; i <= 20; i++) {
      const riskScore = parseFloat((i * 0.05).toFixed(2));
      const op = makeOp('agent-pct', 'tool-pct');
      const log: OperationLog = {
        operationId: op.id,
        operation: op,
        decision: dec('allow', riskScore),
        createdAt: new Date(),
      };
      await ctx.store.saveOperationLog(log);
    }
  }

  it('19. p50RiskScore is present in GET /operations/summary response', async () => {
    ctx = await setup();
    await seedPercentileOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['p50RiskScore']).toBeDefined();
  });

  it('20. p95RiskScore is present in GET /operations/summary response', async () => {
    ctx = await setup();
    await seedPercentileOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as Record<string, unknown>;
    expect(b['p95RiskScore']).toBeDefined();
  });

  it('21. p50RiskScore is between 0.45 and 0.55 (50th percentile of 20 evenly spaced scores)', async () => {
    ctx = await setup();
    await seedPercentileOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { p50RiskScore: number };
    expect(b.p50RiskScore).toBeGreaterThanOrEqual(0.45);
    expect(b.p50RiskScore).toBeLessThanOrEqual(0.55);
  });

  it('22. p95RiskScore is between 0.85 and 1.0 (95th percentile of 20 evenly spaced scores)', async () => {
    ctx = await setup();
    await seedPercentileOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { p95RiskScore: number };
    expect(b.p95RiskScore).toBeGreaterThanOrEqual(0.85);
    expect(b.p95RiskScore).toBeLessThanOrEqual(1.0);
  });

  it('23. p50RiskScore is a number type', async () => {
    ctx = await setup();
    await seedPercentileOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { p50RiskScore: unknown };
    expect(typeof b.p50RiskScore).toBe('number');
  });

  it('24. p95RiskScore is a number type', async () => {
    ctx = await setup();
    await seedPercentileOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { p95RiskScore: unknown };
    expect(typeof b.p95RiskScore).toBe('number');
  });

  it('25. p50RiskScore <= p95RiskScore (percentile ordering holds)', async () => {
    ctx = await setup();
    await seedPercentileOps(ctx);

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { p50RiskScore: number; p95RiskScore: number };
    expect(b.p50RiskScore).toBeLessThanOrEqual(b.p95RiskScore);
  });

  it('26. p50RiskScore and p95RiskScore are 0 when no ops exist', async () => {
    ctx = await setup();
    // Fresh DB — no ops seeded

    const { status, body } = await getJSON(ctx.port, '/operations/summary');
    expect(status).toBe(200);
    const b = body as { p50RiskScore: number; p95RiskScore: number };
    expect(b.p50RiskScore).toBe(0);
    expect(b.p95RiskScore).toBe(0);
  });

  it('27. single-op: p50RiskScore === p95RiskScore === that op riskScore', async () => {
    ctx = await setup();
    const op = makeOp('agent-one', 'tool-one');
    await ctx.store.saveOperationLog({
      operationId: op.id,
      operation: op,
      decision: dec('allow', 0.65),
      createdAt: new Date(),
    });

    const { body } = await getJSON(ctx.port, '/operations/summary');
    const b = body as { p50RiskScore: number; p95RiskScore: number };
    expect(b.p50RiskScore).toBeCloseTo(0.65, 5);
    expect(b.p95RiskScore).toBeCloseTo(0.65, 5);
  });
});

// ── T453 — GET /tools/:tool returns medianRiskScore ───────────────────────────

describe('GET /tools/:tool — medianRiskScore (T453)', () => {
  let ctx: Ctx;

  afterEach(async () => { if (ctx) await teardown(ctx); });

  /**
   * Seed 5 ops for tool='sql_exec' with riskScores 0.1, 0.3, 0.5, 0.7, 0.9.
   * Odd count — median = middle element = 0.5.
   */
  async function seedSqlExecOps(ctx: Ctx): Promise<void> {
    const scores = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (const riskScore of scores) {
      const op = makeOp('agent-sql', 'sql_exec');
      const log: OperationLog = {
        operationId: op.id,
        operation: op,
        decision: dec('allow', riskScore),
        createdAt: new Date(),
      };
      await ctx.store.saveOperationLog(log);
    }
  }

  /**
   * Seed 4 ops for tool='file_move' with riskScores 0.2, 0.4, 0.6, 0.8.
   * Even count — median = (0.4 + 0.6) / 2 = 0.5.
   */
  async function seedFileMoveOps(ctx: Ctx): Promise<void> {
    const scores = [0.2, 0.4, 0.6, 0.8];
    for (const riskScore of scores) {
      const op = makeOp('agent-file', 'file_move');
      const log: OperationLog = {
        operationId: op.id,
        operation: op,
        decision: dec('allow', riskScore),
        createdAt: new Date(),
      };
      await ctx.store.saveOperationLog(log);
    }
  }

  it('28. medianRiskScore is present in GET /tools/:tool response', async () => {
    ctx = await setup();
    await seedSqlExecOps(ctx);

    const { status, body } = await getJSON(ctx.port, '/tools/sql_exec');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['medianRiskScore']).toBeDefined();
  });

  it('29. sql_exec medianRiskScore === 0.5 (odd count, middle value)', async () => {
    ctx = await setup();
    await seedSqlExecOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools/sql_exec');
    const b = body as { medianRiskScore: number };
    expect(b.medianRiskScore).toBeCloseTo(0.5, 5);
  });

  it('30. file_move medianRiskScore === 0.5 (even count, avg of two middle values: (0.4+0.6)/2)', async () => {
    ctx = await setup();
    await seedFileMoveOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools/file_move');
    const b = body as { medianRiskScore: number };
    expect(b.medianRiskScore).toBeCloseTo(0.5, 5);
  });

  it('31. medianRiskScore is a number type', async () => {
    ctx = await setup();
    await seedSqlExecOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools/sql_exec');
    const b = body as { medianRiskScore: unknown };
    expect(typeof b.medianRiskScore).toBe('number');
  });

  it('32. single-op tool: medianRiskScore equals that op riskScore', async () => {
    ctx = await setup();
    const op = makeOp('agent-z', 'tool-single-median');
    await ctx.store.saveOperationLog({
      operationId: op.id,
      operation: op,
      decision: dec('allow', 0.33),
      createdAt: new Date(),
    });

    const { body } = await getJSON(ctx.port, '/tools/tool-single-median');
    const b = body as { medianRiskScore: number };
    expect(b.medianRiskScore).toBeCloseTo(0.33, 5);
  });

  it('33. two-op tool: medianRiskScore equals average of the two riskScores', async () => {
    ctx = await setup();
    for (const riskScore of [0.2, 0.8]) {
      const op = makeOp('agent-z', 'tool-two-median');
      await ctx.store.saveOperationLog({
        operationId: op.id,
        operation: op,
        decision: dec('allow', riskScore),
        createdAt: new Date(),
      });
    }

    const { body } = await getJSON(ctx.port, '/tools/tool-two-median');
    const b = body as { medianRiskScore: number };
    // median of [0.2, 0.8] = (0.2 + 0.8) / 2 = 0.5
    expect(b.medianRiskScore).toBeCloseTo(0.5, 5);
  });

  it('34. sql_exec (5 ops) medianRiskScore is between 0.4 and 0.6', async () => {
    ctx = await setup();
    await seedSqlExecOps(ctx);

    const { body } = await getJSON(ctx.port, '/tools/sql_exec');
    const b = body as { medianRiskScore: number };
    expect(b.medianRiskScore).toBeGreaterThanOrEqual(0.4);
    expect(b.medianRiskScore).toBeLessThanOrEqual(0.6);
  });
});

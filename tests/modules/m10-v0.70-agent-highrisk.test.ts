/**
 * v0.70 — T468: GET /agents/:agentId returns `highRiskCount`
 *
 * highRiskCount = number of ops for the agent where riskScore >= 0.7.
 * Boundary: exactly 0.7 counts; 0.69 does not.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { OperationLogger } from '../../src/modules/m3-logger/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeOp(agentId: string, overrides: Partial<MCPOperation> = {}): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId,
    tool: 'fs',
    method: 'call',
    params: {},
    timestamp: new Date(),
    sessionId: 'sess-highrisk',
    ...overrides,
  };
}

function dec(riskScore: number, action: ProxyDecision['action'] = 'allow'): ProxyDecision {
  return { action, riskScore, reasons: [] };
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
  path: string
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

// ── T468 — highRiskCount on GET /agents/:agentId ──────────────────────────────

describe('GET /agents/:agentId — highRiskCount (T468)', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  // ── Test 1: highRiskCount is 0 when no ops have riskScore >= 0.7 ─────────────

  it('1. highRiskCount is 0 when no ops have riskScore >= 0.7', async () => {
    ctx = await setup();
    const agentId = 'agent-highrisk-zero';

    // All ops below the threshold
    await ctx.logger.log(makeOp(agentId, { id: crypto.randomUUID() }), dec(0.1));
    await ctx.logger.log(makeOp(agentId, { id: crypto.randomUUID() }), dec(0.5));
    await ctx.logger.log(makeOp(agentId, { id: crypto.randomUUID() }), dec(0.69));

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as { highRiskCount: number };
    expect(b.highRiskCount).toBe(0);
  });

  // ── Test 2: boundary — exactly 0.7 counts, 0.69 does not ────────────────────

  it('2. highRiskCount counts ops with riskScore >= 0.7 (0.7 counts, 0.69 does not)', async () => {
    ctx = await setup();
    const agentId = 'agent-highrisk-boundary';

    // Below threshold — should NOT count
    await ctx.logger.log(makeOp(agentId, { id: crypto.randomUUID() }), dec(0.69));
    await ctx.logger.log(makeOp(agentId, { id: crypto.randomUUID() }), dec(0.5));

    // At and above threshold — should count
    await ctx.logger.log(makeOp(agentId, { id: crypto.randomUUID() }), dec(0.7));   // boundary
    await ctx.logger.log(makeOp(agentId, { id: crypto.randomUUID() }), dec(0.8));
    await ctx.logger.log(makeOp(agentId, { id: crypto.randomUUID() }), dec(1.0));

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as { highRiskCount: number; totalOps: number };
    // 3 ops qualify (0.7, 0.8, 1.0)
    expect(b.highRiskCount).toBe(3);
    // Sanity: total ops matches what was inserted
    expect(b.totalOps).toBe(5);
  });

  // ── Test 3: highRiskCount is present alongside other agent fields ─────────────

  it('3. highRiskCount is present alongside other agent fields', async () => {
    ctx = await setup();
    const agentId = 'agent-highrisk-fields';

    await ctx.logger.log(makeOp(agentId, { id: crypto.randomUUID() }), dec(0.3, 'allow'));
    await ctx.logger.log(makeOp(agentId, { id: crypto.randomUUID() }), dec(0.9, 'block'));

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}`);
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;

    // highRiskCount must be present and be a number
    expect(b['highRiskCount']).toBeDefined();
    expect(typeof b['highRiskCount']).toBe('number');

    // Core agent fields must still be present
    expect(b['agentId']).toBe(agentId);
    expect(typeof b['totalOps']).toBe('number');
    expect(typeof b['avgRiskScore']).toBe('number');
    expect(typeof b['maxRiskScore']).toBe('number');
    expect(b['byAction']).toBeDefined();
    expect(Array.isArray(b['topTools'])).toBe(true);
    expect(Array.isArray(b['recentOps'])).toBe(true);

    // Value check: only the 0.9 op qualifies
    expect(b['highRiskCount']).toBe(1);
  });
});

/**
 * Sprint v0.30 — T265, T267, T268 tests
 *
 * T265: GET /operations/count — returns {count: N}. Accepts ?action=, ?tool=, ?agentId= filters.
 * T267: GET /checkpoints/:id — 404 if not found. (diff sub-path takes priority over plain ID)
 * T268: GET /agents/:agentId/risk — returns {agentId, totalOps, avgRisk, maxRisk, riskBuckets}.
 *       404 if no ops for agent.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import type { OperationLog } from '../../src/types/interfaces.js';

// Ports come from start(0). A hand-picked base sits inside the OS ephemeral
// range (49152-65535), so a concurrent listen(0) can be handed the same number
// and this suite loses the race with EADDRINUSE.

// ── helpers ───────────────────────────────────────────────────────────────────

interface SetupResult {
  dash: DashboardAPI;
  port: number;
  store: StateStore;
  tmpDir: string;
}

async function setup(options: Record<string, unknown> = {}): Promise<SetupResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-crp-'));
  const store = new StateStore(':memory:');
  await store.initialize();
  const dash = new DashboardAPI(store, options);
  await dash.start(0);
  const port = dash.getPort();
  return { dash, port, store, tmpDir };
}

async function teardown(ctx: SetupResult): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
}

async function getJSON(
  port: number,
  p: string
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, body: await res.json() };
}

/** Build a minimal valid OperationLog for testing. */
function makeLog(
  id: string,
  overrides: Partial<OperationLog> = {},
  agentId = 'agent-test'
): OperationLog {
  return {
    operationId: id,
    operation: {
      id,
      agentId,
      tool: 'filesystem',
      method: 'read_file',
      params: { path: '/tmp/test.txt' },
      timestamp: new Date('2026-01-01T00:00:00Z'),
      sessionId: 'session-1',
    },
    decision: {
      action: 'allow',
      riskScore: 0.1,
      reasons: ['low risk'],
    },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ── T265: GET /operations/count ───────────────────────────────────────────────

describe('DashboardAPI — T265: GET /operations/count', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. returns {count: 0} when DB is empty', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/operations/count');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b).toHaveProperty('count');
    expect(b.count).toBe(0);
  });

  it('2. returns {count: N} after N logs are saved', async () => {
    ctx = await setup();
    await ctx.store.saveOperationLog(makeLog('op-cnt-1'));
    await ctx.store.saveOperationLog(makeLog('op-cnt-2'));
    await ctx.store.saveOperationLog(makeLog('op-cnt-3'));

    const { status, body } = await getJSON(ctx.port, '/operations/count');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(3);
  });

  it('3. ?action=block returns count of only blocked ops', async () => {
    ctx = await setup();
    // Save 2 allowed and 3 blocked ops
    await ctx.store.saveOperationLog(makeLog('op-allow-1', { decision: { action: 'allow', riskScore: 0.1, reasons: [] } }));
    await ctx.store.saveOperationLog(makeLog('op-allow-2', { decision: { action: 'allow', riskScore: 0.1, reasons: [] } }));
    await ctx.store.saveOperationLog(makeLog('op-block-1', { decision: { action: 'block', riskScore: 0.9, reasons: ['high risk'] } }));
    await ctx.store.saveOperationLog(makeLog('op-block-2', { decision: { action: 'block', riskScore: 0.8, reasons: ['high risk'] } }));
    await ctx.store.saveOperationLog(makeLog('op-block-3', { decision: { action: 'block', riskScore: 0.7, reasons: ['medium-high risk'] } }));

    const { status, body } = await getJSON(ctx.port, '/operations/count?action=block');
    expect(status).toBe(200);
    const b = body as { count: number };
    expect(b.count).toBe(3);
  });
});

// ── T267: GET /checkpoints/:id ────────────────────────────────────────────────

describe('DashboardAPI — T267: GET /checkpoints/:id', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('4. returns 404 for an unknown checkpoint ID', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/checkpoints/nonexistent-cp-id');
    expect(status).toBe(404);
    const b = body as { error: string };
    expect(b.error).toBeTruthy();
    expect(b.error).toMatch(/nonexistent-cp-id/);
  });
});

// ── T268: GET /agents/:agentId/risk ──────────────────────────────────────────

describe('DashboardAPI — T268: GET /agents/:agentId/risk', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('5. returns 404 when no ops exist for the given agentId', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/agents/ghost-agent/risk');
    expect(status).toBe(404);
    const b = body as { error: string };
    expect(b.error).toBeTruthy();
    expect(b.error).toMatch(/ghost-agent/);
  });

  it('6. returns correct avgRisk and riskBuckets after saving 3 ops with riskScores 0.1, 0.5, 0.9', async () => {
    ctx = await setup();
    const agentId = 'agent-risk-profile';

    // Save 3 logs with risk scores 0.1 (bucket 0.0-0.2), 0.5 (bucket 0.4-0.6), 0.9 (bucket 0.8-1.0)
    await ctx.store.saveOperationLog(makeLog('op-risk-low', { decision: { action: 'allow', riskScore: 0.1, reasons: [] } }, agentId));
    await ctx.store.saveOperationLog(makeLog('op-risk-mid', { decision: { action: 'allow', riskScore: 0.5, reasons: [] } }, agentId));
    await ctx.store.saveOperationLog(makeLog('op-risk-high', { decision: { action: 'block', riskScore: 0.9, reasons: ['high risk'] } }, agentId));

    const { status, body } = await getJSON(ctx.port, `/agents/${agentId}/risk`);
    expect(status).toBe(200);

    const b = body as {
      agentId: string;
      totalOps: number;
      avgRisk: number;
      maxRisk: number;
      riskBuckets: Record<string, number>;
    };

    expect(b.agentId).toBe(agentId);
    expect(b.totalOps).toBe(3);

    // avgRisk = (0.1 + 0.5 + 0.9) / 3 = 0.5
    expect(b.avgRisk).toBeCloseTo(0.5, 5);

    // maxRisk = 0.9
    expect(b.maxRisk).toBeCloseTo(0.9, 5);

    // riskBuckets: 1 in '0.0-0.2', 1 in '0.4-0.6', 1 in '0.8-1.0'; others = 0
    expect(b.riskBuckets).toHaveProperty('0.0-0.2', 1);
    expect(b.riskBuckets).toHaveProperty('0.2-0.4', 0);
    expect(b.riskBuckets).toHaveProperty('0.4-0.6', 1);
    expect(b.riskBuckets).toHaveProperty('0.6-0.8', 0);
    expect(b.riskBuckets).toHaveProperty('0.8-1.0', 1);
  });
});

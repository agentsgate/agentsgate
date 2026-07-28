/**
 * Sprint v0.29 — T260–T264 tests
 *
 * T260: GET /quota — returns {quotas, count}, 503 if quotaManager not configured
 * T261: agentsgate quota CLI — calls GET /quota (endpoint coverage here)
 * T262: GET /operations?method=<name> — post-fetch filter on operation.method
 * T263: GET /risk (no id) — returns {data: [...], count}
 * T264: agentsgate ops get <id> now prints parentId and tags if present (endpoint coverage)
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { AgentQuotaManager } from '../../src/utils/agent-quota.js';
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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-qr-'));
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
function makeLog(id: string, method = 'read_file', overrides: Partial<OperationLog> = {}): OperationLog {
  return {
    operationId: id,
    operation: {
      id,
      agentId: 'agent-test',
      tool: 'filesystem',
      method,
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

// ── T260: GET /quota ──────────────────────────────────────────────────────────

describe('DashboardAPI — T260: GET /quota', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. returns 503 when quotaManager not configured', async () => {
    ctx = await setup(); // no quotaManager
    const { status, body } = await getJSON(ctx.port, '/quota');
    expect(status).toBe(503);
    const b = body as { error: string };
    expect(b.error).toBeTruthy();
  });

  it('2. returns empty quotas array when quotaManager has no entries (no ops processed)', async () => {
    const quotaManager = new AgentQuotaManager({ defaultQuota: 100 });
    ctx = await setup({ quotaManager });
    // Do NOT call check() — listAll() should return []
    const { status, body } = await getJSON(ctx.port, '/quota');
    expect(status).toBe(200);
    const b = body as { quotas: unknown[]; count: number };
    expect(b.quotas).toEqual([]);
    expect(b.count).toBe(0);
  });

  it('3. returns quota usage after quotaManager.check() called — agentId appears with used=1', async () => {
    const quotaManager = new AgentQuotaManager({ defaultQuota: 100 });
    ctx = await setup({ quotaManager });
    quotaManager.check('agent-x');
    const { status, body } = await getJSON(ctx.port, '/quota');
    expect(status).toBe(200);
    const b = body as { quotas: Array<{ agentId: string; used: number; quota: number | undefined; remaining: number | undefined }>; count: number };
    expect(b.count).toBe(1);
    expect(b.quotas).toHaveLength(1);
    const entry = b.quotas[0];
    expect(entry.agentId).toBe('agent-x');
    expect(entry.used).toBe(1);
    expect(entry.quota).toBe(100);
    expect(entry.remaining).toBe(99);
  });
});

// ── T262: GET /operations?method=<name> ──────────────────────────────────────

describe('DashboardAPI — T262: GET /operations?method=read_file', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('4. ?method=read_file returns only ops with method=read_file, filters out write_file', async () => {
    ctx = await setup();
    // Insert one read_file and one write_file operation
    await ctx.store.saveOperationLog(makeLog('op-read-1', 'read_file'));
    await ctx.store.saveOperationLog(makeLog('op-write-1', 'write_file'));

    const { status, body } = await getJSON(ctx.port, '/operations?method=read_file');
    expect(status).toBe(200);
    const b = body as { operations?: unknown[]; logs?: unknown[]; data?: unknown[] };
    const list = (b.operations ?? b.logs ?? b.data ?? []) as Array<{ operationId: string; operation: { method: string } }>;

    // Only read_file ops should appear
    expect(list.length).toBeGreaterThanOrEqual(1);
    for (const item of list) {
      expect(item.operation.method).toBe('read_file');
    }
    // write_file op should NOT be in the results
    const writeFileFound = list.some(item => item.operationId === 'op-write-1');
    expect(writeFileFound).toBe(false);
    // read_file op should be in the results
    const readFileFound = list.some(item => item.operationId === 'op-read-1');
    expect(readFileFound).toBe(true);
  });
});

// ── T263: GET /risk ───────────────────────────────────────────────────────────

describe('DashboardAPI — T263: GET /risk', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('5. returns data array with riskScore, action, operationId fields from recent logs', async () => {
    ctx = await setup();
    await ctx.store.saveOperationLog(makeLog('op-risk-1', 'read_file'));
    await ctx.store.saveOperationLog(makeLog('op-risk-2', 'write_file', {
      decision: { action: 'block', riskScore: 0.9, reasons: ['high risk'] },
    }));

    const { status, body } = await getJSON(ctx.port, '/risk');
    expect(status).toBe(200);
    const b = body as { data: Array<{ operationId: string; agentId: string; tool: string; method: string; riskScore: number; action: string; firedRules: string[] }>; count: number };
    expect(b).toHaveProperty('data');
    expect(b).toHaveProperty('count');
    expect(Array.isArray(b.data)).toBe(true);
    expect(b.data.length).toBeGreaterThanOrEqual(2);
    expect(b.count).toBe(b.data.length);

    const entry = b.data.find(d => d.operationId === 'op-risk-1');
    expect(entry).toBeDefined();
    expect(entry).toHaveProperty('operationId');
    expect(entry).toHaveProperty('agentId');
    expect(entry).toHaveProperty('riskScore');
    expect(entry).toHaveProperty('action');
    expect(typeof entry!.riskScore).toBe('number');
    expect(typeof entry!.action).toBe('string');
    // firedRules should be present (array)
    expect(Array.isArray(entry!.firedRules)).toBe(true);
  });

  it('6. ?limit=1 returns only 1 result even if 3 logs exist', async () => {
    ctx = await setup();
    await ctx.store.saveOperationLog(makeLog('op-lim-1', 'read_file'));
    await ctx.store.saveOperationLog(makeLog('op-lim-2', 'read_file'));
    await ctx.store.saveOperationLog(makeLog('op-lim-3', 'read_file'));

    const { status, body } = await getJSON(ctx.port, '/risk?limit=1');
    expect(status).toBe(200);
    const b = body as { data: unknown[]; count: number };
    expect(b.data).toHaveLength(1);
    expect(b.count).toBe(1);
  });
});

// ── T264: GET /operations/:id includes parentId and tags ─────────────────────

describe('DashboardAPI — T264: GET /operations/:id includes parentId and tags', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('7. GET /operations/:id response includes parentId and tags when present', async () => {
    ctx = await setup();
    const log = makeLog('op-tagged-1', 'read_file');
    // Add parentId and tags to the operation
    (log.operation as Record<string, unknown>)['parentId'] = 'parent-op-99';
    (log.operation as Record<string, unknown>)['tags'] = ['infra', 'audit'];
    await ctx.store.saveOperationLog(log);

    const { status, body } = await getJSON(ctx.port, '/operations/op-tagged-1');
    expect(status).toBe(200);
    const b = body as { operationId: string; operation: Record<string, unknown> };
    expect(b.operationId).toBe('op-tagged-1');
    // parentId and tags should be preserved in the response
    expect(b.operation['parentId']).toBe('parent-op-99');
    expect(b.operation['tags']).toEqual(['infra', 'audit']);
  });

  it('8. GET /operations/:id response omits parentId and tags when absent', async () => {
    ctx = await setup();
    await ctx.store.saveOperationLog(makeLog('op-plain-1', 'read_file'));
    const { status, body } = await getJSON(ctx.port, '/operations/op-plain-1');
    expect(status).toBe(200);
    const b = body as { operationId: string; operation: Record<string, unknown> };
    expect(b.operationId).toBe('op-plain-1');
    // parentId and tags should not be present (or be undefined/null)
    expect(b.operation['parentId'] ?? undefined).toBeUndefined();
    expect(b.operation['tags'] ?? undefined).toBeUndefined();
  });
});

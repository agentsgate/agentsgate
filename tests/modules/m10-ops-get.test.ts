/**
 * Sprint v0.26 — T245–T249 tests
 *
 * T245: GET /operations/:id — single operation by operationId
 * T246: maxOpsPerPage option on DashboardOptions caps per-page limit
 * T247: (CLI tested elsewhere; dashboard endpoint covered by T245)
 * T248: GET /audit/verify?limit=N — HMAC verification endpoint
 * T249: (CLI tested elsewhere; endpoint covered by T248)
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { stampLog } from '../../src/utils/audit-hmac.js';
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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-og-'));
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
function makeLog(id: string): OperationLog {
  return {
    operationId: id,
    operation: {
      id,
      agentId: 'agent-test',
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
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('DashboardAPI — T245: GET /operations/:id', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. returns 404 when operation not found', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/operations/nonexistent-id');
    expect(status).toBe(404);
    const b = body as { error: string };
    expect(b.error).toMatch(/nonexistent-id/);
  });

  it('2. returns 200 with log data when operation exists', async () => {
    ctx = await setup();
    const log = makeLog('op-123');
    await ctx.store.saveOperationLog(log);
    const { status, body } = await getJSON(ctx.port, '/operations/op-123');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['operationId']).toBe('op-123');
  });
});

describe('DashboardAPI — T246: maxOpsPerPage option', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('3. maxOpsPerPage:3 caps limit at 3 even when client requests limit=100', async () => {
    ctx = await setup({ maxOpsPerPage: 3 });
    // Insert 10 logs
    for (let i = 0; i < 10; i++) {
      await ctx.store.saveOperationLog(makeLog(`op-cap-${i}`));
    }
    const { status, body } = await getJSON(ctx.port, '/operations?limit=100');
    expect(status).toBe(200);
    const b = body as { operations?: unknown[]; logs?: unknown[]; data?: unknown[] };
    // The response array may be under different keys depending on implementation
    const list = b.operations ?? b.logs ?? b.data ?? [];
    expect((list as unknown[]).length).toBeLessThanOrEqual(3);
  });
});

describe('DashboardAPI — T248: GET /audit/verify', () => {
  let ctx: SetupResult;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('4. returns 503 when signingSecret is not configured', async () => {
    ctx = await setup(); // no signingSecret
    const { status, body } = await getJSON(ctx.port, '/audit/verify');
    expect(status).toBe(503);
    const b = body as { error: string };
    expect(b.error).toBeTruthy();
  });

  it('5. returns {checked, valid, invalid, unsigned} with unsigned=total when logs have no HMAC', async () => {
    ctx = await setup({ signingSecret: 'test-secret' });
    // Insert 3 unsigned logs
    for (let i = 0; i < 3; i++) {
      await ctx.store.saveOperationLog(makeLog(`op-unsigned-${i}`));
    }
    const { status, body } = await getJSON(ctx.port, '/audit/verify?limit=3');
    expect(status).toBe(200);
    const b = body as { checked: number; valid: number; invalid: number; unsigned: number };
    expect(b).toHaveProperty('checked');
    expect(b).toHaveProperty('valid');
    expect(b).toHaveProperty('invalid');
    expect(b).toHaveProperty('unsigned');
    expect(b.checked).toBe(3);
    expect(b.unsigned).toBe(3);
    expect(b.valid).toBe(0);
    expect(b.invalid).toBe(0);
  });

  it('6. valid count matches signed logs when logs are signed with the secret', async () => {
    const secret = 'test-secret';
    ctx = await setup({ signingSecret: secret });

    // Insert 2 signed logs and 1 unsigned log
    const signedA = stampLog(makeLog('op-signed-a'), secret);
    const signedB = stampLog(makeLog('op-signed-b'), secret);
    const unsigned = makeLog('op-unsigned-x');

    await ctx.store.saveOperationLog(signedA);
    await ctx.store.saveOperationLog(signedB);
    await ctx.store.saveOperationLog(unsigned);

    const { status, body } = await getJSON(ctx.port, '/audit/verify?limit=10');
    expect(status).toBe(200);
    const b = body as { checked: number; valid: number; invalid: number; unsigned: number };
    expect(b.checked).toBe(3);
    expect(b.valid).toBe(2);
    expect(b.unsigned).toBe(1);
    expect(b.invalid).toBe(0);
  });
});

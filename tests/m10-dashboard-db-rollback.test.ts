/**
 * T449 + T456 — Dashboard db-rollback endpoint and snapshotId surfacing
 *
 * Tests for:
 * - GET /operations/:id includes snapshotId when executionResult.output.snapshot_id is present
 * - GET /operations list includes snapshotId when snapshot_id is present
 * - POST /operations/:id/db-rollback (503 / 404 / 400 / 200 / 500)
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DashboardAPI } from '../src/modules/m10-dashboard/index.js';
import { OperationLogger } from '../src/modules/m3-logger/index.js';
import { StateStore } from '../src/modules/m2-store/index.js';
import { DatabaseRollbackAdapter } from '../src/modules/m9-adapters/database-rollback-adapter.js';
import type { MCPOperation, ProxyDecision, RollbackResult, StateSnapshot } from '../src/types/interfaces.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOp(
  tool = 'database',
  method = 'execute',
  params: Record<string, unknown> = {},
): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId: 'agent-test',
    tool,
    method,
    params,
    timestamp: new Date(),
    sessionId: 'sess-db-test',
  };
}

function dec(riskScore = 0.5, action: ProxyDecision['action'] = 'allow'): ProxyDecision {
  return { action, riskScore, reasons: [] };
}

interface Ctx {
  dash: DashboardAPI;
  port: number;
  store: StateStore;
  logger: OperationLogger;
  tmpDir: string;
  dbPath: string;
}

async function setup(opts: { withAdapter?: boolean } = {}): Promise<Ctx> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-dash-dbrb-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const store = new StateStore(path.join(tmpDir, 'store.db'));
  await store.initialize();
  const logger = new OperationLogger(store, undefined, { redact: false });

  let dbRollbackAdapter: DatabaseRollbackAdapter | undefined;
  if (opts.withAdapter) {
    dbRollbackAdapter = new DatabaseRollbackAdapter(dbPath);
  }

  const dash = new DashboardAPI(store, { dbRollbackAdapter });
  await dash.start(0);
  const port = dash.getPort();
  return { dash, port, store, logger, tmpDir, dbPath };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
}

async function getJSON(port: number, p: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function postJSON(port: number, p: string, body = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// T456 — snapshotId surfacing in GET /operations/:id
// ---------------------------------------------------------------------------

describe('T456 — snapshotId in GET /operations/:id', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('GET /operations/:id includes snapshotId when executionResult.output.snapshot_id is present', async () => {
    ctx = await setup();
    const snapshotId = crypto.randomUUID();
    const op = makeOp('database', 'execute', { sql: 'INSERT INTO t VALUES (1)', snapshot_table: 'users' });
    await ctx.logger.log(op, dec(), {
      success: true,
      output: { snapshot_id: snapshotId, changes: 1 },
      durationMs: 10,
    });

    const { status, body } = await getJSON(ctx.port, `/operations/${op.id}`);
    expect(status).toBe(200);
    expect(body['snapshotId']).toBe(snapshotId);
  });

  it('GET /operations/:id does NOT include snapshotId when output has no snapshot_id', async () => {
    ctx = await setup();
    const op = makeOp('database', 'execute', { sql: 'INSERT INTO t VALUES (1)' });
    await ctx.logger.log(op, dec(), { success: true, output: { changes: 1 }, durationMs: 5 });

    const { status, body } = await getJSON(ctx.port, `/operations/${op.id}`);
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('snapshotId');
  });

  it('GET /operations/:id returns 404 for unknown id', async () => {
    ctx = await setup();
    const { status } = await getJSON(ctx.port, `/operations/${crypto.randomUUID()}`);
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// T456 — snapshotId surfacing in GET /operations list
// ---------------------------------------------------------------------------

describe('T456 — snapshotId in GET /operations list', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('GET /operations list includes snapshotId for logs that have it', async () => {
    ctx = await setup();
    const snapshotId = crypto.randomUUID();
    const op = makeOp('database', 'execute', { sql: 'INSERT INTO t VALUES (1)', snapshot_table: 'users' });
    await ctx.logger.log(op, dec(), {
      success: true,
      output: { snapshot_id: snapshotId, changes: 1 },
      durationMs: 10,
    });

    const { status, body } = await getJSON(ctx.port, '/operations');
    expect(status).toBe(200);
    const data = body['data'] as Array<Record<string, unknown>>;
    const found = data.find(d => d['operationId'] === op.id);
    expect(found).toBeDefined();
    expect(found!['snapshotId']).toBe(snapshotId);
  });

  it('GET /operations list does NOT include snapshotId for logs without snapshot', async () => {
    ctx = await setup();
    const op = makeOp('filesystem', 'write', { path: '/tmp/foo.txt' });
    await ctx.logger.log(op, dec(), { success: true, output: null, durationMs: 3 });

    const { status, body } = await getJSON(ctx.port, '/operations');
    expect(status).toBe(200);
    const data = body['data'] as Array<Record<string, unknown>>;
    const found = data.find(d => d['operationId'] === op.id);
    expect(found).toBeDefined();
    expect(found).not.toHaveProperty('snapshotId');
  });
});

// ---------------------------------------------------------------------------
// T449 — POST /operations/:id/db-rollback
// ---------------------------------------------------------------------------

describe('T449 — POST /operations/:id/db-rollback', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('returns 503 when no dbRollbackAdapter configured', async () => {
    ctx = await setup({ withAdapter: false });
    const op = makeOp('database', 'execute', { snapshot_table: 'users' });
    await ctx.logger.log(op, dec());

    const { status, body } = await postJSON(ctx.port, `/operations/${op.id}/db-rollback`);
    expect(status).toBe(503);
    expect(body['error']).toMatch(/no rollback engine or adapter configured/i);
  });

  it('returns 404 for unknown operation', async () => {
    ctx = await setup({ withAdapter: true });
    const { status } = await postJSON(ctx.port, `/operations/${crypto.randomUUID()}/db-rollback`);
    expect(status).toBe(404);
  });

  it('returns 400 when operation has no snapshot (no snapshot_id in output)', async () => {
    ctx = await setup({ withAdapter: true });
    const op = makeOp('database', 'execute', { snapshot_table: 'users' });
    // Log with output that has NO snapshot_id
    await ctx.logger.log(op, dec(), { success: true, output: { changes: 1 }, durationMs: 5 });

    const { status, body } = await postJSON(ctx.port, `/operations/${op.id}/db-rollback`);
    expect(status).toBe(400);
    expect(body['error']).toMatch(/snapshot/i);
  });

  it('calls adapter.rollback() and returns 200 on success', async () => {
    ctx = await setup({ withAdapter: true });

    // Create a real SQLite DB with a users table and snapshot
    const db = new Database(ctx.dbPath);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob')");
    db.close();

    const snapshotId = crypto.randomUUID();
    const snapshotDir = path.join(ctx.tmpDir, '.agentsgate-snapshots');
    await fs.mkdir(snapshotDir, { recursive: true });
    const snapshotContent = JSON.stringify({
      tableName: 'users',
      capturedAt: new Date().toISOString(),
      rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
      columns: ['id', 'name'],
    });
    await fs.writeFile(path.join(snapshotDir, `${snapshotId}_users.json`), snapshotContent, 'utf8');

    const op = makeOp('database', 'execute', { sql: 'DELETE FROM users', snapshot_table: 'users' });
    await ctx.logger.log(op, dec(), {
      success: true,
      output: { snapshot_id: snapshotId, changes: 2 },
      durationMs: 15,
    });

    const { status, body } = await postJSON(ctx.port, `/operations/${op.id}/db-rollback`);
    expect(status).toBe(200);
    expect(body['success']).toBe(true);
  });

  it('returns 500 when adapter.rollback() returns success=false', async () => {
    ctx = await setup({ withAdapter: true });

    // Log with a snapshotId that doesn't exist on disk → adapter.rollback fails
    const snapshotId = crypto.randomUUID();
    const op = makeOp('database', 'execute', { sql: 'DELETE FROM users', snapshot_table: 'users' });
    await ctx.logger.log(op, dec(), {
      success: true,
      output: { snapshot_id: snapshotId, changes: 2 },
      durationMs: 10,
    });

    // Create a real DB so the adapter doesn't fail opening it, but the snapshot file won't exist
    const db = new Database(ctx.dbPath);
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    db.close();

    const { status, body } = await postJSON(ctx.port, `/operations/${op.id}/db-rollback`);
    expect(status).toBe(500);
    expect(body['success']).toBe(false);
  });
});

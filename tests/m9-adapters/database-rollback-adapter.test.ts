/**
 * T445 — DatabaseRollbackAdapter unit tests
 *
 * Tests canRollback, captureState, rollback, and previewRollback behavior.
 * Uses real SQLite temp databases and real snapshot JSON files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseRollbackAdapter } from '../../src/modules/m9-adapters/database-rollback-adapter.js';
import type { MCPOperation, StateSnapshot } from '../../src/types/interfaces.js';

function makeOp(
  tool: string,
  method: string,
  params: Record<string, unknown> = {},
): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId: 'test-agent',
    tool,
    method,
    params,
    timestamp: new Date(),
    sessionId: 'test-session',
  };
}

let tmpDir: string;
let dbPath: string;
let adapter: DatabaseRollbackAdapter;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-dba-test-'));
  dbPath = path.join(tmpDir, 'test.db');
  adapter = new DatabaseRollbackAdapter(dbPath);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// canRollback
// ---------------------------------------------------------------------------

describe('DatabaseRollbackAdapter.canRollback', () => {
  it('returns false for non-database tool', async () => {
    const op = makeOp('filesystem', 'execute', { snapshot_table: 'users' });
    const result = await adapter.canRollback(op);
    expect(result.canRollback).toBe(false);
  });

  it('returns false for database tool with method=query', async () => {
    const op = makeOp('database', 'query', { snapshot_table: 'users' });
    const result = await adapter.canRollback(op);
    expect(result.canRollback).toBe(false);
  });

  it('returns false when snapshot_table parameter is missing', async () => {
    const op = makeOp('database', 'execute', {});
    const result = await adapter.canRollback(op);
    expect(result.canRollback).toBe(false);
  });

  it('returns false when snapshot_table is empty string', async () => {
    const op = makeOp('database', 'execute', { snapshot_table: '' });
    const result = await adapter.canRollback(op);
    expect(result.canRollback).toBe(false);
  });

  it('returns true for database execute with snapshot_table present', async () => {
    const op = makeOp('database', 'execute', { snapshot_table: 'users' });
    const result = await adapter.canRollback(op);
    expect(result.canRollback).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('returns true for database execute_ddl with snapshot_table present', async () => {
    const op = makeOp('database', 'execute_ddl', { snapshot_table: 'orders' });
    const result = await adapter.canRollback(op);
    expect(result.canRollback).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// captureState
// ---------------------------------------------------------------------------

describe('DatabaseRollbackAdapter.captureState', () => {
  it('returns StateSnapshot with correct operationId', async () => {
    const op = makeOp('database', 'execute', { snapshot_table: 'users' });
    const snapshot = await adapter.captureState(op);
    expect(snapshot.operationId).toBe(op.id);
  });

  it('returns StateSnapshot with adapterId = agentsgate-database', async () => {
    const op = makeOp('database', 'execute', { snapshot_table: 'users' });
    const snapshot = await adapter.captureState(op);
    expect(snapshot.adapterId).toBe('agentsgate-database');
  });

  it('stores dbPath in snapshot data', async () => {
    const op = makeOp('database', 'execute', { snapshot_table: 'users' });
    const snapshot = await adapter.captureState(op);
    const data = snapshot.data as Record<string, unknown>;
    expect(data['dbPath']).toBe(dbPath);
  });

  it('stores snapshotTable in snapshot data', async () => {
    const op = makeOp('database', 'execute', { snapshot_table: 'products' });
    const snapshot = await adapter.captureState(op);
    const data = snapshot.data as Record<string, unknown>;
    expect(data['snapshotTable']).toBe('products');
  });

  it('capturedAt is a Date', async () => {
    const op = makeOp('database', 'execute', { snapshot_table: 'users' });
    const snapshot = await adapter.captureState(op);
    expect(snapshot.capturedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

describe('DatabaseRollbackAdapter.rollback', () => {
  it('returns error when snapshotId is missing in data', async () => {
    const snapshot: StateSnapshot = {
      adapterId: 'agentsgate-database',
      operationId: crypto.randomUUID(),
      data: { snapshotTable: 'users' },
      capturedAt: new Date(),
    };
    const result = await adapter.rollback(snapshot);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/snapshotId/i);
  });

  it('returns error when snapshotTable is missing in data', async () => {
    const snapshot: StateSnapshot = {
      adapterId: 'agentsgate-database',
      operationId: crypto.randomUUID(),
      data: { snapshotId: crypto.randomUUID() },
      capturedAt: new Date(),
    };
    const result = await adapter.rollback(snapshot);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/snapshotTable/i);
  });

  it('returns error when snapshot file is not found', async () => {
    const snapshot: StateSnapshot = {
      adapterId: 'agentsgate-database',
      operationId: crypto.randomUUID(),
      data: {
        snapshotId: crypto.randomUUID(),
        snapshotTable: 'users',
      },
      capturedAt: new Date(),
    };
    const result = await adapter.rollback(snapshot);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('successfully restores rows from a JSON snapshot file', async () => {
    // Set up a real SQLite DB with a users table
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob')");
    db.close();

    // Create the snapshot file manually (same format as the MCP server)
    const snapshotId = crypto.randomUUID();
    const snapshotDir = path.join(tmpDir, '.agentsgate-snapshots');
    await fs.mkdir(snapshotDir, { recursive: true });
    const snapshotContent = JSON.stringify({
      tableName: 'users',
      capturedAt: new Date().toISOString(),
      rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
      columns: ['id', 'name'],
    });
    await fs.writeFile(path.join(snapshotDir, `${snapshotId}_users.json`), snapshotContent, 'utf8');

    // Mutate the DB
    const db2 = new Database(dbPath);
    db2.exec('DELETE FROM users');
    db2.exec("INSERT INTO users VALUES (99, 'Charlie')");
    db2.close();

    const snapshot: StateSnapshot = {
      adapterId: 'agentsgate-database',
      operationId: crypto.randomUUID(),
      data: { snapshotId, snapshotTable: 'users' },
      capturedAt: new Date(),
    };

    const result = await adapter.rollback(snapshot);
    expect(result.success).toBe(true);
    expect(result.restoredFiles).toContain('users');

    // Verify the rows are restored
    const db3 = new Database(dbPath);
    const rows = db3.prepare('SELECT * FROM users ORDER BY id').all() as Array<{ id: number; name: string }>;
    db3.close();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe('Alice');
    expect(rows[1]!.name).toBe('Bob');
  });

  it('rollback handles empty table snapshot (0 rows)', async () => {
    // Create a DB with a table
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, msg TEXT)');
    db.exec("INSERT INTO logs VALUES (1, 'hello')");
    db.close();

    // Snapshot with 0 rows
    const snapshotId = crypto.randomUUID();
    const snapshotDir = path.join(tmpDir, '.agentsgate-snapshots');
    await fs.mkdir(snapshotDir, { recursive: true });
    const snapshotContent = JSON.stringify({
      tableName: 'logs',
      capturedAt: new Date().toISOString(),
      rows: [],
      columns: ['id', 'msg'],
    });
    await fs.writeFile(path.join(snapshotDir, `${snapshotId}_logs.json`), snapshotContent, 'utf8');

    const snapshot: StateSnapshot = {
      adapterId: 'agentsgate-database',
      operationId: crypto.randomUUID(),
      data: { snapshotId, snapshotTable: 'logs' },
      capturedAt: new Date(),
    };

    const result = await adapter.rollback(snapshot);
    expect(result.success).toBe(true);

    const db2 = new Database(dbPath);
    const count = (db2.prepare('SELECT COUNT(*) as c FROM logs').get() as { c: number }).c;
    db2.close();
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// previewRollback
// ---------------------------------------------------------------------------

describe('DatabaseRollbackAdapter.previewRollback', () => {
  it('returns willRestore containing table name', async () => {
    const snapshot: StateSnapshot = {
      adapterId: 'agentsgate-database',
      operationId: crypto.randomUUID(),
      data: { snapshotTable: 'orders' },
      capturedAt: new Date(),
    };
    const preview = await adapter.previewRollback(snapshot);
    expect(preview.willRestore).toEqual(expect.arrayContaining([expect.stringContaining('orders')]));
  });

  it('returns empty willRestore when snapshotTable is missing', async () => {
    const snapshot: StateSnapshot = {
      adapterId: 'agentsgate-database',
      operationId: crypto.randomUUID(),
      data: {},
      capturedAt: new Date(),
    };
    const preview = await adapter.previewRollback(snapshot);
    expect(preview.willRestore).toHaveLength(0);
  });

  it('returns cannotRestore as empty array', async () => {
    const snapshot: StateSnapshot = {
      adapterId: 'agentsgate-database',
      operationId: crypto.randomUUID(),
      data: { snapshotTable: 'users' },
      capturedAt: new Date(),
    };
    const preview = await adapter.previewRollback(snapshot);
    expect(preview.cannotRestore).toHaveLength(0);
  });

  it('returns warnings about destructive restore', async () => {
    const snapshot: StateSnapshot = {
      adapterId: 'agentsgate-database',
      operationId: crypto.randomUUID(),
      data: { snapshotTable: 'users' },
      capturedAt: new Date(),
    };
    const preview = await adapter.previewRollback(snapshot);
    expect(preview.warnings.length).toBeGreaterThan(0);
  });
});
